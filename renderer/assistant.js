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

const OPEN_KEY = "shell.assistant.open";
const THUMB_MAX = 240;

const ui = {};
let deps = {};
let started = false;
let busy = false;
let openAsk = null;          // the call id of the ask card that is waiting
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

/** `code` and `**bold**` inside one paragraph or list item. */
function inline(text) {
    const out = document.createDocumentFragment();
    const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
    let at = 0;
    let m;
    while ((m = re.exec(text))) {
        if (m.index > at) out.appendChild(document.createTextNode(text.slice(at, m.index)));
        if (m[1] !== undefined) out.appendChild(el("code", null, m[1]));
        else out.appendChild(el("strong", null, m[2]));
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
    ui.close = el("button", null, "×");
    ui.close.type = "button";
    ui.close.title = "Close the assistant (Ctrl+Shift+A)";
    const row = el("div", "as-head-row");
    row.appendChild(ui.model);
    row.appendChild(ui.newChat);
    row.appendChild(ui.close);
    head.appendChild(row);
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
    ui.text = el("textarea");
    ui.text.rows = 3;
    ui.text.spellcheck = false;
    ui.text.placeholder = "Ask the assistant — Enter sends, Shift+Enter is a new line";
    foot.appendChild(ui.text);
    const frow = el("div", "as-foot-row");
    ui.cost = el("span", "as-cost", "");
    ui.send = el("button", null, "Send");
    ui.send.type = "button";
    frow.appendChild(ui.cost);
    frow.appendChild(ui.send);
    foot.appendChild(frow);
    dialog.appendChild(foot);

    // ---- events of the loop
    api().onEvent((e) => onEvent(e));

    // ---- the panel's own
    ui.close.addEventListener("click", () => toggleAssistant(false));
    ui.newChat.addEventListener("click", () => newChat());
    ui.send.addEventListener("click", () => (busy ? stop() : send()));
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
    if (want) { refresh().catch(() => {}); ui.text.focus(); }
    syncButton();
    return want;
}

export function assistantOpen() {
    return !!(started && ui.dialog.open);
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
    // typing, which is what the editor's own question does the moment it opens.
    if (handedOff || !ui.dialog.open) return;
    const to = e.relatedTarget;
    if (to && ui.dialog.contains(to)) return;
    if (wants(to)) return;
    const now = Date.now();
    if (now - lastOutsidePointer < 500 || now - lastTab < 500) return;
    setTimeout(() => {
        if (handedOff || !ui.dialog.open) return;
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
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(node.tagName)) return true;
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
    if (e.reason) card.appendChild(el("div", "as-reason", e.reason));
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
    openAsk = e.call;
    const card = el("div", "as-card as-ask");
    card.dataset.ask = e.call;
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
    allow.addEventListener("click", () => answer(e.call, true, card, "allowed"));
    deny.addEventListener("click", () => answer(e.call, false, card, "declined"));
    buttons.appendChild(allow);
    buttons.appendChild(deny);
    card.appendChild(buttons);
    add(card);
    if (!ui.dialog.open) toggleAssistant(true);        // an ask opens the panel
    syncButton();
    return card;
}

/** What the card says beyond the policy's reason: the file, the recipe, the settings. */
function cardLines(e) {
    const c = e.card || {};
    const lines = [];
    if (c.path) lines.push(`${c.path}${c.exists ? " — exists, will be overwritten" : " — a new file"}`);
    if (c.recipe) lines.push(`recipe: ${c.recipe}${c.mode ? " (" + c.mode + ")" : ""}`);
    else if (e.name === "generate" || e.name === "generate_new") {
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

function answer(call, allow, card, word) {
    openAsk = null;
    const state = card.querySelector(".as-card-state");
    if (state) state.textContent = word;
    for (const b of card.querySelectorAll("button")) b.disabled = true;
    api().answer(call, allow).catch(() => {});
    syncButton();
}

// ---- events ---------------------------------------------------------------------------------

function onEvent(e) {
    if (!started || !e) return;
    switch (e.type) {
        case "user":
            endStream();
            bubble("as-user", e.text);
            break;
        case "turn:start":
            cards = new Map();
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
            openAsk = null;
            ui.send.textContent = "Send";
            endStream(e.reason === "stopped");
            if (e.reason && e.reason !== "end") note(doneWords(e), e.reason === "error" ? "as-bad" : "");
            if (e.usage) usage = e.usage;
            showCost();
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
    if (e.reason === "cap") return "the step limit of this turn was reached" + detail;
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

// ---- sending --------------------------------------------------------------------------------

async function send() {
    const text = ui.text.value.trim();
    if (!text || busy) return;
    ui.text.value = "";
    try {
        await api().send(text);
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
    api().stop().catch(() => {});
}

async function newChat() {
    await api().reset().catch(() => {});
    ui.list.textContent = "";
    cards = new Map();
    usage = null;
    lastTurnCost = 0;
    busy = false;
    openAsk = null;
    streamBubble = null;
    ui.send.textContent = "Send";
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
    await fillPicker(state);
    showNotice();
    showCost();
    if (!ui.list.childNodes.length && Array.isArray(state.events) && state.events.length) replay(state.events);
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
            const o = el("option", null, m.label + marks(group, m));
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
    ui.pickNote = notes.join(" · ");
}

function marks(group, m) {
    const out = [];
    if (m.vision === false) out.push("cannot look at the picture");
    if (!group.tried) out.push("not tried with a real key");
    if (m.note) out.push(m.note);
    return out.length ? ` — ${out.join(", ")}` : "";
}
