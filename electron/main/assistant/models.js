// What a turn costs. Prices in US dollars per million tokens, input / output, with the cache
// read and, where a provider publishes one, the cache write; read from each provider's own
// pricing page on 2026-09-19 (docs/PLAN_ASSISTANT.md §3, "The provider registry"). Nothing here
// was checked against a real invoice, and a route can be cheaper or dearer than its maker's
// list: OpenRouter therefore reports `usage.cost` and this table is not used for it (§2 row 25).
"use strict";

const PRICED_ON = "2026-09-19";

/** per million tokens: [input, output, cacheRead, cacheWrite] (cacheWrite null = not published). */
const PRICES = {
    anthropic: {
        "claude-sonnet-5": [2, 10, 0.20, 2.50],
        "claude-opus-5": [5, 25, 0.50, 6.25],
    },
    openai: {
        "gpt-5.6-terra": [2, 12, 0.20, null],
        "gpt-5.6-sol": [4, 20, 0.40, null],      // promotional "at least through November 21, 2026"
        "gpt-5.6-luna": [0.20, 1.20, 0.02, null],
    },
    gemini: {
        "gemini-3.8-flash": [0.75, 3.75, 0.075, null],   // until 2026-12-31, then 1.50 / 7.50
        "gemini-3.1-pro-preview": [2, 12, 0.20, null],
        "gemini-3.5-flash-lite": [0.30, 2.50, 0.03, null],
    },
    deepseek: {
        "deepseek-flash": [0.30, 1.20, 0.006, null],     // peak; off-peak is half, see peakFactor
    },
    moonshot: {
        "kimi-k3": [3.00, 15.00, 0.30, null],            // a cache write is billed, price not published
        "kimi-k2.6": [0.95, 4.00, 0.16, null],
    },
    zai: {
        "glm-5.3-flash": [0.15, 0.50, 0.03, null],
        "glm-5.3-flashx": [0.37, 1.25, 0.075, null],
    },
    toapis: {                                            // in ToAPIs credits, 200 credits = $1
        "claude-sonnet-5": [0.90, 4.50, null, null],
        "claude-opus-5": [1.50, 7.50, null, null],
        "gemini-3.8-flash": [0.30, 1.50, null, null],
    },
    wavespeed: {                                         // the makers' list prices
        "anthropic/claude-sonnet-5": [2, 10, 0.20, null],
        "anthropic/claude-opus-5": [5, 25, 0.50, null],
        "google/gemini-3.8-flash": [0.75, 3.75, 0.075, null],
    },
    oxen: {                                              // GET https://hub.oxen.ai/api/ai/models, 2026-09-26; no cache price listed
        "claude-sonnet-5": [3.5, 18, null, null],
        "gpt-5-6-terra": [2.5, 15, null, null],
        "gemini-3-8-flash": [0.75, 3.75, null, null],
    },
};

/** Where a long request is billed at another rate (§3). */
const LONG_CONTEXT = {
    openai: { over: 272000, input: 2, output: 1.5 },          // multipliers above 272K input tokens
    gemini: { over: 200000, only: "gemini-3.1-pro-preview", inputPrice: 4, outputPrice: 18 },
};

/** Gemini 3.8 Flash's promotional price ends with this day (UTC). */
const GEMINI_FLASH_PROMO_END = Date.UTC(2026, 11, 31, 23, 59, 59);
const GEMINI_FLASH_AFTER = [1.50, 7.50, 0.075, null];

/**
 * DeepSeek's peak hours: 01:00 to 04:00 and 06:00 to 10:00 UTC, Monday to Friday. Off peak, at
 * the weekend and on Chinese holidays (not modelled) the price is half.
 */
function deepseekPeak(at) {
    const d = new Date(at);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) return false;
    const h = d.getUTCHours();
    return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** The four rates of one model at one moment, or null when the model has no published price. */
function ratesOf(provider, model, at = Date.now()) {
    if (provider === "openrouter" || provider === "compat") return null;   // usage.cost, or free
    const table = PRICES[Object.prototype.hasOwnProperty.call(PRICES, provider) ? provider : ""];
    if (!table) return null;
    let row = table[Object.prototype.hasOwnProperty.call(table, model) ? model : ""];
    if (!row) return null;
    if (provider === "gemini" && model === "gemini-3.8-flash" && at > GEMINI_FLASH_PROMO_END) row = GEMINI_FLASH_AFTER;
    if (provider === "deepseek" && !deepseekPeak(at)) row = row.map((v) => (v === null ? null : v / 2));
    return { input: row[0], output: row[1], cacheRead: row[2], cacheWrite: row[3] };
}

const M = 1000000;

/**
 * What one model call cost, from the usage the adapter normalised to
 * `{input, cacheRead, cacheWrite, output, reasoning}` (reasoning tokens are part of output and
 * are not priced again).
 *
 * @returns {{amount: number|null, currency: string, note: string}}
 *          `amount` null means "no published price"; `currency` is "USD", or "credits" for ToAPIs.
 */
function costOf(provider, model, usage, at = Date.now()) {
    const u = usage || {};
    if (provider === "openrouter") {
        const cost = Number(u.cost);
        return Number.isFinite(cost)
            ? { amount: cost, currency: "USD", note: "as OpenRouter reported it" }
            : { amount: null, currency: "USD", note: "OpenRouter reported no cost" };
    }
    if (provider === "compat") return { amount: 0, currency: "USD", note: "local" };

    const rates = ratesOf(provider, model, at);
    if (!rates) return { amount: null, currency: "USD", note: `no published price for ${model}` };

    const input = Math.max(0, Number(u.input) || 0);
    const cacheRead = Math.max(0, Number(u.cacheRead) || 0);
    const cacheWrite = Math.max(0, Number(u.cacheWrite) || 0);
    const output = Math.max(0, Number(u.output) || 0);

    let inRate = rates.input, outRate = rates.output;
    const long = LONG_CONTEXT[provider];
    if (long && input + cacheRead + cacheWrite > long.over && (!long.only || long.only === model)) {
        if (long.inputPrice) { inRate = long.inputPrice; outRate = long.outputPrice; }
        else { inRate = rates.input * long.input; outRate = rates.output * long.output; }
    }

    let amount = (input * inRate + output * outRate) / M;
    if (cacheRead) amount += (cacheRead * (rates.cacheRead === null ? inRate : rates.cacheRead)) / M;
    const notes = [];
    if (cacheWrite) {
        if (rates.cacheWrite === null) notes.push("cache writes are billed, price not published");
        else amount += (cacheWrite * rates.cacheWrite) / M;
    }
    if (provider === "deepseek") notes.push(deepseekPeak(at) ? "peak price" : "off-peak price");
    if (provider === "toapis") return { amount, currency: "credits", note: notes.concat("200 credits = $1").join("; ") };
    return { amount, currency: "USD", note: notes.join("; ") };
}

module.exports = { PRICES, PRICED_ON, costOf, ratesOf, deepseekPeak, LONG_CONTEXT };
