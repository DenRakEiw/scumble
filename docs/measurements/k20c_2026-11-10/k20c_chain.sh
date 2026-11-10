#!/usr/bin/env bash
# K20c (docs/PLAN_WASM_K20.md §4.3): three alternating rounds of `native_test.py 15000x10000`
# (build_the_file open_the_file add_the_paint_layer export_ora open_ora close), the base tree `db2c39da` against this
# tree, on fresh offline instances (tiles on, port 9621), under the busy lock per round. Unfocused runs are not counted.
# Written while the machine was busy: not run yet. Only while F:\canvas\.claude\coord\MACHINE_FREE exists.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MAIN_REPO="$(git -C "$ROOT" worktree list --porcelain | head -n 1 | sed 's/^worktree //')"
LOCK="$ROOT/docs/measurements/w1_2026-11-06/w1_lock.py"
PORT="${SCUMBLE_CDP_PORT:-9621}"
BASE_SHA="db2c39da"
export SCUMBLE_CDP_PORT="$PORT"
mkdir -p "$HERE/before/native" "$HERE/after/native" "$HERE/notcounted"
BEFORE_TREE="$(dirname "$ROOT")/.tmp_k20c_before_$$"
TOKEN=""
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$HERE/chain.log"; }
acquire_lock() {
    while true; do
        TOKEN="$(python "$LOCK" acquire "$1" 2>> "$HERE/chain.log")"; local lrc=$?
        if [ $lrc -eq 0 ] && [ -n "$TOKEN" ]; then log "lock: taken ($TOKEN)"; return 0
        elif [ $lrc -eq 3 ]; then log "lock: still held after 60 min; waiting"; sleep 10
        else log "lock: acquire failed (rc=$lrc); stopping"; exit 1; fi
    done
}
release_lock() { if [ -n "$TOKEN" ]; then python "$LOCK" release "$TOKEN" >> "$HERE/chain.log" 2>&1 || true; TOKEN=""; fi; }
cleanup() {
    SCUMBLE_CDP_PORT="$PORT" python "$ROOT/tools/close_app.py" >> "$HERE/chain.log" 2>&1 || true
    release_lock
    python -c "import os, sys; p = sys.argv[1]; os.path.lexists(p) and os.rmdir(p)" "$BEFORE_TREE/node_modules" 2>/dev/null || true
    rm -rf "$BEFORE_TREE" "$HERE"/profile_* 2>/dev/null || true
}
trap cleanup EXIT
log "exporting the before tree at $BASE_SHA to $BEFORE_TREE"
mkdir -p "$BEFORE_TREE"
git -C "$ROOT" archive "$BASE_SHA" | tar -x -C "$BEFORE_TREE"
python -c "import os, sys, _winapi; _winapi.CreateJunction(os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2]))" "$MAIN_REPO/node_modules" "$BEFORE_TREE/node_modules"
[ -f "$BEFORE_TREE/node_modules/electron/dist/electron.exe" ] || { log "ERROR: electron.exe missing"; exit 1; }
start_app() {
    local tree="$1" prof="$2" applog="$3"
    rm -rf "$prof"; mkdir -p "$prof"
    "$tree/node_modules/electron/dist/electron.exe" "$tree" --remote-debugging-port="$PORT" --user-data-dir="$prof" --tiles on --no-comfy > "$applog" 2>&1 &
    for _ in $(seq 1 120); do curl -s -m 1 "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1 && break; sleep 1; done
    sleep 6
}
stop_app() { SCUMBLE_CDP_PORT="$PORT" python "$ROOT/tools/close_app.py" >> "$HERE/chain.log" 2>&1 || true; sleep 3; rm -rf "$1"; }
arm() {
    local name="$1" r="$2" tree="$ROOT"
    [ "$name" = "before" ] && tree="$BEFORE_TREE"
    local P="$HERE/profile_${name}_r$r" J="$HERE/$name/native/r$r.json" L="$HERE/$name/native/r$r.log"
    for try in 1 2 3; do
        log "native $name r$r (try $try)"
        start_app "$tree" "$P" "$HERE/$name/native/app_r$r.log"
        timeout 1800 python "$ROOT/tools/native_test.py" 15000x10000 --json "$J" build_the_file open_the_file add_the_paint_layer export_ora open_ora close > "$L" 2>&1
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focused": false' "$J" 2>/dev/null; then
            log "native $name r$r NOT COUNTED (unfocused)"
            mv "$J" "$HERE/notcounted/${name}_r${r}_try${try}.json" 2>/dev/null || true
            mv "$L" "$HERE/notcounted/${name}_r${r}_try${try}.log" 2>/dev/null || true
            continue
        fi
        break
    done
}
for R in 1 2 3; do
    acquire_lock "K20c native_test r$R (chain-p)"
    if [ $((R % 2)) -eq 1 ]; then arm before "$R"; arm after "$R"; else arm after "$R"; arm before "$R"; fi
    release_lock
done
log "done"
