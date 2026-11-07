"""U0 of docs/PLAN_WASM_BUILD.md §7 ("The user's answers after K4"): where the in-app ONNX helpers' time goes.

Every model but LaMa runs on Electron's main process (docs/HELPERS.md). This starts a fresh instance per batch (its
own profile, offline, the window in front; the helpers folder is the user's ComfyUI models folder, read only, with
the app folder's extra files linked; nothing is downloaded) and measures each helper call the renderer makes
(helpers:objects / segment / cutout / depth, through host.helperCall with host.objectInput's 1024 x 1024 input):
  - the renderer's wall time;
  - the main process's longest block: an event-loop sampler in main (a 4 ms interval; a gap over 20 ms is a block)
    and an IPC round-trip probe from the renderer (app:tileMode every 3 ms) during the call;
  - main's breakdown from wrappers installed through main's inspector (`--inspect`, no app code): every
    InferenceSession.create / run / release (file, provider, ms), Sam2 encode / automask / predict, the IPC handlers;
  - main's memory (app.getAppMetrics private bytes, after a forced GC) and the GPU memory (the WDDM counters of
    main's pid, the card by nvidia-smi) before, after, and after Free VRAM.
Batches:
  gpu     Settings › Helpers device "gpu": every model on DirectML, a matting session released after each run (as the
          app does on that device; "auto" runs SAM2 and depth like this and matting like "cpu")
  cpu     device "cpu"
  editor  device "auto": the object tool's own path on the scene scaled to 6000 and 15000 px wide (ensureObjects with
          its renderer parts, the hover's object shape, a click on an object, select_point)
  probe   the same engine (electron/main/onnx's runtime, sam2, matting, depth) in a utility process forked from main
          (tools/helpers_process_probe.js): DirectML there, the message port's copy, main's responsiveness meanwhile
  hovermem  the object tool's hover shapes on the 15k picture: the time per shape, the renderer's and the GPU
          process's memory with 14 shapes hovered (13 are kept); a run numbered 4 or more reads it again 20 and 60 s
          after the shapes were dropped
  batchsize  the SAM2 decoder's batch size on DirectML, each size in a fresh utility process (the export runs only
          B 1 and B 64: every other size fails at /Mul_14, on DirectML and on the CPU)
After U1 (docs/PLAN_HELPERS_PROCESS.md; the models in the helpers' utility process, `helpers.helperProcess` in
electron/main/onnx/index.js) main loads no onnxruntime and its wrappers see no session: the harness then hooks the
process's answers instead (`HelperProcess.onJob`: each job's time inside the process, `proc` in the summary, and the
wall from main's post to the answer) and counts the process ("Scumble helpers") in the memory rows; main's sampler and
the renderer's IPC probe measure the same as before.
RMBG-2.0 runs on the CPU only (BiRefNet lite on DirectML held 24.7 GB of main's private bytes, docs/BUGS.md B5;
RMBG-2.0 is the full BiRefNet). Each batch takes the machine's busy lock (docs/measurements/w1_2026-11-06/w1_lock.py)
for its instance only, after waiting for other agents' Electron instances and test scripts to end; it is released
between batches and stays free for --gap seconds, so an agent that checks it every 60 s can start its gates.

    python tools/helpers_perf.py --out docs/measurements/u0_2026-11-07 [--runs 1,2,3]
        [--batches gpu,cpu,editor,probe,batchsize,hovermem] [--skip 1:gpu] [--gap 90]
        [--port 9588] [--inspect 9598] [--no-lock] [--models-dir DIR] [--app-models DIR] [--work DIR] [--image FILE]
        [--quick]                                         a dry run: SAM2 base+, BiRefNet lite, depth, one editor size
    python tools/helpers_perf.py --out DIR --summarize      summary.txt from DIR/raw/*.json
"""
import argparse
import asyncio
import base64
import glob
import json
import os
import shutil
import statistics
import subprocess
import sys
import time

import aiohttp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
LOCK = os.path.join(ROOT, "docs", "measurements", "w1_2026-11-06", "w1_lock.py")
PROBE = os.path.join(ROOT, "tools", "helpers_process_probe.js")
COMFY_MODELS = r"F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\models"
APP_MODELS = os.path.join(os.environ.get("APPDATA", ""), "Scumble", "models")
# a real scene (2000 x 1125, the tutorial's picture: a person, a car, a bag, a building; untracked material in the main
# checkout): SAM2's object map depends on the content (dist/daily's adobe_*.jpg are gradients, two objects)
IMAGE = os.path.join(r"F:\canvas", "docs", "images", "tutorial", "scene.jpg")
EDITOR_SIDES = (6000, 15000)   # the editor batch: IMAGE scaled to these widths (Lanczos, into --work)


def editor_images(work, image):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    out = []
    im = None
    for w in EDITOR_SIDES:
        p = os.path.join(work, f"scene_{w}.jpg")
        if not os.path.isfile(p):
            im = im or Image.open(image).convert("RGB")
            h = round(im.size[1] * w / im.size[0])
            im.resize((w, h), Image.LANCZOS).save(p, quality=92)
        with Image.open(p) as x:
            out.append((p, x.size[0], x.size[1]))
    return out


# ---- CDP ------------------------------------------------------------------------------------------------------------

class Cdp:
    def __init__(self, ws, cli=False):
        self.ws = ws
        self.n = 0
        self.cli = cli

    async def call(self, method, timeout=900, **params):
        self.n += 1
        my = self.n
        await self.ws.send_json({"id": my, "method": method, "params": params})

        async def wait():
            while True:
                msg = await self.ws.receive_json()
                if msg.get("id") == my:
                    if "error" in msg:
                        raise RuntimeError(json.dumps(msg["error"]))
                    return msg.get("result", {})
        return await asyncio.wait_for(wait(), timeout)

    async def eval(self, expr, timeout=900):
        r = await self.call("Runtime.evaluate", timeout=timeout, expression=expr, awaitPromise=True, returnByValue=True,
                            includeCommandLineAPI=self.cli)
        if "exceptionDetails" in r:
            ed = r["exceptionDetails"]
            raise RuntimeError("JS exception: " + str(ed.get("exception", {}).get("description") or ed.get("text")))
        v = r.get("result", {}).get("value")
        return json.loads(v) if isinstance(v, str) and v[:1] in "[{" else v


async def targets(session, port):
    async with session.get(f"http://127.0.0.1:{port}/json") as r:
        return await r.json()


# ---- the machine ----------------------------------------------------------------------------------------------------

def ps(script, timeout=60):
    r = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True,
                       text=True, timeout=timeout)
    return r.stdout


def gpu_mem(pids):
    """{pid: {dedicatedMB, sharedMB}} from the WDDM counters (about 1.5 s), and the card's used MiB (nvidia-smi)."""
    out = {}
    try:
        text = ps('(Get-Counter "\\GPU Process Memory(*)\\Dedicated Usage","\\GPU Process Memory(*)\\Shared Usage"'
                  ' -ErrorAction SilentlyContinue).CounterSamples | ForEach-Object { $_.Path + "|" + $_.CookedValue }')
        for line in text.splitlines():
            if "|" not in line:
                continue
            path, val = line.rsplit("|", 1)
            low = path.lower()
            for pid in pids:
                if f"(pid_{pid}_" in low:
                    d = out.setdefault(pid, {"dedicatedMB": 0, "sharedMB": 0})
                    key = "dedicatedMB" if "dedicated usage" in low else "sharedMB"
                    d[key] += round(float(val.replace(",", ".")) / 1048576)
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)[:200]
    card = None
    try:
        card = int(subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                                  capture_output=True, text=True, timeout=20).stdout.strip().splitlines()[0])
    except Exception:  # noqa: BLE001
        pass
    return {"procs": {str(k): v for k, v in out.items()}, "cardMB": card}


