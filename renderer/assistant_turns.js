// "Undo this turn" (docs/PLAN_ASSISTANT.md §4 A7): the snapshots of the documents one assistant
// turn changed, kept in the window.
//
// The loop sends `meta.turn` with every call that is not a read. Right before the command runs -
// after the user-activity wait and the busy check, with no await in between - the shell asks
// `beforeCall()` here, which takes that document's `turnSnapshot()` **when this turn has none for
// it yet**. So a turn's snapshot of a document is its state just before the turn's first change
// there, even when the model switched tabs or passed `doc` for another one.
//
// Only the last turn that changed something is kept: a new turn's first change releases the one
// before it. Nothing here holds an editor - the snapshots are keyed by document id, and the
// editor is looked up again when the restore runs, so a closed tab cannot be brought back to
// life by a snapshot.
import { host } from "./editor/host.js";
import { editorOf } from "./assistant_wait.js";

let record = null;         // { turn, docs: Map<docId, {snap, edited}>, at }

/** The editor of a document id, or null when that tab is gone. */
function editor(docId) {
    return editorOf(docId);
}

/** Release every snapshot a record holds; a released step's tiles go back to the arena. */
function release(rec) {
    if (!rec) return;
    for (const [docId, entry] of rec.docs) {
        const ed = editor(docId);
        if (ed && entry.snap && typeof ed.releaseSnapshot === "function") {
            try { ed.releaseSnapshot(entry.snap); } catch (_) { /* a release must never throw here */ }
        }
        entry.snap = null;
    }
    rec.docs.clear();
}

/**
 * Called by the shell's bridge handler before an assistant call that changes something.
 * Answers what it did, for the gate: "taken", "kept" (this turn already has one) or the reason
 * it took none.
 */
export function beforeCall(meta, docId) {
    if (!meta || !meta.turn) return "no turn";
    const ed = editor(docId);
    if (!ed) return "no document";
    const id = ed.node && ed.node.id;
    if (record && record.turn !== meta.turn) { release(record); record = null; }
    if (!record) record = { turn: meta.turn, docs: new Map(), at: Date.now() };
    if (record.docs.has(id)) return "kept";
    if (typeof ed.turnSnapshot !== "function") return "no snapshot";
    const snap = ed.turnSnapshot();
    if (!snap) return "canvas backend";                 // a full copy per layer is not taken there
    record.docs.set(id, { snap, edited: false });
    return "taken";
}

/** What the panel needs to offer the button: the turn, its documents, and whether the user edited. */
export function turnState() {
    if (!record || !record.docs.size) return null;
    const docs = [...record.docs.keys()];
    return {
        turn: record.turn,
        docs,
        edited: docs.filter((id) => record.docs.get(id).edited),
        open: docs.filter((id) => !!editor(id)),
        at: record.at,
    };
}

/**
 * Put every document of the turn back. Each restore pushes the present state as one `turn` undo
 * step first, so Ctrl+Z takes the restore back and redo does it again.
 */
export function restoreTurn() {
    const state = turnState();
    if (!state) return { ok: false, reason: "nothing to undo" };
    const done = [];
    const missing = [];
    for (const [docId, entry] of record.docs) {
        const ed = editor(docId);
        if (!ed || !entry.snap) { missing.push(docId); continue; }
        try {
            if (ed.restoreTurn(entry.snap)) done.push(docId);
            else missing.push(docId);
        } catch (err) {
            console.warn("assistant: a turn could not be restored", err);
            missing.push(docId);
        }
        entry.snap = null;                     // the restore took the clones out of the step
    }
    const turn = record.turn;
    record.docs.clear();
    record = null;
    return { ok: !!done.length, turn, docs: done, missing };
}

/** The reset and a closing window drop what they hold. */
export function forgetTurns() {
    release(record);
    record = null;
}

/** A document that closes takes its snapshot with it. */
export function forgetDocument(docId) {
    if (!record || !record.docs.has(docId)) return;
    const ed = editor(docId);
    const entry = record.docs.get(docId);
    if (ed && entry.snap && typeof ed.releaseSnapshot === "function") {
        try { ed.releaseSnapshot(entry.snap); } catch (_) { /* going anyway */ }
    }
    record.docs.delete(docId);
    if (!record.docs.size) record = null;
}

/**
 * The user's own edits while a turn is open: a trusted pointer, key or input event inside an
 * editor's root. The assistant's own calls are synthetic, so they never set it. The button asks
 * before it discards work that is not the assistant's.
 */
export function watchUserEdits() {
    const mark = (e) => {
        if (!record || !e.isTrusted) return;
        for (const ed of host.editors()) {
            const id = ed.node && ed.node.id;
            if (!record.docs.has(id)) continue;
            if (ed.root && ed.root.contains(e.target)) { record.docs.get(id).edited = true; return; }
        }
    };
    for (const type of ["pointerdown", "keydown", "input"]) document.addEventListener(type, mark, true);
}
