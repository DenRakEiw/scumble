//! The float masks of a provider run (`renderer/editor/stitch.js`): a square dilation and the box blurs of its
//! gaussian, as whole jobs over one `f32` buffer of w × h values in 0..1.
//!
//! Both give the floats of their JS twins (`dilateMask`, `boxBlurs` in `kernels_js.js`) bit for bit. The dilation is
//! a maximum, which no order of evaluation changes; the blur keeps the twin's running sums in f64, added and
//! subtracted in the twin's order.

#[inline(always)]
fn fmax(a: f32, b: f32) -> f32 {
    if a > b { a } else { b }
}

/// The window of i, clamped to the line. It is shorter than a block at both ends of the line, and then it may lie in
/// one block: it starts the block (`g` of its end is the window) or it ends with the block or the line (`hh` of its start is).
#[inline(always)]
fn window(i: usize, r: usize, n: usize) -> (usize, usize) {
    (i.saturating_sub(r), (i + r).min(n - 1))
}

/// The maximum over [i - r, i + r] (clamped to the line) for every i, never below 0, by van Herk / Gil-Werman:
/// `g` holds the maximum from the start of i's block of 2r + 1 to i, `hh` the one from i to its block's end, and a
/// window is the end of one block and the start of the next. `n` is the length of a line and `lines` their number;
/// vertical lines are walked a row at a time, so memory is read in order either way.
fn max_lines(data: &mut [f32], g: &mut [f32], hh: &mut [f32], n: usize, lines: usize, r: usize, vertical: bool) {
    let k = 2 * r + 1;
    let (outer, inner) = if vertical { (n, lines) } else { (lines, n) };
    if vertical {
        for i in 0..n {
            let row = i * inner;
            if i % k == 0 {
                g[row..row + inner].copy_from_slice(&data[row..row + inner]);
            } else {
                for x in 0..inner { g[row + x] = fmax(g[row - inner + x], data[row + x]); }
            }
        }
        for i in (0..n).rev() {
            let row = i * inner;
            if i == n - 1 || (i + 1) % k == 0 {
                hh[row..row + inner].copy_from_slice(&data[row..row + inner]);
            } else {
                for x in 0..inner { hh[row + x] = fmax(hh[row + inner + x], data[row + x]); }
            }
        }
        for i in 0..n {
            let (a, b) = window(i, r, n);
            let (lo, hi, row) = (a * inner, b * inner, i * inner);
            let one = a / k == b / k;
            for x in 0..inner {
                let v = if !one { fmax(hh[lo + x], g[hi + x]) } else if a % k == 0 { g[hi + x] } else { hh[lo + x] };
                data[row + x] = if v > 0.0 { v } else { 0.0 };
            }
        }
    } else {
        for y in 0..outer {
            let row = y * inner;
            for i in 0..n {
                g[row + i] = if i % k == 0 { data[row + i] } else { fmax(g[row + i - 1], data[row + i]) };
            }
            for i in (0..n).rev() {
                hh[row + i] = if i == n - 1 || (i + 1) % k == 0 { data[row + i] } else { fmax(hh[row + i + 1], data[row + i]) };
            }
            for i in 0..n {
                let (a, b) = window(i, r, n);
                let v = if a / k != b / k { fmax(hh[row + a], g[row + b]) } else if a % k == 0 { g[row + b] } else { hh[row + a] };
                data[row + i] = if v > 0.0 { v } else { 0.0 };
            }
        }
    }
}

/// Square dilation by `r` pixels, in place.
pub fn dilate(data: &mut [f32], w: usize, h: usize, r: usize) {
    if r == 0 || w == 0 || h == 0 { return; }
    let mut g = vec![0f32; w * h];
    let mut hh = vec![0f32; w * h];
    max_lines(data, &mut g, &mut hh, w, h, r, false);
    max_lines(data, &mut g, &mut hh, h, w, r, true);
}

// ---- the generic box pass (docs/PLAN_WASM_BUILD.md §3.3, K4) ------------------------------------------------------
//
// One box pass of radius r over a w x h image of C interleaved f32 channels, with clamped edges: a running sum in f64
// per line and channel, started over the clamped window of the line's first value and moved on by the value that
// enters less the one that leaves, `sum + (enter - leave)`, the order of every twin. The lanes hold two such sums at
// once and do the same f64 operations on each, so they give the scalar loop's floats bit for bit.

