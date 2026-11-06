"""Key screen gate (item 49, docs/PLAN_CORRIDORKEY.md I4, I5, I7): the landing, the Key dialog's live loop and the
key_screen command, on a stubbed engine (host.keyEngine replaced by a fixture: a synthetic matte from the picture it
was given, or the hint when one went). No model, no ComfyUI.

    python tools/key_test.py

Start the app first (tools/run_gates.sh does: `--offline`, on both backends). Checks, in order:
  refusals    the engine missing (this build's default answer), no picture, a run going: nothing read, nothing added
  picture     a key of the visible picture at a scale of 1: the Key layer's bytes exactly the engine's foreground,
              its mask exactly the matte in white (MASK_RGB), trimmed to the matte's box, ref null and both dirty flags,
              the grey Fill layer under it in #808080 named Grey (not the paint colour), the Key active, its status last;
              one undo takes both back
  layer       a layer as the source: the Key directly above it, the source hidden in the same step; one undo
  scaled      a selection's box keyed at a smaller bucket: the hint reached the engine, the layer the matte's box, the
              mask within a level of the matte sampled bilinearly (a flat picture: the refine leaves the matte as it is)
  refine      the whole picture keyed at a third of its size over a sharp disc: the mask refined in the key worker
              against the full-resolution picture (no fallback, guideDiff at most a level), nearer the sharp edge than
              the bilinear matte, and keymatte.refineMatte's bytes exactly; a fill layer over the box changes nothing
              (the reads skip filters as the bucket did); a layer as the source refines too
  restore    syncLayers + getValue + setValue: the pixels and the mask come back, the session's record does not, and
              Re-key falls back to the layer's bounds
  rekey read  the picture under the key (upTo) goes to the engine: no compositeVersion change, nothing hidden
  rekey       the key layer's mask as the hint (0.95), pixels and mask replaced; one undo restores both
  cancel      the title row's Cancel during the engine's run adds nothing
  export      the Key layer with its mask in PSD and ORA, and in the flattened picture
  dialog      the values reach the engine, a selection change sends one preview with the new hint, a dab burst through
              pluginPointer gives one run in flight and one pending, a stale ticket is dropped, Key lands the matte shown,
              Re-key follows a mask change at its end (not mid-stroke), the dormant and the not-downloaded states
  command     key_screen, its preview into the selection, rekey, status.key
  comfy *     Route B (B2): the key on your ComfyUI, host.uploadInput and host.comfyPictureRun stubbed with B0's fixture
              (tools/fixtures/corridorkey_routeb): native (the picture and the hint byte for byte, B0's graph, the
              landed bytes and mask the pack's rgba answer exactly), rekey (the picture under the key, a clean matte),
              scaled (the half fixture, the mask refineMatte's bytes, the colour within a level), refusals (not
              connected, no pack, a run going, the models missing, another size), cancel (the title row, a closed tab)
  dialog comfy  B3: the route row on your ComfyUI: no session and nothing run before Key, the box line following the
              selection, the rows reaching the graph and the wait, Key and Re-key once, the first-run block, the
              readiness line following the server
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

# B0's Route B fixture (docs/measurements/ck_b0_2026-11-06/summary.txt section 6): real answers of pack A at c7662de
FIXDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "corridorkey_routeb").replace("\\", "/")

HELPERS = r"""
const K = window.__keying;
const ednow = (id) => host.editors().find((e) => e.node.id === id);
const fail = (msg, extra) => { throw new Error(msg + (extra === undefined ? "" : ": " + JSON.stringify(extra).slice(0, 400))); };
const ok = (cond, msg, extra) => { if (!cond) fail(msg, extra); };
const stub = window.__keyStub;
const engineOn = () => { host.keyEngine = stub; };
const engineOff = () => { host.keyEngine = window.__keyEngine0; };
const rect = (px, w, h) => px.readRect(0, 0, w, h).data;
// new_canvas is white: the base made green (#00b140) by a filled paint layer, flattened
const greenBase = async (ed) => {
    const l = ed.addPaintLayer();
    const W = ed.width, H = ed.height, img = new ImageData(W, H);
    for (let i = 0; i < W * H; i++) { img.data[i * 4] = 0; img.data[i * 4 + 1] = 177; img.data[i * 4 + 2] = 64; img.data[i * 4 + 3] = 255; }
    l.px.writeRect(img, 0, 0);
    ed.markLayerChanged(l);
    await ed.flatten();
    await wait(100);
};
const closeDialog = () => { const d = window.__keyDialogMod.currentKeyDialog(); if (d) d.close(); };
const runs = () => stub.calls.filter((c) => c.op === "run" && !c.gone);
const preps = () => stub.calls.filter((c) => c.op === "prepare");
const fill = (l, rgba, x0 = 0, y0 = 0, x1 = l.w, y1 = l.h) => {
    const img = new ImageData(l.w, l.h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set(rgba, (y * l.w + x) * 4);
    l.px.writeRect(img, 0, 0);
};
// a pointer event at image (ix, iy) for the editor's own handlers (onPointerDown / Move / Up)
const ev = (ed, ix, iy) => {
    const r = ed.canvas.getBoundingClientRect();
    const [cx, cy] = ed.imageToScreen(ix, iy);
    return { clientX: r.left + (cx * r.width) / ed.canvas.width, clientY: r.top + (cy * r.height) / ed.canvas.height, button: 0, buttons: 1, pointerId: 7, pointerType: "mouse",
        altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, detail: 1, pressure: 0.5, preventDefault() {}, stopPropagation() {}, target: ed.canvas };
};
const waitFor = async (cond, ms = 3000) => { for (let t = 0; t < ms / 25 && !cond(); t++) await wait(25); return cond(); };
// Route B: a connected ComfyUI with an RTX 5090 and pack A's node list, the uploads and the job answered by the stub
const comfyOn = () => {
    const C = window.__comfyStub;
    host.server = { state: "connected", os: "nt", gpus: ["cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync"], remote: false, url: "http://127.0.0.1:8188", version: "0.44.0" };
    host.objectInfo = window.__ckFix.info;
    host.comfyPictureRun = (...a) => C.run(...a);
    host.uploadInput = (...a) => C.upload(...a);
};
const comfyOff = () => {
    const o = window.__comfy0;
    if (!o) return;
    host.server = o.server; host.objectInfo = o.objectInfo; host.comfyPictureRun = o.comfyPictureRun; host.uploadInput = o.uploadInput; host.keyComfyFit = o.keyComfyFit;
};
const settle = async (ed) => { for (let t = 0; t < 50 && (ed.providerPending || host._keyBusy); t++) await wait(50); await wait(60); };
"""

STEPS = [
    ("setup", r"""
window.__keying = await import("./editor/keying.js");
window.__keyDialogMod = await import("./keydialog.js");
const K2 = window.__keying;
window.__keyEngine0 = host.keyEngine;
// the fixture engine: a synthetic matte (a soft disc in the content) from the picture it was given, or the hint as the
// matte when one went; the foreground the picture's own RGB; every request kept
const st = {
    calls: [], prepared: new Map(), delay: 0, fail: "", closedCount: 0, cancels: 0, present: true, provider: "stub", last: null,
    status() { return { installed: true, offered: true, present: this.present, provider: this.provider, workingSizes: [512, 1024] }; },
    async prepare(req) {
        // what the picture holds: its first pixel, its centre's, and how many pixels are magenta (a colour only a test paints)
        const { w, h } = req.bucket, [, , cw, ch] = req.content, im = req.image;
        let magenta = 0;
        for (let i = 0; i < w * h; i++) if (im[i * 4] > 150 && im[i * 4 + 1] < 80 && im[i * 4 + 2] > 150) magenta++;
        const ci = (Math.floor(ch / 2) * w + Math.floor(cw / 2)) * 4;
        this.calls.push({ op: "prepare", key: req.key, bucket: req.bucket, content: req.content, px: Array.from(im.slice(0, 4)), centre: Array.from(im.slice(ci, ci + 4)), magenta });
        this.prepared.set(req.key, req);
        return { provider: this.provider, ms: 1, cached: false };
    },
    async holds(key) { return this.prepared.has(key); },
    async cancel() { this.cancels++; },
    async run(req) {
        const p = this.prepared.get(req.key);
        if (!p) { this.calls.push({ op: "run", key: req.key, gone: true }); throw new Error(K2.FEATURES_GONE + ": no features under " + req.key); }
        let hintSum = 0;
        if (req.hint) for (let i = 0; i < req.hint.length; i++) hintSum += req.hint[i];
        this.calls.push({ op: "run", key: req.key, hint: !!req.hint, hintSum, quality: req.quality, despill: req.despill, screen: req.screen, ticket: req.ticket });
        if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
        if (this.fail) throw new Error(this.fail);
        const { w, h } = p.bucket;
        const [, , cw, ch] = p.content;
        const alpha = new Float32Array(w * h), fg = new Uint8Array(w * h * 3);
        const cx = cw / 2, cy = ch / 2, r = 0.3 * Math.min(cw, ch);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (x < cw && y < ch) alpha[i] = req.hint ? req.hint[i] / 255 : Math.min(1, Math.max(0, (r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)) / 6 + 0.5));
            fg[i * 3] = p.image[i * 4]; fg[i * 3 + 1] = p.image[i * 4 + 1]; fg[i * 3 + 2] = p.image[i * 4 + 2];
        }
        this.last = { alpha, fg, w, h, content: p.content.slice() };
        return { alpha, fg, ms: 2, provider: this.provider, ticket: req.ticket };
    },
    async free() {},
    closed() { this.closedCount++; },
};
window.__keyStub = st;
host.keyStored = { ...K2.keyDefaults, workingSize: 512 };
host._keyLoaded = true;
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 512, height: 512 });
await greenBase(ed);
window.__keyDoc = d.id;
return { doc: d.id, tiles: !!ed.tileMode, worker: typeof Worker !== "undefined" };
"""),

    ("refusals", r"""
const ed = ednow(window.__keyDoc);
engineOff();
const n0 = ed.layers.length;
let msg = "";
try { await host.keyScreen(ed, { route: "app" }); } catch (err) { msg = err.message; }
ok(msg === K.TEXTS.notInstalled, "this build's engine answers not installed", msg);
ok(ed.layers.length === n0, "nothing added");
ok(host.keyCheck(ed, {}).text === K.TEXTS.notInstalled, "keyCheck says the same");
// without the in-app engine the default route is your ComfyUI (Route B), which says what it needs (offline: connect)
let msg2 = "";
try { await host.keyScreen(ed, {}); } catch (err) { msg2 = err.message; }
ok(host.keyRoute() === "comfyui" && msg2 === K.serverSupport({ state: "disconnected" }).reason && ed.statusKind !== "error", "the default route is your ComfyUI and says to connect it", [host.keyRoute(), msg2, ed.statusKind]);
engineOn();
ed.providerPending = { label: "x" };
ok(host.keyCheck(ed, {}).text === K.TEXTS.runGoing, "a run going refuses", host.keyCheck(ed, {}));
ed.providerPending = null;
const blank = ednow((await run("new_document")).id);
ok(host.keyCheck(blank, {}).text === K.TEXTS.noPicture, "no picture refuses");
await run("close_document", { doc: blank.node.id, force: true });
host.shell.activate(ed);
const filt = ed.addFilterLayer("grain");
ok(/filter layer/.test(host.keyCheck(ed, { source: filt.id, layer: filt }).text), "a filter layer as the source refuses");
ed.layers.splice(ed.layers.indexOf(filt), 1); ed.layersRestacked();
ok(stub.calls.length === 0, "nothing reached the engine", stub.calls.length);
return { msg };
"""),

    ("picture", r"""
