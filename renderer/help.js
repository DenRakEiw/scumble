// The Help panel (docs/PLAN_HELP.md): the manual, rendered and searchable, which needs no key and no
// network, and above it a chat that answers from the same text on any model the user has a key for.
// The chat runs in main (electron/main/assistant/help.js) with no tools: Help explains, the assistant
// acts.
//
// Like the assistant's panel (renderer/assistant.js):
// - a `<dialog>` shown with `show()`, a column beside the editor, never modal;
// - **one window capture `keydown` listener** for every key inside the panel, so typing a search or a
//   question never reaches the editor's shortcuts;
// - **nothing here writes markup**: the manual and every answer are built with `createElement` and
//   `textContent` (`no_markup_writes` in tools/assistant_test.js holds this file to it too).
import { parseManual, inline, chapterText } from "./help/manual.js";
import { renderText } from "./assistant.js";
import { host } from "./editor/host.js";

const OPEN_KEY = "shell.help.open";

const ui = {};
let started = false;
let deps = {};
let manual = null;           // { title, chapters } of docs/MANUAL.md
let texts = new Map();       // slug -> the chapter as plain lowercase text, for the search
let models = null;           // help:models - { groups, current, ready }
let busy = false;
let streamBubble = null;
let streamText = null;
let searchTimer = 0;

const api = () => (window.scumble && window.scumble.help) || null;
const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
};

// ---- the manual, built by hand ---------------------------------------------------------------

/** The search's terms: lowercase words of two letters and more. */
function termsOf(query) {
    return String(query || "").toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
}

/** Text with every term wrapped in a <mark>, as nodes. */
function marked(text, terms) {
    const frag = document.createDocumentFragment();
    if (!terms.length) { frag.append(text); return frag; }
    const lower = text.toLowerCase();
    let at = 0;
    while (at < text.length) {
        let best = -1, len = 0;
        for (const t of terms) {
            const i = lower.indexOf(t, at);
            if (i >= 0 && (best < 0 || i < best)) { best = i; len = t.length; }
        }
        if (best < 0) { frag.append(text.slice(at)); break; }
        if (best > at) frag.append(text.slice(at, best));
        frag.append(el("mark", "hp-hit", text.slice(best, best + len)));
        at = best + len;
    }
    return frag;
}

/** A manual text (inline Markdown) as nodes: **bold**, `code`, the search's hits marked. */
function richText(text, terms = []) {
    const frag = document.createDocumentFragment();
    for (const span of inline(text)) {
        const node = span.type === "code" ? el("code") : span.type === "strong" ? el("strong") : null;
        if (node) { node.append(marked(span.text, terms)); frag.append(node); } else frag.append(marked(span.text, terms));
    }
    return frag;
}

function chapterNode(c, index, terms) {
    const sec = el("section", "hp-chapter");
    sec.dataset.slug = c.slug;
    const h = el("h2", "hp-title");
    h.append(el("span", "hp-num", String(index + 1).padStart(2, "0")), marked(c.title, terms));
    sec.append(h, el("p", "hp-summary", c.summary));
    for (const p of c.body) { const node = el("p"); node.append(richText(p, terms)); sec.append(node); }
    if (c.steps && c.steps.length) {
        const ol = el("ol", "hp-steps");
        for (const s of c.steps) {
            const li = el("li");
            li.append(el("strong", null, s.title + ". "), richText(s.text, terms));
            ol.append(li);
        }
        sec.append(ol);
    }
    for (const g of c.keys || []) {
        sec.append(el("h3", "hp-group", g.group));
        const table = el("table", "hp-keys");
        for (const r of g.rows) {
            const tr = el("tr");
            const k = el("td", "hp-key"), w = el("td");
            k.append(richText(r.key, terms));
            w.append(richText(r.what, terms));
            tr.append(k, w);
            table.append(tr);
        }
        sec.append(table);
    }
    if (c.notes && c.notes.length) {
        const ul = el("ul", "hp-notes");
        for (const n of c.notes) { const li = el("li"); li.append(richText(n, terms)); ul.append(li); }
        sec.append(ul);
    }
    return sec;
}

/**
 * The chapters whose text holds every term of the query, in reading order: [{ slug, title }].
 * An empty query matches every chapter.
 */
export function searchManual(query) {
    if (!manual) return [];
    const terms = termsOf(query);
    return manual.chapters
        .filter((c) => terms.every((t) => texts.get(c.slug).includes(t)))
        .map((c) => ({ slug: c.slug, title: c.title }));
}

/** The contents list and the chapters, filtered and marked by the search. */
function renderManual() {
    if (!manual) return;
    const query = ui.search.value;
    const terms = termsOf(query);
    const hits = new Set(searchManual(query).map((c) => c.slug));
    ui.contents.replaceChildren();
    ui.chapters.replaceChildren();
    manual.chapters.forEach((c, i) => {
        if (!hits.has(c.slug)) return;
        const b = el("button", "hp-link");
        b.type = "button";
        b.append(el("span", "hp-num", String(i + 1).padStart(2, "0")), document.createTextNode(c.title));
        b.addEventListener("click", () => showChapter(c.slug));
        const li = el("li");
        li.append(b);
        ui.contents.append(li);
        ui.chapters.append(chapterNode(c, i, terms));
    });
    ui.count.textContent = terms.length
        ? (hits.size ? `${hits.size} of ${manual.chapters.length} chapters` : `No chapter mentions "${query.trim()}". Ask below, or read the docs on GitHub.`)
        : "";
}

