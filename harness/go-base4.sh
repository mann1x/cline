#!/usr/bin/env bash
# 4 more oracle runs of the Qwen 3.6 27B dense base, queued behind the v6 run.
# With 0157 (FIXED, 359s) that makes n=5 for the base.
#
# One run said nothing: 359s sits inside v4's observed oracle range (min 241s,
# median 638s, max 2153s), and the within-arm spread on this task has been as
# wide as 8.6x. Five is still small, but it is enough to see whether the base
# fixes it every time and roughly where its wall clock sits.
#
# RUNS=4 in ONE native.sh invocation, with a single eviction before the batch
# rather than one between each run. That is deliberately how the v4 (11-run)
# and v6 (10-run) baselines were measured -- those batches reused a resident
# runner across their runs -- so the comparison is not confounded by paying a
# cold model load on every run of this batch and none of theirs.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/oracle3.log"
E="http://192.168.178.161:11434"
TAG="qwen36-base-mtp_tb:27b-q4km-128k"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

ornith_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}
# Wait for the v6 run to actually finish, not just to have started.
sleep 30
while ornith_busy; do sleep 60; done

# v6 shares neither blob nor flags with the base, but evict anyway: a resident
# 15.7 GB runner and a 15.9 GB load do not both fit, and ollama should not have
# to discover that under memory pressure.
for T in $(curl -s --max-time 15 "$E/api/ps" \
           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
	say "unloading $T"
	curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
done
sleep 15

rm -f "$H/STOP-NATIVE" "$H/STOP-ORNITH"
say "=== base n=5: 4 more oracle runs on $TAG ==="
cd "$H" || exit 1
ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS=4 ./native.sh 4
say "=== $TAG batch of 4 finished ==="
tail -4 "$H/verdicts-native.txt" >> "$LOG"
