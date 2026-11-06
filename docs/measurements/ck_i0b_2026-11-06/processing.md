# CK2 spike (I0b): the pre- and post-processing of Nucito's five graphs

`Nucito/corridorkey-web@1ae72ca7270b4fb2f64e98b5c3cc6e6ee4103957`, read 2026-11-06. The harness carries the same table
in `tools/ck_spike/ckio.js` (header) and does exactly this (`prepare`, `key_process.js`).

## Where it comes from

- **Nucito's README** (1,083 bytes) names the files, the components and the format only: `manifest.json`,
  `<component>.weights` (fp16, shared by all graphs of a component), `<component>_<H>x<W>[_t<T>].onnx` (static
  shapes, external data). Nothing about inputs, ranges or colour.
- **Nucito's JS loader is not public.** The README says the set is "used by the CorridorKey Web app"; no such app or
  loader is on Hugging Face (Nucito has one model repo and no Space), on GitHub (Nucito's seven repos, a code search for
  `corridorkey-web-1`, `stage1_1024x1024_t1`, `cradio.weights`) or on the web (searched 2026-11-06).
  `CorridorKeyWeb/CorridorKeyWeb.github.io@4034893` is a v1 page (GreenFormer, safetensors in the browser), not this
  set's loader.
- So the table is read **from the graphs themselves** (`tools/ck_spike` reads each `.onnx` with a small protobuf reader:
  the inputs and outputs with dtype and shape, the opset, the external data, and the nodes that read a graph input or
  write an output; `inspect/` beside this file) and **checked against upstream's code** (`CorridorKey2.0@485f5e9`, as
  vendored by pack A at `c7662de`, which I0a's reference runs): `runtime.py` `_build_foundation_inputs` :283-292,
  `precompute_rvm_to_memmap` :303-344; `video_io.py` `_read_frame_dir_views` :247-255, `preprocess_frame_dir_path`
  :323-338, `read_hint_image` :144-156, `load_initial_hint_frame` :479-499; `color_utils.py` :1-138;
  `foundations.py` `forward` :218-290; `rvm.py` :363-386.
- Every graph: ONNX IR 8, opset 17, default domain only, exported by PyTorch 2.9.1, every initializer float16 in the
  component's `.weights`, no `value_info`; every graph input and output float32, cast to fp16 by the graph's first node
  and back by its last.

## The table (H x W = the bucket, a multiple of 128; h x w = H/64 x W/64)

