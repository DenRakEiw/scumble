"""The in-app helper models in their own process (U1, docs/PLAN_HELPERS_PROCESS.md §3.8), against the running app.

    python tools/helpers_test.py [--models-dir DIR] [--app-models DIR] [--node-only]

First `node tools/helpers_test.js DIR --also APP --process` in plain Node (the process's answers byte for byte the
main-thread engine's, the kill, the deaths, the fallback, the idle unload). Then in the app (run it --offline): the
helpers folder set to DIR (read only: the user's ComfyUI models folder, whose onnx/ holds SAM2 tiny and RMBG-1.4; a
scan links what it finds, nothing is downloaded), and
  - the object map through helpers:objects on a cold process: the helpers' process up (its pid in helpers:status and
    in the app's metrics as "Scumble helpers"), the renderer's IPC round trips during it short (main never blocked:
    before U1 the first SAM2 call held main about a second, a map 0.2 s sixteen times);
  - the editor's own paths through it: the hover tool's map (ensureObjects), select_point on a shape, cutout_layer on
    a layer;
  - Free VRAM: the process gone; the next point (host.segmentLogits sends the picture again) starts a new one;
  - Free VRAM during an object map (the free a local Generate does): the map still lands, the process ends after it,
    a point sent meanwhile goes to a new process;
  - the device switch to CPU: the process ends, the next answer's provider is the CPU.
The folder, the models and the device are put back at the end. Skipped (PASS with a note) where DIR has no SAM2 tiny.
It holds the machine's busy lock while it runs (it loads SAM2 on the GPU and times IPC round trips), waiting at most
5 minutes for it; tools/run_gates_both.sh runs it serially.
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def _arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


MODELS = _arg("--models-dir", r"F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\models")
APP_MODELS = _arg("--app-models", os.path.join(os.environ.get("APPDATA", ""), "Scumble", "models"))
RTT_MAX = 150   # ms: the longest renderer -> main -> renderer round trip allowed while a helper job runs
# the machine's busy lock (docs/measurements/w1_2026-11-06/w1_lock.py; SCUMBLE_BUSY_LOCK names another file): the gate
# loads SAM2 on the GPU and times IPC round trips, so it holds the lock while it runs, as a timed batch does
LOCK_SCRIPT = os.path.join(os.path.dirname(HERE), "docs", "measurements", "w1_2026-11-06", "w1_lock.py")
LOCK_WAIT_S = 300
SAM2_TINY = os.path.join(MODELS, "onnx", "sam2_hiera_tiny.encoder.onnx")


def synthetic_png(path):
    """The plain-Node test's picture: grey, a red rectangle, a blue ellipse, a yellow rectangle (1024 x 1024)."""
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (1024, 1024), (128, 128, 128))
    d = ImageDraw.Draw(im)
    d.rectangle([100, 120, 419, 479], fill=(220, 40, 40))
    d.ellipse([560, 100, 939, 459], fill=(40, 60, 220))
    d.rectangle([300, 620, 759, 899], fill=(250, 230, 60))
    im.save(path)


def cutout_png(path):
    """A yellow rectangle on black, the matting test's picture."""
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (1024, 1024), (0, 0, 0))
    ImageDraw.Draw(im).rectangle([250, 200, 699, 799], fill=(250, 200, 60))
    im.save(path)


PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host, H = window.scumble.helpers;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const G = window.__hg;
    // the renderer's IPC round trips (app:tileMode every 3 ms) during fn: what main's longest block feels like
    const probed = async (fn) => {
        const rtts = [];
        let on = true;
        const loop = (async () => { while (on) { const t = performance.now(); try { await window.scumble.tileMode(); } catch (_) {} rtts.push(performance.now() - t); await wait(3); } })();
        await wait(20);
        const t0 = performance.now();
        let res = null, err = null;
        try { res = await fn(); } catch (e) { err = String((e && e.message) || e); }
        const wall = +(performance.now() - t0).toFixed(1);
        await wait(30);
        on = false; await loop;
        const max = rtts.length ? +Math.max(...rtts).toFixed(1) : null;
        return { res, err, wall, rttMax: max, rtts: rtts.length };
    };
    const proc = async () => (await H.status()).runtime.process;
    const helperPids = async () => (await window.scumble.metrics()).processes.filter((p) => p.name === "Scumble helpers").map((p) => p.pid);
    const gone = async (pid) => { for (let i = 0; i < 100; i++) { if (!(await helperPids()).includes(pid)) return true; await wait(50); } return false; };
    %s
})()"""

STEPS = [
    ("setup", """
