// Plain-Node test of the helper downloader (electron/main/onnx/models.js `Downloader`), no Electron, no real model:
// two local HTTP servers on 127.0.0.1 (two ports, so two origins: A stands for Hugging Face, B for any other host)
// serve random bytes, and a fetch stub stands in for huggingface.co and its CDN where the real token rule is checked.
//
//     node tools/download_test.js
//
// Checked: the token rule (the URL table; the token on A and never on B across a redirect; with the real rule the
// token on huggingface.co and not on its CDN hop, github.com or a look-alike host; https never followed to http), the
// sha256 per file (a wrong hash refused, the .part deleted, no file), a size too large refused and deleted, the resume
// of a .part (Range asked, the checksum over the old and the new bytes; a broken connection resumed; a corrupt .part
// refused; a server that ignores Range or answers another range), a whole .part kept when it checks, a model without
// a sha256 (size only), a set in its own folder under onnx/ (the app folder and a ComfyUI models folder; a bare folder
// of the same name never counted; a file of the wrong size fetched again), the overall progress over a set, the
// free-disk refusal before the first request, the terms, a set without URLs not offered (the CorridorKey 2.0
// placeholder included), 401/403 wording, cancel, already downloading, verify and remove, and tools/ck2_catalogue.js
// on a fake built set (the entry it writes downloads through the registry). Exits non-zero on a failure.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const models = require("../electron/main/onnx/models");

let pass = 0, fail = 0;
function check(name, ok, detail) {
    if (ok) { pass++; console.log("[ok]", name); }
    else { fail++; console.log("[FAIL]", name, detail === undefined ? "" : "-> " + (typeof detail === "string" ? detail : JSON.stringify(detail))); }
}
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const exists = (p) => { try { fs.statSync(p); return true; } catch (_) { return false; } };
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch (_) { return -1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the servers --------------------------------------------------------------------------------------------------

const content = new Map();   // name -> Buffer
const log = [];              // { srv, path, auth, range }
const breaks = new Map();    // name -> times served broken

function serveRange(req, res, buf) {
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || "");
    if (m && Number(m[1]) < buf.length) {
        const start = Number(m[1]);
        res.writeHead(206, { "content-length": buf.length - start, "content-range": `bytes ${start}-${buf.length - 1}/${buf.length}`, "accept-ranges": "bytes" });
        res.end(buf.subarray(start));
    } else if (m) {
        res.writeHead(416, { "content-range": `bytes */${buf.length}` }); res.end();
    } else {
        res.writeHead(200, { "content-length": buf.length, "accept-ranges": "bytes" }); res.end(buf);
    }
}

function handler(srv, other) {
    return (req, res) => {
        res.on("error", () => {});
        const u = new URL(req.url, "http://x");
        const [, route, name] = u.pathname.split("/");
        log.push({ srv, path: u.pathname, auth: req.headers.authorization || null, range: req.headers.range || null });
        const buf = content.get(name);
        if (route === "redir") { res.writeHead(302, { location: `${other()}/ok/${name}` }); return res.end(); }
        if (route === "rel") { res.writeHead(307, { location: `/ok/${name}` }); return res.end(); }
        if (route === "denied") { res.writeHead(403); return res.end("no"); }
        if (route === "missing" || !buf) { res.writeHead(404); return res.end("not found"); }
        if (route === "ok") return serveRange(req, res, buf);
        if (route === "bad") { const b = Buffer.from(buf); b[b.length >> 1] ^= 0xff; return serveRange(req, res, b); }
        if (route === "long") { res.writeHead(200, { "content-length": buf.length + 10 }); return res.end(Buffer.concat([buf, Buffer.alloc(10, 7)])); }
        if (route === "norange") { res.writeHead(200, { "content-length": buf.length }); return res.end(buf); }
        if (route === "wrongrange") {
            if (req.headers.range) { res.writeHead(206, { "content-length": buf.length, "content-range": `bytes 0-${buf.length - 1}/${buf.length}` }); return res.end(buf); }
            res.writeHead(200, { "content-length": buf.length }); return res.end(buf);
        }
        if (route === "break") {
            const n = breaks.get(name) || 0;
            if (n === 0 && !req.headers.range) {
                breaks.set(name, 1);
                res.writeHead(200, { "content-length": buf.length });
                res.write(buf.subarray(0, buf.length >> 1));
                setTimeout(() => res.socket.destroy(), 50);
                return;
            }
            return serveRange(req, res, buf);
        }
        if (route === "slow") {
            res.writeHead(200, { "content-length": buf.length });
            let at = 0;
            const tick = () => {
                if (res.destroyed) return;
                if (at >= buf.length) return res.end();
                res.write(buf.subarray(at, at + 16384)); at += 16384;
                setTimeout(tick, 30);
            };
            return tick();
        }
        res.writeHead(400); res.end();
    };
}

