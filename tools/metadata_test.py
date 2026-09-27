"""What an exported picture says about itself (docs/PLAN_0_1_29.md 3f), on both backends.

Every PNG export carried the prompt, the seed and the recipe as tEXt chunks until 3f; now it does so only when the
Export section's switch ("Prompt and recipe in the PNG", `settings.embedRecipe`, on by default since 0.1.32) or the export command's
`metadata` says so. Every PNG export carries an `sRGB` chunk (its pixels are sRGB), on the banded path and on the
canvas path; uploads never do (their names are the hash of their bytes). JPEG gets Chromium's sRGB ICC profile (APP2);
WebP's chunks are printed (2026-09-26: VP8X, ICCP, VP8). An embedded recipe leaves out the inputs named like a key, a
token, a secret or a password (renderer/editor/redact.js; the matcher itself is tools/secret_names_test.js).

No ComfyUI, no API key. Start the app first (tools/run_gates.sh does), then:

    python tools/metadata_test.py
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HELPERS = r"""
const PNG = await import("./editor/inpaint_png.js");
// the chunk types of a PNG up to IDAT, with the tEXt keywords
const chunks = async (blob) => {
    const b = new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer());
    const dv = new DataView(b.buffer);
    const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if (sig.some((v, i) => b[i] !== v)) throw new Error("not a PNG");
    const types = [], texts = {};
    for (let p = 8; p + 12 <= b.length;) {
        const len = dv.getUint32(p), t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
        types.push(t);
        if (t === "tEXt") { const d = b.subarray(p + 8, p + 8 + len), z = d.indexOf(0); texts[new TextDecoder("latin1").decode(d.subarray(0, z))] = new TextDecoder("latin1").decode(d.subarray(z + 1)); }
        if (t === "IDAT" || t === "IEND") break;
        p += 12 + len;
    }
    return { types, texts };
};
// one export through the editor into memory: { blob, name, status }
const exportOf = async (ed, fmt = "png", call = null) => {
    let saved = null;
    const was = host.saveExport;
    host.saveExport = async (blob, name) => { saved = { blob, name }; return { path: "memory:" + name }; };
    try {
        if (call) await call();
        else { ed.saveFormatSel.value = fmt; host.syncExportRow(ed); const out = await ed.exportImage({ download: false }); if (!out) throw new Error("exportImage saved nothing: " + ed.status); }
    } finally { host.saveExport = was; ed.saveFormatSel.value = "png"; host.syncExportRow(ed); }
    if (!saved) throw new Error("nothing saved: " + ed.status);
    return { ...saved, status: ed.status };
};
const once = (types, t) => types.filter((x) => x === t).length;
// sRGB exactly once, before IDAT, no other colour chunk; tEXt as `embedded` says
const checkPng = async (blob, embedded, what) => {
    const c = await chunks(blob);
    if (c.types[0] !== "IHDR") throw new Error(what + ": IHDR is not first: " + c.types);
    if (once(c.types, "sRGB") !== 1) throw new Error(what + ": " + once(c.types, "sRGB") + " sRGB chunks: " + c.types);
    for (const t of ["iCCP", "gAMA", "cHRM", "cICP"]) if (c.types.includes(t)) throw new Error(what + ": a " + t + " chunk beside sRGB: " + c.types);
    const keys = Object.keys(c.texts).sort().join(",");
    if (embedded && keys !== "inpaint_canvas,workflow") throw new Error(what + ": the recipe is not embedded: [" + keys + "]");
    if (!embedded && keys) throw new Error(what + ": text chunks although the switch is off: [" + keys + "]");
    // the browser still decodes it, at the size it says
    const bmp = await createImageBitmap(blob);
    const size = [bmp.width, bmp.height];
    bmp.close();
    return { types: c.types.join(" "), texts: c.texts, size };
};
"""

STEPS = [
    ("setup", r"""
