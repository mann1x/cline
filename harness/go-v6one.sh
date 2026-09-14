#!/usr/bin/env bash
# 1 oracle run of omnimerge-v6-mtp_tb:27b-q4km-128k on eleven2go, on the CURRENT
# harness. Every existing v6 number was measured on CLI 4.100.54 against the
# .160 endpoint, before the arm= concept existed -- those runs had the oracle
# checking automatically, which is what arm=oracle means now, but a lot has
# landed since (atomic transactions, restore_file, propose_check, the loop
# guard). This run says what v6 does on today's build.
#
# For reference, all FIXED, from verdicts-native.txt:
#   v6 q4km, CLI 4.100.54, 10/10 -- mean 2369s, median 2155s
#   v4 q4km, CLI 4.100.54, 10/10 -- mean  809s, median  716s
#   v4 q4km, CLI 4.100.71/.73, 11/11 -- mean 875s, median 638s
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/oracle3.log"
E="http://192.168.178.161:11434"
TAG="omnimerge-v6-mtp_tb:27b-q4km-128k"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

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
say "=== v6 on the current harness: 1 oracle run on $TAG ==="
cd "$H" || exit 1
ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS=1 ./native.sh 1
say "=== $TAG finished ==="
tail -1 "$H/verdicts-native.txt" >> "$LOG"
