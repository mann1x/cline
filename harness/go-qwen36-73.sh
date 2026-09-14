#!/usr/bin/env bash
# .73 side of the wall-time comparison. Same model, endpoint, oracle and harness
# as the .98 arm (runs 0217-0236); the ONLY thing that moves is the build:
# 4.100.98 working tree -> 4.100.73 clean checkout of 6dc1cbc5b.
# Grows the .73 side from n=5 to n=15 so the .73-vs-.98 median gap can be tested.
set -uo pipefail
H=/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness
cd "$H"
export MODEL=qwen36-base-mtp_tb:27b-q4km-128k
export OLLAMA_BASE_URL=http://192.168.178.161:11434
export CLI_DIR=/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/cline-73/apps/cli
echo "qwen36-73: start $(date '+%F %T')  CLI_DIR=$CLI_DIR"
./native.sh 10
echo ">>> QWEN36_73_DONE $(date '+%F %T')"
