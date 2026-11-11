// tools/rename_check.js on a small rename (item 56 S14a): the right one passes, each slip fails.
// Run: node tools/rename_check_test.js
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run } = require("./rename_check.js");

const OLD = `import { x } from "./dep.js";
// the settings
let settings = await x();
let count = 0;
function bump(state) { count++; return { settings, state }; }
export { bump };
`;
const GOOD = `import { x } from "./dep.js";
import { shared } from "./s_state.js";
// the settings
shared.settings = await x();
shared.count = 0;
function bump(state) { shared.count++; return { settings: shared.settings, state }; }
export { bump };
`;
const STATE = "export const shared = {\n    settings: undefined,\n    count: undefined,\n};\n";

let failed = 0, passed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${info ? " -- " + info : ""}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-check-"));
try {
    fs.writeFileSync(path.join(dir, "old.js"), OLD);
    const trial = (text, state = STATE) => {
        fs.writeFileSync(path.join(dir, "s.js"), text);
        fs.writeFileSync(path.join(dir, "s_state.js"), state);
        return run({ old: path.join(dir, "old.js"), root: dir, state: "./s_state.js", name: "shared", file: "s.js", names: ["settings", "count"] });
    };
    const ok = trial(GOOD);
    check("the right rename passes (a shorthand written out, a parameter of another name left alone)", !ok.problems.length && ok.renamed === 4, ok.problems.join("; ") + ` renamed ${ok.renamed}`);
    const fails = (r, re) => r.problems.some((p) => re.test(p));
    const cases = [
        ["another change", GOOD.replace("count++", "count += 2"), STATE, /differs/],
        ["a name not listed", GOOD.replace("return { settings", "return { other: shared.other, settings"), STATE, /shared\.other is not a listed name/],
        ["a use left as the bare name", GOOD.replace("shared.count++", "count++"), STATE, /differs|count/],
        ["a changed comment", GOOD.replace("// the settings", "// settings"), STATE, /comments differ/],
        ["a state object with other keys", GOOD, "export const shared = {\n    settings: undefined,\n};\n", /keys settings are not the listed names/],
    ];
    for (const [what, text, state, re] of cases) { const r = trial(text, state); check(`fails on ${what}`, fails(r, re), r.problems.join(" | ") || "no problem found"); }
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
