//! PSD channel rows: PackBits encoding (`pack_rows`, `pack_rows_cap`), per-row PackBits decoding (`packbits_rows`),
//! and band mask-to-RGBA8 placement (`mask_rgba`) (`docs/PLAN_WASM_BUILD.md` §4.7, `docs/PLAN_WASM_K20.md` §2.2).
//!
//! `pack_rows` takes `rows` rows of interleaved RGBA8 (`w` wide) and one channel index, and writes per row the packed
//! bytes one after the other into `out` and the packed length of each row, big endian u16, into `lens` (the table a
//! PSD puts in front of a channel's data). The runs are found exactly as `packBits` in
//! `renderer/editor/inpaint_export.js` finds them, so the bytes are the ones the JS writer gives (tools/px_test.js).

/// Returns the bytes written to `out`, or -1 when `out` was too small (the caller sizes it with `pack_rows_cap`).
pub fn pack_rows(rgba: &[u8], w: usize, rows: usize, channel: usize, out: &mut [u8], lens: &mut [u8]) -> isize {
    let mut o = 0usize;
    for y in 0..rows {
        let base = y * w * 4 + channel;
        let at = |x: usize| rgba[base + x * 4];
        let start = o;
        let mut i = 0usize;
        while i < w {
            let v = at(i);
            let mut j = i;
            while j + 1 < w && at(j + 1) == v && j - i < 126 {
                j += 1;
            }
            let run = j - i + 1;
            if run >= 2 {
                if o + 2 > out.len() {
                    return -1;
                }
                out[o] = (257 - run) as u8;
                out[o + 1] = v;
                o += 2;
                i = j + 1;
                continue;
            }
            let mut k = i;
            while k < w && k - i < 128 {
                if k + 1 < w && at(k + 1) == at(k) {
                    break;
                }
                k += 1;
            }
            if k == i {
                k = i + 1;
            }
            let n = k - i;
            if o + 1 + n > out.len() {
                return -1;
            }
            out[o] = (n - 1) as u8;
            for m in 0..n {
                out[o + 1 + m] = at(i + m);
            }
            o += 1 + n;
            i = k;
        }
        let len = o - start;
        lens[y * 2] = (len >> 8) as u8;
        lens[y * 2 + 1] = len as u8;
    }
    o as isize
}

/// The most bytes `pack_rows` can write. The worst input is a single byte between runs of two (x a a y b b ...): the
/// single costs two bytes and the run two, four for three; twice the input covers it with room to spare.
pub fn pack_rows_cap(w: usize, rows: usize) -> usize {
    rows * (2 * w + 2)
}

/// Unpack `rows` PSD PackBits rows (`row_bytes` unpacked bytes per row) from `src`, advancing by each row's big-endian
/// `u16` byte count in `lens` (`2 * rows` bytes). Matches `unpackRows` in `renderer/editor/inpaint_layered.js`:
/// `0x80` is a no-op, runs past `row_bytes` are clamped while still advancing `p` to `end`, short rows are zero-padded,
/// and a dangling repeat byte at `lim - 1` fills `0` without reading into the next row. Returns `(rows * row_bytes) as isize`.
pub fn packbits_rows(lens: &[u8], src: &[u8], rows: usize, row_bytes: usize, out: &mut [u8]) -> isize {
    let mut p = 0usize;
    for y in 0..rows {
        let row_len = u16::from_be_bytes([lens[2 * y], lens[2 * y + 1]]) as usize;
        let end = p.saturating_add(row_len);
        let lim = end.min(src.len());
        let dst = &mut out[y * row_bytes..(y + 1) * row_bytes];
        let mut o = 0usize;
        while p < lim && o < row_bytes {
            let n = src[p] as usize;
            p += 1;
            if n < 128 {
                let run = n + 1;
                let c = run.min(row_bytes - o).min(lim - p);
                dst[o..o + c].copy_from_slice(&src[p..p + c]);
                p = p.saturating_add(run);
                o += c;
            } else if n > 128 {
                let run = 257 - n;
                let v = if p < lim {
                    let b = src[p];
                    p += 1;
                    b
                } else {
                    0
                };
                let c = run.min(row_bytes - o);
                dst[o..o + c].fill(v);
                o += c;
            }
        }
        if o < row_bytes {
            dst[o..row_bytes].fill(0);
        }
        p = end;
    }
    (rows * row_bytes) as isize
}

