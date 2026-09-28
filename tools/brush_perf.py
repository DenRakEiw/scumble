"""Smudge, clone and heal at 15000 x 10000 (docs/PLAN_0_1_31.md §4, docs/PERFORMANCE.md §15): runs tools/brush_perf.js
in a running instance (port SCUMBLE_CDP_PORT, default 9555) and prints its table.

    python tools/brush_perf.py '{"TOOLS": ["clone"]}'
    python tools/brush_perf.py '{"SIZES": [200]}' liquify_perf.js    # another script of the same shape (Liquify)

Start a fresh instance per tool, on its own profile, `--no-comfy`, the window in front and no hand on the mouse
(tools/run_gates.sh does not run it: it is a measurement, not a gate). The JSON sets `window.__bp` (W, H, TOOLS, SIZES,
SAMPLES, VIEWS, MOVES, MOVE_CSS, MODE, GAP, PEN, BASE_ROW, KEEP; defaults in the script). The rows go to
`brush_perf.out.json` in the working directory as well.
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), sys.argv[2] if len(sys.argv) > 2 else "brush_perf.js"), encoding="utf-8").read()
PARAMS = sys.argv[1] if len(sys.argv) > 1 else "{}"


async def run(c):
    await c.call("Page.bringToFront")
    await c.eval("window.__bp = %s; 1" % PARAMS)
    out = await c.eval(JS, timeout=3000)
    print("\n".join(out.get("table", [])))
    print(json.dumps({k: v for k, v in out.items() if k not in ("rows", "table")}))
    with open("brush_perf.out.json", "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(session(run))
