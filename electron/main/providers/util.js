// Shared bits for the provider adapters.
"use strict";

function dataUri(buf, mime = "image/png") {
    return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
}

function b64(buf) {
    return Buffer.from(buf).toString("base64");
}

/** Decode a data URI or fetch an http(s) URL into bytes. */
async function fetchImage(url, fetchFn, headers = {}) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(url));
    if (m) {
        const mime = m[1] || "application/octet-stream";
        const bytes = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "latin1");
        return { bytes, mime };
    }
    const r = await fetchFn(url, { headers });
    if (!r.ok) throw Object.assign(new Error(`image download answered ${r.status}`), { response: r });
    return { bytes: Buffer.from(await r.arrayBuffer()), mime: (r.headers && typeof r.headers.get === "function" && r.headers.get("content-type")) || "image/png" };
}

function scrub(text, key) {
    let s = String(text == null ? "" : text);
    if (key && key.length >= 6) s = s.split(key).join("[key]");
    return s;
}

function jsonError(j, key) {
    if (!j || typeof j !== "object") return "";
    const msg = (j.error && (j.error.message || j.error)) || j.detail || j.message || j.status;
    if (!msg) return "";
    const raw = typeof msg === "string" ? msg : JSON.stringify(msg, (k, v) => (k === "input" ? undefined : v));
    return scrub(raw, key).slice(0, 500);
}

