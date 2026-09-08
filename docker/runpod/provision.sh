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
#   HF_TOKEN          Hugging Face token for gated downloads (Flux.2 Klein needs it)
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

clone_or_pull() {
    local url="$1" dir="$2"
    if [ -d "$dir/.git" ]; then
        log "updating $(basename "$dir")"; git -C "$dir" pull --ff-only || true
    else
        log "cloning $url"; git clone --depth 1 "$url" "$dir"
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
    if [ -n "${HF_TOKEN:-}" ]; then auth=(--header "Authorization: Bearer ${HF_TOKEN}"); fi
    wget -q --show-progress --progress=bar:force:noscroll "${auth[@]}" -O "$target.part" "$url"
    mv "$target.part" "$target"
}

mkdir -p "$NODES_DIR" "$MODELS_DIR"

# --- the node pack the app needs ---------------------------------------------------------
clone_or_pull https://github.com/DenRakEiw/ComfyUI-InpaintCanvas "$NODES_DIR/ComfyUI-InpaintCanvas"

# --- optional helper packs ---------------------------------------------------------------
if [ "$HELPERS" = "1" ]; then
    clone_or_pull https://github.com/1038lab/ComfyUI-RMBG "$NODES_DIR/comfyui-rmbg"
    clone_or_pull https://github.com/1038lab/ComfyUI-QwenVL "$NODES_DIR/ComfyUI-QwenVL"
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
