"""K20b review mutation round for tools/mutation_round.py: K20b's 24 mutants (../../k20b_2026-11-10/mutation/mut_k20b.py)
again on the reviewed code, and the review's: the acknowledgement window (worker, pool, window, reader), the window
reader's dangling PackBits repeat (K20b-T2), and the mutants of docs/PLAN_WASM_K20.md §4.2 the first round left out
(K20b-D1: `2 * h + total > dataLen`, `DEFLATE_MAX_RATIO`, the planar 8-bit shuffle lanes, gray replication, the psdRead
route lookup, the mask's top and bottom default fill, the PackBits literal clamp), each with the layered gate (which runs
tools/layered_test.js first, the crafted files) in its kill set where px_test alone may not see it.

    python tools/mutation_round.py make TREE docs/measurements/k20b_review_2026-11-10/mutation/mut_k20b_review.py
    python tools/mutation_round.py run TREE OUT docs/measurements/k20b_review_2026-11-10/mutation/mut_k20b_review.py orig ... --port 9621 --lock LOCK
"""
import importlib.util
import os

_old_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "k20b_2026-11-10", "mutation", "mut_k20b.py")
_spec = importlib.util.spec_from_file_location("mut_k20b_first_round", _old_path)
_old = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_old)

TITLE = "K20b review (K20b's 24 mutants again, the acknowledgement window, T2's window reader, D1's left-out mutants)"

WORKING = list(_old.WORKING) + ["renderer/editor/inpaint_canvas.js", "renderer/editor/inpaint_pool.js"]
GATES = ["layered"]
TILES = "on"

PSD_RS = "crates/px/src/psd.rs"
TIFF_RS = "crates/px/src/tiff.rs"
LAYERED_JS = "renderer/editor/inpaint_layered.js"
KERNELS_JS = "renderer/editor/px/kernels.js"
WORKER_JS = "renderer/editor/inpaint_worker.js"
CANVAS_JS = "renderer/editor/inpaint_canvas.js"
POOL_JS = "renderer/editor/inpaint_pool.js"

PX = {"px": ["psd"]}
PX_LAYERED = {"px": ["psd"], "gates": ["layered"]}
LAYERED = {"gates": ["layered"]}

