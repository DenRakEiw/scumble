"""The in-app assistant against the scripted mock model (docs/PLAN_ASSISTANT.md §6, the A4 steps).

No ComfyUI and no API key: tools/assistant_mock.py plays every model family on 127.0.0.1, this
drives the running app over CDP with `settings.assistant.base` pointed at the mock and a
`test-` key stored in every provider row. Step 0 runs the plain-Node layer
(tools/assistant_test.js). Then, in the app: the MCP identity check (the assistant's tool list
is the external agents' list minus the exclusion set), `ping` as the assistant, every tool has
a policy row, one scripted turn per model family (all four) and Chat Completions dialect through the mock
(the key row, the path, the reasoning part sent back, the screenshot's place), a blind
OpenRouter id, the three new key rows, a read-only turn, the asks of a paid run and of an
irreversible call, the refused path-less export, the document pin across a tab switch, the
a file drop that must not navigate the window off the app, the chat across a window reload, the
user-activity wait (a held pointer holds the assistant's call and not an external one), the
test-key rule, the relaunch refusal and the agent count.

It refuses an instance connected to ComfyUI and a profile that holds a key in any row it
writes; every key and setting it writes is put back at the end whatever happens, and the
assistant's chat is reset.

    python tools/assistant_test.py [--user-data-dir <dir>] [--exe <exe>] [out_dir]

Start the app first, offline: ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
The identity check and the external call need the profile the app runs on (`--user-data-dir`,
as tools/run_gates.sh passes it); without it they use the default profile.
"""
import asyncio
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402
from assistant_mock import Mock, Turn  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))

args = sys.argv[1:]
EXE = None
if "--exe" in args:
    i = args.index("--exe")
    EXE = os.path.abspath(args[i + 1])
    del args[i:i + 2]
USER_DATA = None
if "--user-data-dir" in args:
    i = args.index("--user-data-dir")
    USER_DATA = os.path.abspath(args[i + 1])
    del args[i:i + 2]
OUT = os.path.abspath(args[0] if args else os.path.join(ROOT, "dist", "smoke"))
os.makedirs(OUT, exist_ok=True)

DEV_EXE = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe" if os.name == "nt" else "electron")
EXE = EXE or DEV_EXE
IS_ELECTRON = "electron" in os.path.basename(EXE).lower()
LAUNCHER = os.path.join(ROOT, "electron", "main", "mcp", "launch.js") if IS_ELECTRON else \
    os.path.join(os.path.dirname(EXE), "resources", "app.asar", "electron", "main", "mcp", "launch.js")

# every key row the assistant reads (electron/main/assistant/providers.js); each gets a test key
ROWS = ["anthropic", "openai", "gemini", "openrouter", "deepseek", "moonshot", "zai", "toapis", "wavespeed", "compat"]
EXCLUDED = ["list_commands", "run_action", "set_status", "ailabel_add", "ailabel_remove", "ailabel_info"]
# one curated model per built family and dialect, with the path its requests keep under the loopback base
FAMILIES = [
    ("anthropic", "claude-sonnet-5", "/v1/messages"),
    ("openai", "gpt-5.6-terra", "/v1/responses"),
    ("gemini", "gemini-3.8-flash", ":streamGenerateContent"),
    ("openrouter", "anthropic/claude-sonnet-5", "/api/v1/chat/completions"),
    ("deepseek", "deepseek-flash", "/chat/completions"),
    ("moonshot", "kimi-k3", "/v1/chat/completions"),
    ("zai", "glm-5.3-flash", "/api/paas/v4/chat/completions"),
    ("toapis", "claude-sonnet-5", "/v1/chat/completions"),
    ("wavespeed", "anthropic/claude-sonnet-5", "/v1/chat/completions"),
    ("compat", "mock-agent", "/v1/chat/completions"),
]


def key_of(row):
    return f"test-gate-{row}-0000"


def last_results(r):
    """The tool results of the last step only: the chat goes on between the gate's steps, so a
    request carries every earlier result too. Walk back from the end to the last assistant message."""
    out = []
    for m in reversed(r["messages"]):
        if m["role"] == "assistant":
            break
        out = list(m.get("tool_results", [])) + out
    return out


PRE = """(async () => {
    if (!window.__as) window.__as = { shell: await import('./shell.js'), host: (await import('./editor/host.js')).host, cmds: await import('./commands.js') };
    const shell = window.__as.shell, host = window.__as.host, cmds = window.__as.cmds;
    const run = (n, a) => cmds.commands.run(n, a || {});
    const A = window.scumble.assistant;
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (f, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await wait(100); } return null; };
    const strip = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
    const DOC = __DOC__;
    __BODY__
})()"""


def js(body, doc=None):
    return PRE.replace("__DOC__", json.dumps(doc)).replace("__BODY__", body)


