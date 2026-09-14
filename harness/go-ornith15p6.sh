#!/usr/bin/env bash
# 10 oracle runs of ornith15-p6-mtp_tb:27b-q4km-128k on eleven2go.
#
# Same shape as the v4/v6 and qwen36-base batches measured on this host: one
# native.sh invocation with RUNS=10, so the batch reuses a resident runner
# rather than paying a cold load on every run. Comparing against those numbers
# only means anything if the load cost is spent the same way.
#
# Endpoint is the WIRED address. 192.168.178.160 is the box's wifi side and is
# currently down; .161 answers and is the 1G link.
#
# Model config as read from /api/show before launching: num_ctx 131072,
# num_gpu 99, temperature 0.6, top_k 20, top_p 0.95, think_budget medium with
# the cap message, RENDERER/PARSER qwen3.5, Q4_K_M, 26.2B qwen35moe.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/ornith15p6.log"
E="http://192.168.178.161:11434"
TAG="ornith15-p6-mtp_tb:27b-q4km-128k"
V="$H/verdicts-native.txt"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# Only a run in THIS directory gates us; the gemma instance is another host.
harness_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}
while harness_busy; do sleep 60; done

# Nothing is resident right now, but evict anyway rather than discover under
# memory pressure that a leftover runner and this load do not both fit.
for T in $(curl -s --max-time 15 "$E/api/ps" \
           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
	say "unloading $T"
	curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
done
sleep 10

# Where the verdicts file ends now, so the summary reports only our ten.
before=$(wc -l < "$V" 2>/dev/null || echo 0)

rm -f "$H/STOP-NATIVE" "$H/STOP-ORNITH"
say "=== 10 oracle runs: $TAG on $E ==="
cd "$H" || exit 1
ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS=10 ./native.sh 10
say "=== all 10 runs finished ==="
tail -n +$((before + 1)) "$V" >> "$LOG"
