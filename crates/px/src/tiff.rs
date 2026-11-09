//! TIFF strip and tile unpacking (K16, `docs/PLAN_WASM_BUILD.md` §4.6).
//!
//! `unpack` decodes one strip or tile of uncompressed (`1`), LZW (`5`, TIFF 6.0 §13) or PackBits (`32773`, TIFF 6.0 §9)
//! bytes into `out` (`need` bytes), stopping as soon as `out` is full. Deflate (`8` and `32946`) stays on the browser's
//! native `DecompressionStream("deflate")`.
//!
//! Returns `out.len() as isize` on success, or a negative code matching the JS reader's refusal messages in
//! `renderer/editor/inpaint_tiff.js`:
//! - `-1` (`ERR_BAD_ARGS`): unsupported compression or invalid arguments
//! - `-2` (`ERR_TRUNCATED`): the input ended (or LZW hit EOI `257`) before `out.len()` bytes were written
//! - `-3` (`ERR_OLD_LZW`): pre-TIFF-6 LSB-first LZW (`src[0] == 0 && (src[1] & 1) != 0`)
//! - `-4` (`ERR_LZW_BEFORE_LITERAL`): an LZW code `> 255` before any literal (at the start or right after Clear `256`)
//! - `-5` (`ERR_LZW_BEYOND_TABLE`): an LZW code `> next`

pub const ERR_BAD_ARGS: isize = -1;
pub const ERR_TRUNCATED: isize = -2;
pub const ERR_OLD_LZW: isize = -3;
pub const ERR_LZW_BEFORE_LITERAL: isize = -4;
pub const ERR_LZW_BEYOND_TABLE: isize = -5;

pub fn unpack(compression: u32, src: &[u8], out: &mut [u8]) -> isize {
    match compression {
        1 => unpack_none(src, out),
        5 => unpack_lzw(src, out),
        32773 => unpack_packbits(src, out),
        _ => ERR_BAD_ARGS,
    }
}

fn unpack_none(src: &[u8], out: &mut [u8]) -> isize {
    let need = out.len();
    if src.len() < need {
        return ERR_TRUNCATED;
    }
    out.copy_from_slice(&src[..need]);
    need as isize
}

fn unpack_packbits(src: &[u8], out: &mut [u8]) -> isize {
    let need = out.len();
    let mut i = 0usize;
    let mut o = 0usize;
    while i < src.len() && o < need {
        let h = src[i];
        i += 1;
        if h < 128 {
            let lit = (h as usize) + 1;
            let n = lit.min(src.len() - i).min(need - o);
            out[o..o + n].copy_from_slice(&src[i..i + n]);
            o += n;
            i += n;
        } else if h > 128 {
            if i >= src.len() {
                break;
            }
            let rep = 257 - (h as usize);
            let n = rep.min(need - o);
            out[o..o + n].fill(src[i]);
            o += n;
            i += 1;
        }
    }
    if o < need {
        return ERR_TRUNCATED;
    }
    need as isize
}

fn unpack_lzw(src: &[u8], out: &mut [u8]) -> isize {
    let need = out.len();
    if need == 0 {
        return 0;
    }
    if src.len() < 2 {
        return ERR_TRUNCATED;
    }
    // An old-style LZW stream starts with its clear code least-significant-bit first: 0x00, then a byte with bit 0 set.
    if src[0] == 0 && (src[1] & 1) != 0 {
        return ERR_OLD_LZW;
    }

    // 24 KB on the 1 MB wasm stack: 4,096-entry prefix, suffix, first and len tables.
    let mut prefix = [0u16; 4096];
    let mut suffix = [0u8; 4096];
    let mut first = [0u8; 4096];
    let mut len = [0u16; 4096];
    let mut i = 0usize;
    while i < 256 {
        suffix[i] = i as u8;
        first[i] = i as u8;
        len[i] = 1;
        i += 1;
    }

    let mut next = 258usize;
    let mut width = 9u32;
    let mut old: i32 = -1;
    let mut acc = 0u32;
    let mut nbits = 0u32;
    let mut o = 0usize;

    let emit = |code: usize, o: &mut usize, out: &mut [u8], prefix: &[u16; 4096], suffix: &[u8; 4096], len: &[u16; 4096]| {
        let l = len[code & 0xFFF] as usize;
        let left = out.len() - *o;
        let keep = l.min(left);
        let mut c = code & 0xFFF;
        for _ in 0..(l - keep) {
            c = (prefix[c] as usize) & 0xFFF;
        }
        for dst in out[*o..*o + keep].iter_mut().rev() {
            *dst = suffix[c];
            c = (prefix[c] as usize) & 0xFFF;
        }
        *o += keep;
    };

    let add = |pre: usize, ch: u8, next: &mut usize, width: &mut u32, prefix: &mut [u16; 4096], suffix: &mut [u8; 4096], first: &mut [u8; 4096], len: &mut [u16; 4096]| {
        if *next >= 4096 {
            return;
        }
        let n = *next;
        prefix[n] = pre as u16;
        suffix[n] = ch;
        first[n] = first[pre & 0xFFF];
        len[n] = len[pre & 0xFFF] + 1;
        *next = n + 1;
        if *next >= (1usize << *width) - 1 && *width < 12 {
            *width += 1;
        }
    };

    for &byte in src {
        acc = ((acc << 8) | (byte as u32)) & 0xFF_FFFF;
        nbits += 8;
        while nbits >= width {
            let c = ((acc >> (nbits - width)) & ((1u32 << width) - 1)) as usize;
            nbits -= width;
            if c == 256 {
                next = 258;
                width = 9;
                old = -1;
                continue;
            }
            if c == 257 {
                return if o >= need { need as isize } else { ERR_TRUNCATED };
            }
            if old < 0 {
                if c > 255 {
                    return ERR_LZW_BEFORE_LITERAL;
                }
                emit(c, &mut o, out, &prefix, &suffix, &len);
                old = c as i32;
            } else {
                let prev = (old as usize) & 0xFFF;
                if c < next {
                    emit(c, &mut o, out, &prefix, &suffix, &len);
                    add(prev, first[c & 0xFFF], &mut next, &mut width, &mut prefix, &mut suffix, &mut first, &mut len);
                } else if c == next {
                    add(prev, first[prev], &mut next, &mut width, &mut prefix, &mut suffix, &mut first, &mut len);
                    emit(c, &mut o, out, &prefix, &suffix, &len);
                } else {
                    return ERR_LZW_BEYOND_TABLE;
                }
                old = c as i32;
            }
            if o >= need {
                return need as isize;
            }
        }
    }
    if o < need {
        return ERR_TRUNCATED;
    }
    need as isize
}
