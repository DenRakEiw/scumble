// @ts-check
// host state fields, configure and its settings, attach, the editor registry, events: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import * as comfyprompt from "./comfyprompt.js";
import * as realism from "./realism.js";
import { planFrame } from "./stitch.js";
import { glReleasePool } from "./inpaint_filters_gl.js";
import { loraPercent } from "./inpaint_relight.js";
import { buildAreaButton } from "./eacharea.js";
import { API_SIZES, CLOSED_MAX, RELIGHT_DEFAULTS, boxesSchema, plainObject, textOptions } from "./host_util.js";

export const HostStatePart = {
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
    embedRecipe: true,     // settings.embedRecipe: exported PNGs carry the prompt, seed and recipe (docs/PLAN_0_1_29.md 3f; on since 0.1.32)
    connected: false,
    // the ComfyUI status as the shell last showed it (setServerStatus): `connected` above is never set back, the
    // Realism Pass's check needs the live state and the server's own system and cards
    server: { state: "disconnected", os: "", gpus: [], remote: false, url: "", version: "" },
    // settings.realism as stored (the renderer's copy, like nodeParams); realismValues() fills it per key
    realismStored: null,
    _pendingStates: [],
    // quit safety (docs/PLAN_0_1_29.md §3): while documents are restored, an autosave would write only those restored so
    // far (a later one not created yet, the one loading with part of its layers) over the whole state. Saves wait.
    _restoring: 0,
    // editor -> the state it waits to be restored from (a document whose files wait for ComfyUI): bundle() saves that
    // instead of the empty editor, until the editor holds a picture of its own
    _rawStates: new Map(),
    _saveTimer: null,
    _types: {},

    /**
     * Shell setup: where editors mount and the persisted node params.
     * @param {{ mount?: HTMLElement, nodeParams?: any, apiSize?: string, embedRecipe?: boolean, llmRefPictures?: boolean, realism?: any, depthDetail?: string, relight?: any }} [opts]
     */
    configure({ mount, nodeParams, apiSize, embedRecipe, llmRefPictures, realism: realismStored, depthDetail, relight } = {}) {
        this.mountEl = mount || document.body;
        if (nodeParams) this.nodeParams = { ...this.nodeParams, ...nodeParams };
        if (API_SIZES.some(([id]) => id === apiSize)) this.apiSize = apiSize;
        if (typeof embedRecipe === "boolean") this.embedRecipe = embedRecipe;
        if (typeof llmRefPictures === "boolean") this.llmRefPictures = llmRefPictures;
        if (realismStored !== undefined) this.realismStored = realismStored;
        if (depthDetail !== undefined) this.depthDetailSetting = depthDetail;
        if (relight !== undefined) {
            const picked = { ...(relight || {}) };
            // a stored 0..1 strength (77da63f's default 1.0) is a fraction of the 0..100 slider
            if (picked.lora_strength != null) picked.lora_strength = loraPercent(picked.lora_strength);
            for (const k of Object.keys(picked)) if (picked[k] === undefined || (picked[k] && typeof picked[k] === "object")) delete picked[k];
            this.relightPicked = picked;
            this.relightSettings = { ...RELIGHT_DEFAULTS, ...picked };
        }
    },

    /** The relight panel's values for a new relight layer: RELIGHT_DEFAULTS under what the user picked. */
    relightSettings: { ...RELIGHT_DEFAULTS },
    /** What the user picked (stored as settings.relight): never the defaults, so a later default reaches every profile. */
    relightPicked: {},

    getRelightSettings() {
        return this.relightSettings || {};
    },

    /** Remember the panel's values; a key set to undefined is forgotten (Light type: From the lights). */
    setRelightSettings(patch) {
        const drop = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };
        this.relightSettings = drop({ ...(this.relightSettings || {}), ...(patch || {}) });
        this.relightPicked = drop({ ...(this.relightPicked || {}), ...(patch || {}) });
        if (typeof window !== "undefined" && window.scumble && window.scumble.settings) {
            window.scumble.settings.set({ relight: this.relightPicked }).catch(() => {});
        }
    },

    depthDetailSetting: "standard",

    getDepthDetail() {
        return this.depthDetailSetting || "standard";
    },

    setDepthDetail(val) {
        this.depthDetailSetting = val || "standard";
        if (typeof window !== "undefined" && window.scumble && window.scumble.settings) {
            window.scumble.settings.set({ depth: { detail: this.depthDetailSetting } }).catch(() => {});
        }
    },

    // ---- the Realism Pass (docs/PLAN_0_1_42.md, renderer/editor/realism.js) ----

    /** The shell's ComfyUI status, every one of them (connected, missing-node, connecting, disconnected, error). */
    setServerStatus(st) {
        if (!st || typeof st !== "object") return;
        this.server = {
            state: String(st.state || "disconnected"),
            os: typeof st.os === "string" ? st.os : (this.server && this.server.os) || "",
            gpus: Array.isArray(st.gpus) ? st.gpus.map(String) : (this.server && this.server.gpus) || [],
            remote: !!st.remote,
            // which server (a picture run ends when another one is connected) and its version (cancelComfyPrompt)
            url: typeof st.url === "string" ? st.url : (this.server && this.server.url) || "",
            version: typeof st.version === "string" ? st.version : (this.server && this.server.version) || "",
        };
        // only when the server is gone: "connecting" (a re-Connect to the same server) is a pause, the jobs go on. A lost
        // socket (a crashed server, the network) ends the bars too: no event would end them, and a run that still goes
        // takes its bar back with its next event after the reconnect (RunProgress.wants)
        if (this.server.state === "disconnected" || this.server.state === "error" || st.socket === false) for (const ed of this._editors) if (ed.runProgress) ed.runProgress.idle(this.liveRunIds());
        // the socket back: what the queue still holds of the dropped prompts shows again (checkTrackedRuns)
        if (st.socket === true && this._socketWas === false) this.checkTrackedRuns();
        if (typeof st.socket === "boolean") this._socketWas = st.socket;
        this.emit("realism");
    },

    /** Whether the connected server can run the pass, and what the user reads when not (realism.serverSupport). */
    realismSupport() {
        const s = this.server || { state: "disconnected", os: "", gpus: [] };
        return realism.serverSupport({ state: s.state, os: s.os, gpus: s.gpus, objectInfo: this.objectInfo });
    },

    /** The Realism Pass recipe (a user copy wins, as for any recipe), or null. */
    realismRecipe() {
        const list = this.shell && this.shell.recipes ? this.shell.recipes() : [];
        return list.find((r) => r.id === realism.RECIPE_ID) || null;
    },

    /** settings.realism, filled per key from the defaults (a stored object from an older build replaces them whole). */
    realismValues() {
        return realism.fillValues(this.realismStored);
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

    /**
     * The crop an API run of the selected recipe would send now (stitch.js planFrame: `{ x, y, w, h, emitted, paste,
     * aspect }` in image pixels), or null without a selection. Cheap enough for an overlay: the Boxes plugin draws it.
     */
    cropFrame(editor) {
        const r = this.recipe;
        // Generate with a provider upscaler sends the crop at its own size (runUpscale plans with mode "crop")
        const limits = r && r.kind === "provider" && r.task === "upscale" && r.limits ? { ...r.limits, mode: "crop" } : this.cropLimits();
        return planFrame(editor, this.nodeParams, limits);
    },

    /**
     * The Boxes switch under the prompt field (item 28 S3d, docs/PLAN_BOXES.md §10): `takes` says a run of the selected
     * recipe sends boxes (the row shows only then), `count` how many boxes the plugins hold for the document (its
     * label), `schema` the format they go in (the variant's `options.boxes`: "flux3", "ideogram4"; a ComfyUI recipe's
     * `boxes.schema`; null when it takes none). The switch itself is the document's `genSettings.boxes`: on, a run sends
     * the boxes, or the selection as one box when there are none; off, none.
     */
    boxSwitch(editor) {
        const schema = boxesSchema(this.recipe);
        return { takes: !!schema, count: editor && this.plugins ? this.plugins.countBoxes(editor) : 0, schema };
    },

    /**
     * Whether Generate new with `recipe` (a resolved recipe; the selected one by default) sends the document's boxes
     * (item 34): `schema` the format its text route takes them in (null: none), `on` the Boxes switch, `count` how many
     * the document holds, `goes` all three. The rule runGenerate follows (textOptions; the references go where the text
     * route takes them), so the Generate new dialog says what the run will do. A ComfyUI recipe that declares where its
     * box rows go (its `boxes`): Generate new is an edit of a fresh white canvas (generate_new's local path), and the
     * document's boxes go with it, scaled to the new canvas (queueGenerate).
     */
    newBoxes(editor, recipe = this.recipe) {
        const r = recipe;
        const local = editor && r && r.kind !== "provider" ? comfyprompt.localBoxSchema(r) : null;
        if (!local && (!editor || !r || r.kind !== "provider" || !r.text)) return { schema: null, on: false, count: 0, goes: false };
        const options = local ? null : textOptions(r, !!(this.refTokens && r.text.refs && editor.refSnapshot().refIds.length));
        const schema = local || (options && typeof options.boxes === "string" ? options.boxes : null);
        const on = !!(editor.genSettings && editor.genSettings.boxes);
        const count = schema && this.plugins ? this.plugins.countBoxes(editor) : 0;
        return { schema, on, count, goes: !!schema && on && count > 0 };
    },

    setApiSize(mode) {
        if (!API_SIZES.some(([id]) => id === mode)) return;
        this.apiSize = mode;
        window.scumble.settings.set({ apiSize: mode }).catch((err) => console.warn("apiSize not saved", err));
        for (const ed of this._editors) { if (ed._apiSizeSelect) ed._apiSizeSelect.value = mode; this.emit("crop", { editor: ed }); }
    },

    /** The Export section's switch: one value for every open editor, kept in the settings. */
    setEmbedRecipe(on) {
        this.embedRecipe = !!on;
        // `embedRecipeChosen`: the value is the user's (electron/main/settings.js drops an unmarked false, the old default)
        window.scumble.settings.set({ embedRecipe: this.embedRecipe, embedRecipeChosen: true }).catch((err) => console.warn("embedRecipe not saved", err));
        for (const ed of this._editors) this.syncExportRow(ed);
    },

    /** Compatibility with the single-editor shell: configure + addEditor + activate. */
    attach(editor, opts = {}) {
        this.configure(opts);
        this.addEditor(editor);
        this.activate(editor);
    },

    addEditor(editor) {
        if (!this._editors.includes(editor)) this._editors.push(editor);
        if (!plainObject(editor.pluginData)) editor.pluginData = {};   // per-document plugin data (renderer/plugins.js)
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
        // its prompts on ComfyUI (a Generate, a helper) land nowhere now, not in the tab in front (the event listeners)
        if (i >= 0) {
            // its runs in the title row stop as their Cancel stops them (review G1.1): main aborts an API run, so a
            // provider that can (Comfy Cloud, Comfy Router) is asked to stop the job, and a picture run on the user's
            // ComfyUI has its job taken off the server; their answers would land in no tab
            this.cancelRuns(editor);
            const ids = [...(editor._localRuns || []), editor.lastPromptId, editor.segmentPromptId, editor.objectsPromptId, editor.upsamplePromptId, editor.cutoutPromptId];
            for (const id of ids) if (id) this._closedPrompts.add(String(id));
            for (const id of this._closedPrompts) { if (this._closedPrompts.size <= 64) break; this._closedPrompts.delete(id); }
            // a helper's output names its tab (canvas_node): one queued while the tab closed has no id here yet
            this._closedNodes.add(String(editor.node.id));
            for (const id of this._closedNodes) { if (this._closedNodes.size <= 64) break; this._closedNodes.delete(id); }
            // the renders Reopen Closed Tab takes back (reopenClosed): their node counts and the click's texts
            const p = editor.runProgress;
            const runs = [...(editor._localRuns || [])].map((id) => {
                const r = p && (p.runs.get(String(id)) || (p.dropped.get(String(id)) || {}).run);
                return { id: String(id), nodes: r ? r.nodes : 1, sent: editor._sentTexts ? editor._sentTexts.get(id) : undefined };
            });
            if (runs.length) {
                this._closedRuns.set(String(editor.node.id), runs);
                for (const k of this._closedRuns.keys()) { if (this._closedRuns.size <= CLOSED_MAX) break; this._closedRuns.delete(k); }
            }
        }
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
    //   geometry (editor, kind, m, op, from, to) the whole picture was turned, cropped, extended, resized or straightened
    //                             (before its "changed"; `m` maps old image coordinates to new ones, `op` only for turns)
    //   tool (editor, tool, prev) the active tool changed
    //   removed (editor)          a tab was closed
    //   crop (editor)             an app setting the crop of a run depends on changed (a node parameter, the API size);
    //                             once per open editor, the document itself unchanged
    //   realism ()                what the Realism Pass shows may have changed: the server's status, its node list,
    //                             settings.realism (a refused model preset's fallback included)

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

    /** Called at the end of the editor constructor. */
    editorBuilt(editor) {
        try { this.buildExportSize(editor); } catch (err) { console.warn("export size row", err); }
        try { this.hookStatus(editor); } catch (err) { console.warn("status hook", err); }
        try { this.buildUpscaleButton(editor); } catch (err) { console.warn("upscale button", err); }
        try { buildAreaButton(this, editor); } catch (err) { console.warn("each area button", err); }
        this.emit("built", { editor });
    },

    /**
     * The status line is one clipped line without a tooltip in the editor: the app gives
     * it the full text as a title, logs an error or a warning line (the editor's statusKind), and
     * opens the console on a click. Hooked from outside, so no sync patch.
     */
    hookStatus(editor) {
        if (editor._statusHooked || typeof editor.setStatus !== "function") return;
        editor._statusHooked = true;
        const orig = editor.setStatus.bind(editor);
        editor.setStatus = (t, opts) => {
            orig(t, opts);
            const text = String(t == null ? "" : t);
            if (editor.statusEl) editor.statusEl.title = text + (text ? "\n(click: the console)" : "");
            const kind = editor.statusKind;
            if (kind === "error" || kind === "warn") {
                try { window.scumble.log.add({ level: kind, source: "status", message: text }); } catch (_) { /* preload missing */ }
            }
        };
        if (editor.statusEl) {
            editor.statusEl.style.cursor = "pointer";
            editor.statusEl.addEventListener("click", () => { if (this.openConsole) this.openConsole(); });
        }
    },
};
