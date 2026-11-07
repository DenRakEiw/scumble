// A Node micro-bench of tileWithGutter at level 0: the store's (P10) against the old code's twin (from the test file).
const fs = require("node:fs"), path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const ROOT = process.argv[2];
globalThis.ImageData = globalThis.ImageData || class { constructor(a, b, c) { this.data = a; this.width = b; this.height = c; } };
globalThis.document = globalThis.document || { createElement() { return { getContext() { return null; } }; } };
(async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u, ...r) => { const s = String(u && u.href ? u.href : u); return s.startsWith("file:") ? new Response(fs.readFileSync(fileURLToPath(s))) : realFetch(u, ...r); };
    const K = await import(pathToFileURL(path.join(ROOT, "renderer/editor/px/kernels.js")).href); await K.kernelsReady();
    globalThis.fetch = realFetch;
    const T = await import(pathToFileURL(path.join(ROOT, "renderer/editor/inpaint_tiles.js")).href);
    const src = fs.readFileSync(path.join(ROOT, "tools/gutter_words_test.js"), "utf8");
    const twinSrc = src.slice(src.indexOf("const PM = new Uint8Array"), src.indexOf("// ---- tile contents"));
    const twin = new Function("TS", twinSrc + "; return twinTileWithGutter;")(256);
    for (const kind of ["opaque", "transparent", "soft"]) {
        const p = new T.TileLayerPixels(2560, 2560);
        for (let ty = 0; ty < 10; ty++) for (let tx = 0; tx < 10; tx++) {
            const d = p.writable(tx, ty).data;
            for (let i = 0; i < d.length; i += 4) { d[i] = i & 255; d[i + 1] = (i >> 8) & 255; d[i + 2] = 77; d[i + 3] = kind === "opaque" ? 255 : kind === "transparent" ? 0 : 1 + (i >> 2) % 254; }
        }
        const out = new Uint8Array(258 * 258 * 4);
        const time = (fn) => { const ts = []; for (let r = 0; r < 7; r++) { const a = performance.now(); for (let ty = 0; ty < 10; ty++) for (let tx = 0; tx < 10; tx++) fn(tx, ty); ts.push(performance.now() - a); } ts.sort((x, y) => x - y); return ts[3]; };
        const o = time((tx, ty) => twin(p, tx, ty, 0, out)), n = time((tx, ty) => p.tileWithGutter(tx, ty, 0, out));
        const o2 = time((tx, ty) => twin(p, tx, ty, 0, out)), n2 = time((tx, ty) => p.tileWithGutter(tx, ty, 0, out));
        console.log(`${kind}: 100 slots old ${o.toFixed(1)} / ${o2.toFixed(1)} ms, new ${n.toFixed(1)} / ${n2.toFixed(1)} ms; ns/px old ${(o2 * 1e6 / (100 * 258 * 258)).toFixed(2)} new ${(n2 * 1e6 / (100 * 258 * 258)).toFixed(2)}`);
    }
})();