const ed = ednow(window.__keyDoc);
engineOn();
ed.color = "#ff00ff";   // the paint colour: the grey layer must not take it
const n0 = ed.layers.length, u0 = ed.undo.length;
const out = await host.keyScreen(ed, { source: "picture", hint: "selection", screen: "green" });
const L = out.layer, G = out.grey;
ok(L && G, "a Key and a Grey layer", out);
ok(ed.layers.length === n0 + 2 && ed.undo.length === u0 + 1, "two layers, one undo step", [ed.layers.length, ed.undo.length]);
ok(ed.layers.indexOf(G) === ed.layers.indexOf(L) - 1, "the grey layer directly under the key");
ok(G.kind === "filter" && G.filter === "fill" && G.params.color === "#808080" && G.name === "Grey", "the grey layer is a #808080 fill named Grey", { f: G.filter, c: G.params.color, n: G.name });
ok(ed.activeLayerId === L.id, "the key layer is active");
ok(L.name === "Key" && L.ref === null && L.dirty === true && L.maskDirty === true && !!L.maskPx, "named Key, ref null, both dirty flags", { n: L.name, ref: L.ref, d: L.dirty, md: L.maskDirty });
ok(L.match && L.match.strength === 0 && L.match.source === "underneath", "match preset to underneath at 0", L.match);
ok(/^Key: .* of the box kept/.test(ed.status) && /grey layer sits under the Key layer/.test(ed.status), "the key's status is the last line", ed.status);
const s = stub.last;
ok(s.w === 512 && s.h === 512, "keyed at the 512 bucket", [s.w, s.h]);
const mb = K.matteBox(s.alpha, s.w, s.h, s.content, [0, 0, 512, 512]);
ok(L.x === mb[0] && L.y === mb[1] && L.w === mb[2] - mb[0] && L.h === mb[3] - mb[1], "trimmed to the matte's box", { mb, x: L.x, y: L.y, w: L.w, h: L.h });
ok(L.w < 400 && L.h < 400, "smaller than the box", [L.w, L.h]);
const px = rect(L.px, L.w, L.h), mk = rect(L.maskPx, L.w, L.h);
let offPx = 0, offA = 0, offRgb = 0, kept = 0;
for (let Y = 0; Y < L.h; Y++) for (let X = 0; X < L.w; X++) {
    const i = (Y + L.y) * s.w + (X + L.x), o = (Y * L.w + X) * 4;
    if (px[o] !== s.fg[i * 3] || px[o + 1] !== s.fg[i * 3 + 1] || px[o + 2] !== s.fg[i * 3 + 2] || px[o + 3] !== 255) offPx++;
    if (mk[o + 3] !== K.toLevel(s.alpha[i])) offA++;
    if (mk[o + 3] > 0 && (mk[o] !== 255 || mk[o + 1] !== 255 || mk[o + 2] !== 255)) offRgb++;
    if (mk[o + 3] === 255) kept++;
}
ok(offPx === 0, "the layer's bytes are the engine's foreground, opaque", offPx);
ok(offA === 0, "the mask's alpha is the matte exactly", offA);
ok(offRgb === 0, "the mask is white where it lets through (MASK_RGB)", offRgb);
ok(kept > 1000, "the matte keeps its disc", kept);
ok(host._keyRows && host._keyRows.inThread === false, "the rows came from the app-only worker (keyworker.js), not the window's thread");
ok(L.key && L.key.box.join() === "0,0,512,512" && L.key.greyId === G.id && L.key.screen === "green", "the session's key record", L.key);
await ed.undoStep();
ok(ed.layers.length === n0 && !ed.layers.some((l) => l.id === L.id || l.id === G.id), "one undo takes both back", ed.layers.map((l) => l.name));
await ed.redoStep();
ok(ed.layers.some((l) => l.id === L.id) && ed.layers.some((l) => l.id === G.id), "redo brings both");
window.__keyLayer = L.id; window.__keyGrey = G.id;
return { box: out.box, matteBox: out.matteBox, kept: Math.round(out.kept), status: ed.status };
"""),

    ("layer", r"""
const ed = ednow(window.__keyDoc);
const src = ed.addPaintLayer();
src.name = "Subject";
const img = new ImageData(512, 512);
for (let i = 0; i < 512 * 512; i++) { img.data[i * 4] = 0; img.data[i * 4 + 1] = 177; img.data[i * 4 + 2] = 64; img.data[i * 4 + 3] = 255; }
src.px.writeRect(img, 0, 0);
ed.markLayerChanged(src);
const below = ed.layers.indexOf(src);
const n0 = ed.layers.length, u0 = ed.undo.length;
const out = await host.keyScreen(ed, { source: src.id, layer: src, hint: "none", screen: "green" });
ok(out.layer && !out.grey, "a key, no grey layer", out);
ok(ed.layers.indexOf(out.layer) === below + 1, "directly above the source", [ed.layers.indexOf(out.layer), below]);
ok(src.visible === false && out.hidden === src, "the source is hidden");
ok(ed.layers.length === n0 + 1 && ed.undo.length === u0 + 1, "one layer, one undo step");
ok(/Subject is hidden/.test(ed.status), "the status names the hidden layer", ed.status);
ok(stub.calls[stub.calls.length - 1].hint === false && stub.calls[stub.calls.length - 1].quality === -1, "no hint: quality -1", stub.calls[stub.calls.length - 1]);
await ed.undoStep();
ok(src.visible === true || ed.layers.find((l) => l.id === src.id).visible === true, "one undo shows the source again");
ok(!ed.layers.some((l) => l.id === out.layer.id), "and takes the key back");
ed.layers.splice(ed.layers.findIndex((l) => l.id === src.id), 1); ed.layersRestacked();
return { at: below + 1 };
"""),

    ("scaled", r"""
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 1536, height: 1024 });
await greenBase(ed);
await run("select_rect", { doc: d.id, x: 500, y: 300, w: 600, h: 400 });
const plan = host.keyPlan(ed, { source: "picture", hint: "selection" });
ok(!plan.whole && plan.box[0] <= 500 && plan.box[2] >= 1100 && plan.bucket.w === 512, "the selection's box grown, a 512 bucket", plan);
const out = await host.keyScreen(ed, { source: "picture", hint: "selection", trust: 0.5, screen: "green", grey: false });
const c = stub.calls[stub.calls.length - 1];
ok(c.hint && c.quality === 0.5, "the selection went as the hint at 0.5", c);
const L = out.layer, s = stub.last;
ok(!out.grey, "grey: false leaves the base as it is");
ok(L.x >= plan.box[0] && L.x + L.w <= plan.box[2] && L.w < plan.box[2] - plan.box[0], "the layer is the matte's box inside the box", { L: [L.x, L.y, L.w, L.h], box: plan.box });
const mk = rect(L.maskPx, L.w, L.h);
const sx = (s.content[2]) / (plan.box[2] - plan.box[0]), sy = (s.content[3]) / (plan.box[3] - plan.box[1]);
let worst = 0;
for (let Y = 0; Y < L.h; Y += 3) for (let X = 0; X < L.w; X += 3) {
    const u = Math.min(s.content[2] - 1, Math.max(0, (L.x + X + 0.5 - plan.box[0]) * sx - 0.5));
    const v = Math.min(s.content[3] - 1, Math.max(0, (L.y + Y + 0.5 - plan.box[1]) * sy - 0.5));
    const i0 = Math.floor(u), j0 = Math.floor(v), i1 = Math.min(s.content[2] - 1, i0 + 1), j1 = Math.min(s.content[3] - 1, j0 + 1);
    const fu = u - i0, fv = v - j0, A = (i, j) => s.alpha[j * s.w + i];
    const want = Math.round(255 * Math.min(1, Math.max(0, (A(i0, j0) * (1 - fu) + A(i1, j0) * fu) * (1 - fv) + (A(i0, j1) * (1 - fu) + A(i1, j1) * fu) * fv)));
    worst = Math.max(worst, Math.abs(mk[(Y * L.w + X) * 4 + 3] - want));
}
ok(worst <= 1, "the scaled mask within a level of the matte", worst);
const cx = 800 - L.x, cy = 500 - L.y;
ok(mk[(cy * L.w + cx) * 4 + 3] === 255, "inside the selection the matte lets through");
window.__keyDoc2 = d.id;
return { box: plan.box, bucket: plan.bucket, layer: [L.x, L.y, L.w, L.h], worst };
"""),

    ("refine", r"""
