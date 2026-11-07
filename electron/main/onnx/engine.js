// The jobs of the in-app helper models (SAM2's object map and point prompts, background removal, depth) on one
// Runtime: the bodies index.js ran on the main process until U1 (docs/PLAN_HELPERS_PROCESS.md §3.1). The helpers'
// utility process (helpers_process.js) and the main-thread fallback (helpers.js) run the same engine, as LaMa's
// engine(ort) is shared (lama.js). No Electron and no settings here: main resolves the model and its files and sends
// them with every job ({ device, model: { id, label, input, mean, std }, files }), so an answer does not depend on
// where the engine runs, and the answers are what index.js answered before (host.js reads them unchanged).
"use strict";

const { Runtime } = require("./runtime");
const { Sam2, logitsToMask, SIZE } = require("./sam2");
const { Matting } = require("./matting");
const { Depth } = require("./depth");

function checkImage(req) {
    const image = req && req.image;
    if (!image || image.length !== SIZE * SIZE * 4) throw new Error(`the helper needs an RGBA image of ${SIZE} × ${SIZE} pixels`);
    return image;
}

/** The label map's / the mask's side as index.js clamped it. */
function outSize(v) {
    return Math.max(1, Math.min(4096, Math.round(v || SIZE)));
}

/** A depth job's picture: both sides multiples of 14 in [14, 2058]. -> { w, h, image } */
function checkDepth(req) {
    const w = req && req.width | 0;
    const h = req && req.height | 0;
    const image = req && req.image;
    if (!w || !h || w < 14 || h < 14 || w > 2058 || h > 2058 || w % 14 !== 0 || h % 14 !== 0 || !image || image.length !== w * h * 4) {
        throw new Error(`the depth model needs RGBA at multiples of 14 (got ${w} × ${h}, length ${image ? image.length : 0})`);
    }
    return { w, h, image };
}

/** The fields of a registry entry (models.js) the models read; a job carries them across the port. */
function modelInfo(model) {
    const m = model || {};
    return { id: m.id, label: m.label, kind: m.kind, input: m.input, multiple: m.multiple, mean: m.mean, std: m.std };
}

/**
 * The engine on a Runtime (a new one by default). Its instances are keyed by their files: one Sam2 per encoder and
 * decoder with its embedding cache (the last three pictures), one Matting and one Depth per model and file.
 */
