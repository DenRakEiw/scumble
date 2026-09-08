// Test provider: hands the crop straight back. The stitched layer then equals the base
// inside the selection, which lets the smoke test check crop, placement and mask
// without an API key. Not listed in the settings dialog.
"use strict";

module.exports = {
    label: "Loopback (test)",
    needsKey: false,
    async edit(req, ctx) {
        const delay = Math.max(0, +req.params.delay_ms || 0);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (req.params.fail) throw new Error("loopback failure requested");
        return { bytes: req.image, mime: "image/png", seed: req.seed, info: { width: req.width, height: req.height, references: req.references.length, mask: !!req.mask } };
    },
};
