#!/usr/bin/env bash
# K3 of docs/PLAN_WASM_BUILD.md (§4.3 K3, row 15): crc32, png_chunk_frame, crc32Combine, and ORA entry CRC from the writer.
# Runs under the machine's busy lock (docs/measurements/w1_2026-11-06/w1_lock.py) on port 9621:
#   1. Node and Electron-as-Node kernel benchmarks (node_bench.mjs: crc32 size sweep, png_chunk_frame vs pngChunk, crc32Combine).
#   2. Three alternating rounds (r1..r3) of native_test.py 15000x10000 (build_the_file open_the_file add_the_paint_layer export_png export_ora close),
#      alternating before (HEAD ad148e2e) and after (K3) on fresh offline instances with focus retry.
#   3. Three rounds (r1..r3) of w0_bench.py --rows=crc32_64mb on fresh offline instances with focus retry.
set -u
cd /f/canvas/.claude/worktrees/ag-chain-p
HERE="docs/measurements/k3_2026-11-08"
LOCK="docs/measurements/w1_2026-11-06/w1_lock.py"
PORT=9621
export SCUMBLE_CDP_PORT=$PORT
mkdir -p "$HERE/before/native" "$HERE/after/native" "$HERE/after/bench" "$HERE/node" "$HERE/notcounted"

SWAP_FILES=(
    "renderer/editor/px/px.wasm"
    "renderer/editor/px/px_scalar.wasm"
    "renderer/editor/px/px.js"
    "renderer/editor/px/kernels.js"
    "renderer/editor/px/kernels_js.js"
    "renderer/editor/inpaint_png.js"
    "renderer/editor/inpaint_worker.js"
    "renderer/editor/inpaint_bands.js"
    "renderer/editor/inpaint_export.js"
)

BEFORE_DIR="$HERE/.tmp_before"
AFTER_DIR="$HERE/.tmp_after"
rm -rf "$BEFORE_DIR" "$AFTER_DIR"
mkdir -p "$BEFORE_DIR" "$AFTER_DIR"

for f in "${SWAP_FILES[@]}"; do
    mkdir -p "$BEFORE_DIR/$(dirname "$f")" "$AFTER_DIR/$(dirname "$f")"
    cp "$f" "$AFTER_DIR/$f"
    git show "HEAD:$f" > "$BEFORE_DIR/$f"
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

TOKEN="$(python "$LOCK" acquire "K3 measuring (chain-p)" 2>> "$HERE/chain.log")"; LRC=$?
if [ $LRC -eq 0 ] && [ -n "$TOKEN" ]; then
    log "lock: taken ($TOKEN)"
elif [ $LRC -eq 3 ]; then
    log "NOT LOCKED: measured while another agent held the lock"
else
    log "lock: acquire failed (rc=$LRC); stopping"; exit 1
fi

log "branch $(git rev-parse --abbrev-ref HEAD) at $(git rev-parse --short HEAD); port $PORT"
log "before px.wasm $(sha256sum "$BEFORE_DIR/renderer/editor/px/px.wasm" | cut -c1-16); after px.wasm $(sha256sum "$AFTER_DIR/renderer/editor/px/px.wasm" | cut -c1-16); after px_scalar.wasm $(sha256sum "$AFTER_DIR/renderer/editor/px/px_scalar.wasm" | cut -c1-16)"
gpu

set_arm after
log "node kernel bench"
node "$HERE/node_bench.mjs" "$HERE/node/node_bench.json" > "$HERE/node/node_bench.log" 2>&1
log "rc=$?"
log "electron-as-node kernel bench"
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe "$HERE/node_bench.mjs" "$HERE/node/electron_bench.json" > "$HERE/node/electron_bench.log" 2>&1
log "rc=$?"

start_app() {
    rm -rf "$1"; mkdir -p "$1"
    ./node_modules/electron/dist/electron.exe . --remote-debugging-port=$PORT --user-data-dir="$1" --no-comfy > "$2" 2>&1 &
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
    local P="$HERE/profile_${arm}_r$r"
    for try in 1 2 3; do
        log "native $arm r$r (try $try, px.wasm $(sha256sum renderer/editor/px/px.wasm | cut -c1-12))"
        gpu
        start_app "$P" "$HERE/$arm/native/app_r$r.log"
        timeout 1800 python tools/native_test.py 15000x10000 --json "$HERE/$arm/native/r$r.json" \
            add_the_paint_layer export_png export_ora > "$HERE/$arm/native/r$r.log" 2>&1
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focused": false' "$HERE/$arm/native/r$r.json" 2>/dev/null; then
            log "native $arm r$r NOT COUNTED (unfocused): try $try"
            mv "$HERE/$arm/native/r$r.json" "$HERE/notcounted/${arm}_r${r}_try${try}.json" 2>/dev/null || true
            mv "$HERE/$arm/native/r$r.log" "$HERE/notcounted/${arm}_r${r}_try${try}.log" 2>/dev/null || true
            continue
        fi
        break
    done
}

run_crc_bench() {
    local r="$1"
    set_arm after
    local P="$HERE/profile_bench_r$r"
    for try in 1 2 3; do
        log "w0_bench crc32_64mb r$r (try $try)"
        gpu
        start_app "$P" "$HERE/after/bench/app_r$r.log"
        timeout 600 python tools/w0_bench.py --json "$HERE/after/bench/crc32_r$r.json" --rows=crc32_64mb \
            > "$HERE/after/bench/crc32_r$r.log" 2>&1
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focus": false' "$HERE/after/bench/crc32_r$r.log" 2>/dev/null; then
            log "w0_bench crc32_64mb r$r NOT COUNTED (unfocused): try $try"
            mv "$HERE/after/bench/crc32_r$r.json" "$HERE/notcounted/crc32_r${r}_try${try}.json" 2>/dev/null || true
            mv "$HERE/after/bench/crc32_r$r.log" "$HERE/notcounted/crc32_r${r}_try${try}.log" 2>/dev/null || true
            continue
        fi
        break
    done
}

for R in 1 2 3; do
    log "== round $R"
    if [ $((R % 2)) -eq 1 ]; then
        run_native_arm before "$R"
        run_native_arm after "$R"
    else
        run_native_arm after "$R"
        run_native_arm before "$R"
    fi
    run_crc_bench "$R"
done

set_arm after
gpu
log "done"
