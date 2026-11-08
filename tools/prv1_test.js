// Polled-job and result-download resilience (review finding providers/PRV-1, money):
//   node -r ./tools/nonet.js tools/prv1_test.js
// Tests electron/main/providers/util.js (pollJob, downloadImage), fal.js (edit, upscale, relight),
// replicate.js (edit, generate), wavespeed.js (edit, generate), comfyrouter.js (download) and
// comfypartner.js (download) against scripted fake fetches in plain Node, with zero network.
"use strict";

const path = require("node:path");
const PROV = path.join(__dirname, "..", "electron", "main", "providers");
const fal = require(path.join(PROV, "fal.js"));
const replicate = require(path.join(PROV, "replicate.js"));
const wavespeed = require(path.join(PROV, "wavespeed.js"));
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

// ---- 1. fal.js (edit, upscale, relight) ----

function makeFalRig({ id = "req-fal-77", submit, status = [], result = [], download = [], signal } = {}) {
    const KEY = KEYS[0];
    const statusQ = [...status];
    const resultQ = [...result];
    const dlQ = [...download];
    const sleeps = [];
    const calls = { submit: 0, status: 0, result: 0, download: 0, afterAbort: 0 };

    async function fetch(url, init = {}) {
        if (signal && signal.aborted) {
            calls.afterAbort++;
            throw Object.assign(new Error("cancelled"), { name: "AbortError" });
        }
        const u = String(url);
        const method = String(init.method || "GET").toUpperCase();
        if (method === "POST") {
            calls.submit++;
            if (submit) return submit();
            return json(200, { request_id: id, status: "IN_QUEUE", status_url: "https://queue.fal.run/m/requests/" + id + "/status", response_url: "https://queue.fal.run/m/requests/" + id });
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
    return { KEY, id, calls, sleeps, ctx, req };
}

// ---- 2. replicate.js (edit) ----

function makeReplicateRig({ id = "pred-rep-88", submit, status = [], download = [], signal } = {}) {
    const KEY = KEYS[1];
    const statusQ = [...status];
    const dlQ = [...download];
    const sleeps = [];
    const calls = { submit: 0, status: 0, download: 0, afterAbort: 0 };

    async function fetch(url, init = {}) {
        if (signal && signal.aborted) {
            calls.afterAbort++;
            throw Object.assign(new Error("cancelled"), { name: "AbortError" });
        }
        const u = String(url);
        const method = String(init.method || "GET").toUpperCase();
        if (method === "POST") {
            calls.submit++;
            if (submit) return submit();
            return json(201, { id, status: "starting", urls: { get: `https://api.replicate.com/v1/predictions/${id}` } });
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
    return { KEY, id, calls, sleeps, ctx, req };
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
        // 6c. Fake-clock timeout clamps remaining wait and throws naming request id and saying job may still finish and be charged
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
                check(`${label}: poll timeout clamps sleep to remaining 5000 ms and throws naming ${g.id} and saying job may still finish and be charged`,
                    !!err && err.includes("timed out after 15 minutes") && err.includes(g.id)
                    && /may still finish and be charged/.test(err) && !err.includes(g.KEY)
                    && g.sleeps.includes(5000) && !g.sleeps.includes(60000),
                    `${err} | sleeps=${JSON.stringify(g.sleeps)}`);
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
            check(`${label}: Cancel during status retry sleep ends at once (${elapsed} ms < 500 ms) and sends no further request`,
                /cancelled|aborted/i.test(err || "") && elapsed < 500 && g.calls.submit === 1 && g.calls.status === 1 && g.calls.download === 0 && g.calls.afterAbort === 0,
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
            check(`${label}: Cancel during download retry sleep ends at once (${elapsed} ms < 500 ms) and sends no further request`,
                /cancelled|aborted/i.test(err || "") && elapsed < 500 && g.calls.submit === 1 && g.calls.download === 1 && g.calls.afterAbort === 0,
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
        (req, ctx) => fal.edit(req, ctx),
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

            const gFail = makeFalRig({ download: [() => html(502, "bad"), () => html(502, "bad"), () => html(502, "bad")] });
            const err = await throws(() => fal[verb]({ ...gFail.req, kind: verb, ...extra }, gFail.ctx));
            check(`fal.${verb}: 3 failed downloads throws naming ${gFail.id} and saying job may still finish and be charged`,
                !!err && err.includes(gFail.id) && /may still finish and be charged/.test(err) && gFail.calls.download === 3, err);
        }
    });

    await testPolledAdapter(
        "replicate.js",
        makeReplicateRig,
        (req, ctx) => replicate.edit(req, ctx),
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

        const withGlobalFetch = async (fn, work) => {
            const saved = globalThis.fetch;
            globalThis.fetch = fn;
            try { return await work(); } finally { globalThis.fetch = saved; }
        };

        const crReq = { model: "bfl/flux-2-pro", kind: "edit", prompt: "a cat", image: PNG, references: [], width: 64, height: 64, seed: 7, params: {} };
        const hyReq = { model: "hy-image-v3.5-preview", kind: "edit", prompt: "a cat", image: PNG, references: [], width: 512, height: 512, seed: 7, params: {} };

        // 1. Comfy Router download: 2 failures then 3rd try lands
        {
            const g = makeComfyRig({ downloads: [() => { throw new Error("socket closed"); }, () => html(502, "bad gateway")] });
            const out = await withGlobalFetch(g.fetch, () => router.edit(crReq, g.ctx));
            check("comfyrouter.js: 2 failed asset downloads then 3rd try lands the picture, submit sent once",
                Buffer.compare(out.bytes, PNG) === 0 && g.calls.submit === 1 && g.calls.download === 3);
        }
        // 2. Comfy Router download: 3 failures throws naming request_id and saying job may still finish and be charged
        {
            const bad = () => html(503, `storage error ${KEY}`);
            const g = makeComfyRig({ downloads: [bad, bad, bad] });
            const err = await withGlobalFetch(g.fetch, () => throws(() => router.edit(crReq, g.ctx)));
            check("comfyrouter.js: 3 failed asset downloads throws naming request_id and saying job may still finish and be charged, key scrubbed",
                !!err && err.includes(g.rid) && /may still finish and be charged/.test(err) && !err.includes(KEY) && g.calls.submit === 1 && g.calls.download === 3,
                err);
        }
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
        // 5. Comfy Partner API download: 3 failures throws naming request_id and saying job may still finish and be charged
        {
            const bad = () => html(502, `partner cdn error ${KEY}`);
            const g = makeComfyRig({ downloads: [bad, bad, bad] });
            const err = await throws(() => partner.edit(hyReq, g.ctx));
            check("comfypartner.js: 3 failed asset downloads throws naming request_id and saying job may still finish and be charged, key scrubbed",
                !!err && err.includes(g.hyId) && /may still finish and be charged/.test(err) && !err.includes(KEY) && g.calls.hy === 1 && g.calls.download === 3,
                err);
        }
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