function engine(runtime = new Runtime()) {
    const sams = new Map();       // "encoder\ndecoder" -> Sam2
    const mattings = new Map();   // "id\nfile" -> Matting
    const depths = new Map();     // "id\nfile" -> Depth
    const encoding = new WeakMap();   // Sam2 -> Map(key -> the encode under way)

    function samOf(files) {
        const k = files.encoder + "\n" + files.decoder;
        if (!sams.has(k)) sams.set(k, new Sam2(runtime, { encoder: files.encoder, decoder: files.decoder }));
        return sams.get(k);
    }

    function mattingOf(model, file) {
        const k = model.id + "\n" + file;
        if (!mattings.has(k)) mattings.set(k, new Matting(runtime, model, file));
        return mattings.get(k);
    }

    function depthOf(model, file) {
        const k = model.id + "\n" + file;
        if (!depths.has(k)) depths.set(k, new Depth(runtime, model, file));
        return depths.get(k);
    }

    /** The encode under way for a key, if any: a second job for the same picture waits for it instead of encoding it again. */
    function inflight(sam, key) {
        const m = key ? encoding.get(sam) : null;
        return m ? m.get(key) || null : null;
    }

    /** Sam2.encode (cached by key), one encode in flight per key. */
    function encode(sam, image, key) {
        if (!key || sam.cache.has(key)) return sam.encode(image, key);
        const running = inflight(sam, key);
        if (running) return running;
        let m = encoding.get(sam);
        if (!m) { m = new Map(); encoding.set(sam, m); }
        const p = sam.encode(image, key);
        m.set(key, p);
        const done = () => { if (m.get(key) === p) m.delete(key); };
        p.then(done, done);
        return p;
    }

    return {
        runtime,

        /**
         * Objects for the hover tool. job: { model, files: { encoder, decoder }, key, image (RGBA 1024²), outWidth,
         * outHeight, params? } -> { ids: Uint16Array(outWidth * outHeight), width, height, count, candidates, seconds,
         * encodeMs, provider, model, label }
         */
        async objects(job) {
            const image = checkImage(job);
            const sam = samOf(job.files);
            const outW = outSize(job.outWidth);
            const outH = outSize(job.outHeight);
            const t0 = Date.now();
            const emb = await encode(sam, image, job.key || null);
            const res = await sam.automask(emb, outW, outH, job.params || {});
            return { ids: res.ids, width: outW, height: outH, count: res.count, candidates: res.candidates, seconds: (Date.now() - t0) / 1000, encodeMs: emb.encodeMs, provider: emb.provider, model: job.model.id, label: job.model.label };
        },

        /**
         * One prompt on an already encoded picture (or the given one). job: { model, files, key, image?, points:
         * [{x, y, label}] in 1024 space, box?, raw?, outWidth, outHeight } -> { mask: Uint8Array, width, height, score,
         * ... } or, with raw: true, { logits: Float32Array(256²), n: 256, score, ... }. Without a picture for a key that
         * is neither cached nor being encoded it refuses (host.segmentLogits sends the picture then).
         */
        async segment(job) {
            const sam = samOf(job.files);
            let emb = job.key ? sam.cache.get(job.key) : null;
            if (!emb) { const running = inflight(sam, job.key); if (running) emb = await running; }
            if (!emb) emb = await encode(sam, checkImage(job), job.key || null);
            const outW = outSize(job.outWidth);
            const outH = outSize(job.outHeight);
            const { logits, score } = await sam.predict(emb, job.points || [], job.box || null);
            if (job.raw === true) {
                return { logits, n: 256, score, provider: emb.provider, model: job.model.id, label: job.model.label };
            }
            return { mask: logitsToMask(logits, outW, outH), width: outW, height: outH, score, provider: emb.provider, model: job.model.id, label: job.model.label };
        },

        /** Cutout: job { model, files: { model }, image (RGBA 1024²) } -> { alpha: Uint8Array(1024²), size, seconds, provider, model, label } */
        async cutout(job) {
            const image = checkImage(job);
            const matting = mattingOf(job.model, job.files.model);
            const t0 = Date.now();
            const res = await matting.run(image);
            return { alpha: res.alpha, size: res.size, seconds: (Date.now() - t0) / 1000, provider: res.provider, model: job.model.id, label: job.model.label };
        },

        /**
         * Depth map: job { model, files: { model }, image (RGBA w*h*4), width, height } -> { depth: Float32Array, width,
         * height, min, max, seconds, runMs, provider, model, label }. Both sides multiples of 14 in [14, 2058].
         */
        async depth(job) {
            const { w, h, image } = checkDepth(job);
            const depthModel = depthOf(job.model, job.files.model);
            const t0 = Date.now();
            const res = await depthModel.run(image, w, h);
            return {
                depth: res.depth, width: res.width, height: res.height,
                min: res.min, max: res.max, seconds: (Date.now() - t0) / 1000,
                runMs: res.ms, provider: res.provider, model: job.model.id, label: job.model.label,
            };
        },

        /** Every session released and the embeddings dropped (the fallback's Free VRAM). -> the number released */
        async free() {
            for (const s of sams.values()) s.cache.clear();
            return runtime.free();
        },

        /** The instances dropped (their files may have moved: a folder change, a scan, a removal). */
        clear() {
            sams.clear(); mattings.clear(); depths.clear();
        },

        status() {
            return runtime.status();
        },
    };
}

module.exports = { engine, checkImage, checkDepth, modelInfo, outSize, SIZE };
