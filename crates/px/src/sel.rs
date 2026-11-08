//! The selection's combine and invert (docs/PLAN_WASM_BUILD.md §4.3, K5, K11): one tile of the selection, `size`²
//! RGBA8 with straight alpha, combined with an alpha source under a mode or inverted in `255 - a`, the maths of
//! `combineRows` (renderer/editor/inpaint_raster.js), and the tile's extent found on the way, as `tileExtent`
//! (renderer/editor/inpaint_tiles.js) finds it, so `bounds()` need not scan the tile again.
//!
//!   replace    a = s
//!   add        a = d + s - mul255(d, s)
//!   subtract   a = max(0, d - mul255(d, s))
//!   intersect  a = mul255(d, s)                  mul255(x, y) = round(x * y / 255), exact in integers
//!
//! A pixel with a > 0 gets the colour and a, one with a = 0 becomes 0, 0, 0, 0 (canvas and tiles agree byte for byte).
//! Only the `bw` x `bh` pixels from the tile's corner are combined (the part of the tile inside the image); the rest of
//! the tile is kept and only read for the extent, or with FRESH written as 0 (a tile that did not exist: its old alpha
//! is taken as 0). The source region is `bw` x `bh` pixels, `stride` pixels a row: KIND_ALPHA one byte a pixel,
//! KIND_RGBA four (the alpha is the fourth), KIND_NONE all 0 and KIND_FULL all 255 without a buffer. All integer, so the
//! JS twin (renderer/editor/px/kernels_js.js `selCombine`), the scalar build and the SIMD build give the same bytes.

/// A source of no coverage: every source alpha is 0, no buffer.
pub const KIND_NONE: u32 = 0;
/// One alpha byte a pixel.
pub const KIND_ALPHA: u32 = 1;
/// Full coverage: every source alpha is 255, no buffer.
pub const KIND_FULL: u32 = 2;
/// RGBA8, the alpha the fourth byte of a pixel.
pub const KIND_RGBA: u32 = 4;
/// Added to the mode: the tile is new, its old alpha is taken as 0 and all of it is written.
pub const FRESH: u32 = 8;
/// The answer for arguments out of range: nothing written.
pub const REFUSED: u32 = 2;

#[inline(always)]
fn mul255(x: u32, y: u32) -> u32 {
    let t = x * y + 128;
    (t + (t >> 8)) >> 8
}

#[inline(always)]
fn alpha_of(mode: u32, d: u32, s: u32) -> u32 {
    match mode {
        0 => s,
        1 => d + s - mul255(d, s),
        2 => d.saturating_sub(mul255(d, s)),
        _ => mul255(d, s),
    }
}

/// The bytes a source region of `bw` x `bh` pixels at `stride` pixels a row spans, or None when it overflows.
pub fn source_bytes(kind: u32, stride: usize, bw: usize, bh: usize) -> Option<usize> {
    let bpp = match kind {
        KIND_ALPHA => 1,
        KIND_RGBA => 4,
        _ => return Some(0),
    };
    if bw == 0 || bh == 0 {
        return Some(0);
    }
    (bh - 1).checked_mul(stride)?.checked_add(bw)?.checked_mul(bpp)
}

