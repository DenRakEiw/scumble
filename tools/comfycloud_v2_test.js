// Comfy Cloud on the Comfy API v2 through Comfy's SDK (comfycloud.js runV2, docs/PLAN_COMFY_SDK.md S1 and section 10),
// in plain Node against the fake v2 of tools/fake_comfy_v2.js; no Electron, no key, nothing sent to Comfy:
//   node tools/comfycloud_v2_test.js
// Checked: every picture the layout wires is an asset (a core/ASSET reference in its LoadImage) for a partner node and
// for a recipe graph's titled LoadImage nodes; bytes Comfy holds already go by hash with no second upload; the job is
// submitted with an Idempotency-Key, the key again in extra_data and no metadata, the bearer on every v2 call (that the
// signed download carries none rests on fetch dropping Authorization across origins, measured in S1, not on this fake);
// the submit and the uploads follow no redirect; the recipe's own SaveImage answers before a preview; a submit with no
// answer goes once more under the same key, and a refusal of that key (the first one landed) stops the run with the
// lost-answer words, never a third submit, and so does any other refusal of the resend but the workflow's own; a refused
// workflow names the node; a failed job names the node's class and Comfy's message, plus the model file the node list
// lacked; canceled and expired in words; status reads with no answer are read again for two minutes in a row (any
// answer starts that again, scattered misses never add up), past the run's time too, and then end the run without a
// stop request (the job's note stays); a read that hangs gives up on its own limit; a throttled one (429) is waited out;
// a timeout, or a status Comfy refuses, asks Comfy to stop the job, and a cancel that answers "succeeded" still gives the
// result; a dropped or throttled download is read again, one Comfy says is gone is not; a finished job that lists no
// output yet keeps its note, one that lists outputs and no image does not; a 5xx upload goes again under a
// fresh upload key; a gateway's 503 on the submit is sent again under the same key; the node list is advisory (a failed
// read does not stop the run, a node it lacks does) and follows a redirect on its own origin only; a fill recipe's mask;
// Generate new uploads nothing; an upscaler partner node; a test base takes only a test key; the Cancel's flags (asked,
// done, ended, not confirmed) and their words through providers/index.js; the progress throttle on a clock set back; a
// context without cloudApi stays on the legacy API.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const { fakeComfyV2, png, tagOf } = require("./fake_comfy_v2");

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail != null && detail !== "" ? ": " + detail : ""}`);
}
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 600 ? s.slice(0, 600) + " ..." : s; };
async function thrown(fn) { try { await fn(); return null; } catch (err) { return String((err && err.message) || err); } }

const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-cloudv2-test-"));
const orig = Module._load;
Module._load = function (request, ...rest) {
    if (request === "electron") return { app: { getPath: () => USERDATA } };
    return orig.call(this, request, ...rest);
};
const recipes = require(path.join(ROOT, "electron", "main", "recipes.js"));
Module._load = orig;
const cloud = require(path.join(ROOT, "electron", "main", "providers", "comfycloud.js"));

const KEY = "comfyui-0f1e2d3c4b5a69788796a5b4c3d2e1f0aabbccdd";   // the shape of a Comfy key; never a real one
const TEST_KEY = "test-cloudv2-0123456789";
const MOCK = "http://127.0.0.1:5594";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ctxOf = (fake, extra = {}) => ({ key: KEY, fetch: fake.fetch, sleep: async () => {}, log: () => {}, cloudApi: "v2", ...extra });
const KEPT = require(path.join(ROOT, "electron", "main", "providers", "cloudjobs.js")).KEPT;
// a notes store in memory (cloudjobs.store's methods), for a run whose job's note is kept
const memJobs = () => { const m = new Map(); return { add: (e) => m.set(String(e.jobId), e), remove: (id) => m.delete(String(id)), drop: (ids) => ids.forEach((id) => m.delete(String(id))), list: () => [...m.values()], keep: () => {} }; };
const jobReads = (fake) => fake.calls.filter((c) => c.method === "GET" && /^\/api\/v2\/jobs\/[^/]+$/.test(c.path)).length;
const isRef = (v) => !!(v && typeof v === "object" && v.__type === "core/ASSET" && v.info && typeof v.info.id === "string");
const saveIdOf = (wf) => Object.keys(wf).find((id) => wf[id].class_type === "SaveImage");
const v2Calls = (fake) => fake.calls.filter((c) => c.path.startsWith("/api/v2/"));
const posts = (fake) => fake.calls.filter((c) => c.method === "POST" && c.path === "/api/v2/jobs");

const partnerReq = (extra = {}) => ({
    provider: "comfycloud", model: "gpt-image-2", kind: "fill", options: { node: "OpenAIGPTImageNodeV2" }, prompt: "a red door", negative: "", seed: 5,
    image: png("CROP"), mask: png("MASK"), references: [png("REF1"), png("REF2")], width: 1024, height: 768, params: {}, original: 0, ...extra,
});
const saveOutput = (wf) => [{ node_id: saveIdOf(wf), name: "out.png" }];

async function main() {
    const list = await recipes.list(path.join(ROOT, "recipes"));
    const klein = list.find((r) => r.id === "flux2_klein_local");
    const kv = recipes._normalize(JSON.parse(JSON.stringify(recipes.detach(klein).recipe))).providers.comfycloud;
    const all = Object.values(kv.options.graph).map((n) => n.class_type);
    const graphReq = (extra = {}) => ({
        provider: "comfycloud", model: kv.model, kind: "edit", options: kv.options, prompt: "a red door", negative: "blurry", seed: 4242,
        image: png("CROP"), mask: png("MASK"), width: 1024, height: 768, references: [], params: { "unet|unet_name": "my-unet.safetensors", random_seed: false }, original: 0, ...extra,
    });

    // 1. a partner node with the crop, two references and the mask: four assets, each in its LoadImage
    {
        const f = fakeComfyV2({ outputs: saveOutput });
        const c1 = ctxOf(f);
        const out = await cloud.edit(partnerReq(), c1);
        check("a run that brought its picture marks the job done (a Cancel that lands after it is worded as a finished, charged job)", c1.jobDone === true, String(c1.jobDone));
        const bodies = f.calls.filter((c) => c.method === "POST");
        check("the submit and the uploads follow no redirect (the submit's body carries the key)", bodies.length >= 5 && bodies.every((c) => c.redirect === "error"), short(bodies.map((c) => `${c.path} ${c.redirect}`)));
        const body = f.jobs[0] || {};
        const wf = body.workflow || {};
        const loads = Object.entries(wf).filter(([, n]) => n.class_type === "LoadImage");
        const tags = loads.map(([, n]) => (isRef(n.inputs.image) && f.assets.get(n.inputs.image.info.id) ? tagOf(f.assets.get(n.inputs.image.info.id).bytes) : "?"));
        check("a partner node: the crop, the two references and the mask uploaded as assets in that order, under Scumble's file names",
            f.uploads.map((u) => u.tag).join(",") === "CROP,REF1,REF2,MASK" && f.uploads.every((u) => /^scumble-[0-9a-z]+-(crop|ref\d|mask)\.png$/.test(u.filePath)),
            short(f.uploads.map((u) => [u.tag, u.filePath])));
        check("every LoadImage holds a core/ASSET reference to its picture", loads.length === 4 && loads.every(([, n]) => isRef(n.inputs.image)) && tags.join(",") === "CROP,REF1,REF2,MASK", short(tags));
        const partner = Object.values(wf).find((n) => n.class_type === "OpenAIGPTImageNodeV2") || { inputs: {} };
        const mask = Object.values(wf).find((n) => n.class_type === "ImageToMask");
        check("the partner node links the three pictures and the mask through ImageToMask; SaveImage answers",
            ["model.images.image_1", "model.images.image_2", "model.images.image_3"].every((k) => Array.isArray(partner.inputs[k])) && Array.isArray(partner.inputs["model.mask"]) && !!mask && saveIdOf(wf),
            short(partner.inputs));
        check("one submit with an Idempotency-Key, the key again in extra_data, no metadata",
            posts(f).length === 1 && UUID.test(posts(f)[0].idem || "") && body.extra_data && body.extra_data.api_key_comfy_org === KEY && !("metadata" in body) && Object.keys(body).sort().join(",") === "extra_data,workflow",
            short({ idem: posts(f)[0] && posts(f)[0].idem, keys: Object.keys(body) }));
        check("the bearer on every v2 call, no X-API-Key there, Scumble in the User-Agent; the result read once, following the redirect",
            v2Calls(f).length > 0 && v2Calls(f).every((c) => c.auth === `Bearer ${KEY}` && !c.apiKey && /app\/scumble\//.test(c.ua || "")) && f.contents.length === 1 && f.contents[0].redirect === "follow" && f.storage.length === 1,
            short(f.calls.map((c) => `${c.method} ${c.origin}${c.path} ${c.auth ? "bearer" : "-"}`)));
        check("the answer: the SaveImage's bytes, its type, the job's id; no legacy route and no node list for a partner node",
            tagOf(out.bytes) === "RESULT out.png" && out.mime === "image/png" && out.info.job_id === "job-1" && out.info.node === "OpenAIGPTImageNodeV2" && out.seed === 5
            && !f.calls.some((c) => /^\/api\/(prompt|upload|job\/|jobs\/|view)/.test(c.path)) && f.infoReads === 0,
            short({ bytes: tagOf(out.bytes), info: out.info }));

        // 2. the same crop again: Comfy holds those bytes, so they go by hash and are not uploaded twice
        const out2 = await cloud.edit(partnerReq({ references: [], mask: null, kind: "edit" }), ctxOf(f));
        const crop2 = (f.jobs[1] && Object.values(f.jobs[1].workflow).find((n) => n.class_type === "LoadImage")) || { inputs: {} };
        check("bytes Comfy holds go by hash (from-hash), not uploaded again",
            f.uploads.length === 4 && f.fromHash.length === 1 && isRef(crop2.inputs.image) && tagOf(f.assets.get(crop2.inputs.image.info.id).bytes) === "CROP" && tagOf(out2.bytes) === "RESULT out.png",
            short({ uploads: f.uploads.length, fromHash: f.fromHash }));
    }

    // 3. a recipe graph: the crop, the Original and a reference into the titled LoadImage nodes; its own SaveImage
    // answers although a preview comes first; the node list read once, with X-API-Key (v1)
    {
        cloud._clearNodeList();
        const f = fakeComfyV2({ classes: all, outputs: (wf) => [{ node_id: "preview", name: "preview.png" }, { node_id: "scumble_save", name: "own.png" }] });
        const out = await cloud.edit(graphReq({ references: [png("ORIGINAL"), png("REF1")], original: 1 }), ctxOf(f));
        const wf = f.jobs[0].workflow;
        const at = (id) => (isRef(wf[id].inputs.image) ? tagOf(f.assets.get(wf[id].inputs.image.info.id).bytes) : "?");
        check("a recipe graph: picture k into LoadImage k as an asset, the fourth (past the run's last) the last one",
            at("img0") === "CROP" && at("img1") === "ORIGINAL" && at("img2") === "REF1" && at("img3") === "REF1" && wf.img3.inputs.image.info.id === wf.img2.inputs.image.info.id && f.uploads.length === 3,
            short(["img0", "img1", "img2", "img3"].map(at)));
        check("the prompt, the seed and the Settings row in their inputs", wf.pos.inputs.text === "a red door" && wf.noise.inputs.noise_seed === 4242 && wf.unet.inputs.unet_name === "my-unet.safetensors", short({ text: wf.pos.inputs.text, seed: wf.noise.inputs.noise_seed }));
        check("the recipe's own SaveImage answers before a preview listed first", tagOf(out.bytes) === "RESULT own.png", tagOf(out.bytes));
        const info = f.calls.filter((c) => c.path === "/api/object_info");
        check("the node list (v1) read once, with X-API-Key and no bearer", info.length === 1 && info[0].apiKey === KEY && !info[0].auth, short(info));
    }

    // 4. the node list is advisory: a failed read lets the run go (noted in the answer's info); a node a list that was
    // read lacks still stops the run before any upload
    {
        cloud._clearNodeList();
        let f = fakeComfyV2({ infoFails: true, outputs: () => [{ node_id: "scumble_save", name: "own.png" }] });
        const out = await cloud.edit(graphReq(), ctxOf(f));
        check("a node list that cannot be read does not stop the run", tagOf(out.bytes) === "RESULT own.png" && /^unread: /.test(out.info.nodeList || "") && posts(f).length === 1, short(out.info));
        cloud._clearNodeList();
        f = fakeComfyV2({ classes: all.filter((c) => c !== "Flux2Scheduler") });
        const e = await thrown(() => cloud.edit(graphReq(), ctxOf(f)));
        check("a node the list lacks stops the run by name before any upload", /Comfy Cloud has no Flux2Scheduler node/.test(e || "") && f.uploads.length === 0 && f.heads.length === 0 && posts(f).length === 0, e);
        cloud._clearNodeList();
        const away = fakeComfyV2({ classes: all, infoRedirect: "https://elsewhere.example/api/object_info", outputs: () => [{ node_id: "scumble_save", name: "own.png" }] });
        const oa = await cloud.edit(graphReq(), ctxOf(away));
        check("a node list that redirects to another host: refused there, the key never goes along, the run goes without the check",
            /refused a redirect to https:\/\/elsewhere\.example/.test(oa.info.nodeList || "") && !away.calls.some((c) => c.origin === "https://elsewhere.example") && tagOf(oa.bytes) === "RESULT own.png", short({ list: oa.info.nodeList, calls: away.calls.map((c) => c.origin + c.path) }));
        cloud._clearNodeList();
        const same = fakeComfyV2({ classes: all.filter((c) => c !== "Flux2Scheduler"), infoRedirect: "/api/object_info?hop=1" });
        const es = await thrown(() => cloud.edit(graphReq(), ctxOf(same)));
        check("a node list that redirects on its own origin: followed (with the key), and its answer counts", /Comfy Cloud has no Flux2Scheduler node/.test(es || "") && same.infoReads === 1 && same.calls.filter((c) => c.path === "/api/object_info").every((c) => c.apiKey === KEY), es);
    }

    // 5. the lost answer: a submit that landed but whose answer dropped is sent once more under the same key; Comfy
    // refuses the key, and the run stops with the lost-answer words, never a third submit
    {
        const f = fakeComfyV2({ submits: ["lostAfter"], outputs: saveOutput });
        const e = await thrown(() => cloud.edit(partnerReq(), ctxOf(f)));
        const p = posts(f);
        check("a submit that landed without an answer: once more under the same key, then the lost-answer words",
            /answer to the submit was lost/.test(e || "") && /does not send it again/.test(e || "") && p.length === 2 && p[0].idem && p[0].idem === p[1].idem && f.jobs.length === 1,
            short({ e, keys: p.map((c) => c.idem) }));
        const g = fakeComfyV2({ submits: ["lostBefore"], outputs: saveOutput });
        const out = await cloud.edit(partnerReq(), ctxOf(g));
        const q = posts(g);
        check("a submit lost before it landed: the resend under the same key runs the job", tagOf(out.bytes) === "RESULT out.png" && q.length === 2 && q[0].idem === q[1].idem && g.jobs.length === 1, short(q.map((c) => c.idem)));
        const h = fakeComfyV2({ submits: ["lostBefore", "lostBefore", "ok"], outputs: saveOutput });
        const e2 = await thrown(() => cloud.edit(partnerReq(), ctxOf(h)));
        check("no answer twice: stopped, no third submit", /did not answer the submit twice/.test(e2 || "") && posts(h).length === 2, e2);
        const gw = fakeComfyV2({ submits: [{ status: 503, code: "unavailable", message: "gateway", noted: false }], outputs: saveOutput });
        const og = await cloud.edit(partnerReq(), ctxOf(gw));
        check("a gateway's 503 on the submit: once more under the same key, the job runs", tagOf(og.bytes) === "RESULT out.png" && posts(gw).length === 2 && posts(gw)[0].idem === posts(gw)[1].idem && gw.jobs.length === 1, short(posts(gw).map((c) => c.idem)));
        const sv = fakeComfyV2({ submits: [{ status: 500, code: "upstream_error", message: "backend" }], outputs: saveOutput });
        const es = await thrown(() => cloud.edit(partnerReq(), ctxOf(sv)));
        check("a 500 after Comfy noted the key: the resend is refused, the lost-answer words, two submits", /answer to the submit was lost/.test(es || "") && posts(sv).length === 2, es);
        const lim = fakeComfyV2({ submits: ["lostAfter", { status: 429, code: "concurrency_limit_exceeded", message: "one job at a time", beforeKey: true }], outputs: saveOutput });
        const el = await thrown(() => cloud.edit(partnerReq(), ctxOf(lim)));
        check("a resend refused for a limit the first job may hold: the words say the first submit may have landed and be charged, two submits",
            /refused the resent submit/.test(el || "") && /may have landed/.test(el || "") && /may run and be charged/.test(el || "") && posts(lim).length === 2, el);
    }

    // 6. a refused workflow names the node; nothing is resent
    {
        const details = { node_errors: { 6: { class_type: "OpenAIGPTImageNodeV2", errors: [{ message: "Required input is missing", details: "prompt" }] } } };
        const f = fakeComfyV2({ submits: [{ status: 422, code: "invalid_workflow", message: "Prompt outputs failed validation", details }] });
        const e = await thrown(() => cloud.edit(partnerReq(), ctxOf(f)));
        check("a refused workflow: Comfy's words with the node's class, id and message, one submit",
            /^Comfy Cloud prompt: Comfy refused the workflow \(Prompt outputs failed validation \[OpenAIGPTImageNodeV2 6: Required input is missing: prompt\]\)$/.test(e || "") && posts(f).length === 1, e);
        const g = fakeComfyV2({ submits: [{ status: 402, code: "insufficient_credits", message: `no credits on ${KEY}` }] });
        const e2 = await thrown(() => cloud.edit(partnerReq(), ctxOf(g)));
        check("no credits: said so, the key scrubbed, one submit", /no credits left/.test(e2 || "") && !(e2 || "").includes(KEY) && posts(g).length === 1, e2);
    }

    // 7. a failed job: the failing node's class and Comfy's message; a model file the node list lacked is named too
    {
        const f = fakeComfyV2({ statuses: ["running", "failed"], error: { code: "execution_error", message: "content policy", node_id: "6", class_type: "OpenAIGPTImageNodeV2" } });
        const e = await thrown(() => cloud.edit(partnerReq(), ctxOf(f)));
        check("a failed partner job: Comfy's message under the node's name", e === "Comfy Cloud OpenAIGPTImageNodeV2: content policy", e);
        const unetCls = kv.options.graph.unet.class_type;
        const info = { ...Object.fromEntries(all.map((c) => [c, {}])), [unetCls]: { input: { required: { unet_name: [["flux-2-klein-9b.safetensors"], {}] } } }, SaveImage: { output_node: true } };
        cloud._clearNodeList();
        const g = fakeComfyV2({ info, statuses: ["failed"], error: { code: "execution_error", message: `Value not in list: my-unet.safetensors (${KEY})`, node_id: "unet", class_type: unetCls } });
        const e2 = await thrown(() => cloud.edit(graphReq(), ctxOf(g)));
        check("a failed graph job: the class and node, Comfy's message (the key scrubbed), and the file the node list lacked",
            new RegExp(`^Comfy Cloud recipe graph: ${unetCls} \\(node unet\\): Value not in list: my-unet\\.safetensors \\(\\[key\\]\\) Comfy Cloud's node list does not name the model file my-unet\\.safetensors`).test(e2 || ""), e2);
        const n = fakeComfyV2({ statuses: ["failed"] });
        check("a failed job without detail", (await thrown(() => cloud.edit(partnerReq(), ctxOf(n)))) === "Comfy Cloud OpenAIGPTImageNodeV2: the job failed without a reason from Comfy");
        for (const [st, re] of [["canceled", /the job was canceled on Comfy's side/], ["expired", /the job expired on Comfy's side/]]) {
            const c = fakeComfyV2({ statuses: [st] });
            const ec = await thrown(() => cloud.edit(partnerReq(), ctxOf(c)));
            check(`a job ${st} on Comfy's side: said so`, re.test(ec || ""), ec);
        }
    }

    // 8. a status read with no answer is read again; too many stop the run
    {
        const f = fakeComfyV2({ reads: ["lost", "lost"], outputs: saveOutput });
        const out = await cloud.edit(partnerReq(), ctxOf(f));
        check("two status reads without an answer: read again, the run lands", tagOf(out.bytes) === "RESULT out.png", tagOf(out.bytes));
        const lost = (n) => Array.from({ length: n }, () => "lost");
        const o12 = fakeComfyV2({ reads: lost(12), outputs: saveOutput });
        const out12 = await cloud.edit(partnerReq(), ctxOf(o12));
        check("twelve status reads in a row without an answer (an outage of about two minutes, a Wi-Fi back after a wake): read again, the run lands, no stop asked",
            tagOf(out12.bytes) === "RESULT out.png" && o12.cancels.length === 0, tagOf(out12.bytes));
        const g = fakeComfyV2({ reads: lost(30), outputs: saveOutput });
        const gctx = ctxOf(g, { jobs: memJobs() });
        const e = await thrown(() => cloud.edit(partnerReq(), gctx));
        check("status reads without an answer for two minutes: the run ends without a stop request, says the job may still finish, and keeps its note",
            /^Comfy Cloud did not answer about the job \(job-1\) for 1\d\d s \(fetch failed\); it may still finish and be charged\. /.test(e || "") && (e || "").endsWith(KEPT) && g.cancels.length === 0 && gctx.noteKept === true && gctx.jobs.list().length === 1 && jobReads(g) === 13, short({ e, cancels: g.cancels.length, reads: jobReads(g) }));
        const sc = fakeComfyV2({ statuses: [...Array(9).fill("running"), "succeeded"], reads: [].concat(...Array.from({ length: 8 }, () => ["lost", null])), outputs: saveOutput });
        const osc = await cloud.edit(partnerReq(), ctxOf(sc));
        check("eight reads without an answer scattered over one long status, each after an answered one: they never add up, the run lands, no stop asked",
            tagOf(osc.bytes) === "RESULT out.png" && sc.cancels.length === 0, short({ bytes: tagOf(osc.bytes), cancels: sc.cancels.length }));
        const t = fakeComfyV2({ reads: [{ status: 429, code: "rate_limited", message: "slow down", retryAfter: 1 }, { status: 429, code: "rate_limited" }], outputs: saveOutput });
        const out2 = await cloud.edit(partnerReq(), ctxOf(t));
        check("status reads Comfy throttles (429): waited out, the run lands, no cancel, one job", tagOf(out2.bytes) === "RESULT out.png" && t.cancels.length === 0 && t.jobs.length === 1, tagOf(out2.bytes));
        const lost5 = ["lost", "lost", "lost", "lost", "lost"];
        const r = fakeComfyV2({ statuses: ["running", "succeeded"], reads: [...lost5, null, ...lost5], outputs: saveOutput });
        const out4 = await cloud.edit(partnerReq(), ctxOf(r));
        check("five reads without an answer, a new status, five more: the count starts again, the run lands", tagOf(out4.bytes) === "RESULT out.png" && r.cancels.length === 0, tagOf(out4.bytes));
        const q = fakeComfyV2({ statuses: ["queued", "running", "succeeded"], outputs: saveOutput });
        const out3 = await cloud.edit(partnerReq(), ctxOf(q));
        check("queued, running, succeeded: the run lands", tagOf(out3.bytes) === "RESULT out.png" && q.calls.filter((c) => c.method === "GET" && /^\/api\/v2\/jobs\/[^/]+$/.test(c.path)).length === 3, tagOf(out3.bytes));
    }

    // 8c. a machine that slept past the run's time wakes before its network: the reads that get no answer are read again
    // (the job finished meanwhile); a status read that hangs gives up on its own limit and counts as unanswered
    {
        const realNow = Date.now;
        let n = 0;
        const f = fakeComfyV2({ statuses: ["running", "succeeded"], reads: [null, "lost", "lost"], outputs: saveOutput, hold: (c) => {
            if (c.method === "GET" && /^\/api\/v2\/jobs\/[^/]+$/.test(c.path) && ++n === 2) Date.now = () => realNow() + 25 * 60 * 1000;
        } });
        let out = null, e = null;
        try { out = await cloud._runV2(partnerReq(), ctxOf(f), 20 * 60 * 1000); } catch (err) { e = String(err.message || err); } finally { Date.now = realNow; }
        check("woken 25 minutes later, past the run's 20, with the network not back yet: the unanswered reads are read again, the finished job's picture comes, no stop asked",
            !e && out && tagOf(out.bytes) === "RESULT out.png" && f.cancels.length === 0, short({ e, cancels: f.cancels.length }));
        const saved = cloud._times.statusReadMs;
        cloud._times.statusReadMs = 150;
        let hung = 0;
        const h = fakeComfyV2({ statuses: ["running", "succeeded"], outputs: saveOutput, hold: (c, init) => {
            if (!(c.method === "GET" && /^\/api\/v2\/jobs\/[^/]+$/.test(c.path)) || ++hung !== 2) return undefined;
            // a read on a connection that never answers: it ends only when its signal does (a timer keeps this process
            // alive meanwhile: AbortSignal.timeout's own does not)
            return new Promise((resolve, reject) => {
                const keep = setTimeout(() => reject(new Error("the read's own limit never fired")), 5000);
                if (init.signal) init.signal.addEventListener("abort", () => { clearTimeout(keep); reject(init.signal.reason || new Error("aborted")); }, { once: true });
            });
        } });
        const t0 = Date.now();
        let oh = null, eh = null;
        try { oh = await cloud.edit(partnerReq(), ctxOf(h)); } catch (err) { eh = String(err.message || err); } finally { cloud._times.statusReadMs = saved; }
        check("a status read that hangs gives up on its own limit, counts as unanswered, and the next read lands the run",
            !eh && oh && tagOf(oh.bytes) === "RESULT out.png" && hung >= 3 && Date.now() - t0 < 10000, short({ eh, hung, ms: Date.now() - t0 }));
    }

    // 8b. the paid result: a download that dropped or was throttled is read again; one Comfy says is gone is not
    {
        const f = fakeComfyV2({ contents: ["lost", { status: 429, code: "rate_limited" }], outputs: saveOutput });
        const out = await cloud.edit(partnerReq(), ctxOf(f));
        check("a download that dropped, then one throttled: read again, the run lands", tagOf(out.bytes) === "RESULT out.png" && f.contents.length === 3 && posts(f).length === 1, short({ contents: f.contents.length }));
        const g = fakeComfyV2({ contents: [{ status: 404, code: "asset_not_found", message: "gone" }], outputs: saveOutput });
        const e = await thrown(() => cloud.edit(partnerReq(), ctxOf(g)));
        check("a result Comfy says is gone: no second read, the words name the job", /^Comfy Cloud download \(job job-1\): /.test(e || "") && g.contents.length === 1, e);
        const h = fakeComfyV2({ contents: ["lost", "lost", "lost", "lost"], outputs: saveOutput });
        const hctx = ctxOf(h, { jobs: memJobs() });
        const e2 = await thrown(() => cloud.edit(partnerReq(), hctx));
        check("a download that drops three times: stopped after three reads, the words say Scumble keeps the job and brings its picture",
            /^Comfy Cloud download \(job job-1\): fetch failed\. /.test(e2 || "") && (e2 || "").endsWith(KEPT) && h.contents.length === 3 && hctx.noteKept === true, e2);
        const gctx = ctxOf(fakeComfyV2({ contents: [{ status: 404, code: "asset_not_found", message: "gone" }], outputs: saveOutput }), { jobs: memJobs() });
        const e404 = await thrown(() => cloud.edit(partnerReq(), gctx));
        check("a result Comfy says is gone: no promise to bring it, the note goes", !(e404 || "").includes(KEPT) && !gctx.noteKept && gctx.jobs.list().length === 0, e404);
        const j = fakeComfyV2({ outputs: (wf) => [{ node_id: saveIdOf(wf), name: "out.jpg", content_type: "image/jpeg" }] });
        const oj = await cloud.edit(partnerReq(), ctxOf(j));
        check("the answer's type comes from the output", oj.mime === "image/jpeg", oj.mime);
        const k = fakeComfyV2({ outputsAfter: 1, outputs: saveOutput });
        const ok = await cloud.edit(partnerReq(), ctxOf(k));
        check("a finished job that lists its outputs only on the next read: read again, the run lands", tagOf(ok.bytes) === "RESULT out.png", tagOf(ok.bytes));
        // a finished job that still lists no output after the re-reads is paid for: its note stays for a later ask
        const lctx = ctxOf(fakeComfyV2({ outputsAfter: 8, outputs: saveOutput }), { jobs: memJobs() });
        const el = await thrown(() => cloud.edit(partnerReq(), lctx));
        check("a finished job that lists no output after its re-reads: the words say so and end with the keep sentence, the note stays",
            /^Comfy Cloud: the job \(job-1\) finished, and Comfy lists no output of it yet\. /.test(el || "") && (el || "").endsWith(KEPT) && lctx.noteKept === true && lctx.jobs.list().length === 1, short({ el, notes: lctx.jobs.list().length }));
        // one that lists outputs and no image never gets one: no promise, the note goes
        const tctx = ctxOf(fakeComfyV2({ outputs: (wf) => [{ node_id: saveIdOf(wf), name: "out.txt", type: "text", content_type: "text/plain" }] }), { jobs: memJobs() });
        const et = await thrown(() => cloud.edit(partnerReq(), tctx));
        check("a finished job that lists outputs and no image: the without-an-image words, no keep sentence, the note goes",
            /^Comfy Cloud: the job finished without an image \(/.test(et || "") && !(et || "").includes(KEPT) && !tctx.noteKept && tctx.jobs.list().length === 0, short({ et, notes: tctx.jobs.list().length }));
        const p = fakeComfyV2({ outputs: (wf) => [{ node_id: "999", name: "preview.png" }, { node_id: saveIdOf(wf), name: "out.png" }] });
        const op = await cloud.edit(partnerReq(), ctxOf(p));
        check("a partner node: its SaveImage answers before a preview listed first", tagOf(op.bytes) === "RESULT out.png", tagOf(op.bytes));
    }

    // 9. a timeout asks Comfy to stop the job
    {
        const f = fakeComfyV2({ statuses: ["running"] });
        const e = await thrown(() => cloud._runV2(partnerReq(), ctxOf(f), 60));
        check("a timeout: Comfy asked to stop the job (POST cancel with the bearer), then the timeout words",
            /timed out/.test(e || "") && /asked Comfy Cloud to stop the job/.test(e || "") && f.cancels.length === 1 && f.cancels[0].auth === `Bearer ${KEY}` && f.cancels[0].path === "/api/v2/jobs/job-1/cancel",
            short({ e, cancels: f.cancels.length }));
        const g = fakeComfyV2({ statuses: ["running"], cancelSays: "fail" });
        const e2 = await thrown(() => cloud._runV2(partnerReq(), ctxOf(g), 60));
        check("a timeout whose cancel fails: said that the job may still finish and be charged, not that it was stopped",
            /timed out/.test(e2 || "") && /the job \(job-1\) may still finish and be charged/.test(e2 || "") && !/asked Comfy Cloud/.test(e2 || ""), e2);
        const h = fakeComfyV2({ statuses: ["running"], cancelSays: "succeeded", outputs: saveOutput });
        const out = await cloud._runV2(partnerReq(), ctxOf(h), 60);
        check("a timeout whose cancel answers that the job just succeeded: the result is read, not thrown away", tagOf(out.bytes) === "RESULT out.png" && h.cancels.length === 1, tagOf(out.bytes));
    }

    // 9b. the live events (S2): each reaches ctx.progress as a frame (the job's status first), and a summary of what
    // came joins the answer's info; a surface without them (404) changes nothing (every case above)
    {
        const live = [
            { event: "status", data: { status: "running", queue_position: null } },
            { event: "progress", data: { value: 0, nodes_done: 0, nodes_total: 12 } },
            { event: "preview", data: { node_id: "75:64", content_type: "image/jpeg", data_base64: "" } },
            { event: "progress", data: { value: 0.9375, nodes_done: 11, nodes_total: 12 } },
            { event: "status", data: { status: "succeeded", queue_position: null } },
        ];
        const f = fakeComfyV2({ statuses: ["running", "running", "succeeded"], events: live, outputs: saveOutput });
        const frames = [];
        const out = await cloud.edit(partnerReq(), ctxOf(f, { progress: (p) => frames.push(p) }));
        const pf = frames.filter((x) => x.value != null);
        check("live events reach ctx.progress: the job's status first (urgent), the shares with their node counts, the statuses",
            frames[0] && frames[0].status === "queued" && frames[0].urgent === true && pf.length === 2 && pf[1].value === 0.9375 && pf[1].nodesDone === 11 && pf[1].nodesTotal === 12
            && frames.some((x) => x.status === "running") && frames.some((x) => x.status === "succeeded"),
            short(frames));
        check("a preview event is no frame: five frames (the submit's status, two statuses, two shares)", frames.length === 5, short(frames));
        const ev = out.info.events || {};
        check("a summary of the events joins the answer's info", ev.count === 5 && ev.kinds.progress === 2 && ev.kinds.preview === 1 && ev.fields.join(",") === "value,nodesDone,nodesTotal" && ev.value[0] === 0 && ev.value[1] === 0.9375 && ev.statuses.join(",") === "running,succeeded", short(ev));
    }

    // 9c. the user's Cancel (S2, section 10 must 1): the run's signal fires during the wait; Comfy is asked to stop the
    // job on a transport of its own (the run's refuses everything now), and ctx.cancelAsked says it answered
    {
        const f = fakeComfyV2({ statuses: ["running"], events: [{ event: "progress", data: { value: 0.5, nodes_done: 1, nodes_total: 2 } }] });
        const ac = new AbortController();
        // the run's fetch as providers/index.js contextFor builds it: nothing leaves once the run is cancelled
        const runFetch = (url, init = {}) => (ac.signal.aborted ? Promise.reject(Object.assign(new Error("cancelled"), { name: "AbortError" })) : f.fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, ac.signal]) : ac.signal }));
        const ctx = ctxOf(f, { fetch: runFetch, signal: ac.signal, progress: (p) => { if (p.value === 0.5) setTimeout(() => ac.abort(), 20); } });
        const saved = globalThis.fetch;
        globalThis.fetch = f.fetch;   // the cancel's own transport (unbound) is the global fetch
        let e;
        try { e = await thrown(() => cloud.edit(partnerReq(), ctx)); } finally { globalThis.fetch = saved; }
        const c = f.cancels[0] || {};
        check("Cancel during the wait: the run stops, Comfy got POST .../cancel with the bearer, ctx.cancelAsked is set",
            !!e && f.cancels.length === 1 && c.path === "/api/v2/jobs/job-1/cancel" && c.auth === `Bearer ${KEY}` && ctx.cancelAsked === true,
            short({ e, cancels: f.cancels.length, asked: ctx.cancelAsked }));
        const g = fakeComfyV2({ statuses: ["running"], cancelSays: "fail", events: [{ event: "progress", data: { value: 0.5, nodes_done: 1, nodes_total: 2 } }] });
        const ag = new AbortController();
        const gctx = ctxOf(g, { fetch: (url, init = {}) => (ag.signal.aborted ? Promise.reject(new Error("cancelled")) : g.fetch(url, init)), signal: ag.signal, progress: (p) => { if (p.value === 0.5) setTimeout(() => ag.abort(), 20); } });
        globalThis.fetch = g.fetch;
        try { await thrown(() => cloud.edit(partnerReq(), gctx)); } finally { globalThis.fetch = saved; }
        check("a Cancel whose stop request fails twice: no flag says it stopped or ended, the cancel went twice, and no note is claimed without a store",
            !gctx.cancelAsked && !gctx.jobDone && !gctx.jobEnded && !gctx.noteKept && g.cancels.length === 2, short({ asked: gctx.cancelAsked, cancels: g.cancels.length }));
        const h = fakeComfyV2({ statuses: ["running"], cancelSays: "succeeded", events: [{ event: "progress", data: { value: 0.5, nodes_done: 1, nodes_total: 2 } }] });
        const ah = new AbortController();
        const hctx = ctxOf(h, { fetch: (url, init = {}) => (ah.signal.aborted ? Promise.reject(new Error("cancelled")) : h.fetch(url, init)), signal: ah.signal, progress: (p) => { if (p.value === 0.5) setTimeout(() => ah.abort(), 20); } });
        globalThis.fetch = h.fetch;
        try { await thrown(() => cloud.edit(partnerReq(), hctx)); } finally { globalThis.fetch = saved; }
        check("a Cancel answered with succeeded (the job ended meanwhile): not \"asked to stop\", but done and charged", !hctx.cancelAsked && hctx.jobDone === true && h.cancels.length === 1, short({ asked: hctx.cancelAsked, done: hctx.jobDone }));
        for (const st of ["failed", "expired"]) {
            const x = fakeComfyV2({ statuses: ["running"], cancelSays: st, events: [{ event: "progress", data: { value: 0.5, nodes_done: 1, nodes_total: 2 } }] });
            const ax = new AbortController();
            const xctx = ctxOf(x, { fetch: (url, init = {}) => (ax.signal.aborted ? Promise.reject(new Error("cancelled")) : x.fetch(url, init)), signal: ax.signal, progress: (p) => { if (p.value === 0.5) setTimeout(() => ax.abort(), 20); } });
            globalThis.fetch = x.fetch;
            try { await thrown(() => cloud.edit(partnerReq(), xctx)); } finally { globalThis.fetch = saved; }
            check(`a Cancel answered with ${st} (the job ended without a picture meanwhile): ctx.jobEnded says so, not "asked to stop"`, xctx.jobEnded === st && !xctx.cancelAsked && !xctx.jobDone, short({ ended: xctx.jobEnded, asked: xctx.cancelAsked }));
        }
        const k = fakeComfyV2({ statuses: ["running"], cancelSays: "fail", events: [{ event: "progress", data: { value: 0.5, nodes_done: 1, nodes_total: 2 } }] });
        const ak = new AbortController();
        const kctx = ctxOf(k, { jobs: memJobs(), fetch: (url, init = {}) => (ak.signal.aborted ? Promise.reject(new Error("cancelled")) : k.fetch(url, init)), signal: ak.signal, progress: (p) => { if (p.value === 0.5) setTimeout(() => ak.abort(), 20); } });
        globalThis.fetch = k.fetch;
        try { await thrown(() => cloud.edit(partnerReq(), kctx)); } finally { globalThis.fetch = saved; }
        check("a Cancel whose stop Comfy did not confirm keeps the job's note (the job may still run and be charged)", kctx.noteKept === true && kctx.jobs.list().length === 1 && !kctx.cancelAsked, short({ kept: kctx.noteKept, notes: kctx.jobs.list().length }));
    }

    // 9d. a live stream that drops, and the status read right after it fails (the SDK's own reconnect ends there): the
    // following joins again after a pause; a share lower than one sent is not passed on
    {
        const f = fakeComfyV2({
            statuses: ["running", "running", "running", "succeeded"], outputs: saveOutput,
            events: (k) => (k === 1 ? { frames: [{ event: "progress", data: { value: 0.1, nodes_done: 0, nodes_total: 4 } }], drop: true }
                : { frames: [{ event: "progress", data: { value: 0.05, nodes_done: 0, nodes_total: 4 } }, { event: "progress", data: { value: 0.3, nodes_done: 1, nodes_total: 4 } }, { event: "status", data: { status: "succeeded" } }] }),
        });
        const frames = [];
        const out = await cloud.edit(partnerReq(), ctxOf(f, { progress: (p) => frames.push(p) }));
        const vals = frames.filter((x) => x.value != null).map((x) => x.value);
        check("a dropped stream whose next status read fails: joined again, the shares go on (the lower replay left out), the run lands",
            tagOf(out.bytes) === "RESULT out.png" && f.eventReads >= 2 && vals.join(",") === "0.1,0.3" && out.info.events.value[0] === 0.05, short({ reads: f.eventReads, vals }));
    }

    // 9e. a run that ends while its live stream would go on forever (no terminal frame, the cancel refused): the
    // following stops with the run, nothing hangs
    {
        const g = fakeComfyV2({ statuses: ["running"], cancelSays: "fail", events: [{ event: "progress", data: { value: 0.5, nodes_done: 1, nodes_total: 2 } }] });
        const raced = await Promise.race([thrown(() => cloud._runV2(partnerReq(), ctxOf(g), 60)), new Promise((r) => setTimeout(() => r("HUNG"), 3000))]);
        check("a timed-out run with an endless live stream: the run ends (the following stopped with it)", raced !== "HUNG" && /timed out/.test(raced || ""), raced);
    }

    // 10. Generate new on a recipe's text-to-image graph: nothing uploaded, the size in steps of 16
    {
        const z = list.find((r) => r.id === "cloud_z_image_turbo").providers.comfycloud;
        cloud._clearNodeList();
        const f = fakeComfyV2({ classes: z.options.needs, outputs: () => [{ node_id: z.options.save, name: "z.png" }] });
        const out = await cloud.generate({ provider: "comfycloud", model: z.text.model, kind: "text", options: z.options, prompt: "a lighthouse", negative: "", seed: 77, width: 1000, height: 777, references: [], params: {} }, ctxOf(f));
        const wf = f.jobs[0].workflow;
        const at = (k) => z.options.values[k].map(([id, input]) => wf[id].inputs[input]);
        check("Generate new: nothing uploaded, the prompt, the seed, 1000 x 777 as 1008 x 784, its SaveImage answers",
            tagOf(out.bytes) === "RESULT z.png" && f.uploads.length === 0 && f.heads.length === 0 && at("prompt").every((x) => x === "a lighthouse") && at("seed").every((x) => x === 77) && at("width").every((x) => x === 1008) && at("height").every((x) => x === 784),
            short({ uploads: f.uploads.length, width: at("width"), height: at("height") }));
    }

    // 11. an upscaler partner node: the picture as an asset, the factor as the node takes it
    {
        const f = fakeComfyV2({ outputs: saveOutput });
        const out = await cloud.upscale({ provider: "comfycloud", model: "MagnificImageUpscalerPreciseV2Node", kind: "upscale", options: { node: "MagnificImageUpscalerPreciseV2Node" }, factor: 4, image: png("PIC"), references: [png("X")], params: {} }, ctxOf(f));
        const wf = f.jobs[0].workflow;
        const node = Object.values(wf).find((n) => n.class_type === "MagnificImageUpscalerPreciseV2Node") || { inputs: {} };
        check("Magnific Precise V2 on v2: one picture as an asset, 4x, no downscale on its own",
            tagOf(out.bytes) === "RESULT out.png" && f.uploads.map((u) => u.tag).join(",") === "PIC" && node.inputs.scale_factor === "4x" && node.inputs.auto_downscale === false && isRef(wf["1"].inputs.image),
            short(node.inputs));
    }

    // 12. an upload Comfy refuses: named as an upload's, nothing submitted; one that got a 5xx after Comfy noted its key
    // goes again under a fresh key, and the run's own handle finds the bytes by hash
    {
        const f = fakeComfyV2({ uploadFails: { status: 401, code: "unauthorized", message: "invalid key" } });
        const e = await thrown(() => cloud.edit(partnerReq(), ctxOf(f)));
        check("a refused upload: named with the file and the key words, nothing submitted", /^Comfy Cloud upload \(scumble-[0-9a-z]+-crop\.png\): the key was refused/.test(e || "") && posts(f).length === 0, e);
        const g = fakeComfyV2({ uploadsSay: [{ status: 500, code: "upstream_error", message: "storage broke" }], outputs: saveOutput });
        const out = await cloud.edit(partnerReq(), ctxOf(g));
        const crop = Object.values(g.jobs[0].workflow).find((n) => n.class_type === "LoadImage");
        check("an upload that got a 5xx: sent again under a fresh upload key, the run's handle by hash, one job",
            tagOf(out.bytes) === "RESULT out.png" && g.uploadKeys.length === 5 && new Set(g.uploadKeys).size === 5 && g.fromHash.length === 1 && g.jobs.length === 1 && tagOf(g.assets.get(crop.inputs.image.info.id).bytes) === "CROP",
            short({ keys: g.uploadKeys.length, fromHash: g.fromHash.length }));
    }

    // 12b. a recipe graph that takes the mask: the mask an asset in its scumble:mask LoadImage; the model file in the
    // cloud's spelling; a failure with a file the list lacks reads the list again for the next run
    {
        const withMask = JSON.parse(JSON.stringify(klein));
        withMask.prompt.extra = { class_type: "SetLatentNoiseMask", inputs: { samples: ["noise", 0], mask: [klein.canvas, 1] } };
        const fill = recipes._normalize(JSON.parse(JSON.stringify(recipes.detach(withMask).recipe))).providers.comfycloud;
        cloud._clearNodeList();
        const f = fakeComfyV2({ classes: Object.values(fill.options.graph).map((n) => n.class_type), outputs: () => [{ node_id: "scumble_save", name: "fill.png" }] });
        const out = await cloud.edit(graphReq({ options: fill.options, kind: "fill" }), ctxOf(f));
        const mask = Object.values(f.jobs[0].workflow).find((n) => n._meta && n._meta.title === "scumble:mask");
        check("a fill recipe on v2: the crop and the mask as assets, the mask in its scumble:mask LoadImage, no legacy upload",
            tagOf(out.bytes) === "RESULT fill.png" && f.uploads.map((u) => u.tag).join(",") === "CROP,MASK" && mask && isRef(mask.inputs.image) && tagOf(f.assets.get(mask.inputs.image.info.id).bytes) === "MASK" && !f.calls.some((c) => c.path === "/api/upload/image"),
            short(f.uploads.map((u) => u.tag)));
        const g0 = fakeComfyV2({ classes: Object.values(fill.options.graph).map((n) => n.class_type) });
        const e0 = await thrown(() => cloud.edit(graphReq({ options: fill.options, kind: "fill", mask: null }), ctxOf(g0)));
        check("a fill recipe without a mask: refused before any request to v2", /needs a selection mask/.test(e0 || "") && v2Calls(g0).length === 0, e0);
        const unetCls = kv.options.graph.unet.class_type;
        const infoWith = (files) => ({ ...Object.fromEntries(all.map((c) => [c, {}])), [unetCls]: { input: { required: { unet_name: [files, {}] } } }, SaveImage: { output_node: true } });
        cloud._clearNodeList();
        const h = fakeComfyV2({ info: infoWith(["klein/my-unet.safetensors"]), outputs: () => [{ node_id: "scumble_save", name: "own.png" }] });
        await cloud.edit(graphReq({ params: { "unet|unet_name": "klein" + String.fromCharCode(92) + "my-unet.safetensors", random_seed: false } }), ctxOf(h));
        check("a model file written with backslashes goes out in the cloud's spelling", h.jobs[0].workflow.unet.inputs.unet_name === "klein/my-unet.safetensors", h.jobs[0].workflow.unet.inputs.unet_name);
        const twice = async (files) => {
            cloud._clearNodeList();
            const fk = fakeComfyV2({ info: infoWith(files), statuses: ["failed"], error: { code: "execution_error", message: "boom" } });
            for (let i = 0; i < 2; i++) await thrown(() => cloud.edit(graphReq(), ctxOf(fk)));
            return fk.infoReads;
        };
        const reread = await twice(["other.safetensors"]), kept = await twice(["my-unet.safetensors"]);
        check("a failure with a file the list lacks reads the list again for the next run; one without keeps it", reread === 2 && kept === 1, short({ reread, kept }));
    }

    // 13. a test base: only a test key goes there, and every request with it (the node list too)
    {
        cloud._clearNodeList();
        const f = fakeComfyV2({ origin: MOCK, classes: all, outputs: () => [{ node_id: "scumble_save", name: "own.png" }] });
        const out = await cloud.edit(graphReq(), ctxOf(f, { key: TEST_KEY, base: MOCK }));
        check("a test key with a test base: every request to the mock, the node list too", tagOf(out.bytes) === "RESULT own.png" && f.calls.filter((c) => c.origin !== "https://storage.example").every((c) => c.origin === MOCK) && f.infoReads === 1, short(f.calls.map((c) => c.origin + c.path)));
        const g = fakeComfyV2({ origin: MOCK, classes: all });
        const e = await thrown(() => cloud.edit(graphReq(), ctxOf(g, { base: MOCK })));
        check("a real key with a test base: refused before any request", /only a test key/.test(e || "") && g.calls.length === 0, e);
    }

    // 15. through providers/index.js, the app's path: the settings give the v2 default and the test base; the live
    // frames reach hooks.progress with the run's id, a share within 250 ms of the last one waits and is replaced, and a
    // status sends the share that waited first; a Cancel's words say where the job stood (asked to stop, not sent yet,
    // already finished)
    {
        const idxPath = path.join(ROOT, "electron", "main", "providers", "index.js");
        const origLoad = Module._load;
        Module._load = function (request, parent, ...rest) {
            if (request === "electron") return { nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) } };
            if (parent && parent.filename === idxPath) {
                if (request === "../log") return { record: () => {} };
                if (request === "../keys") return { get: () => TEST_KEY, describe: (id) => ({ name: id, set: true, hint: "6789" }) };
                if (request === "../settings") return { get: () => ({ comfycloud: { base: MOCK } }) };
            }
            return origLoad.call(this, request, parent, ...rest);
        };
        let index;
        try { index = require(idxPath); } finally { Module._load = origLoad; }
        const saved = globalThis.fetch;
        const viaIndex = async (fake, request) => {
            globalThis.fetch = fake.fetch;
            const frames = [];
            try { return { out: await index.edit(request, { progress: (x) => frames.push(x) }), frames, err: null }; } catch (e) { return { out: null, frames, err: String((e && e.message) || e) }; } finally { globalThis.fetch = saved; }
        };
        const live = [
            { event: "status", data: { status: "running" } },
            { event: "progress", data: { value: 0, nodes_done: 0, nodes_total: 12 } },
            { event: "progress", data: { value: 0.9375, nodes_done: 11, nodes_total: 12 } },
            { event: "status", data: { status: "succeeded" } },
        ];
        cloud._clearNodeList();
        const a = fakeComfyV2({ origin: MOCK, statuses: ["running", "running", "running", "succeeded"], events: live, outputs: saveOutput });
        const ra = await viaIndex(a, { ...partnerReq(), runId: "idx-1" });
        const shares = ra.frames.filter((x) => x.value != null);
        const iShare = ra.frames.findIndex((x) => x.value === 0.9375), iDone = ra.frames.findIndex((x) => x.status === "succeeded");
        check("index.edit: v2 by default against the test base, the frames with the run's id, the share that waited sent before the end",
            !ra.err && tagOf(Buffer.from(ra.out.bytes)) === "RESULT out.png" && a.calls.every((c) => c.origin === MOCK || c.origin === "https://storage.example")
            && ra.frames.length > 0 && ra.frames.every((x) => x.runId === "idx-1" && !("urgent" in x)) && shares.length === 1 && iShare >= 0 && iShare < iDone && ra.frames[0].status === "queued",
            short({ err: ra.err, frames: ra.frames }));
        let fired = false;
        const once = (re, method) => (c) => { if (!fired && c.method === method && re.test(c.path)) { fired = true; index.cancel(c.runId); } };
        const cancelOn = async (re, method, extra = {}) => {
            fired = false;
            const runId = `idx-${re.source.length}-${method}`;
            const f = fakeComfyV2({ origin: MOCK, outputs: saveOutput, ...extra, hold: (c) => once(re, method)({ ...c, runId }) });
            return { f, r: await viaIndex(f, { ...partnerReq(), runId }) };
        };
        const w = await cancelOn(/^\/api\/v2\/jobs\/[^/]+$/, "GET", { statuses: ["running"] });
        check("a Cancel while the job runs: Comfy asked to stop it, said so", /^Cancelled after \d+\.\d s: Scumble asked Comfy Cloud to stop the job\.$/.test(w.r.err || "") && w.f.cancels.length === 1, w.r.err);
        const u = await cancelOn(/^\/api\/v2\/assets\/by-hash\//, "HEAD");
        check("a Cancel during the uploads: nothing submitted, said so", /^Cancelled after \d+\.\d s, before the job went to Comfy Cloud: nothing runs or is charged\.$/.test(u.r.err || "") && posts(u.f).length === 0 && u.f.cancels.length === 0, u.r.err);
        const dl = await cancelOn(/\/content$/, "GET");
        check("a Cancel during the download of a finished job: done and charged, its picture not kept", /^Cancelled after \d+\.\d s: the job had already finished on Comfy Cloud and is charged; its picture was not kept\.$/.test(dl.r.err || "") && dl.f.cancels.length === 0, dl.r.err);
        globalThis.fetch = saved;
        const fl = await cancelOn(/^\/api\/v2\/jobs\/[^/]+$/, "GET", { statuses: ["running"], cancelSays: "failed" });
        check("a Cancel as the job failed on Comfy: the words say it had already ended without a picture", /^Cancelled after \d+\.\d s: the job had already ended on Comfy Cloud \(failed\) without a picture\.$/.test(fl.r.err || ""), fl.r.err);
        const nf = await cancelOn(/^\/api\/v2\/jobs\/[^/]+$/, "GET", { statuses: ["running"], cancelSays: "fail" });
        check("a Cancel whose stop is not confirmed (no data folder here, so no note): the may-still-finish words without the keep sentence", /^Cancelled after \d+\.\d s: Scumble stopped waiting for Comfy Cloud, which may still finish the job and charge it\.$/.test(nf.r.err || "") && nf.f.cancels.length === 2, nf.r.err);
        // a Cancel that comes after the last upload, before the submit: the guard before the submit stops the run
        {
            let ups = 0;
            const runId = "idx-pre-submit";
            const f = fakeComfyV2({ origin: MOCK, outputs: saveOutput });
            const wrap = { fetch: async (u, i = {}) => {
                const r = await f.fetch(u, i);
                if (String(i.method || "GET").toUpperCase() === "POST" && new URL(String(u)).pathname === "/api/v2/assets" && ++ups === 4) index.cancel(runId);
                return r;
            } };
            const r = await viaIndex(wrap, { ...partnerReq(), runId });
            check("a Cancel after the last upload, before the submit: nothing submitted, the words say nothing runs", /^Cancelled after \d+\.\d s, before the job went to Comfy Cloud: nothing runs or is charged\.$/.test(r.err || "") && ups === 4 && posts(f).length === 0 && f.cancels.length === 0, short({ err: r.err, ups }));
        }
    }

    // 15b. the progress throttle runs on the monotonic clock: a wall clock set back after a frame holds no share
    {
        const idx = require(path.join(ROOT, "electron", "main", "providers", "index.js"));
        const got = [];
        const realNow = Date.now;
        const fn = idx._progressSender("clock", (x) => got.push(x));
        fn({ status: "running", urgent: true });
        Date.now = () => realNow() - 60000;   // a time sync after a wake sets the clock back a minute
        try {
            await new Promise((r) => setTimeout(r, 300));
            fn({ value: 0.5 });
            await new Promise((r) => setTimeout(r, 400));
        } finally { Date.now = realNow; fn.stop(); }
        check("a wall clock set back a minute: the next share still reaches the bar at once", got.length === 2 && got[1].value === 0.5 && got[1].runId === "clock", short(got));
    }

    // 14. a context that names no API (a direct call, the plain-Node tests of the legacy path) stays on the legacy API
    {
        const f = fakeComfyV2({ outputs: saveOutput });
        await thrown(() => cloud.edit(partnerReq(), { key: KEY, fetch: f.fetch, sleep: async () => {} }));
        check("no cloudApi: the legacy upload first, no v2 call", (f.calls[0] || {}).path === "/api/upload/image" && v2Calls(f).length === 0, short(f.calls.map((c) => c.path)));
    }

    fs.rmSync(USERDATA, { recursive: true, force: true });
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