| graph | inputs (float32) | made outside the graph | inside the graph (read from its nodes) | outputs (float32) |
|---|---|---|---|---|
| `cradio_HxW` | `x` [1,3,H/4,W/4] | display RGB = PNG bytes / 255 (alpha dropped, as `cv2.IMREAD_COLOR`), **area** resize to H/4 x W/4 (`F.interpolate(mode="area")` = adaptive average pooling; here a 4 x 4 box mean), NCHW | RADIO's input conditioner (`/m/input_conditioner/Sub`), the ViT, then `(feat - mean) / std` (CK2's `foundation_stats`, `Sub mean`, `Div std` before the output cast) | `feat` [1,1152,h,w] |
| `moge_HxW` | `x` [1,3,7H/32,7W/32] | display RGB, **area** resize to floor(7H/32) x floor(7W/32) (adaptive average pooling with bins [floor(i·in/out), ceil((i+1)·in/out)), a non-integer factor) | the ImageNet normalisation (`Sub` on the cast input), the DINOv2 encoder, the output projections, `(feat - mean) / std` | `feat` [1,768,h,w] |
| `rvm_HxW` | `frame` [1,3,H/4,W/4], `state` [1,1+h·w,384] | display RGB, **bilinear** resize to H/4 x W/4 (align_corners false, no antialias), clamped to [0,1] (no mean / std: RVM wants [0,1]); `state` all zeros (upstream's `state is None` makes `new_zeros`, rvm.py:376) | the ViT-S encoder, the gated recurrent core, `(feat - mean) / std` | `feat` [1,384,h,w], `new_state` (unused on a still) |
| `stage1_HxW_t1` | `rgb` [1,1,3,H,W], `hint` [1,1,1,H,W], `hint_quality` [1,1], `moge` / `cradio` / `rvm` [1,1,C,h,w] | `rgb` = the **model code**: linear = sRGB-to-linear(display) (IEC piecewise), code = asinh(linear / 0.008) / asinh(16 / 0.008); `hint` = grey PNG / 255, white = subject (a 3-channel hint: channel 0 of BGR; 4 channels: alpha), or zeros; `hint_quality` 0.95 clean, 0.75 rough, <= 0.5 loose, **-1 with the zero hint** (the model decides the subject); the three features exactly as the graphs above give them (the normalisation is inside those) | the clip of `hint_quality` (`/s1/Clip`), the 4-channel patchify, the whole of stage 1; `t_stride` is baked in | `baton` [1,1,512,H/16,W/16], `aux` [1,1,4,H/2,W/2] (dynamic dim names, static values) |
| `stage2_HxW` | `rgb` [1,3,H,W], `baton` [1,512,H/16,W/16] | the same model code (4-D here), stage 1's baton (its T dim dropped) | stage 2, the depatchify (ConvTranspose 32 x 32), the channel gather | `logits` [1,4,H,W]: ch 0 alpha (raw; clamp to [0,1]), ch 1-3 the fg in the asinh code |

**Decode** (not in the parity rows, which stay logits to logits): alpha = clamp(ch0, 0, 1); fg_linear = sinh(code ·
asinh(2000)) · 0.008, straight (unpremultiplied) scene-linear, unclamped (`color_utils.asinh_to_linear`).

**Padding:** the buckets are multiples of 128, so upstream's reflect-101 pad to a multiple of 128 (`runtime.py:105`,
`video_io.center_pad_to_shape`) is the identity on I0a's bucket inputs; a box that is not a bucket is fitted and padded
by the caller (§4.7 of the plan), never by these graphs.

## Where the spike differs from the reference on purpose

- Upstream rounds the display RGB and the model code to **bf16** before the graphs (`preprocess_frame_dir_path`
  :331-337, `.to(dtype=torch.bfloat16)`) and the hint to bf16 (`load_initial_hint_frame` :499), and runs every graph
  under bf16 autocast. The spike feeds float32 (what the app would) and the graphs compute in fp16.
  `--bf16-inputs` rounds the inputs to bf16 first (the code from the float32 display, then rounded, as upstream): it
  moved stage 2's isolated alpha MAE on hair_green 768 from 3.86e-3 to 3.75e-3, so **the difference to the reference is
  the graphs' fp16 arithmetic, not the input rounding** (`parity_webgpu_129_1024_bf16in` in `parity_summary.txt`).
- The C-RADIO and MoGe features of I0a's reference are fp16 roundings of float32; its RVM features and baton are what
  upstream feeds (its fp16 memmaps). The isolated rows (stage 1 on I0a's features, stage 2 on I0a's baton) feed those.

## How the table was checked

- The JS pre-processing (`ckio.js`) against numpy / OpenCV on hair_green b768 (`scripts/check_io.js` in the scratchpad,
  the numbers in `summary.txt`): the PNG bytes equal cv2's (byte sum 105,831,300); the C-RADIO input's sum (4 x 4 box
  mean) 25,939.0450 vs 25,939.0453; MoGe's adaptive pooling to 168 x 168 19,859.9438 vs 19,859.9446 (a numpy
  adaptive-pool); RVM's bilinear 25,943.9165 vs cv2 INTER_LINEAR 25,943.9166; the model code 437,969.2999 vs
  437,969.2992 (float64 numpy); the hint 476,189.3256 vs 476,189.3255.
- The feature graphs' parity (`parity_summary.txt`): on WebGPU every feature map's cosine to the fp32 run is >= 0.9928
  (MoGe at 768) and its relative MAE <= 6.6 %, the same distance as I0a's bf16 reference from that fp32 run (cosine
  >= 0.9937, relative MAE <= 6.7 %); on DirectML the same graphs sit at cosine >= 0.9995 and relative MAE <= 1.4 % from
  fp32. A wrong resize, range or normalisation would not land there.
