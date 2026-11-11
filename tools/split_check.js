// The proof that a split of a long file is a move, not a rewrite (item 56, docs/PLAN_SPLIT.md §2).
//
//   node tools/split_check.js --base <commit> <file> [new files...]
//   node tools/split_check.js --old <path to the old text> <file> [new files...]     (the test's form)
//
// <file> is the long file as it is now (repo-relative); its old text comes from `git show <commit>:<file>` (or --old).
// The new files are the modules split out of it; with --base and none given, every file of the file's family
// (tools/srcfind.js: same folder, same prefix) that did not exist at <commit>. The check:
//   - every top-level declaration and every class member of the old file is found under the same name in exactly one
//     new place, with the same source text: indentation, the comments right above it and a comment at its line's end
//     included (an `export ` in front of a top-level declaration may come or go);
//   - nothing else was added: only imports, export lists, part classes (a new class named ...Part, its members
//     counted as members of the class they came from), the bind form (`let <Class> = null;` and a `bind...(C)`
//     function whose body is `<Class> = C;`) and, in <file>, `installParts(...)` and `bind...(...)` calls;
//   - every part class is imported by <file> and installed there onto its class, every bind function called with it,
//     no part has a static member, a field or a constructor, and no new file imports <file>;
//   - every name the old file exported is still exported by <file> (no importer changes);
//   - every free name in a unit means what it meant: a module-level binding before is a module-level binding (an
//     import or a declaration) in the new file, a browser or Node global before is still one (a forgotten import of a
//     name that is also a global, `status`, `name`, `event`, would pass eslint's no-undef);
//   - the target class's prototype ends with the same member names (it follows from the first two; printed).
// A CommonJS file (recipes.js) is read the same way: `const x = require("...")` and `const { a } = require("...")`
// count as imports, `module.exports = { ... }` as the export list, a "use strict" directive as no unit.
// Comments that stand alone (a blank line from the code below them) are not part of a unit: one that is gone is
// listed as a note, never a failure. Exit 1 on any problem. Prints the moved line count for the commit message.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const acorn = require("acorn");
const escope = require("eslint-scope");

const REPO = path.resolve(__dirname, "..");

function args(argv) {
    const o = { base: null, old: null, root: REPO, cls: null, object: null, files: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--base") o.base = argv[++i];
        else if (a === "--old") o.old = argv[++i];
        else if (a === "--root") o.root = path.resolve(argv[++i]);
        else if (a === "--class") o.cls = argv[++i];
        else if (a === "--object") o.object = argv[++i];
        else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
        else o.files.push(a.replace(/\\/g, "/"));
    }
    if (!o.files.length || (!o.base && !o.old)) throw new Error("usage: split_check.js (--base <commit> | --old <path>) <file> [new files...]");
    return o;
}

const lf = (s) => s.replace(/\r\n/g, "\n");
const lineStart = (text, pos) => text.lastIndexOf("\n", pos - 1) + 1;
const lineEnd = (text, pos) => { const n = text.indexOf("\n", pos); return n < 0 ? text.length : n; };
const lines = (s) => s.split("\n").length;

function parse(text, file) {
    const comments = [];
    const module = /^\s*(import|export)\s/m.test(text);
    let ast;
    try {
        ast = acorn.parse(text, {
            ecmaVersion: "latest", sourceType: module ? "module" : "script", ranges: true, locations: true,
            allowHashBang: true, allowReturnOutsideFunction: !module, onComment: comments,
        });
    } catch (err) {
        throw new Error(`${file}: does not parse: ${err.message}`);
    }
    const sm = escope.analyze(ast, { ecmaVersion: 2022, sourceType: module ? "module" : "script", nodejsScope: !module });
    const g = sm.globalScope;
    const fileScope = g.childScopes.find((s) => s.type === "module" || (!module && s.type === "function")) || g;
    return { file, text, ast, comments, sm, fileScope, module };
}

// ---- units -------------------------------------------------------------------------------------------------------

