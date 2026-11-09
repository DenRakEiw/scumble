#!/usr/bin/env bash
# K10c of docs/PLAN_WASM_BUILD.md (§4.4 K10c, row 44) & docs/PLAN_WASM_K10.md (§9.3):
# PSD pack by pointer (`psdPackRowsFromPtr`, route `psdPartWasm`), wand/filter box stack into wasm memory
# (`stackInto`, route `stackIntoWasm`), and Rust SIMD + scalar `clip_coverage` (route `clipCoverage`) and
# `dissolve_rows` (route `dissolveRows`).
#
# Runs under the machine's busy lock (docs/measurements/w1_2026-11-06/w1_lock.py, acquired and released per batch):
#   1. Node and Electron-as-Node kernel micro-benchmarks (`node_bench.mjs`).
#   2. Three alternating rounds (r1..r3) of Stack + Match `native_test.py 15000x10000`
#      (`build_the_file open_the_file add_the_paint_layer wand_whole_picture export_png export_psd export_ora
#        match_export_png match_wand close`) against an exported clean `before` tree at base `3359cb0f` and `after` (K10c).
#   3. Three alternating rounds (r1..r3) of Filter-band `native_test.py 15000x10000`
#      (`open_the_file add_the_paint_layer filter_export_png filter_wand close`) (`before` vs `after`).
#   4. Three alternating rounds (r1..r3) of `export_test.py --perf 15000x10000` (`before` vs `after`).
#   5. Three alternating rounds (r1..r3) of `export_test.py --perf 15000x10000 --blend=dissolve`
#      (`--set dissolveRows=js` vs `--set dissolveRows=rust`).
#   6. Three alternating rounds (r1..r3) of `export_test.py --perf 15000x10000 --clipped`
#      (`--set clipCoverage=js` vs `--set clipCoverage=rust`).
#   7. Memory retention probes (`px_probe.py --retention 15000x10000` and `retention_psd_wand.py` on `export_psd`
#      and `wand_whole_picture`).
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MAIN_REPO="$(git -C "$ROOT" worktree list --porcelain | head -n 1 | sed 's/^worktree //')"
LOCK="$ROOT/docs/measurements/w1_2026-11-06/w1_lock.py"
PORT="${SCUMBLE_CDP_PORT:-9629}"
BASE_SHA="3359cb0f"
export SCUMBLE_CDP_PORT="$PORT"

mkdir -p "$HERE/before/native" "$HERE/after/native" \
         "$HERE/before/native_filter" "$HERE/after/native_filter" \
         "$HERE/before/exportperf" "$HERE/after/exportperf" \
         "$HERE/before/exportperf_dissolve" "$HERE/after/exportperf_dissolve" \
         "$HERE/before/exportperf_clipped" "$HERE/after/exportperf_clipped" \
         "$HERE/retention" "$HERE/node" "$HERE/notcounted"

BEFORE_TREE="$(dirname "$ROOT")/.tmp_k10c_before_$$"
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
    rm -rf "$BEFORE_TREE" "$HERE"/profile_* 2>/dev/null || true
}
trap cleanup EXIT

log "exporting clean before tree at $BASE_SHA to $BEFORE_TREE"
mkdir -p "$BEFORE_TREE"
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

if [ "${1:-}" != "--retention-only" ]; then

# 1. Node & Electron-as-Node micro-benchmarks
acquire_lock "K10c node_bench (chain-c)"
log "node kernel bench"
node "$HERE/node_bench.mjs" "$HERE/node/node_bench.json" > "$HERE/node/node_bench.log" 2>&1
log "rc=$?"
log "electron-as-node kernel bench"
ELECTRON_RUN_AS_NODE=1 "$ROOT/node_modules/electron/dist/electron.exe" "$HERE/node_bench.mjs" "$HERE/node/electron_bench.json" > "$HERE/node/electron_bench.log" 2>&1
log "rc=$?"
release_lock
sleep 2

