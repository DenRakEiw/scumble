// @ts-check
// The helper prompts a document waits for on the user's ComfyUI (a selection by text, the object map, a prompt
// upsampling through a node, a background removal): their wait ends here when ComfyUI will never answer (issue
// scumble-app/scumble#15, 2026-11-17: SAM3 hung, ComfyUI was restarted, and the tab stayed on "Segmenting ..." until
// Scumble was restarted). The editor ends such a wait itself on the helper's output, and host.js on ComfyUI's
// execution_error; neither comes after a restart of the server, a cleared queue or an interrupt. Each helper also has
// a row in the title row, so Cancel (and the cancel_run command) stops it.

import { api } from "./host_util.js";

// what each helper is called in a status line, and the words of its failure (as host.js's execution_error says them)
const KINDS = {
    segment: { label: "Selection by text", failed: "Segmentation failed: " },
    objects: { label: "Object detection", failed: "Object detection failed: " },
    upsample: { label: "Prompt upsampling", failed: "Upsampling failed: " },
    cutout: { label: "Background removal", failed: "Background removal failed: " },
};
const ROW_AFTER = 1500;     // ms a helper runs before it gets its row in the title row (a fast one never shows one)
const LISTED_AFTER = 3000;  // ms before a job missing from /queue counts as gone (a job queued a moment ago may not be listed)
const POLL_EVERY = 2000;    // ms between two reads of /queue
const SILENT_POLLS = 10;    // reads of /queue without an answer, the socket down, before the wait ends as lost (20 s)
const KEPT = 64;

function keep(set, id) {
    set.add(id);
    for (const old of set) { if (set.size <= KEPT) break; set.delete(old); }
}

