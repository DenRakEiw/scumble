"""The ComfyUI window (item 35 V1, docs/PLAN_COMFY_VIEW.md §2.1, §2.5, §3 V1).

No ComfyUI: a stub server this test starts on 127.0.0.1 plays the page (it checks the auth on "/" and on the
websocket "/ws", and records the page's keys). In the app (a --no-comfy instance, which shows no ComfyUI unless the
opener passes a stub's URL):

- with no target the window shows the bar's start page and loads nothing; a second open brings the same window to
  the front; its bounds come back after a close;
- on the stub the page loads in its own process and has no window.scumble, no window.comfybar and no require; a
  navigation away from the stub's origin and a window.open are refused;
- Ctrl+S in the page reaches the page and no menu command of Scumble's, also after Scumble's menu was built again;
- the auth of Settings › ComfyUI reaches the page and its websocket: basic, bearer and a custom header; a wrong
  password ends on the start page with the 401 (no prompt, no loop); a server that does not answer says so.

It refuses an instance connected to ComfyUI and a profile that holds a ComfyUI secret; the settings and the secret it
writes are put back at the end whatever happens.

    python tools/comfyview_test.py [out_dir]

Start the app first, offline: ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
"""
import asyncio
import base64
import json
import os
import socket
import sys

import aiohttp
from aiohttp import web

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Cdp, PORT, session  # noqa: E402

SECRET = "tok-comfyview-123"
PAGE = """<!doctype html><title>stub</title><script>
window.__keys = [];
addEventListener('keydown', (e) => window.__keys.push((e.ctrlKey ? 'ctrl+' : '') + e.key), true);
const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws?clientId=t');
ws.onopen = () => { document.title = 'open'; };
ws.onclose = (e) => { if (document.title !== 'open') document.title = 'closed ' + e.code; };
</script><p>stub ComfyUI</p>"""


class Stub:
    """The page and its websocket; `mode` says what auth a request must carry."""

    def __init__(self):
        self.mode = "none"
        self.seen = []

    def ok(self, h):
        if self.mode == "basic":
            return h.get("Authorization") == "Basic " + base64.b64encode(b"user:" + SECRET.encode()).decode()
        if self.mode == "bearer":
            return h.get("Authorization") == "Bearer " + SECRET
        if self.mode == "header":
            return h.get("X-Pod-Token") == SECRET
        return True

    async def page(self, req):
        good = self.ok(req.headers)
        self.seen.append(("page", good))
        if not good:
            hdr = {"WWW-Authenticate": 'Basic realm="pod"'} if self.mode == "basic" else {}
            return web.Response(status=401, text="no", headers=hdr)
        return web.Response(text=PAGE, content_type="text/html")

    async def ws(self, req):
        good = self.ok(req.headers)
        self.seen.append(("ws", good))
        if not good:
            return web.Response(status=401, text="no")
        sock = web.WebSocketResponse()
        await sock.prepare(req)
        await sock.send_str("{}")
        async for _ in sock:
            pass
        return sock

    async def start(self):
        app = web.Application()
        app.router.add_get("/ws", self.ws)
        app.router.add_get("/", self.page)
        app.router.add_get("/favicon.ico", lambda r: web.Response(status=404))
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        self.port = s.getsockname()[1]
        s.close()
        await web.TCPSite(self.runner, "127.0.0.1", self.port).start()
        self.url = f"http://127.0.0.1:{self.port}"


async def target(sub, timeout=10):
    """A CDP session on the first page target whose URL holds `sub` (the bar, the stub page)."""
    t0 = asyncio.get_event_loop().time()
    async with aiohttp.ClientSession() as s:
        while True:
            async with s.get(f"http://127.0.0.1:{PORT}/json") as r:
                targets = await r.json()
            hit = [t for t in targets if t.get("type") == "page" and sub in t.get("url", "")]
            if hit or asyncio.get_event_loop().time() - t0 > timeout:
                return hit


