#!/bin/bash
# Provisioning for the Scumble ComfyUI template (ai-dock contract: runs once at first
# start with /workspace mounted, ComfyUI at ${COMFYUI_DIR:-/workspace/ComfyUI}).
#
# Installs the Inpaint Canvas node pack and, optionally, the helper packs and the model
# files of the shipped recipes. Everything is driven by environment variables so one
# template serves several recipes:
#
#   SCUMBLE_RECIPES   space separated list of recipe model sets to download
#                     (flux2_klein_9b | none), default flux2_klein_9b
#   SCUMBLE_HELPERS   "1" installs the helper packs for select-by-text / RMBG / Qwen-VL
#                     (comfyui-rmbg, ComfyUI-QwenVL) so those work remotely too; default 0
#   HF_TOKEN          Hugging Face token for gated downloads (Flux.2 Klein needs it); sent by curl, which drops it
#                     on a redirect to another host (Hugging Face's CDN), never by wget (which sends it on)
#   SCUMBLE_NODE_REF  the Inpaint Canvas commit to check out: the full 40-character commit id (or a branch or tag;
#                     a short id fails the shallow fetch), default the one pinned below
#
# Every node pack is checked out at a pinned commit (H1 S8): a fresh pod gets the code this file was written for, never
# whatever a repository's head holds that day, and a restart does not pull. To move a pack, change its commit here
# (`git ls-remote <url> HEAD` gives the head) or, for Inpaint Canvas, set SCUMBLE_NODE_REF.
#
# Model files land in ${COMFYUI_DIR}/models/... on the persistent volume; existing
# files are never re-downloaded.
set -euo pipefail

COMFYUI_DIR="${COMFYUI_DIR:-/workspace/ComfyUI}"
NODES_DIR="${COMFYUI_DIR}/custom_nodes"
MODELS_DIR="${COMFYUI_DIR}/models"
RECIPES="${SCUMBLE_RECIPES:-flux2_klein_9b}"
HELPERS="${SCUMBLE_HELPERS:-0}"

log() { printf '[scumble provision] %s\n' "$*"; }

# the commits the packs are checked out at (read with git ls-remote on 2026-11-07)
INPAINT_CANVAS_REF="${SCUMBLE_NODE_REF:-1b993724da1b6f383676446d6c21fa60e7376863}"
RMBG_REF="a66a5e641a54988d80ed6aad18946081c85f309e"
QWENVL_REF="1b67b443918801f571714bab636edc1845b7002a"

clone_at() {
    local url="$1" dir="$2" ref="$3"
    if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$ref" ]; then
        log "have $(basename "$dir") at ${ref:0:12}"
    else
        log "fetching $url at ${ref:0:12}"
        [ -d "$dir/.git" ] || git init -q "$dir"
        git -C "$dir" remote remove origin 2>/dev/null || true
        git -C "$dir" remote add origin "$url"
        git -C "$dir" fetch -q --depth 1 origin "$ref"
        git -C "$dir" checkout -q --force --detach FETCH_HEAD
    fi
    if [ -f "$dir/requirements.txt" ]; then
        # ai-dock keeps ComfyUI's Python in a venv; use whatever `python` resolves to inside it
        python -m pip install --no-cache-dir -r "$dir/requirements.txt" || log "requirements of $(basename "$dir") failed (continuing)"
    fi
}

download() {
    local url="$1" target="$2"
    if [ -f "$target" ]; then log "have $(basename "$target")"; return; fi
    mkdir -p "$(dirname "$target")"
    log "downloading $(basename "$target")"
    local auth=()
    if [ -n "${HF_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer ${HF_TOKEN}"); fi
    # curl sends a header given with -H only to the URL's own host: the redirect to the CDN goes without the token
    curl -fL --retry 3 --progress-bar "${auth[@]}" -o "$target.part" "$url"
    mv "$target.part" "$target"
}

mkdir -p "$NODES_DIR" "$MODELS_DIR"

# --- the node pack the app needs ---------------------------------------------------------
clone_at https://github.com/DenRakEiw/ComfyUI-InpaintCanvas "$NODES_DIR/ComfyUI-InpaintCanvas" "$INPAINT_CANVAS_REF"

# --- optional helper packs ---------------------------------------------------------------
if [ "$HELPERS" = "1" ]; then
    clone_at https://github.com/1038lab/ComfyUI-RMBG "$NODES_DIR/comfyui-rmbg" "$RMBG_REF"
    clone_at https://github.com/1038lab/ComfyUI-QwenVL "$NODES_DIR/ComfyUI-QwenVL" "$QWENVL_REF"
fi

# --- recipe models -----------------------------------------------------------------------
for r in $RECIPES; do
    case "$r" in
        flux2_klein_9b)
            # the file names the shipped recipe "Flux.2 Klein 9B (local)" lists in its Settings panel
            download "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8/resolve/main/flux-2-klein-base-9b-fp8.safetensors" \
                     "$MODELS_DIR/diffusion_models/flux-2-klein-base-9b-fp8.safetensors"
            download "https://huggingface.co/Comfy-Org/flux2-klein-9B/resolve/main/split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors" \
                     "$MODELS_DIR/text_encoders/qwen_3_8b_fp8mixed.safetensors"
            download "https://huggingface.co/black-forest-labs/FLUX.2-small-decoder/resolve/main/full_encoder_small_decoder.safetensors" \
                     "$MODELS_DIR/vae/full_encoder_small_decoder.safetensors"
            ;;
        none) ;;
        *) log "unknown recipe model set: $r" ;;
    esac
done

log "done"
