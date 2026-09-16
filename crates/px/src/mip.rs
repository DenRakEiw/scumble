//! Mip halving: a 2×2 box filter on RGBA8 with straight alpha, weighted by alpha.
//!
//! Per output pixel with samples i = 0..3 (A = Σ aᵢ):
//!   alpha = (A + 2) >> 2
//!   colour = A == 0 ? 0 : floor((Σ cᵢ·aᵢ + A/2) / A)
//! An unweighted average would bleed the colour of transparent pixels (black) into edges.
//! When all four samples are opaque the formula reduces exactly to (Σ cᵢ + 2) >> 2, which
//! both paths use as a fast path. The division is exact in f32 (numerators stay below
//! 2^24 and a non-integer quotient is at least 1/1020 away from the next integer), which is
//! what lets the SIMD path divide in f32 lanes and still match the integer path bit for bit.
//!
//! An odd last column or row of the source is dropped: tiles are powers of two.

#[inline(always)]
fn box4(p: &[u8], q: &[u8], o: &mut [u8]) {
    // p: 8 bytes of the upper row (two pixels), q: 8 bytes of the lower row
    let (a0, a1, a2, a3) = (p[3] as u32, p[7] as u32, q[3] as u32, q[7] as u32);
    let a = a0 + a1 + a2 + a3;
    if a == 1020 {
        o[0] = ((p[0] as u32 + p[4] as u32 + q[0] as u32 + q[4] as u32 + 2) >> 2) as u8;
        o[1] = ((p[1] as u32 + p[5] as u32 + q[1] as u32 + q[5] as u32 + 2) >> 2) as u8;
        o[2] = ((p[2] as u32 + p[6] as u32 + q[2] as u32 + q[6] as u32 + 2) >> 2) as u8;
        o[3] = 255;
    } else if a == 0 {
        o[0] = 0;
        o[1] = 0;
        o[2] = 0;
        o[3] = 0;
    } else {
        let h = a >> 1;
        for c in 0..3 {
            let s = p[c] as u32 * a0 + p[c + 4] as u32 * a1 + q[c] as u32 * a2 + q[c + 4] as u32 * a3;
            o[c] = ((s + h) / a) as u8;
        }
        o[3] = ((a + 2) >> 2) as u8;
    }
}

/// Halve `src` (sw × sh) into `dst` ((sw / 2) × (sh / 2)).
pub fn mip_half(src: &[u8], sw: usize, sh: usize, dst: &mut [u8]) {
    let (ow, oh) = (sw / 2, sh / 2);
    if ow == 0 || oh == 0 {
        return;
    }
    let stride = sw * 4;
    let src = &src[..stride * oh * 2];
    let dst = &mut dst[..ow * oh * 4];
    for (pair, orow) in src.chunks_exact(stride * 2).zip(dst.chunks_exact_mut(ow * 4)) {
        let (r0, r1) = pair.split_at(stride);
        let done = simd::row(r0, r1, orow, ow);
        for ((p, q), o) in r0.chunks_exact(8).zip(r1.chunks_exact(8)).zip(orow.chunks_exact_mut(4)).skip(done) {
            box4(p, q, o);
        }
    }
}

/// Bytes `mip_chain` writes for a tile of `size` and `levels` levels.
pub fn chain_bytes(size: usize, levels: usize) -> usize {
    (1..=levels).map(|l| (size >> l) * (size >> l) * 4).sum()
}

/// All `levels` mips of a square tile (size/2, size/4, …) one after the other in `out`.
pub fn mip_chain(src: &[u8], size: usize, levels: usize, out: &mut [u8]) {
    let mut s = size;
    let mut offset = 0;
    for l in 0..levels {
        let n = (s / 2) * (s / 2) * 4;
        if n == 0 {
            break;
        }
        if l == 0 {
            mip_half(src, s, s, &mut out[..n]);
        } else {
            let prev = (s * s) * 4;
            let (done, rest) = out.split_at_mut(offset);
            mip_half(&done[offset - prev..], s, s, &mut rest[..n]);
        }
        offset += n;
        s /= 2;
    }
}

#[cfg(not(target_feature = "simd128"))]
mod simd {
    #[inline(always)]
    pub fn row(_: &[u8], _: &[u8], _: &mut [u8], _: usize) -> usize {
        0
    }
}

#[cfg(target_feature = "simd128")]
mod simd {
    use core::arch::wasm32::*;

    #[inline(always)]
    unsafe fn store8(out: *mut u8, v: v128) {
        (out as *mut u64).write_unaligned(i64x2_extract_lane::<0>(v) as u64);
    }

