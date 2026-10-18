// The one place that loads the Comfy SDK (electron/main/providers/comfysdk.js, docs/PLAN_COMFY_SDK.md 3.1, 3.2, 10),
// in plain Node, no Electron, no key, nothing sent to Comfy:
//   node tools/comfysdk_test.js
// A scripted fetch plays cloud.comfy.org, api.comfy.org and a loopback mock. It checks that version() reads the SDK's
// version without loading it; that clearEnv() drops the SDK's environment variables; that a Cloud request goes to
// https://cloud.comfy.org/api/v2/... with the key as a bearer and Scumble in the User-Agent; that a test base takes only
// a test- key and gets every request, a real key never; that COMFY_BASE_URL left in the environment cannot send the key
// elsewhere; that the Router goes to https://api.comfy.org (or the mock) whatever COMFY_ROUTER_BASE_URL says; that a
// request with a body follows no redirect (a read still does); that a cancel still leaves when the run's own signal has
// fired, goes by the job's id alone (no read before it) and goes once more when it got no answer, a 429 or a 5xx, never
// after a refusal, through the SDK's public transport (not a client's private `low`); and that the error words take Cloud's own 404 codes, never a prototype's member, and name why a
// request got no answer.
"use strict";

const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const sdkMod = require(path.join(ROOT, "electron", "main", "providers", "comfysdk.js"));

const KEY = "comfyui-0f1e2d3c4b5a69788796a5b4c3d2e1f0aabbccdd";   // the shape of a Comfy key; never a real one
const TEST_KEY = "test-comfysdk-0123456789";
const MOCK = "http://127.0.0.1:5593";
const JOB = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}

function jobBody(status = "running") {
    return {
        id: JOB, status, created_at: "2026-10-18T10:00:00Z", started_at: null, completed_at: null,
        expires_at: "2026-10-25T10:00:00Z", queue_position: null, progress: null, outputs: [], error: null,
        urls: { self: `/api/v2/jobs/${JOB}`, events: `/api/v2/jobs/${JOB}/events`, cancel: `/api/v2/jobs/${JOB}/cancel` },
    };
}

/** A fetch that records every call and answers like the v2 job routes and the Router's submit. */
function recorder() {
    const calls = [];
    const fetch = async (input, init = {}) => {
        const url = typeof input === "string" ? input : String(input.url || input);
        const h = new Headers(init.headers);
        calls.push({ url, method: (init.method || "GET").toUpperCase(), auth: h.get("authorization"), ua: h.get("user-agent"), aborted: !!(init.signal && init.signal.aborted) });
        const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (/\/api\/v2\/jobs\/[^/]+\/cancel$/.test(url)) return json(jobBody("canceling"));
        if (/\/api\/v2\/jobs\/[^/]+$/.test(url)) return json(jobBody());
        if (/\/v2\/models\/.+\/requests$/.test(url)) return json({ request_id: "req-1", status: "IN_QUEUE" }, 201);
        return json({ error: { type: "not_found", message: "no such route in the fake" } }, 404);
    };
    return { calls, fetch };
}