// I6 wired into the landing (docs/ck2/refine_notes.md step 9): a matte keyed smaller than its box is refined against
// the full-resolution picture in the key worker. The picture: green with a skin-tone disc whose edge is sharp at full
// resolution exactly where the stub's soft matte has its 0.5 contour
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const W = 1536, H = 1024;
await run("new_canvas", { doc: d.id, width: W, height: H });
const plan = host.keyPlan(ed, { source: "picture", hint: "none" });
const cw = plan.content[2], ch = plan.content[3];
ok(K.isScaled(plan) && plan.box.join() === `0,0,${W},${H}`, "the whole picture keyed smaller than its box", plan);
const r = 0.3 * Math.min(cw, ch);
const inDisc = (X, Y) => Math.hypot(((X + 0.5) * cw) / W - cw / 2, ((Y + 0.5) * ch) / H - ch / 2) < r;
const disc = (transparent) => {
    const img = new ImageData(W, H);
    for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) img.data.set(inDisc(X, Y) ? [222, 170, 140, 255] : transparent ? [0, 0, 0, 0] : [0, 177, 64, 255], (Y * W + X) * 4);
    return img;
};
const l0 = ed.addPaintLayer();
l0.px.writeRect(disc(false), 0, 0);
ed.markLayerChanged(l0);
await ed.flatten();
await wait(100);
const opts = { source: "picture", hint: "none", screen: "green", grey: false };
const errs = (L) => {
    const s = stub.last, mk = rect(L.maskPx, L.w, L.h);
    const lin = K.bilinearRows(s.alpha, null, s.w, K.sampleMap([L.x, L.y, L.x + L.w, L.y + L.h], plan.box, s.content), L.w, 0, L.h).a;
    let eR = 0, eB = 0;
    for (let Y = 0; Y < L.h; Y++) for (let X = 0; X < L.w; X++) {
        const t = inDisc(L.x + X, L.y + Y) ? 255 : 0, k = Y * L.w + X;
        eR += Math.abs(mk[k * 4 + 3] - t); eB += Math.abs(lin[k] - t);
    }
    return { mk, refined: eR / (L.w * L.h), bilinear: eB / (L.w * L.h) };
};
const out = await host.keyScreen(ed, opts);
const L = out.layer, rf = out.refine;
ok(L && rf && !rf.fallback && !rf.error && rf.guideDiff != null && rf.guideDiff <= 1, "refined: no fallback, the full-resolution read is the bucket's picture", rf);
const e1 = errs(L);
ok(e1.refined < 0.6 * e1.bilinear, "the refined mask follows the sharp edge closer than the bilinear matte", e1);
ok(!/not refined/.test(ed.status), "the status says nothing of a fallback", ed.status);
// the same bytes as keymatte.refineMatte run in the window from the same inputs and the same reader (up to the key
// layer: the picture now holds the key itself, which the landing's reads came before)
const KM = await import("./editor/keymatte.js");
const s = stub.last, prep = stub.prepared.get(preps().pop().key);
const rd = host.keyBandReader(ed, { layer: null, fill: null, upTo: ed.layers.indexOf(L) });
const want = await KM.refineMatte({
    alpha: s.alpha, aw: s.w, ah: s.h, small: { data: prep.image, width: s.w, height: s.h },
    src: { x: 0, y: 0, w: cw, h: ch }, full: { w: W, h: H }, out: { x: L.x, y: L.y, w: L.w, h: L.h },
    read: (b) => rd.read([L.x, L.y + b[1], L.x + L.w, L.y + b[3]]),
});
rd.done();
let off = 0;
for (let k = 0; k < L.w * L.h; k++) if (e1.mk[k * 4 + 3] !== want.alpha[k]) off++;
ok(off === 0 && !want.fallback, "the mask is refineMatte's answer exactly", { off, fallback: want.fallback });
ok(host._keyRows && host._keyRows.inThread === false, "the key worker answered");
// a filter layer over the box (a red fill): the reads skip it as the bucket did, so the same mask
await ed.undoStep();
const f = ed.addFilterLayer("fill");
f.params.color = "#ff0000";
ed.markFilterChanged(f);
const out2 = await host.keyScreen(ed, opts);
const rf2 = out2.refine;
ok(rf2 && !rf2.fallback && rf2.guideDiff <= 1, "a fill layer over the box: still no fallback", rf2);
const mk2 = rect(out2.layer.maskPx, out2.layer.w, out2.layer.h);
let off2 = out2.layer.w === L.w && out2.layer.h === L.h ? 0 : -1;
if (off2 === 0) for (let k = 0; k < L.w * L.h; k++) if (mk2[k * 4 + 3] !== e1.mk[k * 4 + 3]) off2++;
ok(off2 === 0, "the mask equals the one without the filter layer", off2);
await ed.undoStep();
ed.layers.splice(ed.layers.indexOf(f), 1);
ed.layersRestacked();
// a layer as the source (the disc on transparent pixels, read on the screen's green at both scales)
const sl = ed.addPaintLayer();
sl.name = "Subject";
sl.px.writeRect(disc(true), 0, 0);
ed.markLayerChanged(sl);
const out3 = await host.keyScreen(ed, { source: sl.id, layer: sl, hint: "none", screen: "green" });
const rf3 = out3.refine;
ok(rf3 && !rf3.fallback && rf3.guideDiff <= 1, "a layer source: refined, no fallback", rf3);
const e3 = errs(out3.layer);
ok(e3.refined < 0.6 * e3.bilinear, "a layer source: the refined mask nearer the edge", e3);
await ed.undoStep();
ed.layers.splice(ed.layers.indexOf(sl), 1);
ed.layersRestacked();
await run("close_document", { doc: d.id, force: true });
host.shell.activate(ednow(window.__keyDoc));
return { bucket: plan.bucket, refine: rf, layerRefine: rf3, err: { refined: e1.refined, bilinear: e1.bilinear }, layerErr: { refined: e3.refined, bilinear: e3.bilinear } };
"""),

    ("restore", r"""
const ed = ednow(window.__keyDoc);
host.shell.activate(ed);
const L = ed.layers.find((l) => l.id === window.__keyLayer);
await ed.syncLayers();
const v = ed.getValue();
const ed2 = host.shell.newDocument();
host.shell.activate(ed2);
await wait(300);
await ed2.setValue(v);
for (let t = 0; t < 100 && ed2.layers.length < ed.layers.length; t++) await wait(100);
await wait(400);
const L2 = ed2.layers.find((l) => l.name === "Key");
ok(L2 && L2.maskPx, "the key layer and its mask come back", ed2.layers.map((l) => l.name));
ok(L2.x === L.x && L2.y === L.y && L2.w === L.w && L2.h === L.h, "at its box");
const a = rect(L.px, L.w, L.h), b = rect(L2.px, L2.w, L2.h), ma = rect(L.maskPx, L.w, L.h), mb = rect(L2.maskPx, L2.w, L2.h);
let dp = 0, dm = 0;
for (let i = 0; i < a.length; i++) { dp = Math.max(dp, Math.abs(a[i] - b[i])); }
for (let i = 3; i < ma.length; i += 4) dm = Math.max(dm, Math.abs(ma[i] - mb[i]));
ok(dp === 0 && dm === 0, "the same pixels and mask", [dp, dm]);
ok(!L2.key, "the key record is the session's only (not stored)");
ok(host.isKeyLayer(L2), "still a key layer by its name and mask");
const plan = host.keyPlan(ed2, { rekey: true, layer: L2 });
ok(plan.fromBounds && plan.rekey, "Re-key falls back to the layer's bounds", plan);
const G2 = ed2.layers.find((l) => l.name === "Grey");
ok(G2 && G2.params.color === "#808080", "the grey layer comes back grey");
await run("close_document", { doc: ed2.node.id, force: true });
host.shell.activate(ed);
return { box: plan.box };
"""),

    ("rekey read", r"""
const ed = ednow(window.__keyDoc);
const L = ed.layers.find((l) => l.id === window.__keyLayer);
const plan = host.keyPlan(ed, { rekey: true, layer: L });
ok(!plan.fromBounds && plan.box.join() === "0,0,512,512" && plan.from === "the picture under the key", "Re-key keys the record's box and reads the picture under the key", plan);
// the engine still holds the features under the record's hash: nothing is read (§4.5)
const n0 = preps().length;
const held = await host.keyPrepare(ed, plan, { rekey: true, layer: L });
ok(held.held && held.image === null && held.hash === L.key.hash && preps().length === n0, "features held: Re-key reads nothing", { held: held.held, n: preps().length - n0 });
// the engine dropped them: the picture under the key is read, the key layer's own pixels (magenta here) are not in it
const keep = rect(L.px, L.w, L.h).slice();
fill(L, [230, 20, 230, 255]); ed.markLayerChanged(L);
stub.prepared.clear();
const cv = ed.compositeVersion, vis = ed.layers.map((l) => l.visible).join();
const prep = await host.keyPrepare(ed, plan, { rekey: true, layer: L });
const c = preps().pop();
ok(!prep.held && c.magenta === 0 && c.centre[1] > 150 && c.centre[0] < 30, "the engine got the picture under the key (the green base), not the key's own pixels", c);
ok(ed.compositeVersion === cv && ed.layers.map((l) => l.visible).join() === vis, "nothing hidden or shown for the read", [cv, ed.compositeVersion]);
ok(host.keyUpTo(ed, L) === ed.layers.findIndex((l) => l.id === window.__keyGrey), "upTo is the grey layer's index");
L.px.writeRect(new ImageData(new Uint8ClampedArray(keep), L.w, L.h), 0, 0); ed.markLayerChanged(L);
return { key: prep.key, magenta: c.magenta };
"""),

    ("rekey layer", r"""
// a key of a layer (a subject on a blue plate, transparent margins): Auto tells the screen from the layer's own pixels;
// the Key hides the layer, so a Re-key must read the layer, not the picture under the key (the green base)
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 512, height: 512 });
await greenBase(ed);
const src = ed.addPaintLayer();
src.name = "Subject";
fill(src, [10, 60, 200, 255], 64, 0, 448, 512);
ed.markLayerChanged(src);
const out = await host.keyScreen(ed, { source: src.id, layer: src, hint: "none", screen: "auto" });
const p0 = preps().pop(), r0 = runs().pop();
ok(r0.screen === "blue", "Auto on a layer: the screen from its opaque pixels, not the fill", r0);
ok(p0.px[2] > 150 && p0.px[1] < 100, "the transparent margins are read on the blue screen's colour", p0.px);
const K1 = out.layer;
ok(K1 && src.visible === false && K1.key.source === src.id && K1.key.screen === "blue", "the key above the hidden source, its record names the source", K1 && K1.key);
// Re-key with the features held: nothing read, the record's screen
let n0 = preps().length;
ed.activeLayerId = K1.id;
await host.keyScreen(ed, { rekey: true, layer: K1 });
ok(preps().length === n0 && runs().pop().screen === "blue", "Re-key, features held: nothing read, keyed on the record's screen", { n: preps().length - n0 });
// the engine dropped them: the hidden source is read (blue at the centre), not the green base under the key
stub.prepared.clear();
n0 = preps().length;
await host.keyScreen(ed, { rekey: true, layer: K1 });
let c = preps().pop();
ok(preps().length === n0 + 1 && c.centre[2] > 150 && c.centre[1] < 100, "Re-key reads the hidden source layer", c);
ok(K1.key.source === src.id, "a Re-key keeps the original source in its record");
// after a restart (no record): the hidden pixel layer directly below the key, and the box line says so
K1.key = undefined;
const plan = host.keyPlan(ed, { rekey: true, layer: K1 });
ok(plan.fromBounds && plan.from === "Subject (hidden)" && /read from Subject \(hidden\)/.test(K.boxLine(plan)), "after a restart Re-key reads the hidden layer below and says so", plan);
await host.keyScreen(ed, { rekey: true, layer: K1 });
c = preps().pop();
ok(c.centre[2] > 150 && c.centre[1] < 100, "after a restart: the hidden layer below is read", c);
// another screen for a layer source is another picture
const r2 = await host.keyRead(ed, host.keyPlan(ed, { source: src.id, layer: src, hint: "none" }), { source: src.id, layer: src, screen: "green" });
ok(r2.image[1] > 150 && r2.image[2] < 100, "Screen Green reads the margins on green", Array.from(r2.image.slice(0, 4)));
await run("close_document", { doc: d.id, force: true });
host.shell.activate(ednow(window.__keyDoc));
return { screen: r0.screen };
"""),

    ("rekey", r"""
const ed = ednow(window.__keyDoc);
const L = ed.layers.find((l) => l.id === window.__keyLayer);
const p0 = Array.from(rect(L.px, L.w, L.h)), m0 = Array.from(rect(L.maskPx, L.w, L.h)), r0 = [L.x, L.y, L.w, L.h];
const u0 = ed.undo.length;
const out = await host.keyScreen(ed, { rekey: true, layer: L });
const c = stub.calls[stub.calls.length - 1];
ok(c.op === "run" && c.hint && c.quality === 0.95, "the mask went as the hint at 0.95", c);
ok(out.layer === L && ed.undo.length === u0 + 1, "the same layer, one undo step", [ed.undo.length, u0]);
ok(/^Re-key: /.test(ed.status), "the status says Re-key", ed.status);
await ed.undoStep();
const L1 = ed.layers.find((l) => l.id === window.__keyLayer);
const p1 = Array.from(rect(L1.px, L1.w, L1.h)), m1 = Array.from(rect(L1.maskPx, L1.w, L1.h));
let dp = 0, dm = 0;
for (let i = 0; i < p0.length; i++) dp = Math.max(dp, Math.abs(p0[i] - p1[i]));
for (let i = 3; i < m0.length; i += 4) dm = Math.max(dm, Math.abs(m0[i] - m1[i]));
ok([L1.x, L1.y, L1.w, L1.h].join() === r0.join() && dp === 0 && dm === 0 && p0.length === p1.length, "one undo restores the pixels and the mask", { dp, dm, r: [L1.x, L1.y, L1.w, L1.h], r0 });
return { ok: true };
"""),

    ("cancel", r"""
