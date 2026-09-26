"""Quit safety (docs/PLAN_0_1_29.md §3, electron/main/quit.js and autosave.js): the app gate.

No ComfyUI and no key. First `node tools/quit_test.js` (the modules and the wiring), then the app, in instances this
gate starts and ends itself (its own profile and port; it never touches another instance):

1. a_close_right_after_a_stroke_keeps_it - a new paint layer and a stroke on it, and the window is closed at once
   (WM_CLOSE, as the close button and Alt+F4 send it), long before the layer's own upload 15 s later; the process
   ends by itself, and the next start shows the layer with the same pixels;
2. a_windowed_start_keeps_the_last_session - that second start made the first session's state generation 1;
   closed and started a third time with nothing changed, generation 1 stays and no generation 2 appears (the
   restore wrote the state back re-serialized, which is no new session);
2b. no_autosave_while_documents_are_restored - with a restore under way (host._restoring), a change reaches the
   autosave only once the restore is over;
3. a_crashed_window_comes_back_with_its_documents - the renderer is crashed (CDP Page.crash); main reloads the
   window, which restores the document with the same pixels, and the app log has the line;
4. a_second_crash_starts_empty_and_keeps_the_documents - crashed again at once, the window comes back without
   restoring and says so; the state is set aside, and Settings > Local files > Earlier states opens it again as a
   tab with the same pixels; the app log did not flood (a send to a crashed window once looped);
5. the_last_close_ends_the_process - a plain close of that window ends the app.

    python tools/quit_test.py [--exe PATH] [--size 1200x800] [--port 9572] [--out DIR] [--only close] [--no-node]

`--size 15000x10000 --only close` is the 15k measurement: how long the close waits for the save of a stroke on a
new layer of that size. The backend is the environment's (SCUMBLE_TILES, which tools/run_gates.sh --tiles sets).
"""
import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time

import aiohttp

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
from cdp import HOOK, Cdp  # noqa: E402

ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")

PRE = """(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const shell = await import('./shell.js');
    const host = (await import('./editor/host.js')).host;
    const cmds = await import('./commands.js');
    const run = (n, a) => cmds.commands.run(n, a || {});
    /** The layer's pixels at points along the stroke and off it: what has to come back. */
    const fingerprint = (L, W, H) => {
        const out = [];
        for (let i = 0; i <= 40; i++) {
            const x = Math.round(W * (0.2 + 0.6 * i / 40));
            for (const y of [Math.round(H / 2), Math.round(H / 2) + Math.round(H / 40), Math.round(H / 4)]) out.push(Array.from(L.px.readRect(x, y, 1, 1).data).join(","));
        }
        return out.join(" ");
    };
    const findLayer = () => {
        for (const ed of host.editors()) { const L = (ed.layers || []).find((l) => l.name === "quit-gate"); if (L) return { ed, L }; }
        return null;
    };
    __BODY__
})()"""

STROKE = """
const [W, H] = __SIZE__;
await run("new_canvas", { width: W, height: H, color: "#336699" });
const ed = host.editor;
const L = ed.addPaintLayer();
L.name = "quit-gate";
ed.activeLayerId = L.id;
ed.fitView(); ed.sceneSig = null; ed.draw(); await wait(150);
const rect = ed.canvas.getBoundingClientRect();
const client = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 17, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
ed.setTool("paint");
ed.color = "#ff2020"; ed.brushSize = Math.max(40, Math.round(W / 15)); ed.hardness = 1; ed.brushOpacity = 1;
const y = Math.round(H / 2), x0 = Math.round(W * 0.2), x1 = Math.round(W * 0.8);
ed.canvas.dispatchEvent(ev("pointerdown", x0, y));
for (let i = 1; i <= 12; i++) { ed.canvas.dispatchEvent(ev("pointermove", x0 + (x1 - x0) * i / 12, y)); await wait(16); }
ed.canvas.dispatchEvent(ev("pointerup", x1, y));
await wait(400);
const fp = fingerprint(L, W, H);
if (!/^255,/.test(fp.split(" ")[0]) && !fp.includes("255,32,32,255")) throw new Error("the stroke did not paint: " + fp.slice(0, 120));
return { fp, dirty: !!L.dirty, ref: L.ref ? L.ref.filename : null, tiles: ed.tileMode };
"""

