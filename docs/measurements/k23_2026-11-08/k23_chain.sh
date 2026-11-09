#!/usr/bin/env bash
# K23 of docs/PLAN_WASM_BUILD.md (§4.8): range_tiles_rgba (luma & colour, crates/px/src/range.rs).
# Before = a tree exported at 13d32fa8 (ag-chain-m-3 tip before K23), after = F:/canvas/.claude/worktrees/ag-chain-m working tree.
# The two alternate within each round (before/after in r1, after/before in r2, before/after in r3), each on a fresh
# Electron instance (offline, tiles, its own profile, port 9613; w1_lock.py held per timed batch and released between).
# Usage: bash k23_chain.sh <outdir> <before_tree> [rounds]   (rounds "1 2 3" by default)
set -u
REPO="/f/canvas/.claude/worktrees/ag-chain-m"
cd "$REPO"
OUTDIR="$1"; BEFORE="$2"; ROUNDS="${3:-1 2 3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$HERE/../w1_2026-11-06/w1_lock.py"
ELECTRON="/f/canvas/node_modules/electron/dist/electron.exe"
PORT=9613
mkdir -p "$OUTDIR/before" "$OUTDIR/after" "$BEFORE"
if [ ! -f "$BEFORE/renderer/editor/px/px.wasm" ]; then
    git archive --format=tar 13d32fa8 | tar -x -C "$BEFORE"
fi
if [ ! -e "$BEFORE/node_modules" ]; then
    python -c "import subprocess, os, sys; subprocess.run(['cmd', '/c', 'mklink', '/J', os.path.abspath(sys.argv[1]), r'F:\canvas\node_modules'], check=True)" "$BEFORE/node_modules"
fi
OUTDIR="$(cd "$OUTDIR" && pwd)"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
TOKEN=""
release() {
    if [ -n "$TOKEN" ]; then
        python "$LOCK" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1
        TOKEN=""
    fi
}
trap release EXIT

acquire_batch() {
    TOKEN="$(python "$LOCK" acquire "K23 measuring ($1)" 2>> "$OUTDIR/chain.log")"; LRC=$?
    if [ $LRC -eq 0 ] && [ -n "$TOKEN" ]; then log "lock: taken ($TOKEN) for $1"
    elif [ $LRC -eq 3 ]; then log "NOT LOCKED: measured while another agent held the lock ($1)"
    else log "lock: acquire failed (rc=$LRC); stopping"; exit 1; fi
}

log "after: $(git rev-parse --short HEAD) + working tree, px.wasm $(sha256sum renderer/editor/px/px.wasm | cut -c1-16), px_scalar.wasm $(sha256sum renderer/editor/px/px_scalar.wasm | cut -c1-16)"
log "before: $BEFORE, px.wasm $(sha256sum "$BEFORE/renderer/editor/px/px.wasm" | cut -c1-16)"
log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader); comfy 8188: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8188/system_stats)"

start_app() {   # $1 = tree, $2 = profile, $3 = app log
    curl -s -m 2 http://127.0.0.1:$PORT/json/version > /dev/null && { log "an instance listens on $PORT: closing it"; SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4; }
    rm -rf "$2"; mkdir -p "$2"
    (cd "$1" && SCUMBLE_TILES=1 "$ELECTRON" . --remote-debugging-port=$PORT --user-data-dir="$2" --no-comfy --tiles > "$3" 2>&1 &)
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 6
}

stop_app() {   # $1 = profile
    SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 3
    rm -rf "$1"
}

if [ "$ROUNDS" = "sel" ]; then
    d="$OUTDIR/after"
    for R in 1 2 3; do
        acquire_batch "after sel r$R"
        start_app "$REPO" "$d/profile_sel_r$R" "$d/app_sel_r$R.log"
        log "after r$R: selection_test 15000x10000"
        (cd "$REPO" && SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 600 python tools/selection_test.py --range-size 15000x10000 --only range_select_luma_color_cases,range_select_15k_luma_case > "$d/selection_r$R.log" 2>&1)
        log "after r$R: selection_test rc=$?"
        stop_app "$d/profile_sel_r$R"
        release
    done
    log "done sel"
    exit 0
