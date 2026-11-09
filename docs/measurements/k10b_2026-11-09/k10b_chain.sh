#!/usr/bin/env bash
# K10b of docs/PLAN_WASM_BUILD.md (§4.4 K10b, row 44) & docs/PLAN_WASM_K10.md (§9.3):
# Gather + composite + PNG filter / deflate by pointer (`pngPartFromPtr`, `tilesRowsToWasm`, `storeRowsToWasm`,
# `stackRowsToWasm`, `partPtrOf`, routes `composeTiles` and `composeStack`).
#
# Runs under the machine's busy lock (docs/measurements/w1_2026-11-06/w1_lock.py, acquired and released per batch):
#   1. Node and Electron-as-Node kernel micro-benchmarks (`node_bench.mjs`).
#   2. Three alternating rounds (r1..r3) of `native_test.py 15000x10000` (`build_the_file open_the_file
#      add_the_paint_layer wand_whole_picture export_png export_psd export_ora open_psd open_ora match_export_png close`)
#      against an exported clean `before` tree at base `3fd8bda7` and the `after` tree (K10b), on fresh offline
#      Electron instances with focus retry.
#   3. Three alternating rounds (r1..r3) of `export_test.py --perf 15000x10000` (`before` vs `after`).
#   4. Three alternating rounds (r1..r3) of `tiff_test.py --size 15000x10000 --variant noise,own` (`before` vs `after`).
#   5. Memory retention probe (`px_probe.py --retention 15000x10000`) on `composeStack=js` vs `composeStack=rust`.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MAIN_REPO="$(git -C "$ROOT" worktree list --porcelain | head -n 1 | sed 's/^worktree //')"
LOCK="$ROOT/docs/measurements/w1_2026-11-06/w1_lock.py"
PORT="${SCUMBLE_CDP_PORT:-9629}"
BASE_SHA="3fd8bda7"
export SCUMBLE_CDP_PORT="$PORT"

mkdir -p "$HERE/before/native" "$HERE/after/native" \
         "$HERE/before/exportperf" "$HERE/after/exportperf" \
         "$HERE/before/tiffperf" "$HERE/after/tiffperf" \
         "$HERE/retention" "$HERE/node" "$HERE/notcounted"

BEFORE_TREE="$(dirname "$ROOT")/.tmp_k10b_before_$$"
TIFF_OUT="$(dirname "$ROOT")/.tmp_k10b_tiff_$$"
PHOTO="$MAIN_REPO/dist/daily/adobe_15000x10000.jpg"
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

log "branch $(git -C "$ROOT" rev-parse --abbrev-ref HEAD) at $(git -C "$ROOT" rev-parse --short HEAD); base $BASE_SHA; port $PORT"
log "before px.wasm $(sha256sum "$BEFORE_TREE/renderer/editor/px/px.wasm" | cut -c1-16); after px.wasm $(sha256sum "$ROOT/renderer/editor/px/px.wasm" | cut -c1-16); after px_scalar.wasm $(sha256sum "$ROOT/renderer/editor/px/px_scalar.wasm" | cut -c1-16)"
gpu

