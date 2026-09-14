#!/usr/bin/env bash
# JackOD4-AC on eleven2go — the SAME model and build as lane 2's solidPC arm,
# on a second host, to buy n without buying wall-clock.
#
# Why this is legitimate to pool with lane 2: the primary scorers are
# restores/run, iterations/run, transactions closed and verdict mix, and none
# of those is a function of how fast the card is. Wall time IS, so wall time
# from this lane must never be pooled with solidPC's — report it separately or
# not at all.
#
# CLI_DIR is the HARNESS tree, per docs/protocols/BUILD-RELEASE-DEPLOY.md, so
# that building in /srv/dev-disk-by-label-opt/dev/cline cannot disturb a run.
# /shared/dev/cline-scan is checked out at 62e260f7b with its dist rebuilt.
set -uo pipefail
H=/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness
cd "$H"
export MODEL=jackod4ac-9b_tb:q6_k-128k
export OLLAMA_BASE_URL=http://192.168.178.161:11434
export CLI_DIR=/shared/dev/cline-scan/apps/cli
echo "jackod4ac-e2g: start $(date '+%F %T')  CLI_DIR=$CLI_DIR  MODEL=$MODEL"
./native.sh 5
echo ">>> JACKOD4AC_E2G_DONE $(date '+%F %T')"
