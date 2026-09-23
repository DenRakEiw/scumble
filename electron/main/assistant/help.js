// Help: questions about using Scumble, answered from the manual (docs/PLAN_HELP.md §3). The assistant's
// loop with **no tools**: the same four adapters, the same registry of providers and keys, the same
// streaming, retries and final-answer rules, and nothing of what makes the assistant complex - no MCP
// client, no policy, no asks, no undo, no screenshots. It cannot change anything, so it needs none of
// it, and a model that cannot see pictures serves as well as one that can.
//
// The system text is a few rules plus the whole of docs/MANUAL.md, byte-stable for the chat so the
// provider's prompt cache holds: the first question pays for the manual, every later one reads it
// from the cache (§4).
//
// Everything is passed in, so it runs in plain Node against a scripted fetch (tools/assistant_test.js).
"use strict";

const { Assistant, ADAPTERS } = require("./index.js");
const { loopbackBase, scrub } = require("./http.js");
const llmCustom = require("../llm_custom.js");

const DEFAULTS = { model: "", maxTokens: 4000, effort: "low" };

const RULES = `You are the help of Scumble, a desktop editor for AI inpainting. You answer questions about
using Scumble, from the manual below and from nothing else.

- Answer only from the manual. When it does not cover the question, say so in one sentence, and point
  to the docs folder of the repository (https://github.com/DenRakEiw/scumble/tree/main/docs) and its
  issues (https://github.com/DenRakEiw/scumble/issues). Never guess a menu path, a shortcut, a setting,
  a model or a feature the manual does not name.
- End every answer that uses the manual with the chapter it comes from, on a line of its own:
  Chapter: <the chapter's title as the manual writes it>
- You cannot change anything in the app and you cannot see the user's picture. When the user wants
  something done, give the steps; the assistant (View › Assistant, Ctrl+Shift+A) is the part of
  Scumble that acts.
- Answer in the language of the question. Menu items, buttons and settings keep the names the manual
  gives them.
- Be short: a few sentences, or a short numbered list for steps.`;