export const HostHelperWatchPart = {
    // prompt id -> { ed, kind, at, state0, url, gone, silent, token } of each helper prompt a document waits for
    _helperSeen: new Map(),
    // the ids whose output came (the editor's own code ends that wait, whatever becomes of the output)
    _helperAnswered: new Set(),
    // the ids whose wait ended here (lost, gone, interrupted, cancelled): an output that still comes lands nowhere
    _helperEnded: new Set(),
    _helperPolled: 0,
    _helperPolling: false,

    /**
     * The helper prompts on ComfyUI that `ed` waits for: [{ kind, id }]. Read from the editor's own fields: each
     * helper sets its prompt id when the queue answers (and forgets the last one when it starts), so an in-app helper
     * (no prompt) and one whose queue request is still out are not listed.
     */
    helperPrompts(ed) {
        const out = [];
        const add = (kind, id) => { if (id != null && id !== "" && !this._helperAnswered.has(String(id)) && !this._helperEnded.has(String(id))) out.push({ kind, id: String(id) }); };
        if (!ed) return out;
        if (ed.segmentPending) add("segment", ed.segmentPromptId);
        if (ed.objectsPending && ed.objectsPending.stage === "run") add("objects", ed.objectsPending.promptId);
        if (ed.upsamplePending) add("upsample", ed.upsamplePromptId);
        if (ed.cutoutPending) add("cutout", ed.cutoutPromptId);
        return out;
    },

    /** Whether `ed` still waits for helper prompt `id` of `kind`. */
    helperWaits(ed, kind, id) {
        return this._editors.includes(ed) && this.helperPrompts(ed).some((h) => h.kind === kind && h.id === String(id));
    },

    /** The document that waits for helper prompt `id`: { ed, kind }, or null. */
    helperOf(id) {
        for (const ed of this._editors) for (const h of this.helperPrompts(ed)) if (h.id === String(id)) return { ed, kind: h.kind };
        return null;
    },

    /** A helper prompt's output came: its wait is the editor's own again (the executed listener, host.js). */
    helperAnswered(id) {
        keep(this._helperAnswered, String(id));
        this.helperRows();
    },

    /**
     * End `ed`'s wait for helper prompt `id` with a line in its status: what host.js's execution_error does for a
     * failure, for an end ComfyUI says nothing about. The document is free again; a late output of `id` lands nowhere.
     */
    endHelper(ed, kind, id, text, statusKind = "error") {
        if (!this.helperWaits(ed, kind, id)) return false;
        keep(this._helperEnded, String(id));
        if (kind === "segment") { ed.segmentPending = null; if (ed.segBtn) ed.segBtn.disabled = false; }
        else if (kind === "objects") ed.objectsPending = null;
        else if (kind === "upsample") { ed.upsamplePending = null; if (ed.upBtn) ed.upBtn.disabled = false; }
        else if (kind === "cutout") { ed.cutoutPending = null; if (ed.renderLayers) ed.renderLayers(); }
        if (ed.setStatus) ed.setStatus(text, statusKind);
        this.helperRows();
        return true;
    },

    /**
     * The watch's list brought up to the helpers that wait now: a new one is noted (with the server it was queued on),
     * one that waits no more loses its row. `force`: every helper gets its row at once (a Cancel is about to read them).
     * -> the entries of the helpers that wait
     */
    helperRows(force = false) {
        const now = Date.now();
        const s = this.server || { state: "", url: "" };
        const live = new Map();
        for (const ed of this._editors) for (const h of this.helperPrompts(ed)) live.set(h.id, { ed, kind: h.kind });
        for (const [id, e] of this._helperSeen) {
            if (live.has(id)) continue;
            this._helperSeen.delete(id);
            if (e.token) this.endRunRow(e.token);
        }
        const out = [];
        let added = false;
        for (const [id, h] of live) {
            let e = this._helperSeen.get(id);
            if (!e) { e = { id, ed: h.ed, kind: h.kind, at: now, state0: s.state || "", url: s.url || "", gone: 0, silent: 0, token: null }; this._helperSeen.set(id, e); }
            if (!e.token && (force || now - e.at >= ROW_AFTER)) {
                e.token = { provider: "comfyui", label: KINDS[e.kind].label, started: e.at, editor: e.ed, helper: { kind: e.kind, id } };
                this._providerRuns.add(e.token);
                added = true;
            }
            out.push(e);
        }
        if (added) this.notifyProviderRuns();
        return out;
    },

    /**
     * Cancel the helper prompts among `runs` (cancelRuns' tokens, already marked cancelled): each job is taken off
     * ComfyUI (its own prompt only, cancelComfyPrompt) and its document is free at once, whatever the server answers.
     */
    cancelHelpers(runs) {
        for (const t of runs) {
            if (!t || !t.helper) continue;
            const { kind, id } = t.helper;
            this.cancelComfyPrompt(id).catch((err) => console.warn("helper cancel", err));
            t.said = `${KINDS[kind].label} cancelled.`;
            this.endHelper(t.editor, kind, id, t.said, "info");
            this.endRunRow(t);
        }
    },

    /** ComfyUI's end events for a helper prompt (host.js): an interrupt ends the wait, a success without an output is looked up. */
    helperEvent(type, detail) {
        const id = detail && detail.prompt_id != null ? String(detail.prompt_id) : "";
        const hit = id ? this.helperOf(id) : null;
        if (!hit) return false;
        if (type === "interrupted") this.endHelper(hit.ed, hit.kind, id, `${KINDS[hit.kind].label} was interrupted on your ComfyUI.`, "info");
        // the output's `executed` comes before the success: one that is still waited for a moment later never came
        else if (type === "success") setTimeout(() => { const h = this.helperOf(id); if (h) this.helperGone(h.ed, h.kind, id).catch((err) => console.warn("helper watch", err)); }, 1500);
        return true;
    },

    /**
     * Helper prompt `id` in /history: { found, outputs: [{ node, output }] (the nodes with a mask or a text for the
     * editor), error (the server's message), interrupted }; throws when /history does not answer.
     */
    async helperFromHistory(id) {
        const r = await api.fetchApi("/history/" + encodeURIComponent(id), { signal: AbortSignal.timeout(15000) });
        if (r.status !== 200) throw new Error("/history answered " + r.status);
        const all = await r.json();
        const h = all && all[id];
        if (!h) return { found: false, outputs: [], error: "", interrupted: false };
        const outputs = [];
        for (const [node, output] of Object.entries(h.outputs || {})) {
            if (output && (Array.isArray(output.inpaint_mask) || Array.isArray(output.inpaint_text))) outputs.push({ node, output });
        }
        const msgs = (h.status && h.status.messages) || [];
        const err = msgs.find((m) => Array.isArray(m) && m[0] === "execution_error");
        return {
            found: true, outputs,
            error: err ? String((err[1] && err[1].exception_message) || "execution failed") : "",
            interrupted: msgs.some((m) => Array.isArray(m) && m[0] === "execution_interrupted"),
        };
    },

    /**
     * ComfyUI's queue no longer holds helper prompt `id` and no output came: what /history says. An output there (the
     * socket missed its event) goes to the editor as the event would have; an error or an interrupt ends the wait in
     * its words; a job the server knows nothing of (it was restarted, its queue cleared) ends it as gone.
     * -> false when /history did not answer (asked again at the next poll)
     */
    async helperGone(ed, kind, id) {
        let got;
        try { got = await this.helperFromHistory(id); } catch (_) { return false; }
        if (!this.helperWaits(ed, kind, id)) return true;
        const L = KINDS[kind].label;
        if (got.outputs.length) {
            for (const o of got.outputs) api.dispatch("executed", { prompt_id: id, node: o.node, output: o.output });
            // an output the listener did not take (no mask, no text in it) leaves the wait: said as an empty answer
            if (this.helperWaits(ed, kind, id)) this.endHelper(ed, kind, id, `${L}: your ComfyUI finished without an answer.`);
        } else if (got.error) this.endHelper(ed, kind, id, KINDS[kind].failed + got.error);
        else if (got.interrupted) this.endHelper(ed, kind, id, `${L} was interrupted on your ComfyUI.`, "info");
        else if (got.found) this.endHelper(ed, kind, id, `${L}: your ComfyUI finished without an answer.`);
        else this.endHelper(ed, kind, id, `${L}: your ComfyUI no longer holds its job (was it restarted, or its queue cleared?). Nothing was changed; run it again.`);
        return true;
    },

    /**
     * The watch's tick (host.js, once a second): the rows, then for each helper that waits: the server it was queued
     * on was disconnected or replaced by another -> lost; /queue (read at most every 2 s) no longer holds it twice in
     * a row -> helperGone; /queue silent while the socket is down for 20 s -> lost. A helper queued while no server
     * was connected (a test's stub) is never judged by the connection.
     */
    async watchHelpers() {
        const waiting = this.helperRows();
        if (!waiting.length) return;
        const now = Date.now();
        const s = this.server || { state: "", url: "" };
        const lost = (e) => this.endHelper(e.ed, e.kind, e.id, `${KINDS[e.kind].label}: the connection to your ComfyUI was lost. Nothing was changed; run it again once it is back.`);
        const connected0 = (e) => e.state0 !== "disconnected" && e.state0 !== "error" && e.state0 !== "";
        for (const e of waiting) {
            if (!connected0(e)) continue;
            if (s.state === "disconnected" || s.state === "error" || (e.url && s.url && s.url !== e.url)) lost(e);
        }
        if (this._helperPolling || now - this._helperPolled < POLL_EVERY) return;
        this._helperPolling = true;
        this._helperPolled = now;
        try {
            let held = null;
            try {
                const r = await api.fetchApi("/queue", { signal: AbortSignal.timeout(15000) });
                if (r.status === 200) {
                    const q = await r.json();
                    held = new Set([...((q && q.queue_running) || []), ...((q && q.queue_pending) || [])].filter(Array.isArray).map((it) => String(it[1])));
                }
            } catch (_) { held = null; }
            for (const e of this.helperRows()) {
                if (!held) {
                    // no answer: a server that is down (its socket too) for 20 s will not bring this job back
                    if (this._socketWas === false && connected0(e) && ++e.silent >= SILENT_POLLS) lost(e);
                    continue;
                }
                e.silent = 0;
                if (held.has(e.id)) { e.gone = 0; continue; }
                if (Date.now() - e.at < LISTED_AFTER || ++e.gone < 2) continue;
                if (!(await this.helperGone(e.ed, e.kind, e.id))) e.gone = 1;
            }
        } finally {
            this._helperPolling = false;
        }
    },
};
