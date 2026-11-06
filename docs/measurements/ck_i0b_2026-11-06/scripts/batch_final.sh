cd /f/canvas/.claude/worktrees/corridorkey
echo "bisect start $(date -u +%H:%M:%S)"
python -I tools/ck_spike/bisect_dml.py "$SCRATCH/ck_spike_dl/set/stage1_384x384_t1.onnx" "$SCRATCH/ck_spike_dl/set/stage1.weights" "$SCRATCH/ck_i0b/bisect" "$SCRATCH/ck_i0b/ort129/node_modules" nofusion > "$SCRATCH/ck_i0b/runs/bisect_dml_nofusion.jsonl" 2>&1
echo "bisect rc=$? $(date -u +%H:%M:%S)"
timeout 900 ./node_modules/.bin/electron tools/ck_spike/main.js --set "$SCRATCH/ck_spike_dl/set" --provider cpu --ort "$SCRATCH/ck_i0b/ort129/node_modules" --out "$SCRATCH/ck_i0b/runs/bench" --label "stagesref_cpu_129_768" --task stagesref --bucket 768x768 --refcase dist/ck_ref/hair_green/b768_hint > /dev/null 2>&1; echo "cpu stagesref rc=$? $(date -u +%H:%M:%S)"
