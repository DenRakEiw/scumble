"""K37 15000x10000 A/B measurement: bucketFill over tiles (compositeFill -> compositeMaskedTile) vs canvas (_scratchDraw)."""
import asyncio
import json
import os
import statistics
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from cdp import session  # noqa: E402
import native_test  # noqa: E402


JS_SETUP_AND_RUN = r"""(async () => {
    const roundIdx = __ROUND__;
    const commands = window.__cmds.commands, host = window.__host, shell = window.__shell;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const T = await import("./editor/inpaint_tiles.js");
    const A = await import("./editor/inpaint_arena.js");
    const K = await import("./editor/px/kernels.js");
    const [W, H] = [15000, 10000];
    const CELL = 2500, R = Math.round(W / 40);
    const onDisc = (x, y) => {
        const dx = x - (Math.floor(x / CELL) * CELL + CELL / 2);
        const dy = y - (Math.floor(y / CELL) * CELL + CELL / 2);
        return dx * dx + dy * dy < (R + 2) * (R + 2);
    };
    let [GX, GY] = [2500, 2500];
    if (onDisc(GX, GY)) GX = Math.min(W - 1, GX + 2 * R + 4);
    const GRAD = [GX, GY];
    const DISC = [1250, 1250];

    const d = await run("new_document");
    window.__n1doc = d.id;
    const ed = ednow(d.id);
    const E = ed.constructor;
    shell.activate(ed);
    await wait(300);
    ed.resizeCanvas();
    if (!ed.tileMode) throw new Error("not in tileMode");

    // 1. Build and load 15000 x 10000 base image (same as native_test.py build_the_file + open_the_file)
    let px = T.TileLayerPixels.empty(W, H);
    const R2 = R * R;
    for (let ty = 0; ty * 256 < H; ty++) for (let tx = 0; tx * 256 < W; tx++) {
        const d8 = px.writable(tx, ty).data;
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
    const enc = await E.parts.encodeTilePixels(px, { hash: true });
    px.release(); px = null;
    await ed.loadFile(new File([enc.blob], "n1.png", { type: "image/png" }));
    ed.fitView(); ed.draw();
    await ed.mipsSettled();

    // 2. Add full-size paint layer (same as native_test.py add_the_paint_layer)
    const word = (r, g, b, a) => new Uint32Array(new Uint8Array([r, g, b, a]).buffer)[0];
    const hsl = (h, s, l) => {
        const f = (n) => {
            const k = (n + h / 30) % 12;
            return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
        };
        return [f(0), f(8), f(4)];
    };
    const wash = word(...hsl(60, 0.8, 0.5), 89);
    const rects = [];
    for (let k = 0; k < 20; k++) {
        const x0 = (k * 811) % W, y0 = (k * 457) % H;
        rects.push([x0, y0, Math.min(W, Math.round(x0 + W / 25)), Math.min(H, Math.round(y0 + H / 25)), word(...hsl((k * 53) % 360, 0.7, 0.6), 255)]);
    }
    const lpx = ed.pixels.Layer.empty(W, H);
    let img = null;
    for (let y0 = 0; y0 < H; y0 += 256) {
        const rows = Math.min(256, H - y0);
        if (!img || img.height !== rows) img = new ImageData(W, rows);
        const b32 = new Uint32Array(img.data.buffer);
        b32.fill(0);
        for (let yy = 0; yy < rows; yy++) {
            const Y = y0 + yy, o = yy * W;
            if (Y >= 40 && Y < H - 80) b32.fill(wash, o + 40, o + W - 80);
            for (const [rx0, ry0, rx1, ry1, c] of rects) if (Y >= ry0 && Y < ry1) b32.fill(c, o + rx0, o + rx1);
        }
        lpx.writeRect(img, 0, y0);
    }
    const paint = ed.addLayer({ name: "Paint", kind: "paint", px: lpx, x: 0, y: 0, w: W, h: H, dirty: true });
    ed.renderLayers(); ed.fitView(); ed.draw();
    await ed.mipsSettled();

    const addCalls = (into, calls) => {
        if (calls && typeof calls === "object") for (const [k, n] of Object.entries(calls)) if (typeof n === "number") into[k] = (into[k] || 0) + n;
        return into;
    };

    const fnvTiles = (store, x0, y0, x1, y1) => {
        let h = 2166136261 >>> 0;
        for (let ty = y0 >> 8; ty * 256 < y1; ty++) {
            for (let tx = x0 >> 8; tx * 256 < x1; tx++) {
                const t = store.tileAt(tx, ty);
                if (!t) continue;
                const d = t.data;
                for (let i = 0; i < d.length; i += 64) {
                    h = Math.imul(h ^ d[i], 16777619) >>> 0;
                    h = Math.imul(h ^ d[i + 3], 16777619) >>> 0;
                }
            }
        }
        return h >>> 0;
    };

    const runBucketOp = async (arm, x, y, selBox, checkHashBox = null) => {
        ed.sel.clear();
        if (selBox) {
            ed.sel.fill(selBox, "#ff0000");
            ed.markSelectionChanged(selBox);
        } else {
            ed.markSelectionChanged();
        }
        ed.getBounds();
        ed.clearUndo();
        ed.activeLayerId = paint.id;
        ed.setTool("bucket");
        ed.color = "#e08020";
        ed.brushOpacity = 1;
        await ed.mipsSettled();
        await wait(80);

        E.bucketTiles = arm !== "before";
        K.setRoute("compositeMaskedTile", arm === "js" ? "js" : null);

        window.__n1.reset();
        E.jobTimings(true);
        K.pxCalls(true);
        let held = 0, last = performance.now(), on = true;
        const beat = () => { const n = performance.now(); held = Math.max(held, n - last); last = n; if (on) setTimeout(beat, 0); };
        setTimeout(beat, 0);
        const t0 = performance.now();
        await ed.bucketFill(x, y);
        const tFill = performance.now();
        const heldFill = Math.max(held, tFill - last);
        await ed.mipsSettled();
        on = false;
        held = Math.max(held, performance.now() - last);
        const wall = tFill - t0;
        const wallSettled = performance.now() - t0;

        const calls = window.__n1.read();
        const windowPx = K.pxCalls(true);
        const jobs = {}, workerPx = {};
        for (const t of E.jobTimings(true)) {
            const key = t.op + (t.kind ? ":" + t.kind : "");
            const j = jobs[key] || (jobs[key] = { jobs: 0 });
            j.jobs++;
            for (const [k, v] of Object.entries(t)) if (typeof v === "number") j[k] = +((j[k] || 0) + v).toFixed(1);
            if (t.pxCalls && typeof t.pxCalls === "object") { addCalls(j.pxCalls || (j.pxCalls = {}), t.pxCalls); addCalls(workerPx, t.pxCalls); }
        }
        const m = /Filled ([\d.,\s]+) px/.exec(ed.status || "");
        const filled = m ? +m[1].replace(/\D/g, "") : 0;
        const hash = checkHashBox ? fnvTiles(paint.px, ...checkHashBox) : null;

        E.bucketTiles = true;
        K.setRoute("compositeMaskedTile", null);
        if (ed.undo.length) await run("undo", { doc: window.__n1doc, steps: ed.undo.length });
        ed.clearUndo();
        ed.renderLayers();
        ed.draw();
        await ed.mipsSettled();
        await wait(200);

        return {
            wall: +wall.toFixed(1),
            wallSettled: +wallSettled.toFixed(1),
            blocked: +heldFill.toFixed(1),
            blockedSettled: +held.toFixed(1),
            filled,
            hash,
            getImageData: calls["2d getImageData"] || { n: 0, ms: 0, MB: 0 },
            putImageData: calls["2d putImageData"] || { n: 0, ms: 0, MB: 0 },
            windowPx,
            workerPx,
            floodJob: jobs.flood || null,
            focused: document.hasFocus(),
        };
    };

    const arms = [["before", "rust", "js"], ["rust", "js", "before"], ["js", "before", "rust"]][roundIdx % 3];
    const scenarios = [
        ["bucket_fill", GRAD[0], GRAD[1], null, [0, 0, W, H]],
        ["bucket_one_disc", DISC[0], DISC[1], null, [768, 768, 1792, 1792]],
        ["bucket_sel_1000", DISC[0], DISC[1], [750, 750, 1750, 1750], [750, 750, 1750, 1750]],
        ["bucket_sel_256", DISC[0], DISC[1], [1122, 1122, 1378, 1378], [1024, 1024, 1536, 1536]],
        ["bucket_sel_64", DISC[0], DISC[1], [1218, 1218, 1282, 1282], [1024, 1024, 1536, 1536]],
    ];

    const out = { round: roundIdx, rows: {}, compositeFillOnly: {} };
    for (const [name, x, y, selBox, hashBox] of scenarios) {
        out.rows[name] = {};
        for (const arm of arms) {
            out.rows[name][arm] = await runBucketOp(arm, x, y, selBox, hashBox);
        }
    }

    // Also measure `compositeFill` alone (rust vs js) on frozen clones of the 15k paint layer
    ed.sel.clear(); ed.markSelectionChanged(); ed.getBounds();
    const rBand = await ed.floodRegion(GRAD[0], GRAD[1], { tolerance: 32, contiguous: true, sample: "image", color: "#e08020", clip: true, tiles: true });
    const rDisc = await ed.floodRegion(DISC[0], DISC[1], { tolerance: 32, contiguous: true, sample: "image", color: "#e08020", clip: true, tiles: true });
    for (const [label, r] of [["band_949_tiles", rBand], ["disc_tiles", rDisc]]) {
        out.compositeFillOnly[label] = { tiles: r.tiles.length };
        for (const rt of (roundIdx % 2 === 0 ? ["rust", "js"] : ["js", "rust"])) {
            const clone = paint.px.clone();
            K.setRoute("compositeMaskedTile", rt === "js" ? "js" : null);
            K.pxCalls(true);
            const t0 = performance.now();
            const written = clone.compositeFill(r.tiles, "#e08020", 0, 255, [r.x, r.y]);
            const ms = +(performance.now() - t0).toFixed(2);
            const kc = K.pxCalls(true);
            K.setRoute("compositeMaskedTile", null);
            clone.release();
            out.compositeFillOnly[label][rt] = { ms, written, composite_masked_tile: kc.composite_masked_tile || 0 };
        }
    }

    await run("close_document", { doc: d.id, force: true });
    return out;
})()"""


