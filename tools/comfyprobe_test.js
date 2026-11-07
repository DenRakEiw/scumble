// Settings › ComfyUI's Test (electron/main/comfy.js ComfyClient.probe), in plain Node against a stub server:
//   node tools/comfyprobe_test.js
// P15 (docs/PLAN_WASM_BUILD.md §7 "The user's answers after K4"): after /system_stats the probe's requests go together,
// not one after another, and its answer is what the serial probe of before gave, key for key in the same order: the
// stub answers every request after a delay, so the serial probe takes about thirteen delays and this one about three.
// A list that fails, a server without the node pack (no /inpaint_canvas/info asked), a request that never answers (the
// others are still read, the timeout ends it without an error) and a refused /system_stats are checked too. The gate
// comfyview runs it first.
"use strict";

const http = require("node:http");
const { ComfyClient } = require("../electron/main/comfy.js");

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}

const DELAY = 120;
const combo = (name, values) => ({ input: { required: { [name]: [values] } } });
const v3 = (name, values) => ({ input: { required: { [name]: ["COMBO", { options: values }] } } });
const ANSWERS = {
    "/system_stats": { system: { comfyui_version: "0.44.0", python_version: "3.12.7", os: "nt" }, devices: [{ name: "cuda:0 RTX", vram_total: 25769803776, vram_free: 20000000000 }] },
    "/queue": { queue_running: [[1]], queue_pending: [[2], [3]] },
    "/object_info/InpaintCanvas": { InpaintCanvas: { input: {} } },
    "/inpaint_canvas/info": { version: "0.4.1" },
    "/object_info/UNETLoader": { UNETLoader: combo("unet_name", ["flux-2-klein-9b.safetensors", "qwen_image.safetensors"]) },
    "/object_info/CheckpointLoaderSimple": { CheckpointLoaderSimple: combo("ckpt_name", ["sdxl.safetensors"]) },
    "/object_info/CLIPLoader": { CLIPLoader: v3("clip_name", ["qwen_3_8b.safetensors"]) },
    "/object_info/DualCLIPLoader": { DualCLIPLoader: { input: { required: { clip_name1: [["clip_l.safetensors"]], clip_name2: [["t5.safetensors"]] } } } },
    "/object_info/VAELoader": { VAELoader: combo("vae_name", ["ae.safetensors"]) },
    // LoraLoader 500 (a list that fails), ControlNetLoader without its input, UpscaleModelLoader a combo
    "/object_info/LoraLoaderModelOnly": { LoraLoaderModelOnly: combo("lora_name", ["a.safetensors", "b.safetensors"]) },
    "/object_info/ControlNetLoader": { ControlNetLoader: { input: { required: {} } } },
    "/object_info/UpscaleModelLoader": { UpscaleModelLoader: combo("model_name", ["4x.pth"]) },
};

/** A stub ComfyUI: every answer after DELAY ms; `opts.missing` paths answer 404, `opts.hang` paths never answer. */
function stub(opts = {}) {
    const seen = [];
    let flying = 0, most = 0;
    const server = http.createServer((req, res) => {
        const p = req.url.split("?")[0];
        seen.push(p);
        flying++; most = Math.max(most, flying);
        const done = () => { flying--; };
        if ((opts.hang || []).includes(p)) { req.on("close", done); return; }
        setTimeout(() => {
            done();
            if (p === "/object_info/LoraLoader") { res.writeHead(500); res.end("boom"); return; }
            if (p === "/system_stats" && opts.refuse) { res.writeHead(401); res.end("no"); return; }
            const a = (opts.missing || []).includes(p) ? undefined : ANSWERS[p];
            if (a === undefined) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(a));
        }, DELAY);
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, seen, most: () => most })));
}

// The probe as it was before P15 (comfy.js at 8689d49), each request awaited in turn: the reference for the answer
const MODEL_COMBOS = {
    UNETLoader: ["unet_name"], CheckpointLoaderSimple: ["ckpt_name"], CLIPLoader: ["clip_name"], DualCLIPLoader: ["clip_name1", "clip_name2"],
    VAELoader: ["vae_name"], LoraLoader: ["lora_name"], LoraLoaderModelOnly: ["lora_name"], ControlNetLoader: ["control_net_name"], UpscaleModelLoader: ["model_name"],
};
async function serialProbe(url, headers = {}, { timeoutMs = 15000 } = {}) {
    const base = String(url || "").trim().replace(/\/+$/, "");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const get = (p) => fetch(base + p, { headers, signal: ac.signal, redirect: "follow" });
    try {
        const t0 = Date.now();
        const r = await get("/system_stats");
        if (!r.ok) throw new Error(`/system_stats answered ${r.status}`);
        const stats = await r.json();
        const out = {
            ok: true, url: base, latency: Date.now() - t0,
            version: stats && stats.system ? stats.system.comfyui_version : "?",
            python: stats && stats.system ? stats.system.python_version : "",
            os: stats && stats.system ? stats.system.os : "",
            devices: ((stats && stats.devices) || []).map((d) => ({ name: d.name, vramTotal: d.vram_total, vramFree: d.vram_free })),
            node: false, nodeVersion: "", queue: null, models: {},
        };
        try { const q = await get("/queue"); if (q.ok) { const j = await q.json(); out.queue = { running: (j.queue_running || []).length, pending: (j.queue_pending || []).length }; } } catch (_) { /* ignore */ }
        try { const n = await get("/object_info/InpaintCanvas"); out.node = n.status === 200 && Object.keys(await n.json()).length > 0; } catch (_) { out.node = false; }
        if (out.node) { try { const i = await get("/inpaint_canvas/info"); if (i.ok) out.nodeVersion = (await i.json()).version || ""; } catch (_) { /* older node */ } }
        for (const [cls, inputs] of Object.entries(MODEL_COMBOS)) {
            try {
                const r2 = await get("/object_info/" + cls);
                if (!r2.ok) continue;
                const info = (await r2.json())[cls];
                const req = (info && info.input && info.input.required) || {};
                for (const inp of inputs) {
                    const spec = req[inp];
                    const opts = Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0] : (spec && spec[1] && Array.isArray(spec[1].options) ? spec[1].options : null);
                    if (opts) out.models[`${cls}.${inp}`] = opts;
                }
            } catch (_) { /* ignore */ }
        }
        return out;
    } finally { clearTimeout(timer); }
}

