// Z.ai (GLM) has no image model, so this entry only puts the key row into Settings › API
// providers; the key is read by the in-app assistant (electron/main/assistant/providers.js).
// No balance(): Z.ai documents no balance endpoint (2026-09-20), so the row has no
// "check balance". Not run against the live API.
"use strict";

module.exports = {
    label: "Z.ai / GLM (assistant)",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    keyHint: "a pay-as-you-go API key from z.ai, not a GLM Coding Plan key",
    async edit() {
        throw new Error("Z.ai offers no image editing model; the key is used by the assistant.");
    },
};
