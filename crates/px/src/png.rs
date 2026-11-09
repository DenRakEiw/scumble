//! PNG rows: the filter per row (libpng's heuristic).
//!
//! `filter_rows` writes, for every row of RGBA8, one filter-type byte and the filtered row.
//! The filter is the one of None, Sub, Up, Average, Paeth whose output has the smallest sum
//! of absolute values when the bytes are read as signed (ties go to the lower type, the order
//! libpng tries them in). The row above the first one is `prev`, or zeros.
//!
//! `deflate_part` compresses one part of a zlib stream as raw deflate. Every part but the last ends on a sync flush
//! (an empty stored block, byte aligned), so parts compressed independently, in any order and on any thread, are one
//! valid deflate stream when they are written one after the other; the last part ends the stream. The caller adds
//! the two zlib header bytes in front and the Adler-32 of all the uncompressed bytes behind (`adler32`, chained
//! through `start`). The browser's `CompressionStream("deflate")` is 1.4 to 2.2× faster than miniz_oxide on one
//! thread (docs/PERFORMANCE.md §10) but cannot flush, so it cannot be run in parallel: eight workers win.

use miniz_oxide::deflate::core::{compress, create_comp_flags_from_zip_params, CompressorOxide, TDEFLFlush, TDEFLStatus};

/// Raw deflate of `src` into `out`; returns the bytes written, or -1 when `out` was too small.
///
/// A sync flush answers Okay with all of `src` consumed even when the end of the part (the last block's tail and the
/// sync marker) did not fit: miniz_oxide keeps it in its own buffer for a next call, which never comes. Output can
/// only be left there when `out` is full, so a part that is not the last and fills `out` exactly counts as too small
/// (an exact fit costs the caller one retry). The last part is safe: Done comes only once nothing is left.
pub fn deflate_part(src: &[u8], level: i32, last: bool, out: &mut [u8]) -> isize {
    let flags = create_comp_flags_from_zip_params(level, -15, 0);
    let mut c = Box::new(CompressorOxide::new(flags));
    let (status, consumed, written) = compress(&mut c, src, out, if last { TDEFLFlush::Finish } else { TDEFLFlush::Sync });
    let done = if last { status == TDEFLStatus::Done } else { status == TDEFLStatus::Okay && written < out.len() };
    if !done || consumed != src.len() {
        return -1;
    }
    written as isize
}

pub fn adler32(src: &[u8], start: u32) -> u32 {
    let mut a = adler2::Adler32::from_checksum(start);
    a.write_slice(src);
    a.checksum()
}

#[inline(always)]
fn cost(v: u8) -> u32 {
    if v < 128 { v as u32 } else { 256 - v as u32 }
}

#[inline(always)]
fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let (ia, ib, ic) = (a as i32, b as i32, c as i32);
    let pa = (ib - ic).abs();
    let pb = (ia - ic).abs();
    let pc = (ia + ib - 2 * ic).abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

#[inline(always)]
fn filtered(t: u8, x: u8, a: u8, b: u8, c: u8) -> u8 {
    match t {
        0 => x,
        1 => x.wrapping_sub(a),
        2 => x.wrapping_sub(b),
        3 => x.wrapping_sub(((a as u16 + b as u16) >> 1) as u8),
        _ => x.wrapping_sub(paeth(a, b, c)),
    }
}

fn filter_row(row: &[u8], up: Option<&[u8]>, out: &mut [u8]) {
    let n = row.len();
    let mut sums = [0u32; 5];
    for i in 0..n {
        let x = row[i];
        let a = if i >= 4 { row[i - 4] } else { 0 };
        let (b, c) = match up {
            Some(u) => (u[i], if i >= 4 { u[i - 4] } else { 0 }),
            None => (0, 0),
        };
        sums[0] += cost(x);
        sums[1] += cost(x.wrapping_sub(a));
        sums[2] += cost(x.wrapping_sub(b));
        sums[3] += cost(x.wrapping_sub(((a as u16 + b as u16) >> 1) as u8));
        sums[4] += cost(x.wrapping_sub(paeth(a, b, c)));
    }
    let mut best = 0u8;
    for t in 1..if up.is_some() { 5u8 } else { 2u8 } {
        if sums[t as usize] < sums[best as usize] {
            best = t;
        }
    }
    out[0] = best;
    let o = &mut out[1..1 + n];
    for i in 0..n {
        let a = if i >= 4 { row[i - 4] } else { 0 };
        let (b, c) = match up {
            Some(u) => (u[i], if i >= 4 { u[i - 4] } else { 0 }),
            None => (0, 0),
        };
        o[i] = filtered(best, row[i], a, b, c);
    }
}

