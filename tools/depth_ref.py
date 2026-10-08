"""Python reference for Depth Anything V2 Small helper (R1-S1).

Uses DPTImageProcessor from transformers with ImageNet normalization and onnxruntime on CPU.
Writes synthetic test inputs and references when given --write <dir>:
    python tools/depth_ref.py --model <path/to/depth_anything_v2_small.onnx> --write <dir>
"""
import argparse
import os
import sys
import numpy as np

IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]


def make_synthetic_scene(w, h):
    from PIL import Image
    yh = int(0.35 * h)
    cx = w / 2.0
    f = h * 0.8
    s = 40.0
    arr = np.zeros((h, w, 4), dtype=np.uint8)
    for y in range(h):
        for x in range(w):
            if y < yh:
                t = y / max(1, yh)
                arr[y, x] = [int(100 + 80 * t), int(140 + 60 * t), int(220 + 20 * t), 255]
            else:
                dy = y - yh + 1
                z = f / dy
                X = (x - cx) * z / f
                chk = 220 if ((int(np.floor(X / s)) + int(np.floor(z / s))) & 1) else 60
                fog = min(1.0, max(0.0, 1.0 - 20.0 / z))
                v = int(chk * (1.0 - fog) + 128 * fog)
                arr[y, x] = [v, v, v, 255]
    return Image.fromarray(arr, "RGBA")


def main():
    parser = argparse.ArgumentParser(description="Depth Anything V2 Small reference")
    parser.add_argument("--model", help="Path to depth_anything_v2_small.onnx")
    parser.add_argument("--write", help="Output directory to write input_*.rgba and ref_*.f32")
    parser.add_argument("--shapes", default="784x518,518x518", help="Comma-separated wxh shapes to generate")
    args = parser.parse_args()

    if not args.write or not args.model:
        parser.print_help()
        sys.exit(0)

    if not os.path.exists(args.model):
        print(f"Model not found: {args.model}")
        sys.exit(1)

    import onnxruntime as ort
    from transformers import DPTImageProcessor

    processor = DPTImageProcessor(
        do_resize=True,
        size={"height": 518, "width": 518},
        keep_aspect_ratio=True,
        ensure_multiple_of=14,
        resample=3,
        do_rescale=True,
        rescale_factor=1.0 / 255.0,
        do_normalize=True,
        image_mean=IMAGENET_MEAN,
        image_std=IMAGENET_STD,
    )

    sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    input_name = sess.get_inputs()[0].name
    output_name = sess.get_outputs()[0].name

    os.makedirs(args.write, exist_ok=True)
    shapes = [tuple(map(int, s.split("x"))) for s in args.shapes.split(",")]

    for w, h in shapes:
        img = make_synthetic_scene(w, h)
        inputs = processor(images=img, return_tensors="np")
        pixel_values = inputs["pixel_values"]  # [1, 3, H, W]

        # Resized RGBA input as raw bytes
        rgb_resized = ((pixel_values[0].transpose(1, 2, 0) * IMAGENET_STD + IMAGENET_MEAN) * 255.0).clip(0, 255).astype(np.uint8)
        H_out, W_out = rgb_resized.shape[0], rgb_resized.shape[1]
        rgba_out = np.zeros((H_out, W_out, 4), dtype=np.uint8)
        rgba_out[:, :, :3] = rgb_resized
        rgba_out[:, :, 3] = 255

        rgba_path = os.path.join(args.write, f"input_{W_out}x{H_out}.rgba")
        with open(rgba_path, "wb") as f:
            f.write(rgba_out.tobytes())

        # Run ONNX session
        out = sess.run([output_name], {input_name: pixel_values})[0]
        depth_map = np.squeeze(out).astype(np.float32)

        ref_path = os.path.join(args.write, f"ref_{W_out}x{H_out}.f32")
        with open(ref_path, "wb") as f:
            f.write(depth_map.tobytes())

        print(f"Wrote {rgba_path} and {ref_path} ({W_out}x{H_out})")


if __name__ == "__main__":
    main()
