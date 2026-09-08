"""Command core and plugin test against the running app (see tools/cdp.py for the setup).

No ComfyUI needed: loads the test image from the local mirror (or the server when
connected), then runs the command core (renderer/commands.js) through its public
`commands.run`: documents, selection, layers, filters (the sample plugin's Posterize on
the GPU and CPU paths), text, plugin actions / tools / commands, export to a fixed path,
screenshot, plugin reload and disable / enable.

    python tools/commands_test.py [out_dir]
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "dist", "smoke"))
os.makedirs(OUT, exist_ok=True)


def out_path(name):
    return json.dumps(os.path.join(OUT, name).replace(os.sep, "/"))


# every step is a JS async function body; `c` is commands.run, `raw` the module
STEPS = [
    ("ping", """
const p = await c("ping");
if (p.app !== "scumble") throw new Error("ping");
return { documents: p.documents.length, plugins: p.plugins, commands: raw.commands.names().length };
"""),
    ("new_document", """
const d = await c("new_document");
window.__testDoc = d.id;
const l = await c("list_documents");
if (!l.documents.some((x) => x.id === d.id && x.active)) throw new Error("the new document is not active");
return d;
"""),
    ("load", """
const r = await fetch("/comfy/view?filename=test_base.png&subfolder=inpaint_canvas&type=input");
if (r.status !== 200) throw new Error("test image " + r.status + " (run the smoke test once so it is in the mirror)");
const s = await c("load_image", { filename: "test_base.png", subfolder: "inpaint_canvas", type: "input", doc: window.__testDoc });
if (!s.width) throw new Error("not loaded");
return s;
"""),
    ("status_and_docs", """
const s = await c("status");
if (s.doc !== window.__testDoc || !s.loaded) throw new Error("status is not about the test document: " + JSON.stringify(s).slice(0, 200));
const cmds = await c("list_commands");
const missing = ["select_rect", "generate", "add_filter", "export", "screenshot", "sample.mean_color"].filter((n) => !cmds.commands.some((x) => x.name === n));
if (missing.length) throw new Error("commands missing: " + missing);
return { width: s.width, height: s.height, layers: s.layers.length, commands: cmds.commands.length, recipe: s.recipe && s.recipe.id };
"""),
    ("selection", """
const a = await c("select_rect", { x: 100, y: 80, w: 200, h: 120 });
if (!a.selection || a.selection.w !== 200 || a.selection.h !== 120) throw new Error("rect: " + JSON.stringify(a));
const g = await c("select_grow", { px: 10 });
if (g.selection.w !== 220) throw new Error("grow: " + JSON.stringify(g));
const inv = await c("select_invert");
const none = await c("select_none");
if (none.selection) throw new Error("select_none left a selection");
const m = new Uint8Array(editor.width * editor.height);
for (let y = 10; y < 60; y++) m.fill(1, y * editor.width + 20, y * editor.width + 120);
const sm = await c("select_mask", { mask: Array.from(m) });
if (!sm.selection || sm.selection.w !== 100 || sm.selection.h !== 50) throw new Error("select_mask: " + JSON.stringify(sm));
const mean = await c("sample.mean_color");
await c("select_rect", { x: 100, y: 80, w: 200, h: 120 });
return { rect: a.selection, grown: g.selection, inverted: inv.selection, mask: sm.selection, mean };
"""),
    ("layers", """
const before = (await c("list_layers")).layers.length;
const p = await c("add_paint_layer", { name: "Test paint" });
const t = await c("add_text", { text: "Scumble", x: 40, y: 40, size: 48, color: "#ff8800", name: "Title" });
if (t.kind !== "text" || t.text.content !== "Scumble") throw new Error("add_text: " + JSON.stringify(t));
const t2 = await c("set_text", { layer: "Title", text: "Plugins", bold: true });
if (t2.text.content !== "Plugins") throw new Error("set_text");
const moved = await c("set_layer", { layer: "Title", x: 60, y: 70, opacity: 0.8 });
if (moved.x !== 60 || moved.opacity !== 0.8) throw new Error("set_layer: " + JSON.stringify(moved));
const dup = await c("duplicate_layer", { layer: "Title" });
const mv = await c("move_layer", { layer: dup.id, to: "bottom" });
if (mv.index !== 0) throw new Error("move_layer: " + JSON.stringify(mv));
const rm = await c("remove_layer", { layer: dup.id });
const after = (await c("list_layers")).layers.length;
if (after !== before + 2) throw new Error(`layer count ${after}, expected ${before + 2}`);
return { paint: p.id, text: t2.id, layers: after };
"""),
    ("posterize_filter", """