pub fn filter_rows(rgba: &[u8], w: usize, rows: usize, prev: Option<&[u8]>, out: &mut [u8]) -> usize {
    let stride = w * 4;
    if stride == 0 || rows == 0 {
        return 0;
    }
    for (y, (row, o)) in rgba[..stride * rows].chunks_exact(stride).zip(out.chunks_exact_mut(stride + 1)).enumerate() {
        let up = if y == 0 { prev.map(|p| &p[..stride]) } else { Some(&rgba[(y - 1) * stride..y * stride]) };
        row_filter(row, up, o);
    }
    rows * (stride + 1)
}

// ---- reading: the filters undone ---------------------------------------------------------------------------------

fn sub_px<const B: usize>(cur: &mut [u8]) {
    let mut a = [0u8; B];
    for x in cur.chunks_exact_mut(B) {
        for k in 0..B { x[k] = x[k].wrapping_add(a[k]); }
        a.copy_from_slice(x);
    }
}

fn avg_px<const B: usize>(cur: &mut [u8], up: &[u8]) {
    let mut a = [0u8; B];
    for (x, b) in cur.chunks_exact_mut(B).zip(up.chunks_exact(B)) {
        for k in 0..B { x[k] = x[k].wrapping_add(((a[k] as u16 + b[k] as u16) >> 1) as u8); }
        a.copy_from_slice(x);
    }
}

fn paeth_px<const B: usize>(cur: &mut [u8], up: &[u8]) {
    let mut a = [0i16; B];
    let mut c = [0i16; B];
    for (x, b) in cur.chunks_exact_mut(B).zip(up.chunks_exact(B)) {
        for k in 0..B {
            let ib = b[k] as i16;
            let pa = (ib - c[k]).abs();
            let pb = (a[k] - c[k]).abs();
            let pc = (a[k] + ib - 2 * c[k]).abs();
            // the order of the ties is the standard's: a, then b, then c
            let pred = if pa <= pb && pa <= pc { a[k] } else if pb <= pc { ib } else { c[k] };
            x[k] = x[k].wrapping_add(pred as u8);
            a[k] = x[k] as i16;
            c[k] = ib;
        }
    }
}

/// Undo the filters of `rows` lines in place: each line is its filter-type byte and `row_bytes` filtered bytes, `bpp`
/// the bytes of a whole pixel (the distance of the "left" byte). `prev` is the unfiltered row above the first line
/// (zeros at the top of the picture) and holds the last row afterwards, for the next call. The number of lines undone:
/// `rows`, or the index of the line whose filter type is none of the five.
pub fn unfilter_rows(lines: &mut [u8], rows: usize, row_bytes: usize, bpp: usize, prev: &mut [u8]) -> usize {
    unfilter_rows_opt(lines, rows, row_bytes, bpp, Some(prev))
}

