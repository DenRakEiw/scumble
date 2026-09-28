//! The healing brush's solver (docs/PLAN_0_1_31.md §5 step 1): a gradient-domain (Poisson) blend over a box.
//!
//! The healed pixels are `f = src + u`, where `src` is the patch the brush clones and `u` a correction membrane: per
//! RGB channel `u` is harmonic where the stroke covers (`mask` > 0) and equals `dst - src` on the pixels around it.
//! That is the discrete Poisson blend with the source's gradients as the guide, the destination as the boundary. The
//! cells of the box:
//!
//!   UNKNOWN  mask > 0
//!   FIXED    mask 0, dst and src at least `MIN_ALPHA` in alpha: u = dst - src there (Dirichlet; a nearly clear
//!            pixel's straight colour is too coarse to hold the boundary)
//!   NONE     anything else, and outside the box: left out of its neighbours' equations (Neumann)
//!
//! At every unknown p, per channel: n_p u_p - sum of u_q over its 4-neighbours q that are not NONE = 0, n_p their
//! count. Geometric multigrid: a coarse cell covers 2 x 2 children and is FIXED when a child is, else UNKNOWN when a
//! child is, else NONE (the boundary has to survive coarsening: with UNKNOWN first, a coarse grid of unknowns between
//! Neumann edges was singular and the cycles diverged, 18 times the error a cycle), down to 3 x 3 or the last grid with
//! unknowns. A V-cycle: two red-black Gauss-Seidel sweeps, the residual restricted as the sum of the children (the
//! spacing doubles), the coarser grids in turn (the coarsest takes 40 sweeps), the correction interpolated bilinearly
//! (9 3 3 1 / 16; a NONE neighbour mirrors the parent, a FIXED one is 0) and scaled per channel by the step that
//! minimises the error's energy along it (alpha = r.c / c.Ac, 0..4: a coarse grid whose boundary moved inward corrects
//! too little, up to 2.6 times on a thin diagonal stroke), two sweeps after. The start is full multigrid: every coarse
//! grid first holds the problem itself (the mean of its children), the coarsest is solved, and each finer grid starts
//! from the one below and gets a V-cycle. Then V-cycles until no update at the finest level moved a value by `TOL`,
//! `MAX_CYCLES` at most; info[3] is 1 when they ran out first (the caller keeps what it had: a heal the source's
//! transparency splits into thin strands is one domain on the coarse grids and does not settle). Measured against an
//! f64 reference in tools/px_test.js: within a level, 4 to 8 cycles.
//!
//! Values are stored as f32 and computed in f64, in one fixed order with no fused operations (as `edt.rs`), so the JS
//! twin (`poissonBlend` in renderer/editor/px/kernels_js.js) and both builds give the same bytes (tools/px_test.js).
//! Fixed-point integers would stall: rounding each update biases a Laplace solve by the domain's size squared.
//!
//! A region of unknowns that touches no FIXED cell (walled in by transparency, or the whole box) keeps the start.
//!
//! out: where mask > 0, RGB = clamp(floor(src + u + 0.5)) with src's alpha (0 0 0 0 where src is transparent);
//! elsewhere dst's bytes.

const NONE: u8 = 0;
const FIXED: u8 = 1;
const UNKNOWN: u8 = 2;
/// An unknown whose 4-connected region touches no FIXED cell: the problem is singular there, so the region keeps the
/// start and stays out of the solve (on the coarse grids it would take corrections from a region next to it).
const FREE: u8 = 3;

/// `1 / n` for the neighbour counts 0..4 (an unknown without neighbours gets 0).
const INV: [f64; 5] = [0.0, 1.0, 0.5, 1.0 / 3.0, 0.25];

