"""MCP --attach-only test (docs/BUGS.md "A headless MCP instance keeps Scumble from starting"): the registration of a
dev checkout (.mcp.json) drives a running Scumble and never starts one, because its headless app would take the user's
profile and a Start-menu Scumble would hand over to the dev tree.

On a fresh profile with no instance: the server lists `ping` alone, a call answers "Scumble is not running" and no
app starts (no renderer process on that profile). Then an instance starts on the profile: the next ping reaches it,
the server says the tool list changed and lists every command. The instance closes: a call answers "not running"
again, and still nothing starts.

    python tools/mcp_attach_test.py [--exe <Scumble.exe | electron.exe>] [out_dir]

Needs the `mcp` package. Port 9573 for the instance it starts (the runner's is 9555, quit's 9572).
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
PORT = 9573

args = sys.argv[1:]
EXE = None
if "--exe" in args:
    i = args.index("--exe")
    EXE = os.path.abspath(args[i + 1])
    del args[i:i + 2]
OUT = os.path.abspath(args[0] if args else os.path.join(ROOT, "dist", "mcp_attach"))
DEV_EXE = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe" if os.name == "nt" else "electron")
EXE = EXE or DEV_EXE
IS_ELECTRON = "electron" in os.path.basename(EXE).lower()
LAUNCHER = os.path.join(ROOT, "electron", "main", "mcp", "launch.js") if IS_ELECTRON else \
    os.path.join(os.path.dirname(EXE), "resources", "app.asar", "electron", "main", "mcp", "launch.js")
PROFILE = os.path.join(OUT, "profile")


def renderers():
    """Renderer processes on the test profile: an app that started, headless or not."""
    if os.name != "nt":
        out = subprocess.run(["ps", "-eo", "args"], capture_output=True, text=True).stdout
    else:
        ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--type=renderer' } | ForEach-Object { $_.CommandLine }"
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True).stdout
    key = os.path.normcase(PROFILE)
    return [l for l in out.splitlines() if "--type=renderer" in l and key in os.path.normcase(l)]


def text_of(res):
    return "".join(c.text for c in res.content if getattr(c, "type", "") == "text")


async def main():
    report = {}
    changed = []

    async def on_message(m):
        if getattr(getattr(m, "root", None), "method", "") == "notifications/tools/list_changed":
            changed.append(time.time())

    server = StdioServerParameters(command=EXE, args=[LAUNCHER, f"--user-data-dir={PROFILE}", "--mcp", "--attach-only"],
                                   cwd=ROOT, env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"})
    app = None
    try:
        async with stdio_client(server) as (read, write):
            async with ClientSession(read, write, message_handler=on_message) as session:
                await session.initialize()
                # 1. nothing runs: ping alone, an error, nothing started
                names = [t.name for t in (await session.list_tools()).tools]
                if names != ["ping"]:
                    raise RuntimeError(f"with no Scumble running the server lists {names[:8]}, not ping alone")
                res = await session.call_tool("ping", {})
                if not res.isError or "not running" not in text_of(res):
                    raise RuntimeError(f"ping with no Scumble running: isError={res.isError} {text_of(res)[:200]!r}")
                await asyncio.sleep(3)
                if renderers():
                    raise RuntimeError(f"an app started on the profile: {renderers()[:1]}")
                report["alone"] = {"tools": names, "error": text_of(res)[:120]}
                # 2. an instance starts on the profile: the next ping reaches it, the list grows
                env = dict(os.environ)
                env.pop("ELECTRON_RUN_AS_NODE", None)
                app = subprocess.Popen(([EXE, ROOT] if IS_ELECTRON else [EXE]) + [f"--user-data-dir={PROFILE}", f"--remote-debugging-port={PORT}", "--no-comfy"],
                                       cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                t0 = time.time()
                ping = None
                while time.time() - t0 < 90:
                    res = await session.call_tool("ping", {})
                    if not res.isError:
                        ping = json.loads(text_of(res))
                        break
                    await asyncio.sleep(1)
                if not ping:
                    raise RuntimeError("ping never reached the started instance: " + text_of(res)[:200])
                if (ping.get("mcp") or {}).get("mode") != "proxy":
                    raise RuntimeError(f"the server took the instance over instead of attaching: {ping.get('mcp')}")
                await asyncio.sleep(1)
                if not changed:
                    raise RuntimeError("the server did not say the tool list changed")
                names = [t.name for t in (await session.list_tools()).tools]
                if len(names) < 40 or "list_layers" not in names:
                    raise RuntimeError(f"after the attach the server lists {len(names)} tools")
                res = await session.call_tool("list_documents", {})
                if res.isError:
                    raise RuntimeError("list_documents on the attached instance: " + text_of(res)[:200])
                report["attached"] = {"after_s": round(time.time() - t0, 1), "tools": len(names), "list_changed": len(changed)}
                # 3. the instance closes: an error again, nothing started
                subprocess.run([sys.executable, os.path.join(HERE, "close_app.py")], env={**os.environ, "SCUMBLE_CDP_PORT": str(PORT)}, timeout=60)
                try:
                    app.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    raise RuntimeError("the started instance did not close")
                await asyncio.sleep(2)
                res = await session.call_tool("list_documents", {})
                if not res.isError or "not running" not in text_of(res):
                    raise RuntimeError(f"a call after the instance closed: isError={res.isError} {text_of(res)[:200]!r}")
                await asyncio.sleep(3)
                if renderers():
                    raise RuntimeError(f"the server started an app after the instance closed: {renderers()[:1]}")
                report["closed"] = text_of(res)[:120]
    finally:
        if app and app.poll() is None:
            app.kill()
    return report


if __name__ == "__main__":
    shutil.rmtree(PROFILE, ignore_errors=True)
    os.makedirs(PROFILE, exist_ok=True)
    try:
        rep = asyncio.run(main())
    except Exception as err:
        print("[FAIL]", err)
        print("FAIL")
        sys.exit(1)
    for k, v in rep.items():
        print(f"[ok] {k}: {json.dumps(v)}")
    print("PASS")
