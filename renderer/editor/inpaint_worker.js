/**
 * The editor's worker: everything that used to stall the main thread with a whole image
 * in hand. It runs in the ComfyUI page and in the app alike (a module worker created from
 * `import.meta.url`, so both hosts serve it from next to the editor).
 *
 * Jobs:
 *   png             one canvas -> a PNG blob, optionally with the upload hash. The main
 *                   thread only pays for createImageBitmap (25 ms on a 96 MP canvas)
 *                   instead of the 755 ms that canvas.toBlob blocks it for.
 *   export_begin / export_layer / export_finish
 *                   a layered PSD or ORA file, one layer at a time: the layer is packed
 *                   as soon as its pixels arrive, so only one layer is ever in flight and
 *                   the 3 s PackBits run happens off the main thread.
 *   selection       grow, shrink, feather or invert the selection (up to 3.9 s on the
 *                   main thread at 96 MP).
 *   flood           the magic wand's and the bucket's region: the similar pixels around a
 *                   point, clipped to the selection, as a coloured shape.
 *   mips            the mip chains of a batch of tiles, after a change of a whole layer or
 *                   mask (2,360 chains, about 300 ms, at 15000 x 10000). The editor runs
 *                   this job in a worker of its own, so a long flood does not hold it up.
 *   png_part        one part of a PNG written in parts (inpaint_png.js): rows, as bytes or as the tiles that hold
 *                   them, filtered and deflated into a finished IDAT chunk. Stateless, so the pool runs them.
 *   hash            the short SHA-1 of a blob.
 *   psd_part        one part of a PSD's channel data: rows (bytes or tiles) as PackBits per channel.
 *   crc             CRC-32 and size of a blob (a zip entry of an ORA file).
 *   png_read        a PNG file decoded as a stream, its rows back band by band (`progress` messages).
 *   band            a row of tiles composited, layer over layer (`compositeTile`): no caller in
 *                   the editor yet; phase R measures the kernel phase E's band export will run.
 *
 * Pixels arrive as ImageBitmaps (transferred, never copied through structured cloning) and
 * are closed as soon as they are drawn. Every reply carries the request's id; a failure
 * comes back as { ok: false, error } and the editor falls back to the main thread.
 *
 * The pixel kernels come from px/kernels.js: the Rust build once this worker has loaded it, the
 * JS twins before and without it. `kernels: "js"` on a job forces the twins (the benchmark,
 * tools/px_jobs.py). The mips, selection, flood and band jobs reply with `timing`: the
 * milliseconds of their parts.
 */
import { PsdWriter, OraWriter } from "./inpaint_export.js";
import { floodMask, maskToColorCanvas, clipMaskToSelection, growMaskBounds, invertMask, maskBounds, hexToRgb } from "./inpaint_raster.js";
import { pngChunk, crc32, readPng, PNG_LEVEL, NO_PARTS } from "./inpaint_png.js";
import { mipChain, mipChainBytes, clampExtend, compositeTile, matchPixels, psdPackRows, kernelsReady, setKernels, rustPx, kernelsInUse, releaseIfLarge } from "./px/kernels.js";

const TILE = 256, LEVELS = 5, TILE_BYTES = TILE * TILE * 4;
const now = () => performance.now();

// The tile arena's chunks (inpaint_arena.js, docs/PLAN_BCE.md §E1): index -> SharedArrayBuffer, sent by the pool before
// the first job and on every change. A job names a tile in the arena as { chunk, slot } and it is read where it lies;
// any other tile comes as { data: ArrayBuffer }, a copy, transferred.
const ARENA = new Map();

function arenaMessage(msg) {
    for (const [index, sab] of msg.added || []) ARENA.set(index, sab);
    for (const index of msg.dropped || []) ARENA.delete(index);
}

/** The bytes of a job's tile. `shared`: they are the document's own, never to be written. */
function tileBytes(t) {
    if (t.data) return { bytes: new Uint8Array(t.data, 0, TILE_BYTES), shared: false };
    const sab = ARENA.get(t.chunk);
    if (!sab) throw new Error("unknown arena chunk " + t.chunk);
    return { bytes: new Uint8Array(sab, t.slot * TILE_BYTES, TILE_BYTES), shared: true };
}

/**
 * The mip chains of a batch of tiles (docs/PLAN_BCE.md §C6 b): each tile's bytes (a copy, transferred) give
 * its chain, and an edge tile (valid part vw x vh below 256) also the chain of its clamp-extended bytes, which
 * is what the atlas and the region canvases draw. The same kernels the main thread runs, so the bytes are the
 * ones it would build. The chains and the tile buffers go back transferred (the buffers for the next batch).
 */
