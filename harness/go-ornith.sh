#!/usr/bin/env bash
# Wait for the import, find the largest context that holds every layer, bake it
# into the tag, and launch the five runs.
#
# The ladder is 128k -> 110k -> 100k. A context that does not fit entirely on
# the card is not a smaller experiment, it is a different one: the moment any
# layer lands on the CPU the arm measures the spill, not the model.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/chain-ornith.log"
E="http://192.168.178.161:11434"
BASE="ornith15-a3b_tb:35b-iq4xs-128k"
say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

say "waiting for $BASE to register"
for _ in $(seq 1 180); do
	curl -s --max-time 15 "$E/api/tags" 2>/dev/null | grep -q 'ornith15-a3b_tb' && break
	sleep 20
done
curl -s --max-time 15 "$E/api/tags" 2>/dev/null | grep -q 'ornith15-a3b_tb' || { say "model never registered; NOT launching"; exit 1; }
say "model registered"

MODEL="$BASE" bash "$H/fit-ornith.sh" >> "$LOG" 2>&1
if [[ ! -s "$H/ornith-ctx.txt" ]]; then
	say "no context in the ladder fits; NOT launching"
	exit 1
fi
CTX="$(cat "$H/ornith-ctx.txt")"
say "largest fitting context: $CTX"

TAG="$BASE"
if [[ "$CTX" != "131072" ]]; then
	# Re-derive from the imported tag: the blob is already local, so this is
	# a metadata-only create and costs nothing.
	K=$((CTX / 1024))
	TAG="ornith15-a3b_tb:35b-iq4xs-${K}k"
	say "baking num_ctx=$CTX into $TAG"
	ssh -o BatchMode=yes eleven2go "cmd /c \"cd /d C:\\Users\\ManniX && (echo FROM $BASE& echo PARAMETER num_ctx $CTX& echo PARAMETER num_gpu 99) > Modelfile.ornithctx && ollama create $TAG -f Modelfile.ornithctx\"" >> "$LOG" 2>&1
	curl -s --max-time 20 "$E/api/tags" | grep -q "${K}k" || { say "re-tag failed; NOT launching"; exit 1; }
fi

say "launching 5 runs on $TAG"
rm -f "$H/STOP-ORNITH" "$H/STOP-NATIVE"
cd "$H" || exit 1
MODEL="$TAG" RUNS=5 ./chain-ornith.sh
