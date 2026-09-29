// The prompt field of the app (item 26, docs/PLAN_REFS.md 26c and C4): a contenteditable that the rest of the editor
// reads like the textarea it replaces (`value`, the selection, `setSelectionRange`, `input` and `change`), and that
// draws each @img token of the prompt as a chip: a round thumbnail, the label, a chevron. The text stays a plain
// string (reftokens.js C1); the DOM is only its drawing, built again from the text whenever the two would differ.
//
// Plain typing is left to the browser, so dead keys, IMEs and the caret keep their own feel. Every edit that could touch
// a chip or leave markup behind is made here on the string and drawn again: Enter, a delete next to a chip, paste, cut,
// typing over a selection. A chip is one unit: the caret steps over it, Backspace and Delete take it whole. Where no
// text stands next to a chip, a text node holding one U+200B (a guard) gives Chromium a place for the caret; the string
// never holds one. The field keeps its own undo, since the browser's does not survive a redraw.
//
// In the node's FILES (tools/build_node.py), although only the app builds it (its host's `refTokens`). Nothing touches
// `document` or `window` at import time, so tools/prompt_field_test.js runs the helpers in plain Node.

import { parse, normalize, hasTokens, diffRange, mapOffset } from "./reftokens.js";

export { diffRange, mapOffset };

/** The caret guard: an invisible character Chromium can put the caret beside. Never part of the text. */
export const GUARD = String.fromCharCode(0x200b);
const GUARDS = new RegExp(GUARD, "g");
// besides white space, the characters after which an @ starts a word: brackets and the opening quotes (" ' „ “ ‚ «)
const OPENERS = new Set(["(", "[", "{", "\"", "'", String.fromCharCode(0x201e), String.fromCharCode(0x201c), String.fromCharCode(0x201a), String.fromCharCode(0xab)]);

/**
 * A text as the field holds it: line breaks as LF, no caret guards, every token's prefix in lower case (C1 `normalize`).
 * @param {unknown} text
 * @returns {string}
 */
export function sanitize(text) {
    return normalize(String(text == null ? "" : text).replace(/\r\n?/g, "\n").replace(GUARDS, ""));
}

/**
 * Does offset `i` start a word, so that an @ typed there may open the picker? At the start of the text, after white
 * space (a line break too), an opening bracket or an opening quote; `mail@` is no word start.
 * @param {string} text
 * @param {number} i
 */
export function atWordStart(text, i) {
    if (i <= 0) return true;
    const c = String(text == null ? "" : text)[i - 1];
    return c === undefined || /\s/.test(c) || OPENERS.has(c);
}

