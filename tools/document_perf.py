""".scumble documents at size (docs/PLAN_DOCUMENTS.md §7 D5, "The 15k measurement"), against the running app.

    python tools/document_perf.py [15000x10000] [--out DIR]

Start the app first (tools/cdp.py; `tools/run_gates.sh <label> --offline --tiles on|off docperf:15000x10000` does it
on a fresh profile). A base of noise written here as a PNG (so the file is as large as a photo's, larger) is loaded
with load_image, then three full-size paint layers with shapes and a filter layer go on top, as perf_test.py builds
its stack. Recorded: the flush (the dirty layers uploaded) and the write separately, the file's size and MB/s, a
second Ctrl+S with nothing changed, the open of the file in a new tab (the mirror files' CRCs read, nothing copied,
the restore until settled) against the restore of the same state alone, the main process's private bytes during the
save, and Python's zipfile reading the whole file (testzip). Expected (§4.1), believed only as measured: a clean save
at disk speed plus under a second of work; the open within 10 % of the restore plus the CRC read.
"""
import asyncio
import json
import os
import sys
import time
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
SIZE = ARGS[0] if ARGS else "15000x10000"
W, H = (int(v) for v in SIZE.lower().split("x"))
OUT = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else os.path.join(os.environ.get("SCUMBLE_GATES", os.path.join(os.path.dirname(__file__), "..", "dist", "gates")), "docperf")


def noise_png(path):
    """A noise base of W x H as a PNG (zlib level 1: noise does not compress, the time goes to the write)."""
    import numpy as np
    from PIL import Image
    rng = np.random.default_rng(7)
    rows = []
    step = 1000
    img = Image.new("RGB", (W, H))
    for y in range(0, H, step):
        h = min(step, H - y)
        band = rng.integers(0, 256, size=(h, W, 3), dtype=np.uint8)
        img.paste(Image.fromarray(band, "RGB"), (0, y))
        rows.append(h)
    img.save(path, compress_level=1)
    return os.path.getsize(path)


BUILD = r"""
(async () => {
    const W = __W__, H = __H__;
    const shell = await import("./shell.js");
    const { host } = await import("./editor/host.js");
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ed = shell.newDocument(); shell.activate(ed);
    await wait(300);
    const t0 = performance.now();
    const r = await shell.commands.call("load_image", { doc: ed.node.id, path: __BASE__ });
    if (!r.ok) throw new Error("load_image: " + r.error);
    for (let i = 0; i < 600 && (ed._loading || !ed.base); i++) await wait(100);
    await host.flushEditor(ed);
    const loadMs = performance.now() - t0;
    const { Layer } = ed.pixels;
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    for (let i = 0; i < 3; i++) {
        const c = mk(W, H);
        const x = c.getContext("2d");
        x.fillStyle = `hsla(${i * 60},80%,50%,0.35)`;
        x.fillRect(i * 40, i * 40, W - i * 120, H - i * 120);
        for (let k = 0; k < 40; k++) {
            x.fillStyle = `hsl(${(k * 53 + i * 90) % 360},70%,60%)`;
            x.beginPath(); x.arc((k * 811) % W, (k * 457) % H, W / 30, 0, Math.PI * 2); x.fill();
        }
        ed.addLayer({ name: `Paint ${i + 1}`, kind: "paint", px: Layer.fromCanvas(c), x: 0, y: 0, w: W, h: H, dirty: true });
        if (ed.tileMode) c.width = c.height = 1;    // tiles copied the pixels; the canvas backend keeps this canvas as the layer
    }
    ed.addFilterLayer("curves");
    ed.renderLayers(); ed.fitView(); ed.draw();
    if (ed.mipsSettled) await ed.mipsSettled();
    window.__docperf = ed;
    return { loadMs: Math.round(loadMs), layers: ed.layers.length, tiles: !!ed.tileMode };
})()
"""

SAVE = r"""
(async () => {
    const { host } = await import("./editor/host.js");
    const ed = window.__docperf;
    const shell = await import("./shell.js");
    const t0 = performance.now();
    await host.flushEditor(ed);
    const t1 = performance.now();
    const r = await host.saveDocument(ed, { path: __PATH__, history: true });
    const t2 = performance.now();
    const again0 = performance.now();
    const r2 = await host.saveDocument(ed, {});
    const again = performance.now() - again0;
    // a selection changed right before a save with nothing else to upload: above 16 MP its PNG is encoded in the
    // background, and the save has to wait for it (flushEditor), or the file keeps the selection of before
    await shell.commands.call("select_rect", { doc: ed.node.id, x: 1000, y: 800, w: Math.round(ed.width * 0.4), h: Math.round(ed.height * 0.3) });
    const selBefore = (await shell.commands.call("status", { doc: ed.node.id })).result.selection;
    const sel0 = performance.now();
    await host.saveDocument(ed, {});
    const selSaveMs = Math.round(performance.now() - sel0);
    return { flushMs: Math.round(t1 - t0), saveMs: Math.round(t2 - t1), writeMs: r.ms, bytes: r.bytes, entries: r.entries, cleanSaveMs: Math.round(again), cleanWriteMs: r2.ms, selBefore, selSaveMs, state: ed.getValue() };
})()
"""

