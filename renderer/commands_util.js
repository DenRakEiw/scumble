// the helpers of the commands: summaries, lookups, shots, status, the parameter tables, checkParams and describe: moved out of commands.js (item 56 S12, docs/PLAN_SPLIT.md), text unchanged.

import * as genpresets from "./editor/genpresets.js";
import { host } from "./editor/host.js";
import { RELIGHT_LIGHT_TYPES, RELIGHT_STYLES, makeCanvas, viewUrl } from "./editor/inpaint_canvas.js";
import { FILTERS } from "./editor/inpaint_filters.js";
import { normalizeLimit } from "./editor/inpaint_weights.js";
import { RELIGHT_ROUTES, normalizeLights } from "./editor/inpaint_relight.js";
import { fontList } from "./editor/inpaint_text.js";
import { parse, remap } from "./editor/reftokens.js";
import { lacksNodesText } from "./editor/comfyprompt.js";
import { refusal } from "./editor/inpaint_status.js";
import { MAX_LORAS, clampStrength, loraHint, missingLoras, normalizeName, recipeFamily } from "./editor/loras.js";

/** @typedef {import("./commands.js").CommandDescriptor} CommandDescriptor */

let COMMANDS = null;

const VERSION = 2;   // 1 = the node's bridge

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function until(fn, ms, step = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { if (await fn()) return true; } catch (_) { /* keep waiting */ }
        await wait(step);
    }
    return false;
}

