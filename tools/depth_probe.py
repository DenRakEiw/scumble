"""Depth probe tool for Nik-9 Parity R1-S2 checkpoint.

Processes test pictures to produce raw and guided depth maps, contact sheets, and benchmarks:
    python tools/depth_probe.py --self-test
    python tools/depth_probe.py --all
    python tools/depth_probe.py --image path/to/image.jpg
"""
import argparse
import json
import os
import sys
import time
import numpy as np
from PIL import Image

# Prevent DecompressionBombError on large 15k images
Image.MAX_IMAGE_PIXELS = None

IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]
LUMA = [0.299, 0.587, 0.114]


def dpt_model_size(w, h, short=518, multiple=14):
    """Compute DPT model input size with keep_aspect_ratio and multiple of 14.
    
    Uses round-half-to-even (Python's round()).
    """
    if w <= short and h <= short:
        scale = short / max(w, h)
    elif w >= short and h >= short:
        scale = short / min(w, h)
    else:
        scale = short / (h if abs(h - short) <= abs(w - short) else w)

    nw = round((w * scale) / multiple) * multiple
    nh = round((h * scale) / multiple) * multiple
    return max(multiple, int(nw)), max(multiple, int(nh))


def work_size(w, h, max_dim=4096):
    """Compute working size capped at max_dim, keeping aspect ratio."""
    m = max(w, h)
    if m <= max_dim:
        return int(w), int(h)
    scale = max_dim / float(m)
    return max(1, int(round(w * scale))), max(1, int(round(h * scale)))


def disparity_range(d, p_lo=0.005, p_hi=0.995):
    """Compute disparity bounds using 4096-bin histogram or percentiles."""
    lo = float(np.percentile(d, p_lo * 100.0))
    hi = float(np.percentile(d, p_hi * 100.0))
    if hi <= lo:
        hi = lo + 1e-6
    return lo, hi


def far_u16(d, lo, hi):
    """Convert disparity to u16 far map: near (hi) -> 0, far (lo) -> 65535."""
    norm = np.clip((d - lo) / (hi - lo), 0.0, 1.0)
    far = 1.0 - norm
    return np.round(far * 65535.0).astype(np.uint16)


def box_filter_1d(arr, r, axis=-1):
    """1D box filter with clamped (edge) boundary condition."""
    if r <= 0:
        return arr.copy()
    k = 2 * r + 1
    pad_width = [(0, 0)] * arr.ndim
    pad_width[axis] = (r, r)
    padded = np.pad(arr, pad_width, mode="edge")
    c = np.cumsum(padded, axis=axis, dtype=np.float64)
    zero_shape = list(padded.shape)
    zero_shape[axis] = 1
    c = np.concatenate([np.zeros(zero_shape, dtype=np.float64), c], axis=axis)
    slice_high = [slice(None)] * arr.ndim
    slice_high[axis] = slice(k, None)
    slice_low = [slice(None)] * arr.ndim
    slice_low[axis] = slice(0, -k)
    res = (c[tuple(slice_high)] - c[tuple(slice_low)]) / float(k)
    return res.astype(np.float32)


def box_filter_2d(arr, r):
    """2D separable box filter with clamped edges matching crates/px/src/maskf.rs."""
    return box_filter_1d(box_filter_1d(arr, r, axis=1), r, axis=0)


def bilinear_resize(src, w_out, h_out):
    """Bilinear resize matching pixel centers with edge clamp."""
    h_in, w_in = src.shape
    x_ratio = float(w_in) / float(w_out)
    y_ratio = float(h_in) / float(h_out)
    xs = (np.arange(w_out, dtype=np.float32) + 0.5) * x_ratio - 0.5
    ys = (np.arange(h_out, dtype=np.float32) + 0.5) * y_ratio - 0.5
    x0 = np.clip(np.floor(xs).astype(np.int32), 0, w_in - 1)
    x1 = np.clip(x0 + 1, 0, w_in - 1)
    wx = np.clip(xs - np.floor(xs), 0.0, 1.0)
    y0 = np.clip(np.floor(ys).astype(np.int32), 0, h_in - 1)
    y1 = np.clip(y0 + 1, 0, h_in - 1)
    wy = np.clip(ys - np.floor(ys), 0.0, 1.0)
    top = (1.0 - wx)[None, :] * src[y0[:, None], x0[None, :]] + wx[None, :] * src[y0[:, None], x1[None, :]]
    bottom = (1.0 - wx)[None, :] * src[y1[:, None], x0[None, :]] + wx[None, :] * src[y1[:, None], x1[None, :]]
    return ((1.0 - wy)[:, None] * top + wy[:, None] * bottom).astype(np.float32)


