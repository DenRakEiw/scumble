""".scumble documents, the steps of the window (docs/PLAN_DOCUMENTS.md §7 D5, steps 9, 10 and 12), against the running app.

    python tools/document_ux_test.py [--out DIR]

Start the app first (tools/cdp.py; `tools/run_gates.sh <label> --offline docux` does it on a fresh profile). No
ComfyUI, no key. The dialogs are answered by replacing `host.askDocument` / `host.chooseDocumentPath` in the page.

 9. dirty_clean_undo - a document with a picture and no file is changed; clean after Save; changed after a fill;
    clean after Save; changed after another fill, clean again after its undo once the layer is uploaded;
10. close_asks_and_reopen - a clean tab with a file closes without a question and Reopen Closed Tab brings it back
    clean with its file and the same pixels; a changed tab asks: Cancel keeps it, Don't Save closes it, and it comes
    back still changed with its change; Save saves and closes; the bundle keeps the closed tabs;
10b. the_history_question - a Save As of a document with results asks with or without the history; "without" leaves
    the history out of the file and the next Ctrl+S keeps it out without asking; a changed file on disk asks first;
12. commands_and_argv - save_document and open_document through the command core (errors, Save As, copy, in place,
    an open that activates, an open with activate false), list_documents' file and dirty; a second start of the app
    with a .scumble path on its command line opens it in this instance.
"""
import asyncio
import json
import os
import subprocess
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
from cdp import session  # noqa: E402

OUT = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else os.path.join(os.environ.get("SCUMBLE_GATES", os.path.join(ROOT, "dist", "gates")), "docux")
ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")

PRE = r"""
(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const sh = await import("./shell.js");
    const { host } = await import("./editor/host.js");
    const C = sh.commands;
    const must = async (name, args) => { const r = await C.call(name, args || {}); if (!r.ok) throw new Error(name + ": " + r.error); return r.result; };
    const dir = __DIR__;
    // the autosave (1.5 s) recomputes the state's key; a save in flight first
    const settle = async (ed) => { for (let i = 0; i < 100 && ed._docSaving; i++) await wait(100); await wait(1800); };
    const fp = (ed) => { const L = ed.layers.find((l) => l.kind === "paint"); if (!L) return ""; const d = L.px.readRect(0, 0, Math.min(200, L.px.width), Math.min(120, L.px.height)).data; let h = 0; for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) >>> 0; return String(h); };
    if (!window.__askLog) {
        window.__askLog = []; window.__answers = [];
        host.askDocument = async (q) => { window.__askLog.push(q.kind); return window.__answers.shift() || "cancel"; };
    }
    const asked = () => window.__askLog.splice(0);
    const answer = (...a) => { window.__answers = a; };
    __BODY__
})()
"""

DIRTY = r"""
    const ed = sh.newDocument(); sh.activate(ed);
    await must("new_canvas", { doc: ed.node.id, width: 480, height: 320 });
    await settle(ed);
    const out = { noFile: host.documentDirty(ed) };
    await host.saveDocument(ed, { path: dir + "/ux_a.scumble" }); await settle(ed);
    out.afterSave = !host.documentDirty(ed);
    await must("add_paint_layer", { doc: ed.node.id });
    await must("select_rect", { doc: ed.node.id, x: 20, y: 20, w: 60, h: 60 });
    ed.fillSelection();
    out.afterFill = host.documentDirty(ed);
    await host.saveDocument(ed, {}); await settle(ed);
    out.afterSecondSave = !host.documentDirty(ed);
    await must("select_rect", { doc: ed.node.id, x: 120, y: 60, w: 50, h: 40 });
    ed.fillSelection(); await settle(ed);
    out.afterSecondFill = host.documentDirty(ed);
    ed.undoStep();
    await must("select_rect", { doc: ed.node.id, x: 20, y: 20, w: 60, h: 60 });
    await ed.syncLayers(); await settle(ed);
    out.afterUndo = !host.documentDirty(ed);
    out.tiles = !!ed.tileMode;
    // the canvas backend encodes the layer through createImageBitmap: fully transparent pixels can come back with other
    // colour bytes, so the same visible pixels hash to another file name and the tab stays marked (docs/PLAN_DOCUMENTS.md
    // D3); saved here so the next steps start from a clean tab
    if (!out.afterUndo) { await host.saveDocument(ed, {}); await settle(ed); }
    out.tab = Array.from(document.querySelectorAll(".shell-tab.active .shell-tab-name")).map((n) => n.textContent)[0];
    window.__uxA = ed.node.id;
    return out;
"""

