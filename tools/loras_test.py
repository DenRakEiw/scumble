"""LoRAs on the user's ComfyUI (item 50, docs/PLAN_LORAS.md LR1): plain Node first, then the queue path in the app.

No ComfyUI, no API key, nothing reaches a server. The first step runs tools/loras_test.js (renderer/editor/loras.js
over every shipped recipe: the model source, the chain, the rows, the declarations, missingLoras, the helpers). The
rest drives the running app (run --offline) with the server stood in for, as generate_test.py's Klein steps do: the
page's `fetch` answers POST /prompt (so api.queuePrompt builds the real body, extra_pnginfo included) and
/object_info/LoraLoaderModelOnly (the list read again), `host.objectInfo` holds a LoRA combo whose names carry
backslashes, `host.ensureOnServer` and `host.missingFilesRefusal` are stubbed, and `host.loras` holds the rows (the
store's shape; the LoRAs section's own steps follow):

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

Then the LoRAs section of the Generate tab (LR2, renderer/editor/lora_panel.js), driven by its own controls:

- it is the <details> right after Settings and before History, the Boxes plugin's panel still after Crop;
- hidden under an API recipe (qwen_image_edit), an upscaler (rtx_vsr_local), the Realism Pass, a `loras: false`
  recipe, a graph with two model loaders and a Comfy Cloud recipe, each with its reason in the summary's title;
- + adds rows (each opens the picker; Escape closes it) up to five, the sixth greyed; × takes rows off; the store
  (settings.recipeLoras) follows;
- a pick through the picker: the list read again on open, the search focused, the folder groups, a search, the
  arrows, a pointer move of no distance keeps the cursor and a real one takes it, Enter picks, a click picks, Escape
  and a press outside close it with the editor's status untouched; the next queued prompt holds both picks;
- the strength: the spinner -2 .. 2 by 0.05, a typed value clamped to the node list's range, no number kept out; the
  tick leaves a row out of the run; ×;
- the rows survive a recipe switch, a second document shows the same rows and a change in one shows in the other; a
  file the list lacks is marked; not connected, the picker says so and keeps the row;
- a recipe saved from the ComfyUI window under a new id takes the rows of the one it came from (shell.js
  copySavedLoras, main's comfyview:saved `from`); without `from`, or with `from` the same id, nothing moves.

Then the base-model hint (LR3), with host.loraHeader stood in for (main's loras:header, the user's files are never
read here) and the page's `fetch` answering /view_metadata:

- a row's file read by its tensor names: the grey line "looks like FLUX 3" under flux3_klein_local, its trigger word as
  a chip; a click on the chip appends ", Targa" to the prompt (the editor's prompt setter);
- a 2509 LoRA under qwen_image_edit_2_1_local (a FLUX.1 one under flux2_klein_local too): the amber line with the
  plan's sentence, and the run still goes (nothing refused), the chain in the queued prompt;
- no header (a remote server, no models folder linked): the server's /view_metadata answer gives "metadata says SD
  1.5" (anna_qwen's lie, grey, never amber); a 404 there leaves the folder, "in folder klein";
- read once per server and name (the stand-in asked once for two looks, a connect starts over);
- the picker of flux3_klein_local shows the Flux_3 folder first and the rest behind Show all; Show all and back; a
  row whose file sits in a hidden folder opens the picker with every folder shown.

Every stub, the recipe, the rows and the stored settings.recipeLoras are put back whatever happens.

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
    out = {}
    # the splice module, then the header reader (LR3: synthetic safetensors files in its own temp folder)
    for name in ("loras_test.js", "loraheader_test.js"):
        r = subprocess.run(["node", os.path.join(ROOT, "tools", name)], cwd=ROOT,
                           capture_output=True, text=True, encoding="utf-8", timeout=180)
        # stdout alone: stderr carries Node's note that it read renderer/editor/loras.js as an ES module
        tail = r.stdout.strip()
        if r.returncode != 0 or not tail.endswith("PASS"):
            raise Exception("tools/%s: %s" % (name, (tail + r.stderr)[-1500:]))
        out[name] = {"checks": tail.count("[ok]"), "tail": (tail.splitlines()[-2:-1] or [""])[0]}
    return out


# the stand-ins every app step shares: S.install() puts them in, S.restore() takes them out again
STUBS = r"""
const api = (await import('./editor/host.js')).api;
const panel = await import('./editor/lora_panel.js');
const shellMod = await import('./shell.js');
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
    headers: {}, headerAsks: 0, meta: {}, metaAsks: 0,
    install() {
        if (this.saved) return;
        this.saved = { connected: host.connected, objectInfo: host.objectInfo, ensure: host.ensureOnServer, missing: host.missingFilesRefusal, recipe: host.recipe, loras: host.loras, fetch: window.fetch, server: host.server, loraHeader: host.loraHeader };
        const self = this, orig = this.saved.fetch;
        // main's loras:header (the linked models folder): the test's reduced headers by name, never a file of the user's
        host.loraHeader = async (name) => { self.headerAsks++; return self.headers[name] || null; };
        host._loraInfo.clear();
        host.connected = true;
        host.server = { ...host.server, state: "connected" };   // the LoRAs section's picker asks the shell's last status
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
            // ComfyUI's /view_metadata: the test's metadata by file name, a 404 for any other
            const vm = /\/view_metadata\/loras\?filename=([^&]+)/.exec(u);
            if (vm) {
                self.metaAsks++;
                const m = self.meta[decodeURIComponent(vm[1])];
                return m ? new Response(JSON.stringify(m), { status: 200, headers: { "Content-Type": "application/json" } }) : new Response("", { status: 404 });
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
        panel.closePicker();
        host.connected = s.connected; host.objectInfo = s.objectInfo; host.ensureOnServer = s.ensure; host.missingFilesRefusal = s.missing; host.loras = s.loras; window.fetch = s.fetch; host.server = s.server;
        host.loraHeader = s.loraHeader;
        host._loraInfo.clear();
        host.setRecipe(s.recipe);
        this.saved = null;
    },
});
// the LoRAs section (LR2): its parts, the Generate tab's sections, and the user's hand on it
const P = (ed) => ed._loraPanel;
const sections = (ed) => Array.from(ed.panes.gen.querySelectorAll(":scope > details")).map((d) => ({ title: d.querySelector("summary").firstChild.textContent, hidden: d.hidden, el: d }));
const rowEls = (ed) => Array.from(P(ed).list.querySelectorAll(".ipc-lora-row"));
const nameBtn = (ed, i) => P(ed).list.querySelector('.ipc-lora-row[data-index="' + i + '"] .ipc-lora-name');
const strEl = (ed, i) => P(ed).list.querySelector('.ipc-lora-row[data-index="' + i + '"] .ipc-lora-strength');
const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const typeIn = (el, text) => { el.value = text; el.dispatchEvent(new Event("input", { bubbles: true })); };
const setNum = (el, v) => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); };
const stored = async () => ((await window.scumble.settings.get()).recipeLoras || {});
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await wait(50); } return null; };
const rowsNow = () => JSON.parse(JSON.stringify((host.loras || {}).flux3_klein_local || []));
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
    ("ui_the_section_sits_after_settings", r"""
// LR2: the LoRAs section is the <details> right after Settings and before History; the Boxes plugin's panel stays after Crop
const ed = ednow(window.__lr);
window.__lrStore = (await window.scumble.settings.get()).recipeLoras || {};
host.setRecipe(klein3);
const s = sections(ed), at = (t) => s.findIndex((x) => x.title === t);
const iL = at("LoRAs"), iS = at("Settings"), iH = at("History"), iC = at("Crop"), iB = at("Boxes");
if (iL < 0 || iL !== iS + 1 || iH !== iL + 1) throw new Error("the order: " + s.map((x) => x.title).join(", "));
if (iB < 0 || iB < iC) throw new Error("the Boxes panel is not after Crop: " + s.map((x) => x.title).join(", "));
if (s[iL].el !== P(ed).section || s[iL].hidden || s[iL].el.open) throw new Error("the section: " + JSON.stringify({ hidden: s[iL].hidden, open: s[iL].el.open }));
if (!/^LoRAs for FLUX 3 Image Klein/.test(P(ed).summary.title)) throw new Error("the summary's title: " + P(ed).summary.title);
if (ed.panes.image.contains(P(ed).section)) throw new Error("the section is in the Image tab");
return { order: s.map((x) => x.title) };
"""),
    ("ui_hidden_where_a_recipe_takes_none", r"""
const ed = ednow(window.__lr);
const rec = (id) => { const r = host.shell.recipes().find((x) => x.id === id); if (!r) throw new Error(id + " is not listed"); return r; };
const cloudRaw = rec("cloud_qwen_image_edit_2509");
const cloud = { ...cloudRaw, provider: "comfycloud", options: cloudRaw.providers.comfycloud.options };
const two = JSON.parse(JSON.stringify(klein3.prompt));
two.unet2 = JSON.parse(JSON.stringify(two.unet));
two.sched.inputs.model = ["unet2", 0];
const cases = [
    [rec("qwen_image_edit"), /runs through an API provider: LoRAs go only to your ComfyUI and Comfy Cloud\.$/],
    [rec("rtx_vsr_local"), /is an upscaler: it loads no model a LoRA could change\.$/],
    [rec("realism_pass"), /loads no model a LoRA could change\.$/],
    [{ ...klein3, id: "lr2_no_loras", name: "No LoRAs (test)", loras: false }, /^No LoRAs \(test\) takes no LoRA rows: the recipe takes no LoRAs\.$/],
    [{ ...klein3, id: "lr2_two", name: "Two loaders (test)", loras: undefined, prompt: two }, /^Two loaders \(test\)'s graph has 2 model loaders \(unet, unet2\) and the recipe names none of them/],
    [cloud, /runs on Comfy Cloud, and Scumble does not send LoRA rows there yet\.$/],
];
host.loras = { flux3_klein_local: [{ name: NAMES[0], strength: 0.8, on: true }] };
const out = {};
for (const [r, want] of cases) {
    host.setRecipe(r);
    const p = P(ed);
    if (!p.section.hidden) throw new Error(r.id + ": the section shows");
    if (!want.test(p.summary.title) || p.section.dataset.reason !== p.summary.title) throw new Error(r.id + ": the reason " + JSON.stringify(p.summary.title));
    if (host.loraTakes(r).takes !== false) throw new Error(r.id + ": loraTakes " + JSON.stringify(host.loraTakes(r)));
    out[r.id] = p.summary.title.slice(0, 70);
}
host.setRecipe(klein3);
if (P(ed).section.hidden || rowEls(ed).length !== 1) throw new Error("back on flux3_klein_local: " + JSON.stringify({ hidden: P(ed).section.hidden, rows: rowEls(ed).length }));
return out;
"""),
    ("ui_plus_adds_rows_up_to_five", r"""
const ed = ednow(window.__lr);
host.objectInfo = OI();
host.loras = {};
panel.renderAll(host);
const p = P(ed);
p.section.open = true;
if (rowEls(ed).length || p.add.disabled || !/Add a LoRA/.test(p.note.textContent)) throw new Error("the empty section: " + JSON.stringify({ rows: rowEls(ed).length, disabled: p.add.disabled, note: p.note.textContent }));
for (let n = 1; n <= 5; n++) {
    p.add.click();
    const st = panel.openPickerState();
    if (!st || st.index !== n - 1) throw new Error("+ #" + n + " opened " + JSON.stringify(st && st.index));
    key(st.search, "Escape");
    if (panel.openPickerState()) throw new Error("Escape left the picker open");
    if (rowEls(ed).length !== n || rowsNow().length !== n) throw new Error("+ #" + n + ": " + rowEls(ed).length + " rows");
}
const rows = rowsNow();
if (!rows.every((r) => r.name === "" && r.strength === 1 && r.on === true)) throw new Error("the new rows: " + JSON.stringify(rows));
if (!p.add.disabled || !/Five LoRAs per recipe/.test(p.add.title) || p.note.textContent !== "Five LoRAs per recipe.") throw new Error("the sixth +: " + JSON.stringify({ disabled: p.add.disabled, title: p.add.title, note: p.note.textContent }));
p.add.click();
if (rowsNow().length !== 5 || panel.openPickerState()) throw new Error("a sixth row came");
if (!(await until(async () => ((await stored()).flux3_klein_local || []).length === 5))) throw new Error("the store: " + JSON.stringify((await stored()).flux3_klein_local));
if (p.count.textContent !== "5 on" || !/Pick a LoRA/.test(nameBtn(ed, 0).textContent)) throw new Error("the summary / the empty name: " + p.count.textContent + " / " + nameBtn(ed, 0).textContent);
// × takes three of them off again
for (let i = 0; i < 3; i++) rowEls(ed)[rowEls(ed).length - 1].querySelector(".ipc-lora-del").click();
if (rowsNow().length !== 2 || p.add.disabled) throw new Error("after three ×: " + rowsNow().length);
return { rows: 5, after: 2, stored: 5 };
"""),
    ("ui_a_pick_through_the_search_lands_in_the_store_and_the_run", r"""
const ed = ednow(window.__lr);
host.objectInfo = OI();
S.reread = "list"; S.rereadNames = NAMES;
const rereads0 = S.rereads;
nameBtn(ed, 0).click();
let st = panel.openPickerState();
if (!st || st.index !== 0) throw new Error("the picker did not open");
await until(() => S.rereads > rereads0, 2000);
await wait(60);
if (S.rereads !== rereads0 + 1) throw new Error("the list was not read again on open: " + (S.rereads - rereads0));
if (document.activeElement !== st.search) throw new Error("the search has no focus: " + (document.activeElement && document.activeElement.className));
// FLUX 3's own folder first (LR3); Show all lists every folder
const famOnly = Array.from(st.el.querySelectorAll(".ipc-lp-group .ipc-lp-folder")).map((g) => g.textContent);
if (JSON.stringify(famOnly) !== '["Flux_3"]' || !st.el.querySelector(".ipc-lp-more")) throw new Error("the family group: " + JSON.stringify(famOnly));
st.el.querySelector(".ipc-lp-more").click();
st = panel.openPickerState();
const groups = Array.from(st.el.querySelectorAll(".ipc-lp-group .ipc-lp-folder")).map((g) => g.textContent);
if (JSON.stringify(groups) !== JSON.stringify(["Flux_3", "klein", "qwen", "(root)"]) || st.rows().length !== NAMES.length) throw new Error("the groups: " + JSON.stringify(groups) + ", " + st.rows().length + " rows");
typeIn(st.search, "NYC");
st = panel.openPickerState();
const hits = st.rows().map((r) => r.name);
if (JSON.stringify(hits) !== JSON.stringify(["klein\\nyc_style.safetensors", "qwen\\NYC_Qwen.safetensors"]) || st.cursor.name !== hits[0]) throw new Error("the search: " + JSON.stringify({ hits, cursor: st.cursor && st.cursor.name }));
key(st.search, "ArrowDown");
if (panel.openPickerState().cursor.name !== hits[1]) throw new Error("ArrowDown");
key(st.search, "ArrowDown");
if (panel.openPickerState().cursor.name !== hits[0]) throw new Error("ArrowDown does not wrap");
// a move of no distance (Chromium's after a layout under a resting pointer) keeps the cursor; a real move takes it
const second = st.rows()[1].el;
second.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, movementX: 0, movementY: 0 }));
if (panel.openPickerState().cursor.name !== hits[0]) throw new Error("a move of no distance took the cursor");
second.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, movementX: 3, movementY: 1 }));
if (panel.openPickerState().cursor.name !== hits[1]) throw new Error("a real move did not take the cursor");
key(st.search, "ArrowUp");
const status0 = ed.status;
key(st.search, "Enter");
if (panel.openPickerState()) throw new Error("Enter left the picker open");
if (rowsNow()[0].name !== "klein\\nyc_style.safetensors") throw new Error("the pick: " + JSON.stringify(rowsNow()[0]));
if (ed.status !== status0) throw new Error("the editor took a key: " + ed.status);
if (!(await until(async () => (((await stored()).flux3_klein_local || [])[0] || {}).name === "klein\\nyc_style.safetensors"))) throw new Error("the store: " + JSON.stringify((await stored()).flux3_klein_local));
// row 2 by a click on a hit
nameBtn(ed, 1).click();
st = panel.openPickerState();
typeIn(st.search, "klein/targa");
if (st.rows().length !== 0 || !/No LoRA matches "klein\/targa"/.test(st.el.querySelector(".ipc-lp-note").textContent)) throw new Error("no match: " + st.rows().length);
typeIn(st.search, "targa");
panel.openPickerState().rows()[0].el.click();
if (panel.openPickerState() || rowsNow()[1].name !== "Flux_3\\Flux3_Targa.safetensors") throw new Error("the click pick: " + JSON.stringify(rowsNow()[1]));
// Escape closes it and the editor leaves the key alone; a press outside closes it too
nameBtn(ed, 1).click();
st = panel.openPickerState();
key(st.search, "Escape");
if (panel.openPickerState() || ed.status !== status0) throw new Error("Escape: " + JSON.stringify({ open: !!panel.openPickerState(), status: ed.status }));
nameBtn(ed, 1).click();
ed.canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
if (panel.openPickerState()) throw new Error("a press outside left it open");
if (rowsNow()[1].name !== "Flux_3\\Flux3_Targa.safetensors") throw new Error("a close without a pick changed the row");
// the next run loads both, in order
host.objectInfo = OI();
const q = await queue(ed);
if (q.err) throw new Error("refused: " + q.err);
const g = q.body.prompt;
if (g.scumble_lora_1.inputs.lora_name !== "klein\\nyc_style.safetensors" || g.scumble_lora_1.inputs.strength_model !== 1 || g.scumble_lora_2.inputs.lora_name !== "Flux_3\\Flux3_Targa.safetensors" || g.scumble_lora_3) throw new Error("the queued chain: " + JSON.stringify([g.scumble_lora_1, g.scumble_lora_2, g.scumble_lora_3]));
return { picked: rowsNow().map((r) => r.name), rereads: S.rereads - rereads0 };
"""),
    ("ui_strength_clamped_tick_and_remove", r"""
const ed = ednow(window.__lr);
host.objectInfo = OI();
const s0 = strEl(ed, 0);
if (s0.min !== "-2" || s0.max !== "2" || s0.step !== "0.05" || s0.value !== "1.0") throw new Error("the spinner: " + JSON.stringify({ min: s0.min, max: s0.max, step: s0.step, value: s0.value }));
setNum(strEl(ed, 0), "250");
if (rowsNow()[0].strength !== 100 || strEl(ed, 0).value !== "100.0") throw new Error("250 -> " + rowsNow()[0].strength + " / " + strEl(ed, 0).value);
setNum(strEl(ed, 0), "-3.5");
if (rowsNow()[0].strength !== -3.5) throw new Error("-3.5 -> " + rowsNow()[0].strength);
setNum(strEl(ed, 0), "");
if (rowsNow()[0].strength !== -3.5 || strEl(ed, 0).value !== "-3.5") throw new Error("an empty field changed the row: " + rowsNow()[0].strength);
// the node list's own range
const oi = OI();
oi.LoraLoaderModelOnly.input.required.strength_model[1].max = 5;
host.objectInfo = oi;
setNum(strEl(ed, 0), "9");
if (rowsNow()[0].strength !== 5) throw new Error("9 against max 5 -> " + rowsNow()[0].strength);
host.objectInfo = OI();
setNum(strEl(ed, 0), "0.85");
if (rowsNow()[0].strength !== 0.85) throw new Error("0.85 -> " + rowsNow()[0].strength);
// the tick: switched off, the row stays and the run leaves it out
const tick = P(ed).list.querySelector('.ipc-lora-row[data-index="1"] .ipc-lora-on');
tick.checked = false;
tick.dispatchEvent(new Event("change", { bubbles: true }));
if (rowsNow()[1].on !== false || !rowEls(ed)[1].classList.contains("ipc-lora-off") || P(ed).count.textContent !== "1 on") throw new Error("the tick: " + JSON.stringify({ row: rowsNow()[1], count: P(ed).count.textContent }));
const q = await queue(ed);
if (q.err || q.body.prompt.scumble_lora_2 || q.body.prompt.scumble_lora_1.inputs.strength_model !== 0.85 || JSON.stringify(q.body).includes("Flux3_Targa")) throw new Error("the run after the tick: " + JSON.stringify(q.err || q.body.prompt.scumble_lora_1));
// × takes the row off
rowEls(ed)[1].querySelector(".ipc-lora-del").click();
if (rowsNow().length !== 1 || rowsNow()[0].name !== "klein\\nyc_style.safetensors") throw new Error("×: " + JSON.stringify(rowsNow()));
if (!(await until(async () => JSON.stringify((await stored()).flux3_klein_local) === JSON.stringify(rowsNow())))) throw new Error("the store: " + JSON.stringify((await stored()).flux3_klein_local));
return { rows: rowsNow() };
"""),
    ("ui_rows_survive_a_switch_and_are_every_documents", r"""
const ed = ednow(window.__lr);
host.objectInfo = OI();
host.loras = { flux3_klein_local: [{ name: NAMES[0], strength: 0.8, on: true }, { name: "klein\\gone.safetensors", strength: 1, on: true }, { name: NAMES[1], strength: 1.2, on: false }] };
panel.renderAll(host);
const stems = (e) => rowEls(e).map((r) => r.querySelector(".ipc-lora-stem").textContent);
// a file the list lacks is marked, the others not
const miss = rowEls(ed).map((r) => !!r.querySelector(".ipc-lora-miss"));
if (JSON.stringify(miss) !== "[false,true,false]" || !/not on the server/.test(nameBtn(ed, 1).title)) throw new Error("the missing mark: " + JSON.stringify(miss));
host.setRecipe(host.shell.recipes().find((x) => x.id === "rtx_vsr_local"));
if (!P(ed).section.hidden) throw new Error("shown under rtx_vsr_local");
host.setRecipe(klein3);
if (JSON.stringify(stems(ed)) !== JSON.stringify(["Flux3_Targa", "gone", "nyc_style"])) throw new Error("after the switch: " + JSON.stringify(stems(ed)));
// a second document shows the same rows, and a change in one shows in the other
const d2 = await run("new_document");
const ed2 = ednow(d2.id);
try {
    if (JSON.stringify(stems(ed2)) !== JSON.stringify(stems(ed))) throw new Error("the second document: " + JSON.stringify(stems(ed2)));
    rowEls(ed2)[1].querySelector(".ipc-lora-del").click();
    if (JSON.stringify(stems(ed)) !== JSON.stringify(["Flux3_Targa", "nyc_style"])) throw new Error("the first after a × in the second: " + JSON.stringify(stems(ed)));
} finally { await run("close_document", { doc: d2.id, force: true }); host.shell.activate(ed); }
// not connected: the picker says so, keeps the row, and Escape still closes it
host.server = { ...host.server, state: "disconnected" };
nameBtn(ed, 0).click();
const st = panel.openPickerState();
await wait(30);
const note = st.el.querySelector(".ipc-lp-note").textContent;
if (!/^Connect ComfyUI to pick LoRAs/.test(note) || st.rows().length || !st.search.disabled) throw new Error("disconnected: " + JSON.stringify({ note, rows: st.rows().length }));
if (document.activeElement !== st.el) throw new Error("the dialog has no focus: " + (document.activeElement && document.activeElement.className));
key(st.el, "Escape");
if (panel.openPickerState() || rowsNow()[0].name !== NAMES[0]) throw new Error("disconnected Escape: " + JSON.stringify(rowsNow()[0]));
host.server = { ...host.server, state: "connected" };
return { rows: stems(ed), note };
"""),
    ("ui_a_saved_recipe_takes_the_rows_it_was_saved_from", r"""
// main's comfyview:saved names `from` (the recipe the ComfyUI window held); the shell copies its rows to a new id
const rows = rowsNow();
if (!(await shellMod.copySavedLoras({ id: "lr2_saved", from: "flux3_klein_local" }))) throw new Error("nothing copied");
if (JSON.stringify(host.loras.lr2_saved) !== JSON.stringify(rows) || host.loras.lr2_saved === host.loras.flux3_klein_local) throw new Error("the copy: " + JSON.stringify(host.loras.lr2_saved));
if ((await shellMod.copySavedLoras({ id: "lr2_saved2" })) || "lr2_saved2" in host.loras) throw new Error("copied without from");
if ((await shellMod.copySavedLoras({ id: "flux3_klein_local", from: "flux3_klein_local" })) || JSON.stringify(rowsNow()) !== JSON.stringify(rows)) throw new Error("Save to recipe (from === id) moved rows");
if ((await shellMod.copySavedLoras({ id: "lr2_saved3", from: "no_such_recipe" })) || "lr2_saved3" in host.loras) throw new Error("copied from a recipe without rows");
const st = await stored();
if (JSON.stringify(st.lr2_saved) !== JSON.stringify(rows)) throw new Error("the store: " + JSON.stringify(st.lr2_saved));
return { copied: rows.length };
"""),
    ("hint_the_grey_line_and_a_trigger_chip", r"""
// LR3: the base-model hint under each row's name, read through host.loraHeader (main's loras:header, stood in for) or
// the server's /view_metadata (the page's fetch), else the folder
const ed = ednow(window.__lr);
host.objectInfo = OI();
host.setRecipe(klein3);
const range = (n) => Array.from({ length: n }, (_, i) => i);
S.headers = {
    "Flux_3\\Flux3_Targa.safetensors": { keyCount: 516, modules: ["diffusion_model.content_mode_blocks.image.N.q_proj", "diffusion_model.single_blocks.N.attn_out"], blocks: { content_mode_blocks: range(5), single_blocks: range(28) }, width: { content_mode_blocks: 3072, single_blocks: 3072 }, outs: {}, metadata: { ss_base_model_version: "flux3", tags: ["Targa"] } },
    "qwen\\NYC_Qwen.safetensors": { keyCount: 1680, modules: ["diffusion_model.transformer_blocks.N.attn.add_k_proj", "diffusion_model.transformer_blocks.N.img_mod.N"], blocks: { transformer_blocks: range(60) }, width: { transformer_blocks: 3072 }, outs: {}, metadata: { ss_base_model_version: "sd_1.5", tags: ["NYC"] } },
    "flux\\old_flux1.safetensors": { keyCount: 912, modules: ["lora_unet_double_blocks_N_img_attn_proj", "lora_unet_single_blocks_N_linear1"], blocks: { double_blocks: range(19), single_blocks: range(38) }, width: { double_blocks: 3072, single_blocks: 3072 }, outs: { double_blocks: [3072, 12288], single_blocks: [3072, 21504] }, metadata: {} },
};
S.meta = { "klein\\nyc_style.safetensors": { ss_base_model_version: "sd_1.5", ss_tag_frequency: JSON.stringify({ d: { nyc: 12, "a street at night with": 1 } }) } };
S.headerAsks = 0; S.metaAsks = 0;
host._loraInfo.clear();
host.loras = { flux3_klein_local: [
    { name: "Flux_3\\Flux3_Targa.safetensors", strength: 0.8, on: true },
    { name: "klein\\nyc_style.safetensors", strength: 1, on: true },
    { name: "klein\\gone.safetensors", strength: 1, on: false },
] };
panel.renderAll(host);
const hintOf = (i) => { const el = rowEls(ed)[i] && rowEls(ed)[i].querySelector(".ipc-lora-hint"); return el ? { text: el.textContent, amber: el.classList.contains("ipc-lora-amber"), title: el.title } : null; };
const chips = (i) => Array.from(rowEls(ed)[i].querySelectorAll(".ipc-lora-chip")).map((c) => c.textContent);
if (!(await until(() => hintOf(0) && hintOf(1) && hintOf(2)))) throw new Error("no hint lines: " + JSON.stringify([hintOf(0), hintOf(1), hintOf(2)]));
const h = [hintOf(0), hintOf(1), hintOf(2)];
if (h[0].text !== "looks like FLUX 3" || h[0].amber || !/tensor names/.test(h[0].title)) throw new Error("row 1: " + JSON.stringify(h[0]));
if (h[1].text !== "metadata says SD 1.5" || h[1].amber || !/may be wrong/.test(h[1].title)) throw new Error("row 2 (the server's metadata): " + JSON.stringify(h[1]));
if (h[2].text !== "in folder klein" || h[2].amber) throw new Error("row 3 (a 404, the folder): " + JSON.stringify(h[2]));
if (JSON.stringify(chips(0)) !== '["Targa"]' || JSON.stringify(chips(1)) !== '["nyc"]' || chips(2).length) throw new Error("the chips: " + JSON.stringify([chips(0), chips(1), chips(2)]));
if (S.headerAsks !== 3 || S.metaAsks !== 2) throw new Error("asks: " + JSON.stringify({ headers: S.headerAsks, meta: S.metaAsks }));
// a chip appends its word to the prompt (the editor's prompt setter), a second one after it
await run("set_prompt", { doc: window.__lr, text: "a red mug on the table" });
rowEls(ed)[0].querySelector(".ipc-lora-chip").click();
if (ed.promptText !== "a red mug on the table, Targa") throw new Error("after the chip: " + JSON.stringify(ed.promptText));
rowEls(ed)[1].querySelector(".ipc-lora-chip").click();
if (ed.promptText !== "a red mug on the table, Targa, nyc") throw new Error("after the second chip: " + JSON.stringify(ed.promptText));
await run("set_prompt", { doc: window.__lr, text: "a red mug on the table" });
return { hints: h.map((x) => x.text), chips: [chips(0), chips(1)], asks: { headers: S.headerAsks, meta: S.metaAsks } };
"""),
    ("hint_amber_on_a_mismatch_and_the_run_goes", r"""
const ed = ednow(window.__lr);
const rec = (id) => { const r = host.shell.recipes().find((x) => x.id === id); if (!r) throw new Error(id + " is not listed"); return r; };
const hintOf = (i) => { const el = rowEls(ed)[i] && rowEls(ed)[i].querySelector(".ipc-lora-hint"); return el ? { text: el.textContent, amber: el.classList.contains("ipc-lora-amber") } : null; };
// a 2509 LoRA (anna_qwen's shape, its metadata saying sd_1.5) under Qwen Image 2.1: amber, the plan's sentence
const q21 = rec("qwen_image_edit_2_1_local");
host.setRecipe(q21);
host.loras = { qwen_image_edit_2_1_local: [{ name: "qwen\\NYC_Qwen.safetensors", strength: 1, on: true }] };
panel.renderAll(host);
if (!(await until(() => hintOf(0)))) throw new Error("no hint under qwen_image_edit_2_1_local");
const a = hintOf(0);
const sentence = "This LoRA looks made for Qwen Image (Edit 2509 / 2511); this recipe runs Qwen Image 2.1. ComfyUI loads it without an error and the picture may come back unchanged.";
if (!a.amber || a.text !== sentence) throw new Error("the amber line: " + JSON.stringify(a));
// a FLUX.1 LoRA under flux2_klein_local (FLUX.2 Klein): amber, and the run goes with the chain (nothing refused on it)
const k2 = rec("flux2_klein_local");
host.objectInfo = { ...OI(), ...Object.fromEntries((k2.needs || []).map((n) => [n, { input: { required: {} } }])), LoraLoaderModelOnly: LORA([...NAMES, "flux\\old_flux1.safetensors"]) };
host.setRecipe(k2);
host.loras = { flux2_klein_local: [{ name: "flux\\old_flux1.safetensors", strength: 0.7, on: true }] };
panel.renderAll(host);
if (!(await until(() => hintOf(0)))) throw new Error("no hint under flux2_klein_local");
const b = hintOf(0);
if (!b.amber || !/^This LoRA looks made for FLUX\.1; this recipe runs FLUX\.2 Klein\. /.test(b.text)) throw new Error("the FLUX.1 line: " + JSON.stringify(b));
const q = await queue(ed);
if (q.err) throw new Error("refused on a hint: " + q.err);
const g = q.body.prompt;
if (!g.scumble_lora_1 || g.scumble_lora_1.inputs.lora_name !== "flux\\old_flux1.safetensors" || g.scumble_lora_1.inputs.strength_model !== 0.7) throw new Error("the chain: " + JSON.stringify(g.scumble_lora_1));
// a Klein 9B one under the same recipe: grey
S.headers["klein\\nyc_style.safetensors"] = { keyCount: 224, modules: ["diffusion_model.double_blocks.N.img_attn.proj", "diffusion_model.single_blocks.N.linear1"], blocks: { double_blocks: range8(), single_blocks: Array.from({ length: 24 }, (_, i) => i) }, width: { double_blocks: 4096, single_blocks: 4096 }, outs: { double_blocks: [4096], single_blocks: [4096, 36864] }, metadata: {} };
host._loraInfo.clear();
host.loras = { flux2_klein_local: [{ name: "klein\\nyc_style.safetensors", strength: 1, on: true }] };
panel.renderAll(host);
if (!(await until(() => hintOf(0) && hintOf(0).text === "looks like FLUX.2 Klein 9B"))) throw new Error("the Klein 9B line: " + JSON.stringify(hintOf(0)));
if (hintOf(0).amber) throw new Error("a Klein 9B LoRA is amber under FLUX.2 Klein");
host.objectInfo = OI();
host.setRecipe(klein3);
return { amber: a.text.slice(0, 60), flux1: b.text.slice(0, 60), queued: q.id };
function range8() { return Array.from({ length: 8 }, (_, i) => i); }
"""),
    ("hint_read_once_per_server_and_name", r"""
const ed = ednow(window.__lr);
host.setRecipe(klein3);
host._loraInfo.clear();
S.headerAsks = 0; S.metaAsks = 0;
host.loras = { flux3_klein_local: [{ name: "Flux_3\\Flux3_Targa.safetensors", strength: 0.8, on: true }] };
panel.renderAll(host);
await until(() => host.loraInfo("Flux_3\\Flux3_Targa.safetensors"));
panel.renderAll(host); panel.renderAll(host);
await wait(80);
if (S.headerAsks !== 1) throw new Error("asked " + S.headerAsks + " times for one name");
// a look without reading (the picker's family group) never asks
if (host.loraInfo("qwen\\NYC_Qwen.safetensors", { read: false }) !== null || S.headerAsks !== 1) throw new Error("a look read the file");
// another server: read again (the hints are the server's)
const url0 = host.server.url;
host.server = { ...host.server, url: "http://127.0.0.1:8190" };
panel.renderAll(host);
await until(() => S.headerAsks === 2);
host.server = { ...host.server, url: url0 };
if (S.headerAsks !== 2) throw new Error("another server did not read again: " + S.headerAsks);
return { asks: S.headerAsks };
"""),
    ("hint_the_picker_shows_the_recipes_family_first", r"""
const ed = ednow(window.__lr);
host.objectInfo = OI();
S.reread = "list"; S.rereadNames = NAMES;
host.setRecipe(klein3);
host.loras = { flux3_klein_local: [{ name: "Flux_3\\Flux3_Targa.safetensors", strength: 0.8, on: true }, { name: "klein\\nyc_style.safetensors", strength: 1, on: true }] };
panel.renderAll(host);
P(ed).section.open = true;
const folders = (st) => Array.from(st.el.querySelectorAll(".ipc-lp-group .ipc-lp-folder")).map((g) => g.textContent);
const more = (st) => st.el.querySelector(".ipc-lp-more");
nameBtn(ed, 0).click();
let st = panel.openPickerState();
await wait(80);
st = panel.openPickerState();
if (JSON.stringify(folders(st)) !== '["Flux_3"]' || !more(st) || more(st).textContent !== "Show all (3 more in 3 other folders)") throw new Error("the family group: " + JSON.stringify({ folders: folders(st), more: more(st) && more(st).textContent }));
if (st.rows().length !== 1 || st.cursor.name !== "Flux_3\\Flux3_Targa.safetensors") throw new Error("the rows: " + st.rows().length);
more(st).click();
st = panel.openPickerState();
if (!st || JSON.stringify(folders(st)) !== '["Flux_3","klein","qwen","(root)"]' || more(st).textContent !== "Only the FLUX 3 folders" || st.rows().length !== NAMES.length) throw new Error("Show all: " + JSON.stringify(st && { folders: folders(st), more: more(st).textContent }));
if (document.activeElement !== st.search) throw new Error("Show all took the focus from the search");
more(st).click();
st = panel.openPickerState();
if (JSON.stringify(folders(st)) !== '["Flux_3"]') throw new Error("back: " + JSON.stringify(folders(st)));
// a search that finds nothing in the family's folders shows what it finds
typeIn(st.search, "nyc");
st = panel.openPickerState();
if (JSON.stringify(folders(st)) !== '["klein","qwen"]' || more(st)) throw new Error("the search: " + JSON.stringify(folders(st)));
key(st.search, "Escape");
// a row whose file sits outside the family's folders: every folder at open, its own name under the cursor
nameBtn(ed, 1).click();
await wait(80);
st = panel.openPickerState();
if (JSON.stringify(folders(st)) !== '["Flux_3","klein","qwen","(root)"]' || st.cursor.name !== "klein\\nyc_style.safetensors") throw new Error("a row outside: " + JSON.stringify({ folders: folders(st), cursor: st.cursor && st.cursor.name }));
key(st.search, "Escape");
return { family: ["Flux_3"], all: NAMES.length };
"""),
    ("cleanup", r"""
S.restore();
if (window.__lrStore) { await window.scumble.settings.set({ recipeLoras: window.__lrStore }); window.__lrStore = null; }
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
