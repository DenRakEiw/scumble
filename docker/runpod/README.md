# Scumble ComfyUI template for RunPod

A ComfyUI box with the Inpaint Canvas node pack and the models of the shipped
recipes, reachable from the desktop app over RunPod's HTTPS proxy with basic auth.
Built on [ai-dock/comfyui](https://github.com/ai-dock/comfyui).

**Status (2026-09-08): written, not yet run on a real pod.** The steps below are the
plan for the first test; expect small fixes to `provision.sh` afterwards.

## Build and push

```
docker build -t <dockerhub-user>/scumble-comfyui:latest docker/runpod
docker push <dockerhub-user>/scumble-comfyui:latest
```

## RunPod template

- Container image: `<dockerhub-user>/scumble-comfyui:latest`
- Volume: `/workspace`, 60 GB or more (Flux.2 Klein 9B fp8 + text encoder + VAE ≈ 25 GB)
- Exposed HTTP ports: `8188`
- Environment:
  - `WEB_USER` / `WEB_PASSWORD`: the proxy's basic auth (ai-dock), what the app sends
  - `HF_TOKEN`: Hugging Face token (the Flux.2 Klein repository is gated)
  - `SCUMBLE_RECIPES`: `flux2_klein_9b` (default) or `none`
  - `SCUMBLE_HELPERS`: `1` to install the RMBG / Qwen-VL helper packs (select by text
    with SAM3 needs the ComfyUI SAM3 nodes too; in-app ONNX helpers are phase 3)

## In the app

Settings (Ctrl+,) › ComfyUI:

- Server URL: `https://<pod-id>-8188.proxy.runpod.net`
- Auth: basic, user `WEB_USER`, password `WEB_PASSWORD`
- Test: reports the ComfyUI version, the node pack and whether the recipe's model
  files are on the box; Connect stores the settings (the password in the credential
  store) and opens the websocket.

The app keeps every image locally and uploads only what a run needs, so a pod that
was stopped and started again just needs Connect; the next run re-uploads the base
and mask of the document it works on (a 16 MP PNG is 30–60 MB, count a few seconds).