OPEN = r"""
(async () => {
    const shell = await import("./shell.js");
    const { host } = await import("./editor/host.js");
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const settle = async (ed) => { for (let i = 0; i < 1200 && (ed._loading || !ed.base); i++) await wait(100); if (ed.mipsSettled) await ed.mipsSettled(); };
    const old = window.__docperf;
    const state = old.getValue();
    await shell.closeDocument(old, { force: true });
    // the restore of the same state alone, in a new tab (what the autosave restore does)
    const id = host.nextId++;
    const a0 = performance.now();
    await host.restore(JSON.stringify({ version: 2, active: id, nextId: host.nextId, docs: [{ id, state }] }));
    const r1 = host.editorById(id);
    await settle(r1);
    const restoreMs = performance.now() - a0;
    await shell.closeDocument(r1, { force: true });
    await wait(500);
    const b0 = performance.now();
    const o = await host.openDocument(__PATH__);
    await settle(o.editor);
    const openMs = performance.now() - b0;
    const same = JSON.stringify(JSON.parse(o.editor.getValue()).layers.map((l) => l.ref && l.ref.filename)) === JSON.stringify(JSON.parse(state).layers.map((l) => l.ref && l.ref.filename));
    const selAfter = (await shell.commands.call("status", { doc: o.editor.node.id })).result.selection;
    return { restoreMs: Math.round(restoreMs), openMs: Math.round(openMs), sameRefs: same, dirty: host.documentDirty(o.editor), selAfter };
})()
"""


async def main_proc_kb(c):
    m = await c.eval("(async () => JSON.stringify(await window.scumble.metrics()))()")
    procs = json.loads(m)["processes"]
    browser = [p for p in procs if p.get("type") == "Browser"]
    return (browser[0].get("privateKB") or browser[0].get("workingSetKB") or 0) if browser else 0


async def run(c):
    os.makedirs(OUT, exist_ok=True)
    base = os.path.join(OUT, f"noise_{W}x{H}.png").replace("\\", "/")
    doc = os.path.join(OUT, f"doc_{W}x{H}.scumble").replace("\\", "/")
    t = time.time()
    if not os.path.exists(base):
        size = noise_png(base)
        print(f"noise base: {size / 1048576:.0f} MB in {time.time() - t:.1f} s", flush=True)
    built = await c.eval(BUILD.replace("__W__", str(W)).replace("__H__", str(H)).replace("__BASE__", json.dumps(base)), timeout=1800)
    print("built:", json.dumps(built), flush=True)
    # the main process's private bytes while the save runs (a second CDP connection is not needed: poll between steps)
    before_kb = await main_proc_kb(c)
    peak = {"kb": before_kb}
    stop = asyncio.Event()

    async def poll():
        from cdp import page_ws, Cdp
        import aiohttp
        async with aiohttp.ClientSession() as s:
            async with s.ws_connect(await page_ws(), max_msg_size=64 * 1024 * 1024) as ws:
                c2 = Cdp(ws)
                while not stop.is_set():
                    try:
                        peak["kb"] = max(peak["kb"], await main_proc_kb(c2))
                    except Exception:  # noqa: BLE001
                        pass
                    await asyncio.sleep(0.2)

    poller = asyncio.create_task(poll())
    saved = await c.eval(SAVE.replace("__PATH__", json.dumps(doc)), timeout=1800)
    stop.set()
    await poller
    saved.pop("state", None)
    mb = saved["bytes"] / 1048576
    print("save:", json.dumps({**saved, "MB": round(mb), "MBps_write": round(mb / max(0.001, saved["writeMs"] / 1000)), "mainPrivateMB_before": round(before_kb / 1024), "mainPrivateMB_peak": round(peak["kb"] / 1024)}), flush=True)
    t = time.time()
    with zipfile.ZipFile(doc) as z:
        bad = z.testzip()
        first = z.infolist()[0]
        ok_zip = bad is None and first.filename == "mimetype" and first.compress_type == zipfile.ZIP_STORED
    print(f"zipfile: testzip {'clean' if bad is None else 'BAD ' + bad}, mimetype first and stored: {ok_zip}, {time.time() - t:.1f} s", flush=True)
    opened = await c.eval(OPEN.replace("__PATH__", json.dumps(doc)), timeout=1800)
    print("open:", json.dumps(opened), flush=True)
    same_sel = json.dumps(saved.get("selBefore"), sort_keys=True) == json.dumps(opened.get("selAfter"), sort_keys=True)
    print(f"selection changed right before the save came back: {same_sel} ({saved.get('selBefore')} -> {opened.get('selAfter')})", flush=True)
    ok = ok_zip and opened.get("sameRefs") and not opened.get("dirty") and same_sel
    print("PASS" if ok else "FAIL", flush=True)
    return ok


if __name__ == "__main__":
    ok = asyncio.run(session(run))
    sys.exit(0 if ok else 1)
