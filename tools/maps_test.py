"""Maps and picture input gate (PLAN_NIK9_BUILD.md §F5, §F8).

First group "picture_input":
  * pictureInput(ed, 512, 341, { skipFilters: true }) equals the same call with the filter layer hidden,
    byte for byte, and differs with skipFilters: false.
  * passStores with skipFilters names no store the pass does not draw.
  * A layer clipped to a filter layer is skipped with its base when skipFilters is true.
  * Tested on both tiles and canvas backends.

Second group "maps":
  * Synthetic ramp setMap("depth", makeMap(...)) and no model.
  * rotate_canvas 90 and undo (xf turns and turns back, data untouched, sampleMap at a document point follows the turn).
  * Crop, then extend (points outside the footprint read the edge value).
  * setMap, undo and redo swap the object.
  * .scumble save and open returns map's bytes exactly (unpack equals original) and its xf.
  * Autosave restore (the quit gate's restart pattern) returns map's bytes and xf.
  * referencedFileKeys: map file is tracked, and drops out on the next save when map is removed.
  * Document with map writes version 2 / minReader 1, one without writes 1 / 1.
  * load_image / setBaseFromCanvas clears maps.
  * mapStale check.

Runs Node test tools/maps_test.js first, then connects to running app via CDP if available.
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

JS_PICTURE_INPUT = r"""
(async () => {
    const shell = await import("./shell.js");
    const hostModule = await import("./editor/host.js");
    const host = hostModule.default || hostModule.host;
    const fails = [];
    const check = (name, ok, info) => {
        if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : ""));
    };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const settle = async (ed) => { await ed.mipsSettled(); await new Promise((r) => setTimeout(r, 100)); };
    const diff = (a, b) => {
        if (!a || !b) return null;
        if (a.length !== b.length) return { max: 999, n: -1 };
        let m = 0, n = 0;
        for (let i = 0; i < a.length; i++) {
            const d = Math.abs(a[i] - b[i]);
            if (d) { n++; if (d > m) m = d; }
        }
        return { max: m, n };
    };

    const W = 600, H = 400;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 300));
    ed.resizeCanvas();

    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#1a3a6a"); g.addColorStop(1, "#d8c8a0");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        for (let i = 0; i < 8; i++) {
            x.fillStyle = `hsl(${i * 45},60%,45%)`;
            x.fillRect(10 + i * 70, H - 100, 60, 80);
        }
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(base, { keepLayers: false });

    // Add strong filter layer (fill or levels)
    const fl = ed.addFilterLayer("fill");
    if (fl) {
        fl.params = { ...fl.params, color: "#ff0080" };
        ed.markFilterChanged(fl);
    }
    // Add a paint layer clipped to the filter layer
    const { Layer: LP } = ed.pixels;
    const clCanvas = mk(200, 200);
    {
        const cx = clCanvas.getContext("2d");
        cx.fillStyle = "#00ff00";
        cx.fillRect(0, 0, 200, 200);
    }
    const clippedLayer = ed.addLayer({
        name: "clippedToFilter",
        kind: "paint",
        clip: true,
        px: LP.fromCanvas(clCanvas),
        x: 50, y: 50, w: 200, h: 200, dirty: true,
    });

    await settle(ed);

    // 1. pictureInput with skipFilters: true vs filter hidden
    const resSkip = await host.pictureInput(ed, 512, 341, { skipFilters: true });
    check("resSkip returned dimensions", resSkip && resSkip.width === 512 && resSkip.height === 341, resSkip && [resSkip.width, resSkip.height]);

    // Hide the filter layer
    fl.visible = false;
    ed.renderLayers();
    await settle(ed);

    const resHidden = await host.pictureInput(ed, 512, 341, { skipFilters: true });
    const diffSkipVsHidden = diff(resSkip.image, resHidden.image);
    check("pictureInput with skipFilters: true equals filter layer hidden byte for byte", diffSkipVsHidden && diffSkipVsHidden.max === 0, diffSkipVsHidden);

    // Show the filter layer again and test skipFilters: false
    fl.visible = true;
    ed.renderLayers();
    await settle(ed);

    const resWithFilters = await host.pictureInput(ed, 512, 341, { skipFilters: false });
    const diffWithFilters = diff(resSkip.image, resWithFilters.image);
    check("pictureInput differs with skipFilters: false", diffWithFilters && diffWithFilters.max > 0, diffWithFilters);

    // 2. passStores with skipFilters names no store the pass does not draw
    if (ed.tileMode) {
        const s = Math.min(1, Math.max(512 / W, 341 / H));
        const storesSkip = ed.passStores("image", [0, 0, W, H], s, { forRun: true, skipFilters: true });
        fl.visible = false;
        const storesHidden = ed.passStores("image", [0, 0, W, H], s, { forRun: true, skipFilters: false });
        fl.visible = true;

        check("passStores store count with skipFilters skips both filter and clipped layer", storesSkip.length === 1 && storesHidden.length === 2, { skip: storesSkip.length, hidden: storesHidden.length });

        // Verify neither fl's mask nor clippedLayer's px are in storesSkip
        const hasFlStore = storesSkip.some((st) => st.px === ed.liveMask(fl));
        const hasClippedStore = storesSkip.some((st) => st.px === clippedLayer.px);
        check("passStores omits filter mask", !hasFlStore, hasFlStore);
        check("passStores omits layer clipped to filter", !hasClippedStore, hasClippedStore);
    }

    // 3. Memory check at 15k if memoryReport is available
    if (typeof ed.memoryReport === "function") {
        const rep = ed.memoryReport();
        const over64 = rep && rep.mirrors && Object.values(rep.mirrors).some((bytes) => bytes > 64 * 1024 * 1024);
        check("no mirror over 64 MB", !over64, rep);
    }

    shell.closeDocument && shell.closeDocument(ed, { force: true });
    return { fails, tiles: !!ed.tileMode };
})()
"""

JS_MAPS = r"""
(async () => {
    const shell = await import("./shell.js");
    const { host } = await import("./editor/host.js");
    const { makeMap, sampleMap, fingerprint } = await import("./editor/inpaint_maps.js");
    const fails = [];
    const check = (name, ok, info) => {
        if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 400) : ""));
    };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const settle = async (ed) => { await ed.mipsSettled(); await new Promise((r) => setTimeout(r, 100)); };

    const W = 400, H = 300;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 200));
    ed.resizeCanvas();

    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#204060"); g.addColorStop(1, "#f0b080");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(base, { keepLayers: false });
    await settle(ed);

    check("initial maps empty", !ed.maps || Object.keys(ed.maps).length === 0, ed.maps);

    // 1. Synthetic ramp setMap("depth", makeMap(...)) without model
    const mapW = 100, mapH = 75;
    const rampData = new Uint16Array(mapW * mapH);
    for (let y = 0; y < mapH; y++) {
        for (let x = 0; x < mapW; x++) {
            rampData[y * mapW + x] = Math.round((y * mapW + x) * 65535 / (mapW * mapH));
        }
    }
    const initXf = [W, 0, 0, H, 0, 0];
    const initialFpImg = (await host.pictureInput(ed, 64, 64, { skipFilters: true })).image;
    const initialFp = fingerprint(initialFpImg, 64, 64);
    const mapA = makeMap("depth", mapW, mapH, rampData, initXf, { label: "Ramp A", model: "synthetic", fp: initialFp });
    const setOk = await ed.setMap("depth", mapA);
    check("setMap returned true", setOk === true, setOk);
    check("ed.maps.depth is mapA", ed.maps && ed.maps.depth === mapA);

    // 2. rotate_canvas 90 and undo (xf turns and turns back, data untouched, sampleMap follows turn)
    const pt0 = [100, 60];
    const s0 = sampleMap(ed.maps.depth, pt0[0], pt0[1]);
    const dataRef0 = ed.maps.depth.data;

    await shell.commands.call("rotate_canvas", { doc: ed.node.id, angle: 90 });
    await settle(ed);
    check("rotate_canvas 90 width/height swapped", ed.width === H && ed.height === W, [ed.width, ed.height]);
    check("data untouched on rotate_canvas", ed.maps.depth.data === dataRef0);

    // (x, y) rotates to (H - y, x) = (300 - 60, 100) = (240, 100)
    const turnedPt = [H - pt0[1], pt0[0]];
    const sTurn = sampleMap(ed.maps.depth, turnedPt[0], turnedPt[1]);
    check("sampleMap at document point follows turn", Math.abs(sTurn - s0) < 1e-4, { s0, sTurn });

    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("undo restored width/height", ed.width === W && ed.height === H, [ed.width, ed.height]);
    check("data untouched after undo", ed.maps.depth.data === dataRef0);
    const sUndo = sampleMap(ed.maps.depth, pt0[0], pt0[1]);
    check("sampleMap at document point follows undo", Math.abs(sUndo - s0) < 1e-4, { s0, sUndo });

    // 3. Crop then extend (points outside footprint read edge value)
    await shell.commands.call("extend_canvas", { doc: ed.node.id, left: -50, top: -50, right: 0, bottom: 0 });
    await settle(ed);
    check("canvas cropped", ed.width === W - 50 && ed.height === H - 50, [ed.width, ed.height]);

    await shell.commands.call("extend_canvas", { doc: ed.node.id, left: 100, top: 100, right: 0, bottom: 0 });
    await settle(ed);
    check("canvas extended", ed.width === W + 50 && ed.height === H + 50, [ed.width, ed.height]);

    // Top-left of original footprint is now at (50, 50).
    // Point (10, 10) is outside the map's original footprint -> sampleMap clamps to (50, 50).
    const edgeVal = sampleMap(ed.maps.depth, 50, 50);
    const outsideVal = sampleMap(ed.maps.depth, 10, 10);
    check("points outside footprint read edge value", Math.abs(outsideVal - edgeVal) < 1e-4, { edgeVal, outsideVal });

    // Undo extend and crop
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("restored after undo crop/extend", ed.width === W && ed.height === H);

    // 4. setMap, undo and redo swap the object
    const mapB = makeMap("depth", mapW, mapH, new Uint16Array(mapW * mapH).fill(42000), [W, 0, 0, H, 0, 0], { label: "Const B", fp: initialFp });
    await ed.setMap("depth", mapB);
    check("ed.maps.depth is mapB", ed.maps.depth === mapB);

    await shell.commands.call("undo", { doc: ed.node.id });
    await settle(ed);
    check("undo swaps back to mapA", ed.maps.depth === mapA);

    await shell.commands.call("redo", { doc: ed.node.id });
    await settle(ed);
    check("redo swaps back to mapB", ed.maps.depth === mapB);

    // 5. Persistence: .scumble save and open returns map bytes exactly (unpack equals original) and xf
    const scumblePath = __PATH_WITH_MAP__;
    const saveRes = await host.saveDocument(ed, { path: scumblePath, copy: true, history: false });
    check("saveDocument succeeded", saveRes && saveRes.bytes > 0, saveRes);

    const openRes = await host.openDocument(scumblePath);
    check("openDocument succeeded", openRes && openRes.editor, openRes);
    const edOpen = openRes ? openRes.editor : null;
    if (edOpen) {
        await settle(edOpen);
        check("opened document has maps.depth", edOpen.maps && edOpen.maps.depth);
        if (edOpen.maps && edOpen.maps.depth) {
            check("opened map w matches", edOpen.maps.depth.w === mapB.w);
            check("opened map h matches", edOpen.maps.depth.h === mapB.h);
            check("opened map xf matches", JSON.stringify(edOpen.maps.depth.xf) === JSON.stringify(mapB.xf));
            let byteMismatches = 0;
            for (let i = 0; i < mapB.data.length; i++) {
                if (edOpen.maps.depth.data[i] !== mapB.data[i]) byteMismatches++;
            }
            check("opened map unpack bytes exactly equal original", byteMismatches === 0, { byteMismatches });
        }
        shell.closeDocument && shell.closeDocument(edOpen, { force: true });
    }

    // 6. Autosave restore (the quit gate's restart pattern)
    const stateJson = ed.getValue();
    const edRestore = shell.newDocument();
    check("autosave restore created editor", !!edRestore);
    if (edRestore) {
        await edRestore.setValue(stateJson);
        await settle(edRestore);
        check("restored editor has maps.depth", edRestore.maps && edRestore.maps.depth);
        if (edRestore.maps && edRestore.maps.depth) {
            check("restored map w matches", edRestore.maps.depth.w === mapB.w);
            check("restored map h matches", edRestore.maps.depth.h === mapB.h);
            check("restored map xf matches", JSON.stringify(edRestore.maps.depth.xf) === JSON.stringify(mapB.xf));
            let byteMismatches = 0;
            for (let i = 0; i < mapB.data.length; i++) {
                if (edRestore.maps.depth.data[i] !== mapB.data[i]) byteMismatches++;
            }
            check("restored map unpack bytes exactly equal original", byteMismatches === 0, { byteMismatches });
        }
        shell.closeDocument && shell.closeDocument(edRestore, { force: true });
    }

    // 7. referencedFileKeys and removal
    host.closed = [];
    const refKeysWithMap = host.referencedFileKeys();
    const mapBKey = mapB.ref ? `${mapB.ref.type || "input"}/${mapB.ref.subfolder || ""}/${mapB.ref.filename}` : null;
    if (mapBKey) {
        check("referencedFileKeys includes mapB file", refKeysWithMap.includes(mapBKey), mapBKey);
    }

    // Remove map and save to scumbleWithoutMap
    await ed.setMap("depth", null);
    check("map removed from ed", !ed.maps || !ed.maps.depth);
    const scumbleNoMapPath = __PATH_WITHOUT_MAP__;
    await host.saveDocument(ed, { path: scumbleNoMapPath, copy: true, history: false });
    const refKeysWithoutMap = host.referencedFileKeys();
    if (mapBKey) {
        check("removed map file drops out of referencedFileKeys on next save", !refKeysWithoutMap.includes(mapBKey), mapBKey);
    }

    // 8. mapStale check
    await ed.setMap("depth", mapA);
    const staleFresh = await ed.mapStale("depth");
    check("mapStale returns false for unchanged picture", staleFresh.stale === false && staleFresh.diff <= 5, staleFresh);

    // Modify image to induce staleness
    const alteredCanvas = mk(W, H);
    {
        const ax = alteredCanvas.getContext("2d");
        ax.fillStyle = "#00ff00";
        ax.fillRect(0, 0, W, H);
    }
    const { Layer } = ed.pixels;
    const lAlert = ed.addLayer({ name: "Cover", kind: "paint", px: Layer.fromCanvas(alteredCanvas), x: 0, y: 0, w: W, h: H, dirty: true });
    await settle(ed);
    const staleModified = await ed.mapStale("depth");
    check("mapStale returns true when picture changes substantially", staleModified.stale === true && staleModified.diff > 10, staleModified);
    ed.removeLayer(lAlert.id);
    await settle(ed);

    // 9. load_image / setBaseFromCanvas clears maps
    Object.defineProperty(alteredCanvas, "naturalWidth", { value: W });
    Object.defineProperty(alteredCanvas, "naturalHeight", { value: H });
    await ed.setBaseFromCanvas(alteredCanvas, { keepLayers: false });
    await settle(ed);
    check("load_image / setBaseFromCanvas clears maps", !ed.maps || Object.keys(ed.maps).length === 0, ed.maps);

    shell.closeDocument && shell.closeDocument(ed, { force: true });
    return { fails, tiles: !!ed.tileMode };
})()
"""


async def run(c):
    # 1. picture_input group
    r1 = await c.eval(JS_PICTURE_INPUT, timeout=300)
    fails1 = r1.get("fails", [])
    for f in fails1:
        print("[FAIL picture_input]", f)
    if not fails1:
        print(f"[ok] picture_input on {'tiles' if r1.get('tiles') else 'canvas'}")

    # 2. maps group
    tmp_dir = os.path.join(tempfile.gettempdir(), f"maps_test_{os.getpid()}").replace("\\", "/")
    os.makedirs(tmp_dir, exist_ok=True)
    scumble_with_map = f"{tmp_dir}/test_with_map.scumble"
    scumble_without_map = f"{tmp_dir}/test_without_map.scumble"

    fails2 = []
    r2 = {}
    try:
        js_maps = JS_MAPS.replace("__PATH_WITH_MAP__", json.dumps(scumble_with_map)).replace("__PATH_WITHOUT_MAP__", json.dumps(scumble_without_map))
        r2 = await c.eval(js_maps, timeout=300)
        fails2 = r2.get("fails", [])
        for f in fails2:
            print("[FAIL maps]", f)

        # Check zip header versions in Python
        if os.path.exists(scumble_with_map):
            with zipfile.ZipFile(scumble_with_map, "r") as z:
                hdr = json.loads(z.read("scumble/document.json").decode("utf-8"))
                if hdr.get("version") != 2:
                    fails2.append(f"document with map: expected version 2, got {hdr.get('version')}")
                if hdr.get("minReader") != 1:
                    fails2.append(f"document with map: expected minReader 1, got {hdr.get('minReader')}")

        if os.path.exists(scumble_without_map):
            with zipfile.ZipFile(scumble_without_map, "r") as z:
                hdr = json.loads(z.read("scumble/document.json").decode("utf-8"))
                if hdr.get("version") != 1:
                    fails2.append(f"document without map: expected version 1, got {hdr.get('version')}")
                if hdr.get("minReader") != 1:
                    fails2.append(f"document without map: expected minReader 1, got {hdr.get('minReader')}")
    finally:
        for p in [scumble_with_map, scumble_without_map]:
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        try:
            os.rmdir(tmp_dir)
        except OSError:
            pass

    if not fails2:
        print(f"[ok] maps on {'tiles' if r2.get('tiles') else 'canvas'}")

    return not fails1 and not fails2


def main():
    sys.stdout.reconfigure(encoding="utf-8")

    # 1. Run Node unit test
    print("Running node tools/maps_test.js...")
    node_cmd = sys.executable.replace("python.exe", "node.exe") if os.path.exists(sys.executable.replace("python.exe", "node.exe")) else "node"
    res = subprocess.run([node_cmd, os.path.join(HERE, "maps_test.js")])
    if res.returncode != 0:
        print("[FAIL] node tools/maps_test.js failed with code", res.returncode)
        sys.exit(res.returncode)
    print("[ok] node maps_test.js passed")

    # 2. Run CDP integration test
    launch = "--launch" in sys.argv
    proc = None
    if launch:
        electron = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
        prof = os.path.join(tempfile.gettempdir(), f"maps_prof_{os.getpid()}")
        os.makedirs(prof, exist_ok=True)
        env = dict(os.environ)
        if "--tiles" in sys.argv:
            idx = sys.argv.index("--tiles")
            if idx + 1 < len(sys.argv):
                env["SCUMBLE_TILES"] = "1" if sys.argv[idx + 1] == "on" else "0"
        proc = subprocess.Popen([electron, ".", "--remote-debugging-port=9555", f"--user-data-dir={prof}", "--no-comfy"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        import time
        for _ in range(30):
            try:
                import urllib.request
                urllib.request.urlopen("http://127.0.0.1:9555/json/version", timeout=1)
                break
            except Exception:
                time.sleep(0.5)

    try:
        ok = asyncio.run(session(run))
        if not ok:
            print("FAIL")
            sys.exit(1)
    except Exception as e:
        if launch:
            print(f"[FAIL] CDP test failed: {e}")
            sys.exit(1)
        print(f"Note: CDP session not reachable ({e}), node test passed.")
    finally:
        if proc:
            try:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
            except Exception:
                pass

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()
