r"""The portable copy on the packaged exe (docs/PLAN_0_1_42.md P3, CLAUDE.md item 36): the gate `portable`.

A copy of Scumble with portable.txt beside Scumble.exe keeps everything it stores in the `data` folder beside it
(electron/main/portable.js, P1; the zip of P2 ships such a copy). This gate starts copies the way a user does, WITHOUT
--user-data-dir, so it is the one gate that could reach the user's own %APPDATA%\Scumble if the detection failed: a
windowed start there rotates the user's autosave at once (main.js startApp) and takes the user's instance lock. Hence:

- It refuses, starting nothing and reading nothing under %APPDATA%, without --exe, and while any Scumble.exe runs (the
  user's window, a headless or MCP-started one, another gate's exe). Run it alone or only with gates that start no
  app (`lint`, `types`, `quit`, `document` start their own instances only while they run; never in one runner call
  with app gates, whose runner instance is a Scumble.exe itself).
- Step 1 snapshots %APPDATA%\Scumble and copies its settings.json and autosave files into a folder of their own
  (dist/gates/portable-backup/<time>, kept across runs: the runner wipes a label's folder at its start), so a failed
  detection can be put right by hand. The gate itself never writes under %APPDATA%.
- Before the first windowed start, two starts that cannot rotate anything: the exe's own resolver in its Node mode
  (ELECTRON_RUN_AS_NODE, the built app.asar's portable.js with the copy's real exe path; nothing of Electron starts),
  then `--cmd ping --attach-only` (an agent start that never starts the app): the copy's data folder must appear and
  %APPDATA%\Scumble must stay as it was. Every windowed start then reads app:info.userData first; when it is not the
  copy's data folder the instance is ended at once (killed: a close would let its window write its state into the
  folder it found) and the gate stops.
- The cleanup takes the deny entry off C (icacls /remove:d, then /reset) before it deletes the staged copies, and
  stops every instance it started by WM_CLOSE (the quit gate's way; a kill only when that does not end it).

The steps (the plan's ten):
 1. the_users_folder_is_snapshotted_and_copied - entry names, sizes and times of %APPDATA%\Scumble (recursive), the
    top-level names of %APPDATA% and %LOCALAPPDATA%; the copy of settings.json and autosave*.json;
 2. two_copies_are_staged - A and B: the --exe's folder copied to <out>\A\Scumble and <out>\B\Scumble with the marker
    (electron/main/portable.js MARKER_TEXT, the zip's bytes);
 3. a_marked_copy_keeps_its_data_beside_it - the two safe starts above, then A started with --no-comfy and a DevTools
    port: app:info.userData is A\Scumble\data (portable true), data\Local State and data\settings.json are there;
 4. a_setting_survives_a_restart - the assistant's step limit changed through the Settings field's own change
    listener (the shell's path), in A's settings.json; WM_CLOSE; a new start shows it in the field;
 5. the_last_session_comes_back_from_the_data_folder - a new canvas, a stroke on a paint layer, its autosave in A's
    data; WM_CLOSE; the next start says "Last session restored." with the same pixels;
 6. a_document_saves_and_opens_beside_the_copy - save_document to A\docs\portable-gate.scumble, the tab closed,
    open_document: the same pixels;
 7. two_copies_run_side_by_side - B started beside A (its own data folder and instance lock); `Scumble.exe --cmd ping
    --attach-only` from each copy's exe answers from its own instance (ping names no pid, so each instance holds a
    canvas only it has: A 640 x 400, B 333 x 222);
 8. the_mcp_registration_names_the_copys_exe - Help > Copy MCP registration (both entries) clicked in A's main process
    through its Node inspector (--inspect on A's last start, port +21), with clipboard.writeText swapped for a
    recorder while it runs: the user's clipboard is never written. Both texts name A's exe and A's launcher;
    8b. the_copy_only_says_that_an_update_is_out - A's update status: mode notify, never downloading or downloaded
    (P1's note for P3; the start's check ran 8 s after the start);
 9. a_folder_it_cannot_write_to_stops_it - a third copy C whose folder denies this account writing
    (icacls C /deny <sid>:(OI)(CI)(WD,AD,WEA,WA); measured 2026-10-05: the plan's plain `W` also denies running the
    exe, WinError 5): the error box comes up (a window of C's process, caption "Error" or the box's title), the gate
    presses its OK, the process ends with 1, C has no data folder, and its stderr line names C's data folder;
10. the_users_folder_is_untouched - the snapshot again: %APPDATA%\Scumble unchanged (names, sizes, times), no new
    Scumble names in %APPDATA% or %LOCALAPPDATA%, and the Scumble-named ones there unchanged.

    python tools/portable_test.py --exe dist/win-unpacked/Scumble.exe [--out DIR] [--base 9555] [--keep] [--no-node]

Ports: A on base + 19, B on base + 20, A's inspector on base + 21 (base: SCUMBLE_CDP_PORT, else 9555). `--keep` keeps
the staged copies (the deny entry is always taken off); `--no-node` skips tools/platform_test.js (a mutation round of
the resolver, which runs first otherwise: no packaged copy starts without --user-data-dir while it is red).
"""
import argparse
import asyncio
import csv
import ctypes
import io
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
from ctypes import wintypes

import aiohttp

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
from cdp import HOOK, Cdp  # noqa: E402

SYSTEM32 = os.path.join(os.environ.get("SystemRoot") or os.environ.get("windir") or r"C:\Windows", "System32")
MARKER = "portable.txt"
DATA = "data"
BOX_TITLE = "Scumble cannot use its folder"
BOX_CAPTIONS = (BOX_TITLE, "Error")   # Electron's error box may carry "Error" as its caption and the title as its heading
DENY_RIGHTS = "(OI)(CI)(WD,AD,WEA,WA)"
LAYER = "portable-gate"
SIZE_A = [640, 400]
SIZE_B = [333, 222]
STEPS_VALUE = 37                         # the assistant's step limit (default 25): the setting of step 4
REG_ITEMS = {"code": "Copy MCP registration (Claude Code)", "desktop": "Copy MCP registration (Claude Desktop JSON)"}

WM_CLOSE = 0x0010
WM_COMMAND = 0x0111
TDM_CLICK_BUTTON = 0x0400 + 102
IDOK = 1

PRE = r"""(async () => {
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
        for (const ed of host.editors()) { const L = (ed.layers || []).find((l) => l.name === "portable-gate"); if (L) return { ed, L }; }
        return null;
    };
    __BODY__
})()"""

