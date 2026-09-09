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

import { prepareCrop, finishResult, canvasBytes, bytesToImage } from "./stitch.js";

const PROXY = "/comfy";
const SUBFOLDER = "inpaint_canvas";

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
    connected: false,
    _pendingStates: [],
    _saveTimer: null,
    _types: {},

    /** Shell setup: where editors mount and the persisted node params. */
    configure({ mount, nodeParams } = {}) {
        this.mountEl = mount || document.body;
        if (nodeParams) this.nodeParams = { ...this.nodeParams, ...nodeParams };
    },

    /** Compatibility with the single-editor shell: configure + addEditor + activate. */
    attach(editor, opts = {}) {
        this.configure(opts);
        this.addEditor(editor);
        this.activate(editor);
    },

    addEditor(editor) {
        if (!this._editors.includes(editor)) this._editors.push(editor);
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
        this.emit("built", { editor });
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
    providerParams(editor) {
        const r = this.recipe;
        const params = {};
        for (const s of (r && r.settings) || []) {
            const entry = editor.settings[String(s.index)];
            if (entry && entry.value != null && entry.value !== "") params[s.key] = entry.value;
        }
        for (const [k, v] of Object.entries((r && r.fixed) || {})) params[k] = v;
        return params;
    },

    /**
     * A run through an API provider: crop in the app (stitch.js), one request to the
     * main process (electron/main/providers), the answer stitched back into an RGBA
     * patch that is stored in the file mirror as a result and added like a result from
     * the node. No ComfyUI involved.
     */
    async runProvider(editor) {
        const r = this.recipe;
        if (!editor.base) throw new Error("Load an image first.");
        const label = r.providerLabel || r.provider;
        const token = { provider: r.provider, label, started: Date.now(), editor };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();
        let res, info, sel, x, y, w, h;
        try {
            const prep = prepareCrop(editor, this.nodeParams);
            const { crop, mask, maskAlpha, references } = prep;
            info = prep.info; sel = prep.sel;
            [x, y, w, h] = info.bbox;
        editor.setStatus(`Sending crop ${w} × ${h} at ${x}, ${y} (${info.emitted[0]} × ${info.emitted[1]}${references.length ? `, ${references.length} reference${references.length > 1 ? "s" : ""}` : ""}) to ${label} ...`);
            const [image, maskBytes, maskAlphaBytes, ...refBytes] = await Promise.all([canvasBytes(crop), canvasBytes(mask), canvasBytes(maskAlpha), ...references.map((c) => canvasBytes(c))]);
            const request = {
                provider: r.provider, model: r.model, kind: r.input === "edit" ? "edit" : "fill", fields: r.fields || null, options: r.options || null,
                prompt: editor.promptText || "", negative: editor.negativeText || "", seed: editor.genSettings.seed,
                image, mask: maskBytes, maskAlpha: maskAlphaBytes, width: crop.width, height: crop.height, references: refBytes,
                params: this.providerParams(editor),
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
        await editor.addResults([{ filename: ref.filename, subfolder: ref.subfolder, type: ref.type, x, y, width: w, height: h, align, canvas_node: editor.node.id, provider: r.provider }]);
        return { provider: r.provider, seconds: res.seconds, x, y, w, h };
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
