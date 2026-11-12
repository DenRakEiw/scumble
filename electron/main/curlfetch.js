// The main process's HTTP requests through the system's curl (Settings › Network, on by default).
//
// Why: on managed company machines (the user, 2026-11-11: Omnicom's MacBooks) a proxy or a TLS-inspecting filter lets
// the system curl through and blocks other clients (Python requests; Node's fetch has its own CA list and ignores the
// keychain the same way). `install()` puts a switch in place of `globalThis.fetch` once at start: every request of
// the main process that does not go to this machine (the providers and Comfy's SDK, the prompt upsamplers, model
// downloads, a remote ComfyUI) goes through `curlFetch`; loopback (the local ComfyUI, the tests' mocks) stays on
// Node's fetch. With the setting off, or no curl found, everything stays on Node's fetch and the log says why once.
// The ComfyUI websocket (`ws`) and electron-updater (Chromium's network stack) are not fetch and do not go through it.
//
// `curlFetch(input, init)` answers like fetch: a Response with a streamed body, `url` and `redirected`. One curl
// process per request and per redirect hop:
//   - the URL, the method and the headers go to curl on stdin as a config file (`-K -`), never on its command line,
//     where any process of the machine could read a key; a body goes as a temp file (mode 0600) removed afterwards;
//   - redirects are followed here, not by curl, under fetch's rules: 301 / 302 after a POST and every 303 become a GET
//     without a body, and on a change of origin every header that can carry a key is dropped (Authorization, Cookie,
//     Proxy-Authorization, and the providers' own key headers: x-api-key, x-key, api-key, x-goog-api-key ...);
//     `redirect: "error"` rejects on a 3xx, `"manual"` returns it;
//   - `signal` kills the process (before the answer: the promise rejects with the signal's reason; during the body: the
//     body errors);
//   - a curl failure (no route, TLS, a cut transfer) rejects as fetch does: TypeError "fetch failed" with curl's own
//     words as the cause. Undici's `dispatcher` is not used; its limits are: a transfer that moves nothing for 300 s
//     (undici's headers and body timeouts), or for the dispatcher's own `headersTimeout` / `bodyTimeout` when a caller
//     sets them, fails with the cause's `code` UND_ERR_HEADERS_TIMEOUT (before the answer) or UND_ERR_BODY_TIMEOUT;
//   - curl is started with `-q` first, so a user's .curlrc / _curlrc changes nothing.
"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const MAX_REDIRECTS = 20;
const CONNECT_TIMEOUT_S = 30;
const STALL_TIMEOUT_MS = 300000;   // undici's default headersTimeout and bodyTimeout
// headers that may carry a key: dropped when a redirect leaves the origin (fetch drops Authorization alone; the
// providers' own key headers would go along with it there, so they are dropped here too)
const KEY_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key", "x-key", "api-key", "x-goog-api-key", "x-comfy-api-key", "x-auth-token", "x-token", "x-magnific-api-key"]);
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

// ---- where curl is ----------------------------------------------------------------------------------------------

function candidates() {
    if (process.platform === "win32") {
        const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
        return [path.join(root, "System32", "curl.exe"), "curl.exe"];
    }
    return ["/usr/bin/curl", "/bin/curl", "/usr/local/bin/curl", "/opt/homebrew/bin/curl", "curl"];
}

