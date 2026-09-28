/* global window, document, PointerEvent, requestAnimationFrame */
// Smudge, clone and heal on a large document (15000 x 10000 by default): ms per pointer move and per press, and the
// mirrors and the whole composite they hold (docs/PLAN_0_1_31.md §4 steps 1 and 2, docs/PERFORMANCE.md §15). One
// expression, evaluated in a running instance by tools/brush_perf.py (which brings the window to the front first and
// allows a longer run than cdp.py's 600 s). Parameters: `window.__bp = { ... }` before it (the defaults below). Run it
// against a fresh dev instance on a profile of its own, --no-comfy, tiles on (the default); restart before every tool.
(async () => {
    const P = Object.assign({
        W: 15000, H: 10000,
        TOOLS: ["smudge", "clone", "heal"],
        SIZES: [50, 200, 400],           // image px; 1000 / 2000 for step 7 (set on ed.brushSize: setBrushSize caps at 400)
        SAMPLES: ["image", "layer"],     // clone / heal: the options bar's Sample (ed.cloneOpts.sample)
        VIEWS: ["fit", "1:1"],
        MOVES: 30,                       // pointer moves per stroke
        MOVE_CSS: 12,                    // CSS px per move: a steady hand at 60 Hz (720 px/s on the screen)
        MODE: "sync",                    // "sync": each move, then one draw() timed here; "raf": the app's own frames (window in front)
        GAP: 4,                          // ms between moves (sync: lets the probe run; raf: use 16)
        PEN: 0,                          // 0 = mouse; 0 < p <= 1 = pointerType "pen" at that pressure (the radius scales with it)
        BASE_ROW: true,                  // smudge with the base active: the press adds a layer (a full "Base copy" before 0.1.32)
        KEEP: false,                     // keep the document (window.__bpDoc) for the next run
    }, window.__bp || {});
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const r1 = (v) => (v == null ? null : +v.toFixed(1));
    const stat = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return { med: r1(s[Math.floor(s.length / 2)]), worst: r1(s[s.length - 1]), n: s.length }; };
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const shell = await import("./shell.js");
    const host = (await import("./editor/host.js")).host;
    // how long the main thread was held: a 0 ms timer chain (Chromium clamps it to about 4 ms), as tools/perf_test.py's probe
    const probe = () => {
        let last = performance.now(), max = 0, sum = 0, over50 = 0, stop = false;
        const gap = (now) => { const g = now - last; if (g > max) max = g; if (g > 8) sum += g; if (g > 50) over50++; last = now; };
        const tick = () => { if (stop) return; gap(performance.now()); setTimeout(tick, 0); };
        setTimeout(tick, 0);
        return () => { gap(performance.now()); stop = true; return { max: r1(max), sum: Math.round(sum), over50 }; };
    };

    // ---- the document: a textured base and a full-size textured paint layer (built once; KEEP reuses it) ----
    let ed = window.__bpDoc != null ? host.editors().find((e) => e.node.id === window.__bpDoc) : null;
    const built = { reused: !!ed };
    if (!ed) {
        const t0 = performance.now();
        ed = shell.newDocument();
        shell.activate(ed);
        await wait(300);   // not requestAnimationFrame: it never fires in a hidden window
        ed.resizeCanvas();
        const W = P.W, H = P.H;
        const tile = mk(256, 256);   // a 256 px noise tile, repeated: every dab has texture under it
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
        // a canvas that looks like an <img> to the editor (no upload, no PNG encode), as perf_test.py and px_jobs.py do
        Object.defineProperty(base, "naturalWidth", { value: W });
        Object.defineProperty(base, "naturalHeight", { value: H });
        await ed.setBase({ filename: "brushperf.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
        if (ed.tileMode) base.width = 1;   // the tiles copied it
        const pc = mk(W, H);
        {
            const x = pc.getContext("2d");
            x.fillStyle = "hsla(40,80%,55%,0.5)"; x.fillRect(0, 0, W, H);
            x.globalAlpha = 0.6; x.translate(97, 53); x.fillStyle = x.createPattern(tile, "repeat"); x.fillRect(-97, -53, W, H);
        }
        const L = ed.addLayer({ name: "Paint", kind: "paint", px: ed.pixels.Layer.fromCanvas(pc), x: 0, y: 0, w: W, h: H, dirty: true });
        if (ed.tileMode) pc.width = 1;   // the canvas backend adopts the canvas as the layer's pixels
        ed.activeLayerId = L.id;
        ed.renderLayers(); ed.fitView(); ed.draw();
        await ed.mipsSettled();
        window.__bpDoc = ed.node.id;
        built.ms = Math.round(performance.now() - t0);
    }
    shell.activate(ed);
    const W = ed.width, H = ed.height, dpr = window.devicePixelRatio || 1;

    // ---- the real pointer handlers, driven by synthetic PointerEvents (the brush / editor gates' client() helper) ----
    let k = 0, pid = 60;
    const client = (ix, iy) => {
        const rect = ed.canvas.getBoundingClientRect();
        const [sx, sy] = ed.imageToScreen(ix, iy);
        return { clientX: rect.left + sx * rect.width / ed.canvas.width, clientY: rect.top + sy * rect.height / ed.canvas.height };
    };
    const ev = (type, ix, iy, extra = {}) => new PointerEvent(type, Object.assign({
        bubbles: true, cancelable: true, pointerId: pid, isPrimary: true,
        pointerType: P.PEN ? "pen" : "mouse", pressure: type === "pointerup" ? 0 : (P.PEN || 0.5),
        button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1,
    }, client(ix, iy), extra));
    // dispatchEvent runs the handler synchronously: the time around it is the handler's
    const send = (type, ix, iy, extra) => { const t = performance.now(); ed.canvas.dispatchEvent(ev(type, ix, iy, extra)); return performance.now() - t; };
    // every stroke on a row of its own (strokes may overlap other tools' rows: the costs do not depend on it)
    const place = () => { const y = Math.round(H * (0.12 + ((k * 0.07) % 0.76))); k++; return { x0: Math.round(W * 0.17), y }; };
    const src = (x0, y) => [x0 - Math.round(W * 0.1), y - Math.round(H * 0.03)];   // the clone source, left of and above the stroke
    const settle = async () => {
        await ed.mipsSettled();   // the chains earlier rows asked for land first, so this row is not charged with them
        await wait(60);
        try { ed.canvas.getContext("2d").getImageData(0, 0, 1, 1); } catch (_) { /* drain the screen's GPU queue */ }
        try { const c = ed.compositor && ed.compositor(); if (c) c.gl.finish(); } catch (_) { /* no compositor */ }
        await wait(30);
    };
    const mem = () => {
        const t = ed.memoryReport().tiles, f = ed.flatCache && ed.flatCache.canvas;
        return { mirrorMB: t ? Math.round(t.mirrorBytes / 1048576) : null, tilesMB: t ? Math.round(t.bytes / 1048576) : null, flatMB: f ? Math.round(f.width * f.height * 4 / 1048576) : 0 };
    };

    const stroke = async (tool, size, view, sample, opts = {}) => {
        const moves = opts.moves || P.MOVES;
        const L = ed.layers.find((l) => l.name === "Paint");
        const { x0, y } = place();
        pid++;
        ed.setTool(tool);
        ed.brushSize = size; ed.hardness = 0.5; ed.brushOpacity = 1; ed.brushTipId = null;
        if (ed.smudgeOpts) ed.smudgeOpts.strength = 60;
        ed.activeLayerId = opts.onBase ? null : L.id;
        ed.renderLayers();
        ed.view.angle = 0;
        let scale = 1;
        if (view === "fit") { ed.fitView(); scale = ed.view.scale; }
        const d = P.MOVE_CSS * dpr / scale, len = d * moves;   // image px per move: a hand's move on the screen at this zoom
        if (view !== "fit") { ed.view.scale = 1; ed._fitted = false; ed.view.x = Math.round(ed.canvas.width / 2 - (x0 + len / 2)); ed.view.y = Math.round(ed.canvas.height / 2 - y); }
        ed.sceneSig = null; ed.draw();
        if (tool === "clone" || tool === "heal") {
            const [sx, sy] = src(x0, y);
            ed.cloneOpts = { sample, aligned: false };   // not aligned: every press takes the offset source - press point
            send("pointerdown", sx, sy, { altKey: true });   // Alt+click sets the source point and starts no gesture
            send("pointerup", sx, sy);
            if (!ed.cloneSource || Math.abs(ed.cloneSource.x - sx) > 1 || Math.abs(ed.cloneSource.y - sy) > 1) throw new Error(tool + ": Alt+click did not set the source: " + JSON.stringify(ed.cloneSource));
        }
        await settle();
        const m0 = mem();
        const box = [Math.round(x0 + len / 2 - 32), Math.round(y - 32), 64, 64];
        const before = L.px.readRect(box[0], box[1], box[2], box[3]).data.slice();
        const proto = Object.getPrototypeOf(ed).draw;
        const other = [];   // draws this loop did not ask for: the app's rAF frames, landings
        ed.draw = function (...a) { const t = performance.now(); try { return proto.apply(this, a); } finally { other.push(performance.now() - t); } };
        const row = { tool: opts.onBase ? "smudge (base)" : tool, sample: tool === "smudge" ? "-" : sample, size, view, scale: +scale.toFixed(3), pxPerMove: r1(d), cold: !!opts.cold };
        try {
            const hold = probe();
            row.press = r1(send("pointerdown", x0, y));   // the press and its own draw() (onPointerDown ends with one)
            row.kind = ed.pointer ? ed.pointer.kind : null; row.memPress = mem();
            if (!row.kind) throw new Error(row.tool + ": the press started no gesture: " + ed.status);
            other.length = 0;
            const dab = [], frame = [], per = [];
            for (let i = 1; i <= moves; i++) {
                const x = x0 + d * i;
                if (P.MODE === "sync") {
                    ed._drawQueued = true;   // the move's drawSoon() stays quiet: one draw per move, timed here
                    const a = send("pointermove", x, y);
                    const t = performance.now();
                    proto.call(ed);
                    const f = performance.now() - t;
                    ed._drawQueued = false;
                    dab.push(a); frame.push(f); per.push(a + f);
                } else dab.push(send("pointermove", x, y));
                await wait(P.GAP);
            }
            row.blocked = hold();
            const others = other.splice(0);
            row.firstMove = r1(P.MODE === "sync" ? per[0] : dab[0]);
            row.move = stat((P.MODE === "sync" ? per : dab).slice(1));
            row.dab = stat(dab.slice(1));
            row.frame = P.MODE === "sync" ? stat(frame.slice(1)) : stat(others);
            row.otherFrames = others.length;
            await wait(30);
            const hold2 = probe();
            ed.lastHeal = null;   // a row whose heal keeps the quick heal notes none
            row.up = r1(send("pointerup", x0 + len, y));   // the commit (or markLayerChanged of the whole layer for smudge) and the release's draw()
            // heal blends at the release (PLAN_0_1_31 §5 step 2): a large stroke in a worker, the gesture held until it lands
            if (ed.healPending) { const t = performance.now(); await ed.healPending; row.healWait = r1(performance.now() - t); }
            if (tool === "heal" && ed.lastHeal) row.heal = { where: ed.lastHeal.where, ms: ed.lastHeal.ms, px: ed.lastHeal.unknowns, box: ed.lastHeal.box.slice(2), cycles: ed.lastHeal.info && ed.lastHeal.info[1] };
            await ed.mipsSettled();
            await wait(30);
            row.release = hold2();
        } finally {
            delete ed.draw;
            ed._drawQueued = false;
            if (ed.pointer) send("pointerup", x0, y);
        }
        const after = L.px.readRect(box[0], box[1], box[2], box[3]).data;
        let changed = 0;
        for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) changed++;
        row.changed = changed;   // bytes of a 64 px box at the stroke's middle that moved (0 for the base row: it paints on the copy)
        row.mem = [m0, mem()];
        return row;
    };

    const out = { size: `${W}x${H}`, tiles: ed.tileMode, kernels: ed.constructor.kernels, dpr, canvas: [ed.canvas.width, ed.canvas.height],
        visible: document.visibilityState, focused: document.hasFocus(), params: P, built, rows: [] };
    if (P.MODE === "raf") {
        const raf = await new Promise((r) => { const t = setTimeout(() => r(false), 3000); requestAnimationFrame(() => { clearTimeout(t); r(true); }); });
        if (!raf) throw new Error("requestAnimationFrame does not fire (" + document.visibilityState + "): bring the window to the front, or MODE sync");
    }
    try {
        for (const tool of P.TOOLS) {
            const samples = tool === "smudge" ? ["-"] : P.SAMPLES;
            for (const sample of samples) {
                ed.releaseCaches({ mirrors: true });   // each tool / sample starts without display mirrors or the cached composite
                out.rows.push(await stroke(tool, 200, "fit", sample, { moves: 6, cold: true }));
                for (const view of P.VIEWS) for (const size of P.SIZES) out.rows.push(await stroke(tool, size, view, sample));
            }
            if (tool === "smudge" && P.BASE_ROW) {
                ed.releaseCaches({ mirrors: true });
                const ids0 = new Set(ed.layers.map((l) => l.id));
                out.rows.push(await stroke("smudge", 200, "fit", "-", { moves: 6, onBase: true }));
                // the layer the smudge on the base added (a "Base copy" before 0.1.32, a new paint layer since)
                for (const l of ed.layers.filter((x) => !ids0.has(x.id))) ed.removeLayer(l.id);
                ed.renderLayers();
                ed.clearUndo();
                ed.releaseCaches({ mirrors: true });
            }
        }
    } finally {
        if (!P.KEEP) { shell.closeDocument(ed, { force: true }); window.__bpDoc = null; }
    }
    out.table = ["tool | sample | size | view | px/move | press | 1st move | move med | move worst | frame med | blocked max | blocked sum | up | release max | mirror MB | flat MB | changed"]
        .concat(out.rows.map((r) => [r.tool + (r.cold ? " (cold)" : ""), r.sample, r.size, r.view, r.pxPerMove, r.press, r.firstMove,
            r.move ? r.move.med : "-", r.move ? r.move.worst : "-", r.frame ? r.frame.med : "-", r.blocked.max, r.blocked.sum, r.up,
            r.release.max, r.mem[1].mirrorMB, (r.memPress || {}).flatMB, r.changed].join(" | ")));
    return out;
})()
