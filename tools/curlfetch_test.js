// electron/main/curlfetch.js in plain Node against local servers (and one real HTTPS request unless SKIP_NET=1):
// methods, headers, binary bodies both ways (64 MB), FormData, status codes with and without a body, redirects under
// fetch's rules (key headers dropped on a change of origin, 303 to GET, "error", "manual"), abort before the answer
// and during the body, a refused connection, streaming, keys never on curl's command line, no temp file left, and
// the switch that install() puts in place of globalThis.fetch. Run: node tools/curlfetch_test.js
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const cp = require("node:child_process");

// every curl started, with its arguments (before curlfetch.js takes `spawn`)
const spawned = [];
const origSpawn = cp.spawn;
// and the config each one was given on stdin
const configs = [];
cp.spawn = function (cmd, args, opts) {
    spawned.push({ cmd, args: [...(args || [])] });
    const child = origSpawn.call(this, cmd, args, opts);
    if (child && child.stdin && args && args.includes("-K")) {
        const end = child.stdin.end.bind(child.stdin);
        child.stdin.end = (chunk, ...rest) => { configs.push(String(chunk || "")); return end(chunk, ...rest); };
    }
    return child;
};
const CF = require("../electron/main/curlfetch.js");

let failed = 0, passed = 0;
function check(name, ok, info) {
    if (ok) passed++; else failed++;
    console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${info ? " -- " + info : ""}`);
}
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.listen(0, "127.0.0.1", () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` }));
    });
}
function readAll(req) {
    return new Promise((resolve) => { const parts = []; req.on("data", (d) => parts.push(d)); req.on("end", () => resolve(Buffer.concat(parts))); });
}

