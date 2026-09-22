"""Opening PSD and ORA files with their layers (renderer/editor/inpaint_layered.js, the editor's loadLayered).

No ComfyUI, no key. First `node tools/layered_test.js` (the reader on files built byte by byte), then the app:

- the round trip: a document with a base and three layers (offset, multiply at half opacity, hidden, a half
  transparent edge) saved as PSD and as ORA through the `export` command, then opened with `load_image`: the same
  size, the base's bytes, every layer's name, box, opacity, visibility, blend and bytes;
- a file whose bottom layer does not cover the picture opens over a transparent base, its mask applied and its
  hidden group hidden, with the notes in the status line;
- a PSD dropped on an open document adds its layers (the bottom one included) where the file has them;
- a file named .png that is a PSD is still read as one (the first bytes decide); the layers reach the local store
  (`syncLayers`), so autosave keeps them.

    python tools/layered_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="scumble_layered_")
J = lambda p: json.dumps(os.path.join(TMP, p).replace("\\", "/"))  # noqa: E731

# the layers' bytes, read through the backend, and how far two sets of them are apart
HELP = """
const bytesOf = (px, w, h) => Array.from(px.readRect(0, 0, w, h).data);
const far = (a, b) => { if (a.length !== b.length) return 999; let m = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; } return m; };
const shape = (l) => ({ name: l.name, x: l.x, y: l.y, w: l.w, h: l.h, opacity: Math.round((l.opacity ?? 1) * 255), visible: l.visible !== false, blend: l.blend || "normal" });
"""

STEPS = [
    ("setup_a_document_with_layers", """
const d = await run("new_document");
window.__l = { src: d.id };
const ed = ednow(d.id);
host.shell.activate(ed);
const c = document.createElement("canvas");
c.width = 160; c.height = 100;
const g = c.getContext("2d");
for (let x = 0; x < 160; x += 4) { g.fillStyle = `rgb(${x}, ${255 - x}, 80)`; g.fillRect(x, 0, 4, 100); }
await ed.setBaseFromCanvas(c);
const mk = (w, h, draw) => { const k = document.createElement("canvas"); k.width = w; k.height = h; draw(k.getContext("2d")); return ed.pixels.Layer.fromCanvas(k); };
const a = ed.addLayer({ name: "Offset opaque", kind: "image", ref: null, px: mk(30, 20, (x) => { x.fillStyle = "#c83214"; x.fillRect(0, 0, 30, 20); x.fillStyle = "#1464c8"; x.fillRect(10, 5, 10, 10); }), x: 12, y: 7, w: 30, h: 20, dirty: true });
const b = ed.addLayer({ name: "Multiply half", kind: "image", ref: null, px: mk(40, 30, (x) => { x.fillStyle = "#80ff40"; x.fillRect(0, 0, 40, 30); }), x: 100, y: 60, w: 40, h: 30, opacity: 128 / 255, blend: "multiply", dirty: true });
const h = ed.addLayer({ name: "Hidden \\u00e4\\u00f6\\u00fc", kind: "image", ref: null, px: mk(20, 20, (x) => { x.fillStyle = "#ffffff"; x.fillRect(0, 0, 20, 10); }), x: 60, y: 40, w: 20, h: 20, visible: false, dirty: true });
window.__l.layers = ed.layers.map((l) => ({ ...shape(l), bytes: bytesOf(l.px, l.w, l.h) }));
window.__l.base = bytesOf(ed.basePx, 160, 100);
await run("export", { doc: d.id, format: "psd", path: %(PSD)s });
await run("export", { doc: d.id, format: "ora", path: %(ORA)s });
return { layers: window.__l.layers.map((l) => l.name) };
"""),
    ("a_psd_opens_with_its_layers", """
