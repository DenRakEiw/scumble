//! Flood fill / magic wand over RGBA8: the pixels similar to the seed (largest per-channel
//! difference, alpha included, at most `tol`), 4-connected from the seed with a scanline
//! fill when `contiguous`, else every similar pixel. `out` gets 1 inside, 0 outside, the
//! same set as `floodMask` in `inpaint_raster.js`.
//!
//! The span stack is the caller's (`stack`, pairs of u32); the kernel returns the number of
//! pixels set, or -1 when the stack was too small (the caller retries with a larger one).

#[inline(always)]
fn similar(p: &[u8], seed: [u8; 4], tol: u8) -> bool {
    p[0].abs_diff(seed[0]) <= tol && p[1].abs_diff(seed[1]) <= tol && p[2].abs_diff(seed[2]) <= tol && p[3].abs_diff(seed[3]) <= tol
}

pub fn flood(rgba: &[u8], w: usize, h: usize, sx: i32, sy: i32, tol: i32, contiguous: bool, out: &mut [u8], stack: &mut [u32]) -> i32 {
    if w == 0 || h == 0 {
        return 0;
    }
    let rgba = &rgba[..w * h * 4];
    let out = &mut out[..w * h];
    out.fill(0);
    let sx = sx.clamp(0, w as i32 - 1) as usize;
    let sy = sy.clamp(0, h as i32 - 1) as usize;
    let i0 = (sy * w + sx) * 4;
    let seed = [rgba[i0], rgba[i0 + 1], rgba[i0 + 2], rgba[i0 + 3]];
    let tol = tol.clamp(0, 255) as u8;

    if !contiguous {
        let done = simd::all_similar(rgba, out, seed, tol);
        let mut count = done.1;
        for (p, o) in rgba.chunks_exact(4).zip(out.iter_mut()).skip(done.0) {
            if similar(p, seed, tol) {
                *o = 1;
                count += 1;
            }
        }
        return count as i32;
    }

    let cap = stack.len() & !1;
    if cap < 2 {
        return -1;
    }
    let sim = |p: usize| -> bool {
        let i = p * 4;
        similar(unsafe { rgba.get_unchecked(i..i + 4) }, seed, tol)
    };
    let mut count: usize = 0;
    stack[0] = sx as u32;
    stack[1] = sy as u32;
    let mut sp = 2;
    while sp > 0 {
        sp -= 2;
        let x = stack[sp] as usize;
        let y = stack[sp + 1] as usize;
        let row = y * w;
        let mut p = row + x;
        if out[p] != 0 || !sim(p) {
            continue;
        }
        let (mut xl, mut xr) = (x, x);
        while xl > 0 && out[p - 1] == 0 && sim(p - 1) {
            xl -= 1;
            p -= 1;
        }
        p = row + x;
        while xr < w - 1 && out[p + 1] == 0 && sim(p + 1) {
            xr += 1;
            p += 1;
        }
        out[row + xl..=row + xr].fill(1);
        count += xr - xl + 1;
        for ny in [y.wrapping_sub(1), y + 1] {
            if ny >= h {
                continue;
            }
            let nrow = ny * w;
            let mut in_span = false;
            for i in xl..=xr {
                let q = nrow + i;
                let ok = out[q] == 0 && sim(q);
                if ok && !in_span {
                    if sp + 2 > cap {
                        return -1;
                    }
                    stack[sp] = i as u32;
                    stack[sp + 1] = ny as u32;
                    sp += 2;
                    in_span = true;
                } else if !ok {
                    in_span = false;
                }
            }
        }
    }
    count as i32
}

#[cfg(not(target_feature = "simd128"))]
mod simd {
    #[inline(always)]
    pub fn all_similar(_: &[u8], _: &mut [u8], _: [u8; 4], _: u8) -> (usize, usize) {
        (0, 0)
    }
}

#[cfg(target_feature = "simd128")]
mod simd {
    use core::arch::wasm32::*;

    /// The non-contiguous case four pixels at a time. Returns (pixels done, pixels set).
    pub fn all_similar(rgba: &[u8], out: &mut [u8], seed: [u8; 4], tol: u8) -> (usize, usize) {
        let px = out.len() & !3;
        let mut count = 0usize;
        unsafe {
            let s = u32x4_splat(u32::from_le_bytes(seed));
            let t = u8x16_splat(tol);
            let ones = u32x4_splat(1);
            let mut i = 0;
            while i < px {
                let v = v128_load(rgba.as_ptr().add(i * 4) as *const v128);
                let diff = v128_or(u8x16_sub_sat(v, s), u8x16_sub_sat(s, v));
                let ok = u8x16_le(diff, t); // 0xFF per byte within tolerance
                let all = u32x4_eq(ok, u32x4_splat(0xFFFF_FFFF)); // per pixel: every channel
                let bits = v128_and(all, ones);
                (out.as_mut_ptr().add(i) as *mut u32).write_unaligned(
                    // lane k (pixel k) -> byte k: pack the four 0/1 lanes into one u32
                    (u32x4_extract_lane::<0>(bits)) | (u32x4_extract_lane::<1>(bits) << 8) | (u32x4_extract_lane::<2>(bits) << 16) | (u32x4_extract_lane::<3>(bits) << 24),
                );
                count += u32x4_bitmask(all).count_ones() as usize;
                i += 4;
            }
            (px, count)
        }
    }
}