async function mips(msg) {
    const p = rustPx();
    const t0 = now();
    const out = p ? mipsRust(p, msg) : mipsJs(msg);
    out.timing = { op: "mips", kernels: p ? "rust" : "js", tiles: msg.tiles.length, kernel: now() - t0 };
    return out;
}

function mipsJs(msg) {
    const n = mipChainBytes(TILE, LEVELS);
    const chains = [], exts = [], datas = [], transfer = [];
    for (const t of msg.tiles) {
        const { bytes, shared } = tileBytes(t);
        const chain = mipChain(bytes, TILE, LEVELS, new Uint8Array(n));
        chains.push(chain.buffer);
        transfer.push(chain.buffer);
        if (t.vw < TILE || t.vh < TILE) {
            // extended in place in the job's copy; a tile in the arena is the document's, so in a copy of it
            const own = shared ? bytes.slice() : bytes;
            clampExtend(own, TILE, t.vw, t.vh);
            const ext = mipChain(own, TILE, LEVELS, new Uint8Array(n));
            exts.push(ext.buffer);
            transfer.push(ext.buffer);
        } else {
            exts.push(null);
        }
        datas.push(t.data || null);
        if (t.data) transfer.push(t.data);
    }
    return { chains, exts, datas, transfer };
}

/** The same chains from the Rust kernels: each tile copied into wasm memory, its chain copied out. */
function mipsRust(p, msg) {
    const n = p.exports.mip_chain_bytes(TILE, LEVELS), a = p.job;
    const chains = [], exts = [], datas = [], transfer = [];
    try {
        const pin = a.take(TILE * TILE * 4), pout = a.take(n);
        for (const t of msg.tiles) {
            p.u8().set(tileBytes(t).bytes, pin);
            p.exports.mip_chain(pin, TILE, LEVELS, pout);
            const chain = p.u8().slice(pout, pout + n);
            chains.push(chain.buffer);
            transfer.push(chain.buffer);
            if (t.vw < TILE || t.vh < TILE) {
                p.exports.clamp_extend(pin, TILE, t.vw, t.vh);
                p.exports.mip_chain(pin, TILE, LEVELS, pout);
                const ext = p.u8().slice(pout, pout + n);
                exts.push(ext.buffer);
                transfer.push(ext.buffer);
            } else {
                exts.push(null);
            }
            datas.push(t.data || null);
            if (t.data) transfer.push(t.data);
        }
    } finally { a.reset(); }
    return { chains, exts, datas, transfer };
}

/**
 * A row of tiles composited (docs/PLAN_BCE.md §2b, E2): `columns` of { dst, srcs: [ArrayBuffer], masks: [ArrayBuffer or
 * null] }, the same `ops` and `alphas` for every column. Each dst comes back composited, transferred.
 */
async function band(msg) {
    const t0 = now();
    const transfer = [];
    for (const col of msg.columns) {
        const dst = new Uint8Array(col.dst);
        const srcs = col.srcs.map((b) => new Uint8Array(b)), masks = col.masks.map((b) => (b ? new Uint8Array(b) : null));
        compositeTile(dst, srcs, msg.ops, msg.alphas, masks);
        transfer.push(col.dst);
    }
    return { dsts: transfer, transfer, timing: { op: "band", kernels: kernelsInUse(), tiles: msg.columns.length, kernel: now() - t0 } };
}

/**
 * The rows `r0` to `r0 + rows` of one tile row as RGBA8, `w` wide: `tiles` holds the row's tiles from the left (null
 * for one that does not exist: transparent). With `above`, the single row above them instead (the PNG filter's `prev`):
 * row `r0 - 1` of the same tiles, or the last row of `prevTiles`, or null for the picture's first row.
 */
function rowsOfTiles(msg, above = false) {
    let tiles = msg.tiles, r0 = msg.r0 | 0, rows = msg.rows;
    if (above) {
        if (r0 > 0) { r0--; rows = 1; } else if (msg.prevTiles) { tiles = msg.prevTiles; r0 = TILE - 1; rows = 1; } else return null;
    }
    const w = msg.w, out = new Uint8Array(w * rows * 4);
    for (let tx = 0; tx * TILE < w; tx++) {
        const t = tiles[tx];
        if (!t) continue;
        const { bytes } = tileBytes(t);
        const n = Math.min(TILE, w - tx * TILE) * 4;
        for (let y = 0; y < rows; y++) {
            const so = (r0 + y) * TILE * 4;
            out.set(bytes.subarray(so, so + n), (y * w + tx * TILE) * 4);
        }
    }
    return out;
}

