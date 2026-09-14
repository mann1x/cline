#!/usr/bin/env bash
# qwen3.6 27B on eleven2go: the CONTROL arm.
# CLI_DIR is the HARNESS tree, per docs/protocols/BUILD-RELEASE-DEPLOY.md. It is
# not the build tree: `bun run package` there starts with `build:sdk`, which
# rewrites the exact dist a running experiment executes from. The first attempt
# at this arm ran from the build tree and had to be abandoned for that reason.
# /shared/dev/cline-scan is checked out at 62e260f7b with its dist rebuilt.
#
# Tests four commits:
#   08bc73a6e  qwen.md: batch gathering, not edits
#   4b9c379b8  three checks over unchanged files settle the transaction
#   e8f75827e  the 3rd restore in a transaction says what that many means
#   6db52bcf4  protocol.ts: make the planned changes one at a time
#
# Baseline: 40/40 FIXED across four closed arms, 0.23 restore_file per run.
# No room to improve, every room to regress -- a regression here kills the
# change whatever the jackod lane does.
set -uo pipefail
H=/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness
cd "$H"
export MODEL=qwen36-base-mtp_tb:27b-q4km-128k
export OLLAMA_BASE_URL=http://192.168.178.161:11434
export CLI_DIR=/shared/dev/cline-scan/apps/cli
echo "qwen36-stall2: start $(date '+%F %T')  CLI_DIR=$CLI_DIR"
./native.sh 10
echo ">>> QWEN36_STALL_DONE $(date '+%F %T')"
