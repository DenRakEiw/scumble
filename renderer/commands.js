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
import { viewUrl, loadImageEl, makeCanvas } from "./editor/inpaint_canvas.js";
import { FILTERS } from "./editor/inpaint_filters.js";

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
    return { id: ed.node.id, name: docName(ed), active: host.isActive(ed), width: ed.width || 0, height: ed.height || 0, layers: ed.layers.length, loaded: !!ed.base, busy: busy(ed) };
}

function docName(ed) {
    if (!ed.base || !ed.base.ref) return "Untitled";
    return String(ed.base.ref.filename || "image").replace(/\.[a-z0-9]+$/i, "");
}

function busy(ed) {
    return !!(ed.pending || ed.segmentPending || ed.cutoutPending || ed.upsamplePending || ed.objectsPending || ed._loading || ed.providerPending);
}

export function layerSummary(ed, l) {
    const out = {
        id: l.id, name: l.name, kind: l.kind, role: l.role || "none", visible: !!l.visible, opacity: Math.round((l.opacity == null ? 1 : l.opacity) * 100) / 100,
        blend: l.blend || "normal", x: l.x, y: l.y, w: l.w, h: l.h, locked: !!l.locked, alpha_lock: !!l.alphaLock, mask: !!l.mask,
        active: l.id === ed.activeLayerId,
    };
    if (l.match && l.match.strength > 0) out.match = { strength: l.match.strength, source: l.match.source };
    if (l.kind === "filter") { out.filter = l.filter; out.params = { ...(l.params || {}) }; if (l.lut) out.lut = l.lut.name || true; }
    if (l.kind === "text" && l.text) out.text = { content: l.text.content, font: l.text.font, size: l.text.size, color: l.text.color, bold: !!l.text.bold, italic: !!l.text.italic, align: l.text.align };
    return out;
}

/** A layer by id, exact name, or unique name fragment; "active" / empty = the active layer. */
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
        const type = /\.jpe?g$/i.test(r.name) ? "image/jpeg" : /\.webp$/i.test(r.name) ? "image/webp" : /\.svg$/i.test(r.name) ? "image/svg+xml" : "image/png";
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
        generation: { mode: ed.genSettings.mode, seed: ed.genSettings.seed, seed_random: !!ed.genSettings.seedRandom, denoise: ed.genSettings.denoise },
        crop: { ...ed.cropSettings }, selection: bounds(ed), active_layer: ed.activeLayerId,
        layers: ed.layers.map((l) => layerSummary(ed, l)), results: results.length, history: ed.history.length,
        pending: { segment: !!ed.segmentPending, cutout: !!ed.cutoutPending, upsample: !!ed.upsamplePending, transform: !!ed.pending, objects: !!ed.objectsPending, provider: !!ed.providerPending },
        recipe: r ? { id: r.id, name: r.name || r.id, kind: r.kind || "comfy", provider: r.provider || null } : null,
        connected: !!host.connected, status: ed.status || "",
    };
}

/** What the app is using, in MB: the GPU process and this renderer (docs/PERFORMANCE.md phase 6). */
async function memoryMB() {
    try {
        const m = await window.scumble.metrics();
        let gpuKB = 0;
        for (const p of m.processes || []) if (p.type === "GPU") gpuKB += p.privateKB || p.workingSetKB || 0;
        const r = m.renderer && m.renderer.process;
        return { gpuMB: Math.round(gpuKB / 1024), rendererMB: r ? Math.round((r.private || r.residentSet || 0) / 1024) : 0 };
    } catch (_) {
        return null;
    }
}

// ---- parameter schema helpers ---------------------------------------------------------------

const P = {
    layer: (d, extra = {}) => ({ type: "string", description: d || "the layer: id, name, a unique part of the name, or \"active\"", default: "active", ...extra }),
    timeout: (d) => ({ type: "integer", description: `seconds to wait for the result (default ${d})`, default: d }),
    num: (description, extra = {}) => ({ type: "number", description, ...extra }),
    int: (description, extra = {}) => ({ type: "integer", description, ...extra }),
    str: (description, extra = {}) => ({ type: "string", description, ...extra }),
    bool: (description, extra = {}) => ({ type: "boolean", description, ...extra }),
    obj: (description, extra = {}) => ({ type: "object", description, ...extra }),
};
const FILE_PARAMS = {
    path: P.str("absolute path of a local image file"),
    filename: P.str("instead of path: a file name in the local store / ComfyUI input folder (with subfolder and type)"),
    subfolder: P.str("subfolder of `filename` (default none)"),
    type: P.str("folder type of `filename`: input, output or temp", { enum: ["input", "output", "temp"], default: "input" }),
};

// ---- the commands ----------------------------------------------------------------------------
//
// { description, params, scope?: "app" | "doc" (default doc), needsImage?, run(ed, args) }