start_app() {
    local tree="$1" prof="$2" applog="$3"
    rm -rf "$prof"; mkdir -p "$prof"
    "$tree/node_modules/electron/dist/electron.exe" "$tree" --remote-debugging-port="$PORT" --user-data-dir="$prof" --no-comfy > "$applog" 2>&1 &
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

# 1. Node & Electron-as-Node micro-benchmarks
acquire_lock "K10b node_bench (chain-c)"
log "node kernel bench"
node "$HERE/node_bench.mjs" "$HERE/node/node_bench.json" > "$HERE/node/node_bench.log" 2>&1
log "rc=$?"
log "electron-as-node kernel bench"
ELECTRON_RUN_AS_NODE=1 "$ROOT/node_modules/electron/dist/electron.exe" "$HERE/node_bench.mjs" "$HERE/node/electron_bench.json" > "$HERE/node/electron_bench.log" 2>&1
log "rc=$?"
release_lock
sleep 2

# 2. 15,000 x 10,000 native_test.py (3 alternating rounds)
run_native_arm() {
    local arm="$1" r="$2"
    local tree
    tree="$(tree_for_arm "$arm")"
    local P="$HERE/profile_native_${arm}_r$r"
    for try in 1 2 3; do
        log "native $arm r$r (try $try, px.wasm $(sha256sum "$tree/renderer/editor/px/px.wasm" | cut -c1-12))"
        gpu
        start_app "$tree" "$P" "$HERE/$arm/native/app_r$r.log"
        timeout 1800 python "$ROOT/tools/native_test.py" 15000x10000 --json "$HERE/$arm/native/r$r.json" \
            build_the_file open_the_file add_the_paint_layer wand_whole_picture \
            export_png export_psd export_ora open_psd open_ora match_export_png close \
            > "$HERE/$arm/native/r$r.log" 2>&1
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

for R in 1 2 3; do
    acquire_lock "K10b native_test r$R (chain-c)"
    log "== native_test round $R"
    if [ $((R % 2)) -eq 1 ]; then
        run_native_arm before "$R"
        run_native_arm after "$R"
    else
        run_native_arm after "$R"
        run_native_arm before "$R"
    fi
    release_lock
    sleep 2
done

# 3. 15,000 x 10,000 exportperf (3 alternating rounds)
run_exportperf_arm() {
    local arm="$1" r="$2"
    local tree
    tree="$(tree_for_arm "$arm")"
    local P="$HERE/profile_exportperf_${arm}_r$r"
    for try in 1 2 3; do
        log "exportperf $arm r$r (try $try)"
        gpu
        start_app "$tree" "$P" "$HERE/$arm/exportperf/app_r$r.log"
        timeout 1800 python "$ROOT/tools/export_test.py" --perf 15000x10000 \
            > "$HERE/$arm/exportperf/r$r.json" 2> "$HERE/$arm/exportperf/r$r.err"
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focused": false' "$HERE/$arm/exportperf/r$r.json" 2>/dev/null; then
            log "exportperf $arm r$r NOT COUNTED (unfocused): try $try"
            mv "$HERE/$arm/exportperf/r$r.json" "$HERE/notcounted/exportperf_${arm}_r${r}_try${try}.json" 2>/dev/null || true
            continue
        fi
        break
    done
}

for R in 1 2 3; do
    acquire_lock "K10b exportperf r$R (chain-c)"
    log "== exportperf round $R"
    if [ $((R % 2)) -eq 1 ]; then
        run_exportperf_arm before "$R"
        run_exportperf_arm after "$R"
    else
        run_exportperf_arm after "$R"
        run_exportperf_arm before "$R"
    fi
    release_lock
    sleep 2
done

# 4. 15,000 x 10,000 tiffperf noise,own (3 alternating rounds)
run_tiffperf_arm() {
    local arm="$1" r="$2"
    local tree
    tree="$(tree_for_arm "$arm")"
    local P="$HERE/profile_tiffperf_${arm}_r$r"
    for try in 1 2 3; do
        log "tiffperf $arm r$r (try $try)"
        gpu
        start_app "$tree" "$P" "$HERE/$arm/tiffperf/app_r$r.log"
        timeout 1800 python "$ROOT/tools/tiff_test.py" --size 15000x10000 --variant noise,own \
            --image "$PHOTO" --out "$TIFF_OUT" \
            > "$HERE/$arm/tiffperf/r$r.log" 2>&1
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focused": false' "$HERE/$arm/tiffperf/r$r.log" 2>/dev/null; then
            log "tiffperf $arm r$r NOT COUNTED (unfocused): try $try"
            mv "$HERE/$arm/tiffperf/r$r.log" "$HERE/notcounted/tiffperf_${arm}_r${r}_try${try}.log" 2>/dev/null || true
            continue
        fi
        break
    done
}

for R in 1 2 3; do
    acquire_lock "K10b tiffperf r$R (chain-c)"
    log "== tiffperf round $R"
    if [ $((R % 2)) -eq 1 ]; then
        run_tiffperf_arm before "$R"
        run_tiffperf_arm after "$R"
    else
        run_tiffperf_arm after "$R"
        run_tiffperf_arm before "$R"
    fi
    release_lock
    sleep 2
done

# 5. Memory retention probe (composeStack=js vs composeStack=rust)
acquire_lock "K10b retention (chain-c)"
log "== px_probe retention 15000x10000"
rm -f "$HERE/retention/px_probe.jsonl"
for route_val in js rust; do
    P="$HERE/profile_retention_$route_val"
    log "retention composeStack=$route_val"
    start_app "$ROOT" "$P" "$HERE/retention/app_${route_val}.log"
    PX_PROBE_JSON="$HERE/retention/px_probe.jsonl" timeout 900 python "$ROOT/tools/px_probe.py" \
        --retention 15000x10000 --set "composeStack=$route_val" \
        > "$HERE/retention/retention_${route_val}.log" 2>&1
    log "rc=$?"
    stop_app "$P"
done
release_lock

gpu
log "done"
