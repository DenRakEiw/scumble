/**
 * The stitch worker: a provider run's crop and stitch (stitch.js `prepareCropAsync` / `finishResultAsync`) off the
 * window. App only, like stitch.js; the steps are stitch.js's own (`stitchJob`), on OffscreenCanvases and the pixel
 * kernels of this thread.
 *
 * Jobs (`{ id, op, kernels, ... }`, the reply `{ id, ok, ... }` with its buffers transferred):
 *   plan    the selection's window (RGBA bytes) and the run's settings -> the crop's geometry and the window as floats
 *   crop    the plan, the floats and the crop box's composite (RGBA bytes) -> the crop, mask and maskAlpha as PNG bytes
 *   finish  the run's info, the floats, the answer's file bytes and (for a colour match) the box's composite -> the
 *           patch as PNG bytes and whether it carries real transparency
 */
import { stitchJob } from "./stitch.js";
import { kernelsReady, setKernels } from "./px/kernels.js";

self.onmessage = async (e) => {
    const msg = e.data || {};
    try {
        setKernels(msg.kernels);
        await kernelsReady();
        const result = await stitchJob(msg);
        const transfer = result.transfer || [];
        delete result.transfer;
        self.postMessage({ id: msg.id, ok: true, ...result }, transfer);
    } catch (err) {
        self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
    }
};
