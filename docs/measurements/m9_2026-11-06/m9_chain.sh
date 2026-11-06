#!/usr/bin/env bash
# #0 of PLAN_WASM_BUILD §7 "The order after Stop 1": K1's M9 (docs/PLAN_WASM_K1.md §3) and the second open.
#   M9-M3: px_jobs --only wand_object,wand_band,wand_add --split, no --ab (the legacy kernels flip: "rust" is the
#          app's default, now keepMB 16), three fresh runs
#   M9-M4: px_jobs --only flood_ladder --split, no --ab, three fresh runs
#   mem:15000x10000,--rounds,3 once (K0c's form), against K0c's "+354 MB" GPU-process line
#   native_test open_again: the 15k file opened twice in one instance (the second into a new tab), three fresh
#          instances, then one restart on the third run's profile (its disk caches warm), the same rows
# Offline, tiles, each run a fresh instance with its own profile; px_jobs brings the window to the front itself and a
# run it did not count (rc 2, the window behind) is tried again, up to three times. Big files stay out of this folder.
# Usage: bash m9_chain.sh <outdir>
set -u
cd /f/canvas
OUTDIR="$1"
mkdir -p "$OUTDIR/json" "$OUTDIR/pxjobs" "$OUTDIR/native"
export SCUMBLE_GATES="$OUTDIR/gates"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
gpu() { log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader); comfy 8188: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8188/system_stats)"; }
start_app() {   # $1 = the profile folder, $2 = the app log
    ./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir="$1" --no-comfy > "$2" 2>&1 &
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:9555/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 8
}
stop_app() {
    SCUMBLE_CDP_PORT=9555 python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4
}
pxjobs() {   # $1 = a label, the rest px_jobs.py's arguments
    local label="$1"; shift
    local prof="$OUTDIR/profile_$label" rc=2
    for try in 1 2 3; do
        log "$label (try $try): px_jobs.py $*"
        gpu
        rm -rf "$prof"; mkdir -p "$prof"
        start_app "$prof" "$OUTDIR/pxjobs/app_$label.log"
        PX_JOBS_JSON="$OUTDIR/json/$label.jsonl" timeout 3000 python tools/px_jobs.py "$@" > "$OUTDIR/pxjobs/$label.log" 2>&1
        rc=$?
        log "rc=$rc"
        stop_app
        rm -rf "$prof"
        [ "$rc" != 2 ] && break
    done
}
native() {   # $1 = a label, $2 = the profile folder (kept when $3 is "keep")
    log "$1: native_test.py 15000x10000 open_again"
    gpu
    start_app "$2" "$OUTDIR/native/app_$1.log"
    timeout 1800 python tools/native_test.py 15000x10000 --json "$OUTDIR/native/$1.json" open_again > "$OUTDIR/native/$1.log" 2>&1
    log "rc=$?"
    stop_app
    [ "${3:-}" = keep ] || rm -rf "$2"
}

gpu
for r in 1 2 3; do
    pxjobs "m9-m3-r$r" --only wand_object,wand_band,wand_add --split 15000x10000
    pxjobs "m9-m4-r$r" --only flood_ladder --split 15000x10000
done
log "mem:15000x10000,--rounds,3"
gpu
bash tools/run_gates.sh m9-mem --offline --tiles on "mem:15000x10000,--rounds,3" >> "$OUTDIR/chain.log" 2>&1
rm -rf "$OUTDIR/gates/profiles"
for r in 1 2; do
    P="$OUTDIR/profile_native_r$r"; rm -rf "$P"; mkdir -p "$P"
    native "open2-r$r" "$P"
done
P="$OUTDIR/profile_native_r3"; rm -rf "$P"; mkdir -p "$P"
native "open2-r3" "$P" keep
native "open2-restart" "$P"
gpu
log "done"