/// The largest update at the finest level that still asks for another cycle, in levels.
pub const TOL: f64 = 1.0 / 32.0;
pub const MAX_CYCLES: u32 = 30;
const PRE: u32 = 2;
const POST: u32 = 2;
const COARSEST: u32 = 40;
const MAX_LEVELS: usize = 24;
const ALPHA_MAX: f64 = 4.0;
/// The alpha both pictures need for a pixel to be boundary (FIXED); the quick heal's means use the same level.
pub const MIN_ALPHA: u8 = 8;

/// One grid: `w` x `h` cells inside a ring of NONE padding, so a cell's four neighbours are always in the arrays.
struct Level {
    w: usize,
    h: usize,
    stride: usize,
    cells: usize,
    state: Vec<u8>,
    /// Neighbours that are not NONE, for the unknown cells.
    nb: Vec<u8>,
    /// Three per cell: the membrane at the finest level; below it the problem while the start climbs, then corrections.
    u: Vec<f32>,
    /// Three per cell, the coarse levels' right-hand side; empty at the finest level (0 there).
    f: Vec<f32>,
    /// Three per cell, the coarse correction interpolated at the unknowns (every grid but the coarsest).
    cc: Vec<f32>,
    /// Runs of unknown cells, `x0, x1` pairs, row after row; `rows[y]..rows[y + 1]` are row y's pairs.
    spans: Vec<u32>,
    rows: Vec<u32>,
}

impl Level {
    fn new(w: usize, h: usize, coarse: bool) -> Level {
        let stride = w + 2;
        let cells = stride * (h + 2);
        Level {
            w,
            h,
            stride,
            cells,
            state: vec![NONE; cells],
            nb: vec![0; cells],
            u: vec![0.0; cells * 3],
            f: if coarse { vec![0.0; cells * 3] } else { Vec::new() },
            cc: Vec::new(),
            spans: Vec::new(),
            rows: Vec::new(),
        }
    }

    #[inline(always)]
    fn at(&self, x: usize, y: usize) -> usize {
        (y + 1) * self.stride + x + 1
    }

    /// Neighbour counts and the runs of unknown cells, once the states are set.
    fn finish(&mut self) {
        let s = self.stride;
        self.rows.push(0);
        for y in 0..self.h {
            let row = (y + 1) * s + 1;
            let mut x = 0;
            while x < self.w {
                if self.state[row + x] != UNKNOWN {
                    x += 1;
                    continue;
                }
                let x0 = x;
                while x < self.w && self.state[row + x] == UNKNOWN {
                    let i = row + x;
                    let n = (self.state[i - 1] != NONE) as u8 + (self.state[i + 1] != NONE) as u8 + (self.state[i - s] != NONE) as u8 + (self.state[i + s] != NONE) as u8;
                    self.nb[i] = n;
                    x += 1;
                }
                self.spans.push(x0 as u32);
                self.spans.push(x as u32);
            }
            self.rows.push((self.spans.len() / 2) as u32);
        }
    }

    /// The next coarser grid; each cell's values are the mean of its children of its own kind (the boundary the start
    /// solves against).
    fn coarser(&self) -> Level {
        let (w1, h1) = ((self.w + 1) >> 1, (self.h + 1) >> 1);
        let mut c = Level::new(w1, h1, true);
        for y1 in 0..h1 {
            for x1 in 0..w1 {
                let mut st = NONE;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let (x, y) = (2 * x1 + dx, 2 * y1 + dy);
                        if x < self.w && y < self.h {
                            let v = self.state[self.at(x, y)];
                            if v == FIXED || (v == UNKNOWN && st == NONE) {
                                st = v;
                            }
                        }
                    }
                }
                let j = c.at(x1, y1);
                c.state[j] = st;
                if st == NONE {
                    continue;
                }
                let mut acc = [0.0f64; 3];
                let mut n = 0usize;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let (x, y) = (2 * x1 + dx, 2 * y1 + dy);
                        if x >= self.w || y >= self.h {
                            continue;
                        }
                        let i = self.at(x, y);
                        if self.state[i] != st {
                            continue;
                        }
                        for ch in 0..3 {
                            acc[ch] += self.u[3 * i + ch] as f64;
                        }
                        n += 1;
                    }
                }
                for ch in 0..3 {
                    c.u[3 * j + ch] = (acc[ch] / n as f64) as f32;
                }
            }
        }
        c.finish();
        c
    }
}

