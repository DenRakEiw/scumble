//! The float masks of a provider run (`renderer/editor/stitch.js`): a square dilation, erosion and the box blurs of its
//! gaussian, plus the per-pixel conversions, clamping and bounding box around them, over `f32` buffers of w × h values.
//!
//! Every kernel gives the floats or bytes of its JS twin (`kernels_js.js`) bit for bit. The dilation is
//! a maximum, which no order of evaluation changes; the blur keeps the twin's running sums in f64, added and
//! subtracted in the twin's order.

use crate::stroke::clamp8;

#[inline(always)]
fn fmax(a: f32, b: f32) -> f32 {
    if a > b { a } else { b }
}

/// `Math.max(a, b)` in a Float32Array: NaN (either side) gives V8's quiet NaN (`0xffc0_0000`), and `+0.0` beats `-0.0`.
#[inline(always)]
fn js_max(a: f32, b: f32) -> f32 {
    if a.is_nan() || b.is_nan() {
        f32::from_bits(0xffc0_0000)
    } else if a == 0.0 && b == 0.0 {
        f32::from_bits(a.to_bits() & b.to_bits())
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(1, Math.max(0, v))` in a Float32Array: NaN gives `0xffc0_0000`, `<= 0` (including `-0.0`) gives `+0.0`.
#[inline(always)]
fn js_clamp01(v: f32) -> f32 {
    if v.is_nan() {
        f32::from_bits(0xffc0_0000)
    } else if !(v > 0.0) {
        0.0
    } else if v > 1.0 {
        1.0
    } else {
        v
    }
}

#[inline(always)]
fn mask_byte(x: f32) -> u8 {
    let c = if x > 0.0 { x.min(1.0) as f64 } else { 0.0 };
    (c * 255.0 + 0.5) as u8
}

/// The alpha byte of each RGBA8 pixel divided by 255 in f64 and rounded to f32 (`stitch.js` `maskFromAlpha`).
pub fn alpha_to_mask(rgba: &[u8], dst: &mut [f32]) {
    let n = dst.len().min(rgba.len() / 4);
    let done = lanes::alpha_to_mask(&rgba[..n * 4], &mut dst[..n]);
    for i in done..n {
        dst[i] = (rgba[i * 4 + 3] as f64 / 255.0) as f32;
    }
}

/// `Math.max(dst[i], b[i])` (when `b` is `Some`) and/or `Math.min(1, Math.max(0, x))` (when `clamp` is true), in place on `dst`.
pub fn mask_max_clamp(dst: &mut [f32], b: Option<&[f32]>, clamp: bool) {
    let n = match b {
        Some(b) => dst.len().min(b.len()),
        None => dst.len(),
    };
    let done = lanes::mask_max_clamp(&mut dst[..n], b.map(|s| &s[..n]), clamp);
    match (b, clamp) {
        (Some(b), true) => {
            for i in done..n {
                dst[i] = js_clamp01(js_max(dst[i], b[i]));
            }
        }
        (Some(b), false) => {
            for i in done..n {
                dst[i] = js_max(dst[i], b[i]);
            }
        }
        (None, true) => {
            for i in done..n {
                dst[i] = js_clamp01(dst[i]);
            }
        }
        (None, false) => {}
    }
}

/// `1.0 - data[i]` in place for every float of `data`.
pub fn mask_one_minus(data: &mut [f32]) {
    let done = lanes::mask_one_minus(data);
    for x in &mut data[done..] {
        *x = 1.0 - *x;
    }
}

/// Square erosion by `r` pixels in place: `1 - dilate(1 - m, r)` in f32 (`1 - (1 - x)` is not always `x` in f32).
pub fn erode(data: &mut [f32], w: usize, h: usize, r: usize) {
    if r == 0 || w == 0 || h == 0 {
        return;
    }
    let n = w * h;
    mask_one_minus(&mut data[..n]);
    dilate(&mut data[..n], w, h, r);
    mask_one_minus(&mut data[..n]);
}

/// A float mask `src` as RGBA8 bytes `dst` (`n * 4` bytes): `mode` 0 white `[255, 255, 255, v]`,
/// 1 luminance `[v, v, v, 255]`, 2 alpha `[0, 0, 0, src[i] > 0.5 ? 0 : 255]`.
pub fn mask_to_rgba(src: &[f32], dst: &mut [u8], mode: u32) {
    let n = src.len().min(dst.len() / 4);
    let done = lanes::mask_to_rgba(&src[..n], &mut dst[..n * 4], mode);
    let tail_s = &src[done..n];
    let tail_d = &mut dst[done * 4..n * 4];
    match mode {
        2 => {
            for (&x, p) in tail_s.iter().zip(tail_d.chunks_exact_mut(4)) {
                let a = if x > 0.5 { 0 } else { 255 };
                p.copy_from_slice(&[0, 0, 0, a]);
            }
        }
        1 => {
            for (&x, p) in tail_s.iter().zip(tail_d.chunks_exact_mut(4)) {
                let v = mask_byte(x);
                p.copy_from_slice(&[v, v, v, 255]);
            }
        }
        _ => {
            for (&x, p) in tail_s.iter().zip(tail_d.chunks_exact_mut(4)) {
                let v = mask_byte(x);
                p.copy_from_slice(&[255, 255, 255, v]);
            }
        }
    }
}

/// Bounding box `[x0, y0, x1, y1]` (right and bottom exclusive) of the pixels of `data` (w x h) with `v > 0.5`
/// written into `bounds` (4 i32). Returns 1 when any pixel was > 0.5, else 0.
pub fn mask_bounds_f32(data: &[f32], w: usize, h: usize, bounds: &mut [i32]) -> i32 {
    if w == 0 || h == 0 || data.len() < w * h {
        return 0;
    }
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
    let mut any = false;
    for (y, row) in data[..w * h].chunks_exact(w).enumerate() {
        let Some((first, last)) = lanes::row_bounds(row) else { continue };
        any = true;
        x0 = x0.min(first);
        x1 = x1.max(last + 1);
        if y < y0 {
            y0 = y;
        }
        y1 = y + 1;
    }
    if !any {
        return 0;
    }
    bounds[0] = x0 as i32;
    bounds[1] = y0 as i32;
    bounds[2] = x1 as i32;
    bounds[3] = y1 as i32;
    1
}

/// Matches the weighted RGB mean and standard deviation of `patch` (`n * 4` RGBA8 bytes, in place) to `reference`
/// (`n * 4` RGBA8 bytes) under `weight` (`n` f32, `stitch.js` `colorMatch`). Returns 0 when the clamped weight sum is
/// below 64 (leaving `patch` untouched), else 1.
pub fn color_match_rgba(patch: &mut [u8], reference: &[u8], weight: &[f32]) -> u32 {
    let n = weight.len().min(patch.len() / 4).min(reference.len() / 4);
    let mut total = 0.0f64;
    for &w in &weight[..n] {
        let cw = if w.is_nan() {
            f64::NAN
        } else if w > 0.0 {
            w.min(1.0) as f64
        } else {
            0.0
        };
        total += cw;
    }
    if total < 64.0 {
        return 0;
    }
    let (r_mean, r_v, t_mean, t_v) = lanes::color_match_stats(&patch[..n * 4], &reference[..n * 4], &weight[..n], total);
    let floor = 1e-6 * 255.0 * 255.0;
    let std_of = |v: f64| -> f64 {
        let x = v / total;
        if x.is_nan() {
            f64::NAN
        } else if x > floor {
            x.sqrt()
        } else {
            floor.sqrt()
        }
    };
    let mut scale = [0.0f64; 3];
    for c in 0..3 {
        let q = std_of(r_v[c]) / std_of(t_v[c]);
        scale[c] = if q.is_nan() {
            f64::NAN
        } else if q < 0.5 {
            0.5
        } else if q > 2.0 {
            2.0
        } else {
            q
        };
    }
    let done = lanes::color_match_apply(&mut patch[..n * 4], &t_mean, &scale, &r_mean);
    for p in patch[done * 4..n * 4].chunks_exact_mut(4) {
        for c in 0..3 {
            p[c] = clamp8((p[c] as f64 - t_mean[c]) * scale[c] + r_mean[c]);
        }
    }
    1
}

/// The alpha byte of each pixel of `rgba` (`n * 4` bytes) set to `Math.round(clamp01(mask[i]) * (keep_alpha ? a : 255))`.
pub fn blend_alpha(rgba: &mut [u8], mask: &[f32], keep_alpha: bool) {
    let n = mask.len().min(rgba.len() / 4);
    let done = lanes::blend_alpha(&mut rgba[..n * 4], &mask[..n], keep_alpha);
    let tail_m = &mask[done..n];
    let tail_d = &mut rgba[done * 4..n * 4];
    if keep_alpha {
        for (&x, p) in tail_m.iter().zip(tail_d.chunks_exact_mut(4)) {
            let c = if x > 0.0 { x.min(1.0) as f64 } else { 0.0 };
            p[3] = (c * (p[3] as f64) + 0.5) as u8;
        }
    } else {
        for (&x, p) in tail_m.iter().zip(tail_d.chunks_exact_mut(4)) {
            p[3] = mask_byte(x);
        }
    }
}

#[inline(always)]
fn shrink_row_full(rgba_row: &[u8], g_row: &mut [f32], a_row: &mut [f32]) {
    let w = g_row.len().min(a_row.len()).min(rgba_row.len() / 4);
    let done = lanes::shrink_row(&rgba_row[..w * 4], &mut g_row[..w], &mut a_row[..w]);
    for x in done..w {
        let j = x * 4;
        let al = (rgba_row[j + 3] as f64) / 255.0;
        a_row[x] = al as f32;
        g_row[x] = ((al * ((0.299 * (rgba_row[j] as f64) + 0.587 * (rgba_row[j + 1] as f64)) + 0.114 * (rgba_row[j + 2] as f64))) / 255.0) as f32;
    }
}

/// Fused area-average shrink of straight-alpha RGBA8 `rgba` (`w * h * 4` bytes) to `{ gray, alpha }` (`tw * th` f32
/// each, `edgefit.js` `shrinkRGBA`). `a[i]` is stored as `f32` while `g[i]` multiplies by the unrounded `f64` alpha.
pub fn edgefit_shrink(rgba: &[u8], w: usize, h: usize, tw: usize, th: usize, gray: &mut [f32], alpha: &mut [f32]) {
    if w == 0 || h == 0 || tw == 0 || th == 0 {
        return;
    }
    if tw == w && th == h {
        for y in 0..h {
            let row = y * w;
            shrink_row_full(&rgba[row * 4..(row + w) * 4], &mut gray[row..row + w], &mut alpha[row..row + w]);
            for i in row..row + w {
                let a = alpha[i] as f64;
                gray[i] = if a > 1e-4 { ((gray[i] as f64) / a) as f32 } else { 0.0 };
            }
        }
        return;
    }
    let fx = (w as f64) / (tw as f64);
    let fy = (h as f64) / (th as f64);
    let mut x_bounds = Vec::with_capacity(tw);
    for x in 0..tw {
        let x0 = (((x as f64) * fx).floor() as usize).min(w - 1);
        let x1 = (((x + 1) as f64) * fx).floor() as usize;
        let x1 = x1.min(w).max(x0 + 1);
        x_bounds.push((x0, x1));
    }
    let mut g_row = vec![0.0f32; w];
    let mut a_row = vec![0.0f32; w];
    let mut sg_acc = vec![0.0f64; tw];
    let mut sa_acc = vec![0.0f64; tw];
    let mut cached_yy = usize::MAX;
    for y in 0..th {
        let y0 = (((y as f64) * fy).floor() as usize).min(h - 1);
        let y1 = (((y + 1) as f64) * fy).floor() as usize;
        let y1 = y1.min(h).max(y0 + 1);
        sg_acc.fill(0.0);
        sa_acc.fill(0.0);
        for yy in y0..y1 {
            if yy != cached_yy {
                let r = yy * w * 4;
                shrink_row_full(&rgba[r..r + w * 4], &mut g_row, &mut a_row);
                cached_yy = yy;
            }
            for x in 0..tw {
                let (x0, x1) = x_bounds[x];
                let mut sg = sg_acc[x];
                let mut sa = sa_acc[x];
                for xx in x0..x1 {
                    sg += g_row[xx] as f64;
                    sa += a_row[xx] as f64;
                }
                sg_acc[x] = sg;
                sa_acc[x] = sa;
            }
        }
        let dy = y1 - y0;
        let out_row = y * tw;
        for x in 0..tw {
            let (x0, x1) = x_bounds[x];
            let count = (dy * (x1 - x0)) as f64;
            let gs = (sg_acc[x] / count) as f32;
            let as_val = (sa_acc[x] / count) as f32;
            alpha[out_row + x] = as_val;
            gray[out_row + x] = if (as_val as f64) > 1e-4 {
                ((gs as f64) / (as_val as f64)) as f32
            } else {
                0.0
            };
        }
    }
}

#[inline(always)]
fn js_clamp_coord(v: f64, hi: f64) -> f64 {
    if v.is_nan() {
        f64::NAN
    } else if !(v > 0.0) {
        0.0
    } else if v > hi {
        hi
    } else {
        v
    }
}

#[inline(always)]
fn js_or_zero(v: f64) -> i32 {
    if !v.is_finite() { 0 } else { v as i32 }
}

/// Bilinear inverse-affine warp of RGBA8 `src` (`w * h * 4` bytes) into `dst` (`w * h * 4` bytes) under `m` (`edgefit.js` `warpRGBA`).
pub fn warp_rgba(src: &[u8], dst: &mut [u8], w: usize, h: usize, m: [f64; 6]) {
    if w == 0 || h == 0 {
        return;
    }
    if lanes::warp_rgba(src, dst, w, h, m) {
        return;
    }
    let [a00, a01, tx, a10, a11, ty] = m;
    let cap_x = (w - 1) as f64;
    let cap_y = (h - 1) as f64;
    let max_x0 = (w as i32) - 2;
    let max_y0 = (h as i32) - 2;
    let dx = if w > 1 { 4 } else { 0 };
    let dy = if h > 1 { w * 4 } else { 0 };
    let mut o = 0;
    for y in 0..h {
        let ay_x = a01 * (y as f64);
        let ay_y = a11 * (y as f64);
        for x in 0..w {
            let cap_xx = js_clamp_coord((a00 * (x as f64) + ay_x) + tx, cap_x);
            let cap_yy = js_clamp_coord((a10 * (x as f64) + ay_y) + ty, cap_y);
            let x0 = js_or_zero(cap_xx).min(max_x0);
            let y0 = js_or_zero(cap_yy).min(max_y0);
            let fx = if w > 1 { cap_xx - (x0 as f64) } else { 0.0 };
            let fy = if h > 1 { cap_yy - (y0 as f64) } else { 0.0 };
            let j = ((y0.max(0) as usize) * w + (x0.max(0) as usize)) * 4;
            for c in 0..4 {
                let t = (src[j + c] as f64) * (1.0 - fx) + (src[j + dx + c] as f64) * fx;
                let b = (src[j + dy + c] as f64) * (1.0 - fx) + (src[j + dy + dx + c] as f64) * fx;
                dst[o + c] = clamp8(t * (1.0 - fy) + b * fy);
            }
            o += 4;
        }
    }
}

#[inline(always)]
fn js_min2_f64(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        f64::from_bits(a.to_bits() | b.to_bits())
    } else if a < b {
        a
    } else {
        b
    }
}

/// Per-pixel source-bounds coverage mask (`w * h` f32 in `dst`, 1 inside, 1 px ramp to 0 outside) for `m` (`edgefit.js` `warpCoverage`).
pub fn warp_coverage(dst: &mut [f32], w: usize, h: usize, m: [f64; 6]) {
    if w == 0 || h == 0 {
        return;
    }
    if lanes::warp_coverage(dst, w, h, m) {
        return;
    }
    let [a00, a01, tx, a10, a11, ty] = m;
    let cap_x = (w - 1) as f64;
    let cap_y = (h - 1) as f64;
    let mut i = 0;
    for y in 0..h {
        let ay_x = a01 * (y as f64);
        let ay_y = a11 * (y as f64);
        for x in 0..w {
            let xx = (a00 * (x as f64) + ay_x) + tx;
            let yy = (a10 * (x as f64) + ay_y) + ty;
            let d = js_min2_f64(js_min2_f64(js_min2_f64(xx, cap_x - xx), yy), cap_y - yy) + 1.0;
            dst[i] = if d.is_nan() {
                f32::from_bits(0xffc0_0000)
            } else if d >= 1.0 {
                1.0
            } else if d <= 0.0 {
                0.0
            } else {
                d as f32
            };
            i += 1;
        }
    }
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
/// `boxCols`, k = 1 / (2r + 1)). The two can differ in a sum's last f64 bit, so each caller keeps its twin's; on the
/// dab blur's byte-derived values that difference never reached a byte (K26's review), on wide-range floats it does.
#[derive(Clone, Copy)]
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

    #[inline(always)]
    pub fn alpha_to_mask(_: &[u8], _: &mut [f32]) -> usize {
        0
    }

    #[inline(always)]
    pub fn mask_max_clamp(_: &mut [f32], _: Option<&[f32]>, _: bool) -> usize {
        0
    }

    #[inline(always)]
    pub fn mask_one_minus(_: &mut [f32]) -> usize {
        0
    }

    #[inline(always)]
    pub fn mask_to_rgba(_: &[f32], _: &mut [u8], _: u32) -> usize {
        0
    }

    #[inline(always)]
    pub fn row_bounds(row: &[f32]) -> Option<(usize, usize)> {
        let first = row.iter().position(|&v| v > 0.5)?;
        let last = first + row[first..].iter().rposition(|&v| v > 0.5).unwrap_or(0);
        Some((first, last))
    }

    pub fn color_match_stats(patch: &[u8], reference: &[u8], weight: &[f32], total: f64) -> ([f64; 3], [f64; 3], [f64; 3], [f64; 3]) {
        let stats = |d: &[u8]| -> ([f64; 3], [f64; 3]) {
            let mut mean = [0.0f64; 3];
            let mut v = [0.0f64; 3];
            for (i, &wt) in weight.iter().enumerate() {
                if wt <= 0.0 {
                    continue;
                }
                let w = wt as f64;
                let j = i * 4;
                mean[0] += d[j] as f64 * w;
                mean[1] += d[j + 1] as f64 * w;
                mean[2] += d[j + 2] as f64 * w;
            }
            for m in &mut mean {
                *m /= total;
            }
            for (i, &wt) in weight.iter().enumerate() {
                if wt <= 0.0 {
                    continue;
                }
                let w = wt as f64;
                let j = i * 4;
                for c in 0..3 {
                    let dd = d[j + c] as f64 - mean[c];
                    v[c] += dd * dd * w;
                }
            }
            (mean, v)
        };
        let (r_mean, r_v) = stats(reference);
        let (t_mean, t_v) = stats(patch);
        (r_mean, r_v, t_mean, t_v)
    }

    #[inline(always)]
    pub fn color_match_apply(_: &mut [u8], _: &[f64; 3], _: &[f64; 3], _: &[f64; 3]) -> usize {
        0
    }

    #[inline(always)]
    pub fn blend_alpha(_: &mut [u8], _: &[f32], _: bool) -> usize {
        0
    }

    #[inline(always)]
    pub fn shrink_row(_: &[u8], _: &mut [f32], _: &mut [f32]) -> usize {
        0
    }

    #[inline(always)]
    pub fn warp_rgba(_: &[u8], _: &mut [u8], _: usize, _: usize, _: [f64; 6]) -> bool {
        false
    }

    #[inline(always)]
    pub fn warp_coverage(_: &mut [f32], _: usize, _: usize, _: [f64; 6]) -> bool {
        false
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

    /// `f32x4_max` / `f32x4_min` canonicalise a NaN lane to `0x7fc0_0000`; V8's `Math.max` / `Math.min` writes `0xffc0_0000`.
    #[inline(always)]
    fn nan_sign(m: v128) -> v128 {
        v128_or(m, v128_and(f32x4_ne(m, m), u32x4_splat(0x8000_0000)))
    }

    pub fn alpha_to_mask(rgba: &[u8], dst: &mut [f32]) -> usize {
        let n4 = dst.len().min(rgba.len() / 4) / 4 * 4;
        let (s, d) = (rgba.as_ptr(), dst.as_mut_ptr());
        let v255 = f64x2_splat(255.0);
        unsafe {
            let mut i = 0;
            while i < n4 {
                let q = f32x4_convert_u32x4(u32x4_shr(v128_load(s.add(i * 4) as *const v128), 24));
                let lo = f64x2_div(f64x2_promote_low_f32x4(q), v255);
                let hi = f64x2_div(high(q), v255);
                v128_store(d.add(i) as *mut v128, pack(lo, hi));
                i += 4;
            }
        }
        n4
    }

    pub fn mask_max_clamp(dst: &mut [f32], b: Option<&[f32]>, clamp: bool) -> usize {
        let n = match b {
            Some(b) => dst.len().min(b.len()),
            None => dst.len(),
        };
        let n4 = n / 4 * 4;
        let d = dst.as_mut_ptr();
        let (zero, one) = (f32x4_splat(0.0), f32x4_splat(1.0));
        unsafe {
            match (b, clamp) {
                (Some(b), true) => {
                    let bp = b.as_ptr();
                    let mut i = 0;
                    while i < n4 {
                        let qa = v128_load(d.add(i) as *const v128);
                        let qb = v128_load(bp.add(i) as *const v128);
                        let m = f32x4_min(one, f32x4_max(zero, f32x4_max(qa, qb)));
                        v128_store(d.add(i) as *mut v128, nan_sign(m));
                        i += 4;
                    }
                }
                (Some(b), false) => {
                    let bp = b.as_ptr();
                    let mut i = 0;
                    while i < n4 {
                        let qa = v128_load(d.add(i) as *const v128);
                        let qb = v128_load(bp.add(i) as *const v128);
                        let m = f32x4_max(qa, qb);
                        v128_store(d.add(i) as *mut v128, nan_sign(m));
                        i += 4;
                    }
                }
                (None, true) => {
                    let mut i = 0;
                    while i < n4 {
                        let qa = v128_load(d.add(i) as *const v128);
                        let m = f32x4_min(one, f32x4_max(zero, qa));
                        v128_store(d.add(i) as *mut v128, nan_sign(m));
                        i += 4;
                    }
                }
                (None, false) => return n,
            }
        }
        n4
    }

    pub fn mask_one_minus(data: &mut [f32]) -> usize {
        let n4 = data.len() / 4 * 4;
        let d = data.as_mut_ptr();
        let one = f32x4_splat(1.0);
        unsafe {
            let mut i = 0;
            while i < n4 {
                let q = v128_load(d.add(i) as *const v128);
                v128_store(d.add(i) as *mut v128, f32x4_sub(one, q));
                i += 4;
            }
        }
        n4
    }

    pub fn mask_to_rgba(src: &[f32], dst: &mut [u8], mode: u32) -> usize {
        let n4 = src.len().min(dst.len() / 4) / 4 * 4;
        let (s, d) = (src.as_ptr(), dst.as_mut_ptr());
        unsafe {
            if mode == 2 {
                let half = f32x4_splat(0.5);
                let opaque = u32x4_splat(0xff00_0000);
                let mut i = 0;
                while i < n4 {
                    let q = v128_load(s.add(i) as *const v128);
                    let px = v128_andnot(opaque, f32x4_gt(q, half));
                    v128_store(d.add(i * 4) as *mut v128, px);
                    i += 4;
                }
            } else {
                let (zero, one) = (f32x4_splat(0.0), f32x4_splat(1.0));
                let (v255, vhalf) = (f64x2_splat(255.0), f64x2_splat(0.5));
                let (rgb_scale, a_hi) = (u32x4_splat(0x0001_0101), u32x4_splat(0xff00_0000));
                let rgb_white = u32x4_splat(0x00ff_ffff);
                let mut i = 0;
                while i < n4 {
                    let q = f32x4_pmin(one, f32x4_pmax(zero, v128_load(s.add(i) as *const v128)));
                    let lo = i32x4_trunc_sat_f64x2_zero(f64x2_add(f64x2_mul(f64x2_promote_low_f32x4(q), v255), vhalf));
                    let hi = i32x4_trunc_sat_f64x2_zero(f64x2_add(f64x2_mul(high(q), v255), vhalf));
                    let v = i64x2_shuffle::<0, 2>(lo, hi);
                    let px = if mode == 1 {
                        v128_or(u32x4_mul(v, rgb_scale), a_hi)
                    } else {
                        v128_or(u32x4_shl(v, 24), rgb_white)
                    };
                    v128_store(d.add(i * 4) as *mut v128, px);
                    i += 4;
                }
            }
        }
        n4
    }

    pub fn row_bounds(row: &[f32]) -> Option<(usize, usize)> {
        let n = row.len();
        let n4 = n / 4 * 4;
        let p = row.as_ptr();
        let half = f32x4_splat(0.5);
        let mut i = 0;
        let mut first = None;
        unsafe {
            while i < n4 {
                let q = v128_load(p.add(i) as *const v128);
                if v128_any_true(f32x4_gt(q, half)) {
                    for k in i..i + 4 {
                        if *p.add(k) > 0.5 {
                            first = Some(k);
                            break;
                        }
                    }
                    break;
                }
                i += 4;
            }
        }
        if first.is_none() {
            for k in n4..n {
                if row[k] > 0.5 {
                    first = Some(k);
                    break;
                }
            }
        }
        let first = first?;
        for k in (n4.max(first)..n).rev() {
            if row[k] > 0.5 {
                return Some((first, k));
            }
        }
        let mut j = n4;
        unsafe {
            while j >= first + 4 {
                j -= 4;
                let q = v128_load(p.add(j) as *const v128);
                if v128_any_true(f32x4_gt(q, half)) {
                    for k in (j..j + 4).rev() {
                        if *p.add(k) > 0.5 {
                            return Some((first, k));
                        }
                    }
                }
            }
        }
        for k in (first..j).rev() {
            if row[k] > 0.5 {
                return Some((first, k));
            }
        }
        Some((first, first))
    }

    pub fn color_match_stats(patch: &[u8], reference: &[u8], weight: &[f32], total: f64) -> ([f64; 3], [f64; 3], [f64; 3], [f64; 3]) {
        let n = weight.len().min(patch.len() / 4).min(reference.len() / 4);
        let (tp, rp, wp) = (patch.as_ptr(), reference.as_ptr(), weight.as_ptr());
        unsafe {
            let (mut m0, mut m1, mut m2) = (f64x2_splat(0.0), f64x2_splat(0.0), f64x2_splat(0.0));
            for i in 0..n {
                let wt = *wp.add(i);
                if wt <= 0.0 {
                    continue;
                }
                let vw = f64x2_splat(wt as f64);
                let j = i * 4;
                m0 = f64x2_add(m0, f64x2_mul(f64x2(*rp.add(j) as f64, *tp.add(j) as f64), vw));
                m1 = f64x2_add(m1, f64x2_mul(f64x2(*rp.add(j + 1) as f64, *tp.add(j + 1) as f64), vw));
                m2 = f64x2_add(m2, f64x2_mul(f64x2(*rp.add(j + 2) as f64, *tp.add(j + 2) as f64), vw));
            }
            let vtotal = f64x2_splat(total);
            m0 = f64x2_div(m0, vtotal);
            m1 = f64x2_div(m1, vtotal);
            m2 = f64x2_div(m2, vtotal);
            let (mut v0, mut v1, mut v2) = (f64x2_splat(0.0), f64x2_splat(0.0), f64x2_splat(0.0));
            for i in 0..n {
                let wt = *wp.add(i);
                if wt <= 0.0 {
                    continue;
                }
                let vw = f64x2_splat(wt as f64);
                let j = i * 4;
                let d0 = f64x2_sub(f64x2(*rp.add(j) as f64, *tp.add(j) as f64), m0);
                let d1 = f64x2_sub(f64x2(*rp.add(j + 1) as f64, *tp.add(j + 1) as f64), m1);
                let d2 = f64x2_sub(f64x2(*rp.add(j + 2) as f64, *tp.add(j + 2) as f64), m2);
                v0 = f64x2_add(v0, f64x2_mul(f64x2_mul(d0, d0), vw));
                v1 = f64x2_add(v1, f64x2_mul(f64x2_mul(d1, d1), vw));
                v2 = f64x2_add(v2, f64x2_mul(f64x2_mul(d2, d2), vw));
            }
            (
                [f64x2_extract_lane::<0>(m0), f64x2_extract_lane::<0>(m1), f64x2_extract_lane::<0>(m2)],
                [f64x2_extract_lane::<0>(v0), f64x2_extract_lane::<0>(v1), f64x2_extract_lane::<0>(v2)],
                [f64x2_extract_lane::<1>(m0), f64x2_extract_lane::<1>(m1), f64x2_extract_lane::<1>(m2)],
                [f64x2_extract_lane::<1>(v0), f64x2_extract_lane::<1>(v1), f64x2_extract_lane::<1>(v2)],
            )
        }
    }

    pub fn color_match_apply(patch: &mut [u8], t_mean: &[f64; 3], scale: &[f64; 3], r_mean: &[f64; 3]) -> usize {
        let n4 = (patch.len() / 4) / 4 * 4;
        let d = patch.as_mut_ptr();
        unsafe {
            let (tm0, tm1, tm2) = (f64x2_splat(t_mean[0]), f64x2_splat(t_mean[1]), f64x2_splat(t_mean[2]));
            let (sc0, sc1, sc2) = (f64x2_splat(scale[0]), f64x2_splat(scale[1]), f64x2_splat(scale[2]));
            let (rm0, rm1, rm2) = (f64x2_splat(r_mean[0]), f64x2_splat(r_mean[1]), f64x2_splat(r_mean[2]));
            let (zero, f255) = (f64x2_splat(0.0), f64x2_splat(255.0));
            let b8 = u32x4_splat(0xff);
            let a_mask = u32x4_splat(0xff00_0000);
            let ch = |v: v128, tm: v128, sc: v128, rm: v128| -> v128 {
                let lo = f64x2_convert_low_i32x4(v);
                let hi = f64x2_convert_low_i32x4(i32x4_shuffle::<2, 3, 2, 3>(v, v));
                let r_lo = f64x2_nearest(f64x2_add(f64x2_mul(f64x2_sub(lo, tm), sc), rm));
                let r_hi = f64x2_nearest(f64x2_add(f64x2_mul(f64x2_sub(hi, tm), sc), rm));
                let c_lo = i32x4_trunc_sat_f64x2_zero(f64x2_pmin(f255, f64x2_pmax(zero, r_lo)));
                let c_hi = i32x4_trunc_sat_f64x2_zero(f64x2_pmin(f255, f64x2_pmax(zero, r_hi)));
                i64x2_shuffle::<0, 2>(c_lo, c_hi)
            };
            let mut i = 0;
            while i < n4 {
                let px = v128_load(d.add(i * 4) as *const v128);
                let r = ch(v128_and(px, b8), tm0, sc0, rm0);
                let g = ch(v128_and(u32x4_shr(px, 8), b8), tm1, sc1, rm1);
                let b = ch(v128_and(u32x4_shr(px, 16), b8), tm2, sc2, rm2);
                let out = v128_or(v128_or(r, u32x4_shl(g, 8)), v128_or(u32x4_shl(b, 16), v128_and(px, a_mask)));
                v128_store(d.add(i * 4) as *mut v128, out);
                i += 4;
            }
        }
        n4
    }

    pub fn blend_alpha(rgba: &mut [u8], mask: &[f32], keep_alpha: bool) -> usize {
        let n4 = mask.len().min(rgba.len() / 4) / 4 * 4;
        let (d, m) = (rgba.as_mut_ptr(), mask.as_ptr());
        let (zero, one) = (f32x4_splat(0.0), f32x4_splat(1.0));
        let vhalf = f64x2_splat(0.5);
        let rgb_mask = u32x4_splat(0x00ff_ffff);
        unsafe {
            if keep_alpha {
                let mut i = 0;
                while i < n4 {
                    let px = v128_load(d.add(i * 4) as *const v128);
                    let q = f32x4_pmin(one, f32x4_pmax(zero, v128_load(m.add(i) as *const v128)));
                    let a = f32x4_convert_u32x4(u32x4_shr(px, 24));
                    let lo = i32x4_trunc_sat_f64x2_zero(f64x2_add(
                        f64x2_mul(f64x2_promote_low_f32x4(q), f64x2_promote_low_f32x4(a)),
                        vhalf,
                    ));
                    let hi = i32x4_trunc_sat_f64x2_zero(f64x2_add(f64x2_mul(high(q), high(a)), vhalf));
                    let v = i64x2_shuffle::<0, 2>(lo, hi);
                    v128_store(d.add(i * 4) as *mut v128, v128_or(v128_and(px, rgb_mask), u32x4_shl(v, 24)));
                    i += 4;
                }
            } else {
                let v255 = f64x2_splat(255.0);
                let mut i = 0;
                while i < n4 {
                    let px = v128_load(d.add(i * 4) as *const v128);
                    let q = f32x4_pmin(one, f32x4_pmax(zero, v128_load(m.add(i) as *const v128)));
                    let lo = i32x4_trunc_sat_f64x2_zero(f64x2_add(f64x2_mul(f64x2_promote_low_f32x4(q), v255), vhalf));
                    let hi = i32x4_trunc_sat_f64x2_zero(f64x2_add(f64x2_mul(high(q), v255), vhalf));
                    let v = i64x2_shuffle::<0, 2>(lo, hi);
                    v128_store(d.add(i * 4) as *mut v128, v128_or(v128_and(px, rgb_mask), u32x4_shl(v, 24)));
                    i += 4;
                }
            }
        }
        n4
    }

    #[inline(always)]
    fn hi_i32_to_f64(v: v128) -> v128 {
        f64x2_convert_low_i32x4(i32x4_shuffle::<2, 3, 2, 3>(v, v))
    }

    pub fn shrink_row(rgba_row: &[u8], g_row: &mut [f32], a_row: &mut [f32]) -> usize {
        let n4 = g_row.len().min(a_row.len()).min(rgba_row.len() / 4) / 4 * 4;
        let (s, gp, ap) = (rgba_row.as_ptr(), g_row.as_mut_ptr(), a_row.as_mut_ptr());
        let v255 = f64x2_splat(255.0);
        let (c_r, c_g, c_b) = (f64x2_splat(0.299), f64x2_splat(0.587), f64x2_splat(0.114));
        let b8 = u32x4_splat(0xff);
        let vzero = f32x4_splat(0.0);
        unsafe {
            let mut x = 0;
            while x < n4 {
                let px = v128_load(s.add(x * 4) as *const v128);
                let a_u32 = u32x4_shr(px, 24);
                if !v128_any_true(a_u32) {
                    v128_store(ap.add(x) as *mut v128, vzero);
                    v128_store(gp.add(x) as *mut v128, vzero);
                } else {
                    let r_u32 = v128_and(px, b8);
                    let g_u32 = v128_and(u32x4_shr(px, 8), b8);
                    let b_u32 = v128_and(u32x4_shr(px, 16), b8);
                    let al_lo = f64x2_div(f64x2_convert_low_i32x4(a_u32), v255);
                    let al_hi = f64x2_div(hi_i32_to_f64(a_u32), v255);
                    let lum_lo = f64x2_add(
                        f64x2_add(f64x2_mul(c_r, f64x2_convert_low_i32x4(r_u32)), f64x2_mul(c_g, f64x2_convert_low_i32x4(g_u32))),
                        f64x2_mul(c_b, f64x2_convert_low_i32x4(b_u32)),
                    );
                    let lum_hi = f64x2_add(
                        f64x2_add(f64x2_mul(c_r, hi_i32_to_f64(r_u32)), f64x2_mul(c_g, hi_i32_to_f64(g_u32))),
                        f64x2_mul(c_b, hi_i32_to_f64(b_u32)),
                    );
                    let gr_lo = f64x2_div(f64x2_mul(al_lo, lum_lo), v255);
                    let gr_hi = f64x2_div(f64x2_mul(al_hi, lum_hi), v255);
                    v128_store(ap.add(x) as *mut v128, pack(al_lo, al_hi));
                    v128_store(gp.add(x) as *mut v128, pack(gr_lo, gr_hi));
                }
                x += 4;
            }
        }
        n4
    }

    pub fn warp_rgba(src: &[u8], dst: &mut [u8], w: usize, h: usize, m: [f64; 6]) -> bool {
        if w < 2 || h < 2 || src.len() < w * h * 4 || dst.len() < w * h * 4 || !m.iter().all(|v| v.is_finite()) {
            return false;
        }
        let [a00, a01, tx, a10, a11, ty] = m;
        let cap_x = (w - 1) as f64;
        let cap_y = (h - 1) as f64;
        let max_x0 = (w - 2) as i32;
        let max_y0 = (h - 2) as i32;
        let dy = w * 4;
        let (s, d) = (src.as_ptr(), dst.as_mut_ptr());
        unsafe {
            let mut o = 0;
            for y in 0..h {
                let ay_x = a01 * (y as f64);
                let ay_y = a11 * (y as f64);
                for x in 0..w {
                    let raw_x = (a00 * (x as f64) + ay_x) + tx;
                    let raw_y = (a10 * (x as f64) + ay_y) + ty;
                    let xx = if raw_x > 0.0 { raw_x.min(cap_x) } else { 0.0 };
                    let yy = if raw_y > 0.0 { raw_y.min(cap_y) } else { 0.0 };
                    let x0 = (xx as i32).min(max_x0);
                    let y0 = (yy as i32).min(max_y0);
                    let fx = xx - (x0 as f64);
                    let fy = yy - (y0 as f64);
                    let vfx = f64x2_splat(fx);
                    let v1fx = f64x2_splat(1.0 - fx);
                    let vfy = f64x2_splat(fy);
                    let v1fy = f64x2_splat(1.0 - fy);
                    let j = (y0 as usize * w + x0 as usize) * 4;
                    let top8 = u16x8_extend_low_u8x16(v128_load64_zero(s.add(j) as *const u64));
                    let bot8 = u16x8_extend_low_u8x16(v128_load64_zero(s.add(j + dy) as *const u64));
                    let top32 = u32x4_extend_low_u16x8(top8);
                    let top32_r = u32x4_extend_high_u16x8(top8);
                    let bot32 = u32x4_extend_low_u16x8(bot8);
                    let bot32_r = u32x4_extend_high_u16x8(bot8);
                    let t_rg = f64x2_add(f64x2_mul(f64x2_convert_low_i32x4(top32), v1fx), f64x2_mul(f64x2_convert_low_i32x4(top32_r), vfx));
                    let b_rg = f64x2_add(f64x2_mul(f64x2_convert_low_i32x4(bot32), v1fx), f64x2_mul(f64x2_convert_low_i32x4(bot32_r), vfx));
                    let v_rg = f64x2_nearest(f64x2_add(f64x2_mul(t_rg, v1fy), f64x2_mul(b_rg, vfy)));
                    let t_ba = f64x2_add(f64x2_mul(hi_i32_to_f64(top32), v1fx), f64x2_mul(hi_i32_to_f64(top32_r), vfx));
                    let b_ba = f64x2_add(f64x2_mul(hi_i32_to_f64(bot32), v1fx), f64x2_mul(hi_i32_to_f64(bot32_r), vfx));
                    let v_ba = f64x2_nearest(f64x2_add(f64x2_mul(t_ba, v1fy), f64x2_mul(b_ba, vfy)));
                    let i_rg = i32x4_trunc_sat_f64x2_zero(v_rg);
                    let i_ba = i32x4_trunc_sat_f64x2_zero(v_ba);
                    let i_rgba = i64x2_shuffle::<0, 2>(i_rg, i_ba);
                    let u16_rgba = i16x8_narrow_i32x4(i_rgba, i_rgba);
                    let u8_rgba = u8x16_narrow_i16x8(u16_rgba, u16_rgba);
                    v128_store32_lane::<0>(u8_rgba, d.add(o) as *mut u32);
                    o += 4;
                }
            }
        }
        true
    }

    pub fn warp_coverage(dst: &mut [f32], w: usize, h: usize, m: [f64; 6]) -> bool {
        if dst.len() < w * h || !m.iter().all(|v| v.is_finite()) {
            return false;
        }
        let [a00, a01, tx, a10, a11, ty] = m;
        let cap_x = (w - 1) as f64;
        let cap_y = (h - 1) as f64;
        let va00 = f64x2_splat(a00);
        let va10 = f64x2_splat(a10);
        let vtx = f64x2_splat(tx);
        let vty = f64x2_splat(ty);
        let vcap_x = f64x2_splat(cap_x);
        let vcap_y = f64x2_splat(cap_y);
        let vzero = f64x2_splat(0.0);
        let vone = f64x2_splat(1.0);
        let w4 = w / 4 * 4;
        let d_ptr = dst.as_mut_ptr();
        unsafe {
            for y in 0..h {
                let ay_x = a01 * (y as f64);
                let ay_y = a11 * (y as f64);
                let vay0 = f64x2_splat(ay_x);
                let vay1 = f64x2_splat(ay_y);
                let row = y * w;
                let mut x = 0;
                while x < w4 {
                    let vx0 = f64x2(x as f64, (x + 1) as f64);
                    let vx1 = f64x2((x + 2) as f64, (x + 3) as f64);
                    let xx0 = f64x2_add(f64x2_add(f64x2_mul(va00, vx0), vay0), vtx);
                    let yy0 = f64x2_add(f64x2_add(f64x2_mul(va10, vx0), vay1), vty);
                    let xx1 = f64x2_add(f64x2_add(f64x2_mul(va00, vx1), vay0), vtx);
                    let yy1 = f64x2_add(f64x2_add(f64x2_mul(va10, vx1), vay1), vty);
                    let m0 = f64x2_pmin(f64x2_pmin(f64x2_pmin(xx0, f64x2_sub(vcap_x, xx0)), yy0), f64x2_sub(vcap_y, yy0));
                    let m1 = f64x2_pmin(f64x2_pmin(f64x2_pmin(xx1, f64x2_sub(vcap_x, xx1)), yy1), f64x2_sub(vcap_y, yy1));
                    let d0 = f64x2_add(m0, vone);
                    let d1 = f64x2_add(m1, vone);
                    let c0 = f64x2_pmin(vone, f64x2_pmax(vzero, d0));
                    let c1 = f64x2_pmin(vone, f64x2_pmax(vzero, d1));
                    v128_store(d_ptr.add(row + x) as *mut v128, pack(c0, c1));
                    x += 4;
                }
                for x in w4..w {
                    let xx = (a00 * (x as f64) + ay_x) + tx;
                    let yy = (a10 * (x as f64) + ay_y) + ty;
                    let d = xx.min(cap_x - xx).min(yy).min(cap_y - yy) + 1.0;
                    *d_ptr.add(row + x) = (if d >= 1.0 {
                        1.0
                    } else if d <= 0.0 {
                        0.0
                    } else {
                        d
                    }) as f32;
                }
            }
        }
        true
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
