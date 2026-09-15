/**
 * The tile store: the second backend of `LayerPixels` / `MaskPixels` (docs/PLAN_BCE.md §C2,
 * "C2 as built"). The same methods, argument forms and results as the canvas backend in
 * inpaint_pixels.js, over 256 × 256 tiles of straight-alpha RGBA8 in renderer memory instead of
 * one canvas. `pixelsBackend(tiles)` hands out the classes of either backend.
 *
 * What a caller has to know beyond the rules at the top of inpaint_pixels.js:
 * - Sparse: a missing tile reads as transparent, a write allocates what it touches, and a tile
 *   whose alpha is all zero after a write is dropped. `bytes()` counts allocated tiles.
 * - `clone()` shares every tile (copy on write): a tile is copied by the first write into it
 *   from any holder but the last one (`writable`), once per writer.
 * - Every write that is not a plain byte copy (drawInto, writeRect with an operation or an
 *   alpha, blit, fill with a non-string style) goes through a scratch of the rectangle: an
 *   OffscreenCanvas with a `willReadFrequently` context, which Chromium rasterises on the CPU and
 *   keeps there (a `willReadFrequently` <canvas> is moved to the GPU for good once a GPU canvas
 *   is drawn into it; measured in C2). Every canvas this module makes itself (a writeRect source,
 *   a blit source, `toCanvas`, the display mirror) is a CPU canvas too, whatever
 *   `setPixelsOptions` says. The canvas backend's canvases are rasterised on the GPU unless
 *   `setPixelsOptions({ software: true })`, and anti-aliased edges, gradients and resampling then
 *   differ (tens of levels, and any amount of un-premultiplied colour where alpha is near zero).
 *   On the CPU both backends agree to the byte, except where Skia does not rasterise exactly
 *   translation-invariantly (the scratch's origin is the rect's origin): gradients, resampled
 *   images, and the anti-aliased edges of curves and strokes, by up to tens of alpha levels
 *   (docs/PLAN_BCE.md §C2 "C2 as built"). The scratch clips without anti-aliasing: a drawInto
 *   callback clips to whole pixels only (the rules at the top of inpaint_pixels.js).
 * - Side limits: a scratch, a materialised canvas or the mirror above 65,535 px a side or 268 MP
 *   is refused with an Error (Chromium makes such a canvas without complaint and draws nothing).
 * - Bytes that enter without a canvas (writeRect "copy", fromImageData) go through the round
 *   trip a canvas applies to straight alpha (premultiply, un-premultiply), measured once from a
 *   canvas, so a read gives back what the canvas backend gives back.
 * - `canvasOf()` is a display mirror, one CPU canvas per pixels object synced from the tiles written
 *   since the last call, until C3 draws tiles (the editor's screen draws a GPU copy of it);
 *   `thumbnailCanvas()` is a small one for thumbnails that never makes the mirror.
 * - No module-level side effects: nothing touches the page until pixels are made.
 */

import { LayerPixels, MaskPixels, pixelRect, WHOLE_CANVAS_OPS, BLIT_MARGIN, reentrantPixels } from "./inpaint_pixels.js";
import { mipChain, mipChainBytes, clampExtend } from "./px/kernels_js.js";

export const TILE_SIZE = 256;
const TILE_BYTES = TILE_SIZE * TILE_SIZE * 4;
/** 65,536 tiles a side: the key is (ty << 16) | tx. */
export const TILE_MAX_SIDE = 16777216;
/** Chromium's canvas area limit: a scratch or a materialised canvas above it cannot exist. */
export const CANVAS_MAX_PIXELS = 268435456;
/** Chromium's canvas side limit: a canvas of 65,536 px a side exists but draws and reads nothing (measured). */
export const CANVAS_MAX_SIDE = 65535;
/** Region canvases kept per pixels object: the screen's level and the navigator's. */
const REGION_LEVELS = 2;
/** The key of the one region canvas kept besides them, for reads that are not for the screen (C6 c1 review). */
const SAMPLE_REGION = "sample";
/** Mips per tile: 128, 64, 32, 16, 8 px. */
export const MIP_LEVELS = 5;
/** The gutter a tile carries in an atlas slot, on every side (docs/PLAN_BCE.md §C3). */
export const GUTTER = 1;
/** The side of a tile at `level`, and of its slot in an atlas page. */
export const levelSide = (level) => TILE_SIZE >> level;
export const slotSide = (level) => (TILE_SIZE >> level) + 2 * GUTTER;
const STRIP_W = 4096;              // fromImage / fromCanvas: strips 4096 wide ...
// ... and 4096 rows high for fromImage (fromCanvas reads 256 rows at a time): an image of at most 4096 px
// a side is one untranslated draw, byte for byte the canvas backend's; in 256-row strips a scaled image
// came out a few bytes apart (docs/PLAN_BCE.md §C2 "C2 as built")
const DECODE_ROWS = 4096;
const BLOCK = 4096;                // a big scratch is read back in blocks of this side
const DISPLAY_RECT_MAX_PX = 4 * 1024 * 1024;   // displayRectSource: above this the mirror is the source
const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const ALPHA = 0x1000000;           // a word >= this has a non-zero alpha byte (little-endian)

let tileSeq = 0;                   // tile versions are unique across all tiles
// Pixels versions are unique across all pixels objects (docs/PLAN_BCE.md §C6 a). A cache that keys on
// `version` then cannot mistake one object for another: a new mask started at 0 and was 1 after its first
// touch, exactly what the mask it replaced had, and the atlas's instances and the region view kept
// drawing the old mask.
let pixelSeq = 0;

function newTile() {
    return {
        data: new Uint8ClampedArray(TILE_BYTES),   // its own ArrayBuffer: starts on a page (§B3, 4K aliasing)
        version: ++tileSeq,
        // the mip chain (plainChain): exact while mipsVersion is the version; otherwise, when there is one, the
        // picture the tile had, shown while the exact one is built in the worker (C6 b). `mipsOwn`: the buffer is
        // this tile's alone and a rebuild may write into it; a copy-on-write copy reads the original's (never writes)
        mips: null, mipsVersion: -1, mipsOwn: false, mipsSeq: 0,
        wantV: -1, wantW: 0, wantH: 0, wantEntry: null,   // the mips job asked for this tile at this version and valid part
        ext: null, extVersion: -1,
        // the clamp-extended copy of an edge tile (edgeCopy), and in `edge.mips` its chain (edgeChain)
        edge: null, edgeVersion: -1, edgeW: 0, edgeH: 0,
        frozen: 0,                                 // how many other pixels objects hold this tile
        _img: null, _u32: null,
    };
}

// ---- mip chains, on the main thread or in the worker (docs/PLAN_BCE.md §C6 b) -------------------------

const CHAIN_BYTES = mipChainBytes(TILE_SIZE, MIP_LEVELS);
let chainSeq = 0;                  // a stamp per chain content: a slot or a cell made from a stale chain knows which
let chainEpochSeq = 0;             // a pixels object's chainEpoch: moved when a chain from the worker lands in it
/**
 * How many chains were built where (tests, perf_test.py): `main` on this thread and kept, `landed` from the worker,
 * `handed` of those given to a thumbnail and not kept, `thumb` a thumbnail's levels built into a scratch.
 */
const CHAIN_STATS = { main: 0, landed: 0, handed: 0, dropped: 0, requested: 0, batches: 0, coarse: 0, thumb: 0 };
let THUMB_MIPS = null;             // thumbnailCanvas: the levels of a tile that keeps no chain of its own
const thumbScratch = () => THUMB_MIPS || (THUMB_MIPS = new Uint8Array(mipChainBytes(TILE_SIZE, MIP_LEVELS)));

/** The chain of a tile's own bytes, built here when it is not exact, and kept on the tile. */
function plainChain(t) {
    if (t.mipsVersion === t.version && t.mips) return t.mips;
    // never into a buffer another tile still reads (a copy-on-write copy's inherited picture)
    const out = t.mipsOwn && t.mips ? t.mips : new Uint8Array(CHAIN_BYTES);
    t.mips = mipChain(t.data, TILE_SIZE, MIP_LEVELS, out);
    t.mipsVersion = t.version;
    t.mipsOwn = true;
    t.mipsSeq = ++chainSeq;
    CHAIN_STATS.main++;
    return t.mips;
}

const newEdge = () => ({ data: null, mips: null, mipsVersion: -1, mipsW: 0, mipsH: 0, mipsOwn: false, mipsSeq: 0 });

/** Is the edge chain of `t` the exact one for its version and a valid part of vw x vh? */
const edgeExact = (t, vw, vh) => !!(t.edge && t.edge.mips && t.edge.mipsVersion === t.version && t.edge.mipsW === vw && t.edge.mipsH === vh);

/** The chain of an edge tile's clamp-extended bytes, built here when it is not exact, and kept on the tile. */
function edgeChain(t, vw, vh) {
    if (edgeExact(t, vw, vh)) return t.edge.mips;
    const e = edgeCopy(t, vw, vh);
    const out = e.mipsOwn && e.mips ? e.mips : new Uint8Array(CHAIN_BYTES);
    e.mips = mipChain(e.data, TILE_SIZE, MIP_LEVELS, out);
    e.mipsVersion = t.version; e.mipsW = vw; e.mipsH = vh;
    e.mipsOwn = true;
    e.mipsSeq = ++chainSeq;
    CHAIN_STATS.main++;
    return e.mips;
}

/**
 * A tile at `level` sampled nearest from its own bytes, one pixel at the centre of each cell (clamped to the
 * valid part vw x vh when `clamp`, as the edge chain is): the picture a tile that has no chain at all shows
 * while its exact one is built in the worker (C6 b). Never kept on the tile.
 */
function coarseLevel(t, level, vw, vh, clamp, out) {
    const side = TILE_SIZE >> level, f = 1 << level, half = f >> 1;
    const n = side * side * 4;
    if (!out || out.length < n) out = new Uint8Array(n);
    CHAIN_STATS.coarse++;
    const s = t.data;
    const s32 = LITTLE ? u32Of(t) : null, o32 = s32 ? (out === COARSE[level] ? COARSE32[level] : words(out)) : null;
    for (let y = 0; y < side; y++) {
        let sy = y * f + half;
        if (clamp && sy >= vh) sy = vh - 1;
        const row = sy * TILE_SIZE;
        for (let x = 0; x < side; x++) {
            let sx = x * f + half;
            if (clamp && sx >= vw) sx = vw - 1;
            if (o32) { o32[y * side + x] = s32[row + sx]; continue; }
            const i = (row + sx) * 4, o = (y * side + x) * 4;
            out[o] = s[i]; out[o + 1] = s[i + 1]; out[o + 2] = s[i + 2]; out[o + 3] = s[i + 3];
        }
    }
    return out;
}

/** The bytes of a `_levelBytes` answer: its chain, or for a coarse one the level sampled into a scratch of the level. */
const coarseBytes = (lv) => (lv.coarse ? { data: coarseLevel(lv.t, lv.level, lv.vw, lv.vh, true, coarseBuf(lv.level)), off: 0 } : lv);

const COARSE = [], COARSE32 = [];  // per level: a scratch for a coarse cell (and its words), copied out at once by its caller
const coarseBuf = (level) => {
    if (!COARSE[level]) { COARSE[level] = new Uint8Array((TILE_SIZE >> level) * (TILE_SIZE >> level) * 4); COARSE32[level] = new Uint32Array(COARSE[level].buffer); }
    return COARSE[level];
};

/**
 * Chains asked for per batch (a batch of 128 is about 16 ms of worker time and 5 ms of copies here), and the batches in
 * flight at once. The first batches are smaller: each tile's bytes are copied into a buffer of its own, and a buffer
 * that is new costs more than one the worker gave back (256 new ones were 9 ms of the frame after a flip at 15k).
 */
const CHAIN_BATCH = 128;
const CHAIN_BATCH_NEW = 32;
const CHAIN_FLIGHTS = 1;
/**
 * Chains the display may still build on this thread in one task before it asks the worker instead: a brush
 * commit, a fill or an undo touches a handful of tiles and stays exact in the frame it draws, while a whole
 * change of a large document (2,360 tiles at 15000 x 10000, about 120 µs each) goes to the worker.
 */
export const CHAIN_SYNC_BUDGET = 16;

/**
 * Where the chains a display reader asks for are built (C6 b). Without a transport everything is built on the
 * main thread when it is read, exactly as before; with one (the editor's mips worker) a display reader that finds
 * no exact chain, once the task's budget is spent, asks for it and draws what the tile had meanwhile. Only
 * display readers (`display` true) ever see such a picture: `mips()`, `tileWithGutter()` and `regionCanvas()`
 * without it stay exact.
 *
 * `transport(tiles)` takes [{ data: ArrayBuffer, vw, vh }] (the buffers transferred) and resolves to
 * { chains: [ArrayBuffer], exts: [ArrayBuffer | null], datas: [ArrayBuffer] }.
 */
