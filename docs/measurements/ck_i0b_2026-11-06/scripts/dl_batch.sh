#!/usr/bin/env bash
SP="$SCRATCH"
set -u
echo "start $(date -u +%H:%M:%SZ)"
python -I "$SP/ck_i0b/scripts/nucito_fetch.py" "$SP/ck_i0b/meta/nucito_tree.json" "$SP/ck_spike_dl" "$SP/ck_i0b/meta/nucito_fetch_log.json"
echo "nucito rc=$? $(date -u +%H:%M:%SZ)"
for v in 1.29.0 1.30.0; do
  d="$SP/ck_i0b/ort${v//./}"; d="${d%0}"
  (cd "$d" && npm install --prefix "$d" "onnxruntime-node@$v" --ignore-scripts --no-audit --no-fund --no-save --loglevel=warn)
  echo "npm $v rc=$? $(date -u +%H:%M:%SZ)"
done
