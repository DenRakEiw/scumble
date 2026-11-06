// tools/fake_comfy_v2.js on a loopback port, for the app's gates (item 50, docs/PLAN_LORAS.md LR5: the loras and
// commands gates run a Comfy Cloud recipe against it, the app's settings.comfycloud.base pointing here and a test key):
//   node tools/fake_comfy_v2_http.js < options.json
// The options (JSON on stdin): `info` (the node list), `loraAssets` ({ own, shared }), `outputs` ([{ node_id, name }]
// every finished job lists), `picture` (base64 of the PNG every output answers; the fake's own bytes are no picture),
// and any other fakeComfyV2 option that is plain data. It prints "LISTEN <port>" once it listens on 127.0.0.1.
// GET /__state answers what it saw: { jobs (the submitted bodies' workflows), calls ({ method, path, query, bearer,
// apiKey }: whether each carried the bearer or X-API-Key, and which key: "test" for a key starting "test-", else
// "other"), assetReads, infoReads, uploads }; POST /__quit ends it. Nothing here reaches the network.
"use strict";

const http = require("node:http");
const { fakeComfyV2 } = require("./fake_comfy_v2");

function readStdin() {
    return new Promise((resolve) => {
        let s = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (d) => { s += d; });
        process.stdin.on("end", () => resolve(s));
    });
}

const keyKind = (v) => (v == null ? null : /^(Bearer )?test-/.test(String(v)) ? "test" : "other");

async function main() {
    const opts = JSON.parse((await readStdin()) || "{}");
    const picture = opts.picture ? Buffer.from(opts.picture, "base64") : null;
    const outputs = Array.isArray(opts.outputs) ? opts.outputs : [];
    const server = http.createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { picture: _p, outputs: _o, ...rest } = opts;
    const fake = fakeComfyV2({ ...rest, origin, outputs: () => outputs });
    server.on("request", async (req, res) => {
        try {
            const url = new URL(req.url, origin);
            if (url.pathname === "/__state") {
                const body = {
                    jobs: fake.jobs.map((j) => j.workflow), assetReads: fake.assetReads || 0, infoReads: fake.infoReads, uploads: fake.uploads.length,
                    calls: fake.calls.map((c) => ({ method: c.method, path: c.path, query: new URL(c.url).search, bearer: keyKind(c.auth), apiKey: keyKind(c.apiKey) })),
                };
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(body));
                return;
            }
            if (url.pathname === "/__quit") { res.writeHead(200); res.end("bye"); server.close(); setTimeout(() => process.exit(0), 50); return; }
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const raw = Buffer.concat(chunks);
            const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string"));
            let body;
            if (raw.length) {
                // the multipart uploads go through the fake as the FormData it reads
                if (/^multipart\/form-data/.test(headers["content-type"] || "")) body = await new Response(raw, { headers: { "content-type": headers["content-type"] } }).formData();
                else body = raw.toString("utf8");
            }
            // the fake follows its own storage redirect when asked to (the content route), so the app gets the bytes
            const r = await fake.fetch(url.href, { method: req.method, headers, body, redirect: "follow" });
            let bytes = Buffer.from(await r.arrayBuffer());
            const type = r.headers.get("content-type") || "application/json";
            if (picture && /^image\//.test(type) && /\/content$/.test(url.pathname)) bytes = picture;
            const out = { "content-type": type };
            for (const h of ["location", "retry-after"]) if (r.headers.get(h)) out[h] = r.headers.get(h);
            res.writeHead(r.status, out);
            res.end(bytes);
        } catch (err) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { code: "fake_error", message: String((err && err.message) || err) } }));
        }
    });
    process.stdout.write(`LISTEN ${server.address().port}\n`);
}

main().catch((err) => { process.stderr.write(String((err && err.stack) || err) + "\n"); process.exit(1); });