export class ChainScheduler {
    constructor(transport = null, { budget = CHAIN_SYNC_BUDGET, batch = CHAIN_BATCH, flights = CHAIN_FLIGHTS } = {}) {
        this.transport = transport;
        this.budgetMax = budget;
        this.budget = budget;
        this.batch = batch;
        this.flights = flights;
        this.queue = new Map();        // tile -> entry
        this.flight = 0;
        this.pool = [];                // tile buffers back from the worker, for the next batch's copies
        this._refill = false;
        this._flushQueued = false;
        this._landing = [];            // resolvers of chainLanding()
        this._settled = [];            // resolvers of chainsSettled()
        this.failure = null;
    }

    get async() { return !!this.transport; }

    get pending() { return this.queue.size + this.flight; }

    /** May the display build this chain here and now? Never for a tile whose chain is already asked for. */
    mayBuild(t, vw, vh) {
        if (!this.transport) return true;
        if (t.wantV === t.version && t.wantW === vw && t.wantH === vh) return false;
        if (this.budget <= 0) return false;
        this.budget--;
        if (!this._refill) { this._refill = true; queueMicrotask(() => { this._refill = false; this.budget = this.budgetMax; }); }
        return true;
    }

    /**
     * Ask for the chains of `t` (at its version, with the edge chain for a valid part of vw x vh) for `store` at `key`.
     * `screen`: a reader of the screen asks (the atlas, a region canvas), and the chain is kept on the tile. A
     * thumbnail's ask alone (false) keeps nothing on a tile that has no chain buffer of its own: the chain is handed to
     * the thumbnail's cell and dropped, because a hidden layer, or one only ever seen at 1:1, kept a chain on every
     * tile for a picture of 40 px (196 MB a layer at 15000 x 10000: the C6 b review).
     *
     * An entry asked for again while it waits goes to the end of the queue, and the queue is flushed newest first: the
     * tiles the screen still shows go before the ones of pixels a later whole change replaced, which nothing asks
     * for any more (a flip after a flip waited for the first flip's chains: the C6 b review).
     */
    request(store, key, t, vw, vh, screen = true) {
        if (t.wantV === t.version && t.wantW === vw && t.wantH === vh && t.wantEntry) {
            // queued or in flight: its landing tells every store that asked (the first one inline, a rare second in `more`)
            const f = t.wantEntry;
            if (screen) f.keep = true;
            if (this.queue.get(t) === f) { this.queue.delete(t); this.queue.set(t, f); }
            if (f.store === store && f.key === key) { if (screen) f.screen = true; return; }
            if (!f.more) f.more = [];
            for (let i = 0; i < f.more.length; i += 3) if (f.more[i] === store && f.more[i + 1] === key) { if (screen) f.more[i + 2] = true; return; }
            f.more.push(store, key, screen);
            return;
        }
        const e = { t, version: t.version, vw, vh, store, key, screen, keep: screen, more: null };
        t.wantV = t.version; t.wantW = vw; t.wantH = vh;
        t.wantEntry = e;
        this.queue.set(t, e);
        CHAIN_STATS.requested++;
        if (!this._flushQueued) { this._flushQueued = true; queueMicrotask(() => { this._flushQueued = false; this._flush(); }); }
    }

    /** `t`'s chain is still wanted where it is shown (a region canvas's stale cell): its entry goes to the end of the queue. */
    touch(t) {
        const e = t.wantEntry;
        if (e && this.queue.get(t) === e) { this.queue.delete(t); this.queue.set(t, e); }
    }

    _flush() {
        while (this.transport && this.flight < this.flights && this.queue.size) {
            const batch = [];
            const size = Math.min(this.batch, this.pool.length + CHAIN_BATCH_NEW);
            // newest first (see `request`): the Map keeps the order entries were last asked for in
            const entries = Array.from(this.queue.values());
            for (let j = entries.length - 1; j >= 0; j--) {
                const e = entries[j], t = e.t;
                this.queue.delete(t);
                // written since it was asked for: the write's reader asks again for the new version
                if (t.version !== e.version) { if (t.wantEntry === e) { t.wantV = -1; t.wantEntry = null; } CHAIN_STATS.dropped++; this._notify(e, false); continue; }
                batch.push(e);
                if (batch.length >= size) break;
            }
            if (!batch.length) break;
            const tiles = batch.map((e) => {
                const buf = this.pool.pop() || new ArrayBuffer(TILE_BYTES);
                new Uint8Array(buf).set(e.t.data);
                return { data: buf, vw: e.vw, vh: e.vh };
            });
            this.flight++;
            CHAIN_STATS.batches++;
            let sent;
            try { sent = Promise.resolve(this.transport(tiles)); } catch (err) { sent = Promise.reject(err); }
            sent.then((reply) => this._land(batch, reply), (err) => this._fail(batch, err));
        }
        this._maybeSettled();
    }

    _land(batch, reply) {
        this.flight--;
        const landed = landedSet();
        const chains = (reply && reply.chains) || [], exts = (reply && reply.exts) || [];
        for (const d of (reply && reply.datas) || []) if (d && d.byteLength === TILE_BYTES && this.pool.length < this.batch) this.pool.push(d);
        batch.forEach((e, i) => {
            const t = e.t;
            if (t.wantEntry === e) { t.wantV = -1; t.wantEntry = null; }
            // installed only on the tile it was made from, at the version it was made from: a later write gave the
            // tile a new version (or the store a new tile object), and this answer is of pixels that are gone
            if (t.version !== e.version || !chains[i]) { CHAIN_STATS.dropped++; this._notify(e, false, landed); return; }
            // kept when a reader of the screen asked, or in place of a chain buffer the tile owns; a thumbnail's ask
            // alone hands the chain to its cell (see `request`)
            let handed = null;
            if (t.mipsVersion !== t.version) {
                if (e.keep || (t.mipsOwn && t.mips)) {
                    t.mips = new Uint8Array(chains[i]);
                    t.mipsVersion = t.version;
                    t.mipsOwn = true;
                    t.mipsSeq = ++chainSeq;
                } else {
                    handed = new Uint8Array(chains[i]);
                    CHAIN_STATS.handed++;
                }
            }
            if (exts[i] && (e.vw < TILE_SIZE || e.vh < TILE_SIZE) && !edgeExact(t, e.vw, e.vh) && (e.keep || (t.edge && t.edge.mipsOwn && t.edge.mips))) {
                const g = t.edge || (t.edge = newEdge());
                g.mips = new Uint8Array(exts[i]);
                g.mipsVersion = t.version; g.mipsW = e.vw; g.mipsH = e.vh;
                g.mipsOwn = true;
                g.mipsSeq = ++chainSeq;
            }
            CHAIN_STATS.landed++;
            this._notify(e, true, landed, handed);
        });
        const waiters = this._landing.splice(0);
        for (const w of waiters) w(landed);
        this._flush();
    }

    /**
     * Tell the stores that asked for `e` that its tile's picture may be refreshed; `landed` collects them, and in
     * `landed.screen` the ones a reader of the screen asked for. `handed`: the chain, not kept on the tile, for a thumbnail.
     */
    _notify(e, ok, landed = null, handed = null) {
        const one = (store, key, screen) => {
            if (store._tiles.get(key) !== e.t) return;
            store._chainLanded(key, screen, handed, e.version);
            if (landed) { landed.add(store); if (screen) landed.screen.add(store); }
        };
        one(e.store, e.key, e.screen);
        if (e.more) for (let i = 0; i < e.more.length; i += 3) one(e.more[i], e.more[i + 1], e.more[i + 2]);
    }

    /** The tile buffers kept for the next batch's copies (32 MB at most) go, when no chain is on its way (releaseCaches). */
    releasePool() {
        if (this.pending) return 0;
        const bytes = this.pool.length * TILE_BYTES;
        this.pool.length = 0;
        return bytes;
    }

    _fail(batch, err) {
        this.flight--;
        // the worker is gone or refused: from now on every chain is built where it is read, as without a worker
        if (this.transport) console.warn("Inpaint Canvas: the mips worker failed, building mips on the main thread:", (err && err.message) || err);
        this.transport = null;
        this.failure = err;
        const landed = landedSet();
        const all = batch.concat(Array.from(this.queue.values()));
        this.queue.clear();
        for (const e of all) {
            if (e.t.wantEntry === e) { e.t.wantV = -1; e.t.wantEntry = null; }
            this._notify(e, false, landed);
        }
        const waiters = this._landing.splice(0);
        for (const w of waiters) w(landed);
        this._maybeSettled();
    }

    _maybeSettled() {
        if (this.pending) return;
        const waiters = this._settled.splice(0);
        for (const w of waiters) w();
    }

    /**
     * Resolves with the stores that got chains at the next landing (at once, with none, when nothing is pending), and
     * in its `screen` set the ones a reader of the screen had asked for.
     */
    landing() {
        if (!this.pending) return Promise.resolve(landedSet());
        return new Promise((resolve) => this._landing.push(resolve));
    }

    /** Resolves when no chain is asked for or in flight. */
    settled() {
        if (!this.pending && !this._flushQueued) return Promise.resolve();
        return new Promise((resolve) => this._settled.push(resolve));
    }
}

/** The stores a landing reached, with `screen`: the ones among them a reader of the screen had asked for. */
function landedSet() {
    const s = new Set();
    s.screen = new Set();
    return s;
}

const CHAINS = new ChainScheduler();

/** The transport of the default scheduler (the editor gives it its mips worker); null builds everything here. */
export function setChainTransport(transport) {
    CHAINS.transport = transport || null;
    CHAINS.failure = null;
}

/** The default scheduler, which every tile store uses unless it was given another (`pixels._chains`). */
export function chainScheduler() { return CHAINS; }

/** The counters of chains built here and in the worker (tests, perf_test.py); `reset` zeroes them. */
export function chainStats(reset = false) {
    const out = { ...CHAIN_STATS, pending: CHAINS.pending, async: CHAINS.async };
    if (reset) for (const k of Object.keys(CHAIN_STATS)) CHAIN_STATS[k] = 0;
    return out;
}

const u32Of = (t) => t._u32 || (t._u32 = new Uint32Array(t.data.buffer));
const imageDataOf = (t) => t._img || (t._img = new ImageData(t.data, TILE_SIZE, TILE_SIZE));
let ZERO_IMAGE = null;
const zeroImage = () => ZERO_IMAGE || (ZERO_IMAGE = new ImageData(TILE_SIZE, TILE_SIZE));

const LONG_MIN = -2147483648, LONG_MAX = 2147483647;

/**
 * An argument of getImageData / putImageData as Chromium converts it: a WebIDL `[EnforceRange] long`
 * (a TypeError for NaN, an infinity or a value outside the 32-bit range; fractions truncated).
 */
function enforceLong(v) {
    if (typeof v === "bigint") throw new TypeError("Value is not of type 'long'.");
    const n = Number(v);
    if (Number.isNaN(n)) throw new TypeError("Value is not of type 'long'.");
    if (!Number.isFinite(n)) throw new TypeError("Value is infinite and not of type 'long'.");
    const t = Math.trunc(n);
    if (t < LONG_MIN || t > LONG_MAX) throw new TypeError("Value is outside the 'long' value range.");
    return t + 0;   // no -0
}

const outOfMemory = () => new RangeError("Out of memory at ImageData creation");

/** A canvas of w x h must be possible: Chromium's side and area limits, as a named Error. */
function checkCanvas(w, h, what, beyond = "") {
    if (w > CANVAS_MAX_SIDE || h > CANVAS_MAX_SIDE) {
        throw new Error(`Inpaint Canvas: ${what} of ${w} × ${h} px is above Chromium's canvas limit of 65,535 px a side${beyond}`);
    }
    if (w * h > CANVAS_MAX_PIXELS) {
        throw new Error(`Inpaint Canvas: ${what} of ${w} × ${h} px is above Chromium's canvas limit of 268 MP${beyond}`);
    }
}

/**
 * A <canvas> the module fills itself (putImageData only) and hands on as a source or a view: a
 * `willReadFrequently` context, so it is rasterised on the CPU whatever `setPixelsOptions` says.
 * Nothing is ever drawn into it, which is what would move it to the GPU.
 */
function cpuCanvas(w, h, what = "a canvas", beyond = "") {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    checkCanvas(w, h, what, beyond);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d", { willReadFrequently: true });
    return c;
}

function words(bytes) {
    return LITTLE && bytes.byteOffset % 4 === 0 ? new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2) : null;
}

