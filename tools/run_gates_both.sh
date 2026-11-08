#!/usr/bin/env bash
# Both backends side by side (docs/TESTING.md "Both backends side by side"): tools/run_gates.sh twice at the same time,
# --tiles on on one port and --tiles off on another, each with its own label, profile and temp folder.
#
#   bash tools/run_gates_both.sh <label> [--stagger S] [--ports T,C[,P,...]] [--shards N] [--lock PATH] [--copy] [--strict]
#                                [--offline] [--exe PATH] [--js-flags FLAGS] gate [gate ...]
#
# Labels <label>-tiles and <label>-canvas under $SCUMBLE_GATES/gates/ (default F:/canvas/dist/gates, as run_gates.sh);
# ports T (tiles, default 9586) and C (canvas, default 9587). The canvas side starts S seconds after the tiles side
# (default 25): an instance starting or closing beside a running gate is when the live stroke steps fail (TESTING.md
# "Known flakes"), and the stagger keeps the two instances' starts and closes apart. Each side gets its own TEMP / TMP
# (several gates write fixed names under the temp folder). The gates that cannot share the machine with another
# instance (fixed ports, their own instances, timings, the node copy) run after the side-by-side part, tiles then
# canvas, as <label>-tiles-serial and <label>-canvas-serial. Exit code 0 only when every run passed.
#
# --shards N (TESTING.md "The editor gate in shards"): the editor gate runs on each backend as N groups of its steps,
# each group on an instance, port, profile and temp folder of its own (labels <label>-tiles-editor1 .. N, the same for
# canvas), planned by tools/editor_shards.py from the newest timed editor logs (equal counts without one) and checked
# by it after: the editor gate of a backend passes only when every group passed and every step ran exactly once
# (<label>-tiles-editor/summary.txt). The other gates of the side-by-side part run on each backend's own instance as
# before (<label>-tiles, <label>-canvas), minus the editor. The runs share the ports given (--ports with as many as
# you like; a run waits for a free port), each start S seconds after the one before (default 10 with --shards).
# --lock PATH: before each run starts, the script waits (60 s polls) while that busy-lock file exists; the runs that
# waited then start one stagger apart, as the others do.
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="$1"; shift
[ -n "$LABEL" ] || { sed -n '2,24p' "$0"; exit 2; }
STAGGER=""; PORTS="9586,9587"; SHARDS=1; LOCK=""; PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --stagger) STAGGER="$2"; shift 2 ;;
    --ports) PORTS="$2"; shift 2 ;;
    --shards) SHARDS="$2"; shift 2 ;;
    --lock) LOCK="$2"; shift 2 ;;
    --tiles) echo "run_gates_both.sh runs --tiles on and --tiles off itself"; exit 2 ;;
    --copy|--strict|--offline) PASS+=("$1"); shift ;;
    --exe|--js-flags) PASS+=("$1" "$2"); shift 2 ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || { echo "no gates given"; exit 2; }
IFS=, read -r -a PORTL <<< "$PORTS"
[ ${#PORTL[@]} -ge 2 ] || { echo "the two sides need two ports (--ports T,C)"; exit 2; }
[ "$(printf '%s\n' "${PORTL[@]}" | sort -u | wc -l)" = "${#PORTL[@]}" ] || { echo "the two sides need two ports (--ports T,C)"; exit 2; }
case "$SHARDS" in ''|*[!0-9]*) echo "--shards takes a number"; exit 2 ;; esac
PT="${PORTL[0]}"; PC="${PORTL[1]}"
SP="${SCUMBLE_GATES:-/f/canvas/dist/gates}"
PAR=(); SER=(); needs_app=0; has_editor=0
for g in "$@"; do
  case "$g" in
    smoke|mcp|mcpb|cli|cloudjobs|portable|quit|quit:*|document|node|nodecopy|perf:*|exportperf:*|tiffperf:*|mem:*|docperf:*|huge:*|upscaleperf:*|pxjobs|pxjobs:*|pxprobe:*|helpers) SER+=("$g") ;;
    *) PAR+=("$g")
       [ "$g" = editor ] && has_editor=1
       case "$g" in lint|types) ;; *) needs_app=1 ;; esac ;;
  esac
done
if [ "$SHARDS" -gt 1 ] && [ "$has_editor" = 0 ]; then echo "--shards $SHARDS: no editor gate among the gates, nothing to split"; SHARDS=1; fi
if [ "$SHARDS" -gt 1 ] && [ -n "$SCUMBLE_EDITOR_ONLY" ]; then echo "--shards splits the whole editor gate, but SCUMBLE_EDITOR_ONLY is set"; exit 2; fi
[ -n "$STAGGER" ] || { [ "$SHARDS" -gt 1 ] && STAGGER=10 || STAGGER=25; }
mkdir -p "$SP/gates" "$SP/tmp"
t_all=$(date +%s)

