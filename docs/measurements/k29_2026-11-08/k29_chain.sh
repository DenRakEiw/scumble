#!/usr/bin/env bash
# K29 of docs/PLAN_WASM_BUILD.md: liquify's live preview kernel (liquify_preview in crates/px/src/resample.rs, ABI 26),
# with the window kept in px.alloc memory and a dab after a 2 s pause (§7 row 40).
# Three rounds on 15000 x 10000 (grid step 4), the arms alternating within each round (before = ROUTES
# {"liquifyPreview":"js"} first in rounds 1 and 3, after = ROUTES {"liquifyPreview":"rust"} first in round 2; IE.kernels
# stays "rust" in both arms), each arm on a fresh instance (offline, tiles, its own profile, port 9617; brush_perf.py
# brings the window to the front). The machine's busy lock is held for the whole chain.
# Usage: bash k29_chain.sh <outdir> [rounds]   (rounds "1 2 3" by default)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
OUTDIR="${1:-$HERE/ab}"; ROUNDS="${2:-1 2 3}"
ELECTRON=/f/canvas/node_modules/electron/dist/electron.exe
PORT=9617
mkdir -p "$OUTDIR"
OUTDIR="$(cd "$OUTDIR" && pwd)"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
log "tree: $ROOT at $(git rev-parse --short HEAD), px.wasm $(sha256sum renderer/editor/px/px.wasm | cut -c1-16), px_scalar.wasm $(sha256sum renderer/editor/px/px_scalar.wasm | cut -c1-16)"

start() {   # $1 = profile, $2 = app log
    curl -s -m 2 http://127.0.0.1:$PORT/json/version > /dev/null && { log "an instance listens on $PORT: closing it"; SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4; }
    rm -rf "$1"; mkdir -p "$1"
    (cd "$ROOT" && SCUMBLE_TILES=1 "$ELECTRON" . --remote-debugging-port=$PORT --user-data-dir="$1" --no-comfy --tiles > "$2" 2>&1 &)
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 8
}
stop() {   # $1 = profile
    SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4
    rm -rf "$1"
}
one() {   # $1 = arm (before / after), $2 = route ("js" / "rust"), $3 = round
    local arm="$1" route="$2" R="$3" d="$OUTDIR/$1"
    mkdir -p "$d/run"
    start "$d/profile" "$d/app_r$R.log"
    log "$arm r$R: liquify_perf ROUTES.liquifyPreview=$route"
    (cd "$d/run" && SCUMBLE_CDP_PORT=$PORT PYTHONIOENCODING=utf-8 timeout 1500 python "$ROOT/tools/brush_perf.py" "{\"ROUTES\":{\"liquifyPreview\":\"$route\"}}" liquify_perf.js > "../liquify_r$R.log" 2>&1; echo "rc=$?" >> "../liquify_r$R.log"; mv brush_perf.out.json "../liquify_r$R.json" 2>/dev/null)
    log "$(tail -2 "$d/liquify_r$R.log" | tr '\n' ' ')"
    stop "$d/profile"
}
for R in $ROUNDS; do
    log "== round $R"
    if [ $((R % 2)) -eq 1 ]; then
        one before js "$R"
        one after rust "$R"
    else
        one after rust "$R"
        one before js "$R"
    fi
done
log "done"
