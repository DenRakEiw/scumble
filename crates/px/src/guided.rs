//! The depth map's guided filter (`renderer/editor/inpaint_depth.js` `guidedFar`, `guidedFilter`, `bilinearResize`;
//! K24 of `docs/PLAN_WASM_BUILD.md` §4.8): normalises and inverts `raw` (`rw * rh` `f32`) by `[lo, hi]`, bilinearly
//! resizes to `gw * gh` (`wx` stored as `f32`, `fy` kept as `f64`), forms `I = (grey[i] as f64 * (1.0 / 255.0)) as f32`
//! and `Ip`, `II` from the raw `I` and `p` before any in-place box pass, runs six single-channel box passes
//! (`maskf::box_pass::<1>` with `Norm::Div((2 * r_work + 1) as f64)`), forms `a = cov_ip / (var_i + eps)` (`f32`) and
//! `b = mean_p - av * mean_i` (`f32`, from the unrounded `f64` `av`), clamps `mean_a * I + mean_b` to `0.0..=1.0` as
//! `f32`, and quantises `Math.round(q[i] * 65535.0)` into `out` (`gw * gh` `u16`).

use crate::maskf::{box_pass, Norm};

/// The largest block `px_alloc` hands out (`Layout::from_size_align` limit less 4 KB alignment).
const MAX_BLOCK: usize = (isize::MAX as usize) - 4096;

/// Largest working radius accepted (`2 * r_work + 1` fits comfortably in `usize` and `f64`).
pub const MAX_RADIUS: usize = 0x3fff_ffff;

