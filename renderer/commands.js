// @ts-check
// The command core: every operation the editor offers as a plain, documented function
// (name, args) -> JSON. Ported from the node's MCP bridge (ComfyUI-InpaintCanvas
// js/inpaint_bridge.js, COMMANDS + TAB_COMMANDS); the node addressed graph nodes, the app
// addresses documents (tabs). Plugins call it through the `scumble.commands` API, the MCP
// server (phase 4c) maps every entry to a tool, tests run it from the console:
//
//     const { commands } = await import("./commands.js");
//     await commands.run("status");
//     await commands.run("select_rect", { x: 10, y: 10, w: 200, h: 100, doc: 3 });
//
// Every command has `params` (a schema: type, description, default, required, enum) and a
// `description`, so `commands.describe()` is enough to build a tool list or a help page.
// Document commands take `doc` (the editor id shown in list_documents); without it the
// active tab is used. App commands (`scope: "app"`) take no document.

import { api, host } from "./editor/host.js";
import { viewUrl, loadImageEl, makeCanvas, BRUSH_MAX, BLEND_MODES } from "./editor/inpaint_canvas.js";
import { FILTERS } from "./editor/inpaint_filters.js";
import { normalizeLimit } from "./editor/inpaint_weights.js";
import { fontList } from "./editor/inpaint_text.js";
import { parse, remap } from "./editor/reftokens.js";
import { LABEL as REALISM_LABEL } from "./editor/realism.js";

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
    if (l.kind === "filter") { out.filter = l.filter; out.params = { ...(l.params || {}) }; if (l.lut) out.lut = l.lut.name || true; }
    if (l.kind === "text" && l.text) {
        out.text = { content: l.text.content, font: l.text.font, size: l.text.size, color: l.text.color, bold: !!l.text.bold, italic: !!l.text.italic, align: l.text.align };
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
    return new File([b], a.name || fallbackName || ref.filename, { type: b.type || "image/png" });
}

