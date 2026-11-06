"""Shared by ck_ref.py (python_embeded) and routeb.py: the rough brush hint and the box plan of PLAN_CORRIDORKEY §4.7.

numpy + cv2 only.
"""
import cv2
import numpy as np


def _ellipse(k):
    k = max(3, int(k) | 1)
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))


def subject_mask(rgb_u8, screen, thresh=30, keep_ratio=0.15):
    """A quick screen-difference key: the subject is where the screen channel does not dominate. Components below
    `keep_ratio` of the largest one are dropped (studio clutter, specks)."""
    r, g, b = (rgb_u8[..., i].astype(np.int16) for i in range(3))
    d = (g - np.maximum(r, b)) if screen == "green" else (b - np.maximum(r, g))
    subj = (d <= thresh).astype(np.uint8)
    h, w = subj.shape
    side = min(h, w)
    subj = cv2.morphologyEx(subj, cv2.MORPH_OPEN, _ellipse(side // 200))
    n, lab, st, _ = cv2.connectedComponentsWithStats(subj, 8)
    if n <= 1:
        return subj
    areas = st[1:, cv2.CC_STAT_AREA]
    big = areas.max()
    keep = np.zeros_like(subj)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] >= keep_ratio * big:
            keep[lab == i] = 1
    keep = cv2.morphologyEx(keep, cv2.MORPH_CLOSE, _ellipse(side // 25))
    return keep


def rough_hint(rgb_u8, screen, mask=None):
    """A rough brush hint, white = subject: the quick key's subject, gaps closed and holes filled, grown by 3 % of the
    short side, then painted over with
    round dabs of radius 4 % on a grid (the blobby overshoot of a quick brush), softened by a small blur. uint8."""
    keep = subject_mask(rgb_u8, screen) if mask is None else mask
    h, w = keep.shape
    side = min(h, w)
    # a brush covers the subject whole: gaps narrower than 8 % of the short side closed (a leaf the quick key missed
    # between others), then every hole filled (the screen seen through glass)
    keep = cv2.morphologyEx(keep.astype(np.uint8), cv2.MORPH_CLOSE, _ellipse(int(0.08 * side)))
    pad = cv2.copyMakeBorder(keep, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    flood = pad.copy()
    cv2.floodFill(flood, np.zeros((h + 4, w + 4), np.uint8), (0, 0), 1)
    keep = np.maximum(keep, (1 - flood[1:-1, 1:-1]).astype(np.uint8))
    grow = int(round(0.03 * side))
    keep = cv2.dilate(keep, _ellipse(2 * grow + 1))
    rad = int(round(0.04 * side))
    step = max(1, rad // 2)
    out = np.zeros((h, w), np.uint8)
    ys, xs = np.nonzero(keep[::step, ::step])
    for y, x in zip(ys, xs):
        cv2.circle(out, (int(x * step), int(y * step)), rad, 255, -1, lineType=cv2.LINE_AA)
    out = cv2.GaussianBlur(out, (0, 0), sigmaX=max(1.0, side / 400.0))
    return out


def box_plan(hint_u8, bucket, width, height, min_side=768):
    """§4.7 points 1-2 for a square bucket. With a hint: the hint's bounds, the longer side times 1.5, at least
    `min_side` and at least the bucket's side (so the resample is always a reduction), squared (the bucket's aspect)
    around the bounds' centre, placed inside the picture where it fits, then clamped to the picture. Without a hint:
    the whole picture. Returns (x, y, w, h) in picture pixels."""
    if hint_u8 is None:
        return 0, 0, width, height
    ys, xs = np.nonzero(hint_u8 > 127)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    side = int(round(max(max(x1 - x0, y1 - y0) * 1.5, min_side, bucket)))
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0

    def place(c, n, size):
        if n >= size:
            return 0, size
        s = int(round(c - n / 2.0))
        return min(max(s, 0), size - n), n

    bx, bw = place(cx, side, width)
    by, bh = place(cy, side, height)
    return bx, by, bw, bh


def fit_bucket(img, box, bucket):
    """The box cropped, reduced with INTER_AREA so its longer side is the bucket's, and reflect-101 padded at the
    centre only for what the picture's edge leaves short. Returns (bucket image, scale, pad (l, r, t, b), size)."""
    x, y, w, h = box
    crop = img[y:y + h, x:x + w]
    s = bucket / float(max(w, h))
    nw, nh = int(round(w * s)), int(round(h * s))
    if (nw, nh) != (w, h):
        crop = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_AREA)
    pl = (bucket - nw) // 2
    pr = bucket - nw - pl
    pt = (bucket - nh) // 2
    pb = bucket - nh - pt
    if pl or pr or pt or pb:
        crop = cv2.copyMakeBorder(crop, pt, pb, pl, pr, cv2.BORDER_REFLECT_101)
    return crop, s, (pl, pr, pt, pb), (nw, nh)