#[inline(always)]
fn fill_mask_rgba(dst: &mut [u8], def: u8) {
    #[cfg(target_feature = "simd128")]
    {
        use core::arch::wasm32::*;
        let fill_u32 = 0x00FF_FFFFu32 | ((def as u32) << 24);
        let v = u32x4_splat(fill_u32);
        let n = dst.len();
        let simd_end = (n / 16) * 16;
        let ptr = dst.as_mut_ptr();
        let mut i = 0usize;
        while i < simd_end {
            unsafe {
                v128_store(ptr.add(i) as *mut v128, v);
            }
            i += 16;
        }
        for px in dst[simd_end..].chunks_exact_mut(4) {
            px[0] = 255;
            px[1] = 255;
            px[2] = 255;
            px[3] = def;
        }
    }
    #[cfg(not(target_feature = "simd128"))]
    {
        for px in dst.chunks_exact_mut(4) {
            px[0] = 255;
            px[1] = 255;
            px[2] = 255;
            px[3] = def;
        }
    }
}

#[inline(always)]
fn write_mask_span_8(msrc: &[u8], dst: &mut [u8]) {
    #[cfg(target_feature = "simd128")]
    {
        use core::arch::wasm32::*;
        let span = msrc.len();
        let simd_end = (span / 16) * 16;
        let ff = u8x16_splat(255);
        let s_ptr = msrc.as_ptr();
        let d_ptr = dst.as_mut_ptr();
        let mut x = 0usize;
        while x < simd_end {
            unsafe {
                let a = v128_load(s_ptr.add(x) as *const v128);
                let p0 = u8x16_shuffle::<16, 16, 16, 0, 16, 16, 16, 1, 16, 16, 16, 2, 16, 16, 16, 3>(a, ff);
                let p1 = u8x16_shuffle::<16, 16, 16, 4, 16, 16, 16, 5, 16, 16, 16, 6, 16, 16, 16, 7>(a, ff);
                let p2 = u8x16_shuffle::<16, 16, 16, 8, 16, 16, 16, 9, 16, 16, 16, 10, 16, 16, 16, 11>(a, ff);
                let p3 = u8x16_shuffle::<16, 16, 16, 12, 16, 16, 16, 13, 16, 16, 16, 14, 16, 16, 16, 15>(a, ff);
                let o = d_ptr.add(x * 4);
                v128_store(o as *mut v128, p0);
                v128_store(o.add(16) as *mut v128, p1);
                v128_store(o.add(32) as *mut v128, p2);
                v128_store(o.add(48) as *mut v128, p3);
            }
            x += 16;
        }
        for i in simd_end..span {
            let di = i * 4;
            dst[di] = 255;
            dst[di + 1] = 255;
            dst[di + 2] = 255;
            dst[di + 3] = msrc[i];
        }
    }
    #[cfg(not(target_feature = "simd128"))]
    {
        for (px, &a) in dst.chunks_exact_mut(4).zip(msrc.iter()) {
            px[0] = 255;
            px[1] = 255;
            px[2] = 255;
            px[3] = a;
        }
    }
}

#[inline(always)]
fn write_mask_span_16be(msrc: &[u8], span: usize, dst: &mut [u8]) {
    #[cfg(target_feature = "simd128")]
    {
        use core::arch::wasm32::*;
        let simd_end = (span / 8) * 8;
        let c255 = u16x8_splat(255);
        let c32895 = u32x4_splat(32895);
        let rgb_white = u32x4_splat(0x00FF_FFFF);
        let s_ptr = msrc.as_ptr();
        let d_ptr = dst.as_mut_ptr();
        let mut x = 0usize;
        while x < simd_end {
            unsafe {
                let raw = v128_load(s_ptr.add(x * 2) as *const v128);
                let v = u8x16_shuffle::<1, 0, 3, 2, 5, 4, 7, 6, 9, 8, 11, 10, 13, 12, 15, 14>(raw, raw);
                let lo = u32x4_shr(u32x4_add(u32x4_extmul_low_u16x8(v, c255), c32895), 16);
                let hi = u32x4_shr(u32x4_add(u32x4_extmul_high_u16x8(v, c255), c32895), 16);
                let p0 = v128_or(u32x4_shl(lo, 24), rgb_white);
                let p1 = v128_or(u32x4_shl(hi, 24), rgb_white);
                let o = d_ptr.add(x * 4);
                v128_store(o as *mut v128, p0);
                v128_store(o.add(16) as *mut v128, p1);
            }
            x += 8;
        }
        for i in simd_end..span {
            let v = u16::from_be_bytes([msrc[i * 2], msrc[i * 2 + 1]]) as u32;
            let di = i * 4;
            dst[di] = 255;
            dst[di + 1] = 255;
            dst[di + 2] = 255;
            dst[di + 3] = ((v * 2 + 257) / 514) as u8;
        }
    }
    #[cfg(not(target_feature = "simd128"))]
    {
        for i in 0..span {
            let v = u16::from_be_bytes([msrc[i * 2], msrc[i * 2 + 1]]) as u32;
            let di = i * 4;
            dst[di] = 255;
            dst[di + 1] = 255;
            dst[di + 2] = 255;
            dst[di + 3] = ((v * 2 + 257) / 514) as u8;
        }
    }
}

