"""GLB layer plugin test against the running app (see tools/cdp.py for the setup).

No ComfyUI and no key needed. Writes a small cube as a valid glTF 2.0 binary (an embedded
buffer, positions, normals, indices, one material), then: glb.place through the command core
with a depth layer, the layer's size and position against the parameters, the alpha inside
and outside the cube's silhouette, the colour, the depth layer's role and its near / far
values, a second object at another position, glb.edit replacing rather than stacking, the
dialog opened through the action and closed with a real Escape, and the objects surviving a
reload (the file in the local store, the parameters in the plugin's storage). In a document of
its own: an object's frame following a crop, a resize and a quarter turn of the whole picture
(and a straighten's matrix sent by hand), glb.edit rendering it where the layer went.

    python tools/glb_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import struct
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

OUT = os.path.join(tempfile.gettempdir(), "scumble_glb_test")


def cube_glb(color=(0.85, 0.2, 0.15)):
    """A unit cube, 24 vertices with face normals, as GLB bytes."""
    faces = [
        ((0, 0, 1), [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]),
        ((0, 0, -1), [(1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)]),
        ((1, 0, 0), [(1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1)]),
        ((-1, 0, 0), [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)]),
        ((0, 1, 0), [(-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)]),
        ((0, -1, 0), [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)]),
    ]
    pos, nrm, idx = [], [], []
    for n, quad in faces:
        base = len(pos)
        for v in quad:
            pos.append(tuple(c * 0.5 for c in v))
            nrm.append(n)
        idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    pos_b = b"".join(struct.pack("<3f", *p) for p in pos)
    nrm_b = b"".join(struct.pack("<3f", *n) for n in nrm)
    idx_b = b"".join(struct.pack("<H", i) for i in idx)
    if len(idx_b) % 4:
        idx_b += b"\0\0"
    bin_b = pos_b + nrm_b + idx_b
    gltf = {
        "asset": {"version": "2.0", "generator": "scumble glb_test"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "cube"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "material": 0}]}],
        "materials": [{"name": "red", "pbrMetallicRoughness": {"baseColorFactor": [*color, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.6}}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos_b), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos_b), "byteLength": len(nrm_b), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos_b) + len(nrm_b), "byteLength": len(idx_b), "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(pos), "type": "VEC3", "min": [-0.5, -0.5, -0.5], "max": [0.5, 0.5, 0.5]},
            {"bufferView": 1, "componentType": 5126, "count": len(nrm), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5123, "count": len(idx), "type": "SCALAR"},
        ],
        "buffers": [{"byteLength": len(bin_b)}],
    }
    json_b = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_b += b" " * ((4 - len(json_b) % 4) % 4)
    total = 12 + 8 + len(json_b) + 8 + len(bin_b)
    return (b"glTF" + struct.pack("<II", 2, total) + struct.pack("<I", len(json_b)) + b"JSON" + json_b
            + struct.pack("<I", len(bin_b)) + b"BIN\0" + bin_b)


PRE = """(async () => {
    const raw = await import('./commands.js'); const c = (n, a) => raw.commands.run(n, a || {});
    const host = (await import('./editor/host.js')).host;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ednow = () => host.editors().find((e) => e.node.id === window.__gDoc) || window.editor;
    const px = (p, x, y) => Array.from(p.readRect(Math.round(x), Math.round(y), 1, 1).data);   // a layer's pixels (LayerPixels)
    %s
})()"""

STEPS = [
    ("plugin_loaded", """
const P = await import("./plugins.js");
const p = (await P.pluginHost.list()).find((x) => x.id === "glb");
if (!p) throw new Error("glb plugin not listed");
if (p.error) throw new Error("glb plugin error: " + p.error);
const cmds = (await c("list_commands")).commands.map((x) => x.name);
for (const n of ["glb.place", "glb.edit", "glb.info"]) if (!cmds.includes(n)) throw new Error("command missing: " + n);
const d = await c("new_document");
window.__gDoc = d.id;
host.shell.activate(ednow());
await c("new_canvas", { width: 1200, height: 800, doc: d.id });
return { defaults: (await c("glb.info", { doc: d.id })).defaults.depth };
"""),
    ("place_with_depth_layer", """
