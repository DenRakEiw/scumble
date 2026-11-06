"""D0's twin on the real 15k PSD in the app: the file read by the pool's reader (psd_read) and by the window's
(`InpaintEditor.psdOnPool = false`) on one fresh offline instance (tiles on, or --tiles off), every layer's and mask's
pixels hashed band by band (FNV-1a over readRect of 256 rows) with the layers' fields, the groups, notes and loss flag;
the two must be the same, and the pool route must have run.

    python twin15k.py FILE.psd OUT.json [--tiles off]
"""
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

FILE, OUT = sys.argv[1], sys.argv[2]
TILES = "off" if "--tiles" in sys.argv and sys.argv[sys.argv.index("--tiles") + 1] == "off" else "on"

JS = r"""(async () => {
    const commands = (await import('./commands.js')).commands, host = (await import('./editor/host.js')).host;
    await import('./shell.js');
    const d = await commands.run("new_document");
    const ed = host.editors().find((e) => e.node.id === d.id);
    const E = ed.constructor, proto = Object.getPrototypeOf(ed);
    let routes = [];
    ed.readPsdOnPool = async function (...a) { const r = await proto.readPsdOnPool.apply(this, a); routes.push(r ? "pool" : "fallback"); return r; };
    const r = await window.scumble.file.read(%(file)s);
    const file = new File([r.data], "psd15k.psd");
    const hashPx = (p) => {
        let h = 2166136261 >>> 0;
        for (let y = 0; y < p.height; y += 256) {
            const b = p.readRect(0, y, p.width, Math.min(256, p.height - y)).data;
            for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
        }
        return h;
    };
    const summary = (doc) => {
        const out = { width: doc.width, height: doc.height, groups: doc.groups, notes: doc.notes, lossy: doc.lossy, layers: [] };
        for (const L of doc.layers) {
            out.layers.push({ name: L.name, x: L.x, y: L.y, w: L.w, h: L.h, opacity: L.opacity, visible: L.visible, blend: L.blend, group: L.group, clip: !!L.clip, maskOff: !!L.maskOff,
                pw: L.px.width, ph: L.px.height, px: hashPx(L.px), mask: L.maskPx ? hashPx(L.maskPx) : null, kind: L.px.constructor.name });
            for (const p of [L.px, L.maskPx]) if (p) p.release();
        }
        return out;
    };
    const was = E.psdOnPool;
    try {
        delete E.psdOnPool;
        let t = performance.now();
        const poolDoc = await ed.readLayered(file, "psd");
        const poolMs = performance.now() - t;
        const pool = summary(poolDoc);
        E.psdOnPool = false;
        t = performance.now();
        const winDoc = await ed.readLayered(file, "psd");
        const winMs = performance.now() - t;
        const win = summary(winDoc);
        return { same: JSON.stringify(pool) === JSON.stringify(win), routes, tiles: !!ed.tileMode, poolMs: Math.round(poolMs), winMs: Math.round(winMs), pool, win };
    } finally {
        if (was === undefined) delete E.psdOnPool; else E.psdOnPool = was;
        delete ed.readPsdOnPool;
        try { await commands.run("close_document", { doc: d.id, force: true }); } catch (_) { /* gone */ }
    }
})()"""


def up():
    try:
        urllib.request.urlopen("http://127.0.0.1:9555/json/version", timeout=1).read()
        return True
    except Exception:
        return False


async def body(c):
    await c.call("Page.bringToFront")
    return await c.eval(JS % {"file": json.dumps(FILE.replace("\\", "/"))}, timeout=900)


def main():
    if up():
        raise SystemExit("an instance answers on 9555 already")
    prof = os.path.join(SCRATCH, "d0", "profile_twin15k")
    shutil.rmtree(prof, ignore_errors=True)
    os.makedirs(prof)
    args = [os.path.join(ROOT, r"node_modules\electron\dist\electron.exe"), ".", "--remote-debugging-port=9555", "--user-data-dir=" + prof, "--no-comfy"]
    args.append("--tiles" if TILES == "on" else "--no-tiles")   # as tools/run_gates.sh starts it
    log = open(OUT + ".app.log", "w")
    app = subprocess.Popen(args, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env=dict(os.environ, SCUMBLE_TILES="1" if TILES == "on" else "0"))
    try:
        for _ in range(240):
            if up():
                break
            time.sleep(0.5)
        time.sleep(8)
        res = asyncio.run(session(body))
        json.dump(res, open(OUT, "w", encoding="utf-8"), indent=1)
        ok = res and res.get("same") and res.get("routes") == ["pool"]
        print(json.dumps({k: res.get(k) for k in ("same", "routes", "tiles", "poolMs", "winMs")}))
        print("layers:", [(L["name"], L["pw"], L["ph"], L["px"], L["mask"]) for L in res["pool"]["layers"]])
        print("PASS" if ok else "FAIL")
    finally:
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "close_app.py")], cwd=ROOT, env=dict(os.environ, SCUMBLE_CDP_PORT="9555"), capture_output=True, timeout=120)
        try:
            app.wait(timeout=90)
        except subprocess.TimeoutExpired:
            app.kill()
        shutil.rmtree(prof, ignore_errors=True)


main()
