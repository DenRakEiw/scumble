"""LoRAs on the user's ComfyUI (item 50, docs/PLAN_LORAS.md LR1): plain Node first, then the queue path in the app.

No ComfyUI, no API key, nothing reaches a server. The first step runs tools/loras_test.js (renderer/editor/loras.js
over every shipped recipe: the model source, the chain, the rows, the declarations, missingLoras, the helpers). The
rest drives the running app (run --offline) with the server stood in for, as generate_test.py's Klein steps do: the
page's `fetch` answers POST /prompt (so api.queuePrompt builds the real body, extra_pnginfo included) and
/object_info/LoraLoaderModelOnly (the list read again), `host.objectInfo` holds a LoRA combo whose names carry
backslashes, `host.ensureOnServer` and `host.missingFilesRefusal` are stubbed, and `host.loras` holds the rows (the
store's shape; the LoRAs section that edits them is LR2):

- flux3_klein_local with three rows (one switched off, one named with "/" where the server says "\\"): the queued
  body holds the chain in order with the strengths, every reader of the model loader's MODEL (guider and sched)
  re-pointed to the chain's end, the switched-off row nowhere, the separator name in the server's spelling, the
  recipe's own graph untouched; extra_pnginfo.workflow.loras the run's; the result's via text "+ 2 LoRAs: ...", the
  status note, the log line, editor.lastLoras;
- a row at a file the list lacks: refused with the sentence after one re-read, before ensureOnServer, nothing queued
  (two such rows: the plural); the re-read listing it (a file copied in since the connect): queued;
- the node list unread (objectInfo null) and the re-read failing: nothing refused, the names sent as typed; the
  re-read answering: the server's spelling, and the node list stays unread (no partial list);
- six switched-on rows refused before anything is uploaded (a limit, so "warn"), five sent in order;
- a recipe that declares `loras: false`: no chain, no refusal, the note says why the rows stayed out;
- the result of the first run lands (the node's `executed` answer dispatched): its history entry's via line names
  the LoRAs and the seconds, and the history row shows it.

Every stub, the recipe and the rows are put back whatever happens.

    python tools/loras_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
"""
import asyncio
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def node_step():
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "loras_test.js")], cwd=ROOT,
                       capture_output=True, text=True, encoding="utf-8", timeout=180)
    # stdout alone: stderr carries Node's note that it read renderer/editor/loras.js as an ES module
    tail = r.stdout.strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        raise Exception("tools/loras_test.js: " + (tail + r.stderr)[-1500:])
    return {"checks": tail.count("[ok]"), "tail": (tail.splitlines()[-2:-1] or [""])[0]}


# the stand-ins every app step shares: S.install() puts them in, S.restore() takes them out again
STUBS = r"""
const api = (await import('./editor/host.js')).api;
const klein3 = host.shell.recipes().find((r) => r.id === "flux3_klein_local");
if (!klein3) throw new Error("flux3_klein_local is not listed");
const NAMES = ["Flux_3\\Flux3_Targa.safetensors", "klein\\nyc_style.safetensors", "qwen\\NYC_Qwen.safetensors", "root_style.safetensors"];
const LORA = (names) => ({ input: { required: { model: ["MODEL"], lora_name: [names, {}], strength_model: ["FLOAT", { default: 1, min: -100, max: 100, step: 0.01 }] } }, output: ["MODEL"], output_node: false });
const OI = (names = NAMES) => ({ ...Object.fromEntries(klein3.needs.map((n) => [n, { input: { required: {} } }])), LoraLoaderModelOnly: LORA(names) });
/** the inputs of a graph that read [id, slot], as "node.input", sorted */
const readers = (g, id, slot) => {
    const out = [];
    for (const [n, node] of Object.entries(g)) for (const [k, v] of Object.entries((node && node.inputs) || {})) if (Array.isArray(v) && String(v[0]) === String(id) && v[1] === slot) out.push(n + "." + k);
    return out.sort();
};
const S = window.__lrS || (window.__lrS = {
    posts: [], rereads: 0, reread: "list", rereadNames: NAMES, ensured: 0, n: 0,
    install() {
        if (this.saved) return;
        this.saved = { connected: host.connected, objectInfo: host.objectInfo, ensure: host.ensureOnServer, missing: host.missingFilesRefusal, recipe: host.recipe, loras: host.loras, fetch: window.fetch };
        const self = this, orig = this.saved.fetch;
        host.connected = true;
        host.objectInfo = OI();
        host.missingFilesRefusal = () => null;
        host.ensureOnServer = async () => { self.ensured++; return null; };
        window.fetch = async (url, init) => {
            const u = String(url);
            if (/\/prompt$/.test(u) && init && init.method === "POST") {
                const id = "lr1-" + (++self.n);
                self.posts.push({ id, body: JSON.parse(init.body) });
                return new Response(JSON.stringify({ prompt_id: id, number: self.n, node_errors: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
            if (u.includes("/object_info/LoraLoaderModelOnly")) {
                self.rereads++;
                if (self.reread === "fail") return new Response("no", { status: 500 });
                return new Response(JSON.stringify({ LoraLoaderModelOnly: LORA(self.rereadNames) }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
            return orig.call(window, url, init);
        };
    },
    restore() {
        if (!this.saved) return;
        const s = this.saved;
        host.connected = s.connected; host.objectInfo = s.objectInfo; host.ensureOnServer = s.ensure; host.missingFilesRefusal = s.missing; host.loras = s.loras; window.fetch = s.fetch;
        host.setRecipe(s.recipe);
        this.saved = null;
    },
});
/** one queueGenerate: the POST it made, or the error it threw (`{ err, kind }`) */
const queue = async (ed) => {
    const n = S.posts.length;
    try { await host.queueGenerate(ed); } catch (e) { if (S.posts.length !== n) throw new Error("posted and threw: " + e.message); return { err: String(e && e.message || e), kind: e && e.statusKind || "" }; }
    if (S.posts.length !== n + 1) throw new Error("nothing was queued: " + ed.status);
    return S.posts[n];
};
"""

