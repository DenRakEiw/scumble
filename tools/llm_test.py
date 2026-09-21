"""The OpenAI-compatible upsample endpoint against a mock server (see tools/cdp.py).

No ComfyUI, no API key and no local model needed: tools/llm_mock.py plays the server, this
drives the running app over CDP. The first step is tools/models_test.js in plain Node (the rules
the stored rows of Settings > Language models are held to). Then it points settings.llm.compat at the mock, checks the
backend shows up in the editor's upsample list, upsamples once with a model that sees the
crop and once with a text-only model (the adapter must retry without the image and say so),
then the ToAPIs rows (the same client on the ToAPIs image key, at the host settings.toapis.base
allows: the mock on 127.0.0.1), then a model the user added by hand under Settings > Language
models (the dialog writes it, the editor lists it, the request goes to that provider on its key),
and finally with the server stopped, where the error has to name
the URL. The settings are put back at the end whatever happens, and the test key is cleared; a
profile that already holds a ToAPIs key is refused rather than overwritten.

    python tools/llm_test.py [out_dir]

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import subprocess
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


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def node_test():
    """tools/models_test.js: the rules the stored model rows are held to, without the app."""
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "models_test.js")], cwd=ROOT,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    tail = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0:
        raise Exception("tools/models_test.js: " + tail[-1500:])
    print("[ok] models_test.js:", tail.strip().splitlines()[-1])


async def run(c):
    mock = Mock().start()
    print("mock server on", mock.url)
    ok = True
    try:
        node_test()
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

        # 4. ToAPIs: three rows first in the list once its key is stored, the request on that key
        res = await c.eval(js("""
    const had = await window.scumble.keys.list();
    if ((had.keys || {}).toapis && had.keys.toapis.set) throw new Error("this profile holds a ToAPIs key; the test never overwrites a key");
    window.__llmToapisBase = (await window.scumble.settings.get()).toapis;
    await window.scumble.settings.set({ toapis: { base: %s } });
    let before = (await host.refreshLLMs(), host.upsampleBackends().map((b) => b.id));
    if (before.some((id) => id.startsWith("app:toapis:"))) throw new Error("ToAPIs rows without a key: " + before.join(", "));
    await window.scumble.keys.set("toapis", "sk-llmtest-toapis-000000");
    window.__llmToapisKey = true;
    await host.refreshLLMs();
    const ids = host.upsampleBackends().map((b) => b.id);
    const want = ["app:toapis:gemini-3.8-flash", "app:toapis:claude-haiku-4-5", "app:toapis:gpt-5.6-terra"];
    if (JSON.stringify(ids.slice(0, 3)) !== JSON.stringify(want)) throw new Error("the ToAPIs rows are not first: " + ids.join(", "));
    // the whole list, keyless rows included: a profile with only the ToAPIs key cannot show the order otherwise
    const all = (await window.scumble.llm.list()).map((l) => "app:" + l.id);
    if (JSON.stringify(all.slice(0, 3)) !== JSON.stringify(want)) throw new Error("the ToAPIs rows are not first in llm.list(): " + all.join(", "));
    await c("set_prompt", { text: %s });
    ed.refreshSegmentBackends();
    ed.upBackendSel.value = want[0];
    if (ed.upBackendSel.value !== want[0]) throw new Error("the editor's select has no ToAPIs row: " + Array.from(ed.upBackendSel.options).map((o) => o.value).join(", "));
    const r = await c("upsample_prompt");
    await window.scumble.keys.clear("toapis");
    window.__llmToapisKey = false;
    await host.refreshLLMs();
    const after = host.upsampleBackends().map((b) => b.id);
    ed.refreshSegmentBackends();
    ed.upBackendSel.value = "app:compat:mock-text";   // what the offline step below asks, as before this step
    return { first: ids.slice(0, 3), prompt: r.prompt || ed.promptText, goneAfterClear: !after.some((id) => id.startsWith("app:toapis:")) };
