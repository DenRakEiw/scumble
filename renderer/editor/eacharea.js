// Generate each area separately (CLAUDE.md item 54, issue #9). A selection of several areas apart (people selected by
// text, say) goes as one crop of all of them, scaled down to the model's size, so each area comes back soft. This module
// counts the areas, says before a run when one crop of all of them goes out strongly scaled down (`areaHint`), and runs
// each area as its own Generate, one after another (`runEachArea`): the same prompt, each area its own crop, its own run
// and its own result layer.
//
// The count: the selection's selected pixels on a coarse grid (at most 1024 cells a side), off the window in the pool's
// `area_cells` job on tiles (inpaint_areas.js has the arithmetic), debounced after a selection change; parts smaller than
// a speck are left out, and the parts whose crops would overlap are one area. A run of one area is given that area, the
// selection cut to its reach (its crop and a rim) at the click (`editor.generate({ area })`), and reads it instead of the
// document's selection, which nobody touches: the user goes on selecting, undoing and saving while the areas run.
//
// The app's only (the host calls it; the node's editor never does, its host has none of it).

import { areaCell, speckPixels, countTileCells, countRowCells, labelParts, groupAreas, boxesMeet } from "./inpaint_areas.js";
import { planFrame, planBox } from "./stitch.js";
import { editorPool } from "./inpaint_jobs.js";
import { NORMAL } from "./inpaint_pool.js";
import { storeArgs, stackInArena } from "./inpaint_bands.js";
import { isTilePixels, TILE_SIZE } from "./inpaint_tiles.js";
import { arenaEnabled } from "./inpaint_arena.js";
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
    // the canvas backend: the selection's box read on the window in bands of rows (at most half a megapixel each),
    // counted by the same rule as the tiles, yielding every 8 ms; a selection changed meanwhile makes a count nobody
    // keeps. (A bitmap of the box counted in a pool worker was slower, measured 2026-11-07 at 15000 x 10000: a GPU
    // canvas's bitmap took the worker 6 s to read, the bands here 0.4 s.)
    const counts = new Uint32Array(gw * gh);
    await countRowsHere(sel, b, cell, gw, counts);
    return { ...labelParts(counts, gw, gh, cell, W, H, speck), cell, speck, how: "canvas", window: performance.now() - tw };
}

/** The rows of the box `b` of canvas pixels `sel` counted on the window in bands of up to half a megapixel, yielding every 8 ms. */
async function countRowsHere(sel, b, cell, gw, counts) {
    const bw = b[2] - b[0];
    const rows = Math.max(1, Math.floor((1 << 19) / Math.max(1, bw)));
    let t0 = performance.now();
    for (let y = b[1]; y < b[3]; y += rows) {
        const h = Math.min(rows, b[3] - y);
        const img = sel.readRect(b[0], y, bw, h);
        countRowCells(img.data, bw, h, b[0], y, cell, gw, counts);
        if (performance.now() - t0 > 8) { await new Promise((r) => setTimeout(r, 0)); t0 = performance.now(); }
    }
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

/**
 * The specks of a count that lie outside every area's reach (a run of each area leaves them out): `{ n, atLeast }`,
 * `atLeast` when the count listed fewer speck boxes than it found (the rest may lie inside an area: not counted here).
 */
function specksLeftOut(entry, groups) {
    const n = entry.speckBoxes.filter((b) => !groups.some((g) => boxesMeet(g.reach, b))).length;
    return { n, atLeast: entry.specks > entry.speckBoxes.length };
}

/** The words for specks left out, or "" (`lead` a space before them). */
function speckWords(left) {
    if (!left || !left.n) return "";
    const many = left.n !== 1 || left.atLeast;
    return ` ${left.atLeast ? "At least " : ""}${left.n} small speck${many ? "s" : ""} of the selection outside the areas ${many ? "were" : "was"} left out.`;
}

/**
 * The selection for the `status` command: `{ count, each_area (whether Each area would run them with the selected recipe),
 * cap, specks (all parts smaller than a speck, inside an area's reach or not), areas: [{ x, y, w, h }] (each area's box
 * on the grid) }`. Counts now when the count is not current.
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
 * current count: a run never waits for one. A run of one area of them (Each area) asks none.
 */
export function areaHint(host, editor, limits, unionScale = null) {
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

/**
 * "Each area" in the top bar, before Generate; shown only while the selection has two or more areas (syncAreaButton).
 * While Each area runs it is its Stop: the run going stops as Cancel stops it (an API run; one on the user's ComfyUI
 * finishes there) and the areas not yet sent never go.
 */
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
        if (editor._eachArea) { host.cancelRuns(editor); syncAreaButton(host, editor); return; }
        runEachArea(host, editor).catch((err) => editor.setStatus(String((err && err.message) || err), failKind(err)));
    });
    editor.generateBtn.before(b);
    editor.eachAreaBtn = b;
}