HOLD = """
const f = findLayer();
const before = await window.scumble.state.load();
host._restoring++;
f.L.name = "quit-gate-held";
host.changed(f.ed);
await wait(2200);
const during = await window.scumble.state.load();
host._restoring--;
await wait(2200);
const after = await window.scumble.state.load();
f.L.name = "quit-gate";
host.changed(f.ed);
await wait(2000);
return { held: !during.includes("quit-gate-held") && during === before, saved: after.includes("quit-gate-held") };
"""

RESTORED = """
const [W, H] = __SIZE__;
const f = findLayer();
if (!f) return { found: false, docs: host.editors().map((e) => ({ base: !!e.base, layers: (e.layers || []).map((l) => l.name) })) };
return { found: true, fp: fingerprint(f.L, W, H), ref: f.L.ref ? f.L.ref.filename : null, status: f.ed.status || "" };
"""

GENERATIONS = """
return await window.scumble.state.generations();
"""

FLUSH = """
await shell.saveBeforeRestart();
return 1;
"""

SAFE = """
const log = await window.scumble.log.list({ after: 0 });
return {
    docs: host.editors().map((e) => ({ base: !!e.base, layers: (e.layers || []).map((l) => l.name) })),
    status: (host.editor && host.editor.status) || "",
    gens: await window.scumble.state.generations(),
    log: log.filter((e) => /renderer ended/.test(e.message)).map((e) => e.message),
};
"""

REOPEN = """
const [W, H] = __SIZE__;
await shell.openSettings();
const sel = document.getElementById("set-gens");
for (let i = 0; i < 50 && !Array.from(sel.options).some((o) => o.value === "crash"); i++) await wait(100);
if (!Array.from(sel.options).some((o) => o.value === "crash")) throw new Error("Earlier states has no crash state: " + Array.from(sel.options).map((o) => o.value + ":" + o.textContent).join(" | "));
sel.value = "crash";
document.getElementById("set-gens-open").click();
let f = null;
for (let i = 0; i < 100 && !(f = findLayer()); i++) await wait(100);
const note = document.getElementById("set-gens-note").textContent;
const d = document.getElementById("shell-settings"); if (d && d.open) d.close();
if (!f) throw new Error("the crash state did not open: " + note);
for (let i = 0; i < 50 && !f.ed.base; i++) await wait(100);
return { fp: fingerprint(f.L, W, H), note };
"""


