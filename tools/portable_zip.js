// Builds the portable zip of a Windows release (CLAUDE.md item 36, docs/PLAN_0_1_42.md P2): dist/win-unpacked copied
// to dist/portable/Scumble/ with the marker portable.txt (electron/main/portable.js MARKER_TEXT), zipped by Windows' own
// tar.exe into dist/Scumble-<version>-portable-win-x64.zip. One top folder Scumble\ and no data folder (the app makes
// it at the first start), so a new version unpacks over an old one and keeps its data.
//
//   node tools/portable_zip.js     (npm run dist:portable) after `npm run dist` and before any `npm run dist:store`:
//                                  dist:store rewrites win-unpacked without resources\app-update.yml, and a copy
//                                  without it cannot read the update feed (the notify mode of electron/main/updater.js)
//
// CI runs it after the installer build (.github/workflows/build.yml) and uploads the zip to the draft on a tag.
// Windows only: Git Bash's tar is GNU tar and writes no zip, so tar.exe is called by its full path.
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const portable = require("../electron/main/portable");

const ROOT = path.resolve(__dirname, "..");
const TOP = "Scumble";

/** The release asset's name (the CI upload and docs/RELEASING.md use the same). */
function zipName(version) {
    return `Scumble-${version}-portable-win-x64.zip`;
}

function tarPath(env = process.env) {
    return path.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "tar.exe");
}

/**
 * One file out of an asar archive (the app's package.json), read by the archive's own layout: an 8-byte size pickle,
 * the header pickle (its JSON), then the files at `offset` from the header's end. Null when the file is not inside.
 */
function asarFile(asar, name) {
    const fd = fs.openSync(asar, "r");
    try {
        const head = Buffer.alloc(8);
        fs.readSync(fd, head, 0, 8, 0);
        const size = head.readUInt32LE(4);
        const hb = Buffer.alloc(size);
        fs.readSync(fd, hb, 0, size, 8);
        const header = JSON.parse(hb.toString("utf8", 8, 8 + hb.readInt32LE(4)));
        let node = header;
        for (const part of name.split("/")) node = node && node.files && node.files[part];
        if (!node || node.unpacked || node.offset == null) return null;
        const buf = Buffer.alloc(node.size);
        fs.readSync(fd, buf, 0, node.size, 8 + size + Number(node.offset));
        return buf;
    } finally {
        fs.closeSync(fd);
    }
}

/** The version inside win-unpacked (the asar's package.json), or null when it cannot be read. */
function builtVersion(src) {
    try {
        const pkg = asarFile(path.join(src, "resources", "app.asar"), "package.json");
        return pkg ? JSON.parse(pkg.toString("utf8")).version || null : null;
    } catch (_) {
        return null;
    }
}

/** Why `src` cannot be shipped as the portable copy of `version`; empty when it can. */
function problems(src, version) {
    const out = [];
    const at = (...p) => path.join(src, ...p);
    if (!fs.existsSync(at("Scumble.exe"))) {
        out.push(`no Scumble.exe in ${src}: run npm run dist first`);
        return out;
    }
    const yml = at("resources", "app-update.yml");
    if (!fs.existsSync(yml)) {
        out.push(`no resources\\app-update.yml in ${src}: a copy without it cannot read the update feed (npm run dist:store rewrites win-unpacked without it); run npm run dist again`);
    } else {
        const t = fs.readFileSync(yml, "utf8");
        if (!/^provider:\s*github\s*$/m.test(t) || !/^owner:\s*DenRakEiw\s*$/m.test(t) || !/^repo:\s*scumble\s*$/m.test(t)) {
            out.push(`resources\\app-update.yml in ${src} does not name the GitHub releases of DenRakEiw/scumble`);
        }
    }
    const built = builtVersion(src);
    if (!built) out.push(`cannot read the version of resources\\app.asar in ${src}`);
    else if (built !== version) out.push(`${src} holds version ${built}, package.json says ${version}: run npm run dist again`);
    if (fs.existsSync(at(portable.DATA))) {
        out.push(`${src} has a "${portable.DATA}" folder (a copy started there as a portable one): it would ship that copy's settings and keys; run npm run dist again`);
    }
    return out;
}

function countFiles(dir) {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
    return n;
}

/**
 * Stage `src` as <out>\portable\Scumble with the marker, zip it to <out>\<zipName>, remove the stage.
 * Throws (with `refused: true`) before writing anything when the layout is wrong.
 * @param {{ src: string, out: string, version: string, tar?: string }} o
 * @returns {{ zip: string, bytes: number, files: number }}
 */
function build({ src, out, version, tar = tarPath() }) {
    const why = problems(src, version);
    if (why.length) {
        const err = new Error("portable_zip: refused:\n- " + why.join("\n- "));
        err.refused = true;
        throw err;
    }
    const stageRoot = path.join(out, "portable");
    const stage = path.join(stageRoot, TOP);
    const zip = path.join(out, zipName(version));
    // a stage left from an earlier run (or started by hand, with a data folder in it) never reaches the zip
    fs.rmSync(stageRoot, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
    fs.cpSync(src, stage, { recursive: true });
    fs.writeFileSync(path.join(stage, portable.MARKER), portable.MARKER_TEXT);
    const files = countFiles(stage);
    const r = spawnSync(tar, ["-a", "-c", "-f", zip, "-C", stageRoot, TOP], { encoding: "utf8" });
    if (r.error || r.status !== 0) {
        fs.rmSync(zip, { force: true });
        throw new Error(`portable_zip: ${tar} failed (${r.error ? r.error.message : "exit " + r.status}) ${(r.stderr || "").trim()}`);
    }
    fs.rmSync(stageRoot, { recursive: true, force: true });
    return { zip, bytes: fs.statSync(zip).size, files };
}

function main() {
    if (process.platform !== "win32") {
        console.error("portable_zip: Windows only (it zips with Windows' own tar.exe)");
        process.exit(2);
    }
    const version = require(path.join(ROOT, "package.json")).version;
    const t0 = Date.now();
    try {
        const r = build({ src: path.join(ROOT, "dist", "win-unpacked"), out: path.join(ROOT, "dist"), version });
        const mb = (r.bytes / 1048576).toFixed(1);
        console.log(`built ${path.relative(ROOT, r.zip)} (${mb} MB, ${r.files} files, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (err) {
        console.error(err.message);
        process.exit(err.refused ? 2 : 1);
    }
}

if (require.main === module) main();

module.exports = { zipName, tarPath, asarFile, builtVersion, problems, build, TOP };
