"""Mask view gate: layer-mask overlay, black-and-white view, filter effect view (PLAN_NIK9_BUILD.md §R1-S10).

    python tools/maskview_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

STEPS = [
    ("setup", """
const d = await run("new_document");
window.__maskDoc = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 400, height: 300, color: "#808080" });
return { doc: d.id, width: ed.width, height: ed.height, tiles: !!ed.tileMode };
"""),

    ("create_layer_with_mask", """
const ed = ednow(window.__maskDoc);
const l = ed.addPaintLayer();
l.name = "TestPaint";

// Paint layer filled with green [0, 170, 0]
const c = document.createElement("canvas");
c.width = 400; c.height = 300;
const ctx = c.getContext("2d");
ctx.fillStyle = "#00aa00";
ctx.fillRect(0, 0, 400, 300);
l.px = ed.pixels.Layer.fromCanvas(c);

// Mask: left half [0, 0, 200, 300] is black (0, hidden), right half [200, 0, 200, 300] is white (255, revealed)
const mc = document.createElement("canvas");
mc.width = 400; mc.height = 300;
const mctx = mc.getContext("2d");
mctx.clearRect(0, 0, 400, 300);
mctx.fillStyle = "#ffffff";
mctx.fillRect(200, 0, 200, 300);
l.maskPx = ed.pixels.Mask.fromCanvas(mc);

ed.markLayerChanged(l);
ed.markMaskChanged(l);
ed.renderLayers();
ed.sceneSig = null;
ed.draw();
await wait(100);

window.__testLayerId = l.id;
return { layerId: l.id };
"""),

    ("case1_overlay_probes", """
const ed = ednow(window.__maskDoc);
const l = ed.layers.find((x) => x.id === window.__testLayerId);

// Probe right half without overlay
ed.maskView = null;
ed.sceneSig = null;
ed.draw();
await wait(100);

