#!/usr/bin/env bash
# K19 of docs/PLAN_WASM_BUILD.md (4.6 K19, question 6.3): the TIFF writer's deflate, Rust deflate_part at level 2 (the
# app's default) against the browser's CompressionStream("deflate") per strip in the workers, at 15,000 x 10,000.
#
# The app has no route that picks the deflater in the workers (tiffPartJob uses rustPx().zlib or tiffStrip(FromPtr) at
# level 2 whenever the Rust kernels are loaded; CompressionStream only without them). The A/B therefore runs on a scratch
# tree: `git archive HEAD` plus native_deflate.patch (a harness route `tiffDeflate`; "js" takes the same wasm gather and
# tiff_predict_rgba, then the predicted strip through CompressionStream). Nothing of the patch is committed into the app.
# Both arms run that one scratch tree; only the route differs (set in the window before the export, k19_bench.py).
#
# Under the machine's busy lock (docs/measurements/w1_2026-11-06/w1_lock.py, acquired and released per batch): three
# rounds, each variant (own = the photo, noise) a batch of both arms on fresh offline instances (--tiles on, port
# $SCUMBLE_CDP_PORT, default 9633), the arm order alternated per round. Results: results/<arm>_<variant>_r<n>.json,
# logs beside them, chain.log. Re-running skips the rows that have a result.
#
#   bash docs/measurements/k19_2026-11-11/k19_chain.sh            # the 15k rounds
#   K19_ARM_A=rust6 K19_RES=results_l6 bash docs/measurements/k19_2026-11-11/k19_chain.sh   # level 6 against native
#   K19_SMOKE=1 bash docs/measurements/k19_2026-11-11/k19_chain.sh  # one 2000x1500 noise pair (checks the route)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MAIN_REPO="$(git -C "$ROOT" worktree list --porcelain | head -n 1 | sed 's/^worktree //')"
LOCK="$ROOT/docs/measurements/w1_2026-11-06/w1_lock.py"
PORT="${SCUMBLE_CDP_PORT:-9633}"
export SCUMBLE_CDP_PORT="$PORT"
SMOKE="${K19_SMOKE:-}"
ROUNDS="${K19_ROUNDS:-1 2 3}"
VARIANTS="${K19_VARIANTS:-own noise}"
# two arms, alternated per round: "rust native" (results/) or "rust6 native" (results_l6/: Rust at the native level 6)
ARM_A="${K19_ARM_A:-rust}"
ARM_B="${K19_ARM_B:-native}"
RES_NAME="${K19_RES:-results}"

RES="$HERE/$RES_NAME"
[ -n "$SMOKE" ] && RES="$HERE/smoke"
mkdir -p "$RES"

TREE="$(dirname "$ROOT")/.tmp_k19_tree_$$"
TIFF_OUT="$(dirname "$ROOT")/.tmp_k19_tiff_$$"
PHOTO="$MAIN_REPO/dist/daily/adobe_15000x10000.jpg"
NOISE_SRC="$MAIN_REPO/dist/gates/k0a_2026-10-23/tiff_files/noise_15000x10000.png"
TOKEN=""

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$HERE/chain.log"; }
gpu() { log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader 2>/dev/null || echo n/a)"; }

acquire_lock() {
    local label="$1"
    while true; do
        [ -e "$MAIN_REPO/.claude/coord/WRAP_UP" ] && { log "WRAP_UP set: stopping"; exit 2; }
        TOKEN="$(python "$LOCK" acquire "$label" 2>> "$HERE/chain.log")"; local lrc=$?
        if [ $lrc -eq 0 ] && [ -n "$TOKEN" ]; then
            log "lock: taken ($TOKEN)"
            return 0
        elif [ $lrc -eq 3 ]; then
            log "lock: still held; waiting ($label)"
            sleep 10
        else
            log "lock: acquire failed (rc=$lrc); stopping"
            exit 1
        fi
    done
}

release_lock() {
    if [ -n "$TOKEN" ]; then
        python "$LOCK" release "$TOKEN" >> "$HERE/chain.log" 2>&1 || true
        TOKEN=""
    fi
}

cleanup() {
    SCUMBLE_CDP_PORT="$PORT" python "$ROOT/tools/close_app.py" >> "$HERE/chain.log" 2>&1 || true
    release_lock
    python -c "import os, sys; p = sys.argv[1]; os.path.lexists(p) and os.rmdir(p)" "$TREE/node_modules" 2>/dev/null || true
    rm -rf "$TREE" "$TIFF_OUT" "$HERE"/profile_* 2>/dev/null || true
}
trap cleanup EXIT

