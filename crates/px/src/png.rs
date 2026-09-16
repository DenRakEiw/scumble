//! PNG rows: the filter per row (libpng's heuristic).
//!
//! `filter_rows` writes, for every row of RGBA8, one filter-type byte and the filtered row.
//! The filter is the one of None, Sub, Up, Average, Paeth whose output has the smallest sum
//! of absolute values when the bytes are read as signed (ties go to the lower type, the order
//! libpng tries them in). The row above the first one is `prev`, or zeros.
//!
//! Deflate is not here: the browser's `CompressionStream("deflate")` was 1.4 to 2.2× faster than
//! miniz_oxide (docs/PERFORMANCE.md §10), so the crate dropped it in phase R.

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
