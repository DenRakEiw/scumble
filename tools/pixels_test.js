// The LayerPixels / MaskPixels contract (renderer/editor/inpaint_pixels.js, docs/PLAN_BCE.md C1 and
// C2), case by case, for both backends. Runs inside the app's renderer: tools/pixels_test.py reads
// this file and evaluates it with inpaint_pixels.js imported as `P` and inpaint_tiles.js as `T`.
//
// Every case runs three times:
//   canvas      the canvas backend as the app runs it (Chromium rasterises its canvases on the GPU);
//               every check against a plain canvas holds byte for byte, as in C1
//   canvas-cpu  the canvas backend with setPixelsOptions({ software: true }): its canvases, and the
//               reference canvases of the case, get a willReadFrequently context and are rasterised
//               on the CPU, like the tile backend's scratch
//   tiles       the tile backend (inpaint_tiles.js) with the app's options (software off: the canvas
//               backend's canvases made inside a case are GPU canvases, as in the app); only the
//               reference canvases of the case (`mk`) are CPU canvases
// and every output a case checks is recorded and compared between canvas-cpu and tiles byte for
// byte. A tolerance there is only allowed where a measured cause says why (TOLERANCES below). The
// GPU run is compared with the tile run as information only (gpuVsTiles): the GPU and the CPU
// rasterise anti-aliased edges, gradients and resampling differently, by tens of levels.
//
// Defines one function, `pixelsCases(P, T)`, returning [name, async () => result] pairs.