/**
 * The rows `Y0` to `Y0 + n` of the image out of one store of a stack: `{ x, y, w, h, tiles }`, its pixels at (x, y) of
 * the image, `tiles[lty]` the names of its tile row `lty` from the left (as `rowsOfTiles` takes them). Into `out`, `W`
 * pixels wide from the image's column `X0`: RGBA8, or with `alphaOnly` one byte a pixel, the alpha. False when no tile
 * of the store lies there.
 */
function storeRows(store, X0, W, Y0, n, out, alphaOnly = false) {
    const sx = store.x | 0, sy = store.y | 0;
    const y0 = Math.max(Y0, sy), y1 = Math.min(Y0 + n, sy + store.h);
    const x0 = Math.max(X0, sx), x1 = Math.min(X0 + W, sx + store.w);
    if (y1 <= y0 || x1 <= x0) return false;
    let any = false;
    for (let lty = (y0 - sy) >> 8; lty * TILE < y1 - sy; lty++) {
        const names = store.tiles[lty];
        if (!names) continue;
        const ry0 = Math.max(y0, sy + lty * TILE), ry1 = Math.min(y1, sy + (lty + 1) * TILE);
        for (let ltx = (x0 - sx) >> 8; ltx * TILE < x1 - sx; ltx++) {
            const t = names[ltx];
            if (!t) continue;
            const { bytes } = tileBytes(t);
            const cx0 = Math.max(x0, sx + ltx * TILE), cx1 = Math.min(x1, sx + (ltx + 1) * TILE), k = cx1 - cx0;
            any = true;
            for (let Y = ry0; Y < ry1; Y++) {
                const so = ((Y - sy - lty * TILE) * TILE + (cx0 - sx - ltx * TILE)) * 4, o = (Y - Y0) * W + cx0 - X0;
                if (alphaOnly) for (let i = 0; i < k; i++) out[o + i] = bytes[so + i * 4 + 3];
                else out.set(bytes.subarray(so, so + k * 4), o * 4);
            }
        }
    }
    return any;
}

/**
 * Rows of a plain stack composited here, from the tiles where they lie (docs/PLAN_BCE.md §3b, B item 1): `stack` is
 * `{ base, layers: [{ x, y, w, h, tiles, alpha, op, mask }] }`, every store as `storeRows` takes it, a layer drawn
 * source-over or in its blend mode (`op`, the kernel's number; B item 7) at `alpha` (0..255) through its mask's alpha (a store on the layer's own grid; where the mask has no
 * tile the layer shows nothing). The rows `y` to `y + rows`, or with `above` the one row over them (null at the top),
 * `w` pixels from the image's column `x0`. `into`: a cleared buffer of that size to composite in (a part of a shared one).
 * `base` may be null: nothing below the layers (the wand's and the bucket's "sample the layer"), or, with `into`, what
 * the buffer already holds (B item 7 part 2: the layers above a filter layer go over the filtered band). A layer with
 * `sab` instead of tiles is a buffer of the same box as `into` (`msg.y0` its first row): a filter layer's result, which
 * goes over the band it was made from at the layer's opacity, in its blend mode, through its mask. A layer with
 * `match` (the ten floats of a colour match, B item 7 part 3) is matched here, on its copy of the rows, before it
 * is composited.
 */
function rowsOfStack(msg, above = false, into = null) {
    let Y0 = msg.y | 0, n = msg.rows;
    if (above) { if (Y0 <= 0) return null; Y0--; n = 1; }
    const W = msg.w, X0 = msg.x0 | 0, st = msg.stack;
    const dst = into || new Uint8Array(W * n * 4);
    if (st.base) storeRows(st.base, X0, W, Y0, n, dst);
    const srcs = [], alphas = [], masks = [], ops = [];
    for (const l of st.layers) {
        let src;
        if (l.sab) src = new Uint8Array(l.sab, (Y0 - (msg.y0 | 0)) * W * 4, W * n * 4);
        else {
            src = new Uint8Array(W * n * 4);
            if (!storeRows(l, X0, W, Y0, n, src)) continue;
            if (l.match) matchPixels(src, l.match);
        }
        let mask = null;
        if (l.mask) { mask = new Uint8Array(W * n); storeRows({ x: l.x, y: l.y, w: l.w, h: l.h, tiles: l.mask }, X0, W, Y0, n, mask, true); }
        srcs.push(src); alphas.push(l.alpha); masks.push(mask); ops.push(l.op | 0);
    }
    if (srcs.length) compositeTile(dst, srcs, ops, alphas, masks);
    return dst;
}

/**
 * Rows of a stack composited into a shared buffer (B item 2: the picture a flood reads, put together by the pool):
 * `sab` holds `w` x `h` RGBA8 of the box at (`x0`, `y0`) of the image, zeroed (or `clear` asks this job to zero its
 * rows first); this job fills the rows `y` to `y + rows`.
 */