async function main() {
    // ---- version without loading the SDK ----
    const v = sdkMod.version();
    check("version() reads the SDK's own package.json", v === "0.5.0", v);
    check("version() does not load the SDK", sdkMod.loaded() === false);

    // ---- clearEnv ----
    const env = { COMFY_BASE_URL: "http://evil.example", COMFY_API_KEY: "other", COMFY_ROUTER_BASE_URL: "http://evil.example", PATH: "x" };
    const gone = sdkMod.clearEnv(env);
    check("clearEnv() removes the three SDK variables and names them", gone.length === 3 && !("COMFY_BASE_URL" in env) && !("COMFY_API_KEY" in env) && !("COMFY_ROUTER_BASE_URL" in env) && env.PATH === "x", gone.join(","));

    // ---- a Cloud request ----
    {
        const r = recorder();
        const client = sdkMod.cloudClient({ key: KEY, fetch: r.fetch });
        await client.jobs.get(JOB);
        const c = r.calls[0] || {};
        check("a Cloud request goes to https://cloud.comfy.org/api/v2/...", c.url === `https://cloud.comfy.org/api/v2/jobs/${JOB}`, c.url);
        check("the key goes as a bearer", c.auth === `Bearer ${KEY}`);
        check("the User-Agent names Scumble", /app\/scumble\//.test(c.ua || ""), c.ua);
    }

    // ---- one request's limit ----
    {
        const run = sdkMod.cloudClient({ key: KEY, fetch: async () => new Response("{}") });
        const up = sdkMod.cloudClient({ key: KEY, fetch: async () => new Response("{}") }, { timeoutMs: sdkMod.UPLOAD_TIMEOUT_MS });
        check("a run's own client bounds one request (the submit, a status read) at 60 s; an upload's own client takes 300 s at least",
            run.low.defaultTimeoutMs === 60000 && sdkMod.UPLOAD_TIMEOUT_MS === 300000 && up.low.defaultTimeoutMs === 300000, `${run.low.defaultTimeoutMs} / ${up.low.defaultTimeoutMs}`);
    }

    // ---- the test base ----
    {
        const r = recorder();
        const client = sdkMod.cloudClient({ key: TEST_KEY, base: MOCK, fetch: r.fetch });
        await client.jobs.get(JOB);
        check("a test base gets the request of a test key", (r.calls[0] || {}).url === `${MOCK}/api/v2/jobs/${JOB}`, (r.calls[0] || {}).url);
        let threw = null;
        try { sdkMod.cloudClient({ key: KEY, base: MOCK, fetch: r.fetch }); } catch (e) { threw = e.message; }
        check("a real key is refused for a test base before any request", threw && /only a test key/.test(threw) && r.calls.length === 1, threw);
        threw = null;
        try { sdkMod.cloudClient({ key: TEST_KEY, fetch: r.fetch }); } catch (e) { threw = e.message; }
        check("a test key never goes to Comfy", threw && /never sent to Comfy/.test(threw), threw);
        const bad = sdkMod.guarded({ key: TEST_KEY, base: MOCK, fetch: r.fetch });
        threw = null;
        try { await bad("https://elsewhere.example/x", {}); } catch (e) { threw = e.message; }
        check("with a test base, no other origin is reached", threw && /refused/.test(threw) && r.calls.length === 1, threw);
    }

    // ---- COMFY_BASE_URL in the environment cannot redirect the key ----
    {
        const r = recorder();
        process.env.COMFY_BASE_URL = "https://evil.example";
        process.env.COMFY_API_KEY = "comfyui-not-this-one-000000000000";
        let threw = null;
        try { await sdkMod.cloudClient({ key: KEY, fetch: r.fetch }).jobs.get(JOB); } catch (e) { threw = e.message; }
        check("COMFY_BASE_URL left in the environment: the key is refused at the guard, nothing sent", threw && /refused/.test(threw) && r.calls.length === 0, threw);
        sdkMod.clearEnv();
        await sdkMod.cloudClient({ key: KEY, fetch: r.fetch }).jobs.get(JOB);
        const c = r.calls[0] || {};
        check("after clearEnv() the client goes to Comfy Cloud with the run's key", c.url && c.url.startsWith("https://cloud.comfy.org/") && c.auth === `Bearer ${KEY}`, c.url);
    }

    // ---- Comfy Router ----
    {
        const r = recorder();
        const saved = globalThis.fetch;
        globalThis.fetch = r.fetch;
        try {
            process.env.COMFY_ROUTER_BASE_URL = "https://evil.example";
            const comfy = sdkMod.routerSetup({ key: KEY });
            await comfy.models.submit("bfl/flux-2-pro", { prompt: "a cat" }, { idempotencyKey: "k-1", retry: false });
            const c = r.calls[0] || {};
            check("the Router goes to https://api.comfy.org whatever COMFY_ROUTER_BASE_URL says", c.url === "https://api.comfy.org/v2/models/bfl/flux-2-pro/requests", c.url);
            check("the Router gets the key as a bearer", c.auth === `Bearer ${KEY}`);
            const comfy2 = sdkMod.routerSetup({ key: TEST_KEY, base: MOCK });
            await comfy2.models.submit("bfl/flux-2-pro", { prompt: "a cat" }, { idempotencyKey: "k-2", retry: false });
            check("the Router's test base takes a test key", (r.calls[1] || {}).url === `${MOCK}/v2/models/bfl/flux-2-pro/requests`, (r.calls[1] || {}).url);
            let threw = null;
            try { sdkMod.routerSetup({ key: KEY, base: MOCK }); } catch (e) { threw = e.message; }
            check("the Router refuses a real key for a test base", threw && /only a test key/.test(threw), threw);
        } finally {
            globalThis.fetch = saved;
            delete process.env.COMFY_ROUTER_BASE_URL;
        }
    }

    // ---- a cancel after the run's signal fired ----
    {
        const r = recorder();
        const saved = globalThis.fetch;
        globalThis.fetch = r.fetch;
        try {
            const ac = new AbortController();
            ac.abort();
            // the run's fetch as providers/index.js contextFor builds it: refuses once the run is cancelled
            const runFetch = (url, init = {}) => (ac.signal.aborted ? Promise.reject(new Error("cancelled")) : r.fetch(url, init));
            const ok = await sdkMod.cancelJob({ key: KEY, fetch: runFetch }, JOB);
            const post = r.calls.find((c) => c.method === "POST" && /\/cancel$/.test(c.url));
            check("a cancel leaves after the run's own signal fired, answering the job's status", ok === "canceling" && !!post && post.url === `https://cloud.comfy.org/api/v2/jobs/${JOB}/cancel`, post && post.url);
            check("the cancel carries the key", post && post.auth === `Bearer ${KEY}`);
        } finally {
            globalThis.fetch = saved;
        }
    }

    // ---- the cancel by id alone, tried once more ----
    {
        // per cancel POST in turn: a status to answer with, "lost" (the connection drops), or a job status
        const scripted = (says) => {
            const calls = [];
            const fetch = async (input, init = {}) => {
                const url = typeof input === "string" ? input : String(input.url || input);
                const h = new Headers(init.headers);
                calls.push({ url, method: (init.method || "GET").toUpperCase(), redirect: init.redirect || "follow", bearer: h.get("authorization") === `Bearer ${KEY}`, ua: h.get("user-agent") });
                const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
                if (/\/cancel$/.test(url)) {
                    const say = says[calls.filter((c) => /\/cancel$/.test(c.url)).length - 1];
                    if (say === "lost") throw new TypeError("fetch failed");
                    if (typeof say === "number") return json({ error: { code: say === 404 ? "job_not_found" : say === 429 ? "rate_limited" : "upstream_error", message: "said " + say } }, say);
                    return json(jobBody(say || "canceling"));
                }
                if (/\/api\/v2\/jobs\/[^/]+$/.test(url)) return json({ error: { code: "upstream_error", message: "the read broke" } }, 503);
                return json({ error: { type: "not_found", message: "no such route in the fake" } }, 404);
            };
            return { calls, fetch };
        };
        const saved = globalThis.fetch;
        const cancelWith = async (says) => {
            const r = scripted(says);
            globalThis.fetch = r.fetch;
            let answer = null, threw = null;
            try { answer = await sdkMod.cancelJob({ key: KEY, fetch: () => Promise.reject(new Error("the run's fetch")) }, JOB); } catch (e) { threw = e; } finally { globalThis.fetch = saved; }
            return { answer, threw, calls: r.calls, posts: r.calls.filter((c) => c.method === "POST").length, gets: r.calls.filter((c) => c.method === "GET").length };
        };
        const a = await cancelWith([]);
        check("the cancel goes by the job's id alone: one POST .../cancel, no read of the job before it (a read that fails would keep it from leaving)",
            a.answer === "canceling" && a.posts === 1 && a.gets === 0 && a.calls[0].url === `https://cloud.comfy.org/api/v2/jobs/${JOB}/cancel`, JSON.stringify(a.calls));
        const b = await cancelWith([503, "canceled"]);
        check("a cancel answered 503 goes once more and answers the second's status", b.answer === "canceled" && b.posts === 2 && !b.threw, JSON.stringify({ answer: b.answer, posts: b.posts }));
        const c = await cancelWith(["lost", "succeeded"]);
        check("a cancel with no answer goes once more (the job had finished: succeeded)", c.answer === "succeeded" && c.posts === 2, JSON.stringify({ answer: c.answer, posts: c.posts }));
        const d = await cancelWith([404, "canceling"]);
        check("a cancel Comfy refuses (404) is not sent again, and throws", !!d.threw && +d.threw.httpStatus === 404 && d.posts === 1, JSON.stringify({ posts: d.posts, threw: d.threw && d.threw.message }));
        const e = await cancelWith(["lost", "lost"]);
        check("two cancels with no answer: thrown, no third", !!e.threw && e.posts === 2, JSON.stringify({ posts: e.posts }));
        check("the cancel (a request with a body's method) follows no redirect", a.calls[0].redirect === "error", a.calls[0].redirect);
        check("the cancel carries the key as a bearer and Scumble in the User-Agent", a.calls[0].bearer === true && /app\/scumble\//.test(a.calls[0].ua || ""), JSON.stringify({ bearer: a.calls[0].bearer, ua: a.calls[0].ua }));
        // the class client's `low` is a TypeScript-private member: an SDK release may make it truly private (#low)
        const src = require("node:fs").readFileSync(path.join(ROOT, "electron", "main", "providers", "comfysdk.js"), "utf8");
        check("the cancel goes through the SDK's public transport export (@comfyorg/sdk/low), never a client's private `low`",
            /require\("@comfyorg\/sdk\/low"\)/.test(src) && !/\.low\b/.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));
    }

    // ---- redirects ----
    {
        const seen = [];
        const fetch = async (_u, init = {}) => { seen.push({ method: String(init.method || "GET").toUpperCase(), redirect: init.redirect || "follow" }); return new Response("{}", { status: 200 }); };
        const g = sdkMod.guarded({ key: KEY, fetch });
        await g("https://cloud.comfy.org/api/v2/jobs", { method: "POST", body: "{}" });
        await g("https://cloud.comfy.org/api/v2/assets", { method: "post", body: "x", redirect: "follow" });
        await g(`https://cloud.comfy.org/api/v2/jobs/${JOB}`, {});
        await g("https://cloud.comfy.org/api/v2/assets/a/content", { redirect: "manual" });
        await g("https://cloud.comfy.org/api/v2/assets/a/content", { method: "POST", redirect: "manual" });
        check("a request with a body follows no redirect (the submit's body carries the key); a read follows one; \"manual\" stays",
            seen.map((x) => `${x.method}:${x.redirect}`).join(",") === "POST:error,POST:error,GET:follow,GET:manual,POST:manual", JSON.stringify(seen));
    }

    // ---- error words ----
    check("errorText words an SDK error by its type and scrubs the key", /no credits left/.test(sdkMod.errorText({ errorType: "insufficient_credits", message: `out of credits for ${KEY}` }, KEY)) && !sdkMod.errorText({ code: "x", message: KEY }, KEY).includes(KEY));
    const cut = sdkMod.errorText({ code: "x", message: "m", details: { pad: "a".repeat(262), echo: KEY } }, KEY);
    check("errorText scrubs the key in the details before it shortens them (no part of the key left)", !cut.includes(KEY.slice(0, 12)), cut.slice(-60));
    const proto = sdkMod.errorText({ code: "constructor", message: "x" }, KEY) + "|" + sdkMod.errorText({ code: "__proto__", message: "y" }, KEY);
    check("errorText never takes a prototype's member for words", proto === "x|y", proto);
    const nf = sdkMod.errorText({ code: "job_not_found", httpStatus: 404, message: "Job not found" }, KEY);
    check("errorText words Cloud's own 404 codes (job_not_found)", /^Comfy does not know this job \(Job not found\)$/.test(nf), nf);
    const off = sdkMod.errorText(new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND cloud.comfy.org"), { code: "ENOTFOUND" }) }), KEY);
    check("errorText names why a request got no answer (the cause of fetch's \"fetch failed\")", off === "fetch failed: getaddrinfo ENOTFOUND cloud.comfy.org", off);
    const keyed = sdkMod.errorText(new TypeError("fetch failed", { cause: new Error(`bad header ${KEY}`) }), KEY);
    check("the cause is scrubbed too", !keyed.includes(KEY) && /\[key\]/.test(keyed), keyed);

    const failed = results.filter((x) => !x).length;
    console.log(failed ? `${failed} of ${results.length} checks FAILED` : `all ${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
