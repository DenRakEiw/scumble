"""TIFF in the app (docs/PLAN_0_1_29.md 3d): open, add as a layer, export, drop; on whichever backend the instance runs.

No ComfyUI, no key. First `node tools/tiff_test.js --out <dir>` (the reader and the writer in plain Node, which also
writes the fixtures of tools/tiff_fixtures.py to <dir>/fixtures), then the app:

- opens_every_accepted_fixture: `load_image` of each accepted fixture into a new tab. The base's bytes equal the
  fixture's expected RGBA exactly where alpha is 255; where it is below, alpha is exact and the colour within one level
  of what a canvas gives back for the expected colour (the tile store puts bytes that enter without a canvas through
  that round trip, the canvas backend's GPU canvas differs from it by one level on a few pairs); the worst difference
  from the expected bytes themselves and how many there are is printed. The status line mentions the notes, and the
  base is stored as a PNG, never as the TIFF.
- refuses_with_a_message: `load_image` of each refused fixture throws a message matching its pattern, the tab keeps no
  base (and a tab with a picture keeps its picture), and no .tif lands in the local store.
- adds_a_tiff_as_a_layer: `add_image_layer` of a 16-bit RGBA TIFF: an image layer with its pixels, stored as a PNG.
- exports_tiff_and_reads_it_back: a document with a partly transparent base and two layers (one at half opacity)
  exported as TIFF and PNG; tifffile and Pillow read the TIFF (size, Adobe Deflate, Predictor 2, ExtraSamples 2, the
  PNG's pixels exactly), then `load_image` of the TIFF gives the PNG's pixels (the round trip).
- exports_tiff_at_a_size: `export { format: "tiff", scale: 50 }` is half the size, and the PNG at 50 % its pixels.
- a_tif_drop_opens: a TIFF dropped (a synthetic drop event with a File) on an empty tab opens it; a second one, with no
  type but a .tiff name, dropped on the open tab becomes a layer.
- deflate_cut_adler_and_damaged_tail_open: >= 1 MiB decoded Deflate strips and tiles (codes 8 and 32946) whose Adler-32
  is cut by 1 or 4 bytes, plus a Deflate strip with damaged bytes past a 256 KiB flushed tail, open cleanly via
  readTiffBand / inflateInto in real Chromium with exact pixels.
- parallel_bands_priority_cancel_and_fallback: K18 parallel `tiff_band` jobs carry only `{ blob, spec, band }` (neither
  full strip tables nor `colormap`), write out-of-order bands via `writeRect`, run at `NORMAL` ahead of queued `EXPORT`
  jobs, cancel their group and release partial pixels without falling back on `later()`, and cancel + release + fall
  back to `tiff_read` on any band error.
- no_tiff_in_the_local_store: no .tif or .tiff file came into the local store during the gate.

    python tools/tiff_test.py [--out DIR] [--no-node]
    python tools/tiff_test.py --size 15000x10000 [--variant noise|own|lzw|packbits|raw_strips|zlib1|raw|all|a,b,...]
                              [--image PATH] [--out DIR]
        the 15k measurement alone (not in the default run; docs/PLAN_WASM_BUILD.md 4.6 and K0a), one variant or several:
        noise           (the default: W0's tiffperf row, unchanged) a noise picture of --size (a PNG written here, like
                        document_perf.py's) opened, exported as TIFF and that TIFF opened in a new tab; one row per
                        band plus whole-picture SHA-256 compared
        own             the photo (--image, default dist/daily/adobe_15000x10000.jpg as tools/w0_bench.py) opened, exported
                        as TIFF by the app (deflate + predictor 2: Scumble's own TIFF) and that opened in a new tab;
                        one row per band plus whole-picture SHA-256 compared
        lzw, packbits   Pillow writes the photo (decoded by Pillow, RGB) as LZW / PackBits (its default strips: one row
                        per strip at 15000 px)
        raw_strips      tifffile writes it uncompressed in 16-row strips (625 strips at 10000 px, on readTiffBand)
        zlib1           tifffile writes it with zlib in one strip, no predictor
        raw             tifffile writes it uncompressed (one strip)
        The five third-party files are written once into DIR and reused (the time and size printed when written), with
        <stem>_rows16.json beside them: the SHA-256 of one row per band and of the whole picture of the decoded photo as
        RGBA. Each open reports its wall (settled with mipsSettled), the window's tiff_open marks as durations
        (InpaintEditor.stepMarks), the tiff_band / tiff_read worker timings (InpaintEditor.jobTimings) and the other
        jobs of the open; noise and own also the export's marks and jobs; the file's strips, compression and predictor
        read by tifffile. One "[ok] variant <name>: {json}" line per variant (or [FAIL]); PASS when every variant opened
        at its size, noise's and own's per-band rows and whole-picture hash equal the tab they were exported from, and
        the third-party variants give one hash of their per-band rows and one whole-picture hash with alpha 255 (whether
        both match the decoded photo's is printed as asSource).
        Variants run one after the other in one instance: for numbers to compare run each on a fresh instance
        (tools/run_gates.sh <label> --offline tiffperf:15000x10000,--variant,own; commas for spaces).

The fixtures and the exported files go to DIR (default $SCUMBLE_GATES/tiff_fixtures, else dist/gates/tiff_fixtures).
Start the app first (tools/run_gates.sh <label> --offline [--tiles on|off] tiff does it).
"""
import asyncio
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARGS = sys.argv[1:]


def opt(name, default=None):
    return ARGS[ARGS.index(name) + 1] if name in ARGS and ARGS.index(name) + 1 < len(ARGS) else default


GATES = os.environ.get("SCUMBLE_GATES", os.path.join(ROOT, "dist", "gates"))
OUT = os.path.abspath(opt("--out", os.path.join(GATES, "tiff_fixtures")))
FIX = os.path.join(OUT, "fixtures")
SIZE = opt("--size")
VARIANTS = ("noise", "own", "lzw", "packbits", "raw_strips", "zlib1", "raw")   # the order of --variant all
THIRD = ("lzw", "packbits", "raw_strips", "zlib1", "raw")                      # written here from the photo, not by the app
VARIANT = opt("--variant", "noise")
IMAGE = os.path.abspath(opt("--image", os.path.join(ROOT, "dist", "daily", "adobe_15000x10000.jpg")))


def P(*parts):
    """A path under OUT, as a JSON string with forward slashes (for the page)."""
    return json.dumps(os.path.join(OUT, *parts).replace("\\", "/"))