async function stackInto(msg) {
    const t0 = now();
    const at = ((msg.y | 0) - (msg.y0 | 0)) * msg.w * 4;
    const into = new Uint8Array(msg.sab, at, msg.w * msg.rows * 4);
    if (msg.clear) into.fill(0);   // a buffer that is used band after band (B item 7 part 2): cleared here, not on the main thread
    rowsOfStack(msg, false, into);
    return { timing: { op: "stack_into", kernels: kernelsInUse(), pixels: msg.w * msg.rows, kernel: now() - t0 } };
}

/**
 * The samples of one store at the image pixels `xs` x `ys` (a grid), into `out`: RGBA8, or with `alphaOnly` one byte a
 * pixel. A sample outside the store, or on a tile it does not have, stays as it is. False when nothing was read.
 */
function gatherStore(store, xs, ys, out, alphaOnly = false) {
    const sx = store.x | 0, sy = store.y | 0, nx = xs.length, ny = ys.length;
    let any = false;
    for (let j = 0; j < ny; j++) {
        const Y = ys[j] - sy;
        if (Y < 0 || Y >= store.h) continue;
        const names = store.tiles[Y >> 8];
        if (!names) continue;
        const ro = (Y & (TILE - 1)) * TILE;
        let last = null, bytes = null;
        for (let i = 0; i < nx; i++) {
            const X = xs[i] - sx;
            if (X < 0 || X >= store.w) continue;
            const t = names[X >> 8];
            if (!t) continue;
            if (t !== last) { bytes = tileBytes(t).bytes; last = t; }
            const so = (ro + (X & (TILE - 1))) * 4, o = j * nx + i;
            any = true;
            if (alphaOnly) out[o] = bytes[so + 3];
            else { out[o * 4] = bytes[so]; out[o * 4 + 1] = bytes[so + 1]; out[o * 4 + 2] = bytes[so + 2]; out[o * 4 + 3] = bytes[so + 3]; }
        }
    }
    return any;
}

/**
 * Point samples of a stack for a layer's colour-match statistics (B item 7 part 3): `grid` { x0, y0, dx, dy, nx, ny }
 * names the image pixels (floor(x0 + i·dx), floor(y0 + j·dy)); `stack` is `rowsOfStack`'s, the layers below the
 * matched one with their own `match` where they have one; `layer` the matched layer's store with its `mask`, or
 * null. Answers `{ bel, lay }`, nx × ny RGBA8 each, transferred: the composite below at the samples, and the layer's
 * own samples with its mask folded into the alpha. A sample outside the image or a store is transparent. The
 * composite is pointwise, so the composite of the samples is the samples of the composite.
 */
async function stackPoints(msg) {
    const t0 = now();
    const { x0, y0, dx, dy, nx, ny } = msg.grid, n = nx * ny;
    const xs = new Int32Array(nx), ys = new Int32Array(ny);
    for (let i = 0; i < nx; i++) xs[i] = Math.floor(x0 + i * dx);
    for (let j = 0; j < ny; j++) ys[j] = Math.floor(y0 + j * dy);
    const st = msg.stack, bel = new Uint8Array(n * 4);
    if (st.base) gatherStore(st.base, xs, ys, bel);
    const srcs = [], alphas = [], masks = [], ops = [];
    for (const l of st.layers) {
        if (l.sab) continue;   // a filtered band cannot be sampled (a matched layer above a filter takes the region pass)
        const src = new Uint8Array(n * 4);
        if (!gatherStore(l, xs, ys, src)) continue;
        if (l.match) matchPixels(src, l.match);
        let mask = null;
        if (l.mask) { mask = new Uint8Array(n); gatherStore({ x: l.x, y: l.y, w: l.w, h: l.h, tiles: l.mask }, xs, ys, mask, true); }
        srcs.push(src); alphas.push(l.alpha); masks.push(mask); ops.push(l.op | 0);
    }
    if (srcs.length) compositeTile(bel, srcs, ops, alphas, masks);
    const lay = new Uint8Array(n * 4);
    if (msg.layer && gatherStore(msg.layer, xs, ys, lay) && msg.layer.mask) {
        const m = new Uint8Array(n);
        gatherStore({ x: msg.layer.x, y: msg.layer.y, w: msg.layer.w, h: msg.layer.h, tiles: msg.layer.mask }, xs, ys, m, true);
        for (let i = 0; i < n; i++) { const t = lay[i * 4 + 3] * m[i] + 128; lay[i * 4 + 3] = (t + (t >> 8)) >> 8; }
    }
    return { bel: bel.buffer, lay: lay.buffer, transfer: [bel.buffer, lay.buffer], timing: { op: "stack_points", kernels: kernelsInUse(), pixels: n, kernel: now() - t0 } };
}