// the latency differs from run to run, the URL from stub to stub (each run has its own port)
const noLatency = (o) => { const c = { ...o }; delete c.latency; c.url = c.url.replace(/:\d+$/, ":port"); return JSON.stringify(c); };

async function main() {
    // 1. the answer, key for key, and the time
    let s = await stub();
    let t0 = Date.now();
    const want = await serialProbe(s.url);
    const serialMs = Date.now() - t0, serialMost = s.most();
    await new Promise((r) => s.server.close(r));
    s = await stub();
    t0 = Date.now();
    const got = await ComfyClient.probe(s.url);
    const ms = Date.now() - t0;
    check("the answer is the serial probe's, key for key in the same order (the models in MODEL_COMBOS order)", noLatency(got) === noLatency(want), noLatency(got).slice(0, 300));
    check("it holds what the stub has: the queue, the node pack and its version, eight model lists (LoraLoader's 500 and ControlNetLoader's missing input left out)",
        got.queue && got.queue.running === 1 && got.queue.pending === 2 && got.node === true && got.nodeVersion === "0.4.1"
        && JSON.stringify(Object.keys(got.models)) === JSON.stringify(["UNETLoader.unet_name", "CheckpointLoaderSimple.ckpt_name", "CLIPLoader.clip_name", "DualCLIPLoader.clip_name1", "DualCLIPLoader.clip_name2", "VAELoader.vae_name", "LoraLoaderModelOnly.lora_name", "UpscaleModelLoader.model_name"]),
        JSON.stringify(Object.keys(got.models)));
    check("the requests after /system_stats go together: about three delays instead of thirteen",
        s.most() >= 10 && serialMost === 1 && ms < serialMs / 2 && ms < 6 * DELAY, `${ms} ms (serial ${serialMs} ms), at most ${s.most()} at once (serial ${serialMost})`);
    check("every request asked once, /system_stats first", s.seen[0] === "/system_stats" && s.seen.length === 13 && new Set(s.seen).size === 13, s.seen.join(" "));
    await new Promise((r) => s.server.close(r));

    // 2. no node pack: its version is not asked
    s = await stub({ missing: ["/object_info/InpaintCanvas"] });
    const bare = await ComfyClient.probe(s.url);
    check("a server without the node pack: node false, no /inpaint_canvas/info asked, the lists still read",
        bare.node === false && bare.nodeVersion === "" && !s.seen.includes("/inpaint_canvas/info") && Object.keys(bare.models).length === 8, s.seen.join(" "));
    await new Promise((r) => s.server.close(r));

    // 3. a request that never answers: the timeout ends the probe without an error, the others are read
    s = await stub({ hang: ["/object_info/VAELoader"] });
    t0 = Date.now();
    let hung = null, err = null;
    try { hung = await ComfyClient.probe(s.url, {}, { timeoutMs: 1500 }); } catch (e) { err = e; }
    const hungMs = Date.now() - t0;
    check("a list that never answers is left out when the time is up; the probe answers, with every other list",
        !err && hung && !("VAELoader.vae_name" in hung.models) && Object.keys(hung.models).length === 7 && hung.node === true && hungMs >= 1400 && hungMs < 4000,
        err ? err.message : `${hungMs} ms, ${Object.keys(hung.models).length} lists`);
    s.server.closeAllConnections();
    await new Promise((r) => s.server.close(r));

    // 4. the server refuses: the same error as before, nothing else asked
    s = await stub({ refuse: true });
    let refused = "";
    try { await ComfyClient.probe(s.url); } catch (e) { refused = e.message; }
    check("a refused /system_stats: the auth message, nothing else asked", /refuses the request \(401\)/.test(refused) && s.seen.length === 1, refused + " / " + s.seen.join(" "));
    await new Promise((r) => s.server.close(r));

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.log("[FAIL] " + ((e && e.stack) || e)); console.log("FAIL"); process.exit(1); });
