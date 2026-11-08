//! Pixel kernels for Scumble's tile engine, compiled to `wasm32-unknown-unknown`.
//!
//! No wasm-bindgen: every export is a plain `extern "C"` function over linear memory and
//! the module is loaded with `WebAssembly.instantiate` (`renderer/editor/px/px.js`).
//! `docs/PLAN_BCE.md` §1 has the contract:
//!
//! - `px_alloc(bytes) -> ptr` and `px_free(ptr, bytes)` over std's allocator (dlmalloc);
//!   every block is 8-aligned, so a pointer serves `u8`, `u32` and `f32` buffers alike, and
//!   blocks of 16 KB and more start on a 4 KB page boundary (see `align_for`).
//! - Every kernel is pure over its arguments: no globals, no allocation inside (the caller
//!   allocates in and out buffers), so one instance per worker can run any of them. The
//!   whole-job kernels (`grow_mask`, `flood_shape`) allocate their scratch inside.
//! - Memory can grow during `px_alloc`; the JS side re-creates its views afterwards.
//!
//! Each kernel has a JS twin of the same shape in `renderer/editor/px/kernels_js.js` that
//! gives the same bytes; `tools/px_test.js` holds them to it.

use core::slice;
use std::alloc::{alloc, dealloc, Layout};

mod cmatch;
mod composite;
mod edges;
mod edt;
mod flood;
mod jobs;
mod maskf;
mod mip;
mod png;
mod poisson;
mod psd;
mod relight;
mod resample;
mod sel;
mod smudge;
mod stroke;

/// dlmalloc hands out a page start plus its 8-byte header, while a JS ArrayBuffer of tile
/// size starts on a page. A copy between the two then has its destination 8 bytes past the
/// source modulo 4096, which is 4K aliasing: measured 56 to 66 µs for 256 KB against 3.5 µs
/// (Node 24 and Electron 44 alike). Page-aligned blocks avoid it.
fn align_for(bytes: usize) -> usize {
    if bytes >= 16 * 1024 { 4096 } else { 8 }
}

/// Bumped whenever an export changes its signature or learns a new op (20: height_normals, shadow_march height convention;
/// 21: sel_combine; 22: blur_rgba, sharpen_rgba, dab_scratch_bytes; 23: tone_rgba, sponge_rgba, freq_split;
/// 24: liquify_block; 25: alpha_to_mask, mask_max_clamp, mask_one_minus, erode_mask, mask_to_rgba, mask_bounds_f32;
/// 26: color_match_rgba, blend_alpha);
/// `px.js` refuses a module it does not know.
#[no_mangle]
pub extern "C" fn px_abi_version() -> u32 {
    26
}

/// 1 when this build uses WASM SIMD128, 0 for the scalar build.
#[no_mangle]
pub extern "C" fn px_simd() -> u32 {
    if cfg!(target_feature = "simd128") { 1 } else { 0 }
}

/// A block of `bytes` bytes, 8-aligned, uninitialised; null when `bytes` is 0 or memory
/// cannot grow any further.
#[no_mangle]
pub extern "C" fn px_alloc(bytes: usize) -> *mut u8 {
    if bytes == 0 {
        return core::ptr::null_mut();
    }
    match Layout::from_size_align(bytes, align_for(bytes)) {
        Ok(layout) => unsafe { alloc(layout) },
        Err(_) => core::ptr::null_mut(),
    }
}

/// Give back a block from `px_alloc`; `bytes` must be the size it was allocated with.
#[no_mangle]
pub unsafe extern "C" fn px_free(ptr: *mut u8, bytes: usize) {
    if ptr.is_null() || bytes == 0 {
        return;
    }
    dealloc(ptr, Layout::from_size_align_unchecked(bytes, align_for(bytes)));
}

// ---- mips -------------------------------------------------------------------------------

/// `src` RGBA8 (sw × sh, straight alpha) halved into `dst` ((sw / 2) × (sh / 2)).
#[no_mangle]
pub unsafe extern "C" fn mip_half(src: *const u8, sw: usize, sh: usize, dst: *mut u8) {
    let (ow, oh) = (sw / 2, sh / 2);
    mip::mip_half(slice::from_raw_parts(src, sw * sh * 4), sw, sh, slice::from_raw_parts_mut(dst, ow * oh * 4));
}

/// Bytes `mip_chain` writes for a square tile of `size` and `levels` levels.
#[no_mangle]
pub extern "C" fn mip_chain_bytes(size: usize, levels: usize) -> usize {
    mip::chain_bytes(size, levels)
}