const ed = ednow(window.__keyDoc);
const n0 = ed.layers.length;
stub.delay = 600;
const c0 = stub.cancels;
const p = host.keyScreen(ed, { source: "picture", hint: "none", screen: "green" });
await wait(120);
ok(ed.providerPending && ed.providerPending.provider === "key", "the key holds the document like a run");
const tc = performance.now();
const cancelled = host.cancelRuns(ed);
// the document goes free at once, not when the engine answers
ok(!ed.providerPending && !host._keyBusy && !host.runsOf(ed).length, "a Cancel lets the document go at once", { pending: !!ed.providerPending, busy: !!host._keyBusy });
let msg = "";
try { await p; } catch (err) { msg = err.message; }
const took = performance.now() - tc;
ok(cancelled.length === 1 && msg === K.TEXTS.cancelled && took < 300, "the title row's Cancel ends it before the engine answers", { msg, took });
ok(stub.cancels === c0 + 1, "the engine is told to stop", stub.cancels - c0);
await wait(650);
stub.delay = 0;
ok(ed.layers.length === n0 && !ed.providerPending && !host._keyBusy, "the late answer adds nothing, the document free");
stub.fail = "the keyer process died";
try { await host.keyScreen(ed, { source: "picture", hint: "none", screen: "green" }); msg = ""; } catch (err) { msg = err.message; }
stub.fail = "";
ok(/the keyer stopped: the keyer process died/.test(msg) && ed.statusKind === "error" && ed.layers.length === n0, "the engine dying is one red sentence, nothing added", [msg, ed.statusKind]);
return { msg };
"""),

    ("export", r"""
const ed = ednow(window.__keyDoc);
const L = ed.layers.find((l) => l.id === window.__keyLayer);
const { readPsd, readOra } = await import("./editor/inpaint_layered.js");
const r = await ed.exportLayeredBands("psd");
let blob = r && r.blob;
if (!blob) { const { buildLayered } = await import("./editor/inpaint_jobs.js"); const { layers } = ed.exportLayerStack("psd"); blob = await buildLayered("psd", { width: 512, height: 512, layers, composite: ed.flattenToCanvas({ forRun: true }) }); }
const back = await readPsd(new Uint8Array(await blob.arrayBuffer()));
const kl = back.layers.find((l) => l.name === "Key");
ok(kl && kl.mask && kl.mask.data, "PSD: the Key layer with its mask", back.layers.map((l) => [l.name, !!l.mask]));
const r2 = await ed.exportLayeredBands("ora");
let blob2 = r2 && r2.blob;
if (!blob2) { const { buildLayered } = await import("./editor/inpaint_jobs.js"); const { layers } = ed.exportLayerStack("ora"); blob2 = await buildLayered("ora", { width: 512, height: 512, layers, composite: ed.flattenToCanvas({ forRun: true }) }); }
const back2 = await readOra(new Uint8Array(await blob2.arrayBuffer()), { inflateRaw: async (data) => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()) });
ok(back2.layers.some((l) => l.name === "Key"), "ORA: the Key layer", back2.layers.map((l) => l.name));
const flat = ed.flattenToCanvas({ forRun: false });
const at = (x, y) => Array.from(flat.getContext("2d").getImageData(x, y, 1, 1).data);
const mid = at(256, 256), corner = at(4, 4);
flat.width = flat.height = 0;
ok(mid[1] > 150 && mid[0] < 30, "the picture: the key's own colour in the matte", mid);
ok(Math.abs(corner[0] - 128) <= 1 && Math.abs(corner[1] - 128) <= 1 && Math.abs(corner[2] - 128) <= 1, "the picture: grey outside the matte", corner);
return { psd: back.layers.length, ora: back2.layers.length, mid, corner };
"""),

    ("dialog", r"""
engineOn(); closeDialog();
const ed = ednow(window.__keyDoc2);
host.shell.activate(ed);
const M = window.__keyDialogMod;
const n0 = ed.layers.length;
ed.activeLayerId = null;   // no key layer active: the selection flow, not Re-key
await run("select_rect", { doc: ed.node.id, x: 600, y: 350, w: 300, h: 300 });
const runs0 = stub.calls.filter((c) => c.op === "run").length;
const dlg = await M.openKeyDialog(ed);
for (let t = 0; t < 60 && !(dlg.session && dlg.session.matte); t++) await wait(50);
let st = dlg.state();
ok(st.session && st.session.prepared && st.session.ticket >= 1, "the dialog prepared the picture and shows the first matte", st);
ok(host.keySession === dlg.session, "its session is host.keySession");
ok(st.rows.screenRow && st.rows.hintRow && st.rows.trustRow && st.rows.previewRow && !st.keyDisabled, "the in-app rows, Key enabled", st.rows);
const box0 = st.session.box.slice();
// the values reach the engine
dlg.els.despill.value = "0.8"; dlg.els.despill.dispatchEvent(new Event("input")); dlg.els.despill.dispatchEvent(new Event("change"));
dlg.els.screen.value = "blue"; dlg.els.screen.dispatchEvent(new Event("change"));
await dlg.session.queue.idle(); await wait(80); await dlg.session.queue.idle();
let last = stub.calls.filter((c) => c.op === "run").pop();
ok(last.despill === 0.8 && last.screen === "blue", "Despill and Screen reach the engine's request", last);
dlg.els.screen.value = "green"; dlg.els.screen.dispatchEvent(new Event("change"));
await wait(60); await dlg.session.queue.idle();
// a scripted selection change: one preview with the new hint
const before = stub.calls.filter((c) => c.op === "run").length, sum0 = stub.calls.filter((c) => c.op === "run").pop().hintSum, t0 = dlg.session.matte.ticket;
await run("select_rect", { doc: ed.node.id, x: 650, y: 380, w: 120, h: 120 });
for (let t = 0; t < 40 && dlg.session.matte.ticket === t0; t++) await wait(50);
await dlg.session.queue.idle();
const after = stub.calls.filter((c) => c.op === "run");
ok(after.length === before + 1 && after[after.length - 1].hintSum < sum0, "a selection change sends one preview with the new hint", { before, after: after.length, sum0, sum1: after[after.length - 1].hintSum });
st = dlg.state();
ok(st.session.ticket > t0 && st.session.box.join() === box0.join(), "the dialog's object holds the new matte with its ticket and the box", st.session);
// a dab burst through pluginPointer: one run in flight, one pending
stub.delay = 150;
let seen = { flying: 0, pending: 0 }, both = false;
const r0 = dlg.session.queue.runs;
for (let i = 0; i < 10; i++) {
    ed.pointer = { kind: "selpaint" };
    dlg.session.lastDab = 0;
    const took = host.pluginPointer(ed, "move", {}, 700, 400, null);
    ed.pointer = null;
    ok(took === false, "pluginPointer never takes the brush's event");
    await wait(20);
    const q = dlg.session.queue.state;
    if (q.flying && q.pending) both = true;
}
await dlg.session.queue.idle(); await wait(30); await dlg.session.queue.idle();
stub.delay = 0;
const burstRuns = dlg.session.queue.runs - r0;
ok(both && burstRuns <= 4 && dlg.session.queue.dropped >= 4, "ten dabs: one run in flight and one pending, the rest dropped", { both, burstRuns, dropped: dlg.session.queue.dropped });
ok(dlg.session.matte.ticket === dlg.session.queue.ticket, "the matte shown is the newest");
// a stale ticket is dropped
const sd = dlg.session.staleDropped;
ok(dlg.session.accept({ ticket: dlg.session.shown - 1, alpha: new Float32Array(4), fg: new Uint8Array(12) }) === false && dlg.session.staleDropped === sd + 1, "an answer older than the one shown is dropped");
// a mask stroke in progress sends nothing (the session follows the selection here)
const req0 = dlg.session.requests;
ed.pointer = { kind: "maskpaint" }; dlg.session.lastDab = 0; host.pluginPointer(ed, "move", {}, 700, 400, null); ed.pointer = null;
await wait(40);
ok(dlg.session.requests === req0, "a mask stroke's dab sends nothing");
// Key lands the matte shown (no new run) and closes the dialog
const runsBefore = stub.calls.filter((c) => c.op === "run").length, closed0 = stub.closedCount;
const out = await dlg.apply();
ok(out && out.layer && out.grey && ed.layers.length === n0 + 2, "Key lands the key and the grey layer", out && out.status);
ok(stub.calls.filter((c) => c.op === "run").length === runsBefore, "Key landed the matte the overlay showed, no new run");
ok(M.currentKeyDialog() === null && host.keySession === null && stub.closedCount === closed0 + 1, "the dialog closed, the overlay gone, the engine told");
window.__keyLayer2 = out.layer.id;
return { burstRuns, dropped: dlg.session ? dlg.session.queue.dropped : null, ticket: st.session.ticket };
"""),

    ("dialog rekey", r"""
engineOn(); closeDialog();
const ed = ednow(window.__keyDoc2);
const M = window.__keyDialogMod;
const L = ed.layers.find((l) => l.id === window.__keyLayer2);
ed.activeLayerId = L.id;
const dlg = await M.openKeyDialog(ed);
for (let t = 0; t < 60 && !(dlg.session && dlg.session.matte); t++) await wait(50);
ok(dlg.values.hint === "mask" && dlg.els.key.textContent === "Re-key", "a key layer active: the dialog offers Re-key with its mask", dlg.values);
const c0 = stub.calls.filter((c) => c.op === "run").pop();
ok(c0.hint && c0.quality === 0.95, "the mask is the hint at 0.95", c0);
ok(!dlg.state().rows.sourceRow, "no Source row for a Re-key");
// mid-stroke (the mask lives in a StrokeBuffer until pointer-up) nothing goes; at the stroke's end one run
const req0 = dlg.session.requests;
ed.pointer = { kind: "maskpaint" }; dlg.session.lastDab = 0; host.pluginPointer(ed, "move", {}, 700, 400, null); ed.pointer = null;
await wait(60);
ok(dlg.session.requests === req0, "not mid-stroke");
const { rectSource } = await import("./editor/inpaint_raster.js");
const m = L.maskPx.clone();
m.combine(rectSource([0, 0, Math.floor(L.w / 2), L.h]), "subtract");
L.maskPx = m;
const t0 = dlg.session.matte.ticket, sum0 = c0.hintSum;
ed.markMaskChanged(L);
for (let t = 0; t < 40 && dlg.session.matte.ticket === t0; t++) await wait(50);
await dlg.session.queue.idle();
const c1 = stub.calls.filter((c) => c.op === "run").pop();
ok(dlg.session.requests === req0 + 1 && c1.hintSum < sum0, "at the stroke's end the painted mask changes the engine's input", { r: dlg.session.requests - req0, sum0, sum1: c1.hintSum });
const u0 = ed.undo.length;
const p0 = Array.from(rect(L.px, L.w, L.h)), m0 = Array.from(rect(L.maskPx, L.w, L.h)), r0 = [L.x, L.y, L.w, L.h];
const out = await dlg.apply();
ok(out && out.layer === L && ed.undo.length === u0 + 1, "Re-key replaced the layer in one step");
await ed.undoStep();
const L1 = ed.layers.find((l) => l.id === L.id);
const p1 = Array.from(rect(L1.px, L1.w, L1.h)), m1 = Array.from(rect(L1.maskPx, L1.w, L1.h));
let d = p0.length === p1.length ? 0 : 999;
for (let i = 0; i < p0.length && !d; i++) if (p0[i] !== p1[i]) d++;
for (let i = 3; i < m0.length && !d; i += 4) if (m0[i] !== m1[i]) d++;
ok(!d && [L1.x, L1.y, L1.w, L1.h].join() === r0.join(), "one Ctrl+Z restores pixels and mask", d);
return { ok: true };
"""),

    ("dialog follow", r"""
