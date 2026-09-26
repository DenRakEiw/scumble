#!/usr/bin/env bash
# Run with Git Bash; it runs the checkout it lives in (F:/canvas, or a worktree of it). Never touches port 9557 (the
# preview) or the real node repo.
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
# film, glb, ailabel, size, transparent, generate, log, llm, toapis, openrouter, ark, comfyrouter, oxen, magnific, recipes, assistant, mcp, smoke,
# node, perf:<args>).
# Gate "toapis" (tools/toapis_test.py) runs tools/toapis_test.js in plain Node first, then the app against
# tools/toapis_mock.py; it needs no ToAPIs key and refuses a profile that holds one. Gate "openrouter"
# (tools/openrouter_test.py) does the same with tools/openrouter_test.js and tools/openrouter_mock.py, and gate
# "ark" (tools/ark_test.py, BytePlus ModelArk) with tools/ark_test.js and tools/ark_mock.py, and gate "comfyrouter"
# (tools/comfyrouter_test.py) with tools/comfyrouter_test.js and tools/comfyrouter_mock.py (it refuses a profile that
# holds a Comfy Cloud key, the key Comfy Router runs on), and gate "oxen" (tools/oxen_test.py, Oxen.ai) with
# tools/oxen_test.js and tools/oxen_mock.py (it refuses a profile that holds an Oxen key), and gate "magnific"
# (tools/magnific_test.py) with tools/magnific_test.js and tools/magnific_mock.py (it refuses a profile that holds a
# Magnific key). Gate "recipes"
# (tools/recipes_test.py) runs tools/recipes_test.js in plain Node first (the shipped recipes' settings slots and
# the importer), then the import through the app's Settings dialog; it needs no key and no ComfyUI. Gate "assistant"
# (tools/assistant_test.py) runs tools/assistant_test.js in plain Node first, then the in-app assistant against
# tools/assistant_mock.py (every model family through the mock, the asks, the pin, the user-activity wait); it needs
# no key, refuses a profile that holds one, refuses an instance connected to ComfyUI, and goes last in a list.
# Gate "platform" (tools/platform_test.py) runs tools/platform_test.js in plain Node first (the MCP registration of
# every platform, the files each installer leaves out), then the API keys note in the app.
# Gate "document" (tools/document_test.py) runs tools/document_test.js in plain Node first, then saves and opens
# .scumble documents in instances of its own (a fresh profile, a kill mid-save, a close during a save, newer files).
# Logs and summary.txt go to $SCUMBLE_GATES/gates/<label>/. Exit code 0 only when every gate passed.
# Logs, profiles and the node copy go under $SCUMBLE_GATES (default F:/canvas/dist/gates, ignored by git).
SP="${SCUMBLE_GATES:-/f/canvas/dist/gates}"
# SCUMBLE_CDP_PORT picks the DevTools port (default 9555), so two runs with different labels can go side by side;
# tools/cdp.py and tools/close_app.py read the same variable.
PORT="${SCUMBLE_CDP_PORT:-9555}"
export SCUMBLE_CDP_PORT="$PORT"
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
cd "$(dirname "$0")/.." || exit 1
rm -rf "$OUT" "$PROFILE"
mkdir -p "$OUT" "$PROFILE/files/input/inpaint_canvas"
cp "/f/Comfyui/ComfyUI_windows_portable_nvidia/ComfyUI/input/inpaint_canvas/test_base.png" "$PROFILE/files/input/inpaint_canvas/"
export PYTHONIOENCODING=utf-8
export PYTHONUNBUFFERED=1
T="timeout 420"

if curl -s -m 2 http://127.0.0.1:$PORT/json/version > /dev/null; then
  echo "an instance already listens on $PORT, closing it" | tee -a "$OUT/summary.txt"
  python tools/close_app.py; sleep 4
fi

needs_app=0
for g in "$@"; do case "$g" in node|nodecopy|lint|types|quit|quit:*|document) ;; *) needs_app=1 ;; esac; done
TILEARG=""
case "$TILES" in
  on) export SCUMBLE_TILES=1; TILEARG="--tiles" ;;
  off) export SCUMBLE_TILES=0; TILEARG="--no-tiles" ;;
  *) unset SCUMBLE_TILES ;;
esac

