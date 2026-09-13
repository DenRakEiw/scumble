//! Pixel kernels for Scumble's tile engine, compiled to `wasm32-unknown-unknown`.
//!
//! No wasm-bindgen: every export is a plain `extern "C"` function over linear memory and
//! the module is loaded with `WebAssembly.instantiate` (`renderer/editor/px/px.js`).
//! `docs/PLAN_BCE.md` §1 has the contract:
//!
//! - `px_alloc(bytes) -> ptr` and `px_free(ptr, bytes)` over std's allocator (dlmalloc);
//!   every block is 8-aligned, so a pointer serves `u8`, `u32` and `f32` buffers alike.
//! - Every kernel is pure over its arguments: no globals, no allocation inside (the caller
//!   allocates in and out buffers), so one instance per worker can run any of them.
//! - Memory can grow during `px_alloc`; the JS side re-creates its views afterwards.

use std::alloc::{alloc, dealloc, Layout};

const ALIGN: usize = 8;

/// Bumped whenever an export changes its signature; `px.js` refuses a module it does not know.
#[no_mangle]
pub extern "C" fn px_abi_version() -> u32 {
    1
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
    match Layout::from_size_align(bytes, ALIGN) {
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
    dealloc(ptr, Layout::from_size_align_unchecked(bytes, ALIGN));
}
