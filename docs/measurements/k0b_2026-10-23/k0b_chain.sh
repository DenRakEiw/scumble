#!/usr/bin/env bash
# K0b's run (PLAN_WASM_BUILD): the new harness rows once at 15k, each group on a fresh instance (offline, tiles).
# The gates ran before, through tools/run_gates.sh (gates/). Usage: bash k0b_chain.sh <outdir> [group ...]
# Groups: native native_filter perf_relight pxjobs selection exportperf bench brush liquify pxbench (default: all)
set -u
cd /f/canvas
OUTDIR="$1"; shift
GROUPS_="${*:-native native_filter perf_relight pxjobs selection exportperf bench brush liquify pxbench}"
mkdir -p "$OUTDIR"
export SCUMBLE_GATES="$OUTDIR/gates"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
want() { case " $GROUPS_ " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

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
stop_app() {
    grep -h "renderer ended" "$OUTDIR/profile_$1/logs/scumble.log" >> "$OUTDIR/chain.log" 2>/dev/null
    SCUMBLE_CDP_PORT=9555 python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4
    rm -rf "$OUTDIR/profile_$1"
}

if want native; then
    log "native_test 15k, the default rows (wand_whole_add, the px split by function, the counters, bucket_fill last)"
    start_app native
    python tools/native_test.py 15000x10000 --json "$OUTDIR/native/native_15k.json" > "$OUTDIR/native/native_15k.log" 2>&1
    log "native rc=$?"
    stop_app native
fi
if want native_filter; then
    log "native_test 15k, filter_wand (the program marks)"
    start_app native_filter
    python tools/native_test.py 15000x10000 --json "$OUTDIR/native/native_filter_15k.json" add_the_paint_layer wand_whole_picture filter_wand > "$OUTDIR/native/native_filter_15k.log" 2>&1
    log "native_filter rc=$?"
    stop_app native_filter
fi
if want perf_relight; then
    log "perf 15k with relight, map 4096x2731 (the relight_maps rows)"
    bash tools/run_gates.sh k0b-perf-relight --offline --tiles on "perf:15000x10000,--filter=relight,--map=4096x2731" >> "$OUTDIR/chain.log" 2>&1
fi
if want pxjobs; then
    log "px_jobs 15k, three rounds (the rows of 4.3 / 4.8 beside the old ones)"
    start_app pxjobs
    python tools/px_jobs.py --rounds 3 15000x10000 > "$OUTDIR/pxjobs_15k.log" 2>&1
    log "pxjobs rc=$?"
    stop_app pxjobs
fi
if want selection; then
    log "selection_test: the two 15k range cases (ms, range_select jobs, marks)"
    start_app selection
    python tools/selection_test.py --only range_select_15k_tile_case,range_select_15k_luma_case > "$OUTDIR/selection/selection_15k.log" 2>&1
    log "selection rc=$?"
    stop_app selection
fi
if want exportperf; then
    log "exportperf 15k with a fill layer and a depth limit"
    bash tools/run_gates.sh k0b-exportperf-fill --offline --tiles on "exportperf:15000x10000,--fill-limit" >> "$OUTDIR/chain.log" 2>&1
fi
if want bench; then
    for r in freqsep_4000 stitch_align_2048 stitch_align_4096 edgefit_2048 match_fallback_16k grow_fallback_15k; do
        log "w0_bench $r (a fresh instance)"
        start_app "bench_$r"
        python tools/w0_bench.py --json "$OUTDIR/bench/$r.json" --rows=$r > "$OUTDIR/bench/$r.log" 2>&1
        log "w0_bench $r rc=$?"
        stop_app "bench_$r"
    done
fi
if want brush; then
    for t in blur sharpen tone sponge; do
        log "brush_perf 15k, $t (a fresh instance)"
        start_app "brush_$t"
        (cd "$OUTDIR/brush" && python /f/canvas/tools/brush_perf.py "{\"TOOLS\": [\"$t\"], \"SIZES\": [50, 200, 400, 1000]}" > "brush_$t.log" 2>&1)
        log "brush $t rc=$?"
        [ -f "$OUTDIR/brush/brush_perf.out.json" ] && mv "$OUTDIR/brush/brush_perf.out.json" "$OUTDIR/brush/brush_$t.json"
        stop_app "brush_$t"
    done
fi
if want liquify; then
    for k in rust js; do
        log "liquify_perf 15k, KERNELS $k (a fresh instance)"
        start_app "liquify_$k"
        (cd "$OUTDIR/liquify" && python /f/canvas/tools/brush_perf.py "{\"KERNELS\": \"$k\"}" liquify_perf.js > "liquify_$k.log" 2>&1)
        log "liquify $k rc=$?"
        [ -f "$OUTDIR/liquify/brush_perf.out.json" ] && mv "$OUTDIR/liquify/brush_perf.out.json" "$OUTDIR/liquify/liquify_$k.json"
        stop_app "liquify_$k"
    done
fi
if want pxbench; then
    log "px_test with PX_BENCH=large (Node: the medians and the cold first calls; explain, never decide)"
    PX_BENCH=large node tools/px_test.js > "$OUTDIR/px_bench_large.log" 2>&1
    log "px_bench rc=$?"
fi
log "done"
