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
//!
//! The eight blend modes (B item 7, ops 5 to 12) are the W3C compositing formula, rounded ONCE per channel: with three
//! rounded products the result was up to 1.45 levels from the exact value and a level from the compositor's shader on
//! 29 % of the bytes of a half-transparent layer; rounded once it is within half a level (12 % from the shader, which
//! reads its source back from a premultiplied 8-bit texture).
//!
//!   B16(cb, cs) = 255 · B, exact integers:
//!     multiply    b·s                          screen      65025 − (255 − b)(255 − s)
//!     hard-light  s ≤ 127 ? 2·b·s : 65025 − (255 − b)(510 − 2s)        overlay: b and s swapped
//!     darken, lighten, difference   255 · min, max, |b − s|
//!     soft-light  s ≤ 127 ? 255·b − ((255 − 2s)·b·(255 − b) + 127) / 255
//!                         : 255·b + ((2s − 255)·(D[b] − 257·b) + 128) / 257
//!                 D[b] = round(65535 · d(b / 255)), d as the specification has it (a table, so that no square
//!                 root is taken twice in two languages)
//!   over an opaque backdrop:  r = (dp·inv·255 + sa·B16 + 32512) / 65025
//!   else, with cb = dp unpremultiplied as at the end and ra = sa + mul255(da, inv):
//!     r = min(ra, (s.c·sa·(255 − da)·255 + dp·inv·65025 + sa·da·B16 + 8290687) / 16581375)
//!   which is the first line where da is 255. Everything fits 32 bits (255⁴ + 255³/2 < 2³²). The SIMD path takes four
//!   pixels at a time where all four backdrop pixels are opaque, in 32-bit lanes, and divides through floats with the
//!   remainder put right (the sums stay below 2²⁴, so the conversion is exact).

pub const SOURCE_OVER: u8 = 0;
pub const DESTINATION_OUT: u8 = 1;
pub const SOURCE_ATOP: u8 = 2;
pub const DESTINATION_IN: u8 = 3;
pub const COPY: u8 = 4;
pub const MULTIPLY: u8 = 5;
pub const SCREEN: u8 = 6;
pub const OVERLAY: u8 = 7;
pub const DARKEN: u8 = 8;
pub const LIGHTEN: u8 = 9;
pub const SOFT_LIGHT: u8 = 10;
pub const HARD_LIGHT: u8 = 11;
pub const DIFFERENCE: u8 = 12;

/// round(65535 · d(b / 255)) of soft-light: d = ((16b − 12)b + 4)b up to a quarter (b ≤ 63), else the square root.
static SOFT_D: [u16; 256] = [
    0, 1016, 2008, 2977, 3923, 4846, 5746, 6625, 7482, 8318, 9134, 9929, 10704, 11459, 12195, 12912,
    13611, 14291, 14954, 15600, 16228, 16840, 17436, 18016, 18580, 19129, 19664, 20184, 20690, 21183, 21663, 22129,
    22584, 23026, 23457, 23876, 24284, 24682, 25070, 25448, 25817, 26176, 26527, 26870, 27205, 27532, 27852, 28166,
    28473, 28774, 29069, 29360, 29645, 29926, 30203, 30476, 30746, 31013, 31278, 31540, 31800, 32059, 32317, 32575,
    32832, 33087, 33341, 33592, 33842, 34090, 34336, 34581, 34823, 35064, 35304, 35541, 35778, 36012, 36245, 36477,
    36707, 36936, 37163, 37389, 37613, 37837, 38059, 38279, 38499, 38717, 38934, 39149, 39364, 39577, 39789, 40000,
    40210, 40419, 40627, 40834, 41040, 41244, 41448, 41651, 41852, 42053, 42253, 42452, 42650, 42847, 43043, 43238,
    43432, 43626, 43818, 44010, 44201, 44391, 44580, 44769, 44957, 45144, 45330, 45515, 45700, 45884, 46067, 46249,
    46431, 46612, 46792, 46972, 47151, 47329, 47507, 47684, 47860, 48036, 48211, 48385, 48559, 48732, 48904, 49076,
    49248, 49418, 49588, 49758, 49927, 50095, 50263, 50430, 50597, 50763, 50929, 51094, 51258, 51422, 51586, 51749,
    51911, 52073, 52235, 52396, 52556, 52716, 52876, 53035, 53193, 53351, 53509, 53666, 53823, 53979, 54135, 54290,
    54445, 54600, 54754, 54907, 55060, 55213, 55365, 55517, 55669, 55820, 55971, 56121, 56271, 56420, 56569, 56718,
    56866, 57014, 57162, 57309, 57455, 57602, 57748, 57893, 58039, 58184, 58328, 58472, 58616, 58760, 58903, 59046,
    59188, 59330, 59472, 59613, 59755, 59895, 60036, 60176, 60316, 60455, 60594, 60733, 60872, 61010, 61148, 61285,
    61422, 61559, 61696, 61832, 61968, 62104, 62240, 62375, 62510, 62644, 62779, 62913, 63046, 63180, 63313, 63446,
    63578, 63711, 63843, 63974, 64106, 64237, 64368, 64499, 64629, 64759, 64889, 65019, 65148, 65277, 65406, 65535,
];

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
    if layer.op >= MULTIPLY && layer.op <= DIFFERENCE {
        let start = simd::blend(dst, src, layer.op, layer.alpha, mask);
        blend_from(dst, src, layer.op, layer.alpha as u32, mask, start);
        return;
    }
    let start = simd::layer(dst, src, layer.op, layer.alpha, mask);
    scalar_layer(dst, src, layer.op, layer.alpha as u32, mask, start);
}

