"""K18 mutation round config for tools/mutation_round.py (docs/PLAN_WASM_BUILD.md §4.6)."""

TITLE = "K18 (parallel tiff_band worker dispatch, per-band spec payload, NORMAL priority, later cancellation, fallback to tiff_read, tiffBandRows)"

WORKING = [
    "renderer/editor/inpaint_tiff.js",
    "renderer/editor/px/kernels_js.js",
    "renderer/editor/px/kernels.js",
    "renderer/editor/inpaint_worker.js",
    "renderer/editor/inpaint_canvas.js",
    "tools/px_test.js",
    "tools/tiff_test.js",
    "tools/tiff_test.py",
]

GATES = []
TILES = "on"

IT = "renderer/editor/inpaint_tiff.js"
WK = "renderer/editor/inpaint_worker.js"
CV = "renderer/editor/inpaint_canvas.js"

MUTANTS = [
    # ---- renderer/editor/inpaint_tiff.js: tiffPlan spec & readTiffBands ----
    (
        "inpaint_tiff.js: tiffPlan puts raw colormap array on spec alongside precomputed pal",
        IT,
        [(
            "        pal,\n    };\n    const bands = [];",
            "        pal,\n        colormap: layout.colormap,\n    };\n    const bands = [];",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBands ignores plan.streamed instead of returning null",
        IT,
        [(
            "    if (plan.streamed || !plan.bands || !plan.bands.length) return null;",
            "    if (false && (plan.streamed || !plan.bands || !plan.bands.length)) return null;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBands posts full plan instead of spec to tiff_band",
        IT,
        [(
            "                { blob, spec, band },",
            "                { blob, spec: plan, band },",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBands posts tiff_band at EXPORT priority (2) instead of caller priority",
        IT,
        [(
            "                { priority, group, timeout: 600000 },",
            "                { priority: 2, group, timeout: 600000 },",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBands removes maxInFlight window bound",
        IT,
        [(
            "    const maxInFlight = Math.max(1, (pool.size | 0) || 8) * 2;",
            "    const maxInFlight = 1e9;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBands passes y0 = 0 instead of band.y0 to onRows",
        IT,
        [(
            "                    const p = onRows ? onRows(view, y0, rows) : null;",
            "                    const p = onRows ? onRows(view, 0, rows) : null;",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBands skips later() check when band reply arrives",
        IT,
        [(
            "                if (isLater && isLater()) {\n                    inFlight--;\n                    if (r && r.rgba) detachBuffer(r.rgba);\n                    stopCancel();\n                    return;\n                }",
            "                if (false) { return; }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBands skips finishBand later() check after onRows",
        IT,
        [(
            "                        if (isLater && isLater()) { stopCancel(); return; }",
            "                        if (false) { stopCancel(); return; }",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_tiff.js: readTiffBands skips pool.cancel(group) on cancellation and band error",
        IT,
        [(
            "    const cancelGroup = () => {\n        if (typeof pool.cancel === \"function\") pool.cancel(group);\n    };",
            "    const cancelGroup = () => {};",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    # ---- renderer/editor/inpaint_worker.js: tiffBandJob & worker dispatch ----
    (
        "inpaint_worker.js: tiffBandJob passes kernels: null instead of tiffKernels()",
        WK,
        [(
            "    const rgba = await readTiffBand(msg.blob, spec, band, { spent, kernels: tiffKernels() });",
            "    const rgba = await readTiffBand(msg.blob, spec, band, { spent, kernels: null });",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_worker.js: tiffBandJob returns y0 = 0 instead of band.y0",
        WK,
        [(
            "    return {\n        rgba: buf,\n        y0,",
            "    return {\n        rgba: buf,\n        y0: 0,",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_worker.js: tiffBandJob omits transfer: [buf] on reply",
        WK,
        [(
            "        transfer: [buf],\n        timing: {\n            op: \"tiff_band\",",
            "        transfer: [],\n        timing: {\n            op: \"tiff_band\",",
        )],
        "killed",
        {"px": ["tiff"]},
    ),
    (
        "inpaint_worker.js: run(msg) omits tiff_band dispatch",
        WK,
        [(
            "    if (msg.op === \"tiff_band\") return tiffBandJob(msg);",
            "    if (false && msg.op === \"tiff_band\") return tiffBandJob(msg);",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    # ---- renderer/editor/inpaint_canvas.js: pixelsFromTiff & loadTiff ----
    (
        "inpaint_canvas.js: pixelsFromTiff ignores InpaintEditor.tiffBandRows > 0 knob",
        CV,
        [(
            "    const rowsPerBand = bandSetting > 0 ? (bandSetting | 0) : TILE_SIZE;",
            "    const rowsPerBand = TILE_SIZE;",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_canvas.js: pixelsFromTiff ignores InpaintEditor.tiffBandRows === false override",
        CV,
        [(
            "    if (bandSetting !== false && tiffPoolUsable(blob)) {",
            "    if (tiffPoolUsable(blob)) {",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_canvas.js: pixelsFromTiff falls back to tiff_read on CancelledError instead of rethrowing",
        CV,
        [(
            "            resetTarget();\n            if ((err && err.cancelled) || (isLater && isLater())) throw new CancelledError(\"tiff_open\");",
            "            resetTarget();\n            if (false) throw new CancelledError(\"tiff_open\");",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_canvas.js: pixelsFromTiff skips resetTarget() (px.release()) before tiff_read fallback on band error",
        CV,
        [(
            "        } catch (err) {\n            resetTarget();\n            if ((err && err.cancelled) || (isLater && isLater())) throw new CancelledError(\"tiff_open\");",
            "        } catch (err) {\n            if ((err && err.cancelled) || (isLater && isLater())) { resetTarget(); throw new CancelledError(\"tiff_open\"); }",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_canvas.js: pixelsFromTiff rethrows band error instead of falling back to tiff_read",
        CV,
        [(
            "            console.warn(\"Inpaint Canvas: reading the TIFF in bands failed, using tiff_read:\", (err && err.message) || err);",
            "            throw err;",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_canvas.js: pixelsFromTiff posts tiff_read fallback at EXPORT priority instead of NORMAL",
        CV,
        [(
            "                const r = await editorPool().run(\"tiff_read\", { blob, rowsPerBand }, [], {\n                    priority: NORMAL,",
            "                const r = await editorPool().run(\"tiff_read\", { blob, rowsPerBand }, [], {\n                    priority: EXPORT,",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_canvas.js: loadTiff fails to forward later callback to pixelsFromTiff",
        CV,
        [(
            "            ({ px, info: got, writeMs } = await pixelsFromTiff(file, this.pixels.Layer, (f) => { if (!later()) this.setStatus(`Reading ${info.width} × ${info.height} px ... ${Math.round(f * 100)} %`); }, later));",
            "            ({ px, info: got, writeMs } = await pixelsFromTiff(file, this.pixels.Layer, (f) => { if (!later()) this.setStatus(`Reading ${info.width} × ${info.height} px ... ${Math.round(f * 100)} %`); }, null));",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_canvas.js: tiffPoolUsable requires partsUsable() (kernelsMode === rust)",
        CV,
        [(
            "function tiffPoolUsable(blob) {\n    return typeof Worker === \"function\" && typeof Blob === \"function\" && blob instanceof Blob && !editorPool().off;\n}",
            "function tiffPoolUsable(blob) {\n    return partsUsable() && typeof Worker === \"function\" && typeof Blob === \"function\" && blob instanceof Blob && !editorPool().off;\n}",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_canvas.js: pixelsFromTiff reports (y0 + n) / H instead of rowsDone / H to progress",
        CV,
        [(
            "        rowsDone += n;\n        if (progress) progress(rowsDone / H);",
            "        rowsDone += n;\n        if (progress) progress((y0 + n) / H);",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_canvas.js: resetTarget omits resetting rowsDone = 0 before fallback",
        CV,
        [(
            "        W = 0; H = 0; writeMs = 0; rowsDone = 0;",
            "        W = 0; H = 0; writeMs = 0;",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
    (
        "inpaint_canvas.js: pixelsFromTiff skips needWindowFallback when pool turns off on tiff_read",
        CV,
        [(
            "                if (editorPool().off && !px) needWindowFallback = true;\n                else throw err;",
            "                throw err;",
        )],
        "killed",
        {"gates": ["tiff"]},
    ),
]
