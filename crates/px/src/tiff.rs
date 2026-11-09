//! TIFF strip and tile unpacking, Predictor 2 differencing / undifferencing, and sample-to-RGBA8 conversion
//! (K15 & K16, `docs/PLAN_WASM_BUILD.md` §4.6).
//!
//! `unpack` decodes one strip or tile of uncompressed (`1`), LZW (`5`, TIFF 6.0 §13) or PackBits (`32773`, TIFF 6.0 §9)
//! bytes into `out` (`need` bytes), stopping as soon as `out` is full. Deflate (`8` and `32946`) stays on the browser's
//! native `DecompressionStream("deflate")`.
//!
//! Returns `out.len() as isize` on success, or a negative code matching the JS reader's refusal messages in
//! `renderer/editor/inpaint_tiff.js`:
//! - `-1` (`ERR_BAD_ARGS`): unsupported compression or invalid arguments
//! - `-2` (`ERR_TRUNCATED`): the input ended (or LZW hit EOI `257`) before `out.len()` bytes were written
//! - `-3` (`ERR_OLD_LZW`): pre-TIFF-6 LSB-first LZW (`src[0] == 0 && (src[1] & 1) != 0`)
//! - `-4` (`ERR_LZW_BEFORE_LITERAL`): an LZW code `> 255` before any literal (at the start or right after Clear `256`)
//! - `-5` (`ERR_LZW_BEYOND_TABLE`): an LZW code `> next`

pub const ERR_BAD_ARGS: isize = -1;
pub const ERR_TRUNCATED: isize = -2;
pub const ERR_OLD_LZW: isize = -3;
pub const ERR_LZW_BEFORE_LITERAL: isize = -4;
pub const ERR_LZW_BEYOND_TABLE: isize = -5;

/// Undo horizontal differencing (Predictor 2) in place on `rows` rows of `row_bytes` stride, each `pixels` wide with
/// `per` samples per pixel at `bits` (`8` or `16`) bits per sample (`le`: little-endian for 16-bit). Returns `0` on
/// success or `-1` on invalid arguments. Padding bytes in each row past `pixels * per * (bits / 8)` are left untouched.
pub fn unpredict(
    buf: *mut u8,
    len: usize,
    rows: usize,
    row_bytes: usize,
    pixels: usize,
    per: usize,
    bits: u32,
    le: bool,
) -> i32 {
    if (bits != 8 && bits != 16) || per == 0 {
        return -1;
    }
    if rows == 0 || pixels == 0 {
        return 0;
    }
    let bps = (bits / 8) as usize;
    let active = match pixels.checked_mul(per).and_then(|n| n.checked_mul(bps)) {
        Some(n) if n <= row_bytes => n,
        _ => return -1,
    };
    let need = match (rows - 1).checked_mul(row_bytes).and_then(|o| o.checked_add(active)) {
        Some(n) if n <= len => n,
        _ => return -1,
    };
    if buf.is_null() {
        return -1;
    }
    let slice = unsafe { core::slice::from_raw_parts_mut(buf, need) };
    if bits == 8 {
        for r in 0..rows {
            let row = &mut slice[r * row_bytes..r * row_bytes + active];
            unpredict_row_8(row, per);
        }
    } else {
        let total_samples = pixels * per;
        for r in 0..rows {
            let row = &mut slice[r * row_bytes..r * row_bytes + active];
            if le {
                for s in per..total_samples {
                    let prev = u16::from_le_bytes([row[(s - per) * 2], row[(s - per) * 2 + 1]]);
                    let cur = u16::from_le_bytes([row[s * 2], row[s * 2 + 1]]);
                    let sum = cur.wrapping_add(prev).to_le_bytes();
                    row[s * 2] = sum[0];
                    row[s * 2 + 1] = sum[1];
                }
            } else {
                for s in per..total_samples {
                    let prev = u16::from_be_bytes([row[(s - per) * 2], row[(s - per) * 2 + 1]]);
                    let cur = u16::from_be_bytes([row[s * 2], row[s * 2 + 1]]);
                    let sum = cur.wrapping_add(prev).to_be_bytes();
                    row[s * 2] = sum[0];
                    row[s * 2 + 1] = sum[1];
                }
            }
        }
    }
    0
}

