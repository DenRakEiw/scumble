#!/usr/bin/env bash
# K27 of docs/PLAN_WASM_BUILD.md: the tone brush (tone_rgba), the sponge (sponge_rgba) and frequency separation's split
# (freq_split, with the blur in one arena) in Rust. Before = a tree exported at 8729426 (the base: K26's Rust blur, the
# twins for tone, sponge and the split on the window), after = this worktree at its commit; the two alternate within
# each round, each run on a fresh instance (offline, tiles, its own profile, port 9605; the harnesses bring the window
# to the front):
#   brush_perf.py {"TOOLS":["tone"],"SIZES":[400,1000]}      ms per move at fit and 1:1 on 15000 x 10000 (the row that
#   brush_perf.py {"TOOLS":["sponge"],"SIZES":[400,1000]}    decides), the dab, the press, the window's px calls
#   w0_bench.py --rows=freqsep_4000                           frequency separation of a 4000 x 4000 box of the 15k photo,
#                                                             the window's px instance before and after
# and once per round in the after arm, on its own instance, w0_bench.py --rows=dabs_k27 (the kernel rows: Rust against
# the twins in one instance, for the tie rule of section 1.1). The machine's busy lock (../w1_2026-11-06/w1_lock.py) is
# held for the whole chain.
# Usage: bash k27_chain.sh <outdir> <before_tree> [rounds]   (rounds "1 2 3" by default)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AFTER="$(cd "$HERE/../../.." && pwd)"
cd "$AFTER"
OUTDIR="$1"; BEFORE="$2"; ROUNDS="${3:-1 2 3}"
LOCK="$HERE/../w1_2026-11-06/w1_lock.py"
ELECTRON=/f/canvas/node_modules/electron/dist/electron.exe
IMAGE=F:/canvas/dist/daily/adobe_15000x10000.jpg
PORT=9605
mkdir -p "$OUTDIR"
OUTDIR="$(cd "$OUTDIR" && pwd)"   # absolute: start() cds into the tree under test before it writes the app log
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
TOKEN=""
release() { [ -n "$TOKEN" ] && python "$LOCK" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1; }
trap release EXIT
TOKEN="$(python "$LOCK" acquire "K27 measuring" 2>> "$OUTDIR/chain.log")"; LRC=$?
if [ $LRC -eq 0 ] && [ -n "$TOKEN" ]; then log "lock: taken ($TOKEN)"
elif [ $LRC -eq 3 ]; then log "NOT LOCKED: measured while another agent held the lock"
else log "lock: acquire failed (rc=$LRC); stopping"; exit 1; fi
log "after: $AFTER at $(git rev-parse --short HEAD), px.wasm $(sha256sum renderer/editor/px/px.wasm | cut -c1-16); before: $BEFORE px.wasm $(sha256sum "$BEFORE/renderer/editor/px/px.wasm" | cut -c1-16)"
log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader); comfy 8188: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8188/system_stats)"

start() {   # $1 = tree, $2 = profile, $3 = app log
    curl -s -m 2 http://127.0.0.1:$PORT/json/version > /dev/null && { log "an instance listens on $PORT: closing it"; SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4; }
    rm -rf "$2"; mkdir -p "$2"
    (cd "$1" && SCUMBLE_TILES=1 "$ELECTRON" . --remote-debugging-port=$PORT --user-data-dir="$2" --no-comfy --tiles > "$3" 2>&1 &)
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 8
}
stop() {   # $1 = profile
    SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4
    rm -rf "$1"
}
one() {   # $1 = arm (before / after), $2 = tree, $3 = round
    local arm="$1" tree="$2" R="$3" d="$OUTDIR/$1"
    mkdir -p "$d/run"
    for tool in tone sponge; do
        start "$tree" "$d/profile" "$d/app_${tool}_r$R.log"
        log "$arm r$R: brush_perf $tool"
        (cd "$d/run" && SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 1500 python "$AFTER/tools/brush_perf.py" "{\"TOOLS\":[\"$tool\"],\"SIZES\":[400,1000]}" > "../brush_${tool}_r$R.log" 2>&1; echo "rc=$?" >> "../brush_${tool}_r$R.log"; mv brush_perf.out.json "../brush_${tool}_r$R.json" 2>/dev/null)
        log "$(tail -1 "$d/brush_${tool}_r$R.log")"
        stop "$d/profile"
    done
    start "$tree" "$d/profile" "$d/app_freqsep_r$R.log"
    log "$arm r$R: w0_bench freqsep_4000"
    SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 900 python tools/w0_bench.py --rows=freqsep_4000 --image=$IMAGE --json "$d/freqsep_r$R.json" > "$d/freqsep_r$R.log" 2>&1
    log "rc=$?"
    stop "$d/profile"
    if [ "$arm" = after ]; then
        start "$tree" "$d/profile" "$d/app_dabs_r$R.log"
        log "$arm r$R: w0_bench dabs_k27"
        SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 900 python tools/w0_bench.py --rows=dabs_k27 --json "$d/dabs_r$R.json" > "$d/dabs_r$R.log" 2>&1
        log "rc=$?"
        stop "$d/profile"
    fi
}
for R in $ROUNDS; do
    log "== round $R"
    if [ $((R % 2)) -eq 1 ]; then one before "$BEFORE" "$R"; one after "$AFTER" "$R"; else one after "$AFTER" "$R"; one before "$BEFORE" "$R"; fi
done
log "done"
