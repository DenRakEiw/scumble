#!/usr/bin/env bash
# K0a's check run (PLAN_WASM_BUILD): the gates the change touches, then the new harness rows once at 15k.
# Usage: bash k0a_chain.sh <outdir> [gates|tiff|native|bench|all]
set -u
cd /f/canvas
OUTDIR="$1"; WHAT="${2:-all}"
mkdir -p "$OUTDIR"
export SCUMBLE_GATES="$OUTDIR/gates"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }

start_app() {
    local prof="$OUTDIR/profile_$1"
    rm -rf "$prof"; mkdir -p "$prof"
    ./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir="$prof" --no-comfy > "$OUTDIR/app_$1.log" 2>&1 &
    for i in $(seq 1 120); do
        curl -s -m 1 http://127.0.0.1:9555/json/version > /dev/null 2>&1 && break
        sleep 1
    done
    sleep 8
}
stop_app() { SCUMBLE_CDP_PORT=9555 python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4; }

if [ "$WHAT" = all ] || [ "$WHAT" = gates ]; then
    log "gates lint types (no app)"
    bash tools/run_gates.sh k0a-static lint types >> "$OUTDIR/chain.log" 2>&1
    log "gates tiff export layered pxjobs (tiles, offline)"
    bash tools/run_gates.sh k0a-gates --offline --tiles on tiff export layered pxjobs >> "$OUTDIR/chain.log" 2>&1
fi
if [ "$WHAT" = all ] || [ "$WHAT" = tiff ]; then
    for v in noise own lzw packbits zlib1 raw; do
        log "tiffperf 15k, variant $v (a fresh instance; the files shared in tiff_files)"
        bash tools/run_gates.sh "k0a-tiff-$v" --offline --tiles on "tiffperf:15000x10000,--variant,$v,--out,$OUTDIR/tiff_files" >> "$OUTDIR/chain.log" 2>&1
    done
fi
if [ "$WHAT" = all ] || [ "$WHAT" = native ]; then
    log "native_test 15k (export rows, real saves, layered and TIFF opens)"
    start_app native
    python tools/native_test.py 15000x10000 --json "$OUTDIR/native_15k.json" --out "$OUTDIR/native_files" \
        add_the_paint_layer export_png export_psd export_ora save_png save_psd save_tiff save_ora open_psd open_ora open_tiff > "$OUTDIR/native_15k.log" 2>&1
    log "native rc=$?"
    stop_app
fi
if [ "$WHAT" = all ] || [ "$WHAT" = bench ]; then
    log "w0_bench K0a rows"
    start_app bench
    python tools/w0_bench.py --json "$OUTDIR/w0_bench_k0a.json" --files "$OUTDIR/w0_files" \
        --rows=files_15k,jpeg_open_15k,png_inflate_15k,tiff_inflate_15k,tiff_rows_256,png_filter_types > "$OUTDIR/w0_bench_k0a.log" 2>&1
    log "w0_bench rc=$?"
    stop_app
fi
log "done"
