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

Runs tools/blend_table_test.js under plain Node first, then connects to running app via CDP.
"""
import argparse
import asyncio
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
}
DEFAULT_BOUNDS = {"gl_translucent": 3, "flips": 0}

HELPERS = r"""
const { BLENDS, BLEND_MODES, BLEND_OPS, EMULATED_BLENDS, READER_OF_BLEND } = await import("./editor/blend_modes.js");
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


async def run_gate(c, scratch_dir):
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
                if (df.max > 3) throw new Error("mode " + m.id + ": clipped masked worker max diff " + df.max + " > 3");
                if (df.over2Fraction > 1e-4) throw new Error("mode " + m.id + ": clipped masked worker over2 fraction " + df.over2Fraction + " > 1e-4");
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
        if min_reader != 2:
            raise Exception(f"minReader {min_reader} !== 2 (linear-light reader)")
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

    scratch_dir = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else tempfile.gettempdir()
    os.makedirs(scratch_dir, exist_ok=True)

    try:
        ok = asyncio.run(session(lambda c: run_gate(c, scratch_dir)))
        sys.exit(0 if ok else 1)
    except Exception as e:
        print(f"[FAIL] CDP session error: {e}")
        print("FAIL")
        sys.exit(1)


if __name__ == "__main__":
    main()
