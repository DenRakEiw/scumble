// What the editor needs from its surroundings. In the ComfyUI node this was `app`, `api`
// and the litegraph node; here it is one object backed by the main process (see
// tools/sync_editor.py for the exact places in inpaint_canvas.js that call into it).
//
//   api   - ComfyUI's client API surface the editor uses: fetchApi, apiURL, queuePrompt,
//           addEventListener, clientId. Requests go to scumble://app/comfy/*, which the main
//           process proxies to the server, so images and uploads stay same-origin.
//   host  - the document-level services: recipe, settings targets, generate, autosave.
//           Several editors can be open (tabs in the shell); `host.editor` is the active
//           one, `host.editors()` all of them. Server events are routed to the editor
//           that asked: results by prompt id, helper masks / texts by the canvas_node id
//           the helper prompt carried (= editor.node.id).

import { prepareCrop, finishResult, canvasBytes, bytesToImage, transparentPixels } from "./stitch.js";
import { glReleasePool } from "./inpaint_filters_gl.js";

const PROXY = "/comfy";
const SUBFOLDER = "inpaint_canvas";

// How big the crop goes to an API provider. The app is for quality, so "max" is the default:
// the crop is emitted at the provider variant's documented maximum. "x2" / "x4" are the
// high-res fix - the crop at twice or four times its own size, still held under that maximum -
// and the last two keep the older behaviour. Every one of them is capped by the variant's
// `limits`, which is what keeps a model from being handed a size it answers with an error.
const MAX_EXPORT_SIDE = 32768;
const EXPORT_PERCENTS = [200, 150, 100, 75, 50, 33, 25, 10];

const API_SIZES = [
    ["max", "Provider max", "Send the crop at the biggest size the chosen provider takes (best quality, biggest bill)"],
    ["x2", "2x crop", "High-res fix: the crop at twice its own size, capped at the provider's maximum"],
    ["x4", "4x crop", "High-res fix: the crop at four times its own size, capped at the provider's maximum"],
    ["target", "Target size", "The Target field above, the way local ComfyUI runs use it"],
    ["crop", "Crop size", "The crop at its own resolution, capped at the provider's maximum"],
];

// ---- api ---------------------------------------------------------------------------------

const listeners = new Map();

export const api = {
    clientId: null,

    apiURL(path) {
        return PROXY + path;
    },

    fetchApi(path, init) {
        return fetch(PROXY + path, init);
    },

    /**
     * Queue an API-format prompt. number -1 = front of the queue (helper prompts),
     * 0 = normal. Throws with the server's node errors as text.
     */
    async queuePrompt(number, { output, workflow }) {
        const body = { client_id: api.clientId, prompt: output, extra_data: { extra_pnginfo: { workflow: workflow || {} } } };
        if (number === -1) body.front = true;
        else if (number) body.number = number;
        const r = await fetch(PROXY + "/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        let data = null;
        try { data = await r.json(); } catch (_) { data = null; }
        if (r.status !== 200) {
            const parts = [];
            if (data && data.error) parts.push(data.error.message || String(data.error));
            for (const [id, ne] of Object.entries((data && data.node_errors) || {})) {
                for (const e of ne.errors || []) parts.push(`${ne.class_type || id}: ${e.message}${e.details ? " (" + e.details + ")" : ""}`);
            }
            throw new Error(parts.length ? parts.join("; ") : `/prompt answered ${r.status}`);
        }
        return data;
    },

    addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
    },

    removeEventListener(type, fn) {
        const s = listeners.get(type);
        if (s) s.delete(fn);
    },

    dispatch(type, data) {
        const s = listeners.get(type);
        if (!s) return;
        for (const fn of s) {
            try { fn({ detail: data }); } catch (err) { console.error("listener for", type, err); }
        }
    },
};

// ---- host --------------------------------------------------------------------------------

