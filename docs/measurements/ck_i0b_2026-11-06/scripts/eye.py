"""I0b's by-eye check: the hair edge at 100 % from the WebGPU chain beside I0a's bf16 reference and the fp32 run.

    python -I eye.py <ours arrays case dir> <dist/ck_ref case dir> <fp32 case dir> <out.png> [x y size]

Panels (each a crop at 1:1): the input; alpha bf16 reference; alpha WebGPU fp16; alpha fp32; |WebGPU - fp32| x 20;
|bf16 ref - fp32| x 20; the WebGPU key composited over mid grey (fg decoded, sRGB, straight colour times alpha).
"""
import sys

import cv2
import numpy as np

KNEE, DENOM = 0.008, float(np.arcsinh(16.0 / 0.008))


def alpha(lg):
    return np.clip(lg[0], 0, 1)


def comp(lg):
    a = alpha(lg)[..., None]
    lin = np.sinh(lg[1:4].transpose(1, 2, 0) * DENOM) * KNEE
    lin = np.clip(lin, 0, None)
    s = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(np.maximum(lin, 0.0031308), 1 / 2.4) - 0.055)
    s = np.clip(s, 0, 1)
    return s * a + 0.5 * (1 - a)


def main():
    od, rd, fd, out = sys.argv[1:5]
    o = np.load(od + "/logits.npy").astype(np.float32)
    r = np.load(rd + "/logits.npy").astype(np.float32)
    f = np.load(fd + "/logits.npy").astype(np.float32)
    inp = cv2.cvtColor(cv2.imread(rd + "/in/input.png", cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB).astype(np.float32) / 255
    H, W = o.shape[1:]
    size = int(sys.argv[7]) if len(sys.argv) > 7 else 320
    if len(sys.argv) > 6:
        x, y = int(sys.argv[5]), int(sys.argv[6])
    else:   # the densest edge-band window
        a = alpha(f)
        band = ((a > 0.05) & (a < 0.95)).astype(np.float64)
        ii = np.pad(band.cumsum(0).cumsum(1), ((1, 0), (1, 0)))   # window sums by the integral image
        k = ii[size:, size:] - ii[:-size, size:] - ii[size:, :-size] + ii[:-size, :-size]   # (H-size+1, W-size+1), top-left
        y, x = (int(v) for v in np.unravel_index(np.argmax(k), k.shape))
    sl = (slice(y, y + size), slice(x, x + size))
    g = lambda m: np.repeat(m[sl][..., None], 3, 2)
    panels = [inp[sl], g(alpha(r)), g(alpha(o)), g(alpha(f)), g(np.clip(np.abs(alpha(o) - alpha(f)) * 20, 0, 1)),
              g(np.clip(np.abs(alpha(r) - alpha(f)) * 20, 0, 1)), comp(o)[sl], comp(f)[sl]]
    sep = np.ones((size, 4, 3), np.float32)
    row = np.concatenate(sum([[p, sep] for p in panels], [])[:-1], 1)
    cv2.imwrite(out, cv2.cvtColor((row * 255 + 0.5).astype(np.uint8), cv2.COLOR_RGB2BGR))
    print("crop x %d y %d size %d" % (x, y, size))
    d = np.abs(alpha(o) - alpha(f))[sl]
    e = np.abs(alpha(r) - alpha(f))[sl]
    print("in the crop: |webgpu - fp32| mean %.2e max %.3f (levels of 255: mean %.2f, max %.1f); |bf16 - fp32| mean %.2e max %.3f"
          % (d.mean(), d.max(), d.mean() * 255, d.max() * 255, e.mean(), e.max()))
    print("8-bit alpha levels differing by > 2 (webgpu vs fp32): %d of %d px" % ((np.abs(np.round(alpha(o) * 255) - np.round(alpha(f) * 255))[sl] > 2).sum(), d.size))


if __name__ == "__main__":
    main()
