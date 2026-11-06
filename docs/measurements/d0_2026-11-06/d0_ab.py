"""D0's same-state A/B (the review's confound finding): the 15k PSD open on the final D0 build, the pool route against
the window's reader (`InpaintEditor.psdOnPool = false`), alternating fresh instances in one machine state.

Each run is d0_chain.py's run (a fresh offline instance, tiles on, its own profile; tools/native_test.py 15000x10000
add_the_paint_layer export_psd save_psd open_psd, the real 925 MB PSD saved through host.saveExport and opened from that
file into a new tab). For the window's runs the class switch is set over CDP before native_test starts. A run whose
open_psd row ran with the window behind (`focused` false) is NOT COUNTED and tried again, up to three times. Before every
run the main session's lock file is waited for (at most 45 minutes, the wait logged) and the GPU's state is logged.

    python d0_ab.py OUTDIR [RUNS] [FIRST]

OUTDIR/pool/ab-pool-rN.json and OUTDIR/window/ab-window-rN.json (with .log), OUTDIR/chain.log.
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = r"F:\canvas"
SCRATCH = r"C:\Users\SCHOEN~1\AppData\Local\Temp\claude\F--canvas\543d44fb-4d2d-4818-8804-974916d10a44\scratchpad"
LOCK = os.path.join(SCRATCH, "machine_busy.lock")
ROWS = ["add_the_paint_layer", "export_psd", "save_psd", "open_psd"]

OUT = os.path.abspath(sys.argv[1])   # native_test runs in F:/canvas: a relative --json would land there
RUNS = int(sys.argv[2]) if len(sys.argv) > 2 else 3
FIRST = int(sys.argv[3]) if len(sys.argv) > 3 else 1   # the first run number (a pair added to a chain)
os.makedirs(OUT, exist_ok=True)
CHAIN = os.path.join(OUT, "chain.log")


def log(s):
    line = time.strftime("[%H:%M:%S] ") + s
    print(line, flush=True)
    with open(CHAIN, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def wait_lock():
    t0 = time.time()
    if not os.path.exists(LOCK):
        return 0
    log("machine_busy.lock exists: waiting")
    while os.path.exists(LOCK) and time.time() - t0 < 45 * 60:
        time.sleep(60)
    waited = time.time() - t0
    log(f"waited {waited:.0f} s for the lock ({'gone' if not os.path.exists(LOCK) else 'still there, going on'})")
    return waited


def up():
    try:
        urllib.request.urlopen("http://127.0.0.1:9555/json/version", timeout=1).read()
        return True
    except Exception:
        return False


def gpu():
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader"], capture_output=True, text=True, timeout=20)
        return r.stdout.strip()
    except Exception as e:
        return f"(nvidia-smi: {e})"


def one(tag, out, window):
    if up():
        raise SystemExit("an instance answers on 9555 already: close it first")
    prof = os.path.join(SCRATCH, "d0", "profile_" + tag)
    files = os.path.join(SCRATCH, "d0", "files_" + tag)
    shutil.rmtree(prof, ignore_errors=True)
    shutil.rmtree(files, ignore_errors=True)
    os.makedirs(prof)
    os.makedirs(files)
    applog = open(os.path.join(out, f"app_{tag}.log"), "w")
    app = subprocess.Popen([os.path.join(ROOT, r"node_modules\electron\dist\electron.exe"), ".", "--remote-debugging-port=9555",
                            "--user-data-dir=" + prof, "--no-comfy"], cwd=ROOT, stdout=applog, stderr=subprocess.STDOUT)
    for _ in range(240):
        if up():
            break
        time.sleep(0.5)
    time.sleep(8)
    switch = None
    if window:
        r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "cdp.py"), "eval", "(window.editor.constructor.psdOnPool = false, String(window.editor.constructor.psdOnPool))"],
                           cwd=ROOT, env=dict(os.environ, SCUMBLE_CDP_PORT="9555"), capture_output=True, text=True, timeout=60)
        switch = r.stdout.strip()
    js = os.path.join(out, tag + ".json")
    cmd = [sys.executable, os.path.join(ROOT, "tools", "native_test.py"), "15000x10000", "--out", files, "--json", js]
    r = subprocess.run(cmd + ROWS, cwd=ROOT, capture_output=True, text=True, timeout=3000)
    with open(os.path.join(out, tag + ".log"), "w", encoding="utf-8") as f:
        f.write(("switch: " + str(switch) + "\n" if window else "") + r.stdout + "\n--- stderr\n" + r.stderr)
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "close_app.py")], cwd=ROOT, env=dict(os.environ, SCUMBLE_CDP_PORT="9555"), capture_output=True, timeout=120)
    try:
        app.wait(timeout=90)
    except subprocess.TimeoutExpired:
        app.kill()
    applog.close()
    row = None
    try:
        row = json.load(open(js, encoding="utf-8"))["rows"].get("open_psd", {}).get("row")
    except Exception as e:
        log(f"{tag}: no json ({e}); rc={r.returncode}")
    shutil.rmtree(prof, ignore_errors=True)
    shutil.rmtree(files, ignore_errors=True)
    return row, switch, r.returncode


head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
log(f"ab: {RUNS} runs per route, alternating pool / window, rows {' '.join(ROWS)}; HEAD {head} plus the D0 diff")
for n in range(FIRST, FIRST + RUNS):
    for route in ("pool", "window"):
        out = os.path.join(OUT, route)
        os.makedirs(out, exist_ok=True)
        for attempt in range(1, 4):
            wait_lock()
            tag = f"ab-{route}-r{n}" + ("" if attempt == 1 else f"-try{attempt}")
            log(f"{tag}: gpu {gpu()}")
            row, switch, rc = one(tag, out, route == "window")
            route_seen = None
            if row:
                lo = ((row.get("marks") or {}).get("layered_open") or [{}])[0]
                route_seen = (lo.get("extra") or {}).get("route") or "window"
                log(f"{tag}: rc={rc} open_psd wall {row.get('wall')} blocked {row.get('blocked')} focused {row.get('focused')} route {route_seen}" + (f" switch {switch}" if switch is not None else ""))
            if route_seen and route_seen != route:
                log(f"{tag}: the row ran the {route_seen} route, not {route}: stopping")
                raise SystemExit(2)
            if row and row.get("focused"):
                break
            log(f"{tag}: NOT COUNTED (the window was behind or the row did not run)")
log("done")