/// The `levels` mips of a square RGBA8 tile of `size`, largest first, one after the other.
#[no_mangle]
pub unsafe extern "C" fn mip_chain(src: *const u8, size: usize, levels: usize, out: *mut u8) {
    mip::mip_chain(slice::from_raw_parts(src, size * size * 4), size, levels, slice::from_raw_parts_mut(out, mip::chain_bytes(size, levels)));
}

/// Clamp-extend a square RGBA8 tile of `size` in place from its valid part `vw` × `vh`.
#[no_mangle]
pub unsafe extern "C" fn clamp_extend(bytes: *mut u8, size: usize, vw: usize, vh: usize) {
    mip::clamp_extend(slice::from_raw_parts_mut(bytes, size * size * 4), size, vw, vh);
}

// ---- distance transform -----------------------------------------------------------------

#[no_mangle]
pub extern "C" fn dist_scratch_bytes(w: usize, h: usize) -> usize {
    edt::scratch_bytes(w, h)
}

/// Squared distance to the nearest non-zero byte of `feature` (w × h) into `out` (f32).
#[no_mangle]
pub unsafe extern "C" fn dist_transform(feature: *const u8, w: usize, h: usize, out: *mut f32, scratch: *mut u8) {
    edt::dist_transform(
        slice::from_raw_parts(feature, w * h),
        w,
        h,
        slice::from_raw_parts_mut(out, w * h),
        slice::from_raw_parts_mut(scratch, edt::scratch_bytes(w, h)),
    );
}

// ---- PNG rows read (the stream reader) -----------------------------------------------------

/// Undo the row filters of `rows` lines (a filter byte and `row_bytes` bytes each) in place; `prev` is the row above and
/// becomes the last row. With `channels` 3 or 4 (8-bit RGB / RGBA, `w` pixels) the rows also go to `out` as RGBA8; with
/// 0 `out` is not touched. Returns the lines undone: fewer than `rows` when a line has an unknown filter type.
#[no_mangle]
pub unsafe extern "C" fn png_unfilter_rows(lines: *mut u8, rows: usize, row_bytes: usize, bpp: usize, prev: *mut u8, w: usize, channels: usize, out: *mut u8) -> usize {
    let l = slice::from_raw_parts_mut(lines, rows * (row_bytes + 1));
    let done = png::unfilter_rows(l, rows, row_bytes, bpp, slice::from_raw_parts_mut(prev, row_bytes));
    if done == rows && (channels == 3 || channels == 4) {
        png::lines_to_rgba(l, rows, w, channels, slice::from_raw_parts_mut(out, rows * w * 4));
    }
    done
}

// ---- float masks (a provider run's crop and stitch) --------------------------------------

/// The alpha channel of `n` RGBA8 pixels (`rgba`, `n * 4` bytes) as a 0..1 float mask (`dst`, `n` f32):
/// `((rgba[i * 4 + 3] as f64) / 255.0) as f32`.
#[no_mangle]
pub unsafe extern "C" fn alpha_to_mask(rgba: *const u8, dst: *mut f32, n: usize) {
    if n == 0 || rgba.is_null() || dst.is_null() {
        return;
    }
    maskf::alpha_to_mask(slice::from_raw_parts(rgba, n * 4), slice::from_raw_parts_mut(dst, n));
}

/// Element-wise `Math.max(a[i], b[i])` (when `b` is not null) and/or `Math.min(1, Math.max(0, x))` (when `clamp != 0`)
/// over `n` floats into `dst`. `dst` may alias `a`, never `b`.
#[no_mangle]
pub unsafe extern "C" fn mask_max_clamp(a: *const f32, b: *const f32, dst: *mut f32, n: usize, clamp: u32) {
    if n == 0 || a.is_null() || dst.is_null() {
        return;
    }
    if a != dst as *const f32 {
        core::ptr::copy(a, dst, n);
    }
    let b = if b.is_null() { None } else { Some(slice::from_raw_parts(b, n)) };
    maskf::mask_max_clamp(slice::from_raw_parts_mut(dst, n), b, clamp != 0);
}

/// `1.0 - src[i]` for `n` floats into `dst` (`dst` may alias `src`).
#[no_mangle]
pub unsafe extern "C" fn mask_one_minus(src: *const f32, dst: *mut f32, n: usize) {
    if n == 0 || src.is_null() || dst.is_null() {
        return;
    }
    if src != dst as *const f32 {
        core::ptr::copy(src, dst, n);
    }
    maskf::mask_one_minus(slice::from_raw_parts_mut(dst, n));
}

