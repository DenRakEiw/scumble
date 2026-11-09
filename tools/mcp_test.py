"""MCP server test: talks to `Scumble --mcp` over stdio like an MCP client would.

Works in both modes: with the app running (the server proxies to it over the local socket)
and without (the server starts the app headless in its own process and quits it at the end).
No ComfyUI needed. Loads the test image from the local store, runs a selection, reads the
undo history (list_history), a plugin filter (WebGL2 in the hidden window), a screenshot (image content), an export to a fixed
path and an error case. First tools/local_test.js in plain Node (the local socket's line splitter, its cap).

    python tools/mcp_test.py [--exe <Scumble.exe | electron.exe>] [--direct] [--user-data-dir <dir>] [out_dir]
    python tools/mcp_test.py --store [out_dir]

`--store` starts the server the way Help > Copy MCP registration tells a client to in the Microsoft Store
copy (docs/STORE.md): the execution alias scumble.exe in Node mode with the launch code of
electron/main/mcp/registration.js. Its default profile is the Store copy's own.

The server is started through `electron/main/mcp/launch.js` in Node mode, which is how
clients register it (docs/MCP.md): Electron prints a CR LF to stdout before any JavaScript
runs and this Python client rejects it. `--direct` runs `--mcp` on the executable itself,
which is the documented failure and is not part of the gate.

Needs the `mcp` package (pip install mcp).
"""
import asyncio
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))

args = sys.argv[1:]
EXE = None
if "--exe" in args:
    i = args.index("--exe")
    EXE = args[i + 1]
    del args[i:i + 2]
DIRECT = "--direct" in args
if DIRECT:
    args.remove("--direct")
STORE = "--store" in args
if STORE:
    args.remove("--store")
# an own profile for the server's instance (the launcher forwards it), so a test never touches the
# user's running app, which holds the default profile's single-instance lock
USER_DATA = None
if "--user-data-dir" in args:
    i = args.index("--user-data-dir")
    USER_DATA = os.path.abspath(args[i + 1])
    del args[i:i + 2]
OUT = os.path.abspath(args[0] if args else os.path.join(ROOT, "dist", "smoke"))
os.makedirs(OUT, exist_ok=True)

DEV_EXE = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe" if os.name == "nt" else "electron")
EXE = os.path.abspath(EXE) if EXE else DEV_EXE
IS_ELECTRON = "electron" in os.path.basename(EXE).lower()
# The launcher lives beside the sources in a dev checkout and inside the asar in a package.
LAUNCHER = os.path.join(ROOT, "electron", "main", "mcp", "launch.js") if IS_ELECTRON else     os.path.join(os.path.dirname(EXE), "resources", "app.asar", "electron", "main", "mcp", "launch.js")
if STORE:
    # what the registration names: the alias and the -e code, read from registration.js itself
    _store = json.loads(subprocess.run(["node", "-e", "const r=require('./electron/main/mcp/registration');process.stdout.write(JSON.stringify(r.server({platform:'win32',storeAlias:require('./electron/main/msix').aliasPath(process.env.LOCALAPPDATA)})))"], cwd=ROOT, capture_output=True, text=True, check=True).stdout)
    EXE = _store["command"]
    IS_ELECTRON = False


def server_args(mode):
    """mode is ["--mcp"] or ["--cmd", "ping"]; the launcher takes both."""
    extra = [f"--user-data-dir={USER_DATA}"] if USER_DATA else []
    # the profile switch goes first: "--cmd <name> [json]" would take it for its JSON argument
    if DIRECT:
        return ([ROOT] if IS_ELECTRON else []) + extra + mode, dict(os.environ)
    if STORE:
        return _store["args"] + ["--"] + extra + mode, {**os.environ, **_store["env"]}
    return [LAUNCHER] + extra + mode, {**os.environ, "ELECTRON_RUN_AS_NODE": "1"}


_mcp_args, _mcp_env = server_args(["--mcp"])
SERVER = StdioServerParameters(command=EXE, args=_mcp_args, cwd=ROOT, env=_mcp_env)


