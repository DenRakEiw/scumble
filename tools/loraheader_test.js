// The LoRA hint's header reader (item 50, docs/PLAN_LORAS.md LR3), in plain Node, no Electron and no network:
//   node tools/loraheader_test.js
// electron/main/loraheader.js is the API under test, on synthetic safetensors files this test writes into its own
// temp folder (removed at the end; never a file of the user's ComfyUI): a few modules per family with the shapes their
// base models give (FLUX.1 with 19 double and 38 single blocks at width 3072, FLUX.2 Klein 9B, Klein 4B, FLUX.2 dev,
// FLUX 3, Qwen Image Edit 2509 with anna_qwen's lying metadata, Qwen Image 2.1, MOSS-Image's edit LoRA, Z-Image), an
// SDXL file of 2,958 keys whose reduced answer stays under 64 KB, an ss_tag_frequency of about 1 MB reduced to five
// tags, the metadata's 16 KB cap, a header past the 16 MB cap refused, files that are no safetensors, the module cap,
// the server check (a loopback or the machine's own name, never a remote one), the path check (".." and absolute names
// refused) and headerFor end to end; the metadata reduction held to its twin in renderer/editor/loras.js (loraMeta,
// topTags), and each family file read through loras.js familyOf. tools/loras_test.py (the gate `loras`) runs this file.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const H = require(path.join(ROOT, "electron", "main", "loraheader.js"));

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => util.isDeepStrictEqual(a, b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };
async function section(name, fn) {
    console.log(`\n--- ${name} ---`);
    try { await fn(); } catch (err) { check(`${name}: ran through`, false, String(err && err.stack || err).split(/\r?\n/).slice(0, 3).join(" ")); }
}

// ---- writing synthetic safetensors files ------------------------------------------------------------------------------

/**
 * A safetensors file's bytes: the 8-byte length, the header (each tensor BF16 with its shape and data offsets, the
 * metadata), the tensors' bytes as zeros (a valid file a loader would read).
 * @param {[string, number[]][]} tensors
 * @param {Record<string, string> | null} [meta]
 */
function safetensors(tensors, meta = null) {
    const header = {};
    let at = 0;
    for (const [name, shape] of tensors) {
        const bytes = shape.reduce((a, b) => a * b, 1) * 2;
        header[name] = { dtype: "BF16", shape, data_offsets: [at, at + bytes] };
        at += bytes;
    }
    if (meta) header.__metadata__ = meta;
    let json = Buffer.from(JSON.stringify(header), "utf8");
    const pad = (8 - (json.length % 8)) % 8;   // the format pads the header with spaces to 8 bytes
    if (pad) json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(json.length));
    return Buffer.concat([len, json, Buffer.alloc(at)]);
}

/** A LoRA pair (rank 1) for a module of `out` x `inn` features, in a trainer's naming. */
function pair(mod, out, inn, style = "peft") {
    if (style === "kohya") return [[`${mod}.lora_down.weight`, [1, inn]], [`${mod}.lora_up.weight`, [out, 1]], [`${mod}.alpha`, [1]]];
    if (style === "default") return [[`${mod}.lora_A.default.weight`, [1, inn]], [`${mod}.lora_B.default.weight`, [out, 1]]];
    return [[`${mod}.lora_A.weight`, [1, inn]], [`${mod}.lora_B.weight`, [out, 1]]];
}