/// Square dilation of a w x h mask of f32 by `r` pixels, in place, never below 0 (a whole job: it allocates its scratch).
#[no_mangle]
pub unsafe extern "C" fn dilate_mask(data: *mut f32, w: usize, h: usize, r: usize) {
    maskf::dilate(slice::from_raw_parts_mut(data, w * h), w, h, r);
}

/// Square erosion of a w x h mask of f32 by `r` pixels, in place (`1 - dilate(1 - m, r)` in f32).
#[no_mangle]
pub unsafe extern "C" fn erode_mask(data: *mut f32, w: usize, h: usize, r: usize) {
    if w == 0 || h == 0 || data.is_null() {
        return;
    }
    maskf::erode(slice::from_raw_parts_mut(data, w * h), w, h, r);
}

/// A float mask `src` (`n` f32) as RGBA8 bytes `dst` (`n * 4` bytes): `mode` 0 white `[255, 255, 255, v]`,
/// 1 luminance `[v, v, v, 255]`, 2 alpha `[0, 0, 0, src[i] > 0.5 ? 0 : 255]`.
#[no_mangle]
pub unsafe extern "C" fn mask_to_rgba(src: *const f32, dst: *mut u8, n: usize, mode: u32) {
    if n == 0 || src.is_null() || dst.is_null() {
        return;
    }
    maskf::mask_to_rgba(slice::from_raw_parts(src, n), slice::from_raw_parts_mut(dst, n * 4), mode);
}

/// Bounding box `[x0, y0, x1, y1]` (right and bottom exclusive, 4 i32 at `bounds`) of the pixels of `src` (`w` x `h` f32)
/// with `src[i] > 0.5`. Returns 1 when not empty, else 0.
#[no_mangle]
pub unsafe extern "C" fn mask_bounds_f32(src: *const f32, w: usize, h: usize, bounds: *mut i32) -> i32 {
    if w == 0 || h == 0 || src.is_null() || bounds.is_null() {
        return 0;
    }
    maskf::mask_bounds_f32(slice::from_raw_parts(src, w * h), w, h, slice::from_raw_parts_mut(bounds, 4))
}

/// Matches the weighted RGB mean and standard deviation of `patch` (`n * 4` RGBA8 bytes, in place) to `reference`
/// (`n * 4` RGBA8 bytes) under `weight` (`n` f32, `stitch.js` `colorMatch`). Leaves `patch` untouched and returns 0
/// when the clamped weight sum is below 64 (or `n == 0` or a pointer is null), else 1.
#[no_mangle]
pub unsafe extern "C" fn color_match_rgba(patch: *mut u8, reference: *const u8, weight: *const f32, n: usize) -> u32 {
    if n == 0 || patch.is_null() || reference.is_null() || weight.is_null() {
        return 0;
    }
    maskf::color_match_rgba(
        slice::from_raw_parts_mut(patch, n * 4),
        slice::from_raw_parts(reference, n * 4),
        slice::from_raw_parts(weight, n),
    )
}

/// The alpha byte of each RGBA8 pixel of `src` (`n * 4` bytes) replaced in `dst` (`n * 4` bytes, `dst` may alias `src`)
/// by `Math.round(clamp01(mask[i]) * (keep_alpha != 0 ? src[i * 4 + 3] : 255))` (`stitch.js` align copy and final alpha).
#[no_mangle]
pub unsafe extern "C" fn blend_alpha(src: *const u8, mask: *const f32, dst: *mut u8, n: usize, keep_alpha: u32) {
    if n == 0 || src.is_null() || mask.is_null() || dst.is_null() {
        return;
    }
    if src != dst as *const u8 {
        core::ptr::copy(src, dst, n * 4);
    }
    maskf::blend_alpha(slice::from_raw_parts_mut(dst, n * 4), slice::from_raw_parts(mask, n), keep_alpha != 0);
}

/// Box blurs of the radii `r0`, `r1`, `r2` (0: none), rows then columns each, in place with clamped edges.
#[no_mangle]
pub unsafe extern "C" fn box_blurs(data: *mut f32, w: usize, h: usize, r0: usize, r1: usize, r2: usize) {
    maskf::box_blurs(slice::from_raw_parts_mut(data, w * h), w, h, &[r0, r1, r2]);
}

// ---- the blur and sharpen brushes (K26) ----------------------------------------------------

/// The scratch `blur_rgba` and `sharpen_rgba` need for a w x h box, in bytes (8-aligned at its start): two f32 planes
/// of w * h * 4 and w * 4 f64 column sums; 0 when w or h is 0 or the size does not fit.
#[no_mangle]
pub extern "C" fn dab_scratch_bytes(w: usize, h: usize) -> usize {
    if w == 0 || h == 0 { return 0; }
    stroke::scratch_bytes(w, h).unwrap_or(0)
}

