// What the assistant may run by itself, what it has to ask for and what Scumble refuses
// outright (docs/PLAN_ASSISTANT.md §5). The host decides, never a rule in the prompt: anything
// the model reads can talk it into anything.
//
// The policy decides on the *canonical* call - `doc` filled in, every layer reference resolved
// to an id, the arguments clamped - so the card shows exactly what will be sent, and a layer the
// user clicks while the card is open cannot move the call onto another layer.
"use strict";

/** Not in the assistant's tool list at all (§5, "The exclusion set"). */
const EXCLUDED = new Set(["list_commands", "run_action", "set_status", "ailabel_add", "ailabel_remove", "ailabel_info"]);

/** Tools that only read: no user-activity wait, no busy refusal, no undo step. */
const READS = new Set([
    "ping", "list_documents", "list_recipes", "list_plugins", "list_layers", "list_brush_tips",
    "filter_types", "status", "get_state", "read_log", "film_looks", "glb_info", "sample_mean_color",
    "screenshot", "compare",
]);

/** Tools that can queue on the user's ComfyUI or cost money: they ask, and they refuse a busy document. */
const RUNS = new Set(["generate", "generate_new", "upscale", "select_by_text", "cutout_layer", "upsample_prompt"]);

/** The fields of `set_layer` that the editor records no undo step for (§5). */
const SET_LAYER_SOFT = ["name", "visible", "opacity", "blend", "role", "match", "match_source", "alpha_lock"];
/** The fields of `set_layer` that move or resize, which a lock forbids. */
const SET_LAYER_GEOMETRY = ["x", "y", "w", "h", "width", "height"];

const AUTO = (reason) => ({ action: "auto", reason: reason || "" });
const ASK = (reason, card) => ({ action: "ask", reason, card: card || null });
const REFUSE = (reason) => ({ action: "refuse", reason });

/**
 * One row per tool. `decide` calls the row with the canonical call and the facts; a row that is
 * a string is that action with no reason of its own.
 */
