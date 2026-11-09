"""Mutation round for K10b (tilesRowsToWasm, storeRowsToWasm, stackRowsToWasm, partPtrOf, pngPartFromPtr, pngPart)."""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

MUTANTS = [
    {
        "id": "M01_empty_layer_counted",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "find": "            if (!storeRowsToWasm(p, l, X0, W, Y0, n, psrc, false)) {\n                scratchSrc = psrc;\n                continue;\n            }",
        "replace": "            storeRowsToWasm(p, l, X0, W, Y0, n, psrc, false);",
        "expect": "killed",
        "note": "K10b mutant 1: drop if (!storeRowsToWasm(...)) continue so an empty layer is counted over a soft-alpha base",
    },
    {
        "id": "M02_drop_count_gt_0_guard",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "find": "    if (count > 0) {",
        "replace": "    if (count >= 0) {",
        "expect": "killed",
        "note": "K10b mutant 2: remove count > 0 guard before composite_tile so layers: [] calls composite_tile",
    },
    {
        "id": "M03_prev_tiles_r0_zero",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "find": "        else if (msg.prevTiles) { tiles = msg.prevTiles; r0 = TILE - 1; rows = 1; }",
        "replace": "        else if (msg.prevTiles) { tiles = msg.prevTiles; r0 = 0; rows = 1; }",
        "expect": "killed",
        "note": "K10b mutant 3: change r0 = TILE - 1 on msg.prevTiles branch to r0 = 0",
    },
    {
        "id": "M04_ignore_store_offset_sx",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "find": "export function storeRowsToWasm(p, store, X0, W, Y0, n, ptr, alphaOnly = false) {\n    const sx = store.x | 0, sy = store.y | 0;",
        "replace": "export function storeRowsToWasm(p, store, X0, W, Y0, n, ptr, alphaOnly = false) {\n    const sx = 0, sy = store.y | 0;",
        "expect": "killed",
        "note": "K10b mutant 4: ignore store.x in storeRowsToWasm",
    },
    {
        "id": "M05_reuse_pcov_across_clipped_layers",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "find": "    let count = 0, scratchSrc = 0;\n    for (const l of st.layers) {",
        "replace": "    let count = 0, scratchSrc = 0, sharedPcov = 0;\n    for (const l of st.layers) {",
        "find2": "            const pcov = a.take(px);",
        "replace2": "            const pcov = sharedPcov || (sharedPcov = a.take(px));",
        "expect": "killed",
        "note": "K10b mutant 5: reuse a single pcov buffer across clipped layers instead of allocating per clipped layer",
    },
    {
        "id": "M06a_skip_clip_coverage",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "find": "                clipCoverage(covView, bmView, c.alpha, ownView);",
        "replace": "                void covView;",
        "expect": "killed",
        "note": "K10b mutant 6a: skip clipCoverage call in stackRowsToWasm",
    },
    {
        "id": "M06b_dissolve_shift_16",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "find": "                        const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal);",
        "replace": "                        const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 16) < cVal);",
        "expect": "killed",
        "note": "K10b mutant 6b: mutate >>> 24 to >>> 16 in stackRowsToWasm inline JS dissolve loop",
    },
    {
        "id": "M07_stale_mem_view_across_take",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "find": "    let count = 0, scratchSrc = 0;\n    for (const l of st.layers) {\n        const psrc = scratchSrc || a.take(byteLen);",
        "replace": "    const staleMem = p.u8();\n    let count = 0, scratchSrc = 0;\n    for (const l of st.layers) {\n        const psrc = scratchSrc || a.take(byteLen);",
        "find2": "            p.u8().fill(0, psrc, psrc + byteLen);",
        "replace2": "            staleMem.fill(0, psrc, psrc + byteLen);",
        "expect": "killed",
        "note": "K10b mutant 7: hold p.u8() before the layer loop and use it after a.take across memory.grow",
    },
    {
        "id": "M08_dissolve_drop_cval_255_guard",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "find": "                        const keep = (cVal === 255) || ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal);",
        "replace": "                        const keep = ((hash32(imgX, imgY, l.dissolve) >>> 24) < cVal);",
        "expect": "killed",
        "note": "Drop cVal === 255 short-circuit in stackRowsToWasm dissolve loop (drops pixels where hash32 >>> 24 === 255)",
    },
    {
        "id": "M09_match_pixels_skip",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "find": "                p.exports.match_pixels(psrc, px, pp);",
        "replace": "                void pp;",
        "expect": "killed",
        "note": "Skip match_pixels call in stackRowsToWasm",
    },
    {
        "id": "M10_partptrof_stack_skip_above",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "find": "        if (needPrev && (msg.y | 0) > 0) {\n            pp = stackRowsToWasm(p, a, msg, true, null);\n        }",
        "replace": "        if (false && needPrev && (msg.y | 0) > 0) {\n            pp = stackRowsToWasm(p, a, msg, true, null);\n        }",
        "expect": "killed",
        "note": "Skip above-row stackRowsToWasm pass in partPtrOf when msg.y > 0",
    },
    {
        "id": "M11_pngpart_composewasm_flag_0",
        "file": "renderer/editor/inpaint_worker.js",
        "rust": False,
        "find": "                    op: \"png_part\", kernels: \"rust\", composeWasm: 1,",
        "replace": "                    op: \"png_part\", kernels: \"rust\", composeWasm: 0,",
        "expect": "killed",
        "note": "Report composeWasm: 0 instead of 1 on the pointer path in pngPart",
    },
    {
        "id": "M12_pngpartfromptr_ignore_pp",
        "file": "renderer/editor/px/px.js",
        "rust": False,
        "find": "        this.exports.png_filter_rows(pr, w, rows, pp, pf);",
        "replace": "        this.exports.png_filter_rows(pr, w, rows, 0, pf);",
        "expect": "killed",
        "note": "Pass pp = 0 instead of pp to png_filter_rows in pngPartFromPtr",
    },
    {
        "id": "M13_pngpartfromptr_bytes_offset_0",
        "file": "renderer/editor/px/px.js",
        "rust": False,
        "find": "    pngPartFromPtr(a, pr, w, rows, pp, level, last, laps = null) {",
        "replace": "    pngPartFromPtr(a, pr, w, rows, pp, level, last, laps = null) {",
        "find2": "                const chunk = this.u8().slice(po, po + written + 12);\n                const bytes = chunk.subarray(8, 8 + written);",
        "replace2": "                const chunk = this.u8().slice(po, po + written + 12);\n                const bytes = chunk.subarray(0, written);",
        "expect": "killed",
        "note": "Slice bytes from offset 0 instead of 8 in pngPartFromPtr",
    },
    {
        "id": "M14_pngpartfromptr_zero_adler",
        "file": "renderer/editor/px/px.js",
        "rust": False,
        "find": "        if (lap) lap(\"filter\");\n        const adler = this.exports.adler32(pf, n, 1) >>> 0;\n        if (lap) lap(\"adler\");\n        let cap = storedCap(n);\n        for (;;) {\n            const po = a.take(cap + 12);\n            const written = this.exports.deflate_part(pf, n, level, last ? 1 : 0, po + 8, cap);",
        "replace": "        if (lap) lap(\"filter\");\n        const adler = 0;\n        if (lap) lap(\"adler\");\n        let cap = storedCap(n);\n        for (;;) {\n            const po = a.take(cap + 12);\n            const written = this.exports.deflate_part(pf, n, level, last ? 1 : 0, po + 8, cap);",
        "expect": "killed",
        "note": "Return adler = 0 in pngPartFromPtr",
    },
]


