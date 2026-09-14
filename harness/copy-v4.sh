#!/usr/bin/env bash
# Copy the v4 blobs to eleven2go, detached. scp does not resume, so the 16 GB
# weights restart from zero; that is cheaper than fighting the tool timeout,
# and the link is contended with the live batch so it takes ~20 min.
set -uo pipefail
MS=/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/ollama_models
LOG=/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness/copy-v4.log
say() { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOG"; }
say "starting copy of $(wc -l < /tmp/v4-blobs.txt) blobs"
cd "$MS/blobs" || exit 1
scp -o ConnectTimeout=30 $(cat /tmp/v4-blobs.txt | tr '\n' ' ') 'eleven2go:.ollama/models/blobs/' >> "$LOG" 2>&1
rc=$?
say "scp finished rc=$rc"
[ $rc -eq 0 ] && say "COPY-OK" || say "COPY-FAILED"
