#!/usr/bin/env bash
# fix-filter: exportperf:15000x10000,--filter=film.look before (base 2068af87) and after (worktree),
# three alternating rounds on port 9627 (--offline, --tiles on), acquiring and releasing the machine
# busy lock around each round.
# Usage: bash measure_exportperf.sh <outdir> <before_tree> <after_tree>
set -u
OUTDIR="$1"; BEFORE="$2"; AFTER="$3"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$HERE/../w1_2026-11-06/w1_lock.py"
PORT=9627
mkdir -p "$OUTDIR"; OUTDIR="$(cd "$OUTDIR" && pwd)"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
TOKEN=""
release() { [ -n "$TOKEN" ] && python "$LOCK" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1; TOKEN=""; }
trap release EXIT

one() {   # $1 = arm, $2 = tree, $3 = round
    local label="fix-filter-${1}-r${3}"
    TOKEN="$(python "$LOCK" acquire "fix-filter measuring ($1 r$3)" 2>> "$OUTDIR/chain.log")"; local lrc=$?
    if [ $lrc -eq 0 ] && [ -n "$TOKEN" ]; then log "lock taken ($TOKEN)"
    elif [ $lrc -eq 3 ]; then log "NOT LOCKED: measured while another agent held the lock"
    else log "lock: acquire failed (rc=$lrc); stopping"; exit 1; fi

    local gsp="F:/canvas/.claude/worktrees/ag-fix-filter/dist/gates"
    (cd "$2" && SCUMBLE_CDP_PORT=$PORT SCUMBLE_GATES="$gsp" bash tools/run_gates.sh "$label" --offline --tiles on "exportperf:15000x10000,--filter=film.look" > "$OUTDIR/${1}_r${3}_runner.log" 2>&1)
    local rc=$?
    cp "$gsp/gates/$label/exportperf.log" "$OUTDIR/${1}_r${3}.json" 2>/dev/null || true
    log "$1 r$3: rc=$rc"
    release
}

log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader 2>/dev/null)"
one before "$BEFORE" 1
one after  "$AFTER"  1
one after  "$AFTER"  2
one before "$BEFORE" 2
one before "$BEFORE" 3
one after  "$AFTER"  3
log "done"
