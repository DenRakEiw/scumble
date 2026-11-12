// Polled-job and result-download resilience (review finding providers/PRV-1, money):
//   node -r ./tools/nonet.js tools/prv1_test.js
// Tests electron/main/providers/util.js (pollJob, downloadImage), fal.js (edit, upscale, relight),
// replicate.js (edit, generate), wavespeed.js (edit, generate), comfyrouter.js (download) and
// comfypartner.js (download) against scripted fake fetches in plain Node, with zero network.
"use strict";

const path = require("node:path");
const PROV = path.join(__dirname, "..", "electron", "main", "providers");
const util = require(path.join(PROV, "util.js"));
const GAP_MS = util._times.gapMs;
const fal = require(path.join(PROV, "fal.js"));
const replicate = require(path.join(PROV, "replicate.js"));
const wavespeed = require(path.join(PROV, "wavespeed.js"));
const bfl = require(path.join(PROV, "bfl.js"));
const router = require(path.join(PROV, "comfyrouter.js"));
const partner = require(path.join(PROV, "comfypartner.js"));

const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
]);

const results = [];
const allErrors = [];
const KEYS = [
    "fal_secret_key_9988776655",
    "r8_secret_token_9988776655",
    "ws_secret_key_9988776655",
    "test-comfy-secret-9988776655",
];

function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}

async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    try { await fn(); } catch (err) { check(`${name}: ran through`, false, (err && err.stack) || String(err)); }
}

async function throws(fn) {
    try {
        await fn();
        return null;
    } catch (err) {
        const msg = String((err && err.message) || err);
        allErrors.push(msg);
        return msg;
    }
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const html = (status, text, headers = {}) => new Response(text, { status, headers: { "content-type": "text/html", ...headers } });
const pngRes = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });

async function withGlobalFetch(fn, work) {
    const saved = globalThis.fetch;
    globalThis.fetch = fn;
    try { return await work(); } finally { globalThis.fetch = saved; }
}

// ---- 1. fal.js (edit, upscale, relight) ----

function makeFalRig({ id = "req-fal-77", cancelUrl, submit, status = [], result = [], download = [], cancel, signal } = {}) {
    const KEY = KEYS[0];
    const cancelHref = cancelUrl !== undefined ? cancelUrl : "https://queue.fal.run/m/requests/" + id + "/cancel";
    const statusQ = [...status];
    const resultQ = [...result];
    const dlQ = [...download];
    const sleeps = [];
    const calls = { submit: 0, status: 0, result: 0, download: 0, cancel: 0, afterAbort: 0 };
    const cancelCalls = [];

    async function fetch(url, init = {}) {
        const u = String(url);
        const method = String(init.method || "GET").toUpperCase();
        if (method === "PUT" && u.endsWith("/cancel")) {
            calls.cancel++;
            cancelCalls.push({ url: u, method, headers: init.headers || {}, redirect: init.redirect, signal: init.signal });
            if (cancel) return cancel(u, init);
            return json(200, { status: "CANCELED" });
        }
        if (signal && signal.aborted) {
            calls.afterAbort++;
            throw Object.assign(new Error("cancelled"), { name: "AbortError" });
        }
        if (method === "POST") {
            calls.submit++;
            if (submit) return submit();
            const body = { request_id: id, status: "IN_QUEUE", status_url: "https://queue.fal.run/m/requests/" + id + "/status", response_url: "https://queue.fal.run/m/requests/" + id };
            if (cancelHref) body.cancel_url = cancelHref;
            return json(200, body);
        }
        if (u.endsWith("/status")) {
            calls.status++;
            const step = statusQ.shift();
            if (step) return step();
            return json(200, { status: "COMPLETED" });
        }
        if (u.startsWith("https://queue.fal.run/")) {
            calls.result++;
            const step = resultQ.shift();
            if (step) return step();
            return json(200, { images: [{ url: "https://v3.fal.media/files/out.png", width: 64, height: 64, content_type: "image/png" }], seed: 11 });
        }
        if (u.startsWith("https://v3.fal.media/")) {
            calls.download++;
            const step = dlQ.shift();
            if (step) return step();
            return pngRes();
        }
        return json(404, { detail: "unknown route " + u });
    }

    const ctx = {
        key: KEY,
        fetch,
        signal: signal || null,
        sleep: async (ms) => { sleeps.push(ms); },
        log: () => {},
    };
    const req = { model: "fal-ai/flux-2/edit", kind: "edit", prompt: "a cat", image: PNG, references: [], width: 64, height: 64, seed: 11, params: {} };
    return { KEY, id, calls, cancelCalls, sleeps, ctx, req, fetch };
}

// ---- 2. replicate.js (edit) ----

function makeReplicateRig({ id = "pred-rep-88", cancelUrl, submit, status = [], download = [], cancel, signal } = {}) {
    const KEY = KEYS[1];
    const cancelHref = cancelUrl !== undefined ? cancelUrl : `https://api.replicate.com/v1/predictions/${id}/cancel`;
    const statusQ = [...status];
    const dlQ = [...download];
    const sleeps = [];
    const calls = { submit: 0, status: 0, download: 0, cancel: 0, afterAbort: 0 };
    const submitCalls = [];
    const cancelCalls = [];

    async function fetch(url, init = {}) {
        const u = String(url);
        const method = String(init.method || "GET").toUpperCase();
        if (method === "POST" && u.endsWith("/cancel")) {
            calls.cancel++;
            cancelCalls.push({ url: u, method, headers: init.headers || {}, redirect: init.redirect, signal: init.signal });
            if (cancel) return cancel(u, init);
            return json(200, { id, status: "canceled" });
        }
        if (signal && signal.aborted) {
            calls.afterAbort++;
            throw Object.assign(new Error("cancelled"), { name: "AbortError" });
        }
        if (method === "POST") {
            calls.submit++;
            submitCalls.push({ url: u, headers: init.headers || {} });
            if (submit) return submit();
            const urls = { get: `https://api.replicate.com/v1/predictions/${id}` };
            if (cancelHref) urls.cancel = cancelHref;
            return json(201, { id, status: "starting", urls });
        }
        if (u.startsWith("https://api.replicate.com/v1/predictions/")) {
            calls.status++;
            const step = statusQ.shift();
            if (step) return step();
            return json(200, { id, status: "succeeded", output: ["https://replicate.delivery/out.png"], metrics: { predict_time: 1.2 } });
        }
        if (u.startsWith("https://replicate.delivery/")) {
            calls.download++;
            const step = dlQ.shift();
            if (step) return step();
            return pngRes();
        }
        return json(404, { detail: "unknown route " + u });
    }

    const ctx = {
        key: KEY,
        fetch,
        signal: signal || null,
        sleep: async (ms) => { sleeps.push(ms); },
        log: () => {},
    };
    const req = { model: "black-forest-labs/flux-2-pro", kind: "edit", prompt: "a cat", image: PNG, references: [], width: 64, height: 64, seed: 11, params: {} };
    return { KEY, id, calls, submitCalls, cancelCalls, sleeps, ctx, req, fetch };
}

// ---- 3. wavespeed.js (edit) ----

function makeWaveSpeedRig({ id = "ws-job-99", submit, status = [], download = [], signal } = {}) {
    const KEY = KEYS[2];
    const statusQ = [...status];
    const dlQ = [...download];
    const sleeps = [];
    const calls = { upload: 0, submit: 0, status: 0, download: 0, afterAbort: 0 };

    async function fetch(url, init = {}) {
        if (signal && signal.aborted) {
            calls.afterAbort++;
            throw Object.assign(new Error("cancelled"), { name: "AbortError" });
        }
        const u = String(url);
        const method = String(init.method || "GET").toUpperCase();
        if (method === "POST" && u.endsWith("/media/uploads")) {
            calls.upload++;
            return json(200, { code: 200, data: { download_url: "https://cdn.wavespeed.test/in.png", upload: { url: "https://put.wavespeed.test/in.png", method: "PUT" } } });
        }
        if (method === "PUT" && u.startsWith("https://put.wavespeed.test/")) {
            return new Response(null, { status: 200 });
        }
        if (method === "POST" && u.startsWith("https://api.wavespeed.ai/api/v3/")) {
            calls.submit++;
            if (submit) return submit();
            return json(200, { code: 200, data: { id, status: "processing", urls: { get: `https://api.wavespeed.ai/api/v3/predictions/${id}/result` } } });
        }
        if (method === "GET" && u.includes("/predictions/")) {
            calls.status++;
            const step = statusQ.shift();
            if (step) return step();
            return json(200, { code: 200, data: { id, status: "completed", outputs: ["https://cdn.wavespeed.test/out.png"], timings: { inference: 500 } } });
        }
        if (u === "https://cdn.wavespeed.test/out.png") {
            calls.download++;
            const step = dlQ.shift();
            if (step) return step();
            return pngRes();
        }
        return json(404, { message: "unknown route " + u });
    }

    const ctx = {
        key: KEY,
        fetch,
        signal: signal || null,
        sleep: async (ms) => { sleeps.push(ms); },
        log: () => {},
    };
    const req = { model: "google/nano-banana-2/edit", kind: "edit", prompt: "a cat", image: PNG, references: [], width: 64, height: 64, seed: 11, params: {} };
    return { KEY, id, calls, sleeps, ctx, req };
}

