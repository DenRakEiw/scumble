// The models the user adds by hand (Settings > Language models), in plain Node: the rules
// electron/main/llm_custom.js holds the stored list to, where a row of a Chat Completions
// provider without an upsample adapter of its own is sent, and how such a row reaches the
// assistant's picker (electron/main/assistant/providers.js).
//
// No Electron, no app, no key: this is the first step of the `llm` gate (tools/llm_test.py),
// which then drives the running app.
//
//     node tools/models_test.js
"use strict";

const path = require("node:path");

const custom = require(path.join(__dirname, "..", "electron", "main", "llm_custom.js"));
const { PROVIDERS, ORDER, picker, providerOf } = require(path.join(__dirname, "..", "electron", "main", "assistant", "providers.js"));

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
    if (ok) { pass++; console.log("[ok]", name); }
    else { fail++; console.log("[FAIL]", name, detail === undefined ? "" : "-> " + JSON.stringify(detail)); }
}

function settingsWith(models) {
    return { llm: { compat: { url: "", model: "" }, models } };
}

// ---- 1. the stored list is normalised, never trusted as it comes ------------------------

{
    const rows = custom.normalize([
        { provider: "openrouter", model: "  qwen/qwen3-vl  ", label: "  Qwen3 VL  " },
        { provider: "openrouter", model: "qwen/qwen3-vl" },                 // the same row again
        { provider: "made-up", model: "x" },                                // no such provider
        { provider: "zai", model: "" },                                     // no model id
        { provider: "zai", model: "glm-x", upsample: false, vision: false },
        "not an object",
        null,
        { provider: "compat", model: "llava", assistant: false },
    ]);
    check("a_row_is_trimmed_and_kept_once", rows.length === 3 && rows[0].model === "qwen/qwen3-vl" && rows[0].label === "Qwen3 VL", rows);
    check("an_unknown_provider_and_an_empty_id_are_dropped", !rows.some((r) => r.provider === "made-up" || !r.model), rows);
    check("the_flags_default_to_true_and_are_kept_where_set",
        rows[0].upsample === true && rows[0].assistant === true && rows[0].vision === true
        && rows[1].upsample === false && rows[1].vision === false && rows[1].assistant === true
        && rows[2].assistant === false, rows);
    check("a_label_and_an_id_have_a_ceiling",
        custom.normalize([{ provider: "zai", model: "m".repeat(400), label: "l".repeat(400) }])[0].model.length === 200
        && custom.normalize([{ provider: "zai", model: "m", label: "l".repeat(400) }])[0].label.length === 120);
    const many = custom.normalize(Array.from({ length: custom.MAX_ROWS + 10 }, (_, i) => ({ provider: "zai", model: `m${i}` })));
    check("no_more_than_MAX_ROWS_rows", many.length === custom.MAX_ROWS, many.length);
    check("a_settings_object_without_a_list_gives_none",
        custom.rows({}).length === 0 && custom.rows({ llm: {} }).length === 0 && custom.rows(null).length === 0
        && custom.rows({ llm: { models: "nope" } }).length === 0);
    check("the_two_uses_are_read_apart",
        custom.forUpsample(settingsWith([{ provider: "zai", model: "a", assistant: false }, { provider: "zai", model: "b", upsample: false }])).map((r) => r.model).join() === "a"
        && custom.forAssistant(settingsWith([{ provider: "zai", model: "a", assistant: false }, { provider: "zai", model: "b", upsample: false }])).map((r) => r.model).join() === "b");
    check("a_prototype_key_is_not_a_provider", custom.normalize([{ provider: "constructor", model: "x" }]).length === 0);
}

// ---- 2. every provider of the registry can be named, and each knows where it goes -------