/// How a box pass turns its running sum into a value: `Div(n)` is `sum / n`, the masks' twin (`kernels_js.js`
/// `boxRow` / `boxCol`, n = 2r + 1); `Mul(k)` is `sum * k`, the dab blur's twin (`inpaint_stroke.js` `boxRows` /
/// `boxCols`, k = 1 / (2r + 1)). The two differ in the last bit for many sums, so each caller keeps its twin's.
#[derive(Clone, Copy)]
#[allow(dead_code)] // `Mul` is the dab blur's (K26)
pub enum Norm {
    Div(f64),
    Mul(f64),
}

impl Norm {
    #[inline(always)]
    fn of(self, s: f64) -> f64 {
        match self {
            Norm::Div(n) => s / n,
            Norm::Mul(k) => s * k,
        }
    }
}

/// A window tap k (from -r to r around 0) clamped to a line of n values.
#[inline(always)]
fn clamp(k: isize, n: usize) -> usize {
    (k.max(0) as usize).min(n - 1)
}

/// The pass along the rows for rows y0..h, value by value: the scalar build's whole pass and the rows the lanes leave.
fn rows_scalar<const C: usize>(src: &[f32], dst: &mut [f32], w: usize, y0: usize, h: usize, r: usize, norm: Norm) {
    let ri = r as isize;
    for y in y0..h {
        let row = y * w * C;
        for c in 0..C {
            let mut sum = 0f64;
            for k in -ri..=ri {
                sum += src[row + clamp(k, w) * C + c] as f64;
            }
            for x in 0..w {
                dst[row + x * C + c] = norm.of(sum) as f32;
                let add = (x + r + 1).min(w - 1);
                let sub = x.saturating_sub(r);
                sum += src[row + add * C + c] as f64 - src[row + sub * C + c] as f64;
            }
        }
    }
}

/// The pass along the rows, `src` into `dst` (w * h * C floats each).
fn box_rows<const C: usize>(src: &[f32], dst: &mut [f32], w: usize, h: usize, r: usize, norm: Norm) {
    let done = lanes::rows::<C>(src, dst, w, h, r, norm);
    rows_scalar::<C>(src, dst, w, done, h, r, norm);
}

/// The pass down the columns of h lines of n = w * C values, `src` into `dst`: one running sum a value in `sums` (n of
/// them), walked a line at a time, so memory is read in order (the twins walk the same sums in the same order).
fn box_cols(src: &[f32], dst: &mut [f32], sums: &mut [f64], n: usize, h: usize, r: usize, norm: Norm) {
    let sums = &mut sums[..n];
    for s in sums.iter_mut() {
        *s = 0.0;
    }
    let ri = r as isize;
    for k in -ri..=ri {
        let line = &src[clamp(k, h) * n..][..n];
        let done = lanes::add_line(sums, line);
        for x in done..n {
            sums[x] += line[x] as f64;
        }
    }
    for y in 0..h {
        let add = &src[(y + r + 1).min(h - 1) * n..][..n];
        let sub = &src[y.saturating_sub(r) * n..][..n];
        let out = &mut dst[y * n..][..n];
        let done = lanes::col_line(out, sums, add, sub, norm);
        for x in done..n {
            out[x] = norm.of(sums[x]) as f32;
            sums[x] += add[x] as f64 - sub[x] as f64;
        }
    }
}

/// One box blur of radius r along the rows and then down the columns of a w x h image of C interleaved channels, in
/// place (clamped edges). `tmp` holds at least w * h * C floats and `sums` w * C, both the caller's: nothing is
/// allocated here. A radius of 0 leaves the image as it is (the twins skip it).
pub fn box_pass<const C: usize>(data: &mut [f32], tmp: &mut [f32], sums: &mut [f64], w: usize, h: usize, r: usize, norm: Norm) {
    if w == 0 || h == 0 || r == 0 {
        return;
    }
    let n = w * h * C;
    box_rows::<C>(&data[..n], &mut tmp[..n], w, h, r, norm);
    box_cols(&tmp[..n], &mut data[..n], sums, w * C, h, r, norm);
}