HELP = r"""
// T[(a << 8) | c]: what a CPU canvas gives back for a straight (c, a) put into it (inpaint_tiles.js roundTripTable)
const RT = (() => {
    if (window.__tiffRT) return window.__tiffRT;
    const c = document.createElement("canvas");
    c.width = 256; c.height = 256;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const img = new ImageData(256, 256);
    for (let a = 0; a < 256; a++) for (let v = 0; v < 256; v++) { const i = (a * 256 + v) * 4; img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = a; }
    ctx.putImageData(img, 0, 0);
    const d = ctx.getImageData(0, 0, 256, 256).data;
    const t = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) t[i] = d[i * 4];
    c.width = 1; c.height = 1;
    return (window.__tiffRT = t);
})();
// got against want: alpha exact, colour exact where alpha is 255, within one level of the canvas round trip below it
const compare = (got, want, width) => {
    const r = { ok: false, alphaOff: 0, opaqueOff: 0, softOff: 0, worstSoft: 0, worstRaw: 0, rawOff: 0, soft: 0, first: null };
    if (!got || got.length !== want.length) { r.first = "the pixels hold " + (got ? got.length : 0) + " bytes, not " + want.length; return r; }
    let first = -1;
    for (let i = 0; i < want.length; i += 4) {
        const a = want[i + 3];
        if (got[i + 3] !== a) { r.alphaOff++; if (first < 0) first = i; }
        if (a < 255) r.soft++;
        for (let k = 0; k < 3; k++) {
            const g = got[i + k], w = want[i + k], raw = Math.abs(g - w);
            if (raw) { r.rawOff++; if (raw > r.worstRaw) r.worstRaw = raw; }
            if (a === 255) { if (raw) { r.opaqueOff++; if (first < 0) first = i; } }
            else {
                const d = Math.abs(g - RT[(a << 8) | w]);
                if (d > r.worstSoft) r.worstSoft = d;
                if (d > 1) { r.softOff++; if (first < 0) first = i; }
            }
        }
    }
    if (first >= 0) r.first = { x: (first >> 2) % width, y: Math.floor((first >> 2) / width), got: Array.from(got.subarray(first, first + 4)), want: Array.from(want.subarray(first, first + 4)) };
    r.ok = !(r.alphaOff + r.opaqueOff + r.softOff);
    return r;
};
const says = (c) => `${c.alphaOff} alpha, ${c.opaqueOff} opaque and ${c.softOff} soft bytes off (worst ${c.worstSoft} past the round trip); first ${JSON.stringify(c.first)}`;
const readBytes = async (p) => new Uint8Array((await window.scumble.file.read(p)).data);
const isTifRef = (ref) => !!(ref && /\.tiff?$/i.test(ref.filename || ""));
"""

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    %s
    %s
})()"""

OPEN_ONE = r"""
const F = __F__;
const d = await run("new_document");
const ed = ednow(d.id);
const E = ed.constructor;
host.shell.activate(ed);
try {
    E.jobTimings(true);
    let err = null;
    const t0 = performance.now();
    try { await run("load_image", { doc: d.id, path: F.path }); } catch (e) { err = String(e.message || e); }
    const ms = Math.round(performance.now() - t0);
    if (err) throw new Error("load_image: " + err);
    const allJt = E.jobTimings(true);
    const jt = allJt.filter((t) => t.op === "tiff_band");
    const readJt = allJt.filter((t) => t.op === "tiff_read");
    const pxCalls = {};
    for (const t of jt) {
        for (const [k, v] of Object.entries(t.pxCalls || {})) pxCalls[k] = (pxCalls[k] || 0) + v;
    }
    if (ed.width !== F.width || ed.height !== F.height) throw new Error(`opened as ${ed.width} x ${ed.height}`);
    const got = ed.basePx.readRect(0, 0, F.width, F.height).data;
    const c = compare(got, await readBytes(F.expect), F.width);
    const status = ed.status || "";
    const problems = [];
    if (!c.ok) problems.push(says(c));
    if (!jt.length || readJt.length || jt.some((t) => t.kernels !== "rust")) {
        problems.push("tiff_band timing: " + JSON.stringify({ jt, readJt }));
    }
    if (F.info && (F.info.compression === 5 || F.info.compression === 32773)) {
        if (!pxCalls.tiff_unpack) {
            problems.push("missing tiff_unpack in pxCalls: " + JSON.stringify(pxCalls));
        }
    }
    if (F.info && F.info.compression === 1) {
        if (pxCalls.tiff_unpack) {
            problems.push("unexpected wasm tiff_unpack on uncompressed TIFF: " + JSON.stringify(pxCalls));
        }
    }
    if (F.name === "rgb8_lzw_pred") {
        const d2 = await run("new_document");
        const ed2 = ednow(d2.id);
        host.shell.activate(ed2);
        E.setRoute("tiffUnpack", "js");
        E.setRoute("tiffUnpredict", "js");
        E.setRoute("tiffToRgba", "js");
        E.jobTimings(true);
        try {
            await run("load_image", { doc: d2.id, path: F.path });
            const allJtJs = E.jobTimings(true);
            const jtJs = allJtJs.filter((t) => t.op === "tiff_band");
            const readJtJs = allJtJs.filter((t) => t.op === "tiff_read");
            if (jtJs.length !== jt.length || readJtJs.length || jtJs.some((t) => t.pxCalls && (t.pxCalls.tiff_unpack || t.pxCalls.tiff_unpredict || t.pxCalls.tiff_to_rgba))) {
                problems.push("rgb8_lzw_pred js route timing: " + JSON.stringify({ jtJs, readJtJs }));
            }
            const jsData = ed2.basePx.readRect(0, 0, F.width, F.height).data;
            if (jsData.length !== got.length || jsData.some((v, i) => v !== got[i])) {
                problems.push("rgb8_lzw_pred rust vs js route pixels differ");
            }
        } finally {
            E.setRoute("tiffUnpack", null);
            E.setRoute("tiffUnpredict", null);
            E.setRoute("tiffToRgba", null);
            await run("close_document", { doc: d2.id });
            host.shell.activate(ed);
        }
    }
    const missing = F.notes.filter((n) => !status.toLowerCase().includes(n.toLowerCase()));
    if (missing.length) problems.push(`the status line does not mention ${missing.join(", ")}: "${status}"`);
    if (isTifRef(ed.base && ed.base.ref)) problems.push("the base is stored as the TIFF itself: " + ed.base.ref.filename);
    if (ed.undo && ed.undo.length) problems.push("opening left " + ed.undo.length + " undo steps");
    if (problems.length) throw new Error(problems.join(" | "));
    return { name: F.name, ms, bands: jt.length, soft: c.soft, worstSoft: c.worstSoft, worstRaw: c.worstRaw, rawOff: c.rawOff, ref: ed.base.ref.filename, status, pxCalls };
} finally { await run("close_document", { doc: d.id }); }
"""

REFUSE_ONE = r"""
const F = __F__;
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
try {
    let msg = null;
    try { await run("load_image", { doc: d.id, path: F.path }); } catch (e) { msg = String(e.message || e); }
    if (msg === null) throw new Error(`load_image took it (${ed.width} x ${ed.height})`);
    const re = new RegExp(F.error, F.error_flags || "");
    if (!re.test(msg)) throw new Error(`"${msg}" does not match ${re}`);
    if (ed.base) throw new Error("the tab has a base after the refusal");
    return { name: F.name, message: msg };
} finally { await run("close_document", { doc: d.id }); }
"""

NAMED_TIF = r"""
// a file named .tif that is none: a PNG renamed opens by its bytes and is stored as .png; one that is no picture is refused
const F = __F__;
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
try {
    await run("load_image", { doc: d.id, path: F.path });
    if (!ed.base) throw new Error("a PNG named .tif did not open: " + ed.status);
    const stored = ed.base.ref.filename;
    if (/\.tiff?$/i.test(stored)) throw new Error("stored under " + stored);
    let msg = null;
    const d2 = await run("new_document");
    try { await run("load_image", { doc: d2.id, path: __JUNK__ }); } catch (e) { msg = String(e.message || e); }
    await run("close_document", { doc: d2.id, force: true });
    if (msg === null || !/not a TIFF/i.test(msg)) throw new Error("a text file named .tif: " + msg);
    return { png: stored, junk: msg };
} finally { await run("close_document", { doc: d.id, force: true }); }
"""

REFUSE_KEEPS = r"""
// a refused TIFF on a tab with a picture: the picture stays
const F = __F__;
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
try {
    await run("new_canvas", { doc: d.id, width: 64, height: 48 });
    const ref = ed.base.ref;
    let msg = null;
    try { await run("load_image", { doc: d.id, path: F.path }); } catch (e) { msg = String(e.message || e); }
    if (msg === null) throw new Error("load_image took it");
    if (ed.width !== 64 || ed.height !== 48 || !ed.base || ed.base.ref !== ref) throw new Error(`the tab's picture changed (${ed.width} x ${ed.height})`);
    return { kept: `${ed.width} x ${ed.height}`, message: msg };
} finally { await run("close_document", { doc: d.id }); }
"""

LAYER = r"""
const F = __F__;
const d = await run("new_document");
const ed = ednow(d.id);
const E = ed.constructor;
const prevBandRows = E.tiffBandRows;
host.shell.activate(ed);
try {
    await run("new_canvas", { doc: d.id, width: 200, height: 150 });
    const n = ed.layers.length;
    E.tiffBandRows = 8;
    E.jobTimings(true);
    const r = await run("add_image_layer", { doc: d.id, path: F.path });
    const allJt = E.jobTimings(true);
    const jt = allJt.filter((t) => t.op === "tiff_band");
    const readJt = allJt.filter((t) => t.op === "tiff_read");
    const pxCalls = {};
    for (const t of jt) {
        for (const [k, v] of Object.entries(t.pxCalls || {})) pxCalls[k] = (pxCalls[k] || 0) + v;
    }
    if (ed.layers.length !== n + 1) throw new Error(`${ed.layers.length - n} layers added: ${ed.status}`);
    const l = ed.layers[ed.layers.length - 1];
    const problems = [];
    if (jt.length < 2 || readJt.length || jt.some((t) => t.kernels !== "rust") || !pxCalls.tiff_unpredict || !pxCalls.tiff_to_rgba) {
        problems.push("layer tiff_band timing: " + JSON.stringify({ jt, readJt }));
    }
    if (l.kind !== "image") problems.push("the layer is a " + l.kind);
    if (l.w !== F.width || l.h !== F.height || l.px.width !== F.width || l.px.height !== F.height) problems.push(`the layer is ${l.w} x ${l.h} (pixels ${l.px.width} x ${l.px.height}), not ${F.width} x ${F.height}`);
    const c = compare(l.px.readRect(0, 0, F.width, F.height).data, await readBytes(F.expect), F.width);
    if (!c.ok) problems.push(says(c));
    if (isTifRef(l.ref)) problems.push("the layer is stored as the TIFF itself: " + l.ref.filename);
    await ed.syncLayers();
    if (!l.ref || isTifRef(l.ref)) problems.push("after syncLayers the layer's file is " + JSON.stringify(l.ref));
    if (problems.length) throw new Error(problems.join(" | "));
    return { layer: r.name || l.name, size: `${l.w} x ${l.h}`, bands: jt.length, soft: c.soft, worstSoft: c.worstSoft, worstRaw: c.worstRaw, ref: l.ref.filename, status: ed.status, pxCalls };
} finally {
    E.tiffBandRows = prevBandRows;
    await run("close_document", { doc: d.id });
}
"""

EXPORT_BUILD = r"""
const d = await run("new_document");
window.__tx = { doc: d.id };
const ed = ednow(d.id);
const E = ed.constructor;
host.shell.activate(ed);
const W = 640, H = 400;
const c = document.createElement("canvas");
c.width = W; c.height = H;
const g = c.getContext("2d");
const grad = g.createLinearGradient(0, 0, W, H);
grad.addColorStop(0, "rgba(200, 40, 20, 1)"); grad.addColorStop(0.6, "rgba(40, 160, 90, 0.7)"); grad.addColorStop(1, "rgba(20, 80, 220, 0.15)");
g.fillStyle = grad; g.fillRect(0, 0, W, H);
g.clearRect(0, 0, 60, 60);   // a transparent corner
await ed.setBaseFromCanvas(c);
const mk = (w, h, draw) => { const k = document.createElement("canvas"); k.width = w; k.height = h; draw(k.getContext("2d")); return ed.pixels.Layer.fromCanvas(k); };
ed.addLayer({ name: "Opaque", kind: "image", ref: null, px: mk(200, 120, (x) => { x.fillStyle = "#1a9c3e"; x.fillRect(0, 0, 200, 120); x.fillStyle = "#f0e010"; x.fillRect(40, 30, 60, 50); }), x: 50, y: 40, w: 200, h: 120, dirty: true });
ed.addLayer({ name: "Half", kind: "image", ref: null, px: mk(300, 200, (x) => { x.fillStyle = "rgba(255, 255, 255, 0.5)"; x.fillRect(0, 0, 300, 200); x.fillStyle = "rgba(10, 10, 60, 0.8)"; x.beginPath(); x.arc(150, 100, 80, 0, Math.PI * 2); x.fill(); }), x: 300, y: 150, w: 300, h: 200, opacity: 0.5, dirty: true });
ed.renderLayers && ed.renderLayers();
E.jobTimings(true);
const t0 = performance.now();
const tif = await run("export", { doc: d.id, format: "tiff", path: __TIF__ });
const tifMs = Math.round(performance.now() - t0);
const rustParts = E.jobTimings(true).filter((t) => t.op === "tiff_part");
const wantCompose = ed.tileMode ? 1 : 0;
let predCalls = 0, defCalls = 0;
for (const p of rustParts) {
    predCalls += (p.pxCalls && p.pxCalls.tiff_predict_rgba) || 0;
    defCalls += (p.pxCalls && p.pxCalls.deflate_part) || 0;
}
if (!rustParts.length || rustParts.some((p) => p.kernels !== "rust" || p.composeWasm !== wantCompose) || !predCalls || !defCalls) {
    throw new Error("export tiff_part rust timing: " + JSON.stringify(rustParts));
}
// Replay export under the "js" route for tiffPredict and tiffStripWasm and assert identical file bytes
let jsParts = [];
E.setRoute("tiffPredict", "js");
E.setRoute("tiffStripWasm", "js");
E.jobTimings(true);
try {
    await run("export", { doc: d.id, format: "tiff", path: __TIFJS__ });
    jsParts = E.jobTimings(true).filter((t) => t.op === "tiff_part");
} finally {
    E.setRoute("tiffPredict", null);
    E.setRoute("tiffStripWasm", null);
}
if (!jsParts.length || jsParts.some((p) => p.composeWasm !== 0 || (p.pxCalls && p.pxCalls.tiff_predict_rgba))) {
    throw new Error("export tiff_part js route timing: " + JSON.stringify(jsParts));
}
const bRust = await readBytes(__TIF__), bJs = await readBytes(__TIFJS__);
if (bRust.length !== bJs.length || bRust.some((v, i) => v !== bJs[i])) {
    throw new Error(`export tiff rust (${bRust.length} B) vs js route (${bJs.length} B) differ`);
}
const png = await run("export", { doc: d.id, format: "png", path: __PNG__ });
const half = await run("export", { doc: d.id, format: "tiff", scale: 50, path: __TIF50__ });
const halfPng = await run("export", { doc: d.id, format: "png", scale: 50, path: __PNG50__ });
return { tiles: !!ed.tileMode, tif: tif.status, tifMs, png: png.status, half: half.status, halfPng: halfPng.status, parts: rustParts.length, composeWasm: wantCompose, predCalls, defCalls, jsRouteBytesEqual: true };
"""

EXPORT_REOPEN = r"""
const d = await run("new_document");
const ed = ednow(d.id);
const E = ed.constructor;
host.shell.activate(ed);
try {
    E.jobTimings(true);
    await run("load_image", { doc: d.id, path: __TIF__ });
    const allJt = E.jobTimings(true);
    const jt = allJt.filter((t) => t.op === "tiff_band");
    const readJt = allJt.filter((t) => t.op === "tiff_read");
    const pxCalls = {};
    for (const t of jt) {
        for (const [k, v] of Object.entries(t.pxCalls || {})) pxCalls[k] = (pxCalls[k] || 0) + v;
    }
    if (jt.length !== 2 || readJt.length || jt.some((t) => t.kernels !== "rust") || !pxCalls.tiff_unpredict || !pxCalls.tiff_to_rgba) {
        throw new Error("reopen tiff_band rust timing: " + JSON.stringify({ jt, readJt }));
    }
    if (ed.width !== 640 || ed.height !== 400) throw new Error(`reopened as ${ed.width} x ${ed.height}`);
    const rustData = ed.basePx.readRect(0, 0, 640, 400).data;
    const c = compare(rustData, await readBytes(__RGBA__), 640);
    if (!c.ok) throw new Error("the reopened TIFF against the PNG: " + says(c));
    // Replay open under the "js" route for tiffUnpredict and tiffToRgba and assert identical pixels
    const d2 = await run("new_document");
    const ed2 = ednow(d2.id);
    host.shell.activate(ed2);
    E.setRoute("tiffUnpredict", "js");
    E.setRoute("tiffToRgba", "js");
    E.jobTimings(true);
    try {
        await run("load_image", { doc: d2.id, path: __TIF__ });
        const allJtJs = E.jobTimings(true);
        const jtJs = allJtJs.filter((t) => t.op === "tiff_band");
        const readJtJs = allJtJs.filter((t) => t.op === "tiff_read");
        if (jtJs.length !== 2 || readJtJs.length || jtJs.some((t) => t.pxCalls && (t.pxCalls.tiff_unpredict || t.pxCalls.tiff_to_rgba))) {
            throw new Error("reopen tiff_band js route timing: " + JSON.stringify({ jtJs, readJtJs }));
        }
        const jsData = ed2.basePx.readRect(0, 0, 640, 400).data;
        if (jsData.length !== rustData.length || jsData.some((v, i) => v !== rustData[i])) {
            throw new Error("reopen tiff rust vs js route pixels differ");
        }
    } finally {
        E.setRoute("tiffUnpredict", null);
        E.setRoute("tiffToRgba", null);
        await run("close_document", { doc: d2.id });
    }
    return { bands: jt.length, soft: c.soft, worstSoft: c.worstSoft, worstRaw: c.worstRaw, rawOff: c.rawOff, status: ed.status, pxCalls, jsRouteEqual: true };
} finally { await run("close_document", { doc: d.id }); }
"""

EXPORT_CLOSE = r"""
if (window.__tx) await run("close_document", { doc: window.__tx.doc });
return true;
"""

DROP = r"""
const F = __F__, G = __G__;
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
try {
    const target = ed.viewEl;
    if (!target) return { skipped: "the tab has no view element to drop on" };
    let dt;
    try { dt = new DataTransfer(); dt.items.add(new File([await readBytes(F.path)], "dropped.tif", { type: "image/tiff" })); } catch (e) { return { skipped: "no DataTransfer with a File here: " + e.message }; }
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    for (let i = 0; i < 300 && !ed.base; i++) await wait(100);
    if (!ed.base) throw new Error("the drop on an empty tab opened nothing: " + ed.status);
    for (let i = 0; i < 100 && ed._loading; i++) await wait(100);
    if (ed.width !== F.width || ed.height !== F.height) throw new Error(`the dropped TIFF opened as ${ed.width} x ${ed.height}`);
    const a = compare(ed.basePx.readRect(0, 0, F.width, F.height).data, await readBytes(F.expect), F.width);
    if (!a.ok) throw new Error("the dropped TIFF: " + says(a));
    const opened = ed.status;
    // a second TIFF, with no type but a .tiff name, dropped on the open tab: a layer
    const n = ed.layers.length;
    const dt2 = new DataTransfer();
    dt2.items.add(new File([await readBytes(G.path)], "layer.tiff", { type: "" }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt2, bubbles: true, cancelable: true }));
    for (let i = 0; i < 300 && ed.layers.length === n; i++) await wait(100);
    if (ed.layers.length !== n + 1) throw new Error(`${ed.layers.length - n} layers after the drop on the open tab: ${ed.status}`);
    const l = ed.layers[ed.layers.length - 1];
    if (l.px.width !== G.width || l.px.height !== G.height) throw new Error(`the dropped layer is ${l.px.width} x ${l.px.height}`);
    const b = compare(l.px.readRect(0, 0, G.width, G.height).data, await readBytes(G.expect), G.width);
    if (!b.ok) throw new Error("the dropped layer: " + says(b));
    return { opened, layer: l.name, status: ed.status };
} finally { await run("close_document", { doc: d.id }); }
"""

PARALLEL_BANDS = r"""
const F_PLANAR = __PLANAR__, F_PAL = __PAL__, F_LZW = __LZW__, F_TRUNC = __TRUNC__;
const { editorPool } = await import("./editor/inpaint_jobs.js");
const { NORMAL, EXPORT } = await import("./editor/inpaint_pool.js");
const d = await run("new_document");
const ed = ednow(d.id);
const E = ed.constructor;
host.shell.activate(ed);
const pool = editorPool();
const origRun = pool.run.bind(pool);
const origCancel = pool.cancel.bind(pool);
const origSend = pool._send.bind(pool);
const Proto = ed.pixels.Layer.prototype;
const origRelease = Proto.release;
const prevBandRows = E.tiffBandRows;
try {
    const planarBytes = await readBytes(F_PLANAR.path), planarWant = await readBytes(F_PLANAR.expect);
    const palBytes = await readBytes(F_PAL.path), palWant = await readBytes(F_PAL.expect);
    const lzwBytes = await readBytes(F_LZW.path), lzwWant = await readBytes(F_LZW.expect);
    const truncBytes = await readBytes(F_TRUNC.path);
    const blobPlanar = new File([planarBytes], "planar.tif", { type: "image/tiff" });
    const blobPal = new File([palBytes], "pal.tif", { type: "image/tiff" });
    const blobLzw = new File([lzwBytes], "lzw.tif", { type: "image/tiff" });
    const blobTrunc = new File([truncBytes], "trunc.tif", { type: "image/tiff" });

    // 1) Payload, monotonic progress(rowsDone / H), & out-of-order writeRect across planar_strips (18 total strip entries, 3 per 8-row band) and palette4 (ColorMap)
    E.tiffBandRows = 8;
    const seenPayloads = [], resolveOrder = [], groupsSeen = new Set(), planarProgs = [];
    pool.run = function (op, args, transfer, opts) {
        if (op === "tiff_band") {
            seenPayloads.push({
                argKeys: Object.keys(args || {}).sort().join(","),
                hasSpecOffsets: !!(args.spec && (args.spec.offsets || args.spec.counts)),
                hasSpecColormap: !!(args.spec && args.spec.colormap),
                hasPalLut: !!(args.spec && args.spec.pal),
                bandOffLen: args.band && args.band.offsets ? args.band.offsets.length : -1,
                priority: opts && opts.priority,
            });
            if (opts && opts.group) groupsSeen.add(opts.group);
            const p = origRun(op, args, transfer, opts);
            if (args.band && args.band.index === 0) {
                return p.then(async (r) => { await wait(35); resolveOrder.push(args.band.y0); return r; });
            }
            return p.then((r) => { resolveOrder.push(args.band.y0); return r; });
        }
        return origRun(op, args, transfer, opts);
    };
    const rPlanar = await E.parts.pixelsFromTiff(blobPlanar, ed.pixels.Layer, (f) => planarProgs.push(f), null);
    const cPlanar = compare(rPlanar.px.readRect(0, 0, F_PLANAR.width, F_PLANAR.height).data, planarWant, F_PLANAR.width);
    rPlanar.px.release();
    if (!cPlanar.ok) throw new Error("planar out-of-order bands: " + says(cPlanar));
    if (seenPayloads.length !== 6 || groupsSeen.size !== 1
        || seenPayloads.some((s) => s.argKeys !== "band,blob,spec" || s.hasSpecOffsets || s.hasSpecColormap || s.bandOffLen !== 3 || s.priority !== NORMAL)
        || resolveOrder[0] === 0 || resolveOrder[resolveOrder.length - 1] !== 0
        || planarProgs.length !== 6 || Math.abs(planarProgs[0] - 8 / F_PLANAR.height) > 1e-6
        || planarProgs[planarProgs.length - 1] !== 1
        || !planarProgs.every((f, i) => f > 0 && f <= 1 && (i === 0 || f > planarProgs[i - 1]))) {
        throw new Error("planar payload/order/progress check failed: " + JSON.stringify({ seenPayloads, resolveOrder, planarProgs }));
    }
    seenPayloads.length = 0; resolveOrder.length = 0;
    const rPal = await E.parts.pixelsFromTiff(blobPal, ed.pixels.Layer, null, null);
    const cPal = compare(rPal.px.readRect(0, 0, F_PAL.width, F_PAL.height).data, palWant, F_PAL.width);
    rPal.px.release();
    if (!cPal.ok) throw new Error("palette out-of-order bands: " + says(cPal));
    if (seenPayloads.length !== 6 || seenPayloads.some((s) => s.hasSpecColormap || !s.hasPalLut || s.bandOffLen !== 1)) {
        throw new Error("palette payload check failed: " + JSON.stringify(seenPayloads));
    }
    pool.run = origRun;

    // 2) NORMAL priority (1) runs tiff_band ahead of queued EXPORT (2) jobs on editorPool()
    let releaseHold = null;
    const holdPromise = new Promise((r) => { releaseHold = r; });
    const sentOrder = [];
    pool._send = function (s, job) {
        if (job.args && job.args._hold) {
            s.job = job;
            holdPromise.then(() => origSend(s, job));
            return;
        }
        if (job.op === "tiff_band" || (job.args && job.args._tag === "exp")) {
            sentOrder.push(job.op === "tiff_band" ? "tiff_band" : "export_crc");
        }
        return origSend(s, job);
    };
    const tinyCrcBlob = new Blob([new Uint8Array(4)]);
    const holdJobs = [];
    for (let i = 0; i < pool.size; i++) {
        holdJobs.push(origRun("crc", { blob: tinyCrcBlob, _hold: true }, [], { priority: NORMAL }));
    }
    const expJobs = [];
    for (let i = 0; i < 4; i++) {
        expJobs.push(origRun("crc", { blob: tinyCrcBlob, _tag: "exp" }, [], { priority: EXPORT }));
    }
    const prioOpen = E.parts.pixelsFromTiff(blobLzw, ed.pixels.Layer, null, null);
    for (let i = 0; i < 100 && !pool.queues[NORMAL].length; i++) await wait(5);
    if (!pool.queues[NORMAL].length || pool.queues[EXPORT].length !== 4) {
        releaseHold();
        throw new Error(`expected queued NORMAL and 4 EXPORT jobs before release, got q1=${pool.queues[NORMAL].length} q2=${pool.queues[EXPORT].length}`);
    }
    releaseHold();
    const [prioRes] = await Promise.all([prioOpen, ...holdJobs, ...expJobs]);
    pool._send = origSend;
    const cPrio = compare(prioRes.px.readRect(0, 0, F_LZW.width, F_LZW.height).data, lzwWant, F_LZW.width);
    prioRes.px.release();
    if (!cPrio.ok) throw new Error("priority open pixels: " + says(cPrio));
    const lastBandAt = sentOrder.lastIndexOf("tiff_band"), firstExpAt = sentOrder.indexOf("export_crc");
    if (sentOrder.filter((x) => x === "tiff_band").length !== 6 || firstExpAt < 0 || lastBandAt > firstExpAt) {
        throw new Error("NORMAL did not precede queued EXPORT jobs: " + JSON.stringify(sentOrder));
    }

    // 3) later() cancellation on pixelsFromTiff (after band 0 wrote rows) and via superseded loadFile:
    //    bands > 0 are held inside the real pool via _send, pool.stats().cancelled grows by 5, and no tiff_band starts after cancel
    let releaseCalls = 0;
    Proto.release = function (...a) { releaseCalls++; return origRelease.apply(this, a); };
    let cancelCalls = 0, fallbackReads = 0, stale = false, cancelDone = false, sentAfterCancel = 0;
    const heldSlots = [];
    const flushHeldSlots = (rejectHold = false) => {
        for (const hs of heldSlots.splice(0)) {
            if (hs.job && (hs.job.cancelled || rejectHold)) {
                clearTimeout(hs.job.timer);
                if (rejectHold && !hs.job.cancelled) hs.job.reject(new Error("cleanup held slot"));
                hs.job = null;
            }
        }
        pool._pump();
    };
    pool.cancel = function (g) {
        if (typeof g === "symbol") cancelCalls++;
        const n = origCancel(g);
        cancelDone = true;
        flushHeldSlots(false);
        return n;
    };
    pool.run = function (op, args, transfer, opts) {
        if (op === "tiff_read") fallbackReads++;
        return origRun(op, args, transfer, opts);
    };
    pool._send = function (s, job) {
        if (cancelDone && job.op === "tiff_band") sentAfterCancel++;
        if (job.op === "tiff_band" && job.args.band && job.args.band.index > 0) {
            s.job = job;
            heldSlots.push(s);
            return;
        }
        return origSend(s, job);
    };
    const cancelledBefore1 = pool.stats().cancelled;
    let cancelErr = null, progCalls = 0;
    try {
        await E.parts.pixelsFromTiff(blobLzw, ed.pixels.Layer, () => { progCalls++; stale = true; }, () => stale);
    } catch (e) {
        cancelErr = e;
    }
    const cancelledDelta1 = pool.stats().cancelled - cancelledBefore1;
    flushHeldSlots(true);
    if (!cancelErr || !cancelErr.cancelled || progCalls !== 1 || cancelCalls < 1 || cancelledDelta1 !== 5 || sentAfterCancel !== 0 || releaseCalls !== 1 || fallbackReads !== 0) {
        throw new Error("direct later() cancel check failed: " + JSON.stringify({ err: cancelErr && cancelErr.name, cancelled: !!(cancelErr && cancelErr.cancelled), progCalls, cancelCalls, cancelledDelta1, sentAfterCancel, releaseCalls, fallbackReads }));
    }

    // Superseded ed.loadFile: first open's 6 bands held inside real pool, second loadFile supersedes it cleanly without tiff_read fallback
    cancelCalls = 0; fallbackReads = 0; cancelDone = false; sentAfterCancel = 0;
    let releaseFirstLoad = null;
    const firstLoadGate = new Promise((r) => { releaseFirstLoad = r; });
    let heldBands = 0;
    const cancelledBefore2 = pool.stats().cancelled;
    pool._send = function (s, job) {
        if (cancelDone && job.op === "tiff_band" && job.args.blob === blobPlanar) sentAfterCancel++;
        if (job.op === "tiff_band" && job.args.blob === blobPlanar) {
            heldBands++;
            s.job = job;
            if (job.args.band && job.args.band.index === 0) {
                firstLoadGate.then(() => { if (s.job === job && !job.cancelled) origSend(s, job); });
            } else {
                heldSlots.push(s);
            }
            return;
        }
        return origSend(s, job);
    };
    const pLoad1 = ed.loadFile(blobPlanar, { ask: false });
    for (let i = 0; i < 100 && heldBands < 6; i++) await wait(5);
    const pLoad2 = ed.loadFile(blobPal, { ask: false });
    releaseFirstLoad();
    await Promise.all([pLoad1, pLoad2]);
    const cancelledDelta2 = pool.stats().cancelled - cancelledBefore2;
    flushHeldSlots(true);
    const cLoad2 = compare(ed.basePx.readRect(0, 0, F_PAL.width, F_PAL.height).data, palWant, F_PAL.width);
    if (!cLoad2.ok || cancelCalls < 1 || cancelledDelta2 !== 5 || sentAfterCancel !== 0 || fallbackReads !== 0 || /error|fail|cancel/i.test(ed.status || "")) {
        throw new Error("superseded loadFile check failed: " + JSON.stringify({ ok: cLoad2.ok, cancelCalls, cancelledDelta2, sentAfterCancel, fallbackReads, status: ed.status }));
    }

    // 4) Band error fallback to tiff_read: band 0 writes rows, band 1 fails in worker -> cancels bands 2..5 in real pool,
    //    resets rowsDone = 0 and releases partial px, falls back to tiff_read with exact pixels and progress <= 1 ending at 1
    cancelCalls = 0; fallbackReads = 0; releaseCalls = 0; cancelDone = false; sentAfterCancel = 0;
    let band1Ready = null;
    const afterBand0 = new Promise((r) => { band1Ready = r; });
    const fbProgs = [];
    const cancelledBefore3 = pool.stats().cancelled;
    pool.run = function (op, args, transfer, opts) {
        if (op === "tiff_read") {
            fallbackReads++;
            if (!opts || opts.priority !== NORMAL) throw new Error("tiff_read fallback priority not NORMAL: " + JSON.stringify(opts));
            return origRun(op, args, transfer, opts);
        }
        return origRun(op, args, transfer, opts);
    };
    pool._send = function (s, job) {
        if (cancelDone && job.op === "tiff_band") sentAfterCancel++;
        if (job.op === "tiff_band") {
            const idx = job.args.band.index;
            if (idx === 0) return origSend(s, job);
            s.job = job;
            if (idx === 1) {
                afterBand0.then(() => {
                    if (s.job === job && !job.cancelled) {
                        const badBand = { ...job.args.band, counts: new Uint32Array(job.args.band.counts.length).fill(999999) };
                        origSend(s, { ...job, args: { ...job.args, band: badBand } });
                    }
                });
            } else {
                heldSlots.push(s);
            }
            return;
        }
        return origSend(s, job);
    };
    const fbRes = await E.parts.pixelsFromTiff(blobLzw, ed.pixels.Layer, (f) => { fbProgs.push(f); if (fbProgs.length === 1 && band1Ready) band1Ready(); }, null);
    const cancelledDelta3 = pool.stats().cancelled - cancelledBefore3;
    flushHeldSlots(true);
    const releasesBeforeCleanup = releaseCalls;
    const cFb = compare(fbRes.px.readRect(0, 0, F_LZW.width, F_LZW.height).data, lzwWant, F_LZW.width);
    fbRes.px.release();
    if (!cFb.ok || cancelCalls < 1 || cancelledDelta3 !== 4 || sentAfterCancel !== 0 || fallbackReads !== 1 || releasesBeforeCleanup !== 1 || releaseCalls !== 2
        || fbProgs.length !== 7 || Math.abs(fbProgs[0] - 8 / F_LZW.height) > 1e-6 || Math.abs(fbProgs[1] - 8 / F_LZW.height) > 1e-6
        || fbProgs[fbProgs.length - 1] !== 1 || !fbProgs.every((f) => f > 0 && f <= 1)) {
        throw new Error("band error fallback check failed: " + JSON.stringify({ ok: cFb.ok, cancelCalls, cancelledDelta3, sentAfterCancel, fallbackReads, releasesBeforeCleanup, releaseCalls, fbProgs }));
    }
    pool._send = origSend;

    // Corrupt multi-band TIFF (truncated: 19 bands at tiffBandRows=8): early bands write, later band fails -> cancels group, releases partial px, falls back to tiff_read, throws refusal
    pool.run = function (op, args, transfer, opts) {
        if (op === "tiff_read") fallbackReads++;
        return origRun(op, args, transfer, opts);
    };
    cancelCalls = 0; fallbackReads = 0; releaseCalls = 0;
    let truncErr = null;
    try {
        await E.parts.pixelsFromTiff(blobTrunc, ed.pixels.Layer, null, null);
    } catch (e) {
        truncErr = String((e && e.message) || e);
    }
    if (!truncErr || !/ends early|truncated/i.test(truncErr) || cancelCalls < 1 || fallbackReads !== 1 || releaseCalls < 1) {
        throw new Error("corrupt multi-band fallback refusal check failed: " + JSON.stringify({ truncErr, cancelCalls, fallbackReads, releaseCalls }));
    }

    // 5) E.tiffBandRows = false skips tiff_band and uses tiff_read directly
    pool.run = origRun;
    pool.cancel = origCancel;
    Proto.release = origRelease;
    E.tiffBandRows = false;
    E.jobTimings(true);
    const noBandsRes = await E.parts.pixelsFromTiff(blobLzw, ed.pixels.Layer, null, null);
    const noBandsJt = E.jobTimings(true);
    const cNoBands = compare(noBandsRes.px.readRect(0, 0, F_LZW.width, F_LZW.height).data, lzwWant, F_LZW.width);
    noBandsRes.px.release();
    if (!cNoBands.ok || noBandsJt.some((t) => t.op === "tiff_band") || noBandsJt.filter((t) => t.op === "tiff_read").length !== 1) {
        throw new Error("tiffBandRows=false check failed: " + JSON.stringify(noBandsJt));
    }

    // 6) tiffPoolUsable with E.kernels = "js" (!E.parts.usable()) still dispatches tiff_band;
    //    and window fallbacks run when pool.off = true or when tiff_read sets pool.off and rejects with "no worker pool"
    E.tiffBandRows = 8;
    const prevKernels = E.kernels;
    try {
        E.kernels = "js";
        if (E.parts.usable()) throw new Error("expected E.parts.usable() === false when E.kernels === 'js'");
        E.jobTimings(true);
        const jsModeRes = await E.parts.pixelsFromTiff(blobLzw, ed.pixels.Layer, null, null);
        const jsModeJt = E.jobTimings(true);
        const cJsMode = compare(jsModeRes.px.readRect(0, 0, F_LZW.width, F_LZW.height).data, lzwWant, F_LZW.width);
        jsModeRes.px.release();
        if (!cJsMode.ok || jsModeJt.filter((t) => t.op === "tiff_band").length !== 6) {
            throw new Error("tiffPoolUsable with E.kernels='js' check failed: " + JSON.stringify(jsModeJt));
        }
    } finally {
        E.kernels = prevKernels;
    }

    const offProgs = [], winFbProgs = [];
    try {
        pool.off = true;
        E.jobTimings(true);
        const offRes = await E.parts.pixelsFromTiff(blobLzw, ed.pixels.Layer, (f) => offProgs.push(f), null);
        const offJt = E.jobTimings(true);
        const cOff = compare(offRes.px.readRect(0, 0, F_LZW.width, F_LZW.height).data, lzwWant, F_LZW.width);
        offRes.px.release();
        if (!cOff.ok || offJt.length !== 0 || offProgs.length !== 6 || offProgs[offProgs.length - 1] !== 1) {
            throw new Error("pool.off window branch check failed: " + JSON.stringify({ ok: cOff.ok, offJt, offProgs }));
        }

        pool.off = false;
        E.tiffBandRows = 8;
        pool.run = function (op, args, transfer, opts) {
            if (op === "tiff_band") return Promise.reject(new Error("no worker pool"));
            if (op === "tiff_read") {
                pool.off = true;
                return Promise.reject(new Error("no worker pool"));
            }
            return origRun(op, args, transfer, opts);
        };
        const winFbRes = await E.parts.pixelsFromTiff(blobLzw, ed.pixels.Layer, (f) => winFbProgs.push(f), null);
        const cWinFb = compare(winFbRes.px.readRect(0, 0, F_LZW.width, F_LZW.height).data, lzwWant, F_LZW.width);
        winFbRes.px.release();
        if (!cWinFb.ok || winFbProgs.length !== 6 || winFbProgs[winFbProgs.length - 1] !== 1) {
            throw new Error("needWindowFallback check failed: " + JSON.stringify({ ok: cWinFb.ok, winFbProgs }));
        }
    } finally {
        pool.off = false;
        pool.run = origRun;
    }

    return {
        tiles: !!ed.tileMode,
        planarBands: 6,
        sentOrder: sentOrder.join(","),
        supersededStatus: ed.status,
        truncRefused: truncErr.slice(0, 80),
        cancelledDeltas: [cancelledDelta1, cancelledDelta2, cancelledDelta3],
    };
} finally {
    pool.off = false;
    pool.run = origRun;
    pool.cancel = origCancel;
    pool._send = origSend;
    Proto.release = origRelease;
    E.tiffBandRows = prevBandRows;
    await run("close_document", { doc: d.id, force: true });
}
"""

MEASURE_HELP = r"""
const settle = async (e) => { for (let i = 0; i < 1200 && (e._loading || !e.base); i++) await wait(100); if (e.mipsSettled) await e.mipsSettled(); };
// the window's step marks (InpaintEditor.stepMarks) of one op as runs (docs/PLAN_WASM_BUILD.md K0a): each step's ms since
// the mark before it of the same op, a "start" opens a run, total = the last mark minus the start; extras stay flat
const runsOf = (marks, op) => {
    const runs = [];
    let run = null, t0 = 0, last = 0;
    for (const m of marks) {
        if (m.op !== op) continue;
        if (m.step === "start" || !run) { run = {}; runs.push(run); t0 = last = m.t; }
        if (m.step !== "start") { run[m.step] = Math.round(m.t - last); last = m.t; }
        for (const [k, v] of Object.entries(m)) if (k !== "op" && k !== "step" && k !== "t") run[k] = typeof v === "number" ? +v.toFixed(1) : v;
        run.total = Math.round(m.t - t0);
    }
    const tidy = runs.map(({ total, ...steps }) => ({ ...steps, total }));   // total last, for the reader
    return tidy.length ? (tidy.length === 1 ? tidy[0] : tidy) : null;
};
// the workers' timings (InpaintEditor.jobTimings) summed per op as tools/native_test.py does: numbers added, labels kept
const sums = (timings) => {
    const out = {};
    const workerSets = {};
    for (const t of timings) {
        const key = t.op + (t.kind ? ":" + t.kind : "");
        const j = out[key] || (out[key] = { jobs: 0 });
        j.jobs++;
        for (const [k, v] of Object.entries(t)) {
            if (k === "op" || k === "kind" || k === "gen") continue;
            if (typeof v === "number") j[k] = +((j[k] || 0) + v).toFixed(1);
            else if (typeof v === "string") { const s = new Set(j[k] ? String(j[k]).split("|") : []); s.add(v); j[k] = [...s].join("|"); }
            else if (k === "pxCalls" && v && typeof v === "object") {
                const pc = j.pxCalls || (j.pxCalls = {});
                for (const [ck, cv] of Object.entries(v)) if (typeof cv === "number") pc[ck] = (pc[ck] || 0) + cv;
            } else if (k === "pool" && v && typeof v === "object" && typeof v.worker === "number") {
                (workerSets[key] || (workerSets[key] = new Set())).add(v.worker);
            }
        }
    }
    for (const [key, ws] of Object.entries(workerSets)) out[key].workers = ws.size;
    return out;
};
const marksNow = (E) => (E.stepMarks ? E.stepMarks(true) : []);
const resetAll = (E) => { E.jobTimings(true); marksNow(E); };
// an open's marks and jobs, read and cleared: tiff_band and tiff_read apart, the other ops (png_part, mips ...) as jobs
const openParts = (E) => {
    const marks = marksNow(E), jobs = sums(E.jobTimings(true));
    const tiffBand = jobs.tiff_band || null, tiffRead = jobs.tiff_read || null;
    delete jobs.tiff_band;
    delete jobs.tiff_read;
    return { steps: runsOf(marks, "tiff_open"), tiff_band: tiffBand, tiff_read: tiffRead, jobs };
};
const hexOf = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
// K18 15k compare (docs/PLAN_WASM_BUILD.md §4.6): one row per band plus a 2-level SHA-256 of the whole picture
const checkBandsAndPicture = async (px, W, H, bandStep = 256) => {
    const nBands = Math.ceil(H / bandStep);
    const sampleRows = new Uint8Array(nBands * W * 4);
    const bandDigests = new Uint8Array(nBands * 32);
    let alphaOff = 0;
    for (let b = 0; b < nBands; b++) {
        const y0 = b * bandStep, rows = Math.min(bandStep, H - y0);
        const block = px.readRect(0, y0, W, rows).data;
        const ry = (b * 17) % rows;
        const rowSlice = block.subarray(ry * W * 4, (ry + 1) * W * 4);
        sampleRows.set(rowSlice, b * W * 4);
        for (let i = 3; i < rowSlice.length; i += 4) if (rowSlice[i] !== 255) alphaOff++;
        bandDigests.set(new Uint8Array(await crypto.subtle.digest("SHA-256", block)), b * 32);
    }
    const rowsHash = hexOf(await crypto.subtle.digest("SHA-256", sampleRows));
    const picHash = hexOf(await crypto.subtle.digest("SHA-256", bandDigests));
    return { bands: nBands, sampleRows, rowsHash, picHash, alphaOff };
};
"""

MEASURE = MEASURE_HELP + r"""
const W = __W__, H = __H__;
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const E = ed.constructor;
const t0 = performance.now();
await run("load_image", { doc: d.id, path: __BASE__ });
await settle(ed);
const pngOpenMs = performance.now() - t0;
resetAll(E);
const t1 = performance.now();
const ex = await run("export", { doc: d.id, format: "tiff", path: __TIF__ });
const exportMs = performance.now() - t1;
const exMarks = marksNow(E), exportSteps = { export: runsOf(exMarks, "export"), save: runsOf(exMarks, "save") }, exportJobs = sums(E.jobTimings(true));
const d2 = await run("new_document");
const ed2 = ednow(d2.id);
host.shell.activate(ed2);
resetAll(E);
const t2 = performance.now();
await run("load_image", { doc: d2.id, path: __TIF__ });
await settle(ed2);
const openMs = performance.now() - t2;
const open = openParts(E);
// one row per band compared byte for byte, plus a SHA-256 of the whole picture (after openMs / openParts are recorded)
const baseCheck = await checkBandsAndPicture(ed.basePx, W, H);
const openCheck = await checkBandsAndPicture(ed2.basePx, W, H);
let rowsOff = 0;
for (let b = 0; b < baseCheck.bands; b++) {
    const o0 = b * W * 4, o1 = o0 + W * 4;
    for (let i = o0; i < o1; i++) if (baseCheck.sampleRows[i] !== openCheck.sampleRows[i]) { rowsOff++; break; }
}
const picMatch = baseCheck.picHash === openCheck.picHash;
const tiles = !!ed.tileMode, baseSize = [ed.width, ed.height], size = [ed2.width, ed2.height], status = ed2.status;
await run("close_document", { doc: d2.id });
await run("close_document", { doc: d.id });
return { tiles, pngOpenMs: Math.round(pngOpenMs), exportMs: Math.round(exportMs), openMs: Math.round(openMs), baseSize, size,
         bandsChecked: baseCheck.bands, rowsOff, picMatch, picHash: openCheck.picHash, exportStatus: ex.status, openStatus: status,
         openSteps: open.steps, tiff_band: open.tiff_band, tiff_read: open.tiff_read, openJobs: open.jobs, exportSteps, exportJobs };
