"""Start a fresh offline instance (tiles on), run the branch's native_test.py rows against it, close it."""
import os, shutil, subprocess, sys, time, urllib.request
ROOT = r"F:\canvas"
OUT = sys.argv[1]
rows = sys.argv[2:]
os.makedirs(OUT, exist_ok=True)
prof = os.path.join(OUT, "profile")
shutil.rmtree(prof, ignore_errors=True)
os.makedirs(prof)
log = open(os.path.join(OUT, "app.log"), "w")
app = subprocess.Popen([os.path.join(ROOT, r"node_modules\electron\dist\electron.exe"), ".", "--remote-debugging-port=9555",
                        "--user-data-dir=" + prof, "--no-comfy"], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
for _ in range(120):
    try:
        urllib.request.urlopen("http://127.0.0.1:9555/json/version", timeout=1).read(); break
    except Exception:
        time.sleep(0.5)
time.sleep(6)
here = os.path.dirname(os.path.abspath(__file__))
files = os.path.join(OUT, "files")
os.makedirs(files, exist_ok=True)
r = subprocess.run([sys.executable, os.path.join(here, "native_test.py"), "15000x10000", "--no-profile", "--out", files,
                    "--json", os.path.join(OUT, "native.json")] + rows, cwd=ROOT, capture_output=True, text=True, timeout=3000)
open(os.path.join(OUT, "native.log"), "w", encoding="utf-8").write(r.stdout + "\n--- stderr\n" + r.stderr)
print(r.stdout[-6000:])
print(r.stderr[-1500:])
subprocess.run([sys.executable, os.path.join(ROOT, "tools", "close_app.py")], cwd=ROOT, env=dict(os.environ, SCUMBLE_CDP_PORT="9555"), capture_output=True, timeout=60)
try:
    app.wait(timeout=60)
except subprocess.TimeoutExpired:
    app.kill()
sl = os.path.join(prof, "logs", "scumble.log")
if os.path.exists(sl):
    shutil.copy(sl, os.path.join(OUT, "scumble.log"))
    print("renderer ends:", [l.strip()[:200] for l in open(sl, encoding="utf-8", errors="replace") if "renderer ended" in l])
