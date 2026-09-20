// DeepSeek has no image model, so this entry only puts the key row into Settings › API
// providers; the key is read by the in-app assistant (electron/main/assistant/providers.js).
// balance(): GET https://api.deepseek.com/user/balance with the Bearer key answers
// { is_available, balance_infos: [{ currency ("USD" | "CNY"), total_balance, granted_balance,
// topped_up_balance }] } with the amounts as strings; the USD row's total is the balance, the
// other currencies go into the note. Written from the docs on 2026-09-20, not run against the
// live API.
"use strict";

const BALANCE_URL = "https://api.deepseek.com/user/balance";
const BALANCE_TIMEOUT_MS = 15000;

/** An error text with the key taken out, whatever the server echoed. */
function scrub(text, key) {
    let s = String(text == null ? "" : text);
    if (key) s = s.split(key).join("<key>");
    return s;
}

module.exports = {
    label: "DeepSeek (assistant)",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "sk-... from platform.deepseek.com",
    async edit() {
        throw new Error("DeepSeek offers no image editing model; the key is used by the assistant.");
    },

    /** GET /user/balance, free: what the account has left, in USD when it holds a USD row. */
    async balance(ctx) {
        // the gates store test- keys; one never reaches the real host
        if (/^test-/.test(String(ctx.key || ""))) throw new Error("a test key has no balance");
        const r = await ctx.fetch(BALANCE_URL, { headers: { Authorization: "Bearer " + ctx.key }, signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS) });
        if (!r.ok) {
            let body = "";
            try { body = await r.text(); } catch { body = ""; }
            throw new Error(`DeepSeek balance: HTTP ${r.status}: ${scrub(body, ctx.key).slice(0, 300)}`);
        }
        const j = (await r.json()) || {};
        const rows = Array.isArray(j.balance_infos) ? j.balance_infos : [];
        const usdRow = rows.find((b) => b && String(b.currency).toUpperCase() === "USD");
        const usd = usdRow && Number.isFinite(Number(usdRow.total_balance)) ? Number(usdRow.total_balance) : null;
        const notes = [];
        if (j.is_available === false) notes.push("not available");
        if (!usdRow) {
            // no USD row: name the other currencies' totals (CNY as yuan, anything else by its code)
            const others = rows.filter((b) => b && b.currency && Number.isFinite(Number(b.total_balance)))
                .map((b) => { const c = String(b.currency).toUpperCase(); return `${c === "CNY" ? "¥" : ""}${Number(b.total_balance).toFixed(2)} ${c}`; });
            if (others.length) notes.push(others.join(", "));
        }
        return { usd, note: notes.length ? notes.join("; ") : undefined };
    },
};
