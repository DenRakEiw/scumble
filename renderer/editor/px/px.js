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

export const PX_ABI = 1;

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

    /** A zlib stream (miniz_oxide) of `bytes` at `level`; resolves like kernels_js `deflate`. */
    deflate(bytes, level = 6) {
        const a = this.job;
        let cap = bytes.byteLength + (bytes.byteLength >> 8) + 1024;
        try {
            const pi = this._in(a, bytes);
            for (;;) {
                const po = a.take(cap);
                const written = this.exports.deflate_zlib(pi, bytes.byteLength, po, cap, level);
                if (written >= 0) return this._out(Uint8Array, po, written, null);
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
