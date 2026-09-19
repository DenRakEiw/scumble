#!/usr/bin/env bash
# Run from F:/canvas with Git Bash. Never touches port 9557 (the preview) or the real node repo.
# Gates on a fresh dev instance with its own profile (docs/PLAN_BCE.md §0).
#
#   bash tools/run_gates.sh <label> [--copy] [--strict] [--tiles on|off] [--offline] [--exe PATH] gate [gate ...]
# --offline: the instance does not connect to ComfyUI (--no-comfy), so no upload is forwarded to the server.
#
# --tiles on|off: the pixel backend (C2). Dev: SCUMBLE_TILES=1 / 0. Exe: --tiles / --no-tiles.
# Gate "nodecopy": build_node.py + node_test.py against a scratch copy of the node repo
# ($SCUMBLE_GATES/nodecopy), so the real node repo is never written.
#
# A gate is a tools/ script name without .py (editor, composite, pixels, shape, brush, commands,
# film, glb, ailabel, size, transparent, generate, log, llm, toapis, openrouter, ark, mcp, smoke, node, perf:<args>).
# Gate "toapis" (tools/toapis_test.py) runs tools/toapis_test.js in plain Node first, then the app against
# tools/toapis_mock.py; it needs no ToAPIs key and refuses a profile that holds one. Gate "openrouter"
# (tools/openrouter_test.py) does the same with tools/openrouter_test.js and tools/openrouter_mock.py, and gate
# "ark" (tools/ark_test.py, BytePlus ModelArk) with tools/ark_test.js and tools/ark_mock.py.
# Logs and summary.txt go to $SCUMBLE_GATES/gates/<label>/. Exit code 0 only when every gate passed.
# Logs, profiles and the node copy go under $SCUMBLE_GATES (default F:/canvas/dist/gates, ignored by git).
SP="${SCUMBLE_GATES:-/f/canvas/dist/gates}"
LABEL="$1"; shift
COPY=""; STRICT="0"; EXE=""; TILES=""; OFFLINE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --copy) COPY="--pixels-copy"; shift ;;
    --strict) STRICT="1"; shift ;;
    --exe) EXE="$2"; shift 2 ;;
    --tiles) TILES="$2"; shift 2 ;;
    --offline) OFFLINE="--no-comfy"; shift ;;
    *) break ;;
  esac
done
OUT="$SP/gates/$LABEL"
PROFILE="$SP/profiles/$LABEL"
cd /f/canvas || exit 1
rm -rf "$OUT" "$PROFILE"
mkdir -p "$OUT" "$PROFILE/files/input/inpaint_canvas"
cp "/f/Comfyui/ComfyUI_windows_portable_nvidia/ComfyUI/input/inpaint_canvas/test_base.png" "$PROFILE/files/input/inpaint_canvas/"
export PYTHONIOENCODING=utf-8
export PYTHONUNBUFFERED=1
T="timeout 420"

if curl -s -m 2 http://127.0.0.1:9555/json/version > /dev/null; then
  echo "an instance already listens on 9555, closing it" | tee -a "$OUT/summary.txt"
  python tools/close_app.py; sleep 4
fi

needs_app=0
for g in "$@"; do case "$g" in node|nodecopy) ;; *) needs_app=1 ;; esac; done
TILEARG=""
case "$TILES" in
  on) export SCUMBLE_TILES=1; TILEARG="--tiles" ;;
  off) export SCUMBLE_TILES=0; TILEARG="--no-tiles" ;;
  *) unset SCUMBLE_TILES ;;
esac

if [ "$needs_app" = 1 ]; then
  if [ -n "$EXE" ]; then
    "$EXE" --remote-debugging-port=9555 --user-data-dir="$PROFILE" $COPY $TILEARG $OFFLINE > "$OUT/app.log" 2>&1 &
  else
    if [ "$STRICT" = 1 ]; then export SCUMBLE_STRICT=1; else export SCUMBLE_STRICT=0; fi
    ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9555 --user-data-dir="$PROFILE" $COPY $OFFLINE > "$OUT/app.log" 2>&1 &
  fi
  for i in $(seq 1 90); do
    curl -s -m 2 http://127.0.0.1:9555/json/version > /dev/null && break
    sleep 1
  done
  sleep 8
