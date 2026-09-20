// The assistant: a chat agent that drives Scumble through the same MCP tools an external agent
// uses (docs/PLAN_ASSISTANT.md §3). The loop lives here, in the main process, because only main
// can read the keys and reach the model hosts; the window only shows the chat.
//
// Everything this class needs is passed in, so the whole loop runs in plain Node against a fake
// bridge and a scripted fetch (tools/assistant_test.js). Nothing here requires Electron.
"use strict";

const { PROVIDERS, DEFAULT_MODEL, providerOf } = require("./providers.js");
const policy = require("./policy.js");
const prompt = require("./prompt.js");
const models = require("./models.js");
const { loopbackBase, compatBase, scrub } = require("./http.js");

const ADAPTERS = { messages: require("./anthropic.js"), chat: require("./chat.js") };

/** A Gemini model takes the smaller cap wherever it runs: Google's own, or a `google/*` id through a gateway (§2 row 9). */
const isGemini = (model) => /^(google\/|gemini-)/.test(String(model || ""));

const DEFAULTS = {
    model: DEFAULT_MODEL,
    maxSteps: 25,
    screenshotMax: 1024,
    keepImages: 3,
    maxTokens: 32000,
    effort: "medium",
    keepChats: 20,
    base: "",
    idleMs: 120000,
};

/** The Bridge waits up to 120 s for the window, then 600 s for the command; a call's own
 *  timeout is added on top, and 30 s of slack keeps the SDK's timer the outer one (§2 row 15). */
const callTimeout = (seconds) => (120 + 600 + (seconds || 0)) * 1000 + 30000;

class Assistant {
    /**
     * @param deps {bridge, keys, settings, log, emit, fetchImpl, sleep, now, createServer, Client, InMemoryTransport}
     */
    constructor(deps) {
        this.deps = deps;
        this.chat = null;
        this.turn = null;
        this.pending = null;        // the ask a turn is waiting on
        this.client = null;
        this.server = null;
        this.events = [];
    }

    // ---- settings and keys ---------------------------------------------------------------

    settings() {
        const all = (this.deps.settings && this.deps.settings.get && this.deps.settings.get()) || {};
        return { ...DEFAULTS, ...(all.assistant || {}) };
    }

    /** The provider, its base URL and its key, with the loopback base replacing the host. */
    target(value) {
        const all = (this.deps.settings && this.deps.settings.get && this.deps.settings.get()) || {};
        const s = { ...DEFAULTS, ...(all.assistant || {}) };
        const chosen = providerOf(value || s.model) || providerOf(DEFAULT_MODEL);
        const entry = chosen.entry;
        const base = this.baseFor(chosen.provider, entry, s, all);
        const key = (this.deps.keys && this.deps.keys.get && this.deps.keys.get(entry.key)) || "";
        return { ...chosen, base, key, needsKey: entry.needsKey !== false };
    }

    /**
     * The provider's base. The local server's comes from `settings.llm.compat.url` through
     * `compatBase` (http.js's copy of llm.js's rule), ToAPIs' from `toapis.baseUrl(settings)` plus
     * `/v1` (as llm.js takes it); both may be replaced by the tests through `deps`.
     */
    baseFor(provider, entry, s, all = {}) {
        const test = loopbackBase(s.base);
        let base = entry.base;
        if (!base && provider === "compat") {
            base = this.deps.compatBase ? this.deps.compatBase() : compatBase(((all.llm || {}).compat || {}).url);
        }
        if (!base && provider === "toapis") {
            base = this.deps.toapisBase ? this.deps.toapisBase() : require("../providers/toapis.js").baseUrl(all) + "/v1";
        }
        if (!test) return base;
        // the test endpoint replaces scheme, host and port; the provider's own path stays (§2 row 27)
        try {
            const u = new URL(base);
            return test + (u.pathname === "/" ? "" : u.pathname);
        } catch (_) { return test; }
    }

    // ---- the MCP client ------------------------------------------------------------------