#[cfg(target_feature = "simd128")]
#[inline(always)]
fn unpredict_row_8(row: &mut [u8], per: usize) {
    use core::arch::wasm32::*;
    let n = row.len();
    if per == 4 && n >= 16 {
        let zero = i8x16_splat(0);
        let mut acc = zero;
        let simd_end = (n / 16) * 16;
        let ptr = row.as_mut_ptr();
        let mut i = 0usize;
        while i < simd_end {
            unsafe {
                let v0 = v128_load(ptr.add(i) as *const v128);
                let s1 = u8x16_shuffle::<16, 16, 16, 16, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11>(v0, zero);
                let v1 = i8x16_add(v0, s1);
                let s2 = u8x16_shuffle::<16, 16, 16, 16, 16, 16, 16, 16, 0, 1, 2, 3, 4, 5, 6, 7>(v1, zero);
                let v2 = i8x16_add(v1, s2);
                let out = i8x16_add(v2, acc);
                v128_store(ptr.add(i) as *mut v128, out);
                acc = u8x16_shuffle::<12, 13, 14, 15, 12, 13, 14, 15, 12, 13, 14, 15, 12, 13, 14, 15>(out, out);
            }
            i += 16;
        }
        for k in simd_end..n {
            row[k] = row[k].wrapping_add(row[k - 4]);
        }
        return;
    }
    if per == 1 && n >= 16 {
        let zero = i8x16_splat(0);
        let mut acc = zero;
        let simd_end = (n / 16) * 16;
        let ptr = row.as_mut_ptr();
        let mut i = 0usize;
        while i < simd_end {
            unsafe {
                let v0 = v128_load(ptr.add(i) as *const v128);
                let s1 = u8x16_shuffle::<16, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14>(v0, zero);
                let v1 = i8x16_add(v0, s1);
                let s2 = u8x16_shuffle::<16, 16, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13>(v1, zero);
                let v2 = i8x16_add(v1, s2);
                let s4 = u8x16_shuffle::<16, 16, 16, 16, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11>(v2, zero);
                let v4 = i8x16_add(v2, s4);
                let s8 = u8x16_shuffle::<16, 16, 16, 16, 16, 16, 16, 16, 0, 1, 2, 3, 4, 5, 6, 7>(v4, zero);
                let v8 = i8x16_add(v4, s8);
                let out = i8x16_add(v8, acc);
                v128_store(ptr.add(i) as *mut v128, out);
                acc = u8x16_shuffle::<15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15>(out, out);
            }
            i += 16;
        }
        for k in simd_end..n {
            row[k] = row[k].wrapping_add(row[k - 1]);
        }
        return;
    }
    if per == 3 && n >= 3 {
        let mut c0 = row[0];
        let mut c1 = row[1];
        let mut c2 = row[2];
        let mut i = 3usize;
        while i + 3 <= n {
            c0 = c0.wrapping_add(row[i]);
            c1 = c1.wrapping_add(row[i + 1]);
            c2 = c2.wrapping_add(row[i + 2]);
            row[i] = c0;
            row[i + 1] = c1;
            row[i + 2] = c2;
            i += 3;
        }
        return;
    }
    for i in per..n {
        row[i] = row[i].wrapping_add(row[i - per]);
    }
}

#[cfg(not(target_feature = "simd128"))]
#[inline(always)]
fn unpredict_row_8(row: &mut [u8], per: usize) {
    let n = row.len();
    for i in per..n {
        row[i] = row[i].wrapping_add(row[i - per]);
    }
}

/// Horizontal differencing (Predictor 2) in place on `rows` rows of `w`-wide RGBA8 (`w * rows * 4` bytes).
/// Returns `0` on success or `-1` on invalid arguments (`w == 0`, `rows == 0`, overflow, or null pointer).
pub fn predict_rgba(rgba: *mut u8, w: usize, rows: usize) -> i32 {
    if w == 0 || rows == 0 || rgba.is_null() {
        return -1;
    }
    let row_bytes = match w.checked_mul(4) {
        Some(n) => n,
        None => return -1,
    };
    let total = match row_bytes.checked_mul(rows) {
        Some(n) => n,
        None => return -1,
    };
    let slice = unsafe { core::slice::from_raw_parts_mut(rgba, total) };
    for r in 0..rows {
        let row = &mut slice[r * row_bytes..(r + 1) * row_bytes];
        predict_row_rgba(row);
    }
    0
}

#[cfg(target_feature = "simd128")]
#[inline(always)]
fn predict_row_rgba(row: &mut [u8]) {
    use core::arch::wasm32::*;
    let mut i = row.len();
    let ptr = row.as_mut_ptr();
    while i >= 20 {
        unsafe {
            let cur = v128_load(ptr.add(i - 16) as *const v128);
            let prev = v128_load(ptr.add(i - 20) as *const v128);
            v128_store(ptr.add(i - 16) as *mut v128, i8x16_sub(cur, prev));
        }
        i -= 16;
    }
    for k in (4..i).rev() {
        row[k] = row[k].wrapping_sub(row[k - 4]);
    }
}

