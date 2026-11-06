"""Run a JS body in the Scumble window with the command core at hand.

    SCUMBLE_CDP_PORT=9573 python drive.py body.js [timeout_s]

The body sees `run(name, args)`, `host`, `ednow()` (the active editor) and may use await; its return value is printed.
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, r"F:\canvas\.claude\worktrees\corridorkey\tools")
from cdp import session  # noqa: E402

PRELUDE = """(async () => {
if (!window.__cmds) { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; window.__shell = await import('./shell.js'); }
const commands = window.__cmds.commands, host = window.__host, shell = window.__shell;
const run = (n, a) => commands.run(n, a || {});
const ednow = () => window.editor;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
%s
})()"""


async def main():
    sys.stdout.reconfigure(encoding="utf-8")
    body = open(sys.argv[1], encoding="utf-8").read()
    timeout = float(sys.argv[2]) if len(sys.argv) > 2 else 900

    async def fn(c):
        v = await c.eval(PRELUDE % body, timeout=timeout)
        print(json.dumps(v, indent=1, ensure_ascii=False) if not isinstance(v, str) else v)
        for k, m in await c.logs():
            if k != "log":
                print("CONSOLE", k.upper(), m[:600])

    await session(fn)


if __name__ == "__main__":
    asyncio.run(main())
