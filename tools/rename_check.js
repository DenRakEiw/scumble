// The proof that a rename of module variables into one state object changed nothing else (item 56 S14a,
// docs/PLAN_SPLIT.md §5.1).
//
//   node tools/rename_check.js --base <commit> <file> --state <module> [--name <object>] name1,name2,...
//
// <file>'s old text comes from `git show <commit>:<file>`. The new file must import the object (`--name`, default
// `state`) from <module> (a path
// relative to <file>) and must use it only as `state.<name>` for the listed names. The check normalizes both trees and
// compares them node for node, positions left out:
//   - old: each top-level `let <name> = <init>;` of a listed name reads as the assignment `<name> = <init>;`;
//   - new: the `import { state } from "<module>"` line is dropped and every `state.<name>` reads as `<name>`;
//   - a property `{ x }` and `{ x: x }` are the same (a shorthand of a renamed name has to be written out).
// It also checks that every listed name was a top-level `let` of the old file, that nothing else declares `state`,
// that <module> exports `state` as an object literal with exactly the listed keys, and that the comments are the same
// texts in the same order. Exit 1 on any difference.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const acorn = require("acorn");
const escope = require("eslint-scope");

const REPO = path.resolve(__dirname, "..");

function args(argv) {
    const o = { base: null, old: null, root: REPO, state: null, name: "state", file: null, names: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--base") o.base = argv[++i];
        else if (a === "--old") o.old = argv[++i];
        else if (a === "--root") o.root = path.resolve(argv[++i]);
        else if (a === "--state") o.state = argv[++i];
        else if (a === "--name") o.name = argv[++i];
        else if (!o.file) o.file = a.replace(/\\/g, "/");
        else o.names.push(...a.split(",").filter(Boolean));
    }
    if (!o.file || !o.state || !o.names.length || (!o.base && !o.old)) throw new Error("usage: rename_check.js (--base <commit> | --old <path>) <file> --state <module> [--name <object>] name1,name2,...");
    return o;
}

const lf = (s) => s.replace(/\r\n/g, "\n");
function parse(text, file) {
    const comments = [];
    try {
        return { ast: acorn.parse(text, { ecmaVersion: "latest", sourceType: "module", ranges: true, onComment: comments }), comments };
    } catch (err) {
        throw new Error(`${file}: does not parse: ${err.message}`);
    }
}

const SKIP = new Set(["start", "end", "loc", "range"]);   // positions are left out
function norm(node) {
    if (Array.isArray(node)) return node.map(norm);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const k of Object.keys(node)) {
        if (SKIP.has(k)) continue;
        out[k] = norm(node[k]);
    }
    if (out.type === "Property" && out.shorthand) out.shorthand = false;
    if (out.type === "Property" && !out.computed && out.value && out.value.type === "Identifier" && out.key.type === "Identifier" && out.key.name === out.value.name) out.shorthand = false;
    return out;
}

/** Replace nodes in place: fn(node) returns a replacement or undefined. */
function rewrite(node, fn) {
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) { if (!node[i] || typeof node[i] !== "object") continue; const r = fn(node[i]); if (r) node[i] = r; else rewrite(node[i], fn); } return; }
    if (!node || typeof node !== "object") return;
    for (const k of Object.keys(node)) {
        const c = node[k];
        if (c && typeof c === "object") {
            if (Array.isArray(c)) rewrite(c, fn);
            else if (typeof c.type === "string") { const r = fn(c); if (r) node[k] = r; else rewrite(c, fn); }
        }
    }
}

function firstDiff(a, b, at = "") {
    if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) return at || "(root)";
    if (!a || typeof a !== "object") return a === b ? null : at;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (Array.isArray(a) && a.length !== b.length) return `${at}.length (${a.length} vs ${b.length})`;
    for (const k of keys) {
        const d = firstDiff(a[k], b[k], `${at}.${k}${a && a.type ? `<${a.type}>` : ""}`);
        if (d) return d;
    }
    return null;
}

