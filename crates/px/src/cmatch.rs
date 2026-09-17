//! The colour match of a layer (B item 7 part 3): every pixel's straight RGB moved towards the statistics of what
//! is below the layer, in place, before the pixel is composited.
//!
//!   per channel c:  m = (v − meanT[c]) · scale[c] + meanS[c]      v the byte as a float
//!                   r = v + (m − v) · k                            k the strength, 0..1
//!                   byte = floor(clamp(r, 0, 255) + 0.5)
//!
//! which is `matchCanvas` (renderer/editor/inpaint_filters.js) and the atlas shader's formula. Every operation is an
//! f32 operation in this order, so the JS twin (`matchPixels` in renderer/editor/px/kernels_js.js, `Math.fround`
//! after every operation) and the scalar and the SIMD build give the same bytes; the rounding is `floor(x + 0.5)`
//! and not `round` because `f32x4.nearest` rounds half to even. Alpha is untouched, and so is a pixel whose alpha is
//! 0 (`matchCanvas` leaves fully transparent pixels alone). Against `matchCanvas` in doubles the bytes are within a
//! level (a tie or an f32 rounding; measured never more, tools/px_test.js).

/// `params`: meanS[3], meanT[3], scale[3], k.
pub fn match_pixels(rgba: &mut [u8], params: &[f32]) {
    let px = rgba.len() / 4;
    let rgba = &mut rgba[..px * 4];
    let (ms, mt, sc, k) = (&params[0..3], &params[3..6], &params[6..9], params[9]);
    let start = simd::match_pixels(rgba, params);
    for p in rgba.chunks_exact_mut(4).skip(start) {
        if p[3] == 0 {
            continue;
        }
        for c in 0..3 {
            let v = p[c] as f32;
            let m = (v - mt[c]) * sc[c] + ms[c];
            let r = v + (m - v) * k;
            let r = if r < 0.0 { 0.0 } else if r > 255.0 { 255.0 } else { r };
            p[c] = (r + 0.5).floor() as u8;
        }
    }
}

#[cfg(not(target_feature = "simd128"))]
mod simd {
    #[inline(always)]
    pub fn match_pixels(_: &mut [u8], _: &[f32]) -> usize {
        0
    }
}

#[cfg(target_feature = "simd128")]
mod simd {
    use core::arch::wasm32::*;

    /// Four pixels per sixteen bytes, each pixel as four f32 lanes; the alpha lane has the identity's parameters
    /// (meanT 0, scale 1, meanS 0, k 0), so it comes out as it went in. Returns the pixels done.
    pub fn match_pixels(rgba: &mut [u8], params: &[f32]) -> usize {
        let n = (rgba.len() / 16) * 16;
        unsafe {
            let ms = f32x4(params[0], params[1], params[2], 0.0);
            let mt = f32x4(params[3], params[4], params[5], 0.0);
            let sc = f32x4(params[6], params[7], params[8], 1.0);
            let k = f32x4(params[9], params[9], params[9], 0.0);
            let zero = f32x4_splat(0.0);
            let top = f32x4_splat(255.0);
            let half = f32x4_splat(0.5);
            let azero = u32x4_splat(0);
            let p = rgba.as_mut_ptr();
            let one = |v: v128| -> v128 {
                let v = f32x4_convert_u32x4(v);
                let m = f32x4_add(f32x4_mul(f32x4_sub(v, mt), sc), ms);
                let r = f32x4_add(v, f32x4_mul(f32x4_sub(m, v), k));
                let r = f32x4_min(f32x4_max(r, zero), top);
                // 0..255 after the clamp: the signed conversion is exact
                i32x4_trunc_sat_f32x4(f32x4_floor(f32x4_add(r, half)))
            };
            let mut i = 0;
            while i < n {
                let d = v128_load(p.add(i) as *const v128);
                let a = u32x4_shr(d, 24);
                if !v128_any_true(a) {
                    i += 16;
                    continue;
                }
                let (dl, dh) = (u16x8_extend_low_u8x16(d), u16x8_extend_high_u8x16(d));
                let p0 = one(u32x4_extend_low_u16x8(dl));
                let p1 = one(u32x4_extend_high_u16x8(dl));
                let p2 = one(u32x4_extend_low_u16x8(dh));
                let p3 = one(u32x4_extend_high_u16x8(dh));
                // 0..255 in every lane: the signed narrowings do not saturate
                let r = u8x16_narrow_i16x8(i16x8_narrow_i32x4(p0, p1), i16x8_narrow_i32x4(p2, p3));
                // a pixel whose alpha is 0 keeps its bytes
                let r = v128_bitselect(d, r, u32x4_eq(a, azero));
                v128_store(p.add(i) as *mut v128, r);
                i += 16;
            }
        }
        n / 4
    }
}
