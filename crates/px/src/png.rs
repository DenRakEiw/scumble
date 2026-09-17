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
pub fn deflate_part(src: &[u8], level: i32, last: bool, out: &mut [u8]) -> isize {
    let flags = create_comp_flags_from_zip_params(level, -15, 0);
    let mut c = Box::new(CompressorOxide::new(flags));
    let (status, consumed, written) = compress(&mut c, src, out, if last { TDEFLFlush::Finish } else { TDEFLFlush::Sync });
    let done = if last { status == TDEFLStatus::Done } else { status == TDEFLStatus::Okay };
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
    for t in 1..5u8 {
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
        filter_row(row, up, o);
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
    let stride = row_bytes + 1;
    for y in 0..rows {
        let (done, rest) = lines.split_at_mut(y * stride);
        let line = &mut rest[..stride];
        let ft = line[0];
        let cur = &mut line[1..];
        let up: &[u8] = if y == 0 { &prev[..row_bytes] } else { &done[(y - 1) * stride + 1..y * stride] };
        match (ft, bpp) {
            (0, _) => {}
            (2, _) => {
                for i in 0..row_bytes { cur[i] = cur[i].wrapping_add(up[i]); }
            }
            // a pixel at a time, its channels side by side: the dependency is on the pixel before, not the byte before
            (1, 3) => sub_px::<3>(cur),
            (1, 4) => sub_px::<4>(cur),
            (3, 3) => avg_px::<3>(cur, up),
            (3, 4) => avg_px::<4>(cur, up),
            (4, 3) => paeth_px::<3>(cur, up),
            (4, 4) => paeth_px::<4>(cur, up),
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
        let last = (rows - 1) * stride + 1;
        prev[..row_bytes].copy_from_slice(&lines[last..last + row_bytes]);
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
