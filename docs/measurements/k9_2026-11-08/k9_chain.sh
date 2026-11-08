#!/usr/bin/env bash
# K9 of docs/PLAN_WASM_BUILD.md (§4.3): flood_shape out_kind / cells, the alpha-tile cut, the grow / shrink cut.
# Before = a tree exported at 0117ba14 (wasm-kernels base), after = F:/canvas/.claude/worktrees/ag-chain-f working tree.
# The two alternate within each round (before/after in r1, after/before in r2, before/after in r3), each on a fresh
# Electron instance (offline, tiles, its own profile, port 9619; w1_lock.py held per timed batch and released between).
# Usage: bash k9_chain.sh <outdir> <before_tree> [rounds]   (rounds "1 2 3" by default)
set -u
REPO="/f/canvas/.claude/worktrees/ag-chain-f"
cd "$REPO"
OUTDIR="$1"; BEFORE="$2"; ROUNDS="${3:-1 2 3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$HERE/../w1_2026-11-06/w1_lock.py"
ELECTRON="/f/canvas/node_modules/electron/dist/electron.exe"
PORT=9619
mkdir -p "$OUTDIR/before" "$OUTDIR/after" "$BEFORE"
if [ ! -f "$BEFORE/renderer/editor/px/px.wasm" ]; then
    git archive --format=tar 0117ba14 | tar -x -C "$BEFORE"
fi
if [ ! -d "$BEFORE/node_modules" ]; then
    powershell -NoProfile -Command "New-Item -ItemType Junction -Path '$(cygpath -w "$BEFORE/node_modules")' -Target 'F:\canvas\node_modules' | Out-Null"
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
    TOKEN="$(python "$LOCK" acquire "K9 measuring ($1)" 2>> "$OUTDIR/chain.log")"; LRC=$?
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

acquire_batch "after check"
start_app "$REPO" "$OUTDIR/after/profile_check" "$OUTDIR/after/app_check.log"
log "after check: px_jobs --check --only wand_band,wand_object,wand_add,grow,shrink,invert 15000x10000"
(cd "$REPO" && SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 600 python tools/px_jobs.py --check --only wand_band,wand_object,wand_add,grow,shrink,invert 15000x10000 > "$OUTDIR/after/pxjobs_check.log" 2>&1)
log "after check: px_jobs --check rc=$?"
stop_app "$OUTDIR/after/profile_check"
release

one() {   # $1 = arm (before / after), $2 = tree, $3 = round
    local arm="$1" tree="$2" R="$3" d="$OUTDIR/$1"
    acquire_batch "$arm r$R"
    start_app "$tree" "$d/profile_r$R" "$d/app_r$R.log"

    log "$arm r$R: px_jobs 15000x10000"
    rm -f "$d/pxjobs_r$R.jsonl"
    (cd "$tree" && SCUMBLE_CDP_PORT=$PORT PX_JOBS_JSON="$d/pxjobs_r$R.jsonl" PYTHONIOENCODING=utf-8 timeout 900 python tools/px_jobs.py --rounds 1 --split --only wand_band,wand_object,wand_add,grow,shrink,invert 15000x10000 > "$d/pxjobs_r$R.log" 2>&1)
    log "$arm r$R: px_jobs rc=$?"

    log "$arm r$R: native_test 15000x10000"
    rm -f "$d/native_r$R.json"
    (cd "$tree" && SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 900 python tools/native_test.py --json "$d/native_r$R.json" 15000x10000 grow_16 shrink_16 wand_whole_picture wand_whole_add wand_one_disc > "$d/native_r$R.log" 2>&1)
    log "$arm r$R: native_test rc=$?"

    log "$arm r$R: perf_test 15000x10000"
    (cd "$tree" && SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 900 python tools/perf_test.py 15000x10000 > "$d/perf_r$R.log" 2>&1)
    log "$arm r$R: perf_test rc=$?"

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