# one run: run_gates.sh with its port, backend and temp folder (and its editor group); its lines prefixed, its exit
# code and time in a file
side() {
  local name="$1" port="$2" tiles="$3" only="$4" shard="$5" lab="$LABEL-$1" tmp="$SP/tmp/$LABEL-$1"
  shift 5
  rm -f "$SP/gates/$lab.rc"
  rm -rf "$tmp"; mkdir -p "$tmp"
  local wtmp; wtmp="$(cygpath -w "$tmp" 2>/dev/null || echo "$tmp")"
  if [ -n "$only" ]; then export SCUMBLE_EDITOR_ONLY="$only" SCUMBLE_EDITOR_SHARD="$shard"; fi
  local t0; t0=$(date +%s)
  TEMP="$wtmp" TMP="$wtmp" TMPDIR="$wtmp" SCUMBLE_CDP_PORT="$port" bash "$DIR/run_gates.sh" "$lab" --tiles "$tiles" "${PASS[@]}" "$@" 2>&1 \
    | sed -u "s/^/[$name] /"
  local rc="${PIPESTATUS[0]}"
  local t1; t1=$(date +%s)
  echo "$rc $(( t1 - t0 )) $t0 $t1" > "$SP/gates/$lab.rc"
}

# --lock: wait (60 s polls) while the busy lock exists; called before every run starts, by the code that starts it, so
# runs that waited start one stagger apart again; exit 0 when it waited
wait_lock() {
  [ -n "$LOCK" ] && [ -e "$LOCK" ] || return 1
  echo "waiting for the busy lock $LOCK"
  while [ -e "$LOCK" ]; do sleep 60; done
  return 0
}

