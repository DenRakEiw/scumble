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

    // a decal placed far smaller than its pixels: columns one pixel wide, black and white, 640 wide placed 100 wide
    // (6.4 to 1); read from the halved levels it is an even grey, read straight it would pick stray columns (stripes)
    {
        const dw = 640, dh = 64, dd = new Uint8ClampedArray(dw * dh * 4);
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { const v = x % 2 ? 255 : 0; dd.set([v, v, v, 255], 4 * (y * dw + x)); }
        const place = { cx: 200, cy: 100, w: 100, h: 10 };
        const box = Wr.wrapBox(place, W, H), bw = box[2] - box[0];
        const out = Wr.wrapDecal({ map: flat, box, decal: { data: dd, width: dw, height: dh }, place });
        let lo = 255, hi = 0;
        for (let x = 155; x < 245; x++) { const v = out[4 * ((100 - box[1]) * bw + (x - box[0]))]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
        check("a decal placed 6.4 times smaller: an even grey, no stray columns", hi - lo <= 24 && lo > 100 && hi < 155, [lo, hi]);
        const hv = Wr.halveDecal({ data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 0, 9, 9, 9, 0]), width: 3, height: 1 });
        check("halveDecal: the alpha-weighted colour, an odd edge counted transparent", hv.width === 2 && [...hv.data.slice(0, 4)].join() === "255,0,0,64" && hv.data[7] === 0, [...hv.data]);
        const lv = Wr.decalLevel({ data: dd, width: dw, height: dh }, place);
        check("decalLevel: halved while twice the placed size", lv.k === 2 && lv.level.width === 160, [lv.k, lv.level.width]);
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

    // perspective: a pinhole camera (f = 300 px, the principal point at the centre) and MoGe-2's points (packPoints)
    {
        const S = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_surface.js")).href);
        const PW = 400, PH = 300, F = 300;
        const ray = (u, v) => [(u + 0.5 - PW / 2) / F, (v + 0.5 - PH / 2) / F, 1];
        const pointsOf = (hit) => {
            const pts = new Float32Array(PW * PH * 3), mask = new Float32Array(PW * PH);
            for (let v = 0; v < PH; v++) for (let u = 0; u < PW; u++) {
                const p = hit(ray(u, v));
                if (!p) continue;
                const i = v * PW + u;
                pts.set(p, 3 * i); mask[i] = 1;
            }
            return { pts, mask };
        };
        const flatN2 = new Uint8Array(PW * PH * 4);
        for (let i = 0; i < PW * PH; i++) flatN2.set([128, 128, 0, 255], 4 * i);
        const nmap2 = makeMap("normals", PW, PH, flatN2, [PW, 0, 0, PH, 0, 0], {}, null, "rgba8");
        // (a) a wall face on at z = 5: the focal length read back, and the decal lands as with flat normals
        const wall = pointsOf((d) => [d[0] * 5, d[1] * 5, 5]);
        const pw = S.packPoints(wall.pts, wall.mask, PW, PH);
        check("packPoints: the focal length read back within 1 %", pw && Math.abs(pw.meta.f - F) / F < 0.01, pw && pw.meta.f);
        const wallMap = makeMap("points", PW, PH, pw.data, [PW, 0, 0, PH, 0, 0], pw.meta, null, "rgb16");
        const place = { cx: 200, cy: 150, w: 60, h: 40 };
        const box = Wr.wrapBox(place, PW, PH);
        const flatOut = Wr.wrapDecal({ map: nmap2, box, decal, place });
        const wallOut = Wr.wrapDecal({ map: nmap2, box, decal, place, points: wallMap });
        let wmax = 0;
        for (let i = 0; i < flatOut.length; i++) wmax = Math.max(wmax, Math.abs(flatOut[i] - wallOut[i]));
        check("a wall face on: the points give the flat result within 2 levels", wmax <= 2, wmax);
        // (b) a floor one unit below the camera (y down): rows nearer the horizon are further away
        const floor = pointsOf((d) => (d[1] > 0.02 ? [d[0] / d[1], 1, 1 / d[1]] : null));
        const pf = S.packPoints(floor.pts, floor.mask, PW, PH);
        check("packPoints: the floor's focal length within 2 %", pf && Math.abs(pf.meta.f - F) / F < 0.02, pf && pf.meta.f);
        const floorMap = makeMap("points", PW, PH, pf.data, [PW, 0, 0, PH, 0, 0], pf.meta, null, "rgb16");
        // a decal of horizontal lines two pixels high every 12 rows, centred at (200, 240)
        const hw = 40, hh = 97, hd = new Uint8ClampedArray(hw * hh * 4);
        const rowsOff = [-36, -24, -12, 0, 12, 24, 36];
        for (const o of rowsOff) for (const k of [-1, 0]) { const r = 48 + o + k + 1; if (r >= 0 && r < hh) for (let x = 0; x < hw; x++) hd.set([255, 255, 255, 255], 4 * (r * hw + x)); }
        const fplace = { cx: 200, cy: 240, w: hw, h: hh };
        const fbox = Wr.wrapBox(fplace, PW, PH);
        const fout = Wr.wrapDecal({ map: nmap2, box: fbox, decal: { data: hd, width: hw, height: hh }, place: fplace, points: floorMap });
        // the lines' centres down the centre column (x 200)
        const bw = fbox[2] - fbox[0], col = 200 - fbox[0];
        const found = [];
        let sm = 0, sw = 0;
        for (let y = 0; y < fbox[3] - fbox[1]; y++) {
            const a = fout[4 * (y * bw + col) + 3];
            if (a) { sm += a * (fbox[1] + y + 0.5); sw += a; } else if (sw) { found.push(sm / sw); sm = 0; sw = 0; }
        }
        if (sw) found.push(sm / sw);
        // where a line at surface offset d lands: the row whose floor point lies d * (z_c / f) from the centre's, along
        // the centre column (a straight line on the floor), marched in tenths of a pixel
        // the centre's depth is that of the pixel centre's ray; arc lengths are measured from (200, 240) itself
        const at = (yy) => { const dy = (yy - 150) / F; return [0, 1, 1 / dy]; };
        const c0 = at(240), unit = c0[2] / F;
        const rowFor = (d) => {
            let yy = 240, s = 0, prev = at(yy);
            const step = d < 0 ? -0.01 : 0.01;
            while (Math.abs(s) < Math.abs(d) * unit && yy > 152 && yy < PH) { yy += step; const p = at(yy); s += Math.hypot(p[1] - prev[1], p[2] - prev[2]) * Math.sign(step); prev = p; }
            return yy;
        };
        const wantRows = rowsOff.map((o) => rowFor(o));
        const ferr = found.length === wantRows.length ? Math.max(...found.map((g, i) => Math.abs(g - wantRows[i]))) : 99;
        check("a floor in perspective: each line at its row on the floor within a pixel", ferr <= 1, { found: found.map((g) => +g.toFixed(2)), want: wantRows.map((g) => +g.toFixed(2)) });
        const gaps = found.slice(1).map((g, i) => g - found[i]);
        check("a floor in perspective: the lines crowd towards the horizon", gaps.length === 6 && gaps[0] < gaps[2] && gaps[2] < gaps[5], gaps);
        // and narrower towards it: a far row of the decal is narrower than a near one
        const widthAt = (y) => { let n = 0; for (let x = 0; x < bw; x++) if (fout[4 * ((y - fbox[1]) * bw + x) + 3]) n++; return n; };
        const wmaxAt = (g) => Math.max(widthAt(Math.floor(g) - 1), widthAt(Math.floor(g)), widthAt(Math.floor(g) + 1));
        check("a floor in perspective: a far line is narrower than a near one", wmaxAt(found[0]) > 0 && wmaxAt(found[0]) < wmaxAt(found[6]), [wmaxAt(found[0]), wmaxAt(found[6]), found[0], found[6], fbox]);
    }

    // Stay on surface (Deep paint's brush): the surface under a pixel of the points map (inpaint_surface.js
    // surfaceRegion). A wall seen at an angle, 3 m away; in front of it a slab 8 cm off the wall (a jump in depth), and
    // a block that rests on the wall along its left edge, rising to 10 cm over ten pixels (no jump there, a crease); the
    // top rows the sky
    {
        const S = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_surface.js")).href);
        const w = 320, h = 200, f = 300, n = w * h;
        const slab = [60, 60, 120, 140], wedge = [200, 60, 280, 140], skyRows = 20;
        const inBox = (b, x, y) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3];
        const pts = new Float32Array(3 * n), keep = new Float32Array(n), alpha = new Uint8Array(4 * n);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (y < skyRows) continue;
            const a = (x + 0.5 - w / 2) / f, b = (y + 0.5 - h / 2) / f;
            // the wall: z + 0.8 X = 3; what stands in front of it is that much nearer along the wall's own depth
            let off = 0;
            if (inBox(slab, x, y)) off = 0.08;
            else if (inBox(wedge, x, y)) off = Math.min(0.10, 0.01 * (x - wedge[0]));
            const z = (3 - off) / (1 + 0.8 * a);
            pts[3 * i] = a * z; pts[3 * i + 1] = b * z; pts[3 * i + 2] = z;
            keep[i] = 1; alpha[4 * i + 3] = 255;
        }
        const packed = S.packPoints(pts, keep, w, h);
        const pmap = { data: packed.data, w, h, meta: packed.meta };
        const nmap = { data: alpha, w, h };
        const share = (r, b) => { let on = 0, all = 0; for (let y = b[1]; y < b[3]; y++) for (let x = b[0]; x < b[2]; x++) { all++; if (r.mask[y * w + x]) on++; } return on / all; };
        const wallShare = (r) => { let on = 0, all = 0; for (let y = skyRows; y < h; y++) for (let x = 0; x < w; x++) { if (inBox(slab, x, y) || inBox(wedge, x, y)) continue; all++; if (r.mask[y * w + x]) on++; } return on / all; };
        const wall = S.surfaceRegion(pmap, nmap, 160, 170);
        check("stay on surface: the wall is one surface, at any tilt", !!wall && wallShare(wall) > 0.99, wall && wallShare(wall));
        check("stay on surface: what stands off the wall is not on it", !!wall && share(wall, slab) < 0.02, wall && share(wall, slab));
        check("stay on surface: what rests on the wall is not on it either, but for the reach at its foot", !!wall && share(wall, wedge) < 0.2, wall && share(wall, wedge));
        check("stay on surface: the sky is not the wall", !!wall && share(wall, [0, 0, w, skyRows]) === 0);
        const onSlab = S.surfaceRegion(pmap, nmap, 90, 100);
        check("stay on surface: begun on the slab, it is the slab", !!onSlab && share(onSlab, slab) > 0.9 && wallShare(onSlab) < 0.01, onSlab && [share(onSlab, slab), wallShare(onSlab)]);
        // a start right beside the slab (inside the reach of its border) still finds the wall
        const beside = S.surfaceRegion(pmap, nmap, slab[2] + 1, 100);
        check("stay on surface: a start beside a border finds the surface", !!beside && wallShare(beside) > 0.99 && share(beside, slab) < 0.02, beside && [wallShare(beside), share(beside, slab)]);
        const sky = S.surfaceRegion(pmap, nmap, 100, 5);
        check("stay on surface: the sky is one surface of its own", !!sky && share(sky, [0, 0, w, skyRows]) === 1 && wallShare(sky) === 0, sky && sky.count);
        check("stay on surface: no points, no answer", S.surfaceRegion({ data: packed.data, w, h, meta: {} }, nmap, 10, 10) === null);
    }

    for (const f of fails) console.log("[FAIL wrap]", f);
    console.log(fails.length ? "FAIL" : "PASS");
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