function listen(h) {
    return new Promise((resolve) => { const s = http.createServer(h); s.listen(0, "127.0.0.1", () => resolve(s)); });
}

// ---- helpers ------------------------------------------------------------------------------------------------------

let A = "", B = "";
const TOKEN = "hf_TESTTOKEN";
const registry = {};
const accepted = new Set();
let freeBytes = Infinity;
let events = [];

function file(name, bytes) {
    const buf = crypto.randomBytes(bytes);
    content.set(name, buf);
    return { name, buf, size: buf.length, sha256: sha(buf) };
}

function plain(id, f, url, extra = {}) {
    const m = { id, kind: "test", label: "Test " + id, note: "", source: "", sourceUrl: "", license: "", files: [{ name: f.name, role: "model", size: f.size, sha256: f.sha256, url }], ...extra };
    registry[id] = m;
    return m;
}

function downloader(root) {
    return new models.Downloader(() => root, () => TOKEN, (ev) => events.push(ev), {
        lookup: (id) => registry[id] || null,
        tokenAllowed: (u) => { try { return new URL(u).origin === A; } catch (_) { return false; } },
        termsAccepted: (m) => accepted.has(m.id),
        freeSpace: async () => freeBytes,
    });
}

async function attempt(fn) {
    try { return { value: await fn() }; } catch (err) { return { error: String(err && err.message || err) }; }
}

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), "scumble-dl-" + tag + "-")); }

// ---- the tests ----------------------------------------------------------------------------------------------------

function tokenRuleTable() {
    const yes = ["https://huggingface.co/briaai/RMBG-2.0/resolve/main/onnx/model.onnx", "https://HuggingFace.co/x", "https://hf.co/x", "https://huggingface.co:443/x"];
    const no = [
        "http://huggingface.co/x", "https://huggingface.co.evil.com/x", "https://evil.com/huggingface.co/x", "https://evilhuggingface.co/x",
        "https://user:pw@huggingface.co/x", "https://huggingface.co:8443/x", "https://us.aws.cdn.hf.co/xet-bridge-us/abc", "https://cdn-lfs.huggingface.co/x",
        "https://cas-bridge.xethub.hf.co/x", "https://github.com/DenRakEiw/scumble/releases/download/x", "https://storage.googleapis.com/x", "not a url", "",
    ];
    const wrongYes = yes.filter((u) => !models.hfTokenAllowed(u));
    const wrongNo = no.filter((u) => models.hfTokenAllowed(u));
    check("the token rule: huggingface.co and hf.co over https on the default port, nothing else", !wrongYes.length && !wrongNo.length, { wrongYes, wrongNo });
}

