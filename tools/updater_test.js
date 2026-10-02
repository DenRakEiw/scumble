// The updater's main side (electron/main/updater.js) in plain Node, no Electron and no network:
//   node tools/updater_test.js
// Sections 1-3: the release notes and the bold leads of their bullets (`releaseHeadlines`, what the update question
// lists) from the feed HTML of 0.1.37 as GitHub served it (tools/refs/updates/release_0_1_37.html) and from small cases.
// Sections 4-6: an Updater over a scripted autoUpdater: a skipped version is not installed on quit
// (`autoInstallOnAppQuit` off while the offered version is the skipped one), any other is, `announce` keeps the version
// this start asked about. Section 7: the wiring in main.js (the skip read at the start and on every settings write,
// the announce handler) and electron-updater's quit handler, which must read the switch at quit time for a skip made
// after the download to count.
// The normal tier for the question itself is the platform gate's `the_update_question_asks_once` step.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const ROOT = path.join(__dirname, "..");
const CHECKS = [];
function check(name, fn) { CHECKS.push([name, fn]); }
function assert(c, m) { if (!c) throw new Error(m); }

// electron and electron-updater played by stubs: a packaged app at 0.1.37, an autoUpdater whose checkForUpdates
// answers with the events the test scripts
const fake = new EventEmitter();
fake.autoDownload = false;
fake.autoInstallOnAppQuit = true;
fake.script = [];
fake.installs = [];
fake.checkForUpdates = async () => { for (const [ev, info] of fake.script) fake.emit(ev, info); return null; };
fake.quitAndInstall = (silent, run) => fake.installs.push([silent, run]);
// electron-updater's own: adds the quit handler once (BaseUpdater.addQuitHandler), counted here
fake.quitHandlers = 0;
fake.addQuitHandler = function () { if (this.quitHandlerAdded || !this.autoInstallOnAppQuit) return; this.quitHandlerAdded = true; this.quitHandlers += 1; };
// kept for the whole run: the Updater requires electron-updater only at its first check
const orig = Module._load;
Module._load = function (request, ...rest) {
    if (request === "electron") return { app: { isPackaged: true, getVersion: () => "0.1.37" } };
    if (request === "electron-updater") return { autoUpdater: fake };
    return orig.call(this, request, ...rest);
};
const { Updater, releaseNotes, releaseHeadlines } = require(path.join(ROOT, "electron", "main", "updater.js"));

const feed = fs.readFileSync(path.join(ROOT, "tools", "refs", "updates", "release_0_1_37.html"), "utf8");

check("the_notes_of_0_1_37_read_as_text", () => {
    const t = releaseNotes({ releaseNotes: feed });
    assert(t && t.startsWith("• FLUX 3 Image: boxes in the prompt, behind one switch."), "starts " + JSON.stringify(t && t.slice(0, 80)));
    // no tag of GitHub's HTML is left; `<red_scarf_1>` in the text is a box id the notes write (`&lt;red_scarf_1&gt;`)
    const tag = /<\/?(ul|ol|li|p|strong|em|code|br|a|h[1-6]|table|tr|td|th|div|blockquote)[^>]*>/i;
    assert(!tag.test(t), "markup left: " + (t.match(tag) || [])[0]);
    assert(/<red_scarf_1>/.test(t), "the box id in the text is gone");
    // the whole release, not its first 4,000 characters
    assert(/• Ideogram 4\.5/.test(t) && !t.endsWith("…"), "the notes are cut: " + t.length);
    // a mention GitHub links (`<a class="user-mention" ...>@img1</a>`) comes back as its text
    assert(/@img1/.test(t), "the @img1 mention is missing");
    assert(t.length > 4000 && t.length <= 30000, "the length: " + t.length);
    return `${t.length} characters`;
});