let segmenter;
function graphemes() {
    if (segmenter === undefined) {
        try { segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" }); } catch (_) { segmenter = null; }
    }
    return segmenter;
}
// no grapheme is longer than this: one step never segments a long text whole
const WINDOW = 64;
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/** where the grapheme that ends at offset i starts */
function graphemeStart(text, i) {
    if (i <= 0) return 0;
    const seg = graphemes();
    if (!seg) return i - (i >= 2 && isLow(text.charCodeAt(i - 1)) && isHigh(text.charCodeAt(i - 2)) ? 2 : 1);
    const from = Math.max(0, i - WINDOW);
    let last = 0;
    for (const g of seg.segment(text.slice(from, i))) last = g.index;
    return from + last;
}

/** where the grapheme that starts at offset i ends */
function graphemeEnd(text, i) {
    if (i >= text.length) return text.length;
    const seg = graphemes();
    if (!seg) return i + (i + 1 < text.length && isHigh(text.charCodeAt(i)) && isLow(text.charCodeAt(i + 1)) ? 2 : 1);
    for (const g of seg.segment(text.slice(i, i + WINDOW))) return i + g.segment.length;
    return i + 1;
}

/**
 * What Backspace deletes and ArrowLeft steps over from `caret`: a whole chip when one ends there (or holds the caret),
 * else one grapheme. `segs` is the field's render plan (`renderPlan`): only the tokens it draws as chips are units, so a
 * token still being typed goes a character at a time.
 * @param {string} text
 * @param {number} caret
 * @param {ReturnType<typeof renderPlan> | null} segs
 * @returns {[number, number]}
 */
export function unitBefore(text, caret, segs) {
    const s = String(text == null ? "" : text);
    const c = Math.max(0, Math.min(Number(caret) || 0, s.length));
    for (const g of segs || []) if (g.type === "chip" && g.start < c && c <= g.end) return [g.start, g.end];
    return [graphemeStart(s, c), c];
}

/**
 * What Delete deletes and ArrowRight steps over from `caret`, as `unitBefore` the other way.
 * @param {string} text
 * @param {number} caret
 * @param {ReturnType<typeof renderPlan> | null} segs
 * @returns {[number, number]}
 */
export function unitAfter(text, caret, segs) {
    const s = String(text == null ? "" : text);
    const c = Math.max(0, Math.min(Number(caret) || 0, s.length));
    for (const g of segs || []) if (g.type === "chip" && g.start <= c && c < g.end) return [g.start, g.end];
    return [c, graphemeEnd(s, c)];
}

/** @typedef {{ text: string, start: number, end: number }} FieldState */

const copyState = (e) => ({ text: String(e.text), start: e.start, end: e.end });

/**
 * The field's own undo (C4). Entries are whole states `{text, start, end}`; a step is recorded with the state before
 * and after it. Typing ("type") and deleting ("delete") merge into the step before when they follow it within
 * `mergeMs` with the caret where that step left it, and typing breaks at white space, so an undo takes back a word, as
 * in a textarea. Every other kind is a step of its own. At most `cap` steps are kept.
 */
export class EditHistory {
    constructor({ cap = 200, mergeMs = 1000 } = {}) {
        this.cap = cap;
        this.mergeMs = mergeMs;
        /** @type {FieldState[]} */
        this.undoStack = [];
        /** @type {FieldState[]} */
        this.redoStack = [];
        // the step that is still open for merging: its kind, when it was last extended, the state it left
        this.last = null;
    }

    get undoCount() { return this.undoStack.length; }
    get redoCount() { return this.redoStack.length; }

    /**
     * One edit, `prev` -> `next`. Returns true when it became a step of its own, false when it merged into the one
     * before or changed no text (a caret move is no step).
     * @param {FieldState} prev
     * @param {FieldState} next
     * @param {string} [kind] "type" and "delete" merge; anything else ("set", "paste", "line", ...) does not
     * @param {number} [now]
     */
    record(prev, next, kind = "set", now = Date.now()) {
        if (!prev || !next || prev.text === next.text) return false;
        const merging = kind === "type" || kind === "delete";
        let space = false;
        if (kind === "type") {
            const d = diffRange(prev.text, next.text);
            space = /^\s/.test(next.text.slice(d.start, d.endB));
        }
        const l = this.last;
        if (merging && l && l.kind === kind && now - l.time < this.mergeMs && l.next.text === prev.text
            && l.next.start === prev.start && l.next.end === prev.end && !(space && !l.space)) {
            this.last = { kind, time: now, next: copyState(next), space };
            return false;
        }
        this.undoStack.push(copyState(prev));
        if (this.undoStack.length > this.cap) this.undoStack.splice(0, this.undoStack.length - this.cap);
        this.redoStack.length = 0;
        this.last = merging ? { kind, time: now, next: copyState(next), space } : null;
        return true;
    }

    /**
     * The state before the last step, or null when there is none; `cur` goes onto the redo stack.
     * @param {FieldState} cur
     */
    undo(cur) {
        if (!this.undoStack.length) return null;
        const e = this.undoStack.pop();
        this.redoStack.push(copyState(cur));
        this.last = null;
        return copyState(e);
    }

    /**
     * The state the last undo left, or null; `cur` goes back onto the undo stack.
     * @param {FieldState} cur
     */
    redo(cur) {
        if (!this.redoStack.length) return null;
        const e = this.redoStack.pop();
        this.undoStack.push(copyState(cur));
        this.last = null;
        return copyState(e);
    }

    /** No steps any more (a document opened, a snapshot restored). */
    reset() {
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.last = null;
    }

    /**
     * Every kept state through a text-to-text function (a remap of the tokens, docs/PLAN_REFS.md C2), its caret carried
     * through the change (`mapOffset`); no step is added. So an undo after a remap gives the older text with the tokens
     * that name the same pictures now.
     * @param {(text: string) => string} fn
     */
    map(fn) {
        for (const stack of [this.undoStack, this.redoStack]) {
            for (const e of stack) {
                const t = fn(e.text);
                if (typeof t !== "string" || t === e.text) continue;
                e.start = mapOffset(e.start, e.text, t);
                e.end = mapOffset(e.end, e.text, t);
                e.text = t;
            }
        }
        this.last = null;
    }
}

/**
 * @typedef {{ id: string, label: number | null, name: string, visible: boolean, thumb: string | null, sentAs: string | null }} Descriptor
 * @typedef {{ refs: Descriptor[], cap: number | null, none: string | null, canAdd: boolean, reason: (id: string) => string }} RefContext
 */

/** a name cut for a chip: at most 14 characters (graphemes), the last an ellipsis when it was longer */
function cut(name, n = 14) {
    const s = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
    const seg = graphemes();
    const a = seg ? Array.from(seg.segment(s), (g) => g.segment) : Array.from(s);
    return a.length > n ? a.slice(0, n - 1).join("") + String.fromCharCode(0x2026) : a.join("");
}

/**
 * How a token is drawn (C4): `live` when a shown reference holds its label, `broken` when none does or its layer is
 * gone, `inactive` for a parked token whose layer is still a reference (hidden, or without pixels yet). `label` is what
 * the chip says, `reason` its tooltip, `ref` the reference's descriptor.
 * @param {{ n?: number, id?: string }} seg a token of `parse`
 * @param {RefContext | null} ctx
 * @returns {{ state: "live" | "inactive" | "broken", label: string, reason: string, ref: Descriptor | null }}
 */
export function chipState(seg, ctx) {
    const refs = (ctx && ctx.refs) || [];
    if (seg.n != null) {
        const d = refs.find((r) => r.label === seg.n);
        if (d) return { state: "live", label: "img" + seg.n, reason: "", ref: d };
        return { state: "broken", label: "img" + seg.n, reason: `no reference img${seg.n}`, ref: null };
    }
    const d = refs.find((r) => r.id === seg.id);
    if (d) {
        const reason = d.label != null ? `written for a hidden reference: it is img${d.label} now, name it as @img${d.label}`
            : d.visible ? "no pixels: this reference is not loaded" : "hidden: show it under References to send it";
        return { state: "inactive", label: cut(d.name || "reference"), reason, ref: d };
    }
    let why = "deleted";
    try { why = (ctx && typeof ctx.reason === "function" && ctx.reason(seg.id)) || why; } catch (_) { /* the default */ }
    return { state: "broken", label: "img?", reason: why, ref: null };
}

/**
 * @typedef {{ type: "text", text: string, start: number, end: number }} TextPiece
 * @typedef {{ type: "chip", text: string, token: string, start: number, end: number, n?: number, id?: string, state: string, label: string, reason: string, ref: Descriptor | null }} ChipPiece
 */

/**
 * The text as the field draws it: plain runs and chips with their offsets, in order. A token that overlaps `open`
 * ([start, end], the token being typed) stays text, so typing @img1 and then 2 gives @img12 and not a chip and a "2".
 * @param {string} text
 * @param {RefContext | null} ctx
 * @param {[number, number] | null} [open]
 * @returns {(TextPiece | ChipPiece)[]}
 */
export function renderPlan(text, ctx, open = null) {
    /** @type {(TextPiece | ChipPiece)[]} */
    const out = [];
    let at = 0;
    const addText = (t, start) => {
        const last = out[out.length - 1];
        if (last && last.type === "text") { last.text += t; last.end += t.length; }
        else out.push({ type: "text", text: t, start, end: start + t.length });
    };
    for (const seg of parse(text)) {
        const start = at, end = at + seg.text.length;
        at = end;
        if (seg.type === "token" && !(open && start < open[1] && end > open[0])) {
            const token = "@img" + seg.text.slice(4);
            /** @type {ChipPiece} */
            const chip = { type: "chip", text: seg.text, token, start, end, ...chipState(seg, ctx) };
            if ("n" in seg) chip.n = seg.n; else chip.id = seg.id;
            out.push(chip);
        } else addText(seg.text, start);
    }
    return out;
}

/**
 * What the DOM holds for a plan, child by child: text runs, guards where no text stands next to a chip (the start,
 * after a line break, between two chips, before a line break, the end), chips, and a trailing <br> when the text is
 * empty or ends in a line break (the last line has no height without it).
 */
function layoutOf(plan) {
    const items = [];
    for (let i = 0; i < plan.length; i++) {
        const s = plan[i];
        if (s.type === "text") { items.push({ kind: "text", text: s.text, start: s.start, end: s.end }); continue; }
        const prev = plan[i - 1], next = plan[i + 1];
        if (!prev || (prev.type === "text" && prev.text.endsWith("\n"))) items.push({ kind: "guard", at: s.start });
        items.push({ kind: "chip", seg: s, start: s.start, end: s.end, sig: chipSig(s) });
        if (!next || next.type === "chip" || next.text.startsWith("\n")) items.push({ kind: "guard", at: s.end });
    }
    const last = plan[plan.length - 1];
    if (!last || (last.type === "text" && last.text.endsWith("\n"))) items.push({ kind: "br" });
    return items;
}

const chipSig = (s) => [s.token, s.state, s.label, s.reason, s.ref ? s.ref.name : ""].join("\u0001");
const itemSig = (it) => (it.kind === "text" ? "t" + it.text : it.kind === "chip" ? "c" + it.sig : it.kind === "guard" ? "g" : "br");

function isChip(n) { return !!n && n.nodeType === 1 && n.classList && n.classList.contains("ipc-chip"); }

/** what a child of the field stands for, in the terms of itemSig: anything render() does not make is "x" */
function nodeSig(n) {
    if (n.nodeType === 3) return n.data === GUARD ? "g" : n.data.includes(GUARD) ? "x" : "t" + n.data;
    if (isChip(n)) return "c" + (n._sig || "");
    if (n.nodeName === "BR" && n.hasAttribute("data-trail")) return "br";
    return "x";
}

/**
 * What the DOM of the field reads as, up to the point (stopNode, stopOff) when one is given: text nodes without their
 * guards, a chip as its token, a trailing <br> as nothing and any other <br> as a line break, and whatever else a
 * native edit left behind by its children (a <div> starting a line). `dirty` says the DOM held such markup.
 */
function measure(root, stopNode = null, stopOff = 0) {
    let text = "", dirty = false, stop = false;
    const visit = (parent) => {
        const kids = parent.childNodes;
        for (let i = 0; i < kids.length && !stop; i++) {
            if (parent === stopNode && i === stopOff) { stop = true; return; }
            const c = kids[i];
            if (c.nodeType === 3) {
                if (c === stopNode) { text += c.data.slice(0, stopOff).replace(GUARDS, ""); stop = true; return; }
                text += c.data.replace(GUARDS, "");
            } else if (isChip(c)) {
                if (stopNode && (c === stopNode || c.contains(stopNode))) {
                    // a point on the chip: its start at the very front, else its end
                    const front = (c === stopNode && stopOff === 0) || (c.firstChild && c.firstChild.contains(stopNode));
                    if (!front) text += c.dataset.token || "";
                    stop = true;
                    return;
                }
                text += c.dataset.token || "";
            } else if (c.nodeName === "BR") {
                if (c === stopNode) { stop = true; return; }
                if (!c.hasAttribute("data-trail")) { text += "\n"; dirty = true; }
            } else if (c.nodeType === 1) {
                dirty = true;
                if (c.nodeName === "DIV" && text && !text.endsWith("\n")) text += "\n";
                visit(c);
            }
        }
        if (parent === stopNode) stop = true;
    };
    visit(root);
    return { text, dirty };
}

/** the offset in a text node's data before which `k` characters that are not guards stand */
function domIndex(data, k) {
    let c = 0;
    for (let i = 0; i < data.length; i++) {
        if (c === k) return i;
        if (data[i] !== GUARD) c++;
    }
    return data.length;
}

const EMPTY_CONTEXT = { refs: [], cap: null, none: null, canAdd: false, reason: () => "deleted" };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The field (C4). `el` is the contenteditable the editor keeps as `promptInput`. `refs()` answers the RefContext the
 * chips are drawn from; `popupRoot`, `addReferences` and `preview` are for the picker, the bar and the hover card
 * (26c2).
 */
export class PromptField {
    constructor({ placeholder = "", refs = null, popupRoot = null, addReferences = null, preview = null } = {}) {
        this.refs = typeof refs === "function" ? refs : () => EMPTY_CONTEXT;
        this.popupRoot = popupRoot;
        this.addReferencesFn = addReferences;
        this.preview = preview;
        this.text = "";
        this.anchor = 0;          // the selection as model offsets, kept while the field has no focus (as a textarea's)
        this.focusOff = 0;
        this.open = null;         // [start, end] of the token being typed, drawn as text until the caret leaves it
        this.composing = false;
        this.queued = [];         // the setText calls that came during a composition, in order
        this.dirty = false;       // a native edit left markup render() does not make
        this.pre = null;          // the state before the edit in progress (beforeinput, compositionstart)
        this.nativePending = false;
        this.firing = false;
        this.pointerHeld = false;
        this.fromPointer = false;
        this.renderAfterPointer = false;
        this.autoSpace = null;    // the offset of a space the field put between a typed word and a chip (spaced)
        this.focusText = null;
        this.history = new EditHistory();
        this.plan = [];
        this.runs = [];
        this.destroyed = false;
        const el = document.createElement("div");
        el.className = "ipc-pf";
        el.contentEditable = "plaintext-only";
        el.setAttribute("role", "textbox");
        el.setAttribute("aria-multiline", "true");
        el.spellcheck = false;
        el.setAttribute("autocorrect", "off");
        el.setAttribute("autocapitalize", "off");
        el.setAttribute("translate", "no");
        el.dataset.placeholder = String(placeholder || "");
        this.el = el;
        this.defineApi();
        this.listen();
        this.render();
    }

    // ---- the textarea's API on the element --------------------------------------------------------------------------

    defineApi() {
        const f = this;
        Object.defineProperties(this.el, {
            value: {
                configurable: true,
                get() { return f.composing ? f.pendingValue() : f.nativePending ? sanitize(measure(f.el).text) : f.text; },
                set(v) { f.setText(v, { history: "push" }); },
            },
            selectionStart: {
                configurable: true,
                get() { return f.readSel()[0]; },
                set(v) { const e = f.readSel()[1]; f.setSelectionRange(v, Math.max(Number(v) || 0, e)); },
            },
            selectionEnd: {
                configurable: true,
                get() { return f.readSel()[1]; },
                set(v) { const s = f.readSel()[0]; f.setSelectionRange(Math.min(s, Number(v) || 0), v); },
            },
            selectionDirection: {
                configurable: true,
                get() { f.readSel(); return f.focusOff < f.anchor ? "backward" : "forward"; },
            },
            setSelectionRange: { configurable: true, value: (s, e, dir) => f.setSelectionRange(s, e, dir) },
            select: { configurable: true, value: () => f.setSelectionRange(0, f.text.length) },
            placeholder: {
                configurable: true,
                get() { return f.el.dataset.placeholder || ""; },
                set(v) { f.el.dataset.placeholder = String(v == null ? "" : v); },
            },
            disabled: {
                configurable: true,
                get() { return f.el.getAttribute("aria-disabled") === "true"; },
                set(v) {
                    f.el.contentEditable = v ? "false" : "plaintext-only";
                    if (v) f.el.setAttribute("aria-disabled", "true"); else f.el.removeAttribute("aria-disabled");
                },
            },
        });
    }

    hasFocus() {
        return typeof document !== "undefined" && document.activeElement === this.el;
    }

    /** The model offsets of the document selection when it lies in the field, [anchor, focus]; else null. */
    domSel() {
        const s = document.getSelection();
        if (!s || !s.anchorNode || !this.el.contains(s.anchorNode) || !this.el.contains(s.focusNode)) return null;
        return [this.domToOffset(s.anchorNode, s.anchorOffset), this.domToOffset(s.focusNode, s.focusOffset)];
    }

    /** The selection [start, end]: read from the document while the field has the focus, else the one it kept. */
    readSel() {
        if (this.hasFocus()) {
            const d = this.domSel();
            if (d) { this.anchor = d[0]; this.focusOff = d[1]; }
        }
        const n = this.text.length;
        this.anchor = clamp(this.anchor, 0, n);
        this.focusOff = clamp(this.focusOff, 0, n);
        return [Math.min(this.anchor, this.focusOff), Math.max(this.anchor, this.focusOff)];
    }

    /** an offset inside a chip goes to the chip's nearer edge, or to its end (`toEnd`: text typed into it) */
    snap(off, toEnd = false) {
        for (const g of this.plan) if (g.type === "chip" && g.start < off && off < g.end) return toEnd || off - g.start > g.end - off ? g.end : g.start;
        return off;
    }

    /**
     * As a textarea's: stored, and put into the document only when the field has the focus (placing the document
     * selection in a contenteditable focuses it, which would take the focus from the assistant's chat during an
     * agent's set_prompt).
     */
    setSelectionRange(start, end, dir = "none") {
        const n = this.text.length;
        let a = clamp(Number(start) || 0, 0, n);
        const b = clamp(end == null ? a : Number(end) || 0, 0, n);
        if (a > b) a = b;
        const s = this.snap(a), e = this.snap(b);
        if (dir === "backward") { this.anchor = e; this.focusOff = s; } else { this.anchor = s; this.focusOff = e; }
        if (this.hasFocus()) this.applySel();
        this.markSel();
    }

    /** anchor and focus as given (an arrow key with Shift moves only the focus) */
    setSel(anchor, focus) {
        const n = this.text.length;
        this.anchor = this.snap(clamp(anchor, 0, n));
        this.focusOff = this.snap(clamp(focus, 0, n));
        if (this.hasFocus()) this.applySel();
        this.markSel();
    }

    /** the kept selection into the document */
    applySel() {
        const s = document.getSelection();
        if (!s) return;
        const [an, ao] = this.offsetToDom(this.anchor), [fn, fo] = this.offsetToDom(this.focusOff);
        if (s.anchorNode === an && s.anchorOffset === ao && s.focusNode === fn && s.focusOffset === fo) return;
        try { s.setBaseAndExtent(an, ao, fn, fo); } catch (_) { /* a node that just left the field */ }
    }

    /** The model offset of a DOM point in the field: the length of what the field reads before it. */
    domToOffset(node, o) {
        if (node === this.el && !this.dirty) {
            // the common case after a render: the runs know where each child starts
            const kid = this.el.childNodes[o];
            if (!kid) return this.text.length;
            const r = this.runs.find((x) => x.node === kid);
            if (r) return r.start;
        }
        if (node && node.nodeType === 3 && node.parentNode === this.el && !this.nativePending && !this.composing) {
            const r = this.runs.find((x) => x.node === node);
            if (r) return r.start + node.data.slice(0, o).replace(GUARDS, "").length;
        }
        return measure(this.el, node, o).text.length;
    }

    /** The DOM point for a model offset; at a chip's edge the guard beside it wins over the text. */
    offsetToDom(off) {
        let pick = null;
        for (const r of this.runs) {
            if (r.kind === "chip" || off < r.start || off > r.end) continue;
            if (r.kind === "guard") { pick = r; break; }
            if (!pick) pick = r;
        }
        if (!pick) {
            // an offset inside a chip (never one render leaves): the chip's nearer edge, not the field's start
            const chip = this.runs.find((r) => r.kind === "chip" && r.start < off && off < r.end);
            return chip ? this.offsetToDom(off - chip.start <= chip.end - off ? chip.start : chip.end) : [this.el, 0];
        }
        if (pick.kind === "guard") return [pick.node, Math.min(1, pick.node.data.length)];
        return [pick.node, domIndex(pick.node.data, off - pick.start)];
    }

    /** chips inside the selection get an outline: ::selection does not paint them */
    markSel() {
        const s = Math.min(this.anchor, this.focusOff), e = Math.max(this.anchor, this.focusOff);
        for (const r of this.runs) if (r.kind === "chip") r.node.classList.toggle("ipc-in-sel", s < e && r.start >= s && r.end <= e);
    }

    /** the state for the undo: the text and the selection */
    state() {
        const [s, e] = this.readSel();
        return { text: this.text, start: s, end: e };
    }

    // ---- drawing -----------------------------------------------------------------------------------------------------

    /** the context for the chips; asked only when the text has a token (the editor may not be built yet) */
    context() {
        if (!hasTokens(this.text)) return EMPTY_CONTEXT;
        try { return this.refs() || EMPTY_CONTEXT; } catch (_) { return EMPTY_CONTEXT; }
    }

    /**
     * The DOM from the text. When the field already holds exactly what the text draws as (a native edit that typed
     * into a run), only the runs are read again; otherwise the children are built anew and the selection put back.
     * A selection end that a chip formed around goes to the chip's edge (`typed`: to its end, after what was typed).
     */
    render({ typed = false } = {}) {
        if (this.destroyed) return;
        if (this.composing) { this.needRender = true; return; }
        this.needRender = false;
        const plan = renderPlan(this.text, this.context(), this.open);
        const items = layoutOf(plan);
        this.plan = plan;
        this.anchor = this.snap(this.anchor, typed);
        this.focusOff = this.snap(this.focusOff, typed);
        const el = this.el;
        const kids = el.childNodes;
        const same = !this.dirty && kids.length === items.length && items.every((it, i) => itemSig(it) === nodeSig(kids[i]));
        this.runs = [];
        if (same) {
            items.forEach((it, i) => { if (it.kind !== "br") this.runs.push(this.run(it, kids[i])); });
        } else {
            const frag = document.createDocumentFragment();
            for (const it of items) {
                let node;
                if (it.kind === "text") node = document.createTextNode(it.text);
                else if (it.kind === "guard") node = document.createTextNode(GUARD);
                else if (it.kind === "chip") node = this.chipNode(it.seg, it.sig);
                else { node = document.createElement("br"); node.setAttribute("data-trail", ""); }
                frag.appendChild(node);
                if (it.kind !== "br") this.runs.push(this.run(it, node));
            }
            el.replaceChildren(frag);
            this.dirty = false;
            if (this.hasFocus()) this.applySel();
        }
        el.classList.toggle("ipc-pf-empty", !this.text);
        this.markSel();
    }

    run(it, node) {
        if (it.kind === "guard") return { kind: "guard", node, start: it.at, end: it.at };
        return { kind: it.kind, node, start: it.start, end: it.end };
    }

    chipNode(seg, sig) {
        const c = document.createElement("span");
        c.className = "ipc-chip";
        c.contentEditable = "false";
        c.draggable = false;
        c.dataset.token = seg.token;
        c.dataset.state = seg.state;
        c.dataset.scTrigger = "@";
        c.dataset.scMentionType = "img";
        const key = seg.ref ? seg.ref.id : seg.id || "";
        if (key) c.dataset.scMentionKey = key;
        const name = seg.ref && seg.ref.name ? seg.ref.name : "";
        c.setAttribute("aria-label", `reference ${seg.label}${name && name !== seg.label ? ", " + name : ""}${seg.reason ? ": " + seg.reason : ""}`);
        // 26c1: the tooltip until 26c2's hover card takes its place
        c.title = seg.reason ? `${seg.label}: ${seg.reason}` : name ? `${seg.label}: ${name}` : seg.label;
        c._sig = sig;
        const at = document.createElement("span");
        at.className = "ipc-chip-at";
        at.textContent = "@";
        const av = document.createElement("img");
        av.className = "ipc-chip-av";
        av.alt = "";
        av.draggable = false;
        const thumb = seg.ref && seg.ref.thumb;
        if (thumb) av.src = thumb; else av.hidden = true;
        const lab = document.createElement("span");
        lab.className = "ipc-chip-label";
        lab.textContent = seg.label;
        const chev = document.createElement("button");
        chev.type = "button";
        chev.className = "ipc-chip-chev";
        chev.tabIndex = -1;
        chev.setAttribute("aria-label", "Swap");
        // the swap menu is 26c2; a press on the chevron keeps the caret where it is
        chev.addEventListener("mousedown", (e) => e.preventDefault());
        c.append(at, av, lab, chev);
        return c;
    }

    /** The chips drawn again when a reference changed (a state, a label, a name); a thumbnail alone is swapped in place. */
    refresh() {
        if (this.destroyed) return;
        if (this.composing) { this.needRender = true; return; }
        this.render();
        this.updateThumbs();
    }

    /** The thumbnails of the chips of these layers (all when no ids are given) from the context, without a render. */
    updateThumbs(ids = null) {
        if (this.destroyed || !this.runs.some((r) => r.kind === "chip")) return;
        const ctx = this.context();
        const want = ids ? new Set(ids) : null;
        for (const r of this.runs) {
            if (r.kind !== "chip") continue;
            const key = r.node.dataset.scMentionKey;
            if (!key || (want && !want.has(key))) continue;
            const d = ctx.refs.find((x) => x.id === key);
            const img = r.node.querySelector("img.ipc-chip-av");
            if (!img) continue;
            const thumb = d && d.thumb;
            if (thumb) { if (img.getAttribute("src") !== thumb) img.src = thumb; img.hidden = false; }
            else img.hidden = true;
        }
    }

    // ---- writing -----------------------------------------------------------------------------------------------------

    /**
     * The text set from code (C4): no input or change event, as a textarea's value. `keepCaret`: the selection is
     * carried through the change (`mapOffset`); else it goes to the end, as a textarea's does. `history`: "push" makes
     * the write a step of the field's undo (Upsample, Revert, an agent's set_prompt), "reset" empties the undo (a
     * document opened, a snapshot restored), a text-to-text function is applied to the undo's states without a step (a
     * remap). "reset" and a remap reach the undo even when the text stays the same (a remap may change only what an
     * older state names). Writes during a composition wait for its end and are replayed in order there: an explicit
     * write replaces the composed text, a remap is applied to whatever stands then.
     */
    setText(text, { keepCaret = false, history = "push" } = {}) {
        if (this.destroyed) return;
        const next = sanitize(text);
        if (this.composing) {
            this.queued.push({ text: next, keepCaret, history });
            return;
        }
        const remap = typeof history === "function";
        if (history === "reset") this.history.reset();
        else if (remap) this.history.map(history);
        if (next === this.text) return;
        const [ps, pe] = this.readSel();
        const s = keepCaret ? mapOffset(ps, this.text, next) : next.length;
        const e = keepCaret ? mapOffset(pe, this.text, next) : next.length;
        if (history !== "reset" && !remap) this.history.record({ text: this.text, start: ps, end: pe }, { text: next, start: s, end: e }, "set");
        const backward = this.focusOff < this.anchor;
        this.text = next;
        this.open = null;
        this.autoSpace = null;
        this.anchor = backward ? e : s;
        this.focusOff = backward ? s : e;
        this.render();
        if (this.hasFocus()) this.applySel();
    }

    /** While composing: the text the queued writes will leave, on what the DOM holds now (the editor reads this). */
    pendingValue() {
        let t = sanitize(measure(this.el).text);
        for (const q of this.queued) t = typeof q.history === "function" ? sanitize(q.history(t)) : q.text;
        return t;
    }

    /** an input event for an edit made here (the browser's own is cancelled with the beforeinput) */
    fire(inputType, data = null) {
        this.firing = true;
        try { this.el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data })); } finally { this.firing = false; }
    }

    /**
     * The token being typed after an edit that left the caret at `caret`: the one that ends at the caret when the edit
     * started inside it, or when it was the one being typed before (a Backspace in @img12 keeps @img1 open).
     */
    openAfter(prevText, next, caret) {
        const { start } = diffRange(prevText, next);
        let at = 0;
        for (const seg of parse(next)) {
            const s = at, e = at + seg.text.length;
            at = e;
            if (seg.type !== "token" || e !== caret) continue;
            if ((s <= start && start < e) || (this.open && this.open[0] === s)) return [s, e];
        }
        return null;
    }

    /**
     * One edit made here: [s, t) of the text becomes `ins`, the caret after it, one undo step (merged by `kind`), the
     * DOM drawn again and an input event of `inputType`.
     */
    edit(s, t, ins, kind, inputType, data = null) {
        const prev = this.pre || this.state();
        this.pre = null;
        const clean = String(ins == null ? "" : ins).replace(/\r\n?/g, "\n").replace(GUARDS, "");
        const { pre, post } = this.spaced(s, t, clean);
        const next = normalize(this.text.slice(0, s) + pre + clean + post + this.text.slice(t));
        const caret = s + pre.length + clean.length;
        this.autoSpace = post && kind === "type" ? caret : null;
        if (next === this.text) { this.setSel(caret, caret); return false; }
        this.history.record(prev, { text: next, start: caret, end: caret }, kind);
        this.open = kind === "type" || kind === "delete" ? this.openAfter(this.text, next, caret) : null;
        this.text = next;
        this.anchor = this.focusOff = caret;
        this.render({ typed: !!clean });
        if (this.hasFocus()) this.applySel();
        this.fire(inputType, data);
        return true;
    }

    /**
     * The spaces text inserted at [s, t) needs against a chip: a word character right before a chip's @ or right after
     * its end would make the token plain text (C1: `x@img1` is none), so a space goes between. Typing against a chip
     * then keeps the chip instead of turning it into text and back at every letter.
     */
    spaced(s, t, ins) {
        const W = /[\w-]/;
        const chipAt = (key, at) => this.plan.some((g) => g.type === "chip" && g[key] === at);
        return {
            pre: ins && W.test(ins[0]) && chipAt("end", s) ? " " : "",
            post: ins && W.test(ins[ins.length - 1]) && chipAt("start", t) ? " " : "",
        };
    }

    /**
     * Would deleting [a, b) glue a word character to a chip? `@img1jacket` and `cat@img1` are no tokens (C1), and
     * `@img1 2` would become `@img12`: the chip would turn into text or into another number.
     */
    glues(a, b) {
        const W = /[\w-]/;
        const left = this.text[a - 1], right = this.text[b];
        return this.plan.some((g) => g.type === "chip" && ((g.end === a && right !== undefined && W.test(right)) || (g.start === b && left !== undefined && W.test(left))));
    }

    /** a range widened to whole chips */
    widen(a, b) {
        for (const g of this.plan) {
            if (g.type !== "chip") continue;
            if (a > g.start && a < g.end) a = g.start;
            if (b > g.start && b < g.end) b = g.end;
        }
        return [a, b];
    }

    undo() {
        const e = this.history.undo(this.state());
        if (!e) return false;
        this.restore(e, "historyUndo");
        return true;
    }

    redo() {
        const e = this.history.redo(this.state());
        if (!e) return false;
        this.restore(e, "historyRedo");
        return true;
    }

    restore(e, inputType) {
        this.text = e.text;
        this.open = null;
        this.autoSpace = null;
        this.anchor = e.start;
        this.focusOff = e.end;
        this.render();
        if (this.hasFocus()) this.applySel();
        this.markSel();
        this.fire(inputType);
    }

    // ---- events ------------------------------------------------------------------------------------------------------

    listen() {
        const el = this.el;
        el.addEventListener("beforeinput", (e) => this.onBeforeInput(e));
        el.addEventListener("input", (e) => this.onInput(e));
        el.addEventListener("keydown", (e) => this.onKeyDown(e));
        el.addEventListener("paste", (e) => this.onPaste(e));
        el.addEventListener("copy", (e) => this.onCopy(e, false));
        el.addEventListener("cut", (e) => this.onCopy(e, true));
        el.addEventListener("compositionstart", () => this.onCompositionStart());
        el.addEventListener("compositionend", () => this.onCompositionEnd());
        el.addEventListener("focus", () => this.onFocus());
        el.addEventListener("blur", () => this.onBlur());
        el.addEventListener("mousedown", (e) => {
            const chip = e.button === 0 && e.target && e.target.closest ? e.target.closest(".ipc-chip") : null;
            if (chip && el.contains(chip)) {
                // a chip holds no caret (the browser would leave it in the chip's label, where no key reaches the
                // field): a press puts it beside the chip, on the side that was pressed; the chevron keeps it where it is
                e.preventDefault();
                if (e.target.closest(".ipc-chip-chev")) return;
                const r = this.runs.find((x) => x.node === chip);
                if (!r) return;
                const box = chip.getBoundingClientRect();
                const off = e.clientX < box.left + box.width / 2 ? r.start : r.end;
                if (!this.hasFocus()) el.focus({ preventScroll: true });
                this.setSel(e.shiftKey ? this.anchor : off, off);
                return;
            }
            // the browser puts the caret where the press was: a focus that comes with it keeps that caret
            this.fromPointer = true;
            this.pointerHeld = true;
            setTimeout(() => { this.fromPointer = false; }, 0);
            window.addEventListener("mouseup", this.onPointerUp, true);
        });
        // a chip is not dragged in 26c1 (26c2 moves it); a selection dragged out copies its text
        el.addEventListener("dragstart", (e) => { if (e.target && isChip(e.target)) e.preventDefault(); });
        this.onSelChange = () => this.selectionChanged();
        this.onPointerUp = () => {
            window.removeEventListener("mouseup", this.onPointerUp, true);
            this.pointerHeld = false;
            if (this.renderAfterPointer) { this.renderAfterPointer = false; this.render(); }
            // what the drag left: a caret on a chip goes beside it (no selectionchange follows the release)
            if (this.hasFocus()) this.selectionChanged();
        };
    }

    /** Can the browser type this itself? A collapsed caret in a text run of the field, and a text without markup. */
    nativeTypingOK(e) {
        if (this.dirty) return false;
        const data = e.data;
        if (typeof data !== "string" || !data || /[\r\n]/.test(data) || data.includes(GUARD)) return false;
        const s = document.getSelection();
        return !!(s && s.isCollapsed && s.anchorNode && s.anchorNode.nodeType === 3 && s.anchorNode.parentNode === this.el);
    }

    /**
     * What a delete of `type` takes from a collapsed caret at `s`, widened to whole chips. Every delete is made here:
     * Chromium gives a plaintext-only field no target ranges for them (measured 2026-09-29), and a native one next to a
     * chip or a guard would take the guard or leave its own <br>. Words and lines as Windows takes them: Ctrl+Backspace
     * the word before and the space after it, Ctrl+Delete the word after and its space.
     */
    deleteRange(type, s, t) {
        const text = this.text;
        if (s !== t) return this.widen(s, t);
        if (type === "deleteContentBackward") return unitBefore(text, s, this.plan);
        if (type === "deleteContentForward") return unitAfter(text, s, this.plan);
        const lineStart = text.lastIndexOf("\n", s - 1) + 1;
        let lineEnd = text.indexOf("\n", s);
        if (lineEnd < 0) lineEnd = text.length;
        let r;
        if (type === "deleteWordBackward") r = [s - (/(\S+\s*|\s+)$/.exec(text.slice(0, s)) || [""])[0].length, s];
        else if (type === "deleteWordForward") r = [s, s + (/^(\S+\s*|\s+)/.exec(text.slice(s)) || [""])[0].length];
        else if (/Backward$/.test(type)) r = [s === lineStart ? Math.max(0, s - 1) : lineStart, s];   // a line's start: its break
        else if (/Forward$/.test(type)) r = [s, s === lineEnd ? Math.min(text.length, s + 1) : lineEnd];
        else r = [lineStart, lineEnd];   // deleteEntireSoftLine and the rest
        return this.widen(r[0], r[1]);
    }

    /** a target range of the event in model offsets, or null */
    targetRange(e) {
        const r = typeof e.getTargetRanges === "function" ? e.getTargetRanges()[0] : null;
        if (!r || !this.el.contains(r.startContainer) || !this.el.contains(r.endContainer)) return null;
        const a = this.domToOffset(r.startContainer, r.startOffset), b = this.domToOffset(r.endContainer, r.endOffset);
        return [Math.min(a, b), Math.max(a, b)];
    }

    onBeforeInput(e) {
        const type = e.inputType || "";
        if (type === "insertCompositionText" || this.composing) return;   // not cancelable; the composition path
        const [s, t] = this.readSel();
        this.pre = { text: this.text, start: s, end: t };
        // a space typed where the field put one before a chip steps over it (as an editor steps over a closing bracket)
        if (type === "insertText" && e.data === " " && s === t && this.autoSpace === s && this.text[s] === " ") {
            e.preventDefault();
            this.pre = null;
            this.autoSpace = null;
            this.setSel(s + 1, s + 1);
            return;
        }
        const sp = type === "insertText" ? this.spaced(s, t, e.data || "") : null;
        if (type === "insertText" && s === t && !sp.pre && !sp.post && this.nativeTypingOK(e)) { this.nativePending = true; return; }
        e.preventDefault();
        if (this.el.getAttribute("aria-disabled") === "true") { this.pre = null; return; }
        switch (type) {
            case "insertText":
            case "insertReplacementText": {
                const d = e.data != null ? e.data : e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
                this.edit(s, t, d, "type", type, d);
                break;
            }
            case "insertParagraph":
            case "insertLineBreak":
                this.edit(s, t, "\n", "line", "insertLineBreak");
                break;
            case "insertFromPaste":
            case "insertFromPasteAsQuotation":
            case "insertFromYank":
            case "insertFromDrop": {
                const d = e.dataTransfer ? e.dataTransfer.getData("text/plain") : e.data || "";
                if (!d) { this.pre = null; break; }
                // a drop lands where it was dropped; 26c1 copies a dragged selection (26c2 moves it)
                const at = type === "insertFromDrop" ? this.targetRange(e) : null;
                const [a, b] = at ? this.widen(at[0], at[0]) : [s, t];
                this.edit(a, b, d, "paste", type, null);
                break;
            }
            case "deleteByCut":
                if (s !== t) this.edit(s, t, "", "cut", type); else this.pre = null;
                break;
            case "deleteByDrag":
                this.pre = null;   // the source stays; a drop copies (26c2 moves)
                break;
            case "historyUndo": this.pre = null; this.undo(); break;
            case "historyRedo": this.pre = null; this.redo(); break;
            default: {
                if (!type.startsWith("delete")) { this.pre = null; break; }   // format* and the rest: nothing
                const [a, b] = this.deleteRange(type, s, t);
                if (a === b) { this.pre = null; break; }
                if (this.glues(a, b)) {
                    // the space that keeps a chip apart from a word is stepped over, as the one typing puts there;
                    // a longer range goes and leaves one space
                    if (s === t && !/\S/.test(this.text.slice(a, b))) { this.pre = null; const c = /Backward/.test(type) ? a : b; this.setSel(c, c); break; }
                    this.edit(a, b, " ", "delete", type);
                    break;
                }
                this.edit(a, b, "", "delete", type);
            }
        }
    }

    onInput(e) {
        if (this.firing) return;   // our own event
        if (e.isComposing || this.composing) return;
        this.nativePending = false;
        const m = measure(this.el);
        const next = normalize(m.text);
        if (m.dirty) this.dirty = true;
        const d = this.domSel();
        const caret = d ? d[1] : next.length;
        const prev = this.pre || { text: this.text, start: this.anchor, end: this.focusOff };
        this.pre = null;
        if (next === this.text && !this.dirty) { this.render(); return; }
        const kind = /^delete/.test(e.inputType || "") ? "delete" : "type";
        this.history.record(prev, { text: next, start: caret, end: caret }, kind);
        // the space the field put before a chip moves with a word typed in front of it
        if (this.autoSpace != null) {
            const at = prev.start <= this.autoSpace ? this.autoSpace + next.length - this.text.length : this.autoSpace;
            this.autoSpace = next[at] === " " && at === caret ? at : null;
        }
        this.open = this.openAfter(this.text, next, caret);
        this.text = next;
        if (d) { this.anchor = d[0]; this.focusOff = d[1]; } else this.anchor = this.focusOff = caret;
        // an @ typed in front of "img1" makes a chip around the caret: the caret goes after it
        this.render({ typed: kind === "type" });
    }

    onKeyDown(e) {
        if (e.isComposing || e.keyCode === 229 || this.composing) return;
        const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
        const k = e.key;
        if (ctrl && !e.shiftKey && (k === "z" || k === "Z")) { e.preventDefault(); this.undo(); return; }
        if (ctrl && (k === "y" || k === "Y" || (e.shiftKey && (k === "z" || k === "Z")))) { e.preventDefault(); this.redo(); return; }
        if (k === "Enter" && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            if (this.el.getAttribute("aria-disabled") === "true") return;
            const [s, t] = this.readSel();
            this.pre = { text: this.text, start: s, end: t };
            this.edit(s, t, "\n", "line", "insertLineBreak");
            return;
        }
        if ((k === "ArrowLeft" || k === "ArrowRight") && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            this.arrow(k === "ArrowLeft" ? -1 : 1, e.shiftKey);
        }
    }

    /** ArrowLeft / ArrowRight: a grapheme or a whole chip; without Shift a selection collapses to its side */
    arrow(dir, shift) {
        const [s, t] = this.readSel();
        // the token being typed is left: it becomes a chip first, and the step goes over the whole of it
        if (this.open) { this.open = null; this.render(); }
        if (!shift && s !== t) { const c = dir < 0 ? s : t; this.setSel(c, c); return; }
        const f = this.focusOff;
        const u = dir < 0 ? unitBefore(this.text, f, this.plan) : unitAfter(this.text, f, this.plan);
        const nf = dir < 0 ? u[0] : u[1];
        if (shift) this.setSel(this.anchor, nf); else this.setSel(nf, nf);
        this.leaveOpen();
    }

    onPaste(e) {
        e.preventDefault();
        e.stopPropagation();
        if (this.el.getAttribute("aria-disabled") === "true") return;
        // text only: an image pasted here does nothing, as in the textarea (26c2 makes it a reference)
        const d = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
        if (!d) return;
        const [s, t] = this.readSel();
        this.pre = { text: this.text, start: s, end: t };
        this.edit(s, t, d, "paste", "insertFromPaste");
    }

    /** a chip copies as its token, whatever the hidden "@" and the label say */
    onCopy(e, cut) {
        const [s, t] = this.readSel();
        e.stopPropagation();
        if (s === t) return;
        e.preventDefault();
        if (e.clipboardData) e.clipboardData.setData("text/plain", this.text.slice(s, t));
        if (cut && this.el.getAttribute("aria-disabled") !== "true") {
            this.pre = { text: this.text, start: s, end: t };
            this.edit(s, t, "", "cut", "deleteByCut");
        }
    }

    onCompositionStart() {
        const [s, t] = this.readSel();
        this.pre = { text: this.text, start: s, end: t };
        this.composing = true;
    }

    onCompositionEnd() {
        this.composing = false;
        const m = measure(this.el);
        const next = normalize(m.text);
        if (m.dirty) this.dirty = true;
        const d = this.domSel();
        const caret = d ? d[1] : next.length;
        const prev = this.pre || { text: this.text, start: this.anchor, end: this.focusOff };
        this.pre = null;
        const changed = next !== this.text;
        if (changed) {
            this.history.record(prev, { text: next, start: caret, end: caret }, "type");
            this.open = this.openAfter(this.text, next, caret);
            this.text = next;
        }
        if (d) { this.anchor = d[0]; this.focusOff = d[1]; } else this.anchor = this.focusOff = caret;
        this.render({ typed: true });
        // the writes that came while composing, in order: an explicit one replaces the composed text, a remap applies
        // to what stands then
        const q = this.queued;
        this.queued = [];
        for (const op of q) {
            if (typeof op.history === "function") this.setText(op.history(this.text), { keepCaret: true, history: op.history });
            else this.setText(op.text, { keepCaret: op.keepCaret, history: op.history });
        }
        // the editor reads the text from the input event; the last one came while composing
        if (changed || q.length) this.fire("insertFromComposition", null);
    }

    onFocus() {
        this.focusText = this.text;
        document.addEventListener("selectionchange", this.onSelChange);
        // a focus from code puts back the selection the field kept, as a textarea's does; a click keeps its own caret
        if (!this.fromPointer) this.applySel();
    }

    onBlur() {
        document.removeEventListener("selectionchange", this.onSelChange);
        if (this.open) { this.open = null; this.render(); }
        this.closePopups();
        const was = this.focusText;
        this.focusText = null;
        if (was != null && was !== this.text) this.el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    /** The caret left the token being typed: it becomes a chip. */
    leaveOpen() {
        if (!this.open) return;
        const c = this.anchor === this.focusOff ? this.focusOff : -1;
        if (c === this.open[1]) return;
        this.open = null;
        if (this.pointerHeld) this.renderAfterPointer = true; else this.render();
    }

    selectionChanged() {
        if (!this.hasFocus() || this.composing || this.nativePending) return;
        const s = document.getSelection();
        const d = this.domSel();
        if (!s || !d) return;
        this.anchor = d[0];
        this.focusOff = d[1];
        // a caret the browser put between two elements or into a chip (its label is a text node too) goes to its
        // place, a guard or a text run of the field; a selection being dragged is left alone
        const loose = s.anchorNode && (s.anchorNode.nodeType !== 3 || s.anchorNode.parentNode !== this.el);
        if (s.isCollapsed && loose && !this.pointerHeld) {
            this.anchor = this.focusOff = this.snap(d[1]);
            this.applySel();
        }
        this.markSel();
        if (this.autoSpace != null && !(this.anchor === this.autoSpace && this.focusOff === this.autoSpace)) this.autoSpace = null;
        this.leaveOpen();
    }

    // ---- 26c2 -----------------------------------------------------------------------------------------------------

    /** Is a popup of the field open (the picker, the swap menu)? None before 26c2. */
    popupOpen() { return false; }

    /** Close the field's popups. */
    closePopups() { /* 26c2 */ }

    destroy() {
        this.destroyed = true;
        document.removeEventListener("selectionchange", this.onSelChange);
        window.removeEventListener("mouseup", this.onPointerUp, true);
        this.closePopups();
        this.refs = () => EMPTY_CONTEXT;
        this.addReferencesFn = null;
        this.preview = null;
    }
}
