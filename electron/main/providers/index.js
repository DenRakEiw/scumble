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
//            (Magnific's Ideogram mask and Image Expand; only Scumble's own PNGs go through them, never an answer),
//            resizePng(png, { width, height }): a PNG scaled (FLUX 3's reference layers outside 256 px .. 16 MP)
//
// The crop and the stitch happen in the renderer (renderer/editor/stitch.js); the
// adapters only speak HTTP. Keys come from keys.js by the provider's name.
"use strict";

const electron = require("electron");
const { nativeImage } = electron;

const log = require("../log");
const cloudjobs = require("./cloudjobs");   // the Comfy Cloud jobs a crash may leave (docs/PLAN_COMFY_SDK.md S6)

/** The app's data folder, or null (a plain-Node test's stand-in for Electron has none). */
function userData() {
    try { return electron.app && typeof electron.app.getPath === "function" ? electron.app.getPath("userData") : null; } catch (_) { return null; }
}

const keys = require("../keys");
const settings = require("../settings");
const { MARKER_ANY, TOKEN, REF_NAME_DEFAULT, validRefName, nameOf, refRoles, layoutOf, countOf, checkLayout, resolveMarkers, checkPictures } = require("./refs");
const boxes = require("./boxes");   // the box rows of a prompt (item 28, docs/PLAN_BOXES.md)
const { noKeyText } = require("./util");   // a key stored on another PC or Windows account says so (keys.js stale)

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

