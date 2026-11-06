"""I0b: copy the run results into docs/measurements/ck_i0b_2026-11-06/ with the scratchpad path replaced by $SCRATCH."""
import glob
import os
import sys

S, M = sys.argv[1], sys.argv[2]
R = S + "/ck_i0b/runs"
long_ = r"<the session scratchpad, Windows form>"
subs = {S, S.replace("/", "\\"), S.replace("/", "\\\\"), long_, long_.replace("\\", "\\\\"), long_.replace("\\", "/"),
        "<the session scratchpad, MSYS form>"}


def put(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    t = open(src, encoding="utf-8", errors="replace").read()
    for s in sorted(subs, key=len, reverse=True):
        t = t.replace(s, "$SCRATCH")
    open(dst, "w", encoding="utf-8", newline=chr(10)).write(t)


m = [(R + "/bench/rows.jsonl", "rows/bench_rows.jsonl"), (R + "/parity/rows.jsonl", "rows/parity_runs.jsonl"),
     (R + "/placement/rows.jsonl", "rows/placement_rows.jsonl"),
     (R + "/placement_dmlvariants/rows.jsonl", "rows/placement_dml_variants_rows.jsonl"),
     (R + "/placement.txt", "placement.txt"), (R + "/placement_dmlvariants.txt", "placement_dml_variants.txt"),
     (R + "/placement/placement.json", "placement_detail.json"),
     (R + "/placement_dmlvariants/placement.json", "placement_dml_variants_detail.json"),
     (R + "/bisect_dml_nofusion.jsonl", "bisect_dml_stage1.jsonl"), (R + "/bench_summary.txt", "bench_summary.txt"),
     (R + "/parity/parity_vs_bf16.jsonl", "parity/parity_vs_bf16.jsonl"),
     (R + "/parity/parity_vs_fp32.jsonl", "parity/parity_vs_fp32.jsonl"),
     (R + "/parity/parity_bf16ref_vs_fp32.jsonl", "parity/parity_bf16ref_vs_fp32.jsonl"),
     (R + "/parity/parity_summary.txt", "parity/parity_summary.txt"), (R + "/parity/interior.txt", "parity/interior.txt"),
     (S + "/ck_i0b/ref_fp32/run.json", "parity/fp32_calibration_run.json"),
     (S + "/ck_i0b/fp32_run.log", "parity/fp32_calibration_run.log"),
     (S + "/ck_i0b/meta/nucito_fetch_log.json", "downloads.json"),
     (S + "/ck_i0b/meta/nucito_tree.json", "nucito_tree_1ae72ca.json"), (S + "/ck_i0b/lock_times.log", "lock_times.log")]
for a, b in m:
    put(a, os.path.join(M, b))
for p in glob.glob(R + "/*/*.samples.jsonl") + glob.glob(R + "/*/*.smi.csv"):
    put(p, os.path.join(M, "counters", os.path.basename(p)))
print(len(glob.glob(M + "/counters/*")), "counter files")
