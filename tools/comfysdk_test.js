// The one place that loads the Comfy SDK (electron/main/providers/comfysdk.js, docs/PLAN_COMFY_SDK.md 3.1, 3.2, 10),
// in plain Node, no Electron, no key, nothing sent to Comfy:
//   node tools/comfysdk_test.js
// A scripted fetch plays cloud.comfy.org, api.comfy.org and a loopback mock. It checks that version() reads the SDK's
// version without loading it; that clearEnv() drops the SDK's environment variables; that a Cloud request goes to
// https://cloud.comfy.org/api/v2/... with the key as a bearer and Scumble in the User-Agent; that a test base takes only
// a test- key and gets every request, a real key never; that COMFY_BASE_URL left in the environment cannot send the key
// elsewhere; that the Router goes to https://api.comfy.org (or the mock) whatever COMFY_ROUTER_BASE_URL says; and that
// a cancel still leaves when the run's own signal has fired.
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
            check("a cancel leaves after the run's own signal fired", ok === true && !!post && post.url === `https://cloud.comfy.org/api/v2/jobs/${JOB}/cancel`, post && post.url);
            check("the cancel carries the key", post && post.auth === `Bearer ${KEY}`);
        } finally {
            globalThis.fetch = saved;
        }
    }

    // ---- error words ----
    check("errorText words an SDK error by its type and scrubs the key", /no credits left/.test(sdkMod.errorText({ errorType: "insufficient_credits", message: `out of credits for ${KEY}` }, KEY)) && !sdkMod.errorText({ code: "x", message: KEY }, KEY).includes(KEY));
    const cut = sdkMod.errorText({ code: "x", message: "m", details: { pad: "a".repeat(262), echo: KEY } }, KEY);
    check("errorText scrubs the key in the details before it shortens them (no part of the key left)", !cut.includes(KEY.slice(0, 12)), cut.slice(-60));

    const failed = results.filter((x) => !x).length;
    console.log(failed ? `${failed} of ${results.length} checks FAILED` : `all ${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
