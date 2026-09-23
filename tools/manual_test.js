// The manual (docs/MANUAL.md) and its reader (renderer/help/manual.js), in plain Node (docs/PLAN_HELP.md
// §2): the file parses into its chapters, the reader refuses what is outside the shape, and the manual
// does not name what the app does not have - every menu shortcut is in the shortcuts chapter, and every
// "Settings › X" and "<Menu> › X" names a section or an item that exists.
//
//   node tools/manual_test.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
let failed = 0;
function check(name, fn) {
    try { const note = fn(); console.log("[ok] " + name + (note ? ": " + note : "")); } catch (err) { failed++; console.log("[FAIL] " + name + ": " + err.message); }
}
function eq(a, b, what) {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error(`${what || "value"}: ${x} instead of ${y}`);
}
function throws(fn, re, what) {
    try { fn(); } catch (err) { if (!re.test(err.message)) throw new Error(`${what}: "${err.message}" does not say ${re}`); return; }
    throw new Error(`${what}: no error`);
}

async function main() {
    const { parseManual, inline, plain, chapterText } = await import(pathToFileURL(path.join(ROOT, "renderer", "help", "manual.js")).href);
    const md = fs.readFileSync(path.join(ROOT, "docs", "MANUAL.md"), "utf8");
    const main = fs.readFileSync(path.join(ROOT, "electron", "main", "main.js"), "utf8");
    const html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
    let manual;

    check("the_manual_parses_into_its_chapters", () => {
        manual = parseManual(md, { site: "https://www.denrakeiw.com" });
        if (manual.title !== "Scumble manual") throw new Error("title " + manual.title);
        if (manual.chapters.length < 16) throw new Error(manual.chapters.length + " chapters");
        for (const c of manual.chapters) {
            if (!c.body.length) throw new Error(c.slug + " has no paragraph");
            if (c.shot && !c.shot.src.startsWith("/projects/scumble/manual/")) throw new Error(c.slug + " shot " + c.shot.src);
        }
        return `${manual.chapters.length} chapters, ${manual.chapters.filter((c) => c.shot).length} screenshots, ${Math.round(md.length / 1024)} KB`;
    });

    check("inline_markdown_is_spans_never_html", () => {
        eq(inline("a **b** `c` \\<d\\> e\\*"), [{ type: "text", text: "a " }, { type: "strong", text: "b" }, { type: "text", text: " " }, { type: "code", text: "c" }, { type: "text", text: " <d> e*" }], "spans");
        eq(plain("Setup \\<version\\>.exe"), "Setup <version>.exe", "plain");
        eq(inline("a `b"), [{ type: "text", text: "a `b" }], "an unclosed code span is text");
    });

    check("the_reader_refuses_what_is_outside_the_shape", () => {
        const head = "# M\n\n## One\n\n<!-- slug: one -->\n_Sum._\n\nText.\n";
        eq(parseManual(head).chapters.map((c) => [c.slug, c.title, c.summary, c.body]), [["one", "One", "Sum.", ["Text."]]], "a minimal chapter");
        throws(() => parseManual("# M\n\n## One\n\n_Sum._\n\nText.\n"), /no slug/, "no slug");
        throws(() => parseManual(head + "\n### Tips\n\n- x\n"), /line 10: an unknown section "Tips"/, "unknown section");
        throws(() => parseManual(head + "\n### Notes\n\n- x\n\n### Steps\n\n1. **A.** b\n"), /"Steps" after "Notes"/, "order");
        throws(() => parseManual(head + "\n### Steps\n\nfree text\n"), /a step is/, "a step");
        throws(() => parseManual(head + "\n### Keys\n\n| a | b |\n"), /before its #### group/, "a key row without a group");
        throws(() => parseManual(head + "\n## Two\n\n<!-- slug: one -->\n_S._\n\nT.\n"), /the slug "one" twice/, "a slug twice");
        const keys = parseManual(head + "\n### Keys\n\n#### G\n\n| Key | What it does |\n| --- | --- |\n| Ctrl+\\[ | down \\| up |\n").chapters[0].keys;
        eq(keys, [{ group: "G", rows: [{ key: "Ctrl+\\[", what: "down \\| up" }] }], "a key row with escapes");
    });

    check("every_menu_shortcut_is_in_the_shortcuts_chapter", () => {
        const chapter = manual.chapters.find((c) => c.keys && c.keys.length);
        const listed = new Set();
        for (const g of chapter.keys) for (const r of g.rows) for (const k of plain(r.key).split("·")) listed.add(k.trim().toLowerCase());
        const accels = [...main.matchAll(/accelerator:\s*"([^"]+)"/g)].map((m) => m[1].replace(/CmdOrCtrl/g, "Ctrl"));
        const missing = accels.filter((a) => !listed.has(a.toLowerCase()));
        if (missing.length) throw new Error(`the menu has ${missing.join(", ")}, the chapter "${chapter.title}" does not`);
        return `${accels.length} menu accelerators, all listed`;
    });

    check("every_settings_section_the_manual_names_exists", () => {
        const sections = [...html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1].trim());
        const named = [...md.matchAll(/Settings › ([^.,;:)\n]+)/g)].map((m) => m[1]);
        const bad = named.filter((n) => !sections.some((s) => n.startsWith(s)));
        if (bad.length) throw new Error(`no section for: ${bad.map((b) => b.slice(0, 40)).join(" | ")} (the dialog has ${sections.join(", ")})`);
        return `${named.length} mentions of ${new Set(named.map((n) => sections.find((s) => n.startsWith(s)))).size} sections`;
    });

    check("every_menu_item_the_manual_names_exists", () => {
        // "Copy MCP registration (Claude Code)" is named without its bracket
        const labels = [...main.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1].replace(/&/g, "").replace(/\.\.\.$/, "").replace(/ \([^)]*\)$/, ""));
        const named = [...md.matchAll(/\b(File|Edit|View|Help|Plugins) › ([^.,;:)\n]+)/g)].map((m) => [m[1], m[2]]);
        const bad = named.filter(([, n]) => !labels.some((l) => n.startsWith(l)));
        if (bad.length) throw new Error(`no menu item for: ${bad.map(([m, n]) => m + " › " + n.slice(0, 40)).join(" | ")}`);
        return `${named.length} menu paths`;
    });

    check("the_chat_context_is_the_whole_chapter", () => {
        const c = manual.chapters.find((x) => x.slug === "install");
        const t = chapterText(c);
        for (const bit of [c.title, c.summary, "Download: Scumble Setup <version>.exe", "Windows 10 and 11"]) if (!t.includes(bit)) throw new Error("missing " + bit);
    });

    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err.stack || err)); console.log("FAIL"); process.exit(1); });
