// Builds the .mcpb bundle of Scumble's MCP server (docs/PLAN_MCPB.md): mcpb/ staged into dist/mcpb/scumble/ with the
// manifest's version from package.json and its tools from docs/COMMANDS.md, validated and packed by @anthropic-ai/mcpb
// into dist/scumble-<version>.mcpb, with its SHA-256 beside it. The bundle holds no Scumble: a starter that finds the
// installed one (mcpb/server/index.js).
//
//   node tools/mcpb_build.js                      (npm run dist:mcpb) the bundle
//   node tools/mcpb_build.js --server-json [vX.Y.Z]   after the release is public: the `packages` entry of server.json
//                                                 from the release asset's digest (the registry wants the SHA-256)
//
// CI runs the first form after the installer build (.github/workflows/build.yml) and uploads the file to the draft on
// a tag. The CLI is the devDependency @anthropic-ai/mcpb; without it in node_modules (a worktree) npx fetches the
// pinned version.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "mcpb");
const REPO = "DenRakEiw/scumble";
const MCPB_VERSION = "2.1.2";

function pkg() {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
}

/** The release asset's name (CI, docs/RELEASING.md and server.json use the same). */
function bundleName(version) {
    return `scumble-${version}.mcpb`;
}

function bundleUrl(version) {
    return `https://github.com/${REPO}/releases/download/v${version}/${bundleName(version)}`;
}

/** [{ name, description }] from docs/COMMANDS.md: every `### \`name\`` heading and the paragraph below it. */
function toolsFromCommandsDoc(text = fs.readFileSync(path.join(ROOT, "docs", "COMMANDS.md"), "utf8")) {
    const lines = text.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const m = /^### `([^`]+)`/.exec(lines[i]);
        if (!m) continue;
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const desc = [];
        while (j < lines.length && lines[j].trim() && !lines[j].startsWith("|") && !lines[j].startsWith("#") && !lines[j].startsWith("(")) desc.push(lines[j].trim()), j++;
        out.push({ name: m[1].replace(/\./g, "_"), description: desc.join(" ") });
    }
    return out;
}

/** The manifest as it goes into the bundle: the source with the version and the tools filled in. */
function manifest(version = pkg().version, tools = toolsFromCommandsDoc()) {
    const m = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
    m.version = version;
    m.tools = tools.map((t) => ({ name: t.name, description: t.description }));
    return m;
}

/** Stage the bundle's files into `dest` (emptied first). Returns the manifest. */
function stage(dest, version) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.join(dest, "server"), { recursive: true });
    const m = manifest(version);
    fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
    fs.copyFileSync(path.join(SRC, "server", "index.js"), path.join(dest, "server", "index.js"));
    fs.copyFileSync(path.join(SRC, "README.md"), path.join(dest, "README.md"));
    fs.copyFileSync(path.join(ROOT, "build", "icon.png"), path.join(dest, "icon.png"));
    fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(dest, "LICENSE"));
    return m;
}

/** Runs the mcpb CLI: the devDependency's script, else npx with the pinned version. */
function mcpb(args, opts = {}) {
    let r;
    try {
        const cli = path.join(path.dirname(require.resolve("@anthropic-ai/mcpb/package.json")), "dist", "cli", "cli.js");
        r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: ROOT, ...opts });
    } catch (_) {
        // one command line through the shell (npx is a .cmd on Windows); the arguments are paths and file names
        const line = ["npx", "--yes", `@anthropic-ai/mcpb@${MCPB_VERSION}`, ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
        r = spawnSync(line, { encoding: "utf8", cwd: ROOT, shell: true, ...opts });
    }
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`mcpb ${args[0]} failed (${r.status}): ${(r.stderr || "") + (r.stdout || "")}`.trim());
    return r.stdout || "";
}

function sha256(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** The bundle: stage, validate, pack, hash. Returns { file, sha256, version }. */
function build() {
    const version = pkg().version;
    const dest = path.join(ROOT, "dist", "mcpb", "scumble");
    const m = stage(dest, version);
    mcpb(["validate", path.join(dest, "manifest.json")]);
    const file = path.join(ROOT, "dist", bundleName(version));
    fs.rmSync(file, { force: true });
    mcpb(["pack", dest, file]);
    if (!fs.existsSync(file)) throw new Error(`mcpb pack wrote no ${file}`);
    const hash = sha256(file);
    fs.writeFileSync(file + ".sha256", `${hash}  ${bundleName(version)}\n`);
    console.log(`${file} (${fs.statSync(file).size} bytes, ${m.tools.length} tools)\nsha256 ${hash}`);
    console.log(mcpb(["info", file]).trim());
    return { file, sha256: hash, version };
}

/** The published release's .mcpb digest through gh (GitHub hashes every asset), else by downloading it. */
function releaseDigest(tag) {
    const r = spawnSync("gh", ["release", "view", tag, "--repo", REPO, "--json", "assets,isDraft"], { encoding: "utf8", shell: process.platform === "win32" });
    if (r.status !== 0) throw new Error(`gh release view ${tag}: ${r.stderr || r.stdout}`);
    const rel = JSON.parse(r.stdout);
    if (rel.isDraft) throw new Error(`${tag} is still a draft: publish it first (the registry checks the asset's URL)`);
    const name = bundleName(tag.replace(/^v/, ""));
    const asset = (rel.assets || []).find((a) => a.name === name);
    if (!asset) throw new Error(`${tag} has no asset ${name}`);
    const m = /^sha256:([0-9a-f]{64})$/.exec(asset.digest || "");
    if (m) return m[1];
    const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "scumble-mcpb-"));
    const d = spawnSync("gh", ["release", "download", tag, "--repo", REPO, "--pattern", name, "--dir", tmp], { encoding: "utf8", shell: process.platform === "win32" });
    if (d.status !== 0) throw new Error(`gh release download: ${d.stderr || d.stdout}`);
    return sha256(path.join(tmp, name));
}

/** Writes server.json's version and its `packages` entry for the published bundle of `tag`. */
function serverJson(tag) {
    const version = tag.replace(/^v/, "");
    const file = path.join(ROOT, "server.json");
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    const digest = releaseDigest(tag);
    s.version = version;
    s.packages = [{ registryType: "mcpb", identifier: bundleUrl(version), fileSha256: digest, transport: { type: "stdio" } }];
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
    console.log(`server.json: ${version}, ${bundleUrl(version)}\nsha256 ${digest}`);
    return s;
}

module.exports = { bundleName, bundleUrl, toolsFromCommandsDoc, manifest, stage, mcpb, sha256, build, serverJson, MCPB_VERSION };

if (require.main === module) {
    const a = process.argv.slice(2);
    try {
        if (a[0] === "--server-json") serverJson(a[1] || `v${pkg().version}`);
        else build();
    } catch (e) {
        console.error("mcpb_build: " + e.message);
        process.exit(1);
    }
}
