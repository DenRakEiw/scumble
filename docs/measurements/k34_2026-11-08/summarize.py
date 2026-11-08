"""Summarize the 3 alternating before/after rounds of K34."""
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
AB = os.path.join(HERE, "ab")
ROUNDS = (1, 2, 3)


def med(xs):
    return round(statistics.median(xs), 2)


def fmt_series(xs):
    m = med(xs)
    vals = ", ".join(f"{x:.1f}" for x in xs)
    return f"{m:7.2f} ms  [{vals}]"


def load_json(arm, prefix, r):
    with open(os.path.join(AB, arm, f"{prefix}_r{r}.json"), encoding="utf-8") as f:
        return json.load(f)


def union_keys(b_dicts, a_dicts):
    out = []
    for d in list(b_dicts) + list(a_dicts):
        for k in (d or {}).keys():
            if k not in out:
                out.append(k)
    return out


def print_native_section(title, nat):
    print(f"== {title} ==")
    bw = [x["rows"]["provider_crop"]["row"]["wall"] for x in nat["before"]]
    aw = [x["rows"]["provider_crop"]["row"]["wall"] for x in nat["after"]]
    bb = [x["rows"]["provider_crop"]["row"]["blocked"] for x in nat["before"]]
    ab = [x["rows"]["provider_crop"]["row"]["blocked"] for x in nat["after"]]
    bp = [x["rows"]["provider_crop"]["row"]["extra"]["prepMs"] for x in nat["before"]]
    ap = [x["rows"]["provider_crop"]["row"]["extra"]["prepMs"] for x in nat["after"]]
    b_sh = [((x["rows"]["provider_crop"]["row"].get("calls") or {}).get("gl getShaderParameter") or {}).get("ms", 0.0) for x in nat["before"]]
    a_sh = [((x["rows"]["provider_crop"]["row"].get("calls") or {}).get("gl getShaderParameter") or {}).get("ms", 0.0) for x in nat["after"]]
    b_pr = [((x["rows"]["provider_crop"]["row"].get("calls") or {}).get("gl getProgramParameter") or {}).get("ms", 0.0) for x in nat["before"]]
    a_pr = [((x["rows"]["provider_crop"]["row"].get("calls") or {}).get("gl getProgramParameter") or {}).get("ms", 0.0) for x in nat["after"]]
    print(f"  wall                    before {fmt_series(bw)}   |   after {fmt_series(aw)}   (delta {med(aw) - med(bw):+.2f} ms)")
    print(f"  blocked                 before {fmt_series(bb)}   |   after {fmt_series(ab)}   (delta {med(ab) - med(bb):+.2f} ms)")
    print(f"  gl getShaderParameter   before {fmt_series(b_sh)}   |   after {fmt_series(a_sh)}   (delta {med(a_sh) - med(b_sh):+.2f} ms)")
    print(f"  gl getProgramParameter  before {fmt_series(b_pr)}   |   after {fmt_series(a_pr)}   (delta {med(a_pr) - med(b_pr):+.2f} ms)")
    print(f"  prepMs                  before {fmt_series(bp)}   |   after {fmt_series(ap)}   (delta {med(ap) - med(bp):+.2f} ms)")
    for stage in ("prep", "finish"):
        b_laps = [x["rows"]["provider_crop"]["row"]["extra"]["laps"][stage] for x in nat["before"]]
        a_laps = [x["rows"]["provider_crop"]["row"]["extra"]["laps"][stage] for x in nat["after"]]
        keys = union_keys(b_laps, a_laps)
        for k in keys:
            bl = [d.get(k, 0.0) for d in b_laps]
            al = [d.get(k, 0.0) for d in a_laps]
            print(f"    {stage}.{k:17s}  before {fmt_series(bl)}   |   after {fmt_series(al)}   (delta {med(al) - med(bl):+.2f} ms)")
        if stage == "finish":
            bk34 = [d.get("shrink", 0.0) + d.get("warp", 0.0) + d.get("coverage", 0.0) for d in b_laps]
            ak34 = [d.get("shrink", 0.0) + d.get("warp", 0.0) + d.get("coverage", 0.0) for d in a_laps]
            print(f"    {stage}.K34_sum            before {fmt_series(bk34)}   |   after {fmt_series(ak34)}   (delta {med(ak34) - med(bk34):+.2f} ms)")
        bsum = [sum(d.values()) for d in b_laps]
        asum = [sum(d.values()) for d in a_laps]
        print(f"    {stage}.SUM                before {fmt_series(bsum)}   |   after {fmt_series(asum)}   (delta {med(asum) - med(bsum):+.2f} ms)")
    print("  stitchCalls before:", nat["before"][0]["rows"]["provider_crop"]["row"]["extra"].get("stitchCalls"))
    print("  stitchCalls after :", nat["after"][0]["rows"]["provider_crop"]["row"]["extra"].get("stitchCalls"))
    print()


