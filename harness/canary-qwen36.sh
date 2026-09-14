#!/usr/bin/env bash
# Pause the jackod arm after the run in flight, then one canary run of
# qwen36-base-mtp_tb:27b-q4km-128k.
#
# Why this model: it is the only recent arm with a clean, unambiguous result on
# this harness -- runs 0192-0196, 5 FIXED of 5, 468-1005s -- and all five of its
# archived after-files still pass the *new* 400-frame oracle at
# player_frames=219, so the baseline holds under the standard it will be judged
# by. If it fails here, the fault is in what changed today, not in the model.
#
# It does NOT rebuild anything. sdk/packages/core/dist is deliberately stale
# (14:10) so the canary measures the same build the jackod arm did.
set -uo pipefail
H="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOP_PID="${1:?usage: canary-qwen36.sh <loop-pid>}"

echo "canary: waiting for loop $LOOP_PID to finish its run..."
while [[ -d /proc/$LOOP_PID ]]; do sleep 20; done
echo "canary: loop $LOOP_PID gone at $(date '+%F %T')"

# The sentinel did its job; take it away so the next arm is not stopped by it.
rm -f "$H/STOP-NATIVE"

cd "$H" || exit 1
CLI_DIR=/srv/dev-disk-by-label-opt/dev/cline/apps/cli \
MODEL=qwen36-base-mtp_tb:27b-q4km-128k \
OLLAMA_BASE_URL=http://eleven2go:11434 \
./native.sh 1
echo "canary: done at $(date '+%F %T')"
echo ">>> CANARY_QWEN36_DONE"