/** Which providers have a relight endpoint (the recipes' `task: "relight"` variants). */
function relightProviders() {
    return Object.entries(PROVIDERS).filter(([, p]) => typeof p.relight === "function").map(([id]) => id);
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
    if (req.kind === "relight") {
        if (typeof p.relight !== "function") throw new Error(`${p.label} has no relight endpoint in Scumble; pick another provider for this model.`);
        const l = typeof p.layout === "function" ? p.layout(req) : layoutOf({ seq: [["crop", "image"], ["lightmap", "transfer_light_from_lightmap"]] });
        return checkLayout(l, { ...req, provider: id });
    }
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
            if (left.why === "unnumbered") throw new Error(`${p.label} ${req.model}: this route sends the reference images without a number the prompt could name (as style references or unnumbered references): take the reference out of the prompt.`);
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

// The runs waiting on a provider, by the renderer's run id: the title row's Cancel aborts one (cancel below). An
// aborted run's fetch and its waits between polls end at once; the provider may still finish the job and charge it.
const running = new Map();   // runId -> AbortController
const cancelledEarly = new Set();   // a Cancel that came before its run reached edit(): that run stops at its start

/** Stop waiting for a run (the renderer's Cancel); one that has not started yet stops when it does. */
function cancel(runId) {
    const id = String(runId || "");
    if (!id) return false;
    const ac = running.get(id);
    if (ac) { ac.abort(); return true; }
    if (cancelledEarly.size > 200) cancelledEarly.clear();
    cancelledEarly.add(id);
    return false;
}

const aborted = () => Object.assign(new Error("cancelled"), { name: "AbortError" });

/** Tells the window that the noted Comfy Cloud jobs changed (main.js sends provider:cloudJobsChanged). */
function jobsChanged(hooks) {
    if (hooks && typeof hooks.cloudJobsChanged === "function") { try { hooks.cloudJobsChanged(); } catch (_) { /* the window may be gone */ } }
}

const PROGRESS_MS = 250;   // at most four progress frames a second per run reach the renderer

/**
 * A run's progress frames to `send` with the run's id, at most one per PROGRESS_MS: a frame that comes sooner waits and
 * is replaced by a later one (a share is a whole snapshot of the run); an urgent one (a status change) goes at once,
 * after the share that was waiting (a status carries no share).
 */
function progressSender(runId, send) {
    // the monotonic clock: a wall clock set back (a time sync after a wake) would hold every share for as long
    let last = -Infinity, pending = null, timer = null;
    const emit = (p) => { last = performance.now(); try { send({ ...p, runId }); } catch (_) { /* the window may be gone */ } };
    const flush = () => { timer = null; if (pending) { const p = pending; pending = null; emit(p); } };
    const fn = (frame) => {
        const { urgent, ...p } = frame || {};
        const now = performance.now();
        if (urgent || now - last >= PROGRESS_MS) {
            if (timer) { clearTimeout(timer); timer = null; }
            if (urgent && pending) emit(pending);
            pending = null;
            emit(p);
            return;
        }
        pending = p;
        if (!timer) timer = setTimeout(flush, PROGRESS_MS - (now - last));
    };
    fn.stop = () => { if (timer) clearTimeout(timer); timer = null; pending = null; };
    return fn;
}

/**
 * A provider run. `hooks.progress(frame)` takes the run's live progress (an adapter that has some calls ctx.progress);
 * `hooks.cloudJobsChanged()` hears that a Comfy Cloud run ended with its job's note kept, or put back (the window asks
 * for the noted jobs then); `hooks.pageGone()` says whether the page that asked for the run went away meanwhile (a
 * reload, a crash): a Comfy Cloud picture that came for it puts its job's note back, so the new page's ask brings it.
 */
async function edit(request, hooks = {}) {
    const id = String(request.provider || "");
    const p = Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
    if (!p) throw new Error("Unknown provider: " + id);
    const text = request.kind === "text";
    const upscale = request.kind === "upscale";
    const relight = request.kind === "relight";
    if (text && typeof p.generate !== "function") throw new Error(`${p.label} has no text-to-image endpoint in Scumble; pick another provider for this model.`);
    if (upscale && typeof p.upscale !== "function") throw new Error(`${p.label} has no upscaler in Scumble; pick another provider for this model.`);
    if (relight && typeof p.relight !== "function") throw new Error(`${p.label} has no relight endpoint in Scumble; pick another provider for this model.`);
    const verb = text ? "generate" : upscale ? "upscale" : relight ? "relight" : "edit";
    const key = p.needsKey === false ? "" : keys.get(keyNameOf(id, p));
    if (p.needsKey !== false && !key) throw new Error(noKeyText(p.label, keys.describe(keyNameOf(id, p)).stale));
    const given = (request.references || []).length;
    let req = {
        ...request,
        image: toBuffer(request.image),
        lightmap: toBuffer(request.lightmap),
        mask: toBuffer(request.mask),
        maskAlpha: toBuffer(request.maskAlpha),   // RGBA mask, alpha 0 where to repaint (OpenAI's convention)
        fields: request.fields || null,           // model-specific input names (Replicate, fal)
        options: request.options || null,         // adapter switches from the recipe variant (fal: sizing)
        references: (request.references || []).map(toBuffer).filter(Boolean),
        params: request.params || {},
        original: request.original ? 1 : 0,      // references[0] is the crop before the fill (docs/PLAN_REFS.md C3)
        refName: validRefName(request.refName) ? request.refName : REF_NAME_DEFAULT,   // IPC input is never trusted
        refsMax: +request.refsMax > 0 ? Math.floor(+request.refsMax) : null,   // a text run's cap from the variant (26f)
        boxes: Array.isArray(request.boxes) ? request.boxes : [],              // box geometry in fractions of the frame (item 28)
    };
    const t0 = Date.now();
    const runId = request.runId ? String(request.runId).slice(0, 80) : "";
    const ac = new AbortController();
    if (runId) running.set(runId, ac);
    if (runId && cancelledEarly.delete(runId)) ac.abort();
    const ctx = contextFor(id, p, key, ac.signal);
    if (runId && hooks && typeof hooks.progress === "function") ctx.progress = progressSender(runId, hooks.progress);
    // the request's shape for the log: never the key, never the pixels
    const shape = () => ({ model: req.model, kind: verb === "upscale" ? "upscale" : text ? "text" : relight ? "relight" : "edit", factor: upscale ? req.factor : undefined, image: req.image ? req.image.length : 0, mask: req.mask ? req.mask.length : 0, references: req.references.length, original: req.original, boxes: req.boxes.length, params: req.params, fields: req.fields, options: req.options, prompt: String(req.prompt || "").slice(0, PROMPT_LOG) });
    let out, named, lay, notes = [], sentBoxes = 0;
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
        // the box rows go into the prompt here, where the pictures' final names are known (item 28); a route without
        // a schema for them drops them with a note, so boxes never block a run elsewhere
        if (req.boxes.length) {
            if (!boxes.schemaOf(req)) notes.push(`The boxes were not sent: ${p.label} ${req.model} takes none.`);
            else {
                const a = boxes.applyBoxes(req, lay);
                req.prompt = a.prompt;
                if (a.params) req.params = { ...req.params, ...a.params };   // Ideogram 4: no prompt expansion over its caption
                sentBoxes = a.rows.length;
                for (const n of a.notes) notes.push(n);
            }
        }
        out = text ? await p.generate(req, ctx) : upscale ? await p.upscale(req, ctx) : relight ? await p.relight(req, ctx) : await p.edit(req, ctx);
        if (ac.signal.aborted) throw aborted();   // an adapter that finished its last call as Cancel came: dropped too
    } catch (err) {
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        // a Comfy Cloud run whose job's note stays (comfycloud.runV2): the window asks for the noted jobs again
        if (ctx.noteKept === true) jobsChanged(hooks);
        if (ac.signal.aborted) {
            // an adapter that knows where its job stood says so (Comfy Cloud on v2, Comfy Router): ctx.jobSent false
            // (nothing went out that runs), ctx.jobDone (it had finished: charged, its picture dropped), ctx.jobEnded
            // (it had ended without a picture: its status), ctx.cancelAsked (the provider answered that the job stops);
            // without them the provider may still finish the job, and a kept note (ctx.noteKept) brings its picture
            const words = ctx.jobSent === false ? `Cancelled after ${secs} s, before the job went to ${p.label}: nothing runs or is charged.`
                : ctx.jobDone === true ? `Cancelled after ${secs} s: the job had already finished on ${p.label} and is charged; its picture was not kept.`
                    : typeof ctx.jobEnded === "string" && ctx.jobEnded ? `Cancelled after ${secs} s: the job had already ended on ${p.label} (${ctx.jobEnded}) without a picture.`
                        : ctx.cancelAsked === true ? `Cancelled after ${secs} s: Scumble asked ${p.label} to stop the job.`
                            : `Cancelled after ${secs} s: Scumble stopped waiting for ${p.label}, which may still finish the job and charge it.${ctx.noteKept === true ? " " + cloudjobs.KEPT : ""}`;
            log.record({ source: id, message: `${p.label} ${verb} cancelled after ${secs} s`, detail: { request: shape(), words } });
            throw new Error(words);
        }
        log.record({ level: "error", source: id, message: `${p.label} ${verb} failed after ${secs} s: ${err && err.message || err}`, detail: { request: shape(), stack: err && err.stack } });
        throw err;
    } finally {
        if (runId) running.delete(runId);
        if (ctx.progress && ctx.progress.stop) ctx.progress.stop();
    }
    // the picture came, but the page that asked for it is gone (a reload or a crash during the run): the job's note goes
    // back, so the new page's ask brings the picture as a document of its own (S6)
    if (out && out.bytes && ctx.jobNote && ctx.jobs && hooks && typeof hooks.pageGone === "function" && hooks.pageGone()) {
        ctx.jobs.add(ctx.jobNote);
        log.record({ level: "warn", source: id, message: `${p.label}: the window that asked for job ${ctx.jobNote.jobId} went away before its picture came; the job stays noted, so the window opens it` });
        jobsChanged(hooks);
    }
    if (!out || !out.bytes) { log.record({ level: "error", source: id, message: p.label + " returned no image.", detail: shape() }); throw new Error(p.label + " returned no image."); }
    // an adapter's own notes on the run (Comfy Router: who served it, what it left out) join the request's
    if (Array.isArray(out.notes)) for (const n of out.notes) if (n) notes.push(String(n));
    log.record({ source: id, message: `${p.label} ${verb} ok in ${((Date.now() - t0) / 1000).toFixed(1)} s`, detail: { model: req.model, bytes: out.bytes.length || out.bytes.byteLength, seed: out.seed, info: out.info, prompt: String(req.prompt || "").slice(0, PROMPT_LOG), pictures: countOf(lay), boxes: sentBoxes, notes } });
    const bytes = toBuffer(out.bytes);
    return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime: out.mime || "image/png", seed: out.seed, info: out.info || null, seconds: (Date.now() - t0) / 1000, prompt: req.prompt, negative: req.negative == null ? null : req.negative, refs: named.refs, notes, boxes: sentBoxes };
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
    const kind = ["fill", "edit", "text", "upscale", "relight"].includes(s.kind) ? s.kind : "fill";
    if (kind === "text" && typeof p.generate !== "function") throw new Error(`${p.label} has no text-to-image endpoint in Scumble; pick another provider for this model.`);
    if (kind === "relight" && typeof p.relight !== "function") throw new Error(`${p.label} has no relight endpoint in Scumble; pick another provider for this model.`);
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

