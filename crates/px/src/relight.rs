//! Relight kernels (PLAN_RELIGHT_BUILD.md sec 4.3): height_normals and shadow_march.
//! Pure ASCII, no external dependencies outside crates/px.

/// Precomputed 16-tap Vogel disc points in unit circle.
pub const VOGEL_16: [[f32; 2]; 16] = [
    [0.17677670, 0.00000000],   // tap 0
    [-0.22577219, 0.20682582],  // tap 1
    [0.03455805, -0.39377118],  // tap 2
    [0.28457122, 0.37117276],   // tap 3
    [-0.52222319, -0.09237393], // tap 4
    [0.49469539, -0.31468471],  // tap 5
    [-0.16546593, 0.61552500],  // tap 6
    [-0.31556147, -0.60759440], // tap 7
    [0.68464216, 0.25003022],   // tap 8
    [-0.71225609, 0.29400896],  // tap 9
    [0.34335450, -0.73372862],  // tap 10
    [0.25373024, 0.80893199],   // tap 11
    [-0.76474589, -0.44318588], // tap 12
    [0.89713398, -0.19723239],  // tap 13
    [-0.54750691, 0.77877223],  // tap 14
    [-0.12648677, -0.97608970], // tap 15
];

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

/// Marches shadow rays through u16 depth height field.
/// Output is u8 visibility (0=shadow, 255=lit) for rows [row0 .. row0 + rows].
pub fn shadow_march(
    depth: &[u16],
    w: usize,
    h: usize,
    scale: f32,
    light: &[f32],
    radius: f32,
    taps: u32,
    steps: u32,
    bias: f32,
    row0: usize,
    rows: usize,
    out: &mut [u8],
) {
    if w == 0 || h == 0 || row0 >= h {
        return;
    }
    let band_rows = rows.min(h - row0);
    let lx = light[0];
    let ly = light[1];
    let lz = light[2];
    let kind = light[3] as i32;

    let n_taps = (taps as usize).clamp(1, 16);
    let n_steps = (steps as usize).clamp(1, 64);
    let r = radius.max(0.0);
    let z_bias = bias.max(0.0);
    let long_side = (w.max(h)) as f32;
    let sun_dist = long_side * 1.5;
    let inv65535 = scale / 65535.0;

    let (norm_lx, norm_ly, norm_lz) = if kind == 1 {
        let l_len = (lx * lx + ly * ly + lz * lz).sqrt();
        let inv_l = if l_len > 0.0 { 1.0 / l_len } else { 1.0 };
        (lx * inv_l, ly * inv_l, lz * inv_l)
    } else {
        (0.0, 0.0, 0.0)
    };

    for r_idx in 0..band_rows {
        let y = row0 + r_idx;
        let row_offset = y * w;
        let out_offset = r_idx * w;

        for x in 0..w {
            let z0 = (65535.0 - depth[row_offset + x] as f32) * inv65535;
            let px = x as f32;
            let py = y as f32;
            let pz = z0 + z_bias;
            let mut lit_count = 0u32;

            for t in 0..n_taps {
                let tap = VOGEL_16[t];
                let (tx, ty, tz) = if kind == 1 {
                    let jx = tap[0] * (r / long_side);
                    let jy = tap[1] * (r / long_side);
                    let dir_x = norm_lx + jx;
                    let dir_y = norm_ly + jy;
                    let dir_z = norm_lz;
                    let d_len = (dir_x * dir_x + dir_y * dir_y + dir_z * dir_z).sqrt();
                    let d_len = if d_len > 0.0 { d_len } else { 1.0 };
                    (
                        px + (dir_x / d_len) * sun_dist,
                        py + (dir_y / d_len) * sun_dist,
                        pz + (dir_z / d_len) * sun_dist,
                    )
                } else {
                    (
                        lx + tap[0] * r,
                        ly + tap[1] * r,
                        lz,
                    )
                };

                let rdx = tx - px;
                let rdy = ty - py;
                let rdz = tz - pz;
                let mut blocked = false;

                let inv_steps = 1.0 / (n_steps as f32);
                let step_x = rdx * inv_steps;
                let step_y = rdy * inv_steps;
                let step_z = rdz * inv_steps;
                let mut sx = px + step_x;
                let mut sy = py + step_y;
                let mut sz = pz + step_z;

                for _ in 1..=n_steps {
                    if rdz >= 0.0 && sz > scale {
                        break;
                    }

                    let cx = sx + 0.5;
                    let cy = sy + 0.5;
                    if cx < 0.0 || cy < 0.0 {
                        break;
                    }
                    let ix = cx as usize;
                    let iy = cy as usize;
                    if ix >= w || iy >= h {
                        break;
                    }

                    let map_z = (65535.0 - depth[iy * w + ix] as f32) * inv65535;
                    if map_z > sz + z_bias {
                        blocked = true;
                        break;
                    }

                    sx += step_x;
                    sy += step_y;
                    sz += step_z;
                }

                if !blocked {
                    lit_count += 1;
                }
            }

            out[out_offset + x] = ((lit_count as f32 / n_taps as f32) * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
}
