// A Comfy Cloud job back after a crash (docs/PLAN_COMFY_SDK.md S6), in plain Node against the fake v2 of
// tools/fake_comfy_v2.js; no Electron, no key, nothing sent to Comfy:
//   node tools/cloudjobs_test.js
// Checked: the notes file (cloudjobs.js) adds, replaces, removes and empties itself, written whole; a v2 run notes its
// job while it waits and takes the note out at its end (a result, a failure, the user's Cancel); at a start a noted job
// that succeeded comes back as its picture (its own SaveImage first) and its note goes, one still running stays, a
// failed, an expired and an unknown (404) one go, one Comfy did not answer stays, one older than a day goes unread;
// without a key nothing is asked; nothing is ever submitted again; through providers/index.js the pictures come back
// as bytes the window can open and the notes file holds what is left.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const { fakeComfyV2, png, tagOf } = require("./fake_comfy_v2");
const cloudjobs = require(path.join(ROOT, "electron", "main", "providers", "cloudjobs.js"));
const cloud = require(path.join(ROOT, "electron", "main", "providers", "comfycloud.js"));

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail != null && detail !== "" ? ": " + detail : ""}`);
}
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 500 ? s.slice(0, 500) + " ..." : s; };
async function thrown(fn) { try { await fn(); return null; } catch (err) { return String((err && err.message) || err); } }

const KEY = "comfyui-0f1e2d3c4b5a69788796a5b4c3d2e1f0aabbccdd";   // the shape of a Comfy key; never a real one
const TEST_KEY = "test-cloudjobs-0123456789";
const MOCK = "http://127.0.0.1:5596";
const HOUR = 60 * 60 * 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "scumble-cloudjobs-"));
const fileIn = (dir) => path.join(dir, cloudjobs.FILE);
const partnerReq = () => ({ provider: "comfycloud", model: "gpt-image-2", kind: "edit", options: { node: "OpenAIGPTImageNodeV2" }, prompt: "a door", seed: 5, image: png("CROP"), references: [], width: 512, height: 512, params: {}, original: 0 });
const saveOutput = (wf) => [{ node_id: Object.keys(wf).find((id) => wf[id].class_type === "SaveImage"), name: "out.png" }];

async function main() {
    // 1. the notes file
    {
        const dir = tmp();
        const st = cloudjobs.store(dir);
        st.add({ jobId: "a", model: "m", node: "n", saveId: 7, started: 1000 });
        st.add({ jobId: "b", started: 2000 });
        st.add({ jobId: "a", model: "m2", started: 3000 });
        const j = JSON.parse(fs.readFileSync(fileIn(dir), "utf8"));
        check("the notes file: one note per job (a second add replaces), the save id as a string, no temp file left",
            j.version === 1 && j.jobs.map((e) => e.jobId).join(",") === "b,a" && j.jobs[1].model === "m2" && st.list().length === 2 && !fs.existsSync(fileIn(dir) + ".tmp"), short(j));
        st.remove("b");
        st.remove("nope");
        check("remove takes one note out, an unknown id changes nothing", st.list().map((e) => e.jobId).join(",") === "a");
        st.remove("a");
        check("the last note out: the file is gone", !fs.existsSync(fileIn(dir)) && st.list().length === 0);
        fs.writeFileSync(fileIn(dir), "{not json");
        check("a broken file reads as no notes, and add writes a good one over it", st.list().length === 0 && (st.add({ jobId: "c" }), st.list().length === 1));
        for (let i = 0; i < 60; i++) st.add({ jobId: "x" + i });
        check("at most 50 notes are kept (the newest)", st.list().length === 50 && st.list()[49].jobId === "x59");
        st.drop(["x10", "x11", "nope"]);
        check("drop takes out exactly the named notes", st.list().length === 48 && !st.list().some((e) => e.jobId === "x10" || e.jobId === "x11"));
        // Windows holding the file a moment (a scanner): the rename is tried again
        const realRename = fs.renameSync;
        let refusals = 0;
        fs.renameSync = (...a) => { if (refusals < 2) { refusals++; throw Object.assign(new Error("busy"), { code: "EPERM" }); } return realRename(...a); };
        try { st.add({ jobId: "late" }); } finally { fs.renameSync = realRename; }
        check("a rename Windows refuses twice (EPERM) is tried again and lands", refusals === 2 && st.list().some((e) => e.jobId === "late"), refusals);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // 2. a v2 run notes its job while it waits and takes the note out at its end
    {
        const dir = tmp();
        const jobs = cloudjobs.store(dir);
        let during = null;
        const f = fakeComfyV2({ statuses: ["running", "succeeded"], outputs: saveOutput, hold: (c) => { if (c.method === "GET" && /^\/api\/v2\/jobs\/[^/]+$/.test(c.path) && during == null) during = jobs.list(); } });
        const out = await cloud.edit(partnerReq(), { key: KEY, fetch: f.fetch, sleep: async () => {}, log: () => {}, cloudApi: "v2", jobs });
        check("while the job runs it is noted (its id, model, node, the SaveImage's id); after the result the note is gone",
            !!during && during.length === 1 && during[0].jobId === "job-1" && during[0].model === "gpt-image-2" && during[0].node === "OpenAIGPTImageNodeV2" && during[0].saveId != null && tagOf(out.bytes) === "RESULT out.png" && jobs.list().length === 0, short(during));
        const g = fakeComfyV2({ statuses: ["failed"] });
        await thrown(() => cloud.edit(partnerReq(), { key: KEY, fetch: g.fetch, sleep: async () => {}, log: () => {}, cloudApi: "v2", jobs }));
        check("a failed job: the note is gone too", jobs.list().length === 0);
        const ac = new AbortController();
        const h = fakeComfyV2({ statuses: ["running"], events: [{ event: "progress", data: { value: 0.5, nodes_done: 1, nodes_total: 2 } }] });
        const saved = globalThis.fetch;
        globalThis.fetch = h.fetch;
        try {
            await thrown(() => cloud.edit(partnerReq(), { key: KEY, fetch: (u, i = {}) => (ac.signal.aborted ? Promise.reject(new Error("cancelled")) : h.fetch(u, i)), signal: ac.signal, sleep: async () => {}, log: () => {}, cloudApi: "v2", jobs, progress: (p) => { if (p.value === 0.5) setTimeout(() => ac.abort(), 20); } }));
        } finally { globalThis.fetch = saved; }
        check("the user's Cancel: Comfy asked to stop the job, and the note is gone", h.cancels.length === 1 && jobs.list().length === 0);
        const legacy = fakeComfyV2({ outputs: saveOutput });
        await thrown(() => cloud.edit(partnerReq(), { key: KEY, fetch: legacy.fetch, sleep: async () => {}, jobs }));
        check("the legacy API notes nothing", !fs.existsSync(fileIn(dir)));
        // a job that succeeded but whose picture did not come (the download dropped three times): paid, so its note stays
        const dl = fakeComfyV2({ contents: ["lost", "lost", "lost"], outputs: saveOutput });
        await thrown(() => cloud.edit(partnerReq(), { key: KEY, fetch: dl.fetch, sleep: async () => {}, log: () => {}, cloudApi: "v2", jobs }));
        check("a succeeded job whose download failed: its note stays for the next start", jobs.list().map((e) => e.jobId).join(",") === "job-1", short(jobs.list()));
        jobs.keep([]);
        // a job whose status cannot be read any more (it may still run): its note stays too
        const unread = fakeComfyV2({ reads: ["lost", "lost", "lost", "lost", "lost", "lost", "lost"], outputs: saveOutput });
        await thrown(() => cloud.edit(partnerReq(), { key: KEY, fetch: unread.fetch, sleep: async () => {}, log: () => {}, cloudApi: "v2", jobs }));
        check("a job whose status could not be read: its note stays", jobs.list().length === 1, short(jobs.list()));
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // 3. at a start: what each noted job comes back as
    {
        const dir = tmp();
        const jobs = cloudjobs.store(dir);
        const now = Date.now();
        jobs.keep([
            { jobId: "done", model: "Klein", node: "recipe graph", saveId: "9", started: now - HOUR },
            { jobId: "running", started: now - HOUR },
            { jobId: "failed", started: now - HOUR },
            { jobId: "expired", started: now - HOUR },
            { jobId: "gone", started: now - HOUR },
            { jobId: "offline", started: now - HOUR },
            { jobId: "old", started: now - 25 * HOUR },
        ]);
        const f = fakeComfyV2({
            origin: MOCK,
            jobsById: {
                done: { status: "succeeded", outputs: [{ node_id: "preview", name: "preview.png" }, { node_id: "9", name: "own.png" }] },
                running: { status: "running" }, failed: { status: "failed" }, expired: { status: "expired" }, gone: 404, offline: "lost", old: { status: "succeeded", outputs: [{ node_id: "9", name: "old.png" }] },
            },
        });
        // a run that starts while the recovery waits on Comfy: its note must survive the recovery's write
        const f0 = f.fetch;
        f.fetch = async (u, i) => { if (/\/jobs\/running$/.test(new URL(String(u)).pathname)) jobs.add({ jobId: "new-run", started: now }); return f0(u, i); };
        const r = await cloud.recoverJobs(jobs, { key: TEST_KEY, base: MOCK, fetch: f.fetch, sleep: async () => {} });
        const left = jobs.list().map((e) => e.jobId).sort().join(",");
        check("a noted job that succeeded: its own SaveImage's picture comes back with its model and start; its note stays until the window has it",
            r.pictures.length === 1 && r.pictures[0].jobId === "done" && tagOf(r.pictures[0].bytes) === "RESULT own.png" && r.pictures[0].model === "Klein" && r.pictures[0].mime === "image/png" && left.includes("done"), short(r.pictures.map((p) => ({ id: p.jobId, tag: tagOf(p.bytes) }))));
        check("still running and not answered (offline): kept; failed, expired, unknown (404) and the old one: dropped; a note added meanwhile stays",
            left === "done,new-run,offline,running" && r.kept === 2 && r.keptIds.sort().join(",") === "offline,running" && r.dropped === 4, short({ left, kept: r.kept, dropped: r.dropped }));
        // a job that lists its picture only on the next read; one whose picture cannot be fetched; reading only some notes
        jobs.keep([{ jobId: "nobytes", saveId: "9", started: now - HOUR }, { jobId: "late", saveId: "9", started: now - HOUR }, { jobId: "other", started: now - HOUR }]);
        const g2 = fakeComfyV2({ origin: MOCK, contents: [{ status: 404, code: "asset_not_found" }], jobsById: {
            nobytes: { status: "succeeded", outputs: [{ node_id: "9", name: "x.png" }] }, late: { status: "succeeded", outputsAfter: 1, outputs: [{ node_id: "9", name: "late.png" }] }, other: { status: "running" } } });
        const r3 = await cloud.recoverJobs(jobs, { key: TEST_KEY, base: MOCK, fetch: g2.fetch, sleep: async () => {} }, now, ["nobytes", "late"]);
        check("only the named notes are read; a picture listed on the next read comes back; one that cannot be fetched keeps its note",
            r3.pictures.length === 1 && r3.pictures[0].jobId === "late" && tagOf(r3.pictures[0].bytes) === "RESULT late.png" && r3.keptIds.join(",") === "nobytes" && !g2.calls.some((c) => c.path.endsWith("/jobs/other")),
            short({ pictures: r3.pictures.map((p) => p.jobId), kept: r3.keptIds, calls: g2.calls.map((c) => c.path) }));
        check("a note older than a day is dropped unread, and nothing is ever submitted again",
            !f.calls.some((c) => c.path.includes("/jobs/old")) && !f.calls.some((c) => c.method === "POST"), short(f.calls.map((c) => `${c.method} ${c.path}`)));
        const g = fakeComfyV2({ origin: MOCK });
        jobs.keep([{ jobId: "a", started: now - HOUR }, { jobId: "b", started: now - 30 * HOUR }]);
        const r2 = await cloud.recoverJobs(jobs, { key: "", base: MOCK, fetch: g.fetch });
        check("without a key nothing is asked: the fresh note waits, the old one goes", r2.skipped === "no key" && g.calls.length === 0 && jobs.list().map((e) => e.jobId).join(",") === "a", short(r2));
        const h = fakeComfyV2({ origin: MOCK });
        const e3 = await thrown(() => cloud.recoverJobs(jobs, { key: KEY, base: MOCK, fetch: h.fetch }));
        check("a real key for a test base: refused before any request, the note kept", /only a test key/.test(e3 || "") && h.calls.length === 0 && jobs.list().length === 1, e3);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // 4. through providers/index.js: the data folder, the key and the test base from the app's own modules
    {
        const dir = tmp();
        cloudjobs.store(dir).keep([{ jobId: "done", model: "Z-Image Turbo", saveId: "9", started: Date.now() - HOUR }, { jobId: "running", started: Date.now() - HOUR }]);
        const idxPath = path.join(ROOT, "electron", "main", "providers", "index.js");
        const logged = [];
        const origLoad = Module._load;
        Module._load = function (request, parent, ...rest) {
            if (request === "electron") return { app: { getPath: () => dir }, nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) } };
            if (parent && parent.filename === idxPath) {
                if (request === "../log") return { record: (x) => logged.push(x) };
                if (request === "../keys") return { get: () => TEST_KEY, describe: (id) => ({ name: id, set: true, hint: "6789" }) };
                if (request === "../settings") return { get: () => ({ comfycloud: { base: MOCK } }) };
            }
            return origLoad.call(this, request, parent, ...rest);
        };
        let index;
        try { delete require.cache[idxPath]; index = require(idxPath); } finally { Module._load = origLoad; }
        const f = fakeComfyV2({ origin: MOCK, jobsById: { done: { status: "succeeded", outputs: [{ node_id: "9", name: "z.png" }] }, running: { status: "running" } } });
        const saved = globalThis.fetch;
        globalThis.fetch = f.fetch;
        let r;
        try { r = await index.recoverCloudJobs(); } finally { globalThis.fetch = saved; }
        const p0 = (r && r.pictures[0]) || {};
        const before = cloudjobs.store(dir).list().map((e) => e.jobId).sort().join(",");
        index.ackCloudJob("done");
        check("index.recoverCloudJobs: the picture as bytes for the window, the model and the start; both notes stay until the window acks the picture, then only the running one; a line in the log",
            r.pictures.length === 1 && p0.bytes instanceof Uint8Array && tagOf(Buffer.from(p0.bytes)) === "RESULT z.png" && p0.model === "Z-Image Turbo" && before === "done,running" && cloudjobs.store(dir).list().map((e) => e.jobId).join(",") === "running" && logged.some((l) => /1 result of an earlier run brought back, 1 still noted/.test(l.message || "")),
            short({ n: r.pictures.length, before, left: cloudjobs.store(dir).list(), log: logged.map((l) => l.message) }));
        fs.rmSync(dir, { recursive: true, force: true });
        const empty = tmp();
        Module._load = function (request, parent, ...rest) {
            if (request === "electron") return { app: { getPath: () => empty }, nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) } };
            if (parent && parent.filename === idxPath) {
                if (request === "../log") return { record: () => {} };
                if (request === "../keys") return { get: () => TEST_KEY, describe: (id) => ({ name: id, set: true, hint: "6789" }) };
                if (request === "../settings") return { get: () => ({ comfycloud: { base: MOCK } }) };
            }
            return origLoad.call(this, request, parent, ...rest);
        };
        let index2;
        try { delete require.cache[idxPath]; index2 = require(idxPath); } finally { Module._load = origLoad; }
        const g = fakeComfyV2({ origin: MOCK });
        globalThis.fetch = g.fetch;
        let r2;
        try { r2 = await index2.recoverCloudJobs(); } finally { globalThis.fetch = saved; }
        check("no notes: nothing asked, nothing logged", r2.pictures.length === 0 && g.calls.length === 0);
        fs.rmSync(empty, { recursive: true, force: true });
    }

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
