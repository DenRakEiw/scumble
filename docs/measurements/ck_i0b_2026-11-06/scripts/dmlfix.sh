cd /f/canvas/.claude/worktrees/corridorkey
OUT="$SCRATCH/ck_i0b/runs/placement_dmlvariants"
for v in 129 130; do
  for variant in "--opt basic" "--opt disabled" "--dml-nofusion"; do
    tag=$(echo "$variant" | tr -d ' -')
    timeout 900 ./node_modules/.bin/electron tools/ck_spike/main.js --set "$SCRATCH/ck_spike_dl/set" --provider dml --ort "$SCRATCH/ck_i0b/ort$v/node_modules" --out "$OUT" --label "placement_dml_${v}_1024_$tag" --task placement --bucket 1024x1024 $variant > /dev/null 2>&1
    echo "$v $variant rc=$?"
  done
done