/// The scratch's three parts as slices: plane a, plane b, the sums. The caller checked `dab_scratch_bytes`.
unsafe fn dab_scratch<'a>(scratch: *mut u8, w: usize, h: usize) -> (&'a mut [f32], &'a mut [f32], &'a mut [f64]) {
    let n4 = w * h * 4;
    let a = slice::from_raw_parts_mut(scratch as *mut f32, n4);
    let b = slice::from_raw_parts_mut((scratch as *mut f32).add(n4), n4);
    let sums = slice::from_raw_parts_mut(scratch.add(n4 * 8) as *mut f64, w * 4);
    (a, b, sums)
}

/// `blurRGBA(src, w, h, r)` of `inpaint_stroke.js` from `src` into `out` (w * h * 4 bytes each, every byte of `out`
/// written), `r` already rounded as the twin rounds it; `scratch` holds `dab_scratch_bytes(w, h)` bytes. 1 done, 0
/// refused (w or h 0, a size that does not fit).
#[no_mangle]
pub unsafe extern "C" fn blur_rgba(src: *const u8, out: *mut u8, scratch: *mut u8, w: usize, h: usize, r: usize) -> u32 {
    if dab_scratch_bytes(w, h) == 0 { return 0; }
    let n4 = w * h * 4;
    let (a, b, sums) = dab_scratch(scratch, w, h);
    stroke::blur_rgba(slice::from_raw_parts(src, n4), slice::from_raw_parts_mut(out, n4), a, b, sums, w, h, r);
    1
}

/// `sharpenRGBA(src, w, h, r, amount)` of `inpaint_stroke.js`, as `blur_rgba`.
#[no_mangle]
pub unsafe extern "C" fn sharpen_rgba(src: *const u8, out: *mut u8, scratch: *mut u8, w: usize, h: usize, r: usize, amount: f64) -> u32 {
    if dab_scratch_bytes(w, h) == 0 { return 0; }
    let n4 = w * h * 4;
    let (a, b, sums) = dab_scratch(scratch, w, h);
    stroke::sharpen_rgba(slice::from_raw_parts(src, n4), slice::from_raw_parts_mut(out, n4), a, b, sums, w, h, r, amount);
    1
}

// ---- the tone brush, the sponge, frequency separation's split (K27) --------------------------------------------------

/// `n` bytes of RGBA8 a kernel below takes: at least one pixel, whole pixels, and its pointers set.
fn rgba_len(n: usize, ptrs: &[usize]) -> bool {
    n > 0 && n % 4 == 0 && ptrs.iter().all(|&p| p != 0)
}

/// `toneRGBA(src, lut, protect)` of `inpaint_stroke.js` from `src` into `out` (`n` bytes each, every byte of `out`
/// written), `lut` 256 bytes (the stroke's table, copied in with each call), `protect` 0 or 1. 1 done, 0 refused (`n`
/// not a positive multiple of 4, a null pointer).
#[no_mangle]
pub unsafe extern "C" fn tone_rgba(src: *const u8, out: *mut u8, n: usize, lut: *const u8, protect: u32) -> u32 {
    if !rgba_len(n, &[src as usize, out as usize, lut as usize]) { return 0; }
    let lut = &*(lut as *const [u8; 256]);
    stroke::tone_rgba(slice::from_raw_parts(src, n), slice::from_raw_parts_mut(out, n), lut, protect != 0);
    1
}

/// `spongeRGBA(src, amount, saturate, vibrance)` of `inpaint_stroke.js` from `src` into `out` (as `tone_rgba`); `k` the
/// amount as the twin clamps it (0..1), `flags` bit 0 saturate, bit 1 vibrance. 1 done, 0 refused.
#[no_mangle]
pub unsafe extern "C" fn sponge_rgba(src: *const u8, out: *mut u8, n: usize, k: f64, flags: u32) -> u32 {
    if !rgba_len(n, &[src as usize, out as usize]) { return 0; }
    stroke::sponge_rgba(slice::from_raw_parts(src, n), slice::from_raw_parts_mut(out, n), k, flags & 1 != 0, flags & 2 != 0);
    1
}

/// Frequency separation's split (`freqSplit` of `inpaint_stroke.js`): `src` the picture, `low` its blur (changed in
/// place), `high` the detail out, `n` bytes each (three separate blocks). 1 done, 0 refused.
#[no_mangle]
pub unsafe extern "C" fn freq_split(src: *const u8, low: *mut u8, high: *mut u8, n: usize) -> u32 {
    if !rgba_len(n, &[src as usize, low as usize, high as usize]) { return 0; }
    stroke::freq_split(slice::from_raw_parts(src, n), slice::from_raw_parts_mut(low, n), slice::from_raw_parts_mut(high, n));
    1
}

