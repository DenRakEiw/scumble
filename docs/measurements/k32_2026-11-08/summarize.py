"""Summarize the 3 alternating before/after rounds of K32."""
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


def main():
    w0 = {arm: [load_json(arm, "w0", r) for r in ROUNDS] for arm in ("before", "after")}
    nat = {arm: [load_json(arm, "native", r) for r in ROUNDS] for arm in ("before", "after")}

    print("== 1. w0_bench: stitch_masks_2048 ==")
    for key in ("gauss", "dilate", "max_clamp", "mk"):
        b = [x["stitch_masks_2048"][key]["median"] for x in w0["before"]]
        a = [x["stitch_masks_2048"][key]["median"] for x in w0["after"]]
        print(f"  {key:12s}  before {fmt_series(b)}   |   after {fmt_series(a)}   (delta {med(a) - med(b):+.2f} ms)")
    print("  pxCalls before:", w0["before"][0]["stitch_masks_2048"].get("pxCalls"))
    print("  pxCalls after :", w0["after"][0]["stitch_masks_2048"].get("pxCalls"))
    print()

    for row in ("stitch_align_2048", "stitch_align_4096"):
        print(f"== 2. w0_bench: {row} ==")
        # prepare
        bp_w = [x[row]["prepare"]["wall"] for x in w0["before"]]
        ap_w = [x[row]["prepare"]["wall"] for x in w0["after"]]
        print(f"  prepare.wall       before {fmt_series(bp_w)}   |   after {fmt_series(ap_w)}   (delta {med(ap_w) - med(bp_w):+.2f} ms)")
        for lap in ("selection", "maskFromAlpha", "selectionBbox", "region", "dilate", "blur", "maskMax", "maskToCanvas", "alphaMask", "encode"):
            bl = [x[row]["prepare"]["laps"].get(lap, 0.0) for x in w0["before"]]
            al = [x[row]["prepare"]["laps"].get(lap, 0.0) for x in w0["after"]]
            print(f"    prep.{lap:13s}  before {fmt_series(bl)}   |   after {fmt_series(al)}   (delta {med(al) - med(bl):+.2f} ms)")
        print("    prep.workerPx before:", w0["before"][0][row]["prepare"].get("workerPx"))
        print("    prep.workerPx after :", w0["after"][0][row]["prepare"].get("workerPx"))

        for mode in ("worker", "window"):
            bw = [x[row][mode]["wall"] for x in w0["before"]]
            aw = [x[row][mode]["wall"] for x in w0["after"]]
            bs = [x[row][mode]["laps_sum"] for x in w0["before"]]
            as_ = [x[row][mode]["laps_sum"] for x in w0["after"]]
            print(f"  {mode}.wall        before {fmt_series(bw)}   |   after {fmt_series(aw)}   (delta {med(aw) - med(bw):+.2f} ms)")
            print(f"  {mode}.laps_sum    before {fmt_series(bs)}   |   after {fmt_series(as_)}   (delta {med(as_) - med(bs):+.2f} ms)")
            for lap in ("region", "decode", "resize", "dilate", "blur", "maskMax", "erode", "alignCopy", "shrink", "ring", "fit", "warp", "coverage", "colorMatch", "finalAlpha", "encode"):
                bl = [x[row][mode]["laps"].get(lap, 0.0) for x in w0["before"]]
                al = [x[row][mode]["laps"].get(lap, 0.0) for x in w0["after"]]
                print(f"    {mode}.{lap:12s}  before {fmt_series(bl)}   |   after {fmt_series(al)}   (delta {med(al) - med(bl):+.2f} ms)")
            px_key = "workerPx" if mode == "worker" else "windowPx"
            print(f"    {mode}.{px_key} before:", w0["before"][0][row][mode].get(px_key))
            print(f"    {mode}.{px_key} after :", w0["after"][0][row][mode].get(px_key))
        print()

    print("== 3. native_test 15000x10000 --no-profile provider_crop ==")
    bw = [x["rows"]["provider_crop"]["row"]["wall"] for x in nat["before"]]
    aw = [x["rows"]["provider_crop"]["row"]["wall"] for x in nat["after"]]
    bb = [x["rows"]["provider_crop"]["row"]["blocked"] for x in nat["before"]]
    ab = [x["rows"]["provider_crop"]["row"]["blocked"] for x in nat["after"]]
    bp = [x["rows"]["provider_crop"]["row"]["extra"]["prepMs"] for x in nat["before"]]
    ap = [x["rows"]["provider_crop"]["row"]["extra"]["prepMs"] for x in nat["after"]]
    print(f"  wall               before {fmt_series(bw)}   |   after {fmt_series(aw)}   (delta {med(aw) - med(bw):+.2f} ms)")
    print(f"  blocked            before {fmt_series(bb)}   |   after {fmt_series(ab)}   (delta {med(ab) - med(bb):+.2f} ms)")
    print(f"  prepMs             before {fmt_series(bp)}   |   after {fmt_series(ap)}   (delta {med(ap) - med(bp):+.2f} ms)")
    for stage in ("prep", "finish"):
        keys = list(nat["after"][0]["rows"]["provider_crop"]["row"]["extra"]["laps"][stage].keys())
        for k in keys:
            bl = [x["rows"]["provider_crop"]["row"]["extra"]["laps"][stage].get(k, 0.0) for x in nat["before"]]
            al = [x["rows"]["provider_crop"]["row"]["extra"]["laps"][stage].get(k, 0.0) for x in nat["after"]]
            print(f"    {stage}.{k:13s}  before {fmt_series(bl)}   |   after {fmt_series(al)}   (delta {med(al) - med(bl):+.2f} ms)")
        bsum = [sum(x["rows"]["provider_crop"]["row"]["extra"]["laps"][stage].values()) for x in nat["before"]]
        asum = [sum(x["rows"]["provider_crop"]["row"]["extra"]["laps"][stage].values()) for x in nat["after"]]
        print(f"    {stage}.SUM          before {fmt_series(bsum)}   |   after {fmt_series(asum)}   (delta {med(asum) - med(bsum):+.2f} ms)")
    print("  stitchCalls before:", nat["before"][0]["rows"]["provider_crop"]["row"]["extra"].get("stitchCalls"))
    print("  stitchCalls after :", nat["after"][0]["rows"]["provider_crop"]["row"]["extra"].get("stitchCalls"))


if __name__ == "__main__":
    main()
