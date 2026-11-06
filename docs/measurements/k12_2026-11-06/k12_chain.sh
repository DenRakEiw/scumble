#!/usr/bin/env bash
# K12 of docs/PLAN_WASM_BUILD.md (§4.5, the order row "K12", Stop 5): relight's march rows before and after the stripes.
# Per round one fresh instance (run_gates.sh: offline, tiles, its own profile on port 9555) running
#   perf:15000x10000,--filter=relight,--map=4096x2731   (tools/perf_test.py; its JSON beside the log, PERF_JSON)
# Its rows: one light moved, three lights moved, a drag step's quick map, a pan at 1:1 during a march, the first march
# after start; the stripes' rows and their parallel efficiency (a K12 build); the whole-change chain rows (pinned in
# K12: the paint layer active, the setup's marches landed), the lights overlay's read, and a whole change at 1:1 with no
# march and during a three-light march.
# Before each run: the machine's busy lock (../w1_2026-11-06/w1_lock.py, its own token; another holder: wait every 30 s,
# at most 60 min, then go on and log NOT LOCKED), then no other agent's gate run (k12_others.py: run_gates, _test.py or an
# instance on 9572-9579; every 30 s, at most 60 min); the GPU's use before and after; the lock released right after the
# run (also on failure). A run whose window was not focused and visible (perf_test.py exits 2, NOT COUNTED) is moved to
# notcounted/ and tried again, up to three times.
# Usage: bash k12_chain.sh <outdir> [rounds]   (rounds "1 2 3" by default)
set -u
cd /f/canvas
OUTDIR="$1"; ROUNDS="${2:-1 2 3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$HERE/../w1_2026-11-06/w1_lock.py"
mkdir -p "$OUTDIR/perf"
export SCUMBLE_GATES="$OUTDIR/gates"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
# the user's ComfyUI is only read (GET /system_stats, /queue), never queued, freed or stopped
cq() { curl -s -m 3 http://127.0.0.1:8188/queue 2>/dev/null | python -c "import json,sys; d=json.load(sys.stdin); print('queue', len(d.get('queue_running',[])), 'running,', len(d.get('queue_pending',[])), 'pending')" 2>/dev/null || echo "no queue"; }
gpu() { log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader); comfy 8188: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8188/system_stats), $(cq)"; }
TOKEN=""
release() { if [ -n "$TOKEN" ]; then python "$LOCK" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1; TOKEN=""; fi; }
trap release EXIT
take() {
    TOKEN="$(python "$LOCK" acquire "K12 measuring" 2>> "$OUTDIR/chain.log")"; local rc=$?
    if [ $rc -eq 0 ] && [ -n "$TOKEN" ]; then log "lock: taken ($TOKEN)"
    elif [ $rc -eq 3 ]; then TOKEN=""; log "NOT LOCKED: measured while another agent held the lock (its holder in the lock line above)"
    else TOKEN=""; log "lock: acquire failed (rc=$rc); stopping"; exit 1; fi
    python "$HERE/k12_others.py" wait >> "$OUTDIR/chain.log" 2>&1 || log "OTHERS BUSY: measured while another agent's gate run went on (above)"
}

log "commit $(git rev-parse --short HEAD) (dirty: $(git status --short renderer tools crates | wc -l) files); px ABI $(grep -o 'ABI = [0-9]*' renderer/editor/px/px.js | head -1); rounds: $ROUNDS"
log "px.wasm $(sha256sum renderer/editor/px/px.wasm | cut -c1-16), px_scalar.wasm $(sha256sum renderer/editor/px/px_scalar.wasm | cut -c1-16)"
for R in $ROUNDS; do
    for try in 1 2 3; do
        take
        log "perf-relight r$R (try $try)"
        gpu
        G="$OUTDIR/gates/gates/k12-relight-r$R"
        PERF_JSON="$OUTDIR/perf/r$R.json" bash tools/run_gates.sh "k12-relight-r$R" --offline --tiles on \
            "perf:15000x10000,--filter=relight,--map=4096x2731" >> "$OUTDIR/chain.log" 2>&1
        log "rc=$?"
        gpu
        release
        rm -rf "$OUTDIR/gates/profiles"
        cp "$G/perf.log" "$OUTDIR/perf/r$R.log" 2>/dev/null
        if grep -q "NOT COUNTED" "$G/perf.log" 2>/dev/null; then
            log "perf r$R NOT COUNTED (the window behind): kept in notcounted/ as r${R}_try$try"
            mkdir -p "$OUTDIR/notcounted"; mv "$G" "$OUTDIR/notcounted/r${R}_try$try"
            mv "$OUTDIR/perf/r$R.json" "$OUTDIR/notcounted/r${R}_try$try.json" 2>/dev/null
            rm -f "$OUTDIR/perf/r$R.log"
            continue
        fi
        break
    done
done
log "done"
