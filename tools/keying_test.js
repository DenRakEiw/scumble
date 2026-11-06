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

    // ---- Route B: your ComfyUI with a node pack (§4.11, B1) ----
    const fs = require("fs"), path = require("path");
    const ROOT = path.join(__dirname, "..");
    const { specProblems } = require("./node_specs.js");
    // the node list: pack A's 17 classes as I0a saved them (c7662de), core's ImageToMask and PreviewImage from the
    // fixtures' list, InpaintCanvasLoadRef as the node's nodes.py declares it, pack B's CorridorKey2 as its nodes.py
    // declares it at 141c31b (never installed: hand-copied here, the entry stays unverified)
    const refsDir = path.join(ROOT, "tools", "refs", "corridorkey");
    const packA = {};
    for (const f of fs.readdirSync(refsDir)) Object.assign(packA, JSON.parse(fs.readFileSync(path.join(refsDir, f), "utf8")));
    const core = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs", "comfy_templates", "object_info.json"), "utf8"));
    const base = {
        ImageToMask: core.ImageToMask, PreviewImage: core.PreviewImage, InpaintCanvas: { input: { required: {} } },
        InpaintCanvasLoadRef: { input: { required: { ref: ["STRING", { default: "", multiline: false }] } } },
    };
    const f01 = (d) => ["FLOAT", { default: d, min: 0.0, max: 1.0, step: 0.01 }];
    const packB = {
        CorridorKey2: {
            input: {
                required: {
                    image: ["IMAGE", {}], gamma_space: [["sRGB", "Linear"], {}], hint_quality: f01(0.95), carry_hint: ["BOOLEAN", { default: true }],
                    carry_hint_quality: f01(0.95), despill_strength: f01(0.5), window: [["auto", "80/40", "48/24", "24/12", "8/4", "4/2", "2/1", "1/1"], { default: "auto" }],
                    low_vram: ["BOOLEAN", { default: false }], unload_other_models: ["BOOLEAN", { default: true }],
                },
                optional: { mask: ["MASK", {}] },
            },
            output: ["IMAGE", "MASK", "IMAGE", "IMAGE", "IMAGE"], output_name: ["fg", "matte", "processed", "QC", "cutout"],
        },
    };
    const infoA = { ...base, ...packA }, infoB = { ...base, ...packB };
    check("the saved spec: pack A's loader and keyer are there, and Basic's slot 2 is `rgba`", !!packA.CorridorKey2ModelLoader && packA.CorridorKey2Basic.output_name[2] === "rgba" && K.PACKS[0].output[1] === 2);

    // settings: DEFAULTS.key in main is keyDefaults (read from the file: settings.js needs Electron's app)
    const settingsSrc = fs.readFileSync(path.join(ROOT, "electron", "main", "settings.js"), "utf8");
    const keyLine = /^\s*key: (\{[^\n]*\}),\s*$/m.exec(settingsSrc);
    const mainKey = keyLine ? Function(`"use strict"; return (${keyLine[1]});`)() : null;
    check("settings.js DEFAULTS.key is keying.keyDefaults (the cap 16, keep on GPU and evicts off, the ComfyUI wait)", JSON.stringify(mainKey) === JSON.stringify(K.keyDefaults) && K.keyDefaults.cap === 16 && K.keyDefaults.keepOnGpu === false && K.keyDefaults.evicts === false && K.keyDefaults.comfyTimeout === 300, JSON.stringify(mainKey));
    const fb = K.fillValues({ cap: 0.5, keepOnGpu: "yes", evicts: true, comfyTimeout: 10 });
    const fk = K.fillValues({ cap: 8, keepOnGpu: true, comfyTimeout: 900 });
    check("fillValues: Route B's keys kept when they fit, else the defaults", fb.cap === 16 && fb.keepOnGpu === false && fb.evicts === true && fb.comfyTimeout === 300 && fk.cap === 8 && fk.keepOnGpu === true && fk.comfyTimeout === 900 && fk.evicts === false, JSON.stringify({ fb, fk }));

    // the pack present
    check("packFor: pack A's classes, B's, both (A first), none, no list", K.packFor(infoA).id === "marawan206" && K.packFor(infoB).id === "hashu786" && K.packFor({ ...infoA, ...packB }).id === "marawan206" && K.packFor(base) === null && K.packFor(null) === null);
    check("packFor: one of pack A's two classes alone is no pack", K.packFor({ ...base, CorridorKey2Basic: packA.CorridorKey2Basic }) === null);
    check("isPackNode", K.isPackNode("CorridorKey2ModelLoader") && K.isPackNode("CorridorKey2") && !K.isPackNode("CorridorKey2Despill") && !K.isPackNode("PreviewImage"));

    // the trust mapping: by the number, never by the name
    const hq = packA.CorridorKey2Basic.input.required.hint_quality;
    const mapped = K.TRUSTS.map((t) => K.trustOption(hq, t.value));
    check("trustOption: Rough 0.5 -> loose hint, Automatic 0.75 -> rough matte, Clean 0.95 -> clean matte", mapped.join("|") === "loose hint (0.5)|rough matte (0.75)|clean matte (0.95)", mapped.join("|"));
    const reordered = ["COMBO", { default: "b (0.75)", options: ["c (0.5)", "a (0.95)", "b (0.75)"] }];
    check("trustOption: an option list in another order still maps by the number", K.trustOption(reordered, 0.95) === "a (0.95)" && K.trustOption(reordered, 0.5) === "c (0.5)");
    check("trustOption: no option carries the number: the spec's default", K.trustOption(["COMBO", { default: "medium", options: ["low", "medium", "high"] }], 0.75) === "medium" && K.trustOption([["low", "high"], {}], 0.75) === "low");
    check("trustOption: no spec: the fallback's texts, else the number; a FLOAT clamped", K.trustOption(null, 0.75, ["x (0.95)", "y (0.75)"]) === "y (0.75)" && K.trustOption(null, 0.5) === 0.5 && K.trustOption(f01(0.95), 0.75) === 0.75 && K.trustOption(["FLOAT", { min: 0.6, max: 1 }], 0.5) === 0.6);

    // the graph for every input combination, against the saved spec
    const pic = { filename: "ck_box.png", subfolder: "scumble_key", type: "input" }, hintRef = { filename: "ck_hint.png", subfolder: "scumble_key", type: "input" };
    const combos = [];
    for (const hasHint of [true, false]) for (const screen of ["green", "blue"]) for (const t of K.TRUSTS) for (const keepOnGpu of [false, true]) for (const evicts of [false, true]) {
        combos.push({ hasHint, values: { screen, trust: t.value, despill: screen === "blue" ? 0.3 : 0.5, keepOnGpu, evicts } });
    }
    const problemsA = [], shapeA = [];
    for (const c of combos) {
        const refs = { picture: pic, ...(c.hasHint ? { hint: hintRef } : {}) };
        const g = K.keyPrompt("marawan206", refs, c.values, infoA);
        problemsA.push(...specProblems(g, infoA).map((p) => `${JSON.stringify(c)} ${p}`));
        const bare = K.keyPrompt("marawan206", refs, c.values, null);
        const ids = Object.keys(g).join();
        const want = c.hasHint ? "ck_in,ck_hint_img,ck_hint,ck_model,ck_key,ck_out" : "ck_in,ck_model,ck_key,ck_out";
        const k = g.ck_key.inputs, m = g.ck_model.inputs;
        const ok = ids === want && JSON.stringify(bare) === JSON.stringify(g)
            && m.auto_download === false && m.keep_on_gpu === c.values.keepOnGpu && m.weights === "corridorkey_v2.safetensors"
            && k.screen === c.values.screen && k.despill === c.values.despill && k.invert_hint === false
            && k.hint_quality === K.trustOption(hq, c.values.trust)
            && (c.hasHint ? JSON.stringify(k.alpha_hint) === '["ck_hint",0]' && g.ck_hint.inputs.channel === "red" && JSON.parse(g.ck_hint_img.inputs.ref).filename === "ck_hint.png" : !("alpha_hint" in k))
            && JSON.stringify(g[K.COMFY_OUTPUT]) === '{"class_type":"PreviewImage","inputs":{"images":["ck_key",2]}}'
            && JSON.stringify(JSON.parse(g.ck_in.inputs.ref)) === JSON.stringify(pic);
        if (!ok) shapeA.push(JSON.stringify(c));
    }
    check(`pack A: the graph of all ${combos.length} input combinations validates against tools/refs/corridorkey/`, !problemsA.length, problemsA.slice(0, 3).join("; "));
    check("pack A: six nodes with a hint, four without; auto_download false always; the trust, screen, despill, keep on GPU as given; PreviewImage on rgba; the same graph with and without the node list", !shapeA.length, shapeA.slice(0, 2).join("; "));
    const problemsB = [], shapeB = [];
    for (const c of combos) {
        const g = K.keyPrompt("hashu786", { picture: pic, ...(c.hasHint ? { hint: hintRef } : {}) }, c.values, infoB);
        problemsB.push(...specProblems(g, infoB).map((p) => `${JSON.stringify(c)} ${p}`));
        const k = g.ck_key.inputs;
        const ok = Object.keys(g).join() === (c.hasHint ? "ck_in,ck_hint_img,ck_hint,ck_key,ck_out" : "ck_in,ck_key,ck_out")
            && k.hint_quality === c.values.trust && k.window === "1/1" && k.unload_other_models === c.values.evicts && k.gamma_space === "sRGB"
            && k.despill_strength === (c.values.screen === "blue" ? 0 : c.values.despill) && (c.hasHint ? JSON.stringify(k.mask) === '["ck_hint",0]' : !("mask" in k))
            && JSON.stringify(g.ck_out.inputs.images) === '["ck_key",4]';
        if (!ok) shapeB.push(JSON.stringify(c));
    }
    check(`pack B (from its source, unverified): all ${combos.length} combinations validate against its declared spec`, !problemsB.length, problemsB.slice(0, 3).join("; "));
    check("pack B: window 1/1, unload_other_models from evicts, no despill on blue (green-only), cutout on slot 4", !shapeB.length && !K.PACKS[1].verified && K.PACKS[1].output[1] === 4, shapeB.slice(0, 2).join("; "));
    check("despillNote: pack B on blue says so, pack A and green say nothing", /despills green screens only/.test(K.despillNote("hashu786", "blue")) && K.despillNote("hashu786", "green") === "" && K.despillNote("marawan206", "blue") === "");
    const snap = K.keyPrompt("marawan206", { picture: pic }, { screen: "green", trust: 0.9, despill: 7 }, infoA).ck_key.inputs;
    check("keyPrompt: a trust between presets snaps to the nearest (0.9 -> clean matte), a despill past 1 to 1", snap.hint_quality === "clean matte (0.95)" && snap.despill === 1, JSON.stringify(snap));
    let threw = [];
    for (const [what, fn] of [["auto screen", () => K.keyPrompt("marawan206", { picture: pic }, { screen: "auto" }, infoA)], ["no picture", () => K.keyPrompt("marawan206", {}, { screen: "green" }, infoA)], ["unknown pack", () => K.keyPrompt("nope", { picture: pic }, { screen: "green" }, infoA)]]) {
        try { fn(); } catch (err) { if (String(err.message).startsWith(K.LABEL)) threw.push(what); }
    }
    check("keyPrompt refuses an Auto screen (resolved before), no picture, an unknown pack", threw.length === 3, threw.join());

    // withSpecDefaults: a pack that adds required inputs later still validates
    const grown = JSON.parse(JSON.stringify(infoA));
    Object.assign(grown.CorridorKey2Basic.input.required, { matte_mode: ["COMBO", { default: "fine", options: ["fast", "fine"] }], refine_steps: ["INT", { default: 3, min: 0, max: 8 }], tag: [["one", "two"], {}], guide: ["IMAGE", {}] });
    Object.assign(grown.CorridorKey2ModelLoader.input.required, { precision: ["COMBO", { options: ["bf16", "fp32"] }] });
    const gg = K.keyPrompt("marawan206", { picture: pic }, { screen: "green", trust: 0.5, despill: 0.5 }, grown);
    const gp = specProblems(gg, grown);
    check("withSpecDefaults: new required inputs get the spec's default or first option, a new socket is left alone", gg.ck_key.inputs.matte_mode === "fine" && gg.ck_key.inputs.refine_steps === 3 && gg.ck_key.inputs.tag === "one" && gg.ck_model.inputs.precision === "bf16" && !("guide" in gg.ck_key.inputs) && gp.length === 1 && /guide missing/.test(gp[0]), JSON.stringify(gp));
    const kept = K.withSpecDefaults({ n: { class_type: "CorridorKey2Basic", inputs: { hint_quality: "rough matte (0.75)" } } }, infoA);
    check("withSpecDefaults: what the builder gave stays, an unknown class is not touched", kept.n.inputs.hint_quality === "rough matte (0.75)" && kept.n.inputs.despill === 0.5 && kept.n.inputs.screen === "green" && JSON.stringify(K.withSpecDefaults({ x: { class_type: "Nope", inputs: {} } }, infoA).x.inputs) === "{}");

    // the cap: the box native up to 16 MP (2^20 px each) and 8,192 a side, else one factor below both
    const fits = (f, cap) => f.w * f.h <= K.capPixels(cap) && Math.max(f.w, f.h) <= K.COMFY_LONG;
    const f16 = K.comfyFit(4096, 4096), f17 = K.comfyFit(4097, 4096), f15k = K.comfyFit(15000, 10000), fl = K.comfyFit(9000, 100), f64 = K.comfyFit(8192, 8192, 64), f1 = K.comfyFit(1, 1, 1);
    check("comfyFit: 4,096 x 4,096 goes at its own size under the 16 MP default (I0a's 16 MP row)", !f16.scaled && f16.w === 4096 && f16.h === 4096 && K.capPixels() === 4096 * 4096);
    check("comfyFit: just above the cap, a 15k box and a long strip are scaled by one factor below the cap and 8,192", f17.scaled && fits(f17) && fits(f15k) && Math.abs(f15k.w / f15k.h - 1.5) < 0.002 && f15k.w * f15k.h > 0.999 * K.capPixels() && fl.scaled && fl.w === 8192 && fl.h === 91, JSON.stringify({ f17, f15k, fl }));
    check("comfyFit: the cap 64 is 8,192 squared; a 1 px box; capPixels clamps to 1-64", !f64.scaled && !f1.scaled && K.capPixels(500) === 64 * K.MP && K.capPixels(0) === K.MP && K.capPixels("x") === 16 * K.MP);

    // the box on your ComfyUI (B2): the selection grown by half its longer side, at least 768 a side, no bucket's aspect
    const cpw = K.comfyPlan(1536, 1024, null);
    check("comfyPlan: no selection is the whole picture at its own size, the plan's shape (content = what goes, nothing padded)", cpw.whole && cpw.box.join() === "0,0,1536,1024" && cpw.bucket.w === 1536 && cpw.bucket.h === 1024 && cpw.content.join() === "0,0,1536,1024" && !cpw.scaled && !cpw.padded && cpw.route === "comfyui" && cpw.sx === 1 && cpw.sy === 1, JSON.stringify(cpw));
    const cps = K.comfyPlan(4000, 3000, [1000, 1000, 1200, 1100]);
    check("comfyPlan: a small selection grows to 768 a side, centred on it", cps.box.join() === `${1100 - 384},${1050 - 384},${1100 + 384},${1050 + 384}` && !cps.scaled && !cps.whole && !cps.layerBox, JSON.stringify(cps.box));
    const cpl = K.comfyPlan(4000, 3000, [500, 400, 2500, 1400]);
    check("comfyPlan: a large selection grows by half its longer side (3,000 x 2,000), no aspect step", cpl.box[2] - cpl.box[0] === 3000 && cpl.box[3] - cpl.box[1] === 2000 && inside(cpl.box, [0, 0, 4000, 3000]), JSON.stringify(cpl.box));
    let cpBad = [];
    for (let i = 0; i < 200; i++) {
        const W = 600 + ((i * 7919) % 15000), H = 400 + ((i * 104729) % 10000);
        const x0 = (i * 31) % W, y0 = (i * 57) % H, x1 = Math.min(W, x0 + 1 + ((i * 131) % 3000)), y1 = Math.min(H, y0 + 1 + ((i * 173) % 3000));
        const p = K.comfyPlan(W, H, [x0, y0, x1, y1]);
        const [bx0, by0, bx1, by1] = p.box;
        if (!inside(p.box, [0, 0, W, H]) || !inside([x0, y0, x1, y1], p.box)) cpBad.push(`${W}x${H} [${x0},${y0},${x1},${y1}] -> ${p.box}`);
        if (bx1 - bx0 < Math.min(W, 768) || by1 - by0 < Math.min(H, 768)) cpBad.push(`small ${p.box}`);
        if (p.bucket.w * p.bucket.h > K.capPixels() || (p.scaled !== (p.bucket.w !== bx1 - bx0 || p.bucket.h !== by1 - by0))) cpBad.push(`cap ${JSON.stringify(p.bucket)} ${p.box}`);
    }
    check("comfyPlan: 200 selections on pictures up to 15k: inside the picture, holding the selection, at least 768 a side, under the cap", !cpBad.length, cpBad.slice(0, 3).join("; "));
    const cpb = K.comfyPlan(15000, 10000, null);
    check("comfyPlan: a 15k whole picture goes scaled by one factor under the cap", cpb.scaled && cpb.bucket.w * cpb.bucket.h <= K.capPixels() && Math.abs(cpb.bucket.w / cpb.bucket.h - 1.5) < 0.002 && cpb.content[2] === cpb.bucket.w && K.isScaled(cpb), JSON.stringify(cpb.bucket));
    const cpi = K.comfyPlan(2000, 1500, null, { within: [100.4, 50, 900.2, 1700] });
    const cpf = K.comfyPlan(512, 400, null, { fit: (w, h) => ({ w: w / 2, h: h / 2, scaled: true }) });
    check("comfyPlan: a layer's rect cut to the picture; the fit given (the gate's seam)", cpi.layerBox && cpi.box.join() === "100,50,901,1500" && cpf.bucket.w === 256 && cpf.bucket.h === 200 && cpf.scaled && Math.abs(cpf.sx - 0.5) < 1e-9, JSON.stringify([cpi.box, cpf.bucket]));
    check("comfyBoxLine: the box, at its own size or sent at the cap's size", K.comfyBoxLine(cpw) === "the whole picture, 1,536 × 1,024, at its own size" && K.comfyBoxLine({ ...cpb, from: "the picture under the key", rekey: true }) === `the key layer's box, 15,000 × 10,000, sent at ${K.fmtInt(cpb.bucket.w)} × ${K.fmtInt(cpb.bucket.h)} (the cap) and scaled back, read from the picture under the key`, K.comfyBoxLine(cpb));
    const sl1 = K.comfyStatusLine({ kept: 38.2, seconds: 11.46, pack: "marawan206", gpu: "NVIDIA GeForce RTX 5090", screen: "green", hint: "selection", trust: 0.5, sent: [512, 400], box: [512, 400], grey: true });
    check("comfyStatusLine: on your ComfyUI through the pack on its card, at its own size, the grey layer", sl1 === "Key: 38 % of the box kept, in 11 s on your ComfyUI (CorridorKey 2.0 through ComfyUI-CorridorKey2.0 on NVIDIA GeForce RTX 5090, green screen, hint from the selection (rough); at its own size, 512 × 400). A grey layer sits under the Key layer: replace it with your background.", sl1);
    const sl2 = K.comfyStatusLine({ kept: 5.04, seconds: 2.33, pack: "hashu786", screen: "blue", hint: "none", trust: -1, sent: [4096, 2731], box: [15000, 10000], hidden: "Subject", rekey: true });
    check("comfyStatusLine: scaled back, a hidden source, pack B's despill note on blue, never \"refined\"", sl2.startsWith("Re-key: 5 % of the box kept, in 2.3 s on your ComfyUI (CorridorKey 2.0 through ComfyUI-CorridorKey2, blue screen, no hint; keyed at 4,096 × 2,731 of its 15,000 × 10,000 and scaled back). Subject is hidden;") && sl2.endsWith("despills green screens only, so the blue screen's spill stays on the subject.") && !/refined/.test(sl2), sl2);
    check("COMFY_COST: B0's reload in the dialog's words", /about 10 s more/.test(K.COMFY_COST) && /4\.7 GB/.test(K.COMFY_COST));

    // readiness on your ComfyUI
    const R5090 = ["cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync"];
    const sNo = K.serverSupport({ state: "disconnected" });
    check("serverSupport: not connected: info, the whole need in one sentence", !sNo.ok && sNo.kind === "info" && sNo.show === "hidden" && sNo.reason === "Full resolution on your ComfyUI needs your own ComfyUI with an RTX 30, 40 or 50 card and a CorridorKey 2.0 node pack: connect it under Settings › ComfyUI.", sNo.reason);
    const sOld = K.serverSupport({ state: "connected", gpus: ["cuda:0 NVIDIA GeForce GTX 1080 Ti : cudaMallocAsync"], objectInfo: infoA });
    check("serverSupport: CUDA devices, none RTX 30 or later: a warning naming the card", !sOld.ok && sOld.kind === "warn" && sOld.reason.includes("it shows NVIDIA GeForce GTX 1080 Ti."), sOld.reason);
    const sOk = K.serverSupport({ state: "connected", gpus: R5090, objectInfo: infoA });
    check("serverSupport: all there: offered, pack A named with the card", sOk.ok && sOk.show === "ready" && sOk.pack === "marawan206" && sOk.verified && sOk.note === "" && sOk.line === "CorridorKey 2.0 on your ComfyUI through ComfyUI-CorridorKey2.0 on NVIDIA GeForce RTX 5090." && sOk.generation === 50, JSON.stringify(sOk));
    const sB = K.serverSupport({ state: "connected", gpus: R5090, objectInfo: infoB });
    check("serverSupport: pack B offered with its unverified note", sB.ok && sB.pack === "hashu786" && !sB.verified && /has not keyed with Scumble yet/.test(sB.note), JSON.stringify(sB));
    const sNone = K.serverSupport({ state: "connected", gpus: R5090, objectInfo: base });
    check("serverSupport: no pack's nodes: a warning pointing to the manual", !sNone.ok && sNone.kind === "warn" && sNone.reason.endsWith("install one there (Help › Scumble help › Key screen)."), sNone.reason);
    const { InpaintCanvas: _ic, ...noCanvas } = infoA;
    const sNc = K.serverSupport({ state: "connected", gpus: R5090, objectInfo: noCanvas });
    const sMn = K.serverSupport({ state: "missing-node", gpus: R5090, objectInfo: null });
    check("serverSupport: Inpaint Canvas missing (from the node list, or the state without one): a warning", !sNc.ok && sNc.kind === "warn" && /Inpaint Canvas node pack/.test(sNc.reason) && !sMn.ok && /Inpaint Canvas node pack/.test(sMn.reason), sNc.reason);
    const sNi = K.serverSupport({ state: "connected", gpus: R5090, objectInfo: null });
    check("serverSupport: the node list not read: a warning, nothing claimed", !sNi.ok && sNi.kind === "warn" && /could not read your ComfyUI's node list/.test(sNi.reason));
    const sCpu = K.serverSupport({ state: "connected", gpus: ["cpu"], objectInfo: infoA });
    check("serverSupport: no CUDA device listed is left to the pack (only positive evidence refuses), no os check", sCpu.ok && sCpu.gpu === "" && K.serverSupport({ state: "connected", os: "posix", gpus: R5090, objectInfo: infoA }).ok);

    // the pack's failures
    const tips = "\nThis error means you ran out of memory on your GPU.\n\nTIPS: If the workflow worked before you might have accidentally set the batch_size to a large number.";
    const root = "F:\\Comfyui\\ComfyUI_windows_portable_nvidia\\ComfyUI\\models\\corridorkey2";
    const missA = "CorridorKey 2.0 model files are missing:\n  " + [`${root}\\corridorkey_v2.safetensors`, `${root}\\foundations\\moge\\model.pt`, `${root}\\foundations\\cradio\\model.safetensors`].join("\n  ") + "\nEnable auto_download or see the README for the manual download steps.\n";
    const mm = K.missingModels(missA);
    check("missingModels: pack A's loader, the files from the models folder on", JSON.stringify(mm) === JSON.stringify(["corridorkey_v2.safetensors", "foundations/moge/model.pt", "foundations/cradio/model.safetensors"]), JSON.stringify(mm));
    const hA = K.hint(missA);
    check("hint: missing models name the files and both ways to fetch them on the ComfyUI machine", hA === "Key screen: the CorridorKey 2.0 models are not on your ComfyUI yet (missing: corridorkey_v2.safetensors, foundations/moge/model.pt, foundations/cradio/model.safetensors). Fetch them there once, about 5.1 GB: run the pack's scripts/download_models.py with ComfyUI's Python on that machine, or run its Load Model node once in the ComfyUI page with auto_download on (Help › Scumble help › Key screen).", hA);
    const mlb = K.missingModels(`Missing CorridorKey 2.0 model files: ${root}\\foundations\\rvm\\pretrain_rvm_small16_256_204031069.npz, ${root}\\foundations\\cradio\\hf_model.py`);
    check("missingModels: the comma-separated form (load_base, the download's check)", JSON.stringify(mlb) === JSON.stringify(["foundations/rvm/pretrain_rvm_small16_256_204031069.npz", "foundations/cradio/hf_model.py"]), JSON.stringify(mlb));
    const missB = "CorridorKey 2.0 model files are missing (auto-download is disabled by CORRIDORKEY2_NO_DOWNLOAD):\n  - /srv/comfy/models/corridorkey2/weights/corridorkey_v2.safetensors\n\nDownload them manually into /srv/comfy/models/corridorkey2 (about 5 GB) by running\n  python -s ComfyUI/custom_nodes/ComfyUI-CorridorKey2/scripts/download_weights.py";
    const hB = K.hint(missB);
    check("hint: pack B's missing models: its file, its script, the server switch, no auto_download", JSON.stringify(K.missingModels(missB)) === '["weights/corridorkey_v2.safetensors"]' && hB.includes("scripts/download_weights.py") && hB.includes("CORRIDORKEY2_NO_DOWNLOAD") && !hB.includes("auto_download"), hB);
    check("missingModels: any other failure is null", K.missingModels("CUDA out of memory") === null && K.missingModels("") === null);
    const hCuda = K.hint("CorridorKey 2.0 keying needs an NVIDIA GPU (CUDA) or an Apple Silicon Mac (Metal/MPS); ComfyUI is running on 'cpu'. On the CPU a single frame would take minutes.\n");
    check("hint: no CUDA device, with the device ComfyUI runs on", hCuda === "Key screen: CorridorKey 2.0 needs an NVIDIA GPU (CUDA) on your ComfyUI's machine, and that ComfyUI runs on cpu. Start it on an RTX 30, 40 or 50 card.", hCuda);
    check("hint: pack B's CUDA refusal", /needs an NVIDIA GPU \(CUDA\) on your ComfyUI's machine\. Start it/.test(K.hint("CorridorKey 2.0 requires an NVIDIA CUDA GPU.")));
    const hOom = K.hint("CUDA out of memory. Tried to allocate 3.20 GiB. GPU 0 has a total capacity of 31.84 GiB" + tips);
    const hOom2 = K.hint("Allocation on device " + tips);
    check("hint: CUDA out of memory (torch's text or ComfyUI's tip alone)", /ran out of memory for this box\. Key a smaller box/.test(hOom) && hOom === hOom2, hOom);
    const hCommit = K.hint("CorridorKey 2.0: a 1/1 window needs about 21.3 GB of GPU memory, but the Windows commit limit (RAM plus page file) only leaves room for 12.0 GB. GPU memory counts against that limit, and running out of it makes memory allocations fail in every program.\n");
    check("hint: the Windows commit limit", /Windows commit limit \(RAM plus page file\) on your ComfyUI's machine/.test(hCommit), hCommit);
    check("hint: the low-VRAM mode's disk", /needs about 7\.4 GB of free disk space/.test(K.hint("CorridorKey 2.0: low-VRAM mode needs about 7.4 GB of disk space in C:\\Temp\\ck for this clip and 2.0 GB is free.")));
    const hGen = K.hint("ValueError: alpha_hint has 2 masks for a 1-frame clip.\nmore\n");
    check("hint: anything else: the first line, plainly", hGen === "Key screen failed on your ComfyUI: ValueError: alpha_hint has 2 masks for a 1-frame clip." && K.hint("") === "Key screen failed on your ComfyUI: no message.", hGen);
    check("runFailure: the runner's own texts (they name the feature) pass, the pack's go through hint", K.runFailure(new Error("Key screen cancelled.")) === "Key screen cancelled." && K.runFailure(new Error(missA)) === hA && K.runFailure("CUDA out of memory") === K.hint("CUDA out of memory"));

    console.log(fails ? `FAIL (${fails})` : "PASS");
    process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
