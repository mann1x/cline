#!/usr/bin/env bash
# Validation arm for Cline 4.100.98 on the updated harness.
# Same model, endpoint and oracle as the 0192-0196 and 0216 baselines, so the
# only thing that moved is the build: .90/.97 -> .98 (empty-submission guard
# now spends the transaction instead of ending the run, plus the plan tool).
set -uo pipefail
H=/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness
cd "$H"
export MODEL=qwen36-base-mtp_tb:27b-q4km-128k
export OLLAMA_BASE_URL=http://192.168.178.161:11434
export CLI_DIR=/srv/dev-disk-by-label-opt/dev/cline/apps/cli
echo "qwen36-validate98: start $(date '+%F %T')"
./native.sh 10
echo ">>> QWEN36_VALIDATE98_DONE $(date '+%F %T')"
