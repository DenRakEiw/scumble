#!/usr/bin/env bash
# I0b: run "$@" under the machine's busy lock (w1_lock.py): acquire (waits up to 60 min), run, release (also on failure).
# usage: locked.sh "<what>" cmd args...   The times go to stdout and to $SP/ck_i0b/lock_times.log.
set -u
SP="$SCRATCH"
WHAT="$1"; shift
T_REQ=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TOKEN=$(python /f/canvas/docs/measurements/w1_2026-11-06/w1_lock.py acquire "$WHAT")
rc=$?
if [ "$rc" != 0 ] || [ -z "$TOKEN" ]; then
  echo "LOCK NOT TAKEN ($rc) requested $T_REQ for: $WHAT" | tee -a "$SP/ck_i0b/lock_times.log"
  exit 99
fi
T_GOT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
release() { python /f/canvas/docs/measurements/w1_2026-11-06/w1_lock.py release "$TOKEN"; echo "lock '$WHAT' requested $T_REQ taken $T_GOT released $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$SP/ck_i0b/lock_times.log"; }
trap release EXIT
"$@"