/** The rows of a part job, whichever way they come: bytes, a stack to composite, or one store's tiles. */
function partRowsOf(msg) {
    if (msg.rgba) return new Uint8Array(msg.rgba, 0, msg.w * msg.rows * 4);
    return msg.stack ? rowsOfStack(msg) : rowsOfTiles(msg);
}

/**
 * One part of a PNG's pixels (inpaint_png.js, docs/PLAN_BCE.md §E2): rows as bytes (`rgba`, `prev`) or as tiles
 * (`tiles`, `prevTiles`, `r0`), filtered and deflated by the Rust kernel, as a finished IDAT chunk.
 */
async function pngPart(msg) {
    const p = rustPx();
    if (!p) throw new Error(NO_PARTS);
    const t0 = now();
    const rgba = partRowsOf(msg);
    const tc = now();
    const prev = msg.rgba ? (msg.prev ? new Uint8Array(msg.prev, 0, msg.w * 4) : null) : msg.stack ? rowsOfStack(msg, true) : rowsOfTiles(msg, true);
    const r = p.pngPart(rgba, msg.w, msg.rows, prev, msg.level === undefined ? PNG_LEVEL : msg.level, !!msg.last);
    releaseIfLarge();
    const chunk = pngChunk("IDAT", r.bytes);
    return { chunk: chunk.buffer, adler: r.adler, raw: r.raw, transfer: [chunk.buffer], timing: { op: "png_part", kernels: "rust", pixels: msg.w * msg.rows, kernel: now() - t0, compose: msg.stack ? tc - t0 : 0 } };
}

/**
 * One part of a PSD's channel data (docs/PLAN_BCE.md §E4): rows as bytes or as tiles (as `png_part` takes them),
 * PackBits per channel. `channels`: [{ lens, data }] for R, G, B, A, transferred.
 */
async function psdPart(msg) {
    const t0 = now();
    const rgba = partRowsOf(msg);
    const packed = psdPackRows(rgba, msg.w, msg.rows);
    releaseIfLarge();
    const channels = packed.map((c) => ({ lens: c.lens.buffer, data: c.data.buffer }));
    return { channels, transfer: channels.flatMap((c) => [c.lens, c.data]), timing: { op: "psd_part", kernels: kernelsInUse(), pixels: msg.w * msg.rows, kernel: now() - t0 } };
}

/** CRC-32 and size of a blob (a zip entry of an ORA file). */
async function crcJob(msg) {
    const bytes = new Uint8Array(await msg.blob.arrayBuffer());
    return { crc: crc32(bytes), size: bytes.length };
}

/**
 * A PNG file read as a stream (inpaint_png.js `readPng`, docs/PLAN_BCE.md §E2): every band of rows goes back as a
 * `progress` message (`{ rgba, y0, rows }`, transferred) as soon as it is decoded, the reply carries the header. For a
 * picture no canvas can hold (above 268 MP), which the browser's own decoder cannot hand over.
 */
async function pngRead(msg) {
    const t0 = now();
    let header = null;
    const info = await readPng(msg.blob, {
        rowsPerBand: msg.rowsPerBand || TILE,
        onHeader: (h) => { header = h; self.postMessage({ id: msg.id, progress: true, header: h }); },
        onRows: (rgba, y0, rows) => { self.postMessage({ id: msg.id, progress: true, rgba: rgba.buffer, y0, rows }, [rgba.buffer]); },
    });
    return { width: info.width, height: info.height, texts: info.texts, header, timing: { op: "png_read", kernels: kernelsInUse(), pixels: info.width * info.height, kernel: now() - t0, unfilter: info.spent.unfilter, deliver: info.spent.deliver } };
}

/** The short SHA-1 of a blob (the name of an uploaded file). */
async function hashJob(msg) {
    return { hash: await hashOf(msg.blob) };
}

const exports_ = new Map();   // job id -> { writer, format }

/** An ImageBitmap as a 2D canvas; the bitmap is released right away. */
function canvasOf(bitmap) {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    return c;
}

/** Same short SHA-1 the editor uses to name uploaded files. */
async function hashOf(blob) {
    const digest = await crypto.subtle.digest("SHA-1", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest)).slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function png(bitmap, wantHash) {
    const blob = await canvasOf(bitmap).convertToBlob({ type: "image/png" });
    return { blob, hash: wantHash ? await hashOf(blob) : null };
}

