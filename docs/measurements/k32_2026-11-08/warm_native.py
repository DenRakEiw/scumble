"""Run native_test.py 15000x10000 --no-profile provider_crop after one untimed provider_crop warm-up."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join( os.getcwd(), "tools"))
import native_test  # noqa: E402

WARM_BODY = r"""
const S = await import("./editor/stitch.js");
const cx = Math.round(W / 2), cy = Math.round(H / 2);
ed.clearUndo();
await run("select_rect", { doc: window.__n1doc, x: cx - 512, y: cy - 512, w: 1024, h: 1024 });
const answer = await answerBytes();
await providerCrop(S, answer);
await wait(250);
return { warmed: true };
"""

idx = next(i for i, (n, _, _) in enumerate(native_test.ROWS) if n == "provider_crop")
native_test.ROWS.insert(idx, ("warm_provider_crop", False, WARM_BODY))
native_test.ONLY.append("warm_provider_crop")
sys.stdout.reconfigure(encoding="utf-8")
sys.exit(0 if native_test.asyncio.run(native_test.session(native_test.run_all)) else 1)
