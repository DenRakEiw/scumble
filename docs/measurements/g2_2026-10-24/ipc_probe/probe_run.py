"""G2's IPC probe: one call of window.scumble.file.save per fresh instance (docs/BUGS.md, K0a's save crash).

usage: probe_run.py OUTDIR step:MB [step:MB ...]   (steps of k0a_save_probe2.py: bytes, ipc)
Each call gets its own profile and instance; the instance's scumble.log is copied next to the output so a renderer
end ("oom") shows. Run from F:/canvas.
"""
import os
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = r"F:\canvas"
PORT = "9555"
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)


def up():
    try:
        urllib.request.urlopen("http://127.0.0.1:%s/json/version" % PORT, timeout=1).read()
        return True
    except Exception:  # noqa: BLE001
        return False


for spec in sys.argv[2:]:
    step, mb = spec.split(":")
    prof = os.path.join(OUT, "profile_%s_%s" % (step, mb))
    shutil.rmtree(prof, ignore_errors=True)
    os.makedirs(prof)
    shutil.copy(os.path.join(ROOT, "tools", "test_base.png"), prof) if os.path.exists(os.path.join(ROOT, "tools", "test_base.png")) else None
    log = open(os.path.join(OUT, "app_%s_%s.log" % (step, mb)), "w")
    app = subprocess.Popen([os.path.join(ROOT, r"node_modules\electron\dist\electron.exe"), ".", "--remote-debugging-port=" + PORT,
                            "--user-data-dir=" + prof, "--no-comfy"], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(120):
        if up():
            break
        time.sleep(0.5)
    time.sleep(6)   # the window's start (restore, plugins)
    t = time.time()
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "k0a_save_probe2.py"), step, mb],
                       cwd=ROOT, capture_output=True, text=True, timeout=900)
    took = time.time() - t
    time.sleep(8)   # a renderer end shows in the log a few seconds after
    sl = os.path.join(prof, "scumble.log")
    ends = []
    if os.path.exists(sl):
        shutil.copy(sl, os.path.join(OUT, "scumble_%s_%s.log" % (step, mb)))
        ends = [ln.strip() for ln in open(sl, encoding="utf-8", errors="replace") if "gone" in ln or "oom" in ln or "crash" in ln.lower()]
    print("%s %s MB: %s (%.1f s)%s" % (step, mb, (r.stdout.strip() or r.stderr.strip()[-300:]), took,
                                       ("  renderer: " + " | ".join(ends[:3])) if ends else ""), flush=True)
    env = dict(os.environ, SCUMBLE_CDP_PORT=PORT)
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "close_app.py")], cwd=ROOT, env=env, capture_output=True, timeout=60)
    try:
        app.wait(timeout=30)
    except subprocess.TimeoutExpired:
        app.kill()
    log.close()
    p = r"F:/canvas/dist/gates/k0a_2026-10-23/save_probe/probe2.bin"
    if os.path.exists(p):
        os.remove(p)
