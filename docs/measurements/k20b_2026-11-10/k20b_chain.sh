#!/usr/bin/env bash
# K20b of docs/PLAN_WASM_BUILD.md (§4.7 K20b, §5 row 45) & docs/PLAN_WASM_K20.md (§2, §4.3):
# Rust PSD reader kernels (`packbits_rows`, `psd_mask_rgba`, planar 8/16-bit `tiff_to_rgba` SIMD128,
# 16-bit `tiff_unpredict` SIMD128), upfront channel/merged validation + 1-pass band-in-wasm `readPsdStream`,
# and single `psdRead` route inside `psd_read`.
#
# Runs under the machine's busy lock (docs/measurements/w1_2026-11-06/w1_lock.py, acquired and released per batch):
#   1. Node and Electron-as-Node kernel micro-benchmarks (`PX_ONLY=psd,tiff PX_BENCH=1 node tools/px_test.js`),
#      plus standalone 15,000 x 10,000 2-layer PSD SHA-256 parity + timing (`node tools/layered_test.js --twin-file`).
#   2. Three alternating rounds (r1..r3) of `native_test.py 15000x10000`
#      (`build_the_file open_the_file add_the_paint_layer export_psd open_psd close`) comparing clean `before` tree
#      at base `764fdffe` vs `after` tree (K20b), on fresh offline Electron instances (`--tiles on`, port 9621) with focus retry.
#   3. Three alternating rounds (r1..r3) of same-build route A/B (`--set psdRead=js` vs `--set psdRead=rust`) on
#      `native_test.py 15000x10000 build_the_file open_the_file add_the_paint_layer export_psd open_psd close`.
#   4. Three alternating rounds (r1..r3) of `tiff_test.py --size 15000x10000 --variant <v>` (`noise`, `own`),
#      comparing `before` vs `after`.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MAIN_REPO="$(git -C "$ROOT" worktree list --porcelain | head -n 1 | sed 's/^worktree //')"
LOCK="$ROOT/docs/measurements/w1_2026-11-06/w1_lock.py"
PORT="${SCUMBLE_CDP_PORT:-9621}"
BASE_SHA="764fdffe"
export SCUMBLE_CDP_PORT="$PORT"

mkdir -p "$HERE/before/native" "$HERE/after/native" \
         "$HERE/route_js/native" "$HERE/route_rust/native" \
         "$HERE/before/tiffperf" "$HERE/after/tiffperf" \
         "$HERE/node" "$HERE/notcounted"

BEFORE_TREE="$(dirname "$ROOT")/.tmp_k20b_before_$$"
TIFF_OUT="$(dirname "$ROOT")/.tmp_k20b_tiff_$$"
PSD_TMP="$(dirname "$ROOT")/.tmp_k20b_15k_$$.psd"
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
    rm -rf "$BEFORE_TREE" "$TIFF_OUT" "$PSD_TMP" "$HERE"/profile_* 2>/dev/null || true
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

for f in adobe_15000x10000_rows16.json noise_15000x10000.png; do
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

# 1. Node & Electron-as-Node kernel micro-benchmarks + 15k --twin-file parity
acquire_lock "K20b node_bench + 15k twin (chain-p)"
log "node px_test psd,tiff bench"
PX_ONLY=psd,tiff PX_BENCH=1 node "$ROOT/tools/px_test.js" > "$HERE/node/node_px_test.log" 2>&1
log "rc=$?"
log "electron-as-node px_test psd,tiff bench"
ELECTRON_RUN_AS_NODE=1 PX_ONLY=psd,tiff PX_BENCH=1 "$ROOT/node_modules/electron/dist/electron.exe" "$ROOT/tools/px_test.js" > "$HERE/node/electron_px_test.log" 2>&1
log "rc=$?"
log "building temporary 15000x10000 2-layer PSD for --twin-file"
node "$HERE/make_15k_psd.mjs" "$PSD_TMP" >> "$HERE/chain.log" 2>&1
log "rc=$?"
log "node tools/layered_test.js --twin-file 15k.psd"
node "$ROOT/tools/layered_test.js" --twin-file "$PSD_TMP" > "$HERE/node/twin_15k.log" 2>&1
log "rc=$?"
rm -f "$PSD_TMP"
release_lock
sleep 2