const POLICY = {
    // ---- read the app -------------------------------------------------------------------
    ping: AUTO, list_documents: AUTO, list_recipes: AUTO, list_plugins: AUTO, list_layers: AUTO,
    list_brush_tips: AUTO, filter_types: AUTO, status: AUTO, get_state: AUTO, read_log: AUTO,
    film_looks: AUTO, glb_info: AUTO, sample_mean_color: AUTO, screenshot: AUTO, compare: AUTO,

    // ---- selection ----------------------------------------------------------------------
    select_rect: AUTO, select_all: AUTO, select_none: AUTO, select_invert: AUTO, select_feather: AUTO,
    select_grow: AUTO, select_from_layer: AUTO, select_mask: AUTO, select_point: AUTO,
    select_by_text: () => ASK("a SAM3 helper run goes to the front of your ComfyUI queue"),

    // ---- the document's generation fields -----------------------------------------------
    set_prompt: AUTO, set_generation: AUTO, set_crop: AUTO, set_settings: AUTO,

    // ---- layers -------------------------------------------------------------------------
    add_paint_layer: AUTO, add_filter: AUTO, add_text: AUTO, set_active_layer: AUTO,
    move_layer: AUTO, duplicate_layer: AUTO, flip_layer: AUTO, center_layer: AUTO,
    film_apply_look: AUTO, film_add_point: AUTO,

    set_filter: (call) => (hasParams(call) && !call.args.type
        ? AUTO("a filter's parameters; the shell pushes the undo step")
        : AUTO()),

    set_text: (call, facts) => (owns(call, facts)
        ? AUTO()
        : ASK("changes the text of a layer you made", card(call, facts, ["text"]))),

    set_layer: (call, facts) => setLayer(call, facts),

    remove_layer: (call, facts) => (owns(call, facts)
        ? AUTO()
        : ASK("removes a layer you made", card(call, facts, []))),

    merge_down: (call, facts) => {
        const target = layerOf(call, facts);
        const below = layerBelow(target, facts);
        if (!below) return ASK("merges the layer into the base image");
        if (owns(call, facts) && facts.owned && facts.owned.has(below.id)) return AUTO();
        return ASK("merges into a layer you made", card(call, facts, []));
    },

    flatten: () => ASK("merges every visible layer, yours included, into the base image"),
    extend_canvas: (call) => ASK(positive(call.args)
        ? "bakes every visible layer into the base image and drops the others"
        : "crops the canvas"),

    glb_edit: (call, facts) => (call.args && call.args.depth_layer === false && !owns(call, facts)
        ? ASK("removes the depth layer of a 3D object you placed")
        : AUTO()),

    // ---- files --------------------------------------------------------------------------
    add_image_layer: (call) => (call.args && call.args.path
        ? ASK("reads a file from your disk", { path: String(call.args.path) })
        : AUTO()),
    glb_place: (call) => (call.args && call.args.path
        ? ASK("reads a file from your disk", { path: String(call.args.path) })
        : AUTO()),

    export: (call, facts) => exportRow(call, facts, "png"),
    export_layer: (call, facts) => exportRow(call, facts, "png", true),
    export_mask: (call, facts) => exportRow(call, facts, "png", true),

    // ---- paid or queued -----------------------------------------------------------------
    cutout_layer: () => ASK("without an in-app matting model this queues on your ComfyUI"),
    upsample_prompt: () => ASK("rewrites the prompt on a paid model or your ComfyUI"),
    generate: (call, facts) => ASK("renders: this costs money, or queues on your ComfyUI", renderCard(call, facts)),
    generate_new: (call, facts) => ASK("renders a new base image, and clears the undo history", renderCard(call, facts)),
    upscale: (call, facts) => ASK(call.args && call.args.scope === "document"
        ? "upscales the whole picture on a paid model: every layer is scaled along"
        : "upscales the selection: this costs money, or queues on your ComfyUI", renderCard(call, facts)),

    // ---- replace, close, tabs -----------------------------------------------------------
    load_image: () => ASK("replaces the image and clears the undo history"),
    new_canvas: () => ASK("replaces the image and clears the undo history"),
    close_document: () => ASK("closes the tab without saving it to its file; File › Reopen Closed Tab brings it back"),
    new_document: AUTO, activate_document: AUTO,

    // ---- shared history, global settings, the brush --------------------------------------
    undo: () => ASK("the undo stack is shared with your own steps"),
    redo: () => ASK("the undo stack is shared with your own steps"),
    select_recipe: (call, facts) => ASK("the recipe is global and is saved to your settings", card(call, facts, [])),
    set_node_params: (call, facts) => ASK("these values are global and are saved to your settings", card(call, facts, [])),
    set_brush: (call) => (call.args && call.args.spacing !== undefined
        ? ASK("changes an imported brush tip for every tab, and saves it to your brush library")
        : AUTO()),
};

// ---- helpers the rows use ----------------------------------------------------------------

function hasParams(call) {
    const p = call.args && call.args.params;
    return !!p && typeof p === "object" && Object.keys(p).length > 0;
}

function positive(args) {
    return ["left", "right", "top", "bottom"].some((k) => Number(args && args[k]) > 0);
}

/** The layer a call names, out of the loop's `list_layers` read. */
function layerOf(call, facts) {
    const id = call.args && (call.args.layer || call.args.id);
    const list = (facts && facts.layers) || [];
    if (!id) return list.find((l) => l.active) || null;
    return list.find((l) => l.id === id) || null;
}

function layerBelow(target, facts) {
    const list = (facts && facts.layers) || [];
    const at = target ? list.findIndex((l) => l.id === target.id) : -1;
    if (at < 0) return null;
    // list_layers answers top first (commands.js), so the layer below is the next entry
    return list[at + 1] || null;
}

