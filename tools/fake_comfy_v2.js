// A fake Comfy API v2 (cloud.comfy.org/api/v2, docs/PLAN_COMFY_SDK.md S1 and section 10) as a fetch function, for the
// plain-Node tests of the Comfy Cloud adapter on Comfy's SDK (tools/comfycloud_v2_test.js). No network, no key.
//
// It answers what the SDK sends: HEAD /assets/by-hash/<h> (200 for bytes it holds, else 404), POST /assets/from-hash,
// POST /assets (multipart: content_type, file_path, expected_hash, then the file), POST /jobs (201 with the job and its
// urls; a key it has seen is refused 422 idempotency_key_reuse), GET /jobs/<id> (the statuses of `statuses` in turn, the
// last repeated), POST /jobs/<id>/cancel, GET /assets/<id>/content (a 302 to a signed storage URL the fake follows itself
// when the request follows redirects, dropping Authorization across origins as fetch does), and the v1 node list
// GET /api/object_info (X-API-Key). Every call is recorded with its auth, and every job body is kept.
"use strict";

const ORIGIN = "https://cloud.comfy.org";
const STORAGE = "https://storage.example";

const png = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
const tagOf = (b) => Buffer.from(b).slice(8).toString("latin1");
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const fail = (status, code, message, details, retryAfter) => json(status, { error: { code, message, ...(details ? { details } : {}) } }, retryAfter != null ? { "retry-after": String(retryAfter) } : {});

/**
 * @param {object} o
 * @param {string} [o.origin] where the fake answers (a test base: http://127.0.0.1:<port>)
 * @param {string[]} [o.classes] the node list's classes, or `info` the node list itself; `infoFails` answers it 500
 * @param {string[]} [o.statuses] what successive job reads say (default: succeeded at once)
 * @param {(workflow: object) => object[]} [o.outputs] a finished job's outputs: { node_id, name, type?, content_type? }
 * @param {object} [o.error] job.error of a failed job
 * @param {Array<string|object>} [o.submits] per POST /jobs in turn: "ok", "lostAfter" (taken, then the connection
 *   drops), "lostBefore" (drops before it is taken), or { status, code, message, details, noted } (a refusal notes the
 *   key unless `noted` is false)
 * @param {object} [o.uploadFails] { status, code, message } for every POST /assets
 * @param {Array<string|object>} [o.uploadsSay] per POST /assets in turn: "ok", or { status, code, message } after
 *   the fake has noted the request's Idempotency-Key (a reused upload key is refused 422 idempotency_key_reuse)
 * @param {Set<string>} [o.known] the hashes the fake holds already (shared between fakes to model an account)
 * @param {Array<string|object|null>} [o.reads] per GET /jobs/<id> in turn: null to answer, "lost" to drop the
 *   connection, { status, code, message, retryAfter } to refuse it
 * @param {Array<string|object|null>} [o.contents] per GET /assets/<id>/content in turn, the same forms as `reads`
 * @param {string} [o.cancelSays] "succeeded" (the job ended meanwhile), "fail" (the cancel answers 500)
 * @param {Array<{event: string, data: object}>|function} [o.events] the job's live events (SSE), served on GET
 *   .../events (without them that route answers 404, as a surface with no live events does); a function of the
 *   connection's number answers { frames, drop } per connection, `drop` ending the stream with an error, after which
 *   the next job read fails once (the SDK reads the status right after a drop)
 * @param {(call: object) => Promise|undefined} [o.hold] awaited before a call is answered (a test cancels meanwhile)
 * @param {Object<string, object|string|number>} [o.jobsById] jobs of an earlier run, read by id (S6): { status, outputs },
 *   "lost" (the connection drops) or 404
 * @param {number} [o.outputsAfter] how many reads of the finished job list no outputs yet
 */
