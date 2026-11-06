#!/usr/bin/env bash
# W1 of docs/PLAN_WASM_BUILD.md (§7 "The user's answers (2026-10-24)", Q3; the order row "W1"): the PNG writer's rows
# before and after the SIMD filter choice in crates/px/src/png.rs. Per round, each tool on a fresh instance (offline,
# tiles, its own profile; the harnesses bring the window to the front and print whether it was):
#   native_test.py 15000x10000: add_the_paint_layer export_png export_ora save_png (with build_the_file, open_the_file,
#                  close); the worker png_part laps (filter, deflate, adler, compose) per row; save_png's file kept
#                  for its SHA-256, then deleted (it differs from run to run of one build: the paint layer's canvas
#                  round trip, so it is no identity check)
#   tiffperf own   the TIFF open's store as a PNG (openJobs png_part: filter, deflate) and the TIFF export; its line
#                  says `focused` since the after-runs (tools/tiff_test.py; the before-runs' lines have no focus field)
#   w0_bench files_15k  the 15k photo (dist/daily/adobe_15000x10000.jpg) exported as PNG and TIFF: png_part laps;
#                  the PNG's SHA-256 (the same in every run of one build: the identity check before / after), then deleted
# Once per chain, before the rounds: the Node kernel row `px_bench.js --only png` (explains only, never decides) on
# Node and on Electron's V8.
# A native, tiff or files run with the window behind (not focused) is NOT COUNTED: moved to notcounted/ and tried
# again, up to three times. PARTS (env) picks the parts: "node native tiff files" by default.
# The machine's busy lock (w1_lock.py beside this file) is taken for the whole chain, atomically and with a token of its
# own, and released at its end (also on failure) only if it still holds that token. Still held by another agent after
# 60 minutes: the chain goes on without it, writes nothing into the lock and logs "NOT LOCKED: measured while ... held
# the lock" (the runs are then marked so in summary.txt).
# Usage: [PARTS=...] bash w1_chain.sh <outdir> [rounds]   (rounds "1 2 3" by default)
set -u
cd /f/canvas
OUTDIR="$1"; ROUNDS="${2:-1 2 3}"; PARTS="${PARTS:-node native tiff files}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$OUTDIR/native" "$OUTDIR/bench" "$OUTDIR/node"
export SCUMBLE_GATES="$OUTDIR/gates"
BIG=/f/canvas/dist/w1_files   # big files, never in this folder
has() { case " $PARTS " in *" $1 "*) return 0 ;; esac; return 1; }
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUTDIR/chain.log"; }
gpu() { log "gpu: $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader); comfy 8188: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8188/system_stats)"; }
start_app() {   # $1 = the profile folder, $2 = the app log
    rm -rf "$1"; mkdir -p "$1"
    ./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir="$1" --no-comfy > "$2" 2>&1 &
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:9555/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 8
}
stop_app() {   # $1 = the profile folder
    grep -h "renderer ended" "$1/logs/scumble.log" >> "$OUTDIR/chain.log" 2>/dev/null
    SCUMBLE_CDP_PORT=9555 python tools/close_app.py >> "$OUTDIR/chain.log" 2>&1; sleep 4
    rm -rf "$1"
}
notcounted() {   # $1 = the part, $2 = the round, $3 = the try, $4.. = the files
    local part="$1" r="$2" t="$3"; shift 3
    log "$part r$r NOT COUNTED (the window behind): kept in notcounted/ as ${part}_r${r}_try$t"
    mkdir -p "$OUTDIR/notcounted"
    for f in "$@"; do [ -f "$f" ] && mv "$f" "$OUTDIR/notcounted/${part}_r${r}_try${t}.${f##*.}"; done
}
TOKEN=""
release() { [ -n "$TOKEN" ] && python "$HERE/w1_lock.py" release "$TOKEN" >> "$OUTDIR/chain.log" 2>&1; }
trap release EXIT

TOKEN="$(python "$HERE/w1_lock.py" acquire "W1 measuring" 2>> "$OUTDIR/chain.log")"; LRC=$?
if [ $LRC -eq 0 ] && [ -n "$TOKEN" ]; then
    log "lock: taken ($TOKEN)"
elif [ $LRC -eq 3 ]; then
    log "NOT LOCKED: measured while another agent held the lock (its holder in the lock line above)"
