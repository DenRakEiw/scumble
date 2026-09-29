// Where each picture of a provider request sits and what the model calls it (item 26, docs/PLAN_REFS.md C1-C3).
//
// The renderer writes a reference image the prompt names as a marker `{@ref:i}`, i = the picture's index in
// `request.references` (the Original copy of the crop at 0 when `request.original` is 1). Each adapter declares with
// `layout(req)` the order its builder really sends the pictures in:
//
//   layout(req) -> { pictures: [{ role: "crop" | "mask" | "original" | "reference", ref?, field, n }], max, drops, style }
//
// `n` is the picture's 1-based place among the pictures the model numbers (the order sent), null for a picture in a
// field of its own (a mask field, Ideogram's style references). `max` is the adapter's own refusal threshold, counted
// with countOf() (every picture but a mask in its own field), null where the builder does not check. `drops` is a
// sentence whenever this route leaves out references it may be given; which ones is read from `pictures` (an index
// without an entry). `style`: the references go as style references (Magnific's Ideogram).
//
// index.js turns a marker into `nameOf(refName, n)` ("image 3") and refuses what it cannot name. No Electron, no I/O.
"use strict";

const MARKER = /\{@ref:(\d+)\}/g;
const MARKER_ANY = /\{@ref:/;
// the grammar of renderer/editor/reftokens.js (C1): live @img1 .. @img999, parked @img?<layer id>; the prefix is
// case-insensitive by hand so the id stays case-sensitive; @img0, @img01, @img1234 and @img?labc are plain text
const TOKEN = /(?<![\w-])@[Ii][Mm][Gg](?:([1-9]\d{0,2})|\?(L[0-9a-z]+))(?![\w-])/;
const REF_NAME_DEFAULT = "image {n}";

/** A recipe's `refs.name`: 1-40 characters, `{n}` (1-based) or `{n0}` (0-based) at least once, no `@` or stray brace. */
function validRefName(s) {
    return typeof s === "string" && s.length > 0 && s.length <= 40 && /\{n0?\}/.test(s) && /^(?:[^@{}]|\{n0?\})*$/.test(s);
}

/** The name of picture n (1-based) under a pattern; an invalid pattern gives the default's. */
function nameOf(pat, n) {
    return (validRefName(pat) ? pat : REF_NAME_DEFAULT).replace(/\{n0\}/g, String(n - 1)).replace(/\{n\}/g, String(n));
}

/** [role, index] of req.references in order, the first `cap`; references[0] is the Original when req.original. */
function refRoles(req, cap = Infinity) {
    const orig = req.original ? 1 : 0;
    return (req.references || []).slice(0, cap).map((_, i) => [i < orig ? "original" : "reference", i]);
}

/**
 * A layout from the order a builder sends: `seq` the numbered pictures as [role, field, ref?] in the order sent (n =
 * place, 1-based), `own` the pictures in a field of their own (n null).
 */
function layoutOf({ seq = [], own = [], max = null, drops = null, style = false } = {}) {
    const pic = ([role, field, ref], n) => (ref == null ? { role, field, n } : { role, ref, field, n });
    return {
        pictures: [...seq.map((s, i) => pic(s, i + 1)), ...own.map((s) => pic(s, null))],
        max: max == null ? null : max,
        drops: drops || null,
        style: !!style,
    };
}

/** How many pictures a request with this layout carries for the model's count: all but a mask in its own field. */
function countOf(l) {
    return l.pictures.filter((p) => !(p.role === "mask" && p.n == null)).length;
}

/**
 * A layout that does not describe a request of this shape is a bug in the adapter's declaration: the numbered
 * pictures are 1..N without a gap, there is one crop (none for a text run), and each reference index is a real one,
 * once, with the Original's role at index 0 only.
 */
function checkLayout(l, req) {
    const where = `layout of ${req && req.provider ? req.provider : "a provider"}`;
    if (!l || !Array.isArray(l.pictures)) throw new Error(`${where}: no pictures.`);
    const ns = l.pictures.filter((p) => p.n != null).map((p) => p.n).sort((a, b) => a - b);
    ns.forEach((n, i) => { if (n !== i + 1) throw new Error(`${where}: the numbered pictures are ${ns.join(", ")}, not 1 to ${ns.length}.`); });
    const crops = l.pictures.filter((p) => p.role === "crop").length;
    const want = req && req.kind === "text" ? 0 : 1;
    if (crops !== want) throw new Error(`${where}: ${crops} crop pictures, not ${want}.`);
    const count = (req && req.references ? req.references.length : 0), orig = req && req.original ? 1 : 0;
    const seen = new Set();
    for (const p of l.pictures) {
        if (p.role !== "original" && p.role !== "reference") continue;
        if (!Number.isInteger(p.ref) || p.ref < 0 || p.ref >= count) throw new Error(`${where}: reference index ${p.ref} of ${count}.`);
        if (seen.has(p.ref)) throw new Error(`${where}: reference index ${p.ref} twice.`);
        if ((p.role === "original") !== (p.ref < orig)) throw new Error(`${where}: reference index ${p.ref} has the role ${p.role}.`);
        seen.add(p.ref);
    }
    return l;
}

/**
 * Markers to names: each `{@ref:i}` whose picture is numbered becomes `nameOf(pattern, n)`. `left` lists the markers
 * kept as they were ({ ref, why: "absent" | "unnumbered" }, once each), `refs` the resolved ones ({ ref, name }, once
 * each, in the order they first appear).
 */
function resolveMarkers(text, pictures, pattern) {
    const byRef = new Map();
    for (const p of pictures || []) if (p.ref != null && (p.role === "original" || p.role === "reference")) byRef.set(p.ref, p);
    const left = [], refs = [], seenLeft = new Set(), seenRef = new Set();
    const out = String(text == null ? "" : text).replace(MARKER, (m, d) => {
        const i = +d, p = byRef.get(i);
        if (!p || p.n == null) {
            if (!seenLeft.has(i)) { seenLeft.add(i); left.push({ ref: i, why: p ? "unnumbered" : "absent" }); }
            return m;
        }
        const name = nameOf(pattern, p.n);
        if (!seenRef.has(i)) { seenRef.add(i); refs.push({ ref: i, name }); }
        return name;
    });
    return { text: out, left, refs };
}

module.exports = { MARKER, MARKER_ANY, TOKEN, REF_NAME_DEFAULT, validRefName, nameOf, refRoles, layoutOf, countOf, checkLayout, resolveMarkers };
