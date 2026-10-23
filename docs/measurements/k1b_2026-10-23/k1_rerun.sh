#!/usr/bin/env bash
# K1b: the px_jobs runs of k1_chain.sh that px_jobs did not count (the window was behind), again, each up to three times.
# Usage: bash k1_rerun.sh <outdir> <label>=<args with + for spaces> ...
set -u
cd /f/canvas
OUTDIR="$1"; shift
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
for spec in "$@"; do
    label="${spec%%=*}"; args="${spec#*=}"; args="${args//+/ }"
    for try in 1 2 3; do
        prof="$OUTDIR/profile_$label"
        log "$label (again, try $try): px_jobs.py $args"
        mkdir -p "$prof"
        ./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir="$prof" --no-comfy > "$OUTDIR/pxjobs/app_$label.log" 2>&1 &
        for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:9555/json/version > /dev/null 2>&1 && break; sleep 1; done
        sleep 8
        PX_JOBS_JSON="$OUTDIR/json/$label.jsonl" timeout 3000 python tools/px_jobs.py $args > "$OUTDIR/pxjobs/$label.log" 2>&1
        rc=$?
        log "rc=$rc"
        SCUMBLE_CDP_PORT=9555 python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4
        rm -rf "$prof"
        [ "$rc" != 2 ] && break
    done
done
log "rerun done"