// ---- the straight-alpha round trip of a canvas ---------------------------------------------------

let ROUND_TRIP = null;

/**
 * T[(a << 8) | c]: the channel value a canvas gives back for straight (c, a) put into it. Measured
 * from a CPU canvas (a GPU canvas's first read un-premultiplies 450 of the 65,536 pairs one level
 * differently; its later reads agree with this table).
 */
function roundTripTable() {
    if (ROUND_TRIP) return ROUND_TRIP;
    const c = document.createElement("canvas");
    c.width = 256; c.height = 256;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const img = new ImageData(256, 256);
    for (let a = 0; a < 256; a++) {
        for (let v = 0; v < 256; v++) {
            const i = (a * 256 + v) * 4;
            img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = a;
        }
    }
    ctx.putImageData(img, 0, 0);
    const d = ctx.getImageData(0, 0, 256, 256).data;
    const t = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) t[i] = d[i * 4];
    c.width = 1; c.height = 1;
    ROUND_TRIP = t;
    return t;
}

/** The round trip applied to a block of a tile in place (w x h at lx, ly). */
function normalizeBlock(d, lx, ly, w, h) {
    const t = roundTripTable();
    for (let y = 0; y < h; y++) {
        for (let i = ((ly + y) * TILE_SIZE + lx) * 4, e = i + w * 4; i < e; i += 4) {
            const a = d[i + 3];
            if (a === 255) continue;
            const o = a << 8;
            d[i] = t[o | d[i]]; d[i + 1] = t[o | d[i + 1]]; d[i + 2] = t[o | d[i + 2]];
        }
    }
}

const COLORS = new Map();

/** A CSS colour as a fill of cleared pixels reads back: [r, g, b, a]. */
function probeColor(color) {
    let rgba = COLORS.get(color);
    if (rgba) return rgba;
    const c = document.createElement("canvas");
    c.width = 1; c.height = 1;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    rgba = Array.from(ctx.getImageData(0, 0, 1, 1).data);
    if (COLORS.size > 64) COLORS.clear();
    COLORS.set(color, rgba);
    return rgba;
}

// ---- block helpers -------------------------------------------------------------------------------

/** Is the alpha of the w x h block at (sx, sy) of an RGBA buffer `srcW` wide all zero? */
function blockAlphaZero(src, s32, srcW, sx, sy, w, h) {
    if (s32) {
        for (let y = 0; y < h; y++) {
            for (let i = (sy + y) * srcW + sx, e = i + w; i < e; i++) if (s32[i] >= ALPHA) return false;
        }
        return true;
    }
    for (let y = 0; y < h; y++) {
        for (let i = ((sy + y) * srcW + sx) * 4 + 3, e = i + w * 4; i < e; i += 4) if (src[i]) return false;
    }
    return true;
}

/** Does the block of a tile at (lx, ly) hold the same bytes as the block of `src` at (sx, sy)? */
function blockEqual(t, src, s32, srcW, sx, sy, lx, ly, w, h) {
    const d = t.data;
    if (s32 && LITTLE) {
        const t32 = u32Of(t);
        for (let y = 0; y < h; y++) {
            let j = (ly + y) * TILE_SIZE + lx;
            for (let i = (sy + y) * srcW + sx, e = i + w; i < e; i++, j++) if (s32[i] !== t32[j]) return false;
        }
        return true;
    }
    for (let y = 0; y < h; y++) {
        let j = ((ly + y) * TILE_SIZE + lx) * 4;
        for (let i = ((sy + y) * srcW + sx) * 4, e = i + w * 4; i < e; i++, j++) if (src[i] !== d[j]) return false;
    }
    return true;
}

function tileEmpty(t) {
    if (LITTLE) {
        const a = u32Of(t);
        for (let i = 0; i < a.length; i++) if (a[i] >= ALPHA) return false;
        return true;
    }
    const d = t.data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
    return true;
}

/** The exact non-transparent extent of a tile in its own pixels, cached by its version. */
function tileExtent(t) {
    if (t.extVersion === t.version) return t.ext;
    const d = t.data;
    const alphaAt = LITTLE ? ((a) => (i) => a[i] >= ALPHA)(u32Of(t)) : (i) => d[i * 4 + 3] !== 0;
    let x0 = TILE_SIZE, y0 = -1, x1 = -1, y1 = -1;
    for (let y = 0; y < TILE_SIZE; y++) {
        const row = y * TILE_SIZE;
        let first = -1;
        for (let x = 0; x < TILE_SIZE; x++) if (alphaAt(row + x)) { first = x; break; }
        if (first < 0) continue;
        if (y0 < 0) y0 = y;
        y1 = y;
        if (first < x0) x0 = first;
        for (let x = TILE_SIZE - 1; x > x1; x--) if (alphaAt(row + x)) { x1 = x; break; }
    }
    t.ext = y0 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
    t.extVersion = t.version;
    return t.ext;
}

// ---- the atlas's tiles (docs/PLAN_BCE.md §C3) -----------------------------------------------------

let PREMUL = null;

/** P[(a << 8) | c]: the premultiplied byte Skia stores for a straight (c, a) (SkMulDiv255Round). */
function premulTable() {
    if (PREMUL) return PREMUL;
    const t = new Uint8Array(65536);
    for (let a = 0; a < 256; a++) {
        for (let c = 0; c < 256; c++) {
            const x = c * a + 128;
            t[(a << 8) | c] = (x + (x >> 8)) >> 8;
        }
    }
    PREMUL = t;
    return t;
}

/**
 * A tile's bytes clamp-extended to the whole 256 x 256 from its valid part (vw x vh): the columns
 * right of vw hold column vw - 1 and the rows below vh hold row vh - 1.
 *
 * Only the last tile of a row or a column has a valid part smaller than itself, and the pixels
 * outside it are transparent. Halving that 2 x 2 mixes the last valid column with a transparent one
 * wherever the valid width is odd, so the image's own edge would fade by a level of mip; and the
 * texel a LINEAR sample reaches past the edge of a tile's slot would be that transparent column.
 * Repeating the edge pixel is what a texture clamped to its edge gives, which is what the canvas
 * backend's one texture per layer did.
 */
function edgeCopy(t, vw, vh) {
    let e = t.edge;
    if (e && e.data && t.edgeVersion === t.version && t.edgeW === vw && t.edgeH === vh) return e;
    if (!e) e = t.edge = newEdge();
    // the copy's own buffer: an inherited edge (a copy-on-write copy's) carries a chain to read, never bytes
    if (!e.data) e.data = new Uint8ClampedArray(TILE_BYTES);
    e.data.set(t.data);
    clampExtend(e.data, TILE_SIZE, vw, vh);
    t.edgeVersion = t.version;
    t.edgeW = vw; t.edgeH = vh;
    return e;
}

// ---- the scratch pool ----------------------------------------------------------------------------

const POOL = new Map();            // size class "wxh" -> free scratches
const POOL_PER_CLASS = 2;
const POOL_MAX_CLASS = 4096 * 4096;
const POOL_MAX_SIDE = 32768;       // a class of 65,536 px a side is above the side limit: exact sizes there
const POOL_MAX_TOTAL = 64 * 1024 * 1024;
let poolPixels = 0;
const SCRATCH_STATS = { created: 0, reused: 0, unpooled: 0, flipped: 0 };
let PROBE = null;

const sizeClass = (n) => { let s = 64; while (s < n) s <<= 1; return s; };

/** Clear a scratch and give its context a fresh context's state, save stack and path included. */
function resetScratch(s) {
    if (typeof s.ctx.reset === "function") s.ctx.reset();
    else { s.canvas.width = s.canvas.width; }   // assigning the width resets bitmap and state
}

/**
 * A scratch of at least w x h. An OffscreenCanvas with a `willReadFrequently` context: a
 * `willReadFrequently` <canvas> that has a GPU canvas drawn into it (a stroke buffer, a plain
 * canvas, an ImageBitmap of one, WebGL) is rasterised on the GPU from then on, reset or not,
 * which rounds untouched low-alpha pixels differently and changes every later draw (measured);
 * an OffscreenCanvas stays on the CPU. It clips without anti-aliasing, the one difference
 * measured against a CPU <canvas> (fonts, filters, shadows, patterns, gradients, images agree).
 */
function acquireScratch(w, h, what = "a draw") {
    checkCanvas(w, h, what);
    let cw = sizeClass(w), ch = sizeClass(h);
    const pooled = cw <= POOL_MAX_SIDE && ch <= POOL_MAX_SIDE && cw * ch <= POOL_MAX_CLASS;
    if (!pooled) { cw = w; ch = h; }
    const key = cw + "x" + ch;
    const list = pooled ? POOL.get(key) : null;
    let s = list && list.pop();
    if (s) {
        poolPixels -= cw * ch;
        SCRATCH_STATS.reused++;
    } else {
        let canvas;
        if (typeof OffscreenCanvas === "function") canvas = new OffscreenCanvas(cw, ch);
        else { canvas = document.createElement("canvas"); canvas.width = cw; canvas.height = ch; }
        s = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }), key, pooled, area: cw * ch };
        SCRATCH_STATS[pooled ? "created" : "unpooled"]++;
    }
    resetScratch(s);
    return s;
}

/** Is the scratch still rasterised on the CPU? (212, 24) reads back as 212 there and as 213 from a GPU canvas. */
function scratchOnCpu(s) {
    if (!PROBE) {
        PROBE = new ImageData(1, 1);
        PROBE.data[0] = 212; PROBE.data[3] = 24;
    }
    s.ctx.putImageData(PROBE, 0, 0);   // ignores whatever state the last use left
    return s.ctx.getImageData(0, 0, 1, 1).data[0] === 212;
}

function releaseScratch(s, reusable = true) {
    if (s.pooled && reusable && !scratchOnCpu(s)) {   // a guard: never measured with an OffscreenCanvas
        SCRATCH_STATS.flipped++;
        reusable = false;
    }
    if (!s.pooled || !reusable) { s.canvas.width = 1; s.canvas.height = 1; return; }
    const list = POOL.get(s.key) || [];
    if (list.length >= POOL_PER_CLASS || poolPixels + s.area > POOL_MAX_TOTAL) { s.canvas.width = 1; s.canvas.height = 1; return; }
    list.push(s);
    POOL.set(s.key, list);
    poolPixels += s.area;
}

/** The scratch pool's counters and the free canvases per size class (tests, memoryReport). */
export function scratchStats() {
    const free = {};
    for (const [k, list] of POOL) if (list.length) free[k] = list.length;
    return { ...SCRATCH_STATS, free, poolPixels };
}

// ---- the backend ---------------------------------------------------------------------------------

function checkSize(w, h) {
    if (w > TILE_MAX_SIDE || h > TILE_MAX_SIDE) {
        throw new Error(`Inpaint Canvas: ${w} × ${h} px is above the tile store's limit of 16,777,216 px a side`);
    }
    return [Math.max(1, w | 0), Math.max(1, h | 0)];
}