/** A PNG scaled to width x height (Skia's best filter) as PNG; null when it cannot be decoded. FLUX 3's reference sizes. */
function resizePng(png, size) {
    const img = nativeImage.createFromBuffer(Buffer.from(png));
    if (img.isEmpty()) return null;
    return img.resize({ width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)), quality: "best" }).toPNG();
}

function contextFor(id, p, key, signal) {
    const ctx = {
        key, fetch: globalThis.fetch, log: (...a) => console.log(`[${id}]`, ...a), toJpeg, opaque, bitmap, fromBitmap, cropPng, resizePng,
        base: typeof p.baseUrl === "function" ? p.baseUrl(settings.get()) : undefined,
        signal: signal || null,
    };
    // Comfy Cloud: the Comfy API v2 through the SDK, or the legacy API for one release (docs/PLAN_COMFY_SDK.md 3.9)
    if (id === "comfycloud") ctx.cloudApi = ((settings.get().comfycloud || {}).api === "legacy") ? "legacy" : "v2";
    // a v2 job is noted while it runs, so a crash leaves it for the next start (S6); a note a full file pushes out is
    // named in the log (its picture can only be fetched by hand then)
    if (id === "comfycloud" && userData()) ctx.jobs = cloudjobs.store(userData(), { pushedOut: notesPushedOut });
    if (signal) {
        // a run's every request and every wait between its polls end when the run is cancelled; the fetch is read at
        // call time (the tests put their fake in globalThis.fetch)
        ctx.fetch = (url, init = {}) => {
            if (signal.aborted) return Promise.reject(aborted());
            return globalThis.fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
        };
        ctx.sleep = (ms) => new Promise((resolve, reject) => {
            if (signal.aborted) { reject(aborted()); return; }
            const stop = () => { clearTimeout(t); reject(aborted()); };
            const t = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
            signal.addEventListener("abort", stop, { once: true });
        });
    }
    return ctx;
}