labels=()
if [ ${#PAR[@]} -gt 0 ] && [ "$SHARDS" -le 1 ]; then
  echo "side by side: ${PAR[*]} (tiles on $PT, canvas on $PC$( [ "$needs_app" = 1 ] && echo ", the canvas side ${STAGGER} s later"))"
  wait_lock
  side tiles "$PT" on "" "" "${PAR[@]}" &
  [ "$needs_app" = 1 ] && sleep "$STAGGER"
  wait_lock && [ "$needs_app" = 1 ] && sleep "$STAGGER"
  side canvas "$PC" off "" "" "${PAR[@]}" &
  wait
  labels+=("$LABEL-tiles" "$LABEL-canvas")
elif [ ${#PAR[@]} -gt 0 ]; then
  # the runs: each backend's other gates first, then the editor groups of both backends in turn
  REST=(); rest_app=0
  for g in "${PAR[@]}"; do [ "$g" = editor ] || { REST+=("$g"); case "$g" in lint|types) ;; *) rest_app=1 ;; esac; }; done
  J_NAME=(); J_TILES=(); J_ONLY=(); J_SHARD=(); J_GATES=(); J_APP=()
  if [ ${#REST[@]} -gt 0 ]; then
    for b in tiles canvas; do
      J_NAME+=("$b"); J_TILES+=("$([ $b = tiles ] && echo on || echo off)"); J_ONLY+=(""); J_SHARD+=(""); J_GATES+=("${REST[*]}"); J_APP+=("$rest_app")
      labels+=("$LABEL-$b")
    done
  fi
  for b in tiles canvas; do
    mkdir -p "$SP/gates/$LABEL-$b-editor"
    python "$DIR/editor_shards.py" plan "$SHARDS" --backend "$b" --logs "$SP/gates" --out "$SP/gates/$LABEL-$b-editor/plan.json" \
      > "$SP/gates/$LABEL-$b-editor/groups.txt" 2> "$SP/gates/$LABEL-$b-editor/plan.txt" \
      || { cat "$SP/gates/$LABEL-$b-editor/plan.txt"; echo "the shard plan failed"; exit 1; }
    sed "s/^/[$b-editor] /" "$SP/gates/$LABEL-$b-editor/plan.txt"
  done
  mapfile -t GT < "$SP/gates/$LABEL-tiles-editor/groups.txt"
  mapfile -t GC < "$SP/gates/$LABEL-canvas-editor/groups.txt"
  for i in "${!GT[@]}"; do
    for b in tiles canvas; do
      if [ $b = tiles ]; then grp="${GT[$i]}"; n=${#GT[@]}; else grp="${GC[$i]}"; n=${#GC[@]}; fi
      [ -n "$grp" ] || continue
      J_NAME+=("$b-editor$((i + 1))"); J_TILES+=("$([ $b = tiles ] && echo on || echo off)"); J_ONLY+=("$grp")
      J_SHARD+=("$((i + 1))/$n"); J_GATES+=("editor"); J_APP+=(1)
    done
  done
  echo "side by side: ${#J_NAME[@]} runs (${REST[*]:+${REST[*]} on each backend, }the editor in $SHARDS groups per backend) on ports ${PORTL[*]}, each start ${STAGGER} s after the one before"
  declare -A BUSY=()
  last=0
  for j in "${!J_NAME[@]}"; do
    port=""
    while [ -z "$port" ]; do
      for p in "${PORTL[@]}"; do
        pid="${BUSY[$p]}"
        if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then port="$p"; break; fi
      done
      [ -n "$port" ] || sleep 2
    done
    # the busy lock first, then the stagger from the last start (after a wait the first run goes at once, the next
    # ones one stagger apart)
    wait_lock
    if [ "${J_APP[$j]}" = 1 ] && [ "$last" -gt 0 ]; then
      gap=$(( last + STAGGER - $(date +%s) )); [ "$gap" -gt 0 ] && sleep "$gap"
    fi
    # shellcheck disable=SC2086
    side "${J_NAME[$j]}" "$port" "${J_TILES[$j]}" "${J_ONLY[$j]}" "${J_SHARD[$j]}" ${J_GATES[$j]} &
    BUSY[$port]=$!
    [ "${J_APP[$j]}" = 1 ] && last=$(date +%s)
  done
  wait
  # each backend's editor: every group passed and every step ran exactly once
  for b in tiles canvas; do
    E="$SP/gates/$LABEL-$b-editor"; logs=(); secs=(); t_first=""; t_last=""; bad_rc=()
    n=$(wc -l < "$E/groups.txt")
    for i in $(seq 1 "$n"); do
      logs+=("$SP/gates/$LABEL-$b-editor$i/editor.log")
      r=""; s="?"; a=""; z=""
      read -r r s a z < "$SP/gates/$LABEL-$b-editor$i.rc" 2>/dev/null
      # a run that printed PASS can still end red (its timeout, a teardown): its exit code counts as well as its log
      if [ -z "$r" ]; then bad_rc+=("[FAIL] shard $i ($LABEL-$b-editor$i): no exit code (its .rc file is missing)")
      elif [ "$r" != 0 ]; then bad_rc+=("[FAIL] shard $i ($LABEL-$b-editor$i): run_gates.sh ended with exit code $r"); fi
      secs+=("$s s")
      if [ -n "$a" ]; then
        { [ -z "$t_first" ] || [ "$a" -lt "$t_first" ]; } && t_first="$a"
        { [ -z "$t_last" ] || [ "$z" -gt "$t_last" ]; } && t_last="$z"
      fi
    done
    verdict=$(python "$DIR/editor_shards.py" check "$E/plan.json" "${logs[@]}")
    rc=$?
    {
      for x in "${bad_rc[@]}"; do echo "$x"; done
      echo "$verdict"
      if [ ${#bad_rc[@]} -gt 0 ] && [ "$rc" = 0 ]; then echo "FAIL (the logs' check passed, but ${#bad_rc[@]} shard run(s) ended red)"; fi
    } > "$E/check.txt"
    [ ${#bad_rc[@]} -gt 0 ] && rc=1
    w="${secs[*]}"
    echo "editor rc=$rc $n shards (each run from start to close: ${w// s / s, }) $(tail -1 "$E/check.txt")" > "$E/summary.txt"
    [ "$rc" = 0 ] && echo "ALL PASS" >> "$E/summary.txt" || { grep -a "^\[FAIL\]" "$E/check.txt" | head -20 >> "$E/summary.txt"; echo "SOME FAILED" >> "$E/summary.txt"; }
    echo "$rc $([ -n "$t_first" ] && echo $(( t_last - t_first )) || echo "?")" > "$SP/gates/$LABEL-$b-editor.rc"
    labels+=("$LABEL-$b-editor")
    for i in $(seq 1 "$n"); do labels+=("$LABEL-$b-editor$i"); done
  done
fi
if [ ${#SER[@]} -gt 0 ]; then
  echo "one after the other (they cannot share the machine): ${SER[*]}"
  wait_lock; side tiles-serial "$PT" on "" "" "${SER[@]}"
  wait_lock; side canvas-serial "$PC" off "" "" "${SER[@]}"
  labels+=("$LABEL-tiles-serial" "$LABEL-canvas-serial")
fi

fail=0
for lab in "${labels[@]}"; do
  read -r rc secs _ < "$SP/gates/$lab.rc" 2>/dev/null || { rc=1; secs=?; }
  echo "== $lab (rc $rc, ${secs} s): $SP/gates/$lab/summary.txt"
  sed 's/^/   /' "$SP/gates/$lab/summary.txt" 2>/dev/null || echo "   no summary"
  [ "$rc" = 0 ] || fail=1
done
echo "wall time $(( $(date +%s) - t_all )) s"
[ "$fail" = 0 ] && echo "BOTH PASS" || echo "SOME FAILED"
exit $fail
