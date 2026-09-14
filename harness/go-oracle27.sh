#!/usr/bin/env bash
# The 27B pair on the oracle arm, queued behind go-oracle3.sh (v4 + 35B).
#
# A follow-on script rather than an edit to the running one: bash re-reads a
# script by byte offset while executing it, so editing go-oracle3.sh mid-run
# would corrupt the 35B run in flight.
#
# These two are the decision pair. Same blob, same parameters, same 2 layers
# -- ornith15-coder-rp_tb was built FROM the bare tag -- so the only thing
# that differs is the path to the chat template:
#
#   ornith15-coder-rp_tb          renderer/parser qwen3.5 -> the rendered path,
#                                 the same one v4 and a3b-coder ran on, and
#                                 the one #18281 never touched
#   ornith15-coder-jinja-bare_tb  no renderer/parser -> native, the GGUF's own
#                                 Jinja, which is how official ornith-1.5
#                                 ships, and the path the #18281 thinking fix
#                                 applies to
#
# Rendered runs FIRST. It is the arm we expect to work -- v4 and a3b-coder
# both live there -- so if the 27B is going to look good at all it looks good
# there, and a bad result on it says something much stronger than a bad
# result on the bare path would. If rendered wins we ship the 27B with
# renderer/parser and drop the Ornith template.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/oracle3.log"
E="http://192.168.178.161:11434"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# Wait for the v4 + 35B chain to exit, then for any run it left behind.
while pgrep -f 'go-oracle3\.sh' >/dev/null; do sleep 30; done
say "=== v4 + 35B chain done, starting the 27B pair (rendered first) ==="

for TAG in ornith15-coder-rp_tb:27b-t10 \
           ornith15-coder-jinja-bare_tb:27b-t10; do
	while pgrep -f 'bash \./native\.sh' >/dev/null; do sleep 60; done
	rm -f "$H/STOP-NATIVE" "$H/STOP-ORNITH"
	say "=== launching 1 oracle run on $TAG ==="
	cd "$H" || exit 1
	ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS=1 ./native.sh 1
	say "=== $TAG finished ==="
	tail -1 "$H/verdicts-native.txt" >> "$LOG"
done
say "27B pair done -- rendered then native"
