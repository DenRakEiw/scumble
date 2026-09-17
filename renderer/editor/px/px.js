/**
 * Loader and memory helpers for the px kernels (crates/px, docs/PLAN_BCE.md §B1).
 *
 * The module exports plain functions over its linear memory; nothing here is generated.
 * One instance per thread, own memory each, no shared wasm memory. A kernel call is: take
 * in and out blocks from an arena, one `set`, one call, one `subarray` (or a copy) out.
 *
 * The classic wasm bug is a stale view: `memory.buffer` changes identity whenever memory
 * grows, and every typed array made over the old buffer is detached (length 0). `px.u8()`,
 * `px.f32()` and `px.u32()` check the identity and re-create the view, so call them after
 * anything that could have allocated, never keep one across `alloc` / `take`.
 */

export const PX_ABI = 9;

// arithmetic, not `& -n`: sizes above 2 GB do not survive a 32-bit bitwise operator
const roundUp = (n, to) => Math.ceil(n / to) * to;

/**
 * Instantiate a px module. `source` is a URL (fetched), a `Response`, bytes (an
 * `ArrayBuffer` or a view) or a compiled `WebAssembly.Module` (what a worker is posted).
 */
export async function loadPx(source) {
    let module;
    if (source instanceof WebAssembly.Module) module = source;
    else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) module = await WebAssembly.compile(source);
    else {
        const res = typeof Response !== "undefined" && source instanceof Response ? source : await fetch(source);
        if (!res.ok) throw new Error(`px: ${res.status} for ${res.url}`);
        module = await WebAssembly.compile(await res.arrayBuffer());
    }
    const instance = await WebAssembly.instantiate(module, {});
    return new Px(instance, module);
}

export class Px {
    constructor(instance, module) {
        this.instance = instance;
        this.module = module;
        this.exports = instance.exports;
        this.memory = instance.exports.memory;
        const abi = this.exports.px_abi_version();
        if (abi !== PX_ABI) throw new Error(`px: module ABI ${abi}, this loader speaks ${PX_ABI}`);
        this.simd = this.exports.px_simd() === 1;
        this._buf = null;
        this._u8 = this._f32 = this._u32 = null;
    }

    _views() {
        const buf = this.memory.buffer;
        if (buf !== this._buf) {
            this._buf = buf;
            this._u8 = new Uint8Array(buf);
            this._f32 = new Float32Array(buf);
            this._u32 = new Uint32Array(buf);
        }
    }

    /** The whole memory as bytes, re-created after growth. */
    u8() { this._views(); return this._u8; }
    f32() { this._views(); return this._f32; }
    u32() { this._views(); return this._u32; }

    /** Bytes currently reserved by the instance's memory. */
    get byteLength() { return this.memory.buffer.byteLength; }

    /** A block of `bytes` (8-aligned). Throws when memory cannot grow any further. */
    alloc(bytes) {
        if (!(bytes > 0)) return 0;
        const ptr = this.exports.px_alloc(bytes) >>> 0;   // pointers above 2 GB come back negative
        if (!ptr) throw new Error(`px: out of memory allocating ${bytes} bytes`);
        return ptr;
    }

    free(ptr, bytes) {
        if (ptr && bytes > 0) this.exports.px_free(ptr, bytes);
    }

