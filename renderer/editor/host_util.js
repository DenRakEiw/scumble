// @ts-check
// host.js helpers: texts and hints, the export sizes, the document question, Klein, key and run helpers, api, object ids: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import * as comfyprompt from "./comfyprompt.js";
import * as keying from "./keying.js";
import { refusal } from "./inpaint_status.js";
import { loraWords } from "./loras.js";

let host = null;

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

// a run note that only explains how the run went, not what it left out or changed (item 45: those show red); the
// LoRA rows a recipe whose LoRAs section is hidden still keeps (loraPlan's `hidden`) are no omission the user could
// see or mend there, so their line is plain too; the separate areas' advice (eacharea.js areaHint) changes nothing, and
// Comfy Cloud's GPT Image node sending no mask beside several pictures (comfycloud.js MASK_LEFT_OUT) still keeps the
// result inside the selection
const HINT_NOTE = /^\(wording guessed from the graph\)$|^Prompt expansion went as None |^Served by .+ \(Comfy Router's fallback provider\)\.$|^LoRAs: |^The LoRA rows stored for this recipe stayed out: |^\d+ separate areas; the crop goes at |^Comfy Cloud's GPT Image node takes a mask with one picture only/;
/** The kind of a line that appends a run's notes to the one before: red when a note says something was left out. */
function notesKind(editor, notes) {
    return notes.some((n) => !HINT_NOTE.test(String(n))) ? "warn" : (editor.statusKind || "info");
}

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
 * The piece an export goes to main in (saveExport): one IPC message of about 512 MiB or more ends this renderer (oom;
 * 500 MB saved and 600 MB ended it, measured 2026-10-24), and a piece is read off the blob on its own, so no copy of
 * the whole file is made here either.
 */
const SAVE_PIECE = 64 * 1048576;

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
    if (q.kind === "replace") {
        const n = q.layers || 0;
        const what = n ? `its ${n} layer${n === 1 ? "" : "s"}` : "the picture";
        return {
            answers: ["replace", "cancel"],
            spec: {
                buttons: ["Replace", "Cancel"], defaultId: 1, cancelId: 1, danger: 0,
                title: `Replace ${name} with the new picture?`,
                detail: `Generate new replaces ${what} and the picture under them when the answer lands, and the undo history goes with them; reference layers stay. This cannot be undone: cancel and save first if you may want it back.`,
            },
        };
    }
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
/** An area of Each area (eacharea.js) reached its run with another recipe selected than the one its click confirmed. */
const AREA_RECIPE_CHANGED = "The recipe changed while the areas ran: this area was not sent.";
/** An area of Each area stopped (its Stop, a Cancel) before its prompt went to the user's ComfyUI. */
const AREA_STOPPED = "Stopped before this area was queued: nothing went to your ComfyUI.";
const AREA_STOPPED_API = "Stopped before this area was sent: nothing went to the provider.";
/** Main's refusals before a request goes out (no or a stale key, no such provider or endpoint, a malformed request). */
const NOT_SENT = /^No API key for |key was stored on another PC or Windows account|^Unknown provider: |has no (text-to-image endpoint|upscaler|relight endpoint) in Scumble|nothing was sent|nothing runs or is charged/;
/**
 * The refusal of a run whose recipe needs words (`promptRequired`, P-H3-Image: without them the model redraws the crop, or
 * its upsampler invents an edit) when the prompt is empty or blank; "" otherwise. The model's name is the recipe's
 * without its route in brackets ("P-H3-Image (ComfyUI)" -> "P-H3-Image"). A refusal of the user's state: a plain line.
 */
function promptMissing(r, prompt) {
    if (!r || r.promptRequired !== true || /\S/.test(String(prompt || ""))) return "";
    const model = String(r.name || r.id || "This recipe").replace(/\s*\([^()]*\)\s*$/, "") || String(r.id);
    return `${model} needs a prompt: say what to change, or what to make on Generate new.`;
}
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
 * "FLUX 3 Image via Comfy Router, 23 s"; shown in the status line and the history, never stored in the document. The
 * LoRAs the run loaded (item 50, `loras` [{ name, strength }]) follow the route: "FLUX 3 Image Klein via your ComfyUI
 * + 2 LoRAs: Flux3_Targa 0.8, nyc_style 1.0, 14 s" (the history entry keeps a fixed set of fields, so they ride in it).
 */
function viaLine(r, route, seconds, loras = null) {
    const model = (r && (r.name || r.id)) || "";
    const secs = Number.isFinite(+seconds) && seconds !== null ? `, ${Math.round(+seconds)} s` : "";
    const n = Array.isArray(loras) ? loras.length : 0;
    const with_ = n ? ` + ${n} LoRA${n === 1 ? "" : "s"}: ${loraWords(loras)}` : "";
    return model || route ? `${model}${model && route ? " via " : ""}${route || ""}${with_}${secs}` : "";
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
/** The Key screen's bands: 256 rows, as the selection's banded writers (inpaint_canvas.js RANGE_BAND_ROWS). */
const KEY_BAND_ROWS = 256;
/** A layer mask's colour where it lets through: inpaint_canvas.js MASK_RGB (combine's default is the selection's red). */
const KEY_MASK_RGB = [255, 255, 255];

/** A hint plane (255 = subject) as an opaque grey RGBA picture: what a key on your ComfyUI uploads (ImageToMask, red). */
function keyGreyRgba(plane) {
    const out = new Uint8Array(plane.length * 4);
    for (let i = 0; i < plane.length; i++) { const v = plane[i], o = i * 4; out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255; }
    return out;
}

/** One call into the key process (helpers:keyPrepare / keyRun, I3); refused while this build has none. */
function keyHelper(name, req) {
    const h = window.scumble && window.scumble.helpers;
    if (!h || typeof h[name] !== "function") return Promise.reject(refusal(keying.TEXTS.notInstalled, "info"));
    return host.helperCall(name, req);
}

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

// an id per object, for signatures that must tell a replaced object from one of the same version (host.realismWhole)
const objectIds = new WeakMap();
let objectSeq = 0;
function objectId(o) {
    if (!o || typeof o !== "object") return 0;
    let n = objectIds.get(o);
    if (!n) { n = ++objectSeq; objectIds.set(o, n); }
    return n;
}

export { API_SIZES, AREA_RECIPE_CHANGED, AREA_STOPPED, AREA_STOPPED_API, CLOSED_MAX, ENCODER_MAX_SIDE, EXPORT_PERCENTS, HINT_NOTE, KEY_BAND_ROWS, KEY_MASK_RGB, MAX_EXPORT_SIDE, NOT_SENT, RELIGHT_DEFAULTS, RUN_GOING, SAVE_PIECE, SHAPE_ERROR, STATE_KEYS, SUBFOLDER, answeredSeed, aspectOf, boxesSchema, capExportSide, docMeta, documentQuestion, fmtMB, hashString, keyGreyRgba, keyHelper, kleinEncoderHint, kleinRun, listWords, mosaicPixels, normPath, notesKind, objectId, plainObject, promptMissing, providerEdit, runIdOf, sentTexts, textOptions, upsampledNote, upscaleWords, viaLine, bindUtil };

function bindUtil(C) { host = C; }
