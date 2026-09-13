//! Exact squared euclidean distance transform over a band.
//!
//! `out[i]` is the squared distance of pixel i to the nearest pixel whose feature byte is
//! non-zero, or 1e20 when there is none. Grow, shrink and feather are thresholds and ramps
//! over it. Two separable passes:
//!
//! 1. Columns: for a binary feature the 1-D squared transform of a column is the square of
//!    the distance to the nearest feature in that column, which two sweeps (down, up) give
//!    row by row. This is what Felzenszwalb's column pass computes, bit for bit, but it walks
//!    memory in row order and its inner loop is a select, which vectorises.
//! 2. Rows: Felzenszwalb / Huttenlocher's lower envelope of parabolas, with exactly the
//!    number types of `distanceTransform` in `inpaint_raster.js` (f32 storage, f64
//!    intersections; `g[q] = f[q] + q²` once per row), so both give the same f32 values.
//!
//! The caller passes a scratch block of `scratch_bytes(w, h)`.

pub const INF: f32 = 1e20;
const FAR: f32 = 1e9; // a column distance that means "none"; FAR + 1 == FAR in f32

pub fn scratch_bytes(w: usize, h: usize) -> usize {
    let n = w.max(h);
    g_offset(w, h) + 8 * n
}

// f (n), v (n), z (n + 1), col (w) as 4-byte cells, then g (n) as 8-byte cells on an 8-byte boundary
fn g_offset(w: usize, h: usize) -> usize {
    let n = w.max(h);
    (4 * (3 * n + 1 + w) + 7) & !7
}

pub fn dist_transform(feature: &[u8], w: usize, h: usize, out: &mut [f32], scratch: &mut [u8]) {
    if w == 0 || h == 0 {
        return;
    }
    let n = w.max(h);
    let feature = &feature[..w * h];
    let out = &mut out[..w * h];
    assert!(scratch.len() >= scratch_bytes(w, h) && scratch.as_ptr() as usize % 8 == 0);
    let (f, g, v, z, col) = unsafe {
        let p = scratch.as_mut_ptr();
        (
            core::slice::from_raw_parts_mut(p as *mut f32, n),
            core::slice::from_raw_parts_mut(p.add(g_offset(w, h)) as *mut f64, n),
            core::slice::from_raw_parts_mut(p.add(4 * n) as *mut i32, n),
            core::slice::from_raw_parts_mut(p.add(8 * n) as *mut f32, n + 1),
            core::slice::from_raw_parts_mut(p.add(12 * n + 4) as *mut f32, w),
        )
    };

    // pass 1, down: distance to the nearest feature above (or on) the pixel
    col.fill(FAR);
    for (frow, orow) in feature.chunks_exact(w).zip(out.chunks_exact_mut(w)) {
        for ((&fe, c), o) in frow.iter().zip(col.iter_mut()).zip(orow.iter_mut()) {
            let t = if fe != 0 { 0.0 } else { *c + 1.0 };
            *c = t;
            *o = t;
        }
    }
    // pass 1, up: the nearer of above and below, squared
    col.fill(FAR);
    for (frow, orow) in feature.chunks_exact(w).rev().zip(out.chunks_exact_mut(w).rev()) {
        for ((&fe, c), o) in frow.iter().zip(col.iter_mut()).zip(orow.iter_mut()) {
            let t = if fe != 0 { 0.0 } else { *c + 1.0 };
            *c = t;
            let m = if *o < t { *o } else { t };
            *o = if m >= 1e8 { INF } else { m * m };
        }
    }
    // pass 2, rows: f and g are the row before the pass, the row itself takes the result
    for orow in out.chunks_exact_mut(w) {
        for (x, (&o, (fx, gx))) in orow.iter().zip(f[..w].iter_mut().zip(g[..w].iter_mut())).enumerate() {
            *fx = o;
            *gx = o as f64 + (x * x) as f64;
        }
        edt1d(&f[..w], &g[..w], orow, &mut v[..w], &mut z[..w + 1]);
    }
}

#[inline(always)]
fn edt1d(f: &[f32], g: &[f64], d: &mut [f32], v: &mut [i32], z: &mut [f32]) {
    let n = f.len();
    assert!(g.len() == n && d.len() == n && v.len() == n && z.len() == n + 1);
    unsafe {
        let mut k: usize = 0;
        *v.get_unchecked_mut(0) = 0;
        *z.get_unchecked_mut(0) = -INF;
        *z.get_unchecked_mut(1) = INF;
        for q in 1..n {
            let gq = *g.get_unchecked(q);
            loop {
                let vk = *v.get_unchecked(k) as usize;
                let s = (gq - *g.get_unchecked(vk)) / ((2 * q - 2 * vk) as f64);
                if s <= *z.get_unchecked(k) as f64 {
                    // s is never below -INF (the numerator is above -1.0000001e20 and the
                    // denominator at least 2), so k does not run below 0
                    k -= 1;
                    continue;
                }
                k += 1;
                *v.get_unchecked_mut(k) = q as i32;
                *z.get_unchecked_mut(k) = s as f32;
                *z.get_unchecked_mut(k + 1) = INF;
                break;
            }
        }
        k = 0;
        for q in 0..n {
            while (*z.get_unchecked(k + 1) as f64) < q as f64 {
                k += 1;
            }
            let vk = *v.get_unchecked(k) as i64;
            let dq = q as i64 - vk;
            *d.get_unchecked_mut(q) = ((dq * dq) as f64 + *f.get_unchecked(vk as usize) as f64) as f32;
        }
    }
}