"""

OPEN_VARIANT = MEASURE_HELP + r"""
// a TIFF written outside the app opened in a new tab; one row per band plus the whole picture hashed (SHA-256)
const W = __W__, H = __H__;
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const E = ed.constructor;
try {
    resetAll(E);
    const t0 = performance.now();
    await run("load_image", { doc: d.id, path: __TIF__ });
    await settle(ed);
    const openMs = performance.now() - t0;
    const open = openParts(E);
    const size = [ed.width, ed.height];
    let hash = null, picHash = null, bandsChecked = 0, alphaOff = null;
    if (ed.width === W && ed.height === H) {
        const ck = await checkBandsAndPicture(ed.basePx, W, H);
        hash = ck.rowsHash;
        picHash = ck.picHash;
        bandsChecked = ck.bands;
        alphaOff = ck.alphaOff;
    }
    return { tiles: !!ed.tileMode, openMs: Math.round(openMs), size, bandsChecked, hash, picHash, alphaOff, status: ed.status,
             openSteps: open.steps, tiff_band: open.tiff_band, tiff_read: open.tiff_read, openJobs: open.jobs };
} finally { await run("close_document", { doc: d.id }); }
"""


def node_step():
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "tiff_test.js"), "--out", OUT], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=900)
    out = r.stdout.strip()   # stderr carries Node's note that it read the editor file as an ES module
    if r.returncode != 0 or not out.endswith("PASS"):
        fails = [line for line in out.splitlines() if line.startswith("[FAIL]")]
        raise Exception("tools/tiff_test.js: " + (" / ".join(fails[:8]) if fails else (out + r.stderr)[-1500:]))
    return {"checks": out.count("[ok]")}


def fixtures():
    """The manifest, with absolute paths for the page; the fixtures are written if the Node step did not."""
    man = os.path.join(FIX, "manifest.json")
    if not os.path.exists(man):
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "tiff_fixtures.py"), FIX, "--no-check"], cwd=ROOT, check=True, capture_output=True, timeout=600)
    with open(man, encoding="utf-8") as f:
        entries = json.load(f)
    for e in entries:
        e["path"] = os.path.join(FIX, e["file"]).replace("\\", "/")
        if e.get("expect"):
            e["expect"] = os.path.join(FIX, e["expect"]).replace("\\", "/")
    return entries


def tiffs_in(root):
    found = set()
    for d, _, files in os.walk(root):
        for f in files:
            if f.lower().endswith((".tif", ".tiff")):
                found.add(os.path.relpath(os.path.join(d, f), root))
    return found


async def js(c, body, timeout=300, **subs):
    for k, v in subs.items():
        body = body.replace("__%s__" % k, v)
    return await c.eval(PRE % (HELP, body), timeout=timeout)


def report(ok, name, res):
    print("[%s] %s: %s" % ("ok" if ok else "FAIL", name, res if isinstance(res, str) else json.dumps(res, ensure_ascii=False)[:1500]), flush=True)
    return ok


def python_reads(tif, png, half_tif, half_png, exact=True):
    """tifffile and Pillow read the exported TIFFs: size, tags, pixels against the PNGs'. Writes the TIFF's RGBA.

    `exact` (tiles): the TIFF is the PNG byte for byte, both come from the same rows. On the canvas backend the PNG is
    Chromium's encoder and the TIFF getImageData: two unpremultiplies of one canvas, a level apart where alpha < 255."""
    import numpy as np
    import tifffile
    from PIL import Image
    problems = []
    out = {}
    with tifffile.TiffFile(tif) as t:
        p = t.pages[0]
        a = p.asarray()
        out.update(shape=list(a.shape), compression=int(p.compression), predictor=int(p.predictor), extrasamples=[int(x) for x in p.extrasamples],
                   photometric=int(p.photometric), software=p.tags["Software"].value if "Software" in p.tags else None)
    if a.shape != (400, 640, 4):
        problems.append("tifffile reads %s, not (400, 640, 4)" % (a.shape,))
    if out["compression"] != 8 or out["extrasamples"] != [2] or out["photometric"] != 2 or out["predictor"] != 2:
        problems.append("tags %s" % json.dumps(out))
    im = Image.open(tif)
    im.load()
    b = np.asarray(im)
    if im.mode != "RGBA" or not np.array_equal(a, b):
        problems.append("Pillow reads another picture than tifffile (%s)" % im.mode)
    pim = Image.open(png)
    pim.load()
    q = np.asarray(pim.convert("RGBA"))
    alpha = q[..., 3]
    out["png_alpha"] = {"zero": int((alpha == 0).sum()), "soft": int(((alpha > 0) & (alpha < 255)).sum()), "full": int((alpha == 255).sum())}
    if not out["png_alpha"]["soft"] or not out["png_alpha"]["zero"]:
        problems.append("the test document exports no soft or no clear pixels: %s" % out["png_alpha"])
    if q.shape == a.shape:
        diff = np.abs(q.astype(int) - a.astype(int))
        out["vs_png"] = {"bytes_off": int((diff > 0).sum()), "worst": int(diff.max())}
        soft = q[..., 3] < 255
        loose = not exact and not diff[..., 3].max() and not diff[..., :3][~soft].max(initial=0) and diff[..., :3][soft].max(initial=0) <= 1
        if diff.max() and not loose:
            y, x, ch = np.argwhere(diff > 0)[0]
            problems.append("the TIFF's pixels are not the PNG's: %d bytes off, worst %d, first at (%d, %d): tiff %s png %s" % ((diff > 0).sum(), diff.max(), x, y, a[y, x].tolist(), q[y, x].tolist()))
    with open(os.path.join(OUT, "x_tif.rgba"), "wb") as f:
        f.write(np.ascontiguousarray(a).tobytes())
    # the scaled export
    with tifffile.TiffFile(half_tif) as t:
        h = t.pages[0].asarray()
        hc = int(t.pages[0].compression)
    hp = np.asarray(Image.open(half_png).convert("RGBA"))
    out["half"] = {"shape": list(h.shape), "compression": hc}
    if h.shape != (200, 320, 4) or hc != 8:
        problems.append("the 50 %% TIFF is %s, compression %d" % (h.shape, hc))
    elif hp.shape == h.shape:
        d = np.abs(hp.astype(int) - h.astype(int))
        soft = hp[..., 3] < 255
        colour = d[..., :3]
        out["half"]["vs_png"] = {"bytes_off": int((d > 0).sum()), "worst": int(d.max())}
        if d[..., 3].max() or colour[~soft].max(initial=0) or colour[soft].max(initial=0) > 1:
            problems.append("the 50 %% TIFF is not the 50 %% PNG: %s" % out["half"]["vs_png"])
    return problems, out


