// @ts-check
// Generate new with presets (item 34, docs/PLAN_NEW_PRESETS.md): the aspects and size classes a model variant offers,
// the preset nearest a picture, the working canvas of a preset and the note when boxes would go stretched.
// Pure: no DOM, no imports, app only (not in tools/build_node.py FILES). Tested by tools/genpresets_test.js.

/** "W:H" with whole or decimal sides ("16:9", "2.35:1", "19.5:9"); "auto", "free" and the like are no aspect. */
const ASPECT_RE = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/;

/** The long sides FLUX 3's classes stand for (flux3.js FLUX3_TIERS counts by area: about 1, 4 and 16 MP). */
const FLUX3_TIERS = { "1k": 1024, "2k": 2048, "4k": 4096 };

/** The working canvas of a preset never goes past this on its long side (the user, 2026-10-11). */
export const WORKING_MAX = 2048;

/** Two shapes count as the same within 3 % of their ratio (flux3.js FIT_SLACK). */
export const SHAPE_SLACK = 0.03;

/**
 * @param {unknown} a
 * @returns {[number, number] | null}
 */
export function parseAspect(a) {
    const m = ASPECT_RE.exec(String(a == null ? "" : a));
    if (!m) return null;
    const w = +m[1], h = +m[2];
    return w > 0 && h > 0 ? [w, h] : null;
}

/**
 * @param {unknown} a
 * @returns {number | null}
 */
export function ratioOf(a) {
    const p = parseAspect(a);
    return p ? p[0] / p[1] : null;
}

/** @param {unknown} list @returns {string[]} the aspects of a list, cleaned, in its own order, each once */
function cleanAspects(list) {
    if (!Array.isArray(list)) return [];
    /** @type {string[]} */
    const out = [];
    for (const x of list) {
        const p = parseAspect(x);
        if (!p) continue;
        const s = `${p[0]}:${p[1]}`;
        if (!out.includes(s)) out.push(s);
    }
    return out;
}

/**
 * The aspects a variant (a recipe's `providers[id]`, or a resolved recipe) takes for a new image, from its own data:
 * `text.aspects`, then `options.text.ratios`, `options.ratios`, `options.aspect_ratios`, then `limits.aspects`; a
 * variant that names none takes any shape, and gets `fallback` (the dialog's general list).
 *
 * @param {any} v
 * @param {string[]} [fallback]
 * @returns {string[]}
 */
export function aspectsOf(v, fallback = []) {
    const o = (v && v.options) || {};
    const t = (v && v.text) || {};
    const lists = [t.aspects, o.text && o.text.ratios, o.ratios, o.aspect_ratios, v && v.limits && v.limits.aspects];
    for (const l of lists) {
        const got = cleanAspects(l);
        if (got.length) return got;
    }
    return cleanAspects(fallback);
}

/**
 * The aspect of `list` nearest the shape w x h (by the log of the ratio), or null for an empty list.
 *
 * @param {number} w
 * @param {number} h
 * @param {string[]} list
 * @returns {string | null}
 */
export function nearestAspect(w, h, list) {
    if (!(w > 0) || !(h > 0)) return null;
    const want = Math.log(w / h);
    let best = null, bestD = Infinity;
    for (const a of list || []) {
        const r = ratioOf(a);
        if (!r) continue;
        const d = Math.abs(Math.log(r) - want);
        if (d < bestD - 1e-12) { best = a; bestD = d; }
    }
    return best;
}

/**
 * @param {number} w1
 * @param {number} h1
 * @param {number} w2
 * @param {number} h2
 * @param {number} [slack]
 */
export function sameShape(w1, h1, w2, h2, slack = SHAPE_SLACK) {
    if (!(w1 > 0 && h1 > 0 && w2 > 0 && h2 > 0)) return false;
    return Math.abs(Math.log(w1 / h1) - Math.log(w2 / h2)) <= slack;
}

/**
 * The shapes a note names a picture by when the variant's own list has none near it (FLUX 3's fifteen: the common
 * photo and screen shapes).
 */
export const NAMED_ASPECTS = ["21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16", "1:2", "9:21"];

/**
 * A shape in words: the aspect of `list` it is (within the slack), else "W x H" (with the multiplication sign).
 *
 * @param {number} w
 * @param {number} h
 * @param {string[]} [list]
 */
export function shapeLabel(w, h, list = []) {
    const a = nearestAspect(w, h, list);
    const r = a ? ratioOf(a) : null;
    if (a && r && sameShape(w, h, r, 1)) return a;
    return `${Math.round(w)} \u00d7 ${Math.round(h)}`;
}

