"""Stop 4 & K8 supplementary measurements in the live Electron renderer (offline, tiles on, window focused):
1. Browser-encoded 15,000 x 10,000 PNG open (OffscreenCanvas.convertToBlob -> loadFile, verifying pngPartsOf returns
   null after 41 B and png_read runs unchanged).
2. Question 6.1 (P5: PNG parts that start independent) A/B on both the 15,000 x 10,000 synthetic picture (n1_15k) and
   the 15,000 x 10,000 photograph (adobe_15000x10000.jpg):
   - File size (bytes, MB, delta %, first-row filter census across the 79 parts).
   - 5 alternating rounds of readPngParts + putCanvasRows and full loadFile (standard K8 vs P5 independent part starts).
   - Exact pixel/Adler parity check between standard K8 and P5.
3. Question 6.5 (Upload while decoding) A/B on both 15,000 x 10,000 PNGs:
   - uploadBlob alone, pixelsOffThread alone, sequential (uploadBlob then pixelsOffThread, today's order), and
     parallel (Promise.all([uploadBlob, pixelsOffThread]), Question 6.5).
"""
import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from cdp import session  # noqa: E402

IMAGE = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--image=")), "F:/canvas/dist/daily/adobe_15000x10000.jpg").replace("\\", "/")
JSON_OUT = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--json" and i + 1 < len(sys.argv)), os.path.join(HERE, "after", "stop4_probe.json"))

