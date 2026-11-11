// @ts-check
// plugin hooks, the editor lookup, mount, node types, box plans, restore, setRecipe: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import * as comfyprompt from "./comfyprompt.js";
import * as loraPanel from "./lora_panel.js";
import { refusal } from "./inpaint_status.js";
import { promptPayload } from "./boxes_model.js";
import { syncAreaButton } from "./eacharea.js";
import { CLOSED_MAX, api, plainObject } from "./host_util.js";

export const HostSetupPart = {
    toolChanged(editor, tool, prev) {
        this.emit("tool", { editor, tool, prev });
    },

    /**
     * Pointer gestures on the canvas are offered to plugin tools first (patched into
     * onPointerDown / Move / Up). Returns true when a plugin tool took the event.
     */
    pluginPointer(editor, phase, e, ix, iy, p) {
        // the Key dialog's live loop listens first and never takes the event: the brush goes on (docs/PLAN_CORRIDORKEY.md §4.6)
        const ks = this.keySession;
        if (ks && ks.editor === editor && typeof ks.pointer === "function") {
            try { ks.pointer(phase, e, ix, iy, p); } catch (err) { console.warn("key session pointer", err); }
        }
        return this.plugins ? this.plugins.pointer(editor, phase, e, ix, iy, p) : false;
    },

    /** Single-key shortcuts of plugin tools and actions (patched into onKey before the tool switch). */
    pluginKey(editor, e, k) {
        return this.plugins ? this.plugins.key(editor, e, k) : false;
    },

    /** Plugin tools draw on the canvas overlay (patched into drawOverlays, view transform applied). */
    pluginOverlay(editor, ctx) {
        // the Key dialog's matte over its box, screen only (drawOverlays: no export or screenshot carries it)
        const ks = this.keySession;
        if (ks && ks.editor === editor && typeof ks.overlay === "function") {
            ctx.save();
            try { ks.overlay(ctx); } catch (err) { console.warn("key session overlay", err); } finally { ctx.restore(); }
        }
        if (this.plugins) this.plugins.overlay(editor, ctx);
    },

    /** Report an error from a plugin execution (e.g. wholeStats) to the plugin registry. */
    pluginReport(pluginId, where, err) {
        if (this.plugins && typeof this.plugins.report === "function") this.plugins.report(pluginId, where, err);
    },

    isActive(editor) {
        return editor === this.editor;
    },

    /** The node's editor is an overlay with a title and a close button; here it is the window. */
    overlay: false,
    /** The node words a few texts differently (js/host.js); the editor's fallbacks are ours. */
    text: null,
    /** No litegraph here: settingTargetsFromGraph is the node's path. */
    graph() {
        return null;
    },
    /** File names outside the editors that the cleanup must keep (the node scans workflow tabs). */
    referencedTexts() {
        return [];
    },

    editors() {
        return this._editors.slice();
    },

    editorById(id) {
        return this._editors.find((e) => String(e.node.id) === String(id)) || null;
    },

    // the prompts of closed tabs (removeEditor): their results and errors are dropped (the newest 64); the tabs' node
    // ids, for a helper's output queued while its tab closed; per closed tab, the renders a reopen takes back
    _closedPrompts: new Set(),
    // prompt id -> a local Klein run's family and files (kleinRun), read by the execution_error listener (0.1.50 Q1)
    /** @type {Map<string, { family: string, unet: string, clip: string }>} */
    _kleinRuns: new Map(),
    // prompt id -> the PreviewAny node that shows a run's upsampled prompt (comfyprompt.wireUpsampler, 0.1.50 Q9)
    /** @type {Map<string, string>} */
    _upsampledRuns: new Map(),
    _closedNodes: new Set(),
    _closedRuns: new Map(),

    /** The editor whose generate / helper prompt has this id, if any. */
    editorByPrompt(promptId) {
        if (!promptId) return null;
        return this._editors.find((e) => e.lastPromptId === promptId || e.segmentPromptId === promptId || e.objectsPromptId === promptId
            || e.upsamplePromptId === promptId || e.cutoutPromptId === promptId || (e._localRuns && e._localRuns.has(promptId)))
            || (this._pictureRuns.has(promptId) ? this._pictureRuns.get(promptId).editor : null) || null;
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

    /**
     * The slot of the connected server's Inpaint Canvas box_prompt output (comfyprompt.boxPromptSlot), or -1. A node list
     * without it is read again for that node alone first: the node may have been updated since the connect (the
     * sentence a run refuses with asks for that).
     */
    async boxPromptSlot() {
        let slot = comfyprompt.boxPromptSlot(this.objectInfo);
        if (slot >= 0) return slot;
        try {
            const res = await api.fetchApi("/object_info/InpaintCanvas");
            const one = res && res.status === 200 ? await res.json() : null;
            if (one && one.InpaintCanvas) {
                // kept only in a node list that is known (a partial one would read every other node as missing)
                if (this.objectInfo) {
                    this.objectInfo = { ...this.objectInfo, InpaintCanvas: one.InpaintCanvas };
                    if (this._types) this._types.InpaintCanvas = { nodeData: one.InpaintCanvas };
                }
                slot = comfyprompt.boxPromptSlot(one);
            }
        } catch (_) { /* the node list as it was */ }
        return slot;
    },

    /**
     * The boxes a run of a ComfyUI recipe that declares them (its `boxes`, comfyprompt.localBoxSchema) sends with the Boxes
     * switch on, as canvas_state carries them (boxes_model.promptPayload over the document's boxes and the reference
     * layers `refIds` the run sends; serializeForPrompt takes them as they are, `opts.boxes`):
     * - `boxes`: the list; null when the Boxes plugin holds none for the document (or is off, so its stored boxes stay home
     *   as on an API run): the selection then goes as one box, the node's own, and `goes` says whether there is one;
     * - `notes`: the boxes promptPayload left out (a From box whose layer does not go), said in the status line;
     * - `fresh` (Generate new on a fresh canvas): no selection's box, and Keep, Move and Remove boxes are left out
     *   (comfyprompt.newImageBoxes), each with a note in `dropped`;
     * - `goes`: whether a box goes, so the node's box_prompt is needed.
     * @returns {{ boxes: any[] | null, notes: string[], dropped: string[], goes: boolean }}
     */
    localBoxPlan(editor, refIds, { fresh = false } = {}) {
        const held = this.plugins ? this.plugins.countBoxes(editor) : 0;
        const d = editor.pluginData && editor.pluginData.boxes;
        const list = held > 0 && d && Array.isArray(d.boxes) ? d.boxes : [];
        if (!list.length) return { boxes: fresh ? [] : null, notes: [], dropped: [], goes: !fresh && !!(editor.getBounds && editor.getBounds()) };
        const p = promptPayload(list, editor.refLayersFor(refIds));
        const f = fresh ? comfyprompt.newImageBoxes(p.boxes) : { boxes: p.boxes, dropped: [] };
        return { boxes: f.boxes, notes: p.notes, dropped: f.dropped, goes: f.boxes.length > 0 };
    },

    /**
     * Generate new with a ComfyUI recipe that declares its boxes (the generate_new command's local path, before its
     * newCanvas replaces the picture): the boxes the run sends (localBoxPlan, `fresh`), measured on the picture and the
     * reference layers they were drawn on, or null when the recipe takes none or the Boxes switch is off. A run that sends
     * a box to a node without box_prompt is refused here as queueGenerate refuses it, so the picture is not wiped first.
     * @param {any} editor
     * @param {any} r the recipe
     * @param {string[]} refIds the reference layers the run sends
     */
    async newBoxPlan(editor, r, refIds) {
        if (!comfyprompt.localBoxSchema(r) || !(editor.genSettings && editor.genSettings.boxes)) return null;
        const plan = this.localBoxPlan(editor, refIds, { fresh: true });
        if (plan.goes && (await this.boxPromptSlot()) < 0) throw refusal(comfyprompt.oldNodeBoxes(r), "warn");
        return plan;
    },

    async onConnected(status) {
        api.clientId = await window.scumble.comfy.clientId();
        try { await this.loadObjectInfo(); } catch (err) { console.warn(err); this.objectInfo = null; this._types = {}; }
        this.connected = true;
        this._loraInfo.clear();   // the LoRA hints are the server's: read again for this one (loraInfo)
        this.emit("realism");   // the pass's check reads the node list
        for (const ed of this._editors) {
            // Uploads are cached per hash; a (possibly different) server may not have them.
            // The mirror re-uploads what a run needs (ensureOnServer), the reset only makes
            // sure the next run hashes the composite again.
            ed.uploaded = ed.makeUploaded();
            if (!status.node) ed.setStatus("ComfyUI is connected but the Inpaint Canvas node pack is missing: in that server's custom_nodes run git clone https://github.com/DenRakEiw/ComfyUI-InpaintCanvas, then restart ComfyUI.", "warn");
            else if (!ed.base) ed.setStatus(`Connected to ${status.message}. Load an image (Ctrl+O, drop a file, or paste).`);
            ed.refreshSegmentBackends();
            ed.settingsChanged();
            // the server's LoRA list arrived with the node list: the rows' "(not on the server)" marks follow it
            try { loraPanel.render(this, ed); } catch (err) { console.warn("loras section", err); }
        }
        const pending = this._pendingStates;
        this._pendingStates = [];
        this._restoring++;
        try {
            for (const { editor: ed, state } of pending) {
                if (!this._editors.includes(ed)) continue;
                try { await ed.setValue(state); this.keepRecipeMode(ed); if (ed.base) ed.setStatus("Last session restored."); } catch (err) { console.warn("restore failed", err); }
                if (ed.base) this._rawStates.delete(ed);
            }
        } finally {
            this._restoring--;
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
        // the session's closed tabs (Reopen Closed Tab); only a session bundle carries them
        if (bundle && Array.isArray(bundle.closed)) this.closed = bundle.closed.filter((c) => c && typeof c.state === "string" && c.state.length > 2).slice(-CLOSED_MAX);
        let any = false;
        const settle = [];
        this._restoring++;
        try {
            for (const doc of docs) {
                if (!doc || typeof doc.state !== "string" || doc.state.length < 3) continue;
                let ed = this.editorById(doc.id);
                if (!ed) ed = this.createDocument ? this.createDocument(+doc.id || this.nextId++) : this.editor;
                if (!ed) continue;
                // the tab's .scumble file, its plugin data and a newer document's unknown fields (bundle(), docMeta)
                const f = plainObject(doc.file);
                ed.docFile = f && typeof f.path === "string" ? { ...f } : null;
                ed.pluginData = plainObject(doc.plugins) ? JSON.parse(JSON.stringify(doc.plugins)) : {};
                ed.docExtra = plainObject(doc.extra) ? { ...doc.extra } : {};
                try { await ed.setValue(doc.state); this.keepRecipeMode(ed); } catch (err) { console.warn("restore from the mirror failed", err); }
                if (ed.base && ed.docFile) settle.push(ed);
                if (ed.base) { ed.setStatus("Last session restored."); any = true; }
                else if (!this.connected) { this._pendingStates.push({ editor: ed, state: doc.state }); this._rawStates.set(ed, doc.state); ed.setStatus("This document will be restored once ComfyUI is connected (its files are not in the local store).", "warn"); }
            }
        } finally {
            this._restoring--;
        }
        for (const ed of settle) this.settleKey(ed).catch((err) => console.warn("document key", err));
        const active = bundle && this.editorById(bundle.active);
        if (active) this.activate(active);
        if (this.onDocsChanged) this.onDocsChanged();
        return any;
    },

    // ---- recipe: the graph the editor is wired into ------------------------------------

    setRecipe(recipe) {
        this.recipe = recipe;
        for (const ed of this._editors) this.applyRecipe(ed);
        // the areas' crops follow the recipe's limits, and an upscaler takes no Each area
        for (const ed of this._editors) { try { syncAreaButton(this, ed); } catch (err) { console.warn("each area", err); } }
        // the plugins hear of it (a panel that says whether the recipe takes boxes): the active tab, the recipe's id
        this.emit("recipe", { editor: this.editor, recipe: recipe ? recipe.id : null });
    },

    onModeChanged: null,   // set by the shell: (mode, editor) => void

    /** The editor's local / api select: the shell switches to a recipe of that kind. */
    modeChanged(editor, mode) {
        if (this.onModeChanged) { try { this.onModeChanged(mode, editor); } catch (err) { console.warn(err); } }
    },
};
