#!/usr/bin/env bash
# K33 of docs/PLAN_WASM_BUILD.md: color_match_rgba and blend_alpha in Rust (crates/px/src/maskf.rs),
# routed under colorMatch and blendAlpha in renderer/editor/px/kernels.js.
# Before = a tree exported at HEAD cb9479ddbe (after K32, before K33), after = this worktree;
# the two alternate within each round, each run on a fresh instance (offline, tiles, its own profile, port 9615):
#   w0_bench.py --rows=stitch_align_2048,stitch_align_4096
#   native_test.py 15000x10000 --no-profile provider_crop (cold)
#   warm_native.py 15000x10000 --no-profile provider_crop (warmed by one untimed provider_crop run)
# Usage: bash k33_chain.sh <outdir> <before_tree> [rounds]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AFTER="$(cd "$HERE/../../.." && pwd)"
cd "$AFTER"
OUTDIR="$1"; BEFORE="$2"; ROUNDS="${3:-1 2 3}"
PORT="${SCUMBLE_CDP_PORT:-9615}"
W1LOCK="$AFTER/docs/measurements/w1_2026-11-06/w1_lock.py"
COORDLOCK="/f/canvas/.claude/coord/machine_busy.lock"
ELECTRON="$AFTER/node_modules/electron/dist/electron.exe"
WARM_SCRIPT="$HERE/warm_native.py"
mkdir -p "$OUTDIR"
OUTDIR="$(cd "$OUTDIR" && pwd)"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }

while [ -f "$COORDLOCK" ]; do
    log "waiting for $COORDLOCK"
    sleep 15
done
cat > "$COORDLOCK" <<EOF
CHAIN: chain-e
SESSION: K33
STARTED: $(date -u +%Y-%m-%dT%H:%M:%SZ)
HOLDING: benchmark
EOF

TOKEN=""
release() {
    rm -f "$COORDLOCK"
    [ -n "$TOKEN" ] && python "$W1LOCK" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1
    SCUMBLE_CDP_PORT=$PORT python "$AFTER/tools/close_app.py" >> "$OUTDIR/chain.log" 2>&1
}
trap release EXIT

TOKEN="$(python "$W1LOCK" acquire "K33 measuring (chain-e, port $PORT)" 2>> "$OUTDIR/chain.log")"; LRC=$?
if [ $LRC -eq 0 ] && [ -n "$TOKEN" ]; then log "lock: taken ($TOKEN) and $COORDLOCK written"
elif [ $LRC -eq 3 ]; then log "NOT LOCKED: measured while another agent held w1_lock"
else log "lock: acquire failed (rc=$LRC); stopping"; exit 1; fi

log "after: $(git rev-parse --short HEAD) + working tree, px.wasm $(wc -c < "$AFTER/renderer/editor/px/px.wasm") B ($(sha256sum "$AFTER/renderer/editor/px/px.wasm" | cut -c1-16)), px_scalar.wasm $(wc -c < "$AFTER/renderer/editor/px/px_scalar.wasm") B"
log "before: $BEFORE, px.wasm $(wc -c < "$BEFORE/renderer/editor/px/px.wasm") B ($(sha256sum "$BEFORE/renderer/editor/px/px.wasm" | cut -c1-16)), px_scalar.wasm $(wc -c < "$BEFORE/renderer/editor/px/px_scalar.wasm") B"

start() {   # $1 = tree, $2 = profile, $3 = app log
    curl -s -m 2 http://127.0.0.1:$PORT/json/version > /dev/null && { log "an instance listens on $PORT: closing it"; SCUMBLE_CDP_PORT=$PORT python "$AFTER/tools/close_app.py" >> "$OUTDIR/chain.log" 2>&1; sleep 4; }
    rm -rf "$2"; mkdir -p "$2"
    (cd "$1" && SCUMBLE_TILES=1 "$ELECTRON" . --remote-debugging-port=$PORT --user-data-dir="$2" --no-comfy --tiles > "$3" 2>&1 &)
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 8
}
stop() {   # $1 = profile
    SCUMBLE_CDP_PORT=$PORT python "$AFTER/tools/close_app.py" >> "$OUTDIR/chain.log" 2>&1; sleep 4
    rm -rf "$1"
}
one() {   # $1 = arm (before / after), $2 = tree, $3 = round
    local arm="$1" tree="$2" R="$3" d="$OUTDIR/$1"
    mkdir -p "$d"
    start "$tree" "$d/profile" "$d/app_w0_r$R.log"
    log "$arm r$R: w0_bench stitch_align_2048,stitch_align_4096"
    (cd "$tree" && SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 900 python tools/w0_bench.py --rows=stitch_align_2048,stitch_align_4096 --json "$d/w0_r$R.json" > "$d/w0_r$R.log" 2>&1)
    log "w0 rc=$?"
    stop "$d/profile"

    start "$tree" "$d/profile" "$d/app_native_r$R.log"
    log "$arm r$R: native_test 15000x10000 --no-profile provider_crop (cold)"
    (cd "$tree" && SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 900 python tools/native_test.py 15000x10000 --no-profile provider_crop --json "$d/native_r$R.json" > "$d/native_r$R.log" 2>&1)
    log "native rc=$?"
    stop "$d/profile"

    start "$tree" "$d/profile" "$d/app_native_warm_r$R.log"
    log "$arm r$R: warm_native 15000x10000 --no-profile provider_crop (warmed)"
    (cd "$tree" && SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 900 python "$WARM_SCRIPT" 15000x10000 --no-profile provider_crop --json "$d/native_warm_r$R.json" > "$d/native_warm_r$R.log" 2>&1)
    log "native_warm rc=$?"
    stop "$d/profile"
}

for R in $ROUNDS; do
    log "== round $R"
    if [ $((R % 2)) -eq 1 ]; then
        one before "$BEFORE" "$R"
        one after "$AFTER" "$R"
    else
        one after "$AFTER" "$R"
        one before "$BEFORE" "$R"
    fi
done

log "px_bench: PX_BENCH=1 PX_ONLY=mask node tools/px_test.js"
(cd "$AFTER" && PX_BENCH=1 PX_ONLY=mask node tools/px_test.js > "$OUTDIR/px_bench.txt" 2>&1)
log "done"
