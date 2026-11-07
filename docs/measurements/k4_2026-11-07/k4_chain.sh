#!/usr/bin/env bash
# K4 of docs/PLAN_WASM_BUILD.md: the generic box pass (crates/px/src/maskf.rs), box_blurs' bytes pinned.
# Per round a fresh instance (offline, tiles, its own profile, port 9555, the window brought to the front by w0_bench):
#   w0_bench.py --rows=stitch_masks_2048,box_blurs_k4   stitch.js gaussBlur on a 2048^2 mask (the whole function, the
#                  row that decides), box_blurs through kernels.js and its twin at the callers' sizes and the
#                  output checksums (the same before and after when the bytes are pinned), relight's height_normals
# Once per chain: node tools/px_test.js's box_blurs line (1492 x 1492, explains only).
# The machine's busy lock (../w1_2026-11-06/w1_lock.py) is held for the whole chain.
# Usage: bash k4_chain.sh <outdir> [rounds]   (rounds "1 2 3" by default)
set -u
cd /f/canvas
OUTDIR="$1"; ROUNDS="${2:-1 2 3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$HERE/../w1_2026-11-06/w1_lock.py"
mkdir -p "$OUTDIR"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
TOKEN=""
release() { [ -n "$TOKEN" ] && python "$LOCK" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1; }
trap release EXIT
TOKEN="$(python "$LOCK" acquire "K4 measuring" 2>> "$OUTDIR/chain.log")"; LRC=$?
if [ $LRC -eq 0 ] && [ -n "$TOKEN" ]; then log "lock: taken ($TOKEN)"
elif [ $LRC -eq 3 ]; then log "NOT LOCKED: measured while another agent held the lock"
else log "lock: acquire failed (rc=$LRC); stopping"; exit 1; fi
log "commit $(git rev-parse --short HEAD); px.wasm $(sha256sum renderer/editor/px/px.wasm | cut -c1-16), px_scalar.wasm $(sha256sum renderer/editor/px/px_scalar.wasm | cut -c1-16)"
log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader); comfy 8188: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8188/system_stats)"
node tools/px_test.js 2>&1 | grep -E "three box blurs|FAIL" > "$OUTDIR/px_test_box.txt"; log "px_test box line: $(head -c 300 "$OUTDIR/px_test_box.txt")"
for R in $ROUNDS; do
    P="$OUTDIR/profile_r$R"; rm -rf "$P"; mkdir -p "$P"
    curl -s -m 2 http://127.0.0.1:9555/json/version > /dev/null && { log "an instance listens on 9555: closing it"; SCUMBLE_CDP_PORT=9555 python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4; }
    SCUMBLE_TILES=1 ./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir="$P" --no-comfy --tiles > "$OUTDIR/app_r$R.log" 2>&1 &
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:9555/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 8
    log "round $R: w0_bench"
    SCUMBLE_CDP_PORT=9555 PYTHONIOENCODING=utf-8 timeout 900 python tools/w0_bench.py --rows=stitch_masks_2048,box_blurs_k4 --json "$OUTDIR/bench_r$R.json" > "$OUTDIR/bench_r$R.log" 2>&1
    log "rc=$?"
    SCUMBLE_CDP_PORT=9555 python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4
    rm -rf "$P"
done
log "done"