/// A box blur along rows and then along columns for every radius that is not 0, in place (clamped edges): one channel,
/// `sum / (2r + 1)`, the floats of `kernels_js.js` `boxBlurs`.
pub fn box_blurs(data: &mut [f32], w: usize, h: usize, radii: &[usize]) {
    if w == 0 || h == 0 { return; }
    let mut tmp = vec![0f32; w * h];
    let mut sums = vec![0f64; w];
    for &r in radii {
        if r == 0 { continue; }
        box_pass::<1>(data, &mut tmp, &mut sums, w, h, r, Norm::Div((2 * r + 1) as f64));
    }
}

#[cfg(not(target_feature = "simd128"))]
mod lanes {
    use super::Norm;

    /// No lanes in the scalar build: no row done.
    #[inline(always)]
    pub fn rows<const C: usize>(_: &[f32], _: &mut [f32], _: usize, _: usize, _: usize, _: Norm) -> usize {
        0
    }

    /// No lanes in the scalar build: no value done.
    #[inline(always)]
    pub fn add_line(_: &mut [f64], _: &[f32]) -> usize {
        0
    }

    /// No lanes in the scalar build: no value done.
    #[inline(always)]
    pub fn col_line(_: &mut [f32], _: &mut [f64], _: &[f32], _: &[f32], _: Norm) -> usize {
        0
    }
}

#[cfg(target_feature = "simd128")]
mod lanes {
    use super::{clamp, Norm};
    use core::arch::wasm32::*;

    /// `sum / n` or `sum * k` on both lanes, the divisor or factor splat in `v`.
    #[inline(always)]
    fn apply<const DIV: bool>(s: v128, v: v128) -> v128 {
        if DIV { f64x2_div(s, v) } else { f64x2_mul(s, v) }
    }

    /// Floats 2 and 3 of a group of four as two f64 lanes (floats 0 and 1: `f64x2_promote_low_f32x4` of the group).
    #[inline(always)]
    fn high(q: v128) -> v128 {
        f64x2_promote_low_f32x4(i64x2_shuffle::<1, 1>(q, q))
    }

    /// Two f64x2 rounded to f32 (ties to even, as `as f32`) and packed into one group of four, `lo` first.
    #[inline(always)]
    fn pack(lo: v128, hi: v128) -> v128 {
        i64x2_shuffle::<0, 2>(f32x4_demote_f64x2_zero(lo), f32x4_demote_f64x2_zero(hi))
    }

    /// The rows the lanes take: for one channel two rows at once (one f64 lane each), the last row of an odd height
    /// left to the scalar loop; for four channels every row (channels 0-1 and 2-3 in two f64x2, a pixel one load);
    /// none for another channel count. Returns the rows done, from the first.
    pub fn rows<const C: usize>(src: &[f32], dst: &mut [f32], w: usize, h: usize, r: usize, norm: Norm) -> usize {
        assert!(src.len() >= w * h * C && dst.len() >= w * h * C);
        let (s, d) = (src.as_ptr(), dst.as_mut_ptr());
        // every index below is inside the w * h * C floats checked above
        unsafe {
            match (C, norm) {
                (1, Norm::Div(n)) => rows1::<true>(s, d, w, h, r, f64x2_splat(n)),
                (1, Norm::Mul(k)) => rows1::<false>(s, d, w, h, r, f64x2_splat(k)),
                (4, Norm::Div(n)) => rows4::<true>(s, d, w, h, r, f64x2_splat(n)),
                (4, Norm::Mul(k)) => rows4::<false>(s, d, w, h, r, f64x2_splat(k)),
                _ => 0,
            }
        }
    }

    /// Rows 2p and 2p + 1 of a one-channel image in lanes 0 and 1, for every pair p (four rows in two sums measured
    /// slower: K4's `docs/measurements/k4_2026-11-07/summary.txt`).
    #[inline(always)]
    unsafe fn rows1<const DIV: bool>(s: *const f32, d: *mut f32, w: usize, h: usize, r: usize, v: v128) -> usize {
        let ri = r as isize;
        let two = |a: usize, b: usize| f64x2(*s.add(a) as f64, *s.add(b) as f64);
        for p in 0..h / 2 {
            let a = 2 * p * w;
            let b = a + w;
            let mut sum = f64x2_splat(0.0);
            for k in -ri..=ri {
                let i = clamp(k, w);
                sum = f64x2_add(sum, two(a + i, b + i));
            }
            for x in 0..w {
                let o = apply::<DIV>(sum, v);
                *d.add(a + x) = f64x2_extract_lane::<0>(o) as f32;
                *d.add(b + x) = f64x2_extract_lane::<1>(o) as f32;
                let add = (x + r + 1).min(w - 1);
                let sub = x.saturating_sub(r);
                sum = f64x2_add(sum, f64x2_sub(two(a + add, b + add), two(a + sub, b + sub)));
            }
        }
        h / 2 * 2
    }

