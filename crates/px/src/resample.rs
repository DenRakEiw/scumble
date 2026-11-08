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

/// Sample `T` x `T` taps from `src` at byte offset `p` (with row stride `row`) and write one RGBA8 pixel to `px`
/// (`&mut out.data[o..o + 4]`). Returns 1 when the pixel's alpha is above 0, else 0.
///
/// SAFETY: `p + (T - 1) * row + 4 * T <= src.len()`, `wx + T <= weights.len()`, `wy + T <= weights.len()`,
/// `px.len() == 4`, and `rt` (when `Some`) has at least 65,536 bytes.
#[inline(always)]
unsafe fn sample<const T: usize>(
    src: &[u8],
    row: usize,
    mut p: usize,
    weights: &[i32],
    wx: usize,
    wy: usize,
    opaque: bool,
    alpha: bool,
    (cr, cg, cb): (u8, u8, u8),
    rt: Option<&[u8]>,
    px: &mut [u8],
) -> u32 {
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
        *px.get_unchecked_mut(0) = clamp_byte((sr + HALF28) >> 28);
        *px.get_unchecked_mut(1) = clamp_byte((sg + HALF28) >> 28);
        *px.get_unchecked_mut(2) = clamp_byte((sb + HALF28) >> 28);
        *px.get_unchecked_mut(3) = 255;
        1
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
        if a <= 0 {
            px.copy_from_slice(&[0, 0, 0, 0]);
            0
        } else {
            let a = if a > 255 { 255 } else { a };
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
            1
        }
    }
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
            let p = (cy * block.w + cx) * 4;
            // SAFETY: p + (T - 1) * row + 4 * T <= w * h * 4 since cx <= w - T and cy <= h - T; wx + T and wy + T are at
            // most 256 * T; o + 4 <= out.w * out.h * 4
            unsafe {
                let px = out.data.get_unchecked_mut(o..o + 4);
                count += sample::<T>(src, row, p, weights, wx, wy, opaque, alpha, (cr, cg, cb), rt, px);
            }
            o += 4;
            sx += m.a;
            sy += m.b;
        }
    }
    count
}

