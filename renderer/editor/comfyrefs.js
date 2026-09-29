// @ts-check
// @img tokens on a local ComfyUI recipe (item 26 step 26e, docs/PLAN_REFS.md): which picture of the canvas node's
// crop_image batch each encoder input of the graph reads, what the model calls picture n, and which of those inputs a
// run leaves out. The batch is the node's (nodes.py `InpaintCanvas.run`): the crop, then the Original copy of the crop
// (a selection, a fill other than none, "Original" on, and no refine pass in local mode), then the reference layers of
// canvas_state in order. A token's picture is numbered the way the encoder numbers its inputs, which for the shipped
// graphs is the batch order: n = 1 + Original + k for reference k (0-based).
//
// App-only: host.js imports it; it is not in tools/build_node.py FILES (the node resolves no token). Pure, no DOM. The
// marker resolver is the twin of electron/main/providers/refs.js `resolveMarkers`; tools/refs_cases.json holds the
// vectors both are tested against (tools/comfyrefs_test.js).

export const REF_NAME_DEFAULT = "image {n}";

const MARKER = /\{@ref:(\d+)\}/g;

/** A `refs.name` pattern: 1-40 characters, `{n}` (1-based) or `{n0}` (0-based) at least once, no `@` or stray brace. */
export function validRefName(s) {
    return typeof s === "string" && s.length > 0 && s.length <= 40 && /\{n0?\}/.test(s) && /^(?:[^@{}]|\{n0?\})*$/.test(s);
}

/** The name of picture n (1-based) under a pattern; an invalid pattern gives the default's. */
export function refName(pattern, n) {
    return (validRefName(pattern) ? pattern : REF_NAME_DEFAULT).replace(/\{n0\}/g, String(n - 1)).replace(/\{n\}/g, String(n));
}

/** @param {any} v */
const isLink = (v) => Array.isArray(v) && v.length === 2 && (typeof v[0] === "string" || typeof v[0] === "number") && Number.isInteger(v[1]);

/**
 * The encoder classes whose picture inputs a token can name, the wording their model reads, and each input's place
 * among the pictures the class numbers (1-based). TextEncodeQwenImage21 numbers its present `images.image_k` by rank
 * (its tokenizer writes `<image1>`, `<image2>` ...), TextEncodeQwenImageEditPlus by input ("Picture 1" .. "Picture 3",
 * whether or not the ones before are present), a ReferenceLatent chain by its place in the chain (FLUX.2's "image 1").
 * @type {Record<string, { name: string, inputs: (node: any, prompt: any) => [string, number][] }>}
 */
const ENCODERS = {
    TextEncodeQwenImage21: {
        name: "<image{n}>",
        inputs: (node) => {
            const keys = Object.keys(node.inputs || {}).filter((k) => /^images\.image_\d+$/.test(k) && isLink(node.inputs[k]));
            keys.sort((a, b) => +a.slice(13) - +b.slice(13));
            return keys.map((k, i) => [k, i + 1]);
        },
    },
    TextEncodeQwenImageEditPlus: {
        name: "Picture {n}",
        inputs: (node) => ["image1", "image2", "image3"].filter((k) => isLink((node.inputs || {})[k])).map((k) => [k, +k.slice(5)]),
    },
    ReferenceLatent: {
        name: "image {n}",
        inputs: (node, prompt) => {
            if (!isLink((node.inputs || {}).latent)) return [];
            // the place in the chain: how many ReferenceLatent nodes feed this one's conditioning
            let place = 0, cur = node.inputs.conditioning;
            while (place < 64 && isLink(cur) && prompt[String(cur[0])] && prompt[String(cur[0])].class_type === "ReferenceLatent") {
                place += 1;
                cur = (prompt[String(cur[0])].inputs || {}).conditioning;
            }
            return [["latent", place + 1]];
        },
    },
};

/**
 * The batch index an input's source comes from: traced back through the single linked `pixels` / `image` / `samples`
 * input of each node (a scale, a VAE encode) to an `ImageFromBatch` of the canvas node's crop_image (output 0) with a
 * literal `batch_index` >= 0 and `length` 1. Null when the trace ends anywhere else, or after 8 steps.
 * @param {Record<string, any>} prompt
 * @param {string} canvasId
 * @param {any} link
 * @returns {number | null}
 */
