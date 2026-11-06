/**
 * The stitch worker: a provider run's crop and stitch (stitch.js `prepareCropAsync` / `finishResultAsync`) off the
 * window. App only, like stitch.js; the steps are stitch.js's own (`stitchJob`), on OffscreenCanvases and the pixel
 * kernels of this thread.
 *
 * Jobs (`{ id, op, kernels, routes, ... }`, the reply `{ id, ok, ..., pxCalls }` with its buffers transferred):
 *   plan    the selection's window (RGBA bytes) and the run's settings -> the crop's geometry and the window as floats
 *   crop    the plan, the floats and the crop box's composite (RGBA bytes) -> the crop, mask and maskAlpha as PNG bytes
 *   finish  the run's info, the floats, the answer's file bytes and (for a colour match) the box's composite -> the
 *           patch as PNG bytes and whether it carries real transparency
 */
import { stitchJob } from "./stitch.js";
import { kernelsReady, setKernels, adoptRoutes, pxCalls, pxJobStart, pxJobEnd } from "./px/kernels.js";

// The reply's `pxCalls`: this thread's Rust kernel calls during the job (docs/PLAN_WASM_BUILD.md §3.4). The counters
// start from zero when a job starts in an idle worker; a job that overlaps another (two tabs' runs) counts both. A job
// holds this thread's instance (`pxJobStart` / `pxJobEnd`), so the idle trim never fires inside one.
let inFlight = 0;

self.onmessage = async (e) => {
    const msg = e.data || {};
    if (!inFlight++) pxCalls(true);
    pxJobStart();
    try {
        setKernels(msg.kernels);
        adoptRoutes(msg.routes);
        await kernelsReady();
        const result = await stitchJob(msg);
        const transfer = result.transfer || [];
        delete result.transfer;
        self.postMessage({ id: msg.id, ok: true, ...result, pxCalls: pxCalls() }, transfer);
    } catch (err) {
        self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err), pxCalls: pxCalls() });
    } finally {
        inFlight--;
        pxJobEnd();
    }
};