/** The manual as the model gets it: the file without the comments meant for its writers. */
function manualText(md) {
    return String(md || "").replace(/<!--[\s\S]*?-->\s*\n?/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** The system text of a Help chat. */
function systemText(md) {
    return `${RULES}\n\n<manual>\n${manualText(md)}\n</manual>`;
}

class Help {
    /**
     * @param deps {keys, settings, manual: () => string, emit, log, fetchImpl, sleep, now, customModels?, compatBase?, toapisBase?}
     */
    constructor(deps) {
        this.deps = deps;
        this.chat = null;
        this.turn = null;
        this.turnSeq = 0;
        this.events = [];
        // the assistant's own resolution of a model value to its provider, base and key, with every
        // row the user added (Help takes the rows marked for upsampling too: it needs no eyes and no tools)
        this.registry = new Assistant({
            ...deps,
            customModels: () => (deps.customModels ? deps.customModels() : llmCustom.rows(this.all())),
        });
    }

    all() {
        return (this.deps.settings && this.deps.settings.get && this.deps.settings.get()) || {};
    }

    settings() {
        return { ...DEFAULTS, ...(this.all().help || {}) };
    }

    /**
     * The picker: the assistant's groups (a provider is ready with its key, or the local server with
     * its URL), and the model Help uses. Without a choice of its own that is the assistant's model when
     * it is ready, else the first ready model - so a user with any key has a chat at once.
     */
    async models() {
        const m = await this.registry.models();
        const ready = [];
        for (const g of m.groups) if (g.ready) for (const x of g.models) ready.push(x.value);
        const chosen = this.settings().model;
        const current = ready.includes(chosen) ? chosen : ready.includes(m.current) ? m.current : ready[0] || "";
        return { groups: m.groups, current, ready: ready.length > 0 };
    }

    emit(type, data) {
        const event = { type, at: this.deps.now ? this.deps.now() : Date.now(), ...data };
        this.events.push(event);
        if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
        if (this.deps.emit) this.deps.emit(event);
        return event;
    }

    stop() {
        if (!this.turn) return false;
        this.turn.stopped = true;
        this.turn.abort.abort();
        return true;
    }

    /** A new chat: the history goes, the next question starts over (and pays for the manual again). */
    reset() {
        this.stop();
        this.chat = null;
        this.events = [];
        return true;
    }

    state() {
        return { busy: !!this.turn, model: this.chat ? this.chat.value : null, events: this.events.slice() };
    }

    /** The chat for `value`: kept while the model stays, a new one when the user picked another. */
    chatFor(value) {
        if (this.chat && this.chat.value === value) return this.chat;
        const t = this.registry.target(value);
        const adapter = ADAPTERS[t.entry.family];
        if (!adapter) throw new Error(`${t.entry.label} is not built yet`);
        const s = this.settings();
        const dialect = { ...(t.entry.dialect || {}), ...(t.model.thinking !== undefined ? { thinking: t.model.thinking } : {}) };
        this.chat = {
            id: `h${Date.now().toString(36)}`,
            value,
            provider: t.provider,
            model: t.id,
            label: t.model.label || t.id,
            base: t.base,
            key: t.key,
            needsKey: t.needsKey,
            providerLabel: t.entry.label,
            adapter,
            dialect,
            system: systemText(this.deps.manual ? this.deps.manual() : ""),
            tools: [],                                  // the adapters leave the field out when it is empty
            maxTokens: s.maxTokens,
            effort: s.effort,
            idleMs: 120000,
            history: [],
            usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 },
        };
        return this.chat;
    }

    /**
     * Ask. Resolves when the answer is in (or failed); the window follows it through the events
     * (`user`, `text_delta`, `answer`, `usage`, `done`).
     */
    async send(text, value) {
        if (this.turn || this.starting) throw new Error("an answer is still coming");
        const question = String(text == null ? "" : text).trim();
        if (!question) throw new Error("ask something");
        // the model list is a round trip (the local server's /models): a second question in that
        // window would start a second answer on the same chat
        this.starting = true;
        let m;
        try { m = value ? { current: value } : await this.models(); } finally { this.starting = false; }
        if (!m.current) throw new Error("No model: add an API key under Settings › API providers, or a local server's URL.");
        const chat = this.chatFor(m.current);
        const test = loopbackBase(this.registry.settings().base);
        if (test && chat.key && !chat.key.startsWith("test-")) throw new Error("the test endpoint takes test keys only");
        if (!test && chat.key && chat.key.startsWith("test-")) throw new Error("a test key goes to the test endpoint only");
        if (!chat.key && chat.needsKey) throw new Error(`No API key for ${chat.providerLabel}. Add it under Settings › API providers.`);

        const turn = { id: `ht${(++this.turnSeq).toString(36)}`, abort: new AbortController(), stopped: false };
        this.turn = turn;
        this.emit("user", { turn: turn.id, text: question, model: chat.label });
        const adapter = chat.adapter;
        // a stopped question left its user message without an answer: the new one replaces it
        const last = chat.history[chat.history.length - 1];
        if (last && last.role === "user") chat.history.pop();
        chat.history.push(adapter.userMessage("", question));
        try {
            const res = await adapter.stream(chat, chat.history, {
                signal: turn.abort.signal,
                onText: (part) => this.emit("text_delta", { turn: turn.id, text: part }),
                fetchImpl: this.deps.fetchImpl,
                sleep: this.deps.sleep,
                log: (line) => this.deps.log && this.deps.log(line),
            });
            chat.history.push(...res.messages);
            this.registry.addUsage(chat, res.usage);
            this.emit("usage", { turn: turn.id, usage: res.usage, cost: this.registry.costOf(chat, res.usage), total: chat.usage.cost });
            if (res.text) this.emit("answer", { turn: turn.id, text: res.text });
            // no tools were offered, so a call is the model's mistake: its message stays out of the history
            if (res.calls && res.calls.length) chat.history.splice(chat.history.length - res.messages.length, res.messages.length);
            const reason = res.stop === "cut" ? "cut" : res.stop === "refusal" ? "refusal" : "end";
            return this.done(turn, reason);
        } catch (err) {
            if (turn.stopped || (err && err.name === "AbortError")) return this.done(turn, "stopped");
            return this.done(turn, "error", scrub(String((err && err.message) || err), [chat.key]));
        } finally {
            this.turn = null;
        }
    }

    done(turn, reason, detail) {
        const event = this.emit("done", { turn: turn.id, reason, detail: detail || null });
        if (this.deps.log) this.deps.log(`help: ${reason}${detail ? " - " + detail : ""}`);
        return event;
    }
}

module.exports = { Help, DEFAULTS, RULES, systemText, manualText };