#[inline(always)]
fn hard_light(b: u32, s: u32) -> u32 {
    if s <= 127 {
        2 * b * s
    } else {
        65025 - (255 - b) * (510 - 2 * s)
    }
}

/// 255 · B(cb, cs) of the blend mode `OP`, both straight 0..255: 0..65025.
#[inline(always)]
fn blend_of<const OP: u8>(b: u32, s: u32) -> u32 {
    match OP {
        MULTIPLY => b * s,
        SCREEN => 65025 - (255 - b) * (255 - s),
        OVERLAY => hard_light(s, b),
        DARKEN => 255 * b.min(s),
        LIGHTEN => 255 * b.max(s),
        SOFT_LIGHT => {
            if s <= 127 {
                255 * b - ((255 - 2 * s) * b * (255 - b) + 127) / 255
            } else {
                255 * b + ((2 * s - 255) * (SOFT_D[b as usize] as u32 - b * 257) + 128) / 257
            }
        }
        HARD_LIGHT => hard_light(b, s),
        _ => 255 * (b.max(s) - b.min(s)),
    }
}

/// The pixels from `start` on in the blend mode `op`.
fn blend_from(dst: &mut [u8], src: &[u8], op: u8, o: u32, mask: Option<&[u8]>, start: usize) {
    match op {
        MULTIPLY => scalar_blend::<MULTIPLY>(dst, src, o, mask, start),
        SCREEN => scalar_blend::<SCREEN>(dst, src, o, mask, start),
        OVERLAY => scalar_blend::<OVERLAY>(dst, src, o, mask, start),
        DARKEN => scalar_blend::<DARKEN>(dst, src, o, mask, start),
        LIGHTEN => scalar_blend::<LIGHTEN>(dst, src, o, mask, start),
        SOFT_LIGHT => scalar_blend::<SOFT_LIGHT>(dst, src, o, mask, start),
        HARD_LIGHT => scalar_blend::<HARD_LIGHT>(dst, src, o, mask, start),
        _ => scalar_blend::<DIFFERENCE>(dst, src, o, mask, start),
    }
}

