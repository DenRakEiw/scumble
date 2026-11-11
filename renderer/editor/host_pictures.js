// @ts-check
// ComfyUI picture runs and the Realism Pass: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import * as realism from "./realism.js";
import { bytesToImage, canvasBytes } from "./stitch.js";
import { failKind, refusal } from "./inpaint_status.js";
import { api, mosaicPixels, objectId } from "./host_util.js";

export const HostPicturesPart = {
    // prompt id -> { editor, output, label, answer(image), ended(), fail(kind, message, extra) } of each picture run
    _pictureRuns: new Map(),
    // the ids of picture runs that ended (answered, failed, cancelled, lost): their late events are swallowed, so a pass
    // error of a run Scumble gave up on never lands in a tab's status (the newest 64)
    _endedPictureRuns: new Set(),

    /**
     * Run an API-format prompt that answers one picture and wait for it: `output` is the node whose first image is the
     * answer. Queued at the front (`front`), as the helpers are; never interrupts a running job of the user's. The id
     * counts as an open render of `editor` (a turn of the picture and Generate new wait for it). The wait ends on the
     * node's `executed`, on `execution_success` (the answer read from /history), on an error or interrupt, on the
     * timeout and on `token.cancelled` (both take the job off the server, cancelComfyPrompt, before the call rejects),
     * and when the server is disconnected or another server is connected ("connecting", a re-Connect, is a pause). The
     * timeout counts the time the job is not waiting in the queue: a wait behind the user's jobs, shown with its position
     * from /queue every 2 s, does not use it up. A job that is neither queued nor running twice in a row is read from
     * /history (the socket missed its events), or ends as "dropped". `deadline` (a time in ms, 0 for none) is a hard end
     * that counts the queue's wait too: a command's own timeout (realism_pass, R3b), so an agent's call answers before its
     * bridge gives up. Rejects with an Error whose `kind` is "error" (the server's message, `nodeType`), "interrupted", "timeout",
     * "cancelled", "lost" or "dropped".
     * -> { bytes, mime, seconds, promptId }
     */
    async comfyPictureRun(editor, prompt, output, { label = "ComfyUI", token = null, timeoutMs = 300000, front = true, deadline = 0 } = {}) {
        const stop = (kind, message, extra) => Object.assign(new Error(message), { kind }, extra || {});
        if (token && token.cancelled) throw stop("cancelled", `${label} cancelled.`);
        const t0 = Date.now();
        const url0 = (this.server && this.server.url) || "";
        let queued;
        try {
            queued = await api.queuePrompt(front ? -1 : 0, { output: prompt, workflow: { nodes: [], links: [], version: 0.4, extra: { inpaint_canvas_helper: true } } });
        } catch (err) {
            throw stop("error", String((err && err.message) || err));
        }
        const id = queued && queued.prompt_id;
        if (!id) throw stop("error", `${label}: your ComfyUI gave the job no id.`);
        const runs = editor ? (editor._localRuns || (editor._localRuns = new Set())) : null;
        if (runs) runs.add(id);
        // the token's own prompt: the bar shows its steps under the token's label (RunProgress.state)
        if (token) { token.promptId = String(id); this.syncRunBars(); }
        if (editor) this.trackRun(editor, id, this.runNodeCount(prompt));
        let entry = null;
        const interrupted = `${label} was interrupted on your ComfyUI.`;
        // what /history says about a job that ended without an `executed` for `output`
        const fromHistory = (got) => {
            if (got.image) entry.answer(got.image);
            else if (got.interrupted) entry.fail("interrupted", interrupted);
            else if (got.error) entry.fail("error", got.error.message, { nodeType: got.error.nodeType });
            else if (got.found) entry.fail("error", `${label}: your ComfyUI finished without a picture.`);
            else return false;
            return true;
        };
        const wait = new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
            entry = {
                editor, output, label, interrupted,
                get settled() { return settled; },
                answer: (image) => settle(resolve, image),
                fail: (kind, message, extra) => settle(reject, stop(kind, message, extra)),
                // the prompt ended: its answer from /history, when no `executed` brought it (another server may not
                // re-send one for a cached output)
                ended: async () => {
                    if (settled) return;
                    try {
                        if (!fromHistory(await this.pictureFromHistory(id, output))) entry.fail("error", `${label}: your ComfyUI finished without a picture.`);
                    } catch (err) {
                        entry.fail("error", `${label}: the answer could not be read from your ComfyUI (${String((err && err.message) || err)}).`);
                    }
                },
            };
        });
        this._pictureRuns.set(id, entry);
        // the timeout's clock: reset whenever /queue shows the job still pending
        let clock = t0, lastQueue = t0, polling = false, gone = 0, shown = "", cleanup = null, timer = null;
        // a cancel or the timeout ends the wait at once; the job goes off the server meanwhile, awaited before the call
        // rejects (at most 5 s), so a stalled request never holds the Cancel
        const giveUp = (kind, message) => {
            cleanup = this.cancelComfyPrompt(id).catch((err) => console.warn("picture run cancel", err));
            entry.fail(kind, message);
        };
        const poll = async () => {
            // the position; no answer (no server under --no-comfy) shows none and does not end the wait
            const q = await this.queuePosition(id);
            if (!q || entry.settled) return;
            if (q.running || q.pending) {
                gone = 0;
                if (q.pending) clock = Date.now();
                const text = q.running ? `${label} runs on your ComfyUI ...` : `${label} waits for your ComfyUI (${q.ahead} job${q.ahead === 1 ? "" : "s"} ahead) ...`;
                if (text !== shown && editor && editor.setStatus) { shown = text; editor.setStatus(text); }
                return;
            }
            if (++gone < 2) return;
            // neither queued nor running twice: it ended while the socket was away, or someone cleared the queue; a
            // /history that does not answer is asked again at the next poll
            let got;
            try { got = await this.pictureFromHistory(id, output); } catch (_) { gone = 1; return; }
            if (!entry.settled && !fromHistory(got)) entry.fail("dropped", `${label}: your ComfyUI no longer holds its job (was the queue cleared?).`);
        };
        const tick = () => {
            if (entry.settled) return;
            const s = this.server || { state: "", url: "" };
            if (s.state === "disconnected" || s.state === "error" || (url0 && s.url && s.url !== url0)) {
                // the job stays on that server; taken off in the background in case it is still reachable
                this.cancelComfyPrompt(id).catch(() => { /* unreachable */ });
                entry.fail("lost", `${label}: the connection to your ComfyUI was lost.`);
                return;
            }
            if (token && token.cancelled) { giveUp("cancelled", `${label} cancelled.`); return; }
            if (Date.now() - clock > timeoutMs) { giveUp("timeout", `${label}: no answer from your ComfyUI within ${Math.round(timeoutMs / 1000)} s; its job was taken off the queue.`); return; }
            if (deadline && Date.now() > deadline) { giveUp("timeout", `${label}: no answer from your ComfyUI within ${Math.round((Date.now() - t0) / 1000)} s; its job was taken off the queue.`); return; }
            if (polling || Date.now() - lastQueue < 2000) return;
            lastQueue = Date.now();
            polling = true;
            poll().catch((err) => console.warn("picture run", err)).finally(() => { polling = false; });
        };
        try {
            timer = setInterval(tick, 250);
            const image = await wait;
            const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" });
            const r = await api.fetchApi("/view?" + q.toString(), { signal: AbortSignal.timeout(Math.max(60000, timeoutMs)) });
            if (r.status !== 200) throw stop("error", `${label}: the answer could not be fetched from your ComfyUI (${r.status}).`);
            const bytes = new Uint8Array(await r.arrayBuffer());
            const mime = (r.headers.get("Content-Type") || "image/png").split(";")[0].trim() || "image/png";
            return { bytes, mime, seconds: (Date.now() - t0) / 1000, promptId: id };
        } finally {
            clearInterval(timer);
            this._pictureRuns.delete(id);
            this._endedPictureRuns.add(id);
            for (const old of this._endedPictureRuns) { if (this._endedPictureRuns.size <= 64) break; this._endedPictureRuns.delete(old); }
            if (runs) runs.delete(id);
            // the bar waits no more either: a cancelled or dropped job gets no end event from ComfyUI
            if (editor && editor.runProgress) editor.runProgress.done(id);
            if (cleanup) await Promise.race([cleanup, new Promise((r) => setTimeout(r, 5000))]);
        }
    },

    /**
     * A server event for a picture run (the listeners below): true when `detail` belongs to one, which then answers, or
     * to one that ended (its late events go nowhere).
     */
    pictureRunEvent(type, detail) {
        const id = detail && detail.prompt_id;
        const e = id ? this._pictureRuns.get(id) : null;
        if (!e) return !!id && this._endedPictureRuns.has(id);
        if (type === "executed") {
            const images = detail.output && detail.output.images;
            if ((detail.node === e.output || detail.display_node === e.output) && Array.isArray(images) && images[0]) e.answer(images[0]);
        } else if (type === "success") e.ended();
        else if (type === "error") e.fail("error", detail.exception_message || "execution failed", { nodeType: detail.node_type || "" });
        else if (type === "interrupted") e.fail("interrupted", e.interrupted);
        return true;
    },

    /**
     * Where prompt `id` stands in ComfyUI's /queue: { running, pending, ahead }, or null when /queue gave no answer.
     * The pending list is the server's heap, not sorted: the jobs ahead are those with a smaller number.
     */
    async queuePosition(id) {
        let q;
        try {
            const r = await api.fetchApi("/queue", { signal: AbortSignal.timeout(15000) });
            if (r.status !== 200) return null;
            q = await r.json();
        } catch (_) { return null; }
        const running = Array.isArray(q && q.queue_running) ? q.queue_running : [];
        const pending = Array.isArray(q && q.queue_pending) ? q.queue_pending : [];
        if (running.some((it) => Array.isArray(it) && it[1] === id)) return { running: true, pending: false, ahead: 0 };
        const mine = pending.find((it) => Array.isArray(it) && it[1] === id);
        if (!mine) return { running: false, pending: false, ahead: 0 };
        const ahead = running.length + pending.filter((it) => Array.isArray(it) && it[1] !== id && +it[0] < +mine[0]).length;
        return { running: false, pending: true, ahead };
    },

    /**
     * Prompt `id` in /history: { found, image } (the first image of `output`), { found, interrupted }, or
     * { found, error: { message, nodeType } }; throws when /history does not answer.
     * @returns {Promise<{ found: boolean, image?: any, interrupted?: boolean, error?: { message: string, nodeType: string } | null }>}
     */
    async pictureFromHistory(id, output) {
        const r = await api.fetchApi("/history/" + encodeURIComponent(id), { signal: AbortSignal.timeout(15000) });
        if (r.status !== 200) throw new Error("/history answered " + r.status);
        const all = await r.json();
        const h = all && all[id];
        if (!h) return { found: false };
        const images = h.outputs && h.outputs[output] && h.outputs[output].images;
        if (Array.isArray(images) && images[0]) return { found: true, image: images[0] };
        const msgs = (h.status && h.status.messages) || [];
        const err = msgs.find((m) => Array.isArray(m) && m[0] === "execution_error");
        if (err) return { found: true, error: { message: (err[1] && err[1].exception_message) || "execution failed", nodeType: (err[1] && err[1].node_type) || "" } };
        if (msgs.some((m) => Array.isArray(m) && m[0] === "execution_interrupted")) return { found: true, interrupted: true };
        return { found: true };
    },

    /**
     * Take Scumble's own prompt `id` off ComfyUI, never another job. A current server cancels it by id in one step
     * (POST /api/jobs/<id>/cancel: dequeued if pending, interrupted only while it is the running one, atomically). An
     * older one: deleted from the queue, then interrupted by its id only when /queue shows it running and the server is
     * 0.3.57 or later (before that /interrupt ignored the id and stopped whatever ran; the short job then finishes on its
     * own). Never a bare /interrupt. -> whether a running job was interrupted (or the server cancelled it)
     */
    async cancelComfyPrompt(id) {
        if (!id) return false;
        const post = (path, body) => api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        try {
            const r = await post("/api/jobs/" + encodeURIComponent(id) + "/cancel", {});
            if (r.status === 200) {
                let d = null;
                try { d = await r.json(); } catch (_) { d = null; }
                return !!(d && d.cancelled);
            }
            if (r.status !== 404 && r.status !== 405) console.warn("job cancel answered", r.status);
        } catch (err) { console.warn("job cancel", err); }
        try { await post("/queue", { delete: [id] }); } catch (err) { console.warn("queue delete", err); }
        if (!realism.versionAtLeast((this.server && this.server.version) || "", "0.3.57")) return false;
        const q = await this.queuePosition(id);
        if (!q || !q.running) return false;
        try { await post("/interrupt", { prompt_id: id }); } catch (err) { console.warn("interrupt", err); }
        return true;
    },

    /** Write settings.realism whole (settings.set() stores a top-level key as given): the filled values with `patch`. */
    async setRealismValues(patch) {
        const next = realism.fillValues({ ...this.realismValues(), ...(patch || {}) });
        this.realismStored = next;
        this.emit("realism");
        try { await window.scumble.settings.set({ realism: next }); } catch (err) { console.warn("settings.realism not saved", err); }
        return next;
    },

    /**
     * The Realism Pass on a picture (docs/PLAN_0_1_42.md R2a; the whole picture's, realismWhole): `bytes` (any picture the
     * window decodes) through DLSS 5 on the user's ComfyUI at 1x, with settings.realism's Style, Strength and model
     * preset. An odd side is padded by repeating the last column or row and the answer cropped back; a picture with
     * transparency goes flattened onto mid-grey and gets its alpha back. A refused model preset makes settings.realism
     * use Default from then on and tries once more. `deadline` (ms, 0 for none): comfyPictureRun's hard end, the upload's
     * too. Throws an Error whose `hint` is the sentence (§3.4, §3.5) and whose `unsupported` says the server cannot run
     * the pass at all.
     * `factor` (R-U; the dialog's 1, 1.5, 1.7, 2 or 3): above 1 the pack's mode of that factor (realism.MODES), the answer
     * not cropped back but kept larger (only the padding's share comes off), the alpha scaled with it; a picture whose
     * output would pass 7680 × 4320 or 27.9 MP is scaled down first (realism.fitPlan, the browser's high-quality resampling, as the
     * editor's Resize scales), and the note says so. 1 keeps the refusal past the cap.
     * The answer is held against what went (0.1.50 Q2), pixel for pixel on pieces spread over the picture
     * (realism.compareTiles): nearly the same picture at a Strength of realism.UNCHANGED_MIN_STRENGTH or more adds a note
     * that the pass changed nothing, and `unchanged` holds the difference (realism.pictureDiff), else null; every pass's
     * difference goes to the log.
     * -> { bytes, mime: "image/png", width, height, seconds, note, factor, sent: [w, h], scaled: [w, h] | null, unchanged }
     */
    async passPicture(editor, bytes, mime, { token = null, deadline = 0, factor = 1 } = {}) {
        const L = realism.LABEL;
        const fail = (text, extra) => Object.assign(new Error(text), { hint: text }, extra || {});
        const support = this.realismSupport();
        if (!support.ok) throw fail(support.reason, { unsupported: true });
        if (token && token.cancelled) throw fail(`${L} cancelled.`, { kind: "cancelled" });
        const mode = realism.modeFor(factor);
        if (!mode) throw fail(realism.factorRefusal(factor));
        const up = mode.factor > 1;
        let img;
        try { img = await bytesToImage(bytes, mime); } catch (_) { throw fail(`${L}: the picture could not be decoded.`); }
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!(w > 0 && h > 0)) throw fail(`${L}: the picture is empty.`);
        // what goes: the picture at its own size padded to even sides, or (above 1×, past the cap) scaled down first
        const plan = realism.fitPlan(w, h, mode.factor);
        if (plan.refusal) throw fail(plan.refusal);
        const [fw, fh] = plan.fit, [w2, h2] = plan.sent;
        // the one readback of the source (the acceleration-latch trap): its alpha is reused for the answer
        const c = document.createElement("canvas");
        c.width = fw; c.height = fh;
        const cx = c.getContext("2d", { willReadFrequently: true });
        if (plan.scaled) {
            cx.imageSmoothingEnabled = true;
            cx.imageSmoothingQuality = "high";
            cx.drawImage(img, 0, 0, fw, fh);
        } else {
            cx.imageSmoothingEnabled = false;
            cx.drawImage(img, 0, 0);
        }
        const source = cx.getImageData(0, 0, fw, fh).data;
        const keepAlpha = realism.hasAlpha(source);
        const prep = realism.prepPixels(source, fw, fh, keepAlpha);
        c.width = w2; c.height = h2;
        cx.putImageData(new ImageData(prep.data, w2, h2), 0, 0);
        // what went, read where its answer is held against it (0.1.50 Q2: an answer equal to it means the pass did
        // nothing): pieces of the picture without its padding, pixel for pixel
        const tiles = up ? realism.compareTiles(fw, fh) : realism.compareTiles(w, h);
        const sentTiles = mosaicPixels(c, tiles);
        const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
        let values = this.realismValues();
        // the upload and the server's copy of it end at a Cancel and at the timeout too: a stalled forward to the server
        // never holds the caller. The request runs on and is ignored (a stray input)
        const upload = this.uploadInput(new Blob([await canvasBytes(c)], { type: "image/png" }), `n${editor ? editor.node.id : 0}_pass_${stamp}.png`);
        c.width = c.height = 0;
        const ref = await new Promise((resolve, reject) => {
            const t0 = Date.now(), end = Math.min(t0 + values.timeout * 1000, deadline || Infinity);
            let iv = null;
            const done = (fn, v) => { clearInterval(iv); fn(v); };
            iv = setInterval(() => {
                if (token && token.cancelled) done(reject, fail(`${L} cancelled.`, { kind: "cancelled" }));
                else if (Date.now() > end) done(reject, fail(`${L}: your ComfyUI did not take the picture within ${Math.round((Date.now() - t0) / 1000)} s.`, { kind: "timeout" }));
            }, 250);
            upload.then((v) => done(resolve, v), (err) => done(reject, err));
        });
        const notes = [];
        if (support.note) notes.push(support.note);
        if (plan.scaled) notes.push(realism.scaledDownNote(fw, fh));
        let res = null, fellBack = "";
        while (!res) {
            const prompt = realism.passPrompt(this.realismRecipe(), values, ref, mode.label);
            try {
                res = await this.comfyPictureRun(editor, prompt, realism.PASS_OUTPUT, { label: L, token, timeoutMs: values.timeout * 1000, deadline });
            } catch (err) {
                // the runtime refused the asked model preset: Default from now on, and once more with it (a refusal of
                // Default ends it). The recipe's own DLSS model preset row is not settings.realism and stays as it is
                if (err && err.kind === "error" && realism.isPresetRefusal(err.message) && values.preset !== "Default") {
                    fellBack = realism.presetFallbackNote(values.preset);
                    values = await this.setRealismValues({ preset: "Default" });
                    notes.push(fellBack);
                    if (editor && editor.setStatus) editor.setStatus(fellBack, "warn");
                    continue;
                }
                // a failure after the fallback still says that settings.realism changed
                const text = realism.runFailure(err);
                throw fail(fellBack ? `${text} ${fellBack}` : text, { kind: (err && err.kind) || "error" });
            }
        }
        // the answer cropped back to w × h at 0, 0 (1×), or above 1× to the part that is the picture (the padding's
        // share off, the answer's own scale kept); with transparency the source's alpha written back, scaled with it
        let out;
        try { img = await bytesToImage(res.bytes, res.mime); } catch (_) { throw fail(`${L}: your ComfyUI's answer could not be decoded.`); }
        const aw = img.naturalWidth || img.width, ah = img.naturalHeight || img.height;
        if (!up && (aw < w || ah < h)) throw fail(`${L}: your ComfyUI answered ${aw} × ${ah} for a picture of ${w} × ${h}.`);
        if (up && (aw <= w2 || ah <= h2)) throw fail(`${L}: your ComfyUI answered ${aw} × ${ah} for a picture of ${w2} × ${h2} at ${mode.text}.`);
        // the answer held against what went (0.1.50 Q2), the same pieces (above 1× drawn down by the answer's scale): the
        // same picture back means the pass changed nothing on this card (it still lands, said in red); below a small
        // Strength nothing is said (an unchanged picture is what Strength 0 asks for). Every pass's numbers go to the log,
        // so the first passes on a card show how far the bounds are
        const diff = realism.pictureDiff(sentTiles, mosaicPixels(img, tiles, up ? aw / w2 : 1, up ? ah / h2 : 1));
        const unchanged = realism.unchangedAt(diff, values.intensity);
        if (unchanged) notes.push(realism.unchangedNote(support.gpu, diff, mode.factor));
        try {
            const pieces = tiles.tiles.length > 1 ? `${tiles.tiles.length} pieces of ${tiles.tiles[0].sw} × ${tiles.tiles[0].sh} px` : `${tiles.width} × ${tiles.height} px`;
            const line = `${L}: the answer against what went (${pieces}${up ? `, the answer drawn down from ${mode.text}` : ", pixel for pixel"}): ${realism.diffText(diff)}; Strength ${values.intensity}${unchanged ? ": said to have changed nothing" : ""}`;
            if (window.scumble && window.scumble.log) Promise.resolve(window.scumble.log.add({ level: "info", source: "realism", message: line })).catch(() => { /* the log is optional */ });
        } catch (_) { /* the log is optional */ }
        const kw = up ? Math.round(fw * aw / w2) : w, kh = up ? Math.round(fh * ah / h2) : h;
        if (!keepAlpha && aw === kw && ah === kh) out = res.bytes;
        else {
            c.width = kw; c.height = kh;
            cx.imageSmoothingEnabled = false;
            cx.drawImage(img, 0, 0, kw, kh, 0, 0, kw, kh);
            if (keepAlpha) {
                const answer = cx.getImageData(0, 0, kw, kh).data;
                const alpha = up ? realism.scaleAlpha(source, fw, fh, kw, kh) : source;
                cx.putImageData(new ImageData(realism.putAlphaBack(answer, kw, kh, alpha, kw, kh), kw, kh), 0, 0);
            }
            out = await canvasBytes(c);
            c.width = c.height = 0;
        }
        return {
            bytes: out, mime: out === res.bytes ? res.mime : "image/png", width: kw, height: kh, seconds: res.seconds, note: notes.join(" "),
            factor: mode.factor, sent: [w2, h2], scaled: plan.scaled ? [fw, fh] : null, fellBack: !!fellBack,
            unchanged: unchanged ? diff : null,
        };
    },

    /**
     * "" when realismWhole would start on this document now, else the sentence it refuses with, before anything is read
     * or sent: the server, a run going on the document (an API run, the pass, a local render still on the server), the
     * document still loading, no picture, past 7680 × 4320 or 27.9 MP (the size before anything is read: a 15k document is refused
     * without its flatten). `status`'s realism answers from it too, so an agent is never told ready for a refused pass.
     * `factor` (R-U): a factor no mode has first; above 1× the document is resized when the answer lands, so not while
     * a job would land where the picture was (turnBlocked, as for an upscale of the whole picture), and the size is
     * realism.fitPlan's (a picture whose output would pass the cap is scaled down instead; a fit under 64 px, or one that
     * would not get larger, which is every picture already past the cap, is refused). `status` asks at 1×.
     */
    realismWholeRefusal(editor, { factor = 1 } = {}) {
        const c = this.realismWholeCheck(editor, { factor });
        return c ? c.text : null;
    },

    /**
     * realismWholeRefusal's sentence with its status kind (item 45): plain for the user's state (not connected, a run
     * going, still loading, no picture, the document busy), "warn" for a limit or what the server cannot do. Null: none.
     */
    realismWholeCheck(editor, { factor = 1 } = {}) {
        const L = realism.LABEL;
        const say = (text, kind) => (text ? { text, kind } : null);
        const mode = realism.modeFor(factor);
        if (!mode) return say(realism.factorRefusal(factor), "warn");
        const support = this.realismSupport();
        const state = (this.server && this.server.state) || "disconnected";
        if (!support.ok) return say(support.reason, state === "connected" || state === "missing-node" ? "warn" : "info");
        if (editor.providerPending || (editor._localRuns && editor._localRuns.size)) return say(`${L}: a run is still going on this document.`, "info");
        if (editor._loading) return say(`${L}: the document is still loading.`, "info");
        if (!editor.base || !editor.width || !editor.height) return say(`${L}: load an image first.`, "info");
        if (mode.factor === 1) return say(realism.wholeRefusal(editor.width, editor.height), "warn");
        const blocked = editor.turnBlocked ? editor.turnBlocked() : "";
        if (blocked) return say(`${L}: ${blocked}`, "info");
        return say(realism.fitPlan(editor.width, editor.height, mode.factor).refusal, "warn");
    },

    /**
     * The Realism Pass over the whole picture (docs/PLAN_0_1_42.md R3a; the Upscale dialog's entry and the realism_pass
     * command call it, R3b): the visible composite as a run sees it (every visible layer with its filters and blend
     * modes, without reference and control layers) up to the top run of filter layers goes once, at its own size,
     * through DLSS 5 at 1x on the user's ComfyUI (passPicture) and lands as a new layer named the label: full size at
     * 0, 0, no colour match, under that run of filters, one undo step. A second run reads an earlier pass layer with the
     * rest and stacks its layer above it. Busy like a run while it works: the title row's timer names it and its Cancel
     * ends it; closing the tab ends it too and adds nothing. Refused before anything is read or sent (the server, a run
     * going on the document, no picture, the size); a failure adds nothing. Each sentence is the status and the thrown
     * Error's message. `deadline` (a time in ms, 0 for none): comfyPictureRun's hard end, the queue's wait included.
     * `factor` (R-U, docs/PLAN_0_1_42.md Q29): above 1 (1.5, 1.7, 2, 3) the document becomes that many times larger
     * (the base and every layer, mask and the selection scaled as Resize scales them) and the pass, at the pack's mode
     * of that factor, lands on top of it as the same new layer at the new size, both in one undo step; a picture whose
     * output would pass 7680 × 4320 or 27.9 MP (realism.MAX_AREA, measured) is scaled down before it goes, so the answer,
     * and the document, come back as large as the pass allows. The landing goes through resizeImage's `base` path while the run slot is held
     * (a token that `resizes`: Generate and the helper jobs are refused meanwhile), after wholeLandingRefusal's net; from
     * the resize on the Cancel is gone from the title row (it could no longer stop the landing).
     * An answer that is the picture that went (passPicture's `unchanged`, 0.1.50 Q2) still lands, and the status line
     * says in red that the pass changed nothing on this card; the note carries the sentence.
     * -> { layer, seconds, note, changed, factor, from: [W, H], width, height, unchanged } (layer null when the tab was
     *    closed meanwhile)
     */
    async realismWhole(editor, { deadline = 0, factor = 1 } = {}) {
        const L = realism.LABEL;
        const say = (text, kind) => { editor.setStatus(text, kind); return refusal(text, editor.statusKind || "info"); };
        const refused = this.realismWholeCheck(editor, { factor });
        if (refused) throw say(refused.text, refused.kind);
        const W = editor.width, H = editor.height;
        const mode = realism.modeFor(factor);
        const up = mode.factor > 1;
        const plan = up ? realism.fitPlan(W, H, mode.factor) : null;
        // above 1× the landing resizes the document: `resizes` refuses a Generate or a helper job meanwhile (see runUpscale)
        const token = { provider: "comfyui", label: L, started: Date.now(), editor, resizes: up };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();
        // closing the tab ends the pass (its job taken off the server) and lands nothing
        let closed = false;
        const offRemoved = this.on("removed", (e) => { if (e && e.editor === editor) { closed = true; token.cancelled = true; } });
        const gone = () => closed || !this._editors.includes(editor);
        const isFill = (l) => editor.isFillLayer(l);
        // what a run leaves out (references, control layers) and what it does not draw (a hidden layer, a rejected
        // result on top): passed over, so a film look under them still counts as the top run of filters
        const skip = (l) => editor.isReference(l) || editor.isControl(l) || (l.kind !== "filter" && !l.visible);
        // what a read of the layers below `upTo` depends on: the "picture changed" note compares it, not the editor-wide
        // compositeVersion, which also moves for the live filters above the cut, the references and every redraw in
        // Compare. The global pixelVersion stays in as a net for a pixel write a layer's own version misses
        const pv = (p) => (p ? `${objectId(p)}.${p.version || 0}` : "-");
        const readSig = (upTo) => {
            const parts = [editor.width, editor.height, editor.pixelVersion || 0, pv(editor.basePx), editor.compareShow || ""];
            for (const l of editor.layers.slice(0, upTo)) {
                if (editor.isReference(l) || editor.isControl(l)) continue;
                parts.push(l.id, editor.shown(l) ? 1 : 0, l.opacity, l.blend || "", l.clip ? 1 : 0, l.group || "", l.x, l.y, l.w, l.h, l.kind,
                    l.kind === "filter" ? `${l.filter}${JSON.stringify(l.params || {})}${objectId(l._lutData)}${objectId(l._plateImg)}` : "",
                    pv(l.px), pv(l.maskPx), l.maskOff ? 1 : 0, l.match ? `${l.match.strength}:${l.match.source}` : "");
            }
            return parts.join("|");
        };
        const cancelled = () => Object.assign(new Error(`${L} cancelled.`), { hint: `${L} cancelled.`, kind: "cancelled" });
        try {
            const upTo = realism.topFilterRun(editor.layers, isFill, skip);
            editor.setStatus(`${L}: reading the picture (${W} × ${H}) ...`);
            // taken before the read, so a change during encodeComposite's await counts
            const sig0 = readSig(upTo);
            // as a run reads it: the workers' bands on tiles, else (the canvas backend, a stack they cannot hold) a flatten
            let bytes;
            const enc = await editor.encodeComposite({ forRun: true, upTo });
            if (enc) bytes = new Uint8Array(await enc.blob.arrayBuffer());
            else {
                if (editor.relightSettled) await editor.relightSettled();
                const c = editor.flattenToCanvas({ forRun: true, upTo });
                try { bytes = await canvasBytes(c); } finally { c.width = c.height = 0; }
            }
            const goes = !up ? `${W} × ${H}` : plan.scaled ? `${W} × ${H}, scaled down to ${plan.fit[0]} × ${plan.fit[1]}, at ${mode.text}` : `${W} × ${H} at ${mode.text}`;
            editor.setStatus(`${L}: sending the picture (${goes}) to your ComfyUI ...`);
            const out = await this.passPicture(editor, bytes, "image/png", { token, deadline, factor: mode.factor });
            bytes = null;
            const none = { layer: null, seconds: out.seconds || 0, note: "", changed: false, factor: mode.factor, from: [W, H], width: null, height: null, unchanged: false };
            if (gone()) return none;
            // the title row's Cancel stays until the layer is in: pressed after the answer, nothing lands either
            if (token.cancelled) throw cancelled();
            const img = await bytesToImage(out.bytes, out.mime);
            const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
            // above 1×: the document's new size (the answer's width, the picture's aspect, as an upscale of the whole
            // picture lands; the answer's own height where that rounding would pass the 1× caps, realism.landingSize);
            // the layer's pixels the answer as it is, or stretched by the pixel or two the pack's even rounding moved
            // its height
            const land = up ? realism.landingSize(W, H, w, h) : null;
            const nw = up ? land.w : W, nh = up ? land.h : H;
            if (up && nw <= W) throw new Error(`${L}: your ComfyUI answered ${w} × ${h}, which is not larger than the picture (${W} × ${H}).`);
            let lbytes = out.bytes, lmime = out.mime, lcanvas = null;
            if (up && h !== nh) {
                lcanvas = document.createElement("canvas");
                lcanvas.width = nw; lcanvas.height = nh;
                const lx = lcanvas.getContext("2d");
                lx.imageSmoothingEnabled = true;
                lx.imageSmoothingQuality = "high";
                lx.drawImage(img, 0, 0, nw, nh);
                lbytes = await canvasBytes(lcanvas);
                lmime = "image/png";
            }
            // stored as a result is: its PNG in the mirror, so neither a save nor the autosave encodes it again; when the
            // mirror fails, an unsaved layer, which they upload
            let ref = null;
            if (lmime === "image/png") {
                const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
                try { ref = await this.uploadResult(new Blob([lbytes], { type: "image/png" }), `n${editor.node.id}_realism_${stamp}.png`); }
                catch (err) { console.warn("the Realism Pass layer stays unsaved until the next save", err); }
            }
            lbytes = null;
            if (gone()) { if (lcanvas) lcanvas.width = lcanvas.height = 0; return none; }
            if (token.cancelled) { if (lcanvas) lcanvas.width = lcanvas.height = 0; throw cancelled(); }
            // under the top run of filter layers as the stack is now (layers may have come or gone during the run): what
            // lies under that index now against what was read (before a resize, which moves every layer)
            const at0 = realism.topFilterRun(editor.layers, isFill, skip);
            const changed = readSig(at0) !== sig0;
            // (the canvas backend's layer keeps the canvas it is made from: it is not emptied here)
            const px = lcanvas ? editor.pixels.Layer.fromCanvas(lcanvas) : editor.pixels.Layer.fromImage(img);
            if (up) {
                // the net before the resize (release review 2026-10-05): the size the pass started from, and no job that
                // would land in the old geometry; refused with the reason, nothing added
                const refused = await this.wholeLandingRefusal(editor, W, H, gone);
                if (gone()) return none;
                if (refused) throw new Error(`${L}: ${refused}`);
                if (token.cancelled) throw cancelled();
                // from here the landing cannot be stopped (half of it would be in): the timer and Cancel leave the title
                // row, so neither it nor cancel_run reports a cancel that nothing honours; the slot stays held until the
                // layer is in (endRun below)
                this.endRunRow(token);
                // the document by the factor (Q29): the base scaled as Resize scales it, given as the new base so the
                // landing goes through while this run holds the slot (resizeImage's `base`); every layer, mask and the
                // selection scale along, one `canvas` undo step, which the pass layer below joins (no step of its own)
                const nb = document.createElement("canvas");
                nb.width = nw; nb.height = nh;
                const nctx = nb.getContext("2d");
                nctx.imageSmoothingEnabled = true;
                nctx.imageSmoothingQuality = "high";
                editor.drawBaseInto(nctx, 0, 0, nw, nh);
                // the step is found by identity: with a full history the push drops the oldest, so the length stays
                const last0 = editor.undo[editor.undo.length - 1];
                try { await editor.resizeImage(nw, nh, { base: nb }); } finally { nb.width = nb.height = 0; }
                // a closed tab ends it here too
                if (gone()) return none;
                if (editor.width !== nw || editor.height !== nh) throw new Error(editor.status || `${L}: the picture could not be resized.`);
                // the Undo history names the pass, not "Upscale image"
                const step = editor.undo[editor.undo.length - 1];
                if (step && step !== last0 && step.kind === "canvas") { step.label = L; if (editor.historyChanged) editor.historyChanged(); }
            } else {
                editor.pushUndo({ kind: "layers", label: L });
            }
            const at = realism.topFilterRun(editor.layers, isFill, skip);
            const layer = editor.addLayer({ name: L, kind: "image", ref, dirty: !ref, px, x: 0, y: 0, w: nw, h: nh, match: { strength: 0, source: "underneath" } });
            // the move is part of the undo step above
            const top = editor.layers.length - 1;
            if (at < top) editor.moveLayer(layer.id, at - top, { undo: false });
            const where = `a new layer above the picture${at < top ? ", under the filter layers" : ""}`;
            const secs = Math.max(1, Math.round(out.seconds || 0));
            const parts = [up
                ? `${L} ran on your ComfyUI in ${secs} s at ${mode.text}: ${W} × ${H} is now ${nw} × ${nh}, every layer scaled along, and the pass is ${where} (Ctrl+Z takes both back).`
                : `${L} ran on your ComfyUI in ${secs} s: ${where}.`];
            if (changed) parts.push("The picture changed while the pass ran: the layer shows it as it was when the pass started.");
            if (out.note) parts.push(out.note);
            // a preset the runtime refused and replaced is a fallback, an answer that is the picture unchanged a pass that
            // did nothing (0.1.50 Q2): red (item 45)
            editor.setStatus(parts.join(" "), out.fellBack || out.unchanged ? "warn" : "info");
            return { layer, seconds: out.seconds || 0, note: out.note || "", changed, factor: mode.factor, from: [W, H], width: nw, height: nh, unchanged: !!out.unchanged };
        } catch (err) {
            if (gone()) return { layer: null, seconds: 0, note: "", changed: false, factor: mode.factor, from: [W, H], width: null, height: null, unchanged: false };
            const msg = String((err && err.message) || err);
            throw say(err && err.hint ? String(err.hint) : msg.startsWith(L) ? msg : `${L}: ${msg}`, failKind(err));
        } finally {
            offRemoved();
            this.endRun(editor, token);
        }
    },
};
