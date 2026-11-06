#!/bin/bash
# I0a: the model download under the machine's busy lock (released on any exit).
S="${SCRATCH:?set SCRATCH to the session scratchpad}"
LOCKPY=/f/canvas/docs/measurements/w1_2026-11-06/w1_lock.py
cd "$S" || exit 9
TOKEN=$(python "$LOCKPY" acquire "CK I0a: model download 5.1 GB (CK2, C-RADIO, MoGe, RVM)")
[ -n "$TOKEN" ] || { echo "lock not taken"; exit 3; }
trap 'python "$LOCKPY" release "$TOKEN"' EXIT
echo "start $(date -u +%FT%TZ)"
python -I ck_scripts/ck_fetch.py fetch
rc=$?
echo "end $(date -u +%FT%TZ) rc=$rc"
exit $rc
