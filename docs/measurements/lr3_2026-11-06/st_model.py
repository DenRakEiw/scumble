"""A base model's block counts and hidden width from its safetensors header alone (read-only, 8 bytes + JSON)."""
import json
import re
import struct
import sys

for p in sys.argv[1:]:
    with open(p, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        h = json.loads(f.read(n))
    keys = [k for k in h if k != "__metadata__"]
    def idx(pat):
        return sorted({int(m.group(1)) for k in keys for m in [re.search(pat, k)] if m})
    d = idx(r"(?:^|\.)double_blocks\.(\d+)\.")
    s = idx(r"(?:^|\.)single_blocks\.(\d+)\.")
    cm = idx(r"content_mode_blocks\.[a-z]+\.(\d+)\.")
    shapes = {}
    for k in keys:
        if re.search(r"double_blocks\.0\.img_attn\.proj\.weight$|single_blocks\.0\.linear1\.weight$|single_blocks\.0\.linear2\.weight$|double_blocks\.0\.img_mlp\.0\.weight$|content_mode_blocks\.image\.0\.attn_out\.weight$", k):
            shapes[k.split("diffusion_model.")[-1]] = h[k].get("shape")
    print("###", p.rsplit("/", 1)[-1], "header", n, "keys", len(keys))
    print("  double", len(d), d[-1] if d else None, "single", len(s), s[-1] if s else None, "content_mode", len(cm))
    for k, v in sorted(shapes.items()):
        print("  ", k, v)
