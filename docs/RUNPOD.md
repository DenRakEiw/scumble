# RunPod: ComfyUI as a remote backend for the app

Goal: a Docker template that starts ComfyUI with the Inpaint Canvas node pack and the
models a recipe needs, reachable from the desktop app over HTTPS with an auth token.

## What the app needs from the box

- ComfyUI's HTTP API and websocket (`/prompt`, `/upload/image`, `/view`, `/ws`,
  `/object_info`, `/queue`, `/history`, `/free`) on one port.
- The node pack `ComfyUI-InpaintCanvas` installed (its routes `/inpaint_canvas/*` are
  only needed for the browser bridge, the app talks to the node through the graph).
- Helper packs only if SAM3/RMBG should run remotely: `comfyui-rmbg`,
  `ComfyUI-QwenVL`. With in-app ONNX helpers (phase 3) the box needs none of them.
- Models for the recipes, e.g. Flux.2 Klein: `flux-2-klein-base-9b-fp8`,
  `qwen_3_8b_fp8mixed`, the Flux.2 VAE (see the note node in
  `examples/inpaint_canvas_flux2_klein_local.json`).

## Template shape (to build in phase 2)

- Base: RunPod's `runpod/pytorch` CUDA image or `ghcr.io/ai-dock/comfyui`; the latter
  already handles ComfyUI, Manager, a `PROVISIONING_SCRIPT` for node packs and model
  downloads, and puts a reverse proxy with basic auth in front.
- Provisioning script: clone the node repo into `custom_nodes`, download models into
  `/workspace/ComfyUI/models/...` from Hugging Face (token as env), optional helper packs.
- Ports: 8188 (ComfyUI) behind RunPod's HTTPS proxy `https://<pod-id>-8188.proxy.runpod.net`.
  Auth: either the proxy's basic auth or a simple token check; the app sends it as a
  header on every request and on the websocket handshake.
- Persistent volume for models so a restarted pod does not re-download 20 GB.

## App side

- Connection dialog: URL, optional user/password or token, "test" button that calls
  `/object_info` and reports the ComfyUI version, whether `InpaintCanvas` exists, and
  which recipe models are present (`/models/...` listing or `/object_info` combo values).
- Uploads and downloads go through the same URL; large base images (16 MP PNG ≈ 30–60
  MB) over a remote link take seconds, so the app should send the crop plus context
  only, not the flattened base, when the recipe allows it. The node already supports
  running from the uploaded crop; check `nodes.py` `InpaintCanvas` inputs.
- Latency: the websocket keeps the connection; results are fetched with `/view`.

## Where it stands (2026-09-08)

- App side: done. Settings › ComfyUI has URL, auth (none / basic / bearer / custom
  header; the secret goes into the credential store via `electron/main/keys.js`),
  Test (`ComfyClient.probe`: version, devices, queue, node pack version, and for every
  ComfyUI recipe whether its model files are in the server's loader lists) and
  Connect. Every proxied request and the websocket handshake carry the auth headers
  (`electron/main/comfy.js`).
- Template: `docker/runpod/Dockerfile`, `provision.sh`, `README.md` written on top of
  ai-dock's image, **not yet run on a real pod**. First test: build, push, create the
  template with the fields in that README, start a pod, Test + Connect from the app,
  run the Flux.2 Klein recipe. Then publish the template under the app's name.