/** Scroll the manual to a chapter (clearing a search that hides it). */
export function showChapter(slug) {
    if (!manual) return false;
    let node = ui.chapters.querySelector(`[data-slug="${CSS.escape(String(slug))}"]`);
    if (!node && ui.search.value) { ui.search.value = ""; renderManual(); node = ui.chapters.querySelector(`[data-slug="${CSS.escape(String(slug))}"]`); }
    if (!node) return false;
    ui.doc.scrollTop = node.offsetTop - ui.doc.offsetTop - 4;
    node.classList.add("hp-flash");
    setTimeout(() => node.classList.remove("hp-flash"), 900);
    return true;
}

/** The chapter an answer names on its last "Chapter: ..." line, by title. */
function chapterNamed(answer) {
    if (!manual) return null;
    const m = /(?:^|\n)\s*\**Chapter:?\**\s*(.+?)\s*$/i.exec(String(answer || "").trim());
    if (!m) return null;
    const name = m[1].replace(/[*_`"“”]/g, "").trim().toLowerCase();
    return manual.chapters.find((c) => c.title.toLowerCase() === name)
        || manual.chapters.find((c) => name.startsWith(c.title.toLowerCase()) || c.title.toLowerCase().startsWith(name))
        || null;
}

// ---- the chat ---------------------------------------------------------------------------------

function modelEntry(value) {
    for (const g of (models && models.groups) || []) for (const m of g.models) if (m.value === value) return { group: g, model: m };
    return null;
}

async function refreshModels() {
    const a = api();
    if (!a) return;
    try { models = await a.models(); } catch (err) { models = { groups: [], current: "", ready: false }; ui.note.textContent = String(err.message || err); }
    ui.model.replaceChildren();
    for (const g of models.groups) {
        if (!g.ready) continue;
        const og = el("optgroup");
        og.label = g.label;
        for (const m of g.models) {
            const o = el("option", null, m.label);
            o.value = m.value;
            og.append(o);
        }
        ui.model.append(og);
    }
    ui.model.value = models.current;
    syncChat();
}

function syncChat() {
    const ready = !!(models && models.ready && models.current);
    ui.ask.hidden = !ready;
    ui.none.hidden = ready;
    ui.send.textContent = busy ? "Stop" : "Ask";
    ui.text.disabled = !ready;
    const e = ready ? modelEntry(ui.model.value) : null;
    ui.note.textContent = e
        ? `Answers from the manual only, on ${e.model.label} (${e.group.label}). Your question and the manual go there; no picture, no file. Help cannot change anything.`
        : "";
}

function bubble(cls, text) {
    const b = el("div", "hp-bubble " + cls);
    if (text !== undefined) b.textContent = text;
    ui.list.append(b);
    ui.list.hidden = false;
    ui.list.scrollTop = ui.list.scrollHeight;
    return b;
}

function onEvent(e) {
    if (!started || !e) return;
    if (e.type === "text_delta") {
        if (!streamBubble) { streamBubble = bubble("hp-model"); streamText = document.createTextNode(""); streamBubble.append(streamText); }
        streamText.data += e.text || "";
        ui.list.scrollTop = ui.list.scrollHeight;
    } else if (e.type === "answer") {
        const b = streamBubble || bubble("hp-model");
        b.replaceChildren(renderText(e.text));
        const c = chapterNamed(e.text);
        if (c) {
            const link = el("button", "hp-read", `Read: ${c.title}`);
            link.type = "button";
            link.addEventListener("click", () => showChapter(c.slug));
            b.append(link);
        }
        streamBubble = null;
        streamText = null;
    } else if (e.type === "done") {
        busy = false;
        streamBubble = null;
        streamText = null;
        const why = { stopped: "Stopped.", cut: "The answer was cut off at its length limit.", refusal: "The model refused to answer." }[e.reason];
        if (e.reason === "error") bubble("hp-error", e.detail || "The model did not answer.");
        else if (why) bubble("hp-quiet", why);
        syncChat();
    }
}

async function send() {
    const a = api();
    if (!a) return;
    if (busy) { a.stop(); return; }
    const text = ui.text.value.trim();
    if (!text) return;
    ui.text.value = "";
    busy = true;
    syncChat();
    bubble("hp-user", text);
    try {
        await a.send(text, ui.model.value);
    } catch (err) {
        busy = false;
        bubble("hp-error", String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
        syncChat();
    }
}

async function newChat() {
    const a = api();
    if (a) await a.reset();
    busy = false;
    streamBubble = null;
    ui.list.replaceChildren();
    ui.list.hidden = true;
    syncChat();
}

// ---- the panel ---------------------------------------------------------------------------------

function build(dialog) {
    ui.dialog = dialog;
    const head = el("div", "hp-head");
    const row = el("div", "hp-row");
    const title = el("strong", "hp-name", "Help");
    ui.close = el("button", null, "Close");
    ui.close.type = "button";
    ui.close.title = "Close the help (F1, Escape)";
    row.append(title, el("span", "hp-spacer"), ui.close);
    ui.search = el("input", "hp-search");
    ui.search.type = "search";
    ui.search.placeholder = "Search the manual";
    ui.search.spellcheck = false;
    ui.count = el("div", "hp-count");
    head.append(row, ui.search, ui.count);

    // the chat: shown when a model is there, else one line on how to get one
    const chat = el("div", "hp-chat");
    ui.ask = el("div", "hp-ask");
    const pick = el("div", "hp-row");
    ui.model = el("select", "hp-model");
    ui.model.title = "The model that answers (any model you have a key for; it needs no eyes and no tools)";
    ui.fresh = el("button", null, "New chat");
    ui.fresh.type = "button";
    pick.append(ui.model, ui.fresh);
    ui.list = el("div", "hp-list");
    ui.list.hidden = true;
    const write = el("div", "hp-row hp-write");
    ui.text = el("textarea", "hp-text");
    ui.text.rows = 2;
    ui.text.placeholder = "Ask how to do something (Enter asks, Shift+Enter for a new line)";
    ui.send = el("button", "hp-send", "Ask");
    ui.send.type = "button";
    write.append(ui.text, ui.send);
    ui.note = el("div", "hp-note");
    ui.ask.append(pick, ui.list, write, ui.note);
    ui.none = el("div", "hp-none");
    const keys = el("button", null, "Settings");
    keys.type = "button";
    keys.addEventListener("click", () => deps.openSettings && deps.openSettings());
    ui.none.append(el("span", null, "To ask questions, add an API key under Settings › API providers (any provider, a small model is plenty). The manual below needs none. "), keys);
    ui.none.hidden = true;
    chat.append(ui.ask, ui.none);

    ui.doc = el("div", "hp-doc");
    ui.contents = el("ol", "hp-contents");
    ui.chapters = el("div", "hp-chapters");
    ui.doc.append(ui.contents, ui.chapters);

    dialog.replaceChildren(head, chat, ui.doc);

    ui.close.addEventListener("click", () => toggleHelp(false));
    ui.search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderManual, 120); });
    ui.send.addEventListener("click", send);
    ui.fresh.addEventListener("click", newChat);
    ui.model.addEventListener("change", () => {
        const a = api();
        if (a) a.setModel(ui.model.value).catch(() => {});
        if (models) models.current = ui.model.value;
        syncChat();
    });
}

function onKey(e) {
    if (!started || !ui.dialog.open || !ui.dialog.contains(e.target)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target === ui.text) {
        e.preventDefault();
        e.stopImmediatePropagation();
        send();
        return;
    }
    if (e.key === "Enter" && e.target === ui.search) {
        e.preventDefault();
        e.stopImmediatePropagation();
        clearTimeout(searchTimer);
        renderManual();
        const first = searchManual(ui.search.value)[0];
        if (first) showChapter(first.slug);
        return;
    }
    if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (busy) { const a = api(); if (a) a.stop(); } else if (e.target === ui.search && ui.search.value) { ui.search.value = ""; renderManual(); } else toggleHelp(false);
        return;
    }
    // every other key inside the panel belongs to the panel, never to the editor's shortcuts
    e.stopImmediatePropagation();
}

/** Build the panel into `#help` and load the manual. */
export async function initHelp(options = {}) {
    if (started) return;
    const dialog = document.getElementById("help");
    const a = api();
    if (!dialog || !a) return;
    deps = options;
    build(dialog);
    started = true;
    window.addEventListener("keydown", onKey, true);
    a.onEvent(onEvent);
    try {
        manual = parseManual(await a.manual());
        texts = new Map(manual.chapters.map((c) => [c.slug, chapterText(c).toLowerCase()]));
        renderManual();
    } catch (err) {
        ui.count.textContent = "The manual could not be read: " + String(err.message || err);
    }
    if (read()) toggleHelp(true);
}

/** Open or close the panel; `undefined` toggles. */
export function toggleHelp(on) {
    if (!started) return false;
    const want = on === undefined ? !ui.dialog.open : !!on;
    if (want && !ui.dialog.open) {
        ui.dialog.show();
        refreshModels().catch(() => {});
        ui.search.focus();
    } else if (!want && ui.dialog.open) {
        ui.dialog.close();
        const ed = host.editor;
        if (ed && ed.root && typeof ed.root.focus === "function") ed.root.focus();
    }
    try { if (want) localStorage.setItem(OPEN_KEY, "1"); else localStorage.removeItem(OPEN_KEY); } catch (_) { /* a convenience only */ }
    const b = document.getElementById("shell-help");
    if (b) b.classList.toggle("hp-on", want);
    return want;
}

export function helpOpen() {
    return !!(started && ui.dialog.open);
}

function read() {
    try { return localStorage.getItem(OPEN_KEY) === "1"; } catch (_) { return false; }
}