CLOSE = r"""
    let ed = host.editorById(window.__uxA);
    const pixels = fp(ed);
    asked();
    const clean = await sh.closeDocument(ed);
    const out = { cleanClosedSilently: clean === true && asked().length === 0, bundleClosed: host.bundle().closed.length };
    ed = await host.reopenClosed(); await settle(ed);
    out.reopened = { file: ed.docFile && ed.docFile.name, clean: !host.documentDirty(ed), samePixels: fp(ed) === pixels };
    await must("add_text", { doc: ed.node.id, text: "unsaved", x: 30, y: 30, size: 20 });
    await settle(ed);
    answer("cancel");
    const kept = await sh.closeDocument(ed);
    answer("discard");
    const gone = await sh.closeDocument(ed);
    out.dirty = { cancelKept: kept === false, discardClosed: gone === true, asked: asked() };
    ed = await host.reopenClosed(); await settle(ed);
    out.reopenedDirty = { dirty: host.documentDirty(ed), text: ed.layers.some((l) => l.kind === "text") };
    answer("save");
    const saved = await sh.closeDocument(ed);
    out.saveAndClose = { closed: saved === true, asked: asked() };
    const again = await host.openDocument(dir + "/ux_a.scumble");
    await settle(again.editor);
    out.savedHasText = again.editor.layers.some((l) => l.kind === "text") && !host.documentDirty(again.editor);
    window.__uxA = again.editor.node.id;
    return out;
"""

HISTORY = r"""
    const ed = host.editorById(window.__uxA);
    ed.history.push({ key: "k-ux", name: "r", ref: ed.base.ref, x: 0, y: 0, w: 10, h: 10, prompt: "a secret prompt", time: 1 });
    asked();
    host.chooseDocumentPath = async () => dir + "/ux_b.scumble";
    answer("without");
    const r = await host.saveDocument(ed, { as: true });
    const out = { asked: asked(), saved: !!r, remembered: ed.docFile && ed.docFile.history === false };
    await host.saveDocument(ed, {});
    out.ctrlSAsked = asked();
    await settle(ed);
    ed.docFile.mtime -= 5000;                   // the file "changed on disk"
    answer("cancel");
    const c = await host.saveDocument(ed, {});
    out.changed = { asked: asked(), cancelled: c === null };
    ed.docFile.mtime += 5000;
    return out;
"""

COMMANDS = r"""
    const out = {};
    const nd = await must("new_document", {});
    const id = nd.id;
    await must("new_canvas", { doc: id, width: 300, height: 200 });
    out.noPath = (await C.call("save_document", { doc: id })).error || "no error";
    out.badExt = (await C.call("save_document", { doc: id, path: dir + "/x.png" })).error || "no error";
    const s1 = await must("save_document", { doc: id, path: dir + "/ux_c.scumble" });
    out.saveAs = { file: s1.document.file && s1.document.file.split(/[\\/]/).pop(), dirty: s1.document.dirty };
    const s2 = await must("save_document", { doc: id, path: dir + "/ux_c_copy.scumble", copy: true });
    out.copyKeepsTheTabsFile = host.editorById(id).docFile.name === "ux_c.scumble" && /ux_c_copy/.test(s2.path);
    out.inPlace = (await must("save_document", { doc: id })).path.split(/[\\/]/).pop();
    const o1 = await must("open_document", { path: dir + "/ux_c.scumble" });
    out.openActivates = o1.already === true && o1.id === id;
    const o2 = await must("open_document", { path: dir + "/ux_c_copy.scumble", activate: false });
    out.openCopy = { already: o2.already, activeStayed: host.editor.node.id !== o2.id, dirty: o2.dirty };
    const ls = await must("list_documents", {});
    out.listed = (ls.documents || ls).filter((d) => d.file).map((d) => `${d.file.split(/[\\/]/).pop()}${d.dirty ? "*" : ""}`);
    const info = await window.scumble.info();
    out.userData = info.userData;
    return out;
"""

