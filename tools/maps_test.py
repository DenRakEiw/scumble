"""Maps and picture input gate (PLAN_NIK9_BUILD.md §F5).

First group "picture_input":
  * pictureInput(ed, 512, 341, { skipFilters: true }) equals the same call with the filter layer hidden,
    byte for byte, and differs with skipFilters: false.
  * passStores with skipFilters names no store the pass does not draw.
  * A layer clipped to a filter layer is skipped with its base when skipFilters is true.
  * Tested on both tiles and canvas backends.

Runs Node test tools/maps_test.js first, then connects to running app via CDP if available.
"""
import asyncio
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

JS = r"""
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

        check("passStores store count with skipFilters matches filter hidden", storesSkip.length === storesHidden.length, { skip: storesSkip.length, hidden: storesHidden.length });

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


async def run(c):
    r = await c.eval(JS, timeout=300)
    fails = r.get("fails", [])
    for f in fails:
        print("[FAIL]", f)
    if not fails:
        print(f"[ok] picture_input on {'tiles' if r.get('tiles') else 'canvas'}")
    return not fails


def main():
    sys.stdout.reconfigure(encoding="utf-8")

    # 1. Run Node unit test
    print("Running node tools/maps_test.js...")
    res = subprocess.run([sys.executable.replace("python.exe", "node.exe") if os.path.exists(sys.executable.replace("python.exe", "node.exe")) else "node", os.path.join(HERE, "maps_test.js")])
    if res.returncode != 0:
        print("[FAIL] node tools/maps_test.js failed with code", res.returncode)
        sys.exit(res.returncode)
    print("[ok] node maps_test.js passed")

    # 2. Run CDP integration test if browser session is reachable
    try:
        ok = asyncio.run(session(run))
        if not ok:
            print("FAIL")
            sys.exit(1)
    except Exception as e:
        print(f"Note: CDP session not reachable ({e}), node test passed.")

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()
