"""I0a: compare a rerun of the reference keys with the first run, file by file; and the fp16 stress figures.

    python -I ck_rerun_diff.py diff REF RERUN     every array (*.npy) and every PNG of each case folder RERUN holds
                                                  against REF (dist/ck_ref): arrays as max |d| and MAE in float64,
                                                  PNGs as bytes and as decoded pixels
    python -I ck_rerun_diff.py stress REF STILL   the extremes of fg_linear per case of one still: the largest value
                                                  and the alpha under it, the pixels above 4.0 linear and their mean
                                                  alpha, the decoded inputs' PNG colour type
Reads only; writes nothing but stdout.
"""
import hashlib
import os
import sys

import numpy as np
from PIL import Image

ARRAYS = ("feat_cradio", "feat_moge", "feat_rvm", "baton", "aux", "logits", "alpha", "fg_linear")
PNGS = ("alpha.png", "fg.png", "hint.png", os.path.join("in", "input.png"))


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def png_colortype(path):
    with open(path, "rb") as f:
        head = f.read(26)
    return head[24], head[25]  # IHDR bit depth, colour type


def cases(root):
    for still in sorted(os.listdir(root)):
        d = os.path.join(root, still)
        if not os.path.isdir(d):
            continue
        for case in sorted(os.listdir(d)):
            if os.path.isdir(os.path.join(d, case)):
                yield still, case


def diff(ref, rerun):
    worst = {}
    n = 0
    for still, case in cases(rerun):
        a, b = os.path.join(ref, still, case), os.path.join(rerun, still, case)
        parts = []
        for name in ARRAYS:
            pa, pb = os.path.join(a, name + ".npy"), os.path.join(b, name + ".npy")
            if not os.path.isfile(pb):
                parts.append(f"{name} MISSING in rerun")
                continue
            x, y = np.load(pa), np.load(pb)
            if x.shape != y.shape or x.dtype != y.dtype:
                parts.append(f"{name} SHAPE {x.shape}/{x.dtype} vs {y.shape}/{y.dtype}")
                continue
            d = np.abs(x.astype(np.float64) - y.astype(np.float64))
            mx, mae = float(d.max()), float(d.mean())
            parts.append(f"{name} max {mx:g} mae {mae:g}")
            w = worst.setdefault(name, [0.0, 0.0])
            w[0], w[1] = max(w[0], mx), max(w[1], mae)
        for name in PNGS:
            pa, pb = os.path.join(a, name), os.path.join(b, name)
            if not os.path.isfile(pb):
                if os.path.isfile(pa) and name != "hint.png":
                    parts.append(f"{name} MISSING in rerun")
                continue
            same_bytes = sha(pa) == sha(pb)
            px = np.array_equal(np.asarray(Image.open(pa)), np.asarray(Image.open(pb)))
            parts.append(f"{name.replace(os.sep, '/')} bytes {'same' if same_bytes else 'DIFFER'} pixels "
                         f"{'same' if px else 'DIFFER'}")
            w = worst.setdefault(name.replace(os.sep, "/"), [0, 0])
            w[0] += not same_bytes
            w[1] += not px
        n += 1
        print(f"{still} {case} | " + "; ".join(parts))
    print(f"WORST over {n} cases (arrays: max abs, max of MAE; PNGs: cases whose bytes / pixels differ): {worst}")


def stress(ref, still):
    for case in sorted(os.listdir(os.path.join(ref, still))):
        d = os.path.join(ref, still, case)
        if not os.path.isfile(os.path.join(d, "fg_linear.npy")):
            continue
        fg = np.load(os.path.join(d, "fg_linear.npy")).astype(np.float32)  # HWC
        al = np.load(os.path.join(d, "alpha.npy")).astype(np.float32)  # HW
        m = fg.max(axis=2)
        i = np.unravel_index(int(m.argmax()), m.shape)
        hot = m > 4.0
        nan = int(np.isnan(fg).sum() + np.isnan(al).sum())
        inf = int(np.isinf(fg).sum() + np.isinf(al).sum())
        bd, ct = png_colortype(os.path.join(d, "in", "input.png"))
        print(f"{still} {case}: fg_linear max {float(m[i]):.1f} at alpha {float(al[i]):.3f}; "
              f"{int(hot.sum())} px above 4.0 (mean alpha {float(al[hot].mean()) if hot.any() else float('nan'):.3f}); "
              f"NaN {nan} Inf {inf}; in/input.png bit depth {bd} colour type {ct}")


if __name__ == "__main__":
    if sys.argv[1] == "diff":
        diff(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "stress":
        for s in sys.argv[3:]:
            stress(sys.argv[2], s)
    else:
        sys.exit(2)