async def on_target(sub, fn):
    hit = await target(sub)
    if not hit:
        raise Exception(f"no page target holding {sub!r}")
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect(hit[0]["webSocketDebuggerUrl"], max_msg_size=64 * 1024 * 1024) as ws:
            return await fn(Cdp(ws))


async def ctrl_s(c):
    for typ in ("rawKeyDown", "keyUp"):
        await c.call("Input.dispatchKeyEvent", type=typ, modifiers=2, key="s", code="KeyS", windowsVirtualKeyCode=83, nativeVirtualKeyCode=83)


class Gate:
    def __init__(self, c, stub, out):
        self.c, self.stub, self.out = c, stub, out
        self.results = []

    async def js(self, body):
        return await self.c.eval("(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); %s })()" % body)

    async def open_and_wait(self, url="", want=("page", "error", "none"), ms=10000):
        await self.js("await window.scumble.comfyView.open(%s);" % (json.dumps({"url": url}) if url else ""))
        return await self.js("""const t0 = Date.now(); for (;;) { const i = await window.scumble.comfyView.info();
            if (%s.includes(i.phase)) return i; if (Date.now() - t0 > %d) return i; await wait(100); }""" % (json.dumps(list(want)), ms))

    async def close(self):
        await self.js("await window.scumble.comfyView.close(); for (let i = 0; i < 50; i++) { if (!(await window.scumble.comfyView.info()).open) return; await wait(100); }")

    async def set_auth(self, auth, secret):
        await self.js("""const s = await window.scumble.settings.get();
            await window.scumble.settings.set({ comfy: { ...(s.comfy || {}), auth: %s } });
            await window.scumble.keys.set('comfy-auth', %s);""" % (json.dumps(auth), json.dumps(secret)))

    async def step(self, name, fn):
        try:
            detail = await fn()
            self.results.append((name, True, detail))
            print(f"[ok] {name}: {json.dumps(detail)[:300]}")
        except Exception as e:  # noqa: BLE001
            self.results.append((name, False, str(e)))
            print(f"[FAIL] {name}: {e}")

    # ---- the steps ---------------------------------------------------------------------------------

    async def no_target(self):
        i = await self.open_and_wait(want=("none",))
        if i["phase"] != "none" or "--no-comfy" not in i["message"]:
            raise Exception("no start page: " + json.dumps(i))
        if i["page"]["url"] or i["page"]["visible"]:
            raise Exception("the page loaded something with no target: " + json.dumps(i["page"]))
        async def bar(c):
            return await c.eval("""(async () => { const why = () => document.getElementById('cb-why');
                for (let i = 0; i < 50 && !(why() && why().textContent); i++) await new Promise((r) => setTimeout(r, 100));
                return { scumble: typeof window.scumble, comfybar: typeof window.comfybar, start: !document.getElementById('cb-start').hidden,
                why: document.getElementById('cb-why').textContent, h: innerHeight }; })()""")
        b = await on_target("comfybar.html", bar)
        if b["scumble"] != "undefined" or b["comfybar"] != "object" or not b["start"] or "--no-comfy" not in b["why"]:
            raise Exception("the bar: " + json.dumps(b))
        if b["h"] < 200:
            raise Exception("the start page does not fill the window: " + json.dumps(b))
        # a second open: the same window, in front
        i2 = await self.open_and_wait(want=("none",))
        bars = await target("comfybar.html")
        if len(bars) != 1 or not i2["open"]:
            raise Exception(f"a second open made {len(bars)} bars")
        bounds = i2["bounds"]
        await self.close()
        if (await self.js("return (await window.scumble.settings.get()).comfyView"))["bounds"]["width"] != bounds["width"]:
            raise Exception("the bounds were not kept")
        i3 = await self.open_and_wait(want=("none",))
        if i3["bounds"] != bounds:
            raise Exception(f"bounds after reopening {i3['bounds']} != {bounds}")
        await self.close()
        return {"bar": b, "bounds": bounds, "secondFocused": i2["focused"]}

    async def page(self):
        self.stub.mode = "none"
        await self.set_auth({"type": "none"}, "")
        i = await self.open_and_wait(self.stub.url)
        if i["phase"] != "page":
            raise Exception("the stub did not load: " + json.dumps(i))

        async def inside(c):
            for _ in range(50):
                if await c.eval("document.title") == "open":
                    break
                await asyncio.sleep(0.1)
            g = await c.eval("({ title: document.title, scumble: typeof window.scumble, comfybar: typeof window.comfybar, require: typeof window.require, process: typeof window.process })")
            pop = await c.eval("(() => { const w = window.open('scumble://app/index.html'); return w === null; })()")
            await c.eval("location.href = 'scumble://app/index.html'; 1")
            await asyncio.sleep(0.8)
            here = await c.eval("location.href")
            return {**g, "openDenied": pop, "after": here}
        g = await on_target(self.stub.url, inside)
        if g["title"] != "open":
            raise Exception("the page's websocket did not open: " + json.dumps(g))
        if g["scumble"] != "undefined" or g["comfybar"] != "undefined" or g["require"] != "undefined" or g["process"] != "undefined":
            raise Exception("the page reaches the app: " + json.dumps(g))
        if not g["openDenied"] or not g["after"].startswith(self.stub.url):
            raise Exception("the page left the stub: " + json.dumps(g))
        return g

    async def keys(self):
        # The keys go in through DevTools; an occluded window (the gate runs behind other windows) gets them only with
        # focus emulated. The control first: the same kind of key in the editor's window reaches Scumble's menu there
        # (Ctrl+Shift+L, the console), so a key that reaches no menu in the ComfyUI window says something. The control
        # runs with the ComfyUI window closed: while it has the focus, a key put into the editor's page reaches no menu
        await self.close()
        await self.js("window.__menuSeen = []; if (window.__menuOff) window.__menuOff(); window.__menuOff = window.scumble.onMenu((c) => window.__menuSeen.push(c)); return 1")
        await self.c.call("Emulation.setFocusEmulationEnabled", enabled=True)
        for typ in ("rawKeyDown", "keyUp"):
            await self.c.call("Input.dispatchKeyEvent", type=typ, modifiers=10, key="L", code="KeyL", windowsVirtualKeyCode=76, nativeVirtualKeyCode=76)
        await asyncio.sleep(0.8)
        await self.c.call("Emulation.setFocusEmulationEnabled", enabled=False)
        control = await self.js("const m = window.__menuSeen.splice(0); const d = document.getElementById('log-dialog'); if (d && d.open) d.close(); return m")
        if "console" not in control:
            raise Exception(f"the control failed: Ctrl+Shift+L in the editor's window reached no menu ({control}), so the test cannot tell")
        self.stub.mode = "none"
        if (await self.open_and_wait(self.stub.url))["phase"] != "page":
            raise Exception("the stub did not load again")
        seen = []
        for rebuilt in (False, True):
            if rebuilt:
                await self.js("await window.scumble.appearance.get(); return 1")   # main builds the menu again
            async def press(c):
                await c.call("Emulation.setFocusEmulationEnabled", enabled=True)
                await c.eval("window.__keys = []; 1")
                await ctrl_s(c)
                await asyncio.sleep(0.8)
                await c.call("Emulation.setFocusEmulationEnabled", enabled=False)
                return await c.eval("window.__keys")
            k = await on_target(self.stub.url, press)
            menu = await self.js("return window.__menuSeen.slice()")
            if "ctrl+s" not in k:
                raise Exception(f"Ctrl+S did not reach the page (rebuilt menu: {rebuilt}): {k}")
            if menu:
                raise Exception(f"Ctrl+S in the page reached Scumble's menu (rebuilt menu: {rebuilt}): {menu}")
            seen.append(k)
        await self.js("window.__menuOff(); window.__menuOff = null; return 1")
        return {"control": control, "page": seen}

    async def auth(self, mode, auth, secret=SECRET):
        await self.close()
        self.stub.mode = mode
        self.stub.seen = []
        await self.set_auth(auth, secret)
        i = await self.open_and_wait(self.stub.url)
        if i["phase"] != "page":
            raise Exception(f"{mode}: " + json.dumps(i))
        async def title(c):
            for _ in range(50):
                t = await c.eval("document.title")
                if t == "open" or t.startswith("closed"):
                    return t
                await asyncio.sleep(0.1)
            return t
        t = await on_target(self.stub.url, title)
        if t != "open" or ("ws", True) not in self.stub.seen or ("page", True) not in self.stub.seen or ("ws", False) in self.stub.seen:
            raise Exception(f"{mode}: socket {t}, stub saw {self.stub.seen}")
        return {"socket": t, "seen": self.stub.seen}

    async def wrong_password(self):
        await self.close()
        self.stub.mode = "basic"
        self.stub.seen = []
        await self.set_auth({"type": "basic", "user": "user"}, "wrong")
        i = await self.open_and_wait(self.stub.url, want=("error",))
        if i["phase"] != "error" or "401" not in i["message"] or i["page"]["visible"]:
            raise Exception("no 401 start page: " + json.dumps(i))
        if len(self.stub.seen) > 4:
            raise Exception(f"the login was answered again and again: {len(self.stub.seen)} requests")
        return {"message": i["message"], "requests": len(self.stub.seen)}

    async def unreachable(self):
        await self.close()
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        i = await self.open_and_wait(f"http://127.0.0.1:{port}", want=("error",))
        if i["phase"] != "error" or "does not answer" not in i["message"]:
            raise Exception("no start page for a dead server: " + json.dumps(i))
        return {"message": i["message"]}