/** Did this chat make the layer the call names? */
function owns(call, facts) {
    const target = layerOf(call, facts);
    return !!(target && facts && facts.owned && facts.owned.has(target.id));
}

/** What the ask card shows: the target and the fields the call changes, old -> new. */
function card(call, facts, fields) {
    const target = layerOf(call, facts);
    const out = { layer: target ? { id: target.id, name: target.name } : null, changes: [] };
    for (const [k, v] of Object.entries((call.args) || {})) {
        if (k === "doc" || k === "layer") continue;
        if (fields.length && !fields.includes(k)) { out.changes.push({ field: k, to: v }); continue; }
        out.changes.push({ field: k, from: target ? target[k] : undefined, to: v });
    }
    return out;
}

/** The render card: the recipe, the document's settings and the ones this chat changed (§5). */
function renderCard(call, facts) {
    const f = facts || {};
    return {
        recipe: f.recipe || null,
        mode: f.mode || null,
        settings: f.settings || null,
        changedByChat: f.changedByChat || [],
        queue: f.queue === undefined ? null : f.queue,
    };
}

function exportRow(call, facts, fallback, fixedPng) {
    const args = call.args || {};
    const path = args.path === undefined || args.path === null ? "" : String(args.path);
    if (!path) return REFUSE("pass an absolute path: the save dialog would hold the turn");
    const format = fixedPng ? "png" : String(args.format || fallback).toLowerCase();
    const ext = String((facts && facts.file && facts.file.ext) || "").replace(/^\./, "").toLowerCase();
    if (ext && !extMatches(ext, format)) {
        return REFUSE(`the extension .${ext} does not match the format ${format}`);
    }
    const exists = !!(facts && facts.file && facts.file.exists);
    return ASK(exists ? "writes a file that exists and will be overwritten" : "writes a new file to your disk",
        { path, format, exists });
}

function extMatches(ext, format) {
    const f = String(format).toLowerCase();
    if (f === "jpeg" || f === "jpg") return ext === "jpg" || ext === "jpeg";
    if (f === "tiff") return ext === "tif" || ext === "tiff";
    return ext === f;
}

/** `set_layer` takes the strictest row of the fields it sets (§5). */
function setLayer(call, facts) {
    const args = call.args || {};
    const target = layerOf(call, facts);
    const soft = SET_LAYER_SOFT.filter((k) => args[k] !== undefined);

    if (args.locked === false) return ASK("unlocks a layer you locked", card(call, facts, ["locked"]));
    // a locked layer against geometry is caught in `decide`, before any row runs
    if (soft.length && !owns(call, facts)) return ASK("changes a layer you made", card(call, facts, soft));
    return AUTO();
}

// ---- clamping -----------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/** The command's own default `timeout`, filled in so the Bridge's timer is long enough (§5). */
const TIMEOUT_DEFAULTS = { select_by_text: 300, upsample_prompt: 300, cutout_layer: 300, generate: 600, generate_new: 600, upscale: 1800 };

/**
 * The arguments as they are sent: a screenshot small enough to be cheap, a log page bounded, and
 * every long-running command with an explicit `timeout` so the Bridge waits longer than it can run.
 * Returns a new call; the original is left alone.
 */
function clamp(call, opts = {}) {
    const name = call.name;
    const args = { ...(call.args || {}) };
    if (name === "screenshot") {
        args.max_size = clampInt(args.max_size, 64, opts.screenshotMax || 1024, opts.screenshotMax || 1024);
        const q = Number(args.quality);
        args.quality = Number.isFinite(q) ? Math.min(0.85, Math.max(0.3, q)) : 0.85;
    }
    if (name === "read_log") args.limit = clampInt(args.limit, 1, 100, 100);
    if (Object.prototype.hasOwnProperty.call(TIMEOUT_DEFAULTS, name)) {
        args.timeout = clampInt(args.timeout, 5, 3600, TIMEOUT_DEFAULTS[name]);
    }
    if (name === "select_point") args.timeout = 600;   // the command ignores it; the Bridge waits by it
    return { ...call, args };
}

