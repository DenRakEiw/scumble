// The one place that loads Comfy's official TypeScript SDK (@comfyorg/sdk, MIT; docs/PLAN_COMFY_SDK.md 3.1, 3.2).
// Comfy Cloud runs through its class client (the Comfy API v2), Comfy Router through its comfy.models namespace.
//
// The SDK is an ES module; main requires it through Node's require(esm), lazily on the first Cloud or Router run, so a
// broken package fails one run, not the app. version() reads its package.json without loading it.
//
// Targets and keys never come from the environment: the class client takes its base URL only from COMFY_BASE_URL and
// would send the key to whatever that names, so clearEnv() removes the three variables at start, the key goes in as
// `apiKey`, and every Cloud request passes guarded(): the run's abort signal reaches it, it goes only to
// https://cloud.comfy.org (or, in a test profile, to the loopback mock settings.comfycloud.base names, which only a
// `test-` key may reach), and a request for any other origin that would carry the key is refused.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CLOUD = "https://cloud.comfy.org";
const ROUTER = "https://api.comfy.org";
const ENV = ["COMFY_BASE_URL", "COMFY_API_KEY", "COMFY_ROUTER_BASE_URL"];
const CLIENT_TIMEOUT_MS = 300000;   // one request (a large upload included); the SDK's own default is 30 s
const CANCEL_TIMEOUT_MS = 10000;

let sdk = null;

/** The SDK module, required on first use. */
function load() {
    if (!sdk) sdk = require("@comfyorg/sdk");
    return sdk;
}

/** Whether the SDK module has been required (for tests: version() must not load it). */
function loaded() { return !!sdk; }

let versionCache = null;
/** The SDK's version from its own package.json (not in its exports map; read beside its entry, asar-aware fs). */
function version() {
    if (versionCache) return versionCache;
    try {
        const file = path.join(path.dirname(require.resolve("@comfyorg/sdk")), "..", "package.json");
        versionCache = String(JSON.parse(fs.readFileSync(file, "utf8")).version || "") || null;
    } catch (_) { versionCache = null; }
    return versionCache;
}

let appVersion = null;
function scumbleVersion() {
    if (appVersion == null) {
        try { appVersion = require("../../../package.json").version || ""; } catch (_) { appVersion = ""; }
    }
    return appVersion;
}

/** Removes the SDK's environment variables (a shell profile must not redirect the user's key); the names it removed. */
function clearEnv(env = process.env) {
    const gone = ENV.filter((k) => Object.prototype.hasOwnProperty.call(env, k));
    for (const k of gone) delete env[k];
    return gone;
}

/** http://127.0.0.1:<port> or null: the only test base a setting may name (the Router's rule). */
function testBase(value) {
    if (!value) return null;
    let u;
    try { u = new URL(String(value).trim()); } catch (_) { return null; }
    if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return null;
    if (u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port) return `${u.protocol}//${u.host}`;
    return null;
}

/** A test key goes only to the mock, a real key never there; `who` names the service in the words. */
function checkKey(who, setting, test, key) {
    const isTest = /^test-/.test(String(key || ""));
    if (test && !isTest) throw new Error(`${who}: the host is set to a test address (${setting}), and only a test key goes there; clear the setting to use a real key.`);
    if (!test && isTest) throw new Error(`${who}: a test key is never sent to Comfy; store a real key in the Comfy Cloud row under Settings › API providers.`);
}

function headerOf(init, name) {
    try { return new Headers(init && init.headers).get(name); } catch (_) { return null; }
}

/**
 * The fetch the Cloud client gets. `bound` (the default) goes through ctx.fetch, which carries the run's abort signal;
 * unbound goes through the global fetch with its own timeout (a cancel sent after the run's signal fired).
 */
