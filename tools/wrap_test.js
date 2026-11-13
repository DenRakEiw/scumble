// Deep paint's wrap (docs/PLAN_SURFACE_PAINT.md SP7, renderer/editor/inpaint_wrap.js) in plain Node:
//   node tools/wrap_test.js
// * flat normals: the decal lands as its own pixels where it is placed (byte for byte), nothing outside;
// * a cylinder seen side on (axis vertical, radius R): a vertical line of the decal at surface offset d from the centre
//   lands at x = c + R sin(d / R) within a pixel, the lines crowd towards the silhouette, the rows do not move;
// * a quarter turn: the decal's left half on top;
// * the region (a selection's alpha) multiplies the alpha, a mask of 0 means flat;
// * the map's frame: a cylinder's normal map turned with xf gives the same lines turned.
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

(async () => {
    const Wr = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_wrap.js")).href);
    const { makeMap } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_maps.js")).href);
    const fails = [];
    const check = (name, ok, info) => { if (!ok) fails.push(name + (info !== undefined ? ": " + JSON.stringify(info).slice(0, 300) : "")); else console.log("[ok]", name); };
    const pack = (v) => Math.round((v + 1) / 2 * 255);

    const W = 400, H = 200;
    const flatData = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { flatData[4 * i] = 128; flatData[4 * i + 1] = 128; flatData[4 * i + 2] = 0; flatData[4 * i + 3] = 255; }
    const flat = makeMap("normals", W, H, flatData, [W, 0, 0, H, 0, 0], {}, null, "rgba8");

    // a decal: 60 x 40, red left half, blue right half, a green dot at (10, 5)
    const dw = 60, dh = 40, dd = new Uint8ClampedArray(dw * dh * 4);
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
        const i = 4 * (y * dw + x);
        dd[i] = x < 30 ? 220 : 20; dd[i + 1] = 30; dd[i + 2] = x < 30 ? 20 : 220; dd[i + 3] = 255;
    }
    dd.set([10, 240, 10, 255], 4 * (5 * dw + 10));
    const decal = { data: dd, width: dw, height: dh };

    // flat: the decal placed at (100, 50), its own size
    {
        const place = { cx: 100 + 30, cy: 50 + 20, w: 60, h: 40 };
        const box = Wr.wrapBox(place, W, H);
        const out = Wr.wrapDecal({ map: flat, box, decal, place });
        const bw = box[2] - box[0];
        let same = true, outside = 0;
        for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
            const o = 4 * ((y - box[1]) * bw + (x - box[0]));
            const dx = x - 100, dy = y - 50;
            if (dx >= 0 && dy >= 0 && dx < dw && dy < dh) { for (let c = 0; c < 4; c++) if (out[o + c] !== dd[4 * (dy * dw + dx) + c]) same = false; }
            else if (out[o + 3]) outside++;
        }
        check("flat: the decal's own pixels where it is placed", same);
        check("flat: nothing outside it", outside === 0, outside);
    }

    // the decal twice as large: the pixels scaled (the dot at (20.5, 10.5) * ... ), the halves in place
    {
        const place = { cx: 200, cy: 100, w: 120, h: 80 };
        const box = Wr.wrapBox(place, W, H), bw = box[2] - box[0];
        const out = Wr.wrapDecal({ map: flat, box, decal, place });
        const at = (x, y) => Array.from(out.slice(4 * ((y - box[1]) * bw + (x - box[0])), 4 * ((y - box[1]) * bw + (x - box[0])) + 4));
        check("scaled: the left half red, the right blue", at(150, 100)[0] > 200 && at(250, 100)[2] > 200 && at(139, 100)[3] === 0 && at(261, 100)[3] === 0, [at(150, 100), at(250, 100), at(139, 100), at(261, 100)]);
    }

    // a quarter turn clockwise: the left half on top
    {
        const place = { cx: 200, cy: 100, w: 60, h: 40, angle: 90 };
        const box = Wr.wrapBox(place, W, H), bw = box[2] - box[0];
        const out = Wr.wrapDecal({ map: flat, box, decal, place });
        const at = (x, y) => Array.from(out.slice(4 * ((y - box[1]) * bw + (x - box[0])), 4 * ((y - box[1]) * bw + (x - box[0])) + 4));
        check("a quarter turn: red on top, blue below, 40 wide", at(200, 80)[0] > 200 && at(200, 120)[2] > 200 && at(181, 100)[3] > 0 && at(178, 100)[3] === 0, [at(200, 80), at(200, 120), at(181, 100), at(178, 100)]);
    }

    // a cylinder: axis vertical at x0, radius R; outside it flat
    const R = 150, x0 = 200;
    const cyl = (turned) => {
        const w = turned ? H : W, h = turned ? W : H;
        const d = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            // the map's own pixel (x, y) is the document's (X, Y): untouched, or turned a quarter clockwise (X = h - 1 - y ... )
            const X = turned ? (h - 1 - y) : x;
            const dx = (X + 0.5 - x0) / R;
            const i = 4 * (y * w + x);
            if (Math.abs(dx) < 1) {
                const nz = -Math.sqrt(1 - dx * dx);
                // in the map's frame: untouched x is the document's x; turned, the document's x runs along the map's -y
                const mx = turned ? 0 : dx, my = turned ? -dx : 0;
                d[i] = pack(mx); d[i + 1] = pack(my); d[i + 2] = pack(nz); d[i + 3] = 255;
            } else { d[i] = 128; d[i + 1] = 128; d[i + 2] = 0; d[i + 3] = 255; }
        }
        // turned: map u (its x) runs down the document, map v (its y) runs to the left: doc = (W - v * W ... )
        const xf = turned ? [0, H, -W, 0, W, 0] : [W, 0, 0, H, 0, 0];
        return makeMap("normals", w, h, d, xf, {}, null, "rgba8");
    };
    // a decal of vertical lines: 241 wide, 20 tall, a line two pixels wide every 40 (centred at offsets -120 .. 120)
    const lw = 241, lh = 20, ld = new Uint8ClampedArray(lw * lh * 4);
    const offsets = [-120, -80, -40, 0, 40, 80, 120];
    for (let y = 0; y < lh; y++) for (const o of offsets) for (const k of [-1, 0]) {
        const x = 120 + o + k + 1;   // columns 120 + o and 120 + o + 1 straddle the offset's line at 120.5 + o
        if (x < 0 || x >= lw) continue;
        ld.set([255, 255, 255, 255], 4 * (y * lw + x));
    }
    const lines = { data: ld, width: lw, height: lh };
    const centres = (out, box, y) => {
        const bw = box[2] - box[0], row = (y - box[1]) * bw;
        const found = [];
        let sum = 0, wsum = 0;
        for (let x = 0; x < bw; x++) {
            const a = out[4 * (row + x) + 3];
            if (a) { sum += a * (box[0] + x + 0.5); wsum += a; }
            else if (wsum) { found.push(sum / wsum); sum = 0; wsum = 0; }
        }
        if (wsum) found.push(sum / wsum);
        return found;
    };
    for (const turned of [false, true]) {
        const map = cyl(turned);
        const place = { cx: x0, cy: 100, w: lw, h: lh };
        const box = Wr.wrapBox(place, W, H);
        const out = Wr.wrapDecal({ map, box, decal: lines, place });
        // a line at surface offset d (its centre at decal column 120.5 + d, 0.5 + d from the decal's middle 120.5) lands at
        // x0 + R sin(d / R) - the decal's middle is at the cylinder's axis
        const want = offsets.map((o) => x0 + R * Math.sin((o + 0.5) / R));
        const got = centres(out, box, 100);
        const err = got.length === want.length ? Math.max(...got.map((g, i) => Math.abs(g - want[i]))) : 99;
        check(`a cylinder${turned ? " (the map turned with xf)" : ""}: each line at c + R sin(d / R) within a pixel`, err <= 1, { got: got.map((g) => +g.toFixed(2)), want: want.map((g) => +g.toFixed(2)) });
        const gaps = got.slice(1).map((g, i) => g - got[i]);
        check(`a cylinder${turned ? " (turned)" : ""}: the lines crowd towards the silhouette`, gaps.length === 6 && gaps[0] < gaps[2] && gaps[5] < gaps[3], gaps);
        check(`a cylinder${turned ? " (turned)" : ""}: the rows stay where they were`, centres(out, box, 89).length === 0 && centres(out, box, 90).length === 7 && centres(out, box, 109).length === 7 && centres(out, box, 110).length === 0);
    }

    // a region: half the box selected
    {
        const place = { cx: 130, cy: 70, w: 60, h: 40 };
        const box = Wr.wrapBox(place, W, H), bw = box[2] - box[0], bh = box[3] - box[1];
        const sel = new Uint8Array(bw * bh);
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) sel[y * bw + x] = box[0] + x < 130 ? 255 : 0;
        const out = Wr.wrapDecal({ map: flat, box, decal, place, sel });
        const a = (x, y) => out[4 * ((y - box[1]) * bw + (x - box[0])) + 3];
        check("a region: inside the decal, outside nothing", a(120, 70) === 255 && a(140, 70) === 0);
    }
    // a mask of 0 is flat whatever the normal says
    {
        const d = new Uint8Array(W * H * 4);
        for (let i = 0; i < W * H; i++) d.set([255, 128, 30, 0], 4 * i);
        const masked = makeMap("normals", W, H, d, [W, 0, 0, H, 0, 0], {}, null, "rgba8");
        const { gx, gy } = Wr.wrapSlopes(masked, [0, 0, 10, 10]);
        check("a mask of 0: flat", gx.every((g) => g === 1) && gy.every((g) => g === 1));
    }

    for (const f of fails) console.log("[FAIL wrap]", f);
    console.log(fails.length ? "FAIL" : "PASS");
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
