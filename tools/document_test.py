""".scumble documents (docs/PLAN_DOCUMENTS.md §7 "D5. The full tier"): the app gate `document`.

No ComfyUI and no key: every instance starts with --no-comfy on its own profile and port (SCUMBLE_CDP_PORT + 17 by
default), and this gate starts and ends each of them itself (WM_CLOSE, or a kill where the step is the kill). First
`node tools/document_test.js` (the container in plain Node), then the app:

 1. every_kind_round_trips - a document with a base, a paint layer (a fill and a half-transparent fill), an image
    layer placed smaller than its pixels with a mask, a reference and a control layer (set_layer role), a text layer in
    a user font, a loopback result with a mask and colour match (and so a result history), curves, grain and a film
    filter, a 3D object with its depth layer (glb.place), the AI label, a hidden, a locked and an alpha-locked layer,
    blend modes, two saved selections, a feathered selection, guides, prompt, negative, generation and crop settings.
    Saved, closed, opened: getValue() equal; every layer's, mask's and the base's pixels and the selection equal to a
    restore of the saved state from the mirror (the autosave's path), and within one level of the live document on
    partly transparent pixels only (the PNG round trip of the mirror, not the file); the flatten likewise; glb.info
    equal and glb.edit working. The file read by Python's zipfile: testzip() clean, `mimetype` first, stored, no extra
    field, every entry stored, the entries = the header's list, each entry byte-equal to its mirror file, a thumbnail of
    at most 256 px;
 2. opens_in_a_fresh_profile - the same file in a second instance with an empty profile: the same state and pixels,
    every file imported byte for byte, glb.edit works (the file is self-contained);
 3. reopen_copies_nothing - closed and opened again in the first profile: no file added to the mirror (and main's
    open reports nothing imported);
 4. a_colliding_name_is_renamed - a different picture under the base's mirror name, and one of the SAME SIZE and other
    bytes under an image layer's name, already in the fresh profile's mirror and in use there: the open imports both
    under free names ("photo (1).png"), the refs follow, and both documents keep their own pixels;
 5. a_save_in_place_is_atomic - while a large save runs, Python reads the target again and again (a handle that lets
    the rename through): every read gives the old bytes until the rename, then the new;
 6. cancel_leaves_the_old_file and disk_full_leaves_the_old_file - a cancel mid-write (documents.onProgress ->
    documents.cancel), and the disk-full hook in the fresh profile's instance (SCUMBLE_DOC_FAULT=enospc@<bytes>, read
    by dev builds only, so skipped with --exe): the target unchanged, no temporary file left, the tab's file record
    unchanged;
 7. a_kill_mid_save_keeps_the_old_file - the process killed while the temporary file grows: the target byte-identical;
    the next start deletes the temporary file (document-temps.json) and restores the session;
 8. a_close_waits_for_the_save - WM_CLOSE during a save: the process ends after the rename, the file is complete and
    opens (in the next start, with the saved pixels);
11. newer_documents - files crafted from a saved one (document.json rewritten, `mimetype` first, every entry stored):
    `minReader: 2` is refused with nothing imported; `version: 2, minReader: 1` with a layer of an unknown kind (with a
    ref), an unknown filter id, an unknown top-level field and an unknown plugin's data (with a ref) opens with a note,
    and all four come back unchanged in the next save.

(Steps 9, 10 and 12 of the plan need D3 and D4.) The order is the instances': the first profile runs 1, 3, 11, 5, 6
(cancel) and 7 (killed), its next start 7 (the sweep) and 8 (closed), its third start the open of 8; the fresh
profile 2, 4 and 6 (disk full).

    python tools/document_test.py [--exe PATH] [--port 9572] [--out DIR] [--big 6000x4000] [--no-node] [--keep]

The backend is the environment's (SCUMBLE_TILES, which tools/run_gates.sh --tiles sets). `--big` is the picture of
the slow save of steps 5 to 8 (a noise PNG, stored three times in the document).
"""
import argparse
import asyncio
import ctypes
import glob
import hashlib
import json
import msvcrt
import os
import random
import shutil
import struct
import subprocess
import sys
import threading
import time
import zipfile
import zlib
from ctypes import wintypes

import aiohttp

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
from cdp import HOOK, Cdp  # noqa: E402
from glb_test import cube_glb  # noqa: E402
from quit_test import close_window  # noqa: E402

ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
MIME = b"application/x-scumble"

PRE = """(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const shell = await import('./shell.js');
    const host = (await import('./editor/host.js')).host;
    const G = window.__dg || (window.__dg = {});
    const must = async (n, a) => { const r = await shell.commands.call(n, a || {}); if (!r.ok) throw new Error(n + ": " + r.error); return r.result; };
    const settle = async (ed, ms = 120000) => {
        for (const until = Date.now() + ms; (ed._loading || !ed.base) && Date.now() < until;) await wait(100);
        if (!ed.base) throw new Error("the document did not load: " + ed.status);
        await wait(300);
    };
    const same = (p, q) => String(p || "").replace(/\\\\/g, "/").toLowerCase() === String(q || "").replace(/\\\\/g, "/").toLowerCase();
    const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
    const H = async (d) => hex(await crypto.subtle.digest("SHA-256", d.slice()));
    /** A pixel store's hash ("WxH:sha"); its bytes into raw[key] when asked. */
    const pxInfo = async (px, raw = null, key = "") => {
        if (!px) return null;
        const d = px.readRect(0, 0, px.width, px.height).data;
        if (raw) raw[key] = d.slice();
        return px.width + "x" + px.height + ":" + await H(d);
    };
    /** The whole flatten, read until two reads agree (colour match statistics and filters settle after a load). */
    const flatten = async (ed) => {
        let last = null, d = null;
        for (let i = 0; i < 20; i++) {
            d = ed.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(0, 0, ed.width, ed.height).data;
            const h = await H(d);
            if (h === last) break;
            last = h;
            await wait(300);
        }
        return { hash: last, data: d };
    };
    /** Everything a document must bring back: its state, every layer's, mask's and the base's pixels, the selection, the flatten, the 3D objects. */
    const snap = async (ed, raw = null, { glb = true } = {}) => {
        const layers = [];
        for (const l of ed.layers) {
            layers.push({ id: l.id, name: l.name, kind: l.kind, px: l.kind === "filter" ? null : await pxInfo(l.px, raw, l.id), mask: await pxInfo(l.maskPx, raw, l.id + ":mask") });
        }
        const f = await flatten(ed);
        if (raw) raw.flat = f.data;
        return {
            state: ed.getValue(), layers, base: await pxInfo(ed.basePx, raw, "base"), sel: await pxInfo(ed.sel, raw, "sel"), flat: f.hash,
            glb: glb ? (await must("glb.info", { doc: ed.node.id })).objects : null,
            plugins: JSON.stringify(ed.pluginData || {}), docFile: ed.docFile ? { ...ed.docFile } : null, tiles: !!ed.tileMode,
        };
    };
    /** Two pixel arrays: pixels that differ (transparent in both counts as equal), the largest step, and how many of them are fully opaque. */
    const cmpRaw = (x, y) => {
        if (!x || !y || x.length !== y.length) return { n: -1, max: 999, solid: -1 };
        let n = 0, max = 0, solid = 0;
        for (let i = 0; i < x.length; i += 4) {
            if (x[i + 3] === 0 && y[i + 3] === 0) continue;
            let d = 0;
            for (let k = 0; k < 4; k++) { const v = Math.abs(x[i + k] - y[i + k]); if (v > d) d = v; }
            if (d) { n++; if (d > max) max = d; if (x[i + 3] === 255 && y[i + 3] === 255) solid++; }
        }
        return { n, max, solid };
    };
    const ed4 = (id) => { const e = host.editorById(id); if (!e) throw new Error("no document " + id + " (open: " + host.editors().map((x) => x.node.id).join(", ") + ")"); return e; };
    __BODY__
})()"""

# ---- step 1: the document with every kind of content ------------------------------------------------------------------