/** The seconds the Bridge will be asked to wait beyond its own 600 s, for the call's timeout. */
function timeoutOf(call) {
    const t = Number((call.args || {}).timeout);
    return Number.isFinite(t) ? t : 0;
}

// ---- the decision -------------------------------------------------------------------------

/**
 * @param call  {name, args} - canonical: `doc` filled in, layer references resolved, clamped
 * @param facts {tools: Set of the chat's tool names, owned: Set of layer ids, layers: [],
 *               busy: bool, failedTwice: bool, file: {ext, exists}, recipe, settings, ...}
 * @returns {{action: "auto"|"ask"|"refuse", reason: string, card: object|null}}
 */
function decide(call, facts = {}) {
    const name = String(call && call.name);
    if (EXCLUDED.has(name) || (facts.tools && !facts.tools.has(name))) {
        return REFUSE("not one of your tools in this chat");
    }
    if (facts.failedTwice) {
        return REFUSE("this exact call failed twice; change it or ask the user");
    }
    if (RUNS.has(name) && facts.busy) {
        return REFUSE("that document is already rendering; wait for it to finish");
    }
    // a locked layer: no moving, no resizing, no text edit (the editor forbids it; the commands do not)
    const target = layerOf(call, facts);
    if (target && target.locked && (name === "set_text" || (name === "set_layer" && SET_LAYER_GEOMETRY.some((k) => (call.args || {})[k] !== undefined)))) {
        return ASK("the layer is locked (no moving, no text edits)", card(call, facts, []));
    }

    const row = POLICY[Object.prototype.hasOwnProperty.call(POLICY, name) ? name : ""];
    if (!row) return ASK("not in the assistant's table");
    const out = typeof row === "function" ? row(call, facts) : row;
    return { action: out.action, reason: out.reason || "", card: out.card || null };
}

// ---- the undo step the shell pushes for a call that records none (A7) ----------------------

/**
 * Which of the editor's own step kinds the shell has to push before this call, so that Ctrl+Z
 * takes it back (§5, §2 row 19). A read, and a call the command records a step for itself, gets
 * none.
 */
function undoStep(call, facts = {}) {
    const name = String(call && call.name);
    const args = (call && call.args) || {};
    if (READS.has(name)) return null;
    if (["add_paint_layer", "add_filter", "add_text", "add_image_layer", "duplicate_layer", "generate", "glb_place"].includes(name)) return "layers";
    if (name === "film_apply_look") return addsLayer(facts) ? "layers" : null;
    // the selection's upscale adds a result layer as generate does; the whole picture's pushes its own `canvas` step
    if (name === "upscale") return args.scope === "document" ? null : "layers";
    if (name === "set_filter") return hasParams(call) && !args.type ? "filter" : null;
    if (name === "set_text") return "text";
    if (name === "set_layer") {
        const soft = SET_LAYER_SOFT.filter((k) => args[k] !== undefined);
        if (!soft.length) return null;                                    // geometry pushes its own `transform`
        if (soft.length === 1 && (soft[0] === "match" || soft[0] === "match_source")) return "match";
        if (soft.every((k) => k === "match" || k === "match_source")) return "match";
        return "layers";
    }
    return null;
}

/** `film_apply_look` adds a layer unless the active one already is a film look. */
function addsLayer(facts) {
    const list = (facts && facts.layers) || [];
    const active = list.find((l) => l.active);
    return !(active && String(active.filter || "") === "film.look");
}

module.exports = {
    EXCLUDED, READS, RUNS, POLICY, decide, clamp, clampInt, timeoutOf, undoStep,
    SET_LAYER_SOFT, SET_LAYER_GEOMETRY, TIMEOUT_DEFAULTS,
    _layerOf: layerOf, _owns: owns, _extMatches: extMatches,
};
