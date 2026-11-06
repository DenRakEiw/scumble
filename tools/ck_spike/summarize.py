"""CorridorKey spike (I0b): tables for the summary from the rows of main.js (rows.jsonl) and parity.py (parity_*.jsonl).

    python -I tools/ck_spike/summarize.py parity <parity_*.jsonl> ...     worst case and median per label and array
    python -I tools/ck_spike/summarize.py bench <rows.jsonl> ...          load, parts, loop, memory, kill per label
"""
import json
import statistics as st
import sys
from collections import defaultdict


def rows(paths):
    for p in paths:
        for line in open(p, encoding="utf-8"):
            line = line.strip()
            if line:
                yield p, json.loads(line)


def parity(paths):
    g = defaultdict(list)
    for p, r in rows(paths):
        ref = "fp32" if "fp32" in p.rsplit("parity_", 1)[-1] and "bf16ref" not in p else ("bf16ref->fp32" if "bf16ref" in p else "bf16")
        g[(ref, r["label"], r["array"])].append(r)
    out = []
    for (ref, label, arr), rs in sorted(g.items()):
        if "alpha_mae" in rs[0]:
            def w(k):
                v = [x[k] for x in rs if x.get(k) is not None]
                return (max(v), st.median(v)) if v else (None, None)
            am, aM, ac, fm, ea, ew, fl = w("alpha_mae"), w("alpha_max"), w("alpha_clamped_mae"), w("fg_mae"), w("edge_alpha_mae"), w("edge_fg_wmae"), w("fg_linear_hot_rel_mean")
            npass = sum(x["pass"] for x in rs)
            npc = sum(x["pass_clamped"] for x in rs)
            nan = sum(x["nan_inf"] for x in rs)
            out.append("%-13s %-30s %-13s n %2d | alpha mae max %.2e med %.2e | alpha max %.3f | clamped mae max %.2e | fg mae max %.2e | "
                       "edge alpha mae max %.2e med %.2e | edge fg wmae max %.2e | hot fg rel %s | nan/inf %d | pass %d/%d clamped %d/%d"
                       % (ref, label, arr, len(rs), am[0], am[1], aM[0], ac[0], fm[0], ea[0], ea[1], ew[0],
                          ("%.3f" % fl[0]) if fl[0] is not None else "-", nan, npass, len(rs), npc, len(rs)))
        else:
            mae = [x["mae"] for x in rs]
            rel = [x["rel_mae"] for x in rs]
            cos = [x["cos"] for x in rs]
            mx = [x["max"] for x in rs]
            out.append("%-13s %-30s %-13s n %2d | mae max %.2e med %.2e | rel max %.2e | max %.3f | cos min %.6f | nan/inf %d"
                       % (ref, label, arr, len(rs), max(mae), st.median(mae), max(rel), max(mx), min(cos), sum(x["nan_inf"] for x in rs)))
    print("\n".join(out))


def bench(paths):
    by = defaultdict(list)
    for _, r in rows(paths):
        by[r["label"]].append(r)
    for label, rs in by.items():
        v = next((r for r in rs if r["kind"] == "versions"), {})
        print("== %s  provider %s  bucket %s  ort_node %s  opt %s" % (label, v.get("provider"), v.get("bucket"), v.get("ort_node"), v.get("opt")))
        for r in rs:
            k = r["kind"]
            if k == "load":
                print("  load %-38s %-7s %8.0f ms (cpu %.0f ms)" % (r["phase"], r["graph"], r["ms"], r.get("cpu_ms") or 0))
            elif k == "load_total":
                print("  load total %-32s %8.0f ms" % (r.get("phase", ""), r["ms"]))
            elif k in ("error", "load_failed"):
                print("  %s %s %s" % (k, r.get("graph", ""), r.get("error", "")[:240].replace("\n", " ")))
            elif k == "mem":
                gb = lambda x: ("%.2f" % (x / 2**30)) if isinstance(x, (int, float)) and x >= 0 else "-"
                print("  mem %-24s child private %s GB  child GPU dedicated %s GB  card %s GB  main private %s GB" % (
                    r["tag"], gb(r.get("child_private")), gb(r.get("child_gpu_ded")), gb(r.get("card_ded")), gb(r.get("main_private"))))
            elif k == "loop_median":
                print("  loop median of %d: post->answer %.1f ms, model %.1f ms (stage1+2 %.1f), IPC %.1f ms" % (
                    r["n"], r["post_to_answer_ms"], r["model_ms"], r["stage12_ms"], r["ipc_ms"]))
            elif k == "kill":
                print("  kill: exit after %.0f ms, GPU counter 0 after %s ms, process gone after %s ms (GPU before %.2f GB, private before %.2f GB)" % (
                    r["exit_ms"] or -1, r["gpu_zero_after_ms"], r["process_gone_after_ms"], (r["gpu_before"] or 0) / 2**30, (r["private_before"] or 0) / 2**30))
        f = [r for r in rs if r["kind"] == "features"]
        if f:
            cold, warm = f[0], f[1:]
            med = lambda key: st.median([x[key] for x in warm]) if warm else float("nan")
            print("  features cold: cradio %.0f moge %.0f rvm %.0f ms | warm median: cradio %.1f moge %.1f rvm %.1f ms (cpu %.0f ms)" % (
                cold["cradio_ms"], cold["moge_ms"], cold["rvm_ms"], med("cradio_ms"), med("moge_ms"), med("rvm_ms"), med("cpu_ms")))
        for h in (False, True):
            s = [r for r in rs if r["kind"] == "stages" and r["hint"] == h]
            if s:
                cold, warm = s[0], s[1:]
                print("  stages %s cold: s1 %.0f s2 %.0f ms | warm median: s1 %.1f s2 %.1f total %.1f ms (cpu %.0f ms)" % (
                    "hint  " if h else "nohint", cold["stage1_ms"], cold["stage2_ms"], st.median([x["stage1_ms"] for x in warm]),
                    st.median([x["stage2_ms"] for x in warm]), st.median([x["total_ms"] for x in warm]), st.median([x["cpu_ms"] for x in warm])))


if __name__ == "__main__":
    {"parity": parity, "bench": bench}[sys.argv[1]](sys.argv[2:])
