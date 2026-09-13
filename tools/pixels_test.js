// The LayerPixels / MaskPixels contract (renderer/editor/inpaint_pixels.js, docs/PLAN_BCE.md C1),
// case by case. Runs inside the app's renderer: tools/pixels_test.py reads this file and
// evaluates it with the module imported as `P`. C2 runs the same cases against the tile backend.
//
// Every case compares against a plain canvas that does what the call sites did before C1, byte
// for byte: the canvas backend must not change a single level.
//
// Defines one function, `pixelsCases(P)`, returning [name, async () => result] pairs.

function pixelsCases(P) {
    const { LayerPixels, MaskPixels } = P;
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    // pixels are read through readRect, never through toCanvas(): with --pixels-copy toCanvas() is a
    // copy, and a copy can sit on another Chromium backing and read back 1 level apart at low alpha
    const bytesOf = (src) => (src instanceof LayerPixels ? src.readRect(0, 0, src.width, src.height) : src.getContext("2d").getImageData(0, 0, src.width, src.height)).data;
    // tolerance: a canvas that was read back a few times is moved to software by Chromium, a fresh
    // copy of it sits on the GPU, and the two un-premultiply differently: 1 level at low alpha
    const same = (a, b, what, tolerance = 0) => {
        const da = bytesOf(a), db = bytesOf(b);
        if (da.length !== db.length) throw new Error(`${what}: ${da.length} bytes against ${db.length}`);
        let n = 0, worst = 0, first = -1;
        for (let i = 0; i < da.length; i++) {
            const d = Math.abs(da[i] - db[i]);
            if (d > tolerance) { n++; if (d > worst) worst = d; if (first < 0) first = i; }
        }
        if (n) {
            const w = (a instanceof LayerPixels ? a.width : a.width);
            const p = first >> 2;
            throw new Error(`${what}: ${n} bytes differ, worst ${worst}, first at ${p % w},${Math.floor(p / w)} (${Array.from(da.slice(p * 4, p * 4 + 4))} vs ${Array.from(db.slice(p * 4, p * 4 + 4))})`);
        }
        return true;
    };
    const px = (src, x, y) => Array.from((src instanceof LayerPixels ? src.readRect(x, y, 1, 1) : src.getContext("2d").getImageData(x, y, 1, 1)).data);
    // a test picture with every alpha level, soft edges and colour: what a premultiply round trip would damage
    const paint = (ctx, w, h) => {
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, "rgba(255,40,20,0.02)");
        g.addColorStop(0.5, "rgba(20,200,90,0.5)");
        g.addColorStop(1, "rgba(30,60,250,1)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "rgba(250,250,0,0.3)";
        ctx.beginPath(); ctx.arc(w * 0.4, h * 0.6, Math.min(w, h) * 0.3, 0, Math.PI * 2); ctx.fill();
        ctx.clearRect(w * 0.7, 0, w * 0.1, h * 0.2);
    };
    const pair = (w, h, Cls = LayerPixels) => {
        const ref = mk(w, h); paint(ref.getContext("2d"), w, h);
        const c = mk(w, h); paint(c.getContext("2d"), w, h);
        return { ref, pixels: Cls.fromCanvas(c) };
    };

    return [
        ["construct_and_size", async () => {
            const e = LayerPixels.empty(300, 200);
            if (e.width !== 300 || e.height !== 200 || e.bytes() !== 300 * 200 * 4) throw new Error("size " + e.width + "x" + e.height);
            if (px(e, 10, 10)[3] !== 0) throw new Error("empty is not transparent");
            const z = LayerPixels.empty(0, -3);
            if (z.width !== 1 || z.height !== 1) throw new Error("degenerate size " + z.width + "x" + z.height);
            const c = mk(40, 30);
            if (P.canvasOf(LayerPixels.fromCanvas(c)) !== c) throw new Error("fromCanvas does not adopt");
            const img = new ImageData(new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 255]), 2, 1);
            const d = LayerPixels.fromImageData(img);
            if (d.width !== 2 || px(d, 1, 0).join() !== "5,6,7,255") throw new Error("fromImageData " + px(d, 1, 0));
            const src = mk(64, 32); paint(src.getContext("2d"), 64, 32);
            same(LayerPixels.fromImage(src), src, "fromImage");
            const m = MaskPixels.empty(8, 8);
            if (!(m instanceof LayerPixels) || !(m.clone() instanceof MaskPixels) || !(m.copyRect([0, 0, 4, 4]) instanceof MaskPixels) || !(m.resized(9, 9) instanceof MaskPixels)) throw new Error("MaskPixels class not kept");
            return { ok: true };
        }],

        ["read_write_rect", async () => {
            const { ref, pixels } = pair(200, 120);
            const a = pixels.readRect(20, 10, 50, 40);
            const b = ref.getContext("2d").getImageData(20, 10, 50, 40);
            if (a.width !== 50 || a.height !== 40) throw new Error("readRect size");
            for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) throw new Error("readRect differs at " + i);
            // clamped: outside reads as transparent
            const o = pixels.readRect(190, 110, 20, 20);
            if (o.data[(15 * 20 + 15) * 4 + 3] !== 0) throw new Error("outside is not transparent");
            // copy = putImageData
            const img = new ImageData(30, 20);
            for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 200; img.data[i + 1] = 10; img.data[i + 2] = 60; img.data[i + 3] = (i / 4) % 256; }
            pixels.writeRect(img, 100, 50);
            ref.getContext("2d").putImageData(img, 100, 50);
            same(pixels, ref, "writeRect copy");
            return { ok: true };
        }],

        ["write_rect_ops", async () => {
            const out = {};
            for (const op of ["source-over", "destination-out", "source-atop", "destination-in", "copy"]) {
                const { ref, pixels } = pair(160, 100);
                const img = new ImageData(60, 40);
                for (let y = 0; y < 40; y++) for (let x = 0; x < 60; x++) {
                    const i = (y * 60 + x) * 4;
                    img.data[i] = x * 4; img.data[i + 1] = 255 - y * 6; img.data[i + 2] = 120; img.data[i + 3] = (x * 7 + y * 3) % 256;
                }
                pixels.writeRect(img, 50, 30, op, 0.7);
                // the reference: the way the call sites draw a scratch with an operation, held to the rectangle
                const s = mk(60, 40); s.getContext("2d").putImageData(img, 0, 0);
                const ctx = ref.getContext("2d");
                ctx.save();
                ctx.globalAlpha = 0.7;
                if (op === "copy") { ctx.clearRect(50, 30, 60, 40); ctx.globalCompositeOperation = "source-over"; }
                else { ctx.globalCompositeOperation = op; const p = new Path2D(); p.rect(50, 30, 60, 40); ctx.clip(p); }
                ctx.drawImage(s, 50, 30);
                ctx.restore();
                same(pixels, ref, "writeRect " + op);
                // outside the rectangle nothing changed, whatever the operation
                const before = mk(160, 100); paint(before.getContext("2d"), 160, 100);
                const corner = px(pixels, 5, 5), was = px(before, 5, 5);
                if (corner.join() !== was.join()) throw new Error(op + " touched the outside: " + corner + " vs " + was);
                out[op] = "same";
            }
            return out;
        }],

        ["draw_into", async () => {
            const { ref, pixels } = pair(180, 140);
            // state left behind by an earlier draw must not reach fn
            const raw = P.canvasOf(pixels).getContext("2d");   // the backing canvas itself, in copy mode too
            raw.setTransform(2, 0, 0, 2, 7, 7); raw.globalAlpha = 0.1; raw.globalCompositeOperation = "xor";
            const rect = [30.4, 20.6, 110.2, 90.9];
            const back = pixels.drawInto(rect, (ctx) => {
                if (ctx.globalAlpha !== 1 || ctx.globalCompositeOperation !== "source-over") throw new Error("context not reset");
                const t = ctx.getTransform();
                if (t.a !== 1 || t.e !== 0) throw new Error("transform not reset");
                ctx.globalCompositeOperation = "destination-out";
                ctx.fillStyle = "rgba(0,0,0,0.6)";
                ctx.beginPath(); ctx.arc(70, 55, 60, 0, Math.PI * 2); ctx.fill();   // reaches outside the rect
                ctx.globalCompositeOperation = "source-over";
                ctx.fillStyle = "#0af";
                ctx.fillRect(0, 0, 50, 50);                                         // reaches outside the rect
                return 42;
            });
            if (back !== 42) throw new Error("drawInto did not return fn's value");
            raw.setTransform(1, 0, 0, 1, 0, 0); raw.globalAlpha = 1; raw.globalCompositeOperation = "source-over";
            const ctx = ref.getContext("2d");
            ctx.save();
            const p = new Path2D(); p.rect(30, 20, 81, 71); ctx.clip(p);   // outward to whole pixels
            ctx.globalCompositeOperation = "destination-out";
            ctx.fillStyle = "rgba(0,0,0,0.6)";
            ctx.beginPath(); ctx.arc(70, 55, 60, 0, Math.PI * 2); ctx.fill();
            ctx.globalCompositeOperation = "source-over";
            ctx.fillStyle = "#0af";
            ctx.fillRect(0, 0, 50, 50);
            ctx.restore();
            same(pixels, ref, "drawInto clipped");
            // null = everything, no clip; an empty rect draws nothing
            const { ref: r2, pixels: p2 } = pair(90, 60);
            p2.drawInto(null, (c) => { c.fillStyle = "rgba(10,20,30,0.5)"; c.fillRect(-10, -10, 200, 200); });
            const c2 = r2.getContext("2d"); c2.fillStyle = "rgba(10,20,30,0.5)"; c2.fillRect(-10, -10, 200, 200);
            same(p2, r2, "drawInto whole");
            let called = false;
            p2.drawInto([95, 0, 120, 10], () => { called = true; });
            if (called) throw new Error("fn ran for a rect outside the pixels");
            // what an earlier draw left on the context (a path, a fill style, a line width) does not reach fn:
            // paint() left its arc path and a translucent fill style behind
            const { ref: r3, pixels: p3 } = pair(90, 60);
            p3.drawInto([10, 10, 80, 50], (c) => { c.moveTo(10, 10); c.lineTo(80, 50); c.lineTo(10, 50); c.fill(); c.stroke(); });
            const c3 = r3.getContext("2d"); c3.save(); const q = new Path2D(); q.rect(10, 10, 70, 40); c3.clip(q);
            c3.beginPath(); c3.fillStyle = "#000000"; c3.strokeStyle = "#000000"; c3.lineWidth = 1;
            c3.moveTo(10, 10); c3.lineTo(80, 50); c3.lineTo(10, 50); c3.fill(); c3.stroke(); c3.restore();
            same(p3, r3, "drawInto starts from a fresh context");
            return { ok: true };
        }],

        ["draw_to", async () => {
            const { pixels } = pair(120, 80);
            const a = mk(60, 40), b = mk(60, 40);
            pixels.drawTo(a.getContext("2d"), 10, 5, 100, 70, 0, 0, 60, 40);
            b.getContext("2d").drawImage(P.canvasOf(pixels), 10, 5, 100, 70, 0, 0, 60, 40);
            same(a, b, "drawTo 9 args");
            const e = mk(120, 80), f = mk(120, 80);
            pixels.drawTo(e.getContext("2d"), 3, 4);
            f.getContext("2d").drawImage(P.canvasOf(pixels), 3, 4);
            same(e, f, "drawTo 3 args");
            return { ok: true };
        }],

        ["blit_and_copy_rect", async () => {
            const { ref, pixels } = pair(200, 150);
            const part = pixels.copyRect([40.5, 30, 140, 100.2]);
            if (part.width !== 100 || part.height !== 71) throw new Error("copyRect size " + part.width + "x" + part.height);
            const refPart = mk(100, 71); refPart.getContext("2d").drawImage(ref, 40, 30, 100, 71, 0, 0, 100, 71);
            same(part, refPart, "copyRect");
            if (pixels.copyRect([250, 0, 300, 10]) !== null) throw new Error("copyRect outside is not null");
            // an undo round trip: scribble, then put the copy back with "copy" -> exactly the old pixels (alpha included)
            pixels.drawInto(null, (c) => { c.globalCompositeOperation = "destination-out"; c.fillStyle = "#000"; c.fillRect(0, 0, 200, 150); });
            pixels.blit(part, 40, 30, "copy");
            const back = mk(200, 150);
            const bc = back.getContext("2d"); bc.drawImage(refPart, 40, 30);
            same(pixels, back, "blit copy (the outside was erased, the rectangle came back exactly)");
            // source-over at an alpha, from a part of the source
            const { ref: r2, pixels: p2 } = pair(120, 90);
            const src = pair(60, 60).pixels;
            p2.blit(src, 30, 20, "source-over", 0.35, [10, 10, 50, 40]);
            const c2 = r2.getContext("2d"); c2.globalAlpha = 0.35; c2.drawImage(P.canvasOf(src), 10, 10, 40, 30, 30, 20, 40, 30);
            same(p2, r2, "blit source-over with srcRect");
            return { ok: true };
        }],

        ["clear_fill_bounds", async () => {
            const { ref, pixels } = pair(100, 80);
            pixels.clear([10, 10, 30.5, 20]);
            ref.getContext("2d").clearRect(10, 10, 21, 10);
            same(pixels, ref, "clear");
            pixels.fill([50, 40, 70, 60], "rgba(255,0,0,0.5)");
            const rc = ref.getContext("2d"); rc.clearRect(50, 40, 20, 20); rc.fillStyle = "rgba(255,0,0,0.5)"; rc.fillRect(50, 40, 20, 20);
            same(pixels, ref, "fill");
            const e = LayerPixels.empty(700, 1100);
            if (e.bounds() !== null) throw new Error("empty bounds");
            e.fill([613, 530, 614, 531], "#fff");
            e.fill([20, 1090, 22, 1093], "rgba(0,0,0,0.01)");
            const b = e.bounds();
            if (!b || b.join() !== "20,530,614,1093") throw new Error("bounds " + b);
            return { bounds: b };
        }],

        ["clone_resized_to_canvas", async () => {
            const { pixels } = pair(90, 70);
            const c = pixels.clone();
            same(c, pixels, "clone");
            c.clear();
            if (px(pixels, 45, 35)[3] === 0) throw new Error("clearing the clone cleared the original");
            const big = pixels.resized(130, 100, { x: 20, y: 10 });
            const rb = mk(130, 100); rb.getContext("2d").drawImage(P.canvasOf(pixels), 20, 10);
            same(big, rb, "resized (extend)");
            const small = pixels.resized(50, 40, { x: -15, y: -5 });
            const rs = mk(50, 40); rs.getContext("2d").drawImage(P.canvasOf(pixels), -15, -5);
            same(small, rs, "resized (crop)");
            // share mode hands out the canvas, copy mode a copy with the same pixels
            const was = P.pixelsOptions().copy;
            try {
                P.setPixelsOptions({ copy: false });
                if (pixels.toCanvas() !== pixels.toCanvas()) throw new Error("share mode made a copy");
                P.setPixelsOptions({ copy: true });
                const k = pixels.toCanvas();
                if (k === pixels.toCanvas()) throw new Error("copy mode shared the canvas");
                same(k, P.canvasOf(pixels), "copy mode copy", 1);
                k.getContext("2d").clearRect(0, 0, 90, 70);
                if (px(pixels, 45, 35)[3] === 0) throw new Error("a write into the copy reached the pixels");
            } finally {
                P.setPixelsOptions({ copy: was });
            }
            const part = pixels.toCanvas([10, 10, 30, 25]);
            if (part.width !== 20 || part.height !== 15 || part === P.canvasOf(pixels)) throw new Error("toCanvas(rect)");
            return { ok: true };
        }],

        ["version_and_canvas_of", async () => {
            const e = LayerPixels.empty(10, 10);
            const v0 = e.version;
            e.touch(); e.touch([0, 0, 2, 2]);
            if (e.version !== v0 + 2) throw new Error("version " + e.version);
            const c = mk(4, 4);
            if (P.canvasOf(c) !== c || P.canvasOf(LayerPixels.fromCanvas(c)) !== c) throw new Error("canvasOf");
            // the display pyramid keys on the canvas's _dispVer: the facade's version is the same number
            P.canvasOf(e)._dispVer = 77;
            if (e.version !== 77) throw new Error("version is not the canvas's _dispVer");
            return { ok: true };
        }],

        ["layer_aliases", async () => {
            const was = P.pixelsOptions().strict;
            const warnings = [];
            const orig = console.warn;
            try {
                console.warn = (...a) => { warnings.push(a.join(" ")); };
                P.setPixelsOptions({ strict: false });
                const c = mk(8, 8), m = mk(8, 8);
                const L = P.installLayerAliases({ id: "x", canvas: c, mask: m, x: 1 });
                if (!(L.px instanceof LayerPixels) || !(L.maskPx instanceof MaskPixels)) throw new Error("own canvas / mask not converted");
                if (Object.keys(L).includes("canvas") || Object.keys(L).includes("mask")) throw new Error("the aliases are enumerable");
                const copy = { ...L };
                if (!("px" in copy) || "canvas" in copy) throw new Error("a spread copy carries the alias or lost px");
                // the getter is toCanvas(): the canvas itself in share mode, a copy with --pixels-copy
                const handed = L.canvas;
                if (P.pixelsOptions().copy ? (handed === c || handed.width !== 8) : handed !== c) throw new Error("the getter does not hand out the canvas");
                L.mask = null;
                if (L.maskPx !== null) throw new Error("the setter did not clear maskPx");
                const N = P.installLayerAliases({ id: "y", px: null, maskPx: null });
                if (N.canvas !== null || N.mask !== null) throw new Error("null pixels");
                if (!warnings.length) throw new Error("no deprecation warning");
                P.setPixelsOptions({ strict: true });
                let threw = 0;
                try { void L.canvas; } catch (_) { threw++; }
                try { L.canvas = mk(2, 2); } catch (_) { threw++; }
                try { P.installLayerAliases({ canvas: mk(2, 2) }); } catch (_) { threw++; }
                P.installLayerAliases({ canvas: null });   // a null value is not a use of the old name
                if (threw !== 3) throw new Error("strict mode threw " + threw + " of 3 times");
            } finally {
                console.warn = orig;
                P.setPixelsOptions({ strict: was });
            }
            return { warnings: warnings.length };
        }],
    ];
}