async function testPolledAdapter(label, makeRig, runFn, statusPendingFn, statusFailedFn) {
    await section(`${label}: transient poll failures, reset, 6th failure, Retry-After`, async () => {
        // 1. A 500, 502, 408 and 425 in the middle of the poll still land the picture
        {
            const g = makeRig({
                status: [
                    () => html(500, "<html>500 Internal Server Error</html>"),
                    () => html(502, "<html>502 Bad Gateway</html>"),
                    () => json(408, { error: "Request Timeout" }),
                    () => json(425, { error: "Too Early" }),
                    () => statusPendingFn(),
                ],
            });
            const out = await runFn(g.req, g.ctx);
            check(`${label}: 500, 502, 408 and 425 in the middle of the poll land the picture, POST sent once`,
                Buffer.compare(out.bytes, PNG) === 0 && g.calls.submit === 1 && g.calls.status === 6 && g.calls.download === 1);
        }
        // 2. A thrown fetch in the middle of the poll still lands the picture
        {
            const g = makeRig({ status: [() => { throw new Error("fetch failed: ECONNRESET"); }, () => statusPendingFn()] });
            const out = await runFn(g.req, g.ctx);
            check(`${label}: thrown fetch in the middle of the poll lands the picture, POST sent once`,
                Buffer.compare(out.bytes, PNG) === 0 && g.calls.submit === 1 && g.calls.status === 3);
        }
        // 3. A 429 with Retry-After and a 200 non-JSON body are retried and Retry-After is respected
        {
            const g = makeRig({
                status: [
                    () => html(429, "rate limited", { "Retry-After": "7" }),
                    () => html(200, "<html>not json</html>"),
                ],
            });
            const out = await runFn(g.req, g.ctx);
            check(`${label}: 429 (Retry-After: 7 -> 7000 ms sleep) and non-JSON 200 body land the picture, POST sent once`,
                Buffer.compare(out.bytes, PNG) === 0 && g.calls.submit === 1 && g.calls.status === 3 && g.sleeps.includes(7000),
                JSON.stringify(g.sleeps));
        }
        // 4. Five failed reads in a row, then a good read (resets counter!), then 5 more failed reads in a row, then done -> lands
        {
            const five = (key) => [
                () => { throw new Error(`socket hang up (${key})`); },
                () => html(502, "Bad Gateway"),
                () => json(503, { error: "service unavailable " + key }),
                () => json(429, { error: "too many requests" }, { "retry-after": "3" }),
                () => html(200, "not valid json"),
            ];
            const g = makeRig({ status: [] });
            const seq = [...five(g.KEY), () => statusPendingFn(), ...five(g.KEY)];
            const g2 = makeRig({ status: seq });
            const out = await runFn(g2.req, g2.ctx);
            check(`${label}: 5 failures in a row + 1 good read (resets count) + 5 failures in a row + final read lands the picture, POST sent once`,
                Buffer.compare(out.bytes, PNG) === 0 && g2.calls.submit === 1 && g2.calls.status === 12 && g2.sleeps.includes(3000),
                `statuses=${g2.calls.status} submits=${g2.calls.submit}`);
        }
        util._times.gapMs = 15000;   // the gap window the old count of 5 misses gave (1+2+3+4+5 s of pauses)
        // 5. Six failed reads in a row (5 + 1 more) fails, names the request id, says job may still finish and be charged, scrubs key, and sleeps [1000,2000,3000,4000,5000]
        {
            let g;
            const failStep = () => html(502, `gateway down for ${g.KEY}`);
            g = makeRig({ status: [failStep, failStep, failStep, failStep, failStep, failStep] });
            const err = await throws(() => runFn(g.req, g.ctx));
            check(`${label}: 6 failed status reads in a row throws naming ${g.id}, sleeps [1000..5000], says job may still finish and be charged, key scrubbed, POST sent once`,
                !!err && err.includes(g.id) && /may still finish and be charged/.test(err) && !err.includes(g.KEY)
                && g.calls.submit === 1 && g.calls.status === 6
                && JSON.stringify(g.sleeps.slice(1)) === JSON.stringify([1000, 2000, 3000, 4000, 5000]),
                `${err} | sleeps=${JSON.stringify(g.sleeps)}`);
        }
        // 6. Six thrown fetches in a row also names the request id, scrubs key, and sleeps [1000,2000,3000,4000,5000]
        {
            let g;
            const throwStep = () => { throw new Error(`ECONNRESET with ${g.KEY}`); };
            g = makeRig({ status: [throwStep, throwStep, throwStep, throwStep, throwStep, throwStep] });
            const err = await throws(() => runFn(g.req, g.ctx));
            check(`${label}: 6 thrown status fetches in a row throws naming ${g.id}, sleeps [1000..5000], says job may still finish and be charged, key scrubbed, POST sent once`,
                !!err && err.includes(g.id) && /may still finish and be charged/.test(err) && !err.includes(g.KEY)
                && g.calls.submit === 1 && g.calls.status === 6
                && JSON.stringify(g.sleeps.slice(1)) === JSON.stringify([1000, 2000, 3000, 4000, 5000]),
                `${err} | sleeps=${JSON.stringify(g.sleeps)}`);
        }
        // 6b. Retry-After: 0 or a past HTTP-date falls back to the plain backoff [1000..5000], never 0 ms; Retry-After: 3600 is capped at 60000 ms
        {
            const zeroStep = (i) => html(503, "busy", { "Retry-After": i % 2 === 0 ? "0" : "Wed, 21 Oct 2015 07:28:00 GMT" });
            const gZero = makeRig({ status: [0, 1, 2, 3, 4, 5].map((i) => () => zeroStep(i)) });
            await throws(() => runFn(gZero.req, gZero.ctx));
            check(`${label}: six 503s with Retry-After: 0 / past date sleep the plain backoff [1000..5000]`,
                JSON.stringify(gZero.sleeps.slice(1)) === JSON.stringify([1000, 2000, 3000, 4000, 5000]),
                JSON.stringify(gZero.sleeps));

            const gCap = makeRig({
                status: [() => html(429, "rate limit", { "Retry-After": "3600" })],
                download: [() => html(502, "cdn busy", { "Retry-After": "7200" })],
            });
            const outCap = await runFn(gCap.req, gCap.ctx);
            check(`${label}: Retry-After: 3600 on status and 7200 on download are capped at 60000 ms`,
                Buffer.compare(outCap.bytes, PNG) === 0
                && gCap.sleeps.filter((ms) => ms === 60000).length === 2
                && gCap.sleeps.every((ms) => ms <= 60000),
                JSON.stringify(gCap.sleeps));
        }
        util._times.gapMs = GAP_MS;
        // 6c. Fake-clock timeout clamps remaining wait, asks to stop if supported, and throws naming request id
        {
            const realNow = Date.now;
            let fakeNow = 1_000_000;
            Date.now = () => fakeNow;
            try {
                const g = makeRig({
                    status: [
                        () => {
                            fakeNow = 1_000_000 + 15 * 60 * 1000 - 5000;
                            return html(429, `rate limited ${g.KEY}`, { "Retry-After": "60" });
                        },
                        () => statusPendingFn(),
                    ],
                });
                g.ctx.sleep = async (ms) => {
                    g.sleeps.push(ms);
                    fakeNow += ms;
                };
                const err = await throws(() => runFn(g.req, g.ctx));
                const hasStop = g.calls.cancel !== undefined;
                const stopOk = !hasStop || (g.calls.cancel === 1 && g.ctx.cancelAsked === true);
                const msgOk = hasStop ? /Scumble asked (fal\.ai|Replicate) to stop the job\./.test(err || "") : /may still finish and be charged/.test(err || "");
                check(`${label}: poll timeout clamps sleep to remaining 5000 ms, sends stop if supported, and throws naming ${g.id}`,
                    !!err && err.includes("timed out after 15 minutes") && err.includes(g.id)
                    && msgOk && !err.includes(g.KEY)
                    && g.sleeps.includes(5000) && !g.sleeps.includes(60000) && g.calls.submit === 1 && stopOk,
                    `${err} | sleeps=${JSON.stringify(g.sleeps)} calls=${JSON.stringify(g.calls)}`);
                if (hasStop) {
                    fakeNow = 1_000_000;
                    const gFail = makeRig({
                        status: [
                            () => {
                                fakeNow = 1_000_000 + 15 * 60 * 1000 - 5000;
                                return html(429, `rate limited ${gFail.KEY}`, { "Retry-After": "60" });
                            },
                            () => statusPendingFn(),
                        ],
                        cancel: () => json(500, { error: "stop failed" }),
                    });
                    gFail.ctx.sleep = async (ms) => {
                        gFail.sleeps.push(ms);
                        fakeNow += ms;
                    };
                    const errFail = await throws(() => runFn(gFail.req, gFail.ctx));
                    check(`${label}: poll timeout when stop returns 500 keeps 'the job may still finish and be charged' and leaves cancelAsked unset`,
                        !!errFail && errFail.includes("timed out after 15 minutes") && /may still finish and be charged/.test(errFail) && gFail.calls.cancel === 1 && !gFail.ctx.cancelAsked,
                        `${errFail} | calls=${JSON.stringify(gFail.calls)}`);
                }
            } finally {
                Date.now = realNow;
            }
        }
    });

    await section(`${label}: download retries (3 tries), definite failures, Cancel`, async () => {
        // 7. Failing download retried: 2 failures (thrown fetch, then 502 with Retry-After) then 3rd try succeeds
        {
            const g = makeRig({
                download: [
                    () => { throw new Error("CDN reset"); },
                    () => html(502, "CDN 502", { "retry-after": "4" }),
                ],
            });
            const out = await runFn(g.req, g.ctx);
            check(`${label}: 2 failed picture downloads then a good 3rd try lands the picture, POST sent once`,
                Buffer.compare(out.bytes, PNG) === 0 && g.calls.submit === 1 && g.calls.download === 3 && g.sleeps.includes(4000));
        }
        util._times.gapMs = 4500;    // the gap window the old 3 tries gave (1.5+3 s of pauses)
        // 8. 3 failed picture downloads (HTTP 503 without Retry-After, and thrown fetch) sleeps [1500, 3000] and throws naming request id and saying job may still finish and be charged
        {
            let g;
            const badDl = () => html(503, `CDN unavailable ${g.KEY}`);
            g = makeRig({ download: [badDl, badDl, badDl] });
            const err = await throws(() => runFn(g.req, g.ctx));
            check(`${label}: 3 failed picture downloads throws naming ${g.id}, sleeps [1500,3000], says job may still finish and be charged, key scrubbed, POST sent once`,
                !!err && err.includes(g.id) && /may still finish and be charged/.test(err) && !err.includes(g.KEY)
                && g.calls.submit === 1 && g.calls.download === 3
                && JSON.stringify(g.sleeps.slice(-2)) === JSON.stringify([1500, 3000]),
                `${err} | sleeps=${JSON.stringify(g.sleeps)}`);

            let gThrow;
            const throwDl = () => { throw new Error(`CDN socket hang up ${gThrow.KEY}`); };
            gThrow = makeRig({ download: [throwDl, throwDl, throwDl] });
            const errThrow = await throws(() => runFn(gThrow.req, gThrow.ctx));
            check(`${label}: 3 thrown picture downloads sleeps [1500,3000] and throws naming ${gThrow.id}, key scrubbed`,
                !!errThrow && errThrow.includes(gThrow.id) && /may still finish and be charged/.test(errThrow) && !errThrow.includes(gThrow.KEY)
                && gThrow.calls.download === 3
                && JSON.stringify(gThrow.sleeps.slice(-2)) === JSON.stringify([1500, 3000]),
                `${errThrow} | sleeps=${JSON.stringify(gThrow.sleeps)}`);
        }
        util._times.gapMs = GAP_MS;
        // 9. Cancel during the status retry's sleep ends at once and sends no further request
        {
            const ac = new AbortController();
            const g = makeRig({
                signal: ac.signal,
                status: [
                    () => html(502, "Bad Gateway"),
                    () => statusPendingFn(),
                ],
            });
            // On the retry sleep (the 2nd sleep: 1st is initial poll wait, 2nd is retry backoff after the 502), abort on a real timer
            let sleepCount = 0;
            g.ctx.sleep = (ms) => new Promise((resolve) => {
                sleepCount++;
                if (sleepCount === 2) setTimeout(() => ac.abort(), 15);
                setTimeout(resolve, sleepCount === 2 ? 10000 : 1);
            });
            const t0 = Date.now();
            const err = await throws(() => runFn(g.req, g.ctx));
            const elapsed = Date.now() - t0;
            const stopOk = g.calls.cancel === undefined || (g.calls.cancel === 1 && g.ctx.cancelAsked === true);
            check(`${label}: Cancel during status retry sleep ends at once (${elapsed} ms < 500 ms), asks provider to stop once, and sends no further poll`,
                /cancelled|aborted/i.test(err || "") && elapsed < 500 && g.calls.submit === 1 && g.calls.status === 1 && g.calls.download === 0 && g.calls.afterAbort === 0 && stopOk,
                `err=${err} elapsed=${elapsed}ms calls=${JSON.stringify(g.calls)}`);
        }
        // 10. Cancel during the download retry's sleep ends at once and sends no further request
        {
            const ac = new AbortController();
            const g = makeRig({
                signal: ac.signal,
                download: [
                    () => html(502, "CDN 502"),
                    () => pngRes(),
                ],
            });
            g.ctx.sleep = (ms) => new Promise((resolve) => {
                if (g.calls.download >= 1) {
                    setTimeout(() => ac.abort(), 15);
                    setTimeout(resolve, 10000);
                } else {
                    resolve();
                }
            });
            const t0 = Date.now();
            const err = await throws(() => runFn(g.req, g.ctx));
            const elapsed = Date.now() - t0;
            const doneOk = (g.calls.cancel === undefined || g.calls.cancel === 0) && g.ctx.jobDone === true && !g.ctx.cancelAsked;   // every adapter, WaveSpeed too (wavespeed-cancel-words-after-completion)
            check(`${label}: Cancel during download retry sleep ends at once (${elapsed} ms < 500 ms), sends no stop, and marks jobDone`,
                /cancelled|aborted/i.test(err || "") && elapsed < 500 && g.calls.submit === 1 && g.calls.download === 1 && g.calls.afterAbort === 0 && doneOk,
                `err=${err} elapsed=${elapsed}ms calls=${JSON.stringify(g.calls)}`);
        }
        // 11. An AbortError thrown directly by fetch (with or without ctx.signal) is never treated as a failed read to retry
        {
            const g = makeRig({
                status: [() => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }],
                download: [() => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }],
            });
            const err = await throws(() => runFn(g.req, g.ctx));
            check(`${label}: AbortError during status fetch ends at once without retry`,
                /cancelled|aborted/i.test(err || "") && g.calls.submit === 1 && g.calls.status === 1 && g.sleeps.length === 1);
            const gDl = makeRig({
                download: [() => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }],
            });
            const errDl = await throws(() => runFn(gDl.req, gDl.ctx));
            check(`${label}: AbortError during picture download ends at once without retry`,
                /cancelled|aborted/i.test(errDl || "") && gDl.calls.submit === 1 && gDl.calls.download === 1);
        }
        // 12. A failed job reported by the provider is not retried
        {
            let g;
            g = makeRig({ status: [() => statusFailedFn(g.KEY)] });
            const err = await throws(() => runFn(g.req, g.ctx));
            check(`${label}: provider-reported failed job ends at once without retry, key scrubbed, POST sent once`,
                !!err && /content blocked/.test(err) && !err.includes(g.KEY) && g.calls.submit === 1 && g.calls.status === 1 && g.calls.download === 0,
                err);
        }
        // 13. Definite HTTP 4xx on status poll (400, 401, 402, 403, 404, 422) is not retried and names request id
        for (const code of [400, 401, 402, 403, 404, 422]) {
            let g;
            g = makeRig({ status: [() => json(code, { error: `definite ${code} error with ${g.KEY}` })] });
            const err = await throws(() => runFn(g.req, g.ctx));
            check(`${label}: HTTP ${code} on status poll ends at once without retry, names ${g.id}, key scrubbed`,
                !!err && err.includes(`definite ${code} error`) && err.includes(g.id) && !err.includes(g.KEY) && g.calls.submit === 1 && g.calls.status === 1,
                err);
        }
        // 14. Failed submit POST is never retried (even on 502 / 429)
        for (const code of [429, 502]) {
            let g;
            g = makeRig({ submit: () => json(code, { error: `submit ${code} ${g.KEY}` }) });
            const err = await throws(() => runFn(g.req, g.ctx));
            check(`${label}: submit HTTP ${code} is never retried (POST sent once), key scrubbed`,
                !!err && !err.includes(g.KEY) && g.calls.submit === 1 && g.calls.status === 0);
        }
    });
}

