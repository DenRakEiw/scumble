"""Clipping gate (docs/PLAN_0_1_31.md §6 step 3): a layer clipped to the layer below on every compositing path.

One deterministic document: a base layer (an ellipse through a gradient mask), four layers clipped to it (normal at an
opacity, multiply at another offset and size, linear light, a clipped filter layer), an unclipped layer, a clipped
layer over a hidden base and a clipped layer over a filter layer (no effect). The checks:

  * analytic, on the full flatten (Canvas 2D) and the export (the tile workers' program on tiles): where the base's
    coverage is 0 the picture is the one with the clipped layers hidden, byte for byte; where it is 255 the one with
    their clip switched off; somewhere in between it differs from both
  * the paths agree: the full flatten, the PNG export, the box read, the region pass at 1:1, and the view drawn by the
    GPU compositor against Canvas 2D (filter layers hidden: the compositor does not take them)
  * the clip over a hidden base shows nothing, the clip over a filter layer is no clip
  * the switch is one undo step; getValue / setValue keep it; a PSD keeps it both ways
  * merging a clipped layer into its base, and two clipped layers into each other, keeps the picture

    python tools/clip_test.py [--tolerance 2]

Needs the app on the debugging port (tools/cdp.py); no ComfyUI.
"""
import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

JS = r"""
(async () => {
    const shell = await import("./shell.js");
    const W = 360, H = 240;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 300));
    ed.resizeCanvas();
    const { Layer: LP, Mask: MP } = ed.pixels;
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const settle = async () => { await ed.mipsSettled(); await new Promise((r) => setTimeout(r, 100)); };
    const touch = () => { ed.uploaded.baseHash = null; ed.flatCache = null; ed.sceneSig = null; ed.filterPreview = null; for (const l of ed.layers) { l._fcache = null; l._fcacheView = null; } };

    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#1a3a6a"); g.addColorStop(1, "#d8c8a0");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        for (let i = 0; i < 8; i++) { x.fillStyle = `hsl(${i * 45},60%,45%)`; x.fillRect(10 + i * 44, 170, 36, 50); }
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "clip_ref.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });

    const layer = (name, w, h, draw, props) => {
        const c = mk(w, h); draw(c.getContext("2d"), w, h);
        const l = ed.addLayer({ name, kind: "paint", px: LP.fromCanvas(c), x: 0, y: 0, w, h, dirty: true, ...props });
        return l;
    };
    // the base: an anti-aliased ellipse, its mask a gradient from hidden (left) to shown, so every coverage occurs
    const bl = layer("base", 240, 180, (x) => { x.fillStyle = "#e03020"; x.beginPath(); x.ellipse(120, 90, 110, 80, 0, 0, Math.PI * 2); x.fill(); }, { x: 30, y: 20 });
    {
        const m = mk(240, 180), mx = m.getContext("2d");
        const g = mx.createLinearGradient(0, 0, 240, 0);
        g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.45, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,1)");
        mx.fillStyle = g; mx.fillRect(0, 0, 240, 180);
        bl.maskPx = MP.fromCanvas(m); bl.maskDirty = true; ed.markMaskChanged(bl);
    }
    const stripes = (x, w, h) => { for (let i = 0; i < w; i += 20) { x.fillStyle = (i / 20) % 2 ? "#2040f0" : "#f0e020"; x.fillRect(i, 0, 20, h); } };
    const cn = layer("clipN", W, H, stripes, { opacity: 0.8, clip: true });
    const cm = layer("clipM", 200, 120, (x, w, h) => { const g = x.createLinearGradient(0, 0, w, 0); g.addColorStop(0, "#20c040"); g.addColorStop(1, "#c0f0ff"); x.fillStyle = g; x.fillRect(0, 0, w, h); }, { x: 100, y: 60, blend: "multiply", clip: true });
    const cl = layer("clipLL", 120, 90, (x, w, h) => { x.fillStyle = "#a07030"; x.fillRect(0, 0, w, h); }, { x: 40, y: 100, blend: "linear-light", opacity: 0.7, clip: true });
    const fx = ed.addFilterLayer("hue_sat");
    fx.params = { ...fx.params, hue: 120, saturation: 30 };
    fx.clip = true; fx.name = "fxClip"; fx.id = "clip-test-fx";
    const free = layer("free", 80, 200, (x, w, h) => { x.fillStyle = "rgba(250,250,250,0.6)"; x.fillRect(0, 0, w, h); }, { x: 270, y: 20 });
    const hb = layer("hiddenBase", 100, 100, (x, w, h) => { x.fillStyle = "#000"; x.fillRect(0, 0, w, h); }, { x: 250, y: 120, visible: false });
    const orphan = layer("orphan", W, H, (x, w, h) => { x.fillStyle = "#ff00ff"; x.fillRect(0, 0, w, h); }, { clip: true });
    const fx2 = ed.addFilterLayer("brightness_contrast");
    fx2.params = { ...fx2.params, brightness: 10 };
    fx2.name = "fx2"; fx2.id = "clip-test-fx2";
    const after = layer("afterFx", 60, 60, (x, w, h) => { x.fillStyle = "#00e0e0"; x.fillRect(0, 0, w, h); }, { x: 10, y: 10, clip: true });
    touch();
    ed.renderLayers();
    ed.view = { scale: 1, x: 20, y: 20, angle: 0 };
    ed.draw();
    await settle();

    const bytes = (c) => c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    const full = () => { touch(); return bytes(ed.flattenToCanvas({ forRun: false })); };
    const png = async () => {
        touch();
        const r = await ed.encodeComposite({ forRun: true }, {});
        if (!r || !r.blob) return null;
        const bmp = await createImageBitmap(r.blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        const c = mk(bmp.width, bmp.height); c.getContext("2d").drawImage(bmp, 0, 0); bmp.close();
        return bytes(c);
    };
    const box = async () => { touch(); const r = await ed.readBoxBytes([0, 0, W, H], { forRun: true }); return { data: new Uint8Array(r.data.subarray ? r.data.subarray(0, W * H * 4) : r.data), how: r.how }; };
    const region = () => { touch(); const c = ed.sampleRegion("image", [0, 0, W, H], 1, { forRun: false }); return c && c.width === W && c.height === H ? bytes(c) : null; };
    const where = (a, b) => { const o = []; for (let i = 0; i < W * H && o.length < 4; i++) { let d = 0; for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a[i * 4 + k] - b[i * 4 + k])); if (d > 2) o.push([i % W, (i / W) | 0, Array.from(a.slice(i * 4, i * 4 + 4)), Array.from(b.slice(i * 4, i * 4 + 4))]); } return o; };
    // the difference where the base's coverage is 0 or 255 only (`cov` below): what a merge keeps exactly
    const diffSolid = (a, b) => { let m = 0, n = 0; for (let i = 0; i < W * H; i++) { if (cov[i] !== 0 && cov[i] !== 255) continue; for (let k = 0; k < 4; k++) { const d = Math.abs(a[i * 4 + k] - b[i * 4 + k]); if (d) { n++; if (d > m) m = d; } } } return { max: m, n }; };
    const diff = (a, b) => { if (!a || !b) return null; if (a.length !== b.length) return { max: 999, n: -1 }; let m = 0, n = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > m) m = d; } } return { max: m, n }; };
    const out = { tiles: !!ed.tileMode };

    // the base's coverage per image pixel: its alpha through its mask (opacity 1)
    const cov = new Uint8Array(W * H);
    {
        const lc = mk(W, H), x = lc.getContext("2d", { willReadFrequently: true });
        x.drawImage(ed.layerPixels(bl), bl.x, bl.y, bl.w, bl.h);
        const d = x.getImageData(0, 0, W, H).data;
        for (let i = 0; i < W * H; i++) cov[i] = d[i * 4 + 3];
    }
    const clipped = [cn, cm, cl, fx];
    window.__clipTest = { ed, bl, cn, cm, cl, fx, fx2, cov, full, png, diff, touch, layer, W, H };   // for a look by hand
    const analytic = async (read) => {
        const on = await read();
        for (const l of clipped) l.visible = false;
        const hidden = await read();
        for (const l of clipped) { l.visible = true; l.clip = false; }
        const unclipped = await read();
        for (const l of clipped) l.clip = true;
        touch();
        if (!on || !hidden || !unclipped) return null;
        let zero = { n: 0, max: 0 }, full = { n: 0, max: 0 }, mid = 0, midDiff = 0;
        for (let i = 0; i < W * H; i++) {
            let dh = 0, du = 0;
            for (let k = 0; k < 4; k++) { dh = Math.max(dh, Math.abs(on[i * 4 + k] - hidden[i * 4 + k])); du = Math.max(du, Math.abs(on[i * 4 + k] - unclipped[i * 4 + k])); }
            if (cov[i] === 0) { zero.n++; zero.max = Math.max(zero.max, dh); }
            else if (cov[i] === 255) { full.n++; full.max = Math.max(full.max, du); }
            else { mid++; if (dh > 3 && du > 3) midDiff++; }
        }
        return { zero, full, mid, midDiff };
    };
    out.analyticFull = await analytic(async () => full());
    out.analyticPng = await analytic(png);

    // the paths against the full flatten
    const f = full();
    out.png = diff(f, await png());
    const b = await box();
    out.box = { ...diff(f, b.data), how: b.how };
    out.region = diff(f, region());
    // without the filter layers: the box a brush reads (compositeBox, synchronous, from the stack plan) and the workers'
    // plain stack (readBoxBytes "stack")
    {
        fx.visible = false; fx2.visible = false;
        const f2 = full();
        const plan = ed.stackPlan({ forRun: false });
        if (plan) {
            const { compositeBox } = await import("./editor/inpaint_boxstack.js");
            out.boxStack = diff(f2, compositeBox(plan, 0, 0, W, H, W, H));
        } else out.boxStack = ed.tileMode ? null : { max: 0, n: 0, skipped: "canvas backend" };
        const b2 = await box();
        out.boxPlain = { ...diff(f2, b2.data), how: b2.how };
        fx.visible = true; fx2.visible = true;
        touch();
    }

    // a clip over a hidden base shows nothing; a clip over a filter layer is no clip
    orphan.visible = false; const noOrphan = full(); orphan.visible = true;
    out.orphan = diff(f, noOrphan);
    after.clip = false; const afterPlain = full(); after.clip = true;
    out.afterFx = diff(f, afterPlain);
    out.afterBase = ed.clipBaseOf(after) ? ed.clipBaseOf(after).name : null;

    // the view: GPU compositor against Canvas 2D at 1:1, the filter layers hidden
    {
        fx.visible = false; fx2.visible = false;
        const shot = () => { ed.sceneSig = null; ed.flatCache = null; ed.uploaded.baseHash = null; ed.draw(); const c = mk(ed.canvas.width, ed.canvas.height); c.getContext("2d").drawImage(ed.canvas, 0, 0); return bytes(c); };
        await settle();
        ed.compositorOff = true; const cpu = shot();
        ed.compositorOff = false; const used = ed.glCompositeUsable({});
        shot(); await settle(); const gpu = shot();
        let max = 0, over = 0;
        for (let i = 0; i < cpu.length; i += 4) {
            const aa = cpu[i + 3], ba = gpu[i + 3];
            let d = Math.abs(aa - ba);
            for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(cpu[i + k] * aa / 255 - gpu[i + k] * ba / 255));
            if (d > max) max = d; if (d > 2) over++;
        }
        // the clipped layers really are in the view: hiding them changes it
        cn.visible = false; ed.compositorOff = false; const gpuNoClip = shot(); cn.visible = true;
        out.view = { used, max: +max.toFixed(2), over, clipShows: diff(gpu, gpuNoClip).n > 0 };
        // premultiplied difference of the two paths' screens, drawn as `setup()` leaves the document
        const pair = async (setup) => {
            setup();
            ed.compositorOff = true; await settle(); const c2 = shot();
            ed.compositorOff = false; shot(); await settle(); const g2 = shot();
            let m = 0;
            for (let i = 0; i < c2.length; i += 4) { const aa = c2[i + 3], ba = g2[i + 3]; let d = Math.abs(aa - ba); for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(c2[i + k] * aa / 255 - g2[i + k] * ba / 255)); if (d > m) m = d; }
            return +m.toFixed(2);
        };
        // the base at 60 %: its opacity is part of the coverage (on the tiles backend the export must agree as well)
        const blNow = ed.layers.find((l) => l.id === bl.id);
        out.viewOpacity = await pair(() => { blNow.opacity = 0.6; touch(); });
        out.pngOpacity = ed.tileMode ? diff(full(), await png()) : null;
        blNow.opacity = 1; touch();
        // a base with no tile at all (emptied), right after frames that drew its coverage at the same size: the clipped
        // layers show nothing, and the compositor must not take the coverage its third target kept from those frames
        {
            const px0 = blNow.px;
            out.viewEmpty = await pair(() => { blNow.px = LP.empty(px0.width, px0.height); touch(); });
            blNow.px = px0; touch();
        }
        // the base off the view after a frame that showed it: the compositor's coverage target still holds that frame
        const was = { ...ed.view };
        out.viewOff = await pair(() => { ed.view = { scale: 16, x: Math.round(ed.canvas.width / 2 - 340 * 16), y: Math.round(ed.canvas.height / 2 - 232 * 16), angle: 0 }; touch(); });
        const reg = ed.viewportRegion();
        out.viewOffRegion = reg ? [reg.x, reg.y, reg.x + reg.w, reg.y + reg.h].map(Math.round) : null;
        ed.view = was;
        fx.visible = true; fx2.visible = true;
        touch(); ed.draw();
    }

    // one undo step; the state keeps it
    {
        const n0 = ed.undo.length;
        ed.selectLayers([cm.id]);
        const r1 = ed.setLayerClip(cm, false);
        const off = !cm.clip;
        await ed.undoStep();
        const back = ed.layers.find((l) => l.id === cm.id);
        out.undo = { refusedBottom: !ed.setLayerClip(ed.layers[0], true), r1, off, steps: ed.undo.length - n0, back: !!(back && back.clip) };
        const v = JSON.parse(ed.getValue());
        out.state = v.layers.filter((l) => l.clip).map((l) => l.name).sort();
    }

    // the PSD keeps the flag both ways
    {
        const { buildPsd } = await import("./editor/inpaint_export.js");
        const { readPsd } = await import("./editor/inpaint_layered.js");
        const { layers } = ed.exportLayerStack("psd");
        const comp = ed.flattenToCanvas({ forRun: true });
        const bytesPsd = buildPsd({ width: W, height: H, layers, composite: comp });
        const buf = bytesPsd instanceof Blob ? new Uint8Array(await bytesPsd.arrayBuffer()) : new Uint8Array(bytesPsd.buffer || bytesPsd);
        const doc = await readPsd(buf, {});
        out.psdWritten = layers.filter((l) => l.clip).map((l) => l.name).sort();
        out.psdRead = doc.layers.filter((l) => l.clip).map((l) => l.name).sort();
    }

    // merges keep the picture (normal layers at full opacity, where a merge is exact): a clipped layer into the clipped
    // one below it, then a clipped layer into its base
    {
        const cnNow = ed.layers.find((l) => l.id === cn.id);
        cnNow.opacity = 1;
        const top = layer("clipTop", 160, 60, (x, w, h) => { x.fillStyle = "rgba(255,120,0,0.75)"; x.fillRect(0, 0, w, h); }, { x: 20, y: 90, clip: true });
        ed.layers.splice(ed.layers.indexOf(top), 1);
        ed.layers.splice(ed.layers.indexOf(cnNow) + 1, 0, top);
        const b0 = full();
        await ed.mergeDownNow(top);
        const m1 = full();
        out.mergeClipped = { ...diffSolid(b0, m1), all: diff(b0, m1), stillClipped: !!ed.layers.find((l) => l.id === cn.id).clip, at: where(b0, m1) };
        const b1 = full();
        await ed.mergeDownNow(ed.layers.find((l) => l.id === cn.id));
        const m2 = full();
        const baseNow = ed.layers.find((l) => l.id === bl.id);
        // the merged base keeps its alpha (source-atop), so the layers still clipped to it keep their coverage
        let alphaMax = 0;
        { const lc = mk(W, H), x = lc.getContext("2d", { willReadFrequently: true }); x.drawImage(ed.layerPixels(baseNow), baseNow.x, baseNow.y, baseNow.w, baseNow.h); const d = x.getImageData(0, 0, W, H).data; for (let i = 0; i < W * H; i++) alphaMax = Math.max(alphaMax, Math.abs(d[i * 4 + 3] - cov[i])); }
        out.mergeIntoBase = { ...diffSolid(b1, m2), all: diff(b1, m2), alphaMax, baseClip: !!baseNow.clip, gone: !ed.layers.some((l) => l.id === cn.id) };
    }
    return out;
})()
"""


