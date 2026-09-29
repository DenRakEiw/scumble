// The pure helpers of renderer/editor/prompt_field.js (item 26 steps 26c1 and 26c2, docs/PLAN_REFS.md 26c and C4) in plain Node,
// no Electron and no DOM:
//   node tools/prompt_field_test.js
// Importing the module here proves that nothing touches `document` or `window` at import time. Covered: sanitize (line
// breaks, caret guards, the case of a token), the re-exported mapOffset / diffRange, atWordStart, the units Backspace,
// Delete and the arrows cross (chips, graphemes, emoji, surrogate pairs, an open token, the path without
// Intl.Segmenter), the field's own undo (EditHistory: merging, word steps, undo / redo, map, reset, the cap), chipState
// for each state and renderPlan with and without an open range; 26c2's pickerRows, barCount, cardLine, the over and
// none states and imageFiles. PromptField, RefPicker and RefBar need a DOM: the editor gate's job.
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${!ok && detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => JSON.stringify(v instanceof Map ? [...v] : v);
/** check that `got` equals `want` (JSON), saying both when not */
const same = (what, got, want) => check(what, eq(got, want), `got ${show(got)}, want ${show(want)}`);

async function section(name, fn) {
    try { await fn(); } catch (err) { check(name + " ran to its end", false, String(err && err.stack || err).split(/\r?\n/).slice(0, 3).join(" ")); }
}

// every character outside ASCII is built from its code, so this file stays ASCII
const ch = (...codes) => String.fromCharCode(...codes);
const cp = (...codes) => String.fromCodePoint(...codes);
const ZWSP = ch(0x200b);
const ELL = ch(0x2026);
const SMILE = cp(0x1f600);                                        // one surrogate pair
const FAMILY = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);     // man ZWJ woman ZWJ girl: 8 code units, one grapheme
const FLAG_DE = cp(0x1f1e9, 0x1f1ea), FLAG_AT = cp(0x1f1e6, 0x1f1f9); // two regional indicators each
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
/** does offset i fall between the two halves of a surrogate pair? */
const inPair = (s, i) => i > 0 && i < s.length && isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i));

/** a field state with the caret (a collapsed selection) at `c`, the end by default */
const st = (text, c = text.length) => ({ text, start: c, end: c });

// the references of the chip tests (RefContext of C4): two shown, one hidden, one shown without pixels
const desc = (id, label, name, visible) => ({ id, label, name, visible, thumb: null, sentAs: null });
const REFS = [
    desc("Lk", 1, "Coat", true),
    desc("Lv", 2, "Shoes", true),
    desc("Lhid", null, "A very long layer name here", false),
    desc("Lnop", null, "Empty", true),
];
const ctxOf = (reason) => ({ refs: REFS, cap: null, none: null, canAdd: false, reason });
const CTX = ctxOf((id) => (id === "Lgone" ? "no longer a reference" : "deleted"));

/** the pieces of a plan cover the text in order, each piece's text is its slice, no two text pieces side by side */
function tiles(plan, text) {
    let at = 0;
    for (let i = 0; i < plan.length; i++) {
        const p = plan[i];
        if (p.start !== at || p.end - p.start !== p.text.length || text.slice(p.start, p.end) !== p.text) return false;
        if (i && p.type === "text" && plan[i - 1].type === "text") return false;
        at = p.end;
    }
    return at === text.length && plan.map((p) => p.text).join("") === text;
}
const shape = (plan) => plan.map((p) => [p.type, p.start, p.end]);

/** type `str` into `h` a character at a time from state `from`, `dt` ms apart; the results of record and the last state */
function typeAll(h, from, str, t0 = 0, dt = 100) {
    let cur = from, t = t0;
    const steps = [];
    for (const c of str) {
        const next = st(cur.text + c);
        steps.push(h.record(cur, next, "type", t));
        cur = next;
        t += dt;
    }
    return { cur, steps, t };
}