BUILD = """
let ed = shell.newDocument(); shell.activate(ed);
await must("new_canvas", { width: 1200, height: 800 });
ed = host.editor;
G.every = { id: ed.node.id };
const fill = (layerId, color, opacity = 1) => { ed.activeLayerId = layerId; ed.color = color; ed.brushOpacity = opacity; ed.fillSelection(); ed.brushOpacity = 1; };
await must("set_prompt", { text: "every kind of content", negative: "blurry, low quality" });
// a paint layer: a solid fill and a half-transparent one (its partly transparent pixels go through the PNG round trip)
const paint = await must("add_paint_layer", { name: "paint" });
await must("select_rect", { x: 100, y: 120, w: 300, h: 200 });
fill(paint.id, "#20c040");
await must("select_rect", { x: 450, y: 120, w: 120, h: 200 });
fill(paint.id, "#3050ff", 0.5);
// an image layer placed smaller than its pixels, with a mask
const img = await must("add_image_layer", { path: G.dir + "/img.png", x: 600, y: 50 });
await must("set_layer", { layer: img.id, name: "image", w: 200, h: 150 });
await must("select_rect", { x: 620, y: 60, w: 100, h: 80 });
ed.maskFromSelection(ed.layers.find((l) => l.id === img.id));
// a reference and a control layer, both by set_layer role
const refl = await must("add_image_layer", { path: G.dir + "/img.png", x: 20, y: 20, width: 160 });
await must("set_layer", { layer: refl.id, name: "reference", role: "reference" });
const ctl = await must("add_paint_layer", { name: "control" });
await must("select_rect", { x: 40, y: 600, w: 200, h: 150 });
fill(ctl.id, "#ffffff");
await must("set_layer", { layer: ctl.id, role: "control" });
// a text layer in a user font (a bundled font added as the user's own)
const text = await must("add_text", { text: "Scumble gate", x: 80, y: 470, size: 64, color: "#c4643a", name: "text" });
const fontBytes = await (await fetch("./editor/fonts/Lobster-Regular.ttf")).arrayBuffer();
ed.fontTarget = ed.layers.find((l) => l.id === text.id);
await ed.addFontFiles([new File([fontBytes], "GateFont.ttf", { type: "font/ttf" })]);
const tl = ed.layers.find((l) => l.id === text.id);
if (!tl.text.fontRef) throw new Error("the user font did not reach the text layer: " + ed.status);
// a result of the loopback provider (a result history entry and its file), with a mask and colour match
await must("select_rect", { x: 300, y: 250, w: 300, h: 200 });
const prev = host.recipe;
host.setRecipe({ id: "loopback_doc", kind: "provider", provider: "loopback", providerLabel: "Loopback", model: "loopback", input: "fill", name: "Loopback", settings: [] });
try { await host.runProvider(ed); } finally { host.setRecipe(prev); }
const res = ed.layers[ed.layers.length - 1];
if (!res || res.kind !== "result" || !ed.history.length) throw new Error("no result layer from the loopback run: " + ed.status);
await must("select_rect", { x: 320, y: 270, w: 150, h: 100 });
ed.maskFromSelection(res);
await must("set_layer", { layer: res.id, match: 50 });
// filter layers: curves, grain, and a film filter when the plugin is there
await must("add_filter", { type: "curves", name: "curves", params: { curves: { rgb: [[0, 0], [128, 170], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] } } });
await must("add_filter", { type: "grain", name: "grain", params: { amount: 40 } });
const film = (await must("filter_types")).filters.find((f) => f.plugin === "film" && f.id === "film.halation") || (await must("filter_types")).filters.find((f) => f.plugin === "film");
if (film) await must("add_filter", { type: film.id, name: "film" });
// a 3D object with its depth layer (role control), its model and parameters in the document's plugin data
const g = await must("glb.place", { path: G.dir + "/cube.glb", position: { x: 0.72, y: 0.6 }, depth: 3, rotation: { x: 20, y: 35, z: 0 }, scale: 1, shadow: false, depth_layer: true });
// the AI label
const cmds = (await must("list_commands")).commands.map((c) => c.name);
if (cmds.includes("ailabel.add")) await must("ailabel.add", { label: "modified", anchor: "tr" });
// a hidden layer
const hid = await must("add_paint_layer", { name: "hidden" });
await must("select_rect", { x: 900, y: 650, w: 100, h: 100 });
fill(hid.id, "#ff00ff");
await must("set_layer", { layer: hid.id, visible: false });
// locked, alpha-locked, blend modes, opacity
await must("set_layer", { layer: paint.id, locked: true, blend: "multiply", opacity: 0.8 });
await must("set_layer", { layer: img.id, alpha_lock: true });
await must("set_layer", { layer: text.id, blend: "screen" });
// generation and crop settings
await must("set_generation", { seed: 424242, denoise: 0.8 });
await must("set_crop", { context: "64", feather: "12" });
// two saved selections, then a feathered selection; guides
await must("select_rect", { x: 10, y: 10, w: 100, h: 100 }); ed.saveSelection();
await must("select_rect", { x: 800, y: 500, w: 200, h: 120 }); ed.saveSelection();
await must("select_rect", { x: 200, y: 200, w: 500, h: 300 });
await must("select_feather", { radius: 12 });
ed.guides = { x: [300, 900.5], y: [200] };
host.changed(ed);
await wait(300);
const st = JSON.parse(ed.getValue());
return {
    tiles: ed.tileMode, film: film ? film.id : null, ailabel: cmds.includes("ailabel.add"), glbLayer: g.layer.id,
    layers: st.layers.map((l) => [l.name, l.kind, l.role, l.blend].join("/")),
    history: st.history.length, selections: st.selections.length, guides: st.guides, plugins: Object.keys(ed.pluginData || {}),
};
"""

SAVE_EVERY = """
const ed = ed4(G.every.id);
shell.activate(ed);
// read once before: on the canvas backend the first readback of a GPU canvas moves it to the CPU, and the reads after
// it differ from the first by a level on partly transparent pixels (a readback's rounding, the pixels are the same)
await snap(ed, {});
const rawA = {};
const a = await snap(ed, rawA);
G.rawA = rawA;
const t0 = performance.now();
const r = await host.saveDocument(ed, { path: G.everyPath });
const wall = performance.now() - t0;
const b = await snap(ed);
G.b = b;
// the flush uploads, it must not change a pixel; afterwards every pixel layer has its file
const changed = a.layers.filter((l, i) => JSON.stringify(l) !== JSON.stringify(b.layers[i])).map((l) => l.name);
const st = JSON.parse(b.state);
const noRef = st.layers.filter((l) => l.kind !== "filter" && !l.ref).map((l) => l.name);
return { bytes: r.bytes, entries: r.entries, ms: r.ms, notes: r.notes, wall: Math.round(wall), changed, noRef, sameBase: a.base === b.base, docFile: ed.docFile, fileOk: !!ed.docFile && same(ed.docFile.path, G.everyPath) };
"""

# the saved state restored from the mirror in a scratch tab, as the autosave restores it: what the open must equal
BASELINE = """
const ed = ed4(G.every.id);
const id = host.nextId++;
await host.restore(JSON.stringify({ version: 2, active: id, nextId: host.nextId, docs: [{ id, state: G.b.state }] }));
const sc = ed4(id);
await settle(sc);
const rawR = {};
G.r = await snap(sc, rawR, { glb: false });
G.rawR = rawR;
shell.closeDocument(sc, { force: true });
shell.activate(ed);
return { layers: G.r.layers.length, sameState: G.r.state === G.b.state };
"""

