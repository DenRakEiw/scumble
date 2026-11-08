//! The blur and sharpen brushes' filters (`renderer/editor/inpaint_stroke.js` `blurRGBA`, `sharpenRGBA`; K26 of
//! docs/PLAN_WASM_BUILD.md): straight RGBA8 premultiplied into f32, three box passes of radius r each way on the
//! generic box pass (`maskf::box_pass`, four channels, `sum * (1 / (2r + 1))` as the twin's `sum * k`), back to straight
//! bytes. The twins' bytes bit for bit: the products and divisions in f64 rounded to f32 where the twin stores into a
//! `Float32Array`, every byte stored as a `Uint8ClampedArray` stores it (NaN 0, clamped, ties to even).
//!
//! K27: the tone brush's table (`toneRGBA`), the sponge (`spongeRGBA`) and frequency separation's split (`freqSplit`),
//! each the twin's loop in the twin's order: integers where the twin has integers, every other value an f64 as V8 holds
//! it (no fused multiply-add: wasm has none and LLVM contracts nothing without fast-math), stored through `clamp8`.

use crate::maskf::{box_pass, Norm};

/// A value stored into a `Uint8ClampedArray`: NaN and anything up to 0 give 0, 255 and above 255, the rest rounded to
/// the nearest integer, ties to even.
#[inline(always)]
pub fn clamp8(v: f64) -> u8 {
    if !(v > 0.0) {
        0
    } else if v >= 255.0 {
        255
    } else {
        v.round_ties_even() as i32 as u8   // in (0, 255): exact, and the signed conversion is the cheaper one
    }
}

/// The largest block `px_alloc` hands out: `Layout::from_size_align` refuses a size above isize::MAX less the 4 KB
/// alignment of a large block (lib.rs `align_for`).
const MAX_BLOCK: usize = (isize::MAX as usize) - 4096;

/// The scratch a filter of a w x h box needs, in bytes: two f32 planes of four channels and the column sums, or None
/// when it does not fit a usize or one `px_alloc` block (the export refuses then, and the caller runs the twin).
pub fn scratch_bytes(w: usize, h: usize) -> Option<usize> {
    let n4 = w.checked_mul(h)?.checked_mul(4)?;
    let planes = n4.checked_mul(8)?; // two planes of n4 f32
    let total = planes.checked_add(w.checked_mul(4)?.checked_mul(8)?)?;
    if total > MAX_BLOCK { None } else { Some(total) }
}

/// `blurRGBA(src, w, h, r)` into `out` (w * h * 4 bytes, every one written). `a` and `b` hold w * h * 4 floats, `sums`
/// w * 4 f64 (the caller's scratch). `r` is the twin's `Math.max(0, Math.round(r))`, already rounded.
pub fn blur_rgba(src: &[u8], out: &mut [u8], a: &mut [f32], b: &mut [f32], sums: &mut [f64], w: usize, h: usize, r: usize) {
    let n4 = w * h * 4;
    let (src, out, a) = (&src[..n4], &mut out[..n4], &mut a[..n4]);
    for i in (0..n4).step_by(4) {
        let al = src[i + 3] as f64 / 255.0;
        a[i] = (src[i] as f64 * al) as f32;
        a[i + 1] = (src[i + 1] as f64 * al) as f32;
        a[i + 2] = (src[i + 2] as f64 * al) as f32;
        a[i + 3] = src[i + 3] as f32;
    }
    if r > 0 {
        let k = Norm::Mul(1.0 / (2 * r + 1) as f64);
        for _ in 0..3 {
            box_pass::<4>(a, b, sums, w, h, r, k);
        }
    }
    for i in (0..n4).step_by(4) {
        let al = a[i + 3] as f64;
        if al < 0.5 {
            out[i] = 0;
            out[i + 1] = 0;
            out[i + 2] = 0;
            out[i + 3] = 0;
            continue;
        }
        let k = 255.0 / al;
        out[i] = clamp8(a[i] as f64 * k);
        out[i + 1] = clamp8(a[i + 1] as f64 * k);
        out[i + 2] = clamp8(a[i + 2] as f64 * k);
        out[i + 3] = clamp8(al);
    }
}

