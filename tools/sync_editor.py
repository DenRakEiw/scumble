"""Copy the editor from the ComfyUI-InpaintCanvas node into renderer/editor and apply the
app patches.

Run:  python tools/sync_editor.py [--node PATH]

The node repo stays the source of the editor for now (docs/SYNC.md). Every difference
between the node's js and the app's copy is one entry in PATCHES below, so a re-sync
after node changes is: run this script, fix the patches that no longer match, done.
Each patch must match exactly `count` times, otherwise the script stops and says so.
"""
import argparse
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_NODE = r"F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-InpaintCanvas"
DEST = os.path.join(ROOT, "renderer", "editor")

FILES = ["inpaint_canvas.js", "inpaint_filters.js", "inpaint_curves.js", "inpaint_text.js", "inpaint_raster.js", "inpaint_export.js"]

# (file, old, new, count)
PATCHES = [
    # --- imports: app/api come from host.js, the bridge is not part of the app yet (phase 4)
    ("inpaint_canvas.js",
     'import { app } from "../../scripts/app.js";\nimport { api } from "../../scripts/api.js";\n',
     'import { api, host } from "./host.js";\n', 1),
    ("inpaint_canvas.js", 'import { installBridge } from "./inpaint_bridge.js";\n', "", 1),
    ("inpaint_text.js", 'import { api } from "../../scripts/api.js";\n', 'import { api } from "./host.js";\n', 1),

    # --- node type availability (helper backends) comes from /object_info
    ("inpaint_canvas.js", "(window.LiteGraph && LiteGraph.registered_node_types) || {}", "host.nodeTypes()", 4),
    ("inpaint_canvas.js",
     'const t = window.LiteGraph && LiteGraph.registered_node_types["CheckpointLoaderSimple"];',
     'const t = host.nodeTypes()["CheckpointLoaderSimple"];', 1),

    # --- the editor is the window, not an overlay: it mounts into the shell and Escape never closes it
    ("inpaint_canvas.js", '        top.appendChild(el("span", "ipc-title", "Inpaint Canvas"));\n', "", 1),
    ("inpaint_canvas.js", "        document.body.appendChild(this.root);\n", "        host.mount(this.root);\n", 1),
    ("inpaint_canvas.js",
     'this.setStatus("Compare ended."); }\n                else this.close();',
     'this.setStatus("Compare ended."); }\n                else host.onEscape(this);', 1),
    ("inpaint_canvas.js",
     'if (e.key === "Escape") { e.preventDefault(); if (this.pending) this.cancelPending(); else this.close(); return; }',
     'if (e.key === "Escape") { e.preventDefault(); if (this.pending) this.cancelPending(); else host.onEscape(this); return; }', 1),

    ("inpaint_canvas.js",
     '        const closeBtn = iconButton("close", "Close editor (Esc)", () => this.close());\n        closeBtn.classList.add("ipc-danger");\n        top.appendChild(closeBtn);\n',
     "", 1),
    ("inpaint_canvas.js",
     '"Wheel: zoom · Space/middle: pan · [ ]: size · Esc: close"', '"Wheel: zoom · Space/middle: pan · [ ]: size · Ctrl+Enter: generate"', 1),
    ("inpaint_canvas.js",
     'iconButton("download", "Save and also download the file in the browser", () => this.exportImage({ download: true }), "Download");',
     'iconButton("download", "Save the image to a file (Ctrl+S)", () => this.exportImage({ download: true }), "Save as");', 1),

    # --- files still referenced (cleanup): no graph, no workflow tabs
    ("inpaint_canvas.js",
     "        for (const n of (app.graph && app.graph._nodes) || []) {\n            const ed = n.inpaintEditor;\n            if (!ed) continue;\n",
     "        for (const ed of host.editors()) {\n", 1),
    ("inpaint_canvas.js",
     "        try {\n            const wf = app.extensionManager && app.extensionManager.workflow;\n            for (const w of (wf && wf.openWorkflows) || []) {\n                scan(w.content || w.originalContent || \"\");\n                if (w.activeState) scan(JSON.stringify(w.activeState));\n                if (w.initialState) scan(JSON.stringify(w.initialState));\n            }\n        } catch (_) { /* ignore */ }\n",
     "", 1),

    # --- export: native save dialog instead of ComfyUI's output folder
    ("inpaint_canvas.js",
     "const workflow = this.node.graph && this.node.graph.serialize ? this.node.graph.serialize() : app.graph.serialize();",
     "const workflow = host.workflowForPng(this);", 1),
    ("inpaint_canvas.js",
     "            // Into the output root like SaveImage, not into inpaint_canvas (that folder is working files the cleanup may delete).\n"
     "            const ref = await uploadBlob(blob, `${stem}.${fmt}`, { overwrite: false, type: \"output\", subfolder: \"\" });\n"
     "            const kb = Math.round(blob.size / 1024);\n"
     "            this.setStatus(`Saved output/${ref.subfolder ? ref.subfolder + \"/\" : \"\"}${ref.filename} (${this.width} × ${this.height}, ${kb >= 1024 ? (kb / 1024).toFixed(1) + \" MB\" : kb + \" kB\"}${fmt === \"png\" ? \", workflow embedded\" : \"\"}${note}).`);\n"
     "            if (download) {\n"
     "                const url = URL.createObjectURL(blob);\n"
     "                const a = document.createElement(\"a\");\n"
     "                a.href = url; a.download = ref.filename;\n"
     "                document.body.appendChild(a); a.click(); a.remove();\n"
     "                setTimeout(() => URL.revokeObjectURL(url), 5000);\n"
     "            }\n"
     "            return ref;\n",
     "            const saved = await host.saveExport(blob, `${stem}.${fmt}`);\n"
     "            if (!saved) { this.setStatus(\"Save cancelled.\"); return null; }\n"
     "            const kb = Math.round(blob.size / 1024);\n"
     "            this.setStatus(`Saved ${saved.path} (${this.width} × ${this.height}, ${kb >= 1024 ? (kb / 1024).toFixed(1) + \" MB\" : kb + \" kB\"}${fmt === \"png\" ? \", recipe embedded\" : \"\"}${note}).`);\n"
     "            return saved;\n", 1),

    ("inpaint_canvas.js",
     "            const ref = await uploadBlob(blob, `${stem}.png`, { overwrite: false, type: \"output\", subfolder: \"\" });\n"
     "            this.setStatus(`Saved output/${ref.filename} (${l.name}, ${this.width} × ${this.height} with transparency).`);\n"
     "            return ref;\n",
     "            const saved = await host.saveExport(blob, `${stem}.png`);\n"
     "            if (!saved) { this.setStatus(\"Save cancelled.\"); return null; }\n"
     "            this.setStatus(`Saved ${saved.path} (${l.name}, ${this.width} × ${this.height} with transparency).`);\n"
     "            return saved;\n", 1),
    ("inpaint_canvas.js",
     "            const ref = await uploadBlob(blob, `${stem}_mask.png`, { overwrite: false, type: \"output\", subfolder: \"\" });\n"
     "            this.setStatus(`Saved output/${ref.filename} (mask, white = selected).`);\n"
     "            return ref;\n",
     "            const saved = await host.saveExport(blob, `${stem}_mask.png`);\n"
     "            if (!saved) { this.setStatus(\"Save cancelled.\"); return null; }\n"
     "            this.setStatus(`Saved ${saved.path} (mask, white = selected).`);\n"
     "            return saved;\n", 1),
    ("inpaint_canvas.js",
     '"Save the active layer alone as a PNG with transparency (output folder)"', '"Save the active layer alone as a PNG file with transparency"', 1),
    ("inpaint_canvas.js",
     '"Save the selection as a black and white mask PNG (output folder)"', '"Save the selection as a black and white mask PNG file"', 1),

    # --- the node's own widgets (padding, target_size, feather, multiple_of) get controls in the Generate section
    ("inpaint_canvas.js",
     "            sec.appendChild(this.refineBtn);\n",
     "            sec.appendChild(this.refineBtn);\n            host.buildGenerateExtras(this, sec);\n", 1),

    # --- node widgets, setting outputs, result inputs: the recipe answers instead of the graph
    ("inpaint_canvas.js",
     "    widgetValue(name, fallback) {\n        const w = this.node.widgets && this.node.widgets.find((x) => x.name === name);\n        return w ? (+w.value || 0) : fallback;\n    }\n",
     "    widgetValue(name, fallback) {\n        return host.widgetValue(this, name, fallback);\n    }\n", 1),
    ("inpaint_canvas.js",
     "    settingTargets() {\n        const res = [];\n        const outs = this.node.outputs || [];\n        const graph = this.node.graph || app.graph;\n",
     "    settingTargets() {\n        return host.settingTargets(this);\n    }\n\n    settingTargetsFromGraph() {\n        const res = [];\n        const outs = this.node.outputs || [];\n        const graph = this.node.graph || null;\n", 1),
    ("inpaint_canvas.js",
     "    resultInputState() {\n        const want = this.genSettings.mode === \"local\" ? \"result_local\" : \"result\";\n",
     "    resultInputState() {\n        return host.resultInputState(this);\n    }\n\n    resultInputStateFromGraph() {\n        const want = this.genSettings.mode === \"local\" ? \"result_local\" : \"result\";\n", 1),

    # --- generate: fill the recipe and queue it
    ("inpaint_canvas.js",
     "            try {\n                await app.queuePrompt(0);\n            } catch (first) {\n"
     "                // Some third-party extensions wrap queuePrompt and throw once on the\n"
     "                // first call after a page load. One retry gets past that.\n"
     "                console.warn(\"Inpaint Canvas: queuePrompt failed once, retrying\", first);\n"
     "                await new Promise((r) => setTimeout(r, 300));\n"
     "                await app.queuePrompt(0);\n"
     "            }\n",
     "            await host.queueGenerate(this);\n", 1),
    ("inpaint_canvas.js",
     "    notifyChanged() {\n        try { this.node.graph && this.node.graph.setDirtyCanvas && this.node.graph.setDirtyCanvas(true, true); } catch (_) { /* ignore */ }\n        try { app.canvas && app.canvas.setDirty && app.canvas.setDirty(true, true); } catch (_) { /* ignore */ }\n    }\n",
     "    notifyChanged() {\n        host.changed(this);\n    }\n", 1),
]