    /// Every row of a four-channel image: a pixel's four floats one load, its channels 0-1 and 2-3 two f64x2 sums.
    #[inline(always)]
    unsafe fn rows4<const DIV: bool>(s: *const f32, d: *mut f32, w: usize, h: usize, r: usize, v: v128) -> usize {
        let ri = r as isize;
        for y in 0..h {
            let row = y * w * 4;
            let px = |i: usize| v128_load(s.add(row + i * 4) as *const v128);
            let (mut lo, mut hi) = (f64x2_splat(0.0), f64x2_splat(0.0));
            for k in -ri..=ri {
                let q = px(clamp(k, w));
                lo = f64x2_add(lo, f64x2_promote_low_f32x4(q));
                hi = f64x2_add(hi, high(q));
            }
            for x in 0..w {
                v128_store(d.add(row + x * 4) as *mut v128, pack(apply::<DIV>(lo, v), apply::<DIV>(hi, v)));
                let qa = px((x + r + 1).min(w - 1));
                let qs = px(x.saturating_sub(r));
                lo = f64x2_add(lo, f64x2_sub(f64x2_promote_low_f32x4(qa), f64x2_promote_low_f32x4(qs)));
                hi = f64x2_add(hi, f64x2_sub(high(qa), high(qs)));
            }
        }
        h
    }

    /// `sums[x] += line[x]` for the first `n / 4 * 4` values, four a step. Returns the values done.
    pub fn add_line(sums: &mut [f64], line: &[f32]) -> usize {
        let n4 = sums.len().min(line.len()) / 4 * 4;
        let (s, p) = (sums.as_mut_ptr(), line.as_ptr());
        // i + 3 < n4 <= both lengths
        unsafe {
            let mut i = 0;
            while i < n4 {
                let q = v128_load(p.add(i) as *const v128);
                let s0 = v128_load(s.add(i) as *const v128);
                let s1 = v128_load(s.add(i + 2) as *const v128);
                v128_store(s.add(i) as *mut v128, f64x2_add(s0, f64x2_promote_low_f32x4(q)));
                v128_store(s.add(i + 2) as *mut v128, f64x2_add(s1, high(q)));
                i += 4;
            }
        }
        n4
    }

    /// One line of the column pass for the first `n / 4 * 4` values, four a step: the value out of each sum, then the
    /// sum moved on by `add - sub`. Returns the values done.
    pub fn col_line(out: &mut [f32], sums: &mut [f64], add: &[f32], sub: &[f32], norm: Norm) -> usize {
        match norm {
            Norm::Div(n) => col::<true>(out, sums, add, sub, f64x2_splat(n)),
            Norm::Mul(k) => col::<false>(out, sums, add, sub, f64x2_splat(k)),
        }
    }

    #[inline(always)]
    fn col<const DIV: bool>(out: &mut [f32], sums: &mut [f64], add: &[f32], sub: &[f32], v: v128) -> usize {
        let n4 = out.len().min(sums.len()).min(add.len()).min(sub.len()) / 4 * 4;
        let (o, s, a, b) = (out.as_mut_ptr(), sums.as_mut_ptr(), add.as_ptr(), sub.as_ptr());
        // i + 3 < n4 <= every length
        unsafe {
            let mut i = 0;
            while i < n4 {
                let s0 = v128_load(s.add(i) as *const v128);
                let s1 = v128_load(s.add(i + 2) as *const v128);
                v128_store(o.add(i) as *mut v128, pack(apply::<DIV>(s0, v), apply::<DIV>(s1, v)));
                let qa = v128_load(a.add(i) as *const v128);
                let qb = v128_load(b.add(i) as *const v128);
                v128_store(s.add(i) as *mut v128, f64x2_add(s0, f64x2_sub(f64x2_promote_low_f32x4(qa), f64x2_promote_low_f32x4(qb))));
                v128_store(s.add(i + 2) as *mut v128, f64x2_add(s1, f64x2_sub(high(qa), high(qb))));
                i += 4;
            }
        }
        n4
    }
}
