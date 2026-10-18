// A Comfy Cloud job back after a crash (docs/PLAN_COMFY_SDK.md S6), in plain Node against the fake v2 of
// tools/fake_comfy_v2.js; no Electron, no key, nothing sent to Comfy:
//   node tools/cloudjobs_test.js
// Checked: the notes file (cloudjobs.js) adds, replaces, removes and empties itself, written whole, writes nothing over
// notes it could not read, and names the notes a full file pushes out (the ones past a day first); a v2 run notes its
// job while it waits and takes the note out at its end (a result, a failure, the user's Cancel that Comfy took), and
// keeps it, saying so, when the picture is paid but did not come (a failed download, no output listed yet), when the
// status went unanswered, and when a Cancel's stop was not confirmed; a job whose run is in flight is left to its run.
// At an ask a noted job that succeeded comes back as its picture (its own SaveImage first) and its note goes only with
// the ack; one still running (running), one Comfy did not answer about or refused (unanswered: offline, 401, 403, 429,
// 503, a re-read with no answer) and one whose picture could not be downloaded yet or that lists no output yet (unread)
// stay; a failed, an expired, an unknown (404) one, one whose picture is gone (404) and one that lists outputs but no
// image go, one older than a day goes unread; `skip` leaves pictures the window has alone; without a key nothing is
// asked; nothing is ever submitted again. Through providers/index.js: the pictures as bytes the window
// can open, `earlier` for a note of before this process, a run made the app's way notes its job, a run whose page went
// away puts the note back and tells the window, a run that keeps its note tells the window.
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
const lost = (n) => Array.from({ length: n }, () => "lost");
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
        // a file Windows holds through every retry of the read: the add writes nothing over the notes it could not read
        const before = st.list().length;
        const realRead = fs.readFileSync;
        let reads = 0;
        fs.readFileSync = (f, ...a) => { if (String(f).endsWith(cloudjobs.FILE)) { reads++; throw Object.assign(new Error("busy"), { code: "EBUSY" }); } return realRead(f, ...a); };
        try { st.add({ jobId: "blind" }); } finally { fs.readFileSync = realRead; }
        check("an add whose read of the notes fails (EBUSY after the retries) writes nothing: the other notes stay", reads >= 2 && st.list().length === before && !st.list().some((e) => e.jobId === "blind"), JSON.stringify({ reads, before, after: st.list().length }));
        fs.rmSync(dir, { recursive: true, force: true });
        const full = tmp();
        const pushed = [];
        const ps = cloudjobs.store(full, { pushedOut: (es) => pushed.push(...es.map((e) => e.jobId)) });
        ps.keep([{ jobId: "aged", started: Date.now() - 25 * HOUR }, ...Array.from({ length: 49 }, (_, i) => ({ jobId: "y" + i, started: Date.now() - HOUR }))]);
        ps.add({ jobId: "new1" });
        check("a full file takes the note older than a day out first, quietly (a read would drop it unread)", ps.list().length === 50 && !ps.list().some((e) => e.jobId === "aged") && pushed.length === 0, JSON.stringify(pushed));
        ps.add({ jobId: "new2" });
        check("past 50 young notes the oldest is pushed out, and the store names it", ps.list().length === 50 && !ps.list().some((e) => e.jobId === "y0") && pushed.join(",") === "y0", JSON.stringify(pushed));
        fs.rmSync(full, { recursive: true, force: true });
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
        // a Cancel whose stop Comfy did not confirm (the cancel answers 500 twice): the job may run on, its note stays
        const ak = new AbortController();
        const k = fakeComfyV2({ statuses: ["running"], cancelSays: "fail", events: [{ event: "progress", data: { value: 0.5, nodes_done: 1, nodes_total: 2 } }] });
        const kctx = { key: KEY, fetch: (u, i = {}) => (ak.signal.aborted ? Promise.reject(new Error("cancelled")) : k.fetch(u, i)), signal: ak.signal, sleep: async () => {}, log: () => {}, cloudApi: "v2", jobs, progress: (p) => { if (p.value === 0.5) setTimeout(() => ak.abort(), 20); } };
        globalThis.fetch = k.fetch;
        try { await thrown(() => cloud.edit(partnerReq(), kctx)); } finally { globalThis.fetch = saved; }
        check("a Cancel whose stop Comfy did not confirm: the note stays (the job may still run and be charged), the run says so to providers/index.js",
            jobs.list().map((e) => e.jobId).join(",") === "job-1" && kctx.noteKept === true && !kctx.cancelAsked && k.cancels.length === 2, short({ notes: jobs.list(), kept: kctx.noteKept, cancels: k.cancels.length }));
        jobs.keep([]);
        // a run whose picture landed but whose note's removal Windows refused through every retry: an ask leaves that
        // note alone (it never opens the picture twice) and takes it out again
        const realRename = fs.renameSync;
        let refusedRenames = 0;
        const held = fakeComfyV2({ origin: MOCK, statuses: ["running", "succeeded"], outputs: saveOutput, jobsById: { "job-1": { status: "succeeded", outputs: [{ node_id: "x", name: "twice.png" }] } } });
        jobs.keep([]);
        const hold2 = fakeComfyV2({ origin: MOCK, outputs: saveOutput, hold: (c) => { if (c.method === "GET" && /\/content$/.test(c.path)) fs.renameSync = (...a) => { refusedRenames++; throw Object.assign(new Error("busy"), { code: "EPERM" }); }; } });
        jobs.add({ jobId: "other-note", started: Date.now() - HOUR });
        try { await cloud.edit(partnerReq(), { key: TEST_KEY, base: MOCK, fetch: hold2.fetch, sleep: async () => {}, log: () => {}, cloudApi: "v2", jobs }); } finally { fs.renameSync = realRename; }
        const stuck = jobs.list().map((e) => e.jobId).sort().join(",");
        const rh = await cloud.recoverJobs(jobs, { key: TEST_KEY, base: MOCK, fetch: held.fetch, sleep: async () => {} }, Date.now(), { only: ["job-1"] });
        check("a landed run whose note's removal was refused: an ask does not read it or open its picture again, and takes the note out",
            refusedRenames >= 5 && stuck === "job-1,other-note" && rh.pictures.length === 0 && !held.calls.some((c) => c.path === "/api/v2/jobs/job-1") && jobs.list().map((e) => e.jobId).join(",") === "other-note",
            short({ refusedRenames, stuck, pictures: rh.pictures.length, left: jobs.list().map((e) => e.jobId) }));
        jobs.keep([]);
        const legacy = fakeComfyV2({ outputs: saveOutput });
        await thrown(() => cloud.edit(partnerReq(), { key: KEY, fetch: legacy.fetch, sleep: async () => {}, jobs }));
        check("the legacy API notes nothing", !fs.existsSync(fileIn(dir)));
        // a job that succeeded but whose picture did not come (the download dropped three times): paid, so its note stays
        const dl = fakeComfyV2({ contents: ["lost", "lost", "lost"], outputs: saveOutput });
        const edl = await thrown(() => cloud.edit(partnerReq(), { key: KEY, fetch: dl.fetch, sleep: async () => {}, log: () => {}, cloudApi: "v2", jobs }));
        check("a succeeded job whose download failed: its note stays, and the words say Scumble keeps the job and opens its picture",
            jobs.list().map((e) => e.jobId).join(",") === "job-1" && (edl || "").endsWith(" " + cloudjobs.KEPT), short({ notes: jobs.list(), e: edl }));
        jobs.keep([]);
        // a job whose status cannot be read any more (it may still run): its note stays too
        const unread = fakeComfyV2({ reads: lost(30), outputs: saveOutput });
        const eun = await thrown(() => cloud.edit(partnerReq(), { key: KEY, fetch: unread.fetch, sleep: async () => {}, log: () => {}, cloudApi: "v2", jobs }));
        check("a job whose status went unanswered: its note stays, no stop was asked, the words say so", jobs.list().length === 1 && unread.cancels.length === 0 && (eun || "").endsWith(cloudjobs.KEPT), short({ notes: jobs.list(), e: eun }));
        jobs.keep([]);
        // a job that succeeded but lists no output after the run's re-reads (Comfy lists it late): paid, so its note stays;
        // an ask that still finds none keeps it as unread, and the ask after Comfy lists it brings the picture
        const late = fakeComfyV2({ outputsAfter: 8, outputs: saveOutput });
        const elate = await thrown(() => cloud.edit(partnerReq(), { key: KEY, fetch: late.fetch, sleep: async () => {}, log: () => {}, cloudApi: "v2", jobs }));
        const ask1 = await cloud.recoverJobs(jobs, { key: KEY, fetch: late.fetch, sleep: async () => {} });
        const ask2 = await cloud.recoverJobs(jobs, { key: KEY, fetch: late.fetch, sleep: async () => {} });
        check("a succeeded job that lists no output yet: the run keeps its note and says so; an ask that still finds none keeps it as unread; the next one brings its picture",
            (elate || "").endsWith(" " + cloudjobs.KEPT) && ask1.unread === 1 && ask1.keptIds.join(",") === "job-1" && ask1.dropped === 0 && ask1.pictures.length === 0
            && ask2.pictures.length === 1 && tagOf(ask2.pictures[0].bytes) === "RESULT out.png" && jobs.list().map((e) => e.jobId).join(",") === "job-1",
            short({ e: elate, ask1: { ...ask1, pictures: ask1.pictures.length }, ask2: ask2.pictures.length }));
        jobs.keep([]);
        // a run in flight: an ask for the noted jobs meanwhile leaves its job to it (no read of it, not counted)
        let mid = null;
        const fl = fakeComfyV2({ origin: MOCK, statuses: ["running", "running", "succeeded"], outputs: saveOutput, hold: async (c) => {
            if (mid == null && c.method === "GET" && /^\/api\/v2\/jobs\/[^/]+$/.test(c.path)) {
                mid = "asking";
                jobs.add({ jobId: "earlier-one", started: Date.now() - HOUR });
                const own = () => fl.calls.filter((x) => x.path === "/api/v2/jobs/job-1").length;
                const n0 = own();
                mid = await cloud.recoverJobs(jobs, { key: TEST_KEY, base: MOCK, fetch: fl.fetch, sleep: async () => {} });
                mid.ownReads = own() - n0;
            }
        }, jobsById: { "earlier-one": { status: "running" } } });
        const ofl = await cloud.edit(partnerReq(), { key: TEST_KEY, base: MOCK, fetch: fl.fetch, sleep: async () => {}, log: () => {}, cloudApi: "v2", jobs });
        check("an ask while a run waits on its job: the run's job is left to it (not read, not counted), the earlier note is read; the run lands and takes its note out",
            mid && mid.keptIds.join(",") === "earlier-one" && mid.running === 1 && mid.ownReads === 0 && tagOf(ofl.bytes) === "RESULT out.png" && jobs.list().map((e) => e.jobId).join(",") === "earlier-one",
            short({ mid: mid && { kept: mid.keptIds, running: mid.running, ownReads: mid.ownReads }, notes: jobs.list().map((e) => e.jobId) }));
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
        check("still running and not answered (offline): kept, each counted as what it is; failed, expired, unknown (404) and the old one: dropped; a note added meanwhile stays",
            left === "done,new-run,offline,running" && r.kept === 2 && r.keptIds.sort().join(",") === "offline,running" && r.running === 1 && r.unanswered === 1 && r.unread === 0 && r.dropped === 4, short({ left, kept: r.kept, running: r.running, unanswered: r.unanswered, dropped: r.dropped }));
        // a job that lists its picture only on the next read; one whose picture is gone (404), one whose download got a
        // 503; reading only some notes
        jobs.keep([{ jobId: "gonebytes", saveId: "9", started: now - HOUR }, { jobId: "late", saveId: "9", started: now - HOUR }, { jobId: "slowbytes", saveId: "9", started: now - HOUR }, { jobId: "other", started: now - HOUR }]);
        const g2 = fakeComfyV2({ origin: MOCK, contents: [{ status: 404, code: "asset_not_found" }, null, { status: 503, code: "upstream_error" }], jobsById: {
            gonebytes: { status: "succeeded", outputs: [{ node_id: "9", name: "x.png" }] }, late: { status: "succeeded", outputsAfter: 1, outputs: [{ node_id: "9", name: "late.png" }] },
            slowbytes: { status: "succeeded", outputs: [{ node_id: "9", name: "s.png" }] }, other: { status: "running" } } });
        const r3 = await cloud.recoverJobs(jobs, { key: TEST_KEY, base: MOCK, fetch: g2.fetch, sleep: async () => {} }, now, ["gonebytes", "late", "slowbytes"]);
        check("only the named notes are read; a picture listed on the next read comes back; one Comfy says is gone (404) is dropped; one whose download got a 503 stays as unread",
            r3.pictures.length === 1 && r3.pictures[0].jobId === "late" && tagOf(r3.pictures[0].bytes) === "RESULT late.png" && r3.keptIds.join(",") === "slowbytes" && r3.unread === 1 && r3.dropped === 1
            && !jobs.list().some((e) => e.jobId === "gonebytes") && !g2.calls.some((c) => c.path.endsWith("/jobs/other")),
            short({ pictures: r3.pictures.map((p) => p.jobId), kept: r3.keptIds, unread: r3.unread, dropped: r3.dropped, calls: g2.calls.map((c) => c.path) }));
        // refusals and silence are asked again later; a re-read of a finished job that gets no answer is too; skip
        jobs.keep(["k401", "k403", "k429", "k503", "noout", "given"].map((jobId) => ({ jobId, saveId: "9", started: now - HOUR })));
        const g3 = fakeComfyV2({ origin: MOCK, jobsById: { k401: 401, k403: 403, k429: 429, k503: 503,
            noout: { status: "succeeded", outputsAfter: 5, readsSay: [null, "lost"], outputs: [{ node_id: "9", name: "n.png" }] }, given: { status: "succeeded", outputs: [{ node_id: "9", name: "g.png" }] } } });
        const r4 = await cloud.recoverJobs(jobs, { key: TEST_KEY, base: MOCK, fetch: g3.fetch, sleep: async () => {} }, now, { skip: ["given"] });
        check("a 401, 403, 429 or 503 on the job and a finished job whose re-read got no answer: all kept as unanswered; a picture the window has (skip) is not read",
            r4.unanswered === 5 && r4.kept === 5 && r4.running === 0 && r4.dropped === 0 && r4.pictures.length === 0 && !g3.calls.some((c) => c.path.endsWith("/jobs/given")) && jobs.list().length === 6,
            short({ kept: r4.keptIds, unanswered: r4.unanswered, dropped: r4.dropped, calls: g3.calls.map((c) => c.path) }));
        // a finished job that lists no output after the re-reads waits as unread (Comfy may list it late); one that lists
        // outputs but no image never gets one
        jobs.keep(["unlisted", "textonly"].map((jobId) => ({ jobId, saveId: "9", started: now - HOUR })));
        const g4 = fakeComfyV2({ origin: MOCK, jobsById: { unlisted: { status: "succeeded", outputsAfter: 8, outputs: [{ node_id: "9", name: "u.png" }] },
            textonly: { status: "succeeded", outputs: [{ node_id: "9", name: "t.txt", type: "text", content_type: "text/plain" }] } } });
        const r5 = await cloud.recoverJobs(jobs, { key: TEST_KEY, base: MOCK, fetch: g4.fetch, sleep: async () => {} }, now);
        check("a finished job that lists no output yet: kept as unread after its re-reads; one that lists outputs but no image: dropped",
            r5.unread === 1 && r5.kept === 1 && r5.keptIds.join(",") === "unlisted" && r5.dropped === 1 && r5.pictures.length === 0 && jobs.list().map((e) => e.jobId).join(",") === "unlisted"
            && g4.calls.filter((c) => c.path.endsWith("/jobs/unlisted")).length === 3,
            short({ kept: r5.keptIds, unread: r5.unread, dropped: r5.dropped, left: jobs.list().map((e) => e.jobId) }));
        check("a note older than a day is dropped unread, and nothing is ever submitted again",
            !f.calls.some((c) => c.path.includes("/jobs/old")) && !f.calls.some((c) => c.method === "POST"), short(f.calls.map((c) => `${c.method} ${c.path}`)));
        const g = fakeComfyV2({ origin: MOCK });
        jobs.keep([{ jobId: "a", started: now - HOUR }, { jobId: "b", started: now - 30 * HOUR }]);
        const r2 = await cloud.recoverJobs(jobs, { key: "", base: MOCK, fetch: g.fetch });
        check("without a key nothing is asked: the fresh note waits (unanswered), the old one goes", r2.skipped === "no key" && g.calls.length === 0 && r2.unanswered === 1 && r2.kept === 1 && jobs.list().map((e) => e.jobId).join(",") === "a", short(r2));
        const h = fakeComfyV2({ origin: MOCK });
        const e3 = await thrown(() => cloud.recoverJobs(jobs, { key: KEY, base: MOCK, fetch: h.fetch }));
        check("a real key for a test base: refused before any request, the note kept", /only a test key/.test(e3 || "") && h.calls.length === 0 && jobs.list().length === 1, e3);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // 4. through providers/index.js: the data folder, the key and the test base from the app's own modules
    {
        const dir = tmp();
        cloudjobs.store(dir).keep([{ jobId: "done", model: "Z-Image Turbo", recipe: "cloud_z_image_turbo", saveId: "9", started: Date.now() - HOUR }, { jobId: "running", started: Date.now() - HOUR }]);
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
        check("index.recoverCloudJobs: the picture as bytes for the window, the model, the recipe, the start, earlier (noted before this process); both notes stay until the window acks the picture, then only the running one; a line in the log",
            r.pictures.length === 1 && p0.bytes instanceof Uint8Array && tagOf(Buffer.from(p0.bytes)) === "RESULT z.png" && p0.model === "Z-Image Turbo" && p0.recipe === "cloud_z_image_turbo" && p0.earlier === true && r.running === 1 && r.kept === 1
            && before === "done,running" && cloudjobs.store(dir).list().map((e) => e.jobId).join(",") === "running" && logged.some((l) => /1 noted result brought back, 1 still noted \(1 running/.test(l.message || "")),
            short({ n: r.pictures.length, p0: { ...p0, bytes: undefined }, before, left: cloudjobs.store(dir).list(), log: logged.map((l) => l.message) }));
        cloudjobs.store(dir).keep([]);

        // a run made the app's way (index.edit, contextFor's store in the data folder) notes its job while it waits
        const runFake = (extra = {}) => fakeComfyV2({ origin: MOCK, outputs: saveOutput, ...extra });
        const viaIndex = async (fake, hooks, runId) => {
            globalThis.fetch = fake.fetch;
            try { return { out: await index.edit({ ...partnerReq(), runId }, hooks), err: null }; } catch (e) { return { out: null, err: String((e && e.message) || e) }; } finally { globalThis.fetch = saved; }
        };
        let noted = null;
        const a1 = runFake({ statuses: ["running", "succeeded"], hold: (c) => { if (noted == null && c.method === "GET" && /^\/api\/v2\/jobs\/[^/]+$/.test(c.path)) noted = cloudjobs.store(dir).list().map((e) => e.jobId).join(","); } });
        const changed = [];
        const ra = await viaIndex(a1, { cloudJobsChanged: () => changed.push("a1"), pageGone: () => false }, "cj-1");
        check("a Comfy Cloud run through index.edit notes its job in the data folder while it waits, and takes the note out with its picture (the page that asked is there)",
            !ra.err && noted === "job-1" && cloudjobs.store(dir).list().length === 0 && changed.length === 0, short({ err: ra.err, noted, left: cloudjobs.store(dir).list(), changed }));
        // the page that asked went away during the run (a reload, a crash): the note goes back and the window hears it
        const a2 = runFake({ statuses: ["running", "succeeded"] });
        const rb = await viaIndex(a2, { cloudJobsChanged: () => changed.push("a2"), pageGone: () => true }, "cj-2");
        const back = cloudjobs.store(dir).list();
        check("a run whose page went away before its picture came: the job's note goes back, the window is told, a line in the log",
            !rb.err && back.length === 1 && back[0].jobId === "job-1" && back[0].model === "gpt-image-2" && changed.join(",") === "a2" && logged.some((l) => /went away before its picture came/.test(l.message || "")), short({ back, changed }));
        const a2b = fakeComfyV2({ origin: MOCK, jobsById: { "job-1": { status: "succeeded", outputs: [{ node_id: back[0] && back[0].saveId, name: "again.png" }] } } });
        globalThis.fetch = a2b.fetch;
        let rr;
        try { rr = await index.recoverCloudJobs(); } finally { globalThis.fetch = saved; }
        check("the new page's ask brings that picture, as one of this process (earlier false)", rr.pictures.length === 1 && rr.pictures[0].jobId === "job-1" && rr.pictures[0].earlier === false && tagOf(Buffer.from(rr.pictures[0].bytes)) === "RESULT again.png", short({ n: rr.pictures.length, earlier: rr.pictures[0] && rr.pictures[0].earlier }));
        const rs = await index.recoverCloudJobs({ skip: ["job-1"] });
        check("an ask that skips the pictures the page was given reads nothing of them", rs.pictures.length === 0 && rs.kept === 0, short({ ...rs, pictures: rs.pictures.length }));
        index.ackCloudJob("job-1");
        // a run that keeps its job's note (its download failed): the words say so and the window hears it
        const a3 = runFake({ contents: lost(3) });
        const rc = await viaIndex(a3, { cloudJobsChanged: () => changed.push("a3"), pageGone: () => false }, "cj-3");
        check("a run that keeps its note (the download failed): its words end with the keep sentence, the window is told, the note stays",
            (rc.err || "").endsWith(cloudjobs.KEPT) && changed.join(",") === "a2,a3" && cloudjobs.store(dir).list().map((e) => e.jobId).join(",") === "job-1", short({ err: rc.err, changed }));
        // a Cancel whose stop Comfy did not confirm: the may-still-finish words end with the keep sentence, the note stays
        cloudjobs.store(dir).keep([]);
        const a4 = runFake({ statuses: ["running"], cancelSays: "fail", hold: (c) => { if (c.method === "GET" && /^\/api\/v2\/jobs\/[^/]+$/.test(c.path)) index.cancel("cj-4"); } });
        const rd = await viaIndex(a4, { cloudJobsChanged: () => changed.push("a4"), pageGone: () => false }, "cj-4");
        check("a Cancel whose stop is not confirmed: the words say the job may still finish and end with the keep sentence, the note stays, the window is told",
            /^Cancelled after \d+\.\d s: Scumble stopped waiting for Comfy Cloud, which may still finish the job and charge it\. /.test(rd.err || "") && (rd.err || "").endsWith(cloudjobs.KEPT) && cloudjobs.store(dir).list().length === 1 && changed.join(",") === "a2,a3,a4",
            short({ err: rd.err, notes: cloudjobs.store(dir).list().length, changed }));
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
        check("no notes: nothing asked, nothing logged; the answer carries every count", r2.pictures.length === 0 && g.calls.length === 0 && r2.running === 0 && r2.unanswered === 0 && r2.unread === 0 && r2.kept === 0);
        fs.rmSync(empty, { recursive: true, force: true });
    }

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + ((err && err.stack) || err)); console.log("FAIL"); process.exit(1); });