    /** Copy a typed array (any element type) into memory at `ptr`, byte for byte. */
    put(ptr, data) {
        this.u8().set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), ptr);
    }

    /** A view of `length` elements of `Type` at `ptr`; valid until the next allocation. */
    view(Type, ptr, length) {
        this._views();
        return new Type(this._buf, ptr, length);
    }

    /** A copy of `length` elements of `Type` at `ptr` into `into` (allocated when absent). */
    get(Type, ptr, length, into = new Type(length)) {
        into.set(this.view(Type, ptr, length));
        return into;
    }

    arena(chunkBytes = 1 << 20) {
        return new PxArena(this, chunkBytes);
    }

    // ---- kernels: the signatures of kernels_js.js, one copy in and one copy out ----------------
    // Each call takes its blocks from one job arena and resets it afterwards. For data that
    // already lives in wasm memory, call `px.exports.<kernel>` with pointers instead.

    get job() {
        return this._job || (this._job = this.arena(1 << 20));
    }

    _in(arena, data, bytes = data.byteLength) {
        const ptr = arena.take(bytes);
        this.u8().set(new Uint8Array(data.buffer, data.byteOffset, bytes), ptr);
        return ptr;
    }

    _out(Type, ptr, length, out) {
        const into = out || new Type(length);
        into.set(this.view(Type, ptr, length));
        return into;
    }

    mipHalf(src, sw, sh, dst = null) {
        const a = this.job, n = (sw >> 1) * (sh >> 1) * 4;
        try {
            const ps = this._in(a, src, sw * sh * 4), pd = a.take(n);
            this.exports.mip_half(ps, sw, sh, pd);
            return this._out(Uint8Array, pd, n, dst);
        } finally { a.reset(); }
    }

    mipChain(src, size, levels, out = null) {
        const a = this.job, n = this.exports.mip_chain_bytes(size, levels);
        try {
            const ps = this._in(a, src, size * size * 4), po = a.take(n);
            this.exports.mip_chain(ps, size, levels, po);
            return this._out(Uint8Array, po, n, out);
        } finally { a.reset(); }
    }

    /** In place, like kernels_js `clampExtend`. */
    clampExtend(bytes, size, vw, vh) {
        const a = this.job, n = size * size * 4;
        try {
            const pb = this._in(a, bytes, n);
            this.exports.clamp_extend(pb, size, vw, vh);
            return this._out(Uint8Array, pb, n, new Uint8Array(bytes.buffer, bytes.byteOffset, n));
        } finally { a.reset(); }
    }

    /**
     * The row filters of `rows` PNG lines undone (kernels_js.js `pngUnfilterRows`): `lines` in place, or with `rgba`
     * (`{ w, channels, out }`, 8-bit RGB or RGBA) the rows straight into `out` as RGBA8 and `lines` left as they were.
     * `prev` becomes the last row. Returns the lines undone.
     */
    pngUnfilterRows(lines, rows, rowBytes, bpp, prev, rgba = null) {
        const a = this.job, n = rows * (rowBytes + 1);
        try {
            const pl = this._in(a, lines, n), pp = this._in(a, prev, rowBytes);
            const po = rgba ? a.take(rows * rgba.w * 4) : 0;
            const done = this.exports.png_unfilter_rows(pl, rows, rowBytes, bpp, pp, rgba ? rgba.w : 0, rgba ? rgba.channels : 0, po);
            if (done === rows) {
                if (rgba) rgba.out.set(this.view(Uint8Array, po, rows * rgba.w * 4));
                else lines.set(this.view(Uint8Array, pl, n));
                prev.set(this.view(Uint8Array, pp, rowBytes));
            }
            return done;
        } finally { a.reset(); }
    }

    /** Square dilation of a w x h Float32Array by r pixels; a new array. */
    dilateMask(data, w, h, r) {
        const a = this.job, n = w * h;
        try {
            const pd = this._in(a, data, n * 4);
            this.exports.dilate_mask(pd, w, h, r);
            return this._out(Float32Array, pd, n, null);
        } finally { a.reset(); }
    }

    /** Box blurs of up to three radii (rows then columns each) over a w x h Float32Array; a new array. */
    boxBlurs(data, w, h, radii) {
        const a = this.job, n = w * h;
        try {
            const pd = this._in(a, data, n * 4);
            this.exports.box_blurs(pd, w, h, radii[0] | 0, radii[1] | 0, radii[2] | 0);
            return this._out(Float32Array, pd, n, null);
        } finally { a.reset(); }
    }

    distTransform(feature, w, h, out = null) {
        const a = this.job, n = w * h;
        try {
            const pf = this._in(a, feature, n), po = a.take(n * 4), pt = a.take(this.exports.dist_scratch_bytes(w, h));
            this.exports.dist_transform(pf, w, h, po, pt);
            return this._out(Float32Array, po, n, out);
        } finally { a.reset(); }
    }

    flood(rgba, w, h, sx, sy, tolerance = 32, contiguous = true, out = null) {
        const a = this.job, n = w * h;
        let pairs = Math.max(4096, n >> 4);
        try {
            const pr = this._in(a, rgba, n * 4), po = a.take(n);
            for (;;) {
                const pstack = a.take(pairs * 8);
                const count = this.exports.flood(pr, w, h, sx, sy, tolerance, contiguous ? 1 : 0, po, pstack, pairs);
                if (count >= 0) {
                    const mask = this._out(Uint8Array, po, n, out);
                    mask.count = count;
                    return mask;
                }
                pairs *= 2;
            }
        } finally { a.reset(); }
    }

    /**
     * `growMask` and `maskBounds` of the result in one call: the selection `d` (RGBA8) grown or shrunk in place.
     * Returns the result's bounds [x0, y0, x1, y1] or null.
     */
    growMask(d, w, h, n) {
        const a = this.job, bytes = w * h * 4;
        try {
            const pd = this._in(a, d, bytes), pb = a.take(16);
            const any = this.exports.grow_mask(pd, w, h, n, pb);
            this._out(Uint8Array, pd, bytes, new Uint8Array(d.buffer, d.byteOffset, bytes));
            if (!any) return null;
            const b = this.view(Int32Array, pb, 4);
            return [b[0], b[1], b[2], b[3]];
        } finally { a.reset(); }
    }

    /**
     * The flood job: the region around (sx, sy) clipped to `sel` (RGBA8 or null), drawn as the colour `rgb`
     * (0xRRGGBB). `use(view, count, bounds)` gets the shape as a Uint8ClampedArray over wasm memory (valid only inside
     * the call: an ImageData over it goes to putImageData without a copy) and its result is returned.
     */
    floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use) {
        const a = this.job, bytes = w * h * 4;
        let pairs = Math.max(4096, (w * h) >> 4);
        try {
            const pr = this._in(a, rgba, bytes), ps = sel ? this._in(a, sel, bytes) : 0, pi = a.take(20);
            for (;;) {
                const pst = a.take(pairs * 8);
                if (this.exports.flood_shape(pr, w, h, sx | 0, sy | 0, Math.max(0, tolerance | 0), contiguous ? 1 : 0, ps, rgb >>> 0, pst, pairs, pi) >= 0) break;
                pairs *= 2;
            }
            const info = this.view(Int32Array, pi, 5);
            const bounds = info[3] < 0 ? null : [info[1], info[2], info[3], info[4]];
            return use(new Uint8ClampedArray(this.memory.buffer, pr, bytes), info[0], bounds);
        } finally { a.reset(); }
    }

    compositeTile(dst, srcs, ops, alphas, masks = null) {
        const a = this.job, px = dst.byteLength >> 2, n = srcs.length;
        try {
            const pd = this._in(a, dst);
            const psrcs = a.take(4 * n), pmasks = a.take(4 * n), pops = a.take(n), palphas = a.take(n);
            const sp = [], mp = [];
            for (let i = 0; i < n; i++) {
                sp.push(this._in(a, srcs[i], px * 4));
                mp.push(masks && masks[i] ? this._in(a, masks[i], px) : 0);
            }
            const u32 = this.u32(), u8 = this.u8();
            for (let i = 0; i < n; i++) {
                u32[(psrcs >>> 2) + i] = sp[i];
                u32[(pmasks >>> 2) + i] = mp[i];
                u8[pops + i] = ops[i];
                u8[palphas + i] = alphas[i];
            }
            this.exports.composite_tile(pd, px, n, psrcs, pops, palphas, pmasks);
            return this._out(Uint8Array, pd, px * 4, dst);
        } finally { a.reset(); }
    }

    pngFilterRows(rgba, w, rows, prev = null, out = null) {
        const a = this.job, n = rows * (1 + 4 * w);
        try {
            const pr = this._in(a, rgba, rows * 4 * w), pp = prev ? this._in(a, prev, 4 * w) : 0, po = a.take(n);
            this.exports.png_filter_rows(pr, w, rows, pp, po);
            return this._out(Uint8Array, po, n, out);
        } finally { a.reset(); }
    }

    /**
     * PackBits of the four channels of `rows` rows of RGBA8 for a PSD (docs/PLAN_BCE.md §E4), the bytes of
     * inpaint_export.js `packBits`: `[{ lens, data }]` for R, G, B, A, `lens` each row's packed length as big-endian
     * u16 (the table a PSD puts in front of a channel), `data` the packed rows one after the other. Copies.
     */
    psdPackRows(rgba, w, rows) {
        const a = this.job;
        try {
            const pr = this._in(a, rgba, rows * 4 * w);
            const cap = this.exports.psd_pack_rows_cap(w, rows), po = a.take(cap), pl = a.take(rows * 2);
            const out = [];
            for (let ch = 0; ch < 4; ch++) {
                const n = this.exports.psd_pack_rows(pr, w, rows, ch, po, cap, pl);
                if (n < 0) throw new Error("px: psd_pack_rows ran out of room");
                out.push({ lens: this.u8().slice(pl, pl + rows * 2), data: this.u8().slice(po, po + n) });
            }
            return out;
        } finally { a.reset(); }
    }

    /**
     * One part of a PNG's zlib stream (docs/PLAN_BCE.md §E2): `rows` rows of RGBA8 filtered (`pngFilterRows`) and
     * deflated raw at `level`, every part but the `last` ending on a sync flush, so the parts of a picture are one
     * deflate stream when written one after the other. `{ bytes, adler, raw }`: the deflated part (a copy), the
     * Adler-32 of its `raw` filtered bytes alone (joined by `adlerCombine`).
     */
    pngPart(rgba, w, rows, prev, level, last) {
        const a = this.job, n = rows * (1 + 4 * w);
        try {
            const pr = this._in(a, rgba, rows * 4 * w), pp = prev ? this._in(a, prev, 4 * w) : 0, pf = a.take(n);
            this.exports.png_filter_rows(pr, w, rows, pp, pf);
            const adler = this.exports.adler32(pf, n, 1) >>> 0;
            // stored blocks are the worst case: 5 bytes per 64 KB, and the flush's own
            let cap = n + Math.ceil(n / 65535) * 5 + 64;
            for (;;) {
                const po = a.take(cap);
                const written = this.exports.deflate_part(pf, n, level, last ? 1 : 0, po, cap);
                if (written >= 0) return { bytes: this.u8().slice(po, po + written), adler, raw: n };
                cap *= 2;
            }
        } finally { a.reset(); }
    }
}

