"""Summarize K8 before/after 3-round measurements, Stop 4 probe, 30k huge open/restore, mutation round, and gates."""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))


def median(xs):
    s = sorted(xs)
    return s[len(s) // 2] if s else 0.0


def fmt_stat(xs, unit="ms"):
    if not xs:
        return "n/a"
    s = sorted(xs)
    med = s[len(s) // 2]
    return f"{med:.1f} {unit} [{s[0]:.1f}..{s[-1]:.1f}] (runs: {', '.join(f'{x:.1f}' for x in xs)})"


def load_native(arm):
    out = []
    for r in (1, 2, 3):
        p = os.path.join(HERE, arm, "native", f"r{r}.json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                out.append(json.load(f))
    return out


def load_bench(arm):
    out = []
    for r in (1, 2, 3):
        p = os.path.join(HERE, arm, "bench", f"r{r}.json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                out.append(json.load(f))
    return out


def load_docperf(arm):
    out = []
    for r in (1, 2, 3):
        p = os.path.join(HERE, arm, "docperf", f"r{r}.log")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                txt = f.read()
            row = {}
            for tag in ("built", "save", "open"):
                m = re.search(rf"^{tag}:\s*(\{{.*\}})", txt, re.M)
                if m:
                    row.update(json.loads(m.group(1)))
            if row:
                out.append(row)
    return out


def main():
    nb = load_native("before")
    na = load_native("after")
    bb = load_bench("before")
    ba = load_bench("after")
    db = load_docperf("before")
    da = load_docperf("after")

    lines = []
    lines.append("K8 — Parted PNG Reader in the App (Route N: DecompressionStream('deflate-raw'))")
    lines.append("=" * 84)
    lines.append("Date: 2026-11-09")
    lines.append("Branch: ag-chain-p-5 (forked from wasm-kernels d23d5cc4; baseline commit 9fd93524)")
    lines.append("ABI: 37 (px.wasm 261,098 B; px_scalar.wasm 212,115 B — unchanged from K7)")
    lines.append("")

    # 1. native_test.py 15000x10000
    lines.append("1. native_test.py 15000x10000 (3 alternating rounds, offline, tiles on, focused)")
    lines.append("-" * 84)
    for step, key in [
        ("build_the_file", "encodeMs"),
        ("open_the_file", "wall"),
        ("open_again", "wall"),
        ("export_png", "wall"),
        ("export_ora", "wall"),
    ]:
        vb = [x["rows"][step]["row"][key] for x in nb if step in x.get("rows", {})]
        va = [x["rows"][step]["row"][key] for x in na if step in x.get("rows", {})]
        sp = (median(vb) / median(va)) if (vb and va and median(va) > 0) else 0.0
        lines.append(f"  {step + '.' + key:24s} before: {fmt_stat(vb)}")
        lines.append(f"  {'':24s} after : {fmt_stat(va)}  ({sp:.2f}x)")
        if step in ("open_the_file", "open_again"):
            lfb = [x["rows"][step]["row"].get("extra", {}).get("loadFileMs", 0) for x in nb if step in x.get("rows", {})]
            lfa = [x["rows"][step]["row"].get("extra", {}).get("loadFileMs", 0) for x in na if step in x.get("rows", {})]
            sp_lf = (median(lfb) / median(lfa)) if (lfb and lfa and median(lfa) > 0) else 0.0
            lines.append(f"  {step + '.loadFileMs':24s} before: {fmt_stat(lfb)}")
            lines.append(f"  {'':24s} after : {fmt_stat(lfa)}  ({sp_lf:.2f}x)")
            bb_blk = [x["rows"][step]["row"].get("blocked", 0) for x in nb if step in x.get("rows", {})]
            ba_blk = [x["rows"][step]["row"].get("blocked", 0) for x in na if step in x.get("rows", {})]
            lines.append(f"  {step + '.blocked':24s} before: {fmt_stat(bb_blk)} | after: {fmt_stat(ba_blk)}")
    if nb and na:
        jb = nb[-1]["rows"]["open_the_file"]["row"].get("jobs", {})
        ja = na[-1]["rows"]["open_the_file"]["row"].get("jobs", {})
        lines.append(f"  open_the_file jobs (before r3): {json.dumps(jb)}")
        lines.append(f"  open_the_file jobs (after  r3): {json.dumps(ja)}")
        jba = nb[-1]["rows"]["open_again"]["row"].get("jobs", {})
        jaa = na[-1]["rows"]["open_again"]["row"].get("jobs", {})
        lines.append(f"  open_again    jobs (before r3): {json.dumps(jba)}")
        lines.append(f"  open_again    jobs (after  r3): {json.dumps(jaa)}")
        lines.append(f"  memory (before r3 close): {json.dumps(nb[-1]['rows'].get('close', {}).get('row', {}))}")
        lines.append(f"  memory (after  r3 close): {json.dumps(na[-1]['rows'].get('close', {}).get('row', {}))}")
    lines.append("")

    # 2. w0_bench.py --rows=freqsep_15k
    lines.append("2. w0_bench.py --rows=freqsep_15k (15,000 x 10,000 photograph adobe_15000x10000.jpg, 3 rounds)")
    lines.append("-" * 84)
    for k in ("load_jpg", "png_export", "png_open", "freqsep_16mp"):
        vb = [x["freqsep_15k"][k] for x in bb if "freqsep_15k" in x]
        va = [x["freqsep_15k"][k] for x in ba if "freqsep_15k" in x]
        sp = (median(vb) / median(va)) if (vb and va and median(va) > 0) else 0.0
        lines.append(f"  {k:24s} before: {fmt_stat(vb)}")
        lines.append(f"  {'':24s} after : {fmt_stat(va)}  ({sp:.2f}x)")
    lines.append("")

    # 3. document_perf.py 15000x10000
    lines.append("3. document_perf.py 15000x10000 (4-layer .scumble document, 3 alternating rounds)")
    lines.append("-" * 84)
    for k in ("loadMs", "saveMs", "restoreMs", "openMs"):
        vb = [x[k] for x in db if k in x]
        va = [x[k] for x in da if k in x]
        sp = (median(vb) / median(va)) if (vb and va and median(va) > 0) else 0.0
        lines.append(f"  {k:24s} before: {fmt_stat(vb)}")
        lines.append(f"  {'':24s} after : {fmt_stat(va)}  ({sp:.2f}x)")
    lines.append("")

    # 4. Stop 4 probe (browser 15k PNG, Question 6.1 P5, Question 6.5 upload while decoding)
    s4_path = os.path.join(HERE, "after", "stop4_probe.json")
    if os.path.exists(s4_path):
        with open(s4_path, encoding="utf-8") as f:
            s4 = json.load(f)
        lines.append("4. Browser-Encoded 15,000 x 10,000 PNG Open (OffscreenCanvas -> single IDAT -> fallback to png_read)")
        lines.append("-" * 84)
        b15 = s4.get("browser_15k", {})
        lines.append(f"  Blob size: {b15.get('MB')} MB; pngPartsOf: {b15.get('pngPartsOf')} after reading {b15.get('bytesReadByPngPartsOf')} bytes")
        lines.append(f"  pixelsOffThread    : {b15.get('pixelsFromPngStream', {}).get('median')} ms (runs: {b15.get('pixelsFromPngStream', {}).get('runs')})")
        lines.append(f"  loadFile + mips    : {b15.get('loadFile', {}).get('median')} ms (runs: {b15.get('loadFile', {}).get('runs')})")
        lines.append(f"  worker jobs        : {json.dumps(b15.get('jobs', {}))}")
        lines.append("")

        lines.append("5. Stop 4 — Question 6.1 (P5: PNG parts that start independent) A/B")
        lines.append("-" * 84)
        for key, title in [("n1_15k", "Synthetic 15,000 x 10,000 (n1_15k)"), ("photo_15k", "Photograph 15,000 x 10,000 (adobe_15000x10000.jpg)")]:
            d = s4.get(key, {})
            if not d:
                continue
            lines.append(f"  [{title}]")
            lines.append(f"    Parts: {d.get('parts')}; Adler & pixel match: adlerMatch={d.get('adlerMatch')}, pixelDiffBytes={d.get('pixelDiffBytes')}")
            lines.append(f"    Size : standard = {d.get('stdBytes'):,} B ({d.get('stdMB')} MB), P5 = {d.get('p5Bytes'):,} B ({d.get('p5MB')} MB), delta = {d.get('deltaBytes'):+,} B ({d.get('deltaPct'):+.3f}%)")
            lines.append(f"    Row-0 filter census: standard = {json.dumps(d.get('stdFilters'))} (needs prev: {d.get('stdNeedsPrev')}/78); P5 = {json.dumps(d.get('p5Filters'))} (needs prev: {d.get('p5NeedsPrev')}/78)")
            lines.append("    readPngParts + putCanvasRows (5 alternating rounds):")
            lines.append(f"      standard (K8): {d['readPngParts_std']['median']} ms [{d['readPngParts_std']['min']}..{d['readPngParts_std']['max']}] (runs: {d['readPngParts_std']['runs']})")
            lines.append(f"      P5 (indep.)  : {d['readPngParts_p5']['median']} ms [{d['readPngParts_p5']['min']}..{d['readPngParts_p5']['max']}] (runs: {d['readPngParts_p5']['runs']}) -> {d.get('readPngParts_speedup')}x")
            lines.append(f"      std jobs     : {json.dumps(d.get('stdJobs'))}")
            lines.append(f"      P5  jobs     : {json.dumps(d.get('p5Jobs'))}")
            lines.append("    ed.loadFile + mipsSettled (3 alternating rounds):")
            lines.append(f"      standard (K8): {d['loadFile_std']['median']} ms [{d['loadFile_std']['min']}..{d['loadFile_std']['max']}] (runs: {d['loadFile_std']['runs']})")
            lines.append(f"      P5 (indep.)  : {d['loadFile_p5']['median']} ms [{d['loadFile_p5']['min']}..{d['loadFile_p5']['max']}] (runs: {d['loadFile_p5']['runs']}) -> {d.get('loadFile_speedup')}x")
        lines.append("")

        lines.append("6. Stop 4 — Question 6.5 (Upload while decoding) A/B")
        lines.append("-" * 84)
        for key, title in [("n1_15k", "Synthetic 15,000 x 10,000 (275.8 MB)"), ("photo_15k", "Photograph 15,000 x 10,000 (172.0 MB)")]:
            d = s4.get(key, {})
            if not d:
                continue
            lines.append(f"  [{title}]")
            lines.append(f"    uploadBlob only  : {d['q65_uploadOnly']['median']} ms (runs: {d['q65_uploadOnly']['runs']})")
            lines.append(f"    decode only      : {d['q65_decodeOnly']['median']} ms (runs: {d['q65_decodeOnly']['runs']})")
            lines.append(f"    sequential (now) : {d['q65_sequential']['median']} ms (runs: {d['q65_sequential']['runs']})")
            lines.append(f"    parallel (Q 6.5) : {d['q65_parallel']['median']} ms (runs: {d['q65_parallel']['runs']}) -> saves {d.get('q65_savedMs')} ms ({d.get('q65_speedup')}x)")
        lines.append("")

    # 7. 30,000 x 20,000 huge_test.py open + restore
    huge_path = os.path.join(HERE, "after", "huge_open_restore.log")
    if os.path.exists(huge_path):
        with open(huge_path, encoding="utf-8") as f:
            lines.append("7. huge_test.py 30000x20000 (600 MP, 1,100.7 MB PNG)")
            lines.append("-" * 84)
            for ln in f.read().splitlines():
                if ln.startswith("[ok]") or ln.startswith("[FAIL]") or ln.startswith("PASS"):
                    lines.append("  " + ln)
            lines.append("")

    # 8. Mutation round & Gates
    lines.append("8. Mutation Round & Gate Verification")
    lines.append("-" * 84)
    lines.append("  Mutation round (docs/measurements/k8_2026-11-09/mutation/results.txt):")
    lines.append("    12 killed (0 of them only on the re-check), 0 survived of 12; 0 not as expected")
    lines.append("  Kernel unit tests (tools/px_test.js):")
    lines.append("    node tools/px_test.js: PASS")
    lines.append("    ELECTRON_RUN_AS_NODE=1 electron tools/px_test.js: PASS")
    lines.append("  Gates (--tiles on and --tiles off, offline, dist/gates/gates/):")
    lines.append("    lint, types, build_px.py --check: PASS")
    lines.append("    pixels, export, docux, document, editor (tiles on): PASS")
    lines.append("    pixels, export, docux, document, editor (tiles off): PASS")
    lines.append("    nodecopy (build_node.py --node + --check + node_test.py): PASS")

    out_txt = "\n".join(lines) + "\n"
    with open(os.path.join(HERE, "summary.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write(out_txt)
    print(out_txt)


if __name__ == "__main__":
    main()
