/* global window, document, PointerEvent */
// Liquify on a large document (15000 x 10000 by default, grid step 4): the press, the frame while a push drags (the dabs,
// the preview, the rest of the draw), the landing and how long it holds the window, Restore all, a long shrink held in
// place and the field's and the undo steps' bytes (docs/PLAN_0_1_31.md §5 step 5b, docs/PERFORMANCE.md §15). One
// expression, evaluated in a running instance by `python tools/brush_perf.py '<json>' liquify_perf.js` (the window in
// front). Parameters: `window.__bp` (the defaults below). A fresh dev instance on a profile of its own, --no-comfy.
// KERNELS picks the route for the run (docs/PLAN_WASM_BUILD.md §4.9: the A/B of the liquify kernels, K28-K31).
(async () => {
    const P = Object.assign({
        W: 15000, H: 10000,
        SIZES: [200, 1000],
        VIEWS: ["fit", "1:1"],
        MOVES: 60,                       // pointer moves per push at 1:1 (15 image px each at dpr 1.25)
        MOVES_FIT: 20,                   // at fit (a move there is about 200 image px: 4,000 px of travel)
        RESTORE_MOVES: 20,               // pointer moves per restore brush row at 1:1 (50 image px each at size 1000)
        MOVE_CSS: 12,                    // CSS px per move
        SHRINK_TICKS: 150,               // about 5 s of the 33 ms timer, as ticks
        KERNELS: "rust",                 // InpaintEditor.kernels for the run ("js": the twins in the window and in every job), put back after it
        ROUTES: null,                    // route overrides for the run (e.g. { liquifyBlock: "js" }), put back after it
        DAB: null,                       // "map" (IE.liquifyDabKernel = null) or "dense" (K.liquifyDab), put back after it
        KEEP: false,                     // keep the document open after the run (closed by default, so runs can follow in one instance)
    }, window.__bp || {});
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const r1 = (v) => (v == null ? null : +v.toFixed(1));
    const r2 = (v) => (v == null ? null : +v.toFixed(2));
    const stat = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return { p50: r1(s[Math.floor(s.length / 2)]), p95: r1(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]), worst: r1(s[s.length - 1]) }; };
    const stat2 = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return { p50: r2(s[Math.floor(s.length / 2)]), p95: r2(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]), worst: r2(s[s.length - 1]) }; };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const shell = await import("./shell.js");
    const K = await import("./editor/px/kernels.js");   // the window's own module (the same URL inpaint_canvas.js imports)
    const L = await import("./editor/inpaint_liquify.js");
    const probe = () => {
        let last = performance.now(), max = 0, stop = false;
        const tick = () => { if (stop) return; const now = performance.now(); if (now - last > max) max = now - last; last = now; setTimeout(tick, 0); };
        setTimeout(tick, 0);
        return () => { const now = performance.now(); if (now - last > max) max = now - last; stop = true; return r1(max); };
    };
    // which kernels ran: the window's px calls by export name (null in a build without the counters), and the worker
    // jobs' timings per op (the bake's "liquify" rows, the mips): the count, each numeric field summed, the routes seen
    // and the px calls merged by name
    const pxCalls = (IE, reset) => (typeof IE.pxCalls === "function" ? IE.pxCalls(reset) : null);
    const jobSum = (list) => {
        const out = {};
        for (const t of list) {
            const o = out[t.op] || (out[t.op] = { n: 0 });
            o.n++;
            for (const [key, v] of Object.entries(t)) {
                if (typeof v === "number") o[key] = (o[key] || 0) + v;
                else if (key === "kernels") o.kernels = o.kernels && o.kernels !== v ? "mixed" : v;
                else if (key === "pxCalls" && v) { const c = o.pxCalls || (o.pxCalls = {}); for (const [f, n] of Object.entries(v)) c[f] = (c[f] || 0) + n; }
            }
        }
        for (const o of Object.values(out)) for (const key of Object.keys(o)) if (key !== "n" && typeof o[key] === "number") o[key] = r1(o[key]);
        return out;
    };
    // ---- the document: a textured base, the base active (the first press makes the copy "Liquify") ----
    const t0 = performance.now();
    const ed = shell.newDocument();
    shell.activate(ed);
    await wait(300);
    ed.resizeCanvas();
    const W = P.W, H = P.H;
    const tile = mk(256, 256);
    {
        const x = tile.getContext("2d"), img = x.createImageData(256, 256);
        let s = 12345;
        for (let i = 0; i < img.data.length; i += 4) {
            s = (s * 1664525 + 1013904223) >>> 0;
            const v = s >>> 24;
            img.data[i] = v; img.data[i + 1] = (v * 7 + (i >> 11)) & 255; img.data[i + 2] = 255 - v; img.data[i + 3] = 255;
        }
        x.putImageData(img, 0, 0);
    }
    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "hsl(210,70%,45%)"); g.addColorStop(1, "hsl(300,70%,25%)");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        x.globalAlpha = 0.35; x.fillStyle = x.createPattern(tile, "repeat"); x.fillRect(0, 0, W, H); x.globalAlpha = 1;
        for (let i = 0; i < 80; i++) { x.fillStyle = `hsl(${(i * 37) % 360},80%,55%)`; x.beginPath(); x.arc((i * 977) % W, (i * 613) % H, W / 40, 0, Math.PI * 2); x.fill(); }
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "liquifyperf.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    if (ed.tileMode) base.width = 1;
    ed.activeLayerId = null;
    ed.renderLayers(); ed.fitView(); ed.draw();
    await ed.mipsSettled();
    const built = Math.round(performance.now() - t0);
    const IE = ed.constructor, dpr = window.devicePixelRatio || 1;
    // the route for the run: the window's kernels and every job's (inpaint_jobs.js posts the mode with each job);
    // kernelsInUse says "js" too while the window's px.wasm has not loaded
    const kernels0 = IE.kernels, routes0 = K.routeOverrides(), rate0 = IE.liquifyRateMs, dab0 = IE.liquifyDabKernel;
    const FProto = L.LiquifyField.prototype, nodes0 = FProto.nodes, writeDense0 = FProto._writeDense, write0 = FProto._write;
    let nodesMs = 0, kernelMs = 0, writeMs = 0;
    FProto.nodes = function (...a) { const t = performance.now(); try { return nodes0.apply(this, a); } finally { nodesMs += performance.now() - t; } };
    FProto._writeDense = function (...a) { const t = performance.now(); try { return writeDense0.apply(this, a); } finally { writeMs += performance.now() - t; } };
    FProto._write = function (...a) { const t = performance.now(); try { return write0.apply(this, a); } finally { writeMs += performance.now() - t; } };
    IE.kernels = P.KERNELS;
    if (P.ROUTES && typeof P.ROUTES === "object") for (const [k, v] of Object.entries(P.ROUTES)) K.setRoute(k, v);
    if (P.DAB === "map") IE.liquifyDabKernel = null;
    else if (P.DAB === "dense") IE.liquifyDabKernel = K.liquifyDab;
    const baseDabKernel = IE.liquifyDabKernel;
    if (baseDabKernel) IE.liquifyDabKernel = (...a) => { const t = performance.now(); try { return baseDabKernel(...a); } finally { kernelMs += performance.now() - t; } };
    const route = { kernels: IE.kernels, kernelsInUse: K.kernelsInUse(), routes: K.routeOverrides(), dabKernel: IE.liquifyDabKernel ? "dense" : "map" };
    const rows = [], tiles = ed.tileMode;
    let undoMB = null, s = null;
    try {
        IE.liquifyRateMs = 0;
        ed.setTool("liquify");
        ed.hardness = 0.5;
        ed.liquifyOpts.strength = 50;

        let pid = 90;
        const client = (ix, iy) => {
            const rect = ed.canvas.getBoundingClientRect();
            const [sx, sy] = ed.imageToScreen(ix, iy);
            return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height };
        };
        const ev = (type, ix, iy) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: pid, isPrimary: true, pointerType: "mouse",
            pressure: type === "pointerup" ? 0 : 0.5, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1, ...client(ix, iy) });
        const send = (type, ix, iy) => ed.canvas.dispatchEvent(ev(type, ix, iy));
        // the preview's own share of a draw, the window's build, and the landing's commit
        let previewMs = 0;
        { const f = ed.drawLiquifyInto; ed.drawLiquifyInto = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { previewMs += performance.now() - t; } }; }
        let windowMs = 0;
        { const f = ed.liquifyWindow; ed.liquifyWindow = function (p, vp) { const had = p.liqWin; const t = performance.now(); const r = f.call(this, p, vp); if (p.liqWin !== had) windowMs += performance.now() - t; return r; }; }
        let commitMs = 0;
        { const f = ed.liquifyCommit; ed.liquifyCommit = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { commitMs += performance.now() - t; } }; }
        const heapMB = () => (performance.memory ? r1(performance.memory.usedJSHeapSize / 1048576) : null);
        const view = (kind, cx, cy) => {
            if (kind === "fit") ed.fitView();
            else { ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false; ed.view.x = ed.canvas.width / 2 - cx; ed.view.y = ed.canvas.height / 2 - cy; }
            ed.draw();
        };
        const cellBytes = () => { const f = ed.liq && ed.liq.field; if (!f) return 0; return f.cells.size * f.n * f.n * 8; };
        // the counts from here to the row's end are this row's
        const resetCalls = () => { pxCalls(IE, true); IE.jobTimings(true); };
        const calls = () => ({ pxCalls: pxCalls(IE, true), jobs: jobSum(IE.jobTimings(true)) });
        // ---- 1, 2, 4: a push per view and size: the press, the frames, the landing ----
        let row = 0;
        for (const vk of P.VIEWS) {
            for (const size of P.SIZES) {
                // the 15000 x 10000 places, scaled to the picture: a smaller one put every press outside it (nothing ran)
                const cx = Math.round(W * (2500 + (row % 3) * 4500) / 15000), cy = Math.round(H * (2500 + Math.floor(row / 3) * 4500) / 10000);
                row++;
                view(vk, cx, cy);
                await ed.mipsSettled();
                ed.brushSize = size;
                ed.liquifyOpts.mode = "push";
                pid++;
                previewMs = 0; windowMs = 0;
                resetCalls();
                let t = performance.now();
                send("pointerdown", cx, cy);
                const press = performance.now() - t;
                const step = P.MOVE_CSS * dpr / ed.view.scale;
                const dab = [], dabNodes = [], dabKernel = [], dabWrite = [], frame = [], prev = [], moves = vk === "fit" ? P.MOVES_FIT : P.MOVES;
                for (let i = 1; i <= moves; i++) {
                    nodesMs = 0; kernelMs = 0; writeMs = 0;
                    t = performance.now();
                    send("pointermove", cx + i * step, cy + i * step * 0.3);
                    dab.push(performance.now() - t);
                    dabNodes.push(nodesMs); dabKernel.push(kernelMs); dabWrite.push(writeMs);
                    previewMs = 0;
                    t = performance.now();
                    ed.draw();
                    frame.push(performance.now() - t);
                    prev.push(previewMs);
                }
                commitMs = 0;
                const heapMB0 = heapMB();
                const stop = probe();
                t = performance.now();
                send("pointerup", cx + moves * step, cy + moves * step * 0.3);
                const upSync = performance.now() - t;
                if (ed.liquifyPending) await ed.liquifyPending;
                const land = performance.now() - t;
                const blocked = stop();
                const heapMB1 = heapMB();
                const Lq = ed.lastLiquify || {};
                rows.push({ row: `push ${vk} size ${size}`, travel: Math.round(moves * step), press: r1(press), window: r1(windowMs), dab: stat(dab),
                    dabLaps: { nodes: stat2(dabNodes), kernel: stat2(dabKernel), write: stat2(dabWrite) }, frame: stat(frame), preview: stat(prev),
                    land: r1(land), blockedMax: blocked, landSplit: { upSync: r1(upSync), commit: r1(commitMs), heapMB0, heapMB1 },
                    tiles: Lq.tiles, where: Lq.where, stats: Lq.stats, fieldMB: r1(cellBytes() / 1048576), stepMB: r1(((ed.undo[ed.undo.length - 1] || {}).bytes || 0) / 1048576), ...calls() });
                await wait(200);
            }
        }
        // ---- 7: a shrink held in place, then its landing ----
        {
            const cx = Math.round(W * 0.5), cy = Math.round(H * 0.7);   // 7500, 7000 at 15000 x 10000
            view("fit", cx, cy);
            ed.brushSize = 1000;
            ed.liquifyOpts.mode = "shrink";
            pid++;
            resetCalls();
            send("pointerdown", cx, cy);
            const ticks = [], tickNodes = [], tickKernel = [], tickWrite = [];
            for (let i = 0; i < P.SHRINK_TICKS; i++) {
                nodesMs = 0; kernelMs = 0; writeMs = 0;
                const t = performance.now();
                ed.liquifyTick();
                ticks.push(performance.now() - t);
                tickNodes.push(nodesMs); tickKernel.push(kernelMs); tickWrite.push(writeMs);
            }
            commitMs = 0;
            const heapMB0 = heapMB();
            const stop = probe();
            const t = performance.now();
            send("pointerup", cx, cy);
            const upSync = performance.now() - t;
            if (ed.liquifyPending) await ed.liquifyPending;
            const land = performance.now() - t;
            const blocked = stop();
            const heapMB1 = heapMB();
            const Lq = ed.lastLiquify || {};
            rows.push({ row: `shrink held ${P.SHRINK_TICKS} ticks size 1000`, tick: stat(ticks),
                dabLaps: { nodes: stat2(tickNodes), kernel: stat2(tickKernel), write: stat2(tickWrite) },
                land: r1(land), blockedMax: blocked, landSplit: { upSync: r1(upSync), commit: r1(commitMs), heapMB0, heapMB1 },
                tiles: Lq.tiles, where: Lq.where, stats: Lq.stats, maxReachPx: ed.liq ? r1(ed.liq.field.maxReach()) : null, fieldMB: r1(cellBytes() / 1048576), ...calls() });
        }
        // ---- 7b: a restore brush at 1:1 size 1000 over the pushed area (K30-INT-5) ----
        const runRestoreBrush = async (label) => {
            const cx = Math.round(W * 2500 / 15000), cy = Math.round(H * 7000 / 10000);
            view("1:1", cx, cy);
            await ed.mipsSettled();
            ed.brushSize = 1000;
            ed.liquifyOpts.mode = "restore";
            pid++;
            previewMs = 0; windowMs = 0;
            resetCalls();
            let t = performance.now();
            send("pointerdown", cx, cy);
            const press = performance.now() - t;
            const rStep = Math.max(P.MOVE_CSS * dpr / ed.view.scale, 0.1 * ed.brushSize / 2);
            const dab = [], dabNodes = [], dabKernel = [], dabWrite = [], frame = [], prev = [], moves = P.RESTORE_MOVES;
            for (let i = 1; i <= moves; i++) {
                nodesMs = 0; kernelMs = 0; writeMs = 0;
                t = performance.now();
                send("pointermove", cx + i * rStep, cy + i * rStep * 0.3);
                dab.push(performance.now() - t);
                dabNodes.push(nodesMs); dabKernel.push(kernelMs); dabWrite.push(writeMs);
                previewMs = 0;
                t = performance.now();
                ed.draw();
                frame.push(performance.now() - t);
                prev.push(previewMs);
            }
            commitMs = 0;
            const heapMB0 = heapMB();
            const stop = probe();
            t = performance.now();
            send("pointerup", cx + moves * rStep, cy + moves * rStep * 0.3);
            const upSync = performance.now() - t;
            if (ed.liquifyPending) await ed.liquifyPending;
            const land = performance.now() - t;
            const blocked = stop();
            const heapMB1 = heapMB();
            const Lq = ed.lastLiquify || {};
            rows.push({ row: label, travel: Math.round(moves * rStep), press: r1(press), window: r1(windowMs), dab: stat(dab),
                dabLaps: { nodes: stat2(dabNodes), kernel: stat2(dabKernel), write: stat2(dabWrite) }, frame: stat(frame), preview: stat(prev),
                land: r1(land), blockedMax: blocked, landSplit: { upSync: r1(upSync), commit: r1(commitMs), heapMB0, heapMB1 },
                tiles: Lq.tiles, where: Lq.where, stats: Lq.stats, fieldMB: r1(cellBytes() / 1048576), ...calls() });
            await wait(200);
        };
        await runRestoreBrush("restore 1:1 size 1000 pushed");
        // ---- 5: Restore all over the session ----
        {
            resetCalls();
            const stop = probe();
            const t = performance.now();
            ed.liquifyRestoreAll();
            if (ed.liquifyPending) await ed.liquifyPending;
            const Lq = ed.lastLiquify || {};
            rows.push({ row: "restore all", ms: r1(performance.now() - t), blockedMax: stop(), tiles: Lq.tiles, where: Lq.where, fieldMB: r1(cellBytes() / 1048576), ...calls() });
        }
        // ---- 5b: a restore brush at 1:1 size 1000 over an empty area (K30-INT-5) ----
        await runRestoreBrush("restore 1:1 size 1000 empty");
        undoMB = r1(ed.undoBytes / 1048576);
        s = ed.liq ? ed.liq.s : null;
        // ---- 8: a dab after a 2 s pause at 1:1 size 1000 (docs/PLAN_WASM_BUILD.md §7 row 40, K:138-139) ----
        {
            const cx = Math.round(W * 2500 / 15000), cy = Math.round(H * 7000 / 10000);
            view("1:1", cx, cy);
            await ed.mipsSettled();
            ed.brushSize = 1000;
            ed.liquifyOpts.mode = "push";
            const step = P.MOVE_CSS * dpr / ed.view.scale;
            // warm the 1:1 window (~69 MB in PX on the Rust route) so the 2 s idle wait starts from a warm window instance
            pid++;
            send("pointerdown", cx, cy);
            send("pointermove", cx + step, cy + step * 0.3);
            ed.draw();
            send("pointerup", cx + step, cy + step * 0.3);
            if (ed.liquifyPending) await ed.liquifyPending;
            const inst0 = K.pxInstances(), pxMB0 = r1(inst0.bytes / 1048576);
            // touched() marks an active 2 s timer and re-arms once at trimDue, so the idle trim lands within 2 * IDLE_MS (4 s)
            await wait(4100);
            const inst1 = K.pxInstances(), pxMBTrimmed = r1(inst1.bytes / 1048576), idleTrimmed = inst1.idle - inst0.idle;
            pid++;
            previewMs = 0; windowMs = 0;
            resetCalls();
            let t = performance.now();
            send("pointerdown", cx, cy);
            const press = performance.now() - t;
            nodesMs = 0; kernelMs = 0; writeMs = 0;
            t = performance.now();
            send("pointermove", cx + step, cy + step * 0.3);
            const dab = performance.now() - t;
            const dabLaps1 = { nodes: r2(nodesMs), kernel: r2(kernelMs), write: r2(writeMs) };
            t = performance.now();
            ed.draw();
            const frame = performance.now() - t, prev1 = previewMs, win1 = windowMs;
            const inst2 = K.pxInstances(), pxMBGrown = r1(inst2.bytes / 1048576);
            // a pause mid-stroke while the window is held in win.px (even after PX itself trims for idle)
            await wait(4100);
            const inst3 = K.pxInstances(), midIdleTrimmed = inst3.idle - inst2.idle;
            previewMs = 0; windowMs = 0;
            nodesMs = 0; kernelMs = 0; writeMs = 0;
            t = performance.now();
            send("pointermove", cx + 2 * step, cy + 2 * step * 0.3);
            const midDab = performance.now() - t;
            const midDabLaps = { nodes: r2(nodesMs), kernel: r2(kernelMs), write: r2(writeMs) };
            t = performance.now();
            ed.draw();
            const midFrame = performance.now() - t, midPrev = previewMs, midWin = windowMs;
            t = performance.now();
            send("pointerup", cx + 2 * step, cy + 2 * step * 0.3);
            if (ed.liquifyPending) await ed.liquifyPending;
            const land = performance.now() - t;
            rows.push({
                row: "pause 2s 1:1 size 1000", pxMB0, pxMBTrimmed, idleTrimmed, pxMBGrown, press: r1(press), window: r1(win1), dab: r1(dab), dabLaps: dabLaps1, frame: r1(frame), preview: r1(prev1),
                midIdleTrimmed, midWindow: r1(midWin), midDab: r1(midDab), midDabLaps, midFrame: r1(midFrame), midPreview: r1(midPrev), land: r1(land), ...calls(),
            });
        }
    } finally {
        FProto.nodes = nodes0;
        FProto._writeDense = writeDense0;
        FProto._write = write0;
        IE.kernels = kernels0;   // "js" left behind would put every later run of the instance on the twins
        K.adoptRoutes(routes0);
        IE.liquifyRateMs = rate0;
        IE.liquifyDabKernel = dab0;
        if (!P.KEEP) shell.closeDocument(ed, { force: true });
    }
    const table = rows.map((r) => JSON.stringify(r));
    return { built, s, tiles, ...route, undoMB, rows, table };
})()