function registryChecks() {
    const offeredOnes = models.MODELS.filter((m) => models.offered(m));
    const urlsHF = offeredOnes.every((m) => m.files.every((f) => models.hfTokenAllowed(f.url)));
    check("every offered helper downloads from huggingface.co over https", urlsHF);
    const hashed = [], unhashed = [];
    for (const m of offeredOnes) for (const f of m.files) (f.sha256 ? hashed : unhashed).push(m.id + ":" + f.name);
    const shaOk = offeredOnes.every((m) => m.files.every((f) => f.sha256 === null || /^[0-9a-f]{64}$/.test(f.sha256)));
    check("every known sha256 is 64 hex digits; only RMBG-2.0 (gated) has none", shaOk && unhashed.length === 1 && unhashed[0] === "rmbg2:rmbg2.onnx", { unhashed });
    const pinned = offeredOnes.every((m) => m.files.every((f) => !f.sha256 || /\/resolve\/[0-9a-f]{40}\//.test(f.url)));
    check("every hashed file's URL is pinned to a commit", pinned);
    const large = models.byId("sam2_large").files.find((f) => f.role === "decoder");
    check("SAM2 large's decoder is 20,640,910 bytes (HF, 2026-11-06), not the other decoders' 20,640,886", large.size === 20640910, large.size);
    const ck = models.byId("corridorkey2");
    check("CorridorKey 2.0: a placeholder in onnx/corridorkey2, not offered, kind key, no URL", ck && ck.kind === "key" && ck.placeholder && ck.subdir === "onnx/corridorkey2" && !models.offered(ck) && ck.files.every((f) => !f.url && !f.sha256) && ck.files.length > 0,
        ck && { subdir: ck.subdir, placeholder: ck.placeholder });
    const dir = tmp("reg");
    try {
        check("CorridorKey 2.0 left out of Settings' rows, shown with all: true and offered false",
            !models.describeAll(dir).some((r) => r.id === "corridorkey2")
            && models.describeAll(dir, null, null, { all: true }).some((r) => r.id === "corridorkey2" && r.offered === false && r.set === true));
        const row = models.describe("corridorkey2", dir);
        check("describe(corridorkey2): not present, its folder under onnx/, about 2.4 GB, the terms text", row && !row.present && row.folder === path.join(dir, "onnx", "corridorkey2") && row.approxBytes > 2.3e9 && row.approxBytes < 2.6e9 && /CorridorKey 2\.0/.test(row.terms.text) && /\$20M/.test(row.terms.text), row && { folder: row.folder, approx: row.approxBytes });
        // the placeholder's files put in place by hand are still not "present": it is not a set yet
        const ckDir = path.join(dir, "onnx", "corridorkey2");
        fs.mkdirSync(ckDir, { recursive: true });
        for (const f of ck.files) fs.writeFileSync(path.join(ckDir, f.name), "x");
        check("a placeholder set is never present, whatever lies in its folder", !models.locate(ck, dir).present && models.setFolder(ck, dir) === null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const bad = (cat) => models.fromSetCatalogue({ id: "x", base: "https://huggingface.co/x/resolve/abc/", files: [{ name: "a.onnx", size: 3, sha256: "0".repeat(64) }], ...cat });
    check("a set under onnx/ with a size, a sha256 and a URL per file is offered", models.offered(bad({ subdir: "onnx/x" })));
    check("a bare set folder (corridorkey2/, a ComfyUI pack's) is refused as the set's folder", !models.offered(bad({ subdir: "corridorkey2" })) && !!bad({ subdir: "corridorkey2" }).invalid);
    check("a set folder leaving the model folder is refused", !models.offered(bad({ subdir: "onnx/../x" })) && !models.offered(bad({ subdir: "../onnx/x" })));
    check("a set file name with a path in it is refused", !models.offered(bad({ subdir: "onnx/x", files: [{ name: "../a.onnx", size: 3, sha256: "0".repeat(64) }] })));
    check("a set file without its sha256 or its size is not offered", !models.offered(bad({ subdir: "onnx/x", files: [{ name: "a.onnx", size: 3 }] })) && !models.offered(bad({ subdir: "onnx/x", files: [{ name: "a.onnx", sha256: "0".repeat(64) }] })));
    check("a set without a base or a URL is not offered", !models.offered(bad({ subdir: "onnx/x", base: null })));
}

async function corridorRefused() {
    let calls = 0;
    const d = new models.Downloader(() => os.tmpdir(), () => TOKEN, () => {}, { fetch: async () => { calls++; throw new Error("no"); } });
    const r = await attempt(() => d.download("corridorkey2"));
    check("download(corridorkey2) refused as not available, before any request", r.error && /not available for download yet/.test(r.error) && calls === 0, { r, calls });
}

async function stubbedHF() {
    // the real token rule, on a stub that plays huggingface.co with a CDN redirect
    const body = crypto.randomBytes(5000);
    const seen = [];
    const stub = async (url, init) => {
        seen.push({ url, auth: init.headers.authorization || null });
        const u = new URL(url);
        if (u.hostname === "huggingface.co" && u.pathname.startsWith("/repo/resolve/")) return new Response(null, { status: 302, headers: { location: "https://us.aws.cdn.hf.co/xet-bridge-us/abc?X-Amz-Signature=1" } });
        if (u.hostname === "huggingface.co" && u.pathname.startsWith("/down/")) return new Response(null, { status: 302, headers: { location: "http://plain.example/x" } });
        if (u.hostname === "us.aws.cdn.hf.co" || u.hostname === "github.com" || u.hostname === "huggingface.co.evil.com") return new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
        return new Response("?", { status: 404 });
    };
    const reg = {
        hf: { id: "hf", label: "HF", files: [{ name: "hf.onnx", role: "model", size: body.length, sha256: sha(body), url: "https://huggingface.co/repo/resolve/abc/hf.onnx" }] },
        gh: { id: "gh", label: "GH", files: [{ name: "gh.onnx", role: "model", size: body.length, sha256: sha(body), url: "https://github.com/x/releases/download/v1/gh.onnx" }] },
        evil: { id: "evil", label: "Evil", files: [{ name: "evil.onnx", role: "model", size: body.length, sha256: sha(body), url: "https://huggingface.co.evil.com/x/evil.onnx" }] },
        down: { id: "down", label: "Down", files: [{ name: "down.onnx", role: "model", size: body.length, sha256: sha(body), url: "https://huggingface.co/down/x" }] },
    };
    const dir = tmp("stub");
    try {
        const d = new models.Downloader(() => dir, () => TOKEN, () => {}, { fetch: stub, lookup: (id) => reg[id] });
        const r1 = await attempt(() => d.download("hf"));
        const hop1 = seen.find((s) => s.url.startsWith("https://huggingface.co/repo/"));
        const hop2 = seen.find((s) => s.url.startsWith("https://us.aws.cdn.hf.co/"));
        check("real rule: the token goes to huggingface.co, not to its CDN hop; the file lands checked",
            !r1.error && hop1 && hop1.auth === "Bearer " + TOKEN && hop2 && hop2.auth === null && exists(path.join(dir, "hf.onnx")), { r1, hop1, hop2 });
        seen.length = 0;
        const r2 = await attempt(() => d.download("gh"));
        check("real rule: no token to github.com", !r2.error && seen.length === 1 && seen[0].auth === null, { r2, seen });
        seen.length = 0;
        const r3 = await attempt(() => d.download("evil"));
        check("real rule: no token to huggingface.co.evil.com", !r3.error && seen.length === 1 && seen[0].auth === null, { r3, seen });
        seen.length = 0;
        const r4 = await attempt(() => d.download("down"));
        check("an https URL redirected to http is refused and not followed", r4.error && /from https to http/.test(r4.error) && !seen.some((s) => s.url.startsWith("http://")), { r4, seen });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function plainDownloads() {
    const root = tmp("plain");
    try {
        const d = downloader(root);
        let f = file("redir.onnx", 300000);
        plain("redir", f, `${A}/redir/${f.name}`);
        let n = log.length;
        let r = await attempt(() => d.download("redir"));
        let reqs = log.slice(n);
        check("token on A, none on B after A's redirect to B; the file checked and in place",
            !r.error && reqs.length === 2 && reqs[0].srv === "A" && reqs[0].auth === "Bearer " + TOKEN && reqs[1].srv === "B" && reqs[1].auth === null
            && sha(fs.readFileSync(path.join(root, f.name))) === f.sha256 && !exists(path.join(root, f.name + ".part")), { r, reqs });

        f = file("direct_b.onnx", 20000);
        plain("direct_b", f, `${B}/ok/${f.name}`);
        n = log.length;
        r = await attempt(() => d.download("direct_b"));
        reqs = log.slice(n);
        check("no token to a host the rule does not name", !r.error && reqs.length === 1 && reqs[0].auth === null, { r, reqs });

        f = file("rel.onnx", 20000);
        plain("rel", f, `${A}/rel/${f.name}`);
        n = log.length;
        r = await attempt(() => d.download("rel"));
        reqs = log.slice(n);
        check("a relative redirect on the token host keeps the token", !r.error && reqs.length === 2 && reqs.every((q) => q.auth === "Bearer " + TOKEN), { r, reqs });

        f = file("bad.onnx", 200000);
        plain("bad", f, `${A}/bad/${f.name}`);
        events = [];
        r = await attempt(() => d.download("bad"));
        check("a wrong sha256 is refused, the .part deleted, no file, an error event",
            r.error && /checksum/.test(r.error) && !exists(path.join(root, f.name)) && !exists(path.join(root, f.name + ".part")) && events.some((e) => e.error && /checksum/.test(e.error)), { r, events: events.slice(-1) });

        f = file("long.onnx", 50000);
        plain("long", f, `${A}/long/${f.name}`);
        r = await attempt(() => d.download("long"));
        check("more bytes than the registry says: refused and deleted", r.error && /expected/.test(r.error) && !exists(path.join(root, f.name + ".part")) && !exists(path.join(root, f.name)), r);

        f = file("nosha.onnx", 40000);
        plain("nosha", f, `${A}/ok/${f.name}`);
        registry.nosha.files[0].sha256 = null;
        r = await attempt(() => d.download("nosha"));
        check("a model without a known sha256 (RMBG-2.0's case) still downloads on the size check", !r.error && sizeOf(path.join(root, f.name)) === f.size, r);

        f = file("denied.onnx", 1000);
        plain("denied", f, `${B}/denied/${f.name}`);
        r = await attempt(() => d.download("denied"));
        check("a 403 from another host names that host, not Hugging Face", r.error && r.error.includes(new URL(B).host) && !/Hugging Face/.test(r.error), r);
        registry.denied.gated = true;
        r = await attempt(() => d.download("denied"));
        check("the gated wording only for Hugging Face's own host", r.error && !/gated/.test(r.error), r);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function resumes() {
    const root = tmp("resume");
    try {
        const d = downloader(root);
        let f = file("half.onnx", 300000);
        plain("half", f, `${A}/ok/${f.name}`);
        fs.writeFileSync(path.join(root, f.name + ".part"), f.buf.subarray(0, 102400));
        let n = log.length;
        let r = await attempt(() => d.download("half"));
        let reqs = log.slice(n);
        check("a .part resumes with Range from its end; the checksum over old and new bytes passes",
            !r.error && reqs.length === 1 && reqs[0].range === "bytes=102400-" && sha(fs.readFileSync(path.join(root, f.name))) === f.sha256, { r, reqs });

        f = file("break.onnx", 400000);
        plain("break", f, `${A}/break/${f.name}`);
        r = await attempt(() => d.download("break"));
        const partial = sizeOf(path.join(root, f.name + ".part"));
        check("a broken connection keeps the .part and says it resumes", r.error && /Download again resumes/.test(r.error) && partial > 0 && partial < f.size, { r, partial });
        n = log.length;
        r = await attempt(() => d.download("break"));
        reqs = log.slice(n);
        check("the next download asks for the rest and lands the whole file", !r.error && reqs.length === 1 && reqs[0].range === `bytes=${partial}-` && sha(fs.readFileSync(path.join(root, f.name))) === f.sha256, { r, reqs });

        f = file("corrupt.onnx", 200000);
        plain("corrupt", f, `${A}/ok/${f.name}`);
        fs.writeFileSync(path.join(root, f.name + ".part"), crypto.randomBytes(50000));
        r = await attempt(() => d.download("corrupt"));
        check("a corrupt .part fails the checksum after the resume and is deleted", r.error && /checksum/.test(r.error) && !exists(path.join(root, f.name + ".part")) && !exists(path.join(root, f.name)), r);
        r = await attempt(() => d.download("corrupt"));
        check("then the download starts over and passes", !r.error && sha(fs.readFileSync(path.join(root, f.name))) === f.sha256, r);

        f = file("norange.onnx", 100000);
        plain("norange", f, `${A}/norange/${f.name}`);
        fs.writeFileSync(path.join(root, f.name + ".part"), f.buf.subarray(0, 30000));
        r = await attempt(() => d.download("norange"));
        check("a server that ignores Range: the file is written over from the start", !r.error && sha(fs.readFileSync(path.join(root, f.name))) === f.sha256, r);

        f = file("wrongrange.onnx", 100000);
        plain("wrongrange", f, `${A}/wrongrange/${f.name}`);
        fs.writeFileSync(path.join(root, f.name + ".part"), f.buf.subarray(0, 30000));
        n = log.length;
        r = await attempt(() => d.download("wrongrange"));
        reqs = log.slice(n);
        check("a 206 for another range than asked: the .part dropped, asked again without Range",
            !r.error && reqs.length === 2 && reqs[0].range === "bytes=30000-" && reqs[1].range === null && sha(fs.readFileSync(path.join(root, f.name))) === f.sha256, { r, reqs });

        f = file("whole.onnx", 60000);
        plain("whole", f, `${A}/ok/${f.name}`);
        fs.writeFileSync(path.join(root, f.name + ".part"), f.buf);
        n = log.length;
        r = await attempt(() => d.download("whole"));
        check("a whole .part that checks is kept without a request (SAM2 large's left-over case)", !r.error && log.length === n && sha(fs.readFileSync(path.join(root, f.name))) === f.sha256, r);

        f = file("wholebad.onnx", 60000);
        plain("wholebad", f, `${A}/ok/${f.name}`);
        fs.writeFileSync(path.join(root, f.name + ".part"), crypto.randomBytes(60000));
        n = log.length;
        r = await attempt(() => d.download("wholebad"));
        reqs = log.slice(n);
        check("a whole .part that does not check is fetched again from the start", !r.error && reqs.length === 1 && reqs[0].range === null && sha(fs.readFileSync(path.join(root, f.name))) === f.sha256, { r, reqs });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function setCatalogue(id, files, extra = {}) {
    const m = models.fromSetCatalogue({
        id, kind: "key", label: "Set " + id, subdir: "onnx/" + id, base: `${A}/ok/`,
        files: files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })), ...extra,
    });
    registry[id] = m;
    return m;
}

async function sets() {
    const files = [file("ck_manifest.json", 3000), file("ck_a.weights", 250000), file("ck_b.weights", 180000), file("ck_a_768x768.onnx", 9000)];
    const total = files.reduce((a, f) => a + f.size, 0);
    // the app's own folder
    let root = tmp("set");
    try {
        const m = setCatalogue("ck_test", files);
        const d = downloader(root);
        events = [];
        const r = await attempt(() => d.download("ck_test"));
        const folder = path.join(root, "onnx", "ck_test");
        check("a set lands under onnx/<id>/ of the app folder with its own names", !r.error && files.every((f) => sha(fs.readFileSync(path.join(folder, f.name))) === f.sha256), r);
        const loc = models.locate(m, root);
        check("locate finds the set there; setFolder and paths by name", loc.present && models.setFolder(m, root) === folder && models.paths(m, root)["ck_a.weights"] === path.join(folder, "ck_a.weights"));
        const prog = events.filter((e) => !e.done && !e.error);
        const done = events.find((e) => e.done);
        const mono = prog.every((e, i) => i === 0 || e.setReceived >= prog[i - 1].setReceived);
        const lastPerFile = files.map((f) => prog.filter((e) => e.file === f.name).pop());
        check("overall progress: file i of n, the set's bytes rising to the set's total",
            mono && prog.every((e) => e.count === files.length && e.setTotal === total && e.index >= 1 && e.index <= files.length)
            && lastPerFile.every((e, i) => e && e.index === i + 1 && e.received === files[i].size && e.total === files[i].size)
            && lastPerFile[lastPerFile.length - 1].setReceived === total && done && done.setReceived === total && done.setTotal === total,
            { last: lastPerFile.map((e) => e && [e.index, e.received, e.setReceived]), done });
        const v = await models.verify("ck_test", root, (id) => registry[id]);
        check("verify: every file of the set checks", v.ok && v.files.every((x) => x.ok === true), v);
        const fb = path.join(folder, "ck_b.weights");
        const buf = fs.readFileSync(fb); buf[7] ^= 1; fs.writeFileSync(fb, buf);
        const v2 = await models.verify("ck_test", root, (id) => registry[id]);
        check("verify: a changed byte is found", !v2.ok && v2.files.find((x) => x.name === "ck_b.weights").ok === false);
        // a file of the wrong size in the set's folder counts as missing and is fetched again, the others not
        fs.writeFileSync(fb, buf.subarray(0, 1000));
        check("a set file of the wrong size is not present", !models.locate(m, root).present);
        const n = log.length;
        const r2 = await attempt(() => d.download("ck_test"));
        const reqs = log.slice(n);
        check("downloading again fetches only that file", !r2.error && reqs.length === 1 && reqs[0].path === "/ok/ck_b.weights" && sha(fs.readFileSync(fb)) === files[2].sha256, { r2, reqs });
        const removed = await models.remove("ck_test", root, (id) => registry[id]);
        check("remove deletes the set's files and its folder", removed === files.length && !exists(folder) && exists(path.join(root, "onnx")), removed);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
    // a ComfyUI models folder: under its onnx/ (not onnx/onnx/), and a bare <id>/ folder of the same names never counts
    root = tmp("setcomfy");
    try {
        fs.mkdirSync(path.join(root, "checkpoints"));
        const m = registry.ck_test;
        const bare = path.join(root, "ck_test");
        fs.mkdirSync(bare);
        for (const f of files) fs.writeFileSync(path.join(bare, f.name), f.buf);
        fs.mkdirSync(path.join(root, "onnx"));
        for (const f of files) fs.writeFileSync(path.join(root, "onnx", f.name), f.buf);
        check("a ComfyUI folder: the set's names in a bare <id>/ folder or loose in onnx/ do not count", !models.locate(m, root).present && models.locate(m, root).files.every((f) => !f.present));
        const r = await attempt(() => downloader(root).download("ck_test"));
        check("a ComfyUI folder: the set lands in onnx/<id>/, not onnx/onnx/<id>/", !r.error && models.locate(m, root).present && exists(path.join(root, "onnx", "ck_test", files[1].name)) && !exists(path.join(root, "onnx", "onnx")), r);
        // the scan never links a set (its files must sit together), and reports a ComfyUI pack's fp32 checkpoint
        fs.mkdirSync(path.join(root, "corridorkey2"));
        fs.writeFileSync(path.join(root, "corridorkey2", "corridorkey_v2.safetensors"), "x");
        const sc = models.matchScan(await models.scanFolder(root));
        check("the scan links no set and reports models/corridorkey2/corridorkey_v2.safetensors for CorridorKey 2.0",
            !sc.links.corridorkey2 && !sc.links.ck_test && (sc.elsewhere.corridorkey2 || [])[0] === "corridorkey2/corridorkey_v2.safetensors", sc.elsewhere);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function refusals() {
    const root = tmp("refuse");
    try {
        const files = [file("fd_a.weights", 400000), file("fd_b.weights", 300000), file("fd_c.onnx", 200000)];
        setCatalogue("fd_set", files);
        const d = downloader(root);
        freeBytes = 500000;
        events = [];
        let n = log.length;
        let r = await attempt(() => d.download("fd_set"));
        check("too little free disk: refused before the first request, nothing written, the error event",
            r.error && /Not enough free disk space/.test(r.error) && log.length === n && !exists(path.join(root, "onnx", "fd_set", "fd_a.weights")) && events.some((e) => e.error && /free disk/.test(e.error)), { r, reqs: log.length - n });
        // what is already there does not count against the disk
        const folder = path.join(root, "onnx", "fd_set");
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, "fd_a.weights"), files[0].buf);
        fs.writeFileSync(path.join(folder, "fd_b.weights.part"), files[1].buf.subarray(0, 250000));
        freeBytes = (300000 - 250000) + 200000 + 64 * 1024 * 1024 + 1;
        r = await attempt(() => d.download("fd_set"));
        check("the free-disk check counts only what is left (present files and .part bytes off)", !r.error && models.locate(registry.fd_set, root).present, r);
        freeBytes = Infinity;

        const t = file("terms.onnx", 5000);
        setCatalogue("terms_set", [t], { terms: { version: 1, text: "Terms." } });
        n = log.length;
        r = await attempt(() => d.download("terms_set"));
        check("a set with terms not accepted: refused before any request", r.error && /terms/.test(r.error) && log.length === n, r);
        accepted.add("terms_set");
        r = await attempt(() => d.download("terms_set"));
        check("accepted: it downloads", !r.error && models.locate(registry.terms_set, root).present, r);

        const u = file("nourl.onnx", 5000);
        setCatalogue("nourl_set", [u], { base: null });
        n = log.length;
        r = await attempt(() => d.download("nourl_set"));
        check("a set without URLs: not offered, refused before any request", r.error && /not available/.test(r.error) && log.length === n, r);

        r = await attempt(() => d.download("no_such_model"));
        check("an unknown id is refused", r.error && /unknown model/.test(r.error), r);
    } finally { fs.rmSync(root, { recursive: true, force: true }); freeBytes = Infinity; }
}

async function catalogueTool() {
    // tools/ck2_catalogue.js on a fake built set: sizes and hashes read from the files, offered only with a base URL
    const cat = require("./ck2_catalogue");
    const dir = tmp("cat");
    const root = tmp("catroot");
    try {
        const parts = { "a.weights": crypto.randomBytes(70000), "a_768x768.onnx": crypto.randomBytes(3000), "THIRD_PARTY_NOTICES.md": Buffer.from("notices"), "LICENSE": Buffer.from("licence") };
        for (const [n, b] of Object.entries(parts)) fs.writeFileSync(path.join(dir, n), b);
        fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ files: ["a.weights", "a_768x768.onnx"] }));
        fs.writeFileSync(path.join(dir, "x.onnx.part"), "left over");
        const current = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "electron", "main", "onnx", "corridorkey2.json"), "utf8"));
        const built = await cat.build(dir, { current, version: "t1" });
        const names = built.files.map((f) => f.name);
        check("the catalogue tool: every file with its size and sha256, the manifest first, no .part, the terms kept",
            names[0] === "manifest.json" && names.length === 5 && !names.some((n) => n.endsWith(".part"))
            && built.files.every((f) => f.sha256 === sha(fs.readFileSync(path.join(dir, f.name))) && f.size === fs.statSync(path.join(dir, f.name)).size)
            && built.placeholder === false && built.subdir === "onnx/corridorkey2" && built.terms && built.version === "t1", names);
        const noBase = models.fromSetCatalogue(built);
        check("built without a base URL: not offered", !models.offered(noBase) && !noBase.invalid);
        // serve the built set from A and download it through the registry entry the tool wrote
        for (const [n, b] of Object.entries(parts)) content.set(n, b);
        content.set("manifest.json", fs.readFileSync(path.join(dir, "manifest.json")));
        const withBase = await cat.build(dir, { current, version: "t1", base: `${A}/ok` });
        const m = models.fromSetCatalogue({ ...withBase, id: "cat_set" });
        registry.cat_set = m;
        accepted.add("cat_set");
        check("built with a base URL: offered, every URL the base plus the name", models.offered(m) && m.files.every((f) => f.url === `${A}/ok/${encodeURIComponent(f.name)}`));
        check("the terms paragraph names the size and the host", /about \d\.\d GB/.test(models.termsText(m)) && models.termsText(m).includes("127.0.0.1"));
        const r = await attempt(() => downloader(root).download("cat_set"));
        check("the set the tool described downloads, checks and lands in onnx/<id>/", !r.error && models.locate(m, root).present, r);
        check("--check finds no difference on the folder, and a changed file", (await cat.compare(withBase, dir)).length === 0
            && (() => { fs.writeFileSync(path.join(dir, "LICENSE"), "changed"); return true; })() && (await cat.compare(withBase, dir)).length === 1);
        fs.writeFileSync(path.join(dir, "stray.onnx"), "x");
        const stray = await attempt(() => cat.build(dir, { current }));
        check("a file the manifest does not list is refused", stray.error && /not in the manifest stray\.onnx/.test(stray.error), stray);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); }
}

async function cancelAndBusy() {
    const root = tmp("cancel");
    try {
        const f = file("slow.onnx", 600000);
        plain("slow", f, `${A}/slow/${f.name}`);
        const d = downloader(root);
        events = [];
        const p = d.download("slow");
        let waited = 0;
        while (!events.some((e) => e.received > 0) && waited < 3000) { await sleep(20); waited += 20; }
        const again = await attempt(() => d.download("slow"));
        check("a second download of the same model while it runs is refused", again.error && /already downloading/.test(again.error), again);
        const running = d.running().slow;
        check("running() reports the file, its index and the set's bytes", running && running.file === "slow.onnx" && running.index === 1 && running.count === 1 && running.setTotal === f.size, running);
        d.cancel("slow");
        const r = await attempt(() => p);
        const partial = sizeOf(path.join(root, f.name + ".part"));
        check("cancel: null, a cancelled event, the .part kept for a resume", !r.error && r.value === null && events.some((e) => e.cancelled) && partial >= 0 && !exists(path.join(root, f.name)), { r, partial });
    } finally { await sleep(100); fs.rmSync(root, { recursive: true, force: true }); }
}

(async () => {
    const sa = await listen(handler("A", () => B));
    const sb = await listen(handler("B", () => A));
    A = `http://127.0.0.1:${sa.address().port}`;
    B = `http://127.0.0.1:${sb.address().port}`;
    try {
        tokenRuleTable();
        registryChecks();
        await corridorRefused();
        await stubbedHF();
        await plainDownloads();
        await resumes();
        await sets();
        await refusals();
        await catalogueTool();
        await cancelAndBusy();
    } catch (err) {
        fail++;
        console.log("[FAIL] the test threw:", err && err.stack || err);
    } finally {
        sa.closeAllConnections(); sb.closeAllConnections();
        sa.close(); sb.close();
    }
    console.log(`${fail ? "FAIL" : "PASS"} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
