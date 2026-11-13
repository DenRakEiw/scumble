"""SP0 step 2: export Marigold-IID-Lighting v1.1 as three ONNX graphs (fp16 inside, float32 in and out: onnxruntime-node
1.29 under Node 24 cannot take a Float16Array input):
  vae_encoder.onnx  image [1,3,H,W] in [-1,1]      -> latent [1,4,H/8,W/8] (mode * scaling_factor)
  unet.onnx         sample [1,16,h,w], timestep [1] -> v [1,12,h,w]   (the empty-prompt embedding baked in)
  vae_decoder.onnx  latent [B,4,h,w] (scaled)       -> image [B,3,H,W] in [0,1] (clip, (x+1)/2)
plus scheduler.json (the one-step timestep and the DDIM coefficients) and empty_embedding.npy."""
import json, os
import numpy as np, torch
from diffusers import MarigoldIntrinsicsPipeline

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "marigold-iid-lighting-v1-1")
OUT = os.path.join(HERE, "onnx")
os.makedirs(OUT, exist_ok=True)
pipe = MarigoldIntrinsicsPipeline.from_pretrained(MODEL, variant="fp16", torch_dtype=torch.float16).to("cuda")
vae, unet = pipe.vae, pipe.unet
sf = vae.config.scaling_factor

with torch.no_grad():
    ids = pipe.tokenizer("", padding="do_not_pad", max_length=pipe.tokenizer.model_max_length, truncation=True, return_tensors="pt").input_ids.to("cuda")
    emb = pipe.text_encoder(ids)[0].to(torch.float16)  # [1,2,1024]
np.save(os.path.join(OUT, "empty_embedding.npy"), emb.float().cpu().numpy())


class Enc(torch.nn.Module):
    def __init__(s): super().__init__(); s.vae = vae
    def forward(s, image):
        h = s.vae.quant_conv(s.vae.encoder(image.half()))
        mean = h[:, :4]
        return (mean * sf).float()


class Dec(torch.nn.Module):
    def __init__(s): super().__init__(); s.vae = vae
    def forward(s, latent):
        x = s.vae.decoder(s.vae.post_quant_conv(latent.half() / sf))
        return ((torch.clamp(x, -1.0, 1.0) + 1.0) / 2.0).float()


class Un(torch.nn.Module):
    def __init__(s): super().__init__(); s.unet = unet; s.register_buffer("emb", emb)
    def forward(s, sample, timestep):
        return s.unet(sample.half(), timestep, encoder_hidden_states=s.emb, return_dict=False)[0].float()


H, W = 768, 576
img = torch.randn(1, 3, H, W, device="cuda")
lat = torch.randn(1, 4, H // 8, W // 8, device="cuda")
smp = torch.randn(1, 16, H // 8, W // 8, device="cuda")
ts = torch.tensor([999], device="cuda", dtype=torch.int64)
kw = dict(opset_version=17, do_constant_folding=True, dynamo=False)
with torch.no_grad():
    torch.onnx.export(Enc().eval(), (img,), os.path.join(OUT, "vae_encoder.onnx"), input_names=["image"], output_names=["latent"],
                      dynamic_axes={"image": {2: "H", 3: "W"}, "latent": {2: "h", 3: "w"}}, **kw)
    print("encoder ok", flush=True)
    torch.onnx.export(Dec().eval(), (lat,), os.path.join(OUT, "vae_decoder.onnx"), input_names=["latent"], output_names=["image"],
                      dynamic_axes={"latent": {0: "B", 2: "h", 3: "w"}, "image": {0: "B", 2: "H", 3: "W"}}, **kw)
    print("decoder ok", flush=True)
    torch.onnx.export(Un().eval(), (smp, ts), os.path.join(OUT, "unet.onnx"), input_names=["sample", "timestep"], output_names=["v"],
                      dynamic_axes={"sample": {2: "h", 3: "w"}, "v": {2: "h", 3: "w"}}, **kw)
    print("unet ok", flush=True)

sch = pipe.scheduler
sch.set_timesteps(1)
t = int(sch.timesteps[0])
ac = sch.alphas_cumprod
prev = t - sch.config.num_train_timesteps // 1
a_t = float(ac[t]); a_prev = float(ac[prev]) if prev >= 0 else float(sch.final_alpha_cumprod)
json.dump({"timestep": t, "alpha_t": a_t, "alpha_prev": a_prev, "prediction_type": sch.config.prediction_type,
           "scaling_factor": sf}, open(os.path.join(OUT, "scheduler.json"), "w"), indent=1)
print("scheduler", t, a_t, a_prev)
for f in os.listdir(OUT):
    print(f, os.path.getsize(os.path.join(OUT, f)))
