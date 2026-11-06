"""I0b's calibration: I0a's reference cases run again with upstream's code in float32 (no bf16 autocast, no bf16 rounding
of the inputs), so that the bf16 reference's own error and the ONNX fp16 error can both be stated against fp32.

    python_embeded\\python.exe -I -B ck_ref_fp32.py <out dir> [still ...]

Same loader as I0a's ck_ref.py (pack A's vendored upstream `corridorkey` by path, pack A's ck_comfy/env.py for MoGe and
C-RADIO), the same steps per case (RVM bilinear H/4 zero state normalised; C-RADIO / MoGe through model.foundations on
the area resizes; stage 1; stage 2), every tensor float32. Besides the chain it writes s2bf16_logits: stage 2 in fp32 on
I0a's bf16 baton (the isolated stage 2 row's calibration). Reads I0a's case folders (dist/ck_ref), writes only <out>.
"""
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

PACK = Path(r"F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-CorridorKey2.0")
MODELS = Path(r"F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\models\corridorkey2")
REF = Path(r"F:\canvas\.claude\worktrees\corridorkey\dist\ck_ref")
STILLS = ["blue_plate", "flat_green_plant", "green_plate", "hair_green", "highlights_green"]
CASES = ["b768_nohint", "b768_hint", "b1024_nohint", "b1024_hint"]


def load_upstream():
    spec = importlib.util.spec_from_file_location("corridorkey", PACK / "corridorkey" / "__init__.py",
                                                  submodule_search_locations=[str(PACK / "corridorkey")])
    mod = importlib.util.module_from_spec(spec)
    sys.modules["corridorkey"] = mod
    spec.loader.exec_module(mod)
    import corridorkey.foundations as foundations
    import corridorkey.runtime as runtime
    import corridorkey.video_io as video_io
    import corridorkey.color_utils as cu
    espec = importlib.util.spec_from_file_location("ck2_pack_env", PACK / "ck_comfy" / "env.py")
    env = importlib.util.module_from_spec(espec)
    sys.modules["ck2_pack_env"] = env
    espec.loader.exec_module(env)
    foundations.build_moge_vitb = env.build_moge_vitb
    foundations._load_local_cradio_so400m = env.load_local_cradio
    return runtime, video_io, cu


def main():
    import torch
    import torch.nn.functional as F
    out_root = Path(sys.argv[1])
    stills = sys.argv[2:] or STILLS
    runtime, video_io, cu = load_upstream()
    dev = "cuda"
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    paths = runtime.RuntimePaths(
        package_root=PACK, weights=MODELS / "corridorkey_v2.safetensors",
        foundation_stats=MODELS / "foundation_stats.safetensors",
        rvm_ckpt=MODELS / "foundations" / "rvm" / "pretrain_rvm_small16_256_204031069.npz",
        moge_checkpoint=MODELS / "foundations" / "moge" / "model.pt",
        cradio_dir=MODELS / "foundations" / "cradio" / "C-RADIOv4-SO400M")
    t0 = time.perf_counter()
    model = runtime.load_model(paths, device=dev)
    model.foundations.cuda().float(); model.stage1.cuda().float(); model.stage2.cuda().float()
    torch.cuda.synchronize()
    env = {"torch": torch.__version__, "gpu": torch.cuda.get_device_name(0), "load_s": round(time.perf_counter() - t0, 2),
           "tf32": False, "autocast": False}
    print("ENV", json.dumps(env), flush=True)
    mean = model.foundations.rvm_mean.view(1, 1, -1, 1, 1).float()
    std = model.foundations.rvm_std.view(1, 1, -1, 1, 1).float().clamp(min=1e-6)
    rows = []
    for still in stills:
        for case in CASES:
            cdir = REF / still / case
            info = json.load(open(cdir / "case.json"))
            od = out_root / still / case
            od.mkdir(parents=True, exist_ok=True)
            tm = {}
            with torch.inference_mode():
                display, linear = video_io._read_frame_dir_views(str(cdir / "in" / "input.png"), exr_linear=False)
                H, W = display.shape[:2]
                assert H % 128 == 0 and W % 128 == 0
                disp = torch.from_numpy(np.ascontiguousarray(display.transpose(2, 0, 1))).float().to(dev)
                code = torch.from_numpy(np.ascontiguousarray(cu.linear_to_asinh(linear).transpose(2, 0, 1))).float().to(dev)
                torch.cuda.synchronize(); a = time.perf_counter()
                rgb_rvm = F.interpolate(disp[None], size=(H // 4, W // 4), mode="bilinear", align_corners=False).clamp(0, 1)
                feats, _ = model.foundations.rvm(rgb_rvm[:, None], state=None)
                rvm = (feats.float() - mean) / std   # (1, 1, D, h, w)
                rgb_radio, rgb_moge = runtime._build_foundation_inputs(disp[None, None])
                ff = model.foundations(rgb_cradio=rgb_radio.reshape(1, 3, *rgb_radio.shape[-2:]),
                                       rgb_moge=rgb_moge.reshape(1, 3, *rgb_moge.shape[-2:]))
                cradio = ff["cradio"].reshape(1, 1, -1, H // 64, W // 64)
                moge = ff["moge"].reshape(1, 1, -1, H // 64, W // 64)
                torch.cuda.synchronize(); b = time.perf_counter(); tm["features_s"] = b - a
                hint = torch.zeros(1, 1, 1, H, W, device=dev)
                hq = torch.full((1, 1), -1.0, device=dev)
                if info["hint"]:
                    h = video_io.read_hint_image(str(cdir / info["hint"]))
                    hint[0, 0, 0] = torch.from_numpy(h).to(dev)
                    hq.fill_(float(info["hint_quality"]))
                s1 = model.stage1(code[None, None], hint, moge, cradio_feat=cradio, rvm_feat=rvm, t_stride=1.0, hint_quality=hq)
                baton = s1["baton"][0]   # (1, 512, h16, w16)
                torch.cuda.synchronize(); c = time.perf_counter(); tm["stage1_s"] = c - b
                lg = model.stage2(code[None, None], baton[None])
                if isinstance(lg, tuple):
                    lg = lg[0]
                torch.cuda.synchronize(); d = time.perf_counter(); tm["stage2_s"] = d - c
                b16 = torch.from_numpy(np.load(cdir / "baton.npy").astype(np.float32)).to(dev)   # I0a's (1, 512, h, w)
                lg2 = model.stage2(code[None, None], b16[None, None])
                if isinstance(lg2, tuple):
                    lg2 = lg2[0]
            arrays = {"feat_cradio": cradio[0, 0], "feat_moge": moge[0, 0], "feat_rvm": rvm[0, 0], "baton": baton[0],
                      "aux": s1["aux"][0, 0], "logits": lg[0, 0], "s2bf16_logits": lg2[0, 0]}
            st = {}
            for k, t in arrays.items():
                x = t.float().cpu().numpy()
                np.save(od / (k + ".npy"), x)
                st[k] = {"shape": list(x.shape), "nan": int(np.isnan(x).sum()), "inf": int(np.isinf(x).sum()),
                         "min": float(np.nanmin(x)), "max": float(np.nanmax(x))}
            row = {"still": still, "case": case, **{k: round(v, 4) for k, v in tm.items()}, "arrays": st,
                   "peak_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2)}
            rows.append(row)
            print("ROW", json.dumps({k: row[k] for k in ("still", "case", "features_s", "stage1_s", "stage2_s", "peak_gb")}), flush=True)
            torch.cuda.empty_cache()
    json.dump({"env": env, "rows": rows}, open(out_root / "run.json", "w"), indent=1)


if __name__ == "__main__":
    main()