let found = null;   // { ok, path, version, error }
/** The curl Scumble uses, found once: { ok, path, version } or { ok: false, error }. */
function probe(force = false) {
    if (found && !force) return found;
    for (const p of candidates()) {
        if (path.isAbsolute(p) && !fs.existsSync(p)) continue;
        try {
            const r = spawnSync(p, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
            const m = r.status === 0 && /^curl (\S+)/.exec(r.stdout || "");
            if (m) return (found = { ok: true, path: p, version: m[1] });
        } catch (_) { /* the next */ }
    }
    return (found = { ok: false, error: "no curl found (" + candidates().filter(path.isAbsolute).join(", ") + ")" });
}

// ---- the request ------------------------------------------------------------------------------------------------

const quote = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

function abortError(signal) {
    if (signal && signal.reason !== undefined) return signal.reason;
    const e = new Error("This operation was aborted");
    e.name = "AbortError";
    return e;
}

function failed(why, code) {
    const cause = new Error(why);
    if (code) cause.code = code;
    return new TypeError("fetch failed", { cause });
}

/** The stall limit in seconds: the dispatcher's own headersTimeout / bodyTimeout (the larger), else undici's 300 s. */
function stallSeconds(dispatcher) {
    const ms = Math.max(+(dispatcher && dispatcher.headersTimeout) || 0, +(dispatcher && dispatcher.bodyTimeout) || 0);
    return Math.max(1, Math.ceil((ms > 0 ? ms : STALL_TIMEOUT_MS) / 1000));
}
// curl's exit code 28 with its speed-limit words: nothing moved for speed-time seconds
const stalled = (code, stderr) => code === 28 && /too slow/i.test(stderr);

/** One hop: { status, statusText, headers, body (ReadableStream or null) } once the answer's head is in. */
async function hop(curlPath, url, method, headers, bodyBytes, signal, stallS = STALL_TIMEOUT_MS / 1000) {
    if (signal && signal.aborted) throw abortError(signal);
    let bodyFile = null;
    const config = [
        "silent", "show-error", "globoff", "no-buffer", "suppress-connect-headers",
        `connect-timeout = ${CONNECT_TIMEOUT_S}`,
        "speed-limit = 1", `speed-time = ${stallS}`,
        "output = -",
        `url = ${quote(url)}`,
    ];
    // the head on stdout before the body; `head` writes it there itself (with dump-header too, every line came twice)
    if (method === "HEAD") config.push("head");
    else {
        config.push("dump-header = -");
        if (method !== "GET") config.push(`request = ${quote(method)}`);
    }
    let hasType = false;
    for (const [k, v] of headers) {
        if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) throw new TypeError(`fetch: a header with a line break (${k})`);
        if (k.toLowerCase() === "content-type") hasType = true;
        // curl sends a header written "Name;" with an empty value, "Name:" would remove it
        config.push(`header = ${quote(v === "" ? `${k};` : `${k}: ${v}`)}`);
    }
    config.push(`header = ${quote("Expect:")}`);   // no 100-continue round trip before a large body
    const drop = () => { if (bodyFile) fs.promises.unlink(bodyFile).catch(() => {}); bodyFile = null; };
    if (bodyBytes) {
        if (!hasType) config.push(`header = ${quote("Content-Type:")}`);   // not curl's form type
        bodyFile = path.join(os.tmpdir(), `scumble-curl-${process.pid}-${crypto.randomBytes(8).toString("hex")}.bin`);
        try {
            await fs.promises.writeFile(bodyFile, bodyBytes, { mode: 0o600, flag: "wx" });
        } catch (err) {
            drop();   // a partial file (a full disk)
            throw failed(`fetch: the request body could not be written for curl: ${err.message}`);
        }
        config.push(`data-binary = ${quote("@" + bodyFile)}`);
        // a Cancel while the body was written: the listener below would never fire on a signal aborted already
        if (signal && signal.aborted) { drop(); throw abortError(signal); }
    } else if (method !== "GET" && method !== "HEAD") {
        if (!hasType) config.push(`header = ${quote("Content-Type:")}`);   // not curl's form type, as fetch sends none
        config.push(`data-binary = ""`);   // Content-Length: 0
    }

    let child;
    try {
        child = spawn(curlPath, ["-q", "-K", "-"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
        drop();
        throw failed(`curl did not start: ${err.message}`);
    }
    child.stdin.on("error", () => {});
    child.stdin.end(config.join("\n") + "\n");

    return await new Promise((resolve, reject) => {
        let head = Buffer.alloc(0), stderr = "", answered = false, controller = null, ended = false, code = null, aborted = false;
        const early = [];   // body bytes that came before the stream had its controller
        const onAbort = () => {
            aborted = true;
            try { child.kill(); } catch (_) { /* gone */ }
            if (!answered) { answered = true; reject(abortError(signal)); }
            else if (controller) { try { controller.error(abortError(signal)); } catch (_) { /* closed */ } }
        };
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        const cleanup = () => { if (signal) signal.removeEventListener("abort", onAbort); drop(); };

        const finish = () => {
            if (!ended || code === null) return;
            cleanup();
            if (!answered) { answered = true; reject(failed(stderr.trim() || `curl ended with code ${code} before an answer`, stalled(code, stderr) ? "UND_ERR_HEADERS_TIMEOUT" : undefined)); return; }
            if (aborted || !controller) return;
            if (code === 0) { try { controller.close(); } catch (_) { /* closed */ } }
            else {
                const cause = new Error(stderr.trim() || `curl ended with code ${code}`);
                if (stalled(code, stderr)) cause.code = "UND_ERR_BODY_TIMEOUT";
                try { controller.error(new TypeError("terminated", { cause })); } catch (_) { /* closed */ }
            }
        };

        const answer = (status, statusText, hdrs, rest) => {
            answered = true;
            const nobody = method === "HEAD" || NULL_BODY.has(status);
            let body = null;
            if (!nobody) {
                body = new ReadableStream({
                    start(c) {
                        controller = c;
                        if (rest.length) c.enqueue(new Uint8Array(rest));
                        for (const b of early) c.enqueue(new Uint8Array(b));
                        early.length = 0;
                    },
                    pull() { if (child.stdout.isPaused()) child.stdout.resume(); },
                    cancel() { aborted = true; try { child.kill(); } catch (_) { /* gone */ } },
                }, { highWaterMark: 4 << 20, size: (chunk) => chunk.byteLength });
            } else {
                child.stdout.resume();
            }
            resolve({ status, statusText, headers: hdrs, body });
        };

        child.stdout.on("data", (chunk) => {
            if (answered) {
                if (controller) {
                    try { controller.enqueue(new Uint8Array(chunk)); } catch (_) { return; }
                    if (controller.desiredSize !== null && controller.desiredSize <= 0) child.stdout.pause();
                } else early.push(chunk);
                return;
            }
            head = Buffer.concat([head, chunk]);
            // header blocks: interim 1xx answers come first and are skipped
            for (;;) {
                const end = head.indexOf("\r\n\r\n");
                if (end < 0) return;
                const lines = head.subarray(0, end).toString("latin1").split("\r\n");
                const m = /^HTTP\/[\d.]+\s+(\d{3})\s*(.*)$/.exec(lines[0] || "");
                if (!m) { answered = true; try { child.kill(); } catch (_) { /* gone */ } cleanup(); reject(failed(`curl: not an HTTP answer: ${String(lines[0]).slice(0, 80)}`)); return; }
                const status = +m[1];
                const rest = head.subarray(end + 4);
                if (status >= 100 && status < 200 && status !== 101) { head = rest; continue; }
                const hdrs = new Headers();
                for (const l of lines.slice(1)) {
                    const i = l.indexOf(":");
                    if (i > 0) { try { hdrs.append(l.slice(0, i).trim(), l.slice(i + 1).trim()); } catch (_) { /* a header Headers refuses */ } }
                }
                answer(status, m[2] || "", hdrs, rest);
                return;
            }
        });
        child.stderr.on("data", (d) => { stderr += d.toString("utf8"); if (stderr.length > 8192) stderr = stderr.slice(-8192); });
        child.stdout.on("end", () => { ended = true; finish(); });
        child.on("error", (err) => { stderr += err.message; ended = true; if (code === null) code = -1; finish(); });
        child.on("close", (c) => { code = c === null ? -1 : c; ended = true; finish(); });
    });
}

function urlOf(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === "string") return input.url;
    return String(input);
}

/** A fetch through curl. */
let requests = 0;
async function curlFetch(input, init = {}) {
    const probed = probe();
    if (!probed.ok) throw failed(probed.error);
    if (!requests++) console.log(`Network: requests go through curl ${probed.version} (${probed.path})`);
    // Request does the parsing fetch does: the method, the headers, and the body with its type (a FormData's boundary)
    const isReq = typeof Request !== "undefined" && input instanceof Request;
    const signal = init.signal || (isReq ? input.signal : null) || null;
    if (signal && signal.aborted) throw abortError(signal);
    const reqInit = { method: init.method, headers: init.headers, body: init.body, redirect: init.redirect };
    if (init.body && typeof init.body.getReader === "function") reqInit.duplex = "half";
    const req = new Request(isReq ? input : urlOf(input), reqInit);
    const redirect = init.redirect || req.redirect || "follow";
    let method = req.method.toUpperCase();
    let headers = [...req.headers];
    let body = req.body ? Buffer.from(await req.arrayBuffer()) : null;
    let url = req.url;
    let redirected = false;
    const stallS = stallSeconds(init.dispatcher);

    for (let n = 0; ; n++) {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw failed(`fetch: ${u.protocol} is not supported`);
        const r = await hop(probed.path, u.href, method, headers, body, signal, stallS);
        const loc = r.headers.get("location");
        if (r.status >= 300 && r.status < 400 && loc && redirect !== "manual") {
            if (redirect === "error") { if (r.body) r.body.cancel().catch(() => {}); throw failed(`fetch: a redirect (${r.status}) where redirect: "error" was asked`); }
            if (n >= MAX_REDIRECTS) { if (r.body) r.body.cancel().catch(() => {}); throw failed("fetch: too many redirects"); }
            if (r.body) await r.body.cancel().catch(() => {});
            const next = new URL(loc, u);
            if ((r.status === 303 && method !== "HEAD") || ((r.status === 301 || r.status === 302) && method === "POST")) {
                method = "GET";
                body = null;
                headers = headers.filter(([k]) => !/^content-(type|length|encoding|language|location)$/i.test(k));
            }
            if (next.origin !== u.origin) headers = headers.filter(([k]) => !KEY_HEADERS.has(k.toLowerCase()));
            url = next.href;
            redirected = true;
            continue;
        }
        if (r.status < 200 || r.status > 599) {   // a Response cannot hold it (101 and the like): fetch fails too
            if (r.body) r.body.cancel().catch(() => {});
            throw failed(`fetch: an answer with status ${r.status}`);
        }
        const res = new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
        Object.defineProperty(res, "url", { value: url, enumerable: true });
        Object.defineProperty(res, "redirected", { value: redirected, enumerable: true });
        return res;
    }
}

// ---- the switch in place of globalThis.fetch --------------------------------------------------------------------

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i;
function isLoopback(url) {
    try {
        const h = new URL(url).hostname;
        return LOOPBACK.test(h) || h.endsWith(".localhost");
    } catch (_) {
        return false;
    }
}

let NATIVE = null;
let state = { enabled: () => false, onFallback: null, warned: false };

/** Which way a request to `url` goes now: "curl" or "node". */
function route(url) {
    // SCUMBLE_CURL_ALL=1 (gates only): loopback through curl too, so the providers' gates run against their mocks on it
    if (!state.enabled() || (isLoopback(url) && process.env.SCUMBLE_CURL_ALL !== "1")) return "node";
    if (!probe().ok) {
        if (!state.warned) { state.warned = true; if (state.onFallback) state.onFallback(probe().error); }
        return "node";
    }
    return "curl";
}

/**
 * Put the switch in place of globalThis.fetch (once). `enabled()` is read per request (the setting can change while
 * the app runs); `onFallback(why)` once when the setting is on but no curl was found.
 */
function install({ enabled, onFallback } = {}) {
    state = { enabled: typeof enabled === "function" ? enabled : () => true, onFallback: onFallback || null, warned: false };
    if (NATIVE) return;
    NATIVE = globalThis.fetch;
    const native = NATIVE;
    globalThis.fetch = function fetch(input, init) {
        return route(urlOf(input)) === "curl" ? curlFetch(input, init) : native(input, init);
    };
}

/** For Settings › Network: whether requests go through curl now, and which curl. */
function status() {
    const p = probe();
    const on = state.enabled();
    return { enabled: on, curl: p.ok ? { path: p.path, version: p.version } : null, error: p.ok ? null : p.error, via: on && p.ok ? "curl" : "node", requests };
}

module.exports = { curlFetch, install, route, status, probe, isLoopback, KEY_HEADERS, stallSeconds };