def guided_filter(I, p, r, eps):
    """Guided filter (He et al.) using box filters with clamped edges.
    
    I: guide image (float32 in 0..1)
    p: input depth (float32 in 0..1)
    r: filter radius in pixels
    eps: regularization
    """
    mean_I = box_filter_2d(I, r)
    mean_p = box_filter_2d(p, r)
    mean_Ip = box_filter_2d(I * p, r)
    cov_Ip = mean_Ip - mean_I * mean_p

    mean_II = box_filter_2d(I * I, r)
    var_I = mean_II - mean_I * mean_I

    a = cov_Ip / (var_I + eps)
    b = mean_p - a * mean_I

    mean_a = box_filter_2d(a, r)
    mean_b = box_filter_2d(b, r)

    q = mean_a * I + mean_b
    return np.clip(q, 0.0, 1.0)


def colormap_warm_cool(val_01):
    """Map normalized values in 0..1 (near=0 warm, far=1 cool) to RGB uint8."""
    # 5 anchor points
    # 0.00: warm light amber [255, 220, 140]
    # 0.25: bright warm red-orange [235, 75, 35]
    # 0.50: magenta-violet [160, 40, 140]
    # 0.75: vibrant blue [40, 95, 210]
    # 1.00: deep cool navy [15, 25, 70]
    anchors = np.array([
        [255, 220, 140],
        [235, 75, 35],
        [160, 40, 140],
        [40, 95, 210],
        [15, 25, 70],
    ], dtype=np.float32)
    t = np.clip(val_01, 0.0, 1.0) * 4.0
    idx = np.clip(np.floor(t).astype(np.int32), 0, 3)
    frac = (t - idx)[..., None]
    rgb = (1.0 - frac) * anchors[idx] + frac * anchors[idx + 1]
    return np.round(rgb).astype(np.uint8)


def pack_rg16(u16_arr):
    """Pack uint16 into RGBA8 (R high byte, G low byte, B=0, A=255)."""
    h, w = u16_arr.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[:, :, 0] = (u16_arr >> 8).astype(np.uint8)
    rgba[:, :, 1] = (u16_arr & 0xff).astype(np.uint8)
    rgba[:, :, 3] = 255
    return rgba


def run_self_test():
    """Verify DPT sizing rule against table from PLAN_NIK9_BUILD.md."""
    table = [
        ((6000, 4000), (784, 518)),
        ((2000, 1125), (924, 518)),
        ((1500, 2000), (518, 686)),
        ((400, 300), (518, 392)),
        ((763, 518), (756, 518)),
        ((15000, 10000), (784, 518)),
        ((6000, 1000), (3108, 518)),
    ]
    failures = 0
    print("Running depth_probe --self-test:")
    for (w, h), (ew, eh) in table:
        gw, gh = dpt_model_size(w, h)
        ok = (gw == ew and gh == eh)
        print(f"  ({w}, {h}) -> ({gw}, {gh}) [expected ({ew}, {eh})]: {'ok' if ok else 'FAIL'}")
        if not ok:
            failures += 1

    if failures == 0:
        print("All 7 sizing tests passed!")
        return 0
    else:
        print(f"{failures} tests failed!")
        return 1


def find_model_path():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    candidates = [
        os.path.join(os.environ.get("APPDATA", ""), "Scumble", "models", "depth_anything_v2_small.onnx"),
        os.path.join(root, "models", "depth_anything_v2_small.onnx"),
    ]
    for p in candidates:
        if os.path.exists(p) and os.path.getsize(p) > 0:
            return p
    return None


