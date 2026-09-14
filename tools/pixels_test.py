"""LayerPixels / MaskPixels contract test against the running app (see tools/cdp.py for the setup).

Evaluates the cases of tools/pixels_test.js inside the renderer with
renderer/editor/inpaint_pixels.js and renderer/editor/inpaint_tiles.js imported, one case at a
time. Every case runs on the canvas backend (GPU and CPU) and on the tile backend, and the outputs
of the CPU canvas run and the tile run are compared byte for byte. No ComfyUI, no document needed.

    python tools/pixels_test.py            every case, then the timings (printed, not gated)
    python tools/pixels_test.py --no-timings

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
IMPORTS = ("const P = await import('./editor/inpaint_pixels.js'); "
           "const T = await import('./editor/inpaint_tiles.js'); ")


async def main():
    sys.stdout.reconfigure(encoding="utf-8")
    src = open(os.path.join(HERE, "pixels_test.js"), encoding="utf-8").read()
    timings = "--no-timings" not in sys.argv

    async def run(cdp):
        names = await cdp.eval("(async () => { " + IMPORTS + src + "\nreturn pixelsCases(P, T).map((c) => c[0]); })()")
        failed = 0
        for i, name in enumerate(names):
            if name == "timings" and not timings:
                continue
            js = ("(async () => { " + IMPORTS + src
                  + "\nconst cases = pixelsCases(P, T); return await cases[%d][1](); })()" % i)
            try:
                res = await cdp.eval(js, timeout=300)
                text = json.dumps(res)
                print(f"[ok] {name}: {text if name == 'timings' else text[:700]}")
            except Exception as err:  # noqa: BLE001
                failed += 1
                print(f"[FAIL] {name}: {err}")
        print("PASS" if not failed and names else "FAIL")
        return not failed

    ok = await session(run)
    sys.exit(0 if ok else 1)


asyncio.run(main())
