"""Run w0_bench.py with warpRgba route set to WARP_ROUTE ('js' or 'rust') via K.setRoute."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.getcwd(), "tools"))
import w0_bench  # noqa: E402

ROUTE = os.environ["WARP_ROUTE"]
orig_session = w0_bench.session


async def wrapped_session(fn):
    async def inner(c):
        await c.call("Page.bringToFront")
        ov = await c.eval(
            f"(async () => {{ await import('./shell.js'); const K = await import('./editor/px/kernels.js'); K.setRoute('warpRgba', {json.dumps(ROUTE)}); return JSON.stringify(K.routeOverrides()); }})()"
        )
        print(f"   routeOverrides={ov}", flush=True)
        return await fn(c)

    return await orig_session(inner)


w0_bench.session = wrapped_session
sys.stdout.reconfigure(encoding="utf-8")
w0_bench.asyncio.run(w0_bench.main())