/// Combines the tile `dst` (`size`² RGBA8, in place) with the source under `mode` (0 to 3, plus FRESH) in the colour
/// `rgb` (0xRRGGBB). Returns 1 when the tile holds a pixel afterwards, with its extent [x0, y0, x1, y1] (in the tile's
/// pixels, the end exclusive) in `ext`; 0 when it holds none (`ext` not written); REFUSED for arguments out of range.
pub fn sel_combine(dst: &mut [u8], size: usize, src: &[u8], stride: usize, kind: u32, bw: usize, bh: usize, mode: u32, rgb: u32, ext: &mut [i32]) -> u32 {
    let fresh = mode & FRESH != 0;
    let m = mode & !FRESH;
    if m > 3 || !matches!(kind, KIND_NONE | KIND_ALPHA | KIND_FULL | KIND_RGBA) || bw > size || bh > size || ext.len() < 4 {
        return REFUSED;
    }
    let tile = match size.checked_mul(size).and_then(|n| n.checked_mul(4)) {
        Some(n) if n <= dst.len() => n,
        _ => return REFUSED,
    };
    let bpp = match kind {
        KIND_ALPHA => 1,
        KIND_RGBA => 4,
        _ => 0,
    };
    if bpp > 0 && bw > 0 && bh > 0 {
        match source_bytes(kind, stride, bw, bh) {
            Some(n) if stride >= bw && n <= src.len() => {}
            _ => return REFUSED,
        }
    }
    let dst = &mut dst[..tile];
    let (r, g, b) = (((rgb >> 16) & 255) as u8, ((rgb >> 8) & 255) as u8, (rgb & 255) as u8);
    let colour = (r as u32) | ((g as u32) << 8) | ((b as u32) << 16);
    let (mut x0, mut y0, mut x1, mut y1) = (size, usize::MAX, 0usize, 0usize);
    let mut any = false;
    for y in 0..size {
        let row = &mut dst[y * size * 4..(y + 1) * size * 4];
        let mut first = usize::MAX;
        let mut last = 0usize;
        let from = if y < bh && bw > 0 {
            let s: &[u8] = if bpp > 0 { &src[y * stride * bpp..] } else { &[] };
            let (done, f, l) = simd::row(row, s, kind, m, fresh, bw, colour);
            if f != usize::MAX {
                first = f;
                last = l;
            }
            scalar_row(row, s, kind, m, fresh, done, bw, (r, g, b), &mut first, &mut last);
            bw
        } else {
            0
        };
        if fresh {
            row[from * 4..].fill(0);
        } else {
            rest_of_row(row, from, size, &mut first, &mut last);
        }
        if first != usize::MAX {
            any = true;
            if y0 == usize::MAX {
                y0 = y;
            }
            y1 = y;
            if first < x0 {
                x0 = first;
            }
            if last > x1 {
                x1 = last;
            }
        }
    }
    if !any {
        return 0;
    }
    ext[0] = x0 as i32;
    ext[1] = y0 as i32;
    ext[2] = (x1 + 1) as i32;
    ext[3] = (y1 + 1) as i32;
    1
}

/// Inverts the `bw` x `bh` corner of `tile` (`size`² RGBA8, in place) in the colour `rgb` (0xRRGGBB): each pixel's
/// alpha becomes `255 - a`, with colour `rgb` when `a > 0` and `0, 0, 0, 0` when `a == 0`; pixels outside `bw` x `bh`
/// are kept and read for the extent. Returns 1 when the tile holds a pixel afterwards, with its extent [x0, y0, x1, y1]
/// in `ext`; 0 when it holds none (`ext` not written); REFUSED for arguments out of range.
pub fn mask_invert(tile: &mut [u8], size: usize, bw: usize, bh: usize, rgb: u32, ext: &mut [i32]) -> u32 {
    if bw > size || bh > size || ext.len() < 4 {
        return REFUSED;
    }
    let bytes = match size.checked_mul(size).and_then(|n| n.checked_mul(4)) {
        Some(n) if n <= tile.len() => n,
        _ => return REFUSED,
    };
    let tile = &mut tile[..bytes];
    let (r, g, b) = (((rgb >> 16) & 255) as u8, ((rgb >> 8) & 255) as u8, (rgb & 255) as u8);
    let colour = (r as u32) | ((g as u32) << 8) | ((b as u32) << 16);
    let (mut x0, mut y0, mut x1, mut y1) = (size, usize::MAX, 0usize, 0usize);
    let mut any = false;
    for y in 0..size {
        let row = &mut tile[y * size * 4..(y + 1) * size * 4];
        let mut first = usize::MAX;
        let mut last = 0usize;
        let from = if y < bh && bw > 0 {
            let (done, f, l) = simd::invert_row(row, bw, colour);
            if f != usize::MAX {
                first = f;
                last = l;
            }
            scalar_invert_row(row, done, bw, (r, g, b), &mut first, &mut last);
            bw
        } else {
            0
        };
        rest_of_row(row, from, size, &mut first, &mut last);
        if first != usize::MAX {
            any = true;
            if y0 == usize::MAX {
                y0 = y;
            }
            y1 = y;
            if first < x0 {
                x0 = first;
            }
            if last > x1 {
                x1 = last;
            }
        }
    }
    if !any {
        return 0;
    }
    ext[0] = x0 as i32;
    ext[1] = y0 as i32;
    ext[2] = (x1 + 1) as i32;
    ext[3] = (y1 + 1) as i32;
    1
}