    /** The backend the in-process server runs on: the one Bridge, with the assistant's `meta`. */
    backendFor(turn) {
        const bridge = this.deps.bridge;
        const metaFor = (name) => ({
            origin: "assistant",
            wait: name === "screenshot" ? "soft" : !policy.READS.has(name),
            refuseBusy: policy.RUNS.has(name),
            turn: policy.READS.has(name) ? undefined : (turn && turn.id),
            undo: policy.READS.has(name) ? undefined : (turn && turn.undo),
            signal: turn && turn.signal,
        });
        return {
            run: (name, args) => bridge.run(name, args, metaFor(name)),
            describe: () => bridge.describe(),
            on: (event, fn) => bridge.on(event, fn),
            removeListener: (event, fn) => bridge.removeListener && bridge.removeListener(event, fn),
        };
    }

    async connect() {
        if (this.client) return this.client;
        const { createServer, Client, InMemoryTransport } = this.deps;
        this.server = createServer(this.backendFor(null), {
            version: this.deps.version || "0.0.0",
            info: () => ({ mode: "assistant", pid: process.pid }),
        });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        this.client = new Client({ name: "scumble-assistant", version: "1" }, { capabilities: {} });
        await Promise.all([this.server.connect(serverSide), this.client.connect(clientSide)]);
        return this.client;
    }

    async close() {
        if (this.client) { await this.client.close().catch(() => {}); this.client = null; }
        if (this.server) { await this.server.close().catch(() => {}); this.server = null; }
    }

    /** An internal read: no card, no step, and a timeout long enough for the Bridge's own waits. */
    async read(name, args) {
        const res = await this.client.callTool({ name, arguments: args || {} }, undefined, { timeout: callTimeout(0) });
        if (res.isError) throw new Error(textOf(res));
        return parse(textOf(res));
    }

    // ---- the chat ------------------------------------------------------------------------

