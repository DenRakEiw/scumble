# ComfyUI with the Inpaint Canvas node pack for RunPod, as the remote backend of Scumble.
#
# Base: ai-dock's ComfyUI image (ComfyUI, ComfyUI Manager, a Caddy reverse proxy with
# basic auth in front of every port, a provisioning hook for node packs and models).
# Everything model-related is downloaded by provision.sh at first start into the
# persistent /workspace volume, so the image stays small and a restarted pod does not
# fetch 20 GB again.
#
# Build:   docker build -t <you>/scumble-comfyui:latest docker/runpod
# Run:     see README.md next to this file (RunPod template fields).
#
# Not verified on a real pod yet (2026-09-08): the image builds, the provisioning
# script follows ai-dock's contract, but the first run on RunPod is still to do.
FROM ghcr.io/ai-dock/comfyui:latest

# The provisioning script runs once per new /workspace (ai-dock contract: PROVISIONING_SCRIPT
# may be a URL or a path; we bake it in and point the env at it).
COPY provision.sh /opt/scumble/provision.sh
RUN chmod +x /opt/scumble/provision.sh

ENV PROVISIONING_SCRIPT=/opt/scumble/provision.sh \
    # ComfyUI listens on 8188 behind the proxy; the proxy's basic auth is WEB_USER / WEB_PASSWORD
    COMFYUI_PORT_HOST=8188 \
    COMFYUI_ARGS="--listen --preview-method auto" \
    # keep the web UI's auto-launch off, the app talks to the API
    AUTO_UPDATE=false

EXPOSE 8188
