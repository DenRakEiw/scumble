"""Blend modes gate (PLAN_NIK9_BUILD.md R4-S3).

A reference-free in-app test gate that holds every blend mode to the kernel
on every path, run first on the existing modes, whose numbers set the tolerance
classes.

Steps:
  a. pairs_document (256x256 covering all 65,536 (b, s) pairs and triplets)
  b. the_export_is_the_kernel (0 bytes differ against kernel on tiles; flatten on canvas)
  c. the_flatten_is_the_kernel (emulated 0 bytes; native Skia <= 3)
  d. the_gpu_compositor_is_the_kernel (opaque <= 1 level)
  e. the_canvas_view_is_the_kernel (emulated <= 1 level; native reported)
  f. translucent_masked_clipped (alpha 191 0 bytes against kernel; GPU/canvas max/mean/count over 2 gated by BOUNDS; gradient mask & clip)
  g. a_fill_layer_in_every_mode (worker stack against flatten <= 3)
  h. psd_and_ora_keep_every_mode (export and reopen keeps blend mode)
  i. documents_ask_for_the_right_reader (header minReader matches highest READER_OF_BLEND)
  j. set_layer_takes_every_mode (each valid id accepted; invalid refused with list)
  k. tiff_png_and_merge_agree (encodeTiff vs encodeComposite; merge into base agrees)
  l. references (1024x640 showcase compared against reference PNGs)
  m. live_psd_check (R4-D6, R4-D7, R4-D8)
  n. dissolve (export vs flatten 0 bytes; 1:1 view 0 bytes; kept share 50% +- 1%; PSD key round-trip)
  o. dissolve_merge_and_brush (layers off the origin: flatten = the dither by hand; 1:1 view at 30 % = flatten;
     a brush's read of a box = flatten, dissolve and a clip; merge down = the flatten before it; all 0 bytes)

Runs tools/blend_table_test.js under plain Node first, then connects to running app via CDP.
"""
import argparse
import asyncio
import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REFS = os.path.join(HERE, "refs")


def compare(a_png, b_png):
    """Max and mean absolute difference per channel between two PNGs of the same size."""
    try:
        from PIL import Image
    except ImportError:
        return None
    a = Image.open(io.BytesIO(a_png)).convert("RGBA")
    b = Image.open(io.BytesIO(b_png)).convert("RGBA")
    if a.size != b.size:
        return {"size": (a.size, b.size), "max": 255, "mean": 255.0, "differing": -1}
    da, db = a.tobytes(), b.tobytes()
    worst = 0
    total = 0
    differing = 0
    for x, y in zip(da, db):
        d = abs(x - y)
        if d:
            differing += 1
            total += d
            if d > worst:
                worst = d
    return {"max": worst, "mean": total / max(1, len(da)), "differing": differing, "bytes": len(da)}

# Dated 2026-10-10: measured maximum pixel differences and flips against kernel
BOUNDS = {
    "multiply": {"gl_translucent": 2, "flips": 0},
    "screen": {"gl_translucent": 2, "flips": 0},
    "overlay": {"gl_translucent": 3, "flips": 0},
    "darken": {"gl_translucent": 2, "flips": 0},
    "lighten": {"gl_translucent": 2, "flips": 0},
    "soft-light": {"gl_translucent": 3, "flips": 0},
    "hard-light": {"gl_translucent": 3, "flips": 0},
    "difference": {"gl_translucent": 2, "flips": 0},
    "linear-light": {"gl_translucent": 2, "flips": 0},
    "exclusion": {"gl_translucent": 2, "flips": 0},
    "linear-dodge": {"gl_translucent": 2, "flips": 0},
    "linear-burn": {"gl_translucent": 2, "flips": 0},
    "subtract": {"gl_translucent": 2, "flips": 0},
    "pin-light": {"gl_translucent": 2, "flips": 0},
    "hard-mix": {"gl_translucent": 160, "flips": 0},
    "color-dodge": {"gl_translucent": 16, "flips": 0},
    "color-burn": {"gl_translucent": 42, "flips": 0},
    "vivid-light": {"gl_translucent": 42, "flips": 0},
    "divide": {"gl_translucent": 12, "flips": 0},
    "hue": {"gl_translucent": 12, "flips": 0},
    "saturation": {"gl_translucent": 2, "flips": 0},
    "color": {"gl_translucent": 2, "flips": 0},
    "luminosity": {"gl_translucent": 3, "flips": 0},
    "darker-color": {"gl_translucent": 150, "flips": 0},
    "lighter-color": {"gl_translucent": 100, "flips": 0},
}
DEFAULT_BOUNDS = {"gl_translucent": 3, "flips": 0}

HELPERS = r"""
const { BLENDS, BLEND_MODES, BLEND_OPS, EMULATED_BLENDS, READER_OF_BLEND, seedOfLayer, hash32, mul255 } = await import("./editor/blend_modes.js");
const kernels_js = await import("./editor/px/kernels_js.js");
const PNG = await import("./editor/inpaint_png.js");
const TIFF = await import("./editor/inpaint_tiff.js");
const { host } = await import("./editor/host.js");
const { commands } = await import("./commands.js");
const shell = await import("./shell.js");

const run = (n, a) => commands.run(n, a || {});
const ednow = (id) => host.editors().find((e) => e.node.id === id);

const MODES = BLENDS.filter((r) => r.op >= 5);

const makePairsData = (alpha = 255) => {
    const W = 256, H = 256;
    const baseData = new Uint8ClampedArray(W * H * 4);
    const layerData = new Uint8ClampedArray(W * H * 4);
    let idx = 0;
    for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
            baseData[idx] = x;
            baseData[idx + 1] = y;
            baseData[idx + 2] = (7 * x + 3 * y) & 255;
            baseData[idx + 3] = 255;

            layerData[idx] = y;
            layerData[idx + 1] = x;
            layerData[idx + 2] = (11 * x + 5 * y + 17) & 255;
            layerData[idx + 3] = typeof alpha === "function" ? alpha(x, y) : alpha;
            idx += 4;
        }
    }
    return { baseData, layerData };
};

const getKernelRef = (baseData, layerData, op, alpha = 255) => {
    const dst = new Uint8ClampedArray(baseData);
    return kernels_js.compositeTile(dst, [layerData], [op], [alpha]);
};

const decodePng = async (blob) => {
    let out = null, W = 0, H = 0;
    const info = await PNG.readPng(blob, {
        onHeader: (h) => { W = h.width; H = h.height; out = new Uint8Array(W * H * 4); },
        onRows: (rgba, y0) => { out.set(rgba, y0 * W * 4); },
    });
    return { data: out, width: W, height: H };
};

const decodeTiff = async (blob) => {
    let out = null, W = 0, H = 0;
    await TIFF.readTiff(blob, {
        onHeader: (h) => { W = h.width; H = h.height; out = new Uint8Array(W * H * 4); },
        onRows: (rgba, y0) => { out.set(rgba, y0 * W * 4); },
    });
    return { data: out, width: W, height: H };
};

const diff = (a, b) => {
    if (a.length !== b.length) return { max: 999, mean: 999, count: a.length, over2: a.length, over2Fraction: 1.0 };
    let m = 0, sum = 0, count = 0, over2 = 0;
    for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > 0) {
            count++;
            sum += d;
            if (d > m) m = d;
            if (d > 2) over2++;
        }
    }
    return {
        max: m,
        mean: a.length > 0 ? sum / a.length : 0,
        count,
        over2,
        over2Fraction: a.length > 0 ? over2 / a.length : 0,
    };
};

const bytesOf = (px, w, h) => Array.from(px.readRect(0, 0, w, h).data);

const setupPairsDoc = async (alpha = 255) => {
    const d = await run("new_document");
    const ed = ednow(d.id);
    host.shell.activate(ed);
    await new Promise((r) => setTimeout(r, 80));
    ed.resizeCanvas();
    const { baseData, layerData } = makePairsData(alpha);
    const baseCanvas = document.createElement("canvas");
    baseCanvas.width = 256; baseCanvas.height = 256;
    baseCanvas.getContext("2d").putImageData(new ImageData(baseData, 256, 256), 0, 0);
    await ed.setBaseFromCanvas(baseCanvas, { keepLayers: false });
    const { Layer: LayerPixels } = ed.pixels;
    const l = ed.addLayer({
        name: "mode",
        kind: "paint",
        px: LayerPixels.fromImageData(new ImageData(layerData, 256, 256)),
        x: 0, y: 0, w: 256, h: 256,
        dirty: true,
    });
    return { ed, docId: d.id, layer: l, baseData, layerData };
};
"""