def probe_image(img_path, model_path, out_root):
    base_name = os.path.splitext(os.path.basename(img_path))[0]
    out_dir = os.path.join(out_root, base_name)
    os.makedirs(out_dir, exist_ok=True)
    print(f"\n========================================================")
    print(f"Probing {img_path} -> {out_dir}")

    im = Image.open(img_path).convert("RGB")
    W, H = im.size
    print(f"Input size: {W} x {H}")

    mw, mh = dpt_model_size(W, H)
    print(f"Model input size: {mw} x {mh}")

    # Prepare model input (bicubic resize to mw x mh, normalize ImageNet)
    t0_prep = time.time()
    im_model = im.resize((mw, mh), resample=Image.Resampling.BICUBIC)
    rgb_model = np.array(im_model, dtype=np.float32) / 255.0
    pixel_values = (rgb_model - IMAGENET_MEAN) / IMAGENET_STD
    pixel_values = np.transpose(pixel_values, (2, 0, 1))[None, ...].astype(np.float32)
    prep_ms = (time.time() - t0_prep) * 1000.0

    # Run ONNX inference
    import onnxruntime as ort
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    inp_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name

    # Warmup
    sess.run([out_name], {inp_name: pixel_values})

    t0_inf = time.time()
    out = sess.run([out_name], {inp_name: pixel_values})[0]
    inf_ms = (time.time() - t0_inf) * 1000.0
    raw_depth = np.squeeze(out).astype(np.float32)
    print(f"Inference time (CPU): {inf_ms:.1f} ms, output shape: {raw_depth.shape}")

    # Disparity range & far conversion
    lo, hi = disparity_range(raw_depth)
    raw_far_u16 = far_u16(raw_depth, lo, hi)
    raw_far_f32 = 1.0 - np.clip((raw_depth - lo) / (hi - lo), 0.0, 1.0)

    # 1. raw16.png and raw.f32
    raw_depth.tofile(os.path.join(out_dir, "raw.f32"))
    raw16_path = os.path.join(out_dir, "raw16.png")
    Image.fromarray(raw_far_u16).save(raw16_path)

    # 2. raw_colour.jpg
    raw_col = colormap_warm_cool(raw_far_f32)
    raw_col_path = os.path.join(out_dir, "raw_colour.jpg")
    Image.fromarray(raw_col).save(raw_col_path, quality=92)

    # Prepare working resolutions: 2048 and 4096
    working_targets = [2048, 4096]
    numbers = {
        "name": base_name,
        "input_size": [W, H],
        "model_size": [mw, mh],
        "inference_cpu_ms": round(inf_ms, 1),
        "disparity_range": {"lo": float(lo), "hi": float(hi)},
        "working_maps": {},
        "files": {},
    }

    best_guided_img = None
    best_guided_tag = None

    for target_dim in working_targets:
        gw, gh = work_size(W, H, target_dim)
        print(f"\nWorking resolution {target_dim} px: {gw} x {gh}")

        # Guide image I (grayscale luma in 0..1 from Uint8Array matching host.depthInput)
        im_guide = im.resize((gw, gh), resample=Image.Resampling.BILINEAR)
        rgb_guide = np.array(im_guide, dtype=np.float32)
        grey_u8 = np.clip(np.round(rgb_guide[:, :, 0] * LUMA[0] + rgb_guide[:, :, 1] * LUMA[1] + rgb_guide[:, :, 2] * LUMA[2]), 0, 255).astype(np.uint8)
        grey_u8.tofile(os.path.join(out_dir, f"grey_{gw}x{gh}.u8"))
        if not os.path.exists(os.path.join(out_dir, "grey.u8")) or target_dim == 2048:
            grey_u8.tofile(os.path.join(out_dir, "grey.u8"))
        I = grey_u8.astype(np.float32) / 255.0

        # Bilinear upsample raw depth to gw x gh
        p = bilinear_resize(raw_far_f32, gw, gh)

        # Scale factor from model to working map
        scale_to_work = gw / float(mw)

        # Guided filter for r in {1, 2, 4} model px and eps in {1e-4, 1e-3, 1e-2}
        eps_list = [1e-4, 1e-3, 1e-2]
        r_model_list = [1, 2, 4]

        res_key = f"{target_dim}"
        numbers["working_maps"][res_key] = {"size": [gw, gh], "runs": {}}

        for r_m in r_model_list:
            r_work = max(1, int(round(r_m * scale_to_work)))
            for eps in eps_list:
                eps_str = "1e-4" if eps == 1e-4 else ("1e-3" if eps == 1e-3 else "1e-2")
                tag = f"guided_{target_dim}_r{r_m}_e{eps_str}"

                t0_g = time.time()
                q = guided_filter(I, p, r_work, eps)
                g_ms = (time.time() - t0_g) * 1000.0

                q_u16 = np.round(q * 65535.0).astype(np.uint16)
                out_png = os.path.join(out_dir, f"{tag}.png")
                Image.fromarray(q_u16).save(out_png)
                png_bytes = os.path.getsize(out_png)

                numbers["working_maps"][res_key]["runs"][f"r{r_m}_e{eps_str}"] = {
                    "r_model": r_m,
                    "r_work": r_work,
                    "eps": eps,
                    "time_ms": round(g_ms, 1),
                    "bytes": png_bytes,
                }

                # Default candidate: 2048 or 4096 with r=2, eps=1e-3
                if (target_dim == 2048 or best_guided_img is None) and r_m == 2 and eps == 1e-3:
                    best_guided_img = q
                    best_guided_tag = tag

        # Packed RG8 PNG at this resolution
        best_u16 = np.round((q if target_dim == 4096 else p) * 65535.0).astype(np.uint16)
        packed_rgba = pack_rg16(best_u16)
        packed_path = os.path.join(out_dir, f"packed_rg_{target_dim}.png")
        Image.fromarray(packed_rgba, mode="RGBA").save(packed_path)
        numbers["files"][f"packed_rg_{target_dim}_bytes"] = os.path.getsize(packed_path)
        if target_dim == 2048 or not os.path.exists(os.path.join(out_dir, "packed_rg.png")):
            Image.fromarray(packed_rgba, mode="RGBA").save(os.path.join(out_dir, "packed_rg.png"))

    # Contact sheet: Photo | Raw Depth (Color) | Best Guided Depth (Color)
    sheet_h = 600
    sheet_w_photo = int(round(W * (sheet_h / float(H))))
    sheet_w_raw = int(round(mw * (sheet_h / float(mh))))
    sheet_w_best = int(round(gw * (sheet_h / float(gh))))

    im_photo_s = im.resize((sheet_w_photo, sheet_h), resample=Image.Resampling.BILINEAR)
    im_raw_s = Image.fromarray(raw_col).resize((sheet_w_raw, sheet_h), resample=Image.Resampling.BILINEAR)
    best_col = colormap_warm_cool(best_guided_img)
    im_best_s = Image.fromarray(best_col).resize((sheet_w_best, sheet_h), resample=Image.Resampling.BILINEAR)

    total_w = sheet_w_photo + sheet_w_raw + sheet_w_best
    sheet = Image.new("RGB", (total_w, sheet_h))
    sheet.paste(im_photo_s, (0, 0))
    sheet.paste(im_raw_s, (sheet_w_photo, 0))
    sheet.paste(im_best_s, (sheet_w_photo + sheet_w_raw, 0))
    sheet_path = os.path.join(out_dir, "sheet.jpg")
    sheet.save(sheet_path, quality=90)
    print(f"Contact sheet saved: {sheet_path} ({total_w} x {sheet_h})")

    # Record final file sizes
    numbers["files"]["raw16_bytes"] = os.path.getsize(raw16_path)
    numbers["files"]["raw_colour_bytes"] = os.path.getsize(raw_col_path)
    numbers["files"]["sheet_bytes"] = os.path.getsize(sheet_path)
    numbers["best_guide"] = best_guided_tag

    numbers_path = os.path.join(out_dir, "numbers.json")
    with open(numbers_path, "w", encoding="utf-8") as f:
        json.dump(numbers, f, indent=2)
    print(f"Numbers saved: {numbers_path}")

    return numbers