/// An f32 of a grid as f64 without the bounds check (every caller's index is a cell of the padded grid).
#[inline(always)]
unsafe fn ld(a: &[f32], i: usize) -> f64 {
    *a.get_unchecked(i) as f64
}

/// One colour of a red-black Gauss-Seidel sweep; the largest update when `track`.
fn sweep(lv: &mut Level, color: usize, track: bool) -> f64 {
    let s = lv.stride;
    let coarse = !lv.f.is_empty();
    let (u, f, nb, spans, rows) = (&mut lv.u[..], &lv.f[..], &lv.nb[..], &lv.spans[..], &lv.rows[..]);
    let mut mx = 0.0f64;
    for y in 0..lv.h {
        let row = (y + 1) * s + 1;
        for k in rows[y] as usize..rows[y + 1] as usize {
            let (x0, x1) = (spans[2 * k] as usize, spans[2 * k + 1] as usize);
            let mut x = x0 + ((x0 + y + color) & 1);
            while x < x1 {
                let i = row + x;
                // SAFETY: an unknown cell lies inside the padding ring, so i +- 1 and i +- s are cells of the grid
                unsafe {
                    let n = *INV.get_unchecked(*nb.get_unchecked(i) as usize);
                    for c in 0..3 {
                        let sum = ld(u, 3 * (i - 1) + c) + ld(u, 3 * (i + 1) + c) + ld(u, 3 * (i - s) + c) + ld(u, 3 * (i + s) + c);
                        let fv = if coarse { ld(f, 3 * i + c) } else { 0.0 };
                        let v = (fv + sum) * n;
                        if track {
                            let d = (v - ld(u, 3 * i + c)).abs();
                            if d > mx {
                                mx = d;
                            }
                        }
                        *u.get_unchecked_mut(3 * i + c) = v as f32;
                    }
                }
                x += 2;
            }
        }
    }
    mx
}

/// The fine grid's residual summed over each coarse cell's children into the coarse right-hand side; the coarse
/// correction starts at 0.
fn restrict(fine: &Level, c: &mut Level) {
    let s = fine.stride;
    let coarse = !fine.f.is_empty();
    let (fu, ff) = (&fine.u[..], &fine.f[..]);
    for y1 in 0..c.h {
        for k in c.rows[y1] as usize..c.rows[y1 + 1] as usize {
            for x1 in c.spans[2 * k] as usize..c.spans[2 * k + 1] as usize {
                let mut acc = [0.0f64; 3];
                for dy in 0..2 {
                    for dx in 0..2 {
                        let (x, y) = (2 * x1 + dx, 2 * y1 + dy);
                        if x >= fine.w || y >= fine.h {
                            continue;
                        }
                        let i = fine.at(x, y);
                        if fine.state[i] != UNKNOWN {
                            continue;
                        }
                        let n = fine.nb[i] as f64;
                        for ch in 0..3 {
                            let sum = fu[3 * (i - 1) + ch] as f64 + fu[3 * (i + 1) + ch] as f64 + fu[3 * (i - s) + ch] as f64 + fu[3 * (i + s) + ch] as f64;
                            let fv = if coarse { ff[3 * i + ch] as f64 } else { 0.0 };
                            acc[ch] += (fv + sum) - n * fu[3 * i + ch] as f64;
                        }
                    }
                }
                let j = c.at(x1, y1);
                for ch in 0..3 {
                    c.f[3 * j + ch] = acc[ch] as f32;
                    c.u[3 * j + ch] = 0.0;
                }
            }
        }
    }
}

