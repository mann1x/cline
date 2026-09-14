#!/usr/bin/env bash
# 10 oracle runs of ornith15-base-rp_tb:35b-high on eleven2go.
#
# WHY THIS REPLACES go-ornith15base35b-jinja.sh
# ---------------------------------------------
# CORRECTED 2026-09-08 19:50. An earlier version of this header claimed the
# jinja-bare arm failed because a missing PARSER caused a "content_start
# pathology" -- 1,005,165 content_start against 1,481 content_end in run 0167.
# THAT DIAGNOSIS WAS WRONG and is retracted here so nobody acts on it.
#
# The control refutes it: run 0162 was FIXED with ratio 491:1, and run 0163 was
# FIXED with ratio 643:1 across 1,077,729 content_start events and a 160 MB log
# -- the HIGHEST ratio in the set belongs to a SUCCESSFUL run. One content_start
# per streamed reasoning delta is simply how this harness logs; it is not a
# fault signal. Measured ratios: 0162 FIXED 491, 0163 FIXED 643, 0167 broken
# 679, 0169 (this arm) 175.
#
# WHAT THE EVIDENCE ACTUALLY SUPPORTS, stated at its real strength (n is tiny):
#
#     tag                                  renderer/parser   verdicts
#     ornith15-p6-mtp_tb:27b-q4km-128k     yes               FIXED(0163), broken(0164)
#     ornith15-p6-jinja-bare_tb:27b-high   no                broken(0165), broken(0166)
#     ornith15-base-jinja-bare_tb:35b-high no                broken(0167)
#
# Renderer/parser arms are 1 of 2; bare arms are 0 of 3. That is a weak signal,
# not a proven mechanism, and it is the whole basis for this arm's config.
#
# What run 0167 actually did in 4h: 545 agent iterations, 36.5M input tokens,
# 1.11M output, context at 49,598 by the last call, no convergence. Note 0163
# CONVERGED at 622 iterations / 3.75h -- so 0167 at 545 was not obviously
# doomed, and killing it at 3.99h may have ended a run that was still on track.
# Its "broken" verdict is the kill, not a model verdict.
#
# THE TAG. ornith15-base-rp_tb:35b-high was created from ornith15-base:35b with
# think_budget raised to high. Verified by /api/show against the bare tag:
#
#     blob          sha256-e886ab1eeb41...  IDENTICAL (same weights)
#     sampler       temp 0.6 / top_p 0.95 / top_k 20 / num_ctx 131072  IDENTICAL
#     think_budget  high (65,536 tokens)                               IDENTICAL
#     RENDERER      qwen3.5    <- the only real difference
#     PARSER        qwen3.5    <- the only real difference
#
# BUT BE HONEST ABOUT COMPARABILITY: this changes the arm's configuration
# relative to 0167. It is a NEW arm, not a resumption of the old one.
#
# Smoke-tested non-streaming before launch (thinking populated, tool_calls
# parsed). That test does NOT cover the streaming path the harness uses.
#
# SHARED BLOB, SHARED RUNNER: the bare tag and this one are the SAME blob, so a
# resident runner from the old tag would be reused and would carry its missing
# renderer. The unload loop below is load-bearing, not hygiene.
#
# THE ONE CONFOUND, unchanged: the 35B exists only at IQ4_XS, the 27b p6 arm is
# Q4_K_M, so base-vs-pruned stays convolved with the quant.
#
# Endpoint is the WIRED address; 192.168.178.160 is the wifi side and is down.
# Harness is cline 4.100.80 (non-convergence guard present).
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/ornith15base35b-rp.log"
E="http://192.168.178.161:11434"
TAG="ornith15-base-rp_tb:35b-high"
V="$H/verdicts-native.txt"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

harness_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}
while harness_busy; do sleep 60; done

# Load-bearing: evict any runner holding the shared blob (see header).
for T in $(curl -s --max-time 15 "$E/api/ps" \
           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
	say "unloading $T"
	curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
done
sleep 10

before=$(wc -l < "$V" 2>/dev/null || echo 0)

rm -f "$H/STOP-NATIVE" "$H/STOP-ORNITH"
say "=== 10 oracle runs: $TAG on $E ==="
cd "$H" || exit 1
ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS=10 ./native.sh 10
say "=== all 10 runs finished ==="
tail -n +$((before + 1)) "$V" >> "$LOG"
