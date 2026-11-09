//! Depth map tile statistics, tile evaluation, and row alpha limiting (`docs/PLAN_WASM_BUILD.md` §4.8, K21, K22, K23 & K25).
//!
//! - `map_tile_stats` (K21): maps each tile's four corners into the depth map via the 6-element affine transform
//!   `m0..m5`, expands the bounding box by the 2-texel snap halo, clamps to `[0, mw - 1] × [0, mh - 1]` for the tile's
//!   `u16` minimum and maximum, and sets the edge flag when the unclamped 2-texel window meets `[0, mw - 1] × [0, mh - 1]`
//!   and any texel in `rmax` within the window exceeds `thresh`.
//! - `range_tiles_depth` (K22): evaluates the `"compute"`-class tiles (`classes[tx] == 2`) of one document tile row
//!   `ty` over the `wh`-row window `[wy0, wy0 + wh)` of `map` (and optional `guide` + `pic` for joint-bilateral edge
//!   snapping), in `f64` in the twin's operation order with `js_round` per lane.
//! - `range_tiles_rgba` (K23): evaluates one document tile row `ty` (`[ry0, ry1)` within `[ty * tile, min((ty + 1) * tile, h))`)
//!   over the `(ry1 - ry0)`-row RGBA8 slice of that tile row for `"luma"` (`mode == 0`, three 256-entry `f64` product
//!   tables) or `"color"` (`mode == 1`, opponent colour similarity with one `exp` per pixel).
//! - `limit_alpha_rows` (K25): multiplies the alpha byte of each pixel in a `w × h` RGBA8 band at `(x0, y0)` in place
//!   by the depth limit weight over `[wy0, wy0 + wh)` of `map` (and optional `guide` + `col` for edge snapping).

#[cfg(target_feature = "simd128")]
use core::arch::wasm32::*;

/// Returns `1` on success, `0` when a tile's vertical window `[iy0, iy1]` falls outside `[wy0, wy0 + wh)`.
#[allow(clippy::too_many_arguments)]
pub fn map_tile_stats(
    map: &[u16],
    rmax: Option<&[u16]>,
    mw: usize,
    mh: usize,
    wy0: usize,
    wh: usize,
    w: usize,
    y0: usize,
    y1: usize,
    tile: usize,
    m0: f64,
    m1: f64,
    m2: f64,
    m3: f64,
    m4: f64,
    m5: f64,
    thresh: u32,
    min_out: &mut [u16],
    max_out: &mut [u16],
    edge_out: &mut [u8],
) -> u32 {
    let cols = min_out.len();
    let max_x = (mw - 1) as f64;
    let max_y = (mh - 1) as f64;
    let yf0 = y0 as f64;
    let yf1 = y1 as f64;
    let wy1 = wy0 + wh;

    for tx in 0..cols {
        let x0 = (tx * tile) as f64;
        let x1 = ((tx + 1).saturating_mul(tile)).min(w) as f64;

        let x00 = m0 * x0 + m2 * yf0 + m4;
        let y00 = m1 * x0 + m3 * yf0 + m5;
        let x10 = m0 * x1 + m2 * yf0 + m4;
        let y10 = m1 * x1 + m3 * yf0 + m5;
        let x01 = m0 * x0 + m2 * yf1 + m4;
        let y01 = m1 * x0 + m3 * yf1 + m5;
        let x11 = m0 * x1 + m2 * yf1 + m4;
        let y11 = m1 * x1 + m3 * yf1 + m5;

        let mx0 = x00.min(x10).min(x01).min(x11);
        let my0 = y00.min(y10).min(y01).min(y11);
        let mx1 = x00.max(x10).max(x01).max(x11);
        let my1 = y00.max(y10).max(y01).max(y11);

        let rx0 = (mx0 - 2.0).floor();
        let ry0 = (my0 - 2.0).floor();
        let rx1 = (mx1 + 2.0).ceil();
        let ry1 = (my1 + 2.0).ceil();
        let meets_map = rx0 <= max_x && rx1 >= 0.0 && ry0 <= max_y && ry1 >= 0.0;

        let ix0 = rx0.max(0.0).min(max_x) as usize;
        let iy0 = ry0.max(0.0).min(max_y) as usize;
        let ix1 = rx1.max(0.0).min(max_x) as usize;
        let iy1 = ry1.max(0.0).min(max_y) as usize;

        if iy0 < wy0 || iy1 >= wy1 {
            return 0;
        }

        let mut lo: u16 = u16::MAX;
        let mut hi: u16 = 0;
        let mut has_edge = false;

        for my in iy0..=iy1 {
            let row_off = (my - wy0) * mw;
            let row_slice = &map[row_off + ix0..=row_off + ix1];
            let (r_lo, r_hi) = row_min_max(row_slice);
            if r_lo < lo {
                lo = r_lo;
            }
            if r_hi > hi {
                hi = r_hi;
            }
            if meets_map && !has_edge {
                if let Some(rm) = rmax {
                    let rmax_slice = &rm[row_off + ix0..=row_off + ix1];
                    if row_has_edge(rmax_slice, thresh) {
                        has_edge = true;
                    }
                }
            }
        }

        min_out[tx] = lo;
        max_out[tx] = hi;
        edge_out[tx] = u8::from(has_edge);
    }

    1
}

#[inline]
fn row_min_max(slice: &[u16]) -> (u16, u16) {
    #[cfg(target_feature = "simd128")]
    {
        let n = slice.len();
        let mut i = 0;
        let mut vmin = u16x8_splat(u16::MAX);
        let mut vmax = u16x8_splat(0);
        let ptr = slice.as_ptr();
        while i + 8 <= n {
            // SAFETY: i + 8 <= slice.len(), v128_load supports unaligned loads in wasm simd128.
            let v = unsafe { v128_load(ptr.add(i) as *const v128) };
            vmin = u16x8_min(vmin, v);
            vmax = u16x8_max(vmax, v);
            i += 8;
        }
        let mut lo = u16::MAX;
        let mut hi = 0u16;
        if i > 0 {
            let mut lanes_min = [0u16; 8];
            let mut lanes_max = [0u16; 8];
            unsafe {
                v128_store(lanes_min.as_mut_ptr() as *mut v128, vmin);
                v128_store(lanes_max.as_mut_ptr() as *mut v128, vmax);
            }
            for k in 0..8 {
                if lanes_min[k] < lo {
                    lo = lanes_min[k];
                }
                if lanes_max[k] > hi {
                    hi = lanes_max[k];
                }
            }
        }
        while i < n {
            let v = slice[i];
            if v < lo {
                lo = v;
            }
            if v > hi {
                hi = v;
            }
            i += 1;
        }
        (lo, hi)
    }
    #[cfg(not(target_feature = "simd128"))]
    {
        let mut lo = u16::MAX;
        let mut hi = 0u16;
        for &v in slice {
            if v < lo {
                lo = v;
            }
            if v > hi {
                hi = v;
            }
        }
        (lo, hi)
    }
}

