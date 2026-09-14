#!/usr/bin/env bash
# JackOD4-AC 9B on eleven2go -- the `manual` arm: NO change protocol.
#
# WHAT THIS ARM IS. `--atomic off`. No transactions, no declared changes, no
# rollback, and nothing handed to the model that decides whether its work is
# kept. The model edits the file and stops when it says it is done; native.sh
# then runs the oracle once, and that is the verdict. It is the control the
# other four arms never had -- each of those measures a variant OF the
# protocol, so "the protocol helps" has been an assumption rather than a
# reading (user, 2026-09-13: "the change protocol is not helping, it's making
# things worse ... it starts messing up much earlier the file and it's unable
# to recover due to the stress of the transactions and continuosly reverting
# to the original", against two ad-hoc plugin runs that fixed the file in 28
# and 39 minutes with the protocol off).
#
# DIRECTLY COMPARABLE TO ARM p01, deliberately: same host, same tag, same
# plugin sampler, same oracle, same 7200s cap. p01 scored 1 FIXED / 3 TIMEOUT
# of 4 (0292-0295) and closed no transaction in any of the three failures.
# The ONE thing that moves is the change protocol.
#
# The build does move with it, and that is not free: p01 ran 4.100.104
# (7d465bd84) and this runs 4.100.108 (1b39e1480), 54 commits later, which is
# the build the user is running on pandorum. So a difference here is
# "protocol off, on the new build" -- not the protocol alone. Stated rather
# than discovered later.
#
# THE EXPERT. `escalate` builds its connection from the SESSION's provider and
# base URL -- there is no flag to point it elsewhere -- so the expert must be a
# model this endpoint can serve. eleven2go was signed in to ollama cloud at
# 22:05 on 2026-09-13 and `nemotron-3-nano:30b-cloud` answers here. Note that a
# pull is NOT the test: before it was signed in, /api/pull returned
# {"status":"success"} and /api/generate returned {"error":"Unauthorized"}.
# This script probes with a real generate.
#
# TAG: jackod4ac-9b_tb:q6_k-128k-t08, arm p01's vehicle. The sampler comes from
# the plugin and wins field by field over the tag's PARAMETER lines; the tag is
# checked only for what it cannot override -- RENDERER qwen3.5, PARSER qwen3.5,
# and a TEMPLATE ollama supplies itself (template len 13, i.e. not the
# quoted-TEMPLATE tag that swallowed every directive after it).
#
# EXPERT: set EXPERT_MODEL to arm the escalation path; unset, every escalation
# path is closed and this is the plain manual arm.
#
# DISARM: touch $H/STOP-JACKOD-ORACLE before launch, or $H/STOP-NATIVE between
# runs.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/jackod4ac-oracle-e2g-$(date '+%Y%m%d-%H%M%S').log"
E="http://192.168.178.161:11434"
V="$H/verdicts-native.txt"
TAG="jackod4ac-9b_tb:q6_k-128k-t08"
RUNS="${RUNS:-1}"
export CLI_DIR=/shared/dev/cline-scan/apps/cli
# Identical to arm p01, so the sampler is not a variable between the two.
export OLLAMA_SAMPLING='{"temperature":0.8,"minP":0.05,"repeatLastN":96,"repeatPenalty":1.05,"presencePenalty":0,"thinkBudget":"high"}'
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

say "=== jackod4ac ORACLE arm (change protocol + oracle) x${RUNS} on eleven2go starting ==="
say "expert=${EXPERT_MODEL:-none}"
[ -f "$H/STOP-JACKOD-ORACLE" ] && die "STOP-JACKOD-ORACLE present"
while harness_busy; do say "lane busy, waiting"; sleep 120; done
say "lane free"

curl -s --max-time 60 "$E/api/tags" | grep -q "$TAG" || die "$TAG did not appear on $E"
say "GATE OK: $TAG present"
python3 -c "import json,sys; json.loads(sys.argv[1])" "$OLLAMA_SAMPLING" || die "OLLAMA_SAMPLING is not JSON"
say "plugin sampler: $OLLAMA_SAMPLING"

# The tag's own integrity, for the three things the plugin cannot override.
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

# The expert, proved by inference and not by a pull. A `-cloud` tag resolves
# its manifest on a host that is not signed in and then refuses every token.
if [ -n "$EXPERT_MODEL" ]; then
	probe="$(curl -s --max-time 180 "$E/api/generate" \
	  -d "{\"model\":\"$EXPERT_MODEL\",\"prompt\":\"Reply with exactly: OK\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":16}}" 2>&1)"
	say "expert probe: $(printf '%s' "$probe" | head -c 300)"
	printf '%s' "$probe" | grep -q '"error"' && die "expert $EXPERT_MODEL is not usable on $E"
	printf '%s' "$probe" | grep -q '"done":true' || die "expert $EXPERT_MODEL gave no completion on $E"
	say "expert OK: $EXPERT_MODEL answers on $E"
fi

# A tag built FROM another reuses that tag's llama-server, and stale serve
# flags carry over with it. Evict whatever is resident first. The cloud expert
# holds no local slot, so this does not evict it.
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
say "=== ${RUNS} oracle-arm run(s): $TAG on $E, expert=${EXPERT_MODEL:-none} ==="
cd "$H" || die "cannot enter $H"
ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" EXPERT_MODEL="$EXPERT_MODEL" \
	RUNS=$RUNS ./native.sh $RUNS >> "$LOG" 2>&1
say "=== $TAG: ${RUNS} run(s) finished ==="
tail -n +$((before + 1)) "$V" >> "$LOG"
say ">>> JACKOD_ORACLE_E2G_DONE"