fn unfilter_rows_opt(lines: &mut [u8], rows: usize, row_bytes: usize, bpp: usize, prev: Option<&mut [u8]>) -> usize {
    let stride = row_bytes + 1;
    let prev_ref: &[u8] = match prev.as_deref() {
        Some(p) => &p[..row_bytes],
        None => &[],
    };
    for y in 0..rows {
        let (done, rest) = lines.split_at_mut(y * stride);
        let line = &mut rest[..stride];
        let ft = line[0];
        let cur = &mut line[1..];
        let up: &[u8] = if y == 0 { prev_ref } else { &done[(y - 1) * stride + 1..y * stride] };
        match (ft, bpp) {
            (0, _) => {}
            #[cfg(target_feature = "simd128")] (2, _) => lanes::up_row(cur, up),
            #[cfg(not(target_feature = "simd128"))] (2, _) => { for i in 0..row_bytes { cur[i] = cur[i].wrapping_add(up[i]); } }
            //
            // a pixel at a time, its channels side by side: the dependency is on the pixel before, not the byte before
            (1, 3) => sub_px::<3>(cur),
            (1, 4) => sub_px::<4>(cur),
            (3, 3) => row_avg::<3>(cur, up),
            (3, 4) => row_avg::<4>(cur, up),
            (4, 3) => row_paeth::<3>(cur, up),
            (4, 4) => row_paeth::<4>(cur, up),
            (1, _) => {
                for i in bpp..row_bytes { cur[i] = cur[i].wrapping_add(cur[i - bpp]); }
            }
            (3, _) => {
                for i in 0..bpp.min(row_bytes) { cur[i] = cur[i].wrapping_add(up[i] >> 1); }
                for i in bpp..row_bytes { cur[i] = cur[i].wrapping_add(((cur[i - bpp] as u16 + up[i] as u16) >> 1) as u8); }
            }
            (4, _) => {
                for i in 0..bpp.min(row_bytes) { cur[i] = cur[i].wrapping_add(up[i]); }   // paeth(0, b, 0) is b
                for i in bpp..row_bytes { cur[i] = cur[i].wrapping_add(paeth(cur[i - bpp], up[i], up[i - bpp])); }
            }
            _ => return y,
        }
    }
    if rows > 0 {
        if let Some(p) = prev {
            let last = (rows - 1) * stride + 1;
            p[..row_bytes].copy_from_slice(&lines[last..last + row_bytes]);
        }
    }
    rows
}

/// The unfiltered lines of an 8-bit RGB or RGBA picture as RGBA8: `channels` is 3 (alpha 255) or 4.
pub fn lines_to_rgba(lines: &[u8], rows: usize, w: usize, channels: usize, out: &mut [u8]) {
    let stride = w * channels + 1;
    for y in 0..rows {
        let src = &lines[y * stride + 1..(y + 1) * stride];
        let dst = &mut out[y * w * 4..(y + 1) * w * 4];
        if channels == 4 {
            dst.copy_from_slice(src);
        } else {
            for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(3)) {
                d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; d[3] = 255;
            }
        }
    }
}

// ---- writing: the filter choice in lanes (W1, docs/PLAN_WASM_BUILD.md §7) -------------------------------------------
//
// The same choice and the same bytes as `filter_row`. All five filters read only the raw rows (the byte to the left, the
// one above, the one above left), so the SIMD build takes 16 bytes at a time: the five filtered groups, their costs
// (|signed byte| is `i8x16_abs` read as unsigned, 0x80 giving 128) added in u16 lanes for at most BLOCK groups and then
// in u32 lanes, exact integers, so the sums and the choice are the scalar loop's. The Paeth group it computed for its
// sum goes straight into `out` (Paeth wins about three rows in four of a photograph, K0c's `png_filter_types`); a row
// whose choice is another filter is written again with that filter alone, one or two lane ops per 16 bytes, so no row
// is kept elsewhere and nothing is allocated. The first pixel (no left neighbour) and the bytes after the last whole
// group go through the scalar code, a row narrower than the first pixel and one group through `filter_row` itself.
// The scalar build is `filter_row`, unchanged: tools/px_test.js holds the two builds and the JS twin to the same bytes.

#[cfg(not(target_feature = "simd128"))]
#[inline(always)]
fn row_avg<const B: usize>(cur: &mut [u8], up: &[u8]) {
    avg_px::<B>(cur, up)
}

#[cfg(not(target_feature = "simd128"))]
#[inline(always)]
fn row_paeth<const B: usize>(cur: &mut [u8], up: &[u8]) {
    paeth_px::<B>(cur, up)
}

#[cfg(target_feature = "simd128")]
#[inline(always)]
fn row_avg<const B: usize>(cur: &mut [u8], up: &[u8]) {
    let _ = avg_px::<B>;
    lanes::avg_px::<B>(cur, up)
}

#[cfg(target_feature = "simd128")]
#[inline(always)]
fn row_paeth<const B: usize>(cur: &mut [u8], up: &[u8]) {
    let _ = paeth_px::<B>;
    lanes::paeth_px::<B>(cur, up)
}

#[cfg(not(target_feature = "simd128"))]
#[inline(always)]
fn row_filter(row: &[u8], up: Option<&[u8]>, out: &mut [u8]) {
    filter_row(row, up, out)
}

