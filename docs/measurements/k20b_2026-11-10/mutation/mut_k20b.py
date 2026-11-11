"""K20b mutation round config for tools/mutation_round.py (docs/PLAN_WASM_BUILD.md §4.7, docs/PLAN_WASM_K20.md §2 & §4)."""

TITLE = "K20b (packbits_rows, psd_mask_rgba, planar 8/16-bit tiff_to_rgba SIMD, 16-bit tiff_unpredict SIMD, upfront PSD channel/merged validation, 1-pass band-in-wasm psdRead)"

WORKING = [
    "crates/px/src/psd.rs",
    "crates/px/src/tiff.rs",
    "crates/px/src/lib.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/inpaint_layered.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/px.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_worker.js",
    "tools/px_test.js",
    "tools/layered_test.js",
    "tools/layered_test.py",
]

GATES = []
TILES = "on"

PSD_RS = "crates/px/src/psd.rs"
TIFF_RS = "crates/px/src/tiff.rs"
LAYERED_JS = "renderer/editor/inpaint_layered.js"
PX_JS = "renderer/editor/px/px.js"
KERNELS_JS = "renderer/editor/px/kernels.js"
WORKER_JS = "renderer/editor/inpaint_worker.js"

MUTANTS = [
    # ---- crates/px/src/psd.rs: packbits_rows & mask_rgba ----
    (
        "psd.rs: packbits_rows omits short-row zero-fill on dirty output buffer",
        PSD_RS,
        [(
            "        if o < row_bytes {\n            dst[o..row_bytes].fill(0);\n        }",
            "        if false && o < row_bytes {\n            dst[o..row_bytes].fill(0);\n        }",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "psd.rs: packbits_rows omits p = end row-boundary advance after overlong row",
        PSD_RS,
        [(
            "        p = end;\n    }\n    (rows * row_bytes) as isize",
            "        let _ = end;\n    }\n    (rows * row_bytes) as isize",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "psd.rs: packbits_rows treats 0x80 no-op byte as a 129-byte repeat run",
        PSD_RS,
        [(
            "            } else if n > 128 {",
            "            } else if n >= 128 {",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "psd.rs: packbits_rows dangling repeat at row end reads into next row (src.len() instead of lim)",
        PSD_RS,
        [(
            "                let v = if p < lim {",
            "                let v = if p < src.len() {",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "psd.rs: mask_rgba ignores sx0 mask column offset when indexing src_slice",
        PSD_RS,
        [(
            "        let s_off = mr * m_stride + sx0 * bps;",
            "        let s_off = mr * m_stride;",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "psd.rs: write_mask_span_16be SIMD 16->8 rounding bias 32895 mutated to 32768",
        PSD_RS,
        [(
            "        let c32895 = u32x4_splat(32895);",
            "        let c32895 = u32x4_splat(32768);",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "psd.rs: mask_rgba skips right-side default fill when x1 < w",
        PSD_RS,
        [(
            "        if x1 < w {\n            fill_mask_rgba(&mut row_out[x1 * 4..], def);\n        }",
            "        if false && x1 < w {\n            fill_mask_rgba(&mut row_out[x1 * 4..], def);\n        }",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    # ---- crates/px/src/tiff.rs: unpredict_row_16 SIMD & planar_to_rgba SIMD ----
    (
        "tiff.rs: unpredict_row_16 SIMD carry splats lane 0..1 instead of lane 14..15",
        TIFF_RS,
        [(
            "                acc = u8x16_shuffle::<14, 15, 14, 15, 14, 15, 14, 15, 14, 15, 14, 15, 14, 15, 14, 15>(sum, sum);",
            "                acc = u8x16_shuffle::<0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1>(sum, sum);",
        )],
        "killed",
        {"px": ["tiff", "psd"]},
    ),
    (
        "tiff.rs: unpredict_row_16 SIMD skips big-endian byte swap on load",
        TIFF_RS,
        [(
            "                let v0 = if le {\n                    raw\n                } else {\n                    u8x16_shuffle::<1, 0, 3, 2, 5, 4, 7, 6, 9, 8, 11, 10, 13, 12, 15, 14>(raw, raw)\n                };",
            "                let v0 = raw;",
        )],
        "killed",
        {"px": ["tiff", "psd"]},
    ),
    (
        "tiff.rs: planar_to_rgba 16-bit indexes alpha plane at (base + 1) fallback broken by using plane_bytes instead of base * plane_bytes",
        TIFF_RS,
        [(
            "            let pa = if has_a {\n                Some(&src[base * plane_bytes + r_off..base * plane_bytes + r_off + rb])",
            "            let pa = if has_a {\n                Some(&src[plane_bytes + r_off..plane_bytes + r_off + rb])",
        )],
        "killed",
        {"px": ["tiff", "psd"]},
    ),
    (
        "tiff.rs: planar_row_16 SIMD 16->8 rounding bias 32895 mutated to 0",
        TIFF_RS,
        [(
            "    let c32895 = u32x4_splat(32895);",
            "    let c32895 = u32x4_splat(0);",
        )],
        "killed",
        {"px": ["tiff", "psd"]},
    ),
    (
        "tiff.rs: planar_row_8 SIMD omits scalar tail loop simd_end..w",
        TIFF_RS,
        [(
            "    for i in simd_end..w {\n        let di = i * 4;\n        d[di] = p0[i];",
            "    for i in w..w {\n        let di = i * 4;\n        d[di] = p0[i];",
        )],
        "killed",
        {"px": ["tiff", "psd"]},
    ),
    # ---- renderer/editor/inpaint_layered.js: upfront validation & JS twins ----
    (
        "inpaint_layered.js: decodePsd gates keep on descs[0] instead of precomputed wantPixels (breaks [-2, -1, 0, 1, 2] channel order)",
        LAYERED_JS,
        [(
            "                            const keep = wantPixels && (c.id === 0 || c.id === -1 || (!gray && (c.id === 1 || c.id === 2)) || c.id === activeMaskId);",
            "                            const keep = !!descs[0] && (c.id === 0 || c.id === -1 || (!gray && (c.id === 1 || c.id === 2)) || c.id === activeMaskId);",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "inpaint_layered.js: prepareChannel drops packedAtLeast upfront RLE bomb check",
        LAYERED_JS,
        [(
            "        r.need(total);\n        if (total < packedAtLeast(h, rowBytes) || 2 * h + total > dataLen) throw tooShort(what, w, h);\n        if (!keep) return null;",
            "        r.need(total);\n        if (2 * h + total > dataLen) throw tooShort(what, w, h);\n        if (!keep) return null;",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "inpaint_layered.js: prepareChannel skips inflate on non-kept comp 2/3 channels (misses over-cap ZIP on extra channels)",
        LAYERED_JS,
        [(
            "    if (compression === 2 || compression === 3) {\n        if (!inflate) throw new Error(\"a ZIP-compressed PSD channel needs an inflater\");\n        r.need(dataLen);\n        if (size > dataLen * DEFLATE_MAX_RATIO) throw tooShort(what, w, h);\n        const bomb = () => new Error(`a ZIP channel of ${what} unpacks to more than its ${sizeText(w, h)}: the file is damaged`);\n        let raw;\n        try { raw = await inflate(r.bytes(dataLen), size); } catch (err) { throw err && err.tooLarge ? bomb() : err; }\n        if (raw.length > size) throw bomb();\n        if (!keep) return null;",
            "    if (compression === 2 || compression === 3) {\n        if (!keep) return null;\n        if (!inflate) throw new Error(\"a ZIP-compressed PSD channel needs an inflater\");\n        r.need(dataLen);\n        if (size > dataLen * DEFLATE_MAX_RATIO) throw tooShort(what, w, h);\n        const bomb = () => new Error(`a ZIP channel of ${what} unpacks to more than its ${sizeText(w, h)}: the file is damaged`);\n        let raw;\n        try { raw = await inflate(r.bytes(dataLen), size); } catch (err) { throw err && err.tooLarge ? bomb() : err; }\n        if (raw.length > size) throw bomb();\n        if (!keep) return null;",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "inpaint_layered.js: mergedChannelDescs omits err.refused = true on truncated RLE flat merged image",
        LAYERED_JS,
        [(
            "                const err = new Error(`the PSD's merged picture holds less data than its ${sizeText(width, height)} need: the file is damaged`);\n                err.refused = true;\n                throw err;\n            }\n            descs.push({",
            "                const err = new Error(`the PSD's merged picture holds less data than its ${sizeText(width, height)} need: the file is damaged`);\n                err.refused = false;\n                throw err;\n            }\n            descs.push({",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "inpaint_layered.js: unpackBandDesc mutates d.bytes in place via subarray instead of slice on comp === 3",
        LAYERED_JS,
        [(
            "    if (d.comp === 3) {\n        const out = d.bytes.slice(off, off + planeBytes);",
            "    if (d.comp === 3) {\n        const out = d.bytes.subarray(off, off + planeBytes);",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    # ---- renderer/editor/px/px.js: arena safety, missing channels, sub-rect unpredict, reset ----
    (
        "px.js: psdBandRgba caches stale this.u8() before a.take(...) across wasm memory.grow",
        PX_JS,
        [(
            "            const pPlanes = a.take(totalPlanes), pOut = a.take(needOut);\n            const pLens = anyRle ? a.take(rows * 2) : 0;\n            const pPacked = maxPacked > 0 ? a.take(maxPacked) : 0;\n            for (let i = 0; i < spp; i++) {\n                const d = list[i], dstPtr = pPlanes + i * planeBytes;\n                if (!d) {\n                    this.u8().fill(0, dstPtr, dstPtr + planeBytes);",
            "            const staleU8 = this.u8();\n            const pPlanes = a.take(totalPlanes), pOut = a.take(needOut);\n            const pLens = anyRle ? a.take(rows * 2) : 0;\n            const pPacked = maxPacked > 0 ? a.take(maxPacked) : 0;\n            for (let i = 0; i < spp; i++) {\n                const d = list[i], dstPtr = pPlanes + i * planeBytes;\n                if (!d) {\n                    staleU8.fill(0, dstPtr, dstPtr + planeBytes);",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "px.js: psdBandRgba omits zero-fill for omitted colour channel (!d)",
        PX_JS,
        [(
            "                if (!d) {\n                    this.u8().fill(0, dstPtr, dstPtr + planeBytes);",
            "                if (!d) {\n                    void dstPtr;",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "px.js: psdBandMask passes layer width w instead of mask width desc.cw to tiff_unpredict",
        PX_JS,
        [(
            "                    const rcP = this.exports.tiff_unpredict(pPlane, planeBytes, mRows, desc.rowBytes, desc.cw, 1, depth, 0) | 0;",
            "                    const rcP = this.exports.tiff_unpredict(pPlane, planeBytes, mRows, desc.rowBytes, w, 1, depth, 0) | 0;",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "px.js: psdBandRgba omits this._reset(a) in finally (leaks job arena bytes)",
        PX_JS,
        [(
            "            const out = this._out(Uint8ClampedArray, pOut, needOut, null);\n            if (spent) spent.interleave += clock() - t1;\n            return out;\n        } finally { this._reset(a); }",
            "            const out = this._out(Uint8ClampedArray, pOut, needOut, null);\n            if (spent) spent.interleave += clock() - t1;\n            return out;\n        } finally { void a; }",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    # ---- renderer/editor/px/kernels.js & renderer/editor/inpaint_worker.js: routing, trap recovery, releaseIfLarge ----
    (
        "kernels.js: PSD_RUST.bandRgba ignores tiffToRgba sub-route override",
        KERNELS_JS,
        [(
            "        const p = rustPx(\"psdRead\") && rustPx(\"tiffUnpredict\") && rustPx(\"tiffToRgba\");",
            "        const p = rustPx(\"psdRead\") && rustPx(\"tiffUnpredict\");",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "kernels.js: PSD_RUST.bandRgba rethrows wasm RuntimeError instead of recovering to PSD_JS",
        KERNELS_JS,
        [(
            "            catch (err) { if (!recovered(p, err, \"packbits_rows\")) throw err; }",
            "            catch (err) { throw err; }",
        )],
        "killed",
        {"px": ["psd"]},
    ),
    (
        "inpaint_worker.js: psdRead omits releaseIfLarge() in finally",
        WORKER_JS,
        [(
            "        releaseIfLarge();\n        // the file's array goes now, not at this idle worker's next collection (the answer holds no view of it)",
            "        void releaseIfLarge;\n        // the file's array goes now, not at this idle worker's next collection (the answer holds no view of it)",
        )],
        "killed",
        {"px": ["psd"]},
    ),
]
