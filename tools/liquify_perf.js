/* global window, document, PointerEvent */
// Liquify on a large document (15000 x 10000 by default, grid step 4): the press, the frame while a push drags (the dabs,
// the preview, the rest of the draw), the landing and how long it holds the window, Restore all, a long shrink held in
// place and the field's and the undo steps' bytes (docs/PLAN_0_1_31.md §5 step 5b, docs/PERFORMANCE.md §15). One
// expression, evaluated in a running instance by `python tools/brush_perf.py '<json>' liquify_perf.js` (the window in
// front). Parameters: `window.__bp` (the defaults below). A fresh dev instance on a profile of its own, --no-comfy.
(async () => {
    const P = Object.assign({
        W: 15000, H: 10000,
        SIZES: [200, 1000],
        VIEWS: ["fit", "1:1"],
        MOVES: 60,                       // pointer moves per push at 1:1 (15 image px each at dpr 1.25)
        MOVES_FIT: 20,                   // at fit (a move there is about 200 image px: 4,000 px of travel)
        MOVE_CSS: 12,                    // CSS px per move
        SHRINK_TICKS: 150,               // about 5 s of the 33 ms timer, as ticks
    }, window.__bp || {});
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const r1 = (v) => (v == null ? null : +v.toFixed(1));
    const stat = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return { p50: r1(s[Math.floor(s.length / 2)]), p95: r1(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]), worst: r1(s[s.length - 1]) }; };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const shell = await import("./shell.js");
    const probe = () => {
        let last = performance.now(), max = 0, stop = false;
        const tick = () => { if (stop) return; const now = performance.now(); if (now - last > max) max = now - last; last = now; setTimeout(tick, 0); };
        setTimeout(tick, 0);
        return () => { const now = performance.now(); if (now - last > max) max = now - last; stop = true; return r1(max); };
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
    // the preview's own share of a draw
    let previewMs = 0;
    { const f = ed.drawLiquifyInto; ed.drawLiquifyInto = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { previewMs += performance.now() - t; } }; }
    let windowMs = 0;
    { const f = ed.liquifyWindow; ed.liquifyWindow = function (p, vp) { const had = p.liqWin; const t = performance.now(); const r = f.call(this, p, vp); if (p.liqWin !== had) windowMs += performance.now() - t; return r; }; }
    const view = (kind, cx, cy) => {
        if (kind === "fit") ed.fitView();
        else { ed.view.angle = 0; ed.view.scale = 1; ed._fitted = false; ed.view.x = ed.canvas.width / 2 - cx; ed.view.y = ed.canvas.height / 2 - cy; }
        ed.draw();
    };
    const cellBytes = () => { const f = ed.liq && ed.liq.field; if (!f) return 0; return f.cells.size * f.n * f.n * 8; };
    const rows = [];
    // ---- 1, 2, 4: a push per view and size: the press, the frames, the landing ----
    let row = 0;
    for (const vk of P.VIEWS) {
        for (const size of P.SIZES) {
            const cx = 2500 + (row % 3) * 4500, cy = 2500 + Math.floor(row / 3) * 4500;
            row++;
            view(vk, cx, cy);
            await ed.mipsSettled();
            ed.brushSize = size;
            ed.liquifyOpts.mode = "push";
            pid++;
            previewMs = 0; windowMs = 0;
            let t = performance.now();
            send("pointerdown", cx, cy);
            const press = performance.now() - t;
            const step = P.MOVE_CSS * dpr / ed.view.scale;
            const dab = [], frame = [], prev = [], moves = vk === "fit" ? P.MOVES_FIT : P.MOVES;
            for (let i = 1; i <= moves; i++) {
                t = performance.now();
                send("pointermove", cx + i * step, cy + i * step * 0.3);
                dab.push(performance.now() - t);
                previewMs = 0;
                t = performance.now();
                ed.draw();
                frame.push(performance.now() - t);
                prev.push(previewMs);
            }
            const stop = probe();
            t = performance.now();
            send("pointerup", cx + moves * step, cy + moves * step * 0.3);
            if (ed.liquifyPending) await ed.liquifyPending;
            const land = performance.now() - t;
            const blocked = stop();
            const L = ed.lastLiquify || {};
            rows.push({ row: `push ${vk} size ${size}`, travel: Math.round(moves * step), press: r1(press), window: r1(windowMs), dab: stat(dab), frame: stat(frame), preview: stat(prev),
                land: r1(land), blockedMax: blocked, tiles: L.tiles, where: L.where, stats: L.stats, fieldMB: r1(cellBytes() / 1048576), stepMB: r1(((ed.undo[ed.undo.length - 1] || {}).bytes || 0) / 1048576) });
            await wait(200);
        }
    }
    // ---- 7: a shrink held in place, then its landing ----
    {
        const cx = 7500, cy = 7000;
        view("fit", cx, cy);
        ed.brushSize = 1000;
        ed.liquifyOpts.mode = "shrink";
        pid++;
        send("pointerdown", cx, cy);
        const ticks = [];
        for (let i = 0; i < P.SHRINK_TICKS; i++) { const t = performance.now(); ed.liquifyTick(); ticks.push(performance.now() - t); }
        const stop = probe();
        const t = performance.now();
        send("pointerup", cx, cy);
        if (ed.liquifyPending) await ed.liquifyPending;
        const land = performance.now() - t;
        const L = ed.lastLiquify || {};
        rows.push({ row: `shrink held ${P.SHRINK_TICKS} ticks size 1000`, tick: stat(ticks), land: r1(land), blockedMax: stop(), tiles: L.tiles, where: L.where, stats: L.stats,
            maxReachPx: ed.liq ? r1(ed.liq.field.maxReach()) : null, fieldMB: r1(cellBytes() / 1048576) });
    }
    // ---- 5: Restore all over the session ----
    {
        const stop = probe();
        const t = performance.now();
        ed.liquifyRestoreAll();
        if (ed.liquifyPending) await ed.liquifyPending;
        const L = ed.lastLiquify || {};
        rows.push({ row: "restore all", ms: r1(performance.now() - t), blockedMax: stop(), tiles: L.tiles, where: L.where, fieldMB: r1(cellBytes() / 1048576) });
    }
    const undoMB = r1(ed.undoBytes / 1048576);
    const table = rows.map((r) => JSON.stringify(r));
    return { built, s: ed.liq ? ed.liq.s : null, tiles: ed.tileMode, undoMB, rows, table };
})()
