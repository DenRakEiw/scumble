#!/usr/bin/env bash
# K40 interim: which commit moved the pan and full-composite rows? Runs `perf:15000x10000` three times on evenly spaced
# first-parent commits of wasm-kernels between the W0b baseline and the given tip, in a throw-away worktree.
# Usage: bash bisect_perf.sh <outdir> <from> <to> <points> [port]
set -u
OUT="$1"; FROM="$2"; TO="$3"; POINTS="$4"; PORT="${5:-9555}"   # 9555: the harness of the oldest commits knows no other port
ROOT=/f/canvas; WT=$ROOT/.claude/worktrees/k40-bisect
mkdir -p "$OUT"
cd "$ROOT"
mapfile -t ALL < <(git log --first-parent --reverse --format=%h "$FROM..$TO")
N=${#ALL[@]}
echo "commits on the first-parent line: $N"
[ -d "$WT" ] || git worktree add --detach -q "$WT" "$TO"
[ -e "$WT/node_modules" ] || (cd "$WT" && cmd //c mklink /J node_modules 'F:\canvas\node_modules' > /dev/null)
[ -e "$WT/node_modules/electron/dist/electron.exe" ] || { echo "no node_modules in the worktree"; exit 2; }
PICK=("$FROM")
for ((i = 1; i < POINTS; i++)); do PICK+=("${ALL[$(( (N - 1) * i / (POINTS - 1) ))]}"); done
: > "$OUT/table.txt"
for C in "${PICK[@]}"; do
  git -C "$WT" checkout -q --detach "$C" || { echo "$C: checkout failed" | tee -a "$OUT/table.txt"; continue; }
  TOKEN=$(python docs/measurements/w1_2026-11-06/w1_lock.py acquire "main loop K40 bisect $C")
  cd "$WT"
  for r in 1 2 3; do
    SCUMBLE_CDP_PORT=$PORT SCUMBLE_GATES="$OUT/$C/r$r" bash tools/run_gates.sh perf --offline --tiles on perf:15000x10000 > /dev/null 2>&1
    rm -rf "$OUT/$C/r$r/profiles"
  done
  cd "$ROOT"
  python docs/measurements/w1_2026-11-06/w1_lock.py release "$TOKEN" > /dev/null 2>&1
  row() { grep -hE "^$1" "$OUT/$C"/r*/gates/perf/perf.log | awk -v FS='  +' '{print $2}' | awk '{printf "%s ", $1}'; }
  S=$(git log -1 --format=%s "$C" | cut -c1-60)
  printf '%s | pan %s| composite %s| fit-masked %s| %s\n' "$C" "$(row 'pan \(60')" "$(row 'full composite')" "$(row 'pan at fit, masked')" "$S" | tee -a "$OUT/table.txt"
done
echo done
