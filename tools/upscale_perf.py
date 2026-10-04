"""The whole picture on a ComfyUI upscaler at size (docs/PLAN_0_1_42.md U2, "15k measurement"), against the running app.

    python tools/upscale_perf.py [7680x4320] [--factor 2] --profile DIR [--out DIR]

Start the app first on a fresh profile (`bash tools/run_gates.sh <label> --offline --tiles on|off upscaleperf:7680x4320`
does it and passes the profile; benchmark hygiene: one row per fresh instance). The answer ComfyUI would give, the
base at `factor` times its size (a gradient with a little noise, PNG at zlib level 1 as ComfyUI's PreviewImage writes
it), is written here into the profile's mirror (files/input/inpaint_canvas), so /view serves it as it serves a picture
fetched from the server. A base of W x H with two full-size paint layers is built in a new tab, the server is stood in
for in the page (the queue answers the stored picture at once; nothing reaches a server), and host.runComfyUpscale runs
on a copy of the RTX Video Super Resolution recipe without its size limits (a 7680 px picture is past every shipped
upscaler's input cap: this measures the route, not a recipe). Recorded: the time until the prompt is queued (the base
drawn, encoded and stored), the landing (landWholePicture: the answer decoded, drawn, resizeImage with the layers and
the selection, its upload of the new base), the whole call, and the peak private bytes of the renderer, the GPU process
and all of Scumble's processes during the landing (window.scumble.metrics every 200 ms) against before. A measurement,
not a pass mark: PASS means the landing happened at the expected size.
"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]


def opt(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


SIZE = ARGS[0] if ARGS else "7680x4320"
W, H = (int(v) for v in SIZE.lower().split("x"))
FACTOR = int(opt("--factor", "2"))
PROFILE = opt("--profile")
OUT = opt("--out", os.path.join(os.environ.get("SCUMBLE_GATES", os.path.join(os.path.dirname(__file__), "..", "dist", "gates")), "upscaleperf"))
NAME = f"u2perf_answer_{W * FACTOR}x{H * FACTOR}.png"


def answer_png(path, w, h):
    """A gradient with a little noise at w x h (zlib level 1, as PreviewImage writes), in bands to keep memory down."""
    import numpy as np
    from PIL import Image
    rng = np.random.default_rng(11)
    img = Image.new("RGB", (w, h))
    xs = (np.arange(w, dtype=np.float32) * 255.0 / max(1, w - 1))
    step = 512
    for y in range(0, h, step):
        bh = min(step, h - y)
        ys = (np.arange(y, y + bh, dtype=np.float32) * 255.0 / max(1, h - 1))[:, None]
        band = np.empty((bh, w, 3), dtype=np.float32)
        band[..., 0] = xs[None, :]
        band[..., 1] = ys
        band[..., 2] = 255.0 - xs[None, :] * 0.5 - ys * 0.5
        band += rng.integers(-6, 7, size=(bh, w, 3)).astype(np.float32)
        img.paste(Image.fromarray(np.clip(band, 0, 255).astype(np.uint8), "RGB"), (0, y))
    img.save(path, compress_level=1)
    return os.path.getsize(path)


RUN = r"""
(async () => {
    const W = __W__, H = __H__, F = __F__, NAME = __NAME__;
    const shell = await import("./shell.js");
    const { host, api } = await import("./editor/host.js");
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ed = shell.newDocument(); shell.activate(ed);
    await wait(300);
    const r0 = await shell.commands.call("new_canvas", { doc: ed.node.id, width: W, height: H });
    if (!r0.ok) throw new Error("new_canvas: " + r0.error);
    for (let i = 0; i < 600 && (ed._loading || !ed.base); i++) await wait(100);
    const { Layer } = ed.pixels;
    for (let i = 0; i < 2; i++) {
        const c = document.createElement("canvas"); c.width = W; c.height = H;
        const x = c.getContext("2d");
        x.fillStyle = `hsla(${i * 120},80%,50%,0.35)`;
        x.fillRect(i * 60, i * 60, W - i * 180, H - i * 180);
        ed.addLayer({ name: `Paint ${i + 1}`, kind: "paint", px: Layer.fromCanvas(c), x: 0, y: 0, w: W, h: H, dirty: true });
        if (ed.tileMode) c.width = c.height = 1;
    }
    await shell.commands.call("select_rect", { doc: ed.node.id, x: Math.round(W / 4), y: Math.round(H / 4), w: Math.round(W / 3), h: Math.round(H / 3) });
    await host.flushEditor(ed);
    if (ed.mipsSettled) await ed.mipsSettled();
    await wait(1500);
    // the server stood in for: the queue answers the stored picture, nothing reaches a server
    const nodeInfo = () => ({ input: { required: {} } });
    const saved = { connected: host.connected, objectInfo: host.objectInfo, server: { ...(host.server || {}) }, ensureRefs: host.ensureRefs, queue: api.queuePrompt, land: host.landWholePicture, recipe: host.recipe };
    const T = { queuedAt: 0, landStart: 0, landEnd: 0 };
    const ANS = { filename: NAME, subfolder: "inpaint_canvas", type: "input" };
    const sample = async () => {
        const m = await window.scumble.metrics();
        let total = 0, gpu = 0, rend = 0;
        for (const p of m.processes || []) {
            const kb = p.privateKB || p.workingSetKB || 0;
            total += kb;
            if (p.type === "GPU") gpu += kb;
            if (p.type === "Tab" || p.type === "renderer" || p.type === "Renderer") rend = Math.max(rend, kb);
        }
        const rp = m.renderer && m.renderer.process;
        if (rp && rp.private) rend = rp.private;
        return { total, gpu, rend };
    };
    const base = await sample();
    const peak = { ...base };
    let sampling = false;
    const iv = setInterval(async () => {
        if (!sampling) return;
        try { const s = await sample(); for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], s[k]); } catch (_) { /* a sample lost */ }
    }, 200);
    let out = null, err = null;
    const t0 = performance.now();
    try {
        host.connected = true;
        host.objectInfo = { InpaintCanvasLoadRef: nodeInfo(), ImageFromBatch: nodeInfo(), RTXVideoSuperResolution: nodeInfo(), PreviewImage: nodeInfo(), InpaintCanvas: nodeInfo() };
        host.setServerStatus({ state: "connected", os: "win32", gpus: ["cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync"], url: "http://127.0.0.1:8188", version: "0.38.0" });
        host.ensureRefs = async () => ({ checked: 0, uploaded: [], missing: [] });
        api.queuePrompt = async () => {
            T.queuedAt = performance.now();
            setTimeout(() => api.dispatch("executed", { prompt_id: "u2perf", node: "scumble_out", output: { images: [ANS] } }), 50);
            return { prompt_id: "u2perf" };
        };
        host.landWholePicture = async function (...a) {
            sampling = true; T.landStart = performance.now();
            try { return await saved.land.apply(this, a); } finally { T.landEnd = performance.now(); }
        };
        const rtx = host.shell.recipes().find((r) => r.id === "rtx_vsr_local");
        const r = JSON.parse(JSON.stringify(rtx));
        delete r.limits;
        r.id = "rtx_vsr_perf"; r.name = "RTX Video Super Resolution (measurement)";
        host.setRecipe(r);
        out = await host.runComfyUpscale(ed, { factor: F });
        await wait(1000);
        if (ed.tileMode && ed.mipsSettled) await ed.mipsSettled();
    } catch (e) { err = String((e && e.message) || e); }
    const total = performance.now() - t0;
    sampling = false;
    clearInterval(iv);
    const after = await sample();
    host.connected = saved.connected; host.objectInfo = saved.objectInfo; host.ensureRefs = saved.ensureRefs; api.queuePrompt = saved.queue; host.landWholePicture = saved.land;
    host.setServerStatus({ state: saved.server.state || "disconnected", os: saved.server.os || "", gpus: saved.server.gpus || [], remote: !!saved.server.remote, url: saved.server.url || "", version: saved.server.version || "" });
    host.setRecipe(saved.recipe);
    const mb = (kb) => Math.round(kb / 1024);
    return {
        tiles: !!ed.tileMode, err, out, size: [ed.width, ed.height], layers: ed.layers.length, undo: ed.undo.length,
        queuedMs: Math.round(T.queuedAt - t0), landMs: Math.round(T.landEnd - T.landStart), totalMs: Math.round(total),
        mbBefore: { total: mb(base.total), renderer: mb(base.rend), gpu: mb(base.gpu) },
        mbPeak: { total: mb(peak.total), renderer: mb(peak.rend), gpu: mb(peak.gpu) },
        mbAfter: { total: mb(after.total), renderer: mb(after.rend), gpu: mb(after.gpu) },
        status: ed.status,
    };
})()
"""


async def run(c):
    if not PROFILE:
        print("--profile is needed (the instance's --user-data-dir: the answer goes into its mirror)")
        print("FAIL")
        return False
    os.makedirs(OUT, exist_ok=True)
    dst_dir = os.path.join(PROFILE, "files", "input", "inpaint_canvas")
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, NAME)
    t = time.time()
    size = answer_png(dst, W * FACTOR, H * FACTOR)
    print(f"answer: {W * FACTOR} x {H * FACTOR}, {size / 1048576:.0f} MB in {time.time() - t:.1f} s", flush=True)
    res = await c.eval(RUN.replace("__W__", str(W)).replace("__H__", str(H)).replace("__F__", str(FACTOR)).replace("__NAME__", json.dumps(NAME)), timeout=3000)
    print("row:", json.dumps(res, ensure_ascii=False), flush=True)
    ok = not res.get("err") and res.get("size") == [W * FACTOR, H * FACTOR]
    print("PASS" if ok else "FAIL", flush=True)
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run)) else 1)