/// Pixels `from` to `to` of a row inverted one at a time (the scalar build's whole row, the SIMD build's last few).
#[inline(always)]
fn scalar_invert_row(row: &mut [u8], from: usize, to: usize, (r, g, b): (u8, u8, u8), first: &mut usize, last: &mut usize) {
    for x in from..to {
        let o = x * 4;
        let a = 255 - (row[o + 3] as u32);
        if a != 0 {
            row[o] = r;
            row[o + 1] = g;
            row[o + 2] = b;
            row[o + 3] = a as u8;
            if *first == usize::MAX {
                *first = x;
            }
            *last = x;
        } else {
            row[o] = 0;
            row[o + 1] = 0;
            row[o + 2] = 0;
            row[o + 3] = 0;
        }
    }
}

/// Pixels `from` to `to` of a row one at a time (the scalar build's whole row, the SIMD build's last few).
#[inline(always)]
fn scalar_row(row: &mut [u8], s: &[u8], kind: u32, m: u32, fresh: bool, from: usize, to: usize, (r, g, b): (u8, u8, u8), first: &mut usize, last: &mut usize) {
    for x in from..to {
        let o = x * 4;
        let da = if fresh { 0 } else { row[o + 3] as u32 };
        let sa = match kind {
            KIND_NONE => 0,
            KIND_FULL => 255,
            KIND_ALPHA => s[x] as u32,
            _ => s[x * 4 + 3] as u32,
        };
        let a = alpha_of(m, da, sa);
        if a != 0 {
            row[o] = r;
            row[o + 1] = g;
            row[o + 2] = b;
            row[o + 3] = a as u8;
            if *first == usize::MAX {
                *first = x;
            }
            *last = x;
        } else {
            row[o] = 0;
            row[o + 1] = 0;
            row[o + 2] = 0;
            row[o + 3] = 0;
        }
    }
}

/// The part of a row the combine does not touch, read for the extent: its first and its last pixel with alpha.
fn rest_of_row(row: &[u8], from: usize, size: usize, first: &mut usize, last: &mut usize) {
    let mut x = from;
    while x < size && row[x * 4 + 3] == 0 {
        x += 1;
    }
    if x == size {
        return;
    }
    if *first == usize::MAX {
        *first = x;
    }
    let mut e = size - 1;
    while e > x && row[e * 4 + 3] == 0 {
        e -= 1;
    }
    *last = e;
}

#[cfg(not(target_feature = "simd128"))]
mod simd {
    /// No lanes in the scalar build: nothing done, no pixel found.
    #[inline(always)]
    pub fn row(_: &mut [u8], _: &[u8], _: u32, _: u32, _: bool, _: usize, _: u32) -> (usize, usize, usize) {
        (0, usize::MAX, 0)
    }

    #[inline(always)]
    pub fn invert_row(_: &mut [u8], _: usize, _: u32) -> (usize, usize, usize) {
        (0, usize::MAX, 0)
    }
}

#[cfg(target_feature = "simd128")]
mod simd {
    use super::{KIND_ALPHA, KIND_FULL, KIND_NONE};
    use core::arch::wasm32::*;

    /// The first `n / 4 * 4` pixels of a row, four pixels a lane group (one u32 lane each): returns the pixels done
    /// and the first and last pixel with alpha among them (usize::MAX, 0 when none). `kind` and `mode` are constants of
    /// a tile, so each pair gets a loop of its own.
    #[inline(always)]
    pub fn row(row: &mut [u8], s: &[u8], kind: u32, mode: u32, fresh: bool, n: usize, colour: u32) -> (usize, usize, usize) {
        let n4 = n / 4 * 4;
        if n4 == 0 {
            return (0, usize::MAX, 0);
        }
        let d = row.as_mut_ptr();
        let s = s.as_ptr();
        // the slices are checked by the caller: `row` holds `size` >= n pixels, `s` the source's n pixels of this row
        unsafe {
            macro_rules! go {
                ($k:literal) => {
                    match mode {
                        0 => run::<$k, 0>(d, s, fresh, n4, colour),
                        1 => run::<$k, 1>(d, s, fresh, n4, colour),
                        2 => run::<$k, 2>(d, s, fresh, n4, colour),
                        _ => run::<$k, 3>(d, s, fresh, n4, colour),
                    }
                };
            }
            match kind {
                KIND_NONE => go!(0),
                KIND_ALPHA => go!(1),
                KIND_FULL => go!(2),
                _ => go!(4),
            }
        }
    }