const d = await run("new_document");
window.__md = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
const W = 1500, H = 1000;
const c = document.createElement("canvas"); c.width = W; c.height = H;
const x = c.getContext("2d");
const g = x.createLinearGradient(0, 0, W, H);
g.addColorStop(0, "hsl(20,70%,50%)"); g.addColorStop(1, "hsl(220,70%,30%)");
x.fillStyle = g; x.fillRect(0, 0, W, H);
Object.defineProperty(c, "naturalWidth", { value: W }); Object.defineProperty(c, "naturalHeight", { value: H });
await ed.setBase({ filename: "metadata_test.png", subfolder: "inpaint_canvas", type: "input" }, c, { keepLayers: false });
await run("set_prompt", { doc: d.id, text: "a red fox été", negative: "blur" });
window.__mdWas = host.embedRecipe;
// the default: the runner's fresh profile never touched the switch, so it is on (the user, 2026-09-27; `--keep-switch`
// against a used profile). Off from here, so the next step starts from a switched-off app
if (!__KEEP__ && (window.__mdWas !== true || (await window.scumble.settings.get()).embedRecipe !== true)) throw new Error("a fresh profile has the switch off: host " + window.__mdWas);
host.setEmbedRecipe(false);
const r = ed._exportRow;
if (!r || !r.meta || !r.mRow) throw new Error("the Export section has no metadata switch");
return { doc: d.id, tiles: !!ed.tileMode, switchWas: window.__mdWas };
"""),
    ("switched_off_embeds_nothing", r"""
const ed = ednow(window.__md);
const fresh = await window.scumble.settings.get();
const def = host.embedRecipe;
if (def !== false) throw new Error("host.embedRecipe is " + def);
const r = ed._exportRow;
if (r.meta.checked) throw new Error("the checkbox shows on while the switch is off");
if (r.mRow.hidden) throw new Error("the switch is hidden for PNG");
ed.saveFormatSel.value = "jpg"; host.syncExportRow(ed);
const hiddenForJpg = r.mRow.hidden;
ed.saveFormatSel.value = "png"; host.syncExportRow(ed);
if (!hiddenForJpg) throw new Error("the switch shows for JPEG");
const e = await exportOf(ed);
const got = await checkPng(e.blob, false, "plain export, switch off");
if (/embedded/.test(e.status)) throw new Error("the status says embedded: " + e.status);
return { stored: fresh.embedRecipe, banded: /ms\)/.test(e.status), ...got, status: e.status };
"""),
    ("the_switch_embeds_and_is_kept", r"""
const ed = ednow(window.__md);
const r = ed._exportRow;
r.meta.click();   // the checkbox as the user ticks it
if (host.embedRecipe !== true) throw new Error("ticking the checkbox left the switch at " + host.embedRecipe);
let stored = null;
for (let i = 0; i < 20 && stored !== true; i++) { await wait(50); stored = (await window.scumble.settings.get()).embedRecipe; }
if (stored !== true) throw new Error("the settings file says " + stored);
// a second tab's checkbox follows
const d2 = await run("new_document");
const ed2 = ednow(d2.id);
const other = ed2._exportRow && ed2._exportRow.meta.checked;
await run("close_document", { doc: d2.id, force: true });
host.shell.activate(ed);
if (!other) throw new Error("a new tab's checkbox is off while the switch is on");
const e = await exportOf(ed);
const got = await checkPng(e.blob, true, "plain export, switch on");
const wf = JSON.parse(got.texts.workflow), ic = JSON.parse(got.texts.inpaint_canvas);
if (wf.app !== "scumble") throw new Error("the workflow chunk is not the app's: " + got.texts.workflow.slice(0, 200));
if (ic.prompt !== "a red fox été" || ic.negative !== "blur") throw new Error("the prompt chunk says " + got.texts.inpaint_canvas.slice(0, 200));
if (/[^\x00-\x7f]/.test(got.texts.inpaint_canvas)) throw new Error("a tEXt chunk holds non-ASCII");
if (!/embedded/.test(e.status)) throw new Error("the status does not say embedded: " + e.status);
return { types: got.types, recipe: wf.recipe, prompt: ic.prompt, status: e.status };
"""),
    ("the_canvas_path_too", r"""