def others(my_port):
    """Other agents' Electron main processes and test scripts (the user's installed Scumble.exe is left alone)."""
    text = ps("Get-CimInstance Win32_Process -Filter \"Name='electron.exe' or Name='node.exe' or Name='python.exe'\" |"
              " ForEach-Object { [string]$_.ProcessId + '|' + $_.CommandLine }")
    found = []
    for line in text.splitlines():
        if "|" not in line:
            continue
        pid, cmd = line.split("|", 1)
        c = cmd.lower()
        # an MCP server (`--mcp`, Claude's connection to a running Scumble) lives as long as its client: never waited for
        if "electron.exe" in c and "--type=" not in c and "--mcp" not in c and f"--remote-debugging-port={my_port}" not in c:
            found.append((pid, cmd[:160]))
        elif ("node.exe" in c or "python" in c) and ("_test.js" in c or "_test.py" in c or "run_gates" in c
                                                     or "mutation" in c or "px_jobs" in c or "_bench" in c
                                                     or "brush_perf" in c or "perf_test" in c) and "helpers_perf" not in c:
            found.append((pid, cmd[:160]))
    return found


def lock_acquire(text, log):
    r = subprocess.run([sys.executable, LOCK, "acquire", text], capture_output=True, text=True)
    log(f"lock: rc {r.returncode} {r.stderr.strip()}")
    return r.stdout.strip() if r.returncode == 0 else None


def lock_release(token, log):
    if token:
        r = subprocess.run([sys.executable, LOCK, "release", token], capture_output=True, text=True)
        log(f"lock: {r.stderr.strip()}")


def wait_others(port, log, max_s=1200):
    t0 = time.time()
    seen = None
    while True:
        o = others(port)
        if not o:
            if seen:
                log(f"others gone after {time.time() - t0:.0f} s")
            return []
        if seen is None:
            log("waiting for: " + "; ".join(f"{p} {c}" for p, c in o))
        seen = o
        if time.time() - t0 > max_s:
            log("still running after the wait (measured beside them): " + "; ".join(f"{p} {c}" for p, c in o))
            return o
        time.sleep(20)


# ---- the instance ---------------------------------------------------------------------------------------------------

def settings_for(device, models_dir, app_models):
    links = {}
    def link(mid, files):
        paths = {role: os.path.join(app_models, name) for role, name in files.items()}
        if all(os.path.isfile(p) for p in paths.values()):
            links[mid] = paths
    link("da2_small", {"model": "depth_anything_v2_small.onnx"})
    link("sam2_small", {"encoder": "sam2_hiera_small.encoder.onnx", "decoder": "sam2_hiera_small.decoder.onnx"})
    link("rmbg2", {"model": "rmbg2.onnx"})
    return {"helpers": {"device": device, "dir": models_dir, "sam2": "sam2_base_plus", "matting": "birefnet_lite",
                        "depth": "da2_small", "links": links}}


def start(profile, logfile, port, inspect, device, models_dir, app_models):
    if os.path.isdir(profile):
        shutil.rmtree(profile, ignore_errors=True)
    os.makedirs(profile, exist_ok=True)
    with open(os.path.join(profile, "settings.json"), "w", encoding="utf-8", newline=chr(10)) as f:
        json.dump(settings_for(device, models_dir, app_models), f, indent=1)
    lf = open(logfile, "w", encoding="utf-8")
    return subprocess.Popen([ELECTRON, f"--inspect={inspect}", ".", f"--remote-debugging-port={port}",
                             f"--user-data-dir={profile}", "--no-comfy"], cwd=ROOT, stdout=lf, stderr=subprocess.STDOUT)


def close(port, proc):
    env = dict(os.environ, SCUMBLE_CDP_PORT=str(port))
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "close_app.py")], env=env, capture_output=True, timeout=60)
    try:
        proc.wait(30)
    except Exception:  # noqa: BLE001
        proc.kill()