/// Liquify's bake kernel (`liquifyBlock` in `renderer/editor/inpaint_liquify.js`, K28): the destination block `out`
/// (`w` x `h` packed pixels at `(x0, y0)`) sampled from `block` through the dense nodes `nodes` (`nw` nodes a row from
/// `(nx0, ny0)` at grid step `s` in `{1, 2, 4, 8}`). A pixel whose two phases are 0 copies its source pixel's four
/// bytes verbatim; any other pixel takes the 4-tap bicubic `sample::<4>` above. Returns how many pixels came out with
/// an alpha above 0.
#[allow(clippy::too_many_arguments)]
pub fn liquify(
    block: &Block,
    nodes: &[i32],
    nw: usize,
    nx0: i32,
    ny0: i32,
    s: u32,
    weights: &[i32],
    rt: Option<&[u8]>,
    out: &mut Out,
) -> u32 {
    if !matches!(s, 1 | 2 | 4 | 8) || nw < 2 || out.w == 0 || out.h == 0 || block.w < 4 || block.h < 4 {
        return 0;
    }
    let Some(need_block) = block.w.checked_mul(block.h).and_then(|n| n.checked_mul(4)) else { return 0 };
    let Some(need_out) = out.w.checked_mul(out.h).and_then(|n| n.checked_mul(4)) else { return 0 };
    if block.data.len() < need_block || weights.len() < 256 * 4 || out.data.len() < need_out {
        return 0;
    }
    if out.x0 < i32::MIN as i64 || out.y0 < i32::MIN as i64 {
        return 0;
    }
    let x0 = out.x0 as i32;
    let y0 = out.y0 as i32;
    let Some(x_last) = x0.checked_add((out.w - 1) as i32) else { return 0 };
    let Some(y_last) = y0.checked_add((out.h - 1) as i32) else { return 0 };
    let ls = s.trailing_zeros();
    let k = 8 + 2 * ls;
    let kp = k - 8;
    let s = s as i32;
    let sm = s - 1;
    let Some(gx0_min) = (x0 >> ls).checked_sub(nx0) else { return 0 };
    let Some(gx0_max) = (x_last >> ls).checked_sub(nx0) else { return 0 };
    let Some(gy0_min) = (y0 >> ls).checked_sub(ny0) else { return 0 };
    let Some(gy0_max) = (y_last >> ls).checked_sub(ny0) else { return 0 };
    if gx0_min < 0 || gy0_min < 0 || (gx0_max as usize) + 1 >= nw {
        return 0;
    }
    let Some(need_nodes) = (gy0_max as usize + 1)
        .checked_mul(nw)
        .and_then(|r| r.checked_add(gx0_max as usize + 2))
        .and_then(|n| n.checked_mul(2))
    else {
        return 0;
    };
    if nodes.len() < need_nodes {
        return 0;
    }
    let max_x = block.w as i64 - 4;
    let max_y = block.h as i64 - 4;
    let max_w1 = block.w as i64 - 1;
    let max_h1 = block.h as i64 - 1;
    let row = block.w * 4;
    let src = block.data;
    let opaque = src[..need_block].chunks_exact(4).all(|p| p[3] == 255);
    let mut count: u32 = 0;
    for j in 0..out.h {
        let yy = y0 + j as i32;
        let fy = yy & sm;
        let gy = s - fy;
        let r0 = (((yy >> ls) - ny0) as usize) * nw * 2;
        let r1 = r0 + nw * 2;
        let yk = yy.wrapping_shl(k);
        let mut o = j * out.w * 4;
        for i in 0..out.w {
            let xx = x0 + i as i32;
            let fx = xx & sm;
            let gx = s - fx;
            let gx0 = ((xx >> ls) - nx0) as usize * 2;
            let a = r0 + gx0;
            let b = r1 + gx0;
            let w00 = gx * gy;
            let w10 = fx * gy;
            let w01 = gx * fy;
            let w11 = fx * fy;
            // SAFETY: gx0_min >= 0, gy0_min >= 0, gx0_max + 1 < nw, and b + 3 < need_nodes <= nodes.len()
            let (sx, sy) = unsafe {
                let dx = w00
                    .wrapping_mul(*nodes.get_unchecked(a))
                    .wrapping_add(w10.wrapping_mul(*nodes.get_unchecked(a + 2)))
                    .wrapping_add(w01.wrapping_mul(*nodes.get_unchecked(b)))
                    .wrapping_add(w11.wrapping_mul(*nodes.get_unchecked(b + 2)));
                let dy = w00
                    .wrapping_mul(*nodes.get_unchecked(a + 1))
                    .wrapping_add(w10.wrapping_mul(*nodes.get_unchecked(a + 3)))
                    .wrapping_add(w01.wrapping_mul(*nodes.get_unchecked(b + 1)))
                    .wrapping_add(w11.wrapping_mul(*nodes.get_unchecked(b + 3)));
                (xx.wrapping_shl(k).wrapping_add(dx), yk.wrapping_add(dy))
            };
            let px_phase = ((sx >> kp) & 255) as usize;
            let py_phase = ((sy >> kp) & 255) as usize;
            if px_phase == 0 && py_phase == 0 {
                let cx = clamp_index((sx >> k) as i64 - block.x, max_w1);
                let cy = clamp_index((sy >> k) as i64 - block.y, max_h1);
                let q = (cy * block.w + cx) * 4;
                // SAFETY: cx <= block.w - 1, cy <= block.h - 1, so q + 4 <= need_block; o + 4 <= need_out
                unsafe {
                    let dst = out.data.get_unchecked_mut(o..o + 4);
                    let p0 = src.get_unchecked(q..q + 4);
                    dst.copy_from_slice(p0);
                    if p0[3] != 0 {
                        count += 1;
                    }
                }
            } else {
                let cx = clamp_index((sx >> k) as i64 - 1 - block.x, max_x);
                let cy = clamp_index((sy >> k) as i64 - 1 - block.y, max_y);
                let wx = px_phase * 4;
                let wy = py_phase * 4;
                let p = (cy * block.w + cx) * 4;
                // SAFETY: cx <= block.w - 4, cy <= block.h - 4, wx + 4 <= 1024, wy + 4 <= 1024, o + 4 <= need_out
                unsafe {
                    let dst = out.data.get_unchecked_mut(o..o + 4);
                    count += sample::<4>(src, row, p, weights, wx, wy, opaque, false, (0, 0, 0), rt, dst);
                }
            }
            o += 4;
        }
    }
    count
}
