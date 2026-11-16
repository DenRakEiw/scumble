// Florence-2 (Microsoft, MIT; onnx-community's ONNX export of Florence-2-base-ft, its 8-bit files): a caption of a
// picture in the helpers' process (item 62). Four graphs and the tokenizer:
//
//   vision_encoder  pixel_values [1, 3, 768, 768] float32 (ImageNet mean / std)  -> image_features [1, 577, 768]
//   embed_tokens    input_ids [1, L] int64                                         -> inputs_embeds [1, L, 768]
//   encoder_model   inputs_embeds [1, 577 + L, 768], attention_mask [1, 577 + L]   -> last_hidden_state
//   decoder_model_merged  inputs_embeds of the last token, the encoder's states and mask, the key / value cache of
//                   its 6 layers (`past_key_values.<i>.{decoder,encoder}.{key,value}`, [1, 12, n, 64]) and
//                   `use_cache_branch` -> logits [1, 1, 51289] and the cache's next state (`present.<i>...`)
//
// The task token becomes its sentence before tokenizing, as Florence-2's processor does it ("<CAPTION>": "What does
// the image describe?"); the text is <s> sentence </s> after the 577 image tokens. Decoding is greedy, starts at
// `</s>` (decoder_start_token_id 2), forces `<s>` first (forced_bos_token_id 0), bans a repeated trigram
// (no_repeat_ngram_size 3), and stops at `</s>`. The model's generation_config asks for a beam of 3; greedy is a
// third of the decoder's work, and its captions on the pictures tried for item 62 were right in the main (a beam was
// not compared).
"use strict";

const fs = require("node:fs");
const { BartTokenizer } = require("./bart_tokenizer");
const { IMAGENET } = require("./models");

const SIDE = 768;
const LAYERS = 6;
const HEADS = 12;
const HEAD_DIM = 64;
const START = 2;         // decoder_start_token_id
const BOS = 0;           // forced_bos_token_id
const EOS = 2;
const NO_REPEAT = 3;

/** Florence-2's task tokens and the sentences its processor puts in their place. */
const TASKS = {
    caption: { token: "<CAPTION>", prompt: "What does the image describe?", maxTokens: 40 },
    detailed: { token: "<DETAILED_CAPTION>", prompt: "Describe in detail what is shown in the image.", maxTokens: 160 },
};

/**
 * The tokens a step may not choose: every token that followed an earlier occurrence of the last `n - 1` tokens
 * (`no_repeat_ngram_size`), the decoder's start token included as Hugging Face counts it.
 */
function bannedAfter(seq, n) {
    const out = new Set();
    if (!n || seq.length < n - 1) return out;
    const k = n - 1;
    const tail = seq.slice(seq.length - k);
    for (let i = 0; i + k < seq.length; i++) {
        let same = true;
        for (let j = 0; j < k; j++) if (seq[i + j] !== tail[j]) { same = false; break; }
        if (same) out.add(seq[i + k]);
    }
    return out;
}

/** The largest logit's index, `banned` left out. */
function argmax(logits, banned) {
    let best = -1, bestV = -Infinity;
    for (let i = 0; i < logits.length; i++) {
        const v = logits[i];
        if (v > bestV && !(banned && banned.has(i))) { bestV = v; best = i; }
    }
    return best;
}

/**
 * Greedy decoding on any step function (the decoder, or a stand-in in tools/florence2_test.js).
 * @param {(token: number, index: number) => Promise<Float32Array> | Float32Array} step the logits after `token`
 * @param {{ start?: number, bos?: number | null, eos?: number, maxTokens?: number, noRepeat?: number,
 *   check?: () => void | Promise<void> }} [opts] `check` runs before every step and throws to stop (a cancel, the
 *   time limit)
 * @returns {Promise<number[]>} the tokens chosen, the end token included when it came
 */
async function greedy(step, { start = START, bos = BOS, eos = EOS, maxTokens = 40, noRepeat = NO_REPEAT, check = null } = {}) {
    const seq = [start];
    for (let t = 0; t < maxTokens; t++) {
        if (check) await check();
        const logits = await step(seq[seq.length - 1], t);
        const next = t === 0 && bos != null ? bos : argmax(logits, bannedAfter(seq, noRepeat));
        if (next < 0) break;
        seq.push(next);
        if (next === eos) break;
    }
    return seq.slice(1);
}

/** Florence-2's answer for a plain-text task: the special tokens dropped, spaces trimmed. */
function cleanText(text) {
    return String(text || "").replace(/<\/?s>|<pad>/g, "").replace(/\s+/g, " ").trim();
}

/** RGBA side x side -> NCHW float32 with ImageNet's mean and std (rescale 1/255, then normalize). */
function pixelValues(rgba, side = SIDE) {
    const plane = side * side;
    const x = new Float32Array(3 * plane);
    const { mean, std } = IMAGENET;
    for (let i = 0; i < plane; i++) {
        for (let c = 0; c < 3; c++) x[c * plane + i] = (rgba[4 * i + c] / 255 - mean[c]) / std[c];
    }
    return x;
}