fi

fail=0
for g in "$@"; do
  t0=$(date +%s)
  case "$g" in
    smoke) q0=$(curl -s -m 5 http://127.0.0.1:8188/queue); $T python tools/smoke_test.py "$OUT/smoke" --no-helpers > "$OUT/$g.log" 2>&1; rc=$?; q1=$(curl -s -m 5 http://127.0.0.1:8188/queue); echo "queue before $q0 after $q1" >> "$OUT/$g.log" ;;
    mcp) if [ -n "$EXE" ]; then $T python tools/mcp_test.py --exe "$EXE" --user-data-dir "$PROFILE" "$OUT/mcp" > "$OUT/$g.log" 2>&1; else $T python tools/mcp_test.py --user-data-dir "$PROFILE" "$OUT/mcp" > "$OUT/$g.log" 2>&1; fi; rc=$? ;;
    commands) $T python tools/commands_test.py "$OUT/commands" > "$OUT/$g.log" 2>&1; rc=$? ;;
    film) $T python tools/film_test.py "$OUT/film" > "$OUT/$g.log" 2>&1; rc=$? ;;
    nodecopy) NC="$SP/nodecopy"; rm -rf "$NC"; mkdir -p "$NC"; (cd "/f/Comfyui/ComfyUI_windows_portable_nvidia/ComfyUI/custom_nodes/ComfyUI-InpaintCanvas" && tar --exclude=.git --exclude=__pycache__ -cf - .) | (cd "$NC" && tar -xf -); { $T python tools/build_node.py --node "$NC" && $T python tools/build_node.py --node "$NC" --check && $T python tools/node_test.py --node "$NC"; } > "$OUT/$g.log" 2>&1; rc=$? ;;
    node) $T python tools/build_node.py --check > "$OUT/$g.log" 2>&1 && $T python tools/node_test.py >> "$OUT/$g.log" 2>&1; rc=$? ;;
    perf:*) $T python tools/perf_test.py ${g#perf:} > "$OUT/perf.log" 2>&1; rc=$? ;;
    pxjobs) timeout 1200 python tools/px_jobs.py --check > "$OUT/pxjobs.log" 2>&1; rc=$? ;;
    huge:*) timeout 3000 python tools/huge_test.py ${g#huge:} > "$OUT/huge.log" 2>&1; rc=$? ;;
    exportperf:*) timeout 1800 python tools/export_test.py --perf $(echo "${g#exportperf:}" | tr ',' ' ') > "$OUT/exportperf.log" 2>&1; rc=$? ;;
    # mem:15000x10000,--rounds,4 (commas for spaces); four rounds at 15k take longer than the other gates' 420 s
    mem:*) timeout 2400 python tools/mem_test.py $(echo "${g#mem:}" | tr ',' ' ') > "$OUT/mem.log" 2>&1; rc=$? ;;
    *) $T python "tools/${g}_test.py" > "$OUT/$g.log" 2>&1; rc=$? ;;
  esac
  verdict=$(grep -aE "(^PASS|^FAIL|^RESULT)" "$OUT/${g%%:*}.log" | tail -1)
  [ "$rc" != 0 ] && fail=1
  case "$verdict" in *FAIL*) fail=1 ;; esac
  echo "$g rc=$rc $(( $(date +%s) - t0 ))s ${verdict}" | tee -a "$OUT/summary.txt"
done

if [ "$needs_app" = 1 ]; then
  $T python tools/cdp.py log > "$OUT/console.log" 2>&1
  python tools/close_app.py > /dev/null; sleep 4
fi
[ "$fail" = 0 ] && echo "ALL PASS" | tee -a "$OUT/summary.txt" || echo "SOME FAILED" | tee -a "$OUT/summary.txt"
exit $fail