// real selection-brush dabs on an empty selection with the dialog open: the hint follows the stroke before pointer-up
engineOn(); closeDialog(); stub.delay = 0;
const ed = ednow(window.__keyDoc2);
host.shell.activate(ed);
const M = window.__keyDialogMod;
await run("select_none", { doc: ed.node.id });
ed.activeLayerId = null;
const dlg = await M.openKeyDialog(ed);
ok(await waitFor(() => dlg.session && dlg.session.matte), "the first matte (no hint)", dlg.state());
const s = dlg.session;
// Refit restarts the session but the dialog stays open: the engine's idle timer does not start
const closed0 = stub.closedCount;
dlg.els.refit.click();
ok(await waitFor(() => dlg.session && dlg.session !== s && dlg.session.matte), "Refit: a new session with its matte");
ok(stub.closedCount === closed0, "Refit does not tell the engine the dialog closed", stub.closedCount - closed0);
const tool0 = ed.tool, size0 = ed.brushSize;
ed.setTool("select");
ed.brushSize = 60;
const e0 = ev(ed, 700, 500);
const back = ed.toImage(e0);
ok(Math.abs(back[0] - 700) < 2 && Math.abs(back[1] - 500) < 2, "the test's pointer events land where they should", back);
const mark = stub.calls.length;
ed.onPointerDown(e0);
ok(ed.pointer && ed.pointer.kind === "selpaint", "a selection-brush stroke", ed.pointer && ed.pointer.kind);
for (let i = 1; i <= 8; i++) { ed.onPointerMove(ev(ed, 700 + i * 20, 500 + i * 5)); await wait(55); }
await dlg.session.queue.idle(); await wait(30);
const during = stub.calls.slice(mark).filter((c) => c.op === "run" && !c.gone);
ok(during.length >= 2 && during.every((c) => c.hint && c.hintSum > 0), "every run during the stroke carries the painted hint", during.map((c) => [c.hint, c.hintSum]));
ok(during[during.length - 1].hintSum > during[0].hintSum, "the hint grows with the stroke", during.map((c) => c.hintSum));
ed.onPointerUp(ev(ed, 860, 540));
await wait(80); await dlg.session.queue.idle();
ed.setTool(tool0); ed.brushSize = size0;
// the engine dropped the features (its idle timer, freeHelpers before a local ComfyUI run): prepared again, the run goes on
stub.prepared.clear();
const t0 = dlg.session.matte.ticket, rp0 = dlg.session.reprepared;
await run("select_rect", { doc: ed.node.id, x: 650, y: 380, w: 200, h: 160 });
ok(await waitFor(() => dlg.session.matte.ticket > t0), "a matte after the features were gone", dlg.state());
ok(dlg.session.reprepared === rp0 + 1 && stub.prepared.has(dlg.session.prep.key), "the kept picture was prepared again", dlg.state().session);
closeDialog();
ok(stub.closedCount === closed0 + 1, "the dialog's own close tells the engine, once", stub.closedCount - closed0);
await run("select_none", { doc: ed.node.id });
return { during: during.map((c) => c.hintSum) };
"""),

    ("dialog values", r"""
// Trust changed with Preview off: Key runs once more at the new trust (not the matte shown); Key's final run is never
// replaced by the previews asked while it waits
engineOn(); closeDialog(); stub.delay = 0;
const ed = ednow(window.__keyDoc2);
host.shell.activate(ed);
const M = window.__keyDialogMod;
ed.activeLayerId = null;
await run("select_rect", { doc: ed.node.id, x: 600, y: 350, w: 300, h: 300 });
const n0 = ed.layers.length;
let dlg = await M.openKeyDialog(ed);
ok(await waitFor(() => dlg.session && dlg.session.matte), "the first matte", dlg.state());
ok(dlg.session.matte.quality === dlg.values.trust, "the matte carries its trust");
dlg.els.preview.checked = false; dlg.els.preview.dispatchEvent(new Event("change"));
dlg.els.trust.value = "0.95"; dlg.els.trust.dispatchEvent(new Event("change"));
ok(!dlg.session.matte, "a value changed with Preview off drops the matte shown");
let before = runs().length;
let out = await dlg.apply();
ok(out && out.layer && runs().length === before + 1 && runs().pop().quality === 0.95, "Key ran at the new trust", runs().pop());
ok(/\(clean\)/.test(ed.status), "the status names the trust it ran at", ed.status);
await ed.undoStep();
ok(ed.layers.length === n0, "undone");
await host.setKeyValues({ preview: true, trust: 0.5 });
// the final run waits behind a preview while dabs and a selection change ask for more
dlg = await M.openKeyDialog(ed);
ok(await waitFor(() => dlg.session && dlg.session.matte), "the first matte again");
stub.delay = 200;
await run("select_rect", { doc: ed.node.id, x: 610, y: 360, w: 280, h: 280 });
await waitFor(() => dlg.session.queue.state.flying, 1000);
const pk = dlg.apply();
await wait(30);
for (let i = 0; i < 6; i++) { ed.pointer = { kind: "selpaint" }; dlg.session.lastDab = 0; host.pluginPointer(ed, "move", {}, 700, 400, null); ed.pointer = null; await wait(15); }
await run("select_rect", { doc: ed.node.id, x: 620, y: 370, w: 260, h: 260 });
let err = "";
try { out = await pk; } catch (e) { err = e.message; }
stub.delay = 0;
ok(!err && out && out.layer && ed.layers.length === n0 + 2, "Key landed although previews were asked while it waited", { err, n: ed.layers.length - n0 });
await ed.undoStep();
await run("select_none", { doc: ed.node.id });
return { ok: true };
"""),

    ("dialog geometry", r"""
// the panel is not modal: a turn of the picture re-plans the box, an edit under it is prepared again at Key, another tab
// closes it
engineOn(); closeDialog(); stub.delay = 0;
const M = window.__keyDialogMod;
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { doc: d.id, width: 768, height: 512 });
await greenBase(ed);
let dlg = await M.openKeyDialog(ed);
ok(await waitFor(() => dlg.session && dlg.session.matte), "the first matte", dlg.state());
ok(dlg.session.plan.box.join() === "0,0,768,512", "the whole picture", dlg.session.plan.box);
await run("rotate_canvas", { doc: d.id, angle: 90 });
ok(await waitFor(() => dlg.geometryRestarts === 1 && dlg.session && dlg.session.prep && dlg.session.plan.box.join() === "0,0,512,768"), "a turn re-plans the box and prepares again", { r: dlg.geometryRestarts, box: dlg.session && dlg.session.plan && dlg.session.plan.box });
await waitFor(() => dlg.session.matte);
// an edit under the open panel: Key reads the picture again and keys the new one
const l = ed.addPaintLayer();
fill(l, [230, 20, 230, 255], 0, 0, 200, 200); ed.markLayerChanged(l);
await wait(100);
const p0 = preps().length;
const out = await dlg.apply();
const c = preps().pop();
ok(out && out.layer && preps().length === p0 + 1 && c.magenta > 0, "Key prepared the edited picture once more", { n: preps().length - p0, magenta: c.magenta });
await ed.undoStep();
// another tab in front closes the panel
dlg = await M.openKeyDialog(ed);
await waitFor(() => dlg.session && dlg.session.prep);
host.shell.activate(ednow(window.__keyDoc2));
ok(dlg.closed && M.currentKeyDialog() === null && host.keySession === null, "another tab closes the panel");
await run("close_document", { doc: d.id, force: true });
return { ok: true };
"""),

    ("dialog states", r"""
engineOn(); closeDialog();
const ed = ednow(window.__keyDoc2);
const M = window.__keyDialogMod;
ed.activeLayerId = null;
engineOff();
let dlg = await M.openKeyDialog(ed);
let st = dlg.state();
// no engine in the build (and no server: the gate is offline): the route is your ComfyUI alone, no live preview, Key
// greyed with what it needs
ok(st.values.route === "comfyui" && st.routeFixed && st.rows.routeRow && !st.rows.previewRow && st.rows.screenRow && st.keyDisabled && st.ready === K.serverSupport({ state: "disconnected" }).reason && !dlg.session && host.keySession === null, "no engine in the build: your ComfyUI's route alone, Key greyed, the reason", st);
dlg.close();
engineOn();
stub.present = false;
dlg = await M.openKeyDialog(ed);
st = dlg.state();
ok(st.keyDisabled && st.ready === K.TEXTS.notDownloaded && !dlg.els.settings.hidden && !dlg.session, "the set missing: the download sentence, Settings › Helpers, Key greyed", st);
const terms = dlg.els.terms;
ok(!terms.hidden && /C-RADIOv4/.test(terms.textContent) && /MoGe-2/.test(terms.textContent) && /RVM/.test(terms.textContent) && /US \$20M/.test(terms.textContent) && !dlg.els.download.hidden, "the first-run block: the parts, their licences, the seat clause, Download", terms.textContent.slice(0, 120));
// Download hands over to the engine's download (I2's terms dialog) where there is one
let asked = 0;
stub.download = () => { asked++; };
dlg.els.download.click();
delete stub.download;
ok(asked === 1, "Download asks keyEngine.download");
dlg.close();
stub.present = true;
// the CPU runs the set: no live preview, Key keys once
stub.provider = "cpu";
await run("select_rect", { doc: ed.node.id, x: 600, y: 350, w: 300, h: 300 });
const r0 = runs().length, n0 = ed.layers.length;
dlg = await M.openKeyDialog(ed);
ok(await waitFor(() => dlg.session && dlg.session.prep), "prepared on the CPU");
await wait(300);
st = dlg.state();
ok(runs().length === r0 && !st.rows.previewRow && !st.session.preview && /CPU/.test(st.ready), "on the CPU: no preview run, no Preview row", { runs: runs().length - r0, st });
const out = await dlg.apply();
ok(out && out.layer && runs().length === r0 + 1, "Key keys once on the CPU", runs().length - r0);
await ed.undoStep();
ok(ed.layers.length === n0, "undone");
stub.provider = "stub";
await run("select_none", { doc: ed.node.id });
return { ok: true };
"""),

    ("command", r"""