/** The comments right above `start` (own lines, no blank line between them and the code) as text, and where they begin. */
function leadingComments(p, start, floor) {
    let at = start, out = [];
    for (let i = p.comments.length - 1; i >= 0; i--) {
        const c = p.comments[i];
        if (c.end > at || c.start < floor) continue;
        const between = p.text.slice(c.end, at);
        if (/\S/.test(between) || (between.match(/\n/g) || []).length > 1) break;
        if (/\S/.test(p.text.slice(lineStart(p.text, c.start), c.start))) break;   // a comment at another line's end
        out.unshift(c);
        at = c.start;
    }
    return { at, comments: out };
}

/** A unit's text: its attached comments, then the code from its line's start, then a comment at its last line's end. */
function unitText(p, node, floor, strip, prop) {
    const lead = leadingComments(p, node.start, floor);
    const from = lineStart(p.text, lead.at);
    const end = node.end;
    const rest = p.text.slice(end, lineEnd(p.text, end));
    // an object property's comma may come or go (the last one of a part, a former last one)
    let tail = "";
    if ((prop ? /^,?\s*(\/\/.*|\/\*.*\*\/\s*)?$/ : /^\s*(\/\/.*|\/\*.*\*\/\s*)?$/).test(rest)) tail = prop ? rest.replace(/^,/, "") : rest;
    let t = p.text.slice(from, end) + tail;
    if (strip) {
        // `export ` in front of a top-level declaration may come or go
        const k = strip - from;
        t = t.slice(0, k) + t.slice(k).replace(/^export\s+/, "");
    }
    return { text: t.replace(/[ \t]+$/gm, ""), from, end, used: new Set(lead.comments) };
}

function idNames(pat, out = []) {
    if (!pat) return out;
    if (pat.type === "Identifier") out.push(pat.name);
    else if (pat.type === "ObjectPattern") pat.properties.forEach((q) => idNames(q.type === "RestElement" ? q.argument : q.value, out));
    else if (pat.type === "ArrayPattern") pat.elements.forEach((e) => idNames(e, out));
    else if (pat.type === "RestElement") idNames(pat.argument, out);
    else if (pat.type === "AssignmentPattern") idNames(pat.left, out);
    return out;
}

function memberKey(p, m) {
    const name = m.computed ? `[${p.text.slice(m.key.start, m.key.end)}]` : (m.key.type === "PrivateIdentifier" ? "#" + m.key.name : (m.key.name ?? String(m.key.value)));
    if (m.type === "StaticBlock") return "static {}";
    return `${m.static ? "static " : ""}${m.kind === "get" || m.kind === "set" ? m.kind + " " : ""}${name}`;
}

const isBindFn = (d) => d.type === "FunctionDeclaration" && /^bind[A-Z$_]/.test(d.id.name) && d.params.length === 1 && d.params[0].type === "Identifier"
    && d.body.body.length === 1 && d.body.body[0].type === "ExpressionStatement" && d.body.body[0].expression.type === "AssignmentExpression"
    && d.body.body[0].expression.operator === "=" && d.body.body[0].expression.left.type === "Identifier"
    && d.body.body[0].expression.right.type === "Identifier" && d.body.body[0].expression.right.name === d.params[0].name;
const isBindLet = (d) => d.type === "VariableDeclaration" && d.kind === "let" && d.declarations.length === 1 && d.declarations[0].id.type === "Identifier"
    && d.declarations[0].init && d.declarations[0].init.type === "Literal" && d.declarations[0].init.value === null;
const isRequireCall = (e) => e && e.type === "CallExpression" && e.callee.type === "Identifier" && e.callee.name === "require" && e.arguments.length === 1 && e.arguments[0].type === "Literal" && typeof e.arguments[0].value === "string";
const isRequireDecl = (s) => s.type === "VariableDeclaration" && s.declarations.every((v) => v.init && (isRequireCall(v.init) || (v.init.type === "MemberExpression" && !v.init.computed && isRequireCall(v.init.object)))
    && (v.id.type === "Identifier" || (v.id.type === "ObjectPattern" && v.id.properties.every((q) => q.type === "Property" && !q.computed && q.value.type === "Identifier"))));
const isModuleExports = (s) => s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" && s.expression.operator === "="
    && s.expression.left.type === "MemberExpression" && !s.expression.left.computed && s.expression.left.object.name === "module" && s.expression.left.property.name === "exports"
    && s.expression.right.type === "ObjectExpression" && s.expression.right.properties.every((q) => q.type === "Property" && !q.computed);
