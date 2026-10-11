//! Edge and map kernels (docs/PLAN_WASM.md #1).
//!
//! `range_max`: separable 4x4 block max - min over a u16 map.
//! Bit-identical to the JS twin in `renderer/editor/px/kernels_js.js`.

#[inline(always)]
fn horizontal_row(src_row: &[u16], w: usize, max_row: &mut [u16], min_row: &mut [u16]) {
    if w == 0 {
        return;
    }
    if w <= 3 {
        for x in 0..w {
            let cx_m1 = x.saturating_sub(1);
            let cx_0 = x;
            let cx_p1 = (x + 1).min(w - 1);
            let cx_p2 = (x + 2).min(w - 1);
            let v0 = src_row[cx_m1];
            let v1 = src_row[cx_0];
            let v2 = src_row[cx_p1];
            let v3 = src_row[cx_p2];
            max_row[x] = v0.max(v1).max(v2).max(v3);
            min_row[x] = v0.min(v1).min(v2).min(v3);
        }
        return;
    }

    // Left border (x = 0): taps at 0, 0, 1, 2
    {
        let v0 = src_row[0];
        let v1 = src_row[0];
        let v2 = src_row[1];
        let v3 = src_row[2];
        max_row[0] = v0.max(v1).max(v2).max(v3);
        min_row[0] = v0.min(v1).min(v2).min(v3);
    }

    // Interior (x = 1 .. w - 2): taps at x-1, x, x+1, x+2
    let interior_end = w - 2;
    for x in 1..interior_end {
        let v0 = src_row[x - 1];
        let v1 = src_row[x];
        let v2 = src_row[x + 1];
        let v3 = src_row[x + 2];
        max_row[x] = v0.max(v1).max(v2).max(v3);
        min_row[x] = v0.min(v1).min(v2).min(v3);
    }

    // Right border (x = w - 2): taps at w-3, w-2, w-1, w-1
    {
        let x = w - 2;
        let v0 = src_row[x - 1];
        let v1 = src_row[x];
        let v2 = src_row[x + 1];
        let v3 = src_row[x + 1]; // clamped to w - 1
        max_row[x] = v0.max(v1).max(v2).max(v3);
        min_row[x] = v0.min(v1).min(v2).min(v3);
    }

    // Right border (x = w - 1): taps at w-2, w-1, w-1, w-1
    {
        let x = w - 1;
        let v0 = src_row[x - 1];
        let v1 = src_row[x];
        let v2 = src_row[x]; // clamped to w - 1
        let v3 = src_row[x]; // clamped to w - 1
        max_row[x] = v0.max(v1).max(v2).max(v3);
        min_row[x] = v0.min(v1).min(v2).min(v3);
    }
}

pub fn range_max(src: &[u16], w: usize, h: usize, out: &mut [u16]) {
    if w == 0 || h == 0 {
        return;
    }
    if src.len() < w * h || out.len() < w * h {
        return;
    }

    // 4-row ring buffer for horizontal max/min
    let mut max_rows: [Vec<u16>; 4] = [
        vec![0u16; w],
        vec![0u16; w],
        vec![0u16; w],
        vec![0u16; w],
    ];
    let mut min_rows: [Vec<u16>; 4] = [
        vec![0u16; w],
        vec![0u16; w],
        vec![0u16; w],
        vec![0u16; w],
    ];
    let mut cached = [-1isize; 4];

    for y in 0..h {
        let cy0 = y.saturating_sub(1);
        let cy1 = y;
        let cy2 = (y + 1).min(h - 1);
        let cy3 = (y + 2).min(h - 1);

        for &cy in &[cy0, cy1, cy2, cy3] {
            let slot = cy % 4;
            if cached[slot] != cy as isize {
                let start = cy * w;
                horizontal_row(&src[start..start + w], w, &mut max_rows[slot], &mut min_rows[slot]);
                cached[slot] = cy as isize;
            }
        }

        let s0 = cy0 % 4;
        let s1 = cy1 % 4;
        let s2 = cy2 % 4;
        let s3 = cy3 % 4;

        let r0_max = &max_rows[s0];
        let r1_max = &max_rows[s1];
        let r2_max = &max_rows[s2];
        let r3_max = &max_rows[s3];

        let r0_min = &min_rows[s0];
        let r1_min = &min_rows[s1];
        let r2_min = &min_rows[s2];
        let r3_min = &min_rows[s3];

        let out_row = &mut out[y * w..(y + 1) * w];
        for x in 0..w {
            let mx = r0_max[x].max(r1_max[x]).max(r2_max[x]).max(r3_max[x]);
            let mn = r0_min[x].min(r1_min[x]).min(r2_min[x]).min(r3_min[x]);
            out_row[x] = mx - mn;
        }
    }
}
