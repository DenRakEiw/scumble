// The one way out of the assistant: a streamed POST, the key rules that keep a real key off a
// local listener and a test key off a real host, and the three helpers the plan needs from
// code that does not export them (docs/PLAN_ASSISTANT.md §3, "Modules"). `electron/main/llm.js`
// and `electron/main/providers/toapis.js` stay untouched, so their rules are written again here,
// beside the tests that hold both copies to the same answers.
"use strict";

const RETRY_STATUS = new Set([429, 500, 502, 503, 529]);   // 529 is Anthropic's "overloaded"
const BACKOFF = [2000, 4000, 8000];                        // when the answer names no retry-after
const MAX_RETRY_WAIT = 60000;                              // a longer retry-after is not waited out

/**
 * `settings.assistant.base`, when it is a loopback origin and nothing else. The loopback branch
 * of `toapis.allowedBase` (electron/main/providers/toapis.js), which that file exports only for
 * its own test; a base with a user, a query, a fragment or a path is refused.
 */
function loopbackBase(value) {
    if (!value) return null;
    let u;
    try { u = new URL(String(value).trim()); } catch (_) { return null; }
    if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return null;
    if (u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port) return `${u.protocol}//${u.host}`;
    return null;
}

/** True for a URL on the loopback host, whatever its path. */
function isLoopback(url) {
    try {
        const u = new URL(String(url));
        return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    } catch (_) { return false; }
}

/**
 * "http://host:port" or ".../v1" -> ".../v1", no trailing slash: the rule of `llm.js` compatBase,
 * which that file does not export. An empty URL throws the same sentence.
 */
function compatBase(url) {
    const u = String(url || "").trim().replace(/\/+$/, "");
    if (!u) throw new Error("No endpoint URL. Set one under Settings › Local / OpenAI-compatible endpoint.");
    return /\/v\d+$/.test(u) ? u : u + "/v1";
}

/**
 * The strict test of `llm.js` askCompatible: did the server turn the request away because of the
 * picture? Only then is a request sent again without it.
 */
function refusesImage(status, body) {
    if (![400, 413, 415, 422].includes(Number(status))) return false;
    return /image|vision|multimodal|content part/i.test(String(body || ""));
}

/**
 * The key rule, both ways (§2 row 27). A key that starts with `test-` goes to a loopback URL
 * only, and a loopback URL takes no other key: a gate never reaches a real host, and no real key
 * ever reaches a local listener. `localOk` lifts the second half for the one provider whose URL
 * is a local listener by nature: the local OpenAI-compatible server, whose own key (LM Studio's,
 * a vLLM token) goes to the URL the user saved (§2 row 26).
 */
function checkKey(url, key, opts = {}) {
    const k = String(key || "");
    if (!k) return;
    const test = k.startsWith("test-");
    const local = isLoopback(url);
    if (test && !local) throw new Error("a test key goes to the test endpoint only");
    if (!test && local && !opts.localOk) throw new Error("the test endpoint takes test keys only");
}

/** Every key out of a text, whatever wrapped it: the model's answer, an error, a log line. */
function scrub(text, keys) {
    let out = String(text == null ? "" : text);
    for (const key of keys || []) {
        const k = String(key || "");
        if (k.length < 8) continue;
        while (out.includes(k)) out = out.replace(k, "<key>");
    }
    return out;
}

/** How long to wait before trying again, from the header the server sent. */
function retryAfterMs(res, attempt) {
    const raw = res && res.headers && res.headers.get && res.headers.get("retry-after");
    if (raw) {
        const seconds = Number(String(raw).trim());
        if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
        const at = Date.parse(String(raw));
        if (Number.isFinite(at)) return Math.max(0, at - Date.now());
    }
    return BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
}

/** The error an answer that is not ok becomes: the status and the body it carried. */
function httpError(status, bodyText, keys) {
    const body = scrub(bodyText, keys).trim();
    const err = new Error(`HTTP ${status}${body ? ": " + body.slice(0, 600) : ""}`);
    err.status = status;
    err.body = body;
    return err;
}

/**
 * POST a JSON body and hand back the answer to stream from. Retries happen here, so they happen
 * only before the first byte of a stream: 429, 500, 502, 503 and 529, at most `retries` times,
 * after `retry-after` or 2, 4 and 8 s, plus one retry after a connection error that never got an
 * answer. `noRetry(status, bodyText)` lets a provider's adapter keep its own answers off that
 * list (an empty balance never comes back by waiting).
 *
 * @returns {Promise<{res: Response, attempts: number}>}
 */
async function postStream(url, headers, body, opts = {}) {
    const { signal, retries = 3, keys = [], noRetry, sleep = wait, log, fetchImpl } = opts;
    const send = fetchImpl || fetch;                 // the tests script it; nothing else does
    checkKey(url, opts.key, { localOk: !!opts.localOk });
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    let connectionTried = false;
    for (let attempt = 0; ; attempt++) {
        if (signal && signal.aborted) throw stopped();
        let res;
        try {
            res = await send(url, { method: "POST", headers, body: payload, signal });
        } catch (err) {
            if (signal && signal.aborted) throw stopped();
            if (connectionTried) throw new Error(scrub(String((err && err.message) || err), keys));
            connectionTried = true;                      // one retry for a connection that never answered
            if (log) log(`connection failed, trying once more: ${scrub(String((err && err.message) || err), keys)}`);
            await sleep(BACKOFF[0]);
            attempt--;                                   // a connection error does not use up a status retry
            continue;
        }
        if (res.ok) return { res, attempts: attempt + 1 };

        const text = await res.text().catch(() => "");
        const err = httpError(res.status, text, keys);
        const retryable = RETRY_STATUS.has(res.status) && !(noRetry && noRetry(res.status, text));
        if (!retryable || attempt >= retries) throw err;
        const waitMs = retryAfterMs(res, attempt);
        if (waitMs > MAX_RETRY_WAIT) { err.message += ` (asked to wait ${Math.round(waitMs / 1000)} s)`; throw err; }
        if (log) log(`HTTP ${res.status}, again in ${Math.round(waitMs / 1000)} s (${attempt + 1} of ${retries})`);
        await sleep(waitMs);
    }
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopped() {
    const err = new Error("stopped");
    err.name = "AbortError";
    return err;
}

module.exports = { postStream, scrub, checkKey, loopbackBase, isLoopback, compatBase, refusesImage, retryAfterMs, httpError, RETRY_STATUS };