    async newChat() {
        const s = this.settings();
        const t = this.target();
        const adapter = ADAPTERS[t.entry.family];
        if (!adapter) throw new Error(`${t.entry.label} is not built yet`);
        const tools = (await this.client.listTools()).tools
            .filter((tool) => !policy.EXCLUDED.has(tool.name))
            .filter((tool) => t.model.vision !== false || tool.name !== "screenshot")
            .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
        // the dialect is the provider's, with the model's own thinking switch where it has one (Moonshot)
        const dialect = { ...(t.entry.dialect || {}), ...(t.model.thinking !== undefined ? { thinking: t.model.thinking } : {}) };
        return {
            id: `c${Date.now().toString(36)}`,
            provider: t.provider,
            model: t.id,
            base: t.base,
            key: t.key,
            family: t.entry.family,
            adapter,
            dialect,
            system: prompt.systemText(this.client.getInstructions(), { vision: t.model.vision !== false }),
            tools: adapter.toolsFor(tools, dialect),
            schemas: new Map(tools.map((x) => [x.name, x.inputSchema || {}])),   // family-neutral, for the canonical arguments
            names: new Set(tools.map((x) => x.name)),
            maxTokens: s.maxTokens,
            effort: s.effort,
            idleMs: s.idleMs,
            history: [],
            owned: new Map(),      // doc -> Set of layer ids this chat made
            seen: new Map(),       // doc -> Set of layer ids any read of this chat saw
            failures: new Map(),   // "name(args)" -> how often it came back an error
            usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 },
            stopped: false,
        };
    }

    setOf(map, doc) {
        const key = String(doc);
        if (!map.has(key)) map.set(key, new Set());
        return map.get(key);
    }

    // ---- events --------------------------------------------------------------------------

    emit(type, data) {
        const event = { type, at: Date.now(), ...data };
        this.events.push(event);
        if (this.deps.emit) this.deps.emit(event);
        return event;
    }

    busy() { return !!this.turn; }

    stop() {
        if (!this.turn) return false;
        this.turn.stopped = true;
        this.turn.abort.abort(stopError());
        if (this.pending) { this.pending.resolve(false); this.pending = null; }
        return true;
    }

    /** The user's answer to an ask card. */
    answer(callId, allow) {
        if (!this.pending || this.pending.callId !== callId) return false;
        const p = this.pending;
        this.pending = null;
        p.resolve(!!allow);
        return true;
    }

    // ---- the turn ------------------------------------------------------------------------

    async send(text) {
        if (this.turn) throw new Error("a turn is running");
        const s = this.settings();
        const t = this.target();
        const test = loopbackBase(s.base);
        if (test && t.key && !t.key.startsWith("test-")) throw new Error("the test endpoint takes test keys only");
        if (!test && t.key && t.key.startsWith("test-")) throw new Error("a test key goes to the test endpoint only");
        if (!t.key && t.needsKey) throw new Error(`No API key for ${t.entry.label}. Add it under Settings › API providers.`);

        await this.connect();
        if (!this.chat) this.chat = await this.newChat();
        const chat = this.chat;
        if (chat.dialect && chat.dialect.contextNote && !chat.noted) {
            chat.noted = true;                       // the one-time note of §2 row 26
            this.emit("note", { text: chat.dialect.contextNote });
        }

        const turn = {
            id: `t${Date.now().toString(36)}`,
            abort: new AbortController(),
            stopped: false,
            steps: 0,
            undo: null,
            docs: new Set(),
        };
        turn.signal = turn.abort.signal;
        this.turn = turn;
        this.emit("turn:start", { turn: turn.id, provider: chat.provider, model: chat.model });

        try {
            return await this.runTurn(chat, turn, text, s);
        } finally {
            this.turn = null;
            if (this.pending) { this.pending.resolve(false); this.pending = null; }
        }
    }

    async runTurn(chat, turn, text, s) {
        const adapter = chat.adapter;
        let docs;
        let layers = [];
        try {
            docs = await this.read("list_documents");
        } catch (err) {
            return this.done(chat, turn, "error", `could not read the open documents: ${err.message}`);
        }
        const list = (docs && docs.documents) || [];
        const active = list.find((d) => d.active) || list[0] || null;
        turn.pin = active ? active.id : null;
        if (turn.pin != null) {
            try {
                const answer = await this.read("list_layers", { doc: turn.pin });
                layers = (answer && answer.layers) || [];
                for (const l of layers) this.setOf(chat.seen, turn.pin).add(l.id);
            } catch (err) {
                return this.done(chat, turn, "error", `could not read the document: ${err.message}`);
            }
        }

        const note = prompt.stateNote(list, layers, { pin: turn.pin, undone: chat.undone, stopped: chat.stopped });
        chat.undone = false;
        const pendingUser = chat.history.length && chat.history[chat.history.length - 1].role === "user";
        if (!pendingUser && s.keepImages > 0 && adapter.countImages(chat.history) > 2 * s.keepImages) adapter.prune(chat.history, s.keepImages);
        if (pendingUser) appendUserText(chat.history[chat.history.length - 1], note, text);
        else chat.history.push(adapter.userMessage(note, text));
        chat.stopped = false;

        const cap = PROVIDERS[chat.provider].requestCap || (isGemini(chat.model) ? PROVIDERS.gemini.requestCap : adapter.REQUEST_CAP);
        for (;;) {
            if (turn.stopped) return this.done(chat, turn, "stopped");
            const bytes = adapter.requestBytes(chat, chat.history);
            if (bytes > cap) return this.done(chat, turn, "full", `this chat is too long (${Math.round(bytes / 1048576)} MB); start a new chat`);

            let res;
            try {
                res = await adapter.stream(chat, chat.history, {
                    signal: turn.signal,
                    onText: (part) => this.emit("text_delta", { text: part }),
                    fetchImpl: this.deps.fetchImpl,
                    sleep: this.deps.sleep,
                    log: (line) => this.record(line),
                });
            } catch (err) {
                if (turn.stopped || err.name === "AbortError") { chat.stopped = true; return this.done(chat, turn, "stopped"); }
                return this.done(chat, turn, "error", scrub(err.message, [chat.key]));
            }
            if (turn.stopped) { chat.stopped = true; return this.done(chat, turn, "stopped"); }

            chat.history.push(...res.messages);
            this.addUsage(chat, res.usage);
            this.emit("usage", { usage: res.usage, cost: this.costOf(chat, res.usage) });
            if (res.text) this.emit("assistant:text", { text: res.text });

            if (res.stop === "cut") {
                if (res.calls.length) chat.history.push(...adapter.resultsMessages(res.calls, res.calls.map(() => errorResult("not run: the answer was cut off")), chat));
                return this.done(chat, turn, "cut");
            }
            if (res.stop === "refusal") {
                if (res.calls.length) chat.history.push(...adapter.resultsMessages(res.calls, res.calls.map(() => errorResult("not run: the answer was refused")), chat));
                return this.done(chat, turn, "refusal", JSON.stringify(res.stopDetails || {}));
            }
            if (!res.calls.length) return this.done(chat, turn, "end");

            const results = [];
            let declined = false;
            let closed = false;
            for (const call of res.calls) {
                results.push(await this.runCall(chat, turn, call, { declined, closed, s }));
                if (this.lastWasDecline) declined = true;
                if (this.lastWasClosed) closed = true;
            }
            chat.history.push(...adapter.resultsMessages(res.calls, results, chat));
            if (closed) return this.done(chat, turn, "closed");
            if (turn.steps >= s.maxSteps) return this.done(chat, turn, "cap");
        }
    }

    /** One tool call: canonical arguments, the policy, the ask, the call, the ownership. */
    async runCall(chat, turn, call, state) {
        this.lastWasDecline = false;
        this.lastWasClosed = false;
        const name = call.name;
        if (turn.stopped) return errorResult("stopped by the user");
        if (state.declined) return errorResult("skipped: an earlier call in this step was declined");
        if (call.badJson) return errorResult(`the arguments were not valid JSON: ${String(call.badJson).slice(0, 200)}`);

        if (!chat.names.has(name)) {
            this.emit("call", { call: call.id, name, action: "refuse", reason: "not one of your tools in this chat" });
            return errorResult(`refused by Scumble: not one of your tools in this chat`);
        }
        if (name === "screenshot" && chat.noImages) {
            // the local server refused a picture earlier in this chat (§2 row 26)
            this.emit("call", { call: call.id, name, action: "refuse", reason: "this server does not take images" });
            return errorResult("refused by Scumble: this server does not take images; judge from list_layers and status, and ask the user to look");
        }

        // ---- canonical arguments
        const props = (chat.schemas.get(name) || {}).properties || {};
        const takesDoc = !!props.doc;
        let args = { ...(call.args || {}) };
        if (takesDoc && args.doc === undefined) {
            if (turn.pin == null) return errorResult("the document of this turn was closed; pass doc (see list_documents)");
            args.doc = turn.pin;
        }
        const doc = args.doc !== undefined ? args.doc : turn.pin;
        let layers = [];
        const takesLayer = !!(props.layer || props.source || props.target);
        const wantsLayers = !policy.READS.has(name) && (takesDoc || takesLayer) && doc != null;
        if (wantsLayers) {
            try {
                const answer = await this.read("list_layers", { doc });
                layers = (answer && answer.layers) || [];
                for (const l of layers) this.setOf(chat.seen, doc).add(l.id);
            } catch (err) {
                // the user closed the pinned document while the turn ran: say so, and end the
                // turn after this step rather than answering call after call into a closed tab
                if (doc === turn.pin && /no document with id/.test(err.message)) {
                    turn.pin = null;
                    this.lastWasClosed = true;
                    return errorResult("the document of this turn was closed");
                }
                return errorResult(`not run: could not read the document (${err.message})`);
            }
            const resolved = resolveLayer(args, layers);
            if (resolved.error) return errorResult(resolved.error);
            args = resolved.args;
        }
        let canonical = policy.clamp({ name, args }, { screenshotMax: this.settings().screenshotMax });

        // ---- the facts the policy decides on
        const facts = await this.factsFor(chat, turn, canonical, layers, doc);
        let decision = policy.decide(canonical, facts);

        if (decision.action === "refuse") {
            this.emit("call", { call: call.id, name, args: canonical.args, action: "refuse", reason: decision.reason });
            return errorResult(`refused by Scumble: ${decision.reason}`);
        }
        if (decision.action === "ask") {
            const allowed = await this.ask(call, canonical, decision);
            if (!allowed) {
                this.lastWasDecline = true;
                return errorResult("the user declined; do not reach the same effect another way");
            }
            if (wantsLayers) {
                try {
                    const answer = await this.read("list_layers", { doc });
                    layers = (answer && answer.layers) || [];
                } catch (err) {
                    return errorResult(`not run: could not read the document (${err.message})`);
                }
                const again = policy.decide(canonical, await this.factsFor(chat, turn, canonical, layers, doc));
                const target = canonical.args.layer;
                if (again.action === "refuse" || (target && !layers.some((l) => l.id === target))) {
                    return errorResult("the document changed while you were asked; nothing was run");
                }
            }
        }

        // ---- run it
        turn.undo = policy.undoStep(canonical, { layers });
        turn.docs.add(doc);
        this.emit("call", { call: call.id, name, args: canonical.args, action: decision.action === "ask" ? "allowed" : "auto" });
        const before = layers.map((l) => l.id);
        let res;
        try {
            res = await this.client.callTool(
                { name, arguments: canonical.args },
                undefined,
                { timeout: callTimeout(policy.timeoutOf(canonical)), signal: turn.signal },
            );
        } catch (err) {
            if (turn.stopped || err.name === "AbortError") return errorResult("stopped by the user; if the call had already started, it runs on in the editor");
            return errorResult(`the call did not finish: ${err.message}; it may still be running in the editor, do not repeat it`);
        } finally {
            turn.undo = null;
        }
        turn.steps++;
        this.countFailure(chat, canonical, res.isError);

        // ---- ownership and the pin
        if (!policy.READS.has(name) && takesDoc && name !== "close_document") {
            try {
                const answer = await this.read("list_layers", { doc });
                const after = (answer && answer.layers) || [];
                const named = idsNamedBy(name, parse(textOf(res)));
                const fresh = after.map((l) => l.id).filter((id) => !before.includes(id) && !this.setOf(chat.seen, doc).has(id));
                for (const id of named) if (fresh.includes(id)) this.setOf(chat.owned, doc).add(id);
                for (const l of after) this.setOf(chat.seen, doc).add(l.id);
                if (name === "remove_layer" && canonical.args.layer && after.some((l) => l.id === canonical.args.layer)) {
                    res = withNote(res, "not removed; the layer may be locked");
                }
            } catch (_) { /* a failed after-read leaves owned alone; the result stands */ }
        }
        if (name === "new_document" || name === "activate_document") {
            const made = parse(textOf(res));
            if (made && made.id !== undefined) turn.pin = made.id;
        }
        if (name === "close_document" && doc === turn.pin) turn.pin = null;
        return res;
    }

    /** What the policy needs to know about this call, beyond its arguments. */
    async factsFor(chat, turn, call, layers, doc) {
        const facts = {
            tools: chat.names,
            owned: this.setOf(chat.owned, doc),
            layers,
            busy: false,
            failedTwice: (chat.failures.get(keyOf(call)) || 0) >= 2,
        };
        if (policy.RUNS.has(call.name)) {
            try {
                const answer = await this.read("list_documents");
                const entry = ((answer && answer.documents) || []).find((d) => d.id === doc);
                facts.busy = !!(entry && entry.busy);
            } catch (_) { /* the renderer checks again just before the command */ }
        }
        if (call.name === "generate" || call.name === "generate_new") {
            facts.recipe = chat.recipe || null;
            facts.changedByChat = [...(chat.changedSettings || [])];
        }
        if (/^export/.test(call.name) && call.args.path && this.deps.statFile) {
            facts.file = this.deps.statFile(String(call.args.path));
        }
        return facts;
    }

    /** Show the ask card and wait for the user (Stop counts as a decline). */
    ask(call, canonical, decision) {
        return new Promise((resolve) => {
            this.pending = { callId: call.id, resolve };
            this.emit("ask", { call: call.id, name: canonical.name, args: canonical.args, reason: decision.reason, card: decision.card });
        });
    }

    countFailure(chat, call, failed) {
        const key = keyOf(call);
        if (failed) chat.failures.set(key, (chat.failures.get(key) || 0) + 1);
        else chat.failures.delete(key);
    }

    addUsage(chat, usage) {
        for (const k of ["input", "cacheRead", "cacheWrite", "output", "reasoning"]) chat.usage[k] += Number(usage[k]) || 0;
        const cost = this.costOf(chat, usage);
        if (cost && cost.amount != null) chat.usage.cost += cost.amount;
    }

    costOf(chat, usage) {
        return models.costOf(chat.provider, chat.model, usage, this.deps.now ? this.deps.now() : Date.now());
    }

    record(line) {
        if (this.deps.log && this.deps.log.record) this.deps.log.record({ source: "assistant", text: String(line) });
    }

    done(chat, turn, reason, detail) {
        this.emit("turn:done", { turn: turn.id, reason, detail: detail || "", steps: turn.steps, usage: { ...chat.usage } });
        return { reason, detail: detail || "", steps: turn.steps, usage: { ...chat.usage } };
    }
}

