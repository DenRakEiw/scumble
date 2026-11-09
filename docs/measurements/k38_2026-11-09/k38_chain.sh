#!/usr/bin/env bash
# K38 of docs/PLAN_WASM_BUILD.md (§4.11, question 6.4): matchCanvas CPU fallback (renderer/editor/inpaint_filters.js)
# routed through matchPixels in 4 MP (16,777,216-byte) chunks in place on ImageData.data's buffer.
# Before = a tree exported at HEAD 044b84c3 (after K37, before K38), after = this checkout;
# the two alternate within each round under w1_lock.py (released between rounds), each run on a fresh instance:
#   w0_bench.py --rows=match_fallback_16k,match_loop_4096 (4096x4096)
#   w0_bench.py --rows=match_fallback_16k --size=15000x10000 (15000x10000)
#   measure_k38.py (after tree: matchPixels=rust vs matchPixels=js + step breakdown at 4096x4096 and 15000x10000)
# Usage: bash k38_chain.sh <outdir> <before_tree> [rounds]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AFTER="$(cd "$HERE/../../.." && pwd)"
cd "$AFTER"
OUTDIR="$1"; BEFORE="$2"; ROUNDS="${3:-1 2 3}"
PORT="${SCUMBLE_CDP_PORT:-9619}"
W1LOCK="$AFTER/docs/measurements/w1_2026-11-06/w1_lock.py"
ELECTRON="$AFTER/node_modules/electron/dist/electron.exe"
MEASURE_SCRIPT="$HERE/measure_k38.py"
mkdir -p "$OUTDIR"
OUTDIR="$(cd "$OUTDIR" && pwd)"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }

TOKEN=""
release() {
    [ -n "$TOKEN" ] && python "$W1LOCK" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1
    TOKEN=""
    SCUMBLE_CDP_PORT=$PORT python "$AFTER/tools/close_app.py" >> "$OUTDIR/chain.log" 2>&1
}
trap release EXIT

log "after: $(git rev-parse --short HEAD) + working tree, px.wasm $(wc -c < "$AFTER/renderer/editor/px/px.wasm") B ($(sha256sum "$AFTER/renderer/editor/px/px.wasm" | cut -c1-16)), px_scalar.wasm $(wc -c < "$AFTER/renderer/editor/px/px_scalar.wasm") B"
log "before: $BEFORE, px.wasm $(wc -c < "$BEFORE/renderer/editor/px/px.wasm") B ($(sha256sum "$BEFORE/renderer/editor/px/px.wasm" | cut -c1-16)), px_scalar.wasm $(wc -c < "$BEFORE/renderer/editor/px/px_scalar.wasm") B"

start() {   # $1 = tree, $2 = profile, $3 = app log
    curl -s -m 2 http://127.0.0.1:$PORT/json/version > /dev/null && { log "an instance listens on $PORT: closing it"; SCUMBLE_CDP_PORT=$PORT python "$AFTER/tools/close_app.py" >> "$OUTDIR/chain.log" 2>&1; sleep 3; }
    rm -rf "$2"; mkdir -p "$2"
    (cd "$1" && SCUMBLE_TILES=1 "$ELECTRON" . --remote-debugging-port=$PORT --user-data-dir="$2" --no-comfy --tiles > "$3" 2>&1 &)
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 5
}
stop() {   # $1 = profile
    SCUMBLE_CDP_PORT=$PORT python "$AFTER/tools/close_app.py" >> "$OUTDIR/chain.log" 2>&1; sleep 3
    rm -rf "$1"
}
one() {   # $1 = arm (before / after), $2 = tree, $3 = round
    local arm="$1" tree="$2" R="$3" d="$OUTDIR/$1"
    mkdir -p "$d"
    start "$tree" "$d/profile" "$d/app_r$R.log"
    log "$arm r$R: w0_bench match_fallback_16k,match_loop_4096 (4096x4096)"
    (cd "$tree" && SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 600 python tools/w0_bench.py --rows=match_fallback_16k,match_loop_4096 --json "$d/w0_4096_r$R.json" > "$d/w0_4096_r$R.log" 2>&1)
    log "$arm r$R w0_4096 rc=$?"
    log "$arm r$R: w0_bench match_fallback_16k --size=15000x10000"
    (cd "$tree" && SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 600 python tools/w0_bench.py --rows=match_fallback_16k --size=15000x10000 --json "$d/w0_15k_r$R.json" > "$d/w0_15k_r$R.log" 2>&1)
    log "$arm r$R w0_15k rc=$?"
    if [ "$arm" = "after" ]; then
        log "$arm r$R: measure_k38.py (matchPixels=rust vs matchPixels=js + step breakdown)"
        (cd "$tree" && SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 600 python "$MEASURE_SCRIPT" "$R" "$d/ab_r$R.json" > "$d/ab_r$R.log" 2>&1)
        log "$arm r$R measure_k38 rc=$?"
    fi
    stop "$d/profile"
}

for R in $ROUNDS; do
    log "== round $R: acquiring busy lock"
    TOKEN="$(python "$W1LOCK" acquire "K38 measuring r$R (chain-f, port $PORT)" 2>> "$OUTDIR/chain.log")"; LRC=$?
    if [ $LRC -eq 0 ] && [ -n "$TOKEN" ]; then log "lock: taken ($TOKEN)"
    elif [ $LRC -eq 3 ]; then log "NOT LOCKED: measured while another agent held w1_lock"
    else log "lock: acquire failed (rc=$LRC); stopping"; exit 1; fi

    if [ $((R % 2)) -eq 1 ]; then
        one before "$BEFORE" "$R"
        one after "$AFTER" "$R"
    else
        one after "$AFTER" "$R"
        one before "$BEFORE" "$R"
    fi

    if [ -n "$TOKEN" ]; then
        python "$W1LOCK" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1
        log "lock: released ($TOKEN)"
        TOKEN=""
    fi
done

log "px_bench: PX_ONLY=matchTwin,match node tools/px_test.js"
(cd "$AFTER" && PX_ONLY=matchTwin,match node tools/px_test.js > "$OUTDIR/px_bench.txt" 2>&1)
log "done"