#[inline]
fn row_has_edge(slice: &[u16], thresh: u32) -> bool {
    if thresh >= u16::MAX as u32 {
        return false;
    }
    #[cfg(target_feature = "simd128")]
    {
        let thr16 = thresh as u16;
        let n = slice.len();
        let mut i = 0;
        let ptr = slice.as_ptr();
        let mut vmax = u16x8_splat(0);
        while i + 8 <= n {
            let v = unsafe { v128_load(ptr.add(i) as *const v128) };
            vmax = u16x8_max(vmax, v);
            i += 8;
        }
        if i > 0 {
            let mut lanes = [0u16; 8];
            unsafe {
                v128_store(lanes.as_mut_ptr() as *mut v128, vmax);
            }
            for k in 0..8 {
                if lanes[k] > thr16 {
                    return true;
                }
            }
        }
        while i < n {
            if slice[i] > thr16 {
                return true;
            }
            i += 1;
        }
        false
    }
    #[cfg(not(target_feature = "simd128"))]
    {
        let thr16 = thresh as u16;
        for &v in slice {
            if v > thr16 {
                return true;
            }
        }
        false
    }
}

#[inline(always)]
fn sstep(a: f64, b: f64, x: f64) -> f64 {
    if b <= a {
        return if x >= b { 1.0 } else { 0.0 };
    }
    if x <= a {
        return 0.0;
    }
    if x >= b {
        return 1.0;
    }
    let t = (x - a) / (b - a);
    if t <= 1e-14 {
        return 0.0;
    }
    if t >= 1.0 - 1e-14 {
        return 1.0;
    }
    t * t * (3.0 - 2.0 * t)
}

#[inline(always)]
fn range_weight(v: f64, lo: f64, hi: f64, f_lo: f64, f_hi: f64, limit_invert: bool) -> f64 {
    let w_lo = if f_lo > 0.0 {
        sstep(lo - f_lo, lo, v)
    } else if v >= lo - 1e-12 {
        1.0
    } else {
        0.0
    };
    let w_hi = if f_hi > 0.0 {
        1.0 - sstep(hi, hi + f_hi, v)
    } else if v <= hi + 1e-12 {
        1.0
    } else {
        0.0
    };
    let w = w_lo * w_hi;
    if limit_invert { 1.0 - w } else { w }
}

/// JavaScript `Math.round(x)` for `x` in `0.0..=255.0`: rounds half-way cases toward `+Infinity`.
#[inline(always)]
fn js_round_byte(x: f64) -> u8 {
    let f = x.floor();
    if x - f >= 0.5 {
        (f as u8).wrapping_add(1)
    } else {
        f as u8
    }
}

#[inline(always)]
fn weight_to_alpha(v: f64, lo: f64, hi: f64, f_lo: f64, f_hi: f64, limit_invert: bool, job_invert: bool) -> u8 {
    let w = range_weight(v, lo, hi, f_lo, f_hi, limit_invert);
    let wf = if job_invert { 1.0 - w } else { w };
    js_round_byte(255.0 * wf)
}

#[inline(always)]
fn u16_bilinear(map: &[u16], mw: usize, mh: usize, wy0: usize, px: f64, py: f64) -> f64 {
    let u = px - 0.5;
    let v = py - 0.5;
    let x0 = u.floor();
    let y0 = v.floor();
    let x1 = x0 + 1.0;
    let y1 = y0 + 1.0;
    let fx = u - x0;
    let fy = v - y0;

    let max_x = (mw - 1) as f64;
    let max_y = (mh - 1) as f64;
    let cx0 = x0.max(0.0).min(max_x) as usize;
    let cx1 = x1.max(0.0).min(max_x) as usize;
    let cy0 = (y0.max(0.0).min(max_y) as usize) - wy0;
    let cy1 = (y1.max(0.0).min(max_y) as usize) - wy0;

    let r0 = cy0 * mw;
    let r1 = cy1 * mw;
    let s00 = map[r0 + cx0] as f64 / 65535.0;
    let s10 = map[r0 + cx1] as f64 / 65535.0;
    let s01 = map[r1 + cx0] as f64 / 65535.0;
    let s11 = map[r1 + cx1] as f64 / 65535.0;

    let top = s00 + fx * (s10 - s00);
    let bot = s01 + fx * (s11 - s01);
    top + fy * (bot - top)
}

#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn snap_field(
    map: &[u16],
    guide: &[u8],
    mw: usize,
    mh: usize,
    wy0: usize,
    mx: f64,
    my: f64,
    pr: f64,
    pg: f64,
    pb: f64,
    sigma_r: f64,
    tau: f64,
) -> f64 {
    if !(sigma_r > 0.0) {
        return u16_bilinear(map, mw, mh, wy0, mx, my);
    }
    let u = mx - 0.5;
    let v = my - 0.5;
    let ix = u.floor();
    let iy = v.floor();
    let max_x = (mw - 1) as f64;
    let max_y = (mh - 1) as f64;

    let cx = [
        (ix - 1.0).max(0.0).min(max_x) as usize,
        ix.max(0.0).min(max_x) as usize,
        (ix + 1.0).max(0.0).min(max_x) as usize,
        (ix + 2.0).max(0.0).min(max_x) as usize,
    ];
    let cy = [
        ((iy - 1.0).max(0.0).min(max_y) as usize) - wy0,
        (iy.max(0.0).min(max_y) as usize) - wy0,
        ((iy + 1.0).max(0.0).min(max_y) as usize) - wy0,
        ((iy + 2.0).max(0.0).min(max_y) as usize) - wy0,
    ];

    let mut lo: u16 = 65535;
    let mut hi: u16 = 0;

    for &y_off in &cy {
        let row = y_off * mw;
        for &x_off in &cx {
            let val = map[row + x_off];
            if val < lo {
                lo = val;
            }
            if val > hi {
                hi = val;
            }
        }
    }

    let range = (hi as f64 / 65535.0) - (lo as f64 / 65535.0);
    let k = sstep(tau, 2.0 * tau, range);
    if k <= 0.0 {
        return u16_bilinear(map, mw, mh, wy0, mx, my);
    }

    let dx0 = u - (ix - 1.0);
    let dx1 = u - ix;
    let dx2 = u - (ix + 1.0);
    let dx3 = u - (ix + 2.0);
    let dx2_arr = [dx0 * dx0, dx1 * dx1, dx2 * dx2, dx3 * dx3];

    let inv_2_sigma_r2 = 0.5 / (sigma_r * sigma_r);
    let mut num = 0.0;
    let mut den = 0.0;

    for (j, &y_off) in cy.iter().enumerate() {
        let ty = iy + (j as isize - 1) as f64;
        let dist_y = v - ty;
        let dist_y2 = dist_y * dist_y;
        let row_idx = y_off * mw;

        for (i, &x_off) in cx.iter().enumerate() {
            let dist_spatial2 = dx2_arr[i] + dist_y2;
            let idx = row_idx + x_off;
            let g_idx = idx * 4;
            let gr = guide[g_idx] as f64 / 255.0;
            let gg = guide[g_idx + 1] as f64 / 255.0;
            let gb = guide[g_idx + 2] as f64 / 255.0;

            let dr = pr - gr;
            let dg = pg - gg;
            let db = pb - gb;
            let dist_color2 = dr * dr + dg * dg + db * db;

            let w_spatial = (-0.5 * dist_spatial2).exp();
            let w_color = (-dist_color2 * inv_2_sigma_r2).exp();
            let weight = w_spatial * w_color;

            let m_val = map[idx] as f64 / 65535.0;
            num += weight * m_val;
            den += weight;
        }
    }

    let bil = u16_bilinear(map, mw, mh, wy0, mx, my);
    if !(den > 1e-6) {
        return bil;
    }
    let snapped = num / den;
    bil + k * (snapped - bil)
}

