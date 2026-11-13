"""SP0 step 3a: reference tensors for the ORT parity check. Per picture: the preprocessed image (f32 raw, [1,3,PPH,PPW]),
the noise ([1,12,h,w]) and torch's prediction ([3,3,PPH,PPW], linear 0..1) through the pipeline with that noise,
plus the same through the hand-written one-step formula the app will use (to prove the formula)."""
import json, os
import numpy as np, torch
from PIL import Image
from diffusers import MarigoldIntrinsicsPipeline

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "marigold-iid-lighting-v1-1")
OUT = os.path.join(HERE, "ref"); os.makedirs(OUT, exist_ok=True)
PICS = json.load(open(os.path.join(HERE, "pics.json")))
pipe = MarigoldIntrinsicsPipeline.from_pretrained(MODEL, variant="fp16", torch_dtype=torch.float16).to("cuda")
pipe.set_progress_bar_config(disable=True)
sch = json.load(open(os.path.join(HERE, "onnx", "scheduler.json")))
meta = {}
for name in ("portrait", "cafe_car", "house"):
    img = Image.open(PICS[name]).convert("RGB")
    x, padding, orig = pipe.image_processor.preprocess(img, 768, "bilinear", "cuda", torch.float16)
    # pad on to a multiple of 64 (latent sides a multiple of 8: the UNet's skip concats need even sides at every level)
    _, _, ph8, pw8 = x.shape
    e_h, e_w = (-ph8) % 64, (-pw8) % 64
    x = torch.nn.functional.pad(x, (0, e_w, 0, e_h), mode="replicate")
    padding = (padding[0] + e_h, padding[1] + e_w)
    _, _, PH, PW = x.shape
    g = torch.Generator("cuda").manual_seed(0)
    noise = torch.randn((1, 12, PH // 8, PW // 8), generator=g, device="cuda", dtype=torch.float16)
    with torch.no_grad():
        ref_pipe = None
        # the formula: x0 = sqrt(a_t) x - sqrt(1-a_t) v ; eps = sqrt(a_t) v + sqrt(1-a_t) x ; prev = sqrt(a_p) x0 + sqrt(1-a_p) eps
        il = pipe.vae.encode(x).latent_dist.mode() * pipe.vae.config.scaling_factor
        v = pipe.unet(torch.cat([il, noise], 1), torch.tensor([sch["timestep"]], device="cuda"), encoder_hidden_states=torch.from_numpy(np.load(os.path.join(HERE, "onnx", "empty_embedding.npy"))).to("cuda", torch.float16), return_dict=False)[0]
        at, ap = sch["alpha_t"], sch["alpha_prev"]
        x0 = at ** 0.5 * noise - (1 - at) ** 0.5 * v
        eps = at ** 0.5 * v + (1 - at) ** 0.5 * noise
        prev = ap ** 0.5 * x0 + (1 - ap) ** 0.5 * eps
        dec = pipe.vae.decode(prev.reshape(3, 4, PH // 8, PW // 8) / pipe.vae.config.scaling_factor, return_dict=False)[0]
        mine = ((dec.clamp(-1, 1) + 1) / 2).float()
    ph, pw = padding
    mine_u = mine[:, :, :PH - ph, :PW - pw]
    print(name, "padded", (PW, PH), "unpadded", tuple(mine_u.shape))
    x.float().cpu().numpy().tofile(os.path.join(OUT, name + "_image.f32"))
    noise.float().cpu().numpy().tofile(os.path.join(OUT, name + "_noise.f32"))
    mine.cpu().numpy().tofile(os.path.join(OUT, name + "_pred.f32"))
    meta[name] = {"PH": PH, "PW": PW, "pad": [ph, pw], "orig": list(orig)}
json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
