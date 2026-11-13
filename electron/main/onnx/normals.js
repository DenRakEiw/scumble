// Surface normals and shape (MoGe-2 normal, Microsoft's ONNX export; Deep paint, docs/PLAN_SURFACE_PAINT.md SP2).
//
//   input:  image [1, 3, H, W] float32 RGB in [0, 1] (no mean or std), num_tokens int64 scalar (detail; 1800 by default)
//   output: normal [1, H, W, 3] unit vectors in the camera's frame (x right, y down, z away from the viewer, so a
//           surface facing the camera has z < 0), points [1, H, W, 3] (the 3D point per pixel, up to `scale`),
//           mask [1, H, W] (sigmoid: where the model trusts its geometry), scale [1]
"use strict";

class Normals {
    /**
     * @param {import("./runtime").Runtime} runtime
     * @param {object} model registry entry (tokens)
     * @param {string} file the .onnx path
     */
    constructor(runtime, model, file) {
        this.runtime = runtime;
        this.model = model;
        this.file = file;
    }

    /**
     * RGBA w × h -> { normal, points: Float32Array(w * h * 3), mask: Float32Array(w * h), scale, width, height,
     * provider, ms }. `tokens` sets the detail (the model's patch count; more is slower).
     */
    async run(rgba, w, h, { tokens } = {}) {
        const { session, provider } = await this.runtime.session(this.file);
        const plane = w * h;
        const x = new Float32Array(3 * plane);
        for (let i = 0; i < plane; i++) {
            x[i] = rgba[4 * i] / 255;
            x[plane + i] = rgba[4 * i + 1] / 255;
            x[2 * plane + i] = rgba[4 * i + 2] / 255;
        }
        const n = Math.max(256, Math.min(9000, Math.round(tokens || this.model.tokens || 1800)));
        const t0 = Date.now();
        const out = await session.run({
            image: this.runtime.tensor("float32", x, [1, 3, h, w]),
            num_tokens: this.runtime.tensor("int64", BigInt64Array.from([BigInt(n)]), []),
        });
        const ms = Date.now() - t0;
        const take = (name, len) => {
            const t = out[name];
            if (!t || !t.data || t.data.length !== len) {
                throw new Error(`unexpected ${name} of shape ${t && t.dims ? t.dims.join("×") : "none"} from ${this.model.label || "the normal model"}`);
            }
            return t.data instanceof Float32Array ? t.data : Float32Array.from(t.data);
        };
        const scale = out.scale && out.scale.data && out.scale.data.length ? Number(out.scale.data[0]) : 1;
        return { normal: take("normal", 3 * plane), points: take("points", 3 * plane), mask: take("mask", plane), scale, tokens: n, width: w, height: h, provider, ms };
    }
}

module.exports = { Normals };
