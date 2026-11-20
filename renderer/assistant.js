// The assistant's panel (docs/PLAN_ASSISTANT.md §4 A5): a collapsible column right of the
// editor. The loop itself lives in the main process (electron/main/assistant/); this file only
// shows what it reports and sends what the user types.
//
// Three things about it are not decoration:
//
// - It is a `<dialog>` shown with `show()`, never `showModal()`: the canvas stays usable and the
//   panel stays out of the top layer. assistant.css talks it out of the UA sheet.
// - **One window capture `keydown` listener** handles every key whose target is inside the
//   panel, and calls `stopImmediatePropagation()` so neither the editor's `_docKey` nor an open
//   editor question (which listens on `window`, inpaint_canvas.js) sees a chat key. It is
//   registered at shell start, before any question's listener, so it runs first, and it calls
//   `preventDefault()` only for the keys it consumes: Shift+Enter still writes a newline, a
//   composing Enter still commits the IME, Tab still moves the focus.
// - **Nothing here writes markup.** Every model answer is built with `createElement` and
//   `textContent` (`renderText`), so a picture's text, a layer name or a log line can never
//   become HTML. `no_markup_writes` in tools/assistant_test.js holds this file to it.
import { host } from "./editor/host.js";
import { turnState, restoreTurn, forgetTurns } from "./assistant_turns.js";
import { protectAsk, releaseAsk } from "./skins.js";
import { confirm } from "./dialogs.js";

const OPEN_KEY = "shell.assistant.open";
const THUMB_MAX = 240;

const ui = {};
let deps = {};
let started = false;
let busy = false;
let openAsk = null;          // the token of the ask card that is waiting
let continueRow = null;      // the Continue button under the last step-limit note
let approveAll = false;      // "Approve everything" of this chat, as main holds it (item 75)
let autoRuns = 30;           // the paid or queued runs it lets one turn start
let streamBubble = null;     // the bubble the model's text streams into
let streamText = null;       // its text node
let cards = new Map();       // call id -> its card, for this turn only: ids repeat across turns
let picker = null;           // the groups of assistant:models
let usage = null;            // the running total of the chat
let lastTurnCost = 0;
let handedOff = false;       // Escape gave the focus to the editor on purpose
let lastOutsidePointer = 0;
let lastTab = 0;
let focusBefore = null;
let agents = 0;
let noticeProvider = null;   // the provider whose privacy notice the panel shows, until the first send to it

const api = () => (window.scumble && window.scumble.assistant) || null;
const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
};

// ---- markup, built by hand ------------------------------------------------------------------

/**
 * The model's text as elements: paragraphs, `-` and `1.` lists, fenced code, inline `code` and
 * `**bold**`. Everything goes through `textContent`; a URL stays text.
 */