/** What a key has left (the key row's "check balance"), for adapters that can ask for free. */
async function balance(id) {
    const p = PROVIDERS[String(id || "")];
    if (!p || typeof p.balance !== "function") throw new Error(`${(p && p.label) || id} cannot report a balance.`);
    const key = keys.get(keyNameOf(id, p));
    if (!key) throw new Error(noKeyText(p.label, keys.describe(keyNameOf(id, p)).stale));
    try {
        return await p.balance(contextFor(id, p, key));
    } catch (err) {
        log.record({ level: "warn", source: id, message: `${p.label} balance failed: ${err && err.message || err}` });
        throw err;
    }
}

function notesPushedOut(entries) {
    for (const e of entries) log.record({ level: "warn", source: "comfycloud", message: `Comfy Cloud: the note of job ${e.jobId} (${e.model || "Comfy Cloud"}) was pushed out by newer ones; its picture is not brought back by itself` });
}

// when this process started: a note written before it is of an earlier run (`earlier` in recoverCloudJobs' pictures)
const BOOT = Date.now();

/**
 * The noted Comfy Cloud jobs (docs/PLAN_COMFY_SDK.md S6), read whenever the window asks (main.js: after its documents
 * are back, when the notes changed, every 90 s while some are kept; never while no window is shown): the pictures of
 * the jobs that finished meanwhile, for the window to open as documents of their own (`earlier`: noted before this
 * process started), and how many stay noted (running, unanswered, unread). The jobs of `skip` (pictures the window
 * was given and has not acked) and those whose run is in flight here are left alone. Nothing is sent again; without a
 * key nothing is asked.
 */
async function recoverCloudJobs({ skip = null, only = null } = {}) {
    const none = { pictures: [], kept: 0, keptIds: [], running: 0, unanswered: 0, unread: 0, dropped: 0, skipped: null };
    const dir = userData();
    if (!dir) return { ...none, skipped: "no data folder" };
    const jobs = cloudjobs.store(dir);
    if (!jobs.list().length) return none;
    const p = PROVIDERS.comfycloud;
    const key = keys.get(keyNameOf("comfycloud", p));
    const leave = new Set([...(Array.isArray(skip) ? skip : []), ...cloudjobs.flying].map(String));
    try {
        const r = await p.recoverJobs(jobs, contextFor("comfycloud", p, key, null), Date.now(), { skip: [...leave], only: Array.isArray(only) ? only.map(String) : null });
        if (r.pictures.length || r.dropped || r.kept) log.record({ source: "comfycloud", message: `Comfy Cloud: ${r.pictures.length} noted result${r.pictures.length === 1 ? "" : "s"} brought back, ${r.kept} still noted (${r.running} running, ${r.unanswered} unanswered, ${r.unread} not downloaded yet), ${r.dropped} dropped${r.skipped ? ` (${r.skipped})` : ""}` });
        return { ...r, pictures: r.pictures.map((x) => ({ ...x, earlier: !(+x.started >= BOOT), bytes: new Uint8Array(x.bytes.buffer, x.bytes.byteOffset, x.bytes.byteLength) })) };
    } catch (err) {
        log.record({ level: "error", source: "comfycloud", message: `Comfy Cloud: the noted jobs could not be read: ${(err && err.message) || err}` });
        const left = jobs.list().map((e) => e.jobId).filter((id) => !leave.has(id) && !cloudjobs.settled.has(id) && (!Array.isArray(only) || only.includes(id)));
        return { ...none, kept: left.length, keptIds: left, unanswered: left.length, skipped: "error" };
    }
}

/** The window has opened a brought-back picture: its job's note goes (until then a start brings it again). */
function ackCloudJob(jobId) {
    const dir = userData();
    if (dir && jobId) cloudjobs.store(dir).remove(String(jobId));
    return true;
}

module.exports = { edit, cancel, layout, balance, describeAll, textProviders, upscaleProviders, relightProviders, recoverCloudJobs, ackCloudJob, PROVIDERS, _progressSender: progressSender };
