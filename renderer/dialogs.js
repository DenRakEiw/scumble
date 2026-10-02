// The app's own questions (CLAUDE.md item 25): a modal dialog in the window instead of the native message box or
// window.confirm. It reads the skin's colours (the --sc-* tokens inherit into it) but no skin reaches its structure:
// its parts sit in a shadow root that no selector of a skin matches, the <dialog> around them is in the window's top
// layer while it is open (nothing a stylesheet does is painted over it), and the dialog's own box is pinned by inline
// !important values, which beat a skin's !important rules. So a skin can recolour a question but not hide it, fade it,
// move it out of the window or reorder its buttons (docs/SKINS.md §5).
//
// ask() is also how main asks (main.js askWindow over dialog:ask / dialog:shown / dialog:answer): a question it asks
// while the window does not answer at once (a busy or hung renderer) falls back to the native box. The file pickers
// and the crash dialog stay native.

/** The dialog's own box: inline and !important, so no rule of a skin overrides it. `all: initial` first. */
const BOX = [
    "all: initial", "position: fixed", "inset: 0", "margin: auto", "padding: 0", "border: 0", "background: transparent",
    "display: block", "visibility: visible", "opacity: 1", "transform: none", "filter: none", "zoom: 1",
    "clip-path: none", "mask: none", "width: fit-content", "height: fit-content", "max-width: calc(100vw - 32px)",
    "max-height: calc(100vh - 32px)", "overflow: visible", "pointer-events: auto", "direction: ltr", "outline: none",
].map((d) => d + " !important").join("; ");

const CSS = `
:host {
    all: initial !important; display: block !important; direction: ltr !important; unicode-bidi: isolate !important;
    visibility: visible !important; opacity: 1 !important; transform: none !important;
}
.box {
    box-sizing: border-box; min-width: 320px; max-width: 520px; max-height: calc(100vh - 32px); overflow: auto;
    display: flex; flex-direction: column; gap: 10px; padding: 16px;
    background: var(--sc-surface, #242424); color: var(--sc-fg, #ddd);
    border: 1px solid var(--sc-border, #4a4a4a); border-radius: var(--sc-radius-lg, 10px);
    box-shadow: var(--sc-shadow, 0 12px 40px rgba(0,0,0,.6));
    font: 13px/1.45 var(--sc-font, system-ui, sans-serif); color-scheme: var(--sc-scheme, normal);
}
.title { font-weight: 600; font-size: 14px; color: var(--sc-fg-strong, #eee); overflow-wrap: anywhere; }
.message { white-space: pre-line; overflow-wrap: anywhere; }
.detail { color: var(--sc-fg-2, #aaa); white-space: pre-line; overflow-wrap: anywhere; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 4px; }
button {
    font: inherit; color: var(--sc-fg, #ddd); background: var(--sc-btn, #2d2d2d);
    border: 1px solid var(--sc-border, #555); border-radius: var(--sc-radius, 3px); padding: 5px 14px; cursor: pointer;
    min-width: 72px;
}
button:hover { background: var(--sc-btn-hover, #3a3a3a); }
button:focus-visible { outline: 2px solid var(--sc-active, #4a90d9); outline-offset: 1px; }
button.primary { background: var(--sc-go, #2f6b3f); color: var(--sc-on-active, #fff); border-color: transparent; }
button.danger { border-color: var(--sc-error, #e0533d); }
button.danger:hover { background: var(--sc-error-bg, #3a1f1c); }
`;

let sheet = null;
const open = new Set();        // the dialogs on screen: { dialog, finish }

/**
 * Ask in a modal dialog of the app. `buttons` are labels, left to right; `defaultId` has the focus and Enter answers
 * it (`primary` draws it as the main action unless `danger` names it), `cancelId` is the answer of Escape. `danger`:
 * the index of a button that loses something (drawn as such). `focusId`: another button to take the focus (a
 * question that opens unasked, while the user may be typing, puts it on the harmless answer; Enter answers the
 * focused button). Resolves with the index of the button pressed.
 * `signal` (an AbortSignal) closes the dialog with `cancelId` (main took the question back).
 */