async def main():
    sys.stdout.reconfigure(encoding="utf-8")
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join("dist", "gates", "comfyview")
    os.makedirs(out, exist_ok=True)
    stub = Stub()
    await stub.start()

    async def run(c):
        st = await c.eval("window.scumble.comfy.status()")
        if st.get("url"):
            raise SystemExit("refused: the instance is connected to ComfyUI (start it with --no-comfy)")
        keys = (await c.eval("window.scumble.keys.list()"))["keys"]
        if keys.get("comfy-auth", {}).get("set"):
            raise SystemExit("refused: the profile holds a ComfyUI secret")
        saved = (await c.eval("window.scumble.settings.get()")).get("comfy")
        g = Gate(c, stub, out)
        try:
            await g.close()
            await g.step("no target: the start page, nothing loaded, one window, bounds kept", g.no_target)
            await g.step("the stub page: no app API, stays on its origin", g.page)
            await g.step("Ctrl+S reaches the page, not Scumble's menu", g.keys)
            await g.step("basic auth on the page and /ws", lambda: g.auth("basic", {"type": "basic", "user": "user"}))
            await g.step("bearer on the page and /ws", lambda: g.auth("bearer", {"type": "bearer"}))
            await g.step("a custom header on the page and /ws", lambda: g.auth("header", {"type": "header", "header": "X-Pod-Token"}))
            await g.step("a wrong password: the 401 on the start page, no loop", g.wrong_password)
            await g.step("a server that does not answer", g.unreachable)
        finally:
            await g.close()
            await c.eval("(async () => { const s = await window.scumble.settings.get(); await window.scumble.settings.set({ comfy: %s || s.comfy }); await window.scumble.keys.clear('comfy-auth'); return 1; })()" % json.dumps(saved))
        return g.results

    try:
        results = await session(run)
    finally:
        await stub.runner.cleanup()
    with open(os.path.join(out, "results.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, indent=1)
    failed = [r for r in results if not r[1]]
    print("FAIL" if failed else "PASS", f"({len(results) - len(failed)} of {len(results)})")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())