/// `sharpenRGBA(src, w, h, r, amount)` into `out`: the blur of radius r first written into `out`, then each pixel's
/// colour + amount x (colour - its blur), clamped; the alpha stays; a pixel the blur or the source leaves transparent
/// keeps its bytes. The same scratch as `blur_rgba`.
#[allow(clippy::too_many_arguments)]
pub fn sharpen_rgba(src: &[u8], out: &mut [u8], a: &mut [f32], b: &mut [f32], sums: &mut [f64], w: usize, h: usize, r: usize, amount: f64) {
    let n4 = w * h * 4;
    blur_rgba(src, out, a, b, sums, w, h, r);
    let (src, out) = (&src[..n4], &mut out[..n4]);
    for i in (0..n4).step_by(4) {
        let (sa, ba) = (src[i + 3], out[i + 3]);
        if sa == 0 || ba == 0 {
            out[i] = src[i];
            out[i + 1] = src[i + 1];
            out[i + 2] = src[i + 2];
        } else {
            for c in 0..3 {
                let s = src[i + c] as f64;
                out[i + c] = clamp8(s + amount * (s - out[i + c] as f64));
            }
        }
        out[i + 3] = sa;
    }
}

/// `toneRGBA(src, lut, protect)` of `inpaint_stroke.js` into `out` (as long as `src`, a multiple of 4; every byte
/// written): the alpha kept, a transparent pixel's bytes kept; per channel `lut[c]`, or with `protect` the table on the
/// brightest channel `v` and the three scaled alike above the table's floor `o = lut[0]`: `o + c * ((lut[v] - o) / v)`,
/// `o` for black. The factor `(lut[v] - o) / v` depends on `v` alone: the call divides once per `v` into `kt`, the very
/// f64s the twin divides out per pixel.
pub fn tone_rgba(src: &[u8], out: &mut [u8], lut: &[u8; 256], protect: bool) {
    let o = lut[0];
    let of = o as f64;
    let mut kt = [0f64; 256];
    if protect {
        for v in 1..256 {
            kt[v] = (lut[v] as f64 - of) / v as f64;
        }
    }
    for (s, d) in src.chunks_exact(4).zip(out.chunks_exact_mut(4)) {
        let (r, g, b, a) = (s[0], s[1], s[2], s[3]);
        d[3] = a;
        if a == 0 {
            d[0] = r;
            d[1] = g;
            d[2] = b;
            continue;
        }
        if !protect {
            d[0] = lut[r as usize];
            d[1] = lut[g as usize];
            d[2] = lut[b as usize];
            continue;
        }
        let v = r.max(g).max(b);   // the twin's nested ternaries, branch-free
        if v == 0 {
            d[0] = o;
            d[1] = o;
            d[2] = o;
            continue;
        }
        let k = kt[v as usize];
        d[0] = clamp8(of + r as f64 * k);
        d[1] = clamp8(of + g as f64 * k);
        d[2] = clamp8(of + b as f64 * k);
    }
}

/// `spongeRGBA(src, amount, saturate, vibrance)` of `inpaint_stroke.js` into `out` (as `tone_rgba`), with `k` the twin's
/// `Math.max(0, Math.min(1, +amount || 0))` (the caller's): each channel moved from the pixel's BT.601 luma `y` by the
/// gain `t`, `y + (c - y) * t`; desaturate `t = 1 - k`; saturate `t = 1 + k * (1 - (mx - mn) / mx)` with `vibrance`, else
/// `1 + k`, stopped where the first channel would clip (`lim`, an infinite side where no channel lies beyond `y`, as the
/// twin's `Infinity`). Transparent and grey pixels keep their bytes. The SIMD build takes four pixels a step
/// (`sponge_lanes`), the rest here.
pub fn sponge_rgba(src: &[u8], out: &mut [u8], k: f64, saturate: bool, vibrance: bool) {
    let n = src.len();
    let out = &mut out[..n];
    let done = sponge_lanes::run(src, out, k, saturate, vibrance);
    sponge_scalar(&src[done..], &mut out[done..], k, saturate, vibrance);
}

