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
import { pngChunk, crc32, PNG_LEVEL, NO_PARTS } from "./inpaint_png.js";
import { mipChain, mipChainBytes, clampExtend, compositeTile, psdPackRows, kernelsReady, setKernels, rustPx, kernelsInUse, releaseIfLarge } from "./px/kernels.js";

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
 * One part of a PNG's pixels (inpaint_png.js, docs/PLAN_BCE.md §E2): rows as bytes (`rgba`, `prev`) or as tiles
 * (`tiles`, `prevTiles`, `r0`), filtered and deflated by the Rust kernel, as a finished IDAT chunk.
 */
async function pngPart(msg) {
    const p = rustPx();
    if (!p) throw new Error(NO_PARTS);
    const t0 = now();
    const rgba = msg.rgba ? new Uint8Array(msg.rgba, 0, msg.w * msg.rows * 4) : rowsOfTiles(msg);
    const prev = msg.rgba ? (msg.prev ? new Uint8Array(msg.prev, 0, msg.w * 4) : null) : rowsOfTiles(msg, true);
    const r = p.pngPart(rgba, msg.w, msg.rows, prev, msg.level === undefined ? PNG_LEVEL : msg.level, !!msg.last);
    releaseIfLarge();
    const chunk = pngChunk("IDAT", r.bytes);
    return { chunk: chunk.buffer, adler: r.adler, raw: r.raw, transfer: [chunk.buffer], timing: { op: "png_part", kernels: "rust", pixels: msg.w * msg.rows, kernel: now() - t0 } };
}

/**
 * One part of a PSD's channel data (docs/PLAN_BCE.md §E4): rows as bytes or as tiles (as `png_part` takes them),
 * PackBits per channel. `channels`: [{ lens, data }] for R, G, B, A, transferred.
 */
async function psdPart(msg) {
    const t0 = now();
    const rgba = msg.rgba ? new Uint8Array(msg.rgba, 0, msg.w * msg.rows * 4) : rowsOfTiles(msg);
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
 * The magic wand's and the bucket's region, as a shape in the requested colour. The bitmap
 * may be a box cut out of the image: `touches` says on which of its edges the region
 * arrives, so the editor can widen the box and ask again.
 */
async function flood(msg) {
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

async function run(msg) {
    setKernels(msg.kernels);
    await kernelsReady();
    if (msg.op === "png") return png(msg.bitmap, !!msg.hash);
    if (msg.op === "selection") return selection(msg);
    if (msg.op === "flood") return flood(msg);
    if (msg.op === "mips") return mips(msg);
    if (msg.op === "band") return band(msg);
    if (msg.op === "png_part") return pngPart(msg);
    if (msg.op === "hash") return hashJob(msg);
    if (msg.op === "psd_part") return psdPart(msg);
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