/** grow / shrink / feather / invert, on the selection's pixels. */
async function selection(msg) {
    const t0 = now();
    const c = canvasOf(msg.bitmap);
    const W = c.width, H = c.height;
    let out = c;
    if (msg.kind === "feather") {
        out = new OffscreenCanvas(W, H);
        const octx = out.getContext("2d");
        octx.filter = `blur(${msg.radius}px)`;
        octx.drawImage(c, 0, 0);
        octx.filter = "none";
    } else if (msg.kind !== "invert" && msg.kind !== "grow") {
        throw new Error("unknown selection job " + msg.kind);
    }
    const ctx = out.getContext("2d");
    const img = ctx.getImageData(0, 0, W, H);
    const ms = { op: "selection", kind: msg.kind, kernels: kernelsInUse(), pixels: W * H, read: now() - t0 };
    // the editor would otherwise scan the whole selection for the bounds afterwards, on its own thread
    let bounds;
    if (msg.kind === "grow") {
        bounds = growMaskBounds(img.data, W, H, msg.n, { ms });
        const t = now();
        ctx.putImageData(img, 0, 0);
        ms.put = now() - t;
    } else {
        if (msg.kind === "invert") { invertMask(img.data); ctx.putImageData(img, 0, 0); }
        const tb = now();
        bounds = maskBounds(img.data, W, H);
        ms.resultBounds = now() - tb;
    }
    const bitmap = out.transferToImageBitmap();
    ms.total = now() - t0;
    return { bitmap, bounds, timing: ms };
}

/**
 * grow / shrink / feather on the selection's own tiles (docs/PLAN_BCE.md 3b, B item 3): `sel` is the mask as a store
 * (`storeRows`), the box `w` x `h` at (`x0`, `y0`) lies on the tile grid. The box is read from the tiles where they lie,
 * worked on, and cut into tiles again; only the tiles whose pixels changed go back, `{ tx, ty, data }` or
 * `{ tx, ty, empty: true }` for one that holds nothing any more. No canvas for grow and shrink; feather's blur is the
 * browser's, so it keeps one canvas here, but none on the main thread.
 */
async function selectionOverTiles(msg) {
    const t0 = now();
    const W = msg.w, H = msg.h, X0 = msg.x0 | 0, Y0 = msg.y0 | 0;
    let data = new Uint8ClampedArray(W * H * 4);
    storeRows(msg.sel, X0, W, Y0, H, data);
    const ms = { op: "selection", kind: msg.kind, kernels: kernelsInUse(), pixels: W * H, tiles: true, read: now() - t0 };
    let bounds;
    if (msg.kind === "grow") {
        bounds = growMaskBounds(data, W, H, msg.n, { ms });
    } else if (msg.kind === "feather") {
        const c = new OffscreenCanvas(W, H);
        c.getContext("2d").putImageData(new ImageData(data, W, H), 0, 0);
        // canvases of the default kind, as the job over a bitmap makes them: a CPU canvas blurs up to 7 levels differently
        const out = new OffscreenCanvas(W, H), octx = out.getContext("2d");
        octx.filter = `blur(${msg.radius}px)`;
        octx.drawImage(c, 0, 0);
        octx.filter = "none";
        data = octx.getImageData(0, 0, W, H).data;
        const tb = now();
        bounds = maskBounds(data, W, H);
        ms.resultBounds = now() - tb;
    } else throw new Error("unknown selection job " + msg.kind);
    const tc = now();
    const tiles = [], transfer = [];
    const d32 = new Uint32Array(data.buffer, data.byteOffset, W * H);
    const sx = msg.sel.x | 0, sy = msg.sel.y | 0;
    for (let ty = 0; ty * TILE < H; ty++) for (let tx = 0; tx * TILE < W; tx++) {
        const x0 = tx * TILE, y0 = ty * TILE, bw = Math.min(TILE, W - x0), bh = Math.min(TILE, H - y0);
        const row = msg.sel.tiles[(Y0 + y0 - sy) >> 8];
        const name = row ? row[(X0 + x0 - sx) >> 8] : null;
        const ob = name ? tileBytes(name).bytes : null;
        const old = ob ? new Uint32Array(ob.buffer, ob.byteOffset, TILE * TILE) : null;
        // whole pixels as words (little endian: the alpha is the top byte)
        let any = false, changed = false;
        for (let yy = 0; yy < bh && !(any && changed); yy++) {
            const o = (y0 + yy) * W + x0, so = yy * TILE;
            for (let i = 0; i < bw; i++) {
                const v = d32[o + i];
                if (v >>> 24) any = true;
                if (v !== (old ? old[so + i] : 0)) changed = true;
            }
        }
        if (!changed) continue;
        if (!any) { tiles.push({ tx, ty, empty: true }); continue; }
        const out = new Uint8ClampedArray(TILE * TILE * 4);
        for (let yy = 0; yy < bh; yy++) { const o = ((y0 + yy) * W + x0) * 4; out.set(data.subarray(o, o + bw * 4), yy * TILE * 4); }
        tiles.push({ tx, ty, data: out.buffer });
        transfer.push(out.buffer);
    }
    ms.cut = now() - tc;
    ms.total = now() - t0;
    return { tiles, bounds, transfer, timing: ms };
}

