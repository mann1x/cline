#!/usr/bin/env bash
# 1 oracle run of the Qwen 3.6 27B DENSE BASE, as the control for omnimerge v4.
#
# The pair is as clean as this gets: both GGUFs are qwen35, 866 tensors, 65
# blocks, 24/4 heads, embedding 5120, context 262144, nextn_predict_layers 1,
# file_type 15 (Q4_K_M). The tag mirrors v4's Modelfile field for field --
# TEMPLATE {{ .Prompt }}, RENDERER/PARSER qwen3.5, num_ctx 131072,
# think_budget medium and the same think_budget_message, temperature 1,
# top_k 20, top_p 0.95, min_p 0, repeat_penalty 1, presence_penalty 0,
# num_gpu 99, draft_num_predict 4. Only the weights differ.
#
# Baseline to beat: 20260907-125651-0151, omnimerge-v4-mtp_tb:27b-q4km-128k,
# arm=oracle -- FIXED, kept=1, 456s. Same arm here so the two are comparable.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/oracle3.log"
E="http://192.168.178.161:11434"
TAG="qwen36-base-mtp_tb:27b-q4km-128k"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# Only a run in THIS instance gates us; the gemma instance is another host.
ornith_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}
while ornith_busy; do sleep 60; done

for T in $(curl -s --max-time 15 "$E/api/ps" \
           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
	say "unloading $T"
	curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
done
sleep 15

rm -f "$H/STOP-NATIVE" "$H/STOP-ORNITH"
say "=== base control: 1 oracle run on $TAG (vs v4 0151, FIXED 456s) ==="
cd "$H" || exit 1
ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS=1 ./native.sh 1
say "=== $TAG finished ==="
tail -1 "$H/verdicts-native.txt" >> "$LOG"