/// Place a band's mask overlap (`m_rows = ry1 - ry0` rows of width `mw` starting at mask column `sx0`, `bits == 8` or
/// big-endian `bits == 16` rounded via `(2v + 257) / 514`) into `out` (`rows * w * 4` bytes) as `[255, 255, 255, alpha]`
/// over `[ry0, ry1) × [x0, x1)` and `[255, 255, 255, def]` everywhere else. Returns `0` on success or `-1` on invalid bounds.
#[allow(clippy::too_many_arguments)]
pub fn mask_rgba(
    src: *const u8,
    src_len: usize,
    mw: usize,
    sx0: usize,
    w: usize,
    rows: usize,
    x0: usize,
    x1: usize,
    ry0: usize,
    ry1: usize,
    bits: u32,
    def: u8,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    if w == 0 || rows == 0 || (bits != 8 && bits != 16) {
        return -1;
    }
    if x0 > x1 || x1 > w || ry0 > ry1 || ry1 > rows {
        return -1;
    }
    let need_out = match w.checked_mul(rows).and_then(|px| px.checked_mul(4)) {
        Some(n) if n <= isize::MAX as usize => n,
        _ => return -1,
    };
    if out.is_null() || out_len < need_out {
        return -1;
    }
    let out_slice = unsafe { core::slice::from_raw_parts_mut(out, need_out) };
    let m_rows = ry1 - ry0;
    let span = x1 - x0;
    if m_rows == 0 || span == 0 {
        fill_mask_rgba(out_slice, def);
        return 0;
    }
    let bps = (bits / 8) as usize;
    let end_x = match sx0.checked_add(span) {
        Some(n) if n <= mw => n,
        _ => return -1,
    };
    let m_stride = match mw.checked_mul(bps) {
        Some(n) => n,
        None => return -1,
    };
    let min_last = match end_x.checked_mul(bps) {
        Some(n) => n,
        None => return -1,
    };
    let need_src = match (m_rows - 1).checked_mul(m_stride).and_then(|o| o.checked_add(min_last)) {
        Some(n) if n <= isize::MAX as usize => n,
        _ => return -1,
    };
    if src.is_null() || src_len < need_src {
        return -1;
    }
    let src_slice = unsafe { core::slice::from_raw_parts(src, need_src) };

    if ry0 > 0 {
        fill_mask_rgba(&mut out_slice[..ry0 * w * 4], def);
    }
    for mr in 0..m_rows {
        let r = ry0 + mr;
        let row_out = &mut out_slice[r * w * 4..(r + 1) * w * 4];
        if x0 > 0 {
            fill_mask_rgba(&mut row_out[..x0 * 4], def);
        }
        let s_off = mr * m_stride + sx0 * bps;
        let dst_span = &mut row_out[x0 * 4..x1 * 4];
        if bits == 8 {
            write_mask_span_8(&src_slice[s_off..s_off + span], dst_span);
        } else {
            write_mask_span_16be(&src_slice[s_off..s_off + span * 2], span, dst_span);
        }
        if x1 < w {
            fill_mask_rgba(&mut row_out[x1 * 4..], def);
        }
    }
    if ry1 < rows {
        fill_mask_rgba(&mut out_slice[ry1 * w * 4..], def);
    }
    0
}