const st = await H.status();
window.__hg = { before: { dir: st.isDefaultDir ? null : st.dir, sam2: st.sam2, matting: st.matting, device: st.device } };
const G2 = window.__hg;
const after = await H.configure({ dir: __MODELS__, sam2: "sam2_tiny", matting: "rmbg14", device: "auto" });
await host.refreshHelpers();
const tiny = (after.models || []).find((m) => m.id === "sam2_tiny");
if (!tiny || !tiny.present) throw new Error("SAM2 tiny not found in " + after.dir);
const p = after.runtime.process;
if (!p || p.state !== "off" || p.pid != null) throw new Error("the helpers' process should be off before the first job: " + JSON.stringify(p));
if (!after.runtime.version) throw new Error("no onnxruntime version before the first job");
// the plain-Node test's picture, as the window sends it (RGBA 1024²)
const S = 1024, img = new Uint8Array(S * S * 4);
const fill = (x0, y0, x1, y1, r, g, b, round) => { const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { if (round && ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue; const i = (y * S + x) * 4; img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255; } };
fill(0, 0, S, S, 128, 128, 128, false); fill(100, 120, 420, 480, 220, 40, 40, false); fill(560, 100, 940, 460, 40, 60, 220, true); fill(300, 620, 760, 900, 250, 230, 60, false);
G2.img = img;
return { dir: after.dir, runtime: after.runtime };
"""),
    ("objects_in_the_process", """
const r = await probed(() => H.objects({ model: "sam2_tiny", key: "gate:a", image: G.img, outWidth: 1024, outHeight: 1024 }));
if (r.err) throw new Error(r.err);
const o = r.res, at = (x, y) => o.ids[y * 1024 + x];
const red = at(260, 300), blue = at(750, 280), yellow = at(530, 760), bg = at(50, 1000);
if (!(o.count > 0) || new Set([red, blue, yellow]).size !== 3 || !red || !blue || !yellow || [red, blue, yellow].includes(bg)) throw new Error("objects: " + JSON.stringify({ count: o.count, red, blue, yellow, bg }));
const p = await proc();
if (p.state !== "ready" || !p.pid) throw new Error("the helpers' process is not up: " + JSON.stringify(p));
const pids = await helperPids();
if (!pids.includes(p.pid)) throw new Error("no 'Scumble helpers' process with pid " + p.pid + " in the metrics: " + JSON.stringify(pids));
const st = (await H.status()).runtime;
if (!(st.loaded >= 2)) throw new Error("helpers:status should show the process's sessions: " + JSON.stringify(st));
if (r.rttMax > __RTT__) throw new Error(`main blocked: an IPC round trip took ${r.rttMax} ms during the cold object map (wall ${r.wall} ms)`);
G.pid1 = p.pid;
return { count: o.count, provider: o.provider, wall: r.wall, rttMax: r.rttMax, probes: r.rtts, pid: p.pid, loaded: st.loaded, providers: Object.values(st.active) };
"""),
    ("editor_paths", """
const d = await run("new_document");
G.doc = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("load_image", { doc: d.id, path: __PICTURE__ });
await wait(500);
// the hover tool's map (host.findObjects)
ed.objects = null;
const r1 = await probed(() => ed.ensureObjects());
if (!ed.objects || !(ed.objects.count > 0)) throw new Error("ensureObjects found nothing: " + ed.status);
// a point on the blue ellipse (host.segmentLogits, then the selection)
const r2 = await probed(() => run("select_point", { doc: d.id, x: 750, y: 280, mode: "replace" }));
if (r2.err) throw new Error(r2.err);
const b = r2.res.selection;
const bb = Array.isArray(b) ? b : (b && [b.x, b.y, b.w, b.h]);
if (!bb || Math.abs(bb[0] - 560) > 30 || Math.abs(bb[1] - 100) > 30 || Math.abs(bb[2] - 380) > 40 || Math.abs(bb[3] - 360) > 40) throw new Error("select_point's selection is not the ellipse: " + JSON.stringify(b));
// a cutout of a layer (host.cutoutInApp) with RMBG-1.4
await run("add_image_layer", { doc: d.id, path: __CUTOUT__ });
const layer = ed.layers[ed.layers.length - 1];
ed.cutoutSettings.backend = "app:rmbg14";
const r3 = await probed(() => run("cutout_layer", { doc: d.id, layer: layer.id }));
if (r3.err) throw new Error(r3.err);
// the matte lands as the layer's mask (applyCutoutImage); read either encoding of it (alpha or grey)
if (!layer.maskPx) throw new Error("no layer mask after the cutout: " + ed.status);
const c = layer.maskPx.toCanvas(), g = c.getContext("2d");
const a = (x, y) => { const d = g.getImageData(Math.round(x * c.width / 1024), Math.round(y * c.height / 1024), 1, 1).data; return Math.min(d[0], d[3]); };
const inside = a(475, 500), corner = a(40, 40);
if (inside < 200 || corner > 40) throw new Error("the cutout's alpha: inside " + inside + ", corner " + corner);
const worst = Math.max(r1.rttMax, r2.rttMax, r3.rttMax);
if (worst > __RTT__) throw new Error(`main blocked: an IPC round trip took ${worst} ms (map ${r1.rttMax}, point ${r2.rttMax}, cutout ${r3.rttMax})`);
return { objects: ed.objects.count, selection: b, cutout: { inside, corner }, wall: { map: r1.wall, point: r2.wall, cutout: r3.wall }, rttMax: { map: r1.rttMax, point: r2.rttMax, cutout: r3.rttMax } };
"""),
    ("free_vram_ends_the_process", """
const before = await proc();
const n = await H.free();
const p = await proc();
if (p.state !== "off" || p.pid != null) throw new Error("after Free VRAM: " + JSON.stringify(p));
if (!(await gone(before.pid))) throw new Error("the process " + before.pid + " is still in the metrics after Free VRAM");
const st = (await H.status()).runtime;
if (st.loaded !== 0 || Object.keys(st.active).length) throw new Error("sessions after Free VRAM: " + JSON.stringify(st));
// the next point starts a new one: no embedding for the key there, so the window sends the picture again
const ed = ednow(G.doc);
const r = await probed(() => run("select_point", { doc: G.doc, x: 260, y: 300, mode: "replace" }));
if (r.err) throw new Error(r.err);
const p2 = await proc();
if (p2.state !== "ready" || !p2.pid || p2.pid === before.pid) throw new Error("no new process after the point: " + JSON.stringify(p2));
if (r.rttMax > __RTT__) throw new Error(`main blocked ${r.rttMax} ms during the restart`);
return { released: n, oldPid: before.pid, newPid: p2.pid, selection: r.res.selection, wall: r.wall, rttMax: r.rttMax };
"""),
    ("free_during_a_map", """
// the free a local Generate does (or the button) while a map runs: the map still lands, the process ends after it,
// and a point sent meanwhile goes to a new process
const old = (await proc()).pid;
const job = H.objects({ model: "sam2_tiny", key: "gate:b", image: G.img, outWidth: 1024, outHeight: 1024 }).then((r) => r, (e) => ({ error: String(e.message || e) }));
await wait(250);
const freeing = H.free();
await wait(20);
const p1 = await proc();
if (p1.pid === old || p1.retiring !== 1) throw new Error("the process should be retiring during the map: " + JSON.stringify(p1));
const point = H.segment({ model: "sam2_tiny", key: "gate:c", image: G.img, points: [{ x: 750, y: 280, label: 1 }], raw: true });
const r = await job;
await freeing;
if (r.error || !(r.count > 0)) throw new Error("the map should land through Free VRAM: " + (r.error || JSON.stringify({ count: r.count })));
if (!(await gone(old))) throw new Error("the retired process " + old + " is still in the metrics");
const next = await point;
if (!next || !next.logits || next.logits.length !== 65536) throw new Error("the point sent during the drain did not answer");
const p2 = await proc();
if (!p2.pid || p2.pid === old || p2.retiring !== 0) throw new Error("the point should have gone to a new process: " + JSON.stringify(p2));
return { landed: r.count, oldPid: old, newPid: p2.pid, next: { score: next.score, provider: next.provider } };
"""),
    ("device_cpu", """
const pid = (await proc()).pid;
const st = await H.configure({ device: "cpu" });
if (st.runtime.process.state !== "off" || !(await gone(pid))) throw new Error("the device switch should end the process: " + JSON.stringify(st.runtime.process));
if (JSON.stringify(st.runtime.candidates) !== JSON.stringify(["cpu"])) throw new Error("candidates on the CPU: " + JSON.stringify(st.runtime.candidates));
const r = await probed(() => H.segment({ model: "sam2_tiny", key: "gate:d", image: G.img, points: [{ x: 750, y: 280, label: 1 }], raw: true }));
if (r.err) throw new Error(r.err);
if (r.res.provider !== "cpu") throw new Error("the answer's provider after the switch: " + r.res.provider);
const rt = (await H.status()).runtime;
if (!Object.values(rt.active).length || Object.values(rt.active).some((p) => p !== "cpu")) throw new Error("sessions after the switch: " + JSON.stringify(rt.active));
if (r.rttMax > __RTT__) throw new Error(`main blocked ${r.rttMax} ms during a CPU point`);
await H.configure({ device: "auto" });
return { provider: r.res.provider, wall: r.wall, rttMax: r.rttMax, active: Object.values(rt.active) };
"""),
    ("cleanup", """
const b = (G && G.before) || {};
await H.free();
await H.configure({ dir: b.dir == null ? null : b.dir, sam2: b.sam2, matting: b.matting, device: b.device || "auto" });
await host.refreshHelpers();
if (G && G.doc) { try { await run("close_document", { doc: G.doc, remember: false }); } catch (_) {} }
const p = await proc();
return { restored: b, process: p };
"""),
]


async def run_all(c):
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    work = tempfile.mkdtemp(prefix="scumble_helpers_gate_")
    pic, cut = os.path.join(work, "shapes.png"), os.path.join(work, "cutout.png")
    synthetic_png(pic)
    cutout_png(cut)
    ok = True
    for name, body in STEPS:
        body = (body.replace("__MODELS__", json.dumps(MODELS)).replace("__PICTURE__", json.dumps(pic))
                .replace("__CUTOUT__", json.dumps(cut)).replace("__RTT__", str(RTT_MAX)))
        try:
            res = await c.eval(PRE % body, timeout=300)
            print("[ok] %s: %s" % (name, json.dumps(res)[:400]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            if name != "cleanup":
                try:
                    await c.eval(PRE % STEPS[-1][1], timeout=120)
                except Exception as e2:  # noqa: BLE001
                    print("  cleanup after the failure:", e2)
            break
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    return ok


def lock_acquire():
    """The busy lock, waited for at most LOCK_WAIT_S (the gate's own timeout is 420 s): its token, or None when another
    holder kept it (the gate then runs beside it and says so)."""
    import contextlib
    import importlib.util
    import io
    if not os.path.isfile(LOCK_SCRIPT):
        return None
    spec = importlib.util.spec_from_file_location("w1_lock", LOCK_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.WAIT_S, mod.STEP_S = LOCK_WAIT_S, 10
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = mod.acquire("helpers gate")
    if rc != 0:
        print(f"lock: still held after {LOCK_WAIT_S} s by {mod.holder()!r}: the gate runs beside it")
        return None
    return mod, out.getvalue().strip()


def main():
    if not os.path.isfile(SAM2_TINY):
        print(f"SKIP: no SAM2 tiny in {MODELS} (onnx/)")
        print("PASS (skipped)")
        return 0
    held = lock_acquire()
    try:
        return run_gate()
    finally:
        if held:
            held[0].release(held[1])


def run_gate():
    node_cmd = ["node", os.path.join(HERE, "helpers_test.js"), MODELS, "--also", APP_MODELS, "--process", "--sam2", "sam2_tiny", "--matting", "rmbg14"]
    p = subprocess.run(node_cmd, capture_output=True, text=True, encoding="utf-8")
    print(p.stdout.rstrip())
    if p.returncode != 0:
        print("[FAIL] node helpers_test.js --process:", (p.stderr or "")[-2000:])
        print("FAIL")
        return 1
    print("[ok] node helpers_test.js --process passed")
    if "--node-only" in sys.argv:
        print("PASS")
        return 0
    try:
        ok = asyncio.run(session(run_all))
    except Exception as err:  # noqa: BLE001
        print(f"[FAIL] CDP session not reachable: {err}")
        ok = False
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
