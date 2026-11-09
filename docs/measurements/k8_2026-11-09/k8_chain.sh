#!/usr/bin/env bash
# K8 of docs/PLAN_WASM_BUILD.md (§4.2 K8, row K8): the parted PNG reader in the app, route N (native DecompressionStream("deflate-raw")).
# Runs under the machine's busy lock (docs/measurements/w1_2026-11-06/w1_lock.py) on port 9621:
#   1. Three alternating rounds (r1..r3) of native_test.py 15000x10000
#      (build_the_file open_the_file open_again add_the_paint_layer export_png export_ora close),
#      alternating before (HEAD 9fd93524, single-stream png_read) and after (K8 parted reader) on fresh offline instances.
#   2. Three alternating rounds (r1..r3) of w0_bench.py --rows=freqsep_15k (load_jpg, png_export, png_open, freqsep_16mp),
#      alternating before and after on fresh offline instances.
#   3. Three alternating rounds (r1..r3) of document_perf.py 15000x10000 (restoreMs, openMs on a 4-layer .scumble document),
#      alternating before and after on fresh offline instances.
#   4. Stop 4 probe (stop4_probe.py) on a fresh offline instance: browser-encoded 15k PNG open, Question 6.1 (P5 independent
#      part starts A/B on synthetic n1_15k and real photo_15k), and Question 6.5 (upload while decoding A/B).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"

LOCK="docs/measurements/w1_2026-11-06/w1_lock.py"
PORT=9621
IMAGE="F:/canvas/dist/daily/adobe_15000x10000.jpg"
export SCUMBLE_CDP_PORT=$PORT

mkdir -p \
    "$HERE/before/native" "$HERE/after/native" \
    "$HERE/before/bench" "$HERE/after/bench" \
    "$HERE/before/docperf" "$HERE/after/docperf" \
    "$HERE/docperf_out" "$HERE/notcounted"

SWAP_FILES=(
    "renderer/editor/px/kernels.js"
    "renderer/editor/inpaint_png.js"
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
    rm -rf "$BEFORE_DIR" "$AFTER_DIR" "$HERE/docperf_out"
    SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >> "$HERE/chain.log" 2>&1 || true
    [ -n "$TOKEN" ] && python "$LOCK" release "$TOKEN" >> "$HERE/chain.log" 2>&1 || true
}
trap cleanup EXIT

TOKEN="$(python "$LOCK" acquire "K8 measuring (chain-p)" 2>> "$HERE/chain.log")"; LRC=$?
if [ $LRC -eq 0 ] && [ -n "$TOKEN" ]; then
    log "lock: taken ($TOKEN)"
elif [ $LRC -eq 3 ]; then
    log "NOT LOCKED: measured while another agent held the lock"
else
    log "lock: acquire failed (rc=$LRC); stopping"; exit 1
fi

log "branch $(git rev-parse --abbrev-ref HEAD) at $(git rev-parse --short HEAD); port $PORT"
log "px.wasm $(sha256sum renderer/editor/px/px.wasm | cut -c1-16); px_scalar.wasm $(sha256sum renderer/editor/px/px_scalar.wasm | cut -c1-16)"
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

run_docperf_arm() {
    local arm="$1" r="$2"
    set_arm "$arm"
    local P="$HERE/profile_docperf_${arm}_r$r"
    log "docperf $arm r$r"
    gpu
    start_app "$P" "$HERE/$arm/docperf/app_r$r.log"
    PYTHONIOENCODING=utf-8 timeout 1800 python tools/document_perf.py 15000x10000 --out "$HERE/docperf_out" \
        > "$HERE/$arm/docperf/r$r.log" 2>&1
    log "rc=$?"
    stop_app "$P"
}

if [ "${1:-}" != "--tail-only" ] && [ "${1:-}" != "--stop4-only" ]; then
    for R in 1 2 3; do
        log "== round $R"
        if [ $((R % 2)) -eq 1 ]; then
            run_native_arm before "$R"
            run_native_arm after "$R"
            run_bench_arm before "$R"
            run_bench_arm after "$R"
            run_docperf_arm before "$R"
            run_docperf_arm after "$R"
        else
            run_native_arm after "$R"
            run_native_arm before "$R"
            run_bench_arm after "$R"
            run_bench_arm before "$R"
            run_docperf_arm after "$R"
            run_docperf_arm before "$R"
        fi
    done
fi

set_arm after
for try in 1 2 3; do
    log "stop4_probe (try $try)"
    gpu
    start_app "$HERE/profile_stop4" "$HERE/after/app_stop4.log"
    PYTHONIOENCODING=utf-8 timeout 2400 python "$HERE/stop4_probe.py" --image="$IMAGE" --json "$HERE/after/stop4_probe.json" \
        > "$HERE/after/stop4_probe.log" 2>&1
    RC=$?
    log "rc=$RC"
    stop_app "$HERE/profile_stop4"
    if [ $RC -ne 0 ]; then break; fi
    if grep -q '"focused": false' "$HERE/after/stop4_probe.json" 2>/dev/null; then
        log "stop4_probe NOT COUNTED (unfocused): try $try"
        mv "$HERE/after/stop4_probe.json" "$HERE/notcounted/stop4_probe_try${try}.json" 2>/dev/null || true
        mv "$HERE/after/stop4_probe.log" "$HERE/notcounted/stop4_probe_try${try}.log" 2>/dev/null || true
        continue
    fi
    break
done

if [ "${1:-}" != "--stop4-only" ]; then
    log "huge 30000x20000 open + restore"
    gpu
    start_app "$HERE/profile_huge" "$HERE/after/app_huge.log"
    PYTHONIOENCODING=utf-8 timeout 2400 python tools/huge_test.py 30000x20000 \
        write_the_png_from_tiles open_through_the_stream_reader the_screen_pan_zoom_and_a_stroke the_state_for_the_autosave a_restore_from_the_state close \
        > "$HERE/after/huge_open_restore.log" 2>&1
    log "rc=$?"
    stop_app "$HERE/profile_huge"
fi

set_arm after
gpu
log "done"
