#!/usr/bin/env bash
# Oracle-arm runs, one each, same seeded fault, only the model moves.
#
# The 27B pair (ornith15-coder-jinja-bare_tb and ornith15-coder-rp_tb) is NOT
# here: that quant was judged bad on 2026-09-07 and both runs wait for the
# rebuild. Re-add them together when it lands -- they are the native-vs-
# rendered pair that decides how the 27B ships, and they only mean anything
# run against the same blob.
#
# Why the oracle arm at all: every a3b-coder number we have (9/10, all TX-01,
# median 5,531s) was measured with `oracle=node run_game.js ...`, and every
# Ornith number so far was measured on the proposed arm with no oracle. Run
# 0150 showed exactly what that costs -- the model froze a `node --check`
# syntax gate, satisfied it by deleting braces until the file parsed, and
# closed TX-01 on a game that dies with "initClouds is not defined". The
# oracle cannot be passed that way.
#
# v4 is the control. Its oracle baseline exists at n=10 (runs 0097-0106:
# 10/10, all TX-01, median 742s), so this run controls the new ollama binary
# rather than the arm -- though v4 carries renderer/parser and takes the
# rendered path, which that binary does not touch.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/oracle3.log"
E="http://192.168.178.161:11434"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

say "=== oracle arm: v4 then Ornith 35B (27B held for the rebuilt quant) ==="
for TAG in omnimerge-v4-mtp_tb:27b-q4km-128k \
           ornith15-jinja-bare_tb:35b-t10; do
	while pgrep -f 'bash \./native\.sh' >/dev/null; do sleep 60; done
	rm -f "$H/STOP-NATIVE" "$H/STOP-ORNITH"
	say "=== launching 1 oracle run on $TAG ==="
	cd "$H" || exit 1
	ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS=1 ./native.sh 1
	say "=== $TAG finished ==="
	tail -1 "$H/verdicts-native.txt" >> "$LOG"
done
say "oracle runs done (v4, 35B) -- 27B pending rebuilt quant"
