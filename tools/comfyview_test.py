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
  password ends on the start page with the 401 (no prompt, no loop); a server that does not answer says so;
- V2, a recipe as a graph: on a stub whose fake window.app records what it is given, a shipped ComfyUI recipe arrives
  as its API prompt with the result and the Settings rows wired to the canvas node, under the recipe's name, and the
  bar names it; a provider recipe is refused; a page without window.app and a load that throws say so in the bar;
  with no target the start page names the recipe;
- V3, a graph as a recipe: the bar's Save to recipe overwrites the held recipe with the page's graph (a shipped one as
  a user copy under its id, its Settings rows and labels kept, the UI graph stored) and the editor selects it; Save as
  new recipe takes its name in the bar and makes a new recipe; a graph without the Inpaint Canvas node and an answer
  that is no prompt are refused and save nothing. The recipes it saves are removed at the end; it refuses a profile
  that holds a user recipe of the shipped id it overwrites;
- V4, Comfy Cloud: tools/comfyhosts_test.js first (the sign-in hosts, popups, navigation); then, with the stub standing
  in for the cloud, the window titled Comfy Cloud refuses a recipe with the Inpaint Canvas node and offers no save,
  the bar's select switches to My ComfyUI and the held recipe loads there, the target is kept (the saves are offered
  on the cloud since V5c); with no target the start
  page names Comfy Cloud, and its Use Comfy Cloud switches. The target the profile had is put back;
- V5c, Comfy Cloud recipes: Settings › Recipes' Cloud copy saves "<id>_cloud" and the editor selects it; that recipe
  opens on Comfy Cloud in the window as its graph without the node; a graph without the node saved from the window is
  a new Comfy Cloud recipe, Save to recipe overwrites it, and a graph with the node is refused for it;
- V6, the cloud mode: the editor's mode select offers api, local and cloud; with no Comfy Cloud recipe, cloud says so
  and the select goes back; with the two the V5c steps made, cloud lists them alone (the negative shown, denoise not),
  api lists none of them, and each mode comes back with the recipe last used in it; list_recipes and set_generation
  know the mode;
- a page that keeps unsaved changes (beforeunload, as ComfyUI does): Reload asks, Stay ends on the page as it was
  (ready to save, the window not stuck on "Loading"), Leave loads it again;
- a page whose ComfyUI sets up after the wait gave up (many node packs): the save buttons are on with the page, a
  save before window.app says so, and once it is there the save works without a reload.

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

import subprocess

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

# a fake ComfyUI frontend for V2: window.app records the graph it is given ("throw": its load fails)
FAKE_APP = """<script>
window.app = { graph: {},
  loadApiJson: async (prompt, name) => { if (window.__throw) throw new Error('boom'); window.__loaded = { kind: 'api', prompt, name }; },
  loadGraphData: async (workflow) => { if (window.__throw) throw new Error('boom'); window.__loaded = { kind: 'graph', workflow }; },
  graphToPrompt: async () => ({ workflow: window.__wf || { nodes: [], links: [] }, output: window.__out || (window.__loaded && window.__loaded.prompt) || {} }) };
window.__throw = %s;
</script>"""


