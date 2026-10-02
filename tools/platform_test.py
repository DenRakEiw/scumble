"""The per-platform parts of the build and of the app (B1 + B2, docs/PLAN_0_1_24.md).

No ComfyUI, no key. First `node tools/platform_test.js` (the MCP registration of every platform, the files each
installer leaves out), then the app:

- what the API keys section says for every credential store: the Windows and macOS stores and a Linux keyring
  plainly, no store at all and Linux' `basic_text` fallback (obfuscated, not encrypted) as a warning;
- the Settings dialog shows the note for this machine's real store, and on Windows that is DPAPI, not a warning;
- the Updates section of the Microsoft Store copy (electron/main/msix.js) offers no check, no switch and no GitHub
  text, and the installer's section comes back unchanged; this instance is not the Store copy.

    python tools/platform_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
"""
import asyncio
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STEPS = [
    ("the_keys_note_warns_where_keys_are_not_encrypted", """
const cases = [
    [{ available: true, backend: "dpapi" }, false, /encrypted with the system credential store \\(dpapi\\)/],
    [{ available: true, backend: "keychain" }, false, /\\(keychain\\)/],
    [{ available: true, backend: "gnome_libsecret" }, false, /\\(gnome_libsecret\\)/],
    [{ available: true, backend: "kwallet6" }, false, /\\(kwallet6\\)/],
    [{ available: true, backend: "basic_text" }, true, /obfuscated, not encrypted/],
    [{ available: false, backend: "unavailable" }, true, /keys cannot be saved/],
    [null, true, /keys cannot be saved/],
];
const out = [];
for (const [info, warn, re] of cases) {
    const n = shell.keysNote(info);
    if (n.warn !== warn || !re.test(n.text)) throw new Error(JSON.stringify(info) + ": " + JSON.stringify(n));
    if (warn === false && /obfuscated|cannot/.test(n.text)) throw new Error("a good store reads as a bad one: " + n.text);
    out.push((info && info.backend) + (n.warn ? " warns" : " ok"));
}
return out;
"""),
    ("the_settings_dialog_shows_this_machines_store", """
const info = await window.scumble.keys.list();
await shell.openSettings();
await wait(300);
const el = document.getElementById("set-keys-note");
const want = shell.keysNote(info);
const read = () => ({ text: el.textContent, warn: el.classList.contains("shell-warn"), colour: getComputedStyle(el).color });
const res = { backend: info.backend, ...read() };
// the section as a Linux desktop without a keyring would show it, then back to this machine's store
shell.showKeysNote({ available: true, backend: "basic_text" });
const bad = read();
shell.showKeysNote(info);
const back = read();
document.getElementById("shell-settings").close();
if (res.text !== want.text || res.warn !== want.warn) throw new Error(JSON.stringify(res) + " against " + JSON.stringify(want));
if (navigator.platform.startsWith("Win") && (info.backend !== "dpapi" || res.warn)) throw new Error("Windows without DPAPI: " + JSON.stringify(res));
if (!bad.warn || !/obfuscated/.test(bad.text) || bad.colour === res.colour) throw new Error("basic_text does not read as a warning: " + JSON.stringify(bad));
if (JSON.stringify(back) !== JSON.stringify({ text: res.text, warn: res.warn, colour: res.colour })) throw new Error("the warning stayed: " + JSON.stringify(back));
return { ...res, basic_text: bad.colour };
"""),
]

STEPS.append(("the_store_copy_leaves_its_updates_to_the_store", """
const info = await window.scumble.info();
if (info.store !== false) throw new Error("a dev instance reads as the Store copy: " + JSON.stringify(info));
await shell.openSettings();
await wait(300);
const ids = ["set-update-check", "set-update-help"];
const read = () => ({
    note: document.getElementById("set-update-note").textContent,
    hidden: ids.map((id) => document.getElementById(id).hidden).concat(document.getElementById("set-update-auto").parentElement.hidden),
});
const before = await window.scumble.updates.status();
const own = read();
shell.renderUpdate({ state: "store", current: "0.1.27", version: null, percent: null, error: null, manual: false });
const store = read();
shell.renderUpdate(before);
const back = read();
document.getElementById("shell-settings").close();
if (JSON.stringify(own.hidden) !== "[false,false,false]") throw new Error("this instance hides its updates: " + JSON.stringify(own));
if (JSON.stringify(store.hidden) !== "[true,true,true]" || !/Microsoft Store/.test(store.note) || /GitHub/.test(store.note)) throw new Error("the Store copy still offers GitHub updates: " + JSON.stringify(store));
if (JSON.stringify(back) !== JSON.stringify(own)) throw new Error("the section did not come back: " + JSON.stringify(back) + " against " + JSON.stringify(own));
return { state: before.state, store: store.note };
"""))