// a Size row makes the export non-plain: the picture is encoded by the browser and the chunks put in afterwards
const ed = ednow(window.__md);
host.setExportSize(ed, { percent: 50 });
try {
    host.setEmbedRecipe(true);
    const on = await exportOf(ed);
    const a = await checkPng(on.blob, true, "scaled export, switch on");
    host.setEmbedRecipe(false);
    const off = await exportOf(ed);
    const b = await checkPng(off.blob, false, "scaled export, switch off");
    if (a.size.join() !== "750,500" || b.size.join() !== "750,500") throw new Error("the scaled export is " + a.size + " / " + b.size);
    if (/ms\)/.test(off.status)) throw new Error("the scaled export went through the bands: " + off.status);
    // a PNG that already has its own sRGB chunk gets no second one, one with an ICC profile none at all
    const buf = await off.blob.arrayBuffer();
    const again = await chunks(PNG.pngWithChunks(buf, { chunks: [PNG.SRGB_CHUNK] }));
    if (once(again.types, "sRGB") !== 1) throw new Error("a second sRGB chunk went in: " + again.types);
    return { on: a.types, off: b.types, size: b.size };
} finally { host.setExportSize(ed, { percent: 100 }); host.setEmbedRecipe(false); }
"""),
    ("the_command_answers_for_one_export", r"""
const ed = ednow(window.__md);
host.setEmbedRecipe(false);
const on = await exportOf(ed, "png", () => run("export", { doc: window.__md, format: "png", metadata: true }));
await checkPng(on.blob, true, "export command, metadata true, switch off");
if (host.exportState(ed).metadata !== null) throw new Error("the command left its answer behind: " + host.exportState(ed).metadata);
const plain = await exportOf(ed);
await checkPng(plain.blob, false, "the export after the command");
host.setEmbedRecipe(true);
try {
    const off = await exportOf(ed, "png", () => run("export", { doc: window.__md, format: "png", metadata: false }));
    await checkPng(off.blob, false, "export command, metadata false, switch on");
    const dflt = await exportOf(ed, "png", () => run("export", { doc: window.__md, format: "png" }));
    await checkPng(dflt.blob, true, "export command without metadata, switch on");
} finally { host.setEmbedRecipe(false); }
const described = window.__cmds.describe().find((c) => c.name === "export");
if (!described || !described.params.metadata || described.params.metadata.type !== "boolean") throw new Error("the export command does not describe `metadata`");
return { param: described.params.metadata.description };
"""),
    ("an_imported_key_stays_out_of_the_png", r"""
// the user, 2026-09-27: an imported workflow's key widgets stay out of the embedded recipe (renderer/editor/redact.js);
// a recipe as an import makes it, with a key typed into a node and one wired in from a primitive
const ed = ednow(window.__md);
const KEY = "sk-metadata-test-0123456789";
const recipeWas = host.recipe;
host.recipe = { id: "imported_with_a_key", kind: "comfy", mode: "local", canvas: "canvas", result: "decode:0", prompt: {
    canvas: { class_type: "InpaintCanvas", inputs: { padding: 64 } },
    api: { class_type: "SomeApiNode", inputs: { prompt: "a fox", api_key: KEY, keyframe: 3, image: ["canvas", 0] } },
    prim: { class_type: "PrimitiveString", inputs: { value: KEY } },
    llm: { class_type: "LLMNode", inputs: { openaiKey: ["prim", 0], max_tokens: 512 } },
} };
host.setEmbedRecipe(true);
try {
    const e = await exportOf(ed);
    const got = await checkPng(e.blob, true, "an imported recipe with a key, switch on");
    if (got.texts.workflow.includes(KEY) || got.texts.inpaint_canvas.includes(KEY)) throw new Error("the key is in the PNG: " + got.texts.workflow.slice(0, 400));
    const wf = JSON.parse(got.texts.workflow);
    if (wf.recipe !== "imported_with_a_key" || !wf.prompt || !wf.prompt.api) throw new Error("the recipe is not embedded: " + got.texts.workflow.slice(0, 300));
    const api = wf.prompt.api.inputs, llm = wf.prompt.llm.inputs;
    if ("api_key" in api || "openaiKey" in llm || "value" in wf.prompt.prim.inputs) throw new Error("a key input is still there: " + JSON.stringify(wf.prompt));
    if (api.prompt !== "a fox" || api.keyframe !== 3 || llm.max_tokens !== 512 || wf.prompt.canvas.inputs.padding !== 64) throw new Error("an ordinary input went too: " + JSON.stringify(wf.prompt));
    // the recipe the app runs keeps its key
    if (host.recipe.prompt.api.inputs.api_key !== KEY) throw new Error("the recipe itself lost its key");
    return { api: Object.keys(api), llm: Object.keys(llm), bytes: got.texts.workflow.length };
} finally { host.recipe = recipeWas; host.setEmbedRecipe(false); }
"""),
    ("uploads_carry_no_srgb", r"""
