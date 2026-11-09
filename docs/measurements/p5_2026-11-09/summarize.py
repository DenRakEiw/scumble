"""Summarize P5 + Question 6.5 before/after 3-round measurements, mutation round, and gates."""
import json
import os

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


def main():
    nb = load_native("before")
    na = load_native("after")
    bb = load_bench("before")
    ba = load_bench("after")

    lines = []
    lines.append("P5 (Independent PNG Part Starts) + Question 6.5 (Parallel Upload While Decoding)")
    lines.append("=" * 84)
    lines.append("Date: 2026-11-09")
    lines.append("Base: wasm-kernels 9a5f1681")
    lines.append("ABI: 42")
    lines.append("  before (9a5f1681): px.wasm 279,003 B (sha256 aeb476777e971bbd); px_scalar.wasm 225,584 B (sha256 920cb56151a5a0fc)")
    lines.append("  after  (P5)      : px.wasm 278,242 B (sha256 7923cd0278a8c0cb, -761 B); px_scalar.wasm 225,743 B (sha256 203a16365f2ec7e7, +159 B)")
    lines.append("")

    # 1. native_test.py 15000x10000
    lines.append("1. native_test.py 15000x10000 (3 alternating rounds, offline, tiles on, focused)")
    lines.append("-" * 84)
    for step, key in [
        ("build_the_file", "encodeMs"),
        ("build_the_file", "MB"),
        ("open_the_file", "wall"),
        ("open_again", "wall"),
        ("export_png", "wall"),
        ("export_png", "MB"),
        ("export_ora", "wall"),
        ("export_ora", "MB"),
    ]:
        unit = "MB" if key == "MB" else "ms"
        if key == "MB" and step in ("export_png", "export_ora"):
            vb = [x["rows"][step]["row"].get("extra", {}).get("MB", 0) for x in nb if step in x.get("rows", {})]
            va = [x["rows"][step]["row"].get("extra", {}).get("MB", 0) for x in na if step in x.get("rows", {})]
        else:
            vb = [x["rows"][step]["row"][key] for x in nb if step in x.get("rows", {})]
            va = [x["rows"][step]["row"][key] for x in na if step in x.get("rows", {})]
        sp = (median(vb) / median(va)) if (vb and va and median(va) > 0 and unit == "ms") else 0.0
        suf = f"  ({sp:.2f}x)" if unit == "ms" else ""
        lines.append(f"  {step + '.' + key:24s} before: {fmt_stat(vb, unit)}")
        lines.append(f"  {'':24s} after : {fmt_stat(va, unit)}{suf}")
        if step in ("open_the_file", "open_again", "export_png", "export_ora") and key == "wall":
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
        for step in ("open_the_file", "open_again", "export_png", "export_ora"):
            jb = nb[-1]["rows"].get(step, {}).get("row", {}).get("jobs", {})
            ja = na[-1]["rows"].get(step, {}).get("row", {}).get("jobs", {})
            lines.append(f"  {step:14s} jobs (before r3): {json.dumps(jb)}")
            lines.append(f"  {step:14s} jobs (after  r3): {json.dumps(ja)}")
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
        if k in ("load_jpg", "png_export", "png_open", "freqsep_16mp"):
            blkb = [x["freqsep_15k"].get("blocked", {}).get(k, {}).get("blockedMax", 0) for x in bb if "freqsep_15k" in x]
            blka = [x["freqsep_15k"].get("blocked", {}).get(k, {}).get("blockedMax", 0) for x in ba if "freqsep_15k" in x]
            if any(blkb) or any(blka):
                lines.append(f"  {k + '.blockedMax':24s} before: {fmt_stat(blkb)} | after: {fmt_stat(blka)}")
    lines.append("")

    # 3. Mutation round
    mut_path = os.path.join(HERE, "mutation", "results.txt")
    if os.path.exists(mut_path):
        lines.append("3. Mutation Round (docs/measurements/p5_2026-11-09/mutation/results.txt)")
        lines.append("-" * 84)
        with open(mut_path, encoding="utf-8") as f:
            for ln in f.read().splitlines():
                lines.append("  " + ln)
        lines.append("")

    out_path = os.path.join(HERE, "summary.txt")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
