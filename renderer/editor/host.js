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

const PROXY = "/comfy";

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
    },

    /** Show this editor, hide the others; only the active editor gets keyboard shortcuts. */
    activate(editor) {
        if (!editor || !this._editors.includes(editor)) return;
        this.editor = editor;
        for (const e of this._editors) e.root.classList.toggle("shell-hidden", e !== editor);
        try { editor.resizeCanvas(); editor.draw(); } catch (_) { /* not open yet */ }
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
        const mode = r.mode === "api" ? "api" : "local";
        if (ed.genSettings.mode !== mode) { ed.genSettings.mode = mode; ed.syncGenControls(); }
        ed.settingsChanged();
        ed.renderInfo();
    },

    /** The recipe's editable inputs in the shape settingTargets() had in the node. */
    settingTargets(editor) {
        const r = this.recipe;
        if (!r || !r.prompt) return [];
        const out = [];
        for (const s of r.settings || []) {
            const node = r.prompt[s.node];
            if (!node) continue;
            const info = this.objectInfo && this.objectInfo[node.class_type];
            const inp = info && info.input;
            const spec = inp && ((inp.required && inp.required[s.input]) || (inp.optional && inp.optional[s.input])) || null;
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
        const want = editor.genSettings.mode === "local" ? "result_local" : "result";
        const has = r.mode === "api" ? "result" : "result_local";
        return { name: has, wired: !!r.result, fallback: want !== has };
    },

    widgetValue(editor, name, fallback) {
        const v = this.nodeParams[name];
        return v == null ? fallback : +v;
    },

    /** Fill the recipe with the editor state and queue it. Called by editor.generate(). */
    async queueGenerate(editor) {
        const r = this.recipe;
        if (!r || !r.prompt) throw new Error("No recipe selected.");
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
        return { app: "scumble", recipe: this.recipe ? this.recipe.id : null, prompt: this.recipe ? this.recipe.prompt : null, nodeParams: this.nodeParams };
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
        return window.scumble.file.save({ name, data });
    },

    /** An editor changed: autosave every open document (debounced) and refresh the tabs. */
    changed(editor) {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.saveAll(), 1500);
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
