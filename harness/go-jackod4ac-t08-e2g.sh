#!/usr/bin/env bash
# JackOD4-AC 9B on eleven2go -- sampling arm t08, 10 oracle runs.
#
# TAG: jackod4ac-9b_tb:q6_k-128k-t08, created 2026-09-13 on eleven2go with the
# JSON create API FROM jackod4ac-9b_tb:q6_k-128k-t04 (digest a8ed235432fe, the
# tag both t04 lanes ran, byte-identical on solidPC and eleven2go). Built FROM
# t04 and NOT from the bare parent on purpose: the two hosts' bare
# jackod4ac-9b_tb:q6_k-128k tags have different digests -- eleven2go's is the
# one whose quoted TEMPLATE swallowed every directive after it -- while t04 is
# the same object on both.
#
# /api/show proves the new tag differs from t04 in exactly two fields:
#     temperature       0.4  -> 0.8
#     repeat_last_n  absent  -> 96
# Everything else is carried over unchanged: repeat_penalty 1.05,
# presence_penalty 0, min_p 0.05, top_p 0.95, top_k 20, num_ctx 131072,
# think_budget "medium" + its message, TEMPLATE {{ .Prompt }}, RENDERER qwen3.5,
# PARSER qwen3.5, same blob sha256-dbdf9a154f5b5...
#
# BASELINE this is measured against -- same model, same harness build, same
# oracle, same limits, 10 runs each:
#   eleven2go t04 (runs 0274-0283): 5 FIXED / 5 broken / 0 TIMEOUT, median 1361s
#   solidPC   t04 (runs 0041-0050): 5 FIXED / 3 broken / 2 TIMEOUT, median 4430s
# Wall time from this lane is comparable only with the eleven2go t04 row:
# solidPC's 3090 is power-capped to 220W of 370W with its memory clock at
# 5001MHz of 9751MHz, and measured 41.4 gen tok/s against eleven2go's 74.9.
#
# Build under test: /shared/dev/cline-scan at 7d465bd84 (4.100.104), the same
# checkout both t04 arms ran. Do not move it while this batch is in flight.
# ollama on eleven2go is 0.34.0-thinkbudget.
#
# DISARM: touch $H/STOP-JACKOD-T08 before launch, or $H/STOP-NATIVE between runs.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/jackod4ac-t08-e2g-$(date '+%Y%m%d-%H%M%S').log"
E="http://192.168.178.161:11434"
V="$H/verdicts-native.txt"
TAG="jackod4ac-9b_tb:q6_k-128k-t08"
RUNS=10
export CLI_DIR=/shared/dev/cline-scan/apps/cli
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
die(){ say "$*"; say "NOT launching."; exit 1; }

harness_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}

say "=== jackod4ac t08 x${RUNS} on eleven2go starting ==="
[ -f "$H/STOP-JACKOD-T08" ] && die "STOP-JACKOD-T08 present"
while harness_busy; do say "lane busy, waiting"; sleep 120; done
say "lane free"

curl -s --max-time 60 "$E/api/tags" | grep -q "$TAG" || die "$TAG did not appear on $E"
say "GATE OK: $TAG present"

# A tag built FROM another reuses that tag's llama-server, and stale serve
# flags carry over with it. Evict whatever is resident first.
for T in $(curl -s --max-time 15 "$E/api/ps" \
           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
	say "unloading $T"
	curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
done
sleep 10

# Full residency, proved not assumed.
curl -s --max-time 560 "$E/api/generate" \
  -d "{\"model\":\"$TAG\",\"prompt\":\"say OK\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":8}}" >> "$LOG" 2>&1
echo >> "$LOG"
off=$(ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "(Get-Content ($env:LOCALAPPDATA + \"\Ollama\server.log\") | Select-String -Pattern \"offloaded \d+/\d+ layers\" | Select-Object -Last 1).Line"' 2>/dev/null | tr -d '\r')
say "$TAG preflight offload: $off"
have="$(sed -n 's/.*offloaded \([0-9]\+\)\/\([0-9]\+\) layers.*/\1 \2/p' <<< "$off")"
set -- $have
[ $# -eq 2 ] && [ -n "$1" ] && [ "$1" = "$2" ] || die "$TAG not fully GPU-resident: $off"
say "$TAG residency ok: $1/$2 layers"

before=$(wc -l < "$V" 2>/dev/null || echo 0)
rm -f "$H/STOP-NATIVE"
say "=== ${RUNS} oracle runs: $TAG on $E ==="
cd "$H" || die "cannot enter $H"
ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS=$RUNS ./native.sh $RUNS
say "=== $TAG: ${RUNS} runs finished ==="
tail -n +$((before + 1)) "$V" >> "$LOG"
say ">>> JACKOD_T08_E2G_DONE"