// ---- flood ------------------------------------------------------------------------------

/// Pixels similar to the seed into `out` (1 / 0); returns the count, or -1 when the span
/// stack (`stack_pairs` pairs of u32) was too small.
#[no_mangle]
pub unsafe extern "C" fn flood(
    rgba: *const u8,
    w: usize,
    h: usize,
    sx: i32,
    sy: i32,
    tol: i32,
    contiguous: u32,
    out: *mut u8,
    stack: *mut u32,
    stack_pairs: usize,
) -> i32 {
    flood::flood(
        slice::from_raw_parts(rgba, w * h * 4),
        w,
        h,
        sx,
        sy,
        tol,
        contiguous != 0,
        slice::from_raw_parts_mut(out, w * h),
        if stack.is_null() { &mut [] } else { slice::from_raw_parts_mut(stack, stack_pairs * 2) },
    )
}

// ---- whole jobs -------------------------------------------------------------------------

/// `growMask` plus the bounds of its result over the selection `d` (w × h RGBA8, in place); `bounds` (4 i32) is
/// written when the result is not empty. Returns 1 when something is selected, else 0.
#[no_mangle]
pub unsafe extern "C" fn grow_mask(d: *mut u8, w: usize, h: usize, n: i32, bounds: *mut i32) -> i32 {
    jobs::grow_mask(slice::from_raw_parts_mut(d, w * h * 4), w, h, n, slice::from_raw_parts_mut(bounds, 4))
}

/// The flood job: the region around (sx, sy) of `rgba`, clipped to `sel` (0 for none), drawn over `rgba` in the colour
/// `rgb` (0xRRGGBB); `info` (5 i32) gets count and bounds. Returns 0, or -1 when the stack was too small.
#[no_mangle]
pub unsafe extern "C" fn flood_shape(
    rgba: *mut u8,
    w: usize,
    h: usize,
    sx: i32,
    sy: i32,
    tol: i32,
    contiguous: u32,
    sel: *const u8,
    rgb: u32,
    stack: *mut u32,
    stack_pairs: usize,
    info: *mut i32,
) -> i32 {
    jobs::flood_shape(
        slice::from_raw_parts_mut(rgba, w * h * 4),
        w,
        h,
        sx,
        sy,
        tol,
        contiguous != 0,
        if sel.is_null() { None } else { Some(slice::from_raw_parts(sel, w * h * 4)) },
        [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8],
        slice::from_raw_parts_mut(stack, stack_pairs * 2),
        slice::from_raw_parts_mut(info, 5),
    )
}

// ---- resample (PLAN_0_1_31 §7, 23b) -----------------------------------------------------------

/// One block of destination pixels through an affine map (`resampleBlock` in `renderer/editor/inpaint_resample.js`):
/// `block` is bw x bh RGBA8 at (bx, by) in source pixels, `map` six f64 holding the map at 2^32 as exact integers,
/// `weights` the caller's table (`taps` integers per phase, 256 phases), `alpha` 1 for a mask (the alpha alone in
/// `rgb`, 0xBBGGRR), `rt` the canvas round-trip table or null. Writes vw x vh packed pixels to `out` for the
/// destination pixels from (x0, y0); returns how many have an alpha above 0.
#[no_mangle]
pub unsafe extern "C" fn resample_block(block: *const u8, bw: u32, bh: u32, bx: i32, by: i32, map: *const f64, weights: *const i32, taps: u32,
                                        alpha: u32, rgb: u32, rt: *const u8, out: *mut u8, x0: i32, y0: i32, vw: u32, vh: u32) -> u32 {
    let (bw, bh, vw, vh, taps) = (bw as usize, bh as usize, vw as usize, vh as usize, taps as usize);
    if bw < taps || bh < taps || vw == 0 || vh == 0 {
        return 0;
    }
    let m = slice::from_raw_parts(map, 6);
    let map = resample::Map { a: m[0] as i64, b: m[1] as i64, c: m[2] as i64, d: m[3] as i64, e: m[4] as i64, f: m[5] as i64 };
    let block = resample::Block { data: slice::from_raw_parts(block, bw * bh * 4), w: bw, h: bh, x: bx as i64, y: by as i64 };
    let weights = slice::from_raw_parts(weights, 256 * taps);
    let rt = if rt.is_null() { None } else { Some(slice::from_raw_parts(rt, 65536)) };
    let mut out = resample::Out { data: slice::from_raw_parts_mut(out, vw * vh * 4), x0: x0 as i64, y0: y0 as i64, w: vw, h: vh };
    resample::resample(&block, &map, weights, taps, alpha != 0, rgb, rt, &mut out)
}