check("each_bullets_bold_lead_is_a_headline", () => {
    const h = releaseHeadlines({ releaseNotes: feed });
    const want = [
        "FLUX 3 Image: boxes in the prompt, behind one switch.",
        "Plugins can supply boxes for the prompt.",
        "Boxes: a panel for the boxes of a document.",
        "Boxes: draw them on the canvas.",
        "Boxes: the crop on the canvas, and what it does to them.",
        "Boxes: the prompt says where each box goes.",
        "Boxes are named after their description.",
        "Boxes: warnings before a run, and a tool that takes the box you point at.",
        // the bullet without a bold lead: its first sentence, cut near 160 characters
        "Plugins get a crop event when an app setting the crop of a run depends on changes (a node parameter, the API size), and scumble.host.cropFrame(editor) says …",
        "Ideogram 4.5",
    ];
    assert(JSON.stringify(h) === JSON.stringify(want), JSON.stringify(h));
    return `${h.length} lines, one per bullet`;
});

check("leads_over_two_lines_entities_loose_lists_and_none", () => {
    const wrapped = releaseHeadlines({ releaseNotes: "<ul>\n<li><strong>A lead over<br>\ntwo lines &amp; <code>code</code></strong> the text</li>\n</ul>" });
    assert(JSON.stringify(wrapped) === JSON.stringify(["A lead over two lines & code"]), JSON.stringify(wrapped));
    const loose = releaseHeadlines({ releaseNotes: "<ul>\n<li>\n<p><strong>Loose.</strong> A paragraph.</p>\n</li>\n</ul>" });
    assert(JSON.stringify(loose) === JSON.stringify(["Loose."]), JSON.stringify(loose));
    // a bold word inside a bullet is no lead: the bullet's first sentence stands for it
    const plain = releaseHeadlines({ releaseNotes: "<ul><li>Plain <strong>bold</strong> word. Second sentence.</li></ul>" });
    assert(JSON.stringify(plain) === JSON.stringify(["Plain bold word."]), "a bullet without a lead: " + JSON.stringify(plain));
    // sub-bullets belong to their bullet (the CHANGELOG's "Not tried against the real service yet." under a provider)
    const nested = releaseHeadlines({ releaseNotes: ["<ul>", "<li><strong>OpenRouter as a provider.</strong> Text.", "<ul>", "<li><strong>Not tried against the real service yet.</strong> More.</li>", "<li><strong>What leaves your machine:</strong> x</li>", "</ul>", "</li>", "<li><strong>Second.</strong> y</li>", "</ul>"].join(String.fromCharCode(10)) });
    assert(JSON.stringify(nested) === JSON.stringify(["OpenRouter as a provider.", "Second."]), "sub-bullets: " + JSON.stringify(nested));
    assert(releaseHeadlines({ releaseNotes: "" }) === null && releaseHeadlines(null) === null, "empty notes give leads");
    const many = releaseHeadlines({ releaseNotes: [{ version: "0.1.38", note: "<ul><li><strong>One.</strong> a</li></ul>" }, { version: "0.1.39", note: "<ul><li><strong>Two.</strong> b</li></ul>" }] });
    assert(JSON.stringify(many) === JSON.stringify(["One.", "Two."]), "fullChangelog form: " + JSON.stringify(many));
    // every release since the installed one, newest first, each under its version
    const two = releaseNotes({ version: "0.1.39", releaseNotes: [{ version: "0.1.39", note: "<ul><li><strong>Two.</strong> b</li></ul>" }, { version: "0.1.38", note: "<ul><li><strong>One.</strong> a</li></ul>" }] });
    const NL = String.fromCharCode(10);
    assert(two === ["0.1.39", "• Two. b", "", "0.1.38", "• One. a"].join(NL), "two releases: " + JSON.stringify(two));
    const one = releaseNotes({ version: "0.1.38", releaseNotes: [{ version: "0.1.38", note: "<ul><li><strong>One.</strong> a</li></ul>" }] });
    assert(one === "• One. a", "one release carries no version line: " + JSON.stringify(one));
    const huge = releaseNotes({ releaseNotes: "<ul>" + ("<li>" + "y".repeat(99) + "</li>").repeat(400) + "</ul>" });
    assert(huge.length <= 30002 && huge.endsWith(NL + "…") && new RegExp(NL + "• y{99}" + NL + "…$").test(huge), "past 30,000 characters: " + huge.length + " " + JSON.stringify(huge.slice(-30)));
    return "wrapped, loose, a sentence, sub-bullets, [{version, note}], 30,000";
});