const callName = (s) => s.type === "ExpressionStatement" && s.expression.type === "CallExpression" && s.expression.callee.type === "Identifier" ? s.expression.callee.name : null;

/**
 * The units of a parsed file. ctx.oldNames: the old file's top-level names (null for the old file itself);
 * ctx.target: the class part classes belong to; ctx.object: the top-level object literal split into its properties
 * (--object). Returns { units, extra, parts, bindFns, lets, installs, bindCalls, spreads, imports, exports, used }.
 */
function unitsOf(p, ctx, isMain) {
    const oldClasses = ctx.oldNames, target = ctx.target;
    const out = { units: [], extra: [], parts: [], bindFns: [], lets: [], installs: [], bindCalls: [], spreads: null, imports: [], exports: new Set(), used: new Set() };
    let partName = null;
    const add = (key, node, floor, strip, cls, prop) => {
        const u = unitText(p, node, floor, strip, prop);
        u.used.forEach((c) => out.used.add(c));
        out.units.push({ key, text: u.text, start: node.start, end: node.end, file: p.file, cls, part: partName });
    };
    let prev = 0;
    for (const s of p.ast.body) {
        const floor = prev;
        prev = s.end;
        if (s.type === "ImportDeclaration") {
            out.imports.push({ source: s.source.value, names: s.specifiers.map((x) => (x.imported ? (x.imported.name ?? x.imported.value) : x.type === "ImportDefaultSpecifier" ? "default" : "*")), locals: s.specifiers.map((x) => x.local.name) });
            continue;
        }
        if (s.type === "ExportNamedDeclaration" && !s.declaration) {
            s.specifiers.forEach((x) => out.exports.add(x.exported.name ?? x.exported.value));
            continue;
        }
        if (s.type === "ExportAllDeclaration") { out.exports.add("*" + s.source.value); continue; }
        if (s.type === "ExpressionStatement" && s.directive) continue;   // "use strict" heads every file
        // CommonJS: `const x = require("...")`, `const { a, b: c } = require("...")` are imports, `module.exports = {...}` an export list
        if (!p.module && isRequireDecl(s)) {
            for (const v of s.declarations) {
                const call = v.init.type === "MemberExpression" ? v.init.object : v.init;
                const member = v.init.type === "MemberExpression" ? (v.init.property.name ?? v.init.property.value) : null;
                if (v.id.type === "ObjectPattern") out.imports.push({ source: call.arguments[0].value, names: v.id.properties.map((q) => q.key.name ?? q.key.value), locals: v.id.properties.map((q) => q.value.name) });
                else out.imports.push({ source: call.arguments[0].value, names: [member || "*"], locals: [v.id.name] });
            }
            continue;
        }
        if (!p.module && isModuleExports(s)) {
            s.expression.right.properties.forEach((q) => out.exports.add(q.key.name ?? q.key.value));
            continue;
        }
        const d = s.type === "ExportNamedDeclaration" ? s.declaration : s.type === "ExportDefaultDeclaration" ? s.declaration : s;
        const strip = s !== d && s.type === "ExportNamedDeclaration" ? s.start : 0;
        if (s.type === "ExportDefaultDeclaration") { out.exports.add("default"); add("default", s, floor, 0); continue; }
        if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") { if (strip) out.exports.add(d.id.name); }
        if (d.type === "VariableDeclaration" && strip) d.declarations.forEach((v) => idNames(v.id).forEach((n) => out.exports.add(n)));

        if (oldClasses && isBindLet(d) && oldClasses.has(d.declarations[0].id.name) && !isMain) { out.lets.push(d.declarations[0].id.name); continue; }
        if (oldClasses && isBindFn(d) && !isMain) { out.bindFns.push({ name: d.id.name, sets: d.body.body[0].expression.left.name }); continue; }
        if (oldClasses && isMain && callName(s) === "installParts") {
            const [t, list] = s.expression.arguments;
            out.installs.push({ target: t && t.type === "Identifier" ? t.name : null, parts: list && list.type === "ArrayExpression" ? list.elements.map((e) => (e && e.type === "Identifier" ? e.name : null)) : null });
            continue;
        }
        if (oldClasses && isMain && /^bind[A-Z$_]/.test(callName(s) || "")) {
            const a = s.expression.arguments;
            out.bindCalls.push({ fn: callName(s), arg: a.length === 1 && a[0].type === "Identifier" ? a[0].name : null });
            continue;
        }
        if (d.type === "ClassDeclaration") {
            const name = d.id.name;
            const part = oldClasses && !oldClasses.has(name) && /Part$/.test(name);
            if (part) {
                if (d.superClass) out.extra.push({ file: p.file, what: `part class ${name} extends another class` });
                out.parts.push({ name, file: p.file });
            } else {
                // the header, from its line's start to the body's brace
                const u = unitText(p, { start: d.start, end: d.body.start + 1 }, floor, strip);
                u.used.forEach((c) => out.used.add(c));
                out.units.push({ key: `class ${name}`, text: u.text, start: d.start, end: d.body.start + 1, file: p.file });
            }
            const owner = part ? target : name;
            let mprev = d.body.start + 1;
            for (const m of d.body.body) {
                const mfloor = mprev;
                mprev = m.end;
                const key = memberKey(p, m);
                if (part) {
                    if (m.type === "PropertyDefinition" || m.type === "StaticBlock") out.extra.push({ file: p.file, what: `part class ${name} has a field or a static block (${key})` });
                    else if (m.static) out.extra.push({ file: p.file, what: `part class ${name} has a static member (${key}); statics stay in the class` });
                    else if (m.kind === "constructor") { out.extra.push({ file: p.file, what: `part class ${name} has a constructor` }); continue; }
                }
                add(`${owner}.${key}`, m, mfloor, 0, owner);
            }
            continue;
        }
        if (d.type === "FunctionDeclaration") { add(d.id.name, s, floor, strip); continue; }
        if (d.type === "VariableDeclaration" && ctx.object && d.declarations.length === 1 && d.declarations[0].id.type === "Identifier"
            && d.declarations[0].init && d.declarations[0].init.type === "ObjectExpression") {
            const name = d.declarations[0].id.name, obj = d.declarations[0].init;
            const part = oldClasses && !oldClasses.has(name) && /Part$/.test(name);
            if (name === ctx.object || part) {
                if (part) out.parts.push({ name, file: p.file, object: true });
                else {
                    const u = unitText(p, { start: s.start, end: obj.start + 1 }, floor, strip);
                    u.used.forEach((c) => out.used.add(c));
                    out.units.push({ key: `object ${name}`, text: u.text, start: s.start, end: obj.start + 1, file: p.file });
                    // the closing brace and what follows it on its line
                    out.units.push({ key: `object ${name} end`, text: p.text.slice(lineStart(p.text, obj.end - 1), lineEnd(p.text, s.end)).replace(/[ \t]+$/gm, ""), start: obj.end - 1, end: s.end, file: p.file });
                }
                const owner = ctx.object;
                partName = part ? name : null;
                if (name === ctx.object && oldClasses) out.spreads = [];
                let mprev = obj.start + 1;
                for (const m of obj.properties) {
                    const mfloor = mprev;
                    mprev = m.end;
                    if (m.type === "SpreadElement") {
                        if (oldClasses && name === ctx.object && m.argument.type === "Identifier") { out.spreads.push({ part: m.argument.name }); continue; }
                        add(`${owner}....${p.text.slice(m.argument.start, m.argument.end)}`, m, mfloor, 0, owner, true);
                        continue;
                    }
                    const key = `${owner}.${memberKey(p, m)}`;
                    if (out.spreads) out.spreads.push({ key });
                    add(key, m, mfloor, 0, owner, true);
                }
                partName = null;
                continue;
            }
        }
        if (d.type === "VariableDeclaration") { add(d.declarations.map((v) => idNames(v.id).join(",")).join(","), s, floor, strip); continue; }
        add("statement: " + p.text.slice(s.start, s.end).replace(/\s+/g, " ").slice(0, 120), s, floor, 0);
    }
    return out;
}

