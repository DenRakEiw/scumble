// Depth estimation (Depth Anything V2 Small) through ONNX Runtime: [1, 3, H, W] float32 RGB input
// (ImageNet mean and std), [1, H, W] float32 depth map out.
//
// Expected model signature:
//   input:  pixel_values [1, 3, height, width]
//   output: predicted_depth [1, height, width] (or [1, 1, height, width])
"use strict";

const { normaliseRect } = require("./sam2");

class Depth {
    /**
     * @param {import("./runtime").Runtime} runtime
     * @param {object} model registry entry (input, multiple, mean, std)
     * @param {string} file the .onnx path
     */
    constructor(runtime, model, file) {
        this.runtime = runtime;
        this.model = model;
        this.file = file;
    }

    /**
     * RGBA at w × h (multiples of 14) -> { depth: Float32Array(w*h), width: w, height: h, min, max, provider, ms }
     */
    async run(rgba, w, h) {
        const { session, provider } = await this.runtime.session(this.file);
        const input = this.runtime.tensor("float32", normaliseRect(rgba, w, h, this.model.mean, this.model.std), [1, 3, h, w]);
        const t0 = Date.now();
        const out = await session.run({ [session.inputNames[0]]: input });
        const n = w * h;
        let data = null;
        for (const name of session.outputNames) {
            const t = out[name];
            if (t && t.data && t.data.length === n) { data = t.data; break; }
        }
        if (!data) {
            const first = out[session.outputNames[0]];
            throw new Error(`unexpected output shape ${first && first.dims ? first.dims.join("×") : "none"} from ${this.model.label || "depth model"}`);
        }
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < n; i++) {
            const v = data[i];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        const depth = data instanceof Float32Array ? data : new Float32Array(data);
        return { depth, width: w, height: h, min, max, provider, ms: Date.now() - t0 };
    }
}

module.exports = { Depth };