const info = (version) => ({ version, releaseNotes: "<ul><li><strong>New in " + version + ".</strong> More.</li></ul>" });

check("a_skipped_version_is_not_installed_on_quit", () => {
    const u = new Updater();
    const seen = [];
    u.on("status", (s) => seen.push(s));
    assert(u.status.state === "idle" && u.status.skip === null && u.status.announced === null, "start: " + JSON.stringify(u.status));
    u.setSkip("0.1.38");   // main.js startApp, from settings.updates.skip
    assert(u.status.skip === "0.1.38", "skip not kept");
    fake.script = [["checking-for-update"], ["update-available", info("0.1.38")], ["download-progress", { percent: 50 }], ["update-downloaded", info("0.1.38")]];
    return u.check().then(() => {
        assert(u.status.state === "downloaded" && u.status.version === "0.1.38", "state " + JSON.stringify(u.status));
        assert(fake.autoInstallOnAppQuit === false, "the skipped version installs on quit");
        assert(u.skipped() === true, "skipped() does not see the skipped download");
        assert(JSON.stringify(u.status.headlines) === JSON.stringify(["New in 0.1.38."]), "headlines " + JSON.stringify(u.status.headlines));
        assert(seen.every((s) => s.skip === "0.1.38"), "a status without the skip");
        assert(fake.quitHandlers === 0, "a quit handler for the skipped download");
        u.setSkip(null);
        assert(fake.autoInstallOnAppQuit === true && u.skipped() === false, "an unskipped version does not install on quit");
        // electron-updater added no handler at the download (the switch was off): the skip taken back adds it
        assert(fake.quitHandlers === 1, "the skip taken back left the download without a quit handler: " + fake.quitHandlers);
        u.setSkip("0.1.37");
        assert(fake.autoInstallOnAppQuit === true, "skipping another version keeps this one from installing");
        u.setSkip("0.1.38");
        assert(fake.autoInstallOnAppQuit === false, "skipping it again does not take");
        // a newer version comes while 0.1.38 is skipped: that one installs on quit
        fake.emit("update-available", info("0.1.39"));
        assert(fake.autoInstallOnAppQuit === true, "a newer version than the skipped one does not install on quit");
        fake.emit("update-downloaded", info("0.1.39"));
        assert(fake.autoInstallOnAppQuit === true && u.status.version === "0.1.39", "after the newer download: " + fake.autoInstallOnAppQuit);
        return `${seen.length} statuses`;
    });
});

check("announce_keeps_the_version_and_install_runs_the_installer", () => {
    const u = new Updater();
    fake.script = [["update-available", info("0.1.40")], ["update-downloaded", info("0.1.40")]];
    return u.check().then(() => {
        let emitted = 0;
        u.on("status", () => { emitted += 1; });
        const r = u.announce("0.1.40");
        assert(r.announced === "0.1.40" && u.status.announced === "0.1.40" && emitted === 1, "announce: " + JSON.stringify(r) + " " + emitted);
        u.announce("0.1.40");
        assert(emitted === 1, "the same version announced twice emits twice");
        assert(u.status.state === "downloaded", "announce changed the state");
        fake.installs = [];
        assert(u.install() === true, "install refused");
        return new Promise((resolve) => setImmediate(resolve)).then(() => {
            assert(JSON.stringify(fake.installs) === JSON.stringify([[true, true]]), "quitAndInstall " + JSON.stringify(fake.installs));
            return "announced, installed silently and started";
        });
    });
});