// ---- free names ----------------------------------------------------------------------------------------------------

/** For each reference inside [start, end): "file" when it resolves to the file's top level (or a class's own name), "global" when nothing in the file declares it. */
function freeNames(p, start, end) {
    const out = new Map();
    for (const sc of p.sm.scopes) {
        for (const r of sc.references) {
            const id = r.identifier;
            if (id.start < start || id.end > end) continue;
            let kind = null;
            const v = r.resolved;
            if (!v) kind = "global";
            else if (v.scope === p.fileScope || (v.scope.type === "global" && p.fileScope === v.scope)) kind = "file";
            else if (v.scope.type === "class" && v.defs.some((d) => d.type === "ClassName")) kind = "file";
            if (kind && !out.has(id.name)) out.set(id.name, kind);
        }
    }
    return out;
}

// ---- main ----------------------------------------------------------------------------------------------------------

function family(root, rel) {
    const dir = path.dirname(path.join(root, rel)), base = path.basename(rel);
    const prefix = base.replace(/[_.].*$/, "") + "_";
    const relDir = path.relative(root, dir).replace(/\\/g, "/");
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { names = []; }
    return names.filter((n) => n !== base && n.startsWith(prefix) && n.endsWith(".js")).sort().map((n) => (relDir ? relDir + "/" : "") + n);
}

