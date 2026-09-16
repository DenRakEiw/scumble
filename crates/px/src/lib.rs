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
//!   one exception is `deflate_zlib`, whose compressor state miniz_oxide allocates.
//! - Memory can grow during `px_alloc`; the JS side re-creates its views afterwards.
//!
//! Each kernel has a JS twin of the same shape in `renderer/editor/px/kernels_js.js` that
//! gives the same bytes; `tools/px_test.js` holds them to it.

use core::slice;
use std::alloc::{alloc, dealloc, Layout};

mod composite;
mod edt;
mod flood;
mod mip;
mod png;

/// dlmalloc hands out a page start plus its 8-byte header, while a JS ArrayBuffer of tile
/// size starts on a page. A copy between the two then has its destination 8 bytes past the
/// source modulo 4096, which is 4K aliasing: measured 56 to 66 µs for 256 KB against 3.5 µs
/// (Node 24 and Electron 44 alike). Page-aligned blocks avoid it.
fn align_for(bytes: usize) -> usize {
    if bytes >= 16 * 1024 { 4096 } else { 8 }
}

/// Bumped whenever an export changes its signature; `px.js` refuses a module it does not know.
#[no_mangle]
pub extern "C" fn px_abi_version() -> u32 {
    2
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

// ---- composite --------------------------------------------------------------------------

/// `n` sources over the tile `dst` (`px` pixels of RGBA8, straight alpha, in place).
/// `srcs` and `masks` are arrays of n u32 pointers (a mask pointer may be 0), `ops` and
/// `alphas` arrays of n bytes (0 source-over, 1 destination-out, 2 source-atop,
/// 3 destination-in, 4 copy; opacity 0..255).
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

// ---- PNG --------------------------------------------------------------------------------

/// Filter `rows` rows of RGBA8 (`w` wide) into `out` (rows × (1 + 4w) bytes); `prev` is the
/// row above the first one, or 0. Returns the bytes written.
#[no_mangle]
pub unsafe extern "C" fn png_filter_rows(rgba: *const u8, w: usize, rows: usize, prev: *const u8, out: *mut u8) -> usize {
    let prev = if prev.is_null() { None } else { Some(slice::from_raw_parts(prev, w * 4)) };
    png::filter_rows(slice::from_raw_parts(rgba, w * 4 * rows), w, rows, prev, slice::from_raw_parts_mut(out, rows * (1 + 4 * w)))
}

/// A zlib stream of `len` bytes at `input` into `out` (`cap` bytes) at `level` (0..10);
/// returns the bytes written or -1 when `cap` is too small.
#[no_mangle]
pub unsafe extern "C" fn deflate_zlib(input: *const u8, len: usize, out: *mut u8, cap: usize, level: u32) -> i32 {
    png::deflate_zlib(slice::from_raw_parts(input, len), slice::from_raw_parts_mut(out, cap), level.min(10) as u8)
}
