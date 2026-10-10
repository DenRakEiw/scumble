"""The source pictures of the blend-mode fixture (docs/PLAN_NIK9_BUILD.md R4-D6 / R4-S3): a backdrop and a patch,
deterministic, so the PSD another editor writes from them (tools/blendmodes_fixture.jsx in Photoshop) can be rebuilt.

    python tools/blendmodes_fixture.py [out-dir]      default dist/fixtures/blendmodes

Writes backdrop.png (512 x 512, opaque: a hue sweep across, a luminance sweep down, a soft checker so every mode has
light and dark, saturated and grey backdrop pixels to act on) and patch.png (80 x 80 RGBA: a diagonal colour gradient
through grey with a soft-edged disc alpha, so the blend sees every source colour and every alpha). Then the JSX puts
the patch once per blend mode into a 6 x 5 grid of cells (cell size 84, origin 4), sets the mode, and saves the PSD
and the merged picture; the cell of each mode is in the JSX's list (and in modes.json it writes).
"""
import os
import sys

import numpy as np
from PIL import Image

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist", "fixtures", "blendmodes")
W = H = 512
P = 80


def hsv_to_rgb(h, s, v):
    i = np.floor(h * 6).astype(int) % 6
    f = h * 6 - np.floor(h * 6)
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    r = np.choose(i, [v, q, p, p, t, v])
    g = np.choose(i, [t, v, v, q, p, p])
    b = np.choose(i, [p, p, t, v, v, q])
    return np.stack([r, g, b], axis=-1)


def backdrop():
    y, x = np.mgrid[0:H, 0:W].astype(np.float64)
    hue = x / W
    lum = 0.15 + 0.7 * (y / H)
    sat = 0.35 + 0.6 * (0.5 + 0.5 * np.sin((x / 64.0) * np.pi) * np.sin((y / 64.0) * np.pi))   # a soft checker of saturation
    rgb = hsv_to_rgb(hue, sat, lum)
    # a grey band and a white / black strip, so the modes meet neutral and extreme backdrops too
    rgb[200:232, :, :] = (0.5 + 0.4 * (x[200:232, :] / W - 0.5))[..., None]
    rgb[480:496, :, :] = 1.0
    rgb[496:512, :, :] = 0.0
    return (np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8)


def patch():
    y, x = np.mgrid[0:P, 0:P].astype(np.float64)
    t = (x + y) / (2 * (P - 1))                       # 0 top-left .. 1 bottom-right
    hue = (0.08 + 0.84 * t) % 1.0
    sat = np.clip(np.abs(t - 0.5) * 2.4, 0, 1)        # grey in the middle of the diagonal, saturated at the ends
    val = 0.2 + 0.8 * (x / (P - 1))                   # dark at the left, bright at the right
    rgb = hsv_to_rgb(hue, sat, val)
    cx = cy = (P - 1) / 2
    d = np.hypot(x - cx, y - cy)
    alpha = np.clip((P / 2 - 4 - d) / 12.0, 0, 1)      # a disc with a 12 px soft edge
    alpha[y < P * 0.25] = np.minimum(alpha[y < P * 0.25], 0.5)   # the top quarter half transparent: partial alpha everywhere
    out = np.zeros((P, P, 4), np.uint8)
    out[..., :3] = (np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8)
    out[..., 3] = (alpha * 255 + 0.5).astype(np.uint8)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    Image.fromarray(backdrop(), "RGB").save(os.path.join(OUT, "backdrop.png"))
    Image.fromarray(patch(), "RGBA").save(os.path.join(OUT, "patch.png"))
    print("wrote", os.path.join(OUT, "backdrop.png"), "and patch.png")


if __name__ == "__main__":
    main()