// ---- helpers ------------------------------------------------------------------------------

function textOf(res) {
    return ((res && res.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

function parse(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
}

function errorResult(text) {
    return { content: [{ type: "text", text }], isError: true };
}

function withNote(res, note) {
    const content = (res.content || []).slice();
    const at = content.findIndex((c) => c.type === "text");
    if (at >= 0) content[at] = { ...content[at], text: `${content[at].text}\n${note}` };
    else content.push({ type: "text", text: note });
    return { ...res, content };
}

function keyOf(call) {
    return `${call.name}(${JSON.stringify(call.args || {})})`;
}

/** The layer ids a tool's own answer names (§5, "Ownership" (a)). */
function idsNamedBy(name, result) {
    if (!result || typeof result !== "object") return [];
    const out = [];
    const add = (v) => { if (typeof v === "string" && v) out.push(v); };
    if (["add_paint_layer", "add_filter", "add_text", "add_image_layer", "duplicate_layer", "film_apply_look"].includes(name)) add(result.id);
    if (name === "generate" || name === "glb_place") { add(result.layer && result.layer.id); add(result.depthLayer && result.depthLayer.id); }
    if (name === "film_add_point") add(result.layer);
    return out;
}

/**
 * Every layer reference to an id, the way the command core resolves it (`findLayer`): an id, a
 * name, a unique part of a name, "active" or nothing for the active layer.
 */
function resolveLayer(args, layers) {
    const out = { ...args };
    for (const field of ["layer", "source", "target"]) {
        const raw = out[field];
        if (raw === undefined || raw === null || raw === "") continue;
        const found = findLayer(layers, raw);
        if (found.error) return { error: found.error };
        out[field] = found.id;
    }
    if (out.layer === undefined && layers.length) {
        const active = layers.find((l) => l.active);
        if (active) out.layer = active.id;
    }
    return { args: out };
}

function findLayer(layers, ref) {
    const want = String(ref);
    if (want === "active") {
        const active = layers.find((l) => l.active);
        return active ? { id: active.id } : { error: `no active layer` };
    }
    const byId = layers.find((l) => l.id === want);
    if (byId) return { id: byId.id };
    const byName = layers.filter((l) => String(l.name) === want);
    if (byName.length === 1) return { id: byName[0].id };
    if (byName.length > 1) return { error: `several layers are called "${want}"` };
    const part = layers.filter((l) => String(l.name).toLowerCase().includes(want.toLowerCase()));
    if (part.length === 1) return { id: part[0].id };
    if (part.length > 1) return { error: `"${want}" matches ${part.length} layers (${part.map((l) => l.name).join(", ")})` };
    return { error: `no layer "${want}" (layers: ${layers.map((l) => l.name).join(", ") || "none"})` };
}

/**
 * The user's text joined to a pending user message, never as a second user message (§3). The
 * note carries the "(stopped)" line when the last answer was stopped.
 */
function appendUserText(message, note, text) {
    const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content || "") }];
    if (note) parts.push({ type: "text", text: note });
    parts.push({ type: "text", text: String(text == null ? "" : text) });
    message.content = parts;
    return message;
}

function stopError() {
    const err = new Error("stopped");
    err.name = "AbortError";
    return err;
}

module.exports = { Assistant, DEFAULTS, callTimeout, _findLayer: findLayer, _idsNamedBy: idsNamedBy, _resolveLayer: resolveLayer, _appendUserText: appendUserText };
