/**
 * The JS twins of the px kernels (crates/px, docs/PLAN_BCE.md §B2): the same signatures
 * over typed arrays and the same bytes out. They are what phase C ships if the Rust kernels
 * do not clear the 3× rule, so they are written to be fast JavaScript, not to be short.
 * `tools/px_test.js` holds each to its Rust counterpart and to the editor's current code.
 *
 * Every function takes its output buffer as the last argument (allocated when absent) and
 * returns it. The formulas are integer maths and are spelled out in the Rust sources.
 */

export const OPS = Object.freeze({
    "source-over": 0,
    "destination-out": 1,
    "source-atop": 2,
    "destination-in": 3,
    copy: 4,
});

// ---- mips ------------------------------------------------------------------------------------

/**
 * RGBA8 `src` (sw × sh, straight alpha) halved into `dst` ((sw >> 1) × (sh >> 1)): a 2×2
 * box weighted by alpha, colour 0 where all four samples are transparent.
 */
export function mipHalf(src, sw, sh, dst = new Uint8Array((sw >> 1) * (sh >> 1) * 4)) {
    const ow = sw >> 1, oh = sh >> 1, stride = sw * 4;
    let o = 0;
    for (let y = 0; y < oh; y++) {
        let i = 2 * y * stride, j = i + stride;
        for (let x = 0; x < ow; x++, i += 8, j += 8, o += 4) {
            const a0 = src[i + 3], a1 = src[i + 7], a2 = src[j + 3], a3 = src[j + 7];
            const a = a0 + a1 + a2 + a3;
            if (a === 1020) {
                dst[o] = (src[i] + src[i + 4] + src[j] + src[j + 4] + 2) >> 2;
                dst[o + 1] = (src[i + 1] + src[i + 5] + src[j + 1] + src[j + 5] + 2) >> 2;
                dst[o + 2] = (src[i + 2] + src[i + 6] + src[j + 2] + src[j + 6] + 2) >> 2;
                dst[o + 3] = 255;
            } else if (a === 0) {
                dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0; dst[o + 3] = 0;
            } else {
                const h = a >> 1;
                dst[o] = ((src[i] * a0 + src[i + 4] * a1 + src[j] * a2 + src[j + 4] * a3 + h) / a) | 0;
                dst[o + 1] = ((src[i + 1] * a0 + src[i + 5] * a1 + src[j + 1] * a2 + src[j + 5] * a3 + h) / a) | 0;
                dst[o + 2] = ((src[i + 2] * a0 + src[i + 6] * a1 + src[j + 2] * a2 + src[j + 6] * a3 + h) / a) | 0;
                dst[o + 3] = (a + 2) >> 2;
            }
        }
    }
    return dst;
}

export function mipChainBytes(size, levels) {
    let n = 0;
    for (let l = 1; l <= levels; l++) n += (size >> l) * (size >> l) * 4;
    return n;
}

/** The `levels` mips of a square tile, largest first, one after the other in `out`. */
export function mipChain(src, size, levels, out = new Uint8Array(mipChainBytes(size, levels))) {
    let s = size, offset = 0, prev = src;
    for (let l = 0; l < levels; l++) {
        const n = (s >> 1) * (s >> 1) * 4;
        if (!n) break;
        const dst = out.subarray(offset, offset + n);
        mipHalf(prev, s, s, dst);
        prev = dst;
        offset += n;
        s >>= 1;
    }
    return out;
}

// ---- distance transform ------------------------------------------------------------------------

const INF = Math.fround(1e20);
const FAR = 1e9;

/** Scratch arrays for `distTransform`, reusable across calls of the same or smaller size. */
export function distScratch(w, h) {
    const n = Math.max(w, h);
    return { n, w, f: new Float32Array(n), d: new Float32Array(n), v: new Int32Array(n), z: new Float32Array(n + 1), col: new Float32Array(w) };
}

/**
 * Squared distance of every pixel to the nearest non-zero byte of `feature` (w × h), 1e20
 * where there is none. Columns by two sweeps, rows by Felzenszwalb's lower envelope with
 * the number types of `distanceTransform` in inpaint_raster.js.
 */