function guarded(ctx, { bound = true, timeoutMs = 0 } = {}) {
    const test = testBase(ctx.base);
    return (input, init = {}) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input && input.url || "");
        let u;
        try { u = new URL(url); } catch (_) { return Promise.reject(new Error(`Comfy Cloud: refused a request to ${String(url).slice(0, 80)}`)); }
        let target = u.href;
        if (u.origin === CLOUD) {
            if (test) target = test + u.pathname + u.search;
        } else if (!(test && u.origin === test)) {
            // the SDK sends its key only to the client's own origin; a request elsewhere is let through only without it
            if (test || headerOf(init, "authorization")) return Promise.reject(new Error(`Comfy Cloud: refused a request to ${u.origin} (Scumble's Cloud client talks to ${CLOUD} only).`));
        }
        const send = { ...init };
        if (timeoutMs > 0) send.signal = send.signal ? AbortSignal.any([send.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        const f = bound && typeof ctx.fetch === "function" ? ctx.fetch : globalThis.fetch;
        return f(target, send);
    };
}

/** A Comfy Cloud client for this run (ctx.key, ctx.base, ctx.fetch); `bound: false` for a cancel after the abort. */
function cloudClient(ctx, { bound = true } = {}) {
    const key = String(ctx.key || "").trim();
    if (!key) throw new Error("Comfy Cloud: no API key.");
    checkKey("Comfy Cloud", "settings.comfycloud.base", !!testBase(ctx.base), key);
    const { Comfy } = load();
    return new Comfy({
        apiKey: key,
        fetch: guarded(ctx, bound ? {} : { bound: false, timeoutMs: CANCEL_TIMEOUT_MS }),
        clientInfo: `scumble/${scumbleVersion() || "dev"}`,
        timeoutMs: CLIENT_TIMEOUT_MS,
    });
}

/** Asks Comfy Cloud to stop a job, on a transport not tied to the run (its signal may have fired); true when answered. */
async function cancelJob(ctx, jobId) {
    if (!jobId) return false;
    const client = cloudClient(ctx, { bound: false });
    const job = await client.jobs.get(String(jobId));
    await job.cancel(AbortSignal.timeout(CANCEL_TIMEOUT_MS));
    return true;
}

/** comfy.models configured for this run: the key and the host (api.comfy.org, or the loopback mock for a test key). */
function routerSetup(ctx) {
    const key = String(ctx.key || "").trim();
    const test = testBase(ctx.base);
    checkKey("Comfy Router", "settings.comfyrouter.base", !!test, key);
    const { comfy } = load();
    comfy.config({ credentials: key, baseUrl: test || ROUTER });
    return comfy;
}

const WORDS = {
    unauthorized: "the key was refused (check the Comfy Cloud row under Settings › API providers)",
    forbidden: "the key may not do this (Comfy Cloud's API needs a paid plan)",
    insufficient_credits: "the account has no credits left (top up at platform.comfy.org)",
    queue_full: "Comfy's queue is full; try again in a minute",
    invalid_workflow: "Comfy refused the workflow",
    missing_asset: "a picture did not arrive at Comfy",
    idempotency_key_reuse: "Comfy already took this job",
    rate_limited: "too many requests; try again in a minute",
    concurrency_limit_exceeded: "too many runs at once on this account",
    not_found: "Comfy does not know this job or model",
    request_timeout: "Comfy did not answer in time",
};

function scrub(text, key) {
    let s = String(text == null ? "" : text);
    if (key && key.length >= 6) s = s.split(key).join("[key]");
    return s;
}

/** An SDK or Router error in Scumble's words, the key scrubbed; keyed by errorType / code, never instanceof. */
function errorText(err, key) {
    if (!err) return "unknown error";
    const code = String(err.errorType || err.code || "").toLowerCase();
    const said = scrub(err.message || String(err), key);
    const words = WORDS[code];
    return words ? `${words} (${said})` : said;
}

module.exports = { load, loaded, version, clearEnv, testBase, checkKey, guarded, cloudClient, cancelJob, routerSetup, errorText, scrub, CLOUD, ROUTER, ENV };