MAIN_SETUP = r"""(() => {
    if (globalThis.__u0) return JSON.stringify({ again: true, pid: process.pid });
    const R = require, C = R.cache;
    const find = (re) => { const k = Object.keys(C).find((x) => re.test(x)); if (!k) throw new Error("not loaded: " + re); return C[k].exports; };
    const { performance, monitorEventLoopDelay } = R("node:perf_hooks");
    const path = R("node:path");
    const rt = find(/[\\/]electron[\\/]main[\\/]onnx[\\/]runtime\.js$/);
    const sam2m = find(/[\\/]electron[\\/]main[\\/]onnx[\\/]sam2\.js$/);
    const helpers = find(/[\\/]electron[\\/]main[\\/]onnx[\\/]index\.js$/);
    const U = globalThis.__u0 = { ev: [], blocks: [], fileOf: new WeakMap(), R };
    const now = () => performance.now();
    const rec = (o) => { U.ev.push(o); };
    // U1: the models run in the helpers' process; main loads no onnxruntime, so its answers are what there is to time
    const hp = helpers.helperProcess || null;
    if (hp) hp.onJob = (j) => rec({ k: "job", type: j.type, ms: j.ms, wallMs: j.wallMs, error: j.error, pid: j.pid, t0: now() - (j.wallMs || 0) });
    const ort = hp ? null : rt.loadOrt();
    const IS = ort ? ort.InferenceSession : function () {};
    const oc = IS.create;
    if (ort) IS.create = async function (a, b, ...rest) {
        const t = now(), f = typeof a === "string" ? path.basename(a) : "(buffer)", p = b && b.executionProviders ? String(b.executionProviders[0]) : "?";
        try { const s = await oc.call(this, a, b, ...rest); rec({ k: "create", f, p, t0: t, ms: now() - t }); U.fileOf.set(s, f); return s; }
        catch (e) { rec({ k: "createFail", f, p, t0: t, ms: now() - t, err: String((e && e.message) || e).slice(0, 200) }); throw e; }
    };
    const orun = IS.prototype.run;
    if (ort) IS.prototype.run = async function (feeds, ...rest) {
        const t = now();
        const r = await orun.call(this, feeds, ...rest);
        const d = feeds && (feeds.point_coords || Object.values(feeds)[0]);
        rec({ k: "run", f: U.fileOf.get(this) || "?", t0: t, ms: now() - t, dims: d && d.dims ? Array.from(d.dims) : null });
        return r;
    };
    const orel = IS.prototype.release;
    if (ort) IS.prototype.release = async function (...a) { const t = now(); const r = await orel.apply(this, a); rec({ k: "release", f: U.fileOf.get(this) || "?", t0: t, ms: now() - t }); return r; };
    for (const name of ["encode", "automask", "predict"]) {
        const o = sam2m.Sam2.prototype[name];
        sam2m.Sam2.prototype[name] = async function (...a) { const t = now(); const r = await o.apply(this, a); rec({ k: name, t0: t, ms: now() - t }); return r; };
    }
    for (const name of ["objects", "segment", "cutout", "depth", "free"]) {
        const o = helpers[name];
        helpers[name] = async function (...a) { const t = now(); try { return await o.apply(this, a); } finally { rec({ k: "handler", name, t0: t, ms: now() - t }); } };
    }
    let last = now();
    U.timer = setInterval(() => { const n = now(), g = n - last; if (g > 20) U.blocks.push([+last.toFixed(1), +g.toFixed(1)]); last = n; }, 4);
    try { U.hist = monitorEventLoopDelay({ resolution: 5 }); U.hist.enable(); } catch (_) { U.hist = null; }
    U.reset = () => { U.ev.length = 0; U.blocks.length = 0; if (U.hist) U.hist.reset(); return now(); };
    U.collect = () => {
        const ev = U.ev.splice(0), bl = U.blocks.splice(0);
        const top = bl.slice().sort((a, b) => b[1] - a[1]).slice(0, 12);
        const out = { ev, blockN: bl.length, blockMax: top.length ? top[0][1] : 0, blockSum: +bl.reduce((a, b) => a + b[1], 0).toFixed(1), top,
            histMaxMs: U.hist ? +(U.hist.max / 1e6).toFixed(1) : null, histP99Ms: U.hist ? +(U.hist.percentile(99) / 1e6).toFixed(1) : null };
        if (U.hist) U.hist.reset();
        return JSON.stringify(out);
    };
    U.mem = () => {
        const { app } = R("electron");
        const m = process.memoryUsage(), ms = app.getAppMetrics();
        const by = (t) => ms.filter((p) => p.type === t).map((p) => ({ pid: p.pid, privMB: Math.round(p.memory.privateBytes / 1024), wsMB: Math.round(p.memory.workingSetSize / 1024), name: p.name || p.serviceName || "" }));
        return JSON.stringify({ rssMB: Math.round(m.rss / 1048576), abMB: Math.round(m.arrayBuffers / 1048576), heapMB: Math.round(m.heapUsed / 1048576),
            main: by("Browser")[0] || null, gpu: by("GPU"), utility: by("Utility"), tab: by("Tab") });
    };
    // the probe batch: the same engine in a utility process
    U.fork = (script) => new Promise((resolve) => {
        const { utilityProcess } = R("electron");
        const t = now();
        const p = utilityProcess.fork(script, [], { serviceName: "Scumble U0 probe" });
        const P = { p, seq: 0, pending: new Map(), exited: null };
        p.on("message", (m) => { const j = P.pending.get(m && m.id); if (j) { P.pending.delete(m.id); j(m); } });
        p.on("exit", (code) => { P.exited = code; P.exitAt = now(); for (const j of P.pending.values()) j({ error: "exited " + code }); P.pending.clear(); });
        P.call = (msg) => new Promise((res) => { const id = ++P.seq; const s = now(); P.pending.set(id, (m) => res({ ...m, rtt: now() - s })); p.postMessage({ ...msg, id }); });
        U.P = P;
        p.on("spawn", () => resolve(JSON.stringify({ pid: p.pid, spawnMs: +(now() - t).toFixed(1) })));
    });
    U.pcall = async (msg) => {
        const r = await U.P.call(msg);
        const res = r.result || {};
        const o = {};
        for (const [k, v] of Object.entries(res)) { if (ArrayBuffer.isView(v)) o[k + "Bytes"] = v.byteLength; else if (v == null || typeof v !== "object") o[k] = v; }
        return JSON.stringify({ rtt: +r.rtt.toFixed(1), ms: r.ms != null ? +r.ms.toFixed(1) : null, error: r.error || null, res: o });
    };
    U.read = (f) => { const b = R("node:fs").readFileSync(f); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };
    return JSON.stringify({ pid: process.pid, ort: ort && ort.env && ort.env.versions ? ort.env.versions.node : null, u1: !!hp, electron: process.versions.electron, hist: !!U.hist });
})()"""

PAGE_SETUP = r"""(async () => {
    await import('./shell.js');
    const host = (await import('./editor/host.js')).host;
    const commands = (await import('./commands.js')).commands;
    const D = await import('./editor/inpaint_depth.js');
    const U = window.__u0 = window.__u0 || {};
    Object.assign(U, { host, commands, D });
    U.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    U.probeStart = () => {
        const p = { on: true, rtts: [], gaps: [] };
        U.probe = p;
        p.loop = (async () => { while (p.on) { const t = performance.now(); try { await window.scumble.tileMode(); } catch (_) {} p.rtts.push([t, performance.now() - t]); await U.sleep(3); } })();
        let last = performance.now();
        p.timer = setInterval(() => { const n = performance.now(); if (n - last > 30) p.gaps.push([last, n - last]); last = n; }, 4);
        return true;
    };
    U.probeStop = async () => {
        const p = U.probe; p.on = false; clearInterval(p.timer); await p.loop;
        const ds = p.rtts.map((x) => x[1]).sort((a, b) => a - b);
        const q = (f) => ds.length ? +ds[Math.min(ds.length - 1, Math.floor(f * ds.length))].toFixed(1) : null;
        return { n: ds.length, max: ds.length ? +ds[ds.length - 1].toFixed(1) : null, p50: q(0.5), p95: q(0.95),
            over50: ds.filter((d) => d > 50).length, over200: ds.filter((d) => d > 200).length,
            rendGapMax: p.gaps.length ? +Math.max(...p.gaps.map((g) => g[1])).toFixed(1) : 0, rendGaps: p.gaps.length };
    };
    U.summ = (res) => {
        if (!res || typeof res !== 'object') return res;
        const o = {};
        for (const [k, v] of Object.entries(res)) { if (ArrayBuffer.isView(v)) o[k + 'Bytes'] = v.byteLength; else if (v == null || typeof v !== 'object') o[k] = v; }
        return o;
    };
    U.parts = [];
    U.timed = async (fn) => {
        U.parts = [];
        U.probeStart(); await U.sleep(20);
        const t = performance.now(); U.t0 = t;
        let res = null, err = null;
        try { res = await fn(); } catch (e) { err = String((e && e.message) || e).slice(0, 300); }
        const wall = performance.now() - t;
        await U.sleep(30);
        const probe = await U.probeStop();
        return JSON.stringify({ wall: +wall.toFixed(1), probe, res: U.summ(res), err, parts: U.parts.map((p) => ({ k: p.k, at: +(p.t0 - t).toFixed(1), ms: +p.ms.toFixed(1) })),
            focus: document.hasFocus(), vis: document.visibilityState });
    };
    // the editor's own parts, timed where they are called (the editor batch)
    U.wrap = () => {
        if (U.wrapped) return true;
        U.wrapped = true;
        const ed = window.editor;
        const time = (obj, name, k) => { const o = obj[name]; obj[name] = function (...a) { const t = performance.now(); const r = o.apply(this, a); const done = () => U.parts.push({ k: k || name, t0: t, ms: performance.now() - t }); if (r && typeof r.then === 'function') return r.finally(done); done(); return r; }; };
        time(host, 'objectInput'); time(host, 'inputHash'); time(host, 'helperCall'); time(host, 'segmentLogits');
        const proto = Object.getPrototypeOf(ed);
        time(proto, 'applySegmentIds'); time(proto, 'selectLogits'); time(proto, 'objectShape');
        return true;
    };
    return JSON.stringify({ ok: true, tiles: !!(window.editor && window.editor.tileMode) });
})()"""

