// The phase B benchmark in Node (docs/PLAN_BCE.md §B3). Firefox runs the same rows through
// tools/px_bench.html; both import renderer/editor/px/bench.js.
//
//     node tools/px_bench.js [--sizes 96,150] [--only mip,edt,flood,composite,png,tiles,copy]
//                            [--runs 5] [--warmups 2] [--json out.json]
//
// Electron's own V8 (the renderer's JS engine) runs it without a window:
//     set ELECTRON_RUN_AS_NODE=1 && node_modules\electron\dist\electron.exe tools\px_bench.js
//
// Restart nothing else while it runs: it is a CPU benchmark, other load moves the numbers.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.dirname(__dirname);
const PX_DIR = path.join(ROOT, "renderer", "editor", "px");

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
    const imp = (p) => import(pathToFileURL(p).href);
    const { loadPx } = await imp(path.join(PX_DIR, "px.js"));
    const js = await imp(path.join(PX_DIR, "kernels_js.js"));
    const bench = await imp(path.join(PX_DIR, "bench.js"));
    const raster = await imp(path.join(ROOT, "renderer", "editor", "inpaint_raster.js"));
    const simd = await loadPx(fs.readFileSync(path.join(PX_DIR, "px.wasm")));
    const scalar = await loadPx(fs.readFileSync(path.join(PX_DIR, "px_scalar.wasm")));

    const env = {
        runtime: process.versions.electron ? `Electron ${process.versions.electron} (ELECTRON_RUN_AS_NODE)` : `Node ${process.versions.node}`,
        v8: process.versions.v8,
        cpu: os.cpus()[0].model.trim(),
        date: new Date().toISOString(),
    };
    console.log(`${env.runtime}, V8 ${env.v8}, ${env.cpu}`);
    const t0 = Date.now();
    const result = await bench.runBench({
        impls: { js, scalar, simd },
        extras: { distanceTransform: raster.distanceTransform, floodMask: raster.floodMask },
        sizes: arg("sizes", "96,150").split(","),
        only: arg("only", null)?.split(","),
        runs: Number(arg("runs", 5)),
        warmups: Number(arg("warmups", 2)),
        log: (line) => console.log(line),
    });
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    const out = arg("json", null);
    if (out) {
        fs.writeFileSync(out, JSON.stringify({ env, ...result }, null, 2));
        console.log(`wrote ${out}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
