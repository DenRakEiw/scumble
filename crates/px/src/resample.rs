//! The resampler's kernel (PLAN_0_1_31 §7, 23b): one block of destination pixels through an affine map, in integer
//! maths, the twin of `resampleBlock` in `renderer/editor/inpaint_resample.js` (that file has the contract; this is
//! the same arithmetic in i64, so both give the same bytes, `tools/px_test.js`).
//!
//!   position   S = A·X + C·Y + E (the map at 2^32), tap index S >> 32 (floor), phase (S >> 24) & 255
//!   weights    the caller's table: `taps` integers per phase at 2^14, each phase summing to 2^14
//!   sums       SA = Σ wy·Σ wx·a, SC = Σ wy·Σ wx·a·c (exact; below 2^53 as in the twin)
//!   alpha      (SA + 2^27) >> 28, clamped to 255; 0 gives a pixel of zeros
//!   colour     floor((2·SC + SA) / (2·SA)) clamped to 0..255 (the twin's double division lands on the same floor)
//!   masks      the alpha alone, in the given colour
//!   opaque     a block with no alpha below 255 takes (Σ w·c + 2^27) >> 28, the same bytes
//!   round trip bytes of alpha below 255 through the canvas round-trip table when one is given

const HALF28: i64 = 1 << 27;

pub struct Block<'a> {
    pub data: &'a [u8],
    pub w: usize,
    pub h: usize,
    pub x: i64,
    pub y: i64,
}

pub struct Map {
    pub a: i64,
    pub b: i64,
    pub c: i64,
    pub d: i64,
    pub e: i64,
    pub f: i64,
}

pub struct Out<'a> {
    pub data: &'a mut [u8],
    pub x0: i64,
    pub y0: i64,
    pub w: usize,
    pub h: usize,
}

#[inline]
fn clamp_index(v: i64, max: i64) -> usize {
    (if v < 0 { 0 } else if v > max { max } else { v }) as usize
}

#[inline]
fn clamp_byte(v: i64) -> u8 {
    if v < 0 { 0 } else if v > 255 { 255 } else { v as u8 }
}

/// The destination block `out` (w x h pixels, packed rows) from `block`; returns how many pixels have an alpha above 0.
#[allow(clippy::too_many_arguments)]
pub fn resample(block: &Block, m: &Map, weights: &[i32], taps: usize, alpha: bool, rgb: u32, rt: Option<&[u8]>, out: &mut Out) -> u32 {
    let need = block.w * block.h * 4;
    if block.data.len() < need || weights.len() < 256 * taps || out.data.len() < out.w * out.h * 4 || block.w < taps || block.h < taps {
        return 0;
    }
    if taps == 4 { run::<4>(block, m, weights, alpha, rgb, rt, out) } else { run::<2>(block, m, weights, alpha, rgb, rt, out) }
}