engineOn(); closeDialog(); stub.present = true; stub.delay = 0; stub.fail = "";
const ed = ednow(window.__keyDoc2);
host.shell.activate(ed);
await run("select_none", { doc: ed.node.id });
const n0 = ed.layers.length;
const s0 = (await run("status", { doc: ed.node.id })).key;
ok(s0 && s0.ready === true && s0.provider === "stub" && s0.working_size === 512, "status.key: ready on the stub", s0);
const r = await run("key_screen", { doc: ed.node.id, hint: "none", screen: "green", grey: true });
ok(r.layer && r.layer.name === "Key" && r.grey && ed.layers.length === n0 + 2 && /^Key: /.test(r.status), "key_screen lands the key and the grey layer", r);
ok(r.box && r.workingSize === 512 && r.provider === "stub", "with its box, working size and provider", r);
await ed.undoStep();
ok(ed.layers.length === n0, "one undo");
await run("select_rect", { doc: ed.node.id, x: 700, y: 400, w: 100, h: 100 });
const pv = await run("key_screen", { doc: ed.node.id, preview: true });
ok(!pv.layer && ed.layers.length === n0 && pv.preview && pv.selection, "preview: nothing added, the matte is the selection", pv);
const b = ed.getBounds();
ok(b && b[0] >= pv.matte_box[0] - 1 && b[2] <= pv.matte_box[2] + 1, "the selection inside the matte's box", { b, mb: pv.matte_box });
const r2 = await run("key_screen", { doc: ed.node.id, hint: "none", grey: false });
const rk = await run("key_screen", { doc: ed.node.id, rekey: true, layer: r2.layer.id });
ok(rk.layer && rk.layer.id === r2.layer.id && stub.calls.filter((c) => c.op === "run").pop().quality === 0.95, "rekey re-keys the layer from its mask", rk);
// hint "mask": a first key with the source layer's own mask as a soft hint (0.95 unless trust says otherwise)
const ml = ed.addPaintLayer();
ml.name = "Masked";
fill(ml, [0, 177, 64, 255]); ed.markLayerChanged(ml);
await run("select_rect", { doc: ed.node.id, x: 650, y: 380, w: 200, h: 200 });
await run("set_mask", { doc: ed.node.id, layer: ml.id, op: "from_selection" });
await run("select_none", { doc: ed.node.id });
const n1 = ed.layers.length;
const mk = await run("key_screen", { doc: ed.node.id, source: ml.id, hint: "mask" });
const lastRun = runs().pop();
ok(mk.layer && lastRun.hint && lastRun.hintSum > 0 && lastRun.quality === 0.95 && ed.layers.length === n1 + 1, "hint mask: the source layer's mask went as the hint at 0.95", { lastRun, layer: mk.layer });
await ed.undoStep();
let mmsg = "";
try { await run("key_screen", { doc: ed.node.id, hint: "mask" }); } catch (err) { mmsg = err.message; }
ok(mmsg === K.TEXTS.maskHint, "hint mask with the picture as the source is refused", mmsg);
ed.layers.splice(ed.layers.findIndex((l) => l.id === ml.id), 1); ed.layersRestacked();
engineOff();
const s1 = (await run("status", { doc: ed.node.id })).key;
let msg = "";
try { await run("key_screen", { doc: ed.node.id, route: "app" }); } catch (err) { msg = err.message; }
engineOn();
ok(s1.ready === false && msg === K.TEXTS.notInstalled, "without the engine: status.key and key_screen say why", [s1, msg]);
return { s0, layer: r.layer.id };
"""),

    ("comfy setup", r"""
// Route B (B2, docs/PLAN_CORRIDORKEY.md §4.11): your ComfyUI stood in for. A connected server with an RTX 5090, pack A's
// node list as /object_info gave it (tools/refs/corridorkey), the uploads kept and decoded, and comfyPictureRun answering
// B0's fixture (tools/fixtures/corridorkey_routeb: the real rgba answers of pack A at c7662de) for the picture that went
const F = __FIXDIR__;
const KP = await import("./editor/inpaint_png.js");
const readFile = async (p) => new Uint8Array((await window.scumble.file.read(p)).data);
const decode = async (bytes) => {
    let w = 0, h = 0, data = null;
    await KP.readPng(new Blob([bytes]), { onHeader: (hd) => { w = hd.width; h = hd.height; data = new Uint8Array(w * h * 4); }, onRows: (rgba, y0, rows) => { data.set(rgba.subarray(0, rows * w * 4), y0 * w * 4); } });
    return { w, h, data };
};
const json = async (p) => JSON.parse(new TextDecoder().decode(await readFile(p)));
const refs = F + "/../../refs/corridorkey/";
const fx = {
    dir: F, input: await decode(await readFile(F + "/input.png")), hint: await decode(await readFile(F + "/hint.png")),
    rgbaBytes: await readFile(F + "/rgba.png"), halfBytes: await readFile(F + "/half_rgba.png"), graph: await json(F + "/graph.json"),
};
fx.rgba = await decode(fx.rgbaBytes);
fx.half = await decode(fx.halfBytes);
const info = { ...(await json(refs + "CorridorKey2Basic.json")), ...(await json(refs + "CorridorKey2ModelLoader.json")) };
for (const c of ["InpaintCanvas", "InpaintCanvasLoadRef", "ImageToMask", "PreviewImage"]) info[c] = { input: { required: {} }, output: [] };
fx.info = info;
window.__ckFix = fx;
window.__ckDecode = decode;
const cs = {
    calls: [], uploads: [], delay: 0, fail: "", answer: null, cancelSeen: 0,
    async upload(blob, name) {
        const img = await decode(new Uint8Array(await blob.arrayBuffer()));
        this.uploads.push({ name, img });
        return { filename: name, subfolder: "inpaint_canvas", type: "input" };
    },
    async run(editor, prompt, output, opts) {
        const t = opts.token;
        this.calls.push({ prompt: JSON.parse(JSON.stringify(prompt)), output, label: opts.label, timeoutMs: opts.timeoutMs, front: opts.front, deadline: opts.deadline, token: t });
        const gone = () => { if (t && t.cancelled) { this.cancelSeen++; throw Object.assign(new Error(`${opts.label} cancelled.`), { kind: "cancelled" }); } };
        for (let waited = 0; waited < this.delay; waited += 25) { gone(); await new Promise((r) => setTimeout(r, 25)); }
        gone();
        if (this.fail) throw Object.assign(new Error(this.fail), { kind: "error", nodeType: "CorridorKey2ModelLoader" });
        const name = JSON.parse(prompt.ck_in.inputs.ref).filename;
        const pic = this.uploads.find((u) => u.name === name);
        const bytes = this.answer || (pic && pic.img.w === 256 ? fx.halfBytes : fx.rgbaBytes);
        return { bytes, mime: "image/png", seconds: 0.2, promptId: "ck-stub-" + this.calls.length };
    },
};
window.__comfyStub = cs;
window.__comfy0 = { server: host.server, objectInfo: host.objectInfo, comfyPictureRun: host.comfyPictureRun, uploadInput: host.uploadInput, keyComfyFit: host.keyComfyFit };
ok(fx.input.w === 512 && fx.input.h === 400 && fx.rgba.w === 512 && fx.half.w === 256 && fx.half.h === 200, "B0's fixture read", [fx.input.w, fx.input.h, fx.half.w, fx.half.h]);
return { calls: 0, nodes: Object.keys(fx.graph).length };
"""),

    ("comfy native", r"""
