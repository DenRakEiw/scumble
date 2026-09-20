// Anthropic has no image model, so this entry only puts the key row into Settings ›
// API providers; the key is used by electron/main/llm.js (prompt upsampling with Claude)
// and read by the in-app assistant (electron/main/assistant/providers.js).
"use strict";

module.exports = {
    label: "Anthropic (Claude: prompt upsampling, assistant)",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "API key from console.anthropic.com",
    async edit() {
        throw new Error("Anthropic offers no image editing model; the key is used for prompt upsampling.");
    },
};
