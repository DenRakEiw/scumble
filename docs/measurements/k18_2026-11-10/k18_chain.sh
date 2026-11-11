#!/usr/bin/env bash
# K18 of docs/PLAN_WASM_BUILD.md (§4.6 K18, §5 row 35):
# Parallel TIFF worker bands (`tiff_band` carrying only `plan.spec` and `plan.bands[i]`, posted at `NORMAL` priority
# ahead of `EXPORT`), `later` cancellation without fallback, group cancellation + partial `px.release()` + fallback to
# `tiff_read` on any band error, `InpaintEditor.tiffBandRows`, and 15k compare checking one row per band plus whole-picture SHA-256.
#
# Runs under the machine's busy lock (docs/measurements/w1_2026-11-06/w1_lock.py, acquired and released per batch):
#   1. Node and Electron-as-Node kernel micro-benchmarks (`PX_ONLY=tiff PX_BENCH=1 node tools/px_test.js`).
#   2. Three alternating rounds (r1..r3) of `tiff_test.py --size 15000x10000 --variant <v>` for each of the 7 variants
#      (`own`, `lzw`, `packbits`, `raw_strips`, `zlib1`, `raw`, `noise`), one variant per fresh offline Electron instance (`--tiles on`)
#      with focus retry, comparing clean `before` tree at base `c36840d8` (K17) vs `after` tree (K18).
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MAIN_REPO="$(git -C "$ROOT" worktree list --porcelain | head -n 1 | sed 's/^worktree //')"
LOCK="$ROOT/docs/measurements/w1_2026-11-06/w1_lock.py"
PORT="${SCUMBLE_CDP_PORT:-9633}"
BASE_SHA="c36840d8"
export SCUMBLE_CDP_PORT="$PORT"

mkdir -p "$HERE/before/tiffperf" "$HERE/after/tiffperf" "$HERE/node" "$HERE/notcounted"

BEFORE_TREE="$(dirname "$ROOT")/.tmp_k18_before_$$"
TIFF_OUT="$(dirname "$ROOT")/.tmp_k18_tiff_$$"
PHOTO="$MAIN_REPO/dist/daily/adobe_15000x10000.jpg"
TIFF_SRC="$MAIN_REPO/dist/gates/k0a_2026-10-23/tiff_files"
TOKEN=""

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$HERE/chain.log"; }
gpu() { log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader 2>/dev/null || echo n/a); comfy 8188: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8188/system_stats 2>/dev/null || echo down)"; }

acquire_lock() {
    local label="$1"
    while true; do
        TOKEN="$(python "$LOCK" acquire "$label" 2>> "$HERE/chain.log")"; local lrc=$?
        if [ $lrc -eq 0 ] && [ -n "$TOKEN" ]; then
            log "lock: taken ($TOKEN)"
            return 0
        elif [ $lrc -eq 3 ]; then
            log "lock: still held after 60 min; continuing to wait for lock ($label)"
            sleep 10
        else
            log "lock: acquire failed (rc=$lrc); stopping"
            exit 1
        fi
    done
}

release_lock() {
    if [ -n "$TOKEN" ]; then
        python "$LOCK" release "$TOKEN" >> "$HERE/chain.log" 2>&1 || true
        TOKEN=""
    fi
}

cleanup() {
    SCUMBLE_CDP_PORT="$PORT" python "$ROOT/tools/close_app.py" >> "$HERE/chain.log" 2>&1 || true
    release_lock
    python -c "import os, sys; p = sys.argv[1]; os.path.lexists(p) and os.rmdir(p)" "$BEFORE_TREE/node_modules" 2>/dev/null || true
    rm -rf "$BEFORE_TREE" "$TIFF_OUT" "$HERE"/profile_* 2>/dev/null || true
}
trap cleanup EXIT

log "exporting clean before tree at $BASE_SHA to $BEFORE_TREE"
mkdir -p "$BEFORE_TREE" "$TIFF_OUT"
git -C "$ROOT" archive "$BASE_SHA" | tar -x -C "$BEFORE_TREE"
python -c "import os, sys, _winapi; _winapi.CreateJunction(os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2]))" "$MAIN_REPO/node_modules" "$BEFORE_TREE/node_modules"
if [ ! -f "$BEFORE_TREE/node_modules/electron/dist/electron.exe" ]; then
    log "ERROR: electron.exe missing in scratch tree $BEFORE_TREE"
    exit 1
fi

# Hardlink cached 15k fixture pictures (not the JSON sidecar, which K18 generates fresh with bandRowsSha256 + picSha256)
for f in adobe_15000x10000_lzw.tif adobe_15000x10000_packbits.tif adobe_15000x10000_raw_strips.tif adobe_15000x10000_zlib1.tif adobe_15000x10000_raw.tif noise_15000x10000.png; do
    if [ -f "$TIFF_SRC/$f" ]; then
        python -c "import os, shutil, sys
if not os.path.exists(sys.argv[2]):
    try: os.link(sys.argv[1], sys.argv[2])
    except OSError: shutil.copyfile(sys.argv[1], sys.argv[2])
" "$TIFF_SRC/$f" "$TIFF_OUT/$f"
    fi
done