#[cfg(target_feature = "simd128")]
#[inline(always)]
fn row_filter(row: &[u8], up: Option<&[u8]>, out: &mut [u8]) {
    if row.len() < lanes::MIN {
        return filter_row(row, up, out);
    }
    match up {
        Some(u) => lanes::filter_row::<true>(row, &u[..row.len()], out),
        None => lanes::filter_row::<false>(row, &[], out),
    }
}

#[cfg(target_feature = "simd128")]
mod lanes {
    use super::{cost, filtered};
    use core::arch::wasm32::*;

    /// The narrowest row in lanes: the first pixel and one group of 16 bytes.
    pub const MIN: usize = 4 + 16;
    /// Groups added in u16 lanes before they go into u32 ones: a group adds at most 2 x 128 to a lane, 255 x 256 < 65536.
    const BLOCK: usize = 255;

    /// `row` (at least MIN bytes) filtered into `out` (the type byte, then the row); `up` is the row above, as long as
    /// `row`, when `UP`, else empty (zeros above).
    pub fn filter_row<const UP: bool>(row: &[u8], up: &[u8], out: &mut [u8]) {
        let n = row.len();
        let (head, rest) = out.split_at_mut(1);
        let o = &mut rest[..n];
        let above = |i: usize| if UP { up[i] } else { 0 };
        let above_left = |i: usize| if UP { up[i - 4] } else { 0 };
        let mut tot = [0u32; 5];
        // the first pixel: nothing to its left (a = c = 0)
        for i in 0..4 {
            let (x, b) = (row[i], above(i));
            for t in 0..5u8 {
                tot[t as usize] += cost(filtered(t, x, 0, b, 0));
            }
            o[i] = filtered(4, x, 0, b, 0);
        }
        let end = 4 + (n - 4) / 16 * 16;
        // every load and store in there is inside `row`, `up` and `o`: 4 <= i and i + 16 <= end <= n
        unsafe { sums::<UP>(row.as_ptr(), up.as_ptr(), o.as_mut_ptr(), end, &mut tot) };
        // the bytes after the last whole group
        for i in end..n {
            let (x, a, b, c) = (row[i], row[i - 4], above(i), above_left(i));
            for t in 0..5u8 {
                tot[t as usize] += cost(filtered(t, x, a, b, c));
            }
            o[i] = filtered(4, x, a, b, c);
        }
        let mut best = 0u8;
        for t in 1..if UP { 5u8 } else { 2u8 } {
            if tot[t as usize] < tot[best as usize] {
                best = t;
            }
        }
        head[0] = best;
        match best {
            4 => return,   // already written
            0 => {
                o.copy_from_slice(row);
                return;
            }
            _ => {}
        }
        for i in 0..4 {
            o[i] = filtered(best, row[i], 0, above(i), 0);
        }
        unsafe {
            match best {
                1 => write::<UP, 1>(row.as_ptr(), up.as_ptr(), o.as_mut_ptr(), end),
                2 => write::<UP, 2>(row.as_ptr(), up.as_ptr(), o.as_mut_ptr(), end),
                _ => write::<UP, 3>(row.as_ptr(), up.as_ptr(), o.as_mut_ptr(), end),
            }
        }
        for i in end..n {
            o[i] = filtered(best, row[i], row[i - 4], above(i), above_left(i));
        }
    }