async function readError(r, key) {
    let text = "";
    try { text = await r.text(); } catch (_) { text = ""; }
    try {
        const fromJson = jsonError(JSON.parse(text), key);
        if (fromJson) return fromJson;
    } catch (_) { /* not JSON */ }
    return scrub(text, key).slice(0, 300) || (r && r.statusText) || String((r && r.status) || "");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RETRY_AFTER_MAX_MS = 60 * 1000;

function retryAfterMs(r, fallback = 1000) {
    const h = r && r.headers;
    const v = h && (typeof h.get === "function" ? h.get("retry-after") : (h["retry-after"] ?? h["Retry-After"]));
    if (v == null || v === "") return fallback;
    const n = Number(v);
    if (Number.isFinite(n)) {
        const asked = n * 1000;
        return asked > 0 ? Math.min(asked, RETRY_AFTER_MAX_MS) : fallback;
    }
    const at = Date.parse(v);
    if (Number.isFinite(at)) {
        const asked = at - Date.now();
        return asked > 0 ? Math.min(asked, RETRY_AFTER_MAX_MS) : fallback;
    }
    return fallback;
}

function isTransientStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

// A paid job's reads (its status, its result, its picture) that get no answer go on for GAP_MS in a row, past the
// run's time too (a machine that slept past it reads first; a Wi-Fi or VPN that is back after a wake), as
// comfycloud.js finishV2's STATUS_GAP_MS; any answer starts that count again. The gap is the longer of the time since
// the first of them and the pauses taken (a clock that stops while the machine sleeps, a test's pauses that take no
// time). A status read gives up after READ_MS (a connection a sleep left half-open).
const TIMES = { gapMs: 120000, readMs: 30000, pauseMaxMs: 15000 };
const RESULT_TRIES = 3;

function gapWatch() {
    let since = null, paused = 0;
    return {
        /** A read without an answer: its gap so far (before the pause that follows it). */
        miss() {
            if (since == null) since = performance.now();
            return Math.max(paused, performance.now() - since);
        },
        paused(ms) { if (since != null) paused += ms; },
        answered() { since = null; paused = 0; },
        get open() { return since != null; },
    };
}

function readSignal() {
    return AbortSignal.timeout(TIMES.readMs);
}
const STOP_WAIT_MS = 2000;
const STOP_TIMEOUT_MS = 10000;

const aborted = () => Object.assign(new Error("cancelled"), { name: "AbortError" });

function isAbort(err, ctx) {
    return !!(ctx && ctx.signal && ctx.signal.aborted) || !!(err && (err.name === "AbortError" || err.code === "ABORT_ERR"));
}

function allowedStopUrl(raw, host) {
    if (!raw || typeof raw !== "string") return null;
    try {
        const u = new URL(raw);
        if (u.protocol !== "https:" || u.hostname !== host || u.username || u.password) return null;
        return u.href;
    } catch (_) {
        return null;
    }
}

/**
 * Asks a provider (fal.ai or Replicate) to stop an in-flight queued job via `globalThis.fetch` (read at call time,
 * since `ctx.fetch` refuses requests after Cancel). Sends the key only to `https://<host>`, with `redirect: "error"`,
 * `AbortSignal.timeout(10000)` and a `.catch` so a late or failed stop never becomes an unhandled rejection; waits at
 * most `waitMs` (default 2 s) for a 2xx (`r.ok`) without reading the body.
 */
async function askStop(cancelUrl, { host, method, auth, waitMs = STOP_WAIT_MS } = {}) {
    const url = allowedStopUrl(cancelUrl, host);
    const fetchFn = globalThis.fetch;
    if (!url || !auth || typeof fetchFn !== "function") return false;
    const req = Promise.resolve().then(() => fetchFn(url, {
        method,
        headers: { Authorization: auth },
        redirect: "error",
        signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
    })).then((r) => !!(r && r.ok)).catch(() => false);
    let timer = null;
    try {
        return await Promise.race([
            req,
            new Promise((resolve) => { timer = setTimeout(() => resolve(false), waitMs); }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Wait `ms` through `ctx.sleep` (or `sleep`), ending at once on `ctx.signal` abort. */
function pause(ms, ctx) {
    const signal = ctx && ctx.signal;
    if (signal && signal.aborted) return Promise.reject(aborted());
    const sleepFn = (ctx && typeof ctx.sleep === "function") ? ctx.sleep : null;
    if (!signal) return sleepFn ? Promise.resolve(sleepFn(ms)) : sleep(ms);
    return new Promise((resolve, reject) => {
        let timer = null;
        const stop = () => {
            if (timer) clearTimeout(timer);
            reject(aborted());
        };
        signal.addEventListener("abort", stop, { once: true });
        if (sleepFn) {
            Promise.resolve().then(() => sleepFn(ms)).then(
                () => {
                    signal.removeEventListener("abort", stop);
                    if (signal.aborted) reject(aborted());
                    else resolve();
                },
                (err) => {
                    signal.removeEventListener("abort", stop);
                    reject(signal.aborted ? aborted() : err);
                }
            );
        } else {
            timer = setTimeout(() => {
                signal.removeEventListener("abort", stop);
                if (signal.aborted) reject(aborted());
                else resolve();
            }, ms);
        }
    });
}

async function callFetch(ctx, url, init) {
    if (ctx && ctx.signal && ctx.signal.aborted) throw aborted();
    const r = await (init === undefined ? ctx.fetch(url) : ctx.fetch(url, init));
    if (ctx && ctx.signal && ctx.signal.aborted) throw aborted();
    return r;
}

async function readBody(r) {
    let text = "", json = null;
    if (r && typeof r.text === "function") {
        try { text = await r.text(); } catch (_) { text = ""; }
        try { json = JSON.parse(text); } catch (_) { json = null; }
    }
    if (json == null && r && typeof r.json === "function" && typeof r.clone !== "function") {
        try {
            json = await r.json();
            if (!text && json != null) text = JSON.stringify(json);
        } catch (_) { json = null; }
    }
    return { json, text };
}

function errorText(r, text, json, key) {
    const fromJson = jsonError(json, key);
    if (fromJson) return fromJson;
    return scrub(text, key).slice(0, 300) || (r && r.statusText) || String((r && r.status) || "error");
}

/**
 * Downloads a finished job's picture (up to 3 tries, honouring Retry-After and Cancel). On failure, names the
 * request id and says the job may still finish and be charged, with the key scrubbed.
 */
async function downloadImage(url, ctx, opts = {}) {
    const { who = "Provider", id = "", headers } = opts;
    const key = ctx && ctx.key;
    const fetchFn = (u, init) => callFetch(ctx, u, init);
    let last = "";
    // the picture is paid for: a download with no answer (a dropped connection, a 408 / 425 / 429 / 5xx) is tried
    // again for the gap window (TIMES.gapMs), any other answer 3 times
    const gap = gapWatch();
    for (let attempt = 1; ; attempt++) {
        if (ctx && ctx.signal && ctx.signal.aborted) throw aborted();
        try {
            return await fetchImage(url, fetchFn, headers);
        } catch (err) {
            if (isAbort(err, ctx)) throw err;
            last = scrub(String((err && err.message) || err), key);
            const unanswered = !(err && err.response) || isTransientStatus(err.response.status);
            let g = 0;
            if (unanswered) g = gap.miss(); else gap.answered();
            if (!(attempt < RESULT_TRIES || (unanswered && g < TIMES.gapMs))) break;
            const step = Math.min(1500 * attempt, TIMES.pauseMaxMs);
            const wait = err && err.response ? retryAfterMs(err.response, step) : step;
            await pause(wait, ctx);
            if (unanswered) gap.paused(wait);
        }
    }
    const tag = id ? ` (request ${id})` : "";
    throw new Error(scrub(`${who}${tag}: the picture could not be downloaded (${last}); the job may still finish and be charged.`, key));
}

/**
 * Polls a submitted job until `done(state)` is true (modelled on bfl.js): failed status reads (a thrown fetch, a
 * read past TIMES.readMs, 408, 425, 429, 5xx, or a body that is not a status JSON object) go on for the gap window
 * (TIMES.gapMs) in a row, reset by a good read, with a backoff on `ctx.sleep` (1 s more per miss, at most 15 s) and
 * `Retry-After` (above 0, capped at 60 s) respected; other 4xx answers (such as 400/401/402/403/404/422) and
 * provider-reported failures end at once; a Cancel stops at once. The run's time (`waitMs`) is checked only after a
 * read that was answered: a job read last without an answer is never called timed out (`timedOut` makes the callers
 * ask the provider to stop it). If `resultUrl` is given, the result JSON is tried 3 times, and for the gap window
 * while it gets no answer.
 */
async function pollJob(ctx, opts) {
    const {
        who,
        timeoutWho = who,
        statusWho = `${who} status`,
        resultWho = `${who} result`,
        id = "",
        waitMs,
        initial,
        url,
        resultUrl,
        headers = {},
        delay = 1000,
        parse,
        done,
    } = opts;
    const key = ctx && ctx.key;
    const tag = id ? ` (request ${id})` : "";
    const t0 = Date.now();
    let state = initial;
    let misses = 0;
    let nextWait = null;
    let answered = true;   // the last read had an answer (the submit's, before the first read)
    const gap = gapWatch();
    const missed = (why, extra) => {
        answered = false;
        const g = gap.miss();
        if (g >= TIMES.gapMs) {
            throw Object.assign(new Error(scrub(`${who}${tag}: status poll failed for ${Math.round(g / 1000)} s (${why}); the job may still finish and be charged.`, key)), { unanswered: true });
        }
        misses++;
        nextWait = extra != null ? extra : Math.min(1000 * misses, TIMES.pauseMaxMs);
    };

    while (!done(state)) {
        const rem = waitMs - (Date.now() - t0);
        // past the run's time only after an answered read: a machine that slept past it, or a network that is
        // gone, reads again first (the gap window bounds that)
        if (rem <= 0 && answered) {
            throw Object.assign(
                new Error(scrub(`${timeoutWho}: timed out after ${Math.round(waitMs / 60000)} minutes${tag}; the job may still finish and be charged.`, key)),
                { timedOut: true }
            );
        }
        const wait = nextWait != null ? nextWait : (typeof delay === "function" ? delay(state) : delay);
        nextWait = null;
        const ms = rem > 0 ? Math.min(wait, rem) : wait;
        await pause(ms, ctx);
        if (!answered) gap.paused(ms);
        const pollUrl = typeof url === "function" ? url(state) : url;
        let r, body;
        try {
            // each read with its own time: a connection a sleep left half-open does not hold the run
            const signal = readSignal();
            r = await callFetch(ctx, pollUrl, { headers, signal });
            body = await readBody(r);
            if (signal.aborted && !(ctx && ctx.signal && ctx.signal.aborted)) throw signal.reason;
        } catch (err) {
            if (isAbort(err, ctx)) throw err;
            missed(scrub(String((err && err.message) || err), key));
            continue;
        }
        const { json, text } = body;
        const parsed = (!r.ok && isTransientStatus(r.status)) ? null : (parse ? parse(json, state) : (json && typeof json === "object" && !Array.isArray(json) ? json : null));
        if (!r.ok || !parsed) {
            const detail = errorText(r, text, json, key);
            if (!r.ok && !isTransientStatus(r.status)) {
                throw new Error(scrub(`${statusWho}${tag}: ${detail}`, key));
            }
            const why = !r.ok ? `HTTP ${r.status}${detail ? " " + detail : ""}` : `invalid status JSON${text ? ": " + scrub(text, key).slice(0, 200) : ""}`;
            missed(why, retryAfterMs(r, Math.min(1000 * (misses + 1), TIMES.pauseMaxMs)));
            continue;
        }
        misses = 0;
        answered = true;
        gap.answered();
        state = parsed;
    }

    if (!resultUrl) return state;

    // the job is done (and paid for): its result read with no answer goes on for the gap window, any other 3 times
    const resUrl = typeof resultUrl === "function" ? resultUrl(state) : resultUrl;
    let last = "";
    const rgap = gapWatch();
    for (let attempt = 1; ; attempt++) {
        let r, wait, unanswered = true;
        try {
            r = await callFetch(ctx, resUrl, { headers });
        } catch (err) {
            if (isAbort(err, ctx)) throw err;
            last = scrub(String((err && err.message) || err), key);
            r = null;
        }
        if (r) {
            const { json, text } = await readBody(r);
            if (!r.ok && !isTransientStatus(r.status)) {
                throw new Error(scrub(`${resultWho}${tag}: ${errorText(r, text, json, key)}`, key));
            }
            if (r.ok && json && typeof json === "object" && !Array.isArray(json)) {
                return json;
            }
            const detail = errorText(r, text, json, key);
            last = !r.ok ? `HTTP ${r.status}${detail ? " " + detail : ""}` : `invalid result JSON${text ? ": " + scrub(text, key).slice(0, 200) : ""}`;
            unanswered = !r.ok;
        }
        let g = 0;
        if (unanswered) g = rgap.miss(); else rgap.answered();
        if (!(attempt < RESULT_TRIES || (unanswered && g < TIMES.gapMs))) break;
        const step = Math.min(1500 * attempt, TIMES.pauseMaxMs);
        wait = r ? retryAfterMs(r, step) : step;
        await pause(wait, ctx);
        if (unanswered) rgap.paused(wait);
    }
    throw new Error(scrub(`${who}${tag}: result could not be read (${last}); the job may still finish and be charged.`, key));
}
pollJob.download = downloadImage;

/** Pick from `sizes` (["WxH", ...]) the one whose aspect is closest to w:h. */
function closestSize(w, h, sizes) {
    const want = w / h;
    let best = sizes[0], bestD = Infinity;
    for (const s of sizes) {
        const [sw, sh] = s.split("x").map(Number);
        const d = Math.abs(Math.log(sw / sh) - Math.log(want));
        if (d < bestD) { best = s; bestD = d; }
    }
    return best;
}

/** The preset ("W:H") whose aspect is closest to w:h (WaveSpeed, Comfy Cloud and ToAPIs presets). */
function closestAspect(w, h, presets) {
    const want = Math.log(w / h);
    let best = presets[0], bestD = Infinity;
    for (const p of presets) {
        const [a, b] = String(p).split(":").map(Number);
        if (!a || !b) continue;
        const d = Math.abs(Math.log(a / b) - want);
        if (d < bestD) { best = p; bestD = d; }
    }
    return best;
}

/** editAspect: a preset within this of the emitted crop goes (|ln| of the ratios); the planned one within the second. */
const FIT_SLACK = 0.03;
const PLANNED_SLACK = 0.08;

/**
 * { aspect, fit } of an edit on a model of aspect presets (`o.ratios`, without auto; FLUX 3 on OpenRouter, Krea 3). The
 * preset the crop was widened to (req.cropAspect, one of `ratios`, within PLANNED_SLACK of the emitted size), else the
 * nearest within FIT_SLACK, both with fit "stretch" (the answer comes back in that shape and the stitch stretches it
 * onto the crop); else "auto" and no fit.
 */
function editAspect(req, o) {
    const ratios = Array.isArray(o.ratios) ? o.ratios.filter((r) => r && r !== "auto") : [];
    const w = Math.max(1, +req.width || 1024), h = Math.max(1, +req.height || 1024);
    const off = (r) => { const [a, b] = String(r).split(":").map(Number); return a > 0 && b > 0 ? Math.abs(Math.log(w / h) - Math.log(a / b)) : Infinity; };
    const planned = String(req.cropAspect || "");
    if (ratios.includes(planned) && off(planned) <= PLANNED_SLACK) return { aspect: planned, fit: "stretch" };
    const near = ratios.length ? closestAspect(w, h, ratios) : null;
    return near && off(near) <= FIT_SLACK ? { aspect: near, fit: "stretch" } : { aspect: "auto", fit: null };
}

/**
 * A free pixel size for a crop of w x h under a model's rules: both edges multiples of `step`,
 * at most `max` an edge, `minPixels` to `maxPixels` in all (0 = no bound) and a ratio no steeper
 * than `maxRatio` (0 = any). GPT Image 2 / 2.5 / 2.6 (OpenAI, fal and ToAPIs) and Qwen Image 3.0 on ToAPIs.
 * Returns [width, height].
 */
function fitPixels(w, h, r) {
    let cw = Math.max(1, Math.round(w)), ch = Math.max(1, Math.round(h));
    if (r.maxRatio && Math.max(cw, ch) / Math.min(cw, ch) > r.maxRatio) {
        // a very long crop: keep the short edge and pull the long one back to the ratio
        if (cw > ch) cw = Math.round(ch * r.maxRatio); else ch = Math.round(cw * r.maxRatio);
    }
    const fit = (k) => { cw = Math.max(1, Math.round(cw * k)); ch = Math.max(1, Math.round(ch * k)); };
    if (Math.max(cw, ch) > r.max) fit(r.max / Math.max(cw, ch));
    if (r.maxPixels && cw * ch > r.maxPixels) fit(Math.sqrt(r.maxPixels / (cw * ch)));
    if (r.minPixels && cw * ch < r.minPixels) {
        // too few pixels for the model: grow, but never past an edge or the area ceiling
        const k = Math.min(Math.sqrt(r.minPixels / (cw * ch)), r.max / Math.max(cw, ch));
        fit(k);
    }
    const snap = (v) => Math.max(r.step, Math.min(r.max, Math.round(v / r.step) * r.step));
    cw = snap(cw); ch = snap(ch);
    // rounding can drop back under the minimum: take the next step up on both edges
    while (r.minPixels && cw * ch < r.minPixels && cw + r.step <= r.max && ch + r.step <= r.max) { cw += r.step; ch += r.step; }
    // stepping in whole multiples drifts the ratio, and 3:1 is a hard refusal: widen the
    // short edge rather than cutting the long one, which also keeps the pixel floor met
    if (r.maxRatio) {
        const need = (long) => Math.min(r.max, Math.max(r.step, Math.ceil(long / r.maxRatio / r.step) * r.step));
        if (cw > ch * r.maxRatio) ch = need(cw);
        else if (ch > cw * r.maxRatio) cw = need(ch);
    }
    if (r.maxPixels && cw * ch > r.maxPixels) {
        while (cw * ch > r.maxPixels && cw > r.step && ch > r.step) { cw -= r.step; ch -= r.step; }
    }
    return [cw, ch];
}

function num(v, fallback) {
    const n = +v;
    return Number.isFinite(n) ? n : fallback;
}

/** [width, height] from a PNG's IHDR, or null for anything else. */
function pngSize(b) {
    if (!b || b.length < 24) return null;
    if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
    const v = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    return [v(16), v(20)];
}

/**
 * The seed as a route with a cap takes it, or undefined (no seed, or the Random seed row on): the editor's seed runs up
 * to 0xffffffff, Ideogram's cap is 2147483647 (Magnific, Replicate's `options.seed_max`).
 */
function seedOf(req, max) {
    if (max == null || req.seed == null || req.seed === "" || (req.params || {}).random_seed) return undefined;
    return (Number(req.seed) >>> 0) % (max + 1);
}

/** The tier ({ name: long side }) for a long side: the smallest that holds it, else the largest (Comfy Router, Magnific, WaveSpeed). */
function tierFor(long, tiers) {
    const list = Object.entries(tiers || {}).filter(([, v]) => +v > 0).sort((a, b) => a[1] - b[1]);
    if (!list.length) return null;
    const hit = list.find(([, v]) => +v >= long);
    return (hit || list[list.length - 1])[0];
}

/**
 * Refuses a crop steeper than the variant's `options.max_ratio` (Ideogram 4.5's 1:6 .. 6:1) before the first upload; the
 * recipe's limits.ratio widens a crop to it wherever the picture allows, so this only meets a picture too narrow to widen.
 */
function checkRatio(image, o, who) {
    const size = +(o || {}).max_ratio > 0 ? pngSize(Buffer.from(image || [])) : null;
    if (size && Math.max(size[0], size[1]) > +o.max_ratio * Math.min(size[0], size[1])) throw new Error(`${who} takes pictures no steeper than ${+o.max_ratio}:1; the crop is ${size[0]} × ${size[1]}, and the picture is too narrow to widen it. Nothing was sent.`);
}

/**
 * A picture held to the variant's `options.max_bytes` (Ideogram 4.5: 25 MB each): an opaque one over it goes as JPEG,
 * one with transparency or still over it as JPEG is refused before anything is sent. Answers { bytes, mime }.
 */
function withinBytes(bytes, what, o, ctx, who) {
    const max = +(o || {}).max_bytes > 0 ? +o.max_bytes : 0;
    if (!max || bytes.length <= max) return { bytes, mime: "image/png" };
    const opaque = typeof ctx.opaque === "function" && ctx.opaque(bytes);
    const jpeg = opaque && typeof ctx.toJpeg === "function" ? ctx.toJpeg(bytes, 92) : null;
    if (!jpeg || !jpeg.length || jpeg.length > max) {
        throw new Error(`${who}: the ${what} is ${(bytes.length / 1e6).toFixed(1)} MB, more than the ${Math.round(max / 1e6)} MB a picture may have${opaque ? " even as JPEG" : " (it has transparency, so it stays PNG)"}. Set Highres fix lower or use a smaller reference layer. Nothing was sent.`);
    }
    return { bytes: Buffer.from(jpeg), mime: "image/jpeg" };
}

/** The shape a text run asks for: `aspect` when it reads as W:H, else the size. */
function textShape(req) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(String(req.aspect || ""));
    if (m && +m[1] > 0 && +m[2] > 0) return [+m[1], +m[2]];
    return [Math.max(1, +req.width || 1024), Math.max(1, +req.height || 1024)];
}

/**
 * Ideogram's mask from Scumble's: Scumble's is white where to repaint, Ideogram's black ("Black regions indicate where
 * to edit"), of the picture's own size. Channel 0 at 128 or more becomes black, the rest white; always PNG. Answers
 * { png, edits, pixels } (`edits` the black pixels); throws when the mask cannot be read or differs from the picture in
 * size. Magnific's Ideogram Inpaint sends `png` as it is; Ideogram 4.5 goes through ideogramMask below.
 */
function blackEditMask(mask, image, ctx, who) {
    if (!mask || !mask.length) throw new Error(`${who} needs the selection as a mask.`);
    if (typeof ctx.bitmap !== "function" || typeof ctx.fromBitmap !== "function") throw new Error(`${who}: this build cannot read the mask.`);
    const bm = ctx.bitmap(mask);
    if (!bm || !bm.width || !bm.height) throw new Error(`${who}: the mask could not be read.`);
    const size = pngSize(Buffer.from(image || []));
    if (size && (size[0] !== bm.width || size[1] !== bm.height)) throw new Error(`${who}: the mask is ${bm.width} × ${bm.height} and the picture ${size[0]} × ${size[1]}; Ideogram takes a mask of the picture's own size.`);
    const n = bm.width * bm.height;
    const out = Buffer.alloc(n * 4);
    let edits = 0;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
        const v = bm.data[j] >= 128 ? 0 : 255;
        if (!v) edits++;
        out[j] = v; out[j + 1] = v; out[j + 2] = v; out[j + 3] = 255;
    }
    return { png: Buffer.from(ctx.fromBitmap({ width: bm.width, height: bm.height, data: out })), edits, pixels: n };
}

/**
 * The mask an Ideogram 4.5 edit sends (Replicate and WaveSpeed under `options.mask: "black"`, Comfy Router's ideogram
 * dialect by the model id `ideogram-4-5`): Ideogram refuses
 * a mask without both colours, so a selection over the whole picture sends none (null: the whole picture is edited and
 * the stitch keeps the selection), and one with no pixel at half strength is refused before anything is sent.
 */
function ideogramMask(mask, image, ctx, who) {
    const m = blackEditMask(mask, image, ctx, who);
    if (!m.edits) throw new Error(`${who}: the selection holds no pixel at half strength or more, so the model would have nothing to edit. Select the area to change.`);
    return m.edits === m.pixels ? null : m.png;
}

/**
 * What a run says when it has no usable key. `stale` (keys.js describe): a key stored on another PC or Windows account,
 * which DPAPI does not let this one read, is named as such and not as missing.
 */
function noKeyText(label, stale) {
    return stale
        ? `The ${label} key was stored on another PC or Windows account, so it cannot be read here: type it again under Settings › API providers.`
        : `No API key for ${label}. Add it under Settings › API providers.`;
}

module.exports = { dataUri, b64, fetchImage, downloadImage, pollJob, _times: TIMES, askStop, isAbort, retryAfterMs, scrub, readError, errorText, sleep, closestSize, closestAspect, editAspect, fitPixels, num, pngSize, seedOf, tierFor, checkRatio, withinBytes, textShape, blackEditMask, ideogramMask, noKeyText };
