cd /f/canvas/.claude/worktrees/corridorkey
OUT="$SCRATCH/ck_i0b/runs/placement"
for v in 129 130; do for p in dml webgpu cpu; do for b in 768x768 1024x1024; do
  timeout 900 ./node_modules/.bin/electron tools/ck_spike/main.js --set "$SCRATCH/ck_spike_dl/set" --provider $p --ort "$SCRATCH/ck_i0b/ort$v/node_modules" --out "$OUT" --label "placement_${p}_${v}_${b%%x*}" --task placement --bucket $b > /dev/null 2>&1
  echo "$p $v $b rc=$?"
done; done; done