export function renderText(text) {
    const out = document.createDocumentFragment();
    const lines = String(text == null ? "" : text).split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (/^\s*```/.test(line)) {                       // a fenced block, to its fence or the end
            const body = [];
            i++;
            while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i++; }
            if (i < lines.length) i++;
            const pre = el("pre");
            pre.appendChild(el("code", null, body.join("\n")));
            out.appendChild(pre);
            continue;
        }
        if (/^\s*([-*]|\d+\.)\s+/.test(line)) {           // a list, until a line that is not one
            const ordered = /^\s*\d+\./.test(line);
            const list = el(ordered ? "ol" : "ul");
            while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
                const item = el("li");
                item.appendChild(inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, "")));
                list.appendChild(item);
                i++;
            }
            out.appendChild(list);
            continue;
        }
        if (!line.trim()) { i++; continue; }
        const para = [];                                   // a paragraph, to the next empty line
        while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
            para.push(lines[i]);
            i++;
        }
        const p = el("p");
        p.appendChild(inline(para.join("\n")));
        out.appendChild(p);
    }
    return out;
}

/**
 * `code`, `**bold**` and `*em*` inside one paragraph or list item; a `*` with a space after it
 * ("5 * 3") opens nothing.
 */
function inline(text) {
    const out = document.createDocumentFragment();
    const re = /`([^`]+)`|\*\*([^*]+)\*\*|(?<!\*)\*(?![\s*])([^*]*[^\s*])\*(?!\*)/g;
    let at = 0;
    let m;
    while ((m = re.exec(text))) {
        if (m.index > at) out.appendChild(document.createTextNode(text.slice(at, m.index)));
        if (m[1] !== undefined) out.appendChild(el("code", null, m[1]));
        else if (m[2] !== undefined) out.appendChild(el("strong", null, m[2]));
        else out.appendChild(el("em", null, m[3]));
        at = m.index + m[0].length;
    }
    if (at < text.length) out.appendChild(document.createTextNode(text.slice(at)));
    return out;
}

// ---- the panel ------------------------------------------------------------------------------

/** Build the panel once, wire its keys and events, and show it when the user left it open. */
export function initAssistant(options = {}) {
    if (started) return;
    deps = options || {};
    const dialog = document.getElementById("assistant");
    if (!dialog || !api()) return;
    started = true;
    ui.dialog = dialog;

    // header
    const head = el("div", "as-head");
    ui.model = el("select");
    ui.model.title = "The provider and the model of this chat. Changing it starts a new chat.";
    ui.newChat = el("button", null, "New chat");
    ui.newChat.type = "button";
    ui.newChat.title = "Forget this chat and start over";
    ui.chats = el("button", null, "Chats");
    ui.chats.type = "button";
    ui.chats.title = "The chats on disk";
    ui.close = el("button", null, "×");
    ui.close.type = "button";
    ui.close.title = "Close the assistant (Ctrl+Shift+A)";
    const row = el("div", "as-head-row");
    row.appendChild(ui.model);
    row.appendChild(ui.chats);
    row.appendChild(ui.newChat);
    row.appendChild(ui.close);
    head.appendChild(row);
    ui.chatList = el("div", "as-chats");
    ui.chatList.hidden = true;
    head.appendChild(ui.chatList);
    ui.free = el("div", "as-free");
    ui.freeId = el("input");
    ui.freeId.type = "text";
    ui.freeId.placeholder = "a model id from OpenRouter's list";
    ui.freeId.setAttribute("list", "as-or-models");
    ui.freeList = el("datalist");
    ui.freeList.id = "as-or-models";
    ui.freeUse = el("button", null, "Use");
    ui.freeUse.type = "button";
    ui.free.appendChild(ui.freeId);
    ui.free.appendChild(ui.freeUse);
    ui.free.appendChild(ui.freeList);
    ui.free.hidden = true;
    head.appendChild(ui.free);
    ui.notice = el("div", "as-note");
    head.appendChild(ui.notice);
    dialog.appendChild(head);

    // the chat
    ui.list = el("div", "as-list");
    ui.list.setAttribute("role", "log");
    ui.list.setAttribute("aria-live", "polite");
    dialog.appendChild(ui.list);

    // footer
    const foot = el("div", "as-foot");
    // the saved task texts (item 76): a list over the field, filled when it opens
    ui.tplList = el("div", "as-chats as-templates");
    ui.tplList.hidden = true;
    foot.appendChild(ui.tplList);
    ui.text = el("textarea");
    ui.text.rows = 3;
    ui.text.spellcheck = false;
    ui.text.placeholder = "Ask the assistant — Enter sends, Shift+Enter is a new line";
    foot.appendChild(ui.text);
    const frow = el("div", "as-foot-row");
    ui.cost = el("span", "as-cost", "");
    ui.send = el("button", null, "Send");
    ui.send.type = "button";
    ui.approve = el("button", "as-approve", "Approve everything");
    ui.approve.type = "button";
    ui.approve.setAttribute("aria-pressed", "false");
    ui.tpl = el("button", "as-tpl", "Templates");
    ui.tpl.type = "button";
    ui.tpl.title = "Saved task texts: put one into the field, or save the text in the field as one";
    // Send stays the first button of the footer (the tests find it that way); assistant.css draws the others left of it
    frow.appendChild(ui.cost);
    frow.appendChild(ui.send);
    frow.appendChild(ui.tpl);
    frow.appendChild(ui.approve);
    foot.appendChild(frow);
    dialog.appendChild(foot);

    // ---- events of the loop
    api().onEvent((e) => onEvent(e));

    // ---- the panel's own
    ui.close.addEventListener("click", () => toggleAssistant(false));
    ui.newChat.addEventListener("click", () => newChat());
    ui.chats.addEventListener("click", () => toggleChats());
    ui.send.addEventListener("click", () => (busy ? stop() : send()));
    ui.approve.addEventListener("click", () => toggleApprove());
    ui.tpl.addEventListener("click", () => toggleTemplates());
    ui.model.addEventListener("change", () => pickModel(ui.model.value));
    ui.freeUse.addEventListener("click", () => pickModel("openrouter:" + ui.freeId.value.trim()));
    ui.text.addEventListener("focus", () => { handedOff = false; });
    ui.text.addEventListener("input", () => { handedOff = false; });
    ui.text.addEventListener("focusout", (e) => onFocusOut(e));
    dialog.addEventListener("close", () => { store(false); syncButton(); });
    for (const type of ["dragover", "drop"]) {
        dialog.addEventListener(type, (e) => {
            e.preventDefault();
            if (type === "drop") note("drop images on the canvas; the chat takes text only");
        });
    }
    // a pointerdown outside the panel means the user went somewhere else on purpose
    window.addEventListener("pointerdown", (e) => { if (!dialog.contains(e.target)) lastOutsidePointer = Date.now(); }, true);
    window.addEventListener("keydown", onKey, true);

    refresh().catch(() => { /* the picker fills at the next open */ });
    if (read()) open(true);
    syncButton();
}

/** Open or close the column; `undefined` toggles. */
export function toggleAssistant(on) {
    if (!started) return false;
    const want = on === undefined ? !ui.dialog.open : !!on;
    open(want);
    store(want);
    // an ask opens the column in the canvas-only view too, under the picture: the keys stay with the picture there
    // (show() has put the focus on the column itself)
    if (want) { refresh().catch(() => {}); if (covered()) focusEditor(); else ui.text.focus(); }
    syncButton();
    return want;
}

/** The canvas-only view (renderer/shell.js canvasOnly) covers the column: its question still shows, its field does not. */
function covered() {
    return document.body.classList.contains("shell-canvas-only");
}

/**
 * Read the picker again: called by the settings dialog when the user's own model list changes
 * (the groups are cached for the session, so a new row would not show otherwise).
 */
export function refreshAssistantModels() {
    picker = null;
    if (started && ui.dialog.open) refresh().catch(() => { /* the picker fills at the next open */ });
}

export function assistantOpen() {
    return !!(started && ui.dialog.open);
}

/**
 * Whether a turn runs, whether a card waits for the user's answer, and how many external agents are connected
 * (shell.js asks before an update restarts the app, and its update question waits while a card asks).
 */
export function assistantActivity() {
    return { busy, asking: !!openAsk, agents };
}

function open(on) {
    if (on && !ui.dialog.open) {
        focusBefore = document.activeElement;
        ui.dialog.show();
    } else if (!on && ui.dialog.open) {
        ui.dialog.close();
        if (focusBefore && document.contains(focusBefore) && !ui.dialog.contains(focusBefore)) focusBefore.focus();
        focusBefore = null;
    }
    // the editors refit to the narrower host by their own ResizeObserver
}

function read() {
    try { return localStorage.getItem(OPEN_KEY) === "1"; } catch (_) { return false; }
}

function store(on) {
    try { if (on) localStorage.setItem(OPEN_KEY, "1"); else localStorage.removeItem(OPEN_KEY); } catch (_) { /* a convenience only */ }
}

/** The bar button says what the assistant is doing. */
function syncButton() {
    const b = document.getElementById("shell-assistant");
    if (!b) return;
    b.textContent = openAsk ? "Assistant · waits for you" : (busy ? "Assistant · working" : "Assistant");
    b.classList.toggle("as-on", assistantOpen());
}

// ---- keys -----------------------------------------------------------------------------------

function onKey(e) {
    if (!started || !ui.dialog.open || !ui.dialog.contains(e.target)) return;
    if (e.key === "Enter" && !e.isComposing && ui.tplName && e.target === ui.tplName) {
        e.preventDefault();
        e.stopImmediatePropagation();
        saveTemplate(ui.tplName.value, ui.text.value);
        return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target === ui.text) {
        e.preventDefault();
        e.stopImmediatePropagation();
        send();
        return;
    }
    if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (busy) stop();
        else focusEditor();
        return;
    }
    // every other key inside the panel belongs to the panel: neither the editor's key handler
    // nor an open editor question may see it. The default action stands (Tab, Shift+Enter, IME).
    e.stopImmediatePropagation();
    if (e.key === "Tab") lastTab = Date.now();
    else handedOff = false;                    // the user is writing here again
}

function focusEditor() {
    handedOff = true;                  // the user asked to leave; the guard must not pull it back
    const ed = host.editor;
    if (ed && ed.root && typeof ed.root.focus === "function") ed.root.focus();
}

/**
 * The editor takes the focus back for its own reasons (`generate()` focuses the root,
 * `add_text` blurs): while the user is writing, the textarea takes it back - unless the user
 * clicked or tabbed somewhere themselves.
 */
function onFocusOut(e) {
    // The editor takes the focus back for its own reasons (`generate()` focuses its root at the
    // end of a run, `add_text` blurs): while the panel is open and the user was writing, the
    // textarea takes it back. Not when the user went somewhere themselves - a click or a Tab in
    // the last 500 ms, an Escape (`handedOff`) - and not when the new target wants the focus for
    // typing, which is what the editor's own question does the moment it opens. Nor under the canvas-only view, which
    // takes the focus to the picture on purpose.
    if (handedOff || !ui.dialog.open || covered()) return;
    const to = e.relatedTarget;
    if (to && ui.dialog.contains(to)) return;
    if (wants(to)) return;
    const now = Date.now();
    if (now - lastOutsidePointer < 500 || now - lastTab < 500) return;
    setTimeout(() => {
        if (handedOff || !ui.dialog.open || covered()) return;
        const active = document.activeElement;
        if (active && ui.dialog.contains(active)) return;
        if (wants(active)) return;
        if (host.editor && host.editor.askOpen) return;                         // the editor is asking
        if (Date.now() - lastOutsidePointer < 500 || Date.now() - lastTab < 500) return;
        ui.text.focus();
    }, 0);
}

/**
 * Does this element want the focus for itself? The guard exists for the two places the editor
 * takes the focus back on its own (`generate()` focuses its root, `add_text` blurs), and those
 * are not form controls. A question's button or field is, and the user has to reach it.
 */
function wants(node) {
    if (!node || node === document.body) return false;
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(node.tagName) || node.isContentEditable) return true;   // the prompt field is a contenteditable
    return !!(node.closest && node.closest(".ipc-ask"));
}

// ---- the chat ---------------------------------------------------------------------------

function atBottom() {
    return ui.list.scrollHeight - ui.list.scrollTop - ui.list.clientHeight < 40;
}

function add(node) {
    const bottom = atBottom();
    ui.list.appendChild(node);
    if (bottom) ui.list.scrollTop = ui.list.scrollHeight;
    return node;
}

function note(text, kind) {
    const card = el("div", "as-card as-note" + (kind ? " " + kind : ""));
    card.appendChild(el("div", null, text));
    return add(card);
}

function bubble(kind, text) {
    const node = el("div", "as-bubble " + kind);
    if (text !== undefined) node.appendChild(renderText(text));
    return add(node);
}

const short = (v, n = 200) => {
    const s = typeof v === "string" ? v : JSON.stringify(v == null ? null : v);
    return s && s.length > n ? s.slice(0, n) + " …" : s || "";
};

function argsOf(args) {
    const a = { ...(args || {}) };
    delete a.doc;
    const s = JSON.stringify(a);
    return s === "{}" ? "" : s;
}

function toolCard(e) {
    const card = el("div", "as-card");
    card.dataset.call = e.call;
    const head = el("div", "as-card-head");
    head.appendChild(el("span", "as-card-name", e.name));
    const state = el("span", "as-card-state", e.action === "refuse" ? "refused" : "running …");
    head.appendChild(state);
    card.appendChild(head);
    const args = argsOf(e.args);
    if (args) card.appendChild(el("div", "as-card-args", short(args, 200)));
    // a call "Approve everything" let through says what its question would have said
    if (e.action === "approved") {
        card.classList.add("as-approved");
        card.appendChild(el("div", "as-reason", "approved without asking" + (e.reason ? ": " + e.reason : "")));
        for (const line of cardLines(e)) card.appendChild(el("div", "as-note", line));
    } else if (e.reason) card.appendChild(el("div", "as-reason", e.reason));
    if (e.action === "refuse") card.classList.add("as-bad");
    cards.set(String(e.call), card);
    return add(card);
}

function endCard(e) {
    const card = cards.get(String(e.call));
    if (!card) return;
    const state = card.querySelector(".as-card-state");
    if (state) state.textContent = e.ok ? `done in ${(e.ms / 1000).toFixed(1)} s` : `error after ${(e.ms / 1000).toFixed(1)} s`;
    if (!e.ok) card.classList.add("as-bad");
    if (e.text) {
        const d = el("details");
        d.appendChild(el("summary", null, "result"));
        d.appendChild(el("pre", null, e.text));
        card.appendChild(d);
    }
    if (e.image) {
        const img = el("img");
        img.src = e.image;
        img.width = THUMB_MAX;
        img.alt = "screenshot";
        card.appendChild(img);
    }
}

function askCard(e) {
    closeAsks();
    const token = String((e && (e.token || e.call)) || "");
    openAsk = token;
    const card = el("div", "as-card as-ask");
    card.dataset.ask = token;
    const head = el("div", "as-card-head");
    head.appendChild(el("span", "as-card-name", e.name));
    head.appendChild(el("span", "as-card-state", "waiting for you"));
    card.appendChild(head);
    const args = argsOf(e.args);
    if (args) card.appendChild(el("div", "as-card-args", short(args, 200)));
    if (e.reason) card.appendChild(el("div", "as-reason", e.reason));
    for (const line of cardLines(e)) card.appendChild(el("div", "as-note", line));
    const buttons = el("div", "as-card-buttons");
    const allow = el("button", null, "Allow");
    allow.type = "button";
    const deny = el("button", null, "Don't");
    deny.type = "button";
    allow.addEventListener("click", () => answer(token, true, card, "allowed"));
    deny.addEventListener("click", () => answer(token, false, card, "declined"));
    buttons.appendChild(allow);
    buttons.appendChild(deny);
    card.appendChild(buttons);
    add(card);
    if (!ui.dialog.open) toggleAssistant(true);        // an ask opens the panel
    syncButton();
    protectAsk(card);                                   // drawn out of any skin's reach, and checked (docs/SKINS.md §5)
    return card;
}

/** What the card says beyond the policy's reason: the file, the recipe, the settings. */
function cardLines(e) {
    const c = e.card || {};
    const lines = [];
    if (c.path) lines.push(`${c.path}${c.exists ? " — exists, will be overwritten" : " — a new file"}`);
    if (c.recipe) lines.push(`recipe: ${c.recipe}${c.mode ? " (" + c.mode + ")" : ""}`);
    else if (e.name === "generate" || e.name === "generate_new" || e.name === "upscale") {
        const r = host.recipe;
        if (r) lines.push(`recipe: ${r.name || r.id}${r.mode ? " (" + r.mode + ")" : ""}`);
    }
    if (Array.isArray(c.changes)) {
        for (const ch of c.changes) lines.push(`${ch.field}: ${short(ch.from, 40)} → ${short(ch.to, 40)}`);
    }
    if (c.settings && typeof c.settings === "object") {
        const changed = new Set(c.changedByChat || []);
        for (const [k, v] of Object.entries(c.settings)) lines.push(`${k}: ${short(v, 40)}${changed.has(k) ? " (this chat set it)" : ""}`);
    }
    if (c.queue && typeof c.queue === "object") lines.push(`your queue: ${c.queue.running || 0} running, ${c.queue.pending || 0} waiting`);
    return lines;
}

function closeAsk(card, word = "not answered") {
    if (!card) return;
    const parts = card.shadowRoot || card;                 // skins.js protectAsk moved them into the card's shadow root
    const buttons = Array.from(parts.querySelectorAll("button"));
    if (buttons.some((b) => !b.disabled)) {
        for (const b of buttons) b.disabled = true;
        const state = parts.querySelector(".as-card-state");
        if (state) state.textContent = word;
    }
    releaseAsk(card);
}

function closeAsks(word = "not answered") {
    openAsk = null;
    if (!ui.list) return;
    for (const c of ui.list.querySelectorAll(".as-card.as-ask")) closeAsk(c, word);
}

function answer(token, allow, card, word) {
    if (!token || openAsk !== token) {
        closeAsk(card);
        syncButton();
        return;
    }
    openAsk = null;
    closeAsk(card, word);
    api().answer(token, allow).then((ok) => {
        if (ok === false) {
            const parts = card.shadowRoot || card;
            const state = parts.querySelector(".as-card-state");
            if (state) state.textContent = "not answered";
        }
    }).catch(() => {});
    syncButton();
}

// ---- events ---------------------------------------------------------------------------------

function onEvent(e) {
    if (!started || !e) return;
    switch (e.type) {
        case "user":
            dropContinue();
            endStream();
            bubble("as-user", e.text);
            break;
        case "turn:start":
            cards = new Map();
            lastTurnCost = 0;                              // "last turn" is this turn's, not the session's
            busy = true;
            ui.send.textContent = "Stop";
            syncButton();
            break;
        case "text_delta":
            if (!streamBubble) {
                streamBubble = bubble("as-model");
                streamText = document.createTextNode("");
                streamBubble.appendChild(streamText);
            }
            streamText.appendData(e.text);
            if (atBottom()) ui.list.scrollTop = ui.list.scrollHeight;
            break;
        case "assistant:text":
            if (streamBubble) {
                streamBubble.textContent = "";
                streamBubble.appendChild(renderText(e.text));
                streamBubble = null;
                streamText = null;
            } else bubble("as-model", e.text);
            break;
        case "call":
            if (e.action === "allowed") closeAsks("allowed");
            toolCard(e);
            break;
        case "tool_end":
            endCard(e);
            break;
        case "ask":
            askCard(e);
            break;
        case "usage":
            if (e.cost && e.cost.amount) lastTurnCost += e.cost.amount;
            showCost();
            break;
        case "note":
            note(e.text);
            break;
        case "turn:done":
            busy = false;
            closeAsks();                                   // no question stays clickable after a turn
            ui.send.textContent = "Send";
            endStream(e.reason === "stopped");
            if (e.reason && e.reason !== "end") {
                const card = note(doneWords(e), e.reason === "error" ? "as-bad" : "");
                if (e.reason === "cap") continueButton(card);
            }
            if (e.usage) usage = e.usage;
            showCost();
            undoCard(e.turn);
            syncButton();
            break;
        case "agents":
            agents = e.n || 0;
            showNotice();
            break;
        default:
            break;
    }
}

function doneWords(e) {
    const detail = e.detail ? ": " + e.detail : "";
    if (e.reason === "stopped") return "stopped" + detail;
    if (e.reason === "cut") return "the answer was cut off (the model's length limit)" + detail;
    if (e.reason === "cap") return "the step limit of this turn was reached" + detail + ". Continue goes on from here; the limit is in Settings › Assistant.";
    if (e.reason === "full") return "this chat is too long" + detail;
    if (e.reason === "refusal") return "the model refused" + detail;
    if (e.reason === "closed") return "the document of this turn was closed" + detail;
    return String(e.reason || "ended") + detail;
}

function endStream(stopped) {
    if (!streamBubble) return;
    if (stopped) {
        streamBubble.classList.add("as-stopped");
        streamBubble.appendChild(document.createTextNode(" (stopped)"));
    }
    streamBubble = null;
    streamText = null;
}

function showCost() {
    const parts = [];
    const u = usage || {};
    if (u.cost) parts.push(`this chat $${u.cost.toFixed(4)}`);
    if (lastTurnCost) parts.push(`last turn $${lastTurnCost.toFixed(4)}`);
    const context = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
    if (context) parts.push(`${Math.round(context / 1000)}k tokens in, ${Math.round((u.cacheRead || 0) / 1000)}k cached`);
    ui.cost.textContent = parts.join(" · ");
}

function showNotice() {
    const lines = [];
    if (ui.baseNote) lines.push(ui.baseNote);
    if (agents) lines.push(`an external agent is connected too (${agents}); both act on the same documents`);
    if (ui.pickNote) lines.push(ui.pickNote);
    ui.notice.textContent = lines.join(" · ");
    ui.notice.classList.toggle("as-warn", !!ui.baseNote || !!agents);
}

// ---- undo the whole turn (A7) ---------------------------------------------------------------

/**
 * After a turn that changed something: one card with "Undo this turn". It takes every document
 * the turn touched back to the state it had before the turn's first change there - which is more
 * than Ctrl+Z, because it covers the calls that record no undo step at all (the prompt, the
 * generation settings, the crop, the recipe's settings) and a turn of more than thirty steps.
 */
function undoCard(turn) {
    const state = turnState();
    // only the turn whose snapshot is kept: a turn that only read, a failed one, or a turn of a chat opened again has
    // none of its own (the record may still hold an earlier turn's)
    if (!state || !turn || state.turn !== turn) return;
    const card = el("div", "as-card as-undo");
    const head = el("div", "as-card-head");
    head.appendChild(el("span", "as-card-name", "this turn"));
    head.appendChild(el("span", "as-card-state", `document${state.docs.length > 1 ? "s" : ""} ${state.docs.join(", ")}`));
    card.appendChild(head);
    const button = el("button", null, "Undo this turn");
    button.type = "button";
    const row = el("div", "as-card-buttons");
    row.appendChild(button);
    card.appendChild(row);
    button.addEventListener("click", () => askThenUndo(card, button, turn));
    add(card);
}

function askThenUndo(card, button, turn) {
    const state = turnState();
    // a later turn that changed something released this one's snapshot: the card must not undo that other turn
    if (!state || state.turn !== turn) {
        button.disabled = true;
        if (!card.dataset.gone) { card.dataset.gone = "1"; card.appendChild(el("div", "as-reason", "a later turn changed the documents; this turn can no longer be taken back")); }
        return;
    }
    if (state.edited.length && !card.dataset.asked) {
        // work that is not the assistant's would go with it: the user says so first
        card.dataset.asked = "1";
        card.appendChild(el("div", "as-reason",
            `You edited document${state.edited.length > 1 ? "s" : ""} ${state.edited.join(", ")} since this turn started; undoing the turn discards those edits too.`));
        button.textContent = "Undo anyway";
        return;
    }
    const out = restoreTurn(turn);
    button.disabled = true;
    if (!out.ok) {
        card.appendChild(el("div", "as-reason", "nothing of this turn could be taken back" + (out.missing && out.missing.length ? ` (document${out.missing.length > 1 ? "s" : ""} ${out.missing.join(", ")} closed)` : "")));
        return;
    }
    button.textContent = "Turn taken back";
    if (out.missing && out.missing.length) card.appendChild(el("div", "as-reason", `document${out.missing.length > 1 ? "s" : ""} ${out.missing.join(", ")} could not be restored (closed)`));
    card.appendChild(el("div", "as-note", "Ctrl+Z takes this restore back; the steps of the turn stay on the stack below it."));
    api().turnUndone(out.turn, out.docs).catch(() => { /* the model is told at the next turn anyway */ });
}

// ---- the chats on disk (A6) -----------------------------------------------------------------

async function toggleChats() {
    if (!ui.chatList.hidden) { ui.chatList.hidden = true; return; }
    if (ui.tplList) ui.tplList.hidden = true;
    ui.chatList.textContent = "";
    ui.chatList.hidden = false;
    ui.chatList.appendChild(el("div", "as-note", "reading \u2026"));
    let rows = [];
    try { rows = await api().chats(); } catch (err) { rows = null; }
    ui.chatList.textContent = "";
    if (!rows) { ui.chatList.appendChild(el("div", "as-note", "the chats could not be read")); return; }
    if (!rows.length) { ui.chatList.appendChild(el("div", "as-note", "no chat is saved yet")); return; }
    for (const row of rows) ui.chatList.appendChild(chatRow(row));
}

function chatRow(row) {
    const node = el("div", "as-chat");
    node.dataset.chat = row.id;
    const open = el("button", "as-chat-open");
    open.type = "button";
    open.appendChild(el("div", "as-chat-title", row.title || (row.broken ? "could not be read" : "(no text)")));
    const when = row.updated ? new Date(row.updated).toLocaleString() : "";
    open.appendChild(el("div", "as-chat-note", [row.label || row.model, when, row.turns ? `${row.turns} turns` : ""].filter(Boolean).join(" \u00b7 ")));
    if (row.broken) open.disabled = true;
    else open.addEventListener("click", () => openChat(row.id));
    const del = el("button", "as-chat-del", "\u00d7");
    del.type = "button";
    del.title = "Delete this chat and its screenshots";
    del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await api().delete(row.id).catch(() => {});
        node.remove();
    });
    node.appendChild(open);
    node.appendChild(del);
    return node;
}

