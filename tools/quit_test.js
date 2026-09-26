// Quit safety (docs/PLAN_0_1_29.md §3) in plain Node, no app: the first step of tools/quit_test.py.
//
//  1. electron/main/autosave.js on a scratch folder: save and load, the rotation at a start (once, only when the
//     files changed - a restore's re-serialized state is the same - never an empty session over one with pictures),
//     the two crash copies (never an empty or repeated state over them), the list, the mirror keys the generations
//     name, no temporary file left behind;
//  2. electron/main/quit.js: QuitGuard (flush, ask while it runs, allow after; a timeout and a failed save still let
//     the close through) and CrashGuard (reload, safe, stop, and reload again once the window has passed);
//  3. the wiring in electron/main/main.js, files.js, renderer/shell.js, editor/host.js and editor/inpaint_canvas.js,
//     read from the sources: a close is prevented until the window saved, with uploads kept local meanwhile; the
//     update's installer starts only after the save, and an install that does not quit resets the guard; a restart
//     releases the guard; View > Reload saves first; a crashed window is reloaded, and the third crash ends even an
//     agent's instance; every start rotates; pruning keeps what the generations name; an agent's quit re-checks after
//     the save; the window answers the save, a safe start restores nothing, no autosave runs while documents are
//     restored, and a layer's upload runs one pass at a time and marks the layer clean before it starts.
//
//     node tools/quit_test.js
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const autosave = require(path.join(ROOT, "electron", "main", "autosave.js"));
const { QuitGuard, CrashGuard, isCrash } = require(path.join(ROOT, "electron", "main", "quit.js"));

let failed = 0;
const results = [];
async function check(name, fn) {
    try {
        const detail = await fn();
        results.push(`[ok] ${name}${detail ? ": " + detail : ""}`);
    } catch (err) {
        failed++;
        results.push(`[FAIL] ${name}: ${err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err}`);
    }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The body of the first `{ ... }` after `re` matched in `src` (braces counted, strings not). */
function bodyAfter(src, re) {
    const m = re.exec(src);
    if (!m) return null;
    let i = src.indexOf("{", m.index + m[0].length - 1);
    if (i < 0) return null;
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") { depth--; if (!depth) return src.slice(i, j + 1); }
    }
    return null;
}

