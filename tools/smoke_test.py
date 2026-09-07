"""Smoke test against the running app (see tools/cdp.py for the setup).

Loads the node's test image (from the local mirror or the connected ComfyUI:
input/inpaint_canvas/test_base.png), selects a rectangle, sets a prompt, generates through
the selected recipe, waits for the result layer, saves a PNG without a dialog, then runs
the helpers against the result (select by text with SAM3, cutout with RMBG, prompt
upsampling with Qwen-VL, object detection with SAM2, a grain filter layer plus undo, the
layer and mask exports, a PSD export) and screenshots the window.

    python tools/smoke_test.py [out_dir] ["prompt"] [--no-helpers]

A real model run: check GET /queue on the server first, it must be idle. The helpers run
after the generate on purpose: the node frees helper models before a local run, so this
order loads Flux once and the helpers afterwards.
"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
HELPERS = "--no-helpers" not in sys.argv
OUT = os.path.abspath(ARGS[0] if ARGS else os.path.join(os.path.dirname(__file__), "..", "dist", "smoke"))
PROMPT = ARGS[1] if len(ARGS) > 1 else "Change the white rectangle into a red apple on a wooden table, keeping the rest unchanged."
os.makedirs(OUT, exist_ok=True)


def out_path(name):
    return json.dumps(os.path.join(OUT, name).replace(os.sep, "/"))


# Wait until `cond` (a JS expression) is true, or the status reports an error; returns status + timing.
def wait_js(cond, extra="null", timeout_ms=600000):
    return """
(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < %d) {
    if (%s) break;
    if (/failed|^Error/i.test(editor.status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { status: editor.status, done: !!(%s), seconds: Math.round((Date.now() - t0) / 1000), extra: (%s) };
})()
""" % (timeout_ms, cond, cond, extra)


# host.saveExport writes to a fixed path instead of opening a dialog while `fn` runs.
def with_save(fn_js, name):
    return """
(async () => {
  const hostMod = await import("./editor/host.js");
  const orig = hostMod.host.saveExport;
  hostMod.host.saveExport = async (blob, n) => { const data = new Uint8Array(await blob.arrayBuffer()); return window.scumble.file.save({ name: n, data, path: %s }); };
  try { return await (%s)(); } finally { hostMod.host.saveExport = orig; }
})()
""" % (out_path(name), fn_js)

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
    ("save", with_save("async () => ({ saved: await editor.exportImage(), status: editor.status })", "smoke_result.png")),
]

HELPER_STEPS = [
    # SAM3: select the apple on the result; the mask arrives as an `executed` event
    ("segment", """
(async () => {
  editor.clearSelection();
  editor.segInput.value = "apple";
  editor.segBackendSel.value = editor.segBackendSel.options[0].value;
  await editor.segmentByText();
  return { status: editor.status, backend: editor.segBackendSel.value, pending: !!editor.segmentPending };
})()
"""),
    ("segment-wait", wait_js("!editor.segmentPending && !/Segmenting/.test(editor.status)", "editor.getBounds()")),
    # RMBG: cut the result layer out (its mask is set when done)
    ("cutout", """
(async () => {
  const layer = editor.layers.find((l) => l.kind === "result") || editor.layers[editor.layers.length - 1];
  await editor.cutoutLayer(layer);
  return { status: editor.status, layer: layer && layer.name, pending: !!editor.cutoutPending };
})()
"""),
    ("cutout-wait", wait_js("!editor.cutoutPending", "(() => { const l = editor.layers.find((l) => l.kind === 'result') || editor.layers[editor.layers.length - 1]; return l && !!l.mask; })()")),
    # Qwen-VL: rewrite the prompt for the selection
    ("upsample", """
(async () => {
  const before = editor.promptInput.value;
  await editor.upsamplePrompt();
  return { status: editor.status, before, pending: !!editor.upsamplePending };
})()
"""),
    ("upsample-wait", wait_js("!editor.upsamplePending", "editor.promptInput.value")),
    # SAM2 automask: object hover data
    ("objects", """
(async () => {
  editor.objects = null;
  await editor.ensureObjects();
  return { status: editor.status, pending: !!editor.objectsPending };
})()
"""),
    # objectsPending clears before the segments image is decoded; wait for the objects too
    ("objects-wait", wait_js("!editor.objectsPending && editor.objects", "editor.objects && editor.objects.count")),
    # filter layer, then remove it again (undo of a filter step restores its params, not its existence)
    ("filter", """
(async () => {
  const n = editor.layers.length;
  editor.addFilterLayer("grain");
  const layer = editor.layers.find((l) => l.kind === "filter" && l.filter === "grain");
  const added = editor.layers.length === n + 1 && !!layer;
  if (layer) editor.removeLayer(layer.id);
  return { added, removed: editor.layers.length === n, done: added && editor.layers.length === n, layers: editor.layers.map((l) => l.name), status: editor.status };
})()
"""),
    ("export-layer", with_save("""async () => {
  editor.activeLayerId = (editor.layers.find((l) => l.kind === "result") || editor.layers[0]).id;
  editor.renderLayers();
  return { saved: await editor.exportLayerPng(), status: editor.status };
}""", "smoke_layer.png")),
    ("export-mask", with_save("async () => ({ saved: await editor.exportMaskPng(), status: editor.status })", "smoke_mask.png")),
    ("export-psd", with_save("""async () => {
  editor.saveFormatSel.value = "psd";
  try { return { saved: await editor.exportImage(), status: editor.status }; } finally { editor.saveFormatSel.value = "png"; }
}""", "smoke_result.psd")),
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
    if ok and HELPERS:
        for name, js in HELPER_STEPS:
            t0 = time.time()
            try:
                v = await c.eval(js, timeout=1000)
            except Exception as err:
                v = {"error": str(err)}
                ok = False
            print(f"== {name} ({time.time() - t0:.1f}s)")
            print(json.dumps(v, indent=1, ensure_ascii=False)[:3000])
            if isinstance(v, dict) and (v.get("error") or v.get("done") is False or v.get("saved") is None and "saved" in v):
                ok = False
    await c.screenshot(os.path.join(OUT, "smoke_shot.png"))
    for k, m in await c.logs():
        print(k.upper(), m[:1500])
    print("RESULT", "PASS" if ok else "FAIL", "->", OUT)
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run)) else 1)
