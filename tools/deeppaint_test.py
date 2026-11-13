"""Deep paint's layer gate (docs/PLAN_SURFACE_PAINT.md SP4): the filter layer `surface` whose own pixels are the paint.

On synthetic maps (the light a ramp across, 0.3 .. 1.2 after sScale; the reflections a ramp down, 0 .. 0.08), a
640 x 400 gradient picture, paint in two rectangles (opaque, half transparent):
  * with no paint the picture goes through byte for byte; where nothing is painted it stays byte for byte;
  * painted pixels are mix(B, P S + k R, a) in linear light within one level (k = Keep reflections), the maps sampled
    bilinear at the pixel's centre (an own bilinear here, not the filter's);
  * the GPU path ran, the CPU twin within one level of it, the program (the export's bands) the same bytes as the pass;
  * Keep reflections 0, a layer mask (the masked half is the picture), opacity, a hidden layer, no maps (the picture);
  * a quarter turn turns the paint with the picture (the turned result within one level) and its undo gives the bytes
    back; a crop keeps the paint in place; a resize remakes it at the new size; undo of each;
  * the type picker: set_filter and add_filter refuse to turn anything into or out of Deep paint;
  * .scumble save and open and the autosave restore give the same bytes; the header asks for reader 7.

Gate `deeppaint` (tools/run_gates.sh runs tools/deeppaint_test.py against the instance on SCUMBLE_CDP_PORT).
"""
import asyncio
import json
import os
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