export function distTransform(feature, W, H, out = new Float32Array(W * H), scratch = null) {
    if (!scratch || scratch.n < Math.max(W, H) || scratch.w < W) scratch = distScratch(W, H);
    const { f, d, v, z, col } = scratch;
    col.fill(FAR, 0, W);
    for (let y = 0, row = 0; y < H; y++, row += W) {
        for (let x = 0; x < W; x++) {
            const t = feature[row + x] !== 0 ? 0 : col[x] + 1;
            col[x] = t;
            out[row + x] = t;
        }
    }
    col.fill(FAR, 0, W);
    for (let y = H - 1, row = (H - 1) * W; y >= 0; y--, row -= W) {
        for (let x = 0; x < W; x++) {
            const t = feature[row + x] !== 0 ? 0 : col[x] + 1;
            col[x] = t;
            const o = out[row + x];
            const m = o < t ? o : t;
            out[row + x] = m >= 1e8 ? INF : m * m;
        }
    }
    for (let y = 0, row = 0; y < H; y++, row += W) {
        for (let x = 0; x < W; x++) f[x] = out[row + x];
        let k = 0;
        v[0] = 0; z[0] = -INF; z[1] = INF;
        for (let q = 1; q < W; q++) {
            const fq = f[q] + q * q;
            let vk = v[k];
            let s = (fq - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
            while (s <= z[k]) {
                k--;
                vk = v[k];
                s = (fq - (f[vk] + vk * vk)) / (2 * q - 2 * vk);
            }
            k++;
            v[k] = q; z[k] = s; z[k + 1] = INF;
        }
        k = 0;
        for (let q = 0; q < W; q++) {
            while (z[k + 1] < q) k++;
            const vk = v[k];
            d[q] = (q - vk) * (q - vk) + f[vk];
        }
        for (let x = 0; x < W; x++) out[row + x] = d[x];
    }
    return out;
}

// ---- flood -------------------------------------------------------------------------------------

/**
 * Pixels similar to the seed (largest channel difference, alpha included, ≤ tolerance) as
 * 1 / 0 in `out`: 4-connected from the seed by a scanline fill, or every similar pixel.
 * The same set as `floodMask` in inpaint_raster.js. `out.count` is the pixels set.
 */
export function flood(data, W, H, sx, sy, tolerance = 32, contiguous = true, out = new Uint8Array(W * H)) {
    out.fill(0, 0, W * H);
    sx = Math.max(0, Math.min(W - 1, sx | 0));
    sy = Math.max(0, Math.min(H - 1, sy | 0));
    const i0 = (sy * W + sx) * 4;
    const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2], a0 = data[i0 + 3];
    const tol = Math.max(0, Math.min(255, tolerance | 0));
    let count = 0;
    if (!contiguous) {
        for (let p = 0, i = 0, n = W * H; p < n; p++, i += 4) {
            if (Math.abs(data[i] - r0) <= tol && Math.abs(data[i + 1] - g0) <= tol && Math.abs(data[i + 2] - b0) <= tol && Math.abs(data[i + 3] - a0) <= tol) {
                out[p] = 1;
                count++;
            }
        }
        out.count = count;
        return out;
    }
    let stack = new Int32Array(Math.max(4096, (W * H) >> 3));
    let sp = 0;
    stack[sp++] = sx; stack[sp++] = sy;
    while (sp > 0) {
        const y = stack[--sp], x = stack[--sp];
        const row = y * W;
        let p = row + x;
        if (out[p] || !similarAt(data, p * 4, r0, g0, b0, a0, tol)) continue;
        let xl = x, xr = x;
        while (xl > 0 && !out[p - 1] && similarAt(data, (p - 1) * 4, r0, g0, b0, a0, tol)) { xl--; p--; }
        p = row + x;
        while (xr < W - 1 && !out[p + 1] && similarAt(data, (p + 1) * 4, r0, g0, b0, a0, tol)) { xr++; p++; }
        out.fill(1, row + xl, row + xr + 1);
        count += xr - xl + 1;
        for (let pass = 0; pass < 2; pass++) {
            const ny = pass === 0 ? y - 1 : y + 1;
            if (ny < 0 || ny >= H) continue;
            const nrow = ny * W;
            let inSpan = false;
            for (let i = xl; i <= xr; i++) {
                const q = nrow + i;
                const ok = !out[q] && similarAt(data, q * 4, r0, g0, b0, a0, tol);
                if (ok && !inSpan) {
                    if (sp + 2 > stack.length) {
                        const grown = new Int32Array(stack.length * 2);
                        grown.set(stack);
                        stack = grown;
                    }
                    stack[sp++] = i; stack[sp++] = ny;
                    inSpan = true;
                } else if (!ok) inSpan = false;
            }
        }
    }
    out.count = count;
    return out;
}