fn sponge_scalar(src: &[u8], out: &mut [u8], k: f64, saturate: bool, vibrance: bool) {
    for (s, d) in src.chunks_exact(4).zip(out.chunks_exact_mut(4)) {
        d.copy_from_slice(s);
        let (r, g, b) = (s[0] as i32, s[1] as i32, s[2] as i32);
        let (mx, mn) = (r.max(g).max(b), r.min(g).min(b));   // the twin's nested ternaries, branch-free
        if s[3] == 0 || mx == mn {
            continue;
        }
        let y = (77 * r + 150 * g + 29 * b + 128) >> 8;
        let t = if saturate {
            let mut t = 1.0 + k * (if vibrance { 1.0 - (mx - mn) as f64 / mx as f64 } else { 1.0 });
            let up = if mx > y { (255 - y) as f64 / (mx - y) as f64 } else { f64::INFINITY };
            let down = if mn < y { y as f64 / (y - mn) as f64 } else { f64::INFINITY };
            let lim = if down < up { down } else { up };
            if t > lim {
                t = if lim > 1.0 { lim } else { 1.0 };
            }
            t
        } else {
            1.0 - k
        };
        let yf = y as f64;
        d[0] = clamp8(yf + (r - y) as f64 * t);
        d[1] = clamp8(yf + (g - y) as f64 * t);
        d[2] = clamp8(yf + (b - y) as f64 * t);
    }
}

/// Frequency separation's split (`freqSplit` of `inpaint_stroke.js`, the loop of `InpaintEditor.frequencySeparation`):
/// `src` the picture I, `low` its blur L (changed in place), `high` H out; all as long as `src`, a multiple of 4, every
/// byte of `high` written. Per colour channel t = I - L + 255, H = t >> 1, and where t is odd L one level up (at 255
/// one down and H one up), so L + 2H - 255 = I exactly; the alpha of both is I's. Branch-free: `odd` the low bit of t,
/// `top` whether that odd t meets L at 255. The SIMD build takes four pixels a step (`split_lanes`), the rest here.
pub fn freq_split(src: &[u8], low: &mut [u8], high: &mut [u8]) {
    let n = src.len();
    let (low, high) = (&mut low[..n], &mut high[..n]);
    let done = split_lanes::run(src, low, high);
    split_scalar(&src[done..], &mut low[done..], &mut high[done..]);
}

fn split_scalar(src: &[u8], low: &mut [u8], high: &mut [u8]) {
    for ((s, l), h) in src.chunks_exact(4).zip(low.chunks_exact_mut(4)).zip(high.chunks_exact_mut(4)) {
        for c in 0..3 {
            let lv = l[c] as i32;
            let t = s[c] as i32 - lv + 255;
            let odd = t & 1;
            let top = odd & (lv == 255) as i32;
            h[c] = ((t >> 1) + top) as u8;
            l[c] = (lv + odd - 2 * top) as u8;
        }
        l[3] = s[3];
        h[3] = s[3];
    }
}

/// No lanes in the scalar build: no byte done.
#[cfg(not(target_feature = "simd128"))]
mod split_lanes {
    pub fn run(_: &[u8], _: &mut [u8], _: &mut [u8]) -> usize {
        0
    }
}

/// The split sixteen bytes (four pixels) a step, every byte a lane of u8: `255 - L` is `!L`, so t = I + !L and
/// t >> 1 is the rounding average less the low bit of `I ^ !L` (`odd`); `top` is `odd` where L is 255; H = t >> 1 +
/// top, L' = L + odd - 2 top (wrapping: 255 + 1 - 2 = 254); each pixel's alpha byte (3 of every 4) taken from I.
#[cfg(target_feature = "simd128")]
mod split_lanes {
    use core::arch::wasm32::*;