/// The kernel for `T` taps a side (2 bilinear, 4 bicubic). Every read is inside by construction: the tap index is
/// clamped to the block and the weights index is a phase times `T`; the sizes were checked above.
fn run<const T: usize>(block: &Block, m: &Map, weights: &[i32], alpha: bool, rgb: u32, rt: Option<&[u8]>, out: &mut Out) -> u32 {
    let lead: i64 = if T == 4 { 1 } else { 0 };
    let max_x = block.w as i64 - T as i64;
    let max_y = block.h as i64 - T as i64;
    let row = block.w * 4;
    let src = block.data;
    let opaque = !alpha && src[..block.w * block.h * 4].chunks_exact(4).all(|p| p[3] == 255);
    let (cr, cg, cb) = ((rgb & 255) as u8, ((rgb >> 8) & 255) as u8, ((rgb >> 16) & 255) as u8);
    let mut count: u32 = 0;
    for j in 0..out.h {
        let yy = out.y0 + j as i64;
        let mut sx = m.a * out.x0 + m.c * yy + m.e;
        let mut sy = m.b * out.x0 + m.d * yy + m.f;
        let mut o = j * out.w * 4;
        for _ in 0..out.w {
            let cx = clamp_index((sx >> 32) - lead - block.x, max_x);
            let cy = clamp_index((sy >> 32) - lead - block.y, max_y);
            let wx = (((sx >> 24) & 255) as usize) * T;
            let wy = (((sy >> 24) & 255) as usize) * T;
            let mut p = (cy * block.w + cx) * 4;
            // SAFETY: p + (T - 1) * row + 4 * T <= w * h * 4 since cx <= w - T and cy <= h - T; wx + T and wy + T are at
            // most 256 * T; o + 4 <= out.w * out.h * 4
            unsafe {
                if opaque {
                    // alpha is 255 everywhere: Σ w·c, a row of T taps fits i32 (4 · 20000 · 255 < 2^31)
                    let (mut sr, mut sg, mut sb) = (0i64, 0i64, 0i64);
                    for r in 0..T {
                        let (mut rr, mut rg, mut rb) = (0i32, 0i32, 0i32);
                        for k in 0..T {
                            let w = *weights.get_unchecked(wx + k);
                            let q = p + 4 * k;
                            rr += w * *src.get_unchecked(q) as i32;
                            rg += w * *src.get_unchecked(q + 1) as i32;
                            rb += w * *src.get_unchecked(q + 2) as i32;
                        }
                        let w = *weights.get_unchecked(wy + r) as i64;
                        sr += w * rr as i64;
                        sg += w * rg as i64;
                        sb += w * rb as i64;
                        p += row;
                    }
                    *out.data.get_unchecked_mut(o) = clamp_byte((sr + HALF28) >> 28);
                    *out.data.get_unchecked_mut(o + 1) = clamp_byte((sg + HALF28) >> 28);
                    *out.data.get_unchecked_mut(o + 2) = clamp_byte((sb + HALF28) >> 28);
                    *out.data.get_unchecked_mut(o + 3) = 255;
                    count += 1;
                } else {
                    let (mut sa, mut sr, mut sg, mut sb) = (0i64, 0i64, 0i64, 0i64);
                    for r in 0..T {
                        // w·a fits i32 and so does their sum over a row; w·a·c does not, so the colour sums are i64
                        let (mut ra, mut rr, mut rg, mut rb) = (0i32, 0i64, 0i64, 0i64);
                        for k in 0..T {
                            let q = p + 4 * k;
                            let a = *src.get_unchecked(q + 3) as i32;
                            if a != 0 {
                                let wa = *weights.get_unchecked(wx + k) * a;
                                ra += wa;
                                if !alpha {
                                    let wa = wa as i64;
                                    rr += wa * *src.get_unchecked(q) as i64;
                                    rg += wa * *src.get_unchecked(q + 1) as i64;
                                    rb += wa * *src.get_unchecked(q + 2) as i64;
                                }
                            }
                        }
                        let w = *weights.get_unchecked(wy + r) as i64;
                        sa += w * ra as i64;
                        if !alpha {
                            sr += w * rr;
                            sg += w * rg;
                            sb += w * rb;
                        }
                        p += row;
                    }
                    let a = (sa + HALF28) >> 28;
                    let px = out.data.get_unchecked_mut(o..o + 4);
                    if a <= 0 {
                        px.copy_from_slice(&[0, 0, 0, 0]);
                    } else {
                        let a = if a > 255 { 255 } else { a };
                        count += 1;
                        let (mut r, mut g, mut b) = if alpha {
                            (cr, cg, cb)
                        } else {
                            let d = 2 * sa;
                            (clamp_byte((2 * sr + sa).div_euclid(d)), clamp_byte((2 * sg + sa).div_euclid(d)), clamp_byte((2 * sb + sa).div_euclid(d)))
                        };
                        if let Some(t) = rt {
                            if a < 255 {
                                let base = (a as usize) << 8;
                                r = t[base | r as usize];
                                g = t[base | g as usize];
                                b = t[base | b as usize];
                            }
                        }
                        px[0] = r;
                        px[1] = g;
                        px[2] = b;
                        px[3] = a as u8;
                    }
                }
            }
            o += 4;
            sx += m.a;
            sy += m.b;
        }
    }
    count
}