function similarAt(d, i, r0, g0, b0, a0, tol) {
    let e = d[i] - r0; if (e < 0) e = -e; if (e > tol) return false;
    e = d[i + 1] - g0; if (e < 0) e = -e; if (e > tol) return false;
    e = d[i + 2] - b0; if (e < 0) e = -e; if (e > tol) return false;
    e = d[i + 3] - a0; if (e < 0) e = -e;
    return e <= tol;
}

// ---- composite ---------------------------------------------------------------------------------

/**
 * `srcs.length` straight-alpha RGBA8 sources over the tile `dst` (in place). `ops` are OPS
 * numbers, `alphas` opacities 0..255, `masks` one byte of coverage per pixel or null.
 * Premultiplied 8-bit maths between the premultiply at the start and the unpremultiply at
 * the end; the formulas are in crates/px/src/composite.rs.
 */
export function compositeTile(dst, srcs, ops, alphas, masks = null) {
    const px = dst.length >> 2;
    for (let i = 0, n = px * 4; i < n; i += 4) {
        const a = dst[i + 3];
        if (a !== 255) {
            let t = dst[i] * a + 128; dst[i] = (t + (t >> 8)) >> 8;
            t = dst[i + 1] * a + 128; dst[i + 1] = (t + (t >> 8)) >> 8;
            t = dst[i + 2] * a + 128; dst[i + 2] = (t + (t >> 8)) >> 8;
        }
    }
    for (let l = 0; l < srcs.length; l++) {
        compositeLayer(dst, srcs[l], ops[l] | 0, alphas[l] | 0, masks ? masks[l] : null, px);
    }
    for (let i = 0, n = px * 4; i < n; i += 4) {
        const a = dst[i + 3];
        if (a === 0) {
            dst[i] = 0; dst[i + 1] = 0; dst[i + 2] = 0;
        } else if (a !== 255) {
            const h = a >> 1;
            let c = ((dst[i] * 255 + h) / a) | 0; dst[i] = c > 255 ? 255 : c;
            c = ((dst[i + 1] * 255 + h) / a) | 0; dst[i + 1] = c > 255 ? 255 : c;
            c = ((dst[i + 2] * 255 + h) / a) | 0; dst[i + 2] = c > 255 ? 255 : c;
        }
    }
    return dst;
}

function compositeLayer(dst, src, op, o, mask, px) {
    for (let p = 0, i = 0; p < px; p++, i += 4) {
        const m = mask ? mask[p] : 255;
        if (m === 0) continue;
        let sa = src[i + 3];
        if (o !== 255) { const t = sa * o + 128; sa = (t + (t >> 8)) >> 8; }
        const inv = 255 - sa;
        const dr = dst[i], dg = dst[i + 1], db = dst[i + 2], da = dst[i + 3];
        let r, g, b, a, t;
        switch (op) {
            case 0: { // source-over
                if (sa === 0) continue;
                if (sa === 255 && m === 255) {
                    dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = 255;
                    continue;
                }
                t = src[i] * sa + 128; r = (t + (t >> 8)) >> 8;
                t = dr * inv + 128; r += (t + (t >> 8)) >> 8;
                t = src[i + 1] * sa + 128; g = (t + (t >> 8)) >> 8;
                t = dg * inv + 128; g += (t + (t >> 8)) >> 8;
                t = src[i + 2] * sa + 128; b = (t + (t >> 8)) >> 8;
                t = db * inv + 128; b += (t + (t >> 8)) >> 8;
                t = da * inv + 128; a = sa + ((t + (t >> 8)) >> 8);
                break;
            }
            case 1: { // destination-out
                if (sa === 0) continue;
                t = dr * inv + 128; r = (t + (t >> 8)) >> 8;
                t = dg * inv + 128; g = (t + (t >> 8)) >> 8;
                t = db * inv + 128; b = (t + (t >> 8)) >> 8;
                t = da * inv + 128; a = (t + (t >> 8)) >> 8;
                break;
            }
            case 2: { // source-atop
                if (sa === 0) continue;
                t = src[i] * sa + 128; t = ((t + (t >> 8)) >> 8) * da + 128; r = (t + (t >> 8)) >> 8;
                t = dr * inv + 128; r += (t + (t >> 8)) >> 8;
                t = src[i + 1] * sa + 128; t = ((t + (t >> 8)) >> 8) * da + 128; g = (t + (t >> 8)) >> 8;
                t = dg * inv + 128; g += (t + (t >> 8)) >> 8;
                t = src[i + 2] * sa + 128; t = ((t + (t >> 8)) >> 8) * da + 128; b = (t + (t >> 8)) >> 8;
                t = db * inv + 128; b += (t + (t >> 8)) >> 8;
                t = sa * da + 128; a = (t + (t >> 8)) >> 8;
                t = da * inv + 128; a += (t + (t >> 8)) >> 8;
                break;
            }
            case 3: { // destination-in
                if (sa === 255) continue;
                t = dr * sa + 128; r = (t + (t >> 8)) >> 8;
                t = dg * sa + 128; g = (t + (t >> 8)) >> 8;
                t = db * sa + 128; b = (t + (t >> 8)) >> 8;
                t = da * sa + 128; a = (t + (t >> 8)) >> 8;
                break;
            }
            default: { // copy
                t = src[i] * sa + 128; r = (t + (t >> 8)) >> 8;
                t = src[i + 1] * sa + 128; g = (t + (t >> 8)) >> 8;
                t = src[i + 2] * sa + 128; b = (t + (t >> 8)) >> 8;
                a = sa;
            }
        }
        if (m !== 255) {
            const im = 255 - m;
            t = r * m + 128; r = (t + (t >> 8)) >> 8; t = dr * im + 128; r += (t + (t >> 8)) >> 8;
            t = g * m + 128; g = (t + (t >> 8)) >> 8; t = dg * im + 128; g += (t + (t >> 8)) >> 8;
            t = b * m + 128; b = (t + (t >> 8)) >> 8; t = db * im + 128; b += (t + (t >> 8)) >> 8;
            t = a * m + 128; a = (t + (t >> 8)) >> 8; t = da * im + 128; a += (t + (t >> 8)) >> 8;
        }
        dst[i] = r; dst[i + 1] = g; dst[i + 2] = b; dst[i + 3] = a;
    }
}

