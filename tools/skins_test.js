// The skins (docs/SKINS.md) in plain Node, no app: the first step of tools/skins_test.py.
//
//  1. every var(--sc-*) in the app's sources names a token of the contract and has a fallback;
//  2. no --sc-* token is declared by the app (only a skin declares tokens; renderer/skins.js may only
//     neutralise one with setProperty(name, "initial", ...));
//  3. the ask-card rules (.as-ask, .as-reason) read no var();
//  4. index.html links protect.css first and #skin-css after help.css, and protect.css is an anonymous
//     first layer that names no layer but its closing `@layer app;`;
//  5. shell.css, assistant.css and help.css are one `@layer app { ... }` each;
//  6. the brush ring and the marching ants read no THEME colour;
//  7. the assistant's askCard() hands its card to protectAsk(), answer() releases it, and ASK_CSS reads no token and
//     names no font a skin could redefine;
//  8. the token table of docs/SKINS.md names exactly the tokens of renderer/editor/inpaint_theme.js;
//  9. every shipped skin (plugins/skin_*): a valid manifest, every token declared once on :root and of its
//     kind, nothing loaded from outside its folder, no JavaScript, none of the names it must not carry;
// 10. electron/main/skins.js: readSkinManifest, activeSkin, sheetFor, backgroundFor and SKIN_FILE_RE.
//
// With --base <commit> it also runs the byte proof (design §6a, once, at review): every tokenized source,
// with the layer wrapper stripped and each var(--sc-X, FALLBACK) replaced by FALLBACK, equals the base
// commit's text byte for byte, and THEME_DEFAULTS equals the literals the base drew with. Line numbers of
// that proof are 66285e0's.
//
//   node tools/skins_test.js [--base 66285e0]
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const BASE = arg("--base");

let failed = 0;
function check(name, fn) {
    try {
        const note = fn();
        console.log("[ok] " + name + (note ? ": " + note : ""));
    } catch (err) {
        failed++;
        console.log("[FAIL] " + name + ": " + (err && err.message ? err.message : err));
    }
}
function eq(a, b, what) {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error(`${what || "value"}: ${x} instead of ${y}`);
}
const lf = (s) => s.replace(/\r\n/g, "\n");
const read = (rel) => lf(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// ---- the contract (version 1): names and kinds; tokens may be added later, never removed or renamed ----------

const V1 = [
    ["bg", "color"], ["chrome", "color"], ["chrome-edge", "color"], ["surface", "color"], ["raised", "color"], ["selected", "color"],
    ["well", "color"], ["field", "color"], ["btn", "color"], ["btn-hover", "color"], ["border", "color"], ["line", "color"],
    ["fg-strong", "color"], ["fg", "color"], ["fg-2", "color"], ["muted", "color"], ["faint", "color"], ["accent", "color"],
    ["active", "color"], ["active-bg", "color"], ["on-active", "color"], ["go", "color"], ["warn", "color"], ["ok", "color"],
    ["error", "color"], ["error-bg", "color"], ["link", "color"], ["backdrop", "color"], ["shadow", "shadow"], ["scheme", "scheme"],
    ["control", "control"], ["scrollbar", "scrollbar"], ["font", "font"], ["font-mono", "font"], ["radius-sm", "radius"],
    ["radius", "radius"], ["radius-lg", "radius"],
].map(([n, kind]) => ({ name: "--sc-" + n, kind }));

// ---- small parsers ----------------------------------------------------------------------------------------

const stripCssComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "");

