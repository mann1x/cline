#!/usr/bin/env bash
# JackOD4-AC 9B on eleven2go -- arm p01, 5 oracle runs.
#
# WHAT IS NEW HERE. The sampler and the thinking budget are configured in the
# plugin, not on the model (user, 2026-09-13). Every t0x arm before this one
# baked them into a tag with PARAMETER lines; a real session configures them in
# the extension's Ollama panel, and what the plugin sends wins field by field
# over the tag. So this arm writes them into the run's own providers.json --
# `settings.sampling`, which is the field `toProviderConfig` actually reads --
# and native.sh reads the file back and refuses to run if they did not survive.
#
#     temperature 0.8  min_p 0.05  repeat_last_n 96  repeat_penalty 1.05
#     presence_penalty 0  think_budget "high"
#
# plus --thinking high on the command line, which every arm has always passed.
# Worth writing down, because it changes how the earlier arms read: ollama
# resolves the request's own think level BEFORE the model's `think_budget`
# parameter, so `--thinking high` has been setting the budget to half the
# context window (65,536 tokens at num_ctx 131072) in every arm, and the tags'
# `think_budget "medium"` never applied to any of them.
#
# TAG: jackod4ac-9b_tb:q6_k-128k-t08 -- the vehicle, not the configuration. It
# is used because its TEMPLATE, RENDERER qwen3.5 and PARSER qwen3.5 are intact
# (eleven2go's bare tag is the one whose quoted TEMPLATE swallowed every
# directive after it) and because its own PARAMETER lines are identical to what
# the plugin now sends, so there is nothing for the two to disagree about.
#
# BASELINE, same model, same harness build, same oracle, same limits:
#   eleven2go t04 (0274-0283, n=10): 5 FIXED / 5 broken / 0 TIMEOUT, median 1361s
#   eleven2go t08 (0289-0291): 1 FIXED 5421s, 1 TIMEOUT 7203s, 1 killed by hand
#     -- stopped after 3 runs at the user's request; not a comparison.
#
# Build under test: /shared/dev/cline-scan at 7d465bd84 (4.100.104), the same
# checkout every t0x arm has run. Do not move it while this batch is in flight.
# ollama on eleven2go is 0.34.0-thinkbudget.
#
# DISARM: touch $H/STOP-JACKOD-P01 before launch, or $H/STOP-NATIVE between runs.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/jackod4ac-p01-e2g-$(date '+%Y%m%d-%H%M%S').log"
E="http://192.168.178.161:11434"
V="$H/verdicts-native.txt"
TAG="jackod4ac-9b_tb:q6_k-128k-t08"
RUNS=5
export CLI_DIR=/shared/dev/cline-scan/apps/cli
# The plugin's Ollama panel, as the gateway names the fields. presence_penalty
# is deliberately 0 rather than absent: zero is a value the user set, and the
# builder only drops undefined.
export OLLAMA_SAMPLING='{"temperature":0.8,"minP":0.05,"repeatLastN":96,"repeatPenalty":1.05,"presencePenalty":0,"thinkBudget":"high"}'
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
die(){ say "$*"; say "NOT launching."; exit 1; }

harness_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}

say "=== jackod4ac p01 (plugin-configured sampler) x${RUNS} on eleven2go starting ==="
[ -f "$H/STOP-JACKOD-P01" ] && die "STOP-JACKOD-P01 present"
while harness_busy; do say "lane busy, waiting"; sleep 120; done
say "lane free"

curl -s --max-time 60 "$E/api/tags" | grep -q "$TAG" || die "$TAG did not appear on $E"
say "GATE OK: $TAG present"
python3 -c "import json,sys; json.loads(sys.argv[1])" "$OLLAMA_SAMPLING" || die "OLLAMA_SAMPLING is not JSON"
say "plugin sampler: $OLLAMA_SAMPLING"

# A tag built FROM another reuses that tag's llama-server, and stale serve
# flags carry over with it. Evict whatever is resident first.
for T in $(curl -s --max-time 15 "$E/api/ps" \
           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
	say "unloading $T"
	curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
done
sleep 10

# Full residency, proved not assumed.
curl -s --max-time 560 "$E/api/generate" \
  -d "{\"model\":\"$TAG\",\"prompt\":\"say OK\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":8}}" >> "$LOG" 2>&1
echo >> "$LOG"
off=$(ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "(Get-Content ($env:LOCALAPPDATA + \"\Ollama\server.log\") | Select-String -Pattern \"offloaded \d+/\d+ layers\" | Select-Object -Last 1).Line"' 2>/dev/null | tr -d '\r')
say "$TAG preflight offload: $off"
have="$(sed -n 's/.*offloaded \([0-9]\+\)\/\([0-9]\+\) layers.*/\1 \2/p' <<< "$off")"
set -- $have
[ $# -eq 2 ] && [ -n "$1" ] && [ "$1" = "$2" ] || die "$TAG not fully GPU-resident: $off"
say "$TAG residency ok: $1/$2 layers"

before=$(wc -l < "$V" 2>/dev/null || echo 0)
rm -f "$H/STOP-NATIVE"
say "=== ${RUNS} oracle runs: $TAG on $E ==="
cd "$H" || die "cannot enter $H"
ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS=$RUNS ./native.sh $RUNS
say "=== $TAG: ${RUNS} runs finished ==="
tail -n +$((before + 1)) "$V" >> "$LOG"
say ">>> JACKOD_P01_E2G_DONE"