const ed = ednow();
const r = await c("glb.place", { path: window.__glbPath, position: { x: 0.5, y: 0.5 }, depth: 3, rotation: { x: 20, y: 35, z: 0 }, scale: 1, shadow: false, depth_layer: true, doc: window.__gDoc });
const L = r.layer;
if (L.name !== "cube") throw new Error("name " + L.name);
const cx = L.x + L.w / 2, cy = L.y + L.h / 2;
if (Math.abs(cx - 600) > 24 || Math.abs(cy - 400) > 24) throw new Error("the object is not centred: " + cx + "," + cy + " (" + JSON.stringify(L) + ")");
// the frame is 2 * 3 * tan(20 deg) = 2.18 units high at distance 3, a tilted unit cube about 1.5 units: two thirds of 800 px
if (L.h < 380 || L.h > 700 || L.w < 380 || L.w > 700) throw new Error("size " + L.w + "x" + L.h);
const lay = ed.layers.find((l) => l.id === L.id);
const cw = lay.px.width, ch = lay.px.height;
const centre = px(lay.px, cw / 2, ch / 2), corner = px(lay.px, 1, 1);
if (centre[3] < 250) throw new Error("the silhouette's centre is transparent: " + centre);
if (centre[0] < 60 || centre[0] <= centre[1] + 20) throw new Error("the cube is not red: " + centre);
if (corner[3] !== 0) throw new Error("the corner of the layer is not transparent: " + corner);
if (!r.depthLayer) throw new Error("no depth layer");
const D = r.depthLayer;
if (D.role !== "control" || D.w !== 1200 || D.h !== 800 || D.x !== 0 || D.y !== 0) throw new Error("depth layer " + JSON.stringify(D));
const dep = ed.layers.find((l) => l.id === D.id);
const ks = dep.px.width / 1200;
const dc = px(dep.px, cx * ks, cy * ks), de = px(dep.px, (L.x + L.w * 0.08) * ks, cy * ks), far = px(dep.px, 20 * ks, 20 * ks);
if (dc[0] < 128) throw new Error("the nearest part of the cube is not bright in the depth layer: " + dc);
if (de[0] >= dc[0] - 10) throw new Error("the cube's side is not farther than its front edge: centre " + dc + " edge " + de);
if (far[0] !== 0 || far[3] !== 255) throw new Error("outside the object the depth frame is not black: " + far);
window.__gLayer = L.id; window.__gDepth = D.id; window.__gFile = r.ref.filename;
return { layer: [L.x, L.y, L.w, L.h], centre, depthCentre: dc[0], depthEdge: de[0], render: r.render };
"""),
    ("second_object_and_edit", """
const ed = ednow();
const r2 = await c("glb.place", { filename: window.__gFile, position: { x: 0.25, y: 0.3 }, depth: 4, rotation: { x: 0, y: 0, z: 0 }, shadow: true, depth_layer: false, name: "second", doc: window.__gDoc });
const L2 = r2.layer;
const cx = L2.x + L2.w / 2, cy = L2.y + L2.h / 2;
if (Math.abs(cx - 300) > 24 || Math.abs(cy - 240) > 40) throw new Error("second object not at 25 % / 30 %: " + cx + "," + cy);
const count = () => ed.layers.filter((l) => ["cube", "second"].includes(l.name)).length;
if (count() !== 2) throw new Error("layers " + count());
const before = ed.layers.find((l) => l.id === window.__gLayer);
const w0 = before.w, h0 = before.h;
const e = await c("glb.edit", { layer: window.__gLayer, rotation: { x: 0, y: 0, z: 0 }, doc: window.__gDoc });
if (e.layer.id !== window.__gLayer) throw new Error("edit made a new layer");
if (count() !== 2) throw new Error("edit stacked a layer: " + count());
const after = ed.layers.find((l) => l.id === window.__gLayer);
if (after.w === w0 && after.h === h0) throw new Error("the box did not change with the rotation");
// a cube seen face on: the silhouette is a square
if (Math.abs(after.w - after.h) > 3) throw new Error("face on, the cube should be square: " + after.w + "x" + after.h);
if (!ed.layers.some((l) => l.id === window.__gDepth)) throw new Error("the depth layer vanished on edit");
const info = await c("glb.info", { doc: window.__gDoc });
if (info.objects.length !== 2) throw new Error("info lists " + info.objects.length);
window.__gLayer2 = L2.id;
return { second: [L2.x, L2.y, L2.w, L2.h], edited: [after.w, after.h], objects: info.objects.map((o) => o.name) };
"""),
    ("frame_follows_crop_resize_and_turn", """
