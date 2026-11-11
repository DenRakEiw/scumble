// Split into layers (Seedream's layer decomposition: Seedream 5.5 and 5.0 pro on BytePlus ModelArk, Seedream 5.5 on
// WaveSpeedAI and Oxen.ai too): the visible picture or one layer goes out as the one input, and the answer (a base
// picture and the model's layers, each a PNG with alpha, with a box in the base's pixels where the host gives one, a
// stacking order and a name) lands as new layers above everything that is there, in one group, as one undo step.
// docs/RECIPES.md "Split into layers".
//
// Which host runs it: the recipe's chosen provider (the user's pick, what resolveRecipe takes without a forced host)
// when its variant declares `options.layers`, else ModelArk when its variant does; never a host without a layer mode.
//
// The rules a person cares about: the layers already in the document are not touched; the new layers sit at the top; each
// one is placed from its box scaled to the document and is baked to that size, so it is a layer at its own size on whole
// pixels (the retouch tools paint into those only); the model's answer is at most about 2K, so a larger picture gets
// layers scaled up, which the status line says. Everything that can fail (the run, a picture that does not decode) comes
// before the undo step: a failure leaves the document as it was.
//
// Only the app calls this (the node's host has no API providers). `app` below is the host object, passed in; the helpers that
// are private to it come in `deps`. Plain data going in and out of the pure functions, so tools/ark_test.js imports them
// in Node.

import { refusal, failKind } from "./inpaint_status.js";

export const SPLIT_LABEL = "Split into layers";
/** The sizes a split takes: a tier only. auto: about the input's own size, within the model's 1K to 2K. */
export const SPLIT_TIERS = ["auto", "1K", "1.5K", "2K"];
/** What the dialog and the command ask for when nothing says otherwise. */
export const SPLIT_COUNT_DEFAULT = 16;

const MIN_PIXELS = 512 * 512;
const MAX_PIXELS = 6000 * 6000;
const MIN_EDGE = 15;
const MAX_RATIO = 16;
const NAME_MAX = 60;
const RUN_GOING = "A run is still going on this document: wait for it, or Cancel.";

/** "" when a w x h picture may go, else the refusal (the same as ark.js layerSizeRefusal; tools/ark_test.js holds them together). */
export function splitSizeRefusal(w, h, model) {
    const pixels = w * h;
    if (Math.min(w, h) >= MIN_EDGE && pixels >= MIN_PIXELS && pixels <= MAX_PIXELS && Math.max(w, h) <= MAX_RATIO * Math.min(w, h)) return "";
    return `The picture is ${w} × ${h} (${(pixels / 1e6).toFixed(2)} megapixels): ${model} splits pictures of 512 × 512 to 6000 × 6000 in area, no steeper than 16:1.`;
}

/** The host a split falls back to when the chosen one has no layer mode. */
export const SPLIT_FALLBACK = "ark";

/**
 * A provider variant's layer mode, or null: { max (layers besides the base), options (the count and Text recognition,
 * ModelArk's shape), count, text (each on its own, defaulting to `options`), tiers (false: the host takes no size),
 * price (the dialog's words) }. electron/main/providers/layersplit.js specOf reads the same.
 */
function variantSpec(v) {
    const s = v && v.options && v.options.layers;
    if (!s || typeof s !== "object" || !(+s.max > 0)) return null;
    const options = !!s.options;
    return { max: Math.floor(+s.max), options, count: s.count != null ? !!s.count : options, text: s.text != null ? !!s.text : options, tiers: s.tiers !== false, price: typeof s.price === "string" ? s.price : "" };
}

/**
 * The provider a split of `recipe` runs on: `chosen` (the recipe's chosen provider; left out: its `default`) when that
 * variant has a layer mode, else ModelArk when its variant has one, else null.
 */
export function splitProviderOf(recipe, chosen) {
    const ps = recipe && recipe.providers;
    if (!ps) return null;
    const pid = chosen === undefined ? recipe.default : chosen;
    if (pid && Object.prototype.hasOwnProperty.call(ps, pid) && variantSpec(ps[pid])) return pid;
    return variantSpec(ps[SPLIT_FALLBACK]) ? SPLIT_FALLBACK : null;
}

