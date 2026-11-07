#!/usr/bin/env bash
# The same gate list on both backends: one after the other (run_gates.sh twice) against side by side
# (run_gates_both.sh), then side by side without the stagger. Ports 9586 / 9587, --offline.
cd /f/canvas/.claude/worktrees/agent-a7dd53734239fe794 || exit 1
L='C:\Users\SCHOEN~1\AppData\Local\Temp\claude\F--canvas\543d44fb-4d2d-4818-8804-974916d10a44\scratchpad\machine_busy.lock'
waitlock() { while [ -e "$L" ]; do echo "waiting for the busy lock"; sleep 10; done; }
export SCUMBLE_GATES='C:/Users/SCHOEN~1/AppData/Local/Temp/claude/9a199ca2a3624e76/cedffc32-4015-48b3-9701-7b53ab2707ce/scratchpad/testspeed_f/gates'
GATES="${GATES:-lint types editor brush}"
case "$1" in
  seq)
    waitlock; t0=$(date +%s)
    SCUMBLE_CDP_PORT=9586 bash tools/run_gates.sh seq-tiles --offline --tiles on $GATES
    t1=$(date +%s)
    waitlock
    SCUMBLE_CDP_PORT=9587 bash tools/run_gates.sh seq-canvas --offline --tiles off $GATES
    t2=$(date +%s)
    echo "SEQUENTIAL: tiles $((t1 - t0)) s, canvas $((t2 - t1)) s, together $((t2 - t0)) s" ;;
  both)
    waitlock; t0=$(date +%s)
    bash tools/run_gates_both.sh "${2:-par}" --offline ${3:+--stagger $3} $GATES
    echo "SIDE BY SIDE (${2:-par}, stagger ${3:-25}): $(( $(date +%s) - t0 )) s" ;;
esac