const COMMANDS = {
    // -- app --
    ping: {
        scope: "app", description: "Whether the app answers: version, the open documents, the recipe, the connection.",
        params: {},
        async run() { return appInfo(); },
    },
    list_commands: {
        scope: "app", description: "Every command with its parameters (this table).",
        params: {},
        async run() { return { version: VERSION, commands: describe() }; },
    },
    list_documents: {
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
    close_document: {
        description: "Close a tab without asking. The document's files stay in the local store.",
        params: {},
        async run(ed) { const id = ed.node.id; host.shell.closeDocument(ed, { force: true }); return { closed: id, documents: host.editors().map(docSummary) }; },
    },
    list_recipes: {
        scope: "app", description: "The recipes (ComfyUI workflows and API providers) and which one is selected.",
        params: {},
        async run() {
            const cur = host.recipe;
            return { selected: cur ? cur.id : null, provider: cur && cur.kind === "provider" ? cur.provider : null, recipes: host.shell.recipes().map((r) => {
                const v = host.shell.resolveRecipe(r);
                return { id: r.id, name: r.name || r.id, kind: r.kind || "comfy", family: r.family || null, mode: r.mode || (r.kind === "provider" ? "api" : "local"), provider: v.provider || null, providers: r.providerIds || [], model: v.model || null, description: r.description || "", source: r.source || "builtin" };
            }) };
        },
    },
    select_recipe: {
        scope: "app", description: "Select the recipe every tab generates with; model recipes take the provider to run on (gemini, openai, bfl, fal, replicate, wavespeed, comfycloud), else the remembered or default one.",
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
        description: "What the document holds: image size, prompt, generation settings, selection bounds, every layer, pending jobs, the recipe, and what the app is using in memory.",
        params: {},
        async run(ed) { return { ...status(ed), memory: await memoryMB() }; },
    },
    new_canvas: {
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
        description: "Load an image as the base image of this tab (replaces its image, layers and history). From a local path, or by file name from the local store. An SVG is rasterised on the way in: at width x height when given (one of them keeps the aspect), else at its own declared size, else 2048 px on the long side.",
        params: { ...FILE_PARAMS, width: P.int("SVG only: the pixel width to rasterise at"), height: P.int("SVG only: the pixel height to rasterise at") },
        async run(ed, a) {
            if (ed.pending) ed.cancelPending();
            if (ed.textEdit) ed.endTextEdit(false);
            if (a.path) {
                const size = (+a.width > 0 || +a.height > 0) ? [+a.width > 0 ? Math.round(+a.width) : 0, +a.height > 0 ? Math.round(+a.height) : 0] : null;
                await ed.loadFile(await fileFrom(a), { size, ask: false });
                if (!ed.base) throw new Error(ed.status || "the image could not be loaded");
            } else {
                if (!a.filename) throw new Error("pass path or filename");
                const ref = { filename: a.filename, subfolder: a.subfolder || "", type: a.type || "input" };
                const img = await loadImageEl(viewUrl(ref));
                await ed.setBase(ref, img, { keepLayers: false });
            }
            ed.history = []; ed.renderHistory && ed.renderHistory();
            return { width: ed.width, height: ed.height, base: ed.base.ref };
        },
    },
    add_image_layer: {
        needsImage: true,
        description: "Add an image file as a new layer. role \"none\": part of the picture (fitted to the canvas, or placed at x,y with width/height); role \"reference\": a reference image for multi-reference models, not part of the picture. An SVG is rasterised to fit the document first, so it stays sharp.",
        params: { ...FILE_PARAMS, role: P.str("none or reference", { enum: ["none", "reference"], default: "none" }), name: P.str("layer name (default the file name)"), x: P.int("left edge in image pixels"), y: P.int("top edge"), width: P.int("width; without height the aspect is kept"), height: P.int("height") },
        async run(ed, a) {
            const role = a.role === "reference" ? "reference" : "none";
            const before = new Set(ed.layers.map((l) => l.id));
            const at = Number.isFinite(+a.x) && Number.isFinite(+a.y) ? [+a.x, +a.y] : null;
            await ed.addImageLayers([await fileFrom(a)], role, at ? { place: "at", at } : { place: role === "reference" ? "cascade" : "fit" });
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
        params: { x: P.int("left", { required: true }), y: P.int("top", { required: true }), w: P.int("width (alias width)", { required: true }), h: P.int("height (alias height)", { required: true }), mode: P.str("replace, add or subtract", { enum: ["replace", "add", "subtract"], default: "replace" }) },
        async run(ed, a) { ed.applyMaskToSelection(rectMask(ed, +a.x || 0, +a.y || 0, +a.w || +a.width || 0, +a.h || +a.height || 0), a.mode || "replace"); return { selection: bounds(ed) }; },
    },
    select_all: { needsImage: true, description: "Select the whole image.", params: {}, async run(ed) { ed.applyMaskToSelection(rectMask(ed, 0, 0, ed.width, ed.height), "replace"); return { selection: bounds(ed) }; } },
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
        params: { mask: P.obj("array of width*height values, or a base64 PNG string", { required: true }), mode: P.str("replace, add or subtract", { enum: ["replace", "add", "subtract"], default: "replace" }) },
        async run(ed, a) {
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
            ed.applyMaskToSelection(m, a.mode || "replace");
            return { selection: bounds(ed) };
        },
    },
    select_by_text: {
        needsImage: true, description: "Select an object by describing it (\"the car\", \"sky\"). Runs the segmentation model on the connected ComfyUI (SAM3); waits for the mask.",
        params: { text: P.str("what to select", { required: true }), mode: P.str("replace, add or subtract", { enum: ["replace", "add", "subtract"], default: "replace" }), threshold: P.num("0.05..0.95, the model's default when omitted"), timeout: P.timeout(300) },
        async run(ed, a) {
            if (!ed.segInput) throw new Error("the editor has no segmentation controls");
            if (ed.segmentPending) throw new Error("a segmentation is still running");
            const text = String(a.text || "").trim();
            if (!text) throw new Error("text missing, e.g. \"the car\"");
            ed.segInput.value = text;
            ed.segMode = ["replace", "add", "subtract"].includes(a.mode) ? a.mode : "replace";
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
        params: { x: P.num("x of the point"), y: P.num("y of the point"), points: P.obj("instead of x/y: [{x, y, label}] with several points"), box: P.obj("optional [x0, y0, x1, y1] box prompt"), mode: P.str("replace, add or subtract", { enum: ["replace", "add", "subtract"], default: "replace" }) },
        async run(ed, a) {
            if (!host.objectsInApp()) throw new Error("no SAM2 model is downloaded (Settings › Helpers)");
            if (!ed.objects || ed.objects.w !== ed.width || ed.objects.h !== ed.height) {
                await ed.ensureObjects();
                const ok = await until(() => !ed.objectsPending, 600000, 250);
                if (!ok || !ed.objects) throw new Error("object detection did not finish: " + ed.status);
            }
            const pts = Array.isArray(a.points) && a.points.length ? a.points.map((p) => ({ x: +p.x, y: +p.y, label: p.label == null ? 1 : +p.label })) : [{ x: +a.x, y: +a.y, label: 1 }];
            if (pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error("pass x and y, or points");
            const { mask, score } = await host.segmentPoint(ed, pts, Array.isArray(a.box) && a.box.length === 4 ? a.box.map(Number) : null);
            ed.applyMaskToSelection(mask, a.mode || "replace");
            return { selection: bounds(ed), score };
        },
    },

    // -- prompt and generation --
    set_prompt: {
        description: "Set the prompt (and the negative prompt, used by local chains).",
        params: { text: P.str("the prompt"), negative: P.str("the negative prompt") },
        async run(ed, a) {
            if (a.text != null) { ed.promptText = String(a.text); if (ed.promptInput) ed.promptInput.value = ed.promptText; }
            if (a.negative != null) { ed.negativeText = String(a.negative); if (ed.negativeInput) ed.negativeInput.value = ed.negativeText; }
            ed.notifyChanged();
            return { prompt: ed.promptText, negative: ed.negativeText };
        },
    },
    set_generation: {
        description: "Generation settings: mode api / local (the recipe decides what is available), seed, random seed, denoise, refine.",
        params: { mode: P.str("api or local", { enum: ["api", "local"] }), seed: P.int("a fixed seed (turns random off)"), seed_random: P.bool("a new seed per run"), denoise: P.num("0.05..1"), refine: P.bool("refine pass") },
        async run(ed, a) {
            const g = ed.genSettings;
            if (a.mode != null) { if (!["api", "local"].includes(a.mode)) throw new Error("mode must be api or local"); g.mode = a.mode; }
            if (a.seed != null) { g.seed = Math.max(0, Math.floor(+a.seed) || 0); g.seedRandom = false; }
            if (a.seed_random != null) g.seedRandom = !!a.seed_random;
            if (a.denoise != null) g.denoise = Math.min(1, Math.max(0.05, +a.denoise || 1));
            if (a.refine != null) g.refine = !!a.refine;
            if (ed.syncGenControls) ed.syncGenControls();
            ed.renderInfo(); ed.notifyChanged();
            return { mode: g.mode, seed: g.seed, seed_random: !!g.seedRandom, denoise: g.denoise, refine: !!g.refine };
        },
    },
    set_crop: {
        description: "Crop settings for the round trip: context (\"auto\" or pixels), feather (\"auto\" or pixels), fill, colorMatch, extendFill, withOriginal, align, paste.",
        params: { context: P.str("auto or a number of pixels of surroundings"), feather: P.str("auto or pixels"), fill: P.str("fill mode outside the image"), colorMatch: P.str("colour match of the result"), extendFill: P.str("fill for canvas extensions"), withOriginal: P.bool(""), align: P.str(""), paste: P.str("") },
        async run(ed, a) {
            const allowed = ["context", "feather", "fill", "colorMatch", "extendFill", "withOriginal", "align", "paste"];
            for (const [k, v] of Object.entries(a || {})) { if (k === "doc") continue; if (!allowed.includes(k)) throw new Error(`unknown crop setting "${k}" (${allowed.join(", ")})`); ed.cropSettings[k] = v; }
            if (ed.syncCropControls) ed.syncCropControls();
            ed.renderInfo(); ed.notifyChanged();
            return { ...ed.cropSettings };
        },
    },
    set_node_params: {
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
    upsample_prompt: {
        needsImage: true, description: "Let the language model the editor is set to rewrite the prompt with the image in view (a ComfyUI language model node, an API key for OpenAI / Google / Anthropic, or a local OpenAI-compatible server).",
        params: { timeout: P.timeout(300) },
        async run(ed, a) {
            if (ed.upsamplePending) throw new Error("an upsampling is still running");
            const before = ed.promptText;
            await ed.upsamplePrompt();   // an API model answers before this resolves, a ComfyUI helper prompt keeps upsamplePending
            if (!ed.upsamplePending && ed.promptText === before) throw new Error(ed.status);
            const ok = await until(() => !ed.upsamplePending, clampInt(a.timeout, 5, 3600, 300) * 1000);
            if (!ok) throw new Error("upsampling timed out: " + ed.status);
            if (/failed/i.test(ed.status)) throw new Error(ed.status);
            return { prompt: ed.promptText, previous: before, status: ed.status };
        },
    },
    generate_new: {
        description: "Make this tab's base image from the prompt alone, no image needed. A local recipe renders onto a fresh canvas and is flattened into the base; an API recipe calls the model's text-to-image endpoint. Replaces the image, the layers and the history of this tab.",
        params: {
            prompt: P.str("what to make; the tab's current prompt when left out"),
            negative: P.str("negative prompt (local chains only)"),
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
            let w = clampInt(a.width, 64, 8192, 1024), h = clampInt(a.height, 64, 8192, 1024);
            if (a.aspect) {
                const [aw, ah] = sizeForAspect(a.aspect, clampInt(a.resolution, 64, 8192, 1024));
                w = aw; h = ah;
            }
            if (a.prompt != null) { ed.promptText = String(a.prompt); if (ed.promptInput) ed.promptInput.value = ed.promptText; }
            if (a.negative != null) { ed.negativeText = String(a.negative); if (ed.negativeInput) ed.negativeInput.value = ed.negativeText; }
            if (!String(ed.promptText || "").trim()) throw new Error("write a prompt first");
            if (a.seed != null) { ed.genSettings.seed = Math.abs(Math.round(+a.seed)) >>> 0; ed.genSettings.seedRandom = false; if (ed.seedInput) ed.seedInput.value = ed.genSettings.seed; }
            const t0 = Date.now();
            if (r.kind === "provider") {
                const out = await host.runGenerate(ed, { width: w, height: h, aspect: a.aspect || null, prompt: ed.promptText, negative: ed.negativeText, seed: ed.genSettings.seed, background: a.background || null });
                ed.notifyChanged();
                return { mode: "api", provider: out.provider, model: out.model, width: out.width, height: out.height, seconds: out.seconds, transparent: !!out.transparent, status: ed.status };
            }
            if (a.background === "transparent" && r.kind !== "provider") throw new Error("a transparent background is an API model's parameter; this is a local ComfyUI recipe");
            // local: a flat canvas of the wanted size, everything selected, the recipe run,
            // then the result flattened into the base. Nothing of the flat canvas survives.
            await ed.newCanvas(`${w}x${h}`);
            if (ed.width !== w || ed.height !== h) throw new Error(ed.status);
            ed.applyMaskToSelection(rectMask(ed, 0, 0, ed.width, ed.height), "replace");
            const res = await COMMANDS.generate.run(ed, { timeout: a.timeout });
            await ed.flatten();
            ed.notifyChanged();
            return { mode: "local", recipe: r.id, width: ed.width, height: ed.height, seconds: Math.round((Date.now() - t0) / 1000), result: res && res.layer ? res.layer : null, status: ed.status };
        },
    },
    generate: {
        needsImage: true, description: "Generate with the selected recipe: the selected area (with context) goes to the model, the answer comes back as a result layer. Waits for it.",
        params: { timeout: P.timeout(600) },
        async run(ed, a) {
            const n0 = ed.history.length;
            const { wired } = host.resultInputState(ed);
            if (!wired) throw new Error("the recipe has no result output for this mode: select a recipe first");
            await ed.generate();
            if (/^Error|failed/i.test(ed.status)) throw new Error(ed.status);
            const t0 = Date.now(), limit = clampInt(a.timeout, 5, 3600, 600) * 1000;
            const provider = host.recipe && host.recipe.kind === "provider";
            let idleSince = 0;
            while (Date.now() - t0 < limit) {
                await wait(500);
                if (ed.history.length > n0) break;
                if (/^Error|failed/i.test(ed.status || "")) throw new Error(ed.status);
                if (provider) { if (!ed.providerPending) break; continue; }
                // the queue went idle without a result: the run failed elsewhere in the graph
                try {
                    const q = await (await api.fetchApi("/queue")).json();
                    const idle = !(q.queue_running || []).length && !(q.queue_pending || []).length;
                    if (idle && Date.now() - t0 > 3000) { idleSince = idleSince || Date.now(); if (Date.now() - idleSince > 2500) break; } else idleSince = 0;
                } catch (_) { /* ignore */ }
            }
            await until(() => ed.history.length > n0 || /^Error|failed/i.test(ed.status || ""), Math.max(30000, Math.min(limit - (Date.now() - t0), 180000)), 250);
            if (ed.history.length <= n0) throw new Error("no result arrived: " + (ed.status || "the run produced nothing"));
            const h = ed.history[ed.history.length - 1];
            const layer = ed.layers.find((l) => l.id === h.layerId);
            return { layer: layer ? layerSummary(ed, layer) : null, seed: h.seed, mode: h.mode, status: ed.status, seconds: Math.round((Date.now() - t0) / 100) / 10 };
        },
    },

    // -- layers --
    list_layers: { description: "All layers bottom to top with their properties.", params: {}, async run(ed) { return { active: ed.activeLayerId, layers: ed.layers.map((l) => layerSummary(ed, l)) }; } },
    set_active_layer: { description: "Make a layer the active one.", params: { layer: P.layer("the layer: id, name or unique name fragment", { required: true }) }, async run(ed, a) { const l = findLayer(ed, a.layer, { allowActive: false }); ed.activeLayerId = l.id; touch(ed); if (ed.updateSubbar) ed.updateSubbar(); return layerSummary(ed, l); } },
    set_layer: {
        description: "Change a layer: name, visible, opacity (0..1 or percent), blend, locked, alpha_lock, role, colour match (0..100 %, match_source surroundings / below), geometry x y w h, active.",
        params: { layer: P.layer(), name: P.str(""), visible: P.bool(""), opacity: P.num("0..1 (or 0..100)"), blend: P.str("normal, multiply, screen, overlay, ..."), locked: P.bool(""), alpha_lock: P.bool(""), role: P.str("none, reference or control", { enum: ["none", "reference", "control"] }), match: P.num("colour match strength 0..100"), match_source: P.str("surroundings or below", { enum: ["surroundings", "below"] }), x: P.int(""), y: P.int(""), w: P.int("width (alias width); without h the aspect is kept"), h: P.int("height (alias height)"), active: P.bool("also make it the active layer") },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (a.name != null) l.name = String(a.name);
            if (a.visible != null) l.visible = !!a.visible;
            if (a.opacity != null) l.opacity = Math.min(1, Math.max(0, +a.opacity > 1 ? +a.opacity / 100 : +a.opacity));
            if (a.blend != null) l.blend = String(a.blend);
            if (a.locked != null) l.locked = !!a.locked;
            if (a.alpha_lock != null) l.alphaLock = !!a.alpha_lock;
            if (a.role != null) {
                if (!["none", "reference", "control"].includes(a.role)) throw new Error("role must be none, reference or control");
                l.role = a.role; l.exportRef = null;
            }
            if (a.match != null || a.match_source != null) {
                if (l.kind === "filter") throw new Error("filter layers have no colour match");
                l.match = l.match || { strength: 0, source: "surroundings" };
                if (a.match != null) { const m = +a.match; l.match.strength = Math.min(100, Math.max(0, Math.round(m > 0 && m < 1 ? m * 100 : m))); }
                if (a.match_source != null) { if (!["surroundings", "below"].includes(a.match_source)) throw new Error("match_source must be surroundings or below"); l.match.source = a.match_source; }
                ed.markMatchChanged(l);
            }
            const geo = ["x", "y", "w", "h"].some((k) => a[k] != null) || a.width != null || a.height != null;
            if (geo) {
                if (l.kind === "filter") throw new Error("filter layers cover the whole canvas");
                ed.pushUndo({ kind: "transform", id: l.id });
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
    remove_layer: { description: "Delete a layer.", params: { layer: P.layer("", { required: true }) }, async run(ed, a) { const l = findLayer(ed, a.layer); ed.removeLayer(l.id); return { removed: l.id, layers: ed.layers.length }; } },
    duplicate_layer: { description: "Duplicate a layer (the copy sits above it).", params: { layer: P.layer() }, async run(ed, a) { const l = findLayer(ed, a.layer); const c = ed.duplicateLayer(l); if (!c) throw new Error(ed.status); return layerSummary(ed, c); } },
    merge_down: { description: "Merge a layer into the one below it (into the base image if it is the lowest).", params: { layer: P.layer() }, async run(ed, a) { const l = findLayer(ed, a.layer); const n = ed.layers.length; await ed.mergeDown(l); if (ed.layers.length === n && ed.layers.includes(l)) throw new Error(ed.status); return { layers: ed.layers.map((x) => layerSummary(ed, x)), status: ed.status }; } },
    move_layer: {
        description: "Reorder a layer: to = up, down, top, bottom, or delta = ±n.",
        params: { layer: P.layer("", { required: true }), to: P.str("up, down, top or bottom", { enum: ["up", "down", "top", "bottom"] }), delta: P.int("steps up (positive) or down") },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            const i = ed.layers.indexOf(l);
            let delta = 0;
            if (a.to === "top") delta = ed.layers.length - 1 - i; else if (a.to === "bottom") delta = -i;
            else if (a.to === "up") delta = 1; else if (a.to === "down") delta = -1; else delta = Math.round(+a.delta || 0);
            if (delta) ed.moveLayer(l.id, delta, { undo: true });
            return { index: ed.layers.indexOf(l), layers: ed.layers.map((x) => x.name) };
        },
    },
    flip_layer: { description: "Mirror a layer horizontally (axis x) or vertically (axis y).", params: { layer: P.layer(), axis: P.str("x or y", { enum: ["x", "y"], default: "x" }) }, async run(ed, a) { const l = findLayer(ed, a.layer); ed.activeLayerId = l.id; ed.flipLayer(a.axis === "y" || a.axis === "vertical" ? "y" : "x"); return layerSummary(ed, l); } },
    center_layer: { description: "Centre a layer on the canvas.", params: { layer: P.layer() }, async run(ed, a) { const l = findLayer(ed, a.layer); ed.activeLayerId = l.id; ed.centerLayer(); return layerSummary(ed, l); } },
    flatten: { needsImage: true, description: "Flatten all visible layers into the base image.", params: {}, async run(ed) { await ed.flatten(); return { layers: ed.layers.length, status: ed.status }; } },
    cutout_layer: {
        description: "Remove the background of a layer with the cutout model the editor is set to (in-app when a matting model is downloaded); the mask becomes the layer's transparency.",
        params: { layer: P.layer(), timeout: P.timeout(300) },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (ed.cutoutPending) throw new Error("a background removal is still running");
            await ed.cutoutLayer(l);
            if (!ed.cutoutPending) throw new Error(ed.status);
            const ok = await until(() => !ed.cutoutPending, clampInt(a.timeout, 5, 3600, 300) * 1000);
            if (!ok) throw new Error("background removal timed out: " + ed.status);
            if (/failed/i.test(ed.status)) throw new Error(ed.status);
            return layerSummary(ed, l);
        },
    },

    // -- filters --
    filter_types: {
        scope: "app", description: "The filter layer types (built-in and from plugins) with their parameters.",
        params: {},
        async run() { return { filters: Object.entries(FILTERS).map(([id, f]) => ({ id, label: f.label, plugin: f.plugin || null, params: (f.params || []).map((p) => ({ key: p.key, label: p.label, type: p.type || "number", min: p.min, max: p.max, default: p.type === "custom" ? undefined : p.default, options: p.options ? p.options.map((o) => (o.id != null ? o.id : o)) : undefined })) })) }; },
    },
    add_filter: {
        needsImage: true, description: "Add a non-destructive filter layer on top of the stack (see filter_types for types and params).",
        params: { type: P.str("filter type id", { default: "grain" }), params: P.obj("parameter values {key: value}"), name: P.str("layer name") },
        async run(ed, a) {
            const type = String(a.type || "grain");
            if (!FILTERS[type]) throw new Error(`unknown filter "${type}" (${Object.keys(FILTERS).join(", ")})`);
            const l = ed.addFilterLayer(type);
            if (!l) throw new Error(ed.status);
            if (a.name) l.name = String(a.name);
            if (a.params) applyParams(ed, l, a.params);
            touch(ed);
            return layerSummary(ed, l);
        },
    },
    set_filter: {
        description: "Change a filter layer's parameters (or its type).",
        params: { layer: P.layer("", { required: true }), type: P.str("new filter type id"), params: P.obj("parameter values {key: value}") },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (l.kind !== "filter") throw new Error(`${l.name} is not a filter layer`);
            if (a.type && a.type !== l.filter) ed.setFilterType(l, String(a.type));
            if (a.params) applyParams(ed, l, a.params);
            touch(ed);
            return layerSummary(ed, l);
        },
    },

    // -- text --
    add_text: {
        needsImage: true, description: "Add a text layer at x,y (top left of the text). Bundled fonts: Roboto, Open Sans, Montserrat, Playfair Display, Lobster, Oswald, Pacifico, Bebas Neue and more (see the editor's font list).",
        params: { text: P.str("the text", { required: true }), x: P.num("left (default 10 % of the width)"), y: P.num("top"), size: P.int("font size in pixels"), font: P.str("font family"), color: P.str("CSS colour"), bold: P.bool(""), italic: P.bool(""), align: P.str("left, center or right"), outline: P.num("outline width"), outline_color: P.str(""), name: P.str("layer name") },
        async run(ed, a) {
            const l = await ed.addTextLayer(a.x != null ? +a.x : ed.width * 0.1, a.y != null ? +a.y : ed.height * 0.1);
            if (!l) throw new Error(ed.status);
            const t = l.text;
            if (a.text != null) t.content = String(a.text);
            if (a.font != null) t.font = String(a.font);
            if (a.size != null) t.size = Math.max(4, Math.round(+a.size));
            if (a.color != null) t.color = String(a.color);
            if (a.bold != null) t.bold = !!a.bold;
            if (a.italic != null) t.italic = !!a.italic;
            if (a.align != null) t.align = String(a.align);
            if (a.outline != null) t.outline = Math.max(0, +a.outline);
            if (a.outline_color != null) t.outlineColor = String(a.outline_color);
            if (a.name) l.name = String(a.name);
            await ed.renderTextLayer(l, { keepScale: false });
            if (ed.textEdit) ed.endTextEdit(true);
            try { document.activeElement && document.activeElement.blur(); } catch (_) { /* ignore */ }
            touch(ed);
            return layerSummary(ed, l);
        },
    },
    set_text: {
        description: "Change a text layer's content or style.",
        params: { layer: P.layer("", { required: true }), text: P.str(""), font: P.str(""), size: P.int(""), color: P.str(""), bold: P.bool(""), italic: P.bool(""), align: P.str(""), outline: P.num(""), outline_color: P.str("") },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (l.kind !== "text") throw new Error(`${l.name} is not a text layer`);
            const t = l.text;
            for (const [k, tk] of [["text", "content"], ["font", "font"], ["color", "color"], ["align", "align"], ["outline_color", "outlineColor"]]) if (a[k] != null) t[tk] = String(a[k]);
            if (a.size != null) t.size = Math.max(4, Math.round(+a.size));
            if (a.bold != null) t.bold = !!a.bold;
            if (a.italic != null) t.italic = !!a.italic;
            if (a.outline != null) t.outline = Math.max(0, +a.outline);
            await ed.renderTextLayer(l, { keepScale: true });
            touch(ed);
            return layerSummary(ed, l);
        },
    },

    // -- history, canvas --
    undo: { description: "Undo the last step.", params: {}, async run(ed) { await ed.undoStep(); return { undo: ed.undo.length, redo: ed.redo.length, status: ed.status }; } },
    redo: { description: "Redo the last undone step.", params: {}, async run(ed) { await ed.redoStep(); return { undo: ed.undo.length, redo: ed.redo.length, status: ed.status }; } },
    compare: { description: "Toggle the before / after split view.", params: { enabled: P.bool("on or off; toggles when omitted") }, async run(ed, a) { const want = a.enabled == null ? !ed.compare : !!a.enabled; if (want !== !!ed.compare) ed.toggleCompare(); return { compare: !!ed.compare, status: ed.status }; } },
    extend_canvas: {
        needsImage: true, description: "Extend (positive) or crop (negative) the canvas on each side, in pixels.",
        params: { left: P.int("", { default: 0 }), top: P.int("", { default: 0 }), right: P.int("", { default: 0 }), bottom: P.int("", { default: 0 }) },
        async run(ed, a) {
            const v = { left: Math.round(+a.left || 0), top: Math.round(+a.top || 0), right: Math.round(+a.right || 0), bottom: Math.round(+a.bottom || 0) };
            if (Object.values(v).some((x) => x < 0)) { await ed.cropCanvas(v); v.left = Math.max(0, v.left); v.top = Math.max(0, v.top); v.right = Math.max(0, v.right); v.bottom = Math.max(0, v.bottom); }
            if (Object.values(v).some((x) => x > 0)) await ed.extendCanvas(v);
            return { width: ed.width, height: ed.height, status: ed.status };
        },
    },

    // -- export --
    export: {
        needsImage: true, description: "Save the flattened image (png, jpg, webp, psd or ora with layers). With `path` no dialog is shown. `scale`, `width` and `height` save it smaller or bigger; PSD and ORA always keep the full size.",
        params: { format: P.str("png, jpg, webp, psd or ora", { enum: ["png", "jpg", "webp", "psd", "ora"], default: "png" }), name: P.str("file name stem for the dialog"), path: P.str("absolute target path (no dialog)"), scale: P.num("percent of the document size, 1..400"), width: P.int("width in pixels (the height follows the aspect ratio)"), height: P.int("height in pixels (the width follows the aspect ratio)"), quality: P.num("JPEG / WebP quality 0.1..1", { default: 0.92 }) },
        async run(ed, a) {
            const fmt = ["png", "jpg", "webp", "psd", "ora"].includes(a.format) ? a.format : "png";
            if (ed.saveFormatSel) ed.saveFormatSel.value = fmt;
            if (ed.saveNameInput) ed.saveNameInput.value = String(a.name || docName(ed) || "scumble");
            const before = { ...host.exportState(ed) };
            if (a.width != null || a.height != null) host.setExportSize(ed, { width: a.width, height: a.height, quality: a.quality });
            else if (a.scale != null) host.setExportSize(ed, { percent: a.scale, quality: a.quality });
            else if (a.quality != null) host.setExportSize(ed, { quality: a.quality });
            const saved = await withExportPath(a.path, () => ed.exportImage({ download: false }))
                .finally(() => { ed._export = before; host.syncExportRow(ed); });
            if (!saved) throw new Error(ed.status);
            return { file: saved, status: ed.status };
        },
    },
    export_layer: {
        description: "Save one layer as a PNG with transparency.",
        params: { layer: P.layer(), path: P.str("absolute target path (no dialog)") },
        async run(ed, a) { const l = findLayer(ed, a.layer); ed.activeLayerId = l.id; const saved = await withExportPath(a.path, () => ed.exportLayerPng()); if (!saved) throw new Error(ed.status); return { file: saved, status: ed.status }; },
    },
    export_mask: {
        needsImage: true, description: "Save the selection as a black and white mask PNG.",
        params: { path: P.str("absolute target path (no dialog)") },
        async run(ed, a) { const saved = await withExportPath(a.path, () => ed.exportMaskPng()); if (!saved) throw new Error(ed.status); return { file: saved, status: ed.status }; },
    },
    screenshot: {
        needsImage: true, description: "A JPEG of the image (what = image: the flattened picture; editor: with hidden helpers; layer: one layer alone), base64 in `data`.",
        params: { what: P.str("image, editor or layer", { enum: ["image", "editor", "layer"], default: "image" }), layer: P.layer("for what = layer"), max_size: P.int("long side in pixels (64..4096)", { default: 1024 }), quality: P.num("JPEG quality 0.3..0.95", { default: 0.85 }), show_selection: P.bool("tint and outline the selection", { default: true }), show_layers: P.bool("outline and label the layers", { default: false }) },
        async run(ed, a) {
            const max = clampInt(a.max_size, 64, 4096, 1024);
            const src = a.what === "layer" ? (() => { const l = findLayer(ed, a.layer); return { canvas: l.canvas, w: l.canvas.width, h: l.canvas.height }; })() : { canvas: ed.flattenToCanvas({ forRun: a.what !== "editor" }), w: ed.width, h: ed.height };
            const s = Math.min(1, max / Math.max(src.w, src.h));
            const w = Math.max(1, Math.round(src.w * s)), h = Math.max(1, Math.round(src.h * s));
            const c = makeCanvas(w, h);
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#202020"; ctx.fillRect(0, 0, w, h);
            ctx.drawImage(src.canvas, 0, 0, w, h);
            const b = bounds(ed);
            if (a.show_selection !== false && b && ed.selection && a.what !== "layer") {
                ctx.globalAlpha = 0.35; ctx.drawImage(ed.selection, 0, 0, w, h); ctx.globalAlpha = 1;
                ctx.strokeStyle = "#ff40ff"; ctx.lineWidth = 2; ctx.strokeRect(b.x * s, b.y * s, b.w * s, b.h * s);
            }
            if (a.show_layers && a.what !== "layer") {
                ctx.strokeStyle = "#7cc7ff"; ctx.lineWidth = 1; ctx.font = "12px sans-serif"; ctx.fillStyle = "#7cc7ff";
                for (const l of ed.layers) { if (l.kind === "filter" || !l.visible) continue; ctx.strokeRect(l.x * s, l.y * s, l.w * s, l.h * s); ctx.fillText(l.name, l.x * s + 3, l.y * s + 13); }
            }
            const url = c.toDataURL("image/jpeg", Math.min(0.95, Math.max(0.3, +a.quality || 0.85)));
            return { width: w, height: h, scale: s, image_width: src.w, image_height: src.h, mime: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
        },
    },
    get_state: { description: "The document's state JSON (the node's canvas_state without the selection bitmaps).", params: {}, async run(ed) { const v = JSON.parse(ed.getValue() || "{}"); delete v.selection; delete v.selections; return v; } },
    set_status: { description: "Write a line into the document's status bar.", params: { text: P.str("", { required: true }) }, async run(ed, a) { ed.setStatus(String(a.text)); return { status: ed.status }; } },

    // -- brush --
    list_brush_tips: {
        description: "The brush tips available under Tip: the built-in round dab and the imported ones (from Photoshop .abr files or images), with the active one and the brush settings of this document.",
        params: {},
        async run(ed) {
            const tips = [{ id: "round", name: "Round", builtIn: true }, ...(ed.brushTips || []).map((t) => ({ id: t.id, name: t.name, width: t.canvas.width, height: t.canvas.height, spacing: t.spacing || 0, source: t.source || "" }))];
            return { active: ed.brushTipId || "round", size: ed.brushSize, hardness: Math.round((ed.hardness || 0) * 100), eraseHardness: Math.round((ed.eraseHardness || 0) * 100), opacity: Math.round((ed.brushOpacity == null ? 1 : ed.brushOpacity) * 100), follow: !!ed.tipRotate, tips };
        },
    },
    set_brush: {
        description: "Brush settings of this document: the tip (round, or an imported tip by id or name), size in pixels, hardness and opacity in percent, the tip's spacing in percent of its size, and whether the tip follows the stroke direction. Every parameter is optional.",
        params: {
            tip: P.str("round, or the id or name of an imported tip (list_brush_tips)"),
            size: P.int("brush size in image pixels (2..400)"),
            hardness: P.num("0..100 for the paint brush (the eraser keeps its own, see erase_hardness)"),
            erase_hardness: P.num("0..100 for the eraser"),
            opacity: P.num("brush opacity 0..100"),
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
            if (a.size != null) { ed.brushSize = clampInt(a.size, 2, 400, ed.brushSize); if (ed.sizeCtl) { ed.sizeCtl.input.value = ed.brushSize; ed.sizeCtl.value.textContent = ed.brushSize + "px"; } }
            const pct = (v) => Math.max(0, Math.min(1, (+v) / 100));
            if (a.hardness != null && Number.isFinite(+a.hardness)) { ed.hardness = pct(a.hardness); if (ed.tool !== "erase" && ed.hardCtl) { ed.hardCtl.input.value = Math.round(ed.hardness * 100); ed.hardCtl.value.textContent = Math.round(ed.hardness * 100) + "%"; } }
            if (a.erase_hardness != null && Number.isFinite(+a.erase_hardness)) { ed.eraseHardness = pct(a.erase_hardness); if (ed.tool === "erase" && ed.hardCtl) { ed.hardCtl.input.value = Math.round(ed.eraseHardness * 100); ed.hardCtl.value.textContent = Math.round(ed.eraseHardness * 100) + "%"; } }
            if (a.opacity != null && Number.isFinite(+a.opacity)) { ed.brushOpacity = Math.max(0.01, pct(a.opacity)); if (ed.opacCtl) { ed.opacCtl.input.value = Math.round(ed.brushOpacity * 100); ed.opacCtl.value.textContent = Math.round(ed.brushOpacity * 100) + "%"; } }
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

function applyParams(ed, l, params) {
    const spec = FILTERS[l.filter].params || [];
    for (const [k, v] of Object.entries(params)) {
        const p = spec.find((x) => x.key === k);
        if (!p) throw new Error(`filter "${l.filter}" has no parameter "${k}" (${spec.map((x) => x.key).join(", ")})`);
        if (p.type === "select") {
            const ids = (p.options || []).map((o) => (o.id != null ? o.id : o));
            if (!ids.includes(v)) throw new Error(`"${v}" is not an option of ${k} (${ids.join(", ")})`);
            l.params[k] = v;
        }
        else if (p.type === "bool") l.params[k] = !!v;
        else if (p.type === "custom") l.params[k] = v;
        else l.params[k] = Math.min(p.max, Math.max(p.min, +v));
    }
    ed.markFilterChanged(l);
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

/** The command table as data: [{name, description, scope, params: {name: {type, description, default, required, enum}}}]. */
export function describe() {
    return Object.entries(COMMANDS).map(([name, c]) => ({
        name, description: c.description, scope: c.scope || "doc", needsImage: !!c.needsImage, plugin: c.owner || null,
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
