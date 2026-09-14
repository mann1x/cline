#!/usr/bin/env bash
# JackOD4-AC on eleven2go -- the SAME model and build as the solidPC arm, on
# a second host, to buy n without buying wall-clock. Wall time from this lane
# must never be pooled with solidPC's; restores/run, iterations/run,
# transactions closed and verdict mix are not functions of card speed.
# Sampling arm: temperature 0.4, presence_penalty 0, repeat_penalty 1.05,
# min_p 0.05 (was temp 0.6, presence_penalty 1.5, no repeat_penalty, no min_p).
# Tag jackod4ac-9b_tb:q6_k-128k-t04, built via the JSON create API on both hosts
# from the same blob sha256-dbdf9a154f5b5... so the two lanes are byte-identical.
#
# Two confounds in the PREVIOUS arm that this one removes, and which mean the
# old eleven2go numbers are not a usable baseline for this lane:
#   - eleven2go's jackod4ac tag had a quoted, unterminated TEMPLATE, which
#     swallowed every directive after it. Its effective parameters were only
#     num_ctx/top_k/top_p: no temperature, no presence_penalty, and NO
#     think_budget at all.
#   - solidPC and pandorum disagreed with each other anyway (temp 0.6 vs 0.7,
#     repeat_penalty absent vs 1.1).
#
# Build under test: 7d465bd84 -- 4.100.104. The protocol no longer submits
# the transaction for the model. Three fixes, in the order they were found:
#   - onCompletionAttempt no longer stands the protocol down on an untouched
#     first transaction unless the check agrees the task is done.
#   - an empty submission no longer spends a transaction that no tool was ever
#     called in. DEFAULT_MAX_UNSTARTED_ATTEMPTS=6 is the backstop.
#   - submission is now a deliberate act: the model calls submit_transaction
#     when it is confident, and the harness answers with the check result. A
#     turn that called nothing is no longer read as a submission; it nudges,
#     and only DEFAULT_SILENT_TURNS_BEFORE_GUARD=3 consecutive silent turns
#     reach the guard.
#
# Both hosts are on ollama 0.34.0-thinkbudget (aligned 2026-09-12). The
# vendored llama.cpp is byte-identical to 0.33.3, so the runtime is unchanged
# and only the Go binary moved.
#
# CLI_DIR is the HARNESS tree, per docs/protocols/BUILD-RELEASE-DEPLOY.md.
# /shared/dev/cline-scan is checked out at 027930500 with its dist rebuilt.
set -uo pipefail
H=/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness
cd "$H"
export MODEL=jackod4ac-9b_tb:q6_k-128k-t04
export OLLAMA_BASE_URL=http://192.168.178.161:11434
export CLI_DIR=/shared/dev/cline-scan/apps/cli
echo "jackod4ac-t04-e2g: start $(date '+%F %T')  CLI_DIR=$CLI_DIR  MODEL=$MODEL"
./native.sh 10
echo ">>> JACKOD4AC_T04_E2G_DONE $(date '+%F %T')"