def noise_png(path, w, h):
    """A noise picture of w x h as a PNG (zlib level 1), in bands of rows (document_perf.py's base)."""
    import numpy as np
    from PIL import Image
    rng = np.random.default_rng(7)
    img = Image.new("RGB", (w, h))
    for y in range(0, h, 1000):
        n = min(1000, h - y)
        img.paste(Image.fromarray(rng.integers(0, 256, size=(n, w, 3), dtype=np.uint8), "RGB"), (0, y))
    img.save(path, compress_level=1)
    return os.path.getsize(path)


def tiff_tags(path):
    """The file's layout as tifffile reads it from the tags (no pixels: tifffile reads no LZW without imagecodecs)."""
    import tifffile
    with tifffile.TiffFile(path) as t:
        p = t.pages[0]
        return {"compression": int(p.compression), "predictor": int(p.predictor), "strips": len(p.dataoffsets), "rowsperstrip": int(p.rowsperstrip), "shape": list(p.shape)}


def _build_rgb8_deflate_tiff(w, h, comp, seg, tiled=None):
    """Minimal little-endian RGB8 single-strip or single-tile Deflate TIFF carrying raw compressed bytes `seg`."""
    import struct
    pad = b"\x00" if (len(seg) & 1) else b""
    ifd_at = 8 + len(seg) + len(pad)
    tags = [
        (256, 4, [w]),
        (257, 4, [h]),
        (258, 3, [8, 8, 8]),
        (259, 3, [comp]),
        (262, 3, [2]),
        (277, 3, [3]),
        (284, 3, [1]),
    ]
    if tiled:
        tw, tl = tiled
        tags.extend([(322, 4, [tw]), (323, 4, [tl]), (324, 4, [8]), (325, 4, [len(seg)])])
    else:
        tags.extend([(273, 4, [8]), (278, 4, [h]), (279, 4, [len(seg)])])
    tags.sort(key=lambda t: t[0])
    extra_at = ifd_at + 2 + 12 * len(tags) + 4
    entries = [struct.pack("<H", len(tags))]
    extras = []
    for tag, typ, vals in tags:
        fmt = "<" + ("H" if typ == 3 else "I") * len(vals)
        raw_val = struct.pack(fmt, *vals)
        if len(raw_val) <= 4:
            val_field = raw_val.ljust(4, b"\x00")
        else:
            if extra_at & 1:
                extras.append(b"\x00")
                extra_at += 1
            val_field = struct.pack("<I", extra_at)
            extras.append(raw_val)
            extra_at += len(raw_val)
        entries.append(struct.pack("<HHI", tag, typ, len(vals)) + val_field)
    entries.append(b"\x00\x00\x00\x00")
    return b"II*\x00" + struct.pack("<I", ifd_at) + seg + pad + b"".join(entries) + b"".join(extras)