#[cfg(not(target_feature = "simd128"))]
#[inline(always)]
fn predict_row_rgba(row: &mut [u8]) {
    for k in (4..row.len()).rev() {
        row[k] = row[k].wrapping_sub(row[k - 4]);
    }
}

/// Convert `rows` rows of `w` pixels from `planes` (`1` chunky or `spp` planar, packed consecutively at stride
/// `rows * row_bytes` in `src`) into straight-alpha RGBA8 in `out` (`w * rows * 4` bytes).
///
/// - `bits`: `1`, `2`, `4`, `8`, or `16` (`le`: little-endian for `16`-bit).
/// - `photometric`: `0` (MinIsWhite), `1` (MinIsBlack), `2` (RGB, `bits >= 8`), `3` (Palette, `pal` holds `(1 << bits) * 3` 8-bit RGB bytes).
/// - `alpha_mode`: `0` (none), `1` (premultiplied / associated), `2` (straight / unassociated).
/// - Question 6.4 (K15): on sub-byte (`1, 2, 4`-bit) palette files with alpha, sample `0` (the palette index) stays raw
///   (`0 .. 2^bits - 1`) while sample `1` (the alpha sample) is scaled by `255 / (2^bits - 1)` for both chunky and planar,
///   straight and premultiplied.
pub fn to_rgba(
    src: *const u8,
    src_len: usize,
    planes: usize,
    row_bytes: usize,
    w: usize,
    rows: usize,
    spp: usize,
    bits: u32,
    le: bool,
    photometric: u32,
    alpha_mode: u32,
    pal: *const u8,
    pal_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    if w == 0 || rows == 0 {
        return -1;
    }
    if !matches!(bits, 1 | 2 | 4 | 8 | 16) {
        return -1;
    }
    if photometric > 3 || (photometric == 2 && bits < 8) || alpha_mode > 2 {
        return -1;
    }
    let base = if photometric == 2 { 3usize } else { 1usize };
    let min_spp = base + usize::from(alpha_mode != 0);
    if spp < min_spp || (planes != 1 && planes != spp) {
        return -1;
    }
    let per_plane = match if planes == 1 { w.checked_mul(spp) } else { Some(w) } {
        Some(n) => n,
        None => return -1,
    };
    let min_row_bytes = match per_plane.checked_mul(bits as usize).and_then(|b| b.checked_add(7)) {
        Some(b) => b / 8,
        None => return -1,
    };
    if row_bytes < min_row_bytes {
        return -1;
    }
    let plane_bytes = match rows.checked_mul(row_bytes) {
        Some(n) => n,
        None => return -1,
    };
    let min_last_plane = match (rows - 1).checked_mul(row_bytes).and_then(|o| o.checked_add(min_row_bytes)) {
        Some(n) => n,
        None => return -1,
    };
    let need_src = match (planes - 1).checked_mul(plane_bytes).and_then(|o| o.checked_add(min_last_plane)) {
        Some(n) => n,
        None => return -1,
    };
    if src.is_null() || src_len < need_src {
        return -1;
    }
    let need_out = match w.checked_mul(rows).and_then(|px| px.checked_mul(4)) {
        Some(n) => n,
        None => return -1,
    };
    if out.is_null() || out_len < need_out {
        return -1;
    }
    let pal_slice: &[u8] = if photometric == 3 {
        let need_pal = (1usize << bits) * 3;
        if pal.is_null() || pal_len < need_pal {
            return -1;
        }
        unsafe { core::slice::from_raw_parts(pal, need_pal) }
    } else {
        &[]
    };
    let src_slice = unsafe { core::slice::from_raw_parts(src, need_src) };
    let out_slice = unsafe { core::slice::from_raw_parts_mut(out, need_out) };

    // Fast path 1: chunky RGBA8 straight is a direct copy.
    if planes == 1 && bits == 8 && photometric == 2 && spp == 4 && alpha_mode == 2 {
        if row_bytes == w * 4 {
            out_slice.copy_from_slice(&src_slice[..need_out]);
        } else {
            for r in 0..rows {
                out_slice[r * w * 4..(r + 1) * w * 4]
                    .copy_from_slice(&src_slice[r * row_bytes..r * row_bytes + w * 4]);
            }
        }
        return 0;
    }

    // Fast path 2: chunky RGB8 opaque.
    if planes == 1 && bits == 8 && photometric == 2 && spp == 3 && alpha_mode == 0 {
        for r in 0..rows {
            let s = &src_slice[r * row_bytes..r * row_bytes + w * 3];
            let d = &mut out_slice[r * w * 4..(r + 1) * w * 4];
            for (dst, px) in d.chunks_exact_mut(4).zip(s.chunks_exact(3)) {
                dst[0] = px[0];
                dst[1] = px[1];
                dst[2] = px[2];
                dst[3] = 255;
            }
        }
        return 0;
    }

    // Fast path 3: chunky RGBA8 premultiplied.
    if planes == 1 && bits == 8 && photometric == 2 && spp == 4 && alpha_mode == 1 {
        for r in 0..rows {
            let s = &src_slice[r * row_bytes..r * row_bytes + w * 4];
            let d = &mut out_slice[r * w * 4..(r + 1) * w * 4];
            for (dst, px) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
                let a = px[3];
                if a == 255 {
                    dst.copy_from_slice(px);
                } else if a == 0 {
                    dst.fill(0);
                } else {
                    let a32 = a as u32;
                    let h = a32 >> 1;
                    dst[0] = (((px[0] as u32 * 255 + h) / a32).min(255)) as u8;
                    dst[1] = (((px[1] as u32 * 255 + h) / a32).min(255)) as u8;
                    dst[2] = (((px[2] as u32 * 255 + h) / a32).min(255)) as u8;
                    dst[3] = a;
                }
            }
        }
        return 0;
    }

    let mask = if bits < 8 { ((1u32 << bits) - 1) as u8 } else { 0 };
    let scale = if bits < 8 { 255 / mask } else { 1 };
    let per_byte = if bits < 8 { (8 / bits) as usize } else { 1 };

    let sample8 = |r: usize, x: usize, c: usize| -> u8 {
        let (o, idx) = if planes == 1 {
            (r * row_bytes, x * spp + c)
        } else {
            (c * plane_bytes + r * row_bytes, x)
        };
        if bits == 8 {
            src_slice[o + idx]
        } else if bits == 16 {
            let b0 = src_slice[o + idx * 2] as u32;
            let b1 = src_slice[o + idx * 2 + 1] as u32;
            let v = if le { b0 | (b1 << 8) } else { (b0 << 8) | b1 };
            ((v * 2 + 257) / 514) as u8
        } else {
            let byte = src_slice[o + idx / per_byte];
            let shift = 8 - bits - ((idx % per_byte) as u32) * bits;
            let raw = (byte >> shift) & mask;
            if photometric == 3 && c == 0 {
                raw
            } else {
                raw * scale
            }
        }
    };

    for r in 0..rows {
        let row_out = &mut out_slice[r * w * 4..(r + 1) * w * 4];
        for x in 0..w {
            let (mut r_ch, mut g_ch, mut b_ch) = if photometric == 2 {
                (sample8(r, x, 0), sample8(r, x, 1), sample8(r, x, 2))
            } else if photometric == 3 {
                let k = (sample8(r, x, 0) as usize) * 3;
                (pal_slice[k], pal_slice[k + 1], pal_slice[k + 2])
            } else {
                let v = sample8(r, x, 0);
                let g = if photometric == 0 { 255 - v } else { v };
                (g, g, g)
            };
            let a_ch = if alpha_mode != 0 {
                let a = sample8(r, x, base);
                if alpha_mode == 1 {
                    if a == 0 {
                        r_ch = 0;
                        g_ch = 0;
                        b_ch = 0;
                    } else if a < 255 {
                        let a32 = a as u32;
                        let h = a32 >> 1;
                        r_ch = (((r_ch as u32 * 255 + h) / a32).min(255)) as u8;
                        g_ch = (((g_ch as u32 * 255 + h) / a32).min(255)) as u8;
                        b_ch = (((b_ch as u32 * 255 + h) / a32).min(255)) as u8;
                    }
                }
                a
            } else {
                255
            };
            let di = x * 4;
            row_out[di] = r_ch;
            row_out[di + 1] = g_ch;
            row_out[di + 2] = b_ch;
            row_out[di + 3] = a_ch;
        }
    }
    0
}