STEPS = [
    ("setup", r"""
S.install();
const d = await run("new_document");
window.__lr = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 320, height: 240 });
await run("select_rect", { doc: d.id, x: 80, y: 60, w: 160, h: 120 });
await run("set_prompt", { doc: d.id, text: "a red mug on the table" });
host.setRecipe(klein3);
if (host.recipe.id !== "flux3_klein_local" || !host.recipe.loras || host.recipe.loras.family !== "flux3") throw new Error("the recipe: " + JSON.stringify(host.recipe.loras));
return { doc: d.id, names: host.loraNames().length };
"""),
    ("the_rows_go_into_the_queued_copy", r"""
const ed = ednow(window.__lr);
const before = JSON.stringify(klein3.prompt);
host.loras = { flux3_klein_local: [
    { name: "Flux_3/Flux3_Targa.safetensors", strength: 0.8, on: true },     // "/" where the server says "\": its spelling goes
    { name: "klein\\old_style.safetensors", strength: 0.5, on: false },      // switched off: not sent, not checked
    { name: "klein\\nyc_style.safetensors", strength: 1, on: true },
] };
const ensured0 = S.ensured, rereads0 = S.rereads;
const logFrom = ((await window.scumble.log.list({})).slice(-1)[0] || { id: 0 }).id;
const q = await queue(ed);
if (q.err) throw new Error("refused: " + q.err);
const g = q.body.prompt;
const want1 = { model: ["unet", 0], lora_name: "Flux_3\\Flux3_Targa.safetensors", strength_model: 0.8 };
const want2 = { model: ["scumble_lora_1", 0], lora_name: "klein\\nyc_style.safetensors", strength_model: 1 };
if (!g.scumble_lora_1 || g.scumble_lora_1.class_type !== "LoraLoaderModelOnly" || JSON.stringify(g.scumble_lora_1.inputs) !== JSON.stringify(want1)) throw new Error("the first LoRA: " + JSON.stringify(g.scumble_lora_1));
if (!g.scumble_lora_2 || g.scumble_lora_2.class_type !== "LoraLoaderModelOnly" || JSON.stringify(g.scumble_lora_2.inputs) !== JSON.stringify(want2)) throw new Error("the second LoRA: " + JSON.stringify(g.scumble_lora_2));
if (g.scumble_lora_3 || JSON.stringify(q.body).includes("old_style")) throw new Error("the switched-off row went");
const fromUnet = readers(g, "unet", 0), fromEnd = readers(g, "scumble_lora_2", 0);
if (fromUnet.join() !== "scumble_lora_1.model" || !fromEnd.includes("guider.model") || !fromEnd.includes("sched.model")) throw new Error("the readers: " + JSON.stringify({ fromUnet, fromEnd }));
if (JSON.stringify(klein3.prompt) !== before || JSON.stringify(host.recipe.prompt) !== before || klein3.prompt.scumble_lora_1) throw new Error("the recipe's own graph changed");
const sentLoras = [{ name: "Flux_3\\Flux3_Targa.safetensors", strength: 0.8 }, { name: "klein\\nyc_style.safetensors", strength: 1 }];
const wf = q.body.extra_data && q.body.extra_data.extra_pnginfo && q.body.extra_data.extra_pnginfo.workflow;
if (!wf || wf.app !== "scumble" || JSON.stringify(wf.loras) !== JSON.stringify(sentLoras)) throw new Error("extra_pnginfo.workflow: " + JSON.stringify(wf && { app: wf.app, loras: wf.loras }));
if (wf.prompt && wf.prompt.scumble_lora_1) throw new Error("the workflow's prompt shows the chain");
if (JSON.stringify(ed.lastLoras) !== JSON.stringify(sentLoras)) throw new Error("editor.lastLoras: " + JSON.stringify(ed.lastLoras));
const words = "Flux3_Targa 0.8, nyc_style 1.0";
const via = (host.recipe.name || host.recipe.id) + " via your ComfyUI + 2 LoRAs: " + words;
const sent = ed._sentTexts && ed._sentTexts.get(q.id);
if (!sent || sent.via !== via) throw new Error("the via text: " + JSON.stringify(sent && sent.via));
if (!ed.lastRunNotes.includes("LoRAs: " + words + ".") || !ed.status.includes("LoRAs: " + words + ".")) throw new Error("the status note: " + JSON.stringify({ notes: ed.lastRunNotes, status: ed.status }));
if (S.ensured !== ensured0 + 1 || S.rereads !== rereads0) throw new Error("uploads / re-reads: " + JSON.stringify({ ensured: S.ensured - ensured0, rereads: S.rereads - rereads0 }));
let line = null;
for (let i = 0; i < 40 && !line; i++) { await wait(50); line = (await window.scumble.log.list({ after: logFrom })).find((e) => e.message === "local run " + q.id + ": LoRAs " + words); }
if (!line || line.source !== "comfy" || line.level !== "info") throw new Error("the log line: " + JSON.stringify(line));
window.__lrFirst = q.id;
return { chain: ["scumble_lora_1", "scumble_lora_2"], readers: fromEnd, via, log: line.message, nodes: Object.keys(g).length };
"""),
    ("a_file_the_server_lacks_refuses_before_any_upload", r"""
const ed = ednow(window.__lr);
host.objectInfo = OI();
S.reread = "list"; S.rereadNames = NAMES;
host.loras = { flux3_klein_local: [
    { name: "Flux_3\\Flux3_Targa.safetensors", strength: 0.8, on: true },
    { name: "klein\\gone.safetensors", strength: 1, on: true },
] };
const ensured0 = S.ensured, rereads0 = S.rereads;
let q = await queue(ed);
const one = "Your ComfyUI lacks a LoRA file this recipe's rows name: klein\\gone.safetensors. Put the file in models/loras (and refresh ComfyUI), pick one of the server's files in the LoRAs section, or switch the row off, then try again.";
if (q.err !== one) throw new Error("one file: " + JSON.stringify(q));
if (S.ensured !== ensured0) throw new Error("ensureOnServer ran before the refusal");
if (S.rereads !== rereads0 + 1) throw new Error("the list was not read again before refusing: " + (S.rereads - rereads0));
// two files: the plural
host.loras.flux3_klein_local.push({ name: "zz\\also_gone.safetensors", strength: 1, on: true });
q = await queue(ed);
if (!/^Your ComfyUI lacks LoRA files this recipe's rows name: klein\\gone\.safetensors, zz\\also_gone\.safetensors\. Put the files in models\/loras .* or switch the rows off, then try again\.$/.test(q.err || "")) throw new Error("two files: " + JSON.stringify(q));
host.loras.flux3_klein_local.pop();
// switched off, the row is neither sent nor refused
host.loras.flux3_klein_local[1].on = false;
q = await queue(ed);
if (q.err || JSON.stringify(q.body).includes("gone.safetensors")) throw new Error("the switched-off missing row: " + JSON.stringify(q.err || q.body.prompt.scumble_lora_2));
// the file copied in since the connect: the re-read lists it, the run goes and the node list keeps it
host.loras.flux3_klein_local[1].on = true;
S.rereadNames = [...NAMES, "klein\\gone.safetensors"];
const ensured1 = S.ensured;
q = await queue(ed);
if (q.err || !q.body.prompt.scumble_lora_2 || q.body.prompt.scumble_lora_2.inputs.lora_name !== "klein\\gone.safetensors") throw new Error("after the copy: " + JSON.stringify(q.err || q.body.prompt.scumble_lora_2));
if (S.ensured !== ensured1 + 1 || !host.loraNames().includes("klein\\gone.safetensors")) throw new Error("the re-read list was not kept: " + JSON.stringify(host.loraNames()));
S.rereadNames = NAMES;
host.objectInfo = OI();
return { refused: one.slice(0, 80), rereads: S.rereads - rereads0 };
"""),
    ("an_unread_node_list_refuses_nothing", r"""
const ed = ednow(window.__lr);
host.objectInfo = null;
S.reread = "fail";
host.loras = { flux3_klein_local: [
    { name: "Flux_3/Flux3_Targa.safetensors", strength: 0.8, on: true },
    { name: "klein\\gone.safetensors", strength: 0.6, on: true },
] };
const rereads0 = S.rereads;
let q = await queue(ed);
if (q.err) throw new Error("refused against an unread list: " + q.err);
let g = q.body.prompt;
if (!g.scumble_lora_1 || g.scumble_lora_1.inputs.lora_name !== "Flux_3/Flux3_Targa.safetensors" || g.scumble_lora_2.inputs.lora_name !== "klein\\gone.safetensors" || g.scumble_lora_2.inputs.strength_model !== 0.6) throw new Error("the names as typed: " + JSON.stringify([g.scumble_lora_1, g.scumble_lora_2]));
if (readers(g, "unet", 0).join() !== "scumble_lora_1.model" || !readers(g, "scumble_lora_2", 0).includes("guider.model")) throw new Error("the chain by the class table: " + JSON.stringify(readers(g, "scumble_lora_2", 0)));
if (S.rereads !== rereads0 + 1) throw new Error("the empty list was not read again: " + (S.rereads - rereads0));
// the re-read answers: the server's spelling goes, and the node list stays unread (a partial list would read every
// other node as missing)
S.reread = "list";
q = await queue(ed);
if (!q.err || !/lacks a LoRA file this recipe's rows name: klein\\gone\.safetensors\./.test(q.err)) throw new Error("the re-read's list did not refuse klein\\gone.safetensors: " + JSON.stringify(q.err || "queued"));
host.loras.flux3_klein_local.pop();
q = await queue(ed);
if (q.err || q.body.prompt.scumble_lora_1.inputs.lora_name !== "Flux_3\\Flux3_Targa.safetensors") throw new Error("the re-read's spelling: " + JSON.stringify(q.err || q.body.prompt.scumble_lora_1));
if (host.objectInfo !== null) throw new Error("a partial node list was kept: " + Object.keys(host.objectInfo || {}));
host.objectInfo = OI();
return { typed: "Flux_3/Flux3_Targa.safetensors", spelt: "Flux_3\\Flux3_Targa.safetensors" };
"""),
    ("six_rows_refused_five_sent_in_order", r"""
const ed = ednow(window.__lr);
host.objectInfo = OI();
const six = [0, 1, 2, 3, 0, 1].map((i, k) => ({ name: NAMES[i], strength: 0.1 * (k + 1), on: true }));
host.loras = { flux3_klein_local: six };
const ensured0 = S.ensured;
let q = await queue(ed);
if (!/^At most 5 LoRAs per recipe: .+'s rows switch on 6\. Switch rows off in the LoRAs section, then try again\.$/.test(q.err || "") || q.kind !== "warn") throw new Error("six: " + JSON.stringify(q));
if (S.ensured !== ensured0) throw new Error("ensureOnServer ran before the six were refused");
// one off: five go, in order, each after the one before
six[2].on = false;
q = await queue(ed);
if (q.err) throw new Error("five refused: " + q.err);
const g = q.body.prompt, ids = ["scumble_lora_1", "scumble_lora_2", "scumble_lora_3", "scumble_lora_4", "scumble_lora_5"];
const want = six.filter((r) => r.on);
for (let i = 0; i < 5; i++) {
    const n = g[ids[i]];
    const prev = i ? [ids[i - 1], 0] : ["unet", 0];
    if (!n || n.inputs.lora_name !== want[i].name || Math.abs(n.inputs.strength_model - want[i].strength) > 1e-9 || JSON.stringify(n.inputs.model) !== JSON.stringify(prev)) throw new Error("row " + (i + 1) + ": " + JSON.stringify(n));
}
if (g.scumble_lora_6 || !readers(g, "scumble_lora_5", 0).includes("guider.model")) throw new Error("the chain's end: " + JSON.stringify(readers(g, "scumble_lora_5", 0)));
if (q.body.extra_data.extra_pnginfo.workflow.loras.length !== 5) throw new Error("the workflow's loras: " + q.body.extra_data.extra_pnginfo.workflow.loras.length);
return { five: want.map((r) => r.name) };
"""),
    ("a_recipe_that_takes_none_keeps_its_graph", r"""
const ed = ednow(window.__lr);
host.objectInfo = OI();
const none = { ...klein3, id: "lr1_no_loras", name: "No LoRAs (test)", loras: false };
host.setRecipe(none);
host.loras = { lr1_no_loras: [{ name: "klein\\gone.safetensors", strength: 1, on: true }] };
const q = await queue(ed);
if (q.err) throw new Error("refused: " + q.err);
const g = q.body.prompt;
if (Object.keys(g).some((k) => /^scumble_lora/.test(k)) || readers(g, "unet", 0).join() !== readers(klein3.prompt, "unet", 0).join()) throw new Error("the graph changed: " + JSON.stringify(readers(g, "unet", 0)));
if (!ed.lastRunNotes.includes("The LoRAs stayed out: the recipe takes no LoRAs.")) throw new Error("the note: " + JSON.stringify(ed.lastRunNotes));
if ("loras" in q.body.extra_data.extra_pnginfo.workflow || ed.lastLoras.length) throw new Error("loras reported: " + JSON.stringify(q.body.extra_data.extra_pnginfo.workflow.loras));
const via = ed._sentTexts.get(q.id).via;
if (via !== "No LoRAs (test) via your ComfyUI") throw new Error("the via text: " + via);
// without rows the run is as before: no note, no key
host.loras = {};
const q2 = await queue(ed);
if (ed.lastRunNotes.some((n) => /LoRA/.test(n)) || "loras" in q2.body.extra_data.extra_pnginfo.workflow) throw new Error("without rows: " + JSON.stringify(ed.lastRunNotes));
host.setRecipe(klein3);
return { note: "The LoRAs stayed out: the recipe takes no LoRAs.", via };
"""),
    ("the_result_lands_with_the_loras_in_its_via_line", r"""
const ed = ednow(window.__lr);
const pid = window.__lrFirst;
if (!pid || !ed._sentTexts.has(pid)) throw new Error("the first run's texts are gone: " + pid);
const png = async () => { const c = new OffscreenCanvas(40, 40); const x = c.getContext("2d"); x.fillStyle = "#3366aa"; x.fillRect(0, 0, 40, 40); return c.convertToBlob({ type: "image/png" }); };
const savedRefs = host.ensureRefs;
host.ensureRefs = async () => ({ checked: 0, uploaded: [], missing: [] });
try {
    const up = await host.uploadInput(await png(), "lr1_result_" + Date.now() + ".png");
    const n = ed.history.length;
    ed.lastPromptId = pid;
    api.dispatch("executed", { prompt_id: pid, node: "decode", output: { inpaint_result: [{ filename: up.filename, subfolder: up.subfolder, type: up.type, x: 80, y: 60, width: 40, height: 40 }] } });
    for (let i = 0; i < 60 && ed.history.length <= n; i++) await wait(100);
    const h = ed.history[ed.history.length - 1];
    const re = new RegExp("^" + (host.recipe.name || host.recipe.id).replace(/[()]/g, "\\$&") + " via your ComfyUI \\+ 2 LoRAs: Flux3_Targa 0\\.8, nyc_style 1\\.0, \\d+ s$");
    if (ed.history.length <= n || !re.test(h.via || "")) throw new Error("the history entry's via: " + JSON.stringify(h && h.via));
    ed.renderHistory();
    const shown = Array.from(ed.historyList.querySelectorAll(".ipc-hvia")).map((s) => s.textContent);
    if (!shown.includes(h.via)) throw new Error("the history row shows " + JSON.stringify(shown));
    return { via: h.via };
} finally { host.ensureRefs = savedRefs; ed.lastPromptId = null; }
"""),
    ("cleanup", r"""
S.restore();
try { await run("close_document", { doc: window.__lr, force: true }); } catch (_) { /* gone */ }
return { recipe: host.recipe && host.recipe.id, loras: Object.keys(host.loras || {}) };
"""),
]

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    %s
    %s
})()"""


async def run_all(c):
    ok = True
    try:
        print("[ok] the_splice_module_in_plain_node: %s" % json.dumps(node_step()))
    except Exception as err:  # noqa: BLE001
        print("[FAIL] the_splice_module_in_plain_node: %s" % str(err)[:1500])
        print("FAIL")
        return False
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    for name, body in STEPS:
        try:
            res = await c.eval(PRE % (STUBS, body), timeout=240)
            print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:600]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, str(err)[:1200]))
            if name == "setup":
                break
            if name != "cleanup":
                continue
    if not ok:
        # the stand-ins out whatever failed
        try:
            await c.eval(PRE % (STUBS, "S.restore(); return 1;"), timeout=60)
        except Exception:  # noqa: BLE001
            pass
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
