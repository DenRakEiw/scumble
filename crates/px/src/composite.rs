//! Source-over (and four other operators) of a stack of sources onto one tile.
//!
//! Straight RGBA8 in and out, premultiplied 8-bit maths in between, integer only, so the
//! JS twin (`compositeTile` in `renderer/editor/px/kernels_js.js`) matches bit for bit:
//!
//!   mul255(x, y) = round(x·y / 255)            exact: t = x·y + 128, (t + (t >> 8)) >> 8
//!   dst is premultiplied once:  dp = mul255(d, da)
//!   per source: sa = mul255(s.a, opacity), sp = mul255(s.c, sa), inv = 255 − sa
//!     source-over      r = sp + mul255(dp, inv)      ra = sa + mul255(da, inv)
//!     destination-out  r = mul255(dp, inv)           ra = mul255(da, inv)
//!     source-atop      r = mul255(sp, da) + mul255(dp, inv)   ra = da (the same formula
//!                      gives da exactly: two rounded terms whose exact sum is an integer)
//!     destination-in   r = mul255(dp, sa)            ra = mul255(da, sa)
//!     copy             r = sp                        ra = sa
//!   a mask m is coverage: r = mul255(r, m) + mul255(dp, 255 − m), the same for ra
//!   unpremultiplied once at the end: c = a == 0 ? 0 : min(255, floor((c·255 + a/2) / a))
//!
//! Every channel, alpha included, follows the same formula when the source's alpha byte is
//! taken as 255 for "sp", which is what lets the SIMD path treat the 16 bytes of four pixels
//! alike. Canvas 2D keeps premultiplied 8-bit pixels too, so the precision is the same.

pub const SOURCE_OVER: u8 = 0;
pub const DESTINATION_OUT: u8 = 1;
pub const SOURCE_ATOP: u8 = 2;
pub const DESTINATION_IN: u8 = 3;
pub const COPY: u8 = 4;

#[inline(always)]
fn mul255(x: u32, y: u32) -> u32 {
    let t = x * y + 128;
    (t + (t >> 8)) >> 8
}

pub struct Layer<'a> {
    pub src: &'a [u8],
    pub op: u8,
    pub alpha: u8,
    pub mask: Option<&'a [u8]>,
}

/// `begin`, one `apply` per layer, `end`: the whole stack over one tile.
pub fn begin(dst: &mut [u8]) {
    let px = dst.len() / 4;
    let dst = &mut dst[..px * 4];
    let start = simd::premultiply(dst);
    for d in dst.chunks_exact_mut(4).skip(start) {
        let a = d[3] as u32;
        if a != 255 {
            d[0] = mul255(d[0] as u32, a) as u8;
            d[1] = mul255(d[1] as u32, a) as u8;
            d[2] = mul255(d[2] as u32, a) as u8;
        }
    }
}

pub fn apply(dst: &mut [u8], layer: &Layer) {
    let px = dst.len() / 4;
    let dst = &mut dst[..px * 4];
    let src = &layer.src[..px * 4];
    let mask = layer.mask.map(|m| &m[..px]);
    let start = simd::layer(dst, src, layer.op, layer.alpha, mask);
    scalar_layer(dst, src, layer.op, layer.alpha as u32, mask, start);
}

pub fn end(dst: &mut [u8]) {
    let px = dst.len() / 4;
    let dst = &mut dst[..px * 4];
    let start = simd::unpremultiply(dst);
    for d in dst.chunks_exact_mut(4).skip(start) {
        let a = d[3] as u32;
        if a == 0 {
            d[0] = 0;
            d[1] = 0;
            d[2] = 0;
        } else if a != 255 {
            let h = a >> 1;
            d[0] = ((d[0] as u32 * 255 + h) / a).min(255) as u8;
            d[1] = ((d[1] as u32 * 255 + h) / a).min(255) as u8;
            d[2] = ((d[2] as u32 * 255 + h) / a).min(255) as u8;
        }
    }
}

