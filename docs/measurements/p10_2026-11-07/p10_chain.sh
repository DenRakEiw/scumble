#!/usr/bin/env bash
# P10 of docs/PLAN_WASM_BUILD.md section 7 ("The user's answers after K4", item 3): the atlas slot's copy in 32-bit
# words (inpaint_tiles.js tileWithGutter). Before = a tree exported at e9ab0d3 (the byte loop), after = the agent's
# worktree; the two alternate within each round, each run on a fresh instance (offline, tiles, its own profile, port
# 9603; the harnesses bring the window to the front):
#   native_test.py 15000x10000 add_the_paint_layer pan_and_zoom   (profiled, as W0 / W0b: the row's wall, its frames
#                                                                  pan_fit / pan_1to1 / pan_1to1_far / zoom, and the
#                                                                  profile's self time of tileWithGutter's put)
#   perf_test.py 15000x10000                                       (pan at 1:1, first frame fit -> 1:1, the frame
#                                                                  after a whole change at 1:1, ...)
# The machine's busy lock (../w1_2026-11-06/w1_lock.py) is taken for each round and released after it, with a gap.
# Usage: bash p10_chain.sh <outdir> <before_tree> <after_tree> [rounds]   (rounds "1 2 3" by default)
set -u
OUTDIR="$1"; BEFORE="$2"; AFTER="$3"; ROUNDS="${4:-1 2 3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$HERE/../w1_2026-11-06/w1_lock.py"
TOOLS="$AFTER/tools"
ELECTRON=/f/canvas/node_modules/electron/dist/electron.exe
PORT=9603
mkdir -p "$OUTDIR"
OUTDIR="$(cd "$OUTDIR" && pwd)"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
TOKEN=""
release() { [ -n "$TOKEN" ] && python "$LOCK" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1; TOKEN=""; }
trap release EXIT

start() {   # $1 = tree, $2 = profile, $3 = app log
    curl -s -m 2 http://127.0.0.1:$PORT/json/version > /dev/null && { log "an instance listens on $PORT: closing it"; SCUMBLE_CDP_PORT=$PORT python "$TOOLS/close_app.py" >> "$OUTDIR/chain.log" 2>&1; sleep 4; }
    rm -rf "$2"; mkdir -p "$2"
    (cd "$1" && SCUMBLE_TILES=1 "$ELECTRON" . --remote-debugging-port=$PORT --user-data-dir="$2" --no-comfy --tiles > "$3" 2>&1 &)
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 8
}
stop() {   # $1 = profile
    SCUMBLE_CDP_PORT=$PORT python "$TOOLS/close_app.py" >> "$OUTDIR/chain.log" 2>&1; sleep 4
    rm -rf "$1"
}
one() {   # $1 = arm (before / after), $2 = tree, $3 = round
    local arm="$1" tree="$2" R="$3" d="$OUTDIR/$1"
    mkdir -p "$d"
    start "$tree" "$d/profile" "$d/app_native_r$R.log"
    log "$arm r$R: native_test add_the_paint_layer pan_and_zoom"
    SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 1200 python "$TOOLS/native_test.py" 15000x10000 --json "$d/native_r$R.json" add_the_paint_layer pan_and_zoom > "$d/native_r$R.log" 2>&1
    log "rc=$? $(grep -m1 'pan_and_zoom' "$d/native_r$R.log" | cut -c1-160)"
    stop "$d/profile"
    start "$tree" "$d/profile" "$d/app_perf_r$R.log"
    log "$arm r$R: perf_test 15000x10000"
    SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 1200 python "$TOOLS/perf_test.py" 15000x10000 --json="$d/perf_r$R.json" > "$d/perf_r$R.log" 2>&1
    log "rc=$?"
    stop "$d/profile"
}
log "after: $AFTER (e9ab0d3 + the P10 working tree); before: $BEFORE (e9ab0d3)"
for R in $ROUNDS; do
    TOKEN="$(python "$LOCK" acquire "P10 measuring (agent a24fab29) round $R" 2>> "$OUTDIR/chain.log")"; LRC=$?
    if [ $LRC -eq 0 ] && [ -n "$TOKEN" ]; then log "== round $R, lock taken ($TOKEN)"
    elif [ $LRC -eq 3 ]; then log "== round $R: NOT LOCKED, measured while another agent held the lock"
    else log "lock: acquire failed (rc=$LRC); stopping"; exit 1; fi
    log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader 2>/dev/null)"
    if [ $((R % 2)) -eq 1 ]; then one before "$BEFORE" "$R"; one after "$AFTER" "$R"; else one after "$AFTER" "$R"; one before "$BEFORE" "$R"; fi
    release
    log "round $R done, lock released; a gap of 90 s"
    sleep 90
done
log "done"
