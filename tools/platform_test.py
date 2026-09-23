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
