#!/usr/bin/env bash
# Ornith 1.5 35B A3B IQ4_XS against the same task omnimerge v4 was measured on.
#
# One arm, five runs, `proposed` exactly as v4 ran it on 2026-09-06:
# `--propose-check auto --check-reconsider-after 0`. The comparison is the
# 10-run v4 arm at 0127-0136 (9 FIXED / 1 regression, median 658s), so nothing
# about the protocol may move -- only the model.
#
# Ornith is 19.3 GB against v4's 16.8 on a 24 GB card, and has 41 blocks rather
# than 65, so the residency preflight cannot be the hardcoded `66/66` the other
# chains use. It reads the two numbers and requires them equal.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/chain-ornith.log"
E="http://192.168.178.161:11434"
MODEL="${MODEL:-ornith15-a3b_tb:35b-iq4xs-128k}"
RUNS="${RUNS:-5}"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
die() { say "$*"; say "NOT launching the batch."; exit 1; }

# Resumed after eleven2go moved to the wired address mid-batch. The control
# arm banked 8 runs (0127-0134, all adjudicated) before the host went away, and
# the interrupted 0135 was discarded rather than counted, so this finishes the
# arm rather than restarting it.
# The control arm is complete (0127-0136, 10 runs, adjudicated). The first
# attempt at this arm ran with the crack pinned shut -- `${VAR:-0}` before the
# case meant the arm's own `${VAR:-2}` substituted nothing -- so 0137 and 0138
# were the control arm under another name and were discarded. native.sh now
# refuses that combination outright rather than running it.
say "ornith: $RUNS runs, arm=proposed, reconsideration off, on $MODEL"

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
# Both numbers, compared, rather than a literal: this model has 41 blocks.
have="$(sed -n 's/.*offloaded \([0-9]\+\)\/\([0-9]\+\) layers.*/\1 \2/p' <<< "$off")"
set -- $have
if [[ $# -ne 2 || "$1" != "$2" || -z "$1" ]]; then
	die "not fully GPU-resident: $off"
fi
say "preflight residency ok: $1/$2 layers"

cd "$H" || die "cannot enter $H"
rm -f "$H/STOP-NATIVE"

for spec in "proposed:$RUNS"; do
	arm="${spec%%:*}"
	runs="${spec##*:}"
	if [[ -f "$H/STOP-ORNITH" ]]; then
		say "stopping before the $arm arm on STOP-ORNITH"
		break
	fi
	first=$(( $(find "$H/runs-native" -maxdepth 1 -type d -name '2[0-9]*' 2>/dev/null |
		sed 's/.*-//' | sort -n | tail -1 | sed 's/^0*//' | grep -E '^[0-9]+$' || echo 0) + 1 ))
	say "=== $arm arm: $runs runs, starting at $(printf '%04d' "$first") ==="
	ARM="$arm" MODEL="$MODEL" OLLAMA_BASE_URL="$E" \
		./native.sh "$runs" >> "$H/native-ornith-$arm.log" 2>&1
	say "=== $arm arm done ==="
	tail -n "$runs" "$H/verdicts-native.txt" >> "$LOG"
done

say "all arms complete"
