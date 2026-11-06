"""CorridorKey spike (I0b): parity per graph against I0a's reference (docs/PLAN_CORRIDORKEY.md §4.2's go list).

    python -I tools/ck_spike/parity.py <arrays dir of one label> <dist/ck_ref> [--out rows.jsonl] [--table table.txt]

<arrays>/<still>/<case>/ holds main.js --task parity's float32 .npy: feat_cradio / feat_moge / feat_rvm (the feature
graphs on the input PNG), baton / aux / logits (the chain: own features -> stage 1 -> stage 2), s1ref_baton / s1ref_aux /
s1ref_logits (stage 1 on I0a's features, then stage 2), s2ref_logits (stage 2 alone on I0a's baton). Every row compares
logits to logits (no decode, §4.2): the alpha channel raw (ch 0), the fg channels in the asinh code (ch 1-3), and the
edge band 0.05 < alpha_ref < 0.95 with the fg error alpha-weighted (sum a |d| / sum a, a = I0a's clamped alpha) beside
the plain one. The decoded fg (linear) is reported only as the fp16 stress figure (hair_green), never as a gate.
"""
import json
import os
import sys

import numpy as np

KNEE, DENOM = 0.008, float(np.arcsinh(16.0 / 0.008))
GO = {"alpha_mae": 2e-3, "alpha_max": 0.03, "fg_mae": 0.01, "edge_alpha_mae": 5e-3, "edge_fg_wmae": 0.02}


def load(p):
    return np.load(p).astype(np.float64)


def stats(ours, ref):
    d = ours - ref
    a = np.abs(d)
    fin = np.isfinite(ours)
    num = float((ours.ravel() * ref.ravel()).sum())
    den = float(np.linalg.norm(ours.ravel()) * np.linalg.norm(ref.ravel())) or 1.0
    return {"mae": float(a.mean()), "max": float(a.max()), "rel_mae": float(a.mean() / (np.abs(ref).mean() or 1.0)),
            "cos": num / den, "ref_absmax": float(np.abs(ref).max()), "nan_inf": int((~fin).sum()),
            "shape": list(ours.shape)}


def logit_rows(ours, ref):
    """ours / ref: (4, H, W) raw logits."""
    r = {"nan_inf": int((~np.isfinite(ours)).sum())}
    da = np.abs(ours[0] - ref[0])
    df = np.abs(ours[1:4] - ref[1:4])
    r["alpha_mae"] = float(da.mean())
    r["alpha_max"] = float(da.max())
    r["alpha_clamped_mae"] = float(np.abs(np.clip(ours[0], 0, 1) - np.clip(ref[0], 0, 1)).mean())
    r["alpha_clamped_max"] = float(np.abs(np.clip(ours[0], 0, 1) - np.clip(ref[0], 0, 1)).max())
    r["fg_mae"] = float(df.mean())
    r["fg_max"] = float(df.max())
    a = np.clip(ref[0], 0, 1)
    band = (a > 0.05) & (a < 0.95)
    r["edge_px"] = int(band.sum())
    if band.any():
        r["edge_alpha_mae"] = float(da[band].mean())
        r["edge_alpha_max"] = float(da[band].max())
        r["edge_fg_mae"] = float(df[:, band].mean())
        w = a[band]
        r["edge_fg_wmae"] = float((df[:, band] * w).sum() / (3 * w.sum()))
        r["edge_fg_max"] = float(df[:, band].max())
    # the fp16 stress figure: the decoded linear fg where the reference is lit far above 1 (hair_green's edge)
    lin_o = np.sinh(ours[1:4] * DENOM) * KNEE
    lin_r = np.sinh(ref[1:4] * DENOM) * KNEE
    r["fg_linear_max_ours"] = float(np.nanmax(lin_o))
    r["fg_linear_max_ref"] = float(lin_r.max())
    r["fg_linear_px_above4_ours"] = int((lin_o.max(0) > 4.0).sum())
    r["fg_linear_px_above4_ref"] = int((lin_r.max(0) > 4.0).sum())
    hot = lin_r.max(0) > 4.0
    if hot.any():
        rel = np.abs(lin_o - lin_r)[:, hot] / np.maximum(lin_r[:, hot], 1e-6)
        r["fg_linear_hot_rel_mean"] = float(rel.mean())
        r["fg_linear_hot_rel_max"] = float(rel.max())
    edge_ok = not band.any() or (r["edge_alpha_mae"] <= GO["edge_alpha_mae"] and r["edge_fg_wmae"] <= GO["edge_fg_wmae"])
    # pass: §4.2's list as written, the alpha channel raw (its error above 1 and below 0, where the matte is clamped,
    # counts); pass_clamped: the same list with the alpha channel clamped to [0, 1] first (what lands in a matte)
    r["pass"] = bool(r["nan_inf"] == 0 and r["alpha_mae"] <= GO["alpha_mae"] and r["alpha_max"] <= GO["alpha_max"]
                     and r["fg_mae"] <= GO["fg_mae"] and edge_ok)
    r["pass_clamped"] = bool(r["nan_inf"] == 0 and r["alpha_clamped_mae"] <= GO["alpha_mae"] and r["alpha_clamped_max"] <= GO["alpha_max"]
                             and r["fg_mae"] <= GO["fg_mae"] and edge_ok)
    return r