/** A CSS text as a tree: blocks of at-rules with children, style rules with a body, and statements. */
function cssTree(text) {
    text = stripCssComments(text);
    const top = [];
    const walk = (i, list) => {
        let start = i;
        while (i < text.length) {
            const c = text[i];
            if (c === '"' || c === "'") { const j = text.indexOf(c, i + 1); i = j < 0 ? text.length : j + 1; continue; }
            if (c === "{") {
                const prelude = text.slice(start, i).trim();
                if (/^@(layer|media|supports|container|scope|document)\b/.test(prelude)) {
                    const children = [];
                    i = walk(i + 1, children);
                    list.push({ prelude, children });
                } else {
                    let depth = 1, j = i + 1;
                    while (j < text.length && depth) {
                        const d = text[j];
                        if (d === '"' || d === "'") { const k = text.indexOf(d, j + 1); j = k < 0 ? text.length : k + 1; continue; }
                        if (d === "{") depth++; else if (d === "}") depth--;
                        j++;
                    }
                    list.push({ prelude, body: text.slice(i + 1, j - 1) });
                    i = j;
                }
                start = i;
                continue;
            }
            if (c === "}") return i + 1;
            if (c === ";") { const s = text.slice(start, i).trim(); if (s) list.push({ prelude: s, statement: true }); start = i + 1; }
            i++;
        }
        const rest = text.slice(start).trim();
        if (rest) list.push({ prelude: rest, statement: true, unterminated: true });
        return i;
    };
    walk(0, top);
    return top;
}
function* styleRules(list) {
    for (const r of list) {
        if (r.children) yield* styleRules(r.children);
        else if (r.body !== undefined && !r.prelude.startsWith("@")) yield r;
    }
}
/** Split at a separator outside parentheses and quotes. */
function splitTop(s, sep) {
    const out = [];
    let depth = 0, q = null, cur = "";
    for (const c of s) {
        if (q) { cur += c; if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; cur += c; continue; }
        if (c === "(") depth++;
        else if (c === ")") depth--;
        if (depth === 0 && (sep === " " ? /\s/.test(c) : c === sep)) { out.push(cur); cur = ""; continue; }
        cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter((x, i, a) => x !== "" || (sep !== " " && a.length > 1));
}
function declarations(body) {
    return splitTop(body, ";").filter(Boolean).map((d) => {
        const k = d.indexOf(":");
        return k < 0 ? { prop: d.trim(), value: "" } : { prop: d.slice(0, k).trim(), value: d.slice(k + 1).trim() };
    });
}

/** Every var(--sc-...) in a text: { name, fallback, spaced } (fallback null when there is none). */
function varsOf(text) {
    const out = [];
    let i = 0;
    for (;;) {
        const j = text.indexOf("var(--sc-", i);
        if (j < 0) break;
        let k = j + 4, depth = 1, comma = -1;
        for (; k < text.length && depth > 0; k++) {
            const c = text[k];
            if (c === "(") depth++;
            else if (c === ")") { depth--; if (depth === 0) break; }
            else if (c === "," && depth === 1 && comma < 0) comma = k;
        }
        const name = text.slice(j + 4, comma < 0 ? k : comma).trim();
        out.push({ name, fallback: comma < 0 ? null : text.slice(comma + 1, k).trim(), spaced: comma >= 0 && text[comma + 1] === " " && text[comma + 2] !== " " });
        i = k + 1;
    }
    return out;
}
/** Replace var(--sc-x, fb) by fb (the byte proof's substitution: comma, one space, then the fallback verbatim). */
function substitute(text) {
    let out = "", i = 0;
    for (;;) {
        const j = text.indexOf("var(--sc-", i);
        if (j < 0) { out += text.slice(i); break; }
        out += text.slice(i, j);
        let k = j + 4, depth = 1, comma = -1;
        for (; k < text.length && depth > 0; k++) {
            const c = text[k];
            if (c === "(") depth++;
            else if (c === ")") { depth--; if (depth === 0) break; }
            else if (c === "," && depth === 1 && comma < 0) comma = k;
        }
        out += comma < 0 ? "<NOFALLBACK>" : text.slice(comma + 2, k);
        i = k + 1;
    }
    return out;
}

/** The body of a method or function, from the `{` after its parameters to the matching `}`. */
function bodyOf(js, head) {
    const at = js.search(head);
    if (at < 0) return null;
    const open = js.indexOf("{", js.indexOf(")", at));
    let depth = 0;
    for (let i = open; i < js.length; i++) {
        const c = js[i];
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) return js.slice(open, i + 1); }
    }
    return null;
}
const styleOf = (js) => { const m = js.match(/\n(?:export )?const STYLE = `\n([\s\S]*?)\n`;\n/); return m ? m[1] : null; };
const glbCss = (js) => { const m = js.match(/\nconst CSS = `\n([\s\S]*?)\n`;\n/); return m ? m[1] : null; };
const curvesBits = (js) => js.split("\n").filter((l) => /cssText =|style\.background = on|style\.color = on/.test(l)).join("\n");
const shellJsBits = (js) => js.split("\n").filter((l) => /recipeNote\.style\.color/.test(l)).join("\n");

function walkFiles(dir, filter, out = []) {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const d of names) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) { if (d.name !== "vendor" && d.name !== "node_modules" && d.name !== "px") walkFiles(p, filter, out); }
        else if (filter(d.name)) out.push(p);
    }
    return out;
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

// ---- value checks per token kind (what CSS.supports decides in the app) -----------------------------------

const NAMED = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue "
    + "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki "
    + "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise "
    + "darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod "
    + "gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue "
    + "lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray "
    + "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple "
    + "mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite "
    + "navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink "
    + "plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue "
    + "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow "
    + "yellowgreen transparent currentcolor").split(" "));