function clampInt(v, lo, hi, dflt) {
    const n = Math.round(+v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

// ---- summaries -----------------------------------------------------------------------------

export function docSummary(ed) {
    return {
        id: ed.node.id, name: docName(ed), active: host.isActive(ed), width: ed.width || 0, height: ed.height || 0, layers: ed.layers.length, loaded: !!ed.base, busy: busy(ed),
        // its .scumble file (null: not saved as a document) and whether the tab has changes that are not in it
        file: ed.docFile && ed.docFile.path ? ed.docFile.path : null, dirty: host.documentDirty(ed),
    };
}

function docName(ed) {
    return host.documentName(ed);
}

/** What the tab's last load left out (inpaint_canvas.js setValue: layers of a newer version, filter layers that did not load), as a note. */
function loadNotes(ed) {
    return ed && ed.leftOut && ed.leftOut.note ? [ed.leftOut.note] : [];
}

function busy(ed) {
    return !!(ed.pending || ed.segmentPending || ed.cutoutPending || ed.upsamplePending || ed.objectsPending || ed.depthPending || ed.rangePending || ed._loading || ed.providerPending || ed._docSaving || (ed.pointer && ed.pointer.healing));
}

export function layerSummary(ed, l) {
    const out = {
        id: l.id, name: l.name, kind: l.kind, role: l.role || "none", visible: !!l.visible, opacity: Math.round((l.opacity == null ? 1 : l.opacity) * 100) / 100,
        blend: l.blend || "normal", x: l.x, y: l.y, w: l.w, h: l.h, locked: !!l.locked, alpha_lock: !!l.alphaLock, clip: !!l.clip, mask: !!l.maskPx,
        active: l.id === ed.activeLayerId,
    };
    // a reference's label: what @img1 in the prompt names (null while it is hidden: its tokens wait as @img?<id>)
    if (ed.isReference(l)) { const n = ed.refLabels().get(l.id); out.label = n ? "img" + n : null; }
    if (l.clip) { const b = ed.clipBaseOf ? ed.clipBaseOf(l) : null; out.clip_base = b ? b.id : null; }   // null: the clip has no effect
    if (l.group && ed.groupById) {   // the innermost group it is in, and whether a group's eye hides it
        out.group = l.group;
        if (l.visible && !ed.shown(l)) out.hidden_by_group = true;
        if (!l.locked && ed.isLocked(l)) out.locked_by_group = true;
    }
    if (l.maskPx && l.maskOff) out.mask_off = true;   // the mask is kept but switched off
    if (l.match && l.match.strength > 0) out.match = { strength: l.match.strength, source: l.match.source };
    if (l.kind === "filter") {
        out.filter = l.filter;
        out.params = { ...(l.params || {}) };
        if (l.lut) out.lut = l.lut.name || true;
        if (l.filter === "relight") {
            const lights = Array.isArray(l.params && l.params.lights) ? l.params.lights : [];
            out.lights_count = lights.length;
            out.selected_light = l._deselected ? null : (l._selectedLightId || (lights[0] ? lights[0].id : null));
        }
    }
    if (l.kind === "text" && l.text) {
        out.text = { content: l.text.content, font: l.text.font, size: l.text.size, color: l.text.color, bold: !!l.text.bold, italic: !!l.text.italic, align: l.text.align,
            line_height: +l.text.lineHeight || 1.2, letter_spacing: +l.text.letterSpacing || 0 };
        // how the text is turned on the screen in all (its quarter turns and its free angle), and mirrored
        const angle = ((((+l.text.angle || 0) + 90 * ((l.text.turn | 0) & 3)) % 360) + 360) % 360;
        if (angle) out.text.angle = Math.round((angle > 180 ? angle - 360 : angle) * 1000) / 1000;
        if (l.text.flip) out.text.flipped = true;
    }
    return out;
}

/**
 * An agent's text with its @img tokens read by its own map (`refs`: {"img1": "<layer id>"}) and rewritten to the
 * labels now (docs/PLAN_REFS.md 26b sub-task 17); a token the map does not hold stays as it is. No `refs`: unchanged.
 */
function agentRefs(ed, text, refs) {
    const now = ed.refLabels();
    // without refs the text is read with the labels of now: only a parked token of a shown layer changes (it unparks)
    if (refs == null) return remap(text, now, now);
    if (typeof refs !== "object" || Array.isArray(refs)) throw new Error('refs must be an object like {"img1": "<layer id>"}');
    const mine = new Map();
    for (const [k, id] of Object.entries(refs)) {
        const m = /^@?img([1-9]\d{0,2})$/i.exec(k);
        if (!m) throw new Error(`refs: "${k}" is no label (img1, img2 ...)`);
        if (!ed.layers.some((l) => l.id === String(id))) throw new Error(`refs: ${k} names no layer "${id}" (list_layers gives the ids)`);
        if (mine.has(String(id))) throw new Error(`refs: img${mine.get(String(id))} and ${k} both name layer "${id}": give each layer one label`);
        if ([...mine.values()].includes(+m[1])) throw new Error(`refs: img${m[1]} is given twice`);
        mine.set(String(id), +m[1]);
    }
    return remap(text, mine, now);
}

/** The labels of the shown references ({"img1": "<layer id>"}) and the tokens of the prompt that wait for a hidden or removed one. */
function refsReport(ed) {
    const labels = {};
    for (const [id, n] of ed.refLabels()) labels["img" + n] = id;
    const parked = [];
    for (const t of [ed.promptText, ed.negativeText]) for (const seg of parse(t)) if (seg.type === "token" && "id" in seg && !parked.includes(seg.text)) parked.push(seg.text);
    return { labels, parked };
}

/** A layer by id, exact name, or unique name fragment; "active" / empty = the active layer. */
/** A group (PLAN_0_1_31 §6.5) by id, or by name (exact, then a unique case-insensitive part). */
export function findGroup(ed, key) {
    const s = String(key == null ? "" : key);
    const gs = ed.groups || [];
    const g = gs.find((x) => x.id === s) || gs.find((x) => x.name === s);
    if (g) return g;
    const part = gs.filter((x) => x.name.toLowerCase().includes(s.toLowerCase()));
    if (s && part.length === 1) return part[0];
    throw new Error(part.length > 1 ? `"${s}" names more than one group: ${part.map((x) => x.name).join(", ")}` : `no group "${s}"${gs.length ? ` (groups: ${gs.map((x) => x.name).join(", ")})` : " (the document has none)"}`);
}

export function groupSummary(ed, g) {
    return { id: g.id, name: g.name, visible: g.visible !== false, locked: !!g.locked, collapsed: !!g.collapsed, parent: g.parent || null, layers: ed.groupLayers(g.id).map((l) => l.id) };
}

export function findLayer(ed, key, { allowActive = true } = {}) {
    if (key == null || key === "" || (key === "active" && allowActive)) {
        const a = ed.activeLayer();
        if (!a) throw new Error("no active layer: pass a layer id or name");
        return a;
    }
    const s = String(key);
    let l = ed.layers.find((x) => x.id === s);
    if (!l) l = ed.layers.find((x) => (x.name || "").toLowerCase() === s.toLowerCase());
    if (!l) {
        const matches = ed.layers.filter((x) => (x.name || "").toLowerCase().includes(s.toLowerCase()));
        if (matches.length === 1) l = matches[0];
        else if (matches.length > 1) throw new Error(`"${s}" matches ${matches.length} layers: ${matches.map((m) => m.name).join(", ")}`);
    }
    if (!l) throw new Error(`no layer "${s}" (layers: ${ed.layers.map((x) => `${x.name} [${x.id}]`).join(", ") || "none"})`);
    return l;
}

/**
 * A change the editor refuses with no more than its status line (a locked layer, by its own lock or a group's; with
 * `what`, a filter layer, which has no pixels or place of its own): said as an error before the editor is called, so an
 * agent does not read the answer as done.
 */
function refuseLayer(ed, l, what) {
    const name = l.name || l.id;
    if (what && l.kind === "filter") throw new Error(`layer ${name} is a filter layer: it cannot be ${what}`);
    if (ed.isLocked(l)) throw new Error(l.locked ? `layer ${name} is locked: unlock it first (set_layer locked false)` : `layer ${name} is locked by its group: unlock the group first (set_group locked false)`);
}

/** After a change made outside the editor's own handlers: caches off, lists and canvas fresh. */
export function touch(ed, { layers = true } = {}) {
    ed.uploaded.baseHash = null;
    ed.uploaded.controlHash = null;
    if (layers) ed.renderLayers();
    ed.renderInfo();
    ed.draw();
    ed.drawThumb();
    ed.notifyChanged();
}

function requireImage(ed) {
    if (!ed.base || !ed.width) throw new Error("no image loaded: use load_image or new_canvas first");
}

/**
 * The picture `screenshot` encodes, before the layer outlines and the JPEG: `{ canvas, w, h, s, src }`, exported for
 * the gate. On tiles (C6 c5) the image is a region pass at the output's level, a layer is read from its own tiles and
 * the selection tint from the mask's, each with its chains built in the mips worker. Before, it was a full-resolution
 * flatten and the display mirrors of the layer and the selection: at 15000 x 10000 about 3.4 GB made and 2.9 GB kept
 * for a 1024 px JPEG, on a command an agent calls after most steps. The canvas backend keeps its old draws.
 */
export async function shotCanvas(ed, a) {
    const max = clampInt(a.max_size, 64, 4096, 1024);
    const tiles = !!ed.tileMode;
    const what = a.what == null || a.what === "" ? "image" : String(a.what);
    if (!SHOT_WHAT.includes(what)) throw new Error(`what must be one of ${SHOT_WHAT.join(", ")}`);
    // F2a: a region of the picture (`box`), the base alone, a mask in black and white
    const box = shotBox(ed, a.box);
    if (box && what === "layer") throw new Error("box reads a region of the picture; what = layer shows the layer's own pixels whole (leave box out)");
    const layer = what === "layer" ? findLayer(ed, a.layer) : null;
    const masked = what === "mask" && a.layer != null && a.layer !== "" ? findLayer(ed, a.layer) : null;
    if (masked && !masked.maskPx) throw new Error(`${masked.name} has no mask (set_mask adds one)`);
    const r = box || { x: 0, y: 0, w: ed.width, h: ed.height };
    const rect = [r.x, r.y, r.x + r.w, r.y + r.h];
    // a layer alone is its own pixels (unmasked, at their resolution); the picture is a composite
    const src = layer ? { w: layer.px.width, h: layer.px.height } : { w: r.w, h: r.h };
    const s = Math.min(1, max / Math.max(src.w, src.h));
    const w = Math.max(1, Math.round(src.w * s)), h = Math.max(1, Math.round(src.h * s));
    // relight's full shadow maps, not the quick map of a light on the move (docs/PLAN_RELIGHT_FIXES.md F2.7): the canvas
    // backend's flatten below does not wait by itself
    if ((what === "image" || what === "editor") && ed.relightIdle) await ed.relightIdle();
    const c = makeCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.fillStyle = what === "mask" ? "#000000" : "#202020"; ctx.fillRect(0, 0, w, h);
    if (what === "mask") {
        ctx.drawImage(await maskShot(ed, masked, rect, s, w, h), 0, 0);
        return { canvas: c, w, h, s, src, box };
    }
    if (layer) {
        const px = layer.px;
        const job = tiles && typeof px.primeRegion === "function" ? await px.primeRegion([0, 0, src.w, src.h], ed.tileLevel(w / src.w)) : null;
        try {
            if (job && layer.px === px) {
                ctx.save();
                ctx.imageSmoothingEnabled = true;
                ctx.setTransform(w / src.w, 0, 0, h / src.h, 0, 0);
                ed.drawTilesInto(ctx, px, 0, 0, src.w, src.h, { x: 0, y: 0, w: src.w, h: src.h, sx: w / src.w, sy: h / src.h });
                ctx.restore();
            } else layer.px.drawTo(ctx, 0, 0, w, h);
        } finally {
            if (job) job.release();
        }
    } else if (what === "base") {
        // the base alone (the picture before any layer), the peek's pass, on both backends
        ctx.drawImage(await ed.sampleRegionSettled("image", rect, s, { forRun: true, baseOnly: true }), 0, 0);
    } else if (tiles) {
        // a box is padded by as far as its filters read, so its edges are the whole picture's (unknown: unpadded)
        const o = { forRun: what !== "editor" };
        const reach = box && typeof ed.boxReach === "function" ? ed.boxReach(rect, o) : 0;
        ctx.drawImage(await ed.sampleRegionSettled("image", rect, s, Number.isFinite(reach) && reach > 0 ? { ...o, pad: reach } : o), 0, 0);
    } else if (box) {
        ctx.drawImage(ed.flattenToCanvas({ forRun: what !== "editor" }), r.x, r.y, r.w, r.h, 0, 0, w, h);
    } else {
        ctx.drawImage(ed.flattenToCanvas({ forRun: what !== "editor" }), 0, 0, w, h);
    }
    const b = bounds(ed);
    if (a.show_selection !== false && b && ed.sel && !layer) {
        const m = await ed.selectionCanvasSettled(rect, s, w, h);
        ctx.globalAlpha = 0.35;
        if (m) ctx.drawImage(m, 0, 0);
        else if (!box) ed.sel.drawTo(ctx, 0, 0, w, h);
        else { ctx.save(); ctx.setTransform(s, 0, 0, s, -r.x * s, -r.y * s); ed.sel.drawTo(ctx, 0, 0, ed.width, ed.height); ctx.restore(); }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#ff40ff"; ctx.lineWidth = 2; ctx.strokeRect((b.x - r.x) * s, (b.y - r.y) * s, b.w * s, b.h * s);
    }
    return { canvas: c, w, h, s, src, box };
}

/** What `screenshot` shows (F2a added base and mask). */
const SHOT_WHAT = ["image", "editor", "layer", "base", "mask"];

/** `screenshot`'s box [x, y, w, h] in image pixels, held to the picture on whole pixels; null without one. */
function shotBox(ed, box) {
    if (box == null) return null;
    if (!Array.isArray(box) || box.length !== 4 || box.some((v) => v === null || v === "" || !Number.isFinite(+v))) throw new Error("box must be [x, y, w, h] in image pixels");
    const x0 = Math.max(0, Math.floor(+box[0])), y0 = Math.max(0, Math.floor(+box[1]));
    const x1 = Math.min(ed.width, Math.ceil(+box[0] + +box[2])), y1 = Math.min(ed.height, Math.ceil(+box[1] + +box[3]));
    if (!(x1 > x0 && y1 > y0)) throw new Error(`the box ${JSON.stringify(box)} holds no pixel of the ${ed.width} × ${ed.height} picture`);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * A mask over `rect` at `s` as white on transparent (the caller lays it on black): the selection (`layer` null; from its
 * tiles on the tile backend), or a layer's mask over the layer's place, white where the layer shows, switched off or not.
 */
async function maskShot(ed, layer, rect, s, w, h) {
    const m = makeCanvas(w, h);
    const mc = m.getContext("2d");
    if (!layer) {
        const t = await ed.selectionCanvasSettled(rect, s, w, h);
        if (t) mc.drawImage(t, 0, 0);
        else { mc.setTransform(s, 0, 0, s, -rect[0] * s, -rect[1] * s); mc.imageSmoothingEnabled = true; ed.sel.drawTo(mc, 0, 0, ed.width, ed.height); }
    } else {
        mc.setTransform(s, 0, 0, s, -rect[0] * s, -rect[1] * s);
        mc.imageSmoothingEnabled = true;
        ed.drawPixelsInto(mc, layer, layer.maskPx, { x: rect[0], y: rect[1], w: rect[2] - rect[0], h: rect[3] - rect[1], sx: s, sy: s, sample: true });
    }
    mc.setTransform(1, 0, 0, 1, 0, 0);
    mc.globalCompositeOperation = "source-in";
    mc.fillStyle = "#ffffff"; mc.fillRect(0, 0, w, h);
    mc.globalCompositeOperation = "source-over";
    return m;
}

export function bounds(ed) {
    const b = ed.getBounds && ed.getBounds();
    return b ? { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] } : null;
}

function rectMask(ed, x, y, w, h) {
    const W = ed.width, H = ed.height;
    const x0 = clampInt(x, 0, W, 0), y0 = clampInt(y, 0, H, 0);
    const x1 = clampInt(x + w, 0, W, W), y1 = clampInt(y + h, 0, H, H);
    if (x1 <= x0 || y1 <= y0) throw new Error(`empty rectangle ${x},${y} ${w}×${h} on a ${W}×${H} image`);
    const m = new Uint8Array(W * H);
    for (let yy = y0; yy < y1; yy++) m.fill(1, yy * W + x0, yy * W + x1);
    return m;
}

/**
 * generate's `each_area` (item 54): every separate area of the selection on its own, through the host's run of them
 * (eacharea.js; no question before an API run, the agent asked for it), each area's result landed before the next goes
 * (on the user's ComfyUI too). The command's timeout bounds it: no area starts that the time left would not hold, so the
 * answer comes before the bridge stops waiting. A refusal (one area, more than the cap, a recipe that takes none, a stop
 * before anything was sent) throws; a stop after an area went answers with `failed` / `said` instead.
 */
async function generateEachArea(ed, a) {
    if (ed.providerPending) throw refusal("a run is still going on this document");
    const started = Date.now(), limit = clampInt(a.timeout, 5, 3600, 600) * 1000;
    const n0 = ed.history.length;
    // 30 s of the limit stay for the last area's landing and the answer
    const out = await host.generateEachArea(ed, { confirm: false, deadline: started + Math.max(5000, limit - 30000) });
    const landed = ed.history.slice(n0);
    if (!out.sent && out.failed) throw new Error(out.failed);
    const layers = landed.map((h) => ed.layers.find((l) => l.id === h.layerId)).filter(Boolean).map((l) => layerSummary(ed, l));
    return {
        areas: out.areas, generated: landed.length, layers, sent: out.sent, not_sent: out.notSent,
        // an area still running on the user's ComfyUI (the stop or the time came while it ran): it lands when it is done
        still_running: out.running, cancelled: !!out.cancelled, stopped: out.stopped || null, failed: out.failed || null, said: out.said || null,
        left_out: out.leftOut || 0, notes: out.notes || [], status: ed.status, seconds: Math.round((Date.now() - started) / 100) / 10,
    };
}

/** A File from a mirror / server ref {filename, subfolder, type} or from a local path. */
async function fileFrom(a, fallbackName) {
    if (a.path) {
        const r = await window.scumble.file.read(String(a.path));
        const type = /\.jpe?g$/i.test(r.name) ? "image/jpeg" : /\.webp$/i.test(r.name) ? "image/webp" : /\.svg$/i.test(r.name) ? "image/svg+xml" : /\.tiff?$/i.test(r.name) ? "image/tiff" : "image/png";
        return new File([r.data], a.name || r.name, { type });
    }
    if (!a.filename) throw new Error("pass path (a local file) or filename (a file in the local store / ComfyUI input folder)");
    const ref = { filename: a.filename, subfolder: a.subfolder || "", type: a.type || "input" };
    const r = await fetch(viewUrl(ref));
    if (!r.ok) throw new Error(`could not read ${ref.filename} (${r.status})`);
    const b = await r.blob();
    return new File([b], a.name || fallbackName || ref.filename.replace(/~[0-9a-f]{8,64}(?=\.[a-z0-9]+$|$)/i, ""), { type: b.type || "image/png" });
}

export function status(ed) {
    const results = ed.layers.filter((l) => l.kind === "result");
    const r = host.recipe;
    return {
        doc: ed.node.id, name: docName(ed), loaded: !!ed.base, width: ed.width || 0, height: ed.height || 0,
        base: ed.base ? ed.base.ref : null, prompt: ed.promptText || "", negative: ed.negativeText || "",
        generation: { mode: ed.genSettings.mode, seed: ed.genSettings.seed, seed_random: !!ed.genSettings.seedRandom, denoise: ed.genSettings.denoise, boxes: !!ed.genSettings.boxes, ...targetView(ed) },
        crop: cropView(ed), selection: bounds(ed), active_layer: ed.activeLayerId,
        layers: ed.layers.map((l) => layerSummary(ed, l)), results: results.length, history: ed.history.length,
        // every reference layer top first: its label (what @img<n> names; null while hidden) and, from the `status`
        // command, the name the chosen route sends its picture as
        references: ed.refDescriptors().map((d) => ({ id: d.id, name: d.name, label: d.label ? "img" + d.label : null, visible: d.visible })),
        pending: { segment: !!ed.segmentPending, cutout: !!ed.cutoutPending, upsample: !!ed.upsamplePending, transform: !!ed.pending, objects: !!ed.objectsPending, provider: !!ed.providerPending, depth: !!ed.depthPending, range: !!ed.rangePending },
        recipe: r ? { id: r.id, name: r.name || r.id, kind: r.kind || "comfy", provider: r.provider || null } : null,
        connected: !!host.connected, status: ed.status || "",
        // the pixel backend of this document (docs/PLAN_BCE.md §C2 step b) and what chose it
        pixels: { tiles: !!ed.tileMode, from: ed.tileModeFrom || null },
        realism: realismState(ed),
        key: keyState(ed),
    };
}

/**
 * The document's preset for Generate new (item 34, `genSettings.target`: new_canvas with a recipe, the New dialog with a
 * model, or the last generate_new), as status reports it: `valid` while the picture keeps the size it was made at.
 */
function targetView(ed) {
    const t = ed.genSettings && ed.genSettings.target;
    if (!t || typeof t !== "object") return {};
    return { target: { recipe: t.recipe || null, provider: t.provider || null, aspect: t.aspect || null, size: +t.size || null, width: +t.width || 0, height: +t.height || 0, valid: genpresets.targetValid(t, ed) } };
}

/**
 * The preset generate_new asks for when it is given no width, height or aspect: the document's valid target on the
 * selected recipe (and its provider), else null (1024 x 1024 as before). A target without an aspect (a free size) keeps
 * the document's shape at its size class.
 */
function targetSize(ed, r) {
    const t = ed.genSettings && ed.genSettings.target;
    if (!r || !genpresets.targetValid(t, ed) || t.recipe !== r.id) return null;
    if (r.kind === "provider" && t.provider && t.provider !== r.provider) return null;
    const size = clampInt(t.size, 64, 8192, 1024);
    if (t.aspect && genpresets.parseAspect(t.aspect)) return { aspect: String(t.aspect), size, wh: genpresets.sizeFor(t.aspect, size) };
    return { aspect: null, size, wh: genpresets.sizeFor(`${ed.width}:${ed.height}`, size) };
}

/**
 * After a generate_new: the document's preset is what it was made with (the selected recipe and provider, the aspect,
 * the size class asked for) at the size the answer came back at, so the next Generate new opens on it (item 34). The
 * aspect is kept as "W:H" (what the dialogs and genpresets read), else null (a free size).
 */
function writeTarget(ed, r, aspect, size) {
    if (!ed.base || !ed.width || !ed.height) return;
    const pa = genpresets.parseAspect(aspect);
    ed.genSettings.target = { recipe: r.id, provider: r.kind === "provider" ? r.provider || null : null, aspect: pa ? `${pa[0]}:${pa[1]}` : null, size, width: ed.width, height: ed.height };
}

/**
 * The Realism Pass on this document (docs/PLAN_0_1_42.md R4): whether realism_pass at factor 1 would start now
 * (host.realismWholeRefusal: the refusals host.realismWhole makes before anything is read), the reason when not, the
 * server's note (RTX 30) and the app's values it sends. Above 1 (R-U) a picture already past 7680 × 4320 or 27.9 MP is
 * refused too (it cannot get larger), so the assistant's row refuses on every reason given here, whatever the factor.
 */
function realismState(ed) {
    const v = host.realismValues();
    const reason = host.realismWholeRefusal(ed) || null;
    return { ready: !reason, reason, note: host.realismSupport().note || null, style: v.style, strength: v.intensity, preset: v.preset };
}

/**
 * Key green / blue screen on this document (item 49, docs/PLAN_CORRIDORKEY.md §4.8, §4.11): whether key_screen with its
 * default route (host.keyRoute) would start now (host.keyComfyCheck or host.keyCheck: what the route lacks, a run going,
 * no picture), the reason when not, the in-app engine's provider and working size, the stored trust (the assistant's
 * ask card shows what a key_screen without `trust` sends), and `comfy`: the ComfyUI route's
 * readiness, its pack and card, and the settings it sends (B4).
 */
function keyState(ed) {
    const route = host.keyRoute();
    const cc = host.keyComfyCheck(ed, {});
    const c = route === "comfyui" ? cc : host.keyCheck(ed, {});
    const sup = host.keySupport(), cs = host.keyComfySupport(), v = host.keyValues();
    return {
        ready: !c, reason: c ? c.text : null, route, provider: sup.ok ? sup.provider || null : null, cpu: !!sup.cpu, working_size: host.keyWorkingSize(), trust: v.trust,
        comfy: {
            ready: !cc, reason: cc ? cc.text : null, pack: cs.pack || null, pack_label: cs.packLabel || null, verified: cs.pack ? !!cs.verified : null,
            gpu: cs.gpu || null, note: cs.note || null, cap_mp: v.cap, keep_on_gpu: v.keepOnGpu, timeout: v.comfyTimeout,
        },
    };
}

/**
 * Whether a recipe can run now, for list_recipes (docs/PLAN_0_1_42.md F2a; R4 gave the pass the same three keys): an API
 * recipe by its chosen provider's key or the in-app model (the shell's own check, which Settings › Recipes shows), a
 * recipe on the user's ComfyUI by the connection and the node types it needs (queueGenerate's own check), the pass by
 * the server's check. `v`: the recipe resolved to its chosen provider.
 */
function recipeReadiness(r, v) {
    if (r.task === "pass") {
        const s = host.realismSupport();
        return { ready: !!s.ok, reason: s.reason || null, note: s.note || null };
    }
    if (r.kind === "provider") {
        const ks = host.shell.keyState(v);
        return { ready: !ks || !!ks.ok, reason: ks && !ks.ok ? ks.text : null, note: null };
    }
    // host.connected is never set back; the server's state is (the shell reports every status)
    const st = host.server && host.server.state;
    if (!host.connected || (st && st !== "connected" && st !== "missing-node")) return { ready: false, reason: "Not connected to ComfyUI: Settings › ComfyUI.", note: null };
    const missing = (r.needs || []).filter((n) => host.objectInfo && !host.objectInfo[n]);
    return { ready: !missing.length, reason: missing.length ? lacksNodesText(r, missing) : null, note: null };
}

// ---- LoRAs per recipe (item 50, docs/PLAN_LORAS.md §3.8): what the agents read and write -----------------------------

/** Whether the server answers now (host.connected is never set back; the shell's last status is). */
function serverUp() {
    const st = host.server && host.server.state;
    return !!host.connected && (!st || st === "connected" || st === "missing-node");
}

/**
 * The selected recipe's LoRA rows as status reports them: whether it takes rows and why not (host.loraTakes, the
 * LoRAs section's own answer), its base-model family, each stored row with its hint (the LoRAs section's line; null
 * while unknown or still being read) and whether the server's list has it (null: the list is unread), and `sent`, what
 * a run now would load ([{ name, strength }], host.lorasNow: the switched-on rows through the run's own splice).
 */
function lorasView(r) {
    const t = host.loraTakes(r);
    const fam = t.takes ? recipeFamily(r) : null;
    // a Comfy Cloud recipe's rows name files of Comfy Cloud's lists (the account's imports and its catalog), read by
    // the LoRAs section; no hint there (Scumble cannot read those files)
    const cloud = t.takes && host.loraSource(r) === "cloud";
    const names = t.takes ? host.loraNamesFor(r) : host.loraNames();
    const listed = (n) => (names.length ? names.some((x) => normalizeName(x) === normalizeName(n)) : null);
    const rows = r ? host.loraRows(r).map((row) => {
        const inf = t.takes && !cloud && row.name ? host.loraInfo(row.name) : null;
        const h = inf ? loraHint(inf.fam, fam) : null;
        return { name: row.name, strength: row.strength, on: row.on, hint: h ? h.text : null, mismatch: !!(h && h.kind === "mismatch"), triggers: inf ? inf.triggers || [] : [], on_server: row.name ? listed(row.name) : false };
    }) : [];
    return { takes: !!t.takes, reason: t.takes ? null : t.reason || null, source: t.takes ? (cloud ? "comfycloud" : "comfyui") : null, family: fam, max: MAX_LORAS, rows, sent: t.takes ? host.lorasNow(r) : [] };
}

/**
 * set_generation's `loras` checked into the rows the store keeps, before anything changes: an array (a JSON string of
 * one counts) of at most MAX_LORAS `{ name, strength?, on? }`, each name a file of the server's list (separators
 * normalised, the server's spelling kept), as queueGenerate checks a run's rows: against the list read again, and
 * against an empty or unread list nothing is refused (the name is kept as given). Refused for a recipe that takes no
 * LoRA rows, but [] (a clear) where such a recipe still keeps rows from before it stopped taking them (its graph saved
 * again with a second model loader, say): its LoRAs section is hidden, so this is the one way to clear them. Every
 * named row is checked, switched on or not.
 * @returns {Promise<{ name: string, strength: number, on: boolean }[]>}
 */
async function lorasFromCall(r, given) {
    let list = given;
    if (typeof list === "string") { try { list = JSON.parse(list); } catch (_) { /* refused below */ } }
    if (!Array.isArray(list)) throw new Error("loras must be an array of { name, strength, on } (list_loras gives the names); [] clears the rows");
    const t = host.loraTakes(r);
    const held = !!(r && host.loras && Array.isArray(host.loras[r.id]) && host.loras[r.id].length);
    if (!list.length && r && (t.takes || held)) return [];
    if (!t.takes) throw refusal(t.reason || "The selected recipe takes no LoRA rows.");
    if (list.length > MAX_LORAS) throw refusal(`At most ${MAX_LORAS} LoRAs per recipe: the call names ${list.length}. Nothing was changed.`, "warn");
    const rows = list.map((x, i) => {
        if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error(`loras[${i}] must be an object { name, strength, on }`);
        const name = typeof x.name === "string" ? x.name.trim() : "";
        if (!name) throw new Error(`loras[${i}] names no file (list_loras gives the server's names)`);
        let strength = 1;
        if (x.strength != null && x.strength !== "") {
            const v = clampStrength(x.strength, host.objectInfo);
            if (v == null) throw new Error(`loras[${i}].strength must be a number (1.0 is the LoRA as trained), not ${JSON.stringify(x.strength)}`);
            strength = v;
        }
        let on = true;
        if (x.on != null) {
            if (x.on === true || x.on === "true") on = true;
            else if (x.on === false || x.on === "false") on = false;
            else throw new Error(`loras[${i}].on must be true or false, not ${JSON.stringify(x.on)}`);
        }
        return { name, strength, on };
    });
    const asked = rows.map((row) => ({ name: row.name, strength: row.strength }));
    let names = host.loraNamesFor(r);
    let miss = missingLoras(asked, names);
    if (!names.length || miss.some((m) => !m.server)) { names = await host.refreshLoraNamesFor(r); miss = missingLoras(asked, names); }
    const lacks = miss.filter((m) => !m.server).map((m) => m.name);
    // Comfy Cloud: a name its lists lack is kept as given (an import the lists do not show yet); Comfy answers a wrong one
    if (lacks.length && host.loraSource(r) !== "cloud") {
        const one = lacks.length === 1;
        throw new Error(`Your ComfyUI's LoRA list lacks ${one ? "this file" : "these files"}: ${lacks.join(", ")}. list_loras gives the names it has (put a new file in models/loras and refresh ComfyUI first). Nothing was changed.`);
    }
    const spelt = new Map(miss.map((m) => [m.name, m.server]));
    return rows.map((row) => ({ ...row, name: spelt.get(row.name) || row.name }));
}

/** The longest side an upscaler's scope document takes (host.runUpscale's and upscaleSizeRefusal's), null: no cap. */
function documentMax(r, v) {
    if (r.kind === "provider") return (v.limits && v.limits.max) || 2048;
    const l = r.limits || {};
    const m = Math.min(l.picture || Infinity, l.max || Infinity);
    return Number.isFinite(m) ? m : null;
}

/**
 * What the app is using, in MB: the GPU process and this renderer (docs/PERFORMANCE.md phase
 * 6), and the card as a whole when it can be read (cardUsedMB / cardTotalMB, null otherwise).
 */
async function memoryMB() {
    try {
        const m = await window.scumble.metrics();
        let gpuKB = 0;
        for (const p of m.processes || []) if (p.type === "GPU") gpuKB += p.privateKB || p.workingSetKB || 0;
        const r = m.renderer && m.renderer.process;
        let card = null;
        try { card = await window.scumble.gpuMemory(); } catch (_) { card = null; }
        return { gpuMB: Math.round(gpuKB / 1024), rendererMB: r ? Math.round((r.private || r.residentSet || 0) / 1024) : 0, cardUsedMB: card ? card.usedMB : null, cardTotalMB: card ? card.totalMB : null };
    } catch (_) {
        return null;
    }
}

// ---- parameter schema helpers ---------------------------------------------------------------

/**
 * @typedef {(description?: string, extra?: Partial<CommandParam>) => CommandParam} ParamFn
 * @type {{ layer: ParamFn, timeout: (seconds: number) => CommandParam, num: ParamFn, int: ParamFn, str: ParamFn, bool: ParamFn, obj: ParamFn, arr: ParamFn, enum: (description: string, values: string[], def?: string) => CommandParam, selMode: () => CommandParam }}
 */
const P = {
    layer: (d, extra = {}) => ({ type: "string", description: d || "the layer: id, name, a unique part of the name, or \"active\"", default: "active", ...extra }),
    timeout: (d) => ({ type: "integer", description: `seconds to wait for the result (default ${d})`, default: d }),
    num: (description, extra = {}) => ({ type: "number", description, ...extra }),
    int: (description, extra = {}) => ({ type: "integer", description, ...extra }),
    str: (description, extra = {}) => ({ type: "string", description, ...extra }),
    bool: (description, extra = {}) => ({ type: "boolean", description, ...extra }),
    obj: (description, extra = {}) => ({ type: "object", description, ...extra }),
    arr: (description, extra = {}) => ({ type: "array", description, ...extra }),
    enum: (description, values, def) => ({ type: "string", description, enum: values.slice(), ...(def !== undefined ? { default: def } : {}) }),
    selMode: () => P.enum("replace, add, subtract or intersect", SEL_MODES, "replace"),
};
/** The operations of `set_mask` (the editor's `maskOp`). */
const MASK_OPS = ["invert", "reveal", "hide", "from_selection", "hide_selection", "from_layer", "enable", "disable", "apply", "remove"];
/** How a new selection combines with the one there is. */
const SEL_MODES = ["replace", "add", "subtract", "intersect"];
function selMode(v) {
    const m = v == null || v === "" ? "replace" : String(v);
    if (!SEL_MODES.includes(m)) throw new Error(`mode must be replace, add, subtract or intersect, not ${JSON.stringify(v)}`);
    return m;
}

/** add_text / set_text: the text panel's Line and Spacing fields (inpaint_canvas.js, the text layer's row), their ranges. */
const TEXT_LINE_HEIGHT = [0.5, 4];
const TEXT_SPACING = [-50, 200];
const TEXT_LINE_HEIGHT_TEXT = `line height as a multiple of the size, ${TEXT_LINE_HEIGHT[0]}..${TEXT_LINE_HEIGHT[1]} (default 1.2)`;
const TEXT_SPACING_TEXT = `letter spacing in image pixels, ${TEXT_SPACING[0]}..${TEXT_SPACING[1]} (default 0)`;
/** `{ lineHeight, letterSpacing }` of a call's line_height / letter_spacing (those given), in the panel's ranges; a value that is no number is refused. */
function textSpacing(a) {
    const out = {};
    for (const { k, tk, range } of [{ k: "line_height", tk: "lineHeight", range: TEXT_LINE_HEIGHT }, { k: "letter_spacing", tk: "letterSpacing", range: TEXT_SPACING }]) {
        const [lo, hi] = range;
        const v = a[k];
        if (v == null) continue;
        if (v === "" || typeof v === "boolean" || !Number.isFinite(+v)) throw new Error(`${k} takes a number (${lo}..${hi}), not ${JSON.stringify(v)}`);
        out[tk] = Math.min(hi, Math.max(lo, +v));
    }
    return out;
}

/** relight's light_type that leaves the pick to the lights (the panel's "From the lights": the layer stores none). */
const RELIGHT_FROM_LIGHTS = "from_lights";
/**
 * relight's model values: the controls the Relight panel shows for a generative route (inpaint_canvas.js, the relight
 * layer's route box), each with its label there and the layer keys it writes. `num` [lo, hi, step]: clamped and rounded
 * to the control's step, as the slider gives them.
 */
const RELIGHT_MODEL = {
    strength: { label: "Strength", num: [0, 100, 1], keys: ["strength", "light_transfer_strength"] },
    style: { label: "Style", options: RELIGHT_STYLES, keys: ["style"] },
    preserve_details: { label: "Preserve details", bool: true, keys: ["preserve_details"] },
    interpolate: { label: "Interpolate", bool: true, keys: ["interpolate", "interpolate_from_original"] },
    enable_hr_fix: { label: "High-res fix", bool: true, keys: ["enable_hr_fix"] },
    light_type: { label: "Light type", options: [RELIGHT_FROM_LIGHTS, ...RELIGHT_LIGHT_TYPES], keys: ["light_type"] },
    // in the slider's steps of 5
    lora_strength: { label: "LoRA strength", num: [0, 100, 5], keys: ["lora_strength", "strength_model"] },
    steps: { label: "Steps", num: [1, 20, 1], keys: ["steps"] },
    detail: { label: "Detail from original", bool: true, keys: ["detail"] },
};
/** The percent values that read a value in (0, 1] as a fraction, as the panel reads a stored LoRA strength (loraPercent). */
const RELIGHT_PERCENT = new Set(["strength", "lora_strength"]);
/** A relight call's model values `{ key: value }` (those given; light_type from_lights as undefined); a wrong one is refused. */
function relightModel(a) {
    const out = {};
    for (const [k, m] of Object.entries(RELIGHT_MODEL)) {
        const v = a[k];
        if (v == null) continue;
        if (m.bool) {
            if (v === true || v === "true") out[k] = true;
            else if (v === false || v === "false") out[k] = false;
            else throw new Error(`${k} takes true or false, not ${JSON.stringify(v)}`);
        } else if (m.options) {
            if (!m.options.includes(v)) throw new Error(`"${v}" is not an option of ${k} (${m.options.join(", ")})`);
            out[k] = k === "light_type" && v === RELIGHT_FROM_LIGHTS ? undefined : v;
        } else {
            const [lo, hi, step] = m.num;
            if (v === "" || typeof v === "boolean" || !Number.isFinite(+v)) throw new Error(`${k} takes a number (${lo}..${hi}), not ${JSON.stringify(v)}`);
            // 0.8 is 80 %, not 1 % or a LoRA turned off by the rounding
            const n = RELIGHT_PERCENT.has(k) && +v > 0 && +v <= 1 ? +v * 100 : +v;
            out[k] = Math.min(hi, Math.max(lo, Math.round(n / step) * step));
        }
    }
    return out;
}
/** Checked model values into a relight layer, as the panel's controls write them (an undefined light_type: From the lights). No undo step. */
function writeRelightModel(ed, l, model) {
    if (!l.params) l.params = {};
    for (const [k, v] of Object.entries(model)) {
        for (const key of RELIGHT_MODEL[k].keys) {
            if (v === undefined) delete l.params[key];
            else l.params[key] = v;
        }
    }
    ed.markFilterChanged(l);
}

/** set_crop's keys and the Crop section's choices (inpaint_modal.js buildCrop, the Canvas section's Fill). */
const CROP_KEYS = ["context", "feather", "fill", "colorMatch", "extendFill", "withOriginal", "align", "paste"];
const CROP_FILLS = ["none", "neutral", "blur", "border", "green"];
const EXTEND_FILLS = ["stretch edges", "average color", "grey", "green", "black", "noise"];

/**
 * One set_crop value as the Crop section stores it (docs/PLAN_0_1_42.md F2b): the switches as booleans (the strings
 * "true" / "false" too), the selects as one of their choices. A number for context or feather is refused: the editor
 * reads any value but "auto" as manual and takes the pixels from the node parameters, so 200 was stored and ignored.
 */
function cropValue(k, v) {
    const s = typeof v === "string" ? v.trim().toLowerCase() : v;
    if (k === "colorMatch" || k === "withOriginal" || k === "align") {
        if (s === true || s === "true" || s === 1) return true;
        if (s === false || s === "false" || s === 0) return false;
        throw new Error(`${k} takes true or false, not ${JSON.stringify(v)}`);
    }
    if (k === "context" || k === "feather") {
        if (s === "auto" || s === "manual") return s;
        const param = k === "context" ? "padding" : "feather";
        if (s !== "" && s != null && Number.isFinite(+s)) throw new Error(`${k} takes "auto" or "manual", not a number: manual uses set_node_params ${param} (now ${host.nodeParams[param]} px, the same for every tab)`);
        throw new Error(`${k} takes "auto" or "manual", not ${JSON.stringify(v)}`);
    }
    if (k === "fill") { if (CROP_FILLS.includes(s)) return s; throw new Error(`fill must be one of ${CROP_FILLS.join(", ")}, not ${JSON.stringify(v)}`); }
    if (k === "extendFill") { if (EXTEND_FILLS.includes(s)) return s; throw new Error(`extendFill must be one of ${EXTEND_FILLS.join(", ")}, not ${JSON.stringify(v)}`); }
    // paste: the select's label "whole crop" is the stored "crop"
    if (s === "selection") return "selection";
    if (s === "crop" || s === "whole crop") return "crop";
    throw new Error(`paste must be selection or crop, not ${JSON.stringify(v)}`);
}

/** The crop settings as the editor reads them (stitch.js, cropRect): an old document's "64" is manual, "false" a true colour match. */
function cropView(ed) {
    const cs = ed.cropSettings || {};
    return {
        context: cs.context === "auto" ? "auto" : "manual", feather: cs.feather === "auto" ? "auto" : "manual", fill: cs.fill || "none",
        colorMatch: !!cs.colorMatch, extendFill: cs.extendFill || "average color", withOriginal: !!cs.withOriginal, align: cs.align !== false, paste: cs.paste === "crop" ? "crop" : "selection",
    };
}

/**
 * One row of the Settings section as list_settings gives it: the editor's own reading of the input (settingKind), the
 * value the document holds, and whether the row would take it (a combo's options, a number's range).
 */
function settingRow(ed, t, maxOptions) {
    const k = ed.settingKind(t);
    const e = ed.settings[String(t.index)];
    const value = e ? e.value : undefined;
    const out = { index: t.index, label: t.node.title || t.inputName, input: t.inputName, kind: k.kind, value };
    const o = k.opts || {};
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    if (k.kind === "number") {
        Object.assign(out, { integer: k.type === "INT", min: num(o.min), max: num(o.max), step: num(o.step), default: num(o.default) });
        const v = +value;
        out.valid = value !== undefined && value !== null && value !== "" && Number.isFinite(v) && !(num(o.min) !== undefined && v < o.min) && !(num(o.max) !== undefined && v > o.max);
    } else if (k.kind === "combo") {
        const opts = (k.options || []).map(String);
        out.options = opts.slice(0, maxOptions);
        out.options_total = opts.length;
        out.valid = !opts.length || opts.includes(String(value));
    } else if (k.kind === "boolean") {
        out.valid = typeof value === "boolean";
    } else {
        out.valid = value === undefined || value === null || typeof value === "string" || typeof value === "number";
    }
    return out;
}

/** A preset of the Preset row (host.presetRow) with its values by row and the files of it the row's options lack. */
function presetSummary(ed, targets, row, p) {
    const values = [], missing = [];
    for (const [key, v] of Object.entries(p.values || {})) {
        const t = targets.find((x) => row.keyOf(x) === key);
        if (!t) { values.push({ index: null, label: null, key, value: v }); continue; }   // a row this recipe does not have
        values.push({ index: t.index, label: t.node.title || t.inputName, value: v });
        const k = ed.settingKind(t);
        // host.applyPreset's own test: a combo keeps its choice for a value it does not offer
        if (k.kind === "combo" && !(k.options || []).map(String).includes(String(v))) missing.push(String(v));
    }
    return { name: p.name, shipped: !!p.shipped, current: !!(row.matching && row.matching.name === p.name), values, missing };
}

/** The modes of `transform_layer`: the move tool's Rotate, Distort and Warp, and its quarter turns. */
const TRANSFORM_MODES = ["rotate", "rotate90", "distort", "warp"];

/** [[x, y], ...] (or [{x, y}, ...]) of finite numbers, for transform_layer's corners and points. */
function pointList(v, what) {
    if (!Array.isArray(v) || !v.length) throw new Error(`${what} must be a list of [x, y] points in image pixels`);
    return v.map((q, i) => {
        const x = Array.isArray(q) ? +q[0] : q && typeof q === "object" ? +q.x : NaN;
        const y = Array.isArray(q) ? +q[1] : q && typeof q === "object" ? +q.y : NaN;
        if ((Array.isArray(q) && q.length !== 2) || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${what}[${i}] is no [x, y] point: ${JSON.stringify(q)}`);
        return [x, y];
    });
}

/**
 * The pixel size the editor's applyPending gives a pending transform, measured the way it measures it (its fine
 * subdivisions through pendingDst, at the layer's own resolution), or null when a point is not finite.
 */
function pendingSize(ed, p) {
    const l = p.layer;
    const n = ed.pendingSubdivisions(p, true);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const [X, Y] = ed.pendingDst(p, i / n, j / n);
        if (!Number.isFinite(X) || !Number.isFinite(Y)) return null;
        minX = Math.min(minX, X); minY = Math.min(minY, Y); maxX = Math.max(maxX, X); maxY = Math.max(maxY, Y);
    }
    const res = Math.max(l.px.width / l.w, l.px.height / l.h, 1);
    const bw = Math.max(1, Math.ceil(maxX) - Math.floor(minX)), bh = Math.max(1, Math.ceil(maxY) - Math.floor(minY));
    return { w: Math.round(bw * res), h: Math.round(bh * res) };
}

/**
 * The clipboard Ctrl+Shift+C makes (the visible picture in the selection's box, cut to the selection; the whole picture
 * without one), read as a box (`readBox`: padded as far as the filters read, a region pass on tiles) instead of the
 * editor's whole flatten, which a document past the canvas limits cannot make.
 */
async function mergedClip(ed) {
    if (ed.relightIdle) await ed.relightIdle();   // relight's full shadow maps (docs/PLAN_RELIGHT_FIXES.md F2.7)
    const b = ed.getBounds && ed.getBounds();
    const [x0, y0, x1, y1] = b || [0, 0, ed.width, ed.height];
    const w = x1 - x0, h = y1 - y0;
    const c = makeCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.drawImage(ed.readBox([x0, y0, x1, y1], { forRun: true }), 0, 0);
    if (b) {
        ctx.globalCompositeOperation = "destination-in";
        const m = await ed.selectionCanvasSettled([x0, y0, x1, y1], 1, w, h);
        if (m) ctx.drawImage(m, 0, 0); else ed.sel.drawTo(ctx, -x0, -y0);
        ctx.globalCompositeOperation = "source-over";
    }
    ed.setStatus(`Copied ${w} × ${h} px from the visible image.`);
    return { canvas: c, x: x0, y: y0, source: "the visible image" };
}
const FILE_PARAMS = {
    path: P.str("absolute path of a local image file"),
    filename: P.str("instead of path: a file name in the local store / ComfyUI input folder (with subfolder and type)"),
    subfolder: P.str("subfolder of `filename` (default none)"),
    type: P.str("folder type of `filename`: input, output or temp", { enum: ["input", "output", "temp"], default: "input" }),
};

/** A text's font by name, and the file it names (the editor's font select does the same): a text keeps no file of another font. */
function setFont(t, family) {
    t.font = family;
    const f = fontList().find((x) => x.family === family);
    t.fontRef = f && f.ref ? f.ref : null;
}

/** A select's option ids (an option is `{ id, label, group, ...fields }` or a plain value). */
const optionIds = (p) => (p.options || []).map((o) => (o && typeof o === "object" ? o.id : o));

/**
 * A filter type's parameter values checked against its spec, before anything is written (docs/PLAN_0_1_42.md F2b): a
 * refused call changes nothing, and add_filter adds no layer for it. Returns `{ key: value }` as the layer stores them.
 */
export function checkParams(filterId, params, size = null) {
    if (!FILTERS[filterId]) throw new Error(`filter "${filterId}" is not installed (its plugin is off or missing): its settings are kept as they are`);
    // some models send the object as a JSON string ("{\"color\":\"#ff2d2d\"}"): a string that parses to an object counts
    if (typeof params === "string") {
        let parsed = null;
        try { parsed = JSON.parse(params); } catch (_) { /* refused below */ }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed;
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("params must be an object {key: value} (filter_types lists the keys)");
    const spec = FILTERS[filterId].params || [];
    const out = {};
    for (const [k, v] of Object.entries(params)) {
        if (k === "limit") {
            const lim = normalizeLimit(v);
            out.limit = lim;
            continue;
        }
        const p = spec.find((x) => x.key === k);
        if (!p) throw new Error(`filter "${filterId}" has no parameter "${k}" (${spec.map((x) => x.key).join(", ")})`);
        if (p.type === "select") {
            const ids = optionIds(p);
            if (!ids.includes(v)) throw new Error(`"${v}" is not an option of ${k} (${ids.join(", ")})`);
            out[k] = v;
        }
        else if (p.type === "bool") {
            if (v === true || v === "true") out[k] = true;
            else if (v === false || v === "false") out[k] = false;
            else throw new Error(`${k} takes true or false, not ${JSON.stringify(v)}`);
        }
        else if (p.type === "custom") {
            if (filterId === "relight" && k === "lights") {
                if (!Array.isArray(v)) throw new Error("lights must be an array of light objects");
                out[k] = normalizeLights(v, size);
            } else if (filterId === "relight" && k === "route") {
                // a route Render cannot send would only fail there ("Unknown provider")
                if (!RELIGHT_ROUTES.includes(v)) throw new Error(`Unknown relight route ${JSON.stringify(v)} (must be one of: ${RELIGHT_ROUTES.join(", ")})`);
                out[k] = v;
            } else {
                out[k] = v;
            }
        }
        else if (p.type === "color") {
            const m = /^#?([0-9a-f]{6})$/i.exec(String(v).trim());
            if (!m) throw new Error(`${k} takes a colour as "#rrggbb", not "${v}"`);
            out[k] = "#" + m[1].toLowerCase();
        }
        else {
            if (v === null || v === "" || typeof v === "boolean" || !Number.isFinite(+v)) throw new Error(`${k} takes a number (${p.min}..${p.max}), not ${JSON.stringify(v)}`);
            out[k] = Math.min(Number.isFinite(p.max) ? p.max : Infinity, Math.max(Number.isFinite(p.min) ? p.min : -Infinity, +v));
        }
    }
    return out;
}
export const applyParams = checkParams;

/**
 * Checked values into a filter layer, as its row in the layer list writes them (inpaint_canvas.js buildFilterControls):
 * the select named "preset" first, which copies its option's fields (a grain stock's amount, size, speckle, chroma and
 * look; a black-and-white colour filter's hue and strength), drops a look the option does not carry and names the
 * layer after the option; then the other values. A slider that is no offset on the preset (no `keepPreset`) turns the
 * preset to "custom" when its value moves, as dragging it does. No undo step: the caller pushes one.
 */
function writeParams(ed, l, vals) {
    const spec = FILTERS[l.filter].params || [];
    const presetP = spec.find((p) => p.key === "preset" && p.type === "select");
    if (presetP && "preset" in vals) {
        const o = (presetP.options || []).find((x) => (x && typeof x === "object" ? x.id : x) === vals.preset);
        l.params.preset = vals.preset;
        if (o && typeof o === "object") {
            for (const [k, v] of Object.entries(o)) if (k !== "id" && k !== "label" && k !== "group") l.params[k] = v;
            // a stock's colour look goes with it (the row sets null on every type; only one that held a look has one to drop)
            if (!("look" in o) && l.params.look != null) l.params.look = null;
            l.name = o.id === "custom" ? `${FILTERS[l.filter].label} ${ed.filterCounter}` : String(o.label).replace(/ \(.*\)$/, "");
        }
    }
    const custom = !!presetP && optionIds(presetP).includes("custom");
    for (const [k, v] of Object.entries(vals)) {
        if (presetP && k === "preset") continue;
        if (k === "limit") {
            const lim = normalizeLimit(v);
            const next = { ...l.params };
            if (lim) next.limit = lim;
            else delete next.limit;
            l.params = next;
            continue;
        }
        const p = spec.find((x) => x.key === k);
        const moved = JSON.stringify(l.params[k]) !== JSON.stringify(v);
        l.params[k] = v;
        if (custom && moved && !p.keepPreset && (!p.type || p.type === "number") && l.params.preset !== "custom") l.params.preset = "custom";
    }
    ed.markFilterChanged(l);
}

/** The Undo history's name of a filter change, as the layer row names one control's step. */
function filterStepLabel(filterId, keys) {
    const def = FILTERS[filterId];
    if (keys.length === 1 && keys[0] === "limit") return `${def.label}: Limit`;
    const p = keys.length === 1 ? (def.params || []).find((x) => x.key === keys[0]) : null;
    return p && p.label ? `${def.label}: ${p.label}` : def.label;
}

async function withExportPath(path, fn) {
    const prev = host.exportPath;
    host.exportPath = path ? String(path) : null;
    try { return await fn(); } finally { host.exportPath = prev; }
}

function appInfo() {
    const r = host.recipe;
    return { app: "scumble", commands: VERSION, documents: host.editors().map(docSummary), active: host.editor ? host.editor.node.id : null, recipe: r ? r.id : null, connected: !!host.connected, plugins: host.plugins ? host.plugins.list().filter((p) => p.loaded).map((p) => p.id) : [] };
}

/**
 * The command table as data: [{name, description, scope, params: {name: {type, description, default, required, enum}}}].
 * @returns {CommandDescriptor[]}
 */
export function describe() {
    // the MCP hints: a built-in that sets no flag is false; a plugin command that sets none stays null, and the MCP
    // server judges it by its name (electron/main/mcp/server.js)
    const flag = (v, owner) => (typeof v === "boolean" ? v : owner ? null : false);
    return Object.entries(COMMANDS).map(([name, c]) => ({
        name, description: c.description, scope: c.scope || "doc", needsImage: !!c.needsImage, plugin: c.owner || null,
        readOnly: flag(c.readOnly, c.owner), destructive: flag(c.destructive, c.owner),
        params: { ...(c.scope === "app" ? {} : { doc: P.int("document id (default the active tab)") }), ...c.params },
    }));
}

/** Resolve the editor a command runs on: args.doc (id), or the active tab. */
function editorFor(name, args) {
    const c = COMMANDS[name];
    if (c.scope === "app") return null;
    if (args && args.doc != null && args.doc !== "") {
        const ed = host.editorById(args.doc);
        if (!ed) throw new Error(`no document with id ${args.doc} (open: ${host.editors().map((e) => e.node.id).join(", ") || "none"})`);
        return ed;
    }
    const ed = host.editor;
    if (!ed) throw new Error("no document is open");
    return ed;
}

/**
 * new_canvas's model preset (item 34): recipe, provider, aspect and size checked against what the New dialog offers
 * (host.newCanvasChoices), each refusal naming the values allowed; then the canvas the preset makes (its aspect at the
 * class's long side, at most 2048 px).
 */
function newCanvasPreset(ed, a) {
    if (a.width != null || a.height != null) throw new Error("new_canvas takes width and height, or a model preset (recipe, aspect, size), not both: the preset sets the canvas size");
    if (a.recipe == null || a.recipe === "") throw new Error("provider, aspect and size belong to a model preset: pass recipe with them, or width and height alone");
    const ch = host.newCanvasChoices(ed);
    if (!ch) throw new Error("model presets are not available here");
    const models = ch.models.filter((x) => x.value);
    const m = models.find((x) => x.value === String(a.recipe));
    if (!m) {
        const known = host.shell.recipes().some((x) => x.id === String(a.recipe));
        throw new Error(`${known ? `recipe "${a.recipe}" makes no new image` : `no recipe "${a.recipe}"`} (the models that do: ${models.map((x) => x.value).join(", ") || "none"})`);
    }
    let p = m.providers[0];   // the remembered or default provider: newCanvasChoices lists it first
    if (a.provider != null && a.provider !== "") {
        p = m.providers.find((x) => x.value === String(a.provider));
        const fixed = m.providers.length === 1 && !m.providers[0].value;
        // a Comfy Cloud graph has one entry (value ""), on the provider list_recipes reports for it ("comfycloud"): that
        // id names the entry too; a recipe on ComfyUI has none
        const raw = fixed ? host.shell.recipes().find((x) => x.id === m.value) : null;
        const own = raw && raw.kind === "provider" ? host.shell.resolveRecipe(raw).provider || null : null;
        if (!p && own && own === String(a.provider)) p = m.providers[0];
        if (!p) {
            if (own) throw new Error(`recipe "${m.value}" runs on ${m.providers[0].label}: its provider is "${own}" (or leave provider out)`);
            throw new Error(fixed ? `recipe "${m.value}" runs on ${m.providers[0].label} and takes no provider` : `recipe "${m.value}" has no provider "${a.provider}" that makes a new image (${m.providers.map((x) => x.value).join(", ")})`);
        }
    }
    const on = p.value ? ` on ${p.value}` : "";
    if (a.aspect == null || a.aspect === "") throw new Error(`a model preset needs aspect: ${m.value}${on} offers ${p.aspects.join(", ")}`);
    const pa = genpresets.parseAspect(a.aspect);
    const aspect = pa ? `${pa[0]}:${pa[1]}` : String(a.aspect);
    if (!p.aspects.includes(aspect)) throw new Error(`${m.value}${on} offers no aspect "${a.aspect}" (${p.aspects.join(", ")})`);
    const classes = `${p.classes.map((c) => c.label).join(", ")}; size is the long side in pixels`;
    if (a.size == null || a.size === "") throw new Error(`a model preset needs size: ${m.value}${on} offers ${classes}`);
    const size = Math.round(+a.size);
    if (!p.classes.some((c) => c.value === size)) throw new Error(`${m.value}${on} offers no size class ${JSON.stringify(a.size)} (${classes})`);
    const [width, height] = ch.working(aspect, size);
    return { recipe: m.value, provider: p.value || null, aspect, size, width, height };
}

/** "16:9", "16x9" or "16/9" -> [16, 9]; anything else is refused. */
function aspectParts(aspect) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*[:x\/]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(aspect || ""));
    const aw = m ? +m[1] : 0, ah = m ? +m[2] : 0;
    if (!(aw > 0) || !(ah > 0)) throw new Error(`aspect "${aspect}" is not W:H, e.g. 16:9`);
    return [aw, ah];
}

/** An aspect as "W:H" (genpresets.parseAspect's form), from any spelling aspectParts takes ("16x9" -> "16:9"). */
function aspectText(aspect) {
    const [aw, ah] = aspectParts(aspect);
    return `${aw}:${ah}`;
}

/** "16:9" plus a long side -> [width, height], both a multiple of 16. */
function sizeForAspect(aspect, longSide) {
    const [aw, ah] = aspectParts(aspect);
    const round16 = (v) => Math.max(64, Math.round(v / 16) * 16);
    return aw >= ah ? [round16(longSide), round16(longSide * ah / aw)] : [round16(longSide * aw / ah), round16(longSide)];
}

export { CROP_FILLS, CROP_KEYS, EXTEND_FILLS, FILE_PARAMS, MASK_OPS, P, RELIGHT_FROM_LIGHTS, RELIGHT_MODEL, SEL_MODES, SHOT_WHAT, TEXT_LINE_HEIGHT_TEXT, TEXT_SPACING_TEXT, TRANSFORM_MODES, VERSION, agentRefs, appInfo, aspectText, clampInt, cropValue, cropView, docName, documentMax, editorFor, fileFrom, filterStepLabel, generateEachArea, loadNotes, lorasFromCall, lorasView, memoryMB, mergedClip, newCanvasPreset, pendingSize, pointList, presetSummary, recipeReadiness, rectMask, refsReport, refuseLayer, relightModel, requireImage, selMode, serverUp, setFont, settingRow, sizeForAspect, targetSize, textSpacing, until, wait, withExportPath, writeParams, writeRelightModel, writeTarget, bindUtil };

function bindUtil(C) { COMMANDS = C; }