    #[inline(always)]
    unsafe fn mul255(x: v128, y: v128) -> v128 {
        let t = i32x4_add(i32x4_mul(x, y), u32x4_splat(128));
        u32x4_shr(i32x4_add(t, u32x4_shr(t, 8)), 8)
    }

    /// Four source alphas from pixel `x` of the row, one per u32 lane.
    #[inline(always)]
    unsafe fn source<const K: u32>(s: *const u8, x: usize) -> v128 {
        match K {
            0 => u32x4_splat(0),
            2 => u32x4_splat(255),
            1 => u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v128_load32_zero(s.add(x) as *const u32))),
            _ => u32x4_shr(v128_load(s.add(x * 4) as *const v128), 24),
        }
    }

    #[inline(always)]
    unsafe fn alpha<const M: u32>(d: v128, s: v128) -> v128 {
        match M {
            0 => s,
            1 => i32x4_sub(i32x4_add(d, s), mul255(d, s)),
            2 => i32x4_max(i32x4_sub(d, mul255(d, s)), u32x4_splat(0)),
            _ => mul255(d, s),
        }
    }

    #[inline(always)]
    unsafe fn run<const K: u32, const M: u32>(d: *mut u8, s: *const u8, fresh: bool, n4: usize, colour: u32) -> (usize, usize, usize) {
        let c = u32x4_splat(colour);
        let zero = u32x4_splat(0);
        let (mut first, mut last) = (usize::MAX, 0usize);
        let mut x = 0;
        while x < n4 {
            let p = d.add(x * 4) as *mut v128;
            let da = if fresh { zero } else { u32x4_shr(v128_load(p), 24) };
            let a = alpha::<M>(da, source::<K>(s, x));
            let covered = i32x4_ne(a, zero);
            v128_store(p, v128_and(v128_or(i32x4_shl(a, 24), c), covered));
            let bits = i32x4_bitmask(covered) as u32;
            if bits != 0 {
                if first == usize::MAX {
                    first = x + bits.trailing_zeros() as usize;
                }
                last = x + (31 - bits.leading_zeros()) as usize;
            }
            x += 4;
        }
        (n4, first, last)
    }

    /// The first `n / 4 * 4` pixels of a row inverted, four pixels a lane group (one u32 lane each): returns the
    /// pixels done and the first and last pixel with alpha among them (usize::MAX, 0 when none).
    #[inline(always)]
    pub fn invert_row(row: &mut [u8], n: usize, colour: u32) -> (usize, usize, usize) {
        let n4 = n / 4 * 4;
        if n4 == 0 {
            return (0, usize::MAX, 0);
        }
        let d = row.as_mut_ptr();
        let c = u32x4_splat(colour);
        let ff = u32x4_splat(255);
        let zero = u32x4_splat(0);
        let (mut first, mut last) = (usize::MAX, 0usize);
        let mut x = 0;
        // `row` holds `size` >= n pixels, checked by the caller
        unsafe {
            while x < n4 {
                let p = d.add(x * 4) as *mut v128;
                let a = i32x4_sub(ff, u32x4_shr(v128_load(p), 24));
                let covered = i32x4_ne(a, zero);
                v128_store(p, v128_and(v128_or(i32x4_shl(a, 24), c), covered));
                let bits = i32x4_bitmask(covered) as u32;
                if bits != 0 {
                    if first == usize::MAX {
                        first = x + bits.trailing_zeros() as usize;
                    }
                    last = x + (31 - bits.leading_zeros()) as usize;
                }
                x += 4;
            }
        }
        (n4, first, last)
    }
}
