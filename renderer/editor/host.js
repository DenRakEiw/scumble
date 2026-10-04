// @ts-check
// What the editor needs from its surroundings. The editor (renderer/editor/inpaint_*.js) is
// shared with the ComfyUI node, whose own js/host.js answers the same members with `app`,
// `api` and the litegraph node; here it is one object backed by the main process.
// tools/build_node.py --check fails when the editor calls a member one of the two lacks
// (docs/BUILD_NODE.md).
//
//   api   - ComfyUI's client API surface the editor uses: fetchApi, apiURL, queuePrompt,
//           addEventListener, clientId. Requests go to scumble://app/comfy/*, which the main
//           process proxies to the server, so images and uploads stay same-origin.
//   host  - the document-level services: recipe, settings targets, generate, autosave.
//           Several editors can be open (tabs in the shell); `host.editor` is the active
//           one, `host.editors()` all of them. Server events are routed to the editor
//           that asked: results by prompt id, helper masks / texts by the canvas_node id
//           the helper prompt carried (= editor.node.id).

import { prepareCropAsync, finishResultAsync, bytesToImage, transparentPixels, canvasBytes, referenceBytes, planFrame } from "./stitch.js";
import { glReleasePool } from "./inpaint_filters_gl.js";
import { withoutSecrets } from "./redact.js";
import { parse, toMarkers, namesFor, hasTokens, remap, referencesText, referencesRule, referenceName } from "./reftokens.js";
import { comfyRefSpec, comfyLayout, trimSlots, refName, resolveMarkers as resolveComfyMarkers } from "./comfyrefs.js";
import { frameOf, selectionBox, smallBox, smallBoxes, smallNote, SMALL_PX } from "./boxes.js";
import * as realism from "./realism.js";
import * as comfyprompt from "./comfyprompt.js";
import * as dialogs from "../dialogs.js";

const PROXY = "/comfy";

/**
 * The format a run of the recipe sends boxes in (item 28), or null when it sends none: the variant's `options.boxes`
 * ("flux3", "ideogram4"), for Generate and Generate new; Generate new with references may take its text route's own
 * options.
 */
const boxesSchema = (r) => {
    if (!r || r.kind !== "provider") return null;
    const own = (r.options || {}).boxes, text = ((r.text && r.text.refs && r.text.refs.options) || {}).boxes;
    return typeof own === "string" ? own : typeof text === "string" ? text : null;
};
const SUBFOLDER = "inpaint_canvas";

// How big the crop goes to an API provider. The app is for quality, so "max" is the default:
// the crop is emitted at the provider variant's documented maximum. "x2" / "x4" are the
// high-res fix - the crop at twice or four times its own size, still held under that maximum -
// and the last two keep the older behaviour. Every one of them is capped by the variant's
// `limits`, which is what keeps a model from being handed a size it answers with an error.
const MAX_EXPORT_SIDE = 32768;
const EXPORT_PERCENTS = [200, 150, 100, 75, 50, 33, 25, 10];

// The five answers to "how far up?", labelled so they read without the tooltip: the row is
// called Highres fix, so every label finishes that sentence.
const API_SIZES = [
    ["max", "Maximum", "As big as the chosen provider takes: the strongest high-res fix, and the biggest bill"],
    ["x2", "2x crop", "The crop at twice its own size, capped at the provider's maximum"],
    ["x4", "4x crop", "The crop at four times its own size, capped at the provider's maximum"],
    ["target", "Target size", "The Target field above, the way local ComfyUI runs use it"],
    ["crop", "Off (crop size)", "No high-res fix: the crop goes out at its own resolution, capped at the provider's maximum"],
];

// ---- api ---------------------------------------------------------------------------------

const listeners = new Map();

// the top-level fields the editor's getValue() writes (renderer/editor/inpaint_canvas.js); anything else in an opened
// document came from a newer Scumble and rides along in `extra` (docs/PLAN_DOCUMENTS.md §6)
const STATE_KEYS = new Set(["width", "height", "base", "prompt", "layers", "history", "selection", "selectionBox", "selections", "guides", "seen", "crop", "upsample", "gen", "negative", "settings", "refs", "cutout"]);

/** A 53-bit hash of a string (cyrb53): the saved state's key, to tell a changed document from a saved one. */
function hashString(s) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function fmtMB(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(2) + " GB" : n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }

/**
 * The dialog of a question about a document (host.askDocument): `spec` for dialogs.ask, `answers` the word of each
 * button. `close` Save / Don't Save / Cancel; `changed` (the file changed on disk) and `newer` (made by a newer Scumble)
 * Overwrite / Save As / Cancel; `history` (a Save As of a document with results) with / without the result history.
 */
function documentQuestion(q) {
    const name = String(q.name || "the document");
    if (q.kind === "close") return {
        answers: ["save", "discard", "cancel"],
        spec: {
            buttons: [q.hasFile ? "Save" : "Save...", "Don't Save", "Cancel"], defaultId: 0, cancelId: 2, danger: 1,
            title: q.hasFile ? `Save the changes to ${name}?` : `Save ${name} as a document?`,
            detail: "Don't Save closes the tab; File › Reopen Closed Tab (Ctrl+Shift+T) brings it back in this session.",
        },
    };
    if (q.kind === "changed") return {
        answers: ["overwrite", "saveas", "cancel"],
        spec: {
            buttons: ["Overwrite", "Save As...", "Cancel"], defaultId: 1, cancelId: 2, danger: 0,
            title: `${name} changed on disk since it was opened or saved here.`,
            detail: "Overwrite replaces the file on disk with this document; Save As keeps it and writes a new file.",
        },
    };
    if (q.kind === "newer") return {
        answers: ["saveas", "overwrite", "cancel"],
        spec: {
            buttons: ["Save As...", "Overwrite", "Cancel"], defaultId: 0, cancelId: 2, danger: 1,
            title: `${name} was made by a newer Scumble.`,
            detail: "This version keeps what it does not know, but cannot show or check it. Save As leaves the original file as it is.",
        },
    };
    if (q.kind === "history") {
        const n = Math.max(0, Math.round(+q.count || 0));
        return {
            answers: ["with", "without", "cancel"],
            spec: {
                buttons: ["Save with History", "Save without History", "Cancel"], defaultId: 0, cancelId: 2,
                title: `Save ${name} with its result history?`,
                detail: `The history holds ${n} result${n === 1 ? "" : "s"} with the prompts and settings of the runs. Without it, the file shows the picture and its layers but not how it was made (for sharing). Ctrl+S keeps this choice for this file.`,
            },
        };
    }
    throw new Error("unknown question: " + q.kind);
}

