#!/usr/bin/env bash
# 10 oracle runs of ornith15-base-jinja-bare_tb:35b-high on eleven2go.
#
# THIS IS THE BASELINE ARM for the ornith pruning work. The 27b p6 arm was
# stopped at 2 of 10 (0165 broken 462s, 0166 broken 6975s on kill) because two
# runs in a row produced nothing; there is no reference number to say whether
# that is the pruning or the task, and this arm is meant to supply it.
#
# Chosen over ornith15-jinja-bare_tb:35b-t10 by reading /api/show, not by name:
# the -high tag matches the 27b arm's sampler EXACTLY (temperature 0.6, top_p
# 0.95, top_k 20, think_budget "high", num_ctx 131072, num_gpu 99, same Jinja
# template, same budget message). The t10 tag differs on three of those at once
# (temperature 1.0, think_budget medium, no top_p/top_k) and could not serve as
# a baseline for anything.
#
# THE ONE CONFOUND, stated rather than hidden: quantisation. The 35B exists only
# at IQ4_XS; the 27b p6 arm is Q4_K_M. So a difference here is base-vs-pruned
# CONVOLVED WITH the quant, exactly as in the gepo v4/v6 arms. It cannot be
# attributed to pruning alone.
#
# Endpoint is the WIRED address: 192.168.178.160 is the wifi side and is down.
# Harness is cline 4.100.80 (non-convergence guard present).
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/ornith15base35b-jinja.log"
E="http://192.168.178.161:11434"
TAG="ornith15-base-jinja-bare_tb:35b-high"
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

# Evict the 27b that the stopped arm left resident: 35.5B IQ4_XS and a 26.2B
# Q4_K_M do not both fit, and discovering that under memory pressure costs a run.
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
