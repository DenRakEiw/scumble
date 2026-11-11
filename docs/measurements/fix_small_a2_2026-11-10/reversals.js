// Reversal round for fix-small A2 (shell/F2, shell/F9): each mutant puts one piece of the fix back the way the base
// had it (or breaks it the way a careless edit would), runs `node tools/assistant_test.js`, and must turn it red.
// The file is restored after every mutant (and checked against its original bytes at the end).
//
//   node docs/measurements/fix_small_a2_2026-11-10/reversals.js [--out results.txt]
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const INDEX = "electron/main/assistant/index.js";

const MUTANTS = [
    {
        id: "M1_F2_default_layer_on_every_call",
        file: INDEX,
        edits: [["if (out.layer === undefined && layers.length && defaultLayerFor(name, out, props)) {",
            "if (out.layer === undefined && layers.length && name !== \"relight\") {"]],
    },
    {
        id: "M2_F2_tools_without_a_layer_get_one",
        file: INDEX,
        edits: [["if (!props || !props.layer || name === \"relight\") return false;", "if (name === \"relight\") return false;"]],
    },
    {
        id: "M3_F2_select_color_always_gets_the_layer",
        file: INDEX,
        edits: [["if (name === \"select_color\") return !!(args && args.sample === \"layer\");", "if (name === \"select_color\") return true;"]],
    },
    {
        id: "M4_F2_boxes_always_get_the_layer",
        file: INDEX,
        edits: [["if (name === \"boxes_add\" || name === \"boxes_set\") return !!(args && args.kind === \"from\");",
            "if (name === \"boxes_add\" || name === \"boxes_set\") return true;"]],
    },
    {
        id: "M5_F2_select_color_keeps_layer_active",
        file: INDEX,
        edits: [["    if (name === \"select_color\" && out.sample !== \"layer\" && out.layer === \"active\") delete out.layer;\n", ""]],
    },
    {
        id: "M6_F9_nothing_recorded",
        file: INDEX,
        edits: [["if (!res.isError) this.recordSettingsChange(chat, doc, name, canonical.args, parsed);", "void parsed;"]],
    },
    {
        id: "M7_F9_settings_not_on_the_card",
        file: INDEX,
        edits: [["            facts.settings = built.settings;\n", ""]],
    },
    {
        id: "M8_F9_list_settings_not_read",
        file: INDEX,
        edits: [["listed = await this.read(\"list_settings\", { doc, max_options: 0 });", "listed = null;"]],
    },
    {
        id: "M9_F9_one_record_for_every_document",
        file: INDEX,
        edits: [
            ["if (!chat.changedSettings.has(key)) chat.changedSettings.set(key, empty());\n        return chat.changedSettings.get(key);",
                "if (!chat.changedSettings.has(\"0\")) chat.changedSettings.set(\"0\", empty());\n        return chat.changedSettings.get(\"0\");"],
        ],
    },
    {
        id: "M10_F9_marked_by_shared_label",
        file: INDEX,
        edits: [["const hit = idx != null && rows.has(idx);",
            "const hit = (idx != null && rows.has(idx)) || [...rows.values()].some((r) => r.label === row.label);"]],
    },
    {
        id: "M11_F9_generation_field_overwrites_a_row",
        file: INDEX,
        edits: [["if (ch) for (const [k, v] of ch.gen) put(settingKeyOf({ label: k, input: \"generation\" }, taken), v, true);",
            "if (ch) for (const [k, v] of ch.gen) put(k, v, true);"]],
    },
    {
        id: "M12_F9_unlisted_changed_row_dropped",
        file: INDEX,
        edits: [["        if (shown.has(idx)) continue;\n", "        continue;\n"]],
    },
    {
        id: "M13_F9_preset_rows_not_marked",
        file: INDEX,
        edits: [["if (!rows.has(String(v.index))) rows.set(String(v.index), { label: settingKeyOf(v), value: v.value });", "void v;"]],
    },
    {
        id: "M14_F9_undo_keeps_the_record",
        file: INDEX,
        edits: [["for (const d of docs || []) this.chat.changedSettings.delete(String(d));", "void docs;"]],
    },
    {
        id: "M15_F9_close_document_keeps_the_record",
        file: INDEX,
        edits: [["if (chat.changedSettings instanceof Map) chat.changedSettings.delete(String(doc));", "void doc;"]],
    },
];

function apply(src, edits, id) {
    let out = src;
    for (const [from, to] of edits) {
        const n = out.split(from).length - 1;
        if (n !== 1) throw new Error(`${id}: the text to change occurs ${n} times, not once: ${JSON.stringify(from.slice(0, 80))}`);
        out = out.replace(from, () => to);
    }
    return out;
}

function main() {
    const outArg = process.argv.indexOf("--out");
    const outFile = outArg > 0 ? process.argv[outArg + 1] : path.join(__dirname, "results.txt");
    const originals = new Map();
    const lines = [`fix-small A2 reversal round, ${new Date().toISOString()}`, ""];
    let killed = 0;
    try {
        for (const m of MUTANTS) {
            const abs = path.join(ROOT, m.file);
            if (!originals.has(abs)) originals.set(abs, fs.readFileSync(abs));
            const src = originals.get(abs).toString("utf8");
            fs.writeFileSync(abs, apply(src, m.edits, m.id));
            const t0 = Date.now();
            const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "assistant_test.js")], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
            fs.writeFileSync(abs, originals.get(abs));
            const text = `${r.stdout || ""}\n${r.stderr || ""}`;
            const fails = [...text.matchAll(/^\[FAIL\] ([^:\s]+)/gm)].map((x) => x[1]);
            const dead = r.status !== 0;
            if (dead) killed++;
            const line = `${dead ? "KILLED  " : "SURVIVED"} ${m.id} rc=${r.status} ${((Date.now() - t0) / 1000).toFixed(1)} s${fails.length ? " by " + [...new Set(fails)].join(", ") : ""}`;
            console.log(line);
            lines.push(line);
        }
    } finally {
        for (const [abs, buf] of originals) fs.writeFileSync(abs, buf);
    }
    for (const [abs, buf] of originals) {
        if (!fs.readFileSync(abs).equals(buf)) throw new Error(`${abs} was not restored`);
    }
    lines.push("", `${killed} of ${MUTANTS.length} killed`);
    console.log(lines[lines.length - 1]);
    fs.writeFileSync(outFile, lines.join("\n") + "\n");
    process.exit(killed === MUTANTS.length ? 0 : 1);
}

main();