/**
 * A bump allocator on top of `px_alloc` for one job: `take(bytes)` per buffer, `reset()`
 * when the job is done. The first chunk is kept across resets (grown to the largest job
 * seen), so a steady stream of same-sized jobs allocates once.
 */
export class PxArena {
    constructor(px, chunkBytes = 1 << 20) {
        this.px = px;
        this.chunkBytes = chunkBytes;
        this.chunks = [];          // { ptr, size, used }
        this.peak = 0;
        this.jobBytes = 0;
    }

    // blocks of 16 KB and more start on a page, like px_alloc's: a tile copied between a JS
    // buffer and a block 8 bytes past a page start hits 4K aliasing (16x slower copies)
    take(bytes, align = bytes >= 16 * 1024 ? 4096 : 8) {
        if (!(bytes > 0)) return 0;
        this.jobBytes += roundUp(bytes, align) + align;   // room for the padding in front, too
        for (const c of this.chunks) {
            const at = roundUp(c.used, align);
            if (at + bytes <= c.size) {
                c.used = at + bytes;
                return c.ptr + at;
            }
        }
        const size = Math.max(this.chunkBytes, roundUp(bytes, 8));
        const ptr = this.px.alloc(size);
        this.chunks.push({ ptr, size, used: bytes });
        return ptr;
    }

    /** Forget every block of the job. Extra chunks are freed; one chunk that fits the job stays. */
    reset() {
        this.peak = Math.max(this.peak, this.jobBytes);
        this.jobBytes = 0;
        if (this.chunks.length > 1) {
            for (const c of this.chunks) this.px.free(c.ptr, c.size);
            this.chunks = [];
            const size = Math.max(this.chunkBytes, roundUp(this.peak, 8));
            this.chunks.push({ ptr: this.px.alloc(size), size, used: 0 });
        } else if (this.chunks.length) {
            this.chunks[0].used = 0;
        }
    }

    dispose() {
        for (const c of this.chunks) this.px.free(c.ptr, c.size);
        this.chunks = [];
    }
}