// the PNGs the mirror and ComfyUI get are named by the hash of their bytes: no chunk of the export's may go in
const ed = ednow(window.__md);
const E = ed.constructor;
const out = {};
if (ed.tileMode && E.parts && E.parts.usable()) {
    const r = await E.parts.encodeTilePixels(ed.basePx, { hash: true });
    const c = await chunks(r.blob);
    if (c.types.includes("sRGB") || c.types.includes("tEXt")) throw new Error("a tile upload carries " + c.types);
    out.tiles = c.types.join(" ");
    const comp = await ed.encodeComposite({ forRun: true }, { hash: true });
    if (comp) { const cc = await chunks(comp.blob); if (cc.types.includes("sRGB")) throw new Error("the composite upload carries sRGB: " + cc.types); out.composite = cc.types.join(" "); }
}
const cv = ed.basePx.toCanvas();
try {
    const r = E.parts ? await E.parts.encodeCanvas(cv, { hash: true }) : null;
    if (r) { const c = await chunks(r.blob); if (c.types.includes("sRGB")) throw new Error("a canvas upload carries sRGB: " + c.types); out.canvas = c.types.join(" "); }
} finally { if (ed.tileMode) { cv.width = 1; cv.height = 1; } }
return out;
"""),
    ("jpeg_and_webp_as_they_are", r"""
// JPEG: Chromium's encoder writes an sRGB ICC profile (APP2 ICC_PROFILE); WebP: measured and printed
const ed = ednow(window.__md);
host.setEmbedRecipe(true);
let jpg, webp;
try { jpg = await exportOf(ed, "jpg"); webp = await exportOf(ed, "webp"); } finally { host.setEmbedRecipe(false); }
const j = new Uint8Array(await jpg.blob.arrayBuffer());
const markers = [];
let icc = false;
for (let p = 2; p + 4 <= j.length && j[p] === 0xFF;) {
    const m = j[p + 1], len = (j[p + 2] << 8) | j[p + 3];
    markers.push(m.toString(16));
    if (m === 0xE2 && new TextDecoder("latin1").decode(j.subarray(p + 4, p + 15)) === "ICC_PROFILE") icc = true;
    if (m === 0xDA) break;
    p += 2 + len;
}
if (!icc) throw new Error("the JPEG export has no ICC profile: markers " + markers);
const text = new TextDecoder("latin1").decode(j);
if (/scumble|red fox/.test(text)) throw new Error("the JPEG carries the recipe or prompt");
const w = new Uint8Array(await webp.blob.arrayBuffer());
const riff = [];
for (let p = 12; p + 8 <= w.length;) { const t = new TextDecoder("latin1").decode(w.subarray(p, p + 4)); const len = new DataView(w.buffer).getUint32(p + 4, true); riff.push(t); p += 8 + len + (len & 1); }
return { jpeg: markers.join(" "), webp: riff.join(" ") };
"""),
    ("close", r"""
host.setEmbedRecipe(false);   // the gate leaves the switch off, as a fresh profile has it
await run("close_document", { doc: window.__md, force: true });
return { closed: window.__md, embedRecipe: host.embedRecipe };
"""),
]

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    %s
    %s
})()"""


async def run_all(c):
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    ok = True
    only = [a for a in sys.argv[1:] if not a.startswith("-")]
    for name, body in STEPS:
        if only and name not in only and name not in ("setup", "close"):
            continue
        try:
            res = await c.eval(PRE % (HELPERS, body.replace("__KEEP__", "true" if "--keep-switch" in sys.argv else "false")), timeout=300)
            print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:1500]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, str(err)[:900]))
            if name == "setup":
                break
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
