#!/usr/bin/env bash
# px_test before / after PX_ONLY: the same checks in the same order, the unknown-name error, a filtered run's times
cd /f/canvas/.claude/worktrees/agent-a7dd53734239fe794 || exit 1
L='C:\Users\SCHOEN~1\AppData\Local\Temp\claude\F--canvas\543d44fb-4d2d-4818-8804-974916d10a44\scratchpad\machine_busy.lock'
while [ -e "$L" ]; do sleep 10; done
S='C:/Users/SCHOEN~1/AppData/Local/Temp/claude/9a199ca2a3624e76/cedffc32-4015-48b3-9701-7b53ab2707ce/scratchpad/testspeed_f'
node --check tools/px_test.js && echo syntax-ok
PX_ONLY=mask,dabx node tools/px_test.js; echo "unknown name rc=$?"
t0=$(date +%s)
node tools/px_test.js > "$S/px_full_after.txt" 2>&1
echo "full rc=$? $(( $(date +%s) - t0 ))s ok=$(grep -c '^ok ' $S/px_full_after.txt) fail=$(grep -c '^FAIL' $S/px_full_after.txt) last: $(tail -1 $S/px_full_after.txt)"
strip() { grep -E '^(ok  |FAIL) ' "$1" | sed -E 's/  .*$//'; }
if diff <(strip $S/px_full_before.txt) <(strip $S/px_full_after.txt) > "$S/px_titles.diff"; then echo "check titles identical, same order"; else echo "titles differ:"; head -20 "$S/px_titles.diff"; fi
t0=$(date +%s)
PX_ONLY=mask,dab PX_TIMES=1 node tools/px_test.js > "$S/px_maskdab.txt" 2>&1
echo "mask,dab rc=$? $(( $(date +%s) - t0 ))s ok=$(grep -c '^ok ' $S/px_maskdab.txt) last: $(tail -1 $S/px_maskdab.txt)"
grep -E "^PX_ONLY|group " "$S/px_maskdab.txt"
