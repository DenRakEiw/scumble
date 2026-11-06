// The CorridorKey 2.0 set's entry in the helper registry, written from the built set (docs/PLAN_CORRIDORKEY.md §4.3:
// I1 lands it in dist/ck_onnx/<version>/ with its manifest.json and notices). Every file's size and sha256 are read
// from the files themselves, never typed by hand; the hosting URL is the release's (until then no --base, and the
// entry stays not offered). The descriptive fields (label, licence, terms, subdir) are kept from the current file.
//
//     node tools/ck2_catalogue.js --set dist/ck_onnx/<version> [--version <v>] [--base <url>] [--out <json>]
//     node tools/ck2_catalogue.js --set <dir> --check          # does the catalogue match the folder byte for byte?
//
// --base is the folder URL the files are served from (e.g. https://huggingface.co/<user>/CorridorKey2.0-ONNX/resolve/
// <commit>/); a file's URL is the base plus its name. Without --out the catalogue is electron/main/onnx/corridorkey2.json.
// An --out that does not exist yet takes the descriptive fields (DESCRIPTIVE below) from that catalogue, never its
// version or files; --check needs an existing catalogue. A catalogue without id and subdir is never written.
// The files are the folder's regular files (no .part, no hidden files, no subfolders: the set lives in one folder);
// when manifest.json lists `files` (names, or objects with `name`), that list plus manifest.json itself must match the
// folder exactly.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CATALOGUE = path.join(__dirname, "..", "electron", "main", "onnx", "corridorkey2.json");
/** The fields a new catalogue takes from the app's (the rest is read from the set or given on the command line). */
const DESCRIPTIVE = ["id", "kind", "label", "note", "source", "sourceUrl", "license", "subdir", "terms"];

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

async function sha256(p) {
    const h = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(p, { highWaterMark: 1 << 20 })) h.update(chunk);
    return h.digest("hex");
}

function roleOf(name) {
    if (name === "manifest.json") return "manifest";
    if (name === "THIRD_PARTY_NOTICES.md") return "notices";
    if (name === "LICENSE") return "license";
    return null;
}

/** The set's file names: the folder's files, held to manifest.json's list when it has one. */
function setNames(dir) {
    const names = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith(".") && !e.name.endsWith(".part"))
        .map((e) => e.name);
    const extra = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    if (extra.length) throw new Error(`the set must be one folder; subfolders found: ${extra.join(", ")}`);
    const mp = path.join(dir, "manifest.json");
    if (fs.existsSync(mp)) {
        const man = JSON.parse(fs.readFileSync(mp, "utf8"));
        if (Array.isArray(man.files)) {
            const listed = new Set(man.files.map((f) => (typeof f === "string" ? f : f && f.name)).filter(Boolean));
            listed.add("manifest.json");
            const missing = [...listed].filter((n) => !names.includes(n));
            const unlisted = names.filter((n) => !listed.has(n) && !roleOf(n));
            if (missing.length || unlisted.length) throw new Error(`the folder and manifest.json disagree: missing ${missing.join(", ") || "none"}; not in the manifest ${unlisted.join(", ") || "none"}`);
        }
    }
    const order = (n) => (n === "manifest.json" ? 0 : roleOf(n) ? 1 : n.endsWith(".onnx") ? 3 : 2);
    return names.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

/** The catalogue for the set in `dir`, built on `current` (the descriptive fields). */
async function build(dir, { current = {}, version = null, base = null } = {}) {
    const files = [];
    for (const name of setNames(dir)) {
        const p = path.join(dir, name);
        const f = { name, size: fs.statSync(p).size, sha256: await sha256(p) };
        const role = roleOf(name);
        if (role) f.role = role;
        files.push(f);
    }
    if (!files.length) throw new Error("the set folder is empty: " + dir);
    const out = { ...current };
    if (!out.id || !out.subdir) throw new Error("refusing to write a catalogue without id and subdir (start from electron/main/onnx/corridorkey2.json)");
    out.about = "The CorridorKey 2.0 set in the helper registry (electron/main/onnx/models.js fromSetCatalogue), written by tools/ck2_catalogue.js from the built set: names, sizes and sha256 read from the files. Offered for download only with a base URL.";
    out.placeholder = false;
    out.version = version || current.version || null;
    out.base = base ? String(base).replace(/\/*$/, "/") : null;
    out.approxBytes = files.reduce((a, f) => a + f.size, 0);
    out.files = files;
    return out;
}

/** Differences between a catalogue and the folder (empty when they match). */
async function compare(cat, dir) {
    const diffs = [];
    const want = new Map((cat.files || []).map((f) => [f.name, f]));
    const names = setNames(dir);
    for (const n of names) if (!want.has(n)) diffs.push(`${n}: in the folder, not in the catalogue`);
    for (const [n, f] of want) {
        const p = path.join(dir, n);
        if (!fs.existsSync(p)) { diffs.push(`${n}: in the catalogue, not in the folder`); continue; }
        const size = fs.statSync(p).size;
        if (size !== f.size) { diffs.push(`${n}: ${size} bytes, the catalogue says ${f.size}`); continue; }
        if ((await sha256(p)) !== f.sha256) diffs.push(`${n}: the sha256 differs`);
    }
    return diffs;
}

async function main() {
    const args = process.argv.slice(2);
    const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
    const dir = flag("--set");
    const out = flag("--out") || CATALOGUE;
    if (!dir) { console.error("usage: node tools/ck2_catalogue.js --set <dir> [--version v] [--base url] [--out json] [--check]"); process.exit(2); }
    if (args.includes("--check") && !fs.existsSync(out)) { console.error("no catalogue at " + out); process.exit(2); }
    let current;
    if (fs.existsSync(out)) current = readJson(out);
    else {
        const app = readJson(CATALOGUE);
        current = Object.fromEntries(DESCRIPTIVE.filter((k) => k in app).map((k) => [k, app[k]]));
    }
    if (args.includes("--check")) {
        const diffs = await compare(current, dir);
        for (const d of diffs) console.log("  " + d);
        console.log(diffs.length ? `FAIL ${diffs.length} differences` : `PASS ${(current.files || []).length} files match`);
        process.exit(diffs.length ? 1 : 0);
    }
    const cat = await build(dir, { current, version: flag("--version"), base: flag("--base") });
    fs.writeFileSync(out, JSON.stringify(cat, null, 2) + "\n", { encoding: "utf8" });
    console.log(`wrote ${out}: ${cat.files.length} files, ${(cat.approxBytes / 1e9).toFixed(2)} GB, ${cat.base ? "offered from " + cat.base : "no base URL: not offered"}`);
}

if (require.main === module) main().catch((err) => { console.error(String(err && err.message || err)); process.exit(1); });

module.exports = { build, compare, setNames, DESCRIPTIVE };