async function openChat(id) {
    let out;
    try {
        out = await api().open(id);
    } catch (err) {
        note(String((err && err.message) || err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ""), "as-bad");
        return;
    }
    ui.chatList.hidden = true;
    closeAsks();
    forgetTurns();                                   // the kept turn is the chat's that was open
    ui.list.textContent = "";
    cards = new Map();
    usage = null;
    lastTurnCost = 0;
    busy = false;
    openAsk = null;
    streamBubble = null;
    ui.send.textContent = "Send";
    await refresh();
    if (out.readOnly) {
        note(`this chat is open to read: ${out.reason}. Start a new chat to go on.`);
        ui.text.disabled = true;
        ui.send.disabled = true;
    } else {
        ui.text.disabled = false;
        ui.send.disabled = false;
    }
    showApprove();
}

/** Settings deleted everything the assistant stored: the panel goes back to how it started. */
export function resetAssistant() {
    if (!started) return;
    closeAsks();
    forgetTurns();
    ui.list.textContent = "";
    ui.chatList.textContent = "";
    ui.chatList.hidden = true;
    cards = new Map();
    usage = null;
    lastTurnCost = 0;
    busy = false;
    openAsk = null;
    streamBubble = null;
    picker = null;
    ui.send.textContent = "Send";
    ui.text.disabled = false;
    ui.send.disabled = false;
    approveAll = false;
    showApprove();
    showCost();
    open(false);
    store(false);
    syncButton();
}

