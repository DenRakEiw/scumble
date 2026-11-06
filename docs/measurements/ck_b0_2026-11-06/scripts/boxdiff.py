"""Where the tight box's key differs from the whole picture's: alpha (tight), alpha (whole), |difference| x4, the
composite of each over grey, for one still; the tight box's place from b0_box.json. Writes <name>_diff.jpg here."""
import json
import os
import sys

import cv2
import numpy as np

WORK = r"F:\canvas\.claude\worktrees\ck-b0\dist\ck_b0"
OUT = os.path.dirname(os.path.abspath(__file__))
name, hint = sys.argv[1], sys.argv[2]
rep = json.load(open(os.path.join(WORK, "b0_box.json")))
case = rep["cases"][name]
tx0, ty0, tx1, ty1 = case["boxes"]["tight"]
t = cv2.imread(os.path.join(WORK, "box", "%s_tight_%s.png" % (name, hint)), cv2.IMREAD_UNCHANGED)
w = cv2.imread(os.path.join(WORK, "box", "%s_whole_%s.png" % (name, hint)), cv2.IMREAD_UNCHANGED)[ty0:ty1, tx0:tx1]
at, aw = t[..., 3].astype(np.float32), w[..., 3].astype(np.float32)
d = np.abs(at - aw)
print(name, hint, "tight box", case["boxes"]["tight"], "px |d|>25:", int((d > 25).sum()))
ys, xs = np.nonzero(d > 25)
if len(xs):
    print(" where: x %d..%d y %d..%d (in the tight box)" % (xs.min(), xs.max(), ys.min(), ys.max()))
    # the share of those pixels in the outer 24 px ring
    ring = np.zeros_like(d, bool)
    ring[:24], ring[-24:], ring[:, :24], ring[:, -24:] = True, True, True, True
    print(" in the 24 px ring: %d of %d" % (int(((d > 25) & ring).sum()), int((d > 25).sum())))
    # which side has more alpha where they differ
    sel = d > 25
    print(" mean alpha there: tight %.1f whole %.1f" % (at[sel].mean(), aw[sel].mean()))


def comp(img):
    a = img[..., 3:4].astype(np.float32) / 255.0
    return (img[..., :3].astype(np.float32) * a + 128 * (1 - a)).clip(0, 255).astype(np.uint8)


heat = cv2.applyColorMap(np.clip(d * 4, 0, 255).astype(np.uint8), cv2.COLORMAP_INFERNO)
row = np.concatenate([cv2.cvtColor(at.astype(np.uint8), cv2.COLOR_GRAY2BGR), cv2.cvtColor(aw.astype(np.uint8), cv2.COLOR_GRAY2BGR),
                      heat, comp(t), comp(w)], axis=1)
s = min(1.0, 2400.0 / row.shape[1])
row = cv2.resize(row, (int(row.shape[1] * s), int(row.shape[0] * s)), interpolation=cv2.INTER_AREA)
cv2.imwrite(os.path.join(OUT, "%s_%s_diff.jpg" % (name, hint)), row, [cv2.IMWRITE_JPEG_QUALITY, 90])
