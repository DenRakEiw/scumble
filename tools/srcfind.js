// Source text of a long file and of the modules split out of it (item 56, docs/PLAN_SPLIT.md).
//
// Tests that read code as text (skins, quit, comfyrouter, ark, genpresets, comfyprompt) find it by name, not by file:
// once a session moves a method or a const into a new module, the test still finds it. A file's family is the file
// itself and every sibling whose name starts with the file's prefix up to its first "_" or ".", plus "_":
//   renderer/editor/inpaint_canvas.js -> renderer/editor/inpaint_*.js
//   renderer/shell.js                 -> renderer/shell_*.js
//   renderer/editor/host.js           -> renderer/editor/host_*.js
//   electron/main/recipes.js          -> electron/main/recipes_*.js
// Every module split out of one of the five long files is named that way (PLAN_SPLIT.md §2).
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const lf = (s) => s.replace(/\r\n/g, "\n");

/** The family's files, repo-relative with "/", the named file first, the rest sorted. */
function family(rel) {
    const abs = path.join(ROOT, rel);
    const dir = path.dirname(abs), base = path.basename(rel);
    const prefix = base.replace(/[_.].*$/, "") + "_";
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { names = []; }
    const rest = names.filter((n) => n !== base && n.startsWith(prefix) && n.endsWith(".js")).sort();
    const relDir = path.relative(ROOT, dir).replace(/\\/g, "/");
    return [rel, ...rest.map((n) => (relDir ? relDir + "/" : "") + n)];
}

/** One file's text, LF line ends. */
function read(rel) {
    return lf(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

/**
 * The file of the family whose text matches `re`, with its text and the match; null when none does. Throws when two
 * files match: a name found twice is a copy left behind by a move.
 */
function find(rel, re) {
    const hits = [];
    for (const f of family(rel)) {
        const text = read(f);
        re.lastIndex = 0;
        const match = re.exec(text);
        if (match) hits.push({ file: f, text, match });
    }
    if (hits.length > 1) throw new Error(`${re} matches in ${hits.map((h) => h.file).join(" and ")}`);
    return hits[0] || null;
}

/** The text of the family's file that matches `re`, or the named file's own text when none does. */
function textWith(rel, re) {
    const hit = find(rel, re);
    return hit ? hit.text : read(rel);
}

/** Every file of the family, joined with a newline between them (the named file first). */
function familyText(rel) {
    return family(rel).map(read).join("\n");
}

module.exports = { ROOT, family, read, find, textWith, familyText };