pub fn unpack(compression: u32, src: &[u8], out: &mut [u8]) -> isize {
    match compression {
        1 => unpack_none(src, out),
        5 => unpack_lzw(src, out),
        32773 => unpack_packbits(src, out),
        _ => ERR_BAD_ARGS,
    }
}

fn unpack_none(src: &[u8], out: &mut [u8]) -> isize {
    let need = out.len();
    if src.len() < need {
        return ERR_TRUNCATED;
    }
    out.copy_from_slice(&src[..need]);
    need as isize
}

fn unpack_packbits(src: &[u8], out: &mut [u8]) -> isize {
    let need = out.len();
    let mut i = 0usize;
    let mut o = 0usize;
    while i < src.len() && o < need {
        let h = src[i];
        i += 1;
        if h < 128 {
            let lit = (h as usize) + 1;
            let n = lit.min(src.len() - i).min(need - o);
            out[o..o + n].copy_from_slice(&src[i..i + n]);
            o += n;
            i += n;
        } else if h > 128 {
            if i >= src.len() {
                break;
            }
            let rep = 257 - (h as usize);
            let n = rep.min(need - o);
            out[o..o + n].fill(src[i]);
            o += n;
            i += 1;
        }
    }
    if o < need {
        return ERR_TRUNCATED;
    }
    need as isize
}