/// One block of destination pixels through a liquify field (`liquifyBlock` in `renderer/editor/inpaint_liquify.js`, K28):
/// `block` is `bw` x `bh` straight RGBA8 at `(bx, by)`, `nodes` has `nodes_len` `i32`s (`nw` nodes a row from `(nx0, ny0)`
/// at grid step `s`), `weights` the 4-tap bicubic table (256 phases x 4 `i32`s), `rt` the canvas round-trip table or null.
/// Writes `vw` x `vh` packed pixels to `out` for destination pixels from `(x0, y0)`; returns how many have an alpha above 0.
#[no_mangle]
pub unsafe extern "C" fn liquify_block(
    block: *const u8,
    bw: u32,
    bh: u32,
    bx: i32,
    by: i32,
    nodes: *const i32,
    nodes_len: u32,
    nw: u32,
    nx0: i32,
    ny0: i32,
    s: u32,
    weights: *const i32,
    rt: *const u8,
    out: *mut u8,
    x0: i32,
    y0: i32,
    vw: u32,
    vh: u32,
) -> u32 {
    let (bw, bh, vw, vh, nw, nodes_len) = (bw as usize, bh as usize, vw as usize, vh as usize, nw as usize, nodes_len as usize);
    if bw < 4 || bh < 4 || vw == 0 || vh == 0 || nw < 2 || !matches!(s, 1 | 2 | 4 | 8) || block.is_null() || nodes.is_null() || weights.is_null() || out.is_null() {
        return 0;
    }
    let Some(need_block) = bw.checked_mul(bh).and_then(|n| n.checked_mul(4)) else { return 0 };
    let Some(need_out) = vw.checked_mul(vh).and_then(|n| n.checked_mul(4)) else { return 0 };
    let block = resample::Block { data: slice::from_raw_parts(block, need_block), w: bw, h: bh, x: bx as i64, y: by as i64 };
    let nodes = slice::from_raw_parts(nodes, nodes_len);
    let weights = slice::from_raw_parts(weights, 256 * 4);
    let rt = if rt.is_null() { None } else { Some(slice::from_raw_parts(rt, 65536)) };
    let mut out = resample::Out { data: slice::from_raw_parts_mut(out, need_out), x0: x0 as i64, y0: y0 as i64, w: vw, h: vh };
    resample::liquify(&block, nodes, nw, nx0, ny0, s, weights, rt, &mut out)
}

// ---- composite --------------------------------------------------------------------------

/// `n` sources over the tile `dst` (`px` pixels of RGBA8, straight alpha, in place).
/// `srcs` and `masks` are arrays of n u32 pointers (a mask pointer may be 0), `ops` and
/// `alphas` arrays of n bytes (0 source-over, 1 destination-out, 2 source-atop,
/// 3 destination-in, 4 copy, 5 to 23 the blend modes multiply, screen, overlay, darken,
/// lighten, soft-light, hard-light, difference, linear-light, exclusion, linear-dodge,
/// linear-burn, subtract, pin-light, hard-mix, colour-dodge, colour-burn, vivid-light,
/// divide; opacity 0..255).
#[no_mangle]
pub unsafe extern "C" fn composite_tile(dst: *mut u8, px: usize, n: usize, srcs: *const u32, ops: *const u8, alphas: *const u8, masks: *const u32) {
    let srcs = slice::from_raw_parts(srcs, n);
    let ops = slice::from_raw_parts(ops, n);
    let alphas = slice::from_raw_parts(alphas, n);
    let masks = if masks.is_null() { None } else { Some(slice::from_raw_parts(masks, n)) };
    let dst = slice::from_raw_parts_mut(dst, px * 4);
    composite::begin(dst);
    for i in 0..n {
        let mask = masks.and_then(|m| if m[i] == 0 { None } else { Some(slice::from_raw_parts(m[i] as *const u8, px)) });
        let layer = composite::Layer { src: slice::from_raw_parts(srcs[i] as *const u8, px * 4), op: ops[i], alpha: alphas[i], mask };
        composite::apply(dst, &layer);
    }
    composite::end(dst);
}

