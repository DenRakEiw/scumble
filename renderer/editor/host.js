// What the editor needs from its surroundings. In the ComfyUI node this was `app`, `api`
// and the litegraph node; here it is one object backed by the main process (see
// tools/sync_editor.py for the exact places in inpaint_canvas.js that call into it).
//
//   api   - ComfyUI's client API surface the editor uses: fetchApi, apiURL, queuePrompt,
//           addEventListener, clientId. Requests go to scumble://app/comfy/*, which the main
//           process proxies to the server, so images and uploads stay same-origin.
//   host  - the document-level services: recipe, settings targets, generate, autosave.

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
    editor: null,
    mountEl: null,
    recipe: null,
    objectInfo: null,
    nodeParams: { padding: 64, target_size: 1024, feather: 16, multiple_of: 64 },
    connected: false,
    _pendingState: null,
    _saveTimer: null,
    _types: {},

    attach(editor, { mount, nodeParams } = {}) {
        this.editor = editor;
        this.mountEl = mount || document.body;
        if (nodeParams) this.nodeParams = { ...this.nodeParams, ...nodeParams };
    },

    editors() {
        return this.editor ? [this.editor] : [];
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
        const ed = this.editor;
        if (ed) {
            if (!status.node) ed.setStatus("ComfyUI is connected but the Inpaint Canvas node pack is missing: install ComfyUI-InpaintCanvas on that server (ComfyUI Manager or git clone).");
            else if (!ed.base) ed.setStatus(`Connected to ${status.message}. Load an image (Ctrl+O, drop a file, or paste).`);
            ed.refreshSegmentBackends();
            ed.settingsChanged();
        }
        if (this._pendingState) {
            const s = this._pendingState;
            this._pendingState = null;
            try { await ed.setValue(s); ed.setStatus("Last session restored."); } catch (err) { console.warn("restore failed", err); }
        }
    },

    restoreWhenConnected(stateJson) {
        if (this.connected && this.editor) this.editor.setValue(stateJson).catch((err) => console.warn(err));
        else this._pendingState = stateJson;
    },

    // ---- recipe: the graph the editor is wired into ------------------------------------

    setRecipe(recipe) {
        this.recipe = recipe;
        const ed = this.editor;
        if (!ed) return;
        const mode = recipe && recipe.mode === "api" ? "api" : "local";
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

    /** What goes into the PNG's tEXt chunk in place of the litegraph workflow. */
    workflowForPng(editor) {
        return { app: "scumble", recipe: this.recipe ? this.recipe.id : null, prompt: this.recipe ? this.recipe.prompt : null, nodeParams: this.nodeParams };
    },

    async saveExport(blob, name) {
        const data = new Uint8Array(await blob.arrayBuffer());
        return window.scumble.file.save({ name, data });
    },

    /** The editor changed: autosave its state (debounced). */
    changed(editor) {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            try {
                const v = editor.getValue();
                if (v && v !== "{}") window.scumble.state.save(v).catch(() => {});
            } catch (err) { console.warn("autosave", err); }
        }, 1500);
    },
};

// ---- server events ------------------------------------------------------------------------

window.scumble.comfy.onEvent((ev) => api.dispatch(ev.type, ev.data));

api.addEventListener("executed", ({ detail }) => {
    const ed = host.editor;
    const out = detail && detail.output;
    if (!ed || !out) return;
    if (out.inpaint_result) ed.addResults(out.inpaint_result);
    if (out.inpaint_text) for (const info of out.inpaint_text) ed.applyTextResult(info);
    for (const info of out.inpaint_mask || []) {
        if (info.purpose === "segments") ed.applySegmentsFile(info);
        else if (info.purpose === "cutout") ed.applyCutoutFile(info);
        else ed.applyMaskFile(info);
    }
});

api.addEventListener("execution_error", ({ detail }) => {
    const ed = host.editor;
    if (!ed || !detail) return;
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
