// API rendering providers. Each adapter turns one edit request into one image:
//
//   edit(request, ctx) -> { bytes: Buffer, mime, width?, height?, seed?, info? }
//   generate(request, ctx)   the same answer for kind "text" (Generate new)
//   upscale(request, ctx)    the same answer for kind "upscale": `image` the picture, `factor` how many
//                            times larger it should come back (null when the model picks), `prompt` when
//                            the variant takes one as guidance (docs/RECIPES.md "Upscale recipes")
//
//   request: { model, kind ("fill" = image + mask, "edit" = instruction on the image),
//              prompt, negative, seed, image (PNG bytes of the crop), mask (PNG, white =
//              repaint), width, height (of the crop), references: [PNG bytes], params,
//              original (1: references[0] is the crop before the fill), refName (the recipe's refs.name) }
//   layout(req)              where each picture goes and what the model calls it (refs.js, docs/PLAN_REFS.md C3);
//                            a marker {@ref:i} in the prompt becomes that picture's name here, before the adapter runs;
//                            before that, checkPictures strips the references of a route that declares `drops` (the
//                            answer's `notes` say so) and refuses a run past the route's `max`
//   textLayout(req)          the same for kind "text" with references (Generate new, 26f): no crop, the references
//                            numbered from 1 in the order the text route sends them; an adapter without it leaves
//                            references out of a new image. `request.refsMax` (the variant's `text.refs.max`) lowers
//                            the route's cap.
//   ctx:     { key, fetch, log, base, toJpeg, opaque, bitmap, fromBitmap, cropPng }   base: the adapter's own allowlisted host from
//            settings (ToAPIs, OpenRouter; ModelArk's and Oxen.ai's loopback mock; never from a recipe), toJpeg(png, quality): an image re-encoded by Electron's
//            nativeImage, opaque(png): whether it has no transparent pixel; bitmap(png): { width, height, data } (BGRA),
//            fromBitmap({ width, height, data }): a PNG of it, cropPng(png, { x, y, width, height }): a part of a PNG as PNG
//            (Magnific's Ideogram mask and Image Expand; only Scumble's own PNGs go through them, never an answer)
//
// The crop and the stitch happen in the renderer (renderer/editor/stitch.js); the
// adapters only speak HTTP. Keys come from keys.js by the provider's name.
"use strict";

const { nativeImage } = require("electron");

const log = require("../log");

const keys = require("../keys");
const settings = require("../settings");
const { MARKER_ANY, TOKEN, REF_NAME_DEFAULT, validRefName, nameOf, refRoles, layoutOf, countOf, checkLayout, resolveMarkers, checkPictures } = require("./refs");

// how much of a prompt goes into a log record
const PROMPT_LOG = 500;

// The order is the order of Settings › API providers; ToAPIs first (docs/RECIPES.md "ToAPIs").
const PROVIDERS = {
    toapis: require("./toapis"),
    fal: require("./fal"),
    bfl: require("./bfl"),
    openai: require("./openai"),
    gemini: require("./gemini"),
    replicate: require("./replicate"),
    wavespeed: require("./wavespeed"),
    comfycloud: require("./comfycloud"),
    openrouter: require("./openrouter"),
    ark: require("./ark"),
    oxen: require("./oxen"),
    magnific: require("./magnific"),
    comfyrouter: require("./comfyrouter"),   // no key row: the Comfy Cloud key (keyName)
    comfypartner: require("./comfypartner"), // no key row either: HY Image 3.5 through Comfy's Partner Node proxy
    anthropic: require("./anthropic"),   // key row only: prompt upsampling (llm.js)
    deepseek: require("./deepseek"),     // key row only: the assistant
    moonshot: require("./moonshot"),     // key row only: the assistant
    zai: require("./zai"),               // key row only: the assistant
    compat: require("./compat"),         // key row only: the OpenAI-compatible endpoint (llm.js)
    inapp: require("./inapp"),           // no key row: LaMa inside the app (electron/main/onnx), Settings › Helpers
    loopback: require("./loopback"),
};

/** The name a provider's key is stored under: its own id, or the row it shares (Comfy Router uses Comfy Cloud's key). */
function keyNameOf(id, p) {
    return p && p.keyName ? p.keyName : id;
}

/**
 * What the settings dialog shows: id, label, key name, where to get a key. A provider that shares another's key
 * (`sharesKey`) is listed for its label and key state but gets no key row of its own.
 */
function describeAll() {
    // loopback is the smoke test's own provider, compat has its own settings section (URL, model, key), inapp needs no key
    return Object.entries(PROVIDERS).filter(([id]) => id !== "loopback" && id !== "compat" && id !== "inapp").map(([id, p]) => ({ id, label: p.label, keyUrl: p.keyUrl, keyHint: p.keyHint || "", key: keys.describe(keyNameOf(id, p)), balance: typeof p.balance === "function", sharesKey: p.keyName || null }));
}

