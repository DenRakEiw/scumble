// Generate each area separately (CLAUDE.md item 54, issue #9). A selection of several areas apart (people selected by
// text, say) goes as one crop of all of them, scaled down to the model's size, so each area comes back soft. This module
// counts the areas, says before a run when one crop of all of them goes out strongly scaled down (`areaHint`), and runs
// each area as its own Generate, one after another (`runEachArea`): the same prompt, each area its own crop, its own run
// and its own result layer.
//
// The count: the selection's selected pixels on a coarse grid (at most 1024 cells a side), off the window in the pool's
// `area_cells` job on tiles (inpaint_areas.js has the arithmetic), debounced after a selection change; parts smaller than
// a speck are left out, and the parts whose crops would overlap are one area. A run of one area holds the selection cut to
// that area's reach (its crop and a rim) only while the run reads it: the user's own selection is back as soon as the crop
// is made (an API run) or the prompt is queued (a recipe on the user's ComfyUI).
//
// The app's only (the host calls it; the node's editor never does, its host has none of it).

import { areaCell, speckPixels, countTileCells, countRowCells, labelParts, groupAreas, boxesMeet } from "./inpaint_areas.js";
import { planFrame, planBox } from "./stitch.js";
import { editorPool } from "./inpaint_jobs.js";
import { NORMAL } from "./inpaint_pool.js";
import { storeArgs, stackInArena } from "./inpaint_bands.js";
import { isTilePixels, TILE_SIZE } from "./inpaint_tiles.js";
import { arenaEnabled } from "./inpaint_arena.js";
import { canvasOf } from "./inpaint_pixels.js";
import { refusal, failKind, isCancel } from "./inpaint_status.js";

/** The most areas one click of Each area runs. */
export const AREA_CAP = 8;
/** The hint: one crop of all areas goes out at less than half its size ... */
export const HINT_SCALE = 0.5;
/** ... and at least half of the areas would go out at least 1.5 times as large on their own. */
export const HINT_GAIN = 1.5;
/** The count waits this long after the last change of the selection. */
const COUNT_DELAY = 250;
const RUN_GOING = "A run is still going on this document: wait for it, or Cancel.";

// ---- the count ---------------------------------------------------------------------------------

// an id per selection object: a count names the object it is of without holding it (a replaced canvas selection of a
// large picture is hundreds of MB)
const selIds = new WeakMap();
let selSeq = 0;
function selIdOf(sel) {
    if (!sel) return 0;
    let n = selIds.get(sel);
    if (!n) { n = ++selSeq; selIds.set(sel, n); }
    return n;
}

/** What a count is of: the selection object (by id), its change counter and the picture's size. */
function keyOf(editor) {
    return { sel: selIdOf(editor.sel), seq: editor.selectionSeq, w: editor.width || 0, h: editor.height || 0 };
}

function sameKey(a, k) {
    return !!a && !!k && a.sel === k.sel && a.seq === k.seq && a.w === k.w && a.h === k.h;
}

/** The count of the selection as it is now, or null while there is none (not counted yet, or a count on its way). */
export function currentAreas(editor) {
    const c = editor && editor._areas;
    return c && sameKey(c, keyOf(editor)) ? c : null;
}

/**
 * The selection's parts, counted now unless the count is current: `{ sel, seq, w, h, parts, specks, speckBoxes, more,
 * cell, speck, how, ms }` (labelParts's fields; `how`: pool, window, canvas or none). A count of a selection that changed
 * before it was in is answered but not kept.
 */
export function countAreas(editor) {
    const k = keyOf(editor);
    const c = currentAreas(editor);
    if (c) return Promise.resolve(c);
    const going = editor._areasCounting;
    if (going && sameKey(going.key, k)) return going.promise;
    const promise = (async () => {
        const t0 = performance.now();
        const got = await countNow(editor, k);
        const entry = { ...k, ...got, ms: performance.now() - t0 };
        if (sameKey(k, keyOf(editor))) editor._areas = entry;
        return entry;
    })().finally(() => { if (editor._areasCounting && editor._areasCounting.promise === promise) editor._areasCounting = null; });
    editor._areasCounting = { key: k, promise };
    return promise;
}