/** A bundle as host.js bundle() writes it: `pics` documents with a layer file each, `empty` without. */
function bundle(tag, pics, empty = 0) {
    const docs = [];
    let id = 1;
    for (let i = 0; i < pics; i++) docs.push({ id: id++, state: JSON.stringify({ base: { ref: { filename: `${tag}_base_${i}.png`, subfolder: "inpaint_canvas", type: "input" } }, layers: [{ ref: { filename: `${tag}_layer_${i}.png`, subfolder: "inpaint_canvas", type: "input" } }] }) });
    for (let i = 0; i < empty; i++) docs.push({ id: id++, state: "{}" });
    return JSON.stringify({ version: 2, active: 1, nextId: id, docs });
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-quit-"));
    try {
        // 1 -------------------------------------------------------------------------------------------------------
        await check("autosave_saves_and_loads_whole", () => {
            assert(autosave.load(dir) === null, "an empty folder has an autosave");
            assert(autosave.rotate(dir).rotated === false, "rotated without an autosave");
            const a = bundle("a", 2);
            autosave.save(dir, a);
            assert(autosave.load(dir) === a, "the state read back is not the one written");
            assert(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "a temporary file was left: " + fs.readdirSync(dir));
            let threw = false;
            try { autosave.load(dir, "7"); } catch (_) { threw = true; }
            assert(threw, "an unknown generation did not throw");
            return fs.readdirSync(dir).join(", ");
        });
        await check("a_windowed_start_keeps_the_last_session", () => {
            const a = autosave.load(dir);
            assert(autosave.rotate(dir).rotated === true, "the first start did not rotate");
            assert(autosave.load(dir, "1") === a, "generation 1 is not the last session");
            const again = autosave.rotate(dir);
            assert(again.rotated === false, "a second start with the same state rotated");
            const b = bundle("b", 1, 1);
            autosave.save(dir, b);
            assert(autosave.rotate(dir).rotated === true, "a changed state did not rotate");
            assert(autosave.load(dir, "1") === b && autosave.load(dir, "2") === a, "the generations are not b, a");
            const c = bundle("c", 0, 1);                        // a session whose restore failed: one empty tab
            autosave.save(dir, c);
            const r = autosave.rotate(dir);
            assert(r.rotated === false, "an empty session pushed out one with pictures");
            assert(autosave.load(dir, "1") === b && autosave.load(dir, "2") === a, "the generations moved: " + JSON.stringify(r));
            return r.why;
        });
        await check("a_restore_that_writes_the_state_back_is_no_new_session", () => {
            const b = autosave.load(dir, "1");
            const again = JSON.stringify({ ...JSON.parse(b), nextId: 99 });      // the same documents and files, other text
            autosave.save(dir, again);
            const r = autosave.rotate(dir);
            assert(r.rotated === false, "a re-serialized state rotated");
            assert(!autosave.sameState(bundle("a", 2), bundle("a", 1)) && autosave.sameState(b, again), "sameState");
            return r.why;
        });
        await check("a_crash_sets_the_state_aside", () => {
            const d = bundle("d", 1);
            autosave.save(dir, d);
            assert(autosave.setAside(dir) === true, "setAside said no");
            assert(autosave.load(dir, "crash") === d, "the crash generation is not the state set aside");
            assert(autosave.setAside(dir) === false, "the same state was set aside twice");
            autosave.save(dir, bundle("e", 0, 1));
            assert(autosave.setAside(dir) === false && autosave.load(dir, "crash") === d, "an empty state replaced the crash copy");
            const f = bundle("f", 1);
            autosave.save(dir, f);
            assert(autosave.setAside(dir) === true && autosave.load(dir, "crash") === f && autosave.load(dir, "crash.1") === d, "the second crash copy did not keep the first");
            autosave.save(dir, d);
            const list = autosave.generations(dir);
            const ids = list.map((g) => g.id).join(",");
            assert(ids === "1,2,crash,crash.1", "generations: " + ids);
            const one = list.find((g) => g.id === "1");
            assert(one.docs === 2 && one.pictures === 1 && one.bytes > 0 && one.time > 0, "generation 1: " + JSON.stringify(one));
            return list.map((g) => `${g.id} ${g.docs} docs ${g.pictures} with pictures`).join("; ");
        });
        await check("the_generations_name_their_mirror_files", () => {
            const keys = autosave.referencedKeys(dir);
            for (const k of ["input/inpaint_canvas/a_layer_1.png", "input/inpaint_canvas/b_base_0.png", "input/inpaint_canvas/d_layer_0.png", "input/inpaint_canvas/f_layer_0.png"]) assert(keys.includes(k), "missing " + k + ": " + keys.join(", "));
            assert(!keys.some((k) => /^input\/inpaint_canvas\/c_/.test(k)), "the current autosave's files are counted as a generation's");
            return `${keys.length} keys`;
        });

        // 2 -------------------------------------------------------------------------------------------------------
        await check("a_close_waits_for_the_save", async () => {
            const g = new QuitGuard({ timeoutMs: 1000 });
            assert(g.onClose() === "flush", "the first close does not flush");
            let saved = false;
            const run = g.run(async () => { await sleep(40); saved = true; return { ok: true }; });
            assert(g.onClose() === "ask", "a close during the save does not ask");
            assert(g.run(() => { throw new Error("a second save ran"); }) === run, "a second run started another save");
            const r = await run;
            assert(saved && r.ok && !r.timedOut && r.ms >= 30, "the save: " + JSON.stringify(r));
            assert(g.onClose() === "allow", "the close after the save is not allowed");
            return `${r.ms} ms`;
        });
        await check("a_save_that_hangs_or_fails_still_lets_the_window_close", async () => {
            const hang = new QuitGuard({ timeoutMs: 60 });
            const r1 = await hang.run(() => new Promise(() => {}));
            assert(r1.timedOut && !r1.ok && hang.onClose() === "allow", "a hanging save: " + JSON.stringify(r1));
            const bad = new QuitGuard({ timeoutMs: 1000 });
            const r2 = await bad.run(() => { throw new Error("disk full"); });
            assert(!r2.ok && /disk full/.test(r2.error) && bad.onClose() === "allow", "a failing save: " + JSON.stringify(r2));
            const rel = new QuitGuard();
            rel.release();
            assert(rel.onClose() === "allow", "a released guard still flushes");
            rel.reset();
            assert(rel.onClose() === "flush", "a reset guard does not save again");
            return "timeout and error both close; reset saves again";
        });
        await check("a_crashing_window_is_reloaded_then_safe_then_left", () => {
            let t = 1000;
            const c = new CrashGuard({ windowMs: 120000, now: () => t });
            const plans = [c.record(), (t += 5000, c.record()), (t += 5000, c.record())];
            assert(plans.join() === "reload,safe,stop", "plans: " + plans);
            t += 200000;
            assert(c.record() === "reload", "a crash long after the last is not a plain reload");
            assert(isCrash({ reason: "crashed" }) && isCrash({ reason: "oom" }) && !isCrash({ reason: "clean-exit" }) && !isCrash(null), "isCrash");
            return plans.join(" > ");
        });

        // 3 -------------------------------------------------------------------------------------------------------
        const main = read("electron/main/main.js");
        await check("main_prevents_a_close_until_the_window_saved", () => {
            const b = bodyAfter(main, /win\.on\("close", \(e\) => /);
            assert(b, "the close handler is not there");
            const agent = b.indexOf("if (agentMode)"), guard = b.indexOf("quitGuard.onClose()"), prevent = b.indexOf("e.preventDefault();", guard), flush = b.indexOf('quitGuard.run(() => flushWindow("quit"))'), close = b.indexOf("win.close()", flush);
            assert(agent >= 0 && guard > agent, "the guard is not asked after the agent branch");
            assert(prevent > guard && flush > prevent && close > flush, "the close is not prevented, saved, then closed again");
            assert(/if \(what === "allow"\) return;/.test(b), "an allowed close does not go through");
            assert(b.indexOf("mirror.localOnly = true") > prevent && b.indexOf("mirror.localOnly = true") < flush, "the close does not keep uploads local while it saves");
            assert(/if \(forAgents && \(agentMode \|\| local\.clients\.size \|\| windowVisible\(\)\)\) \{[^}]*quitGuard\.reset\(\); return; \}/.test(b), "an agent's quit does not re-check after the save");
            const files = read("electron/main/files.js");
            assert((files.match(/if \(this\.serverUp\(\) && !this\.localOnly\)/g) || []).length === 2, "the mirror's two upload routes do not stay local while the app quits");
            const rl = bodyAfter(main, /async function reloadWindow\(ignoreCache\) /);
            assert(rl && rl.indexOf('flushWindow("reload")') >= 0 && rl.indexOf('flushWindow("reload")') < rl.indexOf("webContents.reload()"), "View > Reload does not save first");
            assert(!/role: "reload"|role: "forceReload"/.test(main), "a menu role reloads without saving");
            return "agent, guard, prevent, local uploads, flush, re-check, close; reload saves first";
        });
        await check("an_update_installs_only_after_the_save", () => {
            const b = bodyAfter(main, /ipcMain\.handle\("update:install", async \(\) => /);
            assert(b, "update:install is not an async handler");
            const run = b.indexOf('await quitGuard.run(() => flushWindow("update"))'), install = b.indexOf("installOrReset()");
            assert(run >= 0 && install > run, "the install does not come after the awaited save");
            const io = bodyAfter(main, /function installOrReset\(\) /);
            assert(io && /const ok = updater\.install\(\);/.test(io) && /if \(!ok\) \{[^}]*quitGuard\.reset\(\)/.test(io) && /if \(!quitting\) \{[^}]*quitGuard\.reset\(\)/.test(io), "an install that does not quit leaves the guard latched");
            const r = bodyAfter(main, /ipcMain\.handle\("app:relaunch", \(\) => /);
            assert(r && r.indexOf("quitGuard.release()") >= 0 && r.indexOf("quitGuard.release()") < r.indexOf("installOrReset()"), "a restart does not release the guard before it installs");
            return "save, then install";
        });
        await check("a_crashed_window_is_reloaded_and_a_windowed_start_rotates", () => {
            const g = bodyAfter(main, /win\.webContents\.on\("render-process-gone", \(_e, d\) => /);
            assert(g && /crashGuard\.record\(\)/.test(g) && /win\.loadURL\(ORIGIN \+ "\/index\.html"\)/.test(g) && /autosave\.setAside\(/.test(g), "the crash handler does not record, set aside and reload");
            assert(/quitGuard\.done \|\| quitGuard\.flushing/.test(g), "a crash while closing would be reloaded");
            assert(/const done = \(\) => \{ quitGuard\.release\(\); if \(win && !win\.isDestroyed\(\)\) win\.destroy\(\); app\.quit\(\); \};/.test(g), "the third crash does not end an agent's instance");
            const s = bodyAfter(main, /function startApp\(\) /);
            assert(s && /^\{\s*(\/\/[^\n]*\n\s*)*try \{ autosave\.rotate\(/.test(s), "startApp does not rotate first thing");
            const p = bodyAfter(main, /ipcMain\.handle\("files:prune", \(_e, args\) => /);
            assert(p && /autosave\.referencedKeys\(/.test(p) && /keep: \[/.test(p), "pruning does not keep what the generations name");
            return "reload, rotate, prune";
        });
        const shell = read("renderer/shell.js");
        await check("the_window_answers_the_save_and_a_safe_start_restores_nothing", () => {
            const f = bodyAfter(shell, /window\.scumble\.state\.onFlush\(async \(reason\) => /);
            assert(f && /await saveBeforeRestart\(/.test(f), "the window does not save when main asks");
            const i = shell.indexOf("startMode = await window.scumble.state.startMode()"), l = shell.indexOf('const saved = startMode === "safe" ? null : await window.scumble.state.load();');
            assert(i >= 0 && l > i, "the start does not read the start mode before it loads the state");
            const pre = read("electron/preload.js");
            assert(/ipcRenderer\.send\("app:flushed", \{ id, \.\.\.r \}\)/.test(pre), "the preload does not answer app:flush");
            const sb = bodyAfter(shell, /async function saveBeforeRestart\(say = \(\) => \{\}, when = "the restart"\) /);
            assert(sb && sb.indexOf("host._restoring") >= 0 && sb.indexOf("host._restoring") < sb.indexOf("syncLayers"), "saveBeforeRestart does not wait for a restore");
            assert(/for \(let round = 0; round < 3/.test(sb), "saveBeforeRestart does not go again for changes made while it saved");
            const host = read("renderer/editor/host.js");
            const sa = bodyAfter(host, /\n    saveAll\(\) /);
            assert(sa && /if \(this\._restoring\) \{ this\._saveTimer = setTimeout\(\(\) => this\.saveAll\(\), 1500\); return; \}/.test(sa), "the autosave does not wait while documents are restored");
            const rs = bodyAfter(host, /\n    async restore\(saved\) /);
            assert(rs && /this\._restoring\+\+;/.test(rs) && /finally \{\s*this\._restoring--;/.test(rs), "restore does not hold the autosave");
            const bu = bodyAfter(host, /\n    bundle\(\) /);
            assert(bu && /this\._rawStates\.get\(ed\)/.test(bu), "the bundle drops a document that waits for ComfyUI");
            const ed = read("renderer/editor/inpaint_canvas.js");
            const once = bodyAfter(ed, /\n    async syncLayersOnce\(\) /);
            assert(once && /layer\.dirty = false;\s*try \{\s*const \{ ref \} = await uploadPixels\(layer\.px/.test(once) && /catch \(err\) \{\s*layer\.dirty = true;/.test(once), "a layer is not marked clean before its upload, or not again when it fails");
            assert(/syncLayers\(\) \{\s*const pass = \(this\._syncing \|\| Promise\.resolve\(\)\)/.test(ed), "syncLayers does not run one pass at a time");
            return "onFlush, startMode, restore holds the autosave, one upload pass at a time";
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const r of results) console.log(r);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
})();