async def run_round(round_idx):
    async def body(c):
        await c.call("Page.bringToFront")
        await c.eval("(async () => { while (document.readyState !== 'complete' || !window.scumble) await new Promise(r => setTimeout(r, 50)); window.__cmds = await import('./commands.js'); const h = await import('./editor/host.js'); window.__host = h.host; window.__shell = await import('./shell.js'); return 1; })()")
        await c.eval(native_test.PROBES)
        expr = JS_SETUP_AND_RUN.replace("__ROUND__", str(round_idx))
        return await c.eval(expr, timeout=1800)
    for attempt in range(60):
        try:
            return await session(body)
        except Exception:
            if attempt == 59:
                raise
            await asyncio.sleep(0.5)


def fmt_med(vals, fmt=".1f"):
    m = statistics.median(vals)
    return f"{m:{fmt}} [{min(vals):{fmt}}-{max(vals):{fmt}}]"


def summarize(out_dir):
    rounds = [json.load(open(os.path.join(out_dir, f"round_{r}.json"), encoding="utf-8")) for r in range(3)]
    lines = [
        "K37 15000 x 10000 A/B Measurement Summary (3 rotating fresh-instance rounds, --tiles --no-comfy)",
        "================================================================================================",
        "Byte effect: At full opacity the bytes equal the canvas path (alpha-locked fills at full opacity stay",
        "on the canvas path); at opacity below 1 partially blended pixels differ by at most one premultiplied",
        "level against Skia.",
        "Note on before arm: measured in-tree via InpaintEditor.bucketTiles = false (which takes the base's",
        "exact canvas drawInto -> _scratchDraw path).",
        "",
        "1. End-to-End bucketFill Operations on 15000 x 10000 Paint Layer (medians [min-max] across 3 rounds)",
        "----------------------------------------------------------------------------------------------------",
    ]
    for row in rounds[0]["rows"]:
        filled = rounds[0]["rows"][row]["rust"]["filled"]
        lines.append(f"\nRow: {row} (filled = {filled:,} px)")
        for arm, desc in (
            ("before", "before (InpaintEditor.bucketTiles = false: drawInto -> _scratchDraw readback of the flood box)"),
            ("rust", "after  (tiles: floodOverTiles + compositeFill -> rust SIMD compositeMaskedTile)"),
            ("js", "twin   (tiles: floodOverTiles + compositeFill -> JS twin compositeMaskedTile)"),
        ):
            walls = [r["rows"][row][arm]["wall"] for r in rounds]
            blks = [r["rows"][row][arm]["blocked"] for r in rounds]
            swalls = [r["rows"][row][arm]["wallSettled"] for r in rounds]
            sblks = [r["rows"][row][arm]["blockedSettled"] for r in rounds]
            g_ms = [r["rows"][row][arm]["getImageData"]["ms"] for r in rounds]
            g_mb = [r["rows"][row][arm]["getImageData"]["MB"] for r in rounds]
            g_n = int(statistics.median([r["rows"][row][arm]["getImageData"]["n"] for r in rounds]))
            p_ms = [r["rows"][row][arm]["putImageData"]["ms"] for r in rounds]
            p_mb = [r["rows"][row][arm]["putImageData"]["MB"] for r in rounds]
            p_n = int(statistics.median([r["rows"][row][arm]["putImageData"]["n"] for r in rounds]))
            ftot = [r["rows"][row][arm]["floodJob"]["total"] for r in rounds]
            fshp = [r["rows"][row][arm]["floodJob"]["shape"] for r in rounds]
            hashes = [r["rows"][row][arm]["hash"] for r in rounds]
            wpx = rounds[0]["rows"][row][arm]["windowPx"]
            lines.append(f"  {desc}")
            lines.append(f"    wall:          {fmt_med(walls)} ms   | longest block:          {fmt_med(blks)} ms")
            lines.append(f"    settled wall:  {fmt_med(swalls)} ms   | settled longest block:  {fmt_med(sblks)} ms")
            lines.append(f"    2d getImageData: {g_n:4d} calls, {fmt_med(g_ms)} ms, {fmt_med(g_mb)} MB")
            lines.append(f"    2d putImageData: {p_n:4d} calls, {fmt_med(p_ms)} ms, {fmt_med(p_mb)} MB")
            lines.append(f"    worker floodJob: total {fmt_med(ftot)} ms (shape {fmt_med(fshp)} ms)")
            lines.append(f"    window pxCalls:  {json.dumps(wpx)}   | patch FNV-1a: {hashes[0]}")
    lines.extend([
        "",
        "2. Isolated TileLayerPixels.compositeFill Microbenchmark (main thread, 3 rounds)",
        "--------------------------------------------------------------------------------",
    ])
    for k, info0 in rounds[0]["compositeFillOnly"].items():
        tiles = info0["tiles"]
        rc = info0["rust"]["composite_masked_tile"]
        rms = [r["compositeFillOnly"][k]["rust"]["ms"] for r in rounds]
        jms = [r["compositeFillOnly"][k]["js"]["ms"] for r in rounds]
        lines.append(f"  {k:18s} ({tiles:4d} tiles, {rc:4d} composite_masked_tile calls): rust = {fmt_med(rms, '.2f')} ms | js = {fmt_med(jms, '.2f')} ms")
    text = "\n".join(lines) + "\n"
    sum_path = os.path.join(out_dir, "summary.txt")
    with open(sum_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(text)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    out_dir = os.path.dirname(os.path.abspath(__file__))
    if len(sys.argv) > 1 and sys.argv[1] == "--summary":
        summarize(out_dir)
        return
    round_idx = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    res = asyncio.run(run_round(round_idx))
    out_dir = os.path.dirname(os.path.abspath(__file__))
    out_path = os.path.join(out_dir, f"round_{round_idx}.json")
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(res, f, indent=2)
    print(f"Saved {out_path}")
    for name, arms in res["rows"].items():
        b, r, j = arms["before"], arms["rust"], arms["js"]
        print(f"  {name:18s} filled={r['filled']:8d}  before: wall={b['wall']:7.1f} blk={b['blocked']:6.1f} (settled {b['wallSettled']:7.1f}/{b['blockedSettled']:6.1f}, getImg={b['getImageData']['ms']:6.1f}ms/{b['getImageData']['MB']:5.1f}MB)"
              f" | rust: wall={r['wall']:7.1f} blk={r['blocked']:6.1f} (settled {r['wallSettled']:7.1f}/{r['blockedSettled']:6.1f})"
              f" | js: wall={j['wall']:7.1f} blk={j['blocked']:6.1f}  hashes={b['hash']}/{r['hash']}/{j['hash']}")
    for label, info in res["compositeFillOnly"].items():
        print(f"  compositeFill {label:16s} ({info['tiles']} tiles): rust={info['rust']['ms']:.2f}ms  js={info['js']['ms']:.2f}ms")


if __name__ == "__main__":
    main()