/// One smudge dab over `n` pixels (docs/PLAN_0_1_31.md §4 step 3, `smudge.rs`): `dst` straight RGBA8 written where
/// `mask` covers, `src` what is sampled (straight RGBA8), `carry` 4n premultiplied u16 carried from dab to dab,
/// `strength` and `keep` 0..65536, `flags` 1 alpha lock, 2 pickup only (the first dab).
#[no_mangle]
pub unsafe extern "C" fn smudge_dab(dst: *mut u8, src: *const u8, carry: *mut u16, mask: *const u8, n: usize, strength: u32, keep: u32, flags: u32) {
    smudge::smudge_dab(slice::from_raw_parts_mut(dst, n * 4), slice::from_raw_parts(src, n * 4), slice::from_raw_parts_mut(carry, n * 4), slice::from_raw_parts(mask, n), strength, keep, flags);
}

/// The healing brush's Poisson blend over a `w` x `h` box (docs/PLAN_0_1_31.md §5 step 1, `poisson.rs`): `dst` the
/// picture before the stroke and `src` the cloned patch (straight RGBA8), `mask` a byte per pixel (> 0: heal there),
/// `out` RGBA8 (may not alias the inputs), `info` 4 i32 or 0: the pixels healed, the V-cycles, the levels, and 1 when
/// the cycles ran out before it settled. A whole job: it allocates its grids. Returns the pixels healed.
#[no_mangle]
pub unsafe extern "C" fn poisson_blend(dst: *const u8, src: *const u8, mask: *const u8, w: usize, h: usize, out: *mut u8, info: *mut i32) -> i32 {
    let n = w * h;
    let mut none = [0i32; 4];
    let info = if info.is_null() { &mut none[..] } else { slice::from_raw_parts_mut(info, 4) };
    if n == 0 {
        return poisson::poisson_blend(&[], &[], &[], w, h, &mut [], info);
    }
    poisson::poisson_blend(slice::from_raw_parts(dst, n * 4), slice::from_raw_parts(src, n * 4), slice::from_raw_parts(mask, n), w, h, slice::from_raw_parts_mut(out, n * 4), info)
}

/// The colour match of a layer over `px` pixels of straight RGBA8, in place (B item 7 part 3): `params` are
/// meanS[3], meanT[3], scale[3], k as f32. Alpha and fully transparent pixels are untouched.
#[no_mangle]
pub unsafe extern "C" fn match_pixels(rgba: *mut u8, px: usize, params: *const f32) {
    cmatch::match_pixels(slice::from_raw_parts_mut(rgba, px * 4), slice::from_raw_parts(params, 10));
}

// ---- PNG --------------------------------------------------------------------------------

/// Filter `rows` rows of RGBA8 (`w` wide) into `out` (rows × (1 + 4w) bytes); `prev` is the
/// row above the first one, or 0. Returns the bytes written.
#[no_mangle]
pub unsafe extern "C" fn png_filter_rows(rgba: *const u8, w: usize, rows: usize, prev: *const u8, out: *mut u8) -> usize {
    let prev = if prev.is_null() { None } else { Some(slice::from_raw_parts(prev, w * 4)) };
    png::filter_rows(slice::from_raw_parts(rgba, w * 4 * rows), w, rows, prev, slice::from_raw_parts_mut(out, rows * (1 + 4 * w)))
}

/// Raw deflate of `len` bytes at `src` into `out` (`cap` bytes) at zlib `level` (0 to 10); every part but the `last`
/// ends on a sync flush. Returns the bytes written, or -1 when `cap` was too small.
#[no_mangle]
pub unsafe extern "C" fn deflate_part(src: *const u8, len: usize, level: i32, last: u32, out: *mut u8, cap: usize) -> isize {
    png::deflate_part(slice::from_raw_parts(src, len), level, last != 0, slice::from_raw_parts_mut(out, cap))
}

/// The Adler-32 of `len` bytes at `src`, continued from `start` (1 for a new checksum).
#[no_mangle]
pub unsafe extern "C" fn adler32(src: *const u8, len: usize, start: u32) -> u32 {
    png::adler32(slice::from_raw_parts(src, len), start)
}

// ---- PSD --------------------------------------------------------------------------------

/// Bytes `psd_pack_rows` needs in `out` for `rows` rows of `w` pixels.
#[no_mangle]
pub extern "C" fn psd_pack_rows_cap(w: usize, rows: usize) -> usize {
    psd::pack_rows_cap(w, rows)
}

