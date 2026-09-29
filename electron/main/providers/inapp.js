// In-app rendering: the selection filled by a helper model that runs inside Scumble (electron/main/onnx), with no key,
// no server and no network. One model so far, LaMa (`model: "lama"`), for the recipe "LaMa remove (in-app)"
// (recipes/lama_remove.json): the recipe's limits make the crop 512 x 512, LaMa's fixed size, and the stitch in the
// renderer blends the answer back as it does any provider's. No prompt: LaMa fills from the picture around the hole.
// Not listed in Settings › API providers (no key); the model is downloaded in Settings › Helpers.
"use strict";

const { layoutOf } = require("./refs");

const SIZE = 512;

module.exports = {
    label: "In-app",
    needsKey: false,

    // the crop and the mask; LaMa fills from the picture around the hole and takes no reference (docs/PLAN_REFS.md C3)
    layout(req) {
        if (req.kind !== "fill") throw new Error("In-app LaMa fills a selection and takes no instruction; use a fill recipe.");
        return layoutOf({ seq: [["crop", "image"]], own: [["mask", req.mask ? "mask" : "maskAlpha"]], drops: "LaMa takes no reference images: they are left out." });
    },

    async edit(req, ctx) {
        if (req.kind !== "fill") throw new Error("In-app LaMa fills a selection and takes no instruction; use a fill recipe.");
        const img = ctx.bitmap(req.image);
        if (!img) throw new Error("In-app LaMa: the crop could not be decoded.");
        if (img.width !== SIZE || img.height !== SIZE) throw new Error(`In-app LaMa takes ${SIZE} × ${SIZE}, and the crop came as ${img.width} × ${img.height} (the recipe's limits set the size).`);
        const n = SIZE * SIZE, hole = new Uint8Array(n);
        // the hole: the soft repaint mask (white = repaint: the selection grown and feathered) above half, which also
        // takes the rim around the selection; else the selection itself (alpha 0 = repaint)
        const soft = req.mask ? ctx.bitmap(req.mask) : null;
        if (soft && soft.width === SIZE && soft.height === SIZE) {
            for (let i = 0; i < n; i++) if (soft.data[i * 4 + 1] > 127) hole[i] = 255;
        } else {
            const a = req.maskAlpha ? ctx.bitmap(req.maskAlpha) : null;
            if (!a || a.width !== SIZE || a.height !== SIZE) throw new Error("In-app LaMa: the mask is missing or not the crop's size.");
            for (let i = 0; i < n; i++) if (a.data[i * 4 + 3] < 128) hole[i] = 255;
        }
        let holes = 0;
        for (let i = 0; i < n; i++) if (hole[i]) holes++;
        if (!holes) throw new Error("In-app LaMa: nothing to fill. Select what should go first.");
        // nativeImage keeps BGRA; the model takes RGBA
        const rgba = new Uint8Array(n * 4);
        for (let i = 0, j = 0; i < n; i++, j += 4) { rgba[j] = img.data[j + 2]; rgba[j + 1] = img.data[j + 1]; rgba[j + 2] = img.data[j]; rgba[j + 3] = 255; }
        const res = await require("../onnx").inpaint({ model: req.model || undefined, image: rgba, mask: hole });
        const out = Buffer.alloc(n * 4);
        for (let j = 0; j < n * 4; j += 4) { out[j] = res.image[j + 2]; out[j + 1] = res.image[j + 1]; out[j + 2] = res.image[j]; out[j + 3] = 255; }
        return { bytes: ctx.fromBitmap({ width: SIZE, height: SIZE, data: out }), mime: "image/png", info: { model: res.model, provider: res.provider, seconds: res.seconds } };
    },
};