def deflate_cut_adler_cases():
    """Build >= 1 MiB decoded Deflate TIFFs with Adler-32 cut by 1..4 bytes (K17-band-1) and damaged post-need tail."""
    import zlib
    import numpy as np
    os.makedirs(OUT, exist_ok=True)
    w, h = 1024, 360   # 1,105,920 decoded RGB8 bytes (> 1 MiB; RGBA 1.41 MiB << 64 MiB -> readTiffBand / inflateInto)
    xs = np.arange(w, dtype=np.uint8)[None, :]
    ys = np.arange(h, dtype=np.uint8)[:, None]
    grad = np.empty((h, w, 3), dtype=np.uint8)
    grad[..., 0] = xs
    grad[..., 1] = ys
    grad[..., 2] = (xs.astype(np.uint16) + ys.astype(np.uint16)).astype(np.uint8)
    grad_rgba = np.dstack([grad, np.full((h, w), 255, dtype=np.uint8)])
    grad_exp = os.path.join(OUT, "k17_grad_1m.rgba")
    with open(grad_exp, "wb") as f:
        f.write(grad_rgba.tobytes())
    grad_z = zlib.compress(grad.tobytes(), 6)

    tl = 368
    tile_rgb = np.zeros((tl, w, 3), dtype=np.uint8)
    tile_rgb[:h] = grad
    tile_z = zlib.compress(tile_rgb.tobytes(), 6)

    rng = np.random.default_rng(17)
    noise = rng.integers(0, 256, size=(h, w, 3), dtype=np.uint8)
    noise_rgba = np.dstack([noise, np.full((h, w), 255, dtype=np.uint8)])
    noise_exp = os.path.join(OUT, "k17_noise_1m.rgba")
    with open(noise_exp, "wb") as f:
        f.write(noise_rgba.tobytes())
    noise_z = zlib.compress(noise.tobytes(), 1)

    sw, sh = 64, 32
    small = grad[:sh, :sw].copy()
    small_rgba = grad_rgba[:sh, :sw].copy()
    small_exp = os.path.join(OUT, "k17_small_tail.rgba")
    with open(small_exp, "wb") as f:
        f.write(small_rgba.tobytes())
    co = zlib.compressobj(6)
    tail_z = co.compress(small.tobytes() + b"\x5a" * 262144) + co.flush(zlib.Z_SYNC_FLUSH) + b"\xff" * 8

    specs = [
        ("grad_1m_c8_cut1", w, h, 8, grad_z[:-1], None, grad_exp),
        ("grad_1m_c32946_cut4", w, h, 32946, grad_z[:-4], None, grad_exp),
        ("grad_1m_tile_c8_cut4", w, h, 8, tile_z[:-4], (w, tl), grad_exp),
        ("noise_1m_c8_cut1", w, h, 8, noise_z[:-1], None, noise_exp),
        ("noise_1m_c32946_cut4", w, h, 32946, noise_z[:-4], None, noise_exp),
        ("damaged_tail_256k_c8", sw, sh, 8, tail_z, None, small_exp),
    ]
    out = []
    for name, cw, ch, comp, seg, tiled, exp_path in specs:
        tif_path = os.path.join(OUT, "k17_%s.tif" % name)
        with open(tif_path, "wb") as f:
            f.write(_build_rgb8_deflate_tiff(cw, ch, comp, seg, tiled=tiled))
        out.append({
            "name": name,
            "path": tif_path.replace("\\", "/"),
            "expect": exp_path.replace("\\", "/"),
            "width": cw,
            "height": ch,
            "notes": [],
            "info": {"compression": comp, "tiled": bool(tiled)},
        })
    return out


