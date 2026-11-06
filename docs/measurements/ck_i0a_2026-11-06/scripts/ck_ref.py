"""I0a's reference keys (docs/PLAN_CORRIDORKEY.md §5 I0a): pack A's vendored upstream `corridorkey` package (not ck_comfy),
run here outside ComfyUI on python_embeded.

    python_embeded\\python.exe -I -B ck_ref.py prep     the case folders: bucket inputs and hints (no GPU)
    python_embeded\\python.exe -I -B ck_ref.py run      the keys (GPU), every array of PLAN §5 I0a (b)

-I: no user site, the script folder not on sys.path (this folder is added by hand for ck_common); -B: no .pyc is written
(the pack's folder stays exactly the checkout). The upstream path is mirrored for a one-frame clip in normal mode:
runtime.precompute_rvm_to_memmap (RVM normalised, stored fp16), hann_stage1_stream (the foundations inline, float32,
stage 1 under bf16 autocast, the baton stored fp16), write_prediction_batches (stage 2 under inference_mode + bf16
autocast), _render_predictions_torch (the decode, in float instead of uint16).
"""
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import time
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import cv2  # noqa: E402
import numpy as np  # noqa: E402

import ck_common  # noqa: E402

PACK = Path(r"F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-CorridorKey2.0")
MODELS = Path(r"F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\models\corridorkey2")
REF = Path(os.environ.get("CK_REF", r"F:\canvas\.claude\worktrees\corridorkey\dist\ck_ref"))
STILLS = json.load(open(os.path.join(HERE, "stills.json"), encoding="utf-8"))["stills"]
BUCKETS = (768, 1024)
HINT_QUALITY = 0.75   # the pack's "rough matte (0.75)" preset; upstream: 0.95 clean, 0.75 rough, <= 0.5 loose


def read_rgb(path):
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def write_rgb(path, rgb):
    path.parent.mkdir(parents=True, exist_ok=True)
    assert cv2.imwrite(str(path), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))


def prep():
    plan = []
    for s in STILLS:
        name, screen = s["name"], s["screen"]
        src = REF / "stills" / (name + ".png")
        rgb = read_rgb(src)
        H, W = rgb.shape[:2]
        sdir = REF / name
        sdir.mkdir(parents=True, exist_ok=True)
        hint_full = ck_common.rough_hint(rgb, screen)
        assert cv2.imwrite(str(sdir / "hint_full.png"), hint_full)
        cases = []
        for bucket in BUCKETS + ("native",):
            for with_hint in (False, True):
                case = ("b%d" % bucket if bucket != "native" else "native") + ("_hint" if with_hint else "_nohint")
                cdir = sdir / case
                if cdir.exists():
                    shutil.rmtree(cdir)
                (cdir / "in").mkdir(parents=True)
                info = {"still": name, "case": case, "screen": screen, "picture": [W, H]}
                if bucket == "native":
                    shutil.copyfile(src, cdir / "in" / "input.png")
                    info.update(box=[0, 0, W, H], scale=1.0, bucket_pad=[0, 0, 0, 0], resample=None)
                    if with_hint:
                        assert cv2.imwrite(str(cdir / "hint.png"), hint_full)
                else:
                    box = ck_common.box_plan(hint_full if with_hint else None, bucket, W, H)
                    img, sc, pad, size = ck_common.fit_bucket(rgb, box, bucket)
                    write_rgb(cdir / "in" / "input.png", img)
                    info.update(box=list(box), scale=sc, bucket_pad=list(pad), resized_to=list(size),
                                resample="cv2.resize INTER_AREA (OpenCV %s), reflect-101 pad at the centre" % cv2.__version__)
                    if with_hint:
                        h, _, _, _ = ck_common.fit_bucket(hint_full, box, bucket)
                        assert cv2.imwrite(str(cdir / "hint.png"), h)
                info["hint"] = "hint.png" if with_hint else None
                info["hint_quality"] = HINT_QUALITY if with_hint else -1.0
                json.dump(info, open(cdir / "case.json", "w"), indent=1)
                cases.append(info)
        plan.append({"still": name, "cases": cases})
    json.dump(plan, open(REF / "plan.json", "w"), indent=1)
    print(json.dumps(plan, indent=1))


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
    # pack A's loaders for MoGe (a private package name, the utils3d shim) and C-RADIO (built eagerly, safetensors
    # loaded by hand; works on transformers 5): ck_comfy/env.py by file, it imports only torch and the standard library
    espec = importlib.util.spec_from_file_location("ck2_pack_env", PACK / "ck_comfy" / "env.py")
    env = importlib.util.module_from_spec(espec)
    sys.modules["ck2_pack_env"] = env
    espec.loader.exec_module(env)
    foundations.build_moge_vitb = env.build_moge_vitb
    foundations._load_local_cradio_so400m = env.load_local_cradio
    return runtime, video_io, cu


def f16(t):
    a = t.detach().float().cpu().numpy()
    b = a.astype(np.float16)
    return b, {"shape": list(b.shape), "min": float(np.nanmin(a)), "max": float(np.nanmax(a)),
               "nan": int(np.isnan(a).sum()), "inf": int(np.isinf(a).sum()), "f16_inf": int(np.isinf(b).sum() - np.isinf(a).sum())}


