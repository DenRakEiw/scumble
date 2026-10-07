// The star and share links of item 40 (electron/main/share.js, docs/PLAN_0_1_43.md S2), in plain Node:
//   node tools/share_test.js
// The share pages (https, the repo and the line, no tracking parameter), the copied text, and when the quiet line after
// an update shows: once per version, never on a fresh install's first start, never where no one sees it.
"use strict";

const path = require("node:path");
const share = require(path.join(__dirname, "..", "electron", "main", "share.js"));

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check("the shared link is the GitHub repo", share.REPO === "https://github.com/DenRakEiw/scumble");
check("Copy link: the line and the link", share.copyText() === "Scumble: a free, open-source editor for AI inpainting https://github.com/DenRakEiw/scumble", share.copyText());
check("four targets: X, LinkedIn, Bluesky, Reddit", eq(share.TARGETS.map((t) => t.id), ["x", "linkedin", "bluesky", "reddit"]));
for (const t of share.TARGETS) {
    const u = new URL(share.urlFor(t.id));
    const all = [...u.searchParams.values()].join(" ");
    check(`${t.label}: https, the repo in it, no utm / ref / tracking parameter`,
        u.protocol === "https:" && all.includes(share.REPO) && ![...u.searchParams.keys()].some((k) => /^utm_|^ref$|^src$|^source$/i.test(k)), u.href);
}
check("X carries the line", new URL(share.urlFor("x")).searchParams.get("text") === share.LINE);
check("Reddit carries the line as the title", new URL(share.urlFor("reddit")).searchParams.get("title") === share.LINE);
check("an unknown target has no URL", share.urlFor("myspace") === null && share.urlFor("") === null);
check("the star line is the user's wording", share.STAR_NOTE === "⭐ If Scumble is useful to you, consider starring the repo — it helps the project get discovered.");

const v = (o) => share.versionNote({ seen: null, current: "0.1.43", existing: true, quiet: false, ...o });
check("an update from a version that showed it: shown, recorded", eq(v({ seen: "0.1.42" }), { show: true, record: "0.1.43" }));
check("the same version again: nothing", eq(v({ seen: "0.1.43" }), { show: false, record: null }));
check("a profile from before the key (0.1.42 and older): shown, recorded", eq(v({ seen: null, existing: true }), { show: true, record: "0.1.43" }));
check("a fresh install's first start: recorded, not shown", eq(v({ seen: null, existing: false }), { show: false, record: "0.1.43" }));
check("headless or an agent's instance: neither shown nor recorded", eq(v({ seen: "0.1.42", quiet: true }), { show: false, record: null }));
check("no version known: nothing", eq(v({ current: "" }), { show: false, record: null }));

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
