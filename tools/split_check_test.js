// tools/split_check.js on a small split (item 56, docs/PLAN_SPLIT.md §2): the right split passes and prints its moved
// lines; each slip a move can make fails with its own words. Run: node tools/split_check_test.js
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run } = require("./split_check.js");

const OLD = `import { x, name } from "./dep.js";

// helper doc
const K = 3;
export function helper(n) { return n * K + x; }

export class Big {
    constructor() { this.v = 1; }
    static make() { return new Big(); }
    // doubles
    twice() { return helper(this.v) * 2; }
    get half() { return this.v / 2; }
    useStatus() { return status; }   // a browser global
    useName() { return name; }
    useBig() { return Big.make(); }
}

export const OBJ = {
    a: 1,
    b() { return K; },
    c: 3
};
`;

const GOOD = {
    "a/big_util.js": `import { x } from "./dep.js";

// helper doc
const K = 3;
export function helper(n) { return n * K + x; }
export { K };
`,
    "a/big_part.js": `import { helper } from "./big_util.js";
import { name } from "./dep.js";

let Big = null;
export class BigPart {
    // doubles
    twice() { return helper(this.v) * 2; }
    useName() { return name; }
    useBig() { return Big.make(); }
}
export function bindBigPart(C) { Big = C; }
`,
    "a/big_obj.js": `import { K } from "./big_util.js";

export const ObjPart = {
    b() { return K; },
    c: 3
};
`,
    "a/big.js": `import { installParts } from "./parts.js";
import { helper } from "./big_util.js";
import { BigPart, bindBigPart } from "./big_part.js";
import { ObjPart } from "./big_obj.js";

export { helper };

export class Big {
    constructor() { this.v = 1; }
    static make() { return new Big(); }
    get half() { return this.v / 2; }
    useStatus() { return status; }   // a browser global
}
installParts(Big, [BigPart]);
bindBigPart(Big);

export const OBJ = {
    a: 1,
    ...ObjPart,
};
`,
};

let failed = 0, passed = 0;
function check(name, ok, info) {
    if (ok) passed++; else failed++;
    console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${info ? " -- " + info : ""}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "split-check-"));
const oldPath = path.join(dir, "old.js");
fs.writeFileSync(oldPath, OLD);

/** Run the check on GOOD with `edits`: { file: [[from, to], ...] } (each `from` must be there). */
function trial(edits = {}) {
    for (const [f, text] of Object.entries(GOOD)) {
        let t = text;
        for (const [a, b] of edits[f] || []) {
            if (!t.includes(a)) throw new Error(`the trial's edit of ${f} does not apply: ${a}`);
            t = t.replace(a, b);
        }
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), t);
    }
    return run({ old: oldPath, root: dir, cls: null, object: "OBJ", files: ["a/big.js", "a/big_util.js", "a/big_part.js", "a/big_obj.js"] });
}
const fails = (r, re) => r.problems.some((p) => re.test(p));

try {
    const ok = trial();
    check("the right split passes", !ok.problems.length, ok.problems.join("; "));
    check("... and counts the moved lines (helper, K with its comment, four members, two properties)", ok.moved === 9, `moved ${ok.moved}`);
    check("... and the prototype's names (constructor, half, useStatus, twice, useName, useBig)", ok.protoCount === 6, String(ok.protoCount));

    const cases = [
        ["a renamed name in a moved body", { "a/big_part.js": [["helper(this.v) * 2", "helper(this.w) * 2"]] }, /Big\.twice: the text differs in a\/big_part\.js/],
        ["a re-indented member", { "a/big_part.js": [["    useBig() {", "  useBig() {"]] }, /Big\.useBig: the text differs/],
        ["a changed comment above a member", { "a/big_part.js": [["// doubles", "// twice"]] }, /Big\.twice: the text differs/],
        ["a member left behind nowhere", { "a/big_part.js": [["    useBig() { return Big.make(); }\n", ""]] }, /Big\.useBig: in the old file, found in none/],
        ["a member in two places", { "a/big_part.js": [["    useName()", "    useStatus() { return status; }   // a browser global\n    useName()"]] }, /Big\.useStatus: found 2 times/],
        ["something added", { "a/big_part.js": [["export function bindBigPart", "function extra() { return 1; }\nexport function bindBigPart"]] }, /extra: new in a\/big_part\.js/],
        ["a forgotten import of a name that is also a global (name)", { "a/big_part.js": [['import { name } from "./dep.js";\n', ""]] }, /Big\.useName: name was the old file's own binding, in a\/big_part\.js it is a global/],
        ["a global shadowed by a new declaration (status)", { "a/big.js": [["export { helper };", "export { helper };\nimport { status } from \"./dep.js\";"]] }, /Big\.useStatus: status was a global, in a\/big\.js it is the file's own binding/],
        ["a part not installed", { "a/big.js": [["installParts(Big, [BigPart]);\n", ""]] }, /part BigPart is not installed/],
        ["a part not imported by the file", { "a/big.js": [["import { BigPart, bindBigPart }", "import { bindBigPart }"], ["[BigPart]", "[]"]] }, /BigPart is not imported by a\/big\.js/],
        ["a part that imports the long file", { "a/big_part.js": [["let Big = null;\n", 'import { Big } from "./big.js";\n'], ["export function bindBigPart(C) { Big = C; }\n", ""]], "a/big.js": [["import { BigPart, bindBigPart }", "import { BigPart }"], ["bindBigPart(Big);\n", ""]] }, /a\/big_part\.js: imports a\/big\.js/],
        ["a bind function never called", { "a/big.js": [["bindBigPart(Big);\n", ""]] }, /bindBigPart\(Big\) is not called/],
        ["a static member in a part", { "a/big_part.js": [["    useBig()", "    static useBig()"]] }, /static member \(static useBig\)/],
        ["an export the importers need is gone", { "a/big.js": [["export { helper };\n", ""]] }, /no longer exports helper/],
        ["a spread part out of the key order", { "a/big.js": [["    a: 1,\n    ...ObjPart,", "    ...ObjPart,\n    a: 1,"]] }, /OBJ: the key order changed at 0/],
        ["a property's text changed", { "a/big_obj.js": [["c: 3", "c: 4"]] }, /OBJ\.c: the text differs/],
    ];
    for (const [what, edits, re] of cases) {
        const r = trial(edits);
        check(`fails on ${what}`, fails(r, re), r.problems.join(" | ") || "no problem found");
    }
    // a comma that comes with a moved last property is no change
    const comma = trial({ "a/big_obj.js": [["c: 3\n", "c: 3,\n"]] });
    check("a trailing comma that comes or goes is no change", !comma.problems.length, comma.problems.join("; "));
    // a stand-alone comment that is gone is a note, not a failure
    const loose = trial({ "a/big_util.js": [["// helper doc\n", "\n// helper doc\n\n"]] });
    check("a comment that no longer sits on its code fails (it is part of the unit)", fails(loose, /^K: the text differs/), loose.problems.join(" | "));
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
