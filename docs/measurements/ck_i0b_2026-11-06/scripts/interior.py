"""I0b: dips inside the opaque subject (where the fp32 run's alpha logit is >= 1): the share of those pixels whose clamped
alpha lands below 255 and below 251 levels, and the lowest one, for a run's arrays and for I0a's bf16 reference.

    python -I interior.py <runs/parity/arrays> <dist/ck_ref> <ref_fp32> label:array ...
"""
import glob
import os
import sys

import numpy as np


def main():
    arrays, ref, fp = sys.argv[1:4]
    for spec in sys.argv[4:]:
        lab, arr = spec.split(":")
        print("== %s %s (pixels with fp32 logit >= 1: share below 255 / below 251 levels, min; then I0a's bf16 the same)" % (lab, arr))
        for d in sorted(glob.glob(os.path.join(arrays, lab, "*", "*"))):
            still, case = os.path.normpath(d).split(os.sep)[-2:]
            p = os.path.join(d, arr + ".npy")
            if not os.path.exists(p):
                continue
            o = np.load(p)[0]
            fname = "s2bf16_logits.npy" if arr == "s2ref_logits" else "logits.npy"
            f = np.load(os.path.join(fp, still, case, fname))[0]
            b = np.load(os.path.join(ref, still, case, "logits.npy")).astype(np.float32)[0]
            m = f >= 1.0
            oa, ba = np.clip(o, 0, 1)[m], np.clip(b, 0, 1)[m]
            print("  %-17s %-13s opaque %.2f | ours <255 %.4f <251 %.5f min %.3f | bf16 <255 %.4f <251 %.5f min %.3f" % (
                still, case, m.mean(), (oa < 254.5 / 255).mean(), (oa < 250.5 / 255).mean(), oa.min(),
                (ba < 254.5 / 255).mean(), (ba < 250.5 / 255).mean(), ba.min()))


if __name__ == "__main__":
    main()
