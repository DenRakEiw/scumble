// Copies the manual and its reader into the website repository, which builds /scumble/manual from them
// (docs/PLAN_HELP.md §2). docs/MANUAL.md here is the one source; the website holds copies, byte for byte.
//
//   node tools/manual_sync.js [website root]          copy (default F:\portfolio_web)
//   node tools/manual_sync.js --check [website root]  exit 1 when a copy differs from the source
//
// Run it with every release, before the dev blog post (CLAUDE.md, the release-channel decision).
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const SITE = path.resolve(args.find((a) => !a.startsWith("--")) || "F:\\portfolio_web");

const FILES = [
    [path.join(ROOT, "docs", "MANUAL.md"), path.join(SITE, "content", "scumble", "MANUAL.md")],
    [path.join(ROOT, "renderer", "help", "manual.js"), path.join(SITE, "lib", "scumble-manual-reader.js")],
];

if (!fs.existsSync(path.join(SITE, "package.json"))) {
    console.error("manual_sync: no website at " + SITE);
    process.exit(2);
}
let differ = 0;
for (const [from, to] of FILES) {
    const src = fs.readFileSync(from);
    // the website repository checks files out with CRLF (core.autocrlf): the same text either way
    const lf = (b) => b.toString("utf8").replace(/\r\n/g, "\n");
    const same = fs.existsSync(to) && lf(fs.readFileSync(to)) === lf(src);
    if (CHECK) {
        if (!same) { differ++; console.log("differs: " + path.relative(SITE, to)); }
        continue;
    }
    if (same) { console.log("unchanged: " + path.relative(SITE, to)); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, src);
    console.log("copied: " + path.relative(ROOT, from) + " -> " + path.relative(SITE, to));
}
if (CHECK) console.log(differ ? `${differ} of ${FILES.length} differ` : "in sync");
process.exit(CHECK && differ ? 1 : 0);