async def run(c, args):
    tol = args.tolerance
    r = await c.eval(JS, timeout=600)
    ok = True

    def check(cond, line):
        nonlocal ok
        print(("[ok] " if cond else "[FAIL] ") + line)
        ok = ok and cond

    print(f"backend: {'tiles' if r['tiles'] else 'canvas'}")
    for key in ("analyticFull", "analyticPng"):
        a = r[key]
        if a is None and key == "analyticPng" and not r["tiles"]:
            print(f"[skip] {key}: no worker export on the canvas backend")
            continue
        if a is None:
            check(False, f"{key}: no picture")
            continue
        # the export (the workers' kernel, one path for all three pictures) is exact; the Canvas 2D flatten reads its canvas
        # back for a clipped layer, which Chromium then keeps in software: a level or two, as between any two Canvas 2D paths
        lim = 0 if key == "analyticPng" else tol
        check(a["zero"]["max"] <= lim and a["zero"]["n"] > 1000, f"{key}: coverage 0 = clipped layers hidden ({a['zero']['n']} px, max {a['zero']['max']})")
        check(a["full"]["max"] <= lim and a["full"]["n"] > 1000, f"{key}: coverage 255 = clip off ({a['full']['n']} px, max {a['full']['max']})")
        check(a["midDiff"] > 100, f"{key}: partial coverage differs from both ({a['midDiff']} of {a['mid']} px)")
    for key in ("png", "box", "region", "boxStack", "boxPlain"):
        d = r[key]
        if d is None and key == "png" and not r["tiles"]:
            print(f"[skip] {key}: no worker export on the canvas backend")
            continue
        check(d is not None and d.get("max", 999) <= tol, f"{key} vs full flatten: {d}")
    check(r["orphan"] and r["orphan"]["n"] == 0, f"clip over a hidden base shows nothing: {r['orphan']}")
    check(r["afterFx"] and r["afterFx"]["n"] == 0 and r["afterBase"] is None, f"clip over a filter layer is no clip: {r['afterFx']}, base {r['afterBase']}")
    v = r["view"]
    check(v["used"] and v["max"] <= tol and v["clipShows"], f"view: GPU vs Canvas 2D at 1:1 max {v['max']} ({v['over']} px over 2), compositor used {v['used']}, clip visible {v['clipShows']}")
    # a base below 100 %: Canvas 2D draws it through globalAlpha, the kernel through mul255, a level apart on the base
    # alone; each clipped layer over it is within 2, the three together 3 (measured 2026-09-30): one level more here
    check(r["viewOpacity"] <= tol and (r["pngOpacity"] is None or r["pngOpacity"]["max"] <= tol + 1), f"base at 60 %: view GPU vs Canvas 2D max {r['viewOpacity']}, export vs flatten {r['pngOpacity']}")
    check(r["viewEmpty"] <= tol, f"an empty base: GPU vs Canvas 2D max {r['viewEmpty']}")
    reg = r["viewOffRegion"] or [0, 0, 0, 0]
    check(r["viewOff"] <= tol and (reg[0] >= 270 or reg[1] >= 200), f"base off the view: GPU vs Canvas 2D max {r['viewOff']} (view {r['viewOffRegion']}, the base at 30..270 x 20..200)")
    u = r["undo"]
    check(u["r1"] and u["off"] and u["back"] and u["refusedBottom"], f"undo: {u}")
    check(r["state"] == sorted(["clipN", "clipM", "clipLL", "fxClip", "orphan", "afterFx"]), f"getValue keeps clip: {r['state']}")
    # the PSD: a clip without effect (afterFx over a filter) and filter layers are not written clipped
    check(r["psdWritten"] == sorted(["clipN", "clipM", "clipLL", "orphan"]) and r["psdRead"] == r["psdWritten"], f"PSD written {r['psdWritten']}, read back {r['psdRead']}")
    m1, m2 = r["mergeClipped"], r["mergeIntoBase"]
    # where the base is only partly there, a stack of two layers masked by it is not one merged layer masked by it
    # (the clip is the base's coverage as a mask, not an isolated group): the merges are gated where it is 0 or 255
    check(m1["max"] <= tol and m1["stillClipped"], f"merge two clipped layers (coverage 0 / 255): {m1}")
    check(m2["max"] <= tol and m2["alphaMax"] <= 1 and not m2["baseClip"] and m2["gone"], f"merge a clipped layer into its base (coverage 0 / 255): {m2}")
    print("PASS" if ok else "FAIL")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tolerance", type=int, default=2)
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(lambda c: run(c, args))) else 1)


if __name__ == "__main__":
    main()
