#!/usr/bin/env bash
# K39 alternating before/after measurement runner (docs/PLAN_WASM_BUILD.md §4.3, K39).
# Usage: bash docs/measurements/k39_2026-11-09/k39_chain.sh <out_dir> <before_tree> [rounds]
set -euo pipefail

OUT="${1:?usage: k39_chain.sh <out_dir> <before_tree> [rounds]}"
BEFORE="${2:?usage: k39_chain.sh <out_dir> <before_tree> [rounds]}"
ROUNDS="${3:-1 2 3}"
AFTER="$(pwd)"
PORT="${SCUMBLE_CDP_PORT:-9619}"
ELECTRON="$AFTER/node_modules/electron/dist/electron.exe"

mkdir -p "$OUT/before" "$OUT/after"

start_app() {
    local tree="$1"
    local prof="$OUT/prof_${2}"
    rm -rf "$prof"
    mkdir -p "$prof"
    SCUMBLE_Wait=0 "$ELECTRON" "$tree" \
        --remote-debugging-port="$PORT" \
        --user-data-dir="$prof" \
        --no-comfy \
        --tiles \
        >/dev/null 2>&1 &
    APP_PID=$!
    for _ in $(seq 1 60); do
        if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
            sleep 1
            return 0
        fi
        sleep 0.5
    done
    echo "ERROR: Electron failed to listen on port $PORT" >&2
    return 1
}

stop_app() {
    if [[ -n "${APP_PID:-}" ]]; then
        kill "$APP_PID" >/dev/null 2>&1 || true
        wait "$APP_PID" >/dev/null 2>&1 || true
        APP_PID=""
    fi
    rm -rf "$OUT"/prof_* 2>/dev/null || true
    sleep 1
}
trap stop_app EXIT

run_arm() {
    local arm="$1"
    local r="$2"
    local tree="$3"
    echo "=== Round $r: $arm ==="
    start_app "$tree" "${arm}_r${r}"
    SCUMBLE_CDP_PORT="$PORT" python "$AFTER/docs/measurements/k39_2026-11-09/measure_k39.py" \
        --mode="$arm" \
        --json "$OUT/$arm/e2e_r${r}.json" \
        | tee "$OUT/$arm/e2e_r${r}.log"
    stop_app

    start_app "$tree" "${arm}_w0_r${r}"
    SCUMBLE_CDP_PORT="$PORT" python "$AFTER/tools/w0_bench.py" \
        --rows=grow_fallback_15k \
        --json "$OUT/$arm/w0_15k_r${r}.json" \
        | tee "$OUT/$arm/w0_15k_r${r}.log"
    stop_app
}

for r in $ROUNDS; do
    if (( r % 2 == 1 )); then
        run_arm before "$r" "$BEFORE"
        run_arm after  "$r" "$AFTER"
    else
        run_arm after  "$r" "$AFTER"
        run_arm before "$r" "$BEFORE"
    fi
done

echo "=== Node px_test route + job ==="
PX_ONLY=route,job node "$AFTER/tools/px_test.js" | tee "$OUT/px_bench.txt"
echo "ALL ROUNDS DONE"