// PLAN_0_1_31 §7 (23b): a 3D object keeps its place through the whole picture's geometry changes. Its frame
// (params.frame { w, h, m }: the upright render frame and the matrix from it to the document) takes every change's
// matrix on (the editor's "geometry" event), and glb.edit renders it where the layer went, at the picture's density,
// parts outside the picture kept (a crop keeps pixels outside too). An undo of the change puts the frame back without an
// event. A straighten's matrix is sent by hand (the editor's straighten is a later step): the render drawn rotated.
// Its own document; the one of the other steps is active again after it.
const d = await c("new_document");
const ed = host.editors().find((e) => e.node.id === d.id);
host.shell.activate(ed);
await c("new_canvas", { width: 1200, height: 800, doc: d.id });
const seen = [];
const off = host.on("geometry", (e) => { if (e.editor === ed) seen.push({ kind: e.kind, m: e.m, op: e.op }); });
const out = {};
const near = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const L = (id) => ed.layers.find((q) => q.id === id);
const rect = (id) => { const l = L(id); return [l.x, l.y, l.w, l.h]; };
const frameOf = async (id) => (await c("glb.info", { doc: d.id })).objects.find((o) => o.layer === id).params.frame;
const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
// the alpha-weighted centre of an object's pixels, in document pixels
const centroid = (id) => {
    const l = L(id), w = l.px.width, h = l.px.height, a = l.px.readRect(0, 0, w, h).data;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const q = a[(y * w + x) * 4 + 3]; if (q) { sx += (x + 0.5) * q; sy += (y + 0.5) * q; n += q; } }
    return [l.x + sx / n * (l.w / w), l.y + sy / n * (l.h / h)];
};
const edit = async (id) => { const e = await c("glb.edit", { layer: id, doc: d.id }); if (e.layer.id !== id) throw new Error("glb.edit made a new layer"); return e; };
try {
    const r = await c("glb.place", { filename: window.__gFile, position: { x: 0.3, y: 0.5 }, depth: 3, rotation: { x: 20, y: 35, z: 0 }, shadow: false, depth_layer: true, doc: d.id });
    const id = r.layer.id, depthId = r.depthLayer.id;
    let f = await frameOf(id);
    if (!f || f.w !== 1200 || f.h !== 800 || !near(f.m, [1, 0, 0, 1, 0, 0], 0)) throw new Error("a new object's frame is " + JSON.stringify(f));
    const r0 = rect(id), c0 = centroid(id);
    // (1) a crop through the object: 300 px off the left (the cube spans about 100..620), 40 off the top -> 880 x 700
    await c("extend_canvas", { left: -300, top: -40, right: -20, bottom: -60, doc: d.id });
    if (ed.width !== 880 || ed.height !== 700) throw new Error("the crop made " + ed.width + " x " + ed.height);
    f = await frameOf(id);
    if (!f || f.w !== 1200 || f.h !== 800 || !near(f.m, [1, 0, 0, 1, -300, -40], 1e-9)) throw new Error("the crop left the frame at " + JSON.stringify(f));
    // its undo puts the frame back, its redo the cropped one (no event either way)
    await c("undo", { doc: d.id });
    f = await frameOf(id);
    if (ed.width !== 1200 || !near(f.m, [1, 0, 0, 1, 0, 0], 0)) throw new Error("the crop's undo left " + ed.width + " px and the frame " + JSON.stringify(f));
    await c("redo", { doc: d.id });
    f = await frameOf(id);
    if (ed.width !== 880 || !near(f.m, [1, 0, 0, 1, -300, -40], 1e-9)) throw new Error("the crop's redo left " + ed.width + " px and the frame " + JSON.stringify(f));
    const shifted = [r0[0] - 300, r0[1] - 40, r0[2], r0[3]];
    if (!near(rect(id), shifted, 0)) throw new Error("the crop put the layer at " + rect(id) + ", not " + shifted);
    await edit(id);
    out.crop = { before: shifted, edited: rect(id) };
    if (!near(rect(id), shifted, 1)) throw new Error("Edit after the crop rendered the object at " + rect(id) + ", the layer was at " + shifted);
    if (!(L(id).x < 0)) throw new Error("the part of the object the crop cut off was not kept: the layer starts at " + L(id).x);
    if (Math.abs(L(id).px.width - L(id).w) > 1) throw new Error("Edit after the crop rendered at " + L(id).px.width + " px for " + L(id).w);
    const cc = centroid(id);
    if (!near(cc, [c0[0] - 300, c0[1] - 40], 0.75)) throw new Error("the object's centre after the crop's edit is " + cc + ", not " + [c0[0] - 300, c0[1] - 40]);
    // the depth layer covers the cropped picture again, bright on the object, black far from it
    const D = L(depthId);
    if (D.x !== 0 || D.y !== 0 || D.w !== 880 || D.h !== 700) throw new Error("the depth layer after the crop's edit is at " + [D.x, D.y, D.w, D.h]);
    const ks = D.px.width / 880;
    const dc = px(D.px, cc[0] * ks, cc[1] * ks), far = px(D.px, 860 * ks, 20 * ks);
    if (dc[0] < 100 || far[0] !== 0 || far[3] !== 255) throw new Error("the depth layer after the crop: centre " + dc + ", far " + far);
    // (2) a resize to half: the frame scales, Edit renders at the new density where the editor scaled the layer to
    const c1 = centroid(id);
    await ed.resizeImage(440, 350);
    f = await frameOf(id);
    if (!near(f.m, [0.5, 0, 0, 0.5, -150, -20], 1e-9)) throw new Error("the resize left the frame at " + JSON.stringify(f));
    const scaled = rect(id);
    await edit(id);
    out.resize = { before: scaled, edited: rect(id), px: [L(id).px.width, L(id).px.height] };
    if (!near(rect(id), scaled, 2)) throw new Error("Edit after the resize rendered the object at " + rect(id) + ", the layer was at " + scaled);
    if (Math.abs(L(id).px.width - L(id).w) > 1) throw new Error("Edit after the resize rendered at " + L(id).px.width + " px for " + L(id).w + " (not at the picture's density)");
    const c2 = centroid(id);
    if (!near(c2, [c1[0] / 2, c1[1] / 2], 1.5)) throw new Error("the object's centre after the resize's edit is " + c2 + ", not " + [c1[0] / 2, c1[1] / 2]);
    if (L(depthId).px.width !== 440 || L(depthId).w !== 440) throw new Error("the depth layer after the resize's edit: " + L(depthId).px.width + " px for " + L(depthId).w);
    // (3) a quarter turn: the editor turns the layer's pixels exactly; Edit renders the same pixels turned
    await c("rotate_canvas", { angle: 90, doc: d.id });
    f = await frameOf(id);
    const wantM = mul([0, 1, -1, 0, 350, 0], [0.5, 0, 0, 0.5, -150, -20]);
    if (!near(f.m, wantM, 1e-9)) throw new Error("the turn left the frame at " + JSON.stringify(f) + ", not " + wantM);
    const turnedRect = rect(id), turnedC = centroid(id);
    await edit(id);
    out.turn = { before: turnedRect, edited: rect(id) };
    if (!near(rect(id), turnedRect, 1)) throw new Error("Edit after the turn rendered the object at " + rect(id) + ", the layer was at " + turnedRect);
    if (!near(centroid(id), turnedC, 0.75)) throw new Error("the object's centre after the turn's edit is " + centroid(id) + ", not " + turnedC);
    out.kinds = seen.map((e) => e.kind);
    if (JSON.stringify(out.kinds) !== JSON.stringify(["crop", "resize", "turn"])) throw new Error("the editor sent " + JSON.stringify(seen) + " (one event per change, none for undo and redo)");
    if (seen.some((e) => !Array.isArray(e.m) || e.m.length !== 6) || seen[2].op !== 1 || seen[0].op !== undefined) throw new Error("the events: " + JSON.stringify(seen));
    // (4) a straighten's matrix, sent by hand: 10 degrees clockwise about the picture's centre, same size. The render
    // is drawn rotated (a smoothed draw): the object's centre turns about the picture's centre
    const W = ed.width, H = ed.height, t = 10 * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
    const m = [co, si, -si, co, W / 2 - co * W / 2 + si * H / 2, H / 2 - si * W / 2 - co * H / 2];
    const before = f.m, c3 = centroid(id);
    host.emit("geometry", { editor: ed, kind: "straighten", m, from: { width: W, height: H }, to: { width: W, height: H } });
    f = await frameOf(id);
    if (!near(f.m, mul(m, before), 1e-9)) throw new Error("the straighten left the frame at " + JSON.stringify(f));
    await edit(id);
    const c4 = centroid(id), want4 = [m[0] * c3[0] + m[2] * c3[1] + m[4], m[1] * c3[0] + m[3] * c3[1] + m[5]];
    out.straighten = { rect: rect(id), centre: c4, want: want4 };
    if (!near(c4, want4, 2)) throw new Error("the straightened object's centre is " + c4 + ", not " + want4);
    out.ok = true;
} finally {
    off();
    await c("close_document", { doc: d.id, force: true });
    host.shell.activate(ednow());
}
return out;
"""),
    ("dialog_opens_and_escape_closes_it", """