class Stub:
    """The page and its websocket; `mode` says what auth a request must carry."""

    def __init__(self):
        self.mode = "none"
        self.seen = []
        self.app = None     # None: no window.app; "ok": a fake one; "throw": one whose load fails
        self.unload = False     # a beforeunload handler that keeps the page, as ComfyUI's with an unsaved workflow

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
        app = (FAKE_APP % ("true" if self.app == "throw" else "false")) if self.app else ""
        keep = "<script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });</script>" if self.unload else ""
        return web.Response(text=PAGE + app + keep, content_type="text/html")

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
        app.router.add_get("/object_info", lambda r: web.json_response({}))
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

    async def bar_text(self):
        async def read(c):
            return await c.eval("""(async () => { const $ = (id) => document.getElementById(id);
                for (let i = 0; i < 60 && !($('cb-recipe') && $('cb-recipe').textContent !== 'No recipe'); i++) await new Promise((r) => setTimeout(r, 100));
                return { recipe: $('cb-recipe').textContent, note: $('cb-recipe-note').textContent, why: $('cb-why').textContent }; })()""")
        return await on_target("comfybar.html", read)

    async def wait_info(self, cond, ms=8000):
        return await self.js("""const t0 = Date.now(); for (;;) { const i = await window.scumble.comfyView.info();
            if (%s) return i; if (Date.now() - t0 > %d) return i; await wait(150); }""" % (cond, ms))

    async def recipe_graph(self):
        await self.close()
        self.stub.mode = "none"
        self.stub.app = "ok"
        await self.set_auth({"type": "none"}, "")
        r = await self.js("return (await window.scumble.recipes.list()).find((x) => x.id === 'flux2_klein_local')")
        await self.js("await window.scumble.comfyView.open(%s); return 1" % json.dumps({"url": self.stub.url, "recipe": r["id"]}))
        i = await self.wait_info("i.recipeLoaded || i.recipeNote", 15000)
        if not i.get("recipeLoaded"):
            raise Exception("the recipe did not load: " + json.dumps(i))
        got = await on_target(self.stub.url, lambda c: c.eval("window.__loaded"))
        p = got["prompt"]
        res = r["result"].split(":")
        wired = all(p[s["node"]]["inputs"][s["input"]] == [r["canvas"], 12 + s["index"]] for s in r["settings"])
        if got["kind"] != "api" or got["name"] != r["name"] or p[r["canvas"]]["inputs"].get("result_local") != [res[0], int(res[1])] or not wired:
            raise Exception("the page got: " + json.dumps(got)[:600])
        b = await self.bar_text()
        if b["recipe"] != "Editing: " + r["name"] or b["note"]:
            raise Exception("the bar: " + json.dumps(b))
        # the same window, a second recipe: it replaces the first
        q = await self.js("return (await window.scumble.recipes.list()).find((x) => x.id === 'upscale_model_local')")
        await self.js("await window.scumble.comfyView.open({ recipe: 'upscale_model_local' }); return 1")
        i2 = await self.wait_info("i.recipeId === 'upscale_model_local' && (i.recipeLoaded || i.recipeNote)")
        got2 = await on_target(self.stub.url, lambda c: c.eval("window.__loaded"))
        if not i2.get("recipeLoaded") or got2["name"] != q["name"]:
            raise Exception("the second recipe: " + json.dumps({"info": i2, "name": got2.get("name")}))
        return {"name": got["name"], "nodes": len(p), "bar": b["recipe"], "second": got2["name"]}

    async def recipe_refused(self):
        err = await self.js("try { await window.scumble.comfyView.open({ recipe: 'flux3' }); return null; } catch (e) { return String(e.message || e); }")
        if not err or "provider" not in err:
            raise Exception(f"a provider recipe was not refused: {err}")
        return {"error": err[-140:]}

    async def recipe_troubles(self):
        await self.close()
        self.stub.app = "throw"
        await self.js("await window.scumble.comfyView.open(%s); return 1" % json.dumps({"url": self.stub.url, "recipe": "flux2_klein_local"}))
        i = await self.wait_info("i.recipeNote", 15000)
        if "did not load" not in i.get("recipeNote", "") or "boom" not in i["recipeNote"] or i.get("recipeLoaded"):
            raise Exception("a load that throws: " + json.dumps(i))
        await self.close()
        self.stub.app = None
        await self.js("await window.scumble.comfyView.open(%s); return 1" % json.dumps({"url": self.stub.url, "recipe": "flux2_klein_local"}))
        i2 = await self.wait_info("i.recipeNote", 30000)
        if "no way to load a graph" not in i2.get("recipeNote", ""):
            raise Exception("a page without window.app: " + json.dumps(i2))
        await self.close()
        await self.js("await window.scumble.comfyView.open({ recipe: 'flux2_klein_local' }); return 1")
        i3 = await self.wait_info("i.phase === 'none'")
        b = await self.bar_text()
        if i3["phase"] != "none" or "Klein" not in b["recipe"] or "opens here once a ComfyUI answers" not in b["why"]:
            raise Exception("no target with a recipe: " + json.dumps({"info": i3, "bar": b}))
        await self.close()
        return {"throws": i["recipeNote"], "noApp": i2["recipeNote"], "noTarget": b["why"][-90:]}

    async def bar_click(self, js):
        # the bar of a window just opened may still be loading: its buttons first
        await on_target("comfybar.html", lambda c: c.eval("""(async () => { for (let k = 0; k < 60 && !(document.readyState === 'complete' && document.getElementById('cb-save')); k++) await new Promise((r) => setTimeout(r, 100));
            %s; return 1; })()""" % js))

    async def recipe_list(self):
        return await self.js("return (await window.scumble.recipes.list()).map((r) => ({ id: r.id, name: r.name, source: r.source, settings: r.settings, mark: r.prompt && r.prompt.sigmas ? r.prompt.sigmas.inputs.gate_mark : undefined, workflow: r.workflow || null }))")

    async def save_over(self):
        await self.close()
        self.stub.mode = "none"
        self.stub.app = "ok"
        shipped = next(r for r in await self.recipe_list() if r["id"] == "flux2_klein_local")
        await self.js("await window.scumble.comfyView.open(%s); return 1" % json.dumps({"url": self.stub.url, "recipe": "flux2_klein_local"}))
        i = await self.wait_info("i.recipeLoaded || i.recipeNote", 15000)
        if not i.get("recipeLoaded") or not i.get("canSave"):
            raise Exception("not ready to save: " + json.dumps(i))
        await on_target(self.stub.url, lambda c: c.eval("""(() => { window.__out = JSON.parse(JSON.stringify(window.__loaded.prompt));
            window.__out.sigmas.inputs.gate_mark = 7; window.__wf = { nodes: [{ id: 'canvas', type: 'InpaintCanvas' }], links: [], extra: { gate: 1 } }; return 1; })()"""))
        await self.bar_click("document.getElementById('cb-save').click()")
        i2 = await self.wait_info("i.saveNote", 10000)
        if "Saved the graph" not in i2.get("saveNote", "") or "stands in for the shipped recipe" not in i2["saveNote"]:
            raise Exception("Save to recipe: " + json.dumps(i2))
        mine = next((r for r in await self.recipe_list() if r["id"] == "flux2_klein_local"), None)
        if not mine or mine["source"] != "user" or mine["mark"] != 7 or (mine["workflow"] or {}).get("extra", {}).get("gate") != 1 or mine["settings"] != shipped["settings"]:
            raise Exception("the saved recipe: " + json.dumps(mine)[:500])
        sel = await self.js("for (let k = 0; k < 30 && !/Saved the graph/.test(document.body.textContent); k++) await wait(100); return document.getElementById('shell-recipe').value")
        if sel != "flux2_klein_local":
            raise Exception("the editor did not select the saved recipe: " + str(sel))
        return {"note": i2["saveNote"][:120], "rows": len(mine["settings"])}

    async def save_new(self):
        await self.bar_click("document.getElementById('cb-save-new').click()")
        await self.bar_click("document.getElementById('cb-name').value = 'Gate graph'; document.getElementById('cb-name-ok').click()")
        i = await self.wait_info("i.saveNote && i.recipeId === 'gate_graph'", 10000)
        new = next((r for r in await self.recipe_list() if r["id"] == "gate_graph"), None)
        if not new or new["name"] != "Gate graph" or new["source"] != "user" or i.get("recipe") != "Gate graph":
            raise Exception("Save as new recipe: " + json.dumps({"info": i, "recipe": new})[:500])
        sel = await self.js("for (let k = 0; k < 30 && document.getElementById('shell-recipe').value !== 'gate_graph'; k++) await wait(100); return document.getElementById('shell-recipe').value")
        b = await self.bar_text()
        if sel != "gate_graph" or b["recipe"] != "Editing: Gate graph":
            raise Exception(f"after the save: editor {sel}, bar {b}")
        return {"id": new["id"], "bar": b["recipe"]}

    async def save_refused(self):
        out = {}
        for what, js, want in (("no canvas", "window.__out = { x: { class_type: 'KSampler', inputs: {} } }", "no Inpaint Canvas node"),
                               ("no prompt", "window.__out = { a: 1 }", "no graph Scumble can read")):
            await on_target(self.stub.url, lambda c: c.eval("(() => { %s; return 1; })()" % js))
            await self.bar_click("document.getElementById('cb-save-new').click()")
            await self.bar_click("document.getElementById('cb-name').value = 'Gate bad'; document.getElementById('cb-name-ok').click()")
            i = await self.wait_info("i.saveNote && i.saveNote.indexOf(%s) >= 0" % json.dumps(want), 8000)
            if want not in i.get("saveNote", ""):
                raise Exception(f"{what}: " + json.dumps(i))
            out[what] = i["saveNote"]
        if any(r["id"].startswith("gate_bad") for r in await self.recipe_list()):
            raise Exception("a refused graph was saved")
        return out

    async def cleanup_recipes(self):
        await self.js("""for (const r of await window.scumble.recipes.list()) if (r.source === 'user' && (r.id === 'flux2_klein_local' || r.id === 'flux2_klein_local_cloud' || /^gate_(graph|bad|cloud|late)/.test(r.id))) await window.scumble.recipes.remove(r.id);
            const S = await import('./shell.js'); await S.loadRecipes(); S.selectRecipe('flux2_klein_local'); return 1""")

    async def hosts(self):
        # plain Node: the sign-in hosts (V4) and a detached recipe run through the Comfy Cloud adapter (V5b)
        root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
        out = {}
        for name in ("comfyhosts_test.js", "cloudgraph_test.js"):
            r = subprocess.run(["node", os.path.join(root, "tools", name)], cwd=root, capture_output=True, text=True, encoding="utf-8", timeout=120)
            tail = r.stdout.strip()
            if r.returncode != 0 or not tail.endswith("PASS"):
                raise Exception(f"tools/{name}: " + (tail + r.stderr)[-800:])
            out[name] = tail.count("[ok]")
        return out

    async def cloud(self):
        await self.close()
        await self.cleanup_recipes()    # the V3 steps saved a copy of the shipped recipe with a UI graph of their own
        self.stub.mode = "none"
        self.stub.app = "ok"
        await self.set_auth({"type": "none"}, "")
        await self.js("await window.scumble.comfyView.open(%s); return 1" % json.dumps({"url": self.stub.url, "recipe": "flux2_klein_local", "target": "cloud"}))
        i = await self.wait_info("i.phase === 'page' && i.recipeNote", 15000)
        await asyncio.sleep(1.0)    # the page is ready by now: the recipe must still not be in it
        loaded = await on_target(self.stub.url, lambda c: c.eval("window.__loaded || null"))
        # the saves are offered there since V5c: a graph without the node becomes a Comfy Cloud recipe
        if i["target"] != "cloud" or i["title"] != "Comfy Cloud" or "no Inpaint Canvas node" not in i["recipeNote"] or loaded:
            raise Exception("Comfy Cloud: " + json.dumps({"info": i, "loaded": loaded})[:600])
        sel = await on_target("comfybar.html", lambda c: c.eval("(async () => { for (let k = 0; k < 30 && document.getElementById('cb-target').value !== 'cloud'; k++) await new Promise((r) => setTimeout(r, 100)); return document.getElementById('cb-target').value; })()"))
        if sel != "cloud":
            raise Exception("the bar's select shows " + str(sel))
        await on_target("comfybar.html", lambda c: c.eval("(() => { const s = document.getElementById('cb-target'); s.value = 'comfy'; s.dispatchEvent(new Event('change')); return 1; })()"))
        i2 = await self.wait_info("i.target === 'comfy' && i.recipeLoaded", 15000)
        got = await on_target(self.stub.url, lambda c: c.eval("window.__loaded || null"))
        stored = await self.js("return ((await window.scumble.settings.get()).comfyView || {}).target")
        if not i2.get("recipeLoaded") or not got or got.get("name") != "Flux.2 Klein 4B / 9B (ComfyUI)" or stored != "comfy" or i2["recipeNote"]:
            raise Exception("switched to My ComfyUI: " + json.dumps({"info": i2, "stored": stored, "loaded": (got or {}).get("name")})[:600])
        return {"cloudNote": i["recipeNote"][:80], "switched": i2["title"]}

    async def cloud_start(self):
        await self.close()
        await self.js("await window.scumble.comfyView.open({ target: 'cloud' }); return 1")
        i = await self.wait_info("i.phase === 'none'")
        async def h1(c):
            return await c.eval("(async () => { for (let k = 0; k < 40 && !(document.querySelector('#cb-start h1') && /Cloud/.test(document.querySelector('#cb-start h1').textContent)); k++) await new Promise((r) => setTimeout(r, 100)); return document.querySelector('#cb-start h1').textContent; })()")
        head = await on_target("comfybar.html", h1)
        if i["target"] != "cloud" or "Comfy Cloud (--no-comfy)" not in i["message"] or head != "No Comfy Cloud to show.":
            raise Exception("no Comfy Cloud: " + json.dumps({"info": i, "h1": head}))
        await self.js("await window.scumble.comfyView.open({ target: 'comfy' }); return 1")
        await self.wait_info("i.target === 'comfy'")
        await self.bar_click("document.getElementById('cb-cloud').click()")
        i2 = await self.wait_info("i.target === 'cloud'")
        if i2["target"] != "cloud":
            raise Exception("Use Comfy Cloud did not switch: " + json.dumps(i2))
        await self.close()
        return {"message": i["message"], "h1": head}

    async def cloud_copy(self):
        await self.close()
        await self.cleanup_recipes()
        sel = await self.js("""const S = await import('./shell.js'); await S.openSettings();
            const row = document.querySelector('.shell-recipe[data-id="flux2_klein_local"]');
            const btn = row && Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Cloud copy');
            if (!btn) return 'no Cloud copy button';
            btn.click();
            for (let k = 0; k < 50 && document.getElementById('shell-recipe').value !== 'flux2_klein_local_cloud'; k++) await wait(100);
            const d = document.querySelector('dialog[open]'); if (d) d.close();
            return document.getElementById('shell-recipe').value""")
        r = next((x for x in await self.js("return await window.scumble.recipes.list()") if x["id"] == "flux2_klein_local_cloud"), None)
        v = (r or {}).get("providers", {}).get("comfycloud", {})
        if sel != "flux2_klein_local_cloud" or not r or r.get("kind") != "provider" or r.get("source") != "user" or (v.get("options") or {}).get("pictures") != 4:
            raise Exception("Cloud copy: " + json.dumps({"selected": sel, "recipe": (r or {}).get("id")}))
        # it opens on Comfy Cloud in the window as its graph without the node
        self.stub.mode = "none"
        self.stub.app = "ok"
        await self.set_auth({"type": "none"}, "")
        await self.js("await window.scumble.comfyView.open(%s); return 1" % json.dumps({"url": self.stub.url, "recipe": "flux2_klein_local_cloud", "target": "cloud"}))
        i = await self.wait_info("i.recipeLoaded || i.recipeNote", 15000)
        got = await on_target(self.stub.url, lambda c: c.eval("window.__loaded || null"))
        nodes = list((got or {}).get("prompt", {}).values())
        if not i.get("recipeLoaded") or i["target"] != "cloud" or any(n["class_type"] == "InpaintCanvas" for n in nodes) or not any((n.get("_meta") or {}).get("title") == "scumble:picture:0" for n in nodes):
            raise Exception("the cloud copy in the window: " + json.dumps({"info": i, "nodes": [n["class_type"] for n in nodes]})[:500])
        return {"selected": sel, "nodes": len(nodes), "title": i["title"]}

    async def cloud_save(self):
        marked = {"1": {"class_type": "LoadImage", "inputs": {"image": "x.png"}, "_meta": {"title": "Scumble crop"}},
                  "2": {"class_type": "ImageInvert", "inputs": {"image": ["1", 0]}},
                  "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0], "filename_prefix": "a"}}}
        await on_target(self.stub.url, lambda c: c.eval("(() => { window.__out = %s; window.__wf = { nodes: [], links: [], extra: { cloud: 1 } }; return 1; })()" % json.dumps(marked)))
        await self.bar_click("document.getElementById('cb-save-new').click()")
        await self.bar_click("document.getElementById('cb-name').value = 'Gate cloud'; document.getElementById('cb-name-ok').click()")
        i = await self.wait_info("i.saveNote && i.recipeId === 'gate_cloud'", 10000)
        r = next((x for x in await self.js("return await window.scumble.recipes.list()") if x["id"] == "gate_cloud"), None)
        if not r or r.get("kind") != "provider" or "Comfy Cloud recipe" not in i.get("saveNote", "") or ((r.get("providers") or {}).get("comfycloud") or {}).get("options", {}).get("save") != "3":
            raise Exception("Save as new on Comfy Cloud: " + json.dumps({"info": i, "recipe": (r or {}).get("id")})[:500])
        sel = await self.js("for (let k = 0; k < 30 && document.getElementById('shell-recipe').value !== 'gate_cloud'; k++) await wait(100); return document.getElementById('shell-recipe').value")
        # Save to recipe overwrites it
        await on_target(self.stub.url, lambda c: c.eval("(() => { window.__out['2'] = { class_type: 'ImageScaleBy', inputs: { image: ['1', 0], scale_by: 2 } }; return 1; })()"))
        await self.bar_click("document.getElementById('cb-save').click()")
        g2 = await self.js("""for (let k = 0; k < 80; k++) { const r = (await window.scumble.recipes.list()).find((x) => x.id === 'gate_cloud');
            const g = r && r.providers.comfycloud.options.graph; if (g && g['2'].class_type === 'ImageScaleBy') return g; await wait(100); }
            return (await window.scumble.recipes.list()).find((x) => x.id === 'gate_cloud').providers.comfycloud.options.graph""")
        i2 = await self.js("return await window.scumble.comfyView.info()")
        if g2["2"]["class_type"] != "ImageScaleBy" or sel != "gate_cloud":
            raise Exception("Save to recipe on Comfy Cloud: " + json.dumps({"node": g2["2"], "selected": sel}))
        # a graph with the node is refused for a cloud recipe
        await on_target(self.stub.url, lambda c: c.eval("(() => { window.__out['9'] = { class_type: 'InpaintCanvas', inputs: {} }; return 1; })()"))
        await self.bar_click("document.getElementById('cb-save').click()")
        i3 = await self.wait_info("i.saveNote && i.saveNote.indexOf('is a Comfy Cloud recipe') >= 0", 8000)
        if "is a Comfy Cloud recipe" not in i3.get("saveNote", ""):
            raise Exception("a graph with the node for a cloud recipe: " + json.dumps(i3))
        await self.close()
        return {"new": i["saveNote"][:90], "over": i2["saveNote"][:60], "refused": i3["saveNote"][:80]}

    async def cloud_mode_none(self):
        # V6: the editor's mode select has the app's third mode; with no Comfy Cloud recipe it says so and goes back
        r = await self.js("""const S = await import('./shell.js');
            const clouds = (await window.scumble.recipes.list()).filter((r) => r.providers && r.providers.comfycloud && r.providers.comfycloud.options && r.providers.comfycloud.options.graph).map((r) => r.id);
            S.selectRecipe('flux2_klein_local');
            const ed = window.editor, sel = ed.modeSel;
            const opts = Array.from(sel.options).map((o) => o.value);
            if (clouds.length) return { opts, skipped: clouds };
            sel.value = 'cloud'; sel.dispatchEvent(new Event('change')); await wait(150);
            return { opts, mode: ed.genSettings.mode, shown: sel.value, recipe: document.getElementById('shell-recipe').value, status: ed.status };""")
        if r["opts"] != ["api", "local", "cloud"]:
            raise Exception("the mode select: " + json.dumps(r))
        if "skipped" in r:
            return {"opts": r["opts"], "skipped (the profile has Comfy Cloud recipes)": r["skipped"]}
        if r["mode"] != "local" or r["shown"] != "local" or r["recipe"] != "flux2_klein_local" or not str(r["status"]).startswith("No Comfy Cloud recipe yet"):
            raise Exception("cloud with no Comfy Cloud recipe: " + json.dumps(r))
        return {"opts": r["opts"], "status": r["status"][:60]}

    async def cloud_mode(self):
        # V6: the cloud mode lists the Comfy Cloud recipes alone (the two the V5c steps made), api lists none of them, and
        # the select brings back the one last used in each mode; list_recipes and set_generation know the mode
        r = await self.js("""const S = await import('./shell.js'), host = (await import('./editor/host.js')).host, { commands } = await import('./commands.js');
            const ed = window.editor, sel = ed.modeSel, rs = document.getElementById('shell-recipe');
            const look = () => ({ mode: ed.genSettings.mode, shown: sel.value, list: rs.dataset.mode, recipe: host.recipe && host.recipe.id, ids: Array.from(rs.options).map((o) => o.value), groups: Array.from(rs.querySelectorAll('optgroup')).map((g) => g.label), allCloud: Array.from(rs.options).every((o) => host.shell.modeOf(host.shell.recipes().find((x) => x.id === o.value)) === 'cloud'), negative: !ed.negativeInput.hidden, denoise: !ed.denoiseInput.parentElement.hidden });
            const pick = async (m) => { sel.value = m; sel.dispatchEvent(new Event('change')); await wait(150); return look(); };
            S.selectRecipe('gate_cloud'); await wait(50);
            const cloud = look();
            const api = await pick('api');
            const back = await pick('cloud');
            const listed = (await commands.run('list_recipes', {})).recipes.filter((x) => x.id === 'gate_cloud' || x.id === 'flux2_klein_local').map((x) => [x.id, x.mode]);
            const set = await commands.run('set_generation', { mode: 'cloud' });
            return { cloud, api, back, listed, set: set.mode };""")
        c, a, b = r["cloud"], r["api"], r["back"]
        if c["mode"] != "cloud" or c["shown"] != "cloud" or c["list"] != "cloud" or not {"flux2_klein_local_cloud", "gate_cloud"} <= set(c["ids"]) or not c["allCloud"] or c["groups"] != ["Comfy Cloud"] or not c["negative"] or c["denoise"]:
            raise Exception("the cloud mode: " + json.dumps(c)[:600])
        if a["mode"] != "api" or a["list"] != "api" or not a["ids"] or any(x in a["ids"] for x in ("gate_cloud", "flux2_klein_local_cloud")) or a["recipe"] in ("gate_cloud", "flux2_klein_local_cloud") or a["negative"]:
            raise Exception("api after cloud: " + json.dumps({**a, "ids": a["ids"][:8]})[:600])
        if b["recipe"] != "gate_cloud" or b["mode"] != "cloud" or b["shown"] != "cloud":
            raise Exception("back to cloud: " + json.dumps(b)[:600])
        if sorted(r["listed"]) != [["flux2_klein_local", "local"], ["gate_cloud", "cloud"]] or r["set"] != "cloud":
            raise Exception("list_recipes / set_generation: " + json.dumps(r["listed"]) + " " + str(r["set"]))
        return {"cloud": c["ids"], "api": len(a["ids"]), "back": b["recipe"]}

    async def unsaved(self):
        await self.close()
        self.stub.mode = "none"
        self.stub.app = "ok"
        self.stub.unload = True
        try:
            await self.set_auth({"type": "none"}, "")
            await self.js("await window.scumble.comfyView.open(%s); return 1" % json.dumps({"url": self.stub.url, "leave": "stay"}))
            await self.wait_info("i.phase === 'page' && i.canSaveNew", 15000)

            async def touch(c):
                # Chromium asks on beforeunload only after the user touched the page: a click gives it that
                await c.call("Emulation.setFocusEmulationEnabled", enabled=True)
                for typ in ("mousePressed", "mouseReleased"):
                    await c.call("Input.dispatchMouseEvent", type=typ, x=20, y=20, button="left", clickCount=1)
                await c.eval("window.__mark = 'kept'; 1")
                await c.call("Emulation.setFocusEmulationEnabled", enabled=False)
            await on_target(self.stub.url, touch)
            await self.bar_click("document.getElementById('cb-reload').click()")
            await asyncio.sleep(1.0)
            i = await self.wait_info("i.phase === 'page' && i.canSaveNew", 8000)
            mark = await on_target(self.stub.url, lambda c: c.eval("window.__mark || null"))
            if i["phase"] != "page" or not i["canSaveNew"] or mark != "kept":
                raise Exception("Stay: " + json.dumps({"phase": i["phase"], "canSaveNew": i["canSaveNew"], "mark": mark}))
            await self.js("await window.scumble.comfyView.open({ leave: 'leave' }); return 1")
            await self.bar_click("document.getElementById('cb-reload').click()")
            await asyncio.sleep(1.0)
            i2 = await self.wait_info("i.phase === 'page' && i.canSaveNew", 8000)
            mark2 = await on_target(self.stub.url, lambda c: c.eval("window.__mark || null"))
            if i2["phase"] != "page" or mark2 is not None:
                raise Exception("Leave: " + json.dumps({"phase": i2["phase"], "mark": mark2}))
            return {"stay": [i["phase"], mark], "leave": [i2["phase"], mark2]}
        finally:
            self.stub.unload = False
            await self.close()

    async def late_app(self):
        await self.close()
        self.stub.mode = "none"
        self.stub.app = None    # no window.app at first: the wait gives up after 20 s in a --no-comfy start
        await self.set_auth({"type": "none"}, "")
        await self.js("await window.scumble.comfyView.open(%s); return 1" % json.dumps({"url": self.stub.url}))
        i = await self.wait_info("i.phase === 'page'", 10000)
        if not i.get("canSaveNew"):
            raise Exception("the save buttons are off with the page there: " + json.dumps(i))
        await self.bar_click("document.getElementById('cb-save-new').click()")
        await self.bar_click("document.getElementById('cb-name').value = 'Gate late'; document.getElementById('cb-name-ok').click()")
        i1 = await self.wait_info("i.saveNote", 8000)
        if "still setting this page up" not in i1.get("saveNote", ""):
            raise Exception("a save before window.app: " + json.dumps(i1))
        graph = {"1": {"class_type": "InpaintCanvas", "inputs": {"result_local": ["2", 0]}}, "2": {"class_type": "VAEDecode", "inputs": {}}}
        await on_target(self.stub.url, lambda c: c.eval("(() => { window.app = { graph: {}, loadApiJson: async () => {}, loadGraphData: async () => {}, graphToPrompt: async () => ({ workflow: { nodes: [], links: [] }, output: %s }) }; return 1; })()" % json.dumps(graph)))
        await self.bar_click("document.getElementById('cb-save-new').click()")
        await self.bar_click("document.getElementById('cb-name').value = 'Gate late'; document.getElementById('cb-name-ok').click()")
        i2 = await self.wait_info("i.recipeId === 'gate_late'", 10000)
        r = next((x for x in await self.js("return await window.scumble.recipes.list()") if x["id"] == "gate_late"), None)
        if not r or r.get("kind") == "provider" or i2.get("recipeId") != "gate_late":
            raise Exception("the save once window.app is there: " + json.dumps({"info": i2, "recipe": (r or {}).get("id")})[:400])
        await self.close()
        return {"before": i1["saveNote"][:60], "after": i2["saveNote"][:60]}

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
        target0 = ((await c.eval("window.scumble.settings.get()")).get("comfyView") or {}).get("target")
        mine = await c.eval("(async () => (await window.scumble.recipes.list()).filter((r) => r.source === 'user' && (r.id === 'flux2_klein_local' || r.id === 'flux2_klein_local_cloud' || /^gate_(graph|bad|cloud|late)/.test(r.id))).map((r) => r.id))()")
        if mine:
            raise SystemExit(f"refused: the profile holds user recipes this test would overwrite or remove: {mine}")
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
            await g.step("V2: a recipe arrives as its graph, the bar names it, a second one replaces it", g.recipe_graph)
            await g.step("V2: a provider recipe is refused", g.recipe_refused)
            await g.step("V2: a load that throws, a page without window.app, no target", g.recipe_troubles)
            await g.step("V3: Save to recipe overwrites the held recipe (a shipped one as a user copy), the editor selects it", g.save_over)
            await g.step("V3: Save as new recipe, the name in the bar", g.save_new)
            await g.step("V3: a graph without the node and an answer that is no prompt are refused", g.save_refused)
            await g.step("V4 / V5b: the sign-in hosts, and a detached recipe on a fake Comfy Cloud (plain Node)", g.hosts)
            await g.step("V4: Comfy Cloud refuses a recipe with the node and offers no save; the select switches back", g.cloud)
            await g.step("V4: no Comfy Cloud to show, and Use Comfy Cloud", g.cloud_start)
            await g.step("V6: the editor's mode select has comfy cloud; with no Comfy Cloud recipe it says so and goes back", g.cloud_mode_none)
            await g.step("V5c: Cloud copy in Settings, the copy opened on Comfy Cloud as its graph", g.cloud_copy)
            await g.step("V5c: a graph without the node saved as a Comfy Cloud recipe, overwritten, a graph with the node refused", g.cloud_save)
            await g.step("V6: the cloud mode lists the Comfy Cloud recipes alone, api none of them, each mode its last recipe", g.cloud_mode)
            await g.step("a page with unsaved changes: Reload asks, Stay keeps it ready to save, Leave loads it again", g.unsaved)
            await g.step("a page whose ComfyUI sets up late: saving asks the page again, no reload needed", g.late_app)
        finally:
            await g.close()
            await g.cleanup_recipes()
            await c.eval("(async () => { const s = await window.scumble.settings.get(); await window.scumble.settings.set({ comfyView: { ...(s.comfyView || {}), target: %s } }); return 1; })()" % json.dumps(target0 or "comfy"))
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