/** A recipe's layer mode on the host a split takes (splitProviderOf) as { provider, ...variantSpec }, or null. */
export function layerSpecOf(recipe, chosen) {
    const pid = splitProviderOf(recipe, chosen);
    return pid ? { provider: pid, ...variantSpec(recipe.providers[pid]) } : null;
}

/** The recipes that can split, the most layers first (Seedream 5.5 before 5.0 pro). `chosenOf(raw)`: each one's chosen provider (left out: its default). */
export function layerRecipes(recipes, chosenOf) {
    const spec = (r) => layerSpecOf(r, chosenOf ? chosenOf(r) : undefined);
    return (recipes || []).filter((r) => spec(r)).sort((a, b) => spec(b).max - spec(a).max);
}

/** The chosen provider of a raw recipe as the shell resolves it (the user's pick, else its default). */
export const chosenIn = (app) => (raw) => { const r = app.shell.resolveRecipe(raw); return r && r.provider ? r.provider : undefined; };

/** A layer's name from the model's: control characters out, one line, a sane length, not one already used (case aside). */
export function cleanLayerName(raw, fallback, taken) {
    const plain = Array.from(String(raw == null ? "" : raw), (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("");
    const stem = plain.replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim() || fallback;
    let name = stem;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} ${n}`;
    taken.add(name.toLowerCase());
    return name;
}

/**
 * An answer's box [left, top, right, bottom] in the base's pixels: `absolute`, else `normalized` (0..1000), else null. A box
 * that only partly lies on the base stays whole (the layer overhangs: clamping it would squeeze the picture into the
 * rest); one that misses the base is no box.
 */
export function boxOf(box, bw, bh) {
    const valid = (b) => Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(n));
    const inside = (b) => (b[2] > b[0] && b[3] > b[1] && b[0] < bw && b[1] < bh && b[2] > 0 && b[3] > 0 ? b : null);
    let got = null;
    if (box && valid(box.absolute)) got = inside(box.absolute);
    if (!got && box && valid(box.normalized)) got = inside([box.normalized[0] * bw / 1000, box.normalized[1] * bh / 1000, box.normalized[2] * bw / 1000, box.normalized[3] * bh / 1000]);
    return got;
}

/**
 * Where an answer lands. `entries` as the adapter returns them (the base first, then bottom to top), `rect` the source
 * in document pixels, `bw` x `bh` the base's size, `taken` the names in use (a Set of lower-case names; the new ones join
 * it). A layer's edges are its box's rounded, so two boxes that meet still meet. A layer the host gave no position
 * (`full`: WaveSpeed's and Oxen's docs name none) covers the whole source, as the base does. -> { rows: [{ entry, name,
 * x, y, w, h }] bottom to top, leftOut: the names of the layers without a usable box, whole: the names of the `full` ones }.
 */
export function planLanding(entries, rect, bw, bh, taken) {
    const sx = rect.w / bw, sy = rect.h / bh;
    const rows = [], leftOut = [], whole = [];
    entries.forEach((entry, i) => {
        const name = cleanLayerName(entry.name, entry.base ? "Base" : `Layer ${i}`, taken);
        if (entry.base || entry.full) {
            if (!entry.base) whole.push(name);
            rows.push({ entry, name, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
            return;
        }
        const b = boxOf(entry.bounding_box, bw, bh);
        if (!b) { leftOut.push(name); return; }
        const x = Math.round(b[0] * sx), y = Math.round(b[1] * sy);
        rows.push({ entry, name, x: rect.x + x, y: rect.y + y, w: Math.max(1, Math.round(b[2] * sx) - x), h: Math.max(1, Math.round(b[3] * sy) - y) });
    });
    return { rows, leftOut, whole };
}

/**
 * The recipe a split runs: `id`, else the selected one if it can, else the first that can; on the host splitProviderOf
 * picks for it (the chosen provider when it has a layer mode, else ModelArk). Throws a plain refusal.
 */
function modelFor(app, id) {
    const all = app.shell.recipes();
    const chosen = chosenIn(app);
    const can = (raw) => !!(raw && layerSpecOf(raw, chosen(raw)));
    let raw = null;
    if (id) {
        raw = all.find((x) => x.id === id);
        if (!raw) throw refusal(`There is no recipe "${id}".`);
        if (!can(raw)) throw refusal(`${raw.name || raw.id} has no layer mode: ${layerRecipes(all, chosen).map((r) => r.name || r.id).join(" and ")} can split a picture.`, "warn");
    } else {
        const selected = app.recipe && all.find((x) => x.id === app.recipe.id);
        raw = can(selected) ? selected : layerRecipes(all, chosen)[0];
        if (!raw) throw refusal("No recipe here has a layer mode.", "warn");
    }
    const spec = layerSpecOf(raw, chosen(raw));
    return { raw, r: app.shell.resolveRecipe(raw, spec.provider), spec };
}

/** A layer that can be split, or a plain refusal. */
function sourceLayer(layer) {
    if (layer.kind === "filter") throw refusal("Filter layers have no pixels: pick a paint or image layer, or split the picture.");
    if (!layer.px) throw refusal(`${layer.name} has no pixels to split.`);
    return layer;
}

/**
 * What a split asks for, with every refusal that needs nothing read: the model and its key, the source's size, the run
 * slot, the count, the tier. `opts` { recipe, layer (null: the visible picture), prompt, count, textRecognition, size }.
 * -> { model, r, spec, layer, rect, tier, count, textRecognition, prompt } (the dialog asks it too, for its first line).
 */
export function splitJob(app, editor, opts = {}) {
    if (!editor.base) throw refusal("Load an image first.");
    if (editor.providerPending) throw refusal(RUN_GOING);
    if (editor._eachArea) throw refusal("Each area is running on this document: wait for it, or stop it.");
    const { r, spec } = modelFor(app, opts.recipe || "");
    const model = r.name || r.id;
    const ks = app.shell.keyState(r);
    if (ks && !ks.ok) throw refusal(`${SPLIT_LABEL} cannot run on ${r.providerLabel || r.provider}: ${ks.text}.`, "warn");
    const layer = opts.layer ? sourceLayer(opts.layer) : null;
    const rect = layer
        ? { x: Math.round(layer.x), y: Math.round(layer.y), w: Math.max(1, Math.round(layer.w)), h: Math.max(1, Math.round(layer.h)) }
        : { x: 0, y: 0, w: editor.width, h: editor.height };
    const no = splitSizeRefusal(rect.w, rect.h, model);
    if (no) throw refusal(no, "warn");
    const label = r.providerLabel || r.provider;
    const tier = opts.size == null || opts.size === "" ? "auto" : String(opts.size);
    if (!SPLIT_TIERS.includes(tier)) throw refusal(`The size of a split is a tier (${SPLIT_TIERS.join(", ")}), not "${opts.size}".`);
    if (!spec.tiers && tier !== "auto") throw refusal(`${model} on ${label} takes no size for a split: it answers at its own size (Size Auto).`);
    let count = null;
    if (spec.count) {
        const n = opts.count == null || opts.count === "" ? Math.min(SPLIT_COUNT_DEFAULT, spec.max) : +opts.count;
        if (!Number.isInteger(n) || n < 1 || n > spec.max) throw refusal(`${model} splits a picture into 1 to ${spec.max} layers, not ${opts.count}.`);
        count = n;
    } else if (opts.count != null && opts.count !== "" && +opts.count !== spec.max) {
        throw refusal(`${model} finds its own number of layers, up to ${spec.max}: it takes no count.`);
    }
    if (opts.textRecognition && !spec.text) throw refusal(`${model} on ${label} has no Text recognition switch for a split.`);
    return { model, r, spec, layer, rect, tier, count, textRecognition: !!opts.textRecognition && spec.text, prompt: String(opts.prompt == null ? "" : opts.prompt).trim() };
}

/** The source's pixels as PNG bytes: the visible picture, or the layer at its size in the document with its transparency and mask. */
async function sourceBytes(editor, job, canvasBytes) {
    if (!job.layer) {
        // a paid request of the picture as it is: relight's full shadow maps first, as every other reader of a run's picture
        if (editor.relightSettled) await editor.relightSettled();
        return canvasBytes(editor.flattenToCanvas({ forRun: true }));
    }
    const c = document.createElement("canvas");
    c.width = job.rect.w;
    c.height = job.rect.h;
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = "high";
    x.drawImage(editor.layerPixels(job.layer), 0, 0, job.rect.w, job.rect.h);
    const bytes = await canvasBytes(c);
    c.width = c.height = 0;
    return bytes;
}

/** A row's pixels at its size in the document and the PNG that stores them: the answer's own bytes when no scale was needed. */
async function readyRow(editor, row, bytes, img, deps) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (iw === row.w && ih === row.h) {
        const png = row.entry.mime === "image/png" ? bytes : await deps.canvasBytes(canvasOf(img, iw, ih));
        return { px: editor.pixels.Layer.fromImage(img), png };
    }
    const c = canvasOf(img, row.w, row.h);
    return { px: editor.pixels.Layer.fromCanvas(c), png: await deps.canvasBytes(c) };   // the canvas backend's layer keeps `c`
}

function canvasOf(img, w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = "high";
    x.drawImage(img, 0, 0, w, h);
    return c;
}

/** Everything of the answer made and stored, the document not touched yet. -> { rows: [{ row, px, ref }], leftOut, base: [w, h] } or null (the tab was closed). */
async function prepare(app, editor, res, job, gone, deps) {
    const entries = res.layers || [];
    if (!entries.length) throw new Error("the answer holds no pictures");
    const take = (e) => window.scumble.providers.layerPart(res.layersToken, e.part);
    const firstBytes = await take(entries[0]);
    const firstImg = await deps.bytesToImage(firstBytes, entries[0].mime);
    const bw = firstImg.naturalWidth || firstImg.width, bh = firstImg.naturalHeight || firstImg.height;
    if (!(bw > 0 && bh > 0)) throw new Error("the answer's base picture is empty");
    const taken = new Set(editor.layers.map((l) => String(l.name).toLowerCase()));
    const { rows, leftOut, whole } = planLanding(entries, job.rect, bw, bh, taken);
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
    const made = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const bytes = row.entry === entries[0] ? firstBytes : await take(row.entry);
        if (gone()) return null;
        const img = row.entry === entries[0] ? firstImg : await deps.bytesToImage(bytes, row.entry.mime);
        const { px, png } = await readyRow(editor, row, bytes, img, deps);
        // stored as a result is, so a save holds the layer; when the mirror fails, an unsaved layer, which a save uploads
        let ref = null;
        try { ref = await app.uploadResult(new Blob([png], { type: "image/png" }), `n${editor.node.id}_split_${stamp}_${i}.png`); }
        catch (err) { console.warn("a split layer stays unsaved until the next save", err); }
        if (gone()) return null;
        made.push({ row, px, ref });
    }
    return { rows: made, leftOut, whole, base: [bw, bh] };
}

/**
 * The prepared layers into the document, above everything, in one new group, as one undo step. A transform the user has
 * going on one of their own layers stays: the new layers do not become the selection while it does.
 */
function land(editor, ready, job, groupName) {
    editor.pushUndo({ kind: "layers", label: SPLIT_LABEL });
    editor.groupCounter = (editor.groupCounter || 0) + 1;
    const names = new Set(editor.groups.map((g) => String(g.name).toLowerCase()));
    const g = { id: "G" + Date.now().toString(36) + editor.groupCounter, name: cleanLayerName(groupName, "Split", names), visible: true, locked: false, collapsed: false, parent: null };
    editor.groups.push(g);
    const layers = ready.rows.map(({ row, px, ref }) => ({
        layer: editor.addLayer({ name: row.name, kind: "image", ref, dirty: !ref, px, x: row.x, y: row.y, w: row.w, h: row.h, group: g.id, match: { strength: 0, source: "underneath" } }, { activate: false, quiet: true }),
        row,
    }));
    if (!editor.pending) {
        const top = layers[layers.length - 1].layer;
        editor.activeLayerId = top.id;
        editor.activeGroupId = null;
        if (editor.selectLayers) editor.selectLayers([top.id]);
    }
    editor.layersRestacked();
    return { group: g, layers };
}

/**
 * The run: one request, a Cancel as any provider run's, the answer landed. -> { group, layers: [{ layer, z, description,
 * base }], asked, answered: [w, h], scaledUp, leftOut, unplaced (the layers laid over the whole source: no position
 * from the host), seconds, model, recipe, provider, tier } or null when the tab was closed.
 * `deps`: providerEdit, canvasBytes, bytesToImage, viaLine, runIdOf (the host's private helpers).
 */
export async function runSplitLayers(app, editor, opts, deps) {
    try {
        return await runJob(app, editor, opts, deps);
    } catch (err) {
        // the status line says what went wrong, as a Generate's does (a menu's or an agent's run, the tab still open)
        if (app.editors().includes(editor)) editor.setStatus(String((err && err.message) || err), failKind(err));
        throw err;
    }
}

async function runJob(app, editor, opts, deps) {
    const job = splitJob(app, editor, opts);
    const { r, model } = job;
    const label = r.providerLabel || r.provider;
    const gone = () => !app.editors().includes(editor);
    const token = { provider: r.provider, label, started: Date.now(), editor, runId: deps.runIdOf() };
    editor.providerPending = token;
    app._providerRuns.add(token);
    app.notifyProviderRuns();
    const geo = editor.geometrySeq;
    let res;
    try {
        const what = job.layer ? `layer ${job.layer.name}` : "the picture";
        editor.setStatus(`${SPLIT_LABEL}: sending ${what} (${job.rect.w} × ${job.rect.h}) to ${model} on ${label}${job.count ? `, up to ${job.count} layers` : ""} ...`);
        const image = await sourceBytes(editor, job, deps.canvasBytes);
        const request = {
            provider: r.provider, model: r.model, kind: "layers", options: r.options, fields: null,
            prompt: job.prompt, negative: "", seed: 0, image, mask: null, maskAlpha: null, width: job.rect.w, height: job.rect.h, references: [],
            params: { size: job.tier, count: job.count, text_recognition: job.textRecognition },
            timeoutMs: opts.timeoutMs || 0,
        };
        res = await deps.providerEdit(request, token);
    } catch (err) {
        app.endRun(editor, token);
        throw err;
    } finally {
        app.endRunRow(token);
    }
    // the answer is in: the Cancel is over (one row of the title row), the document stays held until the layers are in
    if (opts.onAnswer) opts.onAnswer();
    try {
        const ready = await prepare(app, editor, res, job, gone, deps);
        if (!ready || gone()) return null;
        const groupName = job.layer ? job.layer.name : app.documentName(editor);
        const landed = land(editor, ready, job, groupName);
        const [bw, bh] = ready.base;
        const scaledUp = Math.max(bw, bh) < Math.max(job.rect.w, job.rect.h);
        const n = landed.layers.length - 1;
        const parts = [n > 0
            ? `Split into ${n} layer${n === 1 ? "" : "s"} and a base, in the group "${landed.group.name}" (Ctrl+Z takes them all back) · ${deps.viaLine(r, label, res.seconds)}.`
            : `${model} found no separate elements: only its base came back, in the group "${landed.group.name}" · ${deps.viaLine(r, label, res.seconds)}.`];
        if (scaledUp) parts.push(`The model answered ${bw} × ${bh}: the layers are scaled up to the picture's size, so they are lower resolution than the picture.`);
        const missing = Array.isArray(res.missing) ? res.missing.map((m) => cleanLayerName(m, "Layer", new Set())) : [];
        if (ready.leftOut.length) parts.push(`Left out, without a usable position: ${ready.leftOut.join(", ")}.`);
        if (ready.whole.length) parts.push(`${label} gave ${ready.whole.length === 1 ? "one layer" : `${ready.whole.length} layers`} no position, so ${ready.whole.length === 1 ? "it covers" : "each covers"} the whole picture: move or scale ${ready.whole.length === 1 ? "it" : "them"} where needed.`);
        if (missing.length) parts.push(`Left out, its picture could not be downloaded: ${missing.join(", ")}.`);
        if (editor.geometrySeq !== geo) parts.push("The picture changed shape during the run: the layers sit where it was when it went out.");
        editor.setStatus(parts.join(" "), scaledUp || ready.leftOut.length || ready.whole.length || missing.length || n <= 0 ? "warn" : "info");
        return {
            group: landed.group, recipe: r.id, provider: r.provider, model, seconds: res.seconds, unplaced: ready.whole, tier: job.tier, asked: job.count, answered: [bw, bh], scaledUp, leftOut: [...ready.leftOut, ...missing],
            layers: landed.layers.map(({ layer, row }) => ({ layer, z: row.entry.z_index, base: !!row.entry.base, description: row.entry.description || "" })),
        };
    } catch (err) {
        throw Object.assign(new Error(`${SPLIT_LABEL}: ${String((err && err.message) || err)}. Nothing was added.`), { statusKind: "error" });
    } finally {
        window.scumble.providers.dropLayerParts(res.layersToken).catch(() => {});
        app.endRun(editor, token);
    }
}