async function countNow(editor, k) {
    const { w: W, h: H } = k;
    const sel = editor.sel;   // the object `k` names: read before anything is awaited
    const cell = areaCell(W, H), speck = speckPixels(W, H);
    const none = { parts: [], specks: 0, speckBoxes: [], more: 0, cell, speck, how: "none", window: 0 };
    if (!sel || !W || !H || !editor.base) return none;
    const tw = performance.now();
    const b = editor.getBounds();
    if (!b) return none;
    const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
    if (isTilePixels(sel)) {
        // the tiles stay as they are until the count is in: a job reads them where they lie (a clone shares them)
        const snap = sel.clone();
        try {
            const pool = editorPool();
            if (arenaEnabled() && !pool.off && stackInArena(snap)) {
                try {
                    const args = { sel: storeArgs(snap, 0, 0, b[1], b[3]), W, H, cell, speck };
                    const window = performance.now() - tw;   // what the window spends before the job goes
                    const r = await pool.run("area_cells", args, [], { priority: NORMAL, timeout: 120000 });
                    return { parts: r.parts, specks: r.specks, speckBoxes: r.speckBoxes, more: r.more, cell, speck, how: "pool", window, timing: r.timing || null };
                } catch (err) {
                    console.warn("Scumble: counting the selection's areas in the pool failed, counting on the window:", (err && err.message) || err);
                }
            }
            const counts = new Uint32Array(gw * gh);
            await countTilesHere(snap, b, W, H, cell, gw, counts);
            return { ...labelParts(counts, gw, gh, cell, W, H, speck), cell, speck, how: "window", window: performance.now() - tw };
        } finally {
            snap.release();
        }
    }
    // the canvas backend: a picture of up to 1024 px a side read exactly, a larger one scaled down to the grid (each
    // cell's alpha its share of selected pixels)
    const counts = new Uint32Array(gw * gh);
    if (cell === 1) {
        const img = sel.readRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
        countRowCells(img.data, img.width, img.height, b[0], b[1], 1, gw, counts);
    } else {
        const c = document.createElement("canvas");
        c.width = gw; c.height = gh;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(canvasOf(sel), 0, 0, W, H, 0, 0, W / cell, H / cell);
        const d = ctx.getImageData(0, 0, gw, gh).data;
        const full = cell * cell;
        for (let i = 0, j = 3; i < counts.length; i++, j += 4) if (d[j]) counts[i] = Math.max(1, Math.round((d[j] / 255) * full));
        c.width = c.height = 1;
    }
    return { ...labelParts(counts, gw, gh, cell, W, H, speck), cell, speck, how: "canvas", window: performance.now() - tw };
}

/** The tiles of `snap` inside the box `b` counted on the window, a few milliseconds at a time (no pool, no arena). */
async function countTilesHere(snap, b, W, H, cell, gw, counts) {
    let t0 = performance.now();
    for (let ty = b[1] >> 8; ty * TILE_SIZE < b[3]; ty++) {
        for (let tx = b[0] >> 8; tx * TILE_SIZE < b[2]; tx++) {
            const t = snap.tileAt(tx, ty);
            if (!t) continue;
            const ox = tx * TILE_SIZE, oy = ty * TILE_SIZE;
            countTileCells(t.data, ox, oy, Math.min(TILE_SIZE, W - ox), Math.min(TILE_SIZE, H - oy), cell, gw, counts);
            if (performance.now() - t0 > 8) { await new Promise((r) => setTimeout(r, 0)); t0 = performance.now(); }
        }
    }
}

// ---- the areas -----------------------------------------------------------------------------------

/** The scale a planned crop goes out at: its emitted long side over its own. */
function scaleOf(p) {
    return Math.max(p.emitted[0], p.emitted[1]) / Math.max(1, p.w, p.h);
}

/**
 * The areas of a count for the selected recipe: its parts joined where their crops (the run's own geometry, stitch.js
 * planBox, with the recipe's limits) would overlap, each `{ box, crop, reach, px, parts, scale }`, in reading order.
 * Null for a count of more parts than it lists. Kept on the count while the settings the crops depend on stay.
 */
export function areaGroups(host, editor, entry = currentAreas(editor)) {
    if (!entry || entry.more) return null;
    if (!entry.parts.length) return [];
    const limits = host.cropLimits();
    const gen = editor.genSettings || {}, crop = editor.cropSettings || {};
    const sig = JSON.stringify([limits, host.nodeParams, crop.context, crop.feather, gen.mode, gen.denoise, gen.refine, editor.width, editor.height]);
    if (entry.groups && entry.groupsSig === sig) return entry.groups;
    const params = host.nodeParams;
    const cropOf = (box) => { const p = planBox(editor, params, limits, box); return [p.x, p.y, p.x + p.w, p.y + p.h]; };
    const groups = groupAreas(entry.parts, cropOf, { margin: 2 * entry.cell, W: entry.w, H: entry.h });
    for (const g of groups) g.scale = scaleOf(planBox(editor, params, limits, g.box));
    entry.groups = groups;
    entry.groupsSig = sig;
    return groups;
}