#[cfg(target_feature = "simd128")]
#[inline(always)]
fn sstep_f64x2(a: f64, b: f64, x_v: v128) -> v128 {
    let zero_v = f64x2_splat(0.0);
    let one_v = f64x2_splat(1.0);
    if b <= a {
        let b_v = f64x2_splat(b);
        return v128_and(f64x2_ge(x_v, b_v), one_v);
    }
    let a_v = f64x2_splat(a);
    let le_a = f64x2_le(x_v, a_v);
    if i64x2_all_true(le_a) {
        return zero_v;
    }
    let b_v = f64x2_splat(b);
    let ge_b = f64x2_ge(x_v, b_v);
    if i64x2_all_true(ge_b) {
        return one_v;
    }
    let denom_v = f64x2_splat(b - a);
    let t_v = f64x2_div(f64x2_sub(x_v, a_v), denom_v);
    let eps_v = f64x2_splat(1e-14);
    let one_minus_eps_v = f64x2_splat(1.0 - 1e-14);
    let three_v = f64x2_splat(3.0);
    let two_v = f64x2_splat(2.0);
    let poly_v = f64x2_mul(f64x2_mul(t_v, t_v), f64x2_sub(three_v, f64x2_mul(two_v, t_v)));
    let ge_hi = v128_or(ge_b, f64x2_ge(t_v, one_minus_eps_v));
    let le_lo = v128_or(le_a, f64x2_le(t_v, eps_v));
    v128_bitselect(zero_v, v128_bitselect(one_v, poly_v, ge_hi), le_lo)
}

#[cfg(target_feature = "simd128")]
#[inline(always)]
fn range_weight_f64x2(
    val_v: v128,
    lo: f64,
    hi: f64,
    f_lo: f64,
    f_hi: f64,
    limit_invert: bool,
) -> v128 {
    let one_v = f64x2_splat(1.0);
    let w_lo_v = if f_lo > 0.0 {
        sstep_f64x2(lo - f_lo, lo, val_v)
    } else {
        v128_and(f64x2_ge(val_v, f64x2_splat(lo - 1e-12)), one_v)
    };
    let w_hi_v = if f_hi > 0.0 {
        f64x2_sub(one_v, sstep_f64x2(hi, hi + f_hi, val_v))
    } else {
        v128_and(f64x2_le(val_v, f64x2_splat(hi + 1e-12)), one_v)
    };
    let w_v = f64x2_mul(w_lo_v, w_hi_v);
    if limit_invert {
        f64x2_sub(one_v, w_v)
    } else {
        w_v
    }
}