def close_window(pid):
    """Post WM_CLOSE to the process's visible top-level windows: what the close button and Alt+F4 do. (A page's
    window.close() is not the same: Electron closes the window without its close event.)"""
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def each(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            found.append((hwnd, buf.value))
        return True

    user32.EnumWindows(each, 0)
    for hwnd, _ in found:
        user32.PostMessageW(hwnd, 0x0010, 0, 0)
    if not found:
        raise RuntimeError(f"no visible window of process {pid}")
    return [t for _, t in found]


class App:
    """One instance of the app on the gate's profile and port."""

    def __init__(self, args, label):
        self.args = args
        self.label = label
        self.proc = None
        self.session = None
        self.ws = None
        self.c = None

    def start(self):
        cmd = [self.args.exe] if self.args.exe else [ELECTRON, "."]
        cmd += [f"--remote-debugging-port={self.args.port}", f"--user-data-dir={self.args.profile}", "--no-comfy"]
        logf = open(os.path.join(self.args.out, f"app_{self.label}.log"), "w", encoding="utf-8", errors="replace")
        self.proc = subprocess.Popen(cmd, cwd=ROOT, stdout=logf, stderr=subprocess.STDOUT)
        return self

    async def connect(self, timeout=120):
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                if self.session is None:
                    self.session = aiohttp.ClientSession()
                async with self.session.get(f"http://127.0.0.1:{self.args.port}/json") as r:
                    targets = await r.json()
                page = next((t for t in targets if t.get("type") == "page" and str(t.get("url", "")).startswith("scumble://app")), None)
                if page:
                    if self.ws is not None and not self.ws.closed:
                        await self.ws.close()
                    self.ws = await self.session.ws_connect(page["webSocketDebuggerUrl"], max_msg_size=64 * 1024 * 1024)
                    self.c = Cdp(self.ws)
                    ready = await asyncio.wait_for(self.c.eval("(async () => { await import('./shell.js'); return 'ready'; })()", timeout=90), 95)
                    if ready == "ready":
                        await self.c.eval(HOOK)
                        return
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(0.5)
        raise RuntimeError(f"the app ({self.label}) did not come up on port {self.args.port}")

    async def ev(self, body, timeout=180):
        js = PRE.replace("__BODY__", body.replace("__SIZE__", json.dumps(self.args.size)))
        return await self.c.eval(js, timeout=timeout)

    async def fire(self, expr):
        """Evaluate without waiting for an answer (the page goes away)."""
        self.c.n += 1
        await self.ws.send_json({"id": self.c.n, "method": "Runtime.evaluate", "params": {"expression": expr}})

    def wait_exit(self, timeout):
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return None

    async def close_io(self):
        try:
            if self.ws is not None and not self.ws.closed:
                await self.ws.close()
        except Exception:  # noqa: BLE001
            pass
        if self.session is not None:
            await self.session.close()
            self.session = None

    def kill(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()


class Gate:
    def __init__(self, args):
        self.args = args
        self.results = []

    def step(self, name, ok, detail=""):
        self.results.append(ok)
        print(f"[{'ok' if ok else 'FAIL'}] {name}{(': ' + str(detail)) if detail else ''}", flush=True)

    async def run(self):
        if not self.args.no_node:
            r = subprocess.run(["node", os.path.join(HERE, "quit_test.js")], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120)
            tail = r.stdout.strip()
            if r.returncode != 0 or not tail.endswith("PASS"):
                print("[FAIL] node: " + (tail + r.stderr)[-1500:])
                print("FAIL")
                return False
            print("[ok] node: %d checks" % tail.count("[ok]"), flush=True)
        a = b = None
        try:
            # 1: a stroke, and the window closed at once
            a = App(self.args, "first").start()
            await a.connect()
            before = await a.ev(STROKE)
            print(f"  stroke on {self.args.size[0]} x {self.args.size[1]} ({'tiles' if before['tiles'] else 'canvas'}): layer dirty {before['dirty']}, uploaded {before['ref']}", flush=True)
            t0 = time.time()
            close_window(a.proc.pid)
            code = a.wait_exit(300)
            closed = time.time() - t0
            await a.close_io()
            if code is None:
                self.step("a_close_right_after_a_stroke_keeps_it", False, f"the app did not end within 300 s of the close")
                return self.finish()
            b = App(self.args, "second").start()
            await b.connect()
            after = await b.ev(RESTORED)
            ok = after.get("found") and after.get("fp") == before["fp"]
            self.step("a_close_right_after_a_stroke_keeps_it", ok, f"closed in {closed:.1f} s (exit {code}); " + ("the same pixels" if ok else json.dumps(after)[:600]))
            if self.args.only == "close":
                return await self.finish_with(b)
            # 2: the rotation at that start, and none at a third start with nothing changed
            gens = await b.ev(GENERATIONS)
            one = next((g for g in gens if g["id"] == "1"), None)
            await asyncio.sleep(2.5)                 # the restore's own autosave, written back
            close_window(b.proc.pid)
            b.wait_exit(300)
            await b.close_io()
            b = App(self.args, "third").start()
            await b.connect()
            gens3 = await b.ev(GENERATIONS)
            ids3 = [g["id"] for g in gens3]
            ok = bool(one and one["pictures"] >= 1) and ids3 == ["1"]
            self.step("a_windowed_start_keeps_the_last_session", ok, f"second start {json.dumps([(g['id'], g['docs'], g['pictures']) for g in gens])}, third {ids3}")
            hold = await b.ev(HOLD)
            self.step("no_autosave_while_documents_are_restored", hold["held"] and hold["saved"], json.dumps(hold))
            # 3: a crash, and the window back with the document
            await b.ev(FLUSH)
            try:
                await asyncio.wait_for(b.c.call("Page.crash"), 5)
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(2)
            await b.connect()
            back = await b.ev(RESTORED)
            ok = back.get("found") and back.get("fp") == before["fp"]
            self.step("a_crashed_window_comes_back_with_its_documents", ok, "the same pixels" if ok else json.dumps(back)[:600])
            # 4: a second crash at once: back without restoring, the state set aside and opened again
            try:
                await asyncio.wait_for(b.c.call("Page.crash"), 5)
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(2)
            await b.connect()
            safe = await b.ev(SAFE)
            problems = []
            if any(d["base"] for d in safe["docs"]):
                problems.append("a document was restored: " + json.dumps(safe["docs"]))
            if "crashed twice" not in safe["status"]:
                problems.append("the status says " + json.dumps(safe["status"]))
            crash = next((g for g in safe["gens"] if g["id"] == "crash"), None)
            if not crash or crash["pictures"] < 1:
                problems.append("no crash state with a picture: " + json.dumps(safe["gens"]))
            if len(safe["log"]) < 2:
                problems.append("the app log has " + json.dumps(safe["log"]))
            # a crashed window has no frame to send the log to: that must not become a loop of failed sends
            logs = os.path.join(self.args.profile, "logs")
            size = sum(os.path.getsize(os.path.join(logs, f)) for f in os.listdir(logs)) if os.path.isdir(logs) else 0
            if size > 200 * 1024:
                problems.append(f"the app log grew to {size // 1024} KB over two crashes")
            if not problems:
                reopened = await b.ev(REOPEN)
                if reopened["fp"] != before["fp"]:
                    problems.append("the reopened layer's pixels differ")
            self.step("a_second_crash_starts_empty_and_keeps_the_documents", not problems, "; ".join(problems) if problems else "empty start, crash state reopened with the same pixels")
            # 5: a plain close ends it
            t0 = time.time()
            close_window(b.proc.pid)
            code = b.wait_exit(300)
            await b.close_io()
            self.step("the_last_close_ends_the_process", code is not None, f"in {time.time() - t0:.1f} s (exit {code})")
            b = None
        except Exception as err:  # noqa: BLE001
            self.step("gate", False, str(err)[:900])
        finally:
            for x in (a, b):
                if x is not None:
                    await x.close_io()
                    x.kill()
        return self.finish()

    async def finish_with(self, app):
        t0 = time.time()
        close_window(app.proc.pid)
        app.wait_exit(300)
        await app.close_io()
        app.kill()
        print(f"  (closed the second instance in {time.time() - t0:.1f} s)")
        return self.finish()

    def finish(self):
        ok = bool(self.results) and all(self.results)
        print("PASS" if ok else "FAIL")
        return ok


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--exe", default=None)
    p.add_argument("--size", default="1200x800")
    p.add_argument("--port", type=int, default=int(os.environ.get("SCUMBLE_CDP_PORT", "9555")) + 17)
    p.add_argument("--out", default=os.path.join(ROOT, "dist", "gates", "quit"))
    p.add_argument("--only", default=None, choices=[None, "close"])
    p.add_argument("--no-node", action="store_true", help="skip tools/quit_test.js (a mutation round checks the app steps alone)")
    args = p.parse_args()
    args.size = [int(v) for v in args.size.lower().split("x")]
    if args.exe:
        args.exe = os.path.abspath(args.exe)   # Windows resolves a relative program against this process, not cwd
    os.makedirs(args.out, exist_ok=True)
    args.profile = os.path.join(args.out, "profile")
    appdata = os.environ.get("APPDATA", "")
    for name in ("Scumble", "Scumble Store"):
        if appdata and os.path.normcase(os.path.abspath(args.profile)) == os.path.normcase(os.path.join(appdata, name)):
            raise SystemExit("refusing the user's own profile")
    shutil.rmtree(args.profile, ignore_errors=True)
    os.makedirs(args.profile, exist_ok=True)
    sys.stdout.reconfigure(encoding="utf-8")
    ok = asyncio.run(Gate(args).run())
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
