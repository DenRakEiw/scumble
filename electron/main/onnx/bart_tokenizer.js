// A byte-level BPE tokenizer read from a Hugging Face `tokenizer.json` (BART's, which Florence-2 uses; GPT-2 and
// RoBERTa have the same shape): the added tokens split out first, the GPT-2 pre-tokenizer regex, bytes mapped to the
// printable characters GPT-2 uses for them, the merges by rank, and RoBERTa's `<s> ... </s>` around the ids. Decoding
// drops the special tokens and maps the characters back to UTF-8 bytes. No dependency: Florence-2 needs only its two
// task prompts encoded and its captions decoded, so a package for it would be most of a megabyte for a few lines.
"use strict";

// GPT-2's pre-tokenizer pattern (`use_regex: true` of the ByteLevel pre-tokenizer)
const PRE = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

/** GPT-2's byte -> character table: printable bytes stand for themselves, the rest are shifted past 255. */
function byteTable() {
    const bs = [];
    for (let b = 33; b <= 126; b++) bs.push(b);
    for (let b = 161; b <= 172; b++) bs.push(b);
    for (let b = 174; b <= 255; b++) bs.push(b);
    const cs = bs.slice();
    let n = 0;
    for (let b = 0; b < 256; b++) {
        if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
    }
    const toChar = new Array(256), toByte = new Map();
    for (let i = 0; i < bs.length; i++) { const c = String.fromCodePoint(cs[i]); toChar[bs[i]] = c; toByte.set(c, bs[i]); }
    return { toChar, toByte };
}

const BYTES = byteTable();

class BartTokenizer {
    /**
     * @param {object} json the parsed tokenizer.json: `model` { type "BPE", vocab, merges }, `added_tokens`, and a
     *   `post_processor` of RoBERTa's kind (`cls`, `sep`) or none
     */
    constructor(json) {
        const m = json && json.model;
        if (!m || m.type !== "BPE" || !m.vocab || !Array.isArray(m.merges)) throw new Error("tokenizer.json: not a BPE tokenizer");
        this.vocab = new Map(Object.entries(m.vocab));
        this.byId = [];
        for (const [tok, id] of this.vocab) this.byId[id] = tok;
        this.ranks = new Map();
        m.merges.forEach((mg, i) => {
            const pair = Array.isArray(mg) ? mg : String(mg).split(" ");
            this.ranks.set(pair[0] + " " + pair[1], i);
        });
        this.added = new Map();     // content -> id
        this.special = new Set();   // ids dropped by decode(skipSpecial)
        for (const a of json.added_tokens || []) {
            this.added.set(a.content, a.id);
            this.byId[a.id] = a.content;
            if (a.special) this.special.add(a.id);
        }
        // the added tokens split the text first, longest first (`<loc_10>` before `<loc_1>` would never match, but a
        // token that is a prefix of another must lose to it)
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const contents = Array.from(this.added.keys()).sort((a, b) => b.length - a.length);
        this.addedRe = contents.length ? new RegExp("(" + contents.map(esc).join("|") + ")", "g") : null;
        const pp = json.post_processor || null;
        this.cls = pp && pp.cls ? pp.cls[1] : null;
        this.sep = pp && pp.sep ? pp.sep[1] : null;
        this.cache = new Map();
    }

    /** The BPE pieces of one pre-token (already in GPT-2's characters). */
    bpe(word) {
        const hit = this.cache.get(word);
        if (hit) return hit;
        let parts = Array.from(word);
        while (parts.length > 1) {
            let best = -1, rank = Infinity;
            for (let i = 0; i < parts.length - 1; i++) {
                const r = this.ranks.get(parts[i] + " " + parts[i + 1]);
                if (r !== undefined && r < rank) { rank = r; best = i; }
            }
            if (best < 0) break;
            const a = parts[best], b = parts[best + 1];
            const next = [];
            for (let i = 0; i < parts.length; i++) {
                if (i < parts.length - 1 && parts[i] === a && parts[i + 1] === b) { next.push(a + b); i++; }
                else next.push(parts[i]);
            }
            parts = next;
        }
        if (this.cache.size < 10000) this.cache.set(word, parts);
        return parts;
    }

    /** The ids of plain text (no added tokens in it). */
    encodePlain(text) {
        const out = [];
        for (const m of text.matchAll(PRE)) {
            const bytes = new TextEncoder().encode(m[0]);
            let word = "";
            for (const b of bytes) word += BYTES.toChar[b];
            for (const piece of this.bpe(word)) {
                const id = this.vocab.get(piece);
                if (id === undefined) throw new Error(`tokenizer: no id for "${piece}"`);
                out.push(id);
            }
        }
        return out;
    }

    /** Text -> ids, with `<s>` and `</s>` around them unless `special` is false. */
    encode(text, { special = true } = {}) {
        const s = String(text == null ? "" : text);
        const ids = [];
        if (this.addedRe) {
            let last = 0;
            for (const m of s.matchAll(this.addedRe)) {
                if (m.index > last) ids.push(...this.encodePlain(s.slice(last, m.index)));
                ids.push(this.added.get(m[0]));
                last = m.index + m[0].length;
            }
            if (last < s.length) ids.push(...this.encodePlain(s.slice(last)));
        } else ids.push(...this.encodePlain(s));
        if (special && this.cls != null && this.sep != null) return [this.cls, ...ids, this.sep];
        return ids;
    }

    /** Ids -> text; the special tokens left out unless `skipSpecial` is false. */
    decode(ids, { skipSpecial = true } = {}) {
        let text = "";
        let bytes = [];
        const flush = () => { if (bytes.length) { text += new TextDecoder("utf-8").decode(Uint8Array.from(bytes)); bytes = []; } };
        for (const raw of ids) {
            const id = Number(raw);
            if (skipSpecial && this.special.has(id)) continue;
            const tok = this.byId[id];
            if (tok === undefined) continue;
            if (this.added.has(tok) && this.added.get(tok) === id) { flush(); text += tok; continue; }
            for (const ch of tok) {
                const b = BYTES.toByte.get(ch);
                if (b === undefined) { flush(); text += ch; } else bytes.push(b);
            }
        }
        flush();
        return text;
    }
}

module.exports = { BartTokenizer, byteTable, PRE };