SET_STEPS = r"""
const el = document.getElementById("set-as-steps");
if (!el) throw new Error("no #set-as-steps field");
el.value = String(__VALUE__);
el.dispatchEvent(new Event("change"));
for (let i = 0; i < 100; i++) {
    const s = await window.scumble.settings.get();
    if (s.assistant && s.assistant.maxSteps === __VALUE__) return { stored: s.assistant.maxSteps };
    await wait(100);
}
throw new Error("the field's change did not reach the settings: " + JSON.stringify((await window.scumble.settings.get()).assistant || null));
"""

GET_STEPS = r"""
await shell.openSettings();
await wait(400);
const field = document.getElementById("set-as-steps").value;
const d = document.getElementById("shell-settings"); if (d && d.open) d.close();
const s = await window.scumble.settings.get();
return { field, stored: s.assistant ? s.assistant.maxSteps : null };
"""

STROKE = r"""
const [W, H] = __SIZE__;
await run("new_canvas", { width: W, height: H });
const ed = host.editor;
const L = ed.addPaintLayer();
L.name = "portable-gate";
ed.activeLayerId = L.id;
ed.fitView(); ed.sceneSig = null; ed.draw(); await wait(150);
const rect = ed.canvas.getBoundingClientRect();
const client = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 19, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
ed.setTool("paint");
ed.color = "#ff2020"; ed.brushSize = Math.max(40, Math.round(W / 15)); ed.hardness = 1; ed.brushOpacity = 1;
const y = Math.round(H / 2), x0 = Math.round(W * 0.2), x1 = Math.round(W * 0.8);
ed.canvas.dispatchEvent(ev("pointerdown", x0, y));
for (let i = 1; i <= 12; i++) { ed.canvas.dispatchEvent(ev("pointermove", x0 + (x1 - x0) * i / 12, y)); await wait(16); }
ed.canvas.dispatchEvent(ev("pointerup", x1, y));
await wait(400);
host.changed(ed);
const fp = fingerprint(L, W, H);
if (!/^255,/.test(fp.split(" ")[0]) && !fp.includes("255,32,32,255")) throw new Error("the stroke did not paint: " + fp.slice(0, 120));
return { fp, tiles: ed.tileMode };
"""

RESTORED = r"""
const seen = [];
let f = null;
for (let i = 0; i < 300; i++) {
    f = findLayer();
    for (const e of host.editors()) { const s = e.status || ""; if (s && !seen.includes(s)) seen.push(s); }
    if (f && f.ed.base && seen.some((s) => /Last session restored/.test(s))) break;
    await wait(100);
}
if (!f) return { found: false, seen, docs: host.editors().map((e) => ({ base: !!e.base, layers: (e.layers || []).map((l) => l.name) })) };
return { found: true, seen };
"""

FINGERPRINT = r"""
const [W, H] = __SIZE__;
const f = findLayer();
return f && f.ed.base ? fingerprint(f.L, W, H) : null;
"""

SAVE_OPEN = r"""
const [W, H] = __SIZE__;
const P = __PATH__;
const f = findLayer();
if (!f) throw new Error("no portable-gate layer to save");
if (host.editor !== f.ed) shell.activate(f.ed);
const s = await run("save_document", { path: P });
await run("close_document", {});
if (findLayer()) throw new Error("the tab with the layer did not close");
const o = await run("open_document", { path: P });
let g = null;
for (let i = 0; i < 300; i++) { g = findLayer(); if (g && g.ed.base && !g.ed._loading) break; await wait(100); }
const out = { saved: { path: s.path, bytes: s.bytes }, opened: { file: o.file, already: !!o.already, notes: o.notes || [] }, found: !!g };
if (g) { await wait(300); out.fp = fingerprint(g.L, W, H); }
return out;
"""

NEW_CANVAS = r"""
const [W, H] = __SIZE__;
await run("new_canvas", { width: W, height: H });
return { width: host.editor.width, height: host.editor.height };
"""

INFO = "return await window.scumble.info();"
UPDATES = "return await window.scumble.updates.status();"

# In A's main process (its Node inspector): click both Help > Copy MCP registration entries with clipboard.writeText
# swapped for a recorder, so the user's clipboard is never written; refuses to click when the swap does not take.
REGISTRATION = r"""(() => {
    const req = typeof require === "function" ? require : (process.mainModule ? process.mainModule.require.bind(process.mainModule) : null);
    if (!req) return { error: "no require in the main process's console" };
    const { Menu, clipboard } = req("electron");
    const find = (m, label) => { for (const it of (m ? m.items : [])) { if (it.label === label) return it; const x = it.submenu ? find(it.submenu, label) : null; if (x) return x; } return null; };
    const menu = Menu.getApplicationMenu();
    const items = __ITEMS__;
    const orig = clipboard.writeText;
    let got = null;
    const fake = function (t) { got = String(t); };
    try { clipboard.writeText = fake; } catch (e) { return { error: "clipboard.writeText cannot be replaced: " + e.message }; }
    if (clipboard.writeText !== fake) return { error: "clipboard.writeText cannot be replaced, so a click would write the user's clipboard: not clicked" };
    const out = { exe: process.execPath };
    try {
        for (const [k, label] of Object.entries(items)) {
            const it = find(menu, label);
            got = null;
            if (it) it.click();
            out[k] = it ? got : { missing: label };
        }
    } finally {
        clipboard.writeText = orig;
    }
    out.restored = clipboard.writeText === orig;
    return out;
})()"""

# The built resolver in the exe's own Node mode: nothing of Electron starts, nothing is written.
RESOLVER = (
    "const path=require('path'),fs=require('fs');"
    "const p=require(path.join(process.resourcesPath,'app.asar','electron','main','portable.js'));"
    "process.stdout.write(JSON.stringify(p.userData({packaged:true,platform:process.platform,execPath:process.execPath,"
    "store:false,userDataSwitch:false,appData:process.env.APPDATA||'',exists:fs.existsSync,realpath:fs.realpathSync.native})))"
)


class Stop(Exception):
    """Ends the gate at once (the step's name and why); the cleanup still runs."""

    def __init__(self, name, detail):
        super().__init__(detail)
        self.name = name
        self.detail = detail


# ---- processes and windows (Windows only) ---------------------------------------------------------------------------

class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG), ("dwFlags", wintypes.DWORD),
                ("szExeFile", wintypes.WCHAR * 260)]


