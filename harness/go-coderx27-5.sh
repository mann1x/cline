#!/usr/bin/env bash
# Ornith-1.5-27B-A3B CoderX, IQ4_XS, 5 oracle runs on eleven2go.
# Launched 2026-09-13 on request.
#
# TAG: ornith15-coderx-rp_tb:27b-high -- the PUBLISHED parameter set
# (presence_penalty 1.5). The sibling ornith15-coderx-pp0_tb:27b-high differs
# from it in exactly one field, presence_penalty 0, and is a different arm.
# Everything else is byte-identical between the two: temperature 0.6, top_p
# 0.95, top_k 20, min_p 0, repeat_penalty 1, num_ctx 131072, num_gpu 99,
# draft_num_predict 3, think_budget "high", bare {{ .Prompt }} template with no
# RENDERER/PARSER.
#
# The harness tree /shared/dev/cline-scan is at 7d465bd84 (4.100.104) and MUST
# NOT be moved: the solidPC lane is running a live batch from it.
#
# DISARM: touch $H/STOP-CODERX27
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/coderx27-5-$(date '+%Y%m%d-%H%M%S').log"
E="http://192.168.178.161:11434"
V="$H/verdicts-native.txt"
TAG="ornith15-coderx-rp_tb:27b-high"
RUNS=5
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
die(){ say "$*"; say "NOT launching."; exit 1; }

harness_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}

say "=== coderx27 x${RUNS} starting ==="
[ -f "$H/STOP-CODERX27" ] && die "STOP-CODERX27 present"
while harness_busy; do say "lane busy, waiting"; sleep 120; done
say "lane free"

curl -s --max-time 60 "$E/api/tags" | grep -q "$TAG" || die "$TAG did not appear on $E"
say "GATE OK: $TAG present"

# Evict any resident runner: a tag built FROM a shared blob reuses its
# llama-server, and stale serve flags carry over.
for T in $(curl -s --max-time 15 "$E/api/ps" \
           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
	say "unloading $T"
	curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
done
sleep 10

# Full residency, proved not assumed.
curl -s --max-time 560 "$E/api/generate" \
  -d "{\"model\":\"$TAG\",\"prompt\":\"say OK\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":8}}" >> "$LOG" 2>&1
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
say ">>> CODERX27_5_DONE"