JS = r"""
(async () => {
    const shell = await import("./shell.js");
    const { host } = await import("./editor/host.js");
    const { makeMap } = await import("./editor/inpaint_maps.js");
    const { applyFilter } = await import("./editor/inpaint_filters.js");
    const { applyFilterGL, glToCanvas } = await import("./editor/inpaint_filters_gl.js");
    const fails = [];
    const check = (name, ok, info) => { if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : "")); };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const settle = async (ed) => { await ed.mipsSettled(); await wait(150); };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const diff = (a, b) => { if (!a || !b || a.length !== b.length) return { max: 999, n: -1 }; let m = 0, n = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > m) m = d; } } return { max: m, n }; };
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const srgb = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

    const W = 640, H = 400;
    const ed = shell.newDocument();
    shell.activate(ed);
    await wait(250);
    ed.resizeCanvas();
    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#284868"); g.addColorStop(1, "#e8b080");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(base, { keepLayers: false });
    await settle(ed);
    const bd = base.getContext("2d").getImageData(0, 0, W, H).data;
    const all = async (e = ed) => (await e.readBoxBytes([0, 0, e.width, e.height], { forRun: true })).data;

    // no maps: refused
    check("no layer without the maps", ed.addSurfaceLayer() === null && /surface maps/i.test(ed.status), ed.status);

    // the maps: S ramps across (stored 0.25 .. 1 of sScale 1.2), R ramps down (0 .. 0.08); smaller than the picture
    const mw = 80, mh = 50, n = mw * mh;
    const sd = new Uint16Array(n * 3), rd = new Uint16Array(n * 3), nd = new Uint8Array(n * 4).fill(255);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
        const i = y * mw + x;
        for (let c = 0; c < 3; c++) {
            sd[3 * i + c] = Math.round(65535 * (0.25 + 0.75 * x / (mw - 1)) * (c === 1 ? 0.9 : 1));
            rd[3 * i + c] = Math.round(65535 * 0.08 * y / (mh - 1));
        }
    }
    const xf = [W, 0, 0, H, 0, 0];
    const sScale = 1.2;
    await ed.setMaps({
        shading: makeMap("shading", mw, mh, sd, xf, { sScale, fp: "t" }, null, "rgb16"),
        residual: makeMap("residual", mw, mh, rd, xf, { fp: "t" }, null, "rgb16"),
        normals: makeMap("normals", mw, mh, nd, xf, { fp: "t" }, null, "rgba8"),
    });
    const bil = (d, x, y, c) => {   // the map at map pixel (x, y), centres at + 0.5, edge clamp
        const qx = x - 0.5, qy = y - 0.5, x0 = Math.floor(qx), y0 = Math.floor(qy), fx = qx - x0, fy = qy - y0;
        const cl = (v, m) => Math.max(0, Math.min(m - 1, v));
        const at = (xx, yy) => d[3 * (cl(yy, mh) * mw + cl(xx, mw)) + c] / 65535;
        return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    };
    const expect = (paint, k = 1, mask = null) => {
        const out = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x;
            const a = (paint[4 * i + 3] / 255) * (mask ? mask(x, y) : 1);
            const mx = (x + 0.5) * mw / W, my = (y + 0.5) * mh / H;
            for (let c = 0; c < 3; c++) {
                if (!a) { out[4 * i + c] = bd[4 * i + c]; continue; }
                const b = lin(bd[4 * i + c]);
                const t = lin(paint[4 * i + c]) * bil(sd, mx, my, c) * sScale + k * bil(rd, mx, my, c);
                out[4 * i + c] = Math.round(srgb(Math.max(0, Math.min(1, b + (t - b) * a))));
            }
            out[4 * i + 3] = 255;
        }
        return out;
    };

    const L = ed.addSurfaceLayer();
    check("the layer", L && L.kind === "filter" && L.filter === "surface" && L.px && L.px.width === W && L.px.height === H, L && [L.kind, L.filter]);
    check("nothing painted: the picture byte for byte", diff(await all(), bd).max === 0, diff(await all(), bd));

    const paintC = mk(W, H);
    {
        const x = paintC.getContext("2d");
        x.fillStyle = "rgb(192,48,32)"; x.fillRect(100, 100, 120, 100);
        x.fillStyle = "rgba(32,96,192,0.5)"; x.fillRect(330, 140, 150, 110);
    }
    const pd = paintC.getContext("2d").getImageData(0, 0, W, H).data;
    L.px = ed.pixels.Layer.fromCanvas(paintC);
    L.dirty = true;
    ed.markFilterChanged(L); ed.uploaded.baseHash = null; ed.renderLayers(); ed.draw();
    await settle(ed);
    const ref = await all();
    const exp = expect(pd);
    const painted = (d, e) => { let m = 0, out = 0; for (let i = 0; i < W * H; i++) for (let c = 0; c < 4; c++) { const v = Math.abs(d[4 * i + c] - e[4 * i + c]); if (pd[4 * i + 3]) m = Math.max(m, v); else if (v) out++; } return { inMax: m, outN: out }; };
    const r1 = painted(ref, exp);
    check("painted: the formula within a level, the rest byte for byte", r1.inMax <= 1 && r1.outN === 0, r1);
    check("the paint takes the light: left darker than right", (() => { const a = ref[4 * (150 * W + 105)], b = ref[4 * (150 * W + 215)]; return a < b; })());

    // the GPU ran, the twin, the program
    const below = mk(W, H);
    ed.drawLayersInto(below.getContext("2d"), { forRun: true, upTo: ed.layers.indexOf(L) });
    const info = () => ed.filterInfo(L, { scale: 1, origin: [0, 0], full: [W, H], forRun: true, cache: {} });
    const gl = applyFilterGL("surface", below, L.params, info());
    check("the GPU path ran", !!gl);
    if (gl) {
        const g = glToCanvas(gl).getContext("2d").getImageData(0, 0, W, H).data;
        const cpu = applyFilter("surface", below, L.params, { ...info(), cpu: true }).getContext("2d").getImageData(0, 0, W, H).data;
        check("the CPU twin within a level of the GPU", diff(g, cpu).max <= 1, diff(g, cpu));
        check("the CPU twin: the formula within a level", painted(cpu, exp).inMax <= 1 && painted(cpu, exp).outN === 0, painted(cpu, exp));
    }
    if (ed.tileMode) {   // the program is the tiles backend's
        const plan = ed.stackPlan({ forRun: true, filters: true });
        check("the export's plan has the layer as a filter step", !!plan && plan.some((e) => e.filter === L), plan && plan.length);
        const prog = plan && await ed.holdStack(plan, { forRun: true });
        if (prog) {
            const pb = await ed.programBand(prog, [0, 0, W, H]);
            check("the program (bands) gives the pass's bytes", diff(pb, ref).max <= 1, diff(pb, ref));
            prog.release();
        } else check("the program held", false);
    }

    // Keep reflections 0
    await shell.commands.call("set_filter", { doc: ed.node.id, layer: L.id, params: { reflections: 0 } });
    await settle(ed);
    const k0 = painted(await all(), expect(pd, 0));
    check("Keep reflections 0: the formula with k = 0", k0.inMax <= 1 && k0.outN === 0, k0);
    await shell.commands.call("set_filter", { doc: ed.node.id, layer: L.id, params: { reflections: 100 } });
    await settle(ed);

    // a mask: the left half of the first rectangle hidden
    await shell.commands.call("select_rect", { doc: ed.node.id, x: 160, y: 0, w: W - 160, h: H });
    await shell.commands.call("set_mask", { doc: ed.node.id, layer: L.id, op: "from_selection" });
    await shell.commands.call("select_none", { doc: ed.node.id });
    await settle(ed);
    const masked = await all();
    let hiddenSame = true, shownSame = true;
    for (let y = 100; y < 200; y++) {
        for (let x = 100; x < 155; x++) for (let c = 0; c < 3; c++) if (masked[4 * (y * W + x) + c] !== bd[4 * (y * W + x) + c]) hiddenSame = false;
        for (let x = 165; x < 220; x++) for (let c = 0; c < 3; c++) if (Math.abs(masked[4 * (y * W + x) + c] - ref[4 * (y * W + x) + c]) > 1) shownSame = false;
    }
    check("the masked half is the picture", hiddenSame);
    check("the unmasked half keeps the paint", shownSame);
    await shell.commands.call("set_mask", { doc: ed.node.id, layer: L.id, op: "remove" });
    await settle(ed);
    check("without the mask the paint again", diff(await all(), ref).max <= 1, diff(await all(), ref));

    // opacity and visibility
    await shell.commands.call("set_layer", { doc: ed.node.id, layer: L.id, opacity: 0.5 });
    await settle(ed);
    const half = await all();
    const q = 4 * (150 * W + 150);
    check("opacity 0.5: between the picture and the paint", half[q] > Math.min(bd[q], ref[q]) && half[q] < Math.max(bd[q], ref[q]), [bd[q], half[q], ref[q]]);
    await shell.commands.call("set_layer", { doc: ed.node.id, layer: L.id, opacity: 1, visible: false });
    await settle(ed);
    check("hidden: the picture", diff(await all(), bd).max === 0);
    await shell.commands.call("set_layer", { doc: ed.node.id, layer: L.id, visible: true });
    await settle(ed);

    // a part of the picture: the pass's corner is not the picture's
    const part = (await ed.readBoxBytes([90, 95, 230, 210], { forRun: true })).data;
    let pmax = 0;
    for (let y = 95; y < 210; y++) for (let x = 90; x < 230; x++) for (let c = 0; c < 4; c++) pmax = Math.max(pmax, Math.abs(part[4 * ((y - 95) * 140 + x - 90) + c] - ref[4 * (y * W + x) + c]));
    check("a part of the picture: the paint in its place", pmax <= 1, pmax);

    // an undo puts the step's copies of the layers in place: the layer is found again
    const cur = () => ed.layers.find((l) => l.filter === "surface");
    // a copy has its own paint and stores it
    const dc = await shell.commands.call("duplicate_layer", { doc: ed.node.id, layer: L.id });
    const copyL = dc.ok && ed.layers.find((l) => l.id === dc.result.id);
    check("a copy: its own pixels, to be stored", copyL && copyL.px !== L.px && copyL.dirty === true, copyL && [copyL.dirty]);
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);

    // the type picker
    const rt =await shell.commands.call("set_filter", { doc: ed.node.id, layer: cur().id, type: "grain" });
    check("set_filter refuses another type", !rt.ok && cur().filter === "surface", rt);
    const af = await shell.commands.call("add_filter", { doc: ed.node.id, type: "surface" });
    check("add_filter refuses Deep paint", !af.ok, af);

    // a quarter turn and its undo
    const px0 = cur().px;
    await shell.commands.call("rotate_canvas", { doc: ed.node.id, angle: 90 });
    await settle(ed);
    const turned = await all();
    const nw = ed.width, nh = ed.height;
    let tmax = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const j = 4 * (x * nw + (H - 1 - y));   // (x, y) -> (H - 1 - y, x) for a clockwise quarter turn
        for (let c = 0; c < 3; c++) tmax = Math.max(tmax, Math.abs(turned[j + c] - ref[4 * (y * W + x) + c]));
    }
    check("a quarter turn turns the paint with the picture", nw === H && nh === W && cur().px !== px0 && cur().px.width === H && tmax <= 1, { nw, nh, tmax });
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("its undo: the bytes back", cur().px === px0 && diff(await all(), ref).max === 0, diff(await all(), ref));

    // a crop keeps the paint in place
    await ed.cropCanvasNow({ left: -40, top: -30 });
    await settle(ed);
    const cr = await all();
    let cmax = 0;
    for (let y = 0; y < ed.height; y++) for (let x = 0; x < ed.width; x++) for (let c = 0; c < 3; c++) cmax = Math.max(cmax, Math.abs(cr[4 * (y * ed.width + x) + c] - ref[4 * ((y + 30) * W + x + 40) + c]));
    check("a crop keeps the paint in place", ed.width === W - 40 && cur().px.width === W - 40 && cmax <= 1, { w: ed.width, pw: cur().px.width, cmax });
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("the crop's undo", ed.width === W && cur().px === px0 && diff(await all(), ref).max === 0);

    // a resize remakes the paint at the new size
    await ed.resizeImageNow(320, 200);
    await settle(ed);
    const rs = await all();
    const rq = 4 * (75 * 320 + 80);
    check("a resize remakes the paint at the new size", cur().px.width === 320 && cur().px.height === 200 && Math.abs(rs[rq] - ref[4 * (150 * W + 160)]) <= 12, { pw: cur().px.width, v: rs[rq], r: ref[4 * (150 * W + 160)] });
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("the resize's undo", ed.width === W && cur().px === px0 && diff(await all(), ref).max === 0);

    // a straighten resamples the paint onto the new frame
    await shell.commands.call("straighten_canvas", { doc: ed.node.id, angle: 3 });
    await settle(ed);
    check("a straighten: the paint at the new frame's size", cur().px.width === ed.width && cur().px.height === ed.height && cur().px !== px0 && ed.width < W, [cur().px.width, ed.width]);
    const st = await all();
    // the first rectangle's middle (160, 150), turned 3 degrees clockwise about the centre, in the centred frame
    const th = 3 * Math.PI / 180, dx = 160 - W / 2, dy = 150 - H / 2;
    const sq = 4 * (Math.round(ed.height / 2 + dx * Math.sin(th) + dy * Math.cos(th)) * ed.width + Math.round(ed.width / 2 + dx * Math.cos(th) - dy * Math.sin(th)));
    check("a straighten: the red still there", st[sq] > st[sq + 2] + 60, Array.from(st.slice(sq, sq + 4)));
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("the straighten's undo", ed.width === W && cur().px === px0 && diff(await all(), ref).max === 0);

    // without the maps the layer passes the picture through
    const mapsNow = { shading: ed.maps.shading, residual: ed.maps.residual, normals: ed.maps.normals };
    await ed.setMaps({ shading: null, residual: null, normals: null });
    await settle(ed);
    check("no maps: the picture", diff(await all(), bd).max === 0);
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("the maps back: the paint", ed.maps.shading === mapsNow.shading && diff(await all(), ref).max <= 1);

    // .scumble and the autosave restore
    const path = __PATH__;
    const saved = await host.saveDocument(ed, { path, copy: true, history: false });
    check("saved", saved && saved.bytes > 0 && cur().ref && cur().ref.filename, saved);
    const opened = await host.openDocument(path);
    const e2 = opened && opened.editor;
    check("opened", !!e2);
    if (e2) {
        await settle(e2);
        const l2 = e2.layers.find((l) => l.filter === "surface");
        check("opened: the layer with its paint", l2 && l2.px.width === W && !!l2.ref, l2 && [l2.px.width, l2.ref]);
        check("opened: the same bytes", diff(await all(e2), ref).max === 0, diff(await all(e2), ref));
        shell.closeDocument && shell.closeDocument(e2, { force: true });
    }
    const e3 = shell.newDocument();
    await e3.setValue(ed.getValue());
    await settle(e3);
    check("restored: the same bytes", diff(await all(e3), ref).max === 0, diff(await all(e3), ref));
    shell.closeDocument && shell.closeDocument(e3, { force: true });

    shell.closeDocument && shell.closeDocument(ed, { force: true });
    return { fails, tiles: !!ed.tileMode };
})()
"""


