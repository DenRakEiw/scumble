"""The refine's full-resolution read per band in the app (docs/ck2/refine_notes.md, the review's must finding).

A 15000 x 10000 document (a gradient base with discs, a paint layer, a grey fill filter layer at 50 % over everything,
as the base key's grey layer), then per
band of the 15k box (15000 x 279 rows answered plus 7 halo rows above and below, the fast method's plan) three reads:
  same     sampleRegionSettled("image", box, 1, { forRun: true, skipFilters: true }) + getImageData: the bucket's picture
  composite readBoxBytes(box, { forRun: true, held }): the first notes' call, filters composited
each as a whole refine reads them: the noise sample's strip (60 rows), then every band of keymatte's bandPlan once (36
bands of 279 rows plus the halo of 7); the same sweep again warm; the bytes of both reads compared (the filter shows in
one only).
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, "F:/canvas/.claude/worktrees/ck-refine/tools")
from cdp import session  # noqa: E402

W, H = (int(v) for v in (sys.argv[1] if len(sys.argv) > 1 else "15000x10000").split("x"))

BODY = """
(async () => {
    const W = %(w)d, H = %(h)d;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const shell = await import("./shell.js");
    const ed = shell.newDocument();
    shell.activate(ed);
    await sleep(300);
    ed.resizeCanvas();
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const base = mk(W, H);
    {
        const x = base.getContext("2d");
        const g = x.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, "hsl(120,55%%,40%%)");
        g.addColorStop(1, "hsl(140,60%%,30%%)");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        for (let i = 0; i < 60; i++) { x.fillStyle = `hsl(${(i * 37) %% 360},60%%,55%%)`; x.beginPath(); x.arc((i * 977) %% W, (i * 613) %% H, Math.max(8, W / 40), 0, Math.PI * 2); x.fill(); }
    }
    Object.defineProperty(base, "naturalWidth", { value: W });
    Object.defineProperty(base, "naturalHeight", { value: H });
    await ed.setBase({ filename: "readcost.png", subfolder: "inpaint_canvas", type: "input" }, base, { keepLayers: false });
    base.width = 1;
    const pc = mk(W, H);
    { const x = pc.getContext("2d"); x.fillStyle = "hsla(20,70%%,60%%,0.8)"; x.fillRect(W * 0.3, H * 0.2, W * 0.4, H * 0.6); }
    ed.addLayer({ name: "Paint", kind: "paint", px: ed.pixels.Layer.fromCanvas(pc), x: 0, y: 0, w: W, h: H, dirty: true });
    pc.width = 1;
    const fl = ed.addFilterLayer("fill");
    fl.params.color = "#808080"; fl.opacity = 0.5; ed.markFilterChanged(fl);
    const kinds = ed.layers.map((l) => l.kind + (l.filter ? ":" + l.filter : "") + (l.params ? ":" + JSON.stringify(l.params).slice(0, 80) : ""));
    ed.renderLayers(); ed.fitView(); ed.draw();
    await ed.mipsSettled();
    await sleep(500);
    const now = () => performance.now();
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const readSame = async (box) => {
        const c = await ed.sampleRegionSettled("image", box, 1, { forRun: true, skipFilters: true });
        const d = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, box[2] - box[0], box[3] - box[1]).data;
        return d;
    };
    const K = await import("./editor/keymatte.js");
    const out = { size: [W, H], kinds, tileMode: ed.tileMode };
    const bands = K.bandPlan(W, H, { halo: 7 });
    const sy = Math.floor((H - Math.max(48, 60)) / 2), sbox = [0, sy, W, sy + 60];
    const sweep = async (label, read) => {
        const t0 = now(), per = [];
        let t = now(); await read(sbox); const sample = now() - t;
        for (const b of bands) { t = now(); await read([0, b.ry0, W, b.ry1]); per.push(now() - t); }
        return { label, sampleMs: Math.round(sample), bands: per.length, medianMs: Math.round(med(per)), maxMs: Math.round(Math.max(...per)), firstMs: Math.round(per[0]), allMs: Math.round(now() - t0) };
    };
    const held = await ed.holdRunStack({ forRun: true });
    try {
        out.cold_same = await sweep("sampleRegionSettled(image, box, 1, { forRun, skipFilters }) + getImageData, cold", readSame);
        out.composite = await sweep("readBoxBytes(box, { forRun, held }), filters composited", async (box) => (await ed.readBoxBytes(box, { forRun: true, held })).data);
        out.warm_same = await sweep("the same read again, warm", readSame);
        const a = await readSame([0, 5000, W, 5010]), b = (await ed.readBoxBytes([0, 5000, W, 5010], { forRun: true, held })).data;
        let diff = 0; for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) diff = Math.max(diff, Math.abs(a[i] - b[i]));
        out.maxDiffSameVsComposite = diff;
    } finally { if (held) held.release(); }
    return JSON.stringify(out);
})()
"""


async def main():
    async def run(c):
        res = json.loads(await c.eval(BODY % {"w": W, "h": H}, timeout=3600))
        print(json.dumps(res, indent=1))
    await session(run)


if __name__ == "__main__":
    asyncio.run(main())
