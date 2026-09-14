#!/usr/bin/env bash
# QUEUED 2026-09-09. Fires only after the base arm (go-ornith15base35b-rp.sh,
# ornith15-base-rp_tb:35b-high) finishes its 10 runs and releases this lane.
#
# Ornith-1.5-27B-A3B CoderX and Coder at IQ4_XS, 10 oracle runs each, SERIAL --
# CODERX FIRST, then Coder (user-specified 2026-09-09) -- against the base arm's
# 10 runs in this same
# lane. Only the MODEL moves: the arm, protocol, endpoint, RUNS and every sampler
# value are the base arm's, and the two Modelfiles were generated from the live
# `ornith15-base-rp_tb:35b-high` definition rather than retyped, so think_budget,
# the budget message, top_k/top_p/temperature, num_ctx, num_gpu and
# draft_num_predict are byte-identical to it.
#
# NOTE the size class differs: base is 35.5B, these are 27B. That is the point of
# the comparison, but it is NOT a controlled single-variable arm the way the
# renderer/parser change was -- say so when reporting.
#
# DISARM: touch $H/STOP-ORNITH27 (checked before each arm and before creation).
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/ornith27-coder-coderx.log"
E="http://192.168.178.161:11434"
V="$H/verdicts-native.txt"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
die(){ say "$*"; say "NOT launching."; exit 1; }

harness_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}

say "=== queued: waiting for the base arm to release the lane ==="
while harness_busy; do sleep 120; done
say "lane free"
[ -f "$H/STOP-ORNITH27" ] && die "STOP-ORNITH27 present"

# ---- create both tags now that the lane is idle -----------------------------
for spec in "ornith15-coderx-rp_tb:27b-high|Ornith-27b-coderx-rp-tb.Modelfile" \
            "ornith15-coder-rp_tb:27b-high|Ornith-27b-coder-rp-tb.Modelfile"; do
	tag="${spec%%|*}"; mf="${spec##*|}"
	say "creating $tag from $mf"
	ssh -o BatchMode=yes eleven2go "ollama create $tag -f \\\\solidpc\\opencoti_models\\$mf" >> "$LOG" 2>&1
	say "create $tag rc=$?"
	curl -s --max-time 60 "$E/api/tags" | grep -q "$tag" || die "$tag did not appear on $E"
	say "GATE OK: $tag present"
done

# ---- config gate: the sourced param set, asserted literally --------------------
# NOT "byte-identical to the 35B base tag" any more. The base arm deliberately
# carries none of the published params (user 2026-09-09: "ornith 35b does not
# carry them ... but ours must"), so that gate would now fail by design.
python3 "$H/check_27b_config.py" "$E" ornith15-coderx-rp_tb:27b-high ornith15-coder-rp_tb:27b-high >> "$LOG" 2>&1
[ $? -eq 0 ] || die "config gate failed -- the arms would not be comparable"
say "GATE OK: both tags carry the sourced param set"

# ---- serial: Coder's ten, then CoderX's ten ---------------------------------
for TAG in ornith15-coderx-rp_tb:27b-high ornith15-coder-rp_tb:27b-high; do
	[ -f "$H/STOP-ORNITH27" ] && { say "stopping before $TAG on STOP-ORNITH27"; break; }
	while harness_busy; do sleep 120; done

	# Evict any resident runner: a tag built FROM a shared blob reuses its
	# llama-server, and stale serve flags carry over.
	for T in $(curl -s --max-time 15 "$E/api/ps" \
	           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
		say "unloading $T"
		curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
	done
	sleep 10

	# Full residency, proved not assumed: ollama's estimator will leave layers on
	# the CPU and that alone is a 10x throughput difference.
	curl -s --max-time 560 "$E/api/generate" \
	  -d "{\"model\":\"$TAG\",\"prompt\":\"say OK\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":8}}" >> "$LOG" 2>&1
	off=$(ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "(Get-Content ($env:LOCALAPPDATA + \"\Ollama\server.log\") | Select-String -Pattern \"offloaded \d+/\d+ layers\" | Select-Object -Last 1).Line"' 2>/dev/null | tr -d '\r')
	say "$TAG preflight offload: $off"
	have="$(sed -n 's/.*offloaded \([0-9]\+\)\/\([0-9]\+\) layers.*/\1 \2/p' <<< "$off")"
	set -- $have
	[ $# -eq 2 ] && [ -n "$1" ] && [ "$1" = "$2" ] || die "$TAG not fully GPU-resident: $off"
	say "$TAG residency ok: $1/$2 layers"

	before=$(wc -l < "$V" 2>/dev/null || echo 0)
	rm -f "$H/STOP-NATIVE"
	say "=== 10 oracle runs: $TAG on $E ==="
	cd "$H" || die "cannot enter $H"
	ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS=10 ./native.sh 10
	say "=== $TAG: 10 runs finished ==="
	tail -n +$((before + 1)) "$V" >> "$LOG"
done
say ">>> ORNITH27_ARMS_DONE"