export function ask({ title = "", message = "", detail = "", buttons = ["OK", "Cancel"], defaultId = 0, cancelId = null, danger = -1, primary = true, focusId = null, signal = null } = {}) {
    const labels = (Array.isArray(buttons) && buttons.length ? buttons : ["OK"]).map((b) => String(b));
    const cancel = cancelId != null && cancelId >= 0 && cancelId < labels.length ? cancelId : labels.length - 1;
    const def = defaultId >= 0 && defaultId < labels.length ? defaultId : 0;
    return new Promise((resolve) => {
        const dialog = document.createElement("dialog");
        dialog.className = "sc-dialog";
        dialog.setAttribute("style", BOX);
        dialog.setAttribute("aria-label", title || message);
        const host = document.createElement("div");
        dialog.appendChild(host);
        const root = host.attachShadow({ mode: "open" });
        if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); }
        root.adoptedStyleSheets = [sheet];
        const box = document.createElement("div");
        box.className = "box";
        box.setAttribute("role", "alertdialog");
        const add = (cls, text) => { if (!text) return; const n = document.createElement("div"); n.className = cls; n.textContent = String(text); box.appendChild(n); };
        add("title", title);
        add("message", message);
        add("detail", detail);
        const row = document.createElement("div");
        row.className = "row";
        const els = labels.map((label, i) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = label;
            if (i === danger) b.className = "danger";
            else if (i === def && primary && i !== cancel) b.className = "primary";
            b.addEventListener("click", () => finish(i));
            row.appendChild(b);
            return b;
        });
        box.appendChild(row);
        root.appendChild(box);

        let done = false;
        const entry = { dialog, finish: (i) => finish(i) };
        function finish(i) {
            if (done) return;
            done = true;
            open.delete(entry);
            if (signal) signal.removeEventListener("abort", onAbort);
            try { dialog.close(); } catch (_) { /* gone already */ }
            dialog.remove();
            resolve(i);
        }
        // Escape cancels, Enter answers the focused button (the default one at first); no key goes on to the window
        // (the editor, Help and the assistant leave a key inside an open <dialog> alone anyway). Chromium fires `cancel`
        // for a real Escape on a modal <dialog> and may skip `close`
        const onKey = (e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); finish(cancel); return; }
            if (e.key === "Enter") {
                e.preventDefault(); e.stopImmediatePropagation();
                const f = els.indexOf(root.activeElement);
                finish(f >= 0 ? f : def);
                return;
            }
            if (e.key === "Tab") return;          // moves between the buttons (the modal dialog keeps the focus inside)
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                const f = els.indexOf(root.activeElement);
                const n = (f < 0 ? def : f) + (e.key === "ArrowRight" ? 1 : -1);
                els[(n + els.length) % els.length].focus();
            }
            e.stopImmediatePropagation();
        };
        const onAbort = () => finish(cancel);
        dialog.addEventListener("cancel", (e) => { e.preventDefault(); finish(cancel); });
        if (signal) {
            if (signal.aborted) { resolve(cancel); return; }
            signal.addEventListener("abort", onAbort, { once: true });
        }
        dialog.addEventListener("keydown", onKey, true);
        document.body.appendChild(dialog);
        open.add(entry);
        try { dialog.showModal(); } catch (_) { dialog.setAttribute("open", ""); }
        els[focusId != null && focusId >= 0 && focusId < els.length ? focusId : def].focus();
    });
}

/** A yes / no question: resolves true for `ok`. `danger`: the yes loses something (deletes, closes a working tab). */
export async function confirm(message, { title = "", detail = "", ok = "OK", cancel = "Cancel", danger = false } = {}) {
    const i = await ask({ title, message, detail, buttons: [ok, cancel], defaultId: danger ? 1 : 0, cancelId: 1, danger: danger ? 0 : -1 });
    return i === 0;
}

/** How many of the app's questions are open (tests, and main's check whether the window is asking). */
export function openCount() {
    return open.size;
}

/** Answer every open question with its cancel button (a test, a page that goes away). */
export function cancelAll() {
    for (const e of Array.from(open)) e.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
}

/**
 * Main's questions (askWindow in main.js): it sends { id, spec } on dialog:ask; the window says it shows the question
 * at once (dialog:shown, so main knows it answers) and sends the index later (dialog:answer). dialog:dismiss takes a
 * question back (main asked natively after all).
 */
export function listen(api) {
    if (!api || !api.onAsk) return;
    const pending = new Map();
    api.onAsk(({ id, spec }) => {
        const ac = new AbortController();
        pending.set(id, ac);
        api.shown(id);
        ask({ ...(spec || {}), signal: ac.signal }).then((i) => {
            pending.delete(id);
            if (!ac.signal.aborted) api.answer(id, i);
        });
    });
    api.onDismiss((id) => { const ac = pending.get(id); if (ac) ac.abort(); });
}