export function status(ed) {
    const results = ed.layers.filter((l) => l.kind === "result");
    const r = host.recipe;
    return {
        doc: ed.node.id, name: docName(ed), loaded: !!ed.base, width: ed.width || 0, height: ed.height || 0,
        base: ed.base ? ed.base.ref : null, prompt: ed.promptText || "", negative: ed.negativeText || "",
        generation: { mode: ed.genSettings.mode, seed: ed.genSettings.seed, seed_random: !!ed.genSettings.seedRandom, denoise: ed.genSettings.denoise, boxes: !!ed.genSettings.boxes },
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
    };
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
    return { ready: !missing.length, reason: missing.length ? `The server lacks these node types: ${missing.join(", ")}.` : null, note: null };
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
 * @type {{ layer: ParamFn, timeout: (seconds: number) => CommandParam, num: ParamFn, int: ParamFn, str: ParamFn, bool: ParamFn, obj: ParamFn, enum: (description: string, values: string[], def?: string) => CommandParam, selMode: () => CommandParam }}
 */
const P = {
    layer: (d, extra = {}) => ({ type: "string", description: d || "the layer: id, name, a unique part of the name, or \"active\"", default: "active", ...extra }),
    timeout: (d) => ({ type: "integer", description: `seconds to wait for the result (default ${d})`, default: d }),
    num: (description, extra = {}) => ({ type: "number", description, ...extra }),
    int: (description, extra = {}) => ({ type: "integer", description, ...extra }),
    str: (description, extra = {}) => ({ type: "string", description, ...extra }),
    bool: (description, extra = {}) => ({ type: "boolean", description, ...extra }),
    obj: (description, extra = {}) => ({ type: "object", description, ...extra }),
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

// ---- the shape of a command ------------------------------------------------------------------
//
// Three consumers read this table and have to agree with it: the MCP server
// (electron/main/mcp/server.js turns every descriptor into a tool with a JSON schema), the
// assistant's policy (electron/main/assistant/policy.js decides per command name and
// parameter), and docs/COMMANDS.md. The typedefs below are that agreement written down;
// types/contracts.js is where it is checked.

/**
 * One parameter, in the subset of JSON Schema the MCP server emits.
 *
 * @typedef {Object} CommandParam
 * @property {"string" | "number" | "integer" | "boolean" | "object" | "array"} type
 * @property {string} [description]
 * @property {any} [default]
 * @property {boolean} [required]
 * @property {any[]} [enum]
 * @property {any} [items]
 * @property {number} [minimum]
 * @property {number} [maximum]
 */

/**
 * One command. `scope: "app"` means it takes no document; every other command gets the
 * editor of `args.doc`, or the active tab, as its first argument.
 *
 * @typedef {Object} Command
 * @property {string} description
 * @property {Record<string, CommandParam>} params
 * @property {"app" | "doc"} [scope]
 * @property {boolean} [needsImage]     refuse when the document has no picture
 * @property {boolean} [readOnly]       changes nothing (the MCP hint readOnlyHint); unset: false for a built-in
 * @property {boolean} [destructive]    may lose something: a document, a layer, layers merged, a crop, a file written
 *                                      over, the recipe's settings (the MCP hint destructiveHint); unset: false for a built-in
 * @property {string} [owner]           the plugin that registered it, unset for the built-ins
 * @property {(ed: any, args: any) => any} run
 */

/**
 * The table as data: what a tool list, a help page or a policy table is built from.
 *
 * @typedef {Object} CommandDescriptor
 * @property {string} name
 * @property {string} description
 * @property {"app" | "doc"} scope
 * @property {boolean} needsImage
 * @property {string | null} plugin
 * @property {boolean | null} readOnly     null: a plugin command that declares none (the MCP server judges it by its name)
 * @property {boolean | null} destructive  null: as readOnly
 * @property {Record<string, CommandParam>} params
 */

/**
 * What the shell publishes as `commands` (and the bridge, the plugins and the MCP server
 * call). `call` never throws; `run` throws with a readable message.
 *
 * @typedef {Object} CommandCore
 * @property {number} version
 * @property {() => string[]} names
 * @property {(name: string) => boolean} has
 * @property {() => CommandDescriptor[]} describe
 * @property {(name: string, args?: any) => Promise<any>} run
 * @property {(name: string, args?: any) => Promise<{ ok: boolean, result?: any, error?: string }>} call
 * @property {(name: string, def: Command, owner?: string) => void} register
 * @property {(name: string, owner?: string) => void} unregister
 */

// ---- the commands ----------------------------------------------------------------------------
//
// { description, params, scope?: "app" | "doc" (default doc), needsImage?, readOnly?, destructive?, run(ed, args) }

/** @satisfies {Record<string, Command>} */
const COMMANDS = {
    // -- app --
    ping: {
        readOnly: true,
        scope: "app", description: "Whether the app answers: version, the open documents, the recipe, the connection.",
        params: {},
        async run() { return appInfo(); },
    },
    list_commands: {
        readOnly: true,
        scope: "app", description: "Every command with its parameters (this table).",
        params: {},
        async run() { return { version: VERSION, commands: describe() }; },
    },
    list_documents: {
        readOnly: true,
        scope: "app", description: "The open tabs: id, name, size, layer count, which one is active.",
        params: {},
        async run() { return { active: host.editor ? host.editor.node.id : null, documents: host.editors().map(docSummary) }; },
    },
    new_document: {
        scope: "app", description: "Open a new empty tab and make it active. Returns its id (use it as `doc`).",
        params: { activate: P.bool("make it the active tab (default true)", { default: true }) },
        async run(_, a) { const ed = host.shell.newDocument(); if (a.activate !== false) host.shell.activate(ed); return docSummary(ed); },
    },
    activate_document: {
        description: "Bring a tab to the front.",
        params: { doc: P.int("the document id (from list_documents)", { required: true }) },
        async run(ed) { host.shell.activate(ed); return docSummary(ed); },
    },
    save_document: {
        destructive: true,
        needsImage: true,
        description: "Save the document as a .scumble file that reopens fully editable (layers, masks, filters, text, 3D objects, selection, prompts, result history). Without `path` it saves to the tab's file (an error when it has none); with `path` it is Save As, and the tab follows the new file unless `copy` is true. Nothing is asked: a file changed on disk is overwritten.",
        params: {
            path: P.str("absolute path ending in .scumble (Save As); omit to save to the tab's file"),
            copy: P.bool("write the file without making it the tab's file (a snapshot)", { default: false }),
            history: P.bool("include the result history and the prompts of earlier runs (default true)", { default: true }),
        },
        async run(ed, a) {
            const path = a.path != null && String(a.path).trim() ? String(a.path).trim() : null;
            if (path && !/\.scumble$/i.test(path)) throw new Error("the path must end in .scumble");
            if (!path && !(ed.docFile && ed.docFile.path)) throw new Error("this tab has no .scumble file yet: pass path");
            if (!path && a.copy) throw new Error("a copy needs a path");
            const r = await host.saveDocument(ed, { path, copy: !!a.copy, history: a.history !== false, ask: false });
            if (!r) throw new Error("the save was cancelled");
            return { path: r.path, bytes: r.bytes, entries: r.entries, ms: r.ms, notes: r.notes || [], document: docSummary(ed) };
        },
    },
    open_document: {
        scope: "app",
        description: "Open a .scumble file as a tab (the tab that already holds it is activated instead). Returns the document and notes (a newer format, a renamed file, another recipe).",
        params: { path: P.str("absolute path of a .scumble file", { required: true }), activate: P.bool("make it the active tab (default true)", { default: true }) },
        async run(_, a) {
            const path = String(a.path || "").trim();
            if (!/\.scumble$/i.test(path)) throw new Error("the path must end in .scumble");
            const before = host.editor;
            const r = await host.openDocument(path);
            if (a.activate === false && before && before !== r.editor && host.editors().includes(before)) host.shell.activate(before);
            return { ...docSummary(r.editor), already: !!r.already, notes: r.notes || [] };
        },
    },
    close_document: {
        destructive: true,
        description: "Close a tab without asking (unsaved changes are not written to its .scumble file). File › Reopen Closed Tab brings it back in this session; the document's files stay in the local store.",
        params: {},
        async run(ed) { const id = ed.node.id; host.shell.closeDocument(ed, { force: true }); return { closed: id, documents: host.editors().map(docSummary) }; },
    },
    list_recipes: {
        readOnly: true,
        scope: "app", description: `The recipes (ComfyUI workflows and API providers) and which one is selected. ready: whether the recipe can run now (an API recipe: a key stored for its chosen provider, or the in-app model downloaded; a recipe on the user's ComfyUI: connected and every node type it needs on the server; the ${REALISM_LABEL} recipe, task "pass": whether the connected ComfyUI can run it, with a note for RTX 30), reason when not. keys: per provider of the recipe whether it has a key (true / false). new_image: whether generate_new can make a picture with it (an API recipe: its chosen provider has a text-to-image route); edit: whether generate takes it (false: the model makes pictures from the prompt alone); sizes: the long sides its text route offers (null: any size); background: whether generate_new's background transparent goes to it. An upscaler: factor, limits (an upscaler on the user's ComfyUI), document_max (the longest side upscale's scope document takes; null: no cap). textRefs: whether generate_new sends the shown reference layers along (an API recipe: with the chosen provider's text route; a local recipe: whether its graph reads pictures after the white canvas, which is image 1). false: the prompt alone. provider_keys: every API provider and whether a key is stored for it (never the key). status has the pass's readiness for a document (its runs, its size).`,
        params: {},
        async run() {
            const cur = host.recipe;
            return {
                selected: cur ? cur.id : null, provider: cur && cur.kind === "provider" ? cur.provider : null,
                recipes: host.shell.recipes().map((r) => {
                    const v = host.shell.resolveRecipe(r);
                    const pass = r.task === "pass", up = r.task === "upscale", api = r.kind === "provider";
                    // what the Generate new dialog offers for it: the chosen variant's text route (a local recipe takes any size)
                    const text = api ? v.text || null : null;
                    const makes = !up && !pass && (!api || !!text);
                    const rows = text ? text.settings || v.settings || [] : [];
                    return {
                        id: r.id, name: r.name || r.id, kind: r.kind || "comfy", family: r.family || null, mode: host.shell.modeOf(r), provider: v.provider || null, providers: r.providerIds || [], model: v.model || null, task: r.task || "edit",
                        ...recipeReadiness(r, v),
                        keys: api ? Object.fromEntries((r.providerIds || []).map((pid) => { const ks = host.shell.keyState(host.shell.resolveRecipe(r, pid)); return [pid, !ks || !!ks.ok]; })) : undefined,
                        new_image: makes, edit: up || pass ? undefined : !api || v.edit !== false,
                        sizes: makes ? (text && Array.isArray(text.sizes) && text.sizes.length ? text.sizes.slice().sort((x, y) => x - y) : null) : undefined,
                        background: makes ? rows.some((s) => s.key === "background") : undefined,
                        factor: up ? v.factor || null : undefined, limits: up && !api ? r.limits || null : undefined, document_max: up ? documentMax(r, v) : undefined,
                        usesPrompt: up ? !!v.usesPrompt : undefined,
                        textRefs: up || pass ? undefined : api ? !!(v.text && v.text.refs) : ((s) => s == null || s > 1)(host.comfyPlan(null, r, 0, { hasSelection: true }).spec.slots),
                        description: r.description || "", source: r.source || "builtin",
                    };
                }),
                provider_keys: host.shell.providerKeys ? host.shell.providerKeys() : [],
            };
        },
    },
    select_recipe: {
        destructive: true,
        scope: "app", description: "Select the recipe every tab generates with; model recipes take the provider to run on (toapis, gemini, openai, bfl, fal, replicate, wavespeed, comfycloud, openrouter, ark, oxen, magnific; list_recipes has each recipe's own), else the remembered or default one.",
        params: { id: P.str("recipe id (from list_recipes)", { required: true }), provider: P.str("provider id for a model recipe (one of its providers from list_recipes)") },
        async run(_, a) {
            const r = host.shell.recipes().find((x) => x.id === a.id);
            if (!r) throw new Error(`no recipe "${a.id}" (${host.shell.recipes().map((x) => x.id).join(", ")})`);
            if (a.provider && !(r.providerIds || []).includes(a.provider)) throw new Error(`recipe "${a.id}" has no provider "${a.provider}" (${(r.providerIds || []).join(", ") || "none"})`);
            host.shell.selectRecipe(r.id, a.provider || undefined);
            return { selected: host.recipe ? host.recipe.id : null, kind: r.kind || "comfy", provider: host.recipe && host.recipe.kind === "provider" ? host.recipe.provider : null };
        },
    },
    list_plugins: {
        readOnly: true,
        scope: "app", description: "The plugins (built-in and from the user's plugin folder), their state and what they registered.",
        params: {},
        async run() { return { plugins: host.plugins ? host.plugins.list() : [] }; },
    },
    run_action: {
        description: "Run a plugin action (a Plugins menu entry) on the document.",
        params: { id: P.str("action id (from list_plugins)", { required: true }) },
        async run(ed, a) { if (!host.plugins) throw new Error("no plugins loaded"); return { result: await host.plugins.runAction(a.id, ed) }; },
    },

    // -- document --
    status: {
        readOnly: true,
        description: `What the document holds: image size, prompt, generation settings, selection bounds, every layer, the reference layers (label = what @img1, @img2 in the prompt name; sent_as = the name the selected recipe's route sends that picture as), pending jobs, the recipe, and what the app is using in memory. realism: whether realism_pass (${REALISM_LABEL}) at factor 1 would start on this document now (ready; reason when not: the server, a run going on it, a local render on the user's ComfyUI included, still loading, no picture, past 7680 × 4320 or 27.9 megapixels; status answers for factor 1, and above it a picture already past that size is refused too: only a picture whose output would pass it is scaled down), note (RTX 30), and the app's style, strength and preset it sends.`,
        params: {},
        async run(ed) {
            const s = status(ed);
            let info = null;
            try { info = await host.refLayout(ed, {}, { keep: false }); } catch (_) { info = null; }
            s.references = s.references.map((x) => ({ ...x, sent_as: info && x.label ? info.names.get(x.id) || null : null }));
            return { ...s, memory: await memoryMB() };
        },
    },
    new_canvas: {
        destructive: true,
        description: "Start a new white canvas of the given size in this tab (discards its image and layers).",
        params: { width: P.int("width in pixels (16..16384)", { default: 1024 }), height: P.int("height in pixels", { default: 1024 }) },
        async run(ed, a) {
            const w = clampInt(a.width, 16, 16384, 1024), h = clampInt(a.height, 16, 16384, 1024);
            await ed.newCanvas(`${w}x${h}`);
            if (ed.width !== w || ed.height !== h) throw new Error(ed.status);
            return { width: ed.width, height: ed.height };
        },
    },
    load_image: {
        destructive: true,
        description: "Load an image as the base image of this tab (replaces its image, layers and history). From a local path, or by file name from the local store. An SVG is rasterised on the way in: at width x height when given (one of them keeps the aspect), else at its own declared size, else 2048 px on the long side.",
        params: { ...FILE_PARAMS, width: P.int("SVG only: the pixel width to rasterise at"), height: P.int("SVG only: the pixel height to rasterise at") },
        async run(ed, a) {
            if (ed.pending) ed.cancelPending();
            if (ed.textEdit) ed.endTextEdit(false);
            if (a.path) {
                const size = (+a.width > 0 || +a.height > 0) ? [+a.width > 0 ? Math.round(+a.width) : 0, +a.height > 0 ? Math.round(+a.height) : 0] : null;
                const prev = ed.base;   // loadFile says a failure in the status line; a tab with an image kept its old one
                await ed.loadFile(await fileFrom(a), { size, ask: false });
                if (!ed.base || ed.base === prev) throw new Error(ed.status || "the image could not be loaded");
            } else {
                if (!a.filename) throw new Error("pass path or filename");
                const ref = { filename: a.filename, subfolder: a.subfolder || "", type: a.type || "input" };
                await ed.setBaseFromRef(ref);
            }
            ed.history = []; ed.renderHistory && ed.renderHistory();
            return { width: ed.width, height: ed.height, base: ed.base.ref };
        },
    },
    add_image_layer: {
        description: "Add an image file as a new layer. role \"none\": part of the picture (fitted to the canvas, or placed at x,y with width/height); role \"reference\": a reference image for multi-reference models, not part of the picture (in an empty tab it gets a white 1024 x 1024 canvas, which generate_new replaces while the reference stays). An SVG is rasterised to fit the document first, so it stays sharp.",
        params: { ...FILE_PARAMS, role: P.str("none or reference", { enum: ["none", "reference"], default: "none" }), name: P.str("layer name (default the file name)"), x: P.int("left edge in image pixels"), y: P.int("top edge"), width: P.int("width; without height the aspect is kept"), height: P.int("height") },
        async run(ed, a) {
            const role = a.role === "reference" ? "reference" : "none";
            // a reference may start an empty tab (a white canvas under it, 26f); a picture layer needs a picture
            if (role !== "reference") requireImage(ed);
            const before = new Set(ed.layers.map((l) => l.id));
            const at = Number.isFinite(+a.x) && Number.isFinite(+a.y) ? [+a.x, +a.y] : null;
            await ed.addImageLayers([await fileFrom(a)], role, at ? { place: "at", at, blank: true } : { place: role === "reference" ? "cascade" : "fit", blank: true });
            const layer = ed.layers.find((l) => !before.has(l.id));
            if (!layer) throw new Error(ed.status || "the layer was not added");
            if (a.name) layer.name = String(a.name);
            if (at) { layer.x = Math.round(at[0]); layer.y = Math.round(at[1]); }
            if (Number.isFinite(+a.width) && Number.isFinite(+a.height) && +a.width > 0 && +a.height > 0) { layer.w = Math.round(+a.width); layer.h = Math.round(+a.height); }
            else if (Number.isFinite(+a.width) && +a.width > 0) { const k = +a.width / layer.w; layer.w = Math.round(+a.width); layer.h = Math.max(1, Math.round(layer.h * k)); }
            touch(ed);
            return layerSummary(ed, layer);
        },
    },

    // -- selection --
    select_rect: {
        needsImage: true, description: "Select a rectangle in image pixels.",
        params: { x: P.int("left", { required: true }), y: P.int("top", { required: true }), w: P.int("width (alias width)", { required: true }), h: P.int("height (alias height)", { required: true }), mode: P.selMode() },
        async run(ed, a) {
            const mode = selMode(a.mode);
            const x = +a.x || 0, y = +a.y || 0, w = +a.w || +a.width || 0, h = +a.h || +a.height || 0;
            if (!ed.selectRectangle([x, y, x + w, y + h], mode)) throw new Error(`empty rectangle ${x},${y} ${w}×${h} on a ${ed.width}×${ed.height} image`);
            return { selection: bounds(ed) };
        },
    },
    select_all: { needsImage: true, description: "Select the whole image.", params: {}, async run(ed) { ed.selectRectangle([0, 0, ed.width, ed.height], "replace"); return { selection: bounds(ed) }; } },
    select_none: { needsImage: true, description: "Clear the selection.", params: {}, async run(ed) { ed.clearSelection(); return { selection: bounds(ed) }; } },
    select_invert: { needsImage: true, description: "Invert the selection.", params: {}, async run(ed) { await ed.invertSelection(); return { selection: bounds(ed) }; } },
    select_feather: { needsImage: true, description: "Soften the selection edge by a gaussian blur.", params: { radius: P.num("radius in pixels", { default: 8 }) }, async run(ed, a) { await ed.featherSelection(+a.radius || 8); return { selection: bounds(ed), status: ed.status }; } },
    select_grow: { needsImage: true, description: "Grow (positive) or shrink (negative) the selection.", params: { px: P.int("pixels (alias pixels)", { required: true }) }, async run(ed, a) { const n = Math.round(+(a.px != null ? a.px : a.pixels) || 0); if (n) await ed.growSelection(n); return { selection: bounds(ed) }; } },
    select_from_layer: {
        needsImage: true, description: "Selection from a layer's opaque pixels (its alpha).",
        params: { layer: P.layer() },
        async run(ed, a) { const l = findLayer(ed, a.layer); ed.activeLayerId = l.id; ed.selectionFromLayer(); touch(ed); return { selection: bounds(ed), layer: l.id }; },
    },
    select_mask: {
        needsImage: true, description: "Selection from a mask: an array of width × height values (image size, >0 = selected), or a base64 PNG (white = selected).",
        params: { mask: P.obj("array of width*height values, or a base64 PNG string", { required: true }), mode: P.selMode() },
        async run(ed, a) {
            const mode = selMode(a.mode);
            const W = ed.width, H = ed.height;
            let m;
            if (typeof a.mask === "string") {
                const img = await loadImageEl("data:image/png;base64," + a.mask.replace(/^data:[^,]*,/, ""));
                const c = makeCanvas(W, H);
                const ctx = c.getContext("2d");
                ctx.drawImage(img, 0, 0, W, H);
                const d = ctx.getImageData(0, 0, W, H).data;
                m = new Uint8Array(W * H);
                for (let i = 0, j = 0; i < m.length; i++, j += 4) m[i] = d[j] > 127 && d[j + 3] > 127 ? 1 : 0;
            } else {
                const src = a.mask && a.mask.length != null ? a.mask : null;
                if (!src || src.length !== W * H) throw new Error(`mask must hold ${W * H} values (${W} × ${H})`);
                m = new Uint8Array(W * H);
                for (let i = 0; i < m.length; i++) m[i] = src[i] > 0 ? 1 : 0;
            }
            ed.applyMaskToSelection(m, mode);
            return { selection: bounds(ed) };
        },
    },
    select_by_text: {
        needsImage: true, description: "Select an object by describing it (\"the car\", \"sky\"). Runs the segmentation model on the connected ComfyUI (SAM3); waits for the mask.",
        params: { text: P.str("what to select", { required: true }), mode: P.selMode(), threshold: P.num("0.05..0.95, the model's default when omitted"), timeout: P.timeout(300) },
        async run(ed, a) {
            if (!ed.segInput) throw new Error("the editor has no segmentation controls");
            if (ed.segmentPending) throw new Error("a segmentation is still running");
            const text = String(a.text || "").trim();
            if (!text) throw new Error("text missing, e.g. \"the car\"");
            ed.segInput.value = text;
            ed.segMode = SEL_MODES.includes(a.mode) ? a.mode : "replace";
            if (a.threshold != null && ed.segThreshold) ed.segThreshold.value = Math.min(0.95, Math.max(0.05, +a.threshold || 0.3));
            const before = ed.status;
            await ed.segmentByText();
            if (!ed.segmentPending) throw new Error(ed.status !== before ? ed.status : "segmentation did not start");
            const ok = await until(() => !ed.segmentPending, clampInt(a.timeout, 5, 3600, 300) * 1000);
            if (!ok) throw new Error("segmentation timed out: " + ed.status);
            await until(() => !/^(Segmenting|Asking)/.test(ed.status || ""), 30000);
            if (/failed|could not/i.test(ed.status)) throw new Error(ed.status);
            return { selection: bounds(ed), status: ed.status };
        },
    },
    select_point: {
        needsImage: true, description: "Select what SAM2 (in-app) sees at a point; needs a downloaded SAM2 model (Settings › Helpers). Points: label 1 = inside, 0 = outside.",
        params: { x: P.num("x of the point"), y: P.num("y of the point"), points: P.obj("instead of x/y: [{x, y, label}] with several points"), box: P.obj("optional [x0, y0, x1, y1] box prompt"), mode: P.selMode() },
        async run(ed, a) {
            const mode = selMode(a.mode);
            if (!host.objectsInApp()) throw new Error("no SAM2 model is downloaded (Settings › Helpers)");
            // a run that resizes the document holds it: the mask would land in the old geometry
            if (ed.resizingRun && ed.resizingRun()) throw new Error("A run is still going on this document: wait for it, or Cancel.");
            const pts = Array.isArray(a.points) && a.points.length ? a.points.map((p) => ({ x: +p.x, y: +p.y, label: p.label == null ? 1 : +p.label })) : (a.x != null && a.y != null ? [{ x: +a.x, y: +a.y, label: 1 }] : []);
            const box = Array.isArray(a.box) && a.box.length === 4 ? a.box.map(Number) : null;
            if (!pts.length && !box) throw new Error("pass x and y, or points");
            if (pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error("pass x and y, or points");
            const res = await host.segmentLogits(ed, pts, box, null);
            await ed.selectLogits(res, { mode, label: "Object selection", box });
            return { selection: bounds(ed), score: res.score };
        },
    },
    // docs/PLAN_0_1_42.md F2b: the magic wand and the ellipse / polygon / lasso tools without a pointer
    select_color: {
        needsImage: true,
        description: "Magic wand: select the area of similar colour at x, y, as the Magic wand tool (W) does. tolerance: how far each channel may differ (0..255); contiguous: only the area connected to x, y (false: every similar pixel of the picture); sample: image (the visible picture) or layer (one layer's own pixels; that layer becomes the active one). Runs in the app, no model or server needed: flat backgrounds, skies, studio walls. One undo step.",
        params: {
            x: P.num("x in image pixels", { required: true }), y: P.num("y in image pixels", { required: true }),
            tolerance: P.int("0..255 per channel", { default: 32 }),
            contiguous: P.bool("only the area connected to x, y", { default: true }),
            sample: P.str("image or layer", { enum: ["image", "layer"], default: "image" }),
            layer: P.layer("with sample layer: the layer whose pixels are read"),
            mode: P.selMode(),
        },
        async run(ed, a) {
            const x = +a.x, y = +a.y;
            if (a.x == null || a.y == null || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("pass x and y in image pixels");
            if (x < 0 || y < 0 || x >= ed.width || y >= ed.height) throw new Error(`${x}, ${y} is outside the ${ed.width} × ${ed.height} picture`);
            const mode = selMode(a.mode);
            const tol = a.tolerance == null || a.tolerance === "" ? 32 : +a.tolerance;
            if (!Number.isFinite(tol) || tol < 0 || tol > 255) throw new Error(`tolerance must be 0..255, not ${JSON.stringify(a.tolerance)}`);
            const contiguous = a.contiguous == null ? true : a.contiguous === true || a.contiguous === "true" ? true : a.contiguous === false || a.contiguous === "false" ? false : null;
            if (contiguous == null) throw new Error(`contiguous takes true or false, not ${JSON.stringify(a.contiguous)}`);
            const sample = a.sample == null || a.sample === "" ? "image" : String(a.sample);
            if (sample !== "image" && sample !== "layer") throw new Error(`sample must be image or layer, not ${JSON.stringify(a.sample)}`);
            let layer = null;
            if (sample === "layer") {
                layer = findLayer(ed, a.layer);
                if (layer.kind === "filter") throw new Error(`${layer.name} is a filter layer: it has no pixels of its own (sample image reads what it does to the picture)`);
            } else if (a.layer != null && a.layer !== "" && a.layer !== "active") throw new Error("layer goes with sample layer; sample image reads the visible picture");
            // the wand reads the active layer for sample layer while it floods, so that layer stays active (select_from_layer
            // does the same); the options are the tool's own for the call only: wandSelect takes them before its first await
            if (layer && ed.activeLayerId !== layer.id) { ed.activeLayerId = layer.id; ed.renderLayers(); }
            const keep = ed.fillOpts;
            let job;
            try { ed.fillOpts = { ...(keep || {}), tolerance: Math.round(tol), contiguous, sample }; job = ed.wandSelect(x, y, mode); } finally { ed.fillOpts = keep; }
            await job;
            return { selection: bounds(ed), status: ed.status, layer: layer ? layer.id : undefined };
        },
    },
    select_shape: {
        needsImage: true,
        description: "Select an ellipse (x, y, w, h: its bounding box) or a polygon / lasso (points: three or more [x, y] in image pixels, closed from the last back to the first), as the Ellipse, Polygon and Lasso tools do, with replace, add or subtract. feather softens the new shape's edge by a gaussian blur of that radius (the rest of the selection keeps its own edge). Saves sending a whole mask through select_mask. One undo step.",
        params: {
            shape: P.str("ellipse, or polygon / lasso (the same: a closed outline through the points)", { required: true, enum: ["ellipse", "polygon", "lasso"] }),
            x: P.num("ellipse: left of its box"), y: P.num("ellipse: top of its box"), w: P.num("ellipse: width (alias width)"), h: P.num("ellipse: height (alias height)"),
            points: P.obj("polygon / lasso: [[x, y], ...], at least three"),
            feather: P.num("radius of the soft edge in pixels, 0..512", { default: 0 }),
            mode: P.selMode(),
        },
        async run(ed, a) {
            const shape = String(a.shape || "");
            const mode = selMode(a.mode);
            const feather = a.feather == null || a.feather === "" ? 0 : +a.feather;
            if (!Number.isFinite(feather) || feather < 0 || feather > 512) throw new Error(`feather must be 0..512 pixels, not ${JSON.stringify(a.feather)}`);
            const W = ed.width, H = ed.height;
            let path, box, label;
            if (shape === "ellipse") {
                const x = +a.x, y = +a.y, w = +(a.w != null ? a.w : a.width), h = +(a.h != null ? a.h : a.height);
                if (a.x == null || a.y == null || ![x, y, w, h].every(Number.isFinite) || !(w > 0) || !(h > 0)) throw new Error("an ellipse needs x, y, w and h (its bounding box; w and h above 0)");
                box = [x, y, x + w, y + h]; label = "Ellipse selection";
                path = (ctx) => { ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); };
            } else if (shape === "polygon" || shape === "lasso") {
                const pts = pointList(a.points, "points");
                if (pts.length < 3) throw new Error(`a ${shape} needs at least three points`);
                if (pts.length > 100000) throw new Error(`a ${shape} takes at most 100,000 points`);
                box = [Infinity, Infinity, -Infinity, -Infinity];
                for (const [px, py] of pts) { box[0] = Math.min(box[0], px); box[1] = Math.min(box[1], py); box[2] = Math.max(box[2], px); box[3] = Math.max(box[3], py); }
                label = shape === "lasso" ? "Lasso selection" : "Polygon selection";
                path = (ctx) => { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); };
            } else throw new Error(`shape must be ellipse, polygon or lasso, not ${JSON.stringify(a.shape)}`);
            // drawn into a canvas of the shape's box on the picture (with room for the blur), never one of the picture's size
            const reach = feather > 0 ? Math.ceil(feather * 3) + 2 : 0;
            const X0 = Math.max(0, Math.floor(box[0] - reach)), Y0 = Math.max(0, Math.floor(box[1] - reach));
            const X1 = Math.min(W, Math.ceil(box[2] + reach)), Y1 = Math.min(H, Math.ceil(box[3] + reach));
            if (X1 <= X0 || Y1 <= Y0) throw new Error(`the ${shape} lies outside the ${W} × ${H} picture`);
            const c = makeCanvas(X1 - X0, Y1 - Y0);
            const ctx = c.getContext("2d");
            if (feather > 0) ctx.filter = `blur(${feather}px)`;
            ctx.translate(-X0, -Y0);
            ctx.fillStyle = "#ff0000";
            path(ctx);
            ctx.fill();
            // the ellipse's own box is its extent (as the tool's drag gives it); a polygon's and a soft edge's are scanned
            ed.applyShapeToSelection(c, mode, shape === "ellipse" && !feather ? box : null, [X0, Y0], label);
            const sel = bounds(ed);
            ed.setStatus(`${label.replace(/ selection$/, "")} ${mode === "replace" ? "selected" : mode === "add" ? "added" : "subtracted"}${feather ? `, its edge feathered by ${feather} px` : ""}.`);
            return { selection: sel };
        },
    },
    select_range: {
        needsImage: true,
        description: "Select by depth (0 near .. 1 far; needs depth_map), luminosity (0 black .. 1 white) or colour similarity (1 = the colour): between lo and hi, softened over fLo below and fHi above.",
        params: {
            source: P.enum("depth, luma or color", ["depth", "luma", "color"], "depth"),
            lo: P.num("0..1", { required: true }),
            hi: P.num("0..1", { required: true }),
            fLo: P.num("feather below lo, 0..1", { default: 0 }),
            fHi: P.num("feather above hi, 0..1", { default: 0 }),
            invert: P.bool("select outside the range", { default: false }),
            color: P.str("#rrggbb, for source color"),
            tol: P.num("0..100, colour tolerance", { default: 30 }),
            mode: P.selMode(),
        },
        async run(ed, a) {
            const mode = selMode(a.mode);
            const source = a.source == null ? "depth" : String(a.source);
            if (!["depth", "luma", "color"].includes(source)) {
                throw new Error(`source must be one of depth, luma, color (got ${JSON.stringify(a.source)})`);
            }
            const limit = normalizeLimit({
                source,
                lo: a.lo,
                hi: a.hi,
                fLo: a.fLo,
                fHi: a.fHi,
                invert: a.invert,
                color: a.color,
                tol: a.tol,
            });
            const res = await ed.selectRange(limit, mode);
            return { selection: bounds(ed), seconds: res ? res.seconds : 0, status: ed.status };
        },
    },

    // -- prompt and generation --
    set_prompt: {
        description: "Set the prompt (and the negative prompt, used by local chains). @img1, @img2 ... name the shown reference layers, top of the reference list first (list_layers / status give each its label); an API run sends each as the name its model knows the picture by. Pass refs {\"img1\": \"<layer id>\"} to say which layer your tokens mean: they are rewritten to that layer's label now, whatever the order is.",
        params: { text: P.str("the prompt"), negative: P.str("the negative prompt"), refs: P.obj("which layer each @img token of text and negative means: {\"img1\": \"<layer id>\", ...}") },
        async run(ed, a) {
            if (a.text != null) ed.setPromptText(agentRefs(ed, String(a.text), a.refs));
            if (a.negative != null) ed.setNegativeText(agentRefs(ed, String(a.negative), a.refs));
            ed.notifyChanged();
            return { prompt: ed.promptText, negative: ed.negativeText, ...refsReport(ed) };
        },
    },
    set_generation: {
        description: "Generation settings: mode api / local / cloud (the recipe decides what is available; select_recipe switches between the modes' recipes), seed, random seed, denoise, refine, and the document's Boxes switch (boxes).",
        params: { mode: P.str("api, local or cloud (Comfy Cloud recipes)", { enum: ["api", "local", "cloud"] }), seed: P.int("a fixed seed (turns random off)"), seed_random: P.bool("a new seed per run"), denoise: P.num("0.05..1"), refine: P.bool("refine pass"), boxes: P.bool("the Boxes switch under the prompt: on, a run of a recipe that takes boxes (FLUX 3 Image, Ideogram 4) sends the document's boxes, or the selection as one box when there are none; off, none goes and the boxes stay") },
        async run(ed, a) {
            const g = ed.genSettings;
            if (a.mode != null) { if (!["api", "local", "cloud"].includes(a.mode)) throw new Error("mode must be api, local or cloud"); g.mode = a.mode; }
            if (a.seed != null) { g.seed = Math.max(0, Math.floor(+a.seed) || 0); g.seedRandom = false; }
            if (a.seed_random != null) g.seedRandom = !!a.seed_random;
            if (a.denoise != null) g.denoise = Math.min(1, Math.max(0.05, +a.denoise || 1));
            if (a.refine != null) g.refine = !!a.refine;
            if (a.boxes != null) g.boxes = !!a.boxes;
            if (ed.syncGenControls) ed.syncGenControls();
            ed.renderInfo(); ed.notifyChanged();
            // the Boxes overlay draws the boxes dashed while the switch is off
            if (a.boxes != null) ed.draw();
            return { mode: g.mode, seed: g.seed, seed_random: !!g.seedRandom, denoise: g.denoise, refine: !!g.refine, boxes: !!g.boxes };
        },
    },
    set_crop: {
        description: "The Generate tab's Crop section for this document (what a run sends and how its result is pasted back). context: auto sizes the surroundings from the selection (at least 512 px), manual takes set_node_params padding (pixels, the same for every tab); feather: auto grows and feathers the mask edge from the selection's size, manual blurs it by set_node_params feather. fill: how the selected area looks in the picture the model gets (green: for edit models told to fill the green area). colorMatch: the result's colours matched to the surroundings. withOriginal: with a fill, the crop before the fill goes along as one more picture. align: the result is moved onto the crop before it is pasted. paste: selection (soft edge along the selection) or crop (the whole returned rectangle). extendFill: what extend_canvas fills the new border with. Only the keys given change; the answer is every key and the pixels manual uses.",
        params: {
            context: P.str("auto or manual (manual: set_node_params padding)", { enum: ["auto", "manual"] }),
            feather: P.str("auto or manual (manual: set_node_params feather)", { enum: ["auto", "manual"] }),
            fill: P.str("how the selected area is filled in the picture the model gets", { enum: CROP_FILLS }),
            colorMatch: P.bool("match the result's colours to the surroundings"),
            extendFill: P.str("what extend_canvas fills the new border with", { enum: EXTEND_FILLS }),
            withOriginal: P.bool("with a fill: send the crop before the fill as one more picture"),
            align: P.bool("move the result onto the crop before pasting it"),
            paste: P.str("selection or crop (the whole returned rectangle)", { enum: ["selection", "crop"] }),
        },
        async run(ed, a) {
            // every value is checked before any is stored: a refused call changes nothing
            const next = {};
            for (const [k, v] of Object.entries(a || {})) {
                if (k === "doc" || v === undefined) continue;
                if (!CROP_KEYS.includes(k)) throw new Error(`unknown crop setting "${k}" (${CROP_KEYS.join(", ")})`);
                next[k] = cropValue(k, v);
            }
            Object.assign(ed.cropSettings, next);
            if (ed.syncCropControls) ed.syncCropControls();
            ed.renderInfo(); ed.draw(); ed.notifyChanged();
            return { ...cropView(ed), changed: Object.keys(next), pixels: { padding: host.nodeParams.padding, feather: host.nodeParams.feather } };
        },
    },
    set_node_params: {
        destructive: true,
        scope: "app", description: "The Inpaint Canvas node parameters every run uses: padding, target_size, feather, multiple_of.",
        params: { padding: P.int("context pixels around the selection"), target_size: P.int("long side of the crop sent to the model, 0 = own size"), feather: P.int("stitch feather in pixels"), multiple_of: P.int("crop size rounding (64 for Flux / SDXL)") },
        async run(_, a) {
            for (const k of ["padding", "target_size", "feather", "multiple_of"]) if (a[k] != null) host.setNodeParam(k, Math.max(0, Math.round(+a[k] || 0)));
            return { ...host.nodeParams };
        },
    },
    set_settings: {
        description: "Values for the recipe's Settings panel (the editable inputs of the workflow, or the provider parameters): {index or label: value}.",
        params: { values: P.obj("object of setting index (or label) -> value", { required: true }) },
        async run(ed, a) {
            const targets = host.settingTargets(ed);
            const out = {};
            for (const [k, v] of Object.entries(a.values || {})) {
                const t = targets.find((x) => String(x.index) === String(k) || (x.node.title || "").toLowerCase() === String(k).toLowerCase() || x.inputName === k);
                if (!t) throw new Error(`no setting "${k}" (${targets.map((x) => `${x.index}: ${x.node.title}`).join(", ") || "none"})`);
                ed.settings[String(t.index)] = { ...(ed.settings[String(t.index)] || {}), value: v };
                out[t.index] = v;
            }
            if (ed.settingsChanged) ed.settingsChanged();
            ed.notifyChanged();
            return { set: out, settings: targets.map((t) => ({ index: t.index, label: t.node.title, input: t.inputName, value: (ed.settings[String(t.index)] || {}).value })) };
        },
    },
    // docs/PLAN_0_1_42.md F2b: the Settings section as data, and its Preset row
    list_settings: {
        readOnly: true,
        description: "The selected recipe's Settings section for this document, as data: per row its index, label, input, kind (number, combo, boolean or string), for a number integer / min / max / step / default, for a combo its options (model files, LoRAs, samplers; at most max_options of them, options_total says how many there are), the value the document holds and valid (false: a combo value the list does not offer, a number out of range). presets: the Preset row's presets in its order (shipped with the recipe first, then the ones the user saved), each with its values by row and missing (files the server lacks); preset: the one the rows hold now. set_settings changes a row, apply_preset applies a preset. Combo options come from the connected ComfyUI (or the recipe file without one).",
        params: { filter: P.str("only the rows whose label or input contains this (any case)"), max_options: P.int("the most options listed per combo row (0: none)", { default: 200 }) },
        async run(ed, a) {
            const r = host.recipe;
            const targets = host.settingTargets(ed);
            const max = a.max_options == null || a.max_options === "" ? 200 : clampInt(a.max_options, 0, 100000, 200);
            const f = a.filter != null && String(a.filter).trim() ? String(a.filter).trim().toLowerCase() : null;
            const rows = targets.filter((t) => !f || String(t.node.title || "").toLowerCase().includes(f) || String(t.inputName).toLowerCase().includes(f)).map((t) => settingRow(ed, t, max));
            const row = host.presetRow(ed, targets);
            return {
                recipe: r ? r.id : null, provider: r && r.kind === "provider" ? r.provider : null, settings: rows,
                presets: row ? row.presets.map((p) => presetSummary(ed, targets, row, p)) : [], preset: row && row.matching ? row.matching.name : null,
            };
        },
    },
    apply_preset: {
        description: "Apply a preset of the Settings section's Preset row to this document's rows, as picking it there does: one the recipe ships (the Realism Pass's L and M) or one the user saved (list_settings lists them with their values). Refused with nothing changed when the recipe has no presets, the name is none of them, it names no row of the recipe, or the server lacks a file it names. Saving and deleting presets stay in the app.",
        params: { name: P.str("the preset's name (list_settings: presets)", { required: true }) },
        async run(ed, a) {
            const r = host.recipe;
            if (!r) throw new Error("no recipe selected");
            const rn = r.name || r.id;
            if (r.kind === "provider") throw new Error(`${rn} is an API recipe: its Settings have no presets (set_settings sets a row)`);
            const targets = host.settingTargets(ed);
            const row = host.presetRow(ed, targets);
            if (!row || !row.presets.length) throw new Error(`${rn} has no presets${row ? ": the user saves one in its Preset row" : ""}`);
            const name = String(a.name == null ? "" : a.name).trim();
            const ci = row.presets.filter((x) => x.name.toLowerCase() === name.toLowerCase());
            const p = row.presets.find((x) => x.name === name) || (ci.length === 1 ? ci[0] : null);
            if (!p) throw new Error(`no preset "${name}" for ${rn} (${row.presets.map((x) => x.name).join(", ")})`);
            const s = presetSummary(ed, targets, row, p);
            if (!s.values.some((v) => v.index != null)) throw new Error(`preset "${p.name}" names no Settings row of ${rn}: nothing changed`);
            if (s.missing.length) throw new Error(`the server lacks ${s.missing.join(", ")}, which preset "${p.name}" names: nothing changed`);
            const res = host.applyPreset(ed, targets, p);
            return { applied: p.name, shipped: !!p.shipped, rows: res ? res.rows : s.values.length, status: ed.status, settings: targets.map((t) => ({ index: t.index, label: t.node.title, input: t.inputName, value: (ed.settings[String(t.index)] || {}).value })) };
        },
    },
    upsample_prompt: {
        needsImage: true, description: "Let the language model the editor is set to rewrite the prompt with the image in view (a ComfyUI language model node, an API key for ToAPIs / OpenAI / Google / Anthropic / OpenRouter, or a local OpenAI-compatible server). @img tokens are kept: every one must name a shown reference, and `check` lists what the rewrite dropped, added or named by number instead.",
        params: { timeout: P.timeout(300) },
        async run(ed, a) {
            if (ed.upsamplePending) throw new Error("an upsampling is still running");
            const before = ed.promptText;
            await ed.upsamplePrompt();   // an API model answers before this resolves, a ComfyUI helper prompt keeps upsamplePending
            if (!ed.upsamplePending && ed.promptText === before) throw new Error(ed.status);
            const ok = await until(() => !ed.upsamplePending, clampInt(a.timeout, 5, 3600, 300) * 1000);
            if (!ok) throw new Error("upsampling timed out: " + ed.status);
            if (/failed/i.test(ed.status)) throw new Error(ed.status);
            // `previous`: Revert's text, which follows the references like the prompt when they changed meanwhile
            return { prompt: ed.promptText, previous: ed.promptBackup != null ? ed.promptBackup : before, status: ed.status, check: ed.upsampleCheck || undefined };
        },
    },
    generate_new: {
        destructive: true,
        description: "Make this tab's base image from the prompt, no image needed. A local recipe renders onto a fresh canvas and is flattened into the base; an API recipe calls the model's text-to-image route. Replaces the image, the history and every layer but the reference layers, which stay; the shown ones go along where the model takes reference images for a new image (list_recipes: textRefs), each @img token written as the model's name for its picture (\"image 1\"; on a local recipe the white canvas is image 1). In an empty tab add_image_layer role reference makes a white canvas first.",
        params: {
            prompt: P.str("what to make; the tab's current prompt when left out. An @img token names a shown reference layer; a model that makes new images from the prompt alone refuses it"),
            negative: P.str("negative prompt (local chains only)"),
            refs: P.obj("which layer each @img token of prompt and negative means: {\"img1\": \"<layer id>\", ...} (as set_prompt)"),
            width: P.int("width in pixels", { default: 1024 }),
            height: P.int("height in pixels", { default: 1024 }),
            aspect: P.str("aspect ratio like 16:9; used with resolution instead of width and height"),
            resolution: P.int("long side in pixels when aspect is given", { default: 1024 }),
            seed: P.int("seed; a new random one when left out"),
            background: P.str("transparent asks an API model that supports it (the OpenAI image models) for a cut-out on a transparent ground; the base image then keeps its alpha channel", { enum: ["auto", "opaque", "transparent"] }),
            timeout: P.timeout(600),
        },
        async run(ed, a) {
            const r = host.recipe;
            if (!r) throw new Error("no recipe selected");
            if (r.task === "pass") throw new Error(`${REALISM_LABEL} works on a picture: over the whole picture with Upscale › ${REALISM_LABEL} (realism_pass), or select an area and Generate (generate).`);
            // before anything changes: the local route's newCanvas below would wipe the document (layers, history, undo)
            // before the generate it runs refuses a busy one; the API route asks the same in runGenerate
            const blocked = host.generateNewBlocked(ed);
            if (blocked) throw new Error(blocked);
            let w = clampInt(a.width, 64, 8192, 1024), h = clampInt(a.height, 64, 8192, 1024);
            if (a.aspect) {
                const [aw, ah] = sizeForAspect(a.aspect, clampInt(a.resolution, 64, 8192, 1024));
                w = aw; h = ah;
            }
            if (a.prompt != null) ed.setPromptText(agentRefs(ed, String(a.prompt), a.refs));
            if (a.negative != null) ed.setNegativeText(agentRefs(ed, String(a.negative), a.refs));
            if (!String(ed.promptText || "").trim()) throw new Error("write a prompt first");
            if (a.seed != null) { ed.genSettings.seed = Math.abs(Math.round(+a.seed)) >>> 0; ed.genSettings.seedRandom = false; if (ed.seedInput) ed.seedInput.value = ed.genSettings.seed; }
            const t0 = Date.now();
            if (r.kind === "provider") {
                const out = await host.runGenerate(ed, { width: w, height: h, aspect: a.aspect || null, prompt: ed.promptText, negative: ed.negativeText, seed: ed.genSettings.seed, background: a.background || null });
                ed.notifyChanged();
                return { mode: "api", provider: out.provider, model: out.model, width: out.width, height: out.height, seconds: out.seconds, transparent: !!out.transparent, prompt_sent: out.prompt, references: out.references, kept: out.kept, dropped: out.dropped, notes: out.notes || [], info: out.info || null, boxes: out.boxes || 0, status: ed.status };
            }
            if (a.background === "transparent" && r.kind !== "provider") throw new Error("a transparent background is an API model's parameter; this is a local ComfyUI recipe");
            // the run's token check, made before the canvas replaces the picture: the references stay, so this snapshot
            // is the run's, and the run selects the whole canvas (a token past the recipe's slots, a parked one, or one
            // that names nothing refuses here, not after the wipe); an unreachable server too
            if (host.refTokens && r.task !== "upscale") {
                const snap = ed.refSnapshot();
                host.refPrompt(ed, snap, "comfy", { recipe: r, comfy: host.comfyPlan(ed, r, snap.refIds.length, { hasSelection: true, crop: ed.cropSettings, gen: ed.genSettings }) });
            }
            if (!host.connected) throw new Error("Not connected to ComfyUI.");
            // local: a flat canvas of the wanted size (the reference layers stay and go along in the crop_image batch, after
            // the white crop: 26e names them), everything selected, the recipe run, then the result flattened into the
            // base; flatten keeps the reference layers
            await ed.newCanvas(`${w}x${h}`, { keepRefs: true });
            if (ed.width !== w || ed.height !== h) throw new Error(ed.status);
            ed.applyMaskToSelection(rectMask(ed, 0, 0, ed.width, ed.height), "replace");
            const res = await COMMANDS.generate.run(ed, { timeout: a.timeout });
            await ed.flatten();
            ed.notifyChanged();
            return { mode: "local", recipe: r.id, width: ed.width, height: ed.height, seconds: Math.round((Date.now() - t0) / 1000), result: res && res.layer ? res.layer : null, prompt_sent: res ? res.prompt_sent : null, notes: res ? res.notes || [] : [], status: ed.status };
        },
    },
    upscale: {
        needsImage: true, description: "Upscale with the selected upscale recipe (list_recipes: task \"upscale\"; select_recipe picks one). scope \"selection\": the selection's box goes to the upscaler at its own size and the sharper answer comes back into it at the document's resolution, as a result layer. scope \"document\": the base image goes out, the answer becomes the new base N times larger, and every layer, mask and the selection are scaled along (one undo step); on an upscale recipe on the user's ComfyUI the base goes through the recipe's graph and comes back without transparency (refused before anything is sent when the graph reads more than the picture, the picture passes the recipe's limits, or a job is going on the document). Waits for the answer; Topaz can take several minutes.",
        params: {
            scope: P.str("selection (a detail pass) or document (the whole picture larger)", { enum: ["selection", "document"], default: "selection" }),
            factor: P.num("how many times larger; the recipe's default when left out (list_recipes shows each recipe's factors); ignored by a model that picks its own"),
            prompt: P.str("guidance for the added detail, for an upscaler that takes one (list_recipes: usesPrompt true, e.g. Clarity, Magnific Creative); the document's prompt when left out, ignored by the others"),
            timeout: P.timeout(1800),
        },
        async run(ed, a) {
            const r = host.recipe;
            if (!r || r.task !== "upscale") throw new Error(`the selected recipe is no upscaler: select_recipe one with task "upscale" (${host.shell.recipes().filter((x) => x.task === "upscale").map((x) => x.id).join(", ") || "none installed"})`);
            if (ed.providerPending) throw new Error("a run is still going on this document");
            const scope = a.scope === "document" ? "document" : "selection";
            if (r.kind !== "provider") {
                // an upscaler on the user's ComfyUI. The whole picture: the base goes out alone through the recipe's graph
                // and the answer becomes the new base (host.runComfyUpscale, docs/PLAN_0_1_42.md U2); `timeout` is its hard
                // end, the queue's wait included, so the job is taken off the server when it passes
                if (scope === "document") {
                    const deadline = Date.now() + clampInt(a.timeout, 5, 3600, 1800) * 1000;
                    const out = await host.runComfyUpscale(ed, { factor: a.factor, deadline });
                    if (out.width != null) ed.notifyChanged();
                    return {
                        scope, recipe: out.recipe, provider: null, factor: out.factor, from: out.from, width: out.width, height: out.height, answered: out.answered,
                        seconds: Math.round((out.seconds || 0) * 10) / 10, info: null,
                        status: out.width != null ? ed.status : "The document was closed while the upscale ran; nothing was changed.",
                    };
                }
                // the selection: the node's stitch fits the answer back into the box, a Generate with the crop at its
                // native size
                if (!(ed.getBounds && ed.getBounds())) throw new Error("Select an area first: an upscale model on ComfyUI sharpens the selection's box.");
                // a factor (RTX Video Super Resolution) checked here, so a bad one is refused before the run starts
                const factor = host.upscaleFactorFor(r, a.factor);
                // generate() takes no arguments: the factor rides on the editor for host.queueGenerate, read once there
                ed._comfyUpscaleFactor = factor == null ? undefined : factor;
                ed.lastUpscaleFactor = null;
                let g;
                try { g = await COMMANDS.generate.run(ed, { timeout: clampInt(a.timeout, 5, 3600, 1800) }); } finally { ed._comfyUpscaleFactor = undefined; }
                const l = g.layer;
                return { scope, recipe: r.id, provider: null, factor: ed.lastUpscaleFactor ?? factor, box: l ? { x: l.x, y: l.y, w: l.w, h: l.h } : null, layer: l, seconds: g.seconds, info: null, status: ed.status };
            }
            const n0 = ed.history.length;
            const limit = clampInt(a.timeout, 5, 3600, 1800) * 1000;
            let timer = null;
            const out = await Promise.race([
                host.runUpscale(ed, { scope, factor: a.factor, prompt: a.prompt }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the upscale timed out: " + ed.status)), limit); }),
            ]).finally(() => clearTimeout(timer));
            ed.notifyChanged();
            if (scope === "document") return { scope, recipe: out.recipe, provider: out.provider, factor: out.factor, from: out.from, width: out.width, height: out.height, seconds: Math.round(out.seconds * 10) / 10, info: out.info, status: ed.status };
            const h = ed.history.length > n0 ? ed.history[ed.history.length - 1] : null;
            const layer = h ? ed.layers.find((l) => l.id === h.layerId) : null;
            return { scope, recipe: out.recipe, provider: out.provider, factor: out.factor, box: { x: out.x, y: out.y, w: out.w, h: out.h }, layer: layer ? layerSummary(ed, layer) : null, seconds: Math.round(out.seconds * 10) / 10, info: out.info, status: ed.status };
        },
    },
    realism_pass: {
        needsImage: true,
        description: `${REALISM_LABEL}: the whole visible picture (every visible layer with its filters and blend modes, without reference and control layers) goes once through DLSS 5 Neural Rendering on the user's own ComfyUI and comes back as a new layer named "${REALISM_LABEL}": full size, under the top run of filter layers (a film look or grain stays live above it and is not sent), no colour match, one undo step. factor 1 (the default) refines at the picture's own size. factor 1.5, 1.7 (DLSS's 1.724x Balanced), 2 or 3 also makes the document that many times larger first (the base and every layer, mask and the selection scaled along, as Resize does) and the pass layer comes at the new size, both in the same undo step; a picture whose output would pass 7680 × 4320 or 27.9 megapixels (answers near 30 megapixels sometimes came back with broken colours) is scaled down before it goes (the notes say so), so the answer and the document come back as large as DLSS allows. A second run reads the earlier pass layer with the rest and stacks its layer above it. Style, Strength and the DLSS model preset are the app's (Upscale › ${REALISM_LABEL}). Needs a ComfyUI on Windows with an RTX 30, 40 or 50 card and the ComfyUI-DLSS5-Enhancer node pack with its runtime; refused with the reason before anything is sent when the server cannot run it, a run is going on the document, at factor 1 the picture is past 7680 × 4320 or 27.9 megapixels, above 1 a job would land in the old geometry, the scaled-down picture would be under 64 px a side or not get larger (status's realism says beforehand whether factor 1 can run). Waits for the answer; \`timeout\` ends the job on the server too. changed: the picture changed while the pass ran (the layer shows it as it was). from / width / height: the document's size before and after.`,
        params: {
            factor: P.num("1 (the default: refine at the picture's own size), 1.5, 1.7, 2 or 3: above 1 the document becomes that many times larger and the pass layer comes at the new size"),
            timeout: P.timeout(570),
        },
        async run(ed, a) {
            // an epoch time in ms, comfyPictureRun's hard end (the queue's wait included): the job is taken off the
            // server when it passes, so no race is needed here. Without `timeout` the bridge waits its own 600 s, counted
            // from before this call: the default ends the pass 30 s inside it, room for the landing and the cancel, so an
            // agent hears the pass's own sentence and no layer lands after the bridge gave up
            const deadline = Date.now() + clampInt(a.timeout, 5, 3600, 570) * 1000;
            const out = await host.realismWhole(ed, { deadline, factor: a.factor === undefined || a.factor === null ? 1 : a.factor });
            if (out.layer) ed.notifyChanged();
            return {
                layer: out.layer ? layerSummary(ed, out.layer) : null, seconds: Math.round((out.seconds || 0) * 10) / 10,
                notes: out.note ? [out.note] : [], changed: !!out.changed,
                factor: out.factor, from: out.from || null, width: out.width == null ? null : out.width, height: out.height == null ? null : out.height,
                // the tab was closed while the pass ran: the job was taken off the server, nothing was added
                status: out.layer ? ed.status : "The document was closed while the pass ran; nothing was added.",
            };
        },
    },
    generate: {
        needsImage: true, description: "Generate with the selected recipe: the selected area (with context) goes to the model, the answer comes back as a result layer. Waits for it. prompt_sent is the prompt as the model got it (each @img token written as that model's name for its picture; on a local ComfyUI recipe as the graph numbers the picture in the node's batch, e.g. <image3>); notes says what the route or the recipe left out; seed is the seed the model got, null when the route sends none (FLUX 3 Image).",
        params: { timeout: P.timeout(600) },
        async run(ed, a) {
            const n0 = ed.history.length;
            const { wired } = host.resultInputState(ed);
            if (!wired) throw new Error("the recipe has no result output for this mode: select a recipe first");
            ed.lastSentPrompt = null;
            ed.lastRunNotes = [];
            ed.lastPassError = null;
            // a failure of the run: the status reads Error / failed, or is the Realism Pass's sentence for the pack's error
            const failed = () => /^Error|failed/i.test(ed.status || "") || (!!ed.lastPassError && ed.status === ed.lastPassError);
            // a refusal of this run (a token that cannot go, a missing key, ...) is said at once, not after the wait below;
            // a provider run is over when ed.generate() returns, so `seconds` counts from here
            if (ed.providerPending) throw new Error("a run is still going on this document");
            const started = Date.now(), limit = clampInt(a.timeout, 5, 3600, 600) * 1000;
            const run = await ed.generate();
            if (run && run.error) throw run.error;
            // a provider run has landed its layer when generate() returns: a sentence in its status that reads "failed"
            // (a note of the route) is no failure of the run
            if (ed.history.length <= n0 && failed()) throw new Error(ed.status);
            const t0 = Date.now();
            const provider = host.recipe && host.recipe.kind === "provider";
            let idleSince = 0;
            while (Date.now() - t0 < limit) {
                await wait(500);
                if (ed.history.length > n0) break;
                if (failed()) throw new Error(ed.status);
                if (provider) { if (!ed.providerPending) break; continue; }
                // the queue went idle without a result: the run failed elsewhere in the graph
                try {
                    const q = await (await api.fetchApi("/queue")).json();
                    const idle = !(q.queue_running || []).length && !(q.queue_pending || []).length;
                    if (idle && Date.now() - t0 > 3000) { idleSince = idleSince || Date.now(); if (Date.now() - idleSince > 2500) break; } else idleSince = 0;
                } catch (_) { /* ignore */ }
            }
            await until(() => ed.history.length > n0 || failed(), Math.max(30000, Math.min(limit - (Date.now() - t0), 180000)), 250);
            if (ed.history.length <= n0) throw new Error("no result arrived: " + (ed.status || "the run produced nothing"));
            const h = ed.history[ed.history.length - 1];
            const layer = ed.layers.find((l) => l.id === h.layerId);
            // prompt_sent: the prompt as the model got it, each @img token written as the model's name for its picture;
            // notes: what the route (or a local recipe's slots) left out; boxes: how many boxes went in the prompt
            return { layer: layer ? layerSummary(ed, layer) : null, seed: h.seed, mode: h.mode, status: ed.status, seconds: Math.round((Date.now() - started) / 100) / 10, prompt_sent: ed.lastSentPrompt, notes: ed.lastRunNotes || [], boxes: ed.lastSentBoxes || 0 };
        },
    },
    cancel_run: {
        scope: "app",
        description: `Cancel the runs in flight, as the title row's Cancel does: API runs (generate, generate_new and upscale on an API model) and the runs on the user's ComfyUI that hold a document (realism_pass, upscale of the whole picture with a local recipe), whose job is taken off the server. doc: only that tab's runs; without it every tab's. A command waiting on a cancelled run (generate, generate_new, upscale, realism_pass) ends at once with the cancel, and nothing lands. A provider may still finish a job it already had and charge it. A Generate with a recipe on the user's own ComfyUI is not stopped (Scumble never interrupts the user's server). cancelled: the runs (none: nothing was running); landing: runs whose answer was already in and is landing (no longer cancellable; Ctrl+Z takes the result back once it is in); ended: whether they have let go of their documents (waited for up to 10 s).`,
        params: { doc: P.int("only this tab's runs (the id from list_documents); every tab's when left out") },
        async run(_, a) {
            let ed = null;
            if (a.doc != null && a.doc !== "") {
                ed = host.editorById(a.doc);
                if (!ed) throw new Error(`no document with id ${a.doc} (open: ${host.editors().map((e) => e.node.id).join(", ") || "none"})`);
            }
            const now = Date.now();
            const runs = host.cancelRuns(ed);
            // a run whose answer is in has left the title row but still holds its document until its result has landed:
            // it can no longer be cancelled, so it is named as landing (and waited for), never as nothing running
            const landing = (ed ? [ed] : host.editors()).filter((e) => e.providerPending && !runs.includes(e.providerPending))
                .map((e) => ({ e, t: e.providerPending }));
            // the run ends in its own code (main aborts the request, a job on the user's ComfyUI is taken off it): wait for
            // its slot and its row in the title bar to go
            const over = () => runs.every((t) => !host._providerRuns.has(t) && !(t.editor && t.editor.providerPending === t))
                && landing.every((x) => x.e.providerPending !== x.t);
            const ended = runs.length || landing.length ? await until(over, 10000, 100) : true;
            const notes = [];
            if (runs.length) notes.push("A provider may still finish a job it already had and charge it.");
            if (landing.length) notes.push("A run's answer was already in and is landing: it can no longer be cancelled (Ctrl+Z takes it back once it is in).");
            if (!notes.length) notes.push("Nothing was running" + (ed ? " on this document." : "."));
            return {
                cancelled: runs.map((t) => ({ doc: t.editor && t.editor.node ? t.editor.node.id : null, provider: t.provider || null, label: t.label || t.provider || null, seconds: Math.round((now - (t.started || now)) / 100) / 10 })),
                landing: landing.map((x) => ({ doc: x.e.node ? x.e.node.id : null, label: x.t.label || x.t.provider || null })),
                ended,
                note: notes.join(" "),
            };
        },
    },

    // -- layers --
    list_layers: { readOnly: true, description: "All layers bottom to top with their properties; `selected` lists the layers selected with the active one; `groups` the folders (a layer's `group` is the innermost it is in, `parent` a group's).", params: {}, async run(ed) { return { active: ed.activeLayerId, selected: ed.selectedLayers ? ed.selectedLayers().map((l) => l.id) : [], layers: ed.layers.map((l) => layerSummary(ed, l)), groups: (ed.groups || []).map((g) => groupSummary(ed, g)) }; } },
    set_active_layer: {
        description: "Make a layer the active one, or select several (`layers`: they move and scale together with the move tool, merge with Ctrl+E, delete together; the first becomes active).",
        params: { layer: P.layer("the layer: id, name or unique name fragment", { default: "" }), layers: { type: "array", items: { type: "string" }, description: "several layers (ids, names or unique name fragments) to select together" } },
        async run(ed, a) {
            if (Array.isArray(a.layers) && a.layers.length) {
                const ls = a.layers.map((x) => findLayer(ed, x, { allowActive: false }));
                if (ls.some((l) => ed.isReference(l)) && ls.length > 1) throw new Error("reference layers are selected one at a time");
                const sel = ed.selectLayers(ls.map((l) => l.id), { active: a.layer ? findLayer(ed, a.layer, { allowActive: false }).id : null });
                touch(ed);
                return { active: ed.activeLayerId, selected: sel.map((l) => l.id), layers: sel.map((l) => layerSummary(ed, l)) };
            }
            if (!a.layer) throw new Error("give `layer` or `layers`");
            const l = findLayer(ed, a.layer, { allowActive: false });
            if (ed.selectLayers) ed.selectLayers([l.id]); else ed.activeLayerId = l.id;
            touch(ed); if (ed.updateSubbar) ed.updateSubbar();
            return layerSummary(ed, l);
        },
    },
    set_layer: {
        description: "Change a layer: name, visible, opacity (0..1 or percent), blend, locked, alpha_lock, clip (clipped to the layer below: shown only where that layer has pixels; its own undo step), role, colour match (0..100 %, match_source surroundings / below), geometry x y w h, active.",
        params: { layer: P.layer(), name: P.str(""), visible: P.bool(""), opacity: P.num("0..1 (or 0..100)"), blend: P.str("the blend mode", { enum: BLEND_MODES }), locked: P.bool(""), alpha_lock: P.bool(""), clip: P.bool("clip to the layer below (true) or release (false)"), role: P.str("none, reference or control", { enum: ["none", "reference", "control"] }), match: P.num("colour match strength 0..100"), match_source: P.str("surroundings or below", { enum: ["surroundings", "below"] }), x: P.int(""), y: P.int(""), w: P.int("width (alias width); without h the aspect is kept"), h: P.int("height (alias height)"), active: P.bool("also make it the active layer") },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (a.name != null) l.name = String(a.name);
            if (a.visible != null) { l.visible = !!a.visible; ed.refsMutated(); }
            if (a.opacity != null) l.opacity = Math.min(1, Math.max(0, +a.opacity > 1 ? +a.opacity / 100 : +a.opacity));
            if (a.blend != null) {
                // a typo drew as normal on every path before (no site checks the name): refused here
                if (!BLEND_MODES.includes(String(a.blend))) throw new Error(`blend "${a.blend}" is not one of ${BLEND_MODES.join(", ")}`);
                l.blend = String(a.blend);
            }
            if (a.locked != null) l.locked = !!a.locked;
            if (a.alpha_lock != null) l.alphaLock = !!a.alpha_lock;
            if (a.clip != null && !!a.clip !== !!l.clip && !ed.setLayerClip(l, !!a.clip, { only: true })) throw new Error(ed.status);
            if (a.role != null) {
                if (!["none", "reference", "control"].includes(a.role)) throw new Error("role must be none, reference or control");
                ed.setLayerRole(l, a.role);
            }
            if (a.match != null || a.match_source != null) {
                if (l.kind === "filter") throw new Error("filter layers have no colour match");
                l.match = l.match || { strength: 0, source: "surroundings" };
                if (a.match != null) { const m = +a.match; l.match.strength = Math.min(100, Math.max(0, Math.round(m > 0 && m < 1 ? m * 100 : m))); }
                // the editor calls the pixels under the layer "underneath"; "below" was stored as it came and read as surroundings
                if (a.match_source != null) { if (!["surroundings", "below", "underneath"].includes(a.match_source)) throw new Error("match_source must be surroundings or below"); l.match.source = a.match_source === "surroundings" ? "surroundings" : "underneath"; }
                ed.markMatchChanged(l);
            }
            const geo = ["x", "y", "w", "h"].some((k) => a[k] != null) || a.width != null || a.height != null;
            if (geo) {
                if (l.kind === "filter") throw new Error("filter layers cover the whole canvas");
                ed.pushUndo({ kind: "transform", id: l.id, label: "Layer geometry" });
                if (a.x != null) l.x = Math.round(+a.x);
                if (a.y != null) l.y = Math.round(+a.y);
                const w = a.w != null ? a.w : a.width, h = a.h != null ? a.h : a.height;
                if (w != null && h == null) { const k = +w / l.w; l.w = Math.max(1, Math.round(+w)); l.h = Math.max(1, Math.round(l.h * k)); }
                else { if (w != null) l.w = Math.max(1, Math.round(+w)); if (h != null) l.h = Math.max(1, Math.round(+h)); }
            }
            if (a.active) ed.activeLayerId = l.id;
            touch(ed);
            return layerSummary(ed, l);
        },
    },
    add_paint_layer: {
        needsImage: true, description: "Add an empty transparent paint layer at canvas size.",
        params: { name: P.str("layer name") },
        async run(ed, a) { const l = ed.addPaintLayer(); if (!l) throw new Error(ed.status); if (a.name) { l.name = String(a.name); touch(ed); } return layerSummary(ed, l); },
    },
    remove_layer: { destructive: true, description: "Delete a layer. Refused on a locked layer.", params: { layer: P.layer("", { required: true }) }, async run(ed, a) { const l = findLayer(ed, a.layer); refuseLayer(ed, l); ed.removeLayer(l.id); return { removed: l.id, layers: ed.layers.length }; } },
    frequency_separation: {
        description: "Frequency separation of the selection's box (or of the whole picture up to 16 MP): two layers on top, 'Low frequency' (its blur of radius px, normal) and 'High frequency' (the detail, linear light), which together give the picture back. One undo step; the high layer becomes active.",
        params: { radius: P.num("the blur radius in pixels (default: 0.4 % of the picture's short side)") },
        async run(ed, a) { const r = await ed.frequencySeparation({ radius: a.radius }); if (!r) throw new Error(ed.status); return r; },
    },
    dodge_burn_layer: {
        description: "A dodge & burn layer on top: a paint layer in soft light where white paint lightens and black darkens. Empty by default (the same picture as 50 % grey, no memory until painted); grey fills it with 50 % grey. One undo step; the layer becomes active.",
        params: { grey: P.bool("fill it with 50 % grey (Photoshop's habit; about 600 MB at 15000 x 10000)") },
        async run(ed, a) { const l = ed.dodgeBurnLayer({ grey: !!a.grey }); if (!l) throw new Error(ed.status); return layerSummary(ed, l); },
    },
    duplicate_layer: { description: "Duplicate a layer (the copy sits above it).", params: { layer: P.layer() }, async run(ed, a) { const l = findLayer(ed, a.layer); const c = ed.duplicateLayer(l); if (!c) throw new Error(ed.status); return layerSummary(ed, c); } },
    merge_down: { destructive: true, description: "Merge a layer into the one below it (into the base image if it is the lowest).", params: { layer: P.layer() }, async run(ed, a) { const l = findLayer(ed, a.layer); const n = ed.layers.length; await ed.mergeDown(l); if (ed.layers.length === n && ed.layers.includes(l)) throw new Error(ed.status); return { layers: ed.layers.map((x) => layerSummary(ed, x)), status: ed.status }; } },
    move_layer: {
        description: "Reorder a layer: to = up, down, top, bottom, or delta = ±n. A step goes past the next layer, into a group next to it or out of its own group at its end; top and bottom leave every group.",
        params: { layer: P.layer("", { required: true }), to: P.str("up, down, top or bottom", { enum: ["up", "down", "top", "bottom"] }), delta: P.int("steps up (positive) or down") },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (a.to === "top" || a.to === "bottom") ed.moveLayer(l.id, 0, { undo: true, to: a.to });
            else {
                const delta = a.to === "up" ? 1 : a.to === "down" ? -1 : Math.round(+a.delta || 0);
                if (delta) ed.moveLayer(l.id, delta, { undo: true });
            }
            return { index: ed.layers.indexOf(l), group: l.group || null, layers: ed.layers.map((x) => x.name) };
        },
    },
    // axis x is the editor's "h" (left to right), y its "v": until 0.1.42 both reached the editor as a vertical flip
    flip_layer: { description: "Mirror a layer: axis x mirrors it left to right (horizontally), axis y top to bottom (vertically). Refused on a locked or a filter layer.", params: { layer: P.layer(), axis: P.str("x (left to right) or y (top to bottom)", { enum: ["x", "y"], default: "x" }) }, async run(ed, a) { const l = findLayer(ed, a.layer); refuseLayer(ed, l, "flipped"); ed.activeLayerId = l.id; ed.flipLayer(a.axis === "y" || a.axis === "vertical" ? "v" : "h"); return layerSummary(ed, l); } },
    center_layer: { description: "Centre a layer on the canvas. Refused on a locked or a filter layer.", params: { layer: P.layer() }, async run(ed, a) { const l = findLayer(ed, a.layer); refuseLayer(ed, l, "centred"); ed.activeLayerId = l.id; ed.centerLayer(); return layerSummary(ed, l); } },
    // item 42: the layer menu's "Match edges to the layer below"; a refusal is an answer (aligned false and the reason), not an error
    match_edges: {
        needsImage: true,
        description: "Match a layer's edges to the picture under it: an inpaint result that came back slightly shifted or scaled (edit models re-render the whole crop) is fitted on its own edge ring (its opaque pixels near its transparent part or its mask's border) against the composite of the layers below, and moved (a whole-pixel shift) or resampled to match, one undo step (a live mask is baked in when it is resampled). The fit is kept only within 8 % scale, 0.03 shear and 5 % shift and when the edge difference drops by 3 % or more; otherwise nothing changes and the answer says why (aligned false, reason: flat area, fit out of range, no gain, ring too small, no fit found, text layer). apply false only reports the fit. scale and shift as the node's stitch reports them; centre: how far the layer's middle moved, in image pixels; before / after: the mean edge difference in levels of 255; how: moved, resampled or null. Refused on a locked or a filter layer.",
        params: { layer: P.layer(), apply: P.bool("false: only fit and report, change nothing", { default: true }) },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            refuseLayer(ed, l, "matched");
            if (ed.textEdit) ed.endTextEdit(true);
            ed.selectLayers([l.id]);
            const from = { x: l.x, y: l.y, w: l.w, h: l.h };
            const r = ed.matchEdges(l, { apply: a.apply !== false });
            if (r.how) touch(ed);
            const { matrix: _m, ...rest } = r;
            return { ...layerSummary(ed, l), ...rest, from, status: ed.status };
        },
    },
    transform_layer: {
        needsImage: true,
        description: "Transform one layer, baked into its pixels in one undo step, as the move tool's Rotate / Distort / Warp and its quarter turns. mode rotate: by `angle` degrees clockwise about the layer's middle (a text layer stays editable: the angle goes into the text, as set_text's angle); rotate90: a quarter turn (`dir` cw or ccw) without resampling; distort: the layer's four corners to `corners` (a perspective: [[x, y] top left, top right, bottom right, bottom left] in image pixels); warp: the layer bent on a grid of n × n cells: `points` holds the (n + 1) × (n + 1) grid points row by row from the top left, in image pixels (unbent they are x + w·i/n, y + h·j/n of the layer's box). Distort and warp turn a text layer into pixels; a live mask is baked into the pixels, a switched-off one dropped (undo brings both back). The layer keeps the resolution of its pixels. Refused on a locked or a filter layer; the base is no layer (rotate_canvas and straighten_canvas turn the whole picture). from: the layer's box before; changed false: nothing to do (an angle of 0).",
        params: {
            layer: P.layer(),
            mode: P.str("rotate, rotate90, distort or warp", { required: true, enum: TRANSFORM_MODES }),
            angle: P.num("rotate: degrees clockwise"),
            dir: P.str("rotate90: cw (clockwise) or ccw", { enum: ["cw", "ccw"], default: "cw" }),
            corners: { type: "array", items: { type: "array", items: { type: "number" } }, description: "distort: four [x, y] in image pixels, the new top left, top right, bottom right and bottom left corner" },
            n: P.int("warp: grid cells per side, 1..16", { default: 4 }),
            points: { type: "array", items: { type: "array", items: { type: "number" } }, description: "warp: (n + 1) × (n + 1) [x, y] grid points in image pixels, row by row from the top left" },
        },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            refuseLayer(ed, l, "transformed");
            const mode = String(a.mode || "");
            if (!TRANSFORM_MODES.includes(mode)) throw new Error(`mode must be one of ${TRANSFORM_MODES.join(", ")}`);
            // the arguments first, so a wrong one leaves the editor as it was
            let deg = 0, dir = 1, pts = null, n = 0;
            if (mode === "rotate") {
                deg = +a.angle;
                if (a.angle == null || a.angle === "" || !Number.isFinite(deg)) throw new Error("rotate needs angle (degrees clockwise)");
            } else if (mode === "rotate90") {
                if (a.dir != null && a.dir !== "" && a.dir !== "cw" && a.dir !== "ccw") throw new Error("dir must be cw or ccw");
                dir = a.dir === "ccw" ? -1 : 1;
            } else if (mode === "distort") {
                pts = pointList(a.corners, "corners");
                if (pts.length !== 4) throw new Error(`distort needs four corners (top left, top right, bottom right, bottom left), not ${pts.length}`);
            } else {
                n = clampInt(a.n == null || a.n === "" ? 4 : a.n, 1, 16, 4);
                if (a.n != null && a.n !== "" && n !== +a.n) throw new Error("n must be a whole number of grid cells, 1..16");
                pts = pointList(a.points, "points");
                if (pts.length !== (n + 1) * (n + 1)) throw new Error(`warp with n ${n} needs ${(n + 1) * (n + 1)} points ((n + 1) × (n + 1), row by row), not ${pts.length}`);
            }
            // a mode that bakes (rotate, distort, warp; not a text's angle) reads the layer's own pixels as one canvas (the
            // mask step and the bake): a layer past that (a full-size paint layer of a document over 268 MP) is refused
            // before anything changes, not half way after the undo step
            if (mode !== "rotate90" && !(mode === "rotate" && l.kind === "text" && l.text)) {
                const pw = l.px ? l.px.width : 0, ph = l.px ? l.px.height : 0;
                if (pw > 65535 || ph > 65535 || pw * ph > 268435456) throw new Error(`layer ${l.name || l.id} is ${pw} × ${ph} px, more than one canvas holds (65,535 px a side, 268 megapixels): ${mode} needs its pixels as one canvas`);
            }
            if (ed.textEdit) ed.endTextEdit(true);
            // an open transform in the editor (a preview, not applied) goes, as Esc would; the modes take one layer
            if (ed.pending) ed.cancelPending();
            ed.selectLayers([l.id]);
            const from = { x: l.x, y: l.y, w: l.w, h: l.h };
            const px0 = l.px, text0 = l.text;
            if (mode === "rotate90") ed.rotateLayer90(dir);
            else if (mode === "rotate" && l.kind === "text" && l.text) {
                // a text stays text: its angle grows, about its middle (the move tool's Rotate on a text does the same)
                const now = (layerSummary(ed, l).text || {}).angle || 0;
                await ed.setTextAngle(l, now + deg, { label: "Rotate" });
            } else {
                ed.startPending(mode);
                const p = ed.pending;
                if (!p || p.layer !== l) { if (ed.pending) ed.cancelPending(); throw new Error(ed.status || "the layer cannot be transformed"); }
                if (mode === "rotate") p.angle = deg * Math.PI / 180;
                else if (mode === "distort") { p.points = pts; p.H = null; }
                else { p.n = n; p.points = pts; }
                // the size the baked pixels get, before anything changes: a shape past one canvas (or a corner at infinity)
                // would fail half way, after the undo step and the mask
                const size = pendingSize(ed, p);
                if (!size) { ed.cancelPending(); throw new Error(`the ${mode} sends a corner to infinity: give corners that make a four-sided shape`); }
                if (size.w > 65535 || size.h > 65535 || size.w * size.h > 268435456) { ed.cancelPending(); throw new Error(`the ${mode} makes ${size.w} × ${size.h} px of pixels, more than one canvas holds (65,535 px a side, 268 megapixels)`); }
                ed.applyPending();
                if (ed.pending) { ed.cancelPending(); throw new Error(ed.status || "the transform was not applied"); }
            }
            const changed = l.px !== px0 || l.text !== text0;
            if (changed) touch(ed);
            return { ...layerSummary(ed, l), mode, from, changed, status: ed.status };
        },
    },
    copy_to_layer: {
        needsImage: true,
        description: "Copy the selected pixels of a layer, or of the visible picture with merged, into a new layer at the same place (Ctrl+C, or Ctrl+Shift+C, then Ctrl+V); with nothing selected the whole layer or the whole picture. cut takes the selected pixels out of the layer (the whole layer when nothing is selected), as Ctrl+X. to_doc pastes into another tab at the same coordinates. The new layer goes on top and becomes active, one undo step in the tab it lands in (a cut is a step of its own in this tab). The clipboard the user's Ctrl+V reads stays as it was. A typical use: lift an object out of the picture onto a layer of its own, then move it (set_layer x, y) or transform_layer it. Refused: a filter layer (no pixels; merged copies the picture), a cut of a locked layer or of the merged picture.",
        params: {
            layer: P.layer("the layer to copy from (id, name, a unique part of the name, or \"active\"); ignored with merged"),
            merged: P.bool("the visible picture (every visible layer with its filters, without reference and control layers) instead of one layer", { default: false }),
            cut: P.bool("take the pixels out of the layer (not with merged)", { default: false }),
            to_doc: P.int("the tab to paste into (default this one)"),
            name: P.str("the new layer's name (default \"<layer> copy\", or \"Paste n\" for the picture)"),
        },
        async run(ed, a) {
            const merged = !!a.merged, cut = !!a.cut;
            if (merged && cut) throw new Error("cut takes pixels out of one layer: the merged picture cannot be cut (copy it, then hide or mask what should go)");
            let target = ed;
            if (a.to_doc != null && a.to_doc !== "") {
                target = host.editorById(a.to_doc);
                if (!target) throw new Error(`no document with id ${a.to_doc} (open: ${host.editors().map((e) => e.node.id).join(", ") || "none"})`);
                if (!target.base || !target.width) throw new Error(`document ${a.to_doc} has no picture to paste into: load_image or new_canvas there first`);
            }
            const l = merged ? null : findLayer(ed, a.layer);
            if (l && l.kind === "filter") throw new Error(`layer ${l.name || l.id} is a filter layer: it has no pixels to copy (merged true copies the visible picture)`);
            if (l && cut) refuseLayer(ed, l);
            const prev = ed.clipboard;   // every tab shares it: the user's Ctrl+V reads it afterwards
            let made = null, clip = null;
            try {
                if (merged) clip = await mergedClip(ed);
                else {
                    ed.activeLayerId = l.id;
                    // a cut takes pixels; with the layer's mask in edit mode the editor would hide them in the mask instead
                    const edit = l.maskEdit;
                    if (cut) l.maskEdit = false;
                    try { clip = ed.copySelection({ cut }); } finally { if (cut && ed.layers.includes(l)) l.maskEdit = edit; }
                }
                if (!clip) throw new Error(ed.status || "nothing was copied");
                ed.clipboard = clip;
                target.pushUndo({ kind: "layers", label: "Paste" });
                made = target.pasteClipboard();
                if (!made) throw new Error(target.status || "nothing was pasted");
                if (a.name != null && String(a.name).trim()) made.name = String(a.name).trim();
            } finally { ed.clipboard = prev; }
            touch(target);
            if (target !== ed) touch(ed);
            return { ...layerSummary(target, made), doc: target.node.id, source: merged ? "merged" : l.id, cut, status: target.status };
        },
    },
    align_layers: {
        description: "Align the selected layers (or `layers`, which get selected) on an edge or a centre, or distribute them with equal gaps, within the box around them or within the canvas (one layer aligns to the canvas). Filter and locked layers stay put. One undo step.",
        params: {
            layers: { type: "array", items: { type: "string" }, description: "the layers (ids, names or unique name fragments); default: the selected layers" },
            align: P.str("the edge or centre to line up", { enum: ["left", "hcenter", "right", "top", "vcenter", "bottom"] }),
            distribute: P.str("equal gaps along x (horizontal) or y (vertical); three layers at least within the selection, two across the canvas", { enum: ["x", "y"] }),
            to: P.str("selection (the box around the layers) or canvas", { enum: ["selection", "canvas"], default: "selection" }),
        },
        async run(ed, a) {
            if (!a.align === !a.distribute) throw new Error("give `align` or `distribute`");
            if (Array.isArray(a.layers) && a.layers.length) ed.selectLayers(a.layers.map((x) => findLayer(ed, x, { allowActive: false }).id));
            const opts = { to: a.to === "canvas" ? "canvas" : "selection" };
            const moved = a.align ? ed.alignLayers(a.align, opts) : ed.distributeLayers(a.distribute === "y" ? "y" : "x", opts);
            if (!moved.length && !/already in place/.test(ed.status)) throw new Error(ed.status);
            return { moved: moved.map((l) => l.id), layers: ed.alignTargets().map((l) => layerSummary(ed, l)) };
        },
    },
    group_layers: {
        description: "Put layers into a new group, a folder in the layer list (the selected layers, or `layers`): its eye hides and its lock locks all of them; it has no opacity or blend mode of its own. The group takes the place of the topmost of them; a group whose layers are all given goes in whole. One undo step; the group's layers become the selection.",
        params: {
            layers: { type: "array", items: { type: "string" }, description: "the layers (ids, names or unique name fragments); default: the selected layers" },
            name: P.str("the group's name (default Group n)"),
        },
        async run(ed, a) {
            const ls = Array.isArray(a.layers) && a.layers.length ? a.layers.map((x) => findLayer(ed, x, { allowActive: false })) : ed.selectedLayers();
            if (ls.some((l) => ed.isReference(l))) throw new Error("a reference layer is in no group");
            const g = ed.groupLayersNow(ls, { name: a.name || null });
            if (!g) throw new Error(ed.status);
            touch(ed);
            return groupSummary(ed, g);
        },
    },
    ungroup_layers: {
        description: "Dissolve a group: its layers and groups stay where they are, in the group around it. One undo step.",
        params: { group: P.str("the group: id or name", { required: true }) },
        async run(ed, a) { const g = findGroup(ed, a.group); ed.ungroup(g.id); touch(ed); return { ungrouped: g.id, groups: ed.groups.map((x) => groupSummary(ed, x)) }; },
    },
    set_group: {
        description: "Change a group: name, visible (hides every layer in it, their own eyes stay), locked (locks every layer in it), collapsed (folded in the layer list). The switches take no undo step, as a layer's eye and lock; a new name does.",
        params: { group: P.str("the group: id or name", { required: true }), name: P.str(""), visible: P.bool(""), locked: P.bool(""), collapsed: P.bool("") },
        async run(ed, a) {
            const g = findGroup(ed, a.group);
            if (a.name != null && String(a.name).trim()) ed.renameGroup(g.id, a.name);
            for (const k of ["visible", "locked", "collapsed"]) if (a[k] != null) ed.setGroupFlag(g.id, k, !!a[k]);
            touch(ed);
            return groupSummary(ed, ed.groupById(g.id) || g);
        },
    },
    flatten: { destructive: true, needsImage: true, description: "Flatten all visible layers into the base image.", params: {}, async run(ed) { await ed.flatten(); return { layers: ed.layers.length, status: ed.status }; } },
    cutout_layer: {
        description: "Remove the background of a layer with the cutout model the editor is set to (in-app when a matting model is downloaded); the mask becomes the layer's transparency.",
        params: { layer: P.layer(), timeout: P.timeout(300) },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (ed.cutoutPending) throw new Error("a background removal is still running");
            // "done": the in-app model finished inside the call; "started": a ComfyUI run the editor finishes later; false:
            // nothing started (or the in-app run failed), and the status says why
            const run = await ed.cutoutLayer(l);
            if (!run) throw new Error(ed.status);
            if (run === "started") {
                const ok = await until(() => !ed.cutoutPending, clampInt(a.timeout, 5, 3600, 300) * 1000);
                if (!ok) throw new Error("background removal timed out: " + ed.status);
                if (/failed|could not apply/i.test(ed.status)) throw new Error(ed.status);
            }
            return layerSummary(ed, l);
        },
    },
    set_mask: {
        description: "Change a layer's mask (white = the layer shows): invert it; reveal (all) or hide (all) - a white or a black mask, added when the layer has none, else replacing it; from_selection (the selection shows) or hide_selection (the selection is hidden); from_layer (copy another layer's mask); disable / enable (the mask stays with the layer but is not drawn, PSD's \"disabled\"); apply (baked into the pixels; not on a filter layer) or remove. One undo step; every operation but disable switches the mask on.",
        params: {
            layer: P.layer(),
            op: P.str("what to do", { required: true, enum: MASK_OPS }),
            source: P.layer("from_layer: the layer whose mask is copied", { default: undefined }),
        },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            const op = String(a.op || "");
            if (!MASK_OPS.includes(op)) throw new Error(`op must be one of ${MASK_OPS.join(", ")}`);
            if (op === "from_layer") {
                if (a.source === undefined || a.source === null || a.source === "") throw new Error("from_layer needs source");
                const srcLayer = findLayer(ed, a.source);
                const ok = await ed.maskOp(l, op, { source: srcLayer });
                if (!ok) throw new Error(ed.status || `the mask operation ${op} did nothing`);
            } else {
                if (!l.maskPx && ["invert", "enable", "disable", "apply", "remove"].includes(op)) throw new Error(`${l.name} has no mask`);
                if ((op === "from_selection" || op === "hide_selection") && !ed.getBounds()) throw new Error("nothing is selected");
                // the switch standing that way already is no error: nothing changes, no step is pushed, the tab stays as it was
                if ((op === "enable" && !l.maskOff) || (op === "disable" && !!l.maskOff)) {
                    return { ...layerSummary(ed, l), changed: false, status: `${l.name}: the mask is already ${op === "disable" ? "switched off" : "on"}.` };
                }
                const ok = await ed.maskOp(l, op);
                if (!ok) throw new Error(ed.status || `the mask operation ${op} did nothing`);
            }
            touch(ed);
            return { ...layerSummary(ed, l), changed: true, status: ed.status };
        },
    },

    // -- filters --
    filter_types: {
        readOnly: true,
        scope: "app", description: "The filter layer types (built-in and from plugins) with their parameters; `fill: true` marks a fill layer's type (fill: a colour, gradient: two colours with their opacities), which covers what is below instead of filtering it. A select's options are {id, label, group}; a select with key \"preset\" (a grain's film stock, a black-and-white film's colour filter) fills the other parameters with the option's values when add_filter / set_filter set it, as picking it in the layer list does; `offset: true` marks a slider that is an offset on the preset (the others turn the preset to custom when they change it).",
        params: {},
        async run() {
            const option = (o) => (o && typeof o === "object" ? { id: o.id, label: o.label != null ? String(o.label) : String(o.id), ...(o.group ? { group: o.group } : {}), ...(o.needs ? { needs: o.needs } : {}) } : { id: o, label: String(o) });
            return {
                filters: Object.entries(FILTERS).map(([id, f]) => {
                    const hasPreset = (f.params || []).some((p) => p.key === "preset" && p.type === "select");
                    const needs = f.maps ? (typeof f.maps === "function" ? f.maps({}) : f.maps) : [];
                    return {
                        id, label: f.label, plugin: f.plugin || null, ...(f.over ? { fill: true } : {}),
                        needs,
                        params: (f.params || []).map((p) => ({
                            key: p.key, label: p.label, type: p.type || "number", min: p.min, max: p.max, default: p.type === "custom" ? undefined : p.default,
                            options: p.options ? p.options.map(option) : undefined,
                            offset: hasPreset && p.key !== "preset" && p.keepPreset ? true : undefined,
                            ...(p.hidden ? { hidden: true } : {}),
                            ...(p.when ? { when: p.when } : {}),
                        })),
                    };
                }),
                common: {
                    limit: {
                        source: ["depth", "luma", "color"],
                        lo: "0..1",
                        hi: "0..1",
                        fLo: "0..1",
                        fHi: "0..1",
                        invert: "bool",
                        color: "#rrggbb",
                        tol: "0..100",
                    },
                },
            };
        },
    },
    add_filter: {
        needsImage: true, description: "Add a non-destructive filter layer on top of the stack (see filter_types for types and params). A fill layer is one too: type \"fill\" (params color \"#rrggbb\") or \"gradient\" (shape linear / reflected / radial, from, to, from_opacity, to_opacity, angle, scale, x, y); it covers what is below, and set_layer's opacity, blend and a mask let the picture through. params.preset (a film stock of the grain, a colour filter of black-and-white film) sets the preset's values and names the layer as the layer list does; the other params are applied after it. Nothing is added when a parameter is refused.",
        params: { type: P.str("filter type id", { default: "grain" }), params: P.obj("parameter values {key: value}"), name: P.str("layer name (default the type, or the preset's name)") },
        async run(ed, a) {
            const type = String(a.type || "grain");
            if (!FILTERS[type]) throw new Error(`unknown filter "${type}" (${Object.keys(FILTERS).join(", ")})`);
            const vals = a.params != null ? checkParams(type, a.params) : null;
            if (FILTERS[type]?.over && vals?.limit && vals.limit.source !== "depth") throw new Error("a fill layer takes a depth limit only");
            const l = ed.addFilterLayer(type);
            if (!l) throw new Error(ed.status);
            if (vals) writeParams(ed, l, vals);
            if (a.name) l.name = String(a.name);
            touch(ed);
            return layerSummary(ed, l);
        },
    },
    set_filter: {
        description: "Change a filter layer's parameters (or its type), in one undo step as the layer list's controls make one. params.limit restricts where the filter acts (by depth, luma or colour; fill layers take depth only). params.preset (a film stock of the grain, a colour filter of black-and-white film) sets the preset's values and names the layer, then the other params are applied; a slider that is no offset on the preset turns it to custom when it changes the value (filter_types: offset). A new type starts from its defaults, then params. Nothing changes when a parameter is refused.",
        params: { layer: P.layer("", { required: true }), type: P.str("new filter type id"), params: P.obj("parameter values {key: value}") },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (l.kind !== "filter") throw new Error(`${l.name} is not a filter layer`);
            const type = a.type != null && a.type !== "" ? String(a.type) : null;
            if (type && !FILTERS[type]) throw new Error(`unknown filter "${type}" (${Object.keys(FILTERS).join(", ")})`);
            // a fill layer stays a fill and a filter a filter, as the type select offers them
            if (type && FILTERS[l.filter] && !!FILTERS[type].over !== !!FILTERS[l.filter].over) throw new Error(`${l.name} is a ${FILTERS[l.filter].over ? "fill" : "filter"} layer: its type is one of the ${FILTERS[l.filter].over ? "fills" : "filters"} (filter_types: fill)`);
            const vals = a.params != null ? checkParams(type || l.filter, a.params) : null;
            const targetType = type || l.filter;
            if (FILTERS[targetType]?.over && vals?.limit && vals.limit.source !== "depth") throw new Error("a fill layer takes a depth limit only");
            const keys = vals ? Object.keys(vals) : [];
            const retype = !!type && type !== l.filter;
            // the type select pushes its own step ("Filter type"), which holds the parameters as they were too
            if (retype) ed.setFilterType(l, type);
            else if (keys.length) ed.pushUndo({ kind: "filter", id: l.id, label: filterStepLabel(l.filter, keys) });
            if (keys.length) writeParams(ed, l, vals);
            touch(ed);
            return layerSummary(ed, l);
        },
    },

    // -- text --
    add_text: {
        needsImage: true, description: "Add a text layer at x,y (top left of the text; with an angle the corner the text starts at). Bundled fonts: Roboto, Open Sans, Montserrat, Playfair Display, Lobster, Oswald, Pacifico, Bebas Neue and more (see the editor's font list).",
        params: { text: P.str("the text", { required: true }), x: P.num("left (default 10 % of the width)"), y: P.num("top"), size: P.int("font size in pixels"), font: P.str("font family"), color: P.str("CSS colour"), bold: P.bool(""), italic: P.bool(""), align: P.str("left, center or right"), outline: P.num("outline width"), outline_color: P.str(""), angle: P.num("degrees clockwise; the text stays editable"), name: P.str("layer name") },
        async run(ed, a) {
            const l = await ed.addTextLayer(a.x != null ? +a.x : ed.width * 0.1, a.y != null ? +a.y : ed.height * 0.1);
            if (!l) throw new Error(ed.status);
            const t = l.text;
            if (a.text != null) t.content = String(a.text);
            if (a.font != null && String(a.font) !== t.font) setFont(t, String(a.font));
            if (a.size != null) t.size = Math.max(4, Math.round(+a.size));
            if (a.color != null) t.color = String(a.color);
            if (a.bold != null) t.bold = !!a.bold;
            if (a.italic != null) t.italic = !!a.italic;
            if (a.align != null) t.align = String(a.align);
            if (a.outline != null) t.outline = Math.max(0, +a.outline);
            if (a.outline_color != null) t.outlineColor = String(a.outline_color);
            if (a.name) l.name = String(a.name);
            await ed.renderTextLayer(l, { keepScale: false });
            // turned about the corner the text starts at, which stays at x, y; the layer's own step covers it
            if (a.angle != null && +a.angle) await ed.setTextAngle(l, +a.angle, { step: false, pivot: "start" });
            if (ed.textEdit) ed.endTextEdit(true);
            try { const focused = /** @type {HTMLElement | null} */ (document.activeElement); if (focused) focused.blur(); } catch (_) { /* ignore */ }
            touch(ed);
            return layerSummary(ed, l);
        },
    },
    set_text: {
        description: "Change a text layer's content, style or angle (degrees clockwise in all, about the layer's middle; the text stays editable).",
        params: { layer: P.layer("", { required: true }), text: P.str(""), font: P.str(""), size: P.int(""), color: P.str(""), bold: P.bool(""), italic: P.bool(""), align: P.str(""), outline: P.num(""), outline_color: P.str(""), angle: P.num("") },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (l.kind !== "text") throw new Error(`${l.name} is not a text layer`);
            const t = l.text;
            for (const [k, tk] of [["text", "content"], ["color", "color"], ["align", "align"], ["outline_color", "outlineColor"]]) if (a[k] != null) t[tk] = String(a[k]);
            if (a.font != null && String(a.font) !== t.font) setFont(t, String(a.font));
            if (a.size != null) t.size = Math.max(4, Math.round(+a.size));
            if (a.bold != null) t.bold = !!a.bold;
            if (a.italic != null) t.italic = !!a.italic;
            if (a.outline != null) t.outline = Math.max(0, +a.outline);
            await ed.renderTextLayer(l, { keepScale: true });
            // a locked layer keeps its angle: said, not silently skipped
            if (a.angle != null && l.locked) throw new Error(`${l.name} is locked: its angle cannot change`);
            if (a.angle != null) await ed.setTextAngle(l, +a.angle || 0, { step: false });
            touch(ed);
            return layerSummary(ed, l);
        },
    },

    // -- history, canvas --
    undo: {
        destructive: true,
        description: "Undo the last step, or `steps` of them (list_history shows what each one is).",
        params: { steps: P.int("how many steps (default 1)", { default: 1 }) },
        async run(ed, a) { const stepped = await ed.stepHistory(-Math.max(1, Math.round(+a.steps || 1))); return { undo: ed.undo.length, redo: ed.redo.length, stepped, status: ed.status }; },
    },
    redo: {
        destructive: true,
        description: "Redo the last undone step, or `steps` of them.",
        params: { steps: P.int("how many steps (default 1)", { default: 1 }) },
        async run(ed, a) { const stepped = await ed.stepHistory(Math.max(1, Math.round(+a.steps || 1))); return { undo: ed.undo.length, redo: ed.redo.length, stepped, status: ed.status }; },
    },
    list_history: {
        readOnly: true,
        description: "The undo history, oldest first: one row per state, named by the edit that led to it; `current` is the picture now, `future` rows are undone steps a redo brings back. `steps` is what undo (negative) or redo (positive) takes to get to a row. Also the named snapshots and the history's depth.",
        params: {},
        async run(ed) {
            return {
                rows: ed.undoList(), undo: ed.undo.length, redo: ed.redo.length,
                snapshots: ed.snapshots.map((s) => ({ name: s.name, at: s.at })),
                depth: { steps: ed.maxUndo, mb: Math.round(ed.maxUndoBytes / 1048576) },
            };
        },
    },
    take_snapshot: {
        needsImage: true, description: "Keep the whole document as it is now under a name (layers, masks, the selection, the prompt and settings), to come back to with restore_snapshot. Up to 8 per document; not saved with the document. Needs the tile backend. A name already taken gets a number.",
        params: { name: P.str("a name for it (default \"Snapshot N\")"), drop_oldest: P.bool("when the document holds 8 already: drop the oldest for good (else this is refused)") },
        async run(ed, a) {
            if (!ed.tileMode) throw new Error("snapshots need the tile backend (Settings › Rendering)");
            if (ed.snapshots.length >= 8 && !a.drop_oldest) throw new Error(`the document holds 8 snapshots (${ed.snapshots.map((x) => x.name).join(", ")}): delete_snapshot one, or pass drop_oldest: true`);
            const s = ed.takeSnapshot(a.name);
            if (!s) throw new Error("the snapshot could not be taken");
            return { name: s.name, snapshots: ed.snapshots.map((x) => x.name) };
        },
    },
    restore_snapshot: {
        needsImage: true, description: "Put the document back as it was in a named snapshot (take_snapshot). One undo step: undo takes it back; the snapshot stays.",
        params: { name: P.str("the snapshot's name", { required: true }) },
        async run(ed, a) {
            if (!ed.findSnapshot(String(a.name))) throw new Error(`no snapshot "${a.name}" (list_history lists them)`);
            if (!ed.restoreSnapshot(String(a.name))) throw new Error("the snapshot could not be restored");
            touch(ed);
            return { restored: String(a.name), undo: ed.undo.length, redo: ed.redo.length };
        },
    },
    delete_snapshot: {
        destructive: true,
        description: "Delete a named snapshot. The picture does not change.",
        params: { name: P.str("the snapshot's name", { required: true }) },
        async run(ed, a) {
            if (!ed.deleteSnapshot(String(a.name))) throw new Error(`no snapshot "${a.name}"`);
            return { deleted: String(a.name), snapshots: ed.snapshots.map((x) => x.name) };
        },
    },
    compare: { description: "Toggle the before / after split view.", params: { enabled: P.bool("on or off; toggles when omitted") }, async run(ed, a) { const want = a.enabled == null ? !ed.compare : !!a.enabled; if (want !== !!ed.compare) ed.toggleCompare(); return { compare: !!ed.compare, status: ed.status }; } },
    extend_canvas: {
        destructive: true,
        needsImage: true, description: "Extend (positive) or crop (negative) the canvas on each side, in pixels. An extension bakes every visible layer into the base and fills the new border as set_crop's extendFill says (average color unless set).",
        params: { left: P.int("", { default: 0 }), top: P.int("", { default: 0 }), right: P.int("", { default: 0 }), bottom: P.int("", { default: 0 }) },
        async run(ed, a) {
            const v = { left: Math.round(+a.left || 0), top: Math.round(+a.top || 0), right: Math.round(+a.right || 0), bottom: Math.round(+a.bottom || 0) };
            if (Object.values(v).some((x) => x < 0)) { await ed.cropCanvas(v); v.left = Math.max(0, v.left); v.top = Math.max(0, v.top); v.right = Math.max(0, v.right); v.bottom = Math.max(0, v.bottom); }
            if (Object.values(v).some((x) => x > 0)) await ed.extendCanvas(v);
            return { width: ed.width, height: ed.height, status: ed.status };
        },
    },
    rotate_canvas: {
        needsImage: true, description: "Rotate the whole picture by a quarter or a half turn (degrees clockwise: 90, -90 = 270, 180). Every layer, mask, the selection, the guides, the saved selections and the results history turn with it; nothing is resampled. One undo step. Refused while a render or another job of the document runs.",
        params: { angle: P.int("degrees clockwise", { required: true, enum: [90, -90, 180, 270] }) },
        async run(ed, a) {
            const turns = { 90: 1, 270: -1, "-90": -1, 180: 2, "-180": 2 };
            const op = turns[String(Math.round(+a.angle))];
            if (op === undefined) throw new Error("angle must be 90, -90 (270) or 180");
            const w0 = ed.width, h0 = ed.height;
            if (!(await ed.turnDocument(op))) throw new Error(ed.status || "the picture could not be turned");
            const quarter = op !== 2;
            if (ed.width !== (quarter ? h0 : w0) || ed.height !== (quarter ? w0 : h0)) throw new Error(`the picture is ${ed.width} × ${ed.height} after the turn`);
            return { width: ed.width, height: ed.height, status: ed.status };
        },
    },
    flip_canvas: {
        needsImage: true, description: "Mirror the whole picture: horizontal (left to right) or vertical (top to bottom). Every layer, mask, the selection, the guides, the saved selections and the results history follow. One undo step. (flip_layer mirrors one layer.)",
        params: { axis: P.str("horizontal (left to right) or vertical (top to bottom)", { required: true, enum: ["horizontal", "vertical"] }) },
        async run(ed, a) {
            const axis = String(a.axis || "").toLowerCase();
            const op = axis === "horizontal" || axis === "h" ? "h" : axis === "vertical" || axis === "v" ? "v" : null;
            if (!op) throw new Error("axis must be horizontal or vertical");
            if (!(await ed.turnDocument(op))) throw new Error(ed.status || "the picture could not be mirrored");
            return { width: ed.width, height: ed.height, status: ed.status };
        },
    },
    straighten_canvas: {
        destructive: true,
        needsImage: true, description: "Straighten the whole picture: turn it by any angle (degrees clockwise, -45..45) about its centre and crop it to a frame inside the turned picture, in one undo step. Without x / y / width / height the frame is the largest one of `aspect` (original: the picture's own; free; 1:1, 4:3, 3:2, 16:9, 5:4 or W:H) centred in the turned picture. x / y / width / height set the frame in the turned picture's coordinates (the picture's own at 0 degrees). The base, every layer and mask and the selection are resampled once; text stays editable (its angle grows); guides stay where they are on the screen, shifted by the crop. Refused while a render or another job of the document runs.",
        params: {
            angle: P.num("degrees clockwise, -45..45", { required: true }), aspect: P.str("original, free, 1:1, 4:3, 3:2, 16:9, 5:4 or W:H", { default: "original" }),
            x: P.int("frame left"), y: P.int("frame top"), width: P.int("frame width"), height: P.int("frame height"),
        },
        async run(ed, a) {
            const angle = +a.angle;
            if (!Number.isFinite(angle) || Math.abs(angle) > 45) throw new Error("angle must be between -45 and 45 degrees (rotate_canvas turns by quarters)");
            let frame = {};
            if ([a.x, a.y, a.width, a.height].every((v) => v != null)) frame = { x: +a.x, y: +a.y, w: +a.width, h: +a.height };
            else if ([a.x, a.y, a.width, a.height].some((v) => v != null)) throw new Error("give all of x, y, width and height, or none");
            else {
                const ratio = ed.aspectRatio(String(a.aspect || "original"));
                if (ratio === undefined) throw new Error("aspect must be original, free, 1:1, 4:3, 3:2, 16:9, 5:4 or W:H");
                const [x, y, w, h] = ed.fitFrame(angle, ratio);
                frame = { x, y, w, h };
            }
            if (!(await ed.straightenDocument({ angle, ...frame }))) throw new Error(ed.status || "the picture could not be straightened");
            return { width: ed.width, height: ed.height, status: ed.status };
        },
    },
    resize_image: {
        destructive: true,
        needsImage: true,
        description: "Resize the whole document, as Image › Canvas › Resize: the base picture is resampled to the new size, every layer keeps its own pixels and is scaled in place, masks and the selection follow; one undo step. Give width and height, or one of them (the other keeps the aspect), or percent, or long_side (the aspect kept). Refused while a run or another job of the document is going (its result would land in the old geometry), below 8 px a side, and past what one canvas holds (65,535 px a side, 268 megapixels). from: the size before.",
        params: {
            width: P.int("the new width in pixels"), height: P.int("the new height in pixels"),
            percent: P.num("instead: percent of the current size (1..1000)"), long_side: P.int("instead: the new long side in pixels"),
        },
        async run(ed, a) {
            const W = ed.width, H = ed.height;
            const given = (v) => v != null && v !== "";
            const ways = [given(a.width) || given(a.height), given(a.percent), given(a.long_side)].filter(Boolean).length;
            if (ways !== 1) throw new Error(ways ? "give width / height, percent or long_side, one of them" : "give width and / or height, percent or long_side");
            const num = (v, what) => { const x = +v; if (!Number.isFinite(x) || x <= 0) throw new Error(`${what} must be a positive number, not ${JSON.stringify(v)}`); return x; };
            let nw, nh;
            if (given(a.percent)) {
                const p = num(a.percent, "percent");
                if (p < 1 || p > 1000) throw new Error("percent must be 1..1000");
                nw = Math.round(W * p / 100); nh = Math.round(H * p / 100);
            } else if (given(a.long_side)) {
                const k = num(a.long_side, "long_side") / Math.max(W, H);
                nw = Math.round(W * k); nh = Math.round(H * k);
            } else {
                nw = given(a.width) ? Math.round(num(a.width, "width")) : null;
                nh = given(a.height) ? Math.round(num(a.height, "height")) : null;
                if (nw == null) nw = Math.round(W * nh / H);
                if (nh == null) nh = Math.round(H * nw / W);
            }
            if (nw < 8 || nh < 8) throw new Error(`${nw} × ${nh} px is too small: at least 8 px a side`);
            if (nw > 65535 || nh > 65535 || nw * nh > 268435456) throw new Error(`${nw} × ${nh} px is more than one canvas holds (65,535 px a side, 268 megapixels): the resize needs one of that size`);
            if (nw === W && nh === H) throw new Error(`the picture is ${W} × ${H} already`);
            // before the editor, which would only say it in the status line: a job would land in the old geometry
            const blocked = ed.turnBlocked();
            if (blocked) throw new Error(blocked);
            if (ed._turning) throw new Error("Wait for the turn to finish.");
            await ed.resizeImage(nw, nh);
            if (ed.width !== nw || ed.height !== nh) throw new Error(ed.status || "the picture could not be resized");
            return { width: ed.width, height: ed.height, from: [W, H], status: ed.status };
        },
    },

    // -- export --
    export: {
        destructive: true,
        needsImage: true, description: "Save the flattened image (png, jpg, webp, tiff, psd or ora with layers). With `path` no dialog is shown. `scale`, `width` and `height` save it smaller or bigger; `canvas_width` / `canvas_height` put it in a frame of that size (bigger: a margin of `fill`, smaller: cropped) at `anchor`; PSD and ORA always keep the full size. A PNG carries the prompt, seed and recipe only when `metadata` is true, or when it is left out and the Export section's switch is on (on by default).",
        params: { format: P.str("png, jpg, webp, tiff, psd or ora", { enum: ["png", "jpg", "webp", "tiff", "psd", "ora"], default: "png" }), name: P.str("file name stem for the dialog"), path: P.str("absolute target path (no dialog)"), scale: P.num("percent of the document size, 1..400"), width: P.int("width in pixels (the height follows the aspect ratio)"), height: P.int("height in pixels (the width follows the aspect ratio)"), quality: P.num("JPEG / WebP quality 0.1..1", { default: 0.92 }),
            canvas_width: P.int("frame width in pixels (default the picture's)"), canvas_height: P.int("frame height in pixels"), anchor: P.str("where the picture sits in the frame: tl, tc, tr, ml, mc, mr, bl, bc, br", { default: "mc" }), fill: P.str("transparent, white, black or #rrggbb around the picture", { default: "transparent" }),
            metadata: P.bool("PNG: write the prompt, seed and recipe into the file (default: the Export section's switch)") },
        async run(ed, a) {
            const fmt = ["png", "jpg", "webp", "tiff", "psd", "ora"].includes(a.format) ? a.format : "png";
            if (ed.saveFormatSel) ed.saveFormatSel.value = fmt;
            if (ed.saveNameInput) ed.saveNameInput.value = String(a.name || docName(ed) || "scumble");
            const before = { ...host.exportState(ed) };
            if (a.width != null || a.height != null) host.setExportSize(ed, { width: a.width, height: a.height, quality: a.quality });
            else if (a.scale != null) host.setExportSize(ed, { percent: a.scale, quality: a.quality });
            else if (a.quality != null) host.setExportSize(ed, { quality: a.quality });
            if (a.canvas_width != null || a.canvas_height != null) host.setExportSize(ed, { canvasWidth: a.canvas_width, canvasHeight: a.canvas_height, anchor: a.anchor, fill: a.fill });
            if (a.metadata != null) host.exportState(ed).metadata = !!a.metadata;   // this export only: `before` puts it back
            const saved = await withExportPath(a.path, () => ed.exportImage({ download: false }))
                .finally(() => { ed._export = before; host.syncExportRow(ed); });
            if (!saved) throw new Error(ed.status);
            return { file: saved, status: ed.status };
        },
    },
    export_layer: {
        destructive: true,
        description: "Save one layer as a PNG with transparency.",
        params: { layer: P.layer(), path: P.str("absolute target path (no dialog)") },
        async run(ed, a) { const l = findLayer(ed, a.layer); ed.activeLayerId = l.id; const saved = await withExportPath(a.path, () => ed.exportLayerPng()); if (!saved) throw new Error(ed.status); return { file: saved, status: ed.status }; },
    },
    export_mask: {
        destructive: true,
        needsImage: true, description: "Save the selection as a black and white mask PNG.",
        params: { path: P.str("absolute target path (no dialog)") },
        async run(ed, a) { const saved = await withExportPath(a.path, () => ed.exportMaskPng()); if (!saved) throw new Error(ed.status); return { file: saved, status: ed.status }; },
    },
    screenshot: {
        readOnly: true,
        needsImage: true, description: "A JPEG, base64 in `data`. what = image: the flattened picture; editor: with hidden helpers; layer: one layer alone (its own pixels, whole); base: the base picture without any layer (the before); mask: the selection in black and white (white = selected), or with `layer` that layer's mask over its place (white = the layer shows). box [x, y, w, h] in image pixels shows only that region (not with layer), up to 1:1 (max_size caps its long side): judge an inpainted area on a large picture at full resolution. scale: output pixels per image pixel; box: the region read, held to the picture.",
        params: {
            what: P.str("image, editor, layer, base or mask", { enum: SHOT_WHAT, default: "image" }), layer: P.layer("for what = layer; for what = mask the layer whose mask to show (the selection when left out)", { default: undefined }),
            box: { type: "array", items: { type: "number" }, description: "[x, y, w, h]: only this region of the picture, in image pixels (image, editor, base, mask)" },
            max_size: P.int("long side in pixels (64..4096)", { default: 1024 }), quality: P.num("JPEG quality 0.3..0.95", { default: 0.85 }), show_selection: P.bool("tint and outline the selection (image, editor, base)", { default: true }), show_layers: P.bool("outline and label the layers", { default: false }),
        },
        async run(ed, a) {
            const { canvas: c, w, h, s, src, box } = await shotCanvas(ed, a);
            const ctx = c.getContext("2d");
            const ox = box ? box.x : 0, oy = box ? box.y : 0;
            if (a.show_layers && a.what !== "layer" && a.what !== "mask") {
                ctx.strokeStyle = "#7cc7ff"; ctx.lineWidth = 1; ctx.font = "12px sans-serif"; ctx.fillStyle = "#7cc7ff";
                for (const l of ed.layers) { if (l.kind === "filter" || !l.visible) continue; ctx.strokeRect((l.x - ox) * s, (l.y - oy) * s, l.w * s, l.h * s); ctx.fillText(l.name, (l.x - ox) * s + 3, (l.y - oy) * s + 13); }
            }
            const url = c.toDataURL("image/jpeg", Math.min(0.95, Math.max(0.3, +a.quality || 0.85)));
            // with a box the picture's own size, and the region read
            return { width: w, height: h, scale: s, image_width: box ? ed.width : src.w, image_height: box ? ed.height : src.h, ...(box ? { box } : {}), mime: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
        },
    },
    depth_map: {
        needsImage: true,
        description: "Compute or refresh the document's depth map (Depth Anything V2 Small).",
        params: {
            force: P.bool("recompute even if already present and fresh", { default: false }),
            edges: P.int("edge snap strength 0..100; 0 keeps the plain sample", { minimum: 0, maximum: 100 }),
            detail: P.enum("standard, fine (2x2) or finest (3x3)", ["standard", "fine", "finest"], "standard"),
        },
        async run(ed, a) {
            const force = a.force === true || a.force === "true";
            const existing = ed.maps && ed.maps.depth;
            const edgesVal = a.edges !== undefined && a.edges !== null ? Math.max(0, Math.min(100, Math.round(+a.edges))) : null;
            const detail = a.detail || "standard";
            const existingDetail = existing && existing.meta && existing.meta.detail
                ? (existing.meta.detail.route === "large" ? "large" : (existing.meta.detail.grid === 3 ? "finest" : "fine"))
                : "standard";
            let map;
            if (!force && existing && existing.data && existingDetail === detail) {
                if (edgesVal !== null) {
                    ed.setMapMeta("depth", { snap: { ...(existing.meta?.snap || {}), strength: edgesVal } });
                }
                map = ed.maps.depth;
            } else {
                map = await ed.ensureDepthMap({ force: true, edges: edgesVal, detail });
            }
            if (!map || (!map.data && !map.u16)) throw new Error("depth map computation failed");
            const meta = map.meta || map;
            return {
                ok: true,
                width: map.w,
                height: map.h,
                provider: meta.provider,
                raw_bounds: meta.rawBounds || null,
                stale: ed.isDepthStale ? (await ed.checkDepthStale?.() ?? ed.isDepthStale()) : false,
                edges: (meta.snap && meta.snap.strength) || 0,
                guide: !!map.guide,
                detail: meta.detail || null,
            };
        },
    },
    sample_depth: {
        needsImage: true,
        readOnly: true,
        description: "Sample the document's depth map at (x, y) in image pixels (Depth Anything V2 Small). Returns normalized depth (0..1, near to far), 16-bit depth (0..65535), raw disparity, disparity bounds, resolution, provider and whether the map is stale. Requires running depth_map first.",
        params: {
            x: P.num("x in image pixels", { required: true }),
            y: P.num("y in image pixels", { required: true }),
        },
        async run(ed, a) {
            const x = +a.x, y = +a.y;
            if (a.x == null || a.y == null || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("pass x and y in image pixels");
            if (x < 0 || y < 0 || x >= ed.width || y >= ed.height) throw new Error(`${x}, ${y} is outside the ${ed.width} × ${ed.height} picture`);
            const depthObj = (ed.maps && ed.maps.depth) || ed.depth;
            const u16 = (depthObj && (depthObj.data || depthObj.u16)) || null;
            if (!depthObj || !u16) throw new Error("run depth_map first");
            const dw = depthObj.w, dh = depthObj.h;
            const gx = Math.max(0, Math.min(dw - 1, Math.floor((x / ed.width) * dw)));
            const gy = Math.max(0, Math.min(dh - 1, Math.floor((y / ed.height) * dh)));
            const u16Val = u16[gy * dw + gx];
            const meta = depthObj.meta || depthObj;
            let rawVal = null;
            if (meta.raw && meta.rw && meta.rh) {
                const rx = Math.max(0, Math.min(meta.rw - 1, Math.floor((x / ed.width) * meta.rw)));
                const ry = Math.max(0, Math.min(meta.rh - 1, Math.floor((y / ed.height) * meta.rh)));
                rawVal = meta.raw[ry * meta.rw + rx];
            }
            return {
                x: Math.floor(x),
                y: Math.floor(y),
                depth: Math.round((u16Val / 65535) * 100000) / 100000,
                u16: u16Val,
                raw_disparity: rawVal != null ? Math.round(rawVal * 10000) / 10000 : null,
                near: meta.hi != null ? Math.round(meta.hi * 10000) / 10000 : null,
                far: meta.lo != null ? Math.round(meta.lo * 10000) / 10000 : null,
                raw_bounds: meta.rawBounds || null,
                width: dw,
                height: dh,
                provider: meta.provider,
                stale: ed.isDepthStale ? ed.isDepthStale() : false,
            };
        },
    },
    depth_edit: {
        needsImage: true,
        description: "Change the document's depth map inside the selection (soft edges count partly): flatten to the median (or to `value`, 0 near .. 1 far), offset by `value` (-1..1, + is farther), or smooth by `value` (0..1). One undo step.",
        params: {
            op: P.enum("flatten, offset or smooth", ["flatten", "offset", "smooth"]),
            value: P.num("see op"),
        },
        async run(ed, a) {
            const op = String(a.op || "").trim().toLowerCase();
            if (!["flatten", "offset", "smooth"].includes(op)) {
                throw new Error("op must be flatten, offset or smooth");
            }
            if (!ed.maps || !ed.maps.depth) {
                throw new Error("run depth_map first");
            }
            if (!ed.getBounds()) {
                throw new Error("make a selection first");
            }
            const val = a.value !== undefined && a.value !== null ? +a.value : null;
            const res = await ed.editDepth(op, val);
            if (!res) throw new Error("depth edit failed");
            return res;
        },
    },
    depth_from_layer: {
        needsImage: true,
        description: "Create the document's depth map from an existing layer (white is near, black is far). The layer must cover the whole picture.",
        params: {
            layer: P.layer("the layer: id, name or unique name fragment", { required: true }),
            invert: P.bool("invert: treat black as near instead of white", { default: false }),
        },
        async run(ed, a) {
            if (a.layer === undefined || a.layer === null || a.layer === "") {
                throw new Error("layer parameter required");
            }
            const l = findLayer(ed, a.layer);
            const invert = !!a.invert;
            const map = await ed.depthFromLayer(l, { invert });
            if (!map) throw new Error("depth from layer failed");
            return {
                w: map.w,
                h: map.h,
                source: "layer",
            };
        },
    },
    get_state: { readOnly: true, description: "The document's state JSON (the node's canvas_state without the selection bitmaps).", params: {}, async run(ed) { const v = JSON.parse(ed.getValue() || "{}"); delete v.selection; delete v.selections; return v; } },
    set_status: { description: "Write a line into the document's status bar.", params: { text: P.str("", { required: true }) }, async run(ed, a) { ed.setStatus(String(a.text)); return { status: ed.status }; } },

    // -- log --
    read_log: {
        readOnly: true,
        scope: "app",
        description: "The app's log (what the app, its providers and helpers reported; errors carry the request shape and the stack): the last entries, newest last. Also in Help > Console and in <userData>/logs/scumble.log.",
        params: { level: P.str("all, warn (warnings and errors) or error", { enum: ["all", "warn", "error"], default: "all" }), after: P.int("only entries with an id above this (from an earlier call)", { default: 0 }), limit: P.int("at most this many entries (default 200)", { default: 200 }) },
        async run(_ed, a) {
            const all = await window.scumble.log.list({ after: a.after | 0 });
            const lvl = a.level || "all";
            const picked = all.filter((e) => lvl === "all" || (lvl === "error" ? e.level === "error" : e.level !== "info"));
            const limit = Math.max(1, Math.min(2000, a.limit | 0 || 200));
            return { entries: picked.slice(-limit), total: all.length, file: await window.scumble.log.file() };
        },
    },

    // -- brush --
    list_brush_tips: {
        readOnly: true,
        description: "The brush tips available under Tip: the built-in round dab and the imported ones (from Photoshop .abr files or images), with the active one and the brush settings of this document.",
        params: {},
        async run(ed) {
            const tips = [{ id: "round", name: "Round", builtIn: true }, ...(ed.brushTips || []).map((t) => ({ id: t.id, name: t.name, width: t.canvas.width, height: t.canvas.height, spacing: t.spacing || 0, source: t.source || "" }))];
            return { active: ed.brushTipId || "round", size: ed.brushSize, hardness: Math.round((ed.hardness || 0) * 100), eraseHardness: Math.round((ed.eraseHardness || 0) * 100), opacity: Math.round((ed.brushOpacity == null ? 1 : ed.brushOpacity) * 100), flow: Math.round((ed.brushFlow == null ? 1 : ed.brushFlow) * 100), follow: !!ed.tipRotate, tips };
        },
    },
    set_brush: {
        description: "Brush settings of this document: the tip (round, or an imported tip by id or name), size in pixels, hardness, opacity and flow in percent, the tip's spacing in percent of its size, and whether the tip follows the stroke direction. Every parameter is optional.",
        params: {
            tip: P.str("round, or the id or name of an imported tip (list_brush_tips)"),
            size: P.int("brush size in image pixels (2..1000)"),
            hardness: P.num("0..100 for the paint brush (the eraser keeps its own, see erase_hardness)"),
            erase_hardness: P.num("0..100 for the eraser"),
            opacity: P.num("brush opacity 0..100"),
            flow: P.num("brush flow 5..100: below 100 a stroke builds up where it overlaps itself"),
            spacing: P.num("stamp spacing of the active imported tip, in percent of its size (1..200)"),
            follow: P.bool("rotate an imported tip with the stroke direction"),
        },
        async run(ed, a) {
            if (a.tip != null) {
                const want = String(a.tip);
                if (/^round$/i.test(want) || want === "") ed.setBrushTip("");
                else {
                    const t = (ed.brushTips || []).find((x) => x.id === want) || (ed.brushTips || []).find((x) => x.name === want) || (ed.brushTips || []).filter((x) => x.name.toLowerCase().includes(want.toLowerCase()));
                    const hit = Array.isArray(t) ? (t.length === 1 ? t[0] : null) : t;
                    if (!hit) throw new Error(`no brush tip "${want}"${Array.isArray(t) && t.length > 1 ? ` (${t.length} match: ${t.map((x) => x.name).join(", ")})` : ""}`);
                    ed.setBrushTip(hit.id);
                }
            }
            if (a.size != null) { const v = clampInt(a.size, 2, BRUSH_MAX, ed.brushSize); if (ed.setBrushSize && ed.sizeCtl) ed.setBrushSize(v); else ed.brushSize = v; }
            const pct = (v) => Math.max(0, Math.min(1, (+v) / 100));
            if (a.hardness != null && Number.isFinite(+a.hardness)) { ed.hardness = pct(a.hardness); if (ed.tool !== "erase" && ed.hardCtl) { ed.hardCtl.input.value = Math.round(ed.hardness * 100); ed.hardCtl.value.textContent = Math.round(ed.hardness * 100) + "%"; } }
            if (a.erase_hardness != null && Number.isFinite(+a.erase_hardness)) { ed.eraseHardness = pct(a.erase_hardness); if (ed.tool === "erase" && ed.hardCtl) { ed.hardCtl.input.value = Math.round(ed.eraseHardness * 100); ed.hardCtl.value.textContent = Math.round(ed.eraseHardness * 100) + "%"; } }
            if (a.opacity != null && Number.isFinite(+a.opacity)) { ed.brushOpacity = Math.max(0.01, pct(a.opacity)); if (ed.opacCtl) { ed.opacCtl.input.value = Math.round(ed.brushOpacity * 100); ed.opacCtl.value.textContent = Math.round(ed.brushOpacity * 100) + "%"; } }
            if (a.flow != null && Number.isFinite(+a.flow)) { ed.brushFlow = Math.max(0.05, pct(a.flow)); if (ed.flowCtl) { ed.flowCtl.input.value = Math.round(ed.brushFlow * 100); ed.flowCtl.value.textContent = Math.round(ed.brushFlow * 100) + "%"; } }
            if (a.spacing != null && Number.isFinite(+a.spacing)) {
                const t = ed.brushTip();
                if (!t) throw new Error("spacing belongs to an imported tip; pick one first (tip)");
                t.spacing = Math.max(0.01, Math.min(2, (+a.spacing) / 100));
                ed._tipStamp = null;
                ed.syncTipControls();
                ed.brushTipsChanged();
            }
            if (a.follow != null) { ed.tipRotate = !!a.follow; if (ed.tipRotateCb) ed.tipRotateCb.checked = ed.tipRotate; }
            ed.draw();
            return (await COMMANDS.list_brush_tips.run(ed));
        },
    },
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
export function checkParams(filterId, params) {
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
        else if (p.type === "custom") out[k] = v;
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

/** "16:9" plus a long side -> [width, height], both a multiple of 16. */
function sizeForAspect(aspect, longSide) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*[:x\/]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(aspect || ""));
    if (!m) throw new Error(`aspect "${aspect}" is not W:H, e.g. 16:9`);
    const aw = +m[1], ah = +m[2];
    if (!(aw > 0) || !(ah > 0)) throw new Error(`aspect "${aspect}" is not W:H, e.g. 16:9`);
    const round16 = (v) => Math.max(64, Math.round(v / 16) * 16);
    return aw >= ah ? [round16(longSide), round16(longSide * ah / aw)] : [round16(longSide * aw / ah), round16(longSide)];
}

/** @type {CommandCore} */
export const commands = {
    version: VERSION,
    names: () => Object.keys(COMMANDS),
    has: (name) => Object.prototype.hasOwnProperty.call(COMMANDS, name),
    describe,
    /** Run one command. Throws with a readable message on any failure. */
    async run(name, args = {}) {
        const c = COMMANDS[name];
        if (!c) throw new Error(`unknown command "${name}" (${Object.keys(COMMANDS).join(", ")})`);
        const ed = editorFor(name, args);
        if (c.needsImage) requireImage(ed);
        const result = await c.run(ed, args || {});
        return result === undefined ? null : result;
    },
    /** Like run, but never throws: { ok, result } or { ok: false, error }. */
    async call(name, args) {
        try { return { ok: true, result: await this.run(name, args) }; }
        catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
    },
    /** Add a command at runtime (plugins): { description, params, scope, needsImage, run(ed, args) }. */
    register(name, def, owner) {
        if (COMMANDS[name] && !(COMMANDS[name].owner && COMMANDS[name].owner === owner)) throw new Error(`command "${name}" exists`);
        COMMANDS[name] = { ...def, owner };
    },
    unregister(name, owner) {
        if (COMMANDS[name] && COMMANDS[name].owner === owner) delete COMMANDS[name];
    },
};

host.commands = commands;