    /// The bytes done: all whole steps of 16 of `src` (`low` and `high` as long).
    pub fn run(src: &[u8], low: &mut [u8], high: &mut [u8]) -> usize {
        let n = src.len() / 16 * 16;
        assert!(low.len() >= n && high.len() >= n);
        let alpha = u32x4_splat(0xff00_0000);
        let (one, ff) = (u8x16_splat(1), u8x16_splat(255));
        let mut i = 0;
        while i < n {
            // SAFETY: i + 16 <= n, within all three slices (the assert above)
            unsafe {
                let s = v128_load(src.as_ptr().add(i) as *const v128);
                let l = v128_load(low.as_ptr().add(i) as *const v128);
                let nl = v128_not(l);
                let odd = v128_and(v128_xor(s, nl), one);
                let half = u8x16_sub(u8x16_avgr(s, nl), odd);
                let top = v128_and(odd, u8x16_eq(l, ff));
                let h = u8x16_add(half, top);
                let l2 = u8x16_sub(u8x16_add(l, odd), u8x16_add(top, top));
                v128_store(high.as_mut_ptr().add(i) as *mut v128, v128_bitselect(s, h, alpha));
                v128_store(low.as_mut_ptr().add(i) as *mut v128, v128_bitselect(s, l2, alpha));
            }
            i += 16;
        }
        n
    }
}

/// No lanes in the scalar build: no byte done.
#[cfg(not(target_feature = "simd128"))]
mod sponge_lanes {
    pub fn run(_: &[u8], _: &mut [u8], _: f64, _: bool, _: bool) -> usize {
        0
    }
}

/// The sponge four pixels a step: the integers (the channels, mx, mn, the luma) in i32x4 lanes, the gain and the three
/// outputs in two f64x2 halves, each lane the scalar loop's operations on the same values (every value an f64 the twin
/// holds: the integers convert exactly; `/`, `*`, `+` are IEEE in every lane). The twin's branches become masks:
/// `up` / `down` are divided in every lane and replaced by infinity where the twin takes `Infinity` (a lane where
/// mx = y divides by 0); a kept pixel (transparent or grey) is computed too and its bytes taken from `src` at the end.
/// The store `clamp8` is `nearest`, then at least 0 and at most 255: the same byte for every finite value, and a kept
/// lane's NaN is never stored.
#[cfg(target_feature = "simd128")]
mod sponge_lanes {
    use core::arch::wasm32::*;

    #[inline(always)]
    fn lo(v: v128) -> v128 {
        f64x2_convert_low_i32x4(v)
    }

    #[inline(always)]
    fn hi(v: v128) -> v128 {
        f64x2_convert_low_i32x4(i32x4_shuffle::<2, 3, 2, 3>(v, v))
    }

    /// The gain `t` of two pixels from f64x2 halves of mx, mn and the luma y. `up` and `down` are divided in every lane
    /// (the differences of exact integers are exact) and are infinity where the twin takes `Infinity` (mx = y or mn = y:
    /// a division by 0 here). `lim` = `down < up ? down : up` is the twin's `Math.min`, `pmax(1, lim)` its `Math.max(1,
    /// lim)`, and the twin's `if (t > lim) t = max(1, lim)` is `pmin(t0, max(1, lim))`: lim is at least 1 (255 - y >= mx -
    /// y > 0 and y >= y - mn > 0 give quotients of at least 1), so where t0 > lim that is lim, and t0 where t0 <= lim.
    #[inline(always)]
    fn gain(mx: v128, mn: v128, y: v128, c: &Consts, saturate: bool, vibrance: bool) -> v128 {
        if !saturate {
            return c.desat;
        }
        let t0 = if vibrance {
            f64x2_add(c.one, f64x2_mul(c.k, f64x2_sub(c.one, f64x2_div(f64x2_sub(mx, mn), mx))))
        } else {
            c.flat
        };
        let up = v128_bitselect(f64x2_div(f64x2_sub(c.f255, y), f64x2_sub(mx, y)), c.inf, f64x2_gt(mx, y));
        let down = v128_bitselect(f64x2_div(y, f64x2_sub(y, mn)), c.inf, f64x2_lt(mn, y));
        f64x2_pmin(t0, f64x2_pmax(c.one, f64x2_pmin(up, down)))
    }

