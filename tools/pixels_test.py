"""LayerPixels / MaskPixels contract test against the running app (see tools/cdp.py for the setup).

Evaluates the cases of tools/pixels_test.js inside the renderer with
renderer/editor/inpaint_pixels.js imported, one case at a time. No ComfyUI, no document needed.

    python tools/pixels_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


async def main():
    sys.stdout.reconfigure(encoding="utf-8")
    src = open(os.path.join(HERE, "pixels_test.js"), encoding="utf-8").read()

    async def run(cdp):
        names = await cdp.eval("(async () => { const P = await import('./editor/inpaint_pixels.js'); "
                               + src + "\nreturn pixelsCases(P).map((c) => c[0]); })()")
        failed = 0
        for i, name in enumerate(names):
            js = ("(async () => { const P = await import('./editor/inpaint_pixels.js'); " + src
                  + "\nconst cases = pixelsCases(P); return await cases[%d][1](); })()" % i)
            try:
                res = await cdp.eval(js, timeout=120)
                print(f"[ok] {name}: {json.dumps(res)[:300]}")
            except Exception as err:  # noqa: BLE001
                failed += 1
                print(f"[FAIL] {name}: {err}")
        print("PASS" if not failed and names else "FAIL")
        return not failed

    ok = await session(run)
    sys.exit(0 if ok else 1)


asyncio.run(main())
