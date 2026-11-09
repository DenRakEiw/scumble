#!/usr/bin/env bash
# K15 of docs/PLAN_WASM_BUILD.md (§4.6 K15, §5 row 32):
# `tiff_unpredict`, `tiff_predict_rgba`, `tiff_to_rgba`, `tiffStrip`, `TIFF_JS`, and Question 6.4 sub-byte palette alpha fix.
#
# Runs under the machine's busy lock (docs/measurements/w1_2026-11-06/w1_lock.py, acquired and released per batch):
#   1. Node and Electron-as-Node kernel micro-benchmarks (`PX_ONLY=tiff PX_BENCH=1 node tools/px_test.js`).
#   2. Three alternating rounds (r1..r3) of `tiff_test.py --size 15000x10000 --variant <v>` for each of the 6 variants
#      (`own`, `lzw`, `packbits`, `zlib1`, `raw`, `noise`), one variant per fresh offline Electron instance (`--tiles on`)
#      with focus retry, comparing clean `before` tree at base `3359cb0f` vs `after` tree (K15).
#   3. Three alternating rounds (r1..r3) of `w0_bench.py --rows=tiff_rows_256` (`before` vs `after`), each on a fresh
#      offline Electron instance with focus retry.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MAIN_REPO="$(git -C "$ROOT" worktree list --porcelain | head -n 1 | sed 's/^worktree //')"
LOCK="$ROOT/docs/measurements/w1_2026-11-06/w1_lock.py"
PORT="${SCUMBLE_CDP_PORT:-9633}"
BASE_SHA="3359cb0f"
export SCUMBLE_CDP_PORT="$PORT"

mkdir -p "$HERE/before/tiffperf" "$HERE/after/tiffperf" \
         "$HERE/before/w0bench" "$HERE/after/w0bench" \
         "$HERE/node" "$HERE/notcounted"

BEFORE_TREE="$(dirname "$ROOT")/.tmp_k15_before_$$"
TIFF_OUT="$(dirname "$ROOT")/.tmp_k15_tiff_$$"
PHOTO="$MAIN_REPO/dist/daily/adobe_15000x10000.jpg"
W0_FILES="$MAIN_REPO/dist/w0_files"
TIFF_SRC="$MAIN_REPO/dist/gates/k0a_2026-10-23/tiff_files"
TOKEN=""

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$HERE/chain.log"; }
gpu() { log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader 2>/dev/null || echo n/a); comfy 8188: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8188/system_stats 2>/dev/null || echo down)"; }

acquire_lock() {
    local label="$1"
    TOKEN="$(python "$LOCK" acquire "$label" 2>> "$HERE/chain.log")"; local lrc=$?
    if [ $lrc -eq 0 ] && [ -n "$TOKEN" ]; then
        log "lock: taken ($TOKEN)"
    elif [ $lrc -eq 3 ]; then
        log "NOT LOCKED: measured while another agent held the lock"
        TOKEN=""
    else
        log "lock: acquire failed (rc=$lrc); stopping"
        exit 1
    fi
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
    log "ERROR: before tree electron.exe missing at $BEFORE_TREE/node_modules/electron/dist/electron.exe"
    exit 1
fi

for f in adobe_15000x10000_lzw.tif adobe_15000x10000_packbits.tif adobe_15000x10000_zlib1.tif adobe_15000x10000_raw.tif adobe_15000x10000_rows16.json noise_15000x10000.png; do
    if [ -f "$TIFF_SRC/$f" ]; then
        python -c "import os, sys; os.path.exists(sys.argv[2]) or os.link(sys.argv[1], sys.argv[2])" "$TIFF_SRC/$f" "$TIFF_OUT/$f"
    fi
done

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
    if [ "$1" = "before" ]; then
        echo "$BEFORE_TREE"
    else
        echo "$ROOT"
    fi
}

# 1. Node & Electron-as-Node kernel micro-benchmarks
acquire_lock "K15 node_bench (chain-t)"
log "node px_test tiff bench"
PX_ONLY=tiff PX_BENCH=1 node "$ROOT/tools/px_test.js" > "$HERE/node/node_px_test.log" 2>&1
log "rc=$?"
log "electron-as-node px_test tiff bench"
ELECTRON_RUN_AS_NODE=1 PX_ONLY=tiff PX_BENCH=1 "$ROOT/node_modules/electron/dist/electron.exe" "$ROOT/tools/px_test.js" > "$HERE/node/electron_px_test.log" 2>&1
log "rc=$?"
release_lock
sleep 2

# 2. 15,000 x 10,000 tiffperf variants (one variant per fresh instance, 3 alternating rounds)
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
    for V in own lzw packbits zlib1 raw noise; do
        acquire_lock "K15 tiffperf $V r$R (chain-t)"
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

# 3. 15,000 x 10,000 w0_bench tiff_rows_256 (3 alternating rounds, fresh instance each)
run_w0bench_arm() {
    local arm="$1" r="$2"
    local tree
    tree="$(tree_for_arm "$arm")"
    local P="$HERE/profile_w0bench_${arm}_r$r"
    local jsonfile="$HERE/$arm/w0bench/r$r.json"
    local logfile="$HERE/$arm/w0bench/r$r.log"
    for try in 1 2 3; do
        log "w0_bench tiff_rows_256 $arm r$r (try $try)"
        gpu
        start_app "$tree" "$P" "$HERE/$arm/w0bench/app_r$r.log"
        timeout 900 python "$ROOT/tools/w0_bench.py" --rows=tiff_rows_256 \
            --image="$PHOTO" --files="$W0_FILES" --json "$jsonfile" \
            > "$logfile" 2>&1
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focus": false' "$jsonfile" 2>/dev/null; then
            log "w0_bench $arm r$r NOT COUNTED (unfocused): try $try"
            mv "$jsonfile" "$HERE/notcounted/w0bench_${arm}_r${r}_try${try}.json" 2>/dev/null || true
            mv "$logfile" "$HERE/notcounted/w0bench_${arm}_r${r}_try${try}.log" 2>/dev/null || true
            continue
        fi
        break
    done
}

for R in 1 2 3; do
    acquire_lock "K15 w0_bench tiff_rows_256 r$R (chain-t)"
    log "== w0_bench tiff_rows_256 round $R"
    if [ $((R % 2)) -eq 1 ]; then
        run_w0bench_arm before "$R"
        run_w0bench_arm after "$R"
    else
        run_w0bench_arm after "$R"
        run_w0bench_arm before "$R"
    fi
    release_lock
    sleep 2
done

gpu
log "done"
