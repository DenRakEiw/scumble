"""Mask paste gate: set_mask from_layer, mask clipboard, 15k copy-on-write clone (PLAN_NIK9_BUILD.md R3-S8).

    python tools/masks_test.py

Tests:
  1. Equal geometry: filter layer A with a left-half mask, filter layer B without one;
     set_mask B from_layer source A; B's bytes equal A's, B.maskPx !== A.maskPx;
     undo returns B to no mask, redo restores; undo back.
  2. Offset: paint layer P at (100, 50), 300 x 200, circle mask; pasting onto a filter layer
     gives exactly P's mask inside (100, 50, 300, 200) and alpha sums to 0 outside.
  3. Scaled: P at (600, 400) (px 300 x 200, scale 2); pasting onto a filter layer
     matches an explicit transformed call; center is white, far corner is 0.
  4. Refusals: source without mask ("has no mask"); source equals target ("the source layer cannot be the target layer");
     from_layer without source ("from_layer needs source").
  5. 15k: new_canvas 15000x10000, two filter layers, paste under 0.5 s;
     memoryReport() shows no mirror over 64 MB. Also measure transformedAsync of a full 15k x 10k filter layer mask.
  6. Menu: Copy mask on A then Paste mask from A on B matches case 1.
  7. Locks: pending transform on target refuses ("Apply or cancel the transform first").
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
window.__masksDoc = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 800, height: 600, color: "#808080" });
return { doc: d.id, width: ed.width, height: ed.height, tiles: !!ed.tileMode };
"""),

    ("case1_equal_geometry", """
const ed = ednow(window.__masksDoc);
const lA = await run("add_filter", { doc: window.__masksDoc, type: "levels", name: "FilterA" });
const lB = await run("add_filter", { doc: window.__masksDoc, type: "grain", name: "FilterB" });
const rawA = ed.layers.find((l) => l.id === lA.id);
const rawB = ed.layers.find((l) => l.id === lB.id);

// Left-half mask on A: 800 x 600, x in 0..399 white, 400..799 transparent
const mc = document.createElement("canvas");
mc.width = 800; mc.height = 600;
const mctx = mc.getContext("2d");
mctx.fillStyle = "#ffffff";
mctx.fillRect(0, 0, 400, 600);
rawA.maskPx = ed.pixels.Mask.fromCanvas(mc);
ed.markMaskChanged(rawA);

if (rawB.maskPx) throw new Error("FilterB should have no mask initially");

// set_mask B from_layer source A
await run("set_mask", { doc: window.__masksDoc, layer: lB.id, op: "from_layer", source: lA.id });

if (!rawB.maskPx) throw new Error("FilterB should have a mask after set_mask");
if (rawB.maskPx === rawA.maskPx) throw new Error("rawB.maskPx should not be strictly equal to rawA.maskPx");

const bytesA = readData(rawA.maskPx, 800, 600);
const bytesB = readData(rawB.maskPx, 800, 600);
let diffCount = 0;
for (let i = 0; i < bytesA.length; i++) {
    if (bytesA[i] !== bytesB[i]) diffCount++;
}
if (diffCount !== 0) throw new Error(`mask bytes mismatch: ${diffCount} different bytes`);

// Undo returns B to no mask
await run("undo", { doc: window.__masksDoc });
if (rawB.maskPx !== null) throw new Error("undo should return FilterB to no mask");

// Redo restores mask
await run("redo", { doc: window.__masksDoc });
if (!rawB.maskPx) throw new Error("redo should restore FilterB mask");
const bytesB2 = readData(rawB.maskPx, 800, 600);
for (let i = 0; i < bytesA.length; i++) {
    if (bytesA[i] !== bytesB2[i]) throw new Error("restored mask bytes mismatch");
}

// Undo back
await run("undo", { doc: window.__masksDoc });
if (rawB.maskPx !== null) throw new Error("undo back should return FilterB to no mask");

// Cleanup
await run("remove_layer", { doc: window.__masksDoc, layer: lB.id });
await run("remove_layer", { doc: window.__masksDoc, layer: lA.id });

return { ok: true, matchedBytes: bytesA.length };
"""),

    ("case2_offset", """
const ed = ednow(window.__masksDoc);
// Paint layer P at (100, 50), 300 x 200
const P = ed.addLayer({
    name: "PaintP", kind: "paint", ref: null,
    px: ed.pixels.Layer.empty(300, 200),
    x: 100, y: 50, w: 300, h: 200, dirty: true,
});

// Circle mask on P (300 x 200): circle at (150, 100) radius 60
const mcP = document.createElement("canvas");
mcP.width = 300; mcP.height = 200;
const mctxP = mcP.getContext("2d");
mctxP.fillStyle = "#ffffff";
mctxP.beginPath();
mctxP.arc(150, 100, 60, 0, Math.PI * 2);
mctxP.fill();
P.maskPx = ed.pixels.Mask.fromCanvas(mcP);
ed.markMaskChanged(P);

// Target filter layer F on whole 800 x 600
const lF = await run("add_filter", { doc: window.__masksDoc, type: "levels", name: "FilterF" });
const rawF = ed.layers.find((l) => l.id === lF.id);

// Paste mask from P onto F
await run("set_mask", { doc: window.__masksDoc, layer: lF.id, op: "from_layer", source: P.id });

const dataF = readData(rawF.maskPx, 800, 600);
const dataP = readData(P.maskPx, 300, 200);
let insideDiff = 0;
let outsideAlphaSum = 0;
for (let y = 0; y < 600; y++) {
    for (let x = 0; x < 800; x++) {
        const idxF = (y * 800 + x) * 4;
        const inside = (x >= 100 && x < 400 && y >= 50 && y < 250);
        if (inside) {
            const px = x - 100;
            const py = y - 50;
            const idxP = (py * 300 + px) * 4;
            for (let c = 0; c < 4; c++) {
                if (dataF[idxF + c] !== dataP[idxP + c]) insideDiff++;
            }
        } else {
            outsideAlphaSum += dataF[idxF + 3];
        }
    }
}

if (insideDiff !== 0) throw new Error(`inside (100, 50, 300, 200) mismatch: ${insideDiff} channel differences`);
if (outsideAlphaSum !== 0) throw new Error(`outside alpha sum is ${outsideAlphaSum}, expected 0`);

// Cleanup
await run("remove_layer", { doc: window.__masksDoc, layer: lF.id });
await run("remove_layer", { doc: window.__masksDoc, layer: P.id });

return { ok: true, insideDiff, outsideAlphaSum };
"""),

    ("case3_scaled", """
const ed = ednow(window.__masksDoc);
// Paint layer P at (0, 0), w: 600, h: 400 (px 300 x 200, scale 2)
const P = ed.addLayer({
    name: "PaintP_Scaled", kind: "paint", ref: null,
    px: ed.pixels.Layer.empty(300, 200),
    x: 0, y: 0, w: 600, h: 400, dirty: true,
});

// Circle mask on P (300 x 200): circle at (150, 100) radius 50
const mcP = document.createElement("canvas");
mcP.width = 300; mcP.height = 200;
const mctxP = mcP.getContext("2d");
mctxP.fillStyle = "#ffffff";
mctxP.beginPath();
mctxP.arc(150, 100, 50, 0, Math.PI * 2);
mctxP.fill();
P.maskPx = ed.pixels.Mask.fromCanvas(mcP);
ed.markMaskChanged(P);

// Filter layer F on 800 x 600
const lF = await run("add_filter", { doc: window.__masksDoc, type: "levels", name: "FilterF_Scaled" });
const rawF = ed.layers.find((l) => l.id === lF.id);

// Explicit transformedAsync call reference
const sm = P.maskPx;
const srcToImg = [P.w / sm.width, 0, 0, P.h / sm.height, P.x, P.y];
const dstToImg = [rawF.w / rawF.px.width, 0, 0, rawF.h / rawF.px.height, rawF.x, rawF.y];
const { xfMul, xfInv, pixelMap } = await import("./editor/inpaint_resample.js");
const inv = xfMul(xfInv(srcToImg), dstToImg);
const map = pixelMap(inv);
const refM = await sm.transformedAsync(map, rawF.px.width, rawF.px.height, { color: [255, 255, 255], edge: "transparent" });

// Paste mask from P onto F
await run("set_mask", { doc: window.__masksDoc, layer: lF.id, op: "from_layer", source: P.id });

const dataF = readData(rawF.maskPx, 800, 600);
const dataRef = readData(refM, 800, 600);
let maxDiff = 0;
for (let i = 0; i < dataF.length; i++) {
    const d = Math.abs(dataF[i] - dataRef[i]);
    if (d > maxDiff) maxDiff = d;
}
if (refM.release) refM.release();
if (maxDiff > 1) throw new Error(`scaled mask mismatch: max diff ${maxDiff}`);

// Center is white (P center is x: 300, y: 200 on canvas)
const idxCenter = (200 * 800 + 300) * 4;
if (dataF[idxCenter + 3] !== 255 || dataF[idxCenter] !== 255) {
    throw new Error(`center should be white: alpha=${dataF[idxCenter + 3]}, r=${dataF[idxCenter]}`);
}

// Far corner is 0 (x: 750, y: 550 outside P)
const idxFar = (550 * 800 + 750) * 4;
if (dataF[idxFar + 3] !== 0) {
    throw new Error(`far corner should be 0: alpha=${dataF[idxFar + 3]}`);
}

// Cleanup
await run("remove_layer", { doc: window.__masksDoc, layer: lF.id });
await run("remove_layer", { doc: window.__masksDoc, layer: P.id });

return { ok: true, maxDiff, centerAlpha: dataF[idxCenter + 3], farAlpha: dataF[idxFar + 3] };
"""),

    ("case4_refusals", """
const ed = ednow(window.__masksDoc);
const lA = await run("add_filter", { doc: window.__masksDoc, type: "levels", name: "RefuseA" });
const lB = await run("add_filter", { doc: window.__masksDoc, type: "grain", name: "RefuseB" });

// 1. source without mask ("has no mask")
let threw1 = false, msg1 = "";
try {
    await run("set_mask", { doc: window.__masksDoc, layer: lB.id, op: "from_layer", source: lA.id });
} catch (err) {
    msg1 = String(err.message || err);
    threw1 = msg1.includes("has no mask");
}
if (!threw1) throw new Error("source without mask should refuse with 'has no mask', got: " + msg1);

// 2. source equals target ("the source layer cannot be the target layer")
let threw2 = false, msg2 = "";
try {
    await run("set_mask", { doc: window.__masksDoc, layer: lB.id, op: "from_layer", source: lB.id });
} catch (err) {
    msg2 = String(err.message || err);
    threw2 = msg2.includes("the source layer cannot be the target layer");
}
if (!threw2) throw new Error("source equals target should refuse with 'the source layer cannot be the target layer', got: " + msg2);

// 3. from_layer without source ("from_layer needs source")
let threw3 = false, msg3 = "";
try {
    await run("set_mask", { doc: window.__masksDoc, layer: lB.id, op: "from_layer" });
} catch (err) {
    msg3 = String(err.message || err);
    threw3 = msg3.includes("from_layer needs source");
}
if (!threw3) throw new Error("from_layer without source should refuse with 'from_layer needs source', got: " + msg3);

// Cleanup
await run("remove_layer", { doc: window.__masksDoc, layer: lB.id });
await run("remove_layer", { doc: window.__masksDoc, layer: lA.id });

return { ok: true, msg1, msg2, msg3 };
"""),

    ("case5_15k", """
const ed = ednow(window.__masksDoc);
if (!ed.tileMode) return { skipped: "canvas backend" };

const d15 = await run("new_document");
const ed15 = ednow(d15.id);
host.shell.activate(ed15);
await run("new_canvas", { doc: d15.id, width: 15000, height: 10000, color: "#808080" });

const f1 = await run("add_filter", { doc: d15.id, type: "grain", name: "Filter15_1" });
const f2 = await run("add_filter", { doc: d15.id, type: "levels", name: "Filter15_2" });
await run("set_mask", { doc: d15.id, layer: f1.id, op: "reveal" });

// Equal-geometry paste under 0.5s
const t0 = performance.now();
await run("set_mask", { doc: d15.id, layer: f2.id, op: "from_layer", source: f1.id });
const pasteMs = performance.now() - t0;
if (pasteMs > 500) throw new Error(`paste took ${pasteMs.toFixed(1)} ms, expected under 500 ms`);

// memoryReport() shows no mirror over 64 MB
const rep = ed15.memoryReport();
if (rep && rep.layers && rep.layers.list) {
    for (const lyr of rep.layers.list) {
        for (const slot of lyr.slots || []) {
            if (slot.name && slot.name.includes("irror") && slot.bytes > 64 * 1024 * 1024) {
                throw new Error(`layer ${lyr.name} slot ${slot.name} mirror over 64 MB: ${(slot.bytes / 1048576).toFixed(1)} MB`);
            }
        }
    }
}
if (rep && rep.tiles && rep.tiles.mirrorBytes > 64 * 1024 * 1024) {
    throw new Error(`total tile mirrorBytes over 64 MB: ${(rep.tiles.mirrorBytes / 1048576).toFixed(1)} MB`);
}

// Measure transformedAsync of a full 15k x 10k filter layer mask
const smSmall = ed.pixels.Mask.empty(400, 300);
await smSmall.transformedAsync([1, 0, 0, 1, 0, 0], 400, 300, { color: [255, 255, 255], edge: "transparent" });
if (smSmall.release) smSmall.release();

const rawF1 = ed15.layers.find((l) => l.id === f1.id);
const t0Trans = performance.now();
const mTrans = await rawF1.maskPx.transformedAsync([1, 0, 0, 1, 0, 0], 15000, 10000, { color: [255, 255, 255], edge: "transparent" });
const transMs = performance.now() - t0Trans;
if (mTrans && mTrans.release) mTrans.release();

await run("close_document", { doc: d15.id, force: true });
host.shell.activate(ed);

return { pasteMs: +pasteMs.toFixed(1), transMs: +transMs.toFixed(1) };
"""),

    ("case6_menu", """
const ed = ednow(window.__masksDoc);
const lA = await run("add_filter", { doc: window.__masksDoc, type: "levels", name: "MenuA" });
const lB = await run("add_filter", { doc: window.__masksDoc, type: "grain", name: "MenuB" });
const rawA = ed.layers.find((l) => l.id === lA.id);
const rawB = ed.layers.find((l) => l.id === lB.id);

// Left-half mask on A
const mc = document.createElement("canvas");
mc.width = 800; mc.height = 600;
const mctx = mc.getContext("2d");
mctx.fillStyle = "#ffffff";
mctx.fillRect(0, 0, 400, 600);
rawA.maskPx = ed.pixels.Mask.fromCanvas(mc);
ed.markMaskChanged(rawA);

const anchor = document.createElement("button");
ed.root.appendChild(anchor);

// Copy mask on A via menu
let copyAction = null;
let pasteAction = null;
const origFlyout = ed.openFlyout.bind(ed);
ed.openFlyout = function(opts) {
    if (opts.actions) {
        copyAction = opts.actions.find((a) => a.label === "Copy mask");
    }
    return origFlyout(opts);
};
try {
    ed.openMaskMenu(rawA, anchor);
    if (!copyAction || copyAction.disabled) throw new Error("Copy mask action missing or disabled on layer A");
    copyAction.onClick();
    ed.closeFlyout();

    if (!ed.maskClip || ed.maskClip.id !== rawA.id) throw new Error("ed.maskClip not set to layer A");

    // Paste mask on B via menu
    ed.openFlyout = function(opts) {
        if (opts.actions) {
            pasteAction = opts.actions.find((a) => a.label && a.label.startsWith("Paste mask from"));
        }
        return origFlyout(opts);
    };
    ed.openMaskMenu(rawB, anchor);
    ed.openFlyout = origFlyout;
    if (!pasteAction || pasteAction.disabled) throw new Error("Paste mask action missing or disabled on layer B");
    pasteAction.onClick();
    ed.closeFlyout();
} finally {
    ed.openFlyout = origFlyout;
    anchor.remove();
}

// Verify rawB has mask matching rawA (matching case 1)
if (!rawB.maskPx) throw new Error("MenuB should have a mask after menu paste");
const bytesA = readData(rawA.maskPx, 800, 600);
const bytesB = readData(rawB.maskPx, 800, 600);
for (let i = 0; i < bytesA.length; i++) {
    if (bytesA[i] !== bytesB[i]) throw new Error("Menu pasted mask bytes mismatch");
}

// Cleanup
await run("remove_layer", { doc: window.__masksDoc, layer: lB.id });
await run("remove_layer", { doc: window.__masksDoc, layer: lA.id });

return { ok: true, pasteLabel: pasteAction.label };
"""),

    ("case7_locks", """
const ed = ednow(window.__masksDoc);
const lA = await run("add_filter", { doc: window.__masksDoc, type: "levels", name: "LockA" });
const lB = await run("add_filter", { doc: window.__masksDoc, type: "grain", name: "LockB" });
const rawA = ed.layers.find((l) => l.id === lA.id);
const rawB = ed.layers.find((l) => l.id === lB.id);

// Give A a mask
await run("set_mask", { doc: window.__masksDoc, layer: lA.id, op: "reveal" });

// Place B under a pending transform
ed.pending = { layer: rawB };

let threw = false, msg = "";
try {
    await run("set_mask", { doc: window.__masksDoc, layer: lB.id, op: "from_layer", source: lA.id });
} catch (err) {
    msg = String(err.message || err);
    threw = msg.includes("Apply or cancel the transform first");
} finally {
    ed.pending = null;
}

if (!threw) throw new Error("pending transform on target should refuse with 'Apply or cancel the transform first', got: " + msg);

// Cleanup
await run("remove_layer", { doc: window.__masksDoc, layer: lB.id });
await run("remove_layer", { doc: window.__masksDoc, layer: lA.id });
await run("close_document", { doc: window.__masksDoc, force: true });

return { ok: true, msg };
"""),
]

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const readData = (m, w, h) => {
        if (!m) return null;
        if (m.readRect) return m.readRect(0, 0, w, h).data;
        return m.getContext("2d").getImageData(0, 0, w, h).data;
    };
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