export const host = {
    editor: null,          // the active editor
    _editors: [],          // every open editor, in tab order
    nextId: 1,             // editor ids (node.id): upload name prefix and helper routing key
    createDocument: null,  // set by the shell: (id) => editor, used by restore()
    onDocsChanged: null,   // set by the shell: () => void, after autosave (tab labels)
    shell: null,           // set by the shell: newDocument, activate, closeDocument, selectRecipe, recipes (for renderer/commands.js)
    commands: null,        // renderer/commands.js: the command core, set by the shell
    plugins: null,         // renderer/plugins.js: pointer / key / tool hooks for plugin tools, set by the shell
    exportPath: null,      // a fixed target for the next saveExport (commands, scripts); no dialog then
    _listeners: new Map(),
    mountEl: null,
    recipe: null,
    objectInfo: null,
    nodeParams: { padding: 64, target_size: 1024, feather: 16, multiple_of: 64 },
    apiSize: "max",        // how big the crop goes to an API provider: max | x2 | x4 | target | crop
    connected: false,
    _pendingStates: [],
    _saveTimer: null,
    _types: {},

    /** Shell setup: where editors mount and the persisted node params. */
    configure({ mount, nodeParams, apiSize } = {}) {
        this.mountEl = mount || document.body;
        if (nodeParams) this.nodeParams = { ...this.nodeParams, ...nodeParams };
        if (API_SIZES.some(([id]) => id === apiSize)) this.apiSize = apiSize;
    },

    /**
     * The size rules for an API run: the chosen provider variant's limits plus the app's
     * size mode. Null for a local ComfyUI recipe, where the node's own target_size rules
     * and the app must not interfere.
     */
    cropLimits() {
        const r = this.recipe;
        if (!r || r.kind !== "provider" || !r.limits) return null;
        return { ...r.limits, mode: this.apiSize };
    },

    setApiSize(mode) {
        if (!API_SIZES.some(([id]) => id === mode)) return;
        this.apiSize = mode;
        window.scumble.settings.set({ apiSize: mode }).catch((err) => console.warn("apiSize not saved", err));
        for (const ed of this._editors) if (ed._apiSizeSelect) ed._apiSizeSelect.value = mode;
    },

    /** Compatibility with the single-editor shell: configure + addEditor + activate. */
    attach(editor, opts = {}) {
        this.configure(opts);
        this.addEditor(editor);
        this.activate(editor);
    },

    addEditor(editor) {
        if (!this._editors.includes(editor)) this._editors.push(editor);
        // the app-only GPU path behind releaseCaches({ deep: true }); the node has none
        editor.releaseGpu = glReleasePool;
        const id = +editor.node.id;
        if (Number.isFinite(id) && id >= this.nextId) this.nextId = id + 1;
        if (!this.editor) this.editor = editor;
        editor.root.classList.toggle("shell-hidden", editor !== this.editor);
        this.applyRecipe(editor);
    },

    removeEditor(editor) {
        const i = this._editors.indexOf(editor);
        if (i >= 0) this._editors.splice(i, 1);
        if (this.editor === editor) this.editor = this._editors[Math.min(i, this._editors.length - 1)] || null;
        if (this.editor) this.activate(this.editor);
        this.emit("removed", { editor });
    },

    /** Show this editor, hide the others; only the active editor gets keyboard shortcuts. */
    activate(editor) {
        if (!editor || !this._editors.includes(editor)) return;
        const prev = this.editor;
        this.editor = editor;
        for (const e of this._editors) e.root.classList.toggle("shell-hidden", e !== editor);
        try { editor.resizeCanvas(); editor.draw(); } catch (_) { /* not open yet */ }
        if (prev !== editor) this.emit("activate", { editor });
    },

    // ---- events for the shell and plugins ---------------------------------------------------
    //   built (editor)            an editor finished building its UI (plugins add panels / tools)
    //   activate (editor)         another tab became active
    //   changed (editor)          a document changed (debounced autosave follows)
    //   tool (editor, tool, prev) the active tool changed
    //   removed (editor)          a tab was closed

    on(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
        return () => this.off(type, fn);
    },

    off(type, fn) {
        const s = this._listeners.get(type);
        if (s) s.delete(fn);
    },

    emit(type, data) {
        const s = this._listeners.get(type);
        if (!s) return;
        for (const fn of Array.from(s)) { try { fn(data); } catch (err) { console.error("host listener", type, err); } }
    },

    /** Patched into the end of the editor constructor (tools/sync_editor.py). */
    editorBuilt(editor) {
        try { this.buildExportSize(editor); } catch (err) { console.warn("export size row", err); }
        this.emit("built", { editor });
    },

    // ---- export size ---------------------------------------------------------------------
    //
    // The editor's Export section saves the flattened image at its own resolution. The app
    // adds a size to it: a percentage or a free width and height, plus the encoder quality
    // for JPEG / WebP. `exportCanvas` and `exportQuality` are what the patched exportImage()
    // asks (tools/sync_editor.py). PSD and ORA always go out at full size, because every
    // layer would have to be scaled on its own.

    /** The per-document export settings, made on first use. */
    exportState(editor) {
        if (!editor._export) editor._export = { percent: 100, width: 0, height: 0, quality: 0.92 };
        return editor._export;
    },

    /** The pixel size an export would have, [w, h], or null when it is the document's own. */
    exportPixels(editor) {
        const e = this.exportState(editor);
        const dw = editor.width | 0, dh = editor.height | 0;
        if (!dw || !dh) return null;
        let w, h;
        if (e.width > 0 && e.height > 0) { w = e.width; h = e.height; }
        else { w = Math.round(dw * e.percent / 100); h = Math.round(dh * e.percent / 100); }
        w = Math.max(1, Math.min(MAX_EXPORT_SIDE, w));
        h = Math.max(1, Math.min(MAX_EXPORT_SIDE, h));
        return w === dw && h === dh ? null : [w, h];
    },

    /**
     * Down to half the size in one draw is what the browser's high-quality filter does well;
     * below that it starts skipping pixels instead of averaging them, so a big reduction is
     * walked down in halving steps. An enlargement is one draw.
     */
    resizeForExport(src, w, h) {
        let cur = src;
        while (cur.width >= w * 2 && cur.height >= h * 2 && cur.width > 1 && cur.height > 1) {
            const next = document.createElement("canvas");
            next.width = Math.max(w, Math.floor(cur.width / 2));
            next.height = Math.max(h, Math.floor(cur.height / 2));
            const c = next.getContext("2d");
            c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
            c.drawImage(cur, 0, 0, next.width, next.height);
            cur = next;
        }
        const out = document.createElement("canvas");
        out.width = w; out.height = h;
        const ctx = out.getContext("2d");
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        ctx.drawImage(cur, 0, 0, w, h);
        return out;
    },

    /** What exportImage() encodes: the flattened image, scaled when the Size row asks for it. */
    exportCanvas(editor, fmt) {
        const canvas = editor.flattenToCanvas({ forRun: true });
        if (fmt === "psd" || fmt === "ora") return canvas;
        const size = this.exportPixels(editor);
        if (!size) return canvas;
        return this.resizeForExport(canvas, size[0], size[1]);
    },

    /** The JPEG / WebP quality exportImage() encodes with (PNG ignores it). */
    exportQuality(editor) {
        const q = +this.exportState(editor).quality;
        return Number.isFinite(q) ? Math.min(1, Math.max(0.1, q)) : 0.92;
    },

    /**
     * Set the export size from the row, a command or a script. A width or a height alone
     * keeps the aspect ratio; `percent` clears a free size again.
     */
    setExportSize(editor, { percent, width, height, quality } = {}) {
        const e = this.exportState(editor);
        if (quality != null) e.quality = Math.min(1, Math.max(0.1, +quality || 0.92));
        if (width != null || height != null) {
            const dw = editor.width | 0, dh = editor.height | 0;
            let w = Math.round(+width || 0), h = Math.round(+height || 0);
            if (w > 0 && !h && dw) h = Math.max(1, Math.round(w * dh / dw));
            if (h > 0 && !w && dh) w = Math.max(1, Math.round(h * dw / dh));
            e.width = Math.max(0, Math.min(MAX_EXPORT_SIDE, w));
            e.height = Math.max(0, Math.min(MAX_EXPORT_SIDE, h));
            if (e.width && dw) e.percent = Math.round(e.width / dw * 1000) / 10;
        } else if (percent != null) {
            e.percent = Math.min(400, Math.max(1, +percent || 100));
            e.width = 0; e.height = 0;
        }
        this.syncExportRow(editor);
        return e;
    },

    /** The Size row the app appends under the editor's Export row. */
    buildExportSize(editor) {
        const anchor = editor.saveFormatSel && editor.saveFormatSel.parentElement;
        if (!anchor) return;
        const row = document.createElement("div");
        row.className = "ipc-seg scumble-export-size";
        const lab = document.createElement("span");
        lab.textContent = "Size";
        lab.title = "How big the saved file is. PSD and ORA always keep the full size.";
        row.appendChild(lab);

        const sel = document.createElement("select");
        sel.className = "ipc-sel";
        sel.style.maxWidth = "72px";
        for (const p of EXPORT_PERCENTS) {
            const o = document.createElement("option");
            o.value = String(p); o.textContent = p + " %";
            sel.appendChild(o);
        }
        const custom = document.createElement("option");
        custom.value = "custom"; custom.textContent = "custom";
        sel.appendChild(custom);
        sel.title = "A percentage of the document size; typing a width or a height switches to custom.";
        sel.addEventListener("keydown", (ev) => ev.stopPropagation());
        sel.addEventListener("change", () => {
            if (sel.value === "custom") {
                const px = this.exportPixels(editor) || [editor.width, editor.height];
                this.setExportSize(editor, { width: px[0], height: px[1] });
            } else {
                this.setExportSize(editor, { percent: +sel.value });
            }
        });
        row.appendChild(sel);

        const num = (title) => {
            const i = document.createElement("input");
            i.type = "number"; i.className = "ipc-num"; i.style.width = "58px"; i.style.minWidth = "0";
            i.min = 1; i.max = MAX_EXPORT_SIDE; i.step = 1; i.title = title;
            i.addEventListener("keydown", (ev) => ev.stopPropagation());
            return i;
        };
        const wIn = num("Width in pixels; the height follows the aspect ratio");
        const hIn = num("Height in pixels; the width follows the aspect ratio");
        wIn.addEventListener("change", () => this.setExportSize(editor, { width: +wIn.value, height: 0 }));
        hIn.addEventListener("change", () => this.setExportSize(editor, { width: 0, height: +hIn.value }));
        row.appendChild(wIn);
        const times = document.createElement("span");
        times.textContent = "×";
        row.appendChild(times);
        row.appendChild(hIn);

        // the quality gets its own line: the panel is too narrow for five controls, and it
        // only concerns JPEG and WebP anyway
        const qRow = document.createElement("div");
        qRow.className = "ipc-seg scumble-export-quality";
        const qLab = document.createElement("span");
        qLab.textContent = "Quality";
        qLab.title = "JPEG / WebP quality, 1 is the best";
        const q = document.createElement("input");
        q.type = "number"; q.className = "ipc-num"; q.style.width = "60px";
        q.min = 0.1; q.max = 1; q.step = 0.02; q.title = qLab.title;
        q.addEventListener("keydown", (ev) => ev.stopPropagation());
        q.addEventListener("change", () => this.setExportSize(editor, { quality: +q.value }));
        qRow.appendChild(qLab);
        qRow.appendChild(q);

        anchor.insertAdjacentElement("afterend", row);
        row.insertAdjacentElement("afterend", qRow);
        editor._exportRow = { row, qRow, sel, wIn, hIn, q, qLab, doc: "" };
        editor.saveFormatSel.addEventListener("change", () => this.syncExportRow(editor));
        // the numbers follow the document: a new image, a crop or an extended canvas changes
        // them. Only a changed document size refreshes the row, so a number being typed in is
        // never overwritten underneath the cursor.
        this.on("changed", ({ editor: ed }) => {
            if (ed !== editor || !editor._exportRow) return;
            if (editor._exportRow.doc !== `${editor.width}x${editor.height}`) this.syncExportRow(editor);
        });
        this.syncExportRow(editor);
    },

    /** Put the state into the row: the numbers, the percentage, and what the format allows. */
    syncExportRow(editor) {
        const r = editor._exportRow;
        if (!r) return;
        const e = this.exportState(editor);
        const px = this.exportPixels(editor) || [editor.width | 0, editor.height | 0];
        r.doc = `${editor.width}x${editor.height}`;
        r.wIn.value = px[0] || "";
        r.hIn.value = px[1] || "";
        r.q.value = e.quality;
        const exact = EXPORT_PERCENTS.find((p) => Math.abs(p - e.percent) < 0.05);
        r.sel.value = exact != null ? String(exact) : "custom";
        const fmt = (editor.saveFormatSel && editor.saveFormatSel.value) || "png";
        const layered = fmt === "psd" || fmt === "ora";
        for (const el of [r.sel, r.wIn, r.hIn]) el.disabled = layered;
        r.row.title = layered ? "PSD and ORA always keep the full size" : "";
        r.qRow.hidden = !(fmt === "jpg" || fmt === "webp");
    },

    toolChanged(editor, tool, prev) {
        this.emit("tool", { editor, tool, prev });
    },

    /**
     * Pointer gestures on the canvas are offered to plugin tools first (patched into
     * onPointerDown / Move / Up). Returns true when a plugin tool took the event.
     */
    pluginPointer(editor, phase, e, ix, iy, p) {
        return this.plugins ? this.plugins.pointer(editor, phase, e, ix, iy, p) : false;
    },

    /** Single-key shortcuts of plugin tools and actions (patched into onKey before the tool switch). */
    pluginKey(editor, e, k) {
        return this.plugins ? this.plugins.key(editor, e, k) : false;
    },

    /** Plugin tools draw on the canvas overlay (patched into drawOverlays, view transform applied). */
    pluginOverlay(editor, ctx) {
        if (this.plugins) this.plugins.overlay(editor, ctx);
    },

    isActive(editor) {
        return editor === this.editor;
    },

    editors() {
        return this._editors.slice();
    },

    editorById(id) {
        return this._editors.find((e) => String(e.node.id) === String(id)) || null;
    },

    /** The editor whose generate / helper prompt has this id, if any. */
    editorByPrompt(promptId) {
        if (!promptId) return null;
        return this._editors.find((e) => e.lastPromptId === promptId || e.segmentPromptId === promptId || e.objectsPromptId === promptId
            || e.upsamplePromptId === promptId || e.cutoutPromptId === promptId) || null;
    },

    mount(rootEl) {
        (this.mountEl || document.body).appendChild(rootEl);
    },

    onEscape(editor) {
        editor.setStatus("Nothing to cancel.");
    },

    /** Litegraph's registered_node_types look-alike: { className: { nodeData } } from /object_info. */
    nodeTypes() {
        return this._types;
    },

    async loadObjectInfo() {
        const r = await api.fetchApi("/object_info");
        if (r.status !== 200) throw new Error("/object_info answered " + r.status);
        this.objectInfo = await r.json();
        const types = {};
        for (const [name, info] of Object.entries(this.objectInfo)) types[name] = { nodeData: info };
        this._types = types;
        return this.objectInfo;
    },

    async onConnected(status) {
        api.clientId = await window.scumble.comfy.clientId();
        try { await this.loadObjectInfo(); } catch (err) { console.warn(err); this.objectInfo = null; this._types = {}; }
        this.connected = true;
        for (const ed of this._editors) {
            // Uploads are cached per hash; a (possibly different) server may not have them.
            // The mirror re-uploads what a run needs (ensureOnServer), the reset only makes
            // sure the next run hashes the composite again.
            ed.uploaded = ed.makeUploaded();
            if (!status.node) ed.setStatus("ComfyUI is connected but the Inpaint Canvas node pack is missing: install ComfyUI-InpaintCanvas on that server (ComfyUI Manager or git clone).");
            else if (!ed.base) ed.setStatus(`Connected to ${status.message}. Load an image (Ctrl+O, drop a file, or paste).`);
            ed.refreshSegmentBackends();
            ed.settingsChanged();
        }
        const pending = this._pendingStates;
        this._pendingStates = [];
        for (const { editor: ed, state } of pending) {
            if (!this._editors.includes(ed)) continue;
            try { await ed.setValue(state); if (ed.base) ed.setStatus("Last session restored."); } catch (err) { console.warn("restore failed", err); }
        }
    },

    /**
     * Restore the autosaved session: either a bundle { version: 2, docs: [{id, state}],
     * active, nextId } or, from older builds, one editor's state JSON. Editors are
     * created through this.createDocument. The layer files normally sit in the local
     * mirror, so this works offline; a document whose base is not mirrored (state from
     * before the mirror existed) waits for the server.
     */
    async restore(saved) {
        if (!saved) return false;
        let bundle = null;
        try { bundle = JSON.parse(saved); } catch (_) { bundle = null; }
        const docs = bundle && Array.isArray(bundle.docs) ? bundle.docs : [{ id: this.nextId, state: saved }];
        if (bundle && +bundle.nextId > this.nextId) this.nextId = +bundle.nextId;
        let any = false;
        for (const doc of docs) {
            if (!doc || typeof doc.state !== "string" || doc.state.length < 3) continue;
            let ed = this.editorById(doc.id);
            if (!ed) ed = this.createDocument ? this.createDocument(+doc.id || this.nextId++) : this.editor;
            if (!ed) continue;
            try { await ed.setValue(doc.state); } catch (err) { console.warn("restore from the mirror failed", err); }
            if (ed.base) { ed.setStatus("Last session restored."); any = true; }
            else if (!this.connected) { this._pendingStates.push({ editor: ed, state: doc.state }); ed.setStatus("This document will be restored once ComfyUI is connected (its files are not in the local store)."); }
        }
        const active = bundle && this.editorById(bundle.active);
        if (active) this.activate(active);
        if (this.onDocsChanged) this.onDocsChanged();
        return any;
    },

    // ---- recipe: the graph the editor is wired into ------------------------------------

    setRecipe(recipe) {
        this.recipe = recipe;
        for (const ed of this._editors) this.applyRecipe(ed);
    },

    onModeChanged: null,   // set by the shell: (mode, editor) => void

    /** The editor's local / api select: the shell switches to a recipe of that kind. */
    modeChanged(editor, mode) {
        if (this.onModeChanged) { try { this.onModeChanged(mode, editor); } catch (err) { console.warn(err); } }
    },

    // ---- setting presets: a named model / text encoder / VAE combination per recipe ----

    presets: {},   // settings.recipePresets: { [recipeId]: [{ name, values: { "node:input": value } }] }

    /** The settings a preset stores: file combos (unet_name, ckpt_name, clip_name, vae_name, lora_name ...). */
    presetTargets(editor, targets) {
        return targets.filter((t) => {
            const k = editor.settingKind(t);
            return k.kind === "combo" && /_name$/.test(t.inputName) && k.options.some((o) => /\.[a-z0-9]{2,12}$/i.test(String(o)));
        });
    },

    async savePresets(recipeId, list) {
        this.presets = { ...(this.presets || {}), [recipeId]: list };
        try { await window.scumble.settings.set({ recipePresets: this.presets }); } catch (err) { console.warn("presets", err); }
    },

    /** The preset row at the top of the editor's Settings section (called by renderSettings). */
    renderPresets(editor, list, targets) {
        const r = this.recipe;
        if (!r || r.kind === "provider") return;
        const pts = this.presetTargets(editor, targets);
        if (pts.length < 2) return;
        const keyOf = (t) => `${t.node.id}:${t.inputName}`;
        const current = {};
        for (const t of pts) { const e = editor.settings[String(t.index)]; if (e) current[keyOf(t)] = String(e.value); }
        const presets = (this.presets || {})[r.id] || [];
        const matching = presets.find((p) => Object.entries(p.values || {}).every(([k, v]) => current[k] === String(v)));
        const lab = document.createElement("label");
        lab.textContent = "Preset";
        lab.title = `A saved combination of ${pts.map((t) => t.node.title || t.inputName).join(" / ")} for this recipe. Pick the files above, then Save.`;
        const row = document.createElement("div");
        row.className = "ipc-preset-row";
        const sel = document.createElement("select");
        sel.className = "ipc-sel";
        sel.title = lab.title;
        const none = document.createElement("option");
        none.value = ""; none.textContent = presets.length ? (matching ? "" : "(custom)") : "(none saved)";
        if (!matching) sel.appendChild(none);
        for (const p of presets) { const o = document.createElement("option"); o.value = p.name; o.textContent = p.name; sel.appendChild(o); }
        sel.value = matching ? matching.name : "";
        sel.addEventListener("change", () => { const p = presets.find((x) => x.name === sel.value); if (p) this.applyPreset(editor, targets, p); });
        const save = document.createElement("button");
        save.type = "button"; save.className = "ipc-ib"; save.textContent = "Save"; save.title = "Save the current combination under a name (Enter saves, Escape cancels).";
        const del = document.createElement("button");
        del.type = "button"; del.className = "ipc-ib"; del.textContent = "Delete"; del.disabled = !matching; del.title = matching ? `Delete the preset "${matching.name}"` : "Delete the selected preset";
        save.addEventListener("click", () => {
            // the select becomes a name field: the first file's stem is the suggestion
            const first = pts[0] && editor.settings[String(pts[0].index)];
            const stem = first ? String(first.value).replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "") : "";
            const input = document.createElement("input");
            input.type = "text"; input.value = matching ? matching.name : stem; input.placeholder = "preset name"; input.spellcheck = false;
            const finish = async (ok) => {
                const name = input.value.trim();
                if (ok && name) {
                    const values = {};
                    for (const t of pts) { const e = editor.settings[String(t.index)]; if (e) values[keyOf(t)] = e.value; }
                    const next = presets.filter((p) => p.name !== name).concat([{ name, values }]).sort((a, b) => a.name.localeCompare(b.name));
                    await this.savePresets(r.id, next);
                    for (const ed of this._editors) { try { ed.renderSettings(); } catch (_) { /* not built */ } }
                    editor.setStatus(`Preset "${name}" saved for ${r.name || r.id}.`);
                } else {
                    editor.renderSettings();
                }
            };
            input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); finish(true); } if (e.key === "Escape") { e.preventDefault(); finish(false); } });
            row.replaceChild(input, sel);
            save.textContent = "OK";
            save.onclick = () => finish(true);
            del.textContent = "Cancel"; del.disabled = false; del.onclick = () => finish(false);
            input.focus(); input.select();
        });
        del.addEventListener("click", async () => {
            if (!matching || del.textContent !== "Delete") return;
            await this.savePresets(r.id, presets.filter((p) => p.name !== matching.name));
            for (const ed of this._editors) { try { ed.renderSettings(); } catch (_) { /* not built */ } }
            editor.setStatus(`Preset "${matching.name}" deleted.`);
        });
        row.append(sel, save, del);
        lab.appendChild(row);
        list.appendChild(lab);
    },

    applyPreset(editor, targets, preset) {
        const missing = [];
        for (const t of this.presetTargets(editor, targets)) {
            const v = (preset.values || {})[`${t.node.id}:${t.inputName}`];
            const e = editor.settings[String(t.index)];
            if (v == null || !e) continue;
            const k = editor.settingKind(t);
            if (k.options.map(String).includes(String(v))) e.value = v; else missing.push(String(v));
        }
        editor.renderSettings();
        editor.notifyChanged();
        editor.setStatus(missing.length ? `Preset "${preset.name}": ${missing.join(", ")} not on the server, kept the current choice there.` : `Preset "${preset.name}" applied.`);
    },

    /** The recipe decides the mode (local / api) and the Settings panel of every editor. */
    applyRecipe(ed) {
        const r = this.recipe;
        if (!r) return;
        const mode = r.kind === "provider" || r.mode === "api" ? "api" : "local";
        if (ed.genSettings.mode !== mode) { ed.genSettings.mode = mode; ed.syncGenControls(); }
        ed.settingsChanged();
        ed.renderInfo();
    },

    /** The recipe's editable inputs in the shape settingTargets() had in the node. */
    settingTargets(editor) {
        const r = this.recipe;
        if (!r) return [];
        const out = [];
        if (r.kind === "provider") {
            // provider parameters: the recipe carries the spec itself (no /object_info)
            for (const s of r.settings || []) {
                const spec = s.spec || ["STRING", {}];
                const value = s.default !== undefined ? s.default : (spec[1] && spec[1].default !== undefined ? spec[1].default : (Array.isArray(spec[0]) ? spec[0][0] : undefined));
                out.push({
                    index: s.index, output: { name: `setting_${s.index}` },
                    node: { id: "provider", title: s.label || s.key, type: r.provider },
                    inputName: s.key, spec, widget: value !== undefined ? { value } : null,
                });
            }
            return out;
        }
        if (!r.prompt) return [];
        for (const s of r.settings || []) {
            const node = r.prompt[s.node];
            if (!node) continue;
            const info = this.objectInfo && this.objectInfo[node.class_type];
            const inp = info && info.input;
            const spec = inp && ((inp.required && inp.required[s.input]) || (inp.optional && inp.optional[s.input])) || s.spec || null;
            const current = node.inputs ? node.inputs[s.input] : undefined;
            const value = s.default !== undefined ? s.default : (Array.isArray(current) ? undefined : current);
            out.push({
                index: s.index, output: { name: `setting_${s.index}` },
                node: { id: s.node, title: s.label || s.input, type: node.class_type },
                inputName: s.input, spec, widget: value !== undefined ? { value } : null,
            });
        }
        return out;
    },

    resultInputState(editor) {
        const r = this.recipe;
        if (!r) return { name: "result_local", wired: false, fallback: false };
        if (r.kind === "provider") return { name: "result", wired: true, fallback: editor.genSettings.mode === "local" };
        const want = editor.genSettings.mode === "local" ? "result_local" : "result";
        const has = r.mode === "api" ? "result" : "result_local";
        return { name: has, wired: !!r.result, fallback: want !== has };
    },

    widgetValue(editor, name, fallback) {
        const v = this.nodeParams[name];
        return v == null ? fallback : +v;
    },

    /** The provider recipe's parameter values from the editor's Settings panel plus the recipe's fixed ones. */
    providerParams(editor, overrides) {
        const r = this.recipe;
        const params = {};
        for (const s of (r && r.settings) || []) {
            const entry = editor.settings[String(s.index)];
            if (entry && entry.value != null && entry.value !== "") params[s.key] = entry.value;
        }
        for (const [k, v] of Object.entries((r && r.fixed) || {})) params[k] = v;
        for (const [k, v] of Object.entries(overrides || {})) if (v != null && v !== "") params[k] = v;
        return params;
    },

    /**
     * Whether the chosen provider variant takes a `background` parameter, which is what an
     * OpenAI image model answers a transparent cut-out to. The recipe says so by carrying a
     * setting with that key (docs/RECIPES.md, "Transparent results").
     */
    supportsTransparency(use = "edit") {
        const r = this.recipe;
        if (!r || r.kind !== "provider") return false;
        const rows = use === "text" ? ((r.text && r.text.settings) || r.settings || []) : (r.settings || []);
        return rows.some((s) => s.key === "background");
    },

    /** True when this run asked the model for a transparent background. */
    wantsTransparent(params) {
        return String((params || {}).background || "").toLowerCase() === "transparent";
    },

    /**
     * A run through an API provider: crop in the app (stitch.js), one request to the
     * main process (electron/main/providers), the answer stitched back into an RGBA
     * patch that is stored in the file mirror as a result and added like a result from
     * the node. No ComfyUI involved.
     */
    async runProvider(editor, opts = {}) {
        const r = this.recipe;
        if (!editor.base) throw new Error("Load an image first.");
        const label = r.providerLabel || r.provider;
        if (r.edit === false) throw new Error(`${r.name || r.id} on ${label} makes images from the prompt alone: use "Generate new", not Generate.`);
        const token = { provider: r.provider, label, started: Date.now(), editor };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();
        let res, info, sel, x, y, w, h, params = {};
        try {
            const prep = prepareCrop(editor, this.nodeParams, this.cropLimits());
            const { crop, mask, maskAlpha, references } = prep;
            info = prep.info; sel = prep.sel;
            [x, y, w, h] = info.bbox;
            params = this.providerParams(editor, opts.background ? { background: opts.background } : null);
            info.keepAlpha = this.wantsTransparent(params);
        editor.setStatus(`Sending crop ${w} × ${h} at ${x}, ${y} (${info.emitted[0]} × ${info.emitted[1]}${references.length ? `, ${references.length} reference${references.length > 1 ? "s" : ""}` : ""}) to ${label}${info.keepAlpha ? ", transparent background" : ""} ...`);
            const [image, maskBytes, maskAlphaBytes, ...refBytes] = await Promise.all([canvasBytes(crop), canvasBytes(mask), canvasBytes(maskAlpha), ...references.map((c) => canvasBytes(c))]);
            const request = {
                provider: r.provider, model: r.model, kind: r.input === "edit" ? "edit" : "fill", fields: r.fields || null, options: r.options || null,
                prompt: editor.promptText || "", negative: editor.negativeText || "", seed: editor.genSettings.seed,
                image, mask: maskBytes, maskAlpha: maskAlphaBytes, width: crop.width, height: crop.height, references: refBytes,
                params,
            };
            res = await window.scumble.providers.edit(request);
        } finally {
            if (editor.providerPending === token) editor.providerPending = null;
            this._providerRuns.delete(token);
            this.notifyProviderRuns();
        }
        const img = await bytesToImage(res.bytes, res.mime);
        const { patch, align } = finishResult(editor, info, sel, img);
        const blob = await new Promise((resolve) => patch.toBlob(resolve, "image/png"));
        const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
        const ref = await this.uploadResult(blob, `n${editor.node.id}_result_${stamp}.png`);
        editor.setStatus(`${label} answered after ${Math.round(res.seconds)} s${res.info && res.info.width ? ` (${res.info.width} × ${res.info.height})` : ""}.`);
        const cutout = info.keepAlpha ? transparentPixels(patch) : false;
        await editor.addResults([{ filename: ref.filename, subfolder: ref.subfolder, type: ref.type, x, y, width: w, height: h, align, canvas_node: editor.node.id, provider: r.provider }]);
        // addResults writes its own line, so the cut-out note goes on afterwards
        if (info.keepAlpha) editor.setStatus(`${editor.status} ${cutout ? "The layer is a cut-out on a transparent ground." : "The model returned no transparency, so the layer is opaque."}`);
        return { provider: r.provider, seconds: res.seconds, x, y, w, h, transparent: !!info.keepAlpha, cutout };
    },

    /**
     * "Generate new": one call to the provider with the prompt alone, no crop, no mask and
     * no references, and the answer becomes the document's base image. The recipe variant's
     * `text` shape says which model id does that at this provider (docs/RECIPES.md).
     */
    async runGenerate(editor, opts = {}) {
        const r = this.recipe;
        if (!r || r.kind !== "provider") throw new Error("Pick an API recipe first.");
        const t = r.text;
        if (!t || !t.model) throw new Error(`${r.providerLabel || r.provider} cannot make an image from the prompt alone for this model.`);
        const label = r.providerLabel || r.provider;
        const width = Math.max(64, Math.round(opts.width || editor.width || 1024));
        const height = Math.max(64, Math.round(opts.height || editor.height || 1024));
        const token = { provider: r.provider, label, started: Date.now(), editor };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();
        const genParams = { ...this.providerParams(editor, opts.background ? { background: opts.background } : null), ...(t.fixed || {}) };
        const cutout = this.wantsTransparent(genParams);
        let res;
        try {
            editor.setStatus(`Asking ${label} for a new ${width} × ${height} image${cutout ? " on a transparent ground" : ""} ...`);
            const request = {
                provider: r.provider, model: t.model, kind: "text",
                prompt: String(opts.prompt != null ? opts.prompt : editor.promptText || ""),
                negative: String(opts.negative != null ? opts.negative : editor.negativeText || ""),
                seed: opts.seed != null ? opts.seed : editor.genSettings.seed,
                width, height, aspect: opts.aspect || null,
                image: null, mask: null, maskAlpha: null, references: [],
                fields: r.fields || null, options: r.options || null,
                params: genParams,
            };
            res = await window.scumble.providers.edit(request);
        } finally {
            if (editor.providerPending === token) editor.providerPending = null;
            this._providerRuns.delete(token);
            this.notifyProviderRuns();
        }
        const img = await bytesToImage(res.bytes, res.mime);
        const c = document.createElement("canvas");
        c.width = img.naturalWidth || img.width;
        c.height = img.naturalHeight || img.height;
        c.getContext("2d").drawImage(img, 0, 0);
        await editor.setBaseFromCanvas(c);
        const gotAlpha = cutout && transparentPixels(c);
        editor.setStatus(`${label} answered after ${Math.round(res.seconds)} s: a new ${c.width} × ${c.height} base image${cutout ? (gotAlpha ? " with a transparent background" : " (the model returned no transparency)") : ""}.`);
        return { provider: r.provider, model: t.model, seconds: res.seconds, width: c.width, height: c.height, transparent: !!gotAlpha };
    },

    // ---- prompt instruction templates (electron/main/prompts.js) -------------------

    promptTemplates: [],          // [{ id, name, description, use, for, body, source }]
    promptTemplateIds: { upsample: "", generate: "" },   // "" = the built-in rule

    async refreshPromptTemplates() {
        try { this.promptTemplates = await window.scumble.prompts.list(); }
        catch (err) { console.warn("prompt templates", err); this.promptTemplates = []; }
        return this.promptTemplates;
    },

    /** The templates that apply to a use ("upsample" / "generate") and the current recipe. */
    promptTemplatesFor(use) {
        const r = this.recipe || {};
        const hay = `${r.id || ""} ${r.name || ""} ${r.family || ""} ${r.model || ""}`.toLowerCase();
        return this.promptTemplates.filter((t) => !t.error && (t.use === "both" || t.use === use) && (!t.for.length || t.for.some((f) => hay.includes(f))));
    },

    /** Fill the placeholders; the output rule is the app's, never the template's. */
    fillPromptTemplate(tpl, ctx) {
        const values = {
            prompt: ctx.prompt || "", model: (this.recipe && (this.recipe.model || this.recipe.name)) || "",
            aspect: ctx.aspect || "", width: ctx.width || "", height: ctx.height || "",
            usecase: ctx.useCase || "", useCase: ctx.useCase || "", region: ctx.region || "the whole image",
            hint: ctx.hint ? ` It currently shows: ${ctx.hint}.` : "",
        };
        const body = String(tpl.body || "").replace(/\{(\w+)\}/g, (all, k) => (values[k] !== undefined ? String(values[k]) : all));
        return `${body}\n\nOutput only the prompt text: no preamble, no quotes, no headings, no explanation.`;
    },

    /** Called by the editor instead of its built-in rule when a template is chosen. */
    upsampleInstruction(ctx) {
        const id = this.promptTemplateIds.upsample;
        if (!id) return null;
        const tpl = this.promptTemplates.find((t) => t.id === id);
        if (!tpl || tpl.error) return null;
        return this.fillPromptTemplate(tpl, ctx);
    },

    /** Whether the editor should show the "Generate new" button at all. */
    generateNewAvailable() {
        return !!(this.shell && this.shell.openGenerateNew);
    },

    openGenerateNew(editor) {
        if (this.shell && this.shell.openGenerateNew) this.shell.openGenerateNew(editor);
    },

    /** Store a result patch in the mirror's output folder (where the node's stitch writes its results). */
    async uploadResult(blob, filename) {
        const form = new FormData();
        form.append("image", new File([blob], filename, { type: "image/png" }));
        form.append("subfolder", SUBFOLDER);
        form.append("type", "output");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
        if (resp.status !== 200) throw new Error("storing the result failed (" + resp.status + ")");
        const data = await resp.json();
        return { filename: data.name, subfolder: data.subfolder || SUBFOLDER, type: data.type || "output" };
    },

    _providerRuns: new Set(),
    onProviderRuns: null,   // set by the shell: (runs: [{provider, label, started, editor}]) => void

    notifyProviderRuns() {
        if (this.onProviderRuns) { try { this.onProviderRuns(Array.from(this._providerRuns)); } catch (err) { console.warn(err); } }
    },

    /** Fill the recipe with the editor state and queue it. Called by editor.generate(). */
    async queueGenerate(editor) {
        const r = this.recipe;
        if (!r) throw new Error("No recipe selected.");
        if (r.kind === "provider") return this.runProvider(editor);
        if (!r.prompt) throw new Error("No recipe selected.");
        if (!this.connected) throw new Error("Not connected to ComfyUI.");
        const missing = (r.needs || []).filter((n) => this.objectInfo && !this.objectInfo[n]);
        if (missing.length) throw new Error("The server lacks these node types: " + missing.join(", "));
        const state = await editor.serializeForPrompt();
        await this.ensureOnServer(state, editor);
        const prompt = JSON.parse(JSON.stringify(r.prompt));
        const canvas = prompt[r.canvas];
        if (!canvas) throw new Error(`Recipe "${r.id}" has no canvas node "${r.canvas}".`);
        canvas.inputs = { ...(canvas.inputs || {}), ...this.nodeParams, canvas_state: state };
        delete canvas.inputs.result; delete canvas.inputs.result_local;
        delete canvas.inputs.result_source; delete canvas.inputs.result_source_local;
        canvas.inputs[r.mode === "api" ? "result_source" : "result_source_local"] = r.result;
        for (const s of r.settings || []) {
            const entry = editor.settings[String(s.index)];
            const node = prompt[s.node];
            if (entry && entry.value != null && node && node.inputs) node.inputs[s.input] = entry.value;
        }
        const res = await api.queuePrompt(0, { output: prompt, workflow: this.workflowForPng(editor) });
        editor.lastPromptId = res && res.prompt_id;
        return res;
    },

    /** The file refs a canvas_state JSON makes the node read: base, mask, control, references. */
    stateRefs(stateJson) {
        let s = null;
        try { s = typeof stateJson === "string" ? JSON.parse(stateJson) : stateJson; } catch (_) { return []; }
        if (!s) return [];
        const refs = [];
        const add = (ref) => { if (ref && typeof ref.filename === "string") refs.push({ filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input" }); };
        add(s.base); add(s.mask); add(s.control);
        for (const ref of s.references || []) add(ref);
        return refs;
    },

    /**
     * Files live in the local mirror (electron/main/files.js); the server only has copies.
     * Before a run, upload those it lacks (a fresh server, a restarted RunPod, a cleanup).
     */
    async ensureOnServer(stateJson, editor) {
        const refs = this.stateRefs(stateJson);
        if (!refs.length) return null;
        const report = await window.scumble.comfy.ensure(refs);
        if (report && report.uploaded.length && editor) editor.setStatus(`Uploaded ${report.uploaded.length} file${report.uploaded.length > 1 ? "s" : ""} to the server. Waiting for the result ...`);
        if (report && report.missing.length) throw new Error("These files are neither on the server nor in the local store: " + report.missing.join(", "));
        return report;
    },

    /** What goes into the PNG's tEXt chunk in place of the litegraph workflow. */
    workflowForPng(editor) {
        const r = this.recipe;
        return { app: "scumble", recipe: r ? r.id : null, kind: r ? r.kind || "comfy" : null, provider: (r && r.provider) || null, model: (r && r.model) || null, prompt: r ? r.prompt || null : null, nodeParams: this.nodeParams };
    },

    /**
     * The InpaintCanvas node's own widgets, which the litegraph node showed under the
     * editor button: crop padding, target size, feather, multiple_of. Built into the
     * editor's Generate section (patched in by tools/sync_editor.py), stored in
     * settings.nodeParams and filled into the recipe's canvas node on every run.
     */
    buildGenerateExtras(editor, sec) {
        const grid = document.createElement("div");
        grid.className = "ipc-row4 scumble-node-params";
        const fields = [
            ["padding", "Padding", 0, 4096, 8, "Pixels of context around the selection that go into the crop (ignored when Crop is set to auto context)"],
            ["target_size", "Target", 0, 8192, 8, "Long side of the crop sent to the model; 0 keeps the crop at its own size"],
            ["feather", "Feather", 0, 512, 1, "Edge feather in pixels when the result is stitched back (used when the crop's edge setting is not auto)"],
            ["multiple_of", "Multiple", 1, 256, 1, "Crop width and height are rounded to a multiple of this (64 for Flux and SDXL, 16 for SD 1.5)"],
        ];
        const inputs = {};
        for (const [key, label, min, max, step, title] of fields) {
            const lab = document.createElement("span");
            lab.textContent = label; lab.title = title;
            grid.appendChild(lab);
            const input = document.createElement("input");
            input.type = "number"; input.className = "ipc-num"; input.style.width = "64px";
            input.min = min; input.max = max; input.step = step; input.title = title;
            input.value = this.nodeParams[key];
            input.addEventListener("keydown", (e) => e.stopPropagation());
            input.addEventListener("change", () => {
                const v = Math.min(max, Math.max(min, Math.round(+input.value || 0)));
                input.value = v;
                this.setNodeParam(key, v);
            });
            grid.appendChild(input);
            inputs[key] = input;
        }
        sec.appendChild(grid);
        editor._nodeParamInputs = inputs;

        // Highres fix (settings.apiSize): app-only, so it sits under the node params instead
        // of among them
        const row = document.createElement("div");
        row.className = "ipc-seg scumble-api-size";
        const lab = document.createElement("span");
        lab.textContent = "Highres fix";
        lab.title = "How far the crop's resolution is pushed up before it goes to an API provider. A local ComfyUI recipe uses Target instead.";
        row.appendChild(lab);
        const sel = document.createElement("select");
        sel.className = "ipc-sel";
        sel.style.flex = "1"; sel.style.maxWidth = "none"; sel.style.minWidth = "0";
        for (const [id, label, title] of API_SIZES) {
            const opt = document.createElement("option");
            opt.value = id; opt.textContent = label; opt.title = title;
            sel.appendChild(opt);
        }
        sel.value = this.apiSize;
        sel.title = lab.title;
        sel.addEventListener("keydown", (e) => e.stopPropagation());
        sel.addEventListener("change", () => this.setApiSize(sel.value));
        row.appendChild(sel);
        sec.appendChild(row);
        editor._apiSizeSelect = sel;
    },

    /** One value for every open editor: the node params are app settings, not per document. */
    setNodeParam(key, value) {
        this.nodeParams = { ...this.nodeParams, [key]: value };
        window.scumble.settings.set({ nodeParams: this.nodeParams }).catch((err) => console.warn("nodeParams not saved", err));
        for (const ed of this._editors) {
            if (ed._nodeParamInputs && ed._nodeParamInputs[key]) ed._nodeParamInputs[key].value = value;
            ed.renderInfo(); ed.draw();
        }
    },

    async saveExport(blob, name) {
        const data = new Uint8Array(await blob.arrayBuffer());
        return window.scumble.file.save({ name, data, path: this.exportPath || undefined });
    },

    /** An editor changed: autosave every open document (debounced) and refresh the tabs. */
    changed(editor) {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.saveAll(), 1500);
        this.emit("changed", { editor });
    },

    /** The autosave bundle: every open document's state, the active one, the id counter. */
    bundle() {
        const docs = [];
        for (const ed of this._editors) {
            let state = "{}";
            try { state = ed.getValue(); } catch (err) { console.warn("getValue", err); }
            docs.push({ id: ed.node.id, state });
        }
        return { version: 2, active: this.editor ? this.editor.node.id : null, nextId: this.nextId, docs };
    },

    saveAll() {
        clearTimeout(this._saveTimer);
        try { window.scumble.state.save(JSON.stringify(this.bundle())).catch(() => {}); } catch (err) { console.warn("autosave", err); }
        if (this.onDocsChanged) { try { this.onDocsChanged(); } catch (err) { console.warn(err); } }
    },

    /** Every file ref ({filename, subfolder, type}) any open document mentions, as mirror keys. */
    referencedFileKeys() {
        const keys = new Set();
        const walk = (v) => {
            if (!v || typeof v !== "object") return;
            if (Array.isArray(v)) { for (const x of v) walk(x); return; }
            if (typeof v.filename === "string") keys.add(`${v.type || "input"}/${v.subfolder || ""}/${v.filename}`);
            for (const x of Object.values(v)) walk(x);
        };
        for (const ed of this._editors) {
            try { walk(JSON.parse(ed.getValue())); } catch (_) { /* empty document */ }
            if (ed.base && ed.base.ref) walk(ed.base.ref);
        }
        return Array.from(keys);
    },

    // ---- in-app helpers: SAM2 objects and background removal through ONNX Runtime -----------
    //
    // The main process (electron/main/onnx) holds the models; the renderer scales the
    // source to the model's 1024 × 1024 input with Canvas 2D and scales the answer back.
    // The editor asks through objectBackendAvailable() / ensureObjects() and
    // availableCutoutBackends() / cutoutLayer() (patched in tools/sync_editor.py); when
    // no in-app model is present, the ComfyUI helper prompts run as in the node.

    helpers: { models: [], sam2: null, matting: null, runtime: null },
    onHelpersChanged: null,   // set by the shell: (status) => void

    /** Ask the main process what is downloaded and refresh the editors' model lists. */
    async refreshHelpers() {
        try { this.helpers = await window.scumble.helpers.status(); } catch (err) { console.warn("helpers status", err); this.helpers = { models: [] }; }
        for (const ed of this._editors) { try { ed.refreshCutoutBackends(); } catch (_) { /* not built yet */ } }
        if (this.onHelpersChanged) { try { this.onHelpersChanged(this.helpers); } catch (err) { console.warn(err); } }
        return this.helpers;
    },

    // ---- language models on the provider keys (electron/main/llm.js) ----------------

    llms: [],   // [{ id, provider, model, label, key }] from the main process

    /** Which API language models have a key, then refresh the editors' upsample lists. */
    async refreshLLMs() {
        try { this.llms = await window.scumble.llm.list(); } catch (err) { console.warn("llm list", err); this.llms = []; }
        for (const ed of this._editors) { try { ed.refreshSegmentBackends(); } catch (_) { /* not built yet */ } }
        return this.llms;
    },

    /** Upsample backends in the shape of the editor's UPSAMPLE_BACKENDS entries (id "app:<provider>:<model>"). */
    upsampleBackends() {
        return this.llms.filter((l) => l.key).map((l) => ({ id: "app:" + l.id, label: l.label, inApp: true, llm: l.id, needs: [] }));
    },

    /** One question to an API language model with a canvas in view; { text, seconds }. */
    async askLLM(backend, instruction, canvas) {
        let image = null;
        if (canvas) {
            const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
            image = new Uint8Array(await blob.arrayBuffer());
        }
        try {
            return await window.scumble.llm.ask({ id: backend.llm, instruction, image });
        } catch (err) {
            // strip Electron's "Error invoking remote method 'llm:ask': Error: " wrapper
            throw new Error(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
        }
    },

    /**
     * Prompt upsampling through an API language model. Called by the editor's
     * upsamplePrompt() with upsamplePending set; hands the text to applyTextResult like
     * the ComfyUI path does through the InpaintCanvasTextOut event. Throws on failure
     * (the editor's catch resets the pending state).
     */
    async upsampleInApp(editor, backend, instruction) {
        const res = await this.askLLM(backend, instruction, editor.promptContextCanvas());
        if (!editor.upsamplePending) return;   // cancelled meanwhile
        editor.applyTextResult({ text: res.text });
        const note = res.note ? `, ${res.note}` : "";   // "text only": the model refused the crop and answered on the words alone
        editor.setStatus(editor.status.replace(/\.$/, "") + ` (${backend.label.replace(/ \(.*\)$/, "")}, ${res.seconds.toFixed(1)} s${note}).`);
    },

    presentHelpers(kind) {
        return (this.helpers.models || []).filter((m) => m.kind === kind && m.present);
    },

    /** The SAM2 model the object tool uses: the chosen one when present, else the first present. */
    sam2Model() {
        const all = this.presentHelpers("sam2");
        return all.find((m) => m.id === this.helpers.sam2) || all[0] || null;
    },

    objectsInApp() {
        return !!this.sam2Model();
    },

    /** Cutout backends in the shape of the editor's CUTOUT_BACKENDS entries (id "app:<model>"). */
    cutoutBackends() {
        return this.presentHelpers("matting").map((m) => ({ id: "app:" + m.id, label: `${m.label} (in-app)`, inApp: true, model: m.id, needs: [] }));
    },

    /** What a helper looks at, as a canvas: the flattened image, or one layer on neutral grey. */
    sourceCanvas(editor, layer) {
        if (!layer) return editor.flattenToCanvas({ forRun: true });
        const c = document.createElement("canvas");
        c.width = editor.width; c.height = editor.height;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#808080";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(editor.layerPixels(layer), layer.x, layer.y, layer.w, layer.h);
        return c;
    },

    /** RGBA bytes of a source drawn (squashed) into size × size, on `background` where it is transparent. */
    modelInput(source, size, background) {
        const c = document.createElement("canvas");
        c.width = size; c.height = size;
        const ctx = c.getContext("2d");
        if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, size, size); }
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        ctx.drawImage(source, 0, 0, size, size);
        return new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer);
    },

    /**
     * The object map for the hover tool from SAM2 in-app. Called by the editor's
     * ensureObjects() with the source hash and layer; fills editor.objects through
     * applySegmentIds like the ComfyUI path does through applySegmentsFile.
     */
    async findObjects(editor, pending) {
        const model = this.sam2Model();
        if (!model) { editor.objectsPending = null; editor.setStatus("No SAM2 model is downloaded (Settings › Helpers)."); return; }
        editor.objectsPending = { stage: "run", ...pending };
        try {
            const src = this.sourceCanvas(editor, pending.layer);
            editor.setStatus(`Finding objects with ${model.label} (in-app) ...`);
            const image = this.modelInput(src, 1024, null);
            const W = editor.width, H = editor.height;
            const s = Math.min(1, 2048 / Math.max(W, H));
            const outW = Math.max(1, Math.round(W * s)), outH = Math.max(1, Math.round(H * s));
            editor.helperUsed = true;   // the ONNX sessions hold VRAM; freed before a local run like the ComfyUI helpers
            const res = await window.scumble.helpers.objects({ model: model.id, key: `${editor.node.id}:${pending.hash}`, image, outWidth: outW, outHeight: outH });
            if (editor.objectsPending && editor.objectsPending.hash !== pending.hash) return;   // a newer request took over
            let ids;
            if (res.width === W && res.height === H) {
                ids = new Uint16Array(res.ids.buffer, res.ids.byteOffset, W * H);
            } else {
                ids = new Uint16Array(W * H);
                const sx = res.width / W, sy = res.height / H;
                for (let y = 0; y < H; y++) {
                    const row = Math.min(res.height - 1, Math.floor((y + 0.5) * sy)) * res.width, o = y * W;
                    for (let x = 0; x < W; x++) ids[o + x] = res.ids[row + Math.min(res.width - 1, Math.floor((x + 0.5) * sx))];
                }
            }
            editor.objectsPending = null;
            editor.applySegmentIds(ids, W, H, res.count, pending);
            editor.setStatus(`${res.count} objects found with ${model.label} in ${res.seconds.toFixed(1)} s (${res.provider}). Hover to preview, click to select, click again to deselect (Shift adds, Alt subtracts).${this.slowHelperHint(res)}`);
        } catch (err) {
            console.error(err);
            editor.objectsPending = null;
            editor.setStatus("Object detection failed: " + (err.message || err));
        }
    },

    /**
     * Background removal of one layer in-app. Called by the editor's cutoutLayer() with
     * cutoutPending already set; returns a grayscale canvas (white = keep) at the model
     * size that applyCutoutImage scales onto the layer.
     */
    async cutoutInApp(editor, layer, backend) {
        const model = (this.helpers.models || []).find((m) => m.id === backend.model);
        if (!model || !model.present) throw new Error(`${backend.label} is not downloaded any more (Settings › Helpers).`);
        // like the ComfyUI path: the layer's own pixels, transparent parts on black
        const image = this.modelInput(layer.canvas, 1024, "#000000");
        editor.helperUsed = true;
        const res = await window.scumble.helpers.cutout({ model: model.id, image });
        const c = document.createElement("canvas");
        c.width = res.size; c.height = res.size;
        const ctx = c.getContext("2d");
        const out = ctx.createImageData(res.size, res.size);
        const d = out.data;
        for (let i = 0, j = 0; i < res.alpha.length; i++, j += 4) { const a = res.alpha[i]; d[j] = a; d[j + 1] = a; d[j + 2] = a; d[j + 3] = 255; }
        ctx.putImageData(out, 0, 0);
        editor.setStatus(`${layer.name}: background removed with ${model.label} in ${res.seconds.toFixed(1)} s (${res.provider}).`);
        const hint = this.slowHelperHint(res);
        if (hint) setTimeout(() => editor.setStatus(editor.status + hint), 50);   // after applyCutoutImage's own status line
        return c;
    },

    /**
     * One SAM2 point prompt on the current object-tool source (its embedding is cached in
     * the main process by the hash ensureObjects used): a Uint8 mask at image size.
     */
    async segmentPoint(editor, points, box) {
        const model = this.sam2Model();
        if (!model || !editor.objects) throw new Error("run the object tool first");
        const W = editor.width, H = editor.height;
        const s = Math.min(1, 2048 / Math.max(W, H));
        const outW = Math.max(1, Math.round(W * s)), outH = Math.max(1, Math.round(H * s));
        const pts = points.map((p) => ({ x: p.x / W * 1024, y: p.y / H * 1024, label: p.label }));
        const bx = box ? [box[0] / W * 1024, box[1] / H * 1024, box[2] / W * 1024, box[3] / H * 1024] : null;
        const key = `${editor.node.id}:${editor.objects.hash}`;
        let res;
        try {
            res = await window.scumble.helpers.segment({ model: model.id, key, points: pts, box: bx, outWidth: outW, outHeight: outH });
        } catch (err) {
            // embedding gone (freed, restarted): encode again from the same source
            const layer = editor.objects.layerId != null ? editor.layers.find((l) => l.id === editor.objects.layerId) : null;
            const image = this.modelInput(this.sourceCanvas(editor, layer), 1024, null);
            res = await window.scumble.helpers.segment({ model: model.id, key, image, points: pts, box: bx, outWidth: outW, outHeight: outH });
        }
        if (res.width === W && res.height === H) return { mask: res.mask, score: res.score };
        const mask = new Uint8Array(W * H);
        const sx = res.width / W, sy = res.height / H;
        for (let y = 0; y < H; y++) {
            const row = Math.min(res.height - 1, Math.floor((y + 0.5) * sy)) * res.width, o = y * W;
            for (let x = 0; x < W; x++) mask[o + x] = res.mask[row + Math.min(res.width - 1, Math.floor((x + 0.5) * sx))];
        }
        return { mask, score: res.score };
    },

    /**
     * Object tool, click where the object map has nothing: segment with one SAM2 point
     * prompt and toggle that mask in the selection (Shift adds, Alt subtracts, otherwise
     * a click on a selected pixel subtracts). Called by the editor's toggleObjectAt().
     */
    async selectPoint(editor, ix, iy, p = {}) {
        if (editor.objectsPending || editor._pointPending) return;
        editor._pointPending = true;
        try {
            editor.setStatus("Segmenting what is under the cursor with SAM2 ...");
            const { mask, score } = await this.segmentPoint(editor, [{ x: ix, y: iy, label: 1 }], null);
            const W = editor.width, H = editor.height;
            const layer = editor.objects && editor.objects.layerId != null ? editor.layers.find((l) => l.id === editor.objects.layerId) : null;
            const clip = layer ? editor.layerAlpha(layer) : null;
            let count = 0;
            for (let i = 0; i < mask.length; i++) { if (clip && !clip[i]) mask[i] = 0; count += mask[i]; }
            if (!count) { editor.setStatus("SAM2 found nothing at this spot. Use the brush or lasso here."); return; }
            const x = Math.floor(ix), y = Math.floor(iy);
            const already = editor.selection.getContext("2d").getImageData(x, y, 1, 1).data[3] > 0;
            const subtract = p.alt ? true : (p.shift ? false : already);
            editor.pushUndo({ kind: "selection" });
            const shape = document.createElement("canvas");
            shape.width = W; shape.height = H;
            const sctx = shape.getContext("2d");
            const im = sctx.createImageData(W, H);
            const d = im.data;
            for (let i = 0, j = 0; i < mask.length; i++, j += 4) if (mask[i]) { d[j] = 255; d[j + 3] = 255; }
            sctx.putImageData(im, 0, 0);
            const ctx = editor.selection.getContext("2d");
            ctx.globalCompositeOperation = subtract ? "destination-out" : "source-over";
            ctx.drawImage(shape, 0, 0);
            ctx.globalCompositeOperation = "source-over";
            editor.markSelectionChanged();
            editor.draw();
            editor.setStatus(`${subtract ? "Removed" : "Added"} what SAM2 sees at this point (${Math.round(100 * count / (W * H))}% of the image, score ${score.toFixed(2)}).`);
        } catch (err) {
            console.error(err);
            editor.setStatus("Point segmentation failed: " + (err.message || err));
        } finally {
            editor._pointPending = false;
        }
    },

    /**
     * A GPU run that took far longer than it should: the card is most likely full with
     * ComfyUI's models (measured: 125 s instead of 1.6 s with 29 of 32 GB in use), and
     * DirectML pages through system memory. Say what helps.
     */
    slowHelperHint(res) {
        if (!res || res.seconds < 15 || res.provider === "cpu") return "";
        return this.connected
            ? " Slow: the GPU memory is probably full with ComfyUI's models; Free VRAM (also unloads them on the server) or set the helper device to CPU in Settings."
            : " Slow: the GPU memory is probably full; close what else uses it, or set the helper device to CPU in Settings.";
    },

    /** Release the in-app models (VRAM); the editor's "Free VRAM" button and the pre-run free call this. */
    async freeHelpers() {
        return window.scumble.helpers.free();
    },
};

