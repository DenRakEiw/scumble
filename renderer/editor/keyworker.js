// The Key screen's app-only module worker (docs/PLAN_CORRIDORKEY.md §4.5 step 2, §4.7 point 3, decision (b) of §6):
// the matte at the bucket's size back to the layer's box, band by band, off the window's thread. Started by
// renderer/editor/host.js on the first key (as stitch.js starts stitch_worker.js); imported from no shipped file and
// not in tools/build_node.py FILES, so the node never sees it.
//
//   { id, op: "matte", mid, alpha: Float32Array, fg: Uint8Array (RGB), bw, bh }  keep a matte under `mid`
//   { id, op: "rows", mid, map, outW, y0, rows, alpha?: bool, fg?: bool }        -> { a: Uint8Array, rgba: Uint8ClampedArray }
//   { id, op: "refine", mid, opts }          the refine of a scaled matte prepared (keymatte.js prepareRefine: opts
//                                           { small, src, full, out }) -> { halo, sample, soft, residual, fitMs, method }
//   { id, op: "refineSample", mid, rgba }    the noise sample's full-resolution rows -> { noise, guideDiff, fallback }
//   { id, op: "refineBand", mid, band, rgba } one band of keymatte.bandPlan, its rows with the halo -> { a: Uint8Array }
//   { id, op: "drop", mid }                                                       forget it
//
// Every answer is { id, ok: true, ... } or { id, ok: false, error }. The rows are keying.bilinearRows (the floats
// sampled bilinearly, never through a canvas); the refine's steps are keying.refineOp (I6, renderer/editor/keymatte.js:
// the matte's alpha refined against the full-resolution picture rows of the same picture the bucket was read from;
// importing it loads px.wasm here for its box blurs). The foreground stays the bilinear rows.

import { bilinearRows, refineOp } from "./keying.js";
import { kernelsReady } from "./px/kernels.js";

const MATTES = new Map();

// one message at a time, in the order sent: a refine step waits for this thread's Rust kernels first (the box blurs of
// keymatte.js then run in Rust as in the window, so a refine answers the same bytes here and there)
let chain = Promise.resolve();
self.onmessage = (e) => { chain = chain.then(() => handle(e.data || {})); };

async function handle(m) {
    try {
        if (m.op === "matte") {
            MATTES.set(m.mid, { alpha: m.alpha, fg: m.fg, bw: m.bw, bh: m.bh });
            self.postMessage({ id: m.id, ok: true });
        } else if (m.op === "rows") {
            const t = MATTES.get(m.mid);
            if (!t) throw new Error("no matte " + m.mid);
            const { a, rgba } = bilinearRows(m.alpha === false ? null : t.alpha, m.fg === false ? null : t.fg, t.bw, m.map, m.outW, m.y0, m.rows);
            const transfer = [];
            if (a) transfer.push(a.buffer);
            if (rgba) transfer.push(rgba.buffer);
            self.postMessage({ id: m.id, ok: true, a, rgba }, transfer);
        } else if (m.op === "refine" || m.op === "refineSample" || m.op === "refineBand") {
            const t = MATTES.get(m.mid);
            if (!t) throw new Error("no matte " + m.mid);
            await kernelsReady();
            const { answer, transfer } = refineOp(t, m);
            self.postMessage({ id: m.id, ok: true, ...answer }, transfer);
        } else if (m.op === "drop") {
            MATTES.delete(m.mid);
            self.postMessage({ id: m.id, ok: true });
        } else {
            throw new Error("unknown op " + m.op);
        }
    } catch (err) {
        self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
    }
}
