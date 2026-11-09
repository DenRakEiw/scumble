"""K17 mutation round config for tools/mutation_round.py (docs/PLAN_WASM_BUILD.md §4.6)."""

TITLE = "K17 (tiffPlan, readTiffBand, TIFF_BAND_BYTES RGBA-size rule, per-tile unpredict, contiguous blob.slice, tiffUnpack route)"

WORKING = [
    "renderer/editor/inpaint_tiff.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/kernels.js",
    "tools/px_test.js",
    "tools/tiff_test.js",
    "tools/tiff_test.py",
]

GATES = []
TILES = "on"

IT = "renderer/editor/inpaint_tiff.js"
KR = "renderer/editor/px/kernels.js"

MUTANTS = [
    # ---- renderer/editor/inpaint_tiff.js: tiffPlan & RGBA-size rule ----
    (
        "inpaint_tiff.js: TIFF_BAND_BYTES 64 * 1048576 mutated to 32 * 1048576",
        IT,
        [(
            "export const TIFF_BAND_BYTES = 64 * 1048576;",
            "export const TIFF_BAND_BYTES = 32 * 1048576;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: tiffPlan maxRows divides by W instead of W * 4 (raw width instead of RGBA stride)",
        IT,
        [(
            "    const maxRows = Math.floor(TIFF_BAND_BYTES / (W * 4));",
            "    const maxRows = Math.floor(TIFF_BAND_BYTES / W);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: tiffPlan streamed boundary unitRows > maxRows mutated to unitRows >= maxRows",
        IT,
        [(
            "    const streamed = !!forceStreamed || unitRows > maxRows;",
            "    const streamed = !!forceStreamed || unitRows >= maxRows;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: tiffPlan ignores forceStreamed option",
        IT,
        [(
            "    const streamed = !!forceStreamed || unitRows > maxRows;",
            "    const streamed = unitRows > maxRows;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: tiffPlan wantRows ignores maxRows cap on multi-strip bands",
        IT,
        [(
            "        const wantRows = Math.min(Math.max(1, rowsPerBand | 0), maxRows);",
            "        const wantRows = Math.max(1, rowsPerBand | 0);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: tiffPlan planar band offset slicing uses seg0 instead of p * planeSegs + seg0",
        IT,
        [(
            "                    const base = p * planeSegs + seg0, dst = p * segCount;",
            "                    const base = seg0, dst = p * segCount;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- renderer/editor/inpaint_tiff.js: inflateInto & readTiffBand ----
    (
        "inpaint_tiff.js: inflateInto skips got < need truncation check",
        IT,
        [(
            "    if (got < need) throw truncated(tiled ? `${name} holds ${got} of ${need} bytes` : `${name} holds fewer bytes than its rows`);",
            "    if (false && got < need) throw truncated(tiled ? `${name} holds ${got} of ${need} bytes` : `${name} holds fewer bytes than its rows`);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: inflateInto swallows damaged deflate reader error instead of wrapping with segment name",
        IT,
        [(
            "        throw new Error(`${name} of the TIFF is damaged or cut off (${(err && err.message) || err})`);",
            "        throw err;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBand contiguous check maxEnd - minOff <= sumCounts + 65536 mutated to < sumCounts (splits out-of-order contiguous strips)",
        IT,
        [(
            "    } else if (maxEnd - minOff <= sumCounts + 65536) {",
            "    } else if (maxEnd - minOff < sumCounts) {",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBand contiguous subarray start ignores offsets[i] - minOff",
        IT,
        [(
            "            const start = offsets[i] - minOff, end = start + counts[i];",
            "            const start = 0, end = start + counts[i];",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBand non-contiguous run loop merges gaps > 65536 into a single slice",
        IT,
        [(
            "            while (j < totalSegs && offsets[j] >= runEnd && offsets[j] - runEnd <= 65536) {",
            "            while (j < totalSegs && offsets[j] >= runEnd) {",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBand tiled per-tile unpredict uses clipped edge stride instead of tileRow",
        IT,
        [(
            "                        if (info.predictor === 2) {\n                            const tu = clock();\n                            K.unpredict(tileBuf, tl, tileRow, tw, perPixel, info.bits, P.le);\n                            sp.unpredict += clock() - tu;\n                        }",
            "                        if (info.predictor === 2) {\n                            const tu = clock();\n                            K.unpredict(tileBuf, tl, Math.ceil(Math.min(tw, info.width - tx * tw) * per), Math.min(tw, info.width - tx * tw), perPixel, info.bits, P.le);\n                            sp.unpredict += clock() - tu;\n                        }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBand tiled Predictor-2 unpredicts across assembled planeBuf rows instead of per tile",
        IT,
        [(
            "                        if (info.predictor === 2) {\n                            const tu = clock();\n                            K.unpredict(tileBuf, tl, tileRow, tw, perPixel, info.bits, P.le);\n                            sp.unpredict += clock() - tu;\n                        }\n                        const px = Math.min(tw, info.width - tx * tw);\n                        const bytes = Math.ceil(px * per), at = Math.floor(tx * tw * per);\n                        const tc = clock();\n                        for (let r = 0; r < tRows; r++) {\n                            planeBuf.set(tileBuf.subarray(r * tileRow, r * tileRow + bytes), (r0 + r) * rowBytes + at);\n                        }\n                        sp.copy += clock() - tc;\n                    }\n                }\n                bufs[p] = planeBuf;",
            "                        const px = Math.min(tw, info.width - tx * tw);\n                        const bytes = Math.ceil(px * per), at = Math.floor(tx * tw * per);\n                        const tc = clock();\n                        for (let r = 0; r < tRows; r++) {\n                            planeBuf.set(tileBuf.subarray(r * tileRow, r * tileRow + bytes), (r0 + r) * rowBytes + at);\n                        }\n                        sp.copy += clock() - tc;\n                    }\n                }\n                if (info.predictor === 2) K.unpredict(planeBuf, rows, rowBytes, info.width, perPixel, info.bits, P.le);\n                bufs[p] = planeBuf;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBand striped unpredict skipped",
        IT,
        [(
            "                if (info.predictor === 2) {\n                    const tu = clock();\n                    K.unpredict(planeBuf, rows, rowBytes, info.width, perPixel, info.bits, P.le);\n                    sp.unpredict += clock() - tu;\n                }",
            "                if (info.predictor === 99) {\n                    const tu = clock();\n                    K.unpredict(planeBuf, rows, rowBytes, info.width, perPixel, info.bits, P.le);\n                    sp.unpredict += clock() - tu;\n                }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBand multi-strip band writes every strip at offset 0 of planeBuf instead of r0 * rowBytes",
        IT,
        [(
            "                    const dst = planeBuf.subarray(r0 * rowBytes, r0 * rowBytes + need);",
            "                    const dst = planeBuf.subarray(0, need);",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- renderer/editor/inpaint_tiff.js: readTiff ----
    (
        "inpaint_tiff.js: readTiff skips !plan.streamed band path and always falls back to StripRows/TileRows",
        IT,
        [(
            "    if (!plan.streamed) {",
            "    if (false && !plan.streamed) {",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiff does not slice out when b.rows > band (rowsPerBand < rps or tl)",
        IT,
        [(
            "            if (b.rows <= band) {",
            "            if (true || b.rows <= band) {",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- renderer/editor/px/kernels.js: tiffUnpack route ----
    (
        "kernels.js: tiffUnpack calls rustPx() without 'tiffUnpack' route name",
        KR,
        [(
            "export function tiffUnpack(compression, src, need, out = null, name = \"strip\") {\n    const p = rustPx(\"tiffUnpack\");",
            "export function tiffUnpack(compression, src, need, out = null, name = \"strip\") {\n    const p = rustPx();",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
]
