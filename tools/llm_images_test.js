// The reference pictures of prompt upsampling (electron/main/llm.js, item 26 step 26d2, docs/PLAN_REFS.md) in plain
// Node, no Electron and no key:
//   node tools/llm_images_test.js
// ./keys and ./settings are stubbed (the pattern of tools/openrouter_test.js sections 11 and 12) and a scripted fetch
// plays OpenAI's Responses API, Gemini, Anthropic and the OpenAI-compatible Chat Completions servers (the local
// endpoint, ToAPIs, a Chat provider row). It checks the exact part sequence each builder sends, that a request
// without reference pictures is the request from before them, the cap of six, the switch, `vision: false`, the
// compatible client's steps (all pictures, the crop, the text) with their notes, and the labels on one line.
"use strict";

const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const llmPath = path.join(ROOT, "electron", "main", "llm.js");

const KEYS = { openai: "sk-openai-0123456789abcdef", gemini: "AIzaGemini0123456789abcdef", anthropic: "sk-ant-0123456789abcdef", toapis: "sk-toapis-0123456789abcdef", deepseek: "sk-ds-0123456789abcdef" };
const COMPAT = { url: "http://127.0.0.1:5999", model: "local-vision" };
const ROWS = [
    { provider: "deepseek", model: "ds-sees" },
    { provider: "deepseek", model: "ds-blind", vision: false },
    { provider: "gemini", model: "gemini-blind", vision: false },
    // a row of the local endpoint's model, ticked for the assistant only: its vision flag still counts
    { provider: "compat", model: "local-blind", vision: false, upsample: false },
];
const state = { settings: null };
function reset(extra = {}) {
    state.settings = { llm: { compat: { ...COMPAT }, models: ROWS.map((r) => ({ ...r })), ...extra } };
}
reset();

const orig = Module._load;
Module._load = function (request, parent, ...rest) {
    if (request === "electron") return { app: { getPath: () => path.join(os.tmpdir(), "scumble-llm-images-test") }, safeStorage: {} };
    if (parent && parent.filename === llmPath) {
        if (request === "./keys") return { get: (id) => KEYS[id] || "", describe: (id) => ({ set: !!KEYS[id] }) };
        if (request === "./settings") return { get: () => state.settings };
    }
    return orig.call(this, request, parent, ...rest);
};
let llm;
try { llm = require(llmPath); } finally { Module._load = orig; }

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${!ok && detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 600 ? s.slice(0, 600) + " ..." : s; };

// ---- pictures, words, today's parts ------------------------------------------------------------------------------

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngOf = (tag) => Buffer.concat([SIG, Buffer.from(tag, "latin1")]);
const CROP = pngOf("THE-CROP");
const REFS = Array.from({ length: 8 }, (_, i) => pngOf("REFERENCE-" + (i + 1)));
const LABELS = ["a", "b", "c", "d", "e", "f", "g", "h"].map((n, i) => `@img${i + 1} (the layer "${n}")`);
const refs = (n) => REFS.slice(0, n).map((png, i) => ({ png: new Uint8Array(png), label: LABELS[i] }));   // as IPC hands them

const INSTR = "rewrite the prompt";
const ORDER_CROP = "The first picture is the one being edited; the reference pictures follow it, each after a line that gives its token.";
const ORDER_NONE = "The pictures are reference images, each after a line that gives its token.";
const uri = (b) => "data:image/png;base64," + Buffer.from(b).toString("base64");
const b64 = (b) => Buffer.from(b).toString("base64");