fn unpack_lzw(src: &[u8], out: &mut [u8]) -> isize {
    let need = out.len();
    if need == 0 {
        return 0;
    }
    if src.len() < 2 {
        return ERR_TRUNCATED;
    }
    // An old-style LZW stream starts with its clear code least-significant-bit first: 0x00, then a byte with bit 0 set.
    if src[0] == 0 && (src[1] & 1) != 0 {
        return ERR_OLD_LZW;
    }

    // 24 KB on the 1 MB wasm stack: 4,096-entry prefix, suffix, first and len tables.
    let mut prefix = [0u16; 4096];
    let mut suffix = [0u8; 4096];
    let mut first = [0u8; 4096];
    let mut len = [0u16; 4096];
    let mut i = 0usize;
    while i < 256 {
        suffix[i] = i as u8;
        first[i] = i as u8;
        len[i] = 1;
        i += 1;
    }

    let mut next = 258usize;
    let mut width = 9u32;
    let mut old: i32 = -1;
    let mut acc = 0u32;
    let mut nbits = 0u32;
    let mut o = 0usize;

    let emit = |code: usize, o: &mut usize, out: &mut [u8], prefix: &[u16; 4096], suffix: &[u8; 4096], len: &[u16; 4096]| {
        let l = len[code & 0xFFF] as usize;
        let left = out.len() - *o;
        let keep = l.min(left);
        let mut c = code & 0xFFF;
        for _ in 0..(l - keep) {
            c = (prefix[c] as usize) & 0xFFF;
        }
        for dst in out[*o..*o + keep].iter_mut().rev() {
            *dst = suffix[c];
            c = (prefix[c] as usize) & 0xFFF;
        }
        *o += keep;
    };

    let add = |pre: usize, ch: u8, next: &mut usize, width: &mut u32, prefix: &mut [u16; 4096], suffix: &mut [u8; 4096], first: &mut [u8; 4096], len: &mut [u16; 4096]| {
        if *next >= 4096 {
            return;
        }
        let n = *next;
        prefix[n] = pre as u16;
        suffix[n] = ch;
        first[n] = first[pre & 0xFFF];
        len[n] = len[pre & 0xFFF] + 1;
        *next = n + 1;
        if *next >= (1usize << *width) - 1 && *width < 12 {
            *width += 1;
        }
    };

    for &byte in src {
        acc = ((acc << 8) | (byte as u32)) & 0xFF_FFFF;
        nbits += 8;
        while nbits >= width {
            let c = ((acc >> (nbits - width)) & ((1u32 << width) - 1)) as usize;
            nbits -= width;
            if c == 256 {
                next = 258;
                width = 9;
                old = -1;
                continue;
            }
            if c == 257 {
                return if o >= need { need as isize } else { ERR_TRUNCATED };
            }
            if old < 0 {
                if c > 255 {
                    return ERR_LZW_BEFORE_LITERAL;
                }
                emit(c, &mut o, out, &prefix, &suffix, &len);
                old = c as i32;
            } else {
                let prev = (old as usize) & 0xFFF;
                if c < next {
                    emit(c, &mut o, out, &prefix, &suffix, &len);
                    add(prev, first[c & 0xFFF], &mut next, &mut width, &mut prefix, &mut suffix, &mut first, &mut len);
                } else if c == next {
                    add(prev, first[prev], &mut next, &mut width, &mut prefix, &mut suffix, &mut first, &mut len);
                    emit(c, &mut o, out, &prefix, &suffix, &len);
                } else {
                    return ERR_LZW_BEYOND_TABLE;
                }
                old = c as i32;
            }
            if o >= need {
                return need as isize;
            }
        }
    }
    if o < need {
        return ERR_TRUNCATED;
    }
    need as isize
}
