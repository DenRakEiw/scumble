//! Whole worker jobs around a kernel: the loops before and after it run here too, so a job crosses the
//! wasm boundary once with its pixels (docs/PERFORMANCE.md §12: the byte scans around the EDT and the
//! flood were more than half of the grow and wand jobs).
//!
//! Selections are RGBA8 as the editor keeps them: selected where alpha > 127, written as red.

use crate::{edt, flood};

/// Bounds of the pixels with alpha > 127: [x0, y0, x1, y1], right and bottom exclusive; None when empty.
fn alpha_bounds(d: &[u8], w: usize, h: usize) -> Option<[usize; 4]> {
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
    let mut any = false;
    for (y, row) in d.chunks_exact(w * 4).take(h).enumerate() {
        // the first and the last selected pixel of the row
        let first = row.chunks_exact(4).position(|p| p[3] > 127);
        let Some(first) = first else { continue };
        let last = row.chunks_exact(4).rposition(|p| p[3] > 127).unwrap_or(first);
        any = true;
        x0 = x0.min(first);
        x1 = x1.max(last + 1);
        if y < y0 {
            y0 = y;
        }
        y1 = y + 1;
    }
    if any { Some([x0, y0, x1, y1]) } else { None }
}

fn fill_red_clear(d: &mut [u8]) {
    for p in d.chunks_exact_mut(4) {
        p.copy_from_slice(&[255, 0, 0, 0]);
    }
}

/// `growMask` and the `maskBounds` of its result (inpaint_raster.js) in one call: the selection `d` (w × h RGBA8)
/// grown (n > 0) or shrunk (n < 0) by |n| pixels in place, hard edged. `bounds` gets the result's bounds; returns 1
/// when something is selected afterwards, else 0.
pub fn grow_mask(d: &mut [u8], w: usize, h: usize, n: i32, bounds: &mut [i32]) -> i32 {
    let d = &mut d[..w * h * 4];
    let grow = n > 0;
    let r = n.unsigned_abs() as usize;
    let Some(b) = alpha_bounds(d, w, h) else {
        fill_red_clear(d);
        return 0;
    };
    let pad = r + 2;
    let bx0 = b[0].saturating_sub(pad);
    let by0 = b[1].saturating_sub(pad);
    let bx1 = (b[2] + pad).min(w);
    let by1 = (b[3] + pad).min(h);
    let (bw, bh) = (bx1 - bx0, by1 - by0);
    let mut feature = vec![0u8; bw * bh];
    for y in 0..bh {
        let src = &d[((by0 + y) * w + bx0) * 4..((by0 + y) * w + bx1) * 4];
        let dst = &mut feature[y * bw..(y + 1) * bw];
        for (f, p) in dst.iter_mut().zip(src.chunks_exact(4)) {
            let sel = p[3] > 127;
            *f = (sel == grow) as u8;
        }
    }
    let mut dist = vec![0f32; bw * bh];
    let mut scratch = vec![0u64; (edt::scratch_bytes(bw, bh) + 7) / 8];
    let scratch_bytes = unsafe { core::slice::from_raw_parts_mut(scratch.as_mut_ptr() as *mut u8, scratch.len() * 8) };
    edt::dist_transform(&feature, bw, bh, &mut dist, scratch_bytes);
    drop(feature);
    fill_red_clear(d);
    let r2 = (r * r) as f64;
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
    let mut any = false;
    for y in 0..bh {
        let drow = &dist[y * bw..(y + 1) * bw];
        let out = &mut d[((by0 + y) * w + bx0) * 4..((by0 + y) * w + bx1) * 4];
        let mut first = usize::MAX;
        let mut last = 0usize;
        for (x, (&v, p)) in drow.iter().zip(out.chunks_exact_mut(4)).enumerate() {
            let inside = if grow { (v as f64) <= r2 } else { (v as f64) > r2 };
            if inside {
                p[3] = 255;
                if first == usize::MAX {
                    first = x;
                }
                last = x;
            }
        }
        if first != usize::MAX {
            any = true;
            x0 = x0.min(bx0 + first);
            x1 = x1.max(bx0 + last + 1);
            if by0 + y < y0 {
                y0 = by0 + y;
            }
            y1 = by0 + y + 1;
        }
    }
    if !any {
        return 0;
    }
    bounds[..4].copy_from_slice(&[x0 as i32, y0 as i32, x1 as i32, y1 as i32]);
    1
}

/// The worker's flood job (inpaint_worker.js `flood`) after its read: the region of pixels similar to (sx, sy) in
/// `rgba`, clipped to `sel` (RGBA8 of the same size, selected where alpha >= 128) when given, drawn over `rgba` itself
/// as `color` (opaque where the region is, transparent black elsewhere): the picture is not needed afterwards, and a
/// second picture-sized buffer would be 600 MB more wasm memory at 15k. `info` gets [count, x0, y0, x1, y1]
/// (right and bottom exclusive, x1 = -1 when empty). Returns 0, or -1 when the span stack was too small.
#[allow(clippy::too_many_arguments)]
pub fn flood_shape(
    rgba: &mut [u8],
    w: usize,
    h: usize,
    sx: i32,
    sy: i32,
    tol: i32,
    contiguous: bool,
    sel: Option<&[u8]>,
    color: [u8; 3],
    stack: &mut [u32],
    info: &mut [i32],
) -> i32 {
    let n = w * h;
    let mut mask = vec![0u8; n];
    if flood::flood(rgba, w, h, sx, sy, tol, contiguous, &mut mask, stack) < 0 {
        return -1;
    }
    if let Some(sel) = sel {
        for (m, p) in mask.iter_mut().zip(sel.chunks_exact(4)) {
            if p[3] < 128 {
                *m = 0;
            }
        }
    }
    let out = &mut rgba[..n * 4];
    let px = [color[0], color[1], color[2], 255];
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
    let mut count = 0usize;
    for (y, (mrow, orow)) in mask.chunks_exact(w).zip(out.chunks_exact_mut(w * 4)).enumerate() {
        let mut first = usize::MAX;
        let mut last = 0usize;
        for (x, (&m, o)) in mrow.iter().zip(orow.chunks_exact_mut(4)).enumerate() {
            if m != 0 {
                o.copy_from_slice(&px);
                count += 1;
                if first == usize::MAX {
                    first = x;
                }
                last = x;
            } else {
                o.copy_from_slice(&[0, 0, 0, 0]);
            }
        }
        if first != usize::MAX {
            x0 = x0.min(first);
            x1 = x1.max(last + 1);
            if y < y0 {
                y0 = y;
            }
            y1 = y + 1;
        }
    }
    info[0] = count as i32;
    if count == 0 {
        info[1..5].copy_from_slice(&[0, 0, -1, 0]);
    } else {
        info[1..5].copy_from_slice(&[x0 as i32, y0 as i32, x1 as i32, y1 as i32]);
    }
    0
}
