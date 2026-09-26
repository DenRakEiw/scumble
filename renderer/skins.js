// Skins in the window (docs/SKINS.md). App only: the ComfyUI node has no skins and never loads this module.
//
// main.js answers scumble://app/skin.css with an @import of the chosen skin's stylesheet (electron/main/skins.js),
// and index.html links it after the app's own CSS. The app's CSS sits in `@layer app` and the protected rules in the
// anonymous first layer of protect.css, so a skin's normal rules beat the app's and its !important loses to both.
// This module switches that link live (the new sheet is in before the old one goes, so no frame shows the default
// look in between), resets token values that are not of their kind, refreshes the canvas colours that follow the
// tokens (editor/inpaint_theme.js), draws the assistant's question out of any skin's reach (protectAsk), switches off
// a skin that hides it anyway (guardAsk) and fills Settings › Appearance. Nothing here writes markup: every manifest
// text goes in through textContent.
import { host } from "./editor/host.js";
import { SKIN_TOKENS, refreshTheme } from "./editor/inpaint_theme.js";

/** The CSS property a token's value is checked against, by the token's kind; a value that fails is reset. */
const PROPERTY_OF = { color: "color", font: "font-family", radius: "border-radius", shadow: "box-shadow", scheme: "color-scheme", control: "accent-color", scrollbar: "scrollbar-color" };
/** Selectors aimed at what protect.css pins: a skin's rules there change nothing that matters, so it is told. */
const PROTECTED_RE = /\.as-ask\b|\[data-ask\b|\.as-card-buttons\b|\.as-reason\b|\.shell-key-state\b|password|\.ipc-view\b/i;
const LOAD_TIMEOUT = 5000;
const FONTS_TIMEOUT = 3000;
const DEFAULT_SWATCH = ["#181818", "#202020", "#2d2d2d", "#ddd", "#f0c674"];

let state = null;        // the last answer of appearance.get / set / refuse (electron/main/main.js appearanceState)
let seq = 0;             // every switch takes a number; only the newest one finishes
let findings = [];       // what settle() found in the skin in use: reset tokens, the lint
let note = "";           // the last thing that happened to a skin, shown above the Appearance list until the next switch
let flash = "";          // a short word for the note line beside the buttons ("reloading ...", a refused id)
let refusing = null;     // the skin being switched off: guardAsk starts no second refusal meanwhile
let ui = null;           // Settings › Appearance's elements, from renderAppearance()

const appearance = () => window.scumble.appearance;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (s, n = 80) => { const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const errText = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

// ---- the sheet ---------------------------------------------------------------------------

/** Waits for a stylesheet link: true when it loaded, false on an error or after LOAD_TIMEOUT (no rAF: hidden windows). */
function loaded(link) {
    return new Promise((resolve) => {
        let timer = 0;
        const finish = (ok) => {
            clearTimeout(timer);
            link.removeEventListener("load", onLoad);
            link.removeEventListener("error", onError);
            resolve(ok);
        };
        const onLoad = () => finish(true);
        const onError = () => finish(false);
        link.addEventListener("load", onLoad);
        link.addEventListener("error", onError);
        timer = setTimeout(() => finish(false), LOAD_TIMEOUT);
    });
}

/** How many rules the skin's own stylesheet brought (0 when it failed, is empty, or no skin is imported). */
function importedRules(link) {
    try {
        const first = link && link.sheet && link.sheet.cssRules[0];
        return first && first.styleSheet ? first.styleSheet.cssRules.length : 0;
    } catch (_) {
        return 0;
    }
}

/**
 * Loads what main serves at skin.css now into a new link right after the current one, and only then takes the old one
 * out. Returns true, false (did not load: the new link is gone, the old one stays) or "stale" (a newer switch took
 * over). `force` keeps the new link even when it did not load: the refusal path, where the old sheet is the problem.
 */
async function reapply(my, force) {
    const old = document.getElementById("skin-css");
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "skin.css?v=" + Date.now();
    const done = loaded(link);
    if (old && old.parentNode) old.after(link); else document.head.appendChild(link);
    const ok = await done;
    if (my !== seq) { link.remove(); return "stale"; }
    if (!ok && !force) { link.remove(); return false; }
    if (old && old !== link) old.remove();
    link.id = "skin-css";
    await settle(link, state ? state.active : null, my);
    return true;
}

/**
 * After a sheet is in: undo the last reset of tokens, check the new sheet, reset the tokens whose values are not of
 * their kind, mark the root, wait for the skin's fonts, and redraw what takes its colours from the tokens.
 */
async function settle(link, id, my) {
    const root = document.documentElement;
    for (const t of SKIN_TOKENS) root.style.removeProperty(t.name);
    findings = [];
    if (id && importedRules(link) === 0) {
        await refuse(id, "its stylesheet did not load or is empty", false);
        return;
    }
    const cs = getComputedStyle(root);
    for (const t of SKIN_TOKENS) {
        const v = cs.getPropertyValue(t.name).trim();
        if (!v || CSS.supports(PROPERTY_OF[t.kind] || "color", v)) continue;
        // an inline !important beats the skin's :root value, and a guaranteed-invalid value makes every site use its fallback
        root.style.setProperty(t.name, "initial", "important");
        findings.push(`${t.name}: "${short(v, 40)}" is not a valid ${t.kind}; the default is used`);
    }
    if (id) lint(link, findings, id);
    if (id) root.dataset.skin = id;
    else delete root.dataset.skin;
    await Promise.race([document.fonts.ready, sleep(FONTS_TIMEOUT)]);
    if (my !== seq) return;
    refreshTheme();
    for (const ed of host.editors()) {
        try { if (typeof ed.themeChanged === "function") ed.themeChanged(); } catch (err) { console.warn("skins: redraw", err); }
    }
    host.emit("theme", { editor: null, skin: id || "" });
    for (const card of Array.from(asks.keys())) { place(card); guardAsk(card); }
}

/** A url() or @import that leaves the skin's folder: another scheme (data: is fine) or a protocol-relative URL. */
function external(url) {
    const u = String(url || "").trim();
    return u.startsWith("//") || (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^data:/i.test(u));
}

/**
 * A url() or @import inside the app that is not in the skin's folder: the app's own files, another plugin's, or the
 * ComfyUI proxy (scumble://app/comfy/). Those load (they are the app's origin), but they are no part of the skin.
 */
function outsideFolder(url, base, id) {
    const u = String(url || "").trim();
    if (!u || /^data:/i.test(u) || u.startsWith("#") || external(u)) return false;
    let abs;
    try { abs = new URL(u, base || location.href).href; } catch (_) { return true; }
    return !abs.startsWith(new URL(`plugins/${encodeURIComponent(id)}/`, location.href).href);
}

/** Tells what in the skin's sheet will not work as its author may think: protected targets, the app's layers, the web. */
function lint(link, out, id) {
    const layerOf = (name) => String(name || "").split(".")[0].trim().toLowerCase();
    const walk = (rules, depth) => {
        if (!rules || depth > 8) return;
        for (const r of Array.from(rules)) {
            if (out.length >= 40) return;
            const base = r.parentStyleSheet && r.parentStyleSheet.href;
            if (typeof CSSImportRule !== "undefined" && r instanceof CSSImportRule) {
                if (external(r.href)) out.push(`@import ${short(r.href, 60)} loads from outside its folder: blocked`);
                else if (outsideFolder(r.href, base, id)) out.push(`@import ${short(r.href, 60)} reaches outside its folder, into the app`);
                else { let inner = null; try { inner = r.styleSheet && r.styleSheet.cssRules; } catch (_) { inner = null; } walk(inner, depth + 1); }
                continue;
            }
            if (r.selectorText && PROTECTED_RE.test(r.selectorText)) out.push(`"${short(r.selectorText, 60)}" aims at something the app protects: those properties are pinned`);
            const names = typeof CSSLayerStatementRule !== "undefined" && r instanceof CSSLayerStatementRule ? Array.from(r.nameList)
                : typeof CSSLayerBlockRule !== "undefined" && r instanceof CSSLayerBlockRule ? [r.name] : [];
            for (const n of names) if (layerOf(n) === "app" || layerOf(n) === "protect") out.push(`@layer ${n}: that name belongs to the app; a skin's rules belong outside its layers`);
            const text = r.style && r.style.cssText ? r.style.cssText : "";
            for (const m of text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
                if (external(m[2])) out.push(`url(${short(m[2], 60)}) loads from outside its folder: blocked`);
                else if (outsideFolder(m[2], base, id)) out.push(`url(${short(m[2], 60)}) reaches outside its folder, into the app`);
            }
            if (r.cssRules) walk(r.cssRules, depth + 1);
        }
    };
    try {
        const first = link && link.sheet && link.sheet.cssRules[0];
        walk(first && first.styleSheet ? first.styleSheet.cssRules : null, 0);
    } catch (err) {
        out.push("its stylesheet could not be read: " + errText(err));
    }
}

// ---- switching ---------------------------------------------------------------------------

/** At start, before the first editor: the sheet in index.html is loaded already (it holds back the first paint). */
export async function initSkins() {
    state = await appearance().get();
    const my = ++seq;
    const link = document.getElementById("skin-css");
    if (state.active && link && !link.sheet) await loaded(link);
    await settle(link, state.active, my);
    return state;
}

/**
 * Switch to the skin `id` ("" = the default look), live: the newest call wins. When the new sheet does not load, the
 * old one stays and the choice goes back to it. Rejects when main refuses the id (no such skin, or a broken one).
 */
export async function applySkin(id) {
    const want = String(id == null ? "" : id);
    const my = ++seq;
    const prev = state ? state.active || "" : "";
    let next;
    try {
        next = await appearance().set(want);
    } catch (err) {
        if (my === seq) { flash = errText(err); render(); }
        throw err;
    }
    if (my !== seq) return state;
    state = next;
    note = "";
    flash = "";
    const r = await reapply(my, false);
    if (my !== seq) return state;
    if (r === false) {
        try { state = await appearance().set(prev); } catch (err) { console.warn("skins: back to the previous choice", err); }
        note = `The skin "${nameOf(want)}" did not load; the look stays as it was.`;
        status(note);
    }
    render();   // with --no-skin, the list says the choice waits for the next start
    return state;
}

/**
 * Read the skin folders again and load the sheet in use afresh (a skin's author edits and reloads). The choice is
 * kept: a skin whose folder is gone gives the default look and a note, not an empty choice.
 */
export async function reloadSkins() {
    const my = ++seq;
    state = await appearance().get();
    if (my !== seq) return state;
    const r = await reapply(my, false);
    if (my !== seq) return state;
    note = r === false ? "The skin's stylesheet did not load; the look stays as it was." : "";
    render();
    return state;
}

/** What the window uses: main's appearance state as last read, and what the last check found in the skin. */
export function skinState() {
    return state ? { ...state, findings: findings.slice(), note } : null;
}

/** Switch the skin in use off for good (until it is chosen again) and go back to the default look. */
async function refuse(id, reason, hidAsk) {
    if (refusing) return;
    refusing = id;
    const my = ++seq;
    const name = nameOf(id);
    try {
        try {
            state = await appearance().refuse(id, reason);   // main writes the line in the app log
        } catch (err) {
            console.warn(`skins: the skin "${id}" was switched off here but not in the settings: ${reason}`, err);
            state = { ...(state || {}), skin: "", active: null, refused: { id, reason, at: Date.now() } };
        }
        await reapply(my, true);
        note = hidAsk ? `The skin "${name}" hid the assistant's question and was switched off: ${reason}` : `The skin "${name}" was switched off: ${reason}`;
        status(note);
        render();
    } finally {
        refusing = null;
    }
}

function nameOf(id) {
    const s = state && Array.isArray(state.skins) ? state.skins.find((x) => x.id === id) : null;
    return (s && s.name) || id || "Default";
}

function status(text) {
    try { if (host.editor) host.editor.setStatus(text); } catch (_) { /* no editor yet */ }
}

// ---- the assistant's question --------------------------------------------------------------
//
// The card the assistant asks with before a paid run or a change it cannot take back is drawn where no skin reaches
// (docs/SKINS.md §5). Its parts live in a shadow root with their own copy of the default look: no selector of a skin
// matches inside it, and the `:host` rule is !important in the inner context, which beats every rule outside it,
// !important or not, protect.css's included. While the question is open the card is a popover in the top layer, above
// everything in the page (CSS cannot put anything there), placed over a spacer of its height in the chat and clipped to
// the chat's scroll box, so it looks and scrolls as a card in the list. What is left to a skin is where the chat is and
// how big it is: guardAsk() checks that when the card appears, on every skin switch and every CHECK_EVERY ms while the
// question is open, which also catches a skin that shrinks the chat later (an animation delay, a :hover).

const CHECK_EVERY = 250;
/** The chat must be at least this high to show an open question (or the question's own height, if that is less). */
const MIN_CHAT_HEIGHT = 120;
/**
 * The question's look: assistant.css's in the default look, with literal colours and generic font families only (a
 * skin's @font-face cannot take the name of a generic family, so it cannot swap the glyphs). The --ask-* properties
 * are set on the card as inline !important values by place(), which no rule of a skin can override.
 */
const ASK_CSS = `
:host {
    all: initial !important; direction: ltr !important; unicode-bidi: isolate !important;
    display: block !important; position: static !important; box-sizing: content-box !important; margin: 0 !important;
    padding: 6px 8px !important; border: 1px solid #383838 !important; border-left: 3px solid #f0c674 !important;
    border-radius: 4px !important; background: #262218 !important; color: #ddd !important;
    font: 12px/1.4 system-ui, sans-serif !important;
}
:host([popover]:not(:popover-open)) { display: none !important; }
:host(:popover-open) {
    position: fixed !important; inset: auto !important; box-sizing: border-box !important;
    left: var(--ask-left, 0px) !important; top: var(--ask-top, 0px) !important; width: var(--ask-width, 320px) !important;
    height: auto !important; overflow: visible !important; clip-path: var(--ask-clip, none) !important;
}
.as-card-head { display: flex; align-items: baseline; gap: 6px; }
.as-card-name { color: #f0c674; font: 12px/1.4 monospace; }
.as-card-state { color: #888; margin-left: auto; white-space: nowrap; }
.as-card-args { color: #999; font: 11px/1.4 monospace; overflow-wrap: anywhere; margin-top: 2px; }
.as-reason { color: #ccc; margin-top: 2px; }
.as-note { color: #888; font-size: 12px; }
.as-card-buttons { display: flex; gap: 6px; margin-top: 6px; }
.as-card-buttons button { background: #2d2d2d; color: #ddd; border: 1px solid #555; border-radius: 3px; padding: 3px 10px; font: inherit; cursor: pointer; }
.as-card-buttons button:hover { background: #3a3a3a; }
`;
const ASK_VARS = ["--ask-left", "--ask-top", "--ask-width", "--ask-clip"];

let askSheet = null;
/** The open questions: card -> { spacer, list, timer, onMove, ro, mo }. */
const asks = new Map();

/** The card's parts: in its shadow root once protectAsk() has run, else in the card itself. */
const partsOf = (card) => card.shadowRoot || card;

function hasOpenButton(card) {
    return Array.from(partsOf(card).querySelectorAll(".as-card-buttons button")).some((b) => !b.disabled);
}

/**
 * Draw the assistant's question `card` (renderer/assistant.js askCard: a `.as-card.as-ask` in the chat, its parts
 * built) where no skin reaches: its parts move into a shadow root with ASK_CSS, and while it is open it is a popover
 * in the top layer over a spacer in the chat. In the default look too, so there is one way it is drawn. Returns the
 * card. releaseAsk() puts it back into the chat's flow when it is answered.
 */
export function protectAsk(card) {
    if (!card || !card.isConnected || asks.has(card) || !card.parentElement) return card;
    let root = card.shadowRoot;
    if (!root) {
        root = card.attachShadow({ mode: "open" });
        if (!askSheet) { askSheet = new CSSStyleSheet(); askSheet.replaceSync(ASK_CSS); }
        root.adoptedStyleSheets = [askSheet];
        root.append(...Array.from(card.childNodes));
    }
    if (!hasOpenButton(card)) return card;
    const list = card.parentElement;
    const spacer = document.createElement("div");
    spacer.className = "as-ask-spacer";
    spacer.setAttribute("aria-hidden", "true");
    card.after(spacer);
    card.popover = "manual";
    const a = { spacer, list, timer: 0, onMove: () => place(card), ro: null, mo: null };
    asks.set(card, a);
    list.addEventListener("scroll", a.onMove, { passive: true });
    window.addEventListener("resize", a.onMove);
    a.ro = new ResizeObserver(a.onMove);
    for (const n of [card, spacer, list]) a.ro.observe(n);
    const panel = card.closest("#assistant");
    if (panel) {
        a.mo = new MutationObserver(a.onMove);
        a.mo.observe(panel, { attributes: true, attributeFilter: ["open"] });
    }
    a.timer = setInterval(() => tick(card), CHECK_EVERY);
    place(card);
    try { spacer.scrollIntoView({ block: "nearest" }); } catch (_) { /* not laid out */ }
    // after the current task: a replayed chat makes and settles its old questions in one go (assistant.js replay)
    setTimeout(() => { if (asks.has(card)) guardAsk(card); }, 0);
    return card;
}

/** The question is answered, or the chat is gone: the card drops out of the top layer into the chat's flow. */
export function releaseAsk(card) {
    const a = card ? asks.get(card) : null;
    if (!a) return;
    asks.delete(card);
    clearInterval(a.timer);
    a.list.removeEventListener("scroll", a.onMove);
    window.removeEventListener("resize", a.onMove);
    if (a.ro) a.ro.disconnect();
    if (a.mo) a.mo.disconnect();
    try { if (card.matches(":popover-open")) card.hidePopover(); } catch (_) { /* gone already */ }
    card.removeAttribute("popover");
    for (const k of ASK_VARS) card.style.removeProperty(k);
    a.spacer.remove();
}

/** Lays the open question over its spacer and clips it to the chat's scroll box; the spacer takes the card's height. */
function place(card) {
    const a = asks.get(card);
    if (!a) return;
    if (!card.isConnected || !a.spacer.isConnected) { releaseAsk(card); return; }
    const panel = card.closest("#assistant");
    const show = !panel || panel.open;
    try {
        if (show && !card.matches(":popover-open")) card.showPopover();
        else if (!show && card.matches(":popover-open")) card.hidePopover();
    } catch (err) {
        console.warn("skins: the question's popover", err);
    }
    if (!show) return;
    // inline and !important: only an element's own !important value beats a skin's !important rule on it
    const same = (el, k, v) => el.style.getPropertyValue(k) === v && el.style.getPropertyPriority(k) === "important";
    const s = a.spacer.getBoundingClientRect();
    const x = s.left + "px", y = s.top + "px", w = s.width + "px";
    if (!same(card, "--ask-left", x)) card.style.setProperty("--ask-left", x, "important");
    if (!same(card, "--ask-top", y)) card.style.setProperty("--ask-top", y, "important");
    if (!same(card, "--ask-width", w)) card.style.setProperty("--ask-width", w, "important");
    const h = card.getBoundingClientRect().height;
    if (!same(a.spacer, "height", h + "px")) a.spacer.style.setProperty("height", h + "px", "important");
    const v = scrollBox(a.list);
    const top = Math.max(0, v.top - s.top), left = Math.max(0, v.left - s.left);
    const bottom = Math.max(0, s.top + h - v.bottom), right = Math.max(0, s.left + s.width - v.right);
    const clip = top || left || bottom || right ? `inset(${top}px ${right}px ${bottom}px ${left}px)` : "none";
    if (!same(card, "--ask-clip", clip)) card.style.setProperty("--ask-clip", clip, "important");
}

function tick(card) {
    if (!asks.has(card)) return;
    if (!card.isConnected || !hasOpenButton(card)) { releaseAsk(card); return; }
    place(card);
    if (state && state.active) guardAsk(card, { scroll: false });
}

/** What of an element's box its content can be seen through: the padding box without the scroll bars. */
function scrollBox(el) {
    const r = el.getBoundingClientRect();
    const left = r.left + el.clientLeft, top = r.top + el.clientTop;
    return { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight, width: el.clientWidth, height: el.clientHeight };
}

const waiting = new WeakSet();

/** Checks the card again once the reason to wait is gone: the window shown, the modal dialog closed, the panel open. */
function defer(card, modal, panel) {
    if (waiting.has(card)) return;
    waiting.add(card);
    const again = () => { waiting.delete(card); guardAsk(card); };
    if (document.visibilityState !== "visible") document.addEventListener("visibilitychange", again, { once: true });
    else if (modal) modal.addEventListener("close", again, { once: true });
    else if (panel) {
        const watch = new MutationObserver(() => { if (panel.open) { watch.disconnect(); again(); } });
        watch.observe(panel, { attributes: true, attributeFilter: ["open"] });
    }
}

/**
 * Why the user could not see or answer the card, or null when they can. `scroll`: bring the question into view first
 * and check that both buttons can be clicked there (when it appears, on a skin switch); without it (the check every
 * CHECK_EVERY ms) the user may have scrolled the chat, so only what the skin decides is checked: the chat's size and
 * place, and the buttons that are in view.
 */
function askProblem(card, scroll) {
    const a = asks.get(card);
    const parts = partsOf(card);
    if (typeof card.checkVisibility === "function" && !card.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return "the question is not visible";
    let alpha = 1;
    for (let n = card; n && n.nodeType === 1; n = n.parentElement) alpha *= parseFloat(getComputedStyle(n).opacity);
    if (!(alpha >= 0.99)) return `the question is faded (opacity ${alpha.toFixed(2)})`;
    if (scroll) {
        try { (a ? a.spacer : card).scrollIntoView({ block: "nearest" }); } catch (_) { /* a detached card */ }
        if (a) place(card);
    }
    const box = card.getBoundingClientRect();
    if (box.width < 160 || box.height < 24) return `the question is too small (${Math.round(box.width)} x ${Math.round(box.height)} px)`;
    const buttons = Array.from(parts.querySelectorAll(".as-card-buttons button"));
    const allow = buttons.find((b) => b.textContent.trim() === "Allow");
    const deny = buttons.find((b) => b.textContent.trim() === "Don't");
    if (!allow || !deny) return "the question's buttons are not Allow and Don't";
    const list = card.closest(".as-list");
    const lb = list ? scrollBox(list) : null;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    if (lb && !scroll) {
        if (lb.width < 160 || lb.height < Math.min(box.height, MIN_CHAT_HEIGHT)) return `the chat is too small to show the question (${Math.round(lb.width)} x ${Math.round(lb.height)} px)`;
        if (lb.right < 1 || lb.bottom < 1 || lb.left > vw - 1 || lb.top > vh - 1) return "the chat is outside the window";
    }
    const inside = (r, b) => r.left >= b.left - 1 && r.top >= b.top - 1 && r.right <= b.right + 1 && r.bottom <= b.bottom + 1;
    for (const [b, label] of [[allow, "Allow"], [deny, "Don't"]]) {
        const r = b.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return `the ${label} button is too small`;
        const inChat = !lb || inside(r, lb), inWindow = inside(r, { left: 0, top: 0, right: vw, bottom: vh });
        if (scroll && !inChat) return `the ${label} button is outside the chat`;
        if (scroll && !inWindow) return `the ${label} button is outside the window`;
        if (!inChat || !inWindow) continue;
        // in the top layer only another top-layer element can cover it, and guardAsk waits while a modal dialog is open
        const hit = (card.shadowRoot || document).elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || !b.contains(hit)) return `something covers the ${label} button`;
    }
    if (!(allow.getBoundingClientRect().left < deny.getBoundingClientRect().left)) return "Allow does not come before Don't";
    return null;
}

/**
 * The check of what is left to a skin (protectAsk draws the question itself out of its reach): can the user see the
 * assistant's question and reach both buttons under the skin in use? True when so, or in the default look (nothing to
 * check, so this can never loop); false when not, and the skin is switched off; null while it waits (the window hidden,
 * a modal dialog open, the panel closed) - it checks again when that is over. `scroll: false` is the repeated check
 * while the question is open (askProblem).
 */
export function guardAsk(card, { scroll = true } = {}) {
    if (!state || !state.active) return true;
    if (!card || !card.isConnected || !hasOpenButton(card)) return true;
    if (refusing) return false;
    const panel = card.closest("#assistant");
    const modal = document.querySelector("dialog:modal");
    if (document.visibilityState !== "visible" || modal || (panel && !panel.open)) {
        defer(card, modal, panel);
        return null;
    }
    const why = askProblem(card, scroll);
    if (!why) return true;
    refuse(state.active, why, true).catch((err) => console.warn("skins: switching off", err));
    return false;
}

// ---- Settings › Appearance ------------------------------------------------------------------

/** Fills Settings › Appearance (#set-skins): the default look and every skin folder, a radio each. */
export async function renderAppearance(u) {
    if (u) ui = u;
    if (!ui || !ui.skins) return;
    if (!ui.skins.dataset.bound) {
        ui.skins.dataset.bound = "1";
        // the note beside them may grow long; the buttons keep their one line
        ui.skinsReload.style.flexShrink = "0";
        ui.skinsFolder.style.flexShrink = "0";
        ui.skinsReload.addEventListener("click", async () => {
            ui.skinsReload.disabled = true;
            ui.skinsNote.textContent = "reloading ...";
            try { await reloadSkins(); flash = "reloaded"; } catch (err) { flash = errText(err); }
            finally { ui.skinsReload.disabled = false; render(); }
        });
        ui.skinsFolder.addEventListener("click", () => window.scumble.plugins.openFolder());
    }
    try {
        state = await appearance().get();
    } catch (err) {
        ui.skinsNote.textContent = errText(err);
        return;
    }
    render();
}

function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

function render() {
    if (!ui || !ui.skins || !state) return;
    const box = ui.skins;
    box.replaceChildren();
    // what the user should know before choosing: above the list, in full
    const parts = [];
    if (state.noSkinFlag) parts.push("Scumble was started with --no-skin: the default look is in use, and the choice here applies at the next start without it.");
    else if (state.skin && !state.active) parts.push(`The skin "${state.skin}" was not found or cannot be used; the default look is in use.`);
    if (note && !parts.includes(note)) parts.push(note);
    if (parts.length) box.appendChild(node("p", "shell-help", parts.join(" ")));
    box.appendChild(row({ id: "", name: "Default", description: "the look Scumble ships with", skin: { swatch: DEFAULT_SWATCH }, warnings: [] }, true));
    for (const s of state.skins || []) box.appendChild(row(s, false));
    ui.skinsNote.textContent = flash;
    ui.skinsNote.title = flash;
}

function row(s, isDefault) {
    const inUse = isDefault ? !state.active : state.active === s.id;
    const chosen = state.noSkinFlag ? (state.skin || "") === s.id : (state.active || "") === s.id;
    const refused = !isDefault && state.refused && state.refused.id === s.id ? state.refused : null;
    const newer = !isDefault && s.skin && s.skin.tokens > (state.tokens || 1);
    const el = node("div", "shell-plugin");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "skin";
    radio.value = s.id;
    radio.checked = chosen;
    radio.disabled = !!s.error;
    radio.style.marginTop = "3px";
    radio.title = s.error ? "This skin has an error and cannot be chosen" : isDefault ? "Use the default look" : "Use this skin";
    radio.addEventListener("change", () => {
        if (!radio.checked) return;
        applySkin(s.id).catch(() => { /* the note says why */ }).finally(render);
    });
    el.appendChild(radio);
    const body = node("div");
    const name = node("div", "shell-plugin-name", s.name || s.id);
    if (!isDefault) name.appendChild(node("small", null, [s.version, s.author, s.source === "builtin" ? "built-in" : "user folder"].filter(Boolean).join(" · ")));
    body.appendChild(name);
    if (s.description) body.appendChild(node("div", "shell-plugin-desc", s.description));
    const swatch = s.skin && Array.isArray(s.skin.swatch) ? s.skin.swatch : [];
    if (swatch.length) {
        const chips = node("div");
        for (const c of swatch) {
            if (!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(c)) continue;
            const chip = node("span");
            chip.title = c;
            chip.style.cssText = `display:inline-block;width:14px;height:14px;border:1px solid var(--sc-line, #333);border-radius:2px;margin-right:3px;background:${c}`;
            chips.appendChild(chip);
        }
        body.appendChild(chips);
    }
    if (s.error) body.appendChild(node("div", "shell-plugin-error", s.error));
    if (refused) body.appendChild(node("div", "shell-plugin-error", `Switched off ${new Date(refused.at || Date.now()).toLocaleString()}: ${refused.reason || ""}. Choose it again to give it another try.`));
    for (const w of s.warnings || []) body.appendChild(node("div", "shell-plugin-error", w));
    if (inUse && !isDefault) for (const w of findings) body.appendChild(node("div", "shell-plugin-error", w));
    el.appendChild(body);
    const st = s.error ? ["error", " bad"] : inUse ? ["in use", ""] : refused ? ["switched off", " bad"] : newer ? ["made for a newer Scumble", " off"] : ["available", " off"];
    const stateEl = node("span", "shell-plugin-state" + st[1], st[0]);
    stateEl.title = s.dir || "";
    el.appendChild(stateEl);
    return el;
}
