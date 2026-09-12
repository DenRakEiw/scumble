"""The app's log against the running app (see tools/cdp.py for the setup).

No ComfyUI and no key needed: an entry from the renderer (console.error in the page), one from
the main process (a provider run that fails before any network call), both read back through
the log IPC and the read_log command, the file under <userData>/logs holding them, the rotation
at 1 MB, the console dialog (filter by level and text, Escape closes it), and the status line
hook (a title with the full text, an error logged).

    python tools/log_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

PRE = """(async () => {
    const raw = await import('./commands.js'); const c = (n, a) => raw.commands.run(n, a || {});
    const shell = await import('./shell.js');
    const host = (await import('./editor/host.js')).host;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    %s
})()"""

MARK = "log_test %d" % int(time.time())

STEPS = [
    ("renderer_and_main_entries", """
const before = await window.scumble.log.list({});
if (!before.some((e) => /log started/.test(e.message) && e.source === "main")) throw new Error("no 'log started' line from the main process");
console.error("%(mark)s renderer error", { some: "detail" });
// a provider run that fails in the main process before any network call: no key stored
let err = null;
try { await window.scumble.providers.edit({ provider: "fal", model: "x", prompt: "p", image: new Uint8Array(4) }); } catch (e) { err = String(e.message || e); }
await wait(400);
const all = await window.scumble.log.list({ after: before[before.length - 1].id });
const r = all.find((e) => e.source === "renderer" && e.level === "error" && e.message.includes("%(mark)s renderer error"));
const m = all.find((e) => e.level === "error" && e.source !== "renderer" && /No API key|fal/i.test(e.message));
if (!r) throw new Error("the renderer's console.error did not reach the log: " + JSON.stringify(all.map((e) => [e.source, e.message.slice(0, 60)])));
if (!m) throw new Error("the failed provider run did not reach the log: " + JSON.stringify(all.map((e) => [e.source, e.message.slice(0, 60)])) + " / " + err);
if (!r.message.includes('"some":"detail"')) throw new Error("the console.error's object argument is missing: " + r.message);
window.__logMark = "%(mark)s";
return { renderer: r.message.slice(0, 80), main: [m.source, m.message.slice(0, 80)], total: all.length };
""" % {"mark": MARK}),
    ("read_log_command", """
const r = await c("read_log", { level: "error", limit: 50 });
if (!r.entries.length || !r.entries.every((e) => e.level === "error")) throw new Error("read_log level filter: " + JSON.stringify(r.entries.slice(0, 3)));
if (!r.entries.some((e) => e.message.includes(window.__logMark))) throw new Error("read_log misses the test entry");
if (!r.file || !/scumble\\.log$/.test(r.file)) throw new Error("no file path: " + r.file);
window.__logFile = r.file;
return { errors: r.entries.length, total: r.total, file: r.file };
"""),
    ("status_line_hook", """
const d = await c("new_document");
window.__logDoc = d.id;
const ed = host.editors().find((e) => e.node.id === d.id);
host.shell.activate(ed);
await c("new_canvas", { width: 256, height: 256, doc: d.id });
const last = (await window.scumble.log.list({})).slice(-1)[0].id;
ed.setStatus("Error invoking remote method 'provider:edit': Error: Comfy Cloud GeminiNanoBanana2V2: error - " + window.__logMark);
await wait(300);
const title = ed.statusEl.title;
const logged = (await window.scumble.log.list({ after: last })).find((e) => e.source === "status" && e.message.includes(window.__logMark));
if (!title.includes("GeminiNanoBanana2V2")) throw new Error("the status line has no title: " + title);
if (!logged) throw new Error("the error status was not logged");
if (ed.statusEl.style.cursor !== "pointer") throw new Error("the status line is not clickable");
return { title: title.slice(0, 60), logged: logged.level };
"""),
    ("console_dialog", """
await shell.openConsole();
await wait(200);
const dlg = document.querySelector("#log-dialog[open]");
if (!dlg) throw new Error("the console did not open");
const rows = () => dlg.querySelectorAll(".log-entry").length;
const all = rows();
document.getElementById("log-filter").value = window.__logMark + " renderer";
document.getElementById("log-filter").dispatchEvent(new Event("input"));
const filtered = rows();
document.getElementById("log-level").value = "error";
document.getElementById("log-level").dispatchEvent(new Event("change"));
const errorsOnly = rows();
document.getElementById("log-filter").value = "";
document.getElementById("log-filter").dispatchEvent(new Event("input"));
const allErrors = rows();
const infoShown = Array.from(dlg.querySelectorAll(".log-entry")).some((r) => r.classList.contains("log-info"));
document.getElementById("log-level").value = "all";
document.getElementById("log-level").dispatchEvent(new Event("change"));
// the status line click opens it too (already open: stays open)
if (all < 3 || filtered !== 1 || errorsOnly !== 1 || infoShown || allErrors < 2) throw new Error(JSON.stringify({ all, filtered, errorsOnly, allErrors, infoShown }));
return { all, filtered, errorsOnly, allErrors };
"""),
]

AFTER_ESCAPE = """
if (document.querySelector("#log-dialog[open]")) throw new Error("the console is still open after Escape");
return { closed: true };
"""

ROTATION = """
const big = "x".repeat(1900);
for (let i = 0; i < 620; i++) await window.scumble.log.add({ level: "info", source: "rotation", message: big + " " + i });
await wait(1500);
return { file: await window.scumble.log.file() };
"""


async def main():
    sys.stdout.reconfigure(encoding="utf-8")

    async def run(cdp):
        ev = cdp.eval
        await ev("(async () => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); window.__log = window.__log || []; return 1; })()")
        failed = 0
        for name, body in STEPS:
            try:
                res = await ev(PRE % body, timeout=120)
                print(f"PASS {name}: {json.dumps(res)[:300]}")
            except Exception as err:  # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {err}")
                break
        if failed:
            print("RESULT FAIL")
            return False
        try:
            for kind in ("keyDown", "keyUp"):
                await cdp.call("Input.dispatchKeyEvent", type=kind, key="Escape", code="Escape", windowsVirtualKeyCode=27, nativeVirtualKeyCode=27)
            await asyncio.sleep(0.3)
            print(f"PASS escape_closes_the_console: {json.dumps(await ev(PRE % AFTER_ESCAPE, timeout=30))}")
            # the file holds the entries
            path = await ev("window.__logFile")
            await asyncio.sleep(0.5)
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
            if MARK + " renderer error" not in text:
                raise RuntimeError("the renderer entry is not in the file " + path)
            if "ERROR [status]" not in text:
                raise RuntimeError("the status entry is not in the file")
            print(f"PASS file_holds_the_entries: {path} ({len(text)} bytes)")
            # rotation: more than a megabyte of lines
            r = await ev(PRE % ROTATION, timeout=120)
            rotated = os.path.join(os.path.dirname(path), "scumble.1.log")
            if not os.path.exists(rotated):
                raise RuntimeError("no scumble.1.log after writing past 1 MB")
            size = os.path.getsize(path)
            if size > 1024 * 1024 + 4096:
                raise RuntimeError("the current file did not shrink: %d bytes" % size)
            print(f"PASS rotation: current {size} bytes, {os.path.getsize(rotated)} bytes rotated")
            await ev(PRE % 'await c("close_document", { doc: window.__logDoc, force: true }); return 1;')
        except Exception as err:  # noqa: BLE001
            print(f"FAIL: {err!r}")
            print("RESULT FAIL")
            return False
        print("RESULT PASS")
        return True

    return await session(run)


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()) else 1)