async function main() {
    await testPolledAdapter(
        "fal.js",
        makeFalRig,
        (req, ctx) => withGlobalFetch(ctx.fetch, () => fal.edit(req, ctx)),
        () => json(200, { status: "IN_PROGRESS" }),
        (key) => json(200, { status: "FAILED", error: `content blocked (${key})` }),
    );

    await section("fal.js: resultUrl JSON retries (3 tries), upscale & relight download retries", async () => {
        // Result JSON tried 3 times: 2 failures (thrown fetch, then 429 with Retry-After) then success
        {
            const g = makeFalRig({
                result: [
                    () => { throw new Error("result socket reset"); },
                    () => html(429, "<html>result 429</html>", { "retry-after": "2" }),
                ],
            });
            const out = await fal.edit(g.req, g.ctx);
            check("fal.js: 2 failed resultUrl reads (thrown + 429) then a good 3rd read lands the picture, POST sent once",
                Buffer.compare(out.bytes, PNG) === 0 && g.calls.submit === 1 && g.calls.result === 3 && JSON.stringify(g.sleeps.slice(-2)) === JSON.stringify([1500, 2000]));
        }
        // Result JSON transient 500, 408 and 425 are retried
        for (const code of [500, 408, 425]) {
            const g = makeFalRig({ result: [() => html(code, `result ${code}`)] });
            const out = await fal.edit(g.req, g.ctx);
            check(`fal.js: HTTP ${code} on resultUrl is retried and lands the picture`,
                Buffer.compare(out.bytes, PNG) === 0 && g.calls.result === 2);
        }
        util._times.gapMs = 4500;    // the gap window the old 3 tries gave (1.5+3 s of pauses)
        // Result JSON fails all 3 times (HTTP 503 with Retry-After: 0, and thrown fetch) -> sleeps [1500, 3000], names request id and says job may still finish and be charged
        {
            let g;
            const badRes = () => html(503, `result unavailable ${g.KEY}`, { "Retry-After": "0" });
            g = makeFalRig({ result: [badRes, badRes, badRes] });
            const err = await throws(() => fal.edit(g.req, g.ctx));
            check("fal.js: 3 failed resultUrl reads sleeps [1500,3000] and throws naming request id and saying job may still finish and be charged, key scrubbed",
                !!err && err.includes(g.id) && /may still finish and be charged/.test(err) && !err.includes(g.KEY)
                && g.calls.submit === 1 && g.calls.result === 3
                && JSON.stringify(g.sleeps.slice(-2)) === JSON.stringify([1500, 3000]),
                `${err} | sleeps=${JSON.stringify(g.sleeps)}`);

            let gThrow;
            const throwRes = () => { throw new Error(`result reset ${gThrow.KEY}`); };
            gThrow = makeFalRig({ result: [throwRes, throwRes, throwRes] });
            const errThrow = await throws(() => fal.edit(gThrow.req, gThrow.ctx));
            check("fal.js: 3 thrown resultUrl reads sleeps [1500,3000] and throws naming request id, key scrubbed",
                !!errThrow && errThrow.includes(gThrow.id) && /may still finish and be charged/.test(errThrow) && !errThrow.includes(gThrow.KEY)
                && gThrow.calls.result === 3
                && JSON.stringify(gThrow.sleeps.slice(-2)) === JSON.stringify([1500, 3000]),
                `${errThrow} | sleeps=${JSON.stringify(gThrow.sleeps)}`);
        }
        util._times.gapMs = GAP_MS;
        // Result JSON definite 422 / 403 is not retried and names request id
        for (const code of [403, 422]) {
            let g;
            g = makeFalRig({ result: [() => json(code, { detail: `unusable image ${code} ${g.KEY}` })] });
            const err = await throws(() => fal.edit(g.req, g.ctx));
            check(`fal.js: HTTP ${code} on resultUrl ends at once without retry, names ${g.id}, key scrubbed`,
                !!err && err.includes(`unusable image ${code}`) && err.includes(g.id) && !err.includes(g.KEY) && g.calls.submit === 1 && g.calls.result === 1,
                err);
        }
        // fal.js status with s.error without FAILED ends at once without retry
        {
            let g;
            g = makeFalRig({ status: [() => json(200, { status: "IN_PROGRESS", error: `worker crashed (${g.KEY})` })] });
            const err = await throws(() => fal.edit(g.req, g.ctx));
            check("fal.js: status object with error field (without FAILED status) ends at once without retry, key scrubbed",
                !!err && /worker crashed/.test(err) && !err.includes(g.KEY) && g.calls.submit === 1 && g.calls.status === 1);
        }
        // fal.upscale and fal.relight also retry picture download 3 times and name request id on failure
        for (const [verb, extra] of [["upscale", { factor: 2 }], ["relight", {}]]) {
            const gOk = makeFalRig({ download: [() => html(502, "bad"), () => { throw new Error("drop"); }] });
            const out = await fal[verb]({ ...gOk.req, kind: verb, ...extra }, gOk.ctx);
            check(`fal.${verb}: 2 failed downloads then 3rd try succeeds`, Buffer.compare(out.bytes, PNG) === 0 && gOk.calls.download === 3);

            util._times.gapMs = 4500;    // the gap window the old 3 tries gave (1.5+3 s of pauses)
            const gFail = makeFalRig({ download: [() => html(502, "bad"), () => html(502, "bad"), () => html(502, "bad")] });
            const err = await throws(() => fal[verb]({ ...gFail.req, kind: verb, ...extra }, gFail.ctx));
            check(`fal.${verb}: 3 failed downloads throws naming ${gFail.id} and saying job may still finish and be charged`,
                !!err && err.includes(gFail.id) && /may still finish and be charged/.test(err) && gFail.calls.download === 3, err);
            util._times.gapMs = GAP_MS;
        }
    });

    await testPolledAdapter(
        "replicate.js",
        makeReplicateRig,
        (req, ctx) => withGlobalFetch(ctx.fetch, () => replicate.edit(req, ctx)),
        () => json(200, { status: "processing" }),
        (key) => json(200, { status: "failed", error: `content blocked (${key})` }),
    );

    await testPolledAdapter(
        "wavespeed.js",
        makeWaveSpeedRig,
        (req, ctx) => wavespeed.edit(req, ctx),
        () => json(200, { code: 200, data: { status: "processing" } }),
        (key) => json(200, { code: 200, data: { status: "failed", error: `content blocked (${key})` } }),
    );

    await section("replicate.js & wavespeed.js: terminal status edges & 200-char boundary key scrubbing", async () => {
        // fal.js resultUrl Retry-After: 86400 is capped at 60000 ms
        {
            const g = makeFalRig({ result: [() => html(429, "result rate limit", { "Retry-After": "86400" })] });
            const out = await fal.edit(g.req, g.ctx);
            check("fal.js: Retry-After: 86400 on resultUrl is capped at 60000 ms",
                Buffer.compare(out.bytes, PNG) === 0 && g.sleeps.slice(-1)[0] === 60000 && g.sleeps.every((ms) => ms <= 60000),
                JSON.stringify(g.sleeps));
        }
        // Replicate "canceled" status ends at once without retry
        {
            let g;
            g = makeReplicateRig({ status: [() => json(200, { status: "canceled", error: `user canceled (${g.KEY})` })] });
            const err = await throws(() => replicate.edit(g.req, g.ctx));
            check("replicate.js: status 'canceled' ends at once without retry, key scrubbed",
                !!err && /user canceled/.test(err) && !err.includes(g.KEY) && g.calls.submit === 1 && g.calls.status === 1);
        }
        // WaveSpeed "cancelled", "timeout", "deleted" statuses each end at once without retry
        for (const st of ["cancelled", "timeout", "deleted"]) {
            let g;
            g = makeWaveSpeedRig({ status: [() => json(200, { code: 200, data: { status: st, error: `job ${st} (${g.KEY})` } })] });
            const err = await throws(() => wavespeed.edit(g.req, g.ctx));
            check(`wavespeed.js: status '${st}' ends at once without retry, key scrubbed`,
                !!err && err.includes(`job ${st}`) && !err.includes(g.KEY) && g.calls.submit === 1 && g.calls.status === 1);
        }
        // Key straddling the 200-char JSON slice boundary is scrubbed before slicing across fal, replicate, wavespeed
        {
            const straddlePad = (makeObj, key) => {
                const base = JSON.stringify(makeObj("")).indexOf(key);
                return "x".repeat(Math.max(0, 192 - base));
            };

            let gFalSub;
            gFalSub = makeFalRig({
                submit: () => {
                    const mk = (p) => ({ note: p + gFalSub.KEY });
                    return json(200, mk(straddlePad(mk, gFalSub.KEY)));
                },
            });
            const e1 = await throws(() => fal.edit(gFalSub.req, gFalSub.ctx));
            check("fal.js: key straddling 200-char cut in submit JSON without status_url is scrubbed before slice",
                !!e1 && e1.includes("[key]") && !e1.includes(gFalSub.KEY.slice(0, 8)), e1);

            for (const [verb, extra] of [["edit", {}], ["upscale", { factor: 2 }], ["relight", {}]]) {
                let gFalOut;
                gFalOut = makeFalRig({
                    result: [() => {
                        const mk = (p) => ({ note: p + gFalOut.KEY, images: [] });
                        return json(200, mk(straddlePad(mk, gFalOut.KEY)));
                    }],
                });
                const eOut = await throws(() => fal[verb]({ ...gFalOut.req, kind: verb, ...extra }, gFalOut.ctx));
                check(`fal.${verb}: key straddling 200-char cut in empty result JSON is scrubbed before slice`,
                    !!eOut && eOut.includes("[key]") && !eOut.includes(gFalOut.KEY.slice(0, 8)), eOut);
            }

            let gRepOut;
            gRepOut = makeReplicateRig({
                status: [() => {
                    const mk = (p) => ({ note: p + gRepOut.KEY });
                    return json(200, { id: "p1", status: "succeeded", output: mk(straddlePad(mk, gRepOut.KEY)) });
                }],
            });
            const eRep = await throws(() => replicate.edit(gRepOut.req, gRepOut.ctx));
            check("replicate.js: key straddling 200-char cut in empty output JSON is scrubbed before slice",
                !!eRep && eRep.includes("[key]") && !eRep.includes(gRepOut.KEY.slice(0, 8)), eRep);

            let gWsSub;
            gWsSub = makeWaveSpeedRig({
                submit: () => {
                    const mk = (p) => ({ code: 200, data: { note: p + gWsSub.KEY } });
                    return json(200, mk(straddlePad(mk, gWsSub.KEY)));
                },
            });
            const eWs1 = await throws(() => wavespeed.edit(gWsSub.req, gWsSub.ctx));
            check("wavespeed.js: key straddling 200-char cut in submit JSON without id is scrubbed before slice",
                !!eWs1 && eWs1.includes("[key]") && !eWs1.includes(gWsSub.KEY.slice(0, 8)), eWs1);

            let gWsOut;
            gWsOut = makeWaveSpeedRig({
                status: [() => {
                    const full = (p) => ({
                        id: "ws-job-99",
                        status: "completed",
                        urls: { get: "https://api.wavespeed.ai/api/v3/predictions/ws-job-99/result" },
                        note: p + gWsOut.KEY,
                        outputs: [],
                    });
                    return json(200, { code: 200, data: full(straddlePad(full, gWsOut.KEY)) });
                }],
            });
            const eWs2 = await throws(() => wavespeed.edit(gWsOut.req, gWsOut.ctx));
            check("wavespeed.js: key straddling 200-char cut in result JSON without outputs is scrubbed before slice",
                !!eWs2 && eWs2.includes("[key]") && !eWs2.includes(gWsOut.KEY.slice(0, 8)), eWs2);
        }
    });

    await section("comfyrouter.js and comfypartner.js: download retries (3 tries), Cancel, request id", async () => {
        const BASE = "http://127.0.0.1:5598";
        const KEY = KEYS[3];

        function makeComfyRig({ rid = "cr-req-55", hyId = "hy-req-66", downloads = [], signal } = {}) {
            const dlQ = [...downloads];
            const sleeps = [];
            const calls = { submit: 0, hy: 0, download: 0, afterAbort: 0 };

            async function fetch(url, init = {}) {
                if ((signal && signal.aborted) || (init.signal && init.signal.aborted)) {
                    calls.afterAbort++;
                    throw Object.assign(new Error("cancelled"), { name: "AbortError" });
                }
                const u = new URL(String(url));
                const method = String(init.method || "GET").toUpperCase();
                if (u.pathname.startsWith("/asset/")) {
                    calls.download++;
                    const step = dlQ.shift();
                    if (step) return step();
                    return pngRes();
                }
                if (method === "POST" && u.pathname === "/customers/storage") {
                    return json(200, { upload_url: `${BASE}/upload/1`, download_url: `${BASE}/stored/1.png` });
                }
                if (method === "PUT" && u.pathname.startsWith("/upload/")) {
                    return new Response(null, { status: 200 });
                }
                if (method === "POST" && u.pathname === partner.HY_PATH) {
                    calls.hy++;
                    return json(200, { choices: [{ delta: { image: { url: `${BASE}/asset/hy.png`, width: 64, height: 64 } } }], request_id: hyId });
                }
                if (method === "POST" && u.pathname.endsWith("/requests")) {
                    calls.submit++;
                    return json(201, { request_id: rid, status: "IN_QUEUE", queue_position: 0 }, { "x-comfy-request-id": rid });
                }
                if (method === "GET" && u.pathname.endsWith("/status")) {
                    return json(200, { request_id: rid, status: "COMPLETED", queue_position: 0 });
                }
                if (method === "GET" && u.pathname.includes("/requests/")) {
                    return json(200, { id: "bfl-1", status: "Ready", result: { sample: `${BASE}/asset/bfl.png`, seed: 7 } });
                }
                return json(404, { detail: "not found" });
            }

            const ctx = {
                key: KEY,
                base: BASE,
                fetch,
                signal: signal || null,
                sleep: async (ms) => { sleeps.push(ms); },
                log: () => {},
            };
            return { rid, hyId, calls, sleeps, ctx, fetch };
        }

        const crReq = { model: "bfl/flux-2-pro", kind: "edit", prompt: "a cat", image: PNG, references: [], width: 64, height: 64, seed: 7, params: {} };
        const hyReq = { model: "hy-image-v3.5-preview", kind: "edit", prompt: "a cat", image: PNG, references: [], width: 512, height: 512, seed: 7, params: {} };

        // 1. Comfy Router download: 2 failures then 3rd try lands
        {
            const g = makeComfyRig({ downloads: [() => { throw new Error("socket closed"); }, () => html(502, "bad gateway")] });
            const out = await withGlobalFetch(g.fetch, () => router.edit(crReq, g.ctx));
            check("comfyrouter.js: 2 failed asset downloads then 3rd try lands the picture, submit sent once",
                Buffer.compare(out.bytes, PNG) === 0 && g.calls.submit === 1 && g.calls.download === 3);
        }
        util._times.gapMs = 4500;    // the gap window the old 3 tries gave (1.5+3 s of pauses)
        // 2. Comfy Router download: 3 failures throws naming request_id and saying job may still finish and be charged
        {
            const bad = () => html(503, `storage error ${KEY}`);
            const g = makeComfyRig({ downloads: [bad, bad, bad] });
            const err = await withGlobalFetch(g.fetch, () => throws(() => router.edit(crReq, g.ctx)));
            check("comfyrouter.js: 3 failed asset downloads throws naming request_id and saying job may still finish and be charged, key scrubbed",
                !!err && err.includes(g.rid) && /may still finish and be charged/.test(err) && !err.includes(KEY) && g.calls.submit === 1 && g.calls.download === 3,
                err);
        }
        util._times.gapMs = GAP_MS;
        // 3. Comfy Router download: Cancel during download retry sleep stops at once and sends no further request
        {
            const ac = new AbortController();
            const g = makeComfyRig({ signal: ac.signal, downloads: [() => html(502, "bad"), () => pngRes()] });
            g.ctx.sleep = () => new Promise((resolve) => {
                setTimeout(() => ac.abort(), 15);
                setTimeout(resolve, 10000);
            });
            const t0 = Date.now();
            const err = await withGlobalFetch(g.fetch, () => throws(() => router.edit(crReq, g.ctx)));
            const elapsed = Date.now() - t0;
            check(`comfyrouter.js: Cancel during download retry sleep stops at once (${elapsed} ms < 500 ms) and sends no further download`,
                /cancelled|aborted/i.test(err || "") && elapsed < 500 && g.calls.submit === 1 && g.calls.download === 1 && g.calls.afterAbort === 0,
                `err=${err} elapsed=${elapsed}ms calls=${JSON.stringify(g.calls)}`);
        }
        // 4. Comfy Partner API download: 2 failures then 3rd try lands
        {
            const g = makeComfyRig({ downloads: [() => html(502, "bad"), () => { throw new Error("ECONNRESET"); }] });
            const out = await partner.edit(hyReq, g.ctx);
            check("comfypartner.js: 2 failed asset downloads then 3rd try lands the picture, generation POST sent once",
                Buffer.compare(out.bytes, PNG) === 0 && g.calls.hy === 1 && g.calls.download === 3);
        }
        util._times.gapMs = 4500;    // the gap window the old 3 tries gave (1.5+3 s of pauses)
        // 5. Comfy Partner API download: 3 failures throws naming request_id and saying job may still finish and be charged
        {
            const bad = () => html(502, `partner cdn error ${KEY}`);
            const g = makeComfyRig({ downloads: [bad, bad, bad] });
            const err = await throws(() => partner.edit(hyReq, g.ctx));
            check("comfypartner.js: 3 failed asset downloads throws naming request_id and saying job may still finish and be charged, key scrubbed",
                !!err && err.includes(g.hyId) && /may still finish and be charged/.test(err) && !err.includes(KEY) && g.calls.hy === 1 && g.calls.download === 3,
                err);
        }
        util._times.gapMs = GAP_MS;
        // 6. Comfy Partner API download: Cancel during download retry sleep stops at once and sends no further request
        {
            const ac = new AbortController();
            const g = makeComfyRig({ signal: ac.signal, downloads: [() => html(502, "bad"), () => pngRes()] });
            g.ctx.sleep = () => new Promise((resolve) => {
                setTimeout(() => ac.abort(), 15);
                setTimeout(resolve, 10000);
            });
            const t0 = Date.now();
            const err = await throws(() => partner.edit(hyReq, g.ctx));
            const elapsed = Date.now() - t0;
            check(`comfypartner.js: Cancel during download retry sleep stops at once (${elapsed} ms < 500 ms) and sends no further download`,
                /cancelled|aborted/i.test(err || "") && elapsed < 500 && g.calls.hy === 1 && g.calls.download === 1 && g.calls.afterAbort === 0,
                `err=${err} elapsed=${elapsed}ms calls=${JSON.stringify(g.calls)}`);
        }
    });

    await section("util.js: readError & errorText strip input fields, scrub before 500-char cut (PRV-5)", async () => {
        const key = KEYS[0];
        const hugeUri = "data:image/png;base64," + "A".repeat(20000);
        const detail422 = {
            detail: [{
                type: "value_error",
                loc: ["body", "image_url"],
                input: hugeUri,
                msg: `Image decode failed (${key})`,
            }],
        };
        const r422 = json(422, detail422);
        const fromRead = await util.readError(r422, key);
        const fromText = util.errorText(r422, JSON.stringify(detail422), detail422, key);
        check("readError strips 'input' field from 422 detail array, keeps msg/loc, scrubs key, and stays <= 500 chars",
            fromRead.includes("Image decode failed ([key])") && fromRead.includes("image_url") && !fromRead.includes("base64") && !fromRead.includes(key) && fromRead.length <= 500,
            `len=${fromRead.length} out=${fromRead}`);
        check("errorText strips 'input' field from 422 detail array identically to readError",
            fromText === fromRead,
            `len=${fromText.length} out=${fromText}`);

        // Long JSON error string (>500 chars) with key straddling the 500-char cut boundary
        const straddle = "x".repeat(492) + key + "y".repeat(200);
        const bodyLong = { error: { message: straddle } };
        const rLong = json(400, bodyLong);
        const outRead = await util.readError(rLong, key);
        const outText = util.errorText(rLong, JSON.stringify(bodyLong), bodyLong, key);
        check("readError cuts JSON error message to 500 chars after scrubbing key straddling the 500-char cut",
            outRead.length === 500 && outRead.includes("[key]") && !outRead.includes(key.slice(0, 6)),
            `len=${outRead.length} tail=${outRead.slice(485)}`);
        check("errorText cuts JSON error message to 500 chars after scrubbing key straddling the 500-char cut",
            outText === outRead,
            `len=${outText.length} tail=${outText.slice(485)}`);
    });

    await section("fal.js, replicate.js & bfl.js: provider stop on Cancel/timeout & BFL Cancel (PRV-3)", async () => {
        // 1. Cancel while polling sends PUT (fal) / POST (Replicate) with auth, redirect: "error", timeout signal, sets cancelAsked on 2xx without reading body
        for (const [label, makeRig, runFn, wantMethod, wantHost, wantAuthPrefix] of [
            ["fal.js", makeFalRig, (r, c) => fal.edit(r, c), "PUT", "queue.fal.run", "Key "],
            ["replicate.js", makeReplicateRig, (r, c) => replicate.edit(r, c), "POST", "api.replicate.com", "Bearer "],
        ]) {
            let bodyRead = false;
            const ac = new AbortController();
            const g = makeRig({
                signal: ac.signal,
                cancel: async () => ({
                    ok: true,
                    status: 200,
                    text() { bodyRead = true; throw new Error("cancel body should not be read"); },
                    json() { bodyRead = true; throw new Error("cancel body should not be read"); },
                }),
            });
            g.ctx.sleep = async () => { ac.abort(); };
            const err = await withGlobalFetch(g.fetch, () => throws(() => runFn(g.req, g.ctx)));
            const c = g.cancelCalls[0];
            const noPrefer = !g.submitCalls || !Object.keys((g.submitCalls[0] && g.submitCalls[0].headers) || {}).some((k) => k.toLowerCase() === "prefer");
            check(`${label}: Cancel while queued sends ${wantMethod} to ${wantHost} with auth & redirect=error, sets cancelAsked=true without reading body, POST counted once (no Prefer wait header)`,
                /cancelled|aborted/i.test(err || "") && g.calls.submit === 1 && g.calls.cancel === 1 && g.ctx.cancelAsked === true && !g.ctx.jobDone && !bodyRead && noPrefer
                && c && c.method === wantMethod && new URL(c.url).hostname === wantHost && c.headers.Authorization === wantAuthPrefix + g.KEY && c.redirect === "error" && !!c.signal,
                JSON.stringify({ err, calls: g.calls, cancelAsked: g.ctx.cancelAsked, c }));

            // 2. Failed stop request (HTTP 500 or thrown network error) is silent and leaves cancelAsked unset
            for (const failCancel of [
                () => json(500, { error: "internal error" }),
                () => Promise.reject(new Error("cancel socket hang up")),
            ]) {
                const acFail = new AbortController();
                const gFail = makeRig({ signal: acFail.signal, cancel: failCancel });
                gFail.ctx.sleep = async () => { acFail.abort(); };
                const errFail = await withGlobalFetch(gFail.fetch, () => throws(() => runFn(gFail.req, gFail.ctx)));
                check(`${label}: failed stop request is silent and leaves cancelAsked unset`,
                    /cancelled|aborted/i.test(errFail || "") && gFail.calls.submit === 1 && gFail.calls.cancel === 1 && !gFail.ctx.cancelAsked && !gFail.ctx.jobDone,
                    JSON.stringify({ errFail, calls: gFail.calls, cancelAsked: gFail.ctx.cancelAsked }));
            }

            // 3. Cancel during the submit POST sends no stop and sets neither cancelAsked nor jobDone
            {
                const acSub = new AbortController();
                const gSub = makeRig({
                    signal: acSub.signal,
                    submit: () => {
                        acSub.abort();
                        throw Object.assign(new Error("cancelled"), { name: "AbortError" });
                    },
                });
                const errSub = await withGlobalFetch(gSub.fetch, () => throws(() => runFn(gSub.req, gSub.ctx)));
                check(`${label}: Cancel during submit POST sends no stop and leaves cancelAsked/jobDone unset`,
                    /cancelled|aborted/i.test(errSub || "") && gSub.calls.submit === 1 && gSub.calls.cancel === 0 && !gSub.ctx.cancelAsked && !gSub.ctx.jobDone,
                    JSON.stringify({ errSub, calls: gSub.calls }));
            }

            // 4. Untrusted cancel_url / urls.cancel (http:, wrong or lookalike host, or credentials) sends nothing
            for (const badUrl of [
                `http://${wantHost}/v1/cancel`,
                "https://evil.example/v1/cancel",
                `https://${wantHost}.evil.example/v1/cancel`,
                `https://x${wantHost}/v1/cancel`,
                `https://user:pw@${wantHost}/v1/cancel`,
            ]) {
                const acBad = new AbortController();
                const gBad = makeRig({ signal: acBad.signal, cancelUrl: badUrl });
                gBad.ctx.sleep = async () => { acBad.abort(); };
                const errBad = await withGlobalFetch(gBad.fetch, () => throws(() => runFn(gBad.req, gBad.ctx)));
                check(`${label}: untrusted cancel URL (${badUrl}) sends no stop request`,
                    /cancelled|aborted/i.test(errBad || "") && gBad.calls.cancel === 0 && !gBad.ctx.cancelAsked,
                    JSON.stringify({ badUrl, calls: gBad.calls }));
            }
        }

        // 5. A stop fake that never answers ends the run within ~2 s without setting cancelAsked, and a late rejection after the race is swallowed (tested in parallel for fal & Replicate)
        {
            const lateRejectors = [];
            const runHangingCancel = async (makeRig, runFn) => {
                const ac = new AbortController();
                const g = makeRig({ signal: ac.signal });
                g.ctx.sleep = async () => { ac.abort(); };
                const t0 = Date.now();
                const err = await throws(() => runFn(g.req, g.ctx));
                const elapsed = Date.now() - t0;
                return { err, elapsed, g };
            };
            const saved = globalThis.fetch;
            let falCalls = 0, repCalls = 0;
            globalThis.fetch = (url) => {
                if (String(url).includes("queue.fal.run")) {
                    falCalls++;
                    return new Promise((_, rej) => { lateRejectors.push(rej); });
                }
                if (String(url).includes("api.replicate.com")) {
                    repCalls++;
                    return new Promise((_, rej) => { lateRejectors.push(rej); });
                }
                return Promise.reject(new Error("unexpected url " + url));
            };
            try {
                const [fRes, rRes] = await Promise.all([
                    runHangingCancel(makeFalRig, (r, c) => fal.edit(r, c)),
                    runHangingCancel(makeReplicateRig, (r, c) => replicate.edit(r, c)),
                ]);
                for (const rej of lateRejectors) rej(new Error("late cancel failure after 2s race"));
                await new Promise((r) => setTimeout(r, 20));
                check(`fal.js: hanging stop request ends within ~2 s (${fRes.elapsed} ms) without cancelAsked and swallows late rejection`,
                    /cancelled|aborted/i.test(fRes.err || "") && fRes.elapsed >= 1800 && fRes.elapsed < 2800 && falCalls === 1 && !fRes.g.ctx.cancelAsked,
                    `elapsed=${fRes.elapsed}ms falCalls=${falCalls}`);
                check(`replicate.js: hanging stop request ends within ~2 s (${rRes.elapsed} ms) without cancelAsked and swallows late rejection`,
                    /cancelled|aborted/i.test(rRes.err || "") && rRes.elapsed >= 1800 && rRes.elapsed < 2800 && repCalls === 1 && !rRes.g.ctx.cancelAsked,
                    `elapsed=${rRes.elapsed}ms repCalls=${repCalls}`);
            } finally {
                globalThis.fetch = saved;
            }
        }

        // 6. Cancel after COMPLETED (fal: during resultUrl fetch and during upscale/relight download) or succeeded (Replicate: immediate submit succeeded) sends no stop and sets jobDone = true
        {
            const acRes = new AbortController();
            const gRes = makeFalRig({
                signal: acRes.signal,
                result: [() => {
                    acRes.abort();
                    throw Object.assign(new Error("cancelled"), { name: "AbortError" });
                }],
            });
            const errRes = await withGlobalFetch(gRes.fetch, () => throws(() => fal.edit(gRes.req, gRes.ctx)));
            check("fal.js: Cancel during resultUrl read (after COMPLETED) sends no stop and sets ctx.jobDone = true",
                /cancelled|aborted/i.test(errRes || "") && gRes.calls.cancel === 0 && gRes.ctx.jobDone === true && !gRes.ctx.cancelAsked,
                JSON.stringify({ calls: gRes.calls, jobDone: gRes.ctx.jobDone }));

            for (const [verb, extra] of [["upscale", { factor: 2 }], ["relight", {}]]) {
                const acDl = new AbortController();
                const gDl = makeFalRig({
                    signal: acDl.signal,
                    download: [() => {
                        acDl.abort();
                        throw Object.assign(new Error("cancelled"), { name: "AbortError" });
                    }],
                });
                const errDl = await withGlobalFetch(gDl.fetch, () => throws(() => fal[verb]({ ...gDl.req, kind: verb, ...extra }, gDl.ctx)));
                check(`fal.${verb}: Cancel during picture download (after COMPLETED) sends no stop and sets ctx.jobDone = true`,
                    /cancelled|aborted/i.test(errDl || "") && gDl.calls.cancel === 0 && gDl.ctx.jobDone === true && !gDl.ctx.cancelAsked,
                    JSON.stringify({ calls: gDl.calls, jobDone: gDl.ctx.jobDone }));
            }

            const acRep = new AbortController();
            const gRep = makeReplicateRig({
                signal: acRep.signal,
                submit: () => json(201, {
                    id: "pred-sync-1",
                    status: "succeeded",
                    output: ["https://replicate.delivery/out.png"],
                    urls: { get: "https://api.replicate.com/v1/predictions/pred-sync-1", cancel: "https://api.replicate.com/v1/predictions/pred-sync-1/cancel" },
                }),
                download: [() => {
                    acRep.abort();
                    throw Object.assign(new Error("cancelled"), { name: "AbortError" });
                }],
            });
            const errRep = await withGlobalFetch(gRep.fetch, () => throws(() => replicate.edit(gRep.req, gRep.ctx)));
            check("replicate.js: Cancel during picture download after synchronous submit succeeded sends no stop and sets ctx.jobDone = true",
                /cancelled|aborted/i.test(errRep || "") && gRep.calls.cancel === 0 && gRep.ctx.jobDone === true && !gRep.ctx.cancelAsked,
                JSON.stringify({ calls: gRep.calls, jobDone: gRep.ctx.jobDone }));
        }

        // 7. bfl.js uses (ctx.sleep || sleep) at all 3 places and rethrows on ctx.signal.aborted during poll or download retry
        {
            const bflKey = "bfl_secret_key_9988776655";
            KEYS.push(bflKey);
            const makeBflRig = ({ signal, polls = [], downloads = [] } = {}) => {
                const pollQ = [...polls];
                const dlQ = [...downloads];
                const sleeps = [];
                const calls = { submit: 0, poll: 0, download: 0 };
                const fetch = async (url) => {
                    if (signal && signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
                    const u = String(url);
                    if (u.includes("/v1/flux-2-pro")) {
                        calls.submit++;
                        return json(200, { id: "bfl-job-1", polling_url: "https://api.bfl.ai/v1/get_result?id=bfl-job-1" });
                    }
                    if (u.includes("/v1/get_result")) {
                        calls.poll++;
                        const step = pollQ.shift();
                        if (step) return step();
                        return json(200, { status: "Ready", result: { sample: "https://delivery.bfl.ai/out.png", seed: 42 } });
                    }
                    if (u.includes("delivery.bfl.ai")) {
                        calls.download++;
                        const step = dlQ.shift();
                        if (step) return step();
                        return pngRes();
                    }
                    return json(404, { detail: "not found" });
                };
                const ctx = { key: bflKey, fetch, signal: signal || null, sleep: async (ms) => { sleeps.push(ms); }, log: () => {} };
                const req = { model: "flux-2-pro", kind: "edit", prompt: "a cat", image: PNG, references: [], width: 64, height: 64, seed: 42, params: {} };
                return { ctx, req, sleeps, calls };
            };

            // 7a. All 3 sleep sites (poll 1000, retry 1000*misses, download retry 1500) go through ctx.sleep
            const gOk = makeBflRig({
                polls: [() => html(502, "bad gateway")],
                downloads: [() => html(502, "cdn busy")],
            });
            const t0Ok = Date.now();
            const outOk = await bfl.edit(gOk.req, gOk.ctx);
            const elapsedOk = Date.now() - t0Ok;
            check(`bfl.js: poll wait, poll retry and download retry all use ctx.sleep ([1000,1000,1000,1500] in ${elapsedOk} ms)`,
                Buffer.compare(outOk.bytes, PNG) === 0 && elapsedOk < 500 && JSON.stringify(gOk.sleeps) === JSON.stringify([1000, 1000, 1000, 1500]),
                JSON.stringify({ sleeps: gOk.sleeps, calls: gOk.calls, elapsedOk }));

            // 7b. Cancel during BFL status poll rethrows at once instead of retrying 5 times (~21 s)
            const acPoll = new AbortController();
            const gPoll = makeBflRig({
                signal: acPoll.signal,
                polls: [() => {
                    acPoll.abort();
                    throw new Error("socket closed on abort");
                }],
            });
            const t0Poll = Date.now();
            const errPoll = await throws(() => bfl.edit(gPoll.req, gPoll.ctx));
            const elapsedPoll = Date.now() - t0Poll;
            check(`bfl.js: Cancel during status poll rethrows at once without retrying (calls.poll=${gPoll.calls.poll}, sleeps=${JSON.stringify(gPoll.sleeps)})`,
                !!errPoll && gPoll.calls.poll === 1 && gPoll.sleeps.length === 1 && elapsedPoll < 200,
                JSON.stringify({ errPoll, calls: gPoll.calls, sleeps: gPoll.sleeps }));

            // 7c. Cancel during BFL picture download rethrows at once without retrying
            const acDl = new AbortController();
            const gDl = makeBflRig({
                signal: acDl.signal,
                downloads: [() => {
                    acDl.abort();
                    throw new Error("download aborted");
                }],
            });
            const errDl = await throws(() => bfl.edit(gDl.req, gDl.ctx));
            check(`bfl.js: Cancel during picture download rethrows at once without retrying (calls.download=${gDl.calls.download})`,
                !!errDl && gDl.calls.download === 1 && JSON.stringify(gDl.sleeps) === JSON.stringify([1000]),
                JSON.stringify({ errDl, calls: gDl.calls, sleeps: gDl.sleeps }));
        }
    });

    // review finding providers/polljob-deadline-before-reread (money): reads with no answer go on for the gap window,
    // the run's time is checked only after an answered read, a read has its own time, no stop after an unanswered end
    await section("pollJob / downloadImage: the gap window, the deadline after an answered read", async () => {
        const realNow = Date.now;
        // 1. The machine slept past the 15 minutes; the first read after the wake gets no answer (Wi-Fi coming back),
        //    the next says COMPLETED: the picture lands and no stop is sent
        try {
            let fakeNow = 1_000_000;
            Date.now = () => fakeNow;
            let g;
            g = makeFalRig({
                status: [
                    () => json(200, { status: "IN_PROGRESS" }),
                    () => { throw new Error("getaddrinfo ENOTFOUND queue.fal.run"); },
                    () => json(200, { status: "COMPLETED" }),
                ],
            });
            let n = 0;
            g.ctx.sleep = async (ms) => { g.sleeps.push(ms); if (++n === 2) fakeNow += 20 * 60 * 1000; else fakeNow += ms; };
            const out = await withGlobalFetch(g.ctx.fetch, () => fal.edit(g.req, g.ctx));
            check("fal.js: a sleep past the run's time, then one unanswered read, then COMPLETED lands the picture and sends no stop",
                Buffer.compare(out.bytes, PNG) === 0 && g.calls.cancel === 0 && !g.ctx.cancelAsked,
                JSON.stringify({ calls: g.calls, sleeps: g.sleeps }));
        } catch (err) {
            check("fal.js: a sleep past the run's time, then one unanswered read, then COMPLETED lands the picture and sends no stop", false, String(err && err.message || err));
        } finally {
            Date.now = realNow;
        }
        // 2. A network gone for about 30 s (seven thrown reads, 1+2+...+7 s of pauses) still lands the picture
        {
            const drop = () => { throw new Error("fetch failed: ECONNRESET"); };
            const g = makeReplicateRig({ status: [drop, drop, drop, drop, drop, drop, drop, () => json(200, { status: "processing" })] });
            const out = await withGlobalFetch(g.ctx.fetch, () => replicate.edit(g.req, g.ctx));
            check("replicate.js: seven thrown status reads in a row (a network gone about 30 s) land the picture",
                Buffer.compare(out.bytes, PNG) === 0 && g.calls.submit === 1 && g.calls.status === 9,
                JSON.stringify({ calls: g.calls, sleeps: g.sleeps }));
        }
        // 3. Reads that stay unanswered past the run's time end after the gap window, with the pauses capped at 15 s,
        //    as "status poll failed", not timed out, and with no stop sent
        try {
            let fakeNow = 1_000_000;
            Date.now = () => fakeNow;
            let g;
            const down = () => { throw new Error(`ECONNREFUSED ${g.KEY}`); };
            g = makeFalRig({ status: Array.from({ length: 40 }, () => down) });
            g.ctx.sleep = async (ms) => { g.sleeps.push(ms); fakeNow += ms + 60 * 1000; };
            const err = await throws(() => withGlobalFetch(g.ctx.fetch, () => fal.edit(g.req, g.ctx)));
            const pauses = g.sleeps.slice(1);
            check("fal.js: unanswered reads past the run's time end after the 120 s gap window as 'status poll failed', no timeout, no stop",
                !!err && /status poll failed for \d+ s/.test(err) && !/timed out/.test(err) && err.includes(g.id) && !err.includes(g.KEY)
                && g.calls.cancel === 0 && !g.ctx.cancelAsked
                && pauses.reduce((a, b) => a + b, 0) >= 120000 && pauses.every((ms) => ms <= 15000) && g.calls.status === 16,
                `${err} | status=${g.calls.status} sleeps=${JSON.stringify(g.sleeps)}`);
        } finally {
            Date.now = realNow;
        }
        // 4. A status read that never answers (a connection a sleep left half-open) gives up after its own time and is
        //    read again
        {
            const savedRead = util._times.readMs;
            util._times.readMs = 40;
            try {
                const g = makeWaveSpeedRig({});
                const inner = g.ctx.fetch;
                let hung = 0;
                g.ctx.fetch = (u, init = {}) => {
                    if (String(init.method || "GET").toUpperCase() === "GET" && /predictions\/[^/]+\/result/.test(String(u)) && hung++ === 0) {
                        return new Promise((_, reject) => {
                            if (!init.signal) return;   // no time of its own: this read hangs (the guard below ends the test)
                            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
                        });
                    }
                    return inner(u, init);
                };
                const guard = new Promise((resolve) => setTimeout(() => resolve("hung"), 3000));
                const out = await Promise.race([wavespeed.edit(g.req, g.ctx).catch((e) => "error: " + e.message), guard]);
                check("wavespeed.js: a status read that never answers gives up after its own time and the next read lands the picture",
                    out && out.bytes && Buffer.compare(out.bytes, PNG) === 0, typeof out === "string" ? out : "");
            } finally {
                util._times.readMs = savedRead;
            }
        }
        // 5. A finished picture whose download gets no answer six times (about 30 s) still lands
        {
            const drop = () => { throw new Error("CDN socket hang up"); };
            const g = makeFalRig({ download: [drop, drop, drop, drop, () => html(503, "busy"), drop] });
            const out = await withGlobalFetch(g.ctx.fetch, () => fal.edit(g.req, g.ctx));
            check("fal.js: six unanswered picture downloads in a row (about 30 s) then a good one land the picture",
                Buffer.compare(out.bytes, PNG) === 0 && g.calls.download === 7,
                JSON.stringify({ calls: g.calls, sleeps: g.sleeps }));
        }
        // 6. A download answered with a refusal (403) still ends after 3 tries
        {
            const no = () => html(403, "forbidden");
            const g = makeFalRig({ download: [no, no, no, no, no] });
            const err = await throws(() => withGlobalFetch(g.ctx.fetch, () => fal.edit(g.req, g.ctx)));
            check("fal.js: a picture download refused with 403 ends after 3 tries",
                !!err && /may still finish and be charged/.test(err) && g.calls.download === 3, `${err} | ${JSON.stringify(g.calls)}`);
        }
    });

    await section("no key leaked in any error", async () => {
        const leaked = allErrors.filter((e) => KEYS.some((k) => e.includes(k)));
        check(`none of the ${allErrors.length} errors across all adapters contains an API key`, leaked.length === 0, leaked.join(" | "));
    });

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); console.log("FAIL"); process.exit(1); });