const tiled = (Base) => class extends Base {
    /** `new (w, h)`: transparent pixels without a tile; `new (canvas)`: the canvas read in strips. */
    constructor(w = 1, h = 1) {
        super(null);
        const canvas = w && typeof w === "object" ? w : null;
        const size = canvas ? checkSize(canvas.width, canvas.height) : checkSize(w, h);
        this._w = size[0];
        this._h = size[1];
        this._tiles = new Map();
        this._version = ++pixelSeq;
        this._mirror = null;
        this._mirrorDirty = null;
        this._thumb = null;
        this._regions = null;   // level -> the part of the pixels a view shows there, from the tiles' mips (C3)
        if (canvas) this._readCanvas(canvas);
    }

    static get backend() { return TILE_BACKEND; }

    static empty(w, h) { return new this(w, h); }

    /** The canvas's pixels, read in strips; the canvas is not kept (unlike the canvas backend). */
    static fromCanvas(canvas) { return new this(canvas); }

    static fromImageData(data) {
        const p = new this(data.width, data.height);
        p.writeRect(data, 0, 0);
        return p;
    }

    /** An <img>, ImageBitmap or canvas drawn at w x h, decoded in strips through one scratch. */
    static fromImage(img, w, h) {
        const p = new this(w || img.naturalWidth || img.width, h || img.naturalHeight || img.height);
        const W = p._w, H = p._h;
        // every strip draws the whole image translated by the strip's origin, so every pixel is
        // resampled exactly as in the canvas backend's one draw
        p._strips((ctx, sx, sy) => ctx.drawImage(img, -sx, -sy, W, H));
        return p;
    }

    get width() { return this._w; }

    get height() { return this._h; }

    get version() { return this._version; }

    get tileCount() { return this._tiles.size; }

    /** The tile store has no context of its own: a call here is a missed override. */
    _context() { throw new Error("Inpaint Canvas: tile pixels have no canvas context"); }

    bytes() { return this._tiles.size * TILE_BYTES; }

    /**
     * The pixels changed (`rect`, or anywhere): a new `version` for the caches that key on the object. The tiles
     * keep theirs. Every write into a tile already gave it a new version (`writable`) or put another tile object
     * in its place (`_share`, `_dropTile`, a copy on write), which is what the per-tile caches (extent, mips, edge
     * copy, atlas slot) compare, so a touch has nothing to add there. It used to give every tile under `rect` a new
     * version as well: a whole touch after a write of a few tiles then rebuilt 2,360 mip chains and re-uploaded
     * every visible slot at 15000 x 10000 (250 to 285 ms), and, through a tile an undo step shares, invalidated the
     * step's caches too (C6 b).
     */
    touch() {
        this._version = ++pixelSeq;
        if (this._mirror) this._mirror._dispVer = this._version;
    }

    /**
     * Moved when a chain a reader of the screen asked for landed in these pixels (C6 b): the atlas's instances and a
     * live stroke's view key on it. A chain only a thumbnail asked for leaves it (nothing on the screen changes).
     */
    get chainEpoch() { return this._chainEpoch || 0; }

    /**
     * The worker's chain of the tile at `key` landed (or the ask for it ended): the cells of the thumbnail and of
     * the region canvases that show a stale or coarse picture of that tile are put again on their next call.
     * `screen`: a reader of the screen asked for it. `handed`: the chain, which the tile does not keep, of the tile at
     * `version`: the thumbnail takes its level from it for the cell.
     */
    _chainLanded(key, screen = true, handed = null, version = -1) {
        if (screen) this._chainEpoch = ++chainEpochSeq;
        const th = this._thumb;
        if (th && th.stale.delete(key)) {
            th.dirty.add(key);
            if (handed && th.level) {
                const at = mipChainBytes(TILE_SIZE, th.level - 1);
                th.cells.set(key, { version, bytes: handed.slice(at, at + th.cell * th.cell * 4) });
            }
        }
        if (this._regions) for (const rc of this._regions.values()) if (rc.stale.delete(key)) rc.dirty.add(key);
    }

    /** The scheduler of these pixels' chains: their own when a test gave them one, else the module's. */
    _scheduler() { return this._chains || CHAINS; }

    // -- tiles --

    /** The tile at (tx, ty), made writable: allocated when missing (with `create`), copied when shared. */
    writable(tx, ty, create = true) {
        this._guard();
        const key = (ty << 16) | tx;
        let t = this._tiles.get(key);
        if (!t) {
            if (!create) return null;
            t = newTile();
            this._tiles.set(key, t);
        } else if (t.frozen > 0) {
            t.frozen--;
            const c = newTile();
            c.data.set(t.data);
            // the original's chains as the copy's stale picture until its own are built (C6 b): read, never written
            // (`mipsOwn` false), because the other holders of the original read the same buffers. The original gives
            // up owning them too: its last holder writes into it in place, and a rebuild into the buffer the copy reads
            // showed that holder's new pixels in the copy's cells under an unchanged stamp (the C6 b review)
            if (t.mips) { c.mips = t.mips; c.mipsSeq = t.mipsSeq; t.mipsOwn = false; }
            if (t.edge && t.edge.mips) {
                c.edge = newEdge();
                c.edge.mips = t.edge.mips; c.edge.mipsW = t.edge.mipsW; c.edge.mipsH = t.edge.mipsH; c.edge.mipsSeq = t.edge.mipsSeq;
                t.edge.mipsOwn = false;
            }
            this._tiles.set(key, c);
            t = c;
        } else {
            t.version = ++tileSeq;
        }
        this._changed(key);
        return t;
    }

    /** The tile at (tx, ty) for reading (null when missing). Never write into it: use `writable`. */
    tileAt(tx, ty) { this._guard(); return this._tiles.get((ty << 16) | tx) || null; }

    /** The tile keys, (ty << 16) | tx. */
    tileKeys() { this._guard(); return Array.from(this._tiles.keys()); }

    /** The five mips of a tile (128 to 8 px, one after the other), built lazily by the kernel; always exact. */
    mips(tx, ty) {
        this._guard();
        const t = this._tiles.get((ty << 16) | tx);
        return t ? plainChain(t) : null;
    }

    /**
     * The bytes of the tile at (tx, ty) at `level` (one buffer, `off` bytes in, `side` x `side`
     * straight-alpha RGBA8), clamp-extended when the tile is the last of a row or a column
     * (`edgeCopy`, `edgeChain`), with `stamp`: the tile's version when the bytes are exact. Null when the tile
     * is not allocated or lies outside the image.
     *
     * `display` (C6 b): for a picture on the screen. When the chain is not exact and the scheduler has spent
     * this task's budget, the chain is asked of the worker and the bytes are what the tile had meanwhile, `stale`
     * with a negative `stamp`: its previous chain when it kept one (the stamp, -1 - its seq, names that chain), else
     * `coarse` (the stamp -version - 0.5) and no `data`: the level sampled nearest from the tile's bytes, which
     * `coarseBytes` makes.
     */
    _levelBytes(tx, ty, level, display = false) {
        const t = this._tiles.get((ty << 16) | tx);
        if (!t) return null;
        const ox = tx << 8, oy = ty << 8;
        const vw = Math.min(TILE_SIZE, this._w - ox), vh = Math.min(TILE_SIZE, this._h - oy);
        if (vw <= 0 || vh <= 0) return null;
        const edge = vw < TILE_SIZE || vh < TILE_SIZE;
        if (!level) return { data: edge ? edgeCopy(t, vw, vh).data : t.data, off: 0, stamp: t.version };
        const off = mipChainBytes(TILE_SIZE, level - 1);
        if (edge ? edgeExact(t, vw, vh) : t.mipsVersion === t.version && t.mips) return { data: edge ? t.edge.mips : t.mips, off, stamp: t.version };
        if (display) {
            const sch = this._scheduler();
            if (!sch.mayBuild(t, vw, vh)) {
                sch.request(this, (ty << 16) | tx, t, vw, vh);
                const old = edge ? t.edge && t.edge.mips && t.edge : t.mips && t;
                if (old) return { data: old.mips, off, stamp: -1 - old.mipsSeq, stale: true };
                // no bytes yet: `coarseBytes` samples the level when a caller wants all of it, `tileWithGutter` only the lines it puts
                return { data: null, off: 0, stamp: -0.5 - t.version, stale: true, coarse: true, t, vw, vh, level };
            }
        }
        return { data: edge ? edgeChain(t, vw, vh) : plainChain(t), off, stamp: t.version };
    }

    /**
     * The stamp `_levelBytes(tx, ty, level, display)` would give, without making the bytes: 0 for a tile that is
     * not allocated or lies outside the image. A display call takes the same decision (build here, or ask the
     * worker) that the bytes call right after it then finds taken.
     */
    _stampAt(tx, ty, level, display) {
        if (tx < 0 || ty < 0) return 0;
        const t = this._tiles.get((ty << 16) | tx);
        if (!t) return 0;
        const ox = tx << 8, oy = ty << 8;
        const vw = Math.min(TILE_SIZE, this._w - ox), vh = Math.min(TILE_SIZE, this._h - oy);
        if (vw <= 0 || vh <= 0) return 0;
        if (!level) return t.version;
        const edge = vw < TILE_SIZE || vh < TILE_SIZE;
        if (edge ? edgeExact(t, vw, vh) : t.mipsVersion === t.version && t.mips) return t.version;
        if (display) {
            const sch = this._scheduler();
            if (!sch.mayBuild(t, vw, vh)) {
                sch.request(this, (ty << 16) | tx, t, vw, vh);
                const old = edge ? t.edge && t.edge.mips && t.edge : t.mips && t;
                return old ? -1 - old.mipsSeq : -0.5 - t.version;
            }
        }
        if (edge) edgeChain(t, vw, vh); else plainChain(t);
        return t.version;
    }

    /**
     * The stamps of the nine tiles an atlas slot at `level` is made from (C6 b), row by row with the tile itself
     * at 4, written into `out`: what `_levelBytes(..., display)` gives for each (0 for a neighbour that is not
     * allocated or lies outside the image). A slot is current while these are the ones it was made from; a
     * negative stamp at 4 is a tile whose exact chain is on its way.
     */
    slotStamps(tx, ty, level, display = false, out = new Float64Array(9)) {
        this._guard();
        let i = 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) out[i++] = this._stampAt(tx + dx, ty + dy, level, display);
        }
        return out;
    }

    /**
     * The tile at (tx, ty) at `level` (0 to MIP_LEVELS) with a one-pixel gutter of its neighbours'
     * edge pixels, **premultiplied** RGBA8, `(TILE_SIZE >> level) + 2` px a side: one slot of the
     * compositor's atlas page (docs/PLAN_BCE.md §C3). Written into `out` (a fresh buffer when none is
     * given, which the caller then keeps and hands back) and returned; null when the tile is not
     * allocated, which is the atlas's "nothing to draw here".
     *
     * The gutter is what stops a LINEAR sample at a slot's edge from reaching the next slot in the
     * page: a neighbour that exists gives its edge row or column, a missing one reads as transparent
     * (a missing tile is transparent), and past the image's own edge the tile's edge pixel is
     * repeated, which is what a texture clamped to its edge gave when a layer was one texture.
     *
     * Premultiplied because the atlas is sampled with LINEAR: straight alpha bleeds the colour of
     * transparent pixels across an edge. The shader divides the alpha out again, as it always did for
     * the canvas uploads (which Chromium premultiplied on the way in).
     */
    tileWithGutter(tx, ty, level = 0, out = null, ring = false, display = false) {
        // `ring`: only the gutter is written (rows 0 and S - 1, columns 0 and S - 1), for a slot whose
        // tile is unchanged and whose neighbours are not (C6 a); the interior of `out` is left as it was.
        // `display`: the bytes of `_levelBytes(..., display)`, stale or coarse where a chain is on its way (C6 b)
        this._guard();
        const own = this._levelBytes(tx, ty, level, display);
        if (!own) return null;
        const side = TILE_SIZE >> level, S = side + 2;
        if (!out || out.length < S * S * 4) out = new Uint8Array(S * S * 4);
        const near = [];
        const infoAt = (dx, dy) => {
            const k = (dy + 1) * 3 + (dx + 1);
            if (near[k] === undefined) near[k] = !dx && !dy ? own : this._levelBytes(tx + dx, ty + dy, level, display);
            return near[k];
        };
        // which neighbour each gutter pixel comes from, and its row / column there; at the image's
        // own edge the tile itself, its edge line repeated
        const leftX = tx > 0 ? -1 : 0, leftS = tx > 0 ? side - 1 : 0;
        const rightX = ((tx + 1) << 8) < this._w ? 1 : 0, rightS = rightX ? 0 : side - 1;
        const topY = ty > 0 ? -1 : 0, topS = ty > 0 ? side - 1 : 0;
        const botY = ((ty + 1) << 8) < this._h ? 1 : 0, botS = botY ? 0 : side - 1;
        const P = premulTable();
        const put = (info, sx, sy, n, o) => {
            if (!info) { out.fill(0, o, o + n * 4); return; }
            if (info.coarse) {
                // a tile whose chain is on its way and that has none: its bytes sampled nearest, only the pixels put here (C6 b)
                const d = info.t.data, f = 1 << level, half = f >> 1, lastX = info.vw - 1;
                const row = Math.min(sy * f + half, info.vh - 1) * TILE_SIZE;
                for (let k = 0; k < n; k++, o += 4) {
                    const i = (row + Math.min((sx + k) * f + half, lastX)) * 4;
                    const a = d[i + 3];
                    if (a === 255) { out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]; out[o + 3] = 255; continue; }
                    if (!a) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
                    const b = a << 8;
                    out[o] = P[b | d[i]]; out[o + 1] = P[b | d[i + 1]]; out[o + 2] = P[b | d[i + 2]]; out[o + 3] = a;
                }
                return;
            }
            const d = info.data;
            let i = info.off + (sy * side + sx) * 4;
            for (let k = 0; k < n; k++, i += 4, o += 4) {
                const a = d[i + 3];
                if (a === 255) { out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]; out[o + 3] = 255; continue; }
                if (!a) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
                const b = a << 8;
                out[o] = P[b | d[i]]; out[o + 1] = P[b | d[i + 1]]; out[o + 2] = P[b | d[i + 2]]; out[o + 3] = a;
            }
        };
        for (let y = 0; y < S; y++) {
            const dy = y === 0 ? topY : y === S - 1 ? botY : 0;
            const sy = y === 0 ? topS : y === S - 1 ? botS : y - 1;
            const o = y * S * 4;
            put(infoAt(leftX, dy), leftS, sy, 1, o);
            if (!ring || y === 0 || y === S - 1) put(infoAt(0, dy), 0, sy, side, o + 4);
            put(infoAt(rightX, dy), rightS, sy, 1, o + (S - 1) * 4);
        }
        return out;
    }

    /**
     * The slot of a tile that has no chain yet, at `level`, from its bytes sampled nearest (C6 b): premultiplied
     * like `tileWithGutter`, with the tile's own edge repeated as its gutter (its neighbours' pictures are just as
     * coarse, and the compositor replaces the slot when the chain lands). What the first frame after a whole change
     * of a large layer draws: 100 px a slot at level 5 and no neighbour read. Null when the tile is not allocated or
     * lies outside the image.
     */
    coarseSlot(tx, ty, level, out = null) {
        this._guard();
        const t = this._tiles.get((ty << 16) | tx);
        if (!t) return null;
        const vw = Math.min(TILE_SIZE, this._w - (tx << 8)), vh = Math.min(TILE_SIZE, this._h - (ty << 8));
        if (vw <= 0 || vh <= 0) return null;
        const side = TILE_SIZE >> level, S = side + 2, f = 1 << level, half = f >> 1;
        if (!out || out.length < S * S * 4) out = new Uint8Array(S * S * 4);
        const P = premulTable(), d = t.data;
        const s32 = LITTLE ? u32Of(t) : null, o32 = s32 ? words(out) : null;
        CHAIN_STATS.coarse++;
        for (let y = 0; y < S; y++) {
            const cy = y ? (y > side ? side - 1 : y - 1) : 0;
            const row = Math.min(cy * f + half, vh - 1) * TILE_SIZE;
            for (let x = 0, o = y * S * 4; x < S; x++, o += 4) {
                const cx = x ? (x > side ? side - 1 : x - 1) : 0;
                const j = row + Math.min(cx * f + half, vw - 1), i = j * 4;
                if (o32) {
                    // an opaque or a transparent pixel is one word (little-endian: alpha in the high byte)
                    const w = s32[j];
                    if (w >= 0xFF000000) { o32[o >> 2] = w; continue; }
                    if (w < ALPHA) { o32[o >> 2] = 0; continue; }
                }
                const a = d[i + 3];
                if (a === 255) { out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]; out[o + 3] = 255; continue; }
                if (!a) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
                const b = a << 8;
                out[o] = P[b | d[i]]; out[o + 1] = P[b | d[i + 1]]; out[o + 2] = P[b | d[i + 2]]; out[o + 3] = a;
            }
        }
        return out;
    }

    /**
     * The versions of the eight tiles `tileWithGutter(tx, ty)` reads its gutter from, written into
     * `out` (row by row around the tile, the tile itself left out): 0 for a neighbour that is not
     * allocated or lies outside the image, where the gutter is transparent or the tile's own edge.
     * A slot is current while its tile's version *and* these are the ones it was made from (C6 a).
     */
    gutterVersions(tx, ty, out = new Float64Array(8)) {
        this._guard();
        let i = 0;
        for (let dy = -1; dy <= 1; dy++) {
            const ny = ty + dy;
            for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const nx = tx + dx;
                let v = 0;
                if (nx >= 0 && ny >= 0 && (nx << 8) < this._w && (ny << 8) < this._h) {
                    const t = this._tiles.get((ny << 16) | nx);
                    if (t) v = t.version;
                }
                out[i++] = v;
            }
        }
        return out;
    }

    _changed(key) {
        if (this._mirrorDirty) this._mirrorDirty.add(key);
        if (this._thumb) this._thumb.dirty.add(key);
        if (this._regions) {
            // only the cells a region holds: its rebuild threshold counts them, and a write of tiles outside the view
            // rebuilt the whole region canvas every frame (the C6 b review); a region that moves is made again whole
            const tx = key & 0xFFFF, ty = key >>> 16;
            for (const rc of this._regions.values()) if (tx >= rc.tx0 && tx <= rc.tx1 && ty >= rc.ty0 && ty <= rc.ty1) rc.dirty.add(key);
        }
    }

    _dropTile(key) {
        const t = this._tiles.get(key);
        if (!t) return;
        if (t.frozen > 0) t.frozen--;
        this._tiles.delete(key);
        this._changed(key);
    }

    _share(key, t) {
        const old = this._tiles.get(key);
        if (old === t) return;
        if (old && old.frozen > 0) old.frozen--;
        t.frozen++;
        this._tiles.set(key, t);
        this._changed(key);
    }

    /** Keys of the allocated tiles that overlap r (whichever is fewer to walk: the grid or the map). */
    _keysIn(r) {
        const tx0 = r[0] >> 8, ty0 = r[1] >> 8, tx1 = (r[2] - 1) >> 8, ty1 = (r[3] - 1) >> 8;
        const out = [];
        if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= this._tiles.size) {
            for (let ty = ty0; ty <= ty1; ty++) {
                for (let tx = tx0; tx <= tx1; tx++) {
                    const key = (ty << 16) | tx;
                    if (this._tiles.has(key)) out.push(key);
                }
            }
        } else {
            for (const key of this._tiles.keys()) {
                const tx = key & 0xFFFF, ty = key >>> 16;
                if (tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1) out.push(key);
            }
        }
        return out;
    }

    /** Does the block [ix0, ix1) x [iy0, iy1) cover everything of the tile at (ox, oy) inside the pixels? */
    _coversTile(ox, oy, ix0, iy0, ix1, iy1) {
        return ix0 === ox && iy0 === oy && ix1 === Math.min(ox + TILE_SIZE, this._w) && iy1 === Math.min(oy + TILE_SIZE, this._h);
    }

    // -- bytes in and out --

    readRect(x, y, w, h) {
        this._guard();
        // getImageData's argument checks, in its order: conversion, a zero size, the checked int arithmetic
        x = enforceLong(x); y = enforceLong(y); w = enforceLong(w); h = enforceLong(h);
        if (!w || !h) throw new DOMException(`The source ${w ? "height" : "width"} is 0.`, "IndexSizeError");
        if (w * h < LONG_MIN || w * h > LONG_MAX) throw outOfMemory();
        if (w < 0) { if (w === LONG_MIN || x + w < LONG_MIN) throw outOfMemory(); x += w; w = -w; }
        if (h < 0) { if (h === LONG_MIN || y + h < LONG_MIN) throw outOfMemory(); y += h; h = -h; }
        if (x + w > LONG_MAX || y + h > LONG_MAX) throw outOfMemory();
        let out;
        try { out = new ImageData(w, h); } catch (_) { throw outOfMemory(); }
        const r = pixelRect([x, y, x + w, y + h], this._w, this._h);
        if (!r) return out;
        const dst = out.data;
        for (const key of this._keysIn(r)) {
            const t = this._tiles.get(key);
            const ox = (key & 0xFFFF) << 8, oy = (key >>> 16) << 8;
            const ix0 = Math.max(r[0], ox), ix1 = Math.min(r[2], ox + TILE_SIZE);
            const iy0 = Math.max(r[1], oy), iy1 = Math.min(r[3], oy + TILE_SIZE);
            const n = (ix1 - ix0) * 4;
            for (let yy = iy0; yy < iy1; yy++) {
                const so = ((yy - oy) * TILE_SIZE + (ix0 - ox)) * 4;
                dst.set(t.data.subarray(so, so + n), ((yy - y) * w + (ix0 - x)) * 4);
            }
        }
        return out;
    }

    /**
     * The w x h block of `src` (RGBA, `srcW` wide) at (sx, sy) into the pixels at (dx, dy), replacing
     * what was there; the block lies inside both. `normalize`: the bytes did not come from a canvas
     * and get its round trip. Unchanged tiles are left alone (no copy, no version); a block of zero
     * alpha allocates nothing, and a tile it leaves empty is dropped.
     */
    _putBlock(src, srcW, sx, sy, dx, dy, w, h, normalize) {
        const s32 = words(src);
        const x1 = dx + w, y1 = dy + h;
        for (let ty = dy >> 8; ty <= (y1 - 1) >> 8; ty++) {
            for (let tx = dx >> 8; tx <= (x1 - 1) >> 8; tx++) {
                const key = (ty << 16) | tx, ox = tx << 8, oy = ty << 8;
                const ix0 = Math.max(dx, ox), ix1 = Math.min(x1, ox + TILE_SIZE);
                const iy0 = Math.max(dy, oy), iy1 = Math.min(y1, oy + TILE_SIZE);
                const bw = ix1 - ix0, bh = iy1 - iy0, bsx = sx + ix0 - dx, bsy = sy + iy0 - dy;
                const lx = ix0 - ox, ly = iy0 - oy;
                const old = this._tiles.get(key);
                const zero = blockAlphaZero(src, s32, srcW, bsx, bsy, bw, bh);
                if (!old) { if (zero) continue; }
                else if (zero && this._coversTile(ox, oy, ix0, iy0, ix1, iy1)) { this._dropTile(key); continue; }
                else if (!normalize && blockEqual(old, src, s32, srcW, bsx, bsy, lx, ly, bw, bh)) continue;
                const t = this.writable(tx, ty);
                const n = bw * 4;
                for (let yy = 0; yy < bh; yy++) {
                    const so = ((bsy + yy) * srcW + bsx) * 4;
                    t.data.set(src.subarray(so, so + n), ((ly + yy) * TILE_SIZE + lx) * 4);
                }
                if (normalize) normalizeBlock(t.data, lx, ly, bw, bh);
                if (zero && tileEmpty(t)) this._dropTile(key);
            }
        }
    }

    writeRect(data, x, y, op = "copy", alpha = 1) {
        this._guard();
        const img = data instanceof ImageData ? data : new ImageData(data.data, data.width, data.height);
        if (op === "copy" && alpha === 1) {
            x = enforceLong(x); y = enforceLong(y);   // putImageData's conversion
            const r = pixelRect([x, y, x + img.width, y + img.height], this._w, this._h);
            if (r) this._putBlock(img.data, img.width, r[0] - x, r[1] - y, r[0], r[1], r[2] - r[0], r[3] - r[1], true);
            return;
        }
        const src = cpuCanvas(img.width, img.height, "a writeRect source");   // as the canvas backend makes its source, on the CPU
        src.getContext("2d").putImageData(img, 0, 0);
        try {
            this._drawOp(src, 0, 0, img.width, img.height, x, y, op, alpha);
        } finally {
            src.width = 1; src.height = 1;
        }
    }

    // -- the scratch path --

    /** Put the tiles over r into a scratch context whose (0, 0) is r's origin. */
    _fillScratch(ctx, r) {
        for (const key of this._keysIn(r)) {
            const t = this._tiles.get(key);
            const ox = (key & 0xFFFF) << 8, oy = (key >>> 16) << 8;
            const ix0 = Math.max(r[0], ox), ix1 = Math.min(r[2], ox + TILE_SIZE);
            const iy0 = Math.max(r[1], oy), iy1 = Math.min(r[3], oy + TILE_SIZE);
            ctx.putImageData(imageDataOf(t), ox - r[0], oy - r[1], ix0 - ox, iy0 - oy, ix1 - ix0, iy1 - iy0);
        }
    }

    /**
     * `fn(ctx)` on a scratch of r (whole pixels, inside these pixels) filled from the tiles, with a
     * fresh context's state, clipped to r when the scratch is bigger and translated by -r's origin;
     * then the scratch is written back with "copy" inside r. Returns what `fn` returns.
     */
    _scratchDraw(r, fn) {
        const rw = r[2] - r[0], rh = r[3] - r[1];
        const s = acquireScratch(rw, rh, "a draw");
        const ctx = s.ctx;
        let filled = false, reusable = true;
        try {
            this._fillScratch(ctx, r);
            filled = true;
            if (s.canvas.width > rw || s.canvas.height > rh) {
                const clip = new Path2D();
                clip.rect(0, 0, rw, rh);
                ctx.clip(clip);
            }
            ctx.translate(-r[0], -r[1]);
            let back;
            this._drawing++;
            try {
                back = fn(ctx);
            } finally {
                this._drawing--;
            }
            if (back && typeof back.then === "function") {
                // what fn draws after an await would land in a scratch that is no longer ours
                reusable = false;
                throw new Error("Inpaint Canvas: a drawInto callback must be synchronous");
            }
            return back;
        } finally {
            try {
                // written back also when fn threw, as the canvas backend keeps what fn drew before
                if (filled) {
                    for (let by = 0; by < rh; by += BLOCK) {
                        for (let bx = 0; bx < rw; bx += BLOCK) {
                            const bw = Math.min(BLOCK, rw - bx), bh = Math.min(BLOCK, rh - by);
                            const img = ctx.getImageData(bx, by, bw, bh);
                            this._putBlock(img.data, bw, 0, 0, r[0] + bx, r[1] + by, bw, bh, false);
                        }
                    }
                }
            } finally {
                releaseScratch(s, reusable);
            }
        }
    }

    drawInto(rect, fn) {
        this._guard();
        const r = pixelRect(rect, this._w, this._h);
        if (!r) return undefined;
        return this._scratchDraw(r, fn);
    }

    /** The canvas backend's `_drawOp`, on a scratch of the destination rectangle. */
    _drawOp(source, sx, sy, sw, sh, dx, dy, op, alpha) {
        const r = pixelRect([dx, dy, dx + sw, dy + sh], this._w, this._h);
        if (!r) return;
        this._scratchDraw(r, (ctx) => {
            ctx.globalAlpha = alpha;
            if (op === "copy") {
                ctx.globalCompositeOperation = "source-over";
                ctx.clearRect(dx, dy, sw, sh);
            } else {
                ctx.globalCompositeOperation = op;
                if (WHOLE_CANVAS_OPS.has(op)) {   // on whole pixels, as the canvas backend clips (the scratch clips without anti-aliasing)
                    const clip = new Path2D();
                    clip.rect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
                    ctx.clip(clip);
                }
            }
            ctx.drawImage(source, sx, sy, sw, sh, dx, dy, sw, sh);
        });
    }

    drawTo(ctx, ...args) {
        this._guard();
        ctx.drawImage(this.canvasForDisplay(), ...args);
    }

    // -- copies between pixels --

    blit(src, dx, dy, op = "source-over", alpha = 1, srcRect = null) {
        this._guard();
        src._guard();
        const r = pixelRect(srcRect, src.width, src.height);
        if (!r) return;
        const sw = r[2] - r[0], sh = r[3] - r[1];
        if (op === "copy" && alpha === 1 && Number.isInteger(dx) && Number.isInteger(dy)) {
            if (src === this) {   // overlapping: from a copy-on-write snapshot of the source rectangle
                this.blit(this.copyRect(r), dx, dy, op, alpha);
                return;
            }
            const cx0 = Math.max(0, dx), cy0 = Math.max(0, dy);
            const cx1 = Math.min(this._w, dx + sw), cy1 = Math.min(this._h, dy + sh);
            if (cx1 <= cx0 || cy1 <= cy0) return;
            const ssx = r[0] + cx0 - dx, ssy = r[1] + cy0 - dy;
            if (src._tiles instanceof Map) {
                this._copyTiles(src, ssx, ssy, cx0, cy0, cx1 - cx0, cy1 - cy0);
            } else {
                const img = src.readRect(ssx, ssy, cx1 - cx0, cy1 - cy0);
                this._putBlock(img.data, cx1 - cx0, 0, 0, cx0, cy0, cx1 - cx0, cy1 - cy0, false);
            }
            return;
        }
        const s = src._blitSource(r, dx, dy);
        try {
            this._drawOp(s.canvas, s.sx, s.sy, sw, sh, dx, dy, op, alpha);
        } finally {
            if (s.temp) { s.canvas.width = 1; s.canvas.height = 1; }
        }
    }

    /**
     * The source rectangle of a blit as a CPU canvas, materialised with a margin of BLIT_MARGIN px
     * (2): at a whole-pixel position an unscaled draw samples nothing outside the rectangle, but Skia
     * draws a sub-rectangle of an image by another path than a whole image (measured, 2,531 bytes of
     * up to 4 levels at an alpha of 0.35 without a margin); a fractional position samples the
     * neighbours, as a draw from the whole canvas does. (The display mirror, which fractional blits
     * drew from before, is a whole-layer canvas.) `temp`: the caller frees it after the draw.
     */
    _blitSource(r, dx, dy) {
        const m = pixelRect([r[0] - BLIT_MARGIN, r[1] - BLIT_MARGIN, r[2] + BLIT_MARGIN, r[3] + BLIT_MARGIN], this._w, this._h);
        return { canvas: this._materialise(m), sx: r[0] - m[0], sy: r[1] - m[1], temp: true };
    }

    /** Copy w x h of tile pixels `src` at (sx, sy) to (dx, dy), inside both; whole tiles are shared. */
    _copyTiles(src, sx, sy, dx, dy, w, h) {
        for (let y = 0; y < h;) {
            const syy = sy + y, dyy = dy + y;
            const bh = Math.min(h - y, TILE_SIZE - (syy & 255), TILE_SIZE - (dyy & 255));
            for (let x = 0; x < w;) {
                const sxx = sx + x, dxx = dx + x;
                const bw = Math.min(w - x, TILE_SIZE - (sxx & 255), TILE_SIZE - (dxx & 255));
                this._copyTileBlock(src, sxx, syy, dxx, dyy, bw, bh);
                x += bw;
            }
            y += bh;
        }
    }

    _copyTileBlock(src, sx, sy, dx, dy, bw, bh) {
        const stx = sx >> 8, sty = sy >> 8, dtx = dx >> 8, dty = dy >> 8;
        const skey = (sty << 16) | stx, dkey = (dty << 16) | dtx;
        const st = src._tiles.get(skey), dt = this._tiles.get(dkey);
        const slx = sx & 255, sly = sy & 255, dlx = dx & 255, dly = dy & 255;
        // a whole tile on both sides (or everything up to both pixels' edges): share it
        if (slx === 0 && sly === 0 && dlx === 0 && dly === 0
            && (bw === TILE_SIZE || (sx + bw === src._w && dx + bw === this._w))
            && (bh === TILE_SIZE || (sy + bh === src._h && dy + bh === this._h))) {
            if (st) this._share(dkey, st);
            else if (dt) this._dropTile(dkey);
            return;
        }
        const n = bw * 4;
        if (!st) {
            if (!dt || blockAlphaZero(dt.data, words(dt.data), TILE_SIZE, dlx, dly, bw, bh)) return;
            const t = this.writable(dtx, dty);
            for (let y = 0; y < bh; y++) {
                const o = ((dly + y) * TILE_SIZE + dlx) * 4;
                t.data.fill(0, o, o + n);
            }
            if (tileEmpty(t)) this._dropTile(dkey);
            return;
        }
        const zero = blockAlphaZero(st.data, words(st.data), TILE_SIZE, slx, sly, bw, bh);
        if (!dt ? zero : blockEqual(dt, st.data, words(st.data), TILE_SIZE, slx, sly, dlx, dly, bw, bh)) return;
        const t = this.writable(dtx, dty);
        for (let y = 0; y < bh; y++) {
            const so = ((sly + y) * TILE_SIZE + slx) * 4;
            t.data.set(st.data.subarray(so, so + n), ((dly + y) * TILE_SIZE + dlx) * 4);
        }
        if (zero && tileEmpty(t)) this._dropTile(dkey);
    }

    copyRect(rect) {
        this._guard();
        const r = pixelRect(rect, this._w, this._h);
        if (!r) return null;
        const out = new this.constructor(r[2] - r[0], r[3] - r[1]);
        out._copyTiles(this, r[0], r[1], 0, 0, r[2] - r[0], r[3] - r[1]);
        return out;
    }

    clone() {
        this._guard();
        const out = new this.constructor(this._w, this._h);
        for (const [key, t] of this._tiles) {
            t.frozen++;
            out._tiles.set(key, t);
        }
        return out;
    }

    resized(w, h, { x = 0, y = 0 } = {}) {
        this._guard();
        if (!Number.isInteger(x) || !Number.isInteger(y)) {
            // no call site passes a fractional offset (extend and crop round theirs); the canvas
            // backend resamples one, so its draw is repeated on a materialised canvas (CPU into CPU)
            const c = cpuCanvas(w, h, "a resized canvas"), from = this.toCanvas();
            c.getContext("2d").drawImage(from, x, y);
            from.width = 1; from.height = 1;
            const out = this.constructor.fromCanvas(c);
            c.width = 1; c.height = 1;
            return out;
        }
        const out = new this.constructor(w, h);
        const dx0 = Math.max(0, x), dy0 = Math.max(0, y);
        const dx1 = Math.min(out._w, x + this._w), dy1 = Math.min(out._h, y + this._h);
        if (dx1 > dx0 && dy1 > dy0) out._copyTiles(this, dx0 - x, dy0 - y, dx0, dy0, dx1 - dx0, dy1 - dy0);
        return out;
    }

    // -- canvases out --

    /** A new canvas of r filled from the tiles. */
    _materialise(r) {
        const rw = r[2] - r[0], rh = r[3] - r[1];
        const c = cpuCanvas(rw, rh, "a canvas", "; pixels that large cannot become one canvas (exports stream them per band, docs/PLAN_BCE.md §E2)");
        this._fillScratch(c.getContext("2d"), r);
        return c;
    }

    /** Always a new CPU canvas (of `rect`, or everything); refused above the canvas limits. Read-only for callers. */
    toCanvas(rect = null) {
        this._guard();
        if (!rect) return this._materialise([0, 0, this._w, this._h]);
        const r = pixelRect(rect, this._w, this._h);
        return r ? this._materialise(r) : cpuCanvas(1, 1);
    }

    /**
     * The display mirror: one canvas for the life of these pixels, synced from the tiles written
     * since the last call; its `_dispVer` is `version` (set by `touch()`). Read-only for callers (the
     * next sync overwrites what they draw). It is a CPU canvas, marked `_cpuMirror`: the editor's
     * screen draws a GPU copy of it (`displaySource`). C3 draws tiles and deletes it.
     */
    canvasForDisplay() {
        this._guard();
        if (!this._mirror) {
            const c = cpuCanvas(this._w, this._h, "a display canvas", " (C3 draws tiles)");
            // A plain value that touch() sets again, never an accessor on these pixels: a closure would keep
            // the pixels and every tile alive for as long as anything holds the canvas (the compositor's
            // texture map keys on it), long after a flip or a transform replaced them (C2 step b's review).
            c._dispVer = this._version;
            c._cpuMirror = true;
            this._mirror = c;
            this._mirrorDirty = new Set(this._tiles.keys());
        }
        if (this._mirrorDirty.size) {
            // putImageData ignores the context's state (transform, clip, alpha), so a caller that
            // left some on the mirror's context cannot bend the sync
            const ctx = this._mirror.getContext("2d");
            for (const key of this._mirrorDirty) {
                const ox = (key & 0xFFFF) << 8, oy = (key >>> 16) << 8;
                const t = this._tiles.get(key);
                ctx.putImageData(t ? imageDataOf(t) : zeroImage(), ox, oy, 0, 0, Math.min(TILE_SIZE, this._w - ox), Math.min(TILE_SIZE, this._h - oy));
            }
            this._mirrorDirty.clear();
        }
        return this._mirror;
    }

    /**
     * The rectangle of the pixels as a CPU canvas of its own, for the display pyramid's rectangle
     * refresh (inpaint_pixels.js). Not the mirror: a draw from a CPU canvas into a GPU canvas takes the
     * whole source along once its content changed (measured at 8000 × 6000: the frame after each move of
     * a small selection drag spent 104 ms refreshing the level from the mirror, 0.3 ms from the rectangle).
     */
    displayRectSource(rect) {
        this._guard();
        const r = pixelRect(rect, this._w, this._h);
        if (!r) return { canvas: cpuCanvas(1, 1), x: 0, y: 0, temp: true };
        // a big rectangle costs more to materialise than the mirror's transfer (measured: a 40 MP box per
        // move of a selection drag 260 to 320 ms against about 200 ms from the mirror)
        if ((r[2] - r[0]) * (r[3] - r[1]) > DISPLAY_RECT_MAX_PX) return { canvas: this.canvasForDisplay(), x: 0, y: 0, temp: false };
        return { canvas: this._materialise(r), x: r[0], y: r[1], temp: true };
    }

    /** The display mirror if it was made, unsynced (memoryReport, releaseCaches); null otherwise. */
    displayCanvasIfMade() {
        return this._mirror;
    }

    /**
     * A small CPU canvas of these pixels for a thumbnail, never the display mirror: a layer that nothing
     * draws (a hidden one, one in a tab that is not in front) must not get a canvas as large as itself for
     * a picture of 40 px (C2 step b's review). Each tile is averaged down by the mip kernel (alpha-weighted
     * 2 × 2 steps) to (256 >> level)², the level the largest at which the long side stays at least 256 px
     * (at most MIP_LEVELS), synced from the tiles written since the last call like the mirror. A tile whose
     * mips are cached gives them; otherwise nothing is kept on the tile. Read-only for callers.
     */
    thumbnailCanvas(display = false) {
        // `display` (C6 b): a tile whose chain is on its way in the worker shows its previous chain or a coarse
        // picture, kept in `stale` and put again when the chain lands. A tile that owns a chain buffer has it rebuilt
        // there and kept (the atlas then finds it exact); one that has none keeps none: its levels go into a scratch,
        // and a chain from the worker that only a thumbnail asked for is handed to the cell (`landed`) and dropped
        this._guard();
        let level = 0;
        while (level < MIP_LEVELS && (Math.max(this._w, this._h) >> (level + 1)) >= TILE_SIZE) level++;
        const cell = TILE_SIZE >> level;
        let th = this._thumb;
        if (!th || th.level !== level) {
            const f = 1 << level;
            th = this._thumb = {
                // `cells`: the cell of a tile that keeps no chain (built into a scratch, or handed by a landing), while
                // the tile keeps that version: a rebuild of the whole thumbnail takes it again instead of asking again
                // (it asked on every batch that landed, for good: a loop)
                level, cell, dirty: new Set(), stale: new Set(), all: true, cells: new Map(),
                canvas: cpuCanvas(Math.ceil(this._w / f), Math.ceil(this._h / f), "a thumbnail canvas"),
                img: new ImageData(cell, cell), zero: new ImageData(cell, cell),
            };
        }
        if (!display && th.stale.size) { for (const key of th.stale) th.dirty.add(key); th.stale.clear(); }
        const cols = Math.ceil(this._w / TILE_SIZE), rows = Math.ceil(this._h / TILE_SIZE);
        // most of the thumbnail: one putImageData of the whole of it, as a new one is made
        if (!th.all && th.dirty.size * 4 >= cols * rows) th.all = true;
        if (th.all || th.dirty.size) {
            const ctx = th.canvas.getContext("2d");
            const at = mipChainBytes(TILE_SIZE, level - 1), n = cell * cell * 4;
            const sch = this._scheduler();
            // the cell of one tile: { data, off, stale }, or { coarse, stale } for a tile with no chain yet (sampled nearest)
            const cellBytes = (key, t) => {
                if (!level) return { data: t.data, off: 0, stale: false };
                if (t.mipsVersion === t.version && t.mips) { if (th.cells.size) th.cells.delete(key); return { data: t.mips, off: at, stale: false }; }
                const got = th.cells.get(key);
                if (got && got.version === t.version) return { data: got.bytes, off: 0, stale: false };
                const tx = key & 0xFFFF, ty = key >>> 16;
                const vw = Math.min(TILE_SIZE, this._w - (tx << 8)), vh = Math.min(TILE_SIZE, this._h - (ty << 8));
                if (display && !sch.mayBuild(t, vw, vh)) {
                    sch.request(this, key, t, vw, vh, false);
                    if (t.mips) return { data: t.mips, off: at, stale: true };
                    return { coarse: true, stale: true };
                }
                if (t.mipsOwn && t.mips) { th.cells.delete(key); return { data: plainChain(t), off: at, stale: false }; }
                CHAIN_STATS.thumb++;
                const bytes = mipChain(t.data, TILE_SIZE, level, thumbScratch()).slice(at, at + n);
                th.cells.set(key, { version: t.version, bytes });
                return { data: bytes, off: 0, stale: false };
            };
            if (th.all) {
                const cw = th.canvas.width, ch = th.canvas.height;
                const all = new ImageData(cw, ch), dst = all.data;
                const d32 = LITTLE ? new Uint32Array(dst.buffer) : null;
                const f = 1 << level, half = f >> 1, stride = level ? cell : TILE_SIZE;
                th.stale.clear();
                for (const key of th.cells.keys()) if (!this._tiles.has(key)) th.cells.delete(key);
                for (const [key, t] of this._tiles) {
                    const ox = (key & 0xFFFF) * cell, oy = (key >>> 16) * cell;
                    const w = Math.min(cell, cw - ox), h = Math.min(cell, ch - oy);
                    if (w <= 0 || h <= 0) continue;
                    const b = cellBytes(key, t);
                    if (b.stale) th.stale.add(key);
                    // byte by byte: a cell is 8 px a side on a large document, and a view per row cost more than the copy
                    if (b.coarse && d32) {
                        const s32 = u32Of(t);
                        for (let y = 0; y < h; y++) {
                            const row = (y * f + half) * TILE_SIZE;
                            for (let x = 0, o = (oy + y) * cw + ox; x < w; x++, o++) d32[o] = s32[row + x * f + half];
                        }
                        continue;
                    }
                    if (b.coarse) {
                        const d = t.data;
                        for (let y = 0; y < h; y++) {
                            const row = (y * f + half) * TILE_SIZE;
                            for (let x = 0, o = ((oy + y) * cw + ox) * 4; x < w; x++, o += 4) {
                                const i = (row + x * f + half) * 4;
                                dst[o] = d[i]; dst[o + 1] = d[i + 1]; dst[o + 2] = d[i + 2]; dst[o + 3] = d[i + 3];
                            }
                        }
                        continue;
                    }
                    const d = b.data;
                    for (let y = 0; y < h; y++) {
                        let i = b.off + y * stride * 4;
                        for (let o = ((oy + y) * cw + ox) * 4, e = o + w * 4; o < e; o++, i++) dst[o] = d[i];
                    }
                }
                ctx.putImageData(all, 0, 0);
            } else {
                for (const key of th.dirty) {
                    const t = this._tiles.get(key);
                    const ox = (key & 0xFFFF) * cell, oy = (key >>> 16) * cell;
                    th.stale.delete(key);
                    if (!t) { th.cells.delete(key); ctx.putImageData(th.zero, ox, oy); continue; }
                    if (!level) { ctx.putImageData(imageDataOf(t), ox, oy); continue; }
                    const b = cellBytes(key, t);
                    if (b.stale) th.stale.add(key);
                    if (b.coarse) th.img.data.set(coarseLevel(t, level, TILE_SIZE, TILE_SIZE, false, coarseBuf(level)).subarray(0, n));
                    else th.img.data.set(b.data.subarray(b.off, b.off + n));
                    ctx.putImageData(th.img, ox, oy);
                }
            }
            th.all = false;
            th.dirty.clear();
        }
        return th.canvas;
    }

    /**
     * The part of these pixels a view shows, at `level`, as a CPU canvas built from the tiles' mips
     * (docs/PLAN_BCE.md §C3): what the screen draws the selection from, instead of a display level of
     * the whole image. Returns `{ canvas, x, y, f }` - the canvas holds whole tiles from image
     * coordinate (x, y) at a scale of 1 / f - or null when no tile of the range is allocated.
     *
     * The canvas covers a margin of one tile around the rectangle asked for and is kept while the
     * range asked for stays inside it, so a pan only rebuilds when it leaves; the tiles written since
     * the last call are put again, like the display mirror. Its last row and column hold the
     * clamp-extended edge of `tileWithGutter`, so the caller crops the draw to the image itself.
     */
    regionCanvas(rect, level = 0, display = false) {
        // `display` (C6 b): the cells of tiles whose chain is on its way in the worker show `_levelBytes`'s stale or
        // coarse picture, kept in `stale` and put again when the chain lands; a call without it puts them exactly
        this._guard();
        level = Math.max(0, Math.min(MIP_LEVELS, level | 0));
        const cell = TILE_SIZE >> level, f = 1 << level;
        const r = pixelRect(rect, this._w, this._h);
        if (!r) return null;
        const tx0 = r[0] >> 8, ty0 = r[1] >> 8, tx1 = (r[2] - 1) >> 8, ty1 = (r[3] - 1) >> 8;
        const lastX = (this._w - 1) >> 8, lastY = (this._h - 1) >> 8;
        if (!this._regions) this._regions = new Map();
        const holds = (q) => !!q && q.level === level && tx0 >= q.tx0 && ty0 >= q.ty0 && tx1 <= q.tx1 && ty1 <= q.ty1;
        // A read that is not for the screen or the navigator (a box the film points, the probe, a plugin or the wand
        // sample, the film panel's picture) uses a display region at its level when that one holds the range, and
        // otherwise a region of its own: taking a display region's place made the next frame rebuild the screen's whole
        // region per pixels object, 40-60 ms of a point add at 4000 x 3000 (the C6 c1 review)
        let key = level, rc = this._regions.get(level);
        if (!display && !holds(rc)) { key = SAMPLE_REGION; rc = this._regions.get(key); }
        if (!holds(rc)) {
            // one tile of margin on each side, inside the image
            const ax0 = Math.max(0, tx0 - 1), ay0 = Math.max(0, ty0 - 1);
            const ax1 = Math.min(lastX, tx1 + 1), ay1 = Math.min(lastY, ty1 + 1);
            if (rc) { rc.canvas.width = 1; rc.canvas.height = 1; }
            rc = {
                level, f, cell, tx0: ax0, ty0: ay0, tx1: ax1, ty1: ay1,
                x: ax0 * TILE_SIZE, y: ay0 * TILE_SIZE,
                canvas: cpuCanvas((ax1 - ax0 + 1) * cell, (ay1 - ay0 + 1) * cell, "a region canvas"),
                img: new ImageData(cell, cell), zero: new ImageData(cell, cell),
                dirty: new Set(), stale: new Set(), all: true,
            };
            this._regions.delete(key);   // inserted last: the Map's order is the LRU
            this._regions.set(key, rc);
            if (key !== SAMPLE_REGION) {
                // the screen's level and the navigator's differ, so two are kept; a third is one
                // level nothing is drawing at any more
                let n = this._regions.size - (this._regions.has(SAMPLE_REGION) ? 1 : 0);
                for (const [k, old] of this._regions) {
                    if (n <= REGION_LEVELS) break;
                    if (k === SAMPLE_REGION || k === level) continue;
                    old.canvas.width = 1; old.canvas.height = 1;
                    this._regions.delete(k);
                    n--;
                }
            }
        } else if (display) {
            this._regions.delete(key);   // re-inserted last: the Map's order is the LRU
            this._regions.set(key, rc);
        }
        if (!display && rc.stale.size) { for (const key of rc.stale) rc.dirty.add(key); rc.stale.clear(); }
        else if (rc.stale.size) {
            // still shown stale: their chains stay ahead of the ones nothing asks for any more (ChainScheduler.request)
            const sch = this._scheduler();
            for (const key of rc.stale) { const t = this._tiles.get(key); if (t) sch.touch(t); }
        }
        // most of the canvas written (a whole change, or a batch of chains landing): one rebuild, as for a new one
        if (!rc.all && rc.dirty.size * 4 >= (rc.tx1 - rc.tx0 + 1) * (rc.ty1 - rc.ty0 + 1)) rc.all = true;
        if (rc.all || rc.dirty.size) {
            const ctx = rc.canvas.getContext("2d");
            const n = cell * cell * 4;
            const put = (tx, ty) => {
                if (tx < rc.tx0 || tx > rc.tx1 || ty < rc.ty0 || ty > rc.ty1) return;
                const ox = (tx - rc.tx0) * cell, oy = (ty - rc.ty0) * cell;
                const key = (ty << 16) | tx;
                const lv = this._levelBytes(tx, ty, level, display);
                if (!lv) { rc.stale.delete(key); ctx.putImageData(rc.zero, ox, oy); return; }
                if (lv.stale) rc.stale.add(key); else rc.stale.delete(key);
                const b = coarseBytes(lv);
                rc.img.data.set(b.data.subarray(b.off, b.off + n));
                ctx.putImageData(rc.img, ox, oy);
            };
            if (rc.all) {
                // the whole region at once: one putImageData of a buffer the tiles are copied into row
                // by row. Per tile it is one call each, and at level 3 on a 15k document that is 2,400
                // calls of 32 x 32 px - 180 ms in the frame that first shows the view (measured).
                const cw = rc.canvas.width, ch = rc.canvas.height;
                const all = new ImageData(cw, ch);
                const dst = all.data;
                // small cells word by word (a view per row cost more than its copy at level 3: C6 b), large ones by row
                const d32 = LITTLE && cell < 64 ? new Uint32Array(dst.buffer) : null;
                const f = 1 << level;
                rc.stale.clear();
                for (let ty = rc.ty0; ty <= rc.ty1; ty++) {
                    for (let tx = rc.tx0; tx <= rc.tx1; tx++) {
                        const lv = this._levelBytes(tx, ty, level, display);
                        if (!lv) continue;
                        if (lv.stale) rc.stale.add((ty << 16) | tx);
                        const ox = (tx - rc.tx0) * cell, oy = (ty - rc.ty0) * cell;
                        if (d32) {
                            if (lv.coarse) {
                                // blocks of at most 8 x 8 samples a cell, the coarse level the atlas draws such a tile at
                                const s32 = u32Of(lv.t), lastX = lv.vw - 1, lastY = lv.vh - 1;
                                const q = Math.max(1, cell >> 3), qh = (q * f) >> 1;
                                for (let by = 0; by < cell; by += q) {
                                    const row = Math.min(by * f + qh, lastY) * TILE_SIZE, o0 = (oy + by) * cw + ox;
                                    for (let bx = 0; bx < cell; bx += q) {
                                        const v = s32[row + Math.min(bx * f + qh, lastX)];
                                        for (let y = 0, o = o0 + bx; y < q; y++, o += cw) for (let k = 0; k < q; k++) d32[o + k] = v;
                                    }
                                }
                            } else {
                                const s32 = new Uint32Array(lv.data.buffer, lv.data.byteOffset + lv.off, cell * cell);
                                for (let y = 0, i = 0; y < cell; y++) {
                                    for (let o = (oy + y) * cw + ox, e = o + cell; o < e; o++, i++) d32[o] = s32[i];
                                }
                            }
                            continue;
                        }
                        const b = coarseBytes(lv);
                        for (let y = 0; y < cell; y++) {
                            const from = b.off + y * cell * 4;
                            dst.set(b.data.subarray(from, from + cell * 4), ((oy + y) * cw + ox) * 4);
                        }
                    }
                }
                ctx.putImageData(all, 0, 0);
            } else {
                for (const key of rc.dirty) put(key & 0xFFFF, key >>> 16);
            }
            rc.all = false;
            rc.dirty.clear();
        }
        return { canvas: rc.canvas, x: rc.x, y: rc.y, f };
    }

    /** The region canvases that were made (memoryReport); an empty array when none. */
    regionCanvasesIfMade() {
        return this._regions ? Array.from(this._regions.values(), (rc) => rc.canvas) : [];
    }

    /** The thumbnail canvas if it was made (memoryReport); null otherwise. */
    thumbnailCanvasIfMade() {
        return this._thumb ? this._thumb.canvas : null;
    }

    /**
     * Drop the display mirror (and the thumbnail canvas): caches of the tiles, made again (synced from
     * every tile) by the next `canvasOf` / `thumbnailCanvas`. Returns their bytes. The caller forgets what
     * it keyed on the old canvas (the pyramid, the compositor's textures); nothing else may hold it.
     */
    releaseDisplay() {
        let bytes = 0;
        if (this._regions) {
            for (const rc of this._regions.values()) {
                bytes += rc.canvas.width * rc.canvas.height * 4;
                rc.canvas.width = 1; rc.canvas.height = 1;
            }
            this._regions = null;
        }
        const th = this._thumb;
        if (th) {
            bytes += th.canvas.width * th.canvas.height * 4;
            this._thumb = null;
            th.canvas.width = 1; th.canvas.height = 1;
        }
        const m = this._mirror;
        if (!m) return bytes;
        bytes += m.width * m.height * 4;
        this._mirror = null;
        this._mirrorDirty = null;
        m.width = 1; m.height = 1;
        return bytes;
    }

    /** The tiles, for counting (memoryReport): never write into one (use `writable`). */
    tileList() { this._guard(); return Array.from(this._tiles.values()); }

    // -- in place --

    clear(rect = null) {
        this._guard();
        const r = pixelRect(rect, this._w, this._h);
        if (!r) return;
        for (const key of this._keysIn(r)) {
            const ox = (key & 0xFFFF) << 8, oy = (key >>> 16) << 8;
            const ix0 = Math.max(r[0], ox), ix1 = Math.min(r[2], ox + TILE_SIZE);
            const iy0 = Math.max(r[1], oy), iy1 = Math.min(r[3], oy + TILE_SIZE);
            if (this._coversTile(ox, oy, ix0, iy0, ix1, iy1)) { this._dropTile(key); continue; }
            const lx = ix0 - ox, ly = iy0 - oy, bw = ix1 - ix0, bh = iy1 - iy0;
            const old = this._tiles.get(key);
            if (blockAlphaZero(old.data, words(old.data), TILE_SIZE, lx, ly, bw, bh)) continue;
            const t = this.writable(key & 0xFFFF, key >>> 16);
            for (let y = 0; y < bh; y++) {
                const o = ((ly + y) * TILE_SIZE + lx) * 4;
                t.data.fill(0, o, o + bw * 4);
            }
            if (tileEmpty(t)) this._dropTile(key);
        }
    }

    fill(rect, color) {
        this._guard();
        const r = pixelRect(rect, this._w, this._h);
        if (!r) return;
        if (typeof color !== "string") {   // a gradient or a pattern: the canvas backend's calls on a scratch
            this._scratchDraw(r, (ctx) => {
                ctx.clearRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
                ctx.fillStyle = color;
                ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
            });
            return;
        }
        const rgba = probeColor(color);
        if (!rgba[3]) { this.clear(r); return; }
        const word = LITTLE ? ((rgba[3] << 24) | (rgba[2] << 16) | (rgba[1] << 8) | rgba[0]) >>> 0 : 0;
        for (let ty = r[1] >> 8; ty <= (r[3] - 1) >> 8; ty++) {
            for (let tx = r[0] >> 8; tx <= (r[2] - 1) >> 8; tx++) {
                const ox = tx << 8, oy = ty << 8;
                const ix0 = Math.max(r[0], ox), ix1 = Math.min(r[2], ox + TILE_SIZE);
                const iy0 = Math.max(r[1], oy), iy1 = Math.min(r[3], oy + TILE_SIZE);
                const t = this.writable(tx, ty);
                for (let y = iy0 - oy; y < iy1 - oy; y++) {
                    if (LITTLE) {
                        u32Of(t).fill(word, y * TILE_SIZE + ix0 - ox, y * TILE_SIZE + ix1 - ox);
                    } else {
                        for (let i = (y * TILE_SIZE + ix0 - ox) * 4, e = (y * TILE_SIZE + ix1 - ox) * 4; i < e; i += 4) {
                            t.data[i] = rgba[0]; t.data[i + 1] = rgba[1]; t.data[i + 2] = rgba[2]; t.data[i + 3] = rgba[3];
                        }
                    }
                }
            }
        }
    }

    /**
     * The non-transparent extent, exactly as the canvas backend's scan finds it. Every allocated
     * tile holds a pixel (empty ones are dropped), so only the tiles in the outermost rows and
     * columns of the tile set can hold an edge; their exact extents are cached per tile version.
     */
    bounds() {
        this._guard();
        for (;;) {
            if (!this._tiles.size) return null;
            let txMin = Infinity, txMax = -1, tyMin = Infinity, tyMax = -1;
            for (const key of this._tiles.keys()) {
                const tx = key & 0xFFFF, ty = key >>> 16;
                if (tx < txMin) txMin = tx;
                if (tx > txMax) txMax = tx;
                if (ty < tyMin) tyMin = ty;
                if (ty > tyMax) tyMax = ty;
            }
            let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, empty = null;
            for (const [key, t] of this._tiles) {
                const tx = key & 0xFFFF, ty = key >>> 16;
                if (tx !== txMin && tx !== txMax && ty !== tyMin && ty !== tyMax) continue;
                const e = tileExtent(t);
                if (!e) { (empty || (empty = [])).push(key); continue; }
                const ox = tx << 8, oy = ty << 8;
                if (tx === txMin && ox + e[0] < x0) x0 = ox + e[0];
                if (tx === txMax && ox + e[2] > x1) x1 = ox + e[2];
                if (ty === tyMin && oy + e[1] < y0) y0 = oy + e[1];
                if (ty === tyMax && oy + e[3] > y1) y1 = oy + e[3];
            }
            if (!empty) return [x0, y0, x1, y1];
            for (const key of empty) this._dropTile(key);   // never expected: a write left one behind
        }
    }

    // -- decoding --

    /** `draw(ctx, sx, sy)` per strip of 4096 x DECODE_ROWS on one scratch, read back into the tiles. */
    _strips(draw) {
        const W = this._w, H = this._h, rows = DECODE_ROWS;
        const s = acquireScratch(Math.min(STRIP_W, W), Math.min(rows, H), "a decode strip");
        try {
            for (let sy = 0; sy < H; sy += rows) {
                for (let sx = 0; sx < W; sx += STRIP_W) {
                    const bw = Math.min(STRIP_W, W - sx), bh = Math.min(rows, H - sy);
                    resetScratch(s);
                    draw(s.ctx, sx, sy);
                    const img = s.ctx.getImageData(0, 0, bw, bh);
                    this._putBlock(img.data, bw, 0, 0, sx, sy, bw, bh, false);
                }
            }
        } finally {
            releaseScratch(s);
        }
    }

    /** A canvas's pixels, read in strips with its own getImageData (a canvas without a 2D context is drawn). */
    _readCanvas(canvas) {
        const ctx = canvas.getContext ? canvas.getContext("2d") : null;
        if (!ctx) {
            this._strips((c, sx, sy) => c.drawImage(canvas, -sx, -sy));
            return;
        }
        const W = Math.min(this._w, canvas.width), H = Math.min(this._h, canvas.height);
        for (let sy = 0; sy < H; sy += TILE_SIZE) {
            for (let sx = 0; sx < W; sx += STRIP_W) {
                const bw = Math.min(STRIP_W, W - sx), bh = Math.min(TILE_SIZE, H - sy);
                const img = ctx.getImageData(sx, sy, bw, bh);
                this._putBlock(img.data, bw, 0, 0, sx, sy, bw, bh, false);
            }
        }
    }
};