function resolveImport(fromRel, spec) {
    if (!spec.startsWith(".")) return null;
    const f = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    return /\.[cm]?js$/.test(f) ? f : f + ".js";   // a CommonJS require may leave out the extension
}

function run(o) {
    const main = o.files[0];
    const read = (rel) => lf(fs.readFileSync(path.join(o.root, rel), "utf8"));
    const oldText = o.old ? lf(fs.readFileSync(o.old, "utf8")) : lf(execFileSync("git", ["-C", o.root, "show", `${o.base}:${main}`], { encoding: "utf8", maxBuffer: 256 << 20 }));
    let news = o.files.slice(1);
    if (!news.length && o.base) {
        news = family(o.root, main).filter((f) => {
            try { execFileSync("git", ["-C", o.root, "cat-file", "-e", `${o.base}:${f}`], { stdio: "ignore" }); return false; } catch (_) { return true; }
        });
    }
    const problems = [], notes = [];
    const old = parse(oldText, `${main} (old)`);
    const oldU = unitsOf(old, { oldNames: null, target: null, object: o.object }, true);
    const decls = old.ast.body.map((s) => (s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration" ? s.declaration : s)).filter(Boolean);
    const classes = decls.filter((d) => d.type === "ClassDeclaration");
    const oldNames = new Set(decls.flatMap((d) => (d.type === "VariableDeclaration" ? d.declarations.flatMap((v) => idNames(v.id)) : d.id ? [d.id.name] : [])));
    const target = o.cls || (classes.slice().sort((a, b) => b.end - b.start - (a.end - a.start))[0] || {}).id?.name || null;
    if (o.object && !oldU.units.some((u) => u.key === `object ${o.object}`)) throw new Error(`--object ${o.object}: no top-level object literal of that name in the old file`);

    const parsed = [main, ...news].map((f) => parse(read(f), f));
    const got = parsed.map((p, i) => unitsOf(p, { oldNames, target, object: o.object }, i === 0));
    const mainU = got[0];

    // every old unit once, same text
    const where = new Map();
    got.forEach((g) => g.units.forEach((u) => { if (!where.has(u.key)) where.set(u.key, []); where.get(u.key).push(u); }));
    const seenOld = new Map();
    let moved = 0;
    const perFile = new Map();
    const pairs = [];
    for (const u of oldU.units) {
        const n = (seenOld.get(u.key) || 0) + 1;
        seenOld.set(u.key, n);
        const at = (where.get(u.key) || []);
        if (n > 1) { problems.push(`${u.key}: twice in the old file; the check cannot tell the two apart`); continue; }
        if (!at.length) { problems.push(`${u.key}: in the old file, found in none of ${[main, ...news].join(", ")}`); continue; }
        if (at.length > 1) { problems.push(`${u.key}: found ${at.length} times (${at.map((x) => x.file).join(", ")})`); continue; }
        const v = at[0];
        if (v.text !== u.text) {
            const a = u.text.split("\n"), b = v.text.split("\n");
            let i = 0;
            while (i < a.length && i < b.length && a[i] === b[i]) i++;
            problems.push(`${u.key}: the text differs in ${v.file}, its line ${i + 1}: old ${JSON.stringify((a[i] ?? "<end>").slice(0, 100))} | new ${JSON.stringify((b[i] ?? "<end>").slice(0, 100))}`);
            continue;
        }
        pairs.push([u, v]);
        if (v.file !== main) {
            moved += lines(u.text);
            const f = perFile.get(v.file) || { units: 0, lines: 0 };
            f.units++; f.lines += lines(u.text);
            perFile.set(v.file, f);
        }
    }
    for (const [key, at] of where) if (!seenOld.has(key)) at.forEach((u) => problems.push(`${key}: new in ${u.file} (only imports, export lists, part classes, the bind form and install calls may be added)`));
    got.forEach((g) => g.extra.forEach((x) => problems.push(`${x.file}: ${x.what}`)));

    // part classes: imported by main, installed onto the target; the bind form wired
    const parts = got.flatMap((g) => g.parts);
    const mainImports = new Map();   // local name -> resolved file
    for (const im of mainU.imports) im.locals.forEach((l, i) => mainImports.set(l, { file: resolveImport(main, im.source), name: im.names[i] }));
    const installed = new Map();
    for (const ins of mainU.installs) {
        if (!ins.target || !ins.parts) { problems.push(`${main}: an installParts call that is not installParts(<Class>, [<parts>])`); continue; }
        if (ins.target !== target && ins.target !== o.object) problems.push(`${main}: installParts onto ${ins.target}, the parts belong to ${[target, o.object].filter(Boolean).join(" or ")}`);
        ins.parts.forEach((n) => { if (!n) problems.push(`${main}: installParts lists something that is no name`); else if (installed.has(n)) problems.push(`${main}: ${n} installed twice`); else installed.set(n, ins.target); });
    }
    for (const pt of parts) {
        const im = mainImports.get(pt.name);
        if (!im || im.file !== pt.file || im.name !== pt.name) problems.push(`${pt.file}: part class ${pt.name} is not imported by ${main} from it`);
        const spread = pt.object && (mainU.spreads || []).some((x) => x.part === pt.name);
        if (!installed.has(pt.name) && !spread) problems.push(`${pt.file}: part ${pt.name} is not installed by ${main}${pt.object ? ` nor spread into ${o.object}` : ""}`);
        else if (installed.has(pt.name) && spread) problems.push(`${main}: part ${pt.name} is both installed and spread`);
        else if (installed.has(pt.name) && installed.get(pt.name) !== (pt.object ? o.object : target)) problems.push(`${main}: part ${pt.name} installed onto ${installed.get(pt.name)}, it belongs to ${pt.object ? o.object : target}`);
        if (!got.find((g, i) => parsed[i].file === pt.file).exports.has(pt.name)) problems.push(`${pt.file}: part class ${pt.name} is not exported`);
    }
    for (const n of installed.keys()) if (!parts.some((pt) => pt.name === n)) problems.push(`${main}: installs ${n}, which is no part of the split`);
    for (const x of mainU.spreads || []) if (x.part && !parts.some((pt) => pt.object && pt.name === x.part)) problems.push(`${main}: spreads ${x.part} into ${o.object}, which is no part of the split`);
    // spread parts keep the key order (COMMANDS: describe(), the MCP list and docs/COMMANDS.md follow it)
    if (o.object && (mainU.spreads || []).some((x) => x.part)) {
        const keysOf = (file, name) => got.find((g, i) => parsed[i].file === file).units.filter((u) => u.cls === o.object && u.part === name).map((u) => u.key);
        const now = mainU.spreads.flatMap((x) => (x.key ? [x.key] : keysOf((parts.find((pt) => pt.name === x.part) || {}).file, x.part)));
        const before = oldU.units.filter((u) => u.cls === o.object).map((u) => u.key);
        const i = before.findIndex((k, j) => now[j] !== k);
        if (i >= 0 || now.length !== before.length) problems.push(`${o.object}: the key order changed at ${i >= 0 ? i : before.length}: before ${before[i]}, now ${now[i]}`);
    }
    got.forEach((g, i) => {
        const f = parsed[i].file;
        for (const l of g.lets) if (!g.bindFns.some((b) => b.sets === l)) problems.push(`${f}: let ${l} = null with no bind function that sets it`);
        for (const b of g.bindFns) {
            if (!g.lets.includes(b.sets)) problems.push(`${f}: ${b.name} sets ${b.sets}, which the file does not declare as let ${b.sets} = null`);
            const im = mainImports.get(b.name);
            const call = mainU.bindCalls.find((c) => c.fn === b.name);
            if (!im || im.file !== f) problems.push(`${f}: ${b.name} is not imported by ${main} from it`);
            else if (!call || call.arg !== b.sets) problems.push(`${main}: ${b.name}(${b.sets}) is not called`);
            if (!g.exports.has(b.name)) problems.push(`${f}: ${b.name} is not exported`);
        }
    });
    for (const c of mainU.bindCalls) if (!got.some((g) => g.bindFns.some((b) => b.name === c.fn))) problems.push(`${main}: calls ${c.fn}, which no new file declares as a bind function`);

    // no new file imports the main file
    parsed.slice(1).forEach((p, i) => {
        for (const im of got[i + 1].imports) if (resolveImport(p.file, im.source) === main) problems.push(`${p.file}: imports ${main} (a part or leaf never does)`);
    });

    // exports kept
    const oldExports = new Set([...oldU.exports]);
    for (const n of oldExports) if (!mainU.exports.has(n)) problems.push(`${main}: no longer exports ${n} (its importers would change)`);

    // free names mean what they meant
    const byFile = new Map(parsed.map((p) => [p.file, p]));
    let free = 0;
    for (const [u, v] of pairs) {
        const a = freeNames(old, u.start, u.end), b = freeNames(byFile.get(v.file), v.start, v.end);
        for (const [name, kind] of a) {
            free++;
            const now = b.get(name);
            if (now === kind) continue;
            if (kind === "file") problems.push(`${u.key}: ${name} was the old file's own binding, in ${v.file} it is ${now === "global" ? "a global (a missing import?)" : "something else"}`);
            else problems.push(`${u.key}: ${name} was a global, in ${v.file} it is ${now === "file" ? "the file's own binding (an import or declaration that shadows it)" : "something else"}`);
        }
    }

    // stand-alone comments that are gone (a note only)
    const keepNow = new Set(parsed.flatMap((p) => p.comments.map((c) => p.text.slice(c.start, c.end))));
    for (const c of old.comments) {
        if (oldU.used.has(c)) continue;
        const t = old.text.slice(c.start, c.end);
        if (!keepNow.has(t)) notes.push(`a stand-alone comment of the old file is gone: ${JSON.stringify(t.slice(0, 90))}`);
    }

    // the prototype's member names
    const protoOld = !target ? [] : oldU.units.filter((u) => u.cls === target && !/^static /.test(u.key.slice(target.length + 1))).map((u) => u.key).sort();
    const protoNew = !target ? [] : got.flatMap((g) => g.units).filter((u) => u.cls === target && !/^static /.test(u.key.slice(target.length + 1))).map((u) => u.key).sort();
    if (target && JSON.stringify(protoOld) !== JSON.stringify(protoNew)) problems.push(`${target}.prototype: ${protoOld.length} members before, ${protoNew.length} after the install`);

    return { main, news, problems, notes, moved, perFile, target, protoCount: protoNew.length, units: oldU.units.length, free };
}

if (require.main === module) {
    let r;
    try {
        r = run(args(process.argv.slice(2)));
    } catch (err) {
        console.error("split_check: " + err.message);
        process.exit(2);
    }
    for (const [f, n] of r.perFile) console.log(`  ${f}: ${n.units} units, ${n.lines} lines`);
    for (const n of r.notes.slice(0, 20)) console.log("  note: " + n);
    if (r.notes.length > 20) console.log(`  note: ... ${r.notes.length - 20} more`);
    for (const p of r.problems.slice(0, 60)) console.log("  PROBLEM: " + p);
    if (r.problems.length > 60) console.log(`  PROBLEM: ... ${r.problems.length - 60} more`);
    console.log(`${r.main}: ${r.units} units, ${r.moved} lines moved into ${r.news.length} new file(s); ${r.target ? `${r.target}.prototype ${r.protoCount} members; ` : ""}${r.free} free names checked; ${r.problems.length ? `FAIL (${r.problems.length} problems)` : "PASS"}`);
    process.exit(r.problems.length ? 1 : 0);
}

module.exports = { run };
