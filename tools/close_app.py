"""Close a Scumble instance that was started with a DevTools port (Browser.close)."""
import asyncio
import json
import os
import sys

import aiohttp

PORT = int(os.environ.get("SCUMBLE_CDP_PORT", "9555"))


async def main():
    async with aiohttp.ClientSession() as s:
        try:
            async with s.get(f"http://127.0.0.1:{PORT}/json/version") as r:
                info = await r.json()
        except Exception as err:
            print("no instance on", PORT, err)
            return
        async with s.ws_connect(info["webSocketDebuggerUrl"], max_msg_size=0) as ws:
            await ws.send_str(json.dumps({"id": 1, "method": "Browser.close"}))
            try:
                await asyncio.wait_for(ws.receive(), 5)
            except Exception:
                pass
    print("closed")


asyncio.run(main())