OPEN_EVERY = """
shell.closeDocument(ed4(G.every.id), { force: true });
const t0 = performance.now();
const o = await host.openDocument(G.everyPath);
const ed = o.editor;
await settle(ed);
const wall = performance.now() - t0;
G.every.id2 = ed.node.id;
const rawC = {};
const c = await snap(ed, rawC);
const problems = [];
if (c.state !== G.b.state) problems.push("getValue() differs from the saved one");
if (c.plugins !== G.b.plugins) problems.push("the plugin data differs: " + c.plugins.slice(0, 300));
if (JSON.stringify(c.glb) !== JSON.stringify(G.b.glb)) problems.push("glb.info differs: " + JSON.stringify(c.glb).slice(0, 300));
if (c.sel !== G.b.sel) problems.push("the selection differs from the saved one");
if (!c.docFile || !same(c.docFile.path, G.everyPath)) problems.push("the tab's file is " + JSON.stringify(c.docFile));
if (o.already) problems.push("the open found the document already open");
// exactly the restore of the saved state from the mirror
const ids = (s) => s.layers.map((l) => l.id).join(",");
if (ids(c) !== ids(G.r)) problems.push("layers " + ids(c) + " vs the restore's " + ids(G.r));
for (const l of c.layers) {
    const r = G.r.layers.find((x) => x.id === l.id);
    if (r && (r.px !== l.px || r.mask !== l.mask)) problems.push(`${l.name}: pixels differ from the restore of the saved state (${l.px} ${l.mask} vs ${r.px} ${r.mask})`);
}
if (c.base !== G.r.base) problems.push("the base differs from the restore's");
if (c.sel !== G.r.sel) problems.push("the selection differs from the restore's");
if (c.flat !== G.r.flat) problems.push("the flatten differs from the restore's");
// against the live document before the save: only partly transparent pixels, at most one level (the mirror's PNG round trip)
const live = {};
const label = (k) => { const l = ed.layers.find((x) => x.id === k.split(":")[0]); return l ? l.name + (k.includes(":") ? " mask" : "") : k; };
for (const k of Object.keys(G.rawA)) {
    const d = cmpRaw(G.rawA[k], rawC[k]);
    if (d.n) live[label(k)] = d;
    const lim = k === "flat" ? 2 : 1;
    if (d.n < 0 || d.solid > 0 || d.max > lim) problems.push(`${label(k)}: ${JSON.stringify(d)} against the live document (allowed: partly transparent pixels, ${lim} level)`);
}
G.c = c;
return { problems, live, wall: Math.round(wall), notes: o.notes, snap: c };
"""

GLB_EDIT = """
const ed = ed4(G.glbDoc);
const info = await must("glb.info", { doc: ed.node.id });
if (!info.objects.length) throw new Error("glb.info lists no object");
const obj = info.objects[0];
const L0 = ed.layers.find((l) => l.id === obj.layer);
const before = [L0.w, L0.h];
const e = await must("glb.edit", { doc: ed.node.id, layer: obj.layer, rotation: { x: 0, y: 0, z: 0 } });
const L1 = ed.layers.find((l) => l.id === obj.layer);
if (e.layer.id !== obj.layer) throw new Error("glb.edit made a new layer");
if (L1.w === before[0] && L1.h === before[1]) throw new Error("glb.edit did not change the object: " + JSON.stringify(before));
await ed.syncLayers();              // uploaded now, so no upload lands in the mirror later
return { before, after: [L1.w, L1.h] };
"""

# ---- step 3 --------------------------------------------------------------------------------------------------------

CLOSE_EVERY = """
const ed = ed4(G.every.id2);
await ed.syncLayers();
shell.closeDocument(ed, { force: true });
await wait(500);
return host.editors().length;
"""

REOPEN_EVERY = """
const o = await host.openDocument(G.everyPath);
const ed = o.editor;
await settle(ed);
G.every.id3 = ed.node.id;
const probe = await window.scumble.documents.open({ reqId: "gate-probe-" + Date.now(), path: G.everyPath });
return { already: o.already, sameState: ed.getValue() === G.c.state, imported: probe.imported, reused: probe.reused, renamed: probe.renamed };
"""

# ---- step 4, the document made in the first profile ------------------------------------------------------------------

BUILD_COLLIDE = """
let ed = shell.newDocument(); shell.activate(ed);
await must("load_image", { path: G.dir + "/photo.png" });
ed = host.editor;
await settle(ed);
await must("add_image_layer", { path: G.dir + "/same.png", x: 50, y: 40 });
await host.saveDocument(ed, { path: G.collidePath });
const s = await snap(ed, null, { glb: false });
shell.closeDocument(ed, { force: true });
return s;
"""

# ---- steps 5 to 8: the large document -----------------------------------------------------------------------------

BUILD_BIG = """
let ed = shell.newDocument(); shell.activate(ed);
const t0 = performance.now();
await must("load_image", { path: G.dir + "/noise.png" });
ed = host.editor;
await settle(ed);
await must("add_image_layer", { path: G.dir + "/noise.png", name: "noise 2" });
await must("add_image_layer", { path: G.dir + "/noise.png", name: "noise 3" });
await must("set_prompt", { text: "big-1" });
const t1 = performance.now();
const r = await host.saveDocument(ed, { path: G.bigPath });
G.big = { id: ed.node.id };
return { load: Math.round(t1 - t0), bytes: r.bytes, ms: r.ms, size: [ed.width, ed.height], base: await pxInfo(ed.basePx), layers: ed.layers.map((l) => l.ref && l.ref.filename) };
"""

SET_PROMPT = """
const ed = ed4(G.saveDoc);
await must("set_prompt", { doc: ed.node.id, text: G.prompt });
return ed.promptText;
"""

SAVE_IN_PLACE = """
const ed = ed4(G.saveDoc);
const t0 = performance.now();
const r = await host.saveDocument(ed);
return { bytes: r.bytes, ms: r.ms, wall: Math.round(performance.now() - t0), path: r.path };
"""

# a save started and left running (the page may go away under it)
START_SAVE = """
const ed = ed4(G.saveDoc);
G.started = host.saveDocument(ed).then((r) => ({ ok: true, bytes: r.bytes }), (e) => ({ ok: false, error: String(e.message || e) }));
return 1;
"""

CANCEL = """
const ed = ed4(G.saveDoc);
const before = JSON.stringify(ed.docFile);
let cancelled = null, seen = 0;
const off = window.scumble.documents.onProgress((p) => {
    if (p.kind !== "save" || !String(p.reqId).startsWith("save-" + ed.node.id + "-")) return;
    seen++;
    if (cancelled == null) { cancelled = p.reqId; window.scumble.documents.cancel(p.reqId); }
});
let err = null;
try { await host.saveDocument(ed); } catch (e) { err = String(e.message || e); } finally { off(); }
return { err, cancelled, seen, before, after: JSON.stringify(ed.docFile), saving: !!ed._docSaving };
"""

ONLY_BIG = """
const keep = ed4(G.big.id);
for (const e of host.editors().slice()) if (e !== keep) shell.closeDocument(e, { force: true });
shell.activate(keep);
await window.scumble.state.save(JSON.stringify(host.bundle()));
return host.editors().map((e) => e.node.id);
"""

AFTER_KILL = """
for (let i = 0; i < 1200 && (host._restoring || host.editors().some((e) => e._loading)); i++) await wait(100);
const eds = host.editors();
const ed = eds.find((e) => e.docFile && same(e.docFile.path, G.bigPath));
if (!ed) return { found: false, docs: eds.map((e) => ({ id: e.node.id, base: !!e.base, file: e.docFile })) };
await settle(ed);
G.saveDoc = ed.node.id;
const log = await window.scumble.log.list({ after: 0 });
return { found: true, id: ed.node.id, base: ed.base.ref.filename, prompt: ed.promptText, layers: ed.layers.length, log: log.filter((e) => /unfinished document save/.test(e.message)).map((e) => e.message) };
"""

OPEN_AFTER_CLOSE = """
for (let i = 0; i < 1200 && (host._restoring || host.editors().some((e) => e._loading)); i++) await wait(100);
for (const e of host.editors().slice()) if (e.docFile && same(e.docFile.path, G.bigPath)) shell.closeDocument(e, { force: true });
const o = await host.openDocument(G.bigPath);
const ed = o.editor;
await settle(ed);
return { already: o.already, prompt: ed.promptText, base: await pxInfo(ed.basePx), layers: ed.layers.length, notes: o.notes };
"""

# ---- step 2 and 4 in the fresh profile ---------------------------------------------------------------------------

OPEN_FRESH = """
const t0 = performance.now();
const o = await host.openDocument(G.everyPath);
const ed = o.editor;
await settle(ed);
const wall = performance.now() - t0;
G.glbDoc = ed.node.id;
return { snap: await snap(ed), notes: o.notes, wall: Math.round(wall) };
"""

COLLIDE = """
const ids = [];
for (const name of ["photo.png", "same.png"]) {
    const e = shell.newDocument(); shell.activate(e);
    await must("load_image", { doc: e.node.id, filename: name, subfolder: "inpaint_canvas" });
    await settle(e);
    ids.push(e.node.id);
}
const own0 = [];
for (const id of ids) own0.push(await pxInfo(ed4(id).basePx));
const o = await host.openDocument(G.collidePath);
const ed = o.editor;
await settle(ed);
const own1 = [];
for (const id of ids) own1.push(await pxInfo(ed4(id).basePx));
const refs1 = ids.map((id) => ed4(id).base.ref.filename);
return { snap: await snap(ed, null, { glb: false }), own0, own1, refs1, notes: o.notes };
"""