/// PackBits of channel `channel` (0 to 3) of `rows` rows of RGBA8 (`w` wide): the packed rows into `out` (`cap` bytes),
/// each row's packed length as a big-endian u16 into `lens` (2 × rows bytes). Returns the bytes written, or -1.
#[no_mangle]
pub unsafe extern "C" fn psd_pack_rows(rgba: *const u8, w: usize, rows: usize, channel: usize, out: *mut u8, cap: usize, lens: *mut u8) -> isize {
    psd::pack_rows(slice::from_raw_parts(rgba, w * 4 * rows), w, rows, channel & 3, slice::from_raw_parts_mut(out, cap), slice::from_raw_parts_mut(lens, rows * 2))
}

// ---- edge & map kernels (PLAN_WASM #1) ----------------------------------------------------

/// Computes max - min over each texel's 4x4 block of a w x h Uint16Array.
#[no_mangle]
pub unsafe extern "C" fn range_max(src: *const u16, w: usize, h: usize, out: *mut u16) {
    edges::range_max(
        slice::from_raw_parts(src, w * h),
        w,
        h,
        slice::from_raw_parts_mut(out, w * h),
    );
}

// ---- relight kernels (PLAN_RELIGHT_BUILD.md sec 4.3) --------------------------------------

/// Surface normals from u16 height field: n = normalize(-dz/dx, -dz/dy, 1.0)
/// after Gaussian blur with sigma; packed as RGBA8 (n * 127.5 + 127.5, A=255).
#[no_mangle]
pub unsafe extern "C" fn height_normals(
    depth: *const u16,
    w: usize,
    h: usize,
    scale: f32,
    sigma: f32,
    out: *mut u8,
) {
    if depth.is_null() || out.is_null() || w == 0 || h == 0 {
        return;
    }
    relight::height_normals(
        slice::from_raw_parts(depth, w * h),
        w,
        h,
        scale,
        sigma,
        slice::from_raw_parts_mut(out, w * h * 4),
    );
}

/// Marches shadow rays through u16 depth height field.
/// Output is u8 visibility (0=shadow, 255=lit) for rows [row0 .. row0 + rows].
#[no_mangle]
pub unsafe extern "C" fn shadow_march(
    depth: *const u16,
    w: usize,
    h: usize,
    scale: f32,
    light: *const f32,
    radius: f32,
    taps: u32,
    steps: u32,
    bias: f32,
    row0: usize,
    rows: usize,
    out: *mut u8,
) {
    if depth.is_null() || light.is_null() || out.is_null() || w == 0 || h == 0 || row0 >= h {
        return;
    }
    let band_rows = rows.min(h - row0);
    relight::shadow_march(
        slice::from_raw_parts(depth, w * h),
        w,
        h,
        scale,
        slice::from_raw_parts(light, 4),
        radius,
        taps,
        steps,
        bias,
        row0,
        band_rows,
        slice::from_raw_parts_mut(out, w * band_rows),
    );
}



// ---- the selection (PLAN_WASM_BUILD.md §4.3, K5) ----------------------------------------------------------------------

/// One `size`² tile of the selection (RGBA8, straight alpha, in place) combined with an alpha source under `mode` (0
/// replace, 1 add, 2 subtract, 3 intersect: SEL_MODES; plus 8 when the tile is new: its old alpha is taken as 0 and all
/// of it is written), the colour `rgb` (0xRRGGBB) on what is covered. `src` is the source region's first pixel and
/// `src_stride` its row in pixels, `src_kind` 1 one alpha byte a pixel or 4 RGBA8; 0 (nothing covered) and 2 (all of it)
/// read no buffer. Only `bw` x `bh` pixels from the tile's corner are combined (`sel.rs`). Returns 1 when the tile holds
/// a pixel afterwards and writes its extent (x0, y0, x1, y1: 4 i32) to `ext`, 0 when it holds none, 2 for arguments out
/// of range (nothing written).
#[no_mangle]
pub unsafe extern "C" fn sel_combine(dst: *mut u8, size: usize, src: *const u8, src_stride: usize, src_kind: u32, bw: usize, bh: usize, mode: u32, rgb: u32, ext: *mut i32) -> u32 {
    if dst.is_null() || ext.is_null() || size == 0 || size > 4096 || bw > size || bh > size {
        return sel::REFUSED;
    }
    let need = match sel::source_bytes(src_kind, src_stride, bw, bh) {
        Some(n) => n,
        None => return sel::REFUSED,
    };
    if need > 0 && src.is_null() {
        return sel::REFUSED;
    }
    let src = if need == 0 { &[][..] } else { slice::from_raw_parts(src, need) };
    sel::sel_combine(slice::from_raw_parts_mut(dst, size * size * 4), size, src, src_stride, src_kind, bw, bh, mode, rgb, slice::from_raw_parts_mut(ext, 4))
}
