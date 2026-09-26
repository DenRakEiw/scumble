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
- no_tiff_in_the_local_store: no .tif or .tiff file came into the local store during the gate.

    python tools/tiff_test.py [--out DIR] [--no-node]
    python tools/tiff_test.py --size 15000x10000 [--out DIR]    the 15k measurement alone (not in the default run):
        a noise picture (a PNG written here, like document_perf.py's) opened, exported as TIFF and opened again; the
        export and open times, the file size and MB/s

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
host.shell.activate(ed);
try {
    let err = null;
    const t0 = performance.now();
    try { await run("load_image", { doc: d.id, path: F.path }); } catch (e) { err = String(e.message || e); }
    const ms = Math.round(performance.now() - t0);
    if (err) throw new Error("load_image: " + err);
    if (ed.width !== F.width || ed.height !== F.height) throw new Error(`opened as ${ed.width} x ${ed.height}`);
    const got = ed.basePx.readRect(0, 0, F.width, F.height).data;
    const c = compare(got, await readBytes(F.expect), F.width);
    const status = ed.status || "";
    const problems = [];
    if (!c.ok) problems.push(says(c));
    const missing = F.notes.filter((n) => !status.toLowerCase().includes(n.toLowerCase()));
    if (missing.length) problems.push(`the status line does not mention ${missing.join(", ")}: "${status}"`);
    if (isTifRef(ed.base && ed.base.ref)) problems.push("the base is stored as the TIFF itself: " + ed.base.ref.filename);
    if (ed.undo && ed.undo.length) problems.push("opening left " + ed.undo.length + " undo steps");
    if (problems.length) throw new Error(problems.join(" | "));
    return { name: F.name, ms, soft: c.soft, worstSoft: c.worstSoft, worstRaw: c.worstRaw, rawOff: c.rawOff, ref: ed.base.ref.filename, status };
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
host.shell.activate(ed);
try {
    await run("new_canvas", { doc: d.id, width: 200, height: 150 });
    const n = ed.layers.length;
    const r = await run("add_image_layer", { doc: d.id, path: F.path });
    if (ed.layers.length !== n + 1) throw new Error(`${ed.layers.length - n} layers added: ${ed.status}`);
    const l = ed.layers[ed.layers.length - 1];
    const problems = [];
    if (l.kind !== "image") problems.push("the layer is a " + l.kind);
    if (l.w !== F.width || l.h !== F.height || l.px.width !== F.width || l.px.height !== F.height) problems.push(`the layer is ${l.w} x ${l.h} (pixels ${l.px.width} x ${l.px.height}), not ${F.width} x ${F.height}`);
    const c = compare(l.px.readRect(0, 0, F.width, F.height).data, await readBytes(F.expect), F.width);
    if (!c.ok) problems.push(says(c));
    if (isTifRef(l.ref)) problems.push("the layer is stored as the TIFF itself: " + l.ref.filename);
    await ed.syncLayers();
    if (!l.ref || isTifRef(l.ref)) problems.push("after syncLayers the layer's file is " + JSON.stringify(l.ref));
    if (problems.length) throw new Error(problems.join(" | "));
    return { layer: r.name || l.name, size: `${l.w} x ${l.h}`, soft: c.soft, worstSoft: c.worstSoft, worstRaw: c.worstRaw, ref: l.ref.filename, status: ed.status };
} finally { await run("close_document", { doc: d.id }); }
"""

EXPORT_BUILD = r"""
const d = await run("new_document");
window.__tx = { doc: d.id };
const ed = ednow(d.id);
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
const t0 = performance.now();
const tif = await run("export", { doc: d.id, format: "tiff", path: __TIF__ });
const tifMs = Math.round(performance.now() - t0);
const png = await run("export", { doc: d.id, format: "png", path: __PNG__ });
const half = await run("export", { doc: d.id, format: "tiff", scale: 50, path: __TIF50__ });
const halfPng = await run("export", { doc: d.id, format: "png", scale: 50, path: __PNG50__ });
return { tiles: !!ed.tileMode, tif: tif.status, tifMs, png: png.status, half: half.status, halfPng: halfPng.status };
"""

EXPORT_REOPEN = r"""
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
try {
    await run("load_image", { doc: d.id, path: __TIF__ });
    if (ed.width !== 640 || ed.height !== 400) throw new Error(`reopened as ${ed.width} x ${ed.height}`);
    const c = compare(ed.basePx.readRect(0, 0, 640, 400).data, await readBytes(__RGBA__), 640);
    if (!c.ok) throw new Error("the reopened TIFF against the PNG: " + says(c));
    return { soft: c.soft, worstSoft: c.worstSoft, worstRaw: c.worstRaw, rawOff: c.rawOff, status: ed.status };
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

MEASURE = r"""
const W = __W__, H = __H__;
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const settle = async (e) => { for (let i = 0; i < 1200 && (e._loading || !e.base); i++) await wait(100); if (e.mipsSettled) await e.mipsSettled(); };
const t0 = performance.now();
await run("load_image", { doc: d.id, path: __BASE__ });
await settle(ed);
const pngOpenMs = performance.now() - t0;
const t1 = performance.now();
const ex = await run("export", { doc: d.id, format: "tiff", path: __TIF__ });
const exportMs = performance.now() - t1;
const d2 = await run("new_document");
const ed2 = ednow(d2.id);
host.shell.activate(ed2);
const t2 = performance.now();
await run("load_image", { doc: d2.id, path: __TIF__ });
await settle(ed2);
const openMs = performance.now() - t2;
// sixteen rows compared byte for byte (the noise is opaque)
let rowsOff = 0;
for (let k = 0; k < 16; k++) {
    const y = Math.min(H - 1, Math.floor((k * (H - 1)) / 15));
    const a = ed.basePx.readRect(0, y, W, 1).data, b = ed2.basePx.readRect(0, y, W, 1).data;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { rowsOff++; break; }
}
const tiles = !!ed.tileMode, size = [ed2.width, ed2.height], status = ed2.status;
await run("close_document", { doc: d2.id });
await run("close_document", { doc: d.id });
return { tiles, pngOpenMs: Math.round(pngOpenMs), exportMs: Math.round(exportMs), openMs: Math.round(openMs), size, rowsOff, exportStatus: ex.status, openStatus: status };
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


async def measure(c):
    w, h = (int(v) for v in SIZE.lower().split("x"))
    os.makedirs(OUT, exist_ok=True)
    base = os.path.join(OUT, "noise_%dx%d.png" % (w, h))
    tif = os.path.join(OUT, "noise_%dx%d.tif" % (w, h))
    if not os.path.exists(base):
        t = time.time()
        size = noise_png(base, w, h)
        print("noise base: %d MB in %.1f s" % (size // 1048576, time.time() - t), flush=True)
    r = await js(c, MEASURE, timeout=3600, W=str(w), H=str(h), BASE=json.dumps(base.replace("\\", "/")), TIF=json.dumps(tif.replace("\\", "/")))
    mb = os.path.getsize(tif) / 1048576
    raw = w * h * 4 / 1048576
    import tifffile
    with tifffile.TiffFile(tif) as t:
        p = t.pages[0]
        tags = {"compression": int(p.compression), "predictor": int(p.predictor), "strips": len(p.dataoffsets), "shape": list(p.shape)}
    r.update(fileMB=round(mb), rawMB=round(raw), exportMBps_raw=round(raw / max(0.001, r["exportMs"] / 1000)), exportMBps_file=round(mb / max(0.001, r["exportMs"] / 1000)),
             openMBps_raw=round(raw / max(0.001, r["openMs"] / 1000)), tifffile=tags)
    ok = r["size"] == [w, h] and r["rowsOff"] == 0 and tags["compression"] == 8
    report(ok, "size %dx%d" % (w, h), r)
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

    # -- opens_every_accepted_fixture --
    good, bad = [], []
    worst = {"worstSoft": 0, "worstRaw": 0, "rawOff": 0}
    for e in (x for x in entries if x["accept"]):
        try:
            r = await js(c, OPEN_ONE, timeout=600, F=json.dumps(e))
            good.append(r["name"])
            for k in worst:
                worst[k] = max(worst[k], r[k]) if k != "rawOff" else worst[k] + r[k]
            if r["worstRaw"] or e["notes"]:
                print("  %s: %s" % (e["name"], json.dumps({k: r[k] for k in ("worstSoft", "worstRaw", "rawOff", "soft", "status")}, ensure_ascii=False)), flush=True)
        except Exception as err:  # noqa: BLE001
            bad.append("%s: %s" % (e["name"], str(err)[:500]))
    ok = report(not bad, "opens_every_accepted_fixture", " || ".join(bad) if bad else {"fixtures": len(good), **worst}) and ok

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
    names = {"TIF": "x.tif", "PNG": "x.png", "TIF50": "x_50.tif", "PNG50": "x_50.png"}
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
            ok = report(True, "exports_tiff_and_reads_it_back", {"export": built["tif"], "ms": built["tifMs"], "tiles": built["tiles"], "python": {k: info[k] for k in ("shape", "compression", "predictor", "extrasamples", "software", "png_alpha", "vs_png") if k in info}, "reopened": reopened}) and ok
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