MUTANTS = list(_old.MUTANTS) + [
    # ---- the acknowledgement window (K20b-T1) ----
    (
        "inpaint_worker.js: psdRead never waits (onRows returns nothing: unpaced whatever the window)",
        WORKER_JS,
        [("                return pace && sent - pace.done >= win ? caughtUp() : undefined;", "                return undefined;")],
        "killed",
        PX_LAYERED,
    ),
    (
        "inpaint_worker.js: psdAck counts one band per ack instead of taking n",
        WORKER_JS,
        [("    pace.done = Math.max(pace.done, msg.n | 0);", "    pace.done++;")],
        "killed",
        PX_LAYERED,
    ),
    (
        "inpaint_worker.js: psdRead waits one band late (sent - done > win)",
        WORKER_JS,
        [("                return pace && sent - pace.done >= win ? caughtUp() : undefined;", "                return pace && sent - pace.done > win ? caughtUp() : undefined;")],
        "killed",
        PX_LAYERED,
    ),
    (
        "inpaint_layered.js: streamChannelDescs does not await onRows' promise",
        LAYERED_JS,
        [("        if (paced && typeof paced.then === \"function\") { await paced; sp.wait += clock() - t1; }", "        if (paced && typeof paced.then === \"function\") { sp.wait += clock() - t1; }")],
        "killed",
        PX_LAYERED,
    ),
    (
        "inpaint_canvas.js: readPsdOnPool never acknowledges a band",
        CANVAS_JS,
        [("                        if (win) pool.ack(m.id, bands);", "                        if (false) pool.ack(m.id, bands);")],
        "killed",
        LAYERED,
    ),
    (
        "inpaint_canvas.js: readPsdOnPool sends no window to the worker (always unpaced)",
        CANVAS_JS,
        [("{ blob: file, window: win }", "{ blob: file }")],
        "killed",
        LAYERED,
    ),
    (
        "inpaint_pool.js: ack goes to a worker that does not run the job",
        POOL_JS,
        [("        const s = this.workers.find((x) => x.job && x.job.id === id);", "        const s = this.workers.find((x) => x.job && x.job.id !== id);")],
        "killed",
        LAYERED,
    ),
    # ---- K20b-T2: the window reader's dangling PackBits repeat ----
    (
        "inpaint_layered.js: unpackRows' dangling repeat reads the next row's first byte (src[p++] without p < lim)",
        LAYERED_JS,
        [("                out.fill(p < lim ? src[p++] : 0, o, o + c);", "                out.fill(src[p++], o, o + c);")],
        "killed",
        LAYERED,
    ),
    # ---- K20b-D1: docs/PLAN_WASM_K20.md §4.2's mutants the first round left out ----
    (
        "inpaint_layered.js: prepareChannel drops 2 * h + total > dataLen (RLE rows past the channel's length)",
        LAYERED_JS,
        [(" || 2 * h + total > dataLen) throw tooShort(what, w, h);\n        if (!keep) return null;", ") throw tooShort(what, w, h);\n        if (!keep) return null;")],
        "killed",
        PX_LAYERED,
    ),
    (
        "inpaint_layered.js: prepareChannel drops the DEFLATE_MAX_RATIO upfront refusal",
        LAYERED_JS,
        [("        if (size > dataLen * DEFLATE_MAX_RATIO) throw tooShort(what, w, h);\n        const bomb", "        if (false && size > dataLen * DEFLATE_MAX_RATIO) throw tooShort(what, w, h);\n        const bomb")],
        "killed",
        PX_LAYERED,
    ),
    (
        "kernels.js: PSD_RUST.bandRgba ignores the psdRead route",
        KERNELS_JS,
        [("        const p = rustPx(\"psdRead\") && rustPx(\"tiffUnpredict\") && rustPx(\"tiffToRgba\");", "        const p = rustPx(\"tiffUnpredict\") && rustPx(\"tiffToRgba\");")],
        "killed",
        PX_LAYERED,
    ),
    (
        "tiff.rs: planar_row_8 SIMD swaps two output lanes (out1 8, 9 -> 9, 8)",
        TIFF_RS,
        [("let out1 = u8x16_shuffle::<8, 9, 24, 25, 10, 11, 26, 27, 12, 13, 28, 29, 14, 15, 30, 31>(rg_lo, ba_lo);", "let out1 = u8x16_shuffle::<9, 8, 24, 25, 10, 11, 26, 27, 12, 13, 28, 29, 14, 15, 30, 31>(rg_lo, ba_lo);")],
        "killed",
        PX,
    ),
    (
        "tiff.rs: planar_row_8 SIMD gray does not replicate into blue (vb = 255)",
        TIFF_RS,
        [("                    v128_load(p2_ptr.add(x) as *const v128),\n                )\n            } else {\n                (vr, vr)\n", "                    v128_load(p2_ptr.add(x) as *const v128),\n                )\n            } else {\n                (vr, ff)\n")],
        "killed",
        PX,
    ),
    (
        "psd.rs: mask_rgba skips the top default fill (rows above ry0)",
        PSD_RS,
        [("    if ry0 > 0 {\n        fill_mask_rgba(", "    if false && ry0 > 0 {\n        fill_mask_rgba(")],
        "killed",
        PX,
    ),
    (
        "psd.rs: mask_rgba skips the bottom default fill (rows from ry1)",
        PSD_RS,
        [("    if ry1 < rows {\n        fill_mask_rgba(", "    if false && ry1 < rows {\n        fill_mask_rgba(")],
        "killed",
        PX,
    ),
    (
        "psd.rs: packbits_rows literal run not clamped at the row's end (lim - p)",
        PSD_RS,
        [("                let c = run.min(row_bytes - o).min(lim - p);", "                let c = run.min(row_bytes - o);")],
        "killed",
        PX,
    ),
]
