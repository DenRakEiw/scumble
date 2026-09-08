// Background removal (BiRefNet, RMBG) through ONNX Runtime: one 1024 × 1024 RGB input,
// one alpha matte out. The models differ only in normalisation (registry entry) and in
// whether the output is a logit (BiRefNet) or already a probability (RMBG-1.4), which
// is detected from the value range.
"use strict";

const { normalise } = require("./sam2");

class Matting {
    /**
     * @param {import("./runtime").Runtime} runtime
     * @param {object} model registry entry (input, mean, std)
     * @param {string} file the .onnx path
     */
    constructor(runtime, model, file) {
        this.runtime = runtime;
        this.model = model;
        this.file = file;
    }

    /** RGBA at model.input × model.input -> Uint8Array alpha (0..255) of the same size. */
    async run(rgba) {
        const size = this.model.input || 1024;
        const { session, provider } = await this.runtime.session(this.file);
        const input = this.runtime.tensor("float32", normalise(rgba, this.model.mean, this.model.std, size), [1, 3, size, size]);
        const t0 = Date.now();
        const out = await session.run({ [session.inputNames[0]]: input });
        const n = size * size;
        let data = null;
        for (const name of session.outputNames) { const t = out[name]; if (t && t.data && t.data.length === n) { data = t.data; break; } }
        if (!data) { const first = out[session.outputNames[0]]; throw new Error(`unexpected output shape ${first ? first.dims.join("×") : "none"} from ${this.model.label}`); }
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < n; i++) { const v = data[i]; if (v < min) min = v; if (v > max) max = v; }
        const logits = min < -0.01 || max > 1.01;
        const alpha = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            let v = data[i];
            if (logits) v = 1 / (1 + Math.exp(-v));
            alpha[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
        }
        return { alpha, size, provider, ms: Date.now() - t0, logits };
    }
}

module.exports = { Matting };