/**
 * The magic wand's and the bucket's region, as a shape in the requested colour. The bitmap
 * may be a box cut out of the image: `touches` says on which of its edges the region
 * arrives, so the editor can widen the box and ask again.
 */
async function flood(msg) {
    if (msg.sab) return floodOverTiles(msg);
    const t0 = now();
    const src = canvasOf(msg.bitmap);
    const W = src.width, H = src.height;
    const data = src.getContext("2d").getImageData(0, 0, W, H).data;
    const ms = { op: "flood", kernels: kernelsInUse(), pixels: W * H, read: now() - t0 };
    let t = now();
    const lap = (key) => { const n = now(); ms[key] = n - t; t = n; };
    const p = rustPx();
    if (p) {
        // one call for the flood, the clip, the count, the bounds and the shape, drawn from wasm memory without a copy
        const sel = msg.selBitmap ? canvasOf(msg.selBitmap).getContext("2d").getImageData(0, 0, W, H).data : null;
        lap("clip");
        const [r, g, b] = hexToRgb(msg.color || "#ff0000");
        const res = p.floodShape(data, W, H, msg.x, msg.y, msg.tolerance === undefined ? 32 : msg.tolerance, msg.contiguous !== false, sel, (r << 16) | (g << 8) | b, (view, count, bounds) => {
            lap("flood");
            const shape = new OffscreenCanvas(W, H);
            shape.getContext("2d").putImageData(new ImageData(view, W, H), 0, 0);
            lap("shape");
            return { count, bounds, bitmap: shape.transferToImageBitmap() };
        });
        releaseIfLarge();
        const bb = res.bounds;
        const touches = bb ? { l: bb[0] === 0, t: bb[1] === 0, r: bb[2] === W, b: bb[3] === H } : null;
        ms.total = now() - t0;
        return { bitmap: res.bitmap, count: res.count, bounds: bb, touches, timing: ms };
    }
    const mask = floodMask(data, W, H, msg.x, msg.y, msg.tolerance, msg.contiguous);
    lap("flood");
    if (msg.selBitmap) clipMaskToSelection(mask, canvasOf(msg.selBitmap));
    lap("clip");
    let count = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
            if (!mask[row + x]) continue;
            count++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
        }
    }
    lap("bounds");
    const shape = maskToColorCanvas(mask, W, H, msg.color || "#ff0000");
    lap("shape");
    const touches = x1 < 0 ? null : { l: x0 === 0, t: y0 === 0, r: x1 === W - 1, b: y1 === H - 1 };
    const bitmap = shape.transferToImageBitmap();
    ms.total = now() - t0;
    return { bitmap, count, bounds: x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1], touches, timing: ms };
}

/**
 * The flood over a picture the pool composited from tiles (`stack_into`), B item 2: `sab` holds the box's RGBA8, `w` x
 * `h`; `sel` is the selection as a store (the bucket's clip), read here from its tiles. No canvas on the way in. The
 * shape goes back as a bitmap (the bucket draws it into a layer), or with `out: "tiles"` as the tiles of the box that
 * hold any of it, `[{ tx, ty, data }]` of 256 x 256 RGBA8 each (the box starts on the tile grid, so they are the
 * selection's own tiles): the wand writes them into the mask without a canvas on the way out either.
 */