log "scratch tree $TREE from $(git -C "$ROOT" rev-parse --short HEAD) + native_deflate.patch"
mkdir -p "$TREE" "$TIFF_OUT"
git -C "$ROOT" archive HEAD | tar -x -C "$TREE"
(cd "$TREE" && GIT_CEILING_DIRECTORIES="$(dirname "$TREE")" git apply "$HERE/native_deflate.patch") || { log "ERROR: the patch did not apply"; exit 1; }
grep -q 'route("tiffDeflate") === "js"' "$TREE/renderer/editor/inpaint_worker.js" || { log "ERROR: patch not in the scratch tree"; exit 1; }
python -c "import os, sys, _winapi; _winapi.CreateJunction(os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2]))" "$MAIN_REPO/node_modules" "$TREE/node_modules"
[ -f "$TREE/node_modules/electron/dist/electron.exe" ] || { log "ERROR: electron.exe missing in $TREE"; exit 1; }
if [ -z "$SMOKE" ] && [ -f "$NOISE_SRC" ]; then
    python -c "import os, shutil, sys
try: os.link(sys.argv[1], sys.argv[2])
except OSError: shutil.copyfile(sys.argv[1], sys.argv[2])" "$NOISE_SRC" "$TIFF_OUT/noise_15000x10000.png"
fi
log "px.wasm $(sha256sum "$TREE/renderer/editor/px/px.wasm" | cut -c1-16), px_scalar.wasm $(sha256sum "$TREE/renderer/editor/px/px_scalar.wasm" | cut -c1-16)"
gpu

start_app() {
    local prof="$1" applog="$2"
    rm -rf "$prof"; mkdir -p "$prof"
    "$TREE/node_modules/electron/dist/electron.exe" "$TREE" --remote-debugging-port="$PORT" --user-data-dir="$prof" --tiles on --no-comfy > "$applog" 2>&1 &
    for i in $(seq 1 120); do
        curl -s -m 1 "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1 && break
        sleep 1
    done
    sleep 6
}

stop_app() {
    local prof="$1"
    grep -h "renderer ended" "$prof/logs/scumble.log" >> "$HERE/chain.log" 2>/dev/null || true
    SCUMBLE_CDP_PORT="$PORT" python "$ROOT/tools/close_app.py" >> "$HERE/chain.log" 2>&1 || true
    sleep 3
    rm -rf "$prof"
}

one() {
    local arm="$1" v="$2" r="$3"
    local P="$HERE/profile_${arm}_${v}_r$r" out="$RES/${arm}_${v}_r$r"
    for try in 1 2 3; do
        log "run $arm $v r$r (try $try)"
        start_app "$P" "$out.app.log"
        if [ -n "$SMOKE" ]; then
            # a small noise picture through the same MEASURE (k19_bench.py's size comes from tiff_test.py's --size)
            K19_SIZE=2000x1500 timeout 1800 python "$HERE/k19_bench.py" "$TREE" "$arm" "$v" "$TIFF_OUT" "$PHOTO" "$out.json" > "$out.log" 2>&1
        else
            timeout 1800 python "$HERE/k19_bench.py" "$TREE" "$arm" "$v" "$TIFF_OUT" "$PHOTO" "$out.json" > "$out.log" 2>&1
        fi
        log "rc=$? $(tail -n 1 "$out.log")"
        stop_app "$P"
        if grep -q '"focused": false' "$out.log" 2>/dev/null; then
            log "$arm $v r$r NOT COUNTED (unfocused), try $try"
            mkdir -p "$HERE/notcounted"
            mv "$out.log" "$HERE/notcounted/${arm}_${v}_r${r}_try${try}.log" 2>/dev/null || true
            rm -f "$out.json"
            continue
        fi
        break
    done
}

if [ -n "$SMOKE" ]; then
    acquire_lock "K19 smoke (chain-t)"
    one rust noise 0
    one native noise 0
    release_lock
    log "smoke done"
    exit 0
fi

for R in $ROUNDS; do
    for V in $VARIANTS; do
        if [ -s "$RES/${ARM_A}_${V}_r${R}.json" ] && [ -s "$RES/${ARM_B}_${V}_r${R}.json" ]; then continue; fi
        acquire_lock "K19 $V r$R (chain-t)"
        log "== $V round $R"
        gpu
        if [ $((R % 2)) -eq 1 ]; then
            [ -s "$RES/${ARM_A}_${V}_r${R}.json" ] || one "$ARM_A" "$V" "$R"
            [ -s "$RES/${ARM_B}_${V}_r${R}.json" ] || one "$ARM_B" "$V" "$R"
        else
            [ -s "$RES/${ARM_B}_${V}_r${R}.json" ] || one "$ARM_B" "$V" "$R"
            [ -s "$RES/${ARM_A}_${V}_r${R}.json" ] || one "$ARM_A" "$V" "$R"
        fi
        release_lock
        sleep 2
    done
done
gpu
log "done"
