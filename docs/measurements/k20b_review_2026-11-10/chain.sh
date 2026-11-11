#!/usr/bin/env bash
# K20b review (K20b-T1, docs/PLAN_WASM_K20.md §7 "K20b review"): the psd_read acknowledgement window, measured at
# 15,000 x 10,000 on fresh offline instances (--tiles on), three alternating rounds per row, each round under the
# machine's busy lock (docs/measurements/w1_2026-11-06/w1_lock.py, taken and released per round). Arms:
#   before    a clean tree of the base 764fdffe (the JS reader in psd_read, before K20b)
#   unpaced   this tree with --set psdWindow=0 (K20b as first handed in: every band posted at once)
#   paced     this tree as built (the default window, PSD_WINDOW = 8)
# Rows:
#   native    tools/native_test.py 15000x10000 build_the_file open_the_file add_the_paint_layer export_psd open_psd close
#             (the open_psd row is the 2-layer file K20b measured: an opaque Background and the soft-alpha Paint)
#   soft      psd_open.py on make_soft_psd.mjs's file (Background + 3 full-size soft-alpha layers), 2 opens per instance
# Then summarize.py > summary.txt.
#   SCUMBLE_CDP_PORT=9621 bash chain.sh [native|soft ...]
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MAIN_REPO="$(git -C "$ROOT" worktree list --porcelain | head -n 1 | sed 's/^worktree //')"
LOCK="$ROOT/docs/measurements/w1_2026-11-06/w1_lock.py"
PORT="${SCUMBLE_CDP_PORT:-9621}"
BASE_SHA="764fdffe"
ROWS="${*:-native soft}"
export SCUMBLE_CDP_PORT="$PORT"

BEFORE_TREE="$(dirname "$ROOT")/.tmp_k20bfix_before_$$"
SOFT_PSD="$(dirname "$ROOT")/.tmp_k20bfix_soft_$$.psd"
TOKEN=""

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$HERE/chain.log"; }
gpu() { log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader 2>/dev/null || echo n/a)"; }

acquire_lock() {
    while true; do
        TOKEN="$(python "$LOCK" acquire "$1" 2>> "$HERE/chain.log")"; local lrc=$?
        if [ $lrc -eq 0 ] && [ -n "$TOKEN" ]; then log "lock: taken ($TOKEN)"; return 0; fi
        if [ $lrc -eq 3 ]; then log "lock: still held after 60 min; waiting on"; sleep 10; continue; fi
        log "lock: acquire failed (rc=$lrc); stopping"; exit 1
    done
}
release_lock() { if [ -n "$TOKEN" ]; then python "$LOCK" release "$TOKEN" >> "$HERE/chain.log" 2>&1 || true; TOKEN=""; fi; }
wrap_up() { [ -e "$MAIN_REPO/.claude/coord/WRAP_UP" ]; }

cleanup() {
    SCUMBLE_CDP_PORT="$PORT" python "$ROOT/tools/close_app.py" >> "$HERE/chain.log" 2>&1 || true
    release_lock
    python -c "import os, sys; p = sys.argv[1]; os.path.lexists(p) and os.rmdir(p)" "$BEFORE_TREE/node_modules" 2>/dev/null || true
    rm -rf "$BEFORE_TREE" "$SOFT_PSD" "$HERE"/profile_* 2>/dev/null || true
}
trap cleanup EXIT

start_app() {
    local tree="$1" prof="$2" applog="$3"
    rm -rf "$prof"; mkdir -p "$prof"
    "$tree/node_modules/electron/dist/electron.exe" "$tree" --remote-debugging-port="$PORT" --user-data-dir="$prof" --tiles on --no-comfy > "$applog" 2>&1 &
    for i in $(seq 1 120); do
        curl -s -m 1 "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1 && break
        sleep 1
    done
    sleep 6
}
stop_app() {
    SCUMBLE_CDP_PORT="$PORT" python "$ROOT/tools/close_app.py" >> "$HERE/chain.log" 2>&1 || true
    sleep 3
    rm -rf "$1"
}
tree_of() { if [ "$1" = "before" ]; then echo "$BEFORE_TREE"; else echo "$ROOT"; fi; }
set_of() { if [ "$1" = "unpaced" ]; then echo "--set psdWindow=0"; fi; }