/** A path as documents are compared (main's pathKey): separators unified; Windows paths case-folded. */
function normPath(p) {
    const s = String(p || "").replace(/\//g, "\\");
    return /^[a-z]:\\|^\\\\/i.test(s) ? s.toLowerCase() : String(p || "");
}

/**
 * What a bundle entry keeps beside the state: the tab's file (with `clean`: whether the tab matched it, so a restart can
 * take the restored state as the saved one), its plugin data, the unknown fields of a newer document.
 */
function docMeta(ed, clean = false) {
    const out = {};
    if (ed.docFile && ed.docFile.path) out.file = { ...ed.docFile, clean: !!clean };
    if (ed.pluginData && Object.keys(ed.pluginData).length) out.plugins = ed.pluginData;
    if (ed.docExtra && Object.keys(ed.docExtra).length) out.extra = ed.docExtra;
    return out;
}

const plainObject = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

/** An API run, an upscale or a Realism Pass refused while another one holds the document (`editor.providerPending`). */
const RUN_GOING = "A run is still going on this document: wait for it, or Cancel.";

/** A run's id, for main's Cancel (providers/index.js `cancel`). */
const runIdOf = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * One provider request (main's `provider:edit`), under the run's id so the title row's Cancel can stop it; a refusal
 * comes back without Electron's "Error invoking remote method" wrapper.
 */
async function providerEdit(request, token) {
    // a Cancel while the crop was being made: nothing goes to the provider
    if (token && token.cancelled) throw new Error("Cancelled before anything was sent to the provider.");
    try {
        return await window.scumble.providers.edit(token && token.runId ? { ...request, runId: token.runId } : request);
    } catch (err) {
        throw new Error(String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
}

/**
 * The seed a provider's answer says the model got (providers/index.js passes the adapter's `seed` on), or null when
 * the route sent none (FLUX 3 Image takes no seed; WaveSpeed's routes whose `accepts` leave it out).
 */
function answeredSeed(res) {
    const n = res && res.seed != null && res.seed !== "" ? Number(res.seed) : NaN;
    return Number.isFinite(n) ? n : null;
}

/** How an upscaler's size refusal names the picture (host.upscaleSizeRefusal's `what`) and what to pick instead. */
function upscaleWords(w, h, what) {
    if (what === "picture") return { the: `The picture is ${w} × ${h}`, smaller: "a smaller picture" };
    if (what === "sent") return { the: `The selection's box goes out at ${w} × ${h}`, smaller: "a smaller area" };
    return { the: `The box (the selection with its context) is ${w} × ${h}`, smaller: "a smaller area" };
}

/** "a", "a and b", "a, b and c" */
function listWords(items) {
    return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const CLOSED_MAX = 10;    // closed tabs kept for Reopen Closed Tab (docs/PLAN_DOCUMENTS.md §5.4)

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

// ---- the contract ------------------------------------------------------------------------
//
// The editor modules (inpaint_*.js) are shared with the ComfyUI node, so every member the
// editor asks for has to exist in *this* file and in the node's own js/host.js.
// tools/build_node.py --check enforces that by grepping both files for the names the editor
// uses; the two typedefs below are the same statement in a form a type checker reads, and
// types/contracts.js is where this side of it is checked against them. The node repository
// has no tsconfig, so the grep stays: it is the only check that reaches over there.
//
// A member belongs here when an editor module calls it. Nothing else is the contract - the
// shell talks to this object too, and those members are deliberately absent.

/**
 * ComfyUI's client API surface. The editor modules call the first three; `addEventListener`
 * is in the surface because the host wires the server's events with it (the header above).
 *
 * @typedef {Object} EditorApi
 * @property {(path: string) => string} apiURL
 * @property {(path: string, init?: RequestInit) => Promise<Response>} fetchApi
 * @property {(number: number, prompt: { output: any, workflow?: any }) => Promise<any>} queuePrompt
 * @property {(type: string, fn: (ev: { detail: any }) => void) => void} addEventListener
 */

/**
 * The document-level services. `editor` is one InpaintEditor instance; it is `any` here
 * because the class is 12,000 lines of its own and typing it is not this stage's business.
 *
 * @typedef {Object} EditorHost
 * @property {boolean} connected                         is a ComfyUI server connected
 * @property {boolean} overlay                           node: a modal over the graph; app: the window
 * @property {Record<string, string> | null} text        node-specific wording, null = the editor's own
 * @property {(rootEl: any) => void} mount               where the editor's DOM goes
 * @property {(editor: any) => void} editorBuilt         the modal is built
 * @property {(editor: any) => void} changed             state changed: autosave
 * @property {(editor: any) => boolean} isActive         is this the editor the user is looking at
 * @property {() => any[]} editors                       every open editor
 * @property {() => any} graph                           the litegraph graph (node) or null (app)
 * @property {() => string[]} referencedTexts            file names outside the editors to keep
 * @property {(editor: any) => void} onEscape            Escape: close the overlay (node) or nothing
 * @property {(editor: any, tool: string, prev: string) => void} toolChanged
 * @property {(editor: any, mode: string) => void} modeChanged
 * @property {(editor: any, phase: string, e: any, ix: number, iy: number, p: any) => boolean} pluginPointer
 * @property {(editor: any, e: any, k: string) => boolean} pluginKey
 * @property {(editor: any, ctx: any) => void} pluginOverlay
 * @property {() => any} nodeTypes                       the server's node classes, for the settings rows
 * @property {(editor: any) => any[]} settingTargets     the recipe's settings rows for this editor
 * @property {(editor: any, list: any, targets: any) => void} renderPresets
 * @property {(editor: any, name: string, fallback?: any) => any} widgetValue
 * @property {(editor: any) => any} resultInputState     which result input the recipe writes to
 * @property {(editor: any) => any} workflowForPng       the workflow to embed in a saved PNG, null = embed nothing
 * @property {(editor: any, sec: any) => void} buildGenerateExtras   the extra rows under Generate
 * @property {(editor: any, opts?: { refs?: any }) => Promise<any>} queueGenerate   run the recipe; `refs`: the click's reference snapshot (docs/PLAN_REFS.md C3)
 * @property {() => boolean} generateNewAvailable
 * @property {(editor: any) => void} openGenerateNew
 * @property {(editor: any, fmt?: string) => any} exportCanvas
 * @property {(editor: any) => boolean} exportIsPlain
 * @property {(editor: any) => number} exportQuality
 * @property {(blob: Blob, name: string, opts?: { editor?: any, download?: boolean }) => Promise<any>} saveExport   the node takes `opts`, the app ignores it
 * @property {() => any[]} upsampleBackends
 * @property {(editor: any, backend: any, instruction: string, refs?: any[]) => Promise<any>} upsampleInApp   `refs`: the references the prompt names (docs/PLAN_REFS.md 26d1)
 * @property {(ctx: any) => string} upsampleInstruction
 * @property {(backend: any, instruction: string, canvas: any, images?: { png: Uint8Array, label: string }[]) => Promise<any>} askLLM   `images`: reference pictures (docs/PLAN_REFS.md 26d2)
 * @property {() => any[]} cutoutBackends
 * @property {(editor: any, layer: any, backend: any) => Promise<any>} cutoutInApp
 * @property {() => boolean} objectsInApp
 * @property {(editor: any, pending: any) => Promise<any>} findObjects
 * @property {(editor: any, ix: number, iy: number, p?: any) => Promise<any>} selectPoint
 * @property {() => Promise<any>} freeHelpers
 * @property {boolean} removeSupported
 * @property {boolean} refTokens                                     @img1 in the prompt names a reference layer (docs/PLAN_REFS.md); the node has none yet
 * @property {(editor: any, over?: any, opts?: { keep?: boolean }) => Promise<any>} refLayout   the chosen route's name for each shown reference ({ names, over, none, local, cap, refuse, guess? }); the node answers null
 * @property {(editor: any) => { takes: boolean, count: number, schema: string | null } | null} boxSwitch   the Boxes switch under the prompt (docs/PLAN_BOXES.md S3d): does the recipe send boxes, how many the document holds, in which format (flux3, ideogram4); the node answers null
 * @property {() => any} removeModel
 * @property {(editor: any, req: { image: Uint8Array, mask: Uint8Array }) => Promise<any>} removeInApp
 * @property {(editor: any) => Promise<any>} warmRemove
 */

// ---- host --------------------------------------------------------------------------------

// an id per object, for signatures that must tell a replaced object from one of the same version (host.realismWhole)
const objectIds = new WeakMap();
let objectSeq = 0;
function objectId(o) {
    if (!o || typeof o !== "object") return 0;
    let n = objectIds.get(o);
    if (!n) { n = ++objectSeq; objectIds.set(o, n); }
    return n;
}

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
     * @param {{ mount?: HTMLElement, nodeParams?: any, apiSize?: string, embedRecipe?: boolean, llmRefPictures?: boolean, realism?: any }} [opts]
     */
    configure({ mount, nodeParams, apiSize, embedRecipe, llmRefPictures, realism: realismStored } = {}) {
        this.mountEl = mount || document.body;
        if (nodeParams) this.nodeParams = { ...this.nodeParams, ...nodeParams };
        if (API_SIZES.some(([id]) => id === apiSize)) this.apiSize = apiSize;
        if (typeof embedRecipe === "boolean") this.embedRecipe = embedRecipe;
        if (typeof llmRefPictures === "boolean") this.llmRefPictures = llmRefPictures;
        if (realismStored !== undefined) this.realismStored = realismStored;
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
     * label), `schema` the format they go in (the variant's `options.boxes`: "flux3", "ideogram4"; null when it takes
     * none). The switch itself is the document's `genSettings.boxes`: on, a run sends the boxes, or the selection as one
     * box when there are none; off, none.
     */
    boxSwitch(editor) {
        const schema = boxesSchema(this.recipe);
        return { takes: !!schema, count: editor && this.plugins ? this.plugins.countBoxes(editor) : 0, schema };
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
        this.emit("built", { editor });
    },

    /**
     * The status line is one clipped line without a tooltip in the editor: the app gives
     * it the full text as a title, logs what looks like an error, and opens the console on a
     * click. Hooked from outside, so no sync patch.
     */
    hookStatus(editor) {
        if (editor._statusHooked || typeof editor.setStatus !== "function") return;
        editor._statusHooked = true;
        const orig = editor.setStatus.bind(editor);
        editor.setStatus = (t) => {
            orig(t);
            const text = String(t == null ? "" : t);
            if (editor.statusEl) editor.statusEl.title = text + (text ? "\n(click: the console)" : "");
            if (/^(error|failed|could not|cannot|no api key)|error invoking|failed[:.]| failed /i.test(text)) {
                try { window.scumble.log.add({ level: "error", source: "status", message: text }); } catch (_) { /* preload missing */ }
            }
        };
        if (editor.statusEl) {
            editor.statusEl.style.cursor = "pointer";
            editor.statusEl.addEventListener("click", () => { if (this.openConsole) this.openConsole(); });
        }
    },

    // ---- export size ---------------------------------------------------------------------
    //
    // The editor's Export section saves the flattened image at its own resolution. The app
    // adds a size to it: a percentage or a free width and height, plus the encoder quality
    // for JPEG / WebP. `exportCanvas` and `exportQuality` are what the patched exportImage()
    // asks. PSD and ORA always go out at full size, because every
    // layer would have to be scaled on its own.

    /** The per-document export settings, made on first use. */
    exportState(editor) {
        // metadata: null = the app's switch (embedRecipe), true / false = this export's own answer (the export command)
        if (!editor._export) editor._export = { percent: 100, width: 0, height: 0, quality: 0.92, canvasW: 0, canvasH: 0, anchor: "mc", fill: "transparent", metadata: null };
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

    /** The export's canvas (the frame around the scaled picture), [w, h], or null when it is the picture's own size. */
    exportFrame(editor) {
        const e = this.exportState(editor);
        if (!(e.canvasW > 0) || !(e.canvasH > 0)) return null;
        const px = this.exportPixels(editor) || [editor.width | 0, editor.height | 0];
        const w = Math.max(1, Math.min(MAX_EXPORT_SIDE, Math.round(e.canvasW))), h = Math.max(1, Math.min(MAX_EXPORT_SIDE, Math.round(e.canvasH)));
        return w === px[0] && h === px[1] ? null : [w, h];
    },

    /** The picture placed in a bigger (or smaller: cropped) frame by the anchor, over the fill. */
    frameForExport(src, w, h, anchor, fill) {
        const out = document.createElement("canvas");
        out.width = w; out.height = h;
        const ctx = out.getContext("2d");
        if (fill && fill !== "transparent") { ctx.fillStyle = fill === "black" ? "#000000" : fill === "white" ? "#ffffff" : String(fill); ctx.fillRect(0, 0, w, h); }
        const a = String(anchor || "mc");
        const row = a[0], col = a[1];
        const x = col === "l" ? 0 : col === "r" ? w - src.width : Math.round((w - src.width) / 2);
        const y = row === "t" ? 0 : row === "b" ? h - src.height : Math.round((h - src.height) / 2);
        ctx.drawImage(src, x, y);
        return out;
    },

    /** Is the export the picture as it is (no Size row, no frame)? Then a PNG is written in bands, without a canvas (E2). */
    exportIsPlain(editor) {
        return !this.exportPixels(editor) && !this.exportFrame(editor);
    },

    /** What exportImage() encodes: the flattened image, scaled when the Size row asks for it, framed when the Canvas row does. */
    exportCanvas(editor, fmt) {
        let canvas = editor.flattenToCanvas({ forRun: true });
        if (fmt === "psd" || fmt === "ora") return canvas;
        const size = this.exportPixels(editor);
        if (size) canvas = this.resizeForExport(canvas, size[0], size[1]);
        const frame = this.exportFrame(editor);
        if (frame) { const e = this.exportState(editor); canvas = this.frameForExport(canvas, frame[0], frame[1], e.anchor, e.fill); }
        return canvas;
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
    /**
     * @param {any} editor
     * @param {{ percent?: number, width?: number, height?: number, quality?: number, canvasWidth?: number, canvasHeight?: number, anchor?: string, fill?: string }} [size]
     */
    setExportSize(editor, { percent, width, height, quality, canvasWidth, canvasHeight, anchor, fill } = {}) {
        const e = this.exportState(editor);
        if (quality != null) e.quality = Math.min(1, Math.max(0.1, +quality || 0.92));
        if (canvasWidth != null || canvasHeight != null) {
            // one of them alone keeps the frame's aspect from the picture; 0 / empty clears the frame
            const px = this.exportPixels(editor) || [editor.width | 0, editor.height | 0];
            let cw = Math.round(+canvasWidth || 0), ch = Math.round(+canvasHeight || 0);
            if (cw > 0 && !ch && canvasHeight == null && px[0]) ch = Math.max(1, Math.round(cw * px[1] / px[0]));
            if (ch > 0 && !cw && canvasWidth == null && px[1]) cw = Math.max(1, Math.round(ch * px[0] / px[1]));
            if (cw > 0 && !ch) ch = e.canvasH || px[1];
            if (ch > 0 && !cw) cw = e.canvasW || px[0];
            e.canvasW = Math.max(0, Math.min(MAX_EXPORT_SIDE, cw));
            e.canvasH = Math.max(0, Math.min(MAX_EXPORT_SIDE, ch));
            if (!e.canvasW || !e.canvasH) { e.canvasW = 0; e.canvasH = 0; }
        }
        if (anchor != null && /^[tmb][lcr]$/.test(String(anchor))) e.anchor = String(anchor);
        if (fill != null) e.fill = ["transparent", "white", "black"].includes(String(fill)) ? String(fill) : (/^#[0-9a-f]{6}$/i.test(String(fill)) ? String(fill) : e.fill);
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
            i.min = "1"; i.max = String(MAX_EXPORT_SIDE); i.step = "1"; i.title = title;
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
        q.min = "0.1"; q.max = "1"; q.step = "0.02"; q.title = qLab.title;
        q.addEventListener("keydown", (ev) => ev.stopPropagation());
        q.addEventListener("change", () => this.setExportSize(editor, { quality: +q.value }));
        qRow.appendChild(qLab);
        qRow.appendChild(q);

        // 3f: the prompt, seed and recipe in a PNG's text chunks; on unless the user turns it off (the user's default since
        // 0.1.32): anyone the file reaches can read them (an imported recipe carries every widget value of its workflow)
        const mRow = document.createElement("div");
        mRow.className = "ipc-seg scumble-export-metadata";
        const mLab = document.createElement("label");
        mLab.style.display = "flex"; mLab.style.alignItems = "center"; mLab.style.gap = "6px"; mLab.style.cursor = "pointer";
        mLab.title = "Write the prompt, the negative prompt, the seed and the recipe into the PNG (as text chunks). Anyone who gets the file can read them. For every document.";
        const meta = document.createElement("input");
        meta.type = "checkbox";
        meta.addEventListener("keydown", (ev) => ev.stopPropagation());
        meta.addEventListener("change", () => this.setEmbedRecipe(meta.checked));
        mLab.appendChild(meta);
        mLab.appendChild(document.createTextNode("Prompt and recipe in the PNG"));
        mRow.appendChild(mLab);

        // inside the Export section's block, not after it: its padding and row layout apply (after it, the rows sat on the
        // panel's left edge, under the width grip)
        anchor.appendChild(row);
        row.insertAdjacentElement("afterend", qRow);
        qRow.insertAdjacentElement("afterend", mRow);
        // the canvas: a frame around the (scaled) picture, for a fixed output format or a margin
        const cRow = document.createElement("div");
        cRow.className = "ipc-seg scumble-export-canvas";
        cRow.style.flexWrap = "wrap";   // the fill select goes onto a line of its own in a narrow panel instead of squeezing the fields
        const cLab = document.createElement("span");
        cLab.textContent = "Canvas";
        cLab.title = "The saved file's frame around the picture: empty = the picture's own size. Bigger adds a margin of the fill, smaller crops.";
        cRow.appendChild(cLab);
        const cw = num("Frame width in pixels; empty = the picture's size");
        const ch = num("Frame height in pixels; empty = the picture's size");
        cw.min = "0"; ch.min = "0"; cw.placeholder = "auto"; ch.placeholder = "auto";
        cw.addEventListener("change", () => this.setExportSize(editor, { canvasWidth: +cw.value || 0, canvasHeight: +ch.value || 0 }));
        ch.addEventListener("change", () => this.setExportSize(editor, { canvasWidth: +cw.value || 0, canvasHeight: +ch.value || 0 }));
        cRow.appendChild(cw);
        const ctimes = document.createElement("span");
        ctimes.textContent = "×";
        cRow.appendChild(ctimes);
        cRow.appendChild(ch);
        const anchorSel = document.createElement("select");
        anchorSel.className = "ipc-sel";
        anchorSel.style.maxWidth = "64px";
        anchorSel.title = "Where the picture sits in the frame";
        for (const [id, label] of [["tl", "top left"], ["tc", "top"], ["tr", "top right"], ["ml", "left"], ["mc", "centre"], ["mr", "right"], ["bl", "bottom left"], ["bc", "bottom"], ["br", "bottom right"]]) {
            const o = document.createElement("option"); o.value = id; o.textContent = label; anchorSel.appendChild(o);
        }
        anchorSel.addEventListener("keydown", (ev) => ev.stopPropagation());
        anchorSel.addEventListener("change", () => this.setExportSize(editor, { anchor: anchorSel.value }));
        cRow.appendChild(anchorSel);
        const fillSel = document.createElement("select");
        fillSel.className = "ipc-sel";
        fillSel.style.maxWidth = "80px";
        fillSel.title = "What fills the frame around the picture";
        for (const f of ["transparent", "white", "black"]) { const o = document.createElement("option"); o.value = f; o.textContent = f; fillSel.appendChild(o); }
        fillSel.addEventListener("keydown", (ev) => ev.stopPropagation());
        fillSel.addEventListener("change", () => this.setExportSize(editor, { fill: fillSel.value }));
        cRow.appendChild(fillSel);
        qRow.parentElement ? qRow.parentElement.insertBefore(cRow, qRow.nextSibling) : anchor.parentElement.insertBefore(cRow, anchor.nextSibling);
        editor._exportRow = { row, qRow, cRow, mRow, meta, sel, wIn, hIn, q, qLab, cw, ch, anchorSel, fillSel, doc: "" };
        editor.saveFormatSel.addEventListener("change", () => this.syncExportRow(editor));
        // the numbers follow the document: a new image, a crop or an extended canvas changes
        // them. Only a changed document size refreshes the row, so a number being typed in is
        // never overwritten underneath the cursor.
        const offChanged = this.on("changed", ({ editor: ed }) => {
            if (ed !== editor || !editor._exportRow) return;
            if (editor._exportRow.doc !== `${editor.width}x${editor.height}`) this.syncExportRow(editor);
        });
        // both listeners hold the editor: left registered, they kept every closed tab alive with its
        // layers, pyramids and undo steps until the app quit
        const offRemoved = this.on("removed", ({ editor: ed }) => {
            if (ed !== editor) return;
            offChanged();
            offRemoved();
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
        if (r.cw) {
            r.cw.value = e.canvasW || ""; r.ch.value = e.canvasH || "";
            r.anchorSel.value = e.anchor || "mc"; r.fillSel.value = ["transparent", "white", "black"].includes(e.fill) ? e.fill : "transparent";
        }
        const exact = EXPORT_PERCENTS.find((p) => Math.abs(p - e.percent) < 0.05);
        r.sel.value = exact != null ? String(exact) : "custom";
        const fmt = (editor.saveFormatSel && editor.saveFormatSel.value) || "png";
        const layered = fmt === "psd" || fmt === "ora";
        for (const el of [r.sel, r.wIn, r.hIn, ...(r.cw ? [r.cw, r.ch, r.anchorSel, r.fillSel] : [])]) el.disabled = layered;
        r.row.title = layered ? "PSD and ORA always keep the full size" : "";
        r.qRow.hidden = !(fmt === "jpg" || fmt === "webp");
        if (r.mRow) { r.mRow.hidden = fmt !== "png"; r.meta.checked = this.embedRecipe; }
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

    /** The editor whose generate / helper prompt has this id, if any. */
    editorByPrompt(promptId) {
        if (!promptId) return null;
        return this._editors.find((e) => e.lastPromptId === promptId || e.segmentPromptId === promptId || e.objectsPromptId === promptId
            || e.upsamplePromptId === promptId || e.cutoutPromptId === promptId)
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

    async onConnected(status) {
        api.clientId = await window.scumble.comfy.clientId();
        try { await this.loadObjectInfo(); } catch (err) { console.warn(err); this.objectInfo = null; this._types = {}; }
        this.connected = true;
        this.emit("realism");   // the pass's check reads the node list
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
                else if (!this.connected) { this._pendingStates.push({ editor: ed, state: doc.state }); this._rawStates.set(ed, doc.state); ed.setStatus("This document will be restored once ComfyUI is connected (its files are not in the local store)."); }
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
        // the plugins hear of it (a panel that says whether the recipe takes boxes): the active tab, the recipe's id
        this.emit("recipe", { editor: this.editor, recipe: recipe ? recipe.id : null });
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

    /**
     * The preset row at the top of the editor's Settings section (called by renderSettings): a ComfyUI recipe's shipped
     * presets (its file's `presets`, any row: the Realism Pass's L and M) first, then the user's own; without shipped
     * ones the row needs two file combos (model / text encoder / VAE).
     */
    renderPresets(editor, list, targets) {
        const r = this.recipe;
        if (!r || r.kind === "provider") return;
        const keyOf = (t) => `${t.node.id}:${t.inputName}`;
        const shipped = Array.isArray(r.presets) ? r.presets : [];
        const files = this.presetTargets(editor, targets);
        const shippedKeys = new Set(shipped.flatMap((p) => Object.keys(p.values || {})));
        const pts = shipped.length ? targets.filter((t) => shippedKeys.has(keyOf(t)) || files.includes(t)) : files;
        if (!pts.length || (!shipped.length && pts.length < 2)) return;
        const current = {};
        for (const t of pts) { const e = editor.settings[String(t.index)]; if (e) current[keyOf(t)] = String(e.value); }
        // the user's own (settings.recipePresets); one of a shipped one's name replaces it in the list
        const own = (this.presets || {})[r.id] || [];
        const ownNames = new Set(own.map((p) => p.name));
        const presets = [...shipped.filter((p) => !ownNames.has(p.name)).map((p) => ({ ...p, shipped: true })), ...own];
        // the user's own first: one saved with a shipped one's values stays theirs to pick and delete
        const holds = (p) => Object.entries(p.values || {}).every(([k, v]) => current[k] === String(v));
        const matching = own.find(holds) || presets.find(holds);
        const lab = document.createElement("label");
        lab.textContent = "Preset";
        lab.title = shipped.length
            ? `${shipped.map((p) => p.name).join(" and ")} come with this recipe; Save keeps your own combination of ${pts.map((t) => t.node.title || t.inputName).join(" / ")} beside them.`
            : `A saved combination of ${pts.map((t) => t.node.title || t.inputName).join(" / ")} for this recipe. Pick the files above, then Save.`;
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
        del.type = "button"; del.className = "ipc-ib"; del.textContent = "Delete"; del.disabled = !matching || !!matching.shipped;
        del.title = matching && matching.shipped ? `"${matching.name}" comes with the recipe and stays` : matching ? `Delete the preset "${matching.name}"` : "Delete the selected preset";
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
                    const next = own.filter((p) => p.name !== name).concat([{ name, values }]).sort((a, b) => a.name.localeCompare(b.name));
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
            if (!matching || matching.shipped || del.textContent !== "Delete") return;
            await this.savePresets(r.id, own.filter((p) => p.name !== matching.name));
            for (const ed of this._editors) { try { ed.renderSettings(); } catch (_) { /* not built */ } }
            editor.setStatus(`Preset "${matching.name}" deleted.`);
        });
        row.append(sel, save, del);
        lab.appendChild(row);
        list.appendChild(lab);
    },

    applyPreset(editor, targets, preset) {
        const missing = [];
        let rows = 0;
        // every row the preset names (a shipped one may name any row, a user's names the rows it was saved from)
        for (const t of targets) {
            const v = (preset.values || {})[`${t.node.id}:${t.inputName}`];
            const e = editor.settings[String(t.index)];
            if (v == null || !e) continue;
            rows++;
            const k = editor.settingKind(t);
            if (k.kind === "combo") { if (k.options.map(String).includes(String(v))) e.value = v; else missing.push(String(v)); }
            else if (k.kind === "number") e.value = +v;
            else if (k.kind === "boolean") e.value = !!v;
            else e.value = String(v);
        }
        editor.renderSettings();
        editor.notifyChanged();
        editor.setStatus(!rows ? `Preset "${preset.name}" names no Settings row of this recipe: nothing changed.`
            : missing.length ? `Preset "${preset.name}": ${missing.join(", ")} not on the server, kept the current choice there.` : `Preset "${preset.name}" applied.`);
    },

    /**
     * The mode a (resolved) recipe runs in: cloud for a Comfy Cloud recipe, its own graph run on Comfy Cloud (item 35
     * V6; the shell's modeOf), api for a provider recipe or a ComfyUI recipe of API nodes, else local.
     */
    recipeMode(r) {
        return r.kind === "provider" && r.provider === "comfycloud" && r.options && r.options.graph ? "cloud"
            : r.kind === "provider" || r.mode === "api" ? "api" : "local";
    },

    /**
     * A document opened, reopened or restored keeps the selected recipe's mode, not the one its file holds: the recipe
     * is the app's, and a file saved under another one would plan the crop for that mode (a local refine pass for a
     * provider run). Only the mode: the Settings values stay as the file has them.
     */
    keepRecipeMode(ed) {
        if (!this.recipe) return;
        const mode = this.recipeMode(this.recipe);
        if (ed.genSettings.mode !== mode) { ed.genSettings.mode = mode; ed.syncGenControls(); }
    },

    /** The recipe decides the mode (local / api / cloud) and the Settings panel of every editor. */
    applyRecipe(ed) {
        const r = this.recipe;
        if (!r) return;
        const mode = this.recipeMode(r);
        if (ed.genSettings.mode !== mode) { ed.genSettings.mode = mode; ed.syncGenControls(); }
        ed.settingsChanged();
        ed.syncBoxesRow();
        ed.renderInfo();
    },

    /** The recipe's editable inputs in the shape settingTargets() had in the node. */
    settingTargets(editor) {
        const r = this.recipe;
        if (!r) return [];
        const out = [];
        if (r.kind === "provider") {
            // provider parameters: the recipe carries the spec itself (no /object_info). The node id names
            // the recipe and its provider, because the editor keeps a stored value while the target stays
            // the same: with one id for every provider recipe, a "standard" Channel chosen on Qwen via
            // ToAPIs ran GPT Image 2 on its maskless channel, and GPT Image 2.5's "xhigh" fell to "low"
            const nodeId = `provider/${r.id}/${r.provider}`;
            for (const s of r.settings || []) {
                const spec = s.spec || ["STRING", {}];
                const value = s.default !== undefined ? s.default : (spec[1] && spec[1].default !== undefined ? spec[1].default : (Array.isArray(spec[0]) ? spec[0][0] : undefined));
                out.push({
                    index: s.index, output: { name: `setting_${s.index}` },
                    node: { id: nodeId, title: s.label || s.key, type: r.provider },
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
            // the key names the recipe too: the editor keeps a stored value while the key stays the same, and Qwen
            // and Klein both load from nodes "unet", "clip" and "vae", so Klein was queued with Qwen's files
            out.push({
                index: s.index, output: { name: `setting_${s.index}` },
                node: { id: s.node, title: s.label || s.input, type: node.class_type },
                inputName: s.input, key: `${r.id}/${s.node}:${s.input}`, spec, widget: value !== undefined ? { value } : null,
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

    // ---- @img tokens at send time (docs/PLAN_REFS.md C3) ------------------------------------

    /**
     * The prompt and the negative of a run with their @img tokens made fit for its route, from the click's snapshot
     * `snap` (`editor.refSnapshot()`; the texts default to its own):
     * - "edit": each token becomes a marker {@ref:i}, i = its layer's index in `sent` (the order of the request's
     *   references, null for the Original), which main turns into the route's own name for the picture; `sent` null
     *   only checks that every token can be sent. `pairs` lists [{ label, id, ref }] for the status line.
     * - "none": a run that sends no reference picture (an upscale, Generate new): each token is written as its layer's
     *   name, in the request text only; `note` says so, `who` names the run in it.
     * - "comfy": a local ComfyUI recipe (26e): `comfy` = { spec, lay } of comfyrefs.js (the recipe's names and slots, the
     *   run's batch); each token becomes the name the graph gives its picture ("<image3>", "image 3") right here, and
     *   a token for a reference past the recipe's slots refuses. `pairs` also carry that `name`.
     * A token that cannot go refuses the run with the reason and what to do.
     * @param {any} editor
     * @param {{ prompt: string, negative: string, refIds: string[], labels: Map<string, number> } | null} snap
     * @param {"edit" | "none" | "comfy"} route
     * @param {{ prompt?: string, negative?: string, sent?: (string | null)[] | null, who?: string, recipe?: any, comfy?: { spec: any, lay: any } | null }} [opts]
     * @returns {{ prompt: string, negative: string, note: string, pairs: { label: string, id: string, ref: number, name?: string | null }[] }}
     */
    refPrompt(editor, snap, route, { prompt, negative, sent = null, who = "This run", recipe = null, comfy = null } = {}) {
        const s = snap || editor.refSnapshot();
        const texts = { prompt: String(prompt != null ? prompt : s.prompt || ""), negative: String(negative != null ? negative : s.negative || "") };
        const out = { prompt: texts.prompt, negative: texts.negative, note: "", pairs: [] };
        if (!this.refTokens) return out;
        const where = (k) => (k === "negative" ? "The negative prompt" : "The prompt");
        for (const k of ["prompt", "negative"]) if (/\{@ref:/i.test(texts[k])) throw new Error(`${where(k)} holds "{@ref:", which Scumble keeps for itself: reword it.`);
        const idOf = new Map([...s.labels].map(([id, n]) => [n, id]));
        if (route === "none") {
            const replaced = [];
            for (const k of ["prompt", "negative"]) {
                const res = namesFor(texts[k], (key) => {
                    const id = key[0] === "?" ? key.slice(1) : idOf.get(+key.slice(3));
                    const l = id && editor.layers.find((x) => x.id === id);
                    return l ? l.name || "" : null;
                });
                if (res.missing.length) throw new Error(this.refError(editor, s, parse(res.missing[0])[0], k));
                out[k] = res.text;
                for (const x of res.replaced) if (!replaced.some((y) => y.token === x.token)) replaced.push(x);
            }
            if (replaced.length) {
                const tokens = listWords(replaced.map((x) => x.token)), names = listWords(replaced.map((x) => `"${x.name}"`));
                out.note = replaced.length === 1
                    ? `${who} sends no reference images: ${tokens} was written as its layer name ${names}.`
                    : `${who} sends no reference images: ${tokens} were written as their layer names ${names}.`;
            }
            return out;
        }
        // a comfy run's markers index the pictures its graph reads: the Original when it goes, then the kept references
        const lay = route === "comfy" && comfy ? comfy.lay : null;
        const ids = lay ? [...Array(lay.original).fill(null), ...s.refIds.slice(0, lay.kept)] : sent;
        for (const k of ["prompt", "negative"]) {
            // a parked token typed or pasted for a layer that has a label now names it (remap from the labels to themselves)
            texts[k] = remap(texts[k], s.labels, s.labels);
            const res = toMarkers(texts[k], s.labels, ids);
            if (res.errors.length) {
                const e = res.errors[0];
                if (lay && e.kind === "unsent") throw new Error(this.slotsError(recipe || this.recipe || {}, comfy.spec, lay, s, e.token));
                throw new Error(this.refError(editor, s, { type: "token", text: e.token, n: e.n, id: e.kind === "parked" ? e.id : undefined, kind: e.kind }, k));
            }
            out[k] = res.text;
            for (const seg of parse(texts[k])) {
                if (seg.type !== "token" || !("n" in seg)) continue;
                const id = idOf.get(seg.n), label = "@img" + seg.n;
                if (id && !out.pairs.some((p) => p.label === label)) out.pairs.push({ label, id, ref: ids ? ids.indexOf(id) : -1 });
            }
        }
        if (!lay) return out;
        // the names, as the node batches the pictures and the graph's encoder numbers them (comfyrefs.js)
        for (const k of ["prompt", "negative"]) {
            const res = resolveComfyMarkers(out[k], lay.pictures, comfy.spec.name);
            if (res.left.length || /\{@ref:/i.test(res.text) || hasTokens(res.text)) throw new Error(`${where(k)} names a picture ${(recipe || this.recipe || {}).name || "this recipe"} does not read: take the token out.`);
            out[k] = res.text;
        }
        for (const p of out.pairs) {
            const pic = lay.pictures.find((x) => x.ref === p.ref);
            p.name = pic ? refName(comfy.spec.name, pic.n) : null;
        }
        return out;
    },

    /**
     * Why a token past a local recipe's slots cannot go (26e): what the graph reads, and the three ways out.
     * @param {any} r the recipe
     * @param {{ slots: number | null }} spec
     * @param {{ original: number, kept: number }} lay
     * @param {{ refIds: string[], labels: Map<string, number> }} snap
     * @param {string} token
     */
    slotsError(r, spec, lay, snap, token) {
        const tok = String(token || "").replace(/^@img/i, "@img");
        const who = r.name || r.id || "this recipe";
        if (spec.slots === 1) return `${tok} cannot be named: ${who} reads the crop alone, its graph takes no reference picture. Take ${tok} out.`;
        const read = ["the crop", ...(lay.original ? ["the Original"] : []), ...snap.refIds.slice(0, lay.kept).map((id) => "img" + snap.labels.get(id))];
        // only the ways that make room: hiding a reference needs one that goes, Original off needs the Original
        const ways = [...(lay.kept > 0 ? ["hide a reference"] : []), ...(lay.original ? ["turn Original off"] : []), `take ${tok} out`];
        const say = ways.length === 1 ? ways[0] : `${ways.slice(0, -1).join(", ")}, or ${ways[ways.length - 1]}`;
        return `${tok} cannot be named: ${who} reads ${spec.slots} pictures (${listWords(read)}). ${say.charAt(0).toUpperCase()}${say.slice(1)}.`;
    },

    /** Why a token cannot go (refPrompt): `seg` a token segment of `parse`, `k` which text holds it. */
    refError(editor, snap, seg, k) {
        const where = k === "negative" ? "The negative prompt" : "The prompt";
        const tok = String(seg.text || "").replace(/^@img/i, "@img");
        const count = snap.labels.size;
        if (seg.kind === "unsent") return `${tok} is not among the pictures this run sends: take it out of the ${k === "negative" ? "negative prompt" : "prompt"}.`;
        if (seg.id == null) {
            const has = count === 0 ? "has none; add a reference layer first" : count === 1 ? "has @img1 only" : `has @img1 to @img${count}`;
            return `${tok} names no reference image: this document ${has}.`;
        }
        const l = editor.layers.find((x) => x.id === seg.id);
        if (!l) return `${where} names a deleted reference (${tok}): undo the delete, or take the token out.`;
        if (!editor.isReference(l)) return `${where} names "${l.name}" (${tok}), which is no longer a reference layer: make it a reference again, or take the token out.`;
        return `${where} names "${l.name}" (${tok}), a hidden reference: show it in the reference list, or take the token out.`;
    },

    /**
     * A text for a field that sends no reference picture (the Generate new and Upscale dialogs' prefill): each token
     * written as its layer's name; a token without one stays (the run then says why). `{ text, note }`.
     */
    refNames(editor, text) {
        const s = String(text == null ? "" : text);
        if (!this.refTokens || !editor || !hasTokens(s)) return { text: s, note: "" };
        const idOf = new Map([...editor.refLabels()].map(([id, n]) => [n, id]));
        const res = namesFor(s, (key) => {
            const id = key[0] === "?" ? key.slice(1) : idOf.get(+key.slice(3));
            const l = id && editor.layers.find((x) => x.id === id);
            return l ? l.name || "" : null;
        });
        return { text: res.text, note: res.replaced.length ? `The reference ${res.replaced.length === 1 ? "token is" : "tokens are"} written as layer names here: this run sends no reference images.` : "" };
    },

    /**
     * The shape of a provider request as main's `provider:layout` reads it (C3), from the recipe and the editor; `over`
     * replaces parts (`kind`, `provider`, `model`, `params`, `original`, `count` = the references including the
     * Original). runProvider builds its request from the same shape.
     */
    layoutShape(editor, over = {}) {
        // `over.recipe`: a run's own recipe, taken at the click (the list may change while its crop is made)
        const r = over.recipe || this.recipe || {};
        const original = over.original != null ? (over.original ? 1 : 0) : editor.predictOriginal();
        return {
            provider: over.provider || r.provider, model: over.model || r.model,
            kind: over.kind || (r.input === "edit" ? "edit" : "fill"),
            fields: over.fields !== undefined ? over.fields : r.fields || null, options: over.options !== undefined ? over.options : r.options || null,
            params: over.params || this.providerParams(editor),
            original, count: over.count != null ? over.count : editor.referenceLayers().length + original,
            refName: over.refName !== undefined ? over.refName : (r.refs && r.refs.name) || null,
            refsMax: over.refsMax || null,
        };
    },

    /**
     * What the chosen route calls each shown reference now (C3): `{ names: Map<layer id, name | null>, over: Set<layer
     * id> (past the route's cap), none: why no reference goes | null, local: a ComfyUI recipe, cap: the reference layers
     * the route takes | null, refuse: why a token cannot go although the pictures do | null (26c2's bar and card) }`.
     * `keep` (the editor's own refresh): also kept as `editor.refLayoutInfo`, by the last call made, not the last to
     * answer; an agent's `status` reads it without touching that. Null without a recipe. Asks main once
     * (`provider:layout`). `over.recipe`: another recipe than the tab's (the Generate new dialog's variant, which passes
     * `{ keep: false }`); `over.kind` "text": a new image from that variant's `text` shape (26f), the references
     * numbered from 1, none going along where the shape has no `refs`.
     */
    async refLayout(editor, over = {}, { keep = true } = {}) {
        const r = over.recipe || this.recipe;
        if (!r || !editor) { if (editor && keep) editor.refLayoutInfo = null; return null; }
        const seq = keep ? (editor._refLayoutSeq = (editor._refLayoutSeq || 0) + 1) : 0;
        const refs = editor.referenceLayers();
        const blank = (none, local = false) => ({ names: new Map(refs.map((l) => [l.id, null])), over: new Set(), none, local, cap: null, refuse: null });
        let info;
        const text = over.kind === "text";
        if (text) {
            // Generate new: the variant's text shape; its refs say whether the pictures go and to which route
            const t = r.kind === "provider" ? r.text : null, tr = t && t.refs;
            if (!t || !tr) over = null;
            else {
                over = {
                    ...over, recipe: r, kind: "text", provider: over.provider || r.provider, model: over.model || tr.model || t.model,
                    options: over.options !== undefined ? over.options : tr.options ? { ...(r.options || {}), ...tr.options } : r.options || null,
                    // the tab's own Settings rows (a ToAPIs Channel, say) when the dialog is on the tab's recipe and provider,
                    // as runGenerate will send them; another variant's rows go back to their defaults on Go
                    params: over.params || (this.recipe && this.recipe.id === r.id && this.recipe.provider === r.provider ? { ...this.providerParams(editor), ...(t.fixed || {}) } : { ...(t.fixed || {}) }),
                    original: 0, refName: over.refName !== undefined ? over.refName : tr.name || (r.refs && r.refs.name) || null, refsMax: tr.max || null,
                };
            }
        }
        if (text && !over) info = blank(`${r.name || r.id} makes new images from the prompt alone: the reference layers stay in the tab, none go along.`);
        else if (r.kind !== "provider" && r.task === "upscale") info = blank("An upscale sends the picture alone: reference images are left out.", true);
        else if (r.kind !== "provider" && r.task === "pass") info = blank(`${realism.LABEL} sends the picture alone: reference images are left out.`, true);
        else if (r.kind !== "provider") {
            // a local recipe: the names its graph gives the pictures of the node's batch, worked out here (comfyrefs.js)
            // `over.state`: the run a caller has in mind (Generate new's white canvas, all of it selected), else the editor now
            const { spec, lay } = this.comfyPlan(editor, r, refs.length, over.state || null);
            const names = new Map(refs.map((l, k) => {
                const pic = lay.pictures.find((p) => p.role === "reference" && p.ref === lay.original + k);
                return [l.id, pic ? refName(spec.name, pic.n) : null];
            }));
            info = {
                names, over: new Set(refs.slice(lay.kept).map((l) => l.id)),
                none: spec.slots === 1 ? `${r.name || r.id} reads the crop alone: its graph takes no reference picture.` : null,
                local: true, cap: spec.slots == null ? null : Math.max(0, spec.slots - 1 - lay.original), refuse: null, guess: spec.guess,
            };
        }
        else if (r.task === "upscale") info = blank("An upscale sends the picture alone: reference images are left out.");
        else if (r.edit === false && !over.kind) info = blank(`${r.name || r.id} makes pictures from the prompt alone.`);
        else {
            const shape = this.layoutShape(editor, over);
            try {
                const ans = await window.scumble.providers.layout(shape);
                const names = new Map(refs.map((l, k) => [l.id, (ans.names && ans.names[shape.original + k]) || null]));
                const past = ans.over && ans.max != null ? Math.max(0, ans.sent - ans.max) : 0;
                const overSet = new Set(past ? refs.slice(Math.max(0, refs.length - past)).map((l) => l.id) : []);
                const none = ans.drops && [...names.values()].every((n) => n == null) ? ans.drops : null;
                // the route's pictures that are no reference layer (the crop, a mask sent as a picture, the Original)
                // come off its max
                const cap = ans.max != null ? Math.max(0, ans.max - (ans.sent - shape.count) - shape.original) : null;
                // style references and other unnumbered references (Ideogram 4.5) go without a number: a token for one refuses the run (refs.js checkPictures)
                const refuse = ans.style ? "this route sends reference images without a number (as style references or unnumbered references): take the token out to run" : null;
                info = { names, over: overSet, none, local: false, cap, refuse, style: !!ans.style };
            } catch (err) {
                info = blank(String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
            }
        }
        if (keep && editor._refLayoutSeq === seq) editor.refLayoutInfo = info;
        return info;
    },

    _comfySpecs: new WeakMap(),

    /**
     * A local recipe's names and slots (comfyrefs.js `comfyRefSpec`, kept per recipe object) and the batch a run of it
     * sends (`comfyLayout`, the node's rule): from a canvas state `st` when given (what the node will read), else from
     * the editor now. `count`: the reference layers that would go.
     */
    comfyPlan(editor, r, count, st = null) {
        let spec = this._comfySpecs.get(r);
        if (!spec) { spec = comfyRefSpec(r); this._comfySpecs.set(r, spec); }
        const cs = st ? st.crop || {} : editor.cropSettings || {};
        const gs = st ? st.gen || {} : editor.genSettings || {};
        const lay = comfyLayout(spec, {
            hasSelection: st ? !!st.hasSelection : !!(editor.getBounds && editor.getBounds()),
            fill: cs.fill || "none", withOriginal: !!cs.withOriginal,
            refine: !!gs.refine && gs.mode === "local", count,
        });
        return { spec, lay };
    },

    /**
     * What a plugin's box source sees (scumble.generate, docs/PLUGINS.md "Generate"; docs/PLAN_BOXES.md §9): the run's
     * frame in image pixels (the crop of an edit, the document of Generate new), the selection's box, and the pictures
     * of this run as the {@ref:i} markers count them (`sent`: a null for the Original, which takes an index and has no
     * layer; then the reference layers' ids), each with the layer's frame in the picture for a from box's source.
     */
    boxContext(editor, { mode, recipe, provider, model, schema, frame, bounds, sent }) {
        const references = [];
        (sent || []).forEach((id, index) => {
            if (!id) return;
            const l = editor.layers.find((x) => x.id === id);
            references.push({ index, layerId: id, name: l ? l.name : id, frame: l ? { x: l.x || 0, y: l.y || 0, w: l.w || 0, h: l.h || 0 } : null });
        });
        // the selection's bounds are [x0, y0, x1, y1] with x1 and y1 exclusive (editor.getBounds)
        const selection = bounds ? { x: bounds[0], y: bounds[1], w: bounds[2] - bounds[0], h: bounds[3] - bounds[1] } : null;
        return { mode, recipe: recipe ? recipe.id : null, provider: provider || null, model: model || null, schema: schema || null, frame, selection, references };
    },

    /**
     * A run through an API provider: crop in the app (stitch.js), one request to the
     * main process (electron/main/providers), the answer stitched back into an RGBA
     * patch that is stored in the file mirror as a result and added like a result from
     * the node. No ComfyUI involved. `opts.refs`: the click's reference snapshot.
     */
    async runProvider(editor, opts = {}) {
        const r = this.recipe;
        if (!editor.base) throw new Error("Load an image first.");
        // one run per document: a second token would take the slot, and its end would clear it under the first (a Realism
        // Pass, an upscale), which then reads as idle (busy(), Close without asking, turnBlocked)
        if (editor.providerPending) throw new Error(RUN_GOING);
        const label = r.providerLabel || r.provider;
        if (r.edit === false) throw new Error(`${r.name || r.id} on ${label} makes images from the prompt alone: use "Generate new", not Generate.`);
        // the prompt and the references of the click; a token that cannot go refuses before anything is made
        const snap = opts.refs || editor.refSnapshot();
        this.refPrompt(editor, snap, "edit");
        editor.lastSentPrompt = null;
        editor.lastRunNotes = [];
        editor.lastSentBoxes = 0;
        const token = { provider: r.provider, label, started: Date.now(), editor, runId: runIdOf() };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();
        let res, info, sel, x, y, w, h, params = {}, named = null;
        try {
            // what the request says is read at the click, as the crop is: the window stays usable while it is made
            params = this.providerParams(editor, opts.background ? { background: opts.background } : null);
            const keepAlpha = this.wantsTransparent(params);
            const seed = editor.genSettings.seed;
            // the crop and its masks off the window: the box from the tile workers, the pixels in the stitch worker;
            // the references are the click's
            const prep = await prepareCropAsync(editor, this.nodeParams, this.cropLimits(), { refIds: snap.refIds });
            const references = prep.references;
            info = prep.info; sel = prep.sel;
            [x, y, w, h] = info.bbox;
            info.keepAlpha = keepAlpha;
            // main names a reference picture by its place in the request: the Original first when it goes
            const original = info.original ? 1 : 0;
            named = this.refPrompt(editor, snap, "edit", { sent: [...Array(original).fill(null), ...snap.refIds] });
        editor.setStatus(`Sending crop ${w} × ${h} at ${x}, ${y} (${info.emitted[0]} × ${info.emitted[1]}${references.length ? `, ${references.length} reference${references.length > 1 ? "s" : ""}` : ""}) to ${label}${info.keepAlpha ? ", transparent background" : ""} ...`);
            const shape = this.layoutShape(editor, { recipe: r, params, original, count: references.length });
            // the boxes (item 28): geometry in fractions of the crop, main writes the model's rows behind the variant's
            // `options.boxes`; only while the document's Boxes switch is on (S3d)
            const preNotes = [];
            const boxes = [];
            const takes = !!(shape.options && typeof shape.options.boxes === "string");
            const sendBoxes = takes && !!editor.genSettings.boxes;
            const held = takes && this.plugins ? this.plugins.countBoxes(editor) : 0;
            if (takes && !sendBoxes && held) preNotes.push(`The document's ${held} box${held === 1 ? "" : "es"} did not go: the Boxes switch under the prompt is off.`);
            const selBounds = sendBoxes && info.has_selection ? editor.selectionBounds() : null;
            // the plugins' boxes (S2): every scumble.generate source, in image pixels, mapped into the crop by the core
            if (sendBoxes && this.plugins) {
                const ctx = this.boxContext(editor, { mode: "edit", recipe: r, provider: shape.provider, model: shape.model, schema: shape.options.boxes, frame: frameOf(info), bounds: selBounds, sent: [...Array(original).fill(null), ...snap.refIds] });
                const got = await this.plugins.boxes(editor, ctx, []);
                boxes.push(...got.boxes);
                preNotes.push(...got.notes);
                // every box that places something, not only the selection's (S3e)
                const small = smallNote(smallBoxes(got.boxes, info.emitted));
                if (small) preNotes.push(small);
            }
            // no source holds a box for the document: the selection goes as one (S1). Boxes the crop left out are no
            // reason for it: the document still holds them
            if (sendBoxes && selBounds && !boxes.length && !held) {
                const b = selectionBox(selBounds, frameOf(info), { prompt: named.prompt, pair: named.pairs[0] || null });
                if (b) {
                    boxes.push(b);
                    if (smallBox(b.rect, info.emitted)) preNotes.push(`The selection is small for a box (under ${SMALL_PX} px a side as sent): the model may not place anything in it.`);
                }
            }
            const request = {
                provider: shape.provider, model: shape.model, kind: shape.kind, fields: shape.fields, options: shape.options,
                prompt: named.prompt, negative: named.negative, seed,
                image: prep.image, mask: prep.mask, maskAlpha: prep.maskAlpha, width: prep.width, height: prep.height, references,
                params: shape.params, original: shape.original, refName: shape.refName, boxes,
                // the preset the crop was widened to (stitch.js planFrame), which FLUX 3 sends as its aspect_ratio
                cropAspect: info.aspect || null,
            };
            res = await providerEdit(request, token);
            editor.lastSentPrompt = res.prompt != null ? res.prompt : request.prompt;
            editor.lastRunNotes = [...preNotes, ...(res.notes || [])];
        } catch (err) {
            this.endRun(editor, token);
            throw err;
        } finally {
            this.endRunRow(token);
        }
        // the document stays held until the result has landed (endRun)
        try {
            // an adapter that knows its answer covers the crop exactly (Magnific's preset shapes, Image Expand) says so
            if (res && res.info && res.info.fit === "stretch") info.fit = "stretch";
            // the answer decoded and stitched in the stitch worker, the region (for a colour match) from the tile workers
            const fin = await finishResultAsync(editor, info, sel, res.bytes, res.mime);
            const { blob, align } = fin;
            const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
            const ref = await this.uploadResult(blob, `n${editor.node.id}_result_${stamp}.png`);
            editor.setStatus(`${label} answered after ${Math.round(res.seconds)} s${res.info && res.info.width ? ` (${res.info.width} × ${res.info.height})` : ""}.`);
            const cutout = info.keepAlpha ? fin.cutout : false;
            await editor.addResults([{ filename: ref.filename, subfolder: ref.subfolder, type: ref.type, x, y, width: w, height: h, align, canvas_node: editor.node.id, provider: r.provider, seed: answeredSeed(res) }]);
            // addResults writes its own line, so the cut-out note, the names the references went as and what the route
            // left out go on afterwards
            if (info.keepAlpha) editor.setStatus(`${editor.status} ${cutout ? "The layer is a cut-out on a transparent ground." : "The model returned no transparency, so the layer is opaque."}`);
            const sentAs = named.pairs.map((p) => {
                const got = (res.refs || []).find((x) => x.ref === p.ref);
                return got ? `${p.label} → ${got.name}` : null;
            }).filter(Boolean);
            if (sentAs.length) editor.setStatus(`${editor.status} Named in the prompt: ${sentAs.join(", ")}.`);
            const sentBoxes = res.boxes > 0 ? Math.floor(res.boxes) : 0;
            editor.lastSentBoxes = sentBoxes;
            if (sentBoxes) editor.setStatus(`${editor.status} Sent with ${sentBoxes} box${sentBoxes === 1 ? "" : "es"}.`);
            if (editor.lastRunNotes.length) editor.setStatus(`${editor.status} ${editor.lastRunNotes.join(" ")}`);
            return { provider: r.provider, seconds: res.seconds, x, y, w, h, transparent: !!info.keepAlpha, cutout, prompt: editor.lastSentPrompt, refs: res.refs || [], pairs: named.pairs, notes: editor.lastRunNotes, info: res.info || null, boxes: sentBoxes };
        } finally {
            this.endRun(editor, token);
        }
    },

    /**
     * The factor a run asks for: null when the model picks its own (Recraft), else `want` held to what the
     * variant offers (its `steps`, or min..max), its default when nothing was asked.
     */
    upscaleFactorFor(r, want) {
        const f = r && r.factor;
        if (!f || f.fixed) return null;
        const n = want == null || want === "" ? f.default : +want;
        if (!Number.isFinite(n)) throw new Error(`"${want}" is no factor.`);
        if (Array.isArray(f.steps) && f.steps.length) {
            if (!f.steps.includes(n)) throw new Error(`${r.name || r.id} upscales by ${f.steps.join(", ")}, not ${n}.`);
            return n;
        }
        if (n < f.min || n > f.max) throw new Error(`${r.name || r.id} upscales by ${f.min} to ${f.max}, not ${n}.`);
        return n;
    },

    /**
     * "" when a ComfyUI upscaler (`r.limits`: `min` the input's short side, `max` its long side, `out` the answer's
     * long side; `picture` the whole picture's long side alone, upscale_model_local's 2048, Q14) takes a w × h picture at
     * `factor` (null: the model picks its own, so `out` is not checked), else the refusal. `what` names the picture:
     * "box" (the selection with its context), "picture" (the whole one) or "sent" (the selection's box as an API
     * upscaler gets it, held to the variant's limits).
     */
    upscaleSizeRefusal(r, w, h, factor, what = "box") {
        const l = (r && r.limits) || {};
        const name = (r && (r.name || r.id)) || "The upscaler";
        const { the, smaller } = upscaleWords(w, h, what);
        if (l.min && Math.min(w, h) < l.min) return `${the}; ${name} needs at least ${l.min} px a side.`;
        const max = what === "picture" && l.picture ? Math.min(l.picture, l.max || Infinity) : l.max;
        if (max && Math.max(w, h) > max) return `${the}; ${name} takes at most ${max} px on the long side. Pick ${smaller}.`;
        return this.upscaleOutRefusal(r, w, h, factor, what);
    },

    /**
     * upscaleSizeRefusal's last rule alone, for an API upscaler (its variant's `limits.out`: RTX Video Super Resolution
     * on Comfy Cloud, 8192; docs/PLAN_0_1_42.md U3), whose input limits the crop is held to instead of refused: "" when
     * the long side of w × h times `factor` stays within `out` (or there is no `out`, or the model picks its factor).
     */
    upscaleOutRefusal(r, w, h, factor, what = "box") {
        const out = r && r.limits && r.limits.out;
        if (!out || factor == null || Math.round(Math.max(w, h) * factor) <= out) return "";
        const { the, smaller } = upscaleWords(w, h, what);
        return `${the}; at ${factor}× the answer would pass ${out} px on the long side. Pick a smaller factor or ${smaller}.`;
    },

    /** The crop an upscale on an API variant (`limits` its EditLimits) would send now: runUpscale's plan (mode "crop"). */
    upscaleFrame(editor, limits) {
        return planFrame(editor, this.nodeParams, limits ? { ...limits, mode: "crop" } : null);
    },

    /**
     * An upscale through the selected upscale recipe (`task: "upscale"`, docs/RECIPES.md "Upscale recipes").
     * `scope` "selection": the selection's box goes out at its own size (no fill, no references) and the larger
     * answer is fitted back into it by the stitch, a result layer like Generate's: a detail pass at the
     * document's resolution. `scope` "document": the base image alone goes out, the answer becomes the new base
     * at its own size, and every layer, mask and the selection are scaled along (`resizeImage` with the new base,
     * one `canvas` undo step); a picture above the variant's `limits.max` is refused, and on either scope a picture
     * whose answer would pass the variant's `limits.out` (upscaleOutRefusal), before anything is sent.
     */
    async runUpscale(editor, opts = {}) {
        const r = this.recipe;
        if (!r || r.kind !== "provider" || r.task !== "upscale") throw new Error("Pick an upscale recipe first (Upscale shows them).");
        if (!editor.base) throw new Error("Load an image first.");
        if (editor.providerPending) throw new Error(RUN_GOING);   // as runProvider
        const scope = opts.scope === "document" ? "document" : "selection";
        const label = r.providerLabel || r.provider;
        const factor = this.upscaleFactorFor(r, opts.factor);
        const max = (r.limits && r.limits.max) || 2048;
        if (scope === "selection" && !(editor.getBounds && editor.getBounds())) throw new Error("Select an area first, or upscale the whole picture.");
        // the whole picture's answer replaces the base: not while a job would land in the old geometry (its resize lets
        // the upscale's own landing through, so the check is here, before anything is paid for)
        const blocked = scope === "document" && editor.turnBlocked ? editor.turnBlocked() : "";
        if (blocked) throw new Error(blocked);
        if (scope === "document" && Math.max(editor.width, editor.height) > max) {
            throw new Error(`The picture is ${editor.width} × ${editor.height}; ${r.name || r.id} on ${label} takes at most ${max} px on the long side. Upscale a selection instead.`);
        }
        // an answer past the variant's cap (limits.out, RTX Video Super Resolution on Comfy Cloud) is refused before anything
        // is paid: the whole picture here, the selection's box once its crop is planned (it is sent held to the limits)
        const over = scope === "document" ? this.upscaleOutRefusal(r, editor.width, editor.height, factor, "picture") : "";
        if (over) throw new Error(over);
        const params = this.providerParams(editor);
        // an upscale sends no reference picture: a token is written as its layer's name, in the request only
        // (the texts of the click's snapshot, or of now, unless the dialog or the command brings its own prompt)
        const texts = r.usesPrompt
            ? this.refPrompt(editor, opts.refs || null, "none", { prompt: opts.prompt != null ? opts.prompt : undefined, who: "Upscale" })
            : { prompt: "", negative: "", note: "" };
        const slow = /topaz/i.test(`${r.id} ${r.model}`) ? " Topaz can take several minutes; the window stays usable."
            : /precision/i.test(r.model || "") && r.provider === "magnific" ? " Magnific Precision can take several minutes; the window stays usable." : "";
        const by = factor ? `${factor}×` : "the model's own factor";
        const token = { provider: r.provider, label, started: Date.now(), editor, runId: runIdOf() };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();
        let res, prep = null, W = editor.width, H = editor.height;
        try {
            const request = {
                provider: r.provider, model: r.model, kind: "upscale", fields: r.fields || null, options: r.options || null,
                factor, params, seed: editor.genSettings.seed,
                // the Upscale dialog's (or the command's) own prompt, else the document's
                prompt: texts.prompt, negative: r.usesPrompt ? texts.negative : "",
                mask: null, maskAlpha: null, references: [],
            };
            if (scope === "selection") {
                // the crop as it is (mode "crop", up to the model's max), without a fill or the reference layers
                prep = await prepareCropAsync(editor, this.nodeParams, { ...r.limits, mode: "crop" }, { crop: { fill: "none", withOriginal: false }, references: false });
                const boxOver = this.upscaleOutRefusal(r, prep.width, prep.height, factor, "sent");
                if (boxOver) throw new Error(boxOver);
                const [x, y, w, h] = prep.info.bbox;
                Object.assign(request, { image: prep.image, width: prep.width, height: prep.height, references: prep.references });
                editor.setStatus(`Upscaling the selection's box ${w} × ${h} at ${x}, ${y} (${prep.width} × ${prep.height} sent) by ${by} on ${label} ...${slow}`);
            } else {
                const c = document.createElement("canvas");
                c.width = W; c.height = H;
                editor.drawBaseInto(c.getContext("2d"), 0, 0, W, H);
                const image = await canvasBytes(c);
                c.width = c.height = 0;
                Object.assign(request, { image, width: W, height: H });
                editor.setStatus(`Upscaling the picture ${W} × ${H} by ${by} on ${label} ...${slow}`);
            }
            res = await providerEdit(request, token);
        } catch (err) {
            this.endRun(editor, token);
            throw err;
        } finally {
            this.endRunRow(token);
        }
        // the document stays held until the answer has landed (endRun); the whole picture's resize lets its own landing
        // through (resizeImageNow's `base`)
        try {
            if (scope === "selection") {
                const info = prep.info;
                const [x, y, w, h] = info.bbox;
                const fin = await finishResultAsync(editor, info, prep.sel, res.bytes, res.mime);
                const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
                const ref = await this.uploadResult(fin.blob, `n${editor.node.id}_upscale_${stamp}.png`);
                await editor.addResults([{ filename: ref.filename, subfolder: ref.subfolder, type: ref.type, x, y, width: w, height: h, align: fin.align, canvas_node: editor.node.id, provider: r.provider, seed: answeredSeed(res) }]);
                const got = res.info && res.info.width ? ` (${res.info.width} × ${res.info.height} came back)` : "";
                editor.setStatus(`${label} upscaled the selection in ${Math.round(res.seconds)} s${got}; it is fitted back into ${w} × ${h} as a new layer.${texts.note ? " " + texts.note : ""}`);
                return { scope, provider: r.provider, recipe: r.id, factor, seconds: res.seconds, x, y, w, h, info: res.info || null, note: texts.note };
            }
            const land = await this.landWholePicture(editor, res.bytes, res.mime, { label, seconds: res.seconds, W, H, note: texts.note });
            return { scope, provider: r.provider, recipe: r.id, factor, seconds: res.seconds, from: [W, H], width: land.width, height: land.height, answered: land.answered, info: res.info || null, note: texts.note };
        } finally {
            this.endRun(editor, token);
        }
    },

    /**
     * The whole picture's answer becomes the document's base (an API upscaler's, runUpscale; a ComfyUI upscaler's,
     * runComfyUpscale): at its own width, stretched to the document's aspect if the model rounded a side, and every
     * layer, mask and the selection scaled along through `resizeImage(nw, nh, { base })`, one `canvas` undo step. The
     * caller holds the document's run slot (providerPending) until this returns: resizeImage's `base` lets this landing
     * through, and nothing else lands in the old geometry meanwhile. `W` × `H` is the picture that went out. Throws on an
     * empty answer, one at the picture's own size, and a resize the editor refused (its status).
     * -> { width, height, answered: [aw, ah] }
     */
    async landWholePicture(editor, bytes, mime, { label, seconds = 0, W, H, note = "" }) {
        const img = await bytesToImage(bytes, mime);
        const aw = img.naturalWidth || img.width, ah = img.naturalHeight || img.height;
        if (!(aw > 0 && ah > 0)) throw new Error(`${label} answered with an empty picture.`);
        const nw = aw, nh = Math.max(1, Math.round(H * aw / W));
        if (nw === W && nh === H) throw new Error(`${label} answered at the picture's own size (${aw} × ${ah}); nothing to do.`);
        const nb = document.createElement("canvas");
        nb.width = nw; nb.height = nh;
        const nctx = nb.getContext("2d");
        nctx.imageSmoothingEnabled = true;
        nctx.imageSmoothingQuality = "high";
        nctx.drawImage(img, 0, 0, nw, nh);
        await editor.resizeImage(nw, nh, { base: nb });
        nb.width = nb.height = 0;
        if (editor.width !== nw || editor.height !== nh) throw new Error(editor.status || "the upscaled picture could not be taken");
        editor.setStatus(`${label} upscaled the picture in ${Math.round(seconds)} s: ${W} × ${H} is now ${nw} × ${nh}, every layer scaled along (Ctrl+Z takes it back).${note ? " " + note : ""}`);
        return { width: nw, height: nh, answered: [aw, ah] };
    },

    /**
     * The whole picture through the selected upscale recipe on the user's ComfyUI (docs/PLAN_0_1_42.md U2): the base
     * alone goes out (drawn at its size, stored in the mirror and on the server, uploadInput), the recipe's graph runs
     * with the canvas node as a loader of that picture (comfyprompt.wholePicturePrompt: the Settings rows and the factor
     * written, a PreviewImage on the result), queued behind the user's jobs (comfyPictureRun), and the answer becomes the
     * new base with every layer, mask and the selection scaled along (landWholePicture, one undo step). Refused before
     * anything is drawn or sent: a graph that reads more than the picture from the canvas node, no connection, node types
     * the server lacks, a document that is busy (turnBlocked), a picture past the recipe's `limits` (the long side `max`,
     * the answer's long side `out` at the factor; an upscale model picks its own factor, so `out` is not checked). The
     * document is busy like a run meanwhile: the title row's timer names the recipe and its Cancel takes the job off the
     * server; closing the tab ends it too and lands nothing. The loader gives RGB: a cut-out picture comes back opaque.
     * `factor`: what the dialog or the command asked (the recipe's default when left out; null for a fixed one);
     * `deadline` (a time in ms, 0 for none): comfyPictureRun's hard end, the upload's too.
     * -> { scope: "document", recipe, factor, seconds, from, width, height, answered } (width null when the tab was closed)
     * @param {any} editor
     * @param {{ factor?: any, deadline?: number }} [opts]
     */
    async runComfyUpscale(editor, { factor: want = undefined, deadline = 0 } = {}) {
        const r = this.recipe;
        if (!r || r.kind === "provider" || r.task !== "upscale" || !r.prompt) throw new Error("Pick an upscale recipe on ComfyUI first (Upscale shows them).");
        if (!editor.base) throw new Error("Load an image first.");
        if (editor.providerPending) throw new Error(RUN_GOING);
        const label = r.name || r.id;
        const shape = comfyprompt.wholePictureRefusal(r);
        if (shape) throw new Error(shape);
        if (!this.connected) throw new Error("Not connected to ComfyUI.");
        const factor = this.upscaleFactorFor(r, want);
        // the classes this route queues: the recipe's own with the loader for the canvas node, and PreviewImage
        const missing = comfyprompt.wholePictureClasses(r).filter((n) => this.objectInfo && !this.objectInfo[n]);
        if (missing.length) throw new Error("The server lacks these node types: " + missing.join(", "));
        // the answer replaces the base: not while a job would land in the old geometry
        const blocked = editor.turnBlocked ? editor.turnBlocked() : "";
        if (blocked) throw new Error(blocked);
        const W = editor.width, H = editor.height;
        const size = this.upscaleSizeRefusal(r, W, H, factor, "picture");
        if (size) throw new Error(size);
        const by = factor != null ? `${factor}×` : "the model's own factor";
        const token = { provider: "comfyui", label, started: Date.now(), editor };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();
        // closing the tab ends the run (its job taken off the server) and lands nothing
        let closed = false;
        const offRemoved = this.on("removed", (e) => { if (e && e.editor === editor) { closed = true; token.cancelled = true; } });
        const gone = () => closed || !this._editors.includes(editor);
        const fail = (err) => {
            const msg = String((err && err.message) || err);
            const text = err && err.kind === "error" && !msg.startsWith(label) ? `${label} failed on your ComfyUI: ${msg}` : msg;
            if (!gone()) editor.setStatus(text);
            return Object.assign(new Error(text), { kind: err && err.kind });
        };
        try {
            let res;
            try {
                editor.setStatus(`Upscaling the picture ${W} × ${H} by ${by} on your ComfyUI (${label}) ...`);
                const c = document.createElement("canvas");
                c.width = W; c.height = H;
                editor.drawBaseInto(c.getContext("2d"), 0, 0, W, H);
                let png;
                try { png = await canvasBytes(c); } finally { c.width = c.height = 0; }
                const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
                // the upload and the server's copy end at a Cancel and at the deadline too (a stalled forward never holds
                // the caller; the request runs on and is ignored, a stray input)
                const upload = this.uploadInput(new Blob([png], { type: "image/png" }), `n${editor.node.id}_upscale_${stamp}.png`);
                png = null;
                const ref = await new Promise((resolve, reject) => {
                    const t0 = Date.now();
                    let iv = null;
                    const done = (fn, v) => { clearInterval(iv); fn(v); };
                    iv = setInterval(() => {
                        if (token.cancelled) done(reject, Object.assign(new Error(`${label} cancelled.`), { kind: "cancelled" }));
                        else if (deadline && Date.now() > deadline) done(reject, Object.assign(new Error(`${label}: your ComfyUI did not take the picture within ${Math.round((Date.now() - t0) / 1000)} s.`), { kind: "timeout" }));
                    }, 250);
                    upload.then((v) => done(resolve, v), (err) => done(reject, err));
                });
                const prompt = comfyprompt.wholePicturePrompt(r, ref, factor, editor.settings);
                res = await this.comfyPictureRun(editor, prompt, comfyprompt.WHOLE_OUTPUT, { label, token, front: false, deadline, timeoutMs: 1800000 });
            } finally {
                // the answer is in (or the run ended): the timer and Cancel leave the title row; the document stays held
                // until the answer has landed (endRun below)
                this.endRunRow(token);
            }
            if (gone()) return { scope: "document", recipe: r.id, factor, seconds: res.seconds, from: [W, H], width: null, height: null, answered: null };
            const land = await this.landWholePicture(editor, res.bytes, res.mime, { label, seconds: res.seconds, W, H, note: "" });
            return { scope: "document", recipe: r.id, factor, seconds: res.seconds, from: [W, H], width: land.width, height: land.height, answered: land.answered };
        } catch (err) {
            if (gone()) return { scope: "document", recipe: r.id, factor, seconds: 0, from: [W, H], width: null, height: null, answered: null };
            throw fail(err);
        } finally {
            offRemoved();
            this.endRun(editor, token);
        }
    },

    /** The Upscale button in the editor's top bar, next to Generate new (the app's, so the node's host needs none). */
    buildUpscaleButton(editor) {
        const top = editor.root && editor.root.querySelector(".ipc-top");
        if (!top || top.querySelector(".ipc-upscale") || !this.shell || !this.shell.openUpscale) return;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ipc-ib ipc-upscale";
        b.title = "Upscale: the selection comes back sharper at the document's resolution, or the whole picture becomes 2, 4 ... times larger with every layer scaled along. Topaz, Clarity, SeedVR2, Recraft and Magnific models, or an upscaler on your own ComfyUI.";
        b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-7 7"/><path d="M10 20H4v-6"/><path d="M4 20l7-7"/></svg><span>Upscale</span>';
        b.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); this.shell.openUpscale(editor); });
        const after = Array.from(top.querySelectorAll(".ipc-ib")).find((x) => /^Generate new/.test(x.title || ""));
        if (after) after.after(b);
        else top.insertBefore(b, top.querySelector(".ipc-grow"));
    },

    /**
     * "Generate new": one call to the provider's text-to-image route, no crop and no mask, and the answer becomes the
     * document's base image. The recipe variant's `text` shape says which model id does that at this provider
     * (docs/RECIPES.md). With `text.refs` the shown reference layers go along (docs/PLAN_REFS.md 26f): each @img token
     * is written as the route's name for its picture ("image 1": there is no crop before them), a variant may send them
     * to another route (`text.refs.model`), and the reference layers stay in the tab over the new base. A variant
     * without it makes pictures from the prompt alone: a token there refuses the run. `opts.refs`: the click's snapshot
     * (refSnapshot), else the references of now; `opts.prompt` / `opts.negative` replace its texts.
     */
    async runGenerate(editor, opts = {}) {
        const r = this.recipe;
        if (!r || r.kind !== "provider") throw new Error("Pick an API recipe first.");
        const t = r.text;
        if (!t || !t.model) throw new Error(`${r.providerLabel || r.provider} cannot make an image from the prompt alone for this model.`);
        const label = r.providerLabel || r.provider;
        // the answer replaces the base: not while a job would land in the picture it replaces
        const blocked = this.generateNewBlocked(editor);
        if (blocked) throw new Error(blocked);
        const width = Math.max(64, Math.round(opts.width || editor.width || 1024));
        const height = Math.max(64, Math.round(opts.height || editor.height || 1024));
        // the prompt and the references of the click; a token that cannot go refuses before anything is sent
        const base = opts.refs || editor.refSnapshot();
        const snap = { ...base, prompt: opts.prompt != null ? String(opts.prompt) : base.prompt, negative: opts.negative != null ? String(opts.negative) : base.negative };
        const takes = !!(this.refTokens && t.refs);
        // a model that sends no picture: the tab's negative (which the dialog neither shows nor sends) gets its tokens
        // written as layer names, as before 26f; only the prompt's tokens refuse
        const neg = takes || !this.refTokens ? null : this.refPrompt(editor, snap, "none", { prompt: "", negative: snap.negative, who: "Generate new" });
        const named = this.refPrompt(editor, neg ? { ...snap, negative: neg.negative } : snap, "edit", { sent: takes ? snap.refIds : null, who: "Generate new" });
        if (!takes && this.refTokens && hasTokens(named.prompt)) {
            throw new Error(`${r.name || r.id} on ${label} makes new images from the prompt alone: take the @img tokens out, or pick a model that takes reference images for a new image (FLUX.2, GPT Image, Nano Banana, Seedream).`);
        }
        const refIds = takes ? snap.refIds : [];
        const tr = t.refs || {};
        const token = { provider: r.provider, label, started: Date.now(), editor, runId: runIdOf() };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();
        const genParams = { ...this.providerParams(editor, opts.background ? { background: opts.background } : null), ...(t.fixed || {}) };
        const cutout = this.wantsTransparent(genParams);
        let res, request, references = [];
        const preNotes = [];
        try {
            // the pixels are read now, before the first await (referenceBytes)
            references = refIds.length ? await referenceBytes(editor, refIds) : [];
            const withRefs = references.length > 0;
            editor.setStatus(`Asking ${label} for a new ${width} × ${height} image${withRefs ? ` with ${references.length} reference image${references.length > 1 ? "s" : ""}` : ""}${cutout ? " on a transparent ground" : ""} ...`);
            const model = (withRefs && tr.model) || t.model;
            // the text route's own options where it has them (a Comfy Cloud recipe's text-to-image graph, item 35 V6),
            // else the variant's
            const own = t.options || r.options || null;
            const options = withRefs && tr.options ? { ...(own || {}), ...tr.options } : own;
            // the plugins' boxes (item 28 S2) when the variant takes them and the document's Boxes switch is on (S3d): a
            // new image has no selection, so the boxes come from scumble.generate sources alone, drawn on the document
            // (the frame; the new image is made at the requested size, so the fractions carry over, stretched when the
            // aspect differs)
            let boxes = [];
            const takes = !!(options && typeof options.boxes === "string");
            const held = takes && this.plugins ? this.plugins.countBoxes(editor) : 0;
            if (takes && !editor.genSettings.boxes && held) preNotes.push(`The document's ${held} box${held === 1 ? "" : "es"} did not go: the Boxes switch under the prompt is off.`);
            if (takes && editor.genSettings.boxes && this.plugins) {
                const frame = { x: 0, y: 0, w: editor.width || width, h: editor.height || height };
                const got = await this.plugins.boxes(editor, this.boxContext(editor, { mode: "new", recipe: r, provider: r.provider, model, schema: options.boxes, frame, bounds: null, sent: refIds }), []);
                boxes = got.boxes;
                preNotes.push(...got.notes);
                const small = smallNote(smallBoxes(got.boxes, [width, height]));
                if (small) preNotes.push(small);
            }
            request = {
                provider: r.provider, model, kind: "text",
                prompt: named.prompt, negative: named.negative,
                seed: opts.seed != null ? opts.seed : editor.genSettings.seed,
                width, height, aspect: opts.aspect || null,
                image: null, mask: null, maskAlpha: null, references, original: 0,
                refName: tr.name || (r.refs && r.refs.name) || null, refsMax: withRefs ? tr.max || null : null,
                fields: r.fields || null, options,
                params: genParams,
                boxes,
            };
            res = await providerEdit(request, token);
        } catch (err) {
            this.endRun(editor, token);
            throw err;
        } finally {
            this.endRunRow(token);
        }
        // the document stays held until the new base is in (endRun)
        let c, swap;
        try {
            const img = await bytesToImage(res.bytes, res.mime);
            c = document.createElement("canvas");
            c.width = img.naturalWidth || img.width;
            c.height = img.naturalHeight || img.height;
            c.getContext("2d").drawImage(img, 0, 0);
            // the reference layers stay (they name what the prompt refers to), every other layer goes with the old base
            swap = await editor.setBaseFromCanvas(c, { keepRefs: true });
        } finally {
            this.endRun(editor, token);
        }
        const gotAlpha = cutout && transparentPixels(c);
        const notes = [...preNotes, ...(res.notes || [])];
        const sentAs = named.pairs.map((p) => {
            const got = (res.refs || []).find((x) => x.ref === p.ref);
            return got ? `${p.label} → ${got.name}` : null;
        }).filter(Boolean);
        const kept = swap && swap.kept ? swap.kept : 0, dropped = swap && swap.dropped ? swap.dropped : 0;
        const stay = kept ? ` The reference layer${kept > 1 ? "s stay" : " stays"}${dropped ? `, ${dropped} other layer${dropped > 1 ? "s were" : " was"} replaced` : ""}.` : "";
        const sentBoxes = res.boxes > 0 ? Math.floor(res.boxes) : 0;
        editor.setStatus(`${label} answered after ${Math.round(res.seconds)} s: a new ${c.width} × ${c.height} base image${cutout ? (gotAlpha ? " with a transparent background" : " (the model returned no transparency)") : ""}.${sentAs.length ? ` Named in the prompt: ${sentAs.join(", ")}.` : ""}${sentBoxes ? ` Sent with ${sentBoxes} box${sentBoxes === 1 ? "" : "es"}.` : ""}${stay}${notes.length ? " " + notes.join(" ") : ""}`);
        const labels = snap.labels;
        return {
            provider: r.provider, model: request.model, seconds: res.seconds, width: c.width, height: c.height, transparent: !!gotAlpha,
            prompt: res.prompt != null ? res.prompt : named.prompt, note: notes.join(" "), notes, info: res.info || null, boxes: sentBoxes,
            references: refIds.map((id, i) => {
                const got = (res.refs || []).find((x) => x.ref === i);
                return { label: "img" + labels.get(id), id, sentAs: got ? got.name : null };
            }),
            kept, dropped,
        };
    },

    // ---- prompt instruction templates (electron/main/prompts.js) -------------------

    promptTemplates: [],          // [{ id, name, description, use, for, body, source }]
    promptTemplateIds: { upsample: "", generate: "" },   // "" = the built-in rule

    // ---- brush tips: one library for every tab, stored as PNGs by electron/main/brushes.js ------
    brushLibrary: [],       // { id, name, canvas, spacing, source, saved } - the editors' brushTips array itself

    /** Load the stored tips into the shared library (once, at start). */
    async loadBrushTips() {
        if (!window.scumble || !window.scumble.brushes) return this.brushLibrary;
        let stored = [];
        try { stored = await window.scumble.brushes.list(); } catch (err) { console.warn("brush tips not loaded", err); return this.brushLibrary; }
        for (const t of stored) {
            try {
                const img = await new Promise((resolve, reject) => {
                    const url = URL.createObjectURL(new Blob([t.png], { type: "image/png" }));
                    const im = new Image();
                    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
                    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad tip file " + t.id)); };
                    im.src = url;
                });
                const c = document.createElement("canvas");
                c.width = img.naturalWidth; c.height = img.naturalHeight;
                c.getContext("2d").drawImage(img, 0, 0);
                this.brushLibrary.push({ id: t.id, name: t.name, canvas: c, spacing: t.spacing || 0, source: t.source || "", saved: true });
            } catch (err) { console.warn(err); }
        }
        for (const ed of this._editors) this.syncBrushTips(ed);
        return this.brushLibrary;
    },

    /** Hand an editor the shared library and the save hook (called for every new tab). */
    attachBrushTips(editor) {
        editor.brushTips = this.brushLibrary;
        editor.onBrushTips = () => this.saveBrushTips(editor);
        this.syncBrushTips(editor);
    },

    syncBrushTips(editor) {
        if (editor.brushTips !== this.brushLibrary) editor.brushTips = this.brushLibrary;
        if (editor.renderBrushTips) editor.renderBrushTips();
        if (editor.syncTipControls) editor.syncTipControls();
    },

    /** Persist the library (new tips as PNG, the index always) and refresh the other tabs' selects. */
    async saveBrushTips(from) {
        if (!window.scumble || !window.scumble.brushes) return null;
        const tips = [];
        for (const t of this.brushLibrary) {
            let png = null;
            if (!t.saved) {
                const blob = await new Promise((resolve) => t.canvas.toBlob(resolve, "image/png"));
                png = new Uint8Array(await blob.arrayBuffer());
            }
            tips.push({ id: t.id, name: t.name, spacing: t.spacing || 0, source: t.source || "", png });
        }
        const r = await window.scumble.brushes.save(tips);
        for (const t of this.brushLibrary) t.saved = true;
        for (const ed of this._editors) if (ed !== from) this.syncBrushTips(ed);
        return r;
    },

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

    /**
     * Fill the placeholders; the output rule is the app's, never the template's. `ctx.references`: the references the
     * prompt names (`[{ id, n, name }]`, docs/PLAN_REFS.md 26d1); with any, the token rule follows the output rule, and a
     * template without `{references}` gets the names there too.
     */
    fillPromptTemplate(tpl, ctx) {
        const refs = ctx.references || [];
        const values = {
            prompt: ctx.prompt || "", model: (this.recipe && (this.recipe.model || this.recipe.name)) || "",
            aspect: ctx.aspect || "", width: ctx.width || "", height: ctx.height || "",
            usecase: ctx.useCase || "", useCase: ctx.useCase || "", region: ctx.region || "the whole image",
            hint: ctx.hint ? ` It currently shows: ${ctx.hint}.` : "",
            references: referencesText(refs),
        };
        const src = String(tpl.body || "");
        const body = src.replace(/\{(\w+)\}/g, (all, k) => (values[k] !== undefined ? String(values[k]) : all));
        const own = refs.length ? "\n\n" + (/\{references\}/.test(src) ? "" : referencesText(refs).trim() + " ") + referencesRule(refs) : "";
        return `${body}\n\nOutput only the prompt text: no preamble, no quotes, no headings, no explanation.${own}`;
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

    /** The title row's Cancel: stop waiting for every API run in progress (main aborts them; each says so in its tab). */
    cancelProviderRuns() {
        const runs = Array.from(this._providerRuns);
        for (const t of runs) t.cancelled = true;
        for (const t of runs) if (t.runId && window.scumble && window.scumble.providers && window.scumble.providers.cancel) window.scumble.providers.cancel(t.runId).catch(() => {});
        return runs.length;
    },

    /** A run's answer is in (or it failed): its timer and Cancel leave the title row. */
    endRunRow(token) {
        if (this._providerRuns.delete(token)) this.notifyProviderRuns();
    },

    /**
     * A run is over: the document's slot (`providerPending`) is given back. An API run holds it past its answer until
     * the result has landed, so a second run, a turn or a Realism Pass started meanwhile does not read or land in the
     * picture before it.
     */
    endRun(editor, token) {
        if (editor.providerPending === token) editor.providerPending = null;
        this.endRunRow(token);
    },

    /**
     * Why Generate new cannot replace the document's picture now (a job would land in the picture it replaces), or "".
     * The API route (runGenerate) and the local one (the generate_new command, before its newCanvas) both ask it.
     */
    generateNewBlocked(editor) {
        if (editor._localRuns && editor._localRuns.size) return "A render on your ComfyUI is still running: its result would land in the picture Generate new replaces. Try again when it is in.";
        if (editor.providerPending || editor.segmentPending || editor.cutoutPending || editor.objectsPending || editor._pointPending || editor._loading || editor._docSaving) {
            return "Wait for the running job to finish: it would land in the picture Generate new replaces.";
        }
        return "";
    },

    notifyProviderRuns() {
        if (this.onProviderRuns) { try { this.onProviderRuns(Array.from(this._providerRuns)); } catch (err) { console.warn(err); } }
    },

    // ---- a picture in, a picture out on the user's ComfyUI (docs/PLAN_0_1_42.md R2a; the pass, U2's upscale) ----

    /** The mirror's ensure behind a host member: a gate stubs it (window.scumble is read-only from the page). */
    async ensureRefs(refs) {
        return window.scumble.comfy.ensure(refs);
    },

    /**
     * Store a picture in the mirror's input folder and make sure the server holds it: the mirror's forward can fail with
     * a warning only, so the ensure is not optional. -> { filename, subfolder, type: "input" }
     */
    async uploadInput(blob, filename) {
        const form = new FormData();
        form.append("image", new File([blob], filename, { type: "image/png" }));
        form.append("subfolder", SUBFOLDER);
        form.append("type", "input");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
        if (resp.status !== 200) throw new Error("storing the picture failed (" + resp.status + ")");
        const data = await resp.json();
        const ref = { filename: data.name, subfolder: data.subfolder || SUBFOLDER, type: "input" };
        let report;
        try { report = await this.ensureRefs([ref]); } catch (err) { throw new Error(`Your ComfyUI did not take the picture: ${String((err && err.message) || err)}`); }
        if (report && report.missing && report.missing.length) throw new Error("Your ComfyUI did not take the picture.");
        return ref;
    },

    // prompt id -> { editor, output, label, answer(image), ended(), fail(kind, message, extra) } of each picture run
    _pictureRuns: new Map(),
    // the ids of picture runs that ended (answered, failed, cancelled, lost): their late events are swallowed, so a pass
    // error of a run Scumble gave up on never lands in a tab's status (the newest 64)
    _endedPictureRuns: new Set(),

    /**
     * Run an API-format prompt that answers one picture and wait for it: `output` is the node whose first image is the
     * answer. Queued at the front (`front`), as the helpers are; never interrupts a running job of the user's. The id
     * counts as an open render of `editor` (a turn of the picture and Generate new wait for it). The wait ends on the
     * node's `executed`, on `execution_success` (the answer read from /history), on an error or interrupt, on the
     * timeout and on `token.cancelled` (both take the job off the server, cancelComfyPrompt, before the call rejects),
     * and when the server is disconnected or another server is connected ("connecting", a re-Connect, is a pause). The
     * timeout counts the time the job is not waiting in the queue: a wait behind the user's jobs, shown with its position
     * from /queue every 2 s, does not use it up. A job that is neither queued nor running twice in a row is read from
     * /history (the socket missed its events), or ends as "dropped". `deadline` (a time in ms, 0 for none) is a hard end
     * that counts the queue's wait too: a command's own timeout (realism_pass, R3b), so an agent's call answers before its
     * bridge gives up. Rejects with an Error whose `kind` is "error" (the server's message, `nodeType`), "interrupted", "timeout",
     * "cancelled", "lost" or "dropped".
     * -> { bytes, mime, seconds, promptId }
     */
    async comfyPictureRun(editor, prompt, output, { label = "ComfyUI", token = null, timeoutMs = 300000, front = true, deadline = 0 } = {}) {
        const stop = (kind, message, extra) => Object.assign(new Error(message), { kind }, extra || {});
        if (token && token.cancelled) throw stop("cancelled", `${label} cancelled.`);
        const t0 = Date.now();
        const url0 = (this.server && this.server.url) || "";
        let queued;
        try {
            queued = await api.queuePrompt(front ? -1 : 0, { output: prompt, workflow: { nodes: [], links: [], version: 0.4, extra: { inpaint_canvas_helper: true } } });
        } catch (err) {
            throw stop("error", String((err && err.message) || err));
        }
        const id = queued && queued.prompt_id;
        if (!id) throw stop("error", `${label}: your ComfyUI gave the job no id.`);
        const runs = editor ? (editor._localRuns || (editor._localRuns = new Set())) : null;
        if (runs) runs.add(id);
        let entry = null;
        const interrupted = `${label} was interrupted on your ComfyUI.`;
        // what /history says about a job that ended without an `executed` for `output`
        const fromHistory = (got) => {
            if (got.image) entry.answer(got.image);
            else if (got.interrupted) entry.fail("interrupted", interrupted);
            else if (got.error) entry.fail("error", got.error.message, { nodeType: got.error.nodeType });
            else if (got.found) entry.fail("error", `${label}: your ComfyUI finished without a picture.`);
            else return false;
            return true;
        };
        const wait = new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
            entry = {
                editor, output, label, interrupted,
                get settled() { return settled; },
                answer: (image) => settle(resolve, image),
                fail: (kind, message, extra) => settle(reject, stop(kind, message, extra)),
                // the prompt ended: its answer from /history, when no `executed` brought it (another server may not
                // re-send one for a cached output)
                ended: async () => {
                    if (settled) return;
                    try {
                        if (!fromHistory(await this.pictureFromHistory(id, output))) entry.fail("error", `${label}: your ComfyUI finished without a picture.`);
                    } catch (err) {
                        entry.fail("error", `${label}: the answer could not be read from your ComfyUI (${String((err && err.message) || err)}).`);
                    }
                },
            };
        });
        this._pictureRuns.set(id, entry);
        // the timeout's clock: reset whenever /queue shows the job still pending
        let clock = t0, lastQueue = t0, polling = false, gone = 0, shown = "", cleanup = null, timer = null;
        // a cancel or the timeout ends the wait at once; the job goes off the server meanwhile, awaited before the call
        // rejects (at most 5 s), so a stalled request never holds the Cancel
        const giveUp = (kind, message) => {
            cleanup = this.cancelComfyPrompt(id).catch((err) => console.warn("picture run cancel", err));
            entry.fail(kind, message);
        };
        const poll = async () => {
            // the position; no answer (no server under --no-comfy) shows none and does not end the wait
            const q = await this.queuePosition(id);
            if (!q || entry.settled) return;
            if (q.running || q.pending) {
                gone = 0;
                if (q.pending) clock = Date.now();
                const text = q.running ? `${label} runs on your ComfyUI ...` : `${label} waits for your ComfyUI (${q.ahead} job${q.ahead === 1 ? "" : "s"} ahead) ...`;
                if (text !== shown && editor && editor.setStatus) { shown = text; editor.setStatus(text); }
                return;
            }
            if (++gone < 2) return;
            // neither queued nor running twice: it ended while the socket was away, or someone cleared the queue; a
            // /history that does not answer is asked again at the next poll
            let got;
            try { got = await this.pictureFromHistory(id, output); } catch (_) { gone = 1; return; }
            if (!entry.settled && !fromHistory(got)) entry.fail("dropped", `${label}: your ComfyUI no longer holds its job (was the queue cleared?).`);
        };
        const tick = () => {
            if (entry.settled) return;
            const s = this.server || { state: "", url: "" };
            if (s.state === "disconnected" || s.state === "error" || (url0 && s.url && s.url !== url0)) {
                // the job stays on that server; taken off in the background in case it is still reachable
                this.cancelComfyPrompt(id).catch(() => { /* unreachable */ });
                entry.fail("lost", `${label}: the connection to your ComfyUI was lost.`);
                return;
            }
            if (token && token.cancelled) { giveUp("cancelled", `${label} cancelled.`); return; }
            if (Date.now() - clock > timeoutMs) { giveUp("timeout", `${label}: no answer from your ComfyUI within ${Math.round(timeoutMs / 1000)} s; its job was taken off the queue.`); return; }
            if (deadline && Date.now() > deadline) { giveUp("timeout", `${label}: no answer from your ComfyUI within ${Math.round((Date.now() - t0) / 1000)} s; its job was taken off the queue.`); return; }
            if (polling || Date.now() - lastQueue < 2000) return;
            lastQueue = Date.now();
            polling = true;
            poll().catch((err) => console.warn("picture run", err)).finally(() => { polling = false; });
        };
        try {
            timer = setInterval(tick, 250);
            const image = await wait;
            const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" });
            const r = await api.fetchApi("/view?" + q.toString(), { signal: AbortSignal.timeout(Math.max(60000, timeoutMs)) });
            if (r.status !== 200) throw stop("error", `${label}: the answer could not be fetched from your ComfyUI (${r.status}).`);
            const bytes = new Uint8Array(await r.arrayBuffer());
            const mime = (r.headers.get("Content-Type") || "image/png").split(";")[0].trim() || "image/png";
            return { bytes, mime, seconds: (Date.now() - t0) / 1000, promptId: id };
        } finally {
            clearInterval(timer);
            this._pictureRuns.delete(id);
            this._endedPictureRuns.add(id);
            for (const old of this._endedPictureRuns) { if (this._endedPictureRuns.size <= 64) break; this._endedPictureRuns.delete(old); }
            if (runs) runs.delete(id);
            if (cleanup) await Promise.race([cleanup, new Promise((r) => setTimeout(r, 5000))]);
        }
    },

    /**
     * A server event for a picture run (the listeners below): true when `detail` belongs to one, which then answers, or
     * to one that ended (its late events go nowhere).
     */
    pictureRunEvent(type, detail) {
        const id = detail && detail.prompt_id;
        const e = id ? this._pictureRuns.get(id) : null;
        if (!e) return !!id && this._endedPictureRuns.has(id);
        if (type === "executed") {
            const images = detail.output && detail.output.images;
            if ((detail.node === e.output || detail.display_node === e.output) && Array.isArray(images) && images[0]) e.answer(images[0]);
        } else if (type === "success") e.ended();
        else if (type === "error") e.fail("error", detail.exception_message || "execution failed", { nodeType: detail.node_type || "" });
        else if (type === "interrupted") e.fail("interrupted", e.interrupted);
        return true;
    },

    /**
     * Where prompt `id` stands in ComfyUI's /queue: { running, pending, ahead }, or null when /queue gave no answer.
     * The pending list is the server's heap, not sorted: the jobs ahead are those with a smaller number.
     */
    async queuePosition(id) {
        let q;
        try {
            const r = await api.fetchApi("/queue", { signal: AbortSignal.timeout(15000) });
            if (r.status !== 200) return null;
            q = await r.json();
        } catch (_) { return null; }
        const running = Array.isArray(q && q.queue_running) ? q.queue_running : [];
        const pending = Array.isArray(q && q.queue_pending) ? q.queue_pending : [];
        if (running.some((it) => Array.isArray(it) && it[1] === id)) return { running: true, pending: false, ahead: 0 };
        const mine = pending.find((it) => Array.isArray(it) && it[1] === id);
        if (!mine) return { running: false, pending: false, ahead: 0 };
        const ahead = running.length + pending.filter((it) => Array.isArray(it) && it[1] !== id && +it[0] < +mine[0]).length;
        return { running: false, pending: true, ahead };
    },

    /**
     * Prompt `id` in /history: { found, image } (the first image of `output`), { found, interrupted }, or
     * { found, error: { message, nodeType } }; throws when /history does not answer.
     * @returns {Promise<{ found: boolean, image?: any, interrupted?: boolean, error?: { message: string, nodeType: string } | null }>}
     */
    async pictureFromHistory(id, output) {
        const r = await api.fetchApi("/history/" + encodeURIComponent(id), { signal: AbortSignal.timeout(15000) });
        if (r.status !== 200) throw new Error("/history answered " + r.status);
        const all = await r.json();
        const h = all && all[id];
        if (!h) return { found: false };
        const images = h.outputs && h.outputs[output] && h.outputs[output].images;
        if (Array.isArray(images) && images[0]) return { found: true, image: images[0] };
        const msgs = (h.status && h.status.messages) || [];
        const err = msgs.find((m) => Array.isArray(m) && m[0] === "execution_error");
        if (err) return { found: true, error: { message: (err[1] && err[1].exception_message) || "execution failed", nodeType: (err[1] && err[1].node_type) || "" } };
        if (msgs.some((m) => Array.isArray(m) && m[0] === "execution_interrupted")) return { found: true, interrupted: true };
        return { found: true };
    },

    /**
     * Take Scumble's own prompt `id` off ComfyUI, never another job. A current server cancels it by id in one step
     * (POST /api/jobs/<id>/cancel: dequeued if pending, interrupted only while it is the running one, atomically). An
     * older one: deleted from the queue, then interrupted by its id only when /queue shows it running and the server is
     * 0.3.57 or later (before that /interrupt ignored the id and stopped whatever ran; the short job then finishes on its
     * own). Never a bare /interrupt. -> whether a running job was interrupted (or the server cancelled it)
     */
    async cancelComfyPrompt(id) {
        if (!id) return false;
        const post = (path, body) => api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        try {
            const r = await post("/api/jobs/" + encodeURIComponent(id) + "/cancel", {});
            if (r.status === 200) {
                let d = null;
                try { d = await r.json(); } catch (_) { d = null; }
                return !!(d && d.cancelled);
            }
            if (r.status !== 404 && r.status !== 405) console.warn("job cancel answered", r.status);
        } catch (err) { console.warn("job cancel", err); }
        try { await post("/queue", { delete: [id] }); } catch (err) { console.warn("queue delete", err); }
        if (!realism.versionAtLeast((this.server && this.server.version) || "", "0.3.57")) return false;
        const q = await this.queuePosition(id);
        if (!q || !q.running) return false;
        try { await post("/interrupt", { prompt_id: id }); } catch (err) { console.warn("interrupt", err); }
        return true;
    },

    /** Write settings.realism whole (settings.set() stores a top-level key as given): the filled values with `patch`. */
    async setRealismValues(patch) {
        const next = realism.fillValues({ ...this.realismValues(), ...(patch || {}) });
        this.realismStored = next;
        this.emit("realism");
        try { await window.scumble.settings.set({ realism: next }); } catch (err) { console.warn("settings.realism not saved", err); }
        return next;
    },

    /**
     * The Realism Pass on a picture (docs/PLAN_0_1_42.md R2a; the whole picture's, realismWhole): `bytes` (any picture the
     * window decodes) through DLSS 5 on the user's ComfyUI at 1x, with settings.realism's Style, Strength and model
     * preset. An odd side is padded by repeating the last column or row and the answer cropped back; a picture with
     * transparency goes flattened onto mid-grey and gets its alpha back. A refused model preset makes settings.realism
     * use Default from then on and tries once more. `deadline` (ms, 0 for none): comfyPictureRun's hard end, the upload's
     * too. Throws an Error whose `hint` is the sentence (§3.4, §3.5) and whose `unsupported` says the server cannot run
     * the pass at all.
     * `factor` (R-U; the dialog's 1, 1.5, 1.7, 2 or 3): above 1 the pack's mode of that factor (realism.MODES), the answer
     * not cropped back but kept larger (only the padding's share comes off), the alpha scaled with it; a picture whose
     * output would pass 7680 × 4320 or 30.4 MP is scaled down first (realism.fitPlan, the browser's high-quality resampling, as the
     * editor's Resize scales), and the note says so. 1 keeps the refusal past the cap.
     * -> { bytes, mime: "image/png", width, height, seconds, note, factor, sent: [w, h], scaled: [w, h] | null }
     */
    async passPicture(editor, bytes, mime, { token = null, deadline = 0, factor = 1 } = {}) {
        const L = realism.LABEL;
        const fail = (text, extra) => Object.assign(new Error(text), { hint: text }, extra || {});
        const support = this.realismSupport();
        if (!support.ok) throw fail(support.reason, { unsupported: true });
        if (token && token.cancelled) throw fail(`${L} cancelled.`, { kind: "cancelled" });
        const mode = realism.modeFor(factor);
        if (!mode) throw fail(realism.factorRefusal(factor));
        const up = mode.factor > 1;
        let img;
        try { img = await bytesToImage(bytes, mime); } catch (_) { throw fail(`${L}: the picture could not be decoded.`); }
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!(w > 0 && h > 0)) throw fail(`${L}: the picture is empty.`);
        // what goes: the picture at its own size padded to even sides, or (above 1×, past the cap) scaled down first
        const plan = realism.fitPlan(w, h, mode.factor);
        if (plan.refusal) throw fail(plan.refusal);
        const [fw, fh] = plan.fit, [w2, h2] = plan.sent;
        // the one readback of the source (the acceleration-latch trap): its alpha is reused for the answer
        const c = document.createElement("canvas");
        c.width = fw; c.height = fh;
        const cx = c.getContext("2d", { willReadFrequently: true });
        if (plan.scaled) {
            cx.imageSmoothingEnabled = true;
            cx.imageSmoothingQuality = "high";
            cx.drawImage(img, 0, 0, fw, fh);
        } else {
            cx.imageSmoothingEnabled = false;
            cx.drawImage(img, 0, 0);
        }
        const source = cx.getImageData(0, 0, fw, fh).data;
        const keepAlpha = realism.hasAlpha(source);
        const prep = realism.prepPixels(source, fw, fh, keepAlpha);
        c.width = w2; c.height = h2;
        cx.putImageData(new ImageData(prep.data, w2, h2), 0, 0);
        const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
        let values = this.realismValues();
        // the upload and the server's copy of it end at a Cancel and at the timeout too: a stalled forward to the server
        // never holds the caller. The request runs on and is ignored (a stray input)
        const upload = this.uploadInput(new Blob([await canvasBytes(c)], { type: "image/png" }), `n${editor ? editor.node.id : 0}_pass_${stamp}.png`);
        c.width = c.height = 0;
        const ref = await new Promise((resolve, reject) => {
            const t0 = Date.now(), end = Math.min(t0 + values.timeout * 1000, deadline || Infinity);
            let iv = null;
            const done = (fn, v) => { clearInterval(iv); fn(v); };
            iv = setInterval(() => {
                if (token && token.cancelled) done(reject, fail(`${L} cancelled.`, { kind: "cancelled" }));
                else if (Date.now() > end) done(reject, fail(`${L}: your ComfyUI did not take the picture within ${Math.round((Date.now() - t0) / 1000)} s.`, { kind: "timeout" }));
            }, 250);
            upload.then((v) => done(resolve, v), (err) => done(reject, err));
        });
        const notes = [];
        if (support.note) notes.push(support.note);
        if (plan.scaled) notes.push(realism.scaledDownNote(fw, fh));
        let res = null, fellBack = "";
        while (!res) {
            const prompt = realism.passPrompt(this.realismRecipe(), values, ref, mode.label);
            try {
                res = await this.comfyPictureRun(editor, prompt, realism.PASS_OUTPUT, { label: L, token, timeoutMs: values.timeout * 1000, deadline });
            } catch (err) {
                // the runtime refused the asked model preset: Default from now on, and once more with it (a refusal of
                // Default ends it). The recipe's own DLSS model preset row is not settings.realism and stays as it is
                if (err && err.kind === "error" && realism.isPresetRefusal(err.message) && values.preset !== "Default") {
                    fellBack = realism.presetFallbackNote(values.preset);
                    values = await this.setRealismValues({ preset: "Default" });
                    notes.push(fellBack);
                    if (editor && editor.setStatus) editor.setStatus(fellBack);
                    continue;
                }
                // a failure after the fallback still says that settings.realism changed
                const text = realism.runFailure(err);
                throw fail(fellBack ? `${text} ${fellBack}` : text, { kind: (err && err.kind) || "error" });
            }
        }
        // the answer cropped back to w × h at 0, 0 (1×), or above 1× to the part that is the picture (the padding's
        // share off, the answer's own scale kept); with transparency the source's alpha written back, scaled with it
        let out;
        try { img = await bytesToImage(res.bytes, res.mime); } catch (_) { throw fail(`${L}: your ComfyUI's answer could not be decoded.`); }
        const aw = img.naturalWidth || img.width, ah = img.naturalHeight || img.height;
        if (!up && (aw < w || ah < h)) throw fail(`${L}: your ComfyUI answered ${aw} × ${ah} for a picture of ${w} × ${h}.`);
        if (up && (aw <= w2 || ah <= h2)) throw fail(`${L}: your ComfyUI answered ${aw} × ${ah} for a picture of ${w2} × ${h2} at ${mode.text}.`);
        const kw = up ? Math.round(fw * aw / w2) : w, kh = up ? Math.round(fh * ah / h2) : h;
        if (!keepAlpha && aw === kw && ah === kh) out = res.bytes;
        else {
            c.width = kw; c.height = kh;
            cx.imageSmoothingEnabled = false;
            cx.drawImage(img, 0, 0, kw, kh, 0, 0, kw, kh);
            if (keepAlpha) {
                const answer = cx.getImageData(0, 0, kw, kh).data;
                const alpha = up ? realism.scaleAlpha(source, fw, fh, kw, kh) : source;
                cx.putImageData(new ImageData(realism.putAlphaBack(answer, kw, kh, alpha, kw, kh), kw, kh), 0, 0);
            }
            out = await canvasBytes(c);
            c.width = c.height = 0;
        }
        return {
            bytes: out, mime: out === res.bytes ? res.mime : "image/png", width: kw, height: kh, seconds: res.seconds, note: notes.join(" "),
            factor: mode.factor, sent: [w2, h2], scaled: plan.scaled ? [fw, fh] : null,
        };
    },

    /**
     * "" when realismWhole would start on this document now, else the sentence it refuses with, before anything is read
     * or sent: the server, a run going on the document (an API run, the pass, a local render still on the server), the
     * document still loading, no picture, past 7680 × 4320 or 30.4 MP (the size before anything is read: a 15k document is refused
     * without its flatten). `status`'s realism answers from it too, so an agent is never told ready for a refused pass.
     * `factor` (R-U): a factor no mode has first; above 1× the document is resized when the answer lands, so not while
     * a job would land where the picture was (turnBlocked, as for an upscale of the whole picture), and the size is
     * realism.fitPlan's (a picture past the cap is scaled down instead; a fit under 64 px, or one that would not get
     * larger, is refused). `status` asks at 1×.
     */
    realismWholeRefusal(editor, { factor = 1 } = {}) {
        const L = realism.LABEL;
        const mode = realism.modeFor(factor);
        if (!mode) return realism.factorRefusal(factor);
        const support = this.realismSupport();
        if (!support.ok) return support.reason;
        if (editor.providerPending || (editor._localRuns && editor._localRuns.size)) return `${L}: a run is still going on this document.`;
        if (editor._loading) return `${L}: the document is still loading.`;
        if (!editor.base || !editor.width || !editor.height) return `${L}: load an image first.`;
        if (mode.factor === 1) return realism.wholeRefusal(editor.width, editor.height);
        const blocked = editor.turnBlocked ? editor.turnBlocked() : "";
        if (blocked) return `${L}: ${blocked}`;
        return realism.fitPlan(editor.width, editor.height, mode.factor).refusal;
    },

    /**
     * The Realism Pass over the whole picture (docs/PLAN_0_1_42.md R3a; the Upscale dialog's entry and the realism_pass
     * command call it, R3b): the visible composite as a run sees it (every visible layer with its filters and blend
     * modes, without reference and control layers) up to the top run of filter layers goes once, at its own size,
     * through DLSS 5 at 1x on the user's ComfyUI (passPicture) and lands as a new layer named the label: full size at
     * 0, 0, no colour match, under that run of filters, one undo step. A second run reads an earlier pass layer with the
     * rest and stacks its layer above it. Busy like a run while it works: the title row's timer names it and its Cancel
     * ends it; closing the tab ends it too and adds nothing. Refused before anything is read or sent (the server, a run
     * going on the document, no picture, the size); a failure adds nothing. Each sentence is the status and the thrown
     * Error's message. `deadline` (a time in ms, 0 for none): comfyPictureRun's hard end, the queue's wait included.
     * `factor` (R-U, docs/PLAN_0_1_42.md Q29): above 1 (1.5, 1.7, 2, 3) the document becomes that many times larger
     * (the base and every layer, mask and the selection scaled as Resize scales them) and the pass, at the pack's mode
     * of that factor, lands on top of it as the same new layer at the new size, both in one undo step; a picture whose
     * output would pass 7680 × 4320 or 30.4 MP (realism.MAX_AREA, measured) is scaled down before it goes, so the answer,
     * and the document, come back as large as the pass allows. The landing goes through resizeImage's `base` path while the run slot is held.
     * -> { layer, seconds, note, changed, factor, from: [W, H], width, height } (layer null when the tab was closed
     *    meanwhile)
     */
    async realismWhole(editor, { deadline = 0, factor = 1 } = {}) {
        const L = realism.LABEL;
        const say = (text) => { editor.setStatus(text); return new Error(text); };
        const refusal = this.realismWholeRefusal(editor, { factor });
        if (refusal) throw say(refusal);
        const W = editor.width, H = editor.height;
        const mode = realism.modeFor(factor);
        const up = mode.factor > 1;
        const plan = up ? realism.fitPlan(W, H, mode.factor) : null;
        const token = { provider: "comfyui", label: L, started: Date.now(), editor };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();
        // closing the tab ends the pass (its job taken off the server) and lands nothing
        let closed = false;
        const offRemoved = this.on("removed", (e) => { if (e && e.editor === editor) { closed = true; token.cancelled = true; } });
        const gone = () => closed || !this._editors.includes(editor);
        const isFill = (l) => editor.isFillLayer(l);
        // what a run leaves out (references, control layers) and what it does not draw (a hidden layer, a rejected
        // result on top): passed over, so a film look under them still counts as the top run of filters
        const skip = (l) => editor.isReference(l) || editor.isControl(l) || (l.kind !== "filter" && !l.visible);
        // what a read of the layers below `upTo` depends on: the "picture changed" note compares it, not the editor-wide
        // compositeVersion, which also moves for the live filters above the cut, the references and every redraw in
        // Compare. The global pixelVersion stays in as a net for a pixel write a layer's own version misses
        const pv = (p) => (p ? `${objectId(p)}.${p.version || 0}` : "-");
        const readSig = (upTo) => {
            const parts = [editor.width, editor.height, editor.pixelVersion || 0, pv(editor.basePx), editor.compareShow || ""];
            for (const l of editor.layers.slice(0, upTo)) {
                if (editor.isReference(l) || editor.isControl(l)) continue;
                parts.push(l.id, editor.shown(l) ? 1 : 0, l.opacity, l.blend || "", l.clip ? 1 : 0, l.group || "", l.x, l.y, l.w, l.h, l.kind,
                    l.kind === "filter" ? `${l.filter}${JSON.stringify(l.params || {})}${objectId(l._lutData)}${objectId(l._plateImg)}` : "",
                    pv(l.px), pv(l.maskPx), l.maskOff ? 1 : 0, l.match ? `${l.match.strength}:${l.match.source}` : "");
            }
            return parts.join("|");
        };
        const cancelled = () => Object.assign(new Error(`${L} cancelled.`), { hint: `${L} cancelled.` });
        try {
            const upTo = realism.topFilterRun(editor.layers, isFill, skip);
            editor.setStatus(`${L}: reading the picture (${W} × ${H}) ...`);
            // taken before the read, so a change during encodeComposite's await counts
            const sig0 = readSig(upTo);
            // as a run reads it: the workers' bands on tiles, else (the canvas backend, a stack they cannot hold) a flatten
            let bytes;
            const enc = await editor.encodeComposite({ forRun: true, upTo });
            if (enc) bytes = new Uint8Array(await enc.blob.arrayBuffer());
            else {
                const c = editor.flattenToCanvas({ forRun: true, upTo });
                try { bytes = await canvasBytes(c); } finally { c.width = c.height = 0; }
            }
            const goes = !up ? `${W} × ${H}` : plan.scaled ? `${W} × ${H}, scaled down to ${plan.fit[0]} × ${plan.fit[1]}, at ${mode.text}` : `${W} × ${H} at ${mode.text}`;
            editor.setStatus(`${L}: sending the picture (${goes}) to your ComfyUI ...`);
            const out = await this.passPicture(editor, bytes, "image/png", { token, deadline, factor: mode.factor });
            bytes = null;
            const none = { layer: null, seconds: out.seconds || 0, note: "", changed: false, factor: mode.factor, from: [W, H], width: null, height: null };
            if (gone()) return none;
            // the title row's Cancel stays until the layer is in: pressed after the answer, nothing lands either
            if (token.cancelled) throw cancelled();
            const img = await bytesToImage(out.bytes, out.mime);
            const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
            // above 1×: the document's new size (the answer's width, the picture's aspect, as an upscale of the whole
            // picture lands); the layer's pixels the answer as it is, or stretched by the pixel or two the pack's even
            // rounding moved its height
            const nw = up ? w : W, nh = up ? Math.max(1, Math.round(H * w / W)) : H;
            if (up && nw <= W) throw new Error(`${L}: your ComfyUI answered ${w} × ${h}, which is not larger than the picture (${W} × ${H}).`);
            let lbytes = out.bytes, lmime = out.mime, lcanvas = null;
            if (up && h !== nh) {
                lcanvas = document.createElement("canvas");
                lcanvas.width = nw; lcanvas.height = nh;
                const lx = lcanvas.getContext("2d");
                lx.imageSmoothingEnabled = true;
                lx.imageSmoothingQuality = "high";
                lx.drawImage(img, 0, 0, nw, nh);
                lbytes = await canvasBytes(lcanvas);
                lmime = "image/png";
            }
            // stored as a result is: its PNG in the mirror, so neither a save nor the autosave encodes it again; when the
            // mirror fails, an unsaved layer, which they upload
            let ref = null;
            if (lmime === "image/png") {
                const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
                try { ref = await this.uploadResult(new Blob([lbytes], { type: "image/png" }), `n${editor.node.id}_realism_${stamp}.png`); }
                catch (err) { console.warn("the Realism Pass layer stays unsaved until the next save", err); }
            }
            lbytes = null;
            if (gone()) { if (lcanvas) lcanvas.width = lcanvas.height = 0; return none; }
            if (token.cancelled) { if (lcanvas) lcanvas.width = lcanvas.height = 0; throw cancelled(); }
            // under the top run of filter layers as the stack is now (layers may have come or gone during the run): what
            // lies under that index now against what was read (before a resize, which moves every layer)
            const at0 = realism.topFilterRun(editor.layers, isFill, skip);
            const changed = readSig(at0) !== sig0;
            // (the canvas backend's layer keeps the canvas it is made from: it is not emptied here)
            const px = lcanvas ? editor.pixels.Layer.fromCanvas(lcanvas) : editor.pixels.Layer.fromImage(img);
            if (up) {
                // the document by the factor (Q29): the base scaled as Resize scales it, given as the new base so the
                // landing goes through while this run holds the slot (resizeImage's `base`); every layer, mask and the
                // selection scale along, one `canvas` undo step, which the pass layer below joins (no step of its own)
                const nb = document.createElement("canvas");
                nb.width = nw; nb.height = nh;
                const nctx = nb.getContext("2d");
                nctx.imageSmoothingEnabled = true;
                nctx.imageSmoothingQuality = "high";
                editor.drawBaseInto(nctx, 0, 0, nw, nh);
                const u0 = editor.undo.length;
                try { await editor.resizeImage(nw, nh, { base: nb }); } finally { nb.width = nb.height = 0; }
                // the landing is under way: a Cancel pressed now no longer stops it (half of it is in), a closed tab does
                if (gone()) return none;
                if (editor.width !== nw || editor.height !== nh) throw new Error(editor.status || `${L}: the picture could not be resized.`);
                // the Undo history names the pass, not "Upscale image"
                const step = editor.undo.length > u0 ? editor.undo[editor.undo.length - 1] : null;
                if (step && step.kind === "canvas") { step.label = L; if (editor.historyChanged) editor.historyChanged(); }
            } else {
                editor.pushUndo({ kind: "layers", label: L });
            }
            const at = realism.topFilterRun(editor.layers, isFill, skip);
            const layer = editor.addLayer({ name: L, kind: "image", ref, dirty: !ref, px, x: 0, y: 0, w: nw, h: nh, match: { strength: 0, source: "underneath" } });
            // the move is part of the undo step above
            const top = editor.layers.length - 1;
            if (at < top) editor.moveLayer(layer.id, at - top, { undo: false });
            const where = `a new layer above the picture${at < top ? ", under the filter layers" : ""}`;
            const secs = Math.max(1, Math.round(out.seconds || 0));
            const parts = [up
                ? `${L} ran on your ComfyUI in ${secs} s at ${mode.text}: ${W} × ${H} is now ${nw} × ${nh}, every layer scaled along, and the pass is ${where} (Ctrl+Z takes both back).`
                : `${L} ran on your ComfyUI in ${secs} s: ${where}.`];
            if (changed) parts.push("The picture changed while the pass ran: the layer shows it as it was when the pass started.");
            if (out.note) parts.push(out.note);
            editor.setStatus(parts.join(" "));
            return { layer, seconds: out.seconds || 0, note: out.note || "", changed, factor: mode.factor, from: [W, H], width: nw, height: nh };
        } catch (err) {
            if (gone()) return { layer: null, seconds: 0, note: "", changed: false, factor: mode.factor, from: [W, H], width: null, height: null };
            const msg = String((err && err.message) || err);
            throw say(err && err.hint ? String(err.hint) : msg.startsWith(L) ? msg : `${L}: ${msg}`);
        } finally {
            offRemoved();
            this.endRun(editor, token);
        }
    },

    /**
     * Fill the recipe with the editor state and queue it. Called by editor.generate(); `opts.refs` is the click's
     * reference snapshot (docs/PLAN_REFS.md C3; a caller without one gets the references of now).
     */
    async queueGenerate(editor, opts = {}) {
        const r = this.recipe;
        if (!r) throw new Error("No recipe selected.");
        if (r.kind === "provider" && r.task === "upscale") return this.runUpscale(editor, { scope: "selection", refs: opts.refs });
        if (r.kind === "provider") return this.runProvider(editor, { refs: opts.refs });
        if (!r.prompt) throw new Error("No recipe selected.");
        // the Realism Pass (task "pass") goes out like an upscale: the box as it is, no fill, no references, no refine
        const pass = r.task === "pass";
        const upscale = r.task === "upscale" || pass;
        // An upscaler sends no reference picture and may not read the prompt at all: its tokens go as names where a
        // layer has one, and nothing refuses it. Any other recipe names each token's picture the way its graph numbers
        // the node's batch (26e): checked here against the editor now, before anything is uploaded, and again below
        // against the canvas state the node will read.
        const snap = opts.refs || editor.refSnapshot();
        let texts, early = null;
        // the pass refuses before anything is uploaded: the server (§3.3), the selection, the size (§3.5)
        const support = pass ? this.realismSupport() : null;
        if (pass) {
            if (!support.ok) throw new Error(support.reason);
            const b = editor.getBounds && editor.getBounds();
            if (!b) throw new Error(`Select an area first: ${realism.LABEL} works on the selection's box (Select All for the whole picture).`);
            // the crop the node makes: the box with its context (cropRect mirrors the node's manual or auto padding, the
            // auto minimum span and the clamp to the picture), then each side to the pass's multiple the node's way
            const [, , cw, ch] = editor.cropRect();
            const refusal = realism.fits(realism.fitSpan(cw, editor.width), realism.fitSpan(ch, editor.height));
            if (refusal) throw new Error(refusal);
        }
        if (upscale) {
            const p = this.refNames(editor, snap.prompt), n = this.refNames(editor, snap.negative);
            // the pass's graph reads no prompt at all, so its tokens need no note
            texts = { prompt: p.text, negative: n.text, note: !pass && (p.note || n.note) ? "Upscale sends no reference images: the prompt's @img tokens were written as layer names." : "" };
        } else {
            early = this.comfyPlan(editor, r, snap.refIds.length);
            texts = this.refPrompt(editor, snap, "comfy", { recipe: r, comfy: early });
        }
        if (!this.connected) throw new Error("Not connected to ComfyUI.");
        const missing = (r.needs || []).filter((n) => this.objectInfo && !this.objectInfo[n]);
        if (missing.length) throw new Error("The server lacks these node types: " + missing.join(", "));
        if (upscale && !pass && !(editor.getBounds && editor.getBounds())) throw new Error("Select an area first: an upscale model on ComfyUI sharpens the selection's box.");
        // a ComfyUI upscaler that takes a factor (RTX Video Super Resolution): the one the dialog or the command asked
        // (editor.generate() takes no arguments and is shared with the node, so the factor travels on the editor, read
        // once), and the size limits on the crop the node makes, before anything is uploaded
        let factor = null;
        if (upscale && !pass) {
            const want = opts.factor !== undefined ? opts.factor : editor._comfyUpscaleFactor;
            editor._comfyUpscaleFactor = undefined;
            factor = this.upscaleFactorFor(r, want);
            const [, , cw, ch] = editor.cropRect();
            const m = Math.max(1, +(this.nodeParams && this.nodeParams.multiple_of) || 8);
            const refusal = this.upscaleSizeRefusal(r, realism.fitSpan(cw, editor.width, m), realism.fitSpan(ch, editor.height, m), factor, "box");
            if (refusal) throw new Error(refusal);
        }
        editor.lastUpscaleFactor = factor;
        editor.lastSentPrompt = null;
        editor.lastRunNotes = [];
        editor.lastSentBoxes = 0;   // a local recipe takes no boxes (docs/PLAN_BOXES.md: FLUX 3 Image and Ideogram 4 only)
        // an upscale's canvas state carries no references (upscaleState), so none is read or uploaded for it; a reference
        // past the recipe's slots is not uploaded either
        const sopts = upscale ? { refIds: [], prompt: texts.prompt, negative: texts.negative } : { refIds: snap.refIds.slice(0, early.lay.kept), prompt: snap.prompt, negative: snap.negative };
        let state, plan = null;
        if (upscale) state = this.upscaleState(await editor.serializeForPrompt(sopts));
        else {
            // the state decides: a selection, the fill or Original changed while the references were uploaded
            const st = JSON.parse(await editor.serializeForPrompt(sopts));
            plan = this.comfyPlan(editor, r, (st.references || []).length, st);
            st.references = (st.references || []).slice(0, plan.lay.kept);
            texts = this.refPrompt(editor, snap, "comfy", { recipe: r, comfy: plan });
            st.prompt = texts.prompt;
            st.negative = texts.negative;
            if (texts.pairs.length) st.named_refs = true;
            state = JSON.stringify(st);
            editor.lastSentPrompt = st.prompt;
            if (snap.refIds.length > plan.lay.kept) {
                const left = snap.refIds.slice(plan.lay.kept).map((id) => "img" + snap.labels.get(id));
                editor.lastRunNotes.push(`${listWords(left)} ${left.length === 1 ? "is" : "are"} not sent: ${r.name || r.id} reads ${plan.spec.slots} picture${plan.spec.slots === 1 ? "" : "s"}.`);
            }
            if (plan.spec.guess && texts.pairs.length) editor.lastRunNotes.push("(wording guessed from the graph)");
        }
        if (texts.note) editor.setStatus(`${editor.status} ${texts.note}`);
        await this.ensureOnServer(state, editor);
        const prompt = JSON.parse(JSON.stringify(r.prompt));
        const canvas = prompt[r.canvas];
        if (!canvas) throw new Error(`Recipe "${r.id}" has no canvas node "${r.canvas}".`);
        // the encoder inputs whose picture this batch does not hold are left out, so none repeats the last one
        if (plan) trimSlots(prompt, plan.spec, 1 + plan.lay.original + plan.lay.kept);
        canvas.inputs = { ...(canvas.inputs || {}), ...this.nodeParams, canvas_state: state };
        // an upscaler sees the crop at its native size: the node grows the box to a multiple instead of scaling it
        if (upscale) canvas.inputs.target_size = 0;
        // the pack rounds odd sides (a 1-px black column, or a resample) and a larger multiple shrinks a whole-picture
        // crop, leaving a border without the pass: the pass's crop is even and loses at most 1 px of an odd side
        if (pass) canvas.inputs.multiple_of = realism.PASS_MULTIPLE;
        delete canvas.inputs.result; delete canvas.inputs.result_local;
        delete canvas.inputs.result_source; delete canvas.inputs.result_source_local;
        canvas.inputs[r.mode === "api" ? "result_source" : "result_source_local"] = r.result;
        for (const s of r.settings || []) {
            const entry = editor.settings[String(s.index)];
            const node = prompt[s.node];
            if (entry && entry.value != null && node && node.inputs) node.inputs[s.input] = entry.value;
        }
        if (factor != null && r.factor && r.factor.input) {
            const at = r.factor.input.indexOf("|"), node = prompt[r.factor.input.slice(0, at)];
            if (node && node.inputs) node.inputs[r.factor.input.slice(at + 1)] = factor;
        }
        if (pass) {
            // Style and Strength are app-wide (settings.realism, the Upscale dialog's row); the DLSS model preset is the
            // recipe's own Settings row (its shipped presets L and M), so it is not taken from settings.realism here. A
            // user copy without an rp_settings node gets them in every DLSS5Settings node it holds.
            const v = this.realismValues();
            for (const node of Object.values(prompt)) {
                if (node && node.class_type === "DLSS5Settings") node.inputs = realism.passSettings(node.inputs, { style: v.style, intensity: v.intensity });
            }
        }
        const res = await api.queuePrompt(0, { output: prompt, workflow: this.workflowInfo() });
        editor.lastPromptId = res && res.prompt_id;
        if (pass && support.note) editor.setStatus(`${editor.status} ${support.note}`);
        if (plan) {
            const named = texts.pairs.filter((p) => p.name).map((p) => `${p.label} → ${p.name}`);
            if (named.length) editor.setStatus(`${editor.status} Named in the prompt: ${named.join(", ")}.`);
            if (editor.lastRunNotes.length) editor.setStatus(`${editor.status} ${editor.lastRunNotes.join(" ")}`);
            if (named.length && window.scumble && window.scumble.log) {
                Promise.resolve(window.scumble.log.add({ level: "info", source: "comfy", message: `local run ${(res && res.prompt_id) || ""}: prompt as sent`, detail: editor.lastSentPrompt })).catch(() => { /* the log is optional */ });
            }
        }
        // open until ComfyUI says the prompt ended (success, error, interrupt) or its queue is empty: a turn of the whole
        // picture waits for it, since the result lands in the geometry it was made for (PLAN_0_1_31 §7)
        if (res && res.prompt_id) (editor._localRuns || (editor._localRuns = new Set())).add(res.prompt_id);
        return res;
    },

    /**
     * The canvas state an upscale recipe on ComfyUI gets: the crop as it is (no fill, so no second "Original"
     * picture either), no reference layers and no refine pass; everything else (context, feather, paste,
     * colour match) stays the user's.
     */
    upscaleState(stateJson) {
        const s = typeof stateJson === "string" ? JSON.parse(stateJson) : { ...(stateJson || {}) };
        s.crop = { ...(s.crop || {}), fill: "none", withOriginal: false };
        s.references = [];
        if (s.gen) s.gen = { ...s.gen, refine: false };
        return JSON.stringify(s);
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
        const report = await this.ensureRefs(refs);
        if (report && report.uploaded.length && editor) editor.setStatus(`Uploaded ${report.uploaded.length} file${report.uploaded.length > 1 ? "s" : ""} to the server. Waiting for the result ...`);
        if (report && report.missing.length) throw new Error("These files are neither on the server nor in the local store: " + report.missing.join(", "));
        return report;
    },

    /** What goes into an exported PNG's tEXt chunk in place of the litegraph workflow, or null when nothing is to go in (3f). */
    workflowForPng(editor) {
        const own = editor && editor._export ? editor._export.metadata : null;
        return (own == null ? this.embedRecipe : own) ? this.workflowInfo() : null;
    },

    /**
     * The recipe as the app describes it: the export's tEXt chunk, and a local run's `extra_pnginfo` for a SaveImage in
     * it. The recipe's prompt goes without the inputs named like a key, a token, a secret or a password (`redact.js`,
     * the user 2026-09-27): an imported workflow carries its third-party key widgets, and the picture may travel. The
     * run itself is queued from `r.prompt` (queueGenerate), which keeps them.
     */
    workflowInfo() {
        const r = this.recipe;
        return { app: "scumble", recipe: r ? r.id : null, kind: r ? r.kind || "comfy" : null, provider: (r && r.provider) || null, model: (r && r.model) || null, prompt: r ? withoutSecrets(r.prompt || null) : null, nodeParams: this.nodeParams };
    },

    /**
     * The InpaintCanvas node's own widgets, which the litegraph node showed under the
     * editor button: crop padding, target size, feather, multiple_of. Built into the
     * editor's Generate section, stored in
     * settings.nodeParams and filled into the recipe's canvas node on every run.
     */
    buildGenerateExtras(editor, sec) {
        const grid = document.createElement("div");
        grid.className = "ipc-row4 scumble-node-params";
        /** @type {[key: string, label: string, min: number, max: number, step: number, title: string][]} */
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
            input.min = String(min); input.max = String(max); input.step = String(step); input.title = title;
            input.value = String(this.nodeParams[key]);
            input.addEventListener("keydown", (e) => e.stopPropagation());
            input.addEventListener("change", () => {
                const v = Math.min(max, Math.max(min, Math.round(+input.value || 0)));
                input.value = String(v);
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
            this.emit("crop", { editor: ed });
        }
    },

    async saveExport(blob, name) {
        const data = new Uint8Array(await blob.arrayBuffer());
        return window.scumble.file.save({ name, data, path: this.exportPath || undefined });
    },

    /**
     * An editor changed: autosave every open document (debounced) and refresh the tabs. `info.geometry` (the whole
     * picture was turned, cropped, extended, resized or straightened: `{ kind, m, op, from, to }`, PLAN_0_1_31 §7) goes
     * out first as a "geometry" event, for the plugins that keep image coordinates of their own.
     */
    changed(editor, info) {
        if (editor) editor._stateKey = null;      // changed since the last autosave: counts as changed until it runs (documentDirty)
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.saveAll(), 1500);
        if (info && info.geometry) this.emit("geometry", { editor, ...info.geometry });
        // the Boxes switch counts the document's boxes: a plugin's data change and its undo come through here
        if (editor && editor.syncBoxesRow) editor.syncBoxesRow();
        this.emit("changed", { editor });
    },

    /**
     * The autosave bundle: every open document's state, the active one, the id counter. A document's entry also keeps
     * its .scumble file (`file`), its per-document plugin data (`plugins`) and the fields of an opened newer document
     * this app does not know (`extra`); an older app reads `id` and `state` only (docs/PLAN_DOCUMENTS.md §5.2).
     */
    bundle() {
        const docs = [];
        for (const ed of this._editors) {
            let state = "{}";
            const raw = this._rawStates.get(ed);
            if (raw != null && ed.base) this._rawStates.delete(ed);        // it holds a picture of its own now
            else if (raw != null) { docs.push({ id: ed.node.id, state: raw, ...docMeta(ed, !!(ed.docFile && ed.docFile.clean)) }); continue; }
            try { state = ed.getValue(); } catch (err) { console.warn("getValue", err); }
            if (ed.base) ed._stateKey = hashString(state);      // the dirty marker compares it with the file's (documentDirty)
            docs.push({ id: ed.node.id, state, ...docMeta(ed, !this.documentDirty(ed)) });
        }
        return { version: 2, active: this.editor ? this.editor.node.id : null, nextId: this.nextId, docs, closed: this.closed.slice(-CLOSED_MAX) };
    },

    saveAll() {
        clearTimeout(this._saveTimer);
        if (this._restoring) { this._saveTimer = setTimeout(() => this.saveAll(), 1500); return; }   // see _restoring
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
            walk(ed.pluginData);          // a 3D layer's model file (glb plugin), and whatever else a plugin keeps per document
            walk(ed.docExtra);            // the fields of a newer document this app does not know may name files too
        }
        // the closed tabs Reopen Closed Tab can bring back
        for (const c of this.closed) {
            try { walk(JSON.parse(c.state)); } catch (_) { /* an empty state */ }
            walk(c.plugins);
            walk(c.extra);
        }
        return Array.from(keys);
    },

    // ---- .scumble documents (docs/PLAN_DOCUMENTS.md; the file is written and read in main, documents.js) -----------

    _docSaves: new Set(),
    _docSeq: 0,
    _docJobs: new Map(),      // reqId -> { editor, name, kind } for the progress line

    /** Resolves when no document save of this window is in flight (the close and the update wait for it). */
    async docSavesIdle() {
        while (this._docSaves.size) await Promise.allSettled(Array.from(this._docSaves));
    },

    /**
     * Everything one document's file must hold, uploaded now: the edited layers and masks (up to three rounds, for a
     * stroke that lands during one) and the selection's PNG (encoded in the background above 16 MP). The same steps
     * as saveBeforeRestart (renderer/shell.js), for one editor, and an upload that fails throws: a file with the
     * layer's old pixels under a new save would lose work without a word.
     * @param {any} ed
     * @param {(text: string) => void} [say]
     * @param {string} [when]
     */
    async flushEditor(ed, say = (_text) => {}, when = "saving") {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (const until = Date.now() + 60000; this._restoring && Date.now() < until;) await sleep(100);
        if (ed.heldEdit) await ed.heldEdit();   // a heal or a Remove still landing (its stroke is drawn until it has)
        for (const until = Date.now() + 10000; ed.pointer && Date.now() < until;) await sleep(50);   // a stroke still down
        const edited = () => ed.base && ed.layers && ed.layers.some((l) => (l.dirty && l.px) || (l.maskDirty && l.maskPx));
        if (edited()) say(`Saving the edited layers before ${when}...`);
        for (let round = 0; round < 3 && edited(); round++) await ed.syncLayers();
        const pending = () => ed.base && ed.sel && (ed._selEncoding || !ed.selectionEncoded || !ed.selectionDataUrl);
        for (const until = Date.now() + 60000; pending() && Date.now() < until;) {
            if (!ed._selEncoding) {
                try { ed.getValue(); } catch (_) { /* reported by the save */ }
                if (pending() && !ed._selEncoding) break;      // an encode that cannot start (above the canvas limit)
            }
            say(`Saving the selection before ${when}...`);
            await sleep(100);
        }
    },

    /** The file's 256 px picture (PNG bytes), from the settled pyramid; null when it cannot be made. */
    async documentThumbnail(ed) {
        if (ed.heldEdit) await ed.heldEdit();
        const W = ed.width, H = ed.height;
        const small = await ed.sampleRegionSettled("image", [0, 0, W, H], Math.min(1, 256 / Math.max(W, H)), { forRun: true });
        const blob = small.convertToBlob ? await small.convertToBlob({ type: "image/png" }) : await new Promise((r) => small.toBlob(r, "image/png"));
        return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    },

    /** The name a document is saved and shown under: its file's stem, else the picture's file name. */
    documentName(ed) {
        if (ed && ed.docFile && ed.docFile.name) return String(ed.docFile.name).replace(/\.scumble$/i, "");
        if (!ed || !ed.base || !ed.base.ref) return "Untitled";
        return String(ed.base.ref.filename || "image").replace(/\.[a-z0-9]+$/i, "");
    },

    /**
     * Is the tab changed against its .scumble file (the "*" on the tab and in the title)? A document with a picture and
     * no file counts as changed; so does one with an edited layer or mask not uploaded yet, a selection not encoded
     * yet, a change since the last autosave, or an autosaved state whose hash is not the file's (bundle() keeps it).
     */
    documentDirty(ed) {
        if (!ed || !ed.base) return false;
        if (ed.pointer && ed.pointer.healing) return true;   // a heal stroke blending in a worker is an edit on its way
        if (!ed.docFile || !ed.docFile.key) return true;
        if (ed.layers.some((l) => (l.dirty && l.px) || (l.maskDirty && l.maskPx))) return true;
        if (ed.sel && !ed.selectionEncoded) return true;
        if (ed._stateKey == null) return true;
        return ed._stateKey !== ed.docFile.key;
    },

    /**
     * After a restore or an open: the state's key once the selection is encoded again (setValue re-encodes it). A file
     * without a key yet (just opened) or one the tab matched when the session was saved (`clean`) takes it as the saved
     * one, so the tab starts clean even where the restored state serialises a little differently.
     */
    async settleKey(ed) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (const until = Date.now() + 60000; this._restoring && Date.now() < until;) await sleep(100);
        await this.flushEditor(ed, () => {}, "saving");
        if (!ed.base || !ed.docFile || !this._editors.includes(ed)) return;
        const key = hashString(ed.getValue());
        ed._stateKey = key;
        if (!ed.docFile.key || ed.docFile.clean) ed.docFile.key = key;
        delete ed.docFile.clean;
        if (this.onDocsChanged) this.onDocsChanged();
    },

    /**
     * A question about a document, in the app's own dialog (renderer/dialogs.js): `close` -> "save" | "discard" |
     * "cancel", `changed` and `newer` -> "overwrite" | "saveas" | "cancel", `history` -> "with" | "without" | "cancel".
     * A test replaces this method in the page.
     */
    async askDocument(q) {
        const d = documentQuestion(q || {});
        return d.answers[await dialogs.ask(d.spec)] || "cancel";
    },

    /** Save As: the path from main's dialog, or null when cancelled (a test replaces this method in the page). */
    async chooseDocumentPath(name) {
        return window.scumble.documents.choosePath({ name });
    },

    /** Stop a save or an open of this document: before the write, the capture stops; during it, main deletes its temporary file. */
    cancelDocumentJob(ed) {
        const p = ed && ed._docProgress;
        if (!p) return false;
        ed._docCancel = true;
        if (p.reqId) window.scumble.documents.cancel(p.reqId).catch(() => {});
        return true;
    },

    /**
     * Save a document to a .scumble file. `as` asks for a path (Save As), `path` gives one (commands), `copy` writes
     * the file without making it the tab's file, `history` true / false keeps or leaves the result history (and the
     * prompts of earlier runs) out; unset, a Save As of a document with results asks, and the tab's file remembers the
     * answer for the next Ctrl+S. `ask: false` (commands) asks nothing. Resolves with main's answer ({ path, bytes,
     * entries, ms, notes }), or null when a dialog was cancelled. Throws with the reason.
     */
    async saveDocument(ed, { as = false, copy = false, path = null, history = null, ask = true } = {}) {
        if (!ed || !ed.base) throw new Error("There is nothing to save yet: the document holds no picture.");
        if (ed._docSaving) throw new Error(`${this.documentName(ed)} is already being saved.`);
        let target = path || (!as && !copy && ed.docFile && ed.docFile.path) || null;
        ed._docSaving = true;      // from here: a second Ctrl+S during a dialog is "already being saved"
        ed._docCancel = false;
        const job = (async () => {
            const inPlace = !!(target && ed.docFile && normPath(target) === normPath(ed.docFile.path));
            if (inPlace && ask) {
                // the file changed on disk since it was opened or saved here, or a newer Scumble made it: ask first
                const st = await window.scumble.documents.stat(target);
                const moved = st.exists && (Math.abs(st.mtime - (ed.docFile.mtime || 0)) > 1 || st.size !== ed.docFile.size);
                for (const kind of [moved && "changed", ed.docFile.newer && "newer"].filter(Boolean)) {
                    const a = await this.askDocument({ kind, name: ed.docFile.name });
                    if (a === "cancel") return null;
                    if (a === "saveas") { target = null; break; }
                }
            }
            let chosen = false;
            if (!target) {
                target = await this.chooseDocumentPath(this.documentName(ed));
                if (!target) return null;
                chosen = true;
            }
            const name = String(target).split(/[\\/]/).pop();
            // the result history: the caller's word, else the answer the tab's file remembers, else (a Save As of a
            // document with results) a question
            let keep = history;
            if (keep == null && !chosen && ed.docFile && normPath(target) === normPath(ed.docFile.path) && ed.docFile.history === false) keep = false;
            if (keep == null && chosen && ask && ed.history && ed.history.length) {
                const a = await this.askDocument({ kind: "history", name, count: Math.min(100, ed.history.length) });
                if (a === "cancel") return null;
                keep = a !== "without";
            }
            if (keep == null) keep = true;
            const reqId = `save-${ed.node.id}-${++this._docSeq}`;
            this._docJobs.set(reqId, { editor: ed, name, kind: "save" });
            ed._docProgress = { kind: "save", name, pct: null, reqId: null };
            if (this.onDocsChanged) this.onDocsChanged();
            try {
                ed.setStatus(`Saving ${name}...`);
                await this.flushEditor(ed, (t) => ed.setStatus(t), "saving the document");
                if (ed._docCancel) throw new Error("the save was cancelled");
                const state = ed.getValue();       // a stroke after this is not in the file and leaves the tab changed
                let thumbnail = null;
                try { thumbnail = await this.documentThumbnail(ed); } catch (err) { console.warn("document thumbnail", err); }
                if (ed._docCancel) throw new Error("the save was cancelled");
                const r = this.recipe;
                ed._docProgress.reqId = reqId;
                const res = await window.scumble.documents.write({
                    reqId, path: target, document: state, plugins: ed.pluginData || {}, extra: ed.docExtra || {}, thumbnail, history: keep, recent: !copy,
                    summary: { name: name.replace(/\.scumble$/i, ""), width: ed.width, height: ed.height, layers: ed.layers.length },
                    recipe: r ? { id: r.id || null, provider: r.provider || null } : null,
                });
                if (!copy) {
                    ed.docFile = { path: res.path, name: res.name, key: hashString(state), mtime: res.mtime, size: res.size, ...(keep ? {} : { history: false }) };
                    this.saveAll();                // the session keeps the tab's file (and bundle() the state's key)
                }
                ed.setStatus(`${copy ? "Saved a copy as" : "Saved"} ${res.name} (${fmtMB(res.bytes)}, ${(res.ms / 1000).toFixed(1)} s)${keep ? "" : ", without the result history"}.${res.notes && res.notes.length ? " " + res.notes.join("; ") + "." : ""}`);
                return res;
            } finally {
                this._docJobs.delete(reqId);
                ed._docProgress = null;
                if (this.onDocsChanged) this.onDocsChanged();
            }
        })();
        this._docSaves.add(job);
        try { return await job; } finally { this._docSaves.delete(job); ed._docSaving = false; ed._docCancel = false; }
    },

    /**
     * Open a .scumble file: the tab that holds it is activated, else it opens into the active tab when that is empty,
     * or a new one. The files go into the mirror in main; the state is restored like the session's (restore()), and the
     * tab starts clean once its key has settled (settleKey). Resolves with { editor, already, notes }. Throws with the
     * reason (nothing is opened then).
     */
    async openDocument(file) {
        const key = normPath(file);
        const open = this._editors.find((ed) => ed.docFile && normPath(ed.docFile.path) === key);
        if (open) { if (this.shell) this.shell.activate(open); return { editor: open, already: true, notes: [] }; }
        const reqId = `open-${++this._docSeq}`;
        const name = String(file).split(/[\\/]/).pop();
        const cur = this.editor;
        if (cur) cur.setStatus(`Opening ${name}...`);
        this._docJobs.set(reqId, { editor: cur, name, kind: "open" });
        if (cur && !cur._docProgress) { cur._docProgress = { kind: "open", name, pct: null, reqId }; if (this.onDocsChanged) this.onDocsChanged(); }
        let r;
        try { r = await window.scumble.documents.open({ reqId, path: file }); } finally {
            this._docJobs.delete(reqId);
            if (cur && cur._docProgress && cur._docProgress.reqId === reqId) { cur._docProgress = null; if (this.onDocsChanged) this.onDocsChanged(); }
        }
        const doc = r.document;
        // top-level fields this app does not write travel in `extra` and go back into the next save (§6)
        const extra = {};
        for (const [k, v] of Object.entries(r.extra || {})) if (!STATE_KEYS.has(k)) extra[k] = v;
        for (const k of Object.keys(doc)) if (!STATE_KEYS.has(k)) extra[k] = doc[k];
        const reuse = cur && !cur.base && !cur._loading && !this._rawStates.has(cur) && !cur.docFile;
        const id = reuse ? cur.node.id : this.nextId++;
        const fileMeta = { path: r.path, name: r.name, key: null, mtime: r.mtime, size: r.size, ...(r.newer ? { newer: true } : {}) };
        await this.restore(JSON.stringify({ version: 2, active: id, nextId: this.nextId, docs: [{ id, state: JSON.stringify(doc), file: fileMeta, plugins: r.plugins, extra }] }));
        const ed = this.editorById(id);
        if (!ed) throw new Error(`${name} could not be opened in a tab`);
        if (this.shell) this.shell.activate(ed);      // the tab bar and window.editor follow (restore() activates in here only)
        // the tab is clean when this resolves (a command's list_documents right after reads it so)
        try { if (ed.base) await this.settleKey(ed); } catch (err) { console.warn("document key", err); }
        const notes = [...(r.notes || [])];
        // the recipe is global (every tab uses it), so opening a document does not switch it; it says when they differ
        const now = this.recipe;
        if (r.recipe && r.recipe.id && (!now || now.id !== r.recipe.id)) {
            const list = this.shell && this.shell.recipes ? this.shell.recipes() || [] : [];
            const named = (id) => { const x = list.find((q) => q.id === id); return x ? x.name || id : id; };
            notes.push(`saved with the recipe ${named(r.recipe.id)}; the current one is ${now ? named(now.id) : "none"}`);
        }
        if (ed.base) ed.setStatus(`Opened ${r.name}.${notes.length ? " " + notes.join("; ") + "." : ""}`);
        this.saveAll();
        return { editor: ed, already: false, notes };
    },

    /** Main's progress of a save or an open: the chip on the document's tab (renderer/shell.js renderTabs). */
    documentProgress({ reqId, done, total }) {
        const j = this._docJobs.get(reqId);
        if (!j || !j.editor || !total) return;
        const pct = Math.min(100, Math.floor((done / total) * 100));
        const p = j.editor._docProgress;
        if (p && (p.reqId === reqId || p.reqId == null)) { p.pct = pct; p.reqId = reqId; }
        if (this.onDocsChanged) this.onDocsChanged();
    },

    // ---- closed tabs (docs/PLAN_DOCUMENTS.md §5.4) ------------------------------------------------------------------

    closed: [],          // [{ id, name, time, state, file?, plugins?, extra? }], the newest last, CLOSED_MAX at most

    /**
     * A tab that was closed (and already left the tab bar): its state goes on the closed list at once, then again after
     * its edited layers are uploaded (at most 30 s), so Reopen Closed Tab brings back what it showed. The caller
     * destroys the editor afterwards.
     */
    async rememberClosed(ed) {
        if (!ed || !ed.base) return;
        const capture = () => {
            let state = null;
            try { state = ed.getValue(); } catch (err) { console.warn("closed tab", err); }
            if (ed.base) ed._stateKey = state ? hashString(state) : null;
            return { id: ed.node.id, name: this.documentName(ed), time: Date.now(), state, ...docMeta(ed, !this.documentDirty(ed)) };
        };
        let entry = capture();
        if (!entry.state) return;
        this.closed.push(entry);
        while (this.closed.length > CLOSED_MAX) this.closed.shift();
        this.saveAll();
        try {
            await Promise.race([this.flushEditor(ed, () => {}, "closing"), new Promise((r) => setTimeout(r, 30000))]);
            const again = capture();
            const i = this.closed.indexOf(entry);
            if (again.state && i >= 0) { this.closed[i] = again; entry = again; this.saveAll(); }
        } catch (err) { console.warn("closed tab: its layers were not all uploaded", err); }
    },

    /** Reopen Closed Tab: the newest closed tab comes back in a new tab. Resolves with the editor, or null. */
    async reopenClosed() {
        const e = this.closed.pop();
        if (!e) return null;
        const id = this.nextId++;
        // a file that is open in another tab by now stays with that tab
        const file = e.file && !this._editors.some((x) => x.docFile && normPath(x.docFile.path) === normPath(e.file.path)) ? e.file : null;
        await this.restore(JSON.stringify({ version: 2, active: id, nextId: this.nextId, docs: [{ id, state: e.state, file, plugins: e.plugins, extra: e.extra }] }));
        const ed = this.editorById(id);
        if (ed && this.shell) this.shell.activate(ed);
        if (ed && ed.base) ed.setStatus(`Reopened ${e.name}.`);
        this.saveAll();
        return ed || null;
    },

    // ---- in-app helpers: SAM2 objects and background removal through ONNX Runtime -----------
    //
    // The main process (electron/main/onnx) holds the models; the renderer scales the
    // source to the model's 1024 × 1024 input with Canvas 2D and scales the answer back.
    // The editor asks through objectBackendAvailable() / ensureObjects() and
    // availableCutoutBackends() / cutoutLayer(); when
    // no in-app model is present, the ComfyUI helper prompts run as in the node.

    /** @type {{ models: any[], sam2?: any, matting?: any, inpaint?: any, runtime?: any }} */
    helpers: { models: [], sam2: null, matting: null, inpaint: null, runtime: null },
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
    // settings.llm.refPictures (absent = on): an upsample shows the language model the reference images the prompt
    // names (docs/PLAN_REFS.md 26d2); main enforces the setting where the request leaves, this only saves the drawing
    llmRefPictures: true,

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

    /**
     * One question to an API language model with a canvas in view; { text, seconds, note, pictures }. `images`: the
     * reference pictures to show it too, [{ png, label }] (`llmPictures`); main sends at most six.
     */
    async askLLM(backend, instruction, canvas, images = []) {
        let image = null;
        if (canvas) {
            const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
            image = new Uint8Array(await blob.arrayBuffer());
        }
        try {
            return await window.scumble.llm.ask({ id: backend.llm, instruction, image, ...(images && images.length ? { images } : {}) });
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
    async upsampleInApp(editor, backend, instruction, refs = []) {
        // the pictures of the references the prompt names (26d2), unless the setting keeps them back
        const images = this.llmRefPictures && refs.length ? await this.llmPictures(editor, refs) : [];
        const res = await this.askLLM(backend, instruction, await editor.promptContextCanvas(), images);
        if (!editor.upsamplePending) return;   // cancelled meanwhile
        editor.applyTextResult({ text: res.text });
        const pics = res.pictures ? `, ${res.pictures} reference picture${res.pictures === 1 ? "" : "s"}` : "";
        // "crop only": the model took no reference picture; "text only": it refused every picture and answered on the words alone
        const note = res.note ? `, ${res.note}` : "";
        editor.setStatus(editor.status.replace(/\.$/, "") + ` (${backend.label.replace(/ \(.*\)$/, "")}, ${res.seconds.toFixed(1)} s${pics}${note}).`);
    },

    /**
     * The pictures of the references an upsample names (26d2): at most six, in label order, each layer drawn with its
     * mask at 512 px on its long side at most (from the tiles' thumbnails on tiles: never a full-size mirror), as PNG
     * bytes after a label with its token and name. A layer without pixels is left out. App only: the editor never
     * calls it.
     * @param {any} editor
     * @param {{ id: string, n: number, name: string }[]} refs  sorted by label
     * @returns {Promise<{ png: Uint8Array, label: string }[]>}
     */
    async llmPictures(editor, refs) {
        const out = [];
        for (const r of (refs || []).slice(0, 6)) {
            const layer = editor.layers.find((l) => l.id === r.id);
            if (!layer || !layer.px) continue;
            const s = Math.min(1, 512 / Math.max(layer.px.width, layer.px.height));
            const w = Math.max(1, Math.round(layer.px.width * s)), h = Math.max(1, Math.round(layer.px.height * s));
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            editor.drawLayerFitted(c.getContext("2d"), layer, 0, 0, w, h);
            const blob = await new Promise((res) => c.toBlob(res, "image/png"));
            if (blob) out.push({ png: new Uint8Array(await blob.arrayBuffer()), label: referenceName(r) });
        }
        return out;
    },

    /**
     * One call into the in-app helper models (`objects`, `segment`, `cutout`, `inpaint`, `warmInpaint`); one member, so
     * a gate can stand in for it.
     */
    helperCall(name, args) {
        return window.scumble.helpers[name](args);
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

    /** The Remove tool is in the app (LaMa in-app, PLAN_0_1_31 §5 step 3); the node has none. */
    removeSupported: true,

    /**
     * @img1, @img2 in the prompt name the shown reference layers, and their numbers follow the layers through every
     * change (docs/PLAN_REFS.md); the node keeps its positional "ref N" until a node release.
     */
    refTokens: true,

    /** The inpaint model the Remove tool runs (LaMa): the chosen one when present, else the first present, else null. */
    removeModel() {
        const all = this.presentHelpers("inpaint");
        return all.find((m) => m.id === this.helpers.inpaint) || all[0] || null;
    },

    /**
     * Remove: the picture and the hole at the model's size (RGBA and bytes, 512²) through the in-app model ->
     * { image (RGBA 512²), size, seconds, runMs, provider, model, label }.
     */
    async removeInApp(editor, req) {
        const m = this.removeModel();
        if (!m) throw new Error("Remove needs the LaMa model: download it in Settings › Helpers (in-app models).");
        // no `helperUsed`: LaMa runs on the CPU in its own process and holds no VRAM, so a local run need not free it
        return this.helperCall("inpaint", { model: m.id, image: req.image, mask: req.mask });
    },

    /**
     * Load the Remove model ahead of the first stroke (about 9 s on the CPU): the tool asks when it is picked.
     * -> { ready, seconds, provider } or { ready: false, error }; null without a model. Never throws.
     */
    async warmRemove(editor) {
        const m = this.removeModel();
        if (!m) return null;
        try { return await this.helperCall("warmInpaint", { model: m.id }); }
        catch (err) { return { ready: false, error: String(err && err.message || err) }; }
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

    /**
     * The object tool's model input, 1024 x 1024 RGBA bytes: the flattened image, or one layer on neutral grey, squashed
     * (C6 c5 slice 6). On tiles it is read from levels: one uniform region pass at `max(1024 / W, 1024 / H)` (so no axis
     * is scaled up and filters run on an unsquashed picture), with its chains built in the mips worker, then the squash.
     * It was one or two full-resolution flattens, or a whole-layer copy, for a 4 MB input: at 15000 x 10000 over 1.7 GB of
     * canvases and mirrors each time the map was checked. On canvases it is the old picture, byte for byte.
     */
    async objectInput(editor, layer) {
        const W = editor.width, H = editor.height;
        if (!editor.tileMode) return this.modelInput(this.sourceCanvas(editor, layer), 1024, null);
        const s = Math.min(1, Math.max(1024 / W, 1024 / H));
        if (!layer) return this.modelInput(await editor.sampleRegionSettled("image", [0, 0, W, H], s, { forRun: true }), 1024, null);
        const px = layer.px;
        const tiled = layer.kind !== "filter" && px && typeof px.primeRegion === "function" && !editor.liveStrokeOn(layer) && (!layer.maskPx || editor.tileMaskOf(layer));
        if (!tiled) return this.modelInput(this.sourceCanvas(editor, layer), 1024, null);
        const tw = Math.max(1, Math.round(W * s)), th = Math.max(1, Math.round(H * s));
        // the layer and its mask at the pass's level, in a scratch of their own (a destination-in over the grey would cut it)
        const fx = layer.w / px.width, fy = layer.h / px.height;
        const rect = [-layer.x / fx, -layer.y / fy, (W - layer.x) / fx, (H - layer.y) / fy];
        const level = editor.tileLevel(fx * s);
        const jobs = await Promise.all([px, layer.maskPx].filter(Boolean).map((q) => q.primeRegion(rect, level)));
        try {
            const scratch = document.createElement("canvas");
            scratch.width = tw; scratch.height = th;
            const x = scratch.getContext("2d");
            x.imageSmoothingEnabled = true;
            x.setTransform(s, 0, 0, s, 0, 0);
            const vp = { x: 0, y: 0, w: W, h: H, sx: s, sy: s, sample: true };
            editor.drawPixelsInto(x, layer, layer.px, vp);
            if (layer.maskPx) {
                x.globalCompositeOperation = "destination-in";
                editor.drawPixelsInto(x, layer, layer.maskPx, vp);
            }
            const c = document.createElement("canvas");
            c.width = tw; c.height = th;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#808080";
            ctx.fillRect(0, 0, tw, th);
            ctx.drawImage(scratch, 0, 0);
            return this.modelInput(c, 1024, null);
        } finally {
            for (const j of jobs) j.release();
        }
    },

    /**
     * The cutout model's input, 1024 x 1024 RGBA bytes: the layer's own pixels (no mask), squashed onto black. On tiles
     * from the layer's levels at the larger of the two squash scales (slice 6); it was a whole-layer `toCanvas()`, 572 MB
     * for a 15000 x 10000 image layer. On canvases `toCanvas()` is the layer canvas itself, as before.
     */
    async cutoutInput(editor, layer) {
        const px = layer.px;
        if (!editor.tileMode || typeof px.primeRegion !== "function") return this.modelInput(px.toCanvas(), 1024, "#000000");
        const pw = px.width, ph = px.height;
        const s = Math.min(1, Math.max(1024 / pw, 1024 / ph));
        const job = await px.primeRegion([0, 0, pw, ph], editor.tileLevel(s));
        try {
            if (layer.px !== px) return this.modelInput(layer.px.toCanvas(), 1024, "#000000");
            const c = document.createElement("canvas");
            c.width = 1024; c.height = 1024;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#000000"; ctx.fillRect(0, 0, 1024, 1024);
            ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
            ctx.setTransform(1024 / pw, 0, 0, 1024 / ph, 0, 0);
            editor.drawTilesInto(ctx, px, 0, 0, pw, ph, { x: 0, y: 0, w: pw, h: ph, sx: s, sy: s });
            return new Uint8Array(ctx.getImageData(0, 0, 1024, 1024).data.buffer);
        } finally {
            job.release();
        }
    },

    /** The key an object map and its SAM2 embedding are cached under: a hash of the model input itself. */
    async inputHash(image) {
        const d = new Uint8Array(await crypto.subtle.digest("SHA-1", image));
        let h = "";
        for (let i = 0; i < 10; i++) h += d[i].toString(16).padStart(2, "0");
        return h;
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
        try {
            // slice 6: the key is a hash of the model input, not of an uploaded full-resolution PNG (nothing is uploaded
            // on this path any more). Equal inputs share the map and the embedding; an undo back to the same picture too.
            const version = editor.compositeVersion;
            const image = await this.objectInput(editor, pending.layer);
            const hash = (pending.layer ? `layer:${pending.layer.id}:` : "image:") + await this.inputHash(image);
            pending = { ...pending, hash };
            const W = editor.width, H = editor.height;
            const o = editor.objects;
            if (o && o.hash === hash && o.w === W && o.h === H) { o.version = version; editor.objectsPending = null; return; }
            editor.objectsPending = { stage: "run", ...pending };
            editor.setStatus(`Finding objects with ${model.label} (in-app) ...`);
            const s = Math.min(1, 2048 / Math.max(W, H));
            const outW = Math.max(1, Math.round(W * s)), outH = Math.max(1, Math.round(H * s));
            editor.helperUsed = true;   // the ONNX sessions hold VRAM; freed before a local run like the ComfyUI helpers
            const res = await this.helperCall("objects", { model: model.id, key: `${editor.node.id}:${pending.hash}`, image, outWidth: outW, outHeight: outH });
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
            if (editor.objects) editor.objects.version = version;   // the hover's staleness test (updateObjectHover)
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
        const image = await this.cutoutInput(editor, layer);
        editor.helperUsed = true;
        const res = await this.helperCall("cutout", { model: model.id, image });
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
            res = await this.helperCall("segment", { model: model.id, key, points: pts, box: bx, outWidth: outW, outHeight: outH });
        } catch (err) {
            // embedding gone (freed, restarted): encode again from the same source, the input the map's hash was taken of
            const layer = editor.objects.layerId != null ? editor.layers.find((l) => l.id === editor.objects.layerId) : null;
            const image = await this.objectInput(editor, layer);
            res = await this.helperCall("segment", { model: model.id, key, image, points: pts, box: bx, outWidth: outW, outHeight: outH });
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
            const already = editor.sel.readRect(x, y, 1, 1).data[3] > 0;
            const subtract = p.alt ? true : (p.shift ? false : already);
            editor.pushUndo({ kind: "selection", label: "Object selection" });
            const shape = document.createElement("canvas");
            shape.width = W; shape.height = H;
            const sctx = shape.getContext("2d");
            const im = sctx.createImageData(W, H);
            const d = im.data;
            for (let i = 0, j = 0; i < mask.length; i++, j += 4) if (mask[i]) { d[j] = 255; d[j + 3] = 255; }
            sctx.putImageData(im, 0, 0);
            // the shape is image-sized: the whole selection (null)
            editor.sel.drawInto(null, (ctx) => {
                ctx.globalCompositeOperation = subtract ? "destination-out" : "source-over";
                ctx.drawImage(shape, 0, 0);
            });
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

    /**
     * Release the in-app models (VRAM); the editor's "Free VRAM" button and the pre-run free
     * call this. The button is the user asking for memory now, so the caches of every other
     * tab go too (the button's own tab released its own, compositor and GL pool included,
     * before calling here); docs/PLAN_TILES.md phase A, item 5.
     */
    async freeHelpers() {
        for (const ed of this._editors) {
            if (ed === this.editor || ed.pointer) continue;
            try { ed.releaseCaches({ deep: true, mirrors: true }); } catch (err) { console.warn(err); }
        }
        return window.scumble.helpers.free();
    },
};

// ---- server events ------------------------------------------------------------------------

window.scumble.comfy.onEvent((ev) => api.dispatch(ev.type, ev.data));

api.addEventListener("executed", ({ detail }) => {
    // a picture run (the Realism Pass, an upscale of the whole picture) takes its own answer
    if (host.pictureRunEvent("executed", detail)) return;
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

/** A prompt ended on ComfyUI: no document counts it as an open render any more (see queueGenerate). */
function localRunEnded(detail) {
    const id = detail && detail.prompt_id;
    for (const ed of host.editors()) if (ed._localRuns) { if (id) ed._localRuns.delete(id); else ed._localRuns.clear(); }
}
api.addEventListener("execution_success", ({ detail }) => { localRunEnded(detail); host.pictureRunEvent("success", detail); });
api.addEventListener("execution_interrupted", ({ detail }) => { localRunEnded(detail); host.pictureRunEvent("interrupted", detail); });
api.addEventListener("status", ({ detail }) => {
    const info = detail && detail.status && detail.status.exec_info;
    if (info && info.queue_remaining === 0) for (const ed of host.editors()) if (ed._localRuns) ed._localRuns.clear();
});

api.addEventListener("execution_error", ({ detail }) => {
    localRunEnded(detail);
    if (!detail) return;
    // a picture run's failure goes to its caller (passPicture's sentence), not into the tab's status
    if (host.pictureRunEvent("error", detail)) return;
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
    } else if (realism.isPassNode(detail.node_type)) {
        // the DLSS pack's failures as sentences (docs/PLAN_0_1_42.md §3.4), not "Error in DLSS5EnhanceImages: ...";
        // marked, since a sentence need not read "failed" (the generate command stops its wait on it)
        const text = realism.hint(msg);
        ed.lastPassError = text;
        ed.setStatus(text);
    } else {
        ed.setStatus("Error in " + (detail.node_type || detail.node_id || "the graph") + ": " + msg);
    }
});