# the question when an update is downloaded (CLAUDE.md item 32, renderer/shell.js announceUpdate): once per version,
# never after a check the user started, a version main says was asked about or a skipped one; Skip writes
# settings.updates.skip and main's status carries it (the install on quit is tools/updater_test.js); the question waits
# for another one; a working document is asked about before the restart. A raw string: its JS has \n escapes
STEPS.append(("the_update_question_asks_once", r"""
const { host } = await import("./editor/host.js");
const dialogs = await import("./dialogs.js");
const keep = (await window.scumble.settings.get()).updates || {};
const boxes = () => Array.from(document.querySelectorAll("dialog.sc-dialog")).map((d) => d.querySelector("div").shadowRoot);
const read = (r) => ({
    title: (r.querySelector(".title") || {}).textContent || "",
    message: (r.querySelector(".message") || {}).textContent || "",
    detail: (r.querySelector(".detail") || {}).textContent || "",
    buttons: Array.from(r.querySelectorAll("button")).map((b) => b.textContent),
});
const press = (r, label) => Array.from(r.querySelectorAll("button")).find((b) => b.textContent === label).click();
const until = async (fn, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(100)) { const v = fn(); if (v) return v; } return null; };
const fake = (version, more = {}) => ({ state: "downloaded", current: "0.1.37", version, percent: 100, error: null, manual: false, skip: null, announced: null, notes: "• One. More.\n• Two. More.", headlines: ["One.", "Two."], ...more });
// a question that must not come: answered "open" after 1.5 s instead of hanging the step until c.eval's timeout
const notAsked = (s) => Promise.race([shell.announceUpdate(s), wait(1500).then(() => "open")]);
if (dialogs.openCount()) throw new Error("a question is open before the step");
// a packaged instance (--exe) checks GitHub 8 s after its start: its statuses would replace the step's fake ones
for (const end = Date.now() + 30000; Date.now() < end && ["checking", "downloading"].includes((await window.scumble.updates.status()).state);) await wait(250);
const out = {};
try {
    // asked once, with the version, the leads and what Later and Skip do
    const p1 = shell.announceUpdate(fake("9.9.1"));
    const b1 = await until(() => boxes()[0]);
    if (!b1) throw new Error("no question for a downloaded update");
    const r1 = read(b1);
    if (r1.title !== "Scumble 9.9.1 is ready" || JSON.stringify(r1.buttons) !== JSON.stringify(["Restart and update", "Later", "Skip this version"])) throw new Error("the question: " + JSON.stringify(r1));
    if (!/You have 0\.1\.37/.test(r1.message) || !r1.detail.startsWith("What changed:\n• One.\n• Two.") || !/Later installs it when you close Scumble/.test(r1.detail)) throw new Error("the text: " + JSON.stringify(r1));
    // it opens unasked: the focus is on Later, so a key the user was typing never restarts the app
    const focused = b1.activeElement && b1.activeElement.textContent;
    if (focused !== "Later") throw new Error("the focus is on " + focused);
    press(b1, "Later");
    if ((await p1) !== 1) throw new Error("Later did not answer 1");
    out.asked = r1.title;
    if ((await window.scumble.updates.status()).announced !== "9.9.1") throw new Error("main does not keep the version asked about");
    // not again: the same version, one main says was asked, a check the user started, a skipped one, a download running
    const none = [fake("9.9.1"), fake("9.9.2", { announced: "9.9.2" }), fake("9.9.3", { manual: true }), fake("9.9.4", { skip: "9.9.4" }), fake("9.9.5", { state: "downloading" })];
    for (const s of none) {
        const r = await notAsked(s);
        if (r !== false || boxes().length) throw new Error("asked about " + JSON.stringify(s) + ": " + r);
    }
    // Skip writes the setting, and main's status carries it (main.js settings:set -> updater.setSkip)
    const p2 = shell.announceUpdate(fake("9.9.6"));
    const b2 = await until(() => boxes()[0]);
    if (!b2) throw new Error("no question for 9.9.6");
    press(b2, "Skip this version");
    if ((await p2) !== 2) throw new Error("Skip did not answer 2");
    const stored = (await window.scumble.settings.get()).updates || {};
    const st = await window.scumble.updates.status();
    if (stored.skip !== "9.9.6" || st.skip !== "9.9.6" || stored.check !== keep.check) throw new Error("the skip: " + JSON.stringify({ stored, skip: st.skip }));
    out.skip = stored.skip;
    // a version skipped in the settings is not asked about either
    await shell.skipUpdate("9.9.7");
    if ((await notAsked(fake("9.9.7"))) !== false || boxes().length) throw new Error("asked about a version the settings skip");
    // notes without leads: cut near 1,500 characters at a line break (every bullet shown whole), the rest named;
    // more than eight leads are counted
    const long = ("• " + "x".repeat(90) + "\n").repeat(40);
    const d1 = shell.updateQuestionDetail({ notes: long });
    const shown = d1.split("\n").filter((l) => l.startsWith("• "));
    if (d1.length > 1800 || !/\n• x{90}\n…, the rest in Settings › Updates\./.test(d1) || !shown.length || shown.some((l) => l !== "• " + "x".repeat(90))) throw new Error("the long notes: " + d1.length + " " + JSON.stringify(d1.slice(-160)));
    const d2 = shell.updateQuestionDetail({ headlines: Array.from({ length: 12 }, (_, i) => "Lead " + (i + 1) + ".") });
    if (!/• Lead 8\.\n… and 4 more in Settings › Updates\./.test(d2) || /Lead 9/.test(d2)) throw new Error("twelve leads: " + JSON.stringify(d2));
    const d3 = shell.updateQuestionDetail({});
    if (/What changed/.test(d3) || !/^Later installs it/.test(d3)) throw new Error("no notes: " + JSON.stringify(d3));
    // it waits for another question and comes once that is answered
    const other = dialogs.ask({ title: "Another question", buttons: ["OK"] });
    const p3 = shell.announceUpdate(fake("9.9.8"));
    await wait(1500);
    const during = boxes().map((r) => read(r).title);
    if (JSON.stringify(during) !== JSON.stringify(["Another question"])) throw new Error("asked over another question: " + JSON.stringify(during));
    press(boxes()[0], "OK");
    await other;
    const b3 = await until(() => boxes()[0]);
    if (!b3 || read(b3).title !== "Scumble 9.9.8 is ready") throw new Error("no question after the other one closed");
    press(b3, "Later");
    await p3;
    // a working document is asked about before the restart (an API run, and a render on the user's ComfyUI, which
    // busy() does not see); Cancel keeps the app running
    let ed = host.editor, made = false;
    if (!ed) { ed = shell.newDocument(); made = true; }
    const pending = ed.providerPending, runs = ed._localRuns;
    const cases = [["9.9.9", () => { ed.providerPending = { test: true }; }], ["9.9.10", () => { ed._localRuns = new Set(["test-prompt"]); }]];
    out.busy = [];
    try {
        for (const [v, setUp] of cases) {
            setUp();
            const p4 = shell.announceUpdate(fake(v));
            const b4 = await until(() => boxes()[0]);
            if (!b4) throw new Error("no question for " + v);
            press(b4, "Restart and update");
            const c = await until(() => { const r = boxes()[0]; return r && /still working/.test(read(r).message) ? r : null; });
            if (!c) throw new Error("no question about the working document (" + v + "): " + JSON.stringify(boxes().map(read)));
            const rc = read(c);
            if (JSON.stringify(rc.buttons) !== JSON.stringify(["Restart and update", "Cancel"]) || !/^A document is still working\. Restart and update anyway\?$/.test(rc.message)) throw new Error("the busy question: " + JSON.stringify(rc));
            press(c, "Cancel");
            if ((await p4) !== 0) throw new Error("Restart and update did not answer 0");
            out.busy.push(v);
            ed.providerPending = pending;
            ed._localRuns = runs;
        }
    } finally {
        ed.providerPending = pending;
        ed._localRuns = runs;
        if (made) await shell.closeDocument(ed, true);
    }
    if (dialogs.openCount()) throw new Error("a question stayed open");
} finally {
    // a question still waiting gives up on the real status (dev: never "downloaded"), an open one is cancelled
    // (a fake idle one, never the real status: on the exe that may be a real download)
    shell.announceUpdate({ state: "idle" });
    await wait(700);
    dialogs.cancelAll();
    await shell.skipUpdate(keep.skip || null);
    await window.scumble.updates.announced(null);
}
const back = (await window.scumble.settings.get()).updates || {};
if (JSON.stringify(back) !== JSON.stringify(keep)) throw new Error("the settings did not come back: " + JSON.stringify(back) + " against " + JSON.stringify(keep));
return out;
"""))

PRE = """(async () => {
    const shell = window.__shell;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    %s
})()"""


def node_step():
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "platform_test.js")], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120)
    tail = r.stdout.strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        raise Exception("tools/platform_test.js: " + (tail + r.stderr)[-1500:])
    return {"checks": tail.count("[ok]")}


async def run_all(c):
    ok = True
    try:
        print("[ok] node: %s" % json.dumps(node_step()))
    except Exception as err:  # noqa: BLE001
        print("[FAIL] node: %s" % err)
        print("FAIL")
        return False
    await c.eval("(async () => { window.__shell = await import('./shell.js'); return 1; })()")
    for name, body in STEPS:
        try:
            res = await c.eval(PRE % body, timeout=60)
            print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:300]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            break
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