# 2. 15,000 x 10,000 native_test.py open_psd: 3 alternating rounds (before 764fdffe vs after K20b)
run_native_arm() {
    local arm="$1" r="$2" extra_route="${3:-}"
    local tree
    tree="$(tree_for_arm "$arm")"
    local P="$HERE/profile_native_${arm}_r$r"
    local jsonfile="$HERE/$arm/native/r$r.json"
    local logfile="$HERE/$arm/native/r$r.log"
    for try in 1 2 3; do
        log "native $arm r$r (try $try, route='${extra_route}', px.wasm $(sha256sum "$tree/renderer/editor/px/px.wasm" | cut -c1-12))"
        gpu
        start_app "$tree" "$P" "$HERE/$arm/native/app_r$r.log"
        if [ -n "$extra_route" ]; then
            timeout 1800 python "$ROOT/tools/native_test.py" 15000x10000 --set "$extra_route" --json "$jsonfile" \
                build_the_file open_the_file add_the_paint_layer export_psd open_psd close \
                > "$logfile" 2>&1
        else
            timeout 1800 python "$ROOT/tools/native_test.py" 15000x10000 --json "$jsonfile" \
                build_the_file open_the_file add_the_paint_layer export_psd open_psd close \
                > "$logfile" 2>&1
        fi
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focused": false' "$jsonfile" 2>/dev/null; then
            log "native $arm r$r NOT COUNTED (unfocused): try $try"
            mv "$jsonfile" "$HERE/notcounted/native_${arm}_r${r}_try${try}.json" 2>/dev/null || true
            mv "$logfile" "$HERE/notcounted/native_${arm}_r${r}_try${try}.log" 2>/dev/null || true
            continue
        fi
        break
    done
}

for R in 1 2 3; do
    acquire_lock "K20b native_test before/after r$R (chain-p)"
    log "== native_test before/after round $R"
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

# 3. Same-build 15,000 x 10,000 psdRead route A/B (--set psdRead=js vs --set psdRead=rust)
for R in 1 2 3; do
    acquire_lock "K20b psdRead route A/B r$R (chain-p)"
    log "== psdRead route A/B round $R"
    if [ $((R % 2)) -eq 1 ]; then
        run_native_arm route_js "$R" "psdRead=js"
        run_native_arm route_rust "$R" "psdRead=rust"
    else
        run_native_arm route_rust "$R" "psdRead=rust"
        run_native_arm route_js "$R" "psdRead=js"
    fi
    release_lock
    sleep 2
done

# 4. 15,000 x 10,000 tiff_test.py --variant noise,own (3 alternating rounds: before vs after)
run_tiff_arm() {
    local arm="$1" v="$2" r="$3"
    local tree
    tree="$(tree_for_arm "$arm")"
    local P="$HERE/profile_tiff_${arm}_${v}_r$r"
    local logfile="$HERE/$arm/tiffperf/${v}_r$r.log"
    for try in 1 2 3; do
        log "tiffperf $arm $v r$r (try $try)"
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
    for V in noise own; do
        acquire_lock "K20b tiffperf $V r$R (chain-p)"
        log "== tiffperf $V round $R"
        if [ $((R % 2)) -eq 1 ]; then
            run_tiff_arm before "$V" "$R"
            run_tiff_arm after "$V" "$R"
        else
            run_tiff_arm after "$V" "$R"
            run_tiff_arm before "$V" "$R"
        fi
        release_lock
        sleep 2
    done
done

log "K20b benchmark chain complete"
