//! The blur and sharpen brushes' filters (`renderer/editor/inpaint_stroke.js` `blurRGBA`, `sharpenRGBA`; K26 of
//! docs/PLAN_WASM_BUILD.md): straight RGBA8 premultiplied into f32, three box passes of radius r each way on the
//! generic box pass (`maskf::box_pass`, four channels, `sum * (1 / (2r + 1))` as the twin's `sum * k`), back to straight
//! bytes. The twins' bytes bit for bit: the products and divisions in f64 rounded to f32 where the twin stores into a
//! `Float32Array`, every byte stored as a `Uint8ClampedArray` stores it (NaN 0, clamped, ties to even).

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
        v.round_ties_even() as u8
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