/** Layer pixels on tiles; `instanceof LayerPixels` holds. */
export class TileLayerPixels extends tiled(LayerPixels) {}

/** A layer mask or the selection on tiles: RGBA tiles in C2 (C5 moves masks to one channel). */
export class TileMaskPixels extends tiled(MaskPixels) {
    /**
     * The selection inverted, tile by tile. The inverse covers everything the selection does not,
     * so no bounding box can help here, but the whole mask does not have to become a canvas, an
     * ImageBitmap and a scratch of 600 MB each on the way through the worker either
     * (docs/PLAN_BCE.md §C5). Only the part of a tile that is inside the image is touched: the rest
     * is what `edgeCopy` clamps from, and a selected padding would bleed into the tile's mips.
     */
    invert() {
        this._guard();
        const cols = Math.ceil(this._w / TILE_SIZE), rows = Math.ceil(this._h / TILE_SIZE);
        // the selection's own red at full alpha, as one word (little-endian: R is the low byte)
        const SEL = 0xFF0000FF;
        for (let ty = 0; ty < rows; ty++) {
            const bh = Math.min(TILE_SIZE, this._h - (ty << 8));
            for (let tx = 0; tx < cols; tx++) {
                const key = (ty << 16) | tx;
                const bw = Math.min(TILE_SIZE, this._w - (tx << 8));
                const had = this._tiles.get(key);
                const t = this.writable(tx, ty);
                if (!had && LITTLE) {
                    // nothing was selected here, so all of it is now: one fill, no reading
                    const w = u32Of(t);
                    if (bw === TILE_SIZE) w.fill(SEL, 0, bh * TILE_SIZE);
                    else for (let y = 0; y < bh; y++) w.fill(SEL, y * TILE_SIZE, y * TILE_SIZE + bw);
                } else if (LITTLE) {
                    const w = u32Of(t);
                    for (let y = 0; y < bh; y++) {
                        let o = y * TILE_SIZE;
                        for (let x = 0; x < bw; x++, o++) {
                            const a = 255 - (w[o] >>> 24);
                            // a pixel the invert leaves fully transparent carries no colour: a canvas
                            // stores premultiplied and un-premultiplies such a pixel to 0, 0, 0, and the
                            // two backends have to agree byte for byte (tools/pixels_test.js)
                            w[o] = a ? ((a << 24) | 0x0000FF) >>> 0 : 0;
                        }
                    }
                } else {
                    const d = t.data;
                    for (let y = 0; y < bh; y++) {
                        let o = y * TILE_SIZE * 4;
                        for (let x = 0; x < bw; x++, o += 4) {
                            const a = 255 - d[o + 3];
                            d[o] = a ? 255 : 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = a;
                        }
                    }
                }
                if (tileEmpty(t)) this._dropTile(key);
            }
        }
        this._version = ++pixelSeq;
        if (this._mirror) this._mirror._dispVer = this._version;
    }
}

const TILE_BACKEND = Object.freeze({ Layer: TileLayerPixels, Mask: TileMaskPixels, tiles: true });

/** The classes of a backend: `{ Layer, Mask, tiles }`, the tile store for `tiles`, else the canvas. */
export function pixelsBackend(tiles) {
    return tiles ? TILE_BACKEND : LayerPixels.backend;
}

/** Are these pixels on tiles? */
export function isTilePixels(p) {
    return p instanceof LayerPixels && p._tiles instanceof Map;
}