function run(o) {
    const problems = [];
    const read = (rel) => lf(fs.readFileSync(path.join(o.root, rel), "utf8"));
    const oldText = o.old ? lf(fs.readFileSync(o.old, "utf8")) : lf(execFileSync("git", ["-C", o.root, "show", `${o.base}:${o.file}`], { encoding: "utf8", maxBuffer: 256 << 20 }));
    const old = parse(oldText, `${o.file} (old)`), now = parse(read(o.file), o.file);
    const names = new Set(o.names);

    // old: the listed lets read as assignments
    const declared = new Set();
    old.ast.body = old.ast.body.map((s) => {
        if (s.type === "VariableDeclaration" && s.kind === "let" && s.declarations.length === 1 && s.declarations[0].id.type === "Identifier" && names.has(s.declarations[0].id.name)) {
            const d = s.declarations[0];
            if (!d.init) { problems.push(`old let ${d.id.name} has no initializer`); return s; }
            declared.add(d.id.name);
            return { type: "ExpressionStatement", expression: { type: "AssignmentExpression", operator: "=", left: { type: "Identifier", name: d.id.name }, right: d.init } };
        }
        return s;
    });
    for (const n of names) if (!declared.has(n)) problems.push(`${n} is not a top-level let of the old file`);

    // new: a listed name may not be used bare any more (it is no binding of the file: it would read a global)
    const sm = escope.analyze(now.ast, { ecmaVersion: 2022, sourceType: "module" });
    for (const r of sm.globalScope.through) if (names.has(r.identifier.name)) problems.push(`${r.identifier.name} is used bare at ${r.identifier.start} (not as ${o.name}.${r.identifier.name})`);
    // new: drop the state import, state.<name> reads as <name>
    let imported = 0;
    now.ast.body = now.ast.body.filter((s) => {
        if (s.type !== "ImportDeclaration" || s.source.value !== o.state) return true;
        if (s.specifiers.length !== 1 || s.specifiers[0].type !== "ImportSpecifier" || s.specifiers[0].imported.name !== o.name || s.specifiers[0].local.name !== o.name) { problems.push(`the import from ${o.state} is not import { ${o.name} }`); return true; }
        imported++;
        return false;
    });
    if (imported !== 1) problems.push(`${o.file} imports ${o.name} from ${o.state} ${imported} times`);
    let renamed = 0;
    rewrite(now.ast.body, (n) => {
        if (n.type === "MemberExpression" && !n.computed && n.object.type === "Identifier" && n.object.name === o.name && n.property.type === "Identifier") {
            if (!names.has(n.property.name)) { problems.push(`${o.name}.${n.property.name} is not a listed name`); return undefined; }
            renamed++;
            return { type: "Identifier", name: n.property.name };
        }
        return undefined;
    });
    rewrite(now.ast.body, (n) => {
        if (n.type === "Identifier" && n.name === o.name) problems.push(`${o.name} is used other than as ${o.name}.<name>`);
        return undefined;
    });

    const a = norm(old.ast.body), b = norm(now.ast.body);
    if (a.length !== b.length) problems.push(`${a.length} top-level statements before, ${b.length} after`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const d = firstDiff(a[i], b[i]);
        if (d) { problems.push(`top-level statement ${i + 1} differs at ${d}`); if (problems.length > 20) break; }
    }
    const ca = old.comments.map((c) => c.value), cb = now.comments.map((c) => c.value);
    const ci = ca.findIndex((c, i) => c !== cb[i]);
    if (ci >= 0 || ca.length !== cb.length) problems.push(`the comments differ at ${ci >= 0 ? ci : ca.length}: ${JSON.stringify((ca[ci] || "").slice(0, 60))} vs ${JSON.stringify((cb[ci] || "").slice(0, 60))}`);

    // the state module
    const stateRel = path.posix.normalize(path.posix.join(path.posix.dirname(o.file), o.state));
    const st = parse(read(stateRel), stateRel);
    const decl = st.ast.body.find((s) => s.type === "ExportNamedDeclaration" && s.declaration && s.declaration.type === "VariableDeclaration" && s.declaration.declarations[0].id.name === o.name);
    if (!decl || !decl.declaration.declarations[0].init || decl.declaration.declarations[0].init.type !== "ObjectExpression") problems.push(`${stateRel}: no export const ${o.name} = { ... }`);
    else {
        const keys = decl.declaration.declarations[0].init.properties.map((q) => q.key && q.key.name).sort();
        if (JSON.stringify(keys) !== JSON.stringify([...names].sort())) problems.push(`${stateRel}: ${o.name}'s keys ${keys.join(",")} are not the listed names`);
    }
    return { problems, renamed, statements: a.length, name: o.name };
}

if (require.main === module) {
    let r;
    try {
        r = run(args(process.argv.slice(2)));
    } catch (err) {
        console.error("rename_check: " + err.message);
        process.exit(2);
    }
    for (const p of r.problems.slice(0, 40)) console.log("  PROBLEM: " + p);
    console.log(`${r.statements} top-level statements, ${r.renamed} uses renamed to ${r.name}.<name>; ${r.problems.length ? `FAIL (${r.problems.length} problems)` : "PASS"}`);
    process.exit(r.problems.length ? 1 : 0);
}

module.exports = { run };