DISK_FULL = """
const o = await host.openDocument(G.fullPath);
const ed = o.editor;
await settle(ed);
const before = JSON.stringify(ed.docFile);
await must("set_prompt", { doc: ed.node.id, text: "disk full attempt" });
let err = null, res = null;
try { res = await host.saveDocument(ed); } catch (e) { err = String(e.message || e); }
return { err, bytes: res && res.bytes, before, after: JSON.stringify(ed.docFile) };
"""

# ---- step 11 -------------------------------------------------------------------------------------------------------

OPEN_REFUSED = """
let err = null, o = null;
const n = host.editors().length;
try { o = await host.openDocument(G.newerPath); } catch (e) { err = String(e.message || e); }
return { err, opened: !!o, tabs: host.editors().length - n };
"""

OPEN_NEWER = """
const o = await host.openDocument(G.newerPath);
const ed = o.editor;
await settle(ed);
const L = ed.layers.find((l) => l.id === "Lfuture1"), F = ed.layers.find((l) => l.id === "Lfuture2");
const newer = !!(ed.docFile && ed.docFile.newer);
const r = await host.saveDocument(ed, { path: G.resavedPath });
return {
    notes: o.notes, newer, kind: L && L.kind, px: L && L.px ? [L.px.width, L.px.height] : null,
    filter: F && F.filter, extra: Object.keys(ed.docExtra || {}), plugins: Object.keys(ed.pluginData || {}), bytes: r.bytes, status: ed.status,
};
"""


# ---- files and pictures ------------------------------------------------------------------------------------------

def png(w, h, pixel=None, level=6, rgb=True, raw_rows=None):
    """A PNG: RGB (or RGBA) rows from pixel(x, y), or raw rows; `level` 0 makes the file's length depend on w and h only."""
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    if raw_rows is None:
        raw_rows = b"".join(b"\0" + b"".join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2 if rgb else 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw_rows, level)) + chunk(b"IEND", b""))


def noise_png(w, h, seed=7):
    rnd = random.Random(seed)
    row = w * 3
    block = rnd.randbytes(row * 64)
    raw = bytearray()
    for y in range(h):
        off = (y * 7919 * 3) % (len(block) - row)
        raw += b"\0" + block[off:off + row]
    return png(w, h, raw_rows=bytes(raw), level=0)


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for part in iter(lambda: f.read(8 << 20), b""):
            h.update(part)
    return h.hexdigest()


def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()


_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.CreateFileW.restype = wintypes.HANDLE
_k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
INVALID = ctypes.c_void_p(-1).value


def open_shared(path):
    """Open for reading with FILE_SHARE_DELETE, as a viewer or a scanner does: the save's rename is not blocked by it."""
    h = _k32.CreateFileW(path, 0x80000000, 0x1 | 0x2 | 0x4, None, 3, 0x80, None)
    if h is None or h == INVALID:
        raise OSError(ctypes.get_last_error(), "CreateFileW failed", path)
    return os.fdopen(msvcrt.open_osfhandle(h, os.O_RDONLY | os.O_BINARY), "rb")


def signature(path, head=4 << 20, tail=256 << 10):
    """(size, sha of the first 4 MB, sha of the last 256 KB): tells the old file, the new one and anything torn apart."""
    with open_shared(path) as f:
        size = os.fstat(f.fileno()).st_size
        h = sha_bytes(f.read(head))
        f.seek(max(0, size - tail))
        t = sha_bytes(f.read(tail))
    return (size, h[:16], t[:16])


def temps(target):
    return glob.glob(glob.escape(target) + ".saving-*")


