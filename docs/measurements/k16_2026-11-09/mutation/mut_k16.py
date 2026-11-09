"""K16 mutation round config for tools/mutation_round.py (docs/PLAN_WASM_BUILD.md §4.6)."""

TITLE = "K16 (tiff_unpack, unpackStrip, TIFF_JS, LZW first-piece fix, stop at need)"

WORKING = [
    "crates/px/src/tiff.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_tiff.js",
    "tools/px_test.js",
    "tools/tiff_test.js",
]

GATES = []
TILES = "on"

TF = "crates/px/src/tiff.rs"
LB = "crates/px/src/lib.rs"
IT = "renderer/editor/inpaint_tiff.js"
PJ = "renderer/editor/px/px.js"
KR = "renderer/editor/px/kernels.js"

MUTANTS = [
    # ---- crates/px/src/tiff.rs ----
    (
        "tiff.rs: unpack_none truncation check < mutated to <=",
        TF,
        [(
            "fn unpack_none(src: &[u8], out: &mut [u8]) -> isize {\n    let need = out.len();\n    if src.len() < need {",
            "fn unpack_none(src: &[u8], out: &mut [u8]) -> isize {\n    let need = out.len();\n    if src.len() <= need {",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpack_packbits literal count (h as usize) + 1 mutated to (h as usize)",
        TF,
        [(
            "        if h < 128 {\n            let lit = (h as usize) + 1;",
            "        if h < 128 {\n            let lit = h as usize;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpack_packbits repeat count 257 - (h as usize) mutated to 256 - (h as usize)",
        TF,
        [(
            "            let rep = 257 - (h as usize);\n            let n = rep.min(need - o);",
            "            let rep = 256 - (h as usize);\n            let n = rep.min(need - o);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpack_packbits h == 128 no-op guard mutated (h > 128 -> h >= 128)",
        TF,
        [(
            "        } else if h > 128 {\n            if i >= src.len() {",
            "        } else if h >= 128 {\n            if i >= src.len() {",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpack_lzw old-style LZW check dropped",
        TF,
        [(
            "    if src[0] == 0 && (src[1] & 1) != 0 {\n        return ERR_OLD_LZW;\n    }",
            "    if false {\n        return ERR_OLD_LZW;\n    }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpack_lzw early width change (1usize << *width) - 1 mutated to (1usize << *width)",
        TF,
        [(
            "        if *next >= (1usize << *width) - 1 && *width < 12 {\n            *width += 1;\n        }",
            "        if *next >= (1usize << *width) && *width < 12 {\n            *width += 1;\n        }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpack_lzw Clear code 256 does not reset old to -1",
        TF,
        [(
            "            if c == 256 {\n                next = 258;\n                width = 9;\n                old = -1;\n                continue;\n            }",
            "            if c == 256 {\n                next = 258;\n                width = 9;\n                continue;\n            }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpack_lzw EOI code 257 returns need as isize even when o < need",
        TF,
        [(
            "            if c == 257 {\n                return if o >= need { need as isize } else { ERR_TRUNCATED };\n            }",
            "            if c == 257 {\n                return need as isize;\n            }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpack_lzw code > 255 before literal returns ERR_TRUNCATED instead of ERR_LZW_BEFORE_LITERAL",
        TF,
        [(
            "                if c > 255 {\n                    return ERR_LZW_BEFORE_LITERAL;\n                }",
            "                if c > 255 {\n                    return ERR_TRUNCATED;\n                }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpack_lzw KwKwK branch (c == next) uses first[c] instead of first[prev]",
        TF,
        [(
            "                } else if c == next {\n                    add(prev, first[prev], &mut next, &mut width, &mut prefix, &mut suffix, &mut first, &mut len);\n                    emit(c, &mut o, out, &prefix, &suffix, &len);",
            "                } else if c == next {\n                    add(prev, first[c & 0xFFF], &mut next, &mut width, &mut prefix, &mut suffix, &mut first, &mut len);\n                    emit(c, &mut o, out, &prefix, &suffix, &len);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpack_lzw stop at need (if o >= need) dropped so trailing damaged codes are read",
        TF,
        [(
            "            if o >= need {\n                return need as isize;\n            }",
            "            if false {\n                return need as isize;\n            }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "tiff.rs: unpack_lzw partial final code skip (l - keep) dropped",
        TF,
        [(
            "        for _ in 0..(l - keep) {\n            c = (prefix[c] as usize) & 0xFFF;\n        }",
            "        for _ in 0..0 {\n            c = (prefix[c] as usize) & 0xFFF;\n        }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- crates/px/src/lib.rs ----
    (
        "lib.rs: tiff_unpack null src check (len > 0 && src.is_null()) dropped",
        LB,
        [(
            "        || (len > 0 && src.is_null())\n        || (need > 0 && out.is_null())",
            "        || (need > 0 && out.is_null())",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "lib.rs: tiff_unpack null out check (need > 0 && out.is_null()) dropped",
        LB,
        [(
            "        || (len > 0 && src.is_null())\n        || (need > 0 && out.is_null())",
            "        || (len > 0 && src.is_null())",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- renderer/editor/inpaint_tiff.js ----
    (
        "inpaint_tiff.js: lzwDecoder 1-byte first-piece fix reverted to buggy head === chunk[0] check",
        IT,
        [(
            "                let firstByte, secondByte;\n                if (head < 0) {\n                    if (chunk.length < 2) { head = chunk[0]; return new Uint8Array(0); }\n                    firstByte = chunk[0]; secondByte = chunk[1];\n                } else {\n                    firstByte = head; secondByte = chunk[0];\n                    acc = head; nbits = 8;\n                }\n                if (firstByte === 0 && (secondByte & 1)) throw tiffError(\"this TIFF uses the old-style LZW of before TIFF 6, which is not read; save it again with LZW or ZIP compression\", -3);\n                checked = true;",
            "                if (head < 0) { head = chunk[0]; if (chunk.length < 2) return new Uint8Array(0); }\n                const second = head === chunk[0] && chunk.length >= 2 ? chunk[1] : chunk[0];\n                if (head === 0 && (second & 1)) throw tiffError(\"this TIFF uses the old-style LZW of before TIFF 6, which is not read; save it again with LZW or ZIP compression\", -3);\n                checked = true;\n                if (chunk[0] !== head || chunk.length < 2) { acc = head; nbits = 8; }",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: lzwDecoder stop at need (if (left <= 0) ended = true) dropped",
        IT,
        [(
            "        left -= keep;\n        if (left <= 0) ended = true;",
            "        left -= keep;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: packBitsDecoder stop at need (left > 0) dropped",
        IT,
        [(
            "        push(chunk) {\n            for (let i = 0; i < chunk.length && left > 0;) {",
            "        push(chunk) {\n            left = Infinity;\n            for (let i = 0; i < chunk.length;) {",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: packBitsDecoder lit = 0 instead of lit -= n across piece break",
        IT,
        [(
            "                    lit -= n; left -= n; i += n;",
            "                    lit = 0; left -= n; i += n;",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: packBitsDecoder loses rep at piece break",
        IT,
        [(
            "            return out.take();\n        },\n        end() { return new Uint8Array(0); },",
            "            rep = -1; return out.take();\n        },\n        end() { return new Uint8Array(0); },",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: StripRows.open omits this.need in unpacked() call",
        IT,
        [(
            "        this.it = unpacked(this.src, L.offsets[k], L.counts[k], this.info.compression, `strip ${k + 1}`, this.need);",
            "        this.it = unpacked(this.src, L.offsets[k], L.counts[k], this.info.compression, `strip ${k + 1}`);",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: TileRows.tile omits want in unpacked() call",
        IT,
        [(
            "        const it = unpacked(this.src, L.offsets[k], L.counts[k], this.info.compression, `tile ${k + 1}`, want);",
            "        const it = unpacked(this.src, L.offsets[k], L.counts[k], this.info.compression, `tile ${k + 1}`);",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: unpackStrip does not throw truncated when decoded.length < need",
        IT,
        [(
            "    const decoded = dec.push(bytes);\n    if (decoded.length < need) throw truncated(`${name} holds fewer bytes than its rows`);",
            "    const decoded = dec.push(bytes);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: unpackStrip ignores caller-supplied out buffer",
        IT,
        [(
            "    if (out == null) {\n        dst = new Uint8Array(need);",
            "    if (true) {\n        dst = new Uint8Array(need);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: unpackStrip accepts bare ArrayBuffer as src",
        IT,
        [(
            "    if (!(compression === 1 || compression === 5 || compression === 32773) || !ArrayBuffer.isView(src) || !Number.isInteger(need) || need < 0) {",
            "    if (!(compression === 1 || compression === 5 || compression === 32773) || !src || typeof src.byteLength !== \"number\" || !Number.isInteger(need) || need < 0) {",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- renderer/editor/px/px.js ----
    (
        "px.js: tiffUnpackError swaps -4 and -5 messages",
        PJ,
        [(
            "    else if (code === -4) msg = \"damaged LZW data in the TIFF (a code before any literal)\";\n    else if (code === -5) msg = \"damaged LZW data in the TIFF (a code beyond the table)\";",
            "    else if (code === -4) msg = \"damaged LZW data in the TIFF (a code beyond the table)\";\n    else if (code === -5) msg = \"damaged LZW data in the TIFF (a code before any literal)\";",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "px.js: tiffUnpack ignores caller-supplied out buffer",
        PJ,
        [(
            "            this._out(Uint8Array, po, need, dst ? (dst.length === need ? dst : dst.subarray(0, need)) : (dst = new Uint8Array(need)));",
            "            dst = this._out(Uint8Array, po, need, null);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "px.js: tiffUnpack accepts bare ArrayBuffer as src",
        PJ,
        [(
            "        if (!(compression === 1 || compression === 5 || compression === 32773) || !ArrayBuffer.isView(src) || !Number.isInteger(need) || need < 0) {",
            "        if (!(compression === 1 || compression === 5 || compression === 32773) || !src || typeof src.byteLength !== \"number\" || !Number.isInteger(need) || need < 0) {",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- renderer/editor/px/kernels.js ----
    (
        "kernels.js: tiffUnpack catch trap recovery dropped",
        KR,
        [(
            "        try { return p.tiffUnpack(compression, src, need, out, name); }\n        catch (err) { if (!recovered(p, err, \"tiff_unpack\")) throw err; }\n        finally { releaseIfLarge(); }",
            "        try { return p.tiffUnpack(compression, src, need, out, name); }\n        finally { releaseIfLarge(); }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
]