PREP = r"""(async () => {
    const U = window.__u0, ed = window.editor;
    const t = performance.now();
    await U.commands.run('load_image', { path: @@IMAGE@@ });
    const loadMs = performance.now() - t;
    await U.sleep(1500);
    if (ed.mipsSettled) await ed.mipsSettled();
    const W = ed.width, H = ed.height;
    const a = performance.now();
    U.img = await U.host.objectInput(ed, null);
    const inputMs = performance.now() - a;
    U.img2 = new Uint8Array(U.img.length);   // the picture mirrored: another embedding of the same content
    for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) { const s = (y * 1024 + x) * 4, d = (y * 1024 + 1023 - x) * 4; U.img2[d] = U.img[s]; U.img2[d + 1] = U.img[s + 1]; U.img2[d + 2] = U.img[s + 2]; U.img2[d + 3] = 255; }
    U.key1 = 'u0:' + await U.host.inputHash(U.img); U.key2 = 'u0:' + await U.host.inputHash(U.img2);
    const s = Math.min(1, 2048 / Math.max(W, H));
    U.outW = Math.max(1, Math.round(W * s)); U.outH = Math.max(1, Math.round(H * s));
    [U.dw, U.dh] = U.D.modelSize(W, H);
    const k = U.D.DEPTH_LARGE / Math.max(W, H);
    U.lw = Math.max(14, U.D.roundHalfEven(W * k / 14) * 14); U.lh = Math.max(14, U.D.roundHalfEven(H * k / 14) * 14);
    U.dimg = (await U.host.depthInput(ed, U.dw, U.dh)).image;
    U.dimgL = (await U.host.depthInput(ed, U.lw, U.lh)).image;
    U.bad4 = new Uint8Array(1024 * 1024 * 4 + 4);
    return JSON.stringify({ W, H, loadMs: +loadMs.toFixed(0), inputMs: +inputMs.toFixed(1), outW: U.outW, outH: U.outH, dw: U.dw, dh: U.dh, lw: U.lw, lh: U.lh, tiles: !!ed.tileMode });
})()"""


def b64_of(page_js):
    return f"(() => {{ const a = {page_js}; let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); }})()"


# ---- the rows -------------------------------------------------------------------------------------------------------

class Batch:
    def __init__(self, page, main, main_pid, log):
        self.page, self.main, self.pid, self.log = page, main, main_pid, log
        self.rows = []
        self.mems = []

    async def gc(self):
        try:
            await self.main.call("HeapProfiler.collectGarbage", timeout=60)
        except Exception:  # noqa: BLE001
            pass

    async def mem(self, label, extra_pids=()):
        await self.gc()
        await asyncio.sleep(0.5)
        m = await self.main.eval("__u0.mem()")
        helper_pids = [u["pid"] for u in (m or {}).get("utility") or [] if "helpers" in (u.get("name") or "")]
        g = await asyncio.get_running_loop().run_in_executor(None, gpu_mem, [self.pid, *extra_pids, *helper_pids])
        entry = {"label": label, "main": m, "gpu": g}
        self.mems.append(entry)
        mm = (m or {}).get("main") or {}
        self.log(f"   mem {label}: main {mm.get('privMB')} MB private, rss {m.get('rssMB')}; gpu main "
                 f"{g['procs'].get(str(self.pid))}, card {g['cardMB']} MiB")
        return entry

    async def row(self, name, js, reps=1, **meta):
        out = []
        for i in range(reps):
            await self.page.call("Page.bringToFront")   # other agents' windows may have taken the front meanwhile
            await self.main.eval("__u0.reset()")
            r = await self.page.eval(f"(() => {{ const U = window.__u0; return U.timed(async () => ({js})); }})()", timeout=1800)
            r["main"] = await self.main.eval("__u0.collect()")
            out.append(r)
            mn = r["main"]
            self.log(f"   {name}#{i + 1}: wall {r['wall']} ms, main block {mn['blockMax']} ms, rtt max "
                     f"{r['probe']['max']} ms{'' if not r.get('err') else ', err ' + r['err'][:120]}")
            await asyncio.sleep(0.3)
        self.rows.append({"name": name, "reps": out, **meta})
        return out


def sam_row(m, key, image=None, points=True):
    img = f", image: {image}" if image else ""
    return (f"U.host.helperCall('segment', {{ model: '{m}', key: {key}{img}, points: [{{ x: 512, y: 512, label: 1 }}], "
            f"box: null, raw: true }})")


def obj_row(m, key, image, params=None):
    extra = f", params: {json.dumps(params)}" if params else ""
    return f"U.host.helperCall('objects', {{ model: '{m}', key: {key}, image: {image}, outWidth: U.outW, outHeight: U.outH{extra} }})"


async def helper_batch(b, device, quick=False):
    await b.mem("start")
    await b.row("idle", "U.sleep(1500)")
    await b.row("ipc_tiny", "U.host.helperCall('cutout', { image: new Uint8Array(16) })", reps=5)
    await b.row("ipc_4mb", "U.host.helperCall('cutout', { image: U.bad4 })", reps=5)
    for m in ["sam2_base_plus"] + ([] if quick else ["sam2_tiny", "sam2_small"]):
        await b.row(f"{m}.point_cold", sam_row(m, "U.key1", "U.img"), model=m)
        await b.mem(f"{m} after the cold point")
        await b.row(f"{m}.point_warm", sam_row(m, "U.key1"), reps=5, model=m)
        # the decoder is the same file for every SAM2 size: the smaller models' object maps once, their encode on a new picture on the GPU
        await b.row(f"{m}.objects_cached", obj_row(m, "U.key1", "U.img"), reps=2 if m == "sam2_base_plus" else 1, model=m)
        if m == "sam2_base_plus" or device != "cpu":
            await b.row(f"{m}.objects_new", obj_row(m, "U.key2", "U.img2"), model=m)
        await b.row(f"{m}.point_after_objects", sam_row(m, "U.key1"), reps=3, model=m)
        if m == "sam2_base_plus":
            # U2's candidates on the cached embedding: the decoder's batch size and the point grid (automask's params,
            # which objects() passes through; the app sends none: 32 x 32 points in batches of 64)
            for p in ([{"pointsPerBatch": 16}, {"pointsPerBatch": 32}, {"pointsPerBatch": 128}, {"pointsPerBatch": 256}]
                      if device != "cpu" else [{"pointsPerBatch": 256}]) + [{"pointsPerSide": 16}]:
                tag = "_".join(f"{k[6:].lower()}{v}" for k, v in p.items())
                await b.row(f"{m}.objects_{tag}", obj_row(m, "U.key1", "U.img", p), model=m, params=p)
        await b.mem(f"{m} after objects")
        await b.row(f"{m}.free", "window.scumble.helpers.free()", model=m)
        await b.mem(f"{m} after Free VRAM")
        if m == "sam2_base_plus":
            await b.row(f"{m}.objects_after_free", obj_row(m, "U.key1", "U.img"), model=m)
            await b.mem(f"{m} after objects after Free VRAM")
            await b.row(f"{m}.free2", "window.scumble.helpers.free()", model=m)
            await b.mem(f"{m} after the second Free VRAM")
    mattings = ["birefnet_lite"] + ([] if quick else ["rmbg14"] + (["rmbg2"] if device == "cpu" else []))
    for m in mattings:
        await b.row(f"{m}.cutout", f"U.host.helperCall('cutout', {{ model: '{m}', image: U.img }})", reps=3, model=m)
        await b.mem(f"{m} after three cutouts")
        await b.row(f"{m}.free", "window.scumble.helpers.free()", model=m)
        await b.mem(f"{m} after Free VRAM")
    await b.row("da2_small.depth", "U.host.helperCall('depth', { model: 'da2_small', image: U.dimg, width: U.dw, height: U.dh })", reps=4, model="da2_small")
    await b.row("da2_small.depth_large", "U.host.helperCall('depth', { model: 'da2_small', image: U.dimgL, width: U.lw, height: U.lh })", reps=3, model="da2_small")
    await b.mem("da2_small after depth")
    await b.row("da2_small.free", "window.scumble.helpers.free()", model="da2_small")
    await b.mem("da2_small after Free VRAM")