/** The button as the count and the recipe say; a count on its way leaves it as it is (areasSoon counts again). */
export function syncAreaButton(host, editor) {
    const b = editor && editor.eachAreaBtn;
    if (!b) return;
    const label = b.querySelector("span");
    const run = editor._eachArea;
    if (run) {
        const at = Math.min(run.n, run.done + 1);
        b.hidden = false;
        b.disabled = !!run.cancelled;
        if (label) label.textContent = run.cancelled ? `Stopping ${at}/${run.n}` : `Stop · ${at}/${run.n}`;
        b.title = run.api
            ? `Generating each area separately: area ${at} of ${run.n}. Click (or Cancel in the title row) to stop: the run going stops, the areas not yet sent never go.`
            : `Generating each area separately on your ComfyUI: area ${at} of ${run.n}. Click to stop: the area going finishes there, the areas not yet sent never go.`;
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
    if (!editor || !editor.eachAreaBtn) return;
    if (editor._eachArea || currentAreas(editor)) { syncAreaButton(host, editor); return; }
    clearTimeout(editor._areasTimer);
    if (!editor.base || !editor.sel) { syncAreaButton(host, editor); return; }
    editor._areasTimer = setTimeout(() => {
        editor._areasTimer = null;
        if (!host.editors().includes(editor)) return;
        countAreas(editor).then(() => syncAreaButton(host, editor), (err) => console.warn("Scumble: counting the selection's areas failed:", (err && err.message) || err));
    }, COUNT_DELAY);
}

// ---- the run ---------------------------------------------------------------------------------------

/** The exact box ([x0, y0, x1, y1]) of the selected pixels (alpha 128 and more) of `part` lying at `at`, or null. */
function partBounds(part, at) {
    const img = part.readRect(0, 0, part.width, part.height);
    const d = new Int32Array(img.data.buffer, img.data.byteOffset, part.width * part.height);
    const w = part.width, h = part.height;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            if (d[row + x] >= 0) continue;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
        }
    }
    return x1 < 0 ? null : [at[0] + x0, at[1] + y0, at[0] + x1 + 1, at[1] + y1 + 1];
}

/**
 * One area as a run reads it in place of the document's selection (host.runProvider, host.queueGenerate,
 * stitch.js prepareCropAsync, the editor's serializeForPrompt): `window()` the area alone as a selection window,
 * `bounds()` its exact box, `maskCanvas()` the picture's mask with the area alone (the node's state), `crop` the crop a
 * run on the user's ComfyUI makes ([x, y, w, h]); the run sets `sent` once the request went out or the prompt was
 * queued, and `promptId` for a queued one. The document's selection is never read or written for it.
 */