const d = await run("new_document");
window.__l.psd = d.id;
await run("load_image", { doc: d.id, path: %(PSD)s });
const ed = ednow(d.id);
if (ed.width !== 160 || ed.height !== 100) throw new Error("size " + ed.width + "x" + ed.height);
const bf = far(bytesOf(ed.basePx, 160, 100), window.__l.base);
if (bf > 0) throw new Error("the base is not the Background's bytes (" + bf + " levels off)");
if (ed.layers.length !== 3) throw new Error("layers: " + ed.layers.map((l) => l.name).join(", "));
const out = [];
for (let i = 0; i < 3; i++) {
    const want = window.__l.layers[i], got = ed.layers[i];
    const a = JSON.stringify({ ...want, bytes: undefined }), b = JSON.stringify(shape(got));
    if (a !== b) throw new Error("layer " + i + ": " + b + " instead of " + a);
    const f = far(bytesOf(got.px, got.w, got.h), want.bytes);
    if (f > 0) throw new Error(`the pixels of ${got.name} are ${f} levels off`);
    if (got.kind !== "image" || !got.dirty) throw new Error("an opened layer is not a dirty image layer: " + got.kind);
    out.push(got.name);
}
if (ed.activeLayerId !== ed.layers[2].id) throw new Error("the top layer is not the active one");
if (!/Opened .*3 layers over "Background" as the base/.test(ed.status)) throw new Error("status: " + ed.status);
if (ed.undo.length) throw new Error("opening left undo steps: " + ed.undo.length);
// the layers reach the local store, so autosave and a restart keep them
await ed.syncLayers();
if (ed.layers.some((l) => !l.ref)) throw new Error("a layer has no file in the local store after syncLayers");
return { layers: out, status: ed.status };
"""),
    ("an_ora_opens_with_its_layers", """
const d = await run("new_document");
window.__l.ora = d.id;
await run("load_image", { doc: d.id, path: %(ORA)s });
const ed = ednow(d.id);
if (ed.width !== 160 || ed.height !== 100) throw new Error("size " + ed.width + "x" + ed.height);
const bf = far(bytesOf(ed.basePx, 160, 100), window.__l.base);
if (bf > 0) throw new Error("the base is " + bf + " levels off");
if (ed.layers.length !== 3) throw new Error("layers: " + ed.layers.map((l) => l.name).join(", "));
for (let i = 0; i < 3; i++) {
    const want = window.__l.layers[i], got = ed.layers[i];
    const w = { ...want, bytes: undefined, opacity: undefined }, s = { ...shape(got), opacity: undefined };
    if (JSON.stringify(w) !== JSON.stringify(s)) throw new Error("layer " + i + ": " + JSON.stringify(s) + " instead of " + JSON.stringify(w));
    // ORA writes the opacity with three decimals
    if (Math.abs(got.opacity * 255 - want.opacity) > 0.5) throw new Error("opacity of " + got.name + ": " + got.opacity);
    const f = far(bytesOf(got.px, got.w, got.h), want.bytes);
    if (f > 0) throw new Error(`the pixels of ${got.name} are ${f} levels off`);
}
return { layers: ed.layers.map((l) => l.name), status: ed.status };
"""),
    ("a_file_without_a_covering_bottom_opens_over_a_transparent_base", """
const d = await run("new_document");
await run("load_image", { doc: d.id, path: %(LOOSE_PSD)s });
const ed = ednow(d.id);
if (ed.width !== 40 || ed.height !== 30) throw new Error("size " + ed.width + "x" + ed.height);
const base = bytesOf(ed.basePx, 40, 30);
if (base.some((v, i) => i %% 4 === 3 && v !== 0)) throw new Error("the base is not transparent");
const names = ed.layers.map((l) => l.name);
if (JSON.stringify(names) !== JSON.stringify(["Corner", "Hidden inside", "Masked"])) throw new Error("layers: " + names.join(", "));
const [corner, hidden, masked] = ed.layers;
if (corner.x !== 3 || corner.y !== 2 || corner.w !== 10 || corner.h !== 8) throw new Error("Corner's box: " + JSON.stringify(shape(corner)));
if (hidden.visible !== false || corner.visible === false) throw new Error("the hidden group did not hide its layer only");
const m = bytesOf(masked.px, 20, 30);
const alpha = (x, y) => m[(y * 20 + x) * 4 + 3];
if (alpha(2, 5) !== 255 || alpha(15, 5) !== 0) throw new Error("the mask was not applied: " + alpha(2, 5) + " / " + alpha(15, 5));
if (!/1 layer mask applied/.test(ed.status) || !/1 group flattened/.test(ed.status) || /as the base/.test(ed.status)) throw new Error("status: " + ed.status);
// the ORA of the same shape: its bottom layer does not cover the picture either; screen at half opacity comes back
await run("load_image", { doc: d.id, path: %(LOOSE_ORA)s });
const o = ednow(d.id);
const on = o.layers.map((l) => `${l.name}@${l.x},${l.y} ${l.w}x${l.h} ${l.blend} ${Math.round(l.opacity * 100)}`);
if (JSON.stringify(on) !== JSON.stringify(["Corner@3,2 10x8 normal 100", "Right@25,4 6x7 screen 50"])) throw new Error("ORA layers: " + on.join(" | "));
if (bytesOf(o.basePx, 40, 30).some((v, i) => i %% 4 === 3 && v !== 0)) throw new Error("the ORA's base is not transparent");
const red = bytesOf(o.layers[0].px, 10, 8).slice(0, 4);
if (red.join() !== "255,0,0,255") throw new Error("the ORA layer's pixels: " + red);
await run("close_document", { doc: d.id });
return { psd: names, ora: on, status: ed.status };
"""),
    ("a_psd_dropped_on_a_document_adds_its_layers", """
