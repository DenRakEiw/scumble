"""SP0 step 1: Marigold-IID-Lighting v1.1 in diffusers, 1 and 4 steps, on the test pictures.
Writes per picture: albedo (sRGB), shading and residual (scaled for viewing), the recomposition A*S+R against the
picture (after a least-squares scale of S and R, since both are up to scale), and timings."""
import json, sys, time, os
import numpy as np, torch
from PIL import Image
from diffusers import MarigoldIntrinsicsPipeline

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "marigold-iid-lighting-v1-1")
OUT = os.path.join(HERE, "out_torch")
os.makedirs(OUT, exist_ok=True)
PICS = json.load(open(os.path.join(HERE, "pics.json")))


def srgb_to_lin(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def save(arr, path):
    Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8)).save(path)


pipe = MarigoldIntrinsicsPipeline.from_pretrained(MODEL, variant="fp16", torch_dtype=torch.float16).to("cuda")
pipe.set_progress_bar_config(disable=True)
report = []
for name, path in PICS.items():
    img = Image.open(path).convert("RGB")
    for steps in (1, 4):
        g = torch.Generator("cuda").manual_seed(0)
        pipe(img, num_inference_steps=steps, processing_resolution=768, generator=g)  # warm
        torch.cuda.synchronize()
        t0 = time.perf_counter()
        g = torch.Generator("cuda").manual_seed(0)
        out = pipe(img, num_inference_steps=steps, processing_resolution=768, generator=g)
        torch.cuda.synchronize()
        dt = time.perf_counter() - t0
        pred = out.prediction  # (3, H, W, 3): albedo, shading, residual, linear
        A, S, R = pred[0], pred[1], pred[2]
        H, W = A.shape[:2]
        I = srgb_to_lin(np.asarray(img.resize((W, H), Image.LANCZOS), dtype=np.float32) / 255.0)
        # least squares for I ~ a*(A*S) + b*R
        X = np.stack([(A * S).ravel(), R.ravel()], 1)
        (a, b), *_ = np.linalg.lstsq(X, I.ravel(), rcond=None)
        rec = a * A * S + b * R
        err = np.abs(lin_to_srgb(rec) - lin_to_srgb(I)) * 255
        tag = f"{name}_s{steps}"
        save(lin_to_srgb(A), os.path.join(OUT, tag + "_albedo.png"))
        save(lin_to_srgb(a * S / max(1e-6, np.percentile(a * S, 99.5))), os.path.join(OUT, tag + "_shading.png"))
        save(lin_to_srgb(b * R / max(1e-6, np.percentile(b * R, 99.5))), os.path.join(OUT, tag + "_residual.png"))
        save(lin_to_srgb(rec), os.path.join(OUT, tag + "_recomposed.png"))
        row = dict(pic=name, steps=steps, size=[W, H], seconds=round(dt, 3), scale_S=float(a), scale_R=float(b),
                   rec_mean_err=float(err.mean()), rec_p99_err=float(np.percentile(err, 99)),
                   residual_share=float((b * R).mean() / max(1e-6, I.mean())))
        report.append(row)
        print(json.dumps(row), flush=True)
json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)
print("vram_peak_GB", round(torch.cuda.max_memory_allocated() / 2**30, 2))
