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
 *   band            a row of tiles composited, layer over layer (`compositeTile`): no caller in
 *                   the editor yet; phase R measures the kernel phase E's band export will run.
 *
 * Pixels arrive as ImageBitmaps (transferred, never copied through structured cloning) and
 * are closed as soon as they are drawn. Every reply carries the request's id; a failure
 * comes back as { ok: false, error } and the editor falls back to the main thread.
 *
 * `kernels: "rust"` on a mips, selection or flood job runs its pixel kernel from px/px.wasm
 * (loaded once per worker) instead of the JS one, the measurement of phase R
 * (docs/PLAN_BCE.md §2b). Those jobs reply with `timing`: the milliseconds of their parts.
 */
import { PsdWriter, OraWriter } from "./inpaint_export.js";
import { floodMask, maskToColorCanvas, clipMaskToSelection, growMask, invertMask, maskBounds } from "./inpaint_raster.js";
import { mipChain, mipChainBytes, clampExtend, compositeTile } from "./px/kernels_js.js";

const TILE = 256, LEVELS = 5;
const now = () => performance.now();

let PX = null;
/**
 * The Rust kernels of this worker, instantiated on the first job that asks for them. The loader is imported only then:
 * the node's build carries neither it nor the module (tools/build_node.py).
 */
function rustKernels() {
    if (!PX) PX = import("./px/px.js").then(({ loadPx }) => loadPx(new URL("./px/px.wasm", import.meta.url))).catch((err) => { PX = null; throw err; });
    return PX;
}

/**
 * The mip chains of a batch of tiles (docs/PLAN_BCE.md §C6 b): each tile's bytes (a copy, transferred) give
 * its chain, and an edge tile (valid part vw x vh below 256) also the chain of its clamp-extended bytes, which
 * is what the atlas and the region canvases draw. The same kernels the main thread runs, so the bytes are the
 * ones it would build. The chains and the tile buffers go back transferred (the buffers for the next batch).
 */
async function mips(msg) {
    const p = msg.kernels === "rust" ? await rustKernels() : null;
    const t0 = now();
    const out = p ? mipsRust(p, msg) : mipsJs(msg);
    out.timing = { op: "mips", kernels: p ? "rust" : "js", tiles: msg.tiles.length, kernel: now() - t0 };
    return out;
}

function mipsJs(msg) {
    const n = mipChainBytes(TILE, LEVELS);
    const chains = [], exts = [], datas = [], transfer = [];
    for (const t of msg.tiles) {
        const bytes = new Uint8Array(t.data);
        const chain = mipChain(bytes, TILE, LEVELS, new Uint8Array(n));
        chains.push(chain.buffer);
        transfer.push(chain.buffer);
        if (t.vw < TILE || t.vh < TILE) {
            clampExtend(bytes, TILE, t.vw, t.vh);
            const ext = mipChain(bytes, TILE, LEVELS, new Uint8Array(n));
            exts.push(ext.buffer);
            transfer.push(ext.buffer);
        } else {
            exts.push(null);
        }
        datas.push(t.data);
        transfer.push(t.data);
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
            p.u8().set(new Uint8Array(t.data, 0, TILE * TILE * 4), pin);
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
            datas.push(t.data);
            transfer.push(t.data);
        }
    } finally { a.reset(); }
    return { chains, exts, datas, transfer };
}

/**
 * A row of tiles composited (docs/PLAN_BCE.md §2b, E2): `columns` of { dst, srcs: [ArrayBuffer], masks: [ArrayBuffer or
 * null] }, the same `ops` and `alphas` for every column. Each dst comes back composited, transferred.
 */
async function band(msg) {
    const p = msg.kernels === "rust" ? await rustKernels() : null;
    const t0 = now();
    const transfer = [];
    for (const col of msg.columns) {
        const dst = new Uint8Array(col.dst);
        const srcs = col.srcs.map((b) => new Uint8Array(b)), masks = col.masks.map((b) => (b ? new Uint8Array(b) : null));
        if (p) p.compositeTile(dst, srcs, msg.ops, msg.alphas, masks);
        else compositeTile(dst, srcs, msg.ops, msg.alphas, masks);
        transfer.push(col.dst);
    }
    return { dsts: transfer, transfer, timing: { op: "band", kernels: p ? "rust" : "js", tiles: msg.columns.length, kernel: now() - t0 } };
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
    const p = msg.kernels === "rust" && msg.kind === "grow" ? await rustKernels() : null;
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
    const ms = { op: "selection", kind: msg.kind, kernels: p ? "rust" : "js", pixels: W * H, read: now() - t0 };
    if (msg.kind === "invert") { invertMask(img.data); ctx.putImageData(img, 0, 0); }
    else if (msg.kind === "grow") {
        growMask(img.data, W, H, msg.n, { ms, dist: p ? (f, w, h) => p.distTransform(f, w, h) : undefined });
        const t = now();
        ctx.putImageData(img, 0, 0);
        ms.put = now() - t;
    }
    // the editor would otherwise scan the whole selection for this afterwards, on its own thread
    const tb = now();
    const bounds = maskBounds(img.data, W, H);
    ms.resultBounds = now() - tb;
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
    const p = msg.kernels === "rust" ? await rustKernels() : null;
    const t0 = now();
    const src = canvasOf(msg.bitmap);
    const W = src.width, H = src.height;
    const data = src.getContext("2d").getImageData(0, 0, W, H).data;
    const ms = { op: "flood", kernels: p ? "rust" : "js", pixels: W * H, read: now() - t0 };
    let t = now();
    const lap = (key) => { const n = now(); ms[key] = n - t; t = n; };
    const mask = p ? p.flood(data, W, H, msg.x | 0, msg.y | 0, Math.max(0, msg.tolerance | 0), msg.contiguous)
        : floodMask(data, W, H, msg.x, msg.y, msg.tolerance, msg.contiguous);
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
    if (msg.op === "png") return png(msg.bitmap, !!msg.hash);
    if (msg.op === "selection") return selection(msg);
    if (msg.op === "flood") return flood(msg);
    if (msg.op === "mips") return mips(msg);
    if (msg.op === "band") return band(msg);
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
