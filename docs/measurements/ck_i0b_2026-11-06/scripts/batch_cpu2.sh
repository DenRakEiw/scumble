cd /f/canvas/.claude/worktrees/corridorkey
timeout 1500 ./node_modules/.bin/electron tools/ck_spike/main.js --set "$SCRATCH/ck_spike_dl/set" --provider cpu --ort "$SCRATCH/ck_i0b/ort129/node_modules" --out "$SCRATCH/ck_i0b/runs/bench" --label "stagesref_cpu_129_768" --task stagesref --bucket 768x768 --refcase dist/ck_ref/hair_green/b768_hint > /dev/null 2>&1; echo "cpu stagesref rc=$?"