async def editor_batch(b, images):
    await b.page.eval("window.__u0.wrap()")
    await b.mem("start")
    for (img, w, h) in images:
        prep = await b.page.eval(PREP.replace("@@IMAGE@@", json.dumps(img)), timeout=900)
        b.log(f"   prep {w}x{h}: {json.dumps(prep)}")
        b.rows.append({"name": f"doc{w}.prep", "prep": prep})
        tag = f"doc{w}"
        await b.row(f"{tag}.ensureObjects", "(window.editor.objects = null, window.editor.ensureObjects())")
        await b.row(f"{tag}.ensureObjects_cached", "(window.editor.objects = null, window.editor.ensureObjects())")
        info = await b.page.eval("""(() => { const ed = window.editor, o = ed.objects; if (!o) return JSON.stringify({ none: true });
            const counts = new Map(); for (let i = 0; i < o.ids.length; i += 97) { const v = o.ids[i]; if (v) counts.set(v, (counts.get(v) || 0) + 1); }
            const ids = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
            const at = (id) => { for (let i = 0; i < o.ids.length; i += 97) if (o.ids[i] === id) return [i % o.w, Math.floor(i / o.w)]; return null; };
            const empty = (() => { for (let i = 0; i < o.ids.length; i += 1013) if (!o.ids[i]) return [i % o.w, Math.floor(i / o.w)]; return [1, 1]; })();
            return JSON.stringify({ count: o.count, big: ids[0], small: ids[ids.length - 1], bigAt: at(ids[0]), smallAt: at(ids[ids.length - 1]), empty }); })()""")
        b.log(f"   objects {w}x{h}: {json.dumps(info)}")
        if info and not info.get("none"):
            await b.row(f"{tag}.hover_shape_big", f"(window.editor.objectShapeCache.clear(), window.editor.objectShape({info['big']}))")
            await b.row(f"{tag}.hover_shape_small", f"(window.editor.objectShapeCache.clear(), window.editor.objectShape({info['small']}))")
            x, y = info["bigAt"]
            await b.row(f"{tag}.click_object", f"(window.editor.objectShape({info['big']}), window.editor.toggleObjectAt({x}, {y}, {{}}))")
            ex, ey = w // 2, h // 2   # the car's bonnet under the person in the scene: a point prompt as select_point sends it
            await b.row(f"{tag}.select_point", f"U.commands.run('select_point', {{ x: {ex}, y: {ey}, mode: 'replace' }})", reps=3)
        await b.mem(f"{tag} after the object tool")


async def hovermem_batch(b, images, run_later=False):
    """The hover's object shapes on the largest picture: one full-size canvas per hovered object, up to 13 kept
    (inpaint_canvas.js objectShape, objectShapeCache): the time per shape and what the renderer and the GPU process hold."""
    await b.page.eval("window.__u0.wrap()")
    img, w, h = images[-1]
    prep = await b.page.eval(PREP.replace("@@IMAGE@@", json.dumps(img)), timeout=900)
    b.rows.append({"name": f"hover{w}.prep", "prep": prep})
    await b.row(f"hover{w}.ensureObjects", "(window.editor.objects = null, window.editor.ensureObjects())")
    metrics = """(async () => { const m = await window.scumble.metrics(); const by = (t) => m.processes.filter((p) => p.type === t).reduce((a, p) => a + (p.privateKB || 0), 0) / 1024;
        return JSON.stringify({ tabMB: Math.round(by('Tab')), gpuMB: Math.round(by('GPU')), cache: window.editor.objectShapeCache.size }); })()"""
    before = await b.page.eval(metrics)
    ids = await b.page.eval("""(() => { const o = window.editor.objects; const c = new Map(); for (let i = 0; i < o.ids.length; i += 97) { const v = o.ids[i]; if (v) c.set(v, (c.get(v) || 0) + 1); }
        return JSON.stringify([...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map((e) => e[0])); })()""")
    await b.page.eval("(window.editor.objectShapeCache.clear(), 1)")
    for i, oid in enumerate(ids):
        await b.row(f"hover{w}.shape_{i + 1:02d}", f"window.editor.objectShape({oid})")
    await asyncio.sleep(2)
    after = await b.page.eval(metrics)
    await b.page.eval("(window.editor.objectShapeCache.clear(), window.editor.hoverObjectCanvas = null, 1)")
    try:
        await b.page.call("HeapProfiler.collectGarbage", timeout=60)
    except Exception:  # noqa: BLE001
        pass
    await asyncio.sleep(3)
    cleared = await b.page.eval(metrics)
    later = []
    if run_later:
        # after the cache was dropped the GPU process held about twice as much (runs 1-3): whether it comes back
        for wait_s in (20, 60):
            await asyncio.sleep(wait_s - (20 if wait_s == 60 else 0))
            await b.page.call("Page.bringToFront")
            later.append({"s": wait_s, **(await b.page.eval(metrics))})
    b.log(f"   hover memory {w}x{h}: before {before}, after {len(ids)} shapes {after}, cache cleared {cleared}, later {later}")
    b.rows.append({"name": f"hover{w}.memory", "hovermem": {"before": before, "after": after, "cleared": cleared, "shapes": len(ids), "later": later}})


async def probe_job(b, prefix, name, msg, reps=1):
    """One job in the forked utility process (__u0.P) with main's sampler and the renderer's IPC probe around it."""
    out = []
    for i in range(reps):
        await b.main.eval("__u0.reset()")
        await b.page.eval("window.__u0.probeStart()")
        r = await b.main.eval(f"__u0.pcall({msg})", timeout=900)
        await asyncio.sleep(0.05)
        pr = await b.page.eval("window.__u0.probeStop().then((p) => JSON.stringify(p))")
        r["probe"] = pr
        r["main"] = await b.main.eval("__u0.collect()")
        out.append(r)
        b.log(f"   {prefix}.{name}#{i + 1}: rtt {r['rtt']} ms, in process {r['ms']} ms, main block "
              f"{r['main']['blockMax']} ms, ipc rtt max {pr['max']} ms{'' if not r.get('error') else ', ' + r['error'][:160]}")
    b.rows.append({"name": f"{prefix}.{name}", "reps": out, "probe": True})
    return out


async def probe_files(b, work, models_dir):
    img_f = os.path.join(work, "probe_input_1024.rgba")
    dimg_f = os.path.join(work, "probe_depth_input.rgba")
    for js, f in (("window.__u0.img", img_f), ("window.__u0.dimg", dimg_f)):
        data = base64.b64decode(await b.page.eval(b64_of(js), timeout=120))
        with open(f, "wb") as fh:
            fh.write(data)
    dims = await b.page.eval("JSON.stringify({ dw: window.__u0.dw, dh: window.__u0.dh, outW: window.__u0.outW, outH: window.__u0.outH })")
    onnx = os.path.join(models_dir, "onnx")
    return img_f, dimg_f, dims, os.path.join(onnx, "sam2_hiera_base_plus.encoder.onnx"), os.path.join(onnx, "sam2_hiera_base_plus.decoder.onnx")


