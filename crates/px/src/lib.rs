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
mod guided;
mod jobs;
mod maskf;
mod mip;
mod png;
mod poisson;
mod psd;
mod range;
mod relight;
mod resample;
mod sel;
mod smudge;
mod stroke;
mod tiff;

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
/// 26: color_match_rgba, blend_alpha; 27: liquify_preview; 28: map_tile_stats; 29: mask_invert;
/// 30: edgefit_shrink, warp_rgba, warp_coverage; 31: flood_shape out_kind/cells, grow_mask cells; 32: liquify_dab; 33: composite_masked_tile;
/// 34: crc32, png_chunk_frame; 35: range_tiles_depth; 36: range_tiles_rgba; 37: png_part_lines_cap, png_part_decode, png_part_finish; 38: tiff_unpack; 39: limit_alpha_rows; 40: guided_far, guided_far_scratch_bytes; 41: pngPartFromPtr / compose in wasm memory; 42: shadow_march_f64; 43: tiff_unpredict, tiff_predict_rgba, tiff_to_rgba);
/// `px.js` refuses a module it does not know.
#[no_mangle]
pub extern "C" fn px_abi_version() -> u32 {
    43
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

/// Area-average shrink of straight-alpha RGBA8 `rgba` (`w * h * 4` bytes) to unpremultiplied grayscale `gray` and
/// straight alpha `alpha` (`tw * th` f32 each, `edgefit.js` `shrinkRGBA`). `a[i]` is rounded to f32 before averaging
/// while `g[i]` multiplies by the unrounded double alpha (`edgefit.js:65-67`).
#[no_mangle]
pub unsafe extern "C" fn edgefit_shrink(rgba: *const u8, w: usize, h: usize, tw: usize, th: usize, gray: *mut f32, alpha: *mut f32) {
    if w == 0 || h == 0 || tw == 0 || th == 0 || rgba.is_null() || gray.is_null() || alpha.is_null() {
        return;
    }
    let Some(src_bytes) = w.checked_mul(h).and_then(|n| n.checked_mul(4)) else { return };
    let Some(dst_len) = tw.checked_mul(th) else { return };
    maskf::edgefit_shrink(
        slice::from_raw_parts(rgba, src_bytes),
        w,
        h,
        tw,
        th,
        slice::from_raw_parts_mut(gray, dst_len),
        slice::from_raw_parts_mut(alpha, dst_len),
    );
}

/// Bilinear inverse-affine warp of RGBA8 `src` (`w * h * 4` bytes) into `dst` (`w * h * 4` bytes, must not alias `src`)
/// under the 2x3 matrix `[a00, a01, tx, a10, a11, ty]` (`edgefit.js` `warpRGBA`).
#[no_mangle]
pub unsafe extern "C" fn warp_rgba(
    src: *const u8,
    dst: *mut u8,
    w: usize,
    h: usize,
    a00: f64,
    a01: f64,
    tx: f64,
    a10: f64,
    a11: f64,
    ty: f64,
) {
    if w == 0 || h == 0 || src.is_null() || dst.is_null() {
        return;
    }
    let Some(bytes) = w.checked_mul(h).and_then(|n| n.checked_mul(4)) else { return };
    maskf::warp_rgba(
        slice::from_raw_parts(src, bytes),
        slice::from_raw_parts_mut(dst, bytes),
        w,
        h,
        [a00, a01, tx, a10, a11, ty],
    );
}

/// Per-pixel source-bounds coverage mask (`w * h` f32 in `dst`, 1 inside, 1 px ramp to 0 outside) for the inverse
/// affine matrix `[a00, a01, tx, a10, a11, ty]` (`edgefit.js` `warpCoverage`).
#[no_mangle]
pub unsafe extern "C" fn warp_coverage(
    dst: *mut f32,
    w: usize,
    h: usize,
    a00: f64,
    a01: f64,
    tx: f64,
    a10: f64,
    a11: f64,
    ty: f64,
) {
    if w == 0 || h == 0 || dst.is_null() {
        return;
    }
    let Some(n) = w.checked_mul(h) else { return };
    maskf::warp_coverage(slice::from_raw_parts_mut(dst, n), w, h, [a00, a01, tx, a10, a11, ty]);
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

/// `growMask` plus the bounds and 256² cell occupancy (`cells`, or 0 for none) of its result over the selection `d`
/// (w × h RGBA8, in place); `bounds` (4 i32) is written when the result is not empty. Returns 1 when something is
/// selected, else 0.
#[no_mangle]
pub unsafe extern "C" fn grow_mask(d: *mut u8, w: usize, h: usize, n: i32, bounds: *mut i32, cells: *mut u8) -> i32 {
    let n_cells = ((w + 255) >> 8) * ((h + 255) >> 8);
    jobs::grow_mask(
        slice::from_raw_parts_mut(d, w * h * 4),
        w,
        h,
        n,
        slice::from_raw_parts_mut(bounds, 4),
        if cells.is_null() || n_cells == 0 { None } else { Some(slice::from_raw_parts_mut(cells, n_cells)) },
    )
}

/// The flood job: the region around (sx, sy) of `rgba`, clipped to `sel` (0 for none), drawn over `rgba` as 255 / 0
/// alpha bytes (`out_kind == 1`, first `w * h` bytes) or in the colour `rgb` (0xRRGGBB, `out_kind == 4`, `w * h * 4`
/// bytes); `info` (5 i32) gets count and bounds, `cells` (`((w + 255) >> 8) * ((h + 255) >> 8)` u8, or 0 for none)
/// gets 1 per occupied 256² cell and 0 per empty one. Returns 0, or -1 when the stack was too small.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
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
    out_kind: u32,
    stack: *mut u32,
    stack_pairs: usize,
    info: *mut i32,
    cells: *mut u8,
) -> i32 {
    let n_cells = ((w + 255) >> 8) * ((h + 255) >> 8);
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
        out_kind,
        slice::from_raw_parts_mut(stack, stack_pairs * 2),
        slice::from_raw_parts_mut(info, 5),
        if cells.is_null() || n_cells == 0 { None } else { Some(slice::from_raw_parts_mut(cells, n_cells)) },
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

/// Liquify's live-stroke preview kernel (`previewBlock` in `renderer/editor/inpaint_liquify.js`, K29): `bw` x `bh`
/// RGBA8 pixels into `out` whose centres lie at `(ox + (i + 0.5) * inv, oy + (j + 0.5) * inv)`, sampled bilinearly
/// (premultiplied) from the level-`level` window `win` (`ww` x `wh` at `(wx0, wy0)`) through the dense field nodes
/// `nodes` (`nodes_len` i32, `nw` nodes a row from `(nx0, ny0)` at grid step `s` on a `lw` x `lh` layer). Returns 1
/// when done, 0 when the arguments lie outside the kernel's contract.
#[no_mangle]
pub unsafe extern "C" fn liquify_preview(
    win: *const u8,
    ww: u32,
    wh: u32,
    wx0: i32,
    wy0: i32,
    level: u32,
    lw: u32,
    lh: u32,
    s: u32,
    nodes: *const i32,
    nodes_len: u32,
    nw: u32,
    nx0: i32,
    ny0: i32,
    ox: f64,
    oy: f64,
    inv: f64,
    out: *mut u8,
    bw: u32,
    bh: u32,
) -> u32 {
    let (ww, wh, lw, lh, nw, nodes_len, bw, bh) = (
        ww as usize,
        wh as usize,
        lw as usize,
        lh as usize,
        nw as usize,
        nodes_len as usize,
        bw as usize,
        bh as usize,
    );
    if ww == 0 || wh == 0 || lw == 0 || lh == 0 || bw == 0 || bh == 0 || nw < 2 || level > 16 || !matches!(s, 1 | 2 | 4 | 8) || win.is_null() || nodes.is_null() || out.is_null() {
        return 0;
    }
    let Some(need_win) = ww.checked_mul(wh).and_then(|n| n.checked_mul(4)) else { return 0 };
    let Some(need_out) = bw.checked_mul(bh).and_then(|n| n.checked_mul(4)) else { return 0 };
    let win = slice::from_raw_parts(win, need_win);
    let nodes = slice::from_raw_parts(nodes, nodes_len);
    let out = slice::from_raw_parts_mut(out, need_out);
    resample::liquify_preview(win, ww, wh, wx0, wy0, level, lw, lh, s, nodes, nw, nx0, ny0, ox, oy, inv, out, bw, bh)
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

/// One source `src` (`px * 4` RGBA8 bytes, straight alpha) composited over `dst` (`px * 4` RGBA8 bytes, in place;
/// `has_dst == 0` when the destination tile does not exist yet and is taken as transparent) under `op` and `alpha`
/// (0..255) with optional coverage `mask` (`px` bytes, or null for full coverage), keeping `dst` (or 0) untouched
/// wherever `src` has alpha 0 or `mask` is 0 (`compositeStroke` in `inpaint_tiles.js`, K36).
/// Returns 0 when no pixel changed, 1 when changed and at least one pixel has alpha > 0 afterwards (`dst` holds all
/// `px * 4` bytes), 2 when changed and every pixel has alpha 0 afterwards, 3 when refused.
#[no_mangle]
pub unsafe extern "C" fn composite_masked_tile(
    dst: *mut u8,
    has_dst: u32,
    src: *const u8,
    px: usize,
    op: u8,
    alpha: u8,
    mask: *const u8,
) -> u32 {
    if dst.is_null() || src.is_null() || px == 0 || px > 4096 * 4096 {
        return composite::REFUSED;
    }
    let Some(bytes) = px.checked_mul(4) else { return composite::REFUSED };
    let dst = slice::from_raw_parts_mut(dst, bytes);
    let src = slice::from_raw_parts(src, bytes);
    let mask = if mask.is_null() { None } else { Some(slice::from_raw_parts(mask, px)) };
    composite::masked_tile(dst, has_dst != 0, src, op, alpha, mask)
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

/// The CRC-32 of `len` bytes at `src`, continued from `start` (0 for a new checksum).
#[no_mangle]
pub unsafe extern "C" fn crc32(src: *const u8, len: usize, start: u32) -> u32 {
    if len == 0 || src.is_null() {
        return start;
    }
    png::crc32(slice::from_raw_parts(src, len), start)
}

/// Frame `data_len` bytes already at `buf[8..8 + data_len]` as a PNG chunk of 4-byte `kind` (big-endian, e.g.
/// `0x49444154` for `"IDAT"`): length and type in `buf[0..8]`, the CRC-32 over type and data in
/// `buf[8 + data_len..12 + data_len]`. Returns that CRC-32.
#[no_mangle]
pub unsafe extern "C" fn png_chunk_frame(buf: *mut u8, data_len: usize, kind: u32) -> u32 {
    if buf.is_null() {
        return 0;
    }
    png::chunk_frame(slice::from_raw_parts_mut(buf, data_len + 12), data_len, kind)
}

/// Byte capacity of `lines` for a standard `PART_BYTES` (`8 MB`) part of a `w`-wide 8-bit RGBA PNG
/// (`partRows(w, 2048) * (1 + 4 * w)`), or 0 when `w == 0` or on overflow (K7, `docs/PLAN_WASM_BUILD.md` §4.2).
#[no_mangle]
pub extern "C" fn png_part_lines_cap(w: usize) -> usize {
    png::part_lines_cap(w)
}

/// Decode one inflated part (`len` bytes at `lines`) of a `w`-wide 8-bit RGBA PNG (K7, `docs/PLAN_WASM_BUILD.md` §4.2).
/// Writes `[rows, adler, first_filter, opaque, needs_prev]` to `info` (5 `u32`s) and returns `rows` (`> 0`),
/// `-4` (`PART_NOT_LINES`), or `-5` (`PART_BAD_FILTER`).
#[no_mangle]
pub unsafe extern "C" fn png_part_decode(
    lines: *mut u8,
    len: usize,
    w: usize,
    prev: *mut u8,
    rt: *const u8,
    out: *mut u8,
    info: *mut u32,
) -> isize {
    if lines.is_null() || info.is_null() {
        return png::PART_NOT_LINES;
    }
    let row_bytes = w.saturating_mul(4);
    let stride = row_bytes.saturating_add(1);
    let rows = len / stride;
    let lines_slice = slice::from_raw_parts_mut(lines, len);
    let prev_slice = if prev.is_null() { None } else { Some(slice::from_raw_parts_mut(prev, row_bytes)) };
    let rt_table = if rt.is_null() { None } else { Some(&*(rt as *const [u8; 65536])) };
    let out_slice = if out.is_null() { None } else { Some(slice::from_raw_parts_mut(out, rows.saturating_mul(row_bytes))) };
    let info_arr = &mut *(info as *mut [u32; 5]);
    png::part_decode(lines_slice, w, prev_slice, rt_table, out_slice, info_arr)
}

/// Finish a part whose `png_part_decode` set `needs_prev = 1` once `prev` (`4 * w` bytes) is available
/// (K7, `docs/PLAN_WASM_BUILD.md` §4.2). Writes `[rows, 0, first_filter, opaque, 0]` to `info` (5 `u32`s) and returns
/// `rows` (`> 0`), `-4` (`PART_NOT_LINES`), or `-5` (`PART_BAD_FILTER`).
#[no_mangle]
pub unsafe extern "C" fn png_part_finish(
    lines: *mut u8,
    rows: usize,
    w: usize,
    prev: *mut u8,
    rt: *const u8,
    out: *mut u8,
    info: *mut u32,
) -> isize {
    if lines.is_null() || prev.is_null() || out.is_null() || info.is_null() {
        return png::PART_NOT_LINES;
    }
    let row_bytes = w.saturating_mul(4);
    let stride = row_bytes.saturating_add(1);
    let lines_slice = slice::from_raw_parts_mut(lines, rows.saturating_mul(stride));
    let prev_slice = slice::from_raw_parts_mut(prev, row_bytes);
    let rt_table = if rt.is_null() { None } else { Some(&*(rt as *const [u8; 65536])) };
    let out_slice = slice::from_raw_parts_mut(out, rows.saturating_mul(row_bytes));
    let info_arr = &mut *(info as *mut [u32; 5]);
    png::part_finish(lines_slice, rows, w, prev_slice, rt_table, out_slice, info_arr)
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

/// Marches shadow rays through u16 depth height field in exact `f64` arithmetic (K13, docs/PLAN_WASM_BUILD.md §4.4).
/// `taps_xyz` holds `taps * 3` `f64` per-tap constants (`[tapX[t], tapY[t], tapZ[t]]`).
/// Output is u8 visibility (0=shadow, 255=lit) for rows `[row0 .. row0 + rows]`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn shadow_march_f64(
    depth: *const u16,
    w: usize,
    h: usize,
    scale: f64,
    is_sun: u32,
    taps_xyz: *const f64,
    taps: u32,
    steps: u32,
    z_bias: f64,
    row0: usize,
    rows: usize,
    out: *mut u8,
) {
    if depth.is_null() || taps_xyz.is_null() || out.is_null() || taps == 0 || taps > 16 {
        return;
    }
    let Some((band_rows, n_depth, n_out)) = relight::march_lens(w, h, row0, rows) else {
        return;
    };
    let n_taps = taps as usize;
    relight::shadow_march_f64(
        slice::from_raw_parts(depth, n_depth),
        w,
        h,
        scale,
        is_sun != 0,
        slice::from_raw_parts(taps_xyz, n_taps * 3),
        n_taps,
        steps as usize,
        z_bias,
        row0,
        band_rows,
        slice::from_raw_parts_mut(out, n_out),
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

/// One `size`² RGBA8 tile of the selection inverted in the `bw` x `bh` corner (`tile` in place, `rgb` 0xRRGGBB;
/// K11, docs/PLAN_WASM_BUILD.md §4.3). Returns 1 with [x0, y0, x1, y1] in `ext` (4 i32s) when the tile holds a pixel
/// afterwards, 0 when it holds none (`ext` not written), 2 when refused.
#[no_mangle]
pub unsafe extern "C" fn mask_invert(tile: *mut u8, size: usize, bw: usize, bh: usize, rgb: u32, ext: *mut i32) -> u32 {
    if tile.is_null() || ext.is_null() || size == 0 || size > 4096 {
        return sel::REFUSED;
    }
    sel::mask_invert(slice::from_raw_parts_mut(tile, size * size * 4), size, bw, bh, rgb, slice::from_raw_parts_mut(ext, 4))
}

// ---- range selection & limits (PLAN_WASM_BUILD.md §4.8, K21) --------------------------------------------------------

/// Per-tile minimum, maximum, and edge flag for one document tile row `[0, y0, w, y1]` over a `wh`-row window of `map`
/// (and optional `rmax`) starting at map row `wy0`. Returns `1` on success, `0` when refused.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn map_tile_stats(
    map: *const u16,
    rmax: *const u16,
    mw: usize,
    mh: usize,
    wy0: usize,
    wh: usize,
    w: usize,
    y0: usize,
    y1: usize,
    tile: usize,
    m0: f64,
    m1: f64,
    m2: f64,
    m3: f64,
    m4: f64,
    m5: f64,
    thresh: u32,
    min_out: *mut u16,
    max_out: *mut u16,
    edge_out: *mut u8,
) -> u32 {
    if map.is_null()
        || min_out.is_null()
        || max_out.is_null()
        || edge_out.is_null()
        || mw == 0
        || mh == 0
        || wh == 0
        || wy0 >= mh
        || wy0.saturating_add(wh) > mh
        || w == 0
        || tile == 0
        || y0 >= y1
        || !m0.is_finite()
        || !m1.is_finite()
        || !m2.is_finite()
        || !m3.is_finite()
        || !m4.is_finite()
        || !m5.is_finite()
    {
        return 0;
    }
    let win_len = match wh.checked_mul(mw) {
        Some(n) => n,
        None => return 0,
    };
    let cols = (w - 1) / tile + 1;
    let map_slice = slice::from_raw_parts(map, win_len);
    let rmax_slice = if rmax.is_null() {
        None
    } else {
        Some(slice::from_raw_parts(rmax, win_len))
    };
    range::map_tile_stats(
        map_slice,
        rmax_slice,
        mw,
        mh,
        wy0,
        wh,
        w,
        y0,
        y1,
        tile,
        m0,
        m1,
        m2,
        m3,
        m4,
        m5,
        thresh,
        slice::from_raw_parts_mut(min_out, cols),
        slice::from_raw_parts_mut(max_out, cols),
        slice::from_raw_parts_mut(edge_out, cols),
    )
}

/// Liquify's dense dab kernel (`inpaint_liquify.js` `liquifyDabNodes`, K31; `docs/PLAN_WASM_BUILD.md` §4.9).
/// `mode`: 0 push, 1 grow, 2 shrink, 3 swirlcw, 4 swirlccw, 5 restore.
/// `src`: `sw * sh * 2` `i32`s of pre-dab `(dx, dy)` nodes from `(si0, sj0)`.
/// `sel` / `freeze`: optional `ow * oh` `u8` thaw/freeze planes (null when absent).
/// Writes `ow * oh * 2` `i32`s to `out` and `[bi0, bj0, bi1, bj1]` to `box_out` (when at least one node changed),
/// returning the changed node count (`0..=ow*oh`), or `u32::MAX` (`0xffff_ffff`) when the arguments are refused.
#[no_mangle]
pub unsafe extern "C" fn liquify_dab(
    mode: u32,
    src: *const i32,
    sw: usize,
    sh: usize,
    si0: i32,
    sj0: i32,
    s: u32,
    ni: usize,
    nj: usize,
    cx: f64,
    cy: f64,
    r: f64,
    h: f64,
    amount: f64,
    dx_step: f64,
    dy_step: f64,
    sel: *const u8,
    freeze: *const u8,
    i0: i32,
    j0: i32,
    ow: usize,
    oh: usize,
    out: *mut i32,
    box_out: *mut i32,
) -> u32 {
    if src.is_null() || out.is_null() || box_out.is_null() {
        return resample::DAB_REFUSED;
    }
    let Some(src_len) = sw.checked_mul(sh).and_then(|n| n.checked_mul(2)) else {
        return resample::DAB_REFUSED;
    };
    let Some(plane_len) = ow.checked_mul(oh) else {
        return resample::DAB_REFUSED;
    };
    let Some(out_len) = plane_len.checked_mul(2) else {
        return resample::DAB_REFUSED;
    };
    if src_len == 0 || out_len == 0 {
        return resample::DAB_REFUSED;
    }
    let sel_slice = if sel.is_null() {
        None
    } else {
        Some(slice::from_raw_parts(sel, plane_len))
    };
    let freeze_slice = if freeze.is_null() {
        None
    } else {
        Some(slice::from_raw_parts(freeze, plane_len))
    };
    resample::liquify_dab(
        mode,
        slice::from_raw_parts(src, src_len),
        sw,
        sh,
        si0,
        sj0,
        s,
        ni,
        nj,
        cx,
        cy,
        r,
        h,
        amount,
        dx_step,
        dy_step,
        sel_slice,
        freeze_slice,
        i0,
        j0,
        ow,
        oh,
        slice::from_raw_parts_mut(out, out_len),
        slice::from_raw_parts_mut(box_out, 4),
    )
}

/// Evaluates the `"compute"`-class tiles (`classes[tx] == 2`) of one document tile row `ty` (`[y0, y1)` clipped to
/// `[ty * tile, min((ty + 1) * tile, h))`) over a `wh`-row window of `map` (and optional `guide`) starting at map row
/// `wy0`, plus optional `pic` (`pic_w` x `pic_h` RGBA8 at `(pic_x0, pic_y0)`).
/// `params` holds 12 `f64`s: `[m0, m1, m2, m3, m4, m5, lo, hi, f_lo, f_hi, sigma_r, tau]`.
/// `flags`: bit 0 = `limit.invert`, bit 1 = `job_invert`.
/// Writes each partial tile's `tile * tile` alpha bytes sequentially into `alpha_out`, writes per-column status into
/// `status_out` (`0` = empty/skipped, `1` = partial in next slot of `alpha_out`, `2` = full), and writes
/// `[alpha_sum, b_x0, b_y0, b_x1, b_y1]` into `info_out` (`b_x0 = -1.0` when no compute tile has non-zero alpha).
/// Returns `1` on success, `0` when refused.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn range_tiles_depth(
    map: *const u16,
    guide: *const u8,
    pic: *const u8,
    mw: usize,
    mh: usize,
    wy0: usize,
    wh: usize,
    pic_x0: usize,
    pic_y0: usize,
    pic_w: usize,
    pic_h: usize,
    w: usize,
    h: usize,
    ty: usize,
    y0: usize,
    y1: usize,
    tile: usize,
    classes: *const u8,
    params: *const f64,
    flags: u32,
    alpha_out: *mut u8,
    status_out: *mut u8,
    info_out: *mut f64,
) -> u32 {
    if map.is_null()
        || classes.is_null()
        || params.is_null()
        || status_out.is_null()
        || info_out.is_null()
        || mw == 0
        || mh == 0
        || wh == 0
        || wy0 >= mh
        || wy0.saturating_add(wh) > mh
        || w == 0
        || h == 0
        || tile == 0
        || tile > 4096
        || y0 >= y1
    {
        return 0;
    }
    let Some(win_len) = wh.checked_mul(mw) else { return 0 };
    let Some(tile_bytes) = tile.checked_mul(tile) else { return 0 };
    let cols = (w - 1) / tile + 1;
    let p_slice = slice::from_raw_parts(params, 12);
    if p_slice.iter().any(|x| !x.is_finite()) {
        return 0;
    }
    let mut p = [0.0f64; 12];
    p.copy_from_slice(p_slice);

    let cls = slice::from_raw_parts(classes, cols);
    let n_compute = cls.iter().filter(|&&c| c == 2).count();
    let Some(alpha_len) = n_compute.checked_mul(tile_bytes) else { return 0 };
    if alpha_len > 0 && alpha_out.is_null() {
        return 0;
    }

    let map_slice = slice::from_raw_parts(map, win_len);
    let guide_slice = if guide.is_null() {
        None
    } else {
        let Some(guide_len) = win_len.checked_mul(4) else { return 0 };
        Some(slice::from_raw_parts(guide, guide_len))
    };
    let pic_slice = if pic.is_null() || pic_w == 0 || pic_h == 0 {
        None
    } else {
        let Some(pic_len) = pic_w.checked_mul(pic_h).and_then(|n| n.checked_mul(4)) else { return 0 };
        Some(slice::from_raw_parts(pic, pic_len))
    };
    let alpha_slice = if alpha_len == 0 {
        &mut [][..]
    } else {
        slice::from_raw_parts_mut(alpha_out, alpha_len)
    };
    let status_slice = slice::from_raw_parts_mut(status_out, cols);
    let info_slice = slice::from_raw_parts_mut(info_out, 5);

    range::range_tiles_depth(
        map_slice,
        guide_slice,
        pic_slice,
        mw,
        mh,
        wy0,
        wh,
        pic_x0,
        pic_y0,
        pic_w,
        pic_h,
        w,
        h,
        ty,
        y0,
        y1,
        tile,
        cls,
        &p,
        flags,
        alpha_slice,
        status_slice,
        info_slice,
    )
}

/// Evaluates one document tile row `ty` (`[ry0, ry1)` within `[ty * tile, min((ty + 1) * tile, h))`) over the
/// `(ry1 - ry0)`-row RGBA8 slice `rgba` (`w * (ry1 - ry0) * 4` bytes) for `"luma"` (`mode == 0`) or `"color"`
/// (`mode == 1`).
/// `params` holds 8 `f64`s: `[lo, hi, f_lo, f_hi, ref_l, ref_a, ref_b, tol]`.
/// `flags`: bit 0 = `limit.invert`, bit 1 = `job_invert`.
/// Writes each partial tile's `tile * tile` alpha bytes sequentially into `alpha_out`, writes per-column status into
/// `status_out` (`0` = empty, `1` = partial in next slot of `alpha_out`, `2` = full), and writes
/// `[alpha_sum, b_x0, b_y0, b_x1, b_y1]` into `info_out` (`b_x0 = -1.0` when no tile has non-zero alpha).
/// Returns `1` on success, `0` when refused.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn range_tiles_rgba(
    rgba: *const u8,
    w: usize,
    h: usize,
    ty: usize,
    ry0: usize,
    ry1: usize,
    tile: usize,
    mode: u32,
    params: *const f64,
    flags: u32,
    alpha_out: *mut u8,
    status_out: *mut u8,
    info_out: *mut f64,
) -> u32 {
    if rgba.is_null()
        || params.is_null()
        || alpha_out.is_null()
        || status_out.is_null()
        || info_out.is_null()
        || w == 0
        || h == 0
        || tile == 0
        || tile > 4096
        || ry0 >= ry1
    {
        return 0;
    }
    let rows = ry1 - ry0;
    let Some(rgba_len) = rows.checked_mul(w).and_then(|n| n.checked_mul(4)) else { return 0 };
    let Some(tile_bytes) = tile.checked_mul(tile) else { return 0 };
    let cols = (w - 1) / tile + 1;
    let Some(alpha_len) = cols.checked_mul(tile_bytes) else { return 0 };

    let p_slice = slice::from_raw_parts(params, 8);
    if p_slice.iter().any(|x| !x.is_finite()) {
        return 0;
    }
    let mut p = [0.0f64; 8];
    p.copy_from_slice(p_slice);

    let rgba_slice = slice::from_raw_parts(rgba, rgba_len);
    let alpha_slice = slice::from_raw_parts_mut(alpha_out, alpha_len);
    let status_slice = slice::from_raw_parts_mut(status_out, cols);
    let info_slice = slice::from_raw_parts_mut(info_out, 5);

    range::range_tiles_rgba(
        rgba_slice,
        w,
        h,
        ty,
        ry0,
        ry1,
        tile,
        mode,
        &p,
        flags,
        alpha_slice,
        status_slice,
        info_slice,
    )
}

/// Unpacks one TIFF strip or tile of uncompressed (`1`), LZW (`5`) or PackBits (`32773`) bytes (`len` bytes at `src`)
/// into `out` (`need` bytes), stopping as soon as `need` bytes are written (`renderer/editor/inpaint_tiff.js`
/// `unpackStrip`, K16). Returns `need as isize`, or `< 0` on error (`-1` bad arguments/compression, `-2` truncated,
/// `-3` old-style LZW, `-4` LZW code before literal, `-5` LZW code beyond table).
#[no_mangle]
pub unsafe extern "C" fn tiff_unpack(compression: u32, src: *const u8, len: usize, out: *mut u8, need: usize) -> isize {
    if !(compression == 1 || compression == 5 || compression == 32773)
        || len > isize::MAX as usize
        || need > isize::MAX as usize
        || (len > 0 && src.is_null())
        || (need > 0 && out.is_null())
    {
        return tiff::ERR_BAD_ARGS;
    }
    if need == 0 {
        return 0;
    }
    let src_slice = if len == 0 { &[][..] } else { slice::from_raw_parts(src, len) };
    let out_slice = slice::from_raw_parts_mut(out, need);
    tiff::unpack(compression, src_slice, out_slice)
}

/// Undo horizontal differencing (Predictor 2) in place on `rows` rows of `row_bytes` stride, each `pixels` wide with
/// `per` samples per pixel at `bits` (`8` or `16`) bits per sample (`le != 0` for little-endian 16-bit;
/// `renderer/editor/inpaint_tiff.js` `unpredict`, K15). Returns `0` on success, `-1` on invalid arguments.
#[no_mangle]
pub unsafe extern "C" fn tiff_unpredict(
    buf: *mut u8,
    len: usize,
    rows: usize,
    row_bytes: usize,
    pixels: usize,
    per: usize,
    bits: u32,
    le: u32,
) -> i32 {
    tiff::unpredict(buf, len, rows, row_bytes, pixels, per, bits, le != 0)
}

/// Horizontal differencing (Predictor 2) in place on `rows` rows of `w`-wide RGBA8 (`w * rows * 4` bytes at `rgba`;
/// `renderer/editor/inpaint_tiff.js` `predictRgba` / `tiffPart`, K15). Returns `0` on success, `-1` on invalid arguments.
#[no_mangle]
pub unsafe extern "C" fn tiff_predict_rgba(rgba: *mut u8, w: usize, rows: usize) -> i32 {
    tiff::predict_rgba(rgba, w, rows)
}

/// Convert `rows` rows of `w` pixels from `planes` (`1` chunky or `spp` planar, packed consecutively at stride
/// `rows * row_bytes` in `src`) into straight-alpha RGBA8 in `out` (`w * rows * 4` bytes;
/// `renderer/editor/inpaint_tiff.js` `toRgba` / `converter`, K15). Returns `0` on success, `-1` on invalid arguments.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn tiff_to_rgba(
    src: *const u8,
    src_len: usize,
    planes: usize,
    row_bytes: usize,
    w: usize,
    rows: usize,
    spp: usize,
    bits: u32,
    le: u32,
    photometric: u32,
    alpha_mode: u32,
    pal: *const u8,
    pal_len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    tiff::to_rgba(
        src,
        src_len,
        planes,
        row_bytes,
        w,
        rows,
        spp,
        bits,
        le != 0,
        photometric,
        alpha_mode,
        pal,
        pal_len,
        out,
        out_len,
    )
}


/// Multiplies the alpha channel of `rgba` (`w * h * 4` RGBA8 bytes, in place) by the depth limit weight over a
/// `wh`-row window of `map` (and optional `guide`) starting at map row `wy0` (`inpaint_limit.js` `limitAlphaRows`, K25).
/// When `sigma_r > 0` and `guide` is non-null, edge snap takes its reference colour from `col` (`w * h * 4` RGBA8 bytes)
/// when `col` is non-null (`col == rgba` reads `rgba`'s RGB in place), or from `guide` sampled at `floor(mx), floor(my)`
/// when `col` is null.
/// `params` holds 12 `f64`s: `[m0, m1, m2, m3, m4, m5, lo, hi, f_lo, f_hi, sigma_r, tau]`.
/// `flags`: bit 0 = `limit.invert`.
/// Returns `1` on success, `0` when refused.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn limit_alpha_rows(
    rgba: *mut u8,
    col: *const u8,
    map: *const u16,
    guide: *const u8,
    mw: usize,
    mh: usize,
    wy0: usize,
    wh: usize,
    x0: i32,
    y0: i32,
    w: usize,
    h: usize,
    params: *const f64,
    flags: u32,
) -> u32 {
    if rgba.is_null()
        || map.is_null()
        || params.is_null()
        || mw == 0
        || mh == 0
        || wh == 0
        || wy0 >= mh
        || wy0.saturating_add(wh) > mh
        || w == 0
        || h == 0
    {
        return 0;
    }
    let Some(win_len) = wh.checked_mul(mw) else { return 0 };
    let Some(rgba_len) = w.checked_mul(h).and_then(|n| n.checked_mul(4)) else { return 0 };

    let p_slice = slice::from_raw_parts(params, 12);
    if p_slice.iter().any(|x| !x.is_finite()) {
        return 0;
    }
    let mut p = [0.0f64; 12];
    p.copy_from_slice(p_slice);

    let col_from_rgba = col == rgba as *const u8;
    let col_slice = if col.is_null() || col_from_rgba {
        None
    } else {
        Some(slice::from_raw_parts(col, rgba_len))
    };
    let map_slice = slice::from_raw_parts(map, win_len);
    let guide_slice = if guide.is_null() {
        None
    } else {
        let Some(guide_len) = win_len.checked_mul(4) else { return 0 };
        Some(slice::from_raw_parts(guide, guide_len))
    };
    let rgba_slice = slice::from_raw_parts_mut(rgba, rgba_len);

    range::limit_alpha_rows(
        rgba_slice,
        col_slice,
        col_from_rgba,
        map_slice,
        guide_slice,
        mw,
        mh,
        wy0,
        wh,
        x0,
        y0,
        w,
        h,
        &p,
        flags,
    )
}

// ---- depth map guided filter (K24) ---------------------------------------------------------

/// Scratch bytes `guided_far` needs for a `rw x rh` raw disparity map and `gw x gh` working guide (8-aligned at its
/// start); `0` when any dimension is `0` or the size does not fit.
#[no_mangle]
pub extern "C" fn guided_far_scratch_bytes(rw: usize, rh: usize, gw: usize, gh: usize) -> usize {
    guided::scratch_bytes(rw, rh, gw, gh).unwrap_or(0)
}

/// `guidedFar({ raw, rw, rh, grey, gw, gh, r, eps, lo, hi }, boxBlurs)` of `inpaint_depth.js`: normalises and inverts
/// `raw` (`rw * rh` `f32`) by `[lo, hi]`, bilinearly resizes to `gw * gh` when `(rw, rh) != (gw, gh)`, runs the
/// He et al. guided filter against `grey` (`gw * gh` `u8`) with working radius `Math.max(1, Math.round(r * (gw / rw)))`
/// and `eps`, and writes `gw * gh` `u16` values into `out`. `scratch` holds `guided_far_scratch_bytes(rw, rh, gw, gh)`
/// bytes. Returns `1` on success, `0` when refused.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn guided_far(
    raw: *const f32,
    rw: usize,
    rh: usize,
    grey: *const u8,
    gw: usize,
    gh: usize,
    r: f64,
    eps: f64,
    lo: f64,
    hi: f64,
    out: *mut u16,
    scratch: *mut u8,
) -> u32 {
    if raw.is_null()
        || grey.is_null()
        || out.is_null()
        || scratch.is_null()
        || !eps.is_finite()
        || !(eps > 0.0)
        || !lo.is_finite()
        || !hi.is_finite()
    {
        return 0;
    }
    if guided::scratch_bytes(rw, rh, gw, gh).is_none() {
        return 0;
    }
    let Some(r_work) = guided::work_radius(r, rw, gw) else {
        return 0;
    };
    let n_raw = rw * rh;
    let n_work = gw * gh;
    let n_tmp = n_work.max(n_raw);

    let sums_ptr = scratch as *mut f64;
    let f32_ptr = scratch.add(gw * 8) as *mut f32;
    let u32_ptr = f32_ptr.add(5 * n_work + n_tmp + gw) as *mut u32;

    let sums = slice::from_raw_parts_mut(sums_ptr, gw);
    let plane_i = slice::from_raw_parts_mut(f32_ptr, n_work);
    let plane_p = slice::from_raw_parts_mut(f32_ptr.add(n_work), n_work);
    let plane_mi = slice::from_raw_parts_mut(f32_ptr.add(2 * n_work), n_work);
    let plane_ip = slice::from_raw_parts_mut(f32_ptr.add(3 * n_work), n_work);
    let plane_ii = slice::from_raw_parts_mut(f32_ptr.add(4 * n_work), n_work);
    let tmp = slice::from_raw_parts_mut(f32_ptr.add(5 * n_work), n_tmp);
    let wx = slice::from_raw_parts_mut(f32_ptr.add(5 * n_work + n_tmp), gw);
    let x0 = slice::from_raw_parts_mut(u32_ptr, gw);
    let x1 = slice::from_raw_parts_mut(u32_ptr.add(gw), gw);

    guided::guided_far(
        slice::from_raw_parts(raw, n_raw),
        rw,
        rh,
        slice::from_raw_parts(grey, n_work),
        gw,
        gh,
        r_work,
        eps,
        lo,
        hi,
        slice::from_raw_parts_mut(out, n_work),
        sums,
        plane_i,
        plane_p,
        plane_mi,
        plane_ip,
        plane_ii,
        tmp,
        wx,
        x0,
        x1,
    );
    1
}
