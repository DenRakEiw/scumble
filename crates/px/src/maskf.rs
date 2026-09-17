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

fn box_rows(src: &[f32], dst: &mut [f32], w: usize, h: usize, r: usize) {
    let n = (2 * r + 1) as f64;
    for y in 0..h {
        let row = y * w;
        let mut sum = 0f64;
        for k in -(r as isize)..=(r as isize) {
            sum += src[row + (k.max(0) as usize).min(w - 1)] as f64;
        }
        for x in 0..w {
            dst[row + x] = (sum / n) as f32;
            let add = (x + r + 1).min(w - 1);
            let sub = x.saturating_sub(r);
            sum += src[row + add] as f64 - src[row + sub] as f64;
        }
    }
}

fn box_cols(src: &[f32], dst: &mut [f32], sums: &mut [f64], w: usize, h: usize, r: usize) {
    let n = (2 * r + 1) as f64;
    for s in sums.iter_mut() { *s = 0.0; }
    for k in -(r as isize)..=(r as isize) {
        let row = (k.max(0) as usize).min(h - 1) * w;
        for x in 0..w { sums[x] += src[row + x] as f64; }
    }
    for y in 0..h {
        let row = y * w;
        let add = (y + r + 1).min(h - 1) * w;
        let sub = y.saturating_sub(r) * w;
        for x in 0..w {
            dst[row + x] = (sums[x] / n) as f32;
            sums[x] += src[add + x] as f64 - src[sub + x] as f64;
        }
    }
}

/// A box blur along rows and then along columns for every radius that is not 0, in place (clamped edges).
pub fn box_blurs(data: &mut [f32], w: usize, h: usize, radii: &[usize]) {
    if w == 0 || h == 0 { return; }
    let mut tmp = vec![0f32; w * h];
    let mut sums = vec![0f64; w];
    for &r in radii {
        if r == 0 { continue; }
        box_rows(data, &mut tmp, w, h, r);
        box_cols(&tmp, data, &mut sums, w, h, r);
    }
}