function toBuffer(v) {
    if (!v) return null;
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    if (v instanceof ArrayBuffer) return Buffer.from(v);
    return Buffer.from(v);
}

/** Which providers have an upscaler (the recipes' `task: "upscale"` variants). */
function upscaleProviders() {
    return Object.entries(PROVIDERS).filter(([, p]) => typeof p.upscale === "function").map(([id]) => id);
}

/** Which providers can make an image from the prompt alone (Generate new). */
function textProviders() {
    return Object.entries(PROVIDERS).filter(([, p]) => typeof p.generate === "function").map(([id]) => id);
}

/**
 * Where each picture of this request goes (refs.js). An upscale sends the picture alone (laid out here). A text run
 * (Generate new) without references sends no picture; with references the adapter's `textLayout` numbers them from 1
 * (no crop), capped by the request's `refsMax`, and a route without one declares the drop. Every other kind asks the
 * adapter's `layout`. Each declaration is checked against the request; a layout that throws refuses the run before
 * anything is sent.
 */
function layoutFor(id, p, req) {
    if (req.kind === "text") {
        if (!(req.references || []).length) return checkLayout(layoutOf({}), req);
        if (typeof p.textLayout !== "function") return checkLayout(layoutOf({ drops: `${p.label} makes a new image from the prompt alone: reference images are left out` }), req);
        const l = p.textLayout(req);
        const cap = +req.refsMax > 0 ? Math.floor(+req.refsMax) : null;
        if (cap != null && l) l.max = l.max == null ? cap : Math.min(+l.max, cap);
        return checkLayout(l, { ...req, provider: id });
    }
    if (req.kind === "upscale") return checkLayout(layoutOf({ seq: [["crop", "image"]], drops: "An upscale sends the picture alone: reference images are left out." }), req);
    if (typeof p.edit !== "function") throw new Error(`${p.label} edits no images in Scumble; pick another provider for this model.`);
    const l = typeof p.layout === "function" ? p.layout(req) : layoutOf({ seq: [["crop", "image"], ...refRoles(req).map(([role, i]) => [role, `references[${i}]`, i])] });
    return checkLayout(l, { ...req, provider: id });
}

/**
 * The markers {@ref:i} of the prompt and the negative turned into the names this route gives those pictures ("image
 * 3"); a marker it cannot name refuses the run. Then the safety net: an @img token or a marker that is still there
 * never reaches a model. Returns { prompt, negative, refs: [{ ref, name }] }.
 */
function resolveNames(p, req, lay, given) {
    const out = { prompt: req.prompt, negative: req.negative, refs: [] };
    const seen = new Set();
    for (const k of ["prompt", "negative"]) {
        const t = req[k];
        if (typeof t !== "string" || !MARKER_ANY.test(t)) continue;
        // an empty picture was taken out of the list, so every index after it points at the next picture
        if (given !== req.references.length) throw new Error("A reference picture of the request was empty, so the reference names would point at the wrong pictures: nothing was sent.");
        const r = resolveMarkers(t, lay.pictures, req.refName);
        for (const left of r.left) {
            if (left.ref >= req.references.length) throw new Error(`The prompt names reference picture ${left.ref + 1}, and the request carries ${req.references.length}: nothing was sent.`);
            if (left.why === "unnumbered") throw new Error(`${p.label} ${req.model}: this route sends the reference images as style references, which have no number the prompt could name: take the reference out of the prompt.`);
            throw new Error(`${p.label} ${req.model}: ${lay.drops || "this route leaves that reference image out."}`);
        }
        out[k] = r.text;
        for (const x of r.refs) if (!seen.has(x.ref)) { seen.add(x.ref); out.refs.push(x); }
    }
    for (const k of ["prompt", "negative"]) {
        const t = out[k];
        if (typeof t !== "string") continue;
        const m = TOKEN.exec(t);
        if (m) throw new Error(`The ${k} holds the reference token "${m[0]}", which was not resolved to a picture: nothing was sent.`);
        if (MARKER_ANY.test(t)) throw new Error(`The ${k} holds "{@ref:", which Scumble keeps for itself: reword it. Nothing was sent.`);
    }
    return out;
}

