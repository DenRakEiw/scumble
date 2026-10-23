#!/usr/bin/env bash
# K0c of PLAN_WASM_BUILD: the W0b baseline on one build. Every row of W0 (plan §2), K0a and K0b, three rounds, each
# group on a fresh instance (offline, tiles, the window in front); then docperf, mem and huge once, and the Node bench.
# Big files go to dist/ (w0b_tiff_files, w0b_native_files, w0_files), never into this folder.
# Usage: bash w0b_chain.sh <outdir> [rounds] [once]   (rounds: "1 2 3" by default; once: "yes" by default)
set -u
cd /f/canvas
OUTDIR="$1"; ROUNDS="${2:-1 2 3}"; ONCE="${3:-yes}"
mkdir -p "$OUTDIR"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }

start_app() {   # $1 = a label, $2 = the round's folder
    local prof="$2/profile_$1"
    rm -rf "$prof"; mkdir -p "$prof"
    ./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir="$prof" --no-comfy > "$2/app_$1.log" 2>&1 &
    for i in $(seq 1 120); do
        curl -s -m 1 http://127.0.0.1:9555/json/version > /dev/null 2>&1 && break
        sleep 1
    done
    sleep 8
}
stop_app() {
    grep -h "renderer ended" "$2/profile_$1/logs/scumble.log" >> "$OUTDIR/chain.log" 2>/dev/null
    SCUMBLE_CDP_PORT=9555 python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4
    rm -rf "$2/profile_$1"
}
gate() {   # $1 = the round's folder, $2 = a label, $3 = the gate
    SCUMBLE_GATES="$1/gates" bash tools/run_gates.sh "$2" --offline --tiles on "$3" >> "$OUTDIR/chain.log" 2>&1
    rm -rf "$1/gates/profiles"
}

for R in $ROUNDS; do
    D="$OUTDIR/r$R"; mkdir -p "$D/native" "$D/bench" "$D/brush" "$D/liquify"
    log "== round $R"
    log "gates: perf, perf relight, exportperf (depth limit; fill limit), edges"
    gate "$D" perf "perf:15000x10000"
    gate "$D" perf-relight "perf:15000x10000,--filter=relight,--map=4096x2731"
    gate "$D" exportperf-limit "exportperf:15000x10000,--limit=depth:0.2:0.6:0.05:0.05"
    gate "$D" exportperf-fill "exportperf:15000x10000,--fill-limit"
    gate "$D" edges "edges"
    for v in noise own lzw packbits zlib1 raw; do
        log "tiffperf $v"
        gate "$D" "tiff-$v" "tiffperf:15000x10000,--variant,$v,--out,/f/canvas/dist/w0b_tiff_files"
    done

    log "native: the default rows"
    start_app native "$D"
    python tools/native_test.py 15000x10000 --json "$D/native/default.json" > "$D/native/default.log" 2>&1; log "rc=$?"
    stop_app native "$D"
    log "native: filter_wand"
    start_app native_filter "$D"
    python tools/native_test.py 15000x10000 --json "$D/native/filter.json" add_the_paint_layer wand_whole_picture filter_wand > "$D/native/filter.log" 2>&1; log "rc=$?"
    stop_app native_filter "$D"
    log "native: K0a's rows (real saves but the PSD's, which ends the renderer; the layered and TIFF opens)"
    start_app native_k0a "$D"
    python tools/native_test.py 15000x10000 --json "$D/native/k0a.json" --out /f/canvas/dist/w0b_native_files \
        add_the_paint_layer export_png export_psd export_ora save_png save_tiff save_ora open_psd open_ora open_tiff > "$D/native/k0a.log" 2>&1; log "rc=$?"
    stop_app native_k0a "$D"
    rm -rf /f/canvas/dist/w0b_native_files

    log "px_jobs 15k (three rounds inside)"
    start_app pxjobs "$D"
    python tools/px_jobs.py --rounds 3 15000x10000 > "$D/pxjobs_15k.log" 2>&1; log "rc=$?"
    stop_app pxjobs "$D"
    log "selection: the two 15k range cases"
    start_app selection "$D"
    python tools/selection_test.py --only range_select_15k_tile_case,range_select_15k_luma_case > "$D/selection_15k.log" 2>&1; log "rc=$?"
    stop_app selection "$D"

    log "w0_bench: W0's rows"
    start_app bench_w0 "$D"
    python tools/w0_bench.py --json "$D/bench/w0_rows.json" --rows=edgefit_2048,stitch_masks_2048,crc32_64mb,dabs_256,match_loop_4096,histogram_depth,freqsep_15k > "$D/bench/w0_rows.log" 2>&1; log "rc=$?"
    stop_app bench_w0 "$D"
    log "w0_bench: K0a's rows"
    start_app bench_k0a "$D"
    python tools/w0_bench.py --json "$D/bench/k0a_rows.json" \
        --rows=files_15k,jpeg_open_15k,png_inflate_15k,png_filter_types,tiff_inflate_15k,tiff_rows_256 > "$D/bench/k0a_rows.log" 2>&1; log "rc=$?"
    stop_app bench_k0a "$D"
    for r in freqsep_4000 stitch_align_2048 stitch_align_4096 match_fallback_16k grow_fallback_15k; do
        log "w0_bench $r"
        start_app "bench_$r" "$D"
        python tools/w0_bench.py --json "$D/bench/$r.json" --rows=$r > "$D/bench/$r.log" 2>&1; log "rc=$?"
        stop_app "bench_$r" "$D"
    done

    for t in blur sharpen tone sponge smudge clone heal; do
        log "brush_perf $t"
        start_app "brush_$t" "$D"
        if [ "$t" = smudge ] || [ "$t" = clone ] || [ "$t" = heal ]; then P="{\"TOOLS\": [\"$t\"]}"; else P="{\"TOOLS\": [\"$t\"], \"SIZES\": [50, 200, 400, 1000]}"; fi
        (cd "$D/brush" && python /f/canvas/tools/brush_perf.py "$P" > "$t.log" 2>&1); log "rc=$?"
        [ -f "$D/brush/brush_perf.out.json" ] && mv "$D/brush/brush_perf.out.json" "$D/brush/$t.json"
        stop_app "brush_$t" "$D"
    done
    for k in rust js; do
        log "liquify_perf $k"
        start_app "liquify_$k" "$D"
        (cd "$D/liquify" && python /f/canvas/tools/brush_perf.py "{\"KERNELS\": \"$k\"}" liquify_perf.js > "$k.log" 2>&1); log "rc=$?"
        [ -f "$D/liquify/brush_perf.out.json" ] && mv "$D/liquify/brush_perf.out.json" "$D/liquify/$k.json"
        stop_app "liquify_$k" "$D"
    done
done

if [ "$ONCE" = yes ]; then
    D="$OUTDIR/once"; mkdir -p "$D"
    log "== once: docperf, mem, huge, the Node bench"
    gate "$D" docperf "docperf:15000x10000"
    gate "$D" mem "mem:15000x10000,--rounds,3"
    gate "$D" huge "huge:30000x20000"
    log "px_test PX_BENCH=large"
    PX_BENCH=large node tools/px_test.js > "$D/px_bench_large.log" 2>&1; log "rc=$?"
fi
rm -rf /f/canvas/dist/w0b_tiff_files
log "done"