def wait_temp(target, min_size, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        for p in temps(target):
            try:
                if os.path.getsize(p) >= min_size:
                    return p
            except OSError:
                pass
        time.sleep(0.002)
    return None


def mirror_files(profile):
    root = os.path.join(profile, "files")
    out = {}
    for d, _, names in os.walk(root):
        for n in names:
            p = os.path.join(d, n)
            out[os.path.relpath(p, root).replace("\\", "/")] = os.path.getsize(p)
    return out


def mirror_path(profile, entry):
    """files/<type>/<sub...>/<name> -> the file in the profile's mirror."""
    return os.path.join(profile, "files", *entry.split("/")[1:])


def zip_check(path, profile=None):
    """Python's zipfile as the independent reader. Returns (problems, header, {entry: sha})."""
    problems = []
    with open(path, "rb") as f:
        head = f.read(30 + 8 + len(MIME))
    if head[:4] != b"PK\x03\x04" or head[30:38] != b"mimetype" or head[38:38 + len(MIME)] != MIME or struct.unpack("<H", head[28:30])[0] != 0:
        problems.append("the file does not start with a bare stored mimetype entry")
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        if bad is not None:
            problems.append(f"testzip: {bad} is damaged")
        infos = z.infolist()
        if not infos or infos[0].filename != "mimetype":
            problems.append("the first entry is " + (infos[0].filename if infos else "nothing"))
        elif z.read("mimetype") != MIME or infos[0].compress_type != zipfile.ZIP_STORED or infos[0].extra:
            problems.append("the mimetype entry is not a bare stored application/x-scumble")
        packed = [i.filename for i in infos if i.compress_type != zipfile.ZIP_STORED]
        if packed:
            problems.append("compressed entries: " + ", ".join(packed[:5]))
        # zipfile checks the data against the central directory only; readers that stream the file trust the local
        # headers, so their CRC and sizes must say the same (the writer puts the CRC back into each one)
        with open(path, "rb") as f:
            for i in infos:
                f.seek(i.header_offset)
                lh = f.read(30)
                crc, csize, usize = struct.unpack("<III", lh[14:26])
                if lh[:4] != b"PK\x03\x04" or crc != i.CRC or (csize != 0xFFFFFFFF and (csize != i.compress_size or usize != i.file_size)):
                    problems.append(f"the local header of {i.filename} says crc {crc:08x} size {usize}, the directory {i.CRC:08x} {i.file_size}")
                    break
        header = json.loads(z.read("scumble/document.json"))
        if header.get("format") != "scumble":
            problems.append("document.json has no format scumble")
        listed = {f["entry"] for f in header.get("files", [])}
        present = {i.filename for i in infos if i.filename.startswith("files/")}
        if listed != present:
            problems.append(f"entries {sorted(present ^ listed)[:6]} are not both listed and present")
        entries = {n: sha_bytes(z.read(n)) for n in sorted(present)}
        if "Thumbnails/thumbnail.png" in {i.filename for i in infos}:
            tb = z.read("Thumbnails/thumbnail.png")
            w, h = struct.unpack(">II", tb[16:24])
            if tb[:8] != b"\x89PNG\r\n\x1a\n" or max(w, h) > 256:
                problems.append(f"the thumbnail is {w} x {h}")
        if profile:
            for n, s in entries.items():
                p = mirror_path(profile, n)
                if not os.path.isfile(p) or sha(p) != s:
                    problems.append(f"{n} differs from its mirror file")
    return problems, header, entries


def craft(src, dst, mutate, add=None):
    """A copy of a .scumble with document.json rewritten by mutate(header) and entries added; mimetype first, all stored."""
    add = add or {}
    with zipfile.ZipFile(src) as z:
        names = [i.filename for i in z.infolist()]
        data = {n: z.read(n) for n in names}
    header = json.loads(data["scumble/document.json"])
    for n, b in add.items():
        header["files"].append({"entry": n, "size": len(b), "required": True})
    mutate(header)
    data["scumble/document.json"] = json.dumps(header).encode("utf-8")
    data.update(add)
    with zipfile.ZipFile(dst, "w", compression=zipfile.ZIP_STORED) as z:
        for n in names + [n for n in add if n not in names]:
            zi = zipfile.ZipInfo(n, date_time=(2026, 9, 26, 12, 0, 0))
            zi.compress_type = zipfile.ZIP_STORED
            z.writestr(zi, data[n])
    return header


def first_diff(a, b, ctx=80):
    a, b = str(a), str(b)
    i = next((k for k in range(min(len(a), len(b))) if a[k] != b[k]), min(len(a), len(b)))
    return f"at {i}: ...{a[max(0, i - ctx):i + ctx]}... vs ...{b[max(0, i - ctx):i + ctx]}..."


def compare_snaps(x, y):
    """Two snapshots of one document in two places: every hash and the state equal."""
    problems = []
    if x["state"] != y["state"]:
        problems.append("state " + first_diff(x["state"], y["state"]))
    for k in ("base", "sel", "flat", "plugins"):
        if x[k] != y[k]:
            problems.append(f"{k}: {str(x[k])[:80]} vs {str(y[k])[:80]}")
    if x.get("glb") is not None and json.dumps(x["glb"], sort_keys=True) != json.dumps(y["glb"], sort_keys=True):
        problems.append("glb.info differs")
    lx, ly = [(l["id"], l["px"], l["mask"]) for l in x["layers"]], [(l["id"], l["px"], l["mask"]) for l in y["layers"]]
    for p, q in zip(lx, ly):
        if p != q:
            problems.append(f"layer {p} vs {q}")
    if len(lx) != len(ly):
        problems.append(f"{len(lx)} layers vs {len(ly)}")
    return problems


def rename_refs(v, renames):
    """Refs in a parsed state with their file names mapped back (renames: new name -> old name)."""
    if isinstance(v, list):
        return [rename_refs(x, renames) for x in v]
    if isinstance(v, dict):
        out = {k: rename_refs(x, renames) for k, x in v.items()}
        if isinstance(out.get("filename"), str) and out["filename"] in renames:
            out["filename"] = renames[out["filename"]]
        return out
    return v


# ---- the app ------------------------------------------------------------------------------------------------------

class App:
    """One instance of the app on its own profile, on the gate's port."""

    def __init__(self, args, label, profile, env=None):
        self.args = args
        self.label = label
        self.profile = profile
        self.env = env or {}
        self.proc = None
        self.session = None
        self.ws = None
        self.c = None

    def start(self):
        cmd = [self.args.exe] if self.args.exe else [ELECTRON, "."]
        cmd += [f"--remote-debugging-port={self.args.port}", f"--user-data-dir={self.profile}", "--no-comfy"]
        logf = open(os.path.join(self.args.out, f"app_{self.label}.log"), "w", encoding="utf-8", errors="replace")
        env = dict(os.environ)
        env.pop("SCUMBLE_DOC_FAULT", None)
        env.update(self.env)
        self.proc = subprocess.Popen(cmd, cwd=ROOT, stdout=logf, stderr=subprocess.STDOUT, env=env)
        return self

    async def connect(self, timeout=120):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.proc.poll() is not None:
                raise RuntimeError(f"the app ({self.label}) ended with {self.proc.returncode} before it came up")
            try:
                if self.session is None:
                    self.session = aiohttp.ClientSession()
                async with self.session.get(f"http://127.0.0.1:{self.args.port}/json") as r:
                    targets = await r.json()
                page = next((t for t in targets if t.get("type") == "page" and str(t.get("url", "")).startswith("scumble://app")), None)
                if page:
                    if self.ws is not None and not self.ws.closed:
                        await self.ws.close()
                    self.ws = await self.session.ws_connect(page["webSocketDebuggerUrl"], max_msg_size=256 * 1024 * 1024)
                    self.c = Cdp(self.ws)
                    ready = await asyncio.wait_for(self.c.eval("(async () => { await import('./shell.js'); return 'ready'; })()", timeout=90), 95)
                    if ready == "ready":
                        await self.c.eval(HOOK)
                        return self
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(0.5)
        raise RuntimeError(f"the app ({self.label}) did not come up on port {self.args.port}")

    async def ev(self, body, timeout=300):
        return await self.c.eval(PRE.replace("__BODY__", body), timeout=timeout)

    async def setg(self, **kw):
        await self.c.eval("(() => { window.__dg = Object.assign(window.__dg || {}, %s); return 1; })()" % json.dumps(kw))

    async def console(self, n=8):
        try:
            logs = await self.c.eval("JSON.stringify((window.__log || []).filter((e) => e[0] !== 'log').slice(-%d))" % n, timeout=10)
            return logs[:1500]
        except Exception as err:  # noqa: BLE001
            return f"(no console: {err})"

    def wait_exit(self, timeout):
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return None

    async def close_io(self):
        try:
            if self.ws is not None and not self.ws.closed:
                await self.ws.close()
        except Exception:  # noqa: BLE001
            pass
        if self.session is not None:
            await self.session.close()
            self.session = None

    async def close(self, timeout=180):
        """WM_CLOSE, as the close button sends it, and the wait for the process to end."""
        t0 = time.time()
        try:
            close_window(self.proc.pid)
        except RuntimeError:
            pass
        code = self.wait_exit(timeout)
        await self.close_io()
        if code is None:
            self.kill()
        return code, time.time() - t0

    def kill(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
        if self.proc:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(self.proc.pid)], capture_output=True)


