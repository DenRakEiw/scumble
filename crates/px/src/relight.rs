//! Relight kernels (PLAN_RELIGHT_BUILD.md sec 4.3, PLAN_WASM_BUILD.md sec 4.4-4.5): height_normals and shadow_march_f64.
//! Pure ASCII, no external dependencies outside crates/px.

/// Three box radii approximating Gaussian blur (Peter Kovesi's method).
pub fn gauss_radii(sigma: f32) -> [usize; 3] {
    if sigma <= 0.0 {
        return [0, 0, 0];
    }
    let s2 = (sigma * sigma) as f64;
    let w_ideal = ((12.0 * s2) / 3.0 + 1.0).sqrt();
    let mut wl = w_ideal.floor() as isize;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wu = wl + 2;
    let m_ideal = (12.0 * s2 - 3.0 * (wl * wl) as f64 - 12.0 * wl as f64 - 9.0) / (-4.0 * wl as f64 - 4.0);
    let mm = m_ideal.round() as isize;
    let r0 = (((if 0 < mm { wl } else { wu }) - 1) / 2).max(0) as usize;
    let r1 = (((if 1 < mm { wl } else { wu }) - 1) / 2).max(0) as usize;
    let r2 = (((if 2 < mm { wl } else { wu }) - 1) / 2).max(0) as usize;
    [r0, r1, r2]
}

/// Computes surface normals from u16 depth map: n = normalize(-dz/dx, -dz/dy, 1.0)
/// after optional Gaussian blur with sigma. Output is packed RGBA8 (n * 127.5 + 127.5, A=255).
pub fn height_normals(
    depth: &[u16],
    w: usize,
    h: usize,
    scale: f32,
    sigma: f32,
    out: &mut [u8],
) {
    if w == 0 || h == 0 {
        return;
    }
    let n = w * h;
    let inv65535 = scale / 65535.0;
    let mut heights = vec![0.0f32; n];
    for i in 0..n {
        heights[i] = (65535.0 - depth[i] as f32) * inv65535;
    }

    if sigma > 0.0 {
        let radii = gauss_radii(sigma);
        crate::maskf::box_blurs(&mut heights, w, h, &radii);
    }

    for y in 0..h {
        let row_offset = y * w;
        let y_top = y.saturating_sub(1);
        let y_bottom = (y + 1).min(h - 1);
        let row_top = y_top * w;
        let row_bottom = y_bottom * w;
        let dy_step = if y_bottom > y_top { (y_bottom - y_top) as f32 } else { 1.0 };

        for x in 0..w {
            let x_left = x.saturating_sub(1);
            let x_right = (x + 1).min(w - 1);
            let dx_step = if x_right > x_left { (x_right - x_left) as f32 } else { 1.0 };

            let dzdx = (heights[row_offset + x_right] - heights[row_offset + x_left]) / dx_step;
            let dzdy = (heights[row_bottom + x] - heights[row_top + x]) / dy_step;

            let nx = -dzdx;
            let ny = -dzdy;
            let nz = 1.0f32;
            let len = (nx * nx + ny * ny + nz * nz).sqrt();
            let len = if len > 0.0 { len } else { 1.0 };

            let out_offset = (row_offset + x) * 4;
            out[out_offset + 0] = ((nx / len) * 127.5 + 127.5).round().clamp(0.0, 255.0) as u8;
            out[out_offset + 1] = ((ny / len) * 127.5 + 127.5).round().clamp(0.0, 255.0) as u8;
            out[out_offset + 2] = ((nz / len) * 127.5 + 127.5).round().clamp(0.0, 255.0) as u8;
            out[out_offset + 3] = 255;
        }
    }
}

/// Validates dimensions and row bounds for `shadow_march_f64` and returns `(band_rows, n_depth, n_out)`.
#[inline]
pub fn march_lens(w: usize, h: usize, row0: usize, rows: usize) -> Option<(usize, usize, usize)> {
    if w == 0 || h == 0 || w >= 0x4000_0000 || h >= 0x4000_0000 || row0 >= h || rows == 0 {
        return None;
    }
    let band_rows = rows.min(h - row0);
    let n_depth = w.checked_mul(h)?;
    let n_out = w.checked_mul(band_rows)?;
    Some((band_rows, n_depth, n_out))
}