(async () => {
    const probed = CF.probe();
    check("curl is found", probed.ok, probed.ok ? `${probed.path} ${probed.version}` : probed.error);
    if (!probed.ok) { console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }

    const BIG = crypto.randomBytes(64 << 20);
    let seen = {}, closed = 0, hang = null;
    const A = await serve(async (req, res) => {
        const body = await readAll(req);
        seen = { method: req.method, url: req.url, headers: req.headers, len: body.length, sha: sha(body), text: body.length < 4096 ? body.toString("utf8") : "" };
        const u = new URL(req.url, "http://x");
        if (u.pathname === "/json") { res.writeHead(200, { "content-type": "application/json", "x-two": "a" }); res.end(JSON.stringify({ ok: true, q: u.searchParams.get("q") })); }
        else if (u.pathname === "/echo") { res.writeHead(201, { "content-type": "application/octet-stream" }); res.end(sha(body)); }
        else if (u.pathname === "/big") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(BIG); }
        else if (u.pathname === "/404") { res.writeHead(404, { "content-type": "text/plain" }); res.end("not here"); }
        else if (u.pathname === "/204") { res.writeHead(204); res.end(); }
        else if (u.pathname === "/to-b") { res.writeHead(302, { location: B.base + "/seen" }); res.end(); }
        else if (u.pathname === "/to-a") { res.writeHead(307, { location: "/seen" }); res.end(); }
        else if (u.pathname === "/303") { res.writeHead(303, { location: "/seen" }); res.end(); }
        else if (u.pathname === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); }
        else if (u.pathname === "/seen") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization || null, key: req.headers["x-key"] || null, other: req.headers["x-other"] || null, len: body.length })); }
        else if (u.pathname === "/stall") { /* never answers */ }
        else if (u.pathname === "/stallbody") { res.writeHead(200, { "content-type": "text/plain" }); res.write("x"); }
        else if (u.pathname === "/slow") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.write("first;");
            req.socket.on("close", () => { closed++; });
            await sleep(600);
            res.end("second");
        } else if (u.pathname === "/hang") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.write("part");
            hang = res;
            req.socket.on("close", () => { closed++; });
        } else if (u.pathname === "/hanghead") { req.socket.on("close", () => { closed++; }); }
        else { res.writeHead(500); res.end("?"); }
    });
    const B = await serve(async (req, res) => {
        await readAll(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ host: "b", auth: req.headers.authorization || null, key: req.headers["x-key"] || null, goog: req.headers["x-goog-api-key"] || null, other: req.headers["x-other"] || null }));
    });
    const KEY = "sk-test-" + crypto.randomBytes(12).toString("hex");

    try {
        // GET, query, headers, json
        const r1 = await CF.curlFetch(A.base + "/json?q=a%20b[1]", { headers: { Authorization: "Bearer " + KEY, "X-Custom": "v" } });
        const j1 = await r1.json();
        check("a GET answers status, headers and JSON (brackets in the query untouched)", r1.ok && r1.status === 200 && j1.q === "a b[1]" && r1.headers.get("x-two") === "a" && r1.url === A.base + "/json?q=a%20b[1]", JSON.stringify({ s: r1.status, j1 }));
        check("... the request carried the headers", seen.headers.authorization === "Bearer " + KEY && seen.headers["x-custom"] === "v");
        check("no key on any curl command line", spawned.every((c) => !c.args.join(" ").includes(KEY) && c.args.join(" ") === "-q -K -"), spawned.map((c) => c.args.join(" ")).slice(0, 3).join(" | "));

        // binary POST both ways
        const r2 = await CF.curlFetch(A.base + "/echo", { method: "POST", body: BIG, headers: { "content-type": "image/png" } });
        check("a 64 MB binary POST arrives byte for byte (201)", r2.status === 201 && (await r2.text()) === sha(BIG) && seen.len === BIG.length && seen.headers["content-type"] === "image/png", `${seen.len}`);
        const r2b = await CF.curlFetch(A.base + "/echo", { method: "POST", body: new Uint8Array([1, 2, 3]) });
        await r2b.text();
        check("a body without a type is not sent as a form", !seen.headers["content-type"] && !seen.headers.expect, JSON.stringify(seen.headers));
        const r3 = await CF.curlFetch(A.base + "/big");
        const got = Buffer.from(await r3.arrayBuffer());
        check("a 64 MB answer arrives byte for byte", got.length === BIG.length && sha(got) === sha(BIG));

        // FormData and a JSON string body
        const fd = new FormData();
        fd.append("prompt", "a red fox");
        fd.append("image", new Blob([Buffer.from("PNGDATA")], { type: "image/png" }), "a.png");
        await (await CF.curlFetch(A.base + "/echo", { method: "PUT", body: fd })).text();
        check("FormData goes as multipart with its boundary", seen.method === "PUT" && /^multipart\/form-data; boundary=/.test(seen.headers["content-type"]) && seen.text.includes("a red fox") && seen.text.includes("PNGDATA") && seen.text.includes('filename="a.png"'));
        await (await CF.curlFetch(A.base + "/echo", { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "Content-Type": "application/json" } })).text();
        check("a JSON string body", seen.text === '{"a":1}' && seen.headers["content-type"] === "application/json");
        await (await CF.curlFetch(A.base + "/echo", { method: "DELETE" })).text();
        check("a DELETE without a body sends Content-Length 0", seen.method === "DELETE" && seen.headers["content-length"] === "0");

        // status codes
        const r4 = await CF.curlFetch(A.base + "/404");
        check("a 404 answers with its body, ok false", r4.status === 404 && !r4.ok && (await r4.text()) === "not here");
        const r5 = await CF.curlFetch(A.base + "/204");
        check("a 204 answers with no body", r5.status === 204 && r5.body === null);
        const r5h = await CF.curlFetch(A.base + "/json", { method: "HEAD" });
        check("a HEAD answers the headers and no body", r5h.status === 200 && r5h.body === null && r5h.headers.get("content-type") === "application/json");

        // redirects
        const r6 = await CF.curlFetch(A.base + "/to-b", { headers: { Authorization: "Bearer " + KEY, "x-key": KEY, "x-goog-api-key": KEY, "x-other": "keep" } });
        const j6 = await r6.json();
        check("a redirect to another origin drops every key header and keeps the rest", j6.host === "b" && j6.auth === null && j6.key === null && j6.goog === null && j6.other === "keep" && r6.redirected && r6.url === B.base + "/seen", JSON.stringify(j6));
        const r7 = await CF.curlFetch(A.base + "/to-a", { method: "POST", body: "abc", headers: { Authorization: "Bearer " + KEY, "x-key": KEY } });
        const j7 = await r7.json();
        check("a 307 on the same origin keeps the method, the body and the keys", j7.method === "POST" && j7.len === 3 && j7.auth === "Bearer " + KEY && j7.key === KEY, JSON.stringify(j7));
        const j8 = await (await CF.curlFetch(A.base + "/303", { method: "POST", body: "abc" })).json();
        check("a 303 after a POST becomes a GET without a body", j8.method === "GET" && j8.len === 0, JSON.stringify(j8));
        let e9 = null;
        try { await CF.curlFetch(A.base + "/to-b", { redirect: "error" }); } catch (err) { e9 = err; }
        check('redirect: "error" rejects on a 3xx', e9 instanceof TypeError && /redirect/.test(e9.cause && e9.cause.message), String(e9 && e9.cause));
        const r10 = await CF.curlFetch(A.base + "/to-b", { redirect: "manual" });
        check('redirect: "manual" answers the 3xx', r10.status === 302 && r10.headers.get("location") === B.base + "/seen");
        let e11 = null;
        try { await CF.curlFetch(A.base + "/loop"); } catch (err) { e11 = err; }
        check("too many redirects reject", e11 instanceof TypeError && /too many/.test(e11.cause.message));

        // streaming and abort
        const r12 = await CF.curlFetch(A.base + "/slow");
        const reader = r12.body.getReader();
        const t0 = Date.now();
        const first = await reader.read();
        const firstMs = Date.now() - t0;
        let rest = "";
        for (;;) { const x = await reader.read(); if (x.done) break; rest += Buffer.from(x.value).toString(); }
        check("the body streams: the first part comes before the rest is written", Buffer.from(first.value).toString() === "first;" && firstMs < 400 && rest === "second", `${firstMs} ms`);
        const ac = new AbortController();
        const r13 = await CF.curlFetch(A.base + "/hang", { signal: ac.signal });
        const rd = r13.body.getReader();
        await rd.read();
        const before = closed;
        setTimeout(() => ac.abort(), 100);
        let e13 = null;
        try { for (;;) { const x = await rd.read(); if (x.done) break; } } catch (err) { e13 = err; }
        await sleep(300);
        check("an abort during the body errors the body and ends the connection", !!e13 && e13.name === "AbortError" && closed > before, `${e13 && e13.name}, closed ${closed - before}`);
        if (hang) try { hang.end(); } catch (_) { /* gone */ }
        const ac2 = new AbortController();
        setTimeout(() => ac2.abort(), 200);
        let e14 = null;
        const t14 = Date.now();
        try { await CF.curlFetch(A.base + "/hanghead", { signal: ac2.signal }); } catch (err) { e14 = err; }
        check("an abort before the answer rejects with AbortError at once", !!e14 && e14.name === "AbortError" && Date.now() - t14 < 1500, `${e14 && e14.name} after ${Date.now() - t14} ms`);
        const ac3 = new AbortController(); ac3.abort();
        let e15 = null;
        try { await CF.curlFetch(A.base + "/json", { signal: ac3.signal }); } catch (err) { e15 = err; }
        check("an aborted signal starts no curl", !!e15 && e15.name === "AbortError");

        // a refused connection
        const dead = await serve(() => {});
        const deadBase = dead.base;
        await new Promise((r) => dead.s.close(r));
        let e16 = null;
        try { await CF.curlFetch(deadBase + "/x"); } catch (err) { e16 = err; }
        check("a refused connection rejects as fetch does: TypeError fetch failed, curl's words as the cause", e16 instanceof TypeError && e16.message === "fetch failed" && /connect|refused/i.test(e16.cause.message), String(e16 && e16.cause && e16.cause.message));
        let e17 = null;
        try { await CF.curlFetch(A.base + "/json", { headers: { "x-bad": "a\r\nb" } }); } catch (err) { e17 = err; }
        check("a header with a line break is refused", e17 instanceof TypeError);

        // a Request object
        const r18 = await CF.curlFetch(new Request(A.base + "/echo", { method: "POST", body: "xyz" }));
        // review of 2026-11-12: a user's .curlrc changes nothing (-q first)
        {
            const home = fs.mkdtempSync(require("node:path").join(os.tmpdir(), "cf-curlrc-"));
            for (const n of [".curlrc", "_curlrc"]) fs.writeFileSync(require("node:path").join(home, n), '-w "TRAILER"' + String.fromCharCode(10) + '-v' + String.fromCharCode(10));
            const old = process.env.CURL_HOME;
            process.env.CURL_HOME = home;
            let txt = "";
            try { txt = await (await CF.curlFetch(A.base + "/json?q=rc")).text(); } finally { if (old === undefined) delete process.env.CURL_HOME; else process.env.CURL_HOME = old; fs.rmSync(home, { recursive: true, force: true }); }
            check("a .curlrc in CURL_HOME is not read", !txt.includes("TRAILER") && JSON.parse(txt).q === "rc", txt.slice(0, 80));
        }
        await CF.curlFetch(A.base + "/json", { method: "POST" }).then((r) => r.text());
        check("a POST without a body is not sent as a form", seen.method === "POST" && !seen.headers["content-type"] && seen.headers["content-length"] === "0", JSON.stringify(seen.headers));
        {
            seen = {};
            const ac = new AbortController();
            const p = CF.curlFetch(A.base + "/w", { method: "POST", body: BIG, signal: ac.signal });
            setImmediate(() => ac.abort());
            const e = await p.then(() => null, (err) => err);
            await sleep(500);
            check("an abort while the body file is written stops the request", !!e && e.name === "AbortError" && seen.url !== "/w", `${e && e.name} ${seen.url} ${seen.len}`);
        }
        {
            const t = Date.now();
            const e = await CF.curlFetch(A.base + "/stall", { dispatcher: { headersTimeout: 2000 } }).then(() => null, (err) => err);
            check("no answer within the dispatcher's headersTimeout fails as undici's headers timeout", e instanceof TypeError && e.cause && e.cause.code === "UND_ERR_HEADERS_TIMEOUT" && Date.now() - t < 8000, `${e && e.cause && e.cause.code} after ${Date.now() - t} ms`);
            const r = await CF.curlFetch(A.base + "/stallbody", { dispatcher: { bodyTimeout: 2000 } });
            const e2 = await r.text().then(() => null, (err) => err);
            check("a body that stops moving fails as undici's body timeout", !!e2 && e2.cause && e2.cause.code === "UND_ERR_BODY_TIMEOUT", String(e2 && e2.cause && (e2.cause.code || e2.cause.message)));
            check("the stall limit is undici's 300 s without a dispatcher", CF.stallSeconds(undefined) === 300 && CF.stallSeconds({ headersTimeout: 630000 }) === 630);
        }
        check("a Request object as input", r18.status === 201 && (await r18.text()) === sha(Buffer.from("xyz")));

        // the switch
        const nativeFetch = globalThis.fetch;
        let on = true, fell = null;
        CF.install({ enabled: () => on, onFallback: (why) => { fell = why; } });
        check("route: a provider goes through curl, loopback stays on Node", CF.route("https://fal.run/x") === "curl" && CF.route("http://127.0.0.1:8188/x") === "node" && CF.route("http://localhost:1/x") === "node" && CF.route("http://[::1]:1/") === "node");
        on = false;
        check("route: with the setting off everything stays on Node", CF.route("https://fal.run/x") === "node");
        on = true;
        const n0 = spawned.length;
        const r19 = await globalThis.fetch(A.base + "/json?q=n");
        await r19.json();
        check("the switch sends loopback to Node's fetch (no curl started)", spawned.length === n0 && seen.headers["user-agent"] !== undefined && !/^curl\//.test(seen.headers["user-agent"]), seen.headers["user-agent"]);
        check("status() names the curl", CF.status().via === "curl" && !!CF.status().curl.version && fell === null);
        if (process.env.SKIP_NET !== "1") {
            const n1 = spawned.length;
            try {
                const r20 = await globalThis.fetch("https://huggingface.co/api/models/Comfy-Org/MiniMax-H3-Image", { signal: AbortSignal.timeout(30000) });
                const j20 = await r20.json();
                check("a real HTTPS request goes through curl (huggingface.co)", r20.ok && j20.id === "Comfy-Org/MiniMax-H3-Image" && spawned.length > n1, `${r20.status} ${j20.id}`);
            } catch (err) {
                check("a real HTTPS request goes through curl (huggingface.co)", false, String(err && (err.cause || err).message));
            }
        } else console.log("[skip] the real HTTPS request (SKIP_NET=1)");
        globalThis.fetch = nativeFetch;

        // review finding main-net/curl-schannel-revocation: the TLS backend is read from curl's own words, and a
        // Schannel curl of 7.70 or newer gets ssl-revoke-best-effort (a browser's soft revocation check), others not
        {
            const vi = CF.versionInfo;
            const win = vi("curl 8.22.0 (Windows) libcurl/8.22.0 Schannel zlib/1.3.2 WinIDN WinLDAP");
            const mingw = vi("curl 8.19.0 (x86_64-w64-mingw32) libcurl/8.19.0 Schannel zlib/1.3.2 brotli/1.2.0");
            const multi = vi("curl 8.5.0 (x86_64-w64-mingw32) libcurl/8.5.0 OpenSSL/3.1.4 (Schannel) zlib/1.3");
            const mac = vi("curl 8.4.0 (x86_64-apple-darwin23.0) libcurl/8.4.0 (SecureTransport) LibreSSL/3.3.6 zlib/1.2.12");
            const old = vi("curl 7.69.1 (Windows) libcurl/7.69.1 Schannel");
            check("versionInfo: Schannel builds of 7.70+ take ssl-revoke-best-effort; a build that only offers Schannel in parentheses, macOS's LibreSSL and 7.69 do not",
                win.tls === "Schannel" && win.revokeBestEffort && mingw.revokeBestEffort && multi.tls === "OpenSSL" && !multi.revokeBestEffort
                && mac.tls === "LibreSSL" && !mac.revokeBestEffort && old.tls === "Schannel" && !old.revokeBestEffort && vi("not curl") === null,
                JSON.stringify({ win, multi, mac, old }));
            const c0 = configs.length;
            await (await CF.curlFetch(A.base + "/json?q=r")).json();
            const cfg = configs.slice(c0).join("\n");
            const want = !!CF.probe().revokeBestEffort;
            check(`a request's config ${want ? "holds" : "leaves out"} ssl-revoke-best-effort for this curl (${CF.probe().tls || "?"} ${CF.probe().version})`,
                configs.length > c0 && /(^|\n)ssl-revoke-best-effort(\n|$)/.test(cfg) === want && CF.status().curl.tls === (CF.probe().tls || null), cfg.split("\n").slice(0, 12).join(" | "));
        }

        // review finding main-net/curl-body-temp-files-left: bodies a gone process left are removed, others stay
        {
            const dir = fs.mkdtempSync(require("node:path").join(os.tmpdir(), "cf-sweep-"));
            const dead = await new Promise((resolve) => { const c = origSpawn(process.execPath, ["-e", ""]); c.on("exit", () => resolve(c.pid)); });
            const hex = () => crypto.randomBytes(8).toString("hex");
            const names = { dead: `scumble-curl-${dead}-${hex()}.bin`, mine: `scumble-curl-${process.pid}-${hex()}.bin`, other: `scumble-curl-${dead}-short.bin`, unrelated: "picture.bin" };
            for (const n of Object.values(names)) fs.writeFileSync(require("node:path").join(dir, n), "PICTURE");
            const gone = CF.sweepBodies(dir);
            const left = fs.readdirSync(dir).sort();
            check("sweepBodies removes a body file of a process that is gone and keeps this process's, and files of other names",
                gone === 1 && !left.includes(names.dead) && left.includes(names.mine) && left.includes(names.other) && left.includes(names.unrelated), JSON.stringify({ gone, left }));
            fs.rmSync(dir, { recursive: true, force: true });
        }

        // no temp file left
        await sleep(200);
        const left = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`scumble-curl-${process.pid}-`));
        check("no temp body file left", left.length === 0, left.join(", "));
    } finally {
        A.s.close(); B.s.close();
        A.s.closeAllConnections && A.s.closeAllConnections();
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
