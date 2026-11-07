#!/usr/bin/env bash
# P18: shell.openSettings()'s time before (a tree at e9ab0d3) and after (the agent's worktree), each arm on a fresh
# instance (offline, tiles, its own profile, port 9603), five opens 6 s apart (p18_settings_open.py), two rounds in
# alternating order; the machine's busy lock (../w1_2026-11-06/w1_lock.py) held for the chain.
# Usage: bash p18_chain.sh <outdir> <before_tree> <after_tree>
set -u
OUTDIR="$1"; BEFORE="$2"; AFTER="$3"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$HERE/../w1_2026-11-06/w1_lock.py"
TOOLS="$AFTER/tools"
ELECTRON=/f/canvas/node_modules/electron/dist/electron.exe
PORT=9603
mkdir -p "$OUTDIR"; OUTDIR="$(cd "$OUTDIR" && pwd)"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
TOKEN=""
release() { [ -n "$TOKEN" ] && python "$LOCK" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1; TOKEN=""; }
trap release EXIT
TOKEN="$(python "$LOCK" acquire "P18 measuring (agent a24fab29)" 2>> "$OUTDIR/chain.log")"; LRC=$?
if [ $LRC -eq 0 ] && [ -n "$TOKEN" ]; then log "lock taken ($TOKEN)"
elif [ $LRC -eq 3 ]; then log "NOT LOCKED: measured while another agent held the lock"
else log "lock: acquire failed (rc=$LRC); stopping"; exit 1; fi
one() {   # $1 = arm, $2 = tree, $3 = round
    local d="$OUTDIR/$1" prof="$OUTDIR/$1/profile"
    mkdir -p "$d"; rm -rf "$prof"; mkdir -p "$prof"
    (cd "$2" && SCUMBLE_TILES=1 "$ELECTRON" . --remote-debugging-port=$PORT --user-data-dir="$prof" --no-comfy --tiles > "$d/app_r$3.log" 2>&1 &)
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 8
    SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 300 python "$HERE/p18_settings_open.py" 5 --json "$d/open_r$3.json" > "$d/open_r$3.log" 2>&1
    log "$1 r$3: rc=$? $(tail -1 "$d/open_r$3.log")"
    SCUMBLE_CDP_PORT=$PORT python "$TOOLS/close_app.py" >> "$OUTDIR/chain.log" 2>&1; sleep 4
    rm -rf "$prof"
}
log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader 2>/dev/null)"
one before "$BEFORE" 1; one after "$AFTER" 1; one after "$AFTER" 2; one before "$BEFORE" 2
log "done"