/// The coarse grid bilinearly at the fine grid's unknowns into `into` (3 a cell of the fine grid); a NONE neighbour
/// mirrors the parent.
fn interp(c: &Level, fine: &Level, into: &mut [f32]) {
    let cs = c.stride;
    let (cu, cst) = (&c.u[..], &c.state[..]);
    for y in 0..fine.h {
        let row = (y + 1) * fine.stride + 1;
        // the coarse rows of the parent and of the nearer other neighbour, in padded coordinates
        let py = (y >> 1) + 1;
        let vy = if y & 1 == 1 { py + 1 } else { py - 1 };
        for k in fine.rows[y] as usize..fine.rows[y + 1] as usize {
            for x in fine.spans[2 * k] as usize..fine.spans[2 * k + 1] as usize {
                let px = (x >> 1) + 1;
                let hx = if x & 1 == 1 { px + 1 } else { px - 1 };
                let p = py * cs + px;
                let (hh, vv, dd) = (py * cs + hx, vy * cs + px, vy * cs + hx);
                let i = row + x;
                for ch in 0..3 {
                    let ep = cu[3 * p + ch] as f64;
                    let eh = if cst[hh] == NONE { ep } else { cu[3 * hh + ch] as f64 };
                    let ev = if cst[vv] == NONE { ep } else { cu[3 * vv + ch] as f64 };
                    let ed = if cst[dd] == NONE { ep } else { cu[3 * dd + ch] as f64 };
                    into[3 * i + ch] = ((9.0 * ep + 3.0 * eh + 3.0 * ev + ed) * 0.0625) as f32;
                }
            }
        }
    }
}

/// The coarse correction added to the fine grid, scaled per channel by the energy-minimising step; the fine grid's `cc`
/// holds the interpolated correction (0 outside the unknowns, which is all it ever writes). The largest change when
/// `track`.
fn correct(c: &Level, fine: &mut Level, track: bool) -> f64 {
    let s = fine.stride;
    let coarse = !fine.f.is_empty();
    let mut cc = core::mem::take(&mut fine.cc);
    interp(c, fine, &mut cc);
    let mut rc = [0.0f64; 3];
    let mut cac = [0.0f64; 3];
    {
        let (fu, ff) = (&fine.u[..], &fine.f[..]);
        for y in 0..fine.h {
            let row = (y + 1) * s + 1;
            for k in fine.rows[y] as usize..fine.rows[y + 1] as usize {
                for x in fine.spans[2 * k] as usize..fine.spans[2 * k + 1] as usize {
                    let i = row + x;
                    let n = fine.nb[i] as f64;
                    // SAFETY: as in `sweep`
                    unsafe {
                        for ch in 0..3 {
                            let sum = ld(fu, 3 * (i - 1) + ch) + ld(fu, 3 * (i + 1) + ch) + ld(fu, 3 * (i - s) + ch) + ld(fu, 3 * (i + s) + ch);
                            let fv = if coarse { ld(ff, 3 * i + ch) } else { 0.0 };
                            let r = (fv + sum) - n * ld(fu, 3 * i + ch);
                            let ci = ld(&cc, 3 * i + ch);
                            let ac = n * ci - (ld(&cc, 3 * (i - 1) + ch) + ld(&cc, 3 * (i + 1) + ch) + ld(&cc, 3 * (i - s) + ch) + ld(&cc, 3 * (i + s) + ch));
                            rc[ch] += r * ci;
                            cac[ch] += ci * ac;
                        }
                    }
                }
            }
        }
    }
    let mut al = [0.0f64; 3];
    for ch in 0..3 {
        if cac[ch] > 0.0 {
            let a = rc[ch] / cac[ch];
            al[ch] = if a <= 0.0 { 0.0 } else if a >= ALPHA_MAX { ALPHA_MAX } else { a };
        }
    }
    let mut mx = 0.0f64;
    let fu = &mut fine.u[..];
    for y in 0..fine.h {
        let row = (y + 1) * s + 1;
        for k in fine.rows[y] as usize..fine.rows[y + 1] as usize {
            for x in fine.spans[2 * k] as usize..fine.spans[2 * k + 1] as usize {
                let i = row + x;
                for ch in 0..3 {
                    let e = al[ch] * cc[3 * i + ch] as f64;
                    if track {
                        let d = e.abs();
                        if d > mx {
                            mx = d;
                        }
                    }
                    fu[3 * i + ch] = (fu[3 * i + ch] as f64 + e) as f32;
                }
            }
        }
    }
    fine.cc = cc;
    mx
}