const C = window.__comfyStub, fx = window.__ckFix;
comfyOn(); engineOff();
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await run("load_image", { doc: d.id, path: fx.dir + "/input.png" });
ok(ed.width === 512 && ed.height === 400, "the fixture's picture", [ed.width, ed.height]);
window.__ckDoc = d.id;
// B0's soft brush hint as the selection (white = subject)
const { bytesSource } = await import("./editor/inpaint_raster.js");
const hp = new Uint8Array(512 * 400);
for (let i = 0; i < hp.length; i++) hp[i] = fx.hint.data[i * 4];
ed.sel.clear(); ed.sel.combine(bytesSource(hp, 0, 0, 512, 400), "add"); ed.markSelectionChanged({ within: [0, 0, 512, 400] }, [0, 0, 512, 400]);
ok(host.keyRoute() === "comfyui" && host.keyComfySupport().ok && host.keyComfySupport().pack === "marawan206", "no in-app engine: the route is your ComfyUI, pack A", host.keyComfySupport());
const n0 = ed.layers.length, u0 = ed.undo.length, up0 = C.uploads.length, c0 = C.calls.length;
const out = await host.keyScreen(ed, { hint: "selection", trust: 0.5, screen: "green", despill: 0.5 });
const L = out.layer, G = out.grey;
ok(out.route === "comfyui" && !out.scaled && out.sent.join() === "512,400" && out.box.join() === "0,0,512,400" && L && G, "keyed on your ComfyUI at its own size", out);
ok(C.uploads.length === up0 + 2 && C.calls.length === c0 + 1, "two uploads (the picture, the hint) and one job", [C.uploads.length - up0, C.calls.length - c0]);
const up = C.uploads[up0].img, uh = C.uploads[up0 + 1].img;
let dPic = 0, dHint = 0;
for (let i = 0; i < 512 * 400 * 4; i++) { if (up.data[i] !== fx.input.data[i]) dPic++; if (uh.data[i] !== fx.hint.data[i]) dHint++; }
ok(up.w === 512 && up.h === 400 && dPic === 0, "the picture that went is the fixture's input byte for byte", dPic);
ok(uh.w === 512 && uh.h === 400 && dHint === 0, "the hint that went is the fixture's hint byte for byte (grey, white = subject)", dHint);
// the queued graph is B0's (the plan's six nodes), with Scumble's uploads as the refs
const call = C.calls[c0];
const canon = (v) => (Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v));
const want = JSON.parse(JSON.stringify(fx.graph)), got = JSON.parse(JSON.stringify(call.prompt));
const refOf = (g, id) => JSON.parse(g[id].inputs.ref);
ok(canon(refOf(got, "ck_in")) === canon({ filename: C.uploads[up0].name, subfolder: "inpaint_canvas", type: "input" }) && refOf(got, "ck_hint_img").filename === C.uploads[up0 + 1].name, "the refs are the uploads", [refOf(got, "ck_in"), refOf(got, "ck_hint_img")]);
for (const g of [want, got]) { g.ck_in.inputs.ref = "<input>"; g.ck_hint_img.inputs.ref = "<hint>"; }
ok(canon(got) === canon(want), "the graph is B0's (auto_download false, loose hint (0.5), the rgba output)", { got: canon(got).slice(0, 300) });
ok(call.output === "ck_out" && call.front === true && call.timeoutMs === 300000 && call.label === "Key screen", "ck_out, at the queue's front, 300 s", { o: call.output, f: call.front, t: call.timeoutMs });
// the landing: the pack's answer exactly, trimmed to its matte
ok(ed.layers.length === n0 + 2 && ed.undo.length === u0 + 1 && ed.layers.indexOf(G) === ed.layers.indexOf(L) - 1, "a Key over a Grey layer, one undo step");
const A = new Float32Array(512 * 400);
for (let i = 0; i < A.length; i++) A[i] = fx.rgba.data[i * 4 + 3] / 255;
const mb = K.matteBox(A, 512, 400, [0, 0, 512, 400], [0, 0, 512, 400]);
ok(L.x === mb[0] && L.y === mb[1] && L.w === mb[2] - mb[0] && L.h === mb[3] - mb[1], "trimmed to the matte's box", { mb, L: [L.x, L.y, L.w, L.h] });
const px = rect(L.px, L.w, L.h), mk = rect(L.maskPx, L.w, L.h);
let offPx = 0, offA = 0, offRgb = 0;
for (let Y = 0; Y < L.h; Y++) for (let X = 0; X < L.w; X++) {
    const i = ((Y + L.y) * 512 + X + L.x) * 4, o = (Y * L.w + X) * 4;
    if (px[o] !== fx.rgba.data[i] || px[o + 1] !== fx.rgba.data[i + 1] || px[o + 2] !== fx.rgba.data[i + 2] || px[o + 3] !== 255) offPx++;
    if (mk[o + 3] !== fx.rgba.data[i + 3]) offA++;
    if (mk[o + 3] > 0 && (mk[o] !== 255 || mk[o + 1] !== 255 || mk[o + 2] !== 255)) offRgb++;
}
ok(offPx === 0 && offA === 0 && offRgb === 0, "the layer's pixels are the pack's colour, opaque; its mask the pack's alpha in white", { offPx, offA, offRgb });
ok(/^Key: [\d.]+ % of the box kept, in [\d.]+ s on your ComfyUI \(CorridorKey 2\.0 through ComfyUI-CorridorKey2\.0 on NVIDIA GeForce RTX 5090, green screen, hint from the selection \(rough\); at its own size, 512 × 400\)\. A grey layer sits under the Key layer/.test(ed.status), "the status line", ed.status);
ok(!ed.providerPending && !host._keyBusy && !host.runsOf(ed).length, "the document free");
ok(L.key && L.key.route === "comfyui" && L.key.box.join() === "0,0,512,400" && L.key.greyId === G.id, "the session's key record", L.key);
await ed.undoStep();
ok(ed.layers.length === n0, "one undo takes both back");
// no hint: four nodes, no alpha_hint, one upload
await run("select_none", { doc: d.id });
const up1 = C.uploads.length;
const out2 = await host.keyScreen(ed, { hint: "selection", screen: "green", grey: false });
const g2 = C.calls[C.calls.length - 1].prompt;
ok(out2.layer && !out2.grey && C.uploads.length === up1 + 1 && Object.keys(g2).sort().join() === "ck_in,ck_key,ck_model,ck_out" && !("alpha_hint" in g2.ck_key.inputs) && /no hint/.test(ed.status), "no selection: no hint, four nodes, one upload", { nodes: Object.keys(g2), status: ed.status });
await ed.undoStep();
await ed.redoStep();
await ed.undoStep();
// the first key again, for Re-key below
ed.sel.clear(); ed.sel.combine(bytesSource(hp, 0, 0, 512, 400), "add"); ed.markSelectionChanged({ within: [0, 0, 512, 400] }, [0, 0, 512, 400]);
const out3 = await host.keyScreen(ed, { hint: "selection", trust: 0.5, screen: "green" });
window.__ckKey = out3.layer.id;
return { box: out.box, matteBox: out.matteBox, kept: Math.round(out.kept), status: ed.status.slice(0, 160) };
"""),

    ("comfy rekey", r"""
// Re-key on your ComfyUI: the key layer's mask as the hint (clean matte (0.95)), the picture under the key (not the grey
// layer, not the key) as the picture; one layerfull step
const C = window.__comfyStub, fx = window.__ckFix;
comfyOn(); engineOff();
const ed = ednow(window.__ckDoc);
const L = ed.layers.find((l) => l.id === window.__ckKey);
ok(L && host.isKeyLayer(L), "the key layer");
await run("select_none", { doc: ed.node.id });
const u0 = ed.undo.length, n0 = ed.layers.length, up0 = C.uploads.length;
const mask0 = rect(L.maskPx, L.w, L.h), r0 = [L.x, L.y, L.w, L.h];
const out = await host.keyScreen(ed, { rekey: true, layer: L });
ok(out.layer === L && ed.layers.length === n0 && ed.undo.length === u0 + 1, "Re-key replaced the layer in one step", out);
const up = C.uploads[up0].img, uh = C.uploads[up0 + 1].img;
let dPic = 0, dHint = 0;
for (let i = 0; i < 512 * 400 * 4; i++) if (up.data[i] !== fx.input.data[i]) dPic++;
for (let Y = 0; Y < 400; Y++) for (let X = 0; X < 512; X++) {
    const inL = X >= r0[0] && Y >= r0[1] && X < r0[0] + r0[2] && Y < r0[1] + r0[3];
    const want = inL ? mask0[((Y - r0[1]) * r0[2] + X - r0[0]) * 4 + 3] : 0;
    if (uh.data[(Y * 512 + X) * 4] !== want) dHint++;
}
ok(dPic === 0, "the picture under the key went (no grey, no key)", dPic);
ok(dHint === 0, "the key layer's mask went as the hint", dHint);
const g = C.calls[C.calls.length - 1].prompt;
ok(g.ck_key.inputs.hint_quality === "clean matte (0.95)" && g.ck_hint.class_type === "ImageToMask", "trusted as a clean matte", g.ck_key.inputs);
ok(/^Re-key: .* on your ComfyUI .*hint from the layer's mask/.test(ed.status), "the status names the Re-key", ed.status);
await ed.undoStep();
const L1 = ed.layers.find((l) => l.id === L.id);
ok([L1.x, L1.y, L1.w, L1.h].join() === r0.join(), "one undo restores the layer");
return { status: ed.status.slice(0, 120) };
"""),

    ("comfy scaled", r"""
// a box above the cap goes scaled (here the 512 x 400 picture at 256 x 200, B0's half fixture) and its alpha is refined
// against the full-resolution picture (I6): the mask is keymatte.refineMatte's answer exactly, the colour bilinear
const C = window.__comfyStub, fx = window.__ckFix;
comfyOn(); engineOff();
const ed = ednow(window.__ckDoc);
host.shell.activate(ed);
await run("select_none", { doc: ed.node.id });
host.keyComfyFit = (w, h) => (w === 512 && h === 400 ? { w: 256, h: 200, scale: 0.5, scaled: true } : K.comfyFit(w, h, 16));
const up0 = C.uploads.length;
let out;
try { out = await host.keyScreen(ed, { hint: "none", screen: "green", grey: false }); } finally { host.keyComfyFit = window.__comfy0.keyComfyFit; }
const L = out.layer, rf = out.refine;
const up = C.uploads[up0].img;
ok(out.scaled && out.sent.join() === "256,200" && up.w === 256 && up.h === 200 && C.uploads.length === up0 + 1, "the box went at 256 x 200", { sent: out.sent, up: [up.w, up.h] });
ok(rf && !rf.fallback && !rf.error && rf.guideDiff != null && rf.guideDiff <= 1, "refined, no fallback: the full-resolution reads are the picture that went", rf);
ok(/keyed at 256 × 200 of its 512 × 400 and scaled back\)/.test(ed.status) && !/not refined|, refined/.test(ed.status), "the status says it went scaled, never \"refined\"", ed.status);
const n = 256 * 200, A = new Float32Array(n), FG = new Uint8Array(n * 3);
for (let i = 0; i < n; i++) { A[i] = fx.half.data[i * 4 + 3] / 255; FG[i * 3] = fx.half.data[i * 4]; FG[i * 3 + 1] = fx.half.data[i * 4 + 1]; FG[i * 3 + 2] = fx.half.data[i * 4 + 2]; }
const box = [0, 0, 512, 400], content = [0, 0, 256, 200];
const mb = K.matteBox(A, 256, 200, content, box);
ok(L.x === mb[0] && L.y === mb[1] && L.w === mb[2] - mb[0] && L.h === mb[3] - mb[1], "trimmed to the scaled matte's box", { mb, L: [L.x, L.y, L.w, L.h] });
const KM = await import("./editor/keymatte.js");
const rd = host.keyBandReader(ed, { layer: null, fill: null, upTo: ed.layers.indexOf(L) });
const want = await KM.refineMatte({
    alpha: A, aw: 256, ah: 200, small: { data: up.data, width: 256, height: 200 },
    src: { x: 0, y: 0, w: 256, h: 200 }, full: { w: 512, h: 400 }, out: { x: L.x, y: L.y, w: L.w, h: L.h },
    read: (b) => rd.read([L.x, L.y + b[1], L.x + L.w, L.y + b[3]]),
});
rd.done();
const mk = rect(L.maskPx, L.w, L.h), px = rect(L.px, L.w, L.h);
const lin = K.bilinearRows(A, FG, 256, K.sampleMap(mb, box, content), L.w, 0, L.h);
let offA = 0, offPx = 0, eR = 0, eB = 0;
for (let k = 0; k < L.w * L.h; k++) {
    if (mk[k * 4 + 3] !== want.alpha[k]) offA++;
    for (let c = 0; c < 3; c++) offPx = Math.max(offPx, Math.abs(px[k * 4 + c] - lin.rgba[k * 4 + c]));
    const X = L.x + (k % L.w), Y = L.y + Math.floor(k / L.w), t = fx.rgba.data[(Y * 512 + X) * 4 + 3];
    eR += Math.abs(mk[k * 4 + 3] - t); eB += Math.abs(lin.a[k] - t);
}
ok(offA === 0 && !want.fallback, "the mask is refineMatte's answer exactly", { offA, fallback: want.fallback });
ok(offPx <= 1, "the colour within a level of the bilinear rows", offPx);
await ed.undoStep();
// how near the native key each comes (reported: the hair edge of B0's fixture; I6's own tests judge the refine)
return { refine: rf, maeRefinedVsNative: Math.round((eR / (L.w * L.h)) * 100) / 100, maeBilinearVsNative: Math.round((eB / (L.w * L.h)) * 100) / 100 };
"""),

    ("comfy refusals", r"""
