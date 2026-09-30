"""Groups gate (docs/PLAN_0_1_31.md §6 step 5): groups as folders of layers (pass-through: no opacity or blend of their own).

One deterministic document: a base picture and six layers, two of them in a group nested in another. The checks:

  * grouping the selection (Ctrl+G's `groupLayersNow`): the block goes where the topmost selected layer was, a group
    whose layers are all selected goes in whole; the layers of a group sit together; one undo step, redo
  * a hidden group draws as its layers hidden one by one, byte for byte, on every path: the full flatten, the PNG
    export, the box read, the region pass, the brush's stack box and the workers' plain stack, and the view drawn by
    the GPU compositor against Canvas 2D; the layers keep their own eyes
  * a locked group locks its layers (delete refused, align leaves them); solo inside a hidden group shows the layer and
    gives the group back hidden; a clip does not reach out of its group
  * moving: the steps of Ctrl+] / Ctrl+[ through the tree, a drop onto a row and onto a group's row, a group dropped
    into another, top leaves every group; ungroup and delete group, each one undo step
  * getValue / setValue keep the groups (name, eye, lock, fold, nesting); a damaged state is repaired, not refused
  * a PSD keeps them both ways (the band writer on tiles and the canvas writers); an ORA writes a hidden group's
    layers hidden
  * the commands: group_layers, set_group, ungroup_layers, list_layers, move_layer
  * the panel: a row per group at its depth, a folded group hides its rows

    python tools/groups_test.py

Needs the app on the debugging port (tools/cdp.py); no ComfyUI.
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

JS = r"""
(async () => {
    const shell = await import("./shell.js");
    const W = 300, H = 200;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 300));
    ed.resizeCanvas();
    const { Layer: LP } = ed.pixels;
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const settle = async () => { await ed.mipsSettled(); await new Promise((r) => setTimeout(r, 100)); };
    const touch = () => { ed.uploaded.baseHash = null; ed.flatCache = null; ed.sceneSig = null; ed.filterPreview = null; ed.compositeVersion++; for (const l of ed.layers) { l._fcache = null; l._fcacheView = null; } };
    const fails = [];
    const check = (name, ok, got) => { if (!ok) fails.push(name + (got === undefined ? "" : ": " + (typeof got === "string" ? got : JSON.stringify(got)))); };

    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#203050"); g.addColorStop(1, "#e0d0b0");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
    }
    await ed.setBaseFromCanvas(base, { keepLayers: false });   // uploaded: a state names the base by its file
    const layer = (name, w, h, colour, props = {}) => {
        const c = mk(w, h), x = c.getContext("2d");
        x.fillStyle = colour; x.beginPath(); x.ellipse(w / 2, h / 2, w / 2 - 2, h / 2 - 2, 0, 0, Math.PI * 2); x.fill();
        return ed.addLayer({ name, kind: "paint", px: LP.fromCanvas(c), x: 0, y: 0, w, h, dirty: true, ...props });
    };
    const a = layer("A", 120, 90, "#e03020", { x: 10, y: 10 });
    const b = layer("B", 140, 100, "rgba(40,200,90,0.7)", { x: 60, y: 40, blend: "multiply" });
    const c = layer("C", 100, 120, "#3050f0", { x: 150, y: 30, opacity: 0.8 });
    const d = layer("D", 90, 90, "#f0e030", { x: 200, y: 100, blend: "screen" });
    const e = layer("E", 160, 60, "rgba(250,250,250,0.6)", { x: 20, y: 130 });
    const f = layer("F", 60, 60, "#a020c0", { x: 120, y: 120 });
    const names = () => ed.layers.map((l) => l.name).join("");
    const gname = (l) => { const g = ed.groupById(l.group); return g ? g.name : null; };
    const out = { tiles: !!ed.tileMode };
    window.__groupsTest = { ed };   // for a look by hand

    // ---- grouping -------------------------------------------------------------------------------------------------
    ed.selectLayers([b.id, c.id], { active: c.id });
    const inner = ed.groupLayersNow(undefined, { name: "Inner" });
    check("group: made", inner && ed.groups.length === 1 && b.group === inner.id && c.group === inner.id, ed.groups);
    check("group: its layers are the selection", ed.selectedLayers().map((l) => l.name).join("") === "BC" && ed.activeGroupId === inner.id, ed.selectedLayers().map((l) => l.name));
    // A, the whole of Inner and E: Inner goes in whole, A and E move up to E's place in stack order
    ed.selectLayers([a.id, b.id, c.id, e.id], { active: e.id });
    const outer = ed.groupLayersNow(undefined, { name: "Outer" });
    check("nested: order", names() === "DABCEF", names());
    check("nested: a group whose layers are all selected goes in whole", inner.parent === outer.id && a.group === outer.id && e.group === outer.id && b.group === inner.id && d.group == null && f.group == null, ed.groupsCopy());
    await ed.undoStep();
    check("undo: one step back", ed.groups.length === 1 && names() === "ABCDEF" && ed.layers.every((l) => (l.name === "B" || l.name === "C") ? l.group === inner.id : !l.group), [names(), ed.groupsCopy()]);
    await ed.redoStep();
    const L = (n) => ed.layers.find((l) => l.name === n);   // undo and redo put copies of the layers back
    check("redo: the nested groups again", names() === "DABCEF" && gname(L("A")) === "Outer" && gname(L("B")) === "Inner" && ed.groupById(inner.id).parent === outer.id, [names(), ed.groupsCopy()]);

    // ---- a hidden group, every path ----------------------------------------------------------------------------------
    touch(); ed.renderLayers();
    ed.view = { scale: 1, x: 20, y: 20, angle: 0 };
    ed.draw();
    await settle();
    const bytes = (cv) => cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
    const full = () => { touch(); return bytes(ed.flattenToCanvas({ forRun: false })); };
    const png = async () => {
        touch();
        const r = await ed.encodeComposite({ forRun: true }, {});
        if (!r || !r.blob) return null;
        const bmp = await createImageBitmap(r.blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        const cv = mk(bmp.width, bmp.height); cv.getContext("2d").drawImage(bmp, 0, 0); bmp.close();
        return bytes(cv);
    };
    const box = async () => { touch(); const r = await ed.readBoxBytes([0, 0, W, H], { forRun: true }); return new Uint8Array(r.data.subarray ? r.data.subarray(0, W * H * 4) : r.data); };
    const region = () => { touch(); const cv = ed.sampleRegion("image", [0, 0, W, H], 1, { forRun: false }); return cv && cv.width === W && cv.height === H ? bytes(cv) : null; };
    const stackBox = async () => { touch(); const plan = ed.stackPlan({ forRun: false }); if (!plan) return null; const { compositeBox } = await import("./editor/inpaint_boxstack.js"); return compositeBox(plan, 0, 0, W, H, W, H).slice(); };   // a copy: the answer is a scratch the next call reuses
    const shot = () => { ed.sceneSig = null; ed.flatCache = null; ed.uploaded.baseHash = null; ed.draw(); const cv = mk(ed.canvas.width, ed.canvas.height); cv.getContext("2d").drawImage(ed.canvas, 0, 0); return bytes(cv); };
    const view = async () => { ed.compositorOff = false; shot(); await settle(); return shot(); };
    const diff = (p, q) => { if (!p || !q) return null; if (p.length !== q.length) return { max: 999, n: -1 }; let m = 0, n = 0; for (let i = 0; i < p.length; i++) { const dd = Math.abs(p[i] - q[i]); if (dd) { n++; if (dd > m) m = dd; } } return { max: m, n }; };
    const same = (x) => x && x.max === 0;
    const reads = { full, png, box, region, stackBox, view };
    const G = () => ed.groupById(inner.id), O = () => ed.groupById(outer.id);
    for (const [key, read] of Object.entries(reads)) {
        const shown = await read();
        ed.setGroupFlag(inner.id, "visible", false); touch();
        const hid = await read();
        ed.setGroupFlag(inner.id, "visible", true);
        L("B").visible = false; L("C").visible = false; touch();
        const oneByOne = await read();
        L("B").visible = true; L("C").visible = true; touch();
        // no plan and no worker export on the canvas backend (the other paths cover it there)
        if ((key === "stackBox" || key === "png") && !shown && !ed.tileMode) { out[key] = "canvas backend"; continue; }
        const r = { asHidden: diff(hid, oneByOne), differs: diff(shown, hid) };
        out[key] = r;
        check(`${key}: a hidden group draws as its layers hidden`, same(r.asHidden), r);
        check(`${key}: and it changes the picture`, r.differs && r.differs.n > 0, r);
    }
    // the outer group hides the inner one's layers too; the layers' own eyes stay on
    ed.setGroupFlag(outer.id, "visible", false);
    check("outer hidden: every layer in it is not shown, their own eyes on", ["A", "B", "C", "E"].every((n) => !ed.shown(L(n)) && L(n).visible) && ed.shown(L("D")) && ed.shown(L("F")));
    ed.setGroupFlag(outer.id, "visible", true);
    // the GPU view against Canvas 2D with the inner group hidden
    {
        ed.setGroupFlag(inner.id, "visible", false);
        ed.compositorOff = true; await settle(); const cpu = shot();
        const gpu = await view();
        const used = ed.glCompositeUsable({});   // after view(): it switches the compositor back on
        let m = 0;
        for (let i = 0; i < cpu.length; i += 4) { const aa = cpu[i + 3], ba = gpu[i + 3]; let dd = Math.abs(aa - ba); for (let k = 0; k < 3; k++) dd = Math.max(dd, Math.abs(cpu[i + k] * aa / 255 - gpu[i + k] * ba / 255)); if (dd > m) m = dd; }
        out.gpuVsCpu = { used, max: +m.toFixed(2) };
        check("GPU view against Canvas 2D with a hidden group", used && m <= 2, out.gpuVsCpu);
        ed.setGroupFlag(inner.id, "visible", true);
    }

    // ---- lock, solo, clip ----------------------------------------------------------------------------------------------
    ed.setGroupFlag(outer.id, "locked", true);
    check("lock: the layers of a locked group are locked", ["A", "B", "C", "E"].every((n) => ed.isLocked(L(n)) && !L(n).locked) && !ed.isLocked(L("D")));
    const nBefore = ed.layers.length;
    ed.removeLayer(L("B").id);
    check("lock: delete refused", ed.layers.length === nBefore, ed.status);
    check("lock: delete group refused", ed.removeGroup(outer.id) === 0 && ed.layers.length === nBefore, ed.status);
    ed.setGroupFlag(outer.id, "locked", false);
    check("lock: unlocked again", !ed.isLocked(L("B")));
    ed.setGroupFlag(inner.id, "visible", false);
    ed.soloLayers([L("B")]);
    check("solo: a layer in a hidden group is shown", ed.shown(L("B")) && !ed.shown(L("C")) && !ed.shown(L("A")), ed.groupsCopy());
    ed.unsolo();
    check("solo: the group comes back hidden", G().visible === false && L("B").visible && L("C").visible && !ed.shown(L("B")), ed.groupsCopy());
    ed.setGroupFlag(inner.id, "visible", true);
    // B is the bottom of Inner: clipped, its base would be A (in Outer) - no clip across the group's edge; C onto B works
    L("B").clip = true;
    check("clip: not out of its group", ed.clipBaseOf(L("B")) === null, ed.clipBaseOf(L("B")) && ed.clipBaseOf(L("B")).name);
    L("B").clip = false; L("C").clip = true;
    check("clip: within it", ed.clipBaseOf(L("C")) === L("B"), ed.clipBaseOf(L("C")) && ed.clipBaseOf(L("C")).name);
    L("C").clip = false; touch();

    // ---- moving through the tree -------------------------------------------------------------------------------------------
    // stack: D (top level) | A (Outer) B C (Inner) E (Outer) | F
    const where = () => ed.layers.map((l) => l.name + (l.group ? ":" + gname(l) : "")).join(" ");
    const f1 = L("F");
    ed.moveLayer(f1.id, -1, { undo: true });   // F down: into Outer at its top
    check("step down: into the group below at its top", where() === "D A:Outer B:Inner C:Inner E:Outer F:Outer", where());
    ed.moveLayer(f1.id, -1);   // past E
    ed.moveLayer(f1.id, -1);   // into Inner at its top
    check("step down: past a layer, into the nested group", where() === "D A:Outer B:Inner C:Inner F:Inner E:Outer", where());
    ed.moveLayer(f1.id, +1);   // out of Inner, in place
    check("step up: out of its group at its end", where() === "D A:Outer B:Inner C:Inner F:Outer E:Outer", where());
    await ed.undoStep();
    check("undo of the steps (only the first took one)", where() === "D A:Outer B:Inner C:Inner E:Outer F", where());
    ed.moveLayer(L("C").id, 0, { undo: true, to: "top" });
    check("to top: out of every group", where() === "D A:Outer B:Inner E:Outer F C", where());
    await ed.undoStep();
    check("to top: undo", where() === "D A:Outer B:Inner C:Inner E:Outer F", where());
    // drops: D onto C's row (below) joins Inner; Inner onto F's row (above) leaves Outer
    ed.dropInLayers({ layer: L("D").id }, { layer: L("C").id }, false);
    check("drop onto a row: the layer joins its group", where() === "A:Outer B:Inner D:Inner C:Inner E:Outer F", where());
    ed.dropInLayers({ group: inner.id }, { layer: L("F").id }, true);
    check("drop a group above a row: out of Outer, with its layers", where() === "A:Outer E:Outer F B:Inner D:Inner C:Inner" && G().parent === null, [where(), ed.groupsCopy()]);
    ed.dropInLayers({ group: inner.id }, { group: outer.id }, false);
    check("drop a group onto a group's row (lower half): into it at its top", where() === "A:Outer E:Outer B:Inner D:Inner C:Inner F" && G().parent === outer.id, [where(), ed.groupsCopy()]);
    check("drop a group into itself is refused", ed.dropInLayers({ group: outer.id }, { group: inner.id }, false) === false && ed.dropInLayers({ group: outer.id }, { layer: L("B").id }, true) === false);
    await ed.undoStep(); await ed.undoStep(); await ed.undoStep();
    check("undo of three drops", where() === "D A:Outer B:Inner C:Inner E:Outer F", where());

    // ---- state ---------------------------------------------------------------------------------------------------------------
    ed.setGroupFlag(inner.id, "collapsed", true);
    ed.setGroupFlag(outer.id, "locked", true);
    ed.setGroupFlag(inner.id, "visible", false);
    ed.renameGroup(outer.id, "Outer ä");
    // the panel: two group rows at their depths, the folded one's rows hidden
    const rows = [...ed.layerList.querySelectorAll(".ipc-layer")].map((r) => (r.dataset.group ? "G" + (r.style.getPropertyValue("--ipc-depth") || "0") : (r.dataset.layer ? ed.layers.find((l) => l.id === r.dataset.layer).name + (r.style.getPropertyValue("--ipc-depth") || "") : "base"))).join(" ");
    check("panel: the tree, the folded group's rows left out", rows === "F G0 E1 G1 A1 D base", rows);
    await ed.syncLayers();   // the layers' pixels reach the local store: a state names them by file
    const state = JSON.parse(ed.getValue());
    check("state: the groups", Array.isArray(state.groups) && state.groups.length === 2 && state.layers.filter((l) => l.group).length === 4, state.groups);
    const ed2 = shell.newDocument();
    shell.activate(ed2);
    await new Promise((r) => setTimeout(r, 200));
    const loaded = async (want) => { for (let t = 0; t < 100 && ed2.layers.length < want; t++) await new Promise((r) => setTimeout(r, 100)); };
    await ed2.setValue(JSON.stringify(state));
    await loaded(6);
    const g2 = Object.fromEntries(ed2.groups.map((g) => [g.name, g]));
    check("state: back", g2.Inner && g2["Outer ä"] && g2.Inner.parent === g2["Outer ä"].id && g2.Inner.collapsed && !g2.Inner.visible && g2["Outer ä"].locked
        && ed2.layers.map((l) => l.name + (l.group ? ":" + ed2.groupById(l.group).name : "")).join(" ") === "D A:Outer ä B:Inner C:Inner E:Outer ä F", [ed2.groupsCopy(), ed2.layers.map((l) => l.group)]);
    // a damaged state: a group apart from its run, a cycle, an unknown group and a reference in a group
    const bad = JSON.parse(JSON.stringify(state));
    const bl = bad.layers;
    bl.find((l) => l.name === "F").group = bl.find((l) => l.name === "B").group;   // F apart from Inner's run
    bl.find((l) => l.name === "D").group = "no-such-group";
    bad.groups.push({ id: "c1", name: "c1", parent: "c2" }, { id: "c2", name: "c2", parent: "c1" });
    ed2.layers = [];
    await ed2.setValue(JSON.stringify(bad));
    await loaded(6);
    const F2 = ed2.layers.find((l) => l.name === "F");
    if (!F2) throw new Error("the damaged state lost layers: " + ed2.layers.map((l) => l.name).join(" ") + " / " + fails.join(" | "));
    // F sits next to Outer's run, not Inner's: it leaves Inner and stays in Outer; D's unknown group and the cycle go
    check("damaged state: repaired", ed2.groupById(F2.group) && ed2.groupById(F2.group).name === "Outer ä" && ed2.layers.find((l) => l.name === "D").group === null && ed2.groups.length === 2 && ed2.layers.find((l) => l.name === "B").group, [ed2.groupsCopy(), ed2.layers.map((l) => l.group)]);
    shell.closeDocument && shell.closeDocument(ed2, { force: true });
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 200));
    ed.setGroupFlag(outer.id, "locked", false);
    ed.setGroupFlag(inner.id, "collapsed", false);
    ed.renameGroup(outer.id, "Outer");

    // ---- PSD both ways, ORA ----------------------------------------------------------------------------------------------------
    const { readPsd, readOra } = await import("./editor/inpaint_layered.js");
    const layered = async (fmt, bands) => {
        const keep = ed.constructor.bands;
        if (bands === false) ed.constructor.bands = false;
        try {
            let blob = null;
            const r = await ed.exportLayeredBands(fmt);
            if (r) blob = r.blob;
            else {
                const { buildLayered } = await import("./editor/inpaint_jobs.js");
                const { layers } = ed.exportLayerStack(fmt);
                blob = await buildLayered(fmt, { width: W, height: H, layers, composite: ed.flattenToCanvas({ forRun: true }) });
            }
            return { bytes: new Uint8Array(await blob.arrayBuffer()), banded: !!r };
        } finally { ed.constructor.bands = keep; }
    };
    const inflateRaw = async (data) => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    for (const bands of [true, false]) {
        const { bytes: psd, banded } = await layered("psd", bands);
        const back = await readPsd(psd);
        const bg = Object.fromEntries((back.groups || []).map((g) => [g.name, g]));
        const lay = back.layers.map((l) => l.name + (l.group ? ":" + back.groups.find((g) => g.id === l.group).name : "")).join(" ");
        const tag = `PSD (${banded ? "band writer" : "canvas writers"})`;
        check(`${tag}: groups back`, bg.Inner && bg.Outer && bg.Inner.parent === bg.Outer.id && bg.Inner.visible === false && bg.Outer.visible === true && !back.notes.some((n) => /opacity of|pass through/.test(n)), [back.groups, back.notes]);
        check(`${tag}: layers in them`, lay === "Background D A:Outer B:Inner C:Inner E:Outer F" && back.layers.every((l) => l.visible), lay);
        out[bands ? "psdBands" : "psdCanvas"] = banded;
    }
    {
        const { bytes: ora } = await layered("ora", true);
        const back = await readOra(ora, { inflateRaw });
        const vis = back.layers.map((l) => l.name + (l.visible ? "" : "-")).join(" ");
        check("ORA: a hidden group's layers are written hidden", vis === "Background D A B- C- E F", vis);
    }
    // the opened PSD makes the groups of the document
    {
        const { bytes: psd } = await layered("psd", true);
        const ed3 = shell.newDocument();
        shell.activate(ed3);
        await new Promise((r) => setTimeout(r, 200));
        const file = new File([psd], "groups.psd");
        await ed3.loadLayered(file, "psd");
        const lay = ed3.layers.map((l) => l.name + (l.group ? ":" + ed3.groupById(l.group).name : "")).join(" ");
        check("PSD opened: the groups in the document", lay === "D A:Outer B:Inner C:Inner E:Outer F" && ed3.groups.length === 2 && ed3.groups.find((g) => g.name === "Inner").visible === false, [lay, ed3.groupsCopy(), ed3.status]);
        // dropped on the document: its layers on top, in groups of their own
        await ed3.addImageLayers([new File([psd], "again.psd")], "none", { place: "at", at: [0, 0] });
        const top = ed3.layers.slice(6);
        const lay2 = top.map((l) => l.name + (l.group ? ":" + ed3.groupById(l.group).name : "")).join(" ");
        check("PSD dropped: its groups come along", ed3.groups.length === 4 && lay2 === "Background D A:Outer B:Inner C:Inner E:Outer F" && top.every((l) => !l.group || !ed3.layers.slice(0, 6).some((m) => m.group === l.group)), [lay2, ed3.groupsCopy()]);
        shell.closeDocument && shell.closeDocument(ed3, { force: true });
        shell.activate(ed);
        await new Promise((r) => setTimeout(r, 200));
    }
    ed.setGroupFlag(inner.id, "visible", true);

    // ---- ungroup and delete group ----------------------------------------------------------------------------------------------
    ed.ungroup(inner.id);
    check("ungroup: the layers stay, in the group around", where() === "D A:Outer B:Outer C:Outer E:Outer F" && ed.groups.length === 1, where());
    await ed.undoStep();
    check("ungroup: undo", where() === "D A:Outer B:Inner C:Inner E:Outer F", where());
    const n0 = ed.layers.length;
    ed.removeGroup(outer.id);
    check("delete group: with its layers and the group inside", ed.layers.length === n0 - 4 && ed.groups.length === 0 && where() === "D F", where());
    await ed.undoStep();
    check("delete group: undo", where() === "D A:Outer B:Inner C:Inner E:Outer F" && ed.groups.length === 2, where());

    // ---- the commands ------------------------------------------------------------------------------------------------------------
    const call = (name, args = {}) => shell.commands.run(name, { doc: ed.node.id, ...args });
    const ls = await call("list_layers");
    check("list_layers: groups and each layer's group", ls.groups && ls.groups.length === 2 && ls.layers.find((l) => l.name === "B").group === inner.id && ls.groups.find((g) => g.name === "Inner").parent === outer.id, ls.groups);
    await call("set_group", { group: "Inner", visible: false, collapsed: true });
    const ls2 = await call("list_layers");
    check("set_group: hidden and folded; list_layers says a layer is hidden by its group", G().visible === false && G().collapsed && ls2.layers.find((l) => l.name === "B").hidden_by_group === true, ls2.layers.find((l) => l.name === "B"));
    await call("set_group", { group: "Inner", visible: true, collapsed: false });
    const made = await call("group_layers", { layers: ["D", "F"], name: "Cmd" });
    check("group_layers: D and F together at F's place", made.name === "Cmd" && made.layers.length === 2 && where() === "A:Outer B:Inner C:Inner E:Outer D:Cmd F:Cmd", [made, where()]);
    await call("move_layer", { layer: "B", to: "top" });
    check("move_layer top: out of every group", where() === "A:Outer C:Inner E:Outer D:Cmd F:Cmd B", where());
    await call("ungroup_layers", { group: "Cmd" });
    check("ungroup_layers", !ed.groups.some((g) => g.name === "Cmd") && where() === "A:Outer C:Inner E:Outer D F B", where());
    let refused = null;
    try { await call("set_group", { group: "nope", visible: false }); } catch (err) { refused = String(err.message || err); }
    check("set_group: an unknown group is named", refused && /no group "nope"/.test(refused), refused);

    out.fails = fails;
    return out;
})()
"""


async def run(c):
    r = await c.eval(JS, timeout=300)
    print(json.dumps({k: v for k, v in r.items() if k != "fails"}))
    for f in r["fails"]:
        print("[FAIL]", f)
    print("PASS" if not r["fails"] else f"FAIL ({len(r['fails'])})")
    return not r["fails"]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run)) else 1)


if __name__ == "__main__":
    main()
