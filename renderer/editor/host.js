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
import { glReleasePool, glToCanvas } from "./inpaint_filters_gl.js";
import { applyFilter } from "./inpaint_filters.js";
import { lightsToWords, detailRatio, loraPercent } from "./inpaint_relight.js";
import { withoutSecrets } from "./redact.js";
import { failKind, refusal } from "./inpaint_status.js";
import { canvasFits, fitInCanvas, largestFactor, canvasSizeRefusal, CANVAS_LIMIT_WORDS } from "./inpaint_sizelimit.js";

/**
 * What a result's history entry keeps of the click (S4): the prompt and the negative as typed, and which layer each
 * @img token named then ({ img1: id }, set_prompt's shape), so a reuse writes them for the references shown now.
 */
function sentTexts(snap) {
    if (!snap) return {};
    const refs = {};
    for (const [id, n] of snap.labels || []) refs["img" + n] = id;
    return { prompt: snap.prompt || "", negative: snap.negative || "", refs: Object.keys(refs).length ? refs : null };
}

// a run note that only explains how the run went, not what it left out or changed (item 45: those show red)
const HINT_NOTE = /^\(wording guessed from the graph\)$|^Prompt expansion went as None |^Served by .+ \(Comfy Router's fallback provider\)\.$/;
/** The kind of a line that appends a run's notes to the one before: red when a note says something was left out. */
function notesKind(editor, notes) {
    return notes.some((n) => !HINT_NOTE.test(String(n))) ? "warn" : (editor.statusKind || "info");
}
import { parse, toMarkers, namesFor, hasTokens, remap, referencesText, referencesRule, referenceName } from "./reftokens.js";
import { comfyRefSpec, comfyLayout, trimSlots, refName, resolveMarkers as resolveComfyMarkers } from "./comfyrefs.js";
import { frameOf, selectionBox, smallBox, smallBoxes, smallNote, SMALL_PX } from "./boxes.js";
import { promptPayload } from "./boxes_model.js";
import * as realism from "./realism.js";
import * as comfyprompt from "./comfyprompt.js";
import * as genpresets from "./genpresets.js";
import * as dialogs from "../dialogs.js";
import { tileBoxes, fusedSize } from "./inpaint_edges.js";
import { modelSize, DEPTH_LARGE, roundHalfEven } from "./inpaint_depth.js";
import { INTERACTIVE } from "./inpaint_pool.js";
import { editorPool, markStep } from "./inpaint_jobs.js";

const PROXY = "/comfy";

/**
 * The format a run of the recipe sends boxes in (item 28), or null when it sends none: the variant's `options.boxes`
 * ("flux3", "ideogram4"), for Generate and Generate new; Generate new with references may take its text route's own
 * options. A ComfyUI recipe: its `boxes.schema` when it declares the input FLUX 3's rows go to (the Inpaint Canvas
 * node's box_prompt writes them, comfyprompt.localBoxSchema).
 */
const boxesSchema = (r) => {
    if (!r) return null;
    if (r.kind !== "provider") return comfyprompt.localBoxSchema(r);
    const own = (r.options || {}).boxes, text = ((r.text && r.text.refs && r.text.refs.options) || {}).boxes;
    return typeof own === "string" ? own : typeof text === "string" ? text : null;
};

/**
 * The options a Generate new run sends (one rule for runGenerate and the Generate new dialog's boxes line, item 34): the
 * text route's own options where it has them (a Comfy Cloud recipe's text-to-image graph, item 35 V6), else the
 * variant's; with references the reference route's options over them.
 */
const textOptions = (r, withRefs) => {
    const t = (r && r.text) || {};
    const tr = t.refs || {};
    const own = t.options || (r && r.options) || null;
    return withRefs && tr.options ? { ...(own || {}), ...tr.options } : own;
};
const SUBFOLDER = "inpaint_canvas";

// How big the crop goes to an API provider. The app is for quality, so "max" is the default:
// the crop is emitted at the provider variant's documented maximum. "x2" / "x4" are the
// high-res fix - the crop at twice or four times its own size, still held under that maximum -
// and the last two keep the older behaviour. Every one of them is capped by the variant's
// `limits`, which is what keeps a model from being handed a size it answers with an error.
const MAX_EXPORT_SIDE = 32768;
const EXPORT_PERCENTS = [200, 150, 100, 75, 50, 33, 25, 10];
/**
 * The widest picture an encoder of Chromium writes, where an export can reach past it: a wider canvas comes out cut to
 * that side (measured 2026-10-22, 0.1.50 Q3: a WebP to 16,383 px). A JPEG is cut to 65,500 px a side and PNG takes
 * 65,535 (measured the same day), but no export comes near: exportPixels holds every export to MAX_EXPORT_SIDE, a
 * document's own size at 100 % included; lifting that needs a JPEG entry here.
 */
const ENCODER_MAX_SIDE = Object.freeze({ webp: { side: 16383, name: "a WebP" } });

/**
 * w × h with its longer side held to MAX_EXPORT_SIDE, the aspect kept (the Size and Canvas rows; each side clamped on
 * its own stretched the picture): [w, h, capped].
 * @param {number} w
 * @param {number} h
 * @returns {[number, number, boolean]}
 */
function capExportSide(w, h) {
    if (w <= MAX_EXPORT_SIDE && h <= MAX_EXPORT_SIDE) return [w, h, false];
    const s = MAX_EXPORT_SIDE / Math.max(w, h);
    return [Math.max(1, Math.min(MAX_EXPORT_SIDE, Math.round(w * s))), Math.max(1, Math.min(MAX_EXPORT_SIDE, Math.round(h * s))), true];
}

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
const STATE_KEYS = new Set(["width", "height", "base", "prompt", "groups", "layers", "history", "selection", "selectionBox", "selections", "guides", "seen", "crop", "upsample", "gen", "negative", "settings", "refs", "cutout", "maps"]);

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
/**
 * The relight panel's values for a new relight layer when the user picked none. `light_type` has none: unset is "From the
 * lights" (the Bria route takes the type lightsToWords derives), until the user picks one.
 */
const RELIGHT_DEFAULTS = Object.freeze({
    route: "app",
    strength: 100,
    style: "standard",
    preserve_details: true,
    interpolate: false,
    detail: true,
    enable_hr_fix: true,
    lora_strength: 100,   // percent, 0..100: the routes send it / 100 as strength_model
    steps: 4,
});

/**
 * What a result names about its run (QW5, docs/PLAN_COMFY_SDK.md S8): the recipe's model, where it ran and its seconds,
 * "FLUX 3 Image via Comfy Router, 23 s"; shown in the status line and the history, never stored in the document.
 */
function viaLine(r, route, seconds) {
    const model = (r && (r.name || r.id)) || "";
    const secs = Number.isFinite(+seconds) && seconds !== null ? `, ${Math.round(+seconds)} s` : "";
    return model || route ? `${model}${model && route ? " via " : ""}${route || ""}${secs}` : "";
}

/** The shipped local Klein recipes and their model family (0.1.50 Q1). */
const KLEIN_RECIPES = Object.freeze({ flux2_klein_local: "flux2", flux3_klein_local: "flux3" });
/** The torch error a Klein sampler raises when the text encoder's features do not fit the model's text input. */
const SHAPE_ERROR = /mat1 and mat2 shapes cannot be multiplied/i;

/**
 * A local run of a Klein model (0.1.50 Q1, docs/BUGS.md "mat1 and mat2"): its family ("flux2" / "flux3") and the model
 * and text encoder files the queued prompt `prompt` loads, or null for any other run. A shipped Klein recipe, or a
 * user's graph whose CLIPLoader has Flux.2's or FLUX 3's type and whose UNETLoader names a Klein file.
 * @returns {{ family: string, unet: string, clip: string } | null}
 */
function kleinRun(r, prompt) {
    // the prompt upsampler's loader (a Qwen3.5 file) is not the text encoder the sampler reads
    const up = new Set(((r && r.upsampler && r.upsampler.nodes) || []).map(String));
    const nodes = Object.entries(prompt || {}).filter(([id, n]) => n && n.inputs && !up.has(String(id))).map(([, n]) => n);
    const clip = nodes.find((n) => n.class_type === "CLIPLoader" && (n.inputs.type === "flux2" || n.inputs.type === "flux3"));
    const unet = nodes.find((n) => n.class_type === "UNETLoader");
    const file = (n, key) => (n && typeof n.inputs[key] === "string" ? n.inputs[key] : "");
    const family = (r && KLEIN_RECIPES[r.id]) || (clip && /klein/i.test(file(unet, "unet_name")) ? clip.inputs.type : null);
    return family ? { family, unet: file(unet, "unet_name"), clip: file(clip, "clip_name") } : null;
}

/** "W:H" in lowest terms for the upsampler's TARGET CANVAS line, or the ratio to two places for an odd one ("1.78:1"). */
function aspectOf(w, h) {
    if (!(w > 0 && h > 0)) return null;
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const g = gcd(Math.round(w), Math.round(h));
    const a = Math.round(w) / g, b = Math.round(h) / g;
    return a <= 32 && b <= 32 ? `${a}:${b}` : `${(w / h).toFixed(2)}:1`;
}

/** The note a run's upsampled prompt leaves: its start, the whole caption in the log. */
function upsampledNote(caption) {
    const t = String(caption || "").replace(/\s+/g, " ").trim();
    return `Prompt upsampled: "${t.length > 160 ? t.slice(0, 157) + "..." : t}" (the whole caption is in the log).`;
}

/**
 * The features a token of a Flux.2 Klein text encoder carries (three stacked hidden states: Qwen3 8B's 4096, Qwen3 4B's
 * 2560), which the model's text input takes: torch's "(AxB and CxD)" gives what arrived (B) and what the model takes (C).
 */
const KLEIN_FEATURES = Object.freeze({ 12288: { size: "9B", encoder: "Qwen3 8B" }, 7680: { size: "4B", encoder: "Qwen3 4B" } });
/** A Klein text encoder file's name for each model (the shipped recipes' files and Comfy-Org's: qwen_3_8b, qwen3_8b, ...). */
const KLEIN_ENCODER_NAME = Object.freeze({ "9B": /qwen_?3_?8b/i, "4B": /qwen_?3_?4b/i, flux3: /qwen_?3_?vl_?4b/i });

/**
 * The status line for a Klein run's sampler error "mat1 and mat2 shapes cannot be multiplied" (0.1.50 Q1): the text
 * encoder does not fit the model (Klein 9B reads Qwen3 8B's features, 4B Qwen3 4B's, FLUX 3 Image Klein Qwen3-VL
 * 4B's), so the sampler cannot take its output; the run's files and the row to change, the torch text at the end. When
 * the files' names already fit each other, the other causes instead: a ComfyUI too old for the encoder, or a file that
 * holds another model than its name says. The line reads "failed", which the generate command's wait stops on.
 */
function kleinEncoderHint(k, msg) {
    const raw = String(msg || "").trim().split(/\r?\n/)[0];
    const torch = ` (ComfyUI: ${raw})`;
    const enc = k.clip ? ` with the text encoder ${k.clip}` : "";
    const shapes = /\((\d+)x(\d+) and (\d+)x(\d+)\)/.exec(raw);
    const got = shapes ? KLEIN_FEATURES[shapes[2]] : null, want = shapes ? KLEIN_FEATURES[shapes[3]] : null;
    const right = " although the files' names fit each other";
    const arrived = got ? `; what arrived reads as ${got.encoder}'s output` : "";
    if (k.family === "flux3") {
        if (k.clip && KLEIN_ENCODER_NAME.flux3.test(k.clip)) {
            return `FLUX 3 Image Klein failed in the sampler: the text encoder's output does not fit the model,${right}: this run sent ${k.unet || "the model"}${enc}${arrived}. Either your ComfyUI is too old for FLUX 3 Image Klein (it needs 0.41 or newer: update it), or one of these files holds another model than its name says.${torch}`;
        }
        return `FLUX 3 Image Klein failed in the sampler: the text encoder does not fit the model. It takes the Qwen3-VL 4B encoder (qwen3vl_4b); this run sent ${k.unet || "the model"}${enc}. Pick that file in the Text encoder row of the Settings panel.${torch}`;
    }
    // the model's size from its file's name, else from what its text input takes
    const size = /9b/i.test(k.unet) ? "9B" : /4b/i.test(k.unet) ? "4B" : want ? want.size : "";
    const wants = size === "9B" ? " (Klein 9B, which takes qwen_3_8b)" : size === "4B" ? " (Klein 4B, which takes qwen_3_4b)" : "";
    if (size && k.clip && KLEIN_ENCODER_NAME[size].test(k.clip)) {
        // what the model's text input takes, when it is not what the model file's name says
        const model = want && want.size !== size ? `; the model takes ${want.encoder}'s output, as Klein ${want.size} does` : "";
        return `Flux.2 Klein failed in the sampler: the text encoder's output does not fit the model,${right}: this run sent ${k.unet || "the model"}${wants}${enc}${arrived}${model}. Either your ComfyUI is too old to build Klein's Qwen3 encoder (Klein needs one from January 2026 or newer: update it), or one of these files holds another model than its name says.${torch}`;
    }
    return `Flux.2 Klein failed in the sampler: the text encoder does not fit the model. Klein 9B takes the Qwen3 8B encoder (qwen_3_8b), Klein 4B the Qwen3 4B one (qwen_3_4b); this run sent ${k.unet || "the model"}${wants}${enc}. Pick the matching file in the Text encoder row of the Settings panel.${torch}`;
}

/**
 * The pieces of `src` (a canvas or a picture) that realism.compareTiles names, put together into a canvas the CPU keeps:
 * its RGBA bytes, one readback (the Realism Pass's answer against what went, 0.1.50 Q2). `kx`, `ky`: how much larger
 * `src` is than the picture the tiles were laid out on (an answer above 1×), drawn down with the browser's high-quality
 * filter; at 1 each piece is copied pixel for pixel.
 * @param {CanvasImageSource} src
 * @param {{ width: number, height: number, tiles: { sx: number, sy: number, sw: number, sh: number, dx: number, dy: number }[] }} m
 */
function mosaicPixels(src, m, kx = 1, ky = 1) {
    const k = document.createElement("canvas");
    k.width = m.width; k.height = m.height;
    const x = /** @type {CanvasRenderingContext2D} */ (k.getContext("2d", { willReadFrequently: true }));
    const one = kx === 1 && ky === 1;
    x.imageSmoothingEnabled = !one;
    if (!one) x.imageSmoothingQuality = "high";
    for (const t of m.tiles) x.drawImage(src, t.sx * kx, t.sy * ky, t.sw * kx, t.sh * ky, t.dx, t.dy, t.sw, t.sh);
    const d = x.getImageData(0, 0, m.width, m.height).data;
    k.width = k.height = 0;
    return d;
}

/** A run's id, for main's Cancel (providers/index.js `cancel`). */
const runIdOf = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * One provider request (main's `provider:edit`), under the run's id so the title row's Cancel can stop it; a refusal
 * comes back without Electron's "Error invoking remote method" wrapper.
 */
async function providerEdit(request, token) {
    // a Cancel while the crop was being made: nothing goes to the provider
    if (token && token.cancelled) throw new Error(token.said = "Cancelled before anything was sent to the provider: nothing runs or is charged.");
    try {
        return await window.scumble.providers.edit(token && token.runId ? { ...request, runId: token.runId } : request);
    } catch (err) {
        const words = String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
        // main's words for how the run ended (a Cancel: what it knew of the job), kept for cancel_run's answer
        if (token) token.said = words;
        throw new Error(words);
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
 * @property {(pluginId: string, where: string, err: any) => void} [pluginReport]
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
 * @property {(editor: any) => ({ models: { value: string, label: string, group: string, providers: { value: string, label: string, aspects: string[], classes: { value: number, label: string }[] }[] }[], pick: { model: string, provider: string, aspect: string | null, size: number | null } | null, working: (aspect: string, size: number) => [number, number] } | null)} [newCanvasChoices]   New with a model (item 34): the models, the preset to open on, the canvas of a preset; the node answers null
 * @property {(editor: any, target: { recipe: string, provider?: string | null, aspect: string | null, size: number, width: number, height: number } | null) => Promise<void>} [newCanvasChosen]   New made a canvas for a preset: remember it, select its recipe; null (a New of a size given by hand): forget the last preset
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
 * @property {(editor: any, box: number[], opts?: any) => Promise<any>} selectBox
 * @property {(editor: any, layer: any) => Promise<{ key: string, image: any }>} segmentKey
 * @property {(editor: any, points?: any[], box?: any, layer?: any) => Promise<{ logits: Float32Array, n: number, score: number }>} segmentLogits
 * @property {() => Promise<any>} freeHelpers
 * @property {boolean} removeSupported
 * @property {boolean} refTokens                                     @img1 in the prompt names a reference layer (docs/PLAN_REFS.md); the node has none yet
 * @property {(editor: any, over?: any, opts?: { keep?: boolean }) => Promise<any>} refLayout   the chosen route's name for each shown reference ({ names, over, none, local, cap, refuse, guess? }); the node answers null
 * @property {(editor: any) => { takes: boolean, count: number, schema: string | null } | null} boxSwitch   the Boxes switch under the prompt (docs/PLAN_BOXES.md S3d): does the recipe send boxes, how many the document holds, in which format (flux3, ideogram4); the node answers takes true, schema flux3 (its box_prompt output) and accepts a null editor
 * @property {boolean} boxesInEditor                                 the editor owns the boxes itself (inpaint_boxes.js: tool X, the Boxes section, the boxes in getValue): the node true, the app false (its Boxes plugin owns them; docs/PLAN_NODE_BOXES.md D5)
 * @property {() => any} removeModel
 * @property {(editor: any, req: { image: Uint8Array, mask: Uint8Array }) => Promise<any>} removeInApp
 * @property {boolean} [depthSupported]
 * @property {() => any} [depthModel]
 * @property {(editor: any, w: number, h: number) => Promise<{ image: Uint8Array, width: number, height: number }>} [depthInput]
 * @property {(editor: any, req: { image: Uint8Array, width: number, height: number }) => Promise<{ depth: Float32Array, min: number, max: number, ms: number, provider: string }>} [computeDepth]
 * @property {(editor: any, req: { image: Uint8Array, width: number, height: number }) => Promise<{ depth: Float32Array, min: number, max: number, ms: number, provider: string }>} [depthInApp]
 * @property {(editor: any, w: number, h: number, opts?: any) => Promise<{ image: Uint8Array, width: number, height: number }>} [pictureInput]
 * @property {(editor: any, box: any, w: number, h: number, opts?: any) => Promise<{ image: Uint8Array, width: number, height: number }>} [pictureInputBox]
 * @property {(editor: any, opts: { grid?: number, route?: string, onProgress?: (i: number, n: number) => void, signal?: AbortSignal, global?: any }) => Promise<{ data: Float32Array, w: number, h: number, fits: any[], route: string, grid: number } | null>} [depthDetail]
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
        // a percentage past the cap keeps the picture's aspect (0.1.50 Q3); a typed size was capped when it was set
        [w, h] = capExportSide(Math.max(1, w), Math.max(1, h));
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

    /**
     * "" when the export canvas of `fmt` can be made and written, else the refusal (0.1.50 Q3, docs/BUGS.md "Size
     * limits"): a Size or Canvas row past one canvas (Chromium makes such a canvas without complaint, draws nothing into
     * it and writes no file, or an empty one), and a WebP past 16,383 px a side (written cut to that side,
     * ENCODER_MAX_SIDE). PSD and ORA keep the document's own size.
     */
    exportSizeRefusal(editor, fmt) {
        if (fmt === "psd" || fmt === "ora") return "";
        const size = this.exportPixels(editor), frame = this.exportFrame(editor);
        const smaller = " Make the Size or the Canvas row in the Export section smaller (the export command's scale, width or canvas_width).";
        const over = (size && canvasSizeRefusal(size[0], size[1], "The export")) || (frame && canvasSizeRefusal(frame[0], frame[1], "The export's canvas"));
        if (over) return over + smaller;
        const [w, h] = frame || size || [editor.width | 0, editor.height | 0];
        const cap = ENCODER_MAX_SIDE[fmt];
        if (cap && Math.max(w, h) > cap.side) {
            return `The export would be ${w.toLocaleString("en-US")} × ${h.toLocaleString("en-US")} px, and ${cap.name} holds at most ${cap.side.toLocaleString("en-US")} px a side: save it as PNG, JPEG or TIFF, or make the Size or the Canvas row smaller.`;
        }
        return "";
    },

    /** What exportImage() encodes: the flattened image, scaled when the Size row asks for it, framed when the Canvas row does. */
    async exportCanvas(editor, fmt) {
        // refused before anything is flattened or drawn (0.1.50 Q3): red, a limit
        const refused = this.exportSizeRefusal(editor, fmt);
        if (refused) throw refusal(refused, "warn");
        if (editor.relightSettled) await editor.relightSettled();
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
        // a typed side past MAX_EXPORT_SIDE: what it became, for the status line (it was clamped without a word)
        /** @type {string[]} */
        const capNotes = [];
        const fmtSize = (w, h) => `${Math.round(w).toLocaleString("en-US")} × ${Math.round(h).toLocaleString("en-US")}`;
        if (quality != null) e.quality = Math.min(1, Math.max(0.1, +quality || 0.92));
        if (canvasWidth != null || canvasHeight != null) {
            // one of them alone keeps the frame's aspect from the picture; 0 / empty clears the frame
            const px = this.exportPixels(editor) || [editor.width | 0, editor.height | 0];
            let cw = Math.round(+canvasWidth || 0), ch = Math.round(+canvasHeight || 0);
            if (cw > 0 && !ch && canvasHeight == null && px[0]) ch = Math.max(1, Math.round(cw * px[1] / px[0]));
            if (ch > 0 && !cw && canvasWidth == null && px[1]) cw = Math.max(1, Math.round(ch * px[0] / px[1]));
            if (cw > 0 && !ch) ch = e.canvasH || px[1];
            if (ch > 0 && !cw) cw = e.canvasW || px[0];
            // past the cap: both sides down, the aspect kept, and the status line says so (0.1.50 Q3)
            if (cw > 0 && ch > 0) {
                const [fw, fh, capped] = capExportSide(cw, ch);
                if (capped) capNotes.push(`the canvas ${fmtSize(cw, ch)} became ${fmtSize(fw, fh)}`);
                cw = fw; ch = fh;
            }
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
            if (w > 0 && h > 0) {
                const [sw, sh, capped] = capExportSide(w, h);
                if (capped) capNotes.push(`the size ${fmtSize(w, h)} became ${fmtSize(sw, sh)}`);
                w = sw; h = sh;
            }
            e.width = Math.max(0, Math.min(MAX_EXPORT_SIDE, w));
            e.height = Math.max(0, Math.min(MAX_EXPORT_SIDE, h));
            if (e.width && dw) e.percent = Math.round(e.width / dw * 1000) / 10;
        } else if (percent != null) {
            e.percent = Math.min(400, Math.max(1, +percent || 100));
            e.width = 0; e.height = 0;
        }
        this.syncExportRow(editor);
        if (capNotes.length && editor.setStatus) editor.setStatus(`An export goes up to ${MAX_EXPORT_SIDE.toLocaleString("en-US")} px a side: ${capNotes.join(", ")} (the aspect kept).`, "warn");
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
    /**
     * The Preset row's data, or null when the recipe shows none (an API recipe; no shipped presets and fewer than two
     * file combos): `pts` the rows a preset stores, `presets` the list as the select shows it (the shipped ones first,
     * then the user's own; one of the user's with a shipped one's name replaces it), `matching` the one the rows hold
     * now (the user's own first), `own` the user's list, `shipped` the recipe file's. The commands list_settings and
     * apply_preset read the same (docs/PLAN_0_1_42.md F2b).
     */
    presetRow(editor, targets) {
        const r = this.recipe;
        if (!r || r.kind === "provider") return null;
        const keyOf = (t) => `${t.node.id}:${t.inputName}`;
        const shipped = Array.isArray(r.presets) ? r.presets : [];
        const files = this.presetTargets(editor, targets);
        const shippedKeys = new Set(shipped.flatMap((p) => Object.keys(p.values || {})));
        const pts = shipped.length ? targets.filter((t) => shippedKeys.has(keyOf(t)) || files.includes(t)) : files;
        if (!pts.length || (!shipped.length && pts.length < 2)) return null;
        const current = {};
        for (const t of pts) { const e = editor.settings[String(t.index)]; if (e) current[keyOf(t)] = String(e.value); }
        // the user's own (settings.recipePresets); one of a shipped one's name replaces it in the list
        const own = (this.presets || {})[r.id] || [];
        const ownNames = new Set(own.map((p) => p.name));
        const presets = [...shipped.filter((p) => !ownNames.has(p.name)).map((p) => ({ ...p, shipped: true })), ...own];
        // the user's own first: one saved with a shipped one's values stays theirs to pick and delete
        const holds = (p) => Object.entries(p.values || {}).every(([k, v]) => current[k] === String(v));
        const matching = own.find(holds) || presets.find(holds) || null;
        return { recipe: r, keyOf, shipped, own, presets, pts, matching };
    },

    renderPresets(editor, list, targets) {
        const row0 = this.presetRow(editor, targets);
        if (!row0) return;
        const { recipe: r, keyOf, shipped, own, presets, pts, matching } = row0;
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

    /**
     * The Settings rows of the selected local recipe whose file the server's list lacks: `[{ label, value, link }]`.
     * Until 0.1.45 such a row silently became the folder's first file (issue #4: a Flux file on most installs, and
     * "no edits done"); now the recipe's value stays (the select marks it, inpaint_canvas.js renderSettings) and the
     * run is refused with the download link from the recipe's `models`. `r` must be the selected recipe, since the
     * rows are its targets.
     */
    missingSettingFiles(editor, r = this.recipe) {
        if (!r || r !== this.recipe || !r.prompt || !editor || !editor.settings) return [];
        const out = [];
        // the prompt upsampler's rows (0.1.50 Q9): without its file the run goes as typed, with a note, not refused
        const up = new Set(((r.upsampler && r.upsampler.nodes) || []).map(String));
        for (const t of this.settingTargets()) {
            const entry = editor.settings[String(t.index)];
            if (!entry || entry.value == null || entry.value === "") continue;
            if (up.has(String(t.node.id))) continue;
            const k = editor.settingKind(t);
            if (k.kind !== "combo" || !k.options.length) continue;
            const value = String(entry.value);
            if (k.options.map(String).includes(value)) continue;
            out.push({ label: entry.label, value, link: this.modelLink(r, value) });
        }
        return out;
    },

    /** The download link a recipe's `models` gives for a file name (rows of "file (url)" per folder), or null. */
    modelLink(r, file) {
        for (const list of Object.values((r && r.models) || {})) {
            for (const row of Array.isArray(list) ? list : []) {
                const m = /^(.*?)\s*\((https?:\/\/[^)]+)\)\s*$/.exec(String(row));
                if (m && m[1] === String(file)) return m[2];
            }
        }
        return null;
    },

    /** Check if ComfyUI object info has the required models for the relight recipe; throws if missing. */
    checkComfyRelightModels(recipe, info) {
        if (!info) return;
        const loras = info.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] || [];
        const unets = info.UNETLoader?.input?.required?.unet_name?.[0] || [];
        const clips = info.CLIPLoader?.input?.required?.clip_name?.[0] || [];
        const vaes = info.VAELoader?.input?.required?.vae_name?.[0] || [];
        const checks = [
            { label: "UNet", file: "qwen_image_edit_2509_fp8_e4m3fn.safetensors", list: unets },
            { label: "Text encoder", file: "qwen_2.5_vl_7b_fp8_scaled.safetensors", list: clips },
            { label: "VAE", file: "qwen_image_vae.safetensors", list: vaes },
            { label: "Relight LoRA", file: "Qwen-Image-Edit-2509-Relight.safetensors", list: loras },
            { label: "Lightning LoRA", file: "Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors", list: loras },
        ];
        const missing = [];
        for (const item of checks) {
            if (!Array.isArray(item.list) || !item.list.includes(item.file)) {
                const link = this.modelLink(recipe, item.file);
                missing.push(`${item.label}: ${item.file}${link ? " (" + link + ")" : ""}`);
            }
        }
        if (missing.length) {
            throw new Error(`Your ComfyUI lacks ${missing.length === 1 ? "a model file this recipe needs" : "model files this recipe needs"}: ${missing.join("; ")}. Put the file in that models folder (and restart or refresh ComfyUI), then try again.`);
        }
    },

    /** The refusal for a run whose Settings rows name files the server lacks, or null when every file is there. */
    missingFilesRefusal(editor, r = this.recipe) {
        const miss = this.missingSettingFiles(editor, r);
        if (!miss.length) return null;
        const rows = miss.map((m) => `${m.label}: ${m.value}${m.link ? " (" + m.link + ")" : ""}`).join("; ");
        return `Your ComfyUI lacks ${miss.length === 1 ? "a model file this recipe needs" : "model files this recipe needs"}: ${rows}. Put the file in that models folder (and restart or refresh ComfyUI), or pick one of the server's files in the Settings panel, then try again.`;
    },

    /** A preset's values into the document's Settings rows; `{ rows, missing }` (rows named, files the server lacks). */
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
            : missing.length ? `Preset "${preset.name}": ${missing.join(", ")} not on the server, kept the current choice there.` : `Preset "${preset.name}" applied.`, !rows ? "info" : missing.length ? "warn" : "info");
        return { rows, missing };
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
        // `provider`: the run goes through runProvider / runUpscale and needs the document's run slot (`providerPending`);
        // the editor's generate() refuses it while the slot is held (the node's host never says so)
        if (r.kind === "provider") return { name: "result", wired: true, fallback: editor.genSettings.mode === "local", provider: true };
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
        for (const k of ["prompt", "negative"]) if (/\{@ref:/i.test(texts[k])) throw refusal(`${where(k)} holds "{@ref:", which Scumble keeps for itself: reword it.`);
        const idOf = new Map([...s.labels].map(([id, n]) => [n, id]));
        if (route === "none") {
            const replaced = [];
            for (const k of ["prompt", "negative"]) {
                const res = namesFor(texts[k], (key) => {
                    const id = key[0] === "?" ? key.slice(1) : idOf.get(+key.slice(3));
                    const l = id && editor.layers.find((x) => x.id === id);
                    return l ? l.name || "" : null;
                });
                if (res.missing.length) throw refusal(this.refError(editor, s, parse(res.missing[0])[0], k));
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
                throw refusal(this.refError(editor, s, { type: "token", text: e.token, n: e.n, id: e.kind === "parked" ? e.id : undefined, kind: e.kind }, k));
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
        if (!editor.base) throw refusal("Load an image first.");
        // one run per document: a second token would take the slot, and its end would clear it under the first (a Realism
        // Pass, an upscale), which then reads as idle (busy(), Close without asking, turnBlocked)
        if (editor.providerPending) throw refusal(RUN_GOING);
        const label = r.providerLabel || r.provider;
        if (r.edit === false) throw refusal(`${r.name || r.id} on ${label} makes images from the prompt alone: use "Generate new", not Generate.`);
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
            await editor.addResults([{ filename: ref.filename, subfolder: ref.subfolder, type: ref.type, x, y, width: w, height: h, align, canvas_node: editor.node.id, provider: r.provider, seed: answeredSeed(res), via: viaLine(r, label, res.seconds), ...sentTexts(snap) }]);
            // addResults writes its own line, so the cut-out note, the names the references went as and what the route
            // left out go on afterwards
            if (info.keepAlpha) editor.setStatus(`${editor.status} ${cutout ? "The layer is a cut-out on a transparent ground." : "The model returned no transparency, so the layer is opaque."}`, editor.statusKind || (cutout ? "info" : "warn"));
            const sentAs = named.pairs.map((p) => {
                const got = (res.refs || []).find((x) => x.ref === p.ref);
                return got ? `${p.label} → ${got.name}` : null;
            }).filter(Boolean);
            if (sentAs.length) editor.setStatus(`${editor.status} Named in the prompt: ${sentAs.join(", ")}.`, editor.statusKind || "info");
            const sentBoxes = res.boxes > 0 ? Math.floor(res.boxes) : 0;
            editor.lastSentBoxes = sentBoxes;
            if (sentBoxes) editor.setStatus(`${editor.status} Sent with ${sentBoxes} box${sentBoxes === 1 ? "" : "es"}.`, editor.statusKind || "info");
            if (editor.lastRunNotes.length) editor.setStatus(`${editor.status} ${editor.lastRunNotes.join(" ")}`, notesKind(editor, editor.lastRunNotes));
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
        // the adapter would round it, and the size checks and the bill would then be for another factor than asked
        if (f.whole && !Number.isInteger(n)) throw new Error(`${r.name || r.id} upscales by whole factors (${f.min} to ${f.max}), not ${n}.`);
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
     * The whole picture (`what` "picture") at 1× is refused on every upscaler: its answer would come back at the picture's
     * own size, which the landing cannot take (release review 2026-10-05); a fixed 1× model is only seen in its answer.
     */
    upscaleOutRefusal(r, w, h, factor, what = "box") {
        if (what === "picture" && factor != null && factor <= 1) {
            return `At 1× the whole picture would come back at its own size: upscale a selection at 1× (Select All for the whole picture), or pick a larger factor.`;
        }
        // the whole picture lands as one canvas: past it the answer would be paid for and could not land (S5)
        const area = (r && r.limits && r.limits.outPixels) || 0;
        if (what === "picture" && factor != null && !canvasFits(Math.round(w * factor), Math.round(h * factor))) {
            const best = largestFactor(w, h, r && r.factor, area);
            // 1× is refused for the whole picture by the rule above, so it is never the advice
            const fit = best != null && best > 1 && best < factor ? ` The largest factor that fits is ${best}×.` : " Upscale a selection instead, or scale the picture down first.";
            return `The picture is ${w} × ${h}; at ${factor}× it would become ${Math.round(w * factor)} × ${Math.round(h * factor)} px, ${CANVAS_LIMIT_WORDS}.${fit}`;
        }
        // the model's own area cap (limits.outPixels: Magnific Creative's 25.3 MP), which its adapter refuses too
        if (area && factor != null && Math.round(w * factor) * Math.round(h * factor) > area) {
            const { the, smaller } = upscaleWords(w, h, what);
            const best = largestFactor(w, h, r && r.factor, area);
            const fit = best != null && best < factor && !(what === "picture" && best <= 1) ? ` The largest factor that fits is ${best}×.` : "";
            // the answer rounded up and the cap down, so the answer never reads as the cap itself
            const got = Math.ceil(Math.round(w * factor) * Math.round(h * factor) / 1e5) / 10;
            const pick = fit ? `Pick a smaller factor or ${smaller}.` : `Pick ${smaller}.`;
            return `${the}; at ${factor}× the answer would be ${got} MP, more than ${(r && (r.name || r.id)) || "the model"} returns (${Math.floor(area / 1e5) / 10} MP). ${pick}${fit}`;
        }
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
        if (!editor.base) throw refusal("Load an image first.");
        if (editor.providerPending) throw refusal(RUN_GOING);   // as runProvider
        const scope = opts.scope === "document" ? "document" : "selection";
        const label = r.providerLabel || r.provider;
        const factor = this.upscaleFactorFor(r, opts.factor);
        const max = (r.limits && r.limits.max) || 2048;
        if (scope === "selection" && !(editor.getBounds && editor.getBounds())) throw refusal("Select an area first, or upscale the whole picture.");
        // the whole picture's answer replaces the base: not while a job would land in the old geometry (its resize lets
        // the upscale's own landing through, so the check is here, before anything is paid for)
        const blocked = scope === "document" && editor.turnBlocked ? editor.turnBlocked() : "";
        if (blocked) throw refusal(blocked);
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
        // `resizes`: the whole picture's landing resizes the document, so a Generate or a helper job started meanwhile is
        // refused (editor.generate and the helpers' starters read it), not left to land in the old geometry
        const token = { provider: r.provider, label, started: Date.now(), editor, runId: runIdOf(), resizes: scope === "document" };
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
        // the run's notes (Comfy Router: who served it, what it left out) after the landing's own line, as Generate does
        const runNotes = Array.isArray(res.notes) ? res.notes.map(String) : [];
        const sayNotes = () => { if (runNotes.length) editor.setStatus(`${editor.status} ${runNotes.join(" ")}`, notesKind(editor, runNotes)); };
        try {
            if (scope === "selection") {
                const info = prep.info;
                const [x, y, w, h] = info.bbox;
                const fin = await finishResultAsync(editor, info, prep.sel, res.bytes, res.mime);
                const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
                const ref = await this.uploadResult(fin.blob, `n${editor.node.id}_upscale_${stamp}.png`);
                // the prompt the upscale sent, its tokens already written as layer names
                const via = viaLine(r, label, res.seconds);
                await editor.addResults([{ filename: ref.filename, subfolder: ref.subfolder, type: ref.type, x, y, width: w, height: h, align: fin.align, canvas_node: editor.node.id, provider: r.provider, seed: answeredSeed(res), via, prompt: r.usesPrompt ? texts.prompt : "", negative: r.usesPrompt ? texts.negative : "", refs: null }]);
                const got = res.info && res.info.width ? ` (${res.info.width} × ${res.info.height} came back)` : "";
                // the upscale's own line in place of addResults', ending as a result's line does with the model, the
                // route and the seconds (QW5)
                editor.setStatus(`Upscaled the selection${got}: fitted back into ${w} × ${h} as a new layer · ${via}${texts.note ? " " + texts.note : ""}`);
                sayNotes();
                return { scope, provider: r.provider, recipe: r.id, factor, seconds: res.seconds, x, y, w, h, info: res.info || null, note: texts.note, notes: runNotes };
            }
            const land = await this.landWholePicture(editor, res.bytes, res.mime, { label, seconds: res.seconds, W, H, note: texts.note });
            sayNotes();
            return { scope, provider: r.provider, recipe: r.id, factor, seconds: res.seconds, from: [W, H], width: land.width, height: land.height, answered: land.answered, info: res.info || null, note: texts.note, notes: runNotes };
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
     * empty answer, one at the picture's own size, a landing wholeLandingRefusal refuses (the size changed, a job that
     * would land in the old geometry), and a resize the editor refused (its status). `gone`: the caller's closed-tab test.
     * -> { width, height, answered: [aw, ah] }
     */
    async landWholePicture(editor, bytes, mime, { label, seconds = 0, W, H, note = "", gone = () => false }) {
        const img = await bytesToImage(bytes, mime);
        const aw = img.naturalWidth || img.width, ah = img.naturalHeight || img.height;
        if (!(aw > 0 && ah > 0)) throw new Error(`${label} answered with an empty picture.`);
        let nw = aw, nh = Math.max(1, Math.round(H * aw / W));
        if (nw === W && nh === H) throw new Error(`${label} answered at the picture's own size (${aw} × ${ah}); nothing to do.`);
        // a model that picks its own factor can answer past what one canvas holds: the paid answer lands scaled to fit
        // (the user, 2026-10-13: scale it down rather than refuse it), and the line says so in red
        let fitted = "";
        if (!canvasFits(nw, nh)) {
            const [fw, fh] = fitInCanvas(nw, nh);
            fitted = ` The answer was ${aw} × ${ah}, ${CANVAS_LIMIT_WORDS}: it landed scaled to ${fw} × ${fh}.`;
            nw = fw; nh = fh;
        }
        const refused = await this.wholeLandingRefusal(editor, W, H, gone);
        if (refused) throw new Error(`${label}: ${refused}`);
        const nb = document.createElement("canvas");
        nb.width = nw; nb.height = nh;
        const nctx = nb.getContext("2d");
        nctx.imageSmoothingEnabled = true;
        nctx.imageSmoothingQuality = "high";
        nctx.drawImage(img, 0, 0, nw, nh);
        await editor.resizeImage(nw, nh, { base: nb });
        nb.width = nb.height = 0;
        if (editor.width !== nw || editor.height !== nh) throw new Error(editor.status || "the upscaled picture could not be taken");
        editor.setStatus(`${label} upscaled the picture in ${Math.round(seconds)} s: ${W} × ${H} is now ${nw} × ${nh}, every layer scaled along (Ctrl+Z takes it back).${fitted}${note ? " " + note : ""}`, fitted ? "warn" : "info");
        return { width: nw, height: nh, answered: [aw, ah], fitted: !!fitted };
    },

    /**
     * The net before a whole-picture landing resizes the document (landWholePicture; realismWhole above 1×): "" when it
     * may, else why not (the caller prefixes its label, adds nothing and changes nothing). The run held the document's
     * slot (providerPending, `resizes`), so Generate, the helpers and a turn were refused meanwhile; this catches what
     * got past that: the size changed since `W` × `H` went out, and turnBlocked's conditions without the run's own slot (a
     * helper job, a render on the user's ComfyUI, a load). A save or a held stroke is waited for (up to 30 s) first.
     * `gone`: the caller's closed-tab test (the wait ends on it).
     */
    async wholeLandingRefusal(editor, W, H, gone = () => false) {
        const t0 = Date.now();
        const busy = () => !!editor._docSaving || !!(editor.gestureHeld && editor.gestureHeld());
        while (busy() && !gone() && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 100));
        if (gone()) return "the document was closed; nothing was changed.";
        if (editor.width !== W || editor.height !== H) return `the picture's size changed while it ran (${W} × ${H} is now ${editor.width} × ${editor.height}); nothing was changed.`;
        if (editor._localRuns && editor._localRuns.size) return "a render on your ComfyUI is still running on this document: its result would land where the picture was. Nothing was changed; run it again when the render is in.";
        if (editor.segmentPending || editor.cutoutPending || editor.objectsPending || editor._pointPending || editor._loading) return "another job on this document (a selection by text, a cutout, the object tool, a load) would land where the picture was. Nothing was changed; run it again when that job is in.";
        if (busy()) return "the document stayed busy (a save, or a held stroke): nothing was changed.";
        return "";
    },

    /**
     * The whole picture through the selected upscale recipe on the user's ComfyUI (docs/PLAN_0_1_42.md U2): the base
     * alone goes out (drawn at its size, stored in the mirror and on the server, uploadInput), the recipe's graph runs
     * with the canvas node as a loader of that picture (comfyprompt.wholePicturePrompt: the Settings rows and the factor
     * written, a PreviewImage on the result), queued behind the user's jobs (comfyPictureRun), and the answer becomes the
     * new base with every layer, mask and the selection scaled along (landWholePicture, one undo step). Refused before
     * anything is drawn or sent: a graph that reads more than the picture from the canvas node, no connection, node types
     * the server lacks, a document that is busy (turnBlocked), a picture past the recipe's `limits` (the long side `max`,
     * the answer's long side `out` at the factor; an upscale model picks its own factor, so `out` is not checked), a factor
     * of 1 (upscaleOutRefusal). The document is busy like a run meanwhile (a token that `resizes`: Generate and the helper
     * jobs are refused): the title row's timer names the recipe and its Cancel takes the job off the server, or, pressed
     * while the answer is fetched, lands nothing; closing the tab ends it too and lands nothing. The landing is
     * landWholePicture's (its net: wholeLandingRefusal). The loader gives RGB: a cut-out picture comes back opaque.
     * `factor`: what the dialog or the command asked (the recipe's default when left out; null for a fixed one);
     * `deadline` (a time in ms, 0 for none): comfyPictureRun's hard end, the upload's too.
     * -> { scope: "document", recipe, factor, seconds, from, width, height, answered } (width null when the tab was closed)
     * @param {any} editor
     * @param {{ factor?: any, deadline?: number }} [opts]
     */
    async runComfyUpscale(editor, { factor: want = undefined, deadline = 0 } = {}) {
        const r = this.recipe;
        if (!r || r.kind === "provider" || r.task !== "upscale" || !r.prompt) throw new Error("Pick an upscale recipe on ComfyUI first (Upscale shows them).");
        if (!editor.base) throw refusal("Load an image first.");
        if (editor.providerPending) throw refusal(RUN_GOING);
        const label = r.name || r.id;
        const shape = comfyprompt.wholePictureRefusal(r);
        if (shape) throw new Error(shape);
        if (!this.connected) throw refusal("Not connected to ComfyUI.");
        const factor = this.upscaleFactorFor(r, want);
        // the classes this route queues: the recipe's own with the loader for the canvas node, and PreviewImage
        const missing = comfyprompt.wholePictureClasses(r).filter((n) => this.objectInfo && !this.objectInfo[n]);
        if (missing.length) throw new Error("The server lacks these node types: " + missing.join(", "));
        // the answer replaces the base: not while a job would land in the old geometry
        const blocked = editor.turnBlocked ? editor.turnBlocked() : "";
        if (blocked) throw refusal(blocked);
        const W = editor.width, H = editor.height;
        const size = this.upscaleSizeRefusal(r, W, H, factor, "picture");
        if (size) throw new Error(size);
        const by = factor != null ? `${factor}×` : "the model's own factor";
        // `resizes`: the landing resizes the document (see runUpscale)
        const token = { provider: "comfyui", label, started: Date.now(), editor, resizes: true };
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
            if (!gone()) editor.setStatus(text, failKind(err));
            return Object.assign(new Error(text), { kind: err && err.kind, statusKind: failKind(err) });
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
                {
                    const lacks = this.missingFilesRefusal(editor, r);   // a file the server lacks (issue #4): refused before the queue
                    if (lacks) throw new Error(lacks);
                }
                const prompt = comfyprompt.wholePicturePrompt(r, ref, factor, editor.settings);
                res = await this.comfyPictureRun(editor, prompt, comfyprompt.WHOLE_OUTPUT, { label, token, front: false, deadline, timeoutMs: 1800000 });
                // a Cancel during the answer's fetch (comfyPictureRun stops watching the token once the job answered):
                // honoured here, so nothing lands, as cancel_run promises
                if (token.cancelled && !gone()) throw Object.assign(new Error(`${label} cancelled.`), { kind: "cancelled" });
            } finally {
                // the answer is in (or the run ended): the timer and Cancel leave the title row; the document stays held
                // until the answer has landed (endRun below)
                this.endRunRow(token);
            }
            if (gone()) return { scope: "document", recipe: r.id, factor, seconds: res.seconds, from: [W, H], width: null, height: null, answered: null };
            const land = await this.landWholePicture(editor, res.bytes, res.mime, { label, seconds: res.seconds, W, H, note: "", gone });
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
        if (blocked) throw refusal(blocked);
        const width = Math.max(64, Math.round(opts.width || editor.width || 1024));
        const height = Math.max(64, Math.round(opts.height || editor.height || 1024));
        // the frame the plugins' image coordinates (the boxes) are measured in: the answer may come back at another size
        const drawnOn = { width: editor.width || 0, height: editor.height || 0 };
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
            // else the variant's (textOptions: the Generate new dialog reads the same rule)
            const options = textOptions(r, withRefs);
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
                // the boxes are fractions of the document: an asked shape other than its own stretches them (item 34;
                // the dialog says the same under its aspect)
                const stretched = boxes.length ? genpresets.stretchNote([drawnOn.width, drawnOn.height], [width, height], genpresets.aspectsOf(r), opts.aspect || null) : "";
                if (stretched) preNotes.push(stretched);
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
        // a model that rounds or tiers the size (FLUX 3's 4k tier answers 5456 x 3072 for 4096 x 2304) lands a picture of
        // another size: what the plugins keep in image coordinates follows it, as after a resize (the boxes were fractions
        // of the frame for the model, so they still are). Generate new clears the undo history, so there is no step to share
        if (drawnOn.width > 0 && drawnOn.height > 0 && (c.width !== drawnOn.width || c.height !== drawnOn.height)) {
            this.changed(editor, { geometry: { kind: "resize", m: [c.width / drawnOn.width, 0, 0, c.height / drawnOn.height, 0, 0], from: drawnOn, to: { width: c.width, height: c.height } } });
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
        editor.setStatus(`${label} answered after ${Math.round(res.seconds)} s: a new ${c.width} × ${c.height} base image${cutout ? (gotAlpha ? " with a transparent background" : " (the model returned no transparency)") : ""}.${sentAs.length ? ` Named in the prompt: ${sentAs.join(", ")}.` : ""}${sentBoxes ? ` Sent with ${sentBoxes} box${sentBoxes === 1 ? "" : "es"}.` : ""}${stay}${notes.length ? " " + notes.join(" ") : ""}`, (cutout && !gotAlpha) || notes.some((n) => !HINT_NOTE.test(String(n))) ? "warn" : "info");
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

    /**
     * New with a model (item 34, docs/PLAN_NEW_PRESETS.md section 8): the models that make a new image with their
     * providers' aspects and size classes ({ models, pick, working(aspect, size) }, the shell's newCanvasChoices), or
     * null without the shell (the dialog then asks for width and height only). The node's host answers null.
     */
    newCanvasChoices(editor) {
        return this.shell && this.shell.newCanvasChoices ? this.shell.newCanvasChoices(editor) : null;
    },

    /**
     * New made a canvas for a preset ({ recipe, provider, aspect, size, width, height }, stored by the editor as
     * `genSettings.target`): the shell remembers it for the next New and selects the recipe (app-wide). Null after a New
     * of a size given by hand: the next New opens on "Any size".
     */
    async newCanvasChosen(editor, target) {
        if (this.shell && this.shell.newCanvasChosen) await this.shell.newCanvasChosen(editor, target);
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
        return this.cancelRuns(null).length;
    },

    /**
     * Cancel the runs in the title row (API runs, and the picture runs on the user's ComfyUI that hold a document: the
     * pass, an upscale of the whole picture, whose job is taken off the server), every tab's or only `editor`'s
     * (the cancel_run command, docs/PLAN_0_1_42.md F2a). Returns the tokens it cancelled.
     */
    cancelRuns(editor) {
        const runs = Array.from(this._providerRuns).filter((t) => !editor || t.editor === editor);
        for (const t of runs) t.cancelled = true;
        for (const t of runs) if (t.runId && window.scumble && window.scumble.providers && window.scumble.providers.cancel) window.scumble.providers.cancel(t.runId).catch(() => {});
        return runs;
    },

    /** The runs in the title row that hold `editor` (its close stops them, removeEditor). */
    runsOf(editor) {
        return Array.from(this._providerRuns).filter((t) => t.editor === editor);
    },

    /** A run's answer is in (or it failed): its timer and Cancel leave the title row, its live steps the bar. */
    endRunRow(token) {
        if (!this._providerRuns.delete(token)) return;
        if (token.live && token.editor && token.editor.runProgress) token.editor.runProgress.done(String(token.runId));
        this.notifyProviderRuns();
    },

    /**
     * A provider run's live progress (Comfy Cloud's events through main's `provider:progress`, docs/PLAN_COMFY_SDK.md
     * 3.5 and section 4): its document's bar shows it under the run's label. A frame with a status alone keeps the
     * timer; the first with a share starts the run; sampler steps (should a provider send them) go in as ComfyUI's
     * events, a share alone as `fraction` (node k of n, the running node's part). A local prompt that runs in the
     * same tab keeps the bar, the provider's run beside it (RunProgress).
     */
    providerProgress(p) {
        const id = p && p.runId ? String(p.runId) : "";
        if (!id) return;
        const token = Array.from(this._providerRuns).find((t) => t.runId === id);
        if (!token || token.cancelled) return;
        const ed = token.editor;
        if (!ed || !ed.runProgress || !this._editors.includes(ed)) return;
        if (token.promptId !== id) { token.promptId = id; this.syncRunBars(); }
        token.live = true;
        const share = p.value != null || p.nodesTotal != null;
        const stepped = p.step != null && +p.steps > 0;
        // a status alone (queued, running, the end) leaves the bar to the run's timer: a "running" taken as a start
        // would take the bar from a local prompt that runs in the same tab
        if (!share && !stepped) return;
        const rp = ed.runProgress;
        if (!rp.has(id)) this.trackRun(ed, id, +p.nodesTotal || 1);
        if (p.node != null && String(p.node) !== token.liveNode) { token.liveNode = String(p.node); rp.event("executing", { prompt_id: id, node: token.liveNode }); }
        if (stepped) rp.event("progress", { prompt_id: id, node: p.node != null ? String(p.node) : token.liveNode, value: +p.step, max: +p.steps });
        else if (share) rp.event("fraction", { prompt_id: id, value: p.value, nodes_done: p.nodesDone, nodes_total: p.nodesTotal });
    },

    /** The ids of the provider runs whose live steps a bar shows: the local ComfyUI's queue knows nothing of them. */
    liveRunIds() {
        const ids = new Set();
        for (const t of this._providerRuns) if (t.live && t.runId) ids.add(String(t.runId));
        return ids;
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
        this.syncRunBars();
    },

    /** The status row's bar of each document: the seconds of the run it waits for (docs/PLAN_0_1_48.md S3). */
    syncRunBars() {
        const runs = Array.from(this._providerRuns);
        for (const ed of this._editors) {
            if (!ed.runProgress) continue;
            const t = runs.find((r) => r.editor === ed);
            ed.runProgress.timer(t ? { label: t.label, started: t.started, promptId: t.promptId || null } : null);
        }
    },

    // ---- the status row's bar: ComfyUI's events for the prompts a document queued (docs/PLAN_0_1_48.md S3) ----

    /** A prompt the document queued: its bar follows it; events that came before the queue answered are replayed. */
    trackRun(editor, promptId, nodes) {
        if (!editor || !editor.runProgress || !promptId || !this._editors.includes(editor)) return;
        editor.runProgress.track(promptId, nodes);
        const early = this._earlyProgress && this._earlyProgress.get(String(promptId));
        if (early) {
            this._earlyProgress.delete(String(promptId));
            for (const [type, detail] of early.events) editor.runProgress.event(type, detail);
        }
    },

    /**
     * How many nodes ComfyUI runs of an API-format prompt: the output nodes (the server's object_info says which) and
     * what they read, so a node left without a reader (a reference slot this run does not fill) is not counted. All of
     * them when the server's node list is not known.
     */
    runNodeCount(prompt) {
        const ids = Object.keys(prompt || {});
        const info = this.objectInfo;
        if (!info) return ids.length;
        const roots = ids.filter((id) => { const n = prompt[id]; const d = n && info[n.class_type]; return !!(d && d.output_node); });
        if (!roots.length) return ids.length;
        const seen = new Set(), stack = roots.slice();
        while (stack.length) {
            const id = stack.pop();
            if (seen.has(id) || !prompt[id]) continue;
            seen.add(id);
            for (const v of Object.values(prompt[id].inputs || {})) if (Array.isArray(v) && v.length === 2 && prompt[String(v[0])]) stack.push(String(v[0]));
        }
        return seen.size || ids.length;
    },

    /**
     * A tracked prompt that waits while others run can leave the queue without an event (deleted in ComfyUI's queue,
     * a lost end event): on a status with jobs left, /queue is read (at most every 2 s) and what it no longer holds
     * goes from the bars.
     */
    async checkTrackedRuns() {
        // a provider's run (Comfy Cloud) is not in this server's queue: it is left to its own end
        const live = this.liveRunIds();
        const tracked = this._editors.filter((e) => e.runProgress && (Array.from(e.runProgress.runs.keys()).some((id) => !live.has(id)) || e.runProgress.dropped.size));
        if (!tracked.length || this._checkingRuns || Date.now() - (this._runsChecked || 0) < 2000) return;
        this._checkingRuns = true;
        this._runsChecked = Date.now();
        try {
            const r = await api.fetchApi("/queue", { signal: AbortSignal.timeout(15000) });
            if (r.status !== 200) return;
            const q = await r.json();
            const held = new Set([...(q.queue_running || []), ...(q.queue_pending || [])].filter(Array.isArray).map((it) => String(it[1])));
            for (const ed of tracked) {
                for (const id of Array.from(ed.runProgress.runs.keys())) {
                    if (live.has(id)) continue;
                    // a prompt queued a moment ago may not be listed yet
                    if (!held.has(id) && Date.now() - ed.runProgress.runs.get(id).tracked > 3000) ed.runProgress.done(id);
                }
                // a prompt a lost socket or a stale "queue empty" dropped shows again while the queue holds it, however
                // long the socket was away; one the queue no longer holds is forgotten
                for (const id of Array.from(ed.runProgress.dropped.keys())) {
                    if (held.has(id)) ed.runProgress.revive(id);
                    else ed.runProgress.dropped.delete(id);
                }
            }
        } catch (_) { /* the server did not answer: the next status asks again */ } finally {
            this._checkingRuns = false;
        }
    },

    /** One of ComfyUI's progress events: to the document that waits for its prompt, or held a few seconds for one. */
    progressEvent(type, detail) {
        const id = detail && detail.prompt_id != null ? String(detail.prompt_id) : null;
        if (!id) return;
        // wants(): a prompt a stale "queue empty" or a lost socket dropped from the bar takes it back with its own events
        const ed = this._editors.find((e) => e.runProgress && e.runProgress.wants(id));
        if (ed) { ed.runProgress.event(type, detail); return; }
        // the POST's answer (the prompt id) can come after the first events of a fast prompt
        if (!this._earlyProgress) this._earlyProgress = new Map();
        const now = Date.now();
        for (const [k, v] of this._earlyProgress) if (now - v.at > 10000) this._earlyProgress.delete(k);
        let e = this._earlyProgress.get(id);
        if (!e) { if (this._earlyProgress.size >= 32) return; e = { at: now, events: [] }; this._earlyProgress.set(id, e); }
        if (e.events.length < 256) e.events.push([type, detail]);
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
        // the token's own prompt: the bar shows its steps under the token's label (RunProgress.state)
        if (token) { token.promptId = String(id); this.syncRunBars(); }
        if (editor) this.trackRun(editor, id, this.runNodeCount(prompt));
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
            // the bar waits no more either: a cancelled or dropped job gets no end event from ComfyUI
            if (editor && editor.runProgress) editor.runProgress.done(id);
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
     * output would pass 7680 × 4320 or 27.9 MP is scaled down first (realism.fitPlan, the browser's high-quality resampling, as the
     * editor's Resize scales), and the note says so. 1 keeps the refusal past the cap.
     * The answer is held against what went (0.1.50 Q2), pixel for pixel on pieces spread over the picture
     * (realism.compareTiles): nearly the same picture at a Strength of realism.UNCHANGED_MIN_STRENGTH or more adds a note
     * that the pass changed nothing, and `unchanged` holds the difference (realism.pictureDiff), else null; every pass's
     * difference goes to the log.
     * -> { bytes, mime: "image/png", width, height, seconds, note, factor, sent: [w, h], scaled: [w, h] | null, unchanged }
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
        // what went, read where its answer is held against it (0.1.50 Q2: an answer equal to it means the pass did
        // nothing): pieces of the picture without its padding, pixel for pixel
        const tiles = up ? realism.compareTiles(fw, fh) : realism.compareTiles(w, h);
        const sentTiles = mosaicPixels(c, tiles);
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
                    if (editor && editor.setStatus) editor.setStatus(fellBack, "warn");
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
        // the answer held against what went (0.1.50 Q2), the same pieces (above 1× drawn down by the answer's scale): the
        // same picture back means the pass changed nothing on this card (it still lands, said in red); below a small
        // Strength nothing is said (an unchanged picture is what Strength 0 asks for). Every pass's numbers go to the log,
        // so the first passes on a card show how far the bounds are
        const diff = realism.pictureDiff(sentTiles, mosaicPixels(img, tiles, up ? aw / w2 : 1, up ? ah / h2 : 1));
        const unchanged = realism.unchangedAt(diff, values.intensity);
        if (unchanged) notes.push(realism.unchangedNote(support.gpu, diff, mode.factor));
        try {
            const pieces = tiles.tiles.length > 1 ? `${tiles.tiles.length} pieces of ${tiles.tiles[0].sw} × ${tiles.tiles[0].sh} px` : `${tiles.width} × ${tiles.height} px`;
            const line = `${L}: the answer against what went (${pieces}${up ? `, the answer drawn down from ${mode.text}` : ", pixel for pixel"}): ${realism.diffText(diff)}; Strength ${values.intensity}${unchanged ? ": said to have changed nothing" : ""}`;
            if (window.scumble && window.scumble.log) Promise.resolve(window.scumble.log.add({ level: "info", source: "realism", message: line })).catch(() => { /* the log is optional */ });
        } catch (_) { /* the log is optional */ }
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
            factor: mode.factor, sent: [w2, h2], scaled: plan.scaled ? [fw, fh] : null, fellBack: !!fellBack,
            unchanged: unchanged ? diff : null,
        };
    },

    /**
     * "" when realismWhole would start on this document now, else the sentence it refuses with, before anything is read
     * or sent: the server, a run going on the document (an API run, the pass, a local render still on the server), the
     * document still loading, no picture, past 7680 × 4320 or 27.9 MP (the size before anything is read: a 15k document is refused
     * without its flatten). `status`'s realism answers from it too, so an agent is never told ready for a refused pass.
     * `factor` (R-U): a factor no mode has first; above 1× the document is resized when the answer lands, so not while
     * a job would land where the picture was (turnBlocked, as for an upscale of the whole picture), and the size is
     * realism.fitPlan's (a picture whose output would pass the cap is scaled down instead; a fit under 64 px, or one that
     * would not get larger, which is every picture already past the cap, is refused). `status` asks at 1×.
     */
    realismWholeRefusal(editor, { factor = 1 } = {}) {
        const c = this.realismWholeCheck(editor, { factor });
        return c ? c.text : null;
    },

    /**
     * realismWholeRefusal's sentence with its status kind (item 45): plain for the user's state (not connected, a run
     * going, still loading, no picture, the document busy), "warn" for a limit or what the server cannot do. Null: none.
     */
    realismWholeCheck(editor, { factor = 1 } = {}) {
        const L = realism.LABEL;
        const say = (text, kind) => (text ? { text, kind } : null);
        const mode = realism.modeFor(factor);
        if (!mode) return say(realism.factorRefusal(factor), "warn");
        const support = this.realismSupport();
        const state = (this.server && this.server.state) || "disconnected";
        if (!support.ok) return say(support.reason, state === "connected" || state === "missing-node" ? "warn" : "info");
        if (editor.providerPending || (editor._localRuns && editor._localRuns.size)) return say(`${L}: a run is still going on this document.`, "info");
        if (editor._loading) return say(`${L}: the document is still loading.`, "info");
        if (!editor.base || !editor.width || !editor.height) return say(`${L}: load an image first.`, "info");
        if (mode.factor === 1) return say(realism.wholeRefusal(editor.width, editor.height), "warn");
        const blocked = editor.turnBlocked ? editor.turnBlocked() : "";
        if (blocked) return say(`${L}: ${blocked}`, "info");
        return say(realism.fitPlan(editor.width, editor.height, mode.factor).refusal, "warn");
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
     * output would pass 7680 × 4320 or 27.9 MP (realism.MAX_AREA, measured) is scaled down before it goes, so the answer,
     * and the document, come back as large as the pass allows. The landing goes through resizeImage's `base` path while the run slot is held
     * (a token that `resizes`: Generate and the helper jobs are refused meanwhile), after wholeLandingRefusal's net; from
     * the resize on the Cancel is gone from the title row (it could no longer stop the landing).
     * An answer that is the picture that went (passPicture's `unchanged`, 0.1.50 Q2) still lands, and the status line
     * says in red that the pass changed nothing on this card; the note carries the sentence.
     * -> { layer, seconds, note, changed, factor, from: [W, H], width, height, unchanged } (layer null when the tab was
     *    closed meanwhile)
     */
    async realismWhole(editor, { deadline = 0, factor = 1 } = {}) {
        const L = realism.LABEL;
        const say = (text, kind) => { editor.setStatus(text, kind); return refusal(text, editor.statusKind || "info"); };
        const refused = this.realismWholeCheck(editor, { factor });
        if (refused) throw say(refused.text, refused.kind);
        const W = editor.width, H = editor.height;
        const mode = realism.modeFor(factor);
        const up = mode.factor > 1;
        const plan = up ? realism.fitPlan(W, H, mode.factor) : null;
        // above 1× the landing resizes the document: `resizes` refuses a Generate or a helper job meanwhile (see runUpscale)
        const token = { provider: "comfyui", label: L, started: Date.now(), editor, resizes: up };
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
        const cancelled = () => Object.assign(new Error(`${L} cancelled.`), { hint: `${L} cancelled.`, kind: "cancelled" });
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
                if (editor.relightSettled) await editor.relightSettled();
                const c = editor.flattenToCanvas({ forRun: true, upTo });
                try { bytes = await canvasBytes(c); } finally { c.width = c.height = 0; }
            }
            const goes = !up ? `${W} × ${H}` : plan.scaled ? `${W} × ${H}, scaled down to ${plan.fit[0]} × ${plan.fit[1]}, at ${mode.text}` : `${W} × ${H} at ${mode.text}`;
            editor.setStatus(`${L}: sending the picture (${goes}) to your ComfyUI ...`);
            const out = await this.passPicture(editor, bytes, "image/png", { token, deadline, factor: mode.factor });
            bytes = null;
            const none = { layer: null, seconds: out.seconds || 0, note: "", changed: false, factor: mode.factor, from: [W, H], width: null, height: null, unchanged: false };
            if (gone()) return none;
            // the title row's Cancel stays until the layer is in: pressed after the answer, nothing lands either
            if (token.cancelled) throw cancelled();
            const img = await bytesToImage(out.bytes, out.mime);
            const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
            // above 1×: the document's new size (the answer's width, the picture's aspect, as an upscale of the whole
            // picture lands; the answer's own height where that rounding would pass the 1× caps, realism.landingSize);
            // the layer's pixels the answer as it is, or stretched by the pixel or two the pack's even rounding moved
            // its height
            const land = up ? realism.landingSize(W, H, w, h) : null;
            const nw = up ? land.w : W, nh = up ? land.h : H;
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
                // the net before the resize (release review 2026-10-05): the size the pass started from, and no job that
                // would land in the old geometry; refused with the reason, nothing added
                const refused = await this.wholeLandingRefusal(editor, W, H, gone);
                if (gone()) return none;
                if (refused) throw new Error(`${L}: ${refused}`);
                if (token.cancelled) throw cancelled();
                // from here the landing cannot be stopped (half of it would be in): the timer and Cancel leave the title
                // row, so neither it nor cancel_run reports a cancel that nothing honours; the slot stays held until the
                // layer is in (endRun below)
                this.endRunRow(token);
                // the document by the factor (Q29): the base scaled as Resize scales it, given as the new base so the
                // landing goes through while this run holds the slot (resizeImage's `base`); every layer, mask and the
                // selection scale along, one `canvas` undo step, which the pass layer below joins (no step of its own)
                const nb = document.createElement("canvas");
                nb.width = nw; nb.height = nh;
                const nctx = nb.getContext("2d");
                nctx.imageSmoothingEnabled = true;
                nctx.imageSmoothingQuality = "high";
                editor.drawBaseInto(nctx, 0, 0, nw, nh);
                // the step is found by identity: with a full history the push drops the oldest, so the length stays
                const last0 = editor.undo[editor.undo.length - 1];
                try { await editor.resizeImage(nw, nh, { base: nb }); } finally { nb.width = nb.height = 0; }
                // a closed tab ends it here too
                if (gone()) return none;
                if (editor.width !== nw || editor.height !== nh) throw new Error(editor.status || `${L}: the picture could not be resized.`);
                // the Undo history names the pass, not "Upscale image"
                const step = editor.undo[editor.undo.length - 1];
                if (step && step !== last0 && step.kind === "canvas") { step.label = L; if (editor.historyChanged) editor.historyChanged(); }
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
            // a preset the runtime refused and replaced is a fallback, an answer that is the picture unchanged a pass that
            // did nothing (0.1.50 Q2): red (item 45)
            editor.setStatus(parts.join(" "), out.fellBack || out.unchanged ? "warn" : "info");
            return { layer, seconds: out.seconds || 0, note: out.note || "", changed, factor: mode.factor, from: [W, H], width: nw, height: nh, unchanged: !!out.unchanged };
        } catch (err) {
            if (gone()) return { layer: null, seconds: 0, note: "", changed: false, factor: mode.factor, from: [W, H], width: null, height: null, unchanged: false };
            const msg = String((err && err.message) || err);
            throw say(err && err.hint ? String(err.hint) : msg.startsWith(L) ? msg : `${L}: ${msg}`, failKind(err));
        } finally {
            offRemoved();
            this.endRun(editor, token);
        }
    },

    /** A provider route's relight request, sent (`providerEdit`); a member so the relight gate can stand in for it. */
    relightSend(request, token) {
        return providerEdit(request, token);
    },

    /**
     * Whole-picture relight pass: sends the composite picture and the light map to a generative route (Magnific),
     * applies the detail ratio from the original picture, lands as a pixel layer named "Relight (<route>)" under
     * the top run of filter layers, and hides the relight filter layer in one undo step.
     */
    async relightWhole(editor, layer, { route = "magnific", deadline = 0, prompt = "" } = {}) {
        if (!editor.base) throw refusal("Load an image first.");
        if (!layer || layer.kind !== "filter" || layer.filter !== "relight") throw new Error("A relight layer is required.");
        const hasDepth = !!(editor.maps && editor.maps.depth && (editor.maps.depth.data || editor.maps.depth.u16));
        if (!hasDepth && editor.ensureDepthMap) {
            await editor.ensureDepthMap();
        }
        if (editor.providerPending) throw refusal(RUN_GOING);

        const L = `Relight (${route})`;
        const say = (text, kind) => { editor.setStatus(text, kind); return refusal(text, editor.statusKind || "info"); };
        const token = { provider: route, label: L, started: Date.now(), editor, runId: runIdOf() };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();

        let closed = false;
        const offRemoved = this.on("removed", (e) => { if (e && e.editor === editor) { closed = true; token.cancelled = true; } });
        const gone = () => closed || !this._editors.includes(editor);
        const isFill = (l) => editor.isFillLayer(l);
        const skip = (l) => editor.isReference(l) || editor.isControl(l) || (l.kind !== "filter" && !l.visible) || (l.relightOf && l.relightOf === layer.id);
        const pv = (p) => (p ? `${objectId(p)}.${p.version || 0}` : "-");
        const readSig = (upTo) => {
            const parts = [editor.width, editor.height, editor.pixelVersion || 0, pv(editor.basePx), editor.compareShow || ""];
            for (const l of editor.layers.slice(0, upTo)) {
                if (editor.isReference(l) || editor.isControl(l) || l === layer || (l.relightOf && l.relightOf === layer.id)) continue;
                parts.push(l.id, editor.shown(l) ? 1 : 0, l.opacity, l.blend || "", l.clip ? 1 : 0, l.group || "", l.x, l.y, l.w, l.h, l.kind,
                    l.kind === "filter" ? `${l.filter}${JSON.stringify(l.params || {})}${objectId(l._lutData)}${objectId(l._plateImg)}` : "",
                    pv(l.px), pv(l.maskPx), l.maskOff ? 1 : 0, l.match ? `${l.match.strength}:${l.match.source}` : "");
            }
            return parts.join("|");
        };
        const cancelled = () => Object.assign(new Error(`${L} cancelled.`), { hint: `${L} cancelled.`, kind: "cancelled" });

        try {
            if (editor.relightSettled) await editor.relightSettled(layer);   // its own maps too when it is hidden: the light map reads them
            const W = editor.width, H = editor.height;
            if ((layer.params || {}).detail !== false && W * H > realism.MAX_AREA) {
                throw new Error(`${L}: detail restoration supports pictures up to 27.9 megapixels (${W} x ${H} is ${((W * H) / 1e6).toFixed(1)} MP). Turn off detail restoration or scale the picture down first.`);
            }
            const upTo = realism.topFilterRun(editor.layers, isFill, skip);
            editor.setStatus(`${L}: reading the picture (${W} x ${H}) ...`);
            const sig0 = readSig(upTo);

            const wasVis = layer.visible;
            layer.visible = false;
            const hiddenRelight = [];
            for (const l of editor.layers) {
                if (l.relightOf && l.relightOf === layer.id && l.visible) {
                    l.visible = false;
                    hiddenRelight.push(l);
                }
            }
            let picBytes = null;
            let cFull = null;
            try {
                const enc = await editor.encodeComposite({ forRun: true, upTo });
                if (enc) {
                    picBytes = new Uint8Array(await enc.blob.arrayBuffer());
                    const bmp = await createImageBitmap(enc.blob);
                    cFull = document.createElement("canvas");
                    cFull.width = W; cFull.height = H;
                    cFull.getContext("2d").drawImage(bmp, 0, 0);
                    bmp.close();
                } else {
                    cFull = editor.flattenToCanvas({ forRun: true, upTo });
                    picBytes = await canvasBytes(cFull);
                }
            } finally {
                layer.visible = wasVis;
                for (const l of hiddenRelight) l.visible = true;
            }

            const longSide = Math.max(W, H);
            const scaleFactor = Math.min(1.0, 2048 / longSide);
            const wSend = Math.max(256, Math.round(W * scaleFactor));
            const hSend = Math.max(256, Math.round(H * scaleFactor));

            let cSend = cFull;
            if (wSend !== W || hSend !== H) {
                cSend = document.createElement("canvas");
                cSend.width = wSend; cSend.height = hSend;
                const sx = cSend.getContext("2d");
                sx.imageSmoothingEnabled = true;
                sx.imageSmoothingQuality = "high";
                sx.drawImage(cFull, 0, 0, wSend, hSend);
                picBytes = await canvasBytes(cSend);
            }

            const mapCanvas = document.createElement("canvas");
            mapCanvas.width = wSend; mapCanvas.height = hSend;
            mapCanvas.getContext("2d").drawImage(cSend, 0, 0);
            const relightInfo = {
                scale: wSend / W,
                maps: editor.maps,
                relight: layer._relight,
                layer,
                forRun: true,   // the full shadow map relightSettled waited for, never the quick one (F2.5)
            };
            const lmRes = applyFilter("relight", mapCanvas, { ...layer.params, mode: 1 }, relightInfo);
            const lmCanvas = glToCanvas(lmRes) || lmRes;
            const lightmapBytes = await canvasBytes(lmCanvas);

            const words = lightsToWords(layer.params.lights || [], { width: W, height: H });
            const sentPrompt = [words.prompt, prompt].filter(Boolean).join(" ");

            const p = layer.params || {};
            let out;
            if (route === "comfyui") {
                if (!this.connected) {
                    throw refusal("ComfyUI is not connected: connect under Settings > ComfyUI.");
                }
                const list = this.shell && this.shell.recipes ? this.shell.recipes() : [];
                const localRecipe = list.find((r) => r.id === "relight_qwen_local");
                let info = this.objectInfo;
                if (!info && typeof this.loadObjectInfo === "function") {
                    info = await this.loadObjectInfo();
                }
                this.checkComfyRelightModels(localRecipe, info);
                editor.setStatus(`${L}: sending picture (${wSend} x ${hSend}) to your local ComfyUI ...`);
                const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
                const upload = this.uploadInput(new Blob([picBytes], { type: "image/png" }), `n${editor.node.id}_relight_${stamp}.png`);
                const ref = await new Promise((resolve, reject) => {
                    const t0 = Date.now(), end = Math.min(t0 + 300000, deadline || Infinity);
                    let iv = null;
                    const done = (fn, v) => { clearInterval(iv); fn(v); };
                    iv = setInterval(() => {
                        if (token && token.cancelled) done(reject, cancelled());
                        else if (Date.now() > end) done(reject, new Error(`${L}: your ComfyUI did not take the picture within ${Math.round((Date.now() - t0) / 1000)} s.`));
                    }, 250);
                    upload.then((v) => done(resolve, v), (err) => done(reject, err));
                });
                const promptGraph = JSON.parse(JSON.stringify((localRecipe && localRecipe.prompt) || {}));
                promptGraph["canvas"] = {
                    class_type: "InpaintCanvasLoadRef",
                    inputs: { ref: JSON.stringify({ filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input" }) },
                };
                if (promptGraph.concat_prompt && promptGraph.concat_prompt.inputs) {
                    promptGraph.concat_prompt.inputs.string_b = sentPrompt;
                }
                if (promptGraph.encode_neg && promptGraph.encode_neg.inputs) {
                    promptGraph.encode_neg.inputs.prompt = "";
                }
                if (promptGraph.run && promptGraph.run.inputs) {
                    promptGraph.run.inputs.seed = Math.floor(Math.random() * 1000000000);
                    if (p.steps != null) promptGraph.run.inputs.steps = p.steps;
                    if (p.cfg != null) promptGraph.run.inputs.cfg = p.cfg;
                }
                if (promptGraph.lora_relight && promptGraph.lora_relight.inputs) {
                    promptGraph.lora_relight.inputs.strength_model = loraPercent(p.lora_strength ?? p.strength_model) / 100;
                }
                promptGraph["relight_out"] = { class_type: "PreviewImage", inputs: { images: ["decode", 0] } };
                out = await this.comfyPictureRun(editor, promptGraph, "relight_out", { label: L, token, deadline, timeoutMs: 300000, front: false });
            } else {
                let req;
                if (route === "fal-iclight") {
                    req = {
                        provider: "fal",
                        model: "fal-ai/iclight-v2",
                        kind: "relight",
                        image: picBytes,
                        prompt: sentPrompt,
                        initial_latent: words.latent || "None",
                        enable_hr_fix: p.enable_hr_fix !== false,
                        width: wSend,
                        height: hSend,
                        params: {
                            initial_latent: words.latent || "None",
                            enable_hr_fix: p.enable_hr_fix !== false,
                        },
                    };
                } else if (route === "fal-bria") {
                    req = {
                        provider: "fal",
                        model: "bria/fibo-edit/relight",
                        kind: "relight",
                        image: picBytes,
                        prompt: sentPrompt,
                        light_direction: words.bria?.direction || "front",
                        light_type: p.light_type || words.bria?.type || "soft overcast daylight lighting",
                        params: {
                            light_direction: words.bria?.direction || "front",
                            light_type: p.light_type || words.bria?.type || "soft overcast daylight lighting",
                        },
                    };
                } else if (route === "comfycloud") {
                    const list = this.shell && this.shell.recipes ? this.shell.recipes() : [];
                    const relightRecipe = list.find((r) => r.id === "relight");
                    const cloudOpts = (relightRecipe && relightRecipe.providers && relightRecipe.providers.comfycloud && relightRecipe.providers.comfycloud.options) || null;
                    req = {
                        provider: "comfycloud",
                        model: "image_qwen_image_edit_2509_relight",
                        kind: "relight",
                        image: picBytes,
                        prompt: sentPrompt,
                        options: cloudOpts ? JSON.parse(JSON.stringify(cloudOpts)) : {},
                        params: {
                            "10:118|strength_model": loraPercent(p.lora_strength ?? p.strength_model) / 100,
                            "10:3|steps": p.steps ?? 4,
                            "10:3|cfg": p.cfg ?? 1.0,
                        },
                    };
                } else {
                    req = {
                        provider: route === "magnific" ? "magnific" : route,
                        model: "image-relight",
                        kind: "relight",
                        image: picBytes,
                        lightmap: lightmapBytes,
                        prompt: sentPrompt,
                        params: {
                            light_transfer_strength: p.strength != null ? p.strength : (p.light_transfer_strength != null ? p.light_transfer_strength : 100),
                            style: p.style || "standard",
                            preserve_details: p.preserve_details !== false,
                            interpolate_from_original: !!(p.interpolate != null ? p.interpolate : p.interpolate_from_original),
                            ...(p.advanced_settings ? { advanced_settings: p.advanced_settings } : {}),
                        },
                    };
                }

                editor.setStatus(`${L}: sending picture and guidance (${wSend} x ${hSend}) to ${route} ...`);
                out = await this.relightSend(req, token);
            }
            if (gone()) return { layer: null, seconds: 0, note: "", changed: false, route, seed: null };
            if (token.cancelled) throw cancelled();

            const img = await bytesToImage(out.bytes, out.mime);
            const wAns = img.naturalWidth || img.width, hAns = img.naturalHeight || img.height;

            const useDetail = p.detail !== false;
            let finCanvas = null;
            if (useDetail) {
                editor.setStatus(`${L}: transferring lighting and restoring original details ...`);
                const cAns = document.createElement("canvas");
                cAns.width = wAns; cAns.height = hAns;
                cAns.getContext("2d").drawImage(img, 0, 0);
                const ansPx = cAns.getContext("2d").getImageData(0, 0, wAns, hAns).data;
                const fullPx = cFull.getContext("2d").getImageData(0, 0, W, H).data;

                let lowPx = null;
                if (cSend && typeof cSend.getContext === "function") {
                    if (wSend === wAns && hSend === hAns) {
                        lowPx = cSend.getContext("2d").getImageData(0, 0, wSend, hSend).data;
                    } else {
                        const cLowAns = document.createElement("canvas");
                        cLowAns.width = wAns;
                        cLowAns.height = hAns;
                        const ctxLow = cLowAns.getContext("2d");
                        ctxLow.imageSmoothingEnabled = true;
                        ctxLow.imageSmoothingQuality = "high";
                        ctxLow.drawImage(cSend, 0, 0, wAns, hAns);
                        lowPx = ctxLow.getImageData(0, 0, wAns, hAns).data;
                    }
                }

                let resBytes = null;
                const pool = editorPool();
                if (pool && !pool.off) {
                    try {
                        const fullBuf = fullPx.slice().buffer;
                        const ansBuf = ansPx.slice().buffer;
                        const lowBuf = lowPx ? lowPx.slice().buffer : null;
                        const transfer = lowBuf ? [fullBuf, lowBuf, ansBuf] : [fullBuf, ansBuf];
                        const poolRes = await pool.run("relight_ratio", {
                            fullPx: fullBuf,
                            lowPx: lowBuf,
                            ansPx: ansBuf,
                            W, H, wAns, hAns,
                        }, transfer, { priority: INTERACTIVE, timeout: 180000 });
                        if (poolRes && poolRes.out) resBytes = new Uint8Array(poolRes.out);
                    } catch (err) {
                        console.warn("relight_ratio pool job failed, falling back to main thread:", err);
                    }
                }
                if (!resBytes) {
                    resBytes = detailRatio(fullPx, lowPx, ansPx, W, H, wAns, hAns);
                }
                finCanvas = document.createElement("canvas");
                finCanvas.width = W; finCanvas.height = H;
                const finImgData = new ImageData(new Uint8ClampedArray(resBytes.buffer, resBytes.byteOffset, resBytes.byteLength), W, H);
                finCanvas.getContext("2d").putImageData(finImgData, 0, 0);
            } else {
                finCanvas = document.createElement("canvas");
                finCanvas.width = W; finCanvas.height = H;
                const fx = finCanvas.getContext("2d");
                fx.imageSmoothingEnabled = true;
                fx.imageSmoothingQuality = "high";
                fx.drawImage(img, 0, 0, W, H);
            }

            let ref = null;
            const lbytes = await canvasBytes(finCanvas);
            const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
            try {
                ref = await this.uploadResult(new Blob([lbytes], { type: "image/png" }), `n${editor.node.id}_relight_${stamp}.png`);
            } catch (err) {
                console.warn("the relight layer stays unsaved until the next save", err);
            }

            if (gone()) return { layer: null, seconds: 0, note: "", changed: false, route, seed: null };
            if (token.cancelled) throw cancelled();
            if (editor.width !== W || editor.height !== H) {
                throw new Error(`${L}: picture size changed during the run (was ${W} x ${H}, now ${editor.width} x ${editor.height}).`);
            }

            const at0 = realism.topFilterRun(editor.layers, isFill, skip);
            const changed = readSig(at0) !== sig0;

            editor.pushUndo({ kind: "layers", label: L });
            const at = realism.topFilterRun(editor.layers, isFill, skip);
            const px = editor.pixels.Layer.fromCanvas(finCanvas);
            const pixelLayer = editor.addLayer({
                name: L,
                kind: "image",
                ref,
                dirty: !ref,
                px,
                x: 0,
                y: 0,
                w: W,
                h: H,
                match: { strength: 0, source: "underneath" },
                relightOf: layer.id,
            });
            const top = editor.layers.length - 1;
            if (at < top) editor.moveLayer(pixelLayer.id, at - top, { undo: false });

            layer.visible = false;
            const ms = Date.now() - token.started;
            layer.params = {
                ...layer.params,
                last: { route, seed: out.seed, ms },
            };
            editor.markFilterChanged(layer);
            editor.renderLayers();
            editor.draw();

            const secs = Math.max(1, Math.round(ms / 1000));
            const changedMsg = changed ? " The picture changed while the relight was running: the layer shows it as it was when the run started." : "";
            editor.setStatus(`${L} finished in ${secs} s: added a new layer above the picture under the filter layers (Ctrl+Z takes it back).${changedMsg}`);
            return { layer: pixelLayer, seconds: ms / 1000, note: changed ? "the picture changed while the relight was running" : "", changed, route, seed: out.seed };
        } catch (err) {
            if (gone()) return { layer: null, seconds: 0, note: "", changed: false, route, seed: null };
            const msg = String((err && err.message) || err);
            throw say(err && err.hint ? String(err.hint) : msg.startsWith(L) ? msg : `${L}: ${msg}`, failKind(err));
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
        // Generate new on a ComfyUI recipe (generate_new's local path, a fresh canvas): the size its boxes were drawn on,
        // read once whatever the run does
        const fresh = editor._newBoxes || null;
        editor._newBoxes = undefined;
        const r = this.recipe;
        if (!r) throw refusal("No recipe selected.");
        // a run whose landing resizes the document (an upscale of the whole picture, the Realism Pass above 1×) holds it:
        // a render queued now would land in the old geometry (editor.generate refuses first; this is the net)
        if (editor.providerPending && editor.providerPending.resizes) throw refusal(RUN_GOING);
        if (r.kind === "provider" && r.task === "upscale") return this.runUpscale(editor, { scope: "selection", refs: opts.refs });
        if (r.kind === "provider") return this.runProvider(editor, { refs: opts.refs });
        if (!r.prompt) throw refusal("No recipe selected.");
        // a text-to-image graph (recipes/moss_image_local.json, `edit: false`): only Generate new's fresh canvas runs it;
        // on a selection it would paint a picture made from the prompt alone into the crop
        if (r.edit === false && !fresh) throw refusal(`${r.name || r.id} makes new pictures from the prompt alone: use "Generate new", not Generate.`);
        // the generation values of the click, before anything is awaited: the result's history entry keeps them (S4)
        const clickGen = { seed: editor.genSettings.seed, mode: editor.genSettings.mode, denoise: editor.genSettings.denoise };
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
            if (!b) throw refusal(`Select an area first: ${realism.LABEL} works on the selection's box (Select All for the whole picture).`);
            // the crop the node makes: the box with its context (cropRect mirrors the node's manual or auto padding, the
            // auto minimum span and the clamp to the picture), then each side to the pass's multiple the node's way
            const [, , cw, ch] = editor.cropRect();
            const tooBig = realism.fits(realism.fitSpan(cw, editor.width), realism.fitSpan(ch, editor.height));
            if (tooBig) throw refusal(tooBig, "warn");
        }
        if (upscale) {
            const p = this.refNames(editor, snap.prompt), n = this.refNames(editor, snap.negative);
            // the pass's graph reads no prompt at all, so its tokens need no note
            texts = { prompt: p.text, negative: n.text, note: !pass && (p.note || n.note) ? "Upscale sends no reference images: the prompt's @img tokens were written as layer names." : "" };
        } else {
            early = this.comfyPlan(editor, r, snap.refIds.length);
            texts = this.refPrompt(editor, snap, "comfy", { recipe: r, comfy: early });
        }
        if (!this.connected) throw refusal("Not connected to ComfyUI.");
        const missing = (r.needs || []).filter((n) => this.objectInfo && !this.objectInfo[n]);
        if (missing.length) throw new Error("The server lacks these node types: " + missing.join(", "));
        if (upscale && !pass && !(editor.getBounds && editor.getBounds())) throw refusal("Select an area first: an upscale model on ComfyUI sharpens the selection's box.");
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
            const tooBig = this.upscaleSizeRefusal(r, realism.fitSpan(cw, editor.width, m), realism.fitSpan(ch, editor.height, m), factor, "box");
            if (tooBig) throw refusal(tooBig, "warn");
        }
        // boxes in the prompt (a recipe that declares the input FLUX 3's rows go to, `boxes`): with the Boxes switch on, the
        // boxes the run sends (localBoxPlan: the document's, or the selection as one box when it holds none; on Generate
        // new the plan generate_new made before the fresh canvas replaced the picture). The Inpaint Canvas node writes the
        // rows from the canvas state into its box_prompt output, which an older node does not have: refused here, before
        // anything is uploaded, and again below on the state
        const boxSchema = upscale ? null : boxesSchema(r);
        const runRefs = upscale ? [] : snap.refIds.slice(0, early.lay.kept);
        let boxPlan = null, boxSlot = -1;
        if (boxSchema && editor.genSettings.boxes) {
            boxPlan = fresh && fresh.plan ? fresh.plan : this.localBoxPlan(editor, runRefs, { fresh: !!fresh });
            if (boxPlan.goes) {
                boxSlot = await this.boxPromptSlot();
                if (boxSlot < 0) throw refusal(comfyprompt.oldNodeBoxes(r), "warn");
            }
        }
        editor.lastUpscaleFactor = factor;
        editor.lastSentPrompt = null;
        editor.lastRunNotes = [];
        editor.lastSentBoxes = 0;
        if (boxSchema && !editor.genSettings.boxes) {
            const held = this.plugins ? this.plugins.countBoxes(editor) : 0;
            if (held) editor.lastRunNotes.push(`The document's ${held} box${held === 1 ? "" : "es"} did not go: the Boxes switch under the prompt is off.`);
        }
        // the plan's boxes as serializeForPrompt sends them; Generate new's scaled from the picture they were drawn on to
        // the fresh canvas, as fractions of the picture as an API model's Generate new places them (another shape
        // stretches them, and the notes say so)
        let boxGiven = null, stretched = "";
        if (boxPlan) {
            boxGiven = { boxes: boxPlan.boxes ? JSON.parse(JSON.stringify(boxPlan.boxes)) : null, notes: boxPlan.notes };
            if (fresh && comfyprompt.scaleStateBoxes(boxGiven, fresh.from, [editor.width, editor.height])) {
                stretched = genpresets.stretchNote(fresh.from, [editor.width, editor.height], genpresets.aspectsOf(r), fresh.aspect || null) || "";
            }
        }
        // an upscale's canvas state carries no references (upscaleState), so none is read or uploaded for it; a reference
        // past the recipe's slots is not uploaded either
        const sopts = upscale ? { refIds: [], prompt: texts.prompt, negative: texts.negative } : { refIds: runRefs, prompt: snap.prompt, negative: snap.negative, ...(boxGiven ? { boxes: boxGiven } : {}) };
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
            // the boxes as the state carries them (the plan's: `boxes` whenever the document holds some, so a list it
            // emptied never turns into the selection's box; none but the plan's on Generate new): their count, the node's
            // box_prompt for a run that sends any. The switch is the state's (turned off while the pictures went up: none go)
            const listed = Array.isArray(st.boxes), stBoxes = listed ? st.boxes.length : 0;
            if (boxPlan) editor.lastRunNotes.push(...boxPlan.dropped);
            if (boxPlan && st.gen && st.gen.boxes && (stBoxes > 0 || (!fresh && !listed && !!st.hasSelection))) {
                if (boxSlot < 0) boxSlot = await this.boxPromptSlot();
                if (boxSlot < 0) throw refusal(comfyprompt.oldNodeBoxes(r), "warn");
                editor.lastSentBoxes = stBoxes || 1;
                if (stretched && stBoxes) editor.lastRunNotes.push(stretched);
                // an @img token in a description: the name this recipe gives its picture, as the prompt names it
                // (<ref_image_1>), not the node's "image n"; a token whose picture does not go stays, and the node says so
                if (stBoxes) {
                    const ids = [...Array(plan.lay.original).fill(null), ...snap.refIds.slice(0, plan.lay.kept)];
                    const idOf = new Map([...snap.labels].map(([id, n]) => [n, id]));
                    const spec = plan.spec, pictures = plan.lay.pictures;
                    st.boxes = comfyprompt.nameBoxTokens(st.boxes, (n) => {
                        const at = idOf.has(n) ? ids.indexOf(idOf.get(n)) : -1;
                        const pic = at >= 0 ? pictures.find((x) => x.ref === at) : null;
                        return pic && pic.n ? refName(spec.name, pic.n) : null;
                    });
                }
            } else boxSlot = -1;
            state = JSON.stringify(st);
            editor.lastSentPrompt = st.prompt;
            if (snap.refIds.length > plan.lay.kept) {
                const left = snap.refIds.slice(plan.lay.kept).map((id) => "img" + snap.labels.get(id));
                editor.lastRunNotes.push(`${listWords(left)} ${left.length === 1 ? "is" : "are"} not sent: ${r.name || r.id} reads ${plan.spec.slots} picture${plan.spec.slots === 1 ? "" : "s"}.`);
            }
            if (plan.spec.guess && texts.pairs.length) editor.lastRunNotes.push("(wording guessed from the graph)");
        }
        if (texts.note) editor.setStatus(`${editor.status} ${texts.note}`, editor.statusKind || "info");
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
        {
            // a row naming a file the server lacks refuses here, before anything is queued (issue #4)
            const lacks = this.missingFilesRefusal(editor, r);
            if (lacks) throw new Error(lacks);
        }
        for (const s of r.settings || []) {
            const entry = editor.settings[String(s.index)];
            const node = prompt[s.node];
            if (entry && entry.value != null && node && node.inputs) node.inputs[s.input] = entry.value;
        }
        if (factor != null && r.factor && r.factor.input) {
            const at = r.factor.input.indexOf("|"), node = prompt[r.factor.input.slice(0, at)];
            if (node && node.inputs) node.inputs[r.factor.input.slice(at + 1)] = factor;
        }
        // the run sends boxes: the recipe's declared input takes the node's box_prompt (the prompt with FLUX 3's rows,
        // written by the node from the state's boxes) instead of the plain prompt the recipe file keeps there
        if (boxSlot >= 0 && !comfyprompt.wireBoxPrompt(prompt, r, boxSlot)) throw new Error(`${r.name || r.id}: its boxes input ${r.boxes && r.boxes.input} does not read the Inpaint Canvas node's prompt, so no box could go.`);
        // a prompt upsampler in the graph (FLUX 3 Image Klein, 0.1.50 Q9): runs when its row is on, no box goes and the
        // server has its file and nodes; Generate new without pictures after the white crop takes the text-to-image
        // guide with the canvas's aspect
        const upClips = this.objectInfo && this.objectInfo.CLIPLoader && this.objectInfo.CLIPLoader.input && this.objectInfo.CLIPLoader.input.required
            && Array.isArray(this.objectInfo.CLIPLoader.input.required.clip_name) ? this.objectInfo.CLIPLoader.input.required.clip_name[0] : null;
        const upsampled = comfyprompt.wireUpsampler(prompt, r, {
            text: texts.prompt, fresh: !!fresh, refsGo: !!(plan && plan.lay.original + plan.lay.kept > 0),
            aspect: fresh ? (fresh.aspect || aspectOf(editor.width, editor.height)) : null, boxes: boxSlot >= 0,
            files: Array.isArray(upClips) ? upClips.map(String) : null, classes: this.objectInfo || null,
        });
        if (upsampled.note) {
            if (plan) editor.lastRunNotes.push(upsampled.note);
            else editor.setStatus(`${editor.status} ${upsampled.note}`, editor.statusKind || "info");
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
        // the tab closed while its prompt was being queued (the uploads take a while): its result lands nowhere
        if (res && res.prompt_id && !this._editors.includes(editor)) this._closedPrompts.add(String(res.prompt_id));
        // a Klein run's files: its sampler's shape error is said as the text encoder that does not fit (0.1.50 Q1)
        const klein = res && res.prompt_id != null ? kleinRun(r, prompt) : null;
        if (upsampled.show && res && res.prompt_id != null) {
            this._upsampledRuns.set(String(res.prompt_id), upsampled.show);
            for (const id of this._upsampledRuns.keys()) { if (this._upsampledRuns.size <= 64) break; this._upsampledRuns.delete(id); }
        }
        if (klein) {
            this._kleinRuns.set(String(res.prompt_id), klein);
            for (const id of this._kleinRuns.keys()) { if (this._kleinRuns.size <= 64) break; this._kleinRuns.delete(id); }
        }
        if (pass && support.note) editor.setStatus(`${editor.status} ${support.note}`, editor.statusKind || "info");
        if (plan) {
            const named = texts.pairs.filter((p) => p.name).map((p) => `${p.label} → ${p.name}`);
            if (named.length) editor.setStatus(`${editor.status} Named in the prompt: ${named.join(", ")}.`, editor.statusKind || "info");
            const nb = editor.lastSentBoxes;
            if (nb) editor.setStatus(`${editor.status} Sent with ${nb} box${nb === 1 ? "" : "es"}.`, editor.statusKind || "info");
            if (editor.lastRunNotes.length) editor.setStatus(`${editor.status} ${editor.lastRunNotes.join(" ")}`, notesKind(editor, editor.lastRunNotes));
            if (named.length && window.scumble && window.scumble.log) {
                Promise.resolve(window.scumble.log.add({ level: "info", source: "comfy", message: `local run ${(res && res.prompt_id) || ""}: prompt as sent`, detail: editor.lastSentPrompt })).catch(() => { /* the log is optional */ });
            }
        }
        // open until ComfyUI says the prompt ended (success, error, interrupt) or its queue is empty: a turn of the whole
        // picture waits for it, since the result lands in the geometry it was made for (PLAN_0_1_31 §7)
        if (res && res.prompt_id) (editor._localRuns || (editor._localRuns = new Set())).add(res.prompt_id);
        if (res && res.prompt_id) this.trackRun(editor, res.prompt_id, this.runNodeCount(prompt));
        // a run that took box_prompt: the node's notes on its boxes are this run's (the `executed` listener shows them);
        // any other run's are not, whatever the node wrote for a switch left on (taken out when the result lands; the
        // bound is only for prompts that never answer)
        if (boxSlot >= 0 && res && res.prompt_id != null) {
            const boxed = editor._boxPrompts || (editor._boxPrompts = new Set());
            boxed.add(String(res.prompt_id));
            while (boxed.size > 50) boxed.delete(boxed.values().next().value);
        }
        // the result's history entry keeps the prompt of the click, not the field's text when it lands (S4)
        if (res && res.prompt_id) {
            const sent = editor._sentTexts || (editor._sentTexts = new Map());
            // an upscale or the pass reads no prompt unless its recipe says so (as runUpscale records it); the seed, mode
            // and denoise of the click too, which a later click changes before this result lands
            const texts0 = upscale ? (r.usesPrompt ? { prompt: texts.prompt, negative: texts.negative, refs: null } : { prompt: "", negative: "", refs: null }) : sentTexts(snap);
            // QW5: the result names the recipe and where it ran; the seconds are counted when it lands
            sent.set(res.prompt_id, { ...texts0, ...clickGen, via: viaLine(r, "your ComfyUI", null), viaStarted: Date.now() });
            // taken out when the result lands; the bound is only for prompts that never answer
            while (sent.size > 500) sent.delete(sent.keys().next().value);
        }
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
        markStep("save", "start");   // the K0a harness: the bytes off the blob, then the write by main
        const data = new Uint8Array(await blob.arrayBuffer());
        markStep("save", "bytes", { MB: data.length / 1048576 });
        const saved = await window.scumble.file.save({ name, data, path: this.exportPath || undefined });
        markStep("save", "written");
        return saved;
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
        if (!ed || !ed.base) throw refusal("There is nothing to save yet: the document holds no picture.");
        if (ed._docSaving) throw refusal(`${this.documentName(ed)} is already being saved.`);
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
                if (ed._docCancel) throw Object.assign(new Error("the save was cancelled"), { kind: "cancelled" });
                const state = ed.getValue();       // a stroke after this is not in the file and leaves the tab changed
                let thumbnail = null;
                try { thumbnail = await this.documentThumbnail(ed); } catch (err) { console.warn("document thumbnail", err); }
                if (ed._docCancel) throw Object.assign(new Error("the save was cancelled"), { kind: "cancelled" });
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
                ed.setStatus(`${copy ? "Saved a copy as" : "Saved"} ${res.name} (${fmtMB(res.bytes)}, ${(res.ms / 1000).toFixed(1)} s)${keep ? "" : ", without the result history"}.${res.notes && res.notes.length ? " " + res.notes.join("; ") + "." : ""}`, "info");
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
        if (ed.base) ed.setStatus(`Opened ${r.name}.${notes.length ? " " + notes.join("; ") + "." : ""}`, "info");
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
        // its renders still on ComfyUI land in it again (removeEditor kept them; a picture run ended with the tab)
        const runs = this._closedRuns.get(String(e.id)) || [];
        this._closedRuns.delete(String(e.id));
        if (ed) for (const run of runs) {
            if (!this._closedPrompts.has(run.id) || this._pictureRuns.has(run.id) || this._endedPictureRuns.has(run.id)) continue;
            this._closedPrompts.delete(run.id);
            (ed._localRuns || (ed._localRuns = new Set())).add(run.id);
            if (run.sent) (ed._sentTexts || (ed._sentTexts = new Map())).set(run.id, run.sent);
            this.trackRun(ed, run.id, run.nodes);
        }
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

    /** @type {{ models: any[], sam2?: any, matting?: any, inpaint?: any, runtime?: any, depth?: any }} */
    helpers: { models: [], sam2: null, matting: null, inpaint: null, runtime: null, depth: null },
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
        editor.setStatus(editor.status.replace(/\.$/, "") + ` (${backend.label.replace(/ \(.*\)$/, "")}, ${res.seconds.toFixed(1)} s${pics}${note}).`, res.note ? "warn" : (editor.statusKind || "info"));
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

    /** Depth map computation is supported in Scumble (R1-S1 / R1-S3). */
    depthSupported: true,

    /**
     * @img1, @img2 in the prompt name the shown reference layers, and their numbers follow the layers through every
     * change (docs/PLAN_REFS.md); the node keeps its positional "ref N" until a node release.
     */
    refTokens: true,

    /** The app's Boxes plugin owns the boxes (plugins/boxes); the node's editor owns them itself (docs/PLAN_NODE_BOXES.md D5). */
    boxesInEditor: false,

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
        if (!editor.tileMode) {
            if (!layer && editor.relightIdle) await editor.relightIdle();   // as sampleRegionSettled waits on tiles (F2.7)
            return this.modelInput(this.sourceCanvas(editor, layer), 1024, null);
        }
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
     * Document picture input without filter layers (or with them if skipFilters: false):
     * For depth estimation, fresh fingerprints, and other photo-derived inputs (PLAN_NIK9_BUILD.md §F5).
     * On tiles: one sampleRegionSettled pass over the whole picture at s = min(1, max(w / W, h / H)) with forRun: true,
     * drawn into a w x h canvas, then RGBA bytes.
     * On canvases: a plain draw of flattenToCanvas({ forRun: true, skipFilters }).
     */
    async pictureInput(editor, w, h, { skipFilters = true, background = null } = {}) {
        const W = editor.width, H = editor.height;
        if (!W || !H) throw new Error("empty document");
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, w, h); }
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        if (editor.tileMode) {
            const s = Math.min(1, Math.max(w / W, h / H));
            const sample = await editor.sampleRegionSettled("image", [0, 0, W, H], s, { forRun: true, skipFilters });
            ctx.drawImage(sample, 0, 0, w, h);
        } else {
            if (editor.relightSettled) await editor.relightSettled();
            const flat = editor.flattenToCanvas({ forRun: true, skipFilters });
            ctx.drawImage(flat, 0, 0, w, h);
        }
        const image = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
        return { image, width: w, height: h };
    },

    /**
     * The object map for the hover tool from SAM2 in-app. Called by the editor's
     * ensureObjects() with the source hash and layer; fills editor.objects through
     * applySegmentIds like the ComfyUI path does through applySegmentsFile.
     */
    async findObjects(editor, pending) {
        const model = this.sam2Model();
        if (!model) { editor.objectsPending = null; editor.setStatus("No SAM2 model is downloaded (Settings › Helpers).", "warn"); return; }
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
            editor.setStatus(`${res.count} objects found with ${model.label} in ${res.seconds.toFixed(1)} s (${res.provider}). Hover to preview, click to select, click again to deselect (Shift adds, Alt subtracts, Shift+Alt intersects).${this.slowHelperHint(res)}`);
        } catch (err) {
            console.error(err);
            editor.objectsPending = null;
            editor.setStatus("Object detection failed: " + (err.message || err), failKind(err));
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
        if (hint) setTimeout(() => editor.setStatus(editor.status + hint, editor.statusKind || "info"), 50);   // after applyCutoutImage's own status line
        return c;
    },

    /**
     * Cache key for SAM2 embeddings: reuses editor.objects.hash when it matches;
     * else ${editor.node.id}: + (layer ? layer:${layer.id}: : "image:") + inputHash(objectInput(editor, layer));
     * cached per compositeVersion.
     */
    async segmentKey(editor, layer) {
        const o = editor.objects;
        const matchesLayer = layer ? (o && o.layerId === layer.id) : (o && o.layerId == null);
        if (matchesLayer && o.hash && o.w === editor.width && o.h === editor.height) {
            return { key: `${editor.node.id}:${o.hash}`, image: null };
        }
        const cache = editor._segmentKeyCache;
        const layerKey = layer ? `layer:${layer.id}` : "image";
        if (cache && cache.version === editor.compositeVersion && cache.layerKey === layerKey) {
            return { key: cache.key, image: cache.image || null };
        }
        const image = await this.objectInput(editor, layer);
        const hash = (layer ? `layer:${layer.id}:` : "image:") + await this.inputHash(image);
        const key = `${editor.node.id}:${hash}`;
        editor._segmentKeyCache = { version: editor.compositeVersion, layerKey, key, image };
        return { key, image };
    },

    /**
     * Segment logits using SAM2: helpers:segment with raw: true, key, points/box in 1024 space.
     * The image is sent only when main lost the embedding.
     */
    async segmentLogits(editor, points = [], box = null, layer = null) {
        const model = this.sam2Model();
        if (!model) throw new Error("no SAM2 model is downloaded (Settings > Helpers)");
        const W = editor.width, H = editor.height;
        const pts = points.map((p) => ({ x: (p.x / W) * 1024, y: (p.y / H) * 1024, label: p.label == null ? 1 : p.label }));
        const bx = box ? [(box[0] / W) * 1024, (box[1] / H) * 1024, (box[2] / W) * 1024, (box[3] / H) * 1024] : null;
        const keyInfo = await this.segmentKey(editor, layer);
        const key = keyInfo.key;
        let res;
        try {
            res = await this.helperCall("segment", { model: model.id, key, points: pts, box: bx, raw: true });
        } catch (err) {
            // embedding gone (freed, restarted): encode again from the same source
            const image = keyInfo.image || await this.objectInput(editor, layer);
            res = await this.helperCall("segment", { model: model.id, key, image, points: pts, box: bx, raw: true });
        }
        return { logits: res.logits, n: res.n || 256, score: res.score };
    },

    /** Backward-compatibility wrapper for segmentLogits */
    async segmentPoint(editor, points, box) {
        return this.segmentLogits(editor, points, box);
    },

    /**
     * Drag a box with the Object tool: segment with SAM2 box prompt and combine into selection.
     */
    async selectBox(editor, box, { mode = "replace" } = {}) {
        if (editor.objectsPending || editor._pointPending) return;
        if (editor.providerPending && editor.providerPending.resizes) { editor.setStatus(RUN_GOING); return; }
        editor._pointPending = true;
        try {
            editor.setStatus("Segmenting what SAM2 sees in the box ...");
            const layer = editor.objects && editor.objects.layerId != null
                ? editor.layers.find((l) => l.id === editor.objects.layerId)
                : (editor.segSourceSel && editor.segSourceSel.value === "active layer" ? (editor.activeLayer ? editor.activeLayer() : null) : null);
            const res = await this.segmentLogits(editor, [], box, layer);
            await editor.selectLogits(res, { mode, label: "Object selection", layer, box });
        } catch (err) {
            console.error(err);
            editor.setStatus("Box segmentation failed: " + (err.message || err), failKind(err));
        } finally {
            editor._pointPending = false;
        }
    },

    /**
     * Object tool, click where the object map has nothing: segment with one SAM2 point
     * prompt and toggle that mask in the selection (Shift adds, Alt subtracts, Shift+Alt intersects,
     * otherwise a click on a selected pixel subtracts). Called by the editor's toggleObjectAt().
     */
    async selectPoint(editor, ix, iy, p = {}) {
        if (editor.objectsPending || editor._pointPending) return;
        // a run that resizes the document holds it: the mask would land in the old geometry
        if (editor.providerPending && editor.providerPending.resizes) { editor.setStatus(RUN_GOING); return; }
        editor._pointPending = true;
        try {
            editor.setStatus("Segmenting what is under the cursor with SAM2 ...");
            const layer = editor.objects && editor.objects.layerId != null
                ? editor.layers.find((l) => l.id === editor.objects.layerId)
                : (editor.segSourceSel && editor.segSourceSel.value === "active layer" ? (editor.activeLayer ? editor.activeLayer() : null) : null);
            const res = await this.segmentLogits(editor, [{ x: ix, y: iy, label: 1 }], null, layer);
            const x = Math.floor(ix), y = Math.floor(iy);
            const already = editor.sel.readRect(x, y, 1, 1).data[3] > 0;
            let mode;
            if (p.shift && p.alt) mode = "intersect";
            else if (p.alt) mode = "subtract";
            else if (p.shift) mode = "add";
            else mode = already ? "subtract" : "add";
            await editor.selectLogits(res, { mode, label: "Object selection", layer, point: [ix, iy] });
        } catch (err) {
            console.error(err);
            editor.setStatus("Point segmentation failed: " + (err.message || err), failKind(err));
        } finally {
            editor._pointPending = false;
        }
    },

    /** The depth model (Depth Anything V2 Small): the chosen one when present, else the first present. */
    depthModel() {
        const all = this.presentHelpers("depth");
        return all.find((m) => m.id === this.helpers.depth) || all[0] || null;
    },

    /**
     * Document input for depth estimation (delegates to pictureInput with skipFilters: true and #808080 background).
     */
    async depthInput(editor, w, h) {
        return this.pictureInput(editor, w, h, { skipFilters: true, background: "#808080" });
    },

    /**
     * Compute depth map via helperCall("depth").
     */
    async computeDepth(editor, req) {
        return this.depthInApp(editor, req);
    },

    /**
     * Run Depth Anything V2 Small helper on image:
     * -> { depth: Float32Array, min: number, max: number, ms: number, provider: string }
     */
    async depthInApp(editor, { image, width, height }) {
        const model = this.depthModel();
        if (!model) throw new Error("No depth model is downloaded (Settings › Helpers)");
        const res = await this.helperCall("depth", {
            model: model.id,
            image,
            width,
            height,
        });
        editor.helperUsed = true;
        return res;
    },

    /**
     * Document picture input cropped to a bounding box, without filter layers (or with them if skipFilters: false).
     * @param {any} editor
     * @param {{ x0: number, y0: number, x1: number, y1: number } | number[]} box
     * @param {number} w
     * @param {number} h
     * @param {{ skipFilters?: boolean, background?: string | null }} [opts]
     */
    async pictureInputBox(editor, box, w, h, { skipFilters = true, background = null } = {}) {
        const W = editor.width, H = editor.height;
        if (!W || !H) throw new Error("empty document");
        const bx0 = Array.isArray(box) ? box[0] : box.x0;
        const by0 = Array.isArray(box) ? box[1] : box.y0;
        const bx1 = Array.isArray(box) ? box[2] : box.x1;
        const by1 = Array.isArray(box) ? box[3] : box.y1;
        const bw = bx1 - bx0, bh = by1 - by0;
        if (bw <= 0 || bh <= 0) throw new Error("empty box for pictureInputBox");

        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, w, h); }
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        if (editor.tileMode) {
            const s = Math.min(1, Math.max(w / bw, h / bh));
            const sample = await editor.sampleRegionSettled("image", [bx0, by0, bx1, by1], s, { forRun: true, skipFilters });
            ctx.drawImage(sample, 0, 0, w, h);
        } else {
            if (editor.relightSettled) await editor.relightSettled();
            const flat = editor.flattenToCanvas({ forRun: true, skipFilters });
            ctx.drawImage(flat, bx0, by0, bw, bh, 0, 0, w, h);
        }
        const image = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
        return { image, width: w, height: h };
    },

    /**
     * Compute a detailed depth map by tiling and fusing or large input (PLAN_NIK9_BUILD.md R2-S7).
     * @param {any} editor
     * @param {{ grid?: number, route?: string, onProgress?: (i: number, n: number) => void, signal?: AbortSignal, global?: any }} [opts]
     */
    async depthDetail(editor, { grid = 2, route = "tiles", onProgress = null, signal = null, global = null } = {}) {
        const W = editor.width, H = editor.height;
        if (!W || !H) throw new Error("empty document");
        const model = this.depthModel();
        if (!model) throw new Error("No depth model is downloaded (Settings > Helpers)");

        if (route === "large") {
            const scale = DEPTH_LARGE / Math.max(W, H);
            const mw = Math.max(14, roundHalfEven((W * scale) / 14) * 14);
            const mh = Math.max(14, roundHalfEven((H * scale) / 14) * 14);
            const inp = await this.pictureInput(editor, mw, mh, { skipFilters: true, background: "#808080" });
            if (signal && signal.aborted) return null;
            const res = await this.computeDepth(editor, { image: inp.image, width: mw, height: mh });
            if (onProgress) onProgress(1, 1);
            if (signal && signal.aborted) return null;
            return { data: res.depth, w: mw, h: mh, fits: [], route: "large", grid: 1 };
        }

        const boxes = tileBoxes(W, H, grid);
        const n = boxes.length;
        const tiles = [];
        const [mw, mh] = modelSize(W, H);

        for (let i = 0; i < n; i++) {
            if (signal && signal.aborted) return null;
            if (onProgress) onProgress(i + 1, n);
            const box = boxes[i];
            const inp = await this.pictureInputBox(editor, box, mw, mh, { skipFilters: true, background: "#808080" });
            if (signal && signal.aborted) return null;
            const raw = await this.computeDepth(editor, { image: inp.image, width: mw, height: mh });
            editor.helperUsed = true;
            if (signal && signal.aborted) return null;
            tiles.push({
                box,
                data: raw.depth,
                w: mw,
                h: mh,
            });
        }

        const [wf, hf] = fusedSize(W, H, boxes, 518);
        const globalCopy = {
            data: global && global.data ? (global.data.slice ? global.data.slice() : new Float32Array(global.data)) : new Float32Array(wf * hf),
            w: global ? global.w : mw,
            h: global ? global.h : mh,
        };
        const tileBuffers = tiles.map((t) => t.data.buffer);
        const transfer = [globalCopy.data.buffer, ...tileBuffers];

        const fused = await editorPool().run("depth_fuse", {
            global: globalCopy,
            tiles,
            W,
            H,
            wf,
            hf,
        }, transfer, { priority: INTERACTIVE, timeout: 300000 });

        if (signal && signal.aborted) return null;

        const fusedData = fused.data instanceof Float32Array ? fused.data : new Float32Array(fused.data);
        return {
            data: fusedData,
            w: wf,
            h: hf,
            fits: fused.fits || [],
            route: "tiles",
            grid,
        };
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
    // a prompt of a closed tab lands nowhere (the fallbacks below would hand it to the tab in front)
    if (detail.prompt_id != null && host._closedPrompts.has(String(detail.prompt_id))) return;
    // the canvas node's notes on boxes it left out or could not write into box_prompt (docs/PLAN_NODE_BOXES.md D9; it runs
    // before the result): the run's notes, and the status line once the result has landed. Only for a run that took
    // box_prompt (queueGenerate's `_boxPrompts`): the node also writes rows nobody reads, for a switch left on under a
    // recipe that takes no boxes or a Generate new without any, and their notes say nothing about the run
    const boxNotes = Array.isArray(out.inpaint_boxes) ? out.inpaint_boxes.filter((n) => typeof n === "string" && n) : [];
    const boxEd = boxNotes.length && detail.prompt_id != null ? host.editorByPrompt(detail.prompt_id) : null;
    if (boxEd && boxEd._boxPrompts && boxEd._boxPrompts.has(String(detail.prompt_id))) {
        const held = boxEd._boxNotes || (boxEd._boxNotes = new Map());
        held.set(String(detail.prompt_id), boxNotes);
        while (held.size > 50) held.delete(held.keys().next().value);
        if (String(boxEd.lastPromptId) === String(detail.prompt_id) && Array.isArray(boxEd.lastRunNotes)) boxEd.lastRunNotes.push(...boxNotes);
        if (window.scumble && window.scumble.log) Promise.resolve(window.scumble.log.add({ level: "warn", source: "comfy", message: `local run ${detail.prompt_id}: boxes`, detail: boxNotes.join(" ") })).catch(() => { /* the log is optional */ });
    }
    // a run's prompt upsampler (0.1.50 Q9): its caption, which the image model got instead of the prompt as typed, into
    // the log, and a note on the run once the result has landed
    const upNode = detail.prompt_id != null ? host._upsampledRuns.get(String(detail.prompt_id)) : null;
    if (upNode && String(detail.node) === upNode && Array.isArray(out.text) && typeof out.text[0] === "string") {
        host._upsampledRuns.delete(String(detail.prompt_id));
        const caption = out.text[0];
        const upEd = host.editorByPrompt(detail.prompt_id);
        const note = upsampledNote(caption);
        if (upEd && String(upEd.lastPromptId) === String(detail.prompt_id) && Array.isArray(upEd.lastRunNotes)) upEd.lastRunNotes.push(note);
        // the status line once the result has landed (the result's own line comes first); a result already in takes it now
        if (upEd) {
            const pid = String(detail.prompt_id);
            if (upEd._upLanded && upEd._upLanded.has(pid)) { upEd._upLanded.delete(pid); upEd.setStatus(`${upEd.status} ${note}`, upEd.statusKind || "info"); }
            else (upEd._upNotes || (upEd._upNotes = new Map())).set(pid, note);
        }
        if (window.scumble && window.scumble.log) Promise.resolve(window.scumble.log.add({ level: "info", source: "comfy", message: `local run ${detail.prompt_id}: the prompt upsampler's caption`, detail: caption })).catch(() => { /* the log is optional */ });
    }
    // Results: the recipe's canvas node id is the same for every tab, so the prompt id
    // decides; helper outputs carry the editor id the helper prompt was queued with.
    if (out.inpaint_result) {
        const ed = host.editorByPrompt(detail.prompt_id) || host.editor;
        const sent = ed && ed._sentTexts && ed._sentTexts.get(detail.prompt_id);
        if (sent) ed._sentTexts.delete(detail.prompt_id);
        const notes = ed && ed._boxNotes && detail.prompt_id != null ? ed._boxNotes.get(String(detail.prompt_id)) : null;
        if (notes) ed._boxNotes.delete(String(detail.prompt_id));
        if (ed && ed._boxPrompts && detail.prompt_id != null) ed._boxPrompts.delete(String(detail.prompt_id));
        const landed = ed ? ed.addResults(sent ? out.inpaint_result.map((r) => ({ ...r, ...sent, via: sent.via ? `${sent.via}, ${Math.round((Date.now() - sent.viaStarted) / 1000)} s` : undefined })) : out.inpaint_result) : null;
        if (notes) Promise.resolve(landed).then(() => ed.setStatus(`${ed.status} Boxes: ${notes.join(" ")}`, "warn")).catch(() => { /* the result's own line stands */ });
        // the run's upsampled prompt (0.1.50 Q9): its note after the result's line; a caption still to come finds the mark
        const pid = detail.prompt_id != null ? String(detail.prompt_id) : null;
        const upNote = ed && pid && ed._upNotes ? ed._upNotes.get(pid) : null;
        if (upNote) { ed._upNotes.delete(pid); Promise.resolve(landed).then(() => ed.setStatus(`${ed.status} ${upNote}`, ed.statusKind || "info")).catch(() => { /* the result's own line stands */ }); }
        else if (ed && pid && host._upsampledRuns.has(pid)) Promise.resolve(landed).then(() => { const l = ed._upLanded || (ed._upLanded = new Set()); l.add(pid); while (l.size > 64) l.delete(l.values().next().value); }).catch(() => { /* nothing to mark */ });
    }
    // a closed tab's helper output (queued while it closed: no prompt id was known) lands nowhere either
    const forNode = (info) => (info && info.canvas_node != null && host._closedNodes.has(String(info.canvas_node)) ? null
        : host.editorById(info && info.canvas_node) || host.editorByPrompt(detail.prompt_id) || host.editor);
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
    if (id != null) host._kleinRuns.delete(String(id));
    for (const ed of host.editors()) if (ed._localRuns) { if (id) ed._localRuns.delete(id); else ed._localRuns.clear(); }
}

/** Whether the prompt was a closed tab's (removeEditor); its end forgets it. */
function closedPromptEnded(detail) {
    const id = detail && detail.prompt_id != null ? String(detail.prompt_id) : null;
    return !!id && host._closedPrompts.delete(id);
}
api.addEventListener("execution_success", ({ detail }) => { localRunEnded(detail); closedPromptEnded(detail); host.pictureRunEvent("success", detail); });
api.addEventListener("execution_interrupted", ({ detail }) => { localRunEnded(detail); closedPromptEnded(detail); host.pictureRunEvent("interrupted", detail); });
api.addEventListener("status", ({ detail }) => {
    const info = detail && detail.status && detail.status.exec_info;
    if (info && info.queue_remaining === 0) for (const ed of host.editors()) { if (ed._localRuns) ed._localRuns.clear(); if (ed.runProgress) ed.runProgress.idle(host.liveRunIds()); }
    else if (info && info.queue_remaining > 0) host.checkTrackedRuns();
});
// a provider run's live progress (Comfy Cloud on v2): the bar of the document it runs for
if (window.scumble.providers && typeof window.scumble.providers.onProgress === "function") window.scumble.providers.onProgress((p) => host.providerProgress(p));
// the status row's bar (docs/PLAN_0_1_48.md S3)
for (const type of ["execution_start", "execution_cached", "executing", "progress", "execution_success", "execution_error", "execution_interrupted"]) {
    api.addEventListener(type, ({ detail }) => host.progressEvent(type, detail));
}

api.addEventListener("execution_error", ({ detail }) => {
    // the owner first: localRunEnded drops the id from the document's open renders, which editorByPrompt reads (and a
    // Klein run's files, read here first)
    const owner = detail ? host.editorByPrompt(detail.prompt_id) : null;
    const klein = detail && detail.prompt_id != null ? host._kleinRuns.get(String(detail.prompt_id)) : null;
    localRunEnded(detail);
    if (!detail) return;
    // a picture run's failure goes to its caller (passPicture's sentence), not into the tab's status
    if (host.pictureRunEvent("error", detail)) { closedPromptEnded(detail); return; }
    // a closed tab's prompt: its failure goes into no tab's status
    if (!owner && closedPromptEnded(detail)) return;
    const ed = owner || host.editor;
    if (!ed) return;
    const msg = detail.exception_message || "execution failed";
    if (ed.segmentPromptId && detail.prompt_id === ed.segmentPromptId) {
        ed.segmentPending = null; if (ed.segBtn) ed.segBtn.disabled = false;
        ed.setStatus("Segmentation failed: " + msg, "error");
    } else if (ed.objectsPromptId && detail.prompt_id === ed.objectsPromptId) {
        ed.objectsPending = null;
        ed.setStatus("Object detection failed: " + msg, "error");
    } else if (ed.upsamplePromptId && detail.prompt_id === ed.upsamplePromptId) {
        ed.upsamplePending = null; if (ed.upBtn) ed.upBtn.disabled = false;
        ed.setStatus("Upsampling failed: " + msg, "error");
    } else if (ed.cutoutPromptId && detail.prompt_id === ed.cutoutPromptId) {
        ed.cutoutPending = null; ed.renderLayers();
        ed.setStatus("Background removal failed: " + msg, "error");
    } else if (realism.isPassNode(detail.node_type)) {
        // the DLSS pack's failures as sentences (docs/PLAN_0_1_42.md §3.4), not "Error in DLSS5EnhanceImages: ...";
        // marked, since a sentence need not read "failed" (the generate command stops its wait on it)
        const text = realism.hint(msg);
        ed.lastPassError = text;
        ed.setStatus(text, "error");
    } else if (klein && SHAPE_ERROR.test(msg)) {
        // a Klein run whose text encoder does not fit the model: said as that, not as torch's matrix shapes (0.1.50 Q1);
        // the sentence reads "failed", so the generate command stops its wait on it at once
        ed.setStatus(kleinEncoderHint(klein, msg), "error");
    } else if (detail.node_type === "InpaintCanvas" && /^Inpaint Canvas: /.test(msg)) {
        // the node's own errors already name it ("Inpaint Canvas: reference 2 (@img2) could not be loaded ..."): said
        // once, with "failed" so the generate command stops its wait on it at once
        ed.setStatus("Inpaint Canvas failed: " + msg.replace(/^Inpaint Canvas: /, ""), "error");
    } else {
        ed.setStatus("Error in " + (detail.node_type || detail.node_id || "the graph") + ": " + msg, "error");
    }
});