/** The neutral turn the plan specifies, written out here independently of llm.js. */
function expectTurn(crop, pictures) {
    if (!pictures.length) return [{ text: INSTR }, ...(crop ? [{ png: crop }] : [])];
    const out = [{ text: INSTR + "\n\n" + (crop ? ORDER_CROP : ORDER_NONE) }];
    if (crop) out.push({ text: "The picture being edited:" }, { png: crop });
    pictures.forEach((png, i) => out.push({ text: `Reference picture ${LABELS[i]}:` }, { png }));
    return out;
}
const MAP = {
    openai: (p) => (p.png ? { type: "input_image", image_url: uri(p.png), detail: "auto" } : { type: "input_text", text: p.text }),
    gemini: (p) => (p.png ? { inline_data: { mime_type: "image/png", data: b64(p.png) } } : { text: p.text }),
    anthropic: (p) => (p.png ? { type: "image", source: { type: "base64", media_type: "image/png", data: b64(p.png) } } : { type: "text", text: p.text }),
    chat: (p) => (p.png ? { type: "image_url", image_url: { url: uri(p.png) } } : { type: "text", text: p.text }),
};
function expectParts(kind, crop, pictures) {
    const t = expectTurn(crop, pictures);
    return (kind === "anthropic" ? [...t.slice(1), t[0]] : t).map(MAP[kind]);
}
/** A request's parts as the test reads them back, by the provider it went to. */
function partsOf(call) {
    const b = call.body;
    if (/api\.openai\.com/.test(call.url)) return b.input[0].content;
    if (/generativelanguage/.test(call.url)) return b.contents[0].parts;
    return b.messages[0].content;
}
/** The pictures of a request's parts, decoded, in order. */
function picturesOf(parts) {
    if (!Array.isArray(parts)) return [];
    return parts.map((p) => {
        const u = (p.image_url && (p.image_url.url || p.image_url)) || null;
        if (typeof u === "string") return Buffer.from(u.replace(/^data:image\/png;base64,/, ""), "base64");
        if (p.inline_data) return Buffer.from(p.inline_data.data, "base64");
        if (p.source) return Buffer.from(p.source.data, "base64");
        return null;
    }).filter(Boolean);
}
const sameBytes = (got, want) => got.length === want.length && got.every((b, i) => b.equals(want[i]));

// ---- the scripted servers ----------------------------------------------------------------------------------------

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function okFor(url) {
    if (/api\.openai\.com/.test(url)) return json(200, { output: [{ type: "message", content: [{ type: "output_text", text: "ok openai" }] }] });
    if (/generativelanguage/.test(url)) return json(200, { candidates: [{ content: { parts: [{ text: "ok gemini" }] } }] });
    if (/anthropic\.com/.test(url)) return json(200, { content: [{ type: "text", text: "ok anthropic" }], stop_reason: "end_turn" });
    return json(200, { choices: [{ index: 0, message: { role: "assistant", content: "ok chat" }, finish_reason: "stop" }] });
}
const fail = (status, message) => () => json(status, { error: { message } });

const realFetch = globalThis.fetch;
/** One llm.ask with the given request; `answers` answer the calls in order, then every call succeeds. */
async function ask(id, req, answers = []) {
    const calls = [];
    const logs = [];
    const log = console.log;
    globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), raw: init.body, body: JSON.parse(init.body) });
        const a = answers[calls.length - 1];
        return a ? a() : okFor(String(url));
    };
    console.log = (...a) => logs.push(a.join(" "));
    try {
        return { calls, logs, res: await llm.ask({ id, instruction: INSTR, ...req }) };
    } catch (err) {
        return { calls, logs, err: String(err && err.message || err) };
    } finally {
        globalThis.fetch = realFetch;
        console.log = log;
    }
}

// ---- the checks --------------------------------------------------------------------------------------------------

