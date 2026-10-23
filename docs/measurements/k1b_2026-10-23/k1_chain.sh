#!/usr/bin/env bash
# K1b of PLAN_WASM_BUILD: the measurements of docs/PLAN_WASM_K1.md §3 (M0-M5, M7, M8; M6 only on M5's word). px_jobs runs
# straight on a fresh instance (run_gates.sh turns every comma into a space, which splits an --only list); the probes
# and M8 through run_gates.sh. Offline, tiles, the window brought to the front by each harness; PX_JOBS_JSON per run.
# Usage: bash k1_chain.sh <outdir> [m0] (m0: the V8 flag listing too)
set -u
cd /f/canvas
OUTDIR="$1"; M0="${2:-}"
mkdir -p "$OUTDIR/json" "$OUTDIR/pxjobs"
export SCUMBLE_GATES="$OUTDIR/gates"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
gate() {   # $1 = a label, $2 = the gate
    log "$1: $2"
    PX_JOBS_JSON="$OUTDIR/json/$1.jsonl" bash tools/run_gates.sh "$1" --offline --tiles on "$2" >> "$OUTDIR/chain.log" 2>&1
    rm -rf "$OUTDIR/gates/profiles"
}
pxjobs() {   # $1 = a label, the rest px_jobs.py's arguments
    local label="$1"; shift
    local prof="$OUTDIR/profile_$label"
    log "$label: px_jobs.py $*"
    rm -rf "$prof"; mkdir -p "$prof"
    ./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir="$prof" --no-comfy > "$OUTDIR/pxjobs/app_$label.log" 2>&1 &
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:9555/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 8
    PX_JOBS_JSON="$OUTDIR/json/$label.jsonl" timeout 3000 python tools/px_jobs.py "$@" > "$OUTDIR/pxjobs/$label.log" 2>&1
    log "rc=$?"
    SCUMBLE_CDP_PORT=9555 python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4
    rm -rf "$prof"
}

if [ -n "$M0" ]; then
    log "M0: the versions and V8's wasm flags (no app)"
    E=node_modules/electron/dist/electron.exe
    ELECTRON_RUN_AS_NODE=1 "$E" -p "JSON.stringify(process.versions)" > "$OUTDIR/versions.txt" 2>&1
    ELECTRON_RUN_AS_NODE=1 "$E" --v8-options > "$OUTDIR/v8_options_all.txt" 2>&1
    grep -iE "wasm.*(tier|liftoff|lazy|cache|turbo)" "$OUTDIR/v8_options_all.txt" > "$OUTDIR/v8_options.txt"
    rm -f "$OUTDIR/v8_options_all.txt"
fi

ONLY1=mips_direct,mips_whole,band,wand_band,wand_object
for r in 1 2 3; do
    pxjobs "k1-m1-r$r" --only "$ONLY1" 15000x10000
    pxjobs "k1-m1s-r$r" --only "$ONLY1" --split 15000x10000
    pxjobs "k1-m2-r$r" --ab mips=js:rust --only mips_direct,mips_whole --split 15000x10000
    pxjobs "k1-m3-r$r" --ab flood=js:rust --only wand_object,wand_band,wand_add --split 15000x10000
    pxjobs "k1-m4-r$r" --ab flood=js:rust --only flood_ladder --split 15000x10000
    gate "k1-m5-r$r" "pxprobe:--cold,--rotation,$r"
done
gate "k1-m7a" "pxprobe:--regrow"
for k in 16 32 64 128 256; do
    gate "k1-m7b-$k" "pxprobe:--retention,15000x10000,--keep-mb,$k"
done
log "M8: the window's release (the pxjobs gate's check run)"
gate "k1-m8" "pxjobs"
grep -h "window_release\|window release" "$OUTDIR/gates/gates/k1-m8/pxjobs.log" > "$OUTDIR/window_release.txt" 2>/dev/null
log "done"