def measured_rows(h):
    """The 16 rows of K17's sidecar (kept in <stem>_rows16.json so a before tree can share the cached sidecar)."""
    return [min(h - 1, (k * (h - 1)) // 15) for k in range(16)]


def measured_band_rows(h, band_step=256):
    """One deterministic row per 256-row band: y0 + ((b * 17) % rows) (docs/PLAN_WASM_BUILD.md §4.6, K18)."""
    out = []
    for b, y0 in enumerate(range(0, h, band_step)):
        rows = min(band_step, h - y0)
        out.append(y0 + ((b * 17) % rows))
    return out


def photo_files(names):
    """The third-party TIFFs of the photo in OUT, written once from one Pillow-decoded RGB array and reused, and the
    SHA-256 of one row per band and of the whole picture as RGBA (alpha 255), kept in <stem>_rows16.json. Returns (files, known)."""
    stem = os.path.splitext(os.path.basename(IMAGE))[0]
    files = {n: os.path.join(OUT, "%s_%s.tif" % (stem, n)) for n in names}
    side = os.path.join(OUT, "%s_rows16.json" % stem)
    known = None
    if os.path.exists(side):
        with open(side, encoding="utf-8") as f:
            known = json.load(f)
    missing = [n for n in names if not os.path.exists(files[n])]
    if known and "bandRowsSha256" in known and "picSha256" in known and not missing:
        return files, known
    import gc
    import hashlib
    import numpy as np
    import tifffile
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None   # 150 MP is past Pillow's decompression-bomb warning
    t = time.time()
    with Image.open(IMAGE) as im:
        im.load()
        arr = np.asarray(im if im.mode == "RGB" else im.convert("RGB"))
    h, w = arr.shape[:2]
    print("photo decoded by Pillow: %d x %d in %.1f s (%s)" % (w, h, time.time() - t, IMAGE), flush=True)
    rows = measured_rows(h)
    rgba = np.empty((16, w, 4), np.uint8)
    rgba[..., :3] = arr[rows]
    rgba[..., 3] = 255
    band_rows = measured_band_rows(h, 256)
    band_rgba = np.empty((len(band_rows), w, 4), np.uint8)
    band_rgba[..., :3] = arr[band_rows]
    band_rgba[..., 3] = 255
    band_rows_sha = hashlib.sha256(band_rgba.tobytes()).hexdigest()
    band_digests = bytearray()
    slice_rgba = np.empty((256, w, 4), np.uint8)
    slice_rgba[..., 3] = 255
    for y0 in range(0, h, 256):
        n_rows = min(256, h - y0)
        view = slice_rgba[:n_rows]
        view[..., :3] = arr[y0:y0 + n_rows]
        if n_rows < 256:
            view[..., 3] = 255
        band_digests.extend(hashlib.sha256(np.ascontiguousarray(view).tobytes()).digest())
    pic_sha = hashlib.sha256(bytes(band_digests)).hexdigest()
    known = {
        "image": IMAGE,
        "size": [w, h],
        "rows": rows,
        "sha256": hashlib.sha256(rgba.tobytes()).hexdigest(),
        "bandRows": band_rows,
        "bandRowsSha256": band_rows_sha,
        "picSha256": pic_sha,
    }
    with open(side, "w", encoding="utf-8", newline=chr(10)) as f:
        json.dump(known, f, indent=1)
    pim = None
    for n in missing:
        part = files[n][:-4] + ".part.tif"   # written under another name first: a broken run leaves no file to reuse
        t = time.time()
        if n in ("lzw", "packbits"):
            if pim is None:
                pim = Image.fromarray(arr)   # no info: the JPEG's ICC profile stays out of the file
            pim.save(part, format="TIFF", compression="tiff_lzw" if n == "lzw" else "packbits")
        elif n == "raw_strips":
            tifffile.imwrite(part, arr, photometric="rgb", rowsperstrip=16, metadata=None)
        elif n == "zlib1":
            tifffile.imwrite(part, arr, photometric="rgb", compression="zlib", rowsperstrip=h, predictor=False, metadata=None)
        else:
            tifffile.imwrite(part, arr, photometric="rgb", metadata=None)
        os.replace(part, files[n])
        print("%s: %d MB in %.1f s (%s)" % (n, os.path.getsize(files[n]) // 1048576, time.time() - t, files[n]), flush=True)
    del arr, rgba, band_rgba, slice_rgba, pim
    gc.collect()
    return files, known


def variant_line(ok, name, res):
    """One "[ok] variant <name>: {json}" line, not cut (report() cuts at 1500 characters)."""
    print("[%s] variant %s: %s" % ("ok" if ok else "FAIL", name, res if isinstance(res, str) else json.dumps(res, ensure_ascii=False)), flush=True)
    return ok


async def measure(c):
    w, h = (int(v) for v in SIZE.lower().split("x"))
    names = list(VARIANTS) if VARIANT == "all" else [v.strip() for v in VARIANT.split(",") if v.strip()]
    unknown = [v for v in names if v not in VARIANTS]
    if unknown or not names:
        print("[FAIL] --variant %s: not one of %s or all" % (VARIANT, ", ".join(VARIANTS)), flush=True)
        return False
    os.makedirs(OUT, exist_ok=True)
    ok = True
    photo = [v for v in names if v != "noise"]
    if photo and not os.path.exists(IMAGE):
        for v in photo:
            ok = variant_line(False, v, "no photo at %s (--image PATH)" % IMAGE) and ok
        names = [v for v in names if v == "noise"]
    third = [v for v in names if v in THIRD]
    files, known = {}, None
    if third:
        try:
            files, known = photo_files(third)   # written before any open, so no write runs beside one
        except Exception as err:  # noqa: BLE001
            for v in third:
                ok = variant_line(False, v, "writing the third-party files: %s" % str(err)[:600]) and ok
            names = [v for v in names if v not in THIRD]
            third = []
    if "own" in names or third:
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = None
        with Image.open(IMAGE) as im:
            pw, ph = im.size
    hashes = {}
    pic_hashes = {}
    focus_js = "(() => JSON.stringify({ focused: document.hasFocus(), visibility: document.visibilityState }))()"
    for v in names:
        try:
            # a timing row counts only with the window in front (native_test.py and px_jobs.py do the same): each
            # variant's line says whether it was, at its start and at its end
            await c.call("Page.bringToFront")
            focus_start = json.loads(await c.eval(focus_js))
            if v in ("noise", "own"):
                if v == "noise":
                    base = os.path.join(OUT, "noise_%dx%d.png" % (w, h))
                    tif = os.path.join(OUT, "noise_%dx%d.tif" % (w, h))
                    if not os.path.exists(base):
                        t = time.time()
                        size = noise_png(base, w, h)
                        print("noise base: %d MB in %.1f s" % (size // 1048576, time.time() - t), flush=True)
                    vw, vh = w, h
                else:
                    base = IMAGE
                    tif = os.path.join(OUT, "%s_own.tif" % os.path.splitext(os.path.basename(IMAGE))[0])
                    vw, vh = pw, ph
                r = await js(c, MEASURE, timeout=3600, W=str(vw), H=str(vh), BASE=json.dumps(base.replace("\\", "/")), TIF=json.dumps(tif.replace("\\", "/")))
                if v == "own":
                    r["jpgOpenMs"] = r.pop("pngOpenMs")
                mb = os.path.getsize(tif) / 1048576
                vraw = vw * vh * 4 / 1048576
                tags = tiff_tags(tif)
                r.update(file=os.path.basename(tif), fileMB=round(mb), rawMB=round(vraw), exportMBps_raw=round(vraw / max(0.001, r["exportMs"] / 1000)),
                         exportMBps_file=round(mb / max(0.001, r["exportMs"] / 1000)), openMBps_raw=round(vraw / max(0.001, r["openMs"] / 1000)), tifffile=tags)
                good = r["size"] == [vw, vh] and r["baseSize"] == [vw, vh] and r["rowsOff"] == 0 and r.get("picMatch") is True and tags["compression"] == 8
            else:
                tif = files[v]
                r = await js(c, OPEN_VARIANT, timeout=3600, W=str(pw), H=str(ph), TIF=json.dumps(tif.replace("\\", "/")))
                mb = os.path.getsize(tif) / 1048576
                vraw = pw * ph * 4 / 1048576
                as_source = bool(known and r.get("hash") == known.get("bandRowsSha256") and r.get("picHash") == known.get("picSha256"))
                r.update(file=os.path.basename(tif), fileMB=round(mb), rawMB=round(vraw), openMBps_raw=round(vraw / max(0.001, r["openMs"] / 1000)), tifffile=tiff_tags(tif),
                         asSource=as_source)
                good = r["size"] == [pw, ph] and bool(r.get("hash")) and bool(r.get("picHash")) and r.get("alphaOff") == 0 and (not known or as_source)
                if r.get("hash"):
                    hashes[v] = r["hash"]
                if r.get("picHash"):
                    pic_hashes[v] = r["picHash"]
            focus_end = json.loads(await c.eval(focus_js))
            r.update(focusedStart=focus_start["focused"], focusedEnd=focus_end["focused"],
                     focused=bool(focus_start["focused"] and focus_end["focused"]), visibility=focus_end["visibility"])
            ok = variant_line(good, v, r) and ok
        except Exception as err:  # noqa: BLE001
            ok = variant_line(False, v, str(err)[:1500]) and ok
    if len(set(hashes.values())) > 1 or len(set(pic_hashes.values())) > 1:
        ok = report(False, "third-party hashes", "the files of one array give different pixels: rows=%s pic=%s" % (json.dumps(hashes), json.dumps(pic_hashes))) and ok
    elif hashes:
        one_rows = next(iter(hashes.values()))
        one_pic = next(iter(pic_hashes.values())) if pic_hashes else ""
        matched = bool(known and one_rows == known.get("bandRowsSha256") and one_pic == known.get("picSha256"))
        report(True, "third-party hashes", "%d file(s) give one per-band-row hash (%s) and one picture hash (%s); the decoded photo's: %s" % (len(hashes), one_rows[:16], one_pic[:16], matched))
    return ok


async def run_all(c):
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    if SIZE:
        ok = await measure(c)
        print("PASS" if ok else "FAIL")
        return ok
    ok = True
    if "--no-node" not in ARGS:
        try:
            report(True, "node", node_step())
        except Exception as err:  # noqa: BLE001
            ok = report(False, "node", str(err)) and ok
    try:
        entries = fixtures()
    except Exception as err:  # noqa: BLE001
        report(False, "fixtures", str(err))
        print("FAIL")
        return False
    stats = await c.eval("(async () => JSON.stringify(await window.scumble.files.stats()))()")
    store = json.loads(stats)["root"] if stats else None
    at_start = tiffs_in(store) if store else set()
    backend = await c.eval("(async () => { const e = window.__host.editors()[0]; const s = await window.__cmds.commands.run('status', {}).catch(() => null); return s && s.pixels ? s.pixels : (e ? { tiles: !!e.tileMode } : null); })()")
    print("backend: %s, local store: %s" % (json.dumps(backend), store), flush=True)
    by = {e["name"]: e for e in entries}

    # -- opens_every_accepted_fixture (with InpaintEditor.tiffBandRows = 8 so 67x45 fixtures split into 3..6 parallel bands) --
    good, bad = [], []
    worst = {"worstSoft": 0, "worstRaw": 0, "rawOff": 0}
    open_calls = {}
    bands_by_name = {}
    await c.eval("(() => { const e = window.__host.editors()[0]; if (e) e.constructor.tiffBandRows = 8; return 1; })()")
    try:
        for e in (x for x in entries if x["accept"]):
            try:
                r = await js(c, OPEN_ONE, timeout=600, F=json.dumps(e))
                good.append(r["name"])
                bands_by_name[r["name"]] = r.get("bands", 0)
                for k, v in (r.get("pxCalls") or {}).items():
                    open_calls[k] = open_calls.get(k, 0) + v
                for k in worst:
                    worst[k] = max(worst[k], r[k]) if k != "rawOff" else worst[k] + r[k]
                if r["worstRaw"] or e["notes"]:
                    print("  %s: %s" % (e["name"], json.dumps({k: r[k] for k in ("worstSoft", "worstRaw", "rawOff", "soft", "status")}, ensure_ascii=False)), flush=True)
            except Exception as err:  # noqa: BLE001
                bad.append("%s: %s" % (e["name"], str(err)[:500]))
    finally:
        await c.eval("(() => { const e = window.__host.editors()[0]; if (e) e.constructor.tiffBandRows = 0; return 1; })()")
    for req in ("tiff_unpack", "tiff_unpredict", "tiff_to_rgba"):
        if not open_calls.get(req):
            bad.append("missing %s in tiff_band pxCalls: %s" % (req, json.dumps(open_calls)))
    for multi_name, min_bands in (("rgb8_lzw_pred", 6), ("tiled16", 3), ("planar_strips", 6), ("many_strips", 100)):
        if bands_by_name.get(multi_name, 0) < min_bands:
            bad.append("%s ran %d bands, expected >= %d" % (multi_name, bands_by_name.get(multi_name, 0), min_bands))
    multi_count = sum(1 for n_b in bands_by_name.values() if n_b >= 2)
    ok = report(not bad, "opens_every_accepted_fixture", " || ".join(bad) if bad else {"fixtures": len(good), "multiBand": multi_count, **worst, "pxCalls": open_calls}) and ok

    # -- refuses_with_a_message --
    before = tiffs_in(store) if store else set()
    good, bad = [], []
    for e in (x for x in entries if not x["accept"]):
        if e["name"] == "not_tiff":
            continue   # a PNG named .tif: the app goes by the bytes (NAMED_TIF below); readTiff alone refuses it (node step)
        try:
            r = await js(c, REFUSE_ONE, F=json.dumps(e))
            good.append("%s: %s" % (e["name"], r["message"][:90]))
        except Exception as err:  # noqa: BLE001
            bad.append("%s: %s" % (e["name"], str(err)[:400]))
    try:
        kept = await js(c, REFUSE_KEEPS, F=json.dumps(by["cmyk"]))
    except Exception as err:  # noqa: BLE001
        bad.append("a refusal on a tab with a picture: %s" % err)
        kept = None
    try:
        junk = os.path.join(OUT, "junk_named.tif")
        with open(junk, "wb") as f:
            f.write(b"this is no picture at all, only a name that says TIFF\n" * 20)
        named = await js(c, NAMED_TIF, F=json.dumps(by["not_tiff"]), JUNK=json.dumps(junk.replace("\\", "/")))
        good.append("named .tif: %s" % json.dumps(named)[:200])
    except Exception as err:  # noqa: BLE001
        bad.append("a file named .tif that is none: %s" % str(err)[:400])
    if store:
        new = sorted(tiffs_in(store) - before)
        if new:
            bad.append("TIFF files came into the local store: %s" % new[:5])
    ok = report(not bad, "refuses_with_a_message", " || ".join(bad) if bad else {"refused": good, "kept": kept, "store": "checked" if store else "not found, skipped"}) and ok

    # -- adds_a_tiff_as_a_layer --
    try:
        ok = report(True, "adds_a_tiff_as_a_layer", await js(c, LAYER, F=json.dumps(by["rgba16"]))) and ok
    except Exception as err:  # noqa: BLE001
        ok = report(False, "adds_a_tiff_as_a_layer", str(err)) and ok

    # -- exports_tiff_and_reads_it_back, exports_tiff_at_a_size --
    names = {"TIF": "x.tif", "TIFJS": "x_js.tif", "PNG": "x.png", "TIF50": "x_50.tif", "PNG50": "x_50.png"}
    for f in names.values():
        try:
            os.remove(os.path.join(OUT, f))
        except OSError:
            pass
    try:
        built = await js(c, EXPORT_BUILD, timeout=600, **{k: P(v) for k, v in names.items()})
        problems, info = python_reads(*(os.path.join(OUT, names[k]) for k in ("TIF", "PNG", "TIF50", "PNG50")), exact=bool(built.get("tiles", True)))
        full = [p for p in problems if "50 %" not in p]
        half = [p for p in problems if "50 %" in p]
        if not full:
            reopened = await js(c, EXPORT_REOPEN, TIF=P("x.tif"), RGBA=P("x_tif.rgba"))
            ok = report(True, "exports_tiff_and_reads_it_back", {"export": built["tif"], "ms": built["tifMs"], "tiles": built["tiles"], "composeWasm": built["composeWasm"], "predCalls": built["predCalls"], "defCalls": built["defCalls"], "jsRouteBytesEqual": built["jsRouteBytesEqual"], "python": {k: info[k] for k in ("shape", "compression", "predictor", "extrasamples", "software", "png_alpha", "vs_png") if k in info}, "reopened": reopened}) and ok
        else:
            ok = report(False, "exports_tiff_and_reads_it_back", " | ".join(full)) and ok
        ok = report(not half, "exports_tiff_at_a_size", " | ".join(half) if half else {"export": built["half"], "python": info.get("half")}) and ok
    except Exception as err:  # noqa: BLE001
        ok = report(False, "exports_tiff_and_reads_it_back", str(err)) and ok
    finally:
        try:
            await js(c, EXPORT_CLOSE)
        except Exception:  # noqa: BLE001
            pass

    # -- a_tif_drop_opens --
    try:
        r = await js(c, DROP, F=json.dumps(by["rgb8_lzw"]), G=json.dumps(by["tiled32x48"]))
        if r and r.get("skipped"):
            print("[ok] a_tif_drop_opens: skipped (%s); drops are exercised by the editor gate" % r["skipped"], flush=True)
        else:
            ok = report(True, "a_tif_drop_opens", r) and ok
    except Exception as err:  # noqa: BLE001
        ok = report(False, "a_tif_drop_opens", str(err)) and ok

    # -- deflate_cut_adler_and_damaged_tail_open (K17-band-1, real Chromium DecompressionStream) --
    cut_good, cut_bad = [], []
    try:
        for e in deflate_cut_adler_cases():
            try:
                r = await js(c, OPEN_ONE, timeout=600, F=json.dumps(e))
                cut_good.append(r["name"])
            except Exception as err:  # noqa: BLE001
                cut_bad.append("%s: %s" % (e["name"], str(err)[:400]))
    except Exception as err:  # noqa: BLE001
        cut_bad.append("building cases: %s" % str(err)[:400])
    ok = report(not cut_bad, "deflate_cut_adler_and_damaged_tail_open", " || ".join(cut_bad) if cut_bad else {"opened": cut_good}) and ok

    # -- parallel_bands_priority_cancel_and_fallback (K18) --
    try:
        pb = await js(
            c,
            PARALLEL_BANDS,
            timeout=600,
            PLANAR=json.dumps(by["planar_strips"]),
            PAL=json.dumps(by["palette4"]),
            LZW=json.dumps(by["rgb8_lzw_pred"]),
            TRUNC=json.dumps(by["truncated"]),
        )
        ok = report(True, "parallel_bands_priority_cancel_and_fallback", pb) and ok
    except Exception as err:  # noqa: BLE001
        ok = report(False, "parallel_bands_priority_cancel_and_fallback", str(err)[:900]) and ok

    # -- no_tiff_in_the_local_store --
    if store:
        new = sorted(tiffs_in(store) - at_start)
        ok = report(not new, "no_tiff_in_the_local_store", ("TIFF files in the local store: %s" % new[:8]) if new else {"root": store}) and ok
    else:
        print("[ok] no_tiff_in_the_local_store: skipped (window.scumble.files.stats() named no root)", flush=True)

    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