AFTER_ARGV = r"""
    const find = () => host.editors().find((x) => x.docFile && x.docFile.name === "ux_b.scumble");
    for (let i = 0; i < 150; i++) { const f = find(); if (f && f.base && !f._loading && host.editor === f) break; await wait(100); }
    const e = find();
    return { opened: !!e, active: !!e && host.editor === e, status: e ? e.status : null };
"""


def step(results, name, ok, detail=""):
    results.append(ok)
    print(f"[{'ok' if ok else 'FAIL'}] {name}{(': ' + json.dumps(detail)) if detail != '' else ''}", flush=True)


async def run(c):
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith(".scumble"):
            os.remove(os.path.join(OUT, f))
    d = json.dumps(OUT.replace("\\", "/"))
    ev = lambda body: c.eval(PRE.replace("__DIR__", d).replace("__BODY__", body), timeout=300)  # noqa: E731
    results = []
    t0 = time.time()

    r = await ev(DIRTY)
    step(results, "dirty_clean_undo", r["noFile"] and r["afterSave"] and r["afterFill"] and r["afterSecondSave"] and r["afterSecondFill"] and (r["afterUndo"] or not r["tiles"]) and r["tab"] == "ux_a", r)

    r = await ev(CLOSE)
    ok = (r["cleanClosedSilently"] and r["bundleClosed"] >= 1 and r["reopened"]["file"] == "ux_a.scumble" and r["reopened"]["clean"] and r["reopened"]["samePixels"]
          and r["dirty"]["cancelKept"] and r["dirty"]["discardClosed"] and r["dirty"]["asked"] == ["close", "close"]
          and r["reopenedDirty"]["dirty"] and r["reopenedDirty"]["text"] and r["saveAndClose"]["closed"] and r["saveAndClose"]["asked"] == ["close"] and r["savedHasText"])
    step(results, "close_asks_and_reopen", ok, r)

    r = await ev(HISTORY)
    ok = r["asked"] == ["history"] and r["saved"] and r["remembered"] and r["ctrlSAsked"] == [] and r["changed"]["asked"] == ["changed"] and r["changed"]["cancelled"]
    with zipfile.ZipFile(os.path.join(OUT, "ux_b.scumble")) as z:
        doc = json.loads(z.read("scumble/document.json"))
        no_history = doc["document"].get("history") == [] and "a secret prompt" not in json.dumps(doc)
    step(results, "the_history_question", ok and no_history, {**r, "fileHasNoHistory": no_history})

    r = await ev(COMMANDS)
    ok = ("pass path" in r["noPath"] and ".scumble" in r["badExt"] and r["saveAs"] == {"file": "ux_c.scumble", "dirty": False} and r["copyKeepsTheTabsFile"]
          and r["inPlace"] == "ux_c.scumble" and r["openActivates"] and r["openCopy"]["already"] is False and r["openCopy"]["activeStayed"] and not r["openCopy"]["dirty"]
          and "ux_c.scumble" in r["listed"] and "ux_c_copy.scumble" in r["listed"])
    user_data = r.pop("userData")
    step(results, "commands", ok, r)

    # a second start with a path: close ux_b first so the open is new, then start the app again on this profile
    await c.eval("(async () => { const sh = await import('./shell.js'); const { host } = await import('./editor/host.js'); for (const e of host.editors().filter((x) => x.docFile && x.docFile.name === 'ux_b.scumble')) await sh.closeDocument(e, { force: true }); return 1; })()")
    exe = os.environ.get("SCUMBLE_EXE")
    cmd = ([exe] if exe else [ELECTRON, "."]) + [f"--user-data-dir={user_data}", os.path.join(OUT, "ux_b.scumble")]
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, timeout=60)
    r = await ev(AFTER_ARGV)
    step(results, "a_second_start_with_a_path_opens_it_here", p.returncode == 0 and r["opened"] and r["active"], {**r, "exit": p.returncode})

    ok = all(results)
    print(f"{'PASS' if ok else 'FAIL'}: {sum(results)} of {len(results)} steps in {time.time() - t0:.0f} s", flush=True)
    return ok


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(session(run)) else 1)