const ed = ednow();
await c("set_active_layer", { layer: window.__gLayer, doc: window.__gDoc });
window.__gDialog = c("run_action", { id: "glb.edit", doc: window.__gDoc });   // resolves when the dialog closes
await wait(600);
const dlg = document.querySelector("dialog.glb-dialog[open]");
if (!dlg) throw new Error("the dialog did not open (" + ed.status + ")");
const sliders = dlg.querySelectorAll("input[type=range]").length, ticks = dlg.querySelectorAll("input[type=checkbox]").length;
const view = dlg.querySelector("canvas");
const d = view.getContext("2d").getImageData(0, 0, view.width, view.height).data;
let reddish = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 100 && d[i] > d[i + 1] + 40 && d[i] > d[i + 2] + 40) reddish++;   // the lit face is (210, 117, 100)
if (sliders < 10 || ticks !== 2) throw new Error("dialog controls: " + sliders + " sliders, " + ticks + " ticks");
if (reddish < 500) throw new Error("the preview shows no red cube: " + reddish);
return { sliders, ticks, reddish, view: [view.width, view.height] };
"""),
]

AFTER_ESCAPE = """
const open = !!document.querySelector("dialog.glb-dialog[open]");
if (open) throw new Error("still open after Escape");
const r = await window.__gDialog;
if (r.result !== null) throw new Error("Escape did not cancel: " + JSON.stringify(r));
return { closed: true };
"""

AFTER_RELOAD = """
const ed = ednow();
if (!ed || !ed.loaded && !ed.base) throw new Error("the document was not restored");
const info = await c("glb.info", { doc: window.__gDoc });
if (info.objects.length !== 2) throw new Error("after the reload info lists " + info.objects.length + " objects");
const e = await c("glb.edit", { layer: window.__gLayer2, rotation: { y: 45 }, doc: window.__gDoc });
if (e.layer.id !== window.__gLayer2) throw new Error("edit after reload made a new layer");
return { objects: info.objects.map((o) => o.name), edited: [e.layer.w, e.layer.h] };
"""


async def main():
    sys.stdout.reconfigure(encoding="utf-8")
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "cube.glb")
    with open(path, "wb") as f:
        f.write(cube_glb())

    async def run(cdp):
        ev = cdp.eval
        await ev("(() => { window.__log = window.__log || []; return 1; })()")
        await ev("window.__glbPath = %s; 1" % json.dumps(path))
        failed = 0
        for name, body in STEPS:
            try:
                res = await ev(PRE % body, timeout=180)
                print(f"PASS {name}: {json.dumps(res)[:300]}")
            except Exception as err:  # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {err}")
                try:
                    print("  console:", (await ev("JSON.stringify((window.__log || []).slice(-8))"))[:1500])
                except Exception:  # noqa: BLE001
                    pass
                break
        if failed:
            print("RESULT FAIL")
            return False
        try:
            for kind in ("keyDown", "keyUp"):
                await cdp.call("Input.dispatchKeyEvent", type=kind, key="Escape", code="Escape", windowsVirtualKeyCode=27, nativeVirtualKeyCode=27)
            await asyncio.sleep(0.3)
            print(f"PASS escape_closes_the_dialog: {json.dumps(await ev(PRE % AFTER_ESCAPE, timeout=30))}")
            ids = await ev("JSON.stringify([window.__gDoc, window.__gLayer, window.__gLayer2, window.__gDepth])")
            # the layers' pixels reach the local store asynchronously after a save: wait for their refs
            saved = await ev("""(async () => { const h = (await import('./editor/host.js')).host; const ed = h.editors().find((e) => e.node.id === window.__gDoc);
                await ed.syncLayers();          // dirty layers into the local store (the autosave does this on its own timer)
                const ok = ed.layers.every((l) => l.ref);
                h.saveAll(); await new Promise((r) => setTimeout(r, 400));
                setTimeout(() => location.reload(), 50);
                return ok; })()""", timeout=30)
            if not saved:
                raise RuntimeError("the layers were not saved to the local store within 10 s")
            await asyncio.sleep(8)
            await ev("[window.__gDoc, window.__gLayer, window.__gLayer2, window.__gDepth] = %s; 1" % ids)
            print(f"PASS objects_survive_a_reload: {json.dumps(await ev(PRE % AFTER_RELOAD, timeout=120))}")
            await ev(PRE % 'await c("close_document", { doc: window.__gDoc, force: true }); return 1;')
        except Exception as err:  # noqa: BLE001
            print(f"FAIL: {err!r}")
            print("RESULT FAIL")
            return False
        print("RESULT PASS")
        return True

    return await session(run)


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()) else 1)