/** @param {number} v a side, a multiple of 16 within 64..8192 (shell.js genSize) */
export function round16(v) {
    return Math.max(64, Math.min(8192, Math.round(v / 16) * 16));
}

/**
 * The size Generate new asks for: `long` on the aspect's long side, the other side from the aspect, both multiples of
 * 16 (the same rule as shell.js genSize and commands.js sizeForAspect).
 *
 * @param {string} aspect
 * @param {number} long
 * @returns {[number, number]}
 */
export function sizeFor(aspect, long) {
    const p = parseAspect(aspect) || [1, 1];
    const [aw, ah] = p;
    const L = +long || 1024;
    return aw >= ah ? [round16(L), round16(L * ah / aw)] : [round16(L * aw / ah), round16(L)];
}

/**
 * The canvas New makes for a preset: the aspect at the class's long side, at most `cap` (the boxes are fractions of
 * the picture, so a 4k class draws on a 2048 px canvas of the same shape).
 *
 * @param {string} aspect
 * @param {number} long
 * @param {number} [cap]
 * @returns {[number, number]}
 */
export function workingSize(aspect, long, cap = WORKING_MAX) {
    return sizeFor(aspect, Math.min(+long || 1024, cap));
}

/** A size up to this much over a tier's area still takes that tier, where the route counts so (flux3.js TIER_SLACK). */
const AREA_SLACK = 1.15;

/**
 * How a provider's adapter counts an area table (`tier_unit: "area"`): OpenRouter squares each value (a long side) and
 * takes a size up to 15 % over it (openrouter.js tierByArea); Oxen compares the pixel count with each value as it is,
 * without slack (oxen.js tierFor, FLUX.2's "0.5 MP" / "1 MP" / "2 MP"). Another provider (none ships an area table)
 * counts by the values: below 10,000 a long side, squared, with the slack; else a pixel count without.
 *
 * @type {Record<string, { square: boolean, slack: number }>}
 */
const AREA_COUNT = { openrouter: { square: true, slack: AREA_SLACK }, oxen: { square: false, slack: 1 } };

/**
 * The tier table a variant names its classes by (`options.tiers`, { name: value }), with how its route counts:
 * `area` false compares the long side with each value (util.js, openrouter.js and oxen.js tierFor; toapis.js tierFor
 * where the variant has no `tier_sizes` row for the size); `area` true compares the pixel count with each value, squared when `square`, times `slack` (AREA_COUNT). FLUX 3
 * without a table counts by area in 1k, 2k and 4k with the 15 % slack (flux3.js tierOf, on every host that sends its
 * shape).
 *
 * @param {any} v
 * @param {string | null} [provider] the variant's provider id (its key in the recipe's `providers`)
 * @returns {TierTable | null}
 */
function tierTable(v, provider = null) {
    const o = (v && v.options) || {};
    if (o.tiers && typeof o.tiers === "object" && Object.keys(o.tiers).length) {
        if (o.tier_unit !== "area") return { tiers: o.tiers, area: false, square: false, slack: 1 };
        const how = provider && Object.prototype.hasOwnProperty.call(AREA_COUNT, provider) ? AREA_COUNT[provider] : null;
        return { tiers: o.tiers, area: true, square: how ? how.square : null, slack: how ? how.slack : null };
    }
    if (o.boxes === "flux3") return { tiers: FLUX3_TIERS, area: true, square: true, slack: AREA_SLACK };
    return null;
}

/**
 * @typedef {{ tiers: Record<string, number>, area: boolean, square: boolean | null, slack: number | null }} TierTable
 * `square` and `slack` null: counted by the values (AREA_COUNT)
 */

/**
 * The name a variant gives the class of long side `px` at `aspect` (1:1 without one): the smallest tier that holds
 * the size Generate new asks for (sizeFor), counted as its route counts (tierTable), else the largest. An area table
 * can name one long side differently per aspect (Oxen's 1024 px is 2 MP at 1:1, 1 MP at 16:9). Null without a table.
 *
 * @param {number} px
 * @param {TierTable | null} table
 * @param {string | null} [aspect]
 * @returns {string | null}
 */
function tierName(px, table, aspect = null) {
    if (!table) return null;
    const [w, h] = sizeFor(aspect && parseAspect(aspect) ? aspect : "1:1", px);
    const want = table.area ? w * h : Math.max(w, h);
    /** @param {number} v */
    const counted = (v) => {
        if (!table.area) return v;
        const square = table.square == null ? v < 10000 : table.square;
        const slack = table.slack == null ? (square ? AREA_SLACK : 1) : table.slack;
        return (square ? v * v : v) * slack;
    };
    const list = Object.entries(table.tiers)
        .map(([name, v]) => /** @type {[string, number]} */ ([name, counted(+v)]))
        .filter(([, v]) => v > 0)
        .sort((a, b) => a[1] - b[1]);
    if (!list.length) return null;
    const hit = list.find(([, v]) => v >= want);
    return String((hit || list[list.length - 1])[0]);
}

