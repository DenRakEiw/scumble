// Deep paint SP3: the 15k timing of computeSurfaceMaps in a dev instance (docs/measurements/sp3_2026-11-13/15k.txt).
// Replace __MODELS__ (a JSON string: a folder with onnx/intrinsic and the MoGe-2 normal ONNX), __W__, __H__, __RUNS__,
// then: python tools/cdp.py eval "$(cat the filled file)"
/* global window, document, performance, PerformanceObserver, __MODELS__, __W__, __H__, __RUNS__ */
(async () => {
    const out = { runs: [] };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.scumble.helpers.configure({ dir: __MODELS__ });
    const host = (await import("./editor/host.js")).host;
    await host.refreshHelpers();
    const shell = await import("./shell.js");
    const W = __W__, H = __H__;
    const ed = shell.newDocument();
    shell.activate(ed);
    await wait(300);
    ed.resizeCanvas();
    const base = document.createElement("canvas"); base.width = W; base.height = H;
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#284868"); g.addColorStop(0.5, "#a08060"); g.addColorStop(1, "#e8b080");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        for (let i = 0; i < 40; i++) {
            x.fillStyle = `hsl(${(i * 47) % 360},55%,${35 + (i % 5) * 8}%)`;
            x.beginPath(); x.arc((i * 0.137 % 1) * W, (i * 0.311 % 1) * H, W / 30 + (i % 7) * W / 80, 0, Math.PI * 2); x.fill();
        }
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "sp3perf.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    await ed.mipsSettled();
    await wait(1000);
    out.size = [ed.width, ed.height];
    out.tiles = !!ed.tileMode;

    // phase timers around the host calls and setMaps; the window's long tasks
    const laps = [];
    const wrap = (obj, name) => {
        const f = obj[name];
        obj[name] = async function (...a) {
            const t = performance.now();
            try { return await f.apply(this, a); } finally { laps.push([name + (name === "pictureInput" ? `(${a[1]}x${a[2]})` : ""), Math.round(performance.now() - t)]); }
        };
        return () => { obj[name] = f; };
    };
    const undo = [wrap(host, "pictureInput"), wrap(host, "surfaceAnalysis"), wrap(ed, "setMaps")];
    let longest = 0, longCount = 0;
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { longCount++; if (e.duration > longest) longest = e.duration; } });
    po.observe({ entryTypes: ["longtask"] });
    for (let k = 0; k < __RUNS__; k++) {
        laps.length = 0; longest = 0; longCount = 0;
        const t0 = performance.now();
        const info = await ed.computeSurfaceMaps({ recompute: true });
        const total = Math.round(performance.now() - t0);
        await wait(300);
        const sum = laps.reduce((s, l) => s + l[1], 0);
        out.runs.push({ total, laps: laps.slice(), poolAndRest: total - sum, longestTaskMs: Math.round(longest), longTasks: longCount,
            info: info && { size: info.size, normalsSize: info.normalsSize, identity: info.identity, provider: info.provider, ms: info.ms } });
    }
    po.disconnect();
    undo.forEach((f) => f());
    // kept set
    const t1 = performance.now();
    await ed.computeSurfaceMaps();
    out.keptMs = Math.round(performance.now() - t1);
    const mr = ed.memoryReport ? ed.memoryReport() : null;
    out.mapsMB = mr && mr.maps != null ? mr.maps : Object.fromEntries(["shading", "residual", "normals"].map((k) => [k, +(ed.maps[k].data.byteLength / 1048576).toFixed(1)]));
    out.undoMB = +(ed.undoBytes / 1048576).toFixed(1);
    return JSON.stringify(out);
})()
