"""Memory retention probe for K10c (`docs/PLAN_WASM_K10.md` §7, §9.3 item 4):
Measures `InpaintEditor.pxInstances()` and worker `px_stats` before, immediately after (`after`), and 3 seconds after (`later`)
a 15,000 x 10,000 2-layer `export_psd` (`psd_part`) or `wand_whole_picture` (`stack_into` + `flood_shape`).
Asserts `after` per pool worker <= 55 MiB and `later` per pool worker <= 16 MiB (with `release === 0` during the 2-layer job).
"""
import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from cdp import session  # noqa: E402

PROBE_JS = r"""
(async () => {
    const W = __W__, H = __H__, OP = __OP__, WAIT = __WAIT__, ROUTES = __ROUTES__;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let seq = 0;
    const ask = (w, msg, transfer = [], timeout = 600000) => new Promise((resolve, reject) => {
        const id = "px_probe_k10c_" + (++seq);
        const done = (fn, v) => { clearTimeout(timer); w.removeEventListener("message", onMsg); w.removeEventListener("error", onErr); fn(v); };
        const onMsg = (e) => {
            const m = e.data || {};
            if (m.id !== id || m.progress) return;
            if (m.ok) done(resolve, m); else done(reject, new Error(msg.op + ": " + (m.error || "failed")));
        };
        const onErr = (e) => done(reject, new Error(msg.op + ": the worker failed: " + ((e && e.message) || e)));
        const timer = setTimeout(() => done(reject, new Error(msg.op + " timed out")), timeout);
        w.addEventListener("message", onMsg);
        w.addEventListener("error", onErr);
        try { w.postMessage({ id, ...msg }, transfer); } catch (err) { done(reject, err); }
    });

    const shell = await import("./shell.js");
    const { host } = await import("./editor/host.js");
    const JOBS = await import("./editor/inpaint_jobs.js");
    const K = await import("./editor/px/kernels.js");
    const T = await import("./editor/inpaint_tiles.js");
    const ed = shell.newDocument();
    shell.activate(ed);
    await sleep(300);
    ed.resizeCanvas();
    const E = ed.constructor;
    const set = [];

    const one = async (thread, w) => {
        try {
            const { id, ok, op, ...rest } = await ask(w, { op: "px_stats" }, [], 15000);
            return { thread, ...rest };
        } catch (err) { return { thread, error: String((err && err.message) || err) }; }
    };
    const stats = async () => {
        const out = [{ thread: "window", ...(typeof E.pxInstances === "function" ? E.pxInstances() : K.pxInstances()) }];
        const ew = JOBS.editorWorker();
        if (ew) out.push(await one("editor worker", ew));
        const pool = E.parts.pool();
        for (let i = 0; i < pool.workers.length; i++) out.push(await one(`pool ${i + 1}`, pool.workers[i].w));
        return out;
    };

    try {
        if (!ed.tileMode) throw new Error("K10c retention probe requires tiles on");
        for (const [name, v] of Object.entries(ROUTES)) { E.setRoute(name, v === "inf" ? Infinity : v); set.push(name); }

        // px_jobs.py / px_probe.py document: a gradient base with discs, one full-size paint layer
        const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
        const base = mk(W, H);
        {
            const x = base.getContext("2d");
            const g = x.createLinearGradient(0, 0, W, H);
            g.addColorStop(0, "hsl(210,70%,45%)");
            g.addColorStop(1, "hsl(300,70%,25%)");
            x.fillStyle = g;
            x.fillRect(0, 0, W, H);
            for (let i = 0; i < 60; i++) {
                x.fillStyle = `hsl(${(i * 37) % 360},80%,55%)`;
                x.beginPath();
                x.arc((i * 977) % W, (i * 613) % H, Math.max(8, W / 40), 0, Math.PI * 2);
                x.fill();
            }
        }
        Object.defineProperty(base, "naturalWidth", { value: W });
        Object.defineProperty(base, "naturalHeight", { value: H });
        await ed.setBase({ filename: "pxprobe.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
        base.width = 1;
        const pc = mk(W, H);
        {
            const x = pc.getContext("2d");
            x.fillStyle = "hsla(60,80%,50%,0.35)";
            x.fillRect(40, 40, W - 120, H - 120);
            for (let k = 0; k < 20; k++) { x.fillStyle = `hsl(${(k * 53) % 360},70%,60%)`; x.fillRect((k * 811) % W, (k * 457) % H, W / 25, H / 25); }
        }
        ed.addLayer({ name: "Paint", kind: "paint", px: ed.pixels.Layer.fromCanvas(pc), x: 0, y: 0, w: W, h: H, dirty: true });
        pc.width = 1;
        ed.renderLayers(); ed.fitView(); ed.draw();
        await ed.mipsSettled();
        ed.sel.clear();
        ed.markSelectionChanged();

        const before = await stats();
        E.jobTimings(true);
        const wasChanged = host.changed;
        host.changed = () => {};
        const t0 = performance.now();
        let mbOut = 0;
        try {
            if (OP === "export_psd") {
                let saved = null;
                const was = host.saveExport;
                host.saveExport = async (blob, name) => { saved = { blob, name }; return { path: "memory:" + name }; };
                try { ed.saveFormatSel.value = "psd"; await ed.exportImage({ download: false }); } finally { host.saveExport = was; ed.saveFormatSel.value = "png"; }
                if (!saved) throw new Error("export_psd saved nothing: " + ed.status);
                mbOut = saved.blob.size / 1048576;
            } else if (OP === "wand_whole_picture") {
                await ed.wandSelect(2500, 2500, "replace");
            } else {
                throw new Error("unknown op " + OP);
            }
        } finally {
            host.changed = wasChanged;
        }
        const opMs = performance.now() - t0;
        const timings = E.jobTimings(true);
        const after = await stats();
        await ed.mipsSettled();
        await sleep(WAIT * 1000);
        const later = await stats();
        const routes = Object.fromEntries(Object.entries(E.routes).map(([k, v]) => [k, v === Infinity ? "inf" : v]));
        return JSON.stringify({
            mode: "retention_" + OP,
            op: OP,
            size: `${W}x${H}`,
            routes,
            wait: WAIT,
            opMs,
            MB: mbOut,
            timings,
            before,
            after,
            later,
            focused: document.hasFocus(),
            visibility: document.visibilityState,
        });
    } finally {
        for (const name of set) { try { E.setRoute(name, null); } catch (_) {} }
        shell.closeDocument(ed, { force: true });
    }
})()
"""


