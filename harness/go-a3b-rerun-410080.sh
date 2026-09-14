#!/usr/bin/env bash
# QUEUED 2026-09-09. REWRITTEN TWICE:
#   15:35 -> "same exact config of the ornith 27b runs queued"  (eleven2go + ornith sampler set)
#   15:52 -> "use the same iq4_xs ... download the quants from ollama directly on
#             eleven2go ... one at a time"                      (Q4_K_M -> IQ4_XS)
#
# Qwen3.6-27B-A3B Coder and CoderX at IQ4_XS, 10 oracle runs each, SERIAL, after
# the ornith 27B arms. Coder first, then CoderX.
#
# QUANT NOW MATCHES THE ORNITH ARMS. Source is the user's own ollama registry
# account, pulled on eleven2go: mannix/qwen3.6-27b-a3b-coder:IQ4_XS and
# mannix/qwen3.6-27b-a3b-coderx:IQ4_XS. Both model layers are 14,222,050,784 B
# against ornith 27B's 14,222,050,848 B -- same quant, same 26.2B class. The
# Q4_K_M copies on \\solidpc\opencoti_models are no longer used and never reach
# eleven2go, so there is no Q4_K_M blob there for GC to reclaim.
#
# WHY `FROM <blob file>` AND NOT `FROM mannix/...:IQ4_XS`:
# the registry model carries a params layer --
#   {"draft_num_predict":3,"min_p":0,"num_ctx":32768,"presence_penalty":1.5,
#    "repeat_penalty":1,"temperature":1,"top_k":20,"top_p":0.95}
# Our Modelfile overrides temperature/top_k/top_p/num_ctx/draft_num_predict but
# NOT presence_penalty, min_p or repeat_penalty, so three ornith-mismatched
# values would ride along silently. A bare GGUF blob inherits nothing. The blob
# digests below come from the registry manifests and are pinned; the size gate
# proves the pull landed the file we expect.
#
# WHAT "SAME EXACT CONFIG" COVERS -- everything the ornith arms hold fixed:
#   * MODELFILE: Ornith-27b-coderx-rp-tb.Modelfile copied byte for byte with only
#     the FROM line replaced (verified identical-after-FROM), so RENDERER/PARSER
#     qwen3.5, num_gpu 99, temperature 0.6, think_budget high + the multi-line
#     budget message, top_k 20, top_p 0.95, draft_num_predict 4 and
#     num_ctx 131072 are the ornith values, not retyped. The parity gate below
#     re-proves it from the LIVE base tag before any run starts.
#   * HOST/ENDPOINT: eleven2go http://192.168.178.161:11434 -- same machine,
#     same RTX 3090, same ollama 0.33.3-thinkbudget-reasoning as the ornith arms.
#   * ARM/PROTOCOL/RUNS: ARM=oracle, ./native.sh, 10.
#
# THE AUGUST CONFIG IS DELIBERATELY ABANDONED. a3b-coder_tb / coderx_tb ran in
# August at Q4_K_M with think_budget medium, temperature 1, num_ctx 262144,
# presence_penalty 1.5, against solidPC :11434 -- an endpoint that no longer
# exists. That comparison was already broken; matching ornith makes one clean.
# When reporting: a3b vs August = quant + config + harness + host, uncontrolled;
# a3b vs ornith-27B = model only, controlled.
#
# ONE AT A TIME, as instructed: each model is pulled, created and run to
# completion before the next is pulled, so at most one new 14.2 GB blob lands at
# a time. NOTE eleven2go C: reported 326.1 GB free at 15:45, so 2x14.2 GB is not
# actually tight -- the arm tags are therefore NOT deleted between arms, because
# destroying a finished arm's model would make any later re-inspection
# impossible. Only the transient `mannix/...` pull tags are removed.
#
# DISARM: touch $H/STOP-A3BRERUN  (checked before each arm)
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/a3b-rerun-410080.log"
E="http://192.168.178.161:11434"
V="$H/verdicts-native.txt"
RUNS="${RUNS:-10}"
WANT=14222050784
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
die(){ say "$*"; say "NOT launching."; exit 1; }

harness_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}

say "=== queued: waiting for the ornith 27B arms to finish and release the lane ==="
# Wait for the ornith27 driver to be GONE, not merely for the lane to be free:
# it runs CoderX's ten then Coder's ten, and a lane-only wait would slip into
# the gap between them and interleave the arms.
for i in $(seq 1 2880); do                      # 48 h ceiling
	ps -eo args | grep -q '[g]o-ornith27-coder-coderx' || break
	sleep 60
done
say "ornith27 driver gone"
while harness_busy; do sleep 120; done
say "lane free"