""" % (json.dumps(mock.url), json.dumps(PROMPT))))
        print("[ok] toapis:", json.dumps(res)[:300])
        if "UPSAMPLED" not in res["prompt"] or "image: yes" not in res["prompt"]:
            raise RuntimeError("the ToAPIs row did not reach the endpoint with the crop: " + res["prompt"])
        if not res["goneAfterClear"]:
            raise RuntimeError("the ToAPIs rows stay after the key was cleared")
        posts, auths = mock.posts(), mock.post_auths()
        if len(posts) != 4 or posts[3].get("model") != "gemini-3.8-flash":
            raise RuntimeError("the ToAPIs request is not the fourth, or not on its model: %s" % [p.get("model") for p in posts])
        if auths[3] != "Bearer sk-llmtest-toapis-000000":
            raise RuntimeError("the ToAPIs request did not carry the ToAPIs key: %r" % auths[3])
        if auths[1] and "toapis" in auths[1]:
            raise RuntimeError("the compat endpoint got the ToAPIs key")

        # 5. a model the user added by hand: the dialog writes it, both pickers take it, the
        # request goes to that provider on its own key
        res = await c.eval(js("""
    const shell = await import("./shell.js");
    await shell.openSettings();
    await window.scumble.keys.set("toapis", "sk-llmtest-toapis-000000");
    window.__llmToapisKey = true;
    const el = (id) => document.getElementById(id);
    el("set-lm-provider").value = "toapis";
    el("set-lm-model").value = "mock-vision";
    el("set-lm-label").value = "My own row";
    el("set-lm-upsample").checked = true;
    el("set-lm-assistant").checked = true;
    el("set-lm-vision").checked = true;
    el("set-lm-add").click();
    for (let i = 0; i < 40 && !((await window.scumble.settings.get()).llm.models || []).length; i++) await new Promise((r) => setTimeout(r, 100));
    const stored = (await window.scumble.settings.get()).llm.models;
    const listed = (await window.scumble.llm.list()).find((l) => l.id === "toapis:mock-vision");
    const group = (await window.scumble.assistant.models()).groups.find((g) => g.provider === "toapis");
    const inPicker = group.models.find((m) => m.value === "toapis:mock-vision");
    // the picker warns about a model, never about itself
    const warns = group.models.some((m) => /not tried/i.test(m.label || "")) || ("tried" in group);
    await c("set_prompt", { text: %s });
    ed.refreshSegmentBackends();
    ed.upBackendSel.value = "app:toapis:mock-vision";
    if (ed.upBackendSel.value !== "app:toapis:mock-vision") throw new Error("the editor has no row for it: " + Array.from(ed.upBackendSel.options).map((o) => o.value).join(", "));
    const r = await c("upsample_prompt");
    // Remove takes it out of both lists again
    document.querySelectorAll("#set-lm-list .shell-lm-row button").forEach((b) => b.click());
    for (let i = 0; i < 40 && ((await window.scumble.settings.get()).llm.models || []).length; i++) await new Promise((r2) => setTimeout(r2, 100));
    await host.refreshLLMs();
    const gone = !(await window.scumble.llm.list()).some((l) => l.id === "toapis:mock-vision")
        && !(await window.scumble.assistant.models()).groups.find((g) => g.provider === "toapis").models.some((m) => m.value === "toapis:mock-vision");
    await window.scumble.keys.clear("toapis");
    window.__llmToapisKey = false;
    await host.refreshLLMs();
    if (document.getElementById("shell-settings").open) document.getElementById("shell-settings").close();
    ed.refreshSegmentBackends();
    ed.upBackendSel.value = "app:compat:mock-text";   // what the offline step below asks
    return { stored, label: listed && listed.label, key: listed && listed.key, inPicker, warns, prompt: r.prompt || ed.promptText, gone };
""" % json.dumps(PROMPT)))
        print("[ok] own row:", json.dumps(res)[:400])
        if not res["stored"] or res["stored"][0]["model"] != "mock-vision" or res["stored"][0]["provider"] != "toapis":
            raise RuntimeError("the dialog did not store the row: %s" % res["stored"])
        if res["label"] != "My own row (ToAPIs)" or res["key"] is not True:
            raise RuntimeError("the upsample list row is wrong: %s" % json.dumps(res))
        if not res["inPicker"] or res["inPicker"].get("custom") is not True or res["inPicker"].get("label") != "My own row":
            raise RuntimeError("the assistant picker does not carry the row: %s" % json.dumps(res["inPicker"]))
        if res["warns"]:
            raise RuntimeError("the picker still warns about itself")
        if "UPSAMPLED" not in res["prompt"] or "image: yes" not in res["prompt"]:
            raise RuntimeError("the row did not reach the endpoint with the crop: " + res["prompt"])
        if not res["gone"]:
            raise RuntimeError("Remove left the row in a list")
        posts, auths = mock.posts(), mock.post_auths()
        if len(posts) != 5 or posts[4].get("model") != "mock-vision":
            raise RuntimeError("the row request is not the fifth, or not on its model: %s" % [p.get("model") for p in posts])
        if auths[4] != "Bearer sk-llmtest-toapis-000000":
            raise RuntimeError("the row request did not carry the provider key: %r" % auths[4])

        # 5b. the "upscale" use case: the built-in instruction describes what is there, asks for fine detail
        #     and forbids changes; the select offers it and the status names it
        before = len(mock.posts())
        res = await c.eval(js("""
    await c("set_prompt", { text: "keep it photographic" });
    const offered = Array.from(ed.upCaseSel.options).map((o) => o.value);
    ed.upCaseSel.value = "upscale";
    ed.upCaseSel.dispatchEvent(new Event("change"));
    const r = await c("upsample_prompt");
    const status = ed.status;
    ed.upCaseSel.value = "auto";
    ed.upCaseSel.dispatchEvent(new Event("change"));
    return { offered, prompt: r.prompt || ed.promptText, status, useCase: ed.upsampleSettings.useCase };
"""))
        print("[ok] upscale case:", json.dumps(res)[:300])
        if "upscale" not in res["offered"]:
            raise RuntimeError("the use case select does not offer upscale: %s" % res["offered"])
        if '"upscale"' not in res["status"]:
            raise RuntimeError("the status does not name the upscale case: " + res["status"])
        if res["useCase"] != "auto":
            raise RuntimeError("the use case was not put back to auto")
        from llm_mock import instruction_of
        new = mock.posts()[before:]
        if not new:
            raise RuntimeError("the upscale upsampling sent no request")
        text = instruction_of(new[-1])
        for want in ("will be upscaled and refined", "fine detail", "Do not add, remove or change any object", "keep it photographic"):
            if want not in text:
                raise RuntimeError("the upscale instruction lacks %r: %s" % (want, text[:400]))

        # 6. the server is gone: the error names the URL
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
    await window.scumble.settings.set({ llm: window.__llmSaved || { compat: { url: "", model: "" }, models: [] } });
    if (window.__llmToapisKey) { await window.scumble.keys.clear("toapis"); window.__llmToapisKey = false; }
    if ("__llmToapisBase" in window) { await window.scumble.settings.set({ toapis: window.__llmToapisBase }); delete window.__llmToapisBase; }
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
