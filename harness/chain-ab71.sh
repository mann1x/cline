#!/usr/bin/env bash
# Three arms of ten on the same file, the same model and the same prompt.
#
# The only thing that moves is what decides whether a transaction is kept:
#
#   oracle    the check is handed to the protocol (`--oracle`), which is every
#             native run before this batch and the baseline the other two are
#             read against
#   self      no check exists and none may be proposed, so the model's own
#             account of its work is the verdict -- the extension's behaviour
#             before 4.100.62, and what the settings switch turns back on
#   proposed  no check exists, the model names one and the CLI approves it
#             without asking -- 4.100.71's flow with the user's judgement
#             removed, which is the only shape an unattended batch can take
#
# The interactive A/B on pandorum runs the last two by hand, one run each. This
# is the same comparison at n=10 with a real oracle adjudicating every run
# afterwards, so `self` and `proposed` can be caught keeping a transaction the
# game does not survive -- which is the failure the whole feature exists to
# prevent and the one a self-declared verdict cannot report.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/chain-ab71.log"
E="http://192.168.178.161:11434"
MODEL="omnimerge-v4-mtp_tb:27b-q4km-128k"
RUNS="${RUNS:-10}"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
die() { say "$*"; say "NOT launching the batch."; exit 1; }

say "armed: $RUNS runs each of oracle, self and proposed on $MODEL"

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

for arm in oracle self proposed; do
	if [[ -f "$H/STOP-AB71" ]]; then
		say "stopping before the $arm arm on STOP-AB71"
		break
	fi
	first=$(( $(find "$H/runs-native" -maxdepth 1 -type d -name '2[0-9]*' 2>/dev/null |
		sed 's/.*-//' | sort -n | tail -1 | sed 's/^0*//' | grep -E '^[0-9]+$' || echo 0) + 1 ))
	say "=== $arm arm: $RUNS runs, starting at $(printf '%04d' "$first") ==="
	ARM="$arm" MODEL="$MODEL" OLLAMA_BASE_URL="$E" \
		./native.sh "$RUNS" >> "$H/native-ab71-$arm.log" 2>&1
	say "=== $arm arm done ==="
	tail -n "$RUNS" "$H/verdicts-native.txt" >> "$LOG"
done

say "all arms complete"