class Gate:
    def __init__(self, c, mock):
        self.c = c
        self.mock = mock
        self.doc = None
        self.results = []
        self.stored_keys = False
        self.saved_settings = None    # the profile's own assistant / llm / toapis settings
        self.saved_recipe = None      # and its recipe; both in Python: a reload wipes window globals
        self.made_docs = []           # the documents the steps opened, closed in cleanup
        self.saved = None

    async def ev(self, body, timeout=120):
        return await self.c.eval(js(body, self.doc), timeout=timeout)

    def step(self, name, ok, detail=""):
        self.results.append(ok)
        print(f"[{'ok' if ok else 'FAIL'}] {name}{(': ' + str(detail)) if detail else ''}", flush=True)

    async def run_step(self, name, fn):
        before = len(self.mock.failures())
        try:
            detail = await fn()
            fails = self.mock.failures()[before:]
            if fails:
                self.step(name, False, "the mock's expectations failed: " + " | ".join(fails))
            else:
                self.step(name, True, detail)
        except Exception as e:  # noqa: BLE001
            fails = self.mock.failures()[before:]
            self.step(name, False, str(e)[:900] + (("; mock: " + " | ".join(fails)) if fails else ""))

    # ---- the assistant over IPC ------------------------------------------------------------

    async def state(self):
        return await self.ev("return await A.state();")

    async def send(self, text):
        return await self.ev("return await A.send(__T__);".replace("__T__", json.dumps(text)))

    async def wait_done(self, timeout=90, allow_ask=False):
        t0 = time.time()
        while time.time() - t0 < timeout:
            s = await self.state()
            if not s["busy"]:
                return s
            if s["pending"] and not allow_ask:
                raise RuntimeError("an unexpected ask card: " + json.dumps(s["pending"])[:300])
            await asyncio.sleep(0.15)
        raise RuntimeError("the turn did not end in time")

    async def wait_ask(self, timeout=30):
        t0 = time.time()
        while time.time() - t0 < timeout:
            s = await self.state()
            if s["pending"]:
                return s["pending"]
            if not s["busy"]:
                raise RuntimeError("the turn ended without an ask; events: " + json.dumps([e["type"] for e in s["events"]])[:300])
            await asyncio.sleep(0.1)
        raise RuntimeError("no ask card appeared in time")

    async def answer(self, call, allow):
        return await self.ev("return await A.answer(__C__, __A__);".replace("__C__", json.dumps(call)).replace("__A__", json.dumps(allow)))

    async def set_model(self, value):
        await self.ev("""
const cur = (await window.scumble.settings.get()).assistant || {};
await window.scumble.settings.set({ assistant: { ...cur, model: __M__ } });
return 1;""".replace("__M__", json.dumps(value)))
        await self.ev("await A.reset(); return 1;")

    def last_turn_reason(self, s):
        for e in reversed(s["events"]):
            if e["type"] == "turn:done":
                return e["reason"], e.get("detail", "")
        return None, ""

    # ---- setup and cleanup -------------------------------------------------------------------

    async def setup(self):
        rows = json.dumps(ROWS)
        info = await self.ev("""
const st = await window.scumble.comfy.status();
if (["connected", "missing-node"].includes(st.state)) throw new Error("this instance is connected to ComfyUI (" + st.state + "); the assistant gate runs offline only");
const had = (await window.scumble.keys.list()).keys || {};
for (const row of __ROWS__) if (had[row] && had[row].set) throw new Error("this profile holds a key in row " + row + "; the test never overwrites a key");
const s = await window.scumble.settings.get();
const saved = { assistant: s.assistant || null, llm: s.llm || null, toapis: s.toapis || null };
const recipe = host.recipe ? JSON.parse(JSON.stringify(host.recipe)) : null;
for (const row of __ROWS__) await window.scumble.keys.set(row, "test-gate-" + row + "-0000");
const cur = s.assistant || {};
const noticed = {}; for (const row of __ROWS__) noticed[row] = "2026-09-20";
await window.scumble.settings.set({
    assistant: { ...cur, base: __MOCK__, model: "anthropic:claude-sonnet-5", noticed },
    llm: { ...(s.llm || {}), compat: { ...((s.llm || {}).compat || {}), url: __MOCK__, model: "mock-agent" } },
    toapis: { ...(s.toapis || {}), base: __MOCK__ },
});
host.setRecipe({ id: "loopback_fill", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "fill", name: "Loopback", settings: [] });
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 800, height: 600, color: "#708090" });
await run("select_rect", { doc: d.id, x: 100, y: 80, w: 200, h: 120 });
await A.reset();
const state = await A.state();
return { doc: d.id, size: [ed.width, ed.height], provider: state.provider, model: state.model, base: state.base, saved, recipe };
""".replace("__ROWS__", rows).replace("__MOCK__", json.dumps(self.mock.url)))
        self.stored_keys = True
        # kept here and not in a window global: a reload wipes those, and cleanup would restore nothing
        self.saved_settings = info.pop("saved", None)
        self.saved_recipe = info.pop("recipe", None)
        self.doc = info["doc"]
        if info["base"] != self.mock.url or info["provider"] != "anthropic":
            raise RuntimeError("the assistant does not see the setup: " + json.dumps(info))
        return info

    async def back_to_the_app(self):
        """Bring the window back to the app if a step (or a mutation of one) took it off.

        Only the window can put the keys and the settings back, so cleanup needs a page that
        runs the app: without this, a run that ended on an error page leaves its test keys in
        the profile and the next run refuses to start.
        """
        try:
            where = await self.c.eval("location.href")
            if str(where).startswith("scumble://app/"):
                return None
        except Exception:  # noqa: BLE001
            where = "unreadable"
        await self.c.call("Page.navigate", url="scumble://app/index.html")
        for _ in range(40):
            await asyncio.sleep(0.5)
            try:
                if await self.ev("return (await run('ping')).ok !== undefined || true;"):
                    return f"the window was on {where}; it is back on the app"
            except Exception:  # noqa: BLE001
                pass
        raise RuntimeError(f"the window is on {where} and did not come back")

    async def cleanup(self):
        # the keys are this run's own or none: setup refuses a profile that holds a key, and when
        # it refused, nothing here may touch the rows (they are the user's)
        back = await self.back_to_the_app()
        rows = json.dumps(ROWS if self.stored_keys else [])
        docs = json.dumps([d for d in self.made_docs + ([self.doc] if self.doc is not None else []) if d is not None])
        out = await self.ev("""
const out = {};
try { await A.reset(); out.reset = true; } catch (e) { out.reset = strip(e); }
if (__SAVED__) {
    const s = __SAVED__;
    await window.scumble.settings.set({ assistant: s.assistant || undefined, llm: s.llm || undefined, toapis: s.toapis || undefined });
    out.settings = true;
}
if (__RECIPE__) host.setRecipe(__RECIPE__);
for (const row of __ROWS__) await window.scumble.keys.clear(row);
for (const d of document.querySelectorAll("dialog[open]")) d.close();
for (const id of __DOCS__) { try { await run("close_document", { doc: id, force: true }); } catch (_) { /* gone */ } }
const k = (await window.scumble.keys.list()).keys || {};
out.keysLeft = __ROWS__.filter((row) => k[row] && k[row].set);
out.closed = __DOCS__.length;
return out;"""
                           .replace("__ROWS__", rows)
                           .replace("__DOCS__", docs)
                           .replace("__SAVED__", json.dumps(self.saved_settings))
                           .replace("__RECIPE__", json.dumps(self.saved_recipe)))
        if back:
            out["navigated"] = back
        if out.get("keysLeft"):
            raise RuntimeError("test keys are still stored: " + ", ".join(out["keysLeft"]))
        return out

    # ---- the steps ---------------------------------------------------------------------------

    async def identity(self):
        """The assistant's list is the MCP list minus exactly the exclusion set."""
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        extra = [f"--user-data-dir={USER_DATA}"] if USER_DATA else []
        params = StdioServerParameters(command=EXE, args=[LAUNCHER] + extra + ["--mcp"], cwd=ROOT, env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"})
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as s:
                init = await s.initialize()
                tools = (await s.list_tools()).tools
                mode = json.loads("\n".join(c.text for c in (await s.call_tool("ping", {})).content if getattr(c, "type", "") == "text")).get("mcp", {}).get("mode")
        external = sorted([{"name": t.name, "description": t.description, "inputSchema": t.inputSchema} for t in tools], key=lambda t: t["name"])
        ours = await self.ev("""
const t = await A.tools();
return { mcp: t.mcp.map((x) => ({ name: x.name, description: x.description, inputSchema: x.inputSchema })), excluded: t.excluded, sent: t.sent, policy: t.policy };""")
        mine = sorted(ours["mcp"], key=lambda t: t["name"])
        if json.dumps(mine, sort_keys=True) != json.dumps(external, sort_keys=True):
            raise RuntimeError(f"the assistant's MCP list differs from the external one ({len(mine)} against {len(external)})")
        if sorted(ours["excluded"]) != sorted(EXCLUDED):
            raise RuntimeError("the exclusion set is " + json.dumps(ours["excluded"]))
        names = {t["name"] for t in external}
        missing = [n for n in EXCLUDED if n not in names]
        if missing:
            raise RuntimeError("excluded names that are not live tools: " + ", ".join(missing))
        want = sorted([{"name": t["name"], "description": t["description"], "input_schema": t["inputSchema"]} for t in external if t["name"] not in EXCLUDED], key=lambda t: t["name"])
        got = sorted(ours["sent"], key=lambda t: t["name"])
        if json.dumps(got, sort_keys=True) != json.dumps(want, sort_keys=True):
            raise RuntimeError(f"what is sent is not the list minus the exclusion set ({len(got)} against {len(want)})")
        self.policy_names = ours["policy"]
        self.sent_names = [t["name"] for t in got]
        return f"{len(external)} external tools ({init.serverInfo.name} {init.serverInfo.version}, {mode}), {len(got)} sent, {len(EXCLUDED)} excluded"

    async def ping(self):
        base = len(self.mock.raw())
        self.mock.push(
            Turn(answer={"tool_calls": [{"name": "ping", "args": {}}]}),
            Turn(expect=lambda r: (r["path"].endswith("/v1/messages") and r["key"] == key_of("anthropic")) or f"path {r['path']} key {r['key']}", answer={"text": "pong"}),
        )
        await self.send("ping")
        s = await self.wait_done()
        reason, detail = self.last_turn_reason(s)
        if reason != "end":
            raise RuntimeError(f"the turn ended with {reason}: {detail}")
        t = self.mock.transcript()
        second = t[base + 1]
        results = last_results(second)
        if not results or results[0]["is_error"]:
            raise RuntimeError("no ping result in the second request: " + json.dumps(second["messages"])[:400])
        text = results[0]["text"]
        if '"mode": "assistant"' not in text or '"pid"' not in text:
            raise RuntimeError("ping did not report the assistant mode: " + text[:300])
        first = t[base]
        if not first["system"].startswith("Scumble is a desktop image editor") or "You are Scumble's assistant" not in first["system"]:
            raise RuntimeError("the system text is not the instructions plus the rules: " + first["system"][:200])
        return f"mcp.mode assistant; {len(first['tools'])} tools in the request"

    async def policy_rows(self):
        missing = [n for n in self.sent_names if n not in self.policy_names]
        if missing:
            raise RuntimeError("tools without a policy row: " + ", ".join(missing))
        return f"{len(self.sent_names)} tools, {len(self.policy_names)} rows"

    async def families(self):
        notes = []
        for provider, model, path in FAMILIES:
            await self.set_model(f"{provider}:{model}")
            self.mock.reset()
            n1 = 1
            key = key_of(provider)

            def expect_second(r, provider=provider, path=path, key=key, n1=n1):
                if not r["path"].split("?")[0].endswith(path):
                    return f"{provider}: path {r['path']}"
                if r["key"] != key:
                    return f"{provider}: key {r['key']} (want {key})"
                calls = [m for m in r["messages"] if m["role"] == "assistant" and m.get("tool_calls")]
                if not calls:
                    return f"{provider}: no assistant message with tool calls sent back"
                reasoning = calls[-1].get("reasoning") or {}
                if provider == "anthropic":
                    sigs = [b.get("signature") for b in reasoning.get("thinking", [])]
                    if f"sig-{n1}" not in sigs:
                        return f"{provider}: the thinking signature did not come back ({sigs})"
                elif provider == "openrouter":
                    details = reasoning.get("reasoning_details")
                    if not details or details[0].get("text") != f"rd-{n1}":
                        return f"{provider}: reasoning_details not sent back unmodified ({json.dumps(details)[:200]})"
                elif provider == "openai":
                    enc = reasoning.get("encrypted_content") or []
                    if f"enc-{n1}" not in enc:
                        return f"{provider}: the reasoning item did not come back ({enc})"
                elif provider == "gemini":
                    sigs = reasoning.get("thoughtSignature") or []
                    if f"ts-{n1}" not in sigs:
                        return f"{provider}: the thought signature did not come back ({sigs})"
                else:
                    if reasoning.get("reasoning_content") != f"rc-{n1}":
                        return f"{provider}: reasoning_content not sent back ({json.dumps(reasoning)[:200]})"
                results = last_results(r)
                if len(results) != 2 or any(x["is_error"] for x in results):
                    return f"{provider}: results {json.dumps(results)[:300]}"
                if provider in ("anthropic", "openai", "gemini"):
                    if not results[1]["image"]:
                        return f"{provider}: the screenshot is not in the tool result itself"
                elif provider == "moonshot":
                    if not results[1]["image"]:
                        return f"{provider}: the screenshot is not inline in the tool message"
                else:
                    after = r["messages"][-1]
                    if after["role"] != "user" or after.get("images", 0) < 1:
                        return f"{provider}: the screenshot is not in a follow-up user message ({after['role']}, {after.get('images')})"
                    if results[1]["image"]:
                        return f"{provider}: the screenshot went inline where the dialect says it does not"
                return True

            self.mock.push(
                Turn(answer={"tool_calls": [{"name": "select_rect", "args": {"x": 40, "y": 30, "w": 200, "h": 150}}, {"name": "screenshot", "args": {"max_size": 512}}]}),
                Turn(expect=expect_second, answer={"text": f"done on {provider}"}),
            )
            await self.send(f"select and look ({provider})")
            s = await self.wait_done()
            reason, detail = self.last_turn_reason(s)
            if reason != "end":
                raise RuntimeError(f"{provider}: the turn ended with {reason}: {detail}")
            if s["provider"] != provider or s["model"] != model:
                raise RuntimeError(f"{provider}: the chat runs on {s['provider']}:{s['model']}")
            sel = (await self.ev("return (await run('status', { doc: DOC })).selection;"))
            if not sel or sel.get("w") != 200 or sel.get("h") != 150:
                raise RuntimeError(f"{provider}: the selection did not land: {json.dumps(sel)}")
            if provider == "deepseek":
                def expect_third(r):
                    assistants = [m for m in r["messages"] if m["role"] == "assistant"]
                    bad = [i for i, m in enumerate(assistants) if not isinstance((m.get("reasoning") or {}).get("reasoning_content"), str)]
                    return True if assistants and not bad else f"deepseek: assistant messages without reasoning_content: {bad} of {len(assistants)}"
                self.mock.push(Turn(expect=expect_third, answer={"text": "again"}))
                await self.send("and again")
                s = await self.wait_done()
                reason, detail = self.last_turn_reason(s)
                if reason != "end":
                    raise RuntimeError(f"deepseek second turn ended with {reason}: {detail}")
            notes.append(f"{provider}:{len(self.mock.raw())}")
        return ", ".join(notes)

    async def blind(self):
        await self.set_model("openrouter:free/blind-model")
        self.mock.reset()
        self.mock.push(Turn(expect=lambda r: ("screenshot" not in r["tools"] and "cannot see the picture" in r["system"]) or f"tools {len(r['tools'])} screenshot {'screenshot' in r['tools']}", answer={"text": "I cannot look"}))
        await self.send("hi")
        s = await self.wait_done()
        reason, detail = self.last_turn_reason(s)
        if reason != "end":
            raise RuntimeError(f"the turn ended with {reason}: {detail}")
        t = await self.ev("const t = await A.tools(); return { n: t.sent.length, shot: t.sent.some((x) => x.name === 'screenshot'), blind: /cannot see the picture/.test(t.system || ''), vision: (await A.state()).vision };")
        if t["shot"] or t["n"] != len(self.sent_names) - 1 or not t["blind"] or t["vision"]:
            raise RuntimeError("the blind model's list: " + json.dumps(t))
        # the live list is read once per session (a warm instance answers from its cache), so it is
        # asked for through IPC: the free id's row says it takes no images, and an id without tools is absent
        rows = await self.ev("const rows = await A.openrouterModels(); return { blind: rows.find((m) => m.id === 'free/blind-model'), noTools: rows.some((m) => m.id === 'free/no-tools'), n: rows.length };")
        if not rows["blind"] or rows["blind"]["vision"] or rows["noTools"]:
            raise RuntimeError("the live list: " + json.dumps(rows)[:300])
        return f"{t['n']} tools, no screenshot, the blind sentence in the system text; the live list holds {rows['n']} tool-capable ids"

    async def key_rows(self):
        rows = await self.ev("""
const list = await window.scumble.providers.list();
const ids = list.map((p) => p.id);
const at = (id) => ids.indexOf(id);
const row = (id) => list.find((p) => p.id === id);
return { ids, first: ids[0], anthropic: row("anthropic") && row("anthropic").label,
    rows: ["deepseek", "moonshot", "zai"].map((id) => ({ id, at: at(id), label: row(id) && row(id).label, set: !!(row(id) && row(id).key && row(id).key.set), balance: !!(row(id) && row(id).balance) })) };""")
        if rows["first"] != "toapis":
            raise RuntimeError("ToAPIs is no longer first: " + json.dumps(rows["ids"]))
        a = rows["ids"].index("anthropic")
        want = {"deepseek": ("DeepSeek (assistant)", True), "moonshot": ("Moonshot / Kimi (assistant)", True), "zai": ("Z.ai / GLM (assistant)", False)}
        for i, r in enumerate(rows["rows"]):
            if r["at"] != a + 1 + i:
                raise RuntimeError(f"{r['id']} is at {r['at']}, anthropic at {a}: " + json.dumps(rows["ids"]))
            if r["label"] != want[r["id"]][0] or not r["set"] or r["balance"] != want[r["id"]][1]:
                raise RuntimeError("row " + json.dumps(r))
        if "assistant" not in (rows["anthropic"] or ""):
            raise RuntimeError("the Anthropic label does not name the assistant: " + str(rows["anthropic"]))
        return "deepseek, moonshot, zai after anthropic; each set; " + rows["anthropic"]

    async def read_only(self):
        await self.set_model("anthropic:claude-sonnet-5")
        await self.ev("await A.reset({ readOnly: true }); await run('select_rect', { doc: DOC, x: 10, y: 10, w: 50, h: 50 }); return 1;")
        self.mock.reset()

        def expect_second(r):
            results = last_results(r)
            if len(results) != 4:
                return f"{len(results)} results"
            if any(x["is_error"] for x in results[:3]):
                return "a read was refused: " + json.dumps(results[:3])[:300]
            if not results[3]["is_error"] or "not enabled in this run" not in results[3]["text"]:
                return "select_rect was not refused: " + results[3]["text"][:200]
            return True

        self.mock.push(
            Turn(answer={"tool_calls": [{"name": "list_documents", "args": {}}, {"name": "status", "args": {}}, {"name": "screenshot", "args": {"max_size": 256}}, {"name": "select_rect", "args": {"x": 100, "y": 100, "w": 300, "h": 200}}]}),
            Turn(expect=expect_second, answer={"text": "looked only"}),
        )
        await self.send("look, do not touch")
        s = await self.wait_done()
        reason, detail = self.last_turn_reason(s)
        if reason != "end":
            raise RuntimeError(f"the turn ended with {reason}: {detail}")
        if any(e["type"] == "ask" for e in s["events"]):
            raise RuntimeError("an ask appeared in a read-only turn")
        if not s["readOnly"]:
            raise RuntimeError("the state does not say read-only")
        sel = await self.ev("return (await run('status', { doc: DOC })).selection;")
        if not sel or sel.get("w") != 50 or sel.get("h") != 50:
            raise RuntimeError("the document changed: " + json.dumps(sel))
        after = await self.ev("await A.reset(); return (await A.state()).readOnly;")
        if after:
            raise RuntimeError("readOnly stayed on after the reset")
        return "list_documents, status, screenshot ran; select_rect refused; selection unchanged"

    async def paid_run(self):
        self.mock.reset()
        await self.ev("await run('select_rect', { doc: DOC, x: 100, y: 80, w: 200, h: 120 }); return 1;")
        layers0 = await self.ev("return (await run('list_layers', { doc: DOC })).layers.length;")

        def expect_second(r):
            results = last_results(r)
            if len(results) != 1 or not results[0]["is_error"] or "the user declined" not in results[0]["text"]:
                return "the decline did not reach the model: " + json.dumps(results)[:300]
            return True

        def expect_third(r):
            results = last_results(r)
            if len(results) != 1 or results[0]["is_error"] or '"layer"' not in results[0]["text"]:
                return "the run's result did not reach the model: " + json.dumps(results)[:300]
            return True

        self.mock.push(
            Turn(answer={"tool_calls": [{"name": "generate", "args": {}}]}),
            Turn(expect=expect_second, answer={"tool_calls": [{"name": "generate", "args": {}}]}),
            Turn(expect=expect_third, answer={"text": "rendered"}),
        )
        await self.send("render the selection")
        ask = await self.wait_ask()
        if ask["name"] != "generate":
            raise RuntimeError("the first ask is " + ask["name"])
        layers_mid = await self.ev("return (await run('list_layers', { doc: DOC })).layers.length;")
        if layers_mid != layers0:
            raise RuntimeError("a layer appeared before the answer")
        await self.answer(ask["call"], False)
        ask2 = await self.wait_ask()
        if ask2["name"] != "generate" or ask2["call"] == ask["call"]:
            raise RuntimeError("the second ask is " + json.dumps(ask2)[:200])
        await self.answer(ask2["call"], True)
        s = await self.wait_done(allow_ask=True)
        reason, detail = self.last_turn_reason(s)
        if reason != "end":
            raise RuntimeError(f"the turn ended with {reason}: {detail}")
        layers = await self.ev("return (await run('list_layers', { doc: DOC })).layers;")
        if len(layers) != layers0 + 1 or layers[0].get("kind") != "result":
            raise RuntimeError(f"no result layer: {layers0} -> {json.dumps([(l['name'], l.get('kind')) for l in layers])}")
        return f"deny then allow; result layer {layers[0]['name']}"

    async def irreversible(self):
        self.mock.reset()
        self.mock.push(Turn(answer={"tool_calls": [{"name": "new_canvas", "args": {"width": 640, "height": 480}}]}), Turn(answer={"text": "new canvas"}))
        await self.send("start over with 640 x 480")
        ask = await self.wait_ask()
        if ask["name"] != "new_canvas":
            raise RuntimeError("the ask is " + ask["name"])
        size = await self.ev("const ed = ednow(DOC); return [ed.width, ed.height];")
        if size != [800, 600]:
            raise RuntimeError("the canvas changed before the answer: " + json.dumps(size))
        await self.answer(ask["call"], True)
        s = await self.wait_done(allow_ask=True)
        reason, detail = self.last_turn_reason(s)
        size = await self.ev("const ed = ednow(DOC); return [ed.width, ed.height];")
        if reason != "end" or size != [640, 480]:
            raise RuntimeError(f"after allow: {reason} {detail}, size {size}")
        # the size the later steps expect
        await self.ev("await run('new_canvas', { doc: DOC, width: 800, height: 600 }); await run('select_rect', { doc: DOC, x: 100, y: 80, w: 200, h: 120 }); return 1;")
        return "new_canvas waited at its card; unchanged before Allow, 640 x 480 after"

    async def export_no_path(self):
        self.mock.reset()

        def expect_second(r):
            results = last_results(r)
            if len(results) != 1 or not results[0]["is_error"] or "path" not in results[0]["text"]:
                return "the refusal did not reach the model: " + json.dumps(results)[:300]
            return True

        self.mock.push(Turn(answer={"tool_calls": [{"name": "export", "args": {"format": "png"}}]}), Turn(expect=expect_second, answer={"text": "cannot"}))
        await self.send("export it")
        s = await self.wait_done()
        reason, detail = self.last_turn_reason(s)
        if reason != "end":
            raise RuntimeError(f"the turn ended with {reason}: {detail}")
        refused = [e for e in s["events"] if e["type"] == "call" and e.get("action") == "refuse"]
        if not refused or refused[-1]["name"] != "export":
            raise RuntimeError("no refuse event: " + json.dumps([e["type"] for e in s["events"]]))
        opened = await self.ev("return !!document.querySelector('dialog[open]');")
        if opened:
            raise RuntimeError("a dialog is open")
        return "refused before any dialog: " + refused[-1].get("reason", "")

    async def pinned(self):
        self.mock.reset()
        other = await self.ev("""
const d = await run("new_document");
await run("new_canvas", { doc: d.id, width: 400, height: 300 });
await run("set_prompt", { doc: d.id, text: "" });
await run("set_prompt", { doc: DOC, text: "" });
host.shell.activate(ednow(DOC));
return d.id;""")
        self.made_docs.append(other)
        self.mock.push(
            Turn(answer={"tool_calls": [{"name": "set_prompt", "args": {"text": "first"}}]}),
            Turn(delay_ms=1500, answer={"tool_calls": [{"name": "set_prompt", "args": {"text": "second"}}]}),
            Turn(answer={"text": "set twice"}),
        )
        await self.send("set the prompt twice")
        await asyncio.sleep(0.6)
        await self.ev("host.shell.activate(ednow(__O__)); return 1;".replace("__O__", json.dumps(other)))
        s = await self.wait_done()
        reason, detail = self.last_turn_reason(s)
        prompts = await self.ev("return { a: ednow(DOC).promptText, b: ednow(__O__).promptText, active: host.editor.node.id };".replace("__O__", json.dumps(other)))
        await self.ev("host.shell.activate(ednow(DOC)); return 1;")
        if reason != "end" or prompts["a"] != "second" or prompts["b"] != "":
            raise RuntimeError(f"{reason} {detail}; prompts {json.dumps(prompts)}")
        return f"both calls landed in #{self.doc} while #{other} was in front"

    async def wait_reads(self):
        """The wait judges the call's own document, and it holds while the user types.

        `waitForUser` is called here directly (the module the shell's handler uses): a `doc` that
        is not open must answer at once - waiting on the active document instead would hold, and
        refuse, a call that was never meant for it - and `upsample_prompt`, which overwrites the
        prompt field it reads, must wait while the user is typing in it, as `set_prompt` does.
        """
        out = await self.ev("""
const w = await import("./assistant_wait.js");
const ed = ednow(DOC);
host.shell.activate(ed);
const open_ids = (await run("list_documents")).documents.map((d) => d.id);
const closed = Math.max(...open_ids) + 1000;
const byId = w.editorOf(DOC) === ed;
const gone = w.editorOf(closed);
const active = w.editorOf(undefined) === host.editor;
// the prompt field is in the Generate tab: a hidden element cannot take the focus, and the
// typing rule reads document.activeElement
const wasPane = Object.entries(ed.panes).find(([, p]) => !p.hidden);
ed.showPane("gen");
const field = ed.promptInput;
const had = field.value;
field.focus();
const focused = document.activeElement === field;
field.value = "the user is typing";
field.dispatchEvent(new Event("input", { bubbles: true }));
const race = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r("waiting"), ms))]);
const typing = await race(w.waitForUser(DOC, "upsample_prompt", true, null), 400);
const prompting = await race(w.waitForUser(DOC, "set_prompt", true, null), 400);
const reading = await race(w.waitForUser(DOC, "list_layers", true, null), 400);
const forClosed = await race(w.waitForUser(closed, "set_prompt", true, null), 400);
field.value = had;
field.dispatchEvent(new Event("input", { bubbles: true }));
field.blur();
ed.showPane(wasPane ? wasPane[0] : "image");
return { byId, gone, active, focused, typing, prompting, reading, forClosed };""")
        if not out["focused"]:
            raise RuntimeError("the prompt field did not take the focus: " + json.dumps(out))
        if not out["byId"] or out["gone"] is not None or not out["active"]:
            raise RuntimeError("editorOf: " + json.dumps(out))
        if out["typing"] != "waiting" or out["prompting"] != "waiting":
            raise RuntimeError("the wait did not hold while the user typed: " + json.dumps(out))
        if out["reading"] is not None or out["forClosed"] is not None:
            raise RuntimeError("a read or a call for a closed document was held: " + json.dumps(out))
        return "a closed doc answers at once, upsample_prompt and set_prompt wait while the user types"

    async def file_drop(self):
        """A file dropped on the shell must not navigate the window away from the app.

        An unhandled drop navigates the frame to the file: the editor would be gone and every
        call in flight would reject. main.js prevents it (will-navigate), and the Bridge must
        not drop its readiness for that cancelled navigation, which Chromium announces first.
        The probe is an https URL on a dead local port, not a file: one - a page on a custom
        scheme is not allowed to navigate itself to file:, so that navigation never starts and
        would prove nothing. Nothing leaves the machine: port 9 refuses at once, and the
        navigation is prevented before any request. The turn afterwards only answers while the
        Bridge is ready (a dropped `ready` holds the first read for 120 s).
        """
        self.mock.reset()
        before = await self.ev("return location.href;")
        await self.ev("location.href = 'https://127.0.0.1:9/'; return 1;")
        await asyncio.sleep(1.5)
        after = await self.ev("return location.href;")
        if after != before:
            raise RuntimeError(f"the window navigated away: {before} -> {after}")
        self.mock.push(Turn(answer={"text": "still here"}))
        await self.send("are you still there?")
        s = await self.wait_done(timeout=30)
        reason, detail = self.last_turn_reason(s)
        if reason != "end":
            raise RuntimeError(f"the turn after the drop ended with {reason}: {detail}")
        return f"the window stayed on {after} and the bridge still answers"

    async def reload(self):
        self.mock.reset()
        before = await self.state()
        n = len(before["events"])
        if n == 0:
            raise RuntimeError("no events before the reload")
        await self.c.call("Page.reload")
        await asyncio.sleep(1.0)
        s = None
        t0 = time.time()
        while time.time() - t0 < 60:
            try:
                s = await self.state()
                docs = await self.ev("return (await run('list_documents')).documents.map((d) => d.id);")
                if self.doc in docs:
                    break
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(0.5)
        if s is None or len(s["events"]) != n:
            raise RuntimeError(f"after the reload the state holds {s and len(s['events'])} events, before {n}")
        await self.ev("host.shell.activate(ednow(DOC)); return 1;")
        self.mock.push(Turn(expect=lambda r: (len([m for m in r["messages"] if m["role"] == "user"]) >= 2) or "the history did not survive", answer={"text": "still here"}))
        await self.send("still there?")
        s = await self.wait_done()
        reason, detail = self.last_turn_reason(s)
        if reason != "end":
            raise RuntimeError(f"the turn after the reload ended with {reason}: {detail}")
        return f"{n} events kept across the reload; the next turn ran on the same chat"

    async def stroke_wait(self):
        self.mock.reset()
        await self.ev("await run('select_rect', { doc: DOC, x: 10, y: 10, w: 60, h: 60 }); return 1;")
        held = await self.ev("""
const ed = ednow(DOC);
host.shell.activate(ed);
await wait(100);
const rect = ed.canvas.getBoundingClientRect();
const client = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 21, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
window.__asEv = ev;
ed.canvas.dispatchEvent(ev("pointerdown", 300, 300));
ed.canvas.dispatchEvent(ev("pointermove", 320, 310));
await wait(50);
return { held: ed.gestureHeld(), kind: ed.pointer && ed.pointer.kind };""")
        if not held["held"]:
            raise RuntimeError("the synthetic pointer did not hold a gesture: " + json.dumps(held))
        try:
            self.mock.push(Turn(answer={"tool_calls": [{"name": "select_rect", "args": {"x": 50, "y": 50, "w": 100, "h": 100}}]}), Turn(answer={"text": "selected"}))
            await self.send("select something")
            await asyncio.sleep(1.2)
            mid = await self.state()
            if not mid["busy"] or len(self.mock.raw()) != 1:
                raise RuntimeError(f"the call was not held: busy {mid['busy']}, {len(self.mock.raw())} requests")
            sel = await self.ev("return (await run('status', { doc: DOC })).selection;")
            if not sel or sel.get("w") != 60:
                raise RuntimeError("the selection changed while the pointer was held: " + json.dumps(sel))
            # an external call is not held: --cmd through the launcher, against the same instance
            extra = [f"--user-data-dir={USER_DATA}"] if USER_DATA else []
            t0 = time.time()
            p = subprocess.run([EXE, LAUNCHER] + extra + ["--cmd", "select_rect", json.dumps({"x": 0, "y": 0, "w": 20, "h": 20, "doc": self.doc})],
                               cwd=ROOT, env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"}, capture_output=True, timeout=90, stdin=subprocess.DEVNULL)
            ext_seconds = time.time() - t0
            if p.returncode != 0 or b'"w": 20' not in p.stdout:
                raise RuntimeError(f"the external call failed or was held ({ext_seconds:.1f} s): {p.stdout[:200]!r} {p.stderr[-300:]!r}")
            still = await self.state()
            if not still["busy"] or len(self.mock.raw()) != 1:
                raise RuntimeError("the assistant's call ran while the pointer was still held")
        finally:
            await self.ev("const ed = ednow(DOC); ed.canvas.dispatchEvent(window.__asEv('pointerup', 320, 310)); return 1;")
        s = await self.wait_done(timeout=30)
        reason, detail = self.last_turn_reason(s)
        sel = await self.ev("return (await run('status', { doc: DOC })).selection;")
        if reason != "end" or not sel or sel.get("w") != 100 or sel.get("h") != 100:
            raise RuntimeError(f"after the release: {reason} {detail}, selection {json.dumps(sel)}")
        return f"held while the pointer was down (external --cmd answered in {ext_seconds:.1f} s), ran after the release"

    async def real_key(self):
        self.mock.reset()
        out = await self.ev("""
await window.scumble.keys.set("anthropic", "sk-ant-not-a-test-0000");
let err = "";
try { await A.send("hello"); } catch (e) { err = strip(e); }
await window.scumble.keys.set("anthropic", "test-gate-anthropic-0000");
return { err, busy: (await A.state()).busy };""")
        if "test keys only" not in out["err"] or out["busy"]:
            raise RuntimeError("send was not refused: " + json.dumps(out))
        if self.mock.raw():
            raise RuntimeError("the mock saw a request")
        return out["err"]

    async def relaunch(self):
        self.mock.reset()
        self.mock.push(Turn(delay_ms=3000, answer={"text": "slow"}))
        await self.send("take your time")
        await asyncio.sleep(0.4)
        err = await self.ev("try { await window.scumble.relaunch(); return 'relaunched'; } catch (e) { return strip(e); }")
        s = await self.wait_done()
        if "The assistant is working" not in err:
            raise RuntimeError("relaunch answered: " + err)
        reason, detail = self.last_turn_reason(s)
        if reason != "end":
            raise RuntimeError(f"the slow turn ended with {reason}: {detail}")
        return err

    async def not_an_agent(self):
        self.mock.reset()
        self.mock.push(Turn(delay_ms=1500, answer={"text": "counting"}))
        await self.send("are you an agent?")
        await asyncio.sleep(0.4)
        mid = await self.state()
        s = await self.wait_done()
        if not mid["busy"] or mid["agents"] != 0:
            raise RuntimeError(f"during the turn: busy {mid['busy']}, agents {mid['agents']}")
        return f"agents {mid['agents']} while busy; reason {self.last_turn_reason(s)[0]}"


def node_step():
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "assistant_test.js")], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=600)
    tail = (r.stdout + r.stderr).strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        raise Exception("tools/assistant_test.js: " + tail[-1500:])
    return f"{tail.count('[ok]')} checks"