fi

acquire_batch "px_test range bench"
PX_BENCH=1 PX_ONLY=range node tools/px_test.js > "$OUTDIR/after/px_test_range_bench.txt" 2>&1
log "px_test range bench rc=$?"
release

acquire_batch "after check 2048x1152"
start_app "$REPO" "$OUTDIR/after/profile_check" "$OUTDIR/after/app_check.log"
rm -f "$OUTDIR/after/pxjobs_check.jsonl"
(cd "$REPO" && SCUMBLE_CDP_PORT=$PORT PX_JOBS_JSON="$OUTDIR/after/pxjobs_check.jsonl" PYTHONIOENCODING=utf-8 timeout 300 python tools/px_jobs.py --check --only range_luma,range_color 2048x1152 > "$OUTDIR/after/pxjobs_check.log" 2>&1)
log "after check 2048x1152 rc=$?"
stop_app "$OUTDIR/after/profile_check"
release

one() {   # $1 = arm (before / after), $2 = tree, $3 = round
    local arm="$1" tree="$2" R="$3" d="$OUTDIR/$1"
    acquire_batch "$arm r$R"
    start_app "$tree" "$d/profile_r$R" "$d/app_r$R.log"

    log "$arm r$R: px_jobs 15000x10000"
    rm -f "$d/pxjobs_r$R.jsonl"
    (cd "$tree" && SCUMBLE_CDP_PORT=$PORT PX_JOBS_JSON="$d/pxjobs_r$R.jsonl" PYTHONIOENCODING=utf-8 timeout 900 python tools/px_jobs.py --rounds 1 --split --only range_luma,range_color 15000x10000 > "$d/pxjobs_r$R.log" 2>&1)
    log "$arm r$R: px_jobs rc=$?"

    if [ "$arm" = "after" ]; then
        log "$arm r$R: px_jobs --ab rangeLuma=js:rust 15000x10000"
        rm -f "$d/ab_luma_r$R.jsonl"
        (cd "$tree" && SCUMBLE_CDP_PORT=$PORT PX_JOBS_JSON="$d/ab_luma_r$R.jsonl" PYTHONIOENCODING=utf-8 timeout 900 python tools/px_jobs.py --rounds 3 --split --ab rangeLuma=js:rust --only range_luma 15000x10000 > "$d/ab_luma_r$R.log" 2>&1)
        log "$arm r$R: px_jobs ab_luma rc=$?"

        log "$arm r$R: px_jobs --ab rangeColor=js:rust 15000x10000"
        rm -f "$d/ab_color_r$R.jsonl"
        (cd "$tree" && SCUMBLE_CDP_PORT=$PORT PX_JOBS_JSON="$d/ab_color_r$R.jsonl" PYTHONIOENCODING=utf-8 timeout 900 python tools/px_jobs.py --rounds 3 --split --ab rangeColor=js:rust --only range_color 15000x10000 > "$d/ab_color_r$R.log" 2>&1)
        log "$arm r$R: px_jobs ab_color rc=$?"
    fi

    log "$arm r$R: selection_test 15000x10000"
    (cd "$tree" && SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 600 python tools/selection_test.py --range-size 15000x10000 --only range_select_luma_color_cases,range_select_15k_luma_case > "$d/selection_r$R.log" 2>&1)
    log "$arm r$R: selection_test rc=$?"

    stop_app "$d/profile_r$R"
    release
}

for R in $ROUNDS; do
    log "== round $R"
    if [ $((R % 2)) -eq 1 ]; then
        one before "$BEFORE" "$R"
        one after "$REPO" "$R"
    else
        one after "$REPO" "$R"
        one before "$BEFORE" "$R"
    fi
done
log "done"
