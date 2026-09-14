#!/usr/bin/env bash
# JackOD 9B on eleven2go -- the manual-arm PROMPT A/B.
#
# WHAT MOVES. One sentence, and nothing else. Both arms are `--atomic off`,
# same tag, same sampler, same oracle, same cap, same build, interleaved on one
# lane:
#
#   old  "check manic_miner.html, it's not working. Run `node run_game.js
#         manic_miner.html` to see whether it actually works ..."
#   new  ... the same, plus "Use `check_file` after each edit to see straight
#         away whether what you wrote parses, and run the command again before
#         you tell me you are done -- do not declare it fixed on a reading of
#         the source."
#
# WHY IT IS AN A/B AND NOT A READING. The sentence went in after 0305 made 13
# `check_file` calls against 1-6 in the three manual runs before it, and 0306 --
# the same prompt, the same tag, the same everything -- then made 2. On a 9B
# model that spread is the sampler, so a before/after on unpaired runs cannot
# see a one-sentence effect at all. Interleaving is what makes the comparison
# survive the variance (user, 2026-09-14: "JackOD is a 9B model so extreme
# variance is expected. we need the A/B testing").
#
# PAIRING. One run of each arm per pair, order alternating by pair, so the lane
# warming up, the endpoint drifting, or a batch stopped early cannot land on
# one arm more than the other. Stopping mid-pair costs at most one unmatched
# run, and the analysis drops it.
#
# SCORED ON, in this order:
#   check_files per run   the thing the sentence asks for -- if this does not
#                         move, nothing downstream can be attributed to it
#   verdict               FIXED vs broken/TIMEOUT
#   edits, calls, wall    secondary, and underpowered at this n by design
#
# The verdict line carries `prompt=old|new` as its last field and build.txt
# carries `manual_prompt=`, so the split needs no bookkeeping here.
#
# DISARM: touch $H/STOP-JACKOD-AB before or during the batch, or $H/STOP-NATIVE
# between runs. Both are checked before every run and neither interrupts one.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/jackod-abprompt-e2g-$(date '+%Y%m%d-%H%M%S').log"
E="http://192.168.178.161:11434"
V="$H/verdicts-native.txt"
TAG="jackod-9b_tb:q6_k-128k"
PAIRS="${PAIRS:-6}"
export CLI_DIR=/shared/dev/cline-scan/apps/cli
# Unset by design: the sampler is the tag's own now, and the gate below is what
# proves it. See go-jackod4ac-manual-e2g.sh for the six fields and the history.
EXPERT_MODEL="${EXPERT_MODEL:-}"

say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
die(){ say "$*"; say "NOT launching."; exit 1; }

harness_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}

say "=== jackod manual PROMPT A/B: ${PAIRS} pairs (${PAIRS} old + ${PAIRS} new) on eleven2go ==="
[ -f "$H/STOP-JACKOD-AB" ] && die "STOP-JACKOD-AB present"
while harness_busy; do say "lane busy, waiting"; sleep 120; done
say "lane free"

curl -s --max-time 60 "$E/api/tags" | grep -q "$TAG" || die "$TAG did not appear on $E"
say "GATE OK: $TAG present"

sampler="$(curl -s --max-time 30 "$E/api/show" -d "{\"model\":\"$TAG\"}" \
  | python3 -c '
import json, sys
want = {"temperature":"0.8", "min_p":"0.05", "repeat_last_n":"96",
        "repeat_penalty":"1.05", "presence_penalty":"0",
        "think_budget":"\"high\"", "top_k":"20", "top_p":"0.95",
        "num_ctx":"131072"}
got = {}
for line in (json.load(sys.stdin).get("parameters") or "").splitlines():
    parts = line.split(None, 1)
    if len(parts) == 2:
        got[parts[0]] = parts[1].strip()
bad = [f"{k}={g} want {v}"
       for k, v in want.items()
       for g in [got.get(k, "MISSING")] if g != v]
print("SAMPLER-BAD " + "; ".join(bad) if bad else "SAMPLER-OK " + json.dumps(got, sort_keys=True))
' 2>&1)"
say "sampler: $sampler"
case "$sampler" in
	SAMPLER-OK*) ;;
	*) die "$TAG does not carry the official sampler: $sampler" ;;
esac

curl -s --max-time 30 "$E/api/show" -d "{\"model\":\"$TAG\"}" \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
mf=d.get("modelfile","") or ""
ok=True
if len(d.get("template","") or "") != 13:
    print("TEMPLATE is not ollama-supplied: len", len(d.get("template","") or "")); ok=False
for want in ("RENDERER qwen3.5","PARSER qwen3.5"):
    if want not in mf: print("missing", want); ok=False
print("TAG-OK" if ok else "TAG-BAD")' >> "$LOG" 2>&1
grep -q 'TAG-OK' "$LOG" || die "$TAG failed the renderer/parser/template check"
say "tag integrity ok"

# Evict whatever is resident: a tag built FROM another reuses that tag's
# llama-server and its serve flags carry over.
for T in $(curl -s --max-time 15 "$E/api/ps" \
           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
	say "unloading $T"
	curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
done
sleep 10

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
# Cleared once, here. From this point on its appearance is the operator saying
# stop, which is why the loop below reads it rather than removing it.
rm -f "$H/STOP-NATIVE"
cd "$H" || die "cannot enter $H"

done_runs=0
for ((pair = 1; pair <= PAIRS; pair++)); do
	# Odd pairs run old first, even pairs new first.
	if (( pair % 2 == 1 )); then order="old new"; else order="new old"; fi
	for arm in $order; do
		if [ -f "$H/STOP-JACKOD-AB" ]; then say "STOP-JACKOD-AB: stopping after $done_runs run(s)"; break 2; fi
		if [ -f "$H/STOP-NATIVE" ]; then say "STOP-NATIVE: stopping after $done_runs run(s)"; break 2; fi
		say "--- pair $pair/$PAIRS, arm=$arm ---"
		MANUAL_PROMPT="$arm" ARM=manual MODEL="$TAG" OLLAMA_BASE_URL="$E" \
			EXPERT_MODEL="$EXPERT_MODEL" RUNS=1 ./native.sh 1 >> "$LOG" 2>&1
		done_runs=$((done_runs + 1))
		say "$(tail -1 "$V")"
	done
done

say "=== A/B finished: $done_runs run(s) ==="
tail -n +$((before + 1)) "$V" >> "$LOG"
say ">>> JACKOD_ABPROMPT_E2G_DONE"
