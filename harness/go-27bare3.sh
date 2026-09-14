#!/usr/bin/env bash
# 3 oracle runs of the 27B BARE tag on eleven2go, to test whether run 0155
# reproduces: finishReason=aborted at 28 iterations, 18 editor calls, ZERO
# transactions kept, and the file byte-identical at 14,127 bytes.
#
# One run cannot separate "this model cannot land an edit on this path" from
# a single bad trajectory, and 0155 was the first bare run that reached the
# model at all -- 0154 died on a stale --no-jinja runner before iteration 1
# (see PR ollama/ollama#18289).
#
# Nothing else may be resident on eleven2go when these start: the rendered tag
# ornith15-coder-rp_tb shares this blob, so if it were loaded the scheduler
# would hand these runs its --no-jinja runner and every tool call would 500.
# Unload first, and unload again between runs -- cheap, and it keeps each run
# a clean load rather than an inherited one.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/oracle3.log"
E="http://192.168.178.161:11434"
TAG="ornith15-coder-jinja-bare_tb:27b-t10"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

evict(){
	for T in $(curl -s --max-time 15 "$E/api/ps" \
	           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
		say "unloading $T"
		curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
	done
}

# Wait only for a run in THIS harness instance. Both instances invoke
# "bash ./native.sh", so a bare pgrep -f also matches the gemma campaign on
# 11439 -- which runs on a different host and must not gate this one. Match on
# the process's cwd instead of its command line.
ornith_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}
while ornith_busy; do sleep 60; done

for i in 1 2 3; do
	evict
	sleep 15
	rm -f "$H/STOP-NATIVE" "$H/STOP-ORNITH"
	say "=== bare repro $i/3 on $TAG ==="
	cd "$H" || exit 1
	ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS=1 ./native.sh 1
	tail -1 "$H/verdicts-native.txt" >> "$LOG"
done
say "=== bare repro set done (3 runs) ==="
