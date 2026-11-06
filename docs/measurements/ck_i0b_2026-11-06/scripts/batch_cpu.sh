cd /f/canvas/.claude/worktrees/corridorkey
E=./node_modules/.bin/electron; SET="$SCRATCH/ck_spike_dl/set"
for v in 129 130; do
  timeout 2400 $E tools/ck_spike/main.js --set "$SET" --provider cpu --ort "$SCRATCH/ck_i0b/ort$v/node_modules" --out "$SCRATCH/ck_i0b/runs/bench" --label "bench_cpu_${v}_768" --task bench --bucket 768x768 --input dist/ck_ref/hair_green/b768_hint/in/input.png --hint dist/ck_ref/hair_green/b768_hint/hint.png --reps 2 --loop 3 > /dev/null 2>&1; echo "cpu bench $v rc=$?"
done
timeout 2400 $E tools/ck_spike/main.js --set "$SET" --provider cpu --ort "$SCRATCH/ck_i0b/ort129/node_modules" --out "$SCRATCH/ck_i0b/runs/parity" --label "parity_cpu_129_768" --task parity --bucket 768x768 --ref dist/ck_ref --stills hair_green,highlights_green > /dev/null 2>&1; echo "cpu parity rc=$?"
