// Reversal round for fix-small F-2 (host/H-6): each mutant puts one piece of the fix back the way the base had it (M1:
// both files as at the base, read with `git show <base>:<file>`), runs `node tools/stitch_test.js`, and must turn it red.
// The files are restored after every mutant (and checked against their original bytes at the end).
//
//   node docs/measurements/fix_small_f2_2026-11-11/reversals.js [--base d8d6cd81] [--out results.txt]
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const STITCH = "renderer/editor/stitch.js";
const WORKER = "renderer/editor/stitch_worker.js";

const MUTANTS = [
    { id: "M1_base_code_of_both_files", base: [STITCH, WORKER] },
    {
        id: "M2_worker_error_reply_without_the_mask",
        file: WORKER,
        edits: [["self.postMessage({ id: msg.id, ok: false, error, sel, pxCalls: pxCalls() }, sel ? [sel.data.buffer] : []);",
            "self.postMessage({ id: msg.id, ok: false, error, pxCalls: pxCalls() });"]],
    },
    {
        id: "M3_main_side_drops_the_reply_mask",
        file: STITCH,
        edits: [["        if (m.sel) err.sel = m.sel;", "        void m.sel;"]],
    },
    {
        id: "M4_fallback_does_not_restore_the_mask",
        file: STITCH,
        edits: [["            if (err && err.sel && err.sel.data) sel.data = err.sel.data;", "            void err;"]],
    },
    {
        id: "M5_plain_run_reads_the_current_selection_again",
        file: STITCH,
        edits: [["            if (!area) throw new Error(", "            if (!area) { sel = selectionWindow(editor); } else if (false) throw new Error("]],
    },
    {
        id: "M6_area_run_refuses_too",
        file: STITCH,
        edits: [["            if (!area) throw new Error(", "            if (true) throw new Error("]],
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
    const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
    const base = arg("--base", "d8d6cd81");
    const outFile = arg("--out", path.join(__dirname, "results.txt"));
    const originals = new Map();
    const keep = (rel) => { const abs = path.join(ROOT, rel); if (!originals.has(abs)) originals.set(abs, fs.readFileSync(abs)); return abs; };
    const lines = [`fix-small F-2 reversal round (base ${base}), ${new Date().toISOString()}`, ""];
    let killed = 0;
    try {
        for (const m of MUTANTS) {
            if (m.base) {
                for (const rel of m.base) fs.writeFileSync(keep(rel), execFileSync("git", ["show", `${base}:${rel}`], { cwd: ROOT }));
            } else {
                const abs = keep(m.file);
                fs.writeFileSync(abs, apply(originals.get(abs).toString("utf8"), m.edits, m.id));
            }
            const t0 = Date.now();
            const r = spawnSync(process.execPath, [path.join(ROOT, "tools", "stitch_test.js")], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
            for (const [abs, buf] of originals) fs.writeFileSync(abs, buf);
            const text = `${r.stdout || ""}\n${r.stderr || ""}`;
            const fails = [...text.matchAll(/^\[FAIL\] ((?:H-6: )?[^:]+)/gm)].map((x) => x[1]);
            const dead = r.status !== 0;
            if (dead) killed++;
            const line = `${dead ? "KILLED  " : "SURVIVED"} ${m.id} rc=${r.status} ${((Date.now() - t0) / 1000).toFixed(1)} s${fails.length ? " by " + [...new Set(fails)].join(" | ") : ""}`;
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