const isColor = (v) => {
    v = v.trim().toLowerCase();
    if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) return true;
    if (NAMED.has(v)) return true;
    const m = v.match(/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\((.*)\)$/);
    return !!(m && m[2].trim() && !/[;{}]/.test(m[2]));
};
const isLength = (v) => /^-?(\d+(\.\d+)?|\.\d+)(px|em|rem|%|pt|ch|ex|vh|vw|vmin|vmax)$/.test(v) || /^-?0(\.0+)?$/.test(v);
const isFont = (v) => splitTop(v, ",").every((f) => /^("[^"]+"|'[^']+'|[A-Za-z_-][A-Za-z0-9_ -]*)$/.test(f) && !/^-?\d/.test(f));
const isRadius = (v) => { const parts = v.split("/").map((p) => p.trim().split(/\s+/)); return parts.length <= 2 && parts.every((p) => p.length >= 1 && p.length <= 4 && p.every(isLength)); };
const isShadow = (v) => v === "none" || splitTop(v, ",").every((s) => {
    const t = splitTop(s, " ");
    const lens = t.filter(isLength), inset = t.filter((x) => x === "inset"), cols = t.filter((x) => !isLength(x) && x !== "inset");
    return lens.length >= 2 && lens.length <= 4 && inset.length <= 1 && cols.length <= 1 && cols.every(isColor);
});
const KIND = {
    color: isColor,
    font: isFont,
    radius: isRadius,
    shadow: isShadow,
    scheme: (v) => v === "normal" || (v.split(/\s+/).every((x) => ["light", "dark", "only"].includes(x)) && v.split(/\s+/).filter((x) => x !== "only").length >= 1),
    control: (v) => v === "auto" || isColor(v),
    scrollbar: (v) => v === "auto" || (splitTop(v, " ").length === 2 && splitTop(v, " ").every(isColor)),
};

const FORBIDDEN = ["winamp", "nullsoft", "webamp", "llama", "microduck", "pollen", "hugging face", "huggingface"];
const FORBIDDEN_90S = ["main.bmp", "cbuttons.bmp", "text.bmp", "viscolor.txt", ".wsz"];

// ---- the checks ---------------------------------------------------------------------------------------------

async function main() {
    let theme = null, skinsMod = null;
    // inpaint_theme.js has no imports: loaded from its text, Node takes it as a module without guessing (no warning)
    try { theme = await import("data:text/javascript;base64," + Buffer.from(read("renderer/editor/inpaint_theme.js")).toString("base64")); } catch (err) { theme = { error: err }; }
    try { skinsMod = require("../electron/main/skins"); } catch (err) { skinsMod = { error: err }; }
    const need = (m, what) => { if (!m || m.error) throw new Error(`${what} cannot be loaded: ${m && m.error ? m.error.message : "missing"}`); return m; };

    check("the_token_list_is_contract_version_1", () => {
        need(theme, "inpaint_theme.js");
        const names = theme.SKIN_TOKENS.map((t) => t.name);
        if (new Set(names).size !== names.length) throw new Error("a token is listed twice");
        for (const t of V1) {
            const got = theme.SKIN_TOKENS.find((x) => x.name === t.name);
            if (!got) throw new Error(`${t.name} is gone (a removed or renamed token bumps the contract version)`);
            if (got.kind !== t.kind) throw new Error(`${t.name} is a ${got.kind}, the contract says ${t.kind}`);
            if (typeof got.default !== "string" || !got.default || !KIND[got.kind](got.default)) throw new Error(`${t.name}: default ${JSON.stringify(got.default)} is not a ${got.kind}`);
        }
        eq(theme.SKIN_TOKENS_VERSION, 1, "SKIN_TOKENS_VERSION");
        for (const [k, tok] of Object.entries(theme.THEME_TOKENS)) {
            if (!names.includes(tok)) throw new Error(`THEME.${k} follows ${tok}, which is no token`);
            if (!(k in theme.THEME_DEFAULTS)) throw new Error(`THEME.${k} has no default`);
        }
        eq(Object.keys(theme.THEME_DEFAULTS).sort(), Object.keys(theme.THEME_TOKENS).sort(), "THEME keys");
        const { version: _version, ...rest } = theme.THEME;
        eq(rest, { ...theme.THEME_DEFAULTS }, "THEME before any refreshTheme()");
        return `${names.length} tokens, ${Object.keys(theme.THEME_DEFAULTS).length} canvas colours`;
    });

    // 1 ----------------------------------------------------------------------------------------------------------
    check("every_var_names_a_token_and_has_a_fallback", () => {
        need(theme, "inpaint_theme.js");
        const names = new Set(theme.SKIN_TOKENS.map((t) => t.name));
        const files = [
            ...walkFiles(path.join(ROOT, "renderer"), (n) => /\.(css|js)$/.test(n)),
            ...walkFiles(path.join(ROOT, "plugins"), (n) => /\.js$/.test(n)),
        ];
        const bad = [], per = {};
        for (const f of files) {
            const vs = varsOf(lf(fs.readFileSync(f, "utf8")));
            if (vs.length) per[rel(f)] = vs.length;
            for (const v of vs) {
                if (!names.has(v.name)) bad.push(`${rel(f)}: unknown token ${v.name}`);
                else if (v.fallback === null || v.fallback === "") bad.push(`${rel(f)}: ${v.name} has no fallback`);
            }
        }
        // the eight sources of the design, each with tokens (skins.js: its swatch chip border)
        const style = styleOf(read("renderer/editor/inpaint_canvas.js"));
        if (!style) throw new Error("no STYLE block in inpaint_canvas.js");
        const sources = { "STYLE": varsOf(style).length };
        for (const f of ["renderer/shell.css", "renderer/assistant.css", "renderer/help.css", "plugins/glb/dialog.js", "renderer/editor/inpaint_curves.js", "renderer/shell.js", "renderer/skins.js"]) sources[f] = per[f] || 0;
        const none = Object.entries(sources).filter(([, n]) => !n).map(([f]) => f);
        if (none.length) bad.push("no var(--sc-*) at all in " + none.join(", "));
        if (bad.length) throw new Error(bad.slice(0, 12).join("; "));
        return Object.entries(sources).map(([f, n]) => `${f.replace(/^.*\//, "")} ${n}`).join(", ");
    });

    // 2 ----------------------------------------------------------------------------------------------------------
    check("the_app_declares_no_token", () => {
        const bad = [];
        const DECL = /--sc-[a-z0-9-]+\s*:/i;
        for (const f of walkFiles(path.join(ROOT, "renderer"), (n) => /\.css$/.test(n))) {
            const m = stripCssComments(lf(fs.readFileSync(f, "utf8"))).match(DECL);
            if (m) bad.push(`${rel(f)} declares ${m[0]}`);
        }
        const js = [
            ...walkFiles(path.join(ROOT, "renderer"), (n) => /\.js$/.test(n)),
            path.join(ROOT, "plugins/glb/dialog.js"),
        ];
        // block comments and whole-line comments out (a doc comment may show an example); code and strings stay
        // (only comments that open a line: "image/*" in a string must not start one)
        const code = (t) => t.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");
        for (const f of js) {
            const t = code(lf(fs.readFileSync(f, "utf8")));
            const m = t.match(DECL);
            if (m) bad.push(`${rel(f)} declares ${m[0]}`);
            if (/setProperty\(\s*["'`]--sc-/.test(t)) bad.push(`${rel(f)} sets a --sc-* token by name`);
            if (rel(f) === "renderer/skins.js") {
                // the one allowed write: a token a skin set to an invalid value goes back to "initial"
                for (const call of t.match(/\.setProperty\(([^)]*)\)/g) || []) {
                    const args = splitTop(call.slice(call.indexOf("(") + 1, -1), ",");
                    if (/^["'`]/.test(args[0])) continue;                 // a named property, not a token
                    if (args[1] !== '"initial"' && args[1] !== "'initial'") bad.push(`renderer/skins.js: ${call} writes a value, not "initial"`);
                }
            }
        }
        if (!exists("renderer/skins.js")) bad.push("renderer/skins.js is missing");
        if (bad.length) throw new Error(bad.join("; "));
        return `${js.length} JS files and the renderer's CSS`;
    });

    // 3 ----------------------------------------------------------------------------------------------------------
    check("the_ask_card_reads_no_token", () => {
        const bad = [];
        let n = 0;
        for (const f of ["renderer/assistant.css", "renderer/protect.css"]) {
            for (const r of styleRules(cssTree(read(f)))) {
                if (!/\.as-ask\b|\.as-reason\b/.test(r.prelude)) continue;
                n++;
                if (/var\(/.test(r.body)) bad.push(`${f}: ${r.prelude} { ${r.body.trim().slice(0, 80)} }`);
            }
        }
        if (n < 3) bad.push(`only ${n} ask-card rules found`);
        if (bad.length) throw new Error(bad.join("; "));
        return `${n} rules`;
    });

    // 4 ----------------------------------------------------------------------------------------------------------
    check("protect_css_comes_first_and_the_skin_last", () => {
        const html = read("renderer/index.html");
        const head = html.slice(0, html.indexOf("</head>"));
        const links = [...head.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).filter((l) => /rel="stylesheet"/.test(l));
        const href = (l) => (l.match(/href="([^"]*)"/) || [])[1];
        const order = links.map(href);
        if (order[0] !== "protect.css") throw new Error("the first stylesheet is " + order[0] + ": " + order.join(", "));
        const skin = links.findIndex((l) => /id="skin-css"/.test(l)), help = order.indexOf("help.css");
        if (skin < 0 || help < 0 || skin < help) throw new Error("#skin-css does not come after help.css: " + order.join(", "));
        if (href(links[skin]) !== "skin.css") throw new Error("#skin-css links " + href(links[skin]));
        const css = stripCssComments(read("renderer/protect.css")).trim();
        if (!/^@layer\s*\{/.test(css)) throw new Error("protect.css does not open with an anonymous @layer {: " + css.slice(0, 40));
        const layers = [...css.matchAll(/@layer\b\s*([^{;]*)([{;])/g)].map((m) => ({ name: m[1].trim(), end: m[2], at: m.index + m[0].length }));
        const named = layers.filter((l) => l.name);
        if (named.length !== 1 || named[0].name !== "app" || named[0].end !== ";") throw new Error("protect.css names these layers: " + JSON.stringify(named.map((l) => l.name + l.end)));
        if (css.slice(named[0].at).trim() !== "") throw new Error("`@layer app;` is not the last statement of protect.css");
        const tree = cssTree(css);
        if (tree.length !== 2 || !tree[0].children || tree[0].prelude !== "@layer" || !tree[1].statement) throw new Error("protect.css is not one anonymous layer and the statement: " + JSON.stringify(tree.map((r) => r.prelude)));
        for (const r of styleRules(tree)) for (const d of declarations(r.body)) if (d.prop && !/!\s*important$/.test(d.value)) throw new Error(`protect.css: ${r.prelude} { ${d.prop}: ${d.value} } is not !important`);
        return order.join(" < ");
    });

    // 5 ----------------------------------------------------------------------------------------------------------
    check("the_app_css_sits_in_layer_app", () => {
        for (const f of ["renderer/shell.css", "renderer/assistant.css", "renderer/help.css"]) {
            const lines = read(f).split("\n");
            while (lines.length && lines[lines.length - 1] === "") lines.pop();
            if (lines[0] !== "@layer app {") throw new Error(`${f}: the first line is ${JSON.stringify(lines[0])}`);
            if (lines[lines.length - 1] !== "}") throw new Error(`${f}: the last line is ${JSON.stringify(lines[lines.length - 1])}`);
            const tree = cssTree(read(f));
            if (tree.length !== 1 || tree[0].prelude !== "@layer app") throw new Error(`${f}: ${tree.length} top-level rules (${tree.map((r) => r.prelude.slice(0, 30)).join(" | ")}), not one @layer app`);
        }
    });

    // 6 ----------------------------------------------------------------------------------------------------------
    check("the_outlines_on_the_picture_follow_no_skin", () => {
        const js = read("renderer/editor/inpaint_canvas.js");
        const out = [];
        for (const name of ["drawBrushRing", "antsStroke", "drawMarchingAnts"]) {
            const b = bodyOf(js, new RegExp(`\\n    ${name}\\(`));
            if (!b) throw new Error(`${name} not found`);
            if (/\bTHEME\b/.test(b)) throw new Error(`${name} reads THEME`);
            if (name === "drawMarchingAnts" && !/antsPattern/.test(b)) throw new Error("the ants pattern is no longer built in drawMarchingAnts");
            out.push(`${name} ${b.split("\n").length} lines`);
        }
        return out.join(", ");
    });

    // 7 ----------------------------------------------------------------------------------------------------------
    check("every_ask_card_is_protected", () => {
        const js = read("renderer/assistant.js");
        if (!/import\s*\{[^}]*\bprotectAsk\b[^}]*\}\s*from\s*["']\.\/skins\.js["']/.test(js)) throw new Error("assistant.js does not import protectAsk from ./skins.js");
        const b = bodyOf(js, /\nfunction askCard\(/);
        if (!b) throw new Error("askCard not found");
        const g = b.indexOf("protectAsk(card)"), r = b.lastIndexOf("return card"), a = b.indexOf("add(card)");
        if (g < 0) throw new Error("askCard does not call protectAsk(card)");
        if (r >= 0 && g > r) throw new Error("protectAsk(card) comes after return card");
        if (a < 0 || a > g) throw new Error("protectAsk(card) comes before the card is in the chat");
        const ans = bodyOf(js, /\nfunction answer\(/);
        if (!ans || !/releaseAsk\(card\)/.test(ans)) throw new Error("answer() does not release the card");
        // the question's own look: no token, no named font (a skin's @font-face could take that name), :host !important
        const m = read("renderer/skins.js").match(/const ASK_CSS = `([^`]*)`/);
        if (!m) throw new Error("renderer/skins.js has no ASK_CSS");
        const css = m[1];
        const vars = [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((x) => x[1]).filter((n) => !/^--ask-/.test(n));
        if (vars.length) throw new Error("ASK_CSS reads " + vars.join(", "));
        const GENERIC = new Set(["system-ui", "sans-serif", "serif", "monospace"]);
        const named = [];
        for (const f of css.matchAll(/\bfont(-family)?\s*:\s*([^;!}]+)/g)) {
            const v = f[2].trim();
            if (v === "inherit") continue;
            const families = f[1] ? v : v.replace(/^.*?\d+px(\/[\d.]+)?\s+/, "");     // the shorthand: size / line-height first
            for (const name of families.split(",").map((x) => x.trim()).filter(Boolean)) if (!GENERIC.has(name)) named.push(name);
        }
        if (named.length) throw new Error("ASK_CSS names fonts a skin could redefine: " + named.join(", "));
        const host = (css.match(/:host\s*\{([^}]*)\}/) || [])[1] || "";
        if (!/all:\s*initial\s*!important/.test(host)) throw new Error(":host does not start from all: initial !important");
        const loose = host.split(";").map((d) => d.trim()).filter((d) => d && !/!important$/.test(d));
        if (loose.length) throw new Error(":host declarations without !important: " + loose.join("; "));
        return `${css.length} bytes of ASK_CSS`;
    });

    // 8 ----------------------------------------------------------------------------------------------------------
    check("docs_skins_md_lists_the_tokens", () => {
        need(theme, "inpaint_theme.js");
        if (!exists("docs/SKINS.md")) throw new Error("docs/SKINS.md is missing");
        const lines = read("docs/SKINS.md").split("\n");
        // the table blocks; the token table is the one naming the most tokens in its first token cell
        const blocks = [];
        let cur = null;
        for (const l of lines) {
            if (/^\s*\|/.test(l)) { if (!cur) blocks.push(cur = []); cur.push(l); } else cur = null;
        }
        let best = [];
        for (const b of blocks) {
            const names = [];
            for (const row of b) {
                const cell = row.split("|").slice(1).find((c) => /`--sc-[a-z0-9-]+`/.test(c));
                if (cell) for (const m of cell.matchAll(/`(--sc-[a-z0-9-]+)`/g)) names.push(m[1]);
            }
            if (names.length > best.length) best = names;
        }
        const want = theme.SKIN_TOKENS.map((t) => t.name);
        if (new Set(best).size !== best.length) throw new Error("the table names a token twice");
        eq([...best].sort(), [...want].sort(), "the token table of docs/SKINS.md");
        return `${best.length} rows`;
    });

    // 9 ----------------------------------------------------------------------------------------------------------
    check("the_shipped_skins_are_valid_and_complete", () => {
        need(theme, "inpaint_theme.js");
        need(skinsMod, "electron/main/skins.js");
        const out = [];
        for (const [id, name] of [["skin_90s", "90s"], ["skin_duck", "Duck"]]) {
            const dir = path.join(ROOT, "plugins", id);
            if (!fs.existsSync(path.join(dir, "plugin.json"))) throw new Error(`plugins/${id}/plugin.json is missing`);
            const m = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
            eq(m.name, name, `${id} name`);
            eq(m.registers, ["skin"], `${id} registers`);
            if ("entry" in m) throw new Error(`${id} names an entry`);
            const r = skinsMod.readSkinManifest(m, dir);
            if (!r || r.error) throw new Error(`${id}: ${r && r.error}`);
            eq(r.kind, "skin", `${id} kind`);
            if ((r.warnings || []).length) throw new Error(`${id} warns: ${r.warnings.join("; ")}`);
            if (!/^#[0-9a-f]{6}$/i.test(r.skin.background)) throw new Error(`${id} background ${r.skin.background}`);
            // the files: plugin.json and the kinds a skin may carry, no code, none of the names
            const files = walkFiles(dir, () => true);
            for (const f of files) {
                const base = path.basename(f), relf = path.relative(dir, f).replace(/\\/g, "/");
                if (base !== "plugin.json" && !skinsMod.SKIN_FILE_RE.test(base)) throw new Error(`${id}/${relf} is not a file a skin may carry`);
                const words = FORBIDDEN.concat(id === "skin_90s" ? FORBIDDEN_90S : []);
                const hay = (relf + "\n" + (/\.(css|json|svg|txt|md)$/i.test(base) ? fs.readFileSync(f, "utf8") : "")).toLowerCase();
                const hit = words.find((w) => hay.includes(w));
                if (hit) throw new Error(`${id}/${relf} carries "${hit}"`);
            }
            if (FORBIDDEN.some((w) => id.toLowerCase().includes(w))) throw new Error(`the folder name ${id}`);
            const css = read(`plugins/${id}/${r.skin.css}`);
            const plain = stripCssComments(css);
            for (const u of plain.matchAll(/url\(\s*["']?\s*([^"')\s]*)/gi)) {
                if (/^(\/\/|[a-z][a-z0-9+.-]*:)/i.test(u[1]) && !/^data:/i.test(u[1])) throw new Error(`${id}: url(${u[1]}) loads from outside the folder`);
            }
            for (const im of plain.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]*)/gi)) {
                if (/^(\/\/|[a-z][a-z0-9+.-]*:)/i.test(im[1])) throw new Error(`${id}: @import ${im[1]} loads from outside the folder`);
            }
            // every token once, on :root, of its kind; no unknown token
            const seen = new Map();
            for (const rule of styleRules(cssTree(css))) {
                for (const d of declarations(rule.body)) {
                    if (!d.prop.startsWith("--sc-")) continue;
                    if (rule.prelude.trim() !== ":root") throw new Error(`${id}: ${d.prop} is declared on ${rule.prelude}, not :root`);
                    if (seen.has(d.prop)) throw new Error(`${id}: ${d.prop} is declared twice`);
                    seen.set(d.prop, d.value.replace(/\s*!\s*important$/i, "").trim());
                }
            }
            for (const t of theme.SKIN_TOKENS) {
                if (!seen.has(t.name)) throw new Error(`${id}: ${t.name} is not declared`);
                if (!KIND[t.kind](seen.get(t.name))) throw new Error(`${id}: ${t.name}: ${JSON.stringify(seen.get(t.name))} is not a ${t.kind}`);
            }
            for (const k of seen.keys()) if (!theme.SKIN_TOKENS.some((t) => t.name === k)) throw new Error(`${id}: ${k} is no token`);
            out.push(`${id} ${seen.size} tokens, ${files.length} files`);
        }
        return out.join("; ");
    });

    // 10 ---------------------------------------------------------------------------------------------------------
    check("the_main_side_reads_skins_as_the_contract_says", () => {
        const S = need(skinsMod, "electron/main/skins.js");
        eq(S.SKIN_TOKENS_VERSION, 1, "SKIN_TOKENS_VERSION");
        if (theme && !theme.error) eq(S.SKIN_TOKENS_VERSION, theme.SKIN_TOKENS_VERSION, "main and renderer agree on the version");
        eq(S.DEFAULT_BACKGROUND, "#181818", "DEFAULT_BACKGROUND");
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-skins-"));
        try {
            const mk = (name, files) => {
                const dir = path.join(tmp, name);
                fs.mkdirSync(dir, { recursive: true });
                for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); }
                return dir;
            };
            const ok = mk("ok", { "skin.css": ":root{--sc-bg:#123456}", "look.css": ":root{}", "sub/in.css": "" });
            const bare = mk("bare", {});
            const good = S.readSkinManifest({ name: "Good", registers: ["skin"] }, ok);
            if (good.error) throw new Error("a plain skin: " + good.error);
            eq({ kind: good.kind, entry: good.entry, enabledByDefault: good.enabledByDefault, skin: good.skin, warnings: good.warnings },
                { kind: "skin", entry: null, enabledByDefault: false, skin: { css: "skin.css", background: "#181818", swatch: [], tokens: 1 }, warnings: [] }, "a plain skin");
            const own = S.readSkinManifest({ registers: ["skin"], skin: { css: "look.css", background: "#2a2c3a", tokens: 1 } }, ok);
            eq([own.error || null, own.skin && own.skin.css, own.skin && own.skin.background], [null, "look.css", "#2a2c3a"], "its own css and background");
            const refused = [
                [{ registers: ["skin"], entry: "main.js" }, ok, /no JavaScript/i, "an entry"],
                [{ registers: ["skin", "filter"] }, ok, /./, "registers more than skin"],
                [{ registers: ["skin"], skin: { css: "../ok/skin.css" } }, ok, /./, "a css path with .."],
                [{ registers: ["skin"], skin: { css: "/skin.css" } }, ok, /./, "an absolute css path"],
                [{ registers: ["skin"], skin: { css: "skin.txt" } }, ok, /./, "a css that is no .css"],
                [{ registers: ["skin"] }, bare, /./, "no skin.css in the folder"],
                [{ registers: ["skin"], skin: { css: "gone.css" } }, ok, /./, "a css file that does not exist"],
                [{ registers: ["skin"], skin: { background: "red" } }, ok, /./, "a background that is no #rrggbb"],
                [{ registers: ["skin"], skin: { background: "#12345" } }, ok, /./, "a five-digit background"],
            ];
            for (const [m, dir, re, what] of refused) {
                const r = S.readSkinManifest(m, dir);
                if (!r || !r.error || !re.test(r.error)) throw new Error(`${what}: ${JSON.stringify(r)}`);
                eq(r.kind, "skin", `${what}: kind`);
            }
            const sub = S.readSkinManifest({ registers: ["skin"], skin: { css: "sub/in.css" } }, ok);
            if (sub.error) throw new Error("a css in a subfolder: " + sub.error);
            const sw = S.readSkinManifest({ registers: ["skin"], skin: { swatch: ["#111111", "red", "#222222", 5, "#33333"] } }, ok);
            eq(sw.skin.swatch, ["#111111", "#222222"], "a swatch keeps its #rrggbb entries");
            const many = ["#010101", "#020202", "#030303", "#040404", "#050505", "#060606", "#070707", "#080808"];
            eq(S.readSkinManifest({ registers: ["skin"], skin: { swatch: many } }, ok).skin.swatch, many.slice(0, 6), "a swatch holds at most six");
            const newer = S.readSkinManifest({ registers: ["skin"], skin: { tokens: 2 } }, ok);
            if (newer.error || !(newer.warnings || []).some((w) => /newer Scumble/.test(w) && /2/.test(w))) throw new Error("a skin for tokens 2: " + JSON.stringify(newer));

            // activeSkin
            const A = { id: "a", kind: "skin", skin: { css: "skin.css" } }, B = { id: "b", kind: "skin", error: "broken" }, P = { id: "p", entry: "main.js" };
            const list = [A, B, P];
            const act = (argv, appearance) => S.activeSkin({ argv, appearance, list });
            const cases = [
                [[], { skin: "", refused: null }, null, "none"],
                [[], { skin: "a", refused: null }, "a", "valid"],
                [[], { skin: "a", refused: { id: "a", reason: "x" } }, null, "refused"],
                [[], { skin: "a", refused: { id: "b", reason: "x" } }, "a", "another skin refused"],
                [[], { skin: "zzz", refused: null }, null, "missing"],
                [[], { skin: "b", refused: null }, null, "an error"],
                [[], { skin: "p", refused: null }, null, "a plugin, no skin"],
                [["electron", ".", "--no-skin"], { skin: "a", refused: null }, null, "--no-skin"],
            ];
            for (const [argv, appearance, want, what] of cases) {
                const got = act(argv, appearance);
                if ((got ? got.id : null) !== want) throw new Error(`activeSkin ${what}: ${JSON.stringify(got)} instead of ${want}`);
            }

            // sheetFor, backgroundFor
            eq(S.sheetFor({ id: "skin_90s", kind: "skin", skin: { css: "skin.css" } }, 123), '@import url("plugins/skin_90s/skin.css?v=123");\n', "sheetFor");
            eq(S.sheetFor({ id: "my skin", kind: "skin", skin: { css: "my look.css" } }, 7), '@import url("plugins/my%20skin/my%20look.css?v=7");\n', "sheetFor, encoded");
            eq(S.sheetFor(null, 123), "/* the default look: no skin */\n", "sheetFor, no skin");
            eq(S.backgroundFor(null), "#181818", "backgroundFor, no skin");
            eq(S.backgroundFor({ id: "a", kind: "skin", skin: { css: "skin.css", background: "#2a2c3a" } }), "#2a2c3a", "backgroundFor");

            // SKIN_FILE_RE: what a skin folder serves
            for (const f of ["skin.css", "a.PNG", "b.jpg", "c.jpeg", "d.webp", "e.gif", "f.svg", "g.woff", "h.woff2", "i.ttf", "j.otf"]) if (!S.SKIN_FILE_RE.test(f)) throw new Error(`SKIN_FILE_RE refuses ${f}`);
            for (const f of ["plugin.json", "main.js", "x.mjs", "x.html", "x.css.map", "css", "x.cssx"]) if (S.SKIN_FILE_RE.test(f)) throw new Error(`SKIN_FILE_RE serves ${f}`);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
        return "readSkinManifest, activeSkin, sheetFor, backgroundFor, SKIN_FILE_RE";
    });

    // (a) the byte proof, once, at review ---------------------------------------------------------------------
    if (BASE) {
        const git = (file) => lf(execFileSync("git", ["-C", ROOT, "show", `${BASE}:${file}`], { encoding: "utf8", maxBuffer: 64 << 20 }));
        const ADDED = "color-scheme: normal; accent-color: auto; scrollbar-color: auto; ";
        const SOURCES = {
            shell: { file: "renderer/shell.css", css: true },
            assistant: { file: "renderer/assistant.css", css: true },
            help: { file: "renderer/help.css", css: true },
            style: { file: "renderer/editor/inpaint_canvas.js", pick: styleOf },
            glb: { file: "plugins/glb/dialog.js", pick: glbCss },
            curves: { file: "renderer/editor/inpaint_curves.js", pick: curvesBits },
            shelljs: { file: "renderer/shell.js", pick: shellJsBits },
        };
        for (const [key, s] of Object.entries(SOURCES)) {
            check(`byte_proof_${key}`, () => {
                const before = s.pick ? s.pick(git(s.file)) : git(s.file);
                let now = s.pick ? s.pick(read(s.file)) : read(s.file);
                if (before === null || now === null) throw new Error("the source block was not found");
                if (s.css) {
                    const lines = now.split("\n");
                    if (lines[0] !== "@layer app {") throw new Error("the first line is not `@layer app {`");
                    lines.shift();
                    while (lines.length && lines[lines.length - 1] === "") lines.pop();
                    if (lines[lines.length - 1] !== "}") throw new Error("the last line is not `}`");
                    lines.pop();
                    now = lines.join("\n") + "\n";
                }
                const vs = varsOf(now);
                const unspaced = vs.filter((v) => !v.spaced);
                if (unspaced.length) throw new Error("a fallback does not follow \", \": " + unspaced.slice(0, 3).map((v) => v.name).join(", "));
                let text = substitute(now);
                if (key === "shell") {
                    if (!text.includes(ADDED)) throw new Error("the three declarations on html, body are missing");
                    text = text.replace(ADDED, "");
                }
                if (text !== before) {
                    const a = before.split("\n"), b = text.split("\n");
                    const diffs = [];
                    for (let i = 0; i < Math.max(a.length, b.length) && diffs.length < 4; i++) if (a[i] !== b[i]) diffs.push(`line ${i + 1}: base ${JSON.stringify(a[i])} | now ${JSON.stringify(b[i])}`);
                    throw new Error(diffs.join("; ") || "differs in trailing text");
                }
                return `${vs.length} var() uses, equal to ${BASE}`;
            });
        }
        check("byte_proof_theme_defaults", () => {
            need(theme, "inpaint_theme.js");
            const canvas = git("renderer/editor/inpaint_canvas.js").split("\n"), curves = git("renderer/editor/inpaint_curves.js").split("\n");
            const lit = (lines, n, i = 0) => {
                const all = [...lines[n - 1].matchAll(/"(#[0-9a-fA-F]{3,8})"/g)].map((m) => m[1]);
                if (all.length <= i) throw new Error(`${BASE} line ${n} holds no colour literal: ${lines[n - 1].trim()}`);
                return all[i];
            };
            const want = {
                rulerBg: [lit(canvas, 2728), lit(canvas, 2763)], rulerEdge: [lit(canvas, 2731)], rulerText: [lit(canvas, 2739)], rulerTick: [lit(canvas, 2740)],
                tipGlyph: [lit(canvas, 4909)], curveBg: [lit(curves, 174), lit(curves, 212, 1)], curveHist: [lit(curves, 181)], curveGrid: [lit(curves, 190)],
                curveDiag: [lit(curves, 198)], curvePoint: [lit(curves, 212, 0)], curveHint: [lit(curves, 217)],
                curveRgb: [(curves[7].match(/rgb:\s*"(#[0-9a-fA-F]+)"/) || [])[1]],
            };
            for (const [k, vals] of Object.entries(want)) for (const v of vals) if (theme.THEME_DEFAULTS[k] !== v) throw new Error(`THEME_DEFAULTS.${k} is ${theme.THEME_DEFAULTS[k]}, ${BASE} drew ${v}`);
            eq(Object.keys(theme.THEME_DEFAULTS).sort(), Object.keys(want).sort(), "THEME_DEFAULTS keys");
            return `${Object.keys(want).length} colours equal to ${BASE}`;
        });
    }

    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