def run_test():
    env = os.environ.copy()
    env["PX_ONLY"] = "pngPart"
    r = subprocess.run(["node", "tools/px_test.js"], cwd=ROOT, env=env, capture_output=True, text=True)
    return r.returncode == 0, r.stdout + r.stderr


def main():
    originals = {}
    for m in MUTANTS:
        p = os.path.join(ROOT, m["file"])
        if p not in originals:
            with open(p, "r", encoding="utf-8", newline="") as f:
                originals[p] = f.read()

    results = []
    t_start = time.time()
    try:
        for m in MUTANTS:
            p = os.path.join(ROOT, m["file"])
            src = originals[p]
            if m["find"] not in src:
                raise RuntimeError(f"Target not found for {m['id']} in {m['file']}")
            mutated = src.replace(m["find"], m["replace"], 1)
            if "find2" in m:
                if m["find2"] not in mutated:
                    raise RuntimeError(f"Target find2 not found for {m['id']} in {m['file']}")
                mutated = mutated.replace(m["find2"], m["replace2"], 1)
            with open(p, "w", encoding="utf-8", newline="") as f:
                f.write(mutated)
            t0 = time.time()
            try:
                ok_test, test_out = run_test()
                status = "survived" if ok_test else "killed"
                fails = [l for l in test_out.splitlines() if l.startswith("FAIL") or "Error:" in l]
                detail = fails[0] if fails else "all checks passed"
            finally:
                with open(p, "w", encoding="utf-8", newline="") as f:
                    f.write(src)
            dt = round(time.time() - t0, 2)
            unexpected = status != m["expect"]
            res = {
                "id": m["id"],
                "file": m["file"],
                "status": status,
                "expect": m["expect"],
                "unexpected": unexpected,
                "seconds": dt,
                "detail": detail,
                "note": m["note"],
            }
            results.append(res)
            print(f"[{m['id']}] {status.upper()} (expected {m['expect']}, {dt}s): {detail}", flush=True)
    finally:
        for p, src in originals.items():
            with open(p, "w", encoding="utf-8", newline="") as f:
                f.write(src)

    killed = sum(1 for r in results if r["status"] == "killed")
    survived = sum(1 for r in results if r["status"] == "survived")
    unexpected = sum(1 for r in results if r["unexpected"])
    report = {
        "target": "K10b (tilesRowsToWasm, storeRowsToWasm, stackRowsToWasm, partPtrOf, pngPartFromPtr, pngPart)",
        "total": len(results),
        "killed": killed,
        "survived": survived,
        "unexpected_survivors": unexpected,
        "seconds": round(time.time() - t_start, 1),
        "mutants": results,
    }
    with open(os.path.join(OUT_DIR, "report.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(report, f, indent=2)
    summary_lines = [
        f"K10b Mutation Round ({len(results)} mutants, {report['seconds']}s):",
        f"  Killed: {killed}/{len(results)}, Survived: {survived}, Unexpected survivors: {unexpected}",
        "",
    ]
    for r in results:
        summary_lines.append(f"  {r['id']}: {r['status']} (expect {r['expect']}, {r['seconds']}s) - {r['note']} [{r['detail']}]")
    with open(os.path.join(OUT_DIR, "summary.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(summary_lines) + "\n")
    print("\n".join(summary_lines), flush=True)
    if unexpected:
        sys.exit(1)


if __name__ == "__main__":
    main()
