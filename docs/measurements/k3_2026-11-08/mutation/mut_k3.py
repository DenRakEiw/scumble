"""Mutation round for K3 (crc32, png_chunk_frame, crc32Combine, PngStreamWriter / OraBandWriter entry CRC)."""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

MUTANTS = [
    {
        "id": "M01_poly_lsb",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };",
        "replace": "c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8321 } else { c >> 1 };",
        "expect": "killed",
        "note": "Reflected polynomial LSB mutated",
    },
    {
        "id": "M02_slice_table_shift",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "t[s][i] = t[0][(prev & 0xFF) as usize] ^ (prev >> 8);",
        "replace": "t[s][i] = t[0][(prev & 0xFF) as usize] ^ (prev >> 7);",
        "expect": "killed",
        "note": "Slice-by-16 table step shift 8 -> 7",
    },
    {
        "id": "M03_crc_init_no_invert",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "let mut c = !start;",
        "replace": "let mut c = start;",
        "expect": "killed",
        "note": "Initial CRC state not inverted",
    },
    {
        "id": "M04_crc_final_no_invert",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "    for &byte in chunks.remainder() {\n        c = CRC_TABLE[0][((c ^ byte as u32) & 0xFF) as usize] ^ (c >> 8);\n    }\n    !c",
        "replace": "    for &byte in chunks.remainder() {\n        c = CRC_TABLE[0][((c ^ byte as u32) & 0xFF) as usize] ^ (c >> 8);\n    }\n    c",
        "expect": "killed",
        "note": "Final CRC state not inverted",
    },
    {
        "id": "M05_crc_d0_no_xor_c",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "let d0 = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) ^ c;",
        "replace": "let d0 = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);",
        "expect": "killed",
        "note": "16-byte block drops running CRC state c",
    },
    {
        "id": "M06_crc_lane15_to_14",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "c = CRC_TABLE[15][(d0 & 0xFF) as usize]",
        "replace": "c = CRC_TABLE[14][(d0 & 0xFF) as usize]",
        "expect": "killed",
        "note": "First byte of 16-byte block uses table 14 instead of 15",
    },
    {
        "id": "M07_crc_lane0_to_1",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "^ CRC_TABLE[0][(d3 >> 24) as usize];",
        "replace": "^ CRC_TABLE[1][(d3 >> 24) as usize];",
        "expect": "killed",
        "note": "Last byte of 16-byte block uses table 1 instead of 0",
    },
    {
        "id": "M08_crc_remainder_no_shift",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "c = CRC_TABLE[0][((c ^ byte as u32) & 0xFF) as usize] ^ (c >> 8);",
        "replace": "c = CRC_TABLE[0][((c ^ byte as u32) & 0xFF) as usize];",
        "expect": "killed",
        "note": "Remainder byte loop drops (c >> 8)",
    },
    {
        "id": "M09_frame_len_le",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "buf[0..4].copy_from_slice(&(data_len as u32).to_be_bytes());",
        "replace": "buf[0..4].copy_from_slice(&(data_len as u32).to_le_bytes());",
        "expect": "killed",
        "note": "Chunk length written as little-endian instead of big-endian",
    },
    {
        "id": "M10_frame_kind_le",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "buf[4..8].copy_from_slice(&kind.to_be_bytes());",
        "replace": "buf[4..8].copy_from_slice(&kind.to_le_bytes());",
        "expect": "killed",
        "note": "Chunk type written as little-endian instead of big-endian",
    },
    {
        "id": "M11_frame_crc_includes_len",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "let crc = crc32(&buf[4..8 + data_len], 0);",
        "replace": "let crc = crc32(&buf[0..8 + data_len], 0);",
        "expect": "killed",
        "note": "Chunk CRC includes the 4-byte length field",
    },
    {
        "id": "M12_frame_crc_omits_kind",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "let crc = crc32(&buf[4..8 + data_len], 0);",
        "replace": "let crc = crc32(&buf[8..8 + data_len], 0);",
        "expect": "killed",
        "note": "Chunk CRC omits the 4-byte type field",
    },
    {
        "id": "M13_frame_crc_trailer_le",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "buf[8 + data_len..12 + data_len].copy_from_slice(&crc.to_be_bytes());",
        "replace": "buf[8 + data_len..12 + data_len].copy_from_slice(&crc.to_le_bytes());",
        "expect": "killed",
        "note": "Chunk CRC trailer written as little-endian instead of big-endian",
    },
    {
        "id": "M14_frame_return_zero",
        "file": "crates/px/src/png.rs",
        "rust": True,
        "find": "    buf[8 + data_len..12 + data_len].copy_from_slice(&crc.to_be_bytes());\n    crc",
        "replace": "    buf[8 + data_len..12 + data_len].copy_from_slice(&crc.to_be_bytes());\n    0",
        "expect": "killed",
        "note": "chunk_frame returns 0 instead of crc",
    },
    {
        "id": "M15_combine_zero_len",
        "file": "renderer/editor/inpaint_png.js",
        "rust": False,
        "find": "if (!(len2 > 0)) return c1;",
        "replace": "if (!(len2 > 0)) return 0;",
        "expect": "killed",
        "note": "crc32Combine returns 0 instead of crc1 when len2 <= 0",
    },
    {
        "id": "M16_combine_bit_invert",
        "file": "renderer/editor/inpaint_png.js",
        "rust": False,
        "find": "if (n & 1) c1 = gf2MatrixTimes(CRC_POW2[b], c1);",
        "replace": "if (!(n & 1)) c1 = gf2MatrixTimes(CRC_POW2[b], c1);",
        "expect": "killed",
        "note": "crc32Combine shifts on 0 bits instead of 1 bits of len2",
    },
    {
        "id": "M17_combine_drop_crc2",
        "file": "renderer/editor/inpaint_png.js",
        "rust": False,
        "find": "return (c1 ^ (crc2 >>> 0)) >>> 0;",
        "replace": "return c1 >>> 0;",
        "expect": "killed",
        "note": "crc32Combine omits XOR with crc2",
    },
    {
        "id": "M18_writer_combine_len_no_minus8",
        "file": "renderer/editor/inpaint_png.js",
        "rust": False,
        "find": "crc = crc32Combine(crc, r.crc >>> 0, c.byteLength - 8);",
        "replace": "crc = crc32Combine(crc, r.crc >>> 0, c.byteLength);",
        "expect": "killed",
        "note": "PngStreamWriter combines r.crc over c.byteLength instead of c.byteLength - 8",
    },
    {
        "id": "M19_writer_combine_drop_trailer",
        "file": "renderer/editor/inpaint_png.js",
        "rust": False,
        "find": "crc = crc32(c.subarray(c.byteLength - 4), crc);",
        "replace": "crc = crc;",
        "expect": "killed",
        "note": "PngStreamWriter omits the 4-byte chunk CRC trailer from the file CRC",
    },
    {
        "id": "M20_pngpart_bytes_subarray_offset",
        "file": "renderer/editor/px/px.js",
        "rust": False,
        "find": "const bytes = chunk.subarray(8, 8 + written);",
        "replace": "const bytes = chunk.subarray(0, written);",
        "expect": "killed",
        "note": "pngPart bytes subarray starts at 0 instead of 8",
    },
    {
        "id": "M21_combine_loop_b17",
        "file": "renderer/editor/inpaint_png.js",
        "rust": False,
        "find": "for (let b = 0; n > 0 && b < 32; b++, n = Math.floor(n / 2)) {",
        "replace": "for (let b = 0; n > 0 && b < 17; b++, n = Math.floor(n / 2)) {",
        "expect": "killed",
        "note": "crc32Combine stops at bit 16 (64 KB) instead of bit 31 (15k part ~7.7 MB)",
    },
]