log "exporting the before tree at $BASE_SHA to $BEFORE_TREE"
mkdir -p "$BEFORE_TREE"
git -C "$ROOT" archive "$BASE_SHA" | tar -x -C "$BEFORE_TREE"
python -c "import os, sys, _winapi; _winapi.CreateJunction(os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2]))" "$MAIN_REPO/node_modules" "$BEFORE_TREE/node_modules"
log "branch $(git -C "$ROOT" rev-parse --abbrev-ref HEAD) at $(git -C "$ROOT" rev-parse --short HEAD) (dirty: $(git -C "$ROOT" status --porcelain -- renderer crates | wc -l) files); base $BASE_SHA; port $PORT"
log "before px.wasm $(sha256sum "$BEFORE_TREE/renderer/editor/px/px.wasm" | cut -c1-16); after px.wasm $(sha256sum "$ROOT/renderer/editor/px/px.wasm" | cut -c1-16)"

run_native() {
    local arm="$1" r="$2" tree; tree="$(tree_of "$arm")"
    local P="$HERE/profile_native_${arm}_r$r" json="$HERE/$arm/native/r$r.json" logf="$HERE/$arm/native/r$r.log"
    mkdir -p "$HERE/$arm/native" "$HERE/notcounted"
    for try in 1 2 3; do
        log "native $arm r$r (try $try) $(set_of "$arm")"; gpu
        start_app "$tree" "$P" "$HERE/$arm/native/app_r$r.log"
        # shellcheck disable=SC2046
        timeout 1800 python "$ROOT/tools/native_test.py" 15000x10000 $(set_of "$arm") --json "$json" \
            build_the_file open_the_file add_the_paint_layer export_psd open_psd close > "$logf" 2>&1
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focused": false' "$json" 2>/dev/null; then
            log "native $arm r$r NOT COUNTED (unfocused)"; mv "$json" "$HERE/notcounted/native_${arm}_r${r}_try$try.json"; mv "$logf" "$HERE/notcounted/native_${arm}_r${r}_try$try.log"; continue
        fi
        break
    done
}

run_soft() {
    local arm="$1" r="$2" tree; tree="$(tree_of "$arm")"
    local P="$HERE/profile_soft_${arm}_r$r" json="$HERE/$arm/soft/r$r.json" logf="$HERE/$arm/soft/r$r.log"
    mkdir -p "$HERE/$arm/soft" "$HERE/notcounted"
    for try in 1 2 3; do
        log "soft $arm r$r (try $try) $(set_of "$arm")"; gpu
        start_app "$tree" "$P" "$HERE/$arm/soft/app_r$r.log"
        # shellcheck disable=SC2046
        timeout 1800 python "$HERE/psd_open.py" "$SOFT_PSD" $(set_of "$arm") --reps 2 --json "$json" > "$logf" 2>&1
        log "rc=$?"
        stop_app "$P"
        if grep -q '"focused": false' "$json" 2>/dev/null; then
            log "soft $arm r$r NOT COUNTED (unfocused)"; mv "$json" "$HERE/notcounted/soft_${arm}_r${r}_try$try.json"; mv "$logf" "$HERE/notcounted/soft_${arm}_r${r}_try$try.log"; continue
        fi
        break
    done
}

ORDERS=("before unpaced paced" "paced unpaced before" "unpaced paced before")
for row in $ROWS; do
    if [ "$row" = "soft" ] && [ ! -f "$SOFT_PSD" ]; then
        acquire_lock "K20b review: soft PSD build (chain-p)"
        log "building $SOFT_PSD"
        node "$HERE/make_soft_psd.mjs" "$SOFT_PSD" 3 >> "$HERE/chain.log" 2>&1
        log "rc=$?"
        release_lock
    fi
    for R in 1 2 3; do
        if wrap_up; then log "WRAP_UP: stopping before $row round $R"; exit 3; fi
        acquire_lock "K20b review: $row round $R (chain-p)"
        log "== $row round $R: ${ORDERS[$((R - 1))]}"
        for arm in ${ORDERS[$((R - 1))]}; do
            if [ "$row" = "native" ]; then run_native "$arm" "$R"; else run_soft "$arm" "$R"; fi
        done
        release_lock
        sleep 2
    done
done

python "$HERE/summarize.py" > "$HERE/summary.txt" 2>&1
log "summary written; chain complete"