const ed = ednow(window.__l.src);
host.shell.activate(ed);
const n = ed.layers.length;
const r = await window.scumble.file.read(%(PSD)s);
// named .png, typed image/png: the first bytes decide
await ed.addImageLayers([new File([r.data], "not_really.png", { type: "image/png" })], "none", { place: "at", at: [5, 5] });
const added = ed.layers.slice(n);
const names = added.map((l) => l.name);
if (JSON.stringify(names) !== JSON.stringify(["Background", "Offset opaque", "Multiply half", "Hidden \\u00e4\\u00f6\\u00fc"])) throw new Error("added: " + names.join(", "));
if (added[1].x !== 12 || added[1].y !== 7) throw new Error("the layers are not where the file has them: " + added[1].x + "," + added[1].y);
if (ed.activeLayerId !== added[3].id) throw new Error("the top added layer is not active");
if (!/4 layers of not_really.png added/.test(ed.status)) throw new Error("status: " + ed.status);
if (ed.width !== 160) throw new Error("the drop changed the document");
return { added: names, status: ed.status };
"""),
    ("a_broken_file_says_why_and_keeps_the_tab", """
const ed = ednow(window.__l.psd);
const n = ed.layers.length;
let msg = "";
try { await run("load_image", { doc: window.__l.psd, path: %(BROKEN)s }); } catch (err) { msg = String(err.message || err); }
if (!/ends early/.test(msg)) throw new Error("a truncated PSD: " + (msg || "no error"));
if (ed.width !== 160 || ed.layers.length !== n) throw new Error("the failed open changed the tab");
return { message: msg };
"""),
    ("cleanup", """
for (const k of ["psd", "ora", "src"]) { try { if (window.__l && window.__l[k]) await run("close_document", { doc: window.__l[k] }); } catch (_) { /* gone */ } }
return true;
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


def node_step():
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "layered_test.js")], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120)
    tail = r.stdout.strip()   # stderr carries Node's note that it read the editor file as an ES module
    if r.returncode != 0 or not tail.endswith("PASS"):
        raise Exception("tools/layered_test.js: " + (tail + r.stderr)[-1500:])
    subprocess.run(["node", os.path.join(ROOT, "tools", "layered_test.js"), "--write-fixtures", TMP], cwd=ROOT, check=True, capture_output=True, timeout=60)
    return {"checks": tail.count("[ok]")}


async def run_all(c):
    ok = True
    try:
        print("[ok] node: %s" % json.dumps(node_step()))
    except Exception as err:  # noqa: BLE001
        print("[FAIL] node: %s" % err)
        print("FAIL")
        return False
    subs = {"PSD": J("roundtrip.psd"), "ORA": J("roundtrip.ora"), "LOOSE_PSD": J("loose.psd"), "LOOSE_ORA": J("loose.ora"), "BROKEN": J("broken.psd")}
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    for name, body in STEPS:
        if name == "a_broken_file_says_why_and_keeps_the_tab":
            with open(os.path.join(TMP, "roundtrip.psd"), "rb") as f:
                data = f.read()
            with open(os.path.join(TMP, "broken.psd"), "wb") as f:
                f.write(data[: len(data) // 3])
        try:
            res = await c.eval(PRE % (HELP, body % subs), timeout=240)
            print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:300]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            if name != "cleanup":
                try:
                    await c.eval(PRE % (HELP, STEPS[-1][1]), timeout=60)
                except Exception:  # noqa: BLE001
                    pass
            break
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    shutil.rmtree(TMP, ignore_errors=True)
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
