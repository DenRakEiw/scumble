"""A 100 % / 200 % look at one spot: for each key png given, the composite over grey and its alpha, cropped at (cx, cy)
in still coordinates with half size r; the keys' own boxes from their names via b0_box.json (or whole pictures)."""
import json
import os
import sys

import cv2
import numpy as np

WORK = r"F:\canvas\.claude\worktrees\ck-b0\dist\ck_b0"
OUT = os.path.dirname(os.path.abspath(__file__))
name, cx, cy, r, tag = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
files = sys.argv[6:]
H = W = 1344


def place(path):
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    full = np.zeros((H, W, 4), np.uint8)
    base = os.path.basename(path)
    box = (0, 0, W, H)
    if "_tight_" in base or "_loose_" in base:
        rep = json.load(open(os.path.join(WORK, "b0_box.json")))
        lab = "tight" if "_tight_" in base else "loose"
        box = rep["cases"][name]["boxes"][lab]
    x0, y0 = box[0], box[1]
    full[y0:y0 + img.shape[0], x0:x0 + img.shape[1]] = img
    return full


tiles = []
for f in files:
    full = place(f)
    c = full[cy - r:cy + r, cx - r:cx + r]
    a = c[..., 3:4].astype(np.float32) / 255.0
    comp = (c[..., :3].astype(np.float32) * a + 128 * (1 - a)).clip(0, 255).astype(np.uint8)
    al = cv2.cvtColor(c[..., 3], cv2.COLOR_GRAY2BGR)
    t = np.concatenate([comp, al], axis=0)
    t = cv2.resize(t, (t.shape[1] * 2, t.shape[0] * 2), interpolation=cv2.INTER_NEAREST)
    cv2.putText(t, os.path.basename(f)[:28], (4, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
    tiles.append(t)
cv2.imwrite(os.path.join(OUT, "zoom_%s.jpg" % tag), np.concatenate(tiles, axis=1), [cv2.IMWRITE_JPEG_QUALITY, 92])
