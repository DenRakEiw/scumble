"""Phase 0 smoke test against the running app (see tools/cdp.py for the setup).

Loads the node's test image from the connected ComfyUI (input/inpaint_canvas/test_base.png),
selects a rectangle, sets a prompt, generates through the selected recipe, waits for the
result layer, saves a PNG without a dialog, then screenshots the window.

    python tools/smoke_test.py [out_dir] ["prompt"]

A real model run: check GET /queue on the server first, it must be idle.
"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "dist", "smoke"))
PROMPT = sys.argv[2] if len(sys.argv) > 2 else "Change the white rectangle into a red apple on a wooden table, keeping the rest unchanged."
os.makedirs(OUT, exist_ok=True)

STEPS = [
    ("load", """
(async () => {
  const r = await fetch("/comfy/view?filename=test_base.png&subfolder=inpaint_canvas&type=input");
  if (r.status !== 200) throw new Error("test image " + r.status + " (upload input/inpaint_canvas/test_base.png to the server first)");
  const blob = await r.blob();
  await editor.loadFile(new File([blob], "test_base.png", { type: "image/png" }));
  return { w: editor.width, h: editor.height, status: editor.status };
})()
"""),
    ("select", """
(() => {
  const W = editor.width, H = editor.height;
  const m = new Uint8Array(W * H);
  const x0 = 300, y0 = 100, x1 = 470, y1 = 300;
  for (let y = y0; y < y1; y++) m.fill(1, y * W + x0, y * W + x1);
  editor.applyMaskToSelection(m, "replace");
  editor.promptText = %s; editor.promptInput.value = editor.promptText;
  editor.genSettings.seedRandom = false; editor.genSettings.seed = 12345; editor.syncGenControls();
  editor.renderInfo();
  return { bounds: editor.getBounds(), crop: editor.cropRect(), mode: editor.genSettings.mode, settings: Object.fromEntries(Object.entries(editor.settings).map(([k, v]) => [k, v.value])) };
})()
""" % json.dumps(PROMPT)),
    ("generate", """
(async () => {
  const before = editor.history.length;
  await editor.generate();
  return { status: editor.status, promptId: editor.lastPromptId, before };
})()
"""),
    ("wait", """
(async () => {
  const t0 = Date.now(), before = %d;
  while (Date.now() - t0 < 900000) {
    if (editor.history.length > before) break;
    if (/^Error|failed/i.test(editor.status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const h = editor.history[editor.history.length - 1];
  return { status: editor.status, history: editor.history.length, last: h && { name: h.name, x: h.x, y: h.y, w: h.w, h: h.h, seed: h.seed }, seconds: Math.round((Date.now() - t0) / 1000) };
})()
"""),
    ("save", """
(async () => {
  const hostMod = await import("./editor/host.js");
  const orig = hostMod.host.saveExport;
  hostMod.host.saveExport = async (blob, name) => { const data = new Uint8Array(await blob.arrayBuffer()); return window.scumble.file.save({ name, data, path: %s }); };
  try { return { saved: await editor.exportImage(), status: editor.status }; } finally { hostMod.host.saveExport = orig; }
})()
""" % json.dumps(os.path.join(OUT, "smoke_result.png").replace("\\\\", "/"))),
]


async def run(c):
    ok = True
    history_before = 0
    for name, js in STEPS:
        t0 = time.time()
        if name == "wait":
            js = js % history_before
        try:
            v = await c.eval(js, timeout=1000)
        except Exception as err:
            v = {"error": str(err)}
            ok = False
        print(f"== {name} ({time.time() - t0:.1f}s)")
        print(json.dumps(v, indent=1, ensure_ascii=False)[:3000])
        if name == "generate" and isinstance(v, dict):
            history_before = v.get("before", 0)
        if name == "wait" and (not isinstance(v, dict) or v.get("history", 0) <= history_before):
            ok = False
            break
    await c.screenshot(os.path.join(OUT, "smoke_shot.png"))
    for k, m in await c.logs():
        print(k.upper(), m[:1500])
    print("RESULT", "PASS" if ok else "FAIL", "->", OUT)
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run)) else 1)