# Everything from this marker to the end of the file is the litegraph extension
# (node widget, queuePrompt wrapper, event routing); host.js does that part.
EXTENSION_MARKER = "// ---------------------------------------------------------------------------\n// extension registration\n"
EXPORTS = "\nexport { InpaintEditor, viewUrl, loadImageEl, makeCanvas, uploadBlob, uploadCanvas, CROP_DEFAULTS, GEN_DEFAULTS, FIXED_OUTPUTS, SETTING_SLOTS };\n"


def read(p):
    with open(p, "r", encoding="utf-8", newline="") as f:
        return f.read()


def write(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline=chr(10)) as f:
        f.write(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", default=DEFAULT_NODE)
    args = ap.parse_args()
    src = os.path.join(args.node, "js")
    if not os.path.isdir(src):
        sys.exit(f"node js folder not found: {src}")

    texts = {name: read(os.path.join(src, name)).replace("\r\n", "\n") for name in FILES}
    failed = []
    for fname, old, new, count in PATCHES:
        t = texts[fname]
        n = t.count(old)
        if n != count:
            failed.append((fname, old[:70].replace("\n", "\\n"), n, count))
            continue
        texts[fname] = t.replace(old, new)
    if failed:
        for fname, snippet, n, count in failed:
            print(f"PATCH MISMATCH {fname}: found {n}, expected {count}: {snippet}...")
        sys.exit(1)

    t = texts["inpaint_canvas.js"]
    i = t.find(EXTENSION_MARKER)
    if i < 0:
        sys.exit("extension marker not found in inpaint_canvas.js")
    texts["inpaint_canvas.js"] = t[:i].rstrip("\n") + "\n" + EXPORTS

    header = "// Synced from ComfyUI-InpaintCanvas by tools/sync_editor.py. Do not edit here: change the node or the patch list.\n"
    for name, text in texts.items():
        write(os.path.join(DEST, name), header + text)
        print("wrote", name, f"{len(text.splitlines())} lines")

    fonts_src = os.path.join(src, "fonts")
    fonts_dst = os.path.join(DEST, "fonts")
    if os.path.isdir(fonts_src):
        if os.path.isdir(fonts_dst):
            shutil.rmtree(fonts_dst)
        shutil.copytree(fonts_src, fonts_dst)
        print("copied fonts", len(os.listdir(fonts_dst)), "entries")
    print("ok")


if __name__ == "__main__":
    main()
