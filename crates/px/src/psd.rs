//! PSD channel rows: PackBits (the RLE of TIFF and PSD) of one channel of RGBA8 rows.
//!
//! `pack_rows` takes `rows` rows of interleaved RGBA8 (`w` wide) and one channel index, and writes per row the packed
//! bytes one after the other into `out` and the packed length of each row, big endian u16, into `lens` (the table a
//! PSD puts in front of a channel's data). The runs are found exactly as `packBits` in
//! `renderer/editor/inpaint_export.js` finds them, so the bytes are the ones the JS writer gives (tools/px_test.js).

/// Returns the bytes written to `out`, or -1 when `out` was too small (the caller sizes it with `pack_rows_cap`).
pub fn pack_rows(rgba: &[u8], w: usize, rows: usize, channel: usize, out: &mut [u8], lens: &mut [u8]) -> isize {
    let mut o = 0usize;
    for y in 0..rows {
        let base = y * w * 4 + channel;
        let at = |x: usize| rgba[base + x * 4];
        let start = o;
        let mut i = 0usize;
        while i < w {
            let v = at(i);
            let mut j = i;
            while j + 1 < w && at(j + 1) == v && j - i < 126 {
                j += 1;
            }
            let run = j - i + 1;
            if run >= 2 {
                if o + 2 > out.len() {
                    return -1;
                }
                out[o] = (257 - run) as u8;
                out[o + 1] = v;
                o += 2;
                i = j + 1;
                continue;
            }
            let mut k = i;
            while k < w && k - i < 128 {
                if k + 1 < w && at(k + 1) == at(k) {
                    break;
                }
                k += 1;
            }
            if k == i {
                k = i + 1;
            }
            let n = k - i;
            if o + 1 + n > out.len() {
                return -1;
            }
            out[o] = (n - 1) as u8;
            for m in 0..n {
                out[o + 1 + m] = at(i + m);
            }
            o += 1 + n;
            i = k;
        }
        let len = o - start;
        lens[y * 2] = (len >> 8) as u8;
        lens[y * 2 + 1] = len as u8;
    }
    o as isize
}

/// The most bytes `pack_rows` can write. The worst input is a single byte between runs of two (x a a y b b ...): the
/// single costs two bytes and the run two, four for three; twice the input covers it with room to spare.
pub fn pack_rows_cap(w: usize, rows: usize) -> usize {
    rows * (2 * w + 2)
}
