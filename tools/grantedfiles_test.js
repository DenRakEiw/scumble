// electron/main/grantedfiles.js in plain Node: the token route that hands File › Open's file (and load_image's path) to
// the window without one IPC message (docs/BUGS.md "Ctrl+O sends the whole file to the window in one message"). The
// checked grant (a file gone, a folder), the whole file across many read pieces, ranges, HEAD, unknown, released and
// capped tokens, a file gone since the grant, the words of each answer. Run by the openfile gate before its in-app
// steps; alone: node tools/grantedfiles_test.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GrantedFiles, parseRange, fileProblem } = require("../electron/main/grantedfiles.js");

let failed = 0;
function check(name, ok, info) {
    console.log(`${ok ? "[ok]" : "[FAIL]"} ${name}${ok ? "" : ": " + JSON.stringify(info)}`);
    if (!ok) failed++;
}
async function rejects(p) { try { await p; return null; } catch (err) { return err; } }

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-grantedfiles-"));
    const file = path.join(dir, "big picture.psd");
    // 3.5 MiB: four of the stream's 1 MiB pieces, the last one short
    const bytes = Buffer.alloc(3.5 * 1048576);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + (i >> 11)) & 255;
    fs.writeFileSync(file, bytes);
    const small = path.join(dir, "a.png");
    fs.writeFileSync(small, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const empty = path.join(dir, "empty.tif");
    fs.writeFileSync(empty, Buffer.alloc(0));
    const body = async (r) => Buffer.from(await r.arrayBuffer());
    try {
        check("parseRange forms", JSON.stringify([parseRange("bytes=0-", 10), parseRange("bytes=2-5", 10), parseRange("bytes=-3", 10), parseRange("bytes=8-99", 10), parseRange("bytes=10-", 10), parseRange("bytes=5-2", 10), parseRange("bytes=-0", 10), parseRange(null, 10), parseRange("items=1-2", 10), parseRange("bytes=-", 10), parseRange(" bytes=1-1 ", 10)])
            === JSON.stringify([{ start: 0, end: 9 }, { start: 2, end: 5 }, { start: 7, end: 9 }, { start: 8, end: 9 }, "bad", "bad", "bad", null, null, null, { start: 1, end: 1 }]), null);
        check("fileProblem words", fileProblem({ code: "ENOENT" }, "C:/x/a.psd") === "a.psd is not there any more"
            && fileProblem({ code: "EACCES" }, "/x/a.psd") === "Scumble may not read a.psd (no permission)"
            && fileProblem({ code: "EPERM" }, "/x/a.psd") === "Scumble may not read a.psd (no permission)"
            && fileProblem({ code: "EISDIR" }, "/x/d") === "d is a folder, not a file"
            && fileProblem({ code: "EBUSY" }, "/x/a.psd") === "a.psd is in use by another program"
            && /^could not read a\.psd: boom$/.test(fileProblem(new Error("boom"), "/x/a.psd")), null);

        const g = new GrantedFiles({ max: 3, types: { ".png": "image/png" } });
        const got = await g.grantReadable(file);
        check("grantReadable: a token of 32 hex characters, the size, the name, the absolute path", /^[0-9a-f]{32}$/.test(got.token) && got.size === bytes.length && got.name === "big picture.psd" && got.path === path.resolve(file) && g.has(got.token) && !got.token.includes("big"), got);

        let err = await rejects(g.grantReadable(path.join(dir, "nope.psd")));
        check("grantReadable of a missing file: refused in words with its code, no token", err && err.message === "nope.psd is not there any more" && err.code === "ENOENT" && g.grants.size === 1, err && [err.message, err.code, g.grants.size]);
        err = await rejects(g.grantReadable(dir));
        check("grantReadable of a folder: refused, no token", err && /is a folder, not a file$/.test(err.message) && err.code === "EISDIR" && g.grants.size === 1, err && [err.message, err.code, g.grants.size]);

        let r = await g.serve(got.token, { method: "GET" });
        let b = await body(r);
        check("GET without a range: 200, the whole file over many pieces, its length", r.status === 200 && b.equals(bytes) && r.headers.get("content-length") === String(bytes.length) && r.headers.get("accept-ranges") === "bytes" && r.headers.get("cache-control") === "no-store", { s: r.status, n: b.length });
        check("an extension without a type: application/octet-stream", r.headers.get("content-type") === "application/octet-stream", r.headers.get("content-type"));
        check("a second GET of the same token (a grant serves until it is released)", (await body(await g.serve(got.token, {}))).equals(bytes), null);

        r = await g.serve(got.token, { method: "GET", range: "bytes=1048570-2097160" });
        b = await body(r);
        check("a range across a piece's border: 206, its bytes, content-range", r.status === 206 && b.equals(bytes.subarray(1048570, 2097161)) && r.headers.get("content-range") === `bytes 1048570-2097160/${bytes.length}` && r.headers.get("content-length") === String(2097161 - 1048570), { s: r.status, n: b.length, cr: r.headers.get("content-range") });
        r = await g.serve(got.token, { method: "GET", range: "bytes=0-0" });
        b = await body(r);
        check("a one-byte range", r.status === 206 && b.length === 1 && b[0] === bytes[0] && r.headers.get("content-range") === `bytes 0-0/${bytes.length}`, { s: r.status, n: b.length });
        r = await g.serve(got.token, { method: "GET", range: "bytes=-5" });
        b = await body(r);
        check("a suffix range", r.status === 206 && b.equals(bytes.subarray(bytes.length - 5)), { s: r.status, n: b.length });
        r = await g.serve(got.token, { method: "GET", range: `bytes=${bytes.length}-` });
        check("a range past the end: 416 with the size", r.status === 416 && r.headers.get("content-range") === `bytes */${bytes.length}`, { s: r.status });
        r = await g.serve(got.token, { method: "HEAD" });
        check("HEAD: the length, no body", r.status === 200 && r.headers.get("content-length") === String(bytes.length) && (await body(r)).length === 0, { s: r.status });
        r = await g.serve(got.token, { method: "PUT" });
        check("another method: 405", r.status === 405, r.status);

        const s = g.grant(small);
        r = await g.serve(s, {});
        check("a typed extension: image/png, the bytes", r.headers.get("content-type") === "image/png" && (await body(r)).equals(fs.readFileSync(small)), r.headers.get("content-type"));
        const e = g.grant(empty);
        r = await g.serve(e, { range: "bytes=0-" });
        check("an empty file: 200, length 0, no range", r.status === 200 && r.headers.get("content-length") === "0" && (await body(r)).length === 0, { s: r.status });

        r = await g.serve("0".repeat(32), { method: "GET" });
        check("an unknown token: 404 in the route's words", r.status === 404 && (await r.text()) === "no such file", r.status);
        r = await g.serve("../../etc/passwd", { method: "GET" });
        check("a path for a token: 404", r.status === 404, r.status);
        r = await g.serve(path.resolve(file), { method: "GET" });
        check("the granted file's own path for a token: 404", r.status === 404, r.status);

        check("release drops the token, once", g.release(got.token) && !g.has(got.token) && !g.release(got.token) && (await g.serve(got.token, {})).status === 404, null);

        const ts = [g.grant(file), g.grant(file), g.grant(file), g.grant(file)];
        check("more than max: the oldest goes", !g.has(ts[0]) && g.has(ts[1]) && g.has(ts[3]) && g.grants.size === 3, g.grants.size);

        const words = new GrantedFiles({ words: { missing: "no such video", gone: "the video is gone" } });
        const w = words.grant(file);
        fs.renameSync(file, file + ".moved");
        r = await words.serve(w, { method: "GET" });
        const t = await r.text();
        check("a file gone since the grant: 404 in words", r.status === 404 && t === "the video is gone: big picture.psd is not there any more", { s: r.status, t });
        r = await words.serve("f".repeat(32), {});
        check("the route's own words for an unknown token", (await r.text()) === "no such video", null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log(failed ? `FAIL ${failed}` : "PASS");
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); console.log("FAIL"); process.exit(1); });
