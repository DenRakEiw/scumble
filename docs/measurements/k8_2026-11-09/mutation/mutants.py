TITLE = "K8 (parted PNG reader: pngPartsOf, readPngParts, png_part_read, png_part_finish, pixelsFromPngStream)"

WORKING = [
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_png.js",
    "renderer/editor/inpaint_worker.js",
    "renderer/editor/inpaint_canvas.js",
    "tools/px_test.js",
    "tools/editor_test.py",
]

GATES = ["editor"]
TILES = "on"

PX_KILL = {"px": ["pngPart"]}
ED_KILL = {"editor": ["a_scumble_png_opens_through_the_parted_reader"]}

MUTANTS = [
    (
        "parts_of_allow_interlaced",
        "renderer/editor/inpaint_png.js",
        [("h.interlace !== 0", "h.interlace < 0")],
        "killed: pngPartsOf accepts an interlaced IHDR",
        PX_KILL,
    ),
    (
        "parts_of_allow_gama",
        "renderer/editor/inpaint_png.js",
        [('type === "gAMA"', 'type === "gAMX"')],
        "killed: pngPartsOf accepts a gAMA chunk before IDAT",
        PX_KILL,
    ),
    (
        "parts_of_skip_cm",
        "renderer/editor/inpaint_png.js",
        [("(cmf & 0x0f) !== 8", "false")],
        "killed: pngPartsOf accepts a 2-byte header IDAT with CM != 8 and valid FCHECK",
        PX_KILL,
    ),
    (
        "parts_of_skip_cinfo",
        "renderer/editor/inpaint_png.js",
        [("(cmf >> 4) > 7", "false")],
        "killed: pngPartsOf accepts a 2-byte header IDAT with CINFO > 7 and valid FCHECK",
        PX_KILL,
    ),
    (
        "parts_of_skip_fcheck",
        "renderer/editor/inpaint_png.js",
        [("(((cmf << 8) | flg) % 31) !== 0", "false")],
        "killed: pngPartsOf accepts a 2-byte header IDAT with a bad zlib FCHECK",
        PX_KILL,
    ),
    (
        "parts_of_zero_part_idats_ok",
        "renderer/editor/inpaint_png.js",
        [("idats.length < 2", "idats.length < 1")],
        "killed: pngPartsOf accepts a PNG with 0 part IDATs (only 2-B header + 4-B tail)",
        PX_KILL,
    ),
    (
        "parts_of_tail_len_gt_4",
        "renderer/editor/inpaint_png.js",
        [("if (tail.len !== 4) return null;", "if (tail.len < 4) return null;")],
        "killed: pngPartsOf accepts a tail IDAT longer than 4 bytes",
        PX_KILL,
    ),
    (
        "read_parts_finish_normal_prio",
        "renderer/editor/inpaint_png.js",
        [("{ priority: 0, group, timeout: 600000 }", "{ priority: 1, group, timeout: 600000 }")],
        "killed: png_part_finish submitted at NORMAL priority 1 instead of INTERACTIVE priority 0",
        PX_KILL,
    ),
    (
        "read_parts_skip_adler_check",
        "renderer/editor/inpaint_png.js",
        [("if ((adler >>> 0) !== (wantAdler >>> 0))", "if (false)")],
        "killed: readPngParts ignores combined Adler-32 mismatch against the 4-byte tail IDAT",
        PX_KILL,
    ),
    (
        "read_parts_skip_over_height_check",
        "renderer/editor/inpaint_png.js",
        [("y0 + cur.rows > height", "false")],
        "killed: readPngParts delivers rows past IHDR height when parts exceed height",
        PX_KILL,
    ),
    (
        "read_parts_skip_height_check",
        "renderer/editor/inpaint_png.js",
        [("if (y0 !== height)", "if (false)")],
        "killed: readPngParts accepts fewer decoded rows than IHDR height",
        PX_KILL,
    ),
    (
        "read_parts_skip_cancel_on_throw",
        "renderer/editor/inpaint_png.js",
        [
            (
                '    } catch (err) {\n        if (typeof pool.cancel === "function") pool.cancel(group);\n        throw err;\n    }',
                "    } catch (err) {\n        throw err;\n    }",
            )
        ],
        "killed: readPngParts does not cancel the pool group when a post-decode check throws",
        PX_KILL,
    ),
    (
        "worker_append_0300_on_last",
        "renderer/editor/inpaint_worker.js",
        [
            (
                "if (!last && !stop) await writer.write(PART_TAIL_0300);",
                "if (!stop) await writer.write(PART_TAIL_0300);",
            )
        ],
        "killed: appending 03 00 to the last part (which already ends on a final block) is rejected by Chromium's DecompressionStream",
        ED_KILL,
    ),
    (
        "worker_ignore_ihdr_cap",
        "renderer/editor/inpaint_worker.js",
        [("const cap = Math.min(pCap, hCap);", "const cap = pCap;")],
        "killed: pngPartRead fails to bound part inflation by IHDR height * stride when smaller than pngPartLinesCap(w)",
        ED_KILL,
    ),
    (
        "worker_read_bytes_after_transfer",
        "renderer/editor/inpaint_worker.js",
        [
            (
                "return { lines, inBytes, readMs: t1 - t0, inflateMs: t2 - t1 };",
                "return { lines, inBytes: bytes.byteLength, readMs: t1 - t0, inflateMs: t2 - t1 };",
            )
        ],
        "killed: reading bytes.byteLength after transfer(0) reports timing.bytes = 0 on every png_part_read job",
        ED_KILL,
    ),
    (
        "worker_read_drop_rt",
        "renderer/editor/inpaint_worker.js",
        [
            (
                "const r = pngPartDecode(lines, w, prev, rt, null, laps);",
                "const r = pngPartDecode(lines, w, prev, null, null, laps);",
            )
        ],
        "killed: pngPartRead drops msg.rt so non-fixed-point straight RGBA bytes are not normalized in png_part_decode",
        ED_KILL,
    ),
    (
        "worker_finish_drop_rt",
        "renderer/editor/inpaint_worker.js",
        [
            (
                "const r = pngPartFinish(lines, rows, w, prev, rt, null, laps);",
                "const r = pngPartFinish(lines, rows, w, prev, null, null, laps);",
            )
        ],
        "killed: pngPartFinishJob drops msg.rt so non-fixed-point straight RGBA bytes are not normalized in png_part_finish",
        ED_KILL,
    ),
    (
        "canvas_rt_null",
        "renderer/editor/inpaint_canvas.js",
        [("rt: canvasRoundTrip(),", "rt: null,")],
        "killed: pixelsFromPngStream passes rt: null to readPngParts, leaving non-fixed-point straight RGBA bytes un-normalized",
        ED_KILL,
    ),
    (
        "canvas_no_release_on_part_err",
        "renderer/editor/inpaint_canvas.js",
        [("if (px) { px.release(); px = null; }", "if (px) { px = null; }")],
        "killed: pixelsFromPngStream fails to release partial TileLayerPixels when a later part fails after earlier parts landed",
        ED_KILL,
    ),
    (
        "canvas_no_fallback_on_part_err",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                'console.warn("Inpaint Canvas: the PNG could not be read in parts, using png_read:", (err && err.message) || err);',
                "throw err;",
            )
        ],
        "killed: pixelsFromPngStream fails to fall back to png_read when readPngParts throws",
        ED_KILL,
    ),
]