function pixelsCases(P, T) {
    const BACKENDS = [
        { name: "canvas", Layer: P.LayerPixels, Mask: P.MaskPixels, tiles: false, software: false, cpuRefs: false },
        { name: "canvas-cpu", Layer: P.LayerPixels, Mask: P.MaskPixels, tiles: false, software: true, cpuRefs: true },
        { name: "tiles", Layer: T.TileLayerPixels, Mask: T.TileMaskPixels, tiles: true, software: false, cpuRefs: true },
    ];

    // a CPU canvas whatever the options say (a willReadFrequently context, and nothing drawn into it
    // from a GPU canvas, which would move it to the GPU)
    const cpuCanvas = (w, h) => {
        const c = document.createElement("canvas");
        c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
        c.getContext("2d", { willReadFrequently: true });
        return c;
    };

    // The helpers of one run of a case against backend B; `rec(what, value)` records an output.
    const kit = (B, rec) => {
        const Layer = B.Layer, Mask = B.Mask;
        const mk = (w, h) => (B.cpuRefs ? cpuCanvas(w, h) : P.makeCanvas(w, h));   // the case's reference canvases
        // pixels are read through readRect, never through toCanvas(): with --pixels-copy toCanvas() is a
        // copy, and a copy can sit on another Chromium backing and read back 1 level apart at low alpha
        const bytesOf = (src) => (src instanceof P.LayerPixels ? src.readRect(0, 0, src.width, src.height) : src.getContext("2d").getImageData(0, 0, src.width, src.height)).data;
        // tolerance: a canvas that was read back a few times is moved to software by Chromium, a fresh
        // copy of it sits on the GPU, and the two un-premultiply differently: 1 level at low alpha
        const same = (a, b, what, tolerance = 0) => {
            const da = bytesOf(a), db = bytesOf(b);
            rec(what, da);
            if (da.length !== db.length) throw new Error(`${what}: ${da.length} bytes against ${db.length}`);
            let n = 0, worst = 0, first = -1;
            for (let i = 0; i < da.length; i++) {
                const d = Math.abs(da[i] - db[i]);
                if (d > tolerance) { n++; if (d > worst) worst = d; if (first < 0) first = i; }
            }
            if (n) {
                const w = a.width;
                const p = first >> 2;
                throw new Error(`${what}: ${n} bytes differ, worst ${worst}, first at ${p % w},${Math.floor(p / w)} (${Array.from(da.slice(p * 4, p * 4 + 4))} vs ${Array.from(db.slice(p * 4, p * 4 + 4))})`);
            }
            return true;
        };
        const snap = (src, what) => { rec(what, bytesOf(src)); return src; };
        const px = (src, x, y) => Array.from((src instanceof P.LayerPixels ? src.readRect(x, y, 1, 1) : src.getContext("2d").getImageData(x, y, 1, 1)).data);
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
        const pair = (w, h, Cls = Layer) => {
            const ref = mk(w, h); paint(ref.getContext("2d"), w, h);
            const c = mk(w, h); paint(c.getContext("2d"), w, h);
            return { ref, pixels: Cls.fromCanvas(c) };
        };
        const tiles = (p, n, what) => {   // the tile count, checked in the tile run only
            if (B.tiles && p.tileCount !== n) throw new Error(`${what}: ${p.tileCount} tiles, expected ${n}`);
            if (B.tiles && p.bytes() !== n * 256 * 256 * 4) throw new Error(`${what}: bytes() ${p.bytes()} for ${p.tileCount} tiles`);
        };
        return { B, P, T, Layer, Mask, mk, bytesOf, same, snap, px, paint, pair, tiles, rec };
    };

    const view = (v) => (ArrayBuffer.isView(v) ? v : null);

    // Runs `body(kit)` on every backend and compares the records of canvas-cpu and tiles.
    // `tolerances`: record name -> { bytes, levels, why }, each measured (docs/PLAN_BCE.md §C2 "C2 as built").
    const both = (body, tolerances = {}) => async () => {
        const was = P.pixelsOptions();
        const results = {}, recs = {};
        for (const B of BACKENDS) {
            const list = [];
            P.setPixelsOptions({ software: B.software });
            try {
                results[B.name] = await body(kit(B, (what, value) => list.push([what, value])));
            } catch (err) {
                throw new Error(`[${B.name}] ${err && err.message}`);
            } finally {
                P.setPixelsOptions({ software: was.software });
            }
            recs[B.name] = list;
        }
        const compare = (a, b, strict) => {
            if (a.length !== b.length) throw new Error(`${a.length} records against ${b.length}`);
            const out = { records: a.length, bytes: 0, differing: 0, differingBytes: 0, worst: 0, tolerated: {} };
            for (let i = 0; i < a.length; i++) {
                const [name, va] = a[i], [nameB, vb] = b[i];
                if (name !== nameB) throw new Error(`record ${i} is "${name}" against "${nameB}"`);
                const ta = view(va), tb = view(vb);
                if (!ta || !tb) {
                    if (JSON.stringify(va) !== JSON.stringify(vb)) {
                        if (strict) throw new Error(`${name}: ${JSON.stringify(va)} against ${JSON.stringify(vb)}`);
                        out.differing++;
                    }
                    continue;
                }
                if (ta.length !== tb.length) throw new Error(`${name}: ${ta.length} bytes against ${tb.length}`);
                out.bytes += ta.length;
                let n = 0, worst = 0;
                for (let j = 0; j < ta.length; j++) { const d = Math.abs(ta[j] - tb[j]); if (d) { n++; if (d > worst) worst = d; } }
                if (!n) continue;
                out.differing++; out.differingBytes += n; out.worst = Math.max(out.worst, worst);
                if (!strict) continue;
                const tol = tolerances[name];
                if (!tol || n !== tol.bytes || worst !== tol.levels) {
                    throw new Error(`canvas-cpu vs tiles, ${name}: ${n} bytes differ, worst ${worst}` + (tol ? ` (tolerated exactly: ${tol.bytes} bytes, ${tol.levels} levels: ${tol.why})` : ""));
                }
                out.tolerated[name] = { bytes: n, worst };
            }
            if (strict) {
                // a tolerance is the exact difference measured: one that is no longer seen is a change too
                for (const name of Object.keys(tolerances)) {
                    if (!out.tolerated[name]) throw new Error(`canvas-cpu vs tiles, ${name}: no difference any more, the tolerance (${tolerances[name].bytes} bytes) is stale`);
                }
            }
            return out;
        };
        const cpu = compare(recs["canvas-cpu"], recs.tiles, true);
        const gpu = compare(recs.canvas, recs.tiles, false);
        return {
            ...results.tiles, compared: cpu.records, comparedBytes: cpu.bytes, tolerated: cpu.tolerated,
            gpuVsTiles: { records: gpu.differing, bytes: gpu.differingBytes, worst: gpu.worst },
        };
    };

    // The tile backend draws on a scratch whose origin is the rect's origin (rule 12), and Skia's CPU
    // rasteriser is not exactly translation-invariant: a gradient's position, a resampled image's
    // sample positions and the anti-aliased edges of curves and strokes are computed in float from
    // device coordinates. Gradients and resampled images round a few pixels a level or a few levels
    // apart; the edges of curves and wide strokes by far more: the selection brush and the ellipse
    // marquee drawn far from the origin (selection_shapes_far_from_the_origin) differ by tens of alpha
    // levels, and a pixel can be transparent on one side and not on the other, so the selection's
    // bounds() can differ too. Lines, rectangles, unscaled images and most scaled draws agree to the
    // byte. Measured 2026-09-13 (Chromium 152); each entry is the exact count and size seen, and the
    // comparison fails on any other count or size, also on none.
    const MOVED = "Skia's CPU rasteriser is not exactly translation-invariant, and the tile backend draws on a scratch translated by the rect's origin";
    const TOLERANCES = {
        clear_fill_bounds: { "fill with a gradient": { bytes: 75, levels: 2, why: "a linear gradient on a scratch at 60,0: " + MOVED } },
        scratch_pool: { "the next callback starts fresh": { bytes: 315, levels: 5, why: "a 60 x 50 soft image scaled to 90 x 70 on a scratch at 120,110 (low alpha): " + MOVED } },
        from_image: {
            "fromImage canvas across a strip border (4096)": { bytes: 10, levels: 1, why: "a canvas scaled to 5000 x 300, its second strip drawn translated by 4096: " + MOVED },
            "fromImage img across a strip border (4096)": { bytes: 10, levels: 1, why: "an <img> scaled to 5000 x 300, its second strip drawn translated by 4096: " + MOVED },
        },
        selection_shapes: {
            "the review's worst ellipse": { bytes: 146, levels: 255, why: "an ellipse marquee 213 x 242 px at 1172,1389: alpha up to 68 levels apart at its edge, pixels transparent on one side only (their red 0 against 255): " + MOVED },
            "the review's worst brush dab": { bytes: 21, levels: 255, why: "a 91 px selection-brush dab at 2759,364: alpha up to 48 levels apart at its edge, a pixel transparent on one side only: " + MOVED },
            "30 ellipses": { bytes: 119, levels: 255, why: "30 ellipse marquees of up to 300 px anywhere on 3300 x 2300: " + MOVED },
            "30 brush dabs": { bytes: 106, levels: 255, why: "30 selection-brush dabs of up to 121 px anywhere on 3300 x 2300: " + MOVED },
        },
    };
    // Measured outside the cases too: an arc of radius 160 moved by (-100, -90), 15 bytes at 5 pixels, 2 levels;
    // 150 random ellipse marquees and 150 selection-brush dabs on 3300 x 2300 (the C2 (a) review's generator):
    // 649 and 565 pixels apart, alpha up to 68 and 48 levels, 28 and 7 pixels transparent on one side only,
    // bounds() the same in all 300 (by chance: a pixel transparent on one side only can move it).

    return [
        ["construct_and_size", both(async ({ B, Layer, Mask, mk, same, snap, px, paint }) => {
            const e = Layer.empty(300, 200);
            if (e.width !== 300 || e.height !== 200 || e.bytes() !== (B.tiles ? 0 : 300 * 200 * 4)) throw new Error("size " + e.width + "x" + e.height + " bytes " + e.bytes());
            if (px(e, 10, 10)[3] !== 0) throw new Error("empty is not transparent");
            const z = Layer.empty(0, -3);
            if (z.width !== 1 || z.height !== 1) throw new Error("degenerate size " + z.width + "x" + z.height);
            const c = mk(40, 30); paint(c.getContext("2d"), 40, 30);
            const adopted = Layer.fromCanvas(c);
            // the canvas backend adopts the canvas; the tile backend reads it and hands out a mirror
            if (B.tiles ? P.canvasOf(adopted) === c : P.canvasOf(adopted) !== c) throw new Error("fromCanvas adoption");
            snap(adopted, "fromCanvas");
            const img = new ImageData(new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 255]), 2, 1);
            const d = Layer.fromImageData(img);
            if (d.width !== 2 || px(d, 1, 0).join() !== "5,6,7,255") throw new Error("fromImageData " + px(d, 1, 0));
            snap(d, "fromImageData");
            const src = mk(64, 32); paint(src.getContext("2d"), 64, 32);
            same(Layer.fromImage(src), src, "fromImage");
            const m = Mask.empty(8, 8);
            if (!(m instanceof P.LayerPixels) || !(m instanceof P.MaskPixels) || !(m.clone() instanceof Mask) || !(m.copyRect([0, 0, 4, 4]) instanceof Mask) || !(m.resized(9, 9) instanceof Mask)) throw new Error("MaskPixels class not kept");
            if (!(e instanceof P.LayerPixels) || e instanceof P.MaskPixels) throw new Error("LayerPixels class");
            if (Layer.backend !== T.pixelsBackend(B.tiles) || Mask.backend !== Layer.backend) throw new Error("backend");
            return { ok: true };
        })],

        ["read_write_rect", both(async ({ Layer, mk, same, pair, rec }) => {
            const { ref, pixels } = pair(200, 120);
            const a = pixels.readRect(20, 10, 50, 40);
            const b = ref.getContext("2d").getImageData(20, 10, 50, 40);
            if (a.width !== 50 || a.height !== 40) throw new Error("readRect size");
            for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) throw new Error("readRect differs at " + i);
            rec("readRect", a.data);
            // clamped: outside reads as transparent
            const o = pixels.readRect(190, 110, 20, 20);
            if (o.data[(15 * 20 + 15) * 4 + 3] !== 0) throw new Error("outside is not transparent");
            rec("readRect outside", o.data);
            // negative sizes and fractions, as getImageData takes them
            rec("readRect negative size", pixels.readRect(70.7, 50.2, -30, -20.9).data);
            let threw = false;
            try { pixels.readRect(0, 0, 0, 10); } catch (err) { threw = err.name === "IndexSizeError"; }
            if (!threw) throw new Error("a zero width did not throw IndexSizeError");
            // copy = putImageData
            const img = new ImageData(30, 20);
            for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 200; img.data[i + 1] = 10; img.data[i + 2] = 60; img.data[i + 3] = (i / 4) % 256; }
            pixels.writeRect(img, 100, 50);
            ref.getContext("2d").putImageData(img, 100, 50);
            same(pixels, ref, "writeRect copy");
            pixels.writeRect(img, 180.9, -5.5);
            ref.getContext("2d").putImageData(img, 180.9, -5.5);
            same(pixels, ref, "writeRect copy at fractions and outside");
            // the arguments convert as getImageData / putImageData convert them ([EnforceRange] long):
            // a NaN, an infinity or a value outside 32 bits throws a TypeError, int overflow a RangeError
            const outcome = (f) => { try { const r = f(); return r ? `ok ${r.width}x${r.height} ${Array.from(r.data.slice(0, 8))}` : "ok"; } catch (err) { return err.name; } };
            const reads = [[NaN, Infinity, 5, 5], [undefined, 0, 5, 5], ["x", 0, 5, 5], [4294967396, 100, 12, 12], [1e10, 0, 3, 3],
                [-2147483649, 0, 3, 3], [2147483647, 0, 10, 10], [2147483640, 0, 7, 1], [2147483640, 0, 8, 1], [-2147483640, 0, -8, 1],
                [-2147483640, 0, -9, 1], [0, 0, -2147483648, 1], [0, 0, 2147483647, 5], [0, 0, 100000, 100000], [null, "3", 5.9, -4.2],
                [0, 0, 0.5, 5], [0, 0, 5, -0.9], [-2147483648.9, 0, 5, 1], [30, 20, 2147483647.5, 1]];
            const readOutcomes = reads.map((a) => outcome(() => pixels.readRect(...a)));
            rec("readRect argument conversion", readOutcomes);
            const two = new ImageData(new Uint8ClampedArray([9, 8, 7, 255, 1, 2, 3, 128, 50, 60, 70, 255, 0, 0, 255, 20]), 2, 2);
            const writes = [[NaN, 7], [Infinity, 0], [4294967301, 7], [-4294967291, 7], [1e21, 5], [undefined, 0], [2147483647, 0], [-2147483648, 0], ["3", 4.7], [null, null]];
            const writeOutcomes = writes.map((a) => outcome(() => pixels.writeRect(two, ...a)));
            rec("writeRect argument conversion", writeOutcomes);
            same(pixels, pixels, "after the writes with converted arguments");
            if (readOutcomes[0] !== "TypeError" || readOutcomes[6] !== "RangeError" || writeOutcomes[2] !== "TypeError" || writeOutcomes[8] !== "ok") {
                throw new Error("argument conversion: " + JSON.stringify([readOutcomes, writeOutcomes]));
            }
            return { ok: true };
        })],

        // A draw that is not the last one on a pixels object must not depend on what the objects before it
        // drew: the tile backend's scratches stay on the CPU when a GPU canvas is drawn into them.
        ["draw_into_scratch_stays_on_the_cpu", both(async ({ B, Layer, rec }) => {
            const pairs = new ImageData(256, 256);   // every (value, alpha) pair: a GPU round trip changes 1,350 bytes of them
            for (let a = 0; a < 256; a++) for (let v = 0; v < 256; v++) { const i = (a * 256 + v) * 4; pairs.data[i] = v; pairs.data[i + 1] = 255 - v; pairs.data[i + 2] = v ^ 90; pairs.data[i + 3] = a; }
            const A = Layer.fromImageData(pairs);
            const holder = A.clone();
            const want = A.readRect(0, 0, 256, 256).data.slice();
            const nothing = (what) => {
                A.drawInto([0, 0, 256, 256], () => {});   // the size class every write below uses
                const got = A.readRect(0, 0, 256, 256).data;
                let n = 0;
                for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) n++;
                // the GPU run's canvas reads back a level apart once it moved to software: nothing to prove there
                if (n && B.name !== "canvas") throw new Error(`${what}: a drawInto that draws nothing changed ${n} bytes`);
                if (B.tiles && A.tileAt(0, 0) !== holder.tileAt(0, 0)) throw new Error(`${what}: a drawInto that draws nothing copied a shared tile`);
                rec(what, B.name === "canvas" ? 0 : n);
            };
            const gpuCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = "rgba(0,0,255,0.5)"; g.fillRect(0, 0, w, h); return c; };
            nothing("fresh");
            const S = Layer.empty(256, 256);
            S.drawInto([0, 0, 256, 256], (ctx) => ctx.drawImage(gpuCanvas(200, 90), 0, 0));   // a stroke buffer in the app
            nothing("after a GPU canvas was drawn in a drawInto");
            S.drawInto(null, (ctx) => ctx.drawImage(gpuCanvas(32, 32), 3, 4));
            nothing("after a small GPU canvas");
            const off = new OffscreenCanvas(64, 64); { const g = off.getContext("2d"); g.fillStyle = "#0f0"; g.fillRect(0, 0, 64, 64); }
            S.drawInto(null, (ctx) => ctx.drawImage(off, 10, 10));
            nothing("after a GPU OffscreenCanvas");
            const gl = document.createElement("canvas"); gl.width = 64; gl.height = 64;
            { const c = gl.getContext("webgl2"); if (c) { c.clearColor(1, 0, 1, 0.5); c.clear(c.COLOR_BUFFER_BIT); } }
            S.drawInto(null, (ctx) => ctx.drawImage(gl, 0, 0));
            nothing("after a WebGL canvas");
            const bitmap = await createImageBitmap(gpuCanvas(40, 40));
            S.drawInto(null, (ctx) => ctx.drawImage(bitmap, 0, 0));
            bitmap.close();
            nothing("after an ImageBitmap of a GPU canvas");
            S.writeRect(pairs, 0, 0, "source-over", 0.5);   // the store's own source canvas
            nothing("after a writeRect with an operation");
            S.blit(Layer.fromImageData(pairs), 10.5, 3.25, "source-over", 0.5);   // the store's own blit source
            nothing("after a fractional blit");
            Layer.empty(256, 256).drawInto(null, (ctx) => S.drawTo(ctx, 0, 0));   // the display mirror as a source
            nothing("after drawTo of the pixels in a drawInto");
            Layer.fromImage(gpuCanvas(256, 256));   // a decode strip
            nothing("after fromImage of a GPU canvas");
            if (B.tiles && T.scratchStats().flipped !== 0) throw new Error("a scratch moved to the GPU: " + JSON.stringify(T.scratchStats()));
            return { flipped: B.tiles ? T.scratchStats().flipped : null };
        })],

        // A layer made from a canvas that carries text state (renderText leaves letterSpacing on the
        // canvas a text layer adopts): drawInto hands fn a fresh context's text state on both backends.
        ["draw_into_text_state", both(async ({ Layer, mk, snap, rec }) => {
            const c = mk(420, 130);
            const cc = c.getContext("2d");
            cc.letterSpacing = "12px"; cc.wordSpacing = "20px"; cc.direction = "rtl"; cc.fontKerning = "none";
            cc.textRendering = "optimizeLegibility"; cc.fontStretch = "condensed"; cc.fontVariantCaps = "small-caps";
            const p = Layer.fromCanvas(c);
            let seen = null;
            p.drawInto(null, (ctx) => {
                seen = [ctx.letterSpacing, ctx.wordSpacing, ctx.direction, ctx.fontKerning, ctx.textRendering, ctx.fontStretch, ctx.fontVariantCaps];
                ctx.fillStyle = "#123";
                ctx.font = "32px serif";
                ctx.fillText("AVA To Wa ffi", 200, 50);
                ctx.font = "24px sans-serif";
                ctx.fillText("kerning AV Yo tracking", 30, 105);
            });
            rec("text state in fn", seen);
            snap(p, "text through drawInto on a canvas that carries text state");
            return { seen };
        })],

        // Reads and writes of the pixels a drawInto draws into, from inside its callback: the tile backend
        // would overwrite a nested write with its scratch and read stale pixels, so both backends throw.
        ["draw_into_does_not_reach_its_own_pixels", both(async ({ Layer, mk, pair, snap, rec }) => {
            const { pixels: p } = pair(300, 200);
            const reach = {
                readRect: (q) => q.readRect(0, 0, 1, 1),
                writeRect: (q) => q.writeRect(new ImageData(1, 1), 0, 0),
                "writeRect with an operation": (q) => q.writeRect(new ImageData(1, 1), 0, 0, "source-over", 0.5),
                drawInto: (q) => q.drawInto(null, () => {}),
                drawTo: (q) => q.drawTo(mk(4, 4).getContext("2d"), 0, 0),
                "blit into": (q) => q.blit(Layer.empty(4, 4), 0, 0, "copy"),
                "blit from": (q) => Layer.empty(4, 4).blit(q, 0, 0, "source-over"),
                clear: (q) => q.clear([0, 0, 1, 1]),
                fill: (q) => q.fill([0, 0, 1, 1], "#fff"),
                bounds: (q) => q.bounds(),
                copyRect: (q) => q.copyRect([0, 0, 2, 2]),
                clone: (q) => q.clone(),
                resized: (q) => q.resized(10, 10),
                toCanvas: (q) => q.toCanvas([0, 0, 2, 2]),
                canvasOf: (q) => P.canvasOf(q),
            };
            const out = {};
            let i = 0;
            for (const [name, f] of Object.entries(reach)) {
                let msg = "did not throw";
                try {
                    p.drawInto([10, 10, 290, 190], (ctx) => { ctx.fillStyle = `hsl(${i * 40},80%,50%)`; ctx.fillRect(12 + i * 18, 20, 14, 60); f(p); });
                } catch (err) { msg = err.message; }
                i++;
                if (!/must not read or write the pixels it draws into/.test(msg)) throw new Error(`${name} inside the callback: ${msg}`);
                out[name] = "throws";
            }
            // other pixels are fine inside the callback, and the pixels are usable again afterwards
            const q = Layer.empty(8, 8);
            p.drawInto(null, (ctx) => { q.fill(null, "#f00"); ctx.drawImage(q.toCanvas(), 100, 150); q.readRect(0, 0, 1, 1); });
            rec("reads and writes from the callback", out);
            snap(p, "what the callbacks drew before they threw is kept");
            return out;
        })],

        ["draw_into_callback_is_synchronous", both(async ({ Layer, snap, rec }) => {
            // docs/PLUGINS.md: a callback that returns a promise throws on both backends (the tile backend
            // copies its scratch back when the callback returns; here what it drew after an await would land
            // unclipped), and what it drew before its first await is kept
            const p = Layer.empty(300, 200);
            let msg = "did not throw", after = null;
            try {
                p.drawInto([20, 20, 200, 150], async (ctx) => {
                    ctx.fillStyle = "#3a7"; ctx.fillRect(30, 30, 60, 40);
                    after = await Promise.resolve("resumed");   // nothing drawn after the await
                });
            } catch (err) { msg = err.message; }
            if (!/a drawInto callback must be synchronous/.test(msg)) throw new Error(`an async callback: ${msg}`);
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (after !== "resumed") throw new Error("the async callback did not resume");
            rec("an async callback", "throws");
            // a thenable counts as a promise; a callback's ordinary return value still comes back
            let thenable = "did not throw";
            try { p.drawInto(null, () => ({ then() {} })); } catch (err) { thenable = err.message; }
            if (!/must be synchronous/.test(thenable)) throw new Error(`a thenable: ${thenable}`);
            const back = p.drawInto([0, 0, 300, 200], (ctx) => { ctx.fillStyle = "#c33"; ctx.fillRect(150, 100, 50, 50); return 42; });
            if (back !== 42) throw new Error(`a synchronous callback returned ${back}`);
            rec("a synchronous callback's return value", back);
            // the pixels are usable again after the throw, and the next callback starts clipped as asked
            p.drawInto([100, 0, 120, 200], (ctx) => { ctx.fillStyle = "#00f"; ctx.fillRect(0, 0, 300, 20); });
            snap(p, "before the await kept, the next draws land");
            return { async: "throws", thenable: "throws", back };
        })],

        ["write_rect_ops", both(async ({ mk, same, px, paint, pair }) => {
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
        })],

        ["draw_into", both(async ({ Layer, same, snap, pair }) => {
            const { ref, pixels } = pair(180, 140);
            // state left behind by an earlier draw must not reach fn
            const raw = P.canvasOf(pixels).getContext("2d");   // the backing canvas itself (the tile backend's mirror), in copy mode too
            raw.setTransform(2, 0, 0, 2, 7, 7); raw.globalAlpha = 0.1; raw.globalCompositeOperation = "xor";
            const rect = [30.4, 20.6, 110.2, 90.9];
            const back = pixels.drawInto(rect, (ctx) => {
                if (ctx.globalAlpha !== 1 || ctx.globalCompositeOperation !== "source-over") throw new Error("context not reset");
                // the transform is not read: it maps the pixels' own coordinates, which is the identity
                // here and a translation on a tile scratch (rule 12); where the pixels land is checked
                // below and in draw_into_transform_composes
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
            same(pixels, ref, "drawInto clipped", 0);
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
            // a callback that throws keeps what it drew before the throw, in both backends
            const { pixels: p4 } = pair(120, 90);
            try { p4.drawInto([0, 0, 60, 60], (c) => { c.fillStyle = "#f0f"; c.fillRect(5, 5, 20, 20); throw new Error("boom"); }); } catch (err) { if (err.message !== "boom") throw err; }
            snap(p4, "drawInto keeps what a throwing fn drew");
            return { ok: true };
        })],

        // docs/PLAN_BCE.md §C1 rule 12: fn gets a transform that maps the pixels' own coordinates and
        // composes on it. Checked by where pixels land, never by reading the matrix, so the case holds
        // for a tile scratch translated by the rect's origin as well as for the canvas backend.
        ["draw_into_transform_composes", both(async ({ Layer, mk, same, px, paint, pair }) => {
            const alphaAt = (p, x, y) => px(p, x, y)[3];
            const leftover = (p) => { const raw = P.canvasOf(p).getContext("2d"); raw.setTransform(2, 0, 0, 2, 7, 7); };
            const rect = [40, 30, 70, 60];
            // a point drawn at the rect's own coordinates lands there, whatever an earlier draw left
            const a = Layer.empty(120, 90);
            leftover(a);
            a.drawInto(rect, (ctx) => { ctx.fillStyle = "#ffffff"; ctx.fillRect(47, 33, 1, 1); });
            P.canvasOf(a).getContext("2d").setTransform(1, 0, 0, 1, 0, 0);
            if (alphaAt(a, 47, 33) !== 255) throw new Error("the point is not at 47,33: " + px(a, 47, 33));
            for (const [x, y] of [[46, 33], [48, 33], [47, 32], [47, 34]]) if (alphaAt(a, x, y)) throw new Error(`the point spilled to ${x},${y}`);
            const ba = a.bounds();
            if (!ba || ba.join() !== "47,33,48,34") throw new Error("point bounds " + ba);
            // a scale and a translation composed inside fn, and restore taking them off again
            const b = Layer.empty(120, 90);
            leftover(b);
            b.drawInto(rect, (ctx) => {
                ctx.fillStyle = "#ffffff";
                ctx.save();
                ctx.scale(2, 2);
                ctx.fillRect(24, 16, 1, 1);          // 48..50 x 32..34
                ctx.translate(5, 10);
                ctx.fillRect(25, 17, 1, 1);          // (25 + 5) * 2 = 60..62 x (17 + 10) * 2 = 54..56
                ctx.restore();
                ctx.fillRect(42, 58, 1, 1);          // back to the pixels' own coordinates
            });
            P.canvasOf(b).getContext("2d").setTransform(1, 0, 0, 1, 0, 0);
            const rb = mk(120, 90), rc = rb.getContext("2d");
            rc.fillStyle = "#ffffff";
            rc.fillRect(48, 32, 2, 2); rc.fillRect(60, 54, 2, 2); rc.fillRect(42, 58, 1, 1);
            same(b, rb, "drawInto with a composed scale and translation");
            // the call sites' pattern (bucketFill, fillSelection): a soft source drawn scaled at an alpha
            const { ref, pixels } = pair(160, 120);
            leftover(pixels);
            const src = mk(50, 40); paint(src.getContext("2d"), 50, 40);
            pixels.drawInto([10, 10, 140, 110], (ctx) => { ctx.globalAlpha = 0.6; ctx.scale(1.5, 1.25); ctx.drawImage(src, 12, 9); });
            P.canvasOf(pixels).getContext("2d").setTransform(1, 0, 0, 1, 0, 0);
            const g = ref.getContext("2d");
            g.save(); const q = new Path2D(); q.rect(10, 10, 130, 100); g.clip(q);
            g.globalAlpha = 0.6; g.setTransform(1.5, 0, 0, 1.25, 0, 0); g.drawImage(src, 12, 9); g.restore();
            same(pixels, ref, "drawInto with a scaled draw at an alpha");
            return { ok: true };
        })],

        ["draw_to", both(async ({ mk, same, pair }) => {
            const { pixels } = pair(120, 80);
            const a = mk(60, 40), b = mk(60, 40);
            pixels.drawTo(a.getContext("2d"), 10, 5, 100, 70, 0, 0, 60, 40);
            b.getContext("2d").drawImage(P.canvasOf(pixels), 10, 5, 100, 70, 0, 0, 60, 40);
            same(a, b, "drawTo 9 args");
            const e = mk(120, 80), f = mk(120, 80);
            pixels.drawTo(e.getContext("2d"), 3, 4);
            f.getContext("2d").drawImage(P.canvasOf(pixels), 3, 4);
            same(e, f, "drawTo 3 args");
            const g = mk(200, 150), h = mk(200, 150);
            pixels.drawTo(g.getContext("2d"), 7.5, 3.25, 170, 111);
            h.getContext("2d").drawImage(P.canvasOf(pixels), 7.5, 3.25, 170, 111);
            same(g, h, "drawTo 5 args");
            return { ok: true };
        })],

        ["blit_and_copy_rect", both(async ({ mk, same, pair }) => {
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
        })],

        ["clear_fill_bounds", both(async ({ B, Layer, same, pair, rec }) => {
            const { ref, pixels } = pair(100, 80);
            pixels.clear([10, 10, 30.5, 20]);
            ref.getContext("2d").clearRect(10, 10, 21, 10);
            same(pixels, ref, "clear");
            pixels.fill([50, 40, 70, 60], "rgba(255,0,0,0.5)");
            const rc = ref.getContext("2d"); rc.clearRect(50, 40, 20, 20); rc.fillStyle = "rgba(255,0,0,0.5)"; rc.fillRect(50, 40, 20, 20);
            same(pixels, ref, "fill");
            pixels.fill([0, 0, 30, 30], "not a colour");   // ignored by the canvas: the reset fill style, black
            rc.clearRect(0, 0, 30, 30); rc.fillStyle = "#000000"; rc.fillRect(0, 0, 30, 30);
            same(pixels, ref, "fill with an invalid colour");
            const grad = ref.getContext("2d").createLinearGradient(0, 0, 100, 0);
            grad.addColorStop(0, "rgba(0,0,255,0.2)"); grad.addColorStop(1, "#ff0");
            pixels.fill([60, 0, 100, 30], grad);
            rc.clearRect(60, 0, 40, 30); rc.fillStyle = grad; rc.fillRect(60, 0, 40, 30);
            same(pixels, ref, "fill with a gradient", B.tiles ? TOLERANCES.clear_fill_bounds["fill with a gradient"].levels : 0);   // see TOLERANCES
            const e = Layer.empty(700, 1100);
            if (e.bounds() !== null) throw new Error("empty bounds");
            e.fill([613, 530, 614, 531], "#fff");
            e.fill([20, 1090, 22, 1093], "rgba(0,0,0,0.01)");
            const b = e.bounds();
            if (!b || b.join() !== "20,530,614,1093") throw new Error("bounds " + b);
            rec("bounds", b);
            return { bounds: b };
        }, TOLERANCES.clear_fill_bounds)],

        ["clone_resized_to_canvas", both(async ({ B, mk, same, px, pair }) => {
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
            // share mode hands out the canvas, copy mode a copy with the same pixels; the tile backend
            // always hands out a new canvas
            const was = P.pixelsOptions().copy;
            try {
                P.setPixelsOptions({ copy: false });
                if (B.tiles ? pixels.toCanvas() === pixels.toCanvas() : pixels.toCanvas() !== pixels.toCanvas()) throw new Error("share mode");
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
            same(part, pixels.copyRect([10, 10, 30, 25]), "toCanvas(rect)");
            return { ok: true };
        })],

        ["version_and_canvas_of", both(async ({ B, Layer, mk }) => {
            const e = Layer.empty(10, 10);
            const v0 = e.version;
            e.touch(); e.touch([0, 0, 2, 2]);
            if (e.version !== v0 + 2) throw new Error("version " + e.version);
            const c = mk(4, 4);
            if (P.canvasOf(c) !== c) throw new Error("canvasOf of a canvas");
            const fc = P.canvasOf(Layer.fromCanvas(c));
            if (B.tiles ? (fc === c || !(fc instanceof HTMLCanvasElement)) : fc !== c) throw new Error("canvasOf of pixels");
            // the display pyramid keys on the canvas's _dispVer: the facade's version is the same number
            if (!B.tiles) {
                P.canvasOf(e)._dispVer = 77;
                if (e.version !== 77) throw new Error("version is not the canvas's _dispVer");
            } else {
                // on tiles a plain value that touch() sets, never an accessor: a closure over the pixels would
                // keep them and every tile alive for as long as anything holds the mirror (C2 step b's review)
                const d = Object.getOwnPropertyDescriptor(P.canvasOf(e), "_dispVer");
                if (!d || !("value" in d) || d.get || d.set || d.value !== e.version) throw new Error("the mirror's _dispVer is not a plain value: " + JSON.stringify(d && { value: d.value, get: !!d.get }));
                e.touch(); e.touch();
            }
            e.touch();
            if (P.canvasOf(e)._dispVer !== e.version) throw new Error("_dispVer does not follow touch()");
            return { ok: true };
        })],

        ["layer_aliases", both(async ({ B, Layer, Mask, mk }) => {
            const was = P.pixelsOptions().strict;
            const warnings = [];
            const orig = console.warn;
            try {
                console.warn = (...a) => { warnings.push(a.join(" ")); };
                P.setPixelsOptions({ strict: false });
                const c = mk(8, 8), m = mk(8, 8);
                const L = P.installLayerAliases({ id: "x", canvas: c, mask: m, x: 1 });
                if (!(L.px instanceof P.LayerPixels) || !(L.maskPx instanceof P.MaskPixels)) throw new Error("own canvas / mask not converted");
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
                // a layer on this backend: the getter hands out a canvas of its pixels, the setters adopt
                // into the layer's backend (a mask set on a layer without one follows its px)
                const K = P.installLayerAliases({ id: "z", px: Layer.fromCanvas(mk(6, 5)), maskPx: null });
                const kc = K.canvas;
                if (!(kc instanceof HTMLCanvasElement) || kc.width !== 6 || (B.tiles && kc === K.canvas)) throw new Error("the getter on " + B.name);
                K.canvas = mk(7, 3);
                K.mask = mk(7, 3);
                if (!(K.px instanceof Layer) || K.px.width !== 7 || !(K.maskPx instanceof Mask)) throw new Error("the setters did not adopt into " + B.name);
                // a warning is given once per name for the page's life, so only the first run of the case sees it
                if (warnings.length) window.__pixelsAliasesWarned = true;
                if (!window.__pixelsAliasesWarned) throw new Error("no deprecation warning");
                P.setPixelsOptions({ strict: true });
                let threw = 0;
                try { void L.canvas; } catch (_) { threw++; }
                try { L.canvas = mk(2, 2); } catch (_) { threw++; }
                try { P.installLayerAliases({ canvas: mk(2, 2) }); } catch (_) { threw++; }
                try { void K.mask; } catch (_) { threw++; }
                P.installLayerAliases({ canvas: null });   // a null value is not a use of the old name
                if (threw !== 4) throw new Error("strict mode threw " + threw + " of 4 times");
            } finally {
                console.warn = orig;
                P.setPixelsOptions({ strict: was });
            }
            return { warnings: warnings.length };
        })],

        // ---- C2: the tile store's own cases, run on every backend like the ones above ----------------

        ["tiles_sparse_growth_and_shrink", both(async ({ Layer, snap, tiles, rec }) => {
            const p = Layer.empty(1000, 700);
            tiles(p, 0, "empty");
            p.fill([250, 250, 262, 258], "rgba(10,20,30,0.5)");                // across four tiles
            tiles(p, 4, "a fill across a tile corner");
            snap(p, "fill across a corner");
            p.writeRect(new ImageData(300, 300), 600, 300);                     // transparent "copy" onto missing tiles
            tiles(p, 4, "a transparent copy allocates nothing");
            p.drawInto([600, 300, 900, 600], (ctx) => { ctx.globalAlpha = 0; ctx.fillRect(600, 300, 300, 300); });
            tiles(p, 4, "an invisible draw allocates nothing");
            p.drawInto([700, 400, 800, 500], (ctx) => { ctx.fillStyle = "#fff"; ctx.fillRect(700, 400, 100, 100); });
            tiles(p, 6, "a draw over two tiles");
            snap(p, "draw over two tiles");
            p.drawInto([690, 390, 810, 510], (ctx) => { ctx.globalCompositeOperation = "destination-out"; ctx.fillStyle = "#000"; ctx.fillRect(690, 390, 120, 120); });
            tiles(p, 4, "destination-out that empties two tiles drops them");
            snap(p, "erased");
            const img = new ImageData(8, 8);
            for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
            p.writeRect(img, 252, 252, "destination-out", 1);                  // erases part of all four
            tiles(p, 4, "a partial erase keeps the tiles");
            snap(p, "partial erase");
            rec("bounds after the partial erase", p.bounds());
            p.clear([240, 240, 256, 256]);
            tiles(p, 3, "clear of the rest of one tile drops it");
            p.blit(Layer.empty(30, 30), 250, 250, "copy");                      // a transparent copy over the rest
            tiles(p, 0, "a transparent blit copy drops what it empties");
            if (p.bounds() !== null) throw new Error("bounds after everything was erased: " + p.bounds());
            p.fill(null, "#123456");
            tiles(p, 12, "a fill of everything");
            snap(p, "filled");
            p.writeRect(new ImageData(1000, 700), 0, 0);
            tiles(p, 0, "a transparent copy of everything");
            p.fill(null, "rgba(1,2,3,0.5)");
            p.clear(null);
            tiles(p, 0, "clear of everything");
            snap(p, "cleared");
            return { tiles: p.tileCount };
        })],

        ["tiles_clone_copy_on_write", both(async ({ B, pair, snap, same, rec }) => {
            const { pixels: base } = pair(800, 600);
            const orig = base.clone();
            const c1 = base.clone(), c2 = base.clone(), c3 = base.clone();
            const t = B.tiles ? base.tileAt(1, 1) : null;
            const expect = (cond, what) => { if (B.tiles && !cond()) throw new Error(typeof what === "function" ? what() : what); };
            expect(() => t && t.frozen === 4 && c1.tileAt(1, 1) === t && orig.tileAt(1, 1) === t, () => "four clones share the tile: frozen " + (t && t.frozen));
            c1.fill([300, 300, 310, 310], "#f00");
            const own1 = B.tiles ? c1.tileAt(1, 1) : null;
            expect(() => own1 !== t && t.frozen === 3 && base.tileAt(1, 1) === t, () => "the first writer copies: frozen " + (t && t.frozen));
            c1.fill([320, 300, 330, 310], "#0f0");
            expect(() => c1.tileAt(1, 1) === own1 && t.frozen === 3, () => "a second write by the same writer does not copy again");
            c2.drawInto([290, 290, 400, 400], (ctx) => { ctx.fillStyle = "rgba(0,0,255,0.5)"; ctx.fillRect(290, 290, 110, 110); });
            expect(() => c2.tileAt(1, 1) !== t && t.frozen === 2, () => "the second writer copies: frozen " + (t && t.frozen));
            c3.clear([256, 256, 300, 300]);
            expect(() => c3.tileAt(1, 1) !== t && t.frozen === 1, () => "the third writer copies: frozen " + (t && t.frozen));
            // untouched tiles stay shared by all five
            expect(() => c1.tileAt(0, 0) === base.tileAt(0, 0) && base.tileAt(0, 0).frozen === 4, () => "untouched tiles stay shared");
            same(base, orig, "the original is untouched by the clones' writes");
            orig.fill([0, 0, 1, 1], "#fff");   // the snapshot lets go of the tile (0, 0) by copying it
            expect(() => t.frozen === 1, () => "orig still holds (1, 1)");
            const img = new ImageData(20, 20);
            for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 9; img.data[i + 3] = 200; }
            const before = B.tiles ? base.tileAt(1, 1) : null;
            base.writeRect(img, 260, 260);
            expect(() => base.tileAt(1, 1) !== before && before.frozen === 0, () => "base copies while orig holds the tile");
            orig.writeRect(img, 270, 270);
            expect(() => orig.tileAt(1, 1) === t && t.frozen === 0, () => "the last holder writes in place");
            for (const [p, name] of [[base, "base"], [c1, "c1"], [c2, "c2"], [c3, "c3"], [orig, "orig"]]) snap(p, name);
            return { tileCounts: B.tiles ? [base, c1, c2, c3, orig].map((p) => p.tileCount) : null };
        })],

        ["tiles_borders", both(async ({ Layer, pair, snap, rec }) => {
            const { pixels: p } = pair(700, 600);
            const img = new ImageData(10, 9);
            for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 250; img.data[i + 1] = i & 255; img.data[i + 2] = 7; img.data[i + 3] = (i * 3) & 255; }
            for (const [x, y] of [[255, 255], [256, 256], [257, 257], [-3, -2], [695, 597], [250, -5], [251, 511]]) {
                p.writeRect(img, x, y);
                snap(p, `writeRect at ${x},${y}`);
            }
            for (const [x, y, w, h] of [[250, 250, 12, 12], [-5, -5, 10, 10], [690, 590, 20, 20], [255, 0, 2, 600], [0, 255, 700, 3], [256, 256, 256, 256], [-300, -300, 1400, 1300]]) {
                rec(`readRect ${x},${y},${w},${h}`, p.readRect(x, y, w, h).data);
            }
            const fills = (color) => (ctx) => { ctx.fillStyle = color; ctx.fillRect(0, 0, 2000, 2000); };
            for (const [r, color] of [[[250, 250, 262, 262], "rgba(0,255,0,0.4)"], [[-10, 250, 5, 262], "#00f"], [[690, 590, 710, 610], "#f0f"], [[255.5, 100, 256.5, 400], "#ff0"]]) {
                p.drawInto(r, fills(color));
                snap(p, `drawInto ${r}`);
            }
            const part = p.copyRect([200, 200, 300, 300]);
            p.blit(part, 254, 510, "copy");
            snap(p, "blit copy across a border");
            p.blit(part, -40, 250, "copy", 1, [30, 30, 90, 90]);
            snap(p, "blit copy from a negative position");
            p.writeRect(img, -4, 253, "source-atop", 0.5);
            snap(p, "writeRect with an operation at a negative position");
            const e = Layer.empty(600, 600);
            e.fill([255, 255, 257, 257], "#fff");
            rec("bounds of a 2 px square on a tile corner", e.bounds());
            return { ok: true };
        })],

        ["tiles_bounds", both(async ({ B, Layer, rec }) => {
            const out = [];
            for (const points of [[[255, 255]], [[256, 256]], [[0, 0], [999, 799]], [[255, 0], [256, 799]], [[511, 300], [512, 301], [767, 302]], [[300, 300]], [[1, 798], [998, 1]]]) {
                const e = Layer.empty(1000, 800);
                for (const [x, y] of points) e.fill([x, y, x + 1, y + 1], "rgba(0,0,0,0.004)");   // alpha 1
                const b = e.bounds();
                rec(`bounds ${JSON.stringify(points)}`, b);
                out.push(b);
                // erase the first point: the bounds follow (a tile left empty is dropped)
                e.clear([points[0][0], points[0][1], points[0][0] + 1, points[0][1] + 1]);
                rec(`bounds without ${points[0]}`, e.bounds());
            }
            // why bounds() does not read the mips: the kernel's alpha is a rounded average, so a
            // pixel of alpha 1 is gone from the first mip on (and alpha < 4 from the second)
            if (B.tiles) {
                const e = Layer.empty(300, 300);
                e.fill([300 - 45, 20, 256, 21], "rgba(0,0,0,0.004)");   // alpha 1 at 255,20: tile (0, 0)
                e.fill([10, 10, 11, 11], "rgba(0,0,0,0.004)");
                const m = e.mips(0, 0);
                let alpha = 0;
                for (let i = 3; i < 128 * 128 * 4; i += 4) alpha += m[i];
                if (alpha !== 0) throw new Error("the first mip kept an alpha-1 pixel: " + alpha);
                if (e.bounds().join() !== "10,10,256,21") throw new Error("bounds " + e.bounds());
            }
            return { bounds: out };
        })],

        ["tiles_resized_offsets", both(async ({ B, Layer, pair, snap }) => {
            const { pixels: p } = pair(700, 600);
            for (const [w, h, x, y] of [[900, 650, -300, 130], [1000, 1000, 256, -512], [700, 600, 37, 0], [512, 512, -256, -256], [300, 200, -400, -390], [1200, 900, 500, 300], [700, 600, 0, 0], [800, 600, 256, 0]]) {
                const r = p.resized(w, h, { x, y });
                if (!(r instanceof Layer) || r.width !== w || r.height !== h) throw new Error("resized class or size");
                snap(r, `resized ${w}x${h} at ${x},${y}`);
            }
            if (B.tiles) {
                const r = p.resized(800, 600, { x: 256, y: 0 });
                if (r.tileAt(1, 0) !== p.tileAt(0, 0) || r.tileAt(1, 0).frozen < 1) throw new Error("an aligned offset does not share whole tiles");
                if (r.tileAt(3, 2) === p.tileAt(2, 2)) throw new Error("an edge tile of another width was shared");
            }
            // no call site passes a fractional offset (extend and crop round theirs); the result is the canvas backend's
            snap(p.resized(710, 610, { x: 0.5, y: 3.25 }), "resized at a fractional offset");
            return { ok: true };
        })],

        ["tiles_from_image", both(async ({ Layer, mk, paint, snap }) => {
            const src = mk(700, 450); paint(src.getContext("2d"), 700, 450);
            const bitmap = await createImageBitmap(src);
            const blob = await new Promise((res) => src.toBlob(res, "image/png"));
            const img = new Image();
            // onload, not decode(): decode() waits for rendering, which a hidden window never does
            await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = URL.createObjectURL(blob); });
            try {
                snap(Layer.fromImage(src), "fromImage canvas unscaled");
                snap(Layer.fromImage(src, 1537, 1011), "fromImage canvas scaled up");
                snap(Layer.fromImage(bitmap, 900, 300), "fromImage bitmap scaled");
                snap(Layer.fromImage(img), "fromImage img unscaled");
                snap(Layer.fromImage(img, 333, 777), "fromImage img scaled down");
                snap(Layer.fromImage(src, 5000, 300), "fromImage canvas across a strip border (4096)");
                snap(Layer.fromImage(img, 5000, 300), "fromImage img across a strip border (4096)");
                snap(Layer.fromImage(img, 900, 5000), "fromImage img across a strip border (rows)");
                snap(Layer.fromCanvas(src), "fromCanvas");
                const d = new ImageData(300, 256);
                for (let i = 0; i < d.data.length; i += 4) { d.data[i] = (i * 7) & 255; d.data[i + 1] = (i >> 3) & 255; d.data[i + 2] = 255 - ((i >> 5) & 255); d.data[i + 3] = (i >> 2) & 255; }
                snap(Layer.fromImageData(d), "fromImageData with every alpha");
            } finally {
                URL.revokeObjectURL(img.src);
                bitmap.close();
            }
            return { ok: true };
        }, TOLERANCES.from_image)],

        ["tiles_to_canvas_and_limits", both(async ({ B, Layer, pair, same, snap }) => {
            const { pixels: p } = pair(700, 600);
            for (const r of [[0, 0, 700, 600], [255, 255, 257, 257], [-20, 100, 300.5, 700], [650, 10, 900, 20]]) {
                const c = p.toCanvas(r);
                same(c, p.copyRect(r), `toCanvas ${r}`);
            }
            snap(p.toCanvas(), "toCanvas()");
            const none = p.toCanvas([800, 0, 900, 10]);
            if (none.width !== 1 || none.height !== 1) throw new Error("toCanvas of a rect outside");
            if (!B.tiles) return { ok: true };
            // above Chromium's canvas limit: refused without allocating a tile
            const huge = Layer.empty(20000, 15000);
            let msg = "";
            try { huge.toCanvas(); } catch (err) { msg = err.message; }
            if (!/268 MP/.test(msg) || huge.tileCount !== 0) throw new Error("toCanvas above 268 MP: " + (msg || "not refused"));
            msg = "";
            try { huge.drawInto(null, () => {}); } catch (err) { msg = err.message; }
            if (!/268 MP/.test(msg) || huge.tileCount !== 0) throw new Error("drawInto above 268 MP: " + (msg || "not refused"));
            huge.fill([19990, 14990, 20000, 15000], "#fff");
            if (huge.tileCount !== 1 || huge.bounds().join() !== "19990,14990,20000,15000") throw new Error("sparse huge pixels");
            // the side limit: 16,777,216 px (65,536 tiles, the key's 16 bits)
            msg = "";
            try { Layer.empty(16777217, 10); } catch (err) { msg = err.message; }
            if (!/16,777,216/.test(msg)) throw new Error("side limit: " + (msg || "not refused"));
            // a blit from pixels above 268 MP works: its source is the rectangle with a margin, never a whole-layer canvas
            const into = Layer.empty(40, 40);
            into.blit(huge, 10.5, 10.25, "source-over", 0.5, [19990, 14990, 20000, 15000]);
            into.blit(huge, 20, 20, "source-over", 1, [19990, 14990, 20000, 15000]);
            if (into.readRect(25, 25, 1, 1).data[3] !== 255 || into.readRect(15, 15, 1, 1).data[3] === 0) throw new Error("a blit from pixels above 268 MP");
            const wide = Layer.empty(16777216, 300);
            wide.fill([16777206, 10, 16777226, 30], "#abc");
            const back = wide.readRect(16777200, 5, 30, 30).data;
            if (wide.tileCount !== 1 || wide.bounds().join() !== "16777206,10,16777216,30" || back[(5 * 30 + 6) * 4 + 3] !== 255 || back[(5 * 30 + 5) * 4 + 3] !== 0) throw new Error("the last tile column: " + wide.bounds());
            return { ok: true, refused: msg };
        })],

        ["tiles_display_mirror", both(async ({ B, pair, same }) => {
            const { pixels: p } = pair(700, 600);
            const m = P.canvasOf(p);
            // the canvas backend's mirror is its canvas: in the GPU run its first read-back un-premultiplies 1 level apart
            same(m, p, "the mirror holds the pixels", B.name === "canvas" ? 1 : 0);
            p.fill([100, 100, 300, 300], "#0f0");             // written, not touched
            if (P.canvasOf(p) !== m) throw new Error("the mirror's identity changed");
            same(P.canvasOf(p), p, "a write without touch reaches the mirror on the next canvasOf");
            const v = p.version;
            const t00 = B.tiles ? p.tileAt(0, 0).version : 0, t22 = B.tiles ? p.tileAt(2, 2).version : 0;
            p.touch([0, 0, 10, 10]);
            if (p.version !== v + 1 || m._dispVer !== p.version) throw new Error("_dispVer does not follow version");
            // C6 b: a touch leaves the tiles' versions alone (every write already gave a tile a new version or a new object)
            if (B.tiles && (p.tileAt(0, 0).version !== t00 || p.tileAt(2, 2).version !== t22)) throw new Error("touch() gave a tile a new version");
            p.clear([0, 0, 700, 300]);
            same(P.canvasOf(p), p, "a clear that drops tiles reaches the mirror");
            p.drawInto([200, 250, 600, 500], (ctx) => { ctx.globalCompositeOperation = "destination-out"; ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(0, 0, 700, 600); });
            p.blit(p.copyRect([0, 300, 300, 600]), 400, 0, "copy");
            same(P.canvasOf(p), p, "drawInto and blit reach the mirror");
            const raw = m.getContext("2d");
            raw.setTransform(3, 0, 0, 3, 50, 50); raw.globalCompositeOperation = "xor"; raw.globalAlpha = 0.2;
            p.fill([0, 0, 700, 20], "#f00");
            same(P.canvasOf(p), p, "state left on the mirror's context does not bend the sync");
            raw.setTransform(1, 0, 0, 1, 0, 0); raw.globalCompositeOperation = "source-over"; raw.globalAlpha = 1;
            return { ok: true };
        })],

        // C2 step (b): what the editor's display machinery asks besides canvasOf. displayRectSource hands out a
        // canvas with the rectangle's pixels where it says they are (the canvas itself on the canvas backend,
        // the rectangle alone on tiles, the mirror above 4 MP); displayCanvasIfMade never makes a mirror;
        // releaseDisplay gives the mirror back and the next canvasOf makes a new one that holds the pixels.
        ["display_rect_source_and_release", both(async ({ B, pair, same, rec }) => {
            const { pixels: p } = pair(3000, 2000);
            const lazy = p.displayCanvasIfMade();
            if (B.tiles ? lazy !== null : lazy !== P.canvasOf(p)) throw new Error("displayCanvasIfMade made or missed the display canvas");
            p.fill([100, 100, 900, 700], "#0f0");
            const m = P.canvasOf(p);
            const x0 = 250, y0 = 300, w = 1000, h = 800;
            const part = p.displayRectSource([x0, y0, x0 + w, y0 + h]);
            const got = part.canvas.getContext("2d").getImageData(x0 - part.x, y0 - part.y, w, h).data;
            const want = p.readRect(x0, y0, w, h).data;
            rec("the rectangle from displayRectSource", got);
            // the GPU run's canvas: two read-backs of it un-premultiply 1 level apart at low alpha (as for the mirror above)
            const tol = B.name === "canvas" ? 1 : 0;
            let n = 0;
            for (let i = 0; i < got.length; i++) if (Math.abs(got[i] - want[i]) > tol) n++;
            if (n) throw new Error(`displayRectSource: ${n} bytes differ from readRect`);
            if (!B.tiles && (part.canvas !== m || part.x || part.y || part.temp)) throw new Error("the canvas backend hands out its own canvas at (0, 0)");
            if (B.tiles && (part.canvas === m || !part.temp || part.x !== x0 || part.y !== y0 || part.canvas.width !== w || part.canvas.height !== h)) throw new Error("the tile store hands out the rectangle alone");
            if (part.temp) { part.canvas.width = 1; part.canvas.height = 1; }
            const big = p.displayRectSource([0, 0, 3000, 2000]);
            if (big.canvas !== m || big.temp || big.x || big.y) throw new Error("above 4 MP the display canvas is the source");
            const freed = p.releaseDisplay();
            if (!B.tiles && (freed !== 0 || p.displayCanvasIfMade() !== m)) throw new Error("the canvas backend has nothing to release");
            if (B.tiles && (freed !== 3000 * 2000 * 4 || p.displayCanvasIfMade() !== null || m.width !== 1)) throw new Error("the tile store did not give its mirror back: " + freed);
            p.fill([0, 0, 50, 50], "#f00");                   // a write while there is no mirror
            const m2 = P.canvasOf(p);
            if (B.tiles && (m2 === m || m2._dispVer !== p.version)) throw new Error("the new mirror is not a new canvas that follows version");
            same(m2, p, "the display canvas after a release holds the pixels", B.name === "canvas" ? 1 : 0);
            return { ok: true, freed };
        })],

        // C2 step (b)'s review: the tile store's thumbnail canvas, which the editor's thumbnails draw instead of
        // the mirror. Each tile's mips at the level whose long side stays at least 256 px, synced from the writes
        // since the last call (a fill, a clear that drops tiles), never making the mirror, given back by releaseDisplay.
        ["tiles_thumbnail_canvas", both(async ({ B, Layer, pair }) => {
            if (!B.tiles) return { ok: true, tilesOnly: true };
            const { pixels: p } = pair(3000, 2000);
            const th = p.thumbnailCanvas();
            if (p.displayCanvasIfMade() !== null) throw new Error("the thumbnail made the display mirror");
            if (th.width !== 375 || th.height !== 250 || p.thumbnailCanvasIfMade() !== th) throw new Error("level 3 expected: " + th.width + " x " + th.height);
            const at = 128 * 128 * 4 + 64 * 64 * 4;   // the offset of the 32 px mip in a tile's mip chain
            const compare = (what) => {
                let n = 0, tilesSeen = 0;
                const got = th.getContext("2d").getImageData(0, 0, th.width, th.height).data;
                for (let ty = 0; ty * 256 < p.height; ty++) {
                    for (let tx = 0; tx * 256 < p.width; tx++) {
                        const m = p.mips(tx, ty);
                        tilesSeen += m ? 1 : 0;
                        for (let y = 0; y < 32 && ty * 32 + y < th.height; y++) {
                            for (let x = 0; x < 32 && tx * 32 + x < th.width; x++) {
                                const o = ((ty * 32 + y) * th.width + tx * 32 + x) * 4, i = at + (y * 32 + x) * 4;
                                const a = m ? m[i + 3] : 0;
                                // the canvas's straight-alpha round trip moves colours where alpha is low: colours checked from alpha 128 on
                                if (got[o + 3] !== a || (a >= 128 && (Math.abs(got[o] - m[i]) > 1 || Math.abs(got[o + 1] - m[i + 1]) > 1 || Math.abs(got[o + 2] - m[i + 2]) > 1))) n++;
                            }
                        }
                    }
                }
                if (n) throw new Error(`${what}: ${n} thumbnail pixels are not the tiles' mips`);
                return tilesSeen;
            };
            const tilesBefore = compare("made");
            p.fill([0, 0, 600, 600], "#00ff00");
            if (p.thumbnailCanvas() !== th) throw new Error("the thumbnail canvas's identity changed");
            compare("after a fill");
            p.clear([0, 0, 3000, 1000]);
            if (p.thumbnailCanvas() !== th) throw new Error("the thumbnail canvas's identity changed after a clear");
            compare("after a clear that dropped tiles");
            if (p.displayCanvasIfMade() !== null) throw new Error("a sync made the display mirror");
            const small = Layer.empty(300, 200);
            small.fill([10, 10, 50, 50], "#f00");
            const st = small.thumbnailCanvas();
            if (st.width !== 300 || st.height !== 200 || st.getContext("2d").getImageData(20, 20, 1, 1).data[3] !== 255) throw new Error("a small layer's thumbnail is its own size");
            const freed = p.releaseDisplay();
            if (freed !== 375 * 250 * 4 || p.thumbnailCanvasIfMade() !== null || th.width !== 1) throw new Error("releaseDisplay kept the thumbnail: " + freed);
            return { ok: true, tilesBefore };
        })],

        // The slots the compositor's atlas uploads (C3 step a): a tile at a level with its one-pixel
        // gutter, premultiplied. Checked against an independent reconstruction from readRect: the
        // tile's straight bytes, clamp-extended past the image's own edge, halved alpha-weighted per
        // level, premultiplied with Skia's rounding, and the gutter taken from the neighbour the rule
        // names (a missing tile transparent, the image's edge the tile's own edge line repeated).
        ["tiles_atlas_slots", both(async ({ B, Layer, pair }) => {
            if (!B.tiles) return { ok: true, tilesOnly: true };
            const TS = 256, LEVELS = 5;
            const W = 601, H = 501;   // 3 x 2 tiles; the last column is 89 px wide and the last row 245: odd,
            const { pixels: p } = pair(W, H);   // so a mip of the valid part alone would fade the image's edge
            p.clear([256, 0, 512, 256]);        // tile (1, 0) is dropped: a missing neighbour
            const pm = (c, a) => { const x = c * a + 128; return (x + (x >> 8)) >> 8; };
            const half = (src, size) => {
                const n = size >> 1, out = new Uint8ClampedArray(n * n * 4);
                for (let y = 0; y < n; y++) {
                    for (let x = 0; x < n; x++) {
                        const i0 = (2 * y * size + 2 * x) * 4, i1 = i0 + 4, i2 = i0 + size * 4, i3 = i2 + 4;
                        const a0 = src[i0 + 3], a1 = src[i1 + 3], a2 = src[i2 + 3], a3 = src[i3 + 3];
                        const a = a0 + a1 + a2 + a3, o = (y * n + x) * 4;
                        if (a === 1020) {
                            for (let c = 0; c < 3; c++) out[o + c] = (src[i0 + c] + src[i1 + c] + src[i2 + c] + src[i3 + c] + 2) >> 2;
                            out[o + 3] = 255;
                        } else if (a) {
                            const h = a >> 1;
                            for (let c = 0; c < 3; c++) out[o + c] = ((src[i0 + c] * a0 + src[i1 + c] * a1 + src[i2 + c] * a2 + src[i3 + c] * a3 + h) / a) | 0;
                            out[o + 3] = (a + 2) >> 2;
                        }
                    }
                }
                return out;
            };
            const CACHE = new Map();
            const levelsOf = (tx, ty) => {
                const key = tx + "," + ty;
                if (CACHE.has(key)) return CACHE.get(key);
                let out = null;
                if (tx >= 0 && ty >= 0 && tx * TS < W && ty * TS < H && p.tileAt(tx, ty)) {
                    const ox = tx * TS, oy = ty * TS;
                    const vw = Math.min(TS, W - ox), vh = Math.min(TS, H - oy);
                    const d = new Uint8ClampedArray(TS * TS * 4);
                    const got = p.readRect(ox, oy, vw, vh).data;
                    for (let y = 0; y < vh; y++) {
                        for (let x = 0; x < vw; x++) {
                            const i = (y * vw + x) * 4, o = (y * TS + x) * 4;
                            d[o] = got[i]; d[o + 1] = got[i + 1]; d[o + 2] = got[i + 2]; d[o + 3] = got[i + 3];
                        }
                    }
                    for (let y = 0; y < vh; y++) {
                        const e = (y * TS + vw - 1) * 4;
                        for (let x = vw; x < TS; x++) {
                            const o = (y * TS + x) * 4;
                            d[o] = d[e]; d[o + 1] = d[e + 1]; d[o + 2] = d[e + 2]; d[o + 3] = d[e + 3];
                        }
                    }
                    for (let y = vh; y < TS; y++) d.copyWithin(y * TS * 4, (vh - 1) * TS * 4, vh * TS * 4);
                    out = [d];
                    for (let l = 1; l <= LEVELS; l++) out.push(half(out[l - 1], TS >> (l - 1)));
                }
                CACHE.set(key, out);
                return out;
            };
            const expect = (tx, ty, level) => {
                if (!levelsOf(tx, ty)) return null;
                const side = TS >> level, S = side + 2;
                const out = new Uint8Array(S * S * 4);
                const leftX = tx > 0 ? -1 : 0, leftS = tx > 0 ? side - 1 : 0;
                const rightX = (tx + 1) * TS < W ? 1 : 0, rightS = rightX ? 0 : side - 1;
                const topY = ty > 0 ? -1 : 0, topS = ty > 0 ? side - 1 : 0;
                const botY = (ty + 1) * TS < H ? 1 : 0, botS = botY ? 0 : side - 1;
                for (let y = 0; y < S; y++) {
                    const dy = y === 0 ? topY : y === S - 1 ? botY : 0;
                    const sy = y === 0 ? topS : y === S - 1 ? botS : y - 1;
                    for (let x = 0; x < S; x++) {
                        const dx = x === 0 ? leftX : x === S - 1 ? rightX : 0;
                        const sx = x === 0 ? leftS : x === S - 1 ? rightS : x - 1;
                        const src = levelsOf(tx + dx, ty + dy);
                        if (!src) continue;   // no tile there: transparent
                        const lvl = src[level], i = (sy * side + sx) * 4, a = lvl[i + 3];
                        if (!a) continue;
                        const o = (y * S + x) * 4;
                        out[o] = pm(lvl[i], a); out[o + 1] = pm(lvl[i + 1], a); out[o + 2] = pm(lvl[i + 2], a); out[o + 3] = a;
                    }
                }
                return out;
            };
            let slots = 0, gutterPixels = 0;
            let buf = null;
            for (let level = 0; level <= LEVELS; level++) {
                const S = (TS >> level) + 2;
                for (let ty = 0; ty * TS < H; ty++) {
                    for (let tx = 0; tx * TS < W; tx++) {
                        const want = expect(tx, ty, level);
                        const got = p.tileWithGutter(tx, ty, level, buf);
                        if (!want) {
                            if (got !== null) throw new Error(`tile ${tx},${ty} is not allocated but a slot came back`);
                            continue;
                        }
                        if (!got) throw new Error(`no slot for tile ${tx},${ty} at level ${level}`);
                        if (buf && got !== buf) throw new Error("the buffer handed in was not reused");
                        buf = got;
                        slots++;
                        for (let i = 0; i < want.length; i++) {
                            if (got[i] === want[i]) continue;
                            const px = (i >> 2) % S, py = (i >> 2) / S | 0;
                            throw new Error(`tile ${tx},${ty} level ${level} at ${px},${py}: ${Array.from(got.slice((i >> 2) * 4, (i >> 2) * 4 + 4))} against ${Array.from(want.slice((i >> 2) * 4, (i >> 2) * 4 + 4))}`);
                        }
                        for (let k = 0; k < S; k++) gutterPixels += (got[k * 4 + 3] ? 1 : 0) + (got[((S - 1) * S + k) * 4 + 3] ? 1 : 0);
                    }
                }
            }
            // the image's own edge does not fade at a level: the last valid cell of the last tile keeps
            // its alpha, and the gutter past it repeats it (a mip of the valid part alone would halve it)
            const side1 = TS >> 1, S1 = side1 + 2, slot = p.tileWithGutter(2, 0, 1);
            const vc = Math.ceil(89 / 2);   // 45 valid cells at level 1, the last one from columns 88 and 89
            const row = 40;
            const at = (x) => slot[((row + 1) * S1 + x + 1) * 4 + 3];
            if (at(vc - 1) !== at(vc) || at(vc - 1) !== at(S1 - 3)) throw new Error("the clamp past the image edge is missing: " + [at(vc - 2), at(vc - 1), at(vc), at(S1 - 3)]);
            const full = p.readRect(512 + 88, row * 2, 1, 2).data;
            const mixedIn = (full[3] + full[7] + 0 + 0 + 2) >> 2;   // what the valid part alone would give
            if (at(vc - 1) === mixedIn && at(vc - 1) !== 255) throw new Error("the last cell is the faded one");
            // the tiles of a document that is a whole number of tiles wide have no clamp
            const exact = Layer.empty(512, 256);
            exact.fill([0, 0, 512, 256], "#3366ff");
            const es = exact.tileWithGutter(0, 0, 0);
            if (es[(1 * 258 + 258 - 1) * 4 + 3] !== 255 || es[(1 * 258) * 4 + 3] !== 255) throw new Error("a full neighbour's gutter is not opaque");
            if (exact.tileWithGutter(0, 1, 0) !== null) throw new Error("a tile outside the image gave a slot");
            return { ok: true, slots, gutterPixels, side: [T.levelSide(0), T.slotSide(0), T.slotSide(5)] };
        })],

        // C6 (a): what a slot's gutter depends on. `gutterVersions` names the version of every tile the gutter is
        // read from (0 for none), so a write into a neighbour, a neighbour dropped or a neighbour allocated makes
        // the slot stale, and a tile further away does not; `tileWithGutter(..., ring)` writes only the gutter,
        // byte for byte the full slot's, and leaves the interior as it was.
        ["tiles_gutter_versions_and_ring", both(async ({ B, pair }) => {
            if (!B.tiles) return { ok: true, tilesOnly: true };
            const TS = 256, W = 601, H = 501;   // 3 x 2 tiles, the last column and row partly outside
            const { pixels: p } = pair(W, H);
            p.clear([256, 0, 512, 256]);         // tile (1, 0) missing
            const expectNear = (tx, ty) => {
                const out = [];
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const nx = tx + dx, ny = ty + dy;
                    const t = nx >= 0 && ny >= 0 && nx * TS < W && ny * TS < H ? p.tileAt(nx, ny) : null;
                    out.push(t ? t.version : 0);
                }
                return out.join();
            };
            const near = (tx, ty) => Array.from(p.gutterVersions(tx, ty)).join();
            for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 3; tx++) {
                if (near(tx, ty) !== expectNear(tx, ty)) throw new Error(`gutterVersions(${tx}, ${ty}) is ${near(tx, ty)}, the neighbours are ${expectNear(tx, ty)}`);
            }
            // a pixel written into tile (0, 0): the slots around it are stale, (2, 1) is not a neighbour
            const n11 = near(1, 1), n21 = near(2, 1), n10 = near(1, 0);
            p.fill([10, 10, 11, 11], "#ff00ff");
            if (near(1, 1) === n11 || near(1, 0) === n10) throw new Error("a write into a diagonal or a side neighbour left the slot's gutter versions alone");
            if (near(2, 1) !== n21) throw new Error("a write two tiles away changed the gutter versions");
            // a neighbour allocated (tile (1, 0) was missing) and one dropped
            const n00 = near(0, 0);
            p.fill([300, 10, 301, 11], "#00ffff");
            if (near(0, 0) === n00 || p.gutterVersions(0, 0)[4] !== p.tileAt(1, 0).version) throw new Error("an allocated neighbour did not reach the gutter versions");
            p.clear([256, 0, 512, 256]);
            if (p.gutterVersions(0, 0)[4] !== 0) throw new Error("a dropped neighbour is not 0 in the gutter versions");
            // the ring: rows 0 and S - 1 and columns 0 and S - 1 as the full slot has them, the interior untouched
            let rings = 0;
            for (let level = 0; level <= 5; level++) {
                const S = (TS >> level) + 2;
                for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 3; tx++) {
                    const full = p.tileWithGutter(tx, ty, level);
                    if (!full) continue;
                    const buf = new Uint8Array(S * S * 4).fill(77);
                    const got = p.tileWithGutter(tx, ty, level, buf, true);
                    if (got !== buf) throw new Error("the ring was not written into the buffer handed in");
                    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
                        const onRing = x === 0 || y === 0 || x === S - 1 || y === S - 1;
                        for (let c = 0; c < 4; c++) {
                            const i = (y * S + x) * 4 + c;
                            if (onRing ? got[i] !== full[i] : got[i] !== 77) throw new Error(`tile ${tx},${ty} level ${level} at ${x},${y}: ${onRing ? "the ring differs from the full slot" : "the interior was written"}`);
                        }
                    }
                    rings++;
                }
            }
            return { ok: true, rings };
        })],

        // C6 (b): a touch gives the pixels a new version and leaves every tile's version and caches alone. Every write
        // already gave the tile it wrote a new version or a new object, so a whole touch after a write of one tile (what
        // markLayerChanged(layer) does) keeps the other tiles' mips and slot stamps, and a touch through one holder of
        // shared tiles (an undo step's clone) does not make the other holder's caches stale either.
        ["tiles_touch_keeps_tile_caches", both(async ({ B, pair }) => {
            const { pixels: p } = pair(700, 600);
            const v0 = p.version;
            p.touch();
            if (p.version === v0) throw new Error("touch() did not give the pixels a new version");
            if (!B.tiles) return { ok: true };
            const keys = p.tileKeys();
            const at = (q, k) => q.tileAt(k & 0xFFFF, k >>> 16);
            for (const k of keys) p.mips(k & 0xFFFF, k >>> 16);
            const stamps = (q, k) => Array.from(q.slotStamps(k & 0xFFFF, k >>> 16, 2)).join();
            const held = p.clone();   // an undo step: every tile shared
            const before = new Map(keys.map((k) => { const t = at(p, k); return [k, { t, v: t.version, m: t.mips, s: t.mipsSeq, st: stamps(p, k) }]; }));
            p.fill([10, 10, 20, 20], "#ff00ff");   // tile (0, 0): copied, the clone holds the original
            p.touch();
            p.touch([0, 0, 700, 600]);
            let kept = 0;
            for (const k of keys) {
                const b = before.get(k), t = at(p, k), tx = k & 0xFFFF, ty = k >>> 16;
                if (!k) { if (t === b.t || t.version === b.v) throw new Error("the written tile kept its object and version"); continue; }
                if (t !== b.t || t.version !== b.v) throw new Error(`tile ${tx},${ty}: a touch gave it a new version`);
                if (p.mips(tx, ty) !== b.m || t.mipsSeq !== b.s) throw new Error(`tile ${tx},${ty}: a touch rebuilt its mips`);
                // a slot reads its eight neighbours: only the ones next to tile (0, 0) see the write
                if ((tx > 1 || ty > 1) && stamps(p, k) !== b.st) throw new Error(`tile ${tx},${ty}: its slot stamps changed (${stamps(p, k)} against ${b.st})`);
                kept++;
            }
            held.touch();
            for (const k of keys) {
                const b = before.get(k);
                if (at(held, k) !== b.t || b.t.version !== b.v || b.t.mips !== b.m) throw new Error("the clone's shared tile was changed by a touch");
                if (k && (at(p, k) !== b.t || stamps(p, k) === "" )) throw new Error("the other holder's tile changed");
            }
            return { ok: true, tiles: keys.length, kept };
        })],

        // C6 (b): the worker's mips job gives the bytes the main thread builds: an interior tile's chain, and for the
        // last tile of a row or a column (valid part below 256) also the chain of its clamp-extended bytes, which is
        // what the atlas and the region canvases draw. Through a real worker, with the buffers transferred both ways.
        ["tiles_mips_job_matches_the_kernel", both(async ({ B, pair }) => {
            if (!B.tiles) return { ok: true, tilesOnly: true };
            const K = await import("./editor/px/kernels_js.js");
            const W = 601, H = 501;   // (2, *) is 89 px wide, (*, 1) 245 px high
            const { pixels: p } = pair(W, H);
            const list = [];
            for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 3; tx++) {
                const t = p.tileAt(tx, ty);
                if (!t) continue;
                const buf = new ArrayBuffer(256 * 256 * 4);
                new Uint8Array(buf).set(t.data);
                list.push({ tx, ty, t, job: { data: buf, vw: Math.min(256, W - (tx << 8)), vh: Math.min(256, H - (ty << 8)) } });
            }
            const w = new Worker(new URL("./editor/inpaint_worker.js", location.href), { type: "module" });
            let reply;
            try {
                reply = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("the mips job did not answer")), 20000);
                    w.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
                    w.onerror = (e) => { clearTimeout(timer); reject(new Error("worker error " + (e.message || e))); };
                    const tiles = list.map((x) => x.job);
                    w.postMessage({ id: 1, op: "mips", tiles }, tiles.map((x) => x.data));
                });
            } finally {
                w.terminate();
            }
            if (!reply.ok) throw new Error("the mips job failed: " + reply.error);
            if (list.some((x) => x.job.data.byteLength !== 0)) throw new Error("the tile buffers were not transferred to the worker");
            const n = K.mipChainBytes(256, 5);
            let edges = 0;
            list.forEach((x, i) => {
                const want = K.mipChain(x.t.data, 256, 5, new Uint8Array(n));
                const got = new Uint8Array(reply.chains[i]);
                if (got.length !== n) throw new Error(`tile ${x.tx},${x.ty}: a chain of ${got.length} bytes`);
                for (let j = 0; j < n; j++) if (got[j] !== want[j]) throw new Error(`tile ${x.tx},${x.ty}: the worker's chain differs at byte ${j}`);
                if (reply.datas[i].byteLength !== 256 * 256 * 4) throw new Error("the tile buffer did not come back");
                const edge = x.job.vw < 256 || x.job.vh < 256;
                if (!edge) { if (reply.exts[i]) throw new Error(`tile ${x.tx},${x.ty}: an interior tile got an edge chain`); return; }
                edges++;
                // the main thread's own edge chain, through the exact reader
                p._levelBytes(x.tx, x.ty, 1);
                const main = x.t.edge.mips;
                const ext = new Uint8Array(reply.exts[i] || new ArrayBuffer(0));
                if (ext.length !== n) throw new Error(`tile ${x.tx},${x.ty}: no edge chain from the worker`);
                for (let j = 0; j < n; j++) if (ext[j] !== main[j]) throw new Error(`tile ${x.tx},${x.ty}: the worker's edge chain differs at byte ${j}`);
            });
            return { ok: true, tiles: list.length, edges };
        })],

        // C6 (b): display readers against a scheduler whose worker answers when the test says so.
        ["tiles_display_chains_through_a_scheduler", both(async ({ B, Layer, pair }) => {
            if (!B.tiles) return { ok: true, tilesOnly: true };
            const K = await import("./editor/px/kernels_js.js");
            const n = K.mipChainBytes(256, 5);
            const jobs = [];
            const sch = new T.ChainScheduler((tiles) => new Promise((resolve) => jobs.push({ tiles, resolve })), { budget: 0 });
            const answer = (job) => {
                const chains = [], exts = [], datas = [];
                for (const x of job.tiles) {
                    const b = new Uint8Array(x.data);
                    chains.push(K.mipChain(b, 256, 5, new Uint8Array(n)).buffer);
                    if (x.vw < 256 || x.vh < 256) { K.clampExtend(b, 256, x.vw, x.vh); exts.push(K.mipChain(b, 256, 5, new Uint8Array(n)).buffer); } else exts.push(null);
                    datas.push(x.data);
                }
                job.resolve({ chains, exts, datas });
            };
            const tick = () => new Promise((r) => setTimeout(r, 0));
            const W = 601, H = 501;
            const { pixels: p } = pair(W, H);
            p._chains = sch;
            const twin = () => Layer.fromImageData(p.readRect(0, 0, W, H));   // exact, on the module's scheduler
            const sameSlots = (q, what) => {
                for (let level = 1; level <= 5; level++) for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 3; tx++) {
                    const a = p.tileWithGutter(tx, ty, level, null, false, true), b = q.tileWithGutter(tx, ty, level);
                    if (!a || !b) { if (a || b) throw new Error(what + ": a slot on one side only"); continue; }
                    for (let j = 0; j < b.length; j++) if (a[j] !== b[j]) throw new Error(`${what}: tile ${tx},${ty} level ${level} differs from the exact slot at byte ${j}`);
                }
            };
            // (1) new pixels: no chain anywhere, so a display slot is coarse (a non-integer negative stamp), sampled nearest
            const st = p.slotStamps(0, 0, 2, true);
            if (!(st[4] < 0) || Number.isInteger(st[4])) throw new Error("a tile with no chain did not get a coarse stamp: " + st[4]);
            if (!sch.pending) throw new Error("nothing was asked of the scheduler");
            const coarse = p.tileWithGutter(0, 0, 2, null, false, true);
            const src = p.readRect(5 * 4 + 2, 7 * 4 + 2, 1, 1).data, o = (8 * 66 + 6) * 4, a = src[3];
            const pm = (c) => { const v = c * a + 128; return (v + (v >> 8)) >> 8; };
            const expect = a === 255 ? [src[0], src[1], src[2], 255] : a ? [pm(src[0]), pm(src[1]), pm(src[2]), a] : [0, 0, 0, 0];
            if (Array.from(coarse.subarray(o, o + 4)).join() !== expect.join()) throw new Error(`the coarse slot's pixel is ${Array.from(coarse.subarray(o, o + 4))}, nearest sampling gives ${expect}`);
            if (p.tileAt(0, 0).mips) throw new Error("a display read built a chain with no budget");
            p.regionCanvas([0, 0, W, H], 2, true);
            const rc = p._regions.get(2);
            if (rc.stale.size !== p.tileCount) throw new Error(`the region canvas marks ${rc.stale.size} stale cells for ${p.tileCount} coarse tiles`);
            // (2) the worker answers: every chain installed, the region's stale cells dirty again, the slots exact
            await tick();
            if (jobs.length !== 1 || jobs[0].tiles.length !== p.tileCount) throw new Error(`${jobs.length} jobs for ${p.tileCount} tiles`);
            const epoch = p.chainEpoch;
            answer(jobs[0]);
            await tick();
            if (p.chainEpoch === epoch) throw new Error("the landing did not move the pixels' chainEpoch");
            if (rc.stale.size || rc.dirty.size !== p.tileCount) throw new Error(`after the landing: ${rc.stale.size} stale and ${rc.dirty.size} dirty cells`);
            for (const t of p.tileList()) if (t.mipsVersion !== t.version) throw new Error("a landed chain was not installed");
            sameSlots(twin(), "after the landing");
            {
                const exact = twin().regionCanvas([0, 0, W, H], 2).canvas.getContext("2d").getImageData(0, 0, rc.canvas.width, rc.canvas.height).data;
                const shown = p.regionCanvas([0, 0, W, H], 2, true).canvas.getContext("2d").getImageData(0, 0, rc.canvas.width, rc.canvas.height).data;
                for (let j = 0; j < exact.length; j++) if (exact[j] !== shown[j]) throw new Error("the region canvas after the landing differs from an exact one at byte " + j);
            }
            // (3) a write in place: the tile shows its previous chain (an integer negative stamp) until the new one lands
            const was = p.tileWithGutter(0, 0, 2, null, false, true).slice();
            p.fill([10, 10, 30, 30], "#00ff00");
            const st3 = p.slotStamps(0, 0, 2, true)[4];
            if (!(st3 < 0) || !Number.isInteger(st3)) throw new Error("a written tile with a chain did not get a stale stamp: " + st3);
            const stale = p.tileWithGutter(0, 0, 2, null, false, true);
            for (let j = 0; j < was.length; j++) if (was[j] !== stale[j]) throw new Error("the stale picture is not the tile's previous chain, at byte " + j);
            // (4) a second write while the first answer is on its way: the late answer is not installed
            await tick();
            if (jobs.length !== 2) throw new Error("the written tile was not asked for again: " + jobs.length + " jobs");
            p.fill([40, 40, 60, 60], "#0000ff");
            const dropped = T.chainStats().dropped;
            answer(jobs[1]);
            await tick();
            const t00 = p.tileAt(0, 0);
            if (t00.mipsVersion === t00.version) throw new Error("a chain of the bytes before the second write was installed");
            if (T.chainStats().dropped !== dropped + 1) throw new Error("the late answer was not counted as dropped");
            p.slotStamps(0, 0, 2, true);
            await tick();
            if (jobs.length !== 3) throw new Error("the tile was not asked for at its new version");
            answer(jobs[2]);
            await tick();
            sameSlots(twin(), "after the second write's chain landed");
            // (5) copy on write: the copy shows the original's chains, never writes into them
            const held = p.clone();
            const shared = p.tileAt(1, 0), sharedEdge = p.tileAt(2, 0);
            const keep = shared.mips.slice(), keepEdge = sharedEdge.edge.mips.slice();
            p.fill([300, 10, 310, 20], "#ff0000");
            p.fill([520, 10, 530, 20], "#ff0000");
            const c = p.tileAt(1, 0), ce = p.tileAt(2, 0);
            if (c === shared || c.mips !== shared.mips || c.mipsOwn) throw new Error("the copy did not take the original's chain as its stale picture");
            if (ce === sharedEdge || !ce.edge || ce.edge.mips !== sharedEdge.edge.mips || ce.edge.mipsOwn) throw new Error("the edge copy did not take the original's edge chain");
            const stc = p.slotStamps(1, 0, 3, true)[4];
            if (!(stc < 0) || !Number.isInteger(stc)) throw new Error("the copy's stamp is not stale: " + stc);
            p.mips(1, 0);
            p._levelBytes(2, 0, 3);
            for (let j = 0; j < keep.length; j++) if (shared.mips[j] !== keep[j]) throw new Error("building the copy's chain wrote into the chain the original's holders read, at byte " + j);
            for (let j = 0; j < keepEdge.length; j++) if (sharedEdge.edge.mips[j] !== keepEdge[j]) throw new Error("building the copy's edge chain wrote into the original's, at byte " + j);
            if (held.tileAt(1, 0) !== shared) throw new Error("the clone lost its tile");
            await tick();
            for (const job of jobs.splice(3)) answer(job);
            await tick();
            // (5b) the original's last holder writes in place while a copy still shows the original's chains as its stale
            // picture: the original's rebuild never writes into the buffers the copy reads (the C6 b review: the copy's
            // cells showed the other holder's new pixels under an unchanged stamp)
            {
                const A = twin();
                A.tileKeys().forEach((k) => A.mips(k & 0xFFFF, k >>> 16));
                A._levelBytes(2, 0, 1);   // the edge tile's edge chain
                const Bc = A.clone();
                const t = A.tileAt(1, 0), te = A.tileAt(2, 0);
                Bc.fill([300, 10, 310, 20], "#ff0000");
                Bc.fill([520, 10, 530, 20], "#ff0000");
                const cc = Bc.tileAt(1, 0), cce = Bc.tileAt(2, 0);
                if (cc.mips !== t.mips || cce.edge.mips !== te.edge.mips) throw new Error("(5b) the copies did not take the original's chains");
                const keepC = cc.mips.slice(), keepE = cce.edge.mips.slice();
                A.fill([256, 0, 512, 256], "#0000ff");
                A.fill([512, 0, 601, 256], "#0000ff");
                if (A.tileAt(1, 0) !== t || A.tileAt(2, 0) !== te) throw new Error("(5b) the last holder did not write in place");
                A.mips(1, 0);
                A._levelBytes(2, 0, 1);
                for (let j = 0; j < keepC.length; j++) if (cc.mips[j] !== keepC[j]) throw new Error("(5b) the original's rebuild wrote into the chain its copy shows, at byte " + j);
                for (let j = 0; j < keepE.length; j++) if (cce.edge.mips[j] !== keepE[j]) throw new Error("(5b) the original's edge rebuild wrote into the edge chain its copy shows, at byte " + j);
            }
            // (6) the thumbnail takes the chains the tiles keep, rebuilds a chain a tile owns in that buffer, and keeps
            // none on a tile that has none (the C6 b review: a hidden layer kept a chain on every tile for its thumbnail)
            const thumbBytes = (x) => { const cv = x.thumbnailCanvas(); return cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; };
            const q = twin();
            q.tileKeys().forEach((k) => q.mips(k & 0xFFFF, k >>> 16));
            const m0 = T.chainStats().main;
            const qBytes = thumbBytes(q);
            if (T.chainStats().main !== m0) throw new Error(`the thumbnail built ${T.chainStats().main - m0} chains the tiles already had`);
            const r = twin();
            const m1 = T.chainStats().main, th1 = T.chainStats().thumb;
            const rBytes = thumbBytes(r);
            if (T.chainStats().main !== m1) throw new Error(`the thumbnail built ${T.chainStats().main - m1} chains to keep on tiles that had none`);
            if (r.tileList().some((t) => t.mips)) throw new Error("the thumbnail kept a chain on a tile that had none");
            if (T.chainStats().thumb - th1 !== r.tileCount) throw new Error(`the thumbnail built ${T.chainStats().thumb - th1} scratch levels for ${r.tileCount} tiles`);
            for (let j = 0; j < qBytes.length; j++) if (qBytes[j] !== rBytes[j]) throw new Error("a thumbnail from scratch levels differs from one from the tiles' chains, at byte " + j);
            {
                const bufs = q.tileList().map((t) => t.mips);
                q.fill([0, 0, W, H], "#123456");   // in place: every tile owns a chain that is not exact any more
                const m2 = T.chainStats().main;
                thumbBytes(q);
                if (T.chainStats().main - m2 !== q.tileCount) throw new Error(`the thumbnail rebuilt ${T.chainStats().main - m2} owned chains of ${q.tileCount}`);
                if (q.tileList().some((t, i) => t.mips !== bufs[i] || t.mipsVersion !== t.version)) throw new Error("an owned chain was not rebuilt in its own buffer");
                const m3 = T.chainStats().main;
                q.tileKeys().forEach((k) => q.mips(k & 0xFFFF, k >>> 16));
                if (T.chainStats().main !== m3) throw new Error("mips() built chains the thumbnail had rebuilt");
            }
            // (6b) a chain from the worker that only a thumbnail asked for is handed to its cell: not kept, the chainEpoch
            // left alone (nothing on the screen changed), the cell exact; a reader of the screen then gets one kept
            {
                const j6 = [];
                const s6 = new T.ChainScheduler((tiles) => new Promise((resolve) => j6.push({ tiles, resolve })), { budget: 0 });
                const v = twin();
                v._chains = s6;
                const e0 = v.chainEpoch;
                v.thumbnailCanvas(true);
                if (!s6.pending) throw new Error("(6b) the display thumbnail asked for nothing");
                await tick();
                const ld = s6.landing();
                for (const job of j6.splice(0)) answer(job);
                const set = await ld;
                await s6.settled();
                if (!set.has(v) || set.screen.has(v)) throw new Error("(6b) the landing did not report the thumbnail's store as a thumbnail's only");
                if (v.tileList().some((t) => t.mips)) throw new Error("(6b) a chain only the thumbnail asked for was kept on the tile");
                if (v.chainEpoch !== e0) throw new Error("(6b) a thumbnail's landing moved the chainEpoch");
                if (T.chainStats().handed < v.tileCount) throw new Error("(6b) the chains were not handed to the thumbnail");
                const cv = v.thumbnailCanvas(true);
                const shown = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
                for (let j = 0; j < qBytes.length; j++) if (shown[j] !== rBytes[j]) throw new Error("(6b) the thumbnail after the landing differs from an exact one at byte " + j);
                // a rebuild of the whole thumbnail (a batch that lands on a quarter of its cells) takes the handed cells
                // again: it asked for them again on every batch, for good
                v._thumb.all = true;
                const again = v.thumbnailCanvas(true);
                if (s6.pending) throw new Error("(6b) a whole rebuild of the thumbnail asked again for the " + s6.pending + " cells a landing had handed it");
                const shown2 = again.getContext("2d").getImageData(0, 0, again.width, again.height).data;
                for (let j = 0; j < qBytes.length; j++) if (shown2[j] !== rBytes[j]) throw new Error("(6b) the thumbnail rebuilt whole after the landing differs from an exact one at byte " + j);
                v.slotStamps(0, 0, 2, true);
                await tick();
                for (const job of j6.splice(0)) answer(job);
                await s6.settled();
                if (!v.tileAt(0, 0).mips || v.tileAt(0, 0).mipsVersion !== v.tileAt(0, 0).version) throw new Error("(6b) a chain a reader of the screen asked for was not kept");
                if (v.chainEpoch === e0) throw new Error("(6b) a screen reader's landing did not move the chainEpoch");
            }
            // (7) the budget: two chains built in the task, the rest asked for; a new task has the budget again
            const s2 = new T.ChainScheduler((tiles) => new Promise((resolve) => jobs.push({ tiles, resolve })), { budget: 2 });
            const u = twin();
            u._chains = s2;
            [0, 1, 2].forEach((tx) => u.slotStamps(tx, 1, 1, true));
            const builtHere = u.tileList().filter((t) => t.mipsVersion === t.version || (t.edge && t.edge.mipsVersion === t.version)).length;
            if (builtHere !== 2) throw new Error("the budget of two built " + builtHere + " chains in one task");
            if (!s2.pending) throw new Error("beyond the budget nothing was asked for");
            await tick();
            if (s2.budget !== 2) throw new Error("the budget was not given back in the next task: " + s2.budget);
            for (const job of jobs.splice(0)) answer(job);
            await s2.settled();
            // (8) the queue goes newest first, and a cell still shown stale keeps its tile ahead: pixels a later whole
            // change replaced, which nothing reads any more, wait behind the ones on the screen (the C6 b review: a flip
            // after a flip waited for all of the first flip's chains)
            {
                const j8 = [];
                const s8 = new T.ChainScheduler((tiles) => new Promise((resolve) => j8.push({ tiles, resolve })), { budget: 0, batch: 2 });
                // A: 20 tiles (1200 x 800), each with its own bytes, so two landed cells are under a quarter of its region and
                // a second read of it puts those two and only touches the stale ones; B: six magenta tiles
                const A = Layer.empty(1200, 800), Bm = twin();
                for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 5; tx++) A.fill([(tx << 8) + 10 + tx, (ty << 8) + 10 + ty, (tx << 8) + 40, (ty << 8) + 40], "#00ff00");
                Bm.fill([0, 0, W, H], "#ff00ff");
                A._chains = s8; Bm._chains = s8;
                const magenta = (job) => job.tiles.filter((x) => { const b = new Uint8Array(x.data); return b[0] === 255 && b[1] === 0 && b[2] === 255 && b[3] === 255; }).length;
                A.regionCanvas([0, 0, 1200, 800], 2, true);   // A's twenty tiles asked for; the first batch of two goes at once
                await tick();
                if (j8.length !== 1 || magenta(j8[0])) throw new Error("(8) the first batch is not A's");
                Bm.regionCanvas([0, 0, W, H], 2, true);       // B asks later
                answer(j8[0]);
                await tick();
                if (j8.length !== 2 || magenta(j8[1]) !== 2) throw new Error(`(8) the batch after B asked holds ${j8[1] ? magenta(j8[1]) : "no"} of B's tiles and A's older ones went first`);
                const rA = A._regions.get(2);
                A.regionCanvas([0, 0, 1200, 800], 2, true);   // A's cells are still shown stale: A's eighteen waiting tiles go ahead again
                if (rA.stale.size !== 18) throw new Error("(8) the second read of A left " + rA.stale.size + " stale cells, not 18");
                answer(j8[1]);
                await tick();
                if (j8.length !== 3 || magenta(j8[2]) !== 0) throw new Error("(8) the cells still shown stale did not bring their tiles ahead of B's newer ones");
                for (let guard = 0; s8.pending && guard < 20; guard++) { for (const job of j8.splice(0)) answer(job); await tick(); }
                await s8.settled();
            }
            // (8b) a read that is not for the screen (a box the film points, the probe or the wand sample at level 0) keeps a
            // region canvas of its own: it took the place of the screen's or the navigator's, and the next frame rebuilt the
            // screen's whole region (the C6 c1 review). A read inside a display region at its level uses that one.
            {
                const z = twin();
                z.regionCanvas([0, 0, W, H], 3);          // exact: builds the chains, so the display reads ask no worker
                z.regionCanvas([0, 0, 300, 300], 1, true);   // the screen
                const shown = z._regions.get(1);
                z.regionCanvas([0, 0, W, H], 3, true);    // the navigator
                const nav = z._regions.get(3);
                if (!shown || !nav) throw new Error("(8b) the display reads kept no region canvas");
                const box = z.regionCanvas([500, 400, 503, 403], 0);   // a sampled box, clear of the screen's region
                if (z._regions.get(1) !== shown || z._regions.get(3) !== nav) throw new Error("(8b) a sampled box at level 0 pushed out a display region: " + JSON.stringify(Array.from(z._regions.keys())));
                const own = z._regions.get("sample");
                if (!own || own.canvas !== box.canvas || own.level !== 0) throw new Error("(8b) the sampled box has no region of its own");
                const inside = z.regionCanvas([10, 10, 20, 20], 1);
                if (inside.canvas !== shown.canvas || z._regions.get("sample") !== own) throw new Error("(8b) a sampled read inside the screen's region did not use it");
                z.fill([501, 401, 502, 402], "#00ff00");
                if (own.dirty.size !== 1) throw new Error("(8b) a write inside the sampled region did not mark its cell");
                const ownBytes = own.canvas.width * own.canvas.height * 4, bytes = z.releaseDisplay();
                if (z._regions || bytes < ownBytes) throw new Error("(8b) releaseDisplay did not give the regions back");
            }
            // (9) a write outside a region canvas's tiles leaves its cells alone: its rebuild threshold counts dirty cells,
            // and a write elsewhere in the picture rebuilt the whole region every frame (the C6 b review)
            {
                const z = twin();
                z.regionCanvas([0, 0, 200, 200], 0);
                const rz = z._regions.get("sample");
                if (rz.tx1 !== 1 || rz.ty1 !== 1) throw new Error("(9) the region's tiles are " + [rz.tx0, rz.ty0, rz.tx1, rz.ty1]);
                z.fill([530, 300, 600, 500], "#00ff00");   // tile (2, 1): outside
                if (rz.dirty.size) throw new Error(`(9) a write outside the region marked ${rz.dirty.size} of its cells dirty`);
                z.fill([10, 10, 20, 20], "#00ff00");
                if (rz.dirty.size !== 1) throw new Error("(9) a write inside the region did not mark its cell");
            }
            // (10) the region canvas's word copies (cells under 64 px, levels 3 to 5) against cells assembled by hand: exact
            // cells from `_levelBytes`, and the coarse blocks of a tile with no chain from nearest samples of its bytes
            {
                const j10 = [];
                const s10 = new T.ChainScheduler((tiles) => new Promise((resolve) => j10.push({ tiles, resolve })), { budget: 0 });
                const src = p.readRect(0, 0, W, H).data;
                const viaCanvas = (bytes, cw, ch) => {
                    const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
                    const x = cv.getContext("2d", { willReadFrequently: true });
                    x.putImageData(new ImageData(bytes, cw, ch), 0, 0);
                    return x.getImageData(0, 0, cw, ch).data;
                };
                const readRc = (res) => res.canvas.getContext("2d").getImageData(0, 0, res.canvas.width, res.canvas.height).data;
                const exactRef = (q, level, cw, ch) => {
                    const cell = 256 >> level, out = new Uint8ClampedArray(cw * ch * 4);
                    for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 3; tx++) {
                        const lv = q._levelBytes(tx, ty, level);
                        for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
                            const i = lv.off + (y * cell + x) * 4, o = ((ty * cell + y) * cw + tx * cell + x) * 4;
                            out[o] = lv.data[i]; out[o + 1] = lv.data[i + 1]; out[o + 2] = lv.data[i + 2]; out[o + 3] = lv.data[i + 3];
                        }
                    }
                    return viaCanvas(out, cw, ch);
                };
                const coarseRef = (level, cw, ch) => {
                    const cell = 256 >> level, f = 1 << level, q = Math.max(1, cell >> 3), qh = (q * f) >> 1, out = new Uint8ClampedArray(cw * ch * 4);
                    for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 3; tx++) {
                        const vw = Math.min(256, W - (tx << 8)), vh = Math.min(256, H - (ty << 8));
                        for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
                            const sy = (ty << 8) + Math.min(Math.floor(y / q) * q * f + qh, vh - 1), sx = (tx << 8) + Math.min(Math.floor(x / q) * q * f + qh, vw - 1);
                            const i = (sy * W + sx) * 4, o = ((ty * cell + y) * cw + tx * cell + x) * 4;
                            out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; out[o + 3] = src[i + 3];
                        }
                    }
                    return viaCanvas(out, cw, ch);
                };
                const same = (a, b, what) => { if (a.length !== b.length) throw new Error(what + ": sizes differ"); for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) throw new Error(`${what}: differs at byte ${j} (${a[j]} against ${b[j]})`); };
                for (let level = 3; level <= 5; level++) {
                    const cell = 256 >> level, cw = 3 * cell, ch = 2 * cell;
                    const ex = twin();
                    same(readRc(ex.regionCanvas([0, 0, W, H], level)), exactRef(ex, level, cw, ch), `(10) level ${level}, exact`);
                    const co = twin();
                    co._chains = s10;
                    same(readRc(co.regionCanvas([0, 0, W, H], level, true)), coarseRef(level, cw, ch), `(10) level ${level}, coarse blocks`);
                    await tick();
                    for (const job of j10.splice(0)) answer(job);
                    await s10.settled();
                    same(readRc(co.regionCanvas([0, 0, W, H], level, true)), exactRef(ex, level, cw, ch), `(10) level ${level}, after the landing`);
                }
            }
            await sch.settled();
            return { ok: true, jobs: 3 };
        })],

        // C6 (c3): a primed exact read. `primeRegion` asks the worker for the chains of the interior tiles of a
        // region, hands each one to the job's cell at its landing and keeps none on the tile; the read that follows
        // is byte for byte the read that built them all here, and it builds only the clamp-extended edge tiles.
        ["tiles_primed_exact_read_builds_no_chain_here", both(async ({ B, Layer, pair }) => {
            if (!B.tiles) return { ok: true, tilesOnly: true };
            const K = await import("./editor/px/kernels_js.js");
            const n = K.mipChainBytes(256, 5);
            const jobs = [];
            const sch = new T.ChainScheduler((tiles) => new Promise((resolve) => jobs.push({ tiles, resolve })), { budget: 0 });
            const answer = () => {
                for (const job of jobs.splice(0)) {
                    const chains = [], exts = [], datas = [];
                    for (const x of job.tiles) {
                        const b = new Uint8Array(x.data);
                        chains.push(K.mipChain(b, 256, 5, new Uint8Array(n)).buffer);
                        if (x.vw < 256 || x.vh < 256) { K.clampExtend(b, 256, x.vw, x.vh); exts.push(K.mipChain(b, 256, 5, new Uint8Array(n)).buffer); } else exts.push(null);
                        datas.push(x.data);
                    }
                    job.resolve({ chains, exts, datas });
                }
            };
            const tick = () => new Promise((r) => setTimeout(r, 0));
            const W = 1100, H = 900;                       // 5 x 4 tiles: 12 interior, 8 clamp-extended at the edge
            const readRc = (res) => res.canvas.getContext("2d").getImageData(0, 0, res.canvas.width, res.canvas.height).data;
            const chainBytesOf = (q) => { let b = 0; for (const t of q.tileList()) { if (t.mips) b += t.mips.byteLength; if (t.edge && t.edge.mips) b += t.edge.mips.byteLength; } return b; };
            const same = (a, b, what) => { if (a.length !== b.length) throw new Error(what + ": sizes differ"); for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) throw new Error(`${what}: differs at byte ${j} (${a[j]} against ${b[j]})`); };

            for (const level of [3, 5]) {
                const { pixels: p } = pair(W, H);
                const { pixels: ex } = pair(W, H);                 // the same picture, read the old way
                p._chains = sch;
                const want = readRc(ex.regionCanvas([0, 0, W, H], level));   // exact, every chain built here

                const m0 = T.chainStats().main, e0 = p.chainEpoch, c0 = chainBytesOf(p);
                const done = p.primeRegion([0, 0, W, H], level);
                await tick();                                     // the scheduler flushes in a microtask
                if (!jobs.length) throw new Error(`level ${level}: primeRegion asked the worker for nothing`);
                const asked = jobs.reduce((a, j) => a + j.tiles.length, 0);
                if (asked !== 12) throw new Error(`level ${level}: ${asked} tiles asked for, expected the 12 interior ones`);
                if (T.chainStats().main !== m0) throw new Error(`level ${level}: the prime built ${T.chainStats().main - m0} chains on this thread`);
                answer();
                const job = await done;
                if (!job.live) throw new Error(`level ${level}: the job says it asked for nothing`);
                if (job.cells.size !== 12) throw new Error(`level ${level}: ${job.cells.size} cells, expected 12`);
                if (p.chainEpoch !== e0) throw new Error(`level ${level}: the prime moved chainEpoch, so it asked as a reader of the screen`);
                if (job.bytes !== 12 * (256 >> level) * (256 >> level) * 4) throw new Error(`level ${level}: the cells are ${job.bytes} bytes`);

                const got = readRc(p.regionCanvas([0, 0, W, H], level));
                same(got, want, `level ${level}: the primed read`);
                // only the eight edge tiles' clamp-extended chains were built here, and no chain is on an interior tile
                const built = T.chainStats().main - m0;
                if (built !== 8) throw new Error(`level ${level}: ${built} chains built on this thread, expected the 8 edge tiles`);
                let kept = 0;
                for (const t of p.tileList()) if (t.mips) kept++;
                if (kept) throw new Error(`level ${level}: ${kept} interior tiles kept a chain the worker built`);
                job.release();
                if (p.primedBytes() !== 0) throw new Error(`level ${level}: release() left ${p.primedBytes()} bytes of cells`);
                if (chainBytesOf(p) - c0 > 8 * n) throw new Error(`level ${level}: the read kept ${chainBytesOf(p) - c0} bytes of chains`);
            }

            // a tile that owns a stale chain buffer (an in-place whole write: a fill, a filter, a mask invert) gets its
            // chain installed rather than handed over, and the read is still exact (critic item 3)
            {
                const { pixels: p } = pair(W, H);
                const { pixels: ex } = pair(W, H);
                p.regionCanvas([0, 0, W, H], 3);                  // every tile owns a chain now
                p._chains = sch;
                p.fill([0, 0, W, H], "#20c040");                  // in place: the tiles keep their (now stale) buffers
                ex.fill([0, 0, W, H], "#20c040");
                const want = readRc(ex.regionCanvas([0, 0, W, H], 3));
                const done = p.primeRegion([0, 0, W, H], 3);
                await tick();
                answer();
                const job = await done;
                same(readRc(p.regionCanvas([0, 0, W, H], 3)), want, "an in-place write: the primed read");
                if (!p.tileList().some((t) => t.mips && t.mipsVersion === t.version)) throw new Error("a tile that owned a buffer did not get its chain back");
                job.release();
            }

            // a write after the landing must not be read from the cell: the cell carries the tile's version
            {
                const { pixels: p } = pair(W, H);
                p._chains = sch;
                const done = p.primeRegion([0, 0, W, H], 3);
                await tick();
                answer();
                const job = await done;
                p.fill([0, 0, 300, 300], "#ff00ff");              // tiles (0,0) and (1,0), after their chains landed
                const { pixels: ex } = pair(W, H);
                ex.fill([0, 0, 300, 300], "#ff00ff");
                same(readRc(p.regionCanvas([0, 0, W, H], 3)), readRc(ex.regionCanvas([0, 0, W, H], 3)), "a write after the landing");
                job.release();
            }

            // the cells are for exact reads only. A display read has to take the same decision `_stampAt` takes, or
            // the atlas would build a slot from a cell under a stamp that reads stale at the very next frame.
            {
                const { pixels: p } = pair(W, H);
                p._chains = sch;
                const done = p.primeRegion([0, 0, W, H], 3);
                await tick();
                answer();
                const job = await done;
                const st = p.slotStamps(1, 1, 3, true);           // an interior tile, asked the way the atlas asks
                const lv = p._levelBytes(1, 1, 3, true);
                if (!lv || st[4] !== lv.stamp) throw new Error(`after a prime a display read and the atlas disagree: ${lv && lv.stamp} against ${st[4]}`);
                job.release();
                await tick();                                     // those two display reads asked for chains of their own
                answer();
            }

            // no transport: the job holds nothing, resolves at once, and the read builds its chains as it always did
            {
                const { pixels: p } = pair(W, H);
                p._chains = new T.ChainScheduler(null, { budget: 0 });
                const job = await p.primeRegion([0, 0, W, H], 3);
                if (job.live || job.cells.size) throw new Error("a prime without a worker asked for something");
                const { pixels: ex } = pair(W, H);
                same(readRc(p.regionCanvas([0, 0, W, H], 3)), readRc(ex.regionCanvas([0, 0, W, H], 3)), "no worker: the read");
                job.release();
            }

            // level 0 reads no chain at all, so a prime there is a no-op
            {
                const { pixels: p } = pair(W, H);
                p._chains = sch;
                const before = jobs.length;
                const job = await p.primeRegion([0, 0, W, H], 0);
                await tick();
                if (job.live) throw new Error("a prime at level 0 asked the worker for chains");
                if (jobs.length !== before) throw new Error("a prime at level 0 queued a batch");
                job.release();
            }
            await sch.settled();
            return { ok: true, levels: [3, 5] };
        })],

        // Whole tiles shared by a tile-aligned "copy" onto pixels that already hold content and a mirror
        // (an undo step put back at the layer origin): the missing source tiles clear, the mirror follows.
        ["tiles_aligned_blit_copy_onto_content", both(async ({ Layer, pair, snap, same }) => {
            const { pixels: p } = pair(1000, 800);
            P.canvasOf(p);                                    // the mirror exists before the blit
            const src = Layer.empty(600, 600);
            src.fill([0, 0, 40, 40], "#0f0");                 // src tile (0,0) holds a pixel, (1,0) is missing, column 2 is 88 px wide
            p.blit(src, 256, 256, "copy");
            snap(p, "aligned blit copy onto content");
            same(P.canvasOf(p), p, "aligned blit copy reaches the mirror");
            const { pixels: h } = pair(700, 600);
            const hole = h.clone();
            hole.clear([300, 300, 340, 340]);                 // a transparent patch inside a tile with content
            h.blit(hole, 0, 0, "copy", 1, [300, 300, 340, 340]);
            snap(h, "a transparent block copied into a tile with content");
            return { ok: true };
        })],

        // The per-tile caches (the extent bounds() uses, the mips) follow writes into a tile that exists.
        ["tiles_caches_follow_in_place_writes", both(async ({ B, Layer, rec }) => {
            const e = Layer.empty(1000, 800);
            e.fill([300, 300, 301, 301], "#fff");
            rec("bounds 1", e.bounds());
            e.fill([260, 290, 261, 291], "#fff");              // the same tile, written in place
            rec("bounds 2", e.bounds());
            e.drawInto([400, 400, 420, 420], (ctx) => { ctx.fillStyle = "#fff"; ctx.fillRect(401, 402, 3, 3); });
            rec("bounds 3", e.bounds());
            const px = new ImageData(1, 1); px.data[3] = 9;
            e.writeRect(px, 257, 500);                         // tile (1, 1), in place after the draw
            rec("bounds 4", e.bounds());
            e.writeRect(px, 258, 299, "source-over", 1);
            rec("bounds 5", e.bounds());
            if (e.bounds().join() !== "257,290,404,501") throw new Error("bounds after in-place writes: " + e.bounds());
            if (B.tiles) {
                const K = await import("./editor/px/kernels_js.js");
                const t = Layer.empty(300, 300);
                t.fill([0, 0, 256, 256], "#808080");
                t.mips(0, 0);
                for (const write of [() => t.fill([0, 0, 128, 128], "#ffffff"), () => t.drawInto([0, 0, 64, 64], (ctx) => ctx.clearRect(0, 0, 64, 64)), () => t.writeRect(px, 200, 200)]) {
                    write();
                    const got = t.mips(0, 0);
                    const want = K.mipChain(t.tileAt(0, 0).data, 256, T.MIP_LEVELS, new Uint8Array(K.mipChainBytes(256, T.MIP_LEVELS)));
                    for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) throw new Error("stale mips at byte " + i);
                }
            }
            return { bounds: e.bounds() };
        })],

        // A clone that drops its hold on a tile lets go of it; a transparent fill allocates nothing.
        ["tiles_drops_and_transparent_fills", both(async ({ B, Layer, pair, tiles, snap }) => {
            const { pixels: base } = pair(700, 600);
            const c = base.clone();
            const t = B.tiles ? base.tileAt(1, 1) : null;
            c.clear([256, 256, 512, 512]);                   // c drops its hold on (1, 1)
            base.fill([300, 300, 301, 301], "#fff");
            if (B.tiles && base.tileAt(1, 1) !== t) throw new Error("the last holder copied after the other one dropped the tile: frozen " + t.frozen);
            snap(base, "the last holder written in place");
            const e = Layer.empty(700, 600);
            e.fill([0, 0, 600, 500], "rgba(0,0,0,0)");
            tiles(e, 0, "a transparent fill allocates nothing");
            e.fill([100, 100, 110, 110], "#f00");
            e.fill([0, 0, 700, 600], "transparent");
            tiles(e, 0, "a transparent fill drops what it empties");
            snap(e, "after transparent fills");
            return { ok: true };
        })],

        // Reads, draws and write-backs wider or taller than one 4096 px block, and bands wider than
        // 32,768 px, whose power-of-two scratch class (65,536 px) Chromium can neither draw nor read.
        ["tiles_wide_draws", both(async ({ B, Layer, mk, paint, snap, rec }) => {
            const c = mk(5000, 300); paint(c.getContext("2d"), 5000, 300);
            snap(Layer.fromCanvas(c), "fromCanvas 5000 wide");
            const c2 = mk(300, 5000); paint(c2.getContext("2d"), 300, 5000);
            snap(Layer.fromCanvas(c2), "fromCanvas 5000 high");
            const bands = (ctx, w, h) => { ctx.fillStyle = "#08f"; ctx.fillRect(0, 0, w, h / 2); ctx.fillStyle = "rgba(255,0,0,0.5)"; ctx.fillRect(w * 0.8, h * 0.3, w * 0.18, h * 0.5); };
            const e = Layer.empty(5000, 300);
            e.drawInto(null, (ctx) => bands(ctx, 5000, 300));
            snap(e, "drawInto 5000 wide");
            const f = Layer.empty(300, 5000);
            f.drawInto(null, (ctx) => bands(ctx, 300, 5000));
            snap(f, "drawInto 5000 high");
            const img = new ImageData(4900, 20);
            for (let i = 0; i < img.data.length; i += 4) img.data[i + 3] = (i >> 5) & 255;
            e.writeRect(img, 50, 100, "destination-out", 0.5);
            snap(e, "writeRect with an operation 4900 wide");
            const w = Layer.empty(40000, 300);
            w.fill([0, 200, 40000, 210], "#00ff00");
            for (const bw of [32768, 32769, 40000]) {
                w.drawInto([0, 200, bw, 210], (ctx) => { ctx.fillStyle = "#f00"; ctx.fillRect(bw - 20, 204, 10, 2); ctx.fillRect(0, 203, 10, 2); });
                rec(`a band ${bw} px wide`, w.readRect(0, 195, 40000, 20).data);
            }
            const d = new ImageData(33000, 4);
            for (let i = 3; i < d.data.length; i += 4) d.data[i] = 128;
            w.writeRect(d, 0, 202, "destination-out", 1);
            rec("destination-out 33000 px wide", w.readRect(0, 195, 40000, 20).data);
            if (w.readRect(20000, 205, 1, 1).data[3] !== 127 || w.readRect(35000, 208, 1, 1).data[1] !== 255) throw new Error("the wide band: " + w.readRect(20000, 205, 1, 1).data + " / " + w.readRect(35000, 208, 1, 1).data);
            if (B.tiles) {
                const big = Object.keys(T.scratchStats().free).filter((k) => k.split("x").some((n) => +n > 32768));
                if (big.length) throw new Error("a scratch class above 32,768 px a side was pooled: " + big);
                for (const [what, f2] of [["drawInto", () => Layer.empty(70000, 100).drawInto(null, () => {})], ["toCanvas", () => Layer.empty(70000, 10).toCanvas()], ["the mirror", () => P.canvasOf(Layer.empty(10, 70000))]]) {
                    let msg = "";
                    try { f2(); } catch (err) { msg = err.message; }
                    if (!/65,535 px a side/.test(msg)) throw new Error(`${what} 70,000 px long: ` + (msg || "not refused"));
                }
            }
            return { ok: true };
        })],

        // The selection brush (selectionDab: a round stroke, its box padded by the width + 4) and the
        // ellipse marquee (its box the shape +- 1) far from the origin: the translation effect at its size
        // on the editor's own shapes (TOLERANCES). Selection edges compared between the backends need an
        // alpha tolerance, and their bounds() can differ.
        ["selection_shapes_far_from_the_origin", both(async ({ Mask, rec }) => {
            const W = 3300, H = 2300;
            const ellipse = (m, x0, y0, x1, y1) => {   // the marquee's pointer up in add mode
                const box = [Math.min(x0, x1) - 1, Math.min(y0, y1) - 1, Math.max(x0, x1) + 1, Math.max(y0, y1) + 1];
                m.drawInto(box, (s) => {
                    s.globalCompositeOperation = "source-over";
                    s.fillStyle = "#ff0000";
                    s.beginPath();
                    s.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
                    s.fill();
                });
                return box;
            };
            const dab = (m, x0, y0, x1, y1, size) => {   // selectionDab
                const pad = size + 4;
                const box = [Math.min(x0, x1) - pad, Math.min(y0, y1) - pad, Math.max(x0, x1) + pad, Math.max(y0, y1) + pad];
                m.drawInto(box, (s) => {
                    s.globalCompositeOperation = "source-over";
                    s.strokeStyle = "#ff0000";
                    s.lineCap = "round"; s.lineJoin = "round"; s.lineWidth = size;
                    s.beginPath(); s.moveTo(x0, y0); s.lineTo(x1 + 0.01, y1 + 0.01); s.stroke();
                });
                return box;
            };
            const read = (m, boxes) => {
                const parts = boxes.map((b) => {
                    const r = [Math.max(0, Math.floor(b[0])), Math.max(0, Math.floor(b[1])), Math.min(W, Math.ceil(b[2])), Math.min(H, Math.ceil(b[3]))];
                    return m.readRect(r[0], r[1], r[2] - r[0], r[3] - r[1]).data;
                });
                const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
                let o = 0;
                for (const a of parts) { out.set(a, o); o += a.length; }
                return out;
            };
            // the review's worst shapes of 150 each (an ellipse 68 levels apart at its edge, a brush dab 48)
            const e1 = Mask.empty(W, H);
            rec("the review's worst ellipse", read(e1, [ellipse(e1, 1172.4333172302847, 1388.9287001168955, 1385.2683221345153, 1630.5719173148143)]));
            const d1 = Mask.empty(W, H);
            rec("the review's worst brush dab", read(d1, [dab(d1, 2758.937741517526, 364.2683506776897, 2746.925194266683, 377.57610091826695, 91.0419998588236)]));
            // and 30 of each drawn as the review drew them (its generator and seed), each on a fresh selection
            let seed = 777;
            const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
            const ellipses = [], dabs = [];
            for (let i = 0; i < 30; i++) {
                const x0 = 50 + rnd() * 2800, y0 = 50 + rnd() * 1800, x1 = x0 + 3 + rnd() * 300, y1 = y0 + 3 + rnd() * 300;
                const m = Mask.empty(W, H);
                ellipses.push(read(m, [ellipse(m, x0, y0, x1, y1)]));
            }
            for (let i = 0; i < 30; i++) {
                const x0 = 200 + rnd() * 2800, y0 = 200 + rnd() * 1800, x1 = x0 + rnd() * 40 - 20, y1 = y0 + rnd() * 40 - 20, size = 1 + rnd() * 120;
                const m = Mask.empty(W, H);
                dabs.push(read(m, [dab(m, x0, y0, x1, y1, size)]));
            }
            const join = (list) => { const out = new Uint8Array(list.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of list) { out.set(a, o); o += a.length; } return out; };
            rec("30 ellipses", join(ellipses));
            rec("30 brush dabs", join(dabs));
            return { ok: true };
        }, TOLERANCES.selection_shapes)],

        ["tiles_rule12_translated_scratch", both(async ({ B, Layer, mk, same, px, paint, pair }) => {
            // the close-out's three transform cases again, on rects far from the origin, so the tile
            // backend's scratch is translated by hundreds of pixels
            const translation = [];
            const probe = (ctx) => { const m = ctx.getTransform(); translation.push([m.e, m.f]); };   // only to prove the case is translated
            const a = Layer.empty(1000, 800);
            a.drawInto([640, 530, 700, 600], (ctx) => { probe(ctx); ctx.fillStyle = "#ffffff"; ctx.fillRect(647, 533, 1, 1); });
            if (px(a, 647, 533)[3] !== 255 || a.bounds().join() !== "647,533,648,534") throw new Error("the point: " + a.bounds());
            const b = Layer.empty(1000, 800);
            b.drawInto([600, 500, 760, 700], (ctx) => {
                probe(ctx);
                ctx.fillStyle = "#ffffff";
                ctx.save();
                ctx.scale(2, 2);
                ctx.fillRect(324, 266, 1, 1);        // 648..650 x 532..534
                ctx.translate(5, 10);
                ctx.fillRect(325, 267, 1, 1);        // 660..662 x 554..556
                ctx.restore();
                ctx.fillRect(610, 690, 1, 1);
            });
            const rb = mk(1000, 800), rc = rb.getContext("2d");
            rc.fillStyle = "#ffffff";
            rc.fillRect(648, 532, 2, 2); rc.fillRect(660, 554, 2, 2); rc.fillRect(610, 690, 1, 1);
            same(b, rb, "far: a composed scale and translation");
            const { ref, pixels } = pair(1000, 800);
            const src = mk(50, 40); paint(src.getContext("2d"), 50, 40);
            pixels.drawInto([300, 260, 700, 600], (ctx) => { probe(ctx); ctx.globalAlpha = 0.6; ctx.scale(1.5, 1.25); ctx.drawImage(src, 212, 219); });
            const g = ref.getContext("2d");
            g.save(); const q = new Path2D(); q.rect(300, 260, 400, 340); g.clip(q);
            g.globalAlpha = 0.6; g.setTransform(1.5, 0, 0, 1.25, 0, 0); g.drawImage(src, 212, 219); g.restore();
            same(pixels, ref, "far: a scaled draw at an alpha");
            const expected = B.tiles ? "-640,-530;-600,-500;-300,-260" : "0,0;0,0;0,0";
            if (translation.map((t) => t.join()).join(";") !== expected) throw new Error("scratch translation " + JSON.stringify(translation));
            return { translation };
        })],

        ["tiles_scratch_pool_no_state", both(async ({ B, mk, paint, pair, snap }) => {
            const { pixels: p } = pair(600, 500);
            const src = mk(60, 50); paint(src.getContext("2d"), 60, 50);
            p.drawInto([100, 100, 400, 350], (ctx) => {
                // everything a callback can leave behind, save() twice without restore included
                ctx.save(); ctx.save();
                ctx.translate(33, 44); ctx.rotate(0.3);
                ctx.globalAlpha = 0.2; ctx.globalCompositeOperation = "xor";
                ctx.filter = "blur(3px)";
                ctx.shadowBlur = 9; ctx.shadowColor = "red"; ctx.shadowOffsetX = 4;
                ctx.lineWidth = 17; ctx.lineCap = "round"; ctx.setLineDash([5, 3]);
                ctx.font = "40px serif"; ctx.textAlign = "center";
                ctx.imageSmoothingEnabled = false;
                ctx.fillStyle = "#123"; ctx.strokeStyle = "#456";
                ctx.beginPath(); ctx.moveTo(150, 150); ctx.lineTo(300, 300);
                ctx.fillRect(120, 120, 40, 40);
                const clip = new Path2D(); clip.rect(100, 100, 50, 50); ctx.clip(clip);
            });
            snap(p, "a callback that leaves state behind");
            const before = B.tiles ? T.scratchStats().reused : 0;
            p.drawInto([120, 110, 410, 360], (ctx) => {
                const fresh = ctx.globalAlpha === 1 && ctx.globalCompositeOperation === "source-over" && ctx.filter === "none"
                    && ctx.shadowBlur === 0 && ctx.shadowOffsetX === 0 && ctx.shadowColor === "rgba(0, 0, 0, 0)" && ctx.lineWidth === 1 && ctx.lineCap === "butt"
                    && ctx.getLineDash().length === 0 && ctx.font === "10px sans-serif" && ctx.textAlign === "start"
                    && ctx.imageSmoothingEnabled === true && ctx.fillStyle === "#000000" && ctx.strokeStyle === "#000000";
                if (!fresh) throw new Error("the second callback got state from the first");
                ctx.lineTo(300, 200); ctx.lineTo(200, 300); ctx.fill();   // a leftover path would join in
                ctx.fillStyle = "#e0e0e0";
                ctx.fillRect(130, 120, 10, 10);                            // a leftover transform or clip would move or cut it
                ctx.drawImage(src, 140, 130, 90, 70);                      // leftover smoothing, filter or shadow would change it
            });
            snap(p, "the next callback starts fresh");
            if (B.tiles && T.scratchStats().reused <= before) throw new Error("the second drawInto did not reuse the pooled scratch");
            return { ok: true };
        }, TOLERANCES.scratch_pool)],

        ["tiles_mask_pixels", both(async ({ B, Mask, snap, rec }) => {
            const m = Mask.empty(900, 700);
            m.fill(null, "#ff0000");
            m.clear([100, 100, 400, 300]);
            snap(m, "selection filled and a hole cleared");
            rec("mask bounds", m.bounds());
            m.drawInto([50, 50, 600, 500], (ctx) => {
                ctx.globalCompositeOperation = "destination-in";   // a whole-canvas operation, held to the rect
                ctx.fillStyle = "#ff0000";
                ctx.fillRect(80, 60, 400, 300);
            });
            snap(m, "destination-in held to the rect");
            const white = Mask.empty(500, 400);
            white.fill([0, 0, 250, 400], "#ffffff");
            white.writeRect(m.readRect(0, 0, 300, 300), 200, 100, "destination-out", 0.5);
            snap(white, "a layer mask erased through the selection");
            const kinds = [m.clone(), m.copyRect([0, 0, 300, 300]), m.resized(1000, 800, { x: 30, y: 40 })];
            for (const k of kinds) {
                if (!(k instanceof Mask) || !(k instanceof P.MaskPixels) || !(k instanceof P.LayerPixels) || T.isTilePixels(k) !== B.tiles) throw new Error("mask class not kept");
                snap(k, "mask " + k.width + "x" + k.height);
            }
            return { tiles: B.tiles ? m.tileCount : null };
        })],

        // MaskPixels.invert (docs/PLAN_BCE.md §C5): the selection inverted. The tile backend walks its
        // own tiles instead of the whole mask, so the two runs are compared byte for byte like every
        // other case, and the result is checked against the rule itself (255 - alpha, colour red) on
        // a size whose last tile column and row are partly outside the image: a selected padding
        // would bleed into that tile's mips and out through the atlas.
        ["mask_invert", both(async ({ B, Mask, snap, rec }) => {
            const W = 601, H = 501;
            const m = Mask.empty(W, H);
            m.fill([100, 80, 400, 300], "#ff0000");
            // partial alpha at several levels, on whole pixels: a gradient is rasterised differently
            // by the CPU and the GPU (51 levels, measured), which would be the case's difference, not
            // invert's
            m.drawInto([380, 280, 560, 460], (ctx) => {
                for (let k = 0; k < 6; k++) {
                    ctx.fillStyle = `rgba(255,0,0,${(k + 1) / 7})`;
                    ctx.fillRect(380 + k * 30, 280, 30, 180);
                }
            });
            const beforeBytes = m.readRect(0, 0, W, H).data.slice();
            snap(m, "the selection before the invert");
            m.invert();
            const after = m.readRect(0, 0, W, H);
            snap(m, "the selection inverted");
            rec("bounds after the invert", m.bounds());
            let worst = 0, n = 0;
            const d = after.data;
            for (let i = 0; i < d.length; i += 4) {
                worst = Math.max(worst, Math.abs(d[i + 3] - (255 - beforeBytes[i + 3])));
                // a fully transparent pixel carries no colour: a canvas un-premultiplies it to 0, 0, 0
                if (d[i + 3] > 0) worst = Math.max(worst, Math.abs(d[i] - 255), d[i + 1], d[i + 2]);
                if (d[i + 3] !== 255 - beforeBytes[i + 3]) n++;
            }
            if (worst > 1) throw new Error("invert did not follow 255 - alpha in red: worst " + worst + " on " + n + " pixels");
            m.invert();
            const back = m.readRect(0, 0, W, H).data;
            let diff = 0;
            for (let i = 3; i < back.length; i += 4) diff = Math.max(diff, Math.abs(back[i] - beforeBytes[i]));
            if (diff > 1) throw new Error("inverting twice did not give the alpha back: " + diff);
            snap(m, "inverted twice");
            // the padding of a partial tile stays out of it: the tiles at the last column and row
            return { tiles: B.tiles ? m.tileCount : null, worst, alphaBack: diff };
        })],

        ["tiles_blit_mixed_backends", both(async ({ B, Layer, mk, paint, pair, snap }) => {
            const Other = B.tiles ? P.LayerPixels : T.TileLayerPixels;   // the other backend
            const c = mk(400, 300); paint(c.getContext("2d"), 400, 300);
            const foreign = Other.fromCanvas(c);
            const { pixels: p } = pair(700, 600);
            p.blit(foreign, 30, 40, "copy");
            snap(p, "copy from the other backend");
            p.blit(foreign, 300.5, 20.25, "source-over", 0.6, [10, 10, 200, 150]);
            snap(p, "source-over at a fraction from the other backend");
            p.blit(foreign, 250, 250, "destination-in", 0.8, [0, 0, 100, 100]);
            snap(p, "destination-in from the other backend");
            const into = Other.fromCanvas(mk(500, 400));
            into.blit(p, -20, 10, "copy", 1, [0, 0, 400, 300]);
            into.blit(p, 100.75, 50, "source-atop", 0.5, [100, 100, 400, 400]);
            snap(into, "the other backend from this one");
            p.blit(p, 50, 60, "copy", 1, [0, 0, 400, 300]);                    // overlapping, onto itself
            snap(p, "copy onto itself, overlapping");
            p.blit(p, 30, 20, "source-over", 0.5, [100, 100, 500, 500]);
            snap(p, "source-over onto itself, overlapping");
            p.blit(p, 20.5, 10.25, "copy", 1, [50, 40, 150, 120]);             // at a fraction: the neighbours are sampled
            snap(p, "copy onto itself at a fraction");
            p.blit(p, 120.5, 60.75, "copy", 0.5, [250, 240, 350, 320]);
            snap(p, "copy onto itself at a fraction and an alpha");
            p.blit(p, 400, 300, "copy", 0.5, [0, 0, 200, 150]);
            snap(p, "copy onto itself at an alpha");
            p.blit(foreign, 250.5, 250.25, "destination-in", 0.8, [0, 0, 100, 100]);   // a whole-canvas operation at a fraction: clipped on whole pixels
            snap(p, "destination-in at a fraction");
            return { ok: true };
        })],

        // ---- timings: printed, not gated ------------------------------------------------------------

        ["timings", async () => {
            const was = P.pixelsOptions();
            const ms = (t0) => +(performance.now() - t0).toFixed(2);
            const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
            const out = {};
            try {
                P.setPixelsOptions({ software: false });
                // a 400 px dab on a 4096² layer with content
                const content = P.makeCanvas(4096, 4096);
                const cc = content.getContext("2d");
                const g = cc.createLinearGradient(0, 0, 4096, 4096); g.addColorStop(0, "#f40"); g.addColorStop(1, "#04f");
                cc.fillStyle = g; cc.fillRect(0, 0, 4096, 4096);
                const dab = (i) => (ctx) => {
                    const x = 300 + i * 50, y = 400 + i * 40;
                    const rg = ctx.createRadialGradient(x, y, 0, x, y, 200);
                    rg.addColorStop(0, "rgba(255,255,255,0.8)"); rg.addColorStop(1, "rgba(255,255,255,0)");
                    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, y, 200, 0, Math.PI * 2); ctx.fill();
                };
                const runDabs = (p, flush) => {
                    const times = [];
                    for (let i = 0; i < 60; i++) {
                        const x = 300 + i * 50, y = 400 + i * 40, t0 = performance.now();
                        p.drawInto([x - 200, y - 200, x + 200, y + 200], dab(i));
                        if (flush) flush();
                        times.push(performance.now() - t0);
                    }
                    return { median: +median(times).toFixed(3), max: +Math.max(...times).toFixed(3) };
                };
                const lc = P.LayerPixels.fromCanvas(P.makeCanvas(4096, 4096));
                lc.drawInto(null, (ctx) => ctx.drawImage(content, 0, 0));
                out.dab_canvas_gpu_no_flush = runDabs(lc);
                out.dab_canvas_gpu_with_1px_read = runDabs(lc, () => lc.readRect(0, 0, 1, 1));
                const lt = T.TileLayerPixels.fromCanvas(content);
                out.dab_tiles = runDabs(lt);
                out.dab_tiles_count = lt.tileCount;
                P.canvasOf(lc).width = 1;
                content.width = 1;

                // fromImage of a 15000 x 10000 JPEG
                const small = new OffscreenCanvas(1500, 1000), sx = small.getContext("2d");
                const g2 = sx.createLinearGradient(0, 0, 1500, 1000); g2.addColorStop(0, "#f20"); g2.addColorStop(0.5, "#2c6"); g2.addColorStop(1, "#23f");
                sx.fillStyle = g2; sx.fillRect(0, 0, 1500, 1000);
                const big = new OffscreenCanvas(15000, 10000), bx = big.getContext("2d");
                bx.drawImage(small, 0, 0, 15000, 10000);
                for (let i = 0; i < 200; i++) { bx.fillStyle = `hsl(${i * 37},70%,50%)`; bx.fillRect((i * 733) % 15000, (i * 491) % 10000, 300, 200); }
                const blob = await big.convertToBlob({ type: "image/jpeg", quality: 0.9 });
                big.width = 1; big.height = 1;
                const img = new Image();
                await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = URL.createObjectURL(blob); });
                let t0 = performance.now();
                const ti = T.TileLayerPixels.fromImage(img);
                out.fromImage_15000x10000_tiles_ms = ms(t0);
                out.fromImage_tiles = { tiles: ti.tileCount, MB: +(ti.bytes() / 1048576).toFixed(1) };
                t0 = performance.now();
                const ci = P.LayerPixels.fromImage(img);
                ci.readRect(0, 0, 1, 1);
                out.fromImage_15000x10000_canvas_ms_with_1px_read = ms(t0);
                // a few rows compared (the canvas backend's full draw is on the GPU: information only)
                let n = 0, worst = 0;
                for (const y of [0, 4095, 5000, 9999]) {
                    const a = ci.readRect(0, y, 15000, 1).data, b = ti.readRect(0, y, 15000, 1).data;
                    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; worst = Math.max(worst, d); } }
                }
                out.fromImage_rows_gpu_vs_tiles = { bytes: n, worst };
                P.canvasOf(ci).width = 1;
                URL.revokeObjectURL(img.src);

                // clone of a full 6000 x 4000 layer
                const full = T.TileLayerPixels.fromImage(small, 6000, 4000);
                t0 = performance.now();
                const cl = full.clone();
                out.clone_6000x4000_tiles_ms = ms(t0);
                out.clone_tiles = { tiles: cl.tileCount, MB: +(cl.bytes() / 1048576).toFixed(1) };
                t0 = performance.now();
                cl.fill([100, 100, 101, 101], "#fff");
                out.clone_first_write_ms = ms(t0);
                const fc = P.LayerPixels.fromImage(small, 6000, 4000);
                t0 = performance.now();
                const fcl = fc.clone();
                fcl.readRect(0, 0, 1, 1);
                out.clone_6000x4000_canvas_ms_with_1px_read = ms(t0);
                P.canvasOf(fcl).width = 1; P.canvasOf(fc).width = 1;

                // a tile copied into another (4K aliasing: both buffers start on a page)
                const a1 = full.tileAt(3, 3).data, a2 = new Uint8ClampedArray(256 * 256 * 4);
                t0 = performance.now();
                for (let i = 0; i < 1000; i++) a2.set(a1);
                out.tile_copy_us = +((performance.now() - t0) * 1000 / 1000).toFixed(1);
                out.scratch = T.scratchStats();
            } finally {
                P.setPixelsOptions({ software: was.software });
            }
            return out;
        }],
    ];
}