def run():
    import torch
    import torch.nn.functional as F
    runtime, video_io, cu = load_upstream()
    dev = "cuda"
    paths = runtime.RuntimePaths(
        package_root=PACK,
        weights=MODELS / "corridorkey_v2.safetensors",
        foundation_stats=MODELS / "foundation_stats.safetensors",
        rvm_ckpt=MODELS / "foundations" / "rvm" / "pretrain_rvm_small16_256_204031069.npz",
        moge_checkpoint=MODELS / "foundations" / "moge" / "model.pt",
        cradio_dir=MODELS / "foundations" / "cradio" / "C-RADIOv4-SO400M",
    )
    t0 = time.perf_counter()
    model = runtime.load_model(paths, device=dev)
    model.foundations.cuda(); model.stage1.cuda(); model.stage2.cuda()
    torch.cuda.synchronize()
    load_s = time.perf_counter() - t0
    env_info = {"torch": torch.__version__, "cuda": torch.version.cuda, "cv2": cv2.__version__, "numpy": np.__version__,
                "gpu": torch.cuda.get_device_name(0), "load_s": round(load_s, 2),
                "weights_allocated_gb": round(torch.cuda.memory_allocated() / 2**30, 2), "python": sys.version.split()[0]}
    print("ENV", json.dumps(env_info), flush=True)
    mean = model.foundations.rvm_mean.view(1, 1, -1, 1, 1).float().cpu()
    std = model.foundations.rvm_std.view(1, 1, -1, 1, 1).float().cpu().clamp(min=1e-6)
    rows = []
    only = set(sys.argv[2:])
    for s in STILLS:
        if only and s["name"] not in only:
            continue
        for cdir in sorted((REF / s["name"]).iterdir()):
            if not (cdir / "case.json").is_file():
                continue
            info = json.load(open(cdir / "case.json"))
            for old in cdir.glob("*.npy"):
                old.unlink()
            torch.cuda.reset_peak_memory_stats()
            tm = {}
            with torch.no_grad():
                meta = video_io.probe_frame_dir_meta(str(cdir / "in"), num_frames=-1, shape_quantum=128, fps=24.0,
                                                     exr_linear=False, model_scale=1.0)
                model_t, display_t, _ = video_io.preprocess_frame_dir_path(meta["frame_paths"][0], meta, need_model=True)
                H, W = meta["shape_hw"]
                torch.cuda.synchronize(); a = time.perf_counter()
                # RVM: precompute_rvm_to_memmap for one frame (zero state), stored fp16 as upstream's memmap
                rgb = display_t.unsqueeze(0).unsqueeze(0).to(dev).float()
                rgb_rvm = F.interpolate(rgb.reshape(1, 3, H, W), size=(H // 4, W // 4), mode="bilinear",
                                        align_corners=False).reshape(1, 1, 3, H // 4, W // 4).clamp(0.0, 1.0)
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    feats, _state = model.foundations.rvm(rgb_rvm, state=None)
                rvm16 = ((feats.float().cpu() - mean) / std)[0].numpy().astype(np.float16)   # (1, D, H/64, W/64)
                torch.cuda.synchronize(); b = time.perf_counter(); tm["rvm_s"] = b - a
                # C-RADIO + MoGe inline (hann_stage1_stream with foundation_paths None): float32 out of the wrapper
                rgb_found = display_t.unsqueeze(0).unsqueeze(0).to(dev)
                rgb_radio, rgb_moge = runtime._build_foundation_inputs(rgb_found)
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    ff = model.foundations(rgb_cradio=rgb_radio.reshape(1, 3, *rgb_radio.shape[-2:]),
                                           rgb_moge=rgb_moge.reshape(1, 3, *rgb_moge.shape[-2:]))
                cradio_feat = ff["cradio"].reshape(1, 1, -1, H // 64, W // 64)
                moge_feat = ff["moge"].reshape(1, 1, -1, H // 64, W // 64)
                rvm_feat = torch.from_numpy(rvm16).unsqueeze(0).to(dev).float()
                torch.cuda.synchronize(); c = time.perf_counter(); tm["foundations_s"] = c - b
                # the hint and its quality as hann_stage1_stream builds them for frame 0
                hint_cpu = torch.zeros(1, 1, 1, H, W, dtype=torch.bfloat16)
                hq_cpu = torch.zeros(1, 1, dtype=torch.bfloat16)
                if info["hint"]:
                    hint_cpu[0, 0] = video_io.load_initial_hint_frame(str(cdir / info["hint"]), meta).to(dtype=hint_cpu.dtype)
                    hq_cpu[0, 0] = float(info["hint_quality"])
                else:
                    hq_cpu.fill_(-1.0)
                rgb_c = model_t.unsqueeze(0).unsqueeze(0).to(dev)
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    s1 = model.stage1(rgb_c, hint_cpu.to(dev), moge_feat, cradio_feat=cradio_feat, rvm_feat=rvm_feat,
                                      t_stride=1.0, hint_quality=hq_cpu.to(dev))
                baton16 = s1["baton"][0].float().cpu().numpy().astype(np.float16)   # (1, d_16, H/16, W/16)
                aux = s1["aux"][0]
                torch.cuda.synchronize(); d = time.perf_counter(); tm["stage1_s"] = d - c
            # stage 2: write_prediction_batches, one frame
            baton_t = torch.from_numpy(baton16).unsqueeze(0).to(dev).float()
            with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                logits = model.stage2(model_t.unsqueeze(0).unsqueeze(0).to(dev), baton_t)
                if isinstance(logits, tuple):
                    logits = logits[0]
            lg = logits[0]   # (1, 4, H, W)
            torch.cuda.synchronize(); e = time.perf_counter(); tm["stage2_s"] = e - d
            logits_dtype = str(lg.dtype)
            # the decode (_render_predictions_torch, in float)
            with torch.no_grad():
                lgf = lg.float()
                h0, w0 = meta["model_native_hw"]
                pl, _, pt, _ = meta["pad"]
                alpha = lgf[:, 0:1, pt:pt + h0, pl:pl + w0].clamp(0.0, 1.0)
                fg_lin = cu.asinh_to_linear(lgf[:, 1:4, pt:pt + h0, pl:pl + w0])
                fg_srgb = cu.linear_to_srgb(fg_lin.clamp(min=0.0)).clamp(0.0, 1.0)
            torch.cuda.synchronize(); tm["decode_s"] = time.perf_counter() - e
            arrays = {}
            arrays["feat_cradio"] = f16(cradio_feat[0, 0])
            arrays["feat_moge"] = f16(moge_feat[0, 0])
            arrays["feat_rvm"] = (rvm16[0], f16(torch.from_numpy(rvm16[0].astype(np.float32)))[1])
            arrays["baton"] = (baton16[0], f16(torch.from_numpy(baton16[0].astype(np.float32)))[1])
            arrays["aux"] = f16(aux[0])
            arrays["logits"] = f16(lg[0])
            arrays["alpha"] = f16(alpha[0, 0])
            arrays["fg_linear"] = f16(fg_lin[0].permute(1, 2, 0))
            stats = {}
            for k, (arr, st) in arrays.items():
                np.save(cdir / (k + ".npy"), arr)
                stats[k] = st
            a8 = np.round(alpha[0, 0].cpu().numpy() * 255.0).astype(np.uint8)
            f8 = np.round(fg_srgb[0].permute(1, 2, 0).cpu().numpy() * 255.0).astype(np.uint8)
            assert cv2.imwrite(str(cdir / "alpha.png"), a8)
            assert cv2.imwrite(str(cdir / "fg.png"), cv2.cvtColor(f8, cv2.COLOR_RGB2BGR))
            info.update(meta={k: v for k, v in meta.items() if k != "frame_paths"}, logits_dtype=logits_dtype,
                        feature_dtypes={"cradio": str(ff["cradio"].dtype), "moge": str(ff["moge"].dtype),
                                        "rvm": "float16 (upstream's memmap)", "baton": "float16 (upstream's memmap)"},
                        seconds={k: round(v, 4) for k, v in tm.items()},
                        peak_allocated_gb=round(torch.cuda.max_memory_allocated() / 2**30, 2), arrays=stats,
                        layout="feat_*, baton, aux, logits: CHW (frame and batch dims dropped) at the padded model size; "
                               "alpha HW and fg_linear HWC (RGB, scene-linear, straight, unclamped) cropped to the input; "
                               "alpha.png and fg.png 8-bit (round(x*255)), fg sRGB-encoded from linear clamped at 0, no despill",
                        env=env_info)
            json.dump(info, open(cdir / "case.json", "w"), indent=1)
            row = {"still": s["name"], "case": cdir.name, "shape": [H, W], **{k: round(v, 3) for k, v in tm.items()},
                   "peak_gb": info["peak_allocated_gb"], "nan_inf": sum(st["nan"] + st["inf"] for st in stats.values()),
                   "f16_overflow": sum(st["f16_inf"] for st in stats.values()),
                   "alpha_mean": round(float(alpha.mean()), 4)}
            rows.append(row)
            print("ROW", json.dumps(row), flush=True)
            del feats, ff, cradio_feat, moge_feat, rvm_feat, s1, aux, logits, lg, lgf, alpha, fg_lin, fg_srgb, baton_t
            torch.cuda.empty_cache()
    json.dump({"env": env_info, "rows": rows}, open(REF / "run.json", "w"), indent=1)


def manifest(out):
    lines = []
    for p in sorted(REF.rglob("*")):
        if p.is_file():
            lines.append("%s  %12d  %s" % (hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_size,
                                            p.relative_to(REF).as_posix()))
    open(out, "w", newline=chr(10)).write("\n".join(lines) + "\n")
    print(len(lines), "files")


if __name__ == "__main__":
    if sys.argv[1] == "prep":
        prep()
    elif sys.argv[1] == "run":
        run()
    elif sys.argv[1] == "manifest":
        manifest(sys.argv[2])
