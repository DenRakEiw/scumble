TITLE = "P5 (PNG parts that start independent: None/Sub on row 0) + Question 6.5 (parallel upload while decoding in loadFile and addImageLayers)"

WORKING = [
    "crates/px/src/png.rs",
    "renderer/editor/px/px.wasm",
    "renderer/editor/px/px_scalar.wasm",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/inpaint_bands.js",
    "renderer/editor/inpaint_worker.js",
    "renderer/editor/inpaint_canvas.js",
    "tools/px_test.js",
    "tools/editor_test.py",
]

GATES = ["editor"]
TILES = "on"

PX_FILTER_KILL = {"px": ["pngFilter"]}
PX_PART_KILL = {"px": ["pngPart"]}
ED_KILL = {"editor": ["a_scumble_png_opens_through_the_parted_reader"]}

MUTANTS = [
    (
        "png_scalar_allow_up_without_prev",
        "crates/px/src/png.rs",
        [
            (
                "    for t in 1..if up.is_some() { 5u8 } else { 2u8 } {",
                "    for t in 1..5u8 {",
            )
        ],
        "killed: scalar filter_row allows Up/Average/Paeth on row 0 when up is None",
        PX_FILTER_KILL,
    ),
    (
        "png_lanes_allow_up_without_prev",
        "crates/px/src/png.rs",
        [
            (
                "        for t in 1..if UP { 5u8 } else { 2u8 } {",
                "        for t in 1..5u8 {",
            )
        ],
        "killed: SIMD lanes::filter_row allows Up/Average/Paeth on row 0 when UP is false",
        PX_FILTER_KILL,
    ),
    (
        "png_lanes_never_sub_without_prev",
        "crates/px/src/png.rs",
        [
            (
                "        for t in 1..if UP { 5u8 } else { 2u8 } {",
                "        for t in 1..if UP { 5u8 } else { 1u8 } {",
            )
        ],
        "killed: off-by-one 1..1u8 in lanes::filter_row never picks Sub (1) when UP is false",
        PX_FILTER_KILL,
    ),
    (
        "js_allow_up_without_prev",
        "renderer/editor/px/kernels_js.js",
        [
            (
                "        if (y > 0 || prev) {\n            if (s2 < min) { best = 2; min = s2; }\n            if (s3 < min) { best = 3; min = s3; }\n            if (s4 < min) { best = 4; min = s4; }\n        }",
                "        if (s2 < min) { best = 2; min = s2; }\n        if (s3 < min) { best = 3; min = s3; }\n        if (s4 < min) { best = 4; min = s4; }",
            )
        ],
        "killed: JS twin pngFilterRows allows Up/Average/Paeth on row 0 when prev is null",
        PX_FILTER_KILL,
    ),
    (
        "bands_write_png_need_prev_true",
        "renderer/editor/inpaint_bands.js",
        [
            (
                "    await forParts(source, async (y, n) => {\n        await writer.room();\n        const { args, transfer } = await source.part(y, n, false);\n        writer.add(n, args, transfer);",
                "    await forParts(source, async (y, n) => {\n        await writer.room();\n        const { args, transfer } = await source.part(y, n, true);\n        writer.add(n, args, transfer);",
            )
        ],
        "killed: writePng passes needPrev=true to source.part so non-first parts depend on the row above",
        PX_PART_KILL,
    ),
    (
        "worker_png_part_ptr_need_prev_true",
        "renderer/editor/inpaint_worker.js",
        [
            (
                "            const ptrs = partPtrOf(p, a, msg, false);",
                "            const ptrs = partPtrOf(p, a, msg, true);",
            )
        ],
        "killed: worker pngPart wasm-gather path passes needPrev=true to partPtrOf",
        PX_PART_KILL,
    ),
    (
        "worker_png_part_js_gather_prev",
        "renderer/editor/inpaint_worker.js",
        [
            (
                "    const prev = msg.rgba && msg.prev ? new Uint8Array(msg.prev, 0, msg.w * 4) : null;",
                "    const prev = msg.rgba ? (msg.prev ? new Uint8Array(msg.prev, 0, msg.w * 4) : null) : msg.stack ? rowsOfStack(msg, true) : rowsOfTiles(msg, true);",
            )
        ],
        "killed: worker pngPart JS-gather fallback gathers the row above for stack and tile parts",
        PX_PART_KILL,
    ),
    (
        "canvas_load_upload_before_check_base_size",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                '            const big = this.tileMode ? (await hugePngSize(file)) || (await imageFileSize(file)) : null;\n            if (big) this.checkBaseSize(big.width, big.height);\n            if (later()) return;\n            this.setStatus("Uploading " + (file.name || "image") + " ...");\n            const stem = (file.name || "pasted").replace(/\\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";\n            const up = uploadBlob(file, stem + ext, { overwrite: false });',
                '            this.setStatus("Uploading " + (file.name || "image") + " ...");\n            const stem = (file.name || "pasted").replace(/\\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";\n            const up = uploadBlob(file, stem + ext, { overwrite: false });\n            const big = this.tileMode ? (await hugePngSize(file)) || (await imageFileSize(file)) : null;\n            if (big) this.checkBaseSize(big.width, big.height);\n            if (later()) return;',
            )
        ],
        "killed: loadFile starts uploadBlob before checkBaseSize",
        ED_KILL,
    ),
    (
        "canvas_layer_upload_before_check_base_size",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                '                    const big = this.tileMode ? (await hugePngSize(file)) || (await imageFileSize(file)) : null;\n                    if (big) this.checkBaseSize(big.width, big.height);\n                    this.setStatus(`Uploading ${file.name || "image"} ...`);\n                    const stem = (file.name || "image").replace(/\\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";\n                    const up = uploadBlob(file, stem + ext, { overwrite: false });',
                '                    this.setStatus(`Uploading ${file.name || "image"} ...`);\n                    const stem = (file.name || "image").replace(/\\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";\n                    const up = uploadBlob(file, stem + ext, { overwrite: false });\n                    const big = this.tileMode ? (await hugePngSize(file)) || (await imageFileSize(file)) : null;\n                    if (big) this.checkBaseSize(big.width, big.height);',
            )
        ],
        "killed: addImageLayers starts uploadBlob before checkBaseSize",
        ED_KILL,
    ),
    (
        "canvas_load_sequential_upload_then_decode",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                '                if (big) px = await pixelsOffThread(file, this.pixels.Layer, (f) => { if (!later()) this.setStatus(`Reading ${big.width} × ${big.height} px ... ${Math.round(f * 100)} %`); });\n                ref = await up;',
                '                ref = await up;\n                if (big) px = await pixelsOffThread(file, this.pixels.Layer, (f) => { if (!later()) this.setStatus(`Reading ${big.width} × ${big.height} px ... ${Math.round(f * 100)} %`); });',
            )
        ],
        "killed: loadFile awaits uploadBlob before starting pixelsOffThread instead of running in parallel",
        ED_KILL,
    ),
    (
        "canvas_layer_sequential_upload_then_decode",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "                        if (big) px = await pixelsOffThread(file, this.pixels.Layer);\n                        ref = await up;",
                "                        ref = await up;\n                        if (big) px = await pixelsOffThread(file, this.pixels.Layer);",
            )
        ],
        "killed: addImageLayers awaits uploadBlob before starting pixelsOffThread instead of running in parallel",
        ED_KILL,
    ),
    (
        "canvas_load_no_release_on_upload_reject",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                '                if (big) px = await pixelsOffThread(file, this.pixels.Layer, (f) => { if (!later()) this.setStatus(`Reading ${big.width} × ${big.height} px ... ${Math.round(f * 100)} %`); });\n                ref = await up;\n            } catch (err) {\n                if (px) px.release();\n                throw err;\n            }',
                '                if (big) px = await pixelsOffThread(file, this.pixels.Layer, (f) => { if (!later()) this.setStatus(`Reading ${big.width} × ${big.height} px ... ${Math.round(f * 100)} %`); });\n                ref = await up;\n            } catch (err) {\n                throw err;\n            }',
            )
        ],
        "killed: loadFile leaks decoded TileLayerPixels when uploadBlob rejects after pixelsOffThread resolves",
        ED_KILL,
    ),
    (
        "canvas_layer_no_release_on_upload_reject",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                "                        if (big) px = await pixelsOffThread(file, this.pixels.Layer);\n                        ref = await up;\n                    } catch (err) {\n                        if (px) px.release();\n                        throw err;\n                    }",
                "                        if (big) px = await pixelsOffThread(file, this.pixels.Layer);\n                        ref = await up;\n                    } catch (err) {\n                        throw err;\n                    }",
            )
        ],
        "killed: addImageLayers leaks decoded TileLayerPixels when uploadBlob rejects after pixelsOffThread resolves",
        ED_KILL,
    ),
    (
        "canvas_load_no_catch_on_up",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                '            const stem = (file.name || "pasted").replace(/\\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";\n            const up = uploadBlob(file, stem + ext, { overwrite: false });\n            up.catch(() => {});',
                '            const stem = (file.name || "pasted").replace(/\\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";\n            const up = uploadBlob(file, stem + ext, { overwrite: false });',
            )
        ],
        "killed: loadFile leaves uploadBlob rejection unhandled when pixelsOffThread throws first",
        ED_KILL,
    ),
    (
        "canvas_layer_no_catch_on_up",
        "renderer/editor/inpaint_canvas.js",
        [
            (
                '                    const stem = (file.name || "image").replace(/\\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";\n                    const up = uploadBlob(file, stem + ext, { overwrite: false });\n                    up.catch(() => {});',
                '                    const stem = (file.name || "image").replace(/\\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._-]/gi, "_") || "image";\n                    const up = uploadBlob(file, stem + ext, { overwrite: false });',
            )
        ],
        "killed: addImageLayers leaves uploadBlob rejection unhandled when pixelsOffThread throws first",
        ED_KILL,
    ),
]
