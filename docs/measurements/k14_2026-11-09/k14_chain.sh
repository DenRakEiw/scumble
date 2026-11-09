#!/usr/bin/env bash
# K14 of docs/PLAN_WASM_BUILD.md (§4.5): shadow_march_f64 y-march precompute + sun route + f32 shadow_march removal.
# Four 15,000 x 10,000 relight arms (before, after_scalar, after_lanes, after_js) on port 9631 under the busy lock:
#   - before:       a tree exported at 9a5f1681 (wasm-kernels base before K14)
#   - after_scalar: shipped K14 tree (march_pixel_scalar + iy_rows/max_steps y precompute, no f64x2 lanes)
#   - after_lanes:  2-lane f64x2 SIMD + iy_rows/max_steps y precompute candidate (removed per K14-T1 after losing to after_scalar)
#   - after_js:     working tree copy with shadowMarch: "js" in DEFAULT_ROUTES (hoisted V8 f64 twin)
# Usage: bash k14_chain.sh <outdir> <before_tree> <after_js_tree> <after_lanes_tree>
set -eo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
OUT="${1:-$HERE}"
BEFORE="${2:-C:/Users/schoeneberg/AppData/Local/Temp/k14_before}"
AFTER_JS="${3:-C:/Users/schoeneberg/AppData/Local/Temp/k14_after_js}"
AFTER_LANES="${4:-C:/Users/schoeneberg/AppData/Local/Temp/k14_after_lanes}"
GATES_DIR="$REPO/dist/gates"
LOCK_PY="$HERE/../w1_2026-11-06/w1_lock.py"
mkdir -p "$OUT" "$GATES_DIR"

CUR_TOK=""
cleanup() {
    if [ -n "$CUR_TOK" ]; then
        python "$LOCK_PY" release "$CUR_TOK" || true
        CUR_TOK=""
    fi
    SCUMBLE_CDP_PORT=9631 python "$REPO/tools/close_app.py" >/dev/null 2>&1 || true
}
trap cleanup EXIT

acquire_lock() {
    local reason="$1"
    CUR_TOK="$(python "$LOCK_PY" acquire "$reason" | tr -d '\r')"
    if [ -z "$CUR_TOK" ]; then
        echo "ERROR: lock not acquired for $reason" >&2
        exit 3
    fi
}

run_one() {
    local dir="$1"
    local name="$2"
    local r="$3"
    local label="k14-${name}-r${r}"
    mkdir -p "$OUT/$name/perf"
    (
        cd "$dir"
        SCUMBLE_GATES="$GATES_DIR" SCUMBLE_CDP_PORT=9631 PERF_JSON="$OUT/$name/perf/r${r}.json" \
            bash tools/run_gates.sh "$label" --offline "perf:15000x10000,--filter=relight,--map=4096x2731"
    )
    cp "$GATES_DIR/gates/$label/perf.log" "$OUT/$name/perf/r${r}.log"
    SCUMBLE_CDP_PORT=9631 python "$REPO/tools/close_app.py" >/dev/null 2>&1 || true
}

# Round 1: before, after_scalar, after_lanes, after_js
acquire_lock "chain-l K14 r1"
run_one "$BEFORE" "before" 1
run_one "$REPO" "after_scalar" 1
run_one "$AFTER_LANES" "after_lanes" 1
run_one "$AFTER_JS" "after_js" 1
python "$LOCK_PY" release "$CUR_TOK"
CUR_TOK=""

# Round 2: after_scalar, after_lanes, after_js, before
acquire_lock "chain-l K14 r2"
run_one "$REPO" "after_scalar" 2
run_one "$AFTER_LANES" "after_lanes" 2
run_one "$AFTER_JS" "after_js" 2
run_one "$BEFORE" "before" 2
python "$LOCK_PY" release "$CUR_TOK"
CUR_TOK=""

# Round 3: after_js, before, after_scalar, after_lanes
acquire_lock "chain-l K14 r3"
run_one "$AFTER_JS" "after_js" 3
run_one "$BEFORE" "before" 3
run_one "$REPO" "after_scalar" 3
run_one "$AFTER_LANES" "after_lanes" 3
python "$LOCK_PY" release "$CUR_TOK"
CUR_TOK=""