// ---- server events ------------------------------------------------------------------------

window.scumble.comfy.onEvent((ev) => api.dispatch(ev.type, ev.data));

api.addEventListener("executed", ({ detail }) => {
    const out = detail && detail.output;
    if (!out) return;
    // Results: the recipe's canvas node id is the same for every tab, so the prompt id
    // decides; helper outputs carry the editor id the helper prompt was queued with.
    if (out.inpaint_result) {
        const ed = host.editorByPrompt(detail.prompt_id) || host.editor;
        if (ed) ed.addResults(out.inpaint_result);
    }
    const forNode = (info) => host.editorById(info && info.canvas_node) || host.editorByPrompt(detail.prompt_id) || host.editor;
    if (out.inpaint_text) for (const info of out.inpaint_text) { const ed = forNode(info); if (ed) ed.applyTextResult(info); }
    for (const info of out.inpaint_mask || []) {
        const ed = forNode(info);
        if (!ed) continue;
        if (info.purpose === "segments") ed.applySegmentsFile(info);
        else if (info.purpose === "cutout") ed.applyCutoutFile(info);
        else ed.applyMaskFile(info);
    }
});

api.addEventListener("execution_error", ({ detail }) => {
    if (!detail) return;
    const ed = host.editorByPrompt(detail.prompt_id) || host.editor;
    if (!ed) return;
    const msg = detail.exception_message || "execution failed";
    if (ed.segmentPromptId && detail.prompt_id === ed.segmentPromptId) {
        ed.segmentPending = null; if (ed.segBtn) ed.segBtn.disabled = false;
        ed.setStatus("Segmentation failed: " + msg);
    } else if (ed.objectsPromptId && detail.prompt_id === ed.objectsPromptId) {
        ed.objectsPending = null;
        ed.setStatus("Object detection failed: " + msg);
    } else if (ed.upsamplePromptId && detail.prompt_id === ed.upsamplePromptId) {
        ed.upsamplePending = null; if (ed.upBtn) ed.upBtn.disabled = false;
        ed.setStatus("Upsampling failed: " + msg);
    } else if (ed.cutoutPromptId && detail.prompt_id === ed.cutoutPromptId) {
        ed.cutoutPending = null; ed.renderLayers();
        ed.setStatus("Background removal failed: " + msg);
    } else {
        ed.setStatus("Error in " + (detail.node_type || detail.node_id || "the graph") + ": " + msg);
    }
});