export function batchOf(prompt, canvasId, link, depth = 0) {
    if (!isLink(link) || depth > 8) return null;
    const node = prompt[String(link[0])];
    if (!node) return null;
    const inputs = node.inputs || {};
    if (node.class_type === "ImageFromBatch") {
        const src = inputs.image;
        const ok = isLink(src) && String(src[0]) === String(canvasId) && src[1] === 0 && inputs.length === 1 && Number.isInteger(inputs.batch_index) && inputs.batch_index >= 0;
        return ok ? inputs.batch_index : null;
    }
    const linked = ["pixels", "image", "samples"].filter((k) => isLink(inputs[k]));
    return linked.length === 1 ? batchOf(prompt, canvasId, inputs[linked[0]], depth + 1) : null;
}

/**
 * Every encoder input a token's picture can reach: `{ node, input, cls, batch, num }`, `batch` the crop_image index it
 * reads (null: not traced), `num` its place among the pictures its class numbers.
 * @param {Record<string, any>} prompt
 * @param {string} canvasId
 */
export function comfySlots(prompt, canvasId) {
    const out = [];
    for (const [id, node] of Object.entries(prompt || {})) {
        const enc = node && ENCODERS[node.class_type];
        if (!enc) continue;
        for (const [input, num] of enc.inputs(node, prompt)) out.push({ node: id, input, cls: node.class_type, batch: batchOf(prompt, canvasId, node.inputs[input]), num });
    }
    return out;
}

/** Whether a node other than a one-picture ImageFromBatch reads the whole crop_image batch (an API node, a preview). */
function readsWholeBatch(prompt, canvasId) {
    for (const node of Object.values(prompt || {})) {
        const inputs = (node && node.inputs) || {};
        for (const v of Object.values(inputs)) {
            if (!isLink(v) || String(v[0]) !== String(canvasId) || v[1] !== 0) continue;
            if (node.class_type !== "ImageFromBatch" || inputs.length !== 1) return true;
        }
    }
    return false;
}

/**
 * The batch index of every one-picture ImageFromBatch of the crop batch, read by an encoder or not (null: not a literal
 * index >= 0). A picker the trace does not reach (a CLIP vision, style or IPAdapter input) still reads a picture.
 */
function pickedBatches(prompt, canvasId) {
    const out = [];
    for (const node of Object.values(prompt || {})) {
        if (!node || node.class_type !== "ImageFromBatch") continue;
        const inputs = node.inputs || {}, src = inputs.image;
        if (!isLink(src) || String(src[0]) !== String(canvasId) || src[1] !== 0) continue;
        out.push(Number.isInteger(inputs.batch_index) && inputs.batch_index >= 0 ? inputs.batch_index : null);
    }
    return out;
}

/**
 * What a ComfyUI recipe calls its pictures and how many it reads: `{ name, slots, guess, trim }`.
 * - The trace is an *identity* when the batch indices its encoder inputs read are exactly 0 .. k-1, one encoder class
 *   reads them all, each input's number is its batch index + 1, no other node takes the whole batch, and no picker
 *   outside the encoders reads an index past k - 1 (else a reference that node reads would be cut off).
 * - `name`: the recipe's `refs.name` when valid, else the class's wording when an identity, else "image {n}".
 * - `slots` (pictures, the crop included): an identity's k (a declared value only lowers it), else the declared
 *   value, else null (no limit known).
 * - `guess`: the name came from neither a declaration nor an identity trace.
 * - `trim`: the inputs a run may leave out when it has fewer pictures ([{ node, input, batch }]), only for an identity.
 * @param {any} recipe
 * @returns {{ name: string, slots: number | null, guess: boolean, trim: { node: string, input: string, batch: number }[] | null }}
 */
export function comfyRefSpec(recipe) {
    const prompt = (recipe && recipe.prompt) || {}, canvasId = String((recipe && recipe.canvas) || "");
    const slots = comfySlots(prompt, canvasId);
    const classes = new Set(slots.map((s) => s.cls));
    const batches = new Set(slots.map((s) => s.batch));
    const k = batches.size;
    const identity = slots.length > 0 && classes.size === 1 && !readsWholeBatch(prompt, canvasId)
        && slots.every((s) => s.batch != null && s.batch === s.num - 1)
        && [...batches].every((b) => b != null && b < k)
        && pickedBatches(prompt, canvasId).every((b) => b != null && b < k);
    const refs = recipe && recipe.refs && typeof recipe.refs === "object" ? recipe.refs : null;
    const declaredName = refs && validRefName(refs.name) ? refs.name : null;
    const declaredSlots = refs && Number.isInteger(refs.slots) && refs.slots >= 1 && refs.slots <= 16 ? refs.slots : null;
    const cls = identity ? [...classes][0] : null;
    return {
        name: declaredName || (cls ? ENCODERS[cls].name : REF_NAME_DEFAULT),
        slots: identity ? (declaredSlots != null ? Math.min(declaredSlots, k) : k) : declaredSlots,
        guess: !declaredName && !identity,
        trim: identity ? slots.map((s) => ({ node: s.node, input: s.input, batch: /** @type {number} */ (s.batch) })) : null,
    };
}