def raw_check():
    """Nothing but the protocol on stdout: the first byte of a --cmd answer must be `{`."""
    a, env = server_args(["--cmd", "ping"])
    p = subprocess.run([EXE] + a, cwd=ROOT, env=env, capture_output=True, timeout=180, stdin=subprocess.DEVNULL)   # an open stdin keeps the relay alive
    if p.returncode != 0:
        raise RuntimeError(f"--cmd ping exited {p.returncode}: {p.stderr[-300:]!r}")
    if p.stdout[:1] != b"{":
        raise RuntimeError(f"stdout does not start with a JSON message: {p.stdout[:40]!r}")
    return f"{len(p.stdout)} bytes, starts with {chr(p.stdout[0])!r}"


def headless_flush_check():
    """MAIN-1: closing stdin on a headless MCP session started via launch.js lets flushBeforeQuit finish (> 5 s)."""
    flush_profile = os.path.join(OUT, "headless_flush_profile")
    shutil.rmtree(flush_profile, ignore_errors=True)
    os.makedirs(flush_profile, exist_ok=True)
    ref_img = os.path.join(ROOT, "tools", "refs", "composite_full.png")
    if STORE:
        cmd = [EXE] + _store["args"] + ["--", f"--user-data-dir={flush_profile}", "--no-comfy", "--mcp"]
        env = {**os.environ, **_store["env"]}
    else:
        cmd = [EXE, LAUNCHER, f"--user-data-dir={flush_profile}", "--no-comfy", "--mcp"]
        env = {**os.environ, "ELECTRON_RUN_AS_NODE": "1"}
    p = subprocess.Popen(cmd, cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        def rpc(msg_id, method, params=None):
            req = {"jsonrpc": "2.0", "id": msg_id, "method": method}
            if params is not None:
                req["params"] = params
            p.stdin.write((json.dumps(req) + "\n").encode("utf-8"))
            p.stdin.flush()
            while True:
                line = p.stdout.readline()
                if not line:
                    raise RuntimeError(f"EOF waiting for {method} (id={msg_id})")
                msg = json.loads(line.decode("utf-8"))
                if msg.get("id") == msg_id:
                    if "error" in msg:
                        raise RuntimeError(f"RPC error on {method}: {msg['error']}")
                    return msg["result"]

        def tool_call(msg_id, name, arguments=None):
            res = rpc(msg_id, "tools/call", {"name": name, "arguments": arguments or {}})
            if res.get("isError"):
                raise RuntimeError(f"tool {name} failed: {res}")
            text = "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
            return json.loads(text) if text else res

        rpc(1, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "flush_test", "version": "1.0"}})
        p.stdin.write((json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n").encode("utf-8"))
        p.stdin.flush()
        ping = tool_call(2, "ping")
        if ping.get("mcp", {}).get("mode") != "headless":
            raise RuntimeError(f"expected headless mode, got {ping}")
        doc_id = tool_call(3, "new_document")["id"]
        tool_call(4, "load_image", {"path": ref_img, "doc": doc_id})
        tool_call(5, "resize_image", {"width": 7500, "height": 5000, "doc": doc_id})
        c0 = tool_call(6, "copy_to_layer", {"merged": True, "name": "Copy0", "doc": doc_id})
        lid = (c0.get("layer") or c0)["id"]
        copies = 22
        for i in range(1, copies):
            tool_call(10 + i, "duplicate_layer", {"layer": lid, "name": f"Copy{i}", "doc": doc_id})
        t0 = time.time()
        p.stdin.close()
        rc = p.wait(timeout=90)
        dt = time.time() - t0
    finally:
        if p.poll() is None:
            p.kill()
    try:
        if rc != 0:
            err = (p.stderr.read() if p.stderr else b"").decode("utf-8", errors="replace")[-400:]
            raise RuntimeError(f"headless MCP launcher exited {rc} after {dt:.2f}s: {err}")
        if dt <= 5.0:
            raise RuntimeError(f"expected flush after stdin EOF to take > 5.0s, took {dt:.2f}s")
        autosave_path = os.path.join(flush_profile, "autosave.json")
        if not os.path.isfile(autosave_path):
            raise RuntimeError("autosave.json missing after headless MCP quit")
        with open(autosave_path, "r", encoding="utf-8") as fh:
            raw_auto = json.load(fh)
        bundle = json.loads(raw_auto["state"]) if isinstance(raw_auto.get("state"), str) else raw_auto
        doc_entry = next((d for d in (bundle.get("docs") or []) if d.get("id") == doc_id), None)
        if not doc_entry:
            raise RuntimeError(f"doc {doc_id} missing from autosave.json")
        state = json.loads(doc_entry["state"]) if isinstance(doc_entry.get("state"), str) else doc_entry.get("state", {})
        layers = state.get("layers") or []
        canvas_dir = os.path.join(flush_profile, "files", "input", "inpaint_canvas")
        def ref_name(r):
            return r.get("filename") if isinstance(r, dict) else r
        saved = [
            ref_name(l.get("ref")) for l in layers
            if str(l.get("name") or "").startswith("Copy")
            and ref_name(l.get("ref"))
            and os.path.isfile(os.path.join(canvas_dir, ref_name(l.get("ref"))))
        ]
        if len(saved) != copies:
            raise RuntimeError(f"only {len(saved)}/{copies} dirty layers flushed to disk (dt={dt:.2f}s)")
        return f"{len(saved)}/{copies} dirty 7500x5000 layers flushed in {dt:.1f}s (rc={rc})"
    finally:
        shutil.rmtree(flush_profile, ignore_errors=True)

# the profile the app runs on holds the image: the one --user-data-dir names, else the default profile
TEST_IMAGE = os.path.join(USER_DATA or os.path.join(os.environ.get("APPDATA", os.path.expanduser("~/.config")), "Scumble"), "files", "input", "inpaint_canvas", "test_base.png")
if STORE and not USER_DATA:
    # the Store copy reads files outside its package like any app; its own folder is redirected
    TEST_IMAGE = os.path.join(ROOT, "tools", "refs", "composite_full.png")
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def text_of(res):
    return "\n".join(c.text for c in res.content if getattr(c, "type", "") == "text")


def data_of(res):
    t = text_of(res)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        return t


# The tool hints (docs/PLAN_0_1_42.md F1): from the commands' readOnly / destructive flags; the names below were wrong
# before (the dotted plugin commands never matched the name test, new_document was destructive, the rest was missing)
HINT_READ = ["ping", "status", "list_layers", "list_history", "screenshot", "filter_types", "read_log",
             "film_looks", "glb_info", "ailabel_info", "sample_mean_color", "boxes_list", "boxes_check", "list_settings",
             "list_loras"]
HINT_DESTRUCTIVE = ["close_document", "remove_layer", "new_canvas", "load_image", "generate_new", "flatten", "merge_down",
                    "extend_canvas", "export", "export_layer", "export_mask", "undo", "redo", "select_recipe",
                    "set_node_params", "ailabel_add", "resize_image"]
HINT_NEITHER = ["new_document", "select_rect", "generate", "set_layer", "add_filter", "sample_box",
                "transform_layer", "copy_to_layer", "cancel_run", "select_color", "select_shape", "apply_preset", "set_crop",
                "set_filter", "reopen_closed_tab", "set_generation"]
# a plugin command that sets no flag: judged by its own name (the part after the plugin id), never destructive
HINT_FALLBACK = (
    "const { toTool } = require('./electron/main/mcp/server');"
    "const a = (name, f) => toTool({ name, plugin: 'x', params: {}, readOnly: null, destructive: null, ...(f || {}) }).annotations;"
    "process.stdout.write(JSON.stringify({ list: a('x.list'), listing: a('x.list_things'), info: a('x.info'), paint: a('x.paint'),"
    " remove: a('x.remove'), flagged: a('x.list', { readOnly: false, destructive: true }), builtin: a('list_layers', { plugin: null }) }));"
)


def hints_check(tools):
    by = {t.name: t for t in tools}

    def ann(n):
        a = by[n].annotations
        return (bool(a.readOnlyHint), bool(a.destructiveHint)) if a else None

    missing = [n for n in HINT_READ + HINT_DESTRUCTIVE + HINT_NEITHER if n not in by]
    if missing:
        raise RuntimeError("tools missing for the hint check: " + ", ".join(missing))
    wrong = [f"{n} {ann(n)}" for n in HINT_READ if ann(n) != (True, False)]
    wrong += [f"{n} {ann(n)}" for n in HINT_DESTRUCTIVE if ann(n) != (False, True)]
    wrong += [f"{n} {ann(n)}" for n in HINT_NEITHER if ann(n) != (False, False)]
    if wrong:
        raise RuntimeError("tool hints (readOnly, destructive) wrong: " + "; ".join(wrong))
    p = subprocess.run(["node", "-e", HINT_FALLBACK], cwd=ROOT, capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        raise RuntimeError("the hint fallback check did not run: " + p.stderr[-300:])
    fb = {k: (v.get("readOnlyHint"), v.get("destructiveHint")) for k, v in json.loads(p.stdout).items()}
    want = {"list": (True, False), "listing": (True, False), "info": (True, False), "paint": (False, False),
            "remove": (False, False), "flagged": (False, True), "builtin": (True, False)}
    if fb != want:
        raise RuntimeError(f"the hint fallback for a plugin without flags: {fb}, not {want}")
    reads = sum(1 for t in tools if t.annotations and t.annotations.readOnlyHint)
    gone = sum(1 for t in tools if t.annotations and t.annotations.destructiveHint)
    return f"{reads} read-only, {gone} destructive; the named {len(HINT_READ)} / {len(HINT_DESTRUCTIVE)} / {len(HINT_NEITHER)} and the fallback right"


async def call(session, name, arguments=None, expect_error=False):
    res = await session.call_tool(name, arguments or {})
    if bool(res.isError) != expect_error:
        raise RuntimeError(f"{name}: {'error' if res.isError else 'no error'}: {text_of(res)[:300]}")
    return res


async def main():
    t0 = time.time()
    if not os.path.isfile(TEST_IMAGE):
        raise SystemExit(f"test image missing: {TEST_IMAGE} (run the smoke test once)")
    report = {}
    # the local command socket's line splitter and cap (electron/main/local.js, H1 S6), plain Node on a pipe of its own
    lt = subprocess.run(["node", os.path.join(ROOT, "tools", "local_test.js")], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=180)
    if lt.returncode != 0 or not lt.stdout.strip().endswith("PASS"):
        raise RuntimeError("tools/local_test.js: " + (lt.stdout + lt.stderr)[-800:])
    report["local"] = f"{lt.stdout.count('[ok]')} checks"
    report["raw"] = raw_check()
    report["flush"] = headless_flush_check()
    async with stdio_client(SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            report["server"] = f"{init.serverInfo.name} {init.serverInfo.version}"
            if not (init.instructions or "").startswith("Scumble"):
                raise RuntimeError("instructions missing")

            tools = (await session.list_tools()).tools
            names = [t.name for t in tools]
            bad = [n for n in names if not NAME_RE.match(n)]
            if bad:
                raise RuntimeError("tool names not allowed: " + ", ".join(bad))
            for need in ("ping", "select_rect", "generate", "screenshot", "export", "film_apply_look", "sample_mean_color", "list_history"):
                if need not in names:
                    raise RuntimeError("tool missing: " + need)
            sel = next(t for t in tools if t.name == "select_rect")
            if "doc" not in sel.inputSchema["properties"] or "x" not in sel.inputSchema["properties"]:
                raise RuntimeError("select_rect schema: " + json.dumps(sel.inputSchema)[:200])
            if "doc" in next(t for t in tools if t.name == "ping").inputSchema["properties"]:
                raise RuntimeError("ping is an app command, no doc")
            report["tools"] = len(names)
            report["hints"] = hints_check(tools)

            ping = data_of(await call(session, "ping"))
            report["mode"] = ping.get("mcp", {}).get("mode")
            report["plugins"] = ping.get("plugins")

            doc = data_of(await call(session, "new_document"))["id"]
            st = data_of(await call(session, "load_image", {"path": TEST_IMAGE, "doc": doc}))
            if not st.get("width"):
                raise RuntimeError("load_image: " + json.dumps(st)[:200])
            report["image"] = f"{st['width']}x{st['height']}"

            r = data_of(await call(session, "select_rect", {"x": 100, "y": 80, "w": 200, "h": 120, "doc": doc}))
            if r["selection"]["w"] != 200:
                raise RuntimeError("select_rect: " + json.dumps(r)[:200])

            # the undo history (docs/PLAN_0_1_31.md section 2): load_image started it, the selection is its present
            hist = data_of(await call(session, "list_history", {"doc": doc}))
            rows = hist.get("rows") if isinstance(hist, dict) else None
            if not isinstance(rows, list) or not isinstance(hist.get("undo"), int) or hist["undo"] < 1 or len(rows) != hist["undo"] + (hist.get("redo") or 0) + 1:
                raise RuntimeError("list_history: " + json.dumps(hist)[:300])
            now = rows[-1]
            if rows[0].get("label") != "Start" or not now.get("current") or now.get("steps") != 0 or not str(now.get("label") or "").strip():
                raise RuntimeError("list_history rows: " + json.dumps(rows)[:300])
            if not isinstance(hist.get("snapshots"), list) or not (hist.get("depth") or {}).get("steps"):
                raise RuntimeError("list_history snapshots / depth: " + json.dumps(hist)[:300])
            report["history"] = f"{hist['undo']} undo, {len(rows)} rows, now {now['label']!r}"

            types = data_of(await call(session, "filter_types"))
            ids = [t["id"] if isinstance(t, dict) else t for t in (types.get("filters") or types.get("types") or types)]
            fid = "sample.posterize" if "sample.posterize" in ids else ids[0]
            f = data_of(await call(session, "add_filter", {"type": fid, "doc": doc}))
            if f.get("filter") != fid:
                raise RuntimeError("add_filter: " + json.dumps(f)[:200])
            report["filter"] = fid
            # set_mask (docs/PLAN_0_1_31.md 6.4): the operations are an enum in the tool's schema; a white mask switched
            # off changes nothing in the picture, so the checks below see the document they always saw
            sm = next((t for t in tools if t.name == "set_mask"), None)
            if sm is None or "reveal" not in ((sm.inputSchema["properties"].get("op") or {}).get("enum") or []):
                raise RuntimeError("set_mask schema: " + json.dumps(sm.inputSchema if sm else None)[:300])
            m1 = data_of(await call(session, "set_mask", {"layer": f["id"], "op": "reveal", "doc": doc}))
            m2 = data_of(await call(session, "set_mask", {"layer": f["id"], "op": "disable", "doc": doc}))
            if not (m1.get("mask") and m1.get("changed") and m2.get("mask_off") and m2.get("changed")):
                raise RuntimeError("set_mask: " + json.dumps([m1, m2])[:300])
            report["set_mask"] = "reveal, disable"
            mean = data_of(await call(session, "sample_mean_color", {"doc": doc}))
            report["mean_color"] = mean

            shot = await call(session, "screenshot", {"max_size": 512, "show_layers": True, "doc": doc})
            img = next((c for c in shot.content if getattr(c, "type", "") == "image"), None)
            if img is None or img.mimeType != "image/jpeg":
                raise RuntimeError("screenshot has no image content")
            shot_path = os.path.join(OUT, "mcp_screenshot.jpg")
            with open(shot_path, "wb") as fh:
                fh.write(base64.b64decode(img.data))
            report["screenshot"] = f"{os.path.getsize(shot_path)} bytes, {text_of(shot)[:60].replace(chr(10), ' ')}"

            export_path = os.path.join(OUT, "mcp_export.png")
            if os.path.exists(export_path):
                os.remove(export_path)
            ex = data_of(await call(session, "export", {"format": "png", "path": export_path, "doc": doc}))
            if not os.path.isfile(export_path):
                raise RuntimeError("export wrote nothing: " + json.dumps(ex)[:200])
            report["export"] = f"{os.path.getsize(export_path)} bytes"

            err = await call(session, "set_layer", {"layer": "no such layer", "x": 1, "doc": doc}, expect_error=True)
            if "no layer" not in text_of(err):
                raise RuntimeError("error text: " + text_of(err)[:200])
            report["error_text"] = text_of(err)[:80]

            unknown = await session.call_tool("does_not_exist", {})
            if not unknown.isError:
                raise RuntimeError("unknown tool did not fail")

            await call(session, "close_document", {"doc": doc})
            docs = data_of(await call(session, "list_documents"))
            if any(d["id"] == doc for d in docs["documents"]):
                raise RuntimeError("document still open")
    report["seconds"] = round(time.time() - t0, 1)
    return report


if __name__ == "__main__":
    try:
        rep = asyncio.run(main())
    except Exception as e:  # noqa: BLE001
        print("FAIL:", e)
        sys.exit(1)
    for k, v in rep.items():
        print(f"{k:12} {v}")
    print("PASS")