#[inline(always)]
fn scalar_layer(dst: &mut [u8], src: &[u8], op: u8, o: u32, mask: Option<&[u8]>, start: usize) {
    let px = dst.len() / 4;
    for i in start..px {
        let m = match mask {
            Some(m) => m[i] as u32,
            None => 255,
        };
        if m == 0 {
            continue;
        }
        let s = &src[i * 4..i * 4 + 4];
        let d = &mut dst[i * 4..i * 4 + 4];
        let mut sa = s[3] as u32;
        if o != 255 {
            sa = mul255(sa, o);
        }
        let inv = 255 - sa;
        let da = d[3] as u32;
        let mut r = [0u32; 4];
        match op {
            SOURCE_OVER => {
                if sa == 0 {
                    continue;
                }
                if sa == 255 && m == 255 {
                    d.copy_from_slice(s);
                    d[3] = 255;
                    continue;
                }
                for c in 0..3 {
                    r[c] = mul255(s[c] as u32, sa) + mul255(d[c] as u32, inv);
                }
                r[3] = sa + mul255(da, inv);
            }
            DESTINATION_OUT => {
                if sa == 0 {
                    continue;
                }
                for c in 0..4 {
                    r[c] = mul255(d[c] as u32, inv);
                }
            }
            SOURCE_ATOP => {
                if sa == 0 {
                    continue;
                }
                for c in 0..3 {
                    r[c] = mul255(mul255(s[c] as u32, sa), da) + mul255(d[c] as u32, inv);
                }
                r[3] = mul255(sa, da) + mul255(da, inv);
            }
            DESTINATION_IN => {
                if sa == 255 {
                    continue;
                }
                for c in 0..4 {
                    r[c] = mul255(d[c] as u32, sa);
                }
            }
            _ => {
                debug_assert_eq!(op, COPY);
                for c in 0..3 {
                    r[c] = mul255(s[c] as u32, sa);
                }
                r[3] = sa;
            }
        }
        if m != 255 {
            let im = 255 - m;
            for c in 0..4 {
                r[c] = mul255(r[c], m) + mul255(d[c] as u32, im);
            }
        }
        d[0] = r[0] as u8;
        d[1] = r[1] as u8;
        d[2] = r[2] as u8;
        d[3] = r[3] as u8;
    }
}

#[cfg(not(target_feature = "simd128"))]
mod simd {
    use super::*;
    #[inline(always)]
    pub fn premultiply(_: &mut [u8]) -> usize {
        0
    }
    #[inline(always)]
    pub fn unpremultiply(_: &mut [u8]) -> usize {
        0
    }
    #[inline(always)]
    pub fn layer(_: &mut [u8], _: &[u8], _: u8, _: u8, _: Option<&[u8]>) -> usize {
        let _ = SOURCE_OVER;
        0
    }
}

#[cfg(target_feature = "simd128")]
mod simd {
    use super::*;
    use core::arch::wasm32::*;

    /// round(x·y / 255) per byte.
    #[inline(always)]
    unsafe fn mul255(x: v128, y: v128) -> v128 {
        let c = u16x8_splat(128);
        let lo = u16x8_add(u16x8_extmul_low_u8x16(x, y), c);
        let hi = u16x8_add(u16x8_extmul_high_u8x16(x, y), c);
        let lo = u16x8_shr(u16x8_add(lo, u16x8_shr(lo, 8)), 8);
        let hi = u16x8_shr(u16x8_add(hi, u16x8_shr(hi, 8)), 8);
        u8x16_narrow_i16x8(lo, hi)
    }

    #[inline(always)]
    unsafe fn alphas(v: v128) -> v128 {
        u8x16_shuffle::<3, 3, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 15, 15, 15, 15>(v, v)
    }

    pub fn premultiply(dst: &mut [u8]) -> usize {
        let n = (dst.len() / 16) * 16;
        unsafe {
            let amask = u32x4_splat(0xFF00_0000);
            let p = dst.as_mut_ptr();
            let mut i = 0;
            while i < n {
                let d = v128_load(p.add(i) as *const v128);
                let a = alphas(d);
                if !u8x16_all_true(u8x16_eq(a, u8x16_splat(255))) {
                    v128_store(p.add(i) as *mut v128, mul255(v128_or(d, amask), a));
                }
                i += 16;
            }
        }
        n / 4
    }

