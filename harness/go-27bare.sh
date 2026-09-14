#!/usr/bin/env bash
# Re-run of the 27B BARE oracle run (0154), which died in 6s with
#   {"error":{"code":500,"message":"tools param requires --jinja flag"}}
#
# Cause: ornith15-coder-rp_tb was built FROM ornith15-coder-jinja-bare_tb, so
# both tags resolve to the SAME blob. schedulerModelKey() keys the runner on
# m.ModelPath (server/sched.go:110) and needsReload() (line 1381) compares
# adapters, projectors, runner options and a Ping -- it never compares
# DisableJinja, which routes.go:2491 sets from usesOllamaRenderedChat(m). The
# rendered tag's runner (started --no-jinja) was still resident from run 0153,
# so the bare tag, which needs --jinja for tools, was handed it.
#
# The fix here is operational, not a code change: unload before switching.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/oracle3.log"
E="http://192.168.178.161:11434"
TAG="ornith15-coder-jinja-bare_tb:27b-t10"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

while pgrep -f 'bash \./native\.sh' >/dev/null; do sleep 60; done

# Evict every resident runner so the bare tag gets a freshly-flagged one.
for T in $(curl -s --max-time 15 "$E/api/ps" \
           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
	say "unloading $T"
	curl -s --max-time 30 "$E/api/generate" \
		-d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
done
sleep 20
say "resident after unload: $(curl -s --max-time 15 "$E/api/ps" | head -c 300)"

rm -f "$H/STOP-NATIVE" "$H/STOP-ORNITH"
say "=== relaunching 1 oracle run on $TAG (bare, sandboxed harness) ==="
cd "$H" || exit 1
ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS=1 ./native.sh 1
say "=== $TAG finished ==="
tail -1 "$H/verdicts-native.txt" >> "$LOG"
