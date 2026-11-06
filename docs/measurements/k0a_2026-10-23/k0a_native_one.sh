#!/usr/bin/env bash
# One native_test run on a fresh instance: bash k0a_native_one.sh <outdir> <label> <rows...>
set -u
cd /f/canvas
OUTDIR="$1"; LABEL="$2"; shift 2
prof="$OUTDIR/profile_$LABEL"
rm -rf "$prof"; mkdir -p "$prof"
./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir="$prof" --no-comfy > "$OUTDIR/app_$LABEL.log" 2>&1 &
for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:9555/json/version > /dev/null 2>&1 && break; sleep 1; done
sleep 8
python tools/native_test.py 15000x10000 --json "$OUTDIR/native_$LABEL.json" --out "$OUTDIR/native_files_$LABEL" "$@" > "$OUTDIR/native_$LABEL.log" 2>&1
echo "native $LABEL rc=$?"
grep -h "renderer ended" "$prof/logs/scumble.log" || echo "no renderer end in the log"
SCUMBLE_CDP_PORT=9555 python tools/close_app.py; sleep 4