# tag | registry source | modelfile | pinned model-blob digest
for spec in "a3b-coder-rp_tb:27b-high|mannix/qwen3.6-27b-a3b-coder:IQ4_XS|A3b-coder-rp-tb.Modelfile|4db1e82314399360064d7c68503f160bea2e6ba34568531821289eee72dcb6af" \
            "a3b-coderx-rp_tb:27b-high|mannix/qwen3.6-27b-a3b-coderx:IQ4_XS|A3b-coderx-rp-tb.Modelfile|50f90ff9451b885fe48b162b3727f71d985f33f1bdccf418f9f020e553887401"; do
	IFS='|' read -r TAG SRC MF DIGEST <<< "$spec"
	[ -f "$H/STOP-A3BRERUN" ] && { say "stopping before $TAG on STOP-A3BRERUN"; break; }
	while harness_busy; do sleep 120; done

	# ---- pull (3 attempts; a partial pull resumes rather than restarting) -----
	say "--- $TAG: pulling $SRC on eleven2go ---"
	for try in 1 2 3; do
		ssh -o BatchMode=yes eleven2go "ollama pull $SRC" >> "$LOG" 2>&1
		rc=$?
		say "pull attempt $try rc=$rc"
		[ $rc -eq 0 ] && break
		sleep 60
	done

	# GATE: the pinned blob is on disk at the exact expected size. This is what
	# proves we got the IQ4_XS we asked for and not a resumed/truncated file.
	sz=$(ssh -o BatchMode=yes eleven2go "powershell -NoProfile -Command \"(Get-Item (\\\$env:USERPROFILE + '\\.ollama\\models\\blobs\\sha256-$DIGEST')).Length\"" 2>/dev/null | tr -d '\r ')
	say "$TAG blob size: ${sz:-<none>} (want $WANT)"
	[ "$sz" = "$WANT" ] || die "$TAG blob missing or wrong size -- pull failed"
	say "GATE OK: $TAG blob present at $WANT bytes"

	# ---- create from the bare blob -------------------------------------------
	say "creating $TAG from $MF"
	ssh -o BatchMode=yes eleven2go "ollama create $TAG -f \\\\solidpc\\opencoti_models\\$MF" >> "$LOG" 2>&1
	say "create $TAG rc=$?"
	curl -s --max-time 60 "$E/api/tags" | grep -q "$TAG" || die "$TAG did not appear on $E"
	say "GATE OK: $TAG present"

	# Drop the transient pull tag. The blob is now referenced by $TAG, so GC
	# keeps it; this removes only the extra manifest and its params/template
	# layers, which we deliberately did not inherit.
	ssh -o BatchMode=yes eleven2go "ollama rm $SRC" >> "$LOG" 2>&1
	say "removed pull tag $SRC rc=$?"

	# ---- config gate: the sourced param set, asserted literally ---------------
	python3 "$H/check_27b_config.py" "$E" "$TAG" >> "$LOG" 2>&1
	[ $? -eq 0 ] || die "$TAG config gate failed -- the arms would not be comparable"
	say "GATE OK: $TAG carries the sourced param set"

	# ---- residency ------------------------------------------------------------
	# Evict any resident runner: a tag sharing a blob reuses its llama-server and
	# stale serve flags carry over with it.
	for T in $(curl -s --max-time 15 "$E/api/ps" \
	           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
		say "unloading $T"
		curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
	done
	sleep 10

	# Proved, not assumed: ollama's estimator will leave layers on the CPU and
	# that alone is a ~10x throughput difference.
	curl -s --max-time 560 "$E/api/generate" \
	  -d "{\"model\":\"$TAG\",\"prompt\":\"say OK\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":8}}" >> "$LOG" 2>&1
	off=$(ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "(Get-Content ($env:LOCALAPPDATA + \"\Ollama\server.log\") | Select-String -Pattern \"offloaded \d+/\d+ layers\" | Select-Object -Last 1).Line"' 2>/dev/null | tr -d '\r')
	say "$TAG preflight offload: $off"
	have="$(sed -n 's/.*offloaded \([0-9]\+\)\/\([0-9]\+\) layers.*/\1 \2/p' <<< "$off")"
	set -- $have
	[ $# -eq 2 ] && [ -n "$1" ] && [ "$1" = "$2" ] || die "$TAG not fully GPU-resident: $off"
	say "$TAG residency ok: $1/$2 layers"

	# ---- run ------------------------------------------------------------------
	before=$(wc -l < "$V" 2>/dev/null || echo 0)
	rm -f "$H/STOP-NATIVE"
	say "=== $RUNS oracle runs: $TAG on $E (cline 4.100.80, IQ4_XS) ==="
	cd "$H" || die "cannot enter $H"
	ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS="$RUNS" ./native.sh "$RUNS"
	say "=== $TAG: $RUNS runs finished ==="
	tail -n +$((before + 1)) "$V" >> "$LOG"
done
say ">>> A3B_RERUN_410080_DONE"