async function main() {
    const BUILDERS = [
        ["openai", "openai:gpt-5.6-luna"],
        ["gemini", "gemini:gemini-3.8-flash"],
        ["anthropic", "anthropic:claude-haiku-4-5"],
        ["chat", "compat:local-vision"],
        ["chat", "toapis:gemini-3.8-flash"],
        ["chat", "deepseek:ds-sees"],
    ];

    // 1. every builder: the instruction and the order note, the crop after its line, each reference after its label
    for (const [kind, id] of BUILDERS) {
        const r = await ask(id, { image: CROP, images: refs(2) });
        const parts = r.calls[0] && partsOf(r.calls[0]);
        const want = expectParts(kind, CROP, REFS.slice(0, 2));
        check(`${id}: one request, the parts in order (instruction and order note, "The picture being edited:" and the crop, each "Reference picture <label>:" and its picture)${kind === "anthropic" ? ", the instruction last" : ""}`,
            !r.err && r.calls.length === 1 && eq(parts, want), short({ err: r.err, calls: r.calls.length, parts }));
        check(`${id}: the bytes of the crop and both references arrive unchanged, pictures 2, no note`,
            !!parts && sameBytes(picturesOf(parts), [CROP, REFS[0], REFS[1]]) && !!r.res && r.res.pictures === 2 && r.res.note === "", short(r.res));
    }
    // Anthropic: the text last, spelled out
    {
        const r = await ask("anthropic:claude-haiku-4-5", { image: CROP, images: refs(1) });
        const c = r.calls[0].body.messages[0].content;
        check("anthropic: the instruction with the order note is the last part, the crop's line the first",
            c[c.length - 1].type === "text" && c[c.length - 1].text === INSTR + "\n\n" + ORDER_CROP && c[0].text === "The picture being edited:", short(c.map((p) => p.type + (p.text ? ":" + p.text.slice(0, 30) : ""))));
    }
    // no crop (Generate new, 26f): the order note says so and there is no line for the crop
    for (const [kind, id] of [["chat", "compat:local-vision"], ["gemini", "gemini:gemini-3.8-flash"], ["anthropic", "anthropic:claude-haiku-4-5"]]) {
        const r = await ask(id, { image: null, images: refs(2) });
        const parts = r.calls[0] && partsOf(r.calls[0]);
        check(`${id} without a crop: the order note for reference images only, the two references, pictures 2`,
            !r.err && eq(parts, expectParts(kind, null, REFS.slice(0, 2))) && r.res.pictures === 2 && r.res.note === "", short({ err: r.err, parts }));
    }

    // 2. no reference pictures: the request from before them, byte for byte, whether `images` is [] or absent
    const TODAY = {
        "openai:gpt-5.6-luna": (content) => ({ model: "gpt-5.6-luna", input: [{ role: "user", content }], max_output_tokens: 4096, reasoning: { effort: "low" } }),
        "gemini:gemini-3.8-flash": (parts) => ({ contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: 4096, responseModalities: ["TEXT"], thinkingConfig: { thinkingLevel: "low" } } }),
        "anthropic:claude-haiku-4-5": (content) => ({ model: "claude-haiku-4-5", max_tokens: 4096, messages: [{ role: "user", content }] }),
        "compat:local-vision": (content) => ({ model: "local-vision", messages: [{ role: "user", content }], max_tokens: 4096, stream: false }),
    };
    const TODAY_PARTS = {
        "openai:gpt-5.6-luna": (crop) => [{ type: "input_text", text: INSTR }, ...(crop ? [{ type: "input_image", image_url: uri(crop), detail: "auto" }] : [])],
        "gemini:gemini-3.8-flash": (crop) => [{ text: INSTR }, ...(crop ? [{ inline_data: { mime_type: "image/png", data: b64(crop) } }] : [])],
        "anthropic:claude-haiku-4-5": (crop) => [...(crop ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64(crop) } }] : []), { type: "text", text: INSTR }],
        "compat:local-vision": (crop) => (crop ? [{ type: "text", text: INSTR }, { type: "image_url", image_url: { url: uri(crop) } }] : INSTR),
    };
    for (const id of Object.keys(TODAY)) {
        for (const crop of [CROP, null]) {
            const want = JSON.stringify(TODAY[id](TODAY_PARTS[id](crop)));
            const a = await ask(id, { image: crop, images: [] });
            const b = await ask(id, { image: crop });
            check(`${id}, ${crop ? "with" : "without"} the crop and no references: the body is today's, byte for byte (images [] and absent alike), pictures 0`,
                !a.err && !b.err && a.calls.length === 1 && b.calls.length === 1 && a.calls[0].raw === want && b.calls[0].raw === want && a.res.pictures === 0 && b.res.pictures === 0 && a.res.note === "",
                short({ err: a.err || b.err, got: a.calls[0] && a.calls[0].raw, want }));
        }
    }

    // 3. eight pictures in, six out, in label order
    {
        const r = await ask("compat:local-vision", { image: CROP, images: refs(8) });
        const parts = partsOf(r.calls[0]);
        const labels = parts.filter((p) => p.type === "text" && /^Reference picture /.test(p.text)).map((p) => p.text);
        check("8 reference pictures in: the crop and 6 go out, labels @img1-@img6 in order, pictures 6",
            eq(parts, expectParts("chat", CROP, REFS.slice(0, 6))) && picturesOf(parts).length === 7 && labels.length === 6 && labels[5] === `Reference picture ${LABELS[5]}:` && r.res.pictures === 6, short({ labels, pictures: r.res && r.res.pictures }));
        const g = await ask("gemini:gemini-3.8-flash", { image: CROP, images: refs(8) });
        check("the direct builders cap at 6 too (Gemini: 7 pictures, pictures 6)", picturesOf(partsOf(g.calls[0])).length === 7 && g.res.pictures === 6, short(g.res));
    }

    // 4. the switch: settings.llm.refPictures false keeps them back, the crop still goes; true and absent send them
    {
        reset({ refPictures: false });
        const r = await ask("compat:local-vision", { image: CROP, images: refs(2) });
        const a = await ask("anthropic:claude-haiku-4-5", { image: CROP, images: refs(2) });
        reset({ refPictures: true });
        const on = await ask("compat:local-vision", { image: CROP, images: refs(2) });
        reset();
        check("refPictures false: one picture (the crop), the request of today, pictures 0",
            r.calls.length === 1 && r.calls[0].raw === JSON.stringify(TODAY["compat:local-vision"](TODAY_PARTS["compat:local-vision"](CROP))) && r.res.pictures === 0 && r.res.note === "", short({ parts: r.calls[0] && partsOf(r.calls[0]), res: r.res }));
        check("refPictures false on a direct builder (Anthropic): the crop only, pictures 0", eq(partsOf(a.calls[0]), TODAY_PARTS["anthropic:claude-haiku-4-5"](CROP)) && a.res.pictures === 0, short(a.res));
        check("refPictures true: the pictures go", picturesOf(partsOf(on.calls[0])).length === 3 && on.res.pictures === 2, short(on.res));
    }

    // 5. vision: false - no picture at all, neither the crop nor a reference, and no note
    {
        const d = await ask("deepseek:ds-blind", { image: CROP, images: refs(2) });
        check("a Chat provider row with vision false: one request, the plain string content, pictures 0, no note",
            !d.err && d.calls.length === 1 && d.calls[0].body.messages[0].content === INSTR && d.res.pictures === 0 && d.res.note === "", short({ err: d.err, content: d.calls[0] && d.calls[0].body.messages[0].content, res: d.res }));
        const g = await ask("gemini:gemini-blind", { image: CROP, images: refs(2) });
        check("a Gemini row with vision false: the text part only, pictures 0, no note",
            !g.err && g.calls.length === 1 && eq(partsOf(g.calls[0]), [{ text: INSTR }]) && g.res.pictures === 0 && g.res.note === "", short({ err: g.err, parts: g.calls[0] && partsOf(g.calls[0]), res: g.res }));
        const c = await ask("compat:local-blind", { image: CROP, images: refs(2) });
        check("the local endpoint's row with vision false (ticked for the assistant only): the plain string, pictures 0, no note",
            !c.err && c.calls.length === 1 && c.calls[0].body.messages[0].content === INSTR && c.calls[0].body.model === "local-blind" && c.res.pictures === 0 && c.res.note === "", short({ err: c.err, res: c.res }));
        const s = await ask("deepseek:ds-sees", { image: CROP, images: refs(2) });
        check("a row without the flag sees: the crop and both references", picturesOf(partsOf(s.calls[0])).length === 3 && s.res.pictures === 2, short(s.res));
    }

    // 6. the compatible client's steps
    {
        const a = await ask("compat:local-vision", { image: CROP, images: refs(2) }, [fail(400, "too many images in the request")]);
        check("local endpoint, 400 \"too many images\" then 200: 2 calls, the second the crop alone (today's request), note crop only, pictures 0",
            !a.err && a.calls.length === 2 && picturesOf(partsOf(a.calls[0])).length === 3 && a.calls[1].raw === JSON.stringify(TODAY["compat:local-vision"](TODAY_PARTS["compat:local-vision"](CROP))) && a.res.note === "crop only" && a.res.pictures === 0,
            short({ err: a.err, calls: a.calls.length, res: a.res }));
        const b = await ask("compat:local-vision", { image: CROP, images: refs(2) }, [fail(400, "too many images"), fail(400, "image input is not supported")]);
        check("local endpoint, 400, 400, 200: 3 calls, the third a string content, note text only, pictures 0",
            !b.err && b.calls.length === 3 && picturesOf(partsOf(b.calls[1])).length === 1 && b.calls[2].body.messages[0].content === INSTR && b.res.note === "text only" && b.res.pictures === 0,
            short({ err: b.err, calls: b.calls.length, res: b.res }));
        const c = await ask("compat:local-vision", { image: CROP, images: refs(2) }, [fail(401, "invalid api key")]);
        check("local endpoint, 401 (a model id with \"vision\" in it): exactly one call, the error thrown", !!c.err && c.calls.length === 1 && /invalid api key/.test(c.err), short({ err: c.err, calls: c.calls.length }));
        const c2 = await ask("compat:local-vision", { image: CROP }, [fail(401, "invalid api key")]);
        check("local endpoint, 401 with the crop only: one call (it was two before 26d2)", !!c2.err && c2.calls.length === 1, short({ err: c2.err, calls: c2.calls.length }));
        // the server repeats the model id in its own text: "vision" in the id is no failure about images
        const c3 = await ask("compat:local-vision", { image: CROP, images: refs(2) }, [fail(404, 'model "local-vision" not found, try pulling it first')]);
        check("local endpoint, 404 naming a model id with \"vision\": one call", !!c3.err && c3.calls.length === 1, short({ err: c3.err, calls: c3.calls.length }));
        const c4 = await ask("compat:local-vision", { image: CROP, images: refs(2) }, [fail(404, "local-vision does not support image input")]);
        check("local endpoint, a failure that names images besides the id: steps down", !c4.err && c4.calls.length === 2 && c4.res.note === "crop only", short({ err: c4.err, calls: c4.calls.length, res: c4.res }));
        const others = [];
        for (const [status, msg] of [[402, "insufficient balance"], [429, "rate limited"], [500, "internal error"], [503, "overloaded"], [404, "model 'x' not found"]]) {
            const r = await ask("compat:local-vision", { image: CROP, images: refs(2) }, [fail(status, msg)]);
            others.push({ status, calls: r.calls.length, err: !!r.err });
        }
        check("local endpoint, 402 / 429 / 500 / 503 / 404 that do not name images: one call each", others.every((o) => o.calls === 1 && o.err), short(others));
        const d = await ask("compat:local-vision", { image: CROP, images: refs(2) }, [fail(500, "this model does not support images")]);
        check("local endpoint, a 500 whose words are about images: stepped down to the crop", !d.err && d.calls.length === 2 && d.res.note === "crop only", short({ err: d.err, calls: d.calls.length, res: d.res }));
        const e = await ask("compat:local-vision", { image: CROP }, [fail(400, "image input is not supported")]);
        check("local endpoint without references, 400 on the crop: 2 calls, the second the plain string, note text only (as before)", !e.err && e.calls.length === 2 && e.calls[1].body.messages[0].content === INSTR && e.res.note === "text only", short({ err: e.err, res: e.res }));
        const f = await ask("compat:local-vision", { image: null, images: refs(2) }, [fail(400, "image input is not supported")]);
        check("local endpoint without a crop: all pictures, then the text (no crop step), note text only", !f.err && f.calls.length === 2 && f.calls[1].body.messages[0].content === INSTR && f.res.note === "text only" && f.res.pictures === 0, short({ err: f.err, calls: f.calls.length, res: f.res }));
        // strict (ToAPIs): only a 400 / 413 / 415 / 422 that names the image steps down
        const s = await ask("toapis:gemini-3.8-flash", { image: CROP, images: refs(2) }, [fail(400, "at most one image_url per request")]);
        check("ToAPIs (strict), 400 naming images then 200: 2 calls, note crop only", !s.err && s.calls.length === 2 && picturesOf(partsOf(s.calls[1])).length === 1 && s.res.note === "crop only", short({ err: s.err, calls: s.calls.length, res: s.res }));
        const s2 = await ask("toapis:gemini-3.8-flash", { image: CROP, images: refs(2) }, [fail(400, "max_tokens must be at least 16")]);
        check("ToAPIs (strict), 400 that does not name images: one call", !!s2.err && s2.calls.length === 1, short({ err: s2.err, calls: s2.calls.length }));
        const s3 = await ask("toapis:gemini-3.8-flash", { image: CROP, images: refs(2) }, [fail(413, "<title>413 Request Entity Too Large</title>")]);
        check("ToAPIs (strict), 413 on every picture from a proxy: 2 calls, note crop only", !s3.err && s3.calls.length === 2 && picturesOf(partsOf(s3.calls[1])).length === 1 && s3.res.note === "crop only", short({ err: s3.err, calls: s3.calls.length, res: s3.res }));
        const s4 = await ask("toapis:gemini-3.8-flash", { image: CROP }, [fail(413, "<title>413 Request Entity Too Large</title>")]);
        check("ToAPIs (strict), 413 on the crop alone: one call, as before", !!s4.err && s4.calls.length === 1, short({ err: s4.err, calls: s4.calls.length }));
    }

    // 7. labels: one line, at most 120 characters; the bytes as a Uint8Array, a Buffer or an ArrayBuffer
    {
        const r = await ask("compat:local-vision", { image: CROP, images: [{ png: new Uint8Array(REFS[0]), label: '@img1 (the layer\n"a"\r\n\t second line)' }] });
        const line = partsOf(r.calls[0]).find((p) => p.type === "text" && /^Reference picture /.test(p.text));
        check("a label with line breaks arrives on one line", !!line && line.text === 'Reference picture @img1 (the layer "a" second line):', short(line));
        const long = "@img1 (the layer \"" + "x".repeat(300) + "\")";
        const r2 = await ask("compat:local-vision", { image: CROP, images: [{ png: REFS[0], label: long }] });
        const line2 = partsOf(r2.calls[0]).find((p) => p.type === "text" && /^Reference picture /.test(p.text));
        check("a label is cut to 120 characters", !!line2 && line2.text === `Reference picture ${long.slice(0, 120)}:`, short(line2 && line2.text.length));
        // 59 emoji in a name (clean() keeps 60 code points): the cut never splits a surrogate pair
        const emoji = "@img1 (the layer \"a" + String.fromCodePoint(0x1f600).repeat(59) + "\")";
        const r6 = await ask("compat:local-vision", { image: CROP, images: [{ png: REFS[0], label: emoji }] });
        const line6 = partsOf(r6.calls[0]).find((p) => p.type === "text" && /^Reference picture /.test(p.text));
        // 80 code points but 139 UTF-16 units: a cut by units at 120 went through the 51st emoji
        check("an emoji label is measured in code points, never cut through a pair", !!line6 && line6.text.isWellFormed() && line6.text === `Reference picture ${emoji}:`, short(line6 && line6.text.length));
        const many = "@img1 (the layer \"" + String.fromCodePoint(0x1f600).repeat(200) + "\")";
        const r7 = await ask("compat:local-vision", { image: CROP, images: [{ png: REFS[0], label: many }] });
        const line7 = partsOf(r7.calls[0]).find((p) => p.type === "text" && /^Reference picture /.test(p.text));
        check("a long emoji label is cut at 120 code points", !!line7 && line7.text.isWellFormed() && Array.from(line7.text).length === "Reference picture ".length + 120 + 1, short(line7 && line7.text.length));
        const ab = REFS[1].buffer.slice(REFS[1].byteOffset, REFS[1].byteOffset + REFS[1].byteLength);
        const r3 = await ask("compat:local-vision", { image: new Uint8Array(CROP), images: [{ png: REFS[0], label: LABELS[0] }, { png: ab, label: LABELS[1] }] });
        check("a Buffer and an ArrayBuffer arrive as their bytes", sameBytes(picturesOf(partsOf(r3.calls[0])), [CROP, REFS[0], REFS[1]]) && r3.res.pictures === 2, short(r3.res));
        const r4 = await ask("compat:local-vision", { image: CROP, images: [{ png: REFS[0], label: "  " }, { png: null, label: LABELS[0] }, { png: "not bytes", label: LABELS[0] }, null, { png: REFS[1], label: LABELS[1] }] });
        check("a picture without a label or without bytes is left out", picturesOf(partsOf(r4.calls[0])).length === 2 && r4.res.pictures === 1 && partsOf(r4.calls[0]).some((p) => p.text === `Reference picture ${LABELS[1]}:`), short(r4.res));
        const r5 = await ask("compat:local-vision", { image: CROP, images: "not a list" });
        check("images that are not a list count as none (today's request)", r5.calls.length === 1 && r5.calls[0].raw === JSON.stringify(TODAY["compat:local-vision"](TODAY_PARTS["compat:local-vision"](CROP))), short(r5.err));
    }

    // 8. the log line names the reference pictures
    {
        const r = await ask("compat:local-vision", { image: CROP, images: refs(2) }, [fail(400, "too many images")]);
        const r2 = await ask("gemini:gemini-3.8-flash", { image: CROP, images: refs(2) });
        check("the log line: crop only with no picture count after a step down, \"2 reference pictures\" when they went",
            /, crop only$/.test(r.logs.join("\n")) && !/reference picture/.test(r.logs.join("\n")) && /, 2 reference pictures$/.test(r2.logs.join("\n")), short([r.logs, r2.logs]));
    }

    const failed = results.filter((x) => !x).length;
    console.log(`${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });

