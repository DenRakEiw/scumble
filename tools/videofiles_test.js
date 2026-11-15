// electron/main/videofiles.js in plain Node: the token route that serves File › Open's video to the frame picker
// (CLAUDE.md item 68). Ranges as Chromium's player sends them, HEAD, unknown and released tokens, a grant cap, a file
// that went away. Run by the videoframe gate before its in-app steps; alone: node tools/videofiles_test.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { VideoFiles, isVideoPath, parseRange } = require("../electron/main/videofiles.js");

let failed = 0;
function check(name, ok, info) {
    console.log(`${ok ? "[ok]" : "[FAIL]"} ${name}${ok ? "" : ": " + JSON.stringify(info)}`);
    if (!ok) failed++;
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-videofiles-"));
    const file = path.join(dir, "clip.mov");
    const bytes = Buffer.alloc(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    fs.writeFileSync(file, bytes);
    const body = async (r) => Buffer.from(await r.arrayBuffer());
    try {
        check("isVideoPath", isVideoPath("a.MP4") && isVideoPath("x/y.webm") && isVideoPath("b.m4v") && isVideoPath("c.mov") && !isVideoPath("d.png") && !isVideoPath("e.mp4.png"), null);
        check("parseRange forms", JSON.stringify([parseRange("bytes=0-", 10), parseRange("bytes=2-5", 10), parseRange("bytes=-3", 10), parseRange("bytes=8-99", 10), parseRange("bytes=10-", 10), parseRange("bytes=5-2", 10), parseRange(null, 10), parseRange("items=1-2", 10)])
            === JSON.stringify([{ start: 0, end: 9 }, { start: 2, end: 5 }, { start: 7, end: 9 }, { start: 8, end: 9 }, "bad", "bad", null, null]), [parseRange("bytes=-3", 10)]);

        const v = new VideoFiles({ max: 3 });
        const t = v.grant(file);
        check("a token is 32 hex characters and names no path", /^[0-9a-f]{32}$/.test(t) && !t.includes("clip"), t);

        let r = await v.serve(t, { method: "GET" });
        let b = await body(r);
        check("GET without a range: 200, the whole file, accept-ranges", r.status === 200 && b.equals(bytes) && r.headers.get("accept-ranges") === "bytes" && r.headers.get("content-length") === "1000", { s: r.status, n: b.length });
        check(".mov is served as video/mp4", r.headers.get("content-type") === "video/mp4", r.headers.get("content-type"));

        r = await v.serve(t, { method: "GET", range: "bytes=100-199" });
        b = await body(r);
        check("a range: 206, its bytes, content-range", r.status === 206 && b.equals(bytes.subarray(100, 200)) && r.headers.get("content-range") === "bytes 100-199/1000" && r.headers.get("content-length") === "100", { s: r.status, n: b.length, cr: r.headers.get("content-range") });

        r = await v.serve(t, { method: "GET", range: "bytes=900-" });
        b = await body(r);
        check("an open range to the end", r.status === 206 && b.equals(bytes.subarray(900)) && r.headers.get("content-range") === "bytes 900-999/1000", { s: r.status, n: b.length });

        r = await v.serve(t, { method: "GET", range: "bytes=-10" });
        b = await body(r);
        check("a suffix range", r.status === 206 && b.equals(bytes.subarray(990)), { s: r.status, n: b.length });

        r = await v.serve(t, { method: "GET", range: "bytes=5000-" });
        check("a range past the end: 416 with the size", r.status === 416 && r.headers.get("content-range") === "bytes */1000", { s: r.status });

        r = await v.serve(t, { method: "HEAD" });
        check("HEAD: the length, no body", r.status === 200 && r.headers.get("content-length") === "1000" && (await body(r)).length === 0, { s: r.status });

        r = await v.serve(t, { method: "POST" });
        check("another method: 405", r.status === 405, r.status);

        r = await v.serve("0".repeat(32), { method: "GET" });
        check("an unknown token: 404", r.status === 404, r.status);
        r = await v.serve("../../etc/passwd", { method: "GET" });
        check("a path for a token: 404", r.status === 404, r.status);

        check("release drops the token", v.release(t) && !v.has(t) && (await v.serve(t, {})).status === 404, null);

        const ts = [v.grant(file), v.grant(file), v.grant(file), v.grant(file)];
        check("more than max: the oldest goes", !v.has(ts[0]) && v.has(ts[1]) && v.has(ts[3]) && v.grants.size === 3, v.grants.size);

        fs.unlinkSync(file);
        r = await v.serve(ts[3], { method: "GET" });
        check("a file gone since the grant: 404", r.status === 404, r.status);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log(failed ? `FAIL ${failed}` : "PASS");
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); console.log("FAIL"); process.exit(1); });
