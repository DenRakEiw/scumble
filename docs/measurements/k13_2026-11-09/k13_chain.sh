#!/usr/bin/env bash
# K13 of docs/PLAN_WASM_BUILD.md (§4.5): shadow_march_f64 scalar, per-tap constants, twin's hoist, and marchGuardOk.
# Before = a tree exported at 3fd8bda7 (wasm-kernels base before K13), after = repository root working tree.
# The two alternate within each round (before/after in r1, after/before in r2, before/after in r3), each on a fresh
# Electron instance (run_gates.sh: offline, tiles on, its own profile, port 9631) running
#   perf:15000x10000,--filter=relight,--map=4096x2731   (tools/perf_test.py; PERF_JSON beside the log)
# Before each run: the machine's busy lock (../w1_2026-11-06/w1_lock.py) is acquired per batch and released right after
# the run (also on failure). A run whose window was not focused and visible (perf_test.py exits 2, NOT COUNTED) is moved
# to notcounted/ and tried again, up to three times.
# Usage: bash k13_chain.sh <outdir> <before_tree> [rounds]   (rounds "1 2 3" by default)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"
OUTDIR="$1"; BEFORE="$2"; ROUNDS="${3:-1 2 3}"
LOCK="$HERE/../w1_2026-11-06/w1_lock.py"
PORT=9631
mkdir -p "$OUTDIR/before/perf" "$OUTDIR/after/perf" "$BEFORE"
if [ ! -f "$BEFORE/renderer/editor/px/px.wasm" ]; then
    git archive --format=tar 3fd8bda7 | tar -x -C "$BEFORE"
fi
if [ ! -e "$BEFORE/node_modules" ]; then
    python -c "import subprocess, os, sys; subprocess.run(['cmd', '/c', 'mklink', '/J', os.path.abspath(sys.argv[1]), r'F:\canvas\node_modules'], check=True)" "$BEFORE/node_modules"
fi
OUTDIR="$(cd "$OUTDIR" && pwd)"
BEFORE="$(cd "$BEFORE" && pwd)"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
cq() { curl -s -m 3 http://127.0.0.1:8188/queue 2>/dev/null | python -c "import json,sys; d=json.load(sys.stdin); print('queue', len(d.get('queue_running',[])), 'running,', len(d.get('queue_pending',[])), 'pending')" 2>/dev/null || echo "no queue"; }
gpu() { log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader); comfy 8188: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8188/system_stats), $(cq)"; }
TOKEN=""
release() {
    if [ -n "$TOKEN" ]; then
        python "$LOCK" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1
        TOKEN=""
    fi
}
trap release EXIT

take() {
    TOKEN="$(python "$LOCK" acquire "K13 measuring ($1)" 2>> "$OUTDIR/chain.log")"; local rc=$?
    if [ $rc -eq 0 ] && [ -n "$TOKEN" ]; then log "lock: taken ($TOKEN)"
    elif [ $rc -eq 3 ]; then TOKEN=""; log "NOT LOCKED: measured while another agent held the lock ($1)"
    else TOKEN=""; log "lock: acquire failed (rc=$rc); stopping"; exit 1; fi
}

log "after: $(git rev-parse --short HEAD) + working tree (dirty: $(git status --short renderer tools crates | wc -l) files); px ABI $(grep -o 'ABI = [0-9]*' renderer/editor/px/px.js | head -1); rounds: $ROUNDS"
log "after px.wasm $(sha256sum renderer/editor/px/px.wasm | cut -c1-16), px_scalar.wasm $(sha256sum renderer/editor/px/px_scalar.wasm | cut -c1-16)"
log "before: $BEFORE (3fd8bda7), px.wasm $(sha256sum "$BEFORE/renderer/editor/px/px.wasm" | cut -c1-16), px_scalar.wasm $(sha256sum "$BEFORE/renderer/editor/px/px_scalar.wasm" | cut -c1-16)"

one() {   # $1 = arm (before / after), $2 = tree, $3 = round
    local arm="$1" tree="$2" R="$3" d="$OUTDIR/$1"
    for try in 1 2 3; do
        take "$arm r$R (try $try)"
        log "perf-relight $arm r$R (try $try)"
        gpu
        local G="$d/gates/gates/k13-$arm-r$R"
        (cd "$tree" && SCUMBLE_CDP_PORT=$PORT SCUMBLE_GATES="$d/gates" PERF_JSON="$d/perf/r$R.json" \
            bash tools/run_gates.sh "k13-$arm-r$R" --offline --tiles on \
            "perf:15000x10000,--filter=relight,--map=4096x2731" >> "$OUTDIR/chain.log" 2>&1)
        log "rc=$?"
        gpu
        release
        rm -rf "$d/gates/profiles"
        cp "$G/perf.log" "$d/perf/r$R.log" 2>/dev/null
        if grep -q "NOT COUNTED" "$G/perf.log" 2>/dev/null; then
            log "perf $arm r$R NOT COUNTED (the window behind): kept in notcounted/ as r${R}_try$try"
            mkdir -p "$d/notcounted"
            mv "$G" "$d/notcounted/r${R}_try$try"
            mv "$d/perf/r$R.json" "$d/notcounted/r${R}_try$try.json" 2>/dev/null
            rm -f "$d/perf/r$R.log"
            continue
        fi
        break
    done
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