async function edit(request) {
    const id = String(request.provider || "");
    const p = Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
    if (!p) throw new Error("Unknown provider: " + id);
    const text = request.kind === "text";
    const upscale = request.kind === "upscale";
    if (text && typeof p.generate !== "function") throw new Error(`${p.label} has no text-to-image endpoint in Scumble; pick another provider for this model.`);
    if (upscale && typeof p.upscale !== "function") throw new Error(`${p.label} has no upscaler in Scumble; pick another provider for this model.`);
    const verb = text ? "generate" : upscale ? "upscale" : "edit";
    const key = p.needsKey === false ? "" : keys.get(keyNameOf(id, p));
    if (p.needsKey !== false && !key) throw new Error(`No API key for ${p.label}. Add it under Settings › API providers.`);
    const given = (request.references || []).length;
    let req = {
        ...request,
        image: toBuffer(request.image),
        mask: toBuffer(request.mask),
        maskAlpha: toBuffer(request.maskAlpha),   // RGBA mask, alpha 0 where to repaint (OpenAI's convention)
        fields: request.fields || null,           // model-specific input names (Replicate, fal)
        options: request.options || null,         // adapter switches from the recipe variant (fal: sizing)
        references: (request.references || []).map(toBuffer).filter(Boolean),
        params: request.params || {},
        original: request.original ? 1 : 0,      // references[0] is the crop before the fill (docs/PLAN_REFS.md C3)
        refName: validRefName(request.refName) ? request.refName : REF_NAME_DEFAULT,   // IPC input is never trusted
        refsMax: +request.refsMax > 0 ? Math.floor(+request.refsMax) : null,   // a text run's cap from the variant (26f)
    };
    const t0 = Date.now();
    const ctx = contextFor(id, p, key);
    // the request's shape for the log: never the key, never the pixels
    const shape = () => ({ model: req.model, kind: verb === "upscale" ? "upscale" : text ? "text" : "edit", factor: upscale ? req.factor : undefined, image: req.image ? req.image.length : 0, mask: req.mask ? req.mask.length : 0, references: req.references.length, original: req.original, params: req.params, fields: req.fields, options: req.options, prompt: String(req.prompt || "").slice(0, PROMPT_LOG) });
    let out, named, lay, notes = [];
    try {
        if (req.original && !req.references.length) throw new Error("The request marks an Original picture but carries no reference picture: nothing was sent.");
        if (req.original && text) throw new Error("A new image has no Original picture, and the request marks one: nothing was sent.");
        lay = layoutFor(id, p, req);
        // a declared drop takes every reference out (the adapter never sees or uploads them), a run past the cap is refused
        const chk = checkPictures(lay, req, `${p.label} ${req.model}`);
        notes = chk.notes;
        const stripped = chk.req !== req;
        if (stripped) {
            req = chk.req;
            lay = layoutFor(id, p, req);   // so a marker can only resolve against what is sent
        }
        named = resolveNames(p, req, lay, stripped ? 0 : given);
        req.prompt = named.prompt;
        req.negative = named.negative;
        out = text ? await p.generate(req, ctx) : upscale ? await p.upscale(req, ctx) : await p.edit(req, ctx);
    } catch (err) {
        log.record({ level: "error", source: id, message: `${p.label} ${verb} failed after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${err && err.message || err}`, detail: { request: shape(), stack: err && err.stack } });
        throw err;
    }
    if (!out || !out.bytes) { log.record({ level: "error", source: id, message: p.label + " returned no image.", detail: shape() }); throw new Error(p.label + " returned no image."); }
    log.record({ source: id, message: `${p.label} ${verb} ok in ${((Date.now() - t0) / 1000).toFixed(1)} s`, detail: { model: req.model, bytes: out.bytes.length || out.bytes.byteLength, seed: out.seed, info: out.info, prompt: String(req.prompt || "").slice(0, PROMPT_LOG), pictures: countOf(lay), notes } });
    const bytes = toBuffer(out.bytes);
    return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime: out.mime || "image/png", seed: out.seed, info: out.info || null, seconds: (Date.now() - t0) / 1000, prompt: req.prompt, negative: req.negative == null ? null : req.negative, refs: named.refs, notes };
}

/**
 * The layout of a request of this shape, for the renderer's preview (the reference bar, the hover card, `status`):
 * shape { provider, model, kind, fields, options, params, original, count, refName, refsMax }, `count` the references
 * including the Original (a text run has none). The mask follows from `kind` as the builders read it. Answers the layout plus `names` (the
 * name of each reference index, null when the route leaves it out or cannot number it, all null when it declares a
 * drop: the send strips every reference then), `sent` (countOf) and `over` (more than the route's `max`).
 */
