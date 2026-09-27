// What the PNG export leaves out of the recipe it embeds (renderer/editor/redact.js), in plain Node, no Electron:
//   node tools/secret_names_test.js
// The user decided on 2026-09-27 ("ja, weglassen") that inputs named like a key, a token, a secret or a password do
// not go into an exported PNG. Covered: the name matcher on names that are secrets (snake, kebab, camel and upper case,
// digits, run-together spellings) and on ordinary widgets that come close (keyframe, keep_*, monkey, key_color,
// max_tokens, token_normalization, author); the filter over a hand-built API-format prompt (a key widget, a nested
// object widget, a key wired from a PrimitiveString through a concatenation, the recipe itself untouched, anything that
// is not a prompt as it was). The app side (the PNG's tEXt chunk) is tools/metadata_test.py
// `an_imported_key_stays_out_of_the_png`.
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const EDITOR = path.join(__dirname, "..", "renderer", "editor");
const editorModule = (rel) => import(pathToFileURL(path.join(EDITOR, rel)).href);

let failures = 0;
function check(what, ok, detail) {
    if (!ok) failures++;
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}

const SECRET = [
    "api_key", "apikey", "API_KEY", "apiKey", "APIKey", "x-api-key", "openai_api_key", "GEMINI_API_KEY", "myAPIKey",
    "key", "keys", "fal_key", "FAL_KEY", "replicateKey", "private_key", "secret_key", "access-key", "api_key_2", "key2",
    "token", "hf_token", "HF_TOKEN", "auth_token", "accessToken", "hftoken", "bearer", "bearer_token", "X-Auth-Token",
    "secret", "client_secret", "clientSecret", "password", "user_password", "passwd", "passphrase",
    "auth", "Authorization", "auth_header", "oauth", "credentials", "credential_json", "googleCredentials", "passkey",
];
const ORDINARY = [
    "keyframe", "keyframes", "keyFrame", "key_color", "keep_aspect", "keep_proportion", "keep_model_loaded", "monkey",
    "monkey_patch", "hotkey", "keypoints", "keyword", "keywords", "max_tokens", "max_new_tokens", "tokens", "tokenizer",
    "token_normalization", "author", "authors", "authority", "author_name", "seed", "steps", "text", "ckpt_name",
    "unet_name", "lora_name", "filename_prefix", "api_url", "api_version", "base_url", "passes", "bypass", "image",
    "images.image_1", "result_source_local", "canvas_state", "denoise", "", "_",
];

async function main() {
    const R = await editorModule("redact.js");

    // ---- the matcher
    const missed = SECRET.filter((n) => !R.isSecretName(n));
    check(`${SECRET.length} names that hold a secret are flagged`, !missed.length, missed.join(", "));
    const flagged = ORDINARY.filter((n) => R.isSecretName(n));
    check(`${ORDINARY.length} ordinary names are left alone`, !flagged.length, flagged.join(", "));
    const odd = [null, undefined, 3, {}, ["api_key"]].filter((n) => R.isSecretName(n));
    check("anything but a string is not a secret name", !odd.length, odd.map(String).join(", "));

    // ---- the filter over an API-format prompt
    const KEY = "sk-live-0123456789abcdef";
    const recipe = {
        canvas: { class_type: "InpaintCanvas", inputs: { padding: 64, result_source_local: ["decode", 0] } },
        unet: { class_type: "UNETLoader", inputs: { unet_name: "flux.safetensors", weight_dtype: "default" } },
        api: { class_type: "SomeApiNode", inputs: { prompt: "a fox", api_key: KEY, keyframe: 3, seed: 7, image: ["canvas", 0] }, _meta: { title: "API key node" } },
        opts: { class_type: "OptionsNode", inputs: { options: { quality: "high", auth: { bearer: KEY }, list: [{ token: KEY, n: 1 }] } } },
        // a key typed into a primitive and joined with a prefix, wired into a node's `openai_key`
        prim: { class_type: "PrimitiveString", inputs: { value: KEY } },
        prefix: { class_type: "PrimitiveString", inputs: { value: "Bearer " } },
        join: { class_type: "StringConcatenate", inputs: { string_a: ["prefix", 0], string_b: ["prim", 0], delimiter: "" } },
        llm: { class_type: "LLMNode", inputs: { openai_key: ["join", 0], max_tokens: 512, text: "hello" } },
        bare: { class_type: "NoInputs" },
    };
    const before = JSON.stringify(recipe);
    const out = R.withoutSecrets(recipe);
    const text = JSON.stringify(out);
    check("the recipe object itself is not changed", JSON.stringify(recipe) === before);
    check("no copy of the key survives anywhere", !text.includes(KEY), text.slice(0, 300));
    check("a key widget is left out, its node's other inputs kept",
        !("api_key" in out.api.inputs) && out.api.inputs.prompt === "a fox" && out.api.inputs.keyframe === 3 && out.api.inputs.seed === 7 && JSON.stringify(out.api.inputs.image) === '["canvas",0]',
        JSON.stringify(out.api.inputs));
    check("node ids, class types and _meta are kept", Object.keys(out).join() === Object.keys(recipe).join() && out.api.class_type === "SomeApiNode" && out.api._meta.title === "API key node");
    check("inside an object widget: the secret keys go, the rest stays",
        JSON.stringify(out.opts.inputs.options) === '{"quality":"high","list":[{"n":1}]}', JSON.stringify(out.opts.inputs.options));
    check("a wired key input is left out", !("openai_key" in out.llm.inputs) && out.llm.inputs.max_tokens === 512 && out.llm.inputs.text === "hello", JSON.stringify(out.llm.inputs));
    check("the nodes that feed it lose their literal inputs, upstream as far as the wires go",
        JSON.stringify(out.prim.inputs) === "{}" && JSON.stringify(out.prefix.inputs) === "{}" && JSON.stringify(out.join.inputs) === '{"string_a":["prefix",0],"string_b":["prim",0]}',
        JSON.stringify([out.prim.inputs, out.prefix.inputs, out.join.inputs]));
    check("nodes that feed no secret keep everything", JSON.stringify(out.canvas) === JSON.stringify(recipe.canvas) && JSON.stringify(out.unet) === JSON.stringify(recipe.unet));
    check("a node without inputs comes through", out.bare && out.bare.class_type === "NoInputs");
    check("null, a string or a list come back as they are", R.withoutSecrets(null) === null && R.withoutSecrets("x") === "x" && JSON.stringify(R.withoutSecrets([1])) === "[1]");
    // a cycle of wires (not a valid prompt, but the walk must end)
    const loop = R.withoutSecrets({ a: { inputs: { token: ["b", 0] } }, b: { inputs: { x: ["a", 0], v: KEY } } });
    check("a cycle of wires ends", !JSON.stringify(loop).includes(KEY), JSON.stringify(loop));

    // ---- the shipped recipes: nothing in them is named like a secret, so the filter changes none of them
    const fs = require("node:fs");
    const dir = path.join(__dirname, "..", "recipes");
    const changed = [];
    let n = 0;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
        let r;
        try { r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
        if (!r || !r.prompt) continue;
        n++;
        if (JSON.stringify(R.withoutSecrets(r.prompt)) !== JSON.stringify(r.prompt)) changed.push(f);
    }
    check(`the ${n} shipped ComfyUI recipes come through unchanged`, n > 0 && !changed.length, changed.join(", "));

    console.log(failures ? `\n${failures} FAILED` : "\nall ok");
    process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