    /// Two output pixels per step from 16 bytes of each source row, each step classified on
    /// its own: all eight samples transparent (zeros), all opaque (the plain average), or
    /// mixed (the weighted division). Returns how many output pixels were written (an even
    /// number; the scalar loop does the rest).
    #[inline(always)]
    pub fn row(r0: &[u8], r1: &[u8], orow: &mut [u8], ow: usize) -> usize {
        let n = ow & !1;
        if n == 0 {
            return 0;
        }
        unsafe {
            let (p0, p1, po) = (r0.as_ptr(), r1.as_ptr(), orow.as_mut_ptr());
            let amask = u32x4_splat(0xFF00_0000);
            let two16 = u16x8_splat(2);
            let lo_keep = u16x8(0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0, 0, 0, 0);
            let hi_ones = u16x8(0, 0, 0, 0, 1, 1, 1, 1);
            let two = i32x4_splat(2);
            let mut x = 0;
            while x < n {
                let a = v128_load(p0.add(x * 8) as *const v128);
                let b = v128_load(p1.add(x * 8) as *const v128);
                if !v128_any_true(v128_and(v128_or(a, b), amask)) {
                    (po.add(x * 4) as *mut u64).write_unaligned(0);
                    x += 2;
                    continue;
                }
                // RGBA×4 -> R0..R3 G0..G3 B0..B3 A0..A3
                let pa = u8x16_shuffle::<0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15>(a, a);
                let pb = u8x16_shuffle::<0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15>(b, b);
                if u32x4_all_true(u32x4_eq(v128_and(v128_and(a, b), amask), amask)) {
                    // [R0+R1, R2+R3, G0+G1, G2+G3, B.., B.., A.., A..] over both rows
                    let s = u16x8_add(u16x8_add(u16x8_extadd_pairwise_u8x16(pa), u16x8_extadd_pairwise_u8x16(pb)), two16);
                    let q = u16x8_shr(s, 2);
                    let bytes = u8x16_narrow_i16x8(q, q);
                    store8(po.add(x * 4), u8x16_shuffle::<0, 2, 4, 6, 1, 3, 5, 7, 8, 10, 12, 14, 9, 11, 13, 15>(bytes, bytes));
                    x += 2;
                    continue;
                }
                let weigh = |p: v128| {
                    let lo = u16x8_extend_low_u8x16(p); // R0..3 G0..3
                    let hi = u16x8_extend_high_u8x16(p); // B0..3 A0..3
                    let aa = u16x8_extend_low_u8x16(u8x16_shuffle::<12, 13, 14, 15, 12, 13, 14, 15, 12, 13, 14, 15, 12, 13, 14, 15>(p, p));
                    let m_lo = u16x8_mul(lo, aa); // c·a fits 16 bits
                    let m_hi = u16x8_mul(hi, v128_or(v128_and(aa, lo_keep), hi_ones)); // [B·A, A]
                    (u32x4_extadd_pairwise_u16x8(m_lo), u32x4_extadd_pairwise_u16x8(m_hi))
                };
                let (la, ha) = weigh(pa);
                let (lb, hb) = weigh(pb);
                let sum_lo = i32x4_add(la, lb); // [SR, SR', SG, SG']
                let sum_hi = i32x4_add(ha, hb); // [SB, SB', A, A']
                let den = i32x4_shuffle::<2, 3, 2, 3>(sum_hi, sum_hi);
                let half = i32x4_shr(den, 1);
                // every value is far below 2^31, so the signed conversions are exact and cheaper
                let den_f = f32x4_convert_i32x4(den);
                // 0 / 0 is NaN and saturates to 0, which is the colour of a transparent pixel
                let q_lo = i32x4_trunc_sat_f32x4(f32x4_div(f32x4_convert_i32x4(i32x4_add(sum_lo, half)), den_f));
                let q_hi = i32x4_trunc_sat_f32x4(f32x4_div(f32x4_convert_i32x4(i32x4_add(sum_hi, half)), den_f));
                let alpha = i32x4_shr(i32x4_add(sum_hi, two), 2);
                let hi = i32x4_shuffle::<0, 1, 6, 7>(q_hi, alpha);
                let w = u16x8_narrow_i32x4(q_lo, hi); // [R R' G G' B B' A A']
                let bytes = u8x16_narrow_i16x8(w, w);
                store8(po.add(x * 4), u8x16_shuffle::<0, 2, 4, 6, 1, 3, 5, 7, 8, 10, 12, 14, 9, 11, 13, 15>(bytes, bytes));
                x += 2;
            }
            n
        }
    }
}

/// A square tile's bytes clamp-extended in place from their valid part (vw × vh): the columns
/// right of vw repeat column vw − 1, the rows below vh repeat row vh − 1. The last tile of a row
/// or a column gets this before its mips, so the image's own edge does not fade by a level.
pub fn clamp_extend(b: &mut [u8], size: usize, vw: usize, vh: usize) {
    if vw == 0 || vh == 0 {
        return;
    }
    let stride = size * 4;
    if vw < size {
        for row in b.chunks_exact_mut(stride).take(vh) {
            let (valid, rest) = row.split_at_mut(vw * 4);
            let mut px = [0u8; 4];
            px.copy_from_slice(&valid[(vw - 1) * 4..]);
            for c in rest.chunks_exact_mut(4) {
                c.copy_from_slice(&px);
            }
        }
    }
    if vh < size {
        let last = (vh - 1) * stride;
        for y in vh..size {
            b.copy_within(last..last + stride, y * stride);
        }
    }
}
