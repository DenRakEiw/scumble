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

FILES = ["inpaint_canvas.js", "inpaint_filters.js", "inpaint_curves.js", "inpaint_text.js", "inpaint_raster.js", "inpaint_export.js", "inpaint_worker.js"]

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

    # --- several editors share the window (tabs): shortcuts go to the active one only
    ("inpaint_canvas.js",
     "            if (!this.isOpen) return;\n            const t = e.target;\n",
     "            if (!this.isOpen || !host.isActive(this)) return;\n            const t = e.target;\n", 1),

    # --- WebGL2 filters (renderer/editor/inpaint_filters_gl.js, app-only for now) get the first go
    ("inpaint_filters.js",
     'import { curveDefaults, curvesToTables, buildCurvesControl } from "./inpaint_curves.js";\n',
     'import { curveDefaults, curvesToTables, buildCurvesControl } from "./inpaint_curves.js";\nimport { applyFilterGL, applyMatchGL } from "./inpaint_filters_gl.js";\n', 1),
    # colour match: one shader pass instead of the pixel loop (phase 2)
    ("inpaint_filters.js",
     "export function matchCanvas(src, stats, strength) {\n    const W = src.width, H = src.height;\n",
     "export function matchCanvas(src, stats, strength) {\n    const gl = applyMatchGL(src, stats, strength);\n    if (gl) return gl;\n    const W = src.width, H = src.height;\n", 1),
    ("inpaint_filters.js",
     "export const FILTER_IDS = Object.keys(FILTERS);\n",
     "export const FILTER_IDS = Object.keys(FILTERS);\n\n// table builders shared with the WebGL2 path\nexport { levelsTable, brightnessContrastTable, hueSatMatrix, lightnessTable, colorBalanceTables, hueToRgb, LOOK_DEFAULT };\n", 1),
    ("inpaint_filters.js",
     "    const f = FILTERS[id];\n    if (!f) return src;\n    return f.apply(src, params || {}, info);\n",
     "    const f = FILTERS[id];\n    if (!f) return src;\n    if (!info.cpu) { const gl = applyFilterGL(id, src, params || {}, info); if (gl) return gl; }\n    return f.apply(src, params || {}, info);\n", 1),

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

    # --- in-app helpers (phase 3): SAM2 objects and background removal through ONNX Runtime in
    #     the main process take precedence over the ComfyUI helper prompts when a model is present
    ("inpaint_canvas.js",
     "function objectBackendAvailable() {\n    const types = host.nodeTypes();\n",
     "function objectBackendAvailable() {\n    if (host.objectsInApp()) return true;\n    const types = host.nodeTypes();\n", 1),
    ("inpaint_canvas.js",
     'this.setStatus("Object selection needs ComfyUI-segment-anything-2 (Kijai) for the SAM2 automatic mask generator."); return; }',
     'this.setStatus("Object selection needs a SAM2 model: download one in Settings › Helpers, or install ComfyUI-segment-anything-2 (Kijai) on the server."); return; }', 1),
    ("inpaint_canvas.js",
     "            if (this.objects && this.objects.hash === hash && this.objects.w === this.width && this.objects.h === this.height) { this.objectsPending = null; return; }\n"
     "            this.setStatus(`Finding objects with ${OBJECT_BACKEND.label} ...`);\n",
     "            if (this.objects && this.objects.hash === hash && this.objects.w === this.width && this.objects.h === this.height) { this.objectsPending = null; return; }\n"
     "            if (host.objectsInApp()) { await host.findObjects(this, { hash, layer }); return; }\n"
     "            this.setStatus(`Finding objects with ${OBJECT_BACKEND.label} ...`);\n", 1),
    # applySegmentsFile = decode the PNG + applySegmentIds (the in-app path hands over the ids directly)
    ("inpaint_canvas.js",
     "            for (let i = 0, j = 0; i < d.length; i += 4, j++) ids[j] = d[i] + (d[i + 1] << 8);\n"
     "            if (pending.layer && w === this.width && h === this.height) {\n",
     "            for (let i = 0, j = 0; i < d.length; i += 4, j++) ids[j] = d[i] + (d[i + 1] << 8);\n"
     "            this.applySegmentIds(ids, w, h, info.count || 0, pending);\n"
     "        } catch (err) {\n"
     "            console.error(err);\n"
     "            this.setStatus(\"Could not read the object map: \" + (err.message || err));\n"
     "        }\n"
     "    }\n"
     "\n"
     "    /** An object label map (0 = none) at w × h becomes this.objects, clipped to the source layer. */\n"
     "    applySegmentIds(ids, w, h, count, pending = {}) {\n"
     "        {\n"
     "            if (pending.layer && w === this.width && h === this.height) {\n", 1),
    ("inpaint_canvas.js",
     "            this.objects = { hash: pending.hash, w, h, ids, count: info.count || 0, layerId: pending.layer ? pending.layer.id : null };\n",
     "            this.objects = { hash: pending.hash, w, h, ids, count, layerId: pending.layer ? pending.layer.id : null };\n", 1),
    ("inpaint_canvas.js",
     "            this.setStatus(`${info.count || 0} objects found. Hover to preview, click to select, click again to deselect (Shift adds, Alt subtracts).`);\n"
     "            if (this.hover) this.updateObjectHover(this.hover[0], this.hover[1]);\n"
     "            this.draw();\n"
     "        } catch (err) {\n"
     "            console.error(err);\n"
     "            this.setStatus(\"Could not read the object map: \" + (err.message || err));\n"
     "        }\n"
     "    }\n",
     "            this.setStatus(`${count} objects found. Hover to preview, click to select, click again to deselect (Shift adds, Alt subtracts).`);\n"
     "            if (this.hover) this.updateObjectHover(this.hover[0], this.hover[1]);\n"
     "            this.draw();\n"
     "        }\n"
     "    }\n", 1),
    # a click beside every object: one SAM2 point prompt on the cached embedding (in-app only)
    ("inpaint_canvas.js",
     '        if (!id) { this.setStatus("No object here. Use the brush or lasso for this spot."); return; }\n',
     '        if (!id) { if (host.objectsInApp()) { host.selectPoint(this, ix, iy, p); return; } this.setStatus("No object here. Use the brush or lasso for this spot."); return; }\n', 1),
    # the local / api select switches the recipe (host.onModeChanged in the shell)
    ("inpaint_canvas.js",
     '        this.modeSel.addEventListener("change", () => { this.genSettings.mode = this.modeSel.value; this.syncGenControls(); this.renderInfo(); this.notifyChanged(); });\n',
     '        this.modeSel.addEventListener("change", () => { this.genSettings.mode = this.modeSel.value; this.syncGenControls(); this.renderInfo(); this.notifyChanged(); host.modeChanged(this, this.modeSel.value); });\n', 1),
    # setting presets (model / text encoder / VAE) at the top of the Settings section
    ("inpaint_canvas.js",
     "        for (const t of targets) {\n            const key = String(t.index);\n            const entry = this.settings[key];\n            if (!entry) continue;\n            const k = this.settingKind(t);\n            const lab = el(\"label\", null, entry.label);\n",
     "        host.renderPresets(this, list, targets);\n        for (const t of targets) {\n            const key = String(t.index);\n            const entry = this.settings[key];\n            if (!entry) continue;\n            const k = this.settingKind(t);\n            const lab = el(\"label\", null, entry.label);\n", 1),
    # prompt upsampling: API language models (host.upsampleBackends, provider keys) after the ComfyUI nodes
    ("inpaint_canvas.js",
     "function availableUpsampleBackends() {\n    const types = host.nodeTypes();\n    return UPSAMPLE_BACKENDS.filter((b) => b.needs.every((n) => !!types[n]));\n}\n",
     "function availableUpsampleBackends() {\n    const types = host.nodeTypes();\n    return [...UPSAMPLE_BACKENDS.filter((b) => b.needs.every((n) => !!types[n])), ...host.upsampleBackends()];\n}\n", 1),
    ("inpaint_canvas.js",
     '{ const o = document.createElement("option"); o.value = ""; o.textContent = "no language model nodes installed"; this.upBackendSel.appendChild(o); }',
     '{ const o = document.createElement("option"); o.value = ""; o.textContent = "no language model (Settings › API providers, or ComfyUI-QwenVL)"; this.upBackendSel.appendChild(o); }', 1),
    ("inpaint_canvas.js",
     "        const backend = UPSAMPLE_BACKENDS.find((b) => b.id === this.upBackendSel.value) || availableUpsampleBackends()[0];\n"
     '        if (!backend) { this.setStatus("No language model nodes installed (ComfyUI-QwenVL, or the Gemini API node)."); return; }\n',
     "        const backend = availableUpsampleBackends().find((b) => b.id === this.upBackendSel.value) || availableUpsampleBackends()[0];\n"
     '        if (!backend) { this.setStatus("No language model: add an OpenAI, Google or Anthropic key in Settings › API providers, or install ComfyUI-QwenVL on the server."); return; }\n', 1),
    ("inpaint_canvas.js",
     "            this.setStatus(`Upsampling the prompt for \"${useCase}\" with ${backend.label} ...`);\n"
     "            const { ref } = await uploadCanvas(this.promptContextCanvas(), `n${this.node.id}_promptctx`);\n",
     "            this.setStatus(`Upsampling the prompt for \"${useCase}\" with ${backend.label} ...`);\n"
     "            if (backend.inApp) { await host.upsampleInApp(this, backend, upsampleInstruction(useCase, text, region, this.getBounds() ? this.selectionLabel : \"\")); return; }\n"
     "            const { ref } = await uploadCanvas(this.promptContextCanvas(), `n${this.node.id}_promptctx`);\n", 1),
    # select by text from the prompt: an API language model names the object before the segmentation prompt is built
    ("inpaint_canvas.js",
     "        const llm = fromPrompt ? (UPSAMPLE_BACKENDS.find((b) => b.id === this.upBackendSel.value) || availableUpsampleBackends()[0]) : null;\n",
     "        const llm = fromPrompt ? (availableUpsampleBackends().find((b) => b.id === this.upBackendSel.value) || availableUpsampleBackends()[0]) : null;\n", 1),
    ("inpaint_canvas.js",
     "            if (fromPrompt) {\n                // term_run: VLM -> STRING, linked straight into the segmentation node's prompt input\n",
     "            if (fromPrompt && llm.inApp) {\n"
     "                text = (await host.askLLM(llm, segmentTermInstruction(this.promptInput.value.trim()), this.promptContextCanvas())).text.replace(/[.\"']/g, \"\").trim();\n"
     "                if (!text) throw new Error(`${llm.label} named no object`);\n"
     "                this.setStatus(`Segmenting \"${text}\" (from the prompt, ${llm.label}) with ${backend.label} ...`);\n"
     "            } else if (fromPrompt) {\n                // term_run: VLM -> STRING, linked straight into the segmentation node's prompt input\n", 1),
    # cutout: in-app matting models are listed first
    ("inpaint_canvas.js",
     "function availableCutoutBackends() {\n    const types = host.nodeTypes();\n    return CUTOUT_BACKENDS.filter((b) => b.needs.every((n) => !!types[n]));\n}\n",
     "function availableCutoutBackends() {\n    const types = host.nodeTypes();\n    return [...host.cutoutBackends(), ...CUTOUT_BACKENDS.filter((b) => b.needs.every((n) => !!types[n]))];\n}\n", 1),
    ("inpaint_canvas.js",
     '{ const o = document.createElement("option"); o.value = ""; o.textContent = "no RMBG nodes"; this.cutoutSel.appendChild(o); }',
     '{ const o = document.createElement("option"); o.value = ""; o.textContent = "no model (Settings › Helpers)"; this.cutoutSel.appendChild(o); }', 1),
    ("inpaint_canvas.js",
     "        const backend = CUTOUT_BACKENDS.find((b) => b.id === this.cutoutSettings.backend && availableCutoutBackends().includes(b)) || availableCutoutBackends()[0];\n"
     '        if (!backend) { this.setStatus("No background removal nodes installed (comfyui-rmbg or ComfyUI-BRIA_AI-RMBG)."); return; }\n',
     "        const availCut = availableCutoutBackends();\n"
     "        const backend = availCut.find((b) => b.id === this.cutoutSettings.backend) || availCut[0];\n"
     '        if (!backend) { this.setStatus("No background removal model: download one in Settings › Helpers, or install comfyui-rmbg on the server."); return; }\n', 1),
    ("inpaint_canvas.js",
     "            this.setStatus(`Removing the background of ${layer.name} with ${backend.label} ...`);\n"
     "            // The layer's own pixels (transparent parts turn black on the way to RGB).\n",
     "            this.setStatus(`Removing the background of ${layer.name} with ${backend.label} ...`);\n"
     "            if (backend.inApp) { const img = await host.cutoutInApp(this, layer, backend); await this.applyCutoutImage(img, this.cutoutPending); return; }\n"
     "            // The layer's own pixels (transparent parts turn black on the way to RGB).\n", 1),
    # applyCutoutFile = load the PNG + applyCutoutImage (the in-app path hands over a canvas)
    ("inpaint_canvas.js",
     "            const img = await loadImageEl(viewUrl({ filename: info.filename, subfolder: info.subfolder || SUBFOLDER, type: info.type || \"temp\" }));\n"
     "            const W = layer.canvas.width, H = layer.canvas.height;\n",
     "            const img = await loadImageEl(viewUrl({ filename: info.filename, subfolder: info.subfolder || SUBFOLDER, type: info.type || \"temp\" }));\n"
     "            await this.applyCutoutImage(img, pending);\n"
     "        } catch (err) {\n"
     "            console.error(err);\n"
     "            this.setStatus(\"Could not apply the cutout: \" + (err.message || err));\n"
     "            if (this.cutoutPending === pending) this.cutoutPending = null;\n"
     "            this.renderLayers();\n"
     "        }\n"
     "    }\n"
     "\n"
     "    /** A grayscale mask (any size, white = keep) for the pending cutout's layer -> its transparency mask. */\n"
     "    async applyCutoutImage(img, pending) {\n"
     "        const layer = pending.layer;\n"
     "        try {\n"
     "            const W = layer.canvas.width, H = layer.canvas.height;\n", 1),
    # trademark note on the film preset list (decided 2026-09-08: keep the real names, add the disclaimer)
    ("inpaint_canvas.js",
     'sel.title = "Film stock: sets amount, grain size and colour share (grain character only, the colour look is a LUT\'s job). Values assume a picture of about 2000 px.";',
     'sel.title = p.title || (p.key !== "preset" ? p.label : "Film stock: sets amount, grain size and colour share (grain character only, the colour look is a LUT\'s job). Values assume a picture of about 2000 px. Film names are trademarks of their owners; the looks are Scumble\'s own approximations, not licensed products.");', 1),

    # Free VRAM also releases the in-app sessions; without a server only those
    ("inpaint_canvas.js",
     "    async freeHelperModels() {\n        try {\n            this.setStatus(\"Freeing helper models (SAM, Qwen-VL) from VRAM ...\");\n",
     "    async freeHelperModels() {\n        try { await host.freeHelpers(); } catch (err) { console.warn(err); }\n        if (!host.connected) { this.helperUsed = false; this.setStatus(\"In-app helper models freed.\"); return; }\n        try {\n            this.setStatus(\"Freeing helper models (SAM, Qwen-VL) from VRAM ...\");\n", 1),
    # --- phase 4: command core and plugins (renderer/commands.js, renderer/plugins.js) ----------
    # the tool column and its addTool helper are reachable, so plugin tools get a button
    ("inpaint_canvas.js",
     '        const tools = el("div", "ipc-tools");\n',
     '        const tools = el("div", "ipc-tools");\n        this.toolsEl = tools;\n', 1),
    ("inpaint_canvas.js",
     "        // Tool groups: one button per family, the button shows the family's current tool; hover,\n",
     "        this._addTool = addTool;\n        // Tool groups: one button per family, the button shows the family's current tool; hover,\n", 1),
    # plugin panels: a section in either side pane, added after the editor is built
    ("inpaint_canvas.js",
     "            build(d, sum);\n            pane.appendChild(d);\n            return d;\n        };\n",
     "            build(d, sum);\n            pane.appendChild(d);\n            return d;\n        };\n"
     "        this.addSection = (title, open, build, paneId) => { const prev = pane; pane = this.panes[paneId] || prev; try { return section(title, open, build); } finally { pane = prev; } };\n", 1),
    ("inpaint_canvas.js",
     "        this.resizeObserver.observe(this.viewEl);\n    }\n\n    buildSubbar() {\n",
     "        this.resizeObserver.observe(this.viewEl);\n        host.editorBuilt(this);\n    }\n\n    buildSubbar() {\n", 1),
    # plugin tools: the pointer gestures and single-key shortcuts are offered to the host first
    ("inpaint_canvas.js",
     "        if (e.button !== 0) return;\n        const [ix, iy] = this.toImage(e);\n        if (this.base) {\n",
     "        if (e.button !== 0) return;\n        const [ix, iy] = this.toImage(e);\n        if (host.pluginPointer(this, \"down\", e, ix, iy)) return;\n        if (this.base) {\n", 1),
    ("inpaint_canvas.js",
     "        this.hover = [ix, iy];\n        const p = this.pointer;\n        if (!p) {\n",
     "        this.hover = [ix, iy];\n        if (host.pluginPointer(this, \"move\", e, ix, iy)) return;\n        const p = this.pointer;\n        if (!p) {\n", 1),
    ("inpaint_canvas.js",
     "        this.pointer = null;\n        this.viewEl.classList.remove(\"ipc-panning\");\n        try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }\n",
     "        this.pointer = null;\n        this.viewEl.classList.remove(\"ipc-panning\");\n        try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }\n"
     "        if (p.kind === \"plugin\") { host.pluginPointer(this, \"up\", e, ...this.toImage(e), p); return; }\n", 1),
    ("inpaint_canvas.js",
     '        switch (k) {\n            case "1": this.zoomTo(1); break;\n',
     '        if (host.pluginKey(this, e, k)) return;\n        switch (k) {\n            case "1": this.zoomTo(1); break;\n', 1),
    ("inpaint_canvas.js",
     "        this.tool = tool;\n        if (this.hardCtl) {\n",
     "        const prevTool = this.tool;\n        this.tool = tool;\n        host.toolChanged(this, tool, prevTool);\n        if (this.hardCtl) {\n", 1),
    # --- phase 4b: only the select param named "preset" fills the other params and renames the layer;
    #     plugin selects for a mode / style / colour just set their value
    ("inpaint_canvas.js",
     "                    this.pushUndo({ kind: \"filter\", id: layer.id });\n                    layer.params[p.key] = preset.id;\n                    for (const [k, v] of Object.entries(preset))",
     "                    this.pushUndo({ kind: \"filter\", id: layer.id });\n                    layer.params[p.key] = preset.id;\n                    if (p.key !== \"preset\") { this.markFilterChanged(layer); return; }\n                    for (const [k, v] of Object.entries(preset))", 1),
    ("inpaint_canvas.js",
     "                presetSel = sel;\n                box.appendChild(sel);\n",
     "                if (p.key === \"preset\") presetSel = sel;\n                box.appendChild(sel);\n", 1),
    # --- phase 4b: plugin tools draw on the overlay (image coordinates, before the screen-space part)
    ("inpaint_canvas.js",
     "        ctx.setTransform(1, 0, 0, 1, 0, 0);\n        if (this.compare && this.compare.a && this.compare.b) {\n",
     "        host.pluginOverlay(this, ctx);\n        ctx.setTransform(1, 0, 0, 1, 0, 0);\n        if (this.compare && this.compare.a && this.compare.b) {\n", 1),
]

# Everything from this marker to the end of the file is the litegraph extension
# (node widget, queuePrompt wrapper, event routing); host.js does that part.
EXTENSION_MARKER = "// ---------------------------------------------------------------------------\n// extension registration\n"
EXPORTS = "\nexport { InpaintEditor, viewUrl, loadImageEl, makeCanvas, uploadBlob, uploadCanvas, CROP_DEFAULTS, GEN_DEFAULTS, FIXED_OUTPUTS, SETTING_SLOTS, el, icon, iconButton, miniButton, selectInput, numberInput };\n"


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