function fakeComfyV2(o = {}) {
    const origin = o.origin || ORIGIN;
    const s = {
        origin, calls: [], jobs: [], keys: [], uploads: [], uploadKeys: [], fromHash: [], heads: [], cancels: [], storage: [], contents: [], infoReads: 0,
        known: o.known || new Set(), assets: new Map(),
    };
    let n = 0, submitN = 0, readN = 0, uploadN = 0, contentN = 0, doneReads = 0, failRead = false;
    const job = { id: null, status: "queued", outputs: [], error: null, reads: 0 };
    const statuses = o.statuses && o.statuses.length ? o.statuses : ["succeeded"];
    /** A scripted answer: null goes on, "lost" drops the connection, an object refuses (with Retry-After when given). */
    const scripted = (say) => {
        if (say === "lost") throw new TypeError("fetch failed");
        if (say && typeof say === "object") return fail(say.status, say.code, say.message || say.code, null, say.retryAfter);
        return null;
    };
    const bodyOf = () => {
        const failed = job.status === "failed";
        const listed = job.status === "succeeded" && doneReads++ >= (o.outputsAfter || 0);
        return {
            id: job.id, status: job.status, created_at: "2026-10-18T10:00:00Z", started_at: job.status === "queued" ? null : "2026-10-18T10:00:01Z",
            completed_at: ["succeeded", "failed", "canceled", "expired"].includes(job.status) ? "2026-10-18T10:00:09Z" : null,
            expires_at: "2026-10-25T10:00:00Z", queue_position: null, progress: null,
            outputs: listed ? job.outputs : [], error: failed ? (o.error || null) : null,
            urls: { self: `/api/v2/jobs/${job.id}`, events: `/api/v2/jobs/${job.id}/events`, cancel: `/api/v2/jobs/${job.id}/cancel` },
        };
    };
    const asset = (id, a, createdNew) => ({
        id, hash: a.hash, size_bytes: a.bytes.length, content_type: a.contentType, file_path: a.filePath, created_new: createdNew,
        created_at: "2026-10-18T10:00:00Z", url: `${STORAGE}/${id}`, url_expires_at: "2026-10-18T11:00:00Z",
    });
    s.fetch = async function fetch(input, init = {}) {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input.url);
        const u = new URL(url);
        const method = String(init.method || "GET").toUpperCase();
        const h = new Headers(init.headers);
        const call = { method, url, path: u.pathname, origin: u.origin, auth: h.get("authorization"), apiKey: h.get("x-api-key"), idem: h.get("idempotency-key"), ua: h.get("user-agent"), redirect: init.redirect || "follow" };
        s.calls.push(call);
        if (o.hold) await o.hold(call);
        if (init.signal && init.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        if (u.origin === STORAGE) {
            s.storage.push(call);
            const a = s.assets.get(u.pathname.slice(1));
            return a ? new Response(a.bytes, { status: 200, headers: { "content-type": a.contentType } }) : json(404, {});
        }
        if (u.origin !== origin) return json(404, { error: { code: "not_found", message: "no such origin in the fake: " + u.origin } });
        const p = u.pathname;
        if (p === "/api/object_info") {
            s.infoReads++;
            if (o.infoFails) return fail(500, "internal", "node list broke");
            return json(200, o.info || Object.fromEntries((o.classes || []).map((c) => [c, {}])));
        }
        let m;
        if (method === "HEAD" && (m = /^\/api\/v2\/assets\/by-hash\/(.+)$/.exec(p))) {
            const hash = decodeURIComponent(m[1]);
            s.heads.push(hash);
            return new Response(null, { status: s.known.has(hash) ? 200 : 404 });
        }
        if (method === "POST" && p === "/api/v2/assets/from-hash") {
            const b = JSON.parse(init.body);
            s.fromHash.push(b);
            const held = [...s.assets.values()].find((a) => a.hash === b.hash) || (s.known.has(b.hash) ? { hash: b.hash, bytes: Buffer.alloc(0), contentType: "image/png" } : null);
            if (!held) return fail(404, "blob_not_found", "no such blob");
            const id = `asset-${++n}`;
            s.assets.set(id, { ...held, filePath: b.file_path });
            return json(201, asset(id, s.assets.get(id), false));
        }
        if (method === "POST" && p === "/api/v2/assets") {
            if (o.uploadFails) return fail(o.uploadFails.status, o.uploadFails.code, o.uploadFails.message);
            if (call.idem && s.uploadKeys.includes(call.idem)) return fail(422, "idempotency_key_reuse", "this upload's Idempotency-Key was already used");
            if (call.idem) s.uploadKeys.push(call.idem);
            const say = (o.uploadsSay || [])[uploadN++];
            if (say && typeof say === "object") return fail(say.status, say.code, say.message || say.code);
            const form = init.body;
            const file = form.get("file");
            const bytes = Buffer.from(await file.arrayBuffer());
            const a = { hash: String(form.get("expected_hash")), bytes, contentType: String(form.get("content_type")), filePath: String(form.get("file_path")) };
            const id = `asset-${++n}`;
            s.assets.set(id, a);
            s.known.add(a.hash);
            s.uploads.push({ id, tag: tagOf(bytes), filePath: a.filePath, contentType: a.contentType, hash: a.hash, fields: [...form.keys()] });
            return json(201, asset(id, a, true));
        }
        if (method === "POST" && p === "/api/v2/jobs") {
            const behave = (o.submits || [])[submitN++] || "ok";
            if (behave === "lostBefore") throw new TypeError("fetch failed");
            const key = call.idem;
            if (key && s.keys.includes(key)) return fail(422, "idempotency_key_reuse", "this Idempotency-Key was already used");
            // a refusal notes the key unless it says it never reached the server (`noted: false`, a gateway's 503)
            if (typeof behave === "object") { if (behave.noted !== false) s.keys.push(key); return fail(behave.status, behave.code, behave.message, behave.details); }
            const body = JSON.parse(init.body);
            s.keys.push(key);
            s.jobs.push(body);
            job.id = `job-${s.jobs.length}`;
            job.status = "queued";
            job.reads = 0;
            doneReads = 0;
            job.outputs = (o.outputs ? o.outputs(body.workflow) : []).map((x, i) => {
                const id = `out-${s.jobs.length}-${i}`;
                const ct = x.content_type || "image/png";
                s.assets.set(id, { hash: null, bytes: png("RESULT " + x.name), contentType: ct, filePath: x.name });
                return { node_id: String(x.node_id), name: x.name, type: x.type || "image", content_type: ct, size_bytes: 9, id, hash: null, url: `${STORAGE}/${id}`, url_expires_at: "2026-10-18T11:00:00Z", job_id: job.id };
            });
            if (behave === "lostAfter") throw new TypeError("fetch failed");
            return json(201, bodyOf());
        }
        if ((m = /^\/api\/v2\/jobs\/([^/]+)\/events$/.exec(p)) && method === "GET" && o.events) {
            s.eventReads = (s.eventReads || 0) + 1;
            const said = typeof o.events === "function" ? o.events(s.eventReads) : { frames: o.events };
            const text = (said.frames || []).map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
            if (!said.drop) return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
            // the frames, then the connection drops
            const body = new ReadableStream({
                start(c) {
                    c.enqueue(new TextEncoder().encode(text));
                    setTimeout(() => { failRead = true; c.error(new TypeError("terminated")); }, 20);
                },
            });
            return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        if ((m = /^\/api\/v2\/jobs\/([^/]+)\/cancel$/.exec(p)) && method === "POST") {
            s.cancels.push(call);
            if (o.cancelSays === "fail") return fail(500, "upstream_error", "cancel broke");
            if (o.cancelSays === "succeeded") job.status = "succeeded";
            else if (!["succeeded", "failed", "canceled", "expired"].includes(job.status)) job.status = "canceling";
            return json(200, bodyOf());
        }
        if ((m = /^\/api\/v2\/jobs\/([^/]+)$/.exec(p)) && method === "GET" && o.jobsById && Object.prototype.hasOwnProperty.call(o.jobsById, decodeURIComponent(m[1]))) {
            // jobs of an earlier run, read by their id (S6): "lost" drops the connection, 404 is unknown, else { status, outputs }
            const id = decodeURIComponent(m[1]);
            const spec = o.jobsById[id];
            if (spec === "lost") throw new TypeError("fetch failed");
            if (spec === 404) return fail(404, "job_not_found", "no such job");
            s.idReads = s.idReads || {};
            s.idReads[id] = (s.idReads[id] || 0) + 1;
            const listed = s.idReads[id] > (spec.outputsAfter || 0);
            const outs = (spec.outputs || []).map((x, i) => {
                const aid = `rec-${id}-${i}`;
                s.assets.set(aid, { hash: null, bytes: png("RESULT " + x.name), contentType: x.content_type || "image/png", filePath: x.name });
                return { node_id: String(x.node_id), name: x.name, type: x.type || "image", content_type: x.content_type || "image/png", size_bytes: 9, id: aid, hash: null, url: `${STORAGE}/${aid}`, url_expires_at: "2026-10-18T11:00:00Z", job_id: id };
            });
            return json(200, {
                id, status: spec.status, created_at: "2026-10-18T10:00:00Z", started_at: null, completed_at: null, expires_at: "2026-10-25T10:00:00Z",
                queue_position: null, progress: null, outputs: spec.status === "succeeded" && listed ? outs : [], error: spec.status === "failed" ? { code: "execution_error", message: "boom" } : null,
                urls: { self: `/api/v2/jobs/${id}`, events: `/api/v2/jobs/${id}/events`, cancel: `/api/v2/jobs/${id}/cancel` },
            });
        }
        if ((m = /^\/api\/v2\/jobs\/([^/]+)$/.exec(p)) && method === "GET") {
            if (m[1] !== job.id) return fail(404, "job_not_found", "no such job");
            if (failRead) { failRead = false; throw new TypeError("fetch failed"); }
            const refused = scripted((o.reads || [])[readN++]);
            if (refused) return refused;
            if (job.status !== "canceling" && !(o.cancelSays === "succeeded" && s.cancels.length)) job.status = statuses[Math.min(job.reads, statuses.length - 1)];
            job.reads++;
            return json(200, bodyOf());
        }
        if ((m = /^\/api\/v2\/assets\/([^/]+)\/content$/.exec(p)) && method === "GET") {
            s.contents.push(call);
            const refused = scripted((o.contents || [])[contentN++]);
            if (refused) return refused;
            const id = decodeURIComponent(m[1]);
            if (!s.assets.has(id)) return fail(404, "asset_not_found", "no such asset");
            const loc = `${STORAGE}/${id}`;
            if (init.redirect === "manual") return new Response(null, { status: 302, headers: { location: loc } });
            // fetch follows the redirect itself and drops Authorization across origins
            const headers = new Headers(init.headers);
            headers.delete("authorization");
            return fetch(loc, { ...init, headers });
        }
        return fail(404, "not_found", `no route ${method} ${p} in the fake`);
    };
    return s;
}

module.exports = { fakeComfyV2, png, tagOf, ORIGIN, STORAGE };
