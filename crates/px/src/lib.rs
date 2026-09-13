//! Pixel kernels for Scumble's tile engine, compiled to `wasm32-unknown-unknown`.
//!
//! No wasm-bindgen: every export is a plain `extern "C"` function over linear memory and
//! the module is loaded with `WebAssembly.instantiate` (`renderer/editor/px/px.js`).
//! `docs/PLAN_BCE.md` §1 has the contract.

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