# 2. 15,000 x 10,000 Stack + Match native_test.py (3 alternating rounds)
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
            export_png export_psd export_ora match_export_png match_wand close \
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
    acquire_lock "K10c native_test r$R (chain-c)"
    log "== native_test (Stack + Match) round $R"
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

# 3. 15,000 x 10,000 Filter-band native_test.py (3 alternating rounds)
run_native_filter_arm() {
    local arm="$1" r="$2"
    local tree
    tree="$(tree_for_arm "$arm")"
    local P="$HERE/profile_native_filter_${arm}_r$r"
    for try in 1 2 3; do
        log "native_filter $arm r$r (try $try, px.wasm $(sha256sum "$tree/renderer/editor/px/px.wasm" | cut -c1-12))"
        gpu
        start_app "$tree" "$P" "$HERE/$arm/native_filter/app_r$r.log"
        timeout 1800 python "$ROOT/tools/native_test.py" 15000x10000 --json "$HERE/$arm/native_filter/r$r.json" \
            open_the_file add_the_paint_layer filter_export_png filter_wand close \
            > "$HERE/$arm/native_filter/r$r.log" 2>&1
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focused": false' "$HERE/$arm/native_filter/r$r.json" 2>/dev/null; then
            log "native_filter $arm r$r NOT COUNTED (unfocused): try $try"
            mv "$HERE/$arm/native_filter/r$r.json" "$HERE/notcounted/native_filter_${arm}_r${r}_try${try}.json" 2>/dev/null || true
            mv "$HERE/$arm/native_filter/r$r.log" "$HERE/notcounted/native_filter_${arm}_r${r}_try${try}.log" 2>/dev/null || true
            continue
        fi
        break
    done
}

for R in 1 2 3; do
    acquire_lock "K10c native_filter r$R (chain-c)"
    log "== native_test (Filter band) round $R"
    if [ $((R % 2)) -eq 1 ]; then
        run_native_filter_arm before "$R"
        run_native_filter_arm after "$R"
    else
        run_native_filter_arm after "$R"
        run_native_filter_arm before "$R"
    fi
    release_lock
    sleep 2
done

# 4. 15,000 x 10,000 exportperf default (3 alternating rounds)
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
    acquire_lock "K10c exportperf r$R (chain-c)"
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

# 5. 15,000 x 10,000 exportperf --blend=dissolve (3 alternating rounds: dissolveRows=js vs dissolveRows=rust)
run_exportperf_dissolve_arm() {
    local arm="$1" r="$2"
    local route_val="rust"
    if [ "$arm" = "before" ]; then
        route_val="js"
    fi
    local P="$HERE/profile_exportperf_dissolve_${arm}_r$r"
    for try in 1 2 3; do
        log "exportperf_dissolve $arm (dissolveRows=$route_val) r$r (try $try)"
        gpu
        start_app "$ROOT" "$P" "$HERE/$arm/exportperf_dissolve/app_r$r.log"
        timeout 1800 python "$ROOT/tools/export_test.py" --perf 15000x10000 --blend=dissolve --set "dissolveRows=$route_val" \
            > "$HERE/$arm/exportperf_dissolve/r$r.json" 2> "$HERE/$arm/exportperf_dissolve/r$r.err"
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focused": false' "$HERE/$arm/exportperf_dissolve/r$r.json" 2>/dev/null; then
            log "exportperf_dissolve $arm r$r NOT COUNTED (unfocused): try $try"
            mv "$HERE/$arm/exportperf_dissolve/r$r.json" "$HERE/notcounted/exportperf_dissolve_${arm}_r${r}_try${try}.json" 2>/dev/null || true
            continue
        fi
        break
    done
}

for R in 1 2 3; do
    acquire_lock "K10c exportperf_dissolve r$R (chain-c)"
    log "== exportperf --blend=dissolve round $R"
    if [ $((R % 2)) -eq 1 ]; then
        run_exportperf_dissolve_arm before "$R"
        run_exportperf_dissolve_arm after "$R"
    else
        run_exportperf_dissolve_arm after "$R"
        run_exportperf_dissolve_arm before "$R"
    fi
    release_lock
    sleep 2
