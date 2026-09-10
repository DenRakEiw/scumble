// Prompt instruction templates: the text that tells the language model how to rewrite a
// prompt. Plain Markdown files with a small front matter, shipped in `prompts/` and added
// to by the user in `<userData>/prompts/`; a user file with the same id wins, so a built-in
// can be overridden. The app always appends its own output rule, so a template that forgets
// it still yields a usable prompt.
//
//   ---
//   name: Photographic
//   description: camera, lens and light, for photo-realistic models
//   use: generate            # generate | upsample | both (default both)
//   for: flux, gpt-image     # optional, matched against the recipe id, name and family
//   ---
//   <the instruction, with {prompt} {model} {aspect} {width} {height} {useCase} {region} {hint}>
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, shell } = require("electron");

function userDir() {
    return path.join(app.getPath("userData"), "prompts");
}

/** Front matter plus body; an id from the file name. */
function parse(text, id, source) {
    let head = "", body = String(text || "").replace(/^﻿/, "");
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
    if (m) { head = m[1]; body = body.slice(m[0].length); }
    const meta = {};
    for (const line of head.split(/\r?\n/)) {
        const kv = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
        if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
    const use = /^(generate|upsample|both)$/.test(meta.use || "") ? meta.use : "both";
    return {
        id,
        source,
        name: meta.name || id,
        description: meta.description || "",
        use,
        for: (meta.for || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
        body: body.trim(),
    };
}

async function readDir(dir, source) {
    let names = [];
    try { names = await fsp.readdir(dir); } catch (_) { return []; }
    const out = [];
    for (const name of names.sort()) {
        if (!/\.md$/i.test(name)) continue;
        try {
            const text = await fsp.readFile(path.join(dir, name), "utf8");
            out.push(parse(text, name.replace(/\.md$/i, ""), source));
        } catch (err) {
            out.push({ id: name.replace(/\.md$/i, ""), source, name, description: "", use: "both", for: [], body: "", error: String(err.message || err) });
        }
    }
    return out;
}

/** Every template, user files first so they override a built-in of the same id. */
async function list(builtinDir) {
    const user = await readDir(userDir(), "user");
    const builtin = await readDir(builtinDir, "builtin");
    const seen = new Set(user.map((t) => t.id));
    return [...user, ...builtin.filter((t) => !seen.has(t.id))];
}

/** Copy a .md file the user picked into the user folder; returns its id. */
async function importFile(file) {
    const src = String(file || "");
    if (!/\.md$/i.test(src)) throw new Error("a prompt template is a .md file");
    const text = await fsp.readFile(src, "utf8");
    const id = path.basename(src).replace(/\.md$/i, "").replace(/[^A-Za-z0-9._-]/g, "_");
    if (!id) throw new Error("bad file name");
    await fsp.mkdir(userDir(), { recursive: true });
    await fsp.writeFile(path.join(userDir(), id + ".md"), text, "utf8");
    return { id, path: path.join(userDir(), id + ".md") };
}

async function remove(id) {
    const safe = String(id || "").replace(/[^A-Za-z0-9._-]/g, "");
    if (!safe) throw new Error("bad template id");
    await fsp.unlink(path.join(userDir(), safe + ".md"));
    return true;
}

function openFolder() {
    fs.mkdirSync(userDir(), { recursive: true });
    shell.openPath(userDir());
    return userDir();
}

module.exports = { list, importFile, remove, openFolder, userDir, parse };