async def batchsize_batch(b, work, models_dir):
    """The decoder's batch size on DirectML: in the main batch every size but 1 and 64 failed after the first runs at
    1 and 64 ("Non-zero status code returned while running Mul node"). Here each size starts in a fresh utility process:
    a cold point (B 1), the object map at that size twice, then at 64 (the app's), then a point again."""
    img_f, _dimg_f, dims, enc, dec = await probe_files(b, work, models_dir)
    J = json.dumps
    img = f"__u0.read({J(img_f)})"
    await b.mem("start")
    for bs in (16, 32, 128, 256, 64):
        f = await b.main.eval(f"__u0.fork({J(PROBE)})", timeout=120)
        b.rows.append({"name": f"batch{bs}.fork", "fork": f})
        pre = f"batch{bs}"
        await probe_job(b, pre, "init", J({"type": "init", "device": "gpu"}))
        objs = lambda p: f"{{ type: 'objects', encoder: {J(enc)}, decoder: {J(dec)}, image: {img}, key: 'k1', outWidth: {dims['outW']}, outHeight: {dims['outH']}, params: {J(p)} }}"
        point = f"{{ type: 'segment', encoder: {J(enc)}, decoder: {J(dec)}, key: 'k1', image: {img}, points: [{{ x: 512, y: 512, label: 1 }}] }}"
        await probe_job(b, pre, "point_cold", point)
        await probe_job(b, pre, f"objects_b{bs}", objs({"pointsPerBatch": bs}), reps=2)
        if bs != 64:
            await probe_job(b, pre, "objects_b64_after", objs({"pointsPerBatch": 64}))
        await probe_job(b, pre, "point_after", point)
        await b.mem(f"batch {bs} after", [f["pid"]])
        await b.main.eval("(async () => { __u0.P.p.kill(); for (let i = 0; i < 200 && __u0.P.exited == null; i++) await new Promise((r) => setTimeout(r, 10)); return 1; })()")
        await asyncio.sleep(1.0)


