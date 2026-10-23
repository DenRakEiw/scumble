"""Which blob size host.saveExport survives (K0a finding: a 925 MB PSD's save ended the renderer, oom)."""
import asyncio
import json
import os
import sys

sys.path.insert(0, r"F:\canvas\tools")
from cdp import session  # noqa: E402

DIR = r"F:\canvas\dist\gates\k0a_2026-10-23\save_probe"
SIZES = [int(x) for x in sys.argv[1:]] or [300, 500, 700, 900]

JS = r"""(async () => {
    const host = (await import('./editor/host.js')).host;
    const E = (await import('./editor/inpaint_canvas.js')).InpaintEditor;
    host.exportPath = %s + "/probe.bin";
    const n = %d * 1048576;
    const blob = new Blob([new Uint8Array(n)]);
    E.stepMarks(true);
    const t = performance.now();
    const saved = await host.saveExport(blob, "probe_%d.bin");
    const ms = performance.now() - t;
    const marks = E.stepMarks(true).map((m) => [m.step, +(m.t - t).toFixed(0)]);
    return JSON.stringify({ MB: %d, ms: Math.round(ms), saved, marks });
})()"""


async def go(c):
    os.makedirs(DIR, exist_ok=True)
    for mb in SIZES:
        try:
            r = await c.eval(JS % (json.dumps(DIR.replace("\\", "/")), mb, mb, mb), timeout=600)
            print("ok", r, flush=True)
        except Exception as e:  # noqa: BLE001
            print("FAIL", mb, str(e)[:300], flush=True)
            return
        for f in os.listdir(DIR):
            os.remove(os.path.join(DIR, f))


asyncio.run(session(go))
