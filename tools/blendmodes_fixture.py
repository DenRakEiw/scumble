"""The source pictures of the blend-mode fixture (docs/PLAN_NIK9_BUILD.md R4-D6 / R4-S3): a backdrop and a patch,
deterministic, so the PSD another editor writes from them (tools/blendmodes_fixture.jsx in Photoshop) can be rebuilt.

    python tools/blendmodes_fixture.py [out-dir]      default dist/fixtures/blendmodes (the sources)
    python tools/blendmodes_fixture.py --strip        after Photoshop: drop the layer metadata (12 MB -> 1.5 MB)

The committed copy is tools/fixtures/blendmodes/ (the gates read it there); dist/fixtures/blendmodes is the workbench.

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

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
OUT = ARGS[0] if ARGS else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist", "fixtures", "blendmodes")
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


def strip_shmd(path):
    """Drop every layer's `shmd` block (Photoshop's layer metadata, about 350 KB per layer here, 10.6 MB of the 12 MB
    file, nothing a reader needs) and rewrite the three lengths above it: the file shrinks to about 1 MB for the repo.
    Readers tolerate a layer without it (Scumble, psd-tools, Krita read the fixture the same)."""
    import struct
    b = bytearray(open(path, "rb").read())
    o = 26
    cm = struct.unpack(">I", b[o:o + 4])[0]; o += 4 + cm
    ir = struct.unpack(">I", b[o:o + 4])[0]; o += 4 + ir
    lm_at = o; lm = struct.unpack(">I", b[o:o + 4])[0]; o += 4
    li_at = o; li = struct.unpack(">I", b[o:o + 4])[0]; o += 4
    n = abs(struct.unpack(">h", b[o:o + 2])[0]); o += 2
    removed = 0
    for _ in range(n):
        o += 16
        nc = struct.unpack(">H", b[o:o + 2])[0]; o += 2 + 6 * nc
        o += 12
        ex_at = o; ex = struct.unpack(">I", b[o:o + 4])[0]; o += 4
        e_start, e_end = o, o + ex
        p = o
        ml = struct.unpack(">I", b[p:p + 4])[0]; p += 4 + ml
        bl = struct.unpack(">I", b[p:p + 4])[0]; p += 4 + bl
        nl = b[p]; p += 1 + nl; p = e_start + ((p - e_start + 3) // 4 * 4)
        cut = []
        while p + 12 <= e_end and b[p:p + 4] in (b"8BIM", b"8B64"):
            key = bytes(b[p + 4:p + 8]); ln = struct.unpack(">I", b[p + 8:p + 12])[0]
            blk = 12 + ln + (ln & 1)
            if key == b"shmd":
                cut.append((p, p + blk))
            p += blk
        for s, e in reversed(cut):
            del b[s:e]
            removed += e - s
            ex -= e - s
        b[ex_at:ex_at + 4] = struct.pack(">I", ex)
        o = e_start + ex
    b[li_at:li_at + 4] = struct.pack(">I", li - removed)
    b[lm_at:lm_at + 4] = struct.pack(">I", lm - removed)
    open(path, "wb").write(bytes(b))
    return removed


def main():
    if "--strip" in sys.argv:
        psd = os.path.join(OUT, "blendmodes.psd")
        print("stripped", strip_shmd(psd), "bytes of layer metadata from", psd, "->", os.path.getsize(psd), "bytes")
        return
    os.makedirs(OUT, exist_ok=True)
    Image.fromarray(backdrop(), "RGB").save(os.path.join(OUT, "backdrop.png"))
    Image.fromarray(patch(), "RGBA").save(os.path.join(OUT, "patch.png"))
    print("wrote", os.path.join(OUT, "backdrop.png"), "and patch.png")


if __name__ == "__main__":
    main()