async function main() {
    // the premise: this process has no DOM, so an import that reached for one would throw here
    check("no document or window in this process", typeof globalThis.document === "undefined" && typeof globalThis.window === "undefined");
    const url = pathToFileURL(path.join(ROOT, "renderer", "editor", "prompt_field.js")).href;
    const P = await import(url);
    check("prompt_field.js imports in plain Node", !!P);
    const T = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "reftokens.js")).href);

    await section("0. exports", async () => {
        same("the module exports the field and its helpers", Object.keys(P).sort(),
            ["EditHistory", "GUARD", "PromptField", "RefBar", "RefPicker", "atWordStart", "barCount", "cardLine", "chipState", "diffRange", "imageFiles", "mapOffset", "pickerRows", "renderPlan", "sanitize", "unitAfter", "unitBefore"]);
        check("GUARD is one U+200B", P.GUARD === ZWSP && P.GUARD.length === 1);
        check("mapOffset and diffRange are reftokens.js's own", P.mapOffset === T.mapOffset && P.diffRange === T.diffRange);
        check("PromptField is a class (not built here: it needs a DOM)", typeof P.PromptField === "function");
    });

    await section("1. sanitize", async () => {
        same("CRLF becomes LF", P.sanitize("a\r\nb\r\n\r\nc"), "a\nb\n\nc");
        same("a lone CR becomes LF", P.sanitize("a\rb\n\rc\r"), "a\nb\n\nc\n");
        same("U+200B is removed", P.sanitize(ZWSP + "a" + ZWSP + ZWSP + "b" + ZWSP), "ab");
        same("a guard inside a token goes before the case is fixed", P.sanitize("@IM" + ZWSP + "G2"), "@img2");
        same("@IMG2 becomes @img2", P.sanitize("from @IMG2 and @Img3"), "from @img2 and @img3");
        same("a parked token keeps its id's case", P.sanitize("@IMG?Labc"), "@img?Labc");
        same("no token, no change of case", P.sanitize("mail@IMG2 and @IMAGE2"), "mail@IMG2 and @IMAGE2");
        same("null gives an empty text", P.sanitize(null), "");
        same("undefined gives an empty text", P.sanitize(undefined), "");
        same("a number gives its text", P.sanitize(12), "12");
        const once = P.sanitize("x\r\n@IMG1" + ZWSP + "\r");
        check("sanitize of a sanitized text changes nothing", P.sanitize(once) === once && once === "x\n@img1\n", show(once));
    });

    await section("2. mapOffset and diffRange", async () => {
        // a remap parks @img2 as @img?L1k3: "2" became "?L1k3"
        const a = "a @img2 b", b = "a @img?L1k3 b";
        same("the change of the remap", P.diffRange(a, b), { start: 6, endA: 7, endB: 11 });
        check("a caret before the change stays", P.mapOffset(0, a, b) === 0 && P.mapOffset(2, a, b) === 2 && P.mapOffset(6, a, b) === 6);
        check("a caret after the token stays after it", P.mapOffset(7, a, b) === 11, String(P.mapOffset(7, a, b)));
        check("a caret after b shifts by the length difference", P.mapOffset(a.length, a, b) === a.length + b.length - a.length, String(P.mapOffset(a.length, a, b)));
        // @img12 -> @img?L1k3: "12" became "?L1k3", so offset 7 (between 1 and 2) is inside the change
        const a2 = "a @img12 b";
        same("the change of a longer token", P.diffRange(a2, b), { start: 6, endA: 8, endB: 11 });
        check("a caret inside the token goes to the end of the change", P.mapOffset(7, a2, b) === 11, String(P.mapOffset(7, a2, b)));
        check("a caret after it shifts", P.mapOffset(9, a2, b) === 12);
        check("inside a plain replacement goes to its end", P.mapOffset(3, "abcdef", "abXYZef") === 5);
        check("clamped to the texts", P.mapOffset(-5, a, b) === 0 && P.mapOffset(99, a, b) === b.length);
    });

    await section("3. atWordStart", async () => {
        check("at 0", P.atWordStart("abc", 0) === true);
        check("at 0 of an empty text", P.atWordStart("", 0) === true);
        check("after a space", P.atWordStart("a b", 2) === true);
        check("after a line break", P.atWordStart("a\nb", 2) === true);
        check("after a tab", P.atWordStart("a\tb", 2) === true);
        check("after (", P.atWordStart("(", 1) === true);
        check("after the German opening quote U+201E", P.atWordStart("sag " + ch(0x201e), 5) === true);
        const openers = ["[", "{", "\"", "'", ch(0x201c), ch(0x201a), ch(0xab)];
        same("after the other opening brackets and quotes", openers.map((o) => P.atWordStart("x" + o, 2)), openers.map(() => true));
        check("not after mail", P.atWordStart("mail@", 4) === false);
        const closers = ["1", "-", ")", ".", "_"];
        same("not after a digit, a hyphen, a closing bracket, a full stop or _", closers.map((c) => P.atWordStart("x" + c, 2)), closers.map(() => false));
        check("not inside a word", P.atWordStart("hello", 3) === false);
    });

    await section("4. unitBefore and unitAfter", async () => {
        const text = "a @img1 b";
        const plan = P.renderPlan(text, CTX);
        same("the plan draws @img1 as a chip at [2, 7]", shape(plan), [["text", 0, 2], ["chip", 2, 7], ["text", 7, 9]]);
        same("unitBefore right after a chip takes the whole token", P.unitBefore(text, 7, plan), [2, 7]);
        same("unitAfter right before a chip takes the whole token", P.unitAfter(text, 2, plan), [2, 7]);
        same("unitBefore right before a chip takes one character", P.unitBefore(text, 2, plan), [1, 2]);
        same("unitAfter right after a chip takes one character", P.unitAfter(text, 7, plan), [7, 8]);
        same("a caret inside a chip: unitBefore takes the chip", P.unitBefore(text, 4, plan), [2, 7]);
        same("a caret inside a chip: unitAfter takes the chip", P.unitAfter(text, 4, plan), [2, 7]);
        same("plain text: unitBefore takes one grapheme", P.unitBefore(text, 9, plan), [8, 9]);
        same("plain text: unitAfter takes one grapheme", P.unitAfter(text, 0, plan), [0, 1]);
        same("unitBefore at 0 is empty", P.unitBefore(text, 0, plan), [0, 0]);
        same("unitAfter at the end is empty", P.unitAfter(text, text.length, plan), [9, 9]);

        // chips at the edges of the text, and side by side with one space between
        const edge = "@img1 @img2";
        const ep = P.renderPlan(edge, CTX);
        same("the edge plan", shape(ep), [["chip", 0, 5], ["text", 5, 6], ["chip", 6, 11]]);
        same("a chip at the start: unitBefore at 0 is empty", P.unitBefore(edge, 0, ep), [0, 0]);
        same("a chip at the start: unitAfter at 0 takes it", P.unitAfter(edge, 0, ep), [0, 5]);
        same("a chip at the end: unitBefore at the end takes it", P.unitBefore(edge, 11, ep), [6, 11]);
        same("a chip at the end: unitAfter at the end is empty", P.unitAfter(edge, 11, ep), [11, 11]);
        same("between two chips unitBefore takes the space", P.unitBefore(edge, 6, ep), [5, 6]);
        same("between two chips unitAfter takes the space", P.unitAfter(edge, 5, ep), [5, 6]);

        // a parked token (inactive or broken) is drawn as a chip, so it is a unit as well
        const parked = "x @img?Lhid y";
        const pp = P.renderPlan(parked, CTX);
        same("a parked chip: unitBefore takes it", P.unitBefore(parked, 11, pp), [2, 11]);
        same("a parked chip: unitAfter takes it", P.unitAfter(parked, 2, pp), [2, 11]);

        // the token being typed is drawn as text, so it goes a character at a time
        const open = P.renderPlan(text, CTX, [2, 7]);
        check("an open token is drawn as text", open.every((p) => p.type === "text"), show(shape(open)));
        same("an open token: unitBefore takes one character", P.unitBefore(text, 7, open), [6, 7]);
        same("an open token: unitAfter takes one character", P.unitAfter(text, 2, open), [2, 3]);
        same("without a plan a token is text too", P.unitBefore(text, 7, null), [6, 7]);
        same("a caret past the end is clamped", P.unitBefore("abc", 99, null), [2, 3]);
        same("a negative caret is clamped", P.unitAfter("abc", -4, null), [0, 1]);

        // graphemes: a ZWJ sequence, flags, a combining mark, a surrogate pair
        check("the family emoji is 8 code units", FAMILY.length === 8);
        const ft = "a" + FAMILY + "b";
        same("a ZWJ family is one unit (unitBefore)", P.unitBefore(ft, 9, null), [1, 9]);
        same("a ZWJ family is one unit (unitAfter)", P.unitAfter(ft, 1, null), [1, 9]);
        const flags = "x" + FLAG_DE + FLAG_AT + "y";
        same("a flag is one unit (unitBefore)", P.unitBefore(flags, 5, null), [1, 5]);
        same("the second of two flags side by side is one unit (unitBefore)", P.unitBefore(flags, 9, null), [5, 9]);
        same("a flag is one unit (unitAfter)", P.unitAfter(flags, 1, null), [1, 5]);
        same("the second of two flags side by side is one unit (unitAfter)", P.unitAfter(flags, 5, null), [5, 9]);
        same("a letter with a combining accent is one unit", P.unitBefore("xe" + ch(0x301), 3, null), [1, 3]);
        const sp = "a" + SMILE + "b";
        same("a surrogate pair is one unit (unitBefore)", P.unitBefore(sp, 3, null), [1, 3]);
        same("a surrogate pair is one unit (unitAfter)", P.unitAfter(sp, 1, null), [1, 3]);

        // every caret that is not inside a pair, in a text of everything above: the unit holds the caret, is not empty
        // unless at an edge, and never splits a surrogate pair
        const mixed = "a " + SMILE + FAMILY + " @img1 " + FLAG_DE + "e" + ch(0x301) + SMILE;
        const mp = P.renderPlan(mixed, CTX);
        const bad = [];
        for (let c = 0; c <= mixed.length; c++) {
            if (inPair(mixed, c)) continue;
            const before = P.unitBefore(mixed, c, mp), after = P.unitAfter(mixed, c, mp);
            for (const [name, r, empty] of [["unitBefore", before, c === 0], ["unitAfter", after, c === mixed.length]]) {
                const ok = r[0] <= c && c <= r[1] && (empty ? r[0] === r[1] : r[0] < r[1]) && !inPair(mixed, r[0]) && !inPair(mixed, r[1]);
                if (!ok) bad.push(`${name}(${c}) = ${show(r)}`);
            }
        }
        check("no unit splits a surrogate pair, every unit holds its caret", bad.length === 0, bad.slice(0, 6).join("; "));
    });

    await section("4b. unitBefore and unitAfter without Intl.Segmenter", async () => {
        // a second instance of the module, so its segmenter is made (and fails) while Intl.Segmenter is gone
        const F = await import(url + "?no-segmenter");
        const saved = Intl.Segmenter;
        Intl.Segmenter = undefined;
        try {
            const sp = "a" + SMILE + "b";
            same("a surrogate pair is one unit (unitBefore)", F.unitBefore(sp, 3, null), [1, 3]);
            same("a surrogate pair is one unit (unitAfter)", F.unitAfter(sp, 1, null), [1, 3]);
            same("one character before", F.unitBefore("abc", 2, null), [1, 2]);
            same("one character after", F.unitAfter("abc", 2, null), [2, 3]);
            same("a chip is still a unit", F.unitBefore("a @img1", 7, F.renderPlan("a @img1", CTX)), [2, 7]);
        } finally {
            Intl.Segmenter = saved;
        }
    });

    await section("5. EditHistory", async () => {
        const H = P.EditHistory;
        {
            const h = new H();
            check("defaults: 200 steps, 1000 ms", h.cap === 200 && h.mergeMs === 1000);
            check("a new history has nothing to undo or redo", h.undoCount === 0 && h.redoCount === 0 && h.undo(st("x")) === null && h.redo(st("x")) === null);
        }
        {
            // typing breaks at white space: a word per undo step
            const h = new H();
            const { cur, steps } = typeAll(h, st(""), "hello world");
            same("typing hello world: new steps at h and at the space, the rest merged", steps,
                [true, false, false, false, false, true, false, false, false, false, false]);
            check("two undo steps", h.undoCount === 2, String(h.undoCount));
            const u1 = h.undo(cur);
            same("undo gives hello with its caret", u1, st("hello"));
            const u2 = h.undo(u1);
            same("undo again gives the empty text", u2, st(""));
            check("then nothing is left to undo", h.undo(u2) === null);
            same("redo gives hello", h.redo(u2), st("hello"));
            same("redo again gives hello world", h.redo(st("hello")), st("hello world"));
            check("then nothing is left to redo", h.redo(st("hello world")) === null);
        }
        {
            const h = new H();
            const { cur } = typeAll(h, st(""), "hello world again");
            const texts = [];
            for (let s = cur, u; (u = h.undo(s)); s = u) texts.push(u.text);
            same("three words are three undo steps", texts, ["hello world", "hello", ""]);
        }
        {
            // the time counts from the key before, not from the step's first key
            const h = new H();
            const { cur, steps, t } = typeAll(h, st(""), "abcd", 0, 800);
            same("typing every 800 ms stays one step", steps, [true, false, false, false]);
            check("a gap longer than mergeMs starts a new step", h.record(cur, st("abcde"), "type", t - 800 + 1500) === true);
            check("a smaller mergeMs is honoured", (() => {
                const g = new H({ mergeMs: 50 });
                return g.record(st(""), st("a"), "type", 0) === true && g.record(st("a"), st("ab"), "type", 60) === true && g.undoCount === 2;
            })());
        }
        {
            const h = new H();
            same("Backspace after Backspace merges, through white space too",
                [h.record(st("ab cd"), st("ab c"), "delete", 0), h.record(st("ab c"), st("ab "), "delete", 100),
                    h.record(st("ab "), st("ab"), "delete", 200), h.record(st("ab"), st("a"), "delete", 300)], [true, false, false, false]);
            const g = new H();
            same("Delete after Delete merges (the caret stays)", [g.record(st("abc", 0), st("bc", 0), "delete", 0), g.record(st("bc", 0), st("c", 0), "delete", 100)], [true, false]);
            const k = new H();
            same("type, delete, type are three steps", [k.record(st("ab"), st("abx"), "type", 0), k.record(st("abx"), st("ab"), "delete", 100),
                k.record(st("ab"), st("aby"), "type", 200)], [true, true, true]);
        }
        {
            const h = new H();
            same("set never merges", [h.record(st(""), st("a"), "set", 0), h.record(st("a"), st("ab"), "set", 10)], [true, true]);
            same("paste never merges", [h.record(st("ab"), st("abc"), "paste", 20), h.record(st("abc"), st("abcd"), "paste", 30)], [true, true]);
            check("typing right after a paste is a step of its own", h.record(st("abcd"), st("abcde"), "type", 40) === true);
            same("the default kind is set", [h.record(st("abcde"), st("abcdef"), undefined, 50), h.record(st("abcdef"), st("abcdefg"), undefined, 60)], [true, true]);
            check("seven steps, none merged", h.undoCount === 7, String(h.undoCount));
        }
        {
            const h = new H();
            typeAll(h, st(""), "ab");
            check("a caret jump breaks the merge", h.record(st("ab", 0), st("xab", 1), "type", 300) === true);
            check("typing on from there merges again", h.record(st("xab", 1), st("xyab", 2), "type", 400) === false);
            check("a selection where the step left a caret breaks it too", h.record({ text: "xyab", start: 1, end: 2 }, st("xzab", 2), "type", 500) === true);
            const n = h.undoCount;
            check("no change of text is no step", h.record(st("xzab", 2), st("xzab", 0), "type", 600) === false && h.undoCount === n);
            check("a missing state is no step", h.record(null, st("a"), "set", 0) === false && h.record(st("a"), undefined, "set", 0) === false && h.undoCount === n);
        }
        {
            // the states kept are copies: what the caller changes later does not reach the stacks
            const h = new H();
            const prev = st("one"), next = st("one two");
            h.record(prev, next, "set", 0);
            prev.text = "changed";
            prev.start = 99;
            const cur = st("one two");
            const u = h.undo(cur);
            same("record keeps its own copy of prev", u, st("one"));
            same("undo returns text, start and end", Object.keys(u).sort(), ["end", "start", "text"]);
            cur.text = "changed too";
            same("undo keeps its own copy of cur", h.redo(u), st("one two"));
        }
        {
            const h = new H();
            h.record(st(""), st("a"), "set", 0);
            h.record(st("a"), st("ab"), "set", 10);
            const u = h.undo(st("ab"));
            check("one step to redo after an undo", h.redoCount === 1 && u.text === "a");
            check("a new step after an undo", h.record(u, st("ac"), "set", 20) === true);
            check("the redo is gone", h.redoCount === 0 && h.redo(st("ac")) === null);
        }
        {
            // map: a remap parks @img2 as @img?L1k3 in every kept state, carets carried along
            const h = new H();
            const A = { text: "a @img2 b", start: 2, end: 7 };   // the token selected
            const B = st("a @img2 b!"), C = st("a @img2 b!?");
            h.record(A, B, "set", 0);
            h.record(B, C, "set", 10);
            const back = h.undo(C);
            same("undo before the map", back, B);
            const remap = (t) => t.replace(/@img2(?![\w-])/g, "@img?L1k3");
            h.map(remap);
            check("map adds no step", h.undoCount === 1 && h.redoCount === 1);
            const cur = st("a @img?L1k3 b!");
            same("the undo entry mapped: new text, the selection still around the token", h.undo(cur), { text: "a @img?L1k3 b", start: 2, end: 11 });
            same("redo gives the state that was current", h.redo({ text: "a @img?L1k3 b", start: 2, end: 11 }), cur);
            same("the redo entry mapped: new text, the caret still at the end", h.redo(cur), st("a @img?L1k3 b!?"));
            const g = new H();
            g.record(st("abc", 1), st("abcd"), "set", 0);
            g.map(() => null);
            g.map((t) => t);
            same("map leaves an entry alone when fn gives no string or the same text", g.undo(st("abcd")), st("abc", 1));
            const k = new H();
            k.record(st(""), st("a"), "type", 0);
            k.map((t) => t);
            check("map breaks the merge", k.record(st("a"), st("ab"), "type", 10) === true);
        }
        {
            const h = new H();
            h.record(st(""), st("a"), "set", 0);
            h.record(st("a"), st("ab"), "set", 10);
            h.undo(st("ab"));
            check("before reset: a step each way", h.undoCount === 1 && h.redoCount === 1);
            h.reset();
            check("reset empties both stacks", h.undoCount === 0 && h.redoCount === 0 && h.undo(st("a")) === null && h.redo(st("a")) === null);
            h.record(st(""), st("a"), "type", 20);
            h.reset();
            check("reset breaks the merge", h.record(st("a"), st("ab"), "type", 30) === true && h.undoCount === 1);
        }
        {
            const h = new H({ cap: 3 });
            let prev = st("");
            for (const t of ["1", "12", "123", "1234", "12345"]) { h.record(prev, st(t), "set", 0); prev = st(t); }
            check("the cap keeps 3 steps", h.undoCount === 3, String(h.undoCount));
            const texts = [];
            for (let s = st("12345"), u; (u = h.undo(s)); s = u) texts.push(u.text);
            same("the oldest steps are dropped", texts, ["1234", "123", "12"]);
        }
    });

    await section("6. chipState", async () => {
        const live = P.chipState({ n: 1 }, CTX);
        same("a label a descriptor holds is live", { ...live, ref: live.ref && live.ref.id }, { state: "live", label: "img1", reason: "", ref: "Lk" });
        check("the live chip's ref is the descriptor itself", live.ref === REFS[0]);
        same("@img9 with no descriptor is broken", P.chipState({ n: 9 }, CTX), { state: "broken", label: "img9", reason: "no reference img9", ref: null });

        const hid = P.chipState({ id: "Lhid" }, CTX);
        same("a parked token of a hidden reference is inactive, its label the name cut", [hid.state, hid.label, hid.ref && hid.ref.id],
            ["inactive", "A very long l" + ELL, "Lhid"]);
        check("the cut label is 14 characters", Array.from(hid.label).length === 14);
        check("its reason says hidden", /hidden/.test(hid.reason), hid.reason);
        const nop = P.chipState({ id: "Lnop" }, CTX);
        same("a parked token of a shown reference without pixels is inactive", [nop.state, nop.label, nop.ref && nop.ref.id], ["inactive", "Empty", "Lnop"]);
        check("its reason is about pixels", /pixels/.test(nop.reason), nop.reason);
        const back = P.chipState({ id: "Lv" }, CTX);
        check("a parked token whose reference holds a label again is inactive and names the label", back.state === "inactive" && back.label === "Shoes" && back.reason.includes("@img2"), show(back.reason));

        const named = (name) => P.chipState({ id: "Lx" }, { refs: [desc("Lx", null, name, false)], cap: null, none: null, canAdd: false, reason: () => "" }).label;
        same("a name of 14 characters stays whole", named("Fourteen chars"), "Fourteen chars");
        same("a name of 15 characters is cut to 13 and an ellipsis", named("Fifteen chars!!"), "Fifteen chars" + ELL);
        same("white space in a name is collapsed and trimmed", named("  Red \n  hat  "), "Red hat");
        same("no name gives reference", [named(""), named(null)], ["reference", "reference"]);
        const emoji = named(SMILE.repeat(20));
        check("a name of emoji is cut by code points, no pair split", emoji === SMILE.repeat(13) + ELL, show(emoji));

        same("a parked token with no descriptor is broken, the reason from ctx.reason", P.chipState({ id: "Lgone" }, CTX),
            { state: "broken", label: "img?", reason: "no longer a reference", ref: null });
        let asked = null;
        P.chipState({ id: "Lq" }, ctxOf((id) => { asked = id; return "r"; }));
        check("ctx.reason is asked with the layer id", asked === "Lq", show(asked));
        same("ctx.reason throwing gives deleted", P.chipState({ id: "Lgone" }, ctxOf(() => { throw new Error("boom"); })).reason, "deleted");
        same("ctx.reason missing gives deleted", P.chipState({ id: "Lgone" }, { refs: REFS, cap: null, none: null, canAdd: false }).reason, "deleted");
        same("ctx.reason giving an empty text gives deleted", P.chipState({ id: "Lgone" }, ctxOf(() => "")).reason, "deleted");
        same("no context: a number is broken", P.chipState({ n: 1 }, null), { state: "broken", label: "img1", reason: "no reference img1", ref: null });
        same("no context: a parked token is broken, deleted", P.chipState({ id: "Lk" }, null), { state: "broken", label: "img?", reason: "deleted", ref: null });
    });

    await section("7. renderPlan", async () => {
        const text = "a @img1 and @IMG2\nb @img?Lhid @img9 @img?Lgone mail@img1.de @image2 (@img1)";
        const plan = P.renderPlan(text, CTX);
        check("the pieces cover the text in order", tiles(plan, text), show(shape(plan)));
        const chips = plan.filter((p) => p.type === "chip");
        same("six chips, their tokens normalised", chips.map((c) => c.token), ["@img1", "@img2", "@img?Lhid", "@img9", "@img?Lgone", "@img1"]);
        check("a chip keeps its text as written", chips[1].text === "@IMG2", show(chips[1].text));
        same("a chip carries n or id, not both", chips.map((c) => ("n" in c ? "n" + c.n : "") + ("id" in c ? "id" + c.id : "")), ["n1", "n2", "idLhid", "n9", "idLgone", "n1"]);
        same("the states", chips.map((c) => c.state), ["live", "live", "inactive", "broken", "broken", "live"]);
        const drift = chips.filter((c) => {
            const s = P.chipState("n" in c ? { n: c.n } : { id: c.id }, CTX);
            return c.state !== s.state || c.label !== s.label || c.reason !== s.reason || c.ref !== s.ref;
        });
        check("each chip carries chipState's fields", drift.length === 0, show(drift.map((c) => c.token)));
        check("mail@img1.de and @image2 stay in the text", plan.some((p) => p.type === "text" && p.text === " mail@img1.de @image2 ("), show(shape(plan)));

        same("mail@img1.de is one text piece", P.renderPlan("mail@img1.de", CTX), [{ type: "text", text: "mail@img1.de", start: 0, end: 12 }]);
        same("@image2 is one text piece", P.renderPlan("@image2", CTX), [{ type: "text", text: "@image2", start: 0, end: 7 }]);
        same("an empty text has no pieces", P.renderPlan("", CTX), []);
        same("null has no pieces", P.renderPlan(null, CTX), []);
        const bare = P.renderPlan("@img1", null);
        check("without a context a chip is broken", bare.length === 1 && bare[0].type === "chip" && bare[0].state === "broken", show(bare));

        // the open range: the token being typed stays text and joins the text on both sides
        const t = "a @img1 b";
        same("an open range over the token keeps it text, one piece with its neighbours", P.renderPlan(t, CTX, [2, 7]), [{ type: "text", text: t, start: 0, end: 9 }]);
        same("an open range inside the token does too", P.renderPlan(t, CTX, [4, 5]), [{ type: "text", text: t, start: 0, end: 9 }]);
        same("open ranges that only touch the token leave it a chip", [P.renderPlan(t, CTX, [0, 2]), P.renderPlan(t, CTX, [7, 9])].map((p) => p.map((x) => x.type)),
            [["text", "chip", "text"], ["text", "chip", "text"]]);
        const two = "x @img1 @img2 y";
        const tp = P.renderPlan(two, CTX, [2, 7]);
        same("only the open token is text; the other stays a chip", shape(tp), [["text", 0, 8], ["chip", 8, 13], ["text", 13, 15]]);
        check("the pieces still cover the text", tiles(tp, two));
        const end = "a @img1 b @img2";
        const ep = P.renderPlan(end, CTX, [10, 15]);
        same("an open token at the end joins the text before it", ep.map((p) => [p.type, p.start, p.end, p.text]),
            [["text", 0, 2, "a "], ["chip", 2, 7, "@img1"], ["text", 7, 15, " b @img2"]]);
        same("an open token that is the whole text is one text piece", P.renderPlan("@img1", CTX, [0, 5]), [{ type: "text", text: "@img1", start: 0, end: 5 }]);
    });

    await section("8. the picker's rows, the bar's count, the card's line (26c2)", async () => {
        const ids = (a) => a.map((d) => d.id);
        same("no query: every shown reference, hidden ones left out", ids(P.pickerRows(CTX, "")), ["Lk", "Lv"]);
        same("a query matches the name", ids(P.pickerRows(CTX, "sho")), ["Lv"]);
        same("and the label", ids(P.pickerRows(CTX, "img1")), ["Lk"]);
        same("case does not matter", ids(P.pickerRows(CTX, "COAT")), ["Lk"]);
        same("every word must match", ids(P.pickerRows(CTX, "img2 coat")), []);
        same("a hidden one is never listed", ids(P.pickerRows(CTX, "long")), []);
        same("no context", P.pickerRows(null, "x"), []);

        same("no cap", P.barCount(CTX), { text: "2 reference images", title: "", over: false });
        same("one", P.barCount({ ...CTX, refs: [REFS[0]] }).text, "1 reference image");
        same("a cap", P.barCount({ ...CTX, cap: 4 }), { text: "2 of 4 for this recipe", title: "This recipe takes 4 reference images.", over: false });
        same("past the cap", P.barCount({ ...CTX, cap: 1 }), { text: "2 of 1 for this recipe", title: "This recipe takes 1 reference image.", over: true });
        same("none wins", P.barCount({ ...CTX, cap: 4, none: "An upscale sends the picture alone." }), { text: "This recipe sends no reference images", title: "An upscale sends the picture alone.", over: false });
        const loc = P.barCount({ ...CTX, local: true, refuse: "not yet" });
        same("a ComfyUI recipe", [loc.text, /crop_image/.test(loc.title), /not yet/.test(loc.title)], ["2 in crop_image", true, true]);

        const over = P.chipState({ n: 2 }, { ...CTX, cap: 1, refs: [REFS[0], { ...REFS[1], over: true }, REFS[2]] });
        same("a descriptor past the cap is over", [over.state, over.label, over.reason], ["over", "img2", "this recipe takes 1 reference image"]);
        const overNoCap = P.chipState({ n: 2 }, { ...CTX, refs: [REFS[0], { ...REFS[1], over: true }] });
        same("over without a cap", overNoCap.reason, "past what this recipe takes");
        const none = P.chipState({ n: 1 }, { ...CTX, none: "no references here" });
        same("none strikes a live token", [none.state, none.reason, none.ref && none.ref.id], ["none", "no references here", "Lk"]);
        same("none leaves a broken token broken", P.chipState({ n: 9 }, { ...CTX, none: "x" }).state, "broken");
        same("a ComfyUI recipe's refusal keeps the chip live", P.chipState({ n: 1 }, { ...CTX, local: true, refuse: "not yet" }).state, "live");

        const withSent = { ...CTX, refs: [{ ...REFS[0], sentAs: "image 3" }, REFS[1]] };
        same("the card: sent as", P.cardLine(P.chipState({ n: 1 }, withSent), withSent), "img1 · sent as image 3");
        same("the card: no name known", P.cardLine(P.chipState({ n: 2 }, withSent), withSent), "img2");
        same("the card: a ComfyUI recipe", P.cardLine(P.chipState({ n: 2 }, { ...CTX, local: true, refuse: "take it out" }), { ...CTX, local: true, refuse: "take it out" }), "img2 · in the crop_image batch; take it out");
        same("the card: the reason of a broken chip", P.cardLine(P.chipState({ n: 9 }, CTX), CTX), "img9 · no reference img9");

        const sty = { ...CTX, cap: 3, refuse: "style references have no number" };
        same("the card: a route that cannot name them", P.cardLine(P.chipState({ n: 1 }, sty), sty), "img1 · style references have no number");
        same("the bar says why too", P.barCount(sty).title, "This recipe takes 3 reference images; an @img token: style references have no number.");
        same("and without a cap", P.barCount({ ...CTX, refuse: "no" }).title, "An @img token: no.");
        const f = (name, type) => ({ name, type });
        same("imageFiles: files", P.imageFiles({ files: [f("a.png", "image/png"), f("b.txt", "text/plain"), f("c.TIF", "")] }).map((x) => x.name), ["a.png", "c.TIF"]);
        same("imageFiles: from items when files is empty", P.imageFiles({ files: [], items: [{ kind: "file", getAsFile: () => f("d.jpg", "image/jpeg") }, { kind: "string", getAsFile: () => null }] }).map((x) => x.name), ["d.jpg"]);
        same("imageFiles: none", P.imageFiles(null), []);
    });


    const failed = results.filter((x) => !x).length;
    console.log(`${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