check("a_skipped_download_is_checked_again_and_a_manual_check_stays_manual", () => {
    const u = new Updater();
    u.setSkip("0.1.41");
    fake.script = [["update-available", info("0.1.41")], ["update-downloaded", info("0.1.41")]];
    return u.check().then(async () => {
        assert(u.skipped(), "not skipped: " + JSON.stringify(u.status));
        // a newer release is out: the user's check looks again instead of answering with the skipped download
        let asked = 0;
        fake.script = [["update-available", info("0.1.42")], ["update-downloaded", info("0.1.42")]];
        const was = fake.checkForUpdates;
        fake.checkForUpdates = async () => { asked += 1; return was(); };
        await u.check({ manual: true });
        assert(asked === 1 && u.status.version === "0.1.42" && u.status.manual === true, "the check of a skipped download: " + JSON.stringify({ asked, v: u.status.version, manual: u.status.manual }));
        // a download in hand that is not skipped answers at once; a later automatic check keeps it manual
        await u.check({ manual: false });
        assert(asked === 1 && u.status.manual === true, "the automatic check took back manual: " + JSON.stringify({ asked, manual: u.status.manual }));
        // the start check downloads, the user's check comes while it runs: manual from then on
        const v = new Updater();
        v.status = { ...v.status, state: "downloading", version: "0.1.43", manual: false };
        await v.check({ manual: true });
        assert(v.status.manual === true && asked === 1, "a check during the download is not marked manual");
        fake.checkForUpdates = was;
        return "checked again, manual kept";
    });
});

check("dev_and_not_downloaded_never_install", () => {
    const u = new Updater();
    u.status = { ...u.status, state: "latest" };
    assert(u.install() === false, "an install without a download");
    u.setSkip("9.9.9");
    assert(u.status.state === "latest" && u.status.skip === "9.9.9", "setSkip changed the state");
    return "latest: refused";
});

check("main_reads_the_skip_and_electron_updater_reads_the_switch_at_quit", () => {
    const main = fs.readFileSync(path.join(ROOT, "electron", "main", "main.js"), "utf8");
    assert(/ipcMain\.handle\("settings:set", \(_e, patch\) => \{[\s\S]{0,200}?if \(patch && patch\.updates\) updater\.setSkip\(\(s\.updates \|\| \{\}\)\.skip\);/.test(main), "settings:set does not pass the skip on");
    assert(/updater\.setSkip\(upd\.skip\);\s*\n\s*if \(app\.isPackaged && !headless && !agentMode && upd\.check !== false\)/.test(main), "the start does not read the skip before its check");
    assert(/ipcMain\.handle\("update:announced", \(_e, version\) => updater\.announce\(version\)\)/.test(main), "no update:announced handler");
    assert(/restartPlan\(\{ argv: process\.argv\.slice\(1\), updateState: updater\.skipped\(\) \? "skipped" : updater\.status\.state \}\)/.test(main), "a restart installs a skipped version");
    const pre = fs.readFileSync(path.join(ROOT, "electron", "preload.js"), "utf8");
    assert(/announced: \(version\) => ipcRenderer\.invoke\("update:announced", version\)/.test(pre), "preload has no updates.announced");
    const base = fs.readFileSync(path.join(ROOT, "node_modules", "electron-updater", "out", "BaseUpdater.js"), "utf8");
    const q = base.indexOf("this.app.onQuit(");
    assert(q > 0, "electron-updater has no quit handler where it was");
    const body = base.slice(q, q + 1200);
    assert(/if \(!this\.autoInstallOnAppQuit\) \{[\s\S]*?return;/.test(body), "electron-updater's quit handler no longer reads autoInstallOnAppQuit at quit time");
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "electron-updater", "package.json"), "utf8")).version;
    return `electron-updater ${version}`;
});

(async () => {
    const fails = [];
    for (let i = 0; i < CHECKS.length; i++) {
        const [name, fn] = CHECKS[i];
        try {
            const r = await fn();
            console.log(`${i + 1}. ${name}: ok${r ? ` (${r})` : ""}`);
        } catch (err) {
            fails.push(name);
            console.log(`${i + 1}. ${name}: FAIL ${err.message}`);
        }
    }
    console.log(fails.length ? `FAIL ${fails.length} of ${CHECKS.length}: ${fails.join(", ")}` : `PASS ${CHECKS.length} of ${CHECKS.length}`);
    process.exitCode = fails.length ? 1 : 0;
})();