async def probe_batch(b, outdir, models_dir, app_models):
    """The engine in a utility process: DirectML there, the copies, main meanwhile."""
    img_f, dimg_f, dims, enc, dec = await probe_files(b, outdir, models_dir)
    lite = os.path.join(models_dir, "onnx", "birefnet_lite.onnx")
    depth = os.path.join(app_models, "depth_anything_v2_small.onnx")
    J = json.dumps
    lite_model = {"id": "birefnet_lite", "label": "BiRefNet lite", "input": 1024, "mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225]}
    depth_model = {"id": "da2_small", "label": "Depth Anything V2 Small", "mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225]}
    await b.mem("start")
    for device in ("gpu", "cpu"):
        f = await b.main.eval(f"__u0.fork({J(PROBE)})", timeout=120)
        b.log(f"   probe {device}: forked {json.dumps(f)}")
        upid = f["pid"]
        b.rows.append({"name": f"probe_{device}.fork", "fork": f})

        async def pjob(name, msg, reps=1):
            return await probe_job(b, f"probe_{device}", name, msg, reps)

        await pjob("init", J({"type": "init", "device": device}))
        await b.mem(f"probe {device} started", [upid])
        img = f"__u0.read({J(img_f)})"
        # the main batch's order: a cold point, warm points, the object map on the cached embedding, points after it
        point = f"{{ type: 'segment', encoder: {J(enc)}, decoder: {J(dec)}, key: 'k1', points: [{{ x: 512, y: 512, label: 1 }}] }}"
        await pjob("point_cold", f"{{ type: 'segment', encoder: {J(enc)}, decoder: {J(dec)}, key: 'k1', image: {img}, points: [{{ x: 512, y: 512, label: 1 }}] }}")
        await pjob("point_warm", point, reps=5)
        await pjob("objects_cached", f"{{ type: 'objects', encoder: {J(enc)}, decoder: {J(dec)}, image: {img}, key: 'k1', outWidth: {dims['outW']}, outHeight: {dims['outH']} }}", reps=2)
        await pjob("point_after_objects", point, reps=3)
        await b.mem(f"probe {device} after SAM2", [upid])
        await pjob("cutout_lite", f"{{ type: 'cutout', file: {J(lite)}, model: {J(lite_model)}, image: {img} }}", reps=2)
        await pjob("depth", f"{{ type: 'depth', file: {J(depth)}, model: {J(depth_model)}, image: __u0.read({J(dimg_f)}), width: {dims['dw']}, height: {dims['dh']} }}", reps=3)
        await b.mem(f"probe {device} after cutout and depth", [upid])
        await pjob("free", J({"type": "free"}))
        await b.mem(f"probe {device} after free", [upid])
        if device == "gpu":
            for mb in (4, 8, 16):
                await pjob(f"echo_{mb}mb", f"{{ type: 'echo', data: new Uint8Array({mb} * 1048576) }}", reps=5)
            await pjob("mem", J({"type": "mem"}))
        k = await b.main.eval("(async () => { const t = performance.now(); __u0.P.p.kill(); for (let i = 0; i < 200 && __u0.P.exited == null; i++) await new Promise((r) => setTimeout(r, 10)); return JSON.stringify({ exited: __u0.P.exited, exitMs: __u0.P.exitAt ? +(__u0.P.exitAt - t).toFixed(1) : null }); })()")
        b.log(f"   probe_{device}.kill: {json.dumps(k)}")
        b.rows.append({"name": f"probe_{device}.kill", "kill": k})
        await asyncio.sleep(1.0)
        await b.mem(f"probe {device} after kill", [upid])


# ---- the chain ------------------------------------------------------------------------------------------------------

async def run_batch(args, batch, run, log):
    raw = os.path.join(args.out, "raw")
    os.makedirs(raw, exist_ok=True)
    device = {"gpu": "gpu", "cpu": "cpu", "editor": "auto", "probe": "auto", "batchsize": "auto", "hovermem": "auto"}[batch]
    profile = os.path.join(args.profiles, f"{batch}_r{run}")
    applog = os.path.join(raw, f"app_{batch}_r{run}.log")
    token = None if args.no_lock else lock_acquire(f"U0 measuring ({batch} r{run})", log)
    if not args.no_lock and not token:
        log("lock not taken: measured without it")
    result = {"batch": batch, "run": run, "device": device, "started": time.strftime("%Y-%m-%dT%H:%M:%S")}
    proc = None
    try:
        result["others"] = [] if args.no_lock else wait_others(args.port, log)
        result["card_before_start"] = gpu_mem([])["cardMB"]
        proc = start(profile, applog, args.port, args.inspect, device, args.models_dir, args.app_models)
        async with aiohttp.ClientSession() as s:
            for _ in range(120):
                try:
                    if any(t.get("type") == "page" and "scumble://" in t.get("url", "") for t in await targets(s, args.port)):
                        break
                except Exception:  # noqa: BLE001
                    pass
                await asyncio.sleep(1)
            page_t = next(t for t in await targets(s, args.port) if t.get("type") == "page" and "scumble://" in t.get("url", "") and "comfybar" not in t.get("url", ""))
            node_t = (await targets(s, args.inspect))[0]
            async with s.ws_connect(page_t["webSocketDebuggerUrl"], max_msg_size=256 << 20) as pws, \
                    s.ws_connect(node_t["webSocketDebuggerUrl"], max_msg_size=256 << 20) as mws:
                page, main = Cdp(pws), Cdp(mws, cli=True)
                for _ in range(60):
                    try:
                        if await page.eval("(async () => { await import('./shell.js'); return !!window.editor; })()"):
                            break
                    except Exception:  # noqa: BLE001
                        pass
                    await asyncio.sleep(1)
                await asyncio.sleep(6)
                await page.call("Page.bringToFront")
                result["main_setup"] = await main.eval(MAIN_SETUP)
                result["page_setup"] = await page.eval(PAGE_SETUP)
                pid = result["main_setup"]["pid"]
                log(f"== {batch} r{run}: main pid {pid}, {json.dumps(result['main_setup'])}")
                b = Batch(page, main, pid, log)
                if batch in ("gpu", "cpu", "probe", "batchsize"):
                    result["image"] = args.image
                    result["prep"] = await page.eval(PREP.replace("@@IMAGE@@", json.dumps(args.image)), timeout=600)
                    log(f"   prep: {json.dumps(result['prep'])}")
                try:
                    if batch in ("gpu", "cpu"):
                        await helper_batch(b, device, args.quick)
                    elif batch == "editor":
                        imgs = editor_images(args.work, args.image)
                        result["images"] = imgs
                        await editor_batch(b, imgs[:1] if args.quick else imgs)
                    elif batch == "hovermem":
                        await hovermem_batch(b, editor_images(args.work, args.image), run_later=run >= 4)
                    elif batch == "batchsize":
                        await batchsize_batch(b, args.work, args.models_dir)
                    else:
                        await probe_batch(b, args.work, args.models_dir, args.app_models)
                except Exception as e:  # noqa: BLE001 - keep what was measured
                    result["error"] = str(e)[:800]
                    log(f"   ERROR {e}")
                result["rows"], result["mems"] = b.rows, b.mems
                result["focus_end"] = await page.eval("JSON.stringify({ focus: document.hasFocus(), vis: document.visibilityState })")
    finally:
        if proc:
            close(args.port, proc)
        time.sleep(3)
        lock_release(token, log)
    with open(os.path.join(raw, f"{batch}_r{run}.json"), "w", encoding="utf-8", newline=chr(10)) as f:
        json.dump(result, f, indent=1)
    return result


# ---- the summary ----------------------------------------------------------------------------------------------------

def fmt(xs, nd=0):
    xs = [x for x in xs if isinstance(x, (int, float))]
    if not xs:
        return "-"
    m = statistics.median(xs)
    f = f"{{:.{nd}f}}"
    return f"{f.format(m)} [{f.format(min(xs))}-{f.format(max(xs))}]" if len(xs) > 1 else f.format(m)


def breakdown(rep):
    """What main did during one call, from the wrappers' events."""
    ev = (rep.get("main") or {}).get("ev") or []
    o = {"handler": sum(e["ms"] for e in ev if e["k"] == "handler"),
         "create": sum(e["ms"] for e in ev if e["k"] == "create"),
         "creates": [(e["f"], e["p"], round(e["ms"])) for e in ev if e["k"] in ("create", "createFail")],
         "enc_run": sum(e["ms"] for e in ev if e["k"] == "run" and "encoder" in e["f"]),
         "dec_runs": [e["ms"] for e in ev if e["k"] == "run" and "decoder" in e["f"]],
         "other_runs": sum(e["ms"] for e in ev if e["k"] == "run" and "encoder" not in e["f"] and "decoder" not in e["f"]),
         "release": sum(e["ms"] for e in ev if e["k"] == "release"),
         "proc": sum(e["ms"] or 0 for e in ev if e["k"] == "job"),
         "proc_wall": sum(e["wallMs"] or 0 for e in ev if e["k"] == "job")}
    am = [e for e in ev if e["k"] == "automask"]
    if am:
        a = am[0]
        inside = [e for e in ev if e["k"] == "run" and "decoder" in e["f"] and a["t0"] <= e["t0"] <= a["t0"] + a["ms"]]
        dec = sum(e["ms"] for e in inside)
        o["automask"] = a["ms"]
        o["automask_decode"] = dec
        o["automask_js"] = a["ms"] - dec
        o["batches"] = len(inside)
        if inside:
            gaps = [inside[i + 1]["t0"] - (inside[i]["t0"] + inside[i]["ms"]) for i in range(len(inside) - 1)]
            tail = a["t0"] + a["ms"] - (inside[-1]["t0"] + inside[-1]["ms"])
            o["filter_per_batch"] = statistics.mean(gaps) if gaps else None
            o["nms_paint"] = tail - (statistics.mean(gaps) if gaps else 0)
    en = [e for e in ev if e["k"] == "encode"]
    if en:
        o["encode"] = en[0]["ms"]
        o["encode_js"] = en[0]["ms"] - o["enc_run"] - sum(e["ms"] for e in ev if e["k"] == "create" and "encoder" in e["f"])
    o["ipc"] = rep["wall"] - o["handler"] if o["handler"] else None
    return o


def summarize(out):
    files = sorted(glob.glob(os.path.join(out, "raw", "*.json")))
    data = [json.load(open(f, encoding="utf-8")) for f in files]
    lines = ["U0 of docs/PLAN_WASM_BUILD.md §7: the in-app ONNX helpers, measured (tools/helpers_perf.py).",
             "Times in ms, median [min-max] over the fresh runs (each run one instance; rows with several reps: every rep).",
             "wall = the renderer's await of the IPC call; block = main's longest event-loop gap (sampler, 4 ms);",
             "rtt = the longest app:tileMode round trip from the renderer during the call; handler = main's IPC handler.",
             ""]
    for batch in ("gpu", "cpu", "editor", "probe", "batchsize", "hovermem"):
        runs = [d for d in data if d["batch"] == batch]
        if not runs:
            continue
        lines.append(f"== batch {batch} (device {runs[0]['device']}), runs {[d['run'] for d in runs]}")
        for d in runs:
            if d.get("others"):
                lines.append(f"   r{d['run']}: measured beside {d['others']}")
            if d.get("error"):
                lines.append(f"   r{d['run']}: ERROR {d['error']}")
            fe = d.get("focus_end") or {}
            if fe and not (fe.get("focus") and fe.get("vis") == "visible"):
                lines.append(f"   r{d['run']}: the window was not focused / visible at the end: {fe}")
        names = []
        for d in runs:
            for r in d.get("rows", []):
                if r["name"] not in names:
                    names.append(r["name"])
        for n in names:
            reps = [rep for d in runs for r in d.get("rows", []) if r["name"] == n for rep in r.get("reps", [])]
            first = [r["reps"][0] for d in runs for r in d.get("rows", []) if r["name"] == n and r.get("reps")]
            if not reps:
                extra = [r for d in runs for r in d.get("rows", []) if r["name"] == n]
                if extra and extra[0].get("prep"):
                    lines.append(f"   {n:34s} " + "; ".join(json.dumps(x["prep"]) for x in extra))
                elif extra and extra[0].get("fork"):
                    lines.append(f"   {n:34s} spawn {fmt([x['fork']['spawnMs'] for x in extra], 1)}")
                elif extra and extra[0].get("hovermem"):
                    for x in extra:
                        hm = x["hovermem"]
                        lines.append(f"   {n:34s} renderer / GPU process private MB: before {hm['before']}, after {hm['shapes']} shapes {hm['after']}, cache cleared {hm['cleared']}"
                                     + (f", later {hm['later']}" if hm.get("later") else ""))
                elif extra and extra[0].get("kill"):
                    lines.append(f"   {n:34s} kill -> exit {fmt([x['kill'].get('exitMs') for x in extra], 1)} ms")
                continue
            if reps[0].get("rtt") is not None and "wall" not in reps[0]:   # a probe job
                lines.append(f"   {n:34s} rtt {fmt([x['rtt'] for x in reps])}  in process {fmt([x['ms'] for x in reps])}"
                             f"  main block {fmt([x['main']['blockMax'] for x in reps])}  ipc rtt max {fmt([x['probe']['max'] for x in reps])}"
                             + (f"  res {json.dumps(reps[0].get('res'))[:160]}" if reps[0].get("res") else "")
                             + (f"  ERR {reps[0]['error'][:120]}" if reps[0].get("error") else ""))
                continue
            bd = [breakdown(x) for x in reps]
            line = (f"   {n:34s} wall {fmt([x['wall'] for x in reps])}  block {fmt([x['main']['blockMax'] for x in reps])}"
                    f"  rtt {fmt([x['probe']['max'] for x in reps])}")
            if any(x["handler"] for x in bd):
                line += f"  handler {fmt([x['handler'] for x in bd])}  ipc {fmt([x['ipc'] for x in bd])}"
            if any(x["create"] for x in bd):
                line += f"  create {fmt([x['create'] for x in bd])} {bd[0]['creates']}"
            if any(x["enc_run"] for x in bd):
                line += f"  enc.run {fmt([x['enc_run'] for x in bd])}"
            if any(x.get("encode_js") is not None for x in bd):
                line += f"  enc.js {fmt([x.get('encode_js') for x in bd])}"
            if any(x.get("automask") for x in bd):
                line += (f"  automask {fmt([x.get('automask') for x in bd])} (decode {fmt([x.get('automask_decode') for x in bd])}"
                         f" in {bd[0].get('batches')} batches, js {fmt([x.get('automask_js') for x in bd])}: filter/batch "
                         f"{fmt([x.get('filter_per_batch') for x in bd], 1)}, nms+paint {fmt([x.get('nms_paint') for x in bd])})")
            elif any(x["dec_runs"] for x in bd):
                line += f"  dec.run {fmt([sum(x['dec_runs']) for x in bd], 1)}"
            if any(x["other_runs"] for x in bd):
                line += f"  run {fmt([x['other_runs'] for x in bd])}"
            if any(x["proc"] for x in bd):
                line += f"  proc {fmt([x['proc'] for x in bd])} (post -> answer {fmt([x['proc_wall'] for x in bd])})"
            if any(x["release"] for x in bd):
                line += f"  release {fmt([x['release'] for x in bd])}"
            parts = {}
            for x in reps:
                for p in x.get("parts") or []:
                    parts.setdefault(p["k"], []).append(p["ms"])
            if parts:
                line += "  parts " + ", ".join(f"{k} {fmt(v)}" for k, v in parts.items())
            # findObjects' nearest scale of the label map to the document, between the helper call and applySegmentIds
            scale = []
            for x in reps:
                ps_ = {p["k"]: p for p in x.get("parts") or []}
                if "helperCall" in ps_ and "applySegmentIds" in ps_:
                    hc = ps_["helperCall"]
                    scale.append(ps_["applySegmentIds"]["at"] - (hc["at"] + hc["ms"]))
            if scale:
                line += f"  scale-back {fmt(scale)}"
            rg = [x["probe"].get("rendGapMax") for x in reps]
            if any(g for g in rg):
                line += f"  renderer gap {fmt(rg)}"
            res = first[0].get("res") if first else None
            if isinstance(res, dict):
                keep = {k: v for k, v in res.items() if k in ("count", "candidates", "provider", "seconds", "score", "encodeMs", "width", "height", "runMs", "size")}
                if keep:
                    line += f"  res {json.dumps(keep)}"
            errs = [x.get("err") for x in reps if x.get("err")]
            if errs:
                line += f"  ERR {errs[0][:100]}"
            lines.append(line)
        # memory
        labels = []
        for d in runs:
            for m in d.get("mems", []):
                if m["label"] not in labels:
                    labels.append(m["label"])
        if labels:
            lines.append("   memory (MB; main private after a forced GC, main rss, GPU dedicated / shared of main [and the probe], the card's used MiB):")
            for lab in labels:
                ms = [m for d in runs for m in d.get("mems", []) if m["label"] == lab]
                priv = [((m["main"] or {}).get("main") or {}).get("privMB") for m in ms]
                rss = [(m["main"] or {}).get("rssMB") for m in ms]
                pids = [str(d["main_setup"]["pid"]) for d in runs for m in d.get("mems", []) if m["label"] == lab]
                ded = [((m["gpu"]["procs"].get(p) or {}).get("dedicatedMB", 0)) for m, p in zip(ms, pids)]
                sh = [((m["gpu"]["procs"].get(p) or {}).get("sharedMB", 0)) for m, p in zip(ms, pids)]
                util = [sum((v or {}).get("dedicatedMB", 0) for k, v in m["gpu"]["procs"].items() if k != p) for m, p in zip(ms, pids)]
                uprv = [sum(u.get("privMB", 0) for u in ((m["main"] or {}).get("utility") or []) if "U0" in (u.get("name") or "") or "helpers" in (u.get("name") or "")) for m in ms]
                card = [m["gpu"]["cardMB"] for m in ms]
                lines.append(f"     {lab:46s} priv {fmt(priv)}  rss {fmt(rss)}  gpu {fmt(ded)} / {fmt(sh)}"
                             + (f"  probe gpu {fmt(util)} priv {fmt(uprv)}" if any(util) or any(uprv) else "")
                             + f"  card {fmt(card)}")
        lines.append("")
    text = "\n".join(lines) + "\n"
    with open(os.path.join(out, "summary.txt"), "w", encoding="utf-8", newline=chr(10)) as f:
        f.write(text)
    print(text)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--runs", default="1,2,3")
    ap.add_argument("--batches", default="gpu,cpu,editor,probe")
    ap.add_argument("--port", type=int, default=9588)
    ap.add_argument("--inspect", type=int, default=9598)
    ap.add_argument("--no-lock", action="store_true")
    ap.add_argument("--models-dir", default=COMFY_MODELS)
    ap.add_argument("--app-models", default=APP_MODELS)
    ap.add_argument("--work", default=os.path.join(os.environ.get("TEMP", "."), "scumble_u0"),
                    help="profiles and the editor batch's scaled pictures (never under --out)")
    ap.add_argument("--image", default=IMAGE)
    ap.add_argument("--skip", default="", help="run:batch pairs already measured, e.g. 1:gpu")
    ap.add_argument("--gap", type=int, default=90, help="seconds the lock stays free between batches")
    ap.add_argument("--summarize", action="store_true")
    ap.add_argument("--quick", action="store_true", help="SAM2 base+, BiRefNet lite and depth only (a dry run)")
    args = ap.parse_args()
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    if args.summarize:
        summarize(args.out)
        return
    os.makedirs(args.work, exist_ok=True)
    args.profiles = os.path.join(args.work, "profiles")
    logf = open(os.path.join(args.out, "chain.log"), "a", encoding="utf-8")

    def log(s):
        line = f"[{time.strftime('%H:%M:%S')}] {s}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    log(f"U0 chain: runs {args.runs}, batches {args.batches}, port {args.port}, inspect {args.inspect}, models {args.models_dir}")
    first = True
    for run in [int(x) for x in args.runs.split(",")]:
        for batch in args.batches.split(","):
            if f"{run}:{batch}" in args.skip.split(","):
                continue
            if not first and not args.no_lock and args.gap:
                # the lock stays free for a while, so an agent that checks it every 60 s can start its gates; the next
                # batch then waits for them (wait_others)
                log(f"gap: the lock is free for {args.gap} s")
                time.sleep(args.gap)
            first = False
            try:
                await run_batch(args, batch, run, log)
            except Exception as e:  # noqa: BLE001 - the next batch still runs
                log(f"batch {batch} r{run} failed: {e}")
    shutil.rmtree(args.profiles, ignore_errors=True)
    summarize(args.out)
    log("done")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())
