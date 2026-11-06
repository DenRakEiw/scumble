cd /f/canvas/.claude/worktrees/corridorkey
E=./node_modules/.bin/electron; SET="$SCRATCH/ck_spike_dl/set"
inp() { if [ $1 -ge 768 ]; then echo "--input dist/ck_ref/hair_green/b$1_hint/in/input.png --hint dist/ck_ref/hair_green/b$1_hint/hint.png"; else echo "--input $SCRATCH/ck_i0b/inputs/hair_green_b$1/input.png --hint $SCRATCH/ck_i0b/inputs/hair_green_b$1/hint.png"; fi; }
for v in 129 130; do
  for s in 384 512 768 1024; do
    timeout 1800 $E tools/ck_spike/main.js --set "$SET" --provider webgpu --ort "$SCRATCH/ck_i0b/ort$v/node_modules" --out "$SCRATCH/ck_i0b/runs/bench" --label "bench_webgpu_${v}_$s" --task bench --bucket ${s}x${s} $(inp $s) --reps 5 --loop 10 > /dev/null 2>&1; echo "webgpu $v $s rc=$?"
  done
done
