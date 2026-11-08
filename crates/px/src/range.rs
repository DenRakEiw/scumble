//! Depth map tile statistics for range selection and filter limits (`docs/PLAN_WASM_BUILD.md` §4.8, K21).
//!
//! For one row of document tiles `[0, y0, w, y1]`, `map_tile_stats` maps each tile's four corners into the depth map
//! via the 6-element affine transform `m0..m5`, expands the bounding box by the 2-texel snap halo, clamps to
//! `[0, mw - 1] × [0, mh - 1]`, and scans the window (shifted by `wy0`) for the tile's `u16` minimum, maximum, and
//! whether any texel in `rmax` exceeds `thresh`.

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

        let ix0 = (mx0 - 2.0).floor().max(0.0).min(max_x) as usize;
        let iy0 = (my0 - 2.0).floor().max(0.0).min(max_y) as usize;
        let ix1 = (mx1 + 2.0).ceil().max(0.0).min(max_x) as usize;
        let iy1 = (my1 + 2.0).ceil().max(0.0).min(max_y) as usize;

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
            if !has_edge {
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
