"""DevTools driver for a running Scumble window.

Start the app with a debugging port first:

    ./node_modules/.bin/electron . --remote-debugging-port=9555

Then:

    python tools/cdp.py eval "<js expression, may return a promise>"
    python tools/cdp.py shot out.png [scale]
    python tools/cdp.py log            # console entries collected by the injected hook

Port 9333 is often taken by the ComfyUI node's headless Chromium, hence 9555.
"""
import asyncio
import base64
import io
import json
import os
import sys

import aiohttp

PORT = int(os.environ.get("SCUMBLE_CDP_PORT", "9555"))

HOOK = """
(() => {
  if (window.__log) return "hooked";
  window.__log = [];
  for (const k of ["log", "warn", "error"]) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { try { window.__log.push([k, a.map((x) => x instanceof Error ? (x.stack || x.message) : (typeof x === "string" ? x : JSON.stringify(x))).join(" ")]); } catch (_) {} orig(...a); };
  }
  window.addEventListener("error", (e) => window.__log.push(["error", "uncaught: " + (e.message || e)]));
  window.addEventListener("unhandledrejection", (e) => window.__log.push(["error", "unhandled: " + (e.reason && (e.reason.stack || e.reason.message) || e.reason)]));
  return "hooked";
})()
"""


async def page_ws():
    async with aiohttp.ClientSession() as s:
        async with s.get(f"http://127.0.0.1:{PORT}/json") as r:
            targets = await r.json()
    pages = [t for t in targets if t.get("type") == "page" and "scumble://" in t.get("url", "")]
    if not pages:
        raise SystemExit("no scumble page on port %d: %s" % (PORT, json.dumps([(t.get("type"), t.get("url")) for t in targets])))
    return pages[0]["webSocketDebuggerUrl"]


class Cdp:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0

    async def call(self, method, **params):
        self.n += 1
        await self.ws.send_json({"id": self.n, "method": method, "params": params})
        while True:
            msg = await self.ws.receive_json()
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(json.dumps(msg["error"]))
                return msg.get("result", {})

    async def eval(self, expr, timeout=600):
        r = await asyncio.wait_for(self.call("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True), timeout)
        if "exceptionDetails" in r:
            ed = r["exceptionDetails"]
            desc = ed.get("exception", {}).get("description") or ed.get("text")
            raise RuntimeError("JS exception: " + str(desc))
        return r.get("result", {}).get("value")

    async def screenshot(self, out, scale=1.0):
        r = await self.call("Page.captureScreenshot", format="png", captureBeyondViewport=False)
        data = base64.b64decode(r["data"])
        if scale != 1.0:
            from PIL import Image
            im = Image.open(io.BytesIO(data))
            im = im.resize((int(im.width * scale), int(im.height * scale)))
            im.save(out)
        else:
            open(out, "wb").write(data)
        return out

    async def logs(self):
        return json.loads(await self.eval("JSON.stringify(window.__log.splice(0))"))


async def session(fn):
    """Run fn(cdp) inside a connected session with the console hook installed."""
    url = await page_ws()
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect(url, max_msg_size=64 * 1024 * 1024) as ws:
            c = Cdp(ws)
            await c.eval(HOOK)
            return await fn(c)


async def main():
    sys.stdout.reconfigure(encoding="utf-8")
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""

    async def run(c):
        if cmd == "eval":
            v = await c.eval(sys.argv[2])
            print(json.dumps(v, indent=1, ensure_ascii=False) if not isinstance(v, str) else v)
        elif cmd == "shot":
            print("saved", await c.screenshot(sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 1.0))
        elif cmd == "log":
            for k, m in await c.logs():
                print(k.upper(), m[:2000])
        else:
            raise SystemExit(__doc__)

    await session(run)


if __name__ == "__main__":
    asyncio.run(main())
