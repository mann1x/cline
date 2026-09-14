#!/usr/bin/env bash
# Paragraph A/B, "paragraph OUT" arm. Build is 4.100.98 with exactly one thing
# removed: the 368-char paragraph added by 0687257de ("A program you write
# yourself is not that check..."). Everything else is byte-identical to the .98
# arm (runs 0217-0236), which is the "paragraph IN" side.
# PRIMARY scorer is tool-call composition (run_check vs run_commands), not wall
# time: the paragraph is one change inside the .73->.98 range, so its wall-time
# effect is too small to resolve at n=10, while its behavioural signature is not.
set -uo pipefail
H=/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness
cd "$H"
export MODEL=qwen36-base-mtp_tb:27b-q4km-128k
export OLLAMA_BASE_URL=http://192.168.178.161:11434
export CLI_DIR=/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/cline-nopara/apps/cli
echo "qwen36-nopara: start $(date '+%F %T')  CLI_DIR=$CLI_DIR"
./native.sh 10
echo ">>> QWEN36_NOPARA_DONE $(date '+%F %T')"
