#!/usr/bin/env bash
# P5 (PNG parts that start independent: None/Sub on row 0) + Question 6.5 (parallel upload while decoding in loadFile
# and addImageLayers), docs/PLAN_WASM_BUILD.md §4.2 P5 and §7 Stop 4 (questions 6.1 & 6.5).
# Runs under the machine's busy lock (docs/measurements/w1_2026-11-06/w1_lock.py) on port 9621:
#   1. Three alternating rounds (r1..r3) of native_test.py 15000x10000
#      (build_the_file open_the_file open_again add_the_paint_layer export_png export_ora close),
#      alternating before (wasm-kernels 9a5f1681, post-K8 / post-K10b) and after (P5 + parallel upload) on fresh offline instances.
#   2. Three alternating rounds (r1..r3) of w0_bench.py --rows=freqsep_15k (load_jpg, png_export, png_open, freqsep_16mp),
#      alternating before and after on fresh offline instances.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"

LOCK="docs/measurements/w1_2026-11-06/w1_lock.py"
PORT=9621
BASE_SHA="9a5f1681"
IMAGE="F:/canvas/dist/daily/adobe_15000x10000.jpg"
export SCUMBLE_CDP_PORT=$PORT

mkdir -p \
    "$HERE/before/native" "$HERE/after/native" \
    "$HERE/before/bench" "$HERE/after/bench" \
    "$HERE/notcounted"

SWAP_FILES=(
    "renderer/editor/px/px.wasm"
    "renderer/editor/px/px_scalar.wasm"
    "renderer/editor/px/kernels_js.js"
    "renderer/editor/inpaint_bands.js"
    "renderer/editor/inpaint_worker.js"
    "renderer/editor/inpaint_canvas.js"
)

BEFORE_DIR="$HERE/.tmp_before"
AFTER_DIR="$HERE/.tmp_after"
rm -rf "$BEFORE_DIR" "$AFTER_DIR"
mkdir -p "$BEFORE_DIR" "$AFTER_DIR"

for f in "${SWAP_FILES[@]}"; do
    mkdir -p "$BEFORE_DIR/$(dirname "$f")" "$AFTER_DIR/$(dirname "$f")"
    cp "$f" "$AFTER_DIR/$f"
    git cat-file -p "${BASE_SHA}:$f" > "$BEFORE_DIR/$f"
done

set_arm() {
    local src="$AFTER_DIR"
    [ "$1" = "before" ] && src="$BEFORE_DIR"
    for f in "${SWAP_FILES[@]}"; do
        cp "$src/$f" "$f"
    done
}

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$HERE/chain.log"; }
gpu() { log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader); comfy 8188: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8188/system_stats)"; }

TOKEN=""
cleanup() {
    [ -d "$AFTER_DIR" ] && set_arm after
    rm -rf "$BEFORE_DIR" "$AFTER_DIR"
    SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >> "$HERE/chain.log" 2>&1 || true
    [ -n "$TOKEN" ] && python "$LOCK" release "$TOKEN" >> "$HERE/chain.log" 2>&1 || true
}
trap cleanup EXIT

take_lock() {
    TOKEN="$(python "$LOCK" acquire "$1" 2>> "$HERE/chain.log")"; local lrc=$?
    if [ $lrc -eq 0 ] && [ -n "$TOKEN" ]; then
        log "lock: taken ($TOKEN)"
    elif [ $lrc -eq 3 ]; then
        log "NOT LOCKED: measured while another agent held the lock"
    else
        log "lock: acquire failed (rc=$lrc); stopping"; exit 1
    fi
}
drop_lock() {
    if [ -n "$TOKEN" ]; then
        python "$LOCK" release "$TOKEN" >> "$HERE/chain.log" 2>&1 || true
        TOKEN=""
    fi
}

