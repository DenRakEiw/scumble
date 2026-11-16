"""The Ctrl+O measurement (docs/BUGS.md "Ctrl+O sends the whole file to the window in one message", 2026-11-16).

One fresh dev instance per run (its own profile, --no-comfy, tiles on), the window brought to the front. Each run opens
one file into an empty tab by one route and records, from the window's thread:

  transfer   t0 (the route starts) -> the editor's loadFile is entered: what the route costs before any reader runs
  xblock     the longest heartbeat gap (setTimeout 0, gaps over 50 ms) inside the transfer
  xlong      the long tasks (PerformanceObserver "longtask") inside the transfer, summed
  wall       t0 -> loadFile returned (the picture in)
  block      the longest heartbeat gap of the whole run

Routes:
  ctrlo   File > Open's route without the dialog: the dev-only hook file:testOpen(path) (main's openChosen)
  load    load_image over the command core (commands_util.js fileFrom: window.scumble.file.read before the fix)
  drop    a disk-backed File (an <input type=file> given the path over CDP, DOM.setFileInputFiles) handed to loadFile,
          as the editor's drop handler does

Usage (no other instance on the port):
    python docs/measurements/ctrlo_2026-11-16/ctrlo.py --port 9585 --out <json> --runs 3 FILE [FILE ...]
    python docs/measurements/ctrlo_2026-11-16/ctrlo.py --port 9585 --ceiling <dir>   (the one-message ceiling)
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools"))


def opt(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        v = sys.argv[i + 1]
        del sys.argv[i:i + 2]
        return v
    return default


PORT = int(opt("--port", "9585"))
OUT = opt("--out")
RUNS = int(opt("--runs", "3"))
ROUTES = opt("--routes", "ctrlo,load,drop").split(",")
CEILING = opt("--ceiling")
FILES = sys.argv[1:]
os.environ["SCUMBLE_CDP_PORT"] = str(PORT)
import cdp  # noqa: E402
cdp.PORT = PORT

PRE = r"""(async () => {
    const commands = (await import('./commands.js')).commands, host = (await import('./editor/host.js')).host;
    await import('./shell.js');
    const lt = [];
    const ob = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push([e.startTime, e.duration]); });
    ob.observe({ entryTypes: ["longtask"] });
    const gaps = [];
    let last = performance.now(), on = true;
    const beat = () => { const n = performance.now(); if (n - last > 50) gaps.push([last, n - last]); last = n; if (on) setTimeout(beat, 0); };
    setTimeout(beat, 0);
    const d = await commands.run("new_document");
    await commands.run("activate_document", { doc: d.id });
    const ed = host.editors().find((e) => e.node.id === d.id);
    const T = { enter: null, done: null, err: null };
    const orig = ed.loadFile.bind(ed);
    ed.loadFile = (f, o) => { T.enter = performance.now(); T.size = f && f.size; return orig(f, o).then((r) => { T.done = performance.now(); return r; }, (e) => { T.done = performance.now(); T.err = String(e); throw e; }); };
    window.__m = { commands, host, ed, d, lt, gaps, T, stop: () => { on = false; ob.disconnect(); } };
    return d.id;
})()"""

GO = r"""(async () => {
    const M = window.__m, route = %(route)s, file = %(file)s;
    await new Promise((r) => setTimeout(r, 300));
    const t0 = performance.now();
    let err = null;
    try {
        if (route === "ctrlo") await window.scumble.file.testOpen(file);
        else if (route === "load") await M.commands.run("load_image", { doc: M.d.id, path: file });
        else { const f = document.getElementById("__ctrlo").files[0]; await M.ed.loadFile(f); }
    } catch (e) { err = String(e.message || e); }
    const until = Date.now() + 600000;
    while (M.T.done === null && !err && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 400));
    M.stop();
    const enter = M.T.enter, done = M.T.done;
    const inX = (s) => enter !== null && s >= t0 && s < enter;
    const xg = M.gaps.filter(([s, g]) => inX(s) || (s < t0 && s + g > t0));
    const xl = M.lt.filter(([s]) => inX(s));
    const all = M.gaps.filter(([s, g]) => s + g > t0 && (done === null || s < done));
    const r = (v) => (v === null || v === undefined ? null : Math.round(v));
    return { route, file, err: err || M.T.err, size: M.T.size, width: M.ed.width, height: M.ed.height, layers: M.ed.layers.length,
        transfer: enter === null ? null : r(enter - t0), xblock: r(Math.max(0, ...xg.map((g) => g[1]))), xlong: r(xl.reduce((a, b) => a + b[1], 0)),
        wall: done === null ? null : r(done - t0), block: r(Math.max(0, ...all.map((g) => g[1]))),
        gapsInTransfer: xg.map(([s, g]) => [r(s - t0), r(g)]), status: M.ed.status };
})()"""


def up():
    try:
        urllib.request.urlopen("http://127.0.0.1:%d/json/version" % PORT, timeout=1).read()
        return True
    except Exception:
        return False


def start(prof):
    exe = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
    app = subprocess.Popen([exe, ".", "--remote-debugging-port=%d" % PORT, "--user-data-dir=" + prof, "--no-comfy"], cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(240):
        if up():
            break
        time.sleep(0.5)
    time.sleep(8)
    return app


def stop(app):
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "close_app.py")], cwd=ROOT, env=dict(os.environ, SCUMBLE_CDP_PORT=str(PORT)), capture_output=True, timeout=180)
    try:
        app.wait(timeout=90)
    except subprocess.TimeoutExpired:
        app.kill()


async def one(c, route, path):
    await c.call("Page.bringToFront")
    await c.call("Emulation.setFocusEmulationEnabled", enabled=True)
    await c.eval(PRE, timeout=120)
    if route == "drop":
        await c.eval("(() => { const i = document.createElement('input'); i.type = 'file'; i.id = '__ctrlo'; i.style.display = 'none'; document.body.appendChild(i); return 1; })()")
        doc = await c.call("DOM.getDocument", depth=1)
        q = await c.call("DOM.querySelector", nodeId=doc["root"]["nodeId"], selector="#__ctrlo")
        await c.call("DOM.setFileInputFiles", files=[path], nodeId=q["nodeId"])
    return await c.eval(GO % {"route": json.dumps(route), "file": json.dumps(path.replace("\\", "/"))}, timeout=900)


def measure():
    rows = []
    for path in FILES:
        for n in range(RUNS):
            for route in ROUTES:
                prof = tempfile.mkdtemp(prefix="ctrlo_prof_")
                app = start(prof)
                try:
                    res = asyncio.run(cdp.session(lambda c: one(c, route, os.path.abspath(path))))
                except Exception as e:  # a renderer that went away is a row too
                    res = {"route": route, "file": path, "err": "harness: " + str(e)[:300]}
                finally:
                    stop(app)
                    shutil.rmtree(prof, ignore_errors=True)
                res["run"] = n + 1
                print(json.dumps(res), flush=True)
                rows.append(res)
    if OUT:
        with open(OUT, "w", encoding="utf-8", newline=chr(10)) as f:
            json.dump(rows, f, indent=1)


CEIL = r"""(async () => {
    const file = %(file)s, how = %(how)s;
    const t0 = performance.now();
    try {
        let size;
        if (how === "read") { const r = await window.scumble.file.read(file); size = r.data.byteLength; }
        else {
            const g = await window.scumble.file.grant(file);
            try { const res = await fetch(g.url); if (!res.ok) throw new Error(res.status + " " + await res.text()); size = (await res.blob()).size; }
            finally { await window.scumble.file.release(g.token); }
        }
        return { how, ok: true, size, ms: Math.round(performance.now() - t0) };
    } catch (e) { return { how, ok: false, err: String(e.message || e).slice(0, 300), ms: Math.round(performance.now() - t0) }; }
})()"""


def ceiling():
    """main -> window in one message (file:read's reply, the same serialisation as file:opened's send), sparse files of
    growing size; each size on a fresh instance (a renderer that ends takes the instance's page with it)."""
    sizes = [512, 768, 1024, 1536, 2047, 2600]
    os.makedirs(CEILING, exist_ok=True)
    rows = []
    for how in ROUTES:
        for mb in sizes:
            p = os.path.join(CEILING, "sparse_%d.bin" % mb)
            if not os.path.exists(p):
                with open(p, "wb") as f:
                    f.truncate(mb * 1048576)
            prof = tempfile.mkdtemp(prefix="ctrlo_ceil_")
            app = start(prof)
            try:
                res = asyncio.run(cdp.session(lambda c: c.eval(CEIL % {"file": json.dumps(p.replace("\\", "/")), "how": json.dumps(how)}, timeout=600)))
                alive = up() and asyncio.run(cdp.session(lambda c: c.eval("1+1", timeout=20))) == 2
            except Exception as e:
                res, alive = {"how": how, "ok": False, "err": "harness: " + str(e)[:300]}, up()
            finally:
                stop(app)
                shutil.rmtree(prof, ignore_errors=True)
            res.update({"MB": mb, "page_alive_after": alive})
            print(json.dumps(res), flush=True)
            rows.append(res)
    if OUT:
        with open(OUT, "w", encoding="utf-8", newline=chr(10)) as f:
            json.dump(rows, f, indent=1)


if CEILING:
    ceiling()
else:
    measure()