JS = r"""(async () => {
    const commands = (await import("./commands.js")).commands;
    const { host } = await import("./editor/host.js");
    const shell = await import("./shell.js");
    const T = await import("./editor/inpaint_tiles.js");
    const PNG = await import("./editor/inpaint_png.js");
    const B = await import("./editor/inpaint_bands.js");
    const U = await import("./editor/inpaint_upload.js");
    const R = await import("./editor/inpaint_resample.js");
    const P = await import("./editor/px/px.js");
    const { InpaintEditor: E } = await import("./editor/inpaint_canvas.js");
    const run = (n, a) => commands.run(n, a || {});
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const median = (xs) => {
        const s = xs.slice().sort((a, b) => a - b);
        return +s[s.length >> 1].toFixed(1);
    };
    const stat = (xs) => {
        const s = xs.slice().sort((a, b) => a - b);
        return {
            median: +s[s.length >> 1].toFixed(1),
            min: +s[0].toFixed(1),
            max: +s[s.length - 1].toFixed(1),
            runs: xs.map((x) => +x.toFixed(1)),
        };
    };
    const sumJobs = (list) => {
        const jobs = {};
        for (const t of list || []) {
            if (!t || !t.op) continue;
            const j = jobs[t.op] || (jobs[t.op] = { jobs: 0 });
            j.jobs++;
            for (const [k, v] of Object.entries(t)) {
                if (typeof v === "number") j[k] = +((j[k] || 0) + v).toFixed(1);
            }
        }
        return jobs;
    };

    const W = 15000, H = 10000;
    const pxInst = await P.loadPx("./editor/px/px.wasm");

    // Helper: build both a standard parted PNG and a P5 (independent part starts: row 0 uses None or Sub) parted PNG
    // from a TileLayerPixels of size W x H, using the exact 79-part tile-aligned schedule (partRows(W, 256) -> align 256).
    const buildStandardAndP5 = async (tilePx) => {
        const parts = [];
        const per = PNG.partRows(W, 256);
        for (let y = 0; y < H;) {
            const rows = Math.min(per, H - y, 256 - (y % 256));
            parts.push({ y0: y, rows, last: y + rows === H });
            y += rows;
        }
        const rowBytes = W * 4;
        const stride = 1 + rowBytes;
        const stdWriter = new PNG.PngStreamWriter(W, H, { run: (args) => args.reply, texts: { Software: "Scumble" } });
        const p5Writer = new PNG.PngStreamWriter(W, H, { run: (args) => args.reply, texts: { Software: "Scumble" } });
        const stdFilters = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
        const p5Filters = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
        let stdNeedsPrev = 0, p5NeedsPrev = 0;

        for (let i = 0; i < parts.length; i++) {
            const { y0, rows, last } = parts[i];
            const raw = new Uint8Array(tilePx.readRect(0, y0, W, rows).data.buffer);
            const prev = i > 0 ? new Uint8Array(tilePx.readRect(0, y0 - 1, W, 1).data.buffer) : null;

            // 1. Standard part (today's writer: row 0 filtered against prev with adaptive 0..4)
            const stdPart = pxInst.pngPart(raw, W, rows, prev, 2, last);
            stdWriter.add(rows, { reply: stdPart });
            // Inspect first row's filter byte by running png_filter_rows on row 0 with prev
            const a0 = pxInst.job;
            let stdF0 = 0;
            try {
                const r0 = pxInst._in(a0, raw.subarray(0, rowBytes), rowBytes);
                const p0 = prev ? pxInst._in(a0, prev, rowBytes) : 0;
                const l0 = a0.take(stride);
                pxInst.exports.png_filter_rows(r0, W, 1, p0, l0);
                stdF0 = pxInst.u8()[l0];
            } finally {
                pxInst._reset(a0);
            }
            stdFilters[stdF0] = (stdFilters[stdF0] || 0) + 1;
            if (i > 0 && stdF0 > 1) stdNeedsPrev++;

            // 2. P5 part: for i === 0, identical to standard; for i > 0, row 0 uses the better of None (0) or Sub (1)
            //    (independent of prev), and rows 1..rows-1 use png_filter_rows with prev = row 0.
            if (i === 0) {
                p5Writer.add(rows, { reply: stdPart });
                p5Filters[stdF0] = (p5Filters[stdF0] || 0) + 1;
            } else {
                const a = pxInst.job;
                try {
                    const nBytes = rows * stride;
                    const linesPtr = a.take(nBytes);
                    const u8 = pxInst.u8();
                    // Score None (0) vs Sub (1) on row 0 using the same signed-abs sum as png.rs
                    let sumNone = 0, sumSub = 0;
                    for (let x = 0; x < rowBytes; x++) {
                        const v = raw[x];
                        sumNone += (v < 128 ? v : 256 - v);
                        const d = (v - (x >= 4 ? raw[x - 4] : 0)) & 255;
                        sumSub += (d < 128 ? d : 256 - d);
                    }
                    const f0 = sumSub <= sumNone ? 1 : 0;
                    p5Filters[f0] = (p5Filters[f0] || 0) + 1;
                    if (f0 > 1) p5NeedsPrev++;
                    u8[linesPtr] = f0;
                    if (f0 === 0) {
                        u8.set(raw.subarray(0, rowBytes), linesPtr + 1);
                    } else {
                        for (let x = 0; x < rowBytes; x++) {
                            u8[linesPtr + 1 + x] = (raw[x] - (x >= 4 ? raw[x - 4] : 0)) & 255;
                        }
                    }
                    if (rows > 1) {
                        const restBytes = (rows - 1) * rowBytes;
                        const rawRestPtr = pxInst._in(a, raw.subarray(rowBytes, rows * rowBytes), restBytes);
                        const prev0Ptr = pxInst._in(a, raw.subarray(0, rowBytes), rowBytes);
                        pxInst.exports.png_filter_rows(rawRestPtr, W, rows - 1, prev0Ptr, linesPtr + stride);
                    }
                    const adler = pxInst.exports.adler32(linesPtr, nBytes, 1) >>> 0;
                    const cap = nBytes + Math.ceil(nBytes / 31744) * 5 + 64;
                    const chunkPtr = a.take(cap + 12);
                    const written = pxInst.exports.deflate_part(linesPtr, nBytes, 2, last ? 1 : 0, chunkPtr + 8, cap);
                    if (written < 0) throw new Error("P5 deflate_part failed: " + written);
                    const crc = pxInst.exports.png_chunk_frame(chunkPtr, written, 0x49444154) >>> 0;
                    const chunk = pxInst.u8().slice(chunkPtr, chunkPtr + written + 12);
                    p5Writer.add(rows, {
                        reply: {
                            bytes: chunk.subarray(8, 8 + written),
                            adler,
                            raw: nBytes,
                            chunk,
                            crc,
                        },
                    });
                } finally {
                    pxInst._reset(a);
                }
            }
        }
        const stdBlob = await stdWriter.finish();
        const p5Blob = await p5Writer.finish();
        return {
            parts: parts.length,
            stdBlob,
            p5Blob,
            stdBytes: stdBlob.size,
            p5Bytes: p5Blob.size,
            deltaBytes: p5Blob.size - stdBlob.size,
            deltaPct: +(((p5Blob.size - stdBlob.size) / stdBlob.size) * 100).toFixed(3),
            stdFilters,
            p5Filters,
            stdNeedsPrev,
            p5NeedsPrev,
        };
    };

    // Benchmark helper for a pair of (stdBlob, p5Blob)
    const benchPair = async (pair, label) => {
        const pool = E.parts.pool();
        const rt = R.canvasRoundTrip();
        const layoutStd = await PNG.pngPartsOf(pair.stdBlob);
        const layoutP5 = await PNG.pngPartsOf(pair.p5Blob);
        if (!layoutStd || !layoutP5) throw new Error(label + ": pngPartsOf returned null");

        // Verify exact Adler-32 and pixel match on one decode of each
        let pxStd = T.TileLayerPixels.empty(W, H);
        let pxP5 = T.TileLayerPixels.empty(W, H);
        const infoStd = await PNG.readPngParts(pair.stdBlob, {
            pool, rt, layout: layoutStd,
            onRows: (rgba, y0, rows) => pxStd.putCanvasRows(rgba, W, 0, y0, rows),
        });
        const infoP5 = await PNG.readPngParts(pair.p5Blob, {
            pool, rt, layout: layoutP5,
            onRows: (rgba, y0, rows) => pxP5.putCanvasRows(rgba, W, 0, y0, rows),
        });
        const sampleCoords = [[0, 0], [17, 11], [29, 19], [58, 39]];
        let diffBytes = 0;
        for (const [tx, ty] of sampleCoords) {
            const a = pxStd.readRect(tx * 256, ty * 256, Math.min(256, W - tx * 256), Math.min(256, H - ty * 256)).data;
            const b = pxP5.readRect(tx * 256, ty * 256, Math.min(256, W - tx * 256), Math.min(256, H - ty * 256)).data;
            for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) diffBytes++;
        }
        pxStd.release(); pxP5.release();
        if (!infoStd.adler || !infoP5.adler || diffBytes !== 0) {
            throw new Error(`${label}: std vs P5 pixel mismatch (diffBytes ${diffBytes})`);
        }

        // 5 alternating rounds of readPngParts + putCanvasRows
        const stdDecodeWalls = [], p5DecodeWalls = [];
        let stdLastJobs = null, p5LastJobs = null;
        for (let r = 0; r < 5; r++) {
            const order = r % 2 === 0 ? ["std", "p5"] : ["p5", "std"];
            for (const arm of order) {
                const blob = arm === "std" ? pair.stdBlob : pair.p5Blob;
                let px = T.TileLayerPixels.empty(W, H);
                E.jobTimings(true);
                const t0 = performance.now();
                const lay = await PNG.pngPartsOf(blob);
                await PNG.readPngParts(blob, {
                    pool, rt, layout: lay,
                    onRows: (rgba, y0, rows) => px.putCanvasRows(rgba, W, 0, y0, rows),
                });
                const ms = performance.now() - t0;
                const jobs = sumJobs(E.jobTimings(true));
                px.release();
                if (arm === "std") { stdDecodeWalls.push(ms); stdLastJobs = jobs; }
                else { p5DecodeWalls.push(ms); p5LastJobs = jobs; }
            }
        }

        // 3 alternating rounds of full ed.loadFile(file) + mipsSettled
        const stdOpenWalls = [], p5OpenWalls = [];
        for (let r = 0; r < 3; r++) {
            const order = r % 2 === 0 ? ["std", "p5"] : ["p5", "std"];
            for (const arm of order) {
                const blob = arm === "std" ? pair.stdBlob : pair.p5Blob;
                const d = await run("new_document");
                const ed = host.editors().find((e) => e.node.id === d.id);
                shell.activate(ed);
                await wait(150);
                ed.resizeCanvas();
                const file = new File([blob], `${label}_${arm}_r${r}.png`, { type: "image/png" });
                const t0 = performance.now();
                await ed.loadFile(file);
                ed.fitView(); ed.draw();
                await ed.mipsSettled();
                const ms = performance.now() - t0;
                if (arm === "std") stdOpenWalls.push(ms);
                else p5OpenWalls.push(ms);
                await run("close_document", { doc: d.id, force: true });
            }
        }

        // Question 6.5: uploadBlob alone, decode alone, sequential (uploadBlob -> decode), parallel (Promise.all)
        const uploadOnly = [], decodeOnly = [], seqWalls = [], parWalls = [];
        for (let r = 0; r < 3; r++) {
            const file = new File([pair.stdBlob], `${label}_q65_r${r}.png`, { type: "image/png" });
            let t0 = performance.now();
            await U.uploadBlob(file, `${label}_u_${r}.png`, { overwrite: true });
            uploadOnly.push(performance.now() - t0);

            t0 = performance.now();
            let px = await E.parts.offThread(file, T.TileLayerPixels);
            decodeOnly.push(performance.now() - t0);
            px.release();

            t0 = performance.now();
            await U.uploadBlob(file, `${label}_seq_${r}.png`, { overwrite: true });
            px = await E.parts.offThread(file, T.TileLayerPixels);
            seqWalls.push(performance.now() - t0);
            px.release();

            t0 = performance.now();
            const [, pxPar] = await Promise.all([
                U.uploadBlob(file, `${label}_par_${r}.png`, { overwrite: true }),
                E.parts.offThread(file, T.TileLayerPixels),
            ]);
            parWalls.push(performance.now() - t0);
            pxPar.release();
        }

        return {
            parts: pair.parts,
            stdBytes: pair.stdBytes,
            p5Bytes: pair.p5Bytes,
            stdMB: +(pair.stdBytes / 1048576).toFixed(2),
            p5MB: +(pair.p5Bytes / 1048576).toFixed(2),
            deltaBytes: pair.deltaBytes,
            deltaPct: pair.deltaPct,
            stdFilters: pair.stdFilters,
            p5Filters: pair.p5Filters,
            stdNeedsPrev: pair.stdNeedsPrev,
            p5NeedsPrev: pair.p5NeedsPrev,
            adlerMatch: true,
            pixelDiffBytes: diffBytes,
            readPngParts_std: stat(stdDecodeWalls),
            readPngParts_p5: stat(p5DecodeWalls),
            readPngParts_speedup: +(median(stdDecodeWalls) / median(p5DecodeWalls)).toFixed(2),
            stdJobs: stdLastJobs,
            p5Jobs: p5LastJobs,
            loadFile_std: stat(stdOpenWalls),
            loadFile_p5: stat(p5OpenWalls),
            loadFile_speedup: +(median(stdOpenWalls) / median(p5OpenWalls)).toFixed(2),
            q65_uploadOnly: stat(uploadOnly),
            q65_decodeOnly: stat(decodeOnly),
            q65_sequential: stat(seqWalls),
            q65_parallel: stat(parWalls),
            q65_savedMs: +(median(seqWalls) - median(parWalls)).toFixed(1),
            q65_speedup: +(median(seqWalls) / median(parWalls)).toFixed(2),
        };
    };

    const out = { focused: document.hasFocus(), visibility: document.visibilityState };

    // 1. Build synthetic 15,000 x 10,000 disc + gradient picture (same as native_test.py build_the_file)
    let n1Px = T.TileLayerPixels.empty(W, H);
    const CELL = 2500, R0 = Math.round(W / 40), R2 = R0 * R0;
    for (let ty = 0; ty * 256 < H; ty++) for (let tx = 0; tx * 256 < W; tx++) {
        const d8 = n1Px.writable(tx, ty).data;
        const w = Math.min(256, W - tx * 256), h = Math.min(256, H - ty * 256);
        for (let y = 0; y < h; y++) {
            const Y = ty * 256 + y, cyc = Math.floor(Y / CELL), dy = Y - (cyc * CELL + CELL / 2);
            for (let x = 0; x < w; x++) {
                const X = tx * 256 + x, o = (y * 256 + x) * 4;
                let n = (Math.imul(X, 374761393) + Math.imul(Y, 668265263)) >>> 0;
                n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
                const cxc = Math.floor(X / CELL), dx = X - (cxc * CELL + CELL / 2);
                if (dx * dx + dy * dy < R2) {
                    const k = (cxc * 73 + cyc * 151) % 7;
                    d8[o] = 60 + k * 25 + (n >>> 29); d8[o + 1] = 220 - k * 22 + ((n >>> 26) & 7); d8[o + 2] = 40 + k * 9 + ((n >>> 23) & 7);
                } else {
                    const t = (X / W + Y / H) * 0.5;
                    d8[o] = ((30 + 190 * t) | 0) + (n >>> 29); d8[o + 1] = ((70 + 60 * t) | 0) + ((n >>> 26) & 7); d8[o + 2] = ((200 - 150 * t) | 0) + ((n >>> 23) & 7);
                }
                d8[o + 3] = 255;
            }
        }
    }
    const n1Pair = await buildStandardAndP5(n1Px);
    n1Px.release(); n1Px = null;
    out.n1_15k = await benchPair(n1Pair, "n1_15k");

    // 2. Browser-encoded 15,000 x 10,000 PNG (OffscreenCanvas.convertToBlob({ type: "image/png" }))
    {
        const oc = new OffscreenCanvas(W, H);
        const octx = oc.getContext("2d");
        const g = octx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "#1e46c8");
        g.addColorStop(0.5, "#3ca078");
        g.addColorStop(1, "#dc7832");
        octx.fillStyle = g;
        octx.fillRect(0, 0, W, H);
        const tEnc = performance.now();
        const browserBlob = await oc.convertToBlob({ type: "image/png" });
        const encodeMs = +(performance.now() - tEnc).toFixed(1);
        oc.width = 1; oc.height = 1;

        let bytesRead = 0;
        const origSlice = browserBlob.slice.bind(browserBlob);
        const wrapped = new Proxy(browserBlob, {
            get(target, prop) {
                if (prop === "size") return target.size;
                if (prop === "slice") return (s = 0, e = target.size) => {
                    bytesRead += Math.max(0, Math.min(target.size, e) - Math.max(0, s));
                    return origSlice(s, e);
                };
                const v = target[prop];
                return typeof v === "function" ? v.bind(target) : v;
            },
        });
        const partsLayout = await PNG.pngPartsOf(wrapped);
        const streamWalls = [], loadWalls = [];
        let lastJobs = null;
        for (let r = 0; r < 3; r++) {
            E.jobTimings(true);
            const t0 = performance.now();
            const px = await E.parts.offThread(browserBlob, T.TileLayerPixels);
            streamWalls.push(performance.now() - t0);
            lastJobs = sumJobs(E.jobTimings(true));
            px.release();

            const d = await run("new_document");
            const ed = host.editors().find((e) => e.node.id === d.id);
            shell.activate(ed);
            await wait(150);
            ed.resizeCanvas();
            const t1 = performance.now();
            await ed.loadFile(new File([browserBlob], `browser_15k_r${r}.png`, { type: "image/png" }));
            ed.fitView(); ed.draw();
            await ed.mipsSettled();
            loadWalls.push(performance.now() - t1);
            await run("close_document", { doc: d.id, force: true });
        }
        out.browser_15k = {
            MB: +(browserBlob.size / 1048576).toFixed(2),
            encodeMs,
            pngPartsOf: partsLayout,
            bytesReadByPngPartsOf: bytesRead,
            pixelsFromPngStream: stat(streamWalls),
            loadFile: stat(loadWalls),
            jobs: lastJobs,
        };
    }

    // 3. Real 15,000 x 10,000 photograph (adobe_15000x10000.jpg)
    {
        const d = await run("new_document");
        const ed = host.editors().find((e) => e.node.id === d.id);
        shell.activate(ed);
        await wait(150);
        ed.resizeCanvas();
        await run("load_image", { doc: d.id, path: __IMAGE__ });
        await ed.mipsSettled();
        const photoPair = await buildStandardAndP5(ed.basePx);
        await run("close_document", { doc: d.id, force: true });
        out.photo_15k = await benchPair(photoPair, "photo_15k");
    }

    return out;
})()"""


async def main(c):
    await c.call("Page.bringToFront")
    res = await c.eval(JS.replace("__IMAGE__", json.dumps(IMAGE)), timeout=2400)
    os.makedirs(os.path.dirname(os.path.abspath(JSON_OUT)), exist_ok=True)
    with open(JSON_OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(res, f, indent=2)
    print(json.dumps(res, indent=2))
    return True


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(main)) else 1)