async function floodOverTiles(msg) {
    const p = rustPx();
    if (!p) throw new Error(NO_PARTS);
    const t0 = now();
    const W = msg.w, H = msg.h;
    const data = new Uint8Array(msg.sab, 0, W * H * 4);
    const ms = { op: "flood", kernels: "rust", pixels: W * H, tiles: true, read: 0 };
    let t = now();
    const lap = (key) => { const n = now(); ms[key] = n - t; t = n; };
    let sel = null;
    if (msg.sel) { sel = new Uint8Array(W * H * 4); storeRows(msg.sel, msg.x0 | 0, W, msg.y0 | 0, H, sel); }
    lap("clip");
    const [r, g, b] = hexToRgb(msg.color || "#ff0000");
    const res = p.floodShape(data, W, H, msg.x, msg.y, msg.tolerance === undefined ? 32 : msg.tolerance, msg.contiguous !== false, sel, (r << 16) | (g << 8) | b, (view, count, bounds) => {
        lap("flood");
        if (msg.out !== "tiles") {
            const shape = new OffscreenCanvas(W, H);
            shape.getContext("2d").putImageData(new ImageData(view, W, H), 0, 0);
            lap("shape");
            return { count, bounds, bitmap: shape.transferToImageBitmap() };
        }
        const tiles = [];
        if (bounds) {
            for (let ty = bounds[1] >> 8; ty * TILE < bounds[3]; ty++) for (let tx = bounds[0] >> 8; tx * TILE < bounds[2]; tx++) {
                const x0 = tx * TILE, y0 = ty * TILE, bw = Math.min(TILE, W - x0), bh = Math.min(TILE, H - y0);
                let any = false;
                for (let yy = 0; yy < bh && !any; yy++) { const o = ((y0 + yy) * W + x0) * 4 + 3; for (let xx = 0; xx < bw; xx++) if (view[o + xx * 4]) { any = true; break; } }
                if (!any) continue;
                const out = new Uint8ClampedArray(TILE * TILE * 4);
                for (let yy = 0; yy < bh; yy++) { const o = ((y0 + yy) * W + x0) * 4; out.set(view.subarray(o, o + bw * 4), yy * TILE * 4); }
                tiles.push({ tx, ty, data: out.buffer });
            }
        }
        lap("shape");
        return { count, bounds, tiles };
    });
    releaseIfLarge();
    const bb = res.bounds;
    const touches = bb ? { l: bb[0] === 0, t: bb[1] === 0, r: bb[2] === W, b: bb[3] === H } : null;
    ms.total = now() - t0;
    if (res.tiles) return { tiles: res.tiles, count: res.count, bounds: bb, touches, transfer: res.tiles.map((x) => x.data), timing: ms };
    return { bitmap: res.bitmap, count: res.count, bounds: bb, touches, timing: ms };
}

async function run(msg) {
    setKernels(msg.kernels);
    await kernelsReady();
    if (msg.op === "png") return png(msg.bitmap, !!msg.hash);
    if (msg.op === "selection") return msg.sel ? selectionOverTiles(msg) : selection(msg);
    if (msg.op === "flood") return flood(msg);
    if (msg.op === "mips") return mips(msg);
    if (msg.op === "band") return band(msg);
    if (msg.op === "png_part") return pngPart(msg);
    if (msg.op === "stack_into") return stackInto(msg);
    if (msg.op === "stack_points") return stackPoints(msg);
    if (msg.op === "hash") return hashJob(msg);
    if (msg.op === "psd_part") return psdPart(msg);
    if (msg.op === "png_read") return pngRead(msg);
    if (msg.op === "crc") return crcJob(msg);
    if (msg.op === "export_begin") {
        const opts = { width: msg.width, height: msg.height };
        exports_.set(msg.job, { format: msg.format, writer: msg.format === "psd" ? new PsdWriter(opts) : new OraWriter(opts) });
        return {};
    }
    if (msg.op === "export_layer") {
        const job = exports_.get(msg.job);
        if (!job) throw new Error("unknown export job");
        await job.writer.layer(msg.meta, canvasOf(msg.bitmap));
        return {};
    }
    if (msg.op === "export_finish") {
        const job = exports_.get(msg.job);
        if (!job) throw new Error("unknown export job");
        exports_.delete(msg.job);
        return { blob: await job.writer.finish(canvasOf(msg.bitmap)) };
    }
    if (msg.op === "export_cancel") {
        exports_.delete(msg.job);
        return {};
    }
    throw new Error("unknown job " + msg.op);
}

// ComfyUI imports every .js of the node's js/ into its page as an extension, this file too.
// There `self` is the window: a handler on it would answer any message posted to the page
// with an error posted to the page, which it receives again, forever. Only a worker listens.
const inWorker = typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;
if (inWorker) self.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.op === "arena") { arenaMessage(msg); return; }
    try {
        const result = await run(msg);
        // an ImageBitmap in the reply is transferred, never copied, and so are the buffers a job names in `transfer`
        const transfer = result && result.transfer ? result.transfer : result && result.bitmap ? [result.bitmap] : [];
        if (result) delete result.transfer;
        self.postMessage({ id: msg.id, ok: true, ...result }, transfer);
    } catch (err) {
        // a bitmap that was transferred but never drawn would leak until the worker dies
        for (const k of ["bitmap", "selBitmap"]) { try { if (msg[k] && msg[k].close) msg[k].close(); } catch (_) { /* ignore */ } }
        self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
    }
};