async def main():
    t0 = time.time()
    results = []
    try:
        results.append(True)
        print("[ok] node_layer:", node_step(), flush=True)
    except Exception as e:  # noqa: BLE001
        results[-1] = False
        print("[FAIL] node_layer:", str(e)[:1500], flush=True)

    mock = Mock().start()
    print("mock model server on", mock.url, flush=True)

    async def run(c):
        g = Gate(c, mock)
        try:
            info = await g.setup()
            print("[ok] setup:", json.dumps(info), flush=True)
            await g.run_step("the_assistant_sees_the_mcp_list_minus_the_exclusion_set", g.identity)
            await g.run_step("the_assistant_pings_as_the_assistant", g.ping)
            await g.run_step("every_tool_has_a_policy_row", g.policy_rows)
            await g.run_step("every_family_runs_a_turn_in_the_app", g.families)
            await g.run_step("a_model_without_vision_gets_no_screenshot_tool", g.blind)
            await g.run_step("the_three_key_rows_are_in_settings", g.key_rows)
            await g.run_step("a_read_only_turn_needs_no_answer", g.read_only)
            await g.run_step("a_paid_run_waits_for_the_user", g.paid_run)
            await g.run_step("an_irreversible_call_asks_first", g.irreversible)
            await g.run_step("export_without_a_path_is_refused", g.export_no_path)
            await g.run_step("the_doc_is_pinned_while_the_user_switches_tabs", g.pinned)
            await g.run_step("a_file_drop_leaves_the_window_on_the_app", g.file_drop)
            await g.run_step("the_chat_survives_a_window_reload", g.reload)
            await g.run_step("the_agent_waits_for_the_users_stroke", g.stroke_wait)
            await g.run_step("the_wait_judges_the_calls_own_document", g.wait_reads)
            await g.run_step("a_real_key_never_goes_to_the_test_base", g.real_key)
            await g.run_step("relaunch_is_refused_while_a_turn_runs", g.relaunch)
            await g.run_step("the_assistant_is_not_counted_as_an_agent", g.not_an_agent)
        except Exception as e:  # noqa: BLE001
            g.results.append(False)
            print("[FAIL] setup:", str(e)[:1500], flush=True)
        finally:
            try:
                out = await g.cleanup()
                print("[ok] cleanup:", json.dumps(out), flush=True)
            except Exception as e:  # noqa: BLE001
                g.results.append(False)
                print("[FAIL] cleanup:", str(e)[:800], flush=True)
        return g.results

    try:
        results += await session(run)
    finally:
        mock.stop()
    ok = all(results)
    print(f"{'PASS' if ok else 'FAIL'}: {sum(1 for r in results if r)} of {len(results)} steps in {time.time() - t0:.0f} s", flush=True)
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(main()) else 1)
