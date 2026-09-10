"""The OpenAI-compatible upsample endpoint against a mock server (see tools/cdp.py).

No ComfyUI, no API key and no local model needed: tools/llm_mock.py plays the server, this
drives the running app over CDP. It points settings.llm.compat at the mock, checks the
backend shows up in the editor's upsample list, upsamples once with a model that sees the
crop and once with a text-only model (the adapter must retry without the image and say so),
and finally with the server stopped, where the error has to name the URL. The settings are
put back at the end whatever happens.

    python tools/llm_test.py [out_dir]

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402
from llm_mock import Mock  # noqa: E402

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "dist", "smoke"))
os.makedirs(OUT, exist_ok=True)

PROMPT = "a red car in the rain"


def js(body):
    """`c` is commands.run, `host` the editor host, `ed` the test document's editor."""
    return """(async () => {
    const raw = window.__llm.commands, host = window.__llm.host;
    const c = (n, a) => raw.commands.run(n, { ...(a || {}), ...(window.__llmDoc ? { doc: window.__llmDoc } : {}) });
    const ed = host.editors().find((e) => e.node.id === window.__llmDoc) || host.editor;
    %s
})()""" % body


async def run(c):
    mock = Mock().start()
    print("mock server on", mock.url)
    ok = True
    try:
        await c.eval("""(async () => {
    window.__llm = { commands: await import('./commands.js'), host: (await import('./editor/host.js')).host };
    window.__llmSaved = (await window.scumble.settings.get()).llm || null;
    return 1;
})()""")

        # 1. the endpoint becomes a backend in the editor's upsample list
        res = await c.eval(js("""
    await window.scumble.settings.set({ llm: { compat: { url: %s, model: "mock-vision" } } });
    const llms = await host.refreshLLMs();
    const backends = host.upsampleBackends().map((b) => b.id);
    if (!backends.includes("app:compat:mock-vision")) throw new Error("not listed: " + backends.join(", "));
    const row = llms.find((l) => l.id === "compat:mock-vision");
    return { backends: backends.length, label: row && row.label };
""" % json.dumps(mock.url)))
        print("[ok] listed:", json.dumps(res))

        # 2. a model that sees the crop
        res = await c.eval(js("""
    const d = await raw.commands.run("new_document");
    window.__llmDoc = d.id;
    await raw.commands.run("new_canvas", { width: 512, height: 384, doc: d.id });
    await raw.commands.run("set_prompt", { text: %s, doc: d.id });
    const e = host.editors().find((x) => x.node.id === d.id) || host.editor;
    e.refreshSegmentBackends();
    e.upBackendSel.value = "app:compat:mock-vision";
    if (e.upBackendSel.value !== "app:compat:mock-vision") throw new Error("the select has no such option: " + Array.from(e.upBackendSel.options).map((o) => o.value).join(", "));
    const r = await raw.commands.run("upsample_prompt", { doc: d.id });
    return { prompt: r.prompt || e.promptText, status: e.status };
""" % json.dumps(PROMPT)))
        print("[ok] vision:", json.dumps(res)[:300])
        if "UPSAMPLED" not in res["prompt"] or "image: yes" not in res["prompt"]:
            raise RuntimeError("the vision model did not see the crop: " + res["prompt"])
        posts = mock.posts()
        if len(posts) != 1:
            raise RuntimeError(f"expected one request, the mock saw {len(posts)}")

        # 3. a text-only model: one 400, then a retry without the image
        res = await c.eval(js("""
    await window.scumble.settings.set({ llm: { compat: { url: %s, model: "mock-text" } } });
    await host.refreshLLMs();
    await c("set_prompt", { text: %s });
    ed.refreshSegmentBackends();
    ed.upBackendSel.value = "app:compat:mock-text";
    if (ed.upBackendSel.value !== "app:compat:mock-text") throw new Error("mock-text is not in the select");
    const r = await c("upsample_prompt");
    return { prompt: r.prompt || ed.promptText, status: ed.status };
""" % (json.dumps(mock.url), json.dumps(PROMPT))))
        print("[ok] text only:", json.dumps(res)[:300])
        if "image: no" not in res["prompt"]:
            raise RuntimeError("the retry still carried the image: " + res["prompt"])
        if "text only" not in res["status"]:
            raise RuntimeError("the status does not say the model was text only: " + res["status"])
        posts = mock.posts()
        if len(posts) != 3:
            raise RuntimeError(f"expected three requests in total, the mock saw {len(posts)}")
        from llm_mock import has_image
        if not has_image(posts[1]) or has_image(posts[2]):
            raise RuntimeError("the retry pattern is wrong: image in request 2 = %s, in request 3 = %s" % (has_image(posts[1]), has_image(posts[2])))

        # 4. the server is gone: the error names the URL
        mock.stop()
        mock = None
        res = await c.eval(js("""
    await c("set_prompt", { text: %s });
    try {
        await c("upsample_prompt");
    } catch (err) {
        return { error: String(err.message || err) };
    }
    throw new Error("upsampling succeeded although the server is stopped");
""" % json.dumps(PROMPT)))
        print("[ok] offline:", json.dumps(res)[:300])
        if "127.0.0.1" not in res["error"]:
            raise RuntimeError("the error does not name the URL: " + res["error"])
    except Exception as err:  # noqa: BLE001
        ok = False
        print("[FAIL]", err)
    finally:
        if mock:
            mock.stop()
        try:
            await c.eval("""(async () => {
    const host = window.__llm.host, raw = window.__llm.commands;
    await window.scumble.settings.set({ llm: window.__llmSaved || { compat: { url: "", model: "" } } });
    await host.refreshLLMs();
    if (window.__llmDoc) { try { await raw.commands.run("close_document", { doc: window.__llmDoc }); } catch (_) { /* already gone */ } }
    window.__llmDoc = null;
    return (await window.scumble.settings.get()).llm;
})()""")
            print("[ok] settings restored")
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] restoring the settings:", err)

    for level, text in (await c.logs())[-20:]:
        if level == "error":
            print("  console error:", text[:300])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run)) else 1)
