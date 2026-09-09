// Film pack: the parametric data. The film stocks come from the editor's grain presets
// (`GRAIN_PRESETS` in renderer/editor/inpaint_filters.js: grain character plus the colour
// "look" of every stock) and get a tone curve class, a halation default and an ISO here.
// Own approximations of how the stocks are described, no manufacturer data; the names are
// used referentially with the trademark note (docs/BRIEF.md §3).

import { GRAIN_PRESETS } from "/editor/inpaint_filters.js";

// tone curve per group: negatives have a soft toe and shoulder, slides a hard toe, cine
// stocks a long shoulder (log-like), black and white a bit of both
const CLASS = {
    "Colour negative": { toe: 0.12, shoulder: 0.30, halation: 12 },
    "Slide": { toe: 0.30, shoulder: 0.10, halation: 6 },
    "Black & white": { toe: 0.18, shoulder: 0.25, halation: 0 },
    "Cine": { toe: 0.08, shoulder: 0.45, halation: 18 },
    "Special & artistic": { toe: 0.20, shoulder: 0.20, halation: 10 },
};

// per-stock departures from the class
const STOCK = {
    cinestill800t: { halation: 55 },      // no remjet layer: the famous red halos
    cinestill400d: { halation: 35 },
    cinestill50d: { halation: 25 },
    velvia50: { toe: 0.4, shoulder: 0.08 },
    kodachrome64: { toe: 0.35, shoulder: 0.12 },
    instant: { toe: 0.35, shoulder: 0.5, halation: 0 },
    expired: { shoulder: 0.5 },
    lomometropolis: { toe: 0.3 },
    delta3200: { toe: 0.1, shoulder: 0.4 },
    tmax3200: { toe: 0.1, shoulder: 0.4 },
    panf50: { toe: 0.25, shoulder: 0.15 },
    vision3_500t: { halation: 22 },
};

function isoOf(label) {
    const m = /(\d{2,4})/.exec(label.replace(/E100/, "100").replace(/P3200/, "3200"));
    return m ? +m[1] : null;
}

/** Every film stock with grain, look, tone class, halation default and ISO. */
export const STOCKS = GRAIN_PRESETS.filter((p) => p.id !== "custom").map((p) => {
    const cls = CLASS[p.group] || CLASS["Special & artistic"];
    const over = STOCK[p.id] || {};
    return {
        id: p.id, label: p.label, group: p.group, iso: isoOf(p.label),
        grain: { amount: p.amount, size: p.size, speckle: p.speckle, chroma: p.chroma },
        look: p.look || {},
        toe: over.toe ?? cls.toe, shoulder: over.shoulder ?? cls.shoulder, halation: over.halation ?? cls.halation,
    };
});
export const STOCK_BY_ID = Object.fromEntries(STOCKS.map((s) => [s.id, s]));
export const GROUPS = Array.from(new Set(STOCKS.map((s) => s.group)));

/** Select options for the look filter: id, label, group only (the editor copies every other field into the params). */
export const STOCK_OPTIONS = [{ id: "none", label: "None (adjustments only)" }, ...STOCKS.map((s) => ({ id: s.id, label: s.label, group: s.group }))];

// ---- black and white ---------------------------------------------------------------------------

/** Colour filters in front of a black-and-white film: hue of the filter and how strongly it weights the channels. */
export const BW_FILTERS = [
    { id: "none", label: "No filter", filter_hue: 0, filter_strength: 0 },
    { id: "yellow", label: "Yellow filter (slightly darker sky)", filter_hue: 55, filter_strength: 45 },
    { id: "orange", label: "Orange filter (darker sky, lighter skin)", filter_hue: 35, filter_strength: 65 },
    { id: "red", label: "Red filter (dramatic sky)", filter_hue: 10, filter_strength: 90 },
    { id: "deepred", label: "Deep red / infrared", filter_hue: 0, filter_strength: 100 },
    { id: "green", label: "Green filter (foliage bright, skin darker)", filter_hue: 110, filter_strength: 70 },
    { id: "blue", label: "Blue filter (orthochromatic, red goes dark)", filter_hue: 220, filter_strength: 80 },
    { id: "custom", label: "Custom hue" },
];