done

# 6. 15,000 x 10,000 exportperf --clipped (3 alternating rounds: clipCoverage=js vs clipCoverage=rust)
run_exportperf_clipped_arm() {
    local arm="$1" r="$2"
    local route_val="rust"
    if [ "$arm" = "before" ]; then
        route_val="js"
    fi
    local P="$HERE/profile_exportperf_clipped_${arm}_r$r"
    for try in 1 2 3; do
        log "exportperf_clipped $arm (clipCoverage=$route_val) r$r (try $try)"
        gpu
        start_app "$ROOT" "$P" "$HERE/$arm/exportperf_clipped/app_r$r.log"
        timeout 1800 python "$ROOT/tools/export_test.py" --perf 15000x10000 --clipped --set "clipCoverage=$route_val" \
            > "$HERE/$arm/exportperf_clipped/r$r.json" 2> "$HERE/$arm/exportperf_clipped/r$r.err"
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focused": false' "$HERE/$arm/exportperf_clipped/r$r.json" 2>/dev/null; then
            log "exportperf_clipped $arm r$r NOT COUNTED (unfocused): try $try"
            mv "$HERE/$arm/exportperf_clipped/r$r.json" "$HERE/notcounted/exportperf_clipped_${arm}_r${r}_try${try}.json" 2>/dev/null || true
            continue
        fi
        break
    done
}

for R in 1 2 3; do
    acquire_lock "K10c exportperf_clipped r$R (chain-c)"
    log "== exportperf --clipped round $R"
    if [ $((R % 2)) -eq 1 ]; then
        run_exportperf_clipped_arm before "$R"
        run_exportperf_clipped_arm after "$R"
    else
        run_exportperf_clipped_arm after "$R"
        run_exportperf_clipped_arm before "$R"
    fi
    release_lock
    sleep 2
done

fi

# 7. Memory retention probes (px_probe.py --retention + export_psd + wand_whole_picture)
acquire_lock "K10c retention (chain-c)"
log "== px_probe retention & psd/wand retention 15000x10000"
rm -f "$HERE/retention/px_probe.jsonl" "$HERE/retention/psd_wand.jsonl"

P="$HERE/profile_retention_png"
log "retention export_png (default routes)"
start_app "$ROOT" "$P" "$HERE/retention/app_png.log"
PX_PROBE_JSON="$HERE/retention/px_probe.jsonl" timeout 900 python "$ROOT/tools/px_probe.py" \
    --retention 15000x10000 \
    > "$HERE/retention/retention_png.log" 2>&1
log "rc=$?"
stop_app "$P"

for route_val in js rust; do
    P="$HERE/profile_retention_psd_$route_val"
    log "retention export_psd psdPartWasm=$route_val"
    start_app "$ROOT" "$P" "$HERE/retention/app_psd_${route_val}.log"
    PX_PROBE_JSON="$HERE/retention/psd_wand.jsonl" timeout 900 python "$HERE/retention_psd_wand.py" \
        15000x10000 --op export_psd --set "psdPartWasm=$route_val" \
        > "$HERE/retention/retention_psd_${route_val}.log" 2>&1
    log "rc=$?"
    stop_app "$P"
done

for route_val in js rust; do
    P="$HERE/profile_retention_wand_$route_val"
    log "retention wand_whole_picture stackIntoWasm=$route_val"
    start_app "$ROOT" "$P" "$HERE/retention/app_wand_${route_val}.log"
    PX_PROBE_JSON="$HERE/retention/psd_wand.jsonl" timeout 900 python "$HERE/retention_psd_wand.py" \
        15000x10000 --op wand_whole_picture --set "stackIntoWasm=$route_val" \
        > "$HERE/retention/retention_wand_${route_val}.log" 2>&1
    log "rc=$?"
    stop_app "$P"
done
release_lock

gpu
log "done"
