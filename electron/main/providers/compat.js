// A local or self-hosted OpenAI-compatible server has no image editing model, so this entry
// only puts a key row into the settings dialog and keeps the key store uniform; the URL and
// the model live in settings.llm.compat and the endpoint is used by electron/main/llm.js
// (prompt upsampling). Most such servers (Ollama, LM Studio) want no key at all.
"use strict";

module.exports = {
    label: "OpenAI-compatible endpoint (prompt upsampling)",
    needsKey: false,
    keyHint: "only for servers that ask for one",
    async edit() {
        throw new Error("The OpenAI-compatible endpoint is a language model; it is used for prompt upsampling, not for image editing.");
    },
};