else
    log "lock: acquire failed (rc=$LRC); stopping"; exit 1
fi
log "commit $(git rev-parse --short HEAD); px ABI $(grep -o 'ABI = [0-9]*' renderer/editor/px/px.js | head -1); parts: $PARTS; rounds: $ROUNDS"
log "px.wasm $(sha256sum renderer/editor/px/px.wasm | cut -c1-16), px_scalar.wasm $(sha256sum renderer/editor/px/px_scalar.wasm | cut -c1-16)"
gpu

if has node; then
    log "node px_bench png"
    node tools/px_bench.js --only png --runs 7 --json "$OUTDIR/node/px_bench_node.json" > "$OUTDIR/node/px_bench_node.log" 2>&1
    log "rc=$?"
    log "electron-as-node px_bench png"
    ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe tools/px_bench.js --only png --runs 7 \
        --json "$OUTDIR/node/px_bench_electron.json" > "$OUTDIR/node/px_bench_electron.log" 2>&1
    log "rc=$?"
fi

for R in $ROUNDS; do
    log "== round $R"

    if has native; then
        P="$OUTDIR/profile_native_r$R"
        for try in 1 2 3; do
            mkdir -p "$BIG/native_r$R"
            log "native r$R (try $try)"
            gpu
            start_app "$P" "$OUTDIR/native/app_r$R.log"
            timeout 1800 python tools/native_test.py 15000x10000 --json "$OUTDIR/native/r$R.json" --out "$BIG/native_r$R" --keep \
                add_the_paint_layer export_png export_ora save_png > "$OUTDIR/native/r$R.log" 2>&1
            log "rc=$?"
            stop_app "$P"
            for f in "$BIG/native_r$R"/*; do [ -f "$f" ] && log "sha256 native r$R $(basename "$f") $(stat -c %s "$f") $(sha256sum "$f" | cut -d' ' -f1)"; done
            rm -rf "$BIG/native_r$R"
            if grep -q '"focused": false' "$OUTDIR/native/r$R.json" 2>/dev/null; then
                notcounted native "$R" "$try" "$OUTDIR/native/r$R.json" "$OUTDIR/native/r$R.log"
                continue
            fi
            break
        done
    fi

    if has tiff; then
        for try in 1 2 3; do
            log "tiffperf own r$R (try $try)"
            gpu
            G="$OUTDIR/gates/gates/w1-tiff-own-r$R"
            bash tools/run_gates.sh "w1-tiff-own-r$R" --offline --tiles on "tiffperf:15000x10000,--variant,own,--out,$BIG/tiff_r$R" >> "$OUTDIR/chain.log" 2>&1
            log "rc=$?"
            rm -rf "$OUTDIR/gates/profiles" "$BIG/tiff_r$R"
            if grep -q '"focused": false' "$G/tiffperf.log" 2>/dev/null; then
                log "tiff r$R NOT COUNTED (the window behind): kept in notcounted/ as tiff_r${R}_try$try"
                mkdir -p "$OUTDIR/notcounted"; mv "$G" "$OUTDIR/notcounted/tiff_r${R}_try$try"
                continue
            fi
            break
        done
    fi

    if has files; then
        P="$OUTDIR/profile_bench_r$R"
        for try in 1 2 3; do
            mkdir -p "$BIG/files_r$R"
            log "w0_bench files_15k r$R (try $try)"
            gpu
            start_app "$P" "$OUTDIR/bench/app_r$R.log"
            timeout 1800 python tools/w0_bench.py --json "$OUTDIR/bench/files_r$R.json" --files="$BIG/files_r$R" --rows=files_15k \
                > "$OUTDIR/bench/files_r$R.log" 2>&1
            log "rc=$?"
            stop_app "$P"
            for f in "$BIG/files_r$R"/*.png; do [ -f "$f" ] && log "sha256 files r$R $(basename "$f") $(stat -c %s "$f") $(sha256sum "$f" | cut -d' ' -f1)"; done
            rm -rf "$BIG/files_r$R"
            if grep -q '"focus": false' "$OUTDIR/bench/files_r$R.log" 2>/dev/null; then
                notcounted files "$R" "$try" "$OUTDIR/bench/files_r$R.json" "$OUTDIR/bench/files_r$R.log"
                continue
            fi
            break
        done
    fi
done
gpu
log "done"