async def run(c):
    tmp = os.path.join(tempfile.gettempdir(), f"deeppaint_{os.getpid()}").replace("\\", "/")
    os.makedirs(tmp, exist_ok=True)
    path = f"{tmp}/deeppaint.scumble"
    fails = []
    r = {}
    try:
        r = await c.eval(JS.replace("__PATH__", json.dumps(path)), timeout=300)
        fails = list(r.get("fails", []))
        if os.path.exists(path):
            with zipfile.ZipFile(path, "r") as z:
                hdr = json.loads(z.read("scumble/document.json").decode("utf-8"))
                if hdr.get("minReader") != 7:
                    fails.append(f"the header: minReader {hdr.get('minReader')}, expected 7")
                layers = (hdr.get("document") or {}).get("layers") or []
                surf = [l for l in layers if l.get("filter") == "surface"]
                if not surf or not (surf[0].get("ref") or {}).get("filename"):
                    fails.append(f"the stored layer has no file: {surf}")
        else:
            fails.append("no .scumble was written")
    finally:
        if os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass
    for f in fails:
        print("[FAIL deeppaint]", f)
    if not fails:
        print(f"[ok] deeppaint on {'tiles' if r.get('tiles') else 'canvas'}")
    return not fails


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        ok = asyncio.run(session(run))
    except Exception as e:
        print(f"[FAIL] CDP test failed: {e}")
        ok = False
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