const types = await c("filter_types");
const f = types.filters.find((x) => x.id === "sample.posterize");
if (!f || f.plugin !== "sample") throw new Error("the sample plugin's filter is not listed");
const layer = await c("add_filter", { type: "sample.posterize", params: { levels: 4 }, name: "Poster" });
if (layer.filter !== "sample.posterize" || layer.params.levels !== 4) throw new Error("add_filter: " + JSON.stringify(layer));
const set = await c("set_filter", { layer: "Poster", params: { mono: true } });
if (set.params.mono !== true) throw new Error("set_filter");
// GPU vs CPU path of the plugin filter
const fl = (await import("./editor/inpaint_filters.js"));
const gl = (await import("./editor/inpaint_filters_gl.js"));
const src = editor.flattenToCanvas({ forRun: true });
const cpu = fl.FILTERS["sample.posterize"].apply;
const cmp = gl.compareFilterPaths(cpu, "sample.posterize", src, { levels: 4, mono: false }, {});
if (gl.glFiltersAvailable() && !cmp.gl) throw new Error("the plugin filter did not run on the GPU (shader error?)");
if (cmp.gl && cmp.max > 2) throw new Error("GPU and CPU posterize differ: " + JSON.stringify(cmp));
const shot = await c("screenshot", { max_size: 512 });
window.__posterShot = shot.data;
return { filter: f, layer: layer.id, compare: cmp, screenshot: [shot.width, shot.height] };
"""),
    ("plugin_action_and_undo", """
await c("set_active_layer", { layer: "Test paint" });
// paint something into the paint layer through the plugin API, then desaturate it via the action
const P = await import("./plugins.js");
const doc = new P.Document(editor);
const px = doc.getPixels("Test paint");
for (let i = 0; i < px.data.data.length; i += 4) { px.data.data[i] = 200; px.data.data[i + 1] = 40; px.data.data[i + 2] = 40; px.data.data[i + 3] = 255; }
doc.setPixels("Test paint", px.data);
const before = editor.undo.length;
const r = await c("run_action", { id: "sample.desaturate" });
const after = doc.getPixels("Test paint").data.data;
if (!(after[0] === after[1] && after[1] === after[2])) throw new Error("not desaturated: " + after.slice(0, 3));
if (editor.undo.length !== before + 1) throw new Error("no undo step");
await c("undo");
const back = doc.getPixels("Test paint").data.data;
if (back[0] !== 200) throw new Error("undo did not restore the pixels: " + back.slice(0, 3));
const sel = await c("run_action", { id: "sample.selection_layer" });
const copy = (await c("list_layers")).layers.find((l) => l.name === "Selection copy");
if (!copy || copy.w !== 200 || copy.h !== 120) throw new Error("selection copy: " + JSON.stringify(copy));
return { action: r, copy: { w: copy.w, h: copy.h, x: copy.x, y: copy.y } };
"""),
    ("plugin_tool_and_panel", """
