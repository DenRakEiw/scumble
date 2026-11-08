#!/usr/bin/env bash
# A/B of the warpRgba route ALONE (WARP_ROUTE=js vs WARP_ROUTE=rust) on edgefit_2048, stitch_align_2048, stitch_align_4096
# across 3 alternating rounds on fresh Electron instances (port 9615) under w1_lock.py.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
OUTDIR="$HERE/warp_ab"
PORT="${SCUMBLE_CDP_PORT:-9615}"
W1LOCK="$ROOT/docs/measurements/w1_2026-11-06/w1_lock.py"
ELECTRON="$ROOT/node_modules/electron/dist/electron.exe"
mkdir -p "$OUTDIR"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }

TOKEN=""
release() {
    [ -n "$TOKEN" ] && python "$W1LOCK" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1
    TOKEN=""
    SCUMBLE_CDP_PORT=$PORT python "$ROOT/tools/close_app.py" >> "$OUTDIR/chain.log" 2>&1
}
trap release EXIT

start() {
    curl -s -m 2 http://127.0.0.1:$PORT/json/version > /dev/null && { SCUMBLE_CDP_PORT=$PORT python "$ROOT/tools/close_app.py" >> "$OUTDIR/chain.log" 2>&1; sleep 4; }
    rm -rf "$1"; mkdir -p "$1"
    (cd "$ROOT" && SCUMBLE_TILES=1 "$ELECTRON" . --remote-debugging-port=$PORT --user-data-dir="$1" --no-comfy --tiles > "$2" 2>&1 &)
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 8
}
stop() {
    SCUMBLE_CDP_PORT=$PORT python "$ROOT/tools/close_app.py" >> "$OUTDIR/chain.log" 2>&1; sleep 4
    rm -rf "$1"
}
one() {   # $1 = route (js / rust), $2 = round
    local route="$1" R="$2" d="$OUTDIR/$1"
    mkdir -p "$d"
    start "$d/profile" "$d/app_w0_r$R.log"
    log "warpRgba=$route r$R: w0_bench edgefit_2048,stitch_align_2048,stitch_align_4096"
    WARP_ROUTE="$route" SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 900 python "$HERE/warp_ab.py" --rows=edgefit_2048,stitch_align_2048,stitch_align_4096 --json "$d/w0_r$R.json" > "$d/w0_r$R.log" 2>&1
    log "w0 rc=$?"
    stop "$d/profile"
}

for R in 1 2 3; do
    log "== round $R: acquiring busy lock"
    TOKEN="$(python "$W1LOCK" acquire "K34 warpRgba A/B r$R (chain-e, port $PORT)" 2>> "$OUTDIR/chain.log")"; LRC=$?
    if [ $LRC -eq 0 ] && [ -n "$TOKEN" ]; then log "lock: taken ($TOKEN)"
    elif [ $LRC -eq 3 ]; then log "NOT LOCKED: measured while another agent held w1_lock"
    else log "lock: acquire failed (rc=$LRC); stopping"; exit 1; fi

    if [ $((R % 2)) -eq 1 ]; then
        one js "$R"
        one rust "$R"
    else
        one rust "$R"
        one js "$R"
    fi

    if [ -n "$TOKEN" ]; then
        python "$W1LOCK" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1
        log "lock: released ($TOKEN)"
        TOKEN=""
    fi
done
log "done"