def main():
    parser = argparse.ArgumentParser(description="Depth probe tool (Nik-9 Parity R1-S2)")
    parser.add_argument("--self-test", action="store_true", help="Run sizing self-test")
    parser.add_argument("--all", action="store_true", help="Run on standard images: scene.jpg, skin.jpg, 15k")
    parser.add_argument("--image", help="Path to single image to probe")
    parser.add_argument("--model", help="Path to depth_anything_v2_small.onnx (default: app models dir)")
    parser.add_argument("--out", default=r"dist\depth_checkpoint", help="Output directory")
    args = parser.parse_args()

    if args.self_test:
        sys.exit(run_self_test())

    model = args.model or find_model_path()
    if not model or not os.path.exists(model):
        print(f"Model file not found: {model}")
        print("Please check models directory or specify --model")
        sys.exit(1)

    print(f"Using ONNX model: {model} ({os.path.getsize(model):,} bytes)")

    images = []
    if args.all:
        candidates = [
            r"docs\images\tutorial\scene.jpg",
            r"docs\images\tutorial\skin.jpg",
            r"dist\daily\adobe_15000x10000.jpg",
        ]
        for c in candidates:
            if os.path.exists(c):
                images.append(c)
    elif args.image:
        images.append(args.image)
    else:
        # Default run self-test then all
        run_self_test()
        images = [
            r"docs\images\tutorial\scene.jpg",
            r"docs\images\tutorial\skin.jpg",
            r"dist\daily\adobe_15000x10000.jpg",
        ]

    for img in images:
        if os.path.exists(img):
            probe_image(img, model, args.out)
        else:
            print(f"Image not found: {img}")


if __name__ == "__main__":
    main()