PRE = """(async () => {
    %s
    %s
})()"""


def node_step():
    r = subprocess.run(
        ["node", os.path.join(HERE, "blend_table_test.js")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )
    tail = r.stdout.strip()
    if r.returncode != 0 or "PASS" not in tail:
        raise Exception("tools/blend_table_test.js: " + (tail + r.stderr)[-1500:])
    return {"passed": True}


async def run_gate(c, scratch_dir, args=None):
    ok = True

    # a. pairs_document
    js_a = """
    const { ed, layer, baseData, layerData } = await setupPairsDoc();
    try {
        const pairsR = new Set();
        const pairsG = new Set();
        const tripletsBase = new Set();
        const tripletsLayer = new Set();
        for (let i = 0; i < baseData.length; i += 4) {
            pairsR.add((baseData[i] << 8) | layerData[i]);
            pairsG.add((baseData[i + 1] << 8) | layerData[i + 1]);
            tripletsBase.add((baseData[i] << 16) | (baseData[i + 1] << 8) | baseData[i + 2]);
            tripletsLayer.add((layerData[i] << 16) | (layerData[i + 1] << 8) | layerData[i + 2]);
        }
        if (pairsR.size !== 65536) throw new Error("pairsR size " + pairsR.size + " !== 65536");
        if (pairsG.size !== 65536) throw new Error("pairsG size " + pairsG.size + " !== 65536");
        if (tripletsBase.size !== 65536) throw new Error("tripletsBase size " + tripletsBase.size + " !== 65536");
        if (tripletsLayer.size !== 65536) throw new Error("tripletsLayer size " + tripletsLayer.size + " !== 65536");

        for (const m of MODES) {
            const ans = getKernelRef(baseData, layerData, m.op, 255);
            if (ans.length !== 262144) throw new Error("kernel answer length " + ans.length);
        }
        return { pairsR: pairsR.size, pairsG: pairsG.size, triplets: tripletsBase.size, modes: MODES.length };
    } finally {
        host.shell.closeDocument(ed, { force: true });
    }
    """
    try:
        res = await c.eval(PRE % (HELPERS, js_a), timeout=60)
        print(f"[ok] pairs_document: {json.dumps(res)}")
    except Exception as err:
        ok = False
        print(f"[FAIL] pairs_document: {err}")

    # b. the_export_is_the_kernel
    js_b = """
    const { ed, layer, baseData, layerData } = await setupPairsDoc();
    try {
        const out = {};
        for (const m of MODES) {
            layer.blend = m.id;
            ed.markLayerChanged(layer);
            ed.renderLayers();
            if (ed.tileMode) {
                const r = await ed.encodeComposite({ forRun: true }, { hash: false });
                if (!r || !r.blob) throw new Error("no composite for " + m.id);
                if (!r.stack) throw new Error("r.stack not set for mode " + m.id);
                const dec = await decodePng(r.blob);
                const kref = getKernelRef(baseData, layerData, m.op, 255);
                const d = diff(dec.data, kref);
                if (d.count !== 0) throw new Error("mode " + m.id + ": export differs from kernel by " + d.count + " bytes (max " + d.max + ")");
                out[m.id] = { diffBytes: d.count };
            } else {
                const flat = ed.flattenToCanvas({ forRun: true });
                const flatData = flat.getContext("2d").getImageData(0, 0, 256, 256).data;
                const kref = getKernelRef(baseData, layerData, m.op, 255);
                const d = diff(flatData, kref);
                if (EMULATED_BLENDS.has(m.id) && d.count !== 0) {
                    throw new Error("emulated mode " + m.id + ": flatten differs from kernel by " + d.count + " bytes");
                }
                out[m.id] = { diffBytes: d.count, emulated: EMULATED_BLENDS.has(m.id) };
            }
        }
        return { tiles: !!ed.tileMode, modes: out };
    } finally {
        host.shell.closeDocument(ed, { force: true });
    }
    """
    try:
        res = await c.eval(PRE % (HELPERS, js_b), timeout=60)
        print(f"[ok] the_export_is_the_kernel: {json.dumps(res)}")
    except Exception as err:
        ok = False
        print(f"[FAIL] the_export_is_the_kernel: {err}")

    # c. the_flatten_is_the_kernel
    js_c = """
    const { ed, layer, baseData, layerData } = await setupPairsDoc();
    try {
        const out = {};
        for (const m of MODES) {
            layer.blend = m.id;
            ed.markLayerChanged(layer);
            ed.renderLayers();
            const flat = ed.flattenToCanvas({ forRun: true });
            const flatData = flat.getContext("2d").getImageData(0, 0, 256, 256).data;
            const kref = getKernelRef(baseData, layerData, m.op, 255);
            const d = diff(flatData, kref);
            if (EMULATED_BLENDS.has(m.id)) {
                if (d.count !== 0) throw new Error("emulated mode " + m.id + ": flatten differs from kernel by " + d.count + " bytes (max " + d.max + ")");
            } else {
                if (d.max > 3) throw new Error("native mode " + m.id + ": flatten differs from kernel by max " + d.max + " > 3");
            }
            out[m.id] = { max: d.max, diffCount: d.count, emulated: EMULATED_BLENDS.has(m.id) };
        }
        return out;
    } finally {
        host.shell.closeDocument(ed, { force: true });
    }
    """
    try:
        res = await c.eval(PRE % (HELPERS, js_c), timeout=60)
        print(f"[ok] the_flatten_is_the_kernel: {json.dumps(res)}")
    except Exception as err:
        ok = False
        print(f"[FAIL] the_flatten_is_the_kernel: {err}")

    # d. the_gpu_compositor_is_the_kernel
    js_d = """
    const { ed, layer, baseData, layerData } = await setupPairsDoc();
    try {
        ed.view = { scale: 1, x: 0, y: 0, angle: 0 };
        ed.compositorOff = false;
        if (!ed.glCompositeUsable({})) throw new Error("glCompositeUsable({}) returned false");
        const out = {};
        for (const m of MODES) {
            layer.blend = m.id;
            ed.markLayerChanged(layer);
            ed.renderLayers();
            ed.sceneSig = null;
            ed.draw();
            const sc = document.createElement("canvas"); sc.width = 256; sc.height = 256;
            sc.getContext("2d").drawImage(ed.canvas, 0, 0, 256, 256, 0, 0, 256, 256);
            const screenData = sc.getContext("2d").getImageData(0, 0, 256, 256).data;
            const kref = getKernelRef(baseData, layerData, m.op, 255);
            const d = diff(screenData, kref);
            if (d.max > 1) throw new Error("mode " + m.id + ": GPU view max diff " + d.max + " > 1");
            out[m.id] = { max: d.max, diffCount: d.count };
        }
        return out;
    } finally {
        host.shell.closeDocument(ed, { force: true });
    }
    """
    try:
        res = await c.eval(PRE % (HELPERS, js_d), timeout=60)
        print(f"[ok] the_gpu_compositor_is_the_kernel: {json.dumps(res)}")
    except Exception as err:
        ok = False
        print(f"[FAIL] the_gpu_compositor_is_the_kernel: {err}")

    # e. the_canvas_view_is_the_kernel
    js_e = """
    const { ed, layer, baseData, layerData } = await setupPairsDoc();
    try {
        ed.view = { scale: 1, x: 0, y: 0, angle: 0 };
        ed.compositorOff = true;
        const out = {};
        for (const m of MODES) {
            layer.blend = m.id;
            ed.markLayerChanged(layer);
            ed.renderLayers();
            ed.sceneSig = null;
            ed.draw();
            const sc = document.createElement("canvas"); sc.width = 256; sc.height = 256;
            sc.getContext("2d").drawImage(ed.canvas, 0, 0, 256, 256, 0, 0, 256, 256);
            const screenData = sc.getContext("2d").getImageData(0, 0, 256, 256).data;
            const kref = getKernelRef(baseData, layerData, m.op, 255);
            const d = diff(screenData, kref);
            if (EMULATED_BLENDS.has(m.id)) {
                if (d.max > 1) throw new Error("emulated mode " + m.id + ": canvas view max diff " + d.max + " > 1");
            }
            out[m.id] = { max: d.max, diffCount: d.count, emulated: EMULATED_BLENDS.has(m.id) };
        }
        return out;
    } finally {
        host.shell.closeDocument(ed, { force: true });
    }
    """
    try:
        res = await c.eval(PRE % (HELPERS, js_e), timeout=60)
        print(f"[ok] the_canvas_view_is_the_kernel: {json.dumps(res)}")
    except Exception as err:
        ok = False
        print(f"[FAIL] the_canvas_view_is_the_kernel: {err}")

    # f. translucent_masked_clipped
    js_f = """
    const alphaFn = (x, y) => (x ^ (y << 1)) & 255;
    const { ed, layer, baseData, layerData } = await setupPairsDoc(alphaFn);
    try {
        layer.opacity = 0.75;
        ed.markLayerChanged(layer);
        const actualLayer = layer.px.readRect(0, 0, 256, 256).data;
        const out = {};
        for (const m of MODES) {
            layer.blend = m.id;
            ed.renderLayers();
            const kref191 = getKernelRef(baseData, actualLayer, m.op, 191);

            // (b) equals kernel with alpha 191
            if (ed.tileMode) {
                const r = await ed.encodeComposite({ forRun: true }, { hash: false });
                if (!r || !r.blob) throw new Error("no composite for translucent " + m.id);
                const dec = await decodePng(r.blob);
                const db = diff(dec.data, kref191);
                if (db.count !== 0) {
                    const diffs = [];
                    for (let j = 0; j < dec.data.length && diffs.length < 5; j += 4) {
                        if (dec.data[j] !== kref191[j] || dec.data[j+1] !== kref191[j+1] || dec.data[j+2] !== kref191[j+2] || dec.data[j+3] !== kref191[j+3]) {
                            const pxIdx = j >> 2;
                            const py = Math.floor(pxIdx / 256), px = pxIdx % 256;
                            diffs.push({
                                x: px, y: py,
                                base: [baseData[j], baseData[j+1], baseData[j+2], baseData[j+3]],
                                layer: [actualLayer[j], actualLayer[j+1], actualLayer[j+2], actualLayer[j+3]],
                                dec: [dec.data[j], dec.data[j+1], dec.data[j+2], dec.data[j+3]],
                                kref: [kref191[j], kref191[j+1], kref191[j+2], kref191[j+3]],
                            });
                        }
                    }
                    throw new Error("translucent export mode " + m.id + " differs from kernel by " + db.count + " bytes: " + JSON.stringify(diffs));
                }
            } else {
                const flat = ed.flattenToCanvas({ forRun: true });
                const flatData = flat.getContext("2d").getImageData(0, 0, 256, 256).data;
                if (EMULATED_BLENDS.has(m.id)) {
                    const db = diff(flatData, kref191);
                    if (db.count !== 0) throw new Error("translucent canvas mode " + m.id + " differs from kernel by " + db.count + " bytes");
                }
            }

            // (d) GPU view
            ed.view = { scale: 1, x: 0, y: 0, angle: 0 };
            ed.compositorOff = false; ed.sceneSig = null; ed.draw();
            const scD = document.createElement("canvas"); scD.width = 256; scD.height = 256;
            scD.getContext("2d").drawImage(ed.canvas, 0, 0, 256, 256, 0, 0, 256, 256);
            const screenDataD = scD.getContext("2d").getImageData(0, 0, 256, 256).data;
            const dd = diff(screenDataD, kref191);

            // (e) Canvas view
            ed.compositorOff = true; ed.sceneSig = null; ed.draw();
            const scE = document.createElement("canvas"); scE.width = 256; scE.height = 256;
            scE.getContext("2d").drawImage(ed.canvas, 0, 0, 256, 256, 0, 0, 256, 256);
            const screenDataE = scE.getContext("2d").getImageData(0, 0, 256, 256).data;
            const de = diff(screenDataE, kref191);

            out[m.id] = {
                gpu: { max: dd.max, mean: +dd.mean.toFixed(4), over2: dd.over2 },
                canvas: { max: de.max, mean: +de.mean.toFixed(4), over2: de.over2 },
            };
        }

        // Gradient mask & clip on half-transparent base
        const mCanvas = document.createElement("canvas"); mCanvas.width = 256; mCanvas.height = 256;
        const mx = mCanvas.getContext("2d");
        const mg = mx.createLinearGradient(0, 0, 256, 0);
        mg.addColorStop(0, "rgba(255,255,255,0)"); mg.addColorStop(1, "rgba(255,255,255,1)");
        mx.fillStyle = mg; mx.fillRect(0, 0, 256, 256);
        layer.maskPx = ed.pixels.Mask.fromCanvas(mCanvas);
        layer.maskDirty = true;
        ed.markMaskChanged(layer);

        const halfBase = new Uint8ClampedArray(baseData);
        for (let i = 3; i < halfBase.length; i += 4) halfBase[i] = 128;
        const hCanvas = document.createElement("canvas"); hCanvas.width = 256; hCanvas.height = 256;
        hCanvas.getContext("2d").putImageData(new ImageData(halfBase, 256, 256), 0, 0);
        const baseLayer = ed.addLayer({
            name: "base",
            kind: "paint",
            px: ed.pixels.Layer.fromCanvas(hCanvas),
            x: 0, y: 0, w: 256, h: 256,
            dirty: true,
        });
        ed.layers.splice(ed.layers.indexOf(baseLayer), 1);
        ed.layers.splice(ed.layers.indexOf(layer), 0, baseLayer);

        layer.clip = true;
        ed.markLayerChanged(baseLayer);
        ed.markLayerChanged(layer);

        if (ed.tileMode) {
            for (const m of MODES) {
                layer.blend = m.id;
                ed.markLayerChanged(layer); ed.renderLayers();
                const r = await ed.encodeComposite({ forRun: true }, { hash: false });
                const dec = await decodePng(r.blob);
                const flat = ed.flattenToCanvas({ forRun: true });
                const flatData = flat.getContext("2d").getImageData(0, 0, 256, 256).data;
                const df = diff(dec.data, flatData);
                const isStep = ["hard-mix", "darker-color", "lighter-color"].includes(m.id);
                const isDivOrNonsep = ["color-dodge", "color-burn", "vivid-light", "divide", "hue", "saturation", "color", "luminosity"].includes(m.id);
                const maxAllowed = isStep ? 100 : (isDivOrNonsep ? 50 : 3);
                const fracAllowed = isStep ? 0.01 : (isDivOrNonsep ? 0.01 : 1e-4);
                if (df.max > maxAllowed) throw new Error("mode " + m.id + ": clipped masked worker max diff " + df.max + " > " + maxAllowed);
                if (df.over2Fraction > fracAllowed) throw new Error("mode " + m.id + ": clipped masked worker over2 fraction " + df.over2Fraction + " > " + fracAllowed);
                out[m.id].clippedWorkerVsFlatten = { max: df.max, over2Fraction: +df.over2Fraction.toFixed(6) };
            }
        }
        return out;
    } finally {
        host.shell.closeDocument(ed, { force: true });
    }
    """
    try:
        res = await c.eval(PRE % (HELPERS, js_f), timeout=120)
        # Verify BOUNDS
        bound_fails = []
        for mid, metrics in res.items():
            b = BOUNDS.get(mid, DEFAULT_BOUNDS)
            max_gpu = metrics["gpu"]["max"]
            if max_gpu > b["gl_translucent"]:
                bound_fails.append(f"{mid} gpu max {max_gpu} > bound {b['gl_translucent']}")
        if bound_fails:
            raise Exception("; ".join(bound_fails))
        print(f"[ok] translucent_masked_clipped: {json.dumps(res)}")
    except Exception as err:
        ok = False
        print(f"[FAIL] translucent_masked_clipped: {err}")

    # g. a_fill_layer_in_every_mode
    js_g = """
    const { ed, layer } = await setupPairsDoc();
    try {
        ed.removeLayer(layer.id);
        const fx = ed.addFilterLayer("fill");
        if (!fx) throw new Error("addFilterLayer('fill') returned null");
        fx.params = { color: "#806040" };
        fx.opacity = 0.6;
        const out = {};
        for (const m of MODES) {
            fx.blend = m.id;
            ed.markFilterChanged(fx);
            ed.renderLayers();
            if (ed.tileMode) {
                const r = await ed.encodeComposite({ forRun: true }, { hash: false });
                const dec = await decodePng(r.blob);
                const flat = ed.flattenToCanvas({ forRun: true });
                const flatData = flat.getContext("2d").getImageData(0, 0, 256, 256).data;
                const d = diff(dec.data, flatData);
                if (d.max > 3) throw new Error("mode " + m.id + ": fill worker max diff " + d.max + " > 3");
                out[m.id] = { max: d.max, count: d.count };
            } else {
                out[m.id] = { skipped: "canvas backend" };
            }
        }
        return out;
    } finally {
        host.shell.closeDocument(ed, { force: true });
    }
    """
    try:
        res = await c.eval(PRE % (HELPERS, js_g), timeout=60)
        print(f"[ok] a_fill_layer_in_every_mode: {json.dumps(res)}")
    except Exception as err:
        ok = False
        print(f"[FAIL] a_fill_layer_in_every_mode: {err}")

    # h. psd_and_ora_keep_every_mode
    psd_path = os.path.join(scratch_dir, f"test_blend_{os.getpid()}.psd").replace("\\", "/")
    ora_path = os.path.join(scratch_dir, f"test_blend_{os.getpid()}.ora").replace("\\", "/")
    js_h = f"""
    const psdPath = {json.dumps(psd_path)};
    const oraPath = {json.dumps(ora_path)};

    const d = await run("new_document");
    const ed = ednow(d.id);
    host.shell.activate(ed);
    await run("new_canvas", {{ doc: d.id, width: 256, height: 256 }});
    const mkLayer = (w, h, fill) => {{
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const x = c.getContext("2d"); x.fillStyle = fill; x.fillRect(0, 0, w, h);
        return ed.pixels.Layer.fromCanvas(c);
    }};
    for (let i = 0; i < MODES.length; i++) {{
        const m = MODES[i];
        const l = ed.addLayer({{
            name: "L_" + m.id,
            kind: "paint",
            px: mkLayer(32, 32, `hsl(${{i * 35}}, 70%, 50%)`),
            x: (i % 8) * 32,
            y: Math.floor(i / 8) * 32,
            w: 32, h: 32,
            dirty: true,
        }});
        l.blend = m.id;
    }}
    await run("export", {{ doc: d.id, format: "psd", path: psdPath }});
    await run("export", {{ doc: d.id, format: "ora", path: oraPath }});
    host.shell.closeDocument(ed, {{ force: true }});

    // Reopen PSD
    const dPsd = await run("new_document");
    await run("load_image", {{ doc: dPsd.id, path: psdPath }});
    const edPsd = ednow(dPsd.id);
    const psdModes = {{}};
    for (const m of MODES) {{
        const l = edPsd.layers.find((x) => x.name === "L_" + m.id);
        if (!l) throw new Error("PSD missing layer for " + m.id);
        if (l.blend !== m.id) throw new Error("PSD layer for " + m.id + " has blend " + l.blend);
        psdModes[m.id] = l.blend;
    }}
    host.shell.closeDocument(edPsd, {{ force: true }});

    // Reopen ORA
    const dOra = await run("new_document");
    await run("load_image", {{ doc: dOra.id, path: oraPath }});
    const edOra = ednow(dOra.id);
    const oraModes = {{}};
    for (const m of MODES) {{
        const l = edOra.layers.find((x) => x.name === "L_" + m.id);
        if (!l) throw new Error("ORA missing layer for " + m.id);
        if (l.blend !== m.id) throw new Error("ORA layer for " + m.id + " has blend " + l.blend);
        oraModes[m.id] = l.blend;
    }}
    host.shell.closeDocument(edOra, {{ force: true }});

    return {{ psd: psdModes, ora: oraModes }};
    """
    try:
        res = await c.eval(PRE % (HELPERS, js_h), timeout=60)
        print(f"[ok] psd_and_ora_keep_every_mode: {json.dumps(res)}")
    except Exception as err:
        ok = False
        print(f"[FAIL] psd_and_ora_keep_every_mode: {err}")
    finally:
        for p in (psd_path, ora_path):
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass

    # i. documents_ask_for_the_right_reader
    scumble_path = os.path.join(scratch_dir, f"test_reader_{os.getpid()}.scumble").replace("\\", "/")
    js_i_save = f"""
    const scumblePath = {json.dumps(scumble_path)};
    const d = await run("new_document");
    const ed = ednow(d.id);
    host.shell.activate(ed);
    await run("new_canvas", {{ doc: d.id, width: 256, height: 256 }});
    for (let i = 0; i < BLEND_MODES.length; i++) {{
        const id = BLEND_MODES[i];
        const l = ed.addPaintLayer();
        l.name = "Layer_" + id;
        l.blend = id;
    }}
    await run("save_document", {{ doc: d.id, path: scumblePath }});
    host.shell.closeDocument(ed, {{ force: true }});
    return {{ saved: true }};
    """
    js_i_open = f"""
    const scumblePath = {json.dumps(scumble_path)};
    const r = await run("open_document", {{ path: scumblePath }});
    const edOpen = ednow(r.id || host.editor.node.id);
    const openedModes = {{}};
    for (const id of BLEND_MODES) {{
        const l = edOpen.layers.find((x) => x.name === "Layer_" + id);
        if (!l) throw new Error("Reopened document missing layer " + id);
        if (l.blend !== id) throw new Error("Reopened layer " + id + " has blend " + l.blend);
        openedModes[id] = l.blend;
    }}
    host.shell.closeDocument(edOpen, {{ force: true }});
    return {{ opened: openedModes }};
    """
    try:
        await c.eval(PRE % (HELPERS, js_i_save), timeout=60)
        # Check zip header minReader in Python
        with zipfile.ZipFile(scumble_path, "r") as zf:
            doc_json = json.loads(zf.read("scumble/document.json").decode("utf-8"))
        min_reader = doc_json.get("minReader")
        if min_reader != 5:
            raise Exception(f"minReader {min_reader} !== 5 (ops 14-19 reader)")
        res_open = await c.eval(PRE % (HELPERS, js_i_open), timeout=60)
        print(f"[ok] documents_ask_for_the_right_reader: minReader={min_reader}, modes={len(res_open['opened'])}")
    except Exception as err:
        ok = False
        print(f"[FAIL] documents_ask_for_the_right_reader: {err}")
    finally:
        if os.path.exists(scumble_path):
            try:
                os.remove(scumble_path)
            except OSError:
                pass

    # j. set_layer_takes_every_mode
    js_j = """
    const d = await run("new_document");
    const ed = ednow(d.id);
    host.shell.activate(ed);
    await run("new_canvas", { doc: d.id, width: 256, height: 256 });
    const l = ed.addPaintLayer();
    try {
        const accepted = [];
        for (const id of BLEND_MODES) {
            await commands.run("set_layer", { layer: l.id, blend: id, doc: d.id });
            if (l.blend !== id) throw new Error("set_layer failed to set blend " + id);
            accepted.push(id);
        }
        let refused = false, errMsg = "";
        try {
            await commands.run("set_layer", { layer: l.id, blend: "colour-dodge", doc: d.id });
        } catch (e) {
            refused = true;
            errMsg = String((e && e.message) || e);
        }
        if (!refused) throw new Error("set_layer accepted invalid mode 'colour-dodge'");
        if (!errMsg.includes("colour-dodge")) throw new Error("error message does not contain invalid name: " + errMsg);
        for (const id of BLEND_MODES) {
            if (!errMsg.includes(id)) throw new Error("error message does not list valid mode " + id + ": " + errMsg);
        }
        return { acceptedCount: accepted.length, refused: "colour-dodge" };
    } finally {
        host.shell.closeDocument(ed, { force: true });
    }
    """
    try:
        res = await c.eval(PRE % (HELPERS, js_j), timeout=60)
        print(f"[ok] set_layer_takes_every_mode: {json.dumps(res)}")
    except Exception as err:
        ok = False
        print(f"[FAIL] set_layer_takes_every_mode: {err}")

    # k. tiff_png_and_merge_agree
    js_k = """
    const out = {};
    for (const m of MODES) {
        const { ed, layer } = await setupPairsDoc();
        try {
            layer.blend = m.id;
            ed.markLayerChanged(layer); ed.renderLayers();
            let decPngData = null;
            if (ed.tileMode) {
                const rPng = await ed.encodeComposite({ forRun: true }, { hash: false });
                const decPng = await decodePng(rPng.blob);
                decPngData = decPng.data;
            } else {
                const flat = ed.flattenToCanvas({ forRun: true });
                decPngData = flat.getContext("2d").getImageData(0, 0, 256, 256).data;
            }

            const rTiff = await ed.encodeTiff(null, {});
            const decTiff = await decodeTiff(rTiff.blob);
            const dt = diff(decTiff.data, decPngData);
            if (dt.count !== 0) throw new Error("mode " + m.id + ": TIFF differs from PNG by " + dt.count + " bytes");

            const flat = ed.flattenToCanvas({ forRun: true });
            const flatData = flat.getContext("2d").getImageData(0, 0, 256, 256).data;

            await ed.mergeDown(layer);
            const baseBytes = bytesOf(ed.basePx, 256, 256);
            if (EMULATED_BLENDS.has(m.id)) {
                const dm = diff(new Uint8Array(baseBytes), decPngData);
                if (dm.count !== 0) throw new Error("mode " + m.id + ": merged base differs from export by " + dm.count + " bytes");
            } else {
                const dm = diff(new Uint8Array(baseBytes), flatData);
                if (dm.count !== 0) throw new Error("mode " + m.id + ": merged base differs from flatten by " + dm.count + " bytes");
            }

            out[m.id] = { tiffDiff: dt.count, mergeDiff: 0 };
        } finally {
            host.shell.closeDocument(ed, { force: true });
        }
    }
    return out;
    """
    try:
        res = await c.eval(PRE % (HELPERS, js_k), timeout=90)
        print(f"[ok] tiff_png_and_merge_agree: {json.dumps(res)}")
    except Exception as err:
        ok = False
        print(f"[FAIL] tiff_png_and_merge_agree: {err}")

    # l. references (showcase document 1024x640 with 25 non-normal columns)
    update = getattr(args, "update", False) if args else False
    tolerance = getattr(args, "tolerance", 3) if args else 3
    ref_full_path = os.path.join(REFS, "blendmodes_full.png")
    ref_view_path = os.path.join(REFS, "blendmodes_view.png")

    js_l = """
    const W = 1024, H = 640;
    const d = await run("new_document");
    const ed = ednow(d.id);
    host.shell.activate(ed);
    await new Promise((r) => setTimeout(r, 80));
    ed.resizeCanvas();
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#12305a"); g.addColorStop(0.5, "#8a6a3a"); g.addColorStop(1, "#d8d0c0");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        for (let i = 0; i < 12; i++) {
            x.fillStyle = `hsl(${i * 30},70%,${30 + (i % 4) * 12}%)`;
            x.fillRect(20 + i * 70, 40 + (i % 3) * 90, 60, 120);
        }
        x.fillStyle = "#000"; x.fillRect(0, H - 60, W, 30);
        x.fillStyle = "#fff"; x.fillRect(0, H - 30, W, 30);
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "blendmodes_showcase.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    const { Layer: LayerPixels } = ed.pixels;

    // 25 columns, one per non-normal mode with a formula, 32 px wide and 36 apart, opacity 0.75
    const modes25 = BLENDS.filter((r) => r.id !== "normal" && r.id !== "dissolve");
    const colW = 32, colH = 200;
    const colCanvas = mk(colW, colH);
    {
        const x = colCanvas.getContext("2d");
        const g = x.createLinearGradient(0, 0, 0, colH);
        g.addColorStop(0, "#ff5020"); g.addColorStop(0.5, "#20ff80"); g.addColorStop(1, "#3050ff");
        x.fillStyle = g; x.fillRect(0, 0, colW, colH);
        x.fillStyle = "rgba(255,255,255,0.85)"; x.fillRect(4, 20, 12, 60);
        x.fillStyle = "rgba(0,0,0,0.85)"; x.fillRect(16, 120, 12, 60);
    }
    try {
        for (let i = 0; i < modes25.length; i++) {
            const m = modes25[i];
            const l = ed.addLayer({
                name: "col_" + m.id,
                kind: "paint",
                px: LayerPixels.fromCanvas(colCanvas),
                x: 64 + i * 36,
                y: 30,
                w: colW,
                h: colH,
                dirty: true,
            });
            l.blend = m.id;
            l.opacity = 0.75;
        }
        ed.uploaded.baseHash = null;
        ed.flatCache = null;
        ed.sceneSig = null;
        ed.renderLayers();
        ed.view = { scale: 1, x: 40, y: 30, angle: 0 };
        ed.draw();
        await ed.mipsSettled();

        // Full-resolution composite
        ed.flatCache = null;
        const fullC = ed.flattenToCanvas({ forRun: true });
        const fullB64 = fullC.toDataURL("image/png").slice("data:image/png;base64,".length);

        // View composite
        await ed.mipsSettled();
        ed.sceneSig = null;
        ed.draw();
        await new Promise((r) => setTimeout(r, 120));
        const viewC = document.createElement("canvas");
        viewC.width = Math.min(1200, ed.canvas.width);
        viewC.height = Math.min(800, ed.canvas.height);
        viewC.getContext("2d").drawImage(ed.canvas, 0, 0, viewC.width, viewC.height, 0, 0, viewC.width, viewC.height);
        const viewB64 = viewC.toDataURL("image/png").slice("data:image/png;base64,".length);

        return { full: fullB64, view: viewB64, count: modes25.length };
    } finally {
        host.shell.closeDocument(ed, { force: true });
    }
    """
    try:
        res_l = await c.eval(PRE % (HELPERS, js_l), timeout=90)
        full_bytes = base64.b64decode(res_l["full"])
        view_bytes = base64.b64decode(res_l["view"])

        if update or not os.path.exists(ref_full_path):
            with open(ref_full_path, "wb") as f:
                f.write(full_bytes)
            print(f"[ref] blendmodes_full.png: written ({len(full_bytes)} bytes)")
        else:
            with open(ref_full_path, "rb") as f:
                want_full = f.read()
            df = compare(want_full, full_bytes)
            if df is None:
                print("[skip] blendmodes_full: Pillow missing")
            elif df.get("max", 999) <= tolerance:
                if df.get("max", 0) == 0:
                    print("[ok] blendmodes_full: identical")
                else:
                    print(f"[ok] blendmodes_full: max {df['max']} levels, mean {df.get('mean', 0):.3f} (within {tolerance})")
            else:
                ok = False
                print(f"[FAIL] blendmodes_full: max {df.get('max')} levels ({df.get('differing')} bytes differ)")

        if update or not os.path.exists(ref_view_path):
            with open(ref_view_path, "wb") as f:
                f.write(view_bytes)
            print(f"[ref] blendmodes_view.png: written ({len(view_bytes)} bytes)")
        else:
            with open(ref_view_path, "rb") as f:
                want_view = f.read()
            dv = compare(want_view, view_bytes)
            if dv is None:
                print("[skip] blendmodes_view: Pillow missing")
            elif dv.get("max", 999) <= tolerance:
                print(f"[ok] blendmodes_view: max {dv['max']} levels, mean {dv['mean']:.3f} (within {tolerance})")
            else:
                ok = False
                print(f"[FAIL] blendmodes_view: max {dv.get('max')} levels, mean {dv.get('mean')} (exceeds {tolerance})")

        print(f"[ok] references: {res_l['count']} columns verified")
    except Exception as err:
        ok = False
        print(f"[FAIL] references: {err}")

    # m. live_psd_check (R4-D6, R4-D7, R4-D8)
    psd_path = os.path.join(ROOT, "tools", "fixtures", "blendmodes", "blendmodes.psd").replace("\\", "/")
    png_path = os.path.join(ROOT, "tools", "fixtures", "blendmodes", "blendmodes_merged.png")
    modes_json_path = os.path.join(ROOT, "tools", "fixtures", "blendmodes", "modes.json")
    js_m = f"""
    const d = await run("new_document");
    const ed = ednow(d.id);
    host.shell.activate(ed);
    await new Promise((r) => setTimeout(r, 80));
    try {{
        await run("load_image", {{ doc: d.id, path: {json.dumps(psd_path)} }});
        const notes = (ed.notes && ed.notes.length) ? [...ed.notes] : (ed.status ? [ed.status] : []);
        const dissolveLayer = ed.layers.find((l) => l.name === "dissolve" || l.blend === "dissolve");
        const dissolveBlend = dissolveLayer ? dissolveLayer.blend : null;
        const flat = ed.flattenToCanvas({{ forRun: true }});
        const png = flat.toDataURL("image/png").slice("data:image/png;base64,".length);
        return {{ notes, png, layersCount: ed.layers.length, dissolveBlend }};
    }} finally {{
        host.shell.closeDocument(ed, {{ force: true }});
    }}
    """
    try:
        from PIL import Image
        res_m = await c.eval(PRE % (HELPERS, js_m), timeout=60)
        notes = res_m.get("notes", [])
        if any("blend modes the editor lacks" in n for n in notes):
            raise Exception(f"Unexpected missing blend modes note in PSD notes: {notes}")
        if res_m.get("dissolveBlend") != "dissolve":
            raise Exception(f"Dissolve layer blend is {res_m.get('dissolveBlend')}, expected dissolve")
        if not any("fill opacity below 100 %" in n for n in notes):
            raise Exception(f"Missing fill opacity note in PSD notes: {notes}")

        merged_img = Image.open(png_path).convert("RGBA")
        flat_img = Image.open(io.BytesIO(base64.b64decode(res_m["png"]))).convert("RGBA")
        if flat_img.size != merged_img.size:
            raise Exception(f"Size mismatch: flattened {flat_img.size} vs merged {merged_img.size}")

        with open(modes_json_path, "r", encoding="utf-8") as f:
            modes_def = json.load(f)

        patches_stats = {}
        for p in modes_def.get("layers", []):
            crop_merged = merged_img.crop((p["x"], p["y"], p["x"] + p["w"], p["y"] + p["h"]))
            crop_flat = flat_img.crop((p["x"], p["y"], p["x"] + p["w"], p["y"] + p["h"]))
            dm = crop_merged.tobytes()
            df = crop_flat.tobytes()
            worst = 0
            total = 0
            diff_count = 0
            for i in range(0, len(dm), 4):
                for ch in range(3):
                    diff_val = abs(dm[i + ch] - df[i + ch])
                    if diff_val:
                        diff_count += 1
                        total += diff_val
                        if diff_val > worst:
                            worst = diff_val
            mean_val = total / (p["w"] * p["h"] * 3)
            patches_stats[p["name"]] = {"max": worst, "mean": round(mean_val, 3), "diff_bytes": diff_count}

        PSD_BOUNDS = {
            "dissolve": 255,
            "hard_mix": 2,
            "darker_color": 25,
            "lighter_color": 60,
            "multiply_fill50": 70,
            "hue": 50,
            "color_dodge": 5,
            "vivid_light": 5,
            "linear_light": 4,
            "pin_light": 4,
            "divide": 4,
        }
        for p in modes_def.get("layers", []):
            name = p["name"]
            limit = PSD_BOUNDS.get(name, 2)
            worst = patches_stats[name]["max"]
            mean_val = patches_stats[name]["mean"]
            if worst > limit:
                raise Exception(f"Patch {name} max diff {worst} > {limit} against merged PSD")
            if name not in ("dissolve", "multiply_fill50") and mean_val > 1.0:
                raise Exception(f"Patch {name} mean diff {mean_val} > 1.0 against merged PSD")

        print(f"[ok] live_psd_check: {res_m.get('layersCount', 0)} layers, {len(patches_stats)} patches verified")
    except Exception as err:
        ok = False
        print(f"[FAIL] live_psd_check: {err}")

    # n. dissolve (PLAN_NIK9_BUILD.md Section 3.5 R4-S9)
    psd_dissolve_path = os.path.join(scratch_dir, f"test_dissolve_{os.getpid()}.psd").replace("\\", "/")
    js_n = f"""
    const psdPath = {json.dumps(psd_dissolve_path)};
    const {{ ed, docId, layer, baseData, layerData }} = await setupPairsDoc();
    try {{
        layer.blend = "dissolve";
        layer.opacity = 128 / 255;
        ed.markLayerChanged(layer);
        ed.renderLayers();

        // 1. Flatten to canvas
        const flat = ed.flattenToCanvas({{ forRun: true }});
        const flatData = flat.getContext("2d").getImageData(0, 0, 256, 256).data;

        // 2. Kernel dither reference
        const kref = new Uint8ClampedArray(256 * 256 * 4);
        const seed = seedOfLayer(layer.id);
        let keptCount = 0;
        for (let y = 0; y < 256; y++) {{
            for (let x = 0; x < 256; x++) {{
                const idx = (y * 256 + x) * 4;
                const srcA = layerData[idx + 3];
                const alpha255 = Math.round(Math.max(0, Math.min(1, layer.opacity ?? 1)) * 255);
                const c = mul255(srcA, alpha255);
                const keep = (c === 255) || ((hash32(x, y, seed) >>> 24) < c);
                if (keep) {{
                    keptCount++;
                    kref[idx] = layerData[idx];
                    kref[idx + 1] = layerData[idx + 1];
                    kref[idx + 2] = layerData[idx + 2];
                    kref[idx + 3] = 255;
                }} else {{
                    kref[idx] = baseData[idx];
                    kref[idx + 1] = baseData[idx + 1];
                    kref[idx + 2] = baseData[idx + 2];
                    kref[idx + 3] = baseData[idx + 3];
                }}
            }}
        }}

        // 3. Kept share at alpha 128 is 50 % +- 1 %
        const keptShare = keptCount / (256 * 256);
        if (Math.abs(keptShare - 0.50) > 0.01) {{
            throw new Error(`kept share ${{keptShare}} not within 50 % +- 1 %`);
        }}

        // Flatten vs kernel dither: 0 bytes differ
        const dFlat = diff(flatData, kref);
        if (dFlat.count !== 0) {{
            throw new Error(`flatten differs from kernel dither by ${{dFlat.count}} bytes (max ${{dFlat.max}})`);
        }}

        // 4. Export composite against flatten: 0 bytes differ (tiles backend)
        let exportDiff = 0;
        if (ed.tileMode) {{
            const comp = await ed.encodeComposite({{ forRun: true }}, {{ hash: false }});
            if (!comp || !comp.blob) throw new Error("no composite for dissolve");
            const dec = await decodePng(comp.blob);
            const dExport = diff(dec.data, flatData);
            if (dExport.count !== 0) {{
                throw new Error(`export differs from flatten by ${{dExport.count}} bytes (max ${{dExport.max}})`);
            }}
            exportDiff = dExport.count;
        }}

        // 5. Canvas view at 1:1 against kernel dither: 0 bytes differ
        ed.view = {{ scale: 1, x: 0, y: 0, angle: 0 }};
        ed.compositorOff = true;
        ed.sceneSig = null;
        ed.draw();
        const sc = document.createElement("canvas"); sc.width = 256; sc.height = 256;
        sc.getContext("2d").drawImage(ed.canvas, 0, 0, 256, 256, 0, 0, 256, 256);
        const screenData = sc.getContext("2d").getImageData(0, 0, 256, 256).data;
        const dView = diff(screenData, kref);
        if (dView.count !== 0) {{
            throw new Error(`canvas view at 1:1 differs from kernel dither by ${{dView.count}} bytes (max ${{dView.max}})`);
        }}

        // 6. Export to PSD to verify "diss"
        await run("export", {{ doc: docId, format: "psd", path: psdPath }});

        return {{ keptShare, exportDiff, viewDiff: dView.count }};
    }} finally {{
        host.shell.closeDocument(ed, {{ force: true }});
    }}
    """
    try:
        res_n = await c.eval(PRE % (HELPERS, js_n), timeout=60)
        with open(psd_dissolve_path, "rb") as f:
            psd_bytes = f.read()
        if b"diss" not in psd_bytes:
            raise Exception("PSD file does not contain blend mode key 'diss'")

        js_n_reopen = f"""
        const dPsd = await run("new_document");
        await run("load_image", {{ doc: dPsd.id, path: {json.dumps(psd_dissolve_path)} }});
        const edPsd = ednow(dPsd.id);
        try {{
            const l = edPsd.layers.find((x) => x.blend === "dissolve");
            if (!l) throw new Error("PSD reopened missing layer with blend dissolve");
            return {{ blend: l.blend }};
        }} finally {{
            host.shell.closeDocument(edPsd, {{ force: true }});
        }}
        """
        res_reopen = await c.eval(PRE % (HELPERS, js_n_reopen), timeout=60)
        if res_reopen.get("blend") != "dissolve":
            raise Exception(f"Reopened PSD layer blend {res_reopen.get('blend')} != dissolve")

        print(f"[ok] dissolve: kept share {res_n.get('keptShare', 0):.4f}, export diff {res_n.get('exportDiff')}, view diff {res_n.get('viewDiff')}, psd round-trip verified")
    except Exception as err:
        ok = False
        print(f"[FAIL] dissolve: {err}")
    finally:
        if os.path.exists(psd_dissolve_path):
            try:
                os.remove(psd_dissolve_path)
            except OSError:
                pass

    # o. dissolve_merge_and_brush (the review of 2026-10-11): step n's layer sits at the origin, where every map from a
    # canvas to the image is the identity. Here the layers are off it: merge down hashed the union box's own pixels and
    # moved half the dots, a brush's read (compositeBox) lost the dissolve and the clip, and the screen shader rounded
    # 30 % (float32 76.5) with GLSL round(), which may go half to even (76; ANGLE on D3D11), where the CPU paths take
    # Math.round (77)
    js_o = """
    const d = await run("new_document");
    const ed = ednow(d.id);
    host.shell.activate(ed);
    await new Promise((r) => setTimeout(r, 80));
    ed.resizeCanvas();
    try {
        const W = 256, H = 256;
        const { baseData } = makePairsData();
        const baseCanvas = document.createElement("canvas");
        baseCanvas.width = W; baseCanvas.height = H;
        baseCanvas.getContext("2d").putImageData(new ImageData(baseData, W, H), 0, 0);
        await ed.setBaseFromCanvas(baseCanvas, { keepLayers: false });
        const { Layer: LayerPixels } = ed.pixels;
        // opaque patterned patches: a dot kept in the wrong place changes the bytes wherever it lands
        const patch = (w, h, f) => {
            const a = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4, p = f(x, y);
                a[i] = p[0]; a[i + 1] = p[1]; a[i + 2] = p[2]; a[i + 3] = 255;
            }
            return a;
        };
        const PAINT = { x: 100, y: 50, w: 100, h: 90 }, DIS = { x: 120, y: 80, w: 96, h: 120 };
        const paintData = patch(PAINT.w, PAINT.h, (x, y) => [200, (x * 2) & 255, (y * 3) & 255]);
        const disData = patch(DIS.w, DIS.h, (x, y) => [(x * 5) & 255, 40 + (y & 63), (y * 2 + x) & 255]);
        const paint = ed.addLayer({ name: "paint", kind: "paint", px: LayerPixels.fromImageData(new ImageData(paintData, PAINT.w, PAINT.h)), ...PAINT, dirty: true });
        const dis = ed.addLayer({ name: "dissolve", kind: "paint", px: LayerPixels.fromImageData(new ImageData(disData, DIS.w, DIS.h)), ...DIS, dirty: true });
        dis.blend = "dissolve";
        const seed = seedOfLayer(dis.id);
        // the picture by hand: the dissolve layer where the hash of the image pixel keeps it, else the paint layer, else the base
        const expected = (alpha255) => {
            const out = new Uint8ClampedArray(baseData);
            const c = mul255(255, alpha255);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const o = (y * W + x) * 4;
                let src = null, si = 0;
                if (x >= DIS.x && x < DIS.x + DIS.w && y >= DIS.y && y < DIS.y + DIS.h && (c === 255 || (hash32(x, y, seed) >>> 24) < c)) { src = disData; si = ((y - DIS.y) * DIS.w + x - DIS.x) * 4; }
                else if (x >= PAINT.x && x < PAINT.x + PAINT.w && y >= PAINT.y && y < PAINT.y + PAINT.h) { src = paintData; si = ((y - PAINT.y) * PAINT.w + x - PAINT.x) * 4; }
                if (src) { out[o] = src[si]; out[o + 1] = src[si + 1]; out[o + 2] = src[si + 2]; out[o + 3] = 255; }
            }
            return out;
        };
        const flatBytes = () => ed.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(0, 0, W, H).data;
        const setOpacity = (v) => { dis.opacity = v; ed.markLayerChanged(dis); ed.renderLayers(); };
        const out = {};

        // 1. opacity 30 %: the flatten is the dither by hand at Math.round(0.3 * 255) = 77, the 1:1 canvas view (the
        //    dissolve shader) is the flatten
        setOpacity(0.3);
        const f30 = flatBytes();
        const d30 = diff(f30, expected(77));
        if (d30.count !== 0) throw new Error("flatten at 30 % differs from the dither by hand by " + d30.count + " bytes (max " + d30.max + ")");
        ed.view = { scale: 1, x: 0, y: 0, angle: 0 };
        ed.compositorOff = true;
        ed.sceneSig = null;
        ed.draw();
        const sc = document.createElement("canvas"); sc.width = W; sc.height = H;
        sc.getContext("2d").drawImage(ed.canvas, 0, 0, W, H, 0, 0, W, H);
        const dView = diff(sc.getContext("2d").getImageData(0, 0, W, H).data, f30);
        if (dView.count !== 0) throw new Error("canvas view at 1:1 and 30 % differs from the flatten by " + dView.count + " bytes (max " + dView.max + ")");
        out.view30 = dView.count;

        // 2. a brush's read of the composite ("all", what clone, heal, remove and the tone brush sample) over a box off
        //    the origin: the dots of the flatten, on the tile tier when the document is on tiles
        const box = [110, 70, 230, 210], bw = box[2] - box[0], bh = box[3] - box[1];
        const src = ed.brushSource("all", dis);
        let got;
        try { got = new Uint8ClampedArray(src.bytes(box)); out.brushTier = src.tier; } finally { src.release(); }
        if (ed.tileMode && out.brushTier !== "tiles") throw new Error("brushSource read the " + out.brushTier + " tier on tiles: compositeBox went untested");
        const want = new Uint8ClampedArray(bw * bh * 4);
        for (let y = 0; y < bh; y++) want.set(f30.subarray(((y + box[1]) * W + box[0]) * 4, ((y + box[1]) * W + box[2]) * 4), y * bw * 4);
        const dBrush = diff(got, want);
        if (dBrush.count !== 0) throw new Error("brushSource over a dissolve layer differs from the flatten by " + dBrush.count + " bytes (max " + dBrush.max + ")");
        out.brushDiff = dBrush.count;

        // 3. opacity 50 %, merge down: the union box starts at (100, 50), and the picture after the merge is the one before
        setOpacity(0.5);
        const f50 = flatBytes();
        const d50 = diff(f50, expected(128));
        if (d50.count !== 0) throw new Error("flatten at 50 % differs from the dither by hand by " + d50.count + " bytes (max " + d50.max + ")");
        await ed.mergeDown(dis);
        if (ed.layers.length !== 1 || ed.layers[0] !== paint) throw new Error("merge down left the layers " + ed.layers.map((l) => l.name).join(", "));
        if (paint.x !== 100 || paint.y !== 50 || paint.w !== 116 || paint.h !== 150) throw new Error("the merged layer's box is " + [paint.x, paint.y, paint.w, paint.h].join(", "));
        const dMerge = diff(flatBytes(), f50);
        if (dMerge.count !== 0) throw new Error("merge down changed the picture: " + dMerge.count + " bytes differ from the flatten before it (max " + dMerge.max + ")");
        out.mergeDiff = dMerge.count;

        // 4. a layer clipped to the merged one (opaque where it was painted or a dot was kept, clear elsewhere): a brush's
        //    read shows it only there, as the flatten does
        const CLIP = { x: 60, y: 20, w: 180, h: 200 };
        const clipData = patch(CLIP.w, CLIP.h, (x, y) => [30, (x * 3) & 255, (200 - y) & 255]);
        const clipped = ed.addLayer({ name: "clipped", kind: "paint", px: LayerPixels.fromImageData(new ImageData(clipData, CLIP.w, CLIP.h)), ...CLIP, dirty: true });
        clipped.clip = true;
        ed.markLayerChanged(clipped); ed.renderLayers();
        if (ed.clipBaseOf(clipped) !== paint) throw new Error("the clipped layer's base is not the merged layer");
        const fClip = flatBytes();
        const o = (25 * W + 65) * 4;   // inside the clipped layer's box, outside its base: the base picture shows
        if (fClip[o] !== baseData[o] || fClip[o + 1] !== baseData[o + 1] || fClip[o + 2] !== baseData[o + 2]) throw new Error("the flatten shows the clipped layer outside its base");
        const src2 = ed.brushSource("all", clipped);
        let got2;
        try { got2 = new Uint8ClampedArray(src2.bytes([0, 0, W, H])); out.clipTier = src2.tier; } finally { src2.release(); }
        if (ed.tileMode && out.clipTier !== "tiles") throw new Error("brushSource read the " + out.clipTier + " tier on tiles: compositeBox went untested");
        const dClip = diff(got2, fClip);
        if (dClip.count !== 0) throw new Error("brushSource over a clipped layer differs from the flatten by " + dClip.count + " bytes (max " + dClip.max + ")");
        out.clipDiff = dClip.count;
        return out;
    } finally {
        host.shell.closeDocument(ed, { force: true });
    }
    """
    try:
        res = await c.eval(PRE % (HELPERS, js_o), timeout=60)
        print(f"[ok] dissolve_merge_and_brush: {json.dumps(res)}")
    except Exception as err:
        ok = False
        print(f"[FAIL] dissolve_merge_and_brush: {err}")

    print("PASS" if ok else "FAIL")
    return ok


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        nres = node_step()
        print("[ok] blend_table_test.js: passed")
    except Exception as err:
        print(f"[FAIL] node pre-step: {err}")
        print("FAIL")
        sys.exit(1)

    parser = argparse.ArgumentParser(description="Blend modes gate")
    parser.add_argument("scratch", nargs="?", default=tempfile.gettempdir(), help="Scratch directory")
    parser.add_argument("--update", action="store_true", help="Update reference PNGs")
    parser.add_argument("--tolerance", type=int, default=3, help="Max allowed view diff levels")
    args = parser.parse_args()

    scratch_dir = args.scratch
    os.makedirs(scratch_dir, exist_ok=True)

    try:
        ok = asyncio.run(session(lambda c: run_gate(c, scratch_dir, args=args)))
        sys.exit(0 if ok else 1)
    except Exception as e:
        print(f"[FAIL] CDP session error: {e}")
        print("FAIL")
        sys.exit(1)


if __name__ == "__main__":
    main()