if [ "$needs_app" = 1 ]; then
  if [ -n "$EXE" ]; then
    "$EXE" --remote-debugging-port=$PORT --user-data-dir="$PROFILE" $COPY $TILEARG $OFFLINE > "$OUT/app.log" 2>&1 &
  else
    if [ "$STRICT" = 1 ]; then export SCUMBLE_STRICT=1; else export SCUMBLE_STRICT=0; fi
    ./node_modules/electron/dist/electron.exe . --remote-debugging-port=$PORT --user-data-dir="$PROFILE" $COPY $OFFLINE > "$OUT/app.log" 2>&1 &
  fi
  for i in $(seq 1 90); do
    curl -s -m 2 http://127.0.0.1:$PORT/json/version > /dev/null && break
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
    assistant) timeout 900 python tools/assistant_test.py --user-data-dir "$PROFILE" ${EXE:+--exe "$EXE"} "$OUT/assistant" > "$OUT/$g.log" 2>&1; rc=$? ;;
    film) $T python tools/film_test.py "$OUT/film" > "$OUT/$g.log" 2>&1; rc=$? ;;
    nodecopy) NC="$SP/nodecopy"; rm -rf "$NC"; mkdir -p "$NC"; (cd "/f/Comfyui/ComfyUI_windows_portable_nvidia/ComfyUI/custom_nodes/ComfyUI-InpaintCanvas" && tar --exclude=.git --exclude=__pycache__ -cf - .) | (cd "$NC" && tar -xf -); { $T python tools/build_node.py --node "$NC" && $T python tools/build_node.py --node "$NC" --check && $T python tools/node_test.py --node "$NC"; } > "$OUT/$g.log" 2>&1; rc=$? ;;
    node) $T python tools/build_node.py --check > "$OUT/$g.log" 2>&1 && $T python tools/node_test.py >> "$OUT/$g.log" 2>&1; rc=$? ;;
    perf:*) $T python tools/perf_test.py ${g#perf:} > "$OUT/perf.log" 2>&1; rc=$? ;;
    # no app and no Python: the four rules that catch what `node --check` cannot see
    lint) timeout 600 npx eslint . > "$OUT/lint.log" 2>&1; rc=$? ;;
    # no app and no Python either: the three contracts, checked by tsc (docs/PLAN_TYPES.md)
    types) timeout 600 npx tsc --noEmit -p tsconfig.check.json > "$OUT/types.log" 2>&1; rc=$? ;;
    pxjobs) timeout 1200 python tools/px_jobs.py --check > "$OUT/pxjobs.log" 2>&1; rc=$? ;;
    huge:*) timeout 3000 python tools/huge_test.py ${g#huge:} > "$OUT/huge.log" 2>&1; rc=$? ;;
    # quit safety: it starts and ends its own instances (port +17, a profile under $OUT/quit), so no app of the runner's;
    # quit:15000x10000 is the 15k measurement of the close alone
    quit) timeout 900 python tools/quit_test.py ${EXE:+--exe "$EXE"} --out "$OUT/quit" > "$OUT/quit.log" 2>&1; rc=$? ;;
    quit:*) timeout 1800 python tools/quit_test.py ${EXE:+--exe "$EXE"} --size ${g#quit:} --only close --out "$OUT/quit" > "$OUT/quit.log" 2>&1; rc=$? ;;
    # .scumble documents (docs/PLAN_DOCUMENTS.md D5): like quit, it starts, kills and ends its own instances (port +17,
    # profiles under $OUT/document); runs tools/document_test.js first
    document) timeout 1500 python tools/document_test.py ${EXE:+--exe "$EXE"} --out "$OUT/document" > "$OUT/document.log" 2>&1; rc=$? ;;
    exportperf:*) timeout 1800 python tools/export_test.py --perf $(echo "${g#exportperf:}" | tr ',' ' ') > "$OUT/exportperf.log" 2>&1; rc=$? ;;
    # mem:15000x10000,--rounds,4 (commas for spaces); four rounds at 15k take longer than the other gates' 420 s
    mem:*) timeout 2400 python tools/mem_test.py $(echo "${g#mem:}" | tr ',' ' ') > "$OUT/mem.log" 2>&1; rc=$? ;;
    # docperf:15000x10000: a .scumble save and open at size against the runner's app (docs/PLAN_DOCUMENTS.md §7 D5)
    docperf:*) timeout 3600 python tools/document_perf.py ${g#docperf:} --out "$OUT/docperf" > "$OUT/docperf.log" 2>&1; rc=$? ;;
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
