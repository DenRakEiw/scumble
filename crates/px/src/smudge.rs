//! The smudge's dab (docs/PLAN_0_1_31.md §4 step 3): a carry buffer the brush holds, laid down where the dab lands
//! and refilled from what lies there. The carry is the dab box's own size, one premultiplied RGBA of 16 bits a pixel,
//! so it moves with the brush a whole box at a time and a long drag keeps its tail instead of losing it to 8-bit
//! rounding. Per pixel, `m` the dab's coverage (0..255), `S` what the brush samples there (the layer, or the picture
//! under it), `T` the layer's pixel, `C` the carry, all premultiplied to 16 bits:
//!
//!   a  = (strength · m + 127) / 255                       0..65536, strength 0..65536
//!   T' = T + lerp(C − T, a)                                laid down (with alpha lock T's alpha stays)
//!   P  = S + lerp(C − S, a)                                what lies there once the dab is laid down
//!   C' = P + lerp(C − P, keep)                             keep 0..65536: how much of the carry it keeps
//!
//! with lerp(d, w) = floor((d · w + 32768) / 65536). At keep 0 the carry is what the dab left behind, which is the
//! smudge of 0.1.31 (it read the box at the previous step, after that step's write); with keep near 1 the paint goes
//! on as far as the stroke. `pickup` (the first dab of a stroke) only fills the carry with `S`. Premultiplied 16 bits
//! from straight 8: c · a · 257 / 255 rounded, alpha a · 257; back: alpha (A + 128) / 257, colour (c · 255 + A / 2) / A,
//! colour 0 at alpha 0. A pixel the dab does not cover (`a` 0) keeps its bytes. Every step is an integer operation, so
//! the JS twin (`smudgeDab` in renderer/editor/px/kernels_js.js) and both builds give the same bytes (tools/px_test.js).

#[inline(always)]
fn lerp(d: i64, w: i64) -> i64 {
    (d * w + 32768) >> 16
}

#[inline(always)]
fn pre(c: u8, a: u8) -> i64 {
    ((c as i64) * (a as i64) * 257 + 127) / 255
}

/// Straight RGBA8 of a premultiplied 16-bit pixel.
#[inline(always)]
fn straight(n: &[i64; 4], out: &mut [u8]) {
    let a = n[3];
    let a8 = (a + 128) / 257;
    if a8 <= 0 {
        out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
        return;
    }
    for c in 0..3 {
        let v = (n[c] * 255 + a / 2) / a;
        out[c] = if v > 255 { 255 } else { v as u8 };
    }
    out[3] = a8 as u8;
}

pub const ALPHA_LOCK: u32 = 1;
pub const PICKUP: u32 = 2;

/// One dab over `n` pixels: `dst` the layer's straight RGBA8 (written where the dab covers), `src` what is sampled
/// there (straight RGBA8, may equal `dst`'s bytes before the call), `carry` 4n premultiplied u16, `mask` n bytes.
pub fn smudge_dab(dst: &mut [u8], src: &[u8], carry: &mut [u16], mask: &[u8], strength: u32, keep: u32, flags: u32) {
    let n = mask.len().min(dst.len() / 4).min(src.len() / 4).min(carry.len() / 4);
    let s = strength.min(65536) as i64;
    let keep = keep.min(65536) as i64;
    let lock = flags & ALPHA_LOCK != 0;
    for k in 0..n {
        let o = k * 4;
        let sa = src[o + 3];
        let sp = [pre(src[o], sa), pre(src[o + 1], sa), pre(src[o + 2], sa), (sa as i64) * 257];
        if flags & PICKUP != 0 {
            for c in 0..4 {
                carry[o + c] = sp[c] as u16;
            }
            continue;
        }
        let a = (s * (mask[k] as i64) + 127) / 255;
        let cp = [carry[o] as i64, carry[o + 1] as i64, carry[o + 2] as i64, carry[o + 3] as i64];
        if a > 0 {
            let ta = dst[o + 3];
            let tp = [pre(dst[o], ta), pre(dst[o + 1], ta), pre(dst[o + 2], ta), (ta as i64) * 257];
            let mut nt = [0i64; 4];
            for c in 0..4 {
                nt[c] = tp[c] + lerp(cp[c] - tp[c], a);
            }
            if !lock {
                straight(&nt, &mut dst[o..o + 4]);
            } else if ta > 0 {
                // the colour of what was laid down, at the alpha the layer had
                let mut px = [0u8; 4];
                straight(&nt, &mut px);
                if px[3] > 0 {
                    dst[o] = px[0]; dst[o + 1] = px[1]; dst[o + 2] = px[2];
                }
            }
        }
        for c in 0..4 {
            let p = sp[c] + lerp(cp[c] - sp[c], a);
            carry[o + c] = (p + lerp(cp[c] - p, keep)) as u16;
        }
    }
}