#[cfg(target_feature = "simd128")]
#[inline(always)]
fn weight_to_alpha_f64x2(
    val_v: v128,
    lo: f64,
    hi: f64,
    f_lo: f64,
    f_hi: f64,
    limit_invert: bool,
    job_invert: bool,
) -> (u8, u8) {
    let one_v = f64x2_splat(1.0);
    let mut w_v = range_weight_f64x2(val_v, lo, hi, f_lo, f_hi, limit_invert);
    if job_invert {
        w_v = f64x2_sub(one_v, w_v);
    }
    let scaled_v = f64x2_mul(f64x2_splat(255.0), w_v);
    let fl_v = f64x2_floor(scaled_v);
    let ge_half = f64x2_ge(f64x2_sub(scaled_v, fl_v), f64x2_splat(0.5));
    let rounded_v = f64x2_add(fl_v, v128_and(ge_half, one_v));
    (
        f64x2_extract_lane::<0>(rounded_v) as u8,
        f64x2_extract_lane::<1>(rounded_v) as u8,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn range_tiles_depth(
    map: &[u16],
    guide: Option<&[u8]>,
    pic: Option<&[u8]>,
    mw: usize,
    mh: usize,
    wy0: usize,
    wh: usize,
    pic_x0: usize,
    pic_y0: usize,
    pic_w: usize,
    pic_h: usize,
    w: usize,
    h: usize,
    ty: usize,
    y0: usize,
    y1: usize,
    tile: usize,
    classes: &[u8],
    params: &[f64; 12],
    flags: u32,
    alpha_out: &mut [u8],
    status_out: &mut [u8],
    info_out: &mut [f64],
) -> u32 {
    let cols = classes.len();
    let m0 = params[0];
    let m1 = params[1];
    let m2 = params[2];
    let m3 = params[3];
    let m4 = params[4];
    let m5 = params[5];
    let lo = params[6];
    let hi = params[7];
    let f_lo = params[8];
    let f_hi = params[9];
    let sigma_r = params[10];
    let tau = params[11];
    let limit_invert = (flags & 1) != 0;
    let job_invert = (flags & 2) != 0;

    let max_y = (mh - 1) as f64;
    let wy1 = wy0 + wh;
    let tile_bytes = tile * tile;

    let tile_y0 = ty.saturating_mul(tile);
    let tile_y1 = tile_y0.saturating_add(tile).min(h);
    let ry0 = tile_y0.max(y0);
    let ry1 = tile_y1.min(y1);

    // Pre-check that every compute tile's vertical window fits inside [wy0, wy1).
    if ry0 < ry1 {
        let yf0 = ry0 as f64;
        let yf1 = ry1 as f64;
        for (tx, &cls) in classes.iter().enumerate() {
            if cls != 2 {
                continue;
            }
            let x0 = (tx * tile) as f64;
            let x1 = ((tx + 1).saturating_mul(tile)).min(w) as f64;
            let y00 = m1 * x0 + m3 * yf0 + m5;
            let y10 = m1 * x1 + m3 * yf0 + m5;
            let y01 = m1 * x0 + m3 * yf1 + m5;
            let y11 = m1 * x1 + m3 * yf1 + m5;
            let my0 = y00.min(y10).min(y01).min(y11);
            let my1 = y00.max(y10).max(y01).max(y11);
            let iy0 = (my0 - 2.0).floor().max(0.0).min(max_y) as usize;
            let iy1 = (my1 + 2.0).ceil().max(0.0).min(max_y) as usize;
            if iy0 < wy0 || iy1 >= wy1 {
                return 0;
            }
        }
    }

    let snap_on = sigma_r > 0.0 && guide.is_some() && pic.is_some();
    let pic_x1 = pic_x0.saturating_add(pic_w);
    let pic_y1 = pic_y0.saturating_add(pic_h);

    let mut alpha_sum: u64 = 0;
    let mut b_x0: usize = usize::MAX;
    let mut b_y0: usize = usize::MAX;
    let mut b_x1: usize = 0;
    let mut b_y1: usize = 0;
    let mut slot: usize = 0;

    for tx in 0..cols {
        if classes[tx] != 2 {
            status_out[tx] = 0;
            continue;
        }
        let tile_x0 = tx * tile;
        let tile_x1 = (tile_x0 + tile).min(w);
        let vw = tile_x1.saturating_sub(tile_x0);
        let vh = tile_y1.saturating_sub(tile_y0);

        if ry0 >= ry1 || vw == 0 {
            status_out[tx] = 0;
            continue;
        }

        let buf = &mut alpha_out[slot * tile_bytes..(slot + 1) * tile_bytes];
        let mut zeros: usize = 0;
        let mut fulls: usize = 0;
        let mut t_min_x: usize = tile;
        let mut t_min_y: usize = tile;
        let mut t_max_x: usize = 0;
        let mut t_max_y: usize = 0;
        let mut any_nonzero = false;

        let py_start = ry0 - tile_y0;
        let py_end = ry1 - tile_y0;
        if py_start > 0 {
            buf[..py_start * tile].fill(0);
            zeros += py_start * tile;
        }
        if py_end < tile {
            buf[py_end * tile..tile_bytes].fill(0);
            zeros += (tile - py_end) * tile;
        }

        let tile_overlaps_pic_x = snap_on && tile_x0 < pic_x1 && tile_x1 > pic_x0;

        for py in py_start..py_end {
            let y = tile_y0 + py;
            let row_buf = &mut buf[py * tile..(py + 1) * tile];
            if vw < tile {
                row_buf[vw..tile].fill(0);
                zeros += tile - vw;
            }
            let py_centre = y as f64 + 0.5;
            let row_snaps = tile_overlaps_pic_x && y >= pic_y0 && y < pic_y1;

            let mut px = 0usize;
            #[cfg(target_feature = "simd128")]
            if !row_snaps {
                let m0_v = f64x2_splat(m0);
                let m1_v = f64x2_splat(m1);
                let m2_py_v = f64x2_splat(m2 * py_centre);
                let m3_py_v = f64x2_splat(m3 * py_centre);
                let m4_v = f64x2_splat(m4);
                let m5_v = f64x2_splat(m5);
                let half_v = f64x2_splat(0.5);
                let one_v = f64x2_splat(1.0);
                let zero_v = f64x2_splat(0.0);
                let max_x_v = f64x2_splat((mw - 1) as f64);
                let max_y_v = f64x2_splat(max_y);
                let scale_v = f64x2_splat(65535.0);

                while px + 2 <= vw {
                    let x0_doc = (tile_x0 + px) as f64 + 0.5;
                    let x1_doc = (tile_x0 + px + 1) as f64 + 0.5;
                    let px_v = f64x2(x0_doc, x1_doc);

                    let mx_v = f64x2_add(f64x2_add(f64x2_mul(m0_v, px_v), m2_py_v), m4_v);
                    let my_v = f64x2_add(f64x2_add(f64x2_mul(m1_v, px_v), m3_py_v), m5_v);

                    let u_v = f64x2_sub(mx_v, half_v);
                    let v_v = f64x2_sub(my_v, half_v);

                    let ix0_v = f64x2_floor(u_v);
                    let iy0_v = f64x2_floor(v_v);
                    let ix1_v = f64x2_add(ix0_v, one_v);
                    let iy1_v = f64x2_add(iy0_v, one_v);

                    let fx_v = f64x2_sub(u_v, ix0_v);
                    let fy_v = f64x2_sub(v_v, iy0_v);

                    let cx0_v = f64x2_max(zero_v, f64x2_min(max_x_v, ix0_v));
                    let cx1_v = f64x2_max(zero_v, f64x2_min(max_x_v, ix1_v));
                    let cy0_v = f64x2_max(zero_v, f64x2_min(max_y_v, iy0_v));
                    let cy1_v = f64x2_max(zero_v, f64x2_min(max_y_v, iy1_v));

                    let cx0_0 = f64x2_extract_lane::<0>(cx0_v) as usize;
                    let cx0_1 = f64x2_extract_lane::<1>(cx0_v) as usize;
                    let cx1_0 = f64x2_extract_lane::<0>(cx1_v) as usize;
                    let cx1_1 = f64x2_extract_lane::<1>(cx1_v) as usize;
                    let cy0_0 = (f64x2_extract_lane::<0>(cy0_v) as usize) - wy0;
                    let cy0_1 = (f64x2_extract_lane::<1>(cy0_v) as usize) - wy0;
                    let cy1_0 = (f64x2_extract_lane::<0>(cy1_v) as usize) - wy0;
                    let cy1_1 = (f64x2_extract_lane::<1>(cy1_v) as usize) - wy0;

                    let r00 = cy0_0 * mw;
                    let r01 = cy1_0 * mw;
                    let r10 = cy0_1 * mw;
                    let r11 = cy1_1 * mw;

                    let s00_v = f64x2_div(f64x2(map[r00 + cx0_0] as f64, map[r10 + cx0_1] as f64), scale_v);
                    let s10_v = f64x2_div(f64x2(map[r00 + cx1_0] as f64, map[r10 + cx1_1] as f64), scale_v);
                    let s01_v = f64x2_div(f64x2(map[r01 + cx0_0] as f64, map[r11 + cx0_1] as f64), scale_v);
                    let s11_v = f64x2_div(f64x2(map[r01 + cx1_0] as f64, map[r11 + cx1_1] as f64), scale_v);

                    let top_v = f64x2_add(s00_v, f64x2_mul(fx_v, f64x2_sub(s10_v, s00_v)));
                    let bot_v = f64x2_add(s01_v, f64x2_mul(fx_v, f64x2_sub(s11_v, s01_v)));
                    let val_v = f64x2_add(top_v, f64x2_mul(fy_v, f64x2_sub(bot_v, top_v)));

                    let (a0, a1) = weight_to_alpha_f64x2(val_v, lo, hi, f_lo, f_hi, limit_invert, job_invert);
                    for (lane, a) in [(px, a0), (px + 1, a1)] {
                        row_buf[lane] = a;
                        alpha_sum += a as u64;
                        if a == 0 {
                            zeros += 1;
                        } else {
                            any_nonzero = true;
                            if a == 255 {
                                fulls += 1;
                            }
                            if lane < t_min_x {
                                t_min_x = lane;
                            }
                            if lane > t_max_x {
                                t_max_x = lane;
                            }
                            if py < t_min_y {
                                t_min_y = py;
                            }
                            if py > t_max_y {
                                t_max_y = py;
                            }
                        }
                    }
                    px += 2;
                }
            }

            while px < vw {
                let x = tile_x0 + px;
                let px_centre = x as f64 + 0.5;
                let mx = m0 * px_centre + m2 * py_centre + m4;
                let my = m1 * px_centre + m3 * py_centre + m5;
                let v = if row_snaps && x >= pic_x0 && x < pic_x1 {
                    let g_slice = guide.unwrap();
                    let p_slice = pic.unwrap();
                    let p_off = ((y - pic_y0) * pic_w + (x - pic_x0)) * 4;
                    let pr = p_slice[p_off] as f64 / 255.0;
                    let pg = p_slice[p_off + 1] as f64 / 255.0;
                    let pb = p_slice[p_off + 2] as f64 / 255.0;
                    snap_field(map, g_slice, mw, mh, wy0, mx, my, pr, pg, pb, sigma_r, tau)
                } else {
                    u16_bilinear(map, mw, mh, wy0, mx, my)
                };
                let a = weight_to_alpha(v, lo, hi, f_lo, f_hi, limit_invert, job_invert);
                row_buf[px] = a;
                alpha_sum += a as u64;
                if a == 0 {
                    zeros += 1;
                } else {
                    any_nonzero = true;
                    if a == 255 {
                        fulls += 1;
                    }
                    if px < t_min_x {
                        t_min_x = px;
                    }
                    if px > t_max_x {
                        t_max_x = px;
                    }
                    if py < t_min_y {
                        t_min_y = py;
                    }
                    if py > t_max_y {
                        t_max_y = py;
                    }
                }
                px += 1;
            }
        }

        if zeros == tile_bytes || !any_nonzero {
            status_out[tx] = 0;
        } else if fulls == tile_bytes && vw == tile && vh == tile {
            status_out[tx] = 2;
            b_x0 = b_x0.min(tile_x0);
            b_y0 = b_y0.min(tile_y0);
            b_x1 = b_x1.max(tile_x0 + tile);
            b_y1 = b_y1.max(tile_y0 + tile);
        } else {
            status_out[tx] = 1;
            slot += 1;
            b_x0 = b_x0.min(tile_x0 + t_min_x);
            b_y0 = b_y0.min(tile_y0 + t_min_y);
            b_x1 = b_x1.max(tile_x0 + t_max_x + 1);
            b_y1 = b_y1.max(tile_y0 + t_max_y + 1);
        }
    }

    info_out[0] = alpha_sum as f64;
    if b_x0 <= b_x1 && b_x0 != usize::MAX {
        info_out[1] = b_x0 as f64;
        info_out[2] = b_y0 as f64;
        info_out[3] = b_x1 as f64;
        info_out[4] = b_y1 as f64;
    } else {
        info_out[1] = -1.0;
        info_out[2] = -1.0;
        info_out[3] = -1.0;
        info_out[4] = -1.0;
    }

    1
}

/// Evaluates one document tile row `ty` over the `(ry1 - ry0)`-row RGBA8 slice `rgba` (`w * (ry1 - ry0) * 4` bytes)
/// for `"luma"` (`mode == 0`) or `"color"` (`mode == 1`).
/// `params`: `[lo, hi, f_lo, f_hi, ref_l, ref_a, ref_b, tol]`.
/// `flags`: bit 0 = `limit.invert`, bit 1 = `job_invert`.
#[allow(clippy::too_many_arguments)]
pub fn range_tiles_rgba(
    rgba: &[u8],
    w: usize,
    h: usize,
    ty: usize,
    ry0: usize,
    ry1: usize,
    tile: usize,
    mode: u32,
    params: &[f64; 8],
    flags: u32,
    alpha_out: &mut [u8],
    status_out: &mut [u8],
    info_out: &mut [f64],
) -> u32 {
    let tile_y0 = ty.saturating_mul(tile);
    let tile_y1 = tile_y0.saturating_add(tile).min(h);
    if ry0 >= ry1 || ry0 < tile_y0 || ry1 > tile_y1 || mode > 1 {
        return 0;
    }
    let rows = ry1 - ry0;
    let Some(need_bytes) = rows.checked_mul(w).and_then(|n| n.checked_mul(4)) else {
        return 0;
    };
    if rgba.len() < need_bytes {
        return 0;
    }

    let cols = status_out.len();
    let tile_bytes = tile * tile;
    let lo = params[0];
    let hi = params[1];
    let f_lo = params[2];
    let f_hi = params[3];
    let ref_l = params[4];
    let ref_a = params[5];
    let ref_b = params[6];
    let tol = params[7];
    let limit_invert = (flags & 1) != 0;
    let job_invert = (flags & 2) != 0;

    let mut luma_r = [0.0f64; 256];
    let mut luma_g = [0.0f64; 256];
    let mut luma_b = [0.0f64; 256];
    let mut inv255 = [0.0f64; 256];
    let mut opp_r = [0.0f64; 256];
    let mut opp_g = [0.0f64; 256];
    let mut opp_b = [0.0f64; 256];
    let s = 0.04 + (if tol == 0.0 { 0.0 } else { tol / 100.0 }).max(0.0).min(1.0) * 0.6;
    let two_s2 = 2.0 * s * s;

    if mode == 0 {
        for i in 0..256 {
            let x = i as f64;
            luma_r[i] = 0.299 * x;
            luma_g[i] = 0.587 * x;
            luma_b[i] = 0.114 * x;
        }
    } else {
        for i in 0..256 {
            let u = (i as f64) / 255.0;
            inv255[i] = u;
            opp_r[i] = 0.299 * u;
            opp_g[i] = 0.587 * u;
            opp_b[i] = 0.114 * u;
        }
    }

    let mut alpha_sum: u64 = 0;
    let mut b_x0: usize = usize::MAX;
    let mut b_y0: usize = usize::MAX;
    let mut b_x1: usize = 0;
    let mut b_y1: usize = 0;
    let mut slot: usize = 0;

    let py_start = ry0 - tile_y0;
    let py_end = ry1 - tile_y0;
    let vh = tile_y1.saturating_sub(tile_y0);

    for tx in 0..cols {
        let tile_x0 = tx * tile;
        let tile_x1 = (tile_x0 + tile).min(w);
        let vw = tile_x1.saturating_sub(tile_x0);
        if vw == 0 {
            status_out[tx] = 0;
            continue;
        }

        let buf = &mut alpha_out[slot * tile_bytes..(slot + 1) * tile_bytes];
        let mut zeros: usize = 0;
        let mut fulls: usize = 0;
        let mut t_min_x: usize = tile;
        let mut t_min_y: usize = tile;
        let mut t_max_x: usize = 0;
        let mut t_max_y: usize = 0;
        let mut any_nonzero = false;

        if py_start > 0 {
            buf[..py_start * tile].fill(0);
            zeros += py_start * tile;
        }
        if py_end < tile {
            buf[py_end * tile..tile_bytes].fill(0);
            zeros += (tile - py_end) * tile;
        }

        for py in py_start..py_end {
            let y_rel = (tile_y0 + py) - ry0;
            let row_rgba = &rgba[(y_rel * w + tile_x0) * 4..(y_rel * w + tile_x1) * 4];
            let row_buf = &mut buf[py * tile..(py + 1) * tile];
            if vw < tile {
                row_buf[vw..tile].fill(0);
                zeros += tile - vw;
            }

            let mut px = 0usize;
            if mode == 0 {
                #[cfg(target_feature = "simd128")]
                {
                    let div255_v = f64x2_splat(255.0);
                    while px + 2 <= vw {
                        let off0 = px * 4;
                        let off1 = (px + 1) * 4;
                        let s0 = luma_r[row_rgba[off0] as usize]
                            + luma_g[row_rgba[off0 + 1] as usize]
                            + luma_b[row_rgba[off0 + 2] as usize];
                        let s1 = luma_r[row_rgba[off1] as usize]
                            + luma_g[row_rgba[off1 + 1] as usize]
                            + luma_b[row_rgba[off1 + 2] as usize];
                        let val_v = f64x2_div(f64x2(s0, s1), div255_v);
                        let (a0, a1) = weight_to_alpha_f64x2(val_v, lo, hi, f_lo, f_hi, limit_invert, job_invert);
                        for (lane, a) in [(px, a0), (px + 1, a1)] {
                            row_buf[lane] = a;
                            alpha_sum += a as u64;
                            if a == 0 {
                                zeros += 1;
                            } else {
                                any_nonzero = true;
                                if a == 255 {
                                    fulls += 1;
                                }
                                if lane < t_min_x {
                                    t_min_x = lane;
                                }
                                if lane > t_max_x {
                                    t_max_x = lane;
                                }
                                if py < t_min_y {
                                    t_min_y = py;
                                }
                                if py > t_max_y {
                                    t_max_y = py;
                                }
                            }
                        }
                        px += 2;
                    }
                }
                while px < vw {
                    let off = px * 4;
                    let v = (luma_r[row_rgba[off] as usize]
                        + luma_g[row_rgba[off + 1] as usize]
                        + luma_b[row_rgba[off + 2] as usize])
                        / 255.0;
                    let a = weight_to_alpha(v, lo, hi, f_lo, f_hi, limit_invert, job_invert);
                    row_buf[px] = a;
                    alpha_sum += a as u64;
                    if a == 0 {
                        zeros += 1;
                    } else {
                        any_nonzero = true;
                        if a == 255 {
                            fulls += 1;
                        }
                        if px < t_min_x {
                            t_min_x = px;
                        }
                        if px > t_max_x {
                            t_max_x = px;
                        }
                        if py < t_min_y {
                            t_min_y = py;
                        }
                        if py > t_max_y {
                            t_max_y = py;
                        }
                    }
                    px += 1;
                }
            } else {
                #[cfg(target_feature = "simd128")]
                {
                    let ref_l_v = f64x2_splat(ref_l);
                    let ref_a_v = f64x2_splat(ref_a);
                    let ref_b_v = f64x2_splat(ref_b);
                    let four_v = f64x2_splat(4.0);
                    let two_s2_v = f64x2_splat(two_s2);
                    while px + 2 <= vw {
                        let off0 = px * 4;
                        let off1 = (px + 1) * 4;
                        let rb0 = row_rgba[off0] as usize;
                        let gb0 = row_rgba[off0 + 1] as usize;
                        let bb0 = row_rgba[off0 + 2] as usize;
                        let rb1 = row_rgba[off1] as usize;
                        let gb1 = row_rgba[off1 + 1] as usize;
                        let bb1 = row_rgba[off1 + 2] as usize;

                        let l0 = opp_r[rb0] + opp_g[gb0] + opp_b[bb0];
                        let l1 = opp_r[rb1] + opp_g[gb1] + opp_b[bb1];
                        let l_v = f64x2(l0, l1);
                        let r_v = f64x2(inv255[rb0], inv255[rb1]);
                        let b_v = f64x2(inv255[bb0], inv255[bb1]);

                        let d0_v = f64x2_sub(l_v, ref_l_v);
                        let d1_v = f64x2_sub(f64x2_sub(r_v, l_v), ref_a_v);
                        let d2_v = f64x2_sub(f64x2_sub(b_v, l_v), ref_b_v);
                        let dd_v = f64x2_add(
                            f64x2_mul(d0_v, d0_v),
                            f64x2_mul(four_v, f64x2_add(f64x2_mul(d1_v, d1_v), f64x2_mul(d2_v, d2_v))),
                        );
                        let arg_v = f64x2_div(f64x2_neg(dd_v), two_s2_v);
                        let v0 = f64x2_extract_lane::<0>(arg_v).exp();
                        let v1 = f64x2_extract_lane::<1>(arg_v).exp();
                        let val_v = f64x2(v0, v1);
                        let (a0, a1) = weight_to_alpha_f64x2(val_v, lo, hi, f_lo, f_hi, limit_invert, job_invert);
                        for (lane, a) in [(px, a0), (px + 1, a1)] {
                            row_buf[lane] = a;
                            alpha_sum += a as u64;
                            if a == 0 {
                                zeros += 1;
                            } else {
                                any_nonzero = true;
                                if a == 255 {
                                    fulls += 1;
                                }
                                if lane < t_min_x {
                                    t_min_x = lane;
                                }
                                if lane > t_max_x {
                                    t_max_x = lane;
                                }
                                if py < t_min_y {
                                    t_min_y = py;
                                }
                                if py > t_max_y {
                                    t_max_y = py;
                                }
                            }
                        }
                        px += 2;
                    }
                }
                while px < vw {
                    let off = px * 4;
                    let rb = row_rgba[off] as usize;
                    let gb = row_rgba[off + 1] as usize;
                    let bb = row_rgba[off + 2] as usize;
                    let l = opp_r[rb] + opp_g[gb] + opp_b[bb];
                    let r = inv255[rb];
                    let b = inv255[bb];
                    let d0 = l - ref_l;
                    let d1 = (r - l) - ref_a;
                    let d2 = (b - l) - ref_b;
                    let dd = d0 * d0 + 4.0 * (d1 * d1 + d2 * d2);
                    let v = (-dd / two_s2).exp();
                    let a = weight_to_alpha(v, lo, hi, f_lo, f_hi, limit_invert, job_invert);
                    row_buf[px] = a;
                    alpha_sum += a as u64;
                    if a == 0 {
                        zeros += 1;
                    } else {
                        any_nonzero = true;
                        if a == 255 {
                            fulls += 1;
                        }
                        if px < t_min_x {
                            t_min_x = px;
                        }
                        if px > t_max_x {
                            t_max_x = px;
                        }
                        if py < t_min_y {
                            t_min_y = py;
                        }
                        if py > t_max_y {
                            t_max_y = py;
                        }
                    }
                    px += 1;
                }
            }
        }

        if zeros == tile_bytes || !any_nonzero {
            status_out[tx] = 0;
        } else if fulls == tile_bytes && vw == tile && vh == tile {
            status_out[tx] = 2;
            b_x0 = b_x0.min(tile_x0);
            b_y0 = b_y0.min(tile_y0);
            b_x1 = b_x1.max(tile_x0 + tile);
            b_y1 = b_y1.max(tile_y0 + tile);
        } else {
            status_out[tx] = 1;
            slot += 1;
            b_x0 = b_x0.min(tile_x0 + t_min_x);
            b_y0 = b_y0.min(tile_y0 + t_min_y);
            b_x1 = b_x1.max(tile_x0 + t_max_x + 1);
            b_y1 = b_y1.max(tile_y0 + t_max_y + 1);
        }
    }

    info_out[0] = alpha_sum as f64;
    if b_x0 <= b_x1 && b_x0 != usize::MAX {
        info_out[1] = b_x0 as f64;
        info_out[2] = b_y0 as f64;
        info_out[3] = b_x1 as f64;
        info_out[4] = b_y1 as f64;
    } else {
        info_out[1] = -1.0;
        info_out[2] = -1.0;
        info_out[3] = -1.0;
        info_out[4] = -1.0;
    }

    1
}

/// Multiplies the alpha channel of `rgba` (`w * h * 4` RGBA8 bytes, in place) by the depth limit weight over a
/// `wh`-row window of `map` (and optional `guide`) starting at map row `wy0` (`inpaint_limit.js` `limitAlphaRows`, K25).
/// When `sigma_r > 0` and `guide` is `Some`, edge snap takes its reference colour from `col` (`w * h * 4` RGBA8 bytes)
/// when `col` is `Some`, from `rgba` when `col_from_rgba` is true, or from `guide` sampled at `floor(mx), floor(my)`.
/// `params`: `[m0, m1, m2, m3, m4, m5, lo, hi, f_lo, f_hi, sigma_r, tau]`.
/// `flags`: bit 0 = `limit.invert`.
/// Returns `1` on success, `0` when the vertical window `[iy0, iy1]` falls outside `[wy0, wy0 + wh)`.
#[allow(clippy::too_many_arguments)]
pub fn limit_alpha_rows(
    rgba: &mut [u8],
    col: Option<&[u8]>,
    col_from_rgba: bool,
    map: &[u16],
    guide: Option<&[u8]>,
    mw: usize,
    mh: usize,
    wy0: usize,
    wh: usize,
    x0: i32,
    y0: i32,
    w: usize,
    h: usize,
    params: &[f64; 12],
    flags: u32,
) -> u32 {
    let m0 = params[0];
    let m1 = params[1];
    let m2 = params[2];
    let m3 = params[3];
    let m4 = params[4];
    let m5 = params[5];
    let lo = params[6];
    let hi = params[7];
    let f_lo = params[8];
    let f_hi = params[9];
    let sigma_r = params[10];
    let tau = params[11];
    let limit_invert = (flags & 1) != 0;

    let max_x = (mw - 1) as f64;
    let max_y = (mh - 1) as f64;
    let wy1 = wy0 + wh;

    let rx0 = x0 as f64;
    let rx1 = (x0 as f64) + (w as f64);
    let ry0 = y0 as f64;
    let ry1 = (y0 as f64) + (h as f64);
    let y00 = m1 * rx0 + m3 * ry0 + m5;
    let y10 = m1 * rx1 + m3 * ry0 + m5;
    let y01 = m1 * rx0 + m3 * ry1 + m5;
    let y11 = m1 * rx1 + m3 * ry1 + m5;
    let my0 = y00.min(y10).min(y01).min(y11);
    let my1 = y00.max(y10).max(y01).max(y11);
    let iy0 = (my0 - 2.0).floor().max(0.0).min(max_y) as usize;
    let iy1 = (my1 + 2.0).ceil().max(0.0).min(max_y) as usize;
    if iy0 < wy0 || iy1 >= wy1 {
        return 0;
    }

    let snap_on = sigma_r > 0.0 && guide.is_some();
    let row_bytes = w * 4;

    for y in 0..h {
        let row_byte_off = y * row_bytes;
        let row_rgba = &mut rgba[row_byte_off..row_byte_off + row_bytes];
        let py_centre = (y0 as f64) + (y as f64) + 0.5;
        let mut px = 0usize;

        #[cfg(target_feature = "simd128")]
        if !snap_on {
            let m0_v = f64x2_splat(m0);
            let m1_v = f64x2_splat(m1);
            let m2_py_v = f64x2_splat(m2 * py_centre);
            let m3_py_v = f64x2_splat(m3 * py_centre);
            let m4_v = f64x2_splat(m4);
            let m5_v = f64x2_splat(m5);
            let half_v = f64x2_splat(0.5);
            let one_v = f64x2_splat(1.0);
            let zero_v = f64x2_splat(0.0);
            let max_x_v = f64x2_splat(max_x);
            let max_y_v = f64x2_splat(max_y);
            let scale_v = f64x2_splat(65535.0);
            let x0_f = x0 as f64;

            while px + 2 <= w {
                let x0_doc = x0_f + (px as f64) + 0.5;
                let x1_doc = x0_f + ((px + 1) as f64) + 0.5;
                let px_v = f64x2(x0_doc, x1_doc);

                let mx_v = f64x2_add(f64x2_add(f64x2_mul(m0_v, px_v), m2_py_v), m4_v);
                let my_v = f64x2_add(f64x2_add(f64x2_mul(m1_v, px_v), m3_py_v), m5_v);

                let u_v = f64x2_sub(mx_v, half_v);
                let v_v = f64x2_sub(my_v, half_v);

                let ix0_v = f64x2_floor(u_v);
                let iy0_v = f64x2_floor(v_v);
                let ix1_v = f64x2_add(ix0_v, one_v);
                let iy1_v = f64x2_add(iy0_v, one_v);

                let fx_v = f64x2_sub(u_v, ix0_v);
                let fy_v = f64x2_sub(v_v, iy0_v);

                let cx0_v = f64x2_max(zero_v, f64x2_min(max_x_v, ix0_v));
                let cx1_v = f64x2_max(zero_v, f64x2_min(max_x_v, ix1_v));
                let cy0_v = f64x2_max(zero_v, f64x2_min(max_y_v, iy0_v));
                let cy1_v = f64x2_max(zero_v, f64x2_min(max_y_v, iy1_v));

                let cx0_0 = f64x2_extract_lane::<0>(cx0_v) as usize;
                let cx0_1 = f64x2_extract_lane::<1>(cx0_v) as usize;
                let cx1_0 = f64x2_extract_lane::<0>(cx1_v) as usize;
                let cx1_1 = f64x2_extract_lane::<1>(cx1_v) as usize;
                let cy0_0 = (f64x2_extract_lane::<0>(cy0_v) as usize) - wy0;
                let cy0_1 = (f64x2_extract_lane::<1>(cy0_v) as usize) - wy0;
                let cy1_0 = (f64x2_extract_lane::<0>(cy1_v) as usize) - wy0;
                let cy1_1 = (f64x2_extract_lane::<1>(cy1_v) as usize) - wy0;

                let r00 = cy0_0 * mw;
                let r01 = cy1_0 * mw;
                let r10 = cy0_1 * mw;
                let r11 = cy1_1 * mw;

                let s00_v = f64x2_div(f64x2(map[r00 + cx0_0] as f64, map[r10 + cx0_1] as f64), scale_v);
                let s10_v = f64x2_div(f64x2(map[r00 + cx1_0] as f64, map[r10 + cx1_1] as f64), scale_v);
                let s01_v = f64x2_div(f64x2(map[r01 + cx0_0] as f64, map[r11 + cx0_1] as f64), scale_v);
                let s11_v = f64x2_div(f64x2(map[r01 + cx1_0] as f64, map[r11 + cx1_1] as f64), scale_v);

                let top_v = f64x2_add(s00_v, f64x2_mul(fx_v, f64x2_sub(s10_v, s00_v)));
                let bot_v = f64x2_add(s01_v, f64x2_mul(fx_v, f64x2_sub(s11_v, s01_v)));
                let val_v = f64x2_max(zero_v, f64x2_min(one_v, f64x2_add(top_v, f64x2_mul(fy_v, f64x2_sub(bot_v, top_v)))));

                let w_v = range_weight_f64x2(val_v, lo, hi, f_lo, f_hi, limit_invert);
                let off0 = px * 4;
                let off1 = (px + 1) * 4;
                let a_in_v = f64x2(row_rgba[off0 + 3] as f64, row_rgba[off1 + 3] as f64);
                let scaled_v = f64x2_mul(a_in_v, w_v);
                let fl_v = f64x2_floor(scaled_v);
                let ge_half = f64x2_ge(f64x2_sub(scaled_v, fl_v), half_v);
                let rounded_v = f64x2_add(fl_v, v128_and(ge_half, one_v));
                row_rgba[off0 + 3] = f64x2_extract_lane::<0>(rounded_v) as u8;
                row_rgba[off1 + 3] = f64x2_extract_lane::<1>(rounded_v) as u8;

                px += 2;
            }
        }

        while px < w {
            let off = px * 4;
            let px_centre = (x0 as f64) + (px as f64) + 0.5;
            let mx = m0 * px_centre + m2 * py_centre + m4;
            let my = m1 * px_centre + m3 * py_centre + m5;
            let mv = if snap_on {
                let g_slice = guide.unwrap();
                let (pr, pg, pb) = if let Some(c_slice) = col {
                    let c_off = row_byte_off + off;
                    (
                        c_slice[c_off] as f64 / 255.0,
                        c_slice[c_off + 1] as f64 / 255.0,
                        c_slice[c_off + 2] as f64 / 255.0,
                    )
                } else if col_from_rgba {
                    (
                        row_rgba[off] as f64 / 255.0,
                        row_rgba[off + 1] as f64 / 255.0,
                        row_rgba[off + 2] as f64 / 255.0,
                    )
                } else {
                    let gx = mx.floor().max(0.0).min(max_x) as usize;
                    let gy = (my.floor().max(0.0).min(max_y) as usize) - wy0;
                    let g_off = (gy * mw + gx) * 4;
                    (
                        g_slice[g_off] as f64 / 255.0,
                        g_slice[g_off + 1] as f64 / 255.0,
                        g_slice[g_off + 2] as f64 / 255.0,
                    )
                };
                snap_field(map, g_slice, mw, mh, wy0, mx, my, pr, pg, pb, sigma_r, tau)
            } else {
                u16_bilinear(map, mw, mh, wy0, mx, my)
            };
            let v = mv.max(0.0).min(1.0);
            let w_val = range_weight(v, lo, hi, f_lo, f_hi, limit_invert);
            row_rgba[off + 3] = js_round_byte((row_rgba[off + 3] as f64) * w_val);
            px += 1;
        }
    }

    1
}


