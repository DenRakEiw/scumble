"""MCP server test: talks to `Scumble --mcp` over stdio like an MCP client would.

Works in both modes: with the app running (the server proxies to it over the local socket)
and without (the server starts the app headless in its own process and quits it at the end).
No ComfyUI needed. Loads the test image from the local store, runs a selection, a plugin
filter (WebGL2 in the hidden window), a screenshot (image content), an export to a fixed
path and an error case.

    python tools/mcp_test.py [--exe <Scumble.exe | electron.exe>] [--direct] [--user-data-dir <dir>] [out_dir]

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


def server_args(mode):
    """mode is ["--mcp"] or ["--cmd", "ping"]; the launcher takes both."""
    extra = [f"--user-data-dir={USER_DATA}"] if USER_DATA else []
    # the profile switch goes first: "--cmd <name> [json]" would take it for its JSON argument
    if DIRECT:
        return ([ROOT] if IS_ELECTRON else []) + extra + mode, dict(os.environ)
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

TEST_IMAGE = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~/.config")), "Scumble", "files", "input", "inpaint_canvas", "test_base.png")
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def text_of(res):
    return "\n".join(c.text for c in res.content if getattr(c, "type", "") == "text")


def data_of(res):
    t = text_of(res)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        return t


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
    report["raw"] = raw_check()
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
            for need in ("ping", "select_rect", "generate", "screenshot", "export", "film_apply_look", "sample_mean_color"):
                if need not in names:
                    raise RuntimeError("tool missing: " + need)
            sel = next(t for t in tools if t.name == "select_rect")
            if "doc" not in sel.inputSchema["properties"] or "x" not in sel.inputSchema["properties"]:
                raise RuntimeError("select_rect schema: " + json.dumps(sel.inputSchema)[:200])
            if "doc" in next(t for t in tools if t.name == "ping").inputSchema["properties"]:
                raise RuntimeError("ping is an app command, no doc")
            report["tools"] = len(names)

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

            types = data_of(await call(session, "filter_types"))
            ids = [t["id"] if isinstance(t, dict) else t for t in (types.get("filters") or types.get("types") or types)]
            fid = "sample.posterize" if "sample.posterize" in ids else ids[0]
            f = data_of(await call(session, "add_filter", {"type": fid, "doc": doc}))
            if f.get("filter") != fid:
                raise RuntimeError("add_filter: " + json.dumps(f)[:200])
            report["filter"] = fid
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