// ---- sending --------------------------------------------------------------------------------

/** The button under a step-limit note: one click goes on with the task. It goes with the next message. */
function continueButton(card) {
    dropContinue();
    const b = el("button", null, "Continue");
    b.type = "button";
    b.addEventListener("click", () => {
        if (busy || ui.send.disabled) return;
        dropContinue();
        sendText("Continue.");
    });
    continueRow = el("div", "as-card-buttons");
    continueRow.appendChild(b);
    card.appendChild(continueRow);
}

// ---- templates (item 76) --------------------------------------------------------------------

const TEMPLATES_MAX = 100;
const TEMPLATE_NAME_MAX = 60;
const TEMPLATE_TEXT_MAX = 20000;

/**
 * The saved task texts, `settings.assistant.templates`: [{ name, text }], oldest first. Only text: a template carries
 * no model, no step limit and never Approve everything, so starting one asks what any message asks. "Delete all
 * assistant data" takes them with the assistant's other settings.
 */
export function cleanTemplates(list) {
    const out = [];
    const seen = new Set();
    for (const t of Array.isArray(list) ? list : []) {
        if (!t || typeof t !== "object") continue;
        const name = String(t.name == null ? "" : t.name).replace(/\s+/g, " ").trim().slice(0, TEMPLATE_NAME_MAX);
        const text = String(t.text == null ? "" : t.text).slice(0, TEMPLATE_TEXT_MAX);
        if (!name || !text.trim() || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        out.push({ name, text });
        if (out.length >= TEMPLATES_MAX) break;
    }
    return out;
}

async function readTemplates() {
    const all = await window.scumble.settings.get();
    return cleanTemplates(((all && all.assistant) || {}).templates);
}

async function writeTemplates(list) {
    const all = await window.scumble.settings.get();
    await window.scumble.settings.set({ assistant: { ...((all && all.assistant) || {}), templates: cleanTemplates(list) } });
}

async function toggleTemplates() {
    if (!ui.tplList.hidden) { ui.tplList.hidden = true; return; }
    ui.chatList.hidden = true;
    ui.tplList.hidden = false;
    await renderTemplates();
}

async function renderTemplates() {
    const box = ui.tplList;
    box.textContent = "";
    let list = [];
    try { list = await readTemplates(); } catch (_) { box.appendChild(el("div", "as-note", "the templates could not be read")); return; }
    if (!list.length) box.appendChild(el("div", "as-note as-tpl-empty", "no template yet: write a task in the field below, name it here and save it"));
    for (const t of list) box.appendChild(templateRow(t));
    // the text in the field, saved under a name (the same name replaces that template, after a question)
    const save = el("div", "as-chat as-tpl-save");
    const name = el("input");
    name.type = "text";
    name.maxLength = TEMPLATE_NAME_MAX;
    name.placeholder = "name for the text in the field";
    const btn = el("button", null, "Save");
    btn.type = "button";
    btn.title = "Save the text in the chat field as a template under this name";
    btn.addEventListener("click", () => saveTemplate(name.value, ui.text.value));
    ui.tplName = name;   // Enter in it saves (onKey: the panel's capture listener sees the key first)
    save.appendChild(name);
    save.appendChild(btn);
    box.appendChild(save);
}

function templateRow(t) {
    const node = el("div", "as-chat as-tpl-row");
    node.dataset.template = t.name;
    const use = el("button", "as-chat-open");
    use.type = "button";
    use.title = "Put this text into the chat field (it is sent when you send it)";
    use.appendChild(el("div", "as-chat-title", t.name));
    use.appendChild(el("div", "as-chat-note", t.text.replace(/\s+/g, " ").trim().slice(0, 120)));
    use.addEventListener("click", () => {
        if (ui.text.disabled) return;
        ui.text.value = t.text;
        ui.tplList.hidden = true;
        ui.text.focus();
    });
    const del = el("button", "as-chat-del", "×");
    del.type = "button";
    del.title = "Delete this template";
    del.addEventListener("click", async (e) => {
        e.stopPropagation();
        const yes = await confirm(`Delete the template "${t.name}"?`, { title: "Assistant", ok: "Delete", cancel: "Cancel", danger: true });
        if (!yes) return;
        await writeTemplates((await readTemplates()).filter((x) => x.name !== t.name));
        await renderTemplates();
    });
    node.appendChild(use);
    node.appendChild(del);
    return node;
}

async function saveTemplate(rawName, rawText) {
    const name = String(rawName || "").replace(/\s+/g, " ").trim().slice(0, TEMPLATE_NAME_MAX);
    const text = String(rawText || "");
    if (!name || !text.trim()) { note(!name ? "a template needs a name" : "the chat field is empty: write the task there first, then save it"); return false; }
    if (text.length > TEMPLATE_TEXT_MAX) { note(`a template holds at most ${TEMPLATE_TEXT_MAX.toLocaleString("en")} characters`); return false; }
    const list = await readTemplates();
    const i = list.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
    if (i >= 0) {
        const yes = await confirm(`Replace the template "${list[i].name}"?`, { title: "Assistant", ok: "Replace", cancel: "Cancel" });
        if (!yes) return false;
        list[i] = { name, text };
    } else {
        if (list.length >= TEMPLATES_MAX) { note(`at most ${TEMPLATES_MAX} templates: delete one first`); return false; }
        list.push({ name, text });
    }
    await writeTemplates(list);
    await renderTemplates();
    return true;
}

// ---- approve everything (item 75) -----------------------------------------------------------

/**
 * The chat's switch: on, every call the assistant would ask about runs without a question. Switching it on asks
 * first, in the app's own dialog (renderer/dialogs.js, which no skin reaches); main answers a question that is
 * waiting, so a turn does not stand still behind it. It belongs to this chat and is off in the next one.
 */
async function toggleApprove() {
    if (ui.approve.disabled) return;
    if (approveAll) {
        showApprove(await api().approveAll(false).catch(() => null));
        return;
    }
    const yes = await confirm("Approve everything in this chat?", {
        title: "Assistant",
        detail: `The assistant then runs every call without asking first: paid runs and runs on your ComfyUI (at most ${autoRuns} per turn, Settings › Assistant), reading and overwriting files, and changes Ctrl+Z does not take back. What it refuses stays refused, and every call still shows as a card.\n\nThe model reads layer names, file names and text in the picture. With everything approved, such text can make it spend money or overwrite a file.\n\nThis holds for this chat only; a new chat asks again.`,
        ok: "Approve everything", cancel: "Cancel", danger: true,
    });
    if (!yes) return;
    showApprove(await api().approveAll(true).catch(() => null));
}

/** The switch as main holds it (`state()`, or the answer of `approveAll`). */
function showApprove(state) {
    if (state) {
        approveAll = !!state.approveAll;
        if (Number.isFinite(Number(state.autoRuns))) autoRuns = Number(state.autoRuns);
    }
    if (!ui.approve) return;
    ui.approve.classList.toggle("as-on", approveAll);
    ui.approve.setAttribute("aria-pressed", approveAll ? "true" : "false");
    ui.approve.textContent = approveAll ? "Approving everything" : "Approve everything";
    ui.approve.title = approveAll
        ? `On for this chat: nothing asks first (at most ${autoRuns} paid or queued runs per turn). Click to make the assistant ask again.`
        : "Let the assistant run every call of this chat without asking, paid runs included";
    ui.approve.disabled = !!ui.text.disabled;              // a chat opened to read takes no turn
}

function dropContinue() {
    if (continueRow) continueRow.remove();
    continueRow = null;
}

async function send() {
    const text = ui.text.value.trim();
    if (!text || busy) return;
    ui.text.value = "";
    await sendText(text);
}

async function sendText(text) {
    // the provider's privacy notice shows until the first send to it (docs/ASSISTANT.md): that send is this one
    const noticed = noticeProvider;
    try {
        await api().send(text);
        if (noticed && api().noticed) {
            noticeProvider = null;
            api().noticed(noticed).then(() => refresh()).catch(() => { /* shown again next time */ });
        }
    } catch (err) {
        const message = String((err && err.message) || err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");
        const card = note(message, "as-bad");
        if (/No API key/i.test(message) && deps.openSettings) {
            const b = el("button", null, "Open Settings …");
            b.type = "button";
            b.addEventListener("click", () => deps.openSettings());
            const row = el("div", "as-card-buttons");
            row.appendChild(b);
            card.appendChild(row);
        }
    }
}

function stop() {
    closeAsks();
    syncButton();
    api().stop().catch(() => {});
}

async function newChat() {
    closeAsks();
    syncButton();
    await api().reset().catch(() => {});
    forgetTurns();
    ui.chatList.hidden = true;
    ui.text.disabled = false;
    ui.send.disabled = false;
    ui.list.textContent = "";
    cards = new Map();
    usage = null;
    lastTurnCost = 0;
    busy = false;
    openAsk = null;
    streamBubble = null;
    ui.send.textContent = "Send";
    approveAll = false;                                    // main's reset() switched it off with the chat
    showApprove();
    showCost();
    syncButton();
}

/** A model the user picked: the chat starts over, after a word when it has turns. */
async function pickModel(value) {
    if (!value || !/^[^:]+:.+/.test(value)) return;
    const hadTurns = !!ui.list.querySelector(".as-bubble");
    await window.scumble.settings.set({ assistant: { ...((await window.scumble.settings.get()).assistant || {}), model: value } });
    await newChat();
    await refresh();
    if (hadTurns) note("the chat starts over: the provider and the model are fixed per chat");
}

// ---- the picker and the state ---------------------------------------------------------------

async function refresh() {
    const state = await api().state();
    busy = !!state.busy;
    usage = state.usage || null;
    ui.send.textContent = busy ? "Stop" : "Send";
    agents = state.agents || 0;
    ui.baseNote = state.base ? `test endpoint: every request goes to ${state.base}` : "";
    if (state.chatReadOnly) {
        ui.text.disabled = true;
        ui.send.disabled = true;
    }
    await fillPicker(state);
    showApprove(state);
    showNotice();
    showCost();
    if (!ui.list.childNodes.length && Array.isArray(state.events) && state.events.length) {
        replay(state.events);
        // a turn still running in main (the window reloaded during it): the replay ends idle, main's state wins
        busy = !!state.busy;
        ui.send.textContent = busy ? "Stop" : "Send";
    }
    if (state.pending && !openAsk) askCard({ ...state.pending, name: state.pending.name, call: state.pending.call });
    syncButton();
}

/** Everything the panel missed (a reload, a first open): the events as they were. */
function replay(events) {
    for (const e of events) {
        if (e.type === "turn:start" || e.type === "text_delta") continue;   // the text comes whole
        onEvent(e);
    }
    busy = false;
    ui.send.textContent = "Send";
    ui.list.scrollTop = ui.list.scrollHeight;
}

async function fillPicker(state) {
    if (!picker) {
        try { picker = await api().models(); } catch (_) { picker = null; }
    }
    if (!picker) return;
    const current = state.provider && state.model ? `${state.provider}:${state.model}` : picker.current;
    ui.model.textContent = "";
    let found = false;
    for (const group of picker.groups) {
        const g = el("optgroup");
        g.label = group.ready ? group.label : `${group.label} — ${group.note || "no key"}`;
        for (const m of group.models) {
            const o = el("option", null, m.label + marks(m));
            o.value = m.value;
            o.disabled = !group.ready;
            if (m.value === current) { o.selected = true; found = true; }
            g.appendChild(o);
        }
        if (group.models.length) ui.model.appendChild(g);
    }
    if (!found && current) {                                // a free OpenRouter id, or one that left the list
        const g = el("optgroup");
        g.label = "this chat";
        const o = el("option", null, state.label || current);
        o.value = current;
        o.selected = true;
        g.appendChild(o);
        ui.model.appendChild(g);
    }
    const provider = String(current || "").split(":")[0];
    ui.free.hidden = provider !== "openrouter";
    if (!ui.free.hidden && !ui.freeList.childNodes.length) {
        api().openrouterModels().then((list) => {
            for (const m of (list || []).slice(0, 400)) {
                const o = el("option");
                o.value = m.id;
                ui.freeList.appendChild(o);
            }
        }).catch(() => { /* the list is a convenience */ });
    }
    const group = picker.groups.find((x) => x.provider === provider);
    const notes = [];
    if (group && !group.ready) notes.push(`${group.label}: ${group.note || "no key"} — add it under Settings › API providers`);
    if (state.built === false) notes.push(`${state.label || provider} is not built yet`);
    if (state.vision === false) notes.push("this model cannot look at the picture");
    if (state.notice && state.notice.text) notes.push(state.notice.text);
    noticeProvider = state.notice && state.notice.text ? state.notice.provider || provider : null;
    ui.pickNote = notes.join(" · ");
}

/**
 * What a row says about itself beside its name. Only what is true of that model: whether it
 * can look at the picture, and whatever note its entry carries. What has and has not run
 * against a live key is one sentence in docs/ASSISTANT.md, not a warning on every row
 * (docs/BUGS.md, "The assistant's picker warns about itself").
 */
function marks(m) {
    const out = [];
    if (m.vision === false) out.push("cannot look at the picture");
    if (m.note) out.push(m.note);
    return out.length ? ` — ${out.join(", ")}` : "";
}