log "branch $(git rev-parse --abbrev-ref HEAD) at $(git rev-parse --short HEAD) (base $BASE_SHA); port $PORT"
log "after  px.wasm $(sha256sum "$AFTER_DIR/renderer/editor/px/px.wasm" | cut -c1-16); px_scalar.wasm $(sha256sum "$AFTER_DIR/renderer/editor/px/px_scalar.wasm" | cut -c1-16)"
log "before px.wasm $(sha256sum "$BEFORE_DIR/renderer/editor/px/px.wasm" | cut -c1-16); px_scalar.wasm $(sha256sum "$BEFORE_DIR/renderer/editor/px/px_scalar.wasm" | cut -c1-16)"
gpu

start_app() {
    curl -s -m 2 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1 && {
        SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >> "$HERE/chain.log" 2>&1 || true
        sleep 3
    }
    rm -rf "$1"; mkdir -p "$1"
    SCUMBLE_TILES=1 ./node_modules/electron/dist/electron.exe . --remote-debugging-port=$PORT --user-data-dir="$1" --no-comfy --tiles > "$2" 2>&1 &
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 6
}
stop_app() {
    grep -h "renderer ended" "$1/logs/scumble.log" >> "$HERE/chain.log" 2>/dev/null || true
    SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >> "$HERE/chain.log" 2>&1 || true
    sleep 3
    rm -rf "$1"
}

run_native_arm() {
    local arm="$1" r="$2"
    set_arm "$arm"
    local P="$HERE/profile_native_${arm}_r$r"
    for try in 1 2 3; do
        log "native $arm r$r (try $try)"
        gpu
        start_app "$P" "$HERE/$arm/native/app_r$r.log"
        PYTHONIOENCODING=utf-8 timeout 1800 python tools/native_test.py 15000x10000 --json "$HERE/$arm/native/r$r.json" \
            build_the_file open_the_file open_again add_the_paint_layer export_png export_ora close > "$HERE/$arm/native/r$r.log" 2>&1
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focused": false' "$HERE/$arm/native/r$r.json" 2>/dev/null; then
            log "native $arm r$r NOT COUNTED (unfocused): try $try"
            mv "$HERE/$arm/native/r$r.json" "$HERE/notcounted/native_${arm}_r${r}_try${try}.json" 2>/dev/null || true
            mv "$HERE/$arm/native/r$r.log" "$HERE/notcounted/native_${arm}_r${r}_try${try}.log" 2>/dev/null || true
            continue
        fi
        break
    done
}

run_bench_arm() {
    local arm="$1" r="$2"
    set_arm "$arm"
    local P="$HERE/profile_bench_${arm}_r$r"
    for try in 1 2 3; do
        log "w0_bench freqsep_15k $arm r$r (try $try)"
        gpu
        start_app "$P" "$HERE/$arm/bench/app_r$r.log"
        PYTHONIOENCODING=utf-8 timeout 1200 python tools/w0_bench.py --rows=freqsep_15k --image="$IMAGE" \
            --json "$HERE/$arm/bench/r$r.json" > "$HERE/$arm/bench/r$r.log" 2>&1
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focus": false' "$HERE/$arm/bench/r$r.log" 2>/dev/null; then
            log "w0_bench $arm r$r NOT COUNTED (unfocused): try $try"
            mv "$HERE/$arm/bench/r$r.json" "$HERE/notcounted/bench_${arm}_r${r}_try${try}.json" 2>/dev/null || true
            mv "$HERE/$arm/bench/r$r.log" "$HERE/notcounted/bench_${arm}_r${r}_try${try}.log" 2>/dev/null || true
            continue
        fi
        break
    done
}

for R in 1 2 3; do
    log "== round $R"
    take_lock "P5 native r$R (chain-p)"
    if [ $((R % 2)) -eq 1 ]; then
        run_native_arm before "$R"
        run_native_arm after "$R"
    else
        run_native_arm after "$R"
        run_native_arm before "$R"
    fi
    drop_lock
    sleep 2
    take_lock "P5 bench r$R (chain-p)"
    if [ $((R % 2)) -eq 1 ]; then
        run_bench_arm before "$R"
        run_bench_arm after "$R"
    else
        run_bench_arm after "$R"
        run_bench_arm before "$R"
    fi
    drop_lock
    sleep 2
done

set_arm after
gpu
log "done"