/** Chemical toners as split-toning parameters (hue / saturation for highlights and shadows). */
export const TONERS = [
    { id: "none", label: "No toning" },
    { id: "sepia", label: "Sepia", hh: 38, hs: 40, sh: 30, ss: 25 },
    { id: "selenium", label: "Selenium (cool purple shadows)", hh: 40, hs: 6, sh: 290, ss: 22 },
    { id: "cyanotype", label: "Cyanotype", hh: 200, hs: 45, sh: 215, ss: 60 },
    { id: "platinum", label: "Platinum / palladium (warm grey)", hh: 42, hs: 14, sh: 35, ss: 10 },
    { id: "gold", label: "Gold toner (warm highlights, blue shadows)", hh: 30, hs: 30, sh: 225, ss: 20 },
    { id: "split", label: "Split: warm highlights, cool shadows", hh: 45, hs: 35, sh: 215, ss: 35 },
];
export const TONER_BY_ID = Object.fromEntries(TONERS.map((t) => [t.id, t]));

// ---- cross processing -----------------------------------------------------------------------

/** Per-channel curves ([x, y] points in 0..1) and a saturation factor per style. */
export const XPRO_STYLES = [
    { id: "e6c41", label: "Slide film in C-41 (E-6 → C-41)", sat: 1.15,
      r: [[0, 0.04], [0.25, 0.19], [0.5, 0.55], [0.75, 0.86], [1, 1]], g: [[0, 0], [0.25, 0.22], [0.5, 0.53], [0.75, 0.81], [1, 0.95]], b: [[0, 0.14], [0.5, 0.5], [1, 0.84]] },
    { id: "c41e6", label: "Negative film in E-6 (C-41 → E-6)", sat: 0.85,
      r: [[0, 0.08], [0.5, 0.47], [1, 0.9]], g: [[0, 0.05], [0.5, 0.5], [1, 0.95]], b: [[0, 0.17], [0.5, 0.56], [1, 0.86]] },
    { id: "lomo", label: "Lomo (saturated, green cast)", sat: 1.3,
      r: [[0, 0], [0.3, 0.24], [0.7, 0.8], [1, 1]], g: [[0, 0.03], [0.3, 0.3], [0.7, 0.79], [1, 0.98]], b: [[0, 0.06], [0.5, 0.48], [1, 0.9]] },
    { id: "cool", label: "Cool blues (bleach and teal)", sat: 0.95,
      r: [[0, 0], [0.5, 0.45], [1, 0.95]], g: [[0, 0.02], [0.5, 0.5], [1, 1]], b: [[0, 0.1], [0.5, 0.58], [1, 1]] },
];
export const XPRO_BY_ID = Object.fromEntries(XPRO_STYLES.map((s) => [s.id, s]));

// ---- light leaks ----------------------------------------------------------------------------

export const LEAK_STYLES = [
    { id: "edge", label: "Warm edge (light through the back door)" },
    { id: "streak", label: "Streak across the frame" },
    { id: "corner", label: "Corner burst" },
    { id: "double", label: "Two streaks" },
    { id: "bars", label: "Bars (light along the sprockets)" },
];

// ---- frames ---------------------------------------------------------------------------------

export const FRAME_STYLES = [
    { id: "line", label: "Thin line" },
    { id: "matte", label: "Matte border with key line" },
    { id: "rebate", label: "Film rebate (dark, rounded)" },
    { id: "slide", label: "Slide mount" },
    { id: "instant", label: "Instant print" },
    { id: "rough", label: "Rough edge" },
    { id: "oval", label: "Oval matte" },
];
export const FRAME_COLOURS = [
    { id: "black", label: "Black", rgb: [0.03, 0.03, 0.03] },
    { id: "white", label: "White", rgb: [0.98, 0.98, 0.98] },
    { id: "cream", label: "Cream", rgb: [0.96, 0.93, 0.86] },
    { id: "grey", label: "Dark grey", rgb: [0.22, 0.22, 0.22] },
    { id: "warm", label: "Warm grey", rgb: [0.62, 0.58, 0.52] },
];
export const FRAME_COLOUR_BY_ID = Object.fromEntries(FRAME_COLOURS.map((c) => [c.id, c]));