/** How many areas a count holds (its listed parts' areas, or more than it lists). */
function areaCount(host, editor, entry) {
    const groups = areaGroups(host, editor, entry);
    return groups ? groups.length : entry.parts.length + entry.more;
}

/** Why Each area cannot run the recipe `r`, or "". */
export function recipeRefusal(r) {
    if (!r) return "No recipe selected.";
    const name = r.name || r.id;
    if (r.task === "upscale" || r.task === "pass") return `Each area runs an edit recipe; ${name} is not one: use Upscale for it.`;
    if (r.edit === false) return `${name} makes new pictures from the prompt alone: Each area needs a recipe that edits a selection.`;
    return "";
}

/** The specks of a count that lie outside every area's reach (a run of each area leaves them out). */
function specksLeftOut(entry, groups) {
    const listed = entry.speckBoxes.filter((b) => !groups.some((g) => boxesMeet(g.reach, b))).length;
    return listed + Math.max(0, entry.specks - entry.speckBoxes.length);
}

/**
 * The selection for the `status` command: `{ count (null while it is being counted), each_area (whether Each area would
 * run them with the selected recipe), cap, specks, areas: [{ x, y, w, h }] (each area's box on the grid) }`. Counts now
 * when the count is not current.
 */
export async function areaState(host, editor) {
    if (!editor.base) return { count: 0, each_area: false, cap: AREA_CAP, specks: 0, areas: [] };
    let entry = await countAreas(editor);
    if (!sameKey(entry, keyOf(editor))) entry = await countAreas(editor);
    const groups = areaGroups(host, editor, entry);
    const count = groups ? groups.length : entry.parts.length + entry.more;
    return {
        count, cap: AREA_CAP, specks: entry.specks,
        each_area: count >= 2 && count <= AREA_CAP && !recipeRefusal(host.recipe),
        areas: (groups || []).map((g) => ({ x: g.box[0], y: g.box[1], w: g.box[2] - g.box[0], h: g.box[3] - g.box[1] })),
    };
}

/**
 * The status line's hint before a run (the run's notes), or "": the selection has two or more separate areas, the crop
 * of all of them goes out at less than HINT_SCALE of its size (`unionScale` when the caller knows it, else planned with
 * `limits`), and at least half of the areas would go out at least HINT_GAIN times as large on their own. Only from a
 * current count: a run never waits for one.
 */
export function areaHint(host, editor, limits, unionScale = null) {
    if (editor._eachAreaRun) return "";
    const entry = currentAreas(editor);
    const groups = entry ? areaGroups(host, editor, entry) : null;
    if (!groups || groups.length < 2) return "";
    let scale = unionScale;
    if (scale == null) {
        const f = planFrame(editor, host.nodeParams, limits);
        if (!f) return "";
        scale = scaleOf(f);
    }
    if (!(scale > 0 && scale < HINT_SCALE)) return "";
    const sharper = groups.filter((g) => g.scale >= scale * HINT_GAIN).length;
    if (sharper * 2 < groups.length) return "";
    const pct = Math.max(1, Math.round(scale * 100));
    if (groups.length > AREA_CAP) return `${groups.length} separate areas; the crop goes at ${pct} % of its size; fewer areas at a time give sharper results (Each area runs up to ${AREA_CAP}).`;
    return `${groups.length} separate areas; the crop goes at ${pct} % of its size; generating each area on its own gives sharper results (Each area).`;
}

// ---- the button ----------------------------------------------------------------------------------

const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="7" height="6" rx="1"/><rect x="14" y="4" width="7" height="6" rx="1"/><rect x="8.5" y="14" width="7" height="6" rx="1"/></svg>';

