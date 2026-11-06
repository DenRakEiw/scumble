cd /f/canvas/.claude/worktrees/corridorkey
E=./node_modules/.bin/electron; SET="$SCRATCH/ck_spike_dl/set"; ALL=blue_plate,flat_green_plant,green_plate,hair_green,highlights_green
for v in 129 130; do
  for b in 768x768 1024x1024; do
    timeout 1800 $E tools/ck_spike/main.js --set "$SET" --provider webgpu --ort "$SCRATCH/ck_i0b/ort$v/node_modules" --out "$SCRATCH/ck_i0b/runs/parity" --label "parity_webgpu_${v}_${b%%x*}" --task parity --bucket $b --ref dist/ck_ref --stills $ALL > /dev/null 2>&1; echo "webgpu $v $b rc=$?"
    timeout 1800 $E tools/ck_spike/main.js --set "$SET" --provider dml --ort "$SCRATCH/ck_i0b/ort$v/node_modules" --out "$SCRATCH/ck_i0b/runs/parity" --label "parity_dml_${v}_${b%%x*}" --task parity --bucket $b --ref dist/ck_ref --stills hair_green,highlights_green > /dev/null 2>&1; echo "dml $v $b rc=$?"
  done
done
timeout 1800 $E tools/ck_spike/main.js --set "$SET" --provider webgpu --ort "$SCRATCH/ck_i0b/ort129/node_modules" --out "$SCRATCH/ck_i0b/runs/parity" --label "parity_webgpu_129_1024_bf16in" --bf16-inputs --task parity --bucket 1024x1024 --ref dist/ck_ref --stills hair_green,highlights_green > /dev/null 2>&1; echo "webgpu bf16 rc=$?"