    /// The costs of bytes 4..end under the five filters added to `tot`, and the Paeth bytes written to `o`.
    #[inline(always)]
    unsafe fn sums<const UP: bool>(r: *const u8, u: *const u8, o: *mut u8, end: usize, tot: &mut [u32; 5]) {
        let zero = u8x16_splat(0);
        let mut acc = [u32x4_splat(0); 5];
        let mut i = 4;
        while i < end {
            let stop = end.min(i + BLOCK * 16);
            let mut s = [u16x8_splat(0); 5];
            while i < stop {
                let x = v128_load(r.add(i) as *const v128);
                let a = v128_load(r.add(i - 4) as *const v128);
                let (b, c) = if UP { (v128_load(u.add(i) as *const v128), v128_load(u.add(i - 4) as *const v128)) } else { (zero, zero) };
                let f4 = i8x16_sub(x, paeth(a, b, c));
                v128_store(o.add(i) as *mut v128, f4);
                s[0] = i16x8_add(s[0], cost16(x));
                s[1] = i16x8_add(s[1], cost16(i8x16_sub(x, a)));
                s[2] = i16x8_add(s[2], cost16(i8x16_sub(x, b)));
                s[3] = i16x8_add(s[3], cost16(i8x16_sub(x, avg(a, b))));
                s[4] = i16x8_add(s[4], cost16(f4));
                i += 16;
            }
            for k in 0..5 {
                acc[k] = i32x4_add(acc[k], u32x4_extadd_pairwise_u16x8(s[k]));
            }
        }
        for k in 0..5 {
            let v = acc[k];
            tot[k] += u32x4_extract_lane::<0>(v) + u32x4_extract_lane::<1>(v) + u32x4_extract_lane::<2>(v) + u32x4_extract_lane::<3>(v);
        }
    }

    /// Bytes 4..end filtered with `T` (1 Sub, 2 Up, 3 Average) into `o`.
    #[inline(always)]
    unsafe fn write<const UP: bool, const T: u8>(r: *const u8, u: *const u8, o: *mut u8, end: usize) {
        let mut i = 4;
        while i < end {
            let x = v128_load(r.add(i) as *const v128);
            let a = v128_load(r.add(i - 4) as *const v128);
            let b = if UP { v128_load(u.add(i) as *const v128) } else { u8x16_splat(0) };
            let p = match T {
                1 => a,
                2 => b,
                _ => avg(a, b),
            };
            v128_store(o.add(i) as *mut v128, i8x16_sub(x, p));
            i += 16;
        }
    }

    /// The 16 costs of a group, |signed byte|, added in pairs into eight u16 lanes.
    #[inline(always)]
    unsafe fn cost16(v: v128) -> v128 {
        u16x8_extadd_pairwise_u8x16(i8x16_abs(v))
    }

    /// floor((a + b) / 2) per byte: the average rounded up, less the bit it rounded.
    #[inline(always)]
    unsafe fn avg(a: v128, b: v128) -> v128 {
        i8x16_sub(u8x16_avgr(a, b), v128_and(v128_xor(a, b), u8x16_splat(1)))
    }

    /// The Paeth predictor per byte in the standard's order (a, then b, then c), its distances in i16 lanes.
    #[inline(always)]
    unsafe fn paeth(a: v128, b: v128, c: v128) -> v128 {
        let (ma0, mb0) = choose(u16x8_extend_low_u8x16(a), u16x8_extend_low_u8x16(b), u16x8_extend_low_u8x16(c));
        let (ma1, mb1) = choose(u16x8_extend_high_u8x16(a), u16x8_extend_high_u8x16(b), u16x8_extend_high_u8x16(c));
        let ma = i8x16_narrow_i16x8(ma0, ma1);
        let mb = i8x16_narrow_i16x8(mb0, mb1);
        v128_bitselect(a, v128_bitselect(b, c, mb), ma)
    }

    /// Eight bytes widened: all ones where the predictor is a, and where it is b when it is not a.
    #[inline(always)]
    unsafe fn choose(a: v128, b: v128, c: v128) -> (v128, v128) {
        let bc = i16x8_sub(b, c);
        let ac = i16x8_sub(a, c);
        let pa = i16x8_abs(bc);
        let pb = i16x8_abs(ac);
        let pc = i16x8_abs(i16x8_add(bc, ac));
        (v128_and(i16x8_le(pa, pb), i16x8_le(pa, pc)), i16x8_le(pb, pc))
    }

    // ---- reading: Up in 16-byte groups, Average and Paeth per pixel across channels in i16x8 lanes (K6) -------------

    /// Undo filter 2 (Up) 16 bytes at a time, the tail byte by byte.
    pub fn up_row(cur: &mut [u8], up: &[u8]) {
        let n = cur.len().min(up.len());
        let end = n / 16 * 16;
        let (c, u) = (cur.as_mut_ptr(), up.as_ptr());
        let mut i = 0;
        unsafe {
            while i < end {
                let x = v128_load(c.add(i) as *const v128);
                let b = v128_load(u.add(i) as *const v128);
                v128_store(c.add(i) as *mut v128, i8x16_add(x, b));
                i += 16;
            }
        }
        for i in end..n {
            cur[i] = cur[i].wrapping_add(up[i]);
        }
    }