/** "Each area" in the top bar, before Generate; shown only while the selection has two or more areas (syncAreaButton). */
export function buildAreaButton(host, editor) {
    const top = editor.root && editor.root.querySelector(".ipc-top");
    if (!top || top.querySelector(".ipc-eacharea") || !editor.generateBtn) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ipc-ib ipc-eacharea";
    b.hidden = true;
    b.innerHTML = ICON + "<span>Each area</span>";
    b.addEventListener("click", (e) => {
        e.stopPropagation(); e.preventDefault();
        runEachArea(host, editor).catch((err) => editor.setStatus(String((err && err.message) || err), failKind(err)));
    });
    editor.generateBtn.before(b);
    editor.eachAreaBtn = b;
}

/** The button as the count and the recipe say; a count on its way leaves it as it is. */
export function syncAreaButton(host, editor) {
    const b = editor && editor.eachAreaBtn;
    if (!b) return;
    const label = b.querySelector("span");
    const run = editor._eachArea;
    if (run) {
        b.hidden = false;
        b.disabled = true;
        if (label) label.textContent = `Each area ${Math.min(run.n, run.done + 1)}/${run.n}`;
        b.title = `Generating each area separately: area ${Math.min(run.n, run.done + 1)} of ${run.n}. Cancel stops the areas not yet sent.`;
        return;
    }
    b.disabled = false;
    if (!editor.base || !editor.sel) { b.hidden = true; return; }
    const entry = currentAreas(editor);
    if (!entry) return;
    const n = areaCount(host, editor, entry);
    b.hidden = n < 2 || !!recipeRefusal(host.recipe);
    if (label) label.textContent = `Each area · ${n}`;
    b.title = n > AREA_CAP
        ? `The selection has ${n} separate areas; Each area runs at most ${AREA_CAP}.`
        : `Generate each area separately (${n} areas): the same prompt, each area its own crop and its own run, one after another; each result its own layer. Sharper than one crop of all of them when they lie far apart.`;
}

/** A change of the document (host.changed): a selection that changed is counted again after a short wait. */
export function areasSoon(host, editor) {
    if (!editor || !editor.eachAreaBtn || editor._eachAreaSwap) return;
    if (editor._eachArea || currentAreas(editor)) { syncAreaButton(host, editor); return; }
    clearTimeout(editor._areasTimer);
    if (!editor.base || !editor.sel) { syncAreaButton(host, editor); return; }
    editor._areasTimer = setTimeout(() => {
        editor._areasTimer = null;
        if (!host.editors().includes(editor) || editor._eachAreaSwap) return;
        countAreas(editor).then(() => syncAreaButton(host, editor), (err) => console.warn("Scumble: counting the selection's areas failed:", (err && err.message) || err));
    }, COUNT_DELAY);
}

// ---- the run ---------------------------------------------------------------------------------------

/**
 * Generate each area of the selection on its own: the same prompt and references (the click's), each area as its own
 * crop and run, one after another, each result its own layer. Before an API run (`confirm`) the editor's own question
 * names the runs it sends. A Cancel (host.cancelRuns) stops the run going as it always does and the areas not yet sent
 * never go. A recipe on the user's ComfyUI gets every area queued at once; its queue runs them one after another.
 * Refuses (throws) before anything runs; afterwards resolves to `{ areas, done, queued, cancelled, failed, leftOut }`.
 */