def scumble_processes():
    """Every running Scumble.exe: [{pid, ppid, path}]. Raises when the process list cannot be read."""
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    for fn in (k32.Process32FirstW, k32.Process32NextW):
        fn.restype = wintypes.BOOL
        fn.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)   # TH32CS_SNAPPROCESS
    if not snap or snap == ctypes.c_void_p(-1).value:
        raise OSError(f"CreateToolhelp32Snapshot failed ({ctypes.get_last_error()})")
    found = []
    try:
        e = PROCESSENTRY32W()
        e.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = k32.Process32FirstW(snap, ctypes.byref(e))
        if not ok:
            raise OSError(f"Process32FirstW failed ({ctypes.get_last_error()})")
        while ok:
            if e.szExeFile.lower() == "scumble.exe":
                found.append({"pid": int(e.th32ProcessID), "ppid": int(e.th32ParentProcessID), "path": None})
            ok = k32.Process32NextW(snap, ctypes.byref(e))
    finally:
        k32.CloseHandle(snap)
    for p in found:
        h = k32.OpenProcess(0x1000, False, p["pid"])   # PROCESS_QUERY_LIMITED_INFORMATION
        if h:
            try:
                buf = ctypes.create_unicode_buffer(32768)
                n = wintypes.DWORD(32768)
                if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
                    p["path"] = buf.value
            finally:
                k32.CloseHandle(h)
    return found


def describe_processes(procs):
    pids = {p["pid"] for p in procs}
    roots = [p for p in procs if p["ppid"] not in pids] or procs
    more = len(procs) - len(roots)
    text = "; ".join(f"pid {p['pid']} {p['path'] or '(path not readable)'}" for p in roots[:4])
    if len(roots) > 4:
        text += f"; and {len(roots) - 4} more"
    return text + (f" (and {more} child process{'es' if more != 1 else ''})" if more > 0 else "")


def _user32():
    user32 = ctypes.windll.user32
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.PostMessageW.restype = wintypes.BOOL
    return user32