{
    const ids = custom.options().map((o) => o.provider);
    check("the_options_are_the_registry_in_its_own_order", ids.join() === ORDER.join(), ids);
    check("every_option_names_its_key_row_and_family",
        custom.options().every((o) => o.key === PROVIDERS[o.provider].key && o.family === PROVIDERS[o.provider].family));
    check("only_the_local_endpoint_needs_no_key",
        custom.options().filter((o) => !o.needsKey).map((o) => o.provider).join() === "compat");

    // the four Chat Completions providers whose upsample rows go through the generic client
    const generic = { deepseek: "https://api.deepseek.com", moonshot: "https://api.moonshot.ai/v1", zai: "https://api.z.ai/api/paas/v4", wavespeed: "https://llm.wavespeed.ai/v1" };
    for (const [provider, base] of Object.entries(generic)) {
        check(`${provider}_is_sent_to_its_own_host`, custom.endpoint(provider).base === base, custom.endpoint(provider));
    }
    check("the_hosts_without_a_fixed_one_have_no_endpoint_here",
        custom.endpoint("toapis") === null && custom.endpoint("compat") === null, [custom.endpoint("toapis"), custom.endpoint("compat")]);
    check("an_unknown_provider_has_no_endpoint", custom.endpoint("made-up") === null && custom.endpoint("hasOwnProperty") === null);
}

// ---- 3. the rows reach the assistant's picker -------------------------------------------

{
    const mine = custom.normalize([
        { provider: "openrouter", model: "qwen/qwen3-vl", label: "Qwen3 VL" },
        { provider: "openrouter", model: "anthropic/claude-opus-5" },       // already curated
        { provider: "zai", model: "glm-x", vision: false },
        { provider: "zai", model: "glm-y", assistant: false },
        { provider: "compat", model: "llava" },
    ]);
    const ready = { openrouter: true, zai: true, compat: true, compatModels: [{ id: "qwen2.5vl:7b", label: "qwen2.5vl:7b" }] };
    const groups = picker(ready, mine.filter((r) => r.assistant));

    const or = groups.find((g) => g.provider === "openrouter");
    check("a_row_joins_its_provider_group_last",
        or.models[or.models.length - 1].value === "openrouter:qwen/qwen3-vl" && or.models[or.models.length - 1].label === "Qwen3 VL" && or.models[or.models.length - 1].custom === true,
        or.models.map((m) => m.value));
    check("a_row_that_repeats_a_curated_model_is_not_listed_twice",
        or.models.filter((m) => m.value === "openrouter:anthropic/claude-opus-5").length === 1, or.models.map((m) => m.value));

    const zai = groups.find((g) => g.provider === "zai");
    check("a_blind_row_says_so_in_the_picker",
        zai.models.find((m) => m.value === "zai:glm-x").vision === false, zai.models);
    check("a_row_that_is_not_for_the_assistant_is_not_in_the_picker",
        !zai.models.some((m) => m.value === "zai:glm-y"), zai.models.map((m) => m.value));

    const compat = groups.find((g) => g.provider === "compat");
    check("a_row_of_the_local_endpoint_joins_what_its_own_models_list",
        compat.models.map((m) => m.value).join() === "compat:qwen2.5vl:7b,compat:llava", compat.models.map((m) => m.value));

    check("no_group_warns_about_itself",
        groups.every((g) => !("tried" in g)) && !JSON.stringify(groups).includes("not tried"), Object.keys(groups[0]));

    // what the loop reads for a chat: the label and whether the model sees the picture
    const t = providerOf("zai:glm-x", mine);
    check("the_loop_takes_a_row_s_own_vision_flag", t.model.vision === false && t.custom === true, t.model);
    check("the_loop_takes_a_row_s_own_name", providerOf("openrouter:qwen/qwen3-vl", mine).model.label === "Qwen3 VL", providerOf("openrouter:qwen/qwen3-vl", mine).model);
    check("a_row_without_a_label_is_its_id", providerOf("openrouter:qwen/qwen3-vl", [{ provider: "openrouter", model: "qwen/qwen3-vl", label: "", vision: true }]).model.label === "qwen/qwen3-vl");
    check("an_id_nobody_added_stays_what_it_was",
        providerOf("openrouter:some/other", mine).model.label === "some/other" && providerOf("openrouter:some/other", mine).custom === false);
    check("a_curated_model_is_not_custom",
        providerOf("anthropic:claude-sonnet-5", mine).custom === false && providerOf("anthropic:claude-sonnet-5", mine).model.label === "Claude Sonnet 5");
    check("providerOf_without_a_list_still_answers", providerOf("anthropic:claude-opus-5").model.label === "Claude Opus 5" && providerOf("nope") === null && providerOf("made-up:x") === null);
}

console.log(`\n${pass} checks pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
