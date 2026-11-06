"""A survey over the user's LoRA folders: each file's header only (8 bytes + JSON, read-only), reduced to a signature
(the naming scheme, the double / single block counts, the hidden width), counted per folder. Writes nothing beside
its own stdout."""
import collections
import json
import os
import re
import struct
import sys

ROOT = sys.argv[1]
FOLDERS = sys.argv[2:]

def header(p):
    with open(p, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        if n > 64 * 1024 * 1024:
            return None
        return json.loads(f.read(n))

UP = (".lora_B.weight", ".lora_up.weight", ".lora_B.default.weight", ".lora.up.weight", ".lora_B")

def sig(h):
    keys = [k for k in h if k != "__metadata__"]
    meta = h.get("__metadata__") or {}
    def idx(pat):
        s = set()
        w = None
        for k in keys:
            m = re.search(pat, k)
            if m:
                s.add(int(m.group(1)))
                if w is None and k.endswith(UP):
                    w = (h[k].get("shape") or [None])[0]
        return len(s), w
    d, dw = idx(r"(?:^|[._])double_blocks[._](\d+)[._]")
    s, sw = idx(r"(?:^|[._])single_blocks[._](\d+)[._]")
    td, tdw = idx(r"(?:^|[._])transformer_blocks[._](\d+)[._]")
    ts, tsw = idx(r"single_transformer_blocks[._](\d+)[._]")
    cm, cmw = idx(r"content_mode_blocks[._][a-z]+[._](\d+)[._]")
    la, law = idx(r"(?:^|[._])layers[._](\d+)[._]")
    scheme = []
    if any(k.startswith("lora_te1_") or k.startswith("lora_te2_") for k in keys): scheme.append("te12")
    if any("input_blocks" in k or "down_blocks" in k for k in keys): scheme.append("unet")
    if any(k.startswith("lora_unet_") for k in keys): scheme.append("kohya")
    if any(k.startswith("diffusion_model.") for k in keys): scheme.append("dm")
    if any(k.startswith("transformer.") for k in keys): scheme.append("tr")
    if any("add_k_proj" in k for k in keys): scheme.append("add_k")
    if any("img_mlp" in k for k in keys): scheme.append("img_mlp")
    out = {"scheme": "+".join(scheme)}
    if d or s: out["flux"] = (d, s, dw)
    if ts: out["diffusers"] = (td, ts, tdw)
    elif td: out["tb"] = (td, tdw)
    if cm: out["f3"] = (cm, s, cmw)
    if la: out["layers"] = (la, law)
    out["base"] = meta.get("ss_base_model_version")
    return json.dumps(out, sort_keys=True)

for folder in FOLDERS:
    base = os.path.join(ROOT, folder)
    count = collections.Counter()
    example = {}
    for dirpath, _, files in os.walk(base):
        for fn in files:
            if not fn.endswith(".safetensors"):
                continue
            p = os.path.join(dirpath, fn)
            try:
                h = header(p)
                k = sig(h) if h is not None else "too large"
            except Exception as e:  # noqa: BLE001
                k = "ERR " + type(e).__name__
            count[k] += 1
            example.setdefault(k, os.path.relpath(p, ROOT))
    print("=== %s (%d files)" % (folder, sum(count.values())))
    for k, n in count.most_common():
        print("  %4d  %s   e.g. %s" % (n, k, example[k]))