class Florence2 {
    /**
     * @param {import("./runtime").Runtime} runtime
     * @param {{ vision: string, embed: string, encoder: string, decoder: string, tokenizer: string }} files
     */
    constructor(runtime, files) {
        this.runtime = runtime;
        this.files = files;
        this.tok = null;
    }

    tokenizer() {
        if (!this.tok) this.tok = new BartTokenizer(JSON.parse(fs.readFileSync(this.files.tokenizer, "utf8")));
        return this.tok;
    }

    /**
     * A caption of a 768 x 768 RGBA picture. `task` "caption" (a short line) or "detailed" (a few sentences); `check`
     * as `greedy`'s. -> { text, tokens, task, provider, ms: { vision, encoder, decoder }, steps }
     */
    async run(rgba, { task = "caption", maxTokens = null, check = null } = {}) {
        const t = TASKS[task];
        if (!t) throw new Error(`unknown task "${task}" (caption or detailed)`);
        const rt = this.runtime;
        const tok = this.tokenizer();
        // the decoder and the embedding are asked for again at every step: in the main-thread fallback a free releases
        // the sessions mid-run, and the next step loads them again (the cache's tensors are plain data)
        const [vis, , enc, dec] = await Promise.all([
            rt.session(this.files.vision), rt.session(this.files.embed), rt.session(this.files.encoder), rt.session(this.files.decoder),
        ]);
        if (check) await check();
        const t0 = Date.now();
        const feat = (await vis.session.run({ pixel_values: rt.tensor("float32", pixelValues(rgba), [1, 3, SIDE, SIDE]) })).image_features;
        const nImg = feat.dims[1];
        const t1 = Date.now();
        const ids = tok.encode(t.prompt);
        const embed = async (list) => (await (await rt.session(this.files.embed)).session.run({ input_ids: rt.tensor("int64", BigInt64Array.from(list.map((v) => BigInt(v))), [1, list.length]) })).inputs_embeds;
        const text = await embed(ids);
        const L = nImg + ids.length;
        const joined = new Float32Array(L * 768);
        joined.set(feat.data, 0);
        joined.set(text.data, nImg * 768);
        const mask = rt.tensor("int64", new BigInt64Array(L).fill(1n), [1, L]);
        const states = (await enc.session.run({ inputs_embeds: rt.tensor("float32", joined, [1, L, 768]), attention_mask: mask })).last_hidden_state;
        const t2 = Date.now();
        if (check) await check();
        // the cache: empty on the first step (use_cache_branch false), then the decoder's own and the encoder's from step one
        const empty = () => rt.tensor("float32", new Float32Array(0), [1, HEADS, 0, HEAD_DIM]);
        let past = {};
        for (let i = 0; i < LAYERS; i++) {
            for (const part of ["decoder", "encoder"]) for (const kv of ["key", "value"]) past[`past_key_values.${i}.${part}.${kv}`] = empty();
        }
        let steps = 0;
        const step = async (token, index) => {
            const out = await (await rt.session(this.files.decoder)).session.run({
                encoder_attention_mask: mask, encoder_hidden_states: states, inputs_embeds: await embed([token]),
                use_cache_branch: rt.tensor("bool", [index > 0], [1]), ...past,
            });
            const next = {};
            for (let i = 0; i < LAYERS; i++) {
                for (const kv of ["key", "value"]) {
                    next[`past_key_values.${i}.decoder.${kv}`] = out[`present.${i}.decoder.${kv}`];
                    next[`past_key_values.${i}.encoder.${kv}`] = index > 0 ? past[`past_key_values.${i}.encoder.${kv}`] : out[`present.${i}.encoder.${kv}`];
                }
            }
            past = next;
            steps++;
            const lg = out.logits;
            const V = lg.dims[lg.dims.length - 1];
            return lg.data.subarray(lg.data.length - V);
        };
        // the helpers' process reads its messages (a cancel) between the steps
        const yieldThen = async () => { await new Promise((r) => setImmediate(r)); if (check) await check(); };
        const tokens = await greedy(step, { maxTokens: maxTokens || t.maxTokens, check: yieldThen });
        const t3 = Date.now();
        return { text: cleanText(tok.decode(tokens)), tokens, task, provider: dec.provider, ms: { vision: t1 - t0, encoder: t2 - t1, decoder: t3 - t2 }, steps };
    }

    /** The four sessions' files (what the engine releases for a model). */
    sessionFiles() {
        return [this.files.vision, this.files.embed, this.files.encoder, this.files.decoder];
    }
}

module.exports = { Florence2, TASKS, SIDE, greedy, bannedAfter, argmax, cleanText, pixelValues };