/** A FLUX.1 / FLUX.2 LoRA in ComfyUI's names (ai-toolkit's for FLUX.2; kohya's lora_unet_ names for FLUX.1). */
function fluxLora({ double, single, h, mlp, lin1, kohya = false, mod = false }) {
    const t = [];
    const name = (s) => (kohya ? "lora_unet_" + s.replace(/\./g, "_") : "diffusion_model." + s);
    for (let i = 0; i < double; i++) {
        for (const side of ["img", "txt"]) {
            t.push(...pair(name(`double_blocks.${i}.${side}_attn.proj`), h, h, kohya ? "kohya" : "peft"));
            t.push(...pair(name(`double_blocks.${i}.${side}_attn.qkv`), 3 * h, h, kohya ? "kohya" : "peft"));
            t.push(...pair(name(`double_blocks.${i}.${side}_mlp.0`), mlp * h, h, kohya ? "kohya" : "peft"));
            t.push(...pair(name(`double_blocks.${i}.${side}_mlp.2`), h, mlp * h, kohya ? "kohya" : "peft"));
            if (mod) t.push(...pair(name(`double_blocks.${i}.${side}_mod.lin`), 6 * h, h, kohya ? "kohya" : "peft"));
        }
    }
    for (let i = 0; i < single; i++) {
        t.push(...pair(name(`single_blocks.${i}.linear1`), lin1 * h, h, kohya ? "kohya" : "peft"));
        t.push(...pair(name(`single_blocks.${i}.linear2`), h, h * (lin1 - 3), kohya ? "kohya" : "peft"));
        if (mod) t.push(...pair(name(`single_blocks.${i}.modulation.lin`), 3 * h, h, kohya ? "kohya" : "peft"));
    }
    return t;
}

