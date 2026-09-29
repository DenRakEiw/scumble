"""Editor behaviour that is easy to break again, against the running app (tools/cdp.py).

No ComfyUI needed. Checks the New dialog (two number boxes, the ratio tie, the focus that a
button click used to steal), that a click without a drag deselects with the marquee and the
lasso, that an outline in progress is drawn black under white so it stays visible on a white
image, copy and paste of a whole layer from one tab into another, and that an erase stroke
through one strip of a zoomed-out result layer leaves the rest of the layer on screen (the
cached display level used to be wiped outside the stroke's rectangle). The steps after the C1
review cover the undo history (order, the objects its steps hold, the budget, a load that takes
it along), the selection's bounds after a restore, the selection brush's display levels, a lost
undo step, and that closed tabs are freed. The close-out's steps: an undo refused while a stroke or
a drag is held, an undo that does not run over an edit made while it loads (a decode, a grow, a
canvas redo, an upload of extend / merge, flatten), text edit steps that give their blob URLs
back, and a restored selection that getValue saves even when it was read during the restore. After
it: the undo and redo of a mask brush stroke (c6bc6a6 loaded the step's mask flag as an image), on
either backend.
C2 step (b) and its review: the pixel backend the flag chose, editing on it in pixels and on screen
(a selection drag with faint isolated pixels, read on screen in the middle of the drag), no display
mirror for pixels nothing draws, no CPU mirror drawn by the screen, stale compositor textures leaving,
and after every step a sweep that every open editor holds only pixels of its own backend. C2's final
review: a selection drag that leaves the display levels alone on canvases, the undo of a mask stroke,
whole-layer undo steps as tile clones and small-selection writes without whole-layer work on tiles, exact
flips and turns, no mirror for an empty selection or for removed layers, the memory report's shared-tile
counting, the 268 MP refusal on tiles and a selection encode that cannot throw out of getValue.
C6 (a): a second mask from selection and its undo reach the screen on both paths, a write that ends on a tile
border or an undo of whole tiles leaves no neighbour's old edge line in the atlas, and the atlas gives back the
pages of pixels the document replaced and holds nothing alive after a collection.
C7, the default: the tile engine is on unless the command line, SCUMBLE_TILES or the Settings › Rendering
row chose otherwise (the precedence in plain Node, tools/tilemode_test.js), and that row writes the setting
and names the source. 0.1.14: the Settings form is valid with its defaults and with every value its memory rows
write, so Close closes it (0.1.13's Tile atlas box refused its own 512).
C6 (b2): mip chains of the selection that land from the mips worker run no colour match and no filter pass again, and
the chains of a layer below a matched one and a filter layer do, once, and the screen ends exact either way; a layer
above them or the base replaced under them follows the same rule, a flatten after the landings keeps nothing a sampled
pass made while they were on their way, and a flatten right after them does not set the screen's colour match.
0.1.31, the Undo history (docs/PLAN_0_1_31.md section 2): three edits as three labelled rows in the panel, a click on a row
that jumps back and forward to the state of that edit, named snapshots restored twice and taken back (tiles; refused on
canvases), the depth that drops the oldest steps, and the history commands against the list.

    python tools/editor_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

async def escape_closes_the_shell_dialogs(c):
    """Settings and Generate-new are native <dialog>s; the browser closes them on Escape unless a
    keydown listener calls preventDefault. The editor's window capture handler did exactly that for
    every Escape, so the dialogs could only be closed with the mouse. A synthetic keydown checks the
    listener (defaultPrevented), a real key through CDP checks the native close."""
    out = {}
    for name, opener in (("settings", "shell.openSettings()"), ("generate_new", "host.shell.openGenerateNew(ednow(window.__t))")):
        await c.eval(PRE % ("""
const shell = await import("./shell.js");
host.shell.activate(ednow(window.__t));
await %s;
await wait(200);
const dlg = document.querySelector("dialog[open]:not(#assistant)");
if (!dlg) throw new Error("the %s dialog did not open");
const el = dlg.contains(document.activeElement) ? document.activeElement : dlg;
const evt = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
el.dispatchEvent(evt);
window.__esc = { prevented: evt.defaultPrevented, focusInside: dlg.contains(document.activeElement), target: el.tagName };
return 1;
""" % (opener, name)), timeout=60)
        for kind in ("keyDown", "keyUp"):
            await c.call("Input.dispatchKeyEvent", type=kind, key="Escape", code="Escape", windowsVirtualKeyCode=27, nativeVirtualKeyCode=27)
        r = await c.eval("(async () => { await new Promise((r) => setTimeout(r, 200)); const d = document.querySelector('dialog[open]:not(#assistant)'); return { ...window.__esc, stillOpen: !!d }; })()")
        out[name] = r
        if r["prevented"]:
            raise Exception("%s: the editor's key handler still prevents Escape (%s)" % (name, json.dumps(r)))
        if r["stillOpen"]:
            raise Exception("%s: still open after a real Escape (%s)" % (name, json.dumps(r)))
    return out


SETTINGS_FORM = r"""
const shell = await import("./shell.js");
const dlg = document.getElementById("shell-settings");
const form = dlg.querySelector("form");
const fields = { gpuLimitMB: document.getElementById("set-gpu-limit"), cardMinFreeMB: document.getElementById("set-card-min"), atlasMB: document.getElementById("set-atlas") };
const invalid = (root) => Array.from(root.querySelectorAll("input, select, textarea")).filter((e) => !e.checkValidity()).map((e) => ({ id: e.id || e.name || e.type, value: e.value, min: e.min, step: e.step, max: e.max, message: e.validationMessage }));
const saved = (await window.scumble.settings.get()).memory || null;
const shipped = __SHIPPED__;
const out = { shipped, rows: [] };
const reopen = async () => { if (dlg.open) dlg.close(); await shell.openSettings(); await wait(250); };
try {
    // the shipped defaults, stored as they are and with no memory entry at all (the rows' own fallbacks)
    for (const [label, memory] of [["defaults stored", shipped], ["no entry", null]]) {
        await window.scumble.settings.set({ memory });
        await reopen();
        const bad = invalid(form);
        out.rows.push({ label, values: Object.fromEntries(Object.entries(fields).map(([k, e]) => [k, e.value])), bad });
        if (bad.length || !form.checkValidity()) throw new Error("Settings form invalid with " + label + ": " + JSON.stringify(bad));
        for (const [k, e] of Object.entries(fields)) if (+e.value !== shipped[k]) throw new Error(k + " shows " + e.value + ", the default is " + shipped[k]);
    }
    // what the rows write themselves: whatever is typed, rounded and clamped by the change handlers
    for (const [k, e] of Object.entries(fields)) {
        for (const typed of ["1000", "100", "513", "3000.4", "-5", "7", "464", "528"]) {
            e.value = typed;
            e.dispatchEvent(new Event("change", { bubbles: true }));
            await wait(80);
            const stored = ((await window.scumble.settings.get()).memory || {})[k];
            const bad = invalid(form);
            if (bad.length) throw new Error(k + ": typed " + typed + ", the row wrote " + stored + " and the form reports " + JSON.stringify(bad));
            if (String(stored) !== e.value) throw new Error(k + ": typed " + typed + ", the row shows " + e.value + " but stored " + stored);
        }
    }
    // values an earlier version may have stored: the browser's own suggestion for the old atlas field, a hand-edited fraction
    await window.scumble.settings.set({ memory: { gpuLimitMB: 1000.5, cardMinFreeMB: 3000, atlasMB: 464 } });
    await reopen();
    out.rows.push({ label: "stored by hand", values: Object.fromEntries(Object.entries(fields).map(([k, e]) => [k, e.value])), bad: invalid(form) });
    if (!form.checkValidity()) throw new Error("Settings form invalid with stored values: " + JSON.stringify(invalid(form)));
    // and the dialog really closes through its Close button (a submit, which the browser validates)
    await window.scumble.settings.set({ memory: shipped });
    await reopen();
    form.requestSubmit(document.getElementById("set-close"));
    await wait(200);
    out.closed = !dlg.open;
    if (dlg.open) throw new Error("Close did not close the Settings dialog: " + JSON.stringify(invalid(form)));
    // Generate new: its size boxes take 64..8192, a wider document shows the clamped size
    const d = await run("new_document");
    try {
        await run("new_canvas", { doc: d.id, width: 9000, height: 64 });
        await host.shell.openGenerateNew(ednow(d.id));
        await wait(200);
        const gen = document.getElementById("gen-dialog");
        const badGen = invalid(gen.querySelector("form"));
        out.generate = { width: document.getElementById("gen-width").value, bad: badGen };
        gen.close();
        if (badGen.length) throw new Error("Generate new form invalid: " + JSON.stringify(badGen));
    } finally {
        await run("close_document", { doc: d.id, force: true });
    }
} finally {
    if (dlg.open) dlg.close();
    // put the rows back the way the handlers do, so the live atlas budget follows too
    await window.scumble.settings.set({ memory: saved });
    await shell.openSettings(); await wait(200);
    for (const [k, e] of Object.entries(fields)) { if (saved && saved[k] != null) { e.value = String(saved[k]); e.dispatchEvent(new Event("change", { bubbles: true })); } }
    await wait(150);
    await window.scumble.settings.set({ memory: saved });
    dlg.close();
    host.shell.activate(ednow(window.__t) || host.editor);
}
return out;
"""


async def settings_form_accepts_its_own_values(c):
    """0.1.13's Settings dialog would not close: the Tile atlas field had min 16 and step 64, so its own default 512
    was no valid value ("nearest 464 and 528") and the browser refused the form's submit. Every number row of the
    dialog is checked with the shipped defaults (read from electron/main/settings.js), with no memory entry, with
    every value its change handler writes for a typed number, and with values an earlier version may have stored;
    then Close has to close the dialog. Generate new's size boxes are checked on a document wider than they take."""
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "..", "electron", "main", "settings.js"), encoding="utf-8") as f:
        src = f.read()
    import re
    m = re.search(r"memory:\s*\{([^}]*)\}", src)
    if not m:
        raise Exception("no memory defaults in electron/main/settings.js")
    shipped = {k: int(v) for k, v in re.findall(r"(\w+):\s*(\d+)", m.group(1))}
    if set(shipped) != {"gpuLimitMB", "cardMinFreeMB", "atlasMB"}:
        raise Exception("the memory defaults changed shape, update this step: %s" % shipped)
    return await c.eval(PRE % SETTINGS_FORM.replace("__SHIPPED__", json.dumps(shipped)), timeout=120)


LIVE_SETUP = """
// the user's report of 0.1.13: a large picture, a rectangle selected, copied merged and pasted ("merged copy added
// (w x h at x, y). Move it with T."), the selection kept and shown as marching ants
const d = await run("new_document");
window.__lv = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { width: 10000, height: 5000, doc: d.id });
const pic = document.createElement("canvas");
pic.width = 10000; pic.height = 5000;
const g = pic.getContext("2d");
for (let y = 0; y < 5000; y += 200) {
    for (let x = 0; x < 10000; x += 200) {
        g.fillStyle = "hsl(" + ((x * 7 + y * 13) / 200 * 23 % 360) + ",70%," + (35 + ((x + y) / 200 % 3) * 12) + "%)";
        g.fillRect(x, y, 200, 200);
    }
}
const picture = ed.addLayer({ name: "picture", kind: "image", ref: null, px: ed.pixels.Layer.fromCanvas(pic), x: 0, y: 0, w: 10000, h: 5000, dirty: true });
if (ed.tileMode) { pic.width = 1; pic.height = 1; }   // the canvas backend adopts the canvas as the layer's pixels
ed.markLayerChanged(picture);
await run("select_rect", { x: 1000, y: 1300, w: 7600, h: 2400, doc: d.id });
ed.copySelection({ merged: true });
const L = ed.pasteClipboard();
ed.clipboard = null;
const status = ed.status;
if (!L || L.x !== 1000 || L.y !== 1300 || L.w !== 7600 || L.h !== 2400) throw new Error("the merged copy is not where it was copied from: " + status);
// a merged copy is the picture itself: inverted, so an erase shows the picture under it
L.name = "merged copy";
L.px.drawInto(null, (ctx) => { ctx.globalCompositeOperation = "difference"; ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, L.px.width, L.px.height); });
ed.markLayerChanged(L);
// the copy has to carry the picture's texture on both backends: a flat copy (the picture's canvas emptied under the
// canvas backend, which adopts it) makes every row a stroke on one colour, where resampling and clone show nothing
const texture = new Set();
for (const [x, y] of [[100, 100], [300, 100], [700, 500], [2500, 1300], [5300, 900], [7300, 2100]]) texture.add(Array.from(L.px.readRect(x, y, 1, 1).data).join(","));
if (texture.size < 4) throw new Error("the merged copy is flat, not the picture: " + JSON.stringify([...texture]));
ed.activeLayerId = L.id;
ed.selectionDisplay = "ants";
ed.renderLayers();
ed.drawSoon();
await ed.mipsSettled();
await wait(300);
return { status, tiles: ed.tileMode, layer: [L.x, L.y, L.w, L.h], texture: texture.size, bounds: ed.getBounds(), canvas: [ed.canvas.width, ed.canvas.height] };
"""

LIVE_PREP = """
const P = await import("./editor/inpaint_pixels.js");
const ed = ednow(window.__lv);
host.shell.activate(ed);
const L = ed.layers.find((l) => l.name === "merged copy");
ed.activeLayerId = L.id;
ed.renderLayers();
ed.setTool(o.tool);
ed.brushSize = 188; ed.hardness = 0.43; ed.eraseHardness = 0.43; ed.brushOpacity = 1; ed.color = "#00ff40";
ed.brushTipId = null;
ed.shapeOpts = { kind: "rectangle", fill: true, stroke: false, width: 4, radius: 0, color: "#000000" };
ed.gradientOpts = { type: "linear", to: "transparent" };
ed.cloneOpts = { sample: "image", aligned: false };
ed.cloneSource = o.tool === "clone" || o.tool === "heal" ? { x: o.x0 - 700, y: o.y - 900 } : null;
// heal's release lays the Poisson blend since 0.1.32, which differs from its preview (the dabs' mean shift) by design: this
// step asks whether the preview reaches the screen, so the heal row commits the preview (the blend is
// heal_blends_the_source_into_the_picture_at_the_release's)
ed.constructor.healBlend = o.tool !== "heal";
if (ed.smudgeOpts) { ed.smudgeOpts.sample = "layer"; ed.smudgeOpts.strength = 60; }
ed.cloneOffset = null;
ed.selectionDisplay = "ants";
const cx = (o.x0 + o.x1) / 2;
// every row sets its scale and centres the stroke: a fitted view's scale is the window's (0.18 on a 1865 px canvas, 0.12 on
// a DPR-1 window of 1241 px, where the rows' rectangles left the layer), so the step would measure a different zoom per monitor
ed.view.angle = 0; ed.view.scale = o.scale; ed._fitted = false;
ed.view.x = Math.round(ed.canvas.width / 2 - cx * o.scale);
ed.view.y = Math.round(ed.canvas.height / 2 - o.y * o.scale);
ed.drawSoon();
await wait(200);
await ed.mipsSettled();
await wait(300);
// the app draws a stroke's frames through requestAnimationFrame (drawSoon), which a hidden window never runs
const raf = await new Promise((r) => { const t = setTimeout(() => r(false), 3000); requestAnimationFrame(() => { clearTimeout(t); r(true); }); });
if (!raf) throw new Error("requestAnimationFrame does not fire (" + document.visibilityState + "): the window is hidden, so no frame is drawn during a stroke; the step needs the window in front");
const rect = ed.canvas.getBoundingClientRect();
const k = rect.width / ed.canvas.width;
const s = ed.view.scale;
if (o.view !== "1:1" && !(s < 0.5)) throw new Error("the zoomed-out row is at " + s + ", not below 0.5");
const n = o.moves, dy = o.dy || 0;
const dev = [], css = [];
for (let i = 0; i <= n; i++) {
    const [sx, sy] = ed.imageToScreen(o.x0 + (o.x1 - o.x0) * i / n, o.y + dy * (2 * i / n - 1));
    dev.push([sx, sy]);
    css.push([rect.left + sx * k, rect.top + sy * k]);
}
const ringR = (188 / 2) * s;
const pad = Math.ceil(ringR + 14 + dy * s);
const [, my] = ed.imageToScreen(cx, o.y);
const x0 = Math.floor(dev[0][0] - pad), x1 = Math.ceil(dev[n][0] + pad), y0 = Math.floor(my - pad), y1 = Math.ceil(my + pad);
if (x0 < 0 || y0 < 0 || x1 > ed.canvas.width || y1 > ed.canvas.height) throw new Error("the editor canvas (" + ed.canvas.width + " x " + ed.canvas.height + ") is too small for the stroke's rectangle of " + (x1 - x0) + " x " + (y1 - y0) + " px at " + s + ": " + JSON.stringify([x0, y0, x1, y1]));
const la = ed.imageToScreen(L.x, L.y), lb = ed.imageToScreen(L.x + L.w, L.y + L.h);
if (x0 < la[0] + 8 || x1 > lb[0] - 8 || y0 < la[1] + 8 || y1 > lb[1] - 8) throw new Error("the stroke's rectangle is not inside the layer, clear of the ants on its edge");
window.__lvShots = {};
window.__lvClip = [x0, y0, x1 - x0, y1 - y0];
window.__lvGeo = { dev, ringR };
window.__lvMirror0 = ed.tileMode ? !!P.displayCanvasIfMade(L.px) : null;
return { css, scale: +s.toFixed(4), layerWiderThanView: la[0] < 0 || lb[0] > ed.canvas.width, layerAt: [L.x, L.y],
         clip: window.__lvClip, visible: document.visibilityState, mirrorBefore: window.__lvMirror0 };
"""

LIVE_SHOT = """
const P = await import("./editor/inpaint_pixels.js");
const ed = ednow(window.__lv);
const L = ed.layers.find((l) => l.name === "merged copy");
const [x, y, w, h] = window.__lvClip;
// NOW: no rest after the pointer event that came before. Two frames of the page's own, so the frame the move asked for
// (drawSoon, registered while the event was handled) has run, and nothing later: a preview that shows only once the hand
// has stopped for a moment is not on the screen yet
if (NOW) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
// one readback of the editor's own canvas: what the window shows, as the app's last frame drew it
window.__lvShots[NAME] = ed.canvas.getContext("2d").getImageData(x, y, w, h).data;
return { pointer: ed.pointer ? ed.pointer.kind : null, last: ed.pointer && ed.pointer.last ? ed.pointer.last.map((v) => +v.toFixed(1)) : null,
         frames: window.__lvFrames || 0, mirror: ed.tileMode ? !!P.displayCanvasIfMade(L.px) : null };
"""

LIVE_MEASURE = """
const S = window.__lvShots, G = window.__lvGeo;
const [cx0, cy0, W, H] = window.__lvClip;
const n = G.dev.length - 1, half = Math.floor(n / 2);
const R = G.ringR + 6;
const loc = (p) => [p[0] - cx0, p[1] - cy0];
const p0 = loc(G.dev[0]), pH = loc(G.dev[half]), pN = loc(G.dev[n]);
const off = (x, y, q) => (x - q[0]) * (x - q[0]) + (y - q[1]) * (y - q[1]) > R * R;
// pixels whose largest channel moved by more than 30 levels, where `keep` says; the brush ring is never counted
const count = (a, b, keep) => {
    let c = 0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (!keep(x, y)) continue;
            const i = (y * W + x) * 4;
            if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 30) c++;
        }
    }
    return c;
};
// mid: the part of the path the cursor has left behind at half way; end: all of it, the button still down
const keepMid = (x, y) => x < pH[0] - R && off(x, y, p0);
const keepEnd = (x, y) => off(x, y, p0) && off(x, y, pN);
const midRef = count(S.pre, S.after, keepMid), mid = count(S.pre, S.mid, keepMid);
const endRef = count(S.pre, S.after, keepEnd), end = count(S.pre, S.end, keepEnd), endNow = count(S.pre, S.endNow, keepEnd);
// half way, anywhere outside the ring discs: for a shape or a gradient, which are redrawn whole per move (the frame half way is
// not a part of the last one), the stroke only has to be on the screen at all
const midAny = count(S.pre, S.mid, keepEnd);
const ratio = (a, b) => (b ? +(a / b).toFixed(3) : null);
// a frame against the frame after the commit, outside the ring discs too: the ring drawn over the stroke's start and end is an
// overlay the release may or may not leave there
const vs = (A) => {
    let worst = 0, differing = 0, big = 0;
    for (let i = 0; i < A.length; i++) {
        if ((i & 3) === 3) continue;
        const px = (i >> 2) % W, py = ((i >> 2) - px) / W;
        if (!keepEnd(px, py)) continue;
        const q = Math.abs(A[i] - S.after[i]);
        if (q) differing++;
        if (q > 30) big++;
        if (q > worst) worst = q;
    }
    return { worst, differing, over30: big, bytes: A.length };
};
const out = { mid: [mid, midRef, ratio(mid, midRef)], midAny: [midAny, endRef, ratio(midAny, endRef)], endNow: [endNow, endRef, ratio(endNow, endRef)],
              end: [end, endRef, ratio(end, endRef)], endNowVsAfter: vs(S.endNow), endVsAfter: vs(S.end) };
window.__lvShots = null;
return out;
"""


async def live_stroke_reaches_the_screen_before_the_release(c):
    """0.1.13 (the user's report): with the brush or the eraser nothing but the press dab reached the screen while
    the button was down; the whole stroke appeared on the release. 28bfad0 (C5 c) had taken the per-dab
    touchSource out of layerDab, cloneDab, gradientDab and shapeDab, and that was the only thing that moved the
    scene cache's signature during a stroke: every frame of the gesture blitted the scene built at the press.
    `live_stroke_preview_shows_what_the_commit_writes` did not see it, because it cleared `sceneSig` by hand before
    every draw and called layerDab and draw itself.

    This step drives the real gesture: CDP mouse events through the page, the window in front, the app's own frames
    (drawSoon, requestAnimationFrame), no direct dab or draw call and no `sceneSig` written. On the user's case (a
    7600 x 2400 merged copy of a textured 10000 x 5000 picture pasted where it was copied, the selection kept with
    marching ants, a soft 188 px brush) the brush and the eraser at 0.18 and at 0.45 (both below 0.5; at 0.45 the
    layer is wider than the view) and at 1:1 (wider too), then a rectangle shape, the gradient and the clone tool at
    1:1. Every row sets its own scale, so the step measures the same zoom whatever window it gets.

    The editor's canvas is read with no rest after a move, two of the page's frames after it: half way through the
    stroke and right after the last move, the button still down. By then the stroke has to be on the screen: 95 % of
    what the release shows over the whole path; half way 90 % of the pixels behind the cursor for the brush, the
    eraser and the clone tool, and for a shape or a gradient (redrawn whole per move) a tenth of what the release
    shows anywhere (the rectangle half way is a quarter of the last one: measured 0.21, the gradient 0.44). A preview that appears only once the hand rests fails there. The canvas is read once more after a
    rest with the button still down, and that frame has to be the frame after the commit (to 2 levels at 1:1, like
    the preview step; to 20 zoomed out, where the preview is composed from levels). On tiles the stroke makes no display
    mirror of the layer; the clone tool, which makes one (its sample), runs last so it cannot hide another tool's.
    Red on 0.1.13 on both backends: 0 of the pixels, every stroke."""
    setup = await c.eval(PRE % LIVE_SETUP, timeout=240)
    out = {"setup": setup, "strokes": {}}
    # a row of the 2400 px layer per stroke; 0.45 shows the 7600 px layer wider than a canvas of 3420 px, 1:1 wider than 7600
    rows = [
        ("z018_paint", dict(tool="paint", view="z018", scale=0.18, y=1600, x0=3660, x1=5710)),
        ("z018_erase", dict(tool="erase", view="z018", scale=0.18, y=1850, x0=3660, x1=5710)),
        ("z045_paint", dict(tool="paint", view="z045", scale=0.45, y=2100, x0=4000, x1=5100, wider=True)),
        ("z045_erase", dict(tool="erase", view="z045", scale=0.45, y=2350, x0=4000, x1=5100, wider=True)),
        ("1to1_paint", dict(tool="paint", view="1:1", scale=1, y=2600, x0=4300, x1=4800, wider=True)),
        ("1to1_erase", dict(tool="erase", view="1:1", scale=1, y=2850, x0=4300, x1=4800, wider=True)),
        ("1to1_shape", dict(tool="shape", view="1:1", scale=1, y=3100, x0=4300, x1=4800, dy=60, wider=True)),
        ("1to1_gradient", dict(tool="gradient", view="1:1", scale=1, y=2475, x0=4300, x1=4800, wider=True)),
        ("1to1_clone", dict(tool="clone", view="1:1", scale=1, y=3350, x0=4300, x1=4800, wider=True)),
        # 0.1.32 (PLAN_0_1_31 §4 step 2): heal and smudge read their box too, and have a row each
        ("1to1_heal", dict(tool="heal", view="1:1", scale=1, y=3480, x0=4300, x1=4800, wider=True)),
        ("1to1_smudge", dict(tool="smudge", view="1:1", scale=1, y=1450, x0=4300, x1=4800, wider=True)),
    ]
    fails = []
    try:
        await live_strokes(c, rows, setup, out, fails)
    finally:
        await c.eval(PRE % "try { ednow(window.__lv).constructor.healBlend = true; await run(\"close_document\", { doc: window.__lv, force: true }); } catch (_) { /* gone */ } return 1;")
    if fails:
        raise Exception(" | ".join(fails) + " " + json.dumps(out["strokes"]))
    return out["strokes"]


async def live_strokes(c, rows, setup, out, fails):
    gap = 0.04
    for name, o in rows:
        o["moves"] = 24
        info = await c.eval(PRE % ("const o = " + json.dumps(o) + ";\n" + LIVE_PREP), timeout=120)
        pts = info["css"]
        n = len(pts) - 1
        shot = lambda nm, now=False: c.eval(PRE % LIVE_SHOT.replace("NAME", json.dumps(nm)).replace("NOW", "true" if now else "false"), timeout=60)  # noqa: E731
        await c.call("Page.bringToFront")
        await c.call("Input.dispatchMouseEvent", type="mouseMoved", x=pts[0][0], y=pts[0][1], button="none", buttons=0, pointerType="mouse")
        await asyncio.sleep(0.3)
        await shot("pre")
        await c.eval("(() => { window.__lvFrames = 0; window.__lvCount = true; const f = () => { if (!window.__lvCount) return; window.__lvFrames++; requestAnimationFrame(f); }; requestAnimationFrame(f); return 1; })()")
        await c.call("Input.dispatchMouseEvent", type="mousePressed", x=pts[0][0], y=pts[0][1], button="left", buttons=1, clickCount=1, pointerType="mouse")
        await asyncio.sleep(gap)
        mid = None
        for i in range(1, n + 1):
            await c.call("Input.dispatchMouseEvent", type="mouseMoved", x=pts[i][0], y=pts[i][1], button="left", buttons=1, pointerType="mouse")
            if i == n // 2:
                mid = await shot("mid", now=True)   # no rest: the hand is still moving
            elif i < n:
                await asyncio.sleep(gap)
        end_now = await shot("endNow", now=True)   # right after the last move, no rest
        await asyncio.sleep(0.4)
        end = await shot("end")          # rested, the button still down: the frame the commit's frame is compared with
        await c.call("Input.dispatchMouseEvent", type="mouseReleased", x=pts[n][0], y=pts[n][1], button="left", buttons=0, clickCount=1, pointerType="mouse")
        await c.eval(PRE % "const ed = ednow(window.__lv); await wait(300); window.__lvCount = false; await ed.mipsSettled(); await wait(400); return 1;", timeout=120)
        after = await shot("after")
        m = await c.eval(PRE % LIVE_MEASURE, timeout=60)
        row = {"scale": info["scale"], "wider": info["layerWiderThanView"], "frames": end["frames"], "pointer": [mid["pointer"], end["pointer"], after["pointer"]], **m}
        if setup["tiles"]:
            row["mirror"] = [info["mirrorBefore"], end["mirror"]]
        out["strokes"][name] = row
        tool = o["tool"]
        behind = tool in ("paint", "erase", "clone", "heal", "smudge")
        kind = "smudge" if tool == "smudge" else "layerpaint"
        if end["pointer"] != kind or after["pointer"] is not None:
            fails.append("%s: the gesture was not a stroke held to the end and released (%s)" % (name, row["pointer"]))
            continue
        # the stroke went where the step moved it: a real mouse over the window (the user's hand) moves the pointer as well
        dy = o.get("dy", 0)
        slack = 3 / info["scale"] + 1
        want = {"mid": [(o["x0"] + o["x1"]) / 2, o["y"], mid], "endNow": [o["x1"], o["y"] + dy, end_now]}
        astray = [k for k, (wx, wy, got) in want.items() if not got["last"] or abs(got["last"][0] - wx) > slack or abs(got["last"][1] - wy) > slack]
        if astray:
            fails.append("%s: the pointer is not where the step moved it at %s (%s; a real mouse over the window?)" % (name, astray, json.dumps({k: [v[0], v[1], v[2]['last']] for k, v in want.items()})))
            continue
        if end["frames"] < n // 3:
            fails.append("%s: only %d frames were drawn during %d moves (the window is not in front?)" % (name, end["frames"], n))
            continue
        if m["end"][1] < 2000:
            fails.append("%s: the stroke changes only %d pixels of the screen, so the check proves nothing" % (name, m["end"][1]))
            continue
        if m["endNow"][2] < 0.95:
            fails.append("%s: right after the last move, the button still down, the screen shows %d of the %d pixels the release shows (%.3f)" % (name, m["endNow"][0], m["endNow"][1], m["endNow"][2]))
        if m["end"][2] < 0.95:
            fails.append("%s: after a rest with the button still down the screen shows %d of the %d pixels the release shows (%.3f)" % (name, m["end"][0], m["end"][1], m["end"][2]))
        # heal moves the source's texture to the colour under it: on the textured copy few pixels change by 30 levels (119
        # half way, measured 2026-09-27), so its row asks for fewer
        if behind and (m["mid"][1] < (50 if tool == "heal" else 500) or m["mid"][2] is None or m["mid"][2] < 0.9):
            fails.append("%s: half way through the stroke, the hand moving, the screen shows %d of the %d pixels behind the cursor (%s)" % (name, m["mid"][0], m["mid"][1], m["mid"][2]))
        if not behind and m["midAny"][2] < 0.1:
            fails.append("%s: half way through the stroke, the hand moving, the screen shows %d pixels of the stroke, against %d after the release (%.3f)" % (name, m["midAny"][0], m["midAny"][1], m["midAny"][2]))
        if o.get("wider") and not info["layerWiderThanView"]:
            fails.append("%s: the layer is not wider than the view at %s" % (name, info["scale"]))
        eq = m["endVsAfter"]
        # at 1:1 neither the preview nor the commit resamples: the same pixels, to 2 levels (the preview step's bound). Zoomed
        # out the preview is the layer's level with the stroke's level over it and the commit's frame the level of the written
        # pixels: measured on the textured copy 2 to 3 levels on tiles, 7 to 12 at 0.18 and 3 to 5 at 0.45 on canvases (DPR 1.5 and 1), never a byte
        # over 30. At 0.12 (a fitted view in a DPR-1 window) canvases gave 27, which is why every row sets its scale
        bound = 2 if o["view"] == "1:1" else 20
        if eq["worst"] > bound:
            fails.append("%s: the last frame before the release is not the frame after the commit (%d levels, bound %d, on %d bytes)" % (name, eq["worst"], bound, eq["differing"]))
        # C5's cost: the live stroke is composed in the region the screen shows. Clone, heal and smudge too since 0.1.32
        # (their whole-picture sample and the smudge's read made a display mirror of the layer before)
        if setup["tiles"] and end["mirror"] and not info["mirrorBefore"]:
            fails.append("%s: the stroke made a display mirror of the layer" % name)
        if setup["tiles"] and info["mirrorBefore"]:
            fails.append("%s: the layer had a display mirror before the stroke, so the step cannot tell whether the stroke makes one" % name)


SVG_SAMPLE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" fill="#fff"/><rect width="200" height="200" fill="#f00"/><circle cx="300" cy="100" r="60" fill="#00f"/></svg>'


async def svg_import_rasterises_on_the_way_in(c):
    """An SVG has no pixel size of its own. Loading one asks for the size (prefilled: 2048 on the
    long side when the file only has a viewBox), the mirror then holds a PNG; as a layer it is
    rasterised to fit the document without a dialog; the load_image command takes width / height
    and never asks; and the mirror serves an .svg with its own type (it used to be octet-stream,
    which an <img> refuses to render)."""
    path = os.path.join(os.environ.get("TEMP", os.getcwd()), "scumble_editor_test.svg")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(SVG_SAMPLE)
    await c.eval("window.__svgPath = %s; window.__svgText = %s; 1" % (json.dumps(path), json.dumps(SVG_SAMPLE)))
    return await c.eval(PRE % """
const { api } = await import("./editor/host.js");
const ed = ednow(window.__t);
host.shell.activate(ed);
const file = new File([window.__svgText], "shapes.svg", { type: "image/svg+xml" });
const out = {};
const p = ed.loadFile(file);                     // interactive: the size dialog
await wait(300);
const box = ed.root.querySelector(".ipc-askbox");
if (!box) throw new Error("no size dialog for the SVG (" + ed.status + ")");
const inputs = Array.from(box.querySelectorAll(".ipc-askfield input"));
out.prefill = [inputs[0].value, inputs[1].value];
inputs[0].value = "800"; inputs[0].dispatchEvent(new Event("input"));
Array.from(box.querySelectorAll("button")).find((b) => b.textContent === "Import").click();
await p;
if (out.prefill[0] !== "2048" || out.prefill[1] !== "1024") throw new Error("prefill " + out.prefill);
if (ed.width !== 800 || ed.height !== 400) throw new Error("size " + ed.width + "x" + ed.height + " (" + ed.status + ")");
const px = (x, y) => Array.from(ed.basePx.readRect(x, y, 1, 1).data);   // the base's pixels (C1: basePx)
out.red = px(100, 200); out.blue = px(600, 200); out.white = px(700, 30);
if (out.red[0] < 250 || out.red[1] > 5) throw new Error("red " + out.red);
if (out.blue[2] < 250 || out.blue[0] > 5) throw new Error("blue " + out.blue);
if (out.white[1] < 250) throw new Error("white " + out.white);
out.baseFile = ed.base.ref.filename;
if (!/\\.png$/i.test(out.baseFile)) throw new Error("the mirror holds " + out.baseFile);
// a layer: rasterised to fit the document, no dialog
await ed.addImageLayers([file], "none", { place: "fit" });
const layer = ed.layers[ed.layers.length - 1];
out.layer = [layer.px.width, layer.px.height, layer.w, layer.h, layer.name];
if (layer.px.width !== 800 || layer.px.height !== 400 || layer.w !== 800) throw new Error("layer " + out.layer);
// the command: a path and a width, the aspect kept, no dialog
const r = await run("load_image", { path: window.__svgPath, width: 600, doc: window.__t });
out.command = [r.width, r.height];
if (r.width !== 600 || r.height !== 300) throw new Error("command size " + out.command);
if (ed.root.querySelector(".ipc-askbox")) throw new Error("the command opened the size dialog");
// the mirror's content type for an .svg file
const fd = new FormData();
fd.append("image", new Blob([window.__svgText], { type: "image/svg+xml" }), "editor_test_mime.svg");
fd.append("overwrite", "true");
const up = await (await fetch(api.apiURL("/upload/image"), { method: "POST", body: fd })).json();
const view = await fetch(api.apiURL("/view?filename=" + encodeURIComponent(up.name) + "&type=input&subfolder=" + encodeURIComponent(up.subfolder || "")));
out.mime = view.headers.get("content-type");
if (out.mime !== "image/svg+xml") throw new Error("the mirror serves an .svg as " + out.mime);
return out;
""", timeout=120)


async def closed_tabs_are_collected(c):
    """A closed tab gives its memory back. The export row's listener on the host held the editor
    for good, so every document ever opened stayed in memory with its layers and undo steps. Four
    tabs are made, painted on, closed, and after a forced collection none of them may be alive."""
    r = await c.eval(PRE % """
window.__closedTabs = [];
for (let i = 0; i < 4; i++) {
    const doc = await run("new_document");
    const ed = ednow(doc.id);
    await run("new_canvas", { width: 1200, height: 800, doc: doc.id });
    await run("add_paint_layer", { doc: doc.id });
    await run("select_rect", { x: 10, y: 10, w: 300, h: 200, doc: doc.id });
    ed.fillSelection();
    await wait(200);
    window.__closedTabs.push(new WeakRef(ed));
    await run("close_document", { doc: doc.id, force: true });
}
host.shell.activate(ednow(window.__t));
return host.editors().length;
""", timeout=120)
    for _ in range(4):
        await c.call("HeapProfiler.collectGarbage")
        await asyncio.sleep(0.3)
    alive = await c.eval("(async () => { await new Promise((r) => setTimeout(r, 300)); const a = window.__closedTabs.map((w) => !!w.deref()); window.__closedTabs = null; return a; })()")
    if any(alive):
        raise Exception("closed tabs still alive after a collection: %s" % json.dumps(alive))
    return {"open": r, "alive": alive}



# C2 step (b) (docs/PLAN_BCE.md §C2): the pixel backend. The gates start the app with
# SCUMBLE_TILES=1 or 0 (run_gates.sh --tiles on|off); without it the default applies (on, since 0.1.13).
def expected_tiles():
    v = os.environ.get("SCUMBLE_TILES")
    return True if v == "1" else False if v == "0" else None


BACKEND_STEP = """
// Every pixels object of a new document is of the backend the flag chose: the selection, the base,
// a layer, and what clone / copyRect / resized make of them; the status command and the memory report
// say so; pixels of the other backend are refused in strict mode (a gate would find a mix); and the
// display draws the pixels' own display canvas: the same canvas every frame, no toCanvas() copy per
// frame, a pyramid that is finished after a few frames and then kept.
const expect = __EXPECT__;   // null when the gate did not set SCUMBLE_TILES
const P = await import("./editor/inpaint_pixels.js");
const T = await import("./editor/inpaint_tiles.js");
const flag = window.scumble.pixels.tiles;
const d = await run("new_document");
window.__tb = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { width: 2400, height: 1600, doc: d.id });   // above 1 MP: the layers get display levels
const st = await run("status", { doc: d.id });
const L = ed.addPaintLayer();
const out = { flag, from: window.scumble.pixels.tilesFrom, expect, tileMode: ed.tileMode, status: st.pixels };
if (typeof flag !== "boolean") throw new Error("main.js passed no backend: " + JSON.stringify(out));
if (expect !== null && flag !== expect) throw new Error("the app runs another backend than the gate asked for: " + JSON.stringify(out));
if (ed.tileMode !== flag || P.pixelsOptions().tiles !== flag || st.pixels.tiles !== flag || ed.pixels !== T.pixelsBackend(flag)) throw new Error("the editor's backend is not the flag's: " + JSON.stringify(out));
const objs = { sel: ed.sel, base: ed.basePx, layer: L.px, clone: L.px.clone(), rect: L.px.copyRect([0, 0, 10, 10]), resized: ed.sel.resized(20, 20) };
for (const [k, p] of Object.entries(objs)) if (T.isTilePixels(p) !== flag) throw new Error(k + " is on the other backend");
if (!(ed.sel instanceof ed.pixels.Mask) || !(L.px instanceof ed.pixels.Layer) || !(ed.basePx instanceof ed.pixels.Layer)) throw new Error("the pixels are not the editor's classes");
const rep = ed.memoryReport();
if (rep.tileMode !== flag || !!rep.tiles !== flag) throw new Error("the memory report does not say the backend: " + JSON.stringify({ tileMode: rep.tileMode, tiles: rep.tiles }));
out.report = rep.tiles;
let refused = null;
const n = ed.layers.length;
try { ed.addLayer({ name: "mix", kind: "paint", px: T.pixelsBackend(!flag).Layer.empty(8, 8), x: 0, y: 0, w: 8, h: 8 }); } catch (e) { refused = e.message; }
if (P.pixelsOptions().strict && (!refused || !/backend/.test(refused) || ed.layers.length !== n)) throw new Error("pixels of the other backend were taken: " + refused);
out.mixRefused = !!refused;
// the display: a masked layer with content, zoomed out so it is drawn from its levels
L.px.fill([100, 100, 1900, 1300], "#3070d0");
ed.markLayerChanged(L);
L.maskPx = ed.pixels.Mask.empty(L.px.width, L.px.height);
L.maskPx.fill([0, 0, 1200, 1600], "#ffffff");
ed.markMaskChanged(L);
const M = ed.addPaintLayer();
M.px.fill([600, 400, 2200, 1500], "#d07030");
ed.markLayerChanged(M);
ed.view.scale = 0.2; ed.view.angle = 0;
ed.view.x = Math.round(ed.canvas.width / 2 - 1200 * 0.2); ed.view.y = Math.round(ed.canvas.height / 2 - 800 * 0.2);
const shown = [L.px, L.maskPx, M.px, ed.basePx, ed.sel];
// On tiles the screen draws the tiles themselves since C3, so nothing may be given a display canvas
// here: canvasOf would make the very mirror this step checks is not made.
const canvasOf = (p) => (flag ? P.displayCanvasIfMade(p) : P.canvasOf(p));
const canvases = shown.map(canvasOf);
const proto = [ed.pixels.Layer.prototype, ed.pixels.Mask.prototype];
const orig = proto.map((pr) => Object.prototype.hasOwnProperty.call(pr, "toCanvas") ? pr.toCanvas : null);
let copies = 0, drawing = false;
const callers = [];   // who took a copy (the stack's first frames)
// only the copies the draws take: an autosave that lands meanwhile encodes this document's selection with toCanvas
// (host.saveAll after a closed tab's flush, the tab of the live stroke step before: the flake of docs/TESTING.md)
for (const pr of proto) { const f = pr.toCanvas; pr.toCanvas = function (...a) { if (drawing) { copies++; if (callers.length < 4) callers.push(String(new Error().stack).split(String.fromCharCode(10)).slice(2, 7).map((x) => x.trim().split("/").pop()).join(" < ")); } return f.apply(this, a); }; }
let frames = 0;
try {
    for (let i = 0; i < 12; i++) { ed.sceneSig = null; drawing = true; try { ed.draw(); } finally { drawing = false; } frames++; await wait(30); if (!ed._pyramidPending && i >= 3) break; }
} finally {
    proto.forEach((pr, i) => { if (orig[i]) pr.toCanvas = orig[i]; else delete pr.toCanvas; });
}
const entry = ed.pyramids.get(canvasOf(M.px));
ed.sceneSig = null; ed.draw(); ed.sceneSig = null; ed.draw();
const comp = ed.compositor();
const atlas = comp ? comp.stats().atlas : null;
out.display = { frames, copies, pending: ed._pyramidPending, levels: entry ? entry.levels.length : 0,
                kept: ed.pyramids.get(canvasOf(M.px)) === entry, mirror: !!P.displayCanvasIfMade(M.px), atlas };
if (copies) throw new Error("the display took toCanvas() copies: " + JSON.stringify(out.display) + " from " + JSON.stringify(callers));
if (shown.some((p, i) => canvasOf(p) !== canvases[i])) throw new Error("a display canvas changed between frames");
// C5 (d): the mask reaches the screen from its own tiles. L is blue over 100,100..1900,1300 and its
// mask lets the left 1200 px through, so the blue shows at 600,200 and not at 1500,200, where the
// mask has no tile at all (a tile a mask does not have hides what is under it). M starts at y = 400,
// so neither point is covered by it.
{
    const g = ed.canvas.getContext("2d");
    const at = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return Array.from(g.getImageData(Math.round(sx), Math.round(sy), 1, 1).data); };
    ed.hover = null; ed.sceneSig = null; ed.draw(); await wait(60);
    const shown = at(600, 200), hidden = at(1500, 200);
    out.display.maskOnScreen = { shown, hidden };
    const blue = (q) => q[2] > 150 && q[0] < 120;
    if (!blue(shown)) throw new Error("the masked layer is not on screen where its mask lets it through: " + JSON.stringify(out.display.maskOnScreen));
    if (blue(hidden)) throw new Error("the masked layer shows where its mask has no tile: " + JSON.stringify(out.display.maskOnScreen));
}
out.display.masked = { canvas: !!L._masked, mirror: flag ? !!P.displayCanvasIfMade(L.px) : null,
                       maskMirror: flag ? !!P.displayCanvasIfMade(L.maskPx) : null,
                       pyramid: flag ? !!ed.pyramids.get(canvasOf(L.px)) : null };
if (flag) {
    // C3: the plain paint layer is drawn from the compositor's atlas, so it has neither a display
    // mirror nor a pyramid entry. (A host without WebGL2 would fall back to the mirror - hence the
    // atlas check first.) C5 (d): the masked layer's mask is a sampler in the same shader, so it has
    // no `_masked` canvas either, and neither its pixels nor its mask has a mirror.
    if (!atlas || !atlas.slots || !atlas.pages) throw new Error("no tiles in the compositor's atlas: " + JSON.stringify(out.display));
    if (out.display.mirror || entry) throw new Error("a tile layer the atlas draws still has a display mirror or pyramid: " + JSON.stringify(out.display));
    const md = out.display.masked;
    if (md.canvas || md.mirror || md.maskMirror || md.pyramid) throw new Error("a masked tile layer still has a `_masked` canvas, a mirror or a pyramid: " + JSON.stringify(md));
} else if (ed._pyramidPending || !entry || !entry.levels.length || !out.display.kept) {
    throw new Error("the pyramid is rebuilt every frame: " + JSON.stringify(out.display));
}
// C3 step (d): with a filter layer in the stack the GPU compositor stands down and Canvas 2D draws
// the view. On tiles a plain layer is drawn from its own tiles there too, so it still has no display
// mirror and no pyramid entry - only its region canvas.
{
    const fx = ed.addFilterLayer("invert");
    ed.renderLayers();
    for (let i = 0; i < 4; i++) { ed.sceneSig = null; ed.draw(); await wait(20); if (!ed._pyramidPending) break; }
    const usable = ed.glCompositeUsable({});
    out.canvas2d = { usable, mirror: !!P.displayCanvasIfMade(M.px), pyramid: !!ed.pyramids.get(canvasOf(M.px)),
                     regions: flag ? M.px.regionCanvasesIfMade().length : null,
                     maskedCanvas: !!L._masked, maskedMirror: flag ? !!P.displayCanvasIfMade(L.px) : null };
    if (usable) throw new Error("a filter layer did not push the view onto Canvas 2D: " + JSON.stringify(out.canvas2d));
    if (flag && (out.canvas2d.mirror || out.canvas2d.pyramid)) throw new Error("Canvas 2D made a display mirror or a pyramid of a tile layer: " + JSON.stringify(out.canvas2d));
    // C5 (d): the Canvas 2D path composes a masked tile layer in the region it draws, so no
    // `_masked` canvas the size of the layer and no mirror to fill it from
    if (flag && (out.canvas2d.maskedCanvas || out.canvas2d.maskedMirror)) throw new Error("Canvas 2D made a `_masked` canvas or a mirror of a masked tile layer: " + JSON.stringify(out.canvas2d));
    if (flag && !out.canvas2d.regions) throw new Error("Canvas 2D did not draw the layer from its tiles: " + JSON.stringify(out.canvas2d));
    ed.removeLayer(fx.id);
    ed.renderLayers();
}
// C6 (c2d): a move drag of a tile layer draws it from its tiles too (the drag keeps the view on Canvas 2D): its first frame
// made the layer's display mirror and a pyramid of it before. Both frames are Canvas 2D here, the drag's last and the one
// after the pointer is let go, so they are the same picture.
{
    const compOff = ed.compositorOff;
    ed.compositorOff = true;
    ed.releaseCaches({ mirrors: true });
    const g = ed.canvas.getContext("2d");
    const [qx, qy] = ed.imageToScreen(500, 300).map(Math.round), [rx2, ry2] = ed.imageToScreen(2300, 1550).map(Math.round);
    const shot = () => g.getImageData(qx, qy, rx2 - qx, ry2 - qy).data;
    const x0 = M.x;
    ed.hover = null;
    ed.pointer = { kind: "move", layer: M, start: [0, 0], orig: { x: M.x, y: M.y } };
    for (let i = 1; i <= 6; i++) { M.x = x0 + 6 * i; ed.hover = null; ed.draw(); }
    await wait(40); ed.hover = null; ed.sceneSig = null; ed.draw();
    const drag = shot();
    const mv = { mirror: flag ? !!P.displayCanvasIfMade(M.px) : null, pyramid: flag ? !!ed.pyramids.get(P.displayCanvasIfMade(M.px)) : null, regions: flag ? M.px.regionCanvasesIfMade().length : null };
    ed.pointer = null;
    ed.markLayerChanged(M);
    ed.hover = null; ed.sceneSig = null; ed.draw(); await wait(40); ed.sceneSig = null; ed.draw();
    const let_go = shot();
    let worst = 0, n = 0;
    for (let i = 0; i < drag.length; i++) { const q = Math.abs(drag[i] - let_go[i]); if (q) n++; if (q > worst) worst = q; }
    out.moveDrag = { ...mv, worst, differing: n };
    M.x = x0; ed.markLayerChanged(M); ed.compositorOff = compOff;
    if (flag && (mv.mirror || mv.pyramid)) throw new Error("a move drag made a display mirror or a pyramid of the tile layer: " + JSON.stringify(out.moveDrag));
    if (flag && !mv.regions) throw new Error("a move drag did not draw the layer from its tiles: " + JSON.stringify(out.moveDrag));
    if (worst > 2) throw new Error("the drag's last frame is not the frame after it: " + worst + " levels on " + n + " bytes");
}
return out;
"""


EDIT_STEP = """
// Editing on the flag's backend, checked in the pixels and on the screen: a real brush stroke (a
// layerrect undo step), a fill (a whole-layer step), undo and redo of both, and the clone-then-write
// path: a duplicated layer shares the pixels (the tiles, on tiles) until it is written, the write and
// its undo leave the original alone to the byte.
const T = await import("./editor/inpaint_tiles.js");
const ed = ednow(window.__tb);
host.shell.activate(ed);
await run("new_canvas", { width: 2400, height: 1600, doc: window.__tb });
const out = { tiles: ed.tileMode };
const L = ed.addPaintLayer();
ed.activeLayerId = L.id;
ed.fitView(); ed.sceneSig = null; ed.draw(); await wait(60);
const settle = async () => { for (let i = 0; i < 6; i++) { ed.sceneSig = null; ed.draw(); await wait(30); if (!ed._pyramidPending) break; } await ed.mipsSettled(); ed.hover = null; ed.sceneSig = null; ed.draw(); };
const screenAt = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return Array.from(ed.canvas.getContext("2d").getImageData(Math.round(sx), Math.round(sy), 1, 1).data); };
const pixel = (l, x, y) => Array.from(l.px.readRect(x, y, 1, 1).data);
const is = (p, rgb) => Math.abs(p[0] - rgb[0]) < 40 && Math.abs(p[1] - rgb[1]) < 40 && Math.abs(p[2] - rgb[2]) < 40;
const RED = [255, 0, 0], GREEN = [0, 255, 0], BLUE = [0, 0, 255], WHITE = [255, 255, 255];
const check = (label, l, x, y, px, screen) => {
    const got = { px: pixel(l, x, y), screen: screenAt(x, y) };
    out[label] = got;
    if (px === null ? got.px[3] !== 0 : (got.px[3] !== 255 || !is(got.px, px))) throw new Error(label + ": the layer's pixel is wrong: " + JSON.stringify(got));
    if (!is(got.screen, screen)) throw new Error(label + ": the screen shows something else: " + JSON.stringify(got));
};
const rect = ed.canvas.getBoundingClientRect();
const client = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 11, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
const stroke = async (x0, y, x1) => {
    ed.canvas.dispatchEvent(ev("pointerdown", x0, y));
    for (let i = 1; i <= 10; i++) { ed.canvas.dispatchEvent(ev("pointermove", x0 + (x1 - x0) * i / 10, y)); await wait(16); }
    ed.canvas.dispatchEvent(ev("pointerup", x1, y));
    await wait(60);
};
// 1. a brush stroke
ed.setTool("paint");
ed.color = "#ff0000"; ed.brushSize = 80; ed.hardness = 1; ed.brushOpacity = 1;
await stroke(300, 300, 1100);
await settle();
const strokeStep = ed.undo[ed.undo.length - 1];
out.strokeStep = strokeStep && strokeStep.kind;
if (!strokeStep || strokeStep.kind !== "layerrect" || T.isTilePixels(strokeStep.px) !== ed.tileMode) throw new Error("the stroke's undo step is not a rect copy on the editor's backend: " + out.strokeStep);
check("stroke", L, 700, 300, RED, RED);
// 2. a fill of the selection
await run("select_rect", { x: 1000, y: 800, w: 400, h: 300, doc: window.__tb });
ed.color = "#00ff00";
ed.fillSelection();
ed.clearSelection();
await wait(200); await settle();
check("fill", L, 1200, 950, GREEN, GREEN);
// 3. undo both, redo both (the selection's own steps lie between them: select, deselect)
const kinds = ed.undo.slice(-4).map((u) => u.kind);
if (kinds.join() !== "layerrect,selection,layer,selection") throw new Error("unexpected undo steps: " + kinds);
await ed.undoStep(); await ed.undoStep(); await settle();
check("undoFill", L, 1200, 950, null, WHITE);
check("strokeStays", L, 700, 300, RED, RED);
await ed.undoStep(); await ed.undoStep(); await settle();
check("undoStroke", L, 700, 300, null, WHITE);
await ed.redoStep(); await settle();
check("redoStroke", L, 700, 300, RED, RED);
await ed.redoStep(); await ed.redoStep(); await ed.redoStep(); await settle();
check("redoFill", L, 1200, 950, GREEN, GREEN);
if (ed.sel.bounds()) throw new Error("the redo left a selection behind");
// 4. clone, then write into the copy
const C = ed.duplicateLayer(L);
if (!C || T.isTilePixels(C.px) !== ed.tileMode) throw new Error("the duplicate is not on the editor's backend");
const tile = (l) => (T.isTilePixels(l.px) ? l.px.tileAt(700 >> 8, 300 >> 8) : null);
if (ed.tileMode && (!tile(L) || tile(C) !== tile(L))) throw new Error("the duplicate does not share the original's tiles");
const origBytes = L.px.readRect(0, 0, 2400, 1600).data;
const sameAsOrig = () => { const now = L.px.readRect(0, 0, 2400, 1600).data; for (let i = 0; i < now.length; i++) if (now[i] !== origBytes[i]) return false; return true; };
ed.activeLayerId = C.id;
const n0 = ed.undo.length;
await run("select_rect", { x: 500, y: 200, w: 500, h: 200, doc: window.__tb });
ed.color = "#0000ff";
ed.fillSelection();
ed.clearSelection();
await wait(200); await settle();
check("cloneFill", C, 700, 300, BLUE, BLUE);
// the original's tile may still be shared by undo steps (on tiles a whole-layer step is a clone, C2's final review): its
// counter must cover every other holder, or the next write would go into it in place
const holders = ed.tileMode ? [...ed.heldPixels()].filter((p) => p.tileAt(700 >> 8, 300 >> 8) === tile(L)).length : null;
out.shared = { afterWrite: ed.tileMode ? tile(C) === tile(L) : null, frozen: ed.tileMode ? tile(L).frozen : null, holders };
if (ed.tileMode && (tile(C) === tile(L) || tile(L).frozen < holders - 1)) throw new Error("the write went into the shared tile: " + JSON.stringify(out.shared));
if (pixel(L, 700, 300)[0] !== 255 || !sameAsOrig()) throw new Error("the write into the copy changed the original");
// a brush stroke on the copy (a rect copy of shared pixels), then undo it and the fill
ed.setTool("paint");
ed.color = "#ffff00";
await stroke(200, 700, 900);
await settle();
if (!sameAsOrig()) throw new Error("the stroke on the copy changed the original");
out.cloneSteps = ed.undo.slice(n0).map((u) => u.kind);
while (ed.undo.length > n0) await ed.undoStep();
await settle();
check("cloneUndo", C, 700, 300, RED, RED);
check("cloneUndoStroke", C, 500, 700, null, WHITE);
if (!sameAsOrig()) throw new Error("undo on the copy changed the original");
const cb = C.px.readRect(0, 0, 2400, 1600).data;
let diff = 0;
for (let i = 0; i < cb.length; i++) if (cb[i] !== origBytes[i]) diff++;
out.copyBackToOriginal = diff;
if (diff) throw new Error("after undo the copy is not the original's pixels: " + diff + " bytes");
// 5. a selection outline dragged with the marquee tool: the outline's pixels move exactly, the old place
// is cleared, and on tiles no move rewrites the whole selection (a full-size scratch per move). The
// selection also holds isolated faint pixels far from the rectangle (a wand's or a matte's speckle): the
// drag's extent used to come from the 1/16 display level, which rounds them away, so they stayed behind
// or were erased (C2 step b's review). Zoomed out with the selection shown as a tint, the screen is read
// in the middle of the drag: the outline is at its new place and gone from its old one (the levels are
// refreshed inside the rewritten box; pointer up rebuilds them all, so only a mid-drag read sees that).
await run("select_rect", { x: 400, y: 300, w: 300, h: 200, doc: window.__tb });
const dots = [[1800, 1200, 77], [2000, 400, 255], [1500, 1400, 115], [300, 1100, 153]];
for (const [x, y, a] of dots) { const d = new ImageData(1, 1); d.data.set([255, 0, 0, a]); ed.sel.writeRect(d, x, y); }
{ const d = new ImageData(3, 3); for (let i = 0; i < 9; i++) d.data.set([255, 0, 0, 77], i * 4); ed.sel.writeRect(d, 1200, 1300); }
ed.markSelectionChanged(undefined);
ed.setTool("rect");
const prevDisplay = ed.selectionDisplay;
ed.selectionDisplay = "tint";
ed.view.scale = 0.2; ed.view.angle = 0; ed._fitted = false;
ed.view.x = Math.round(ed.canvas.width / 2 - 650 * 0.2); ed.view.y = Math.round(ed.canvas.height / 2 - 450 * 0.2);
await settle();
const TINT = [255, 153, 153];
out.tintBefore = screenAt(560, 370);
if (!is(out.tintBefore, TINT)) throw new Error("the selection is not shown as a tint before the drag: " + out.tintBefore);
const selBefore = ed.sel.readRect(0, 0, 2400, 1600).data;
const b0 = ed.sel.bounds();
const sel = ed.sel;
let whole = 0;
const big = (rect) => !rect || (Math.min(2400, rect[2]) - Math.max(0, rect[0])) * (Math.min(1600, rect[3]) - Math.max(0, rect[1])) >= 2400 * 1600;
const wrapped = {};
for (const name of ["drawInto", "clear", "blit"]) {
    const f = sel[name];
    wrapped[name] = [Object.prototype.hasOwnProperty.call(sel, name), f];
    sel[name] = function (...a) { if (big(name === "blit" ? (a[5] ? [a[1], a[2], a[1] + a[5][2] - a[5][0], a[2] + a[5][3] - a[5][1]] : null) : a[0])) whole++; return f.apply(this, a); };
}
try {
    ed.canvas.dispatchEvent(ev("pointerdown", 550, 420));
    out.dragKind = ed.pointer && ed.pointer.kind;
    for (let i = 1; i <= 8; i++) { ed.canvas.dispatchEvent(ev("pointermove", 550 + 25 * i, 420 + 12.5 * i)); await wait(16); }
    // before pointer up: the frame the user sees while dragging
    ed.sceneSig = null; ed.draw();
    // the old place is outside the outline's new extent (above it), so only a refresh of the union of both clears it
    out.midDrag = { oldPlace: screenAt(560, 370), newPlace: screenAt(760, 520) };
    ed.canvas.dispatchEvent(ev("pointerup", 750, 520));
} finally {
    for (const [name, [own, f]] of Object.entries(wrapped)) { if (own) sel[name] = f; else delete sel[name]; }
    ed.selectionDisplay = prevDisplay;
}
await settle();
const b1 = ed.sel.bounds();
out.selDrag = { b0, b1, whole };
if (out.dragKind !== "selmove") throw new Error("the drag did not move the outline: " + out.dragKind);
if (ed.tileMode && whole) throw new Error("a move rewrote the whole selection: " + whole);
if (!is(out.midDrag.newPlace, TINT) || !is(out.midDrag.oldPlace, WHITE)) throw new Error("during the drag the screen does not show the outline at its new place only: " + JSON.stringify(out.midDrag));
const dx = b1[0] - b0[0], dy = b1[1] - b0[1];
if (Math.abs(dx - 200) > 3 || Math.abs(dy - 100) > 3 || b1[2] - b1[0] !== b0[2] - b0[0] || b1[3] - b1[1] !== b0[3] - b0[1]) throw new Error("the outline did not move by the drag: " + JSON.stringify(out.selDrag));
const selAfter = ed.sel.readRect(0, 0, 2400, 1600).data;
let bad = 0;
for (let y = 0; y < 1600; y++) {
    for (let x = 0; x < 2400; x++) {
        const sx = x - dx, sy = y - dy;
        const i = (y * 2400 + x) * 4;
        const want = sx >= 0 && sy >= 0 && sx < 2400 && sy < 1600 ? selBefore[(sy * 2400 + sx) * 4 + 3] : 0;
        if (selAfter[i + 3] !== want) bad++;
    }
}
out.selDrag.badPixels = bad;
out.selDrag.dots = dots.map(([x, y]) => [selAfter[(y * 2400 + x) * 4 + 3], selAfter[((y + dy) * 2400 + x + dx) * 4 + 3]]);
if (bad) throw new Error("the moved selection is not the old one shifted: " + bad + " pixels, the faint dots [old place, new place]: " + JSON.stringify(out.selDrag.dots));
ed.setTool("select");
await run("close_document", { doc: window.__tb });
return out;
"""


SELECTION_STEP = """
// C3: the selection's tint and its marching ants are drawn from the mask itself - on tiles from the
// part of it the view shows, at the view's level, with no display mirror of the whole selection, no
// GPU copy of one and no pyramid entry. Checked on the screen (the overlay covers the selection and
// nothing else) at a zoom that draws from a level and at 1:1, after a pan and after the selection
// changed, and on both backends, so the two are held to the same picture.
const P = await import("./editor/inpaint_pixels.js");
const d = await run("new_document");
await run("new_canvas", { width: 4000, height: 3000, doc: d.id });
const ed = ednow(d.id);
const L = ed.addPaintLayer();
L.px.fill([0, 0, 4000, 3000], "#ffffff");
ed.markLayerChanged(L);
await run("select_rect", { x: 2000, y: 1500, w: 800, h: 600, doc: d.id });
const out = { tiles: !!ed.tileMode };
const shot = () => {
    ed.sceneSig = null;
    ed.draw();
    const c = document.createElement("canvas");
    c.width = ed.canvas.width; c.height = ed.canvas.height;
    c.getContext("2d").drawImage(ed.canvas, 0, 0);
    return c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
};
// the tint is red at 0.4 over white: inside the selection the screen is not white, outside it is
const check = (label, box) => {
    const px = shot();
    const W = ed.canvas.width;
    const at = (ix, iy) => {
        const [sx, sy] = ed.imageToScreen(ix, iy);
        const x = Math.round(sx), y = Math.round(sy);
        if (x < 1 || y < 1 || x >= W - 1 || y >= ed.canvas.height - 1) return null;
        const i = (y * W + x) * 4;
        return [px[i], px[i + 1], px[i + 2], px[i + 3]];
    };
    const tinted = (p) => p && p[3] > 0 && (p[0] - p[1] > 20 || p[0] - p[2] > 20);
    const inside = [[box[0] + 40, box[1] + 40], [box[2] - 40, box[3] - 40], [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]];
    const outside = [[box[0] - 40, box[1] + 40], [box[2] + 40, box[3] - 40], [(box[0] + box[2]) / 2, box[1] - 40]];
    const got = { inside: inside.map(([x, y]) => at(x, y)), outside: outside.map(([x, y]) => at(x, y)) };
    out[label] = got;
    for (const p of got.inside) if (p && !tinted(p)) throw new Error(label + ": the selection is not tinted: " + JSON.stringify(got));
    for (const p of got.outside) if (p && tinted(p)) throw new Error(label + ": the tint reaches outside the selection: " + JSON.stringify(got));
};
ed.selectionDisplay = "tint";
ed.fitView();
ed.draw();
check("fit", [2000, 1500, 2800, 2100]);
// 1:1 on the middle of the picture: the region starts well inside it, so its origin counts
ed.view.scale = 1; ed.view.angle = 0; ed._fitted = false;
ed.view.x = Math.round(ed.canvas.width / 2 - 2400); ed.view.y = Math.round(ed.canvas.height / 2 - 1800);
ed.draw();
check("oneToOne", [2000, 1500, 2800, 2100]);
ed.view.x -= 200; ed.view.y -= 120;   // a pan: the region moves, the mask does not
ed.draw();
check("afterPan", [2000, 1500, 2800, 2100]);
await run("select_rect", { x: 2300, y: 1800, w: 500, h: 400, doc: d.id });
check("afterChange", [2300, 1800, 2800, 2200]);
// the ants: the same mask, drawn as an outline, so the middle of the selection is untouched white
ed.selectionDisplay = "ants";
ed.draw();
{
    const px = shot();
    const W = ed.canvas.width;
    const [mx, my] = ed.imageToScreen(2550, 2000);
    const i = (Math.round(my) * W + Math.round(mx)) * 4;
    out.antsMiddle = [px[i], px[i + 1], px[i + 2], px[i + 3]];
    if (px[i] !== 255 || px[i + 1] !== 255 || px[i + 2] !== 255) throw new Error("the ants filled the selection: " + JSON.stringify(out.antsMiddle));
    // and the outline is there: some pixel on the edge is not white
    let edge = 0;
    for (let ix = 2300; ix <= 2800; ix += 5) {
        const [sx, sy] = ed.imageToScreen(ix, 1800);
        // the outline is about 1.25 screen px wide and dashed: a band of five rows, any pixel of it
        for (let dy = -2; dy <= 2; dy++) {
            const j = ((Math.round(sy) + dy) * W + Math.round(sx)) * 4;
            if (px[j] !== 255 || px[j + 1] !== 255 || px[j + 2] !== 255) { edge++; break; }
        }
    }
    out.antsEdge = edge;
    if (edge < 10) throw new Error("no marching ants on the selection's edge: " + edge);
}
if (ed.tileMode) {
    out.selMirror = !!ed.sel.displayCanvasIfMade();
    out.selRegion = !!ed.sel.regionCanvasesIfMade().length;
    out.selPyramid = !!ed.pyramids.get(P.displayCanvasIfMade(ed.sel));
    if (out.selMirror || out.selPyramid) throw new Error("the selection still has a display mirror or a pyramid: " + JSON.stringify(out));
    if (!out.selRegion) throw new Error("the selection was not drawn from its tiles: " + JSON.stringify(out));
    const freed = ed.sel.releaseDisplay();
    out.freed = freed;
    if (!freed || ed.sel.regionCanvasesIfMade().length) throw new Error("releaseDisplay kept the region canvas: " + freed);
}
ed.selectionDisplay = "ants";
await run("close_document", { doc: d.id });
return out;
"""


UNDRAWN_STEP = """
// C2 step (b)'s review, the display caches on the flag's backend. (1) Pixels nothing draws get no display
// mirror: in a tab that is not in front, after the mirrors were released (what the memory watch does), a
// thumbnail of every layer (one of them hidden, one masked), a rect write into the hidden layer, a selection
// change with its undo step and bounds, and a click that picks a layer make none (each used to make one as
// large as the pixels). The thumbnails still show the layers (the mask applied) and the pick reads the mask.
const P = await import("./editor/inpaint_pixels.js");
const d = await run("new_document");
window.__dc = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { width: 3000, height: 2000, doc: d.id });
const out = { tiles: ed.tileMode };
const H = ed.addPaintLayer();
H.px.fill([200, 200, 2800, 1800], "#2050c0"); ed.markLayerChanged(H);
H.visible = false;
const V = ed.addPaintLayer();
V.px.fill([500, 500, 1500, 1500], "#c05020"); ed.markLayerChanged(V);
V.maskPx = ed.pixels.Mask.empty(3000, 2000);
V.maskPx.fill([0, 0, 1000, 2000], "#ffffff"); ed.markMaskChanged(V);
ed.renderLayers();
ed.fitView();
for (let i = 0; i < 8; i++) { ed.sceneSig = null; ed.draw(); await wait(20); if (!ed._pyramidPending) break; }
host.shell.activate(ednow(window.__t));   // the document goes to the background
await wait(100);
// synchronous from here on: no frame of any tab can run in between
const held = () => [["hidden", H.px], ["visible", V.px], ["mask", V.maskPx], ["selection", ed.sel], ["base", ed._basePx]];
const made = () => ed.tileMode ? held().filter(([, p]) => p && p.displayCanvasIfMade()).map(([n]) => n) : [];
out.released = ed.releaseCaches({ mirrors: true });
out.afterRelease = made();
ed.renderLayers();
out.thumbnails = made();
H.px.fill([10, 10, 20, 20], "#ffff00"); ed.markLayerChanged(H, [10, 10, 20, 20]);
out.rectWriteHidden = made();
ed.pushUndo({ kind: "selection" });
ed.sel.fill([100, 100, 400, 300], "#ff0000"); ed.markSelectionChanged(undefined, [100, 100, 400, 300]);
out.bounds = ed.getBounds();
out.selection = made();
out.pick = [ed.pickLayerAt(800, 800), ed.pickLayerAt(1200, 800), ed.pickLayerAt(2000, 1000)].map((l) => l && l.name);
out.picked = made();
const thumb = (l, ix, iy) => {
    const c = ed.layerList.querySelector('.ipc-layer[data-layer="' + l.id + '"] canvas.ipc-lthumb');
    if (!c) return null;
    const s = Math.min(c.width / 3000, c.height / 2000), x0 = (c.width - 3000 * s) / 2, y0 = (c.height - 2000 * s) / 2;
    return Array.from(c.getContext("2d").getImageData(Math.floor(x0 + ix * s), Math.floor(y0 + iy * s), 1, 1).data);
};
out.thumbPixels = { hidden: thumb(H, 1500, 1000), visibleInMask: thumb(V, 750, 1000), visibleOutsideMask: thumb(V, 1350, 1000) };
host.shell.activate(ed);
if (out.afterRelease.length) throw new Error("releaseCaches({ mirrors: true }) kept mirrors: " + out.afterRelease);
for (const k of ["thumbnails", "rectWriteHidden", "selection", "picked"]) if (out[k].length) throw new Error(k + " made display mirrors of pixels nothing draws: " + JSON.stringify(out));
if (!out.bounds || out.bounds.join() !== "100,100,400,300") throw new Error("the selection's bounds: " + out.bounds);
if (out.pick[0] !== V.name || out.pick[1] !== null || out.pick[2] !== null) throw new Error("pickLayerAt (masked, outside the mask, hidden): " + JSON.stringify(out.pick));
const tp = out.thumbPixels;
if (!tp.hidden || tp.hidden[3] < 200 || tp.hidden[2] < 150 || tp.visibleInMask[3] < 200 || tp.visibleInMask[0] < 150 || tp.visibleOutsideMask[3] > 20) throw new Error("the thumbnails do not show the layers: " + JSON.stringify(tp));
// (2) a display canvas someone holds does not keep its pixels (the mirror's version was an accessor closing
// over them): checked after a forced collection by the caller
const p = ed.pixels.Layer.empty(1024, 1024);
p.fill([0, 0, 600, 600], "#00ff00");
window.__heldDisplay = P.canvasOf(p);
window.__droppedPixels = new WeakRef(p);
return out;
"""

SCREEN_STEP = """
// (3) The screen never draws a CPU mirror (on tiles the display canvas is one): zoomed in (0.6 and 1, no
// display levels), a pan with a filter layer in the stack (Canvas 2D), a pan without one (the GPU
// compositor), the selection as a tint and as ants, a selection drag and a stroke commit: no drawImage /
// texImage2D takes a mirror once the frames are warm (each used to move the whole mirror every frame:
// 44 ms a pan frame at 6000 x 4000). (4) The compositor drops a texture no composite asked for in a while
// (its map keys on the canvases and kept a flipped layer's old pixels).
const ed = ednow(window.__dc);
host.shell.activate(ed);
if (window.__droppedPixels.deref()) throw new Error("a held display canvas keeps its pixels alive");
window.__heldDisplay = null; window.__droppedPixels = null;
const out = { tiles: ed.tileMode };
// an unmasked layer: a masked one is drawn from its masked cache, which is rebuilt (from the mirror) per change
const W = ed.addPaintLayer();
W.px.fill([300, 300, 1700, 1700], "#40a060"); ed.markLayerChanged(W);
const rect = () => ed.canvas.getBoundingClientRect();
const client = (ix, iy) => { const r = rect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: r.left + sx * r.width / ed.canvas.width, clientY: r.top + sy * r.height / ed.canvas.height }; };
const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 12, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
let mirrorDraws = 0;
const isMirror = (s) => !!(s && s._cpuMirror);
const d2 = CanvasRenderingContext2D.prototype.drawImage, t2 = WebGL2RenderingContext.prototype.texImage2D, t1 = WebGLRenderingContext.prototype.texImage2D;
CanvasRenderingContext2D.prototype.drawImage = function (s, ...a) { if (isMirror(s)) mirrorDraws++; return d2.call(this, s, ...a); };
WebGL2RenderingContext.prototype.texImage2D = function (...a) { if (isMirror(a[a.length - 1])) mirrorDraws++; return t2.apply(this, a); };
WebGLRenderingContext.prototype.texImage2D = function (...a) { if (isMirror(a[a.length - 1])) mirrorDraws++; return t1.apply(this, a); };
const centre = (scale) => { ed.view.scale = scale; ed.view.angle = 0; ed._fitted = false; ed.view.x = Math.round(ed.canvas.width / 2 - 900 * scale); ed.view.y = Math.round(ed.canvas.height / 2 - 900 * scale); };
const frame = () => { ed.sceneSig = null; ed.draw(); };
const rows = {};
const count = async (label, n, body) => {
    for (let i = 0; i < 3; i++) { frame(); await wait(15); }   // warm: the GPU copies are made once
    mirrorDraws = 0;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { await body(i); await wait(10); }
    rows[label] = { mirrorDraws, ms: +((performance.now() - t0) / n).toFixed(1) };
};
let fx = null;
try {
    await run("select_rect", { x: 700, y: 700, w: 400, h: 300, doc: window.__dc });
    for (const filter of [true, false]) {
        if (filter) fx = ed.addFilterLayer("levels"); else if (fx) { ed.removeLayer(fx.id); fx = null; }
        for (const scale of [0.6, 1]) {
            for (const disp of ["tint", "ants"]) {
                ed.selectionDisplay = disp;
                centre(scale);
                await count(`${filter ? "filter" : "gpu"}@${scale} ${disp} pan`, 6, async () => { ed.view.x += 7; frame(); });
            }
            ed.selectionDisplay = "tint";
            ed.setTool("rect");
            centre(scale);
            await count(`${filter ? "filter" : "gpu"}@${scale} selection drag`, 1, async () => {
                ed.canvas.dispatchEvent(ev("pointerdown", 900, 850));
                for (let i = 1; i <= 5; i++) { ed.canvas.dispatchEvent(ev("pointermove", 900 + 10 * i, 850 + 6 * i)); frame(); await wait(10); }
                // pointer up touches the whole selection, and its GPU copy is made again once: not a frame's cost
                const moves = mirrorDraws;
                ed.canvas.dispatchEvent(ev("pointerup", 950, 880)); frame();
                mirrorDraws = moves;
            });
            await count(`${filter ? "filter" : "gpu"}@${scale} after the drag`, 3, async () => { ed.view.y += 5; frame(); });
        }
    }
    ed.clearSelection();
    ed.activeLayerId = W.id; ed.setTool("paint"); ed.color = "#00ff00"; ed.brushSize = 30; ed.hardness = 1; ed.brushOpacity = 1;
    centre(1);
    for (let i = 0; i < 3; i++) { frame(); await wait(15); }
    ed.canvas.dispatchEvent(ev("pointerdown", 700, 900));
    for (let i = 1; i <= 5; i++) { ed.canvas.dispatchEvent(ev("pointermove", 700 + 20 * i, 900)); frame(); await wait(10); }
    mirrorDraws = 0;   // a stroke's own preview copies the layer: counted from its commit on
    ed.canvas.dispatchEvent(ev("pointerup", 800, 900)); frame();
    for (let i = 0; i < 3; i++) { await wait(10); frame(); }
    rows["gpu@1 stroke commit"] = { mirrorDraws };
    // the navigator's composite (drawThumb's view pass at its own small scale, run on every change) is not the
    // screen: it must not drop the GPU copies the 1:1 view draws, or every edit would move the mirrors again
    for (let i = 0; i < 2; i++) { frame(); await wait(15); }
    mirrorDraws = 0;
    {
        const c = document.createElement("canvas"); c.width = 300; c.height = 200;
        const x = c.getContext("2d"); x.setTransform(300 / ed.width, 0, 0, 200 / ed.height, 0, 0);
        const prev = ed.viewPass;
        ed.viewPass = { x: 0, y: 0, w: ed.width, h: ed.height, sx: 300 / ed.width, sy: 200 / ed.height };
        try { ed.drawComposite(x); } finally { ed.viewPass = prev; }
    }
    mirrorDraws = 0;   // the navigator itself may read a mirror (its levels, once); the frames after it count
    for (let i = 0; i < 3; i++) { await wait(10); frame(); }
    rows["gpu@1 after a navigator composite"] = { mirrorDraws };
} finally {
    CanvasRenderingContext2D.prototype.drawImage = d2; WebGL2RenderingContext.prototype.texImage2D = t2; WebGLRenderingContext.prototype.texImage2D = t1;
    ed.selectionDisplay = "ants"; ed.setTool("select");
}
out.rows = rows;
if (ed.tileMode) for (const [k, r] of Object.entries(rows)) if (r.mirrorDraws) throw new Error(k + ": the screen drew a CPU mirror " + r.mirrorDraws + " times: " + JSON.stringify(rows));
// (4) an unmasked layer flipped three times at zoom 1: the textures of its replaced display canvases leave the
// compositor within its age limit (the budget alone kept them)
const comp = ed.compositor();
if (!comp) throw new Error("no GPU compositor");
ed.activeLayerId = W.id;
centre(1);
const old = new Set();
const flipped = [];
for (let i = 0; i < 3; i++) {
    frame(); await wait(15);
    for (const k of comp.textures.keys()) old.add(k);
    flipped.push(new WeakRef(W.px));
    ed.flipLayer("h");
}
// (5) C6 (a): the atlas keeps only what the document draws. A flip replaces the layer's pixels and its undo step
// holds a clone, so the pixels it replaced are in neither, and the atlas (a Map keyed on them) kept them and
// every tile they had until their pages aged out: three flips of a 15k layer held 2.4 GB. The release after the
// flip gives their pages back, the pixels still drawn keep theirs (a forgotten live layer would upload again on
// every frame), and a replacement nobody announces (a plugin writing layer.px) does not keep the old pixels alive
// either: the caller checks both WeakRefs after a forced collection.
if (ed.tileMode) {
    frame(); await wait(15);
    const live = new Set([ed._basePx, ed.sel]);
    for (const l of ed.layers) { live.add(l.px); live.add(l.maskPx); }
    const records = [...comp.atlas.values()].map((r) => r.ref.deref());
    const a = { records: records.length, notDrawn: records.filter((p) => !p || !live.has(p)).length,
                flippedBytes: flipped.map((w) => (w.deref() ? comp.pixelBytes(w.deref()) : 0)), liveBytes: comp.pixelBytes(W.px) };
    const u0 = comp.stats().atlas.uploads;
    frame(); await wait(15); frame();
    a.uploadsAfterRelease = comp.stats().atlas.uploads - u0;
    out.atlasAfterFlips = a;
    if (a.notDrawn || a.flippedBytes.some(Boolean)) throw new Error("the atlas keeps pages of pixels the document no longer draws: " + JSON.stringify(a));
    if (!a.liveBytes || a.uploadsAfterRelease) throw new Error("the release took the pages of pixels the document still draws: " + JSON.stringify(a));
    // new pixels and a new mask with no undo step, announced as a whole change (what a plugin's refresh(key) does
    // after writing rawLayer(key).px / maskPx): the whole change queues the release
    // one at a time: the release is for the whole document, so either change's release would take both
    {
        const p0 = W.px;
        const had = comp.pixelBytes(p0);
        W.px = ed.pixels.Layer.fromImageData(p0.readRect(0, 0, p0.width, p0.height));
        ed.markLayerChanged(W);
        frame(); await wait(15); frame();
        a.newLayer = { had, old: comp.pixelBytes(p0), now: comp.pixelBytes(W.px) };
        if (!had) throw new Error("the replaced layer had no atlas pages to give back (the check would pass on nothing): " + JSON.stringify(a.newLayer));
        if (a.newLayer.old) throw new Error("a whole layer change with new pixels kept the old pixels' atlas pages: " + JSON.stringify(a.newLayer));
        if (!a.newLayer.now) throw new Error("the new pixels were not drawn from the atlas: " + JSON.stringify(a.newLayer));
    }
    {
        const V = ed.layers.find((l) => l.maskPx);   // the masked layer of the step before
        const m0 = V.maskPx;
        const had = comp.pixelBytes(m0);
        V.maskPx = m0.clone();
        ed.markMaskChanged(V);
        frame(); await wait(15); frame();
        a.newMask = { had, old: comp.pixelBytes(m0), now: comp.pixelBytes(V.maskPx) };
        if (!had) throw new Error("the replaced mask had no atlas pages to give back (the check would pass on nothing): " + JSON.stringify(a.newMask));
        if (a.newMask.old) throw new Error("a whole mask change with a new mask kept the old mask's atlas pages: " + JSON.stringify(a.newMask));
        if (!a.newMask.now) throw new Error("the new mask was not drawn from the atlas: " + JSON.stringify(a.newMask));
    }
    // the base replaced two ways, each queuing its own release (nothing else does in between, so a missing one
    // keeps the old base's pages): `setBase` with a new image into the open document (what load_image and a
    // restore do; it keeps the layers here so the checks below still have them), and a new base object with its own
    // pixels (what a crop, a resize, a merge into the base and a flatten do: C6 d)
    {
        const c = document.createElement("canvas"); c.width = ed.width; c.height = ed.height;
        const cx = c.getContext("2d"); cx.fillStyle = "#808080"; cx.fillRect(0, 0, c.width, c.height);
        const url = c.toDataURL("image/png");
        const image = () => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
        const b0 = ed.basePx;
        const had = comp.pixelBytes(b0);
        await ed.setBase(ed.base.ref, await image(), { keepLayers: true });
        centre(1);
        frame(); await wait(15); frame();
        a.newBase = { had, old: comp.pixelBytes(b0), now: comp.pixelBytes(ed._basePx), layers: ed.layers.length };
        if (!had) throw new Error("the replaced base had no atlas pages to give back (the check would pass on nothing): " + JSON.stringify(a.newBase));
        if (a.newBase.old) throw new Error("setBase with a new image kept the old base's atlas pages: " + JSON.stringify(a.newBase));
        if (!a.newBase.now || ed._basePx === b0) throw new Error("the new base was not drawn from the atlas: " + JSON.stringify(a.newBase));
        const b1 = ed._basePx;
        const had1 = comp.pixelBytes(b1);
        ed.base = { ref: ed.base.ref, px: ed.pixels.Layer.fromImage(await image()) };
        frame(); await wait(15); frame();
        a.baseImage = { had: had1, old: comp.pixelBytes(b1), now: comp.pixelBytes(ed._basePx), replaced: ed._basePx !== b1 };
        if (!a.baseImage.replaced) throw new Error("a new base object did not replace the base's pixels: " + JSON.stringify(a.baseImage));
        if (a.baseImage.old) throw new Error("a new base image kept the old base pixels' atlas pages: " + JSON.stringify(a.baseImage));
        if (!a.baseImage.now) throw new Error("the new base pixels were not drawn from the atlas: " + JSON.stringify(a.baseImage));
    }
    const before = W.px;
    W.px = ed.pixels.Layer.fromImageData(before.readRect(0, 0, before.width, before.height));
    ed.touchSource(W.px);
    frame(); await wait(15); frame();
    // a flipped-away object an older `layers` step holds by reference (the filter layer added and removed above)
    // stays alive for that step; the others are held by nothing but, before C6 (a), the atlas
    const held = ed.heldPixels();
    window.__atlasHeld = { flipped: flipped.filter((w) => !held.has(w.deref())), stepHeld: flipped.length - flipped.filter((w) => !held.has(w.deref())).length, replaced: new WeakRef(before) };
}
// the caller collects garbage here (for (5)) and then runs SCREEN_STEP_TAIL: its 320 frames would age the pages out
window.__screen = { old, out };
return out;
"""

SCREEN_STEP_TAIL = """
const ed = ednow(window.__dc);
const comp = ed.compositor();
const { old, out } = window.__screen;
window.__screen = null;
const frame = () => { ed.sceneSig = null; ed.draw(); };
let frames = 0;
while (frames < 320) { frame(); frames++; if (frames % 40 === 0) await wait(1); }
const left = [...comp.textures].filter(([k, e]) => old.has(k) && e.used !== comp.frame).length;
out.compositor = { seen: old.size, frames, left, stats: comp.stats() };
if (left) throw new Error("the compositor still holds " + left + " textures no composite asked for in " + frames + " frames: " + JSON.stringify(out.compositor));
await run("close_document", { doc: window.__dc, force: true });
return out;
"""


FINAL_STEP = """
// C2's final review, on the flag's backend. (1) A selection drag on canvases does not redraw the selection's
// display levels on every move (35 to 46 ms of GPU work a move at 15k; the levels are dropped as in 0.1.12).
// (2) The undo of a mask brush stroke works (its `mask` flag was loaded as an image). (3) Fill, clear and mask
// from a small selection, a fill on a mask, flip and both turns, each undone and redone: the pixels are right,
// and on tiles no step holds a PNG, no write or restore covers the whole layer and nothing is materialised whole
// (a whole-layer scratch per fill was 0.7 to 1.1 s at 96 MP; the PNG of a 20k flip failed to encode); flips and
// turns move the bytes exactly. An extend and its undo keep the selection. (4) An empty selection makes no display
// mirror. (5) Removed layers give their mirrors back. (6) The memory report counts shared tiles once. (7) An image
// above 268 MP is refused on tiles, and a selection encode that cannot make its canvas neither throws out of
// getValue nor stops later encodes.
const P = await import("./editor/inpaint_pixels.js");
const T = await import("./editor/inpaint_tiles.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { width: 2400, height: 1600, doc: d.id });
const out = { tiles: ed.tileMode };
const fails = [];
const r = () => ed.canvas.getBoundingClientRect();
const client = (ix, iy) => { const b = r(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: b.left + sx * b.width / ed.canvas.width, clientY: b.top + sy * b.height / ed.canvas.height }; };
const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 15, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
const frame = () => { ed.sceneSig = null; ed.draw(); };
const centre = (scale, cx, cy) => { ed.view.scale = scale; ed.view.angle = 0; ed._fitted = false; ed.view.x = Math.round(ed.canvas.width / 2 - cx * scale); ed.view.y = Math.round(ed.canvas.height / 2 - cy * scale); };
const all = (p) => p.readRect(0, 0, p.width, p.height).data.slice();
// the pixels a step put back: to the byte on tiles (a clone), within a level premultiplied on canvases (a PNG)
const worst = (a, b) => { if (a.length !== b.length) return 255; let m = 0; for (let i = 0; i < a.length; i += 4) { const aa = a[i + 3], ba = b[i + 3]; let v = Math.abs(aa - ba); for (let k = 0; k < 3; k++) v = Math.max(v, Math.abs(a[i + k] * aa / 255 - b[i + k] * ba / 255)); if (v > m) m = v; } return +m.toFixed(1); };
const exact = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const back = (label, a, b) => { const ok = ed.tileMode ? exact(a, b) : worst(a, b) <= 1; if (!ok) fails.push(label + ": not the pixels of before (" + worst(a, b) + " levels)"); };

// (1) the selection drag at zoom 0.6
await run("select_rect", { x: 500, y: 400, w: 600, h: 400, doc: d.id });
ed.setTool("rect");
centre(0.6, 800, 600);
for (let i = 0; i < 3; i++) { frame(); await wait(15); }
{
    const levels = new Set();
    let levelDraws = 0;
    const d2 = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...a) { if (levels.has(this.canvas)) levelDraws++; return d2.apply(this, a); };
    try {
        ed.canvas.dispatchEvent(ev("pointerdown", 800, 600));
        const entry = ed.pyramids.get(P.canvasOf(ed.sel));   // on canvases the pointer-down's undo step built them
        out.drag = { kind: ed.pointer && ed.pointer.kind, levelsAtDown: entry ? entry.levels.filter(Boolean).length : 0 };
        if (entry) for (const l of entry.levels) if (l) levels.add(l);
        for (let i = 1; i <= 6; i++) { ed.canvas.dispatchEvent(ev("pointermove", 800 + 15 * i, 600 + 9 * i)); frame(); await wait(10); }
        out.drag.levelDraws = levelDraws;
        ed.canvas.dispatchEvent(ev("pointerup", 890, 654));
    } finally {
        CanvasRenderingContext2D.prototype.drawImage = d2;
        ed.setTool("select");
    }
    out.drag.bounds = ed.getBounds();
    if (out.drag.kind !== "selmove") fails.push("the drag did not move the outline: " + JSON.stringify(out.drag));
    if (!ed.tileMode && !out.drag.levelsAtDown) fails.push("no display levels at pointer down, the check sees nothing: " + JSON.stringify(out.drag));
    if (levelDraws) fails.push("the drag redrew the selection's display levels " + levelDraws + " times at zoom 0.6: " + JSON.stringify(out.drag));
    const bb = out.drag.bounds, want = [590, 454, 1190, 854];
    if (!bb || bb.some((v, i) => Math.abs(v - want[i]) > 3) || bb[2] - bb[0] !== 600 || bb[3] - bb[1] !== 400) fails.push("the outline did not move by the drag: " + JSON.stringify(out.drag));
}
await run("select_none", { doc: d.id });
ed.fitView();

// (2) a mask brush stroke and its undo
{
    const M = ed.addPaintLayer();
    M.px.fill(null, "#ff0000"); ed.markLayerChanged(M);
    await run("select_rect", { x: 200, y: 200, w: 800, h: 600, doc: d.id });
    ed.maskFromSelection(M);
    ed.clearSelection();
    const mask0 = all(M.maskPx);
    ed.toggleMaskEdit(M);
    ed.setTool("paint"); ed.color = "#000000"; ed.brushSize = 60; ed.hardness = 1; ed.brushOpacity = 1;
    frame(); await wait(30);
    // below the mask's rectangle, where it hides: the brush reveals there
    ed.canvas.dispatchEvent(ev("pointerdown", 300, 900));
    for (let i = 1; i <= 8; i++) { ed.canvas.dispatchEvent(ev("pointermove", 300 + 60 * i, 900)); await wait(16); }
    ed.canvas.dispatchEvent(ev("pointerup", 780, 900));
    await wait(80);
    const top = ed.undo[ed.undo.length - 1];
    const painted = !exact(all(M.maskPx), mask0);
    await ed.undoStep();
    out.maskStroke = { step: top && top.kind, flag: top && top.mask, painted, status: ed.status };
    if (!top || top.kind !== "layerrect" || top.mask !== true || !painted) fails.push("no mask stroke to undo: " + JSON.stringify(out.maskStroke));
    else if (/could not be restored/.test(ed.status) || !exact(all(M.maskPx), mask0)) fails.push("the mask stroke's undo failed: " + JSON.stringify(out.maskStroke));
    ed.toggleMaskEdit(M);
    ed.setTool("select");
    ed.removeLayer(M.id);
}

// (3) whole-layer steps and small-selection writes
const L = ed.addPaintLayer();
L.px.fill(null, "#ff0000"); ed.markLayerChanged(L);
const O = ed.addLayer({ name: "odd", kind: "paint", px: ed.pixels.Layer.empty(700, 300), x: 100, y: 100, w: 700, h: 300 });
O.px.drawInto(null, (x) => { const g = x.createLinearGradient(0, 0, 700, 300); g.addColorStop(0, "rgba(255, 0, 0, 1)"); g.addColorStop(1, "rgba(0, 0, 255, 0.2)"); x.fillStyle = g; x.fillRect(0, 0, 700, 300); });
{ const n = new ImageData(700, 20); for (let i = 0; i < n.data.length; i++) n.data[i] = (i * 7919) & 255; O.px.writeRect(n, 0, 140); }
ed.markLayerChanged(O);
ed.fitView(); frame(); await wait(30);
const counts = { wholeToCanvas: 0, wholeDrawInto: 0, snapUrl: 0, where: [] };
const where = () => { if (counts.where.length < 4) counts.where.push(String(new Error().stack).split(String.fromCharCode(10)).slice(2, 5).map((x) => x.trim().replace(/^at /, "")).join(" < ")); };
const protos = [ed.pixels.Layer.prototype, ed.pixels.Mask.prototype];
const saved = protos.map((pr) => [Object.prototype.hasOwnProperty.call(pr, "toCanvas") ? pr.toCanvas : null, Object.prototype.hasOwnProperty.call(pr, "drawInto") ? pr.drawInto : null]);
let counting = false;   // around the operations and their undo / redo only (a select_rect rewrites the whole selection until C5)
const whole = (p, rect) => !rect || (rect[0] <= 0 && rect[1] <= 0 && rect[2] >= p.width && rect[3] >= p.height);
for (const pr of protos) {
    const tc = pr.toCanvas, di = pr.drawInto;
    pr.toCanvas = function (rect) { if (counting && T.isTilePixels(this) && !rect && this.width * this.height >= 100000) { counts.wholeToCanvas++; where(); } return tc.call(this, rect); };
    pr.drawInto = function (rect, fn) { if (counting && T.isTilePixels(this) && whole(this, rect) && this.width * this.height >= 100000) { counts.wholeDrawInto++; where(); } return di.call(this, rect, fn); };
}
const su = ed.snapUrl;
ed.snapUrl = function (...a) { counts.snapUrl++; return su.apply(this, a); };   // at any time
const find = (id) => ed.layers.find((l) => l.id === id);
const steps = {};
const roundTrip = async (label, pixelsOf, act, check) => {
    const before = all(pixelsOf()), bw = pixelsOf().width, bh = pixelsOf().height;
    const top0 = ed.undo[ed.undo.length - 1];
    counting = true;
    try { await act(); } finally { counting = false; }
    const after = all(pixelsOf());
    if (check) { const why = check(before, after, bw, bh); if (why) fails.push(label + ": " + why); }
    const step = ed.undo[ed.undo.length - 1];
    steps[label] = step && step !== top0 ? { kind: step.kind, png: !!(step.url || step.mask || step.selection), clone: !!(step.px || step.maskPx || step.selPx) } : null;
    counting = true;
    try { await ed.undoStep(); } finally { counting = false; }
    back(label + " undone", all(pixelsOf()), before);
    counting = true;
    try { await ed.redoStep(); } finally { counting = false; }
    back(label + " redone", all(pixelsOf()), after);
};
const at = (buf, w, x, y) => Array.from(buf.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
const onlyInside = (w, box, want) => (before, after) => {
    for (let y = box[1] - 3; y < box[3] + 3; y += 1) {
        for (let x = box[0] - 3; x < box[2] + 3; x += 1) {
            const inside = x >= box[0] && x < box[2] && y >= box[1] && y < box[3];
            const got = at(after, w, x, y), was = at(before, w, x, y);
            if (inside ? got.join() !== want.join() : got.join() !== was.join()) return "pixel " + x + "," + y + " is " + got + (inside ? ", not " + want : ", was " + was);
        }
    }
    let changed = 0;
    for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) changed++;
    const expect = (box[2] - box[0]) * (box[3] - box[1]) * 4;
    return changed > expect ? changed + " bytes changed, more than the selection's " + expect : null;
};
try {
    ed.activeLayerId = L.id;
    ed.brushOpacity = 1;
    await run("select_rect", { x: 1200, y: 700, w: 100, h: 100, doc: d.id });
    // zoomed out, the layer is drawn from display levels: on tiles the fill, the clear and their undo / redo refresh
    // them inside the box and keep them (a rebuild drew the whole CPU mirror into the first level, 200 ms at 96 MP)
    centre(0.3, 1200, 800);
    for (let i = 0; i < 6; i++) { frame(); await wait(20); if (!ed._pyramidPending) break; }
    // C6 b: the layer's chains from the whole changes above may still be in the mips worker, and their landing
    // uploads the slots that showed a coarse picture: counted from here they would be charged to the fill
    await ed.mipsSettled(); frame();
    // C3: the layer is drawn from the compositor's atlas, so it has no display mirror and no levels;
    // what must stay small is the number of slots the fill, the clear and their undo / redo re-upload
    const atlasUploads = () => { const c = ed.compositor(); return c ? c.stats().atlas.uploads : 0; };
    const uploads0 = atlasUploads();
    const mirror0 = ed.tileMode ? !!find(L.id).px.displayCanvasIfMade() : null;
    await roundTrip("fill", () => find(L.id).px, () => { ed.color = "#00ff00"; ed.fillSelection(); }, onlyInside(2400, [1200, 700, 1300, 800], [0, 255, 0, 255]));
    await roundTrip("clear", () => find(L.id).px, () => ed.clearSelectedPixels(), onlyInside(2400, [1200, 700, 1300, 800], [0, 0, 0, 0]));
    if (ed.tileMode) {
        frame();
        const px0 = find(L.id).px;
        const tileCount = px0.tileCount;
        out.levelsKept = { mirror0, mirror: !!px0.displayCanvasIfMade(), uploads: atlasUploads() - uploads0, tiles: tileCount };
        if (mirror0 || out.levelsKept.mirror) fails.push("the fill, the clear or their undo / redo made a display mirror of a layer the atlas draws: " + JSON.stringify(out.levelsKept));
        if (!out.levelsKept.uploads || out.levelsKept.uploads > tileCount) fails.push("the fill, the clear or their undo / redo re-uploaded the whole layer: " + JSON.stringify(out.levelsKept));
    }
    ed.fitView();
    const maskOf = () => find(L.id).maskPx || ed.pixels.Mask.empty(2400, 1600);
    await roundTrip("mask from selection", maskOf, () => ed.maskFromSelection(find(L.id)), onlyInside(2400, [1200, 700, 1300, 800], [255, 255, 255, 255]));
    find(L.id).maskEdit = true;
    await run("select_rect", { x: 1400, y: 900, w: 50, h: 50, doc: d.id });
    await roundTrip("fill on the mask", maskOf, () => ed.fillSelection(), onlyInside(2400, [1400, 900, 1450, 950], [255, 255, 255, 255]));
    find(L.id).maskEdit = false;
    await run("select_none", { doc: d.id });
    ed.activeLayerId = O.id;
    // (x, y) of the new pixels from (x, y) of the old, W x H the old size
    const mapped = (fn) => (before, after, W, H) => {
        if (!ed.tileMode) return null;   // the canvas path draws on the GPU, premultiplied: not to the byte
        const w = find(O.id).px.width, h = find(O.id).px.height;
        if (w * h !== W * H) return "the size is " + w + " x " + h;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const [sx, sy] = fn(x, y, W, H);
            if (at(after, w, x, y).join() !== at(before, W, sx, sy).join()) return "pixel " + x + "," + y + " is not " + sx + "," + sy + " of before";
        }
        return null;
    };
    await roundTrip("flip", () => find(O.id).px, () => ed.flipLayer("h"), mapped((x, y, W) => [W - 1 - x, y]));
    await roundTrip("flip vertically", () => find(O.id).px, () => ed.flipLayer("v"), mapped((x, y, W, H) => [x, H - 1 - y]));
    await roundTrip("turn clockwise", () => find(O.id).px, () => ed.rotateLayer90(1), mapped((x, y, W, H) => [y, H - 1 - x]));
    await roundTrip("turn counter-clockwise", () => find(O.id).px, () => ed.rotateLayer90(-1), mapped((x, y, W) => [W - 1 - y, x]));
    out.counts = { ...counts };
    await run("select_rect", { x: 300, y: 300, w: 200, h: 100, doc: d.id });
    const sel0 = all(ed.sel);
    await ed.extendCanvas({ right: 64 });
    const top = ed.undo[ed.undo.length - 1];
    steps.extend = top ? { kind: top.kind, png: !!top.selection, clone: !!top.selPx } : null;
    await ed.undoStep();
    if (ed.width !== 2400 || !exact(all(ed.sel), sel0)) fails.push("the extend's undo did not bring the size and the selection back: " + ed.width);
    out.countsWithExtend = { ...counts };
} finally {
    protos.forEach((pr, i) => { for (const [k, f] of [["toCanvas", saved[i][0]], ["drawInto", saved[i][1]]]) { if (f) pr[k] = f; else delete pr[k]; } });
    delete ed.snapUrl;
}
out.steps = steps;
const wantKinds = { fill: "layer", clear: "layer", "mask from selection": "mask", "fill on the mask": "mask", flip: "layerfull", "flip vertically": "layerfull", "turn clockwise": "layerfull", "turn counter-clockwise": "layerfull", extend: "canvas" };
for (const [k, kind] of Object.entries(wantKinds)) {
    const s = steps[k];
    if (!s || s.kind !== kind) { fails.push(k + ": the step is " + JSON.stringify(s) + ", not " + kind); continue; }
    if (k === "mask from selection") { if (s.png || s.clone) fails.push(k + ": the layer had no mask, the step holds " + JSON.stringify(s)); continue; }
    if (ed.tileMode ? s.png || !s.clone : !s.png) fails.push(k + ": " + (ed.tileMode ? "a PNG step on tiles" : "no PNG on canvases") + ": " + JSON.stringify(s));
}
if (ed.tileMode && (out.counts.wholeToCanvas || out.counts.wholeDrawInto || out.countsWithExtend.snapUrl)) fails.push("whole-layer work on tiles: " + JSON.stringify(out.countsWithExtend));

// (4) an empty selection draws nothing and makes no mirror
await run("select_none", { doc: d.id });
ed.selectionDisplay = "tint";
ed.releaseCaches({ mirrors: true });
ed.fitView();
for (let i = 0; i < 3; i++) { frame(); await wait(15); }
centre(1, 1200, 800);
for (let i = 0; i < 3; i++) { frame(); await wait(15); }
ed.drawThumb();
ed.selectionDisplay = "ants";
out.emptySelectionMirror = ed.tileMode ? !!ed.sel.displayCanvasIfMade() : null;
if (out.emptySelectionMirror) fails.push("an empty selection made a display mirror");

// (5) removed layers give their display mirrors back
ed.fitView();
const gone = [];
for (let i = 0; i < 3; i++) { const l = ed.addPaintLayer(); l.px.fill([100 * i, 100, 900 + 100 * i, 900], "rgba(0, 0, 255, 0.5)"); ed.markLayerChanged(l); gone.push(l); }
for (let i = 0; i < 4; i++) { frame(); await wait(20); if (!ed._pyramidPending) break; }
// C3: a layer the atlas drew holds atlas pages instead of a display mirror; both have to go with it
const comp3 = ed.compositor();
const atlasOf = (l) => (comp3 ? comp3.pixelBytes(l.px) : 0);
const madeBefore = ed.tileMode ? gone.filter((l) => l.px.displayCanvasIfMade() || atlasOf(l)).length : null;
for (const l of gone) await run("remove_layer", { layer: l.id, doc: d.id });
await wait(0);
out.removed = { madeBefore, kept: ed.tileMode ? gone.filter((l) => l.px.displayCanvasIfMade() || atlasOf(l)).length : null, report: ed.tileMode ? ed.memoryReport().undo.undo.heldLayerBytes : null };
if (ed.tileMode && (madeBefore !== 3 || out.removed.kept)) fails.push("removed layers kept their display mirrors or atlas pages: " + JSON.stringify(out.removed));
await ed.undoStep();
for (let i = 0; i < 4; i++) { frame(); await wait(20); if (!ed._pyramidPending) break; }
const [sx, sy] = ed.imageToScreen(850, 500);
out.removed.undoneOnScreen = Array.from(ed.canvas.getContext("2d").getImageData(Math.round(sx), Math.round(sy), 1, 1).data);
if (out.removed.undoneOnScreen[2] < 100 || out.removed.undoneOnScreen[0] > 200) fails.push("the layer whose removal was undone is not on screen: " + out.removed.undoneOnScreen);

// (6) the memory report counts a tile once however many pixels hold it
if (ed.tileMode) {
    ed.clearUndo();
    const S = ed.addPaintLayer();
    S.px.fill([0, 0, 1024, 1024], "#ff0000"); ed.markLayerChanged(S);
    // a rect copy over whole tiles shares them with the layer (x 256 to 770: tiles 1 and 2 whole)
    const rs = ed.snapshotRect(S, { x: 258, y: 258, w: 508, h: 508 });
    ed.pushUndoSnapshot(rs);
    const D = ed.duplicateLayer(S);
    D.px.fill([0, 0, 10, 10], "#00ff00"); ed.markLayerChanged(D, [0, 0, 10, 10]);
    const rep = ed.memoryReport();
    const distinct = new Set();
    for (const p of ed.heldPixels()) for (const t of p.tileList()) distinct.add(t);
    const order = ed.layers.filter((l) => l.id === S.id || l.id === D.id);
    const firstTiles = new Set(order[0].px.tileList());
    const second = order[1].px.tileList();
    const wantNew = second.filter((t) => !firstTiles.has(t)).length;
    const slot = rep.layers.list.find((x) => x.id === order[1].id).slots.find((s) => s.name === "canvas");
    const liveTiles = new Set();
    for (const l of ed.layers) for (const p of [l.px, l.maskPx]) if (p) for (const t of p.tileList()) liveTiles.add(t);
    const counted = new Set([...liveTiles, ...(ed._basePx ? ed._basePx.tileList() : []), ...ed.sel.tileList()]);
    const wantRect = rs.px.tileList().filter((t) => !counted.has(t)).reduce((a, t) => a + t.data.byteLength, 0);
    out.report = { tiles: rep.tiles.tiles, distinct: distinct.size, slot: { tiles: slot.tiles, shared: slot.sharedTiles }, wantNew, secondTiles: second.length, rectBytes: rep.undo.undo.rectBytes, wantRect, rectTiles: rs.px.tileList().length };
    if (rep.tiles.tiles !== distinct.size || rep.tiles.bytes !== [...distinct].reduce((a, t) => a + t.data.byteLength, 0)) fails.push("the report's tiles are not the distinct tiles held: " + JSON.stringify(out.report));
    if (!wantNew || slot.tiles !== wantNew || slot.sharedTiles !== second.length - wantNew || !slot.sharedTiles) fails.push("the duplicate's slot does not count shared tiles once: " + JSON.stringify(out.report));
    if (rep.undo.undo.rectBytes !== wantRect || wantRect === rs.px.tileList().length * 262144) fails.push("the rect step's bytes count tiles the layer holds: " + JSON.stringify(out.report));
}

// (7) above what a document on tiles can hold (E5 lifted the canvas limit of 268 MP: tools/huge_test.py; what is left is a
// side a band's canvas can have and a gigapixel), and a selection encode without its pixels
if (ed.tileMode) {
    out.huge = [];
    for (const [w, h] of [[70000, 1000], [40000, 30000]]) {
        let refused = null;
        try { await ed.setBase({ filename: "editor_test_huge.png", subfolder: "", type: "input" }, { naturalWidth: w, naturalHeight: h }); } catch (e) { refused = e.message; }
        out.huge.push({ refused, size: [ed.width, ed.height] });
        if (!refused || !/above what a document can hold/.test(refused) || ed.width !== 2400) fails.push("an image of " + w + " x " + h + " was taken on tiles: " + JSON.stringify(out.huge));
    }
}
await run("new_canvas", { width: 5000, height: 4000, doc: d.id });   // above SYNC_ENCODE_PX: the background encode
await run("select_rect", { x: 100, y: 100, w: 300, h: 200, doc: d.id });
{
    for (let i = 0; i < 100 && ed._selEncoding; i++) await wait(50);   // an autosave's encode still on its way
    const sel = ed.sel;
    // on tiles the PNG is read from the tiles (E5), on canvases from the canvas
    sel.toCanvas = () => { throw new Error("editor_test: no canvas"); };
    sel.readRect = () => { throw new Error("editor_test: no pixels"); };
    ed.selectionEncoded = false; ed.selectionDataUrl = null;
    let threw = null;
    try { ed.getValue(); } catch (e) { threw = e.message; } finally { delete sel.toCanvas; delete sel.readRect; }
    out.encode = { threw, stuck: !!ed._selEncoding };
    ed.getValue();
    for (let i = 0; i < 100 && !ed.selectionDataUrl; i++) await wait(50);
    out.encode.laterSaved = !!ed.selectionDataUrl;
    if (threw || out.encode.stuck || !out.encode.laterSaved) fails.push("a selection encode without its canvas: " + JSON.stringify(out.encode));
}
await run("close_document", { doc: d.id, force: true });
host.shell.activate(ednow(window.__t));
if (fails.length) throw new Error(fails.join(" | "));
return out;
"""


async def final_step(c):
    return await c.eval(PRE % FINAL_STEP, timeout=300)


async def undrawn_step(c):
    return await c.eval(PRE % UNDRAWN_STEP, timeout=180)


async def selection_step(c):
    return await c.eval(PRE % SELECTION_STEP, timeout=180)


async def screen_step(c):
    for _ in range(3):
        await c.call("HeapProfiler.collectGarbage")
        await asyncio.sleep(0.3)
    out = await c.eval(PRE % SCREEN_STEP, timeout=240)
    if out.get("tiles"):
        # (5): the pixels three flips and a direct replacement left behind are collected while the document is
        # still open and before its pages could age out, so the only thing that could hold them is the atlas
        for _ in range(4):
            await c.call("HeapProfiler.collectGarbage")
            await asyncio.sleep(0.3)
        held = await c.eval("(() => { const h = window.__atlasHeld; window.__atlasHeld = null; return h ? { flipped: h.flipped.map((w) => !!w.deref()), stepHeld: h.stepHeld, replaced: !!h.replaced.deref() } : null; })()")
        if held is None or not held["flipped"] or any(held["flipped"]) or held["replaced"]:
            raise Exception("pixels the document replaced are still alive after a collection: %s" % json.dumps(held))
    res = await c.eval(PRE % SCREEN_STEP_TAIL, timeout=240)
    if out.get("tiles"):
        res["atlasHeld"] = held
    return res


ARENA_ALLOC = """
const A = await import("./editor/inpaint_arena.js");
const T = await import("./editor/inpaint_tiles.js");
if (!A.arenaEnabled()) return { enabled: false };
const before = A.arenaStats();
// 600 tiles: more than two chunks of 256 slots, so a chunk of their own is filled and has to be dropped again
let p = T.TileLayerPixels.empty(256 * 30, 256 * 20);
for (let ty = 0; ty < 20; ty++) for (let tx = 0; tx < 30; tx++) p.writable(tx, ty).data[3] = 255;
const mid = A.arenaStats();
p = null;
window.__arenaBefore = before;
return { enabled: true, before, mid };
"""

ARENA_AFTER = """
const A = await import("./editor/inpaint_arena.js");
const before = window.__arenaBefore; window.__arenaBefore = null;
return { before, after: A.arenaStats() };
"""


async def arena_step(c):
    """E1: a tile's arena slot goes back when the tile is collected, and a chunk nobody uses is dropped."""
    out = await c.eval(PRE % ARENA_ALLOC, timeout=60)
    if not out.get("enabled"):
        return {"arena": False}
    if out["mid"]["slots"] - out["before"]["slots"] != 600:
        raise Exception("600 tiles took %d arena slots" % (out["mid"]["slots"] - out["before"]["slots"]))
    res = None
    for _ in range(12):
        await c.call("HeapProfiler.collectGarbage")
        await asyncio.sleep(0.3)
        res = await c.eval("(async () => { const A = await import('./editor/inpaint_arena.js'); return A.arenaStats(); })()")
        if res["slots"] <= out["before"]["slots"]:
            break
    await c.eval("(() => { window.__arenaBefore = null; })()")
    left = res["slots"] - out["before"]["slots"]
    if left > 0:
        raise Exception("%d arena slots were not given back after their tiles were collected" % left)
    # the arena keeps its last chunk (the next tile would allocate it again): on a fresh canvas-backend instance, where
    # no tile existed before this step, one chunk stays
    if res["chunks"] > max(1, out["before"]["chunks"]):
        raise Exception("the chunks the tiles filled were kept: %d before, %d after" % (out["before"]["chunks"], res["chunks"]))
    return {"arena": True, "slots": [out["before"]["slots"], out["mid"]["slots"], res["slots"]], "chunks": [out["before"]["chunks"], out["mid"]["chunks"], res["chunks"]], "dropped": res["droppedChunks"] - out["before"]["droppedChunks"]}


def image_fixtures():
    """Files the browser decodes with colour management, EXIF orientation, alpha or 16 bits (Pillow), in a temp folder."""
    import struct
    import tempfile
    import zlib
    from PIL import Image
    d = tempfile.mkdtemp(prefix="scumble_open_")
    w, h = 1500, 1100
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            v = ((x * 7 + y * 13) ^ (x * y)) & 255
            col = ((x * 255) // w, (y * 255) // h, v)
            px[x, y] = col; px[min(w - 1, x + 1), y] = col; px[x, min(h - 1, y + 1)] = col; px[min(w - 1, x + 1), min(h - 1, y + 1)] = col
    icc = None
    for name in ("AdobeRGB1998.icc", "ProPhoto.icm"):
        p = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "System32", "spool", "drivers", "color", name)
        if os.path.exists(p):
            icc = open(p, "rb").read()
            break
    ex = Image.Exif()
    ex[0x0112] = 6
    files = {"plain.jpg": None, "rot6.jpg": None, "alpha.webp": None, "deep.png": None}
    im.save(os.path.join(d, "plain.jpg"), quality=90)
    im.save(os.path.join(d, "rot6.jpg"), quality=90, exif=ex.tobytes())
    if icc:
        im.save(os.path.join(d, "profiled.jpg"), quality=90, icc_profile=icc)
        im.save(os.path.join(d, "profiled.png"), icc_profile=icc)
        files["profiled.jpg"] = files["profiled.png"] = None
    a = Image.new("L", (w, h))
    ap = a.load()
    for y in range(h):
        for x in range(w):
            ap[x, y] = max(0, min(255, 300 - (abs(x - w // 2) + abs(y - h // 2)) // 3))
    rgba = im.copy()
    rgba.putalpha(a)
    rgba.save(os.path.join(d, "alpha.webp"), quality=80)
    # a 16-bit RGBA PNG, written by hand (Pillow writes no 16-bit colour)
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            r, g, b = px[x, y]
            raw += struct.pack(">HHHH", r * 257 + (x & 255), g * 257, b * 257 + (y & 255), 65535 if (x // 50 + y // 50) % 3 else 30000)
    def chunk(t, body):
        return struct.pack(">I", len(body)) + t + body + struct.pack(">I", zlib.crc32(t + body) & 0xFFFFFFFF)
    with open(os.path.join(d, "deep.png"), "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 16, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(raw), 1)) + chunk(b"IEND", b""))
    return d, sorted(files)


LARGE_IMAGES = r"""
// docs/BUGS.md "opening a large JPEG, WebP or a PNG with a colour profile": on tiles such a file of
// `InpaintEditor.imageWorkerFrom` pixels and more is decoded in a pool worker (`image_read`) and read back band by band,
// never through an <img> and a dozen reads in the window. The same pixels as the <img> way, for the base, an image layer
// and a restore; a profiled file really is colour managed (its bytes differ from a decode that drops the profile).
if (!ednow(window.__t).tileMode) return { skipped: "the worker decodes into tiles" };
const ed = ednow(window.__t);
host.shell.activate(ed);
const E = ed.constructor;
const DIR = __DIR__, NAMES = __NAMES__;
const hex = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", u8))).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
const whole = (px) => px.readRect(0, 0, px.width, px.height).data;
const fileOf = async (name) => {
    const r = await window.scumble.file.read(DIR + "/" + name);
    const type = /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.webp$/i.test(name) ? "image/webp" : "image/png";
    return new File([r.data], name, { type });
};
const pool = E.parts.pool(), oRun = pool.run.bind(pool);
const ops = [], failed = [];
// a job that fails falls back to the <img> (the same bytes): count the answers, not the calls
pool.run = (op, ...a) => { const p = oRun(op, ...a); ops.push(op); if (op === "image_read") p.catch((err) => failed.push(String((err && err.message) || err))); return p; };
const was = E.imageWorkerFrom, wasPng = E.pngStreamFrom;
const out = {};
try {
    for (const name of NAMES) {
        const file = await fileOf(name);
        const route = await E.parts.imageRoute(file);
        if (!route || !(route.width * route.height >= 1000000)) throw new Error(name + ": no size from the header: " + JSON.stringify(route));
        E.imageWorkerFrom = 1000000;
        ops.length = 0;
        await ed.loadFile(file);
        const read = ops.filter((o) => o === "image_read").length;
        if (read !== 1 || failed.length) throw new Error(name + ": " + read + " image_read jobs (" + ops.join(",") + "), failed: " + failed.join("; ") + ", " + ed.status);
        const size = [ed.width, ed.height];
        const worker = await hex(whole(ed.basePx));
        E.imageWorkerFrom = 0;
        ops.length = 0;
        await ed.loadFile(await fileOf(name));
        if (ops.includes("image_read")) throw new Error(name + ": with the threshold off the file still went to the worker");
        if (ed.width !== size[0] || ed.height !== size[1]) throw new Error(name + ": " + size + " in the worker, " + [ed.width, ed.height] + " through the image");
        const image = await hex(whole(ed.basePx));
        if (worker !== image) throw new Error(name + ": the worker and the image give different pixels");
        out[name] = { size, same: true };
    }
    if (out["rot6.jpg"] && !(out["rot6.jpg"].size[0] === 1100 && out["rot6.jpg"].size[1] === 1500)) throw new Error("the EXIF orientation was not applied: " + out["rot6.jpg"].size);
    // colour management is exercised: the profile moves the pixels against a decode that drops it
    if (NAMES.includes("profiled.jpg")) {
        const f = await fileOf("profiled.jpg");
        const bmp = await createImageBitmap(f, { colorSpaceConversion: "none" });
        const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext("2d", { willReadFrequently: true });
        x.drawImage(bmp, 0, 0); bmp.close();
        E.imageWorkerFrom = 1000000;
        await ed.loadFile(f);
        if ((await hex(x.getImageData(0, 0, c.width, c.height).data)) === (await hex(whole(ed.basePx)))) throw new Error("the profiled JPEG decodes to the same bytes with its profile dropped: not colour managed");
        out.profiled = "managed";
    }
    // an image layer and a restore take the same way, with the same pixels
    E.imageWorkerFrom = 1000000;
    const name = NAMES.includes("profiled.jpg") ? "profiled.jpg" : "plain.jpg";
    await ed.loadFile(await fileOf(name));
    const base = await hex(whole(ed.basePx));
    ops.length = 0;
    await ed.addImageLayers([await fileOf(name)], "none", { place: "at", at: [0, 0] });
    const layer = ed.layers[ed.layers.length - 1];
    if (!layer || ops.filter((o) => o === "image_read").length !== 1 || failed.length) throw new Error("the image layer was not decoded in the worker: " + ops.join(",") + " " + failed.join("; "));
    if ((await hex(whole(layer.px))) !== base) throw new Error("the image layer's pixels differ from the base's of the same file");
    ed.syncLayers && (await ed.syncLayers());
    const value = ed.getValue();
    const d2 = await run("new_document");
    const ed2 = ednow(d2.id);
    ops.length = 0;
    try {
        await ed2.setValue(value);
        if (ed2.width !== ed.width || ops.filter((o) => o === "image_read").length < 2 || failed.length) throw new Error("the restore did not decode base and layer in the worker: " + ops.join(","));
        if ((await hex(whole(ed2.basePx))) !== base) throw new Error("the restored base differs");
        const l2 = ed2.layers.find((l) => l.kind === "image");
        if (!l2 || (await hex(whole(l2.px))) !== base) throw new Error("the restored image layer differs");
    } finally { await run("close_document", { doc: d2.id, force: true }); }
    out.layerAndRestore = true;
} finally { pool.run = oRun; E.imageWorkerFrom = was; E.pngStreamFrom = wasPng; }
ed.clearUndo();
await run("new_canvas", { width: 600, height: 300, doc: window.__t });
return out;
"""


async def large_images_step(c):
    d, names = image_fixtures()
    try:
        body = LARGE_IMAGES.replace("__DIR__", json.dumps(d.replace("\\", "/"))).replace("__NAMES__", json.dumps(names))
        return await c.eval(PRE % body, timeout=300)
    finally:
        import shutil
        shutil.rmtree(d, ignore_errors=True)


async def backend_step(c):
    exp = expected_tiles()
    return await c.eval(PRE % BACKEND_STEP.replace("__EXPECT__", "null" if exp is None else ("true" if exp else "false")), timeout=180)


TILE_ROW_READ = """
const shell = await import("./shell.js");
const box = document.getElementById("set-tiles"), note = document.getElementById("set-tiles-note"), restart = document.getElementById("set-tiles-restart");
if (__OPEN__) {
    for (const d of document.querySelectorAll("dialog[open]")) d.close();
    await shell.openSettings();
    await wait(200);
}
if (!box || !note || !restart || !document.querySelector("#shell-settings[open]")) throw new Error("the settings dialog or its Tile engine row is missing");
if (__CLICK__) {
    const want = !box.checked;
    box.click();
    for (let i = 0; i < 50 && ((await window.scumble.settings.get()).tiles !== want || box.checked !== want); i++) await wait(40);
    await wait(150);   // the note is written after the setting
}
const st = await run("status", { doc: window.__t });
return { checked: box.checked, note: note.textContent, restartHidden: restart.hidden, mode: await window.scumble.tileMode(),
    status: st.pixels, pixels: { tiles: window.scumble.pixels.tiles, from: window.scumble.pixels.tilesFrom },
    userData: (await window.scumble.info()).userData, relaunch: typeof window.scumble.relaunch };
"""


async def tile_engine_row_writes_the_setting_and_names_its_source(c):
    """C7, the default (docs/PLAN_BCE.md §C7): the tile engine is on unless something chose otherwise, in the
    packaged app too. The precedence (electron/main/tilemode.js) is checked in plain Node for every source
    (tools/tilemode_test.js). Then Settings › Rendering › Tile engine: opening the dialog writes nothing into
    settings.json; the box shows the stored boolean or the default; the note names what decided this window's
    backend, as the status command and the preload do; a click writes the boolean, and while the command line
    or SCUMBLE_TILES decides, the next start stays theirs and the note says so, otherwise the next start takes
    the setting and "Restart now" appears when it differs from this window. The setting is put back as it was
    (no key when there was none). Restart itself is not clicked: it would end the gate's instance."""
    here = os.path.dirname(os.path.abspath(__file__))
    r = subprocess.run(["node", os.path.join(here, "tilemode_test.js")], capture_output=True, text=True, timeout=60)
    if r.returncode != 0 or not r.stdout.strip().endswith("PASS"):
        raise Exception("the precedence in plain Node: " + (r.stdout + r.stderr)[-900:])
    # what Restart now starts: a window again (no --mcp / --headless / --cmd), the installer while an update waits
    rr = subprocess.run(["node", os.path.join(here, "restart_test.js")], capture_output=True, text=True, timeout=60)
    if rr.returncode != 0 or not rr.stdout.strip().endswith("PASS"):
        raise Exception("the restart plan in plain Node: " + (rr.stdout + rr.stderr)[-900:])
    def read(opn, click):
        js = TILE_ROW_READ.replace("__OPEN__", "true" if opn else "false").replace("__CLICK__", "true" if click else "false")
        return c.eval(PRE % js, timeout=60)

    path = os.path.join(await c.eval("(async () => (await window.scumble.info()).userData)()"), "settings.json")

    def stored():
        """(whether settings.json has a `tiles` key, its value)"""
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
        except FileNotFoundError:
            return (False, None)
        return ("tiles" in d, d.get("tiles"))

    # before the dialog: what the file holds (the gate's fresh profile holds no `tiles`)
    before = stored()
    opened = await read(True, False)
    out = {"file_before": before, "opened": {k: opened[k] for k in ("checked", "note", "restartHidden", "status", "pixels")}, "mode": opened["mode"]}
    if stored() != before:
        raise Exception("opening the settings dialog wrote the tile setting: %s -> %s" % (before, stored()))
    m = opened["mode"]
    w, nxt = m["window"], m["next"]
    if not w or w["on"] != opened["pixels"]["tiles"] or w["from"] != opened["pixels"]["from"] or opened["status"] != {"tiles": w["on"], "from": w["from"]}:
        raise Exception("this window's backend is said differently by main, the preload and the status command: %s" % json.dumps(out))
    if opened["relaunch"] != "function":
        raise Exception("no relaunch in the preload")
    forced = w["from"] in ("command line", "SCUMBLE_TILES")
    env = os.environ.get("SCUMBLE_TILES")
    if not forced and env is None:
        want_w = {"on": before[1], "from": "settings"} if before[0] and isinstance(before[1], bool) else {"on": True, "from": "default"}
        if w != want_w:
            raise Exception("this window's backend is %s, settings.json %s gives %s" % (json.dumps(w), before, json.dumps(want_w)))
    want_box = before[1] if before[0] and isinstance(before[1], bool) else m["defaultOn"]
    if opened["checked"] != want_box or m["defaultOn"] is not True:
        raise Exception("the box shows %s, the setting and the default say %s (default %s)" % (opened["checked"], want_box, m["defaultOn"]))
    words = {"command line": "on the command line", "SCUMBLE_TILES": "SCUMBLE_TILES=", "settings": "set by this box", "default": "the default"}[w["from"]]
    if words not in opened["note"] or ("tile engine " + ("on" if w["on"] else "off")) not in opened["note"]:
        raise Exception("the note does not name this window's backend and its source (%s): %s" % (words, opened["note"]))
    clicks = []
    try:
        for i in range(2):
            got = await read(False, True)
            has, val = stored()
            row = {"checked": got["checked"], "file": [has, val], "next": got["mode"]["next"], "restartHidden": got["restartHidden"], "note": got["note"]}
            clicks.append(row)
            if not has or val is not got["checked"]:
                raise Exception("click %d: the box is %s but settings.json holds %s" % (i + 1, got["checked"], [has, val]))
            if got["mode"]["setting"] is not got["checked"]:
                raise Exception("click %d: main reads the setting as %s" % (i + 1, got["mode"]["setting"]))
            n = got["mode"]["next"]
            if forced:
                if n["from"] != w["from"] or n["on"] != w["on"] or not got["restartHidden"] or "wins over this box" not in got["note"]:
                    raise Exception("click %d: the command line or the environment no longer wins, or the note does not say so: %s" % (i + 1, json.dumps(row)))
            else:
                if n["from"] != "settings" or n["on"] != got["checked"]:
                    raise Exception("click %d: the next start does not take the setting: %s" % (i + 1, json.dumps(row)))
                if got["restartHidden"] != (n["on"] == w["on"]):
                    raise Exception("click %d: Restart now is %s while the next start is %s and this window %s" % (i + 1, "hidden" if got["restartHidden"] else "shown", n["on"], w["on"]))
                if n["on"] != w["on"] and "After a restart" not in got["note"]:
                    raise Exception("click %d: the note does not say what the restart changes: %s" % (i + 1, got["note"]))
    finally:
        # put the setting back as it was: no key when there was none (undefined is dropped by JSON)
        restore = json.dumps(before[1]) if before[0] else "undefined"
        await c.eval("(async () => { await window.scumble.settings.set({ tiles: %s }); const d = document.querySelector('#shell-settings[open]'); if (d) d.close(); return 1; })()" % restore)
    out["clicks"] = clicks
    out["file_after"] = stored()
    if out["file_after"] != before:
        raise Exception("the tile setting was not put back: %s -> %s" % (before, out["file_after"]))
    back = await c.eval("(async () => (await window.scumble.tileMode()).next)()")
    if (forced and back != w) or (not forced and not before[0] and back != {"on": True, "from": "default"}):
        raise Exception("after the restore the next start is %s (this window %s)" % (json.dumps(back), json.dumps(w)))
    out["node"] = [r.stdout.strip().splitlines()[-1], rr.stdout.strip().splitlines()[-1]]
    return out


RESTART_SAVE_STEP = """
// Settings › Rendering › Restart now saves before it quits (renderer/shell.js saveBeforeRestart). The autosave bundle
// names each layer's uploaded file, and a layer is uploaded 15 s after its last change: saving the bundle alone kept
// the file from before (a new layer had none and came back empty), and a picture above SYNC_ENCODE_PX saved the
// selection from before its background encode landed. The button itself is not clicked (it would end the instance):
// what it saves is read back from autosave.json.
const shell = await import("./shell.js");
const { api } = await import("./editor/host.js");
const fails = [], out = {};
const doc = await run("new_document");
const ed = ednow(doc.id);
host.shell.activate(ed);
const saved = async () => {
    const b = JSON.parse((await window.scumble.state.load()) || "{}");
    const d = (b.docs || []).find((x) => x.id === doc.id);
    return d ? JSON.parse(d.state || "{}") : null;
};
const pixelOf = async (url, x, y) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("could not load " + url.slice(0, 80))); img.src = url; });
    const cv = document.createElement("canvas"); cv.width = 1; cv.height = 1;
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, x, y, 1, 1, 0, 0, 1, 1);
    return Array.from(g.getImageData(0, 0, 1, 1).data);
};
try {
    // (1) a paint layer filled a moment ago, never uploaded
    await run("new_canvas", { width: 640, height: 480, doc: doc.id });
    await run("add_paint_layer", { doc: doc.id });
    await run("select_rect", { x: 20, y: 20, w: 200, h: 100, doc: doc.id });
    const L = ed.layers.find((l) => l.kind === "paint");
    ed.fillSelection();
    await wait(100);
    out.before = { dirty: !!L.dirty, ref: L.ref || null };
    if (!L.dirty || L.ref) fails.push("the layer is not an unsaved edit before the save: " + JSON.stringify(out.before));
    await shell.saveBeforeRestart();
    const s1 = await saved();
    const sl = s1 && (s1.layers || []).find((l) => l.id === L.id);
    out.layer = sl ? { ref: sl.ref, x: sl.x, y: sl.y } : null;
    if (!sl || !sl.ref) fails.push("the saved document has no file for the layer painted just before the restart: " + JSON.stringify(out.layer));
    else {
        const px = await pixelOf(api.apiURL("/view?" + new URLSearchParams({ filename: sl.ref.filename, subfolder: sl.ref.subfolder || "", type: sl.ref.type || "input" })), 100 - (sl.x || 0), 60 - (sl.y || 0));
        out.layer.pixel = px;
        if (!(px[3] > 0)) fails.push("the saved layer file does not hold the fill: " + JSON.stringify(out.layer));
    }
    // (2) a selection changed a moment ago on a picture above SYNC_ENCODE_PX (5000 x 4000)
    await run("new_canvas", { width: 5000, height: 4000, doc: doc.id });
    await run("select_rect", { x: 0, y: 0, w: 100, h: 100, doc: doc.id });
    ed.getValue();
    for (let i = 0; i < 200 && (ed._selEncoding || !ed.selectionEncoded); i++) await wait(50);
    await run("select_rect", { x: 2000, y: 2000, w: 300, h: 300, doc: doc.id });
    out.selBefore = { encoded: !!ed.selectionEncoded, encoding: !!ed._selEncoding };
    await shell.saveBeforeRestart();
    const s2 = await saved();
    if (!s2 || !s2.selection) fails.push("the saved document has no selection");
    else {
        // E5: on tiles the PNG holds the box the selection covers, and `selectionBox` says where it goes
        const sb = s2.selectionBox || [0, 0, 5000, 4000];
        const at = async (x, y) => (x >= sb[0] && y >= sb[1] && x < sb[0] + sb[2] && y < sb[1] + sb[3] ? pixelOf(s2.selection, x - sb[0], y - sb[1]) : [0, 0, 0, 0]);
        out.sel = { inNew: await at(2100, 2100), inOld: await at(50, 50), box: s2.selectionBox || null };
        if (!(out.sel.inNew[3] > 0) || out.sel.inOld[3] > 0) fails.push("the saved selection is not the one made just before the restart: " + JSON.stringify(out.sel));
    }
} finally {
    await run("close_document", { doc: doc.id, force: true });
    host.shell.activate(ednow(window.__t));
}
if (fails.length) throw new Error(fails.join(" | "));
return out;
"""


async def restart_save_step(c):
    return await c.eval(PRE % RESTART_SAVE_STEP, timeout=180)


async def edit_step(c):
    return await c.eval(PRE % EDIT_STEP, timeout=180)


# The Undo history (docs/PLAN_0_1_31.md section 2, step 6; the normal tier). The steps share a document of their own,
# `window.__uh` (600 x 300), which the first opens and the last closes, and its paint layer `window.__uhLayer`. The
# three edits of the first step are a rectangle selected, the selection filled red on the paint layer and that layer
# flipped horizontally; each leaves a state of its own at the probes A (140, 120) and B, A's mirror (459, 120).
UNDO_HISTORY_OPEN = """
{
    const d = await run("new_document");
    window.__uh = d.id;
    try { window.__uhOpen = localStorage.getItem("ipc.undoOpen"); } catch (_) { window.__uhOpen = null; }
}
"""

UNDO_HISTORY_PRE = """
const doc = window.__uh;
const ed = ednow(doc);
if (!ed) throw new Error("the undo history document is gone (undo_history_lists_three_edits_as_labelled_rows opens it)");
host.shell.activate(ed);
if (!ed.undoSection || typeof ed.undoList !== "function" || typeof ed.renderUndoList !== "function") throw new Error("the editor has no Undo history section");
// the rows are rendered only while the section is open (renderUndoList returns early otherwise)
if (!ed.undoSection.open) { ed.undoSection.open = true; await wait(60); ed.renderUndoList(); }
const until = async (what, cond, ms = 10000) => {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + what + " (undo " + ed.undo.length + ", redo " + ed.redo.length + "; " + ed.status + ")");
        await wait(25);
    }
};
const settle = () => wait(60);   // the list re-renders on a microtask after a change; waits are setTimeout, never rAF
const rowEls = () => Array.from(ed.undoSection.querySelectorAll(".ipc-undo-list .ipc-undo-row"));
const panel = () => rowEls().map((r) => ({ text: r.textContent, steps: +r.dataset.steps, current: r.classList.contains("ipc-undo-current"), future: r.classList.contains("ipc-undo-future") }));
// the panel's rows are undoList(): the same count, order, labels, steps and marks
const samePanel = (what) => {
    const want = ed.undoList(), got = panel();
    const bad = got.length !== want.length || want.some((w, i) => !got[i].text.includes(w.label) || got[i].steps !== w.steps || got[i].current !== !!w.current || got[i].future !== !!w.future);
    if (bad) throw new Error(what + ": the panel shows " + JSON.stringify(got) + ", undoList() " + JSON.stringify(want));
    return got.length;
};
const clickRow = (steps) => {
    const r = rowEls().find((e) => e.dataset.steps === String(steps));
    if (!r) throw new Error("no row with data-steps " + steps + ": " + JSON.stringify(panel()));
    r.click();   // the element's own handler: ed.stepHistory(steps)
};
const bounds = () => { const b = ed.getBounds(); return b ? [b[0], b[1], b[2], b[3]] : null; };
const layerPx = (x, y) => {
    const l = ed.layers.find((q) => q.id === window.__uhLayer);   // looked up each time: a flip or a restore gives it new pixels
    if (!l) throw new Error("the paint layer is gone: " + ed.layers.map((q) => q.id + " " + q.name).join(", "));
    return Array.from(l.px.readRect(x, y, 1, 1).data);
};
const isRed = (p) => p[3] > 200 && p[0] > 200 && p[1] < 60 && p[2] < 60;
const isClear = (p) => p[3] < 8;
const RECT = [40, 60, 240, 180];
const AT = {
    start: { a: "clear", b: "clear", sel: null },   // the paint layer empty, nothing selected
    rect: { a: "clear", b: "clear", sel: RECT },    // edit 1: the selection
    fill: { a: "red", b: "clear", sel: RECT },      // edit 2: filled red
    flip: { a: "clear", b: "red", sel: RECT },      // edit 3: the layer flipped, the red at the mirror
};
const expectState = (what, want) => {
    const s = { a: layerPx(140, 120), b: layerPx(459, 120), sel: bounds() };
    const ok = (want.a === "red" ? isRed(s.a) : isClear(s.a)) && (want.b === "red" ? isRed(s.b) : isClear(s.b)) && JSON.stringify(s.sel) === JSON.stringify(want.sel);
    if (!ok) throw new Error(what + ": want " + JSON.stringify(want) + ", the document holds " + JSON.stringify(s));
    return s;
};
const answerAsk = async (label) => {
    await until("the question", () => ed.root.querySelector(".ipc-askbox"));
    const b = Array.from(ed.root.querySelectorAll(".ipc-askbox button")).find((x) => x.textContent === label);
    if (!b) throw new Error("the question has no " + label + " button: " + ed.root.querySelector(".ipc-askbox").textContent);
    b.click();
    await until("the question to close", () => !ed.root.querySelector(".ipc-askbox"));
};
"""

UNDO_HISTORY_ROWS = UNDO_HISTORY_OPEN + UNDO_HISTORY_PRE + """
await run("new_canvas", { width: 600, height: 300, doc });
await settle();
const fresh = ed.undoList();
if (fresh.length !== 1 || fresh[0].label !== "Start" || !fresh[0].current || fresh[0].future || fresh[0].steps !== 0) throw new Error("a fresh canvas lists " + JSON.stringify(fresh));
samePanel("a fresh canvas");
if (ed.undoSection.tagName !== "DETAILS" || ed.undoSection.parentElement !== ed.panes.image) throw new Error("the Undo history is not a section of the Image tab");
const sum = ed.undoSection.querySelector(":scope > summary");
if (!sum || !sum.textContent.trim().startsWith("Undo history")) throw new Error("the section's title reads " + (sum && sum.textContent));
const P = await run("add_paint_layer", { name: "History paint", doc });
window.__uhLayer = P.id;
const addPushed = ed.undo.length;   // no undo step today; the history starts after the layer either way
ed.clearUndo();
await settle();
if (ed.undoList().length !== 1 || ed.undoList()[0].label !== "Start") throw new Error("a cleared history lists " + JSON.stringify(ed.undoList()));
ed.activeLayerId = P.id;
ed.color = "#ff0000"; ed.brushOpacity = 1;
await run("select_rect", { x: 40, y: 60, w: 200, h: 120, doc });
ed.fillSelection();
ed.flipLayer("h");
await settle();
const rows = ed.undoList();
if (rows.length !== 4) throw new Error("three edits list " + rows.length + " rows: " + JSON.stringify(rows));
if (rows[0].label !== "Start") throw new Error("the first row is " + JSON.stringify(rows[0]));
rows.forEach((r, i) => { if (r.steps !== i - 3 || r.current !== (i === 3) || r.future) throw new Error("row " + i + " is " + JSON.stringify(r) + ": " + JSON.stringify(rows)); });
const labels = rows.slice(1).map((r) => r.label);
if (labels.some((l) => typeof l !== "string" || !l.trim())) throw new Error("an edit without a label: " + JSON.stringify(labels));
if (new Set(labels).size !== 3) throw new Error("a selection, a fill and a flip share a label: " + JSON.stringify(labels));
if (rows.slice(1).some((r) => !(r.at > 0))) throw new Error("an edit row has no time: " + JSON.stringify(rows));
samePanel("three edits");
const els = rowEls();
if (!els[3].classList.contains("ipc-undo-current") || els.slice(0, 3).some((e) => e.classList.contains("ipc-undo-current") || e.classList.contains("ipc-undo-future"))) throw new Error("the present is not the last row: " + JSON.stringify(panel()));
expectState("after the three edits", AT.flip);
// Clear asks first; Cancel keeps every step
ed.undoSection.querySelector(".ipc-undo-clear").click();
await answerAsk("Cancel");
if (ed.undo.length !== 3 || ed.redo.length) throw new Error("Cancel on Clear changed the history: " + ed.undo.length + " / " + ed.redo.length);
return { labels, addPushed, tiles: ed.tileMode };
"""

UNDO_HISTORY_JUMPS = UNDO_HISTORY_PRE + """
if (ed.undo.length !== 3 || ed.redo.length) throw new Error("not at the present of the three edits: " + ed.undo.length + " / " + ed.redo.length);
const labels = ed.undoList().map((r) => r.label);
const sameLabels = (what) => { const now = ed.undoList().map((r) => r.label); if (JSON.stringify(now) !== JSON.stringify(labels)) throw new Error(what + ": the list reads " + JSON.stringify(now) + ", before " + JSON.stringify(labels)); };
// a real click on the row of edit 1: two steps back
const row1 = rowEls()[1];
if (!row1 || row1.dataset.steps !== "-2") throw new Error("the second row is not two steps back: " + JSON.stringify(panel()));
row1.click();
await until("two undo steps", () => ed.undo.length === 1 && ed.redo.length === 2);
await settle();
expectState("after a click on the row of edit 1", AT.rect);
sameLabels("after the jump back");   // an undone step keeps its label as a redo row
samePanel("after the jump back");
if (!rowEls()[1].classList.contains("ipc-undo-current")) throw new Error("the row of edit 1 is not the present: " + JSON.stringify(panel()));
const future = rowEls().filter((e) => e.classList.contains("ipc-undo-future"));
if (future.length !== 2 || future.map((e) => e.dataset.steps).join() !== "1,2") throw new Error("the redo rows: " + JSON.stringify(panel()));
// the last redo row: the present again
future[1].click();
await until("two redo steps", () => ed.undo.length === 3 && ed.redo.length === 0);
await settle();
expectState("after a click on the last redo row", AT.flip);
sameLabels("back at the present");
samePanel("back at the present");
// one step: the row of edit 2, then forward with stepHistory
clickRow(-1);
await until("one undo step", () => ed.undo.length === 2 && ed.redo.length === 1);
await settle();
expectState("after a click on the row of edit 2", AT.fill);
samePanel("one step back");
const one = await ed.stepHistory(1);
if (one !== 1) throw new Error("stepHistory(1) took " + one + " steps");
expectState("after stepHistory(1)", AT.flip);
// the first row: the start, everything undone; more steps than there are take what there is
clickRow(-3);
await until("three undo steps", () => ed.undo.length === 0 && ed.redo.length === 3);
await settle();
expectState("after a click on the first row", AT.start);
samePanel("at the start");
const all = await ed.stepHistory(5);
if (all !== 3) throw new Error("stepHistory(5) with three redo steps took " + all);
await settle();
expectState("after stepHistory(5)", AT.flip);
// the present's own row does nothing
const cur = rowEls().find((e) => e.classList.contains("ipc-undo-current"));
if (!cur || cur.dataset.steps !== "0") throw new Error("the present's row: " + JSON.stringify(panel()));
cur.click();
await wait(150);
if (ed.undo.length !== 3 || ed.redo.length) throw new Error("a click on the present moved the history: " + ed.undo.length + " / " + ed.redo.length);
sameLabels("after the round trip");
return { labels };
"""

UNDO_HISTORY_SNAPSHOTS = UNDO_HISTORY_PRE + """
if (ed.undo.length !== 3 || ed.redo.length) throw new Error("not at the present of the three edits: " + ed.undo.length + " / " + ed.redo.length);
const snapBtn = ed.undoSection.querySelector(".ipc-undo-snap");
if (!snapBtn) throw new Error("no Snapshot button in the Undo history");
if (!ed.tileMode) {
    // the canvas backend cannot clone for free: the button is off and a snapshot is refused
    if (!snapBtn.disabled) throw new Error("the Snapshot button is enabled on the canvas backend");
    const none = ed.takeSnapshot("A");
    if (none !== null || ed.snapshots.length) throw new Error("takeSnapshot answered on the canvas backend: " + JSON.stringify(none && none.name));
    return { skipped: "snapshots need the tile backend", buttonDisabled: true };
}
if (snapBtn.disabled) throw new Error("the Snapshot button is disabled on tiles");
const n0 = ed.undo.length;
const taken = ed.takeSnapshot("A");
if (!taken || taken.name !== "A" || !(taken.at > 0) || ed.snapshots.length !== 1) throw new Error("takeSnapshot('A'): " + JSON.stringify(taken && { name: taken.name, at: taken.at }) + ", " + ed.snapshots.length + " kept");
if (ed.undo.length !== n0) throw new Error("taking a snapshot pushed an undo step");
await settle();
const row = () => ed.undoSection.querySelector('.ipc-snap-row[data-name="A"]');
if (!row() || !row().querySelector(".ipc-snap-restore") || !row().querySelector(".ipc-snap-delete")) throw new Error("no row for the snapshot A with its buttons");
// two edits after it: the layer flipped back and the selection dropped
ed.flipLayer("h");
await run("select_none", { doc });
const edited = { a: "red", b: "clear", sel: null };
expectState("after the edits past the snapshot", edited);
const n1 = ed.undo.length;
if (!ed.restoreSnapshot("A")) throw new Error("restoreSnapshot('A') refused: " + ed.status);
await settle();
expectState("after restoring A", AT.flip);
if (ed.undo.length !== n1 + 1 || ed.redo.length) throw new Error("the restore is not one undo step: " + ed.undo.length + " / " + ed.redo.length + ", " + n1 + " before");
const restoreLabel = ed.undoList()[ed.undoList().length - 1].label;
if (!restoreLabel || !String(restoreLabel).trim()) throw new Error("the restore's row has no label");
samePanel("after the restore");
// Ctrl+Z takes the restore back
await ed.undoStep();
await settle();
expectState("after undoing the restore", edited);
if (ed.undo.length !== n1 || ed.redo.length !== 1) throw new Error("the undo of the restore left " + ed.undo.length + " / " + ed.redo.length);
// the same snapshot a second time, through its row's button
row().querySelector(".ipc-snap-restore").click();
await settle();
expectState("after restoring A a second time", AT.flip);
if (ed.undo.length !== n1 + 1 || ed.redo.length) throw new Error("the second restore is not one undo step: " + ed.undo.length + " / " + ed.redo.length);
if (ed.snapshots.length !== 1) throw new Error("a restore used the snapshot up: " + ed.snapshots.length + " kept");
// its delete button
row().querySelector(".ipc-snap-delete").click();
await settle();
if (ed.snapshots.length || ed.undoSection.querySelector(".ipc-snap-row")) throw new Error("the snapshot is still there after its delete");
if (ed.restoreSnapshot("A")) throw new Error("a deleted snapshot was restored");
expectState("after the delete", AT.flip);
// eight at most: the oldest goes first
for (let i = 1; i <= 9; i++) if (!ed.takeSnapshot("s" + i)) throw new Error("takeSnapshot('s" + i + "') refused");
await settle();
const kept = ed.snapshots.map((s) => s.name);
if (kept.length !== 8 || kept[0] !== "s2" || kept[7] !== "s9") throw new Error("nine snapshots keep " + JSON.stringify(kept));
if (ed.undoSection.querySelectorAll(".ipc-snap-row").length !== 8) throw new Error("the panel lists " + ed.undoSection.querySelectorAll(".ipc-snap-row").length + " snapshots of 8");
// a snapshot holds its clones only, not the layers' live pixels or caches (they would outlive what the document replaced)
if (ed.snapshots.some((s) => s.snap.layers.some((l) => l.px || l.maskPx || l._masked))) throw new Error("a snapshot's layer record keeps live pixels");
// the command refuses at the cap unless it may drop the oldest; the panel's takeSnapshot drops it
const { commands: C } = await import('./commands.js');
const full = await C.call("take_snapshot", { name: "ninth" });
if (full.ok) throw new Error("take_snapshot at the cap did not refuse: " + JSON.stringify(full.result));
const dropped = await C.call("take_snapshot", { name: "ninth", drop_oldest: true });
if (!dropped.ok || ed.snapshots.length !== 8 || ed.snapshots[0].name !== "s3") throw new Error("take_snapshot with drop_oldest: " + JSON.stringify(dropped) + " " + JSON.stringify(ed.snapshots.map((s) => s.name)));
// names are unique: a taken name gets a number, the default skips the taken ones
ed.deleteSnapshot(0);
const dup = ed.takeSnapshot("ninth");
if (!dup || dup.name !== "ninth (2)") throw new Error("a second \\"ninth\\" is named " + (dup && dup.name));
ed.deleteSnapshot(0); ed.deleteSnapshot(0);        // six left
ed.takeSnapshot("Snapshot 8");                     // seven: the default "Snapshot 8" is taken
if (ed.nextSnapshotName() !== "Snapshot 9") throw new Error("the default name after a taken \\"Snapshot 8\\" is " + ed.nextSnapshotName());
while (ed.snapshots.length) if (!ed.deleteSnapshot(0)) throw new Error("deleteSnapshot(0) refused with " + ed.snapshots.length + " left");
if (ed.snapshots.length) throw new Error("eight deletes left " + ed.snapshots.length + " snapshots");
await settle();
if (ed.undoSection.querySelectorAll(".ipc-snap-row").length) throw new Error("the panel still lists snapshots after all were deleted");
return { restoreLabel, undo: ed.undo.length, kept };
"""

UNDO_HISTORY_DEPTH = UNDO_HISTORY_PRE + """
const was = { steps: ed.maxUndo, bytes: ed.maxUndoBytes };
if (!(was.steps > 0) || !(was.bytes > 0)) throw new Error("the editor has no depth: " + JSON.stringify(was));
const out = { was };
try {
    ed.clearUndo();
    ed.setUndoDepth({ steps: 2 });
    if (ed.maxUndo !== 2 || ed.maxUndoBytes !== was.bytes) throw new Error("setUndoDepth({ steps: 2 }) set " + ed.maxUndo + " steps and " + ed.maxUndoBytes + " bytes");
    await run("select_rect", { x: 10, y: 10, w: 50, h: 50, doc });
    await run("select_rect", { x: 20, y: 20, w: 50, h: 50, doc });
    await settle();
    // two edits fit: nothing dropped yet, the first row is still the start
    if (ed.undo.length !== 2 || ed.undoList()[0].label !== "Start") throw new Error("two edits at a depth of 2: " + JSON.stringify(ed.undoList()));
    await run("select_rect", { x: 30, y: 30, w: 50, h: 50, doc });
    await settle();
    const rows = ed.undoList();
    out.rows = rows.map((r) => r.label);
    if (ed.undo.length !== 2) throw new Error("three edits at a depth of 2 keep " + ed.undo.length + " steps");
    if (rows.length !== 3 || rows[0].label !== "Oldest kept" || rows[0].steps !== -2) throw new Error("the first row after a dropped step: " + JSON.stringify(rows));
    samePanel("at a depth of 2");
    // the oldest state kept is the one after the first edit
    await ed.stepHistory(-2);
    if (JSON.stringify(bounds()) !== "[10,10,60,60]") throw new Error("the oldest kept state selects " + JSON.stringify(bounds()));
    await ed.stepHistory(2);
    if (JSON.stringify(bounds()) !== "[30,30,80,80]") throw new Error("back at the present the selection is " + JSON.stringify(bounds()));
    // a smaller depth trims at once
    ed.setUndoDepth({ steps: 1 });
    await settle();
    if (ed.undo.length !== 1 || ed.undoList()[0].label !== "Oldest kept") throw new Error("a depth of 1 keeps " + JSON.stringify(ed.undoList()));
    samePanel("at a depth of 1");
} finally {
    ed.setUndoDepth({ steps: was.steps, bytes: was.bytes });
}
if (ed.maxUndo !== was.steps || ed.maxUndoBytes !== was.bytes) throw new Error("the depth did not go back: " + ed.maxUndo + " steps, " + ed.maxUndoBytes + " bytes");
out.depth = [ed.maxUndo, ed.maxUndoBytes];
return out;
"""

UNDO_HISTORY_COMMANDS = UNDO_HISTORY_PRE + """
const out = {};
try {
    ed.clearUndo();
    await run("select_rect", { x: 20, y: 20, w: 100, h: 80, doc });
    await run("select_rect", { x: 200, y: 100, w: 150, h: 90, doc });
    await run("select_none", { doc });
    // list_history's rows are undoList()'s, its counts the stacks'
    const same = (what, h) => {
        const want = ed.undoList();
        if (!h || !Array.isArray(h.rows) || h.rows.length !== want.length) throw new Error(what + ": list_history rows " + JSON.stringify(h && h.rows) + ", undoList() " + JSON.stringify(want));
        want.forEach((w, i) => {
            const r = h.rows[i];
            if (r.label !== w.label || r.steps !== w.steps || !!r.current !== !!w.current || !!r.future !== !!w.future) throw new Error(what + ": row " + i + " is " + JSON.stringify(r) + ", undoList() has " + JSON.stringify(w));
        });
        if (h.undo !== ed.undo.length || h.redo !== ed.redo.length) throw new Error(what + ": list_history counts " + h.undo + " / " + h.redo + ", the editor " + ed.undo.length + " / " + ed.redo.length);
        return h;
    };
    const h = same("three edits", await run("list_history", { doc }));
    if (h.undo !== 3 || h.redo !== 0) throw new Error("list_history after three edits: " + h.undo + " / " + h.redo);
    if (!Array.isArray(h.snapshots) || h.snapshots.length) throw new Error("list_history snapshots: " + JSON.stringify(h.snapshots));
    if (!h.depth || h.depth.steps !== ed.maxUndo || !(Math.abs(h.depth.mb - ed.maxUndoBytes / 1048576) <= 1)) throw new Error("list_history depth " + JSON.stringify(h.depth) + ", the editor " + ed.maxUndo + " steps, " + ed.maxUndoBytes + " bytes");
    out.rows = h.rows.map((r) => r.label);
    out.depth = h.depth;
    const u = await run("undo", { steps: 2, doc });
    if (!u || u.stepped !== 2 || u.undo !== 1 || u.redo !== 2) throw new Error("undo { steps: 2 }: " + JSON.stringify(u));
    if (JSON.stringify(bounds()) !== "[20,20,120,100]") throw new Error("two steps back the selection is " + JSON.stringify(bounds()));
    same("two steps back", await run("list_history", { doc }));
    const r = await run("redo", { steps: 2, doc });
    if (!r || r.stepped !== 2 || r.undo !== 3 || r.redo !== 0) throw new Error("redo { steps: 2 }: " + JSON.stringify(r));
    if (bounds() !== null) throw new Error("two steps forward the selection is " + JSON.stringify(bounds()));
    // without steps: one
    const u1 = await run("undo", { doc });
    if (!u1 || u1.stepped !== 1 || u1.undo !== 2 || JSON.stringify(bounds()) !== "[200,100,350,190]") throw new Error("undo: " + JSON.stringify(u1) + ", the selection " + JSON.stringify(bounds()));
    const r1 = await run("redo", { doc });
    if (!r1 || r1.stepped !== 1 || r1.redo !== 0 || bounds() !== null) throw new Error("redo: " + JSON.stringify(r1) + ", the selection " + JSON.stringify(bounds()));
    if (ed.tileMode) {
        const named = (list) => Array.isArray(list) && list.some((s) => (s && s.name) === "by command" || s === "by command");
        const t = await run("take_snapshot", { name: "by command", doc });
        if (!t || t.name !== "by command" || !named(t.snapshots)) throw new Error("take_snapshot: " + JSON.stringify(t));
        if (!named((await run("list_history", { doc })).snapshots)) throw new Error("list_history does not list the snapshot");
        const n = ed.undo.length;
        await run("select_rect", { x: 300, y: 50, w: 80, h: 80, doc });
        const rs = await run("restore_snapshot", { name: "by command", doc });
        if (!rs || !rs.restored || rs.undo !== n + 2 || rs.redo !== 0) throw new Error("restore_snapshot: " + JSON.stringify(rs) + " (" + n + " undo steps before the edit after the snapshot)");
        if (bounds() !== null) throw new Error("the restore kept the selection made after the snapshot: " + JSON.stringify(bounds()));
        const miss = await commands.call("restore_snapshot", { name: "no such snapshot", doc });
        if (miss.ok && miss.result && miss.result.restored) throw new Error("restore_snapshot restored a name that was never taken: " + JSON.stringify(miss));
        const del = await run("delete_snapshot", { name: "by command", doc });
        if (!del || !del.deleted || !Array.isArray(del.snapshots) || del.snapshots.length) throw new Error("delete_snapshot: " + JSON.stringify(del));
        if (ed.snapshots.length) throw new Error("delete_snapshot left " + ed.snapshots.length + " snapshots");
        out.snapshot = { restored: rs.restored, deleted: del.deleted, missing: miss.ok ? miss.result : miss.error };
    } else {
        const t = await commands.call("take_snapshot", { name: "by command", doc });
        if (t.ok) throw new Error("take_snapshot answered on the canvas backend: " + JSON.stringify(t.result));
        out.snapshot = t.error;
    }
    // Clear through the panel, answered this time: both stacks empty, the list starts again
    await run("undo", { doc });
    await settle();
    if (!ed.redo.length) throw new Error("no redo step for Clear to drop");
    ed.undoSection.querySelector(".ipc-undo-clear").click();
    await answerAsk("Clear");
    await until("the history to clear", () => !ed.undo.length && !ed.redo.length);
    await settle();
    const left = ed.undoList();
    if (left.length !== 1 || left[0].label !== "Start" || !left[0].current) throw new Error("after Clear the list is " + JSON.stringify(left));
    samePanel("after Clear");
} finally {
    const box = ed.root.querySelector(".ipc-askbox");
    if (box) { const c = Array.from(box.querySelectorAll("button")).find((b) => b.textContent === "Cancel"); if (c) c.click(); }
    for (let i = 0; i < 10 && ed.snapshots && ed.snapshots.length; i++) ed.deleteSnapshot(0);
    try { if (window.__uhOpen == null) localStorage.removeItem("ipc.undoOpen"); else localStorage.setItem("ipc.undoOpen", window.__uhOpen); } catch (_) { /* no storage */ }
    await run("close_document", { doc, force: true });
    host.shell.activate(ednow(window.__t) || host.editor);
}
return out;
"""


STEPS = [
    ("new_dialog_has_two_boxes", """
const doc = await run("new_document");
window.__t = doc.id;
const ed = ednow(window.__t);
host.shell.activate(ed);
const p = ed.newCanvas();                        // not awaited: the dialog is open now
await wait(150);
const box = ed.root.querySelector(".ipc-askbox");
const inputs = Array.from(box.querySelectorAll(".ipc-askfield input"));
const labels = Array.from(box.querySelectorAll(".ipc-askfield span")).map((s) => s.textContent);
const focusedFirst = document.activeElement === inputs[0];
const link = box.querySelector(".ipc-asklink input");
link.checked = true;                             // the ratio tie
inputs[0].value = "2048";
inputs[0].dispatchEvent(new Event("input"));
const tiedHeight = inputs[1].value;
link.checked = false;
inputs[0].value = "1440"; inputs[1].value = "900";
Array.from(box.querySelectorAll("button")).find((b) => b.textContent === "Create").click();
await p;
if (inputs.length !== 2) throw new Error("not two boxes");
if (ed.width !== 1440 || ed.height !== 900) throw new Error("size " + ed.width + "x" + ed.height);
return { labels, focusedFirst, tiedHeight, size: [ed.width, ed.height] };
"""),
    ("every_panel_sits_in_the_tab_it_belongs_to", """
// the dialog is built by inpaint_modal.js, one function per panel, and the Generate tab is filled after the
// side panel switches over (`toGenPane`, the method's `pane = this.panes.gen`). A panel in the wrong tab is
// the way that switch breaks, and nothing else in the gates would show it.
const ed = ednow(window.__t);
const titles = (pane) => Array.from(pane.querySelectorAll(":scope > details > summary")).map((s) => s.textContent);
const image = titles(ed.panes.image), gen = titles(ed.panes.gen);
for (const want of ["Selection", "Canvas", "Export"]) if (!image.includes(want)) throw new Error(want + " is not in the Image tab: " + image.join(", "));
for (const want of ["Prompt", "Generate", "Settings", "History", "Crop"]) if (!gen.includes(want)) throw new Error(want + " is not in the Generate tab: " + gen.join(", "));
if (gen.some((t) => ["Selection", "Canvas", "Export"].includes(t))) throw new Error("an Image panel in the Generate tab: " + gen.join(", "));
if (image.some((t) => ["Prompt", "Generate", "History", "Crop"].includes(t))) throw new Error("a Generate panel in the Image tab: " + image.join(", "));
// the plugins' own sections go through ed.addSection, which names its tab
if (!ed.panes.image.querySelector("h4") || !ed.layerList || !ed.refList) throw new Error("the layer or reference list is missing");
if (!ed.root.querySelector(".ipc-top") || !ed.toolsEl || !ed.viewEl) throw new Error("a part of the dialog is missing");
return { image, gen };
"""),
    ("layer_rows_fit_the_panel_and_names_can_be_renamed", """
// 0.1.22: a layer row was 15 px wider than the panel, the name was squeezed to 0 px (so it could not be
// double-clicked) and the list scrolled sideways (GitHub issue #1). Every row, and the active row of each
// kind, has to fit with the list's own scrollbar showing; renaming is one undo step.
const doc = await run("new_document");
const d = { doc: doc.id };
await run("new_canvas", { width: 640, height: 480, ...d });
for (let i = 0; i < 14; i++) await run("add_paint_layer", d);
await run("add_filter", { type: "grain", ...d });
await run("add_text", { text: "Hello", ...d });
const ed = ednow(doc.id);
host.shell.activate(ed);
await wait(200);
const list = ed.layerList;
const scrollbar = list.offsetWidth - list.clientWidth;
const probe = (label) => {
    ed.renderLayers();
    const right = list.getBoundingClientRect().left + list.clientWidth + 0.5;
    const names = Array.from(list.querySelectorAll(".ipc-layer .ipc-name")).map((n) => n.getBoundingClientRect().width);
    const narrowest = Math.min(...names);
    const sticking = Array.from(list.querySelectorAll(".ipc-layer *"))
        .filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > right)
        .map((e) => (e.className || e.tagName) + "@" + Math.round(e.getBoundingClientRect().right - right));
    if (sticking.length) throw new Error(label + ": past the list's edge: " + sticking.slice(0, 8).join(", "));
    if (list.scrollWidth > list.clientWidth) throw new Error(label + ": the list scrolls sideways, " + list.scrollWidth + " > " + list.clientWidth);
    if (narrowest < 40) throw new Error(label + ": a layer name is " + narrowest + " px wide");
    return Math.round(narrowest);
};
const kinds = {};
for (const layer of ed.layers) {
    const k = layer.kind;
    if (kinds[k] != null) continue;
    ed.activeLayerId = layer.id;
    kinds[k] = probe("active " + k);
}
if (scrollbar <= 0) throw new Error("the list shows no scrollbar with 17 layers, so the narrow case was not measured");
// rename through the name's own double-click, then take it back
const layer = ed.layers.find((l) => l.kind === "paint");
ed.activeLayerId = layer.id;
ed.renderLayers();
const before = layer.name;
const nameEl = Array.from(list.querySelectorAll(".ipc-layer .ipc-name")).find((n) => n.textContent === before);
nameEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
const input = nameEl.querySelector("input");
if (!input) throw new Error("a double-click on the name opened no text field");
input.value = "Renamed layer";
input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
if (layer.name !== "Renamed layer") throw new Error("the name is " + layer.name);
await run("undo", d);
const back = ed.layers.find((l) => l.id === layer.id).name;
if (back !== before) throw new Error("undo left the name at " + back);
const panel = Math.round(ed.root.querySelector(".ipc-side").getBoundingClientRect().width);
await run("close_document", d);
return { panel, scrollbar, narrowestName: kinds, renamedAndUndone: [before, back] };
"""),
    ("keyboard_focus_survives_the_button_click", """
const ed = ednow(window.__t);
const btn = Array.from(ed.root.querySelectorAll("button")).find((b) => (b.title || "").startsWith("New:"));
btn.click();                                     // the real button, so the root click handler runs too
await wait(180);
const inp = ed.root.querySelector(".ipc-askfield input");
const focused = document.activeElement === inp;
Array.from(ed.root.querySelectorAll(".ipc-askbox button")).find((b) => b.textContent === "Cancel").click();
await wait(80);
if (!focused) throw new Error("the focus left the size box: " + (document.activeElement && document.activeElement.className));
return { focusedAfterButtonClick: focused };
"""),
    ("click_deselects_marquee_and_lasso", """
const ed = ednow(window.__t);
const out = {};
await run("select_rect", { x: 100, y: 100, w: 300, h: 200, doc: window.__t });
out.before = !!ed.getBounds();
// a click inside an existing selection with the rectangle tool: selmove, released without moving
const orig = ed.sel.clone();   // the gesture keeps the outline as pixels (C1 step d)
ed.pointer = { kind: "selmove", start: [200, 150], orig, origBounds: ed.getBounds() };
ed.onPointerUp({ pointerId: 1 });
out.afterClickInside = !!ed.getBounds();
// the lasso, a click without a drag
await run("select_rect", { x: 100, y: 100, w: 300, h: 200, doc: window.__t });
ed.lassoPoints = [[50, 50]];
ed.pointer = { kind: "lasso", mode: "replace" };
ed.onPointerUp({ pointerId: 2 });
out.afterLassoClick = !!ed.getBounds();
// the rectangle tool *outside* the selection, a click whose hand wobbled by one screen
// pixel. Zoomed far out that pixel is many image pixels, and it used to leave a small
// selection right under the cursor instead of deselecting.
await run("select_rect", { x: 100, y: 100, w: 300, h: 200, doc: window.__t });
ed.view.scale = 0.087;   // a 15k image fitted into the window
ed.pointer = { kind: "rect", ellipse: false, start: [600, 500], cur: [611, 509], startPx: [400, 300], mode: "replace" };
ed.onPointerUp({ pointerId: 3, pointerType: "mouse" });
out.afterWobbleClick = !!ed.getBounds();
// a real drag still selects
await run("select_none", { doc: window.__t });
ed.pointer = { kind: "rect", ellipse: false, start: [100, 100], cur: [400, 300], startPx: [400, 300], moved: true, mode: "replace" };
ed.onPointerUp({ pointerId: 4, pointerType: "mouse" });
const b = ed.getBounds();
out.afterRealDrag = b ? [b[0], b[1], b[2] - b[0], b[3] - b[1]] : null;
ed.view.scale = 1;
if (!out.before || out.afterClickInside || out.afterLassoClick || out.afterWobbleClick) throw new Error(JSON.stringify(out));
if (!out.afterRealDrag || out.afterRealDrag[2] < 290) throw new Error("a real drag must still select: " + JSON.stringify(out));
return out;
"""),
    ("brush_ring_visible_over_its_own_colour", """
const ed = ednow(window.__t);
// the ring used to be a one pixel line in the paint colour, so it vanished over its own
// paint and a brush wider than the layer looked like a tool that fills rectangles
ed.setTool("paint");
ed.color = "#ff0000";
ed.brushSize = 120;
ed.hardness = 1;
ed.hover = [50, 50];
const c = document.createElement("canvas"); c.width = 100; c.height = 100;
const x = c.getContext("2d");
x.fillStyle = ed.color; x.fillRect(0, 0, 100, 100);
ed.drawBrushRing(x, 1);
const d = x.getImageData(0, 0, 100, 100).data;
let dark = 0;
for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 1] < 128) dark++;
ed.hover = null;
if (!dark) throw new Error("the brush ring is invisible over its own paint colour");
return { darkPixels: dark };
"""),
    ("brush_keys_under_altgr_and_the_opacity_slider", """
const ed = ednow(window.__t);
host.shell.activate(ed);
// the Opacity slider shows for every tool that paints with it (a second moveCtl for "shape" hid it for the brushes, e0c00a7)
const lab = ed.opacCtl.input.parentElement;
const shown = {};
for (const t of ["paint", "erase", "clone", "heal", "bucket", "gradient", "shape", "smudge"]) { ed.setTool(t); ed.updateOptsBar(); shown[t] = !lab.hidden; }
for (const t of ["paint", "erase", "clone", "heal", "bucket", "gradient", "shape"]) if (!shown[t]) throw new Error("the Opacity slider is hidden for " + t + ": " + JSON.stringify(shown));
if (shown.smudge) throw new Error("the Opacity slider shows for smudge, which has Strength instead");
// AltGr+8 / AltGr+9 type [ and ] on a German keyboard; Chromium reports them with Ctrl and Alt down
ed.setTool("paint");
const moved = [];
const undos = [];
// stubs on the instance, deleted after: the prototype's methods come back
ed.moveLayer = function (...a) { moved.push(a); };
ed.activeLayer = function () { return { id: "stub" }; };
ed.undoStep = function () { undos.push(1); };
const key = (k, o) => ed.onKey(new KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, o)));
const probe = new KeyboardEvent("keydown", { key: "[", ctrlKey: true, altKey: true, modifierAltGraph: true });
if (!probe.getModifierState("AltGraph")) throw new Error("this Chromium does not take modifierAltGraph: the step cannot build an AltGr key");
let sizes;
try {
    ed.setBrushSize(100);
    key("[", { ctrlKey: true, altKey: true, modifierAltGraph: true });
    const small = ed.brushSize;
    key("]", { ctrlKey: true, altKey: true, modifierAltGraph: true });
    const back = ed.brushSize;
    sizes = [small, back];
    if (small !== 83 || back !== 100) throw new Error("AltGr+[ / ] did not size the brush: " + sizes);
    if (moved.length) throw new Error("AltGr+[ moved the layer: " + JSON.stringify(moved));
    // Ctrl+[ without AltGr still moves the layer; AltGr+Z is no undo
    key("[", { ctrlKey: true });
    if (moved.length !== 1) throw new Error("Ctrl+[ no longer moves the layer: " + JSON.stringify(moved));
    key("z", { ctrlKey: true, altKey: true, modifierAltGraph: true });
    if (undos.length) throw new Error("AltGr+Z ran an undo");
    key("z", { ctrlKey: true });
    if (undos.length !== 1) throw new Error("Ctrl+Z no longer undoes");
} finally { delete ed.moveLayer; delete ed.activeLayer; delete ed.undoStep; }
return { shown, sizes };
"""),
    ("the_brush_reaches_1000_px_on_a_log_slider", """
// PLAN_0_1_31 §4 step 7: the brush size goes to 1,000 px (measured on the regional path, docs/PERFORMANCE.md §15) on a
// logarithmic Size slider, and every way to set it stops there: the slider, setBrushSize and the keys, set_brush
const ed = ednow(window.__t);
host.shell.activate(ed);
const I = await import("./editor/inpaint_canvas.js");
const keep = ed.brushSize, out = { max: I.BRUSH_MAX };
try {
    if (I.BRUSH_MAX !== 1000) throw new Error("the cap is " + I.BRUSH_MAX);
    const trips = {};
    for (const s of [2, 3, 10, 40, 100, 400, 1000]) {
        const back = I.sliderToBrushSize(I.brushSizeToSlider(s));
        trips[s] = back;
        if (Math.abs(back - s) > Math.max(1, s * 0.03)) throw new Error("the slider does not come back to " + s + ": " + back);
    }
    out.trips = trips;
    if (I.sliderToBrushSize(0) !== 2 || I.sliderToBrushSize(1000) !== 1000) throw new Error("the slider's ends are not 2 and 1000 px");
    out.at40 = I.brushSizeToSlider(40);
    if (out.at40 < 333) throw new Error("40 px sits at " + out.at40 + " of 1000 on the slider: the small sizes got no room");
    const inp = ed.sizeCtl.input;
    inp.value = String(I.brushSizeToSlider(800));
    inp.dispatchEvent(new Event("input"));
    out.slider = ed.brushSize;
    if (Math.abs(ed.brushSize - 800) > 24) throw new Error("the slider at 800 px gave " + ed.brushSize);
    ed.setBrushSize(5000);
    if (ed.brushSize !== 1000) throw new Error("setBrushSize(5000) gave " + ed.brushSize);
    ed.setBrushSize(900);
    ed.onKey(new KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true }));
    if (ed.brushSize !== 1000) throw new Error("] from 900 px gave " + ed.brushSize);
    await run("set_brush", { doc: window.__t, size: 700 });
    out.command = [ed.brushSize, I.sliderToBrushSize(+inp.value), ed.sizeCtl.value.textContent];
    if (ed.brushSize !== 700 || Math.abs(I.sliderToBrushSize(+inp.value) - 700) > 21 || ed.sizeCtl.value.textContent !== "700px") throw new Error("set_brush 700: " + JSON.stringify(out.command));
    await run("set_brush", { doc: window.__t, size: 5000 });
    if (ed.brushSize !== 1000) throw new Error("set_brush 5000 gave " + ed.brushSize);
} finally { ed.setBrushSize(keep); }
return out;
"""),
    ("outline_visible_on_white", """
const ed = ednow(window.__t);
const c = document.createElement("canvas"); c.width = 100; c.height = 100;
const x = c.getContext("2d");
x.fillStyle = "#fff"; x.fillRect(0, 0, 100, 100);
ed.antsStroke(x, () => x.strokeRect(20.5, 20.5, 60, 60), 1);
const d = x.getImageData(0, 0, 100, 100).data;
let dark = 0;
for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
if (!dark) throw new Error("nothing dark was drawn: the outline stays invisible on white");
return { darkPixels: dark };
"""),
    ("copy_paste_a_layer_into_another_tab", """
const a = ednow(window.__t);
host.shell.activate(a);
await run("add_paint_layer", { name: "Source layer", doc: window.__t });
const l = a.activeLayer();
l.px.drawInto(null, (lc) => { lc.fillStyle = "#ff3300"; lc.fillRect(10, 10, 120, 60); });   // writes go through the layer's pixels
a.markLayerChanged(l);
a.clearSelection();
const copied = a.copySelection({});               // nothing selected: the whole layer
if (!copied) throw new Error("nothing copied: " + a.status);
const d2 = await run("new_document");
window.__t2 = d2.id;
const b = ednow(d2.id);
host.shell.activate(b);
await run("new_canvas", { width: 512, height: 384, doc: d2.id });
const pasted = b.pasteClipboard();
if (!pasted) throw new Error("nothing pasted: " + b.status);
return { copiedFrom: copied.source, size: [copied.canvas.width, copied.canvas.height], layerName: pasted.name, layersInTab2: b.layers.length };
"""),
    ("duplicate_button_in_the_layer_row", """
const b = ednow(window.__t2);
host.shell.activate(b);
b.renderLayers();
const btn = Array.from(b.root.querySelectorAll("button")).find((x) => (x.title || "").startsWith("Duplicate layer"));
if (!btn) throw new Error("no duplicate button in the layer row");
const before = b.layers.length;
btn.click();
await wait(80);
if (b.layers.length !== before + 1) throw new Error("the button did not duplicate: " + b.status);
return { before, after: b.layers.length };
"""),
    ("erase_stroke_keeps_the_rest_of_the_layer_on_screen", """
// A result layer on a large document, viewed zoomed out, so the screen is drawn from the
// layer's cached display level. One erase stroke through a strip of it used to wipe the
// level everywhere except the strip: the pixels survived, the picture lost the whole
// layer. The real pointer handlers are driven, because the gesture builds the stroke
// buffer and the clip from the selection, and the report had a selection.
const d3 = await run("new_document");
window.__t3 = d3.id;
const ed = ednow(d3.id);
host.shell.activate(ed);
await run("new_canvas", { width: 4000, height: 3000, doc: d3.id });
const LX = 1000, LY = 700, LW = 2236, LH = 1853;   // over 1 MP, so the layer gets display levels
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const lc = mk(LW, LH);
const g = lc.getContext("2d");
g.fillStyle = "#20c040";
g.fillRect(730, 100, 800, 200);   // the strip the stroke runs through
g.fillRect(930, 780, 370, 300);   // the block 580 px below it, which has to stay
const { Layer: LayerPixels } = ed.pixels;   // the editor's backend (tiles or canvases)
const layer = ed.addLayer({ name: "Result", kind: "result", ref: null, px: LayerPixels.fromCanvas(lc), x: LX, y: LY, w: LW, h: LH, dirty: true });
ed.markLayerChanged(layer);
await run("select_rect", { x: LX, y: LY, w: LW, h: LH, doc: d3.id });   // the eraser is clipped to it
ed._fitted = false;
ed.view.scale = 0.2;
ed.view.x = ed.canvas.width / 2 - (LX + LW / 2) * 0.2;
ed.view.y = ed.canvas.height / 2 - (LY + LH / 2) * 0.2;
ed.setTool("erase");
ed.brushSize = 400; ed.eraseHardness = 0.43; ed.brushOpacity = 1;
ed.draw(); await wait(200); ed.draw(); await wait(200);   // the level chain is built one level per frame
const screenAt = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return Array.from(ed.canvas.getContext("2d").getImageData(Math.round(sx), Math.round(sy), 1, 1).data); };
// the strip is sampled 100 px into the stroke, clear of the brush ring drawn at its end
const block = [LX + 930 + 185, LY + 780 + 150], strip = [LX + 1030, LY + 200];
const green = (p) => p[0] < 100 && p[1] > 150, white = (p) => p[0] > 200 && p[1] > 200 && p[2] > 200;
const before = { block: screenAt(...block), strip: screenAt(...strip) };
if (!green(before.block) || !green(before.strip)) throw new Error("the green is not on screen before the stroke: " + JSON.stringify(before));
const rect = ed.canvas.getBoundingClientRect();
const client = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 9, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
const y = LY + 200, x0 = LX + 930, x1 = LX + 1330;
ed.canvas.dispatchEvent(ev("pointerdown", x0, y));
const kind = ed.pointer && ed.pointer.kind, clipped = !!(ed.pointer && ed.pointer.clip);
for (let i = 1; i <= 10; i++) { ed.canvas.dispatchEvent(ev("pointermove", x0 + (x1 - x0) * i / 10, y)); await wait(16); }
ed.canvas.dispatchEvent(ev("pointerup", x1, y));
ed.hover = null;
await wait(100); ed.draw(); await wait(100);
const d = layer.px.readRect(0, 0, LW, LH).data;
let alpha = 0;
for (let i = 3; i < d.length; i += 4) if (d[i] > 0) alpha++;
const after = { block: screenAt(...block), strip: screenAt(...strip), alpha, kind, clipped };
if (kind !== "layerpaint" || !clipped) throw new Error("the gesture did not become a clipped erase stroke: " + JSON.stringify(after));
if (alpha < 111000 || alpha >= 271000) throw new Error("the layer's own pixels are wrong: " + JSON.stringify(after));
if (!white(after.strip)) throw new Error("the erase did not reach the screen: " + JSON.stringify(after));
if (!green(after.block)) throw new Error("the block 580 px from the stroke vanished from the screen: " + JSON.stringify(after));
return { before, after };
"""),
    ("normalise_filter_moves_colours_to_the_mean_on_both_paths", """
const F = await import("./editor/inpaint_filters.js");
const GL = await import("./editor/inpaint_filters_gl.js");
const ed = ednow(window.__t);
host.shell.activate(ed);
await run("new_canvas", { width: 640, height: 400, doc: window.__t });   // the halves must cover the whole picture
// a two-colour picture: a warm left half, a cold right half
const L = await run("add_paint_layer", { doc: window.__t });
const lay = ed.layers.find((l) => l.id === L.id);
lay.px.drawInto(null, (g) => {
    g.fillStyle = "#c86432"; g.fillRect(0, 0, 320, 400);
    g.fillStyle = "#3264c8"; g.fillRect(320, 0, 320, 400);
});
lay.dirty = true; ed.touchSource(lay.px); ed.draw();
const src = ed.flattenToCanvas({ forRun: true });
const out = {};
for (const mode of ["colour", "all", "levels"]) {
    const r = GL.compareFilterPaths((s, p, i) => F.FILTERS.normalize.apply(s, p, i), "normalize", src, { mode, amount: 100 }, {});
    out[mode] = { gl: r.gl, max: r.max, mean: r.mean };
    if (!r.gl) throw new Error("no GPU path for normalize (" + mode + ")");
    if (r.max > 2) throw new Error(mode + ": GPU and CPU differ by " + r.max + " levels");
}
// "all" at 100 %: everything becomes the mean of the two halves
const all = F.FILTERS.normalize.apply(src, { mode: "all", amount: 100 }, {});
const px = (cv, x, y) => Array.from(cv.getContext("2d").getImageData(x, y, 1, 1).data);
const left = px(all, 100, 200), right = px(all, 540, 200);
if (Math.abs(left[0] - right[0]) > 2 || Math.abs(left[2] - right[2]) > 2) throw new Error("not the same after 'all': " + left + " / " + right);
if (Math.abs(left[0] - 125) > 3 || Math.abs(left[2] - 125) > 3) throw new Error("the mean is off: " + left);
// "colour": the tint evens out, the luma of each half stays
const col = F.FILTERS.normalize.apply(src, { mode: "colour", amount: 100 }, {});
const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const cl = px(col, 100, 200), cr = px(col, 540, 200), sl = px(src, 100, 200), sr = px(src, 540, 200);
if (Math.abs(luma(cl) - luma(sl)) > 3 || Math.abs(luma(cr) - luma(sr)) > 3) throw new Error("colour mode changed the luma: " + cl + " vs " + sl);
if (Math.abs((cl[0] - cl[2]) - (cr[0] - cr[2])) > 4) throw new Error("colour mode left different tints: " + cl + " / " + cr);
// as a filter layer through the command core
const fl = await run("add_filter", { type: "normalize", params: { mode: "all", amount: 50 }, doc: window.__t });
const flat = ed.flattenToCanvas({ forRun: true });
const hl = px(flat, 100, 200);
if (Math.abs(hl[0] - (200 + 125) / 2) > 4) throw new Error("the filter layer at 50 % is off: " + hl);
await run("remove_layer", { layer: fl.id, doc: window.__t });
await run("remove_layer", { layer: L.id, doc: window.__t });
return { ...out, all: left, colour: [cl, cr], half: hl };
"""),
    ("export_canvas_frames_the_picture", """
const ed = ednow(window.__t);
host.shell.activate(ed);
const L = await run("add_paint_layer", { doc: window.__t });
const lay = ed.layers.find((l) => l.id === L.id);
lay.px.drawInto(null, (g) => { g.fillStyle = "#ff0000"; g.fillRect(0, 0, ed.width, ed.height); });
lay.dirty = true; ed.touchSource(lay.px); ed.draw();
const path = window.__exportPath;
const r = await run("export", { format: "png", path, width: 320, canvas_width: 400, canvas_height: 300, anchor: "br", fill: "white", doc: window.__t });
const f = await window.scumble.file.read(path);
const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(new Blob([f.data], { type: "image/png" })); });
if (img.naturalWidth !== 400 || img.naturalHeight !== 300) throw new Error("frame " + img.naturalWidth + "x" + img.naturalHeight);
const c = document.createElement("canvas"); c.width = 400; c.height = 300;
const x = c.getContext("2d"); x.drawImage(img, 0, 0);
const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data);
const tl = px(2, 2), br = px(397, 297);
// 320 wide at the picture's aspect: the red picture sits bottom right, the white fill top left
if (br[0] < 250 || br[1] > 5) throw new Error("bottom right is not the picture: " + br);
if (tl[0] < 250 || tl[1] < 250) throw new Error("top left is not the white fill: " + tl);
// the row's state was restored after the command
const e = host.exportState(ed);
if (e.canvasW || e.canvasH) throw new Error("the export command left the frame set: " + JSON.stringify(e));
// the row itself: type a frame, the state follows, layered formats disable it
const row = ed._exportRow;
row.cw.value = "800"; row.cw.dispatchEvent(new Event("change"));
const after = host.exportState(ed);
if (after.canvasW !== 800 || !(after.canvasH > 0)) throw new Error("the row did not set the frame: " + JSON.stringify(after));
host.setExportSize(ed, { canvasWidth: 0, canvasHeight: 0 });
await run("remove_layer", { layer: L.id, doc: window.__t });
return { frame: [img.naturalWidth, img.naturalHeight], tl, br, rowFrame: [after.canvasW, after.canvasH] };
"""),
    ("scale_snaps_to_the_canvas_edges", """
const ed = ednow(window.__t);
host.shell.activate(ed);
await run("new_canvas", { width: 1000, height: 800, doc: window.__t });
const L = await run("add_paint_layer", { doc: window.__t });
const l = ed.layers.find((x) => x.id === L.id);
l.x = 100; l.y = 100; l.w = 400; l.h = 300;
ed.view.scale = 1;
const gesture = (handle, keepAspect) => ({ kind: "scale", layer: l, handle, start: [0, 0], orig: { x: 100, y: 100, w: 400, h: 300 }, keepAspect });
const out = {};
// the bottom-right corner dragged to 6 px short of the right edge and 5 px past the bottom: both snap
let p = gesture("se", false);
ed.applyScale(p, 994, 805); ed.snapGuides = null; ed.snapScale(p, 994, 805);
out.corner = [l.x + l.w, l.y + l.h, ed.snapGuides];
if (l.x + l.w !== 1000 || l.y + l.h !== 800) throw new Error("the corner did not snap: " + JSON.stringify(out.corner));
// too far away: no snap
l.x = 100; l.y = 100; l.w = 400; l.h = 300;
ed.applyScale(p, 970, 760); ed.snapGuides = null; ed.snapScale(p, 970, 760);
out.far = [l.x + l.w, l.y + l.h];
if (l.x + l.w !== 970 || l.y + l.h !== 760) throw new Error("snapped from too far: " + out.far);
// the left edge to the canvas centre (500) with the west handle; the anchor is the right edge at 900
l.x = 600; l.y = 100; l.w = 300; l.h = 300;
p = gesture("w", false); p.orig = { x: 600, y: 100, w: 300, h: 300 };
ed.applyScale(p, 504, 200); ed.snapGuides = null; ed.snapScale(p, 504, 200);
out.centre = [l.x, l.w, ed.snapGuides && ed.snapGuides.x];
if (l.x !== 500 || l.w !== 400) throw new Error("the west edge did not snap to the centre: " + l.x + " w " + l.w);
// a kept aspect: the dragged right edge snaps to the canvas edge, the height follows the ratio
l.x = 0; l.y = 0; l.w = 400; l.h = 300;
p = gesture("se", true); p.orig = { x: 0, y: 0, w: 400, h: 300 };
ed.applyScale(p, 994, 600); ed.snapGuides = null; ed.snapScale(p, 994, 600);
out.aspect = [l.w, l.h, ed.snapGuides];
if (l.x + l.w !== 1000 || Math.abs(l.h - 750) > 1) throw new Error("kept aspect: " + out.aspect);
if (!ed.snapGuides || !ed.snapGuides.x.includes(1000) || ed.snapGuides.y.length) throw new Error("guide lines: " + JSON.stringify(ed.snapGuides));
ed.snapGuides = null;
await run("remove_layer", { layer: L.id, doc: window.__t });
return out;
"""),
    ("escape_closes_the_shell_dialogs", lambda c: escape_closes_the_shell_dialogs(c)),
    ("settings_form_accepts_its_own_values", lambda c: settings_form_accepts_its_own_values(c)),
    ("svg_import_rasterises_on_the_way_in", lambda c: svg_import_rasterises_on_the_way_in(c)),
    ("selection_undo_copies_its_extent_and_bounds_come_by_strips", """
// Phase A item 1 (docs/PLAN_TILES.md): a selection undo step is a copy of the selection's extent
// (a feathered tail included), not a PNG of the whole canvas; the bounding box is scanned for in
// strips from the edges of a known superset, and a subtract keeps the old box as that superset.
await run("new_canvas", { width: 1440, height: 900, doc: window.__t });   // an earlier step left the tab at 600 x 300
const ed = ednow(window.__t);
host.shell.activate(ed);
const W = ed.width, H = ed.height;
const out = { size: [W, H] };
const pixels = () => ed.sel.readRect(0, 0, W, H).data;
const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
ed.sel.clear();
ed.markSelectionChanged(null);
// an ellipse drawn straight into the selection's pixels: nothing is known about its box
ed.sel.drawInto(null, (s) => { s.fillStyle = "#ff0000"; s.beginPath(); s.ellipse(700, 450, 300, 200, 0, 0, Math.PI * 2); s.fill(); });
ed.markSelectionChanged();
out.ellipse = ed.getBounds();
const full = ed.scanBounds(0, 0, W, H);
if (!eq(out.ellipse, full)) throw new Error("strip scan " + JSON.stringify(out.ellipse) + " differs from the full scan " + JSON.stringify(full));
// feather: the extent reaches past the bounds, the bounds stay the alpha >= 128 box
await ed.featherSelection(20);
out.feathered = ed.getBounds();
out.extent = ed.selectionExtent();
if (!eq(out.feathered, ed.scanBounds(0, 0, W, H))) throw new Error("bounds after feather: " + JSON.stringify(out.feathered));
if (!(out.extent[0] < out.feathered[0] - 8 && out.extent[2] > out.feathered[2] + 8)) throw new Error("the extent does not cover the feathered tail: " + JSON.stringify([out.extent, out.feathered]));
const before = pixels();
// a subtract from the middle: the old box is kept as a superset and made exact by strips
ed.pushUndo({ kind: "selection" });
const snap = ed.undo[ed.undo.length - 1];
out.snap = { kind: snap.kind, px: !!snap.px, pw: snap.px && snap.px.width, ph: snap.px && snap.px.height, w: snap.w, h: snap.h, bytes: snap.bytes };
if (snap.kind !== "selection" || !snap.px || snap.px.width !== snap.w || snap.px.height !== snap.h || snap.w >= W || snap.bytes !== snap.w * snap.h * 4) throw new Error("the undo step is not a copy of the extent: " + JSON.stringify(out.snap));
ed.sel.drawInto(null, (s) => { s.globalCompositeOperation = "destination-out"; s.fillRect(400, 250, 300, 400); });   // the left half of the ellipse
// the info rows ask for the bounds at once, so the superset is resolved inside the mark: watch
// that it is the old box that is scanned by strips, and that the extent is never scanned for
const calls = [];
const oStrips = ed.scanBoundsIn.bind(ed), oExtent = ed.selectionExtent.bind(ed);
ed.scanBoundsIn = (box) => { calls.push(["strips", box]); return oStrips(box); };
ed.selectionExtent = () => { calls.push(["extent"]); return oExtent(); };
ed.markSelectionChanged(ed.boundsAfter("subtract", [400, 250, 700, 650]), [400, 250, 700, 650]);
out.afterSubtract = ed.getBounds();
ed.scanBoundsIn = oStrips; ed.selectionExtent = oExtent;
out.calls = calls;
if (!calls.some((c) => c[0] === "strips" && eq(c[1], out.feathered)) || calls.some((c) => c[0] === "extent")) throw new Error("a subtract should be scanned inside the old box: " + JSON.stringify(calls));
if (ed.selectionLoose || !eq(out.afterSubtract, ed.scanBounds(0, 0, W, H))) throw new Error("bounds after subtract: " + JSON.stringify(out.afterSubtract));
await ed.undoStep();
const restored = pixels();
out.restoredExact = same(before, restored);
if (!out.restoredExact) throw new Error("the undo did not restore the selection's pixels exactly");
if (!eq(ed.getBounds(), out.feathered)) throw new Error("bounds after undo: " + JSON.stringify(ed.getBounds()));
// an empty selection is a step without pixels, and undoing back to it leaves nothing selected
ed.clearSelection();
await ed.undoStep();
if (!eq(ed.getBounds(), out.feathered)) throw new Error("clear + undo: " + JSON.stringify(ed.getBounds()));
ed.clearSelection();
ed.pushUndo({ kind: "selection" });
out.emptySnap = ed.undo[ed.undo.length - 1].empty === true;
ed.sel.drawInto(null, (s) => { s.fillStyle = "#ff0000"; s.fillRect(10, 10, 50, 50); });
ed.markSelectionChanged([10, 10, 60, 60], [10, 10, 60, 60]);
await ed.undoStep();
out.emptyAgain = ed.getBounds() === null;
if (!out.emptySnap || !out.emptyAgain) throw new Error("empty step: " + JSON.stringify(out));
return out;
"""),
    ("wand_and_bucket_flood_a_region_not_the_image", """
// Phase A item 3 (docs/PLAN_TILES.md): on an image over 2048 px the wand floods a coarse composite
// first, then only the region's box at full resolution, and widens the box where the region reaches
// its edge. The result has to be the pixel-exact region a flood over the whole image gives, also
// across a one pixel bridge the coarse pass cannot see; the bucket fills the same region with a
// rect undo step; the eyedropper composites one pixel.
await run("new_canvas", { width: 5000, height: 3000, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const W = ed.width, H = ed.height;
const { floodMask } = await import("./editor/inpaint_raster.js");
const out = {};
// the base: white, a blue blob left, a blue blob right, joined by a one pixel blue line
const base = document.createElement("canvas"); base.width = W; base.height = H;
const bx = base.getContext("2d");
bx.fillStyle = "#ffffff"; bx.fillRect(0, 0, W, H);
bx.fillStyle = "#2040c0";
bx.beginPath(); bx.arc(1000, 1500, 400, 0, Math.PI * 2); bx.fill();
bx.beginPath(); bx.arc(4000, 1500, 400, 0, Math.PI * 2); bx.fill();
bx.fillRect(1000, 1500, 3000, 1);   // the bridge: 1 px high, invisible at the coarse scale
bx.fillStyle = "#c02020"; bx.fillRect(2200, 400, 600, 300);   // a red block the region must not include
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "flood.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
ed.fillOpts = { tolerance: 32, contiguous: true, sample: "image" };
// the reference: a flood over the whole composite on the main thread
const flat = ed.flattenToCanvas({ forRun: true });
const ref = floodMask(flat.getContext("2d").getImageData(0, 0, W, H).data, W, H, 1000, 1400, 32, true);
let refCount = 0; for (let i = 0; i < ref.length; i++) refCount += ref[i];
out.refCount = refCount;
if (refCount < 2 * Math.PI * 400 * 400 * 0.95) throw new Error("the reference region is not both blobs: " + refCount);
// the wand, clicked in the left blob: both blobs and the bridge, nothing else
const spy = { rounds: null };
const oFlood = ed.floodRegion.bind(ed);
ed.floodRegion = async (x, y, o) => { const r = await oFlood(x, y, o); spy.rounds = r.rounds; spy.box = [r.x, r.y, r.w, r.h]; return r; };
await ed.wandSelect(1000, 1400, "replace");
ed.floodRegion = oFlood;
out.rounds = spy.rounds; out.box = spy.box;
if (!(spy.rounds >= 2)) throw new Error("the box should have been widened across the bridge, rounds " + spy.rounds);
const sel = ed.sel.readRect(0, 0, W, H).data;
let wrong = 0, selCount = 0;
for (let p = 0, i = 3; p < ref.length; p++, i += 4) { const on = sel[i] > 127 ? 1 : 0; selCount += on; if (on !== ref[p]) wrong++; }
out.selCount = selCount; out.wrong = wrong;
if (wrong) throw new Error(wrong + " pixels differ from the whole-image flood");
out.bounds = ed.getBounds();
if (JSON.stringify(out.bounds) !== JSON.stringify([600, 1100, 4400, 1900])) throw new Error("bounds " + JSON.stringify(out.bounds));
// the bucket on a new layer, clipped to nothing (no selection), with a rect undo step
ed.clearSelection();
const layer = ed.addPaintLayer();
ed.activeLayerId = layer.id;
ed.color = "#00ff00"; ed.brushOpacity = 1;
const undoBefore = ed.undo.length;
await ed.bucketFill(4000, 1600);
const step = ed.undo[ed.undo.length - 1];
out.bucketUndo = { kind: step.kind, w: step.w, h: step.h, px: !!step.px };
if (ed.undo.length !== undoBefore + 1 || step.kind !== "layerrect" || !step.px || step.w >= W) throw new Error("the bucket's undo step is not a rect copy: " + JSON.stringify(out.bucketUndo));
const at = (x, y) => Array.from(layer.px.readRect(x, y, 1, 1).data);
out.filled = { left: at(1000, 1400), right: at(4000, 1600), red: at(2500, 500), white: at(100, 100) };
if (out.filled.left[1] !== 255 || out.filled.right[1] !== 255 || out.filled.red[3] !== 0 || out.filled.white[3] !== 0) throw new Error("bucket pixels: " + JSON.stringify(out.filled));
await ed.undoStep();
if (at(4000, 1600)[3] !== 0) throw new Error("the bucket's undo did not clear the fill");
// C6 (c1): the bucket inside a selection floods box by box, and each box takes its part of the selection, not a canvas
// of the whole selection per round (572 MB at 15000 x 10000). The selection cuts the right blob at x = 3900.
ed.sel.clear();
ed.sel.fill([3900, 1000, 4600, 2100], "#ff0000");
ed.markSelectionChanged([3900, 1000, 4600, 2100]);
ed.getBounds();
{
    const selObj = ed.sel, spyName = ed.tileMode ? "_materialise" : "toCanvas";
    const own = Object.prototype.hasOwnProperty.call(selObj, spyName), orig = selObj[spyName];
    const areas = [];
    selObj[spyName] = function (r) {
        // the autosave's background encode of the selection is a whole read of its own, not the flood's
        if (!/encodeSelectionSoon/.test(new Error().stack)) areas.push(r ? (r[2] - r[0]) * (r[3] - r[1]) : W * H);
        return orig.call(this, r);
    };
    const fr = { rounds: null, box: null };
    ed.floodRegion = async (x, y, o) => { const r = await oFlood(x, y, o); fr.rounds = r.rounds; fr.box = [r.x, r.y, r.w, r.h]; return r; };
    try { await ed.bucketFill(4100, 1600); } finally { if (own) selObj[spyName] = orig; else delete selObj[spyName]; ed.floodRegion = oFlood; }
    out.bucketInSelection = { rounds: fr.rounds, box: fr.box, selectionReads: areas };
    if (!(fr.rounds >= 1)) throw new Error("the bucket in a selection did not take the box path: " + JSON.stringify(fr));
    // B item 2: over a plain stack the pool's worker reads the selection's tiles where they lie, and nothing is read here
    const overTiles = !!(ed.floodStack && ed.floodStack("image"));
    out.bucketInSelection.overTiles = overTiles;
    if (!areas.length && !overTiles) throw new Error("the bucket in a selection read no part of the selection (the spy saw nothing)");
    if (areas.length && overTiles) throw new Error("the bucket over tiles still read the selection here: " + JSON.stringify(areas));
    if (areas.some((a) => a >= W * H)) throw new Error("the bucket read the whole selection for a box: " + JSON.stringify(areas));
    const inside = at(4100, 1600), outside = at(3700, 1600);
    if (inside[1] !== 255 || outside[3] !== 0) throw new Error("the bucket in a selection filled " + JSON.stringify({ inside, outside }));
    await ed.undoStep();
    ed.clearSelection();
}
// the eyedropper composites one pixel: the red block through the (empty) layer
ed.pickColor(2500, 500);
out.picked = ed.color;
if (ed.color !== "#c02020") throw new Error("eyedropper picked " + ed.color);
// the active layer alone as the sample source: the layer is empty, so the region is everything transparent
ed.fillOpts = { tolerance: 32, contiguous: true, sample: "layer" };
await ed.wandSelect(100, 100, "replace");
out.layerSample = ed.getBounds();
if (JSON.stringify(out.layerSample) !== JSON.stringify([0, 0, W, H])) throw new Error("layer sample: " + JSON.stringify(out.layerSample));
// C6 (c2b): the active layer as the sample source, painted and masked: read from its own tiles and its mask's, not from a
// display mirror (or `_masked` and two mirrors, and a pyramid for the coarse pass). The layer gets the blobs, the mask the
// left half; the eyedropper, the wand and a direct box read against the layer's own pixels with the mask applied by hand.
{
    const P = await import("./editor/inpaint_pixels.js");
    const lc = document.createElement("canvas"); lc.width = W; lc.height = H;
    const lx = lc.getContext("2d");
    lx.fillStyle = "#20a040"; lx.beginPath(); lx.arc(1500, 1500, 500, 0, Math.PI * 2); lx.fill();
    lx.beginPath(); lx.arc(3500, 1500, 500, 0, Math.PI * 2); lx.fill();
    lx.fillRect(1500, 1500, 2000, 1);
    layer.px.writeRect(lx.getImageData(0, 0, W, H), 0, 0);
    ed.markLayerChanged(layer);
    layer.maskPx = ed.pixels.Mask.empty(W, H);
    layer.maskPx.fill([0, 0, 2500, H], "#ffffff");
    ed.markMaskChanged(layer);
    ed.releaseCaches({ mirrors: true });
    ed.fillOpts = { tolerance: 32, contiguous: true, sample: "layer" };
    ed.pickColor(1500, 1400);
    const inside = ed.color, insideStatus = ed.status;
    ed.pickColor(3500, 1400);
    const outsideStatus = ed.status;
    if (inside !== "#20a040" || !/Transparent/.test(outsideStatus)) throw new Error("the eyedropper on the masked layer: " + JSON.stringify({ inside, insideStatus, outsideStatus }));
    await ed.wandSelect(1500, 1400, "replace");
    // the reference: the layer's pixels, zero where the mask hides them, flooded over the whole image
    const d = layer.px.readRect(0, 0, W, H).data, md = layer.maskPx.readRect(0, 0, W, H).data;
    for (let i = 3; i < d.length; i += 4) if (md[i] < 128) { d[i - 3] = 0; d[i - 2] = 0; d[i - 1] = 0; d[i] = 0; }
    const lref = floodMask(d, W, H, 1500, 1400, 32, true);
    const lsel = ed.sel.readRect(0, 0, W, H).data;
    let lwrong = 0, lcount = 0;
    for (let q = 0, i = 3; q < lref.length; q++, i += 4) { const on = lsel[i] > 127 ? 1 : 0; lcount += on; if (on !== lref[q]) lwrong++; }
    const box = [1000, 1000, 2900, 1700];
    const direct = ed.sampleRegion("layer", box, 1).getContext("2d").getImageData(0, 0, box[2] - box[0], box[3] - box[1]).data;
    let dmax = 0;
    for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
        const i = (y * W + x) * 4, j = ((y - box[1]) * (box[2] - box[0]) + (x - box[0])) * 4;
        for (let k = 0; k < 4; k++) { const df = Math.abs(direct[j + k] - d[i + k]); if (df > dmax) dmax = df; }
    }
    const made = ed.tileMode ? { px: !!P.displayCanvasIfMade(layer.px), mask: !!P.displayCanvasIfMade(layer.maskPx), masked: !!layer._masked } : null;
    out.layerSampleMasked = { inside, lcount, lwrong, dmax, made };
    if (lwrong) throw new Error("the wand on the masked layer differs from the flood of its masked pixels in " + lwrong + " pixels (" + lcount + " selected)");
    if (dmax > 2) throw new Error("a box of the masked layer as the sample source differs from its masked pixels by " + dmax + " levels");   // the anti-aliased edge of the discs through a premultiplied canvas
    if (made && (made.px || made.mask || made.masked)) throw new Error("the layer as the sample source made a display copy: " + JSON.stringify(made));
    layer.maskPx = null;
    ed.markLayerChanged(layer);
}
ed.clearSelection();
await run("remove_layer", { layer: layer.id, doc: window.__t });
return out;
"""),
    ("a_sampled_pass_matches_only_the_part_of_a_matched_layer_it_shows", """
// C6 (b3): a sampled pass (the wand's and the bucket's fine boxes, a plugin's flatten with a box) matched the whole
// colour-matched layer for a box of a few hundred pixels: a GPU pass and a readback of the layer's size per box. It
// matches the part its region shows now, with the whole layer's statistics, and the pixels are the ones a pass over
// the whole layer draws there. Both backends, at scale 1 and at 0.5.
await run("new_canvas", { width: 3000, height: 2000, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const W = ed.width, H = ed.height;
const base = document.createElement("canvas"); base.width = W; base.height = H;
{
    const x = base.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#304060"); g.addColorStop(1, "#c09050");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 400; i++) { x.fillStyle = `hsl(${(i * 47) % 360},60%,${30 + (i * 13) % 50}%)`; x.fillRect((i * 733) % W, (i * 419) % H, 40, 40); }
}
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "match.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const lc = document.createElement("canvas"); lc.width = 1200; lc.height = 900;
{
    const x = lc.getContext("2d");
    const g = x.createLinearGradient(0, 0, 1200, 900); g.addColorStop(0, "#20c040"); g.addColorStop(1, "#c02080");
    x.fillStyle = g; x.fillRect(0, 0, 1200, 900);
    for (let i = 0; i < 200; i++) { x.fillStyle = `hsl(${(i * 71) % 360},80%,50%)`; x.fillRect((i * 331) % 1200, (i * 197) % 900, 7, 7); }
}
const L = ed.addLayer({ name: "Matched", kind: "result", px: ed.pixels.Layer.fromCanvas(lc), x: 700, y: 500, w: 1200, h: 900, dirty: true });
L.match = { strength: 100, source: "surroundings" };
ed.markMatchChanged(L);
ed.renderLayers(); ed.fitView(); ed.sceneSig = null; ed.draw();
await ed.mipsSettled(); ed.sceneSig = null; ed.draw();
if (!(L._mstatsSample && L._mstatsSample.stats)) throw new Error("the screen made no statistics for the matched layer");
const read = (c, x = 0, y = 0, w = c.width, h = c.height) => c.getContext("2d").getImageData(x, y, w, h).data;
const out = {};
const box = [600, 600, 1000, 900], whole = [600, 400, 2000, 1500];   // the box cuts the layer's left edge; `whole` holds all of it
for (const s of [1, 0.5]) {
    const a = ed.sampleRegion("image", box, s, { forRun: true });
    const cache = L._mcacheSample;
    const part = cache && cache.canvas ? [cache.canvas.width, cache.canvas.height] : null;
    // the box shows 300 x 300 of the layer's 1200 x 900 source pixels: matched with one pixel of margin, 302 at most. On
    // tiles (C6 c 7b) the part matched is the layer's region canvas at the pass's level, which a read that holds the range
    // reuses however large it is (here all of this small layer); `a_colour_matched_layer_draws_from_its_own_tiles` checks
    // that no mirror is matched
    if (!part || (!ed.tileMode && (part[0] > 302 || part[1] > 302))) throw new Error(`a ${s} pass over a box matched ${JSON.stringify(part)} source pixels of the layer, not the part the box shows`);
    const b = ed.sampleRegion("image", whole, s, { forRun: true });
    const wholePart = L._mcacheSample && L._mcacheSample.canvas ? [L._mcacheSample.canvas.width, L._mcacheSample.canvas.height] : null;
    const da = read(a), db = read(b, (box[0] - whole[0]) * s, (box[1] - whole[1]) * s, a.width, a.height);
    let max = 0, n = 0;
    for (let i = 0; i < da.length; i++) { const d = Math.abs(da[i] - db[i]); if (d > max) max = d; if (d > 1) n++; }
    // the floor: the matched pixels are not the layer's own (the match moved them)
    let moved = 0, cnt = 0;
    if (s === 1) {
        const own = L.px.readRect(0, 100, 300, 300).data, got = read(a, 100, 0, 300, 300);
        for (let i = 0; i < own.length; i += 4) { moved += Math.abs(own[i] - got[i]) + Math.abs(own[i + 1] - got[i + 1]) + Math.abs(own[i + 2] - got[i + 2]); cnt += 3; }
        moved = +(moved / cnt).toFixed(1);
        if (moved < 10) throw new Error("the box's pixels of the layer are not matched: " + moved + " levels from the layer's own");
    }
    out["s" + s] = { part, wholePart, max, over1: n, moved };
    if (max > 1) throw new Error(`the ${s} pass over the box differs from the pass over the whole layer by ${max} levels on ${n} bytes`);
    if (s === 1) out.boxAt1 = read(a);
}
// C6 (c1) review: the pass over `whole` matches its part through the same function, so a part matched or placed wrong
// moves both passes alike. The reference that does not: the screen at 1:1 on Canvas 2D, which draws the whole layer
// matched (layerMatchedPixels) with the same statistics
{
    const compOff = ed.compositorOff;
    ed.compositorOff = true;
    ed.setTool("rect"); ed.hover = null;
    ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false;
    ed.view.x = -400; ed.view.y = -450;
    ed.sceneSig = null; ed.draw(); await ed.mipsSettled(); await wait(60); ed.sceneSig = null; ed.draw(); await wait(60);
    const c0 = ed.imageToScreen(box[0], box[1]).map(Math.round);
    const [ix, iy] = ed.canvasToImage(c0[0], c0[1]).map(Math.round);
    const scr = ed.canvas.getContext("2d").getImageData(c0[0], c0[1], box[2] - box[0], box[3] - box[1]).data;
    ed.compositorOff = compOff;
    const ref = out.boxAt1;
    delete out.boxAt1;
    let max = 0, n = 0;
    for (let i = 0; i < scr.length; i++) { const d = Math.abs(scr[i] - ref[i]); if (d > max) max = d; if (d > 2) n++; }
    out.screen = { at: [ix, iy], max, over2: n };
    if (ix !== box[0] || iy !== box[1]) throw new Error("the screen's region is at " + [ix, iy] + ", not the box's corner");
    // C6 (c) 7c: the screen and a sampled pass take the same statistics (7a / 7b read 3 to 6 levels here while the
    // screen took its own); on tiles both draw the same region canvas (0 levels). On canvases the screen matches the
    // layer's GPU copy and the pass its CPU pyramid: 5 levels on 294 bytes. A part matched or placed wrong is 148 levels
    // off (the (b3) mutation)
    if (max > (ed.tileMode ? 2 : 6)) throw new Error(`the 1 pass over the box differs from the screen at 1:1 by ${max} levels on ${n} bytes: the matched part is matched or placed wrong`);
    ed.fitView(); ed.sceneSig = null; ed.draw();
}
await run("remove_layer", { layer: L.id, doc: window.__t });
return out;
"""),
    ("a_sampled_pass_keys_its_filter_output_on_its_box_and_scale", """
// C6 (c1): a filter layer's output in a sampled pass was cached under the pass's size and origin only, so a pass over
// another box or at another scale with the same size and origin (the film panel's 192 px picture of the whole image,
// then a 192 x 128 box at the corner at full resolution) got the first pass's filter output. Both backends.
await run("new_canvas", { width: 1200, height: 800, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const W = ed.width, H = ed.height;
const base = document.createElement("canvas"); base.width = W; base.height = H;
{
    const x = base.getContext("2d");
    for (let i = 0; i < 60; i++) { x.fillStyle = `hsl(${(i * 37) % 360},70%,${25 + (i * 11) % 50}%)`; x.fillRect((i * 97) % W, (i * 53) % H, 90, 70); }
}
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "key.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const fx = ed.addFilterLayer("invert");
ed.renderLayers(); ed.fitView(); ed.draw();
await ed.mipsSettled();
const small = ed.sampleRegion("image", [0, 0, W, H], 192 / W, { forRun: true });   // 192 x 128 at the origin
const box = ed.sampleRegion("image", [0, 0, 192, 128], 1, { forRun: true });         // 192 x 128 at the origin too
if (small.width !== box.width || small.height !== box.height) throw new Error("the two passes are not the same size: " + [small.width, small.height, box.width, box.height]);
const flat = ed.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(0, 0, 192, 128).data;
const got = box.getContext("2d").getImageData(0, 0, 192, 128).data;
let max = 0, n = 0;
for (let i = 0; i < got.length; i++) { const d = Math.abs(got[i] - flat[i]); if (d > max) max = d; if (d) n++; }
ed.removeLayer(fx.id);
if (max > 1) throw new Error(`the full-resolution box after the 192 px picture differs from the flatten by ${max} levels on ${n} bytes: it took the other pass's filter output`);
return { max, bytes: n };
"""),
    ("a_settled_read_builds_its_levels_in_the_worker_not_here", """
// C6 (c3) / slice 4: an exact read of a picture at a level - the film panel's 192 px flatten, the glb dialog's
// backdrop, the flood's coarse pass - used to build a mip chain for every tile of every layer on this thread and
// keep it: 2,088 chains and 510 ms in one task at 15000 x 10000, 185 MB left on the tiles. `sampleRegionSettled`
// asks the mips worker for them, takes each one as it lands into a cell of its own and drops the chain.
// The picture must be the one `sampleRegion` gives, byte for byte.
await run("new_canvas", { width: 3000, height: 2000, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const T = await import("./editor/inpaint_tiles.js");
const W = ed.width, H = ed.height;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const base = document.createElement("canvas"); base.width = W; base.height = H;
{
    const x = base.getContext("2d");
    for (let i = 0; i < 90; i++) { x.fillStyle = `hsl(${(i * 37) % 360},70%,${25 + (i * 11) % 50}%)`; x.fillRect((i * 97) % W, (i * 53) % H, 140, 110); }
}
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "settled.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const paint = document.createElement("canvas"); paint.width = W; paint.height = H;
{
    const x = paint.getContext("2d");
    x.globalAlpha = 0.5;
    for (let i = 0; i < 40; i++) { x.fillStyle = `hsl(${(i * 53) % 360},80%,55%)`; x.fillRect((i * 211) % W, (i * 149) % H, 120, 120); }
}
const L = ed.addLayer({ name: "Paint", kind: "paint", px: ed.pixels.Layer.fromCanvas(paint), x: 0, y: 0, w: W, h: H, dirty: true });
ed.renderLayers(); ed.fitView(); ed.draw();
await ed.mipsSettled();

const scale = 192 / W;                       // the film panel's picture: level 3 here
const bytesOf = (c) => c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
const diff = (a, b) => { let m = 0, n = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > m) m = d; } } return [m, n]; };
const out = { tileMode: !!ed.tileMode, async: !!(ed.tileMode && T.chainStats().async) };

// a whole change, so no tile of the flipped layer has a chain
const cold = async () => {
    ed.flipLayer("h");
    ed.renderLayers();
    await pause(40);
    ed.clearUndo();
};

// (i) the same picture both ways, in one state. The caches are given back in between, or the second read
// would be handed the region canvas the first one filled and the comparison would be with itself.
await cold();
const settledC = bytesOf(await ed.sampleRegionSettled("image", [0, 0, W, H], scale, { forRun: true }));
ed.releaseCaches({ mirrors: true, deep: true });
await ed.mipsSettled();
const syncC = bytesOf(ed.sampleRegion("image", [0, 0, W, H], scale, { forRun: true }));
const [worst, n] = diff(settledC, syncC);
if (worst) throw new Error(`the settled read differs from sampleRegion by ${worst} levels on ${n} bytes`);
out.samePicture = [worst, n];

// (ii) on tiles with a worker, an A/B in this same document: the two reads after two identical whole changes,
// one settled and one the old way. The settled one must build far fewer chains on this thread - the old way's
// count is the yardstick, so this cannot go green on a document whose tiles happen to have their chains
// already. Without a worker (the canvas backend, a build with no module worker) everything is built where it
// is read, exactly as before, and there is nothing to assert.
if (out.async) {
    const readWith = async (fn) => {
        await cold();
        await ed.mipsSettled();            // the flip's own screen chains are not this read's
        ed.releaseCaches({ mirrors: true, deep: true });
        await cold();                      // a second whole change: now no tile of that layer has a chain
        await pause(40);
        const m0 = ed.memoryReport().tiles;
        T.chainStats(true);
        const c = await fn();
        const st = T.chainStats();
        const m1 = ed.memoryReport().tiles;
        if (!c || !c.width) throw new Error("the read gave no canvas");
        await ed.mipsSettled();
        return { main: st.main, primed: st.primed, requested: st.requested, handed: st.handed,
                 keptMB: +((m1.chainBytes - m0.chainBytes) / 1048576).toFixed(2), primedBytes: m1.primedBytes,
                 mirrors: m1.mirrors - m0.mirrors };
    };
    const e0 = ed.basePx.chainEpoch;
    const A = await readWith(() => ed.sampleRegionSettled("image", [0, 0, W, H], scale, { forRun: true }));
    const B = await readWith(async () => ed.sampleRegion("image", [0, 0, W, H], scale, { forRun: true }));
    out.settled = A;
    out.theOldWay = B;
    if (!A.primed) throw new Error("the settled read took no cell from the worker: " + JSON.stringify(A));
    if (!B.main) throw new Error("the old way built no chain on this thread, so this document proves nothing: " + JSON.stringify(B));
    if (A.main * 3 >= B.main) throw new Error(`the settled read built ${A.main} chains on this thread against the old way's ${B.main}: it is not using the worker`);
    if (A.keptMB * 2 >= B.keptMB) throw new Error(`the settled read left ${A.keptMB} MB of chains against the old way's ${B.keptMB}`);
    if (A.primedBytes) throw new Error(`the settled read left ${A.primedBytes} bytes of cells behind: its jobs were not released`);
    if (A.mirrors > 0) throw new Error("the settled read made a display mirror");
    if (ed.basePx.chainEpoch !== e0) throw new Error("a read asked for its chains as a reader of the screen (chainEpoch moved)");
}

// (iii) the plugin API: flatten({ settled: true }) is the same picture as flatten({}) and is a promise
{
    const P = await import("./plugins.js");
    const doc = new P.Document(ed, "settled-test");
    await cold();
    const p = doc.flatten({ maxSize: 192, settled: true });
    if (!p || typeof p.then !== "function") throw new Error("flatten({ settled: true }) did not return a promise");
    const whole = doc.flatten({ settled: true });
    if (!whole || typeof whole.then !== "function") throw new Error("flatten({ settled: true }) with no maxSize did not return a promise");
    await whole;
    const got = bytesOf(await p);
    ed.releaseCaches({ mirrors: true, deep: true });
    await ed.mipsSettled();
    const [w2, n2] = diff(got, bytesOf(doc.flatten({ maxSize: 192 })));
    if (w2) throw new Error(`flatten({ settled: true }) differs from flatten({}) by ${w2} levels on ${n2} bytes`);
    out.plugin = [w2, n2];
}
await run("remove_layer", { layer: L.id, doc: window.__t });
return out;
"""),
    ("prompt_context_reads_levels_not_a_flatten", """
// C6 (c5): the picture a language model is shown for upsampling (the crop, the selection outlined in magenta or
// filled green, long side <= 1024) was a full-resolution flatten plus the selection's display mirror: at
// 15000 x 10000 about 3.4 GB made and 2.9 GB kept. On tiles it is a region pass at the output's level and the
// selection from its own tiles, with the chains built in the mips worker. On canvases it stays the old picture,
// byte for byte.
await run("new_canvas", { width: 3000, height: 2000, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const P = await import("./editor/inpaint_pixels.js");
const W = ed.width, H = ed.height;
// smooth content: a mip level and a bilinear draw of the whole flatten agree to a few levels there, so the old
// picture is the yardstick
const base = document.createElement("canvas"); base.width = W; base.height = H;
{
    const x = base.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#284878"); g.addColorStop(1, "#c89048");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 6; i++) { x.fillStyle = `hsl(${i * 60},55%,50%)`; x.beginPath(); x.arc(400 + i * 440, 1000 + (i % 2) * 300, 320, 0, 7); x.fill(); }
}
const baseRef = base.getContext("2d").getImageData(0, 0, W, H).data;
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "promptctx.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const paint = document.createElement("canvas"); paint.width = W; paint.height = H;
{ const x = paint.getContext("2d"); x.fillStyle = "#808080"; x.fillRect(1600, 200, 1200, 900); }
const L = ed.addLayer({ name: "Multiply", kind: "paint", px: ed.pixels.Layer.fromCanvas(paint), x: 0, y: 0, w: W, h: H, dirty: true });
L.blend = "multiply";
ed.renderLayers(); ed.fitView(); ed.draw();
await ed.mipsSettled();

// the body as it was before C6 (c5): the yardstick on tiles, and the exact expectation on canvases
const oldBody = () => {
    const [x, y, w, h] = ed.cropRect();
    const flat = ed.flattenToCanvas({ forRun: true });
    const scale = Math.min(1, 1024 / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(flat, x, y, w, h, 0, 0, c.width, c.height);
    if (ed.getBounds()) {
        const t = document.createElement("canvas"); t.width = c.width; t.height = c.height;
        const r = t.getContext("2d");
        if (ed.cropSettings.fill === "green") {
            ed.sel.drawTo(r, x, y, w, h, 0, 0, c.width, c.height);
            r.globalCompositeOperation = "source-in"; r.fillStyle = "#00ff00"; r.fillRect(0, 0, c.width, c.height);
        } else {
            const px = Math.max(2, Math.round(c.width / 300));
            for (let dx = -px; dx <= px; dx += px) for (let dy = -px; dy <= px; dy += px) ed.sel.drawTo(r, x, y, w, h, dx, dy, c.width, c.height);
            r.globalCompositeOperation = "destination-out"; ed.sel.drawTo(r, x, y, w, h, 0, 0, c.width, c.height);
            r.globalCompositeOperation = "source-in"; r.fillStyle = "#ff00ff"; r.fillRect(0, 0, c.width, c.height);
        }
        ctx.drawImage(t, 0, 0);
    }
    return c;
};
const bytesOf = (c) => c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
const count = (d, f) => { let n = 0; for (let i = 0; i < d.length; i += 4) if (f(d[i], d[i + 1], d[i + 2])) n++; return n; };
// primed cells a read holds until it releases them; another reader's (the film panel renders 500 ms after a change)
// may hold some for a moment, so a leak is cells that never drain
const primedDrained = async (ed) => { for (let i = 0; i < 60; i++) { const t = ed.memoryReport().tiles; if (!t || !t.primedBytes) return 0; await new Promise((r) => setTimeout(r, 50)); } return ed.memoryReport().tiles.primedBytes; };
const magenta = (r, g, b) => r > 200 && g < 90 && b > 200;
const green = (r, g, b) => g > 200 && r < 60 && b < 60;
const cases = [
    { name: "no selection", sel: null, fill: "magenta" },
    { name: "whole ring", sel: [300, 250, 2300, 1500], fill: "magenta" },     // a crop above 1024: a level above 0
    { name: "whole green", sel: [300, 250, 2300, 1500], fill: "green" },
    { name: "small ring", sel: [1210, 530, 610, 410], fill: "magenta" },       // a crop at or near scale 1
];
const out = { tiles: !!ed.tileMode, cases: {} };
const fill0 = ed.cropSettings.fill;
try {
    for (const k of cases) {
        await run("select_none", { doc: window.__t });
        if (k.sel) {
            // an ellipse off the tile grid, so the edge is not a straight run of whole tiles
            ed.sel.drawInto(null, (s) => { s.fillStyle = "#ff0000"; s.beginPath(); s.ellipse(k.sel[0] + k.sel[2] / 2 + 0.5, k.sel[1] + k.sel[3] / 2 + 0.5, k.sel[2] / 2, k.sel[3] / 2, 0, 0, Math.PI * 2); s.fill(); });
            ed.markSelectionChanged();
        }
        ed.cropSettings.fill = k.fill;
        ed.renderLayers(); ed.draw();
        await ed.mipsSettled();
        ed.releaseCaches({ mirrors: true, deep: true });
        const f0 = ed.flattenToCanvas;
        let flats = 0;
        ed.flattenToCanvas = function (...q) { flats++; return f0.apply(this, q); };
        let got;
        try { got = await ed.promptContextCanvas(); } finally { ed.flattenToCanvas = f0; }
        const rep = ed.memoryReport();
        const crop = ed.cropRect();
        const row = { size: [got.width, got.height], crop, flats };
        if (ed.tileMode) {
            row.mirrors = rep.tiles.mirrors;
            if (flats) throw new Error(`${k.name}: the prompt context flattened the picture ${flats} times`);
            if (rep.tiles.mirrors) throw new Error(`${k.name}: the prompt context made ${rep.tiles.mirrors} display mirrors (${(rep.tiles.mirrorBytes / 1048576).toFixed(1)} MB)`);
            if (P.displayCanvasIfMade(ed.sel) || P.displayCanvasIfMade(ed.basePx) || P.displayCanvasIfMade(L.px)) throw new Error(`${k.name}: a display mirror of the selection, the base or the layer was made`);
            const leftP = await primedDrained(ed);
            if (leftP) throw new Error(`${k.name}: ${leftP} bytes of primed cells were left behind`);
        }
        const a = bytesOf(got);
        const refC = oldBody();
        const b = bytesOf(refC);
        if (got.width !== refC.width || got.height !== refC.height) throw new Error(`${k.name}: ${got.width}x${got.height} against the old ${refC.width}x${refC.height}`);
        let max = 0, far = 0;
        const n = a.length;
        for (let i = 0; i < n; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; if (d > 4) far++; }
        row.max = max; row.far = far;
        const mk = k.fill === "green" ? green : magenta;
        row.marked = [count(a, mk), count(b, mk)];
        if (!ed.tileMode) {
            if (max) throw new Error(`${k.name}: the canvas backend's picture changed by ${max} levels on ${far} bytes`);
        } else {
            // a level of the tiles against a bilinear draw of the whole flatten: the selection's edge is box-soft
            // instead of stair-stepped, the rest agrees
            if (far > n * 0.02) throw new Error(`${k.name}: ${far} of ${n} bytes differ by more than 4 levels from the old picture (max ${max})`);
        }
        if (k.sel) {
            if (!row.marked[0]) throw new Error(`${k.name}: no ${k.fill} pixels in the picture`);
            if (Math.abs(row.marked[0] - row.marked[1]) > row.marked[1] * 0.15 + 20) throw new Error(`${k.name}: ${row.marked[0]} ${k.fill} pixels against the old picture's ${row.marked[1]}`);
        } else if (row.marked[0] !== row.marked[1]) throw new Error(`${k.name}: a selection was drawn with none`);
        // the multiply layer darkens: the picture is the composite, not the base alone
        const sc = got.width / crop[2];
        const qx = Math.round((2200 - crop[0]) * sc), qy = Math.round((400 - crop[1]) * sc);
        if (qx >= 0 && qy >= 0 && qx < got.width && qy < got.height) {
            const i = (qy * got.width + qx) * 4, bi = (400 * W + 2200) * 4;
            row.multiply = [a[i], baseRef[bi]];
            if (baseRef[bi] - a[i] < 30) throw new Error(`${k.name}: the multiply layer is not in the picture (${a[i]} against the base's ${baseRef[bi]})`);
        }
        out.cases[k.name] = row;
    }
} finally {
    ed.cropSettings.fill = fill0;
    await run("select_none", { doc: window.__t });
}
await run("remove_layer", { layer: L.id, doc: window.__t });
return out;
"""),
    ("helper_inputs_read_levels_and_upload_nothing", """
// C6 (c) slice 6: the in-app helper models' inputs. The object map read one or two full-resolution flattens (or a
// whole layer on grey) for a 1024 x 1024 input, and before that `segmentSource` flattened the picture once more,
// encoded it as a PNG and uploaded it, only for its hash; the cutout input was a whole-layer `toCanvas()`. Now the
// inputs are read from levels on tiles, the map is keyed on a hash of the input itself, nothing is uploaded, and the
// hover checks a composite version stamp. The model is a stand-in: `host.helperCall` answers here, no ONNX needed.
await run("new_canvas", { width: 8000, height: 5000, doc: window.__t });   // s = 0.2048: level 2 on tiles
const ed = ednow(window.__t);
host.shell.activate(ed);
const P = await import("./editor/inpaint_pixels.js");
const W = ed.width, H = ed.height;
const base = document.createElement("canvas"); base.width = W; base.height = H;
{
    const x = base.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#305878"); g.addColorStop(1, "#c8a058");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 7; i++) { x.fillStyle = `hsl(${i * 51},60%,50%)`; x.beginPath(); x.arc(700 + i * 1100, 2500 + (i % 2) * 900, 600, 0, Math.PI * 2); x.fill(); }
}
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "objects.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
// a paint layer that covers the left part only (its right part is transparent: the cutout input is black there)
const paint = document.createElement("canvas"); paint.width = 4000; paint.height = 3000;
{ const x = paint.getContext("2d"); x.fillStyle = "#20c060"; x.fillRect(0, 0, 2000, 3000); x.fillStyle = "rgba(220,40,40,0.7)"; x.fillRect(600, 900, 1000, 1200); }
const L = ed.addLayer({ name: "Objects paint", kind: "paint", px: ed.pixels.Layer.fromCanvas(paint), x: 1000, y: 800, w: 4000, h: 3000, dirty: true });
// a masked layer on the document's grid, the left half shown
const M = ed.addPaintLayer();
M.px.drawInto(null, (x) => { x.fillStyle = "#4060e0"; x.fillRect(5200, 600, 2400, 3600); });
M.maskPx = ed.pixels.Mask.empty(W, H);
M.maskPx.fill([0, 0, 6400, H], "#ffffff");
ed.markMaskChanged(M);
ed.markLayerChanged(M);
ed.renderLayers(); ed.fitView(); ed.draw();
await ed.mipsSettled();

// the model stand-in
const calls = [];
const saved = { sam2Model: host.sam2Model, helperCall: host.helperCall };
let segmentFailsOnce = false;
host.sam2Model = () => ({ id: "fake", label: "fake" });
host.helperCall = async (name, a) => {
    // the mirrors alive when the input reaches the model: what reading the input made (the layer mode's clip after the
    // answer, `layerAlpha`, is a full-resolution read of its own and not this step's)
    const t = ed.memoryReport().tiles;
    calls.push({ name, key: a.key, image: a.image ? new Uint8Array(a.image) : null, mirrors: t ? t.mirrors : 0, primed: t ? t.primedBytes : 0 });
    if (name === "objects") return { ids: new Uint16Array(a.outWidth * a.outHeight), width: a.outWidth, height: a.outHeight, count: 0, seconds: 0.01, provider: "fake" };
    if (name === "segment") {
        if (segmentFailsOnce && !a.image) { segmentFailsOnce = false; throw new Error("no embedding for " + a.key); }
        return { mask: new Uint8Array(a.outWidth * a.outHeight), width: a.outWidth, height: a.outHeight, score: 0.5 };
    }
    if (name === "cutout") return { alpha: new Uint8Array(1024 * 1024).fill(255), size: 1024, seconds: 0.01, provider: "fake" };
    throw new Error("unknown helper " + name);
};
const fetch0 = window.fetch;
let uploads = 0;
window.fetch = function (u, ...rest) { if (/upload/.test(String(u && u.url || u))) uploads++; return fetch0.call(this, u, ...rest); };
const counts = { flatten: 0, toCanvas: 0 };
const f0 = ed.flattenToCanvas;
ed.flattenToCanvas = function (...q) { counts.flatten++; return f0.apply(this, q); };
const tc = new Map();
for (const q of [ed.basePx, L.px, M.px, M.maskPx]) { const o = q.toCanvas; tc.set(q, o); q.toCanvas = function (...a) { counts.toCanvas++; return o.apply(this, a); }; }
const unspy = () => { ed.flattenToCanvas = f0; for (const [q, o] of tc) q.toCanvas = o; };
// primed cells a read holds until it releases them; another reader's (the film panel renders 500 ms after a change)
// may hold some for a moment, so a leak is cells that never drain
const primedDrained = async (ed) => { for (let i = 0; i < 60; i++) { const t = ed.memoryReport().tiles; if (!t || !t.primedBytes) return 0; await new Promise((r) => setTimeout(r, 50)); } return ed.memoryReport().tiles.primedBytes; };
const diff = (a, b) => { let max = 0, sum = 0, far = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); sum += d; if (d > max) max = d; if (d > 24) far++; } return { max, mean: +(sum / a.length).toFixed(3), far }; };
const settle = async () => { for (let i = 0; i < 200 && ed.objectsPending; i++) await wait(10); };
const out = { tiles: !!ed.tileMode };
const baseRef0 = ed.uploaded.baseRef;
const seg0 = ed.segSourceSel.value;
try {
    // (1) the image source: no flatten, no whole-layer copy, no mirror, no upload
    ed.objects = null;
    ed.releaseCaches({ mirrors: true, deep: true });
    const c0 = { ...counts };
    await ed.ensureObjects();
    await settle();
    const rep = ed.memoryReport();
    const objCalls = calls.filter((c) => c.name === "objects");
    if (objCalls.length !== 1) throw new Error(`${objCalls.length} object runs, expected 1`);
    if (!ed.objects || !/^image:[0-9a-f]{20}$/.test(ed.objects.hash)) throw new Error("the map is not keyed on the input's hash: " + JSON.stringify(ed.objects && ed.objects.hash));
    if (objCalls[0].key !== `${ed.node.id}:${ed.objects.hash}`) throw new Error("the embedding key is not the map's hash");
    if (objCalls[0].image.length !== 1024 * 1024 * 4) throw new Error("the model input is not 1024 x 1024 RGBA");
    if (uploads) throw new Error(`the in-app object map uploaded ${uploads} files`);
    if (ed.uploaded.baseRef !== baseRef0) throw new Error("the in-app object map replaced the run's base upload");
    out.image = { flatten: counts.flatten - c0.flatten, toCanvas: counts.toCanvas - c0.toCanvas };
    if (ed.tileMode) {
        out.image.mirrors = objCalls[0].mirrors;
        if (out.image.flatten || out.image.toCanvas) throw new Error("the object input flattened or copied a whole layer: " + JSON.stringify(out.image));
        if (objCalls[0].mirrors) throw new Error(`the object input made ${objCalls[0].mirrors} display mirrors`);
        const leftP = await primedDrained(ed);
        if (leftP) throw new Error(`${leftP} bytes of primed cells were left behind`);
    } else if (out.image.flatten !== 1) throw new Error("the canvas backend's object input should be the one flatten it was: " + JSON.stringify(out.image));

    // (2) a second check with nothing changed makes no model call; a visibility round trip reads the same input
    await ed.ensureObjects(); await settle();
    await run("set_layer", { layer: L.id, visible: false, doc: window.__t });
    await run("set_layer", { layer: L.id, visible: true, doc: window.__t });
    const v0 = ed.compositeVersion;
    await ed.ensureObjects(); await settle();
    if (calls.filter((c) => c.name === "objects").length !== 1) throw new Error("an unchanged picture ran the model again");
    if (ed.objects.version !== v0) throw new Error("the map was not stamped with the composite version it was checked at");

    // (3) the hover: 20 moves read nothing; after a write the next one reads once, and a new picture runs the model
    const oi0 = host.objectInput;
    let reads = 0;
    host.objectInput = function (...a) { reads++; return oi0.apply(this, a); };
    try {
        for (let i = 0; i < 20; i++) ed.updateObjectHover(100 + i, 100);
        await settle();
        if (reads) throw new Error(`20 hovers over an unchanged picture read the input ${reads} times`);
        L.px.drawInto(null, (x) => { x.fillStyle = "#ff00ff"; x.fillRect(100, 100, 64, 64); });
        ed.markLayerChanged(L);
        const hash1 = ed.objects.hash;
        for (let i = 0; i < 5; i++) { ed.updateObjectHover(200 + i, 200); await settle(); }
        if (reads !== 1) throw new Error(`hovers after a write read the input ${reads} times, expected 1`);
        if (calls.filter((c) => c.name === "objects").length !== 2) throw new Error("a changed picture did not run the model");
        if (ed.objects.hash === hash1) throw new Error("a changed picture kept the old hash");
    } finally { host.objectInput = oi0; }

    // (4) the picture against the old input (taken after the checks: it makes mirrors on tiles)
    const lastImage = calls.filter((c) => c.name === "objects").pop().image;
    unspy();
    const refImage = host.modelInput(host.sourceCanvas(ed, null), 1024, null);
    out.imageDiff = diff(lastImage, refImage);
    if (!ed.tileMode ? out.imageDiff.max : (out.imageDiff.mean > 2 || out.imageDiff.far > lastImage.length * 0.01)) throw new Error("the object input differs from the old one: " + JSON.stringify(out.imageDiff));

    // (5) the point prompt's re-encode, when the embedding is gone, sends the input the map's hash was taken of
    segmentFailsOnce = true;
    await host.segmentPoint(ed, [{ x: 3000, y: 2000, label: 1 }], null);
    const seg = calls.filter((c) => c.name === "segment");
    if (seg.length !== 2 || !seg[1].image) throw new Error("the re-encode did not send an image: " + seg.length);
    if (seg[1].key !== `${ed.node.id}:${ed.objects.hash}`) throw new Error("the re-encode used another key");
    const sd = diff(seg[1].image, lastImage);
    if (sd.max) throw new Error("the re-encode's input is not the map's: " + JSON.stringify(sd));

    // (6) the layer source: the masked layer on grey
    ed.releaseCaches({ mirrors: true, deep: true });
    ed.segSourceSel.value = "active layer";
    ed.activeLayerId = M.id;
    for (const [q] of tc) { const o = tc.get(q); q.toCanvas = function (...a) { counts.toCanvas++; return o.apply(this, a); }; }
    ed.flattenToCanvas = function (...q) { counts.flatten++; return f0.apply(this, q); };
    const c1 = { ...counts };
    await ed.ensureObjects(); await settle();
    const rep2 = ed.memoryReport();
    const layerCall = calls.filter((c) => c.name === "objects").pop();
    if (!ed.objects || ed.objects.layerId !== M.id || !ed.objects.hash.startsWith(`layer:${M.id}:`)) throw new Error("the layer source's map is not the layer's: " + JSON.stringify(ed.objects && ed.objects.hash));
    out.layer = { flatten: counts.flatten - c1.flatten, toCanvas: counts.toCanvas - c1.toCanvas };
    if (ed.tileMode) {
        out.layer.mirrors = layerCall.mirrors;
        if (layerCall.mirrors) out.layer.owners = [["base", ed.basePx], ["sel", ed.sel], ["paint", L.px], ["masked", M.px], ["mask", M.maskPx]].filter(([, q]) => q && P.displayCanvasIfMade(q)).map(([n]) => n);
        if (out.layer.flatten || out.layer.toCanvas || layerCall.mirrors) throw new Error("the layer source copied or mirrored: " + JSON.stringify(out.layer));
        const leftL = await primedDrained(ed);
        if (leftL) throw new Error(`${leftL} bytes of primed cells were left behind by the layer input`);
        out.layer.afterClip = rep2.tiles.mirrors;   // layerAlpha's full-resolution clip, bigger change C
    }
    unspy();
    out.layerDiff = diff(layerCall.image, host.modelInput(host.sourceCanvas(ed, M), 1024, null));
    if (!ed.tileMode ? out.layerDiff.max : (out.layerDiff.mean > 2 || out.layerDiff.far > layerCall.image.length * 0.01)) throw new Error("the layer source differs from the old one: " + JSON.stringify(out.layerDiff));

    // (7) the cutout input: the paint layer's own pixels on black, the transparent half black
    ed.releaseCaches({ mirrors: true, deep: true });
    const o = tc.get(L.px);
    let lc = 0;
    L.px.toCanvas = function (...a) { lc++; return o.apply(this, a); };
    const cut = await host.cutoutInput(ed, L);
    L.px.toCanvas = o;
    if (ed.tileMode && lc) throw new Error("the cutout input copied the whole layer");
    let blackMax = 0;
    for (let y = 0; y < 1024; y += 7) for (let x = 560; x < 1024; x += 7) { const i = (y * 1024 + x) * 4; blackMax = Math.max(blackMax, cut[i], cut[i + 1], cut[i + 2]); }
    if (blackMax > 8) throw new Error("the cutout input's transparent half is not black: " + blackMax);
    out.cutoutDiff = diff(cut, host.modelInput(L.px.toCanvas(), 1024, "#000000"));
    if (!ed.tileMode ? out.cutoutDiff.max : (out.cutoutDiff.mean > 2 || out.cutoutDiff.far > cut.length * 0.01)) throw new Error("the cutout input differs from the old one: " + JSON.stringify(out.cutoutDiff));
    out.cutoutToCanvas = lc;
} finally {
    unspy();
    window.fetch = fetch0;
    host.sam2Model = saved.sam2Model;
    host.helperCall = saved.helperCall;
    ed.segSourceSel.value = seg0;
    ed.objects = null;
}
await run("remove_layer", { layer: M.id, doc: window.__t });
await run("remove_layer", { layer: L.id, doc: window.__t });
return out;
"""),
    ("sampled_passes_share_the_colour_match_statistics", """
// C6 (c) slice 7a: the colour-match statistics a sampled pass used were those of whichever pass missed first after
// a drop. The eyedropper's 1 x 1 pass, or a fine box of the wand, finds fewer than 64 pixels of the layer's
// surroundings in its own region and stored null: every sampled pass after it drew the matched layer unmatched until
// the composite changed. A drop between the wand's coarse and fine pass (a chain landing) made the wand select a
// different region. Sampled passes now share one entry per layer per change, taken from the layer's whole padded
// surroundings, whatever pass asks first. Both backends.
await run("new_canvas", { width: 3000, height: 2000, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const W = ed.width, H = ed.height;
const base = document.createElement("canvas"); base.width = W; base.height = H;
{
    const x = base.getContext("2d");
    x.fillStyle = "#6a6a70"; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 3000; i++) { const v = 90 + ((i * 37) % 40); x.fillStyle = `rgb(${v},${v},${v + 6})`; x.fillRect((i * 733) % W, (i * 419) % H, 12, 12); }
    x.fillStyle = "#203060"; x.fillRect(2500, 0, W - 2500, H);   // a dark right part, for (iv)
}
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "match7a.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
// an empty paint layer under the matched one, painted in (iv)
const P7 = ed.addPaintLayer();
// a strongly coloured layer: unmatched it is far from the grey around it, matched it is close to it
const lc = document.createElement("canvas"); lc.width = 1200; lc.height = 900;
{
    const x = lc.getContext("2d");
    x.fillStyle = "#c83c3c"; x.fillRect(0, 0, 1200, 900);
    for (let i = 0; i < 600; i++) { x.fillStyle = (i % 2) ? "#b43232" : "#dc4646"; x.fillRect((i * 331) % 1200, (i * 197) % 900, 10, 10); }
}
const L = ed.addLayer({ name: "Matched 7a", kind: "result", px: ed.pixels.Layer.fromCanvas(lc), x: 900, y: 600, w: 1200, h: 900, dirty: true });
L.match = { strength: 100, source: "surroundings" };
ed.markMatchChanged(L);
ed.renderLayers(); ed.fitView(); ed.sceneSig = null; ed.draw();
await ed.mipsSettled(); ed.sceneSig = null; ed.draw();
await wait(50);

const drop = () => {
    // what a chain landing (watchChains) or a change does to the caches, without a frame in between
    for (const k of Object.keys(L)) if (/^_mstats|^_mcache/.test(k)) L[k] = null;
};
const pixelOf = (c, x, y) => Array.from(c.getContext("2d").getImageData(x, y, 1, 1).data);
const far = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const out = { tiles: !!ed.tileMode };
const px = 1500, py = 1050;   // inside the layer
const unmatched = pixelOf(lc, px - L.x, py - L.y);

// (i) the eyedropper first after a drop, then a picture of the whole image at 512 px. The eyedropper samples what the
// tool bar's Sample says: the image here (a step before may have left it on the layer)
const fill0 = ed.fillOpts;
out.fillOptsBefore = fill0 || null;
ed.fillOpts = { tolerance: 40, contiguous: true, sample: "image" };
let pickedRgb = null;
try {
drop();
const color0 = ed.color;
ed.pickColor(px, py);
const picked = ed.color;
ed.color = color0;
const s = 512 / W;
const afterPick = ed.sampleRegion("image", [0, 0, W, H], s);
// (ii) the same picture first after a drop
drop();
const alone = ed.sampleRegion("image", [0, 0, W, H], s);
const qx = Math.floor(px * s), qy = Math.floor(py * s);
out.pixel = { unmatched, afterPick: pixelOf(afterPick, qx, qy), alone: pixelOf(alone, qx, qy) };
if (far(out.pixel.alone, unmatched) < 40) throw new Error("the match does not move this layer's colour, so this step proves nothing: " + JSON.stringify(out.pixel));
const da = afterPick.getContext("2d").getImageData(0, 0, afterPick.width, afterPick.height).data;
const db = alone.getContext("2d").getImageData(0, 0, alone.width, alone.height).data;
let worst = 0, differing = 0;
for (let i = 0; i < da.length; i++) { const d = Math.abs(da[i] - db[i]); if (d) { differing++; if (d > worst) worst = d; } }
out.afterPickVsAlone = [worst, differing];
if (worst > 1) throw new Error(`a 512 px picture after an eyedropper click differs from the same picture alone by ${worst} levels on ${differing} bytes (the click set the statistics)`);
pickedRgb = [parseInt(picked.slice(1, 3), 16), parseInt(picked.slice(3, 5), 16), parseInt(picked.slice(5, 7), 16)];
const flat = ed.flattenToCanvas({ forRun: false });
const ref = pixelOf(flat, px, py);
out.picked = { picked: pickedRgb, flatten: ref };
if (far(pickedRgb, unmatched) < 30 && far(ref, unmatched) >= 40) throw new Error("the eyedropper picked the layer's unmatched colour: " + JSON.stringify(out.picked));
if (far(pickedRgb, ref) > 12) throw new Error("the eyedropper's colour is far from the matched flatten's: " + JSON.stringify(out.picked));

// (iii) the wand with a drop between its coarse and its fine pass selects what it selects without one
const wandBounds = async (dropBetween) => {
    await run("select_none", { doc: window.__t });
    drop();
    ed.sceneSig = null; ed.draw();
    const f0 = ed.floodShape;
    let n = 0;
    ed.floodShape = async function (...a) { const r = await f0.apply(this, a); if (n++ === 0 && dropBetween) drop(); return r; };
    try { await ed.wandSelect(px, py, "replace"); } finally { ed.floodShape = f0; }
    return { bounds: ed.getBounds(), passes: n };
};
try {
    // B item 7 part 3: the wand on a matched document goes over tiles now (no sampled pass, no `floodShape`); this step is
    // about the canvases' sampled passes sharing the statistics, so it runs them
    ed.constructor.stacks = false;
    const plain = await wandBounds(false);
    const dropped = await wandBounds(true);
    out.wand = { plain, dropped };
    if (plain.passes < 2) throw new Error("the wand ran no fine pass on this document: " + JSON.stringify(out.wand));
    if (JSON.stringify(plain.bounds) !== JSON.stringify(dropped.bounds)) throw new Error("a statistics drop between the wand's passes changed its selection: " + JSON.stringify(out.wand));
} finally {
    ed.constructor.stacks = true;
    await run("select_none", { doc: window.__t });
}
} finally {
    ed.fillOpts = fill0;
}
// (iv) the entry follows a change that leaves the layer's own caches alone: a paint layer below it painted dark over
// the right part of its surroundings (the composite version moves, the slots stay)
{
    ed.fillOpts = { tolerance: 40, contiguous: true, sample: "image" };
    const pc = ed.color;
    ed.pickColor(px, py);   // the entry is made (and would be kept by a cache that does not look at the version)
    ed.color = pc;
    P7.px.drawInto(null, (x) => { x.fillStyle = "#101828"; x.fillRect(1500, 400, 900, 1300); });
    ed.markLayerChanged(P7);
    const c4 = ed.color;
    ed.pickColor(px, py);
    const p4 = ed.color;
    ed.color = c4;
    ed.fillOpts = fill0;
    const rgb4 = [parseInt(p4.slice(1, 3), 16), parseInt(p4.slice(3, 5), 16), parseInt(p4.slice(5, 7), 16)];
    const ref4 = pixelOf(ed.flattenToCanvas({ forRun: false }), px, py);
    out.changed = { picked: rgb4, flatten: ref4, before: pickedRgb };
    if (far(ref4, pickedRgb) < 12) throw new Error("the paint below did not change the layer's matched colour, so (iv) proves nothing: " + JSON.stringify(out.changed));
    if (far(rgb4, ref4) > 12) throw new Error("after a change below the layer the eyedropper's colour is far from the matched flatten's (stale statistics): " + JSON.stringify(out.changed));
}
await run("remove_layer", { layer: P7.id, doc: window.__t });
await run("remove_layer", { layer: L.id, doc: window.__t });
return out;
"""),
    ("a_colour_matched_layer_draws_from_its_own_tiles", """
// C6 (c) slice 7b: a colour-matched layer in a region pass (the screen on both paths, the navigator, a sampled pass) was
// matched on its whole display mirror, or the Skia pyramid level of it the pass drew: a 572 MB mirror and a 197 MB
// pyramid for a full-size layer at 15000 x 10000, `_masked` and two more mirrors for a masked one. On tiles it is
// matched now in the part the pass shows, from its tiles and its mask at the pass's level. The reference is the old
// path (`matchFromTiles` off) with the same statistics object. Tile assertions on tiles only; the pictures on both.
await run("new_canvas", { width: 4100, height: 2900, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const P = await import("./editor/inpaint_pixels.js");
const W = ed.width, H = ed.height;
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const base = mk(W, H);
{
    const x = base.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#405878"); g.addColorStop(1, "#b89060");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 40; i++) { x.fillStyle = `hsl(${(i * 47) % 360},40%,${35 + (i * 13) % 30}%)`; x.fillRect((i * 733) % W, (i * 419) % H, 180, 140); }
}
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "match7b.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
// a full-size matched layer with a mask on its grid (the part right of 2700 hidden)
const fc = mk(W, H);
{
    const x = fc.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, 0); g.addColorStop(0, "#30b050"); g.addColorStop(1, "#b03090");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 30; i++) { x.fillStyle = `hsl(${(i * 71) % 360},70%,50%)`; x.fillRect((i * 331) % W, (i * 197) % H, 220, 160); }
}
const F = ed.addLayer({ name: "Matched full", kind: "result", px: ed.pixels.Layer.fromCanvas(fc), x: 0, y: 0, w: W, h: H, dirty: true });
F.maskPx = ed.pixels.Mask.empty(W, H);
F.maskPx.fill([0, 0, 2700, H], "#ffffff");
ed.markMaskChanged(F);
F.match = { strength: 80, source: "underneath" };
// a small matched result, drawn scaled, whose levels end inside a pixel (1401 / 8 = 175.125: at fit, on a window 1865 px
// wide, it is drawn at level 3, and a draw of the whole last pixel would reach 0.7 screen pixels past its edge)
const sc = mk(1401, 1019);
{
    const x = sc.getContext("2d");
    const g = x.createLinearGradient(0, 0, 1401, 1019); g.addColorStop(0, "#e04030"); g.addColorStop(1, "#f0c020");
    x.fillStyle = g; x.fillRect(0, 0, 1401, 1019);
    for (let i = 0; i < 60; i++) { x.fillStyle = (i % 2) ? "#a02020" : "#f06040"; x.fillRect((i * 331) % 1401, (i * 197) % 1019, 60, 60); }
    x.fillStyle = "#ffffff"; x.fillRect(1401 - 48, 0, 48, 1019);   // a white last column: it stays bright through the match, so a draw past the edge shows
}
const S = ed.addLayer({ name: "Matched small", kind: "result", px: ed.pixels.Layer.fromCanvas(sc), x: 517, y: 389, w: 353, h: 257, dirty: true });
S.match = { strength: 100, source: "surroundings" };
for (const l of [F, S]) ed.markMatchChanged(l);
await run("select_none", { doc: window.__t });
ed.setTool("rect"); ed.hover = null;
ed.renderLayers(); ed.fitView();
ed.releaseCaches({ mirrors: true, deep: true });
const out = { tiles: !!ed.tileMode, gl: !!ed.glCompositeUsable({}) };
const tileCheck = (where) => {
    if (!ed.tileMode) return;
    const t = ed.memoryReport().tiles;
    const m = { mirrors: t ? t.mirrors : null, F: !!P.displayCanvasIfMade(F.px), Fmask: !!P.displayCanvasIfMade(F.maskPx), S: !!P.displayCanvasIfMade(S.px), masked: !!F._masked };
    if (m.mirrors || m.F || m.Fmask || m.S || m.masked) throw new Error(where + ": a display mirror of a matched layer was made: " + JSON.stringify(m));
};
const screen = async () => {
    ed.sceneSig = null; ed.draw(); await ed.mipsSettled(); await wait(60);
    ed.sceneSig = null; ed.draw();
    return ed.canvas.getContext("2d").getImageData(0, 0, ed.canvas.width, ed.canvas.height).data;
};
// the old path with the statistics the new one made (the slot is kept): only the matched pixels are made again
const oldScreen = async () => {
    const f0 = ed.matchFromTiles;
    ed.matchFromTiles = () => false;
    for (const l of [F, S]) l._mcacheView = null;
    try { return await screen(); } finally {
        ed.matchFromTiles = f0;
        for (const l of [F, S]) l._mcacheView = null;
        ed.releaseCaches({ mirrors: true });
        for (const l of [F, S]) { l._masked = null; l._maskedValid = false; }
    }
};
const diff = (a, b) => { let max = 0, o3 = 0, o8 = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; if (d > 3) o3++; if (d > 8) o8++; } return { max, o3, o8, of: a.length }; };
// the screen's columns at S's right edge and rows at its bottom edge, and past them: the layer ends there on either path
const edgeStrip = (px) => {
    const [ex, ey] = ed.imageToScreen(S.x + S.w, S.y + S.h).map(Math.floor);
    const [x0, y0] = ed.imageToScreen(S.x + S.w * 0.25, S.y + S.h * 0.25).map(Math.round);
    const cw = ed.canvas.width, rows = [];
    for (let y = y0; y < ey - 2; y++) for (let x = ex; x <= ex + 2; x++) { const i = (y * cw + x) * 4; rows.push(px[i], px[i + 1], px[i + 2]); }
    for (let x = x0; x < ex - 2; x++) for (let y = ey; y <= ey + 2; y++) { const i = (y * cw + x) * 4; rows.push(px[i], px[i + 1], px[i + 2]); }
    return rows;
};
// "fit": a fixed 0.4, whatever the window's size (the small layer at level 3, 1401 / 8 = 175.125). Its right and bottom
// edges fall a tenth into a screen pixel: the GPU rasterises a quad by pixel centres, so a quad drawn 0.7 px past the edge
// covers the next centre only from there
const zoomOut = () => {
    ed.view.angle = 0; ed.view.scale = 0.4; ed._fitted = false;
    ed.view.x = -(S.x + S.w) * 0.4 + Math.round(ed.canvas.width * 0.3) + 0.1;
    ed.view.y = -(S.y + S.h) * 0.4 + Math.round(ed.canvas.height * 0.6) + 0.1;
};
const compOff0 = ed.compositorOff;
const fitShots = {};
try {
    for (const path of ed.glCompositeUsable({}) ? ["gl", "2d"] : ["2d"]) {
        ed.compositorOff = path === "2d";
        // zoomed out (the tile check calls it "fit")
        zoomOut();
        const a = await screen();
        fitShots[path] = edgeStrip(a);
        tileCheck(path + " fit");
        if (!(F._mstatsSample && F._mstatsSample.stats) || !(S._mstatsSample && S._mstatsSample.stats)) throw new Error(path + ": the screen made no statistics for the matched layers");
        const b = await oldScreen();
        const d = diff(a, b), e = diff(edgeStrip(a), edgeStrip(b));
        // the floor: the screen with the match off differs from the matched screen
        const m0 = ed.matchActive;
        ed.matchActive = () => false;
        let u;
        try { u = diff(a, await screen()); } finally { ed.matchActive = m0; }
        out[path + "Fit"] = { vsOld: d, edge: e, vsUnmatched: u.max };
        if (u.max < 20) throw new Error(path + ": the match does not move the colours on the screen, so this step proves nothing: " + JSON.stringify(out[path + "Fit"]));
        // Skia's pyramid against the tiles' box-filtered mips: a few levels at the blocks' edges
        if (d.o8 > d.of * 0.005) throw new Error(`${path} zoomed out: the matched layers differ from the old path on ${d.o8} bytes by more than 8 levels (max ${d.max})`);
        if (e.max > 24) throw new Error(`${path} zoomed out: at the small layer's right and bottom edges the screen differs from the old path by ${e.max} levels (drawn past the layer's edge?)`);
        // at 1:1 over the small layer's right edge and the full layer's mask edge
        ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false;
        // the view's top at image row 400, so the region canvas is not clamped at the image's top and a pan by three tiles keeps its size
        ed.view.x = -(S.x + S.w) + ed.canvas.width * 0.3; ed.view.y = -400;
        const a1 = await screen();
        tileCheck(path + " 1:1");
        const b1 = await oldScreen();
        const d1 = diff(a1, b1), e1 = diff(edgeStrip(a1), edgeStrip(b1));
        out[path + "One"] = { vsOld: d1, edge: e1 };
        // the full layer is drawn unscaled here, the small one at level 1 against Skia's pyramid: its blocks' edges
        if (d1.o8 > d1.of * 0.005) throw new Error(`${path} at 1:1: the matched layers differ from the old path on ${d1.o8} bytes by more than 8 levels (max ${d1.max})`);
        // a pan past the region canvas's margin that keeps its size (a key without the origin would hit): the kept match must
        // not be drawn for the new region
        await screen();
        const tilesOf = () => { const r = ed.viewportRegion(); return [Math.max(0, Math.floor(r.y / 256) - 1), Math.min((H - 1) >> 8, Math.floor((r.y + r.h - 1) / 256) + 1)]; };
        const t0 = tilesOf();
        ed.view.y -= 768;
        const t1 = tilesOf();
        if (t1[0] <= t0[0] || t1[1] <= t0[1] || t1[1] - t1[0] !== t0[1] - t0[0]) throw new Error(path + ": the pan does not move the region canvas by whole tiles at the same size, so it proves nothing: " + JSON.stringify([t0, t1]));
        const p1 = await screen();
        for (const l of [F, S]) l._mcacheView = null;
        const p2 = await screen();
        const dp = diff(p1, p2);
        out[path + "Pan"] = { vsFresh: dp };
        if (dp.max > 1) throw new Error(`${path}: after a pan the screen differs from the same view with the match made again by ${dp.max} levels on ${dp.o3} bytes over 3`);
        tileCheck(path + " pan");
        // a change under the small layer (the full layer's mask hides its left part): new statistics, so matched again. In
        // the last pass only, so both passes above compare the same picture
        if (path === "2d") {
            zoomOut();
            await screen();
            F.maskPx.drawInto(null, (x) => { x.clearRect(0, 0, 1600, H); });
            ed.markMaskChanged(F);
            const c1 = await screen();
            for (const l of [F, S]) l._mcacheView = null;
            const c2 = await screen();
            const dc = diff(c1, c2);
            out.changeBelow = { vsFresh: dc };
            if (dc.max > 1) throw new Error(`after a change under the matched layer the screen differs from the match made again by ${dc.max} levels on ${dc.o3} bytes over 3 (a match of the old statistics kept)`);
            // a flip of the small layer: its first frames read coarse levels until its chains land, and the landing makes its
            // statistics and its match again (they are read from its own levels now)
            await run("flip_layer", { layer: S.id, doc: window.__t });
            ed.sceneSig = null; ed.draw();
            const f1 = await screen();
            for (const l of [F, S]) { l._mcacheView = null; l._mstatsSample = null; }
            const f2 = await screen();
            const df = diff(f1, f2);
            out.flip = { vsFresh: df };
            // What this catches is the tile engine's provisional statistics (made from coarse levels while chains are in the
            // worker) kept after the chains landed: 2 levels here, so on tiles the bound stays 1 (a mutation that keeps them
            // is red at 1 and green at 2, measured 2026-09-21). The canvas backend has no provisional entry, and with the
            // 320 px panel of 0.1.23 two fresh matches of the same state differ by 2 levels on 12,402 of 8.7 M bytes there,
            // the settled screen by 2 on 61: its bound is 2.
            const flipBound = ed.tileMode ? 1 : 2;
            if (df.max > flipBound) throw new Error(`after a flip of the matched layer settled, the screen differs from its statistics and match made again by ${df.max} levels on ${df.o3} bytes over 3 (statistics of the coarse picture kept)`);
        }
    }
    if (fitShots.gl) {
        const g = diff(fitShots.gl, fitShots["2d"]);
        out.glVs2dEdge = g;
    }
} finally {
    ed.compositorOff = compOff0;
    ed.fitView(); ed.sceneSig = null; ed.draw();
}
// sampled passes: the eyedropper, a 512 px picture (the film panel's kind), the wand
const fill0 = ed.fillOpts;
try {
    ed.fillOpts = { tolerance: 30, contiguous: true, sample: "image" };
    for (const l of [F, S]) { l._mcacheSample = null; }
    const c0 = ed.color;
    ed.pickColor(900, 700);
    ed.color = c0;
    tileCheck("eyedropper");
    const s = 512 / W;
    const pic = ed.sampleRegion("image", [0, 0, W, H], s);
    tileCheck("512 px picture");
    const f0 = ed.matchFromTiles;
    ed.matchFromTiles = () => false;
    let picOld;
    try { for (const l of [F, S]) l._mcacheSample = null; picOld = ed.sampleRegion("image", [0, 0, W, H], s); }
    finally { ed.matchFromTiles = f0; for (const l of [F, S]) { l._mcacheSample = null; l._masked = null; l._maskedValid = false; } ed.releaseCaches({ mirrors: true }); }
    const read = (c) => c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const dq = diff(read(pic), read(picOld));
    out.picture = { vsOld: dq };
    if (dq.o8 > dq.of * 0.005) throw new Error(`a 512 px picture differs from the old path on ${dq.o8} bytes by more than 8 levels (max ${dq.max})`);
    // a block of the small layer (its first, 60 source pixels a side, 15 image pixels): the wand's coarse pass and its fine boxes, not a
    // region that covers most of the picture (that one reads the full-resolution flatten, phase E's)
    ed.fillOpts = { tolerance: 6, contiguous: true, sample: "image" };
    await ed.wandSelect(S.x + 6, S.y + 6, "replace");
    out.wand = ed.getBounds();
    const wb = out.wand;
    if (!wb || wb[2] - wb[0] > 400 || wb[3] - wb[1] > 400) throw new Error("the wand did not select a small region, so its boxes were not tested: " + JSON.stringify(wb));
    tileCheck("wand");
} finally {
    ed.fillOpts = fill0;
    await run("select_none", { doc: window.__t });
}
await run("remove_layer", { layer: S.id, doc: window.__t });
await run("remove_layer", { layer: F.id, doc: window.__t });
return out;
"""),
    ("colour_match_statistics_are_one_entry_for_every_pass", """
// C6 (c) slice 7c: the screen took a colour-matched layer's statistics from whatever the view showed when it missed, a
// sampled pass from the layer's whole surroundings (7a): the screen, the navigator and the eyedropper disagreed by a few
// levels, and the screen's colours depended on where the view was after a change. Every region pass takes one entry per
// layer per change now. The screen reads display levels for it; an entry read while chains are on their way is
// provisional, goes when they have landed, and an exact reader makes it again at once. Both backends; (ii) and (iii) on
// tiles with a worker.
await run("new_canvas", { width: 4000, height: 3000, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const T = await import("./editor/inpaint_tiles.js");
const W = ed.width, H = ed.height;
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const base = mk(W, H);
{
    const x = base.getContext("2d");
    x.fillStyle = "#708090"; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 300; i++) { x.fillStyle = `hsl(${(i * 29) % 360},30%,${40 + (i * 7) % 30}%)`; x.fillRect((i * 733) % W, (i * 419) % H, 90, 70); }
}
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "match7c.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
// a full-size paint layer under the matched one: fine bright and dark stripes on its left half (a coarse picture of them,
// a sample per block, is not their mean), dark on its right, so a flip changes the backdrop
const pc = mk(W, H);
{
    const x = pc.getContext("2d");
    x.fillStyle = "rgba(20,30,70,0.8)"; x.fillRect(0, 0, W, H);
    x.fillStyle = "rgba(240,220,120,0.9)"; for (let sx = 0; sx < W / 2; sx += 5) x.fillRect(sx, 0, 2, H);
}
const P = ed.addLayer({ name: "Under", kind: "paint", px: ed.pixels.Layer.fromCanvas(pc), x: 0, y: 0, w: W, h: H, dirty: true });
const lc = mk(1600, 1200);
{ const x = lc.getContext("2d"); x.fillStyle = "#c83c3c"; x.fillRect(0, 0, 1600, 1200); for (let i = 0; i < 400; i++) { x.fillStyle = (i % 2) ? "#b43232" : "#e05050"; x.fillRect((i * 331) % 1600, (i * 197) % 1200, 30, 30); } }
const L = ed.addLayer({ name: "Matched 7c", kind: "result", px: ed.pixels.Layer.fromCanvas(lc), x: 1200, y: 900, w: 1600, h: 1200, dirty: true });
L.match = { strength: 100, source: "surroundings" };
ed.markMatchChanged(L);
await run("select_none", { doc: window.__t });
ed.setTool("rect"); ed.hover = null;
ed.renderLayers(); ed.fitView();
const settle = async () => { ed.sceneSig = null; ed.draw(); await ed.mipsSettled(); await wait(80); ed.sceneSig = null; ed.draw(); };
await settle();
const out = { tiles: !!ed.tileMode, async: !!(ed.tileMode && T.chainStats().async) };
const same = (a, b) => !!a && !!b && ["meanS", "meanT", "scale"].every((k) => a[k].every((v, i) => Math.abs(v - b[k][i]) < 1e-9));

// (i) one entry: the screen at fit, a pan, 1:1, the navigator's thumbnail, the eyedropper, a 512 px picture, the wand
const e0 = L._mstatsSample;
if (!(e0 && e0.stats)) throw new Error("the screen made no statistics entry for the matched layer");
let made = 0;
const f0 = ed.sampledMatchStats;
ed.sampledMatchStats = function (layer, ...a) { const was = layer._mstatsSample; try { return f0.call(this, layer, ...a); } finally { if (layer === L && layer._mstatsSample !== was) made++; } };
const fill0 = ed.fillOpts;
try {
    ed.view.x += 137; ed.view.y -= 61; ed.sceneSig = null; ed.draw();
    ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false;
    ed.view.x = -(L.x + 400) + ed.canvas.width / 2; ed.view.y = -(L.y + 300) + ed.canvas.height / 2;
    await settle();
    ed.drawThumb();
    ed.fillOpts = { tolerance: 20, contiguous: true, sample: "image" };
    const c0 = ed.color; ed.pickColor(L.x + 200, L.y + 200); ed.color = c0;
    ed.sampleRegion("image", [0, 0, W, H], 512 / W);
    await ed.wandSelect(L.x + 205, L.y + 205, "replace");
    await run("select_none", { doc: window.__t });
    // ten ticks of the layer's own strength slider: its statistics do not depend on it
    for (let i = 0; i < 10; i++) { L.match = { ...L.match, strength: 50 + i * 5 }; ed.markMatchChanged(L); ed.sceneSig = null; ed.draw(); }
    L.match = { ...L.match, strength: 100 }; ed.markMatchChanged(L); ed.sceneSig = null; ed.draw();
} finally {
    ed.sampledMatchStats = f0;
    ed.fillOpts = fill0;
}
out.one = { made, kept: L._mstatsSample === e0 };
if (made || L._mstatsSample !== e0) throw new Error("the statistics were taken again without a change: " + JSON.stringify(out.one));

// (ii) a whole change under the layer (a flip of the paint layer): at fit the screen's entry is provisional while the flip's
// chains are in the worker; once they have landed the entry is the one exact levels give, and so is the screen
const exactStats = () => { const keep = L._mstatsSample; L._mstatsSample = null; try { return ed.sampledMatchStats(L, false, false); } finally { L._mstatsSample = keep; } };
if (out.async) {
    ed.fitView(); await settle();
    await run("flip_layer", { layer: P.id, doc: window.__t });
    ed.sceneSig = null; ed.draw();
    const first = L._mstatsSample;
    out.provisional = !!(first && first.provisional);
    if (!out.provisional) throw new Error("the screen's statistics right after a whole change under the layer are not provisional (the chains are in the worker)");
    await ed.mipsSettled(); await wait(120); ed.sceneSig = null; ed.draw();
    const settled = L._mstatsSample;
    if (!settled || settled.provisional || settled === first) throw new Error("the provisional statistics were not made again after the chains landed: " + JSON.stringify({ same: settled === first, provisional: settled && settled.provisional }));
    const ex = exactStats();
    out.settledIsExact = same(settled.stats, ex);
    if (!out.settledIsExact) throw new Error("the statistics made after the landing are not the exact ones: " + JSON.stringify({ settled: settled.stats, exact: ex }));
    out.firstWasOff = !same(first.stats, ex);
    if (!out.firstWasOff) throw new Error("the provisional statistics were already the exact ones, so (ii) proves nothing");
    // the screen with that entry against the screen with it made again
    const g = ed.canvas.getContext("2d"), read = () => g.getImageData(0, 0, ed.canvas.width, ed.canvas.height).data;
    const a = read();
    L._mstatsSample = null; L._mcacheView = null;
    ed.sceneSig = null; ed.draw();
    const b = read();
    let max = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; }
    out.screenVsFresh = max;
    if (max > 1) throw new Error("after the landing the screen differs from the same view with the statistics made again by " + max + " levels");

    // (iii) an exact reader right after another whole change takes exact statistics at once
    await run("flip_layer", { layer: P.id, doc: window.__t });
    ed.sceneSig = null; ed.draw();
    if (!(L._mstatsSample && L._mstatsSample.provisional)) throw new Error("the second flip left no provisional entry, so (iii) proves nothing");
    ed.fillOpts = { tolerance: 20, contiguous: true, sample: "image" };
    const c1 = ed.color; ed.pickColor(L.x + 200, L.y + 200); ed.color = c1;
    ed.fillOpts = fill0;
    const byPick = L._mstatsSample;
    if (!byPick || byPick.provisional) throw new Error("the eyedropper kept the provisional statistics");
    await ed.mipsSettled(); await wait(120);
    out.pickIsExact = same(byPick.stats, exactStats());
    if (!out.pickIsExact) throw new Error("the eyedropper's statistics are not the exact ones");
}
await run("remove_layer", { layer: L.id, doc: window.__t });
await run("remove_layer", { layer: P.id, doc: window.__t });
return out;
"""),
    ("the_colour_match_on_the_gpu_stack_is_uniforms", """
// C6 (c) slice 7d: on the GPU stack a colour-matched layer on tiles was a canvas per change of its match (7b: its region
// canvas matched and uploaded as a texture; before, its whole display mirror). The atlas draws the layer's own tiles and
// its shader applies the match: a strength tick is a uniform. The picture is the Canvas 2D path's (matchCanvas on each
// byte) up to interpolation. Tiles with a GPU compositor only.
await run("new_canvas", { width: 4100, height: 2900, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
if (!ed.tileMode || !ed.glCompositeUsable({})) return { skipped: "tiles with a GPU compositor only", tiles: !!ed.tileMode };
const W = ed.width, H = ed.height;
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const base = mk(W, H);
{
    const x = base.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#3a5070"); g.addColorStop(1, "#c09868");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 50; i++) { x.fillStyle = `hsl(${(i * 47) % 360},40%,${35 + (i * 13) % 30}%)`; x.fillRect((i * 733) % W, (i * 419) % H, 160, 120); }
}
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "match7d.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
// a matched layer drawn scaled, with a soft mask on its grid, at 60 %: the strength and the mask both matter
const lc = mk(1401, 1019);
{
    const x = lc.getContext("2d");
    const g = x.createLinearGradient(0, 0, 1401, 1019); g.addColorStop(0, "#20c040"); g.addColorStop(1, "#c02080");
    x.fillStyle = g; x.fillRect(0, 0, 1401, 1019);
    for (let i = 0; i < 80; i++) { x.fillStyle = `hsl(${(i * 71) % 360},80%,50%)`; x.fillRect((i * 331) % 1401, (i * 197) % 1019, 50, 50); }
}
const L = ed.addLayer({ name: "Matched 7d", kind: "result", px: ed.pixels.Layer.fromCanvas(lc), x: 900, y: 700, w: 1868, h: 1359, dirty: true });
L.maskPx = ed.pixels.Mask.empty(1401, 1019);
L.maskPx.drawInto(null, (x) => { const g = x.createRadialGradient(700, 510, 200, 700, 510, 640); g.addColorStop(0, "#ffffff"); g.addColorStop(1, "rgba(255,255,255,0)"); x.fillStyle = g; x.fillRect(0, 0, 1401, 1019); });
ed.markMaskChanged(L);
L.match = { strength: 60, source: "surroundings" };
ed.markMatchChanged(L);
await run("select_none", { doc: window.__t });
ed.setTool("rect"); ed.hover = null;
ed.renderLayers();
const g2 = ed.canvas.getContext("2d");
const read = () => g2.getImageData(0, 0, ed.canvas.width, ed.canvas.height).data;
const screen = async () => { ed.sceneSig = null; ed.draw(); await ed.mipsSettled(); await wait(60); ed.sceneSig = null; ed.draw(); return read(); };
// inside the layer's rectangle, 3 screen pixels in from its edges: at the image's own border the GPU stack and Canvas 2D
// differ with no match at all (255 levels on about 8,700 bytes at 0.4, measured), which is not this step's
const diff = (a, b) => {
    const cw = ed.canvas.width, ch = ed.canvas.height;
    const [x0, y0] = ed.imageToScreen(L.x, L.y), [x1, y1] = ed.imageToScreen(L.x + L.w, L.y + L.h);
    const ax = Math.max(0, Math.ceil(x0) + 3), ay = Math.max(0, Math.ceil(y0) + 3), bx = Math.min(cw, Math.floor(x1) - 3), by = Math.min(ch, Math.floor(y1) - 3);
    let max = 0, o2 = 0, o8 = 0, n = 0;
    for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) for (let k = 0; k < 3; k++) { const i = (y * cw + x) * 4 + k; const d = Math.abs(a[i] - b[i]); n++; if (d > max) max = d; if (d > 2) o2++; if (d > 8) o8++; }
    return { max, o2, o8, of: n };
};
const out = {};
const comp0 = ed.compositorOff;
try {
    for (const [name, view] of [["zoomed", () => { ed.view.angle = 0; ed.view.scale = 0.4; ed._fitted = false; ed.view.x = -(L.x + L.w / 2) * 0.4 + ed.canvas.width / 2; ed.view.y = -(L.y + L.h / 2) * 0.4 + ed.canvas.height / 2; }],
                                ["one", () => { ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false; ed.view.x = -(L.x + 200) + 100; ed.view.y = -(L.y + 150) + 100; }]]) {
        view();
        ed.compositorOff = false;
        L._mcacheView = null;   // the Canvas 2D shot before left one
        const gl = await screen();
        if (L._mcacheView) throw new Error(name + ": the GPU stack made a matched canvas");
        ed.compositorOff = true;
        const d2 = await screen();
        ed.compositorOff = false;
        const m0 = ed.matchActive;
        ed.matchActive = () => false;
        let plain;
        try { plain = await screen(); } finally { ed.matchActive = m0; }
        const d = diff(gl, d2), u = diff(gl, plain);
        out[name] = { glVs2d: d, vsUnmatched: u.max };
        if (u.max < 20) throw new Error(name + ": the match does not move the GPU screen, so this proves nothing: " + JSON.stringify(out[name]));
        // interpolating premultiplied samples and matching the result against matching each byte first: a level or two
        if (d.max > 4 || d.o2 > d.of * 0.002) throw new Error(`${name}: the GPU stack's match differs from the Canvas 2D path's by ${d.max} levels, ${d.o2} bytes over 2`);
    }
    // a strength tick at 1:1: a uniform, no matched canvas, no texture uploaded
    ed.compositorOff = false;
    await screen();
    const comp = ed.compositor();
    const s0 = comp.stats();
    let regions = 0, matched = 0;
    const r0 = ed.matchedRegionView, p0 = ed.layerMatchedPixels;
    ed.matchedRegionView = function (...a) { regions++; return r0.apply(this, a); };
    ed.layerMatchedPixels = function (...a) { matched++; return p0.apply(this, a); };
    try {
        for (let i = 0; i < 8; i++) { L.match = { ...L.match, strength: 40 + i * 7 }; ed.markMatchChanged(L); ed.sceneSig = null; ed.draw(); }
    } finally { ed.matchedRegionView = r0; ed.layerMatchedPixels = p0; }
    const s1 = comp.stats();
    out.ticks = { regions, matched, textures: [s0.entries, s1.entries], atlasUploads: s1.atlas.uploads - s0.atlas.uploads, windowUploads: s1.windowUploads - s0.windowUploads };
    if (regions || matched) throw new Error("a strength tick on the GPU stack made a matched canvas: " + JSON.stringify(out.ticks));
    if (out.ticks.atlasUploads || out.ticks.windowUploads || s1.entries > s0.entries) throw new Error("a strength tick on the GPU stack uploaded: " + JSON.stringify(out.ticks));
} finally {
    ed.compositorOff = comp0;
    ed.fitView(); ed.sceneSig = null; ed.draw();
}
await run("remove_layer", { layer: L.id, doc: window.__t });
return out;
"""),
    ("the_base_holds_its_pixels_not_an_image", """
// C6 (d): the base kept the <img> it was decoded from and made its pixels from it on the first frame; every crop, resize,
// extend, merge into the base and flatten uploaded its new base, fetched it back as an <img> and decoded it again, and an
// undo of any of them decoded the old <img> again (0.5 to 0.8 s at 15000 x 10000). The base is { ref, px } now: pixels
// made once, carried by the undo steps, shared tile by tile by a crop. Both backends; the sharing on tiles.
await run("new_canvas", { width: 3000, height: 2000, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const T = await import("./editor/inpaint_tiles.js");
const W = ed.width, H = ed.height;
const base = document.createElement("canvas"); base.width = W; base.height = H;
{
    const x = base.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#284860"); g.addColorStop(1, "#d0a060");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 200; i++) { x.fillStyle = `hsl(${(i * 37) % 360},60%,50%)`; x.fillRect((i * 733) % W, (i * 419) % H, 60, 45); }
}
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "base6d.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const out = { tiles: !!ed.tileMode };
if ("img" in ed.base) throw new Error("the base still keeps an image: " + Object.keys(ed.base));
if (!ed.base.px || ed.basePx !== ed.base.px) throw new Error("the base holds no pixels of its own");
const L = ed.pixels.Layer;
let decodes = 0;
const fi = L.fromImage;
L.fromImage = function (...a) { decodes++; return fi.apply(this, a); };
const bytes = (px) => px.readRect(0, 0, px.width, px.height).data;
const diff = (a, b) => { if (a.length !== b.length) return Infinity; let m = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; } return m; };
try {
    // a crop: on tiles the new base shares the old base's tiles; the pixels are the old base's shifted
    const b0 = ed.basePx, d0 = bytes(b0);
    await ed.cropCanvas({ left: -256, top: -256, right: -300, bottom: -100 });
    const b1 = ed.basePx;
    if (b1 === b0 || b1.width !== W - 556 || b1.height !== H - 356) throw new Error("the crop made no new base of the new size");
    if (ed.tileMode) {
        const old = new Set(b0.tileList());
        const shared = b1.tileList().filter((t) => old.has(t)).length;
        out.cropShared = [shared, b1.tileList().length];
        if (!shared) throw new Error("the cropped base shares no tile with the base it came from: " + JSON.stringify(out.cropShared));
    }
    {
        const part = b0.readRect(256, 256, b1.width, b1.height).data;
        out.cropPixels = diff(part, bytes(b1));
        if (out.cropPixels) throw new Error("the cropped base's pixels are not the old base's: " + out.cropPixels + " levels");
    }
    // a paint layer merged into the base, then a flatten with another one: each new base is the composite the step made
    const P = ed.addPaintLayer();
    P.px.drawInto(null, (x) => { x.fillStyle = "rgba(200,40,40,0.6)"; x.fillRect(300, 200, 900, 700); });
    ed.markLayerChanged(P);
    const expectMerge = bytes(L.fromCanvas(ed.flattenToCanvas({ forRun: true })));
    await ed.mergeDown(P);
    out.merge = diff(expectMerge, bytes(ed.basePx));
    if (out.merge > 1) throw new Error("the base after a merge is not the composite it merged: " + out.merge + " levels");
    const Q = ed.addPaintLayer();
    Q.px.drawInto(null, (x) => { x.fillStyle = "rgba(40,200,90,0.5)"; x.fillRect(900, 500, 700, 600); });
    ed.markLayerChanged(Q);
    const expectFlat = bytes(L.fromCanvas(ed.flattenToCanvas({ forRun: true })));
    await ed.flatten();
    out.flatten = diff(expectFlat, bytes(ed.basePx));
    if (out.flatten > 1) throw new Error("the base after a flatten is not the flattened composite: " + out.flatten + " levels");
    // an extend and a resize
    await ed.extendCanvas({ left: 64, top: 0, right: 64, bottom: 32 }, { fill: "#101010" });
    const bE = ed.basePx;
    if (bE.width !== W - 556 + 128 || bE.height !== H - 356 + 32) throw new Error("the extend made no base of the new size: " + [bE.width, bE.height]);
    await ed.resizeImage(Math.round(bE.width * 0.6), Math.round(bE.height * 0.6));
    const bR = ed.basePx;
    if (bR.width !== Math.round(bE.width * 0.6)) throw new Error("the resize made no base of the new size");
    out.decodesWhileEditing = decodes;
    if (decodes) throw new Error("the base was decoded from an image again while editing: " + decodes + " times");
    // the steps hold the bases' pixels: counted by the memory report
    const rep = ed.memoryReport();
    out.undoHeld = rep.undo.undo.heldLayerBytes;
    // at least two whole old bases (the merged and the flattened one hold tiles of their own; the paint layers are a few tiles)
    const baseBytes = ed.tileMode ? b0.tileList().length * 256 * 256 * 4 : W * H * 4;
    if (!(out.undoHeld >= 2 * baseBytes)) throw new Error("the memory report does not count the bases the canvas steps hold: " + JSON.stringify({ held: out.undoHeld, baseBytes }));
    // undo all five and redo them: the same pixels objects come back, nothing is decoded
    const seen = [ed.basePx];
    for (let i = 0; i < 5; i++) { await ed.undoStep(); seen.push(ed.basePx); }
    if (seen[1] !== bE) throw new Error("the undo of the resize did not bring the extended base's pixels back");
    if (seen[4] !== b1 || seen[5] !== b0) throw new Error("the undo of the merge / crop did not bring the earlier base pixels back");
    for (let i = 0; i < 5; i++) await ed.redoStep();
    if (ed.basePx !== bR) throw new Error("the redo did not bring the resized base's pixels back");
    out.decodesInUndo = decodes;
    if (decodes) throw new Error("an undo or redo decoded a base image: " + decodes + " times");
} finally {
    L.fromImage = fi;
}
ed.clearUndo();
return out;
"""),
    ("undo_steps_share_whole_tiles_and_let_them_go", """
// C4: a stroke's undo step was a copy of the box at floor(x) - 2, and a copy shares a tile only when it starts on the
// tile's corner, so the step copied every tile the box overlapped; the redo copy grew by 6 px per round trip; and no
// discarded step ever put a tile's `frozen` count down, so the document copied tiles on its next write for nothing. On
// tiles the box is whole tiles now, a discarded step releases its own copies, and a restore that takes a step's pixels
// takes them out of the step first. Pixels on both backends; the tile counts on tiles.
await run("new_canvas", { width: 4000, height: 3000, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const W = ed.width, H = ed.height, TS = 256;
ed.clearUndo();
const L = ed.addPaintLayer();
L.px.drawInto(null, (x) => { const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#205080"); g.addColorStop(1, "#c08040"); x.fillStyle = g; x.fillRect(0, 0, W, H); });
ed.markLayerChanged(L);
ed.clearUndo();
const out = { tiles: !!ed.tileMode };
const all = () => L.px.readRect(0, 0, W, H).data;
const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i += 97) if (a[i] !== b[i]) return false; return true; };
const stroke = (i) => {
    const bx = 150 + (i * 353) % (W - 400), by = 120 + (i * 211) % (H - 300), bw = 90 + (i % 5) * 20, bh = 60 + (i % 4) * 15;
    const snap = ed.snapshotRect(L, { x: bx, y: by, w: bw, h: bh });
    const shotBefore = ed.tileMode ? snap.px.tileList().every((t) => L.px.tileList().includes(t)) : true;
    L.px.drawInto([bx, by, bx + bw, by + bh], (x) => { x.fillStyle = `hsl(${i * 37},80%,50%)`; x.fillRect(bx, by, bw, bh); });
    ed.markLayerChanged(L, [bx, by, bx + bw, by + bh]);
    ed.pushUndoSnapshot(snap);
    return { snap, shared: shotBefore, box: [bx, by, bw, bh] };
};
// (o) a step that shares tiles and is dropped without a write: their frozen count goes back down
if (ed.tileMode) {
    const box = [1000, 1000, 1600, 1500];
    const inBox = () => L.px.tileList().filter((t) => t.frozen > 0).length;
    ed.pushUndoSnapshot(ed.snapshotRect(L, { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] }));
    const held = inBox();
    ed.clearUndo();
    out.dropped = { frozenWhileHeld: held, afterClear: inBox() };
    if (!held) throw new Error("the step froze no tile, so this proves nothing");
    if (out.dropped.afterClear) throw new Error("a dropped step left " + out.dropped.afterClear + " tiles frozen");
}
// (i) one stroke: the step shares the tiles until the stroke writes, then holds exactly the originals of the tiles it touched
const s0 = all();
const first = stroke(0);
if (ed.tileMode) {
    if (!first.shared) throw new Error("the stroke's undo copy did not share the layer's tiles");
    const { snap } = first;
    if (snap.x % TS || snap.y % TS) throw new Error("the undo box is not on the tile grid: " + [snap.x, snap.y]);
    const live = new Set(L.px.tileList());
    const own = snap.px.tileList().filter((t) => !live.has(t)).length;
    const [bx, by, bw, bh] = first.box;
    const touched = (Math.floor((bx + bw - 1) / TS) - Math.floor(bx / TS) + 1) * (Math.floor((by + bh - 1) / TS) - Math.floor(by / TS) + 1);
    out.first = { own, touched, stepTiles: snap.px.tileList().length };
    if (own !== touched) throw new Error("the step holds " + own + " tiles of its own, the stroke touched " + touched);
}
// (ii) 29 more strokes: the steps hold only touched tiles
const strokes = [first];
for (let i = 1; i < 30; i++) strokes.push(stroke(i));
const s30 = all();
if (ed.tileMode) {
    const live = new Set(L.px.tileList());
    const held = new Set();
    for (const st of ed.undo) if (st && st.px) for (const t of st.px.tileList()) if (!live.has(t)) held.add(t);
    const touched = new Set();
    for (const { box: [bx, by, bw, bh] } of strokes) for (let ty = Math.floor(by / TS); ty <= Math.floor((by + bh - 1) / TS); ty++) for (let tx = Math.floor(bx / TS); tx <= Math.floor((bx + bw - 1) / TS); tx++) touched.add(ty * 1000 + tx);
    out.thirty = { held: held.size, touchedTiles: touched.size, layerTiles: live.size };
    // a tile touched by several strokes is held once per stroke that copied it: never more than the strokes' touches
    const touches = strokes.reduce((a, { box: [bx, by, bw, bh] }) => a + (Math.floor((bx + bw - 1) / TS) - Math.floor(bx / TS) + 1) * (Math.floor((by + bh - 1) / TS) - Math.floor(by / TS) + 1), 0);
    if (held.size > touches) throw new Error("30 steps hold more tiles than the strokes touched: " + JSON.stringify({ ...out.thirty, touches }));
}
// (iii) undo all 30, redo all 30: the pixels, and redo boxes that do not grow
const boxes = ed.undo.slice(-30).map((st) => [st.x, st.y, st.w, st.h].join(","));
for (let i = 0; i < 30; i++) await ed.undoStep();
if (!same(all(), s0)) throw new Error("30 undos did not bring the layer back");
for (let i = 0; i < 30; i++) await ed.redoStep();
if (!same(all(), s30)) throw new Error("30 redos did not bring the strokes back");
for (let i = 0; i < 30; i++) await ed.undoStep();
for (let i = 0; i < 30; i++) await ed.redoStep();
const boxes2 = ed.undo.slice(-30).map((st) => [st.x, st.y, st.w, st.h].join(","));
out.boxesKept = boxes.join("|") === boxes2.join("|");
if (!out.boxesKept) throw new Error("two undo / redo round trips changed the steps' boxes: " + boxes.slice(0, 3) + " -> " + boxes2.slice(0, 3));
if (!same(all(), s30)) throw new Error("the second round trip lost the strokes");
// (iv) the steps left untouched by writes into the layer: undo 10, write over the whole layer, the 10 redo steps still redo
for (let i = 0; i < 10; i++) await ed.undoStep();
const redoCopies = ed.redo.map((st) => st.px ? st.px.readRect(0, 0, st.px.width, st.px.height).data : null);
L.px.drawInto(null, (x) => { x.fillStyle = "rgba(255,255,255,0.3)"; x.fillRect(0, 0, W, H); });
ed.markLayerChanged(L);
const redoAfter = ed.redo.map((st) => st.px ? st.px.readRect(0, 0, st.px.width, st.px.height).data : null);
// (a write clears the redo stack in the editor's own paths; here it is written directly, so the steps are still there)
out.redoKept = redoCopies.every((c, i) => !c || same(c, redoAfter[i]));
if (!out.redoKept) throw new Error("a write into the layer changed the pixels an undo step holds (a shared tile written in place)");
// (v) the history dropped: no tile of the layer or the selection stays frozen
ed.clearUndo();
if (ed.tileMode) {
    const frozen = [...L.px.tileList(), ...ed.sel.tileList()].filter((t) => t.frozen > 0).length;
    out.frozenAfterClear = frozen;
    if (frozen) throw new Error(frozen + " tiles stay frozen after the history is gone");
}
// (vi) a selection step and a crop's canvas step: undo puts the selection back
await run("select_rect", { x: 500, y: 400, w: 900, h: 700, doc: window.__t });
const sb = JSON.stringify(ed.getBounds());
await ed.cropCanvas({ left: -100, top: -50, right: 0, bottom: 0 });
await ed.undoStep();
out.selectionAfterCropUndo = [sb, JSON.stringify(ed.getBounds())];
if (JSON.stringify(ed.getBounds()) !== sb) throw new Error("the undo of a crop did not put the selection back: " + JSON.stringify(out.selectionAfterCropUndo));
await ed.redoStep(); await ed.undoStep();
if (JSON.stringify(ed.getBounds()) !== sb) throw new Error("a second undo of the crop lost the selection");
await run("select_none", { doc: window.__t });
await run("remove_layer", { layer: L.id, doc: window.__t });
ed.clearUndo();
return out;
"""),
    ("stroke_buffers_cover_the_gesture_not_the_layer", """
// Phase A item 2 (docs/PLAN_TILES.md): a stroke's buffer and its selection clip cover what the
// gesture touched, not the layer; the live preview is refreshed inside the dab's rectangle; the
// committed pixels and the preview are the same as with a buffer the size of the layer, with a
// soft brush at an opacity and clipped to a selection, painting and erasing; and the preview
// canvases of a large layer are given back after the gesture.
await run("new_canvas", { width: 5000, height: 4000, doc: window.__t });   // 20 MP: above the keep limit
const ed = ednow(window.__t);
host.shell.activate(ed);
const W = ed.width, H = ed.height;
const out = {};
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const layer = ed.addPaintLayer();
layer.px.drawInto(null, (x) => { x.fillStyle = "#3060c0"; x.fillRect(200, 200, 2000, 1500); x.fillStyle = "#c06030"; x.fillRect(1500, 1000, 2000, 1500); });
ed.activeLayerId = layer.id;
ed.sel.drawInto(null, (s) => { s.clearRect(0, 0, W, H); s.fillStyle = "#ff0000"; s.fillRect(600, 500, 2200, 1600); });
ed.markSelectionChanged([600, 500, 2800, 2100]);
ed.brushSize = 90; ed.hardness = 0.4; ed.eraseHardness = 0.4; ed.brushOpacity = 0.6; ed.color = "#20c040";
const path = []; for (let i = 0; i <= 24; i++) path.push([500 + i * 90, 700 + Math.round(Math.sin(i / 3) * 300)]);
// premultiplied, like the compositor gate: at alpha 1 or 2 the stored colour is noise, and a
// canvas copy (the buffer growing) may change it without changing what is drawn
const same = (a, b, tol) => { let max = 0; for (let i = 0; i < a.length; i += 4) { const aa = a[i + 3], ba = b[i + 3]; let d = Math.abs(aa - ba); for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] * aa / 255 - b[i + k] * ba / 255)); if (d > max) max = d; } return max <= tol ? null : +max.toFixed(1); };
// a full-size buffer that answers the same interface: the reference is the old way, a canvas the size of the layer
const fullBuffer = (target) => {
    const c = mk(target.width, target.height);
    return {
        tw: target.width, th: target.height, canvas: c, x: 0, y: 0, w: target.width, h: target.height,
        cells: new Set([0]), empty: false,
        draw(x0, y0, x1, y1, fn) { const ctx = c.getContext("2d"); ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); try { return fn(ctx); } finally { ctx.restore(); } },
        all(fn) { return this.draw(0, 0, this.tw, this.th, fn); },
        part() { return { canvas: c, x: 0, y: 0 }; },
    };
};
const paintRef = (erase) => {
    const ref = mk(W, H); layer.px.drawTo(ref.getContext("2d"), 0, 0);
    const q = { kind: "layerpaint", layer, stroke: fullBuffer(layer.px), clip: true, erase, last: path[0], pressure: 1 };
    ed.layerDab(q, path[0][0], path[0][1], path[0][0], path[0][1]);   // the pointer-down dab
    for (let i = 1; i < path.length; i++) ed.layerDab(q, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    const clip = mk(W, H); { const c = clip.getContext("2d"); c.setTransform(layer.px.width / layer.w, 0, 0, layer.px.height / layer.h, 0, 0); ed.sel.drawTo(c, -layer.x, -layer.y); }
    const st = mk(W, H); { const c = st.getContext("2d"); c.drawImage(q.stroke.canvas, 0, 0); c.globalCompositeOperation = "destination-in"; c.drawImage(clip, 0, 0); }
    const r = ref.getContext("2d"); r.globalAlpha = ed.brushOpacity; r.globalCompositeOperation = erase ? "destination-out" : "source-over"; r.drawImage(st, 0, 0);
    return ref;
};
for (const erase of [false, true]) {
    const before = mk(W, H); layer.px.drawTo(before.getContext("2d"), 0, 0);
    const ref = paintRef(erase);
    // the real gesture: the buffer grows with the dabs, the preview follows inside the dab's box
    const p = { kind: "layerpaint", layer, stroke: ed.newStrokeBuffer(layer.px), clip: ed.strokeClip(layer, layer.px), erase, last: path[0], pressure: 1 };
    ed.pointer = p;
    ed.layerDab(p, path[0][0], path[0][1], path[0][0], path[0][1]);
    let previewChecked = 0;
    for (let i = 1; i < path.length; i++) {
        ed.layerDab(p, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
        if (i % 6 === 0) {
            // the incremental preview against a preview built whole from the same buffer
            const live = ed.layerPixels(layer);
            // the reference: the layer, plus the whole buffer clipped to the whole selection, in
            // canvases the size of the layer - which is what C5 stopped making
            const whole = mk(W, H);
            {
                const c = whole.getContext("2d"); layer.px.drawTo(c, 0, 0);
                const clip = mk(W, H); { const q = clip.getContext("2d"); q.setTransform(layer.px.width / layer.w, 0, 0, layer.px.height / layer.h, 0, 0); ed.sel.drawTo(q, -layer.x, -layer.y); }
                const sp = p.stroke.part(p.stroke.x, p.stroke.y, p.stroke.x + p.stroke.w, p.stroke.y + p.stroke.h);
                const st = mk(W, H); { const q = st.getContext("2d"); q.drawImage(sp.canvas, p.stroke.x - sp.x, p.stroke.y - sp.y, p.stroke.w, p.stroke.h, p.stroke.x, p.stroke.y, p.stroke.w, p.stroke.h); q.globalCompositeOperation = "destination-in"; q.drawImage(clip, 0, 0); }
                c.globalAlpha = ed.brushOpacity; c.globalCompositeOperation = erase ? "destination-out" : "source-over"; c.drawImage(st, 0, 0);
            }
            const box = [Math.max(0, p.stroke.x - 4), Math.max(0, p.stroke.y - 4), Math.min(W, p.stroke.x + p.stroke.w + 4), Math.min(H, p.stroke.y + p.stroke.h + 4)];
            const a = live.getContext("2d").getImageData(box[0], box[1], box[2] - box[0], box[3] - box[1]).data;
            const b = whole.getContext("2d").getImageData(box[0], box[1], box[2] - box[0], box[3] - box[1]).data;
            // the same tolerance and the same reason as the committed comparison below: the live path
            // composes in band-sized canvases, which Chromium keeps in software, and the reference in
            // canvases the size of the layer, which are on the GPU (measured 1.7 premultiplied)
            const d = same(a, b, 4);
            if (d) throw new Error((erase ? "erase" : "paint") + ": the live preview differs from a whole one by " + d + " levels after dab " + i);
            previewChecked++;
        }
    }
    const bands = Array.from(ed.strokeBands(p, layer.px));
    out[(erase ? "erase" : "paint") + "Buffer"] = { w: p.stroke.w, h: p.stroke.h, share: +((p.stroke.w * p.stroke.h) / (W * H)).toFixed(3), bands: bands.length, previewChecked };
    if (p.stroke.w * p.stroke.h > 0.25 * W * H) throw new Error("the stroke buffer is not much smaller than the layer: " + JSON.stringify(out));
    // C5: the clip and the patch are taken band by band, so no canvas of the stroke's own size is made
    if (!bands.length || bands.some(([, , bw, bh]) => bw > 1024 || bh > 1024)) throw new Error("a band is larger than STROKE_BAND: " + JSON.stringify(bands.slice(0, 4)));
    ed.onPointerUp({ pointerId: 1 });
    // the 20 MP preview is given back; the band scratches are a band's size and may stay
    if (ed.strokePreview) throw new Error("the preview canvas of a 20 MP layer was kept after the gesture");
    for (const k of ["_strokePatch", "_strokeClip", "_strokeDev"]) {
        const c = ed[k];
        if (c && (c.width > 1024 || c.height > 1024)) throw new Error(k + " is not a band: " + c.width + "x" + c.height);
    }
    // the committed pixels against the reference, inside the selection and outside it
    const got = layer.px.readRect(0, 0, W, H).data;
    const want = ref.getContext("2d").getImageData(0, 0, W, H).data;
    // a small buffer starts as a software canvas and grows onto the GPU; Skia's CPU and GPU
    // blending of twenty overlapping soft dabs round differently by a few levels (measured 4
    // premultiplied at most), which no eye sees and which the old 600 MB buffer did not get
    // to show because it was on the GPU from the first dab
    const d = same(got, want, 8);
    if (d) throw new Error((erase ? "erase" : "paint") + ": the committed stroke differs from the reference by " + d + " levels");
    const step = ed.undo[ed.undo.length - 1];
    out[(erase ? "erase" : "paint") + "Undo"] = { kind: step.kind, w: step.w, h: step.h, px: !!step.px };
    if (step.kind !== "layerrect" || !step.px || step.px.width !== step.w || step.w >= W) throw new Error("the undo step is not a rect copy: " + JSON.stringify(out[(erase ? "erase" : "paint") + "Undo"]));
    await ed.undoStep();
    const back = layer.px.readRect(0, 0, W, H).data;
    if (same(back, before.getContext("2d").getImageData(0, 0, W, H).data, 0)) throw new Error("undo did not restore the layer");
    // paint it for real for the erase round
    ed.pointer = null;
}
ed.clearSelection();
await run("remove_layer", { layer: layer.id, doc: window.__t });
return out;
"""),
    ("grow_feather_and_invert_are_the_answers_a_whole_image_run_gives", """
// C5: grow, shrink and feather send only the selection's bounding box plus the operation's halo
// through the worker, and invert walks the mask's own tiles instead of the worker. The answers have
// to be the answers the whole-image route gives, so each is compared against the rule itself, run
// here over the whole mask.
const R = await import("./editor/inpaint_raster.js");
const d = await run("new_document");
window.__te = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { width: 4000, height: 3000, doc: d.id });
const W = ed.width, H = ed.height;
const out = { tiles: ed.tileMode };
const alphaAt = (x, y) => ed.sel.readRect(x, y, 1, 1).data[3];
const rect = async () => { await run("select_rect", { x: 600, y: 500, w: 600, h: 400, doc: d.id }); };

// grow: the same pixels growMask gives over the whole mask
await rect();
{
    const want = ed.sel.readRect(0, 0, W, H);
    R.growMask(want.data, W, H, 16);
    const wb = R.maskBounds(want.data, W, H);
    await ed.growSelection(16);
    const got = ed.sel.readRect(0, 0, W, H).data;
    let worst = 0, n = 0;
    for (let i = 3; i < got.length; i += 4) { const q = Math.abs(got[i] - want.data[i]); if (q) { n++; if (q > worst) worst = q; } }
    out.grow = { worst, differing: n, bounds: ed.getBounds(), want: wb, far: alphaAt(3500, 2500) };
    if (worst > 1) throw new Error("grow: the box run differs from a whole-image run by " + worst + " levels on " + n + " pixels");
    if (out.grow.far !== 0) throw new Error("grow reached far outside the selection: " + JSON.stringify(out.grow));
    if (!ed.getBounds() || Math.abs(ed.getBounds()[0] - wb[0]) > 1 || Math.abs(ed.getBounds()[2] - wb[2]) > 1) throw new Error("grow reported the wrong bounds: " + JSON.stringify(out.grow));
}
// shrink, from the grown selection back
{
    const want = ed.sel.readRect(0, 0, W, H);
    R.growMask(want.data, W, H, -16);
    await ed.growSelection(-16);
    const got = ed.sel.readRect(0, 0, W, H).data;
    let worst = 0, n = 0;
    for (let i = 3; i < got.length; i += 4) { const q = Math.abs(got[i] - want.data[i]); if (q) { n++; if (q > worst) worst = q; } }
    out.shrink = { worst, differing: n, bounds: ed.getBounds() };
    if (worst > 1) throw new Error("shrink: the box run differs from a whole-image run by " + worst + " levels on " + n + " pixels");
}
// feather: a soft edge inside the halo, nothing at all beyond it
await rect();
{
    const r = 8;
    await ed.featherSelection(r);
    const halo = Math.ceil(r * 3) + 2;
    const inside = alphaAt(900, 700), edge = alphaAt(600, 700), beyond = alphaAt(600 - halo - 4, 700), far = alphaAt(3500, 2500);
    out.feather = { inside, edge, beyond, far, bounds: ed.getBounds() };
    if (inside < 250) throw new Error("feather emptied the middle: " + JSON.stringify(out.feather));
    if (edge < 20 || edge > 235) throw new Error("the feathered edge is not soft: " + JSON.stringify(out.feather));
    if (beyond !== 0 || far !== 0) throw new Error("feather reached past its halo: " + JSON.stringify(out.feather));
}
// invert: 255 - the alpha it had, everywhere
await rect();
{
    const before = ed.sel.readRect(0, 0, W, H).data.slice();
    await ed.invertSelection();
    const got = ed.sel.readRect(0, 0, W, H).data;
    let worst = 0, n = 0;
    for (let i = 3; i < got.length; i += 4) { const q = Math.abs(got[i] - (255 - before[i])); if (q) { n++; if (q > worst) worst = q; } }
    out.invert = { worst, differing: n, inside: alphaAt(900, 700), outside: alphaAt(3500, 2500), bounds: ed.getBounds() };
    if (worst > 1) throw new Error("invert is not 255 - the alpha it had: " + JSON.stringify(out.invert));
    if (out.invert.inside !== 0 || out.invert.outside !== 255) throw new Error("invert did not swap inside and outside: " + JSON.stringify(out.invert));
    const b = ed.getBounds();
    if (!b || b[0] !== 0 || b[1] !== 0 || b[2] !== W || b[3] !== H) throw new Error("the inverted selection's bounds are not the picture: " + JSON.stringify(out.invert));
}
await run("close_document", { doc: d.id, force: true });
return out;
"""),
    ("gradient_tool_keeps_the_canvas_buffer_and_fills_the_layer", """
// The gradient rebuilds its whole buffer on every move, so C5 leaves it on the canvas buffer on
// both backends: a sparse store of the target's size would allocate every tile and read a scratch
// of the whole layer back per move. Driven through the real pointer handlers, so the gesture makes
// its own buffer; the fill itself had no gate at all before.
const d = await run("new_document");
window.__tg = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { width: 800, height: 600, doc: d.id });
const L = ed.addPaintLayer();
ed.activeLayerId = L.id;
ed._fitted = false;
ed.view.scale = 1;
ed.view.x = Math.round(ed.canvas.width / 2 - 400);
ed.view.y = Math.round(ed.canvas.height / 2 - 300);
ed.setTool("gradient");
ed.gradientOpts = { type: "linear", to: "transparent" };
ed.color = "#ff0000";
ed.brushOpacity = 1;
ed.draw(); await wait(60);
const r = ed.canvas.getBoundingClientRect();
const client = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: r.left + sx * r.width / ed.canvas.width, clientY: r.top + sy * r.height / ed.canvas.height }; };
const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 11, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
ed.canvas.dispatchEvent(ev("pointerdown", 60, 300));
const p = ed.pointer;
const out = { tiles: ed.tileMode, kind: p && p.kind, grad: !!(p && p.grad), sparse: !!(p && p.stroke && p.stroke.px) };
if (!p || !p.grad) throw new Error("the gradient tool did not start a gesture: " + JSON.stringify(out) + " " + ed.status);
if (out.sparse) throw new Error("the gradient took a sparse stroke store: " + JSON.stringify(out));
ed.canvas.dispatchEvent(ev("pointermove", 740, 300));
await wait(30);
ed.canvas.dispatchEvent(ev("pointerup", 740, 300));
await wait(60);
const at = (x, y) => Array.from(L.px.readRect(x, y, 1, 1).data);
out.start = at(62, 300); out.middle = at(400, 300); out.end = at(735, 300);
if (out.start[0] < 240 || out.start[3] < 240) throw new Error("the gradient did not start opaque: " + JSON.stringify(out));
if (out.end[3] > 20) throw new Error("the gradient did not run out to transparent: " + JSON.stringify(out));
if (out.middle[3] < 80 || out.middle[3] > 190) throw new Error("the middle is not halfway: " + JSON.stringify(out));
const step = ed.undo[ed.undo.length - 1];
out.undo = { kind: step.kind, w: step.w, h: step.h };
await run("close_document", { doc: d.id, force: true });
ed.setTool("paint");
return out;
"""),
    ("a_stroke_across_the_picture_keeps_only_the_tiles_it_touched", """
// C5: on the tile backend the stroke buffer is a sparse store of the target's own size, so a
// stroke from corner to corner holds the tiles its dabs reached and nothing else. Before that it
// was a canvas of the stroke's bounding box, which for a diagonal is the whole picture (561 MB on
// a 15000 x 10000 one). The picture it writes has to be the picture a buffer of the whole box
// writes, so the committed pixels are compared against exactly that.
const T = await import("./editor/inpaint_tiles.js");
const d = await run("new_document");
window.__tc = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { width: 4000, height: 3000, doc: d.id });
const W = ed.width, H = ed.height;
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const layer = ed.addPaintLayer();
layer.px.drawInto(null, (x) => { x.fillStyle = "#20406080"; x.fillRect(0, 0, W, H); });
ed.activeLayerId = layer.id;
await run("select_none", { doc: d.id });
ed.brushSize = 50; ed.hardness = 0.5; ed.brushOpacity = 0.8; ed.color = "#40e080";
const path = []; for (let i = 0; i <= 20; i++) path.push([100 + i * (W - 200) / 20, 100 + i * (H - 200) / 20]);
const dabs = (q) => { ed.layerDab(q, path[0][0], path[0][1], path[0][0], path[0][1]); for (let i = 1; i < path.length; i++) ed.layerDab(q, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]); };
// the reference: the same dabs into a buffer of the whole target, applied the old way
const before = layer.px.readRect(0, 0, W, H).data.slice();
const full = mk(layer.px.width, layer.px.height);
const ref = {
    tw: layer.px.width, th: layer.px.height, canvas: full, x: 0, y: 0, w: full.width, h: full.height,
    cells: new Set([0]), empty: false,
    draw(x0, y0, x1, y1, fn) { const c = full.getContext("2d"); c.save(); c.setTransform(1, 0, 0, 1, 0, 0); try { return fn(c); } finally { c.restore(); } },
    all(fn) { return this.draw(0, 0, this.tw, this.th, fn); },
    part() { return { canvas: full, x: 0, y: 0 }; },
};
dabs({ kind: "layerpaint", layer, stroke: ref, clip: null, erase: false, last: path[0], pressure: 1 });
const want = mk(W, H);
{ const c = want.getContext("2d"); layer.px.drawTo(c, 0, 0); c.globalAlpha = ed.brushOpacity; c.drawImage(full, 0, 0); }
// the real gesture
const p = { kind: "layerpaint", layer, stroke: ed.newStrokeBuffer(layer.px), clip: null, erase: false, last: path[0], pressure: 1 };
ed.pointer = p;
dabs(p);
const sb = p.stroke;
const boxBytes = sb.w * sb.h * 4;
const out = { tiles: ed.tileMode, box: [sb.w, sb.h], boxMB: +(boxBytes / 1048576).toFixed(1),
              heldMB: +((sb.px ? sb.px.bytes() : sb.cw * sb.ch * 4) / 1048576).toFixed(1),
              tilesHeld: sb.px ? sb.px.tileCount : null, cells: sb.cells.size };
if (ed.tileMode) {
    if (!sb.px || !T.isTilePixels(sb.px)) throw new Error("the stroke buffer is not a tile store: " + JSON.stringify(out));
    if (sb.px.width !== layer.px.width || sb.px.height !== layer.px.height) throw new Error("the stroke store is not the target's size");
    if (out.heldMB > out.boxMB * 0.25) throw new Error("the sparse buffer holds most of its own box: " + JSON.stringify(out));
} else if (sb.px) throw new Error("the canvas backend made a tile store for the stroke");
if (sb.w < W * 0.8 || sb.h < H * 0.8) throw new Error("this stroke is supposed to span the picture: " + JSON.stringify(out));
const bx = ed.strokeRect(p, layer.px);
ed.commitStroke(p);
ed.pointer = null;
ed.markLayerChanged(layer, bx);
ed.releaseStrokeScratch();
const got = layer.px.readRect(0, 0, W, H).data;
const wd = want.getContext("2d").getImageData(0, 0, W, H).data;
let worst = 0, n = 0, changed = 0;
for (let i = 0; i < got.length; i += 4) {
    const ga = got[i + 3], wa = wd[i + 3];
    let dd = Math.abs(ga - wa);
    for (let k = 0; k < 3; k++) dd = Math.max(dd, Math.abs(got[i + k] * ga / 255 - wd[i + k] * wa / 255));
    if (dd > 0) n++;
    if (dd > worst) worst = dd;
    if (Math.abs(got[i + 3] - before[i + 3]) > 2 || Math.abs(got[i] - before[i]) > 2) changed++;
}
out.worst = +worst.toFixed(1); out.differing = n; out.changed = changed;
// the stroke really painted, so the comparison cannot pass on a buffer that drew nothing
if (changed < 200000) throw new Error("the stroke barely changed the layer: " + JSON.stringify(out));
if (worst > 8) throw new Error("the sparse buffer wrote a different picture than a whole one: " + JSON.stringify(out));
await run("close_document", { doc: d.id, force: true });
return out;
"""),
    ("undo_puts_a_flipped_turned_or_merged_layer_back", """
// docs/PLAN_BCE.md C1 rule 11: 0.1.11 drew an undo step's saved pixels with whatever a flip, a turn
// or a merge had left on the layer's own context, so undoing a fill brought the layer back mirrored,
// turned or see-through. Every write goes through the layer's pixels from a fresh state now: fill +
// undo has to give the pixels from before the fill on each such layer.
await run("new_canvas", { width: 600, height: 400, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const paint = (l, a, b) => l.px.drawInto(null, (x) => {
    x.fillStyle = a; x.fillRect(20, 30, 260, 120);
    x.fillStyle = b; x.beginPath(); x.arc(420, 250, 90, 0, Math.PI * 2); x.fill();
});
const all = (l) => l.px.readRect(0, 0, l.px.width, l.px.height).data;
// premultiplied: the undo step is a PNG, which rounds the colour of nearly transparent pixels
const worst = (a, b) => { if (a.length !== b.length) return 255; let m = 0; for (let i = 0; i < a.length; i += 4) { const aa = a[i + 3], ba = b[i + 3]; let d = Math.abs(aa - ba); for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] * aa / 255 - b[i + k] * ba / 255)); if (d > m) m = d; } return +m.toFixed(1); };
const out = {};
for (const make of ["flip", "turn", "merge"]) {
    const l = ed.addPaintLayer();
    ed.activeLayerId = l.id;
    paint(l, "#e03020", "rgba(20, 60, 220, 0.6)");
    ed.markLayerChanged(l);
    if (make === "flip") ed.flipLayer("h");
    else if (make === "turn") ed.rotateLayer90(1);
    else {
        const top = ed.addPaintLayer();
        paint(top, "rgba(40, 200, 90, 0.8)", "#f0d020");
        top.blend = "multiply"; top.opacity = 0.5;
        ed.markLayerChanged(top);
        await ed.mergeDown(top);
        ed.activeLayerId = l.id;
    }
    const target = ed.layers.find((x) => x.id === l.id);
    if (!target || ed.activeLayer() !== target) throw new Error(make + ": the layer is gone (" + ed.status + ")");
    const before = all(target);
    await run("select_rect", { x: 100, y: 80, w: 300, h: 200, doc: window.__t });
    ed.brushOpacity = 0.66; ed.color = "#ff8000";
    ed.fillSelection();
    const fill = worst(all(target), before);
    if (fill < 50) throw new Error(make + ": the fill did not land (" + fill + ", " + ed.status + ")");
    await ed.undoStep();
    const back = worst(all(target), before);
    out[make] = { fill, back, size: [target.px.width, target.px.height] };
    if (back > 1) throw new Error(make + ": the undo did not put the layer back, " + back + " levels off: " + JSON.stringify(out));
    ed.clearSelection();
    await run("remove_layer", { layer: target.id, doc: window.__t });
}
ed.brushOpacity = 1;
return out;
"""),
    ("history_steps_run_in_order_and_keep_their_own_state", """
// C1 review (docs/PLAN_BCE.md, C1 as built): undo and redo run one after the other, an edit that
// writes after an await is waited for, a mask fill replaces the mask like its restore does, an
// older layers step keeps its own filter parameters and text, the redo steps leave the budget
// before it trims, and a new image of the same size takes the history with it.
await run("new_canvas", { width: 400, height: 300, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const out = {};
const band = (x0, x1) => { const m = new Uint8Array(400 * 300); for (let y = 0; y < 300; y++) for (let x = x0; x < x1; x++) m[y * 400 + x] = 1; return m; };
const find = (id) => ed.layers.find((l) => l.id === id);
ed.brushOpacity = 1;
// two undos in a row while the first restore still decodes its PNG (key repeat, a double click)
const L = ed.addPaintLayer();
const at = (x) => { const d = find(L.id).px.readRect(x, 150, 1, 1).data; return d[3] ? d[0] + "," + d[1] : "clear"; };
ed.applyMaskToSelection(band(0, 200), "replace");
ed.color = "#ff0000"; ed.fillSelection();
ed.color = "#00ff00"; ed.fillSelection();
const u1 = ed.undoStep(), u2 = ed.undoStep();
await Promise.all([u1, u2]);
out.race = [at(100)];
await ed.redoStep(); out.race.push(at(100));
await ed.redoStep(); out.race.push(at(100));
if (out.race.join("|") !== "clear|255,0|0,255") throw new Error("undo / redo out of order (clear, red, green expected): " + JSON.stringify(out.race));
// an undo right after a grow that runs in the worker takes the grow back, not the step below it
ed.applyMaskToSelection(band(100, 200), "replace");
const grow = ed.growSelection(20);
await ed.undoStep();
await grow;
out.grow = ed.getBounds();
if (!out.grow || out.grow[0] !== 100 || out.grow[2] !== 200) throw new Error("undo during a grow left " + JSON.stringify(out.grow));
// a fill on a layer mask, with an older layers step holding that mask: undoing both gives the mask from before
const M = ed.addPaintLayer();
M.px.fill(null, "#ff0000"); ed.markLayerChanged(M);
ed.activeLayerId = M.id;
ed.applyMaskToSelection(band(0, 200), "replace");
ed.maskFromSelection(M);
const ma = (x) => { const l = find(M.id); return l.maskPx ? l.maskPx.readRect(x, 150, 1, 1).data[3] : -1; };
const created = [ma(100), ma(300)];
ed.duplicateLayer(M);
ed.activeLayerId = M.id;
find(M.id).maskEdit = true;
ed.applyMaskToSelection(band(200, 400), "replace");
ed.fillSelection();
const filled = [ma(100), ma(300)];
await ed.undoStep(); await ed.undoStep(); await ed.undoStep();   // the fill, the selection, the duplicate
out.maskFill = { created, filled, back: [ma(100), ma(300)] };
if (filled[1] !== 255 || out.maskFill.back.join() !== created.join()) throw new Error("the undone mask fill came back: " + JSON.stringify(out.maskFill));
// filter parameters and text changed in place by their controls, under an older layers step
const F = ed.addFilterLayer("grain");
const key = Object.keys(F.params).find((k) => typeof F.params[k] === "number");
const v0 = F.params[key];
const T = await ed.addTextLayer(20, 20);
T.text.size = 40; await ed.renderTextLayer(T);
if (document.activeElement && document.activeElement.tagName === "TEXTAREA") document.activeElement.blur();
const P = ed.addPaintLayer();
ed.removeLayer(P.id);                                                   // the layers step
ed.pushUndo({ kind: "filter", id: F.id }); find(F.id).params[key] = v0 + 1;   // what the slider does
ed.pushUndo({ kind: "text", id: T.id }); find(T.id).text.size = 80; await ed.renderTextLayer(find(T.id));   // what the Size field does
await ed.undoStep(); await ed.undoStep(); await ed.undoStep();         // text, filter, the removal
out.nested = { param: [v0, find(F.id).params[key]], size: find(T.id).text.size, layers: ed.layers.length };
if (out.nested.param[1] !== v0 || out.nested.size !== 40) throw new Error("an older layers step brought undone values back: " + JSON.stringify(out.nested));
// the budget: 24 steps of 16 MB fill it; 10 undone, then a new step must keep 15 (the redo steps go first)
ed.clearUndo();
const MB16 = 16 * 1048576;
for (let i = 0; i < 24; i++) ed.pushUndoSnapshot({ kind: "transform", id: -1, bytes: MB16 });
for (let i = 0; i < 10; i++) ed.redo.push(ed.undo.pop());            // what undoStep leaves on the budget
ed.pushUndoSnapshot({ kind: "transform", id: -1, bytes: MB16 });
out.budget = { undo: ed.undo.length, redo: ed.redo.length, mb: ed.undoBytes / 1048576 };
if (out.budget.undo !== 15 || out.budget.redo !== 0 || out.budget.mb !== 240) throw new Error("the redo steps trimmed the undo steps: " + JSON.stringify(out.budget));
ed.clearUndo();
// a new image of the same size: no step of the old document survives, and its bytes leave the budget
const S = ed.addPaintLayer();
ed.pushUndoSnapshot(ed.snapshotRect(S, { x: 0, y: 0, w: 400, h: 300 }));
const heldBefore = ed.undoBytes;
await ed.setBasePixels(ed.base.ref, ed.basePx, { keepLayers: false });
out.load = { heldBefore, undo: ed.undo.length, redo: ed.redo.length, bytes: ed.undoBytes, layers: ed.layers.length };
if (!heldBefore || out.load.undo || out.load.redo || out.load.bytes) throw new Error("the history survived a same-size load: " + JSON.stringify(out.load));
return out;
"""),
    ("undo_is_refused_while_a_stroke_or_a_drag_is_held", """
// C1 close-out: Ctrl+Z (or an agent's undo) while the button was down took back the gesture's own
// step, pushed at pointer down (a marquee, a lasso, a move, a smudge), or the step that made the mask
// a stroke paints on, and the finished gesture had no step of its own. It is refused until the
// button comes up.
await run("new_canvas", { width: 800, height: 600, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
await wait(200);
const r = () => ed.canvas.getBoundingClientRect();
const client = (ix, iy) => { const b = r(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: b.left + sx * b.width / ed.canvas.width, clientY: b.top + sy * b.height / ed.canvas.height }; };
const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 14, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
const ctrlZ = () => ed.onKey(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
const fails = [], out = {};
const errors = [];
const onErr = (e) => errors.push(String(e.message || e.error));
window.addEventListener("error", onErr);
try {
    // a stroke on a layer mask whose mask step is on top: the undo removed the mask under the stroke
    await run("add_paint_layer", { doc: window.__t });
    const l = ed.activeLayer();
    await run("select_rect", { x: 100, y: 100, w: 300, h: 200, doc: window.__t });
    ed.maskFromSelection(l);          // a mask step with no mask before it
    ed.clearSelection();
    await ed.undoStep();              // the selection is back, the mask step is on top
    ed.toggleMaskEdit(l);
    ed.setTool("paint");
    const n0 = ed.undo.length;
    ed.canvas.dispatchEvent(ev("pointerdown", 150, 150));
    ed.canvas.dispatchEvent(ev("pointermove", 200, 180));
    await wait(20);
    ctrlZ();
    await wait(80);
    const kept = !!l.maskPx, said = ed.status;
    ed.canvas.dispatchEvent(ev("pointermove", 260, 220));
    await wait(30);
    ed.canvas.dispatchEvent(ev("pointerup", 300, 240));
    await wait(100);
    out.mask = { kept, steps: ed.undo.length - n0, said, pointer: ed.pointer ? ed.pointer.kind : null };
    if (!kept || out.mask.steps !== 1 || out.mask.pointer) fails.push("mask stroke: " + JSON.stringify(out.mask));
    if (l.maskPx) ed.toggleMaskEdit(l);
    // a marquee drag: its step is pushed at pointer down
    ed.setTool("rect");
    await run("select_none", { doc: window.__t });
    const n1 = ed.undo.length;
    ed.canvas.dispatchEvent(ev("pointerdown", 500, 100));
    ed.canvas.dispatchEvent(ev("pointermove", 600, 200));
    await wait(20);
    ctrlZ();
    await wait(50);
    ed.canvas.dispatchEvent(ev("pointermove", 700, 300));
    await wait(20);
    ed.canvas.dispatchEvent(ev("pointerup", 700, 300));
    await wait(50);
    const drawn = ed.getBounds(), steps = ed.undo.length - n1;
    await ed.undoStep();
    out.marquee = { drawn, steps, afterUndo: ed.getBounds() };
    if (steps !== 1 || !drawn || out.marquee.afterUndo) fails.push("marquee: " + JSON.stringify(out.marquee));
    out.errors = errors;
    if (errors.length) fails.push("errors: " + JSON.stringify(errors));
} finally {
    window.removeEventListener("error", onErr);
    ed.setTool("select");
}
if (fails.length) throw new Error(fails.join(" | "));
return out;
"""),
    ("undo_does_not_run_over_edits_made_while_it_loads", """
// C1 close-out: a restore took its step off the stack and then awaited the step's PNG, so an edit
// made in that window was overwritten when the restore landed (and the history then held a step for
// pixels that never existed); an undo that waited for a grow took back the edit made during the wait
// instead; extend, crop, resize and merge into the base pushed their step after the upload without
// being waited for; flatten kept the history and had no step of its own.
await run("new_canvas", { width: 800, height: 600, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
await wait(200);
const fails = [], out = {};
const find = (id) => ed.layers.find((l) => l.id === id);
const pix = (L, x, y) => { const l = find(L.id); return l ? Array.from(l.px.readRect(x, y, 1, 1).data).join(",") : "gone"; };
const stroke = (L, rect, color) => {   // what commitStroke does: the rectangle's step first, then the write
    const l = find(L.id);
    ed.pushUndoSnapshot(ed.snapshotRect(l, { x: rect[0], y: rect[1], w: rect[2] - rect[0], h: rect[3] - rect[1] }));
    l.px.fill(rect, color);
    ed.markLayerChanged(l, rect);
};
const reset = async () => {
    await run("select_none", { doc: window.__t });
    ed.layers = []; ed.activeLayerId = null;
    ed.clearUndo();
    ed.renderLayers(); ed.draw();
};
ed.brushOpacity = 1;
// 1. a stroke while an undo decodes the PNG of a fill
try {
    await reset();
    const L = ed.addPaintLayer();
    ed.activeLayerId = L.id;
    await run("select_rect", { x: 100, y: 100, w: 400, h: 300, doc: window.__t });
    ed.color = "#ff0000"; ed.fillSelection();
    // on tiles the fill's step is a clone, not a PNG (C2's final review): nothing to decode, the undo lands before the stroke
    const png = !!ed.undo[ed.undo.length - 1].url;
    const u = ed.undoStep();
    stroke(L, [200, 200, 260, 260], "#0000ff");
    await u;
    const a = { png, afterUndo: pix(L, 230, 230), said: ed.status };
    await ed.undoStep(); a.strokeUndone = [pix(L, 230, 230), pix(L, 300, 300)];
    await ed.undoStep(); a.fillUndone = [pix(L, 230, 230), pix(L, 300, 300)];
    out.fillDecode = a;
    const wantStroke = png ? "255,0,0,255|255,0,0,255" : "0,0,0,0|0,0,0,0";
    if (png === ed.tileMode || a.afterUndo !== "0,0,255,255" || a.strokeUndone.join("|") !== wantStroke || a.fillUndone.join("|") !== "0,0,0,0|0,0,0,0") fails.push("a stroke during an undo's decode: " + JSON.stringify(a));
} catch (err) { fails.push("1 threw: " + (err && err.message)); }
// 2. a stroke while an undo waits for a grow in the worker
try {
    await reset();
    const L = ed.addPaintLayer();
    ed.activeLayerId = L.id;
    await run("select_rect", { x: 300, y: 200, w: 100, h: 100, doc: window.__t });
    const g = ed.growSelection(20);
    const u = ed.undoStep();
    stroke(L, [50, 50, 90, 90], "#00ff00");
    await Promise.all([g, u]);
    const b = { afterUndo: pix(L, 70, 70), bounds: ed.getBounds(), said: ed.status };
    out.growWait = b;
    if (b.afterUndo !== "0,255,0,255" || !b.bounds || b.bounds[0] !== 280 || b.bounds[2] !== 420) fails.push("a stroke during an undo's wait for a grow: " + JSON.stringify(b));
} catch (err) { fails.push("2 threw: " + (err && err.message)); }
// 3. a layer added while a canvas redo decodes its selection
try {
    await reset();
    await run("extend_canvas", { right: 200, doc: window.__t });
    await ed.undoStep();
    const p = ed.redoStep();
    const P = ed.addPaintLayer();
    await p;
    const c = { size: [ed.width, ed.height], layer: !!find(P.id), said: ed.status };
    out.canvasRedo = c;
    if (!c.layer || c.size[0] !== 800) fails.push("a layer added during a canvas redo: " + JSON.stringify(c));
} catch (err) { fails.push("3 threw: " + (err && err.message)); }
// 4. an undo pressed while an extended canvas uploads
try {
    await reset();
    const L = ed.addPaintLayer();
    ed.activeLayerId = L.id;
    stroke(L, [10, 10, 40, 40], "#ff00ff");
    const W0 = ed.width;
    const e = ed.extendCanvas({ right: 100 });
    const u = ed.undoStep();
    await Promise.all([e, u]);
    const top = ed.undo[ed.undo.length - 1];
    const d = { size: [ed.width, ed.height], pixel: pix(L, 20, 20), top: top ? top.kind : null, said: ed.status };
    out.extendUpload = d;
    if (d.size[0] !== W0 || d.pixel !== "255,0,255,255" || d.top !== "layerrect") fails.push("an undo during the extension's upload: " + JSON.stringify(d));
} catch (err) { fails.push("4 threw: " + (err && err.message)); }
// 5. an undo pressed while a merge into the base uploads, a layers step below it
try {
    await reset();
    const M = ed.addPaintLayer();
    find(M.id).px.fill(null, "#00ffff"); ed.markLayerChanged(find(M.id));
    const copy = ed.duplicateLayer(find(M.id));      // a layers step; the copy above M
    const baseRef = JSON.stringify(ed.base.ref);
    const m = ed.mergeDown(find(M.id));              // the bottom layer: into the base
    const u = ed.undoStep();
    await Promise.all([m, u]);
    const e = { layers: ed.layers.map((l) => l.id), want: [M.id, copy.id], base: JSON.stringify(ed.base.ref) === baseRef, said: ed.status };
    out.mergeUpload = e;
    if (e.layers.join() !== e.want.join() || !e.base) fails.push("an undo during a merge into the base: " + JSON.stringify(e));
} catch (err) { fails.push("5 threw: " + (err && err.message)); }
// 6. flatten, then undo, with a layers step below
try {
    await reset();
    const baseRef = JSON.stringify(ed.base.ref);
    const F = ed.addPaintLayer();
    find(F.id).px.fill([0, 0, 400, 300], "#ff0000"); find(F.id).opacity = 0.5; find(F.id).blend = "multiply"; ed.markLayerChanged(find(F.id));
    const D = ed.duplicateLayer(find(F.id));         // a layers step holding F
    await ed.flatten();
    const flat = { layers: ed.layers.length, base: JSON.stringify(ed.base.ref) !== baseRef };
    await ed.undoStep();
    const f = { flat, layers: ed.layers.map((l) => l.id), want: [F.id, D.id], base: JSON.stringify(ed.base.ref) === baseRef, said: ed.status };
    out.flatten = f;
    if (flat.layers !== 0 || !flat.base || f.layers.join() !== f.want.join() || !f.base) fails.push("undo after flatten: " + JSON.stringify(f));
} catch (err) { fails.push("6 threw: " + (err && err.message)); }
await reset();
if (fails.length) throw new Error(fails.join(" | "));
return out;
"""),
    ("text_edit_steps_give_their_blob_urls_back", """
// C1 close-out: a text edit takes a step with a PNG of the layer when it starts. A cancelled or
// unchanged edit dropped that step without revoking its blob URL, and closing a tab with a changed
// edit open pushed it after the history had been cleared: a PNG of the layer left behind each time.
const live = new Set();
const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
URL.createObjectURL = (b) => { const u = oc.call(URL, b); live.add(u); return u; };
URL.revokeObjectURL = (u) => { live.delete(u); return orv.call(URL, u); };
const out = {};
try {
    const d = await run("new_document");
    const ed = ednow(d.id);
    await run("new_canvas", { width: 800, height: 600, doc: d.id });
    const T = await ed.addTextLayer(20, 20);
    if (ed.textEdit) ed.endTextEdit(true);
    await wait(400);
    live.clear();
    for (let i = 0; i < 3; i++) { ed.beginTextEdit(T); await wait(120); ed.endTextEdit(false); await wait(120); }
    ed.beginTextEdit(T); await wait(120); ed.endTextEdit(true);     // Enter without a change
    await wait(600);
    out.cancelled = { live: live.size, undo: ed.undo.length };
    live.clear();
    ed.beginTextEdit(T); await wait(200);
    ed.textEdit.ta.value = "changed"; T.text.content = "changed";
    await run("close_document", { doc: d.id, force: true });
    await wait(600);
    out.closed = { live: live.size, undo: ed.undo.length };
} finally {
    URL.createObjectURL = oc; URL.revokeObjectURL = orv;
}
host.shell.activate(ednow(window.__t));
if (out.cancelled.live || out.closed.live || out.closed.undo) throw new Error("text edit steps left blob URLs behind: " + JSON.stringify(out));
return out;
"""),
    ("selection_keeps_its_bounds_through_a_restore_above_1mp", """
// C1 review: above 1 MP the bounds come from the selection's display levels. A saved document
// restored with setValue, and a canvas undo with a frame drawn while it decoded, wrote the
// selection after levels of the empty one had been cached under the same version: no bounds.
await run("new_canvas", { width: 2400, height: 1600, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
await run("select_rect", { x: 300, y: 200, w: 600, h: 400, doc: window.__t });
const want = JSON.stringify([300, 200, 900, 600]);
const out = { before: ed.getBounds() };
const state = ed.getValue();
const d2 = await run("new_document");
const ed2 = ednow(d2.id);
// a getValue while the layers load (the autosave, ComfyUI serializing the graph) sees the empty
// selection setBase left; the restored one has to be encoded again after it is written (close-out)
const setBase = ed2.setBase;
ed2.setBase = async function (...a) { const r = await setBase.apply(this, a); this.getValue(); return r; };
try { await ed2.setValue(state); } finally { delete ed2.setBase; }
for (let i = 0; i < 200 && (ed2._loading || !ed2.base); i++) await wait(50);
out.restored = ed2.getBounds();
const selected = async (url) => {
    if (!url) return null;
    const img = new Image(); img.src = url; await img.decode();
    const k = document.createElement("canvas"); k.width = img.naturalWidth; k.height = img.naturalHeight;
    const g = k.getContext("2d"); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, k.width, k.height).data; let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 127) n++;
    return n;
};
out.saved = await selected(JSON.parse(ed2.getValue()).selection);
await run("close_document", { doc: d2.id, force: true });
host.shell.activate(ed);
if (JSON.stringify(out.restored) !== want) throw new Error("the restored selection lost its bounds: " + JSON.stringify(out));
if (out.saved !== 240000) throw new Error("getValue after the restore saves another selection: " + JSON.stringify(out));
await run("extend_canvas", { right: 400, bottom: 400, doc: window.__t });
ed.view.scale = 0.25;
const u = ed.undoStep();
ed.draw();                                  // a frame while the canvas step decodes its selection
await u;
out.undone = { size: [ed.width, ed.height], bounds: ed.getBounds() };
if (JSON.stringify(out.undone.bounds) !== want) throw new Error("the canvas undo lost the selection's bounds: " + JSON.stringify(out));
ed.fitView();
return out;
"""),
    ("selection_brush_levels_follow_each_dab", """
// C1 review: the selection brush refreshed the display levels before it drew the dab, so a fast
// stroke zoomed out showed only parts of itself until the button came up.
await run("new_canvas", { width: 3000, height: 2000, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
await run("select_none", { doc: window.__t });
ed.view.scale = 0.25;
ed._pyramidBudget = Infinity;
ed.displaySource(ed.sel, 0.25);                 // the levels exist, as after a zoomed-out frame
const size = ed.brushSize;
ed.brushSize = 20;
ed.pointer = { kind: "selpaint", last: [200, 1000], path: [[200, 1000]], subtract: false };
let last = [200, 1000];
ed.selectionDab(200, 1000, 200, 1000);
for (let x = 280; x <= 2600; x += 80) { ed.selectionDab(last[0], last[1], x, 1000); ed.pointer.last = [x, 1000]; last = [x, 1000]; }
ed.pointer = null;
const litOn = (lvl) => {
    const f = lvl.width / 3000, row = Math.round(1000 * f);
    const d = lvl.getContext("2d").getImageData(0, row, lvl.width, 1).data;
    let n = 0; for (let x = Math.round(220 * f); x < Math.round(2560 * f); x++) if (d[x * 4 + 3] > 128) n++;
    return n;
};
const shown = litOn(ed.displaySource(ed.sel, 0.25));
ed.touchSource(ed.sel);
const fresh = litOn(ed.displaySource(ed.sel, 0.25));
ed.brushSize = size;
ed.markSelectionChanged();
await run("select_none", { doc: window.__t });
ed.fitView();
const out = { shown, fresh };
if (fresh < 500 || shown < fresh - 2) throw new Error("the levels lag behind the dabs: " + JSON.stringify(out));
return out;
"""),
    ("undo_step_whose_encode_failed_says_so", """
// C1 review: a whole-layer undo step is a PNG of the layer as it was. When the worker could not
// encode it, the fallback encoded the canvas after the edit, and the undo silently put the edit
// back. Such a step fails now and the status line says so.
await run("new_canvas", { width: 400, height: 300, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const L = ed.addPaintLayer();
ed.activeLayerId = L.id;
await run("select_rect", { x: 50, y: 50, w: 200, h: 100, doc: window.__t });
ed.color = "#ff0000"; ed.brushOpacity = 1;
const cib = window.createImageBitmap;
window.createImageBitmap = () => Promise.reject(new Error("editor_test: no bitmap"));
try { ed.fillSelection(); } finally { window.createImageBitmap = cib; }
await wait(300);
const step = ed.undo[ed.undo.length - 1];
const png = !!step.url, clone = !!step.px;   // read before the undo releases the step
await ed.undoStep();
const d = L.px.readRect(100, 100, 1, 1).data;
const out = { tiles: ed.tileMode, png, clone, status: ed.status, pixel: Array.from(d) };
// on tiles the step holds a clone of the tiles and no PNG (C2's final review): nothing to lose, the undo puts the layer back
if (ed.tileMode) { if (png || !clone || d[3] !== 0 || /could not be restored/.test(ed.status)) throw new Error("the fill's step on tiles: " + JSON.stringify(out)); }
else if (!/could not be restored/.test(ed.status)) throw new Error("the lost undo step went unnoticed: " + JSON.stringify(out));
return out;
"""),
    ("mask_brush_stroke_undo_and_redo", """
// c6bc6a6 (the C1 close-out) decodes a step's images before it takes the step off its stack, and read
// a "layerrect" step's `mask` (the flag of a mask stroke) as an image: every undo of a mask brush stroke
// failed with "could not load true" and the stroke stayed. A real stroke with the brush on a layer mask,
// through the pointer handlers: undo gives the mask from before to the byte, redo gives the stroke back,
// the layer's own pixels are never touched, and neither the status line nor the console says "could not".
await run("new_canvas", { width: 1200, height: 900, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
ed.fitView();
const out = {};
const errors = [];
const consoleError = console.error;
console.error = function (...a) { errors.push(a.map((x) => String((x && x.message) || x)).join(" ")); return consoleError.apply(this, a); };
const onRejection = (e) => errors.push("unhandled rejection: " + String((e.reason && e.reason.message) || e.reason));
window.addEventListener("unhandledrejection", onRejection);
const all = (p) => p.readRect(0, 0, p.width, p.height).data.slice();
const exact = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const worst = (a, b) => { if (a.length !== b.length) return 255; let m = 0; for (let i = 0; i < a.length; i += 4) { const aa = a[i + 3], ba = b[i + 3]; let v = Math.abs(aa - ba); for (let k = 0; k < 3; k++) v = Math.max(v, Math.abs(a[i + k] * aa / 255 - b[i + k] * ba / 255)); if (v > m) m = v; } return +m.toFixed(1); };
const find = (id) => ed.layers.find((l) => l.id === id);
let id = null;
try {
    const M = ed.addPaintLayer();
    id = M.id;
    M.px.fill(null, "#ff0000"); ed.markLayerChanged(M);
    await run("select_rect", { x: 200, y: 200, w: 800, h: 500, doc: window.__t });
    ed.maskFromSelection(M);
    ed.clearSelection();
    const layer0 = all(M.px), mask0 = all(M.maskPx);
    ed.toggleMaskEdit(M);
    ed.brushSize = 60; ed.hardness = 1; ed.brushOpacity = 1;
    ed.draw(); await wait(50);
    const rect = ed.canvas.getBoundingClientRect();
    const client = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 21, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
    // below the mask's rectangle, where it hides the layer: the brush reveals there
    ed.canvas.dispatchEvent(ev("pointerdown", 300, 800));
    out.kind = ed.pointer && ed.pointer.kind;
    for (let i = 1; i <= 8; i++) { ed.canvas.dispatchEvent(ev("pointermove", 300 + 75 * i, 800)); await wait(16); }
    ed.canvas.dispatchEvent(ev("pointerup", 900, 800));
    await wait(80);
    const step = ed.undo[ed.undo.length - 1];
    const mask1 = all(find(id).maskPx);
    out.stroke = { tool: ed.tool, maskEdit: M.maskEdit, step: step && step.kind, flag: step && step.mask, revealed: find(id).maskPx.readRect(600, 800, 1, 1).data[3], hiddenBefore: mask0[(800 * 1200 + 600) * 4 + 3], size: [M.maskPx.width, M.maskPx.height] };
    if (out.kind !== "maskpaint" || !step || step.kind !== "layerrect" || step.mask !== true) throw new Error("the gesture did not become a mask stroke with its rect step: " + JSON.stringify(out));
    if (out.stroke.revealed < 250 || out.stroke.hiddenBefore !== 0 || exact(mask1, mask0)) throw new Error("the stroke did not reach the mask: " + JSON.stringify(out));
    const u = await run("undo", { doc: window.__t });
    const maskU = all(find(id).maskPx);
    out.undo = { status: ed.status, redo: u.redo, exact: exact(maskU, mask0), worst: worst(maskU, mask0) };
    if (/could not/i.test(ed.status) || !out.undo.exact || u.redo < 1) throw new Error("the undo of the mask stroke failed: " + JSON.stringify(out) + " " + JSON.stringify(errors));
    const r = await run("redo", { doc: window.__t });
    const maskR = all(find(id).maskPx);
    out.redo = { status: ed.status, undo: r.undo, exact: exact(maskR, mask1), worst: worst(maskR, mask1) };
    if (/could not/i.test(ed.status) || out.redo.worst > 1) throw new Error("the redo did not give the mask stroke back: " + JSON.stringify(out) + " " + JSON.stringify(errors));
    out.layerUntouched = exact(all(find(id).px), layer0);
    if (!out.layerUntouched) throw new Error("the mask stroke, its undo or its redo changed the layer's own pixels: " + JSON.stringify(out));
    await wait(100);
    if (errors.length) throw new Error("console errors: " + JSON.stringify(errors));
} finally {
    console.error = consoleError;
    window.removeEventListener("unhandledrejection", onRejection);
    const L = id != null && find(id);
    if (L && L.maskEdit) ed.toggleMaskEdit(L);
    if (L) await run("remove_layer", { layer: id, doc: window.__t });
    ed.setTool("select");
}
return out;
"""),
    ("live_stroke_preview_shows_what_the_commit_writes", """
// C5 (a): the live preview of a stroke is composed inside the region the pass draws, at the pass's
// resolution (layerRegionView), instead of in a canvas as large as the layer filled from the layer's
// display canvas. What the preview shows has to be what the commit then writes: at 1:1 neither path
// resamples, so the screen just before the commit and just after it are the same pixels. Five
// gestures: paint, erase, alpha lock, a masked layer and a stroke on the mask itself, the first of
// them clipped to a selection. On tiles the stroke must make no display mirror and no pyramid entry.
// The frames during a gesture are drawn without `sceneSig = null`: until 0.1.14 this step cleared the scene
// cache's key by hand before every draw, which is exactly what a dab had stopped doing since 28bfad0, so it
// passed while the app showed no stroke until the release. The real pointer path is
// `live_stroke_reaches_the_screen_before_the_release`.
const P = await import("./editor/inpaint_pixels.js");
const d = await run("new_document");
window.__tv = d.id;
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { width: 2400, height: 1600, doc: d.id });
const { Layer: LayerPixels, Mask: MaskPixels } = ed.pixels;
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const pattern = () => {
    const c = mk(2400, 1600), x = c.getContext("2d");
    x.fillStyle = "#204080"; x.fillRect(0, 0, 2400, 1600);
    for (let i = 0; i < 60; i++) { x.fillStyle = `hsl(${(i * 37) % 360},70%,55%)`; x.fillRect((i * 211) % 2300, (i * 97) % 1500, 90, 70); }
    return c;
};
// the GPU compositor would draw the frame after the commit and the Canvas 2D path the frames before
// it; this step compares the two moments, so both take the same path
const compOff = ed.compositorOff;
ed.compositorOff = true;
ed.setTool("paint");
ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false;
ed.view.x = -700; ed.view.y = -500;
ed.hover = null;
ed.brushSize = 90; ed.hardness = 0.6; ed.eraseHardness = 0.6; ed.brushOpacity = 0.7; ed.color = "#ff2050";
// one readback per shot: 400 single-pixel getImageData calls would switch canvas acceleration off
// for the whole document (docs/PLAN_BCE.md §C2, html_canvas_element.cc)
const c0 = ed.imageToScreen(760, 820).map(Math.round), c1 = ed.imageToScreen(1300, 1060).map(Math.round);
const SX = c0[0], SY = c0[1], SW = c1[0] - c0[0], SH = c1[1] - c0[1];
if (SW < 100 || SH < 100 || SX < 0 || SY < 0) throw new Error("the sample rectangle is not on screen: " + JSON.stringify([SX, SY, SW, SH]));
const shot = () => ed.canvas.getContext("2d").getImageData(SX, SY, SW, SH).data;
const diff = (a, b) => { let worst = 0, n = 0; for (let i = 0; i < a.length; i++) { const q = Math.abs(a[i] - b[i]); if (q) n++; if (q > worst) worst = q; } return [worst, n]; };
const out = { tiles: ed.tileMode, cases: {} };
const one = async (name, opts) => {
    const L = ed.addLayer({ name, kind: "paint", px: LayerPixels.fromCanvas(pattern()), x: 0, y: 0, w: 2400, h: 1600, dirty: true });
    if (opts.mask) {
        L.maskPx = ed.pixels.Mask.empty(2400, 1600);
        L.maskPx.fill([0, 0, 1100, 1600], "#ffffff");
        ed.markMaskChanged(L);
    }
    L.alphaLock = !!opts.alphaLock;
    ed.activeLayerId = L.id;
    ed.markLayerChanged(L);
    if (opts.sel) await run("select_rect", { x: 600, y: 700, w: 800, h: 500, doc: d.id });
    else await run("select_none", { doc: d.id });
    ed.sceneSig = null; ed.draw(); await wait(60); ed.sceneSig = null; ed.draw(); await wait(60);
    const target = opts.kind === "maskpaint" ? L.maskPx : L.px;
    const p = { kind: opts.kind, layer: L, stroke: ed.newStrokeBuffer(target), clip: ed.strokeClip(L, target),
                erase: !!opts.erase, white: opts.kind === "maskpaint", last: [800, 900], pressure: 1 };
    ed.pointer = p;
    let passCheck = null;
    for (let i = 1; i <= 8; i++) {
        const x = 800 + i * 56, y = 900 + (i % 3) * 26;
        ed.layerDab(p, p.last[0], p.last[1], x, y);
        p.last = [x, y];
        if (i === 4) {
            // C6 (c2): a sampled pass between two dabs whose size is not a whole number of pixels (76.8 px high), as the
            // film panel's flatten or the flood's coarse pass: it composes the layer in a scratch of its own, so the
            // screen's stroke scratch, its signature and the dab box waiting for the next frame stay the screen's,
            // and it makes no `_masked` canvas and no display mirror
            const sv = ed.strokeView, sig = ed._strokeViewSig, dirty = p.dirtyView;
            const small = ed.sampleRegion("image", [0, 0, 2400, 1600], 115.2 / 2400, { forRun: true });
            passCheck = { size: [small.width, small.height], kept: ed.strokeView === sv, sig: ed._strokeViewSig === sig, of: ed._strokeViewOf === p, dirty: p.dirtyView === dirty && !!dirty };
            if (!passCheck.kept || !passCheck.sig || !passCheck.of || !passCheck.dirty) throw new Error(name + ": a sampled pass took the screen's stroke scratch: " + JSON.stringify(passCheck));
            if (ed.tileMode && opts.mask && L._masked) throw new Error(name + ": a sampled pass of " + small.width + " x " + small.height + " made the masked layer's `_masked` canvas");
            if (ed.tileMode && (P.displayCanvasIfMade(L.px) || (L.maskPx && P.displayCanvasIfMade(L.maskPx)))) throw new Error(name + ": a sampled pass made a display mirror of the layer or its mask");
            // C6 (c2e): the layer list drawn during the gesture: on tiles the row comes from the layer's thumbnail (the layer
            // as it was before the stroke), not from full-size live previews filled from its mirror
            const tc = L.px.thumbnailCanvas;
            let thumbs = 0;
            L.px.thumbnailCanvas = function (...a) { thumbs++; return tc.apply(this, a); };
            try { ed.renderLayers(); } finally { delete L.px.thumbnailCanvas; }
            passCheck.row = { thumbs, previews: [!!ed.strokePreview, !!ed.maskedPreview, !!ed.maskPreview] };
            if (ed.tileMode && (!thumbs || passCheck.row.previews.some(Boolean))) throw new Error(name + ": the layer's row drawn during the stroke did not come from its thumbnail: " + JSON.stringify(passCheck.row));
            if (ed.tileMode && (P.displayCanvasIfMade(L.px) || (L.maskPx && P.displayCanvasIfMade(L.maskPx)))) throw new Error(name + ": the layer's row drawn during the stroke made a display mirror");
        }
        ed.hover = null; ed.draw();   // never `sceneSig = null` during the gesture: a dab has to move the scene's key itself (0.1.13)
    }
    await wait(40); ed.hover = null; ed.draw(); await wait(40);
    const used = !!(ed.strokeView && ed._strokeViewOf === p);
    const mirror = ed.tileMode ? !!P.displayCanvasIfMade(L.px) : null;
    const pyramid = ed.tileMode ? !!ed.pyramids.get(P.displayCanvasIfMade(L.px)) : null;
    const before = shot();
    const box = ed.strokeRect(p, target);
    ed.commitStroke(p);
    ed.pointer = null;
    if (opts.kind === "maskpaint") ed.markMaskChanged(L, box); else ed.markLayerChanged(L, box);
    ed.releaseStrokeScratch();
    ed.hover = null; ed.sceneSig = null; ed.draw(); await wait(60); ed.sceneSig = null; ed.draw(); await wait(60);
    const after = shot();
    const [worst, n] = diff(before, after);
    out.cases[name] = { used, mirror, pyramid, worst, differing: n, bytes: before.length, pass: passCheck };
    if (!used) throw new Error(name + ": the region preview was not the path taken");
    if (ed.tileMode && (mirror || pyramid)) throw new Error(name + ": the stroke made a display mirror or a pyramid entry: " + JSON.stringify(out.cases[name]));
    if (ed.tileMode && opts.mask && L._masked) throw new Error(name + ": a masked tile layer still made its `_masked` canvas: " + JSON.stringify(out.cases[name]));
    if (worst > 2) throw new Error(name + ": the preview is not what the commit wrote (" + worst + " levels on " + n + " of " + before.length + " bytes)");
    if (opts.mask) {
        // C6 (c2): a sampled pass at 1:1 composes the masked layer in its own scratch: the pixels of the whole-resolution
        // flatten, byte for byte, over the mask's edge and where the mask has no tile at all (the layer hidden there)
        const flat = ed.flattenToCanvas({ forRun: true }).getContext("2d");
        passCheck.exact = [];
        for (const box of [[900, 800, 1300, 1100], [1600, 800, 2000, 1100]]) {
            const a = ed.sampleRegion("image", box, 1, { forRun: true }).getContext("2d").getImageData(0, 0, 400, 300).data;
            const f = flat.getImageData(box[0], box[1], 400, 300).data;
            const [pw, pn] = diff(a, f);
            passCheck.exact.push([pw, pn]);
            if (pw > 0) throw new Error(name + ": a sampled pass over the masked layer at " + JSON.stringify(box) + " differs from the flatten by " + pw + " levels on " + pn + " bytes");
        }
    }
    ed.removeLayer(L.id);
    ed.renderLayers();
};
// how much a stroke changes at all, so the comparison above cannot pass on an empty preview
const emptyL = ed.addLayer({ name: "reach", kind: "paint", px: LayerPixels.fromCanvas(pattern()), x: 0, y: 0, w: 2400, h: 1600, dirty: true });
ed.activeLayerId = emptyL.id;
await run("select_none", { doc: d.id });
ed.markLayerChanged(emptyL);
ed.sceneSig = null; ed.draw(); await wait(60);
const clean = shot();
{
    const p = { kind: "layerpaint", layer: emptyL, stroke: ed.newStrokeBuffer(emptyL.px), clip: null, erase: false, last: [800, 900], pressure: 1 };
    ed.pointer = p;
    for (let i = 1; i <= 8; i++) { const x = 800 + i * 56, y = 900 + (i % 3) * 26; ed.layerDab(p, p.last[0], p.last[1], x, y); p.last = [x, y]; ed.hover = null; ed.draw(); }
    await wait(40); ed.hover = null; ed.draw(); await wait(40);
    out.reach = diff(clean, shot());
    ed.pointer = null;
    ed.releaseStrokeScratch();
}
ed.removeLayer(emptyL.id);
if (out.reach[0] < 40 || out.reach[1] < 5000) throw new Error("the stroke barely changes the screen, so the comparison proves nothing: " + JSON.stringify(out.reach));
await one("paint_clipped", { kind: "layerpaint", sel: true });
await one("paint", { kind: "layerpaint" });
await one("erase", { kind: "layerpaint", erase: true });
await one("alpha_lock", { kind: "layerpaint", alphaLock: true });
await one("masked", { kind: "layerpaint", mask: true });
await one("mask_stroke", { kind: "maskpaint", mask: true });
// a shape gesture dragged out and then back in: the shape is redrawn from nothing on every move,
// so the preview has to show the small rectangle, not the big one the drag passed through
{
    const L = ed.addLayer({ name: "shape", kind: "paint", px: LayerPixels.fromCanvas(pattern()), x: 0, y: 0, w: 2400, h: 1600, dirty: true });
    ed.activeLayerId = L.id;
    ed.markLayerChanged(L);
    await run("select_none", { doc: d.id });
    ed.setTool("shape");
    ed.color = "#00c0ff";
    ed.shapeOpts = { kind: "rectangle", fill: true, stroke: false, width: 4, radius: 0, color: "#000000" };
    ed.sceneSig = null; ed.draw(); await wait(60);
    ed.shapePointerDown(700, 750, {}, false);
    const p = ed.pointer;
    if (!p || !p.stroke) throw new Error("the shape tool refused the gesture: " + ed.status);
    ed.shapeDab(p, 1500, 1300, {});
    ed.hover = null; ed.draw(); await wait(40);
    ed.shapeDab(p, 900, 900, {});
    ed.hover = null; ed.draw(); await wait(40);
    const used = !!(ed.strokeView && ed._strokeViewOf === p);
    const before = shot();
    const box = ed.strokeRect(p, L.px);
    ed.commitStroke(p);
    ed.pointer = null;
    ed.markLayerChanged(L, box);
    ed.releaseStrokeScratch();
    ed.hover = null; ed.sceneSig = null; ed.draw(); await wait(60); ed.sceneSig = null; ed.draw(); await wait(60);
    const [worst, n] = diff(before, shot());
    out.cases.shape = { used, worst, differing: n };
    if (!used) throw new Error("shape: the region preview was not the path taken");
    if (worst > 2) throw new Error("shape: the preview is not what the commit wrote (" + worst + " levels on " + n + " of " + before.length + " bytes)");
    ed.removeLayer(L.id);
    ed.renderLayers();
    ed.setTool("paint");
}
ed.compositorOff = compOff;
await run("select_none", { doc: d.id });
return out;
"""),
    ("live_stroke_reaches_the_screen_before_the_release", lambda c: live_stroke_reaches_the_screen_before_the_release(c)),
    ("a_masked_filter_layer_reads_its_mask_from_tiles", """
// C6 (c2c): a filter layer's mask in a region pass (the screen with a filter layer in the stack, a sampled pass) is drawn from
// the mask's tiles at the pass's level, and a mask stroke on the filter layer is composed in a scratch of the pass's size: no
// display mirror of the mask and no full-size live preview of it. Both backends (the canvas backend keeps its path).
const P = await import("./editor/inpaint_pixels.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { width: 2400, height: 1600, doc: d.id });
const W = 2400, H = 1600;
const base = document.createElement("canvas"); base.width = W; base.height = H;
{
    const x = base.getContext("2d");
    x.fillStyle = "#30507a"; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 80; i++) { x.fillStyle = `hsl(${(i * 41) % 360},70%,${30 + (i * 7) % 40}%)`; x.fillRect((i * 283) % (W - 100), (i * 131) % (H - 80), 100, 80); }
}
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "fmask.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const F = ed.addFilterLayer("invert");
F.maskPx = ed.pixels.Mask.empty(W, H);
F.maskPx.fill([0, 0, 1100, H], "#ffffff");
ed.markMaskChanged(F);
ed.renderLayers();
ed.setTool("rect");
ed.hover = null;
ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false;
ed.view.x = -700; ed.view.y = -500;
ed.sceneSig = null; ed.draw(); await ed.mipsSettled(); await wait(60); ed.sceneSig = null; ed.draw(); await wait(60);
const out = { tiles: ed.tileMode };
// the screen at 1:1 against the whole flatten: a region of screen pixels is a region of image pixels
const c0 = ed.imageToScreen(900, 700).map(Math.round);
const SW = 400, SH = 300;
const ix = Math.round(ed.canvasToImage(c0[0], c0[1])[0]), iy = Math.round(ed.canvasToImage(c0[0], c0[1])[1]);
const screen = () => ed.canvas.getContext("2d").getImageData(c0[0], c0[1], SW, SH).data;
const diff = (a, b) => { let worst = 0, n = 0; for (let i = 0; i < a.length; i++) { const q = Math.abs(a[i] - b[i]); if (q) n++; if (q > worst) worst = q; } return [worst, n]; };
const flatAt = () => ed.flattenToCanvas({ forRun: true }).getContext("2d").getImageData(ix, iy, SW, SH).data;
const s0 = screen();
out.mirrorAfterScreen = ed.tileMode ? !!P.displayCanvasIfMade(F.maskPx) : null;
const [sw0, sn0] = diff(s0, flatAt());
out.screen = [sw0, sn0, ix, iy];
if (sw0 > 2) throw new Error("the screen with the masked filter layer differs from the flatten by " + sw0 + " levels on " + sn0 + " bytes");
if (out.mirrorAfterScreen) throw new Error("the screen made the filter mask's display mirror");
// the split on either side of the mask's edge: inverted left, plain right, at 1:1 and in a sampled pass at 0.08
ed.releaseCaches({ mirrors: true });
const small = ed.sampleRegion("image", [0, 0, W, H], 0.08, { forRun: true }).getContext("2d").getImageData(0, 0, 192, 128).data;
if (ed.tileMode && P.displayCanvasIfMade(F.maskPx)) throw new Error("a sampled pass made the filter mask's display mirror");
F.visible = false;
const plain = ed.sampleRegion("image", [0, 0, W, H], 0.08, { forRun: true }).getContext("2d").getImageData(0, 0, 192, 128).data;
F.visible = true;
// the mask's edge is at 1100 px, 88 px in the pass: inverted to its left, untouched to its right
let inv = 0, same = 0;
for (let y = 0; y < 128; y++) for (let x = 0; x < 192; x++) {
    if (x > 84 && x < 92) continue;
    const i = (y * 192 + x) * 4;
    for (let k = 0; k < 3; k++) {
        if (x <= 84) inv = Math.max(inv, Math.abs(small[i + k] - (255 - plain[i + k])));
        else same = Math.max(same, Math.abs(small[i + k] - plain[i + k]));
    }
}
out.sampled = { invertedLeft: inv, plainRight: same };
if (inv > 2 || same > 1) throw new Error("the sampled pass's split at the filter mask's edge is off: " + JSON.stringify(out.sampled));
// a mask stroke on the filter layer: the frames before the commit against the frame after it
ed.sceneSig = null; ed.draw(); await wait(60);
ed.activeLayerId = F.id;
ed.brushSize = 90; ed.hardness = 0.6; ed.brushOpacity = 1;
const p = { kind: "maskpaint", layer: F, stroke: ed.newStrokeBuffer(F.maskPx), clip: null, erase: true, white: true, last: [900, 850], pressure: 1 };
ed.pointer = p;
for (let i = 1; i <= 8; i++) { const x = 900 + i * 20, y = 850 + (i % 3) * 20; ed.layerDab(p, p.last[0], p.last[1], x, y); p.last = [x, y]; ed.hover = null; ed.sceneSig = null; ed.draw(); }
await wait(40); ed.hover = null; ed.sceneSig = null; ed.draw(); await wait(40);
const during = { maskPreview: !!ed.maskPreview, mirror: ed.tileMode ? !!P.displayCanvasIfMade(F.maskPx) : null };
const before = screen();
const box = ed.strokeRect(p, F.maskPx);
ed.commitStroke(p);
ed.pointer = null;
ed.markMaskChanged(F, box);
ed.releaseStrokeScratch();
ed.hover = null; ed.sceneSig = null; ed.draw(); await ed.mipsSettled(); await wait(60); ed.sceneSig = null; ed.draw(); await wait(60);
const after = screen();
const [ws, ns] = diff(before, after), [wr, nr] = diff(s0, after);
out.stroke = { during, worst: ws, differing: ns, reach: [wr, nr] };
if (wr < 100 || nr < 3000) throw new Error("the mask stroke barely changed the screen, so the comparison proves nothing: " + JSON.stringify(out.stroke));
if (ws > 2) throw new Error("the mask stroke's preview on the filter layer is not what the commit wrote: " + ws + " levels on " + ns + " bytes");
if (ed.tileMode && (during.maskPreview || during.mirror)) throw new Error("the mask stroke on the filter layer made a full-size preview or the mask's mirror: " + JSON.stringify(during));
// C6 (c1) review: the pass scratches are counted by memoryReport and given back by releaseCaches (Free VRAM, the memory
// watch); the filter mask's stroke scratch stayed for the tab's life, and none of the three was counted
if (ed.tileMode) {
    const kept = ["_filterMaskView", "_passView", "_passMaskView"].filter((k) => ed[k] && ed[k].width > 1);
    const listed = ed.memoryReport().scratch.list.map((s) => s.name);
    out.passScratches = { kept, listed: kept.filter((k) => listed.includes(k)) };
    if (!kept.includes("_filterMaskView")) throw new Error("the mask stroke on the filter layer kept no pass scratch: the check proves nothing " + JSON.stringify(kept));
    if (kept.some((k) => !listed.includes(k))) throw new Error("memoryReport does not count the pass scratches " + JSON.stringify(kept.filter((k) => !listed.includes(k))));
    ed.releaseCaches({ deep: true, mirrors: true });
    const left = ["_filterMaskView", "_passView", "_passMaskView"].filter((k) => ed[k]);
    if (left.length) throw new Error("releaseCaches kept the pass scratches " + JSON.stringify(left));
}
await run("close_document", { doc: d.id, force: true });
return out;
"""),
    ("peek_shows_the_base_from_its_tiles", """
// C6 (c2f): the peek (the button or holding the backslash) draws the base alone as the view's composite, from the base's tiles:
// no display mirror of the base, no GPU copy of one and no pyramid. Both backends, on the GPU path and on Canvas 2D.
const P = await import("./editor/inpaint_pixels.js");
const T = await import("./editor/inpaint_tiles.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await run("new_canvas", { width: 3000, height: 2000, doc: d.id });
const W = 3000, H = 2000;
const mkBase = (hue) => {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, `hsl(${hue},60%,30%)`); g.addColorStop(1, `hsl(${hue + 60},60%,60%)`);
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 50; i++) { x.fillStyle = `hsl(${(i * 53 + hue) % 360},70%,50%)`; x.fillRect((i * 331) % (W - 120), (i * 173) % (H - 90), 120, 90); }
    Object.defineProperty(c, "naturalWidth", { value: W }); Object.defineProperty(c, "naturalHeight", { value: H });
    return c;
};
await ed.setBase({ filename: "peek.png", subfolder: "inpaint_canvas", type: "input" }, mkBase(200), { keepLayers: false });
const L = ed.addPaintLayer();
L.px.fill([1000, 600, 2000, 1400], "#ff00ff");
ed.markLayerChanged(L);
ed.renderLayers();
ed.setTool("rect");
ed.hover = null;
ed.fitView();
const g = ed.canvas.getContext("2d");
const [cx, cy] = ed.imageToScreen(1500, 1000).map(Math.round);
const [ax, ay] = ed.imageToScreen(300, 200).map(Math.round), [bx, by] = ed.imageToScreen(2700, 1800).map(Math.round);
const shot = () => g.getImageData(ax, ay, bx - ax, by - ay).data;
const px = () => Array.from(g.getImageData(cx, cy, 1, 1).data.slice(0, 3));
const frame = async () => { ed.hover = null; ed.sceneSig = null; ed.draw(); await ed.mipsSettled(); await wait(40); ed.hover = null; ed.sceneSig = null; ed.draw(); await wait(40); };
const diff = (a, b) => { let worst = 0, n = 0; for (let i = 0; i < a.length; i++) { const q = Math.abs(a[i] - b[i]); if (q) n++; if (q > worst) worst = q; } return [worst, n]; };
const out = { tiles: ed.tileMode, paths: {} };
for (const path of ["gpu", "2d"]) {
    const compOff = ed.compositorOff;
    ed.compositorOff = path === "2d";
    ed.releaseCaches({ mirrors: true });
    await frame();
    const layerColour = px();
    ed.peekBase = true;
    await frame();
    const peek = shot(), peekColour = px();
    const mirror = ed.tileMode ? !!P.displayCanvasIfMade(ed._basePx) : null;
    const pyramid = ed.tileMode ? !!(P.displayCanvasIfMade(ed._basePx) && ed.pyramids.get(P.displayCanvasIfMade(ed._basePx))) : null;
    ed.peekBase = false;
    L.visible = false;
    await frame();
    const baseOnly = shot();
    L.visible = true;
    const [worst, n] = diff(peek, baseOnly);
    out.paths[path] = { layerColour, peekColour, mirror, pyramid, worst, differing: n, gl: ed.glCompositeUsable({ baseOnly: true }) };
    ed.compositorOff = compOff;
    if (layerColour[0] < 200 || layerColour[1] > 60) throw new Error(path + ": the layer is not on the screen without the peek: " + layerColour);
    if (peekColour[0] > 200 && peekColour[1] < 60) throw new Error(path + ": the peek still shows the layer: " + peekColour);
    // the canvas backend keeps its peek (the base's canvas through its pyramid, not the view's composite): reported, not compared
    if (ed.tileMode && worst > 2) throw new Error(path + ": the peek differs from the view with every layer hidden by " + worst + " levels on " + n + " bytes");
    if (ed.tileMode && (mirror || pyramid)) throw new Error(path + ": the peek made the base's display mirror or a pyramid of it");
}
// right after a new base, on Canvas 2D: the peek's frame asks the worker for the base's chains, it does not build them
if (ed.tileMode) {
    const compOff = ed.compositorOff;
    ed.compositorOff = true;
    await ed.setBaseFromCanvas(mkBase(20), { keepLayers: true });
    await wait(30);
    T.chainStats(true);
    ed.peekBase = true;
    ed.hover = null; ed.sceneSig = null; ed.draw();
    const cs = T.chainStats();
    out.newBase = { main: cs.main, requested: cs.requested };
    ed.peekBase = false;
    await ed.mipsSettled();
    ed.compositorOff = compOff;
    if (cs.main > T.CHAIN_SYNC_BUDGET) throw new Error("the peek after a new base built " + cs.main + " chains itself");
}
await run("close_document", { doc: d.id, force: true });
return out;
"""),
    ("a_new_mask_and_a_neighbours_write_reach_the_screen", """
// C6 (a), on the screen and on both backends (on canvases there is no atlas and no region view, and the rows
// have to be right all the same).
// (1) A new mask's version was the one the mask it replaced had: a new pixels object started at 0 and was 1
// after its first touch. The atlas's instance cache (GPU path) and the region view's signature (Canvas 2D path,
// a filter layer in the stack) key on the version, so a second "mask from selection" and the undo that puts the
// first mask back kept drawing the mask before. Pixels versions are unique across pixels objects now.
// (2) A slot's gutter is its eight neighbours' edge lines, and a slot counted as current by its own tile's
// version: a write that ends on a tile border, or the undo of a fill (which puts whole tiles back), left the
// neighbours' slots with the old edge line, which LINEAR sampling reads at the border. The screen after the
// write is compared with the same view drawn from nothing (every cache released).
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = { tiles: ed.tileMode, masks: [], borders: [] };
const fails = [];
const g = ed.canvas.getContext("2d");
const frame = async (n = 3) => { for (let i = 0; i < n; i++) { ed.hover = null; ed.sceneSig = null; ed.draw(); await wait(25); } await ed.mipsSettled(); ed.hover = null; ed.sceneSig = null; ed.draw(); };
const at = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return Array.from(g.getImageData(Math.round(sx), Math.round(sy), 1, 1).data); };
const blue = (q) => q[2] > 150 && q[0] < 120;
const red = (q) => q[0] > 150 && q[2] < 120;
await run("new_canvas", { width: 2400, height: 1600, doc: d.id });
const L = ed.addPaintLayer();
L.px.fill([0, 0, 2400, 1600], "#2040ff"); ed.markLayerChanged(L);
ed.renderLayers();
ed.fitView();
const hasGl = !!ed.compositor();
const mask = async (label, left, right, path, now = false) => {
    // `now`: the frame the operation drew itself, read before any task runs (nothing draws again until the
    // pointer moves, so this is what the user sees); otherwise after a few frames of our own
    if (!now) await frame();
    const s = { label, path, now, gl: ed.glCompositeUsable({}), left: blue(at(600, 800)), right: blue(at(1800, 800)) };
    out.masks.push(s);
    if (s.left !== left || s.right !== right) fails.push(path + ", " + label + (now ? " (its own frame)" : "") + ": the screen shows " + JSON.stringify({ left: s.left, right: s.right }) + " where the mask lets through " + JSON.stringify({ left, right }));
    if (hasGl && s.gl !== (path === "gpu")) fails.push(path + ", " + label + ": the view took the other path (glCompositeUsable " + s.gl + ")");
};
for (const path of ["gpu", "2d"]) {
    const fx = path === "2d" ? ed.addFilterLayer("levels") : null;
    ed.renderLayers();
    await run("select_rect", { x: 0, y: 0, w: 1200, h: 1600, doc: d.id });
    ed.maskFromSelection(L);
    await mask("mask from the left half", true, false, path);
    await run("select_rect", { x: 1200, y: 0, w: 1200, h: 1600, doc: d.id });
    ed.hover = null;
    ed.maskFromSelection(L);
    await mask("a second mask, from the right half", false, true, path, true);
    await mask("a second mask, from the right half", false, true, path);
    ed.releaseCaches();   // the undo row is judged from a screen drawn from nothing, not from the row above
    await mask("the second mask from released caches", false, true, path);
    await ed.undoStep();
    await mask("undo: the first mask back", true, false, path);
    ed.removeMask(L);
    await mask("mask removed", true, true, path);
    if (fx) { ed.removeLayer(fx.id); ed.renderLayers(); }
}
await run("select_none", { doc: d.id });
// (2) the borders, on a document of 4 x 4 tiles
const N = 1024;
await run("new_canvas", { width: N, height: N, doc: d.id });
const B = ed.addPaintLayer();
ed.activeLayerId = B.id;
ed.renderLayers();
const box = () => {
    const [ax, ay] = ed.imageToScreen(0, 0), [bx, by] = ed.imageToScreen(N, N);
    const x0 = Math.max(0, Math.floor(ax)), y0 = Math.max(0, Math.floor(ay));
    return [x0, y0, Math.min(ed.canvas.width, Math.ceil(bx)) - x0, Math.min(ed.canvas.height, Math.ceil(by)) - y0];
};
const read = () => { const b = box(); return g.getImageData(b[0], b[1], b[2], b[3]).data; };
const diff = (a, b) => { let worst = 0, n = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i] - b[i]); if (v) { n++; if (v > worst) worst = v; } } return [worst, n]; };
const cases = {
    // the bucket's and a plugin's kind of write: a box that ends exactly on the tile border at x = 512
    "a fill whose box ends on a tile border": async () => { B.px.fill([256, 0, 512, N], "#2040ff"); ed.markLayerChanged(B, [256, 0, 512, N]); await frame(); return blue(at(384, 512)); },
    "the undo of a fill (whole tiles put back)": async () => {
        await run("select_rect", { x: 256, y: 0, w: 256, h: N, doc: d.id });
        ed.clearUndo();
        ed.color = "#2040ff"; ed.brushOpacity = 1; ed.fillSelection();
        await frame();
        const filled = blue(at(384, 512));
        await ed.undoStep();
        if (ed.undo.length || !ed.getBounds()) throw new Error("the undo did not take back the fill");
        await run("select_none", { doc: d.id });
        await frame();
        return filled && red(at(384, 512));
    },
};
// Whether a fragment centre falls within half a texel of a slot's edge (where LINEAR sampling reads the gutter)
// is set by where the composite's region starts: viewportRegion floors it to a whole image pixel, the region's
// size follows the window, and the view's own fraction only enters in the last drawImage. So one view position
// sees the stale gutter or not depending on the window's width (at 0.75 half the widths missed it: C6 a's
// review). Each write is read with the view moved by 0, 1, 2 ... image pixels, which starts the region on each
// pixel of one sampling period (4 image pixels at 0.75, which are 3 screen pixels; 5 at 0.2, one screen pixel),
// so every phase the samples can have against a border is read, whatever the window's width. The step checks
// that the region really started on each of them.
const periods = { 0.75: 4, 0.2: 5 };
const place = (scale, k) => {
    ed.view.angle = 0; ed.view.scale = scale; ed._fitted = false;
    ed.view.x = Math.round(ed.canvas.width / 2 - (N / 2) * scale) + 0.37 + k * scale; ed.view.y = Math.round(ed.canvas.height / 2 - (N / 2) * scale) + 0.41;
};
for (const scale of [0.75, 0.2]) {
    const shifts = Array.from({ length: periods[scale] }, (_, k) => k);
    for (const [name, write] of Object.entries(cases)) {
        await run("select_none", { doc: d.id });
        B.px.fill([0, 0, N, N], "#ff2020"); ed.markLayerChanged(B);
        place(scale, 0);
        ed.clearUndo();
        await frame();
        const comp = ed.compositor();
        const gu0 = comp ? comp.stats().atlas.gutterUploads : 0;
        const wrote = await write();
        const gutterUploads = comp ? comp.stats().atlas.gutterUploads - gu0 : null;
        const gl = ed.glCompositeUsable({});
        // the screen as the write left the atlas, at each shift (a pan uploads nothing: the slots stay as they are)
        const shown = [], regions = [];
        for (const k of shifts) { place(scale, k); await frame(); shown.push(read()); regions.push(ed.viewportRegion().x); }
        ed.releaseCaches();
        for (const [i, k] of shifts.entries()) {
            place(scale, k);
            await frame();
            const [worst, n] = diff(shown[i], read());
            const row = { scale, name, shift: k, regionX: regions[i], gl, wrote, worst, differing: n, gutterUploads };
            out.borders.push(row);
            if (worst > 2) fails.push(scale + ", " + name + ", shift " + k + " px: the screen after the write is not the same view drawn from nothing (" + worst + " levels on " + n + " bytes; a slot kept a neighbour's old edge line)");
        }
        if (!wrote) fails.push(scale + ", " + name + ": the write did not reach the screen (the comparison would pass on nothing)");
        const P = periods[scale];
        const phases = new Set(regions.map((x) => ((x % P) + P) % P));
        if (phases.size !== P) fails.push(scale + ", " + name + ": the shifts' regions start on " + JSON.stringify(regions) + ", not on " + P + " different pixels modulo " + P + " (the rows would not cover the sampling phases)");
        // the rows compare the atlas with itself only if the GPU compositor drew them: a failure in the atlas path
        // puts the editor on Canvas 2D for good (glViewComposite catches it and warns), and Canvas 2D against
        // Canvas 2D passes whatever the gutter does
        if (hasGl && !gl) fails.push(scale + ", " + name + ": the border rows ran on Canvas 2D, not on the GPU compositor (compositorOff " + ed.compositorOff + ")");
        if (hasGl && ed.tileMode && !(gutterUploads > 0)) fails.push(scale + ", " + name + ": the write uploaded no gutter of a neighbour's slot (" + gutterUploads + "), so the rows did not exercise the gutter");
    }
}
if (hasGl && ed.compositorOff) fails.push("the GPU compositor failed during the step and the editor stayed on Canvas 2D (see the console's warning)");
await run("close_document", { doc: d.id, force: true });
if (fails.length) throw new Error(fails.join(" | ") + " " + JSON.stringify(out));
// the printed result is cut at 280 characters: the border rows first, one short line per write
return { tiles: out.tiles, borders: out.borders.map((r) => r.scale + "/" + (r.name.startsWith("the undo") ? "undo" : "fill") + "/" + r.shift + ":" + r.worst + (r.gl ? "" : " 2d") + (r.gutterUploads ? " g" + r.gutterUploads : "")), masks: out.masks.length };
"""),
    ("a_whole_change_builds_its_mips_in_the_worker_and_the_screen_ends_exact", """
// C6 (b), on both backends, on the GPU path and with a filter layer in the stack (Canvas 2D). A 4000 x 3000 layer at
// fit (level 1 or 2 on this screen) is 192 tiles, more than the chains the display may build in one task.
// (i) A whole change (a flip: new pixels) builds at most CHAIN_SYNC_BUDGET chains on the main thread in its own task
// and asks the mips worker for the rest; the frame shows a coarse picture of those tiles meanwhile.
// (ii) Once no chain is on its way the screen is the same view drawn from released caches, the region canvases and
// thumbnails included (releaseCaches with mirrors: the Canvas 2D path draws from region canvases, and a reference drawn
// from the same ones could not see a cell left coarse), and every chain a tile keeps as exact is the kernel's chain of
// its bytes (a landed chain installed on the wrong bytes shows here even when the screen agrees with itself).
// (iii) A second write while the first answers are in flight (a batch really posted: the layer filled in place, so the
// same tiles get new versions, plus thin stripes, so a coarse picture of it is not the exact one): the late answers are
// not installed, and the settled screen shows the fill.
const T = await import("./editor/inpaint_tiles.js");
const K = await import("./editor/px/kernels_js.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await wait(200);
const W = 4000, H = 3000;
await run("new_canvas", { width: W, height: H, doc: d.id });
const c = document.createElement("canvas"); c.width = W; c.height = H;
{
    const x = c.getContext("2d");
    const gr = x.createLinearGradient(0, 0, W, H);
    gr.addColorStop(0, "#1c4f8a"); gr.addColorStop(1, "#e0a040");
    x.fillStyle = gr; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 120; i++) { x.fillStyle = `hsl(${(i * 37) % 360},80%,55%)`; x.beginPath(); x.arc((i * 977) % W, (i * 613) % H, 90, 0, Math.PI * 2); x.fill(); }
    x.fillStyle = "#000"; x.fillRect(0, 0, 900, 400);   // an asymmetric block: a flip moves it
}
const L = ed.addLayer({ name: "Full", kind: "paint", px: ed.pixels.Layer.fromCanvas(c), x: 0, y: 0, w: W, h: H, dirty: true });
if (ed.tileMode) { c.width = 1; c.height = 1; }   // the canvas backend adopts the canvas as the layer's pixels
ed.activeLayerId = L.id;
ed.renderLayers();
ed.fitView();
const hasGl = !!ed.compositor();
const out = { tiles: ed.tileMode, level: ed.tileLevel(ed.view.scale), rows: [] };
const fails = [];
const g = ed.canvas.getContext("2d");
const frame = () => { ed.hover = null; ed.sceneSig = null; ed.draw(); };
const read = () => g.getImageData(0, 0, ed.canvas.width, ed.canvas.height).data;
const diff = (a, b) => { let worst = 0, n = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i] - b[i]); if (v) { n++; if (v > worst) worst = v; } } return [worst, n]; };
// the canvas backend's display pyramid builds one level a frame: draw until it has them all, as the edit step does
const levels = async () => { for (let i = 0; i < 8; i++) { frame(); await wait(30); if (!ed._pyramidPending) break; } frame(); };
const settle = async () => { await ed.mipsSettled(); await levels(); };
const audit = (label) => {
    if (!ed.tileMode) return 0;
    let n = 0;
    for (const p of [L.px, ed.basePx]) {
        if (!p || !p.tileList) continue;
        for (const t of p.tileList()) {
            if (t.mipsVersion !== t.version || !t.mips) continue;
            const want = K.mipChain(t.data, 256, 5, new Uint8Array(K.mipChainBytes(256, 5)));
            for (let i = 0; i < want.length; i++) if (want[i] !== t.mips[i]) { fails.push(label + ": a chain kept as exact is not the chain of its tile's bytes (byte " + i + ")"); return n; }
            n++;
        }
    }
    return n;
};
const exactScreen = async (label, path) => {
    const shown = read();
    ed.releaseCaches({ mirrors: true });
    frame(); await wait(30); await ed.mipsSettled(); await levels();
    const [worst, n] = diff(shown, read());
    // On the canvas backend, with a filter layer in the stack, the view before and after releaseCaches() differs by
    // 31 levels on about 726,000 bytes whether or not anything changed (measured with and without the flip): that
    // backend has no mips to wait for, and its released view is no reference there. It is checked on the GPU path.
    const gated = ed.tileMode || path === "gpu";
    // 3 levels on the GPU path: the settled screen took its level-1 slots in the order the chains landed (a new layer's
    // first frame draws coarse slots at level 5), the released view takes them in reading order, and the atlas page is
    // sampled up to 3 levels apart at the stripes' edges in another place of the page. Measured: the level-1 slots read
    // back exact against tileWithGutter in both, the difference is 0 with the coarse slots off (coarseLevel null) and on
    // the code before C6 (b), and a coarse or stale cell left on the screen is tens of levels off.
    if (gated && worst > 3) fails.push(path + ", " + label + ": the settled screen is not the view drawn from released caches (" + worst + " levels on " + n + " bytes)");
    if (hasGl && ed.glCompositeUsable({}) !== (path === "gpu")) fails.push(path + ", " + label + ": the view took the other path");
    return [worst, n];
};
const async_ = () => ed.tileMode && T.chainStats().async;
for (const path of ["gpu", "2d"]) {
    const fx = path === "2d" ? ed.addFilterLayer("levels") : null;
    ed.activeLayerId = L.id;
    ed.renderLayers();
    ed.fitView();
    await settle();
    const before = read();
    // (i)
    T.chainStats(true);
    ed.flipLayer("h");
    const st = T.chainStats();
    const row = { path, main: st.main, requested: st.requested, coarse: st.coarse };
    if (async_()) {
        if (st.main > T.CHAIN_SYNC_BUDGET) fails.push(path + ": the whole change built " + st.main + " chains on the main thread in its own task, more than the budget of " + T.CHAIN_SYNC_BUDGET);
        if (!st.requested) fails.push(path + ": the whole change asked the mips worker for nothing (" + JSON.stringify(st) + ")");
    }
    // (ii)
    await settle();
    const flipped = read();
    const [moved] = diff(before, flipped);
    if (moved < 100) fails.push(path + ": the flip did not reach the screen (" + moved + " levels at most)");
    row.flip = await exactScreen("after the flip", path);
    row.audited = audit(path + " after the flip");
    // (iii)
    await settle();
    T.chainStats(true);
    ed.flipLayer("h");
    await Promise.resolve(); await Promise.resolve();   // the first batch is posted
    const sch = T.chainScheduler();
    const inFlight = sch.flight, queued = sch.queue.size;
    L.px.fill([0, 0, W, H], "#30c060");   // in place: the flipped tiles get new versions while their chains are away
    // thin stripes, so nearest samples miss most of them
    for (let x = 7; x < W; x += 20) L.px.fill([x, 0, x + 3, H], "#6030c0");
    ed.markLayerChanged(L);
    ed.draw();
    await settle();
    const st3 = T.chainStats();
    row.dropped = st3.dropped; row.inFlight = inFlight; row.queued = queued;
    if (async_() && !(inFlight > 0)) fails.push(path + ": no batch of chains was in flight when the second write came (" + queued + " queued)");
    if (async_() && !(st3.dropped > 0)) fails.push(path + ": no late answer was dropped (" + JSON.stringify(st3) + ")");
    const [cx, cy] = ed.imageToScreen(W / 2, H / 2);
    const px = Array.from(g.getImageData(Math.round(cx), Math.round(cy), 1, 1).data);
    if (!(px[1] > 150 && px[0] < 100)) fails.push(path + ": the settled screen does not show the second write (" + px + ")");
    // the scheduler's buffers for its next batch (up to 32 MB, the module's) go with the caches once nothing is on its way
    // (C6 b review): the landings above filled the pool
    row.pool = T.chainScheduler().pool.length;
    ed.releaseCaches();
    const poolKept = T.chainScheduler().pool.length;
    // tiles in the arena (E1) are named by slot and never copied, so nothing comes back to keep
    const copied = !T.chainScheduler().transport || !T.chainScheduler().transport.arena;
    if (async_() && copied && !row.pool) fails.push(path + ": the landings left no buffers in the mips scheduler's pool to release");
    if (async_() && poolKept) fails.push(path + ": releaseCaches kept " + poolKept + " buffers of the mips scheduler's pool");
    row.fill = await exactScreen("after the second write", path);
    row.audited3 = audit(path + " after the second write");
    out.rows.push(row);
    await ed.undoStep();   // the flip back: the layer holds the painted picture again for the next path
    await ed.undoStep();
    if (fx) { ed.removeLayer(fx.id); ed.renderLayers(); }
}
if (hasGl && ed.compositorOff) fails.push("the GPU compositor failed during the step");
await run("close_document", { doc: d.id, force: true });
if (fails.length) throw new Error(fails.join(" | ") + " " + JSON.stringify(out));
return { tiles: out.tiles, level: out.level, rows: out.rows.map((r) => r.path + ": main " + r.main + " asked " + r.requested + " flip " + r.flip[0] + " fill " + r.fill[0] + " in flight " + r.inFlight + "+" + r.queued + " dropped " + r.dropped + " audited " + r.audited + "/" + r.audited3) };
"""),
    ("mips_landings_redraw_every_thumbnail_and_the_screen_only_where_it_asked", """
// C6 (b) review, with the mips worker on tiles (elsewhere the same checks run with nothing on its way). Two 4000 x 3000
// layers at fit.
// (i) A paint layer's whole change (a flip), a reference layer added (new pixels), the result list drawn and a rename
// opened, all while their chains are on their way: once they land, the paint layer's row, the reference's row and the
// result list's item were each last drawn from the thumbnail as it is now, which is the exact one; no landing rebuilt a
// list, and the rename is still open. (Drawn from the thumbnail, not compared as pixels: the same thumbnail canvas drawn
// into two 40 x 28 canvases comes out 29 levels apart on 2,251 bytes or identical, run by run, measured.)
// (ii) At 1:1, a whole change of a hidden layer: its thumbnail's chains land without being kept on its tiles, and a
// landing only a thumbnail asked for leaves the view's caches alone.
const T = await import("./editor/inpaint_tiles.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await wait(200);
const W = 4000, H = 3000;
await run("new_canvas", { width: W, height: H, doc: d.id });
const picture = (seed) => {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d");
    const gr = x.createLinearGradient(0, 0, W, H);
    gr.addColorStop(0, seed ? "#e02020" : "#1c4f8a"); gr.addColorStop(1, seed ? "#20e0e0" : "#e0a040");
    x.fillStyle = gr; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 400; i++) { x.fillStyle = `hsl(${(i * 37 + seed * 90) % 360},80%,55%)`; x.beginPath(); x.arc((i * 977 + seed * 311) % W, (i * 613 + seed * 157) % H, 40, 0, Math.PI * 2); x.fill(); }
    x.fillStyle = "#000"; x.fillRect(0, 0, 900, 400);
    return ed.pixels.Layer.fromCanvas(c);
};
const L = ed.addLayer({ name: "Paint", kind: "paint", px: picture(0), x: 0, y: 0, w: W, h: H, dirty: true });
ed.history.push({ layerId: L.id, name: "Result", w: W, h: H, x: 0, y: 0 });
ed.activeLayerId = L.id;
ed.renderLayers(); ed.renderHistory();
ed.fitView();
const out = { tiles: ed.tileMode };
const fails = [];
const async_ = ed.tileMode && T.chainStats().async;
const frame = () => { ed.hover = null; ed.sceneSig = null; ed.draw(); };
const settle = async () => { frame(); await wait(30); await ed.mipsSettled(); frame(); await wait(30); };
await settle();
// a hash of a thumbnail canvas (a CPU canvas), and for each canvas a layer was drawn into, the hash of the thumbnail it was drawn from
const hash = (cv) => { const b = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let h = 0; for (let i = 0; i < b.length; i++) h = (h * 31 + b[i]) | 0; return h; };
const drawnFrom = new WeakMap();
const fitted = ed.drawLayerFitted;
ed.drawLayerFitted = function (ctx, layer, ...rest) {
    const r = fitted.call(this, ctx, layer, ...rest);
    if (layer.px && layer.px._thumb) drawnFrom.set(ctx.canvas, hash(layer.px._thumb.canvas));
    return r;
};
const rowThumb = (list, l) => list && list.querySelector('.ipc-layer[data-layer="' + l.id + '"] canvas.ipc-lthumb');
let renders = 0;
const rl = ed.renderLayers;
ed.renderLayers = function () { renders++; return rl.call(this); };
let input = null, R = null;
try {
    // (i)
    T.chainStats(true);
    ed.flipLayer("h");
    R = ed.addLayer({ name: "Ref", kind: "image", role: "reference", px: picture(1), x: 0, y: 0, w: W, h: H, dirty: true });
    ed.renderHistory();
    out.pending = T.chainScheduler().pending;
    ed.renameLayerInline(L, ed.layerList.querySelector('.ipc-layer[data-layer="' + L.id + '"] .ipc-name'));
    input = ed.layerList.querySelector("input");
    const before = renders;
    await settle();
    out.renders = renders - before;
    if (async_ && !(out.pending > 0)) fails.push("nothing was on its way after the whole changes");
    if (out.renders) fails.push("the landings rebuilt the layer lists " + out.renders + " times");
    if (!(input && input.isConnected)) fails.push("the open rename was taken while the chains landed");
    const rowL = rowThumb(ed.layerList, L), rowR = rowThumb(ed.refList, R);
    const hist = ed.historyList && ed.historyList.querySelector("canvas[data-hist]");
    if (!rowL || !rowR || !hist) fails.push("a thumbnail is missing: row " + !!rowL + ", reference " + !!rowR + ", result " + !!hist);
    else if (ed.tileMode) {
        for (const [name, l, cv] of [["the layer's row", L, rowL], ["the reference's row", R, rowR], ["the result list's item", L, hist]]) {
            const now = hash(l.px.thumbnailCanvas(true));
            const exact = hash(ed.pixels.Layer.fromImageData(l.px.readRect(0, 0, W, H)).thumbnailCanvas());
            if (now !== exact) fails.push(name + ": the thumbnail after the landings is not the exact one");
            if (drawnFrom.get(cv) !== now) fails.push(name + " was last drawn from a thumbnail its chains' landing changed afterwards");
        }
    }
    if (input && input.isConnected) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    // (ii)
    ed.view.scale = 1; ed.view.angle = 0; ed._fitted = false;
    ed.view.x = Math.round(ed.canvas.width / 2 - W / 2); ed.view.y = Math.round(ed.canvas.height / 2 - H / 2);
    L.visible = false;
    rl.call(ed);
    await settle();
    T.chainStats(true);
    ed.activeLayerId = L.id;
    ed.flipLayer("h");   // new pixels: no chain on any tile, and nothing on the screen reads them
    frame();
    const sentinel = { sentinel: true };
    for (const l of ed.layers) l._fcacheView = sentinel;
    await ed.mipsSettled(); await wait(30);
    const st = T.chainStats();
    out.hidden = { requested: st.requested, handed: st.handed, thumb: st.thumb, kept: L.px.tileList ? L.px.tileList().filter((t) => t.mips).length : 0 };
    if (async_ && !st.requested) fails.push("the hidden layer's thumbnail asked for no chain");
    if (out.hidden.kept) fails.push("a hidden layer at 1:1 kept " + out.hidden.kept + " chains on its tiles for its thumbnail (" + JSON.stringify(st) + ")");
    if (ed.layers.some((l) => l._fcacheView !== sentinel)) fails.push("a landing only a thumbnail asked for dropped the view's caches");
} finally {
    delete ed.renderLayers;
    delete ed.drawLayerFitted;
    if (input && input.isConnected) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await run("close_document", { doc: d.id, force: true });
}
if (fails.length) throw new Error(fails.join(" | ") + " " + JSON.stringify(out));
return out;
"""),
    ("a_clipped_stroke_takes_the_selection_its_mips_land_with", """
// C6 (b) review, with the mips worker on tiles (skipped elsewhere). A stroke clipped to a selection whose chains are
// still on their way: a striped selection inverted at fit on a 4000 x 3000 document, the worker's answers held back
// 3 s (a 15000 x 10000 document's take lasts that long), and 40 dabs drawn meanwhile. Once the chains have landed, the
// live preview is what its view scratch gives when built again, both on the screen as the landings left it (C6 b2: they
// draw the scene again for a stroke clipped to the selection) and after frames of the step's own: the dabs drawn before the landing kept the clip of the
// selection before the invert until the commit. Nothing else may rebuild the scratch meanwhile: the film panel's
// flatten of the document (500 ms after a change) draws the layer through it for the whole picture and makes the next
// screen frame rebuild it, so the step lets that run before the first dab and fails if a sampled pass came during it.
const T = await import("./editor/inpaint_tiles.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await wait(200);
const W = 4000, H = 3000;
await run("new_canvas", { width: W, height: H, doc: d.id });
const sch = T.chainScheduler();
if (!ed.tileMode || !sch.async) { await run("close_document", { doc: d.id, force: true }); return { tiles: ed.tileMode, skipped: "no mips worker" }; }
const out = { tiles: ed.tileMode };
const fails = [];
// the tint, not the marching ants: the ants move every 120 ms, and the two screens compared below are 30 ms apart
// (an earlier step leaves the display on ants; the step failed one run in four on that alone, measured)
const display = ed.selectionDisplay;
ed.selectionDisplay = "tint";
const L = ed.addPaintLayer();
ed.activeLayerId = L.id;
ed.renderLayers();
ed.fitView();
out.level = ed.tileLevel(ed.view.scale);
await run("select_all", { doc: d.id });
for (let x = 0; x < W; x += 128) ed.sel.clear([x, 0, x + 64, H]);
ed.markSelectionChanged();
const frame = () => { ed.hover = null; ed.sceneSig = null; ed.draw(); };
frame(); await wait(100); await ed.mipsSettled(); frame(); await wait(50);
const orig = sch.transport;
const g = ed.canvas.getContext("2d");
const CW = ed.canvas.width, CH = ed.canvas.height;
let p = null;
sch.transport = (tiles) => new Promise((res, rej) => setTimeout(() => orig(tiles).then(res, rej), 3000));
try {
    await run("select_invert", { doc: d.id });
    frame();
    out.selPending = sch.pending;
    // what the failure message needs: the selection's chainEpoch at each rebuild of the stroke's scratch, and each landing
    out.trace = [];
    const lrv = ed.layerRegionView;
    ed.layerRegionView = function (layer, vp) { const was = this._strokeViewSig; const r = lrv.call(this, layer, vp); if (this._strokeViewSig !== was) out.trace.push("r" + (was === null ? "0" : "") + ":" + (this.sel.chainEpoch || 0) + (vp.x ? "" : "w")); return r; };
    const landOf = sch._land;
    sch._land = function (batch, reply) { const sel = batch.filter((e) => e.store === ed.sel).length, scr = batch.filter((e) => e.store === ed.sel && e.screen).length; out.trace.push("L" + batch.length + "/" + sel + "/" + scr); return landOf.call(this, batch, reply); };
    ed.setTool("paint");
    ed.brushSize = 90; ed.brushOpacity = 1; ed.hardness = 1; ed.color = "#ff0000";
    await wait(800);   // the film panel's flatten after the invert (its 500 ms debounce)
    let sampled = 0;
    const sr = ed.sampleRegion;
    ed.sampleRegion = function (...a) { sampled++; return sr.apply(this, a); };
    out.sampledOff = () => { delete ed.sampleRegion; return sampled; };
    p = { kind: "layerpaint", layer: L, stroke: ed.newStrokeBuffer(L.px), clip: ed.strokeClip(L, L.px), erase: false, last: [200, 1500], pressure: 1 };
    ed.pointer = p;
    for (let i = 1; i <= 40; i++) {
        const x = 200 + i * 90;
        ed.layerDab(p, p.last[0], p.last[1], x, 1500);
        p.last = [x, 1500];
        frame();
        await wait(1);
    }
    out.used = !!(ed.strokeView && ed._strokeViewOf === p);
    out.sampled = out.sampledOff(); delete out.sampledOff;
    if (out.sampled) fails.push("a sampled pass of the document (" + out.sampled + ") came during the gesture and rebuilt the stroke's scratch");
    out.pendingAfterDabs = sch.pending;
    await ed.mipsSettled();
    // C6 (b2): the screen as the landings left it, before a frame of the step's own. A landing of the selection's chains
    // draws only the overlays, except for a stroke clipped to the selection, whose scene it draws again.
    for (let i = 0; i < 50; i++) { await wait(40); if (!ed._drawQueued) break; }
    const a0 = g.getImageData(0, 0, CW, CH).data;
    await wait(50); frame(); await wait(30); frame();
    const a = g.getImageData(0, 0, CW, CH).data;
    out.at = { gl: ed.glCompositeUsable({}), view: !!(ed.strokeView && ed._strokeViewOf === p), sig: String(ed._strokeViewSig).split(",").slice(0, 6).join("/"), pending: sch.pending, strokeTiles: p.stroke && p.stroke.px && p.stroke.px.tileList ? p.stroke.px.tileList().filter((t) => !(t.mips && t.mipsVersion === t.version)).length : -1 };
    ed._strokeViewSig = null;   // the same gesture, its scratch built again from the (exact) region canvases
    frame(); await wait(30);
    const b = g.getImageData(0, 0, CW, CH).data;
    let worst = 0, n = 0, red = 0;
    for (let i = 0; i < a.length; i += 4) {
        for (let k = 0; k < 4; k++) { const v = Math.abs(a[i + k] - b[i + k]); if (v) { n++; if (v > worst) worst = v; } }
        if (b[i] > 200 && b[i + 1] < 60 && b[i + 2] < 60) red++;
    }
    out.live = [worst, n]; out.red = red;
    {
        let w0 = 0, n0 = 0;
        for (let i = 0; i < a0.length; i++) { const v = Math.abs(a0[i] - b[i]); if (v) { n0++; if (v > w0) w0 = v; } }
        out.landed = [w0, n0];
        if (w0 > 2) fails.push("the screen the landings of the selection's chains left is not the live preview built again (" + w0 + " levels on " + n0 + " bytes)");
    }
    out.bt = { gl: ed.glCompositeUsable({}), sig: String(ed._strokeViewSig).split(",").slice(0, 6).join("/"), pending: sch.pending };
    if (n) {
        let x0 = CW, y0 = CH, x1 = -1, y1 = -1, sample = null;
        for (let k = 0; k < a.length; k += 4) if (a[k] !== b[k] || a[k + 1] !== b[k + 1] || a[k + 2] !== b[k + 2]) { const q = k >> 2, x = q % CW, y = (q / CW) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (!sample) sample = [x, y, a[k], a[k + 1], a[k + 2], b[k], b[k + 1], b[k + 2]]; }
        const toImg = (x, y) => [(x - ed.view.x) / ed.view.scale, (y - ed.view.y) / ed.view.scale];
        const [ix0, iy0] = toImg(x0, y0), [ix1, iy1] = toImg(x1, y1);
        out.box = [x0, y0, x1, y1, Math.round(ix0), Math.round(iy0), Math.round(ix1), Math.round(iy1)]; out.sample = sample;
    }
    if (!out.used) fails.push("the stroke did not draw through its view scratch");
    if (!(out.selPending > 0) || !(out.pendingAfterDabs > 0)) fails.push("the selection's chains were not on their way while the dabs were drawn (" + out.selPending + ", " + out.pendingAfterDabs + ")");
    if (red < 2000) fails.push("the stroke put " + red + " red pixels on the screen");
    if (worst > 2) fails.push("the live preview after the selection's chains landed is not what its scratch gives when built again (" + worst + " levels on " + n + " bytes)");
} finally {
    ed.selectionDisplay = display;
    delete ed.layerRegionView; delete sch._land;
    sch.transport = orig;
    if (out.sampledOff) out.sampledOff();
    delete out.sampledOff;
    if (p) { ed.pointer = null; ed.releaseStrokeScratch(); }
    await ed.mipsSettled();
    await run("close_document", { doc: d.id, force: true });
}
if (fails.length) throw new Error(fails.join(" | ") + " " + JSON.stringify(out));
return out;
"""),
    ("the_navigator_watches_the_chains_it_asks_for", """
// C6 (b) review, with the mips worker on tiles (skipped elsewhere): the node's navigator (drawThumb) is a display pass of
// its own. A new 2400 x 1600 base at fit (level 0 on the screen, which asks the worker for nothing) with the navigator
// mounted as the node mounts it (320 x 240, level 2): once the chains it asked for have landed, its region canvas holds
// no cell left coarse, because the navigator was drawn again. Nothing else draws it after a setBase.
const T = await import("./editor/inpaint_tiles.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await wait(200);
const sch = T.chainScheduler();
if (!ed.tileMode || !sch.async) { await run("close_document", { doc: d.id, force: true }); return { tiles: ed.tileMode, skipped: "no mips worker" }; }
await run("new_canvas", { width: 1000, height: 1000, doc: d.id });
const wrap = document.createElement("div");
wrap.style.cssText = "position:fixed;right:10px;bottom:10px;width:320px;height:240px;z-index:99999;background:#222";
document.body.appendChild(wrap);
const home = ed.thumb.parentElement;
wrap.appendChild(ed.thumb);
const W = 2400, H = 1600;
const c = document.createElement("canvas"); c.width = W; c.height = H;
{
    const x = c.getContext("2d");
    for (let i = 0; i < 3000; i++) { x.fillStyle = `hsl(${(i * 37) % 360},80%,${30 + (i * 13) % 50}%)`; x.fillRect((i * 977) % W, (i * 613) % H, 23, 17); }
}
const out = {};
const fails = [];
try {
    T.chainStats(true);
    await ed.setBaseFromCanvas(c);
    out.level = ed.tileLevel(ed.view.scale);
    out.requested = T.chainStats().requested;
    await ed.mipsSettled();
    await wait(100);
    out.regions = ed.basePx._regions ? Array.from(ed.basePx._regions.values(), (rc) => [rc.level, rc.stale.size, rc.dirty.size]) : [];
    const navigator = out.regions.filter((r) => r[0] >= 1);
    if (out.level !== 0) fails.push("the screen at fit is at level " + out.level + ", not 0: the screen's own pass watches the chains");
    if (!out.requested) fails.push("the navigator asked the mips worker for nothing");
    if (!navigator.length) fails.push("the navigator drew no region canvas");
    for (const [level, stale, dirty] of navigator) if (stale || dirty) fails.push(`the navigator's region at level ${level} keeps ${stale} stale and ${dirty} landed cells it never drew`);
} finally {
    if (home) home.appendChild(ed.thumb); else ed.root.appendChild(ed.thumb);
    wrap.remove();
    await run("close_document", { doc: d.id, force: true });
}
if (fails.length) throw new Error(fails.join(" | ") + " " + JSON.stringify(out));
return out;
"""),
    ("landings_of_the_selection_leave_the_filter_and_the_colour_match", """
// C6 (b2), on both backends (on the canvas backend nothing is ever on its way: the counts stay 0 and the screens are
// checked as they are). A 4000 x 3000 document at fit: a painted layer, a colour-matched result over part of it, and on
// the "2d" path an invert filter layer on top (the Canvas 2D path); on the "gpu" path the filter is not there and the
// GPU compositor takes the stack, the match's backdrop from the atlas. The selection is shown as a tint.
// (i) A whole selection change (an invert of a rectangle) at fit: its chains go to the mips worker. From the end of the
// operation's own frame until they have landed and been drawn, the screen's colour match and filter pass run again 0
// times (a landing of the selection's chains dropped every layer's view caches and ran both again per batch), and the
// screen as the landings left it (no frame of the step's own: a landing that draws nothing leaves the tint coarse) is the
// view drawn from released caches.
// (ii) A whole change of the painted layer below the matched one (a flip): once its chains have landed the colour match
// (and on the 2d path the filter) has run again exactly once (not once per batch of chains), and the screen as the
// landings left it is the view drawn from released caches.
// (iii) A whole change of a layer above the matched one and the filter: its landings run neither again (the caches below
// the landed layer stay), and the screen is exact.
// (iv) A sampled pass (a plugin's flatten at 512 px) while the flip's chains are on their way, after a screen frame of
// that time: the same flatten after they have landed is the flatten with the sampled pass's caches made again (the
// review of C6 b2: the matched pixels made from the coarse picture's statistics outlived the settle).
// (v) The base replaced under the layers: once its chains have landed the colour match (and the filter) ran again once.
// (vi) The film panel's flatten (192 px) right after the settle of a flip, before the screen's next frame: the screen as
// the landings left it is still the view drawn from released caches (the flatten made the screen's statistics from its
// own small picture, 5 levels off on the whole matched layer).
const T = await import("./editor/inpaint_tiles.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
await wait(200);
const W = 4000, H = 3000;
await run("new_canvas", { width: W, height: H, doc: d.id });
const c = document.createElement("canvas"); c.width = W; c.height = H;
{
    const x = c.getContext("2d");
    const gr = x.createLinearGradient(0, 0, W, H);
    gr.addColorStop(0, "#1c4f8a"); gr.addColorStop(1, "#e0a040");
    x.fillStyle = gr; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 120; i++) { x.fillStyle = `hsl(${(i * 37) % 360},80%,55%)`; x.beginPath(); x.arc((i * 977) % W, (i * 613) % H, 90, 0, Math.PI * 2); x.fill(); }
    x.fillStyle = "#000"; x.fillRect(0, 0, 900, 400);   // an asymmetric block: a flip moves it
}
const P = ed.addLayer({ name: "Paint", kind: "paint", px: ed.pixels.Layer.fromCanvas(c), x: 0, y: 0, w: W, h: H, dirty: true });
if (ed.tileMode) { c.width = 1; c.height = 1; }   // the canvas backend adopts the canvas as the layer's pixels
const rc = document.createElement("canvas"); rc.width = 1200; rc.height = 900;
{
    const x = rc.getContext("2d");
    const gr = x.createLinearGradient(0, 0, 1200, 900);
    gr.addColorStop(0, "#f0e0c0"); gr.addColorStop(1, "#402010");
    x.fillStyle = gr; x.fillRect(0, 0, 1200, 900);
}
const R = ed.addLayer({ name: "Result", kind: "result", px: ed.pixels.Layer.fromCanvas(rc), x: 1400, y: 1000, w: 1200, h: 900, dirty: true });
R.match = { strength: 80, source: "surroundings" };
ed.markMatchChanged(R);
const display = ed.selectionDisplay;
ed.selectionDisplay = "tint";   // the ants move every 120 ms, and the screens compared below are further apart
// the screens are read as the editor's own frames left them: a tool without a ring under the pointer. One gate run read
// 193 levels on 1,145 bytes in one of them on the canvas backend, most likely the default selection brush's ring under a
// real pointer over the window (the ring alone is 203 levels on 576 bytes over white at fit; the marquee draws nothing)
ed.setTool("rect");
ed.hover = null;
const hasGl = !!ed.compositor();
const out = { tiles: ed.tileMode, rows: [] };
const fails = [];
const async_ = () => ed.tileMode && T.chainStats().async;
const g = ed.canvas.getContext("2d");
const read = () => g.getImageData(0, 0, ed.canvas.width, ed.canvas.height).data;
const diff = (a, b) => { let worst = 0, n = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i] - b[i]); if (v) { n++; if (v > worst) worst = v; } } return [worst, n]; };
// the frames the editor queued itself (the landings' draws, a pyramid level per frame), and none of the step's own
const drawn = async () => { for (let i = 0; i < 75; i++) { await wait(40); if (!ed._drawQueued && !ed._pyramidPending) break; } };
const frame = () => { ed.hover = null; ed.sceneSig = null; ed.draw(); };
const levels = async () => { for (let i = 0; i < 10; i++) { frame(); await wait(30); if (!ed._pyramidPending) break; } };
// a plugin's flatten at 512 px (renderer/plugins.js `flatten({ maxSize: 512 })`)
const sample = () => { const cv = ed.sampleRegion("image", [0, 0, W, H], 512 / Math.max(W, H), { forRun: true }); return cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; };
// a colour match or a filter pass the screen ran again: a miss of the view's cache (the screen's or the navigator's slot;
// a sampled pass keeps its own)
const reruns = { on: false, match: 0, filter: 0 };
const wrapMiss = (name, slot, key) => {
    const f = ed[name];
    ed[name] = function (layer, ...a) {
        const vp = this.viewPass;
        if (!reruns.on || !vp) return f.call(this, layer, ...a);
        const was = layer[slot];
        try { return f.call(this, layer, ...a); } finally { if (layer[slot] !== was) reruns[key]++; }
    };
};
wrapMiss("sampledMatchStats", "_mstatsSample", "match");
wrapMiss("filteredCanvas", "_fcacheView", "filter");
const count = async () => { reruns.match = 0; reruns.filter = 0; reruns.on = true; await ed.mipsSettled(); await drawn(); reruns.on = false; return [reruns.match, reruns.filter]; };
const exact = async (label, path, shown) => {
    ed.releaseCaches({ mirrors: true });
    await levels(); await ed.mipsSettled(); await levels();
    // a match made while a display pyramid was still being built keeps the statistics of that level: made again with every level there
    for (const l of ed.layers) { l._fcacheView = null; l._mcacheView = null; l._mstatsSample = null; }
    await levels();
    const [worst, n] = diff(shown, read());
    // 3 levels as in the whole-change step; on the canvas backend with a filter layer the released view is no reference
    // (31 levels on about 726,000 bytes with no change at all, measured there)
    if ((ed.tileMode || path === "gpu") && worst > 3) fails.push(path + ", " + label + ": the screen is not the view drawn from released caches (" + worst + " levels on " + n + " bytes)");
    return [worst, n];
};
try {
    for (const path of ["gpu", "2d"]) {
        const fx = path === "2d" ? ed.addFilterLayer("invert") : null;
        // a layer on top of the stack, clear of the result (iii)
        const tc = document.createElement("canvas"); tc.width = 1200; tc.height = 900;
        {
            const x = tc.getContext("2d");
            x.fillStyle = "#30a050"; x.fillRect(0, 0, 1200, 900);
            x.fillStyle = "#f0f0f0"; x.fillRect(0, 0, 1200, 250);   // an asymmetric band: a flip moves it
        }
        const top = ed.addLayer({ name: "Top", kind: "paint", px: ed.pixels.Layer.fromCanvas(tc), x: 2700, y: 2000, w: 1200, h: 900, dirty: true });
        if (ed.tileMode) { tc.width = 1; tc.height = 1; }
        if (ed.layers[ed.layers.length - 1] !== top) fails.push(path + ": the layer on top is not on top");
        ed.activeLayerId = P.id;
        ed.renderLayers();
        ed.fitView();
        out.level = ed.tileLevel(ed.view.scale);
        await run("select_rect", { x: 800, y: 600, w: 1600, h: 1200, doc: d.id });
        await levels(); await ed.mipsSettled(); await levels();
        if (hasGl && ed.glCompositeUsable({}) !== (path === "gpu")) fails.push(path + ": the view took the other path");
        const row = { path };
        // (i)
        T.chainStats(true);
        await ed.invertSelection();
        row.selAsked = T.chainStats().requested;
        row.sel = await count();
        if (async_() && !row.selAsked) fails.push(path + ": the whole selection change asked the mips worker for nothing");
        if (row.sel[0] || row.sel[1]) fails.push(path + ": the landings of the selection's chains ran the colour match " + row.sel[0] + " and the filter " + row.sel[1] + " times again");
        row.selExact = await exact("after the selection's landings", path, read());
        // (ii)
        await levels();
        ed.activeLayerId = P.id;
        T.chainStats(true);
        ed.flipLayer("h");
        row.layerAsked = T.chainStats().requested;
        row.layer = await count();
        if (async_()) {
            if (!row.layerAsked) fails.push(path + ": the flip asked the mips worker for nothing");
            if (row.layerAsked <= 128) fails.push(path + ": the flip's chains fit one batch (" + row.layerAsked + "), so once and once per batch are the same");
            if (row.layer[0] !== 1) fails.push(path + ": the colour match above the flipped layer ran again " + row.layer[0] + " times once its chains landed, once expected");
            if (fx && row.layer[1] !== 1) fails.push(path + ": the filter above the flipped layer ran again " + row.layer[1] + " times once its chains landed, once expected");
        }
        row.layerExact = await exact("after the layer's landings", path, read());
        // (iii)
        await levels();
        ed.activeLayerId = top.id;
        T.chainStats(true);
        ed.flipLayer("v");
        row.topAsked = T.chainStats().requested;
        row.top = await count();
        if (async_() && !row.topAsked) fails.push(path + ": the flip of the layer on top asked the mips worker for nothing");
        if (row.top[0] || row.top[1]) fails.push(path + ": the landings of the layer on top ran the colour match " + row.top[0] + " and the filter " + row.top[1] + " times again below it");
        row.topExact = await exact("after the landings of the layer on top", path, read());
        // (iv)
        await levels();
        ed.activeLayerId = P.id;
        T.chainStats(true);
        ed.flipLayer("h");
        row.samplePending = ed.tileMode ? T.chainScheduler().pending : 0;
        frame();   // the screen's statistics of this moment
        sample();   // the flatten while the chains are on their way
        await ed.mipsSettled(); await drawn();
        const after = sample();
        for (const l of ed.layers) { l._mcacheSample = null; l._fcacheSample = null; }
        row.sample = diff(after, sample());
        if (async_() && !row.samplePending) fails.push(path + ": nothing was on its way during the sampled pass");
        if (row.sample[0]) fails.push(path + ": the flatten after the landings kept the sampled pass's caches from while they were on their way (" + row.sample[0] + " levels on " + row.sample[1] + " bytes)");
        // (vi)
        await levels();
        ed.activeLayerId = P.id;
        ed.flipLayer("h");
        await ed.mipsSettled();
        // the film panel's flatten (192 px), between the drop of the view's caches and the next screen frame
        ed.sampleRegion("image", [0, 0, W, H], 192 / Math.max(W, H), { forRun: true });
        await drawn();
        row.raceExact = await exact("after a sampled pass between the settle and the screen's frame", path, read());
        // (v)
        await levels();
        const bc = document.createElement("canvas"); bc.width = W; bc.height = H;
        { const x = bc.getContext("2d"); x.fillStyle = path === "gpu" ? "#406080" : "#806040"; x.fillRect(0, 0, W, H); }
        T.chainStats(true);
        await ed.setBaseFromCanvas(bc, { keepLayers: true });
        bc.width = 1; bc.height = 1;
        if (ed.layers.indexOf(R) < 0) fails.push(path + ": the new base took the layers");
        frame();   // a frame of the new base (the chains it asks for may have been asked for by the base's own fit)
        row.baseAsked = T.chainStats().requested;
        row.base = await count();
        if (async_()) {
            if (!row.baseAsked) fails.push(path + ": the new base asked the mips worker for nothing");
            if (row.base[0] !== 1) fails.push(path + ": the colour match ran again " + row.base[0] + " times once the new base's chains landed, once expected");
            if (fx && row.base[1] !== 1) fails.push(path + ": the filter ran again " + row.base[1] + " times once the new base's chains landed, once expected");
        }
        out.rows.push(row);
        ed.removeLayer(top.id);
        if (fx) ed.removeLayer(fx.id);
        ed.renderLayers();
    }
    if (hasGl && ed.compositorOff) fails.push("the GPU compositor failed during the step");
} finally {
    delete ed.matchStats; delete ed.filteredCanvas;
    ed.selectionDisplay = display;
    await ed.mipsSettled();
    await run("close_document", { doc: d.id, force: true });
}
if (fails.length) throw new Error(fails.join(" | ") + " " + JSON.stringify(out));
return { tiles: out.tiles, level: out.level, rows: out.rows.map((r) => r.path + ": sel asked " + r.selAsked + " reruns " + r.sel + " exact " + r.selExact[0] + "; layer asked " + r.layerAsked + " reruns " + r.layer + " exact " + r.layerExact[0] + "; top asked " + r.topAsked + " reruns " + r.top + " exact " + r.topExact[0] + "; sampled with " + r.samplePending + " pending, after " + r.sample + "; sampled before the frame, exact " + r.raceExact[0] + "; base asked " + r.baseAsked + " reruns " + r.base) };
"""),
    ("pixel_backend_is_the_one_the_flag_chose", lambda c: backend_step(c)),
    ("tile_engine_row_writes_the_setting_and_names_its_source", lambda c: tile_engine_row_writes_the_setting_and_names_its_source(c)),
    ("restart_now_saves_the_edits_of_the_last_seconds", lambda c: restart_save_step(c)),
    ("editing_on_the_flags_backend_in_pixels_and_on_screen", lambda c: edit_step(c)),
    ("pixels_nothing_draws_get_no_display_mirror", lambda c: undrawn_step(c)),
    ("selection_overlay_is_drawn_from_the_mask_itself", lambda c: selection_step(c)),
    ("the_screen_draws_no_cpu_mirror_and_stale_textures_leave", lambda c: screen_step(c)),
    ("c2_final_review_drag_undo_steps_writes_mirrors_report_limits", lambda c: final_step(c)),
    ("closed_tabs_are_collected", lambda c: closed_tabs_are_collected(c)),
    ("arena_slots_come_back_when_tiles_are_collected", lambda c: arena_step(c)),
    ("the_wand_over_tiles_matches_a_colour_matched_layer", """
// B item 7 part 3 (docs/PLAN_BCE.md 3b): a colour-matched layer under the wand. The pool composites it from its tiles
// with the match applied in the worker, its statistics point samples of the tiles (`stackMatches`); over the canvases
// the sampled pass matches it with `sampledMatchStats` (box means of the mip levels). Flat colours: both statistics are
// the same means to a level, so the wand at tolerance 32 selects the same region either way, and the region proves the
// match: a grey square on a red field matched to its surroundings turns red and joins the field.
if (!ednow(window.__t).tileMode) return { skipped: "the canvas backend has no tiles to flood over" };
await run("new_canvas", { width: 2100, height: 1500, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const E = ed.constructor, W = ed.width, H = ed.height;
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const base = mk(W, H), bx = base.getContext("2d");
bx.fillStyle = "#d8d8d8"; bx.fillRect(0, 0, W, H);
bx.fillStyle = "#c02020"; bx.fillRect(200, 200, 1300, 1000);
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "flood_match.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const L = ed.pixels.Layer;
const c = mk(600, 400); c.getContext("2d").fillStyle = "#808080"; c.getContext("2d").fillRect(0, 0, 600, 400);
const grey = ed.addLayer({ name: "Grey", kind: "result", px: L.fromCanvas(c), x: 500, y: 450, w: 600, h: 400, dirty: true });
ed.renderLayers(); ed.draw();
await ed.mipsSettled();
const hex = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", u8))).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
const wand = async () => {
    ed.clearUndo(); ed.clearSelection();
    ed.fillOpts = { tolerance: 32, contiguous: true, sample: "image" };
    await ed.wandSelect(800, 650, "replace");
    const d = ed.sel.readRect(0, 0, W, H).data;
    let count = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) count++;
    return { hash: await hex(d), bounds: ed.getBounds(), count };
};
const seen = [];
const oOver = ed.floodOverTiles.bind(ed);
ed.floodOverTiles = async (...a) => { const r = await oOver(...a); seen.push(r ? (r.tiles ? "tiles" : "bitmap") : "none"); return r; };
let unmatched, over, canvases;
try {
    unmatched = await wand();
    grey.match = { strength: 100, source: "surroundings" };
    ed.markMatchChanged(grey);
    ed.renderLayers(); ed.draw();
    const plan = ed.floodStack("image");
    if (!plan || !plan.some((s) => s && s.match === grey)) throw new Error("no flood stack carrying the matched layer");
    over = await wand();
    if (!seen.includes("tiles") || seen.includes("none")) throw new Error("the floods over tiles answered " + JSON.stringify(seen));
    E.stacks = false;
    const n = seen.length;
    canvases = await wand();
    if (seen.length !== n) throw new Error("with stacks off the flood still ran over tiles");
} finally { E.stacks = true; delete ed.floodOverTiles; }
// the grey square alone before the match, the whole red field with it: the match was applied under the wand
if (!(unmatched.count > 200000 && unmatched.count < 260000)) throw new Error("the unmatched wand did not select the grey square alone: " + JSON.stringify(unmatched));
if (!(over.count > 1200000)) throw new Error("the matched square did not join the red field under the wand over tiles: " + JSON.stringify(over));
if (over.hash !== canvases.hash || JSON.stringify(over.bounds) !== JSON.stringify(canvases.bounds)) throw new Error("over tiles " + JSON.stringify(over) + ", over canvases " + JSON.stringify(canvases));
// the entry is kept per change: a second click makes no new statistics; a change below the layer drops it
const entry = grey._mstatsStack;
if (!entry || !entry.stats) throw new Error("no stack statistics entry after the wand: " + JSON.stringify(entry));
await wand();
if (grey._mstatsStack !== entry) throw new Error("a second click made the statistics again");
ed.markLayerChanged(grey, null);   // the layer's own change drops its entry
if (grey._mstatsStack) throw new Error("the entry survived a change of the layer");
// the A/B switch turns the document away
E.stackMatch = false;
let off;
try { off = ed.floodStack("image"); } finally { E.stackMatch = true; }
if (off) throw new Error("stackMatch = false still gave a flood stack");
ed.clearSelection();
return { unmatched: unmatched.count, matched: over.count, bounds: over.bounds, seen };
"""),
    ("the_flood_over_tiles_is_the_flood_over_canvases", """
// B item 2 (docs/PLAN_BCE.md 3b): on a plain stack the pool composites the wand's and the bucket's picture from the tiles
// and floods it there, and the wand's answer comes back as tiles of the selection. The same selection and the same fill
// as the canvases give (`InpaintEditor.stacks = false`), byte for byte: every pixel here is opaque or empty, where the
// two composites are the same bytes. Layers off the tile grid and over the picture's edge, a masked one, the three
// modes, the layer as the sample source, the bucket clipped to a selection.
if (!ednow(window.__t).tileMode) return { skipped: "the canvas backend has no tiles to flood over" };
await run("new_canvas", { width: 3300, height: 2300, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const E = ed.constructor, W = ed.width, H = ed.height;
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const base = mk(W, H), bx = base.getContext("2d");
bx.fillStyle = "#f0f0e8"; bx.fillRect(0, 0, W, H);
bx.fillStyle = "#2050c0"; bx.fillRect(300, 300, 1500, 900); bx.fillRect(1700, 1100, 1300, 700);
bx.fillStyle = "#c03030"; bx.fillRect(700, 500, 400, 300);
Object.defineProperty(base, "naturalWidth", { value: W });
Object.defineProperty(base, "naturalHeight", { value: H });
await ed.setBase({ filename: "flood_tiles.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
const L = ed.pixels.Layer, M = ed.pixels.Mask;
{
    const c = mk(1201, 803), x = c.getContext("2d");
    x.fillStyle = "#2050c0"; x.fillRect(0, 0, 1201, 803);          // joins the two blue blocks of the base
    x.clearRect(500, 300, 200, 200);
    ed.addLayer({ name: "Patch", kind: "paint", px: L.fromCanvas(c), x: 1433, y: 977, w: 1201, h: 803, dirty: true });
    const c2 = mk(700, 500); c2.getContext("2d").fillStyle = "#30a040"; c2.getContext("2d").fillRect(0, 0, 700, 500);
    const l2 = ed.addLayer({ name: "Masked", kind: "paint", px: L.fromCanvas(c2), x: W - 450, y: -120, w: 700, h: 500, dirty: true });
    const m = mk(700, 500); m.getContext("2d").fillStyle = "#fff"; m.getContext("2d").fillRect(0, 0, 350, 500);
    l2.maskPx = M.fromCanvas(m); l2.maskDirty = true;
    window.__ftMasked = l2.id;
}
ed.renderLayers(); ed.draw();
await ed.mipsSettled();
if (!ed.floodStack("image")) throw new Error("no flood stack for a plain document");
const hex = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", u8))).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
const selHash = async () => hex(ed.sel.readRect(0, 0, W, H).data);
const script = async () => {
    const out = {};
    ed.clearUndo(); ed.clearSelection();
    ed.fillOpts = { tolerance: 32, contiguous: true, sample: "image" };
    await ed.wandSelect(400, 400, "replace"); out.replace = [await selHash(), ed.getBounds()];
    await ed.wandSelect(800, 600, "add"); out.add = [await selHash(), ed.getBounds()];
    await ed.wandSelect(2000, 1400, "subtract"); out.subtract = [await selHash(), ed.getBounds()];
    await ed.undoStep(); out.undo = [await selHash(), ed.getBounds()];
    await ed.wandSelect(W - 300, 50, "replace"); out.masked = [await selHash(), ed.getBounds()];
    ed.fillOpts = { tolerance: 32, contiguous: false, sample: "image" };
    await ed.wandSelect(400, 400, "replace"); out.everywhere = [await selHash(), ed.getBounds()];
    ed.fillOpts = { tolerance: 32, contiguous: true, sample: "layer" };
    ed.activeLayerId = window.__ftMasked;
    await ed.wandSelect(W - 300, 50, "replace"); out.layer = [await selHash(), ed.getBounds()];
    // the bucket, clipped to a selection, into a new layer
    ed.fillOpts = { tolerance: 32, contiguous: true, sample: "image" };
    ed.sel.clear(); ed.sel.fill([200, 200, 1000, 1000], "#ff0000"); ed.markSelectionChanged([200, 200, 1000, 1000]); ed.getBounds();
    const layer = ed.addPaintLayer(); ed.activeLayerId = layer.id; ed.color = "#e0c020"; ed.brushOpacity = 1;
    await ed.bucketFill(400, 400);
    out.bucket = [await hex(layer.px.readRect(0, 0, W, H).data), (ed.status.match(/^Filled [^ ]+ px/) || [ed.status])[0]];
    ed.removeLayer(layer.id);
    ed.clearSelection();
    return out;
};
const seen = [];
const oOver = ed.floodOverTiles.bind(ed);
ed.floodOverTiles = async (...a) => { const r = await oOver(...a); seen.push(r ? (r.tiles ? "tiles" : "bitmap") : "none"); return r; };
let over, canvases;
try {
    over = await script();
    E.stacks = false;
    const n = seen.length;
    canvases = await script();
    if (seen.length !== n) throw new Error("with stacks off the flood still ran over tiles");
} finally { E.stacks = true; delete ed.floodOverTiles; }
if (!seen.includes("tiles") || !seen.includes("bitmap") || seen.includes("none")) throw new Error("the floods over tiles answered " + JSON.stringify(seen));
for (const k of Object.keys(canvases)) if (JSON.stringify(over[k]) !== JSON.stringify(canvases[k])) throw new Error(k + ": over tiles " + JSON.stringify(over[k]) + ", over canvases " + JSON.stringify(canvases[k]));
if (!over.replace[1] || !over.layer[1]) throw new Error("nothing was selected: " + JSON.stringify(over));
// B item 7: the patch in a blend mode (flat opaque colours, so the two composites are far inside the tolerance of each
// other): the flood still runs over tiles, and gives the canvases' selection and fill
const patchLayer = ed.layers.find((l) => l.name === "Patch");
patchLayer.blend = "multiply";
ed.renderLayers(); ed.draw();
if (!ed.floodStack("image")) throw new Error("no flood stack with a layer in multiply");
let overB, canvasesB;
const n0 = seen.length;
ed.floodOverTiles = async (...a) => { const r = await oOver(...a); seen.push(r ? (r.tiles ? "tiles" : "bitmap") : "none"); return r; };
try {
    overB = await script();
    const n = seen.length;
    if (n === n0 || seen.slice(n0).includes("none")) throw new Error("with a blend mode the floods over tiles answered " + JSON.stringify(seen.slice(n0)));
    E.stacks = false;
    canvasesB = await script();
    if (seen.length !== n) throw new Error("with stacks off the flood still ran over tiles");
} finally { E.stacks = true; delete ed.floodOverTiles; patchLayer.blend = "normal"; }
for (const k of Object.keys(canvasesB)) if (JSON.stringify(overB[k]) !== JSON.stringify(canvasesB[k])) throw new Error(k + " (multiply): over tiles " + JSON.stringify(overB[k]) + ", over canvases " + JSON.stringify(canvasesB[k]));
if (JSON.stringify(overB.replace) === JSON.stringify(over.replace)) throw new Error("multiply selected what normal selected: the mode was not drawn under the wand");
// B item 7 part 2: a filter layer between the layers (invert, which moves every flat colour far and exactly): the pool
// composites below it, the GPU filters the bytes, the masked layer goes over the result, and the flood runs on that
const masked = ed.layers.find((l) => l.id === window.__ftMasked);
const fx = ed.addFilterLayer("invert");
await run("move_layer", { doc: window.__t, layer: fx.id, delta: -1 });
if (ed.layers.indexOf(fx) !== ed.layers.indexOf(masked) - 1) throw new Error("the filter layer is not below the masked layer: " + ed.layers.map((l) => l.name));
ed.renderLayers(); ed.draw();
const fplan = ed.floodStack("image");
if (!fplan || !fplan.some((s) => s && s.filter) || fplan[fplan.length - 1].filter) throw new Error("no flood stack with a filter layer below a layer: " + JSON.stringify(fplan && fplan.map((s) => (s && s.filter ? "f" : "l"))));
let overF, canvasesF;
const n1 = seen.length;
ed.floodOverTiles = async (...a) => { const r = await oOver(...a); seen.push(r ? (r.tiles ? "tiles" : "bitmap") : "none"); return r; };
try {
    overF = await script();
    const n = seen.length;
    if (n === n1 || seen.slice(n1).includes("none")) throw new Error("with a filter layer the floods over tiles answered " + JSON.stringify(seen.slice(n1)));
    E.stacks = false;
    canvasesF = await script();
    if (seen.length !== n) throw new Error("with stacks off the flood still ran over tiles");
} finally { E.stacks = true; delete ed.floodOverTiles; ed.removeLayer(fx.id); }
for (const k of Object.keys(canvasesF)) if (JSON.stringify(overF[k]) !== JSON.stringify(canvasesF[k])) throw new Error(k + " (a filter layer): over tiles " + JSON.stringify(overF[k]) + ", over canvases " + JSON.stringify(canvasesF[k]));
if (!overF.replace[1] || !overF.masked[1]) throw new Error("nothing was selected under the filter: " + JSON.stringify(overF));
// the steps after this one expect the small document they had before it
ed.clearUndo();
await run("new_canvas", { width: 600, height: 300, doc: window.__t });
return { over, floods: seen.length };
"""),
    ("grow_shrink_and_feather_over_tiles_are_the_canvases", """
// B item 3 (docs/PLAN_BCE.md 3b): grow, shrink and feather read the selection's box from its tiles in a worker of the
// pool and send back the tiles that changed. Grow and shrink: the same mask as through the canvases
// (`InpaintEditor.stacks = false`), byte for byte, soft edges and partial alpha included. Feather is the browser's blur
// either way, of a box on the tile grid here and of a tight one there: a few levels of alpha apart (at most 8 allowed).
if (!ednow(window.__t).tileMode) return { skipped: "the canvas backend has no mask tiles" };
await run("new_canvas", { width: 2900, height: 2100, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const E = ed.constructor, W = ed.width, H = ed.height;
const build = () => {
    ed.clearUndo();
    ed.sel.clear();
    ed.sel.fill([300, 260, 1500, 1100], "#ff0000");
    ed.sel.drawInto([1500, 900, 2700, 1900], (x) => {
        const g = x.createRadialGradient(2100, 1400, 40, 2100, 1400, 520);
        g.addColorStop(0, "rgba(255,0,0,1)"); g.addColorStop(1, "rgba(255,0,0,0)");
        x.fillStyle = g; x.fillRect(1500, 900, 1200, 1000);
    });
    ed.sel.fill([W - 40, H - 30, W, H], "#ff0000");   // at the picture's corner: the box ends with the image
    ed.markSelectionChanged();
    ed.getBounds();
};
const read = () => ed.sel.readRect(0, 0, W, H).data;
const seen = [];
const oOver = ed.selectionOverTiles.bind(ed);
ed.selectionOverTiles = async (...a) => { const r = await oOver(...a); seen.push(r ? r.tiles : -1); return r; };
const script = async () => {
    const out = {};
    build();
    await ed.growSelection(16); out.grow = [read(), ed.getBounds()];
    await ed.growSelection(-9); out.shrink = [read(), ed.getBounds()];
    await ed.undoStep(); out.undo = [read(), ed.getBounds()];
    await ed.featherSelection(12); out.feather = [read(), ed.getBounds()];
    return out;
};
let over, canvases;
try {
    over = await script();
    const n = seen.length;
    if (n !== 3 || seen.some((t) => !(t > 0))) throw new Error("the jobs over tiles answered " + JSON.stringify(seen));
    E.stacks = false;
    canvases = await script();
    if (seen.some((t, i) => i >= n && t !== -1)) throw new Error("with stacks off a job still ran over tiles: " + JSON.stringify(seen));
} finally { E.stacks = true; delete ed.selectionOverTiles; }
const cmp = (a, b) => { let n = 0, worst = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > worst) worst = d; } } return { bytes: n, worst }; };
const out = {};
for (const k of ["grow", "shrink", "undo", "feather"]) {
    const d = cmp(over[k][0], canvases[k][0]);
    out[k] = { ...d, bounds: over[k][1] };
    if (k !== "feather" && JSON.stringify(over[k][1]) !== JSON.stringify(canvases[k][1])) throw new Error(k + ": bounds " + JSON.stringify(over[k][1]) + " over tiles, " + JSON.stringify(canvases[k][1]) + " over canvases");
    if (k === "feather") {
        // the mask is the alpha; the colour under an alpha of a few levels is whatever a canvas un-premultiplies it to
        const A = over[k][0], B = canvases[k][0];
        let alphaWorst = 0, alphaBytes = 0, colourWorst = 0;
        for (let i = 0; i < A.length; i += 4) {
            const da = Math.abs(A[i + 3] - B[i + 3]);
            if (da) { alphaBytes++; if (da > alphaWorst) alphaWorst = da; }
            if (A[i + 3] >= 32 && B[i + 3] >= 32) for (let c = 0; c < 3; c++) colourWorst = Math.max(colourWorst, Math.abs(A[i + c] - B[i + c]));
        }
        out[k] = { ...out[k], alphaWorst, alphaBytes, colourWorst };
        // measured: up to 5 levels of alpha on 0.8 % of the pixels between the two (7 with a CPU canvas in the worker): the
        // blur is Skia's on the GPU, and the box it blurs is on the tile grid here and tight around the selection there
        if (alphaWorst > 8 || colourWorst > 8) throw new Error("feather over tiles differs from the canvases: " + JSON.stringify(out[k]));
    } else if (d.bytes) throw new Error(k + " over tiles differs from the canvases: " + JSON.stringify(d));
}
// an unchanged tile is not written: growing a large rectangle leaves its inner tiles alone
ed.clearUndo(); ed.sel.clear(); ed.sel.fill([0, 0, 2048, 2048], "#ff0000"); ed.markSelectionChanged(); ed.getBounds();
seen.length = 0;
ed.selectionOverTiles = async (...a) => { const r = await oOver(...a); seen.push(r ? r.tiles : -1); return r; };
try { await ed.growSelection(8); } finally { delete ed.selectionOverTiles; }
out.changedTiles = seen[0];
if (!(seen[0] > 0 && seen[0] <= 20)) throw new Error("growing a 2048 px square by 8 wrote " + seen[0] + " tiles (its edge is 17 tiles)");
ed.clearUndo(); ed.clearSelection();
await run("new_canvas", { width: 600, height: 300, doc: window.__t });
return out;
"""),
    ("a_large_plain_png_opens_through_the_stream_reader", """
// B item 5 (docs/PLAN_BCE.md 3b): a PNG of `InpaintEditor.pngStreamFrom` pixels and more that needs no colour management
// is decoded by a pool worker straight into tiles, not through an image and a dozen reads of a canvas. The same pixels
// either way; a file with a gamma or a profile chunk, 16 bits or interlacing keeps the browser's decoder.
if (!ednow(window.__t).tileMode) return { skipped: "the stream reader fills tiles" };
const ed = ednow(window.__t);
host.shell.activate(ed);
const E = ed.constructor, PNG = await import("./editor/inpaint_png.js");
const W = 1500, H = 1100;
const c = document.createElement("canvas"); c.width = W; c.height = H;
const x = c.getContext("2d");
const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#e04030"); g.addColorStop(0.5, "#30c0a0"); g.addColorStop(1, "#2030d0");
x.fillStyle = g; x.fillRect(0, 0, W, H);
x.clearRect(200, 150, 300, 200);
x.fillStyle = "rgba(255,255,0,0.4)"; x.fillRect(700, 300, 500, 500);
// partly transparent pixels over nothing: what a canvas does to straight alpha is what `writeRect` does to the reader's rows
x.fillStyle = "rgba(10,200,90,0.35)"; x.fillRect(250, 180, 100, 100);
const blob = await new Promise((r) => c.toBlob(r, "image/png"));
const was = E.pngStreamFrom;
const hex = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", u8))).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
const out = {};
try {
    E.pngStreamFrom = 1000000;
    const route = await E.parts.pngRoute(blob);
    if (!route || route.width !== W) throw new Error("a plain 8-bit PNG above the threshold was not routed to the reader: " + JSON.stringify(route));
    let streamed = 0;
    const pool = E.parts.pool(), oRun = pool.run.bind(pool);
    pool.run = (op, ...a) => { if (op === "png_read") streamed++; return oRun(op, ...a); };
    try {
        await ed.loadFile(new File([blob], "stream_a.png", { type: "image/png" }));
        if (ed.width !== W || streamed !== 1) throw new Error("the file was not read as a stream: " + streamed + ", " + ed.status);
        out.stream = await hex(ed.basePx.readRect(0, 0, W, H).data);
        E.pngStreamFrom = 0;
        await ed.loadFile(new File([blob], "stream_b.png", { type: "image/png" }));
        if (streamed !== 1) throw new Error("with the threshold off the file was still read as a stream");
        out.image = await hex(ed.basePx.readRect(0, 0, W, H).data);
    } finally { pool.run = oRun; }
    if (out.stream !== out.image) throw new Error("the stream reader and the image give different pixels: " + JSON.stringify(out));
    // a gamma chunk in front of the pixels: the browser applies it, the reader would not, so it is not the reader's file
    E.pngStreamFrom = 1000000;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const gama = PNG.pngChunk("gAMA", Uint8Array.of(0, 0, 0x6f, 0x1a));   // 1 / 3.5
    const withGamma = new Blob([bytes.subarray(0, 33), gama, bytes.subarray(33)], { type: "image/png" });
    out.gamma = await E.parts.pngRoute(withGamma);
    if (out.gamma) throw new Error("a PNG with a gAMA chunk was routed to the reader");
    E.pngStreamFrom = 1e9;
    out.small = await E.parts.pngRoute(blob);
    if (out.small) throw new Error("a PNG below the threshold was routed to the reader");
} finally { E.pngStreamFrom = was; }
ed.clearUndo();
await run("new_canvas", { width: 600, height: 300, doc: window.__t });
return out;
"""),
    ("a_stroke_commits_through_the_kernel_on_tiles", """
// docs/BUGS.md "Releasing an erase stroke is its own stutter": on tiles a stroke is committed a tile at a time through
// the compositing kernel (`commitStrokeTiles` -> `compositeStroke`), not band by band through canvases (0.29 s of
// blocked window for a long erase at 15000 x 10000). The same stroke on two layers with the same pixels, once each way:
// painting at an opacity, erasing, painting with the alpha locked, and both clipped to a selection. Pixels the stroke
// does not reach are the same bytes; the rest within two levels of colour premultiplied by alpha; undo gives the layer
// back byte for byte.
if (!ednow(window.__t).tileMode) return { skipped: "the kernel commit is the tile engine's" };
await run("new_canvas", { width: 3000, height: 2000, doc: window.__t });
const ed = ednow(window.__t);
host.shell.activate(ed);
const E = ed.constructor, W = ed.width, H = ed.height;
const fill = (l) => l.px.drawInto(null, (x) => {
    x.fillStyle = "#3060c0"; x.fillRect(100, 100, 1500, 1100);
    x.fillStyle = "rgba(200,90,40,0.55)"; x.fillRect(900, 600, 1600, 1100);
    const g = x.createRadialGradient(2200, 500, 50, 2200, 500, 500); g.addColorStop(0, "rgba(40,200,90,0.9)"); g.addColorStop(1, "rgba(40,200,90,0)");
    x.fillStyle = g; x.fillRect(1700, 0, 1000, 1000);
});
const path = []; for (let i = 0; i <= 30; i++) path.push([250 + i * 80, 500 + Math.round(Math.sin(i / 4) * 400)]);
const bytes = (l) => l.px.readRect(0, 0, l.px.width, l.px.height).data;
const cases = [
    { name: "paint", erase: false, opacity: 0.6, clip: false, lock: false },
    { name: "erase", erase: true, opacity: 1, clip: false, lock: false },
    { name: "erase at an opacity", erase: true, opacity: 0.45, clip: false, lock: false },
    { name: "paint, alpha locked", erase: false, opacity: 0.8, clip: false, lock: true },
    { name: "paint, clipped", erase: false, opacity: 0.7, clip: true, lock: false },
    { name: "erase, clipped", erase: true, opacity: 1, clip: true, lock: false },
];
const out = {};
const pool = [];
let calls = 0;
const was = E.strokeTiles;
try {
    for (const c of cases) {
        ed.sel.clear();
        if (c.clip) { ed.sel.drawInto(null, (s) => { s.fillStyle = "#ff0000"; s.fillRect(700, 250, 1300, 700); s.fillStyle = "rgba(255,0,0,0.5)"; s.fillRect(1900, 250, 500, 700); }); }
        ed.markSelectionChanged();
        ed.getBounds();
        const pair = [];
        for (const kernel of [true, false]) {
            const l = ed.addPaintLayer();
            fill(l);
            // a clipped layer off the origin: the selection under a tile is read where the layer lies
            if (c.clip) { l.x = 137; l.y = 61; ed.renderLayers(); }
            l.alphaLock = c.lock;
            ed.activeLayerId = l.id;
            ed.brushSize = 110; ed.hardness = 0.35; ed.eraseHardness = 0.35; ed.brushOpacity = c.opacity; ed.color = "#f0e020";
            const before = bytes(l).slice();
            E.strokeTiles = kernel;
            const p = { kind: "layerpaint", layer: l, stroke: ed.newStrokeBuffer(l.px), clip: c.clip ? ed.strokeClip(l, l.px) : null, erase: c.erase, last: path[0], pressure: 1, bounds: null };
            ed.pointer = p;
            ed.layerDab(p, path[0][0], path[0][1], path[0][0], path[0][1]);
            for (let i = 1; i < path.length; i++) ed.layerDab(p, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
            const oc = l.px.compositeStroke;
            l.px.compositeStroke = function (...a) { calls++; return oc.apply(this, a); };
            let n0 = calls;
            try { ed.commitStroke(p); } finally { delete l.px.compositeStroke; }
            ed.pointer = null;
            if (kernel && calls === n0) throw new Error(c.name + ": the commit did not go through the kernel");
            if (!kernel && calls !== n0) throw new Error(c.name + ": with the switch off the commit still went through the kernel");
            pair.push({ l, before, after: bytes(l).slice(), stroke: p.stroke });
        }
        const [k, b] = pair;
        let differ = 0, worst = 0, untouchedDiffer = 0, changed = 0;
        const reach = k.stroke.px;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                const t = reach.tileAt(x >> 8, y >> 8);
                const inStroke = t && t.data[((y & 255) * 256 + (x & 255)) * 4 + 3] > 0;
                const ka = k.after[i + 3], ba = b.after[i + 3];
                let d = Math.abs(ka - ba);
                for (let q = 0; q < 3; q++) d = Math.max(d, Math.abs(Math.round(k.after[i + q] * ka / 255) - Math.round(b.after[i + q] * ba / 255)));
                if (!inStroke) {
                    for (let q = 0; q < 4; q++) if (k.after[i + q] !== k.before[i + q]) { untouchedDiffer++; break; }
                    continue;
                }
                if (k.after[i + 3] !== k.before[i + 3] || k.after[i] !== k.before[i]) changed++;
                if (d) { differ++; if (d > worst) worst = d; }
            }
        }
        if (untouchedDiffer) throw new Error(c.name + ": the kernel commit changed " + untouchedDiffer + " pixels the stroke does not reach");
        if (!(changed > 1000)) throw new Error(c.name + ": the stroke changed only " + changed + " pixels");
        if (worst > 2) throw new Error(c.name + ": the kernel commit is " + worst + " levels off the bands' on " + differ + " pixels");
        // undo (the bands' stroke, then the kernel's) gives both layers back as they were, byte for byte
        await ed.undoStep(); await ed.undoStep();
        for (const [what, q] of [["the kernel's", k], ["the bands'", b]]) {
            const back = bytes(q.l);
            for (let i = 0; i < back.length; i++) if (back[i] !== q.before[i]) throw new Error(c.name + ": undo of " + what + " stroke left byte " + i + " at " + back[i] + ", was " + q.before[i]);
        }
        out[c.name] = { changed, differ, worst };
        ed.removeLayer(k.l.id); ed.removeLayer(b.l.id);
    }
} finally { E.strokeTiles = was; ed.pointer = null; }
ed.clearUndo(); ed.sel.clear(); ed.markSelectionChanged();
await run("new_canvas", { width: 600, height: 300, doc: window.__t });
return out;
"""),
    ("large_image_files_open_in_a_worker", lambda c: large_images_step(c)),
    # the Undo history (0.1.31): in this order, on the document the first of them opens and the last closes
    ("undo_history_lists_three_edits_as_labelled_rows", UNDO_HISTORY_ROWS),
    ("undo_history_row_click_jumps_back_and_forward", UNDO_HISTORY_JUMPS),
    ("undo_history_snapshot_restores_twice_and_is_undoable", UNDO_HISTORY_SNAPSHOTS),
    ("undo_history_depth_trims_to_its_steps", UNDO_HISTORY_DEPTH),
    ("undo_history_commands_match_the_list", UNDO_HISTORY_COMMANDS),
    # 3e: a mask switched off (PSD's "disabled") is undone, redone, kept by the steps that hold the mask, and saved
    ("a_switched_off_mask_is_undone_and_saved", """
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = {};
try {
    await run("new_canvas", { width: 400, height: 300, doc: d.id });
    const L = ed.addPaintLayer();
    const id = L.id;
    const lay = () => ed.layers.find((l) => l.id === id);   // a "layers" step puts copies back: looked up each time
    L.px.fill([0, 0, 400, 300], "#2060c0"); ed.markLayerChanged(L);
    await run("select_rect", { x: 50, y: 50, w: 200, h: 100, doc: d.id });
    ed.maskFromSelection(L);
    await run("select_none", { doc: d.id });
    if (!lay().maskPx || lay().maskOff) throw new Error("the mask from the selection is missing or off");
    const summary = async () => (await run("list_layers", { doc: d.id })).layers.find((l) => l.id === id);
    // the switch and its undo step
    const v0 = ed.compositeVersion;
    if (!ed.setMaskOff(lay(), true) || !lay().maskOff || ed.liveMask(lay())) throw new Error("setMaskOff(true) did not switch the mask off");
    // what is drawn changed: every cache keyed on the composite version (filters, colour match above) goes
    if (ed.compositeVersion === v0) throw new Error("the switch left the composite version where it was");
    if (!(await summary()).mask_off) throw new Error("list_layers does not say the mask is off");
    if (ed.setMaskOff(lay(), true)) throw new Error("switching an off mask off again pushed a step");
    await ed.undoStep();
    if (lay().maskOff || !lay().maskPx) throw new Error("the undo did not switch the mask on again");
    await ed.redoStep();
    if (!lay().maskOff) throw new Error("the redo did not switch it off again");
    out.labels = ed.undoList().slice(-1).map((r) => r.label);
    // a step that holds the mask holds its switch: remove and undo, apply and undo
    ed.removeMask(lay());
    if (lay().maskPx || lay().maskOff) throw new Error("the removed mask left its switch on");
    await ed.undoStep();
    if (!lay().maskPx || !lay().maskOff) throw new Error("the undo of a remove brought the mask back " + (lay().maskPx ? "switched on" : "not at all"));
    ed.applyMask(lay());
    if (lay().maskPx || lay().px.readRect(10, 10, 1, 1).data[3] !== 0 || lay().px.readRect(100, 80, 1, 1).data[3] !== 255) throw new Error("applying a switched-off mask did not bake it in");
    await ed.undoStep();
    if (!lay().maskPx || !lay().maskOff || lay().px.readRect(10, 10, 1, 1).data[3] !== 255) throw new Error("the undo of the apply did not bring the switched-off mask and the whole pixels back");
    // saved and restored (the autosave bundle and .scumble both take getValue's layers)
    if (ed.syncLayers) await ed.syncLayers();
    const value = ed.getValue();
    const saved = (typeof value === "string" ? JSON.parse(value) : value).layers.find((l) => l.id === id);
    if (!saved || saved.maskOff !== true || !saved.mask) throw new Error("getValue does not keep the switch: " + JSON.stringify(saved && { mask: saved.mask, maskOff: saved.maskOff }));
    const d2 = await run("new_document");
    const ed2 = ednow(d2.id);
    try {
        await ed2.setValue(value);
        const l2 = ed2.layers.find((l) => l.id === id);
        if (!l2 || !l2.maskPx || l2.maskOff !== true) throw new Error("the restore lost the switch: " + JSON.stringify(l2 && { mask: !!l2.maskPx, maskOff: l2.maskOff }));
    } finally { await run("close_document", { doc: d2.id, force: true }); }
    // editing a switched-off mask switches it on (painting it would show nothing)
    ed.toggleMaskEdit(lay());
    if (lay().maskOff || !lay().maskEdit) throw new Error("editing the mask left it switched off");
    ed.toggleMaskEdit(lay());
    out.saved = true;
} finally { await run("close_document", { doc: d.id, force: true }); }
return out;
"""),
    ("a_transform_says_it_baked_the_mask", """
// rotate, distort and warp bake a live mask into the new pixels and drop a switched-off one: the status says so, and the
// undo step brings the mask back (docs/BUGS.md, found by reading 2026-09-26)
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = {};
try {
    await run("new_canvas", { width: 400, height: 300, doc: d.id });
    const L = ed.addPaintLayer();
    const id = L.id;
    const lay = () => ed.layers.find((l) => l.id === id);
    L.px.fill([0, 0, 400, 300], "#2060c0"); ed.markLayerChanged(L);
    await run("select_rect", { x: 50, y: 50, w: 200, h: 100, doc: d.id });
    ed.maskFromSelection(L);
    await run("select_none", { doc: d.id });
    ed.activeLayerId = id;
    ed.startPending("rotate");
    ed.pending.angle = 10 * Math.PI / 180;
    ed.applyPending();
    out.live = ed.status;
    if (!/mask is baked/.test(ed.status)) throw new Error("a rotate over a live mask says nothing about it: " + ed.status);
    if (lay().maskPx) throw new Error("the rotate kept the mask");
    await ed.undoStep();
    if (!lay().maskPx || lay().maskOff) throw new Error("the undo did not bring the live mask back");
    ed.setMaskOff(lay(), true);
    ed.activeLayerId = id;
    ed.startPending("distort");
    ed.pending.points[1][0] += 20;
    ed.applyPending();
    out.off = ed.status;
    if (!/switched-off mask was dropped/.test(ed.status)) throw new Error("a distort over a switched-off mask says nothing about it: " + ed.status);
    await ed.undoStep();
    if (!lay().maskPx || !lay().maskOff) throw new Error("the undo did not bring the switched-off mask back");
    // a layer without a mask: no note
    ed.removeMask(lay());
    ed.activeLayerId = id;
    ed.startPending("rotate");
    ed.pending.angle = 5 * Math.PI / 180;
    ed.applyPending();
    out.none = ed.status;
    if (/mask/.test(ed.status)) throw new Error("a rotate without a mask speaks of one: " + ed.status);
} finally { await run("close_document", { doc: d.id, force: true }); }
return out;
"""),
    ("smudge_clone_and_heal_read_only_their_box", """
// PLAN_0_1_31 §4 step 2: clone and heal flattened the whole picture at every press, the smudge read the layer's whole
// display mirror at every step and copied the base into a full-size layer. Now each reads the box under its dab through
// the gesture's source (brushSource): from the tiles on tiles, a region pass on canvases. The real handlers through
// synthetic pointer events; uniform patches of the base, so the check does not depend on where a pointer lands
const P = await import("./editor/inpaint_pixels.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const W = 4000, H = 3000;
const out = { tiles: !!ed.tileMode };
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const calls = { compositeCanvas: 0, flattenToCanvas: 0, sampleCanvas: 0 };
let counting = false;
try {
    await run("new_canvas", { width: W, height: H, doc: d.id });
    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, "#803020"); g.addColorStop(1, "#203080");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        for (let i = 0; i < 300; i++) { x.fillStyle = `hsl(${(i * 47) % 360},70%,${30 + (i * 13) % 40}%)`; x.fillRect((i * 977) % W, (i * 613) % H, 30 + (i % 7) * 9, 30 + (i % 5) * 11); }
        x.fillStyle = "#20c040"; x.fillRect(400, 400, 600, 600);      // A: the clone / heal source
        x.fillStyle = "#c03080"; x.fillRect(2000, 400, 600, 600);     // B: where clone and heal paint
        x.fillStyle = "#e0e000"; x.fillRect(400, 1800, 600, 600);     // C, and D right of it: the base smudge
        x.fillStyle = "#0000e0"; x.fillRect(1000, 1800, 600, 600);
    }
    Object.defineProperty(base, "naturalWidth", { value: W }); Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "brushbox_test.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    // a half-transparent textured layer over it, empty over A, B, C, D and the smudge's field; a red block to smudge from
    const pc = mk(W, H);
    {
        const x = pc.getContext("2d");
        for (let i = 0; i < 300; i++) { x.fillStyle = `hsla(${(i * 71) % 360},80%,50%,0.5)`; x.fillRect((i * 433) % W, (i * 271) % H, 60 + (i % 9) * 10, 60 + (i % 4) * 15); }
        x.clearRect(300, 300, 2400, 800); x.clearRect(300, 1700, 1400, 800); x.clearRect(2700, 1400, 1100, 700);
        x.fillStyle = "#e02020"; x.fillRect(2800, 1500, 400, 400);
    }
    const L = ed.addLayer({ name: "P", kind: "paint", px: ed.pixels.Layer.fromCanvas(pc), x: 0, y: 0, w: W, h: H, dirty: true });
    // a colour-matched layer far from every stroke: the tile source has to carry it (it is the app's common case)
    const mc = mk(500, 400); { const x = mc.getContext("2d"); x.fillStyle = "#808080"; x.fillRect(0, 0, 500, 400); }
    const M = ed.addLayer({ name: "M", kind: "paint", px: ed.pixels.Layer.fromCanvas(mc), x: 3300, y: 2500, w: 500, h: 400, dirty: true });
    M.match = { strength: 100, source: "surroundings" };
    ed.renderLayers(); ed.draw();
    await ed.mipsSettled();
    for (const k of Object.keys(calls)) { const f = ed[k]; ed[k] = function (...a) { if (counting) calls[k]++; return f.apply(this, a); }; }
    ed.view.angle = 0; ed.view.scale = 0.4; ed._fitted = false; ed.view.x = 20; ed.view.y = 20; ed.draw();
    let pid = 700;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy, extra = {}) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: "mouse", pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy), extra));
    const send = (type, ix, iy, extra) => { counting = true; try { ed.canvas.dispatchEvent(ev(type, ix, iy, extra)); } finally { counting = false; } };
    // a stroke from a to b in six moves; what the gesture's source was, read while the button is down
    const stroke = (a, b) => {
        pid++;
        send("pointerdown", a[0], a[1]);
        const p = ed.pointer;
        const tier = p ? (p.clone ? p.clone.src.tier + (p.clone.dest && p.clone.dest !== p.clone.src ? "+" + p.clone.dest.tier : "") : p.src ? p.src.tier : "own") : null;
        for (let i = 1; i <= 6; i++) send("pointermove", a[0] + (b[0] - a[0]) * i / 6, a[1] + (b[1] - a[1]) * i / 6);
        send("pointerup", b[0], b[1]);
        return tier;
    };
    const px = (l, x, y) => Array.from(l.px.readRect(x, y, 1, 1).data);
    const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    const mirrors = () => ed.tileMode ? [!!P.displayCanvasIfMade(L.px), !!P.displayCanvasIfMade(ed.basePx)] : null;
    const m0 = mirrors();
    ed.brushSize = 200; ed.hardness = 1; ed.brushOpacity = 1; ed.brushTipId = null;
    ed.activeLayerId = L.id; ed.renderLayers();
    // 1. clone from A into B, the whole picture as the source; the undo gives the layer's bytes back
    ed.setTool("clone");
    ed.cloneOpts = { sample: "image", aligned: false };
    send("pointerdown", 700, 700, { altKey: true }); send("pointerup", 700, 700);
    if (!ed.cloneSource) throw new Error("Alt+click set no clone source: " + ed.status);
    const box0 = L.px.readRect(2150, 550, 300, 300).data.slice();
    out.clone = stroke([2300, 700], [2350, 700]);
    const cl = px(L, 2320, 700);
    if (!near(cl, [0x20, 0xc0, 0x40, 255], 3)) throw new Error("clone: the layer at the dab is " + cl + ", not the source's green");
    await ed.undoStep();
    const box1 = L.px.readRect(2150, 550, 300, 300).data;
    let diff = 0; for (let i = 0; i < box1.length; i++) if (box1[i] !== box0[i]) diff++;
    if (diff) throw new Error("the undo of the clone left " + diff + " bytes changed");
    // 2. heal: the source's texture takes the destination's colour (uniform here, so B itself)
    ed.setTool("heal");
    out.heal = stroke([2300, 700], [2350, 700]);
    const he = px(L, 2320, 700);
    if (!near(he, [0xc0, 0x30, 0x80, 255], 4)) throw new Error("heal: the layer at the dab is " + he + ", not the destination's colour");
    // 3. heal with the layer alone as its source: the source (the layer, empty over A) is transparent, nothing lands
    ed.cloneOpts = { sample: "layer", aligned: false };
    send("pointerdown", 700, 1000, { altKey: true }); send("pointerup", 700, 1000);
    const before3 = px(L, 2320, 1000);
    out.healLayer = stroke([2300, 1000], [2350, 1000]);
    if (!near(px(L, 2320, 1000), before3, 0)) throw new Error("heal from an empty patch of the layer painted " + px(L, 2320, 1000));
    // 4. smudge on the layer, its own pixels: the red block is dragged into the empty field right of it
    ed.setTool("smudge");
    ed.smudgeOpts.sample = "layer"; ed.smudgeOpts.strength = 80;
    const sm0 = px(L, 3240, 1700);
    out.smudge = stroke([3150, 1700], [3400, 1700]);
    const sm = px(L, 3240, 1700);
    if (!(sm[3] > 0 && sm[0] > sm[2]) || sm0[3] !== 0) throw new Error("smudge: the field right of the red block is " + sm + " (was " + sm0 + ")");
    // 5. smudge on the base: a new layer from the picture, the base untouched, no base copy
    ed.activeLayerId = null; ed.renderLayers();
    const n0 = ed.layers.length, base0 = Array.from(ed.basePx.readRect(1030, 2100, 1, 1).data);
    out.smudgeBase = stroke([850, 2100], [1150, 2100]);
    if (ed.layers.length !== n0 + 1) throw new Error("smudge on the base added " + (ed.layers.length - n0) + " layers");
    const N = ed.activeLayer();
    if (!N || N.kind !== "paint" || /copy/i.test(N.name)) throw new Error("smudge on the base made " + (N && N.kind) + " " + (N && N.name));
    const nb = px(N, 1030, 2100);
    if (!(nb[3] > 0 && nb[0] > nb[2])) throw new Error("the new layer right of the yellow is " + nb + ": the smudge did not take the picture");
    if (!near(Array.from(ed.basePx.readRect(1030, 2100, 1, 1).data), base0, 0)) throw new Error("smudge on the base wrote the base");
    out.calls = calls;
    out.mirrors = [m0, mirrors()];
    const want = ed.tileMode ? "tiles" : "region";
    for (const k of ["clone", "heal", "healLayer", "smudgeBase"]) if (!String(out[k]).split("+").every((t) => t === want)) throw new Error(k + " read through " + out[k] + ", not " + want);
    if (out.smudge !== "own") throw new Error("the smudge with Sample: layer read through " + out.smudge);
    if (calls.compositeCanvas || calls.flattenToCanvas || calls.sampleCanvas) throw new Error("a brush read the whole picture: " + JSON.stringify(calls));
    if (ed.tileMode && ((!m0[0] && out.mirrors[1][0]) || (!m0[1] && out.mirrors[1][1]))) throw new Error("a brush made a display mirror: " + JSON.stringify(out.mirrors));
} finally {
    for (const k of Object.keys(calls)) delete ed[k];
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("heal_blends_the_source_into_the_picture_at_the_release", """
// PLAN_0_1_31 §5 step 2: heal lays the Poisson blend at the release (the dabs' mean shift is only the preview): the
// source's texture with the picture's colour and light up to the stroke's edge. The real handlers through synthetic
// pointer events. The layer holds the kernel's result over the box the release took, bit for bit (and so equal with the
// twin in the page); a small stroke blends at once, a large one in a worker while the gesture is held; the selection
// cuts the healed region and the blend meets the picture at its edge too; quick mask refuses the brush
const J = await import("./editor/px/kernels_js.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const IE = ed.constructor;
const keep = { sync: IE.healSyncMax, kernels: IE.kernels, blend: IE.healBlend };
const W = 1600, H = 1000;
const out = { tiles: !!ed.tileMode };
try {
    await run("new_canvas", { width: W, height: H, doc: d.id });
    // the picture: a lit gradient with a fine grain; the source A: a warm, coarser texture far from it in colour
    const base = document.createElement("canvas"); base.width = W; base.height = H;
    {
        const img = new ImageData(W, H), a = img.data;
        const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return (h >>> 24) / 255; };
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 4, n = hash(x, y) - 0.5;
            if (x >= 200 && x < 600 && y >= 200 && y < 600) { const t = hash(x >> 2, y >> 2) - 0.5; a[o] = 200 + 40 * t + 10 * n; a[o + 1] = 70 + 40 * t; a[o + 2] = 50 + 30 * t; }
            else { a[o] = 60 + 0.06 * x + 12 * n; a[o + 1] = 90 + 0.05 * y + 12 * n; a[o + 2] = 140 - 0.04 * x + 12 * n; }
            a[o + 3] = 255;
        }
        base.getContext("2d").putImageData(img, 0, 0);
    }
    Object.defineProperty(base, "naturalWidth", { value: W }); Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "heal_blend_test.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    const L = ed.addPaintLayer();
    ed.activeLayerId = L.id; ed.renderLayers();
    await ed.mipsSettled();
    ed.view.angle = 0; ed.view.scale = 0.5; ed._fitted = false; ed.view.x = 10; ed.view.y = 10; ed.draw();
    let pid = 900;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy, extra = {}) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: "mouse", pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy), extra));
    const send = (type, ix, iy, extra) => ed.canvas.dispatchEvent(ev(type, ix, iy, extra));
    const stroke = (a, b) => {
        pid++;
        send("pointerdown", a[0], a[1]);
        for (let i = 1; i <= 8; i++) send("pointermove", a[0] + (b[0] - a[0]) * i / 8, a[1] + (b[1] - a[1]) * i / 8);
        send("pointerup", b[0], b[1]);
    };
    ed.brushSize = 120; ed.hardness = 1; ed.brushOpacity = 1; ed.brushTipId = null;
    ed.setTool("heal");
    ed.cloneOpts = { sample: "image", aligned: false };
    pid++; send("pointerdown", 400, 400, { altKey: true }); send("pointerup", 400, 400);
    if (!ed.cloneSource) throw new Error("Alt+click set no source: " + ed.status);
    const boxBytes = (b) => L.px.readRect(b[0], b[1], b[2], b[3]).data;
    const empty = (b) => { const a = boxBytes(b); for (let i = 0; i < a.length; i++) if (a[i]) return false; return true; };
    // the kernel over the box the release took: the picture (the base, the layer is empty) and the source at the offset
    const expect = (h) => {
        const [x, y, w, hh] = h.box, n = w * hh;
        const dst = ed.basePx.readRect(x, y, w, hh).data, src = ed.basePx.readRect(x + h.off[0], y + h.off[1], w, hh).data;
        const got = boxBytes(h.box), mask = new Uint8Array(n);
        for (let k = 0; k < n; k++) mask[k] = got[4 * k + 3] ? 255 : 0;
        const want = J.poissonBlend(dst, src, mask, w, hh);
        let differ = 0, full = 0;
        for (let k = 0; k < n; k++) if (got[4 * k + 3] === 255) { full++; for (let c = 0; c < 3; c++) if (got[4 * k + c] !== want[4 * k + c]) differ++; }
        return { differ, full, got, dst, src, w, h: hh };
    };
    // within 3 px of the stroke's edge the heal is near the picture while the source is far from it; inside, heal minus
    // source (the correction) is harmonic: its Laplacian within the rounding of two roundings (4)
    const seam = (r) => {
        const { got, dst, src, w, h } = r, A = (k) => got[4 * k + 3];
        let n = 0, dHeal = 0, dSrc = 0, lap = 0, inside = 0;
        for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
            const k = y * w + x;
            if (A(k) !== 255) continue;
            if (A(k - 3) < 255 || A(k + 3) < 255 || A(k - 3 * w) < 255 || A(k + 3 * w) < 255) {
                for (let c = 0; c < 3; c++) { dHeal += Math.abs(got[4 * k + c] - dst[4 * k + c]); dSrc += Math.abs(src[4 * k + c] - dst[4 * k + c]); }
                n++;
            } else {
                for (let c = 0; c < 3; c++) { const u = (q) => got[4 * q + c] - src[4 * q + c]; lap = Math.max(lap, Math.abs(4 * u(k) - u(k - 1) - u(k + 1) - u(k - w) - u(k + w))); }
                inside++;
            }
        }
        return { edge: n, heal: +(dHeal / (3 * n)).toFixed(2), source: +(dSrc / (3 * n)).toFixed(2), lap, inside };
    };
    const A0 = [1000, 500], B0 = [1150, 500];
    // 1. a small stroke: blended at the release, here
    const n0 = ed.undoList().length;
    stroke(A0, B0);
    const h1 = ed.lastHeal;
    if (!h1 || h1.where !== "here") throw new Error("the small heal was not blended at the release: " + JSON.stringify(h1));
    const r1 = expect(h1), s1 = seam(r1);
    out.small = { box: h1.box, off: h1.off, unknowns: h1.unknowns, cycles: h1.info && h1.info[1], ms: h1.ms, full: r1.full, differ: r1.differ, seam: s1, steps: ed.undoList().length - n0 };
    if (r1.full < 10000 || r1.differ) throw new Error("the layer is not the kernel's blend over the box: " + JSON.stringify(out.small));
    if (!(s1.edge > 500 && s1.heal * 4 < s1.source && s1.lap <= 4 && s1.inside > 5000)) throw new Error("the blend does not meet the picture at its edge: " + JSON.stringify(out.small));
    if (out.small.steps !== 1) throw new Error("the heal left " + out.small.steps + " undo steps");
    const bytes1 = boxBytes(h1.box).slice();
    await ed.undoStep();
    if (!empty(h1.box)) throw new Error("the undo of the heal left pixels on the layer");
    // two strokes are compared where both cover fully: the dabs' soft edge is drawn through canvases, and after many
    // readbacks Chromium makes new canvases software, whose edge differs by a level (CLAUDE.md, canvas traps)
    const inside = (a, b) => { let n = 0; for (let k = 0; k < a.length; k += 4) if (a[k + 3] === 255 && b[k + 3] === 255) for (let c = 0; c < 3; c++) if (a[k + c] !== b[k + c]) n++; return n; };
    // 2. the twin in the page gives the same blend
    IE.kernels = "js";
    try { stroke(A0, B0); } finally { IE.kernels = keep.kernels; }
    const r2 = expect(ed.lastHeal);
    out.twin = { box: ed.lastHeal.box, info: ed.lastHeal.info, differ: r2.differ, inside: inside(r2.got, bytes1) };
    if (r2.differ || out.twin.inside || JSON.stringify(ed.lastHeal.box) !== JSON.stringify(h1.box)) throw new Error("the twin healed otherwise: " + JSON.stringify(out.twin));
    await ed.undoStep();
    if (!empty(h1.box)) { const a = boxBytes(h1.box); let n = 0, k0 = -1; for (let k = 0; k < a.length; k += 4) if (a[k + 3]) { n++; if (k0 < 0) k0 = k; } throw new Error("the undo of the twin's heal left " + n + " pixels, first " + Array.from(a.slice(k0, k0 + 4)) + " at " + ((k0 / 4) % h1.box[2]) + "," + (((k0 / 4) / h1.box[2]) | 0) + "; undo " + JSON.stringify(ed.undoList().map((r) => r.label))); }
    // 3. a large one (every stroke, here): in a worker while the gesture is held; a press meanwhile does nothing
    IE.healSyncMax = 0;
    const n3 = ed.undo.length;
    stroke(A0, B0);
    const held = !!(ed.pointer && ed.pointer.healing), gh = ed.gestureHeld(), pend = !!ed.healPending;
    const pHeld = ed.pointer;
    pid++; send("pointerdown", 1300, 800); send("pointermove", 1350, 800); send("pointerup", 1350, 800);
    const still = ed.pointer === pHeld;
    await ed.healPending;
    const r3 = expect(ed.lastHeal);
    out.large = { held, gestureHeld: gh, pending: pend, pressWaited: still, where: ed.lastHeal.where, ms: ed.lastHeal.ms, differ: r3.differ, inside: inside(r3.got, bytes1), steps: ed.undo.length - n3, after: ed.pointer === null };
    if (!held || !gh || !pend || !still) throw new Error("the large heal did not hold the gesture: " + JSON.stringify(out.large));
    if (r3.differ || out.large.inside || !out.large.after || out.large.steps !== 1 || out.large.where !== "worker") throw new Error("the large heal landed otherwise: " + JSON.stringify(out.large));
    await ed.undoStep();
    // 3b. Ctrl+Z pressed while it blends waits for it and takes it back (the review of 2026-09-28: it was refused)
    stroke(A0, B0);
    const undone = ed.undoStep();
    await ed.healPending; await undone;
    out.undoWhileHeld = { empty: empty(h1.box), label: ed.undoList().filter((r) => r.future).map((r) => r.label) };
    if (!out.undoWhileHeld.empty) throw new Error("an undo pressed while the heal blended did not take it back: " + JSON.stringify(out.undoWhileHeld));
    IE.healSyncMax = keep.sync;
    // 4. the selection cuts the healed region: nothing lands right of it, and at its edge the blend meets the picture
    await run("select_rect", { x: 900, y: 400, w: 170, h: 200, doc: d.id });
    stroke(A0, B0);
    const h4 = ed.lastHeal, r4 = expect(h4), [bx, by, bw, bh] = h4.box;
    let right = 0, edgeD = 0, edgeS = 0, edgeN = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const k = y * bw + x, X = bx + x;
        if (X >= 1070 && r4.got[4 * k + 3]) right++;
        if (X === 1068 && r4.got[4 * k + 3] === 255) { for (let c = 0; c < 3; c++) { edgeD += Math.abs(r4.got[4 * k + c] - r4.dst[4 * k + c]); edgeS += Math.abs(r4.src[4 * k + c] - r4.dst[4 * k + c]); } edgeN++; }
    }
    out.selection = { differ: r4.differ, right, edgeN, heal: +(edgeD / (3 * edgeN)).toFixed(2), source: +(edgeS / (3 * edgeN)).toFixed(2) };
    if (r4.differ || right || edgeN < 50 || out.selection.heal * 4 > out.selection.source) throw new Error("the selection did not cut the blend: " + JSON.stringify(out.selection));
    await ed.undoStep();
    // 4b. a deselect while a large heal blends: the commit clips by the selection of the release, not by none (it wrote
    // nothing before: the review of 2026-09-28); the shortcut waits, a deselect by command does not
    IE.healSyncMax = 0;
    stroke(A0, B0);
    ed.clearSelection();
    await ed.healPending;
    IE.healSyncMax = keep.sync;
    const r4b = expect(ed.lastHeal);
    let right4b = 0; for (let k = 0; k < r4b.got.length; k += 4) if (r4b.got[k + 3] && ed.lastHeal.box[0] + ((k / 4) % ed.lastHeal.box[2]) >= 1070) right4b++;
    out.deselectWhileHeld = { full: r4b.full, differ: r4b.differ, right: right4b };
    if (r4b.full < 5000 || r4b.differ || right4b) throw new Error("a deselect during the blend changed its commit: " + JSON.stringify(out.deselectWhileHeld));
    await ed.undoStep(); await ed.undoStep();
    await run("select_none", { doc: d.id });
    // 5. the quick heal as before when the blend is off: the preview's colours land (not the blend's)
    IE.healBlend = false;
    const last = ed.lastHeal;
    try { stroke(A0, B0); } finally { IE.healBlend = keep.blend; }
    const d5 = inside(boxBytes(h1.box), bytes1);
    out.off = { differ: d5, noted: ed.lastHeal !== last };
    if (!d5 || out.off.noted) throw new Error("with the blend off the heal still blended: " + JSON.stringify(out.off));
    await ed.undoStep();
    // 5b. a layer not at the origin: the box is the image's, the layer's pixels shifted by its place
    const M = ed.addLayer({ name: "O", kind: "paint", px: ed.pixels.Layer.empty(1400, 900), x: 37, y: -21, w: 1400, h: 900 });
    ed.activeLayerId = M.id; ed.renderLayers();
    stroke(A0, B0);
    {
        const h = ed.lastHeal, [x, y, w, hh] = h.box, n = w * hh;
        const got = M.px.readRect(x - 37, y + 21, w, hh).data, dst = ed.basePx.readRect(x, y, w, hh).data, src = ed.basePx.readRect(x + h.off[0], y + h.off[1], w, hh).data;
        const mask = new Uint8Array(n);
        for (let k = 0; k < n; k++) mask[k] = got[4 * k + 3] ? 255 : 0;
        const want = J.poissonBlend(dst, src, mask, w, hh);
        let differ = 0, full = 0;
        for (let k = 0; k < n; k++) if (got[4 * k + 3] === 255) { full++; for (let c = 0; c < 3; c++) if (got[4 * k + c] !== want[4 * k + c]) differ++; }
        out.offsetLayer = { box: h.box, full, differ };
        if (full < 10000 || differ) throw new Error("the heal on a layer at (37, -21) is not the blend over its box: " + JSON.stringify(out.offsetLayer));
    }
    await ed.undoStep();
    ed.activeLayerId = L.id; ed.renderLayers();
    // 6. quick mask on: the healing brush refuses (it works on pixels)
    ed.quickMask = true;
    const nq = ed.undoList().length;
    try { stroke(A0, B0); } finally { ed.quickMask = false; }
    out.quickMask = { status: ed.status, steps: ed.undoList().length - nq, empty: empty(h1.box) };
    if (out.quickMask.steps || !out.quickMask.empty || !/Quick mask/.test(out.quickMask.status)) throw new Error("heal worked with quick mask on: " + JSON.stringify(out.quickMask));
} finally {
    IE.healSyncMax = keep.sync; IE.kernels = keep.kernels; IE.healBlend = keep.blend;
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("remove_fills_the_hole_from_the_model_at_the_release", """
// PLAN_0_1_31 section 5 step 3: Remove. The stroke only marks the hole (its colour never lands); at the release the crop
// around it goes to the in-app LaMa model at 512 x 512 and the answer is sampled back into the hole as one undo step. The
// model is a stand-in (`host.helperCall` answers "inpaint" with its input, the model mask painted one flat colour), so the
// fill is known to the byte. The real handlers through synthetic pointer events: on the base (a new layer), the gesture
// held while the model runs (a press and a shortcut wait, Ctrl+Z waits and takes it back), the selection, a failure, no
// model, quick mask, a layer off the origin that reaches out of the picture, and Sample "layer" against "image"
const R = await import("./editor/inpaint_remove.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const W = 1200, H = 800, N = R.REMOVE_SIZE, RAD = 75;
const FILL = [10, 200, 30];
const out = { tiles: !!ed.tileMode };
const keep = { helperCall: host.helperCall, removeModel: host.removeModel, stabiliser: ed.stabiliser };
const fake = () => ({ id: "fake", label: "fake" });
// the model stand-in: every request recorded, an optional delay and failure per check
const calls = [];
let delay = 0, fail = null;
host.removeModel = fake;
host.helperCall = async (name, a) => {
    if (name === "warmInpaint") { calls.push({ name, model: a.model }); return { ready: true, seconds: 0, provider: "fake" }; }
    if (name !== "inpaint") throw new Error("unknown helper " + name);
    calls.push({ name, model: a.model, image: new Uint8Array(a.image), mask: new Uint8Array(a.mask) });
    if (delay) await wait(delay);
    if (fail) throw fail;
    const image = new Uint8Array(a.image);
    for (let i = 0; i < N * N; i++) if (a.mask[i]) { image[4 * i] = FILL[0]; image[4 * i + 1] = FILL[1]; image[4 * i + 2] = FILL[2]; image[4 * i + 3] = 255; }
    return { image, size: N, seconds: 0.01, provider: "fake" };
};
const reqs = () => calls.filter((c) => c.name === "inpaint");
const lastReq = () => reqs()[reqs().length - 1];
try {
    await run("new_canvas", { width: W, height: H, doc: d.id });
    // the picture: a smooth gradient with a flat red disc in the middle
    const base = document.createElement("canvas"); base.width = W; base.height = H;
    {
        const img = new ImageData(W, H), a = img.data;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 4;
            if ((x - 600) * (x - 600) + (y - 400) * (y - 400) < 90 * 90) { a[o] = 220; a[o + 1] = 30; a[o + 2] = 30; }
            else { a[o] = 40 + 0.15 * x; a[o + 1] = 80 + 0.1 * y; a[o + 2] = 150 - 0.05 * x; }
            a[o + 3] = 255;
        }
        base.getContext("2d").putImageData(img, 0, 0);
    }
    Object.defineProperty(base, "naturalWidth", { value: W }); Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "remove_test.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    ed.activeLayerId = null; ed.renderLayers();
    await ed.mipsSettled();
    ed.view.angle = 0; ed.view.scale = 0.5; ed._fitted = false; ed.view.x = 10; ed.view.y = 10; ed.draw();
    let pid = 1900;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy, extra = {}) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: "mouse", pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy), extra));
    const send = (type, ix, iy, extra) => ed.canvas.dispatchEvent(ev(type, ix, iy, extra));
    const stroke = (a, b) => {
        pid++;
        send("pointerdown", a[0], a[1]);
        for (let i = 1; i <= 8; i++) send("pointermove", a[0] + (b[0] - a[0]) * i / 8, a[1] + (b[1] - a[1]) * i / 8);
        send("pointerup", b[0], b[1]);
    };
    const key = (k, o = {}) => ed.root.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, o)));
    // geometry: the distance of a pixel centre to the stroke's segment (a hard round brush paints the capsule around it)
    const segDist = (x, y, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0; return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); };
    const inPic = (X, Y) => X >= 0 && X < W && Y >= 0 && Y < H;
    // a layer's pixels against the stroke a -> b: `keepFn` says where a fill may land (the picture, the selection). core:
    // 3 px inside the capsule where a fill may land, all (FILL, 255); far: 3 px outside it, all clear; leak: anything
    // where no fill may land; marked: red above green at any alpha (the mark is (255, 60, 120), the fill green)
    const look = (layer, a, b, keepFn = inPic) => {
        const px = layer.px.readRect(0, 0, layer.w, layer.h).data;
        const r = { covered: 0, full: 0, differ: 0, core: 0, coreBad: 0, far: 0, leak: 0, marked: 0 };
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let ly = 0; ly < layer.h; ly++) for (let lx = 0; lx < layer.w; lx++) {
            const o = (ly * layer.w + lx) * 4, A = px[o + 3], X = lx + layer.x, Y = ly + layer.y;
            const dist = segDist(X + 0.5, Y + 0.5, a, b), ok = keepFn(X, Y);
            const exact = px[o] === FILL[0] && px[o + 1] === FILL[1] && px[o + 2] === FILL[2];
            if (A) {
                r.covered++;
                x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y);
                if (px[o] > px[o + 1]) r.marked++;
                if (!ok) r.leak++;
                if (dist >= RAD + 3) r.far++;
                if (A === 255) { r.full++; if (!exact) r.differ++; }
            }
            if (dist <= RAD - 3 && ok) { r.core++; if (A !== 255 || !exact) r.coreBad++; }
        }
        r.bounds = r.covered ? [x0, y0, x1, y1] : null;
        return r;
    };
    const digest = (layer) => { const a = layer.px.readRect(0, 0, layer.w, layer.h).data; let h = 2166136261, n = 0; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619); for (let i = 3; i < a.length; i += 4) if (a[i]) n++; return (h >>> 0).toString(16) + "/" + n; };
    // model <-> image: the model pixel whose centre lies nearest an image pixel's centre, and the image pixel under a
    // model pixel's centre
    const toModel = (crop, X, Y) => [Math.round((X - crop[0] + 0.5) * N / (crop[2] - crop[0]) - 0.5), Math.round((Y - crop[1] + 0.5) * N / (crop[3] - crop[1]) - 0.5)];
    const toImg = (crop, mx, my) => [Math.floor(crop[0] + (mx + 0.5) * (crop[2] - crop[0]) / N), Math.floor(crop[1] + (my + 0.5) * (crop[3] - crop[1]) / N)];
    const reqPx = (q, m) => Array.from(q.image.slice(4 * (m[1] * N + m[0]), 4 * (m[1] * N + m[0]) + 3));
    const reqMask = (q, m) => q.mask[m[1] * N + m[0]];
    const basePx = (p) => Array.from(ed.basePx.readRect(p[0], p[1], 1, 1).data.slice(0, 3));
    const diff = (p, q) => Math.max(...p.map((v, i) => Math.abs(v - q[i])));
    const cropOf = (box) => R.removeCrop([Math.max(0, box[0]), Math.max(0, box[1]), Math.min(W, box[0] + box[2]), Math.min(H, box[1] + box[3])], W, H);
    const settle = async () => { await ed.removePending; for (let i = 0; i < 20 && ed._historyQueue; i++) await ed._historyQueue; };

    ed.brushSize = 150; ed.hardness = 1; ed.brushOpacity = 0.4; ed.brushTipId = null; ed.stabiliser = 0;
    ed.removeOpts = { sample: "image" };
    ed.setTool("remove");
    await wait(50);
    out.warm = calls.filter((c) => c.name === "warmInpaint").length;
    if (out.warm !== 1 || ed.tool !== "remove") throw new Error("picking Remove did not warm the model once: " + JSON.stringify({ warm: out.warm, tool: ed.tool, status: ed.status }));

    // 1. on the base: a new paint layer takes the fill (at opacity 1, not the brush's 0.4), the crop and the request as stated
    const A1 = [540, 400], B1 = [660, 400];
    const nL = ed.layers.length, u1 = ed.undo.length, q1 = reqs().length;
    stroke(A1, B1);
    const heldAtRelease = !!(ed.pointer && ed.pointer.healing && ed.pointer.remove);
    await settle();
    const L1 = ed.activeLayer(), lr1 = ed.lastRemove, req1 = lastReq();
    if (!L1 || !lr1 || !lr1.wrote) throw new Error("the Remove on the base wrote nothing: " + ed.status + " " + JSON.stringify(lr1));
    const s1 = look(L1, A1, B1);
    const c1 = toModel(lr1.crop, 600, 400), far1 = [10, 10];
    out.base = { box: lr1.box, crop: lr1.crop, holes: lr1.holes, provider: lr1.provider, held: heldAtRelease, layers: ed.layers.length - nL, kind: L1.kind, active: ed.activeLayerId === L1.id,
        steps: ed.undo.length - u1, label: (ed.undo[ed.undo.length - 1] || {}).label, requests: reqs().length - q1, model: req1.model, image: req1.image.length, mask: req1.mask.length,
        maskCentre: reqMask(req1, c1), maskFar: reqMask(req1, far1), centre: reqPx(req1, c1), farDiff: diff(reqPx(req1, far1), basePx(toImg(lr1.crop, ...far1))),
        bounds: s1.bounds, covered: s1.covered, full: s1.full, differ: s1.differ, core: s1.core, coreBad: s1.coreBad, far: s1.far, leak: s1.leak, marked: s1.marked };
    const b1 = out.base;
    if (b1.layers !== 1 || b1.kind !== "paint" || !b1.active) throw new Error("Remove on the base did not paint into a new active paint layer: " + JSON.stringify(b1));
    if (b1.steps !== 1 || b1.label !== "Remove" || b1.requests !== 1 || b1.model !== "fake" || b1.provider !== "fake" || !b1.held) throw new Error("the Remove on the base is not one request and one undo step: " + JSON.stringify(b1));
    if (JSON.stringify(lr1.crop) !== JSON.stringify(cropOf(lr1.box))) throw new Error("the crop is not removeCrop of the hole's box: " + JSON.stringify({ crop: lr1.crop, want: cropOf(lr1.box), box: lr1.box }));
    // the box is the hole's own extent (what the fill covers), not the stroke buffer's drawing rectangles (1.5 radii wider)
    if (!s1.bounds || JSON.stringify(lr1.box) !== JSON.stringify([s1.bounds[0], s1.bounds[1], s1.bounds[2] - s1.bounds[0] + 1, s1.bounds[3] - s1.bounds[1] + 1])) throw new Error("the crop is not placed around the hole itself: " + JSON.stringify({ box: lr1.box, bounds: s1.bounds }));
    if (b1.image !== N * N * 4 || b1.mask !== N * N || b1.maskCentre !== 255 || b1.maskFar !== 0) throw new Error("the model's input is not the 512 picture and hole: " + JSON.stringify(b1));
    if (diff(b1.centre, [220, 30, 30]) > 3 || b1.farDiff > 3) throw new Error("the model's picture is not the picture under the crop (the mark sent?): " + JSON.stringify(b1));
    if (b1.core < 25000 || b1.coreBad || b1.differ || b1.far || b1.leak || b1.marked || b1.covered !== b1.holes) throw new Error("the fill did not land as the model's colour over the stroke: " + JSON.stringify(b1));
    await ed.undoStep();
    const empty1 = digest(L1);
    if (!/[/]0$/.test(empty1)) throw new Error("the undo of the Remove left pixels: " + empty1);

    // 2. the gesture is held while the model runs: a press and a shortcut wait, the fill lands as one step, undo takes it back
    delay = 400;
    const u2 = ed.undo.length, q2 = reqs().length;
    stroke(A1, B1);
    const p2 = ed.pointer;
    const held2 = !!(p2 && p2.healing && p2.remove), gh2 = ed.gestureHeld(), pend2 = !!ed.removePending;
    pid++; send("pointerdown", 900, 650); send("pointermove", 950, 650); send("pointerup", 950, 650);
    const pressWaited = ed.pointer === p2, pressStatus = ed.status;
    key("b");
    const keyWaited = ed.tool === "remove" && /Removing: a moment/.test(ed.status);
    await settle();
    const s2 = look(L1, A1, B1);
    out.held = { held: held2, gestureHeld: gh2, pending: pend2, pressWaited, pressStatus, keyWaited, requests: reqs().length - q2, steps: ed.undo.length - u2, full: s2.full, coreBad: s2.coreBad, marked: s2.marked, after: ed.pointer === null, ms: ed.lastRemove.ms };
    if (!held2 || !gh2 || !pend2 || !pressWaited || !/Removing: a moment/.test(pressStatus) || !keyWaited) throw new Error("the Remove did not hold the gesture: " + JSON.stringify(out.held));
    if (out.held.requests !== 1 || out.held.steps !== 1 || !out.held.after || s2.full < 25000 || s2.coreBad || s2.marked) throw new Error("the held Remove landed otherwise: " + JSON.stringify(out.held));
    await ed.undoStep();
    out.held.undone = digest(L1) === empty1;
    if (!out.held.undone) throw new Error("the undo of the held Remove did not give the layer back: " + JSON.stringify(out.held));

    // 3. Ctrl+Z pressed while the model runs waits for the fill and takes it back; the redo list holds it
    const u3 = ed.undo.length;
    stroke(A1, B1);
    key("z", { ctrlKey: true });
    await settle();
    out.undoWhileHeld = { same: digest(L1) === empty1, steps: ed.undo.length - u3, wrote: ed.lastRemove.wrote, future: ed.undoList().filter((r) => r.future).map((r) => r.label) };
    if (!out.undoWhileHeld.same || out.undoWhileHeld.steps || !out.undoWhileHeld.wrote || out.undoWhileHeld.future.join() !== "Remove") throw new Error("Ctrl+Z pressed while the model ran did not take the Remove back: " + JSON.stringify(out.undoWhileHeld));
    delay = 0;

    // 4. the selection cuts the hole: nothing lands outside it (not even the mark), inside is the fill
    await run("select_rect", { x: 400, y: 300, w: 200, h: 200, doc: d.id });
    const inSel = (X, Y) => X >= 400 && X < 600 && Y >= 300 && Y < 500;
    const u4 = ed.undo.length;
    stroke(A1, B1);
    await settle();
    const s4 = look(L1, A1, B1, inSel), lr4 = ed.lastRemove, req4 = lastReq();
    out.selection = { wrote: lr4.wrote, steps: ed.undo.length - u4, holes: lr4.holes, covered: s4.covered, core: s4.core, coreBad: s4.coreBad, differ: s4.differ, leak: s4.leak, marked: s4.marked,
        maskIn: reqMask(req4, toModel(lr4.crop, 560, 400)), maskOut: reqMask(req4, toModel(lr4.crop, 650, 400)) };
    if (!lr4.wrote || out.selection.steps !== 1 || s4.core < 10000 || s4.coreBad || s4.differ || s4.leak || s4.marked || out.selection.maskIn !== 255 || out.selection.maskOut !== 0) throw new Error("the selection did not cut the Remove: " + JSON.stringify(out.selection));
    await ed.undoStep();
    await run("select_none", { doc: d.id });

    // 5. the model fails: nothing lands, no undo step, the status says so
    const u5 = ed.undo.length;
    fail = new Error("boom");
    try { stroke(A1, B1); await settle(); } finally { fail = null; }
    const s5 = look(L1, A1, B1);
    out.failure = { steps: ed.undo.length - u5, same: digest(L1) === empty1, status: ed.status, wrote: ed.lastRemove.wrote, error: ed.lastRemove.error, marked: s5.marked, after: ed.pointer === null };
    if (out.failure.steps || !out.failure.same || !/^Remove failed/.test(out.failure.status) || out.failure.wrote !== false || out.failure.error !== "boom" || s5.marked || !out.failure.after) throw new Error("a failed Remove left something: " + JSON.stringify(out.failure));

    // 6. no model: the press refuses (no gesture, no layer, no request)
    host.removeModel = () => null;
    ed.activeLayerId = null; ed.renderLayers();
    const nl6 = ed.layers.length, q6 = reqs().length, u6 = ed.undo.length;
    try { stroke(A1, B1); } finally { host.removeModel = fake; }
    out.noModel = { status: ed.status, pointer: ed.pointer === null, layers: ed.layers.length - nl6, requests: reqs().length - q6, steps: ed.undo.length - u6 };
    if (!/LaMa model/.test(out.noModel.status) || !out.noModel.pointer || out.noModel.layers || out.noModel.requests || out.noModel.steps) throw new Error("Remove without a model did not refuse: " + JSON.stringify(out.noModel));
    ed.activeLayerId = L1.id; ed.renderLayers();

    // 7. quick mask on: Remove refuses (it works on pixels)
    const u7 = ed.undo.length, q7 = reqs().length;
    ed.quickMask = true;
    try { stroke(A1, B1); } finally { ed.quickMask = false; }
    out.quickMask = { status: ed.status, steps: ed.undo.length - u7, requests: reqs().length - q7, same: digest(L1) === empty1, pointer: ed.pointer === null };
    if (!/Quick mask/.test(out.quickMask.status) || out.quickMask.steps || out.quickMask.requests || !out.quickMask.same || !out.quickMask.pointer) throw new Error("Remove worked with quick mask on: " + JSON.stringify(out.quickMask));

    // 8. a paint layer at (37, -21), larger than the picture: the fill lands at the image position (layer pixel = image
    // pixel - (37, -21)), and the stroke's part outside the picture stays clear
    const M = ed.addLayer({ name: "off", kind: "paint", px: ed.pixels.Layer.empty(1400, 900), x: 37, y: -21, w: 1400, h: 900 });
    ed.activeLayerId = M.id; ed.renderLayers();
    const A8 = [1120, 60], B8 = [1170, 60];
    const u8 = ed.undo.length;
    stroke(A8, B8);
    await settle();
    const s8 = look(M, A8, B8), lr8 = ed.lastRemove, req8 = lastReq();
    const at8 = Array.from(M.px.readRect(1145 - 37, 60 + 21, 1, 1).data);
    out.offsetLayer = { box: lr8.box, crop: lr8.crop, wrote: lr8.wrote, steps: ed.undo.length - u8, bounds: s8.bounds, at: at8, core: s8.core, coreBad: s8.coreBad, differ: s8.differ, far: s8.far, leak: s8.leak, marked: s8.marked,
        maskAt: reqMask(req8, toModel(lr8.crop, 1145, 60)) };
    const o8 = out.offsetLayer;
    if (!o8.wrote || o8.steps !== 1 || JSON.stringify(lr8.crop) !== JSON.stringify(cropOf(lr8.box)) || o8.maskAt !== 255) throw new Error("the Remove on a layer at (37, -21) did not run as stated: " + JSON.stringify(o8));
    // the stroke reaches out of the picture (its capsule), the hole is cut to it (the box is the hole's extent)
    if (!(A8[1] - RAD < 0 && B8[0] + RAD > W)) throw new Error("the stroke did not reach out of the picture (the check would prove nothing): " + JSON.stringify(o8));
    if (lr8.box[1] !== 0 || lr8.box[0] + lr8.box[2] !== W) throw new Error("the hole was not cut to the picture: " + JSON.stringify(o8));
    if (at8.join() !== FILL.concat(255).join() || o8.core < 12000 || o8.coreBad || o8.differ || o8.far || o8.leak || o8.marked) throw new Error("the fill on a layer at (37, -21) is not at the image position: " + JSON.stringify(o8));
    if (!o8.bounds || Math.abs(o8.bounds[0] - (A8[0] - RAD)) > 2 || o8.bounds[1] !== 0 || o8.bounds[2] !== W - 1 || Math.abs(o8.bounds[3] - (A8[1] + RAD)) > 2) throw new Error("the fill on a layer at (37, -21) is not where the stroke was, cut to the picture: " + JSON.stringify(o8));
    await ed.undoStep();

    // 9. Sample "layer" sends the active layer alone (clear is black to the model), "image" the visible picture
    const G = ed.addPaintLayer();
    G.px.drawInto(null, (x) => { x.fillStyle = "#00c800"; x.fillRect(450, 250, 300, 300); });
    ed.markLayerChanged(G);
    ed.activeLayerId = G.id; ed.renderLayers();
    await ed.mipsSettled();
    const A9 = [580, 400], B9 = [620, 400];
    const sampleAt = async (mode) => {
        ed.removeOpts.sample = mode;
        stroke(A9, B9);
        await settle();
        const lr = ed.lastRemove, q = lastReq(), bare = toModel(lr.crop, 360, 160);
        const r = { wrote: lr.wrote, square: reqPx(q, toModel(lr.crop, 470, 270)), bare: reqPx(q, bare), base: basePx(toImg(lr.crop, ...bare)) };
        if (lr.wrote) await ed.undoStep();
        return r;
    };
    const sl = await sampleAt("layer"), si = await sampleAt("image");
    ed.removeOpts.sample = "image";
    out.sample = { layer: { square: sl.square, bare: sl.bare }, image: { square: si.square, bare: si.bare, base: si.base } };
    // the layer's clear pixels lie over the mean of its opaque ones (here the green square), neither black nor the base
    if (!sl.wrote || !si.wrote || diff(sl.square, [0, 200, 0]) > 3 || diff(sl.bare, [0, 200, 0]) > 3) throw new Error("Sample layer did not send the layer alone over its mean colour: " + JSON.stringify(out.sample));
    if (diff(si.square, [0, 200, 0]) > 3 || diff(si.bare, si.base) > 3 || diff(si.base, [0, 0, 0]) < 50) throw new Error("Sample image did not send the visible picture: " + JSON.stringify(out.sample));
    // Sample "layer" on a layer with nothing opaque around the stroke refuses (nothing to fill from)
    const E = ed.addPaintLayer();
    ed.activeLayerId = E.id; ed.renderLayers();
    ed.removeOpts.sample = "layer";
    const q9 = reqs().length, u9 = ed.undo.length;
    stroke(A9, B9); await settle();
    out.emptyLayer = { requests: reqs().length - q9, steps: ed.undo.length - u9, status: ed.status };
    ed.removeOpts.sample = "image";
    if (out.emptyLayer.requests || out.emptyLayer.steps || !/nothing opaque/.test(out.emptyLayer.status)) throw new Error("Sample layer on an empty layer did not refuse: " + JSON.stringify(out.emptyLayer));

    // 10. a failed Remove on the base takes away the paint layer its press made (it holds nothing, no step made it)
    ed.activeLayerId = null; ed.renderLayers();
    const n10 = ed.layers.length, u10 = ed.undo.length;
    fail = new Error("boom again");
    try { stroke(A1, B1); await settle(); } finally { fail = null; }
    out.baseFailure = { layers: ed.layers.length - n10, active: ed.activeLayerId, steps: ed.undo.length - u10, status: ed.status };
    if (out.baseFailure.layers || out.baseFailure.active !== null || out.baseFailure.steps || !/^Remove failed/.test(out.baseFailure.status)) throw new Error("a failed Remove on the base left its new layer: " + JSON.stringify(out.baseFailure));

    // 11. the layer deleted from the panel while the model runs: nothing lands in it, and undoing the delete brings it
    // back as it was (not with the fill)
    const D = ed.addPaintLayer();
    ed.activeLayerId = D.id; ed.renderLayers();
    const d11 = digest(D);
    delay = 400;
    try {
        stroke(A1, B1);
        await wait(50);
        ed.removeLayer(D.id);
        await settle();
    } finally { delay = 0; }
    const back = () => ed.layers.find((l) => l.id === D.id);
    out.deleted = { wrote: ed.lastRemove.wrote, error: ed.lastRemove.error, gone: !back(), top: (ed.undo[ed.undo.length - 1] || {}).label };
    await ed.undoStep();
    out.deleted.restored = !!back();
    out.deleted.same = back() ? digest(back()) === d11 : null;
    if (out.deleted.wrote !== false || !/deleted/.test(out.deleted.error || "") || !out.deleted.gone || out.deleted.top !== "Delete layer" || !out.deleted.restored || !out.deleted.same) throw new Error("a Remove landed in a layer deleted while it ran: " + JSON.stringify(out.deleted));

    // 12. the document thumbnail (as a save makes it) waits for a Remove still landing: its mark is never in it
    const T = ed.addPaintLayer();
    ed.activeLayerId = T.id; ed.renderLayers();
    delay = 300;
    let pendingWhenDone = "unset";
    try {
        stroke(A1, B1);
        await wait(20);
        const heldThen = !!ed.removePending;
        await host.documentThumbnail(ed);
        pendingWhenDone = ed.removePending;
        out.thumbnail = { heldThen, pendingAfter: pendingWhenDone === null, wrote: ed.lastRemove.wrote };
    } finally { delay = 0; await settle(); }
    if (!out.thumbnail.heldThen || !out.thumbnail.pendingAfter || !out.thumbnail.wrote) throw new Error("the thumbnail did not wait for the Remove: " + JSON.stringify(out.thumbnail));
} finally {
    host.helperCall = keep.helperCall; host.removeModel = keep.removeModel; ed.stabiliser = keep.stabiliser;
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("patch_blends_the_donor_into_the_selection_at_the_release", """
// PLAN_0_1_31 section 5 step 4a: the Patch tool. A press inside the selection drags it (elsewhere the tool draws a lasso);
// at the release the donor (Source: the picture under the dragged outline; Destination: the selection itself) lands in the
// target with the selection's alpha, and the heal's Poisson blend lays it into the picture around the target: one "Patch"
// step, the selection unchanged. The real handlers through synthetic pointer events; the layer against the kernel over the
// box the release took (here, and in a worker with the gesture held; Ctrl+Z while held), Destination, Blend 0 and 50, the
// clamp at the picture's edge, the base (a new layer), a layer off the origin, Esc and a click, the refusals, a feathered
// selection, and no whole-picture read (nor a display mirror on tiles) through the drags and their preview
const J = await import("./editor/px/kernels_js.js");
const P = await import("./editor/inpaint_pixels.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const IE = ed.constructor;
const keep = { sync: IE.healSyncMax };
const W = 1200, H = 800;
const out = { tiles: !!ed.tileMode };
const calls = { compositeCanvas: 0, flattenToCanvas: 0, sampleCanvas: 0 };
const phases = {};
const ants = [];
let counting = false;
try {
    await run("new_canvas", { width: W, height: H, doc: d.id });
    // the picture: a lit gradient with a fine grain; a warm, coarser texture right of the selection (the Source donor)
    const base = document.createElement("canvas"); base.width = W; base.height = H;
    {
        const img = new ImageData(W, H), a = img.data;
        const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return (h >>> 24) / 255; };
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 4, n = hash(x, y) - 0.5;
            if (x >= 700 && x < 1000 && y >= 280 && y < 620) { const t = hash(x >> 2, y >> 2) - 0.5; a[o] = 200 + 40 * t + 10 * n; a[o + 1] = 70 + 40 * t; a[o + 2] = 50 + 30 * t; }
            else { a[o] = 60 + 0.06 * x + 12 * n; a[o + 1] = 90 + 0.05 * y + 12 * n; a[o + 2] = 140 - 0.04 * x + 12 * n; }
            a[o + 3] = 255;
        }
        base.getContext("2d").putImageData(img, 0, 0);
    }
    Object.defineProperty(base, "naturalWidth", { value: W }); Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "patch_test.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    const L = ed.addPaintLayer();
    ed.activeLayerId = L.id; ed.renderLayers();
    await ed.mipsSettled();
    ed.view.angle = 0; ed.view.scale = 0.5; ed._fitted = false; ed.view.x = 10; ed.view.y = 10; ed.draw();
    // the whole-picture reads counted while a pointer event or a draw of the drag runs; the ants' shifts recorded
    for (const k of Object.keys(calls)) { const f = ed[k]; ed[k] = function (...a) { if (counting) calls[k]++; return f.apply(this, a); }; }
    { const f = ed.drawMarchingAnts; ed.drawMarchingAnts = function (ctx, shift) { if (counting) ants.push(shift ? [shift[0], shift[1]] : null); return f.call(this, ctx, shift); }; }
    const mirrors = () => ed.tileMode ? [!!P.displayCanvasIfMade(L.px), !!P.displayCanvasIfMade(ed.basePx)] : null;
    const m0 = mirrors();
    const mark = (name) => { phases[name] = calls.compositeCanvas + calls.flattenToCanvas + calls.sampleCanvas; };
    let pid = 2600;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy, extra = {}) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: "mouse", pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy), extra));
    const send = (type, ix, iy, extra) => { counting = true; try { ed.canvas.dispatchEvent(ev(type, ix, iy, extra)); } finally { counting = false; } };
    const drawNow = () => { counting = true; try { ed.draw(); } finally { counting = false; } };
    const key = (k, o = {}) => ed.root.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, o)));
    // a drag from a to b in six moves, the picture drawn after each (the preview and the ants, as the screen would); what the
    // press made, the offset the drag took and the last shifted outline, read before the release
    const drag = (a, b, moves = 6) => {
        pid++;
        send("pointerdown", a[0], a[1]);
        const kind = ed.pointer ? ed.pointer.kind : null;
        ants.length = 0;
        for (let i = 1; i <= moves; i++) { send("pointermove", a[0] + (b[0] - a[0]) * i / moves, a[1] + (b[1] - a[1]) * i / moves); drawNow(); }
        const p = ed.pointer, dd = p && p.kind === "patchdrag" ? p.d.slice() : null;
        const shifted = ants.filter((s) => s).map((s) => s.join()).pop() || null;
        send("pointerup", b[0], b[1]);
        return { kind, d: dd, ants: shifted };
    };
    const hashOf = (a) => { let h = 2166136261, n = 0; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619); for (let i = 3; i < a.length; i += 4) if (a[i]) n++; return (h >>> 0).toString(16) + "/" + n; };
    const digest = (layer) => hashOf(layer.px.readRect(0, 0, layer.w, layer.h).data);
    const selDigest = () => hashOf(ed.sel.readRect(0, 0, W, H).data);
    const baseDigest = () => hashOf(ed.basePx.readRect(0, 0, W, H).data);
    const top = () => (ed.undo[ed.undo.length - 1] || {}).label;
    // the bytes of `px` (pw x ph) over [x, y, w, h] of its own pixels, zeros outside it (the brush source reads so)
    const readZ = (px, pw, ph, x, y, w, h) => {
        const o = new Uint8Array(w * h * 4);
        const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(pw, x + w), y1 = Math.min(ph, y + h), rw = x1 - x0;
        if (rw <= 0 || y1 <= y0) return o;
        const a = px.readRect(x0, y0, rw, y1 - y0).data;
        for (let yy = y0; yy < y1; yy++) o.set(a.subarray((yy - y0) * rw * 4, (yy - y0 + 1) * rw * 4), ((yy - y) * w + x0 - x) * 4);
        return o;
    };
    // the same, but past the pixels' edge the nearest pixel inside (the patch's guide: `patchGuide` replicates the edge)
    const readE = (px, pw, ph, x, y, w, h) => {
        const o = new Uint8Array(w * h * 4);
        const x0 = Math.max(0, Math.min(pw - 1, x)), y0 = Math.max(0, Math.min(ph - 1, y)), x1 = Math.min(pw, Math.max(x0 + 1, x + w)), y1 = Math.min(ph, Math.max(y0 + 1, y + h)), rw = x1 - x0;
        const a = px.readRect(x0, y0, rw, y1 - y0).data;
        for (let yy = 0; yy < h; yy++) {
            const sy = Math.min(y1 - 1, Math.max(y0, y + yy)) - y0;
            for (let xx = 0; xx < w; xx++) {
                const sx = Math.min(x1 - 1, Math.max(x0, x + xx)) - x0, s = (sy * rw + sx) * 4, d = (yy * w + xx) * 4;
                o[d] = a[s]; o[d + 1] = a[s + 1]; o[d + 2] = a[s + 2]; o[d + 3] = a[s + 3];
            }
        }
        return o;
    };
    // the landed patch over `h.box` (image px) against the kernel: mask = the selection (read `sd` from the box: the
    // Destination's target is the selection moved by d) where it has any alpha, dst = the picture over the box, src = the
    // picture at the box + h.off (the donor; past the picture's edge its nearest pixel, as the patch reads it). `mix` (Blend below 100 %): round(src + mix * (blend - src)). RGB compared
    // where the selection and the landed alpha are 255; the landed alpha within 1 of the selection's where the mask is set,
    // clear elsewhere in the box
    const check = (layer, h, sd = [0, 0], mix = null) => {
        const [x, y, w, hh] = h.box, n = w * hh;
        const got = readZ(layer.px, layer.w, layer.h, x - layer.x, y - layer.y, w, hh);
        const sa = readZ(ed.sel, W, H, x + sd[0], y + sd[1], w, hh);
        const dst = readZ(ed.basePx, W, H, x, y, w, hh), src = readE(ed.basePx, W, H, x + h.off[0], y + h.off[1], w, hh);
        const mask = new Uint8Array(n);
        for (let k = 0; k < n; k++) mask[k] = sa[4 * k + 3] ? 255 : 0;
        const want = J.poissonBlend(dst, src, mask, w, hh);
        if (mix != null) for (let k = 0; k < n; k++) if (mask[k]) for (let c = 4 * k; c < 4 * k + 3; c++) want[c] = Math.round(src[c] + mix * (want[c] - src[c]));
        const r = { box: h.box, off: h.off, where: h.where, info: h.info, unknowns: h.unknowns, masked: 0, soft: 0, full: 0, differ: 0, alpha: 0, outside: 0 };
        for (let k = 0; k < n; k++) {
            const A = got[4 * k + 3], S = sa[4 * k + 3];
            if (!mask[k]) { if (A) r.outside++; continue; }
            r.masked++;
            if (S < 255) r.soft++;
            if (Math.abs(A - S) > 1) r.alpha++;
            if (S === 255 && A === 255) { r.full++; for (let c = 0; c < 3; c++) if (got[4 * k + c] !== want[4 * k + c]) r.differ++; }
        }
        Object.defineProperty(r, "bytes", { value: { got, dst, src, w, h: hh }, enumerable: false });
        return r;
    };
    const exact = (r, minFull) => r.full >= minFull && !r.differ && !r.alpha && !r.outside;
    // for a failure's report: the blend's own mask (`healInputs`, its stroke buffer's alpha; on the canvas backend where
    // the buffer's canvas lies) and the selection the press read (`patchExtent`), against the selection `check` reads.
    // Found 2026-09-28: on the canvas backend the blend's mask had 100 to 480 unknowns more than the selection, all one
    // pixel outside the buffer's canvas: `healInputs` reads the box 1 px past the canvas, and Chromium's first
    // getImageData of a GPU canvas does not zero what lies outside it (a second read does, as does a willReadFrequently
    // canvas); reported to the main loop, the check stays
    let lastJob = null, lastExt = null;
    ed.healInputs = function (p) {
        const s = p.stroke, j = IE.prototype.healInputs.call(this, p);
        lastJob = j ? { x: j.x, y: j.y, w: j.w, h: j.h, mask: j.mask.slice(), alpha: j.stroke.data.filter((_, i) => i % 4 === 3), buffer: s && !s.px && s.canvas ? { canvas: [s.canvas.width, s.canvas.height], at: [s.cx, s.cy] } : null } : null;
        return j;
    };
    ed.patchExtent = function () { const g = IE.prototype.patchExtent.call(this); lastExt = g ? { E: g.E.slice(), set: g.selA.reduce((n, v) => n + (v ? 1 : 0), 0) } : null; return g; };
    const diag = (r, sd = [0, 0]) => {
        if (!lastJob) return { job: null };
        const [x, y, w, hh] = r.box, sa = readZ(ed.sel, W, H, x + sd[0], y + sd[1], w, hh);
        const o = { job: [lastJob.x, lastJob.y, lastJob.w, lastJob.h], buffer: lastJob.buffer || null, press: lastExt, extra: 0, missing: 0, bbox: null, alphas: {}, sel: {}, samples: [] };
        if (lastJob.w !== w || lastJob.h !== hh) return o;
        let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
        for (let k = 0; k < w * hh; k++) {
            const m = lastJob.mask[k] > 0, s = sa[4 * k + 3];
            if (m && !s) {
                o.extra++;
                const X = x + (k % w), Y = y + ((k / w) | 0), a = lastJob.alpha[k];
                bx0 = Math.min(bx0, X); by0 = Math.min(by0, Y); bx1 = Math.max(bx1, X); by1 = Math.max(by1, Y);
                o.alphas[a] = (o.alphas[a] || 0) + 1;
                if (o.samples.length < 6) o.samples.push([X, Y, a]);
            } else if (!m && s) { o.missing++; o.sel[s] = (o.sel[s] || 0) + 1; }
        }
        if (o.extra) o.bbox = [bx0, by0, bx1 + 1, by1 + 1];
        return o;
    };
    // the heal step's seam test: within 3 px of the patch's edge the result is near the picture while the donor is far from
    // it; inside, result minus donor is harmonic (its Laplacian within two roundings)
    const seam = (r) => {
        const { got, dst, src, w, h } = r.bytes, A = (k) => got[4 * k + 3];
        let n = 0, dHeal = 0, dSrc = 0, lap = 0, inside = 0;
        for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
            const k = y * w + x;
            if (A(k) !== 255) continue;
            if (A(k - 3) < 255 || A(k + 3) < 255 || A(k - 3 * w) < 255 || A(k + 3 * w) < 255) {
                for (let c = 0; c < 3; c++) { dHeal += Math.abs(got[4 * k + c] - dst[4 * k + c]); dSrc += Math.abs(src[4 * k + c] - dst[4 * k + c]); }
                n++;
            } else {
                for (let c = 0; c < 3; c++) { const u = (q) => got[4 * q + c] - src[4 * q + c]; lap = Math.max(lap, Math.abs(4 * u(k) - u(k - 1) - u(k + 1) - u(k - w) - u(k + w))); }
                inside++;
            }
        }
        return { edge: n, heal: +(dHeal / (3 * n)).toFixed(2), source: +(dSrc / (3 * n)).toFixed(2), lap, inside };
    };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // 1. nothing selected: a press of the patch tool draws a lasso (an octagon of radius 80 around C), one step
    ed.setTool("patch");
    ed.patchOpts = { mode: "source", blend: 100 };
    const C = [500, 400], oct = [];
    for (let i = 0; i < 8; i++) oct.push([C[0] + 80 * Math.cos((i + 0.5) * Math.PI / 4), C[1] + 80 * Math.sin((i + 0.5) * Math.PI / 4)]);
    const u0 = ed.undo.length;
    pid++;
    send("pointerdown", oct[0][0], oct[0][1]);
    const lassoKind = ed.pointer ? ed.pointer.kind : null;
    for (let i = 1; i <= 8; i++) send("pointermove", oct[i % 8][0], oct[i % 8][1]);
    send("pointerup", oct[0][0], oct[0][1]);
    out.lasso = { tool: ed.tool, kind: lassoKind, steps: ed.undo.length - u0, label: top() };
    if (out.lasso.tool !== "patch" || lassoKind !== "lasso" || out.lasso.steps !== 1 || out.lasso.label !== "Lasso selection") throw new Error("the patch tool did not draw a lasso where nothing was selected: " + JSON.stringify(out.lasso));
    // E: the extent of every selected pixel, read here
    const selAll = ed.sel.readRect(0, 0, W, H).data.slice();
    const sel0 = hashOf(selAll);
    let ex0 = W, ey0 = H, ex1 = -1, ey1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (selAll[(y * W + x) * 4 + 3]) { if (x < ex0) ex0 = x; if (x > ex1) ex1 = x; if (y < ey0) ey0 = y; ey1 = y; }
    const E = [ex0, ey0, ex1 + 1, ey1 + 1];
    out.lasso.E = E;
    if (!(E[0] > 410 && E[0] < 430 && E[2] > 570 && E[2] < 590)) throw new Error("the lasso selected " + JSON.stringify(E));
    const e0 = digest(L);
    mark("lasso");

    // 1b. Source, dragged by (300, 40) onto the warm texture, on a paint layer: blended at the release, here
    const n1 = ed.undo.length;
    const g1 = drag(C, [C[0] + 300, C[1] + 40]);
    const h1 = ed.lastHeal;
    if (g1.kind !== "patchdrag" || !h1) throw new Error("the drag inside the selection did not patch: " + JSON.stringify({ g1, h1, status: ed.status }));
    const r1 = check(L, h1), s1 = seam(r1);
    out.source = Object.assign({ d: g1.d, ants: g1.ants, steps: ed.undo.length - n1, label: top(), sel: selDigest() === sel0, seam: s1, ms: h1.ms }, r1);
    const o1 = out.source;
    if (!same(g1.d, [300, 40]) || !same(h1.off, [300, 40]) || h1.where !== "here" || o1.steps !== 1 || o1.label !== "Patch" || !o1.sel) throw new Error("the Source patch did not run as stated: " + JSON.stringify(o1));
    if (ed.selectionDisplay !== "tint" && o1.ants !== "300,40") throw new Error("no second outline followed the drag: " + JSON.stringify(o1));
    if (!exact(r1, 10000) || h1.unknowns !== r1.masked) throw new Error("the layer is not the kernel's blend of the donor over the box: " + JSON.stringify(o1) + " diag " + JSON.stringify(diag(r1)));
    if (!(s1.edge > 500 && s1.heal * 4 < s1.source && s1.lap <= 4 && s1.inside > 5000)) throw new Error("the patch does not meet the picture at its edge: " + JSON.stringify(o1));
    const bytes1 = r1.bytes.got.slice();
    await ed.undoStep();
    if (digest(L) !== e0) throw new Error("the undo of the patch did not give the empty layer back");
    mark("source");

    // 2. in a worker (every patch, here): the gesture held, a press meanwhile waits; the same bytes; Ctrl+Z while held
    IE.healSyncMax = 0;
    const n2 = ed.undo.length;
    drag(C, [C[0] + 300, C[1] + 40]);
    const p2 = ed.pointer;
    const held = !!(p2 && p2.healing && p2.patch && ed.healPending), gh = ed.gestureHeld();
    pid++; send("pointerdown", 900, 700); send("pointermove", 950, 700); send("pointerup", 950, 700);
    const pressWaited = ed.pointer === p2, pressStatus = ed.status;
    await ed.healPending;
    const h2 = ed.lastHeal, r2 = check(L, h2);
    let vsSync = 0;
    for (let k = 0; k < bytes1.length; k += 4) {
        if (bytes1[k + 3] !== r2.bytes.got[k + 3]) vsSync++;
        else if (bytes1[k + 3] === 255) for (let c = 0; c < 3; c++) if (bytes1[k + c] !== r2.bytes.got[k + c]) vsSync++;
    }
    out.worker = Object.assign({ held, gestureHeld: gh, pressWaited, pressStatus, vsSync, sameBox: same(h2.box, h1.box), steps: ed.undo.length - n2, label: top(), after: ed.pointer === null }, r2);
    const o2 = out.worker;
    if (!held || !gh || !pressWaited || !/Patching: a moment/.test(pressStatus)) throw new Error("the patch in a worker did not hold the gesture: " + JSON.stringify(o2));
    if (h2.where !== "worker" || !o2.sameBox || o2.vsSync || !exact(r2, 10000) || o2.steps !== 1 || o2.label !== "Patch" || !o2.after) throw new Error("the patch in a worker landed otherwise: " + JSON.stringify(o2));
    await ed.undoStep();
    drag(C, [C[0] + 300, C[1] + 40]);
    const heldZ = !!(ed.pointer && ed.pointer.healing && ed.healPending);
    const undone = ed.undoStep();
    await ed.healPending; await undone;
    out.undoWhileHeld = { held: heldZ, empty: digest(L) === e0, steps: ed.undo.length - n2, future: ed.undoList().filter((r) => r.future).map((r) => r.label) };
    IE.healSyncMax = keep.sync;
    if (!heldZ || !out.undoWhileHeld.empty || out.undoWhileHeld.steps) throw new Error("an undo pressed while the patch blended did not take it back: " + JSON.stringify(out.undoWhileHeld));
    mark("worker");

    // 3. Destination by (-300, 0): the selection's piece copied there (the donor is the selection itself, off = -d)
    ed.patchOpts = { mode: "destination", blend: 100 };
    const n3 = ed.undo.length;
    const g3 = drag(C, [C[0] - 300, C[1]]);
    const h3 = ed.lastHeal;
    if (g3.kind !== "patchdrag" || !h3) throw new Error("the Destination drag did not patch: " + JSON.stringify({ g3, status: ed.status }));
    const r3 = check(L, h3, [300, 0]);
    out.destination = Object.assign({ d: g3.d, ants: g3.ants, steps: ed.undo.length - n3, label: top(), sel: selDigest() === sel0 }, r3);
    const o3 = out.destination;
    if (!same(g3.d, [-300, 0]) || !same(h3.off, [300, 0]) || h3.where !== "here" || o3.steps !== 1 || o3.label !== "Patch" || !o3.sel) throw new Error("the Destination patch did not run as stated: " + JSON.stringify(o3));
    if (ed.selectionDisplay !== "tint" && o3.ants !== "-300,0") throw new Error("no second outline followed the Destination drag: " + JSON.stringify(o3));
    if (!exact(r3, 10000) || h3.unknowns !== r3.masked) throw new Error("the Destination patch is not the kernel's blend of the selection's piece: " + JSON.stringify(o3) + " diag " + JSON.stringify(diag(r3, [300, 0])));
    await ed.undoStep();
    if (digest(L) !== e0) throw new Error("the undo of the Destination patch did not give the empty layer back");
    mark("destination");

    // 4. Blend 0: no blend at all, the donor's bytes as they are; Blend 50: halfway between the donor and the blend
    ed.patchOpts = { mode: "source", blend: 0 };
    ed.lastHeal = null;
    const n4 = ed.undo.length;
    const g4 = drag(C, [C[0] + 300, C[1] + 40]);
    const r4 = check(L, { box: [E[0], E[1], E[2] - E[0], E[3] - E[1]], off: [300, 40] }, [0, 0], 0);
    out.blend0 = Object.assign({ d: g4.d, lastHeal: ed.lastHeal, steps: ed.undo.length - n4, label: top() }, r4);
    if (ed.lastHeal !== null || !same(g4.d, [300, 40]) || out.blend0.steps !== 1 || out.blend0.label !== "Patch" || !exact(r4, 10000)) throw new Error("Blend 0 did not land the plain copy: " + JSON.stringify(out.blend0));
    await ed.undoStep();
    ed.patchOpts.blend = 50;
    const n5 = ed.undo.length;
    drag(C, [C[0] + 300, C[1] + 40]);
    const h5 = ed.lastHeal, r5 = check(L, h5, [0, 0], 0.5), r5full = check(L, h5);
    out.blend50 = Object.assign({ steps: ed.undo.length - n5, label: top(), vsFull: r5full.differ }, r5);
    if (!h5 || h5.where !== "here" || !same(h5.off, [300, 40]) || out.blend50.steps !== 1 || out.blend50.label !== "Patch" || !exact(r5, 10000) || r5full.differ < 1000) throw new Error("Blend 50 did not land halfway: " + JSON.stringify(out.blend50));
    await ed.undoStep();
    if (digest(L) !== e0) throw new Error("the undo of the Blend patches did not give the empty layer back");
    ed.patchOpts.blend = 100;
    mark("blend");

    // 5. a drag far past the right edge: the offset stops where the moved selection meets the picture's edge
    const n6 = ed.undo.length;
    const g6 = drag(C, [C[0] + 1500, C[1]]);
    const h6 = ed.lastHeal, r6 = check(L, h6);
    out.clamp = Object.assign({ d: g6.d, want: W - E[2], steps: ed.undo.length - n6 }, r6);
    if (!same(g6.d, [W - E[2], 0]) || !same(h6.off, [W - E[2], 0]) || out.clamp.steps !== 1 || !exact(r6, 10000)) throw new Error("the drag past the edge was not clamped to the picture: " + JSON.stringify(out.clamp));
    await ed.undoStep();
    mark("clamp");

    // 7. on the base: a new paint layer takes the patch and is active, the base stays as it was
    ed.activeLayerId = null; ed.renderLayers();
    const nl7 = ed.layers.length, n7 = ed.undo.length, b7 = baseDigest();
    drag(C, [C[0] + 300, C[1] + 40]);
    const N = ed.activeLayer(), h7 = ed.lastHeal;
    const r7 = N ? check(N, h7) : {};
    out.base = Object.assign({ layers: ed.layers.length - nl7, kind: N && N.kind, active: !!N && ed.activeLayerId === N.id && N !== L, steps: ed.undo.length - n7, label: top(), baseSame: baseDigest() === b7 }, r7);
    const o7 = out.base;
    if (o7.layers !== 1 || o7.kind !== "paint" || !o7.active || o7.steps !== 1 || o7.label !== "Patch" || !o7.baseSame) throw new Error("the patch on the base did not paint into a new active layer as one step: " + JSON.stringify(o7));
    if (!exact(r7, 10000) || !same(h7.off, [300, 40])) throw new Error("the patch on the base is not the kernel's blend: " + JSON.stringify(o7));
    await ed.undoStep();
    o7.undone = { kept: ed.layers.includes(N), empty: ed.layers.includes(N) ? /[/]0$/.test(digest(N)) : null, baseSame: baseDigest() === b7 };
    if ((o7.undone.kept && !o7.undone.empty) || !o7.undone.baseSame) throw new Error("the undo of the patch on the base left pixels: " + JSON.stringify(o7.undone));
    ed.activeLayerId = L.id; ed.renderLayers();
    mark("base");

    // 8. Esc during a drag: the drag ends, nothing lands (not at the later release either); a click inside does nothing
    const n8 = ed.undo.length;
    pid++;
    send("pointerdown", C[0], C[1]);
    send("pointermove", C[0] + 60, C[1] + 20); send("pointermove", C[0] + 120, C[1] + 40);
    const p8 = ed.pointer, kind8 = p8 && p8.kind, moved8 = !!(p8 && p8.moved);
    key("Escape");
    out.escape = { kind: kind8, moved: moved8, pointer: ed.pointer === null, status: ed.status };
    send("pointerup", C[0] + 120, C[1] + 40);
    Object.assign(out.escape, { steps: ed.undo.length - n8, same: digest(L) === e0, sel: selDigest() === sel0, statusAfter: ed.status });
    const o8 = out.escape;
    if (o8.kind !== "patchdrag" || !o8.moved || !o8.pointer || !/Patch cancelled/.test(o8.status) || o8.steps || !o8.same || !o8.sel) throw new Error("Esc did not cancel the patch drag: " + JSON.stringify(o8));
    pid++;
    send("pointerdown", C[0], C[1]);
    const kindC = ed.pointer ? ed.pointer.kind : null;
    send("pointerup", C[0], C[1]);
    out.click = { kind: kindC, pointer: ed.pointer === null, steps: ed.undo.length - n8, same: digest(L) === e0, sel: selDigest() === sel0, status: ed.status };
    if (kindC !== "patchdrag" || !out.click.pointer || out.click.steps || !out.click.same || !out.click.sel || !/Drag the selection/.test(out.click.status)) throw new Error("a click inside the selection did something: " + JSON.stringify(out.click));
    mark("escape");

    // 9. the refusals at the press: the status says why, no gesture, no step, no new layer, nothing written
    const refuse = (what, re) => {
        const n = ed.undo.length, nl = ed.layers.length, e = digest(L);
        pid++;
        send("pointerdown", C[0], C[1]);
        const pointer = ed.pointer ? ed.pointer.kind : null;
        send("pointermove", C[0] + 150, C[1] + 20); send("pointermove", C[0] + 300, C[1] + 40);
        send("pointerup", C[0] + 300, C[1] + 40);
        const r = { tool: ed.tool, status: ed.status, pointer, steps: ed.undo.length - n, layers: ed.layers.length - nl, same: digest(L) === e, sel: selDigest() === sel0 };
        if (r.tool !== "patch" || !re.test(r.status) || r.pointer || r.steps || r.layers || !r.same || !r.sel) throw new Error(what + " did not refuse the patch: " + JSON.stringify(r));
        return r;
    };
    out.refused = {};
    ed.quickMask = true;
    try { out.refused.quickMask = refuse("quick mask", /Quick mask/); } finally { ed.quickMask = false; }
    await run("add_text", { doc: d.id, text: "Ab", x: 20, y: 20, size: 40 });
    const TL = ed.layers.find((l) => l.kind === "text");
    if (!TL) throw new Error("add_text made no text layer");
    ed.setTool("patch");
    ed.activeLayerId = TL.id; ed.renderLayers();
    out.refused.text = refuse("a text layer", /Text layers hold text/);
    ed.removeLayer(TL.id);
    const S = ed.addLayer({ name: "S", kind: "paint", px: ed.pixels.Layer.empty(600, 400), x: 0, y: 0, w: W, h: H });
    ed.activeLayerId = S.id; ed.renderLayers();
    out.refused.scaled = refuse("a scaled layer", /scaled or placed between pixels/);
    ed.removeLayer(S.id);
    const O = ed.addLayer({ name: "O", kind: "paint", px: ed.pixels.Layer.empty(400, 400), x: 37, y: -21, w: 400, h: 400 });
    ed.activeLayerId = O.id; ed.renderLayers();
    out.refused.past = refuse("a layer at (37, -21) short of the selection", /reaches past/);
    ed.removeLayer(O.id);
    // 9b. a layer at (37, -21) that covers it: the patch lands at the image position (layer pixel = image pixel - (37, -21))
    const M = ed.addLayer({ name: "M", kind: "paint", px: ed.pixels.Layer.empty(1400, 900), x: 37, y: -21, w: 1400, h: 900 });
    ed.activeLayerId = M.id; ed.renderLayers();
    const n9 = ed.undo.length;
    drag(C, [C[0] + 300, C[1] + 40]);
    const h9 = ed.lastHeal, r9 = check(M, h9);
    out.offsetLayer = Object.assign({ steps: ed.undo.length - n9, label: top() }, r9);
    if (!same(h9.off, [300, 40]) || out.offsetLayer.steps !== 1 || !exact(r9, 10000)) throw new Error("the patch on a layer at (37, -21) is not the blend at the image position: " + JSON.stringify(out.offsetLayer));
    await ed.undoStep();
    ed.removeLayer(M.id);
    ed.activeLayerId = L.id; ed.renderLayers();
    mark("refusals");

    // 6. a feathered selection: the landed alpha follows the selection's soft edge, the colours are the blend's
    await run("select_rect", { x: 440, y: 330, w: 120, h: 140, doc: d.id });
    await ed.featherSelection(8);
    const selF = selDigest();
    const n10 = ed.undo.length;
    const g10 = drag(C, [C[0] + 300, C[1] + 40]);
    const h10 = ed.lastHeal, r10 = check(L, h10);
    out.feathered = Object.assign({ kind: g10.kind, d: g10.d, steps: ed.undo.length - n10, label: top(), sel: selDigest() === selF }, r10);
    const o10 = out.feathered;
    if (g10.kind !== "patchdrag" || !same(h10.off, [300, 40]) || h10.where !== "here" || o10.steps !== 1 || o10.label !== "Patch" || !o10.sel) throw new Error("the patch of a feathered selection did not run as stated: " + JSON.stringify(o10));
    if (!exact(r10, 5000) || r10.soft < 1000 || h10.unknowns !== r10.masked) throw new Error("the patch of a feathered selection does not follow its alpha: " + JSON.stringify(o10) + " diag " + JSON.stringify(diag(r10)));
    await ed.undoStep();
    if (digest(L) !== e0) throw new Error("the undo of the feathered patch did not give the empty layer back");
    mark("feathered");

    // 10. no press, drag, preview draw or release above read the whole picture, nor made a display mirror on tiles
    out.calls = calls;
    out.phases = phases;
    out.mirrors = [m0, mirrors()];
    if (calls.compositeCanvas || calls.flattenToCanvas || calls.sampleCanvas) throw new Error("a patch read the whole picture: " + JSON.stringify({ calls, phases }));
    if (ed.tileMode && ((!m0[0] && out.mirrors[1][0]) || (!m0[1] && out.mirrors[1][1]))) throw new Error("a patch made a display mirror: " + JSON.stringify(out.mirrors));
} finally {
    IE.healSyncMax = keep.sync;
    for (const k of Object.keys(calls)) delete ed[k];
    delete ed.drawMarchingAnts; delete ed.healInputs; delete ed.patchExtent;
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("content_aware_move_fills_the_hole_and_blends_the_seam", """
// PLAN_0_1_31 section 5 step 4b: the Content-aware move. A press inside the selection drags it (the patch's gesture); at
// the release the piece lands at E + d with a band inside its edge blended into the new place by the heal's solver (its
// core byte for byte), and Move fills the old place with LaMa (a stand-in here: the model's mask painted one flat colour,
// so the fill is known to the byte); one step, the selection unchanged. The real handlers through synthetic pointer
// events; the layer against the move computed here from the picture's bytes with the kernels' JS twins: a move apart, an
// overlapping one (the seam reads the filled hole), Blend all, in a worker, held (a press, a key, Ctrl+Z, the layer
// deleted), a failure, no model, Extend, the hole's limit, the refusals, the base, and no whole-picture read
const J = await import("./editor/px/kernels_js.js");
const P = await import("./editor/inpaint_pixels.js");
const R = await import("./editor/inpaint_remove.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const IE = ed.constructor;
const W = 1200, H = 800, N = R.REMOVE_SIZE;
const FILL = [10, 200, 30];
// the later cases first in the printed line (it is cut at 4000 characters)
const out = { tiles: !!ed.tileMode, long: null, layerMoved: null, feathered: null, alpha: null };
const keep = { helperCall: host.helperCall, removeModel: host.removeModel, sync: IE.healSyncMax, maxHole: IE.removeMaxHole };
const fake = () => ({ id: "fake", label: "fake" });
// the model stand-in (the Remove step's): every request recorded, an optional delay and failure
const calls = [];
let delay = 0, fail = null;
host.removeModel = fake;
host.helperCall = async (name, a) => {
    if (name === "warmInpaint") { calls.push({ name, model: a.model }); return { ready: true, seconds: 0, provider: "fake" }; }
    if (name !== "inpaint") throw new Error("unknown helper " + name);
    calls.push({ name, model: a.model, image: new Uint8Array(a.image), mask: new Uint8Array(a.mask) });
    if (delay) await wait(delay);
    if (fail) throw fail;
    const image = new Uint8Array(a.image);
    for (let i = 0; i < N * N; i++) if (a.mask[i]) { image[4 * i] = FILL[0]; image[4 * i + 1] = FILL[1]; image[4 * i + 2] = FILL[2]; image[4 * i + 3] = 255; }
    return { image, size: N, seconds: 0.01, provider: "fake" };
};
const reqs = () => calls.filter((c) => c.name === "inpaint");
const counts = { compositeCanvas: 0, flattenToCanvas: 0, sampleCanvas: 0 };
const stacks = [], phases = {}, ants = [];
let counting = false;
try {
    await run("new_canvas", { width: W, height: H, doc: d.id });
    // the picture: the patch step's lit gradient with a fine grain and a warm, coarser texture (x 700 to 1000, y 280 to
    // 620: where the piece goes), and the object to move: a green textured ellipse around (380, 360), radii 55 and 40
    const base = document.createElement("canvas"); base.width = W; base.height = H;
    {
        const img = new ImageData(W, H), a = img.data;
        const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return (h >>> 24) / 255; };
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 4, n = hash(x, y) - 0.5;
            if ((x - 380) * (x - 380) / 3025 + (y - 360) * (y - 360) / 1600 < 1) { const t = hash(x >> 1, y >> 1) - 0.5; a[o] = 30 + 30 * t; a[o + 1] = 170 + 40 * t; a[o + 2] = 70 + 20 * t; }
            else if (x >= 700 && x < 1000 && y >= 280 && y < 620) { const t = hash(x >> 2, y >> 2) - 0.5; a[o] = 200 + 40 * t + 10 * n; a[o + 1] = 70 + 40 * t; a[o + 2] = 50 + 30 * t; }
            else { a[o] = 60 + 0.06 * x + 12 * n; a[o + 1] = 90 + 0.05 * y + 12 * n; a[o + 2] = 140 - 0.04 * x + 12 * n; }
            a[o + 3] = 255;
        }
        base.getContext("2d").putImageData(img, 0, 0);
    }
    Object.defineProperty(base, "naturalWidth", { value: W }); Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "move_test.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    const L = ed.addPaintLayer();
    ed.activeLayerId = L.id; ed.renderLayers();
    await ed.mipsSettled();
    ed.view.angle = 0; ed.view.scale = 0.5; ed._fitted = false; ed.view.x = 10; ed.view.y = 10; ed.draw();
    let baseAll = ed.basePx.readRect(0, 0, W, H).data.slice();
    // the whole-picture reads counted while a pointer event, a draw of the drag or a landing runs (with where from)
    for (const k of Object.keys(counts)) { const f = ed[k]; ed[k] = function (...a) { if (counting) { counts[k]++; if (stacks.length < 4) stacks.push(k + " " + String(new Error().stack).split(String.fromCharCode(10)).slice(2, 7).join(" < ")); } return f.apply(this, a); }; }
    { const f = ed.drawMarchingAnts; ed.drawMarchingAnts = function (ctx, shift) { if (counting) ants.push(shift ? [shift[0], shift[1]] : null); return f.call(this, ctx, shift); }; }
    // for a failure's report: the picture the release read (`moveInputs`: the new place and the piece over U), copied before
    // the seam writes the fill into it
    let lastJob = null;
    ed.moveInputs = function (p, layer) { const j = IE.prototype.moveInputs.call(this, p, layer); lastJob = j ? { U: j.U.slice(), base: j.base.slice(), piece: j.piece.slice() } : null; return j; };
    const mirrors = () => ed.tileMode ? [!!P.displayCanvasIfMade(L.px), !!P.displayCanvasIfMade(ed.basePx)] : null;
    const m0 = mirrors();
    const mark = (name) => { phases[name] = counts.compositeCanvas + counts.flattenToCanvas + counts.sampleCanvas; };
    let pid = 3100;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy, extra = {}) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: "mouse", pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy), extra));
    const send = (type, ix, iy, extra) => { counting = true; try { ed.canvas.dispatchEvent(ev(type, ix, iy, extra)); } finally { counting = false; } };
    const drawNow = () => { counting = true; try { ed.draw(); } finally { counting = false; } };
    const key = (k, o = {}) => ed.root.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, o)));
    // a drag from a to b in six moves, the picture drawn after each (the preview and the ants, as the screen would); what the
    // press made, the offset the drag took and the last shifted outline, read before the release
    const drag = (a, b, moves = 6) => {
        pid++;
        send("pointerdown", a[0], a[1]);
        const kind = ed.pointer ? ed.pointer.kind : null;
        ants.length = 0;
        for (let i = 1; i <= moves; i++) { send("pointermove", a[0] + (b[0] - a[0]) * i / moves, a[1] + (b[1] - a[1]) * i / moves); drawNow(); }
        const p = ed.pointer, dd = p && p.kind === "patchdrag" ? p.d.slice() : null;
        const shifted = ants.filter((s) => s).map((s) => s.join()).pop() || null;
        send("pointerup", b[0], b[1]);
        return { kind, d: dd, ants: shifted };
    };
    // the landing waited for, counted as part of the gesture (the model's answer, the seam, the write, the commit)
    const settle = async () => { counting = true; try { await ed.removePending; for (let i = 0; i < 20 && ed._historyQueue; i++) await ed._historyQueue; } finally { counting = false; } };
    const hashOf = (a) => { let h = 2166136261, n = 0; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619); for (let i = 3; i < a.length; i += 4) if (a[i]) n++; return (h >>> 0).toString(16) + "/" + n; };
    const digest = (layer) => hashOf(layer.px.readRect(0, 0, layer.w, layer.h).data);
    const selDigest = () => hashOf(ed.sel.readRect(0, 0, W, H).data);
    const baseDigest = () => hashOf(ed.basePx.readRect(0, 0, W, H).data);
    const top = () => (ed.undo[ed.undo.length - 1] || {}).label;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // the bytes of `px` (pw x ph) over [x, y, w, h] of its own pixels, zeros outside it
    const readZ = (px, pw, ph, x, y, w, h) => {
        const o = new Uint8Array(w * h * 4);
        const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(pw, x + w), y1 = Math.min(ph, y + h), rw = x1 - x0;
        if (rw <= 0 || y1 <= y0) return o;
        const a = px.readRect(x0, y0, rw, y1 - y0).data;
        for (let yy = y0; yy < y1; yy++) o.set(a.subarray((yy - y0) * rw * 4, (yy - y0 + 1) * rw * 4), ((yy - y) * w + x0 - x) * 4);
        return o;
    };
    // the same, but past the pixels' edge the nearest pixel inside (the move's piece: `patchGuide` replicates the edge)
    const readE = (px, pw, ph, x, y, w, h) => {
        const o = new Uint8Array(w * h * 4);
        const x0 = Math.max(0, Math.min(pw - 1, x)), y0 = Math.max(0, Math.min(ph - 1, y)), x1 = Math.min(pw, Math.max(x0 + 1, x + w)), y1 = Math.min(ph, Math.max(y0 + 1, y + h)), rw = x1 - x0;
        const a = px.readRect(x0, y0, rw, y1 - y0).data;
        for (let yy = 0; yy < h; yy++) {
            const sy = Math.min(y1 - 1, Math.max(y0, y + yy)) - y0;
            for (let xx = 0; xx < w; xx++) {
                const sx = Math.min(x1 - 1, Math.max(x0, x + xx)) - x0, s = (sy * rw + sx) * 4, d = (yy * w + xx) * 4;
                o[d] = a[s]; o[d + 1] = a[s + 1]; o[d + 2] = a[s + 2]; o[d + 3] = a[s + 3];
            }
        }
        return o;
    };

    // the selection as the move takes it (what the ants show): E the extent of alpha 128 and up, selA the alpha over E
    // (the hole and pm are where it is 128 and up); `soft` the pixels of any alpha below 255, `any` the extent of any alpha
    let E = null, ew = 0, eh = 0, selA = null, sel0 = null, selAll = null;
    const takeSel = () => {
        selAll = ed.sel.readRect(0, 0, W, H).data.slice();
        sel0 = hashOf(selAll);
        let x0 = W, y0 = H, x1 = -1, y1 = -1, a0 = W, b0 = H, a1 = -1, b1 = -1, soft = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const s = selAll[(y * W + x) * 4 + 3];
            if (!s) continue;
            if (s !== 255) soft++;
            if (x < a0) a0 = x; if (x > a1) a1 = x; if (y < b0) b0 = y; b1 = y;
            if (s < 128) continue;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y;
        }
        E = [x0, y0, x1 + 1, y1 + 1]; ew = E[2] - E[0]; eh = E[3] - E[1];
        selA = new Uint8Array(ew * eh);
        for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) selA[y * ew + x] = selAll[((y + E[1]) * W + x + E[0]) * 4 + 3];
        return { E: E.slice(), any: [a0, b0, a1 + 1, b1 + 1], soft };
    };
    await run("select_rect", { x: 300, y: 300, w: 160, h: 120, doc: d.id });
    const s0 = takeSel();
    if (!same(E, [300, 300, 460, 420]) || s0.soft) throw new Error("select_rect did not select the 160 x 120 rectangle: " + JSON.stringify(s0));
    const C = [380, 360];
    // what the model should get (Move): the picture over removeCrop(E) and the hole there, at 512 (the Remove module's own
    // functions, fed from the base's bytes)
    const crop0 = R.removeCrop(E, W, H), cw = crop0[2] - crop0[0], ch = crop0[3] - crop0[1];
    const holeCrop = new Uint8Array(cw * ch);
    for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) if (selA[y * ew + x] >= 128) holeCrop[(E[1] + y - crop0[1]) * cw + E[0] + x - crop0[0]] = 255;
    const wantImage = R.toModelImage(readZ(ed.basePx, W, H, crop0[0], crop0[1], cw, ch), cw, ch), wantMask = R.toModelMask(holeCrop, cw, ch);
    const toModel = (X, Y) => Math.round((Y - crop0[1] + 0.5) * N / ch - 0.5) * N + Math.round((X - crop0[0] + 0.5) * N / cw - 0.5);
    const nDiff = (a, b) => { if (a.length !== b.length) return -1; let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
    // the move by `dd` as the release should make it, from the picture's bytes (the base; the paint layers are empty):
    // U = E + d and a pixel around it, cut to the picture and the layer rect `Lr`; the piece = the picture at U - d (its
    // edge repeated past the picture); pm = the selection (alpha 128 and up) moved by d where the piece is not clear; with
    // Move (`hole`) the new place takes FILL where the old place reaches into U (`fill` false: without it, for the order
    // check); Blend "edge": a band of b = clamp(round(min(ew, eh) / 10), 4, 32) px inside pm's edge (the JS twin's squared
    // distances) is the solver's, the core the piece's own bytes; "all" (`whole`): all of pm is the solver's. Last, where
    // the piece lands over its old place with an alpha a below 255, it lies over the filled new place:
    // round((out * a + dstP * (255 - a)) / 255)
    const expectMove = (dd, { hole = true, whole = false, Lr = [0, 0, W, H], fill = true, px = ed.basePx } = {}) => {
        const [dx, dy] = dd, T = [E[0] + dx, E[1] + dy, E[2] + dx, E[3] + dy];
        const U = [Math.max(Lr[0], 0, T[0] - 1), Math.max(Lr[1], 0, T[1] - 1), Math.min(Lr[2], W, T[2] + 1), Math.min(Lr[3], H, T[3] + 1)];
        const uw = U[2] - U[0], uh = U[3] - U[1], n = uw * uh;
        const base = readZ(px, W, H, U[0], U[1], uw, uh), piece = readE(px, W, H, U[0] - dx, U[1] - dy, uw, uh);
        const pm = new Uint8Array(n), inHole = new Uint8Array(n);
        for (let y = 0; y < uh; y++) for (let x = 0; x < uw; x++) {
            const k = y * uw + x, px = U[0] + x - dx - E[0], py = U[1] + y - dy - E[1], hx = U[0] + x - E[0], hy = U[1] + y - E[1];
            if (px >= 0 && px < ew && py >= 0 && py < eh && selA[py * ew + px] >= 128 && piece[4 * k + 3]) pm[k] = 255;
            if (hole && hx >= 0 && hx < ew && hy >= 0 && hy < eh && selA[hy * ew + hx] >= 128) inHole[k] = 1;
        }
        const dstP = base.slice();
        if (fill) for (let k = 0; k < n; k++) if (inHole[k]) { dstP[4 * k] = FILL[0]; dstP[4 * k + 1] = FILL[1]; dstP[4 * k + 2] = FILL[2]; dstP[4 * k + 3] = 255; }
        const b = whole ? null : Math.max(4, Math.min(32, Math.round(Math.min(ew, eh) / 10)));
        const d2 = whole ? null : J.distTransform(pm.map((v) => (v ? 0 : 255)), uw, uh);
        const dst = dstP.slice(), mask = new Uint8Array(n), core = new Uint8Array(n);
        let unknowns = 0, over = 0;
        for (let k = 0; k < n; k++) {
            if (!pm[k]) continue;
            if (!d2 || d2[k] <= b * b) { mask[k] = 255; unknowns++; }
            else { core[k] = 1; for (let c = 0; c < 4; c++) dst[4 * k + c] = piece[4 * k + c]; }
        }
        const info = new Int32Array(4);
        const res = J.poissonBlend(dst, piece, mask, uw, uh, undefined, info), raw = res.slice();
        for (let k = 0; k < n; k++) {
            const a = piece[4 * k + 3];
            if (!pm[k] || !inHole[k] || a === 255) continue;
            over++;
            for (let c = 4 * k; c < 4 * k + 3; c++) res[c] = Math.round((res[c] * a + dstP[c] * (255 - a)) / 255);
        }
        return { U, uw, uh, d: dd, pm, inHole, hole, base, piece, out: res, raw, info: Array.from(info), band: b, unknowns, core, over };
    };
    // the release's picture against the one the expectation read: the bytes that differ (in the new place, in the piece,
    // where the pixel is not opaque) and the largest step
    const inputsDiff = (x) => {
        if (!lastJob || !same(lastJob.U, x.U)) return { job: lastJob && lastJob.U };
        const r = { base: 0, piece: 0, soft: 0, max: 0, at: null };
        for (const [k, a, b] of [["base", lastJob.base, x.base], ["piece", lastJob.piece, x.piece]]) {
            for (let i = 0; i < a.length; i++) {
                if (a[i] === b[i]) continue;
                r[k]++;
                if (b[i - (i % 4) + 3] < 255) r.soft++;
                r.max = Math.max(r.max, Math.abs(a[i] - b[i]));
                if (!r.at) r.at = [k, x.U[0] + ((i >> 2) % x.uw), x.U[1] + Math.floor((i >> 2) / x.uw), i % 4, a[i], b[i], b[i - (i % 4) + 3]];
            }
        }
        return r;
    };
    // the layer against it: in U where the piece lands or the hole reaches, the expected RGB (where the landed alpha is 255)
    // and alpha (255 on the hole, the piece's elsewhere on pm); the hole outside U exactly FILL at 255; the core (pm farther
    // than the band from its edge; where the piece is opaque) the picture's own bytes at X - d; everything else clear
    const verify = (layer, x) => {
        const got = layer.px.readRect(0, 0, layer.w, layer.h).data;
        const [U0, U1, U2, U3] = x.U;
        const r = { landed: 0, full: 0, differ: 0, alpha: 0, fill: 0, fillBad: 0, leak: 0, core: 0, coreBad: 0, first: null };
        for (let ly = 0; ly < layer.h; ly++) for (let lx = 0; lx < layer.w; lx++) {
            const X = lx + layer.x, Y = ly + layer.y, o = (ly * layer.w + lx) * 4, A = got[o + 3];
            const inU = X >= U0 && X < U2 && Y >= U1 && Y < U3, k = inU ? (Y - U1) * x.uw + X - U0 : -1;
            const hx = X - E[0], hy = Y - E[1], inHole = x.hole && hx >= 0 && hx < ew && hy >= 0 && hy < eh && selA[hy * ew + hx] >= 128;
            if (inU && (x.pm[k] || inHole)) {
                r.landed++;
                if (A !== (inHole ? 255 : x.piece[4 * k + 3])) r.alpha++;
                if (A === 255) {
                    r.full++;
                    for (let c = 0; c < 3; c++) if (got[o + c] !== x.out[4 * k + c]) { r.differ++; if (!r.first) r.first = [X, Y, Array.from(got.slice(o, o + 4)), Array.from(x.out.slice(4 * k, 4 * k + 4))]; }
                }
            } else if (inHole) {
                r.fill++;
                if (A !== 255 || got[o] !== FILL[0] || got[o + 1] !== FILL[1] || got[o + 2] !== FILL[2]) r.fillBad++;
            } else if (A) r.leak++;
            if (inU && x.core[k] && x.piece[4 * k + 3] === 255) {
                r.core++;
                const s = ((Y - x.d[1]) * W + X - x.d[0]) * 4;
                if (A !== 255 || got[o] !== baseAll[s] || got[o + 1] !== baseAll[s + 1] || got[o + 2] !== baseAll[s + 2]) r.coreBad++;
            }
        }
        return r;
    };
    const exact = (r, minFull) => r.full >= minFull && !r.differ && !r.alpha && !r.fillBad && !r.leak && !r.coreBad;
    const lmWant = (x, mode, blend) => ({ box: [x.U[0], x.U[1], x.uw, x.uh], hole: mode === "move" ? [E[0], E[1], ew, eh] : null, off: x.d, mode, blend, crop: mode === "move" ? R.removeCrop(E, W, H) : null, band: x.band, unknowns: x.unknowns, wrote: true, error: null });
    // the undo step's parts: two copies (the old place and the new, layer pixels) when the box around both is larger than
    // the two together (Move only), else none
    const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
    const wantParts = (x) => (x.hole && area([Math.min(E[0], x.U[0]), Math.min(E[1], x.U[1]), Math.max(E[2], x.U[2]), Math.max(E[3], x.U[3])]) > area(E) + area(x.U) ? 2 : 0);
    const topParts = () => { const s = ed.undo[ed.undo.length - 1]; return s && Array.isArray(s.parts) ? s.parts.length : 0; };
    const lmGot = (lm) => lm ? { box: lm.box, hole: lm.hole, off: lm.off, mode: lm.mode, blend: lm.blend, crop: lm.crop, band: lm.band, unknowns: lm.unknowns, wrote: lm.wrote, error: lm.error } : null;
    // a press that refuses: the status says why, no gesture, no step, no new layer, no request, nothing written
    const refuse = (what, re) => {
        const n = ed.undo.length, nl = ed.layers.length, e = digest(L), q = reqs().length;
        pid++;
        send("pointerdown", C[0], C[1]);
        const pointer = ed.pointer ? ed.pointer.kind : null;
        send("pointermove", C[0] + 250, C[1]); send("pointermove", C[0] + 500, C[1]);
        send("pointerup", C[0] + 500, C[1]);
        const r = { tool: ed.tool, status: ed.status, pointer, steps: ed.undo.length - n, layers: ed.layers.length - nl, requests: reqs().length - q, same: digest(L) === e, sel: selDigest() === sel0 };
        if (r.tool !== "contentmove" || !re.test(r.status) || r.pointer || r.steps || r.layers || r.requests || !r.same || !r.sel) throw new Error(what + " did not refuse the move: " + JSON.stringify(r));
        return r;
    };

    // 1. picking the tool in Move mode loads the model once (a warm-up request, no inpaint)
    ed.moveOpts = { mode: "move", blend: "edge" };
    ed.setTool("contentmove");
    await wait(50);
    out.warm = { warm: calls.filter((c) => c.name === "warmInpaint").length, inpaint: reqs().length, tool: ed.tool };
    if (out.warm.warm !== 1 || out.warm.inpaint || ed.tool !== "contentmove") throw new Error("picking the Content-aware move did not warm the model once: " + JSON.stringify(out.warm) + " " + ed.status);
    const e0 = digest(L);
    mark("warm");

    // 2. Move by (500, 0) on a paint layer: held at the release, one request (the picture and the hole over the crop), one
    // step; the hole FILL outside U, U the move computed here, the core (the moved rect shrunk by the 12 px band) the
    // picture's own bytes, nothing else written, the selection as it was
    const n2 = ed.undo.length, q2 = reqs().length, nl2 = ed.layers.length;
    const g2 = drag(C, [C[0] + 500, C[1]]);
    const held2 = !!(ed.pointer && ed.pointer.healing && ed.pointer.move && ed.removePending);
    await settle();
    const lm2 = ed.lastMove, x2 = expectMove([500, 0]), r2 = verify(L, x2), rq2 = reqs()[reqs().length - 1];
    out.move = Object.assign({ kind: g2.kind, d: g2.d, ants: g2.ants, held: held2, steps: ed.undo.length - n2, label: top(), layers: ed.layers.length - nl2, requests: reqs().length - q2, sel: selDigest() === sel0,
        where: lm2 && lm2.where, band: lm2 && lm2.band, unknowns: lm2 && lm2.unknowns, info: lm2 && lm2.info, ms: lm2 && lm2.ms }, r2);
    const o2 = out.move;
    if (g2.kind !== "patchdrag" || !same(g2.d, [500, 0]) || !held2) throw new Error("the drag inside the selection did not start the move, held at the release: " + JSON.stringify(o2) + " " + ed.status);
    if (o2.steps !== 1 || o2.label !== "Content-aware move" || o2.layers || o2.requests !== 1 || !o2.sel) throw new Error("the move is not one request and one step: " + JSON.stringify(o2) + " " + ed.status);
    if (!same(lmGot(lm2), lmWant(x2, "move", "edge")) || lm2.where !== "here" || (lm2.info && lm2.info[3]) || x2.band !== 12) throw new Error("lastMove is not the move as stated: " + JSON.stringify({ got: lmGot(lm2), want: lmWant(x2, "move", "edge"), where: lm2 && lm2.where, info: lm2 && lm2.info }));
    const mc = toModel(C[0], C[1]), mf = toModel(crop0[0] + 6, crop0[1] + 6);
    out.move.request = { model: rq2.model, image: nDiff(rq2.image, wantImage), mask: nDiff(rq2.mask, wantMask), centre: rq2.mask[mc], far: rq2.mask[mf], at: Array.from(rq2.image.slice(4 * mc, 4 * mc + 3)) };
    const rq = out.move.request;
    if (rq.model !== "fake" || rq.image || rq.mask || rq.centre !== 255 || rq.far !== 0 || !(rq.at[1] > rq.at[0] + 80)) throw new Error("the model did not get the picture and the hole over removeCrop(E): " + JSON.stringify(rq));
    if (!exact(r2, 19000) || r2.landed !== 19200 || r2.fill !== 19200 || r2.core !== 136 * 96) throw new Error("the move did not land as computed: " + JSON.stringify(o2));
    // the two places lie apart (the box around both, 661 x 122, is larger than the two): the step copies each of them
    o2.parts = topParts();
    if (wantParts(x2) !== 2 || o2.parts !== 2) throw new Error("the step of a move apart does not copy the two places: " + JSON.stringify({ parts: o2.parts, want: wantParts(x2) }));
    const dig2 = digest(L);
    await ed.undoStep();
    if (digest(L) !== e0) throw new Error("the undo of the move did not give the empty layer back");
    mark("move");

    // 3. an overlapping move by (60, 0): the seam reads the new place with the fill already in (the old place reaches into
    // U); the same computation without the fill differs there, so the case proves the order
    const n3 = ed.undo.length, q3 = reqs().length;
    const g3 = drag(C, [C[0] + 60, C[1]]);
    await settle();
    const lm3 = ed.lastMove, x3 = expectMove([60, 0]), r3 = verify(L, x3), x3n = expectMove([60, 0], { fill: false });
    let order = 0, holeInU = 0;
    for (let k = 0; k < x3.uw * x3.uh; k++) {
        if (x3.inHole[k]) holeInU++;
        if ((x3.pm[k] || x3.inHole[k]) && (x3.out[4 * k] !== x3n.out[4 * k] || x3.out[4 * k + 1] !== x3n.out[4 * k + 1] || x3.out[4 * k + 2] !== x3n.out[4 * k + 2])) order++;
    }
    out.overlap = Object.assign({ d: g3.d, steps: ed.undo.length - n3, label: top(), requests: reqs().length - q3, holeInU, order, where: lm3 && lm3.where }, r3);
    const o3 = out.overlap;
    if (!same(g3.d, [60, 0]) || o3.steps !== 1 || o3.label !== "Content-aware move" || o3.requests !== 1 || !same(lmGot(lm3), lmWant(x3, "move", "edge"))) throw new Error("the overlapping move did not run as stated: " + JSON.stringify(o3) + " " + JSON.stringify(lmGot(lm3)));
    if (holeInU !== 101 * 120 || order < 100) throw new Error("the overlapping move proves nothing about the order (no hole in U, or the fill changes nothing): " + JSON.stringify(o3));
    if (!exact(r3, 19000) || r3.landed !== 19200 + 120 || r3.fill !== 59 * 120 || r3.core !== 136 * 96) throw new Error("the overlapping move did not land as computed (the fill read into the seam): " + JSON.stringify(o3));
    // a short overlapping move: one box, no parts
    o3.parts = topParts();
    if (wantParts(x3) || o3.parts) throw new Error("the step of a short overlapping move has parts: " + JSON.stringify({ parts: o3.parts, want: wantParts(x3) }));
    await ed.undoStep();
    if (digest(L) !== e0) throw new Error("the undo of the overlapping move did not give the empty layer back");
    mark("overlap");

    // 4. Blend "all" by (0, 300): all of the piece is the solver's (the mask = pm), no band
    ed.moveOpts.blend = "all";
    const n4 = ed.undo.length;
    const g4 = drag(C, [C[0], C[1] + 300]);
    await settle();
    ed.moveOpts.blend = "edge";
    const lm4 = ed.lastMove, x4 = expectMove([0, 300], { whole: true }), r4 = verify(L, x4);
    out.all = Object.assign({ d: g4.d, steps: ed.undo.length - n4, label: top(), band: lm4 && lm4.band, unknowns: lm4 && lm4.unknowns, where: lm4 && lm4.where }, r4);
    if (!same(g4.d, [0, 300]) || out.all.steps !== 1 || out.all.label !== "Content-aware move" || lm4.band !== null || lm4.unknowns !== 19200 || !same(lmGot(lm4), lmWant(x4, "move", "all"))) throw new Error("Blend all did not run as stated: " + JSON.stringify(out.all) + " " + JSON.stringify(lmGot(lm4)));
    if (!exact(r4, 19000) || r4.landed !== 19200 || r4.fill !== 19200) throw new Error("Blend all did not land as computed: " + JSON.stringify(out.all));
    await ed.undoStep();
    if (digest(L) !== e0) throw new Error("the undo of the Blend all move did not give the empty layer back");
    mark("all");

    // 5. the seam in a worker (healSyncMax 0): the same bytes as the move of case 2 here
    IE.healSyncMax = 0;
    const n5 = ed.undo.length;
    try { drag(C, [C[0] + 500, C[1]]); await settle(); } finally { IE.healSyncMax = keep.sync; }
    const lm5 = ed.lastMove;
    out.worker = { where: lm5 && lm5.where, same: digest(L) === dig2, steps: ed.undo.length - n5, label: top(), info: lm5 && lm5.info, unknowns: lm5 && lm5.unknowns };
    if (out.worker.where !== "worker" || !out.worker.same || out.worker.steps !== 1 || out.worker.label !== "Content-aware move" || (lm5.info && lm5.info[3])) throw new Error("the move's seam in a worker landed otherwise: " + JSON.stringify(out.worker));
    await ed.undoStep();
    if (digest(L) !== e0) throw new Error("the undo of the move in a worker did not give the empty layer back");
    mark("worker");

    // 6. held while the model runs (the stand-in's delay): a press and a shortcut wait and say so, the move lands as one
    // step; Ctrl+Z pressed meanwhile takes it back once it lands; the layer deleted meanwhile takes nothing
    delay = 400;
    try {
        const n6 = ed.undo.length;
        drag(C, [C[0] + 500, C[1]]);
        const p6 = ed.pointer;
        const held6 = !!(p6 && p6.healing && p6.move && ed.removePending), gh6 = ed.gestureHeld();
        pid++; send("pointerdown", 900, 650); send("pointermove", 950, 650); send("pointerup", 950, 650);
        const pressWaited = ed.pointer === p6, pressStatus = ed.status;
        key("b");
        const keyWaited = ed.tool === "contentmove" && /Moving: a moment/.test(ed.status);
        await settle();
        out.held = { held: held6, gestureHeld: gh6, pressWaited, pressStatus, keyWaited, steps: ed.undo.length - n6, label: top(), same: digest(L) === dig2, after: ed.pointer === null, ms: ed.lastMove.ms };
        if (!held6 || !gh6 || !pressWaited || !/Moving: a moment/.test(pressStatus) || !keyWaited) throw new Error("the move did not hold the gesture: " + JSON.stringify(out.held));
        if (out.held.steps !== 1 || out.held.label !== "Content-aware move" || !out.held.same || !out.held.after) throw new Error("the held move landed otherwise: " + JSON.stringify(out.held));
        await ed.undoStep();
        if (digest(L) !== e0) throw new Error("the undo of the held move did not give the empty layer back");
        const n6z = ed.undo.length;
        drag(C, [C[0] + 500, C[1]]);
        const heldZ = !!(ed.pointer && ed.pointer.healing && ed.removePending);
        key("z", { ctrlKey: true });
        await settle();
        out.undoWhileHeld = { held: heldZ, empty: digest(L) === e0, steps: ed.undo.length - n6z, wrote: ed.lastMove.wrote, future: ed.undoList().filter((r) => r.future).map((r) => r.label) };
        if (!heldZ || !out.undoWhileHeld.empty || out.undoWhileHeld.steps || !out.undoWhileHeld.wrote || out.undoWhileHeld.future.join() !== "Content-aware move") throw new Error("Ctrl+Z pressed while the move was held did not take it back: " + JSON.stringify(out.undoWhileHeld));
        const D = ed.addPaintLayer();
        ed.activeLayerId = D.id; ed.renderLayers();
        const d6 = digest(D);
        drag(C, [C[0] + 500, C[1]]);
        await wait(50);
        ed.removeLayer(D.id);
        await settle();
        const back = () => ed.layers.find((l) => l.id === D.id);
        out.deleted = { wrote: ed.lastMove.wrote, error: ed.lastMove.error, gone: !back(), top: top() };
        await ed.undoStep();
        out.deleted.restored = !!back();
        out.deleted.same = back() ? digest(back()) === d6 : null;
        if (out.deleted.wrote !== false || !/deleted/.test(out.deleted.error || "") || !out.deleted.gone || out.deleted.top !== "Delete layer" || !out.deleted.restored || !out.deleted.same) throw new Error("a move landed in a layer deleted while it was held: " + JSON.stringify(out.deleted));
        ed.removeLayer(D.id);
        ed.activeLayerId = L.id; ed.renderLayers();
    } finally { delay = 0; }
    mark("held");

    // 7. the model fails: no step, the layer as it was, the status says so; on the base the layer the move made goes again
    const n7 = ed.undo.length;
    fail = new Error("boom");
    try { drag(C, [C[0] + 500, C[1]]); await settle(); } finally { fail = null; }
    out.failure = { steps: ed.undo.length - n7, same: digest(L) === e0, status: ed.status, wrote: ed.lastMove.wrote, error: ed.lastMove.error, after: ed.pointer === null };
    if (out.failure.steps || !out.failure.same || !/^Content-aware move failed/.test(out.failure.status) || out.failure.wrote !== false || out.failure.error !== "boom" || !out.failure.after) throw new Error("a failed move left something: " + JSON.stringify(out.failure));
    ed.activeLayerId = null; ed.renderLayers();
    const nl7 = ed.layers.length, n7b = ed.undo.length, b7 = baseDigest();
    fail = new Error("boom again");
    try { drag(C, [C[0] + 500, C[1]]); await settle(); } finally { fail = null; }
    out.baseFailure = { layers: ed.layers.length - nl7, active: ed.activeLayerId, steps: ed.undo.length - n7b, status: ed.status, baseSame: baseDigest() === b7 };
    if (out.baseFailure.layers || out.baseFailure.active !== null || out.baseFailure.steps || !/^Content-aware move failed/.test(out.baseFailure.status) || !out.baseFailure.baseSame) throw new Error("a failed move on the base left its new layer: " + JSON.stringify(out.baseFailure));
    ed.activeLayerId = L.id; ed.renderLayers();
    mark("failure");

    // 8. no model: Move refuses at the press; Extend needs none: no request, the old place untouched, U the seam over the
    // new place as it is (no fill), one "Content-aware extend" step
    host.removeModel = () => null;
    try {
        out.noModel = refuse("Move without a model", /needs the LaMa model/);
        ed.moveOpts.mode = "extend";
        const n8 = ed.undo.length, q8 = reqs().length;
        const g8 = drag(C, [C[0] + 500, C[1]]);
        await settle();
        const lm8 = ed.lastMove, x8 = expectMove([500, 0], { hole: false }), r8 = verify(L, x8);
        out.extend = Object.assign({ d: g8.d, steps: ed.undo.length - n8, label: top(), requests: reqs().length - q8, sel: selDigest() === sel0, where: lm8 && lm8.where }, r8);
        if (!same(g8.d, [500, 0]) || out.extend.steps !== 1 || out.extend.label !== "Content-aware extend" || out.extend.requests || !out.extend.sel || !same(lmGot(lm8), lmWant(x8, "extend", "edge"))) throw new Error("Extend did not run as stated: " + JSON.stringify(out.extend) + " " + JSON.stringify(lmGot(lm8)) + " " + ed.status);
        if (!exact(r8, 19000) || r8.landed !== 19200 || r8.fill || r8.core !== 136 * 96) throw new Error("Extend did not land as computed (or touched the old place): " + JSON.stringify(out.extend));
        await ed.undoStep();
    } finally { host.removeModel = fake; ed.moveOpts.mode = "move"; }
    if (digest(L) !== e0) throw new Error("the undo of the Extend did not give the empty layer back");
    mark("extend");

    // 9. a hole wider than removeMaxHole refuses Move at the press; the patch's refusals, in the move's words
    IE.removeMaxHole = 100;
    try { out.maxHole = refuse("a 160 px hole over a limit of 100", /fills up to/); } finally { IE.removeMaxHole = keep.maxHole; }
    out.refused = {};
    ed.quickMask = true;
    try { out.refused.quickMask = refuse("quick mask", /Quick mask/); } finally { ed.quickMask = false; }
    const S = ed.addLayer({ name: "S", kind: "paint", px: ed.pixels.Layer.empty(600, 400), x: 0, y: 0, w: W, h: H });
    ed.activeLayerId = S.id; ed.renderLayers();
    try { out.refused.scaled = refuse("a scaled layer", /Content-aware move paints into a layer at its own size/); } finally { ed.removeLayer(S.id); }
    const O = ed.addLayer({ name: "O", kind: "paint", px: ed.pixels.Layer.empty(400, 400), x: 37, y: -21, w: 400, h: 400 });
    ed.activeLayerId = O.id; ed.renderLayers();
    try { out.refused.past = refuse("a layer at (37, -21) short of the selection", /reaches past/); } finally { ed.removeLayer(O.id); }
    ed.activeLayerId = L.id; ed.renderLayers();
    mark("refusals");

    // 10. on the base: a new active paint layer takes the move (the same bytes as on the paint layer), the base as it was
    ed.activeLayerId = null; ed.renderLayers();
    const nl10 = ed.layers.length, n10 = ed.undo.length, b10 = baseDigest();
    drag(C, [C[0] + 500, C[1]]);
    await settle();
    const NL = ed.activeLayer(), x10 = expectMove([500, 0]);
    const r10 = NL ? verify(NL, x10) : {};
    out.base = Object.assign({ layers: ed.layers.length - nl10, kind: NL && NL.kind, active: !!NL && NL !== L, steps: ed.undo.length - n10, label: top(), baseSame: baseDigest() === b10, same: !!NL && digest(NL) === dig2 }, r10);
    const o10 = out.base;
    if (o10.layers !== 1 || o10.kind !== "paint" || !o10.active || o10.steps !== 1 || o10.label !== "Content-aware move" || !o10.baseSame) throw new Error("the move on the base did not paint into a new active layer as one step: " + JSON.stringify(o10));
    if (!exact(r10, 19000) || r10.fill !== 19200 || !o10.same) throw new Error("the move on the base did not land as computed: " + JSON.stringify(o10));
    await ed.undoStep();
    o10.undone = { kept: ed.layers.includes(NL), empty: ed.layers.includes(NL) ? /[/]0$/.test(digest(NL)) : null, baseSame: baseDigest() === b10 };
    if ((o10.undone.kept && !o10.undone.empty) || !o10.undone.baseSame) throw new Error("the undo of the move on the base left pixels: " + JSON.stringify(o10.undone));
    ed.activeLayerId = L.id; ed.renderLayers();
    mark("base");

    // 12. a long move: E at (100, 100) moved by (800, 500), the box around both places 961 x 621 px. The step is a
    // layerrect of two parts (a copy around each place, layer pixels), its bytes their sum and fewer than the box's; undo
    // gives the layer from before the move back, redo the moved one
    await run("select_rect", { x: 100, y: 100, w: 160, h: 120, doc: d.id });
    const s12 = takeSel();
    if (!same(E, [100, 100, 260, 220]) || s12.soft) throw new Error("select_rect did not select the rectangle at (100, 100): " + JSON.stringify(s12));
    const n12 = ed.undo.length;
    const g12 = drag([180, 160], [980, 660]);
    await settle();
    const x12 = expectMove([800, 500]), r12 = verify(L, x12), st12 = ed.undo[ed.undo.length - 1] || {};
    const U12 = x12.U, box12 = [Math.min(E[0], U12[0]), Math.min(E[1], U12[1]), Math.max(E[2], U12[2]), Math.max(E[3], U12[3])];
    const parts12 = Array.isArray(st12.parts) ? st12.parts : [];
    const holds = (s, b) => s.x <= b[0] && s.y <= b[1] && s.x + s.w >= b[2] && s.y + s.h >= b[3];
    out.long = Object.assign({ d: g12.d, steps: ed.undo.length - n12, label: st12.label, kind: st12.kind, parts: parts12.map((s) => [s.x, s.y, s.w, s.h]), bytes: st12.bytes,
        sum: parts12.reduce((n, s) => n + (s.bytes || 0), 0), boxBytes: area(box12) * 4, want: wantParts(x12),
        each: parts12.length === 2 && ((holds(parts12[0], E) && holds(parts12[1], U12)) || (holds(parts12[1], E) && holds(parts12[0], U12))) }, r12);
    const o12 = out.long;
    if (!same(g12.d, [800, 500]) || o12.steps !== 1 || o12.label !== "Content-aware move" || !exact(r12, 19000) || r12.landed !== 19200 || r12.fill !== 19200) throw new Error("the long move did not land as computed: " + JSON.stringify(o12));
    if (o12.want !== 2 || o12.kind !== "layerrect" || o12.parts.length !== 2 || !o12.each || o12.bytes !== o12.sum || !(o12.bytes > 0 && o12.bytes < o12.boxBytes)) throw new Error("the step of the long move is not a copy of each place, smaller than the box around both: " + JSON.stringify(o12));
    const dig12 = digest(L);
    await ed.undoStep();
    o12.undone = digest(L) === e0;
    await ed.redoStep();
    o12.redone = digest(L) === dig12;
    await ed.undoStep();
    o12.again = digest(L) === e0;
    if (!o12.undone || !o12.redone || !o12.again) throw new Error("undo / redo of the long move did not give the layer's states back: " + JSON.stringify({ undone: o12.undone, redone: o12.redone, again: o12.again }));
    mark("long");

    // 13. the layer moved while the model runs: a paint layer at (40, 30) covering the move; the move once as it is, then
    // again with the layer moved 60 px right (the transform bar's X) during the wait: the result lands in the layer's own
    // pixels as at the release (the same bytes), the mark's colour (255, 60, 120) nowhere in them
    await run("select_rect", { x: 300, y: 300, w: 160, h: 120, doc: d.id });
    takeSel();
    const M = ed.addLayer({ name: "M", kind: "paint", px: ed.pixels.Layer.empty(1300, 900), x: 40, y: 30, w: 1300, h: 900 });
    ed.activeLayerId = M.id; ed.renderLayers();
    const eM = digest(M);
    const own = (layer) => layer.px.readRect(0, 0, layer.w, layer.h).data.slice();
    const marks = (a) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i + 3] && Math.abs(a[i] - 255) <= 3 && Math.abs(a[i + 1] - 60) <= 3 && Math.abs(a[i + 2] - 120) <= 3) n++; return n; };
    const n13 = ed.undo.length;
    drag(C, [C[0] + 500, C[1]]);
    await settle();
    const x13 = expectMove([500, 0], { Lr: [40, 30, 1340, 930] }), r13 = verify(M, x13), ref13 = own(M);
    out.layerMoved = Object.assign({ steps: ed.undo.length - n13, label: top(), marks: marks(ref13) }, r13);
    if (out.layerMoved.steps !== 1 || out.layerMoved.label !== "Content-aware move" || !exact(r13, 19000) || r13.fill !== 19200 || out.layerMoved.marks) throw new Error("the move on a layer at (40, 30) did not land as computed: " + JSON.stringify(out.layerMoved));
    await ed.undoStep();
    if (digest(M) !== eM) throw new Error("the undo of the move on the layer at (40, 30) did not give it back empty");
    delay = 400;
    try {
        const n13b = ed.undo.length;
        drag(C, [C[0] + 500, C[1]]);
        await wait(50);
        const heldM = !!(ed.pointer && ed.pointer.healing && ed.pointer.move && ed.removePending);
        const g = ed.geoInputs;
        g.x.value = String(M.x + 60); g.y.value = String(M.y); g.w.value = String(M.w); g.h.value = String(M.h);
        ed.setLayerGeometry();
        const movedTo = [M.x, M.y];
        await settle();
        const got13 = own(M);
        const sh = out.layerMoved.shifted = { held: heldM, movedTo, steps: ed.undo.length - n13b, labels: ed.undo.slice(-2).map((s) => s.label).sort(), differ: nDiff(got13, ref13), marks: marks(got13), wrote: ed.lastMove.wrote, error: ed.lastMove.error, at: [M.x, M.y] };
        if (!heldM || !same(movedTo, [100, 30]) || sh.steps !== 2 || !same(sh.labels, ["Content-aware move", "Position and size"])) throw new Error("the layer was not moved while the move was held: " + JSON.stringify(sh));
        if (!sh.wrote || sh.differ || sh.marks) throw new Error("the move landed elsewhere in a layer moved while it was held: " + JSON.stringify(sh));
        await ed.undoStep(); await ed.undoStep();
        sh.undone = { empty: digest(M) === eM, at: [M.x, M.y] };
        if (!sh.undone.empty || !same(sh.undone.at, [40, 30])) throw new Error("the undo of the move and the layer's move did not give the layer back: " + JSON.stringify(sh.undone));
    } finally { delay = 0; }
    ed.removeLayer(M.id);
    ed.activeLayerId = L.id; ed.renderLayers();
    mark("layerMoved");

    // 14. a feathered selection: the move takes it as the ants show it, alpha 128 and up: E is that extent (inside the
    // extent of any alpha), the hole and pm follow it (the model's mask too), nothing lands where its alpha is 1 to 127
    await ed.featherSelection(8);
    const s14 = takeSel();
    let holeN = 0;
    for (let k = 0; k < ew * eh; k++) if (selA[k] >= 128) holeN++;
    const n14 = ed.undo.length, q14 = reqs().length, sf14 = sel0;
    const g14 = drag(C, [C[0] + 500, C[1]]);
    await settle();
    const lm14 = ed.lastMove, x14 = expectMove([500, 0]), r14 = verify(L, x14), rq14 = reqs()[reqs().length - 1];
    const crop14 = R.removeCrop(E, W, H), cw14 = crop14[2] - crop14[0], ch14 = crop14[3] - crop14[1], hc14 = new Uint8Array(cw14 * ch14);
    for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) if (selA[y * ew + x] >= 128) hc14[(E[1] + y - crop14[1]) * cw14 + E[0] + x - crop14[0]] = 255;
    // the feather's outer half (alpha 1 to 127): where it is and where it would have gone, nothing landed
    const got14 = L.px.readRect(0, 0, W, H).data;
    let tail = 0, tailHit = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = selAll[(y * W + x) * 4 + 3];
        if (!s || s >= 128) continue;
        tail++;
        if (got14[(y * W + x) * 4 + 3]) tailHit++;
        if (x + 500 < W && got14[(y * W + x + 500) * 4 + 3]) tailHit++;
    }
    out.feathered = Object.assign({ E: s14.E, any: s14.any, soft: s14.soft, holeN, tail, tailHit, d: g14.d, steps: ed.undo.length - n14, label: top(), requests: reqs().length - q14, sel: selDigest() === sf14,
        mask: nDiff(rq14.mask, R.toModelMask(hc14, cw14, ch14)), band: lm14 && lm14.band }, r14);
    const o14 = out.feathered;
    if (!o14.soft || !(s14.any[0] < E[0] && s14.any[1] < E[1] && s14.any[2] > E[2] && s14.any[3] > E[3]) || !tail) throw new Error("the feathered selection has no tail below 128 around E (the case would prove nothing): " + JSON.stringify(o14));
    if (!same(g14.d, [500, 0]) || o14.steps !== 1 || o14.label !== "Content-aware move" || o14.requests !== 1 || !o14.sel || o14.mask || !same(lmGot(lm14), lmWant(x14, "move", "edge"))) throw new Error("the move of a feathered selection did not take it at 128: " + JSON.stringify(o14) + " " + JSON.stringify({ got: lmGot(lm14), want: lmWant(x14, "move", "edge") }));
    if (!exact(r14, 15000) || r14.landed !== holeN || r14.fill !== holeN || tailHit) throw new Error("the move of a feathered selection did not land as computed at 128: " + JSON.stringify(o14));
    await ed.undoStep();
    if (digest(L) !== e0) throw new Error("the undo of the feathered move did not give the empty layer back");
    mark("feathered");

    // no press, drag, preview draw, release or landing above made a display mirror on tiles (read before the base changes)
    out.mirrors = [m0, mirrors()];
    if (ed.tileMode && ((!m0[0] && out.mirrors[1][0]) || (!m0[1] && out.mirrors[1][1]))) throw new Error("a move made a display mirror: " + JSON.stringify(out.mirrors));

    // 15. an overlapping move whose piece is not opaque: a new base whose selected part fades to the right (alpha 255 at x
    // 300 down to 136 at x 459); moved by (60, 0) into a new paint layer. Where the piece lands over its own old place with
    // an alpha a below 255 it lies over the fill: round((out * a + FILL * (255 - a)) / 255), at alpha 255 (the hole's);
    // elsewhere on pm the piece's own alpha
    const tb = document.createElement("canvas"); tb.width = W; tb.height = H;
    {
        const img = new ImageData(W, H), a = img.data;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 4;
            a[o] = 60 + 0.06 * x; a[o + 1] = 90 + 0.05 * y; a[o + 2] = 140 - 0.04 * x;
            a[o + 3] = x >= 300 && x < 460 && y >= 280 && y < 440 ? 255 - Math.floor((x - 300) * 0.75) : 255;
        }
        tb.getContext("2d").putImageData(img, 0, 0);
    }
    Object.defineProperty(tb, "naturalWidth", { value: W }); Object.defineProperty(tb, "naturalHeight", { value: H });
    await ed.setBase({ filename: "move_test_alpha.png", subfolder: "inpaint_canvas", type: "input" }, tb, { keepLayers: false });
    const L2 = ed.addPaintLayer();
    ed.activeLayerId = L2.id; ed.renderLayers();
    if (ed.tool !== "contentmove") ed.setTool("contentmove");
    await ed.mipsSettled();
    baseAll = ed.basePx.readRect(0, 0, W, H).data.slice();
    const alphaAt = baseAll[(360 * W + 400) * 4 + 3];
    if (alphaAt !== 180) throw new Error("the new base did not keep its alpha (the case would prove nothing): " + alphaAt);
    await run("select_rect", { x: 300, y: 300, w: 160, h: 120, doc: d.id });
    takeSel();
    if (!same(E, [300, 300, 460, 420])) throw new Error("select_rect on the new base selected " + JSON.stringify(E));
    // the picture as the tools read it (brushSource "all"), before the move, and this case's expectation built from it: on
    // the canvas backend a sub-rectangle read of the base (`readRect`) is a level off the whole read and the composite
    // where the base is not opaque (found 2026-09-28: 286 bytes of the move's box, the same before and after the move;
    // `picVsBase` records it), and the expectation read that way missed the release's picture by those bytes
    const src15 = ed.brushSource("all", L2);
    let pic15 = null;
    try { pic15 = new Uint8Array(src15.bytes([0, 0, W, H])); } finally { if (src15.release) src15.release(); }
    const picPx = { readRect: (x, y, w, h) => { const o = new Uint8ClampedArray(w * h * 4); for (let r = 0; r < h; r++) o.set(pic15.subarray(((y + r) * W + x) * 4, ((y + r) * W + x + w) * 4), r * w * 4); return { data: o }; } };
    const vsBase = { bytes: 0, opaque: 0, max: 0 };
    for (let i = 0; i < pic15.length; i++) if (pic15[i] !== baseAll[i]) { vsBase.bytes++; if (baseAll[i - (i % 4) + 3] === 255) vsBase.opaque++; vsBase.max = Math.max(vsBase.max, Math.abs(pic15[i] - baseAll[i])); }
    // the base's own bytes over the move's box read again (a sub-rectangle) against the whole read after setBase: before
    // the move and after it (the base is not written in between)
    const baseBox = (tag) => { const a = readZ(ed.basePx, W, H, 299, 299, 222, 122); const r = { tag, bytes: 0, max: 0 }; for (let i = 0; i < a.length; i++) { const X = 299 + ((i >> 2) % 222), Y = 299 + Math.floor((i >> 2) / 222), b = baseAll[(Y * W + X) * 4 + (i % 4)]; if (a[i] !== b) { r.bytes++; r.max = Math.max(r.max, Math.abs(a[i] - b)); } } return r; };
    vsBase.before = baseBox("before");
    const n15 = ed.undo.length, q15 = reqs().length;
    const g15 = drag(C, [C[0] + 60, C[1]]);
    await settle();
    const lm15 = ed.lastMove, x15 = expectMove([60, 0], { px: picPx }), r15 = verify(L2, x15);
    vsBase.after = baseBox("after");
    let mixed = 0;
    for (let k = 0; k < x15.uw * x15.uh; k++) if (x15.pm[k] && x15.inHole[k] && x15.piece[4 * k + 3] < 255 && (x15.out[4 * k] !== x15.raw[4 * k] || x15.out[4 * k + 1] !== x15.raw[4 * k + 1] || x15.out[4 * k + 2] !== x15.raw[4 * k + 2])) mixed++;
    out.alpha = Object.assign({ baseAlpha: alphaAt, d: g15.d, steps: ed.undo.length - n15, label: top(), requests: reqs().length - q15, over: x15.over, mixed, where: lm15 && lm15.where, info: lm15 && lm15.info, picVsBase: vsBase, inputs: inputsDiff(x15) }, r15);
    const o15 = out.alpha;
    if (!same(g15.d, [60, 0]) || o15.steps !== 1 || o15.label !== "Content-aware move" || o15.requests !== 1 || !same(lmGot(lm15), lmWant(x15, "move", "edge")) || (lm15.info && lm15.info[3])) throw new Error("the move of a piece that is not opaque did not run as stated: " + JSON.stringify(o15) + " " + JSON.stringify(lmGot(lm15)));
    if (x15.over !== 98 * 120 || mixed < 5000) throw new Error("the move of a piece that is not opaque has no such pixels over its old place (the case would prove nothing): " + JSON.stringify(o15));
    if (!exact(r15, 12000) || r15.full !== 101 * 120 || r15.landed !== 19200 + 120 || r15.fill !== 59 * 120) throw new Error("the piece that is not opaque did not land over the fill as computed: " + JSON.stringify(o15));
    mark("alpha");

    // 11. no press, drag, preview draw, release or landing above read the whole picture
    out.calls = counts;
    out.phases = phases;
    if (counts.compositeCanvas || counts.flattenToCanvas || counts.sampleCanvas) throw new Error("a move read the whole picture: " + JSON.stringify({ counts, phases, stacks }));
} finally {
    host.helperCall = keep.helperCall; host.removeModel = keep.removeModel;
    IE.healSyncMax = keep.sync; IE.removeMaxHole = keep.maxHole;
    for (const k of Object.keys(counts)) delete ed[k];
    delete ed.drawMarchingAnts; delete ed.moveInputs;
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("liquify_bakes_each_stroke_from_the_session_source", """
// PLAN_0_1_31 section 5 step 5a: Liquify. Every stroke lands at its release as one undo step, baked from the session's
// source (`ed.liq.orig`: the layer as the session's first press found it) through the whole displacement field. The real
// handlers through synthetic pointer events; after every landing the layer against the reference, the source baked through
// `ed.liq.field` by the backend's `liquified`, tile by tile and byte for byte; on tiles every tile the stroke's output tiles
// leave out is the same object as before it. The preview during a stroke (the layer unchanged, the screen displaced, a
// whole-pixel shift the bake's bytes; a sampled pass and the thumbnails draw the tiles); here, in the pool and with the
// bake's block split small the same bytes; undo and redo carry the field (A, undo, B is B alone); Restore all gives the
// source back (on tiles its own tiles); a paint stroke or a write between two strokes starts a new session; a tool key
// during a drag ends the session and the stroke still lands from its source; a layer off the origin (no edge clamp);
// the base gets a copy (the layer "Liquify"); a held bake refuses a press, a flush waits for it, the tile guard drops a
// stroke whose tiles were written meanwhile; a picture above 4 MP (grid step 2); a close
// during a held bake lands nothing; no whole-picture read through the presses, moves, draws and releases
const LQ = await import("./editor/inpaint_liquify.js");
const P = await import("./editor/inpaint_pixels.js");
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const IE = ed.constructor;
const keep = { sync: IE.liquifySyncMax, block: IE.liquifyBlockMax, rate: IE.liquifyRateMs, stab: ed.stabiliser };
const W = 1200, H = 800, BIG = 1e12;
// the later cases first in the printed line (it is cut at 4000 characters)
const out = { tiles: !!ed.tileMode, close: null, grid2: null, guard: null, held: null, base: null, offset: null, toolkey: null, between: null, restoreAll: null, undo: null, here: null, preview: null, first: null };
const calls = { compositeCanvas: 0, flattenToCanvas: 0, sampleCanvas: 0, toCanvas: 0 };
const stacks = [], phases = {};
let counting = false, phase = "setup", LPproto = null, toCanvas0 = null;
const note = (k) => { calls[k]++; phases[phase] = (phases[phase] || 0) + 1; if (stacks.length < 6) stacks.push(phase + " " + k + " " + String(new Error().stack).split(String.fromCharCode(10)).slice(2, 8).join(" < ")); };
try {
    IE.liquifyRateMs = 0;
    ed.stabiliser = 0;
    await run("new_canvas", { width: W, height: H, doc: d.id });
    const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return (h >>> 24) / 255; };
    const texturedBase = (w, h) => {
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const img = new ImageData(w, h), a = img.data;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4, n = hash(x, y) - 0.5;
            a[o] = 60 + 0.06 * x + 20 * n; a[o + 1] = 90 + 0.05 * y + 20 * n; a[o + 2] = 140 - 0.04 * x + 20 * n; a[o + 3] = 255;
        }
        c.getContext("2d").putImageData(img, 0, 0);
        Object.defineProperty(c, "naturalWidth", { value: w }); Object.defineProperty(c, "naturalHeight", { value: h });
        return c;
    };
    // a layer's pixels: a textured opaque rectangle R (hard edges), a half-transparent band B (alpha 96 and 160 in 8 px
    // stripes, its own colours), transparent elsewhere
    const layerData = (w, h, R, B) => {
        const img = new ImageData(w, h), a = img.data;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            if (x >= R[0] && x < R[2] && y >= R[1] && y < R[3]) { const t = hash(x >> 1, y >> 1), u = hash(x + 7, y >> 2); a[o] = 40 + 200 * t; a[o + 1] = 60 + 150 * u; a[o + 2] = 30 + 120 * t * u; a[o + 3] = 255; }
            else if (B && x >= B[0] && x < B[2] && y >= B[1] && y < B[3]) { a[o] = 250 - 0.15 * x; a[o + 1] = 40 + 0.15 * x; a[o + 2] = 200; a[o + 3] = 96 + ((x >> 3) & 1) * 64; }
        }
        return img;
    };
    await ed.setBase({ filename: "liquify_test.png", subfolder: "inpaint_canvas", type: "input" }, texturedBase(W, H), { keepLayers: false });
    // `let`: an undo of a "layers" step (the base's case below) puts copies of the layer objects back
    let L = ed.addLayer({ name: "Warp", kind: "paint", ref: null, px: ed.pixels.Layer.fromImageData(layerData(W, H, [300, 200, 700, 600], [100, 380, 1100, 440])), x: 0, y: 0, w: W, h: H, dirty: true });
    ed.activeLayerId = L.id; ed.renderLayers();
    ed.setTool("liquify");
    ed.liquifyOpts = { mode: "push", strength: 100 };
    ed.setBrushSize(100); ed.hardness = 0.5;   // r = 50, a flat core of 25 px, push steps of 5 px
    await ed.mipsSettled();
    const fnv = (a) => { let h = 2166136261; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619); return (h >>> 0).toString(16) + "/" + a.length; };
    const pxDigest = (px) => fnv(px.readRect(0, 0, px.width, px.height).data);
    const digest = (layer) => pxDigest(layer.px);
    const baseDigest = () => pxDigest(ed.basePx);
    const cellsKey = (cells) => Array.from(cells.keys()).sort((a, b) => a - b).map((k) => { const c = cells.get(k); return k + ":" + fnv(new Uint8Array(c.buffer, c.byteOffset, c.byteLength)); }).join(",");
    const fieldKey = () => (ed.liq ? cellsKey(ed.liq.field.cells) : "no session");
    const top = () => (ed.undo[ed.undo.length - 1] || {}).label;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const tileGrid = (px) => [Math.ceil(px.width / 256), Math.ceil(px.height / 256)];
    const tilesOf = (px) => { const m = new Map(), [tw, th] = tileGrid(px); for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) m.set((ty << 16) | tx, px.tileAt(tx, ty)); return m; };
    const mirrors = () => ed.tileMode ? !!P.displayCanvasIfMade(L.px) : null;
    // the whole-picture reads counted while a pointer event, a draw or a mid-stroke pass runs: the editor's three, and a
    // toCanvas of a whole pixels object of the layers' class
    for (const k of ["compositeCanvas", "flattenToCanvas", "sampleCanvas"]) { const f = ed[k]; ed[k] = function (...a) { if (counting) note(k); return f.apply(this, a); }; }
    LPproto = Object.getPrototypeOf(L.px); toCanvas0 = LPproto.toCanvas;
    LPproto.toCanvas = function (rect) { if (counting && (!rect || (rect[0] <= 0 && rect[1] <= 0 && rect[2] >= this.width && rect[3] >= this.height))) note("toCanvas"); return toCanvas0.apply(this, arguments); };
    let pid = 5100;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy, extra = {}) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: "mouse", pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy), extra));
    const send = (type, ix, iy, extra) => { counting = true; try { ed.canvas.dispatchEvent(ev(type, ix, iy, extra)); } finally { counting = false; } };
    const drawNow = () => { counting = true; try { ed.draw(); } finally { counting = false; } };
    const line = (a, b, n) => { const o = []; for (let i = 0; i <= n; i++) o.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]); return o; };
    // a stroke through the handlers: press, moves (the screen drawn after each), release; `mid(p)` before the release;
    // `hold` leaves a held landing waiting
    const stroke = async (pts, o = {}) => {
        pid++;
        send("pointerdown", pts[0][0], pts[0][1], o.alt ? { altKey: true } : undefined);
        const p = ed.pointer;
        for (let i = 1; i < pts.length; i++) { send("pointermove", pts[i][0], pts[i][1]); if (o.draws !== false) drawNow(); }
        if (o.mid) await o.mid(p);
        const e = pts[pts.length - 1];
        send("pointerup", e[0], e[1]);
        const held = !!(p && ed.pointer === p && p.healing);
        if (!o.hold && ed.liquifyPending) await ed.liquifyPending;
        return { p, held, kind: p ? p.kind : null };
    };
    // the reference: the session's source baked through the whole field (every tile of the layer, `liquified`), against
    // the layer's bytes tile by tile; `share` is the source's own tile
    const refCheck = (layer, what) => {
        const liq = ed.liq;
        if (!liq || !ed.liquifyValid(liq, layer)) throw new Error(what + ": no valid session on the layer: " + JSON.stringify({ sid: liq ? liq.sid : null, same: liq ? liq.layer === layer : null, stamp: liq ? liq.stamp : null, version: layer.px.version }));
        const px = layer.px, [tw, th] = tileGrid(px), nodes = new Map();
        for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) nodes.set((ty << 16) | tx, liq.field.tileNodes(tx, ty));
        const res = liq.orig.liquified(liq.field.s, nodes, { clamp: liq.clamp });
        const r = { s: liq.s, clamp: liq.clamp, cells: liq.field.cells.size, baked: 0, share: 0, empty: 0, differ: 0, bad: [] };
        for (const t of res) {
            const tx = t.key & 0xFFFF, ty = t.key >>> 16, x = tx * 256, y = ty * 256, w = Math.min(256, px.width - x), h = Math.min(256, px.height - y);
            const got = px.readRect(x, y, w, h).data, src = t.share ? liq.orig.readRect(x, y, w, h).data : null;
            let n = 0;
            for (let j = 0; j < h; j++) for (let i = 0; i < w * 4; i++) {
                const v = src ? src[j * w * 4 + i] : t.empty ? 0 : t.bytes[j * 1024 + i];
                if (got[j * w * 4 + i] !== v) n++;
            }
            if (t.share) r.share++; else if (t.empty) r.empty++; else r.baked++;
            if (n) { r.differ += n; if (r.bad.length < 4) r.bad.push([tx, ty, t.share ? "share" : t.empty ? "empty" : "bytes", n]); }
        }
        if (res.length !== tw * th || r.differ) throw new Error(what + ": the layer is not its source baked through the field: " + JSON.stringify(r));
        return r;
    };
    // the bake of the field as it is now over [x0, y0, w, h] of a layer at the origin
    const bakeRect = (x0, y0, w, h) => {
        const liq = ed.liq, nodes = new Map();
        for (let ty = y0 >> 8; ty <= (y0 + h - 1) >> 8; ty++) for (let tx = x0 >> 8; tx <= (x0 + w - 1) >> 8; tx++) nodes.set((ty << 16) | tx, liq.field.tileNodes(tx, ty));
        const res = liq.orig.liquified(liq.s, nodes, { clamp: liq.clamp }), o = new Uint8Array(w * h * 4);
        for (const t of res) {
            const tx = t.key & 0xFFFF, ty = t.key >>> 16;
            const ax0 = Math.max(x0, tx * 256), ax1 = Math.min(x0 + w, tx * 256 + 256), ay0 = Math.max(y0, ty * 256), ay1 = Math.min(y0 + h, ty * 256 + 256);
            if (ax1 <= ax0 || ay1 <= ay0) continue;
            const src = t.share ? liq.orig.readRect(ax0, ay0, ax1 - ax0, ay1 - ay0).data : null;
            for (let y = ay0; y < ay1; y++) for (let x = ax0; x < ax1; x++) {
                const q = ((y - y0) * w + (x - x0)) * 4;
                for (let c = 0; c < 4; c++) o[q + c] = src ? src[((y - ay0) * (ax1 - ax0) + (x - ax0)) * 4 + c] : t.empty ? 0 : t.bytes[((y - ty * 256) * 256 + (x - tx * 256)) * 4 + c];
            }
        }
        return o;
    };
    // one stroke on `layer` that lands as one step: the reference after it; the tiles its output tiles leave out untouched
    // (on tiles the same objects); `ed.lastLiquify` counts those output tiles
    const landed = async (what, layer, pts, o = {}) => {
        const before = ed.liq && ed.liquifyValid(ed.liq, layer) ? new Map(ed.liq.field.cells) : new Map();
        const T0 = ed.tileMode ? tilesOf(layer.px) : null;
        const u = ed.undo.length;
        ed.lastLiquify = null;
        const g = await stroke(pts, o);
        const r = refCheck(layer, what);
        const [tw, th] = tileGrid(layer.px), keys = ed.liq.field.changedTiles(before, tw, th);
        let moved = 0;
        if (T0) { const T1 = tilesOf(layer.px); for (const [k, t] of T0) if (!keys.has(k) && T1.get(k) !== t) moved++; }
        const lq = ed.lastLiquify;
        Object.assign(r, { steps: ed.undo.length - u, label: top(), keys: keys.size, moved, where: lq && lq.where, landedTiles: lq && lq.tiles, stats: lq && lq.stats, sid: ed.liq.sid });
        if (g.kind !== "liquify" || r.steps !== 1 || r.label !== (o.label || "Liquify: push") || !lq || lq.tiles !== keys.size || !keys.size || moved) throw new Error(what + ": the stroke did not land as one step on its output tiles: " + JSON.stringify(r));
        if (o.where && lq.where !== o.where) throw new Error(what + ": landed " + lq.where + ", not " + o.where + ": " + JSON.stringify(r));
        return r;
    };
    const m0 = mirrors();

    // 1. a push leftwards across the rectangle's left edge through the band, at 1:1: during the stroke the layer is as it
    // was, the screen shows the displaced picture (where the field is a whole-pixel shift, the preview's bytes and the
    // screen's are the bake's), a sampled pass and the thumbnails draw the tiles; one step at the release, the reference
    phase = "first";
    IE.liquifySyncMax = BIG;
    ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false;
    ed.view.x = Math.round(ed.canvas.width / 2 - 300); ed.view.y = Math.round(ed.canvas.height / 2 - 410);
    ed.sceneSig = null; ed.draw(); await ed.mipsSettled(); await wait(60);
    const RX = 250, RY = 360, RW = 100, RH = 100, srBox = [RX, RY, RX + RW, RY + RH];
    const srBytes = (c) => c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    // the canvas backend: the first read of a fresh layer canvas can give some half-transparent pixels a level off the
    // reads after it (measured 2026-09-28: 300 pixels of alpha 96, R one lower, between two reads with a sampled pass
    // between them); the layer is read once before its bytes are taken
    const sr0 = srBytes(ed.sampleRegion("image", srBox, 1));
    digest(L);
    const b1 = L.px.readRect(0, 0, W, H).data.slice(), d1 = fnv(b1);
    // for a failure's report: where the layer's bytes differ from `b1`, and how
    const layerDiff = () => {
        const a = L.px.readRect(0, 0, W, H).data, r = { n: 0, bbox: null, alphas: {}, samples: [] };
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (let k = 0; k < W * H; k++) {
            const q = 4 * k;
            if (a[q] === b1[q] && a[q + 1] === b1[q + 1] && a[q + 2] === b1[q + 2] && a[q + 3] === b1[q + 3]) continue;
            r.n++;
            const x = k % W, y = (k / W) | 0;
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
            r.alphas[b1[q + 3]] = (r.alphas[b1[q + 3]] || 0) + 1;
            if (r.samples.length < 4) r.samples.push([x, y, Array.from(b1.subarray(q, q + 4)), Array.from(a.subarray(q, q + 4))]);
        }
        if (r.n) r.bbox = [x0, y0, x1 + 1, y1 + 1];
        return r;
    };
    const Tstart = ed.tileMode ? tilesOf(L.px) : null;
    // six moves of 8 px: two push steps of exactly 4 px each, so the last dab's flat core is shifted by 48 whole pixels
    const pts1 = line([340, 410], [292, 410], 6);
    const pv = { readTwice: digest(L) === d1 };
    if (!pv.readTwice) throw new Error("two reads of the untouched layer differ: " + JSON.stringify(layerDiff()));
    const r1 = await landed("the first push", L, pts1, { mid: async (p) => {
        const liq = ed.liq;
        pv.layerSame = digest(L) === d1;
        if (!pv.layerSame) pv.layerDiff = layerDiff();
        pv.sid = liq.sid;
        counting = true;
        let sc;
        try { sc = ed.sampleRegion("image", srBox, 1); ed.refreshLayerThumb(L); ed.drawThumb(); } finally { counting = false; }
        const sr1 = srBytes(sc);
        let srMax = 0;
        for (let i = 0; i < sr1.length; i++) srMax = Math.max(srMax, Math.abs(sr1[i] - sr0[i]));
        pv.sampledMax = srMax;
        const bake = bakeRect(RX, RY, RW, RH), src = liq.orig.readRect(RX, RY, RW, RH).data;
        const win = ed.liquifyWindow(p, { x: RX - 100, y: RY - 100, w: RW + 200, h: RH + 200, sx: 1, sy: 1, screen: true });
        const prev = new Uint8ClampedArray(RW * RH * 4);
        LQ.previewBlock(win, liq.field, RX - L.x, RY - L.y, 1, prev, RW, RH);
        ed.hover = null; ed.sceneSig = null; drawNow();
        const c0 = ed.imageToScreen(RX, RY).map(Math.round);
        const scr = ed.canvas.getContext("2d").getImageData(c0[0], c0[1], RW, RH).data;
        const rd = LQ.fieldReader(liq.field), last = pts1[pts1.length - 1], rr = ed.brushSize / 2;
        let whole = 0, pvDiff = 0, scrN = 0, scrMax = 0, shown = 0;
        for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
            const X = RX + x, Y = RY + y, dx = rd.at(X, Y, 0), dy = rd.at(X, Y, 1);
            if (!(dx || dy) || dx % 256 || dy % 256) continue;
            whole++;
            const q = (y * RW + x) * 4;
            for (let c = 0; c < 4; c++) if (prev[q + c] !== bake[q + c]) { pvDiff++; break; }
            const ring = Math.abs(Math.hypot(X + 0.5 - last[0], Y + 0.5 - last[1]) - rr) < 5;
            if (bake[q + 3] === 255 && !ring) {
                scrN++;
                let mv = 0;
                for (let c = 0; c < 3; c++) { scrMax = Math.max(scrMax, Math.abs(scr[q + c] - bake[q + c])); mv = Math.max(mv, Math.abs(bake[q + c] - src[q + c])); }
                if (mv > 8) shown++;
            }
        }
        Object.assign(pv, { at: [c0, ed.canvasToImage(c0[0], c0[1]).map(Math.round)], whole, pvDiff, scrN, scrMax, shown, calls: Object.values(calls).reduce((a, b) => a + b, 0) });
    } });
    out.first = { keys: r1.keys, where: r1.where, baked: r1.baked, share: r1.share, cells: r1.cells, sid: r1.sid, clamp: r1.clamp };
    out.preview = pv;
    if (!pv.layerSame) throw new Error("the layer changed during the stroke (it lands at the release): " + JSON.stringify(pv));
    if (pv.sampledMax > 2 || pv.calls) throw new Error("a sampled pass or a thumbnail mid-stroke did not draw the tiles, or read the whole picture: " + JSON.stringify({ pv, calls, stacks }));
    if (pv.whole < 800 || pv.pvDiff) throw new Error("the preview's bytes are not the bake's where the field is a whole-pixel shift: " + JSON.stringify(pv));
    if (pv.scrN < 800 || pv.scrMax > 2 || pv.shown < 200) throw new Error("the screen at 1:1 does not show the displaced picture: " + JSON.stringify(pv));
    if (!r1.clamp || r1.s !== 1 || r1.where !== "here") throw new Error("the first push did not run as stated: " + JSON.stringify(r1));

    // 2. a push down across the bottom edge and two tile borders, at another zoom (the preview through drawLayerPass):
    // here, in the pool, and with the bake's block split at 64 px: the same bytes and the same field
    phase = "here";
    ed.view.scale = 0.37; ed.view.x = 13; ed.view.y = 7; ed.sceneSig = null; ed.draw();
    const pts2 = line([515, 560], [515, 640], 10);
    const dS1 = digest(L), cS1 = fieldKey();
    let mid2 = null;
    const h2 = await landed("the second push, here", L, pts2, { where: "here", mid: async () => { mid2 = digest(L) === dS1; } });
    const dHere = digest(L), cHere = fieldKey();
    await ed.undoStep();
    const u2 = { same: digest(L) === dS1, cells: fieldKey() === cS1 };
    IE.liquifySyncMax = 0;
    const h3 = await landed("the second push, in the pool", L, pts2, { where: "pool" });
    const pool = { bytes: digest(L) === dHere, cells: fieldKey() === cHere };
    await ed.undoStep();
    IE.liquifySyncMax = BIG; IE.liquifyBlockMax = 64;
    let h4;
    try { h4 = await landed("the second push, its bake split small", L, pts2, { where: "here" }); } finally { IE.liquifyBlockMax = 0; }
    const split = { bytes: digest(L) === dHere, cells: fieldKey() === cHere };
    out.here = { keys: h2.keys, mid: mid2, undo: u2, pool, poolStats: h3.stats, split, splitStats: h4.stats, hereStats: h2.stats };
    if (!mid2 || !u2.same || !u2.cells) throw new Error("the second push: the layer changed during it, or its undo did not give the layer and the field back: " + JSON.stringify(out.here));
    if (!pool.bytes || !pool.cells) throw new Error("the pool's bake is not the one made here: " + JSON.stringify(out.here));
    if (!split.bytes || !split.cells || !(h4.stats && h4.stats.splits > 0)) throw new Error("the bake split into small blocks is not the same, or did not split: " + JSON.stringify(out.here));
    if (h2.keys <= 4) throw new Error("the second push reached " + h2.keys + " tiles: it was meant to cross two tile borders");

    // 3. undo and redo carry the field: B alone; A, undone (the layer and the field as before, the session kept), redone
    // (A's bytes and field), undone; then B again: B's bytes and field
    phase = "undo";
    ed.view.scale = 0.5; ed.view.x = 10; ed.view.y = 10; ed.sceneSig = null; ed.draw();
    const ptsA = line([300, 450], [340, 410], 5);   // diagonal: steps of 3.77 px, a field between whole pixels
    const ptsB = line([660, 300], [716, 300], 7);   // the rectangle pushed past its right edge
    const dS = digest(L), cS = fieldKey(), sidS = ed.liq.sid;
    const back = (what) => { const r = { same: digest(L) === dS, cells: fieldKey() === cS, valid: ed.liquifyValid(ed.liq, L), sid: ed.liq ? ed.liq.sid : null }; if (!r.same || !r.cells || !r.valid || r.sid !== sidS) throw new Error(what + " did not give the layer and the field back: " + JSON.stringify(r)); return r; };
    await landed("stroke B", L, ptsB);
    const dB = digest(L), cB = fieldKey();
    await ed.undoStep(); back("the undo of B");
    await landed("stroke A", L, ptsA);
    const dA = digest(L), cA = fieldKey();
    await ed.undoStep(); back("the undo of A");
    await ed.redoStep();
    const redo = { same: digest(L) === dA, cells: fieldKey() === cA, valid: ed.liquifyValid(ed.liq, L), sid: ed.liq ? ed.liq.sid : null, label: top() };
    if (!redo.same || !redo.cells || !redo.valid || redo.sid !== sidS || redo.label !== "Liquify: push") throw new Error("the redo of A did not bring its bytes and its field back: " + JSON.stringify(redo));
    refCheck(L, "A redone");
    await ed.undoStep(); back("the second undo of A");
    const rB2 = await landed("B after A and its undo", L, ptsB);
    const alone = { same: digest(L) === dB, cells: fieldKey() === cB };
    out.undo = { redo, alone, sid: sidS, keysB: rB2.keys };
    if (!alone.same || !alone.cells) throw new Error("A, undo, B is not B alone: " + JSON.stringify(out.undo));
    out.mirrors = [m0, mirrors()];
    if (ed.tileMode && !m0 && out.mirrors[1]) throw new Error("a liquify stroke made a display mirror of its layer");

    // 4. Restore all: the session's source again, byte for byte (on tiles the tiles the session found), one step; its undo
    // gives the strokes back
    phase = "restoreAll";
    const dPre = digest(L), cPre = fieldKey(), uR = ed.undo.length, origD = pxDigest(ed.liq.orig);
    ed.lastLiquify = null;
    counting = true;
    try { ed.liquifyRestoreAll(); } finally { counting = false; }
    if (ed.liquifyPending) await ed.liquifyPending;
    const ra = { steps: ed.undo.length - uR, label: top(), source: digest(L) === origD, sourceIsStart: origD === d1, empty: !!ed.liq && ed.liq.field.empty, where: ed.lastLiquify && ed.lastLiquify.where, tiles: ed.lastLiquify && ed.lastLiquify.tiles };
    if (Tstart) { const T1 = tilesOf(L.px), other = []; for (const [k, t] of Tstart) if (T1.get(k) !== t) other.push([k & 0xFFFF, k >>> 16]); ra.otherTiles = other; }
    out.restoreAll = ra;
    if (ra.steps !== 1 || ra.label !== "Liquify: restore all" || !ra.source || !ra.sourceIsStart || !ra.empty) throw new Error("Restore all did not give the session's source back as one step: " + JSON.stringify(ra));
    if (Tstart && ra.otherTiles.length) throw new Error("Restore all left tiles that are not the ones the session found: " + JSON.stringify(ra));
    refCheck(L, "Restore all");
    await ed.undoStep();
    ra.undone = { same: digest(L) === dPre, cells: fieldKey() === cPre, valid: ed.liquifyValid(ed.liq, L) };
    if (!ra.undone.same || !ra.undone.cells || !ra.undone.valid) throw new Error("the undo of Restore all did not give the strokes back: " + JSON.stringify(ra));
    refCheck(L, "the undo of Restore all");

    // 5. picking another tool ends the session; a paint stroke, then a push: a new session from the painted layer. A write
    // while the tool stays, then a push: a new session from the written layer
    phase = "between";
    const sidP = ed.liq.sid;
    ed.setTool("paint");
    const ended = ed.liq === null;
    ed.setBrushSize(20);
    pid++;
    for (const [t, x] of [["pointerdown", 380], ["pointermove", 400], ["pointermove", 420], ["pointermove", 440], ["pointerup", 460]]) ed.canvas.dispatchEvent(ev(t, x, 250));
    await wait(100);
    const dPaint = digest(L);
    ed.setTool("liquify"); ed.setBrushSize(100);
    const rP = await landed("the push after a paint stroke", L, line([420, 262], [372, 262], 6));
    const between = { ended, painted: dPaint !== dPre, sids: [sidP, rP.sid], sourceIsPainted: pxDigest(ed.liq.orig) === dPaint };
    const sidW = ed.liq.sid, dot = new ImageData(6, 6);
    dot.data.fill(255);
    L.px.writeRect(dot, 800, 100); ed.markLayerChanged(L, [800, 100, 806, 106]);
    between.validAfterWrite = ed.liquifyValid(ed.liq, L);
    const rW = await landed("the push after a write", L, line([826, 103], [778, 103], 6));
    between.write = { sids: [sidW, rW.sid], sourceHasDot: Array.from(ed.liq.orig.readRect(802, 102, 1, 1).data).join() === "255,255,255,255" };
    out.between = between;
    if (!ended || !between.painted || rP.sid === sidP || !between.sourceIsPainted) throw new Error("a paint stroke between two pushes did not start a new session from the painted layer: " + JSON.stringify(between));
    if (between.validAfterWrite || rW.sid === sidW || !between.write.sourceHasDot) throw new Error("a write between two pushes did not start a new session from the written layer: " + JSON.stringify(between));

    // 5b. a tool key while the button is down (the 5a review's bug: the key ended the session and let its source go under
    // the drag, and the landing dropped the tiles it wrote): the key ends the session, the stroke still lands at the
    // release as one step, the session's source baked through the field as the drag left it; the source is let go only
    // after the landing (on canvases `release` does nothing, so its call is what is timed)
    phase = "toolkey";
    const n5b = ed.undo.length, k5b = { released: null };
    let liq5b = null, want5b = null, rel5b = null;
    try {
        const g5b = await stroke(line([470, 520], [422, 520], 6), { mid: async (p) => {
            liq5b = p.liq;
            k5b.session = ed.liq === liq5b;
            rel5b = liq5b.orig.release;
            liq5b.orig.release = function (...a) { if (!k5b.released) k5b.released = { steps: ed.undo.length - n5b, keyDone: !!k5b.key }; return rel5b.apply(this, a); };
            want5b = bakeRect(0, 0, W, H);
            ed.root.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true, cancelable: true }));
            k5b.key = { tool: ed.tool, ended: ed.liq === null, pointer: ed.pointer === p, released: !!k5b.released };
        } });
        const got5b = L.px.readRect(0, 0, W, H).data;
        let off5b = 0;
        for (let i = 0; i < got5b.length; i++) if (got5b[i] !== want5b[i]) off5b++;
        Object.assign(k5b, { kind: g5b.kind, steps: ed.undo.length - n5b, label: top(), off: off5b, sessionAfter: ed.liq === null, pointerAfter: ed.pointer === null });
    } finally {
        if (liq5b && rel5b) delete liq5b.orig.release;
    }
    out.toolkey = k5b;
    if (!k5b.session || !k5b.key || k5b.key.tool !== "paint" || !k5b.key.ended || !k5b.key.pointer || k5b.key.released) throw new Error("a tool key during a liquify drag did not end the session with the stroke still running: " + JSON.stringify(k5b));
    if (k5b.kind !== "liquify" || k5b.steps !== 1 || k5b.label !== "Liquify: push" || k5b.off || !k5b.sessionAfter || !k5b.pointerAfter) throw new Error("a stroke whose session a tool key ended did not land as the bake of its source: " + JSON.stringify(k5b));
    if (!k5b.released || k5b.released.steps !== 1 || !k5b.released.keyDone) throw new Error("the ended session's source was not let go after the landing: " + JSON.stringify(k5b));
    ed.setTool("liquify"); ed.setBrushSize(100);

    // 6. a layer of 500 x 300 at (650, 450): no edge clamp (what the field reads from outside is transparent, what it
    // pushes out is cut); a push rightwards from past its left edge
    phase = "offset";
    const Q = ed.addLayer({ name: "Offset", kind: "paint", ref: null, px: ed.pixels.Layer.fromImageData(layerData(500, 300, [0, 0, 250, 300], [250, 100, 500, 160])), x: 650, y: 450, w: 500, h: 300, dirty: true });
    ed.activeLayerId = Q.id; ed.renderLayers();
    const dQ = digest(Q);
    const rQ = await landed("a push on a layer at (650, 450)", Q, line([630, 560], [678, 560], 6));
    out.offset = { clamp: rQ.clamp, keys: rQ.keys, baked: rQ.baked, changed: digest(Q) !== dQ, size: [Q.px.width, Q.px.height, Q.x, Q.y] };
    if (rQ.clamp || !out.offset.changed || !same(out.offset.size, [500, 300, 650, 450])) throw new Error("the push on a layer off the origin did not run as stated: " + JSON.stringify(out.offset));
    ed.removeLayer(Q.id);
    ed.activeLayerId = L.id; ed.renderLayers();

    // 7. on the base: a press adds the layer "Liquify" directly above it (a copy of the base, on tiles its very tiles), the
    // push lands in it as one step, the base is never written; one undo takes the layer away; a click without a move
    // leaves no layer and no step
    phase = "base";
    ed.activeLayerId = null; ed.renderLayers();
    const nl7 = ed.layers.length, n7 = ed.undo.length, b7 = baseDigest(), TB = ed.tileMode ? tilesOf(ed.basePx) : null;
    const g7 = await stroke(line([900, 250], [948, 250], 6));
    const N = ed.layers[0];
    const o7 = { layers: ed.layers.length - nl7, name: N && N.name, active: !!N && ed.activeLayerId === N.id, steps: ed.undo.length - n7, label: top(), baseSame: baseDigest() === b7, session: !!ed.liq && ed.liq.layer === N };
    out.base = o7;
    if (g7.kind !== "liquify" || o7.layers !== 1 || o7.name !== "Liquify" || !o7.active || o7.steps !== 1 || o7.label !== "Liquify: push" || !o7.baseSame || !o7.session) throw new Error("a push on the base did not land in a new layer Liquify above it: " + JSON.stringify(o7));
    o7.ref = refCheck(N, "the push on the base").baked;
    o7.sourceIsBase = pxDigest(ed.liq.orig) === b7;
    if (TB) { const keys = ed.liq.field.changedTiles(new Map(), ...tileGrid(N.px)), T1 = tilesOf(N.px); let moved = 0; for (const [k, t] of TB) if (!keys.has(k) && T1.get(k) !== t) moved++; o7.notBaseTiles = moved; }
    if (!o7.sourceIsBase || o7.notBaseTiles) throw new Error("the layer Liquify is not a copy of the base (on tiles its tiles): " + JSON.stringify(o7));
    await ed.undoStep();
    o7.undone = { layers: ed.layers.length - nl7, gone: !ed.layers.includes(N), steps: ed.undo.length - n7, baseSame: baseDigest() === b7 };
    if (o7.undone.layers || !o7.undone.gone || o7.undone.steps || !o7.undone.baseSame) throw new Error("one undo did not take the layer Liquify away: " + JSON.stringify(o7));
    ed.activeLayerId = null; ed.renderLayers();
    pid++; send("pointerdown", 900, 250); send("pointerup", 900, 250);
    if (ed.liquifyPending) await ed.liquifyPending;
    o7.click = { layers: ed.layers.length - nl7, steps: ed.undo.length - n7, pointer: ed.pointer === null, baseSame: baseDigest() === b7 };
    if (o7.click.layers || o7.click.steps || !o7.click.pointer || !o7.click.baseSame) throw new Error("a click on the base without a move left a layer or a step: " + JSON.stringify(o7));
    L = ed.layers.find((l) => l.id === L.id);
    ed.activeLayerId = L.id; ed.renderLayers();

    // 8. a bake in the pool holds the gesture: a press meanwhile is refused with a word, the flush of the document waits for
    // the landing (one step, the reference)
    phase = "held";
    IE.liquifySyncMax = 0;
    ed.lastLiquify = null;
    const n8 = ed.undo.length, d8 = digest(L);
    const g8 = await stroke(line([560, 330], [608, 330], 6), { hold: true });
    const p8 = ed.pointer;
    const h8 = { held: g8.held, pending: !!ed.liquifyPending, gestureHeld: ed.gestureHeld(), layerSame: digest(L) === d8, steps: ed.undo.length - n8 };
    pid++; send("pointerdown", 200, 700); send("pointermove", 240, 700); send("pointerup", 240, 700);
    h8.pressWaited = ed.pointer === p8; h8.pressStatus = ed.status;
    await host.flushEditor(ed);
    Object.assign(h8, { after: ed.pointer === null, pendingAfter: ed.liquifyPending === null, landed: ed.undo.length - n8, label: top(), where: ed.lastLiquify && ed.lastLiquify.where, stats: ed.lastLiquify && ed.lastLiquify.stats });
    out.held = h8;
    if (!h8.held || !h8.pending || !h8.gestureHeld || !h8.layerSame || h8.steps || !h8.pressWaited || !/Liquifying: a moment/.test(h8.pressStatus)) throw new Error("a bake in the pool did not hold the gesture: " + JSON.stringify(h8));
    if (!h8.after || !h8.pendingAfter || h8.landed !== 1 || h8.label !== "Liquify: push" || h8.where !== "pool") throw new Error("the flush did not wait for the held bake: " + JSON.stringify(h8));
    refCheck(L, "the held push");

    // 9. the tile guard: a write into one of the stroke's output tiles while its bake is held drops the stroke (the layer as
    // it was, the field as before); on canvases any write does
    phase = "guard";
    const n9 = ed.undo.length, d9 = digest(L);
    const g9 = await stroke(line([560, 520], [608, 520], 6), { hold: true });
    const p9 = ed.pointer, keys9 = p9 && p9.healing ? ed.liq.field.changedTiles(p9.before, ...tileGrid(L.px)) : new Set();
    const c9 = p9 && p9.before ? cellsKey(p9.before) : null;
    const k9 = Array.from(keys9)[0] || 0, gx = k9 & 0xFFFF, gy = k9 >>> 16;
    let unwrite;
    if (ed.tileMode) { ed.liq.px.writable(gx, gy).data[0] ^= 1; unwrite = () => { L.px.writable(gx, gy).data[0] ^= 1; }; }
    else {
        const x9 = gx * 256 + 40, y9 = gy * 256 + 40, was = L.px.readRect(x9, y9, 1, 1), dot9 = new ImageData(1, 1);
        dot9.data.set([1, 2, 3, 255]);
        // the canvas backend's version moves on the editor's touch after a write (inpaint_pixels.js), not on writeRect
        L.px.writeRect(dot9, x9, y9, "copy"); ed.markLayerChanged(L, [x9, y9, x9 + 1, y9 + 1]);
        unwrite = () => { L.px.writeRect(was, x9, y9, "copy"); ed.markLayerChanged(L, [x9, y9, x9 + 1, y9 + 1]); };
    }
    if (ed.liquifyPending) await ed.liquifyPending;
    const o9 = { held: g9.held, keys: keys9.size, status: ed.status, steps: ed.undo.length - n9, pointer: ed.pointer === null, cells: fieldKey() === c9 };
    unwrite();
    o9.same = digest(L) === d9;
    out.guard = o9;
    if (!o9.held || !o9.keys || !/The layer changed while Liquify was baking: nothing landed/.test(o9.status) || o9.steps || !o9.pointer || !o9.cells || !o9.same) throw new Error("a write into the held stroke's tiles did not drop it: " + JSON.stringify(o9));

    // 10. a picture above 4 MP: the grid step is 2 px; a push against the reference; its undo empties the field
    phase = "grid2";
    IE.liquifySyncMax = BIG;
    const W2 = 2400, H2 = 1800;
    await run("new_canvas", { width: W2, height: H2, doc: d.id });
    await ed.setBase({ filename: "liquify_test2.png", subfolder: "inpaint_canvas", type: "input" }, texturedBase(W2, H2), { keepLayers: false });
    const L2 = ed.addLayer({ name: "Warp 2", kind: "paint", ref: null, px: ed.pixels.Layer.fromImageData(layerData(W2, H2, [900, 600, 1500, 1200], [300, 850, 2100, 950])), x: 0, y: 0, w: W2, h: H2, dirty: true });
    ed.activeLayerId = L2.id; ed.renderLayers();
    ed.setTool("liquify"); ed.setBrushSize(100); ed.hardness = 0.5;
    ed.view.scale = 0.25; ed.view.x = 10; ed.view.y = 10; ed.sceneSig = null; ed.draw();
    await ed.mipsSettled();
    const d10 = digest(L2);
    const r10 = await landed("a push at grid step 2", L2, line([1000, 900], [952, 900], 6));
    out.grid2 = { s: r10.s, lastS: ed.lastLiquify && ed.lastLiquify.s, keys: r10.keys, baked: r10.baked, clamp: r10.clamp };
    if (r10.s !== 2 || out.grid2.lastS !== 2 || !r10.clamp) throw new Error("the picture above 4 MP did not liquify at grid step 2: " + JSON.stringify(out.grid2));
    await ed.undoStep();
    out.grid2.undone = { same: digest(L2) === d10, empty: !!ed.liq && ed.liq.field.empty };
    if (!out.grid2.undone.same || !out.grid2.undone.empty) throw new Error("the undo of the push at grid step 2 did not give the layer back: " + JSON.stringify(out.grid2));

    // 11. the phases above with a press, a move, a draw or a release read no whole picture (the canvas backend's "layers"
    // step for the new layer Liquify writes every layer out: its base phase is left out)
    out.calls = calls; out.phases = phases;
    const bad = Object.keys(phases).filter((k) => !(k === "base" && !ed.tileMode));
    if (bad.length) throw new Error("a liquify stroke read the whole picture: " + JSON.stringify({ calls, phases, stacks }));

    // 12. closing the editor while a bake is held lands nothing, not even when the bake answers after it
    phase = "close";
    IE.liquifySyncMax = 0;
    const n12 = ed.undo.length, d12 = digest(L2);
    const g12 = await stroke(line([1000, 1100], [952, 1100], 6), { hold: true });
    const pend = ed.liquifyPending;
    const o12 = { held: g12.held, pending: !!pend };
    ed.close();
    Object.assign(o12, { pointer: ed.pointer === null, same: digest(L2) === d12, steps: ed.undo.length - n12, session: ed.liq === null });
    if (pend) await pend;
    await wait(50);
    Object.assign(o12, { sameAfter: digest(L2) === d12, stepsAfter: ed.undo.length - n12 });
    out.close = o12;
    if (!o12.held || !o12.pending || !o12.pointer || !o12.same || o12.steps || !o12.session || !o12.sameAfter || o12.stepsAfter) throw new Error("closing the editor during a held bake landed something: " + JSON.stringify(o12));
} finally {
    IE.liquifySyncMax = keep.sync; IE.liquifyBlockMax = keep.block; IE.liquifyRateMs = keep.rate;
    if (LPproto && toCanvas0) LPproto.toCanvas = toCanvas0;
    for (const k of ["compositeCanvas", "flattenToCanvas", "sampleCanvas"]) delete ed[k];
    ed.stabiliser = keep.stab;
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("liquify_brushes_move_the_picture_and_refuse", """
// PLAN_0_1_31 section 5 step 5a: Liquify's brushes through the real handlers (the timed dabs by `liquifyTick`). Grow
// swells a disc (its edge along a ray moves out), shrink pinches it (in), swirl clockwise turns a marker right of the
// centre downwards (y down), swirl counter-clockwise upwards; Alt reverses grow, shrink and the swirl; restore brings a
// grow back to the byte; a push there and back empties the field again; a hard selection keeps a push inside itself;
// every refusal at the press leaves no step and no session; the keys (Shift+W and Ctrl+Shift+X pick Liquify, W stays
// the wand, Ctrl+X still cuts)
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const IE = ed.constructor;
const keep = { rate: IE.liquifyRateMs, sync: IE.liquifySyncMax, stab: ed.stabiliser };
const W = 1200, H = 800, C = [600, 400];
const out = { tiles: !!ed.tileMode, keys: null, refused: null, selection: null, thereAndBack: null, restore: null };
try {
    IE.liquifyRateMs = 0; IE.liquifySyncMax = 1e12; ed.stabiliser = 0;
    await run("new_canvas", { width: W, height: H, doc: d.id });
    // the layer: a textured disc of radius 60 around C, a blue marker (10 px square) 100 px right of C, transparent elsewhere
    const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return (h >>> 24) / 255; };
    const img = new ImageData(W, H), a = img.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, dx = x + 0.5 - C[0], dy = y + 0.5 - C[1];
        if (dx * dx + dy * dy <= 3600) { a[o] = 150 + 100 * hash(x >> 1, y >> 1); a[o + 1] = 120 + 80 * hash(x, y >> 1); a[o + 2] = 40; a[o + 3] = 255; }
        else if (x >= 695 && x < 705 && y >= 395 && y < 405) { a[o] = 30; a[o + 1] = 60; a[o + 2] = 220; a[o + 3] = 255; }
    }
    const D = ed.addLayer({ name: "Disc", kind: "paint", ref: null, px: ed.pixels.Layer.fromImageData(img), x: 0, y: 0, w: W, h: H, dirty: true });
    ed.activeLayerId = D.id; ed.renderLayers();
    ed.view.angle = 0; ed.view.scale = 0.5; ed._fitted = false; ed.view.x = 10; ed.view.y = 10; ed.draw();
    ed.setTool("liquify");
    await ed.mipsSettled();
    const fnv = (b) => { let h = 2166136261; for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619); return (h >>> 0).toString(16) + "/" + b.length; };
    const digest = (layer) => fnv(layer.px.readRect(0, 0, layer.px.width, layer.px.height).data);
    const top = () => (ed.undo[ed.undo.length - 1] || {}).label;
    let pid = 6100;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy, extra = {}) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: "mouse", pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy), extra));
    const send = (type, ix, iy, extra) => ed.canvas.dispatchEvent(ev(type, ix, iy, extra));
    const key = (k, o = {}) => ed.root.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, o)));
    // where the disc's edge lies left of C along its row (the first pixel under half alpha), and the marker's centroid
    const edgeLeft = () => { const r = D.px.readRect(0, C[1], C[0] + 1, 1).data; for (let x = C[0]; x >= 0; x--) if (r[x * 4 + 3] < 128) return x; return -1; };
    const marker = () => {
        const r = D.px.readRect(450, 200, 400, 400).data;
        let n = 0, sx = 0, sy = 0;
        for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) { const q = (y * 400 + x) * 4; if (r[q + 3] > 128 && r[q + 2] > 150 && r[q] < 100) { n++; sx += 450 + x + 0.5; sy += 200 + y + 0.5; } }
        return n ? [+(sx / n).toFixed(1), +(sy / n).toFixed(1), n] : null;
    };
    // a brush held at C: the press's dab, `ticks` timed dabs, the release
    const brush = async (mode, o = {}) => {
        ed.liquifyOpts = { mode, strength: 100 };
        ed.setBrushSize(o.size || 300); ed.hardness = o.hard != null ? o.hard : 0;
        const n = ed.undo.length;
        pid++;
        send("pointerdown", C[0], C[1], o.alt ? { altKey: true } : undefined);
        const p = ed.pointer, kind = p ? p.kind : null, pm = p ? p.mode : null;
        for (let t = 0; t < (o.ticks || 10); t++) ed.liquifyTick();
        send("pointerup", C[0], C[1]);
        if (ed.liquifyPending) await ed.liquifyPending;
        return { kind, mode: pm, steps: ed.undo.length - n, label: top(), edge: edgeLeft(), marker: marker() };
    };
    const d0 = digest(D), e0 = edgeLeft(), m0 = marker();
    if (e0 !== 539 || !m0 || m0[0] !== 700 || m0[1] !== 400) throw new Error("the test layer is not as drawn: " + JSON.stringify({ e0, m0 }));
    const undo = async (what) => { await ed.undoStep(); if (digest(D) !== d0) throw new Error("the undo of " + what + " did not give the layer back"); };
    const res = {};
    const expect = (name, r, mode, label, ok, why) => { res[name] = r; if (r.kind !== "liquify" || r.mode !== mode || r.steps !== 1 || r.label !== label || !ok(r)) throw new Error(name + ": " + why + ": " + JSON.stringify({ e0, m0, r })); };

    // 1. grow and shrink along the ray left of C; Alt reverses them
    expect("grow", await brush("grow"), "grow", "Liquify: grow", (r) => r.edge < e0 - 5, "the disc's edge did not move outwards");
    await undo("grow");
    expect("shrink", await brush("shrink"), "shrink", "Liquify: shrink", (r) => r.edge > e0 + 5, "the disc's edge did not move inwards");
    await undo("shrink");
    expect("growAlt", await brush("grow", { alt: true }), "shrink", "Liquify: shrink", (r) => r.edge > e0 + 5, "Alt did not turn grow into shrink");
    await undo("grow with Alt");
    expect("shrinkAlt", await brush("shrink", { alt: true }), "grow", "Liquify: grow", (r) => r.edge < e0 - 5, "Alt did not turn shrink into grow");
    await undo("shrink with Alt");

    // 2. swirl: clockwise on the screen (y down) takes the marker right of C down, counter-clockwise up; Alt reverses
    expect("swirlcw", await brush("swirlcw"), "swirlcw", "Liquify: swirl", (r) => r.marker && r.marker[1] > m0[1] + 5, "swirl clockwise did not turn the marker right of the centre downwards");
    await undo("swirl clockwise");
    expect("swirlccw", await brush("swirlccw"), "swirlccw", "Liquify: swirl", (r) => r.marker && r.marker[1] < m0[1] - 5, "swirl counter-clockwise did not turn the marker upwards");
    await undo("swirl counter-clockwise");
    expect("swirlcwAlt", await brush("swirlcw", { alt: true }), "swirlccw", "Liquify: swirl", (r) => r.marker && r.marker[1] < m0[1] - 5, "Alt did not reverse the swirl");
    await undo("swirl with Alt");
    out.brushes = res;

    // 3. restore: a grow, then the restore brush held over all of it brings the layer back to the byte (the field empty)
    const g3 = await brush("grow");
    const sourceIsStart = digest(D) !== d0 && ed.liq && digest({ px: ed.liq.orig }) === d0;
    const r3 = await brush("restore", { size: 400, hard: 0.8, ticks: 70 });
    out.restore = { grew: g3.edge, sourceIsStart, steps: r3.steps, label: r3.label, back: digest(D) === d0, empty: !!ed.liq && ed.liq.field.empty, edge: r3.edge };
    if (g3.steps !== 1 || !sourceIsStart || r3.kind !== "liquify" || r3.steps !== 1 || r3.label !== "Liquify: restore" || !out.restore.back || !out.restore.empty) throw new Error("the restore brush did not bring the grow back: " + JSON.stringify(out.restore));
    await ed.undoStep(); await ed.undoStep();
    if (digest(D) !== d0) throw new Error("the undo of the restore and the grow did not give the layer back");

    // 3b. a push there and back with a flat core wider than the layer (200 x 200 at (300, 200), a brush of 500 px at
    // hardness 0.8: every node at full weight, one 5 px step each way): every node goes back to exactly zero, the cell
    // that came back to zero is dropped at the landing (the field is empty again), the layer is its source, and Restore
    // all has nothing to restore (no empty step)
    const sq = new ImageData(200, 200);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) { const o = (y * 200 + x) * 4; sq.data[o] = 20 + x; sq.data[o + 1] = 30 + y; sq.data[o + 2] = 90 + 60 * hash(x, y); sq.data[o + 3] = 255; }
    const SQ = ed.addLayer({ name: "Square", kind: "paint", ref: null, px: ed.pixels.Layer.fromImageData(sq), x: 300, y: 200, w: 200, h: 200, dirty: true });
    ed.activeLayerId = SQ.id; ed.renderLayers();
    ed.liquifyOpts = { mode: "push", strength: 100 }; ed.setBrushSize(500); ed.hardness = 1;
    const s3b = digest(SQ), n3b = ed.undo.length;
    const push3b = async (x0, x1) => { pid++; send("pointerdown", x0, 300); send("pointermove", x1, 300); send("pointerup", x1, 300); if (ed.liquifyPending) await ed.liquifyPending; };
    await push3b(400, 405);
    const there = { steps: ed.undo.length - n3b, moved: digest(SQ) !== s3b, cells: ed.liq && ed.liq.layer === SQ ? ed.liq.field.cells.size : null };
    await push3b(400, 395);
    const back3b = { steps: ed.undo.length - n3b, label: top(), source: digest(SQ) === s3b, session: !!ed.liq && ed.liq.layer === SQ, empty: !!ed.liq && ed.liq.field.empty,
        zeroCells: ed.liq ? Array.from(ed.liq.field.cells.values()).filter((c) => c.every((v) => v === 0)).length : null };
    const nR3b = ed.undo.length;
    ed.liquifyRestoreAll();
    if (ed.liquifyPending) await ed.liquifyPending;
    back3b.restoreAll = { steps: ed.undo.length - nR3b, status: ed.status };
    out.thereAndBack = { there, back: back3b };
    if (there.steps !== 1 || !there.moved || there.cells !== 1) throw new Error("the push there did not land: " + JSON.stringify(out.thereAndBack));
    if (back3b.steps !== 2 || back3b.label !== "Liquify: push" || !back3b.source || !back3b.session || !back3b.empty || back3b.zeroCells || back3b.restoreAll.steps || !/Nothing to restore/.test(back3b.restoreAll.status)) throw new Error("a push there and back did not bring the field back to empty (a cell back at zero is dropped): " + JSON.stringify(out.thereAndBack));
    ed.removeLayer(SQ.id);
    ed.activeLayerId = D.id; ed.renderLayers();

    // 4. a hard selection: a push through it changes nothing outside it (beyond one grid step)
    await run("select_rect", { x: 560, y: 360, w: 80, h: 80, doc: d.id });
    ed.setTool("liquify");
    ed.liquifyOpts = { mode: "push", strength: 100 }; ed.setBrushSize(200); ed.hardness = 0.5;
    const n4 = ed.undo.length, b4 = D.px.readRect(0, 0, W, H).data.slice();
    pid++;
    send("pointerdown", 560, 400);
    for (let i = 1; i <= 10; i++) send("pointermove", 560 + 8 * i, 400);
    send("pointerup", 640, 400);
    if (ed.liquifyPending) await ed.liquifyPending;
    const a4 = D.px.readRect(0, 0, W, H).data;
    let inside = 0, outside = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const q = (y * W + x) * 4;
        if (a4[q] === b4[q] && a4[q + 1] === b4[q + 1] && a4[q + 2] === b4[q + 2] && a4[q + 3] === b4[q + 3]) continue;
        if (x >= 559 && x < 641 && y >= 359 && y < 441) inside++; else outside++;
    }
    out.selection = { steps: ed.undo.length - n4, label: top(), inside, outside };
    if (out.selection.steps !== 1 || out.selection.label !== "Liquify: push" || outside || inside < 200) throw new Error("the selection did not keep the push inside itself: " + JSON.stringify(out.selection));
    await ed.undoStep();
    if (digest(D) !== d0) throw new Error("the undo of the push in the selection did not give the layer back");
    await run("select_none", { doc: d.id });

    // 5. the refusals at the press: the status says why, no gesture, no step, no new layer, no session, nothing written
    ed.setTool("paint"); ed.setTool("liquify");
    if (ed.liq !== null) throw new Error("picking another tool did not end the session");
    ed.liquifyOpts = { mode: "push", strength: 100 }; ed.setBrushSize(100); ed.hardness = 0.5;
    const refuse = (what, re, layer) => {
        const n = ed.undo.length, nl = ed.layers.length, e = layer && layer.px ? digest(layer) : null;
        pid++;
        send("pointerdown", 600, 400);
        const pointer = ed.pointer ? ed.pointer.kind : null;
        send("pointermove", 640, 400); send("pointermove", 680, 400);
        send("pointerup", 680, 400);
        const r = { tool: ed.tool, status: ed.status, pointer, steps: ed.undo.length - n, layers: ed.layers.length - nl, session: ed.liq ? ed.liq.sid : null, same: e === null || digest(layer) === e };
        if (r.tool !== "liquify" || !re.test(r.status) || r.pointer || r.steps || r.layers || r.session !== null || !r.same) throw new Error(what + " did not refuse Liquify: " + JSON.stringify(r));
        return r.status;
    };
    const refused = {};
    ed.activeLayerId = D.id; ed.renderLayers();
    ed.quickMask = true;
    try { refused.quickMask = refuse("quick mask", /Quick mask is on/, D); } finally { ed.quickMask = false; }
    D.locked = true;
    try { refused.locked = refuse("a locked layer", /is locked/, D); } finally { D.locked = false; }
    D.alphaLock = true;
    try { refused.alphaLock = refuse("a layer with its transparency locked", /Liquify moves transparency too/, D); } finally { D.alphaLock = false; }
    const M0 = ed.addPaintLayer();
    ed.activeLayerId = M0.id; ed.renderLayers();
    await run("set_mask", { layer: M0.id, op: "hide", doc: d.id });
    const M = ed.layers.find((l) => l.id === M0.id);
    ed.setTool("liquify"); ed.activeLayerId = M.id; ed.renderLayers();
    M.maskEdit = true;
    try { refused.maskEdit = refuse("a mask being edited", /The mask of .+ is being edited/, M); } finally { M.maskEdit = false; }
    ed.removeLayer(M.id);
    await run("add_text", { doc: d.id, text: "Ab", x: 20, y: 20, size: 40 });
    const TL = ed.layers.find((l) => l.kind === "text");
    if (!TL) throw new Error("add_text made no text layer");
    ed.setTool("liquify"); ed.activeLayerId = TL.id; ed.renderLayers();
    refused.text = refuse("a text layer", /Text layers hold text/, null);
    ed.removeLayer(TL.id);
    const fx = await run("add_filter", { type: "grain", doc: d.id });
    const FL = ed.layers.find((l) => l.id === fx.id) || ed.layers.find((l) => l.kind === "filter");
    if (!FL) throw new Error("add_filter made no filter layer");
    ed.setTool("liquify"); ed.activeLayerId = FL.id; ed.renderLayers();
    refused.filter = refuse("a filter layer", /Filter layers have no pixels/, null);
    ed.removeLayer(FL.id);
    const S = ed.addLayer({ name: "S", kind: "paint", px: ed.pixels.Layer.empty(600, 400), x: 0, y: 0, w: W, h: H });
    ed.activeLayerId = S.id; ed.renderLayers();
    refused.scaled = refuse("a scaled layer", /scaled or placed between pixels/, S);
    ed.removeLayer(S.id);
    const F = ed.addLayer({ name: "F", kind: "paint", px: ed.pixels.Layer.empty(400, 400), x: 400.5, y: 200, w: 400, h: 400 });
    ed.activeLayerId = F.id; ed.renderLayers();
    refused.between = refuse("a layer placed between pixels", /scaled or placed between pixels/, F);
    ed.removeLayer(F.id);
    out.refused = Object.keys(refused);
    ed.activeLayerId = D.id; ed.renderLayers();

    // 6. the keys: Shift+W and Ctrl+Shift+X pick Liquify, W the wand; Ctrl+X still cuts the selection
    ed.setTool("paint");
    key("W", { shiftKey: true }); const k1 = ed.tool;
    key("w"); const k2 = ed.tool;
    key("X", { ctrlKey: true, shiftKey: true }); const k3 = ed.tool;
    await run("select_rect", { x: 560, y: 360, w: 80, h: 80, doc: d.id });
    ed.setTool("wand");
    ed.activeLayerId = D.id; ed.renderLayers();
    const dCut = digest(D);
    key("x", { ctrlKey: true });
    out.keys = { shiftW: k1, w: k2, ctrlShiftX: k3, ctrlX: ed.tool, cut: /^Cut /.test(ed.status), changed: digest(D) !== dCut };
    if (k1 !== "liquify" || k2 !== "wand" || k3 !== "liquify" || out.keys.ctrlX !== "wand" || !out.keys.cut || !out.keys.changed) throw new Error("the keys did not pick as stated: " + JSON.stringify(out.keys) + " " + ed.status);
} finally {
    IE.liquifyRateMs = keep.rate; IE.liquifySyncMax = keep.sync; ed.stabiliser = keep.stab;
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("liquify_freeze_holds_what_it_covers", """
// PLAN_0_1_31 section 5 step 5b: Liquify's freeze. Freeze paints what stays (on the base the press makes the copy
// "Liquify", one step, and the freeze stroke itself lands nothing); a push through a frozen band leaves its bytes as they
// were while the picture beside it moves; Alt thaws a part, which then moves; Restore all keeps what is frozen where it
// was moved to and brings back the rest; the freeze survives a tool switch; Invert freezes the rest (a push there lands
// nothing), Clear frees it all; the veil is drawn only with the tool and Show freeze; a new picture drops every freeze
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const IE = ed.constructor;
const keep = { rate: IE.liquifyRateMs, sync: IE.liquifySyncMax, stab: ed.stabiliser };
const W = 1200, H = 800;
const out = { tiles: !!ed.tileMode };
try {
    IE.liquifyRateMs = 0; IE.liquifySyncMax = 1e12; ed.stabiliser = 0;
    await run("new_canvas", { width: W, height: H, doc: d.id });
    // the picture: noise in both directions (any move shows), as the base
    const base = document.createElement("canvas"); base.width = W; base.height = H;
    {
        const img = new ImageData(W, H), a = img.data;
        const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return h >>> 24; };
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; a[o] = hash(x >> 2, y >> 2); a[o + 1] = hash(y >> 3, x >> 3); a[o + 2] = (x + y) & 255; a[o + 3] = 255; }
        base.getContext("2d").putImageData(img, 0, 0);
    }
    Object.defineProperty(base, "naturalWidth", { value: W }); Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "freeze_test.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    ed.activeLayerId = null; ed.renderLayers();
    ed.view.angle = 0; ed.view.scale = 0.5; ed._fitted = false; ed.view.x = 10; ed.view.y = 10; ed.draw();
    ed.setTool("liquify");
    await ed.mipsSettled();
    const fnv = (b) => { let h = 2166136261; for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619); return (h >>> 0).toString(16) + "/" + b.length; };
    const dig = (px, x, y, w, h) => fnv(px.readRect(x, y, w, h).data);
    const top = () => (ed.undo[ed.undo.length - 1] || {}).label;
    let pid = 6400;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy, extra = {}) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: "mouse", pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy), extra));
    const send = (type, ix, iy, extra) => ed.canvas.dispatchEvent(ev(type, ix, iy, extra));
    const drag = async (a, b, moves, alt = false) => {
        pid++;
        send("pointerdown", a[0], a[1], alt ? { altKey: true } : undefined);
        for (let i = 1; i <= moves; i++) send("pointermove", a[0] + (b[0] - a[0]) * i / moves, a[1] + (b[1] - a[1]) * i / moves);
        send("pointerup", b[0], b[1]);
        if (ed.liquifyPending) await ed.liquifyPending;
    };
    const mode = (m, size, hard) => { ed.liquifyOpts = { mode: m, strength: 100, showFreeze: true }; ed.setBrushSize(size); ed.hardness = hard; };
    const nodeAt = (fr, x, y) => { const sh = 8 - fr.ls, m = fr.n - 1, i = Math.round(x / fr.s), j = Math.round(y / fr.s); const c = fr.cells.get(((j >> sh) << 16) | (i >> sh)); return c ? c[(j & m) * fr.n + (i & m)] : 0; };

    // 1. a freeze band along y = 400 on the base: the copy, one step, and nothing else lands
    mode("freeze", 100, 0.8);
    const n0 = ed.undo.length;
    await drag([100, 400], [1100, 400], 50);
    const L = ed.activeLayer();
    const fr = L && ed.liquifyFreezeOf(L);
    out.made = { name: L && L.name, first: ed.layers[0] === L, steps: ed.undo.length - n0, label: top(), cells: fr ? fr.cells.size : 0, core: fr ? nodeAt(fr, 600, 400) : null, off: fr ? nodeAt(fr, 600, 200) : null };
    if (!L || L.name !== "Liquify" || ed.layers[0] !== L || out.made.steps !== 1 || out.made.label !== "Liquify: copy of the base" || !fr || !fr.cells.size || out.made.core !== 255 || out.made.off !== 0)
        throw new Error("a freeze on the base: " + JSON.stringify(out.made));
    const src = ed.basePx;
    if (dig(L.px, 0, 0, W, H) !== dig(src, 0, 0, W, H)) throw new Error("a freeze stroke changed the pixels");

    // 2. a push across the band: the band's core stays byte for byte, the picture above it moves
    const band = () => dig(L.px, 150, 375, 900, 50);
    const band0 = band(), above0 = dig(L.px, 420, 250, 360, 70);
    mode("push", 300, 0.5);
    const n1 = ed.undo.length;
    await drag([500, 300], [700, 500], 20);
    out.push = { steps: ed.undo.length - n1, label: top(), band: band() === band0, above: dig(L.px, 420, 250, 360, 70) !== above0 };
    if (out.push.steps !== 1 || out.push.label !== "Liquify: push" || !out.push.band || !out.push.above) throw new Error("a push across the frozen band: " + JSON.stringify(out.push));

    // 3. Alt in freeze thaws a part of the band (no step); a push there moves it, the rest of the band stays
    mode("freeze", 100, 0.8);
    const n2 = ed.undo.length;
    await drag([560, 400], [640, 400], 10, true);
    out.thaw = { steps: ed.undo.length - n2, at: nodeAt(fr, 600, 400), kept: nodeAt(fr, 300, 400) };
    if (out.thaw.steps !== 0 || out.thaw.at !== 0 || out.thaw.kept !== 255) throw new Error("Alt did not thaw: " + JSON.stringify(out.thaw));
    const thawed0 = dig(L.px, 585, 385, 30, 30), left0 = dig(L.px, 150, 375, 250, 50);
    mode("push", 200, 0.5);
    await drag([540, 400], [660, 400], 12);
    out.thawedMoves = { moved: dig(L.px, 585, 385, 30, 30) !== thawed0, left: dig(L.px, 150, 375, 250, 50) === left0 };
    if (!out.thawedMoves.moved || !out.thawedMoves.left) throw new Error("after the thaw: " + JSON.stringify(out.thawedMoves));

    // 4. freeze the moved part again, then Restore all: it keeps its move, the rest comes back to the source
    mode("freeze", 100, 0.8);
    await drag([560, 400], [640, 400], 10);
    const kept0 = dig(L.px, 585, 385, 30, 30);
    const n3 = ed.undo.length;
    ed.liquifyRestoreAll();
    if (ed.liquifyPending) await ed.liquifyPending;
    out.restoreAll = { steps: ed.undo.length - n3, label: top(), kept: dig(L.px, 585, 385, 30, 30) === kept0, moved: kept0 !== dig(src, 585, 385, 30, 30),
        back: dig(L.px, 420, 200, 360, 60) === dig(src, 420, 200, 360, 60) };
    if (out.restoreAll.steps !== 1 || out.restoreAll.label !== "Liquify: restore all" || !out.restoreAll.kept || !out.restoreAll.moved || !out.restoreAll.back)
        throw new Error("Restore all under a freeze: " + JSON.stringify(out.restoreAll));

    // 5. the freeze survives a tool switch (and a new session)
    const cells = fr.cells.size;
    ed.setTool("lasso"); ed.setTool("liquify");
    out.toolSwitch = { same: ed.liquifyFreezeOf(L) === fr, cells: fr.cells.size === cells };
    if (!out.toolSwitch.same || !out.toolSwitch.cells) throw new Error("a tool switch lost the freeze: " + JSON.stringify(out.toolSwitch));

    // 6. the veil: drawn with the tool and Show freeze, not without; one canvas at a node a pixel, red at half the freeze
    fr.drawn = 0; ed.draw();
    const shown = fr.drawn;
    fr.drawn = 0; ed.liquifyOpts.showFreeze = false; ed.draw();
    const hidden = fr.drawn;
    ed.liquifyOpts.showFreeze = true; ed.setTool("lasso"); fr.drawn = 0; ed.draw();
    const otherTool = fr.drawn;
    ed.setTool("liquify");
    const vx = Math.round(300 / fr.s / fr.k), vy = Math.round(400 / fr.s / fr.k);
    const vpix = fr.veil ? Array.from(fr.veil.getContext("2d").getImageData(vx, vy, 1, 1).data) : null;
    out.veil = { shown, hidden, otherTool, size: fr.veil ? [fr.veil.width, fr.veil.height] : null, at: vpix };
    if (!(shown > 0) || hidden !== 0 || otherTool !== 0 || !vpix || vpix[0] < 250 || Math.abs(vpix[3] - 127) > 1) throw new Error("the veil: " + JSON.stringify(out.veil));

    // 7. Invert freezes the rest: a push up there lands nothing; Clear frees it all and the same push lands
    ed.liquifyInvertFreeze();
    out.invert = { band: nodeAt(fr, 300, 400), rest: nodeAt(fr, 300, 150) };
    if (out.invert.band !== 0 || out.invert.rest !== 255) throw new Error("Invert freeze: " + JSON.stringify(out.invert));
    mode("push", 200, 0.5);
    const up0 = dig(L.px, 200, 80, 300, 140), n4 = ed.undo.length;
    await drag([250, 150], [400, 150], 10);
    out.frozenPush = { steps: ed.undo.length - n4, same: dig(L.px, 200, 80, 300, 140) === up0 };
    if (out.frozenPush.steps !== 0 || !out.frozenPush.same) throw new Error("a push over what is all frozen: " + JSON.stringify(out.frozenPush));
    ed.liquifyClearFreeze();
    const cleared = ed.liquifyFreezeOf(L);
    await drag([250, 150], [400, 150], 10);
    out.cleared = { none: !cleared || !cleared.cells.size, steps: ed.undo.length - n4, moved: dig(L.px, 200, 80, 300, 140) !== up0 };
    if (!out.cleared.none || out.cleared.steps !== 1 || !out.cleared.moved) throw new Error("Clear freeze: " + JSON.stringify(out.cleared));

    // 8. a thaw on the base's fresh copy froze nothing: the copy goes again, no step; a flip of the layer drops its freeze
    ed.activeLayerId = null; ed.renderLayers();
    mode("thaw", 100, 0.8);
    const nl = ed.layers.length, n5 = ed.undo.length;
    await drag([300, 600], [500, 600], 10);
    out.thawOnBase = { layers: ed.layers.length - nl, steps: ed.undo.length - n5 };
    if (out.thawOnBase.layers !== 0 || out.thawOnBase.steps !== 0) throw new Error("a thaw on the base: " + JSON.stringify(out.thawOnBase));
    ed.activeLayerId = L.id; ed.renderLayers();
    mode("freeze", 100, 0.8);
    await drag([300, 600], [500, 600], 10);
    const beforeFlip = !!(ed.liquifyFreezeOf(L) && ed.liquifyFreezeOf(L).cells.size);
    await run("flip_layer", { layer: L.id, axis: "x", doc: d.id });
    out.flip = { before: beforeFlip, after: !!ed.liquifyFreezeOf(L) };
    if (!out.flip.before || out.flip.after) throw new Error("a flip kept the freeze: " + JSON.stringify(out.flip));

    // 9. a new picture drops every freeze
    mode("freeze", 100, 0.8);
    await drag([300, 600], [500, 600], 10);
    const had = !!(ed.liquifyFreezeOf(L) && ed.liquifyFreezeOf(L).cells.size);
    await ed.setBase({ filename: "freeze_test2.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    out.newPicture = { had, after: ed.liqFreezes };
    if (!had || ed.liqFreezes !== null) throw new Error("a new picture kept a freeze: " + JSON.stringify({ had, after: !!ed.liqFreezes }));
} finally {
    IE.liquifyRateMs = keep.rate; IE.liquifySyncMax = keep.sync; ed.stabiliser = keep.stab;
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("the_smudge_carries_paint_as_far_as_its_length", """
// PLAN_0_1_31 §4 step 3: the smudge's carry (the smudge_dab kernel). Length keeps the paint going, finger painting
// starts from the paint colour, alpha lock keeps the alpha, Sample "below" leaves the layers above out; the kernel and
// its JS twin give the same bytes in the app; the undo gives the layer back. Real handlers, synthetic pointer events
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const W = 1600, H = 900;
const out = { tiles: !!ed.tileMode };
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const K = ed.constructor.kernels;
try {
    await run("new_canvas", { width: W, height: H, doc: d.id });
    const base = mk(W, H);
    { const x = base.getContext("2d"); x.fillStyle = "#2040e0"; x.fillRect(0, 0, W, H); x.fillStyle = "#e02020"; x.fillRect(0, 0, 400, H); }
    Object.defineProperty(base, "naturalWidth", { value: W }); Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "smudge_carry_test.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    // the target: red on its left 400 px, blue to the right, opaque
    const lc = mk(W, H);
    { const x = lc.getContext("2d"); x.fillStyle = "#2040e0"; x.fillRect(0, 0, W, H); x.fillStyle = "#e02020"; x.fillRect(0, 0, 400, H); }
    const L = ed.addLayer({ name: "T", kind: "paint", px: ed.pixels.Layer.fromCanvas(lc), x: 0, y: 0, w: W, h: H, dirty: true });
    ed.renderLayers(); ed.draw();
    ed.view.angle = 0; ed.view.scale = 0.5; ed._fitted = false; ed.view.x = 10; ed.view.y = 10; ed.draw();
    let pid = 900;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: "mouse", pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
    const send = (type, ix, iy) => ed.canvas.dispatchEvent(ev(type, ix, iy));
    const stroke = (y, x0 = 300, x1 = 1300) => { pid++; send("pointerdown", x0, y); for (let i = 1; i <= 20; i++) send("pointermove", x0 + (x1 - x0) * i / 20, y); send("pointerup", x1, y); };
    // how far red went: the last x on the row where red still beats blue
    const reach = (l, y) => { const row = l.px.readRect(0, y, W, 1).data; let last = 0; for (let x = 0; x < W; x++) if (row[x * 4 + 3] > 0 && row[x * 4] > row[x * 4 + 2] + 30) last = x; return last; };
    ed.activeLayerId = L.id; ed.renderLayers();
    ed.setTool("smudge");
    ed.brushSize = 60; ed.hardness = 0.6;
    Object.assign(ed.smudgeOpts, { strength: 80, length: 0, sample: "layer", finger: false });
    const before = L.px.readRect(0, 0, W, H).data.slice();
    stroke(150);
    Object.assign(ed.smudgeOpts, { length: 90 });
    stroke(350);
    out.reach = [reach(L, 150), reach(L, 350)];
    if (!(out.reach[0] > 420)) throw new Error("the smudge did not drag the red: it reaches " + out.reach[0]);
    if (!(out.reach[1] > out.reach[0] + 150)) throw new Error("Length 90 does not carry the paint further than 0: " + out.reach);
    // the undo steps give the layer back byte for byte
    await ed.undoStep(); await ed.undoStep();
    const back = L.px.readRect(0, 0, W, H).data;
    let diff = 0; for (let i = 0; i < back.length; i++) if (back[i] !== before[i]) diff++;
    if (diff) throw new Error("two undos left " + diff + " bytes changed");
    // finger painting: the stroke starts with the paint colour (green) on blue, where there is no green to drag
    Object.assign(ed.smudgeOpts, { length: 50, finger: true });
    ed.color = "#20e040";
    stroke(550, 700, 1100);
    const g = Array.from(L.px.readRect(760, 550, 1, 1).data);
    out.finger = g;
    if (!(g[1] > g[2] && g[1] > g[0])) throw new Error("finger painting laid down no paint colour: " + g);
    Object.assign(ed.smudgeOpts, { finger: false, length: 0 });
    // Sample "below": a green layer above the target is left out, "image" takes it
    const uc = mk(W, H); { const x = uc.getContext("2d"); x.fillStyle = "#20e040"; x.fillRect(0, 700, 400, 200); }
    const U = ed.addLayer({ name: "U", kind: "paint", px: ed.pixels.Layer.fromCanvas(uc), x: 0, y: 0, w: W, h: H, dirty: true });
    ed.activeLayerId = L.id; ed.renderLayers();
    Object.assign(ed.smudgeOpts, { sample: "below" });
    stroke(760, 300, 700);
    const below = Array.from(L.px.readRect(460, 760, 1, 1).data);
    Object.assign(ed.smudgeOpts, { sample: "image" });
    stroke(860, 300, 700);
    const image = Array.from(L.px.readRect(460, 860, 1, 1).data);
    out.sample = { below, image };
    if (!(below[0] > below[1])) throw new Error("Sample below took the layer above: " + below);
    if (!(image[1] > image[0])) throw new Error("Sample image left the layer above out: " + image);
    ed.removeLayer(U.id); ed.renderLayers();
    // alpha lock: red dragged over a transparent hole stays out of it
    Object.assign(ed.smudgeOpts, { sample: "layer" });
    L.px.clear([600, 0, 800, 120]); ed.markLayerChanged(L);
    L.alphaLock = true;
    stroke(60, 300, 1000);
    L.alphaLock = false;
    const hole = L.px.readRect(700, 60, 1, 1).data[3];
    if (hole !== 0) throw new Error("alpha lock let the smudge into a transparent hole: alpha " + hole);
    // the kernel and its twin: the same stroke from the same bytes, Rust and JS
    const snap = L.px.readRect(0, 0, W, H);
    const once = async (mode) => {
        L.px.writeRect(snap, 0, 0); ed.markLayerChanged(L);
        ed.constructor.kernels = mode;
        Object.assign(ed.smudgeOpts, { length: 60, strength: 70 });
        stroke(450, 250, 1250);
        return L.px.readRect(0, 0, W, H).data.slice();
    };
    const a = await once("rust"), b = await once("js");
    let twin = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) twin++;
    out.twinDiff = twin;
    if (twin) throw new Error("the Rust kernel and its JS twin smudged " + twin + " bytes apart");
} finally {
    ed.constructor.kernels = K;
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("package_4_review_fixes_hold", """
// three fixes of the four-lens review of 2026-09-27 (docs/PLAN_0_1_31.md §4): a font set by name takes its own file (a
// stale fontRef drew the old file), the base peek started with AltGr+ss ends when AltGr comes up first, and the smudge on
// the base leaves Sample on the picture for the strokes after it
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = {};
try {
    await run("new_canvas", { width: 400, height: 300, doc: d.id });
    // 1. set_text with a font by name: the old file goes
    const t = await run("add_text", { doc: d.id, text: "Ab", x: 20, y: 20, size: 40 });
    const L = ed.layers.find((l) => l.kind === "text");
    L.text.font = "Stale"; L.text.fontRef = { filename: "Stale (1).ttf", subfolder: "inpaint_canvas/fonts", type: "input" };
    await run("set_text", { doc: d.id, layer: L.id, font: "Stale" });   // the same name: its file stays
    if (!L.text.fontRef || L.text.fontRef.filename !== "Stale (1).ttf") throw new Error("set_text with the same font dropped its file");
    await run("set_text", { doc: d.id, layer: L.id, font: "Roboto" });
    out.fontRef = L.text.fontRef;
    if (L.text.font !== "Roboto" || (L.text.fontRef && L.text.fontRef.filename === "Stale (1).ttf")) throw new Error("set_text kept the stale font file: " + JSON.stringify(L.text));
    // 2. the peek: AltGr+ss types a backslash; its keyup after AltGr went up reports the ss key's code, not "\\\\"
    ed.onKey(new KeyboardEvent("keydown", { key: "\\\\", code: "Minus", ctrlKey: true, altKey: true, modifierAltGraph: true, bubbles: true, cancelable: true }));
    if (!ed.peekBase) throw new Error("AltGr+ss did not start the peek");
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "\\u00df", code: "Minus", bubbles: true }));
    out.peekAfter = ed.peekBase;
    if (ed.peekBase) throw new Error("the peek stayed on after the key came up without AltGr");
    // 3. a smudge on the base: a new layer, and Sample on the picture from then on
    ed.activeLayerId = null; ed.renderLayers();
    ed.setTool("smudge");
    ed.smudgeOpts.sample = "layer";
    if (ed.smudgeSampleSel) ed.smudgeSampleSel.value = "layer";
    ed.fitView(); ed.draw();
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 1300, isPrimary: true, pointerType: "mouse", pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
    ed.canvas.dispatchEvent(ev("pointerdown", 100, 150)); ed.canvas.dispatchEvent(ev("pointermove", 200, 150)); ed.canvas.dispatchEvent(ev("pointerup", 200, 150));
    out.sample = [ed.smudgeOpts.sample, ed.smudgeSampleSel && ed.smudgeSampleSel.value];
    if (ed.smudgeOpts.sample !== "image" || (ed.smudgeSampleSel && ed.smudgeSampleSel.value !== "image")) throw new Error("after the smudge on the base Sample is " + out.sample);
} finally { await run("close_document", { doc: d.id, force: true }); }
return out;
"""),
    ("clone_source_turns_scales_and_flips", """
// PLAN_0_1_31 §4 step 4: the clone source turned, scaled and mirrored where it lands, an imported tip as the dab, and the
// overlay under the brush. A source of four coloured quarters around S; one dab at D, read back at points off its centre
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const W = 1200, H = 800;
const out = { tiles: !!ed.tileMode };
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const opts0 = { ...ed.cloneOpts }, tips0 = ed.brushTips.slice(), tip0 = ed.brushTipId;
try {
    await run("new_canvas", { width: W, height: H, doc: d.id });
    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        x.fillStyle = "#808080"; x.fillRect(0, 0, W, H);
        x.fillStyle = "#e02020"; x.fillRect(200, 300, 100, 100);   // around S = (300, 400): red top left,
        x.fillStyle = "#20c040"; x.fillRect(300, 300, 100, 100);   // green top right,
        x.fillStyle = "#2040e0"; x.fillRect(200, 400, 100, 100);   // blue bottom left,
        x.fillStyle = "#e0e020"; x.fillRect(300, 400, 100, 100);   // yellow bottom right
    }
    Object.defineProperty(base, "naturalWidth", { value: W }); Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "clone_xf_test.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    const L = ed.addPaintLayer();
    ed.activeLayerId = L.id; ed.renderLayers();
    ed.fitView(); ed.draw();
    let pid = 1100;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy, extra = {}) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: "mouse", pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy), extra));
    const send = (type, ix, iy, extra) => ed.canvas.dispatchEvent(ev(type, ix, iy, extra));
    ed.setTool("clone");
    ed.brushSize = 300; ed.hardness = 1; ed.brushOpacity = 1; ed.brushTipId = "";
    send("pointerdown", 300, 400, { altKey: true }); send("pointerup", 300, 400);
    if (!ed.cloneSource) throw new Error("Alt+click set no source");
    const S = { ...ed.cloneSource };
    // one dab at D = (800, 400): lined up there (Aligned off), so the dab's centre copies S
    const dab = async (opts) => {
        Object.assign(ed.cloneOpts, { sample: "image", aligned: false, angle: 0, scale: 100, flipX: false, flipY: false }, opts);
        pid++;
        send("pointerdown", 800, 400); send("pointerup", 800, 400);
    };
    const at = (x, y) => Array.from(L.px.readRect(x, y, 1, 1).data);
    const is = (p, hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return p[3] > 200 && c.every((v, i) => Math.abs(v - p[i]) <= 12); };
    const cases = [
        ["plain", {}, [[750, 350, "#e02020"], [850, 450, "#e0e020"], [750, 450, "#2040e0"]]],
        ["flip H", { flipX: true }, [[750, 350, "#20c040"], [850, 450, "#2040e0"]]],
        ["flip V", { flipY: true }, [[750, 350, "#2040e0"], [850, 350, "#e0e020"]]],
        ["turned 90", { angle: 90 }, [[750, 350, "#2040e0"], [850, 350, "#e02020"]]],
        ["scaled 200", { scale: 200 }, [[680, 380, "#e02020"], [920, 420, "#e0e020"]]],
    ];
    out.cases = {};
    for (const [name, o, probes] of cases) {
        await dab(o);
        const got = probes.map(([x, y, hex]) => [at(x, y), hex]);
        out.cases[name] = got.map(([p]) => p.slice(0, 3).join(","));
        const bad = got.filter(([p, hex]) => !is(p, hex));
        if (bad.length) throw new Error(name + ": " + JSON.stringify(bad) + " (S " + JSON.stringify(S) + ")");
        await ed.undoStep();
    }
    // without the scale, the point that took red at 200 % lies outside the quarters: grey
    await dab({});
    if (!is(at(680, 380), "#808080")) throw new Error("the plain dab at 680,380 is " + at(680, 380) + ", not the grey outside the source");
    await ed.undoStep();
    // an imported square tip: its corner lies outside the round dab
    const sq = mk(64, 64); sq.getContext("2d").fillRect(0, 0, 64, 64);
    ed.brushTips.push({ id: "clone-square", name: "square", canvas: sq, spacing: 0.25 });
    ed.brushTipId = "clone-square";
    await dab({});
    const corner = at(660, 260);
    ed.brushTipId = "";
    await ed.undoStep();
    await dab({});
    const roundCorner = at(660, 260);
    await ed.undoStep();
    out.tip = { square: corner[3], round: roundCorner[3] };
    if (!(corner[3] > 200) || roundCorner[3] !== 0) throw new Error("the square tip did not shape the dab: " + JSON.stringify(out.tip));
    // the overlay: at the brush, half of what it would copy (red at 750,350 over grey), and nothing with it off
    ed.fitView(); await ed.mipsSettled();
    ed.hover = [800, 400];
    const screen = () => { ed.sceneSig = null; ed.draw(); const [sx, sy] = ed.imageToScreen(750, 350); return Array.from(ed.canvas.getContext("2d").getImageData(Math.round(sx), Math.round(sy), 1, 1).data); };
    Object.assign(ed.cloneOpts, { overlay: true, aligned: false, angle: 0, scale: 100, flipX: false, flipY: false });
    const on = screen();
    ed.cloneOpts.overlay = false;
    const off = screen();
    ed.hover = null;
    out.overlay = { on, off };
    if (!(on[0] - off[0] > 30 && off[0] - on[1] > 10)) throw new Error("the overlay does not show the source's red under the brush: " + JSON.stringify(out.overlay));
} finally {
    ed.cloneOpts = opts0; ed.brushTips.splice(0, ed.brushTips.length, ...tips0); ed.brushTipId = tip0;
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("brush_flow_pressure_coalesced_and_stabiliser", """
// PLAN_0_1_31 §4 step 5 through the real handlers: flow below 100 % builds up where a stroke passes again, every coalesced
// point of a move is painted, the pressure curve sizes a pen's brush, the stabiliser holds the brush on its string and
// the release finishes the line to the cursor
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = { tiles: !!ed.tileMode };
const keep = { flow: ed.brushFlow, curve: ed.pressureCurve, stab: ed.stabiliser, size: ed.brushSize, hard: ed.hardness };
try {
    await run("new_canvas", { width: 800, height: 520, doc: d.id });
    const L = ed.addPaintLayer();
    ed.activeLayerId = L.id; ed.renderLayers();
    ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false; ed.view.x = 20; ed.view.y = 20; ed.draw();
    ed.setTool("paint");
    ed.color = "#d02020"; ed.brushOpacity = 1; ed.brushTipId = ""; ed.hardness = 1;
    let pid = 1500;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const init = (type, ix, iy, o = {}) => Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: o.pen ? "pen" : "mouse", pressure: type === "pointerup" ? 0 : (o.pen || 0.5), button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy));
    const send = (type, ix, iy, o = {}) => { const ev = new PointerEvent(type, Object.assign(init(type, ix, iy, o), o.coalesced ? { coalescedEvents: o.coalesced.map(([x, y]) => new PointerEvent("pointermove", init("pointermove", x, y, o))) } : {})); ed.canvas.dispatchEvent(ev); return ev; };
    const stroke = (pts, o = {}) => { pid++; send("pointerdown", pts[0][0], pts[0][1], o); for (const [x, y] of pts.slice(1)) send("pointermove", x, y, o); const [ex, ey] = pts[pts.length - 1]; send("pointerup", ex, ey, o); };
    const line = (x0, x1, y, n = 12) => Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y]);
    const alpha = (x, y) => L.px.readRect(x, y, 1, 1).data[3];
    // 1. flow: 100 % covers, 30 % builds up to less, and more where the stroke comes back
    ed.brushSize = 40;
    ed.brushFlow = 1; stroke(line(100, 700, 60));
    ed.brushFlow = 0.3; stroke(line(100, 700, 140));
    stroke(line(100, 700, 220).concat(line(700, 100, 220)));
    ed.brushFlow = 1;
    out.flow = { full: alpha(400, 60), low: alpha(400, 140), twice: alpha(400, 220) };
    if (out.flow.full !== 255) throw new Error("flow 100 % did not cover: " + JSON.stringify(out.flow));
    if (!(out.flow.low > 60 && out.flow.low < 240)) throw new Error("flow 30 % covered " + out.flow.low + " of 255");
    if (!(out.flow.twice > out.flow.low + 10)) throw new Error("the stroke that came back did not build up: " + JSON.stringify(out.flow));
    // 2. coalesced points: a move to (700, 300) that passed through (400, 380) paints there, not on the straight line
    pid++;
    send("pointerdown", 100, 300);
    const ev = send("pointermove", 700, 300, { coalesced: [[400, 380], [700, 300]] });
    out.coalescedGiven = ev.getCoalescedEvents().length;
    send("pointerup", 700, 300);
    if (out.coalescedGiven !== 2) throw new Error("this Chromium does not take coalescedEvents in PointerEventInit: " + out.coalescedGiven);
    out.coalesced = { via: alpha(400, 380), straight: alpha(400, 300) };
    if (!(out.coalesced.via > 200) || out.coalesced.straight !== 0) throw new Error("the coalesced point was not painted: " + JSON.stringify(out.coalesced));
    // 3. the pressure curve: a pen at half pressure, 80 px, linear against hard
    const width = (x) => { const col = L.px.readRect(x, 400, 1, 100).data; let n = 0; for (let i = 3; i < col.length; i += 4) if (col[i] > 127) n++; return n; };
    ed.brushSize = 80;
    ed.pressureCurve = "linear"; stroke(line(100, 300, 450), { pen: 0.5 });
    ed.pressureCurve = "hard"; stroke(line(450, 650, 450), { pen: 0.5 });
    out.pressure = { linear: width(200), hard: width(550) };
    if (!(out.pressure.linear >= 34 && out.pressure.linear <= 46 && out.pressure.hard >= 15 && out.pressure.hard <= 26)) throw new Error("the pressure curve does not size the brush: " + JSON.stringify(out.pressure));
    ed.pressureCurve = "linear";
    // 4. the stabiliser: 30 screen px of string; a move of 20 image px paints nothing past the press, the release does
    ed.brushSize = 10; ed.stabiliser = 30;
    pid++;
    send("pointerdown", 500, 505);
    send("pointermove", 520, 505);
    const held = { stab: !!(ed.pointer && ed.pointer.stab), at: alpha(518, 505) };
    send("pointerup", 520, 505);
    out.stabiliser = { ...held, after: alpha(518, 505) };
    if (!held.stab || held.at !== 0) throw new Error("the stabiliser did not hold the brush on its string: " + JSON.stringify(out.stabiliser));
    if (!(out.stabiliser.after > 200)) throw new Error("the release did not finish the line to the cursor: " + JSON.stringify(out.stabiliser));
} finally {
    ed.brushFlow = keep.flow; ed.pressureCurve = keep.curve; ed.stabiliser = keep.stab; ed.brushSize = keep.size; ed.hardness = keep.hard;
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("a_move_of_coalesced_points_is_one_box_and_one_run_of_dabs", """
// docs/BUGS.md, the eraser of 0.1.32 (fixed for 0.1.33): the coalesced points of a move go into one box of the stroke
// buffer and one run of dabs spaced along the whole path, as one segment was before 0.1.32. A straight move of 8
// coalesced points writes the bytes the same move of one point writes (the eraser soft, with a tip, hard and at flow
// 30 %, the soft paint brush, clone and heal), every move is one draw of the buffer, and a pen's pressure still sizes
// each segment inside a move
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = { tiles: !!ed.tileMode, cases: {} };
const keep = { size: ed.brushSize, eh: ed.eraseHardness, hard: ed.hardness, tip: ed.brushTipId, flow: ed.brushFlow, stab: ed.stabiliser, curve: ed.pressureCurve, rot: ed.tipRotate, color: ed.color };
const tips0 = ed.brushTips.slice();
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
try {
    await run("new_canvas", { width: 900, height: 700, doc: d.id });
    ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false; ed.view.x = 10; ed.view.y = 10; ed.draw();
    ed.stabiliser = 0; ed.pressureCurve = "linear"; ed.tipRotate = false; ed.brushOpacity = 1;
    // an opaque layer with a texture that changes along y, so a clone from 200 px above changes what it covers
    const filled = (name) => {
        const c = mk(900, 700), x = c.getContext("2d");
        const g = x.createLinearGradient(0, 0, 900, 700);
        g.addColorStop(0, "#3070c0"); g.addColorStop(1, "#c07030");
        x.fillStyle = g; x.fillRect(0, 0, 900, 700);
        x.fillStyle = "rgba(255,255,255,0.35)";
        for (let y = 0; y < 700; y += 37) x.fillRect(0, y, 900, 13);
        return ed.addLayer({ name, kind: "paint", px: ed.pixels.Layer.fromCanvas(c), x: 0, y: 0, w: 900, h: 700, dirty: true });
    };
    let pid = 2600;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const init = (type, ix, iy, pen, extra = {}) => Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: pen ? "pen" : "mouse", pressure: type === "pointerup" ? 0 : (pen || 0.5), button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy), extra);
    // co: the move's coalesced points [x, y, pen pressure or 0]
    const send = (type, ix, iy, pen, co, extra) => ed.canvas.dispatchEvent(new PointerEvent(type, Object.assign(init(type, ix, iy, pen, extra), co ? { coalescedEvents: co.map(([x, y, pp]) => new PointerEvent("pointermove", init("pointermove", x, y, pp))) } : {})));
    // a stroke through pts, k coalesced points per move evenly from the last point; the buffer draws of every move
    const stroke = (pts, k, pen = 0) => {
        pid++;
        send("pointerdown", pts[0][0], pts[0][1], pen);
        const draws = [];
        for (let i = 1; i < pts.length; i++) {
            const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
            const co = k > 1 ? Array.from({ length: k }, (_, j) => [ax + (bx - ax) * (j + 1) / k, ay + (by - ay) * (j + 1) / k, pen]) : null;
            const s = ed.pointer.stroke, d0 = s.draw;
            let n = 0;
            s.draw = function (...a) { n++; return d0.apply(this, a); };
            try { send("pointermove", bx, by, pen, co); } finally { delete s.draw; }
            draws.push(n);
        }
        const [ex, ey] = pts[pts.length - 1];
        send("pointerup", ex, ey, pen);
        return draws;
    };
    // moves of 40 px: with a 300 px brush the soft dab's spacing is 27 px, so 40 / 27 is far from a whole number of steps
    const line = Array.from({ length: 11 }, (_, i) => [150 + 40 * i, 350]);
    // alpha apart, and the colour where both pixels keep at least 32 of alpha (below it the stored colour is rounding)
    const compare = (a, b, orig) => {
        const x = a.px.readRect(0, 0, 900, 700).data, y = b.px.readRect(0, 0, 900, 700).data;
        let differ = 0, alphaDiffer = 0, alphaMax = 0, inner = 0, touched = 0;
        // no pixel within 2 of this one is partly erased in a: it lies inside the stroke or outside it, not on its edge
        const solid = (p) => {
            const px = p % 900, py = (p - px) / 900;
            for (let yy = Math.max(0, py - 2); yy <= Math.min(699, py + 2); yy++) for (let xx = Math.max(0, px - 2); xx <= Math.min(899, px + 2); xx++) {
                const al = x[(yy * 900 + xx) * 4 + 3];
                if (al > 0 && al < 255) return false;
            }
            return true;
        };
        for (let i = 0; i < x.length; i += 4) {
            if (x[i] !== orig[i] || x[i + 1] !== orig[i + 1] || x[i + 2] !== orig[i + 2] || x[i + 3] !== orig[i + 3]) touched++;
            if (x[i] === y[i] && x[i + 1] === y[i + 1] && x[i + 2] === y[i + 2] && x[i + 3] === y[i + 3]) continue;
            differ++;
            const e = Math.abs(x[i + 3] - y[i + 3]);
            if (e) { alphaDiffer++; if (e > alphaMax) alphaMax = e; }
            if (solid(i / 4) && (e || Math.min(x[i + 3], y[i + 3]) > 0)) inner++;
        }
        return { differ, alphaDiffer, alphaMax, inner, touched };
    };
    // the dabs land on the same places, so the bytes are the same. A hard brush draws one line through the move where it
    // drew a line per point: the shape is the same, and only its antialiased outline moves, most on the round ends (the
    // end nudged by 0.01 px, which makes a lone press a dot, turns a short last piece a little more than a long one)
    // clone and heal: Alt+click sets the source 200 px above the press, not aligned, the layer's own pixels sampled
    const source = () => { pid++; send("pointerdown", 150, 150, 0, null, { altKey: true }); send("pointerup", 150, 150, 0); };
    const pair = async (name, setup, tool = "erase", line_ = false, path = line) => {
        setup();
        ed.setTool(tool);
        const A = filled(name + " one"), B = filled(name + " coalesced");
        // both read before the strokes: on canvases a readback can move a canvas off the GPU, and the two then round apart
        const orig = A.px.readRect(0, 0, 900, 700).data.slice();
        B.px.readRect(0, 0, 900, 700);
        const one = [], co = [];
        for (const [L, k, draws] of [[A, 1, one], [B, 8, co]]) {
            ed.activeLayerId = L.id; ed.renderLayers();
            if (tool === "clone" || tool === "heal") source();
            ed._tipAngle = 0;   // "Follow stroke" starts both strokes level
            draws.push(...stroke(path, k));
            if (ed.healPending) await ed.healPending;   // a heal blends at the release, a large one in a worker
        }
        const r = compare(A, B, orig);
        out.cases[name] = { ...r, drawsOne: Math.max(...one), drawsCoalesced: Math.max(...co) };
        if (!(r.touched > 20000)) throw new Error(name + ": the stroke changed too little: " + JSON.stringify(out.cases[name]));
        if (co.some((n) => n !== 1)) throw new Error(name + ": a move of 8 coalesced points drew the buffer " + JSON.stringify(co) + " times, not once");
        const same = line_ ? r.inner === 0 && r.alphaDiffer < r.touched / 100 : r.differ === 0;
        if (!same) throw new Error(name + ": 8 coalesced points on the line erased other bytes than one point: " + JSON.stringify(out.cases[name]));
        ed.removeLayer(A.id); ed.removeLayer(B.id); ed.renderLayers();
    };
    ed.brushSize = 300;
    await pair("soft", () => { ed.eraseHardness = 0.5; ed.brushTipId = ""; ed.brushFlow = 1; });
    const sq = mk(64, 64); sq.getContext("2d").fillRect(8, 8, 48, 48);
    ed.brushTips.push({ id: "coalesced-square", name: "square", canvas: sq, spacing: 0.2 });
    await pair("tip", () => { ed.eraseHardness = 0.5; ed.brushTipId = "coalesced-square"; ed.brushFlow = 1; });
    // "Follow stroke" on a slow diagonal: moves of 3.2 px, 0.4 px a coalesced point. The tip turns by the move's direction
    // either way (0.1.32 took it from each point's piece, and pieces under 0.5 px never turned it: the square stayed level)
    const slow = Array.from({ length: 21 }, (_, i) => [300 + 2.263 * i, 300 + 2.263 * i]);
    try {
        await pair("follow", () => { ed.eraseHardness = 0.5; ed.brushTipId = "coalesced-square"; ed.brushFlow = 1; ed.tipRotate = true; }, "erase", false, slow);
        await pair("follow flow", () => { ed.eraseHardness = 0.5; ed.brushTipId = "coalesced-square"; ed.brushFlow = 0.5; ed.tipRotate = true; }, "erase", false, slow);
    } finally { ed.tipRotate = false; }
    await pair("hard", () => { ed.eraseHardness = 1; ed.brushTipId = ""; ed.brushFlow = 1; }, "erase", true);
    await pair("flow", () => { ed.eraseHardness = 0.5; ed.brushTipId = ""; ed.brushFlow = 0.3; });
    await pair("paint", () => { ed.hardness = 0.5; ed.brushTipId = ""; ed.brushFlow = 1; ed.color = "#e0a020"; }, "paint");
    // clone and heal space their dabs at a quarter of the radius, 37.5 px here: 40 / 37.5 is two steps a move either way
    const cloneOpts0 = ed.cloneOpts;
    try {
        ed.cloneOpts = { sample: "layer", aligned: false };
        await pair("clone", () => { ed.hardness = 0.5; ed.brushTipId = ""; ed.brushFlow = 1; }, "clone");
        await pair("heal", () => { ed.hardness = 0.5; ed.brushTipId = ""; ed.brushFlow = 1; }, "heal");
    } finally { ed.cloneOpts = cloneOpts0; ed.cloneSource = null; }
    // a pen's pressure rising within one move: the segments near its start erase narrower than those near its end
    ed.eraseHardness = 1; ed.brushTipId = ""; ed.brushFlow = 1;
    ed.setTool("erase");
    const P = filled("pen");
    ed.activeLayerId = P.id; ed.renderLayers();
    pid++;
    send("pointerdown", 150, 350, 0.3);
    const co = Array.from({ length: 8 }, (_, j) => [150 + 400 * (j + 1) / 8, 350, 0.3 + 0.7 * (j + 1) / 8]);
    const s = ed.pointer.stroke, d0 = s.draw;
    let n = 0;
    s.draw = function (...a) { n++; return d0.apply(this, a); };
    try { send("pointermove", 550, 350, 1, co); } finally { delete s.draw; }
    send("pointerup", 550, 350, 1);
    const width = (x) => { const col = P.px.readRect(x, 150, 1, 400).data; let w = 0; for (let i = 3; i < col.length; i += 4) if (col[i] < 128) w++; return w; };
    out.pen = { draws: n, start: width(190), end: width(540) };
    if (n !== 1) throw new Error("the pen's move drew the buffer " + n + " times, not once");
    // at 190 the first segment is 116 px wide and the round cap of the second (142 px) reaches over it; at 540 the last is 300
    if (!(out.pen.start >= 100 && out.pen.start <= 150 && out.pen.end >= 280 && out.pen.end <= 310)) throw new Error("the pressure did not size the segments of the move: " + JSON.stringify(out.pen));
    // the soft dabs of that move are spaced by each segment's own radius: radii 32 to 150 px give about 31 steps of 0.18
    // of the radius over the 400 px (33 dabs), where the smallest radius's spacing all along would give 71
    ed.eraseHardness = 0.5;
    pid++;
    send("pointerdown", 150, 550, 0.1);
    const ramp = Array.from({ length: 8 }, (_, j) => [150 + 400 * (j + 1) / 8, 550, 0.1 + 0.9 * (j + 1) / 8]);
    const protos = [CanvasRenderingContext2D.prototype, typeof OffscreenCanvasRenderingContext2D === "undefined" ? null : OffscreenCanvasRenderingContext2D.prototype].filter(Boolean);
    const arcs0 = protos.map((pr) => pr.arc);
    let arcs = 0;
    protos.forEach((pr, i) => { pr.arc = function (...a) { if (this.canvas !== ed.canvas) arcs++; return arcs0[i].apply(this, a); }; });
    try { send("pointermove", 550, 550, 1, ramp); } finally { protos.forEach((pr, i) => { pr.arc = arcs0[i]; }); }
    send("pointerup", 550, 550, 1);
    out.pen.softDabs = arcs;
    if (!(arcs >= 28 && arcs <= 36)) throw new Error("the soft dabs of a move whose pressure rises are not spaced by their own radius: " + arcs + " (about 33; 71 at the smallest's spacing)");
} finally {
    ed.brushSize = keep.size; ed.eraseHardness = keep.eh; ed.hardness = keep.hard; ed.brushFlow = keep.flow; ed.stabiliser = keep.stab;
    ed.pressureCurve = keep.curve; ed.tipRotate = keep.rot; ed.color = keep.color;
    ed.brushTips.splice(0, ed.brushTips.length, ...tips0); ed.brushTipId = keep.tip;
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("blur_and_sharpen_modes_soften_and_crisp_an_edge", """
// PLAN_0_1_31 §4 step 6: the smudge tool's Blur and Sharpen modes through the real handlers. A hard black / white edge
// gets a ramp where the blur passes and stays hard where it does not; a linear ramp gets darker below its dark end and
// lighter above its light end under the sharpen (unsharp masking overshoots at the kinks); the undo says the mode
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = { tiles: !!ed.tileMode };
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const keep = { ...ed.smudgeOpts }, size = ed.brushSize, hard = ed.hardness;
try {
    await run("new_canvas", { width: 800, height: 400, doc: d.id });
    const lc = mk(800, 400);
    {
        const x = lc.getContext("2d");
        x.fillStyle = "#000000"; x.fillRect(0, 0, 400, 300); x.fillStyle = "#ffffff"; x.fillRect(400, 0, 400, 300);
        const g = x.createLinearGradient(380, 0, 420, 0);
        g.addColorStop(0, "rgb(64,64,64)"); g.addColorStop(1, "rgb(192,192,192)");
        x.fillStyle = "rgb(64,64,64)"; x.fillRect(0, 300, 380, 100);
        x.fillStyle = g; x.fillRect(380, 300, 40, 100);
        x.fillStyle = "rgb(192,192,192)"; x.fillRect(420, 300, 380, 100);
    }
    const L = ed.addLayer({ name: "E", kind: "paint", px: ed.pixels.Layer.fromCanvas(lc), x: 0, y: 0, w: 800, h: 400, dirty: true });
    ed.activeLayerId = L.id; ed.renderLayers();
    ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false; ed.view.x = 20; ed.view.y = 20; ed.draw();
    let pid = 1700;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: "mouse", pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy)));
    const stroke = (x, y0, y1) => { pid++; ed.canvas.dispatchEvent(ev("pointerdown", x, y0)); for (let i = 1; i <= 10; i++) ed.canvas.dispatchEvent(ev("pointermove", x, y0 + (y1 - y0) * i / 10)); ed.canvas.dispatchEvent(ev("pointerup", x, y1)); };
    const row = (y) => Array.from(L.px.readRect(0, y, 800, 1).data).filter((_, i) => i % 4 === 0);
    ed.setTool("smudge");
    ed.brushSize = 60; ed.hardness = 1;
    Object.assign(ed.smudgeOpts, { mode: "blur", strength: 100, sample: "layer", length: 0, finger: false });
    stroke(400, 60, 240);
    const mid = row(150), away = row(280);
    const soft = (r) => { let n = 0; for (let x = 385; x <= 415; x++) if (r[x] > 20 && r[x] < 235) n++; return n; };
    out.blur = { ramp: soft(mid), away: soft(away) };
    if (!(out.blur.ramp >= 3)) throw new Error("the blur did not soften the edge: " + mid.slice(390, 411).join(","));
    if (out.blur.away !== 0) throw new Error("the edge softened where the blur did not pass: " + away.slice(390, 411).join(","));
    const before = row(360);
    Object.assign(ed.smudgeOpts, { mode: "sharpen" });
    stroke(400, 320, 390);
    const after = row(360);
    out.sharpen = { dark: [before[379], after[379]], light: [before[421], after[421]], label: ed.undoList().slice(-1)[0].label };
    if (!(after[379] < before[379] - 2 && after[421] > before[421] + 2)) throw new Error("the sharpen did not crisp the ramp's ends: " + JSON.stringify(out.sharpen));
    if (out.sharpen.label !== "Sharpen") throw new Error("the undo step is labelled " + out.sharpen.label);
    await ed.undoStep();
    const back = row(360);
    if (back.some((v, i) => v !== before[i])) throw new Error("the undo did not bring the ramp back");
} finally {
    ed.smudgeOpts = keep; ed.brushSize = size; ed.hardness = hard;
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("frequency_separation_gives_the_picture_back_on_every_path", """
// PLAN_0_1_31 §4 step 8: the low and the high layer (linear light) of a frequency separation recompose the picture byte
// for byte: the worker stack (the kernel's op 13), the Canvas 2D flatten (the CPU emulation) and the screen (the GL
// compositor against the Canvas 2D view with its GPU emulation). A typo in a blend mode is refused; the undo takes both.
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const W = 600, H = 400;
const out = { tiles: !!ed.tileMode };
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
try {
    await run("new_canvas", { width: W, height: H, doc: d.id });
    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#c07050"); g.addColorStop(1, "#305090");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        const img = x.getImageData(0, 0, W, H);
        let s = 7;
        for (let i = 0; i < img.data.length; i += 4) { s = (s * 1664525 + 1013904223) >>> 0; const n = (s >>> 26) - 32; img.data[i] += n; img.data[i + 1] += n >> 1; img.data[i + 2] -= n; }
        x.putImageData(img, 0, 0);
    }
    Object.defineProperty(base, "naturalWidth", { value: W }); Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "freqsep_test.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    const pic = ed.basePx.readRect(0, 0, W, H).data.slice();
    const n0 = ed.layers.length;
    const r = await run("frequency_separation", { doc: d.id, radius: 6 });
    const low = ed.layers.find((l) => l.id === r.low), high = ed.layers.find((l) => l.id === r.high);
    out.layers = [low && low.blend, high && high.blend, ed.activeLayerId === r.high];
    if (!low || !high || high.blend !== "linear-light" || ed.layers.length !== n0 + 2) throw new Error("the two layers are not there: " + JSON.stringify(out.layers));
    const diff = (a, b) => { let worst = 0, n = 0; for (let i = 0; i < a.length; i++) { if ((i & 3) === 3) continue; const e = Math.abs(a[i] - b[i]); if (e) n++; if (e > worst) worst = e; } return { worst, n }; };
    // the worker stack (tiles) or the canvas backend's flatten
    const box = await ed.readBoxBytes([0, 0, W, H], { forRun: true });
    out.stack = { how: box.how, ...diff(new Uint8ClampedArray(box.data), pic) };
    if (out.stack.worst !== 0) throw new Error("the " + box.how + " read does not give the picture back: " + JSON.stringify(out.stack));
    // the Canvas 2D flatten: the CPU emulation
    const flat = ed.flattenToCanvas().getContext("2d").getImageData(0, 0, W, H).data;
    out.flatten = diff(flat, pic);
    if (out.flatten.worst > 1) throw new Error("the Canvas 2D flatten does not give the picture back: " + JSON.stringify(out.flatten));
    // the screen: the GL compositor against the Canvas 2D view (its GPU emulation)
    ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false; ed.view.x = 10; ed.view.y = 10;
    await ed.mipsSettled();
    const [sx, sy] = ed.imageToScreen(50, 50);
    const shot = () => { ed.sceneSig = null; ed.draw(); return ed.canvas.getContext("2d").getImageData(Math.round(sx), Math.round(sy), 300, 200).data.slice(); };
    const gl = shot();
    const offWas = ed.compositorOff;
    ed.compositorOff = true;
    const c2d = shot();
    ed.compositorOff = offWas;
    out.screen = diff(gl, c2d);
    const shown = ed.canvas.getContext("2d").getImageData(Math.round(sx), Math.round(sy), 1, 1).data;
    const want = pic.subarray((50 * W + 50) * 4, (50 * W + 50) * 4 + 3);
    out.screenPixel = [Array.from(shown.slice(0, 3)), Array.from(want)];
    if (out.screen.worst > 2) throw new Error("the Canvas 2D view differs from the GL compositor: " + JSON.stringify(out.screen));
    if (Math.max(...[0, 1, 2].map((c) => Math.abs(shown[c] - want[c]))) > 2) throw new Error("the screen does not show the picture: " + JSON.stringify(out.screenPixel));
    // a typo is refused
    let refused = null;
    try { await run("set_layer", { doc: d.id, layer: high.id, blend: "linaer-light" }); } catch (e) { refused = e.message; }
    if (!refused || high.blend !== "linear-light") throw new Error("set_layer took a mistyped blend: " + refused);
    // one undo step takes both layers
    await ed.undoStep();
    if (ed.layers.length !== n0) throw new Error("the undo left " + (ed.layers.length - n0) + " layers");
} finally { await run("close_document", { doc: d.id, force: true }); }
return out;
"""),
    ("dodge_burn_and_sponge_through_the_real_handlers", """
// PLAN_0_1_31 §4 step 9: the tone brush (Shift+O) through the real pointer handlers. One stroke lays its curve down once
// (no build-up over itself, GIMP's default) and a second stroke goes further; Alt burns; Protect tones keeps the hue;
// the sponge desaturates to the luma and saturates without clipping; on the base it paints into a new layer from the
// picture; the undo says the mode. Then the dodge & burn layer: empty in soft light (paint white lightens), or 50 % grey
// and neutral to the byte.
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = { tiles: !!ed.tileMode };
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const keep = { ...ed.toneOpts }, size = ed.brushSize, hard = ed.hardness;
try {
    await run("new_canvas", { width: 800, height: 400, doc: d.id });
    const lc = mk(800, 400);
    {
        const x = lc.getContext("2d");
        const img = x.createImageData(800, 400);
        for (let y = 0; y < 400; y++) for (let xx = 0; xx < 800; xx++) {
            const i = (y * 800 + xx) * 4;
            // a grey ramp above (the value is x / 800 of the way), a warm band below
            const v = y < 200 ? Math.round(xx * 255 / 799) : 0;
            img.data[i] = y < 200 ? v : 200; img.data[i + 1] = y < 200 ? v : 100; img.data[i + 2] = y < 200 ? v : 50; img.data[i + 3] = 255;
        }
        x.putImageData(img, 0, 0);
    }
    const L = ed.addLayer({ name: "T", kind: "paint", px: ed.pixels.Layer.fromCanvas(lc), x: 0, y: 0, w: 800, h: 400, dirty: true });
    ed.activeLayerId = L.id; ed.renderLayers();
    ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false; ed.view.x = 20; ed.view.y = 20; ed.draw();
    let pid = 2700;
    const client = (ix, iy) => { const rect = ed.canvas.getBoundingClientRect(); const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy, alt) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: "mouse", pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1, altKey: !!alt }, client(ix, iy)));
    const stroke = (x, y0, y1, alt) => { pid++; ed.canvas.dispatchEvent(ev("pointerdown", x, y0, alt)); for (let i = 1; i <= 12; i++) ed.canvas.dispatchEvent(ev("pointermove", x, y0 + (y1 - y0) * i / 12, alt)); ed.canvas.dispatchEvent(ev("pointerup", x, y1, alt)); };
    const px = (l, x, y) => Array.from(l.px.readRect(x, y, 1, 1).data);
    const label = () => ed.undoList().slice(-1)[0].label;
    ed.setTool("tone");
    if (ed.tool !== "tone") throw new Error("setTool(tone) left the tool at " + ed.tool);
    ed.brushSize = 40; ed.hardness = 1;
    // 1. dodge, midtones 50 %, per channel: the stroke's core is the curve of the press, once
    Object.assign(ed.toneOpts, { mode: "dodge", range: "midtones", exposure: 50, protect: false, sample: "layer" });
    const lut = ed.toneStroke().lut;
    const v0 = px(L, 200, 100)[0];
    stroke(200, 20, 180);
    const v1 = px(L, 200, 100)[0];
    out.dodge = { v0, v1, want: lut[v0], label: label(), away: px(L, 600, 100)[0] };
    if (Math.abs(v1 - lut[v0]) > 1) throw new Error("one dodge stroke did not lay its curve down once: " + JSON.stringify(out.dodge));
    if (out.dodge.label !== "Dodge") throw new Error("the undo step is labelled " + out.dodge.label);
    if (out.dodge.away !== Math.round(600 * 255 / 799)) throw new Error("the dodge reached x 600: " + out.dodge.away);
    stroke(200, 20, 180);
    out.dodge.again = px(L, 200, 100)[0];
    if (Math.abs(out.dodge.again - lut[v1]) > 1) throw new Error("a second stroke did not go further: " + JSON.stringify(out.dodge));
    // 1b. a click without a move dabs once where it lands (a spot dodge), one undo step (the review of 2026-09-28)
    const c0 = px(L, 700, 100)[0], nUndo = ed.undoList().length;
    pid++; ed.canvas.dispatchEvent(ev("pointerdown", 700, 100)); ed.canvas.dispatchEvent(ev("pointerup", 700, 100));
    out.click = { c0, c1: px(L, 700, 100)[0], want: lut[c0], steps: ed.undoList().length - nUndo };
    if (Math.abs(out.click.c1 - out.click.want) > 1 || out.click.steps !== 1) throw new Error("a click did not dodge its spot: " + JSON.stringify(out.click));
    // 1c. with quick mask on the brush refuses: the selection is what is being edited
    ed.quickMask = true;
    const q0 = px(L, 650, 100)[0], nq = ed.undoList().length;
    try { stroke(650, 20, 180); } finally { ed.quickMask = false; }
    if (px(L, 650, 100)[0] !== q0 || ed.undoList().length !== nq) throw new Error("the tone brush worked with quick mask on");
    // 2. Alt burns
    const b0 = px(L, 400, 100)[0];
    stroke(400, 20, 180, true);
    const burnLut = (() => { Object.assign(ed.toneOpts, { mode: "burn" }); const t = ed.toneStroke().lut; Object.assign(ed.toneOpts, { mode: "dodge" }); return t; })();
    out.burn = { b0, b1: px(L, 400, 100)[0], want: burnLut[b0], label: label() };
    if (Math.abs(out.burn.b1 - out.burn.want) > 1 || out.burn.label !== "Burn") throw new Error("Alt did not burn: " + JSON.stringify(out.burn));
    // 3. Protect tones: highlights dodge at 100 % on the warm band keeps its 4 : 2 : 1
    Object.assign(ed.toneOpts, { mode: "dodge", range: "highlights", exposure: 100, protect: true });
    const hl = ed.toneStroke().lut, k = hl[200] / 200;
    stroke(100, 220, 380);
    const w = px(L, 100, 300);
    out.protect = { got: w, want: [200, 100, 50].map((c) => Math.round(c * k)) };
    if (w.slice(0, 3).some((c, i) => Math.abs(c - out.protect.want[i]) > 1)) throw new Error("Protect tones did not scale the three alike: " + JSON.stringify(out.protect));
    Object.assign(ed.toneOpts, { protect: false });
    stroke(160, 220, 380);
    const pc = px(L, 160, 300);
    out.perChannel = { got: pc, want: [hl[200], hl[100], hl[50]] };
    if (pc.slice(0, 3).some((c, i) => Math.abs(c - out.perChannel.want[i]) > 1)) throw new Error("per channel is not the curve on each channel: " + JSON.stringify(out.perChannel));
    if (!(pc[1] - w[1] >= 3)) throw new Error("per channel and protect gave the same green: " + pc + " / " + w);
    // 4. the sponge: desaturate 100 % gives the luma, saturate widens without clipping
    Object.assign(ed.toneOpts, { mode: "desaturate", exposure: 100 });
    stroke(300, 220, 380);
    const g = px(L, 300, 300), yl = (77 * 200 + 150 * 100 + 29 * 50 + 128) >> 8;
    out.desaturate = { g, y: yl, label: label() };
    if (g.slice(0, 3).some((c) => Math.abs(c - yl) > 1) || out.desaturate.label !== "Desaturate") throw new Error("desaturate 100 % did not give the luma: " + JSON.stringify(out.desaturate));
    Object.assign(ed.toneOpts, { mode: "saturate", exposure: 60, vibrance: true });
    stroke(500, 220, 380);
    const s = px(L, 500, 300);
    out.saturate = s;
    if (!(s[0] > 200 && s[2] < 50 && s[0] < 255 && s[0] - s[2] > 150)) throw new Error("saturate did not widen the band: " + s);
    // 5. the undo takes the last stroke back
    await ed.undoStep();
    if (px(L, 500, 300).slice(0, 3).join() !== "200,100,50") throw new Error("the undo did not bring the band back: " + px(L, 500, 300));
    // 5b. a layer hanging out of the picture: a brush reading the image finds nothing outside it and leaves that alone
    const oc = mk(200, 100); { const x = oc.getContext("2d"); x.fillStyle = "rgb(90,90,90)"; x.fillRect(0, 0, 200, 100); }
    const O = ed.addLayer({ name: "O", kind: "paint", px: ed.pixels.Layer.fromCanvas(oc), x: -100, y: 250, w: 200, h: 100, dirty: true });
    ed.activeLayerId = O.id; ed.renderLayers();
    Object.assign(ed.toneOpts, { mode: "dodge", range: "midtones", exposure: 50, protect: true, sample: "image" });
    stroke(5, 260, 340);
    out.outside = { out: px(O, 90, 50), in: px(O, 105, 50) };
    if (out.outside.out.join() !== "90,90,90,255") throw new Error("the brush changed the layer outside the picture: " + out.outside.out);
    if (!(out.outside.in[0] > 110)) throw new Error("the brush did not dodge inside the picture: " + out.outside.in);
    ed.removeLayer(O.id);
    ed.activeLayerId = L.id;
    // 6. on the base: a new layer from the picture, the base untouched
    ed.removeLayer(L.id);
    const bc = mk(800, 400); { const x = bc.getContext("2d"); x.fillStyle = "rgb(100,100,100)"; x.fillRect(0, 0, 800, 400); }
    await ed.setBase({ filename: "tone_base.png", subfolder: "inpaint_canvas", type: "input" }, bc, { keepLayers: false });
    ed.activeLayerId = null; ed.renderLayers();
    const n0 = ed.layers.length;
    Object.assign(ed.toneOpts, { mode: "dodge", range: "midtones", exposure: 50, protect: true, sample: "layer" });
    const want = ed.toneStroke().lut[100];
    stroke(400, 50, 350);
    const N = ed.layers[ed.layers.length - 1];
    out.base = { added: ed.layers.length - n0, kind: N && N.kind, px: N && px(N, 400, 200), base: Array.from(ed.basePx.readRect(400, 200, 1, 1).data), want, sample: ed.toneOpts.sample };
    if (out.base.added !== 1 || out.base.kind !== "paint") throw new Error("the tone brush on the base did not make one paint layer: " + JSON.stringify(out.base));
    if (Math.abs(out.base.px[0] - want) > 1 || out.base.px[3] < 250) throw new Error("the new layer does not hold the dodged picture: " + JSON.stringify(out.base));
    if (out.base.base[0] !== 100) throw new Error("the tone brush wrote the base: " + out.base.base);
    if (out.base.sample !== "image") throw new Error("Sample did not switch to image: " + out.base.sample);
    ed.removeLayer(N.id);
    // 6b. a blur filter layer above the layer (the region tier, on tiles too): each dab's write spreads the blur's reach
    // past its box, and the stroke still lays the press's curve (the first reads take that reach around the box)
    const fc = mk(800, 400); { const x = fc.getContext("2d"); x.fillStyle = "rgb(100,100,100)"; x.fillRect(0, 0, 800, 400); }
    const F = ed.addLayer({ name: "F", kind: "paint", px: ed.pixels.Layer.fromCanvas(fc), x: 0, y: 0, w: 800, h: 400, dirty: true });
    const bl = ed.addFilterLayer("blur");
    bl.params = { ...(bl.params || {}), radius: 4 }; bl._fcache = null; bl._fcacheView = null;
    ed.activeLayerId = F.id; ed.renderLayers();
    Object.assign(ed.toneOpts, { mode: "dodge", range: "midtones", exposure: 50, protect: true, sample: "image" });
    stroke(400, 100, 300);
    out.filterAbove = { got: px(F, 400, 200), want: ed.toneStroke().lut[100] };
    if (Math.abs(out.filterAbove.got[0] - out.filterAbove.want) > 1) throw new Error("under a blur filter the stroke compounded: " + JSON.stringify(out.filterAbove));
    ed.removeLayer(bl.id); ed.removeLayer(F.id);
    // 7. the dodge & burn layer: empty soft light, painted white at half alpha, lightens; 50 % grey is neutral to the byte
    const flat = () => { ed.flatCache = null; return Array.from(ed.flattenToCanvas({ forRun: false }).getContext("2d").getImageData(400, 200, 1, 1).data); };
    const plain = flat();
    const e = await run("dodge_burn_layer", { doc: d.id });
    const E = ed.layers.find((l) => l.id === e.id);
    out.layer = { blend: E.blend, name: E.name, active: ed.activeLayerId === E.id, empty: px(E, 400, 200)[3], label: label(), flatEmpty: flat() };
    if (E.blend !== "soft-light" || !out.layer.active || out.layer.empty !== 0 || out.layer.label !== "Dodge & burn layer") throw new Error("the dodge & burn layer is not an empty active soft-light layer: " + JSON.stringify(out.layer));
    if (out.layer.flatEmpty.join() !== plain.join()) throw new Error("the empty layer changed the picture: " + out.layer.flatEmpty);
    E.px.drawInto(null, (c) => { c.fillStyle = "rgba(255,255,255,0.5)"; c.fillRect(0, 0, 800, 400); });
    ed.markLayerChanged(E);
    out.layer.white = flat();
    if (!(out.layer.white[0] > plain[0] + 5)) throw new Error("white on the soft-light layer did not lighten: " + out.layer.white);
    await ed.undoStep();
    if (ed.layers.includes(E)) throw new Error("the undo left the dodge & burn layer");
    const gr = await run("dodge_burn_layer", { doc: d.id, grey: true });
    const G = ed.layers.find((l) => l.id === gr.id);
    out.grey = { px: px(G, 400, 200), flat: flat() };
    if (out.grey.px.join() !== "128,128,128,255") throw new Error("the grey layer holds " + out.grey.px);
    for (const op of [1, 0.5]) { G.opacity = op; ed.bumpComposite(G, null); const f = flat(); if (f.join() !== plain.join()) throw new Error("50 % grey is not neutral at opacity " + op + ": " + f + " against " + plain); }
} finally {
    Object.assign(ed.toneOpts, keep); ed.brushSize = size; ed.hardness = hard;
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("mask_operations_are_one_step_each", """
// PLAN_0_1_31 6.4: set_mask's operations, each one undo step, the mask white where it shows, and the mask row's menu
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = {};
try {
    await run("new_canvas", { width: 400, height: 300, doc: d.id });
    const L = ed.addPaintLayer();
    const id = L.id;
    const lay = () => ed.layers.find((l) => l.id === id);   // a "layers" step puts copies back: looked up each time
    L.px.fill([0, 0, 400, 300], "#2060c0"); ed.markLayerChanged(L);
    const mask = (op) => run("set_mask", { layer: id, op, doc: d.id });
    const alpha = (x, y) => lay().maskPx.readRect(x, y, 1, 1).data;
    const fails = async (op, re) => { try { await mask(op); } catch (e) { if (re.test(String(e.message || e))) return; throw new Error(op + " failed with " + e.message); } throw new Error(op + " did not fail"); };
    // what needs a mask or a selection says so, and pushes nothing
    const n0 = ed.undo.length;
    await fails("invert", /has no mask/);
    await fails("enable", /has no mask/);
    await fails("from_selection", /nothing is selected/);
    if (ed.undo.length !== n0) throw new Error("a refused operation pushed a step");
    // hide all adds a black mask; invert makes it white (a layer mask's colour, not the selection's red)
    let r = await mask("hide");
    if (!r.changed || !r.mask || r.mask_off || alpha(200, 150)[3] !== 0) throw new Error("hide did not add a black mask: " + JSON.stringify(r));
    r = await mask("invert");
    const px = alpha(200, 150);
    if (px[3] !== 255 || px[0] !== 255 || px[1] !== 255 || px[2] !== 255) throw new Error("the inverted mask is not white: " + Array.from(px));
    // reveal replaces the mask; the selection ones keep or hide the selected part
    await mask("hide"); await mask("reveal");
    if (alpha(10, 10)[3] !== 255 || alpha(390, 290)[3] !== 255) throw new Error("reveal did not make the mask white everywhere");
    await run("select_rect", { x: 100, y: 100, w: 100, h: 50, doc: d.id });
    await mask("hide_selection");
    if (alpha(150, 120)[3] !== 0 || alpha(10, 10)[3] !== 255) throw new Error("hide_selection: inside " + alpha(150, 120)[3] + ", outside " + alpha(10, 10)[3]);
    // what the picture shows: the base where the mask hides, the layer around it
    const flat = ed.flattenToCanvas().getContext("2d");
    const inside = flat.getImageData(150, 120, 1, 1).data, outside = flat.getImageData(10, 10, 1, 1).data;
    if (inside[2] > 200 && inside[0] < 60) throw new Error("the hidden part still shows the layer: " + Array.from(inside));
    if (!(outside[0] < 60 && outside[2] > 150)) throw new Error("the layer does not show around the hidden part: " + Array.from(outside));
    await mask("from_selection");
    if (alpha(150, 120)[3] !== 255 || alpha(10, 10)[3] !== 0) throw new Error("from_selection: inside " + alpha(150, 120)[3] + ", outside " + alpha(10, 10)[3]);
    // one labelled step each, and undo walks them back
    out.labels = ed.undoList().filter((x) => x.label && /^Mask|mask/.test(x.label)).map((x) => x.label);
    const maskSteps = ed.undo.slice(n0).filter((x) => x.kind === "mask").length;
    if (maskSteps !== 6) throw new Error("six operations pushed " + maskSteps + " mask steps");
    await ed.undoStep();
    if (alpha(150, 120)[3] !== 0 || alpha(10, 10)[3] !== 255) throw new Error("the undo of from_selection did not bring back the hide_selection mask");
    // the switch: off, off again (no change, no step), and an operation on a switched-off mask switches it on
    r = await mask("disable");
    if (!r.changed || !r.mask_off) throw new Error("disable: " + JSON.stringify(r));
    const n1 = ed.undo.length;
    r = await mask("disable");
    if (r.changed || ed.undo.length !== n1) throw new Error("disabling a switched-off mask changed something");
    if (!/already/.test(r.status)) throw new Error("a disable that changed nothing says: " + r.status);
    r = await mask("invert");
    if (r.mask_off || lay().maskOff) throw new Error("invert left the mask switched off");
    await ed.undoStep();
    if (!lay().maskOff) throw new Error("the undo of the invert did not switch the mask off again");
    // a menu open over an undo that puts copies of the layers back closes with the rows it was opened from
    ed.activeLayerId = id; ed.renderLayers();
    ed.root.querySelector(".ipc-mask-more").click();
    if (!ed.root.querySelector(".ipc-flyout")) throw new Error("the mask menu did not open");
    await ed.undoStep();
    if (ed.root.querySelector(".ipc-flyout")) throw new Error("the mask menu stayed open over an undo that replaced the layers");
    await ed.redoStep();
    if (!lay().maskOff) throw new Error("the redo did not switch the mask off again");
    // the mask row's menu: opened by its button, to the left of it (the side panel sits at the right edge), invert
    // disabled without a mask, an entry runs its operation
    await mask("remove");
    if (lay().maskPx) throw new Error("remove left the mask");
    ed.activeLayerId = id; ed.renderLayers();
    // the mask row belongs to the active layer's row
    const btn = ed.root.querySelector(".ipc-mask-more");
    if (!btn) throw new Error("no mask menu button in the active layer's row");
    btn.click();
    const fly = ed.root.querySelector(".ipc-flyout");
    if (!fly) throw new Error("the mask menu did not open");
    const items = [...fly.querySelectorAll("button")];
    out.menu = items.map((b) => b.textContent.trim() + (b.disabled ? " (disabled)" : ""));
    const inv = items.find((b) => /Invert/.test(b.textContent));
    if (!inv || !inv.disabled) throw new Error("invert is not disabled without a mask: " + out.menu.join(", "));
    const fr = fly.getBoundingClientRect(), rr = ed.root.getBoundingClientRect();
    if (fr.right > rr.right + 1 || fr.left < rr.left - 1) throw new Error("the menu leaves the editor: " + JSON.stringify([fr.left, fr.right, rr.left, rr.right]));
    items.find((b) => /Hide all/.test(b.textContent)).click();
    if (ed.root.querySelector(".ipc-flyout")) throw new Error("the menu stayed open after its entry ran");
    if (!lay().maskPx || alpha(10, 10)[3] !== 0) throw new Error("the menu's Hide all did not add a black mask");
    // a filter layer has no pixels to bake a mask into: apply is refused and the mask stays
    const fx = await run("add_filter", { type: "grain", doc: d.id });
    await run("set_mask", { layer: fx.id, op: "from_selection", doc: d.id });
    let refused = "";
    try { await run("set_mask", { layer: fx.id, op: "apply", doc: d.id }); } catch (e) { refused = String(e.message || e); }
    if (!/filter layer/.test(refused)) throw new Error("apply on a filter layer was not refused: " + (refused || "it ran"));
    if (!ed.layers.find((l) => l.id === fx.id).maskPx) throw new Error("the refused apply dropped the filter layer's mask");
    out.ok = true;
} finally { await run("close_document", { doc: d.id, force: true }); }
return out;
"""),
    ("side_panel_width_drags_and_is_kept", """
// item 17: the grip on the side panel's left edge sets its width, clamped; every tab shows it; it is kept; the view refits
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = {};
const sideOf = (e) => e.root.querySelector(".ipc-side");
const width = (e) => Math.round(parseFloat(getComputedStyle(sideOf(e)).width));   // the CSS width, the border not counted
try {
    await run("new_canvas", { width: 1600, height: 1000, doc: d.id });
    const L = ed.addPaintLayer();
    await run("select_rect", { x: 100, y: 100, w: 300, h: 200, doc: d.id });
    await run("set_mask", { layer: L.id, op: "from_selection", doc: d.id });
    ed.activeLayerId = L.id; ed.renderLayers();
    ed.setSideWidth(null);
    await wait(150);
    const side = sideOf(ed), grip = side.querySelector(".ipc-side-grip");
    if (!grip) throw new Error("no grip on the side panel");
    let stored = null; try { stored = localStorage.getItem("ipc.sideWidth"); } catch (_) { /* none */ }
    const w0 = width(ed);
    if (Math.abs(w0 - 320) > 2 || stored !== null) throw new Error("the default is not 320 px unstored: " + w0 + ", " + stored);
    // at the default width an expanded row (its mask row included) fits: nothing in the panel is wider than it
    const over = [...side.querySelectorAll(".ipc-pane, .ipc-layer, .ipc-maskrow")].filter((p) => p.offsetParent !== null && p.scrollWidth > p.clientWidth + 1).map((p) => p.className + " " + p.scrollWidth + ">" + p.clientWidth);
    if (over.length) throw new Error("wider than the panel at the default width: " + over.join("; "));
    // a drag 120 px to the left, with the pointer leaving the grip on the way
    const gr = grip.getBoundingClientRect(), x = gr.left + 2, y = gr.top + 60;
    const pe = (target, type, cx) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 7, isPrimary: true, pointerType: "mouse" }));
    const cw0 = ed.canvas.width;
    ed.fitView();
    const s0 = ed.view.scale;
    pe(grip, "pointerdown", x);
    if (!grip.classList.contains("ipc-dragging")) throw new Error("the grip did not take the press");
    pe(ed.canvas, "pointermove", x - 60);
    pe(ed.canvas, "pointermove", x - 120);
    pe(ed.canvas, "pointerup", x - 120);
    await wait(250);
    const w1 = width(ed);
    try { stored = localStorage.getItem("ipc.sideWidth"); } catch (_) { stored = "?"; }
    if (Math.abs(w1 - (w0 + 120)) > 2) throw new Error("the drag made the panel " + w1 + " px, not " + (w0 + 120));
    if (grip.classList.contains("ipc-dragging")) throw new Error("the release did not end the drag");
    if (stored !== String(w0 + 120)) throw new Error("the width was not kept: " + stored);
    if (!(ed.canvas.width < cw0)) throw new Error("the view did not shrink with the panel: " + cw0 + " -> " + ed.canvas.width);
    if (ed._fitted === false || !(ed.view.scale < s0)) throw new Error("the picture was not refitted: scale " + s0 + " -> " + ed.view.scale);
    out.dragged = [w0, w1];
    // the ends: no narrower than 300 px, no wider than 60 % of the editor's body
    const drag = (dx) => { const g = grip.getBoundingClientRect(); pe(grip, "pointerdown", g.left + 2); pe(ed.canvas, "pointermove", g.left + 2 + dx); pe(ed.canvas, "pointerup", g.left + 2 + dx); };
    drag(4000); await wait(150);
    if (Math.abs(width(ed) - 310) > 2) throw new Error("dragged far right the panel is " + width(ed) + " px, not 310");
    // at the minimum an expanded row still fits beside the list's scrollbar (16 layers make the list scroll)
    for (let i = 0; i < 15; i++) ed.addPaintLayer();
    ed.activeLayerId = L.id; ed.renderLayers();
    await wait(150);
    const list = side.querySelector(".ipc-list");
    const tight = [...side.querySelectorAll(".ipc-list, .ipc-pane")].filter((p) => p.offsetParent !== null && p.scrollWidth > p.clientWidth + 1).map((p) => p.className + " " + p.scrollWidth + ">" + p.clientWidth);
    if (tight.length) throw new Error("at the minimum width the panel scrolls sideways: " + tight.join("; ") + (list ? " (list scrollbar " + (list.offsetWidth - list.clientWidth) + " px)" : ""));
    out.minScrollbar = list ? list.offsetWidth - list.clientWidth : null;
    drag(-6000); await wait(150);
    const body = side.parentElement.getBoundingClientRect().width;
    if (width(ed) > Math.floor(body * 0.6) + 2 || width(ed) < 400) throw new Error("dragged far left the panel is " + width(ed) + " px of a body of " + Math.round(body));
    out.ends = [310, width(ed), Math.round(body)];
    // a press without a move stores nothing; a move without the button held (the release was lost) ends the drag
    try { stored = localStorage.getItem("ipc.sideWidth"); } catch (_) { stored = "?"; }
    { const g = grip.getBoundingClientRect(); pe(grip, "pointerdown", g.left + 2); pe(ed.canvas, "pointerup", g.left + 2); }
    let after = null; try { after = localStorage.getItem("ipc.sideWidth"); } catch (_) { after = "?"; }
    if (after !== stored) throw new Error("a press without a move stored " + after + " over " + stored);
    ed.setSideWidth(400);
    { const g = grip.getBoundingClientRect(); pe(grip, "pointerdown", g.left + 2); pe(ed.canvas, "pointermove", g.left - 48); }
    ed.canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 200, clientY: y, buttons: 0, pointerId: 7, pointerType: "mouse" }));
    if (grip.classList.contains("ipc-dragging")) throw new Error("a move without the button did not end the drag");
    if (width(ed) !== 450) throw new Error("the lost release left " + width(ed) + " px, not the 450 of the last move with the button");
    ed.canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 100, clientY: y, buttons: 0, pointerId: 7, pointerType: "mouse" }));
    if (width(ed) !== 450) throw new Error("the panel still follows the mouse after the drag ended: " + width(ed));
    // the app's export rows sit inside the Export block (its padding), not on the panel's left edge under the grip
    const exRow = ed.root.querySelector(".scumble-export-size");
    if (exRow && !exRow.parentElement.classList.contains("ipc-sec")) throw new Error("the export size row is outside the Export block");
    // another tab shows the same width
    ed.setSideWidth(450);
    const d2 = await run("new_document");
    const ed2 = ednow(d2.id);
    try {
        host.shell.activate(ed2);
        await wait(150);
        if (Math.abs(width(ed2) - 450) > 2) throw new Error("another tab shows " + width(ed2) + " px, not 450");
    } finally { await run("close_document", { doc: d2.id, force: true }); host.shell.activate(ed); }
    // a stored width is put back when an editor opens (a restart); a double click goes back to the default and forgets it
    document.documentElement.style.setProperty("--ipc-side-w", "320px");
    ed.applyStoredSideWidth();
    await wait(100);
    if (Math.abs(width(ed) - 450) > 2) throw new Error("the stored width did not come back: " + width(ed));
    grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await wait(150);
    try { stored = localStorage.getItem("ipc.sideWidth"); } catch (_) { stored = "?"; }
    if (Math.abs(width(ed) - 320) > 2 || stored !== null) throw new Error("the double click left " + width(ed) + " px, stored " + stored);
    out.ok = true;
} finally {
    ed.setSideWidth(null);
    await run("close_document", { doc: d.id, force: true });
}
return out;
"""),
    ("the_whole_document_turns_and_flips_with_everything_on_it", """
// PLAN_0_1_31 §7 (item 23a): rotate_canvas / flip_canvas move every store exactly, the rest follows, one undo step
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = {};
const W = 601, H = 357;   // no multiple of 256: a new tile gathers from several source tiles
const words = (px) => { const a = px.readRect(0, 0, px.width, px.height).data; return new Uint32Array(a.buffer, a.byteOffset, a.length >> 2); };
// where a pixel (x, y) of a w x h store lands
const land = { 1: (x, y, w, h) => [h - 1 - y, x], "-1": (x, y, w, h) => [y, w - 1 - x], 2: (x, y, w, h) => [w - 1 - x, h - 1 - y], h: (x, y, w, h) => [w - 1 - x, y], v: (x, y, w, h) => [x, h - 1 - y] };
const mapped = (before, bw, bh, after, op, what) => {
    const a = after.width, A = words(after);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const [X, Y] = land[String(op)](x, y, bw, bh);
        if (before[y * bw + x] !== A[Y * a + X]) throw new Error(what + ": pixel " + x + "," + y + " is not at " + X + "," + Y + " after " + op);
    }
};
const same = (a, b, what) => { if (a.length !== b.length) throw new Error(what + ": sizes differ"); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(what + ": word " + i + " differs"); };
try {
    // a base with a pattern that tells every pixel apart
    const bc = document.createElement("canvas"); bc.width = W; bc.height = H;
    const bx = bc.getContext("2d"), bi = bx.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; bi.data[i] = x & 255; bi.data[i + 1] = y & 255; bi.data[i + 2] = (x >> 8) * 40 + (y >> 8) * 90; bi.data[i + 3] = 255; }
    bx.putImageData(bi, 0, 0);
    await ed.setBaseFromCanvas(bc);
    // a full-size layer with a mask, a small layer at twice its resolution, a masked filter layer, a text layer
    const L1 = ed.addPaintLayer();
    L1.px.fill([0, 0, W, H], "rgba(20,120,200,0.8)"); L1.px.fill([30, 40, 90, 70], "#ff3300"); ed.markLayerChanged(L1);
    await run("select_rect", { x: 200, y: 60, w: 150, h: 90, doc: d.id });
    ed.maskFromSelection(L1);
    const L2 = ed.addLayer({ name: "small", kind: "paint", ref: null, px: ed.pixels.Layer.empty(240, 160), x: 50, y: 30, w: 120, h: 80, dirty: true });
    L2.px.fill([0, 0, 120, 80], "#33cc66"); L2.px.fill([200, 100, 240, 160], "#ffee00"); ed.markLayerChanged(L2);
    const fx = await run("add_filter", { type: "grain", doc: d.id });
    await run("select_rect", { x: 400, y: 200, w: 100, h: 100, doc: d.id });
    await run("set_mask", { layer: fx.id, op: "from_selection", doc: d.id });
    const tx = await run("add_text", { text: "Turn me", x: 60, y: 250, size: 40, doc: d.id });
    await wait(300);
    const T = () => ed.layers.find((l) => l.id === tx.id);
    const tw0 = T().w, th0 = T().h;
    // film control points and a 3D object's parameters, where their plugins are loaded
    let pts = null;
    try { pts = await run("add_filter", { type: "film.points", doc: d.id }); } catch (_) { /* no film pack */ }
    if (pts) { const raw = ed.layers.find((l) => l.id === pts.id); raw.params = { ...raw.params, points: [{ id: 1, x: 100, y: 50, r: 20 }] }; }
    ed.pluginData = { ...(ed.pluginData || {}), glb: { objects: { [L2.id]: { ref: null, name: "cube", params: { x: 0.5, y: 0.5 } } } } };
    // the selection, a guide each way, a saved selection, a results-history entry that can be restored
    await run("select_rect", { x: 10, y: 20, w: 100, h: 50, doc: d.id });
    ed.guides = { x: [100], y: [40] };
    ed.saveSelection();
    const hc = document.createElement("canvas"); hc.width = 60; hc.height = 30;
    const hx = hc.getContext("2d"); hx.fillStyle = "#0000ff"; hx.fillRect(0, 0, 60, 30); hx.fillStyle = "#ff00ff"; hx.fillRect(0, 0, 10, 10);
    ed.history.push({ key: "t23", name: "Result t23", ref: { filename: "none.png", subfolder: "", type: "input" }, x: 300, y: 100, w: 60, h: 30, prompt: "", thumbImg: hc });
    if (ed.syncLayers) await ed.syncLayers();
    const before = { base: words(ed.basePx), l1: words(L1.px), m1: words(L1.maskPx), l2: words(L2.px), fm: words(ed.layers.find((l) => l.id === fx.id).maskPx), sel: words(ed.sel) };
    const v0 = ed.compositeVersion, n0 = ed.undo.length, ref0 = JSON.stringify(L1.ref), mref0 = JSON.stringify(L1.maskRef);
    // busy: refused, nothing changes
    ed.providerPending = { t23: true };
    let refused = "";
    try { await run("rotate_canvas", { angle: 90, doc: d.id }); } catch (e) { refused = String(e.message || e); }
    ed.providerPending = null;
    if (!/running job/.test(refused) || ed.width !== W) throw new Error("a turn while a job runs was not refused: " + (refused || "it ran"));
    // a quarter turn clockwise
    const r = await run("rotate_canvas", { angle: 90, doc: d.id });
    if (r.width !== H || r.height !== W || ed.width !== H || ed.height !== W) throw new Error("the turn made " + ed.width + " x " + ed.height);
    if (ed.undo.length !== n0 + 1) throw new Error("the turn pushed " + (ed.undo.length - n0) + " steps");
    if (ed.compositeVersion === v0) throw new Error("the turn left the composite version");
    mapped(before.base, W, H, ed.basePx, 1, "the base");
    const l1 = ed.layers.find((l) => l.id === L1.id), l2 = ed.layers.find((l) => l.id === L2.id), f1 = ed.layers.find((l) => l.id === fx.id);
    mapped(before.l1, W, H, l1.px, 1, "the full-size layer");
    mapped(before.m1, W, H, l1.maskPx, 1, "its mask");
    mapped(before.l2, 240, 160, l2.px, 1, "the small layer at its own resolution");
    mapped(before.fm, W, H, f1.maskPx, 1, "the filter layer's mask");
    mapped(before.sel, W, H, ed.sel, 1, "the selection");
    if (l1.x !== 0 || l1.y !== 0 || l1.w !== H || l1.h !== W) throw new Error("the full-size layer is at " + [l1.x, l1.y, l1.w, l1.h]);
    if (l2.x !== H - 110 || l2.y !== 50 || l2.w !== 80 || l2.h !== 120) throw new Error("the small layer is at " + [l2.x, l2.y, l2.w, l2.h] + ", not " + [H - 110, 50, 80, 120]);
    if (f1.w !== H || f1.h !== W) throw new Error("the filter layer covers " + f1.w + " x " + f1.h);
    // the turned layer and its mask go out as new files at once (a restored session must not pair the old ones with the new places)
    if (ed.syncLayers) await ed.syncLayers();
    if (l1.dirty || l1.maskDirty || JSON.stringify(l1.ref) === ref0 || JSON.stringify(l1.maskRef) === mref0) throw new Error("the turned layer kept its old files: " + JSON.stringify({ dirty: l1.dirty, ref: l1.ref, ref0 }));
    if (JSON.stringify(ed.guides) !== JSON.stringify({ x: [H - 40], y: [100] })) throw new Error("the guides are " + JSON.stringify(ed.guides));
    const hist = ed.history.find((x) => x.key === "t23");
    if ([hist.x, hist.y, hist.w, hist.h].join() !== [H - 130, 300, 30, 60].join() || !hist.orient || hist.orient.turn !== 1) throw new Error("the history entry is " + JSON.stringify({ x: hist.x, y: hist.y, w: hist.w, h: hist.h, orient: hist.orient }));
    if (T().text.turn !== 1 || T().w !== th0 || T().h !== tw0) throw new Error("the text layer: turn " + T().text.turn + ", " + T().w + " x " + T().h);
    if (pts) {
        const p = ed.layers.find((l) => l.id === pts.id).params.points[0];
        if (p.x !== H - 50 || p.y !== 100) throw new Error("the control point is at " + p.x + "," + p.y);
        out.points = true;
    }
    // a 3D object keeps the map from its render frame to the document (23b: the geometry event's matrix)
    const glbFrame = ed.pluginData && ed.pluginData.glb && ed.pluginData.glb.objects[L2.id].params.frame;
    if (glbFrame && JSON.stringify(glbFrame.m) !== JSON.stringify([0, 1, -1, 0, H, 0])) throw new Error("the 3D object's frame is " + JSON.stringify(glbFrame));
    out.glb = glbFrame ? glbFrame.m : "no plugin";
    // the text keeps its turn when it is rendered again
    await ed.renderTextLayer(T());
    if (Math.abs(T().w - th0) > 1 || Math.abs(T().h - tw0) > 1 || T().px.height <= T().px.width) throw new Error("the re-rendered text came back upright: " + T().px.width + " x " + T().px.height + ", " + T().w + " x " + T().h);
    // more text grows away from the corner the text starts at (after a clockwise turn the top right), which stays put
    const right0 = T().x + T().w, top0 = T().y, wide0 = T().w;
    T().text = { ...T().text, content: T().text.content + "\\nand a second line" };
    await ed.renderTextLayer(T());
    if (!(T().w > wide0) || Math.abs(T().x + T().w - right0) > 1 || Math.abs(T().y - top0) > 1) throw new Error("the turned text did not grow away from its first letter: right " + right0 + " -> " + (T().x + T().w) + ", top " + top0 + " -> " + T().y + ", width " + wide0 + " -> " + T().w);
    // a saved selection loads turned; a restored result lands turned where its rectangle went
    await ed.loadSelection(0, "replace");
    mapped(before.sel, W, H, ed.sel, 1, "the saved selection loaded");
    await ed.restoreResult(hist);
    const res = ed.layers.find((l) => l.id === hist.layerId);
    if (!res || res.x !== H - 130 || res.y !== 300 || res.px.width !== 30 || res.px.height !== 60) throw new Error("the restored result: " + JSON.stringify(res && [res.x, res.y, res.px.width, res.px.height]));
    const rp = res.px.readRect(29, 0, 1, 1).data;   // the file's magenta corner (0, 0) lands at (29, 0) after a clockwise turn
    if (!(rp[0] > 200 && rp[2] > 200 && rp[1] < 60)) throw new Error("the restored result is not turned: " + Array.from(rp));
    await ed.undoStep(); await ed.undoStep();   // the loaded selection, the turn (a restored result is no step; the turn's undo drops it)
    if (ed.width !== W || ed.height !== H) throw new Error("the undo left " + ed.width + " x " + ed.height);
    same(words(ed.basePx), before.base, "the base after the undo");
    same(words(ed.layers.find((l) => l.id === L1.id).px), before.l1, "the layer after the undo");
    same(words(ed.sel), before.sel, "the selection after the undo");
    if (JSON.stringify(ed.guides) !== JSON.stringify({ x: [100], y: [40] })) throw new Error("the undo left the guides at " + JSON.stringify(ed.guides));
    if (hist.x !== 300 || hist.y !== 100 || (hist.orient && (hist.orient.turn || hist.orient.flip))) throw new Error("the undo left the history entry at " + JSON.stringify(hist));
    if (T().text.turn) throw new Error("the undo left the text turned");
    if (pts && ed.layers.find((l) => l.id === pts.id).params.points[0].x !== 100) throw new Error("the undo left the control point");
    if (ed.pluginData.glb.objects[L2.id].params.frame) throw new Error("the undo left the 3D object's frame");
    await ed.redoStep();
    if (ed.width !== H) throw new Error("the redo did not turn it again");
    mapped(before.base, W, H, ed.basePx, 1, "the base after the redo");
    if (JSON.stringify(ed.guides) !== JSON.stringify({ x: [H - 40], y: [100] })) throw new Error("the redo left the guides at " + JSON.stringify(ed.guides));
    // three more quarter turns: everything as it was, byte for byte; a half turn and a flip map like the pixels do
    for (let i = 0; i < 3; i++) await run("rotate_canvas", { angle: 90, doc: d.id });
    same(words(ed.basePx), before.base, "four quarter turns");
    same(words(ed.layers.find((l) => l.id === L1.id).maskPx), before.m1, "the mask after four turns");
    same(words(ed.sel), before.sel, "the selection after four turns");
    if (JSON.stringify(ed.guides) !== JSON.stringify({ x: [100], y: [40] })) throw new Error("four turns left the guides at " + JSON.stringify(ed.guides));
    if (T().text.turn || T().text.flip) throw new Error("four turns left the text at " + JSON.stringify([T().text.turn, T().text.flip]));
    await run("rotate_canvas", { angle: 180, doc: d.id });
    mapped(before.base, W, H, ed.basePx, 2, "the half turn");
    await run("rotate_canvas", { angle: 180, doc: d.id });
    // a flip keeps the size: the picture the eyedropper, bucket and wand read must be the flipped one
    const flat0 = ed.compositeCanvas().getContext("2d").getImageData(5, 5, 1, 1).data.slice();
    ed.objects = { t23: true };   // an object map of the picture as it is: the flip makes it wrong
    await run("flip_canvas", { axis: "horizontal", doc: d.id });
    mapped(before.base, W, H, ed.basePx, "h", "the flip");
    if (ed.objects) throw new Error("the object map of the unflipped picture survived the flip");
    const flat1 = ed.compositeCanvas().getContext("2d").getImageData(W - 6, 5, 1, 1).data;
    if (Array.from(flat1).some((v, i) => Math.abs(v - flat0[i]) > 3)) throw new Error("the composite after the flip is the old one: " + Array.from(flat0) + " / " + Array.from(flat1));
    if (!T().text.flip) throw new Error("the flip did not reach the text");
    // its undo keeps the size too (and uploads nothing): what the eyedropper reads is the picture before the flip again
    await ed.undoStep();
    const flat2 = ed.compositeCanvas().getContext("2d").getImageData(5, 5, 1, 1).data;
    if (Array.from(flat2).some((v, i) => Math.abs(v - flat0[i]) > 3)) throw new Error("the composite after undoing the flip is the flipped one: " + Array.from(flat0) + " / " + Array.from(flat2));
    await ed.redoStep();
    mapped(before.base, W, H, ed.basePx, "h", "the flip redone");
    await run("flip_canvas", { axis: "vertical", doc: d.id });
    mapped(before.base, W, H, ed.basePx, 2, "h then v");
    // the text's orientation composes like the pixels: after a quarter turn and a mirror a fresh render, put into the
    // orientation the description says, is what the turns made of the old pixels (byte for byte on tiles)
    await run("rotate_canvas", { angle: 90, doc: d.id });
    await run("flip_canvas", { axis: "horizontal", doc: d.id });
    const tt = T().text;
    out.textOrient = [tt.turn, tt.flip];
    const turnedPx = words(T().px), tpw = T().px.width;
    await ed.renderTextLayer(T());
    if (T().px.width !== tpw) throw new Error("the text rendered again is " + T().px.width + " wide, the turned pixels " + tpw);
    if (ed.tileMode) same(words(T().px), turnedPx, "the text rendered in its orientation against the turned pixels");
    // two turns asked for at once (a double click) run one after the other: a half turn, every store the document's size
    const b2 = words(ed.basePx), w2 = ed.width, h2 = ed.height, s2 = words(ed.sel);
    const both = await Promise.all([ed.turnDocument(1), ed.turnDocument(1)]);
    if (!both[0] || !both[1]) throw new Error("two turns at once: " + JSON.stringify(both) + ", " + ed.status);
    mapped(b2, w2, h2, ed.basePx, 2, "two turns at once, the base");
    mapped(s2, w2, h2, ed.sel, 2, "two turns at once, the selection");
    for (const l of ed.layers) if (l.kind !== "filter" && l.w === ed.width && l.h === ed.height && (l.px.width !== ed.width || l.px.height !== ed.height) && l.px.width * l.h === l.px.height * l.w) throw new Error("two turns at once left " + l.name + " at " + l.px.width + " x " + l.px.height);
    // a render open on ComfyUI blocks a turn (its result lands in the geometry it was made for)
    ed._localRuns = new Set(["t23-prompt"]);
    const blocked = await ed.turnDocument(1);
    ed._localRuns = null;
    if (blocked || !/ComfyUI/.test(ed.status)) throw new Error("a turn with a render open ran: " + ed.status);
    // an edit while the base uploads: nothing is turned, the edit stays
    const upload = ed.uploadBase;
    let release = null;
    ed.uploadBase = (px) => new Promise((resolve, reject) => { release = () => upload.call(ed, px).then(resolve, reject); });
    const w3 = ed.width, b3 = words(ed.basePx);
    const late = ed.turnDocument(1);
    for (let i = 0; i < 50 && !release; i++) await wait(10);
    ed.uploadBase = upload;
    if (!release) throw new Error("the turn never reached its upload");
    await run("select_rect", { x: 5, y: 5, w: 20, h: 20, doc: d.id });
    release();
    if (await late) throw new Error("a turn over an edit made during its upload ran");
    if (ed.width !== w3 || !/changed while/.test(ed.status)) throw new Error("the refused turn left " + ed.width + ", " + ed.status);
    same(words(ed.basePx), b3, "the base after a refused turn");
    out.steps = ed.undoList().slice(-3).map((x) => x.label);
    out.ok = true;
} finally { await run("close_document", { doc: d.id, force: true }); }
return out;
"""),
    ("guides_and_saved_selections_follow_crop_extend_resize", """
// PLAN_0_1_31 §7 (23b step 3): one map (docXf) for what no pixels carry. Crop, extend and resize move the guides (dropped
// when they leave the picture), the saved selections (their xf), the results-history entries and a fixed export size, and
// tell the plugins (the geometry event with its matrix); undo puts each of them back
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = {};
const W = 601, H = 357;
const seen = [];
const onGeom = (e) => { if (e.editor === ed) seen.push({ kind: e.kind, m: e.m, from: e.from, to: e.to, op: e.op }); };
host.on("geometry", onGeom);
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(what + ": " + JSON.stringify(a) + ", not " + JSON.stringify(b)); };
const near = (a, b, tol, what) => { if (!a || a.length !== b.length || a.some((v, i) => Math.abs(v - b[i]) > tol)) throw new Error(what + ": " + JSON.stringify(a) + ", not " + JSON.stringify(b)); };
// the bounds of the saved selection loaded into the picture as it is now
const loaded = async () => { await ed.loadSelection(0); const b = ed.getBounds(); return b ? [b[0], b[1], b[2], b[3]] : null; };
const entry = () => { const h = ed.history.find((x) => x.key === "g23"); return [h.x, h.y, h.w, h.h]; };
try {
    const bc = document.createElement("canvas"); bc.width = W; bc.height = H;
    const bx = bc.getContext("2d"); bx.fillStyle = "#406080"; bx.fillRect(0, 0, W, H); bx.fillStyle = "#e0c040"; bx.fillRect(200, 100, 100, 50);
    await ed.setBaseFromCanvas(bc);
    await run("select_rect", { x: 200, y: 100, w: 100, h: 50, doc: d.id });
    ed.saveSelection();
    await run("select_none", { doc: d.id });
    ed.guides = { x: [20, 100, 580], y: [40] };
    const hc = document.createElement("canvas"); hc.width = 60; hc.height = 30;
    const hx = hc.getContext("2d"); hx.fillStyle = "#0000ff"; hx.fillRect(0, 0, 60, 30);
    ed.history.push({ key: "g23", name: "Result g23", ref: { filename: "none.png", subfolder: "", type: "input" }, x: 300, y: 100, w: 60, h: 30, prompt: "", thumbImg: hc });
    const e = host.exportState ? host.exportState(ed) : null;
    if (e) { e.width = 1200; e.height = 714; }
    const b0 = await loaded();
    await run("select_none", { doc: d.id });
    const n0 = ed.undo.length;
    // crop 50 left, 10 top, 20 right: 531 x 347
    await run("extend_canvas", { left: -50, top: -10, right: -20, doc: d.id });
    if (ed.width !== 531 || ed.height !== 347) throw new Error("the crop made " + ed.width + " x " + ed.height);
    if (ed.undo.length !== n0 + 1) throw new Error("the crop pushed " + (ed.undo.length - n0) + " steps");
    eq(ed.guides, { x: [50, 530], y: [30] }, "the guides after the crop (the one at 20 left the picture)");
    eq(entry(), [250, 90, 60, 30], "the history entry after the crop");
    eq(await loaded(), [b0[0] - 50, b0[1] - 10, b0[2] - 50, b0[3] - 10], "the saved selection after the crop");
    await run("select_none", { doc: d.id });
    eq(ed.docXf, [1, 0, 0, 1, -50, -10], "the document's map after the crop");
    if (e && (e.width || e.height)) throw new Error("a fixed export size survived the crop: " + e.width + " x " + e.height);
    const g = seen[seen.length - 1];
    if (!g || g.kind !== "crop" || JSON.stringify(g.m) !== JSON.stringify([1, 0, 0, 1, -50, -10]) || g.to.width !== 531 || g.op !== undefined) throw new Error("the plugins heard " + JSON.stringify(g));
    // undo: everything as it was (the guide that had left the picture too)
    for (let i = 0; i < 5 && ed.width !== W; i++) await run("undo", { doc: d.id });
    if (ed.width !== W) throw new Error("the undo of the crop left " + ed.width);
    eq(ed.guides, { x: [20, 100, 580], y: [40] }, "the guides after the undo");
    eq(entry(), [300, 100, 60, 30], "the history entry after the undo");
    eq(await loaded(), b0, "the saved selection after the undo");
    await run("select_none", { doc: d.id });
    eq(ed.docXf, [1, 0, 0, 1, 0, 0], "the document's map after the undo");
    if (e && (e.width !== 1200 || e.height !== 714)) throw new Error("the undo did not put the export size back: " + e.width + " x " + e.height);
    // the loads above pushed selection steps, which a redo would not jump over: crop again instead
    await run("extend_canvas", { left: -50, top: -10, right: -20, doc: d.id });
    // resize by two: 1062 x 694
    await ed.resizeImage(1062, 694);
    if (ed.width !== 1062 || ed.height !== 694) throw new Error("the resize made " + ed.width + " x " + ed.height);
    eq(ed.guides, { x: [100, 1060], y: [60] }, "the guides after the resize");
    eq(entry(), [500, 180, 120, 60], "the history entry after the resize");
    near(await loaded(), [(b0[0] - 50) * 2, (b0[1] - 10) * 2, (b0[2] - 50) * 2, (b0[3] - 10) * 2], 2, "the saved selection after the resize");
    await run("select_none", { doc: d.id });
    const gr = seen[seen.length - 1];
    if (!gr || gr.kind !== "resize" || gr.m[0] !== 2 || gr.m[3] !== 2) throw new Error("the plugins heard " + JSON.stringify(gr));
    // extend 30 left, 5 top
    await run("extend_canvas", { left: 30, top: 5, doc: d.id });
    if (ed.width !== 1092 || ed.height !== 699) throw new Error("the extend made " + ed.width + " x " + ed.height);
    eq(ed.guides, { x: [130, 1090], y: [65] }, "the guides after the extend");
    eq(entry(), [530, 185, 120, 60], "the history entry after the extend");
    near(await loaded(), [(b0[0] - 50) * 2 + 30, (b0[1] - 10) * 2 + 5, (b0[2] - 50) * 2 + 30, (b0[3] - 10) * 2 + 5], 2, "the saved selection after the extend");
    await run("select_none", { doc: d.id });
    // a quarter turn after all of it: the chain stays exact; (x, y) of the 1092 x 699 picture goes to (699 - y, x)
    await run("rotate_canvas", { angle: 90, doc: d.id });
    eq(ed.guides, { x: [634], y: [130, 1090] }, "the guides after the turn");
    eq(entry(), [454, 530, 60, 120], "the history entry after the turn");
    eq(ed.history.find((x) => x.key === "g23").orient, { turn: 1, flip: false }, "the entry's orientation");
    const bx1 = (b0[0] - 50) * 2 + 30, by1 = (b0[1] - 10) * 2 + 5, bx2 = (b0[2] - 50) * 2 + 30, by2 = (b0[3] - 10) * 2 + 5;
    near(await loaded(), [699 - by2, bx1, 699 - by1, bx2], 2, "the saved selection after the turn");
    await run("select_none", { doc: d.id });
    // an entry made now survives the undos: it is mapped back with them
    ed.history.push({ key: "late", name: "late", ref: { filename: "none.png", subfolder: "", type: "input" }, x: 10, y: 20, w: 30, h: 40, prompt: "", thumbImg: hc });
    for (let i = 0; i < 60 && ed.undo.length > n0; i++) await run("undo", { doc: d.id });
    if (ed.width !== W || ed.height !== H) throw new Error("all undone left " + ed.width + " x " + ed.height);
    eq(ed.guides, { x: [20, 100, 580], y: [40] }, "the guides after every undo");
    eq(entry(), [300, 100, 60, 30], "the history entry after every undo");
    const o = ed.history.find((x) => x.key === "g23").orient;
    if (o && (o.turn || o.flip)) throw new Error("the entry kept an orientation: " + JSON.stringify(o));
    eq(ed.docXf, [1, 0, 0, 1, 0, 0], "the document's map after every undo");
    // (10, 20, 30, 40) of the turned picture, back through the turn (20, 659, 40, 30), the extend, the resize and the crop
    const late = ed.history.find((x) => x.key === "late");
    near([late.x, late.y, late.w, late.h], [45, 337, 20, 15], 1e-6, "the entry made after the steps");
    if (ed.savedSelections[0].xf) throw new Error("the saved selection kept a map: " + JSON.stringify(ed.savedSelections[0].xf));
    // a saved selection keeps its map through the document's JSON
    await run("extend_canvas", { left: -50, top: -10, doc: d.id });
    eq(JSON.parse(ed.getValue()).selections[0].xf, [1, 0, 0, 1, -50, -10], "a saved selection's map in the document's JSON");
    out.events = seen.map((x) => x.kind);
    out.ok = true;
} finally { host.off("geometry", onGeom); await run("close_document", { doc: d.id, force: true }); }
return out;
"""),
    ("a_text_layer_keeps_its_free_angle", """
// PLAN_0_1_31 §7 (23b step 4): a text turned by any angle stays text (text.angle, drawn at it as vectors); the transform
// tool, the Angle field and set_text turn it; flips negate the angle, turns keep it; distort makes it pixels
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = {};
const TX = await import("./editor/inpaint_text.js");
const settle = async () => { for (let i = 0; i < 100; i++) { if (!ed.layers.some((l) => l._textRendering || l._textTimer)) return; await wait(20); } };
const total = (t) => { const a = ((((+t.angle || 0) + 90 * ((t.turn | 0) & 3)) % 360) + 360) % 360; return a > 180 ? a - 360 : a; };
const start = (l) => { const f = TX.textFrame(l.text.box[0], l.text.box[1], l.text); return [l.x + f.start[0] / f.W * l.w, l.y + f.start[1] / f.H * l.h]; };
const words = (px) => { const a = px.readRect(0, 0, px.width, px.height).data; return new Uint32Array(a.buffer, a.byteOffset, a.length >> 2); };
const sameWords = (a, b, what) => { if (a.length !== b.length) throw new Error(what + ": " + a.length + " against " + b.length + " pixels"); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(what + ": pixel " + i + " differs"); };
try {
    await run("new_canvas", { width: 800, height: 500, doc: d.id });
    const t1 = await run("add_text", { text: "Angle me", x: 100, y: 200, size: 40, doc: d.id });
    await settle();
    const L = () => ed.layers.find((l) => l.id === t1.id);
    const w0 = L().w, h0 = L().h, c0 = [L().x + L().w / 2, L().y + L().h / 2];
    // the transform tool turns it by 30 degrees about its middle
    ed.activeLayerId = t1.id;
    ed.startPending("rotate");
    ed.pending.angle = 30 * Math.PI / 180;
    ed.applyPending();
    await wait(50); await settle();
    let l = L();
    if (l.kind !== "text" || !l.text) throw new Error("the turned text is " + l.kind);
    if (Math.abs(total(l.text) - 30) > 1e-6) throw new Error("the text is turned " + total(l.text) + " degrees");
    const c1 = [l.x + l.w / 2, l.y + l.h / 2];
    if (Math.abs(c1[0] - c0[0]) > 1 || Math.abs(c1[1] - c0[1]) > 1) throw new Error("the middle moved from " + c0 + " to " + c1);
    const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
    if (Math.abs(l.w - (w0 * c30 + h0 * s30)) > 2 || Math.abs(l.h - (w0 * s30 + h0 * c30)) > 2) throw new Error("the turned text is " + l.w + " x " + l.h + " from " + w0 + " x " + h0);
    const corner = l.px.readRect(0, 0, 1, 1).data;
    if (corner[3]) throw new Error("the corner of the turned text's box is not empty");
    if (!ed.textHitAt(l, c1[0], c1[1]) || ed.textHitAt(l, l.x + 1, l.y + 1)) throw new Error("the text tool's hit test does not follow the angle");
    out.turned = [l.w, l.h];
    // more text: the angle stays and so does the corner the text starts at
    const s0 = start(l);
    await run("set_text", { layer: t1.id, text: "Angle me more", doc: d.id });
    await settle();
    l = L();
    const s1 = start(l);
    if (Math.abs(total(l.text) - 30) > 1e-6) throw new Error("an edit changed the angle to " + total(l.text));
    if (Math.abs(s1[0] - s0[0]) > 1.5 || Math.abs(s1[1] - s0[1]) > 1.5) throw new Error("the corner the text starts at moved from " + s0 + " to " + s1);
    // three turns of 10 degrees give the pixels of one of 30: rendered from the description, never resampled
    const t2 = await run("add_text", { text: "Same", x: 50, y: 50, size: 30, doc: d.id });
    const t3 = await run("add_text", { text: "Same", x: 400, y: 50, size: 30, doc: d.id });
    await settle();
    for (const a of [10, 20, 30]) await run("set_text", { layer: t2.id, angle: a, doc: d.id });
    await run("set_text", { layer: t3.id, angle: 30, doc: d.id });
    await settle();
    const A2 = ed.layers.find((x) => x.id === t2.id), A3 = ed.layers.find((x) => x.id === t3.id);
    sameWords(words(A2.px), words(A3.px), "three turns of 10 against one of 30");
    if (A2.w !== A3.w || A2.h !== A3.h) throw new Error("three turns left " + A2.w + " x " + A2.h + ", one " + A3.w + " x " + A3.h);
    // the Angle field's way (a step each) and its undo
    const n0 = ed.undo.length;
    await ed.setTextAngle(A3, 45);
    if (ed.undo.length !== n0 + 1 || Math.abs(total(A3.text) - 45) > 1e-6) throw new Error("the angle change pushed " + (ed.undo.length - n0) + " steps and turned to " + total(A3.text));
    await run("undo", { doc: d.id }); await settle();
    const A3u = ed.layers.find((x) => x.id === t3.id);
    if (Math.abs(total(A3u.text) - 30) > 1e-6) throw new Error("the undo left the angle at " + total(A3u.text));
    sameWords(words(A3u.px), words(A2.px), "the pixels after the undo");
    // 90 degrees in all is a quarter turn: the exact path, no free angle
    await ed.setTextAngle(A3u, 90);
    const q = ed.layers.find((x) => x.id === t3.id);
    if ((q.text.turn | 0) !== 1 || q.text.angle) throw new Error("90 degrees became " + JSON.stringify({ turn: q.text.turn, angle: q.text.angle }));
    // a flip negates the angle, a turn of the document keeps it and adds a quarter
    // an undo puts copies of the layers back: look them up again
    await ed.setTextAngle(ed.layers.find((x) => x.id === t2.id), 20);
    ed.activeLayerId = t2.id;
    ed.flipLayer("h");
    const fl = ed.layers.find((x) => x.id === t2.id);
    if (!fl.text.flip || Math.abs(total(fl.text) + 20) > 1e-6) throw new Error("the flipped text is " + JSON.stringify({ flip: fl.text.flip, turn: fl.text.turn, angle: fl.text.angle }));
    await run("rotate_canvas", { angle: 90, doc: d.id });
    await settle();
    const rt = ed.layers.find((x) => x.id === t2.id);
    if (Math.abs(total(rt.text) - 70) > 1e-6) throw new Error("the document's turn made the text " + total(rt.text));
    await run("undo", { doc: d.id });
    // a masked text keeps its mask, turned into the new box
    const t4 = await run("add_text", { text: "Masked", x: 200, y: 300, size: 48, doc: d.id });
    await settle();
    const M = ed.layers.find((x) => x.id === t4.id);
    await run("select_rect", { x: M.x, y: M.y, w: Math.round(M.w / 2), h: M.h, doc: d.id });
    ed.maskFromSelection(M);
    await run("select_none", { doc: d.id });
    await ed.setTextAngle(M, 45);
    const Mm = ed.layers.find((x) => x.id === t4.id);
    if (Mm.kind !== "text" || !Mm.maskPx || Mm.maskPx.width !== Mm.px.width || Mm.maskPx.height !== Mm.px.height) throw new Error("the turned text's mask is " + (Mm.maskPx ? Mm.maskPx.width + " x " + Mm.maskPx.height : "gone") + " for pixels of " + Mm.px.width + " x " + Mm.px.height);
    const ma = Mm.maskPx.readRect(0, 0, Mm.maskPx.width, Mm.maskPx.height).data;
    let covered = 0;
    for (let i = 3; i < ma.length; i += 4) if (ma[i] > 128) covered++;
    if (covered < ma.length / 4 * 0.15 || covered > ma.length / 4 * 0.85) throw new Error("the turned mask covers " + covered + " of " + ma.length / 4 + " pixels");
    // distort cannot be kept as text: pixels, and the undo brings the text back
    ed.activeLayerId = t4.id;
    ed.startPending("distort");
    ed.applyPending();
    const D1 = ed.layers.find((x) => x.id === t4.id);
    if (D1.kind !== "paint" || D1.text) throw new Error("a distorted text is still " + D1.kind);
    await run("undo", { doc: d.id });
    const D2 = ed.layers.find((x) => x.id === t4.id);
    if (D2.kind !== "text" || !D2.text || Math.abs(total(D2.text) - 45) > 1e-6) throw new Error("the undo of the distort gave " + D2.kind);
    // a new text starts upright; the angle and the box go through the document's JSON
    const t5 = await run("add_text", { text: "Upright", x: 10, y: 400, size: 20, doc: d.id });
    await settle();
    if (ed.layers.find((x) => x.id === t5.id).text.angle) throw new Error("a new text took the last angle");
    const saved = JSON.parse(ed.getValue()).layers.find((x) => x.id === t1.id);
    if (!saved || Math.abs(saved.text.angle - 30) > 1e-6 || !Array.isArray(saved.text.box)) throw new Error("the document keeps " + JSON.stringify(saved && saved.text));
    // the on-canvas editor sits on the turned text
    ed.beginTextEdit(L());
    const tf = ed.textEdit.ta.style.transform;
    ed.endTextEdit(false);
    if (!/rotate\\(30/.test(tf)) throw new Error("the text editor is turned by " + tf);
    const summary = (await run("list_layers", { doc: d.id })).layers.find((x) => x.id === t1.id);
    if (!summary.text || summary.text.angle !== 30) throw new Error("list_layers says " + JSON.stringify(summary.text));
    // add_text with an angle: the corner the text starts at is x, y (the 23b review: it was read from the turned text)
    for (const a of [30, -30, 120]) {
        const ta = await run("add_text", { text: "Corner", x: 300, y: 150, size: 36, angle: a, doc: d.id });
        await settle();
        const la = ed.layers.find((x) => x.id === ta.id), sa = start(la);
        if (Math.abs(sa[0] - 300) > 1.5 || Math.abs(sa[1] - 150) > 1.5) throw new Error("add_text at " + a + " degrees starts at " + sa);
    }
    // twenty turns of 7 degrees keep the middle (no half-pixel walk)
    const t6 = await run("add_text", { text: "Walk", x: 400, y: 300, size: 30, doc: d.id });
    await settle();
    const L6 = () => ed.layers.find((x) => x.id === t6.id);
    const m6 = [L6().x + L6().w / 2, L6().y + L6().h / 2];
    for (let i = 1; i <= 20; i++) await ed.setTextAngle(L6(), 7 * i);
    const m7 = [L6().x + L6().w / 2, L6().y + L6().h / 2];
    if (Math.abs(m7[0] - m6[0]) > 1 || Math.abs(m7[1] - m6[1]) > 1) throw new Error("twenty turns walked the middle from " + m6 + " to " + m7);
    out.ok = true;
} finally { await run("close_document", { doc: d.id, force: true }); }
return out;
"""),
    ("the_document_straightens_and_crops_in_one_step", """
// PLAN_0_1_31 §7 (23b step 5): straighten_canvas turns the whole document by any angle and crops it in one step. Every store
// is the resampler's answer for the document's map (the kernel itself is tools/resample_test.js's), text turns by its
// description, a reference layer moves, the extras follow, and undo / redo give the bytes back
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = {};
const RS = await import("./editor/inpaint_resample.js");
const W = 601, H = 357, DEG = 5;
const words = (px) => { const a = px.readRect(0, 0, px.width, px.height).data; return new Uint32Array(a.buffer, a.byteOffset, a.length >> 2).slice(); };
const same = (a, b, what) => { if (a.length !== b.length) throw new Error(what + ": " + a.length + " against " + b.length + " pixels"); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(what + ": pixel " + i + " differs (" + a[i].toString(16) + " against " + b[i].toString(16) + ")"); };
const near = (a, b, tol, what) => { if (!a || a.length !== b.length || a.some((v, i) => Math.abs(v - b[i]) > tol)) throw new Error(what + ": " + JSON.stringify(a) + ", not " + JSON.stringify(b)); };
const total = (t) => { const a = ((((+t.angle || 0) + 90 * ((t.turn | 0) & 3)) % 360) + 360) % 360; return a > 180 ? a - 360 : a; };
const seen = [];
const onGeom = (e) => { if (e.editor === ed) seen.push({ kind: e.kind, m: e.m }); };
host.on("geometry", onGeom);
try {
    const bc = document.createElement("canvas"); bc.width = W; bc.height = H;
    const bx = bc.getContext("2d"), bi = bx.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; bi.data[i] = x & 255; bi.data[i + 1] = y & 255; bi.data[i + 2] = (x >> 8) * 40 + (y >> 8) * 90; bi.data[i + 3] = 255; }
    bx.putImageData(bi, 0, 0);
    bx.fillStyle = "#ff0000"; bx.fillRect(396, 96, 17, 17);
    await ed.setBaseFromCanvas(bc);
    const L1 = ed.addPaintLayer();
    L1.px.fill([0, 0, W, H], "rgba(20,120,200,0.6)"); L1.px.fill([30, 40, 90, 70], "#ff3300"); ed.markLayerChanged(L1);
    await run("select_rect", { x: 200, y: 60, w: 150, h: 90, doc: d.id });
    ed.maskFromSelection(L1);
    const L2 = ed.addLayer({ name: "small", kind: "paint", ref: null, px: ed.pixels.Layer.empty(240, 160), x: 50, y: 30, w: 120, h: 80, dirty: true });
    L2.px.fill([0, 0, 120, 80], "#33cc66"); L2.px.fill([200, 100, 240, 160], "#ffee00"); ed.markLayerChanged(L2);
    const R = ed.addLayer({ name: "ref", kind: "paint", ref: null, px: ed.pixels.Layer.empty(80, 60), x: 450, y: 240, w: 80, h: 60, dirty: true });
    R.px.fill([0, 0, 80, 60], "#8040c0"); ed.markLayerChanged(R);
    await run("set_layer", { layer: R.id, role: "reference", doc: d.id });
    const fx = await run("add_filter", { type: "grain", doc: d.id });
    await run("select_rect", { x: 400, y: 200, w: 100, h: 100, doc: d.id });
    await run("set_mask", { layer: fx.id, op: "from_selection", doc: d.id });
    const tx = await run("add_text", { text: "Straight", x: 60, y: 250, size: 40, doc: d.id });
    await wait(300);
    await run("select_rect", { x: 10, y: 20, w: 100, h: 50, doc: d.id });
    await run("select_rect", { x: 200, y: 60, w: 150, h: 90, doc: d.id });
    ed.saveSelection();
    await run("select_rect", { x: 100, y: 100, w: 300, h: 150, doc: d.id });
    ed.guides = { x: [5, 300], y: [100] };
    const hc = document.createElement("canvas"); hc.width = 60; hc.height = 30;
    const hx = hc.getContext("2d"); hx.fillStyle = "#0000ff"; hx.fillRect(0, 0, 60, 30);
    ed.history.push({ key: "s23", name: "Result s23", ref: { filename: "none.png", subfolder: "", type: "input" }, x: 300, y: 100, w: 60, h: 30, prompt: "", thumbImg: hc });
    const e = host.exportState ? host.exportState(ed) : null;
    if (e) { e.width = 1000; e.height = 600; }
    if (ed.syncLayers) await ed.syncLayers();
    const F = () => ed.layers.find((l) => l.id === fx.id), T = () => ed.layers.find((l) => l.id === tx.id);
    const Lx = (id) => ed.layers.find((l) => l.id === id);
    const old = { base: ed.basePx, l1: L1.px, m1: L1.maskPx, l2: L2.px, fm: F().maskPx, sel: ed.sel, ref: R.px };
    const before = {}; for (const k of Object.keys(old)) before[k] = words(old[k]);
    const t0 = T(), tc0 = [t0.x + t0.w / 2, t0.y + t0.h / 2], rect0 = { l2: [L2.x, L2.y, L2.w, L2.h], ref: [R.x, R.y, R.w, R.h], text: [t0.x, t0.y, t0.w, t0.h] };
    const frame = ed.fitFrame(DEG, W / H);
    const n0 = ed.undo.length;
    // busy: refused, nothing changes
    ed.providerPending = { s23: true };
    let refused = "";
    try { await run("straighten_canvas", { angle: DEG, doc: d.id }); } catch (err) { refused = String(err.message || err); }
    ed.providerPending = null;
    if (!/running job/.test(refused) || ed.width !== W) throw new Error("a straighten while a job runs was not refused: " + (refused || "it ran"));
    const r = await run("straighten_canvas", { angle: DEG, doc: d.id });
    const [fx0, fy0, nw, nh] = frame;
    if (r.width !== nw || r.height !== nh || ed.width !== nw || ed.height !== nh) throw new Error("the straighten made " + ed.width + " x " + ed.height + ", not " + nw + " x " + nh);
    if (ed.undo.length !== n0 + 1) throw new Error("the straighten pushed " + (ed.undo.length - n0) + " steps");
    const A = RS.xfMul(RS.xfTranslate(-fx0, -fy0), RS.xfRotate(DEG, W / 2, H / 2));
    near(ed.docXf, A, 1e-9, "the document's map");
    const onCanvas = RS.pixelMap(RS.xfInv(A));
    const white = [255, 255, 255];
    same(words(ed.basePx), words(old.base.transformed(onCanvas, nw, nh, { edge: "clamp" })), "the base");
    const [dx, dy] = RS.xfApply(A, 404.5, 104.5);
    const dot = ed.basePx.readRect(Math.floor(dx), Math.floor(dy), 1, 1).data;
    if (dot[0] < 200 || dot[1] > 80) throw new Error("the red square is not where the map puts it: " + Array.from(dot));
    const l1 = Lx(L1.id);
    near([l1.x, l1.y, l1.w, l1.h], [0, 0, nw, nh], 0, "the layer over the whole canvas");
    same(words(l1.px), words(old.l1.transformed(onCanvas, nw, nh, { edge: "clamp" })), "the layer over the whole canvas");
    same(words(l1.maskPx), words(old.m1.transformed(onCanvas, nw, nh, { color: white, edge: "clamp" })), "its mask");
    const l2 = Lx(L2.id);
    const b2 = RS.xfBox(A, 50, 30, 170, 110), rx = Math.floor(b2[0]), ry = Math.floor(b2[1]), rw = Math.ceil(b2[2]) - rx, rh = Math.ceil(b2[3]) - ry;
    near([l2.x, l2.y, l2.w, l2.h], [rx, ry, rw, rh], 0, "the small layer's turned rectangle");
    if (l2.px.width !== rw * 2 || l2.px.height !== rh * 2) throw new Error("the small layer's pixels are " + l2.px.width + " x " + l2.px.height + ", not twice its rectangle");
    const m2 = RS.pixelMap(RS.xfMul(RS.xfInv([0.5, 0, 0, 0.5, 50, 30]), RS.xfMul(RS.xfInv(A), [0.5, 0, 0, 0.5, rx, ry])));
    same(words(l2.px), words(old.l2.transformed(m2, rw * 2, rh * 2)), "the small layer at its own resolution");
    const f1 = F();
    if (f1.w !== nw || f1.h !== nh) throw new Error("the filter layer covers " + f1.w + " x " + f1.h);
    same(words(f1.maskPx), words(old.fm.transformed(onCanvas, nw, nh, { color: white })), "the filter layer's mask");
    same(words(ed.sel), words(old.sel.transformed(onCanvas, nw, nh)), "the selection");
    const t1 = T();
    if (t1.kind !== "text" || Math.abs(total(t1.text) - DEG) > 1e-6) throw new Error("the text is " + t1.kind + " at " + (t1.text && total(t1.text)));
    near([t1.x + t1.w / 2, t1.y + t1.h / 2], RS.xfApply(A, ...tc0), 1, "the text's middle");
    const r1 = Lx(R.id), rc = RS.xfApply(A, rect0.ref[0] + 40, rect0.ref[1] + 30);
    near([r1.x + r1.w / 2, r1.y + r1.h / 2], rc, 1, "the reference layer's middle");
    if (r1.w !== 80 || r1.h !== 60) throw new Error("the reference layer was resized to " + r1.w + " x " + r1.h);
    same(words(r1.px), before.ref, "the reference layer's pixels (moved, not resampled)");
    near([...ed.guides.x, ...ed.guides.y], [300 - fx0, 100 - fy0], 0, "the guides, shifted by the crop (the one at 5 left the picture)");
    const hEntry = ed.history.find((x) => x.key === "s23");
    if (!hEntry.xf) throw new Error("the history entry has no map");
    near([hEntry.x, hEntry.y, hEntry.w, hEntry.h], (() => { const b = RS.xfBox(A, 300, 100, 360, 130); return [b[0], b[1], b[2] - b[0], b[3] - b[1]]; })(), 1e-6, "the history entry's rectangle");
    const u0 = ed.undo.length;
    await ed.restoreResult(hEntry);
    const restored = ed.layers.find((l) => l.name === "Result s23");
    if (!restored || restored.px.width < 60 || restored.x !== Math.floor(hEntry.x)) throw new Error("the entry was restored as " + JSON.stringify(restored && [restored.x, restored.y, restored.px.width, restored.px.height]));
    const centre = restored.px.readRect(restored.px.width >> 1, restored.px.height >> 1, 1, 1).data;
    if (centre[3] !== 255 || centre[2] < 200) throw new Error("the restored entry's middle is " + Array.from(centre));
    // the restore's own step if it pushed one, else the layer taken out by hand (the straighten's step stays on top)
    while (ed.undo.length > u0) await run("undo", { doc: d.id });
    if (ed.layers.includes(restored)) { ed.layers = ed.layers.filter((l) => l !== restored); ed.renderLayers(); }
    if (ed.width !== nw) throw new Error("taking the restore back undid the straighten");
    const u1 = ed.undo.length;
    await ed.loadSelection(0);
    const sb = ed.getBounds(), eb = RS.xfBox(A, 200, 60, 350, 150);
    near([sb[0], sb[1], sb[2], sb[3]], [Math.floor(eb[0]), Math.floor(eb[1]), Math.ceil(eb[2]), Math.ceil(eb[3])], 2, "the saved selection loaded into the straightened picture");
    while (ed.undo.length > u1) await run("undo", { doc: d.id });   // the load
    if (e && (e.width || e.height)) throw new Error("a fixed export size survived the straighten: " + e.width + " x " + e.height);
    const g = seen[seen.length - 1];
    if (!g || g.kind !== "straighten") throw new Error("the plugins heard " + JSON.stringify(g));
    near(g.m, A, 1e-9, "the map the plugins heard");
    const after = { base: words(ed.basePx), l1: words(Lx(L1.id).px), sel: words(ed.sel) };
    // undo: every byte, every place back
    await run("undo", { doc: d.id });
    if (ed.width !== W || ed.height !== H) throw new Error("the undo left " + ed.width + " x " + ed.height);
    same(words(ed.basePx), before.base, "the base after the undo");
    same(words(Lx(L1.id).px), before.l1, "the full layer after the undo");
    same(words(Lx(L1.id).maskPx), before.m1, "its mask after the undo");
    same(words(Lx(L2.id).px), before.l2, "the small layer after the undo");
    same(words(F().maskPx), before.fm, "the filter mask after the undo");
    same(words(ed.sel), before.sel, "the selection after the undo");
    const l2u = Lx(L2.id);
    near([l2u.x, l2u.y, l2u.w, l2u.h], rect0.l2, 0, "the small layer's place after the undo");
    if (T().text.angle || T().text.turn) throw new Error("the text kept a turn after the undo: " + JSON.stringify(T().text));
    near([...ed.guides.x, ...ed.guides.y], [5, 300, 100], 0, "the guides after the undo");
    const hu = ed.history.find((x) => x.key === "s23");
    if (hu.xf) throw new Error("the history entry kept a map after the undo: " + JSON.stringify(hu.xf));
    near([hu.x, hu.y, hu.w, hu.h], [300, 100, 60, 30], 1e-6, "the history entry after the undo");
    near(ed.docXf, [1, 0, 0, 1, 0, 0], 1e-12, "the document's map after the undo");
    if (e && (e.width !== 1000 || e.height !== 600)) throw new Error("the undo did not put the export size back");
    // redo: the same bytes as the straighten made
    await run("redo", { doc: d.id });
    if (ed.width !== nw) throw new Error("the redo left " + ed.width);
    same(words(ed.basePx), after.base, "the base after the redo");
    same(words(Lx(L1.id).px), after.l1, "the full layer after the redo");
    same(words(ed.sel), after.sel, "the selection after the redo");
    await run("undo", { doc: d.id });
    // a render on the user's ComfyUI blocks it; an explicit frame past the turned picture is refused
    ed._localRuns = new Set(["p1"]);
    let blocked = "";
    try { await run("straighten_canvas", { angle: 3, doc: d.id }); } catch (err) { blocked = String(err.message || err); }
    ed._localRuns = new Set();
    if (!/ComfyUI/.test(blocked) || ed.width !== W) throw new Error("a render on ComfyUI did not block the straighten: " + (blocked || "it ran"));
    let outside = "";
    try { await run("straighten_canvas", { angle: 10, x: 0, y: 0, width: W, height: H, doc: d.id }); } catch (err) { outside = String(err.message || err); }
    if (!/past the turned picture/.test(outside) || ed.width !== W) throw new Error("a frame past the turned picture was not refused: " + (outside || "it ran"));
    // an explicit frame and an aspect
    await run("straighten_canvas", { angle: -2, aspect: "1:1", doc: d.id });
    if (ed.width !== ed.height) throw new Error("the 1:1 frame made " + ed.width + " x " + ed.height);
    await run("undo", { doc: d.id });
    // an edit while the base uploads: nothing changes, the edit stays
    const upload = ed.uploadBase;
    let release = null;
    ed.uploadBase = (px) => new Promise((resolve, reject) => { release = () => upload.call(ed, px).then(resolve, reject); });
    const late = ed.straightenDocument({ angle: 4 });
    for (let i = 0; i < 200 && !release; i++) await wait(10);
    ed.uploadBase = upload;
    if (!release) throw new Error("the straighten never reached its upload");
    await run("select_rect", { x: 5, y: 5, w: 20, h: 20, doc: d.id });
    release();
    if (await late) throw new Error("a straighten over an edit made during its upload ran");
    if (ed.width !== W || !/changed while/.test(ed.status)) throw new Error("the refused straighten left " + ed.width + ", " + ed.status);
    same(words(ed.basePx), before.base, "the base after a refused straighten");
    out.frame = frame;
    out.ok = true;
} finally { host.off("geometry", onGeom); await run("close_document", { doc: d.id, force: true }); }
return out;
"""),
    ("the_canvas_frame_waits_for_enter", """
// PLAN_0_1_31 §7 (23b step 6): the Canvas tool's frame is pending. A release applies nothing; Enter, a double click inside
// or Apply does, Esc resets (also in the middle of a drag); a tool switch keeps it, a new picture drops it; aspect
// presets fit the largest frame, the angle turns the preview, the straighten line and a drag outside set it
const d = await run("new_document");
const ed = ednow(d.id);
host.shell.activate(ed);
const out = {};
const W = 800, H = 500;
try {
    await run("new_canvas", { width: W, height: H, doc: d.id });
    ed.setTool("canvas");
    ed.fitView(); ed.draw();
    const rect = ed.canvas.getBoundingClientRect();
    const client = (ix, iy) => { const [sx, sy] = ed.imageToScreen(ix, iy); return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height }; };
    const ev = (type, ix, iy, extra = {}) => new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 23, pointerType: "mouse", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }, client(ix, iy), extra));
    const drag = async (x0, y0, x1, y1, extra = {}, release = true) => {
        ed.canvas.dispatchEvent(ev("pointerdown", x0, y0, extra));
        for (let i = 1; i <= 6; i++) { ed.canvas.dispatchEvent(ev("pointermove", x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6, extra)); await wait(10); }
        if (release) ed.canvas.dispatchEvent(ev("pointerup", x1, y1, extra));
        await wait(30);
    };
    const key = async (k) => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); await wait(50); };
    const settle = async () => { for (let i = 0; i < 200 && (ed._turning || (ed._pendingEdits && ed._pendingEdits.size)); i++) await wait(20); await wait(50); };
    const n0 = ed.undo.length;
    if (!ed.optsBar || ed.optsBar.hidden || !ed.frameAngleInput) throw new Error("the Canvas tool shows no frame bar");
    // 1. a handle dragged in: nothing happens on release
    await drag(W, H / 2, W - 200, H / 2);
    if (ed.width !== W || ed.undo.length !== n0) throw new Error("the release applied the frame: " + ed.width + ", " + (ed.undo.length - n0) + " steps");
    if (!ed.framePending() || ed.frame().w !== W - 200) throw new Error("the frame is " + JSON.stringify(ed.frame()));
    if (!/→ 600 × 500/.test(ed.canvasInfo ? ed.canvasInfo.textContent : "→ 600 × 500")) throw new Error("the Canvas section says " + ed.canvasInfo.textContent);
    // 2. Enter applies, one step; its undo drops nothing it should not
    await key("Enter"); await settle();
    if (ed.width !== W - 200 || ed.undo.length !== n0 + 1) throw new Error("Enter made " + ed.width + " with " + (ed.undo.length - n0) + " steps");
    if (ed.framePending()) throw new Error("the frame stayed after it was applied");
    await run("undo", { doc: d.id }); await settle();
    if (ed.width !== W || ed.framePending()) throw new Error("the undo left " + ed.width + ", frame " + JSON.stringify(ed.frame()));
    // 3. Esc resets it, and in the middle of a drag puts the frame back where it was
    await drag(W / 2, 0, W / 2, 100);
    if (!ed.framePending()) throw new Error("the top handle made no frame");
    const before = { ...ed.frame() };
    const mid = before.y + before.h / 2;   // the right handle sits in the middle of the frame's side
    await drag(W, mid, W - 300, mid, {}, false);
    if (ed.frame().w === before.w) throw new Error("the second drag did not move the frame");
    await key("Escape");
    ed.canvas.dispatchEvent(ev("pointerup", W - 300, mid));
    if (!ed.framePending() || ed.frame().w !== before.w || ed.frame().y !== before.y) throw new Error("Esc during the drag left " + JSON.stringify(ed.frame()));
    await key("Escape");
    if (ed.framePending()) throw new Error("Esc did not reset the frame");
    // 4. a tool switch keeps the frame, a new picture drops it
    await drag(W / 2, H, W / 2, H - 120);
    ed.setTool("paint"); ed.setTool("canvas");
    if (!ed.framePending() || ed.frame().h !== H - 120) throw new Error("a tool switch dropped the frame");
    // 5. a double click inside applies it
    for (let i = 0; i < 2; i++) { ed.canvas.dispatchEvent(ev("pointerdown", 300, 200, { detail: i + 1 })); ed.canvas.dispatchEvent(ev("pointerup", 300, 200, { detail: i + 1 })); await wait(40); }
    await settle();
    if (ed.height !== H - 120) throw new Error("the double click made " + ed.width + " x " + ed.height);
    await run("undo", { doc: d.id }); await settle();
    await drag(W / 2, H, W / 2, H - 80);
    await run("new_canvas", { width: W, height: H, doc: d.id });
    ed.setTool("canvas");
    if (ed.framePending()) throw new Error("a new picture kept the old frame");
    ed.fitView(); ed.draw();
    // 6. an aspect preset fits the largest frame of it; X turns it on its side
    ed.frameAspectSel.value = "1:1"; ed.frameAspectSel.dispatchEvent(new Event("change"));
    let f = ed.frame();
    if (!f || f.w !== H || f.h !== H || f.x !== (W - H) / 2) throw new Error("1:1 fitted " + JSON.stringify(f));
    ed.frameAspectSel.value = "16:9"; ed.frameAspectSel.dispatchEvent(new Event("change"));
    f = ed.frame();
    if (Math.abs(f.w / f.h - 16 / 9) > 0.01 || f.w !== W) throw new Error("16:9 fitted " + JSON.stringify(f));
    await key("x");
    f = ed.frame();
    if (Math.abs(f.h / f.w - 16 / 9) > 0.01 || f.h !== H) throw new Error("X turned 16:9 into " + JSON.stringify(f));
    // a corner drag keeps the aspect
    await drag(f.x + f.w, f.y + f.h, f.x + f.w - 60, f.y + f.h - 40);
    f = ed.frame();
    if (Math.abs(f.h / f.w - 16 / 9) > 0.03) throw new Error("the corner drag lost the aspect: " + JSON.stringify(f));
    ed.frameAspectSel.value = "free"; ed.frameAspectSel.dispatchEvent(new Event("change")); ed.frameAspectFlip = false;
    // 7. an angle turns the preview (the scene is drawn turned) and fits the frame inside; Enter straightens in one step
    const sig0 = ed.sceneSignature();
    ed.frameAngleInput.value = "4"; ed.frameAngleInput.dispatchEvent(new Event("change"));
    f = ed.frame();
    if (f.angle !== 4 || Math.abs(ed.viewTilt() - 4 * Math.PI / 180) > 1e-9 || ed.sceneSignature() === sig0) throw new Error("the angle made " + JSON.stringify(f) + ", tilt " + ed.viewTilt());
    const fit = ed.fitFrame(4, null);
    if (f.x !== fit[0] || f.w !== fit[2] || f.h !== fit[3]) throw new Error("the turned frame is " + JSON.stringify(f) + ", not the largest " + fit);
    ed.draw();
    const n1 = ed.undo.length;
    await key("Enter"); await settle();
    if (ed.width !== fit[2] || ed.height !== fit[3] || ed.undo.length !== n1 + 1) throw new Error("the straighten made " + ed.width + " x " + ed.height + " with " + (ed.undo.length - n1) + " steps");
    await run("undo", { doc: d.id }); await settle();
    ed.fitView(); ed.draw();
    // 8. the straighten line: Ctrl+drag along a horizon that falls by 20 px over 400 turns the picture back by its angle
    await drag(200, 200, 600, 220, { ctrlKey: true });
    f = ed.frame();
    const want = -Math.atan2(20, 400) * 180 / Math.PI;
    if (!f || Math.abs(f.angle - want) > 0.02) throw new Error("the straighten line turned the picture to " + (f && f.angle) + ", not " + want);
    // a steep line is taken for a plumb line
    await key("Escape");
    await drag(300, 100, 310, 400, { ctrlKey: true });
    f = ed.frame();
    const plumb = -(Math.atan2(300, 10) * 180 / Math.PI - 90);
    if (!f || Math.abs(f.angle - plumb) > 0.02) throw new Error("a plumb line turned the picture to " + (f && f.angle) + ", not " + plumb);
    await key("Escape");
    // 9. a drag outside the frame turns the picture about its centre; the frame stays inside
    await drag(W, H / 2, W - 200, H / 2);
    await drag(W - 50, H / 2 - 150, W - 50, H / 2 - 100);
    f = ed.frame();
    if (!f.angle) throw new Error("the drag outside the frame did not turn the picture");
    out.outside = f.angle;
    await key("Escape");
    if (ed.framePending() || ed.viewTilt()) throw new Error("Esc left a turn: " + JSON.stringify(ed.frame()));
    // 10. the Canvas section's sides make the same frame, and Enter in them applies it
    ed.extendInputs.right.value = "-100"; ed.extendInputs.right.dispatchEvent(new Event("input"));
    if (!ed.framePending() || ed.frame().w !== W - 100) throw new Error("the sides made " + JSON.stringify(ed.frame()));
    // 11. while a job runs the frame is not applied and stays; a crop from the command is refused too
    ed.providerPending = { f23: true };
    await key("Enter"); await settle();
    const kept = ed.framePending() && ed.width === W;
    await run("extend_canvas", { right: -50, doc: d.id }).catch(() => {});
    const cropRefused = ed.width === W;
    ed.providerPending = null;
    if (!kept || !cropRefused) throw new Error("a running job did not hold the frame (" + kept + ") or the crop (" + cropRefused + ")");
    await key("Escape");
    // 12. Enter in the angle field applies and gives the keys back to the editor (its value cannot come back on a blur)
    ed.frameAngleInput.focus();
    ed.frameAngleInput.value = "2";
    ed.frameAngleInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    if (document.activeElement === ed.frameAngleInput) throw new Error("Enter left the focus in the angle field");
    if (ed.framePending()) throw new Error("a frame came back after the angle field's apply: " + JSON.stringify(ed.frame()));
    if (+ed.frameAngleInput.value !== 0) throw new Error("the angle field still says " + ed.frameAngleInput.value);
    await run("undo", { doc: d.id }); await settle();
    // 13. a fitted frame is always inside (1920 x 1080 at 1.79 degrees was refused before the 23b review)
    await run("new_canvas", { width: 1920, height: 1080, doc: d.id });
    const ff = ed.fitFrame(1.79, null);
    await run("straighten_canvas", { angle: 1.79, aspect: "free", doc: d.id });
    if (ed.width !== ff[2] || ed.height !== ff[3]) throw new Error("the fitted frame " + ff + " was not taken: " + ed.width + " x " + ed.height + ", " + ed.status);
    out.ok = true;
} finally { await run("close_document", { doc: d.id, force: true }); }
return out;
"""),
    ("cleanup", """
for (const id of [window.__tv, window.__t3, window.__t2, window.__t]) { try { await run("close_document", { doc: id }); } catch (_) { /* gone */ } }
return "ok";
"""),
]

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    %s
})()"""


BACKEND_SWEEP = """(async () => {
    const T = await import("./editor/inpaint_tiles.js");
    const bad = [];
    for (const ed of window.__host.editors()) {
        if (typeof ed.heldPixels !== "function") continue;
        for (const p of ed.heldPixels()) if (T.isTilePixels(p) !== !!ed.tileMode) bad.push([ed.node && ed.node.id, p.constructor.name, p.width, p.height]);
    }
    return bad;
})()"""


async def run_all(c):
    # a modal <dialog> left open makes everything outside it inert, and the focus steps
    # below would fail for a reason that has nothing to do with the editor
    await c.eval("(async () => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; return 1; })()")
    await c.eval("window.__exportPath = %s; 1" % json.dumps(os.path.join(os.environ.get("TEMP", os.getcwd()), "scumble_editor_test_export.png")))
    ok = True
    # SCUMBLE_EDITOR_ONLY=name,name: the first step (it opens the test document), those steps and the cleanup, for iterating on
    # a step; a gate run leaves it unset
    only = set(filter(None, os.environ.get("SCUMBLE_EDITOR_ONLY", "").split(",")))
    for name, body in STEPS:
        if only and name not in only and name not in (STEPS[0][0], "cleanup"):
            continue
        try:
            res = await (body(c) if callable(body) else c.eval(PRE % body, timeout=180))
            # after every step: every pixels object an open editor holds is of that editor's backend (a site
            # that makes pixels with the other backend's classes, a flip or an undo restore, is found here)
            mixed = await c.eval(BACKEND_SWEEP)
            if mixed:
                raise Exception("pixels of the other backend held after the step: %s" % json.dumps(mixed)[:400])
            print("[ok] %s: %s" % (name, json.dumps(res)[:4000 if only else 280]))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] %s: %s" % (name, err))
            break
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:200])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
