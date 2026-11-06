// Plain-Node checks of renderer/editor/keying.js (the Key screen's pure half, docs/PLAN_CORRIDORKEY.md §4.5-4.8): the box
// plan at 1k, 4k and 15k with and without a selection (the aspect growth, the context, inside the picture, the edge-only
// padding), reflect-101, the screen from the border ring, the matte's box, the bilinear rows (exact at a scale of 1,
// within a level when scaled, never a band seam), the queue's coalescing (ten hints in a burst: one run in flight, the
// last one pending), the settings fill and the texts.
//
//     node tools/keying_test.js
"use strict";

(async () => {
    const K = await import("../renderer/editor/keying.js");
    let fails = 0;
    const check = (name, ok, extra = "") => { console.log(`${ok ? "[ok]" : "[FAIL]"} ${name}${extra ? ": " + extra : ""}`); if (!ok) fails++; };
    const inside = (a, b) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];

    // ---- buckets ----
    const b1024 = K.bucketsFor(1024);
    check("buckets at 1,024: the square first, long side 1,024, short sides multiples of 128 from 512",
        b1024[0].w === 1024 && b1024[0].h === 1024 && b1024.every((b) => Math.max(b.w, b.h) === 1024 && Math.min(b.w, b.h) % 128 === 0 && Math.min(b.w, b.h) >= 512), JSON.stringify(b1024));
    check("buckets at 768 hold 768 x 384", K.bucketsFor(768).some((b) => b.w === 768 && b.h === 384));

    // ---- the box plan ----
    let bad = [];
    for (const [W, H] of [[1024, 768], [4000, 3000], [15000, 10000], [600, 400], [3000, 800]]) {
        const whole = K.boxPlan(W, H, null, { workingSize: 1024 });
        if (whole.box.join() !== [0, 0, W, H].join() || !whole.whole) bad.push(`whole ${W}x${H}`);
        const [, , cw, ch] = whole.content;
        if (cw > whole.bucket.w || ch > whole.bucket.h || (cw !== whole.bucket.w && ch !== whole.bucket.h)) bad.push(`fit ${W}x${H} ${cw}x${ch} in ${whole.bucket.w}x${whole.bucket.h}`);
        for (let i = 0; i < 60; i++) {
            const w = 1 + ((i * 7919) % Math.min(W, 3000)), h = 1 + ((i * 104729) % Math.min(H, 3000));
            const x = (i * 31337) % Math.max(1, W - w + 1), y = (i * 2718) % Math.max(1, H - h + 1);
            const sel = [x, y, x + w, y + h];
            const p = K.boxPlan(W, H, sel, { workingSize: 1024 });
            if (!inside(p.box, [0, 0, W, H])) bad.push(`outside ${W}x${H} ${p.box}`);
            if (!inside(sel, p.box)) bad.push(`selection not inside ${W}x${H} ${sel} ${p.box}`);
            const bw = p.box[2] - p.box[0], bh = p.box[3] - p.box[1];
            // the aspect is the bucket's unless the picture's edge cut the box (then it is padded, never stretched)
            const cutX = bw === W, cutY = bh === H;
            const ar = bw / bh, br = p.bucket.w / p.bucket.h;
            if (!cutX && !cutY && Math.abs(Math.log(ar / br)) > 0.02) bad.push(`aspect ${W}x${H} ${bw}x${bh} vs ${p.bucket.w}x${p.bucket.h}`);
            // context: at least half the selection's longer side more, or the picture's side
            const long = Math.max(w, h);
            if (bw < Math.min(W, w + long * 0.5) - 1 || bh < Math.min(H, h + long * 0.5) - 1) bad.push(`context ${W}x${H} sel ${w}x${h} box ${bw}x${bh}`);
            if (Math.max(bw, bh) < Math.min(768, Math.max(W, H)) - 1 && bw < W && bh < H) bad.push(`min side ${bw}x${bh}`);
            if (p.padded && !cutX && !cutY) bad.push(`padded without an edge ${W}x${H} ${p.box}`);
        }
    }
    check("box plan at 1k, 4k, 15k: inside the picture, holds the selection, the bucket's aspect, the context, padding only at an edge", !bad.length, bad.slice(0, 4).join("; "));
    const p15 = K.boxPlan(15000, 10000, [7000, 4000, 8000, 6000], { workingSize: 1024 });
    check("15k: a 1,000 x 2,000 selection keys a box of about 1,750 x 3,000 at a portrait bucket", p15.bucket.h === 1024 && p15.bucket.w < 1024 && p15.box[3] - p15.box[1] >= 3000, JSON.stringify(p15));
    const pl = K.boxPlan(4000, 3000, null, { workingSize: 1024, within: [100, 200, 1100, 1700] });
    check("within: a layer's rect is the box without a selection (the layer's box, not the whole picture)", pl.box.join() === "100,200,1100,1700" && !pl.whole && pl.layerBox, JSON.stringify(pl));
    // a set's own buckets at several sizes: only those of the working size's long side are picked from
    const mixed = [{ w: 512, h: 512 }, { w: 768, h: 512 }, { w: 512, h: 768 }, { w: 1024, h: 1024 }, { w: 1024, h: 640 }, { w: 640, h: 1024 }, { w: 1536, h: 864 }];
    const pm = K.boxPlan(3000, 2000, [600, 800, 1800, 1200], { workingSize: 1024, buckets: mixed });
    check("buckets: a set's list narrowed to the working size's long side", Math.max(pm.bucket.w, pm.bucket.h) === 1024 && pm.bucket.w === 1024 && pm.bucket.h === 640, JSON.stringify(pm.bucket));
    check("bucketsAt: none of that size falls back to bucketsFor", JSON.stringify(K.bucketsAt(768, [{ w: 1024, h: 1024 }])) === JSON.stringify(K.bucketsFor(768)));
    const edge = K.boxPlan(800, 300, [0, 0, 800, 300], { workingSize: 1024 });
    check("a box the picture leaves short is padded, not stretched", edge.padded && edge.box.join() === "0,0,800,300" && Math.abs(edge.sx - edge.sy) < 0.01, JSON.stringify(edge));

    // ---- reflect-101 and the pad ----
    check("reflect101", [-2, -1, 0, 1, 2, 3, 4, 5].map((i) => K.reflect101(i, 4)).join() === "2,1,0,1,2,3,2,1");
    const src = new Uint8Array([1, 2, 3, 4, 5, 6]);           // 3 x 2, one channel
    const pad = K.padRect(src, 3, 2, 5, 3, 1);
    check("padRect: reflect-101 to the right and below", Array.from(pad).join() === "1,2,3,2,1,4,5,6,5,4,1,2,3,2,1", Array.from(pad).join());
    check("padRect: nothing short is the same array", K.padRect(src, 3, 2, 3, 2, 1) === src);

    // ---- the screen ----
    const ring = (rgb, w = 40, h = 30) => { const a = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { a.set(rgb, i * 4); a[i * 4 + 3] = 255; } return a; };
    check("screen: a green border is green", K.screenFromRing(ring([20, 180, 40]), 40, 30, [0, 0, 40, 30]).screen === "green");
    check("screen: a blue border is blue", K.screenFromRing(ring([10, 40, 200]), 40, 30, [0, 0, 40, 30]).screen === "blue");
    check("screen: a grey border asks", K.screenFromRing(ring([120, 120, 120]), 40, 30, [0, 0, 40, 30]).screen === null);
    const hintAll = new Uint8Array(40 * 30).fill(255);
    check("screen: a hint over everything leaves no ring (asks)", K.screenFromRing(ring([20, 180, 40]), 40, 30, [0, 0, 40, 30], hintAll).screen === null);
    // a layer on blue whose transparent margins were read on the green fill: weighted by its alpha, blue
    {
        const w = 40, h = 30, img = ring([10, 40, 200], w, h), wt = new Uint8Array(w * h).fill(255);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 4 || x >= w - 4 || y < 3) { img.set(K.SCREEN_FILL.green, (y * w + x) * 4); wt[y * w + x] = 0; }
        check("screen: the fill is mostly green, unweighted", K.screenFromRing(img, w, h, [0, 0, w, h]).screen === "green");
        check("screen: weighted by the layer's alpha, the plate's blue", K.screenFromRing(img, w, h, [0, 0, w, h], null, wt).screen === "blue");
        check("screen: nothing opaque on the ring asks", K.screenFromRing(img, w, h, [0, 0, w, h], null, new Uint8Array(w * h)).screen === null);
    }
    const ov = K.overColour(new Uint8Array([200, 0, 0, 255, 200, 0, 0, 0, 200, 100, 0, 128]), 3, [0, 71, 187]);
    check("overColour: opaque kept, transparent the fill, half between", Array.from(ov).join() === "200,0,0,255,0,71,187,255,100,86,93,255", Array.from(ov).join());

    // ---- the matte's box and the rows ----
    const bw = 64, bh = 48;
    const alpha = new Float32Array(bw * bh);
    for (let y = 10; y < 20; y++) for (let x = 20; x < 30; x++) alpha[y * bw + x] = 1;
    const mb = K.matteBox(alpha, bw, bh, [0, 0, bw, bh], [100, 200, 164, 248]);
    check("matteBox: the alpha's box grown by a bucket pixel and 2 px", mb && mb.join() === [100 + 20 - 1 - 2, 200 + 10 - 1 - 2, 100 + 30 + 1 + 2, 200 + 20 + 1 + 2].join(), JSON.stringify(mb));
    check("matteBox: nothing kept is null", K.matteBox(new Float32Array(bw * bh), bw, bh, [0, 0, bw, bh], [0, 0, bw, bh]) === null);
    // scale 1: exact
    const fg = new Uint8Array(bw * bh * 3);
    for (let i = 0; i < bw * bh; i++) { fg[i * 3] = i % 251; fg[i * 3 + 1] = (i * 7) % 253; fg[i * 3 + 2] = (i * 13) % 241; }
    const soft = new Float32Array(bw * bh);
    for (let i = 0; i < bw * bh; i++) soft[i] = ((i * 37) % 256) / 255;
    const box = [100, 200, 164, 248];
    const mbox = [110, 205, 150, 240];
    const map = K.sampleMap(mbox, box, [0, 0, bw, bh]);
    const lw = mbox[2] - mbox[0], lh = mbox[3] - mbox[1];
    const all = K.bilinearRows(soft, fg, bw, map, lw, 0, lh);
    let ex = 0;
    for (let Y = 0; Y < lh; Y++) for (let X = 0; X < lw; X++) {
        const u = X + 10, v = Y + 5, i = v * bw + u, o = Y * lw + X;
        if (all.a[o] !== K.toLevel(soft[i]) || all.rgba[o * 4] !== fg[i * 3] || all.rgba[o * 4 + 1] !== fg[i * 3 + 1] || all.rgba[o * 4 + 2] !== fg[i * 3 + 2] || all.rgba[o * 4 + 3] !== 255) ex++;
    }
    check("bilinearRows at a scale of 1: every byte the bucket's", ex === 0, `${ex} off`);
    // bands give the same bytes as one pass (no seam)
    let seam = 0;
    for (let y0 = 0; y0 < lh; y0 += 7) {
        const rows = Math.min(7, lh - y0);
        const b = K.bilinearRows(soft, fg, bw, map, lw, y0, rows);
        for (let k = 0; k < lw * rows; k++) if (b.a[k] !== all.a[y0 * lw + k]) seam++;
    }
    check("bilinearRows in bands of 7: the same bytes as one pass", seam === 0, `${seam} off`);
    // scaled: a smooth ramp sampled at 3.3x stays within a level of the exact ramp
    const rw = 32, rh = 8;
    const ramp = new Float32Array(rw * rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) ramp[y * rw + x] = x / (rw - 1);
    const rbox = [0, 0, Math.round(rw * 3.3), Math.round(rh * 3.3)];
    const rmap = K.sampleMap(rbox, rbox, [0, 0, rw, rh]);
    const up = K.bilinearRows(ramp, null, rw, rmap, rbox[2], 0, rbox[3]);
    let worst = 0;
    for (let X = 0; X < rbox[2]; X++) {
        const u = Math.min(rw - 1, Math.max(0, (X + 0.5) * (rw / rbox[2]) - 0.5));
        worst = Math.max(worst, Math.abs(up.a[X] - Math.round((u / (rw - 1)) * 255)));
    }
    check("bilinearRows scaled 3.3x: a ramp within a level", worst <= 1, `worst ${worst}`);
    check("keptShare", Math.abs(K.keptShare(alpha, bw, [0, 0, bw, bh]) - (100 * 100) / (bw * bh)) < 1e-6);
    check("alphaFloats reads u16 as 0..65535", K.alphaFloats(new Uint16Array([0, 65535]))[1] === 1);

    // ---- the rows client in the thread (no Worker under Node) ----
    const rc = new K.RowsClient();
    await rc.matte("t", soft, fg, bw, bh);
    const viaClient = await rc.rows("t", map, lw, 0, lh);
    let cd = 0;
    for (let k = 0; k < lw * lh; k++) if (viaClient.a[k] !== all.a[k]) cd++;
    check("RowsClient without a worker: the same rows, in the thread", cd === 0 && rc.inThread, `${cd} off`);
    rc.drop("t");

    // ---- the refine of a scaled matte through the rows client (I6; the same steps keyworker.js runs) ----
    {
        const KM = await import("../renderer/editor/keymatte.js");
        // a 96 x 64 bucket of a 288 x 192 box (3x): a skin-tone disc on green, sharp at full resolution, soft in the matte
        const aw = 96, ah = 64, F = 3, W = aw * F, H = ah * F, R = 20 * F, cx = W / 2, cy = H / 2;
        const big = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const inD = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < R, o = (y * W + x) * 4;
            big.set(inD ? [222, 170, 140, 255] : [0, 177, 64, 255], o);
        }
        const small = new Uint8Array(aw * ah * 4), alphaS = new Float32Array(aw * ah);
        for (let v = 0; v < ah; v++) for (let u = 0; u < aw; u++) {
            for (let c = 0; c < 4; c++) {
                let s = 0;
                for (let j = 0; j < F; j++) for (let i = 0; i < F; i++) s += big[((v * F + j) * W + u * F + i) * 4 + c];
                small[(v * aw + u) * 4 + c] = Math.round(s / (F * F));
            }
            alphaS[v * aw + u] = Math.min(1, Math.max(0, (20 - Math.hypot(u + 0.5 - aw / 2, v + 0.5 - ah / 2)) / 3 + 0.5));
        }
        const out = { x: 30, y: 20, w: W - 60, h: H - 40 };
        const read = (b) => {
            const rows = b[3] - b[1], o = new Uint8Array(out.w * rows * 4);
            for (let y = 0; y < rows; y++) o.set(big.subarray(((out.y + b[1] + y) * W + out.x) * 4, ((out.y + b[1] + y) * W + out.x + out.w) * 4), y * out.w * 4);
            return o;
        };
        const opts = { small: { data: small, width: aw, height: ah }, src: { x: 0, y: 0, w: aw, h: ah }, full: { w: W, h: H }, out };
        const want = await KM.refineMatte({ ...opts, alpha: alphaS, aw, ah, read });
        const rr = new K.RowsClient();
        await rr.matte("r", alphaS, null, aw, ah);
        const info = await rr.refine("r", opts);
        const note = await rr.refineSample("r", read([0, info.sample[0], out.w, info.sample[1]]));
        const got = new Uint8Array(out.w * out.h);
        for (const band of KM.bandPlan(out.w, out.h, { halo: info.halo, bandRows: 24 })) {
            const { a } = await rr.refineBand("r", band, read([0, band.ry0, out.w, band.ry1]));
            got.set(a, band.y0 * out.w);
        }
        rr.drop("r");
        let off = 0;
        for (let k = 0; k < got.length; k++) if (got[k] !== want.alpha[k]) off++;
        check("the refine through RowsClient in bands of 24 rows: refineMatte's bytes exactly", off === 0 && note.fallback === null && rr.inThread, `${off} off, fallback ${note.fallback}`);
        // against the true (sharp) disc: the refined matte nearer than the bilinear one
        const lin = K.bilinearRows(alphaS, null, aw, K.sampleMap([out.x, out.y, out.x + out.w, out.y + out.h], [0, 0, W, H], [0, 0, aw, ah]), out.w, 0, out.h).a;
        let eR = 0, eB = 0;
        for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) {
            const t = Math.hypot(out.x + x + 0.5 - cx, out.y + y + 0.5 - cy) < R ? 255 : 0, k = y * out.w + x;
            eR += Math.abs(got[k] - t); eB += Math.abs(lin[k] - t);
        }
        check("the refined matte follows the sharp edge closer than the bilinear one", eR < eB * 0.6, `refined ${(eR / got.length).toFixed(2)} bilinear ${(eB / got.length).toFixed(2)} levels`);
        // a read that is not the bucket's picture: the bilinear matte, said
        const rr2 = new K.RowsClient();
        await rr2.matte("f", alphaS, null, aw, ah);
        const i2 = await rr2.refine("f", opts);
        const dark = read([0, i2.sample[0], out.w, i2.sample[1]]).map((v, k) => (k % 4 === 3 ? v : Math.round(v * 0.6)));
        const n2 = await rr2.refineSample("f", dark);
        check("a read that is not the bucket's picture falls back, said", typeof n2.fallback === "string" && n2.fallback.length > 0, String(n2.guideDiff));
        rr2.drop("f");
        check("isScaled: a 3x box, not a box at its own size", K.isScaled({ box: [0, 0, W, H], content: [0, 0, aw, ah] }) && !K.isScaled({ box: [5, 5, 101, 69], content: [0, 0, 96, 64] }));
    }

    // ---- the queue ----
    {
        let release = null, running = 0, maxRunning = 0;
        const seen = [];
        const q = new K.KeyQueue(async (req) => {
            running++; maxRunning = Math.max(maxRunning, running);
            seen.push(req.n);
            await new Promise((r) => { release = r; });
            running--;
            return { n: req.n };
        });
        const ps = [];
        for (let n = 1; n <= 10; n++) ps.push(q.submit({ n }));
        await new Promise((r) => setTimeout(r, 5));
        const st = q.state;
        check("queue: ten hints in a burst give one run in flight and the last one pending", st.flying === 1 && st.pending === 10 && q.runs === 1, JSON.stringify(st));
        release();
        await new Promise((r) => setTimeout(r, 5));
        release();
        const res = await Promise.all(ps);
        check("queue: the first and the last ran, the eight between were dropped", seen.join() === "1,10" && res.filter((r) => r.dropped).length === 8 && q.dropped === 8, seen.join());
        check("queue: the first answer is stale, the last is not", res[0].stale === true && res[9].stale === false && res[9].ticket === 10);
        check("queue: never two runs at once", maxRunning === 1);
        const q2 = new K.KeyQueue(async () => ({}));
        const a = q2.submit({}), b = q2.submit({});
        check("queue: cancelPending drops the waiting one", q2.cancelPending() && (await b).dropped === true && !(await a).dropped);
        await q2.idle();
        check("queue: idle", q2.state.flying === null && q2.state.pending === null);
        // a pinned request (Key's final run) is never replaced by a preview asked while it waits
        let go = null;
        const ran = [];
        const q3 = new K.KeyQueue(async (req) => { ran.push(req.n); if (req.n === 1) await new Promise((r) => { go = r; }); return { n: req.n }; });
        const f1 = q3.submit({ n: 1 });
        const fin = q3.submit({ n: 2 }, { pinned: true });
        const late = q3.submit({ n: 3 });
        check("queue: a preview while the final waits is dropped at once", (await late).dropped === true && q3.state.pending === 2);
        check("queue: cancelPending keeps a pinned final", q3.cancelPending() === false && q3.state.pending === 2);
        await new Promise((r) => setTimeout(r, 5));
        go();
        const fr = await fin;
        await f1;
        check("queue: the pinned final ran and is the newest", !fr.dropped && fr.n === 2 && fr.stale === false && ran.join() === "1,2", JSON.stringify({ fr, ran }));
    }
    check("isFeaturesGone: by the code or the message", K.isFeaturesGone(Object.assign(new Error("x"), { code: K.FEATURES_GONE })) && K.isFeaturesGone(new Error("Error invoking remote method 'helpers:keyRun': " + K.FEATURES_GONE + " k")) && !K.isFeaturesGone(new Error("other")));

    // ---- settings and texts ----
    const fv = K.fillValues({ screen: "blue", trust: 0.75, despill: 2, workingSize: 768, preview: false });
    check("fillValues: kept what fits, a bad despill falls back", fv.screen === "blue" && fv.trust === 0.75 && fv.despill === 0.5 && fv.workingSize === 768 && fv.preview === false && fv.greyUnderBase === true, JSON.stringify(fv));
    check("fillValues of nothing is the defaults", JSON.stringify(K.fillValues(null)) === JSON.stringify(K.keyDefaults));
    check("trustOf picks the nearest", K.trustOf(0.9).id === "clean" && K.trustOf("x").id === "rough");
    const sup0 = K.engineSupport({ installed: false });
    check("engineSupport: no engine in the build", !sup0.ok && sup0.offered === false && sup0.text.includes(K.LABEL));
    check("engineSupport: not offered", K.engineSupport({ installed: true, offered: false }).text === K.TEXTS.notOffered);
    check("engineSupport: not downloaded is a warning naming the set's size", K.engineSupport({ installed: true, offered: true, present: false }).kind === "warn" && K.TEXTS.notDownloaded.includes("2.4 GB"));
    const cpu = K.engineSupport({ installed: true, offered: true, present: true, provider: "cpu", cpuSeconds: 41.6 });
    check("engineSupport: the CPU with its cost", cpu.ok && cpu.cpu && cpu.text.includes("about 42 s"), cpu.text);
    check("engineSupport: an error names the provider's error", K.engineSupport({ installed: true, offered: true, present: true, error: "no adapter" }).text.includes("(no adapter)"));
    const line = K.statusLine({ kept: 38.2, seconds: 2.43, provider: "dml", screen: "green", hint: "selection", trust: 0.5, keyedAt: 1024, grey: true });
    check("statusLine", line === "Key: 38 % of the box kept, in 2.4 s in Scumble (CorridorKey 2.0 on DirectML, green screen, hint from the selection (rough); keyed at 1,024 px). A grey layer sits under the Key layer: replace it with your background.", line);
    check("boxLine carries the box and the bucket", K.boxLine({ box: [0, 0, 3210, 4100], content: [0, 0, 802, 1024], whole: false }) === "the selection's box, 3,210 × 4,100, keyed at 802 × 1,024");
    check("boxLine: a layer's box", K.boxLine({ box: [10, 20, 1010, 1520], content: [0, 0, 683, 1024], whole: false, layerBox: true }).startsWith("the layer's box, 1,000 × 1,500"));
    check("boxLine: a Re-key says what it reads", K.boxLine({ box: [0, 0, 512, 512], content: [0, 0, 512, 512], rekey: true, from: "Subject (hidden)" }).endsWith(", read from Subject (hidden)"));
    const tp = K.termsParagraph({ gb: 2.43, host: "Hugging Face" });
    check("termsParagraph: the four parts, their licences, the size, the host, the seat clause", ["Corridor Key Licence 2.0", "C-RADIOv4 (NVIDIA Open Model License)", "MoGe-2 (MIT)", "RVM (Google DeepMind, CC BY 4.0)", "about 2.4 GB", "downloaded from Hugging Face", "US $20M"].every((s) => tp.includes(s)), tp);
    check("readyLine", K.readyLine("dml", 1024) === "CorridorKey 2.0 in Scumble on DirectML, working size 1,024 px.");

    console.log(fails ? `FAIL (${fails})` : "PASS");
    process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
