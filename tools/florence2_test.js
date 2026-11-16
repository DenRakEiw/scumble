// Florence-2 in the helpers' process (item 62) in plain Node:
//   node tools/florence2_test.js
//   FLORENCE2_DIR=<a model folder holding onnx/florence2/> FLORENCE2_PICS=<a.rgba;b.rgba> node tools/florence2_test.js
// * the BPE tokenizer against ids Hugging Face's `tokenizers` gave for the same slice of the real tokenizer.json
//   (tools/fixtures/bart_tokenizer_slice.json), and decode(encode(x)) = x;
// * greedy decoding on a stand-in step: the forced <s>, the stop at </s>, the trigram ban, the token limit, a stop;
// * Florence2.run on a stand-in runtime: the 577 + L encoder input, the cache's first step without it and the steps
//   after with the decoder's own and the encoder's from step one, the text decoded;
// * the engine's describe job: the picture check, a cancel by jobId, the time limit;
// * the registry's entry: offered, every URL pinned to a commit, sizes and sha256 there, under 400 MB in all;
// * the layer names (renderer/editor/vlm_names.js): short names from captions, which names count as generic;
// * with FLORENCE2_DIR: the real model through a forked helpers' process (HelperProcess), each picture's caption,
//   and a cancel of a detailed run.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const ONNX = path.join(ROOT, "electron", "main", "onnx");
const { BartTokenizer } = require(path.join(ONNX, "bart_tokenizer.js"));
const F2 = require(path.join(ONNX, "florence2.js"));
const { engine, checkVlm } = require(path.join(ONNX, "engine.js"));
const models = require(path.join(ONNX, "models.js"));

const fails = [];
const check = (name, ok, info) => { if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : "")); else console.log("[ok]", name); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SLICE = path.join(ROOT, "tools", "fixtures", "bart_tokenizer_slice.json");