def windows_of(pid):
    """The visible top-level windows of a process: [(hwnd, title, class)]."""
    user32 = _user32()
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def each(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            found.append((hwnd, buf.value, cls.value))
        return True

    user32.EnumWindows(each, 0)
    return found


def close_window(pid):
    """Post WM_CLOSE to the process's visible top-level windows: what the close button and Alt+F4 do (a page's
    window.close() is not the same: Electron closes the window without its close event)."""
    user32 = _user32()
    found = windows_of(pid)
    for hwnd, _, _ in found:
        user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
    if not found:
        raise RuntimeError(f"no visible window of process {pid}")
    return [t for _, t, _ in found]


def press_ok(proc, hwnd):
    """The error box's OK: a task dialog's TDM_CLICK_BUTTON, then a classic box's IDOK, then WM_CLOSE. Returns the
    message that ended the process, or None."""
    user32 = _user32()
    for name, msg, wp in (("TDM_CLICK_BUTTON", TDM_CLICK_BUTTON, IDOK), ("WM_COMMAND IDOK", WM_COMMAND, IDOK), ("WM_CLOSE", WM_CLOSE, 0)):
        user32.PostMessageW(hwnd, msg, wp, 0)
        try:
            proc.wait(timeout=6)
            return name
        except subprocess.TimeoutExpired:
            pass
    return None


# ---- files ----------------------------------------------------------------------------------------------------------

def norm(p):
    try:
        p = os.path.realpath(p)
    except (OSError, ValueError):
        pass
    return os.path.normcase(os.path.normpath(p))


def same_path(a, b):
    return bool(a) and bool(b) and norm(a) == norm(b)


def inside(child, parent):
    c, p = norm(child), norm(parent)
    return c == p or c.startswith(p.rstrip("\\/") + os.sep)


def tree(root):
    """{relative path: (mtime_ns, size)} of every entry under root (sizes of folders 0), or None without the folder."""
    if not os.path.isdir(root):
        return None
    out = {}
    for d, dirs, files in os.walk(root):
        for n in dirs:
            p = os.path.join(d, n)
            try:
                out[os.path.relpath(p, root)] = (os.stat(p, follow_symlinks=False).st_mtime_ns, 0)
            except OSError:
                out[os.path.relpath(p, root)] = None
        for n in files:
            p = os.path.join(d, n)
            try:
                st = os.stat(p, follow_symlinks=False)
                out[os.path.relpath(p, root)] = (st.st_mtime_ns, st.st_size)
            except OSError:
                out[os.path.relpath(p, root)] = None
    return out


def top(folder):
    """{name: mtime_ns} of a folder's top level."""
    out = {}
    try:
        names = os.listdir(folder)
    except OSError:
        return out
    for n in names:
        try:
            out[n] = os.stat(os.path.join(folder, n), follow_symlinks=False).st_mtime_ns
        except OSError:
            out[n] = None
    return out


def rmtree(p):
    """Remove a staged copy (read-only files too), with a few tries while the processes that held it end."""
    def again(func, path, _exc):
        try:
            os.chmod(path, stat.S_IWRITE)
            func(path)
        except OSError:
            pass
    for _ in range(6):
        if not os.path.exists(p):
            return True
        try:
            if sys.version_info >= (3, 12):
                shutil.rmtree(p, onexc=again)
            else:
                shutil.rmtree(p, onerror=again)
        except OSError:
            pass
        if not os.path.exists(p):
            return True
        time.sleep(2)
    return not os.path.exists(p)


def child_env(node=False):
    env = dict(os.environ)
    env.pop("ELECTRON_RUN_AS_NODE", None)   # set, the exe would run as Node instead of the app
    if node:
        env["ELECTRON_RUN_AS_NODE"] = "1"
    return env


def first_json(text):
    i = text.find("{")
    if i < 0:
        return None
    try:
        return json.loads(text[i:])
    except ValueError:
        return None


def user_sid():
    """This account for icacls: *<SID> (from whoami.exe; Git Bash has a whoami of its own), else DOMAIN\\user."""
    try:
        r = subprocess.run([os.path.join(SYSTEM32, "whoami.exe"), "/user", "/fo", "csv", "/nh"], capture_output=True, timeout=30)
        for row in csv.reader(io.StringIO(r.stdout.decode("oem", errors="replace"))):
            for f in row:
                if f.startswith("S-1-"):
                    return "*" + f.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    dom, user = os.environ.get("USERDOMAIN", ""), os.environ.get("USERNAME", "")
    return f"{dom}\\{user}" if dom else user


def icacls(*a):
    r = subprocess.run([os.path.join(SYSTEM32, "icacls.exe"), *a], capture_output=True, timeout=300)
    return r.returncode, (r.stdout + r.stderr).decode("oem", errors="replace").strip()


def port_in_use(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


# ---- one instance ---------------------------------------------------------------------------------------------------

class App:
    """One windowed instance of a staged copy, started without --user-data-dir."""

    def __init__(self, gate, label, exe, port, extra=()):
        self.gate, self.label, self.exe, self.port, self.extra = gate, label, exe, port, list(extra)
        self.proc = None
        self.logf = None
        self.session = None
        self.ws = None
        self.c = None
        self.killed = False

    def start(self):
        cmd = [self.exe, f"--remote-debugging-port={self.port}", "--no-comfy", *self.extra]
        self.logf = open(os.path.join(self.gate.out, f"app_{self.label}.log"), "w", encoding="utf-8", errors="replace")
        self.proc = subprocess.Popen(cmd, cwd=os.path.dirname(self.exe), stdout=self.logf, stderr=subprocess.STDOUT, env=child_env())
        self.gate.started.append(self)
        print(f"  started {self.label} (pid {self.proc.pid}): {' '.join(cmd[1:])}", flush=True)
        return self

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    async def connect(self, timeout=120):
        """The page's app:info as soon as the window's preload answers (before the shell has loaded)."""
        t0 = time.time()
        while time.time() - t0 < timeout:
            if not self.alive():
                raise RuntimeError(f"{self.label} ended (exit {self.proc.returncode}) before its window answered (app_{self.label}.log)")
            try:
                if self.session is None:
                    self.session = aiohttp.ClientSession()
                async with self.session.get(f"http://127.0.0.1:{self.port}/json", timeout=aiohttp.ClientTimeout(total=3)) as r:
                    targets = await r.json()
                page = next((t for t in targets if t.get("type") == "page" and str(t.get("url", "")).startswith("scumble://app")
                             and "comfybar.html" not in str(t.get("url", ""))), None)
                if page:
                    if self.ws is not None and not self.ws.closed:
                        await self.ws.close()
                    self.ws = await self.session.ws_connect(page["webSocketDebuggerUrl"], max_msg_size=64 * 1024 * 1024)
                    self.c = Cdp(self.ws)
                    info = await self.c.eval("window.scumble.info()", timeout=15)
                    if isinstance(info, dict):
                        return info
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(0.3)
        raise RuntimeError(f"the app ({self.label}) did not come up on port {self.port}")

    async def ready(self):
        r = await asyncio.wait_for(self.c.eval("(async () => { await import('./shell.js'); return 'ready'; })()", timeout=90), 95)
        if r != "ready":
            raise RuntimeError(f"{self.label}: the shell did not load ({r})")
        await self.c.eval(HOOK)

    async def ev(self, body, timeout=180, **subs):
        js = PRE.replace("__BODY__", body)
        for k, v in subs.items():
            js = js.replace(f"__{k.upper()}__", json.dumps(v))
        return await self.c.eval(js, timeout=timeout)

    def wait_exit(self, timeout):
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return None

    async def close(self, timeout=180):
        """WM_CLOSE, then the wait for the process to end: its exit code, or None."""
        close_window(self.proc.pid)
        code = self.wait_exit(timeout)
        await self.close_io()
        return code

    def kill(self):
        if self.alive():
            self.proc.kill()
            self.killed = True

    async def close_io(self):
        try:
            if self.ws is not None and not self.ws.closed:
                await self.ws.close()
        except Exception:  # noqa: BLE001
            pass
        if self.session is not None:
            await self.session.close()
            self.session = None
        if self.logf is not None and self.proc is not None and self.proc.poll() is not None:
            self.logf.close()
            self.logf = None


# ---- the gate -------------------------------------------------------------------------------------------------------

class Gate:
    def __init__(self, args):
        self.args = args
        self.out = args.out
        self.results = []
        self.started = []        # every App this gate started
        self.c_proc = None       # copy C (it never opens a window of its own)
        self.c_log = None
        self.deny = None         # the folder that carries the gate's deny entry
        self.sid = None
        self.appdata = os.environ["APPDATA"]
        self.local = os.environ["LOCALAPPDATA"]
        self.user_dir = os.path.join(self.appdata, "Scumble")
        self.src = os.path.dirname(args.exe)
        self.root = {k: os.path.join(self.out, k) for k in ("A", "B", "C")}
        self.exe = {k: os.path.join(v, "Scumble", "Scumble.exe") for k, v in self.root.items()}
        self.data = {k: os.path.join(v, "Scumble", DATA) for k, v in self.root.items()}
        self.before = None

    def step(self, name, ok, detail=""):
        self.results.append(ok)
        print(f"[{'ok' if ok else 'FAIL'}] {name}{(': ' + str(detail)) if detail != '' else ''}", flush=True)

    def snapshot(self):
        return {"tree": tree(self.user_dir), "appdata": top(self.appdata), "local": top(self.local)}

    def differences(self, a, b):
        problems, notes = [], []
        ta, tb = a["tree"], b["tree"]
        if ta is None and tb is not None:
            problems.append(f"{self.user_dir} was made ({len(tb)} entries)")
        elif ta is not None and tb is None:
            problems.append(f"{self.user_dir} is gone")
        elif ta is not None:
            added = sorted(set(tb) - set(ta))
            gone = sorted(set(ta) - set(tb))
            changed = sorted(k for k in set(ta) & set(tb) if ta[k] != tb[k])
            for label, keys in (("new", added), ("gone", gone), ("changed", changed)):
                if keys:
                    problems.append(f"{label} under %APPDATA%\\Scumble: " + ", ".join(keys[:8]) + (f" (+{len(keys) - 8} more)" if len(keys) > 8 else ""))
        for label, x, y in (("%APPDATA%", a["appdata"], b["appdata"]), ("%LOCALAPPDATA%", a["local"], b["local"])):
            new = sorted(set(y) - set(x))
            mine = [n for n in new if "scumble" in n.lower()]
            if mine:
                problems.append(f"new in {label}: {', '.join(mine)}")
            if len(new) > len(mine):
                notes.append(f"other new names in {label} (not Scumble's): {', '.join(n for n in new if n not in mine)[:300]}")
            for n in sorted(x):
                if "scumble" not in n.lower():
                    continue
                if n not in y:
                    problems.append(f"{label}\\{n} is gone")
                elif x[n] != y[n]:
                    problems.append(f"{label}\\{n} changed (its time)")
        return problems, notes

    def foreign(self):
        """Scumble.exe processes that are not this gate's copies."""
        return [p for p in scumble_processes() if not (p["path"] and inside(p["path"], self.out))]

    def check_home(self, app, info, key, name):
        """The first thing after a windowed start: this copy's data folder, or the instance ends at once and the gate stops."""
        got = (info or {}).get("userData")
        if same_path(got, self.data[key]) and (info or {}).get("portable") is True:
            return
        app.kill()   # at once: a close would let the window's quit flush write its state into the folder it found
        raise Stop(name, f"{app.label}'s userData is {got} (portable {(info or {}).get('portable')}), not {self.data[key]}: it was "
                         f"ended at once (killed) and the gate stops. The user's settings.json and autosave files were copied "
                         f"to {self.args.backup} before any start")

    async def start_checked(self, key, label, port, name, extra=()):
        app = App(self, label, self.exe[key], port, extra).start()
        info = await app.connect()
        self.check_home(app, info, key, name)
        await app.ready()
        return app, info

    async def run(self):
        try:
            await self.steps()
        except Stop as s:
            self.step(s.name, False, s.detail)
        except Exception as err:  # noqa: BLE001
            self.step("gate", False, f"{type(err).__name__}: {err}"[:1200])
        finally:
            await self.cleanup()
        return self.finish()

    async def steps(self):
        a = self.args
        # 0: the resolver in plain Node first (P1's tests): no packaged copy starts without --user-data-dir while it is red
        if not a.no_node:
            r = subprocess.run(["node", os.path.join(HERE, "platform_test.js")], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
            tail = (r.stdout or "").strip()
            if r.returncode != 0 or not tail.endswith("PASS"):
                raise Stop("node", "tools/platform_test.js is red, so no copy is started: " + (tail + (r.stderr or ""))[-1200:])
            self.step("node", True, "tools/platform_test.js, %d checks" % tail.count("[ok]"))

        # 1: the user's folder as it is, and a copy of what a failed detection would touch first
        self.before = self.snapshot()
        os.makedirs(a.backup, exist_ok=True)
        copied = []
        if os.path.isdir(self.user_dir):
            for n in sorted(os.listdir(self.user_dir)):
                if n == "settings.json" or (n.startswith("autosave") and n.endswith(".json")):
                    shutil.copy2(os.path.join(self.user_dir, n), os.path.join(a.backup, n))
                    copied.append(n)
        t = self.before["tree"]
        self.step("1 the_users_folder_is_snapshotted_and_copied", True,
                  (f"{len(t)} entries under {self.user_dir}" if t is not None else f"no {self.user_dir}")
                  + f", {len(self.before['appdata'])} names in %APPDATA%, {len(self.before['local'])} in %LOCALAPPDATA%; "
                  + f"copied {', '.join(copied) or 'nothing (no settings or autosave files)'} to {a.backup}")

        # 2: copies A and B with the marker
        r = subprocess.run(["node", "-e", "process.stdout.write(require('./electron/main/portable').MARKER_TEXT)"], cwd=ROOT, capture_output=True, timeout=60)
        marker = r.stdout
        if r.returncode != 0 or not marker.startswith(b"Scumble, portable copy."):
            raise Stop("2 two_copies_are_staged", "the marker text could not be read from electron/main/portable.js: " + (r.stderr or b"").decode("utf-8", "replace")[-400:])
        t0 = time.time()
        for k in ("A", "B"):
            shutil.copytree(self.src, os.path.dirname(self.exe[k]))
            with open(os.path.join(os.path.dirname(self.exe[k]), MARKER), "wb") as f:
                f.write(marker)
        size = sum(os.path.getsize(os.path.join(d, n)) for d, _, fs in os.walk(os.path.dirname(self.exe["A"])) for n in fs)
        self.step("2 two_copies_are_staged", True, f"A and B under {self.out}, {size / 1048576:.0f} MB each with the {len(marker)}-byte marker, {time.time() - t0:.1f} s")

        # 3: the copy keeps its data beside it; first two starts that can rotate nothing, then the window
        name = "3 a_marked_copy_keeps_its_data_beside_it"
        others = self.foreign()
        if others:
            raise Stop(name, "a Scumble.exe started while the copies were staged (" + describe_processes(others) + "): nothing was started")
        r = subprocess.run([self.exe["A"], "-e", RESOLVER], cwd=os.path.dirname(self.exe["A"]), env=child_env(node=True), capture_output=True, timeout=60)
        home = first_json(r.stdout.decode("utf-8", "replace"))
        if not home or home.get("from") != "portable" or not same_path(home.get("dir"), self.data["A"]):
            raise Stop(name, f"the exe's own resolver (Node mode, nothing of the app started) says {home or r.stdout[-300:]!r} "
                             f"{r.stderr.decode('utf-8', 'replace')[-300:]}: no copy was started")
        t_before = tree(self.user_dir)
        try:
            r = subprocess.run([self.exe["A"], "--cmd", "ping", "--attach-only"], cwd=os.path.dirname(self.exe["A"]), env=child_env(), capture_output=True, timeout=120)
            agent = (r.returncode, (r.stdout + r.stderr).decode("utf-8", "replace").strip())
        except subprocess.TimeoutExpired:
            agent = (None, "no answer in 120 s")
        if tree(self.user_dir) != t_before:
            raise Stop(name, f"the agent start of A (--cmd ping --attach-only, which never starts the app) changed {self.user_dir}: "
                             f"the detection failed; no window was started (exit {agent[0]}: {agent[1][-300:]})")
        if not os.path.isdir(self.data["A"]) or agent[0] != 1 or "not running" not in agent[1]:
            raise Stop(name, f"the agent start of A made no {self.data['A']} or did not say that no Scumble runs (exit {agent[0]}: {agent[1][-400:]}): no window was started")
        app, info = await self.start_checked("A", "A1", a.port_a, name)
        files = {}
        for _ in range(100):
            files = {n: os.path.exists(os.path.join(self.data["A"], n)) for n in ("Local State", "settings.json")}
            if all(files.values()):
                break
            await asyncio.sleep(0.2)
        upd = await app.ev(UPDATES)
        self.mode = (upd or {}).get("mode")
        self.step(name, True, f"the Node-mode resolver and the agent start name {self.data['A']}; app:info.userData is it (portable "
                              f"{info.get('portable')}); " + ", ".join(f"{n} {'there' if v else 'not yet'}" for n, v in files.items())
                              + f"; Crashpad {'there' if os.path.isdir(os.path.join(self.data['A'], 'Crashpad')) else 'not there'}; update mode {self.mode}")
        files_later = not all(files.values())

        # 4: a setting changed through the Settings field's own listener survives a restart
        name = "4 a_setting_survives_a_restart"
        v = await app.ev(SET_STEPS, value=STEPS_VALUE)
        try:
            with open(os.path.join(self.data["A"], "settings.json"), encoding="utf-8") as f:
                in_file = (json.load(f).get("assistant") or {}).get("maxSteps")
        except (OSError, ValueError) as err:
            in_file = f"unreadable: {err}"
        code = await app.close()
        if files_later:
            files = {n: os.path.exists(os.path.join(self.data["A"], n)) for n in ("Local State", "settings.json")}
            self.step("3b the_data_folder_holds_its_files", all(files.values()), "after the first close: " + ", ".join(f"{n} {'there' if x else 'missing'}" for n, x in files.items()))
        if code is None:
            raise Stop(name, "A did not end within 180 s of WM_CLOSE")
        app, _ = await self.start_checked("A", "A2", a.port_a, name)
        back = await app.ev(GET_STEPS)
        ok = v.get("stored") == STEPS_VALUE and in_file == STEPS_VALUE and back.get("stored") == STEPS_VALUE and str(back.get("field")) == str(STEPS_VALUE)
        self.step(name, ok, f"the step limit {STEPS_VALUE}: in A's settings.json {in_file}; closed (exit {code}); after the start the field shows {back.get('field')}, settings {back.get('stored')}")

        # 5: a stroke, its autosave in A's data, the close, and the next start restores it
        name = "5 the_last_session_comes_back_from_the_data_folder"
        drawn = await app.ev(STROKE, size=SIZE_A)
        autosave = os.path.join(self.data["A"], "autosave.json")

        def holds_layer():
            try:
                with open(autosave, encoding="utf-8", errors="replace") as f:
                    return LAYER in f.read()
            except OSError:
                return False
        early = False
        for _ in range(150):
            if holds_layer():
                early = True
                break
            await asyncio.sleep(0.2)
        code = await app.close()
        if code is None:
            raise Stop(name, "A did not end within 180 s of WM_CLOSE")
        kept = holds_layer()
        app, _ = await self.start_checked("A", "A3", a.port_a, name, extra=[f"--inspect=127.0.0.1:{a.port_inspect}"])
        back = await app.ev(RESTORED)
        fp = None
        for _ in range(10):
            fp = await app.ev(FINGERPRINT, size=SIZE_A)
            if fp == drawn["fp"]:
                break
            await asyncio.sleep(1)
        said = any("Last session restored" in s for s in back.get("seen", []))
        ok = kept and back.get("found") and fp == drawn["fp"] and said
        self.step(name, ok, f"stroke on {SIZE_A[0]} x {SIZE_A[1]} ({'tiles' if drawn.get('tiles') else 'canvas'}); A's autosave.json "
                            f"{'held the layer before the close' if early else 'got the layer only at the close'}{'' if kept else ', and NOT after it'}; "
                            f"closed (exit {code}); next start: " + ("the same pixels" if fp == drawn["fp"] else f"pixels differ or missing ({json.dumps(back)[:400]})")
                            + f", status {'said' if said else 'never said'} 'Last session restored.' (seen: {back.get('seen', [])[:4]})")

        # 6: a .scumble document beside the copy, saved and opened again
        name = "6 a_document_saves_and_opens_beside_the_copy"
        docs = os.path.join(self.root["A"], "docs")
        os.makedirs(docs, exist_ok=True)
        doc = os.path.join(docs, "portable-gate.scumble")
        r = await app.ev(SAVE_OPEN, size=SIZE_A, path=doc)
        magic = b""
        if os.path.isfile(doc):
            with open(doc, "rb") as f:
                magic = f.read(2)
        ok = magic == b"PK" and r.get("found") and r.get("fp") == drawn["fp"] and not r["opened"]["already"] and same_path(r["opened"].get("file"), doc)
        self.step(name, ok, f"saved {os.path.getsize(doc) if os.path.isfile(doc) else 0} bytes to {doc}, the tab closed and the file opened again: "
                            + ("the same pixels" if r.get("fp") == drawn["fp"] else f"pixels differ or missing ({json.dumps(r)[:400]})"))

        # 7: B beside A, each answering for itself
        name = "7 two_copies_run_side_by_side"
        b, _ = await self.start_checked("B", "B", a.port_b, name)
        made = await b.ev(NEW_CANVAS, size=SIZE_B)
        answers = {}
        for k in ("A", "B"):
            try:
                r = subprocess.run([self.exe[k], "--cmd", "ping", "--attach-only"], cwd=os.path.dirname(self.exe[k]), env=child_env(), capture_output=True, timeout=120)
                answers[k] = (r.returncode, first_json(r.stdout.decode("utf-8", "replace")), (r.stdout + r.stderr).decode("utf-8", "replace").strip()[-300:])
            except subprocess.TimeoutExpired:
                answers[k] = (None, None, "no answer in 120 s")

        def sizes(k):
            d = answers[k][1] or {}
            return {(x.get("width"), x.get("height")) for x in d.get("documents", [])}
        a_sz, b_sz = sizes("A"), sizes("B")
        ok = (answers["A"][0] == 0 and answers["B"][0] == 0 and tuple(SIZE_A) in a_sz and tuple(SIZE_B) not in a_sz
              and tuple(SIZE_B) in b_sz and tuple(SIZE_A) not in b_sz and made.get("width") == SIZE_B[0])
        self.step(name, ok, f"B's userData is B's data folder; --cmd ping from A's exe lists {sorted(a_sz)}, from B's {sorted(b_sz)}"
                            + ("" if ok else f" (A: exit {answers['A'][0]} {answers['A'][2]!r}; B: exit {answers['B'][0]} {answers['B'][2]!r})"))

        # 8: Help > Copy MCP registration in A's main process
        name = "8 the_mcp_registration_names_the_copys_exe"
        launcher = os.path.join(os.path.dirname(self.exe["A"]), "resources", "app.asar", "electron", "main", "mcp", "launch.js")
        try:
            reg = await self.main_eval(a.port_inspect, REGISTRATION.replace("__ITEMS__", json.dumps(REG_ITEMS)))
        except Exception as err:  # noqa: BLE001
            reg = {"error": f"{type(err).__name__}: {err}"}
        problems = []
        if not isinstance(reg, dict) or reg.get("error"):
            problems.append(str((reg or {}).get("error") if isinstance(reg, dict) else reg))
        else:
            code_line = reg.get("code") if isinstance(reg.get("code"), str) else ""
            quoted = re.findall(r'"([^"]+)"', code_line)
            if not (len(quoted) >= 2 and same_path(quoted[0], self.exe["A"]) and same_path(quoted[1], launcher) and code_line.rstrip().endswith("--mcp")):
                problems.append(f"the Claude Code line is {reg.get('code')!r}")
            try:
                entry = json.loads(reg.get("desktop") or "")["mcpServers"]["scumble"]
                if not (same_path(entry.get("command"), self.exe["A"]) and len(entry.get("args", [])) == 2 and same_path(entry["args"][0], launcher)
                        and entry["args"][1] == "--mcp" and (entry.get("env") or {}).get("ELECTRON_RUN_AS_NODE") == "1"):
                    problems.append(f"the Claude Desktop entry is {json.dumps(entry)}")
            except (ValueError, KeyError, TypeError):
                problems.append(f"the Claude Desktop text is {reg.get('desktop')!r}")
            if not reg.get("restored"):
                problems.append("clipboard.writeText was not put back")
        self.step(name, not problems, "; ".join(problems) if problems else f"both entries name {self.exe['A']} and its launcher (the user's clipboard untouched)")

        name = "8b the_copy_only_says_that_an_update_is_out"
        upd = await app.ev(UPDATES)
        ok = (upd or {}).get("mode") == "notify" and (upd or {}).get("state") not in ("downloading", "downloaded")
        self.step(name, ok, f"mode {(upd or {}).get('mode')}, state {(upd or {}).get('state')}, version {(upd or {}).get('version')}")

        for x in (b, app):
            code = await x.close()
            print(f"  closed {x.label} by WM_CLOSE (exit {code})", flush=True)
            if code is None:
                raise Stop("close", f"{x.label} did not end within 180 s of WM_CLOSE")

        # 9: a copy whose folder this account cannot write to stops with the box and exit code 1
        await self.denied_copy(marker)

        # 10: the user's folder as it was
        name = "10 the_users_folder_is_untouched"
        after = self.snapshot()
        problems, notes = self.differences(self.before, after)
        others = self.foreign()
        if others and problems:
            notes.append("a Scumble.exe outside the gate runs now (" + describe_processes(others) + "): it may have made the change")
        self.step(name, not problems, "; ".join(problems + notes) if (problems or notes) else
                  f"{self.user_dir} unchanged ({len(after['tree'] or {})} entries), no new Scumble names in %APPDATA% or %LOCALAPPDATA%")

    async def denied_copy(self, marker):
        name = "9 a_folder_it_cannot_write_to_stops_it"
        shutil.copytree(self.src, os.path.dirname(self.exe["C"]))
        with open(os.path.join(os.path.dirname(self.exe["C"]), MARKER), "wb") as f:
            f.write(marker)
        self.sid = user_sid()
        self.deny = self.root["C"]
        rc, text = icacls(self.root["C"], "/deny", f"{self.sid}:{DENY_RIGHTS}")
        if rc != 0:
            raise Stop(name, f"icacls /deny failed ({rc}): {text[-300:]}")
        probe = os.path.join(os.path.dirname(self.exe["C"]), ".gate-probe")
        try:
            with open(probe, "wb") as f:
                f.write(b"x")
            os.remove(probe)
            raise Stop(name, "this account can still write into C after the deny entry (an elevated or backup-privileged shell?): C was not started")
        except PermissionError:
            pass
        self.c_log = os.path.join(self.out, "app_C.log")
        logf = open(self.c_log, "w", encoding="utf-8", errors="replace")
        try:
            self.c_proc = subprocess.Popen([self.exe["C"], "--no-comfy"], cwd=os.path.dirname(self.exe["C"]), stdout=logf, stderr=subprocess.STDOUT, env=child_env())
            print(f"  started C (pid {self.c_proc.pid}) in a folder this account cannot write to", flush=True)
            wins = []
            t0 = time.time()
            while time.time() - t0 < 45 and self.c_proc.poll() is None:
                wins = windows_of(self.c_proc.pid)
                if wins:
                    break
                await asyncio.sleep(0.2)
            pressed = None
            if wins:
                await asyncio.sleep(0.7)
                wins = windows_of(self.c_proc.pid) or wins
                pressed = press_ok(self.c_proc, wins[0][0])
            killed = False
            if self.c_proc.poll() is None:
                try:
                    self.c_proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.c_proc.kill()
                    self.c_proc.wait(timeout=30)
                    killed = True
            code = self.c_proc.returncode
        finally:
            logf.close()
        with open(self.c_log, encoding="utf-8", errors="replace") as f:
            said = f.read()
        line = next((ln for ln in said.splitlines() if "cannot write there" in ln), "")
        names_dir = os.path.normcase(self.data["C"]) in os.path.normcase(line)
        captions = [t for _, t, _ in wins]
        box = bool(wins) and any(t in BOX_CAPTIONS for t in captions)
        no_data = not os.path.exists(self.data["C"])
        ok = box and pressed is not None and not killed and code == 1 and no_data and bool(line) and names_dir
        self.undeny()
        self.step(name, ok, f"windows of C: {[(t, c) for _, t, c in wins]}; closed by {pressed or 'nothing'}{' (killed)' if killed else ''}; exit {code}; "
                            f"data folder {'not made' if no_data else 'MADE'}; stderr: {line.strip()[:300] or '(no line)'}"
                            + ("" if names_dir or not line else f" (does not name {self.data['C']})"))

    def undeny(self):
        """Take the gate's deny entry off C (then reset its ACLs to the inherited ones), so C can be deleted."""
        if not self.deny:
            return True
        rc1, t1 = icacls(self.deny, "/remove:d", self.sid or user_sid(), "/C", "/Q")
        rc2, t2 = icacls(self.deny, "/reset", "/T", "/C", "/Q")
        if rc1 == 0 and rc2 == 0:
            print(f"  the deny entry is off {self.deny}", flush=True)
            self.deny = None
            return True
        print(f"  WARNING: the deny entry could not be taken off {self.deny} ({rc1}: {t1[-200:]}; {rc2}: {t2[-200:]}); "
              f"by hand: icacls \"{self.deny}\" /reset /T /C", flush=True)
        return False

    async def main_eval(self, port, js):
        """Evaluate in A's main process through its Node inspector (--inspect on A's last start)."""
        async with aiohttp.ClientSession() as s:
            targets = None
            for _ in range(40):
                try:
                    async with s.get(f"http://127.0.0.1:{port}/json/list", timeout=aiohttp.ClientTimeout(total=3)) as r:
                        targets = await r.json(content_type=None)
                    if targets:
                        break
                except Exception:  # noqa: BLE001
                    pass
                await asyncio.sleep(0.5)
            if not targets:
                raise RuntimeError(f"no Node inspector on port {port} (does the exe's fuse refuse --inspect? app_A3.log says what Electron did)")
            async with s.ws_connect(targets[0]["webSocketDebuggerUrl"], max_msg_size=16 * 1024 * 1024) as ws:
                c = Cdp(ws)
                r = await asyncio.wait_for(c.call("Runtime.evaluate", expression=js, includeCommandLineAPI=True, returnByValue=True), 30)
                if "exceptionDetails" in r:
                    d = r["exceptionDetails"]
                    raise RuntimeError("main process: " + str(d.get("exception", {}).get("description") or d.get("text")))
                return r.get("result", {}).get("value")

    async def cleanup(self):
        for app in self.started:
            if app.alive():
                try:
                    close_window(app.proc.pid)
                    app.wait_exit(90)
                except Exception:  # noqa: BLE001
                    pass
                if app.alive():
                    app.kill()
                    app.wait_exit(30)
                    print(f"  cleanup: {app.label} did not end on WM_CLOSE and was killed", flush=True)
                else:
                    print(f"  cleanup: {app.label} closed by WM_CLOSE (exit {app.proc.returncode})", flush=True)
            await app.close_io()
        if self.c_proc is not None and self.c_proc.poll() is None:
            wins = windows_of(self.c_proc.pid)
            if wins:
                press_ok(self.c_proc, wins[0][0])
            if self.c_proc.poll() is None:
                self.c_proc.kill()
                print("  cleanup: C was killed", flush=True)
        self.undeny()
        if self.args.keep:
            print(f"  the staged copies stay in {self.out} (--keep)", flush=True)
            return
        for k, p in self.root.items():
            if not os.path.exists(p):
                continue
            if k == "C" and self.deny:
                print(f"  {p} kept: its deny entry is still on", flush=True)
                continue
            if not inside(p, self.out):
                continue
            print(f"  removed {p}" if rmtree(p) else f"  WARNING: {p} could not be removed", flush=True)

    def finish(self):
        ok = bool(self.results) and all(self.results)
        print("PASS" if ok else "FAIL", flush=True)
        return ok


def refusal(args):
    """Why the gate must not run (None: it may). Reads nothing under %APPDATA% and writes nothing."""
    if not args.exe:
        return "the portable gate runs only on a packaged exe: pass --exe PATH (dist/win-unpacked/Scumble.exe)"
    if sys.platform != "win32":
        return "Windows only (a portable copy is a Windows zip)"
    if not os.path.isfile(args.exe):
        return f"no exe at {args.exe}"
    if not os.environ.get("APPDATA") or not os.environ.get("LOCALAPPDATA"):
        return "APPDATA or LOCALAPPDATA is not set: the gate cannot tell where the user's data is"
    try:
        procs = scumble_processes()
    except Exception as err:  # noqa: BLE001
        return f"the running processes cannot be listed ({err}), so it cannot be ruled out that a Scumble runs"
    if procs:
        return ("Scumble.exe is running (" + describe_processes(procs) + "): close every Scumble first (the window, a headless or "
                "MCP-started one, another gate's exe); this gate starts copies without --user-data-dir and must never meet another Scumble")
    src = os.path.dirname(args.exe)
    for n in (MARKER, DATA):
        if os.path.exists(os.path.join(src, n)):
            return f"{src} has {n}: it was started as a portable copy; stage from a clean build (npm run dist)"
    if not os.path.isfile(os.path.join(src, "resources", "app.asar")):
        return f"{src} has no resources\\app.asar: not an unpacked build"
    for root in (os.environ["APPDATA"], os.environ["LOCALAPPDATA"]):
        if inside(args.out, root):
            return f"the gate's folder {args.out} lies under {root}"
    busy = [p for p in (args.port_a, args.port_b, args.port_inspect) if port_in_use(p)]
    if busy:
        return f"something listens on port {', '.join(map(str, busy))} already: the gate would talk to it instead of its own copies"
    return None


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser()
    p.add_argument("--exe", default=None)
    p.add_argument("--out", default=os.path.join(ROOT, "dist", "gates", "portable"))
    p.add_argument("--base", type=int, default=int(os.environ.get("SCUMBLE_CDP_PORT", "9555")))
    p.add_argument("--backup", default=None, help="where step 1 copies the user's settings and autosave files")
    p.add_argument("--keep", action="store_true", help="keep the staged copies")
    p.add_argument("--no-node", action="store_true", help="skip tools/platform_test.js")
    args = p.parse_args()
    if args.exe:
        args.exe = os.path.abspath(args.exe)   # Windows resolves a relative program against this process, not cwd
    args.out = os.path.abspath(args.out)
    args.port_a, args.port_b, args.port_inspect = args.base + 19, args.base + 20, args.base + 21
    why = refusal(args)
    if why:
        print("FAIL refused: " + why, flush=True)
        sys.exit(2)
    args.backup = os.path.abspath(args.backup or os.path.join(ROOT, "dist", "gates", "portable-backup", time.strftime("%Y%m%d-%H%M%S")))
    # a stale run's copies (a deny entry on C included) go first
    os.makedirs(args.out, exist_ok=True)
    for k in ("A", "B", "C"):
        stale = os.path.join(args.out, k)
        if os.path.exists(stale):
            if k == "C":
                icacls(stale, "/reset", "/T", "/C", "/Q")
            if not rmtree(stale):
                print(f"FAIL refused: a stale copy {stale} cannot be removed", flush=True)
                sys.exit(2)
    print(f"portable gate: {args.exe} staged under {args.out}; A on port {args.port_a} (inspector {args.port_inspect}), B on {args.port_b}", flush=True)
    ok = asyncio.run(Gate(args).run())
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