    pub fn unpremultiply(dst: &mut [u8]) -> usize {
        let n = (dst.len() / 16) * 16;
        unsafe {
            let p = dst.as_mut_ptr();
            let byte = u32x4_splat(255);
            let c255 = u32x4_splat(255);
            let mut i = 0;
            while i < n {
                let d = v128_load(p.add(i) as *const v128);
                let a = u32x4_shr(d, 24);
                if !u32x4_all_true(u32x4_eq(a, byte)) {
                    let h = u32x4_shr(a, 1);
                    let af = f32x4_convert_i32x4(a);
                    let div = |c: v128| {
                        // values stay below 2^16: the signed conversions are exact
                        let q = i32x4_trunc_sat_f32x4(f32x4_div(f32x4_convert_i32x4(i32x4_add(i32x4_mul(c, c255), h)), af));
                        u32x4_min(q, byte)
                    };
                    let r = div(v128_and(d, byte));
                    let g = div(v128_and(u32x4_shr(d, 8), byte));
                    let b = div(v128_and(u32x4_shr(d, 16), byte));
                    let out = v128_or(v128_or(r, u32x4_shl(g, 8)), v128_or(u32x4_shl(b, 16), u32x4_shl(a, 24)));
                    v128_store(p.add(i) as *mut v128, out);
                }
                i += 16;
            }
        }
        n / 4
    }

    /// One source over `dst` sixteen bytes at a time. Returns the pixels done.
    pub fn layer(dst: &mut [u8], src: &[u8], op: u8, o: u8, mask: Option<&[u8]>) -> usize {
        let n = (dst.len() / 16) * 16;
        unsafe {
            let pd = dst.as_mut_ptr();
            let ps = src.as_ptr();
            let amask = u32x4_splat(0xFF00_0000);
            let full = u8x16_splat(255);
            let ov = u8x16_splat(o);
            let mut i = 0;
            while i < n {
                let mv = match mask {
                    Some(m) => {
                        let w = (m.as_ptr().add(i / 4) as *const u32).read_unaligned();
                        let mv = u32x4_splat(w);
                        let mv = u8x16_shuffle::<0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3>(mv, mv);
                        if !v128_any_true(mv) {
                            i += 16;
                            continue;
                        }
                        Some(mv)
                    }
                    None => None,
                };
                let s = v128_load(ps.add(i) as *const v128);
                let mut sa = alphas(s);
                if o != 255 {
                    sa = mul255(sa, ov);
                }
                let d = v128_load(pd.add(i) as *const v128);
                let inv = v128_xor(sa, full);
                let r = match op {
                    SOURCE_OVER => {
                        if !v128_any_true(sa) {
                            i += 16;
                            continue;
                        }
                        u8x16_add(mul255(v128_or(s, amask), sa), mul255(d, inv))
                    }
                    DESTINATION_OUT => {
                        if !v128_any_true(sa) {
                            i += 16;
                            continue;
                        }
                        mul255(d, inv)
                    }
                    SOURCE_ATOP => {
                        if !v128_any_true(sa) {
                            i += 16;
                            continue;
                        }
                        let sp = mul255(v128_or(s, amask), sa);
                        u8x16_add(mul255(sp, alphas(d)), mul255(d, inv))
                    }
                    DESTINATION_IN => {
                        if u8x16_all_true(u8x16_eq(sa, full)) {
                            i += 16;
                            continue;
                        }
                        mul255(d, sa)
                    }
                    _ => mul255(v128_or(s, amask), sa),
                };
                let r = match mv {
                    Some(mv) if !u8x16_all_true(u8x16_eq(mv, full)) => u8x16_add(mul255(r, mv), mul255(d, v128_xor(mv, full))),
                    _ => r,
                };
                v128_store(pd.add(i) as *mut v128, r);
                i += 16;
            }
        }
        n / 4
    }
}