def build_wasm():
    r = subprocess.run([sys.executable, "tools/build_px.py"], cwd=ROOT, capture_output=True, text=True)
    return r.returncode == 0, r.stdout + r.stderr


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
    need_rebuild = False
    try:
        for m in MUTANTS:
            p = os.path.join(ROOT, m["file"])
            src = originals[p]
            if m["find"] not in src:
                raise RuntimeError(f"Target not found for {m['id']} in {m['file']}")
            mutated = src.replace(m["find"], m["replace"], 1)
            with open(p, "w", encoding="utf-8", newline="") as f:
                f.write(mutated)
            t0 = time.time()
            try:
                if m["rust"]:
                    need_rebuild = True
                    ok_build, build_out = build_wasm()
                    if not ok_build:
                        status = "unviable"
                        detail = build_out.strip().splitlines()[-1] if build_out.strip() else "build failed"
                    else:
                        ok_test, test_out = run_test()
                        status = "survived" if ok_test else "killed"
                        fails = [l for l in test_out.splitlines() if l.startswith("FAIL")]
                        detail = fails[0] if fails else "all checks passed"
                else:
                    if need_rebuild:
                        build_wasm()
                        need_rebuild = False
                    ok_test, test_out = run_test()
                    status = "survived" if ok_test else "killed"
                    fails = [l for l in test_out.splitlines() if l.startswith("FAIL")]
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
        if need_rebuild:
            build_wasm()

    killed = sum(1 for r in results if r["status"] == "killed")
    survived = sum(1 for r in results if r["status"] == "survived")
    unexpected = sum(1 for r in results if r["unexpected"])
    report = {
        "target": "K3 (crc32, png_chunk_frame, crc32Combine, OraBandWriter combined CRC)",
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
        f"K3 Mutation Round ({len(results)} mutants, {report['seconds']}s):",
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
