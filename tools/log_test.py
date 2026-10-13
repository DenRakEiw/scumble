"""The app's log against the running app (see tools/cdp.py for the setup).

No ComfyUI and no key needed: an entry from the renderer (console.error in the page), one from
the main process (a provider run that fails before any network call), both read back through
the log IPC and the read_log command, the file under <userData>/logs holding them, the rotation
at 1 MB, the console dialog (filter by level and text, Escape closes it), the status line
hook (a title with the full text, an error logged), and the status kinds of item 45 (an error
or a missing download red with five blinks, steady after, plain again at the next line, no
blink under reduced motion; set_status's kind).

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
// the scheme's COOP / COEP headers (docs/PLAN_BCE.md §E1): the window is cross-origin isolated and says so in the log
if (!crossOriginIsolated) throw new Error("the window is not cross-origin isolated");
if (!before.some((e) => e.message === "cross-origin isolated: true" && e.source === "renderer")) throw new Error("no 'cross-origin isolated: true' line from the renderer");
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
    ("status_kinds", """
// item 45: an error or warning line shows red (the skin's --sc-error) and blinks five times, then stays red until
// the next line; an explicit kind beats the text; the log takes the kind's level
const ed = host.editors().find((e) => e.node.id === window.__logDoc);
const s = ed.statusEl;
const has = (cls) => s.classList.contains(cls);
const blinks = () => s.getAnimations().filter((a) => a.animationName === "ipc-status-blink");
const last = (await window.scumble.log.list({})).slice(-1)[0].id;
if (!has("ipc-statusline")) throw new Error("the status span has no ipc-statusline class: " + s.className);
ed.setStatus("Saved.");
if (has("ipc-status-error") || has("ipc-status-blink") || ed.statusKind !== "") throw new Error("a plain line is marked: " + s.className + " / " + ed.statusKind);
const plain = getComputedStyle(s).color;
const probe = document.createElement("span");
probe.style.color = "var(--sc-error, #e0533d)";
s.parentNode.appendChild(probe);
const red = getComputedStyle(probe).color;
probe.remove();
// the user's line of 2026-10-11: a missing download counts as an error
ed.setStatus("Depth estimation needs Depth Anything V2 Small: download it in Settings > Helpers. " + window.__logMark);
const a1 = blinks();
if (ed.statusKind !== "warn" || !has("ipc-status-error") || !has("ipc-status-blink")) throw new Error("the download line is not marked: " + ed.statusKind + " / " + s.className);
if (a1.length !== 1) throw new Error("the download line has " + a1.length + " blink animations");
if (getComputedStyle(s).animationIterationCount !== "5") throw new Error("the blink runs " + getComputedStyle(s).animationIterationCount + " times");
if (getComputedStyle(s).color !== red || red === plain) throw new Error("the colour: " + getComputedStyle(s).color + ", --sc-error " + red + ", plain " + plain);
if (ed.nodeStatus && !ed.nodeStatus.classList.contains("ipc-status-error")) throw new Error("the node thumbnail's line is not marked");
await wait(700);
const again = "Error: the same failure again " + window.__logMark;
ed.setStatus(again);
const a2 = blinks();
if (ed.statusKind !== "error" || a2.length !== 1 || a2[0] === a1[0]) throw new Error("a second error did not restart the blink: " + ed.statusKind + " / " + a2.length);
// a caller that repeats the same line while it blinks (the object tool asks on every pointer move) keeps the blink
await wait(300);
ed.setStatus(again);
if (blinks().length !== 1 || blinks()[0] !== a2[0]) throw new Error("the same line again restarted the blink");
// five pulses of 0.6 s: over after 3 s, the line steady red at full opacity, the blink class gone
await wait(3200);
if (blinks().length || has("ipc-status-blink") || !has("ipc-status-error") || getComputedStyle(s).opacity !== "1" || getComputedStyle(s).color !== red) throw new Error("not steady red after the blink: " + blinks().length + " / " + s.className + " / " + getComputedStyle(s).opacity);
// a tab hidden and shown again (display: none and back) does not blink its old line anew
const bar = s.parentNode;
bar.style.display = "none";
getComputedStyle(s).display;
bar.style.display = "";
getComputedStyle(s).display;
if (blinks().length) throw new Error("an old error line blinked again after display none and back");
// the same line after its blink is a new error: it blinks again
ed.setStatus(again);
if (blinks().length !== 1) throw new Error("the same error after its blink did not blink");
ed.setStatus("Error invoking nothing: a hint the caller calls plain " + window.__logMark, "info");
if (ed.statusKind !== "" || has("ipc-status-error") || has("ipc-status-blink")) throw new Error("kind info did not keep the line plain");
ed.setStatus("The lights are off.", { kind: "error" });
if (ed.statusKind !== "error" || !has("ipc-status-error")) throw new Error("kind error on a plain text did not mark it");
ed.setStatus("Ready.");
if (has("ipc-status-error") || has("ipc-status-blink") || getComputedStyle(s).color !== plain) throw new Error("the next plain line did not clear the mark");
// the command
const r = await c("set_status", { doc: window.__logDoc, text: "An agent's error " + window.__logMark, kind: "error" });
if (r.kind !== "error" || !has("ipc-status-error")) throw new Error("set_status kind error: " + JSON.stringify(r));
let bad = null;
try { await c("set_status", { doc: window.__logDoc, text: "x", kind: "loud" }); } catch (e) { bad = String(e.message || e); }
if (!/kind must be/.test(bad || "")) throw new Error("set_status took kind loud: " + bad);
const r2 = await c("set_status", { doc: window.__logDoc, text: "Back to normal." });
if (r2.kind !== "info" || has("ipc-status-error")) throw new Error("set_status without a kind: " + JSON.stringify(r2));
await wait(300);
const logged = (await window.scumble.log.list({ after: last })).filter((e) => e.source === "status" && e.message.includes(window.__logMark));
const level = (re) => (logged.find((e) => re.test(e.message)) || {}).level;
if (level(/^Depth estimation/) !== "warn" || level(/^Error: the same/) !== "error" || level(/^An agent's error/) !== "error") throw new Error("the log levels: " + JSON.stringify(logged.map((e) => [e.level, e.message.slice(0, 30)])));
if (logged.some((e) => /a hint the caller calls plain/.test(e.message))) throw new Error("a line marked info was logged as an error");
return { red, plain, iterations: 5, logged: logged.map((e) => e.level) };
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

REDUCED = """
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) throw new Error("the emulated reduced motion did not reach the page");
const ed = host.editors().find((e) => e.node.id === window.__logDoc);
const s = ed.statusEl;
ed.setStatus("Failed: under reduced motion");
const n = s.getAnimations().length;
const red = s.classList.contains("ipc-status-error");
const name = getComputedStyle(s).animationName;
ed.setStatus("Ready.");
if (n !== 0 || !red || name !== "none") throw new Error(JSON.stringify({ animations: n, red, name }));
return { animations: n, red, name };
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
            # item 45 under reduced motion: still red, no blink
            await cdp.call("Emulation.setEmulatedMedia", features=[{"name": "prefers-reduced-motion", "value": "reduce"}])
            try:
                print(f"PASS status_reduced_motion: {json.dumps(await ev(PRE % REDUCED, timeout=30))}")
            finally:
                await cdp.call("Emulation.setEmulatedMedia", features=[])
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
