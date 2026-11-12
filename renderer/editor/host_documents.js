// @ts-check
// documents: save and open, dirty marks, closed tabs: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import * as dialogs from "../dialogs.js";
import { refusal } from "./inpaint_status.js";
import { CLOSED_MAX, STATE_KEYS, docMeta, documentQuestion, fmtMB, hashString, normPath } from "./host_util.js";

export const HostDocumentsPart = {
    // ---- .scumble documents (docs/PLAN_DOCUMENTS.md; the file is written and read in main, documents.js) -----------

    _docSaves: new Set(),
    _docSeq: 0,
    _docJobs: new Map(),      // reqId -> { editor, name, kind } for the progress line

    /** Resolves when no document save of this window is in flight (the close and the update wait for it). */
    async docSavesIdle() {
        while (this._docSaves.size) await Promise.allSettled(Array.from(this._docSaves));
    },

    /**
     * Everything one document's file must hold, uploaded now: the edited layers and masks (up to three rounds, for a
     * stroke that lands during one) and the selection's PNG (encoded in the background above 16 MP). The same steps
     * as saveBeforeRestart (renderer/shell.js), for one editor, and an upload that fails throws: a file with the
     * layer's old pixels under a new save would lose work without a word.
     * @param {any} ed
     * @param {(text: string) => void} [say]
     * @param {string} [when]
     */
    async flushEditor(ed, say = (_text) => {}, when = "saving") {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (const until = Date.now() + 60000; this._restoring && Date.now() < until;) await sleep(100);
        if (ed.heldEdit) await ed.heldEdit();   // a heal or a Remove still landing (its stroke is drawn until it has)
        for (const until = Date.now() + 10000; ed.pointer && Date.now() < until;) await sleep(50);   // a stroke still down
        const edited = () => ed.base && ed.layers && ed.layers.some((l) => (l.dirty && l.px) || (l.maskDirty && l.maskPx));
        if (edited()) say(`Saving the edited layers before ${when}...`);
        for (let round = 0; round < 3 && edited(); round++) await ed.syncLayers();
        const pending = () => ed.base && ed.sel && (ed._selEncoding || !ed.selectionEncoded || !ed.selectionDataUrl);
        for (const until = Date.now() + 60000; pending() && Date.now() < until;) {
            if (!ed._selEncoding) {
                try { ed.getValue(); } catch (_) { /* reported by the save */ }
                if (pending() && !ed._selEncoding) break;      // an encode that cannot start (above the canvas limit)
            }
            say(`Saving the selection before ${when}...`);
            await sleep(100);
        }
    },

    /** The file's 256 px picture (PNG bytes), from the settled pyramid; null when it cannot be made. */
    async documentThumbnail(ed) {
        if (ed.heldEdit) await ed.heldEdit();
        const W = ed.width, H = ed.height;
        const small = await ed.sampleRegionSettled("image", [0, 0, W, H], Math.min(1, 256 / Math.max(W, H)), { forRun: true });
        const blob = small.convertToBlob ? await small.convertToBlob({ type: "image/png" }) : await new Promise((r) => small.toBlob(r, "image/png"));
        return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    },

    /** The name a document is saved and shown under: its file's stem, else the picture's file name. */
    documentName(ed) {
        if (ed && ed.docFile && ed.docFile.name) return String(ed.docFile.name).replace(/\.scumble$/i, "");
        if (!ed || !ed.base || !ed.base.ref) return "Untitled";
        return String(ed.base.ref.filename || "image").replace(/\.[a-z0-9]+$/i, "").replace(/~[0-9a-f]{8,64}$/i, "");
    },

    /**
     * Is the tab changed against its .scumble file (the "*" on the tab and in the title)? A document with a picture and
     * no file counts as changed; so does one with an edited layer or mask not uploaded yet, a selection not encoded
     * yet, a change since the last autosave, or an autosaved state whose hash is not the file's (bundle() keeps it).
     */
    documentDirty(ed) {
        if (!ed || !ed.base) return false;
        if (ed.pointer && ed.pointer.healing) return true;   // a heal stroke blending in a worker is an edit on its way
        if (!ed.docFile || !ed.docFile.key) return true;
        if (ed.layers.some((l) => (l.dirty && l.px) || (l.maskDirty && l.maskPx))) return true;
        if (ed.sel && !ed.selectionEncoded) return true;
        if (ed._stateKey == null) return true;
        return ed._stateKey !== ed.docFile.key;
    },

    /**
     * After a restore or an open: the state's key once the selection is encoded again (setValue re-encodes it). A file
     * without a key yet (just opened) or one the tab matched when the session was saved (`clean`) takes it as the saved
     * one, so the tab starts clean even where the restored state serialises a little differently.
     */
    async settleKey(ed) {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (const until = Date.now() + 60000; this._restoring && Date.now() < until;) await sleep(100);
        await this.flushEditor(ed, () => {}, "saving");
        if (!ed.base || !ed.docFile || !this._editors.includes(ed)) return;
        const key = hashString(ed.getValue());
        ed._stateKey = key;
        if (!ed.docFile.key || ed.docFile.clean) ed.docFile.key = key;
        delete ed.docFile.clean;
        if (this.onDocsChanged) this.onDocsChanged();
    },

    /**
     * What Generate new would take from this tab when its answer lands (setBaseFromCanvas keeps only the reference
     * layers and clears the undo history): { layers } (those that go), or null when nothing would be lost: no picture
     * yet, or a blank canvas nobody has worked on (issue #12).
     */
    replaceLoss(ed) {
        if (!ed || !ed.base) return null;
        const layers = ed.layers.filter((l) => !ed.isReference(l)).length;
        if (!layers && ed._blankBase && !ed.undo.length) return null;
        return { layers };
    },

    /**
     * A tab of its own for Generate new and New (issue #12), so a document with work in it stays as it is: a copy of
     * `ed` that holds only its reference layers (out of their groups), on the picture they stand on, with its prompt,
     * negative, generation and crop settings and its plugin data (the Boxes), and no history, selection, maps or
     * file. Generate new then replaces that copy's picture, keeping the references, as it did in place. A tab without
     * reference layers comes back as a copy with no layers (the boxes, the negative and the Settings rows still go
     * along); a tab without a picture as an empty one. Resolves with the new editor, made active; null when no tab
     * could be made.
     * @param {any} ed
     */
    async newTabFrom(ed) {
        if (!this.shell || !this.shell.newDocument) return null;
        const refIds = new Set(ed && ed.base ? ed.layers.filter((l) => ed.isReference(l)).map((l) => l.id) : []);
        if (!ed || !ed.base) {
            const fresh = this.shell.newDocument();
            this.shell.activate(fresh);
            return fresh;
        }
        // the references' pixels in the local store first, as a save does (an edited one would come back as it was)
        await Promise.race([this.flushEditor(ed, () => {}, "copying"), new Promise((r) => setTimeout(r, 30000))]);
        let st;
        try { st = JSON.parse(ed.getValue()); } catch (_) { return null; }
        st.layers = (st.layers || []).filter((l) => refIds.has(l.id)).map((l) => { const c = { ...l }; delete c.group; return c; });
        st.groups = [];
        st.history = [];
        st.selection = null;
        delete st.selectionBox;
        st.selections = [];
        delete st.guides;
        st.seen = [];
        st.depth = null;
        delete st.maps;
        const id = this.nextId++;
        const plugins = ed.pluginData && Object.keys(ed.pluginData).length ? JSON.parse(JSON.stringify(ed.pluginData)) : undefined;
        await this.restore(JSON.stringify({ version: 2, active: id, nextId: this.nextId, docs: [{ id, state: JSON.stringify(st), plugins }] }));
        const fresh = this.editorById(id);
        if (!fresh) return null;
        this.shell.activate(fresh);
        fresh.setStatus(refIds.size
            ? `A new tab with the reference layer${refIds.size === 1 ? "" : "s"} of ${this.documentName(ed)}.`
            : `A new tab with the prompt and settings of ${this.documentName(ed)}.`);
        this.saveAll();
        return fresh;
    },

    /**
     * A question about a document, in the app's own dialog (renderer/dialogs.js): `close` -> "save" | "discard" |
     * "cancel", `replace` -> "replace" | "cancel", `changed` and `newer` -> "overwrite" | "saveas" | "cancel", `history` -> "with" | "without" | "cancel".
     * A test replaces this method in the page.
     */
    async askDocument(q) {
        const d = documentQuestion(q || {});
        return d.answers[await dialogs.ask(d.spec)] || "cancel";
    },

    /** Save As: the path from main's dialog, or null when cancelled (a test replaces this method in the page). */
    async chooseDocumentPath(name) {
        return window.scumble.documents.choosePath({ name });
    },

    /** Stop a save or an open of this document: before the write, the capture stops; during it, main deletes its temporary file. */
    cancelDocumentJob(ed) {
        const p = ed && ed._docProgress;
        if (!p) return false;
        ed._docCancel = true;
        if (p.reqId) window.scumble.documents.cancel(p.reqId).catch(() => {});
        return true;
    },

    /**
     * Save a document to a .scumble file. `as` asks for a path (Save As), `path` gives one (commands), `copy` writes
     * the file without making it the tab's file, `history` true / false keeps or leaves the result history (and the
     * prompts of earlier runs) out; unset, a Save As of a document with results asks, and the tab's file remembers the
     * answer for the next Ctrl+S. `ask: false` (commands) asks nothing. Resolves with main's answer ({ path, bytes,
     * entries, ms, notes }), or null when a dialog was cancelled. Throws with the reason.
     */
    async saveDocument(ed, { as = false, copy = false, path = null, history = null, ask = true } = {}) {
        if (!ed || !ed.base) throw refusal("There is nothing to save yet: the document holds no picture.");
        if (ed._docSaving) throw refusal(`${this.documentName(ed)} is already being saved.`);
        let target = path || (!as && !copy && ed.docFile && ed.docFile.path) || null;
        ed._docSaving = true;      // from here: a second Ctrl+S during a dialog is "already being saved"
        ed._docCancel = false;
        const job = (async () => {
            const inPlace = !!(target && ed.docFile && normPath(target) === normPath(ed.docFile.path));
            if (inPlace && ask) {
                // the file changed on disk since it was opened or saved here, or a newer Scumble made it: ask first
                const st = await window.scumble.documents.stat(target);
                const moved = st.exists && (Math.abs(st.mtime - (ed.docFile.mtime || 0)) > 1 || st.size !== ed.docFile.size);
                for (const kind of [moved && "changed", ed.docFile.newer && "newer"].filter(Boolean)) {
                    const a = await this.askDocument({ kind, name: ed.docFile.name });
                    if (a === "cancel") return null;
                    if (a === "saveas") { target = null; break; }
                }
            }
            let chosen = false;
            if (!target) {
                target = await this.chooseDocumentPath(this.documentName(ed));
                if (!target) return null;
                chosen = true;
            }
            const name = String(target).split(/[\\/]/).pop();
            // the result history: the caller's word, else the answer the tab's file remembers, else (a Save As of a
            // document with results) a question
            let keep = history;
            if (keep == null && !chosen && ed.docFile && normPath(target) === normPath(ed.docFile.path) && ed.docFile.history === false) keep = false;
            if (keep == null && chosen && ask && ed.history && ed.history.length) {
                const a = await this.askDocument({ kind: "history", name, count: Math.min(100, ed.history.length) });
                if (a === "cancel") return null;
                keep = a !== "without";
            }
            if (keep == null) keep = true;
            const reqId = `save-${ed.node.id}-${++this._docSeq}`;
            this._docJobs.set(reqId, { editor: ed, name, kind: "save" });
            ed._docProgress = { kind: "save", name, pct: null, reqId: null };
            if (this.onDocsChanged) this.onDocsChanged();
            try {
                ed.setStatus(`Saving ${name}...`);
                await this.flushEditor(ed, (t) => ed.setStatus(t), "saving the document");
                if (ed._docCancel) throw Object.assign(new Error("the save was cancelled"), { kind: "cancelled" });
                const state = ed.getValue();       // a stroke after this is not in the file and leaves the tab changed
                let thumbnail = null;
                try { thumbnail = await this.documentThumbnail(ed); } catch (err) { console.warn("document thumbnail", err); }
                if (ed._docCancel) throw Object.assign(new Error("the save was cancelled"), { kind: "cancelled" });
                const r = this.recipe;
                ed._docProgress.reqId = reqId;
                const res = await window.scumble.documents.write({
                    reqId, path: target, document: state, plugins: ed.pluginData || {}, extra: ed.docExtra || {}, thumbnail, history: keep, recent: !copy,
                    summary: { name: name.replace(/\.scumble$/i, ""), width: ed.width, height: ed.height, layers: ed.layers.length },
                    recipe: r ? { id: r.id || null, provider: r.provider || null } : null,
                });
                if (!copy) {
                    ed.docFile = { path: res.path, name: res.name, key: hashString(state), mtime: res.mtime, size: res.size, ...(keep ? {} : { history: false }) };
                    this.saveAll();                // the session keeps the tab's file (and bundle() the state's key)
                }
                ed.setStatus(`${copy ? "Saved a copy as" : "Saved"} ${res.name} (${fmtMB(res.bytes)}, ${(res.ms / 1000).toFixed(1)} s)${keep ? "" : ", without the result history"}.${res.notes && res.notes.length ? " " + res.notes.join("; ") + "." : ""}`, "info");
                return res;
            } finally {
                this._docJobs.delete(reqId);
                ed._docProgress = null;
                if (this.onDocsChanged) this.onDocsChanged();
            }
        })();
        this._docSaves.add(job);
        try { return await job; } finally { this._docSaves.delete(job); ed._docSaving = false; ed._docCancel = false; }
    },

    /**
     * Open a .scumble file: the tab that holds it is activated, else it opens into the active tab when that is empty,
     * or a new one. The files go into the mirror in main; the state is restored like the session's (restore()), and the
     * tab starts clean once its key has settled (settleKey). Resolves with { editor, already, notes }. Throws with the
     * reason (nothing is opened then).
     */
    async openDocument(file) {
        const key = normPath(file);
        const open = this._editors.find((ed) => ed.docFile && normPath(ed.docFile.path) === key);
        if (open) { if (this.shell) this.shell.activate(open); return { editor: open, already: true, notes: [] }; }
        const reqId = `open-${++this._docSeq}`;
        const name = String(file).split(/[\\/]/).pop();
        const cur = this.editor;
        if (cur) cur.setStatus(`Opening ${name}...`);
        this._docJobs.set(reqId, { editor: cur, name, kind: "open" });
        if (cur && !cur._docProgress) { cur._docProgress = { kind: "open", name, pct: null, reqId }; if (this.onDocsChanged) this.onDocsChanged(); }
        let r;
        try { r = await window.scumble.documents.open({ reqId, path: file }); } finally {
            this._docJobs.delete(reqId);
            if (cur && cur._docProgress && cur._docProgress.reqId === reqId) { cur._docProgress = null; if (this.onDocsChanged) this.onDocsChanged(); }
        }
        const doc = r.document;
        // top-level fields this app does not write travel in `extra` and go back into the next save (§6)
        const extra = {};
        for (const [k, v] of Object.entries(r.extra || {})) if (!STATE_KEYS.has(k)) extra[k] = v;
        for (const k of Object.keys(doc)) if (!STATE_KEYS.has(k)) extra[k] = doc[k];
        const reuse = cur && !cur.base && !cur._loading && !this._rawStates.has(cur) && !cur.docFile;
        const id = reuse ? cur.node.id : this.nextId++;
        const fileMeta = { path: r.path, name: r.name, key: null, mtime: r.mtime, size: r.size, ...(r.newer ? { newer: true } : {}) };
        await this.restore(JSON.stringify({ version: 2, active: id, nextId: this.nextId, docs: [{ id, state: JSON.stringify(doc), file: fileMeta, plugins: r.plugins, extra }] }));
        const ed = this.editorById(id);
        if (!ed) throw new Error(`${name} could not be opened in a tab`);
        if (this.shell) this.shell.activate(ed);      // the tab bar and window.editor follow (restore() activates in here only)
        // the tab is clean when this resolves (a command's list_documents right after reads it so)
        try { if (ed.base) await this.settleKey(ed); } catch (err) { console.warn("document key", err); }
        const notes = [...(r.notes || [])];
        // the recipe is global (every tab uses it), so opening a document does not switch it; it says when they differ
        const now = this.recipe;
        if (r.recipe && r.recipe.id && (!now || now.id !== r.recipe.id)) {
            const list = this.shell && this.shell.recipes ? this.shell.recipes() || [] : [];
            const named = (id) => { const x = list.find((q) => q.id === id); return x ? x.name || id : id; };
            notes.push(`saved with the recipe ${named(r.recipe.id)}; the current one is ${now ? named(now.id) : "none"}`);
        }
        if (ed.base) ed.setStatus(`Opened ${r.name}.${notes.length ? " " + notes.join("; ") + "." : ""}`, "info");
        this.saveAll();
        return { editor: ed, already: false, notes };
    },

    /** Main's progress of a save or an open: the chip on the document's tab (renderer/shell.js renderTabs). */
    documentProgress({ reqId, done, total }) {
        const j = this._docJobs.get(reqId);
        if (!j || !j.editor || !total) return;
        const pct = Math.min(100, Math.floor((done / total) * 100));
        const p = j.editor._docProgress;
        if (p && (p.reqId === reqId || p.reqId == null)) { p.pct = pct; p.reqId = reqId; }
        if (this.onDocsChanged) this.onDocsChanged();
    },

    // ---- closed tabs (docs/PLAN_DOCUMENTS.md §5.4) ------------------------------------------------------------------

    closed: [],          // [{ id, name, time, state, file?, plugins?, extra? }], the newest last, CLOSED_MAX at most

    /**
     * A tab that was closed (and already left the tab bar): its state goes on the closed list at once, then again after
     * its edited layers are uploaded (at most 30 s), so Reopen Closed Tab brings back what it showed. The caller
     * destroys the editor afterwards.
     */
    async rememberClosed(ed) {
        if (!ed || !ed.base) return;
        const capture = () => {
            let state = null;
            try { state = ed.getValue(); } catch (err) { console.warn("closed tab", err); }
            if (ed.base) ed._stateKey = state ? hashString(state) : null;
            return { id: ed.node.id, name: this.documentName(ed), time: Date.now(), state, ...docMeta(ed, !this.documentDirty(ed)) };
        };
        let entry = capture();
        if (!entry.state) return;
        this.closed.push(entry);
        while (this.closed.length > CLOSED_MAX) this.closed.shift();
        this.saveAll();
        try {
            await Promise.race([this.flushEditor(ed, () => {}, "closing"), new Promise((r) => setTimeout(r, 30000))]);
            const again = capture();
            const i = this.closed.indexOf(entry);
            if (again.state && i >= 0) { this.closed[i] = again; entry = again; this.saveAll(); }
        } catch (err) { console.warn("closed tab: its layers were not all uploaded", err); }
    },

    /** Reopen Closed Tab: the newest closed tab comes back in a new tab. Resolves with the editor, or null. */
    async reopenClosed() {
        const e = this.closed.pop();
        if (!e) return null;
        const id = this.nextId++;
        // a file that is open in another tab by now stays with that tab
        const file = e.file && !this._editors.some((x) => x.docFile && normPath(x.docFile.path) === normPath(e.file.path)) ? e.file : null;
        await this.restore(JSON.stringify({ version: 2, active: id, nextId: this.nextId, docs: [{ id, state: e.state, file, plugins: e.plugins, extra: e.extra }] }));
        const ed = this.editorById(id);
        // its renders still on ComfyUI land in it again (removeEditor kept them; a picture run ended with the tab)
        const runs = this._closedRuns.get(String(e.id)) || [];
        this._closedRuns.delete(String(e.id));
        if (ed) for (const run of runs) {
            if (!this._closedPrompts.has(run.id) || this._pictureRuns.has(run.id) || this._endedPictureRuns.has(run.id)) continue;
            this._closedPrompts.delete(run.id);
            (ed._localRuns || (ed._localRuns = new Set())).add(run.id);
            if (run.sent) (ed._sentTexts || (ed._sentTexts = new Map())).set(run.id, run.sent);
            this.trackRun(ed, run.id, run.nodes);
        }
        if (ed && this.shell) this.shell.activate(ed);
        if (ed && ed.base) ed.setStatus(`Reopened ${e.name}.`);
        this.saveAll();
        return ed || null;
    },
};
