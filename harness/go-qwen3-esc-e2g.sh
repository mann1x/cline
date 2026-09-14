#!/usr/bin/env bash
# Escalation measurement: two deliberately weak thinking models, manual arm.
#
# WHAT THIS ARM IS. `ARM=manual` -- atomic off. No change protocol, no
# transactions, no rollback. The model edits freely and stops when it says it is
# done; native.sh then runs the oracle once and that is the verdict.
#
# WHY THESE MODELS. JackOD is too capable to strand: across three oracle-arm
# runs it produced 625 tool calls with ZERO failures, and the struggle detector
# gates on failed tool calls, so escalation could never fire. We need a model
# that actually gets stuck.
#
# WHY NOT qwen2.5-coder. It does not think. The detector counts distress and
# hedging in the model's REASONING, and `noteTurn` returns early on empty
# reasoning -- no reasoning means distress 0, hedging 0, no baseline, and both
# halves of the trigger's disjunction are false forever. A non-thinking model is
# a guaranteed-zero arm at ANY threshold. qwen3:4b/8b think, and both were
# verified live to return a separate `thinking` channel before this was written.
#
# THE TAGS. Built with the STRUCTURED /api/create (from/template/renderer/
# parser/parameters as JSON), not Modelfile text, because an unclosed quoted
# TEMPLATE is what silently voided runs 0267-0271. Verified: template byte-
# identical to base, think_budget and think_budget_message in force, budget
# proven to fire live. See INVALID-RUNS.md and check-tag.sh.
#
#   qwen3-4b_tb:128k   num_ctx 131072. Not the model's 262144 maximum: "256k
#                      is too much for him" (2026-09-14). Sampler copied from
#                      jackod-9b_tb, which is the one that behaves --
#                      temperature 0.7, repeat_penalty 1.1, presence_penalty 1.5.
#   qwen3-8b_tb:40k    num_ctx  40960 (that model's maximum)
#
# THINKING=medium so the request level and the tag's `think_budget medium`
# agree. `--thinking high` resolves the REQUEST first and would override the
# tag with half the context window -- 131072 tokens on the 4b -- which is the
# trap that made every t0x arm's tag budget inert.
#
# NO OLLAMA_SAMPLING: the tag carries qwen3's own published sampler
# (temperature 0.6, top_k 20, top_p 0.95, repeat_penalty 1). Unset fields fall
# through to the Modelfile, which is where sampling belongs.
#
# ONE GPU, so the two models run SEQUENTIALLY. The 4b at 256k is 24.4 GB
# resident; they cannot be co-resident.
#
# DISARM: touch $H/STOP-QWEN3-ESC before launch, or $H/STOP-NATIVE between runs.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/qwen3-esc-e2g-$(date '+%Y%m%d-%H%M%S').log"
E="http://192.168.178.161:11434"
V="$H/verdicts-native.txt"
RUNS_EACH="${RUNS_EACH:-1}"
EXPERT_MODEL="${EXPERT_MODEL:-nemotron-3-nano:30b-cloud}"
TAGS=("qwen3-4b_tb:128k" "qwen3-8b_tb:40k")
export CLI_DIR=/shared/dev/cline-scan/apps/cli

say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
die(){ say "$*"; say "NOT launching."; exit 1; }

harness_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}

say "=== qwen3 ESCALATION arm (manual/atomic off, oracle at end) starting ==="
say "models=${TAGS[*]}  runs_each=$RUNS_EACH  expert=$EXPERT_MODEL"
[ -f "$H/STOP-QWEN3-ESC" ] && die "STOP-QWEN3-ESC present"
while harness_busy; do say "lane busy, waiting"; sleep 120; done
say "lane free"

# The expert, proved by inference. A -cloud tag resolves its manifest on a host
# that is not signed in and then refuses every token, so a pull is not the test.
probe="$(curl -s --max-time 240 "$E/api/generate" \
  -d "{\"model\":\"$EXPERT_MODEL\",\"prompt\":\"Reply with exactly: OK\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":16}}" 2>&1)"
say "expert probe: $(printf '%s' "$probe" | head -c 200)"
printf '%s' "$probe" | grep -q '"error"' && die "expert $EXPERT_MODEL unusable on $E"
printf '%s' "$probe" | grep -q '"done":true' || die "expert $EXPERT_MODEL gave no completion"
say "expert OK"

for TAG in "${TAGS[@]}"; do
	[ -f "$H/STOP-QWEN3-ESC" ] && { say "STOP-QWEN3-ESC appeared; stopping before $TAG"; break; }
	say "---------- $TAG ----------"

	curl -s --max-time 60 "$E/api/tags" | grep -q "$TAG" || die "$TAG not present on $E"

	# The tag check that runs/0267-0271 did not have.
	"$H/check-tag.sh" "$E" "$TAG" --require-budget >> "$LOG" 2>&1 \
		|| die "$TAG failed check-tag.sh"
	say "tag check OK"

	# A tag built FROM another reuses that tag's llama-server; evict first.
	for T in $(curl -s --max-time 15 "$E/api/ps" \
	           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
		say "unloading $T"
		curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
	done
	sleep 10

	# Full residency, proved not assumed.
	curl -s --max-time 900 "$E/api/generate" \
	  -d "{\"model\":\"$TAG\",\"prompt\":\"say OK\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":8}}" >> "$LOG" 2>&1
	echo >> "$LOG"
	off=$(ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "(Get-Content ($env:LOCALAPPDATA + \"\Ollama\server.log\") | Select-String -Pattern \"offloaded \d+/\d+ layers\" | Select-Object -Last 1).Line"' 2>/dev/null | tr -d '\r')
	say "$TAG preflight offload: $off"
	have="$(sed -n 's/.*offloaded \([0-9]\+\)\/\([0-9]\+\) layers.*/\1 \2/p' <<< "$off")"
	set -- $have
	if [ $# -eq 2 ] && [ -n "$1" ] && [ "$1" = "$2" ]; then
		say "$TAG residency ok: $1/$2 layers"
	else
		say "WARNING: $TAG residency unconfirmed ($off) -- continuing, wall time is not comparable"
	fi

	before=$(wc -l < "$V" 2>/dev/null || echo 0)
	rm -f "$H/STOP-NATIVE"
	say "launching $RUNS_EACH run(s) of $TAG"
	cd "$H" || die "cannot enter $H"
	ARM=manual MODEL="$TAG" OLLAMA_BASE_URL="$E" EXPERT_MODEL="$EXPERT_MODEL" \
		THINKING=medium RUNS=$RUNS_EACH ./native.sh $RUNS_EACH >> "$LOG" 2>&1
	say "=== $TAG finished ==="
	tail -n +$((before + 1)) "$V" >> "$LOG"
done

say ">>> QWEN3_ESC_E2G_DONE"
