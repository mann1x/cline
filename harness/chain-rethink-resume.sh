#!/usr/bin/env bash
# Two arms of ten, differing in one thing: whether a check the model named and
# that has never once passed can be replaced.
#
#   proposed  --check-reconsider-after 0. The freeze exactly as it shipped:
#             what is approved judges every attempt for the rest of the run.
#             Ten runs of this on the previous build lost two whole runs to a
#             frozen check that could not pass, one of which proposed the
#             correct check twice and was refused both times.
#   rethink   --check-reconsider-after 2. After two discarded attempts with no
#             pass at all, the model may propose one replacement.
#
# Both run on the same build, which also carries the smaller fixes from that
# batch -- `kind` inferred from the field that was given, the missing-`expect`
# rejection saying what is actually wrong, the working directory stated, and a
# check the interpreter could not run refused before it is frozen. So `proposed`
# here is not the same arm as `proposed` there, and the two are not comparable
# across builds; this batch is self-contained.
#
# The question is whether the crack costs more than the hole. It reopens the
# path the freeze exists to block -- a model that fails twice honestly and then
# swaps for something weaker -- so a false pass in `rethink` that `proposed`
# does not have is the result that matters, not the wall clock.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/chain-rethink.log"
E="http://192.168.178.161:11434"
MODEL="omnimerge-v4-mtp_tb:27b-q4km-128k"
RUNS="${RUNS:-10}"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
die() { say "$*"; say "NOT launching the batch."; exit 1; }

# Resumed after eleven2go moved to the wired address mid-batch. The control
# arm banked 8 runs (0127-0134, all adjudicated) before the host went away, and
# the interrupted 0135 was discarded rather than counted, so this finishes the
# arm rather than restarting it.
say "resuming: 2 more proposed (8 already banked) then $RUNS rethink, on $MODEL"

# Nothing else may be driving the GPU: two runs sharing it measure the
# contention, not the protocol.
while pgrep -f 'bash \./native\.sh' > /dev/null; do
	say "waiting for a native.sh already running"
	sleep 120
done

curl -s --max-time 60 "$E/api/tags" | grep -q "$MODEL" || die "$MODEL is not on $E"

# Full residency, proved rather than assumed. Ollama's estimator leaves two
# layers on the CPU for this model unless num_gpu 99 is baked in, and that
# alone is a 10x throughput difference -- a batch run half on the CPU would
# measure the estimator and nothing else.
curl -s --max-time 60  "$E/api/generate" -d "{\"model\":\"$MODEL\",\"keep_alive\":0}" >/dev/null 2>&1
curl -s --max-time 560 "$E/api/generate" -d "{\"model\":\"$MODEL\",\"prompt\":\"say OK\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":8}}" >> "$LOG" 2>&1
off=$(ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "(Get-Content ($env:LOCALAPPDATA + \"\Ollama\server.log\") | Select-String -Pattern \"offloaded \d+/\d+ layers\" | Select-Object -Last 1).Line"' 2>/dev/null | tr -d '\r')
say "preflight offload: $off"
case "$off" in *"offloaded 66/66"*) ;; *) die "not fully GPU-resident: $off" ;; esac

cd "$H" || die "cannot enter $H"
rm -f "$H/STOP-NATIVE"

for spec in "proposed:2" "rethink:$RUNS"; do
	arm="${spec%%:*}"
	runs="${spec##*:}"
	if [[ -f "$H/STOP-RETHINK" ]]; then
		say "stopping before the $arm arm on STOP-RETHINK"
		break
	fi
	first=$(( $(find "$H/runs-native" -maxdepth 1 -type d -name '2[0-9]*' 2>/dev/null |
		sed 's/.*-//' | sort -n | tail -1 | sed 's/^0*//' | grep -E '^[0-9]+$' || echo 0) + 1 ))
	say "=== $arm arm: $runs runs, starting at $(printf '%04d' "$first") ==="
	ARM="$arm" MODEL="$MODEL" OLLAMA_BASE_URL="$E" \
		./native.sh "$runs" >> "$H/native-rethink-$arm.log" 2>&1
	say "=== $arm arm done ==="
	tail -n "$runs" "$H/verdicts-native.txt" >> "$LOG"
done

say "all arms complete"