// ---- PNG rows ----------------------------------------------------------------------------------

/**
 * `rows` rows of RGBA8 (`w` wide) filtered into `out` (rows × (1 + 4w) bytes): per row the
 * filter byte of None / Sub / Up / Average / Paeth with the smallest sum of absolute signed
 * values (libpng's heuristic, ties to the lower type), then the filtered row. `prev` is the
 * row above the first one, or null for zeros.
 */
export function pngFilterRows(rgba, w, rows, prev = null, out = new Uint8Array(rows * (1 + 4 * w))) {
    const n = w * 4;
    const zero = prev ? null : new Uint8Array(n);
    for (let y = 0; y < rows; y++) {
        const r = y * n;
        const up = y === 0 ? (prev || zero) : rgba;
        const u = y === 0 ? 0 : r - n;
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
        for (let i = 0; i < n; i++) {
            const x = rgba[r + i];
            const a = i >= 4 ? rgba[r + i - 4] : 0;
            const b = up[u + i];
            const c = i >= 4 ? up[u + i - 4] : 0;
            let v = x; s0 += v < 128 ? v : 256 - v;
            v = (x - a) & 255; s1 += v < 128 ? v : 256 - v;
            v = (x - b) & 255; s2 += v < 128 ? v : 256 - v;
            v = (x - ((a + b) >> 1)) & 255; s3 += v < 128 ? v : 256 - v;
            v = (x - paeth(a, b, c)) & 255; s4 += v < 128 ? v : 256 - v;
        }
        let best = 0, min = s0;
        if (s1 < min) { best = 1; min = s1; }
        if (s2 < min) { best = 2; min = s2; }
        if (s3 < min) { best = 3; min = s3; }
        if (s4 < min) { best = 4; min = s4; }
        const o = y * (n + 1);
        out[o] = best;
        for (let i = 0; i < n; i++) {
            const x = rgba[r + i];
            const a = i >= 4 ? rgba[r + i - 4] : 0;
            const b = up[u + i];
            const c = i >= 4 ? up[u + i - 4] : 0;
            out[o + 1 + i] = best === 0 ? x : best === 1 ? x - a : best === 2 ? x - b : best === 3 ? x - ((a + b) >> 1) : x - paeth(a, b, c);
        }
    }
    return out;
}

function paeth(a, b, c) {
    let pa = b - c; if (pa < 0) pa = -pa;
    let pb = a - c; if (pb < 0) pb = -pb;
    let pc = a + b - 2 * c; if (pc < 0) pc = -pc;
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** A zlib stream through the browser's native `CompressionStream("deflate")`. */
export async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
