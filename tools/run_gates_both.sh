#!/usr/bin/env bash
# Both backends side by side (docs/TESTING.md "Both backends side by side"): tools/run_gates.sh twice at the same time,
# --tiles on on one port and --tiles off on another, each with its own label, profile and temp folder.
#
#   bash tools/run_gates_both.sh <label> [--stagger S] [--ports T,C] [--copy] [--strict] [--offline] [--exe PATH]
#                                [--js-flags FLAGS] gate [gate ...]
#
# Labels <label>-tiles and <label>-canvas under $SCUMBLE_GATES/gates/ (default F:/canvas/dist/gates, as run_gates.sh);
# ports T (tiles, default 9586) and C (canvas, default 9587). The canvas side starts S seconds after the tiles side
# (default 25): an instance starting or closing beside a running gate is when the live stroke steps fail (TESTING.md
# "Known flakes"), and the stagger keeps the two instances' starts and closes apart. Each side gets its own TEMP / TMP
# (several gates write fixed names under the temp folder). The gates that cannot share the machine with another
# instance (fixed ports, their own instances, timings, the node copy) run after the side-by-side part, tiles then
# canvas, as <label>-tiles-serial and <label>-canvas-serial. Exit code 0 only when every run passed.
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="$1"; shift
[ -n "$LABEL" ] || { sed -n '2,15p' "$0"; exit 2; }
STAGGER=25; PT=9586; PC=9587; PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --stagger) STAGGER="$2"; shift 2 ;;
    --ports) PT="${2%,*}"; PC="${2#*,}"; shift 2 ;;
    --tiles) echo "run_gates_both.sh runs --tiles on and --tiles off itself"; exit 2 ;;
    --copy|--strict|--offline) PASS+=("$1"); shift ;;
    --exe|--js-flags) PASS+=("$1" "$2"); shift 2 ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || { echo "no gates given"; exit 2; }
[ "$PT" != "$PC" ] || { echo "the two sides need two ports (--ports T,C)"; exit 2; }
SP="${SCUMBLE_GATES:-/f/canvas/dist/gates}"
PAR=(); SER=(); needs_app=0
for g in "$@"; do
  case "$g" in
    smoke|mcp|mcpb|cloudjobs|portable|quit|quit:*|document|node|nodecopy|perf:*|exportperf:*|tiffperf:*|mem:*|docperf:*|huge:*|upscaleperf:*|pxjobs|pxjobs:*|pxprobe:*) SER+=("$g") ;;
    *) PAR+=("$g")
       case "$g" in lint|types) ;; *) needs_app=1 ;; esac ;;
  esac
done
mkdir -p "$SP/gates" "$SP/tmp"
t_all=$(date +%s)

# one side: run_gates.sh with its port, backend and temp folder; its lines prefixed, its exit code in a file
side() {
  local name="$1" port="$2" tiles="$3" lab="$LABEL-$1" tmp="$SP/tmp/$LABEL-$1"
  shift 3
  rm -f "$SP/gates/$lab.rc"
  rm -rf "$tmp"; mkdir -p "$tmp"
  local wtmp; wtmp="$(cygpath -w "$tmp" 2>/dev/null || echo "$tmp")"
  local t0; t0=$(date +%s)
  TEMP="$wtmp" TMP="$wtmp" TMPDIR="$wtmp" SCUMBLE_CDP_PORT="$port" bash "$DIR/run_gates.sh" "$lab" --tiles "$tiles" "${PASS[@]}" "$@" 2>&1 \
    | sed -u "s/^/[$name] /"
  local rc="${PIPESTATUS[0]}"
  echo "$rc $(( $(date +%s) - t0 ))" > "$SP/gates/$lab.rc"
}

labels=()
if [ ${#PAR[@]} -gt 0 ]; then
  echo "side by side: ${PAR[*]} (tiles on $PT, canvas on $PC$( [ "$needs_app" = 1 ] && echo ", the canvas side ${STAGGER} s later"))"
  side tiles "$PT" on "${PAR[@]}" &
  [ "$needs_app" = 1 ] && sleep "$STAGGER"
  side canvas "$PC" off "${PAR[@]}" &
  wait
  labels+=("$LABEL-tiles" "$LABEL-canvas")
fi
if [ ${#SER[@]} -gt 0 ]; then
  echo "one after the other (they cannot share the machine): ${SER[*]}"
  side tiles-serial "$PT" on "${SER[@]}"
  side canvas-serial "$PC" off "${SER[@]}"
  labels+=("$LABEL-tiles-serial" "$LABEL-canvas-serial")
fi

fail=0
for lab in "${labels[@]}"; do
  read -r rc secs < "$SP/gates/$lab.rc" 2>/dev/null || { rc=1; secs=?; }
  echo "== $lab (rc $rc, ${secs} s): $SP/gates/$lab/summary.txt"
  sed 's/^/   /' "$SP/gates/$lab/summary.txt" 2>/dev/null || echo "   no summary"
  [ "$rc" = 0 ] || fail=1
done
echo "wall time $(( $(date +%s) - t_all )) s"
[ "$fail" = 0 ] && echo "BOTH PASS" || echo "SOME FAILED"
exit $fail