#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn march_pixel_scalar(
    depth: &[u16],
    wf: f64,
    scale: f64,
    inv65535: f64,
    inv_steps: f64,
    z_bias: f64,
    is_sun: bool,
    tap_x: &[f64; 16],
    tap_z: &[f64; 16],
    iy_rows: &[[usize; 64]; 16],
    max_steps: &[usize; 16],
    taps: usize,
    taps_f: f64,
    row_offset: usize,
    x: usize,
) -> u8 {
    let px = x as f64;
    let d0 = unsafe { *depth.get_unchecked(row_offset + x) } as f64;
    let z0 = (65535.0 - d0) * inv65535;
    let pz = z0 + z_bias;
    let mut lit_count = 0u32;

    for t in 0..taps {
        let cx_t = unsafe { *tap_x.get_unchecked(t) };
        let cz_t = unsafe { *tap_z.get_unchecked(t) };
        let (tx, tz) = if is_sun {
            (px + cx_t, pz + cz_t)
        } else {
            (cx_t, cz_t)
        };

        let rdx = tx - px;
        let rdz = tz - pz;
        let mut blocked = false;

        let step_x = rdx * inv_steps;
        let step_z = rdz * inv_steps;
        let mut sx = px + step_x;
        let mut sz = pz + step_z;
        let valid_steps = unsafe { *max_steps.get_unchecked(t) };
        let iy_row_t = unsafe { iy_rows.get_unchecked(t) };

        for s in 0..valid_steps {
            if rdz >= 0.0 && sz > scale {
                break;
            }

            let cx = sx + 0.5;
            if cx < 0.0 || cx >= wf {
                break;
            }
            let ix = unsafe { cx.to_int_unchecked::<usize>() };
            let iy_row = unsafe { *iy_row_t.get_unchecked(s) };

            let d = unsafe { *depth.get_unchecked(iy_row + ix) } as f64;
            let map_z = (65535.0 - d) * inv65535;
            if map_z > sz + z_bias {
                blocked = true;
                break;
            }

            sx += step_x;
            sz += step_z;
        }

        if !blocked {
            lit_count += 1;
        }
    }

    let v = (((lit_count as f64) / taps_f) * 255.0 + 0.5).floor();
    unsafe { v.to_int_unchecked::<u8>() }
}

/// Marches shadow rays through u16 depth height field in exact `f64` arithmetic (K13 / K14, docs/PLAN_WASM_BUILD.md §4.5).
/// `taps_xyz` holds `taps * 3` `f64`s (`[tapX[t], tapY[t], tapZ[t]]` for `t in 0..taps`) precomputed on the JS side
/// from `relightVogel`. Output is u8 visibility (0=shadow, 255=lit) for rows `[row0 .. row0 + rows]`.
#[allow(clippy::too_many_arguments)]
pub fn shadow_march_f64(
    depth: &[u16],
    w: usize,
    h: usize,
    scale: f64,
    is_sun: bool,
    taps_xyz: &[f64],
    taps: usize,
    steps: usize,
    z_bias: f64,
    row0: usize,
    rows: usize,
    out: &mut [u8],
) {
    let Some((band_rows, n_depth, n_out)) = march_lens(w, h, row0, rows) else {
        return;
    };
    if taps == 0
        || taps > 16
        || steps == 0
        || steps > 64
        || !scale.is_finite()
        || !z_bias.is_finite()
        || z_bias < 0.0
    {
        return;
    }
    if depth.len() < n_depth || taps_xyz.len() < taps * 3 || out.len() < n_out {
        return;
    }
    if taps_xyz[..taps * 3].iter().any(|x| !x.is_finite()) {
        return;
    }

    let inv65535 = scale / 65535.0;
    let inv_steps = 1.0 / (steps as f64);
    let wf = w as f64;
    let hf = h as f64;
    let taps_f = taps as f64;
    let mut tap_x = [0.0f64; 16];
    let mut tap_y = [0.0f64; 16];
    let mut tap_z = [0.0f64; 16];
    for t in 0..taps {
        let t3 = t * 3;
        tap_x[t] = taps_xyz[t3];
        tap_y[t] = taps_xyz[t3 + 1];
        tap_z[t] = taps_xyz[t3 + 2];
    }

    let mut iy_rows = [[0usize; 64]; 16];
    let mut max_steps = [0usize; 16];

    // K14 (docs/measurements/k14_2026-11-09/summary.txt): precomputing the row-and-tap invariant y march
    // (iy_rows / max_steps) once per row y and marching each pixel via march_pixel_scalar beat 2-lane f64x2 SIMD
    // across the 15000x10000 whole-operation rows (and in 23 of 24 px_bench rows): each pixel ray breaks out of the
    // step loop as soon as that pixel hits or exits without marching alongside a still-active neighbour lane or
    // extracting lane indices to GPRs for scalar u16 gathers.
    for r_idx in 0..band_rows {
        let y = row0 + r_idx;
        let py = y as f64;
        let row_offset = y * w;
        let out_offset = r_idx * w;

        for t in 0..taps {
            let cy_t = unsafe { *tap_y.get_unchecked(t) };
            let ty = if is_sun { py + cy_t } else { cy_t };
            let rdy = ty - py;
            let step_y = rdy * inv_steps;
            let mut sy = py + step_y;
            let mut valid = 0usize;
            for s in 0..steps {
                let cy = sy + 0.5;
                if cy < 0.0 || cy >= hf {
                    break;
                }
                let iy = unsafe { cy.to_int_unchecked::<usize>() };
                iy_rows[t][s] = iy * w;
                valid += 1;
                sy += step_y;
            }
            max_steps[t] = valid;
        }

        for x in 0..w {
            unsafe {
                *out.get_unchecked_mut(out_offset + x) = march_pixel_scalar(
                    depth, wf, scale, inv65535, inv_steps, z_bias, is_sun, &tap_x, &tap_z, &iy_rows, &max_steps,
                    taps, taps_f, row_offset, x,
                );
            }
        }
    }
}