def main():
    w0 = {arm: [load_json(arm, "w0", r) for r in ROUNDS] for arm in ("before", "after")}
    nat = {arm: [load_json(arm, "native", r) for r in ROUNDS] for arm in ("before", "after")}
    nat_warm = {arm: [load_json(arm, "native_warm", r) for r in ROUNDS] for arm in ("before", "after")}

    print("== 1a. w0_bench: edgefit_2048 ==")
    bf = [x["edgefit_2048"]["fit"]["median"] for x in w0["before"]]
    af = [x["edgefit_2048"]["fit"]["median"] for x in w0["after"]]
    print(f"  fit (fitLayerRGBA)      before {fmt_series(bf)}   |   after {fmt_series(af)}   (delta {med(af) - med(bf):+.2f} ms)")
    for k in ("shrink", "ring", "fitEdges", "warp", "coverage"):
        bs = [x["edgefit_2048"]["split"][k] for x in w0["before"]]
        as_ = [x["edgefit_2048"]["split"][k] for x in w0["after"]]
        print(f"    split.{k:14s}  before {fmt_series(bs)}   |   after {fmt_series(as_)}   (delta {med(as_) - med(bs):+.2f} ms)")
    bk34 = [x["edgefit_2048"]["split"]["shrink"] + x["edgefit_2048"]["split"]["warp"] + x["edgefit_2048"]["split"]["coverage"] for x in w0["before"]]
    ak34 = [x["edgefit_2048"]["split"]["shrink"] + x["edgefit_2048"]["split"]["warp"] + x["edgefit_2048"]["split"]["coverage"] for x in w0["after"]]
    print(f"    split.K34_sum         before {fmt_series(bk34)}   |   after {fmt_series(ak34)}   (delta {med(ak34) - med(bk34):+.2f} ms)")
    print("  pxCalls before:", w0["before"][0]["edgefit_2048"].get("pxCalls"))
    print("  pxCalls after :", w0["after"][0]["edgefit_2048"].get("pxCalls"))
    print()

    for row in ("stitch_align_2048", "stitch_align_4096"):
        print(f"== 1b. w0_bench: {row} ==")
        bp_w = [x[row]["prepare"]["wall"] for x in w0["before"]]
        ap_w = [x[row]["prepare"]["wall"] for x in w0["after"]]
        print(f"  prepare.wall            before {fmt_series(bp_w)}   |   after {fmt_series(ap_w)}   (delta {med(ap_w) - med(bp_w):+.2f} ms)")
        for mode in ("worker", "window"):
            bw = [x[row][mode]["wall"] for x in w0["before"]]
            aw = [x[row][mode]["wall"] for x in w0["after"]]
            bs = [x[row][mode]["laps_sum"] for x in w0["before"]]
            as_ = [x[row][mode]["laps_sum"] for x in w0["after"]]
            print(f"  {mode}.wall             before {fmt_series(bw)}   |   after {fmt_series(aw)}   (delta {med(aw) - med(bw):+.2f} ms)")
            print(f"  {mode}.laps_sum         before {fmt_series(bs)}   |   after {fmt_series(as_)}   (delta {med(as_) - med(bs):+.2f} ms)")
            bm_laps = [x[row][mode]["laps"] for x in w0["before"]]
            am_laps = [x[row][mode]["laps"] for x in w0["after"]]
            for lap in union_keys(bm_laps, am_laps):
                bl = [d.get(lap, 0.0) for d in bm_laps]
                al = [d.get(lap, 0.0) for d in am_laps]
                print(f"    {mode}.{lap:16s}  before {fmt_series(bl)}   |   after {fmt_series(al)}   (delta {med(al) - med(bl):+.2f} ms)")
            bk34 = [d.get("shrink", 0.0) + d.get("warp", 0.0) + d.get("coverage", 0.0) for d in bm_laps]
            ak34 = [d.get("shrink", 0.0) + d.get("warp", 0.0) + d.get("coverage", 0.0) for d in am_laps]
            print(f"    {mode}.K34_sum          before {fmt_series(bk34)}   |   after {fmt_series(ak34)}   (delta {med(ak34) - med(bk34):+.2f} ms)")
            px_key = "workerPx" if mode == "worker" else "windowPx"
            print(f"    {mode}.{px_key} before:", w0["before"][0][row][mode].get(px_key))
            print(f"    {mode}.{px_key} after :", w0["after"][0][row][mode].get(px_key))
        print()

    print_native_section("2a. native_test 15000x10000 --no-profile provider_crop (cold)", nat)
    print_native_section("2b. warm_native 15000x10000 --no-profile provider_crop (warmed by 1 untimed provider_crop)", nat_warm)

    warp_ab_dir = os.path.join(HERE, "warp_ab")
    if os.path.isdir(warp_ab_dir):
        print("== 3. warpRgba route ALONE A/B (js vs rust, 3 alternating rounds) ==")
        wab = {
            arm: [json.load(open(os.path.join(warp_ab_dir, arm, f"w0_r{r}.json"), encoding="utf-8")) for r in ROUNDS]
            for arm in ("js", "rust")
        }
        w_js = [x["edgefit_2048"]["split"]["warp"] for x in wab["js"]]
        w_rs = [x["edgefit_2048"]["split"]["warp"] for x in wab["rust"]]
        c_js = [x["edgefit_2048"]["split"]["coverage"] for x in wab["js"]]
        c_rs = [x["edgefit_2048"]["split"]["coverage"] for x in wab["rust"]]
        print(f"  edgefit_2048.split.warp       js {fmt_series(w_js)}   |   rust {fmt_series(w_rs)}   (delta {med(w_rs) - med(w_js):+.2f} ms)")
        print(f"  edgefit_2048.split.coverage   js {fmt_series(c_js)}   |   rust {fmt_series(c_rs)}   (delta {med(c_rs) - med(c_js):+.2f} ms)")
        print("  edgefit_2048.pxCalls js  :", wab["js"][0]["edgefit_2048"].get("pxCalls"))
        print("  edgefit_2048.pxCalls rust:", wab["rust"][0]["edgefit_2048"].get("pxCalls"))
        for row in ("stitch_align_2048", "stitch_align_4096"):
            for mode in ("worker", "window"):
                bw = [x[row][mode]["wall"] for x in wab["js"]]
                aw = [x[row][mode]["wall"] for x in wab["rust"]]
                bs = [x[row][mode]["laps_sum"] for x in wab["js"]]
                as_ = [x[row][mode]["laps_sum"] for x in wab["rust"]]
                lw_js = [x[row][mode]["laps"]["warp"] for x in wab["js"]]
                lw_rs = [x[row][mode]["laps"]["warp"] for x in wab["rust"]]
                lc_js = [x[row][mode]["laps"]["coverage"] for x in wab["js"]]
                lc_rs = [x[row][mode]["laps"]["coverage"] for x in wab["rust"]]
                print(f"  {row}.{mode}.wall      js {fmt_series(bw)}   |   rust {fmt_series(aw)}   (delta {med(aw) - med(bw):+.2f} ms)")
                print(f"  {row}.{mode}.laps_sum  js {fmt_series(bs)}   |   rust {fmt_series(as_)}   (delta {med(as_) - med(bs):+.2f} ms)")
                print(f"  {row}.{mode}.warp      js {fmt_series(lw_js)}   |   rust {fmt_series(lw_rs)}   (delta {med(lw_rs) - med(lw_js):+.2f} ms)")
                print(f"  {row}.{mode}.coverage  js {fmt_series(lc_js)}   |   rust {fmt_series(lc_rs)}   (delta {med(lc_rs) - med(lc_js):+.2f} ms)")
            print(f"  {row}.worker.workerPx js  :", wab["js"][0][row]["worker"].get("workerPx"))
            print(f"  {row}.worker.workerPx rust:", wab["rust"][0][row]["worker"].get("workerPx"))


if __name__ == "__main__":
    main()