class Gate:
    def __init__(self, args):
        self.args = args
        self.results = []
        self.apps = []
        self.t0 = time.time()

    def step(self, name, ok, detail="", t=None):
        self.results.append(ok)
        took = f" ({time.time() - t:.1f} s)" if t is not None else ""
        print(f"[{'ok' if ok else 'FAIL'}] {name}{took}{(': ' + str(detail)) if detail else ''}", flush=True)

    def note(self, text):
        print("  " + text, flush=True)

    def fwd(self, p):
        return p.replace("\\", "/")

    def inputs(self):
        a = self.args
        d = os.path.join(a.out, "inputs")
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, "cube.glb"), "wb").write(cube_glb())
        open(os.path.join(d, "img.png"), "wb").write(png(400, 300, lambda x, y: (x * 255 // 399, y * 255 // 299, 128, 255 if (x // 40 + y // 40) % 2 else 180), rgb=False))
        # level 0: a file's length depends on its size only, so the colliding picture below has the same length
        open(os.path.join(d, "photo.png"), "wb").write(png(400, 300, lambda x, y: (x * 255 // 399, y * 255 // 299, 90), level=0))
        open(os.path.join(d, "same.png"), "wb").write(png(200, 100, lambda x, y: ((x * 3) % 256, (y * 5) % 256, 200), level=0))
        open(os.path.join(d, "photo_other.png"), "wb").write(png(320, 240, lambda x, y: (30, (x + y) % 256, 220)))
        open(os.path.join(d, "same_other.png"), "wb").write(png(200, 100, lambda x, y: (200, (x * 7) % 256, (y * 2) % 256), level=0))
        open(os.path.join(d, "future_layer.png"), "wb").write(png(100, 50, lambda x, y: (250, 200, 0, 255 if x > 10 else 0), rgb=False))
        open(os.path.join(d, "newer_only.png"), "wb").write(png(64, 64, lambda x, y: (x * 4, y * 4, 0)))
        bw, bh = a.big
        open(os.path.join(d, "noise.png"), "wb").write(noise_png(bw, bh))
        assert os.path.getsize(os.path.join(d, "same.png")) == os.path.getsize(os.path.join(d, "same_other.png"))
        return d

    async def run(self):
        a = self.args
        if not a.no_node:
            r = subprocess.run(["node", os.path.join(HERE, "document_test.js")], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=300)
            tail = r.stdout.strip()
            if r.returncode != 0 or not tail.endswith("PASS"):
                print("[FAIL] node: " + (tail + r.stderr)[-1500:])
                print("FAIL")
                return False
            print("[ok] node: %d checks" % tail.count("[ok]"), flush=True)
        inp = self.inputs()
        docs = os.path.join(a.out, "docs")
        os.makedirs(docs, exist_ok=True)
        prof_a, prof_b = os.path.join(a.out, "profile-a"), os.path.join(a.out, "profile-b")
        for p in (prof_a, prof_b):
            shutil.rmtree(p, ignore_errors=True)
            os.makedirs(p, exist_ok=True)
        every, collide, big = (os.path.join(docs, n) for n in ("every.scumble", "collide.scumble", "big.scumble"))
        paths = dict(dir=self.fwd(inp), everyPath=self.fwd(every), collidePath=self.fwd(collide), bigPath=self.fwd(big))
        state = {}
        g = self.guarded
        try:
            # ---- the first profile ----
            A = await self.app("a1", prof_a)
            await A.setg(**paths)
            t = time.time()
            built = await A.ev(BUILD)
            self.note(f"built on {'tiles' if built['tiles'] else 'canvas'}: {len(built['layers'])} layers {built['layers']}, history {built['history']}, film {built['film']}, AI label {built['ailabel']}, plugins {built['plugins']}  ({time.time() - t:.1f} s)")
            await g("every_kind_round_trips", A, self.step1(A, prof_a, every, state))
            await g("reopen_copies_nothing", A, self.step3(A, prof_a, every, state))
            t = time.time()
            state["collide"] = await A.ev(BUILD_COLLIDE)
            self.note(f"collide.scumble saved ({time.time() - t:.1f} s)")
            await g("newer_documents", A, self.step11(A, prof_a, every, docs, inp))
            t = time.time()
            bigr = await A.ev(BUILD_BIG, timeout=600)
            state["bigBase"] = bigr["base"]
            self.note(f"big.scumble: {bigr['size'][0]} x {bigr['size'][1]}, {bigr['bytes'] / 1048576:.0f} MB written in {bigr['ms']} ms (loaded in {bigr['load']} ms; {time.time() - t:.1f} s)")
            await A.setg(saveDoc=(await A.c.eval("window.__dg.big.id")))
            await g("a_save_in_place_is_atomic", A, self.step5(A, big))
            await g("cancel_leaves_the_old_file", A, self.step6_cancel(A, big))
            # ---- 7: killed mid-save, then the next start; 8: closed during a save, then a third start ----
            await A.ev(ONLY_BIG)
            A2 = await g("a_kill_mid_save_keeps_the_old_file", A, self.step7(A, prof_a, big, paths))
            if A2 is not None:
                await g("a_close_waits_for_the_save", A2, self.step8(A2, prof_a, big, paths, state))
            for x in self.apps:
                if x.proc.poll() is None:
                    await x.close()
            # ---- the fresh profile ----
            fault = {} if a.exe else {"SCUMBLE_DOC_FAULT": f"enospc@{os.path.getsize(every) // 2}"}
            B = await self.app("b", prof_b, env=fault)
            await B.setg(**paths)
            await g("opens_in_a_fresh_profile", B, self.step2(B, prof_b, every, state))
            await g("a_colliding_name_is_renamed", B, self.step4(B, prof_b, collide, inp, state))
            await g("disk_full_leaves_the_old_file", B, self.step6_full(B, docs, every))
            code, took = await B.close()
            self.note(f"closed the fresh profile's instance in {took:.1f} s (exit {code})")
        except Exception as err:  # noqa: BLE001
            self.step("gate", False, str(err)[:1500])
            for x in self.apps:
                if x.c is not None and x.proc.poll() is None:
                    self.note(f"console of {x.label}: {await x.console()}")
        finally:
            for x in self.apps:
                await x.close_io()
                x.kill()
        print(f"  gate time {time.time() - self.t0:.0f} s")
        ok = self.finish()
        if ok and not a.keep:
            # about half a gigabyte (the noise picture, three copies in a mirror, the large document): kept on a failure only
            for p in (prof_a, prof_b, docs, inp):
                shutil.rmtree(p, ignore_errors=True)
        return ok

    async def app(self, label, profile, env=None):
        """An instance on `profile`, started and connected; every one is ended when the gate ends."""
        x = App(self.args, label, profile, env).start()
        self.apps.append(x)
        return await x.connect()

    async def guarded(self, name, app, coro):
        """A step whose exception fails that step (with the page's console) and lets the gate go on."""
        try:
            return await coro
        except Exception as err:  # noqa: BLE001
            self.step(name, False, "exception: " + str(err)[:1200])
            if app is not None and app.c is not None and app.proc.poll() is None:
                self.note(f"console of {app.label}: {await app.console()}")
            return None

    # ---- the steps ----

    async def step1(self, A, prof, every, state):
        t = time.time()
        saved = await A.ev(SAVE_EVERY)
        problems = []
        if saved["changed"]:
            problems.append("the save's flush changed pixels of " + ", ".join(saved["changed"]))
        if saved["noRef"]:
            problems.append("layers without a file after the save: " + ", ".join(saved["noRef"]))
        if not saved["fileOk"]:
            problems.append("the tab's file is " + json.dumps(saved["docFile"]))
        zp, header, entries = zip_check(every, prof)
        problems += ["zip: " + p for p in zp]
        kinds = {e.split("/")[1] for e in entries}
        if "output" not in kinds:
            problems.append("no result history file in the document")
        if not any("/fonts/" in e for e in entries) or not any(e.endswith(".glb") for e in entries):
            problems.append("the user font or the 3D model is not in the document: " + ", ".join(entries))
        state["entries"] = entries
        await A.ev(BASELINE)
        opened = await A.ev(OPEN_EVERY)
        problems += opened["problems"]
        state["c"] = opened["snap"]
        glb = None
        if not problems:
            await A.setg(glbDoc=(await A.c.eval("window.__dg.every.id2")))
            glb = await A.ev(GLB_EDIT)
        live = ", ".join(f"{k} {v['n']} px by {v['max']}" for k, v in opened["live"].items()) or "none"
        self.step("every_kind_round_trips", not problems,
                  "; ".join(problems[:8]) if problems else
                  f"{saved['bytes'] / 1024:.0f} KB, {saved['entries']} entries, written in {saved['ms']} ms (save {saved['wall']} ms, open {opened['wall']} ms); "
                  f"state, {len(opened['snap']['layers'])} layers, masks, selection and flatten equal to the restore of the saved state; "
                  f"against the live document, partly transparent pixels one level off: {live}; zipfile clean; glb.edit {glb}", t)

    async def step3(self, A, prof, every, state):
        t = time.time()
        await A.ev(CLOSE_EVERY)
        await asyncio.sleep(1.0)
        before = mirror_files(prof)
        r = await A.ev(REOPEN_EVERY)
        await asyncio.sleep(1.0)
        after = mirror_files(prof)
        added = sorted(set(after) - set(before))
        changed = sorted(k for k in before if k in after and before[k] != after[k])
        ok = not added and not changed and r["sameState"] and not r["already"] and r["imported"] == 0 and not r["renamed"]
        self.step("reopen_copies_nothing", ok, f"mirror {len(before)} files before, {len(after)} after; added {added[:5]}, changed {changed[:5]}; main: imported {r['imported']}, reused {r['reused']}, renamed {r['renamed']}; state equal {r['sameState']}", t)

    async def step5(self, A, big):
        t = time.time()
        old = signature(big)
        old_sha = sha(big)
        await A.setg(prompt="big-2 atomic")
        await A.ev(SET_PROMPT)
        reads, stop = [], threading.Event()

        def reader():
            while not stop.is_set():
                during = bool(temps(big))
                try:
                    reads.append((time.time(), signature(big), during))
                except OSError as err:
                    reads.append((time.time(), ("error", str(err)), during))
                time.sleep(0.002)

        th = threading.Thread(target=reader, daemon=True)
        th.start()
        try:
            r = await A.ev(SAVE_IN_PLACE, timeout=600)
        finally:
            await asyncio.sleep(0.3)
            stop.set()
            th.join(10)
        new = signature(big)
        cls = ["old" if s == old else "new" if s == new else "other" for _, s, _ in reads]
        order_ok = "other" not in cls and "old" not in cls[cls.index("new"):] if "new" in cls else "other" not in cls
        during = [c for (_, _, d), c in zip(reads, cls) if d]
        problems = []
        if new == old or sha(big) == old_sha:
            problems.append("the file did not change")
        if not order_ok:
            bad = [(i, c, s) for i, (c, (_, s, _)) in enumerate(zip(cls, reads)) if c == "other"][:3]
            problems.append(f"reads out of order or torn: {''.join(c[0] for c in cls)[:200]} {bad}")
        if not during or "old" not in during:
            problems.append(f"no read of the old file while the temporary file existed ({len(during)} reads during the write): the write was too quick to observe")
        if temps(big):
            problems.append("a temporary file was left")
        zp, _, _ = zip_check(big)
        problems += ["zip: " + p for p in zp]
        self.step("a_save_in_place_is_atomic", not problems, "; ".join(problems) if problems else
                  f"{len(reads)} reads ({len(during)} while the temporary file existed): {cls.count('old')} old, then {cls.count('new')} new, none torn; {r['bytes'] / 1048576:.0f} MB in {r['ms']} ms", t)

    async def step6_cancel(self, A, big):
        t = time.time()
        old = sha(big)
        r = await A.ev(CANCEL, timeout=600)
        problems = []
        if not r["err"] or "cancel" not in r["err"]:
            problems.append(f"the save was not cancelled: {r['err']!r} (progress events {r['seen']})")
        if sha(big) != old:
            problems.append("the target changed")
        if temps(big):
            problems.append("a temporary file was left: " + ", ".join(temps(big)))
        if r["before"] != r["after"]:
            problems.append(f"the tab's file record changed: {r['before']} -> {r['after']}")
        if r["saving"]:
            problems.append("the tab still says it is saving")
        self.step("cancel_leaves_the_old_file", not problems, "; ".join(problems) if problems else f"cancelled at the first progress ({r['err']}); target byte-identical, no temporary file, docFile unchanged", t)

    async def step6_full(self, B, docs, every):
        t = time.time()
        if self.args.exe:
            self.note("disk_full_leaves_the_old_file: skipped (SCUMBLE_DOC_FAULT is read by dev builds only)")
            return
        full = os.path.join(docs, "full.scumble")
        shutil.copyfile(every, full)
        old = sha(full)
        await B.setg(fullPath=self.fwd(full))
        r = await B.ev(DISK_FULL)
        problems = []
        if not r["err"] or ("no space" not in r["err"] and "ENOSPC" not in r["err"]):
            problems.append(f"the save did not fail like a full disk: {r['err']!r} ({r['bytes']} bytes written)")
        if sha(full) != old:
            problems.append("the target changed")
        if temps(full):
            problems.append("a temporary file was left: " + ", ".join(temps(full)))
        if r["before"] != r["after"]:
            problems.append(f"the tab's file record changed: {r['before']} -> {r['after']}")
        self.step("disk_full_leaves_the_old_file", not problems, "; ".join(problems) if problems else f"{r['err']}; target byte-identical, no temporary file, docFile unchanged", t)

    async def step7(self, A, prof, big, paths):
        t = time.time()
        old = sha(big)
        await A.setg(prompt="big-3 killed")
        await A.ev(SET_PROMPT)
        await A.ev(START_SAVE)
        temp = wait_temp(big, 8 << 20, 120)
        if not temp:
            self.step("a_kill_mid_save_keeps_the_old_file", False, "no temporary file grew within 120 s", t)
            await A.close()
            return None
        size = os.path.getsize(temp)
        A.proc.kill()                                   # TerminateProcess, as taskkill /F does
        A.wait_exit(30)
        A.kill()                                        # and the rest of its tree
        await A.close_io()
        await asyncio.sleep(1.0)
        problems = []
        if sha(big) != old:
            problems.append("the target changed")
        left = temps(big)
        if temp not in left:
            problems.append(f"the temporary file was gone before the next start (the kill came too late?): {left}")
        try:
            listed = json.load(open(os.path.join(prof, "document-temps.json"), encoding="utf-8"))
        except (OSError, ValueError):
            listed = []
        if not any(os.path.normcase(os.path.abspath(p)) == os.path.normcase(os.path.abspath(temp)) for p in listed):
            problems.append(f"document-temps.json does not list it: {listed}")
        A2 = await self.app("a2", prof)
        await A2.setg(**paths)
        after = await A2.ev(AFTER_KILL)
        if temps(big):
            problems.append("the next start did not delete the temporary file: " + ", ".join(temps(big)))
        try:
            listed2 = json.load(open(os.path.join(prof, "document-temps.json"), encoding="utf-8"))
        except (OSError, ValueError):
            listed2 = None
        if listed2:
            problems.append(f"document-temps.json still lists {listed2}")
        if sha(big) != old:
            problems.append("the target changed after the next start")
        if not after["found"]:
            problems.append("the session did not come back with the document: " + json.dumps(after["docs"])[:400])
        self.step("a_kill_mid_save_keeps_the_old_file", not problems, "; ".join(problems) if problems else
                  f"killed at {size / 1048576:.0f} MB of the temporary file; target byte-identical; the next start removed it ({after['log']}) and restored the document ({after['layers']} layers, prompt {after['prompt']!r})", t)
        if not after.get("found"):
            await A2.close()
            return None
        return A2

    async def step8(self, A2, prof, big, paths, state):
        t = time.time()
        old = sha(big)
        await A2.setg(prompt="big-4 closed")
        await A2.ev(SET_PROMPT)
        await A2.ev(START_SAVE)
        temp = wait_temp(big, 8 << 20, 120)
        problems = []
        if not temp:
            self.step("a_close_waits_for_the_save", False, "no temporary file grew within 120 s", t)
            await A2.close()
            return
        t_close = time.time()
        close_window(A2.proc.pid)
        t_gone = None
        while A2.proc.poll() is None and time.time() - t_close < 180:
            if t_gone is None and not os.path.exists(temp):
                t_gone = time.time()
            time.sleep(0.002)
        code = A2.proc.poll()
        t_exit = time.time()
        await A2.close_io()
        if code is None:
            problems.append("the app did not end within 180 s of the close")
            A2.kill()
        if temps(big):
            problems.append("a temporary file was left: " + ", ".join(temps(big)))
        if sha(big) == old:
            problems.append("the file is the old one: the close did not wait for the save")
        zp, header, _ = zip_check(big)
        problems += ["zip: " + p for p in zp]
        if header.get("document", {}).get("prompt") != "big-4 closed":
            problems.append("the file holds the prompt " + repr(header.get("document", {}).get("prompt")))
        opened = None
        if not problems:
            A3 = await self.app("a3", prof)
            try:
                await A3.setg(**paths)
                opened = await A3.ev(OPEN_AFTER_CLOSE, timeout=600)
                if opened["prompt"] != "big-4 closed" or opened["base"] != state.get("bigBase"):
                    problems.append(f"the file opened with prompt {opened['prompt']!r} and base {opened['base']} (expected {state.get('bigBase')})")
                code3, _ = await A3.close()
            finally:
                await A3.close_io()
                A3.kill()
        gone = f"{t_gone - t_close:.2f} s" if t_gone else "?"
        self.step("a_close_waits_for_the_save", not problems, "; ".join(problems) if problems else
                  f"WM_CLOSE at {os.path.getsize(big) / 1048576:.0f} MB; the temporary file was renamed {gone} after the close, the process ended {t_exit - t_close:.2f} s after it (exit {code}); zipfile clean; it opens with the saved prompt and base", t)

    async def step2(self, B, prof, every, state):
        t = time.time()
        r = await B.ev(OPEN_FRESH)
        problems = compare_snaps(state["c"], r["snap"]) if state.get("c") else ["step 1 did not produce a reference"]
        if r["notes"]:
            problems.append("notes: " + "; ".join(r["notes"]))
        for n, s in state.get("entries", {}).items():
            p = mirror_path(prof, n)
            if not os.path.isfile(p) or sha(p) != s:
                problems.append(f"{n} was not imported byte for byte")
        glb = None
        if not problems:
            glb = await B.ev(GLB_EDIT)
        self.step("opens_in_a_fresh_profile", not problems, "; ".join(problems[:8]) if problems else
                  f"state, layers, masks, selection and flatten equal to the first profile's; {len(state['entries'])} files imported byte for byte; open {r['wall']} ms; glb.edit {glb}", t)

    async def step4(self, B, prof, collide, inp, state):
        t = time.time()
        mdir = os.path.join(prof, "files", "input", "inpaint_canvas")
        os.makedirs(mdir, exist_ok=True)
        shutil.copyfile(os.path.join(inp, "photo_other.png"), os.path.join(mdir, "photo.png"))
        shutil.copyfile(os.path.join(inp, "same_other.png"), os.path.join(mdir, "same.png"))
        _, header, entries = zip_check(collide)
        e_photo, e_same = "files/input/inpaint_canvas/photo.png", "files/input/inpaint_canvas/same.png"
        problems = []
        if e_photo not in entries or e_same not in entries:
            problems.append("collide.scumble does not carry photo.png and same.png: " + ", ".join(entries))
        if os.path.getsize(os.path.join(mdir, "same.png")) != header_size(header, e_same):
            problems.append("the same-size case is not the same size")
        r = await B.ev(COLLIDE)
        st = json.loads(r["snap"]["state"])
        refs = [st["base"]["filename"]] + [l["ref"]["filename"] for l in st["layers"] if l.get("ref")]
        if refs != ["photo (1).png", "same (1).png"]:
            problems.append(f"the opened document names {refs}, not the free names")
        orig = state["collide"]
        mapped = rename_refs(st, {"photo (1).png": "photo.png", "same (1).png": "same.png"})
        if mapped != json.loads(orig["state"]):
            problems.append("the state after mapping the names back " + first_diff(json.dumps(mapped, sort_keys=True), json.dumps(json.loads(orig["state"]), sort_keys=True)))
        if r["snap"]["base"] != orig["base"] or [l["px"] for l in r["snap"]["layers"]] != [l["px"] for l in orig["layers"]]:
            problems.append("the opened document's pixels differ from the saved ones")
        if r["own0"] != r["own1"] or r["refs1"] != ["photo.png", "same.png"]:
            problems.append(f"the documents already open changed: {r['own0']} -> {r['own1']}, {r['refs1']}")
        if r["own0"][0] == orig["base"]:
            problems.append("the colliding picture is the same picture")
        for name, other in (("photo", "photo_other.png"), ("same", "same_other.png")):
            if sha(os.path.join(mdir, f"{name}.png")) != sha(os.path.join(inp, other)):
                problems.append(f"{name}.png in the mirror was overwritten")
            p = os.path.join(mdir, f"{name} (1).png")
            if not os.path.isfile(p) or sha(p) != entries.get(f"files/input/inpaint_canvas/{name}.png"):
                problems.append(f"{name} (1).png is not the document's picture")
        self.step("a_colliding_name_is_renamed", not problems, "; ".join(problems[:6]) if problems else
                  f"imported as {refs} (one of another size, one of the same size {header_size(header, e_same)} bytes with other bytes); the open documents kept their pixels; the state equal after mapping the names", t)

    async def step11(self, A, prof, every, docs, inp):
        t = time.time()
        problems = []
        pl = "files/input/inpaint_canvas/"
        only = open(os.path.join(inp, "newer_only.png"), "rb").read()
        min2 = os.path.join(docs, "newer_min2.scumble")

        def refuse(h):
            h["version"], h["minReader"], h["app"] = 2, 2, "9.9.9"
        craft(every, min2, refuse, {pl + "newer_only.png": only})
        before = mirror_files(prof)
        await A.setg(newerPath=self.fwd(min2))
        r = await A.ev(OPEN_REFUSED)
        after = mirror_files(prof)
        if not r["err"] or "newer" not in r["err"] or "update" not in r["err"].lower():
            problems.append(f"minReader 2 was not refused: {r['err']!r}")
        if r["opened"] or r["tabs"]:
            problems.append("minReader 2 opened a tab")
        if set(after) != set(before) or "input/inpaint_canvas/newer_only.png" in after:
            problems.append(f"minReader 2 imported {sorted(set(after) - set(before))}")
        # version 2, minReader 1: four things this version does not know
        v2 = os.path.join(docs, "newer_v2.scumble")
        future = {"id": "Lfuture1", "name": "future layer", "kind": "hologram", "role": "none", "blend": "normal",
                  "ref": {"filename": "future_layer.png", "subfolder": "inpaint_canvas", "type": "input"},
                  "x": 30, "y": 40, "w": 100, "h": 50, "opacity": 1, "visible": True, "mask": None}
        ffilter = {"id": "Lfuture2", "name": "future filter", "kind": "filter", "role": "none", "blend": "normal", "ref": None,
                   "x": 0, "y": 0, "w": 1200, "h": 800, "opacity": 1, "visible": True, "mask": None,
                   "filter": "future.glow", "params": {"radius": 7, "custom": "kept", "nested": {"a": [1, 2]}}, "lut": None, "plate": None}
        field = {"a": 1, "list": [1, 2, 3], "text": "from the future"}
        pdata = {"note": "kept", "n": [1, 2], "ref": {"filename": "future_plugin.bin", "subfolder": "inpaint_canvas", "type": "input"}}
        blob = bytes(range(256)) * 16

        def newer(h):
            h["version"], h["minReader"], h["app"] = 2, 1, "9.9.9"
            h["document"]["layers"] += [future, ffilter]
            h["document"]["futureField"] = field
            h["plugins"]["future-plugin"] = pdata
        craft(every, v2, newer, {pl + "future_layer.png": open(os.path.join(inp, "future_layer.png"), "rb").read(), pl + "future_plugin.bin": blob})
        resaved = os.path.join(docs, "newer_resaved.scumble")
        await A.setg(newerPath=self.fwd(v2), resavedPath=self.fwd(resaved))
        o = await A.ev(OPEN_NEWER)
        if not any("newer" in n for n in o["notes"]):
            problems.append(f"no note about the newer document: {o['notes']}")
        if not o["newer"]:
            problems.append("the tab's file is not marked newer")
        if o["kind"] != "hologram" or o["px"] != [100, 50]:
            problems.append(f"the unknown kind loaded as {o['kind']} {o['px']}")
        if o["filter"] != "future.glow":
            problems.append(f"the unknown filter became {o['filter']}")
        zp, h2, entries = zip_check(resaved, prof)
        problems += ["zip: " + p for p in zp]
        d = h2.get("document", {})
        got = {l.get("id"): l for l in d.get("layers", [])}
        if got.get("Lfuture1") != future:
            problems.append(f"the unknown kind came back as {got.get('Lfuture1')}")
        if got.get("Lfuture2") != ffilter:
            problems.append(f"the unknown filter came back as {got.get('Lfuture2')}")
        if d.get("futureField") != field:
            problems.append(f"the unknown field came back as {d.get('futureField')!r}")
        if h2.get("plugins", {}).get("future-plugin") != pdata:
            problems.append(f"the unknown plugin's data came back as {h2.get('plugins', {}).get('future-plugin')!r}")
        if entries.get(pl + "future_plugin.bin") != sha_bytes(blob) or pl + "future_layer.png" not in entries:
            problems.append("the files of the unknown layer and plugin data did not travel: " + ", ".join(e for e in entries if "future" in e))
        await A.ev("for (const e of host.editors().slice()) if (e.docFile && /newer_v2/.test(e.docFile.path)) shell.closeDocument(e, { force: true }); return 1;")
        self.step("newer_documents", not problems, "; ".join(problems[:6]) if problems else
                  f"minReader 2 refused ({r['err'][:90]}...), nothing imported; version 2 opened with the note, and the unknown kind, filter id, top-level field and plugin data (with their files) came back unchanged in the next save", t)

    def finish(self):
        ok = bool(self.results) and all(self.results)
        print("PASS" if ok else "FAIL")
        return ok


def header_size(header, entry):
    return next((f["size"] for f in header.get("files", []) if f["entry"] == entry), None)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--exe", default=None)
    p.add_argument("--port", type=int, default=int(os.environ.get("SCUMBLE_CDP_PORT", "9555")) + 17)
    p.add_argument("--out", default=os.path.join(ROOT, "dist", "gates", "document"))
    p.add_argument("--big", default="6000x4000", help="the noise picture of the slow saves (steps 5 to 8)")
    p.add_argument("--no-node", action="store_true", help="skip tools/document_test.js (a mutation round checks the app steps alone)")
    p.add_argument("--keep", action="store_true", help="keep the profiles and documents after a pass (they are always kept after a failure)")
    args = p.parse_args()
    args.big = [int(v) for v in args.big.lower().split("x")]
    if args.exe:
        args.exe = os.path.abspath(args.exe)
    args.out = os.path.abspath(args.out)
    os.makedirs(args.out, exist_ok=True)
    appdata = os.environ.get("APPDATA", "")
    for name in ("Scumble", "Scumble Store"):
        for sub in ("profile-a", "profile-b"):
            if appdata and os.path.normcase(os.path.join(args.out, sub)) == os.path.normcase(os.path.join(appdata, name)):
                raise SystemExit("refusing the user's own profile")
    sys.stdout.reconfigure(encoding="utf-8")
    ok = asyncio.run(Gate(args).run())
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