async def main():
    argv = sys.argv[1:]
    op = "export_psd"
    size = "15000x10000"
    routes = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--op" and i + 1 < len(argv):
            op = argv[i + 1]
            i += 2
        elif a == "--set" and i + 1 < len(argv):
            k, _, v = argv[i + 1].partition("=")
            routes[k.strip()] = v.strip()
            i += 2
        elif "x" in a.lower() and not a.startswith("-"):
            size = a
            i += 1
        else:
            i += 1
    w, h = (int(x) for x in size.lower().split("x"))

    async def run(c):
        await c.call("Page.bringToFront")
        body = (
            PROBE_JS.replace("__W__", str(w))
            .replace("__H__", str(h))
            .replace("__OP__", json.dumps(op))
            .replace("__WAIT__", "3")
            .replace("__ROUTES__", json.dumps(routes))
        )
        res = json.loads(await c.eval(body, timeout=1800))
        if os.environ.get("PX_PROBE_JSON"):
            with open(os.environ["PX_PROBE_JSON"], "a", encoding="utf-8", newline="\n") as fh:
                fh.write(json.dumps(res) + "\n")
        aft_pool = [t for t in (res.get("after") or []) if t.get("thread", "").startswith("pool ")]
        lat_pool = [t for t in (res.get("later") or []) if t.get("thread", "").startswith("pool ")]
        max_after = max((t.get("bytes", 0) for t in aft_pool), default=0) / 1048576
        max_later = max((t.get("bytes", 0) for t in lat_pool), default=0) / 1048576
        rels = sum(t.get("release", 0) for t in lat_pool)
        print(
            f"op={op} routes={json.dumps(routes)} opMs={res.get('opMs', 0):.1f} "
            f"workersMaxAfterMB={max_after:.2f} workersMaxLaterMB={max_later:.2f} releases={rels} focused={res.get('focused')}"
        )
        if max_after > 55.0:
            print(f"FAIL: workersMaxAfterMB {max_after:.2f} > 55.0 MiB")
            return 1
        if max_later > 16.0:
            print(f"FAIL: workersMaxLaterMB {max_later:.2f} > 16.0 MiB")
            return 1
        print("PASS")
        return 0

    sys.exit(await session(run))


if __name__ == "__main__":
    asyncio.run(main())
