#!/usr/bin/env bash
# K6 of docs/PLAN_WASM_BUILD.md (§4.2 K6, row 19): SIMD Up, Average and Paeth in png_unfilter_rows.
# Runs under the machine's busy lock (docs/measurements/w1_2026-11-06/w1_lock.py) on port 9621:
#   1. Node and Electron-as-Node kernel benchmarks (node_bench.mjs: before vs after vs scalar vs JS twin).
#   2. Three alternating rounds (r1..r3) of native_test.py 15000x10000 (build_the_file open_the_file open_again close),
#      alternating before (HEAD's px.wasm) and after (K6's px.wasm) on fresh offline instances with focus retry.
set -u
cd /f/canvas/.claude/worktrees/ag-chain-p
HERE="docs/measurements/k6_2026-11-08"
LOCK="docs/measurements/w1_2026-11-06/w1_lock.py"
PORT=9621
export SCUMBLE_CDP_PORT=$PORT
mkdir -p "$HERE/before/native" "$HERE/after/native" "$HERE/node" "$HERE/notcounted"

WASM="renderer/editor/px/px.wasm"
AFTER_TMP="$HERE/px_after.wasm.tmp"
BEFORE_TMP="$HERE/px_before.wasm.tmp"
cp "$WASM" "$AFTER_TMP"
git show HEAD:"$WASM" > "$BEFORE_TMP"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$HERE/chain.log"; }
gpu() { log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader); comfy 8188: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8188/system_stats)"; }

TOKEN=""
cleanup() {
    [ -f "$AFTER_TMP" ] && cp "$AFTER_TMP" "$WASM"
    rm -f "$AFTER_TMP" "$BEFORE_TMP"
    SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >> "$HERE/chain.log" 2>&1 || true
    [ -n "$TOKEN" ] && python "$LOCK" release "$TOKEN" >> "$HERE/chain.log" 2>&1 || true
}
trap cleanup EXIT

TOKEN="$(python "$LOCK" acquire "K6 measuring (chain-p)" 2>> "$HERE/chain.log")"; LRC=$?
if [ $LRC -eq 0 ] && [ -n "$TOKEN" ]; then
    log "lock: taken ($TOKEN)"
elif [ $LRC -eq 3 ]; then
    log "NOT LOCKED: measured while another agent held the lock"
else
    log "lock: acquire failed (rc=$LRC); stopping"; exit 1
fi

log "branch $(git rev-parse --abbrev-ref HEAD) at $(git rev-parse --short HEAD); port $PORT"
log "before px.wasm $(sha256sum "$BEFORE_TMP" | cut -c1-16); after px.wasm $(sha256sum "$AFTER_TMP" | cut -c1-16); px_scalar.wasm $(sha256sum renderer/editor/px/px_scalar.wasm | cut -c1-16)"
gpu

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

run_arm() {
    local arm="$1" r="$2"
    if [ "$arm" = "before" ]; then cp "$BEFORE_TMP" "$WASM"; else cp "$AFTER_TMP" "$WASM"; fi
    local P="$HERE/profile_${arm}_r$r"
    for try in 1 2 3; do
        log "native $arm r$r (try $try, px.wasm $(sha256sum "$WASM" | cut -c1-12))"
        gpu
        start_app "$P" "$HERE/$arm/native/app_r$r.log"
        timeout 1800 python tools/native_test.py 15000x10000 --json "$HERE/$arm/native/r$r.json" \
            build_the_file open_the_file open_again close > "$HERE/$arm/native/r$r.log" 2>&1
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

for R in 1 2 3; do
    log "== round $R"
    if [ $((R % 2)) -eq 1 ]; then
        run_arm before "$R"
        run_arm after "$R"
    else
        run_arm after "$R"
        run_arm before "$R"
    fi
done

cp "$AFTER_TMP" "$WASM"
gpu
log "done"