const FILES = {};
let TMP = "";
function write(rel, bytes) {
    const file = path.join(TMP, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
}

async function main() {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-loraheader-test-"));
    const L = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "loras.js")).href);
    // a ComfyUI models folder of the test's own: loras/ with family subfolders, diffusion_models/ (the Helpers check)
    const MODELS = path.join(TMP, "models");
    fs.mkdirSync(path.join(MODELS, "diffusion_models"), { recursive: true });
    const lora = (rel, tensors, meta) => { FILES[rel] = write(path.join("models", "loras", rel), safetensors(tensors, meta)); return FILES[rel]; };

    // the base models' shapes (read 2026-11-06 from the user's diffusion_models headers, docs/PLAN_LORAS.md "LR3 as built")
    lora("flux/flux1_full.safetensors", fluxLora({ double: 19, single: 38, h: 3072, mlp: 4, lin1: 7, kohya: true, mod: true }), { ss_base_model_version: "flux1", ss_tag_frequency: JSON.stringify({ d: { airbrush: 150, "a woman with long": 5 } }) });
    lora("klein/klein9b.safetensors", fluxLora({ double: 8, single: 24, h: 4096, mlp: 6, lin1: 9 }), { ss_base_model_version: "flux2_klein_9b", ss_tag_frequency: JSON.stringify({ d: { anna: 1 } }) });
    lora("klein/klein4b.safetensors", fluxLora({ double: 5, single: 20, h: 3072, mlp: 6, lin1: 9 }), { ss_base_model_version: "sd_1.5" });
    lora("flux_2/dev.safetensors", fluxLora({ double: 8, single: 48, h: 6144, mlp: 6, lin1: 9 }), { ss_base_model_version: "flux2" });
    // a FLUX.1 LoRA on four single blocks only (60Y911's shape: proj_out at width 3072): FLUX.1 or FLUX.2 Klein 4B
    lora("flux/few_blocks.safetensors", [5, 8, 9, 10].flatMap((i) => pair(`transformer.single_transformer_blocks.${i}.proj_out`, 3072, 12288)), { ss_base_model_version: "sd_1.5" });
    // FLUX 3 (Flux3_Targa's names: content_mode_blocks.image / image_cond, single_blocks of q_proj ... mlp_out)
    lora("Flux_3/flux3.safetensors", [
        ...[0, 1, 2, 3, 4].flatMap((i) => ["image", "image_cond"].flatMap((m) => ["q_proj", "k_proj", "v_proj", "attn_out"].flatMap((p) => pair(`diffusion_model.content_mode_blocks.${m}.${i}.${p}`, 3072, 3072)))),
        ...Array.from({ length: 28 }, (_, i) => i).flatMap((i) => pair(`diffusion_model.single_blocks.${i}.attn_out`, 3072, 3072)),
    ], { ss_base_model_version: "flux3", ss_tag_frequency: JSON.stringify({ "1_img": { Targa: 1 } }) });
    // Qwen Image Edit 2509 with anna_qwen's metadata (ai-toolkit wrote sd_1.5)
    lora("qwen/anna_qwen.safetensors", Array.from({ length: 60 }, (_, i) => i).flatMap((i) => [
        ...pair(`diffusion_model.transformer_blocks.${i}.attn.add_k_proj`, 3072, 3072), ...pair(`diffusion_model.transformer_blocks.${i}.attn.to_q`, 3072, 3072),
        ...pair(`diffusion_model.transformer_blocks.${i}.img_mod.1`, 18432, 3072), ...pair(`diffusion_model.transformer_blocks.${i}.img_mlp.net.0.proj`, 12288, 3072),
    ]), { ss_base_model_version: "sd_1.5", software: "{\"name\": \"ai-toolkit\"}", ss_tag_frequency: JSON.stringify({ d: { Anna: 1 } }) });
    // Qwen Image 2.1 (one stream, the gated MLP's halves; lightx2v's transformer. prefix)
    lora("qwen21/q21.safetensors", Array.from({ length: 32 }, (_, i) => i).flatMap((i) => [
        ...pair(`transformer.transformer_blocks.${i}.attn.to_q`, 4096, 4096), ...pair(`transformer.transformer_blocks.${i}.attn.to_out.0`, 4096, 4096),
        ...pair(`transformer.transformer_blocks.${i}.img_mlp.gate_layer`, 12288, 4096), ...pair(`transformer.transformer_blocks.${i}.img_mlp.proj`, 12288, 4096),
    ]), null);
    // Comfy-Org's Qwen Image 2.1 turbo LoRA (qwen_image_2.1_turbo_lora_avg_rank_178_bf16, read 2026-11-06 at LR9): kohya's
    // lora_down / lora_up under diffusion_model., the gated MLP's gate_up / out, and 1-D `.diff`s of the attention's
    // norm_q / norm_k at the head's 128 (a norm's scale, no out-features) and of txt_in.text_norm
    lora("qwen21/q21_turbo.safetensors", [
        ...pair("diffusion_model.img_in", 4096, 64, "kohya"), ["diffusion_model.txt_in.text_norm.diff", [4096]],
        ...Array.from({ length: 32 }, (_, i) => i).flatMap((i) => [
            ...pair(`diffusion_model.transformer_blocks.${i}.attn.to_q`, 4096, 4096, "kohya"), ...pair(`diffusion_model.transformer_blocks.${i}.attn.to_out.0`, 4096, 4096, "kohya"),
            ["diffusion_model.transformer_blocks." + i + ".attn.norm_q.diff", [128]], ["diffusion_model.transformer_blocks." + i + ".attn.norm_k.diff", [128]],
            ...pair(`diffusion_model.transformer_blocks.${i}.img_mlp.gate_up`, 24576, 4096, "kohya"), ...pair(`diffusion_model.transformer_blocks.${i}.img_mlp.out`, 4096, 12288, "kohya"),
        ]),
    ], null);
    // MOSS-Image's edit LoRA (bare layers.N.proj.q ..., 42 layers at 3072, format moss-edit-lora)
    lora("moss/moss_edit.safetensors", Array.from({ length: 42 }, (_, i) => i).flatMap((i) => ["q", "k", "v", "o"].flatMap((p) => pair(`layers.${i}.proj.${p}`, 3072, 3072))), { format: "moss-edit-lora" });
    // Z-Image (ai-toolkit: diffusion_model.layers.N.attention.to_k, 30 layers at 3840)
    lora("z_image/z.safetensors", Array.from({ length: 30 }, (_, i) => i).flatMap((i) => [...pair(`diffusion_model.layers.${i}.attention.to_k`, 3840, 3840), ...pair(`diffusion_model.layers.${i}.feed_forward.w1`, 10240, 3840)]), { ss_base_model_version: "zimage" });
    // SDXL of 2,958 keys (986 kohya modules, three tensors each): 72 + 192 text-encoder modules and 722 of the U-Net
    const sdxl = [];
    const te = (n, layers) => { for (let l = 0; l < layers; l++) for (const m of ["self_attn_q_proj", "self_attn_k_proj", "self_attn_v_proj", "self_attn_out_proj", "mlp_fc1", "mlp_fc2"]) sdxl.push(`lora_te${n}_text_model_encoder_layers_${l}_${m}`); };
    te(1, 12); te(2, 32);
    const unetMods = ["attn1_to_q", "attn1_to_k", "attn1_to_v", "attn1_to_out_0", "attn2_to_q", "attn2_to_k", "attn2_to_v", "attn2_to_out_0", "ff_net_0_proj", "ff_net_2"];
    outer: for (const where of ["input_blocks_4_1", "input_blocks_5_1", "input_blocks_7_1", "input_blocks_8_1", "middle_block_1", "output_blocks_0_1", "output_blocks_1_1", "output_blocks_2_1", "output_blocks_3_1", "output_blocks_4_1", "output_blocks_5_1"]) {
        for (let b = 0; b < 10; b++) for (const m of unetMods) { if (sdxl.length >= 986) break outer; sdxl.push(`lora_unet_${where}_transformer_blocks_${b}_${m}`); }
    }
    lora("sdxl/sdxl.safetensors", sdxl.flatMap((m) => pair(m, 640, 640, "kohya")), { ss_base_model_version: "sdxl_base_v1-0", ss_sd_model_name: "sd_xl_base_1.0.safetensors" });
    // an ss_tag_frequency of about 1 MB: 40,000 sentence fragments seen once or twice, a trigger seen 900 times, four
    // tags beside it, one of them 40 characters long (left out), one a fragment (below a quarter of the top)
    const big = { set_a: {}, set_b: {} };
    for (let i = 0; i < 40000; i++) big[i % 2 ? "set_a" : "set_b"][`a person standing near window ${i}`] = 1 + (i % 2);
    Object.assign(big.set_a, { trig0r: 500, "red coat": 300, ["x".repeat(40)]: 900, "city street": 250, night: 230, "a person standing near window 7": 1 });
    Object.assign(big.set_b, { trig0r: 400, "red coat": 100, umbrella: 260 });
    const bigFreq = JSON.stringify(big);
    lora("tags/big_tags.safetensors", pair("diffusion_model.double_blocks.0.img_attn.proj", 3072, 3072), { ss_tag_frequency: bigFreq, "modelspec.trigger_phrase": "trig0r, glowing" });

    await section("1. parseHeader and readHeader: a header from a buffer or a path, the cap, files that are no safetensors", async () => {
        const ok = safetensors(pair("diffusion_model.double_blocks.0.img_attn.proj", 3072, 3072), { a: "b" });
        const p = H.parseHeader(ok);
        check("parseHeader of a file's bytes: the header object with its tensors and metadata", p.raw && p.reason === null && p.raw.__metadata__.a === "b" && eq(p.raw["diffusion_model.double_blocks.0.img_attn.proj.lora_B.weight"].shape, [3072, 1]));
        check("parseHeader of the header's bytes alone (8 + n): enough", !!H.parseHeader(ok.subarray(0, 8 + Number(ok.readBigUInt64LE(0)))).raw);
        const len = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
        const bad = [
            ["shorter than 8 bytes", Buffer.from([1, 2, 3])],
            ["a length of 0", len(0)],
            ["a length past the bytes", Buffer.concat([len(500), Buffer.from("{}")])],
            ["no JSON object (an array)", Buffer.concat([len(2), Buffer.from("[]")])],
            ["no JSON", Buffer.concat([len(5), Buffer.from("{oops")])],
            ["text", Buffer.from("this is a text file, not a LoRA at all")],
        ];
        for (const [what, b] of bad) { const r = H.parseHeader(b); check(`parseHeader refuses ${what}`, r.raw === null && typeof r.reason === "string", r.reason); }
        const capped = H.parseHeader(Buffer.concat([len(H.MAX_HEADER + 1), Buffer.from("{}")]));
        check("a header longer than 16 MB is refused by its length alone", capped.raw === null && /past the cap of 16777216/.test(capped.reason), capped.reason);
        const fromFile = await H.readHeader(FILES["klein/klein9b.safetensors"]);
        check("readHeader reads a file's header", fromFile.raw && fromFile.raw.__metadata__.ss_base_model_version === "flux2_klein_9b");
        // a file of 17 MB whose header claims 16 MB + 1 (the file could hold it): refused by the cap, the header unread
        const capFile = write("odd/capped.safetensors", Buffer.concat([len(H.MAX_HEADER + 1), Buffer.from("{"), Buffer.alloc(H.MAX_HEADER + 64 * 1024, 0x20)]));
        const rc = await H.readHeader(capFile);
        check("readHeader refuses a header past the cap without reading it", rc.raw === null && /past the cap/.test(rc.reason), rc.reason);
        const shortFile = write("odd/short.safetensors", Buffer.concat([len(H.MAX_HEADER + 1), Buffer.from("{}")]));
        check("readHeader: a length the file cannot hold is no safetensors file", /not a safetensors file/.test((await H.readHeader(shortFile)).reason || ""));
        const txt = write("odd/notes.safetensors", Buffer.from("not a safetensors file, just text that goes on for a while"));
        const rt = await H.readHeader(txt);
        check("readHeader: a text file under a .safetensors name is no header", rt.raw === null && /not a safetensors file/.test(rt.reason), rt.reason);
        const empty = write("odd/empty.safetensors", Buffer.alloc(0));
        check("readHeader: an empty file is no header", (await H.readHeader(empty)).raw === null);
        check("readHeader: a missing file answers null with its code", (await H.readHeader(path.join(TMP, "nope.safetensors"))).reason === "ENOENT");
    });

    await section("2. reduceHeader: modules with N, blocks, widths, metadata; the per-family files", async () => {
        const red = async (rel) => H.reduceHeader((await H.readHeader(FILES[rel])).raw);
        const f1 = await red("flux/flux1_full.safetensors");
        check("FLUX.1 (kohya): 19 double and 38 single blocks, width 3072 on both", f1.blocks.double_blocks.length === 19 && f1.blocks.double_blocks[18] === 18 && f1.blocks.single_blocks.length === 38 && f1.width.double_blocks === 3072 && f1.width.single_blocks === 3072, short({ b: Object.fromEntries(Object.entries(f1.blocks).map(([k, v]) => [k, v.length])), w: f1.width }));
        check("... its module paths carry N for every index and no adapter suffix", f1.modules.includes("lora_unet_double_blocks_N_img_attn_proj") && f1.modules.includes("lora_unet_single_blocks_N_linear1") && !f1.modules.some((m) => /[._]\d+(?=[._]|$)|lora_up|lora_down|alpha/.test(m)), short(f1.modules));
        check("... the out-features per prefix: FLUX.1's h, 3h, 4h, 6h (double) and h, 3h, 7h (single)", eq(f1.outs.double_blocks, [3072, 9216, 12288, 18432]) && eq(f1.outs.single_blocks, [3072, 9216, 21504]), short(f1.outs));
        check("... keyCount counts the tensors", f1.keyCount === (19 * 2 * 5 + 38 * 3) * 3, String(f1.keyCount));
        const k9 = await red("klein/klein9b.safetensors"), k4 = await red("klein/klein4b.safetensors"), dev = await red("flux_2/dev.safetensors");
        check("FLUX.2 Klein 9B: 8 / 24 blocks at 4096; Klein 4B: 5 / 20 at 3072; FLUX.2 dev: 8 / 48 at 6144",
            k9.blocks.double_blocks.length === 8 && k9.blocks.single_blocks.length === 24 && k9.width.double_blocks === 4096 && k9.width.single_blocks === 4096
            && k4.blocks.double_blocks.length === 5 && k4.blocks.single_blocks.length === 20 && k4.width.single_blocks === 3072
            && dev.blocks.single_blocks.length === 48 && dev.width.double_blocks === 6144, short([k9.width, k4.width, dev.width]));
        const f3 = await red("Flux_3/flux3.safetensors");
        check("FLUX 3: content_mode_blocks (image and image_cond) 5 blocks, single_blocks 28", eq(f3.blocks.content_mode_blocks, [0, 1, 2, 3, 4]) && f3.blocks.single_blocks.length === 28 && f3.modules.includes("diffusion_model.content_mode_blocks.image_cond.N.q_proj"), short(f3.blocks));
        const q = await red("qwen/anna_qwen.safetensors");
        check("Qwen Image Edit 2509: 60 transformer blocks at 3072, the metadata as written (sd_1.5)", q.blocks.transformer_blocks.length === 60 && q.width.transformer_blocks === 3072 && q.metadata.ss_base_model_version === "sd_1.5" && eq(q.metadata.tags, ["Anna"]), short({ w: q.width, m: q.metadata }));
        const q21 = await red("qwen21/q21.safetensors");
        check("Qwen Image 2.1: 32 transformer blocks at 4096, no metadata", q21.blocks.transformer_blocks.length === 32 && q21.width.transformer_blocks === 4096 && eq(q21.metadata, {}));
        const q21t = await red("qwen21/q21_turbo.safetensors");
        check("Comfy-Org's Qwen Image 2.1 turbo LoRA: the 1-D norm_q / norm_k diffs (128) are no out-features, so the width is 4096 (LR9)",
            q21t.blocks.transformer_blocks.length === 32 && q21t.width.transformer_blocks === 4096 && eq(q21t.outs.transformer_blocks, [4096, 24576]) && q21t.modules.includes("diffusion_model.transformer_blocks.N.attn.norm_k"), short({ w: q21t.width, o: q21t.outs }));
        const moss = await red("moss/moss_edit.safetensors"), z = await red("z_image/z.safetensors");
        check("MOSS-Image's edit LoRA: 42 layers at 3072 (bare names); Z-Image: 30 layers at 3840", moss.blocks.layers.length === 42 && moss.width.layers === 3072 && moss.modules.includes("layers.N.proj.q") && z.blocks.layers.length === 30 && z.width.layers === 3840, short([moss.modules, z.width]));
        const sd = await red("sdxl/sdxl.safetensors");
        const size = JSON.stringify(sd).length;
        check("SDXL of 2,958 keys: reduced to a few KB (under 64 KB), the text encoders counted for modules alone", sd.keyCount === 2958 && size < 64 * 1024 && sd.modules.some((m) => m.startsWith("lora_te1_")) && sd.modules.some((m) => m.startsWith("lora_te2_")) && !("layers" in sd.blocks), `${sd.keyCount} keys, ${sd.modules.length} modules, ${size} bytes`);
        check("... the raw header is far bigger than the answer", (await H.readHeader(FILES["sdxl/sdxl.safetensors"])).raw && JSON.stringify((await H.readHeader(FILES["sdxl/sdxl.safetensors"])).raw).length > 10 * size);
        // the module cap: 3,000 distinct paths without an index
        const many = {};
        for (let i = 0; i < 3000; i++) many[`diffusion_model.extra_${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}${String.fromCharCode(97 + Math.floor(i / 676))}.lora_B.weight`] = { dtype: "BF16", shape: [8, 1], data_offsets: [0, 0] };
        const cut = H.reduceHeader(many);
        check("at most 2,000 module paths", cut.modules.length === 2000 && cut.keyCount === 3000, `${cut.modules.length} of ${cut.keyCount}`);
        check("reduceHeader of nothing: an empty answer", eq(H.reduceHeader({}), { keyCount: 0, modules: [], blocks: {}, width: {}, outs: {}, metadata: {} }));
    });

    await section("3. the metadata: the kept fields, the five tags, the 16 KB cap; the renderer's twin gives the same", async () => {
        const raw = (await H.readHeader(FILES["tags/big_tags.safetensors"])).raw;
        check("the test's ss_tag_frequency is about 1 MB", bigFreq.length > 1000000 && raw.__metadata__.ss_tag_frequency.length === bigFreq.length, `${bigFreq.length} bytes`);
        const m = H.reduceMetadata(raw.__metadata__);
        check("five tags from 1 MB: the most frequent (counts summed over the datasets), each shorter than 40, at least a quarter of the top's count",
            eq(m.tags, ["trig0r", "red coat", "umbrella", "city street", "night"]), short(m.tags));
        check("... the trigger phrase kept, the answer small", m["modelspec.trigger_phrase"] === "trig0r, glowing" && JSON.stringify(m).length < 300, JSON.stringify(m));
        check("topTags: a sentence caption's fragments seen a few times are no tags", eq(H.topTags(JSON.stringify({ d: { airbrush: 150, "a woman with long": 5, "to style their long": 3 } })), ["airbrush"]));
        check("topTags: equal counts all kept (ai-toolkit's one-word captions), a tie by name", eq(H.topTags(JSON.stringify({ d: { b: 1, a: 1, c: 1 } })), ["a", "b", "c"]));
        check("topTags of junk: []", eq(H.topTags("{no"), []) && eq(H.topTags(null), []) && eq(H.topTags(JSON.stringify({ d: { "  ": 3, x: "lots" } })), []));
        const huge = { ss_base_model_version: "b".repeat(9000), ss_sd_model_name: "n".repeat(9000), "modelspec.title": "t".repeat(9000), "modelspec.architecture": "a".repeat(9000), "modelspec.trigger_phrase": "w".repeat(9000), other: "z".repeat(50000) };
        const capped = H.reduceMetadata(huge);
        check("the metadata part at most 16 KB: each field at most 4,000 first, then the longest halved; other keys left out",
            JSON.stringify(capped).length <= H.MAX_METADATA && !("other" in capped) && Object.keys(capped).length === 5, `${JSON.stringify(capped).length} bytes`);
        check("reduceMetadata keeps strings only, trimmed", eq(H.reduceMetadata({ ss_base_model_version: "  flux1 ", ss_sd_model_name: 7, "modelspec.title": "" }), { ss_base_model_version: "flux1" }));
        // the twin in renderer/editor/loras.js answers ComfyUI's /view_metadata the same way
        const cases = [raw.__metadata__, huge, { ss_base_model_version: "sd_1.5", ss_tag_frequency: JSON.stringify({ d: { Anna: 1 } }) }, {}, null, { ss_tag_frequency: "{bad" }];
        check("loras.js loraMeta = loraheader.js reduceMetadata on every case", cases.every((c) => eq(L.loraMeta(c), H.reduceMetadata(c))));
        const tagCases = [bigFreq, JSON.stringify({ d: { airbrush: 150, "a woman with long": 5 } }), JSON.stringify({ d: { b: 1, a: 1 } }), "{no", null];
        check("loras.js topTags = loraheader.js topTags", tagCases.every((c) => eq(L.topTags(c), H.topTags(c))));
    });

    await section("4. the server check and the path check", async () => {
        const local = (u, h = "MYBOX") => H.localServer(u, h);
        check("loopback addresses are this machine", local("http://127.0.0.1:8188") && local("http://localhost:8188/") && local("http://[::1]:8188") && local("http://127.4.5.6:9000") && local("https://LOCALHOST"));
        check("the machine's own name, any case", local("http://mybox:8188") && local("http://MyBox:8188/comfy") && !local("http://mybox2:8188") && !H.localServer("http://mybox:8188", ""));
        check("a remote server never is (a LAN box, RunPod's proxy, a bad URL)", !local("http://192.168.1.20:8188") && !local("https://abc123-8188.proxy.runpod.net") && !local("not a url") && !local("") && !local(null) && !local("http://10.0.0.1"));
        const dir = MODELS, root = path.join(MODELS, "loras");
        check("loraPath: a server name with either separator under <dir>/loras", H.loraPath(dir, "klein\\klein9b.safetensors") === path.join(root, "klein", "klein9b.safetensors") && H.loraPath(dir, "klein/klein9b.safetensors") === path.join(root, "klein", "klein9b.safetensors"));
        const refused = ["../x.safetensors", "klein\\..\\..\\x.safetensors", "klein/./x.safetensors", "C:\\x.safetensors", "c:x.safetensors", "/etc/x.safetensors", "\\\\server\\share\\x.safetensors", "x.ckpt", "x.safetensors\0.png", "", "   ", null];
        const out = refused.map((n) => H.loraPath(dir, n));
        check("loraPath refuses '..', '.', absolute names, drives, shares, another extension, a NUL, an empty name", out.every((x) => x === null), short(out));
        check("loraPath: a doubled separator is one", H.loraPath(dir, "klein//klein9b.safetensors") === path.join(root, "klein", "klein9b.safetensors"));
        check("loraPath without a folder: null", H.loraPath("", "x.safetensors") === null && H.loraPath(null, "x.safetensors") === null);
        check("comfyModelsDir: loras/ and diffusion_models/ (or checkpoints/)", H.comfyModelsDir(MODELS) && !H.comfyModelsDir(path.join(MODELS, "loras")) && !H.comfyModelsDir(path.join(TMP, "nothing")));
    });

    await section("5. headerFor end to end: the local server reads, a remote one never; each family through loras.js familyOf", async () => {
        const q = (name, url = "http://127.0.0.1:8188", dir = MODELS) => H.headerFor({ url, hostname: "MYBOX", dir, name });
        const a = await q("klein\\klein9b.safetensors");
        check("a loopback server: the reduced header of <dir>/loras/<name>", a.header && a.reason === null && a.header.blocks.double_blocks.length === 8 && a.header.metadata.ss_base_model_version === "flux2_klein_9b");
        const own = await q("klein\\klein9b.safetensors", "http://mybox:8188");
        check("the machine's own name: read too", !!own.header);
        const remote = await q("klein\\klein9b.safetensors", "https://abc123-8188.proxy.runpod.net");
        check("a remote server: no header (a local file of that name would speak for another file)", remote.header === null && /not this machine/.test(remote.reason), remote.reason);
        const notComfy = await q("klein\\klein9b.safetensors", undefined, path.join(MODELS, "loras"));
        check("Settings > Helpers at no ComfyUI models folder: no header", notComfy.header === null && /no ComfyUI models folder/.test(notComfy.reason), notComfy.reason);
        check("a name that is refused, a missing file, a file that is no safetensors: no header",
            (await q("..\\..\\x.safetensors")).header === null && (await q("klein\\gone.safetensors")).header === null && (await q("odd\\notes.safetensors")).header === null);
        const want = {
            "flux/flux1_full.safetensors": ["looks like FLUX.1", "flux1"],
            "klein/klein9b.safetensors": ["looks like FLUX.2 Klein 9B", "flux2_klein_9b"],
            "klein/klein4b.safetensors": ["looks like FLUX.2 Klein 4B", "flux2_klein_4b"],
            "flux_2/dev.safetensors": ["looks like FLUX.2 dev", "flux2_dev"],
            "flux/few_blocks.safetensors": ["looks like FLUX.1 or FLUX.2 Klein 4B", null],
            "Flux_3/flux3.safetensors": ["looks like FLUX 3", "flux3"],
            "qwen/anna_qwen.safetensors": ["looks like Qwen Image (Edit 2509 / 2511)", "qwen_image"],
            "qwen21/q21.safetensors": ["looks like Qwen Image 2.1", "qwen_image_2_1"],
            "qwen21/q21_turbo.safetensors": ["looks like Qwen Image 2.1", "qwen_image_2_1"],
            "moss/moss_edit.safetensors": ["looks like MOSS-Image", "moss_image"],
            "z_image/z.safetensors": ["looks like Z-Image", "z_image"],
            "sdxl/sdxl.safetensors": ["looks like SDXL", "sdxl"],
        };
        const got = {};
        for (const rel of Object.keys(want)) {
            const r = await q(rel.replace("/", "\\"));
            const fam = L.familyOf(r.header, L.loraFolder(rel));
            got[rel] = fam && [fam.label, fam.family];
        }
        const wrong = Object.keys(want).filter((k) => !eq(got[k], want[k]));
        check("each family file reads as its family by its tensor names (anna_qwen's sd_1.5 metadata loses)", !wrong.length, short(wrong.map((k) => `${k}: ${JSON.stringify(got[k])}`)));
        const rr = await q("Flux_3\\flux3.safetensors");
        check("... and FLUX 3's chips are its caption tag", eq(L.loraTriggers(rr.header), ["Targa"]));
        const tags = await q("tags\\big_tags.safetensors");
        check("the 1 MB tag file: the trigger phrase's words first, then the tags, five at most", eq(L.loraTriggers(tags.header), ["trig0r", "glowing", "red coat", "umbrella", "city street"]), short(L.loraTriggers(tags.header)));
        // a remote server: the hint comes from the server's /view_metadata (metadata only) and the folder
        const viaServer = L.familyOf({ metadata: L.loraMeta({ ss_base_model_version: "sd_1.5" }) }, "qwen");
        check("a remote server's anna_qwen: metadata alone says SD 1.5 (grey, never amber)", viaServer.label === "metadata says SD 1.5" && viaServer.from === "metadata" && L.loraHint(viaServer, "qwen_image_2_1").kind === "hint");
    });

    fs.rmSync(TMP, { recursive: true, force: true });
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    try { if (TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* gone */ }
    console.log("[FAIL] " + ((err && err.stack) || err));
    console.log("FAIL");
    process.exit(1);
});
