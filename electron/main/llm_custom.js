// The language models the user adds by hand (Settings > Language models): one list, read by
// prompt upsampling (llm.js) and by the assistant's picker (assistant/providers.js), so a
// model of any provider Scumble speaks - an OpenRouter id, a model a provider added after
// this release - can be used without a new build.
//
// A row is { provider, model, label, upsample, assistant, vision }, stored in
// settings.llm.models. It comes from a file the user can edit, so it is normalised here and
// never trusted as it is: an unknown provider, an empty id, a duplicate and everything above
// MAX_ROWS is dropped. The provider registry is the assistant's (assistant/providers.js):
// the same ten providers, the same key rows and base URLs.
"use strict";

const { PROVIDERS, ORDER } = require("./assistant/providers.js");

const MAX_ROWS = 50;

/** Every provider a row may name, in the picker's order, for the Settings dialog. */
function options() {
    return ORDER.map((provider) => {
        const p = PROVIDERS[provider];
        return {
            provider,
            label: p.label,
            key: p.key,
            needsKey: p.needsKey !== false,
            family: p.family,
            curated: p.models.map((m) => m.id),
        };
    });
}

function known(provider) {
    return Object.prototype.hasOwnProperty.call(PROVIDERS, provider);
}

function flag(v, dflt) {
    return v === undefined || v === null ? dflt : !!v;
}

/** The stored list, cleaned: a known provider, a model id, no duplicate, at most MAX_ROWS. */
function normalize(list) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
        if (!raw || typeof raw !== "object") continue;
        const provider = String(raw.provider || "").trim();
        const model = String(raw.model || "").trim().slice(0, 200);
        if (!known(provider) || !model) continue;
        const id = `${provider}:${model}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
            provider,
            model,
            label: String(raw.label || "").trim().slice(0, 120),
            upsample: flag(raw.upsample, true),
            assistant: flag(raw.assistant, true),
            vision: flag(raw.vision, true),
        });
        if (out.length >= MAX_ROWS) break;
    }
    return out;
}

/** The rows of a whole settings object. */
function rows(all) {
    return normalize((((all || {}).llm) || {}).models);
}

function forUpsample(all) {
    return rows(all).filter((r) => r.upsample);
}

function forAssistant(all) {
    return rows(all).filter((r) => r.assistant);
}

/**
 * Where a row of a Chat Completions provider that has no upsample adapter of its own goes
 * (DeepSeek, Moonshot, Z.ai, WaveSpeedAI): the provider's own base URL, label and key row, from
 * the registry. null for a provider whose host is not fixed here - ToAPIs takes it from
 * settings.toapis.base and the local endpoint from settings.llm.compat.url, and both have a
 * path of their own in llm.js.
 */
function endpoint(provider) {
    const p = PROVIDERS[Object.prototype.hasOwnProperty.call(PROVIDERS, provider) ? provider : ""];
    if (!p || !p.base) return null;
    return { base: p.base, label: p.label, key: p.key, family: p.family };
}

/** The row for one "<provider>:<model>", or null. */
function find(list, provider, model) {
    return (list || []).find((r) => r.provider === provider && r.model === model) || null;
}

module.exports = { options, normalize, rows, forUpsample, forAssistant, find, endpoint, MAX_ROWS };