/**
 * The pictures a local run sends, as the node batches them (C3's layout shape): the crop (n 1), the Original (ref 0,
 * n 2) when it goes, then reference k (ref original + k, n 2 + original + k) for the first `kept` of `count`. A
 * picture's `field` is the "node.input" that reads it, else "crop_image[b]". `drops`: how many references the
 * recipe's slots leave out (a number, 0 when none; the host words the note); `original` 0 or 1, `kept` the
 * references that go. The Original is listed whenever the node batches it, even past a one-slot recipe's slots.
 * @param {{ name: string, slots: number | null, guess: boolean, trim: any[] | null }} spec
 * @param {{ hasSelection: boolean, fill: string, withOriginal: boolean, refine: boolean, count: number }} run
 */
export function comfyLayout(spec, { hasSelection, fill, withOriginal, refine, count }) {
    const original = hasSelection && fill && fill !== "none" && withOriginal && !refine ? 1 : 0;
    const room = spec.slots == null ? Infinity : Math.max(0, spec.slots - 1 - original);
    const kept = Math.max(0, Math.min(count, room));
    const fieldOf = (b) => {
        const s = (spec.trim || []).find((t) => t.batch === b);
        return s ? `${s.node}.${s.input}` : `crop_image[${b}]`;
    };
    const pictures = [{ role: "crop", field: fieldOf(0), n: 1 }];
    if (original) pictures.push({ role: "original", ref: 0, field: fieldOf(1), n: 2 });
    for (let k = 0; k < kept; k++) pictures.push({ role: "reference", ref: original + k, field: fieldOf(1 + original + k), n: 2 + original + k });
    const dropped = Math.max(0, count - kept);
    return { pictures, max: spec.slots, drops: dropped, style: false, guess: spec.guess, original, kept };
}

/**
 * Leave out the encoder inputs whose picture is not in a batch of `length`: a ReferenceLatent without its latent passes
 * the conditioning on, an absent Qwen image is not numbered. Never the crop's (batch 0). The nodes that fed them are
 * then read by nothing and do not run (the canvas node expands only what its result source reaches). Returns the
 * inputs removed as "node.input".
 * @param {Record<string, any>} prompt  the recipe's prompt as it is queued (a copy)
 * @param {{ trim: { node: string, input: string, batch: number }[] | null }} spec
 * @param {number} length
 */
export function trimSlots(prompt, spec, length) {
    const removed = [];
    for (const t of spec.trim || []) {
        if (t.batch < 1 || t.batch < length) continue;
        const node = prompt[t.node];
        if (!node || !node.inputs || !(t.input in node.inputs)) continue;
        delete node.inputs[t.input];
        removed.push(`${t.node}.${t.input}`);
    }
    return removed;
}

/**
 * Markers to names, as main's resolver does it: each `{@ref:i}` whose picture is numbered becomes
 * `refName(pattern, n)`. `left` lists the markers kept as they were ({ ref, why: "absent" | "unnumbered" }, once
 * each), `refs` the resolved ones ({ ref, name }, once each, in the order they first appear).
 * @param {string} text
 * @param {{ role: string, ref?: number, n: number | null }[]} pictures
 * @param {string} pattern
 */
export function resolveMarkers(text, pictures, pattern) {
    const byRef = new Map();
    for (const p of pictures || []) if (p.ref != null && (p.role === "original" || p.role === "reference")) byRef.set(p.ref, p);
    const left = [], refs = [], seenLeft = new Set(), seenRef = new Set();
    const out = String(text == null ? "" : text).replace(MARKER, (m, d) => {
        const i = +d, p = byRef.get(i);
        if (!p || p.n == null) {
            if (!seenLeft.has(i)) { seenLeft.add(i); left.push({ ref: i, why: p ? "unnumbered" : "absent" }); }
            return m;
        }
        const name = refName(pattern, p.n);
        if (!seenRef.has(i)) { seenRef.add(i); refs.push({ ref: i, name }); }
        return name;
    });
    return { text: out, left, refs };
}
