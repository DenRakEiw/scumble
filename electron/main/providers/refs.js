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
// index.js turns a marker into `nameOf(refName, n)` ("image 3") and refuses what it cannot name. Before that,
// checkPictures() holds the request to the layout: a route that declares `drops` gets no reference at all (a note says
// so), a run past `max` is refused. The adapters build their instruction sentence with instruction() and their label
// parts with labelParts(), both numbered by the same layout, so a sentence and a resolved marker name the same picture.
// No Electron, no I/O.
"use strict";

const MARKER = /\{@ref:(\d+)\}/g;
const MARKER_ANY = /\{@ref:/;
// one well-formed marker, without MARKER's global state (checkPictures)
const MARKER_ONE = /\{@ref:\d+\}/;
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

/** Whether a picture counts for the model's count: every one but a mask in its own field. */
const counted = (p) => !(p.role === "mask" && p.n == null);

/** How many pictures a request with this layout carries for the model's count: all but a mask in its own field. */
function countOf(l) {
    return l.pictures.filter(counted).length;
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

// ---- the instruction, the label parts and the check before the adapter (26a2) ------------------------------------

/** The pattern a request names its pictures by: its refName when valid, else the default. */
const patternOf = (req) => (req && validRefName(req.refName) ? req.refName : REF_NAME_DEFAULT);

/** A name at the start of a sentence: the first character upper case when it is a letter ("<image2>" stays). */
const capital = (s) => (/^\p{Ll}/u.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The numbered pictures of a layout, by n. */
const numbered = (lay) => lay.pictures.filter((p) => p.n != null).sort((a, b) => a.n - b.n);

/**
 * The sentences for the references numbered `ns` (ascending). A pattern that is one word and the number ("image
 * {n}") gets range words per run of consecutive numbers ("Images 3 and 4", "Images 3 to 6"); any other pattern a list
 * of the names ("<image3>, <image4> and <image5> are reference images.").
 */
function referenceSentences(ns, pat) {
    if (!ns.length) return [];
    const word = /^([A-Za-z]+) \{n\}$/.exec(pat);
    if (!word) {
        const names = ns.map((n) => nameOf(pat, n));
        const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
        return [`${capital(list)} ${names.length === 1 ? "is a reference image" : "are reference images"}.`];
    }
    const runs = [];
    for (const n of ns) {
        const r = runs[runs.length - 1];
        if (r && n === r[1] + 1) r[1] = n; else runs.push([n, n]);
    }
    const plural = capital(word[1]) + "s";
    return runs.map(([a, b]) => (a === b ? `${capital(nameOf(pat, a))} is a reference image.` : `${plural} ${a} ${b === a + 1 ? "and" : "to"} ${b} are reference images.`));
}

/**
 * The prompt an adapter sends with the pictures of this layout: what to edit (with a mask picture, what the mask
 * means), the user's text, then what the Original and the references are, each picture by the name the layout gives it
 * (so a resolved marker and the sentence agree). A layout of style references gets no reference sentence (they have no
 * number). Kind "upscale" takes the text unchanged; kind "text" (Generate new, 26f) edits no picture: the text, then
 * what the references are ("Image 1 is a reference image.", "Images 1 to 3 are reference images."), and the text
 * unchanged without any.
 */
function instruction(req, lay, text) {
    const t = String(text == null ? "" : text);
    if (req && req.kind === "upscale") return t;
    if (req && req.kind === "text") {
        const ns = lay && !lay.style ? numbered(lay).filter((p) => p.role === "reference").map((p) => p.n) : [];
        return ns.length ? [t.trim(), ...referenceSentences(ns, patternOf(req))].filter(Boolean).join(" ") : t;
    }
    const pat = patternOf(req);
    const pics = numbered(lay);
    const name = (p) => nameOf(pat, p.n);
    const crop = pics.find((p) => p.role === "crop");
    const first = crop ? name(crop) : nameOf(pat, 1);
    const mask = pics.find((p) => p.role === "mask");
    // the mask clause ran live on OpenRouter (GPT Image 2.5): keep it word for word
    const head = mask
        ? `Edit ${first}. ${capital(name(mask))} is a mask: change only the white area of the mask, keep everything else exactly as it is, and keep the image size and framing.`
        : `Edit ${first} and keep its size and framing.`;
    const tail = [];
    // the Original is the crop before the selected area was filled (renderer/editor/stitch.js fillMasked)
    const orig = pics.find((p) => p.role === "original");
    if (orig) tail.push(`${capital(name(orig))} is ${first} before the selected area was filled.`);
    if (!lay.style) tail.push(...referenceSentences(pics.filter((p) => p.role === "reference").map((p) => p.n), pat));
    return [head, t.trim(), ...tail].filter(Boolean).join(" ");
}

/** A text part before each numbered picture ("Image 1:", by n), for the APIs that interleave text and pictures; [] for one. */
function labelParts(lay, pattern) {
    const pics = numbered(lay);
    return pics.length > 1 ? pics.map((p) => ({ text: `${capital(nameOf(pattern, p.n))}:` })) : [];
}

/** The references of a request in words: "the Original and 2 reference layers", "1 reference layer", "the Original". */
function countWords(req) {
    const orig = req.original ? 1 : 0, n = (req.references || []).length - orig;
    const out = [];
    if (orig) out.push("the Original");
    if (n > 0) out.push(`${n} reference layer${n === 1 ? "" : "s"}`);
    return out.join(" and ");
}

/** The pictures countOf() counts, in words: "the crop, the mask, the Original, 3 reference layers". */
function partsOf(lay) {
    const pics = lay.pictures.filter(counted);
    const has = (role) => pics.filter((p) => p.role === role).length;
    const out = [];
    if (has("crop")) out.push("the crop");
    if (has("mask")) out.push("the mask");
    if (has("original")) out.push("the Original");
    const r = has("reference");
    if (r) out.push(`${r} reference layer${r === 1 ? "" : "s"}`);
    return out.join(", ");
}

/**
 * The request held to its layout before the adapter runs; `who` names the route in the messages ("fal
 * fal-ai/flux-pro/v1/fill"). A route that declares `drops` gets no Original and no reference at all (all or nothing),
 * and a note says what was left out; a prompt that names a reference there, or names a style reference, is refused; a
 * run with more pictures than `max` (countOf) is refused. Returns { req, notes }: `req` the same object when nothing
 * changed, else a copy with references [] and original 0. Kind "upscale" passes (index.js lays it out without
 * references); kind "text" (Generate new, 26f) is held to its text layout the same way, its refusal naming the
 * references only (a new image has no crop and no Original).
 */
function checkPictures(lay, req, who) {
    const given = (req.references || []).length;
    if (!given || req.kind === "upscale") return { req, notes: [] };
    const marker = MARKER_ONE.test(`${req.prompt || ""} ${req.negative || ""}`);
    const drops = lay.drops ? String(lay.drops).replace(/[\s.]+$/, "") : "";
    if (drops) {
        if (marker) throw new Error(`${who}: ${drops}, so the prompt cannot name a reference image. Take the name out or pick a recipe that sends references.`);
        return { req: { ...req, references: [], original: 0 }, notes: [`${who}: ${drops}; ${countWords(req)} not sent.`] };
    }
    if (lay.style && marker) throw new Error(`${who} sends reference layers as style references, which have no number: take the name out of the prompt.`);
    const max = +lay.max > 0 ? +lay.max : null, count = countOf(lay);
    if (max != null && count > max && req.kind === "text") {
        throw new Error(`${who} takes at most ${max} reference picture${max === 1 ? "" : "s"} for a new image; this run has ${count}: hide reference layers.`);
    }
    if (max != null && count > max) {
        throw new Error(`${who} takes at most ${max} picture${max === 1 ? "" : "s"}; this run has ${count} (${partsOf(lay)}): hide reference layers or turn Original off.`);
    }
    return { req, notes: [] };
}

module.exports = { MARKER, MARKER_ANY, TOKEN, REF_NAME_DEFAULT, validRefName, nameOf, refRoles, layoutOf, countOf, checkLayout, resolveMarkers, instruction, labelParts, checkPictures };