const probe = (ix, iy) => {
    const [sx, sy] = ed.imageToScreen(ix, iy);
    const d = ed.canvas.getContext("2d").getImageData(Math.round(sx), Math.round(sy), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
};

const rightWithoutOverlay = probe(300, 150);

// Turn overlay on
ed.maskView = { id: l.id, mode: "overlay" };
ed.draw();
await wait(100);

const leftWithOverlay = probe(100, 150);
const rightWithOverlay = probe(300, 150);

// Case 1 assertion: left half R - G >= 40
const rMinusG = leftWithOverlay[0] - leftWithOverlay[1];
if (rMinusG < 40) {
    throw new Error(`overlay left half R - G < 40: R=${leftWithOverlay[0]}, G=${leftWithOverlay[1]}, diff=${rMinusG}`);
}

// Case 1 assertion: right half equals view without overlay +-2
const diffR = Math.abs(rightWithOverlay[0] - rightWithoutOverlay[0]);
const diffG = Math.abs(rightWithOverlay[1] - rightWithoutOverlay[1]);
const diffB = Math.abs(rightWithOverlay[2] - rightWithoutOverlay[2]);
if (diffR > 2 || diffG > 2 || diffB > 2) {
    throw new Error(`overlay right half moved: before=${JSON.stringify(rightWithoutOverlay)}, after=${JSON.stringify(rightWithOverlay)}`);
}

return { rMinusG, diffRight: [diffR, diffG, diffB] };
"""),

    ("case2_alone_probes", """
const ed = ednow(window.__maskDoc);
const l = ed.layers.find((x) => x.id === window.__testLayerId);

// Turn alone mode on
ed.maskView = { id: l.id, mode: "alone" };
ed.draw();
await wait(100);

const probe = (ix, iy) => {
    const [sx, sy] = ed.imageToScreen(ix, iy);
    const d = ed.canvas.getContext("2d").getImageData(Math.round(sx), Math.round(sy), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
};

const leftAlone = probe(100, 150);
const rightAlone = probe(300, 150);

// Case 2 assertion: left probe 0 +- 2, right probe 255 +- 2
if (leftAlone[0] > 2 || leftAlone[1] > 2 || leftAlone[2] > 2) {
    throw new Error(`alone mode left probe not black (0+-2): ${JSON.stringify(leftAlone)}`);
}
if (rightAlone[0] < 253 || rightAlone[1] < 253 || rightAlone[2] < 253) {
    throw new Error(`alone mode right probe not white (255+-2): ${JSON.stringify(rightAlone)}`);
}

// Verify mask label text reads "mask ◐"
ed.renderLayers();
const row = ed.layerList.querySelector(`[data-layer="${CSS.escape(l.id)}"]`);
const maskLabel = row && row.querySelector(".ipc-mask-off, span:not([class])");
const labelText = maskLabel ? maskLabel.textContent : "";
if (!labelText.includes("mask ◐")) {
    // Check all spans in row
    const spans = Array.from(row.querySelectorAll("span")).map((s) => s.textContent);
    if (!spans.some((t) => t.includes("mask ◐"))) {
        throw new Error(`mask label does not read "mask ◐" while viewed: ${JSON.stringify(spans)}`);
    }
}

return { leftAlone, rightAlone, labelText };
"""),

    ("case3_effect_probes", """
const ed = ednow(window.__maskDoc);
const W = await import("./editor/inpaint_weights.js");
const { makeMap } = await import("./editor/inpaint_maps.js");

// Add a levels filter layer
const flRes = await run("add_filter", { doc: window.__maskDoc, filter: "levels" });
const rawFl = ed.layers.find((x) => x.id === flRes.id);
window.__filterLayerId = rawFl.id;

// Setup a horizontal depth ramp map: [0..1] from left to right
const u16Ramp = new Uint16Array(400 * 300);
for (let y = 0; y < 300; y++) {
    for (let x = 0; x < 400; x++) {
        u16Ramp[y * 400 + x] = Math.round((x / 399) * 65535);
    }
}
const depthMap = makeMap("depth", 400, 300, u16Ramp, [400, 0, 0, 300, 0, 0]);
await ed.setMap("depth", depthMap);

// Depth limit: lo 0.25, hi 0.75, falloff 0.1
const limitObj = { source: "depth", lo: 0.25, hi: 0.75, fLo: 0.1, fHi: 0.1, invert: false };
rawFl.params = { in_min: 0, in_max: 255, limit: limitObj };
ed.markFilterChanged(rawFl);

// Turn effect view on
ed.maskView = { id: rawFl.id, mode: "effect" };
ed.sceneSig = null;
ed.draw();
await wait(150);

const probe = (ix, iy) => {
    const [sx, sy] = ed.imageToScreen(ix, iy);
    const d = ed.canvas.getContext("2d").getImageData(Math.round(sx), Math.round(sy), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
};

// Probe at x=100 (v = 100/399 ~ 0.2506) and x=200 (v = 200/399 ~ 0.5012)
const v1 = 100 / 399;
const w1 = W.rangeWeight(v1, limitObj);
const exp1 = Math.round(255 * w1);

const v2 = 200 / 399;
const w2 = W.rangeWeight(v2, limitObj);
const exp2 = Math.round(255 * w2);

const p1 = probe(100, 150);
const p2 = probe(200, 150);

if (Math.abs(p1[0] - exp1) > 2 || Math.abs(p1[1] - exp1) > 2 || Math.abs(p1[2] - exp1) > 2) {
    throw new Error(`probe 1 grey mismatch: got ${JSON.stringify(p1)}, expected ${exp1} +-2`);
}
if (Math.abs(p2[0] - exp2) > 2 || Math.abs(p2[1] - exp2) > 2 || Math.abs(p2[2] - exp2) > 2) {
    throw new Error(`probe 2 grey mismatch: got ${JSON.stringify(p2)}, expected ${exp2} +-2`);
}

return { p1, exp1, p2, exp2 };
"""),

    ("case4_png_export_byte_equal", """
const ed = ednow(window.__maskDoc);
const paintLayerId = window.__testLayerId;
const filterLayerId = window.__filterLayerId;

let capturedBytes = null;
const origSave = host.saveExport;
host.saveExport = async (blob, name) => {
    capturedBytes = new Uint8Array(await blob.arrayBuffer());
    return { path: name };
};

let bNone, bOverlay, bAlone, bEffect;
try {
    // Export with view: none
    ed.maskView = null;
    await ed.exportImage({ download: false });
    bNone = capturedBytes;

    // Export with view: overlay
    ed.maskView = { id: paintLayerId, mode: "overlay" };
    await ed.exportImage({ download: false });
    bOverlay = capturedBytes;

    // Export with view: alone
    ed.maskView = { id: paintLayerId, mode: "alone" };
    await ed.exportImage({ download: false });
    bAlone = capturedBytes;

    // Export with view: effect
    ed.maskView = { id: filterLayerId, mode: "effect" };
    await ed.exportImage({ download: false });
    bEffect = capturedBytes;
} finally {
    host.saveExport = origSave;
    ed.maskView = null;
}

if (!bNone || !bOverlay || !bAlone || !bEffect) {
    throw new Error("one or more exports failed to produce bytes");
}

const same = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
};

if (!same(bNone, bOverlay)) throw new Error("overlay export differs from none export");
if (!same(bNone, bAlone)) throw new Error("alone export differs from none export");
if (!same(bNone, bEffect)) throw new Error("effect export differs from none export");

return { byteLength: bNone.length, allEqual: true };
"""),

    ("case5_15k_no_mirror_over_64mb", """
const ed = ednow(window.__maskDoc);
if (!ed.tileMode) return { skipped: "canvas backend" };

const d15k = await run("new_document");
const ed15k = ednow(d15k.id);
host.shell.activate(ed15k);
await run("new_canvas", { doc: d15k.id, width: 15000, height: 10000, color: "#808080" });

const l15 = ed15k.addPaintLayer();
// Create a small tile mask on the layer
l15.maskPx = new ed15k.pixels.Mask(15000, 10000);
ed15k.markLayerChanged(l15);
ed15k.markMaskChanged(l15);

let maxCanvasMB = 0;
const origCreate = document.createElement;
document.createElement = function(tag, ...args) {
    const el = origCreate.call(document, tag, ...args);
    if (tag === "canvas") {
        let _w = el.width, _h = el.height;
        Object.defineProperty(el, "width", {
            get() { return _w; },
            set(v) { _w = v; const mb = (_w * _h * 4) / 1048576; if (mb > maxCanvasMB) maxCanvasMB = mb; }
        });
        Object.defineProperty(el, "height", {
            get() { return _h; },
            set(v) { _h = v; const mb = (_w * _h * 4) / 1048576; if (mb > maxCanvasMB) maxCanvasMB = mb; }
        });
    }
    return el;
};

try {
    ed15k.maskView = { id: l15.id, mode: "overlay" };
    ed15k.sceneSig = null;
    ed15k.draw();
    await wait(100);
} finally {
    document.createElement = origCreate;
}

if (maxCanvasMB > 64) throw new Error(`canvas over 64 MB allocated: ${maxCanvasMB.toFixed(1)} MB`);

const mirror = l15.maskPx.displayCanvasIfMade && l15.maskPx.displayCanvasIfMade();
if (mirror && (mirror.width * mirror.height * 4) > 64 * 1024 * 1024) {
    throw new Error(`mask mirror exceeded 64MB: ${mirror.width}x${mirror.height}`);
}

if (typeof ed15k.memoryReport === "function") {
    const rep = ed15k.memoryReport();
    if (rep && rep.mirrors) {
        for (const [k, bytes] of Object.entries(rep.mirrors)) {
            if (bytes > 64 * 1024 * 1024) throw new Error(`mirror ${k} exceeded 64MB: ${bytes}`);
        }
    }
}

await run("close_document", { doc: d15k.id, force: true });
host.shell.activate(ed);
return { maxCanvasMB: +maxCanvasMB.toFixed(1) };
"""),

    ("case6_removing_layer_clears_maskview", """
const ed = ednow(window.__maskDoc);
const paintLayerId = window.__testLayerId;

// 1. Overlay on paint layer: removeLayer clears maskView
ed.maskView = { id: paintLayerId, mode: "overlay" };
if (!ed.maskView) throw new Error("maskView was not set");

await run("remove_layer", { doc: window.__maskDoc, layer: paintLayerId });
if (ed.maskView !== null) throw new Error("removing layer did not clear maskView");

// 2. Add layer with mask, alone mode: removeMask clears maskView
const l2 = ed.addPaintLayer();
const mc = document.createElement("canvas");
mc.width = 400; mc.height = 300;
l2.maskPx = ed.pixels.Mask.fromCanvas(mc);
ed.markLayerChanged(l2);
ed.markMaskChanged(l2);

ed.maskView = { id: l2.id, mode: "alone" };
if (!ed.maskView) throw new Error("maskView was not set for layer 2");

ed.removeMask(l2);
if (ed.maskView !== null) throw new Error("removeMask did not clear maskView");

// Cleanup
await run("close_document", { doc: window.__maskDoc, force: true });
return { ok: true };
"""),
]

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    %s
})()"""


async def run_all(c):
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    ok = True
    for name, body in STEPS:
        try:
            res = await c.eval(PRE % body, timeout=240)
            print("[ok] %s: %s" % (name, json.dumps(res)[:280]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            break
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        ok = asyncio.run(session(run_all))
        sys.exit(0 if ok else 1)
    except Exception as err:
        print("[FAIL] CDP error:", err)
        sys.exit(1)