#[inline(always)]
fn scalar_blend<const OP: u8>(dst: &mut [u8], src: &[u8], o: u32, mask: Option<&[u8]>, start: usize) {
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
        if sa == 0 {
            continue;
        }
        let inv = 255 - sa;
        let da = d[3] as u32;
        let mut r = [0u32; 4];
        if da == 255 {
            for c in 0..3 {
                r[c] = (d[c] as u32 * inv * 255 + sa * blend_of::<OP>(d[c] as u32, s[c] as u32) + 32512) / 65025;
            }
            r[3] = 255;
        } else {
            let ra = sa + mul255(da, inv);
            let both = sa * da;
            let only = sa * (255 - da) * 255;
            let h = da >> 1;
            for c in 0..3 {
                let dp = d[c] as u32;
                let cb = if da == 0 { 0 } else { ((dp * 255 + h) / da).min(255) };
                let x = s[c] as u32 * only + dp * inv * 65025 + both * blend_of::<OP>(cb, s[c] as u32) + 8290687;
                r[c] = (x / 16581375).min(ra);
            }
            r[3] = ra;
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
    #[inline(always)]
    pub fn blend(_: &mut [u8], _: &[u8], _: u8, _: u8, _: Option<&[u8]>) -> usize {
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

    /// 255 · hard-light in 32-bit lanes: s ≤ 127 ? 2·b·s : 65025 − (255 − b)(510 − 2s).
    #[inline(always)]
    unsafe fn hard_light(b: v128, s: v128) -> v128 {
        let c255 = u32x4_splat(255);
        let lo = u32x4_shl(u32x4_mul(b, s), 1);
        let hi = u32x4_sub(u32x4_splat(65025), u32x4_mul(u32x4_sub(c255, b), u32x4_sub(u32x4_splat(510), u32x4_shl(s, 1))));
        v128_bitselect(hi, lo, u32x4_gt(s, u32x4_splat(127)))
    }

    /// One pixel (its four channels as 32-bit lanes) in a blend mode over an opaque backdrop:
    /// (d·inv·255 + sa·B16 + 32512) / 65025. The sum is below 2²⁴, so the float holds it exactly; the quotient
    /// of the float division is put right by its remainder.
    #[inline(always)]
    unsafe fn blend_pixel(d: v128, s: v128, sa: v128, op: u8) -> v128 {
        let c255 = u32x4_splat(255);
        let b16 = match op {
            MULTIPLY => u32x4_mul(d, s),
            SCREEN => u32x4_sub(u32x4_splat(65025), u32x4_mul(u32x4_sub(c255, d), u32x4_sub(c255, s))),
            OVERLAY => hard_light(s, d),
            DARKEN => u32x4_mul(u32x4_min(d, s), c255),
            LIGHTEN => u32x4_mul(u32x4_max(d, s), c255),
            HARD_LIGHT => hard_light(d, s),
            _ => u32x4_mul(u32x4_sub(u32x4_max(d, s), u32x4_min(d, s)), c255),
        };
        let inv = u32x4_sub(c255, sa);
        let x = u32x4_add(u32x4_add(u32x4_mul(u32x4_mul(d, inv), c255), u32x4_mul(sa, b16)), u32x4_splat(32512));
        let q = u32x4_trunc_sat_f32x4(f32x4_mul(f32x4_convert_u32x4(x), f32x4_splat(1.0 / 65025.0)));
        let r = i32x4_sub(x, i32x4_mul(q, i32x4_splat(65025)));
        // r < 0: one too many (the mask is −1); r ≥ 65025: one too few
        let q = i32x4_add(q, i32x4_lt(r, i32x4_splat(0)));
        i32x4_sub(q, i32x4_gt(r, i32x4_splat(65024)))
    }

    /// One source in a blend mode, four pixels at a time where all four backdrop pixels are opaque (the
    /// others, and all of soft-light with its table, go the scalar way). Returns the pixels done.
    pub fn blend(dst: &mut [u8], src: &[u8], op: u8, o: u8, mask: Option<&[u8]>) -> usize {
        if op == SOFT_LIGHT {
            return 0;
        }
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
                if !v128_any_true(sa) {
                    i += 16;
                    continue;
                }
                let d = v128_load(pd.add(i) as *const v128);
                if !u8x16_all_true(u8x16_eq(alphas(d), full)) {
                    let m4 = mask.map(|m| &m[i / 4..i / 4 + 4]);
                    blend_from(&mut dst[i..i + 16], &src[i..i + 16], op, o as u32, m4, 0);
                    i += 16;
                    continue;
                }
                // the sixteen bytes as four pixels of four 32-bit lanes; the alpha lane is set to 255 afterwards
                let (dl, dh) = (u16x8_extend_low_u8x16(d), u16x8_extend_high_u8x16(d));
                let (sl, sh) = (u16x8_extend_low_u8x16(s), u16x8_extend_high_u8x16(s));
                let (al, ah) = (u16x8_extend_low_u8x16(sa), u16x8_extend_high_u8x16(sa));
                let p0 = blend_pixel(u32x4_extend_low_u16x8(dl), u32x4_extend_low_u16x8(sl), u32x4_extend_low_u16x8(al), op);
                let p1 = blend_pixel(u32x4_extend_high_u16x8(dl), u32x4_extend_high_u16x8(sl), u32x4_extend_high_u16x8(al), op);
                let p2 = blend_pixel(u32x4_extend_low_u16x8(dh), u32x4_extend_low_u16x8(sh), u32x4_extend_low_u16x8(ah), op);
                let p3 = blend_pixel(u32x4_extend_high_u16x8(dh), u32x4_extend_high_u16x8(sh), u32x4_extend_high_u16x8(ah), op);
                let r = u8x16_narrow_i16x8(i16x8_narrow_i32x4(p0, p1), i16x8_narrow_i32x4(p2, p3));
                let r = v128_or(r, amask);
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