    /// `clamp8(y + (ch - y) * t)` of two lanes, as i32 in lanes 0 and 1.
    #[inline(always)]
    fn store(y: v128, ch: v128, t: v128, c: &Consts) -> v128 {
        let v = f64x2_nearest(f64x2_add(y, f64x2_mul(f64x2_sub(ch, y), t)));
        // pmax / pmin (`a < b ? b : a`, one instruction each; min / max keep NaN and -0 apart at several): -0 stays -0
        // and converts to 0, as NaN does; neither reaches a byte that is stored
        i32x4_trunc_sat_f64x2_zero(f64x2_pmin(f64x2_pmax(v, c.zero), c.f255))
    }

    struct Consts {
        one: v128,
        zero: v128,
        f255: v128,
        inf: v128,
        k: v128,
        desat: v128,
        flat: v128,
    }

    /// The bytes done: all whole steps of 16 of `src` (`out` as long).
    pub fn run(src: &[u8], out: &mut [u8], k: f64, saturate: bool, vibrance: bool) -> usize {
        let n = src.len() / 16 * 16;
        assert!(out.len() >= n);
        let c = Consts {
            one: f64x2_splat(1.0),
            zero: f64x2_splat(0.0),
            f255: f64x2_splat(255.0),
            inf: f64x2_splat(f64::INFINITY),
            k: f64x2_splat(k),
            desat: f64x2_splat(1.0 - k),
            flat: f64x2_splat(1.0 + k * 1.0),
        };
        let b8 = u32x4_splat(0xff);
        let (w77, w150, w29, w128) = (i32x4_splat(77), i32x4_splat(150), i32x4_splat(29), i32x4_splat(128));
        let mut i = 0;
        while i < n {
            // SAFETY: i + 16 <= n, within both slices (the assert above)
            let px = unsafe { v128_load(src.as_ptr().add(i) as *const v128) };
            let r = v128_and(px, b8);
            let g = v128_and(u32x4_shr(px, 8), b8);
            let b = v128_and(u32x4_shr(px, 16), b8);
            let a = u32x4_shr(px, 24);
            let mx = i32x4_max(r, i32x4_max(g, b));
            let mn = i32x4_min(r, i32x4_min(g, b));
            let keep = v128_or(i32x4_eq(a, i32x4_splat(0)), i32x4_eq(mx, mn));
            if i32x4_all_true(keep) {
                unsafe { v128_store(out.as_mut_ptr().add(i) as *mut v128, px) };
                i += 16;
                continue;
            }
            let y = i32x4_shr(i32x4_add(i32x4_add(i32x4_add(i32x4_mul(w77, r), i32x4_mul(w150, g)), i32x4_mul(w29, b)), w128), 8);
            let (y_lo, y_hi) = (lo(y), hi(y));
            let t_lo = gain(lo(mx), lo(mn), y_lo, &c, saturate, vibrance);
            let t_hi = gain(hi(mx), hi(mn), y_hi, &c, saturate, vibrance);
            let ch = |v: v128| -> v128 { i32x4_shuffle::<0, 1, 4, 5>(store(y_lo, lo(v), t_lo, &c), store(y_hi, hi(v), t_hi, &c)) };
            let packed = v128_or(v128_or(ch(r), i32x4_shl(ch(g), 8)), v128_or(i32x4_shl(ch(b), 16), i32x4_shl(a, 24)));
            unsafe { v128_store(out.as_mut_ptr().add(i) as *mut v128, v128_bitselect(px, packed, keep)) };
            i += 16;
        }
        n
    }
}
