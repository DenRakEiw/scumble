// The user-activity wait for the in-app assistant's requests (docs/PLAN_ASSISTANT.md §2 row 20,
// §4 A4). A request that carries `meta.wait` is held while the user is in the middle of an edit
// on the document it targets: a stroke or another editing drag, a pending transform, a text edit,
// a polygon or shape in progress, or an open question. It waits in 100 ms `setTimeout` steps
// (never rAF: a hidden window draws nothing) for up to 20 s and then refuses, so a call never
// lands inside the user's stroke; a "soft" wait (`screenshot`) runs after the 20 s anyway, and is
// never refused. `set_prompt` and `generate_new` also wait while the user types in that
// document's prompt (a focused but idle field does not hold them).
//
// The fields read here are editor internals that nothing guards (`gestureHeld`, `pending`,
// `textEdit`, `polyPoints`, `shapePoints`, `askOpen`, `promptInput`); a rename turns the gate step
// `the_agent_waits_for_the_users_stroke` red. External agents' requests carry no `meta` and never
// come through here.
import { host } from "./editor/host.js";

const STEP_MS = 100;
const MAX_MS = 20000;
const TYPING_MS = 2000;

// The last input event anywhere in the document: what "the user is typing" is read from. The
// field is held as a WeakRef: a strong one would keep the last edited element, and through its
// own listeners the whole editor of a closed tab, alive for as long as nobody types again.
let lastInput = { target: null, time: 0 };
document.addEventListener("input", (e) => { lastInput = { target: e.target ? new WeakRef(e.target) : null, time: Date.now() }; }, true);

/**
 * The editor a request targets: by `doc` through the host's list, else the active one. A `doc`
 * that is not open answers null - the wait must never judge another document than the call's,
 * and the command itself answers "no document with id ...".
 */
export function editorOf(doc) {
    if (doc !== undefined && doc !== null && doc !== "") {
        return (typeof host.editorById === "function" ? host.editorById(doc) : host.editors().find((e) => String(e.node.id) === String(doc))) || null;
    }
    return host.editor || null;
}

/** What the user is in the middle of on this document, in words, or null. */
export function userBusy(ed) {
    if (!ed) return null;
    if (typeof ed.gestureHeld === "function" && ed.gestureHeld()) return "a stroke or a drag";
    if (ed.pending) return "a transform";
    if (ed.textEdit) return "a text edit";
    if (ed.polyPoints) return "a polygon";
    if (ed.shapePoints) return "a shape";
    if (ed.askOpen) return "a question";
    return null;
}

function typingPrompt(ed) {
    const field = ed && ed.promptInput;
    const typed = lastInput.target && lastInput.target.deref();
    return !!(field && document.activeElement === field && typed === field && Date.now() - lastInput.time < TYPING_MS);
}

/**
 * Wait until the user is done, or give up: resolves null when the call may run, else the
 * refusal. `mode` is `true` (a normal wait) or `"soft"` (run after the limit anyway); `cancelled`
 * says whether the request was cancelled while it waited (the turn's Stop).
 */
export async function waitForUser(doc, name, mode, cancelled) {
    // `upsample_prompt` reads the prompt and writes the upsampled text back into the same field
    const typing = name === "set_prompt" || name === "generate_new" || name === "upsample_prompt";
    const t0 = Date.now();
    for (;;) {
        if (cancelled && cancelled()) return "cancelled before it ran";
        // looked up again every round: a document closed while the call waited is not waited for
        const ed = editorOf(doc);
        if (!ed) return null;
        const why = userBusy(ed) || (typing && typingPrompt(ed) ? "typing in the prompt" : null);
        if (!why) return null;
        if (Date.now() - t0 >= MAX_MS) {
            if (mode === "soft") return null;
            return `the user is in the middle of an edit (${why}) on document ${ed.node.id}; nothing was run`;
        }
        await new Promise((r) => setTimeout(r, STEP_MS));
    }
}