/// One V-cycle with `levels[top]` as its finest grid; the largest update at level 0.
fn vcycle(levels: &mut [Level], top: usize) -> f64 {
    let n = levels.len();
    let mut mx = 0.0f64;
    for l in top..n - 1 {
        for _ in 0..PRE {
            for color in 0..2 {
                let m = sweep(&mut levels[l], color, l == 0);
                if m > mx {
                    mx = m;
                }
            }
        }
        let (a, b) = levels.split_at_mut(l + 1);
        restrict(&a[l], &mut b[0]);
    }
    for _ in 0..COARSEST {
        for color in 0..2 {
            let m = sweep(&mut levels[n - 1], color, n == 1);
            if m > mx {
                mx = m;
            }
        }
    }
    for l in (top..n - 1).rev() {
        let (a, b) = levels.split_at_mut(l + 1);
        let m = correct(&b[0], &mut a[l], l == 0);
        if m > mx {
            mx = m;
        }
        for _ in 0..POST {
            for color in 0..2 {
                let m = sweep(&mut levels[l], color, l == 0);
                if m > mx {
                    mx = m;
                }
            }
        }
    }
    mx
}

/// Marks FREE every 4-connected region of unknowns that has no FIXED neighbour (a scan, then a flood per region from
/// its first cell in row order).
fn free_regions(lv: &mut Level) {
    let s = lv.stride;
    let mut seen = vec![false; lv.cells];
    let mut stack: Vec<usize> = Vec::new();
    let mut region: Vec<usize> = Vec::new();
    for y in 0..lv.h {
        for x in 0..lv.w {
            let i0 = lv.at(x, y);
            if lv.state[i0] != UNKNOWN || seen[i0] {
                continue;
            }
            let mut anchored = false;
            region.clear();
            stack.push(i0);
            seen[i0] = true;
            while let Some(i) = stack.pop() {
                region.push(i);
                for j in [i - 1, i + 1, i - s, i + s] {
                    let v = lv.state[j];
                    if v == FIXED {
                        anchored = true;
                    } else if v == UNKNOWN && !seen[j] {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
            if !anchored {
                for &i in &region {
                    lv.state[i] = FREE;
                }
            }
        }
    }
}

/// The blend over a `w` x `h` box: `dst` and `src` straight RGBA8, `mask` a byte per pixel, `out` RGBA8, `info` gets
/// the unknowns, the cycles run, the levels and 1 when the cycles ran out before the blend settled. Returns the unknowns.
pub fn poisson_blend(dst: &[u8], src: &[u8], mask: &[u8], w: usize, h: usize, out: &mut [u8], info: &mut [i32]) -> i32 {
    for v in info.iter_mut() {
        *v = 0;
    }
    if w == 0 || h == 0 {
        return 0;
    }
    let mut top = Level::new(w, h, false);
    let mut unknowns = 0usize;
    for y in 0..h {
        for x in 0..w {
            let k = y * w + x;
            let i = top.at(x, y);
            if mask[k] > 0 {
                top.state[i] = UNKNOWN;
                unknowns += 1;
            } else if dst[4 * k + 3] >= MIN_ALPHA && src[4 * k + 3] >= MIN_ALPHA {
                top.state[i] = FIXED;
                for c in 0..3 {
                    top.u[3 * i + c] = dst[4 * k + c] as f32 - src[4 * k + c] as f32;
                }
            }
        }
    }
    if unknowns == 0 {
        out[..w * h * 4].copy_from_slice(&dst[..w * h * 4]);
        return 0;
    }
    let s = top.stride;
    free_regions(&mut top);
    top.finish();
    // unknowns start at the mean of the fixed cells beside one
    let mut acc = [0.0f64; 3];
    let mut count = 0usize;
    for y in 0..h {
        for x in 0..w {
            let i = top.at(x, y);
            if top.state[i] == FIXED && (top.state[i - 1] == UNKNOWN || top.state[i + 1] == UNKNOWN || top.state[i - s] == UNKNOWN || top.state[i + s] == UNKNOWN) {
                for c in 0..3 {
                    acc[c] += top.u[3 * i + c] as f64;
                }
                count += 1;
            }
        }
    }
    if count > 0 {
        let mut start = [0.0f32; 3];
        for c in 0..3 {
            start[c] = (acc[c] / count as f64) as f32;
        }
        for y in 0..h {
            for x in 0..w {
                let i = top.at(x, y);
                if top.state[i] == UNKNOWN || top.state[i] == FREE {
                    top.u[3 * i..3 * i + 3].copy_from_slice(&start);
                }
            }
        }
    }
    let solve = !top.spans.is_empty();
    let mut levels = vec![top];
    while levels.len() < MAX_LEVELS {
        let last = &levels[levels.len() - 1];
        if last.w <= 3 && last.h <= 3 {
            break;
        }
        let next = last.coarser();
        if next.spans.is_empty() {
            break;
        }
        levels.push(next);
    }
    let n = levels.len();
    for l in 0..n - 1 {
        levels[l].cc = vec![0.0; levels[l].cells * 3];
    }
    // the start (full multigrid): the coarsest grid solved, each finer one from the one below plus a V-cycle, after
    // which the grid below holds corrections (a fixed cell's correction is 0)
    let mut cycles = 0u32;
    let mut last = if solve { f64::INFINITY } else { 0.0 };
    if solve && n > 1 {
        for _ in 0..COARSEST {
            for color in 0..2 {
                sweep(&mut levels[n - 1], color, false);
            }
        }
        for l in (0..n - 1).rev() {
            {
                let (a, b) = levels.split_at_mut(l + 1);
                let fine = &mut a[l];
                let mut u = core::mem::take(&mut fine.u);
                interp(&b[0], fine, &mut u);
                fine.u = u;
                for v in b[0].u.iter_mut() {
                    *v = 0.0;
                }
            }
            let m = vcycle(&mut levels, l);
            if l == 0 {
                cycles = 1;
                last = m;
            }
        }
    }
    while cycles < MAX_CYCLES && !(last < TOL) {
        cycles += 1;
        last = vcycle(&mut levels, 0);
    }
    let top = &levels[0];
    for y in 0..h {
        for x in 0..w {
            let k = y * w + x;
            let o = 4 * k;
            let i = top.at(x, y);
            if top.state[i] != UNKNOWN && top.state[i] != FREE {
                out[o..o + 4].copy_from_slice(&dst[o..o + 4]);
                continue;
            }
            let a = src[o + 3];
            if a == 0 {
                out[o..o + 4].copy_from_slice(&[0, 0, 0, 0]);
                continue;
            }
            for c in 0..3 {
                let v = (src[o + c] as f64 + top.u[3 * i + c] as f64 + 0.5).floor();
                out[o + c] = if v <= 0.0 { 0 } else if v >= 255.0 { 255 } else { v as u8 };
            }
            out[o + 3] = a;
        }
    }
    if info.len() >= 4 {
        info[0] = unknowns as i32;
        info[1] = cycles as i32;
        info[2] = n as i32;
        info[3] = if last < TOL { 0 } else { 1 };
    }
    unknowns as i32
}
