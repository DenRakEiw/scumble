// Reversal round for fix-small F-1 (filters/depth-map-texture-reuploaded-every-pass, filters/cube-domain-applied-to-outputs,
// filters/haze-cpu-twin-half-pixel): each mutant puts one piece of the fix back the way the base had it, runs the test
// that names that bug, and must turn it red. Node mutants run `node <test>`; live mutants run the depthfx gate on a fresh
// instance (tools/run_gates.sh, --tiles on, --offline, port $SCUMBLE_CDP_PORT or 9641). The file is restored after every
// mutant and checked against its original bytes at the end. Run it with nothing else using the tree.
//
//   node docs/measurements/fix_small_f1_2026-11-11/reversals.js [--out results.txt] [--node-only]
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const MAPS = "renderer/editor/inpaint_maps.js";
const FILTERS = "renderer/editor/inpaint_filters.js";
const DEPTHFX = "renderer/editor/inpaint_depthfx.js";

const MUTANTS = [
    {
        id: "R1_rg8View_new_view_per_call",
        file: MAPS,
        test: ["node", "tools/maps_test.js"],
        edits: [["        data: bytes,\n", "        data: new Uint8Array(map.data.buffer, map.data.byteOffset, map.data.byteLength),\n"]],
    },
    {
        id: "R2_cube_domain_scales_the_outputs",
        file: FILTERS,
        test: ["node", "tools/grade_test.js"],
        edits: [["        const v = out[i];\n", "        const v = (values[i] - lo[i % 3]) / (hi[i % 3] - lo[i % 3]);\n"]],
    },
    {
        id: "R3_cube_domain_ignored",
        file: FILTERS,
        test: ["node", "tools/grade_test.js"],
        edits: [["    const out = unit ? values : lutOnUnitDomain(values, size, lo, hi);\n", "    const out = unit ? values : values;\n"]],
    },
    {
        id: "R4_live_rg8View_new_view_per_call",
        file: MAPS,
        live: "depthfx",
        edits: [["        data: bytes,\n", "        data: new Uint8Array(map.data.buffer, map.data.byteOffset, map.data.byteLength),\n"]],
    },
    {
        id: "R5_live_haze_at_pixel_corners",
        file: DEPTHFX,
        live: "depthfx",
        edits: [
            ["        const py = origin[1] + y + 0.5;   // the pixel's centre", "        const py = origin[1] + y;   // the pixel's centre"],
            ["            const px_x = origin[0] + x + 0.5;\n\n            const mx = m[0]", "            const px_x = origin[0] + x;\n\n            const mx = m[0]"],
        ],
    },
];

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const outFile = outAt >= 0 ? args[outAt + 1] : path.join(__dirname, "results.txt");
const nodeOnly = args.includes("--node-only");
const only = args.filter((a) => /^R\d/.test(a));
const port = process.env.SCUMBLE_CDP_PORT || "9641";
const gates = process.env.SCUMBLE_GATES || path.join(ROOT, "dist", "gates");

const originals = new Map();
const lines = [`F-1 reversal round, ${new Date().toISOString()}`];
let killed = 0, survived = 0, ran = 0;

function run(cmd, opts) {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, ...opts });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

for (const m of MUTANTS) {
    if (nodeOnly && m.live) continue;
    if (only.length && !only.some((o) => m.id.startsWith(o))) continue;
    const abs = path.join(ROOT, m.file);
    if (!originals.has(abs)) originals.set(abs, fs.readFileSync(abs));
    const src = originals.get(abs).toString("utf8");
    let mutated = src;
    for (const [from, to] of m.edits) {
        const n = mutated.split(from).length - 1;
        if (n !== 1) throw new Error(`${m.id}: the text to replace occurs ${n} times in ${m.file}`);
        mutated = mutated.replace(from, to);
    }
    fs.writeFileSync(abs, mutated);
    let r;
    try {
        r = m.live
            ? run(["bash", "tools/run_gates.sh", `f1rev-${m.id}`, "--tiles", "on", "--offline", m.live],
                { env: { ...process.env, SCUMBLE_CDP_PORT: port, SCUMBLE_GATES: gates } })
            : run(m.test);
    } finally {
        fs.writeFileSync(abs, originals.get(abs));
    }
    ran++;
    const red = r.code !== 0;
    if (red) killed++; else survived++;
    const why = (r.out.match(/(FAIL[^\n]*|AssertionError[^\n]*|\[FAIL\][^\n]*)/) || [""])[0].slice(0, 200);
    lines.push(`${red ? "KILLED  " : "SURVIVED"} ${m.id} (rc ${r.code}) ${why}`);
    console.log(lines[lines.length - 1]);
}

for (const [abs, bytes] of originals) {
    if (!fs.readFileSync(abs).equals(bytes)) throw new Error(`${abs} was not restored`);
}
lines.push(`${killed} of ${ran} killed, ${survived} survived; every file restored byte for byte`);
console.log(lines[lines.length - 1]);
fs.writeFileSync(outFile, lines.join("\n") + "\n");
process.exit(survived ? 1 : 0);