/// JavaScript `Math.round(x)` for non-negative finite `x`: rounds half-way cases toward `+Infinity`.
#[inline(always)]
fn js_round_pos(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// JavaScript `Math.round(x)` for `x` in `0.0..=65535.0`: rounds half-way cases toward `+Infinity`.
#[inline(always)]
fn js_round_u16(x: f64) -> u16 {
    let f = x.floor();
    if x - f >= 0.5 {
        (f as u16).wrapping_add(1)
    } else {
        f as u16
    }
}

/// Computes `rWork = Math.max(1, Math.round(r * (gw / rw)))` as `inpaint_depth.js` `guidedFar` does, or `None` when
/// `r` is not finite or `rWork` exceeds `MAX_RADIUS`.
pub fn work_radius(r: f64, rw: usize, gw: usize) -> Option<usize> {
    if !r.is_finite() || rw == 0 || gw == 0 {
        return None;
    }
    let scale = (gw as f64) / (rw as f64);
    let scaled = r * scale;
    if !scaled.is_finite() {
        return None;
    }
    let rounded = if scaled <= 0.5 {
        1.0
    } else {
        js_round_pos(scaled).max(1.0)
    };
    if rounded > (MAX_RADIUS as f64) {
        return None;
    }
    Some(rounded as usize)
}

/// Scratch bytes `guided_far` needs for a `rw x rh` raw disparity map and `gw x gh` working guide:
/// - `gw` `f64` column sums (`gw * 8` bytes, 8-aligned at start)
/// - 5 working `f32` planes (`5 * gw * gh * 4` bytes: `I`, `p`/`meanP`, `meanI`, `Ip`/`a`/`meanA`, `II`/`b`/`meanB`)
/// - 1 scratch `f32` plane of `max(gw * gh, rw * rh)` floats (holds `far_f32` when `(rw, rh) != (gw, gh)`, then `tmp`
///   for `box_pass::<1>`)
/// - `3 * gw * 4` bytes for `bilinear_resize`'s `x0` (`u32`), `x1` (`u32`) and `wx` (`f32`) tables.
/// Returns `None` on zero dimensions, overflow, or when the total exceeds `MAX_BLOCK`.
pub fn scratch_bytes(rw: usize, rh: usize, gw: usize, gh: usize) -> Option<usize> {
    if rw == 0 || rh == 0 || gw == 0 || gh == 0 {
        return None;
    }
    let n_raw = rw.checked_mul(rh)?;
    let n_work = gw.checked_mul(gh)?;
    let n_tmp = n_work.max(n_raw);
    let sums_bytes = gw.checked_mul(8)?;
    let planes_f32 = n_work.checked_mul(5)?.checked_add(n_tmp)?;
    let planes_bytes = planes_f32.checked_mul(4)?;
    let tables_bytes = gw.checked_mul(3)?.checked_mul(4)?;
    let total = sums_bytes.checked_add(planes_bytes)?.checked_add(tables_bytes)?;
    if total > MAX_BLOCK {
        None
    } else {
        Some(total)
    }
}

/// `bilinearResize(src, w, h, w2, h2)` of `inpaint_depth.js`: pixel-centre coordinates with clamped edges, `wx` stored
/// as `f32` and promoted back to `f64` while `fy` stays `f64`.
#[allow(clippy::too_many_arguments)]
fn bilinear_resize(
    src: &[f32],
    w: usize,
    h: usize,
    out: &mut [f32],
    w2: usize,
    h2: usize,
    x0: &mut [u32],
    x1: &mut [u32],
    wx: &mut [f32],
) {
    let x_ratio = (w as f64) / (w2 as f64);
    let y_ratio = (h as f64) / (h2 as f64);
    let w_last = (w - 1) as isize;
    let h_last = (h - 1) as isize;

    for x in 0..w2 {
        let sx = (x as f64 + 0.5) * x_ratio - 0.5;
        let fl = sx.floor();
        let mut ix = fl as isize;
        if ix < 0 {
            ix = 0;
        } else if ix > w_last {
            ix = w_last;
        }
        let mut ix1 = ix + 1;
        if ix1 > w_last {
            ix1 = w_last;
        }
        x0[x] = ix as u32;
        x1[x] = ix1 as u32;
        let mut f = sx - fl;
        if f < 0.0 {
            f = 0.0;
        } else if f > 1.0 {
            f = 1.0;
        }
        wx[x] = f as f32;
    }

    for y in 0..h2 {
        let sy = (y as f64 + 0.5) * y_ratio - 0.5;
        let fl = sy.floor();
        let mut iy = fl as isize;
        if iy < 0 {
            iy = 0;
        } else if iy > h_last {
            iy = h_last;
        }
        let mut iy1 = iy + 1;
        if iy1 > h_last {
            iy1 = h_last;
        }
        let mut fy = sy - fl;
        if fy < 0.0 {
            fy = 0.0;
        } else if fy > 1.0 {
            fy = 1.0;
        }
        let row0 = (iy as usize) * w;
        let row1 = (iy1 as usize) * w;
        let out_row = y * w2;
        let inv_fy = 1.0 - fy;

        let r0 = &src[row0..row0 + w];
        let r1 = &src[row1..row1 + w];
        let dst = &mut out[out_row..out_row + w2];
        for x in 0..w2 {
            let ix0 = x0[x] as usize;
            let ix1 = x1[x] as usize;
            let fx = wx[x] as f64;
            let inv_fx = 1.0 - fx;
            let top = inv_fx * (r0[ix0] as f64) + fx * (r0[ix1] as f64);
            let bot = inv_fx * (r1[ix0] as f64) + fx * (r1[ix1] as f64);
            dst[x] = (inv_fy * top + fy * bot) as f32;
        }
    }
}

/// Normalises `raw[0..n_raw]` into `dst[0..n_raw]` as `farF32[i] = 1 - clamp01((raw[i] - lo) * invRange)`.
fn normalise_far(raw: &[f32], dst: &mut [f32], lo: f64, hi: f64) {
    let range = hi - lo;
    let inv_range = if range > 1e-12 { 1.0 / range } else { 0.0 };
    for (r, d) in raw.iter().zip(dst.iter_mut()) {
        let mut t = (*r as f64 - lo) * inv_range;
        if t < 0.0 {
            t = 0.0;
        } else if t > 1.0 {
            t = 1.0;
        }
        *d = (1.0 - t) as f32;
    }
}

/// `guidedFar({ raw, rw, rh, grey, gw, gh, r, eps, lo, hi }, boxBlurs)` of `inpaint_depth.js` into `out`
/// (`gw * gh` `u16`s). All intermediate planes and column sums live in the caller's `scratch`.
#[allow(clippy::too_many_arguments)]
pub fn guided_far(
    raw: &[f32],
    rw: usize,
    rh: usize,
    grey: &[u8],
    gw: usize,
    gh: usize,
    r_work: usize,
    eps: f64,
    lo: f64,
    hi: f64,
    out: &mut [u16],
    sums: &mut [f64],
    plane_i: &mut [f32],
    plane_p: &mut [f32],
    plane_mi: &mut [f32],
    plane_ip: &mut [f32],
    plane_ii: &mut [f32],
    tmp: &mut [f32],
    wx: &mut [f32],
    x0: &mut [u32],
    x1: &mut [u32],
) {
    let n_raw = rw * rh;
    let n_work = gw * gh;
    let raw = &raw[..n_raw];
    let grey = &grey[..n_work];
    let out = &mut out[..n_work];
    let plane_i = &mut plane_i[..n_work];
    let plane_p = &mut plane_p[..n_work];
    let plane_mi = &mut plane_mi[..n_work];
    let plane_ip = &mut plane_ip[..n_work];
    let plane_ii = &mut plane_ii[..n_work];

    if rw == gw && rh == gh {
        normalise_far(raw, plane_p, lo, hi);
    } else {
        let far_f32 = &mut tmp[..n_raw];
        normalise_far(raw, far_f32, lo, hi);
        bilinear_resize(
            far_f32,
            rw,
            rh,
            plane_p,
            gw,
            gh,
            &mut x0[..gw],
            &mut x1[..gw],
            &mut wx[..gw],
        );
    }

    let inv255 = 1.0_f64 / 255.0_f64;
    for i in 0..n_work {
        let iv_f32 = ((grey[i] as f64) * inv255) as f32;
        let pv_f32 = plane_p[i];
        plane_i[i] = iv_f32;
        plane_mi[i] = iv_f32;
        let iv = iv_f32 as f64;
        plane_ip[i] = (iv * (pv_f32 as f64)) as f32;
        plane_ii[i] = (iv * iv) as f32;
    }

    let tmp_work = &mut tmp[..n_work];
    let sums = &mut sums[..gw];
    let norm = Norm::Div((2 * r_work + 1) as f64);
    box_pass::<1>(plane_mi, tmp_work, sums, gw, gh, r_work, norm);
    box_pass::<1>(plane_p, tmp_work, sums, gw, gh, r_work, norm);
    box_pass::<1>(plane_ip, tmp_work, sums, gw, gh, r_work, norm);
    box_pass::<1>(plane_ii, tmp_work, sums, gw, gh, r_work, norm);

    for i in 0..n_work {
        let mi = plane_mi[i] as f64;
        let mp = plane_p[i] as f64;
        let cov_ip = (plane_ip[i] as f64) - mi * mp;
        let var_i = (plane_ii[i] as f64) - mi * mi;
        let av = cov_ip / (var_i + eps);
        plane_ip[i] = av as f32;
        plane_ii[i] = (mp - av * mi) as f32;
    }

    box_pass::<1>(plane_ip, tmp_work, sums, gw, gh, r_work, norm);
    box_pass::<1>(plane_ii, tmp_work, sums, gw, gh, r_work, norm);

    for i in 0..n_work {
        let mut v = (plane_ip[i] as f64) * (plane_i[i] as f64) + (plane_ii[i] as f64);
        if v < 0.0 {
            v = 0.0;
        } else if v > 1.0 {
            v = 1.0;
        }
        let q = v as f32;
        out[i] = js_round_u16((q as f64) * 65535.0);
    }
}
