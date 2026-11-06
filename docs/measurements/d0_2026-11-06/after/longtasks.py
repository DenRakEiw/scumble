"""Where the open's remaining block is: long tasks and heartbeat gaps of a 15k PSD load_image beside the step marks."""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = r"F:\canvas"
SCRATCH = r"C:\Users\SCHOEN~1\AppData\Local\Temp\claude\F--canvas\543d44fb-4d2d-4818-8804-974916d10a44\scratchpad"
sys.path.insert(0, os.path.join(ROOT, "tools"))
from cdp import session  # noqa: E402

FILE = os.path.join(SCRATCH, "d0", "psd15k.psd").replace("\\", "/")
JS = r"""(async () => {
    const commands = (await import('./commands.js')).commands, host = (await import('./editor/host.js')).host;
    await import('./shell.js');
    const J = await import('./editor/inpaint_jobs.js');
    const lt = [];
    const ob = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push([Math.round(e.startTime), Math.round(e.duration)]); });
    ob.observe({ entryTypes: ["longtask"] });
    const gaps = [];
    let last = performance.now(), on = true;
    const beat = () => { const n = performance.now(); if (n - last > 100) gaps.push([Math.round(last), Math.round(n - last)]); last = n; if (on) setTimeout(beat, 0); };
    setTimeout(beat, 0);
    const d = await commands.run("new_document");
    const m0 = J.STEP_MARKS.length;
    const t0 = performance.now();
    await commands.run("load_image", { doc: d.id, path: %(file)s });
    const t1 = performance.now();
    await new Promise((r) => setTimeout(r, 500));
    on = false; ob.disconnect();
    const marks = J.STEP_MARKS.slice(m0).map((m) => [m.op, m.step, Math.round(m.t)]);
    return { t0: Math.round(t0), t1: Math.round(t1), marks, longtasks: lt, gaps };
})()"""


def up():
    try:
        urllib.request.urlopen("http://127.0.0.1:9555/json/version", timeout=1).read()
        return True
    except Exception:
        return False


async def body(c):
    await c.call("Page.bringToFront")
    return await c.eval(JS % {"file": json.dumps(FILE)}, timeout=900)


prof = os.path.join(SCRATCH, "d0", "profile_lt")
shutil.rmtree(prof, ignore_errors=True)
os.makedirs(prof)
app = subprocess.Popen([os.path.join(ROOT, r"node_modules\electron\dist\electron.exe"), ".", "--remote-debugging-port=9555", "--user-data-dir=" + prof, "--no-comfy", "--tiles"],
                       cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(os.environ, SCUMBLE_TILES="1"))
try:
    for _ in range(240):
        if up():
            break
        time.sleep(0.5)
    time.sleep(8)
    res = asyncio.run(session(body))
    print(json.dumps(res, indent=None))
finally:
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "close_app.py")], cwd=ROOT, env=dict(os.environ, SCUMBLE_CDP_PORT="9555"), capture_output=True, timeout=120)
    try:
        app.wait(timeout=90)
    except subprocess.TimeoutExpired:
        app.kill()
    shutil.rmtree(prof, ignore_errors=True)