/**
 * The size classes of a variant's text route: one per long side of `text.sizes` (or `fallback`), smallest first,
 * labelled with the variant's own tier name where it has one ("2k (2048 px)"), else "2048 px". `provider` (the
 * variant's id) says how an area table counts; `aspect` the shape the class is asked in (1:1 without one), since an
 * area tier depends on it.
 *
 * @param {any} v
 * @param {number[]} [fallback]
 * @param {{ provider?: string | null, aspect?: string | null }} [o]
 * @returns {{ px: number, name: string | null, label: string }[]}
 */
export function classesOf(v, fallback = [], { provider = null, aspect = null } = {}) {
    const t = (v && v.text) || {};
    const raw = Array.isArray(t.sizes) && t.sizes.length ? t.sizes : fallback;
    const sizes = [...new Set(raw.map(Number).filter((x) => x > 0))].sort((a, b) => a - b);
    const table = tierTable(v, provider);
    return sizes.map((px) => {
        const name = tierName(px, table, aspect);
        return { px, name, label: name ? `${name} (${px} px)` : `${px} px` };
    });
}

/**
 * The aspect a dialog opens on or keeps: `want` when the list offers it (a document's preset, or the choice before a
 * refill); else, while boxes go, the one nearest the document; else `keep` when offered; else the one nearest `keep`'s
 * shape; else 1:1 when offered, else the first. "free" (no aspect) is chosen only as `want` or `keep`.
 *
 * @param {string[]} list the aspects offered, "free" among them or not
 * @param {{ want?: string | null, keep?: string | null, doc?: [number, number] | null, boxes?: boolean }} [o]
 * @returns {string | null}
 */
export function chooseAspect(list, { want = null, keep = null, doc = null, boxes = false } = {}) {
    if (!list || !list.length) return null;
    if (want && list.includes(want)) return want;
    const shapes = list.filter((a) => parseAspect(a));
    if (boxes && doc && doc[0] > 0 && doc[1] > 0) {
        const n = nearestAspect(doc[0], doc[1], shapes);
        if (n) return n;
    }
    if (keep && list.includes(keep)) return keep;
    const k = parseAspect(keep);
    const near = k ? nearestAspect(k[0], k[1], shapes) : null;
    if (near) return near;
    return list.includes("1:1") ? "1:1" : list[0];
}

/**
 * The size of `list` equal to `want`, else the nearest to it (1024 when there is no wish), else null for an empty list.
 *
 * @param {number[]} list
 * @param {number | null | undefined} want
 * @returns {number | null}
 */
export function nearestSize(list, want) {
    const sizes = (list || []).map(Number).filter((x) => x > 0);
    if (!sizes.length) return null;
    const w = +want > 0 ? +want : 1024;
    return sizes.includes(w) ? w : sizes.reduce((best, px) => (Math.abs(px - w) < Math.abs(best - w) ? px : best), sizes[0]);
}

/**
 * The note when boxes go and the asked shape is not the one they were drawn on, else "". The shapes are named by
 * `list` (the variant's aspects) and NAMED_ASPECTS, else as "W x H".
 *
 * @param {[number, number]} drawnOn the document's size
 * @param {[number, number]} asked the size Generate new asks for
 * @param {string[]} [list] aspects to name the shapes by
 * @param {string | null} [askedAspect] the aspect as chosen ("1:1"), for the wording
 */
export function stretchNote(drawnOn, asked, list = [], askedAspect = null) {
    const [dw, dh] = drawnOn || [0, 0];
    const [aw, ah] = asked || [0, 0];
    if (!(dw > 0 && dh > 0 && aw > 0 && ah > 0) || sameShape(dw, dh, aw, ah)) return "";
    const names = [...(list || []), ...NAMED_ASPECTS];
    const at = askedAspect && parseAspect(askedAspect) ? askedAspect : shapeLabel(aw, ah, names);
    return `The boxes were drawn on ${shapeLabel(dw, dh, names)}; at ${at} they go stretched.`;
}

/**
 * Is a document's preset (`genSettings.target`) still the one of its canvas? Only while the picture keeps the size it
 * was made or generated at: a crop, a resize or another picture makes it stale without any clean-up.
 *
 * @param {any} target
 * @param {{ width?: number, height?: number } | null} ed
 */
export function targetValid(target, ed) {
    return !!(target && ed && target.recipe && +target.width > 0 && +target.width === ed.width && +target.height === ed.height);
}