function layout(shape) {
    const s = shape || {};
    const id = String(s.provider || "");
    const p = Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
    if (!p) throw new Error("Unknown provider: " + id);
    const kind = ["fill", "edit", "text", "upscale"].includes(s.kind) ? s.kind : "fill";
    if (kind === "text" && typeof p.generate !== "function") throw new Error(`${p.label} has no text-to-image endpoint in Scumble; pick another provider for this model.`);
    const count = Math.max(0, Math.min(64, Math.floor(+s.count) || 0));
    const stand = Buffer.from([0]);   // a picture as far as a layout looks: there
    const withMask = kind === "fill" || kind === "edit";
    const req = {
        provider: id, model: String(s.model || ""), kind, fields: s.fields || null, options: s.options || null, params: s.params || {},
        prompt: "", negative: null, width: 1024, height: 1024,
        image: kind === "text" ? null : stand, mask: withMask ? stand : null, maskAlpha: withMask ? stand : null,
        references: Array.from({ length: count }, () => stand), original: s.original && count && kind !== "text" ? 1 : 0,
        refName: validRefName(s.refName) ? s.refName : REF_NAME_DEFAULT,
        refsMax: +s.refsMax > 0 ? Math.floor(+s.refsMax) : null,
    };
    const l = layoutFor(id, p, req);
    // what edit() does with this request: a declared drop strips every reference (a refusal over the cap is `over`)
    let strips = false;
    try { strips = checkPictures(l, req, p.label).req !== req; } catch (_) { /* refused: not a strip */ }
    const names = req.references.map((_, i) => {
        if (strips) return null;
        const pic = l.pictures.find((x) => x.ref === i);
        return pic && pic.n != null ? nameOf(req.refName, pic.n) : null;
    });
    const sent = countOf(l);
    return { ...l, names, sent, over: l.max != null && sent > l.max };
}

/** A crop as JPEG through Electron's decoder and encoder (nativeImage); null when it cannot be decoded. */
function toJpeg(png, quality = 92) {
    const img = nativeImage.createFromBuffer(Buffer.from(png));
    if (img.isEmpty()) return null;
    return img.toJPEG(quality);
}

/**
 * Whether a PNG has no transparent pixel, so a JPEG of it loses nothing but compression detail. A
 * greyscale or RGB PNG without a tRNS chunk is opaque by its header; anything else is decoded and its
 * alpha read. False when it cannot be decoded.
 */
function opaque(png) {
    const b = Buffer.from(png);
    if (b.length > 33 && b.toString("latin1", 12, 16) === "IHDR") {
        const colourType = b[25];
        if ((colourType === 0 || colourType === 2) && b.indexOf("tRNS", 33, "latin1") < 0) return true;
    }
    const img = nativeImage.createFromBuffer(b);
    if (img.isEmpty()) return false;
    const px = img.toBitmap();   // BGRA
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) return false;
    return true;
}

/** A PNG's pixels ({ width, height, data } in BGRA, as nativeImage keeps them); null when it cannot be decoded. */
function bitmap(png) {
    const img = nativeImage.createFromBuffer(Buffer.from(png));
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    return { width, height, data: img.toBitmap() };
}

/** A PNG of raw pixels (the order bitmap() gives; a grey picture is the same either way). */
function fromBitmap(b) {
    return nativeImage.createFromBitmap(Buffer.from(b.data), { width: b.width, height: b.height }).toPNG();
}

/**
 * A rectangle of a PNG as PNG; null when it cannot be decoded. nativeImage crops through Skia's premultiplied pixels,
 * so a half-transparent pixel may move by a level (docs/RECIPES.md "Magnific").
 */
function cropPng(png, r) {
    const img = nativeImage.createFromBuffer(Buffer.from(png));
    if (img.isEmpty()) return null;
    return img.crop({ x: r.x, y: r.y, width: r.width, height: r.height }).toPNG();
}

function contextFor(id, p, key) {
    return {
        key, fetch: globalThis.fetch, log: (...a) => console.log(`[${id}]`, ...a), toJpeg, opaque, bitmap, fromBitmap, cropPng,
        base: typeof p.baseUrl === "function" ? p.baseUrl(settings.get()) : undefined,
    };
}

/** What a key has left (the key row's "check balance"), for adapters that can ask for free. */
async function balance(id) {
    const p = PROVIDERS[String(id || "")];
    if (!p || typeof p.balance !== "function") throw new Error(`${(p && p.label) || id} cannot report a balance.`);
    const key = keys.get(keyNameOf(id, p));
    if (!key) throw new Error(`No API key for ${p.label}. Add it under Settings › API providers.`);
    try {
        return await p.balance(contextFor(id, p, key));
    } catch (err) {
        log.record({ level: "warn", source: id, message: `${p.label} balance failed: ${err && err.message || err}` });
        throw err;
    }
}

module.exports = { edit, layout, balance, describeAll, textProviders, upscaleProviders, PROVIDERS };