// the ids `tokenizers` gave for the slice (tools/fixtures/bart_tokenizer_slice.json), 2026-11-16; the added tokens
// <loc_1> / <loc_12> with their real ids 50270 / 50281 (`tokenizers` renumbers added tokens of a slice whose vocabulary
// has gaps; on the whole tokenizer.json it gives 50270 / 50281, which the FLORENCE2_DIR part checks)
const EXPECTED = [
    ["What does the image describe?", [0, 14447, 415, 473, 5, 4356, 1580, 2694, 438, 8643, 242, 116, 2]],
    ["Describe in detail what is shown in the image.", [0, 495, 293, 438, 8643, 242, 11, 6769, 3760, 99, 16, 1481, 3355, 11, 5, 4356, 1580, 4, 2]],
    ["A café's naïve 3D shot, 2026!  <loc_12> and émoji 🙂 x", [0, 250, 6056, 506, 3849, 15375, 18, 295, 102, 3849, 10965, 548, 155, 495, 1481, 1242, 6, 291, 176, 401, 328, 1437, 1437, 50281, 8, 1437, 3849, 15375, 119, 139, 267, 118, 1437, 49585, 4333, 27, 9264, 1437, 1178, 2]],
    ["hello<s>world</s>", [0, 700, 890, 139, 0, 605, 368, 4779, 2, 2]],
    ["  leading and trailing  ", [0, 1437, 483, 154, 8, 8419, 718, 154, 1437, 1437, 2]],
    ["tabs\tand\nnewlines", [0, 90, 873, 29, 50117, 463, 50118, 282, 2753, 462, 3141, 2]],
    ["<OD><loc_1><loc_12>", [0, 41552, 673, 495, 15698, 50270, 50281, 2]],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stand-in runtime: four "sessions" keyed by file name, recording every decoder call. */
function fakeRuntime(tok, script, { stepMs = 0 } = {}) {
    const calls = [];
    const V = 51289;
    const tensor = (type, data, dims) => ({ type, data, dims });
    const sessions = {
        vision: { run: async (f) => { calls.push({ g: "vision", dims: f.pixel_values.dims, first: f.pixel_values.data[0] }); return { image_features: tensor("float32", new Float32Array(577 * 768), [1, 577, 768]) }; } },
        embed: { run: async (f) => {
            const ids = Array.from(f.input_ids.data, Number);
            const d = new Float32Array(ids.length * 768);
            ids.forEach((id, i) => { d[i * 768] = id; });   // the token in each row's first value, for the decoder to read
            return { inputs_embeds: tensor("float32", d, [1, ids.length, 768]) };
        } },
        encoder: { run: async (f) => { calls.push({ g: "encoder", dims: f.inputs_embeds.dims, mask: f.attention_mask.dims, tail: f.inputs_embeds.data[577 * 768] }); return { last_hidden_state: tensor("float32", new Float32Array(f.inputs_embeds.data.length), f.inputs_embeds.dims) }; } },
        decoder: { run: async (f) => {
            if (stepMs) await sleep(stepMs);
            const token = f.inputs_embeds.data[0];
            const n = calls.filter((c) => c.g === "decoder").length;
            calls.push({ g: "decoder", token, cache: !!f.use_cache_branch.data[0], pastDec: f["past_key_values.0.decoder.key"].dims[2], pastEnc: f["past_key_values.5.encoder.value"].dims[2], encLen: f.encoder_hidden_states.dims[1] });
            const logits = new Float32Array(V);
            const want = script(token, n);
            logits[want] = 10;
            const out = { logits: tensor("float32", logits, [1, 1, V]) };
            for (let i = 0; i < 6; i++) for (const kv of ["key", "value"]) {
                out[`present.${i}.decoder.${kv}`] = tensor("float32", new Float32Array(12 * (n + 1) * 64), [1, 12, n + 1, 64]);
                // the merged model's encoder outputs after step one are of no use: a run that took them would see 0
                out[`present.${i}.encoder.${kv}`] = n === 0 ? tensor("float32", new Float32Array(12 * 590 * 64), [1, 12, 590, 64]) : tensor("float32", new Float32Array(0), [0, 12, 0, 64]);
            }
            return out;
        } },
    };
    return {
        calls,
        tensor,
        session: async (file) => ({ session: sessions[file], provider: "fake" }),
        free: async () => 0,
        status: () => ({}),
        setDevice() {},
    };
}

(async () => {
    // ---- the tokenizer ----------------------------------------------------------------------------------------------
    const slice = JSON.parse(fs.readFileSync(SLICE, "utf8"));
    const tok = new BartTokenizer(slice);
    for (const [text, ids] of EXPECTED) {
        const got = tok.encode(text);
        check(`encode ${JSON.stringify(text).slice(0, 40)}`, same(got, ids), { got, ids });
        check(`decode(encode) ${JSON.stringify(text).slice(0, 40)}`, tok.decode(got, { skipSpecial: false }) === "<s>" + text + "</s>", tok.decode(got, { skipSpecial: false }));
    }
    check("decode drops the special tokens", tok.decode(tok.encode("hello<s>world</s>")) === "helloworld", tok.decode(tok.encode("hello<s>world</s>")));
    check("encode without <s> </s>", same(tok.encode("the image", { special: false }), tok.encode("the image").slice(1, -1)));
    check("a broken tokenizer.json is refused", (() => { try { new BartTokenizer({ model: { type: "WordPiece" } }); return false; } catch (_) { return true; } })());
    for (const s of ["über 100 % — “quoted”", "日本語のテキスト", "é combining"]) {
        check(`round trip ${JSON.stringify(s)}`, tok.decode(tok.encode(s)) === s, tok.decode(tok.encode(s)));
    }

    // ---- greedy decoding on a stand-in step -------------------------------------------------------------------------
    {
        const V = 20;
        const logitsFor = (want) => { const l = new Float32Array(V); l[want] = 5; return l; };
        let seen = [];
        const toks = await F2.greedy((t, i) => { seen.push([t, i]); return logitsFor([7, 8, 9, 2][Math.min(i - 1, 3)] ?? 7); }, { start: 2, bos: 0, eos: 2, maxTokens: 10 });
        check("greedy forces <s> first and stops at </s>", same(toks, [0, 7, 8, 9, 2]), toks);
        check("greedy feeds each step the token before", same(seen.map((x) => x[0]), [2, 0, 7, 8, 9]), seen);
        // a model that wants "5 6 5 6 5 6 ...": the trigram 5 6 5 may come once only; the next best then wins
        const loop = (t, i) => { const l = new Float32Array(V); l[i % 2 ? 5 : 6] = 9; l[11] = 1; return l; };
        const rep = await F2.greedy(loop, { start: 2, bos: null, eos: 2, maxTokens: 8, noRepeat: 3 });
        check("no repeated trigram", (() => { const g = new Set(); for (let i = 0; i + 2 < rep.length + 1; i++) { const k = [2, ...rep].slice(i, i + 3).join(","); if (g.has(k)) return false; g.add(k); } return true; })(), rep);
        check("the token limit holds", rep.length === 8, rep);
        check("bannedAfter", same([...F2.bannedAfter([2, 5, 6, 5, 6], 3)].sort(), [5]) && F2.bannedAfter([1, 2], 3).size === 0, [...F2.bannedAfter([2, 5, 6, 5, 6], 3)]);
        let n = 0;
        const stopped = await F2.greedy(() => logitsFor(7), { maxTokens: 30, check: () => { if (++n > 3) throw new Error("cancelled"); } }).then(() => "ran", (e) => e.message);
        check("a check that throws stops the loop", stopped === "cancelled" && n === 4, { stopped, n });
        check("cleanText", F2.cleanText("<s> A cat  on a mat.</s><pad>") === "A cat on a mat.");
    }

    // ---- Florence2.run on a stand-in runtime ------------------------------------------------------------------------
    // the "model" answers the slice's tokens for " a cat" then </s>
    const word = tok.encode(" a cat", { special: false });
    {
        const script = (token, n) => (n === 0 ? 0 : n <= word.length ? word[n - 1] : 2);
        const rt = fakeRuntime(tok, script);
        const tokFile = SLICE;
        const f = new F2.Florence2(rt, { vision: "vision", embed: "embed", encoder: "encoder", decoder: "decoder", tokenizer: tokFile });
        const rgba = new Uint8Array(768 * 768 * 4).fill(255);
        const r = await f.run(rgba, { task: "caption" });
        const dec = rt.calls.filter((c) => c.g === "decoder");
        const enc = rt.calls.find((c) => c.g === "encoder");
        const prompt = tok.encode("What does the image describe?");
        check("the caption decoded", r.text === "a cat", r);
        check("the vision input: NCHW 768 with ImageNet's normalisation", same(rt.calls[0].dims, [1, 3, 768, 768]) && Math.abs(rt.calls[0].first - (1 - 0.485) / 0.229) < 1e-5, rt.calls[0]);
        check("the encoder gets 577 image tokens and the prompt", same(enc.dims, [1, 577 + prompt.length, 768]) && same(enc.mask, [1, 577 + prompt.length]) && enc.tail === 0, enc);
        check("step one: no cache, empty pasts", dec[0].cache === false && dec[0].pastDec === 0 && dec[0].pastEnc === 0 && dec[0].token === 2, dec[0]);
        check("the steps after: the cache, the decoder's past grows, the encoder's from step one", dec.slice(1).every((c, i) => c.cache && c.pastDec === i + 1 && c.pastEnc === 590), dec);
        check("the tokens fed back", same(dec.map((c) => c.token), [2, 0, ...word]), dec.map((c) => c.token));
        check("an unknown task is refused", await f.run(rgba, { task: "od" }).then(() => false, (e) => /unknown task/.test(e.message)));
    }

    // ---- the engine's describe job ----------------------------------------------------------------------------------
    {
        const files = { vision: "vision", embed: "embed", encoder: "encoder", decoder: "decoder", tokenizer: SLICE };
        const model = { id: "florence2_base_ft", label: "Florence-2 base" };
        const rgba = new Uint8Array(768 * 768 * 4);
        const eng = engine(fakeRuntime(tok, (t, n) => (n === 0 ? 0 : n <= word.length ? word[n - 1] : 2)));
        const r = await eng.describe({ model, files, image: rgba, task: "caption", jobId: "a" });
        check("describe answers the text, the task and the model", r.text === "a cat" && r.task === "caption" && r.model === model.id && r.provider === "fake", r);
        check("describe refuses a picture of another size", (() => { try { checkVlm({ image: new Uint8Array(4) }); return false; } catch (e) { return /768/.test(e.message); } })());
        check("describe refuses an unknown task", (() => { try { checkVlm({ image: rgba, task: "ocr" }); return false; } catch (e) { return /unknown describe task/.test(e.message); } })());
        // a model that never ends, a step of 40 ms: a cancel by id stops it, the time limit too
        const slow = engine(fakeRuntime(tok, (t, n) => 10 + n, { stepMs: 40 }));   // never the end token, never a repeat
        const p = slow.describe({ model, files, image: rgba, task: "detailed", jobId: "j1" }).then(() => "ran", (e) => e.message);
        await sleep(200);
        slow.cancel("j1");
        const t0 = Date.now();
        const said = await p;
        check("a cancel by jobId stops the run at its next step", said === "cancelled" && Date.now() - t0 < 500, { said, ms: Date.now() - t0 });
        const t1 = Date.now();
        const late = await slow.describe({ model, files, image: rgba, task: "detailed", jobId: "j2", timeoutMs: 1000 }).then(() => "ran", (e) => e.message);
        check("the time limit stops it", /longer than 1 s/.test(late) && Date.now() - t1 < 2500, { late, ms: Date.now() - t1 });
        const again = await slow.describe({ model, files, image: rgba, task: "caption", jobId: "j1", timeoutMs: 600000 }).then((x) => x.steps, (e) => e.message);
        check("a cancelled id does not stop the next job of that id", again === 40, again);
    }

    // ---- the registry ----------------------------------------------------------------------------------------------
    {
        const m = models.byId("florence2_base_ft");
        check("Florence-2 is in the registry and offered", !!m && models.offered(m) && m.kind === "vlm" && m.license === "MIT", m && { kind: m.kind, invalid: m.invalid });
        const total = m.files.reduce((a, f) => a + f.size, 0);
        check("under 400 MB in all", total < 400e6, total);
        check("every file pinned to a commit, with its sha256", m.files.every((f) => /\/resolve\/[0-9a-f]{40}\//.test(f.url) && /^[0-9a-f]{64}$/.test(f.sha256) && f.size > 0), m.files.map((f) => f.url));
        check("the roles Florence2 reads", same(m.files.map((f) => f.role).sort(), ["decoder", "embed", "encoder", "tokenizer", "vision"]));
        check("a set in its own folder", m.subdir === "onnx/florence2" && m.strict);
    }

    // ---- the layer names --------------------------------------------------------------------------------------------
    {
        const N = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "vlm_names.js")).href);
        const cases = [
            ["A woman sitting on the hood of a blue car.", "Woman sitting on the hood of a blue car"],
            ["A car with a bunch of stuffed animals in the back.", "Car with a bunch of stuffed animals"],
            ["Two coffee cups with faces on them are sitting on saucers.", "Two coffee cups with faces on them"],
            ["In this image we can see a dog. In the background there are trees.", "Dog"],
            ["An image of a red apple on a table", "Red apple on a table"],
            ["the", "The"],
            ["", ""],
            ["Supercalifragilisticexpialidociousnessandmorebeyondforty", "Supercalifragilisticexpialidociousnessan"],
        ];
        for (const [c, want] of cases) check(`shortName ${JSON.stringify(c).slice(0, 40)}`, N.shortName(c) === want, N.shortName(c));
        check("names stay short", cases.every(([c]) => N.shortName(c).length <= N.NAME_MAX));
        for (const g of ["Result 3", "Paste 2", "Result 3 copy", "merged copy", "image", "IMG_2041", "Screenshot 2026-11-16 at 07.12.33", "3f2a9c0e41d7", "pasted image (2)", "DSC01234", "", "PXL_20261116_071233"]) check(`generic: ${JSON.stringify(g)}`, N.isGenericName(g) === true);
        for (const k of ["jacket", "anna_face", "Woman on a car", "logo final", "Sky"]) check(`kept: ${JSON.stringify(k)}`, N.isGenericName(k) === false);
    }

    // ---- the real model through the helpers' process ----------------------------------------------------------------
    const dir = process.env.FLORENCE2_DIR;
    if (dir) {
        const { HelperProcess } = require(path.join(ONNX, "helpers.js"));
        const m = models.byId("florence2_base_ft");
        const files = models.paths(m, dir);
        check("the model is in FLORENCE2_DIR", !!files, models.describe(m.id, dir).files.map((f) => [f.name, f.present]));
        if (files) {
            const full = new BartTokenizer(JSON.parse(fs.readFileSync(files.tokenizer, "utf8")));
            check("the whole tokenizer.json: task and location tokens", same(full.encode("<OD><loc_1><loc_12>"), [0, 41552, 7111, 15698, 50270, 50281, 2]) && same(full.encode("What does the image describe?"), [0, 2264, 473, 5, 2274, 6190, 116, 2]), full.encode("<OD><loc_1><loc_12>"));
            const verified = await models.verify(m.id, dir);
            check("its files match their sha256", verified.ok, verified.files);
            const hp = new HelperProcess({ idleMs: 0 });
            const device = process.env.FLORENCE2_DEVICE || "auto";
            const pics = (process.env.FLORENCE2_PICS || "").split(";").filter(Boolean);
            for (const p of pics) {
                const image = new Uint8Array(fs.readFileSync(p));
                for (const task of ["caption", "detailed", "caption"]) {
                    const t0 = Date.now();
                    const r = await hp.call("describe", { device, model: { id: m.id, label: m.label }, files, image, task });
                    console.log(JSON.stringify({ pic: path.basename(p), task, provider: r.provider, wall: Date.now() - t0, ms: r.ms, steps: r.steps, text: r.text }));
                    check(`a ${task} of ${path.basename(p)}`, typeof r.text === "string" && r.text.length > 3, r);
                }
            }
            if (pics.length) {
                const image = new Uint8Array(fs.readFileSync(pics[0]));
                const p = hp.call("describe", { device, model: { id: m.id, label: m.label }, files, image, task: "detailed", jobId: "real" }).then((r) => "ran: " + r.steps, (e) => e.message);
                await sleep(30);
                hp.cancel("real");
                const said = await p;
                check("a cancel reaches the helpers' process", said === "cancelled", said);
            }
            await hp.kill({ reason: "quit" });
        }
    }

    if (fails.length) { console.log("FAIL\n  " + fails.join("\n  ")); process.exit(1); }
    console.log("PASS");
})().catch((err) => { console.error(err); process.exit(1); });