def main():
    arrays, ref_root = sys.argv[1], sys.argv[2]
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else None
    table = sys.argv[sys.argv.index("--table") + 1] if "--table" in sys.argv else None
    label = os.path.basename(os.path.normpath(arrays))
    rows = []
    for still in sorted(os.listdir(arrays)):
        if not os.path.isdir(os.path.join(arrays, still)):
            continue
        for case in sorted(os.listdir(os.path.join(arrays, still))):
            od = os.path.join(arrays, still, case)
            rd = os.path.join(ref_root, still, case)
            if not (os.path.isdir(od) and os.path.isfile(os.path.join(rd, "logits.npy")) and os.path.isfile(os.path.join(od, "logits.npy"))
                    or os.path.isdir(od) and os.path.isfile(os.path.join(rd, "logits.npy")) and os.path.isfile(os.path.join(od, "s2ref_logits.npy"))):
                continue
            if "--only" in sys.argv and case not in sys.argv[sys.argv.index("--only") + 1].split(","):
                continue
            base = {"label": label, "still": still, "case": case}
            for name in ("feat_cradio", "feat_moge", "feat_rvm", "baton", "aux", "s1ref_baton", "s1ref_aux"):
                p = os.path.join(od, name + ".npy")
                if not os.path.exists(p):
                    continue
                refname = name.replace("s1ref_", "")
                rows.append({**base, "array": name, "graph_path": graph_path(name), **stats(load(p), load(os.path.join(rd, refname + ".npy")))})
            ref_lg = load(os.path.join(rd, "logits.npy"))
            for name in ("logits", "s1ref_logits", "s2ref_logits"):
                p = os.path.join(od, name + ".npy")
                if os.path.exists(p):
                    against = ref_lg
                    # the fp32 calibration (ck_ref_fp32.py) keeps stage 2 on I0a's bf16 baton as s2bf16_logits: the
                    # isolated stage 2 row is held against that, not against the fp32 chain
                    alt = os.path.join(rd, "s2bf16_logits.npy")
                    if name == "s2ref_logits" and os.path.exists(alt):
                        against = load(alt)
                    rows.append({**base, "array": name, "graph_path": graph_path(name), **logit_rows(load(p), against)})
    if out:
        with open(out, "a", encoding="utf-8", newline=chr(10)) as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
    lines = ["%-14s %-17s %-13s %s" % ("still", "case", "array", "metrics")]
    for r in rows:
        if "alpha_mae" in r:
            m = "alpha mae %.2e max %.3f (clamped %.2e %.3f) | fg mae %.2e max %.3f | edge %6d px alpha mae %s fg wmae %s (plain %s, max %s) | nan/inf %d | %s / clamped %s" % (
                r["alpha_mae"], r["alpha_max"], r["alpha_clamped_mae"], r["alpha_clamped_max"], r["fg_mae"], r["fg_max"], r["edge_px"],
                fmt(r.get("edge_alpha_mae")), fmt(r.get("edge_fg_wmae")), fmt(r.get("edge_fg_mae")), fmt(r.get("edge_fg_max"), "%.3f"),
                r["nan_inf"], "PASS" if r["pass"] else "FAIL", "PASS" if r["pass_clamped"] else "FAIL")
        else:
            m = "mae %.2e max %.3f rel %.2e cos %.6f | ref |max| %.2f | nan/inf %d" % (
                r["mae"], r["max"], r["rel_mae"], r["cos"], r["ref_absmax"], r["nan_inf"])
        lines.append("%-14s %-17s %-13s %s" % (r["still"], r["case"], r["array"], m))
    text = "\n".join(lines)
    print(text)
    if table:
        open(table, "w", encoding="utf-8", newline=chr(10)).write(text + "\n")


def graph_path(name):
    return {"feat_cradio": "cradio alone (input PNG)", "feat_moge": "moge alone", "feat_rvm": "rvm alone",
            "baton": "chain: own features -> stage1", "aux": "chain: stage1 aux",
            "s1ref_baton": "stage1 alone on I0a's features", "s1ref_aux": "stage1 alone, aux",
            "logits": "chain: features -> stage1 -> stage2", "s1ref_logits": "stage1 on I0a's features -> stage2",
            "s2ref_logits": "stage2 alone on I0a's baton"}[name]


def fmt(v, f="%.2e"):
    return (f % v) if v is not None else "-"


if __name__ == "__main__":
    main()