function areaRun(editor, part, g, index, n) {
    const W = editor.width, H = editor.height, at = [g.reach[0], g.reach[1]];
    let exact;
    return {
        index, n, reach: g.reach.slice(), sent: false, promptId: null,
        crop: [g.crop[0], g.crop[1], g.crop[2] - g.crop[0], g.crop[3] - g.crop[1]],
        window: () => ({ img: part.readRect(0, 0, part.width, part.height), ox: at[0], oy: at[1], fullW: W, fullH: H }),
        bounds: () => (exact === undefined ? (exact = partBounds(part, at)) : exact),
        maskCanvas: () => {
            const c = document.createElement("canvas");
            c.width = W; c.height = H;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, W, H);
            const img = part.readRect(0, 0, part.width, part.height);
            const d = img.data;
            const out = new ImageData(part.width, part.height), o = out.data;
            for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; o[i] = a; o[i + 1] = a; o[i + 2] = a; o[i + 3] = 255; }
            ctx.putImageData(out, at[0], at[1]);
            return c;
        },
    };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One area on the user's ComfyUI, after its prompt was queued: "landed" when a result came in, "ended" when its prompt
 * ended without one (an error, an interrupt), "stopped" (a Stop or a Cancel), "closed" (the tab), "time" (the caller's
 * deadline). The prompt's end comes from the server's events (the document's open renders, `_localRuns`) and, as the
 * generate command does, from the queue read every 2 s; a result may land a little after its prompt's end.
 */
async function waitLocal(host, api, editor, area, h0, seq, deadline) {
    const id = area.promptId;
    const status0 = editor.status;
    let gone = 0, readAt = 0;
    for (;;) {
        if (editor.history.length > h0) return "landed";
        if (seq.cancelled) return "stopped";
        if (!host.editors().includes(editor)) return "closed";
        if (deadline && Date.now() > deadline) return "time";
        let open = !!(editor._localRuns && id != null && editor._localRuns.has(id));
        if (open && api && Date.now() - readAt > 2000) {
            readAt = Date.now();
            try {
                const q = await (await api.fetchApi("/queue")).json();
                const ids = [...(q.queue_running || []), ...(q.queue_pending || [])].map((x) => String(x && x[1]));
                if (!ids.includes(String(id))) open = false;
            } catch (_) { /* the events decide */ }
        }
        if (!open) {
            // a failure says so at once (the execution_error listener's line); a result is waited for a little longer
            if (editor.status !== status0 && editor.statusKind === "error") return "ended";
            if (!gone) gone = Date.now();
            else if (Date.now() - gone > 10000) return "ended";
        }
        await wait(200);
    }
}

/**
 * Generate each area of the selection on its own: the same prompt and references (the click's), each area as its own
 * crop and run, one after another, each result its own layer, on the recipe the click confirmed. The document's
 * selection is never changed: each run is given its area (`editor.generate({ area })`), cut from the selection as it was
 * at the click. Before a charged API run (`confirm`) the editor's own question names the runs. A Cancel (host.cancelRuns,
 * the title row, the button, cancel_run) stops the run going as it always does and the areas not yet sent never go; on
 * the user's ComfyUI an area is queued only once the one before landed, so the rest never reach the queue. A failure
 * stops the rest, so does a change of the recipe, and the `deadline` (ms since the epoch, the generate command's
 * timeout): no area starts that the time left would not hold. Refuses (throws) before anything runs; afterwards resolves
 * to `{ areas, done, sent, notSent, running (an area left running on the user's ComfyUI, or null), cancelled, stopped
 * (why: "cancel", "recipe", "time", "closed", "failed" or null), failed, said (a cancel's words for an area that had
 * gone), leftOut, notes }`.
 */
export async function runEachArea(host, editor, { confirm = true, deadline = 0, api = null } = {}) {
    if (!editor.base) throw refusal("Load an image first.");
    const r = host.recipe;
    const no = recipeRefusal(r);
    if (no) throw refusal(no);
    if (editor._eachArea) throw refusal("Each area is already running on this document: wait for it, or stop it.");
    const remote = r.kind === "provider";
    if (editor.providerPending && (remote || editor.providerPending.resizes)) throw refusal(RUN_GOING);
    let entry = await countAreas(editor);
    if (!sameKey(entry, keyOf(editor))) entry = await countAreas(editor);
    const groups = areaGroups(host, editor, entry);
    const n = groups ? groups.length : entry.parts.length + entry.more;
    if (!groups || n > AREA_CAP) throw refusal(`The selection has ${n} separate areas; Each area runs at most ${AREA_CAP}: select fewer, or use Generate for all of them in one crop.`);
    if (n < 2) throw refusal(n ? "The selection is one area: use Generate." : "Select the areas first: Each area runs every separate area of the selection on its own.");
    // what a run would refuse before anything is sent, asked before the question
    const noWords = host.promptRefusal ? host.promptRefusal(r, editor.promptText) : "";
    if (noWords) throw refusal(noWords);
    // an API model charges each run; the in-app models (LaMa) are free and run offline
    const charged = remote && r.provider !== "inapp";
    const label = r.providerLabel || r.provider;
    if (charged && confirm) {
        const ok = await editor.ask({
            title: "Generate each area separately",
            message: `${n} areas, ${n} runs on ${label} (${r.name || r.id}): each area goes as its own crop with the same prompt, one after another, and ${label} charges each run as one. Cancel stops the areas not yet sent.`,
            ok: `Generate ${n}`,
        });
        if (!ok) { editor.setStatus("Each area: nothing was sent."); return { areas: n, done: 0, sent: 0, notSent: n, running: null, cancelled: true, stopped: "cancel", failed: null, said: null, leftOut: 0, notes: [] }; }
        if (!sameKey(entry, keyOf(editor)) || host.recipe !== r) throw refusal("The selection or the recipe changed while the question was open: nothing was sent. Click Each area again.");
    }
    if (editor.providerPending && (remote || editor.providerPending.resizes)) throw refusal(RUN_GOING);
    const snap = editor.refSnapshot();   // the prompt and the references of the click, for every area
    // each area's part of the selection as it is now (on tiles the copies share the selection's tiles); the document's
    // own selection is left as it is, for the user to go on with
    const own = editor.sel;
    const parts = groups.map((g) => own.copyRect(g.reach));
    const left = specksLeftOut(entry, groups);
    const seq = { n, done: 0, cancelled: false, api: remote };
    editor._eachArea = seq;
    syncAreaButton(host, editor);
    const notes = [];
    const keep = (list) => { for (const x of list || []) { const s = String(x || ""); if (s && !notes.includes(s)) notes.push(s); } };
    let failure = null, failedAt = -1, failedSent = false, stopped = null, running = null, longest = 0;
    try {
        for (let i = 0; i < n; i++) {
            if (seq.cancelled) { stopped = "cancel"; break; }
            if (!host.editors().includes(editor)) { stopped = "closed"; break; }
            if (host.recipe !== r) { stopped = "recipe"; break; }
            // no area starts that the time left would not hold (the longest area so far as the guess)
            if (deadline && Date.now() + longest > deadline) { stopped = "time"; break; }
            const area = areaRun(editor, parts[i], groups[i], i, n);
            const t0 = Date.now(), h0 = editor.history.length;
            const out = await editor.generate({ refs: snap, area });
            if (out && out.error) { failure = out.error; failedAt = i; failedSent = area.sent; stopped = isCancel(failure) || seq.cancelled ? "cancel" : "failed"; break; }
            if (!remote) {
                // one area at a time on the user's ComfyUI: the next is queued once this one's result is in
                if (!area.sent) { failure = new Error("its prompt was not queued"); failedAt = i; stopped = "failed"; break; }
                const got = await waitLocal(host, api, editor, area, h0, seq, deadline);
                if (got === "stopped" || got === "closed" || got === "time") { running = i; stopped = got === "stopped" ? "cancel" : got; break; }
                if (got === "ended") {
                    const said = editor.statusKind === "error" && editor.status ? editor.status : "its prompt ended on your ComfyUI without a result";
                    failure = new Error(said); failedAt = i; failedSent = true; stopped = "failed"; break;
                }
            }
            seq.done++;
            keep(editor.lastRunNotes);
            longest = Math.max(longest, Date.now() - t0);
            syncAreaButton(host, editor);
        }
    } finally {
        for (const p of parts) if (p) p.release();
        editor._eachArea = null;
        // a selection changed during the run is counted again; the button leaves its run's label
        syncAreaButton(host, editor);
        areasSoon(host, editor);
    }
    const done = seq.done;
    const inFlight = failedSent ? 1 : 0;
    const sent = done + inFlight + (running != null ? 1 : 0);
    const notSent = n - sent;
    const result = { areas: n, done, sent, notSent, running: running != null ? running + 1 : null, cancelled: stopped === "cancel", stopped, failed: null, said: null, leftOut: left.n, notes };
    if (!host.editors().includes(editor)) return result;
    const generated = remote ? "generated" : "landed";
    const notSentWords = notSent ? `; ${notSent === n - done ? "the other " : ""}${notSent} ${notSent === 1 ? "was" : "were"} not sent` : "";
    const runningWords = running != null ? `; area ${running + 1} is still running on your ComfyUI and lands when it is done` : "";
    let line, kind = "info";
    if (stopped === "cancel") {
        // the area that had gone when the stop came may be charged: main's words say how it ended
        const said = failure && inFlight ? String(failure.message || failure).replace(/\s+$/, "") : "";
        if (said) result.said = said;
        line = `Each area cancelled: ${done} of ${n} areas ${generated}${said ? `; area ${failedAt + 1} was cancelled after it was sent (${said.replace(/[.!?]$/, "")})` : ""}${runningWords}${notSentWords}.`;
    } else if (stopped === "recipe") {
        line = `Each area stopped: the recipe changed while the areas ran; ${done} of ${n} areas ${generated}${notSentWords}.`;
    } else if (stopped === "time") {
        line = `Each area stopped: the command's time ran out; ${done} of ${n} areas ${generated}${runningWords}${notSentWords}.`;
    } else if (stopped === "closed") {
        return result;
    } else if (failure) {
        const msg = String(failure.message || failure).replace(/\s+$/, "");
        result.failed = msg;
        kind = failKind(failure);
        const end = /[.!?]$/.test(msg) ? "" : ".";
        line = failedSent
            ? `Each area stopped at area ${failedAt + 1} of ${n}: ${msg}${end} ${done} of ${n} areas ${generated}${notSent ? `, ${notSent} not sent` : ""}.`
            : `Each area stopped before area ${failedAt + 1} of ${n} was sent: ${msg}${end} ${done} of ${n} areas ${generated}, ${notSent} not sent.`;
    } else {
        line = `Each area: ${n} areas generated${remote ? "" : " on your ComfyUI"}, each its own layer.${speckWords(left)}`;
    }
    // the areas' own notes (a reference not sent, boxes left out, the LoRAs), once each; red when one says something was left out
    if (notes.length) {
        line += ` ${notes.join(" ")}`;
        if (kind === "info" && host.runNotesKind && host.runNotesKind(editor, notes) === "warn") kind = "warn";
    }
    editor.setStatus(line, kind);
    return result;
}