    /// Undo filter 3 (Average) a pixel of `B` bytes (3 or 4) at a time, its channels side by side in i16x8 lanes.
    pub fn avg_px<const B: usize>(cur: &mut [u8], up: &[u8]) {
        let n = cur.len().min(up.len()) / B * B;
        let (cp, up) = (cur.as_mut_ptr(), up.as_ptr());
        let mut i = 0;
        unsafe {
            let mask = i16x8_splat(255);
            let mut a = i16x8_splat(0);
            while i < n {
                let x = load_px::<B>(cp.add(i));
                let b = load_px::<B>(up.add(i));
                let pred = u16x8_shr(i16x8_add(a, b), 1);
                a = v128_and(i16x8_add(x, pred), mask);
                store_px::<B>(cp.add(i), a);
                i += B;
            }
        }
    }

    /// Undo filter 4 (Paeth) a pixel of `B` bytes (3 or 4) at a time, its channels side by side in i16x8 lanes, the
    /// predictor picked with `v128_bitselect` in the standard's tie order (a, then b, then c).
    pub fn paeth_px<const B: usize>(cur: &mut [u8], up: &[u8]) {
        let n = cur.len().min(up.len()) / B * B;
        let (cp, up) = (cur.as_mut_ptr(), up.as_ptr());
        let mut i = 0;
        unsafe {
            let mask = i16x8_splat(255);
            let mut a = i16x8_splat(0);
            let mut c = i16x8_splat(0);
            while i < n {
                let x = load_px::<B>(cp.add(i));
                let b = load_px::<B>(up.add(i));
                let (ma, mb) = choose(a, b, c);
                let pred = v128_bitselect(a, v128_bitselect(b, c, mb), ma);
                a = v128_and(i16x8_add(x, pred), mask);
                c = b;
                store_px::<B>(cp.add(i), a);
                i += B;
            }
        }
    }

    /// A pixel of `B` bytes (3 or 4) widened into the low `B` i16 lanes (`0..255`).
    #[inline(always)]
    unsafe fn load_px<const B: usize>(p: *const u8) -> v128 {
        if B == 4 {
            u16x8_extend_low_u8x16(v128_load32_zero(p as *const u32))
        } else {
            let v = v128_load16_lane::<0>(u8x16_splat(0), p as *const u16);
            u16x8_extend_low_u8x16(v128_load8_lane::<2>(v, p.add(2)))
        }
    }

    /// The low `B` i16 lanes (`0..255`) narrowed and written as `B` bytes.
    #[inline(always)]
    unsafe fn store_px<const B: usize>(p: *mut u8, v: v128) {
        let b = u8x16_narrow_i16x8(v, v);
        if B == 4 {
            v128_store32_lane::<0>(b, p as *mut u32);
        } else {
            v128_store16_lane::<0>(b, p as *mut u16);
            v128_store8_lane::<2>(b, p.add(2));
        }
    }
}

/// IEEE 802.3 reflected CRC-32 (`0xEDB8_8320`) slice-by-16 lookup tables (`CRC_TABLE[0]` byte-wise, `CRC_TABLE[s]`
/// shifted `s` bytes ahead). Built at compile time so `Cargo.lock` gains no dependency (`tools/build_px.py --locked`).
const CRC_TABLE: [[u32; 256]; 16] = {
    let mut t = [[0u32; 256]; 16];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
            k += 1;
        }
        t[0][i] = c;
        i += 1;
    }
    let mut s = 1;
    while s < 16 {
        let mut i = 0;
        while i < 256 {
            let prev = t[s - 1][i];
            t[s][i] = t[0][(prev & 0xFF) as usize] ^ (prev >> 8);
            i += 1;
        }
        s += 1;
    }
    t
};

