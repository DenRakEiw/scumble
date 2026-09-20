// Moonshot (Kimi) has no image model, so this entry only puts the key row into Settings › API
// providers; the key is read by the in-app assistant (electron/main/assistant/providers.js).
// balance(): GET https://api.moonshot.ai/v1/users/me/balance with the Bearer key answers
// { code: 0, data: { available_balance, voucher_balance, cash_balance }, scode, status: true }
// with the amounts as numbers in USD; available_balance is the balance, cash and vouchers go
// into the note. Written from the docs on 2026-09-20, not run against the live API.
"use strict";

const BALANCE_URL = "https://api.moonshot.ai/v1/users/me/balance";
const BALANCE_TIMEOUT_MS = 15000;

/** An error text with the key taken out, whatever the server echoed. */
function scrub(text, key) {
    let s = String(text == null ? "" : text);
    if (key) s = s.split(key).join("<key>");
    return s;
}

module.exports = {
    label: "Moonshot / Kimi (assistant)",
    keyUrl: "https://platform.kimi.ai/console/api-keys",
    keyHint: "a key from platform.kimi.ai; keys from the China platform do not work here",
    async edit() {
        throw new Error("Moonshot offers no image editing model; the key is used by the assistant.");
    },

    /** GET /v1/users/me/balance, free: what the account has left, in USD. */
    async balance(ctx) {
        // the gates store test- keys; one never reaches the real host
        if (/^test-/.test(String(ctx.key || ""))) throw new Error("a test key has no balance");
        const r = await ctx.fetch(BALANCE_URL, { headers: { Authorization: "Bearer " + ctx.key }, signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS) });
        if (!r.ok) {
            let body = "";
            try { body = await r.text(); } catch { body = ""; }
            throw new Error(`Moonshot balance: HTTP ${r.status}: ${scrub(body, ctx.key).slice(0, 300)}`);
        }
        const j = (await r.json()) || {};
        if (j.status === false) throw new Error(`Moonshot balance: ${scrub(j.error || j.message || JSON.stringify(j), ctx.key).slice(0, 300)}`);
        const d = j.data || {};
        const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
        const money = (v) => (num(v) == null ? "?" : `$${num(v).toFixed(2)}`);
        return { usd: num(d.available_balance), note: `cash ${money(d.cash_balance)}, vouchers ${money(d.voucher_balance)}` };
    },
};