const H = (await import("./editor/host.js")).host;
editor.setTool("sample.probe");
if (editor.tool !== "sample.probe") throw new Error("tool not set");
const btn = editor.toolButtons["sample.probe"];
if (!btn || !btn.classList.contains("ipc-active")) throw new Error("tool button missing or not active");
const fake = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, button: 0, pressure: 0.5, pointerType: "mouse", type: "pointermove" };
const handled = H.pluginPointer(editor, "move", fake, 150, 100);
if (!handled || !/rgb\\(/.test(editor.status)) throw new Error("hover did not probe: " + editor.status);
const down = H.pluginPointer(editor, "down", { ...fake, type: "pointerdown" }, 150, 100);
if (!down || !editor.pointer || editor.pointer.kind !== "plugin") throw new Error("down not routed");
H.pluginPointer(editor, "up", fake, 150, 100, editor.pointer); editor.pointer = null;
// the key shortcut K selects the tool
editor.setTool("select");
const keyHandled = H.pluginKey(editor, { shiftKey: false }, "k");
if (!keyHandled || editor.tool !== "sample.probe") throw new Error("key K did not select the tool");
editor.setTool("select");
const panel = Array.from(editor.root.querySelectorAll("details > summary")).find((s) => s.textContent === "Sample");
if (!panel) throw new Error("the Sample panel is missing");
const grp = editor.toolsEl.querySelector(".ipc-grp:last-of-type");
return { status: editor.status, panel: !!panel, group: grp && grp.textContent };
"""),
    ("export", """
const r = await c("export", { format: "png", path: %s });
const l = await c("export_layer", { layer: "Title", path: %s });
const m = await c("export_mask", { path: %s });
const st = await c("get_state");
return { image: r.file, layer: l.file, mask: m.file, state_layers: (st.layers || []).length };
""" % (out_path("commands_image.png"), out_path("commands_layer.png"), out_path("commands_mask.png"))),
    ("reload_and_toggle", """
const P = await import("./plugins.js");
const n0 = (await c("list_layers")).layers.length;
await P.reloadPlugins();
let list = await c("list_plugins");
let s = list.plugins.find((p) => p.id === "sample");
if (!s || !s.loaded) throw new Error("sample not loaded after reload: " + JSON.stringify(s));
const poster = (await c("list_layers")).layers.find((l) => l.name === "Poster");
if (!poster || poster.filter !== "sample.posterize") throw new Error("the poster layer lost its filter across the reload");
await P.setEnabled("sample", false);
list = await c("list_plugins"); s = list.plugins.find((p) => p.id === "sample");
if (s.loaded || s.enabled) throw new Error("still enabled");
if (editor.toolButtons["sample.probe"]) throw new Error("tool button still there");
if ((await c("filter_types")).filters.some((f) => f.id === "sample.posterize")) throw new Error("filter still registered");
if (Array.from(editor.root.querySelectorAll("details > summary")).some((x) => x.textContent === "Sample")) throw new Error("panel still there");
await P.setEnabled("sample", true);
list = await c("list_plugins"); s = list.plugins.find((p) => p.id === "sample");
if (!s.loaded) throw new Error("not loaded again: " + s.error);
if (!editor.toolButtons["sample.probe"]) throw new Error("tool button not back");
if ((await c("list_layers")).layers.length !== n0) throw new Error("layer count changed");
return { loaded: s.loaded, registered: s.registered };
"""),
    ("close", """
const before = (await c("list_documents")).documents.length;
const r = await c("close_document", { doc: window.__testDoc });
if (r.documents.length !== before - 1) throw new Error("close_document");
return r;
"""),
]


async def run(c):
    ok = True
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); return 1; })()")
    for name, body in STEPS:
        js = "(async () => { const raw = window.__cmds; const c = (n, a) => raw.commands.run(n, a); %s })()" % body
        try:
            res = await c.eval(js, timeout=300)
            print(f"[ok] {name}: {json.dumps(res)[:300]}")
        except Exception as err:  # noqa: BLE001
            ok = False
            print(f"[FAIL] {name}: {err}")
            break
    try:
        data = await c.eval("window.__posterShot || null")
        if data:
            import base64
            with open(os.path.join(OUT, "commands_posterize.jpg"), "wb") as f:
                f.write(base64.b64decode(data))
    except Exception:  # noqa: BLE001
        pass
    await c.screenshot(os.path.join(OUT, "commands_window.png"))
    for level, text in (await c.logs())[-20:]:
        if level == "error":
            print("  console error:", text[:300])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run)) else 1)
