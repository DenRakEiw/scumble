/**
 * K6 kernel benchmark (docs/PLAN_WASM_BUILD.md §4.2 K6): compares before (5419c95a px.wasm), after (K6 px.wasm),
 * scalar (px_scalar.wasm, byte-identical), and the JS twin on 256-row bands at 4,096 and 15,000 px, bpp 3 and 4,
 * with and without RGBA conversion (`channels`), across Up (2), Average (3), Paeth (4), and Scumble's filter mix
 * (75.6% Paeth, 23.5% Average, 0.9% Sub from K0a/W0b `png_filter_types`).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const PX_DIR = path.join(ROOT, "renderer", "editor", "px");

const { loadPx } = await import(pathToFileURL(path.join(PX_DIR, "px.js")).href);
const js = await import(pathToFileURL(path.join(PX_DIR, "kernels_js.js")).href);

const beforeBytes = execFileSync("git", ["show", "HEAD:renderer/editor/px/px.wasm"], { cwd: ROOT, maxBuffer: 10e6 });
const afterBytes = fs.readFileSync(path.join(PX_DIR, "px.wasm"));
const scalarBytes = fs.readFileSync(path.join(PX_DIR, "px_scalar.wasm"));

const beforeSimd = await loadPx(beforeBytes);
const afterSimd = await loadPx(afterBytes);
const scalar = await loadPx(scalarBytes);

function med(xs) {
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
}

const rows = [];
for (const [W, R, runs] of [[4096, 256, 11], [15000, 256, 7]]) {
    for (const [bpp, channels] of [[3, 0], [3, 3], [4, 0], [4, 4]]) {
        const rowBytes = W * bpp, stride = rowBytes + 1;
        const src = new Uint8Array(R * stride);
        for (let i = 0; i < src.length; i++) src[i] = (i * 7 + 13) & 255;
        const out = channels ? new Uint8ClampedArray(R * W * 4) : null;
        const rgbaOpt = channels ? { w: W, channels, out } : null;

        const filterSets = [
            ["Up (2)", () => 2],
            ["Average (3)", () => 3],
            ["Paeth (4)", () => 4],
            ["Scumble mix (76% P, 23% A, 1% S)", (y) => (y % 100 === 0 ? 1 : y % 4 === 0 ? 3 : 4)],
        ];
        for (const [filterName, ftFn] of filterSets) {
            if (W === 15000 && channels === 0 && filterName !== "Scumble mix (76% P, 23% A, 1% S)" && filterName !== "Paeth (4)") continue;
            for (let y = 0; y < R; y++) src[y * stride] = ftFn(y);

            const timeOne = (k) => {
                const work = src.slice(), prev = new Uint8Array(rowBytes);
                k.pngUnfilterRows(work, R, rowBytes, bpp, prev, rgbaOpt);
                const ts = [];
                for (let r = 0; r < runs; r++) {
                    work.set(src);
                    prev.fill(0);
                    const t0 = performance.now();
                    k.pngUnfilterRows(work, R, rowBytes, bpp, prev, rgbaOpt);
                    ts.push(performance.now() - t0);
                }
                return +med(ts).toFixed(2);
            };

            const bMs = timeOne(beforeSimd);
            const aMs = timeOne(afterSimd);
            const sMs = timeOne(scalar);
            const jMs = timeOne(js);
            const rec = {
                band: `${W}x${R}`,
                bpp,
                channels,
                filter: filterName,
                before_simd_ms: bMs,
                after_simd_ms: aMs,
                scalar_ms: sMs,
                js_ms: jMs,
                speedup_vs_before: +(bMs / aMs).toFixed(2),
                speedup_vs_scalar: +(sMs / aMs).toFixed(2),
                speedup_vs_js: +(jMs / aMs).toFixed(2),
            };
            rows.push(rec);
            console.log(
                `${rec.band.padEnd(10)} bpp=${bpp} ch=${channels} ${filterName.padEnd(33)} | before ${String(bMs).padStart(6)} | after ${String(aMs).padStart(6)} | scalar ${String(sMs).padStart(6)} | js ${String(jMs).padStart(6)} | after/before ${rec.speedup_vs_before}x | vs scalar ${rec.speedup_vs_scalar}x | vs js ${rec.speedup_vs_js}x`
            );
        }
    }
}

const outPath = process.argv[2];
if (outPath) fs.writeFileSync(outPath, JSON.stringify({ runtime: process.versions.electron ? "electron" : "node", v8: process.versions.v8, rows }, null, 2) + "\n");
process.exit(0);