const C = window.__comfyStub, fx = window.__ckFix;
comfyOn(); engineOff();
const ed = ednow(window.__ckDoc);
const n0 = ed.layers.length, up0 = C.uploads.length, c0 = C.calls.length;
const tryKey = async (o) => { try { await host.keyScreen(ed, o || { hint: "none", screen: "green" }); return ""; } catch (err) { return err.message; } };
// not connected: what it needs, plain
host.server = { ...host.server, state: "disconnected" };
let msg = await tryKey({ route: "comfyui" });
ok(msg === K.serverSupport({ state: "disconnected" }).reason && ed.statusKind !== "error" && ed.statusKind !== "warn", "not connected: connect it, plain", [msg, ed.statusKind]);
comfyOn();
// a connected server without a pack: install one, in red
host.objectInfo = { InpaintCanvas: fx.info.InpaintCanvas };
msg = await tryKey();
ok(/needs a CorridorKey 2\.0 node pack on your ComfyUI: install one there/.test(msg) && ed.statusKind === "warn", "no pack: install one there", [msg, ed.statusKind]);
comfyOn();
// a run going on the document
ed.providerPending = { label: "x" };
msg = await tryKey();
ed.providerPending = null;
ok(msg === K.TEXTS.runGoing, "a run going refuses", msg);
ok(C.uploads.length === up0 && C.calls.length === c0 && ed.layers.length === n0, "nothing read, sent or added");
// the pack's own failure: the models missing on the ComfyUI machine (pack A's loader)
const missA = "CorridorKey 2.0 model files are missing:\n  F:\\Comfy\\models\\corridorkey2\\corridorkey_v2.safetensors\nEnable auto_download or see the README for the manual download steps.\n";
C.fail = missA;
msg = await tryKey();
C.fail = "";
ok(msg === K.hint(missA) && ed.statusKind === "error" && ed.layers.length === n0 && !ed.providerPending && !host._keyBusy, "the models missing: the files and how to fetch them, red, nothing added", [msg, ed.statusKind]);
// an answer of another size than what went
C.answer = fx.halfBytes;
msg = await tryKey();
C.answer = null;
ok(msg === "Key screen: your ComfyUI answered 256 × 200 for a picture of 512 × 400." && ed.statusKind === "error" && ed.layers.length === n0, "an answer of another size is refused", msg);
return { ok: true };
"""),

    ("comfy cancel", r"""
const C = window.__comfyStub;
comfyOn(); engineOff();
const ed = ednow(window.__ckDoc);
const n0 = ed.layers.length, c0 = C.calls.length;
C.delay = 4000;
const p = host.keyScreen(ed, { hint: "none", screen: "green" });
ok(await waitFor(() => C.calls.length === c0 + 1), "the job went");
ok(ed.providerPending && ed.providerPending.provider === "comfyui" && host.runsOf(ed).length === 1, "the key holds the document like a run, in the title row");
const tc = performance.now();
const cancelled = host.cancelRuns(ed);
let msg = "";
try { await p; } catch (err) { msg = err.message; }
const took = performance.now() - tc;
ok(cancelled.length === 1 && msg === K.TEXTS.cancelled && took < 1000 && C.cancelSeen >= 1, "the title row's Cancel takes the job off and ends the key", { msg, took });
ok(ed.layers.length === n0 && !ed.providerPending && !host._keyBusy && ed.statusKind !== "error", "nothing added, the document free, plain", ed.statusKind);
// a closed tab ends it too and adds nothing
const d2 = await run("new_document");
const e2 = ednow(d2.id);
await run("load_image", { doc: d2.id, path: window.__ckFix.dir + "/input.png" });
const p2 = host.keyScreen(e2, { hint: "none", screen: "green" });
ok(await waitFor(() => C.calls.length === c0 + 2), "the second job went");
await run("close_document", { doc: d2.id, force: true });
const r2 = await p2;
C.delay = 0;
ok(r2 && r2.layer === null && !host._keyBusy, "a closed tab: nothing landed", r2);
host.shell.activate(ed);
return { took: Math.round(took) };
"""),

    ("dialog comfy", r"""
// B3: the dialog's route row "Full resolution on your ComfyUI": no live loop (no session, nothing prepared, no run
// before Key), the box line follows the selection, the rows reach the graph, Key and Re-key run it once, the first-run
// block, the readiness line following the server
const C = window.__comfyStub, fx = window.__ckFix, M = window.__keyDialogMod;
comfyOn(); engineOff(); closeDialog();
const ed = ednow(window.__ckDoc);
host.shell.activate(ed);
ed.activeLayerId = null;
await host.setKeyValues({ ...K.keyDefaults, workingSize: 512 });
await run("select_rect", { doc: ed.node.id, x: 100, y: 100, w: 120, h: 80 });
const c0 = C.calls.length, s0 = stub.calls.length, n0 = ed.layers.length;
let dlg = await M.openKeyDialog(ed);
await wait(150);
let st = dlg.state();
ok(st.values.route === "comfyui" && st.routeFixed && st.rows.routeRow, "the route row: your ComfyUI, the only one in this build", st.values);
ok(!st.rows.previewRow && st.rows.keepRow && !st.rows.evictsRow && st.rows.timeoutRow && st.rows.screenRow && st.rows.hintRow && st.rows.trustRow && st.rows.sourceRow, "no Preview row; pack A's keep tick and the wait shown", st.rows);
ok(!dlg.session && host.keySession === null && C.calls.length === c0 && stub.calls.length === s0, "no live loop: no session, nothing prepared or run before Key");
ok(st.ready.startsWith("CorridorKey 2.0 on your ComfyUI through ComfyUI-CorridorKey2.0 on NVIDIA GeForce RTX 5090.") && st.ready.includes(K.COMFY_COST) && !st.keyDisabled, "the readiness line: the pack, the card, what a key costs there", st.ready);
ok(st.boxLine === "Keys the selection's box, 512 × 400, at its own size." && st.firstRun === K.comfyFirstRun("marawan206") && /download_models\.py/.test(st.firstRun) && /No live preview/.test(st.loop), "the box line, the first-run block, no live preview", st);
// the box line follows the selection, still nothing runs
await run("select_none", { doc: ed.node.id });
await wait(80);
ok(dlg.state().boxLine === "Keys the whole picture, 512 × 400, at its own size." && C.calls.length === c0 && stub.calls.length === s0, "a selection change moves the box line, runs nothing", dlg.state().boxLine);
// the rows reach the graph and the wait; the tick and the wait are stored
dlg.els.screen.value = "blue"; dlg.els.screen.dispatchEvent(new Event("change"));
dlg.els.despill.value = "0.8"; dlg.els.despill.dispatchEvent(new Event("input")); dlg.els.despill.dispatchEvent(new Event("change"));
dlg.els.keep.checked = true; dlg.els.keep.dispatchEvent(new Event("change"));
dlg.els.timeout.value = "120"; dlg.els.timeout.dispatchEvent(new Event("change"));
dlg.els.hint.value = "none"; dlg.els.hint.dispatchEvent(new Event("change"));
await wait(50);
ok(C.calls.length === c0 && stub.calls.length === s0 && dlg.state().rows.keepRow && !dlg.els.keepNote.hidden, "changing rows runs nothing; the keep note shows");
const out = await dlg.apply();
ok(out && out.layer && out.route === "comfyui" && C.calls.length === c0 + 1 && ed.layers.length === n0 + 2, "Key ran once on your ComfyUI and landed", out && out.status);
const g = C.calls[C.calls.length - 1];
ok(g.prompt.ck_key.inputs.screen === "blue" && g.prompt.ck_key.inputs.despill === 0.8 && g.prompt.ck_model.inputs.keep_on_gpu === true && !("alpha_hint" in g.prompt.ck_key.inputs) && g.timeoutMs === 120000, "the rows reached the graph and the wait", { k: g.prompt.ck_key.inputs, m: g.prompt.ck_model.inputs, t: g.timeoutMs });
ok(M.currentKeyDialog() === null && host.keyValues().keepOnGpu === true && host.keyValues().comfyTimeout === 120, "the dialog closed; the tick and the wait stored");
const keyId = out.layer.id;
// Re-key from the dialog: the key layer active, its mask as a clean matte, once
ed.activeLayerId = keyId;
dlg = await M.openKeyDialog(ed);
await wait(80);
st = dlg.state();
ok(st.values.hint === "mask" && dlg.els.key.textContent === "Re-key" && /^Keys the key layer's box, 512 × 400, at its own size, read from the picture under the key\.$/.test(st.boxLine) && !st.rows.sourceRow, "a key layer active: Re-key on your ComfyUI", st);
const u0 = ed.undo.length;
const rk = await dlg.apply();
ok(rk && rk.layer && rk.layer.id === keyId && ed.undo.length === u0 + 1 && C.calls.length === c0 + 2 && C.calls[C.calls.length - 1].prompt.ck_key.inputs.hint_quality === "clean matte (0.95)", "Re-key ran once with the mask as a clean matte, one step");
await ed.undoStep(); await ed.undoStep();
ok(ed.layers.length === n0, "undone");
// the first key found the models missing: the dialog stays open with the files and the first-run block
await host.setKeyValues({ ...K.keyDefaults, workingSize: 512 });
ed.activeLayerId = null;
dlg = await M.openKeyDialog(ed);
await wait(50);
ok(!dlg.state().firstRun, "after a key from the dialog landed the first-run block is folded");
C.fail = "CorridorKey 2.0 model files are missing:\n  F:\\Comfy\\models\\corridorkey2\\corridorkey_v2.safetensors\n";
let err = "";
try { await dlg.apply(); } catch (e) { err = e.message; }
C.fail = "";
st = dlg.state();
ok(err.includes(K.MISSING_TEXT) && !dlg.closed && st.loop === err && st.firstRun === K.comfyFirstRun("marawan206") && ed.layers.length === n0, "the models missing: the files in the dialog, the first-run block again, nothing added", st);
// the server goes away: the readiness line follows it, Key greyed
host.server = { ...host.server, state: "disconnected" };
host.emit("realism");
st = dlg.state();
ok(st.keyDisabled && st.ready === K.serverSupport({ state: "disconnected" }).reason && !st.firstRun && !st.rows.keepRow, "not connected: the reason, Key greyed", st);
comfyOn();
host.emit("realism");
ok(!dlg.state().keyDisabled, "connected again: Key back");
dlg.close();
await host.setKeyValues({ ...K.keyDefaults, workingSize: 512 });
return { ready: st.ready.slice(0, 80) };
"""),

    ("cleanup", r"""
closeDialog();
engineOff();
comfyOff();
for (const id of [window.__ckDoc]) { try { if (id) await run("close_document", { doc: id, force: true }); } catch (_) { /* gone */ } }
for (const id of [window.__keyDoc, window.__keyDoc2]) { try { await run("close_document", { doc: id, force: true }); } catch (_) { /* gone */ } }
host.keyStored = null; host._keyLoaded = false;
return { ok: true };
"""),
]

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    %s
    %s
})()"""


async def run_all(c):
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    ok = True
    for name, body in STEPS:
        try:
            res = await c.eval(PRE % (HELPERS, body.replace("__FIXDIR__", json.dumps(FIXDIR))), timeout=240)
            print("[ok] %s: %s" % (name, json.dumps(res)[:300]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            if name == "setup":
                break
    if not ok:
        try:
            await c.eval("(async () => { const h = window.__host; if (window.__keyEngine0) h.keyEngine = window.__keyEngine0; const o = window.__comfy0; if (o) { h.server = o.server; h.objectInfo = o.objectInfo; h.comfyPictureRun = o.comfyPictureRun; h.uploadInput = o.uploadInput; h.keyComfyFit = o.keyComfyFit; } h.keyStored = null; h._keyLoaded = false; return 1; })()")
        except Exception:  # noqa: BLE001
            pass
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        ok = asyncio.run(session(run_all))
        sys.exit(0 if ok else 1)
    except Exception as err:
        print("[FAIL] CDP error:", err)
        sys.exit(1)
