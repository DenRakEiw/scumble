#!/usr/bin/env bash
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"

LOCK="docs/measurements/w1_2026-11-06/w1_lock.py"
PORT=9621
export SCUMBLE_CDP_PORT=$PORT

SWAP_FILES=(
    "renderer/editor/px/kernels.js"
    "renderer/editor/inpaint_png.js"
    "renderer/editor/inpaint_worker.js"
    "renderer/editor/inpaint_canvas.js"
)

BEFORE_DIR="$HERE/.tmp_before_30k"
AFTER_DIR="$HERE/.tmp_after_30k"
rm -rf "$BEFORE_DIR" "$AFTER_DIR"
mkdir -p "$BEFORE_DIR" "$AFTER_DIR"

for f in "${SWAP_FILES[@]}"; do
    mkdir -p "$BEFORE_DIR/$(dirname "$f")" "$AFTER_DIR/$(dirname "$f")"
    cp "$f" "$AFTER_DIR/$f"
    git show "9fd93524:$f" > "$BEFORE_DIR/$f"
done

set_arm() {
    local src="$AFTER_DIR"
    [ "$1" = "before" ] && src="$BEFORE_DIR"
    for f in "${SWAP_FILES[@]}"; do
        cp "$src/$f" "$f"
    done
}

TOKEN=""
cleanup() {
    [ -d "$AFTER_DIR" ] && set_arm after
    rm -rf "$BEFORE_DIR" "$AFTER_DIR"
    SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >/dev/null 2>&1 || true
    [ -n "$TOKEN" ] && python "$LOCK" release "$TOKEN" >/dev/null 2>&1 || true
}
trap cleanup EXIT

TOKEN="$(python "$LOCK" acquire "K8 30k before/after (chain-p)")"; LRC=$?
if [ $LRC -ne 0 ] || [ -z "$TOKEN" ]; then
    echo "lock acquire failed rc=$LRC"
    exit 1
fi

start_app() {
    SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >/dev/null 2>&1 || true
    sleep 2
    rm -rf "$1"; mkdir -p "$1"
    SCUMBLE_TILES=1 ./node_modules/electron/dist/electron.exe . --remote-debugging-port=$PORT --user-data-dir="$1" --no-comfy --tiles > "$2" 2>&1 &
    for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:$PORT/json/version > /dev/null 2>&1 && break; sleep 1; done
    sleep 6
}
stop_app() {
    SCUMBLE_CDP_PORT=$PORT python tools/close_app.py >/dev/null 2>&1 || true
    sleep 3
    rm -rf "$1"
}

for arm in before after; do
    set_arm "$arm"
    UD="$ROOT/dist/gates/profile-k8-30k-$arm"
    start_app "$UD" "$HERE/${arm}/app_huge_30k.log"
    python "$HERE/huge30k_probe.py" "$arm" "$HERE/${arm}/huge_30k.json" | tee "$HERE/${arm}/huge_30k.log"
    stop_app "$UD"
done
