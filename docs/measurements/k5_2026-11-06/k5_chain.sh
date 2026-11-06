#!/usr/bin/env bash
# K5 of docs/PLAN_WASM_BUILD.md (§4.3, §7 "The order after Stop 1" #3): the selection rows before and after the kernels.
# Per round, each tool on a fresh instance (offline, tiles, its own profile; the window brought to the front by
# px_jobs itself):
#   native_test.py 15000x10000, profiled: grow_16 shrink_16 invert wand_whole_picture wand_whole_add wand_one_disc
#                  (the window's px bucket by function: combineRows, read, mul255, tileExtent)
#   px_jobs.py --split 15000x10000 --only wand_object,wand_band,wand_add,invert,grow,shrink,range_depth,
#                  range_depth_snap,range_luma (the legacy kernels flip, three rounds inside; PX_JOBS_JSON per run)
#                  [extra px_jobs arguments from $PXJOBS_EXTRA, e.g. --ab selCombine=js:rust after the build]
#   selection_test.py --only range_select_15k_tile_case,range_select_15k_luma_case (range in ms, the combine marks)
#   the perf gate perf:15000x10000 (its wand rows: "magic wand (whole-image band)", "(an object)")
# A px_jobs run NOT COUNTED (rc 2, the window behind) is tried again, up to three times.
# Usage: bash k5_chain.sh <outdir> [rounds]   (rounds "1 2 3" by default)
set -u
cd /f/canvas
OUTDIR="$1"; ROUNDS="${2:-1 2 3}"
mkdir -p "$OUTDIR/json" "$OUTDIR/pxjobs" "$OUTDIR/native" "$OUTDIR/selection"
export SCUMBLE_GATES="$OUTDIR/gates"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
gpu() { log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader); comfy 8188: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8188/system_stats)"; }
start_app() {   # $1 = the profile folder, $2 = the app log
    rm -rf "$1"; mkdir -p "$1"
    ./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir="$1" --no-comfy > "$2" 2>&1 &
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:9555/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 8
}
stop_app() {   # $1 = the profile folder
    grep -h "renderer ended" "$1/logs/scumble.log" >> "$OUTDIR/chain.log" 2>/dev/null
    SCUMBLE_CDP_PORT=9555 python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4
    rm -rf "$1"
}

log "commit $(git rev-parse --short HEAD); px ABI $(grep -o 'ABI = [0-9]*' renderer/editor/px/px.js | head -1)"
gpu
for R in $ROUNDS; do
    log "== round $R"
    P="$OUTDIR/profile_native_r$R"
    log "native r$R"
    gpu
    start_app "$P" "$OUTDIR/native/app_r$R.log"
    timeout 1800 python tools/native_test.py 15000x10000 --json "$OUTDIR/native/r$R.json" \
        grow_16 shrink_16 invert wand_whole_picture wand_whole_add wand_one_disc > "$OUTDIR/native/r$R.log" 2>&1
    log "rc=$?"
    stop_app "$P"

    P="$OUTDIR/profile_pxjobs_r$R"
    for try in 1 2 3; do
        log "pxjobs r$R (try $try) ${PXJOBS_EXTRA:-}"
        gpu
        start_app "$P" "$OUTDIR/pxjobs/app_r$R.log"
        # shellcheck disable=SC2086
        PX_JOBS_JSON="$OUTDIR/json/pxjobs_r$R.jsonl" timeout 3000 python tools/px_jobs.py --split ${PXJOBS_EXTRA:-} \
            --only wand_object,wand_band,wand_add,invert,grow,shrink,range_depth,range_depth_snap,range_luma \
            15000x10000 > "$OUTDIR/pxjobs/r$R.log" 2>&1
        rc=$?
        log "rc=$rc"
        stop_app "$P"
        [ "$rc" != 2 ] && break
    done

    P="$OUTDIR/profile_sel_r$R"
    log "selection r$R"
    start_app "$P" "$OUTDIR/selection/app_r$R.log"
    timeout 1800 python tools/selection_test.py --only range_select_15k_tile_case,range_select_15k_luma_case \
        > "$OUTDIR/selection/r$R.log" 2>&1
    log "rc=$?"
    stop_app "$P"

    log "perf r$R"
    gpu
    bash tools/run_gates.sh "k5-perf-r$R" --offline --tiles on "perf:15000x10000" >> "$OUTDIR/chain.log" 2>&1
    log "rc=$?"
    rm -rf "$OUTDIR/gates/profiles"
done
gpu
log "done"
