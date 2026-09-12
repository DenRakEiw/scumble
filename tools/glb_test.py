"""GLB layer plugin test against the running app (see tools/cdp.py for the setup).

No ComfyUI and no key needed. Writes a small cube as a valid glTF 2.0 binary (an embedded
buffer, positions, normals, indices, one material), then: glb.place through the command core
with a depth layer, the layer's size and position against the parameters, the alpha inside
and outside the cube's silhouette, the colour, the depth layer's role and its near / far
values, a second object at another position, glb.edit replacing rather than stacking, the
dialog opened through the action and closed with a real Escape, and the objects surviving a
reload (the file in the local store, the parameters in the plugin's storage).

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
    const px = (cv, x, y) => Array.from(cv.getContext("2d").getImageData(Math.round(x), Math.round(y), 1, 1).data);
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
const cw = lay.canvas.width, ch = lay.canvas.height;
const centre = px(lay.canvas, cw / 2, ch / 2), corner = px(lay.canvas, 1, 1);
if (centre[3] < 250) throw new Error("the silhouette's centre is transparent: " + centre);
if (centre[0] < 60 || centre[0] <= centre[1] + 20) throw new Error("the cube is not red: " + centre);
if (corner[3] !== 0) throw new Error("the corner of the layer is not transparent: " + corner);
if (!r.depthLayer) throw new Error("no depth layer");
const D = r.depthLayer;
if (D.role !== "control" || D.w !== 1200 || D.h !== 800 || D.x !== 0 || D.y !== 0) throw new Error("depth layer " + JSON.stringify(D));
const dep = ed.layers.find((l) => l.id === D.id);
const ks = dep.canvas.width / 1200;
const dc = px(dep.canvas, cx * ks, cy * ks), de = px(dep.canvas, (L.x + L.w * 0.08) * ks, cy * ks), far = px(dep.canvas, 20 * ks, 20 * ks);
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