/// The CRC-32 of `src`, continued from `start` (0 for a new checksum), 16 bytes at a time through `CRC_TABLE`.
pub fn crc32(src: &[u8], start: u32) -> u32 {
    let mut c = !start;
    let mut chunks = src.chunks_exact(16);
    for b in &mut chunks {
        let d0 = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) ^ c;
        let d1 = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
        let d2 = u32::from_le_bytes([b[8], b[9], b[10], b[11]]);
        let d3 = u32::from_le_bytes([b[12], b[13], b[14], b[15]]);
        c = CRC_TABLE[15][(d0 & 0xFF) as usize]
            ^ CRC_TABLE[14][((d0 >> 8) & 0xFF) as usize]
            ^ CRC_TABLE[13][((d0 >> 16) & 0xFF) as usize]
            ^ CRC_TABLE[12][(d0 >> 24) as usize]
            ^ CRC_TABLE[11][(d1 & 0xFF) as usize]
            ^ CRC_TABLE[10][((d1 >> 8) & 0xFF) as usize]
            ^ CRC_TABLE[9][((d1 >> 16) & 0xFF) as usize]
            ^ CRC_TABLE[8][(d1 >> 24) as usize]
            ^ CRC_TABLE[7][(d2 & 0xFF) as usize]
            ^ CRC_TABLE[6][((d2 >> 8) & 0xFF) as usize]
            ^ CRC_TABLE[5][((d2 >> 16) & 0xFF) as usize]
            ^ CRC_TABLE[4][(d2 >> 24) as usize]
            ^ CRC_TABLE[3][(d3 & 0xFF) as usize]
            ^ CRC_TABLE[2][((d3 >> 8) & 0xFF) as usize]
            ^ CRC_TABLE[1][((d3 >> 16) & 0xFF) as usize]
            ^ CRC_TABLE[0][(d3 >> 24) as usize];
    }
    for &byte in chunks.remainder() {
        c = CRC_TABLE[0][((c ^ byte as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    !c
}

/// Frame `data_len` bytes already at `buf[8..8 + data_len]` as a PNG chunk of 4-byte `kind` (big-endian, e.g.
/// `0x49444154` for `"IDAT"`): length and type in `buf[0..8]`, the chunk's CRC-32 over `buf[4..8 + data_len]` in
/// `buf[8 + data_len..12 + data_len]`. Returns that CRC-32.
pub fn chunk_frame(buf: &mut [u8], data_len: usize, kind: u32) -> u32 {
    buf[0..4].copy_from_slice(&(data_len as u32).to_be_bytes());
    buf[4..8].copy_from_slice(&kind.to_be_bytes());
    let crc = crc32(&buf[4..8 + data_len], 0);
    buf[8 + data_len..12 + data_len].copy_from_slice(&crc.to_be_bytes());
    crc
}

// ---- K7: one part of an 8-bit RGBA PNG (docs/PLAN_WASM_BUILD.md §4.2, §7 Stop 2) -----------------------------------

/// Standard PNG part target size in uncompressed pixel bytes (`inpaint_png.js` `PART_BYTES`).
pub const PART_BYTES: usize = 8 * 1048576;
/// Maximum rows in one PNG part (`inpaint_canvas.js` `programRows` / `bandPlan.rows` / `bandSource` ->
/// `inpaint_bands.js` `bandRows` align / `forParts` -> `inpaint_png.js` `partRows(width, align)`).
pub const PART_MAX_ROWS: usize = 2048;
/// `png_part_decode` / `png_part_finish`: `lines` is empty or not a whole number of `1 + 4 * w`-byte scanlines.
pub const PART_NOT_LINES: isize = -4;
/// `png_part_decode` / `png_part_finish`: a scanline's filter byte is not `0..=4`.
pub const PART_BAD_FILTER: isize = -5;

/// Byte capacity of `lines` for a standard `PART_BYTES` part of a `w`-wide 8-bit RGBA PNG (`partRows(w, 2048) * (1 + 4 * w)`).
pub fn part_lines_cap(w: usize) -> usize {
    let Some(row_bytes) = w.checked_mul(4) else { return 0 };
    if row_bytes == 0 {
        return 0;
    }
    let stride = row_bytes + 1;
    let rows = (PART_BYTES / row_bytes).clamp(1, PART_MAX_ROWS);
    rows * stride
}

/// Copy `rows` unfiltered RGBA8 scanlines (`1 + 4 * w` bytes each) from `lines` into `out` (`rows * 4 * w` bytes),
/// applying the 65,536-byte CPU-canvas round-trip table `rt` (`t[(a << 8) | c]` for `a < 255`) when given.
/// Returns `1` when every pixel has `a == 255`, `0` otherwise.
pub fn lines_to_rgba_rt(lines: &[u8], rows: usize, w: usize, rt: Option<&[u8; 65536]>, out: &mut [u8]) -> u32 {
    let row_bytes = w * 4;
    let stride = row_bytes + 1;
    for y in 0..rows {
        let src = &lines[y * stride + 1..(y + 1) * stride];
        let dst = &mut out[y * row_bytes..(y + 1) * row_bytes];
        dst.copy_from_slice(src);
    }
    let mut opaque = 1u32;
    let rgba = &mut out[..rows * row_bytes];
    if let Some(t) = rt {
        for px in rgba.chunks_exact_mut(4) {
            let a = px[3] as usize;
            if a < 255 {
                opaque = 0;
                let row = a << 8;
                px[0] = t[row | px[0] as usize];
                px[1] = t[row | px[1] as usize];
                px[2] = t[row | px[2] as usize];
            }
        }
    } else {
        for px in rgba.chunks_exact(4) {
            if px[3] < 255 {
                opaque = 0;
                break;
            }
        }
    }
    opaque
}

/// Decode one inflated part (`lines`, a whole number of `1 + 4 * w`-byte scanlines) of a `w`-wide 8-bit RGBA PNG (K7,
/// `docs/PLAN_WASM_BUILD.md` §4.2). Writes `[rows, adler, first_filter, opaque, needs_prev]` to `info` and returns
/// `rows` (`> 0`), `PART_NOT_LINES` (`-4`), or `PART_BAD_FILTER` (`-5`).
pub fn part_decode(
    lines: &mut [u8],
    w: usize,
    prev: Option<&mut [u8]>,
    rt: Option<&[u8; 65536]>,
    out: Option<&mut [u8]>,
    info: &mut [u32; 5],
) -> isize {
    let Some(row_bytes) = w.checked_mul(4) else { return PART_NOT_LINES };
    if row_bytes == 0 || lines.is_empty() {
        return PART_NOT_LINES;
    }
    let stride = row_bytes + 1;
    if lines.len() % stride != 0 {
        return PART_NOT_LINES;
    }
    let rows = lines.len() / stride;
    for y in 0..rows {
        if lines[y * stride] > 4 {
            return PART_BAD_FILTER;
        }
    }
    let first_filter = lines[0] as u32;
    let adler = adler32(lines, 1);
    if prev.is_none() && first_filter >= 2 {
        *info = [rows as u32, adler, first_filter, 0, 1];
        return rows as isize;
    }
    let Some(dst) = out else { return PART_NOT_LINES };
    unfilter_rows_opt(lines, rows, row_bytes, 4, prev);
    let opaque = lines_to_rgba_rt(lines, rows, w, rt, dst);
    *info = [rows as u32, adler, first_filter, opaque, 0];
    rows as isize
}

/// Finish a part whose `part_decode` answered `needs_prev = 1` once `prev` (`4 * w` unfiltered bytes from the row
/// above) is ready (K7, `docs/PLAN_WASM_BUILD.md` §4.2). Writes `[rows, 0, first_filter, opaque, 0]` to `info` and
/// returns `rows` (`> 0`), `PART_NOT_LINES` (`-4`), or `PART_BAD_FILTER` (`-5`).
pub fn part_finish(
    lines: &mut [u8],
    rows: usize,
    w: usize,
    prev: &mut [u8],
    rt: Option<&[u8; 65536]>,
    out: &mut [u8],
    info: &mut [u32; 5],
) -> isize {
    let Some(row_bytes) = w.checked_mul(4) else { return PART_NOT_LINES };
    if row_bytes == 0 || rows == 0 {
        return PART_NOT_LINES;
    }
    let stride = row_bytes + 1;
    for y in 0..rows {
        if lines[y * stride] > 4 {
            return PART_BAD_FILTER;
        }
    }
    let first_filter = lines[0] as u32;
    unfilter_rows(lines, rows, row_bytes, 4, prev);
    let opaque = lines_to_rgba_rt(lines, rows, w, rt, out);
    *info = [rows as u32, 0, first_filter, opaque, 0];
    rows as isize
}