log "preparing 15k third-party fixtures and band/picture SHA-256 sidecar in $TIFF_OUT before timed runs"
python - "$ROOT" "$PHOTO" "$TIFF_OUT" <<'PY'
import importlib.util, os, sys
root, photo, out = sys.argv[1], sys.argv[2], sys.argv[3]
spec = importlib.util.spec_from_file_location("tiff_test", os.path.join(root, "tools", "tiff_test.py"))
mod = importlib.util.module_from_spec(spec)
sys.argv = ["tiff_test.py", "--size", "15000x10000", "--image", photo, "--out", out]
spec.loader.exec_module(mod)
mod.photo_files(["lzw", "packbits", "raw_strips", "zlib1", "raw"])
PY

log "branch $(git -C "$ROOT" rev-parse --abbrev-ref HEAD) at $(git -C "$ROOT" rev-parse --short HEAD); base $BASE_SHA; port $PORT"
log "before px.wasm $(sha256sum "$BEFORE_TREE/renderer/editor/px/px.wasm" | cut -c1-16); after px.wasm $(sha256sum "$ROOT/renderer/editor/px/px.wasm" | cut -c1-16); after px_scalar.wasm $(sha256sum "$ROOT/renderer/editor/px/px_scalar.wasm" | cut -c1-16)"
gpu

start_app() {
    local tree="$1" prof="$2" applog="$3"
    rm -rf "$prof"; mkdir -p "$prof"
    "$tree/node_modules/electron/dist/electron.exe" "$tree" --remote-debugging-port="$PORT" --user-data-dir="$prof" --tiles on --no-comfy > "$applog" 2>&1 &
    for i in $(seq 1 120); do
        curl -s -m 1 "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1 && break
        sleep 1
    done
    sleep 6
}

stop_app() {
    local prof="$1"
    grep -h "renderer ended" "$prof/logs/scumble.log" >> "$HERE/chain.log" 2>/dev/null || true
    SCUMBLE_CDP_PORT="$PORT" python "$ROOT/tools/close_app.py" >> "$HERE/chain.log" 2>&1 || true
    sleep 3
    rm -rf "$prof"
}

tree_for_arm() {
    case "$1" in
        before) echo "$BEFORE_TREE" ;;
        *) echo "$ROOT" ;;
    esac
}

# 1. Node & Electron-as-Node kernel tests & micro-benchmarks
if [ ! -s "$HERE/node/node_px_test.log" ] || [ ! -s "$HERE/node/electron_px_test.log" ]; then
    acquire_lock "K18 node_bench (chain-t)"
    log "node px_test tiff bench"
    PX_ONLY=tiff PX_BENCH=1 node "$ROOT/tools/px_test.js" > "$HERE/node/node_px_test.log" 2>&1
    log "rc=$?"
    log "electron-as-node px_test tiff bench"
    ELECTRON_RUN_AS_NODE=1 PX_ONLY=tiff PX_BENCH=1 "$ROOT/node_modules/electron/dist/electron.exe" "$ROOT/tools/px_test.js" > "$HERE/node/electron_px_test.log" 2>&1
    log "rc=$?"
    release_lock
    sleep 2
fi

# 2. 15,000 x 10,000 tiffperf variants (one variant per fresh instance, 3 alternating rounds: before c36840d8 vs after K18)
run_tiffperf_variant() {
    local arm="$1" v="$2" r="$3"
    local tree
    tree="$(tree_for_arm "$arm")"
    local P="$HERE/profile_tiffperf_${arm}_${v}_r$r"
    local logfile="$HERE/$arm/tiffperf/${v}_r$r.log"
    for try in 1 2 3; do
        log "tiffperf $arm $v r$r (try $try, px.wasm $(sha256sum "$tree/renderer/editor/px/px.wasm" | cut -c1-12))"
        gpu
        start_app "$tree" "$P" "$HERE/$arm/tiffperf/app_${v}_r$r.log"
        timeout 1800 python "$ROOT/tools/tiff_test.py" --size 15000x10000 --variant "$v" \
            --image "$PHOTO" --out "$TIFF_OUT" \
            > "$logfile" 2>&1
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focused": false' "$logfile" 2>/dev/null; then
            log "tiffperf $arm $v r$r NOT COUNTED (unfocused): try $try"
            mv "$logfile" "$HERE/notcounted/tiffperf_${arm}_${v}_r${r}_try${try}.log" 2>/dev/null || true
            continue
        fi
        break
    done
}

for R in 1 2 3; do
    for V in own lzw packbits raw_strips zlib1 raw noise; do
        if [ -s "$HERE/before/tiffperf/${V}_r${R}.log" ] && [ -s "$HERE/after/tiffperf/${V}_r${R}.log" ]; then
            continue
        fi
        acquire_lock "K18 tiffperf $V r$R (chain-t)"
        log "== tiffperf $V round $R"
        if [ $((R % 2)) -eq 1 ]; then
            run_tiffperf_variant before "$V" "$R"
            run_tiffperf_variant after "$V" "$R"
        else
            run_tiffperf_variant after "$V" "$R"
            run_tiffperf_variant before "$V" "$R"
        fi
        release_lock
        sleep 2
    done
done

gpu
log "done"
