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
mod edt;
mod flood;
mod jobs;
mod maskf;
mod mip;
mod png;
mod psd;
mod resample;
mod smudge;

/// dlmalloc hands out a page start plus its 8-byte header, while a JS ArrayBuffer of tile
/// size starts on a page. A copy between the two then has its destination 8 bytes past the
/// source modulo 4096, which is 4K aliasing: measured 56 to 66 µs for 256 KB against 3.5 µs
/// (Node 24 and Electron 44 alike). Page-aligned blocks avoid it.
fn align_for(bytes: usize) -> usize {
    if bytes >= 16 * 1024 { 4096 } else { 8 }
}

/// Bumped whenever an export changes its signature or learns a new op (13: linear light in `composite_tile`);
/// `px.js` refuses a module it does not know.
#[no_mangle]
pub extern "C" fn px_abi_version() -> u32 {
    13
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

/// Square dilation of a w x h mask of f32 by `r` pixels, in place, never below 0 (a whole job: it allocates its scratch).
#[no_mangle]
pub unsafe extern "C" fn dilate_mask(data: *mut f32, w: usize, h: usize, r: usize) {
    maskf::dilate(slice::from_raw_parts_mut(data, w * h), w, h, r);
}

/// Box blurs of the radii `r0`, `r1`, `r2` (0: none), rows then columns each, in place with clamped edges.
#[no_mangle]
pub unsafe extern "C" fn box_blurs(data: *mut f32, w: usize, h: usize, r0: usize, r1: usize, r2: usize) {
    maskf::box_blurs(slice::from_raw_parts_mut(data, w * h), w, h, &[r0, r1, r2]);
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

// ---- composite --------------------------------------------------------------------------

/// `n` sources over the tile `dst` (`px` pixels of RGBA8, straight alpha, in place).
/// `srcs` and `masks` are arrays of n u32 pointers (a mask pointer may be 0), `ops` and
/// `alphas` arrays of n bytes (0 source-over, 1 destination-out, 2 source-atop,
/// 3 destination-in, 4 copy, 5 to 13 the blend modes multiply, screen, overlay, darken,
/// lighten, soft-light, hard-light, difference, linear-light; opacity 0..255).
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