export async function runEachArea(host, editor, { confirm = true } = {}) {
    if (!editor.base) throw refusal("Load an image first.");
    const r = host.recipe;
    const no = recipeRefusal(r);
    if (no) throw refusal(no);
    if (editor._eachArea) throw refusal("Each area is already running on this document: wait for it, or Cancel.");
    const api = r.kind === "provider";
    if (editor.providerPending && (api || editor.providerPending.resizes)) throw refusal(RUN_GOING);
    let entry = await countAreas(editor);
    if (!sameKey(entry, keyOf(editor))) entry = await countAreas(editor);
    const groups = areaGroups(host, editor, entry);
    const n = groups ? groups.length : entry.parts.length + entry.more;
    if (!groups || n > AREA_CAP) throw refusal(`The selection has ${n} separate areas; Each area runs at most ${AREA_CAP}: select fewer, or use Generate for all of them in one crop.`);
    if (n < 2) throw refusal(n ? "The selection is one area: use Generate." : "Select the areas first: Each area runs every separate area of the selection on its own.");
    if (api && confirm) {
        const label = r.providerLabel || r.provider;
        const ok = await editor.ask({
            title: "Generate each area separately",
            message: `${n} areas, ${n} runs on ${label} (${r.name || r.id}): each area goes as its own crop with the same prompt, one after another, and ${label} charges each run as one. Cancel stops the areas not yet sent.`,
            ok: `Generate ${n}`,
        });
        if (!ok) { editor.setStatus("Each area: nothing was sent."); return { areas: n, done: 0, queued: 0, cancelled: true, failed: null, leftOut: 0 }; }
        if (!sameKey(entry, keyOf(editor)) || host.recipe !== r) throw refusal("The selection or the recipe changed while the question was open: nothing was sent. Click Each area again.");
    }
    if (editor.providerPending && (api || editor.providerPending.resizes)) throw refusal(RUN_GOING);
    const own = editor.sel;
    const ownBounds = editor.getBounds();
    const snap = editor.refSnapshot();   // the prompt and the references of the click, for every area
    // each area's part of the selection as it is now (on tiles the copies share the selection's tiles)
    const parts = groups.map((g) => own.copyRect(g.reach));
    const leftOut = specksLeftOut(entry, groups);
    const seq = { n, done: 0, cancelled: false, api };
    editor._eachArea = seq;
    syncAreaButton(host, editor);
    let failure = null, failedAt = -1, failedRan = false, stopped = false;
    try {
        for (let i = 0; i < n; i++) {
            if (seq.cancelled || !host.editors().includes(editor)) { stopped = true; break; }
            if (editor.sel !== own) { failure = refusal("The selection was replaced while the areas ran."); failedAt = i; break; }
            const g = groups[i];
            const area = editor.pixels.Mask.empty(editor.width, editor.height);
            if (parts[i]) area.blit(parts[i], g.reach[0], g.reach[1], "copy");
            let restored = false;
            const restore = () => {
                if (restored) return;
                restored = true;
                if (editor.sel === area) {
                    editor.sel = own;
                    editor.markSelectionChanged(ownBounds);
                    // the same selection again: its count holds
                    const c = editor._areas;
                    if (c && c.sel === selIdOf(own)) c.seq = editor.selectionSeq;
                    editor.draw();
                }
                editor._eachAreaSwap = false;
                area.release();
            };
            let out;
            try {
                // the area's selection in place of the user's while the run reads it (restore: once it has)
                editor._eachAreaSwap = true;
                editor.sel = area;
                editor.markSelectionChanged({ within: g.reach });
                editor.draw();
                editor._eachAreaRun = { index: i, n, refs: snap, onSelectionRead: restore };
                out = await editor.generate();
            } finally {
                restore();
                editor._eachAreaRun = null;
            }
            if (out && out.error) { failure = out.error; failedAt = i; failedRan = true; break; }
            seq.done++;
            syncAreaButton(host, editor);
        }
    } finally {
        for (const p of parts) if (p) p.release();
        editor._eachArea = null;
        syncAreaButton(host, editor);
    }
    const cancelled = stopped || (!!failure && isCancel(failure)) || seq.cancelled;
    const done = seq.done;
    // the areas never sent: all after the one that failed, and that one too when it never ran
    const rest = n - done - (failedRan ? 1 : 0);
    const specks = leftOut ? ` ${leftOut} small speck${leftOut === 1 ? "" : "s"} of the selection outside the areas ${leftOut === 1 ? "was" : "were"} left out.` : "";
    if (!host.editors().includes(editor)) return { areas: n, done, queued: api ? 0 : done, cancelled: true, failed: null, leftOut };
    if (cancelled) {
        editor.setStatus(`Each area cancelled: ${done} of ${n} areas ${api ? "generated" : "queued"}; the other ${n - done} ${n - done === 1 ? "was" : "were"} not sent.`, "info");
    } else if (failure) {
        const msg = String(failure.message || failure).replace(/\s+$/, "");
        const after = rest > 0 ? ` ${rest} area${rest === 1 ? " was" : "s were"} not run.` : "";
        editor.setStatus(`Each area stopped at area ${failedAt + 1} of ${n}: ${msg}${/[.!?]$/.test(msg) ? "" : "."}${after}`, failKind(failure));
    } else if (api) {
        editor.setStatus(`Each area: ${n} areas generated, each its own layer (Ctrl+Z takes them back one by one).${specks}`, "info");
    } else {
        editor.setStatus(`Each area: ${n} areas queued on your ComfyUI; they run one after another, each result its own layer.${specks}`, "info");
    }
    return { areas: n, done, queued: api ? 0 : done, cancelled, failed: failure && !isCancel(failure) ? String(failure.message || failure) : null, leftOut };
}
