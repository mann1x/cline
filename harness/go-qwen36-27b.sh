#!/usr/bin/env bash
# Qwen3.6 27B DENSE on the native harness -- 5 oracle runs.
#
# WHY. The 27B arms that have run here so far are the PRUNED derivatives of the
# 35B-A3B (ornith15-*, family qwen35moe, 26.2B), and the last of them, run 0190,
# spent 5h06m and 766 turns to end on the error it started with. The user
# (2026-09-10): "there's no such delta between qwen3.6 27b and qwen 3.6 a3b 35b
# or our 27b pruned versions. a3b is weaker but not at this scale. only on our
# cline test harness it sucks so incredibly bad ... 27b dense works wonderfully,
# much better than any other coding harness."
#
# So this is the control the campaign never ran: a model known to work well in
# daily use on this same extension, on the same task, same host, same arm. It
# separates the two readings of run 0190 that the a3b arms alone cannot:
#   * finishes near its usual ~5 min -> the harness is sound and the finding is
#     about a3b and its prunings.
#   * grinds to the 90m timeout as well -> the instrument is broken and no arm
#     measured so far means what it was taken to mean.
#
# RUN IT AS SHIPPED. The tag's sampler is NOT forced to match the ornith arms.
# check_27b_config.py reports four differences from the pruned-27B parity set --
# draft_num_predict 4, presence_penalty 0, temperature 1, think_budget medium --
# and every one of them is this model's own published config, the config the
# user actually runs and is describing as working. Matching them to the ornith
# arms would make the control a model nobody has ever called good. The gate is
# therefore run for the RECORD, not as a gate; the params go in the log verbatim
# so the difference is on file rather than assumed away.
# Structurally the tag is already proven: RENDERER/PARSER qwen3.5, MTP head
# (qwen35.nextn_predict_layers 1, 4 NextN tensors), num_gpu 99, num_ctx 131072.
#
# TIMEOUT is native.sh's new default, 5400s. The point of this arm is speed, so
# a run that reaches 90 minutes is itself the answer.
#
# The tag already exists on eleven2go: nothing is pulled, created or removed.
#
# DISARM: touch $H/STOP-QWEN36  (checked before the arm and by native.sh's own
# STOP-NATIVE between runs)
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/qwen36-27b.log"
E="http://192.168.178.161:11434"
V="$H/verdicts-native.txt"
TAG="${TAG:-qwen36-base-mtp_tb:27b-q4km-128k}"
RUNS="${RUNS:-5}"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
die(){ say "$*"; say "NOT launching."; exit 1; }

# Never `pkill -f`/`pgrep -f`: the pattern matches this shell. Match on the
# process's cwd instead, which only a real harness run has.
harness_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$p" = "$$" ] && continue
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}

[ -f "$H/STOP-QWEN36" ] && die "STOP-QWEN36 present"
while harness_busy; do say "lane busy, waiting"; sleep 60; done
say "=== qwen3.6 27B dense control arm: $TAG, $RUNS oracle runs on $E ==="

curl -s --max-time 30 "$E/api/tags" | grep -q "$TAG" || die "$TAG not on $E"
say "GATE OK: $TAG present"

# For the record, not as a gate -- see the header.
say "--- config gate output (differences below are the model's own published sampler) ---"
python3 "$H/check_27b_config.py" "$E" "$TAG" >> "$LOG" 2>&1
say "--- /api/show parameters verbatim ---"
curl -s --max-time 30 "$E/api/show" -d "{\"name\":\"$TAG\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("parameters"))' >> "$LOG" 2>&1

# Evict every resident runner: a tag sharing a blob reuses another tag's
# llama-server, and its serve flags carry over with it.
for T in $(curl -s --max-time 15 "$E/api/ps" \
           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
	say "unloading $T"
	curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
done
sleep 10

# GATE: the card is actually empty before we load.
#
# Measured 2026-09-10, and it is why this arm's first attempt had to be thrown
# away. An ollama restart at 12:39 orphaned the llama-server it had started four
# minutes earlier; /api/ps reported {"models":[]} and ollama had no idea the
# process existed, but it held 4,026 MiB for the next nine hours. The dense 27B
# needs ~22.3 GB at num_ctx 131072, so with 4 GB gone it did not fit -- and
# Windows does not fail that allocation, it silently pages the overflow to
# system RAM over PCIe. The run went at 21.5 tok/s instead of 45.8, and nothing
# in ollama, /api/ps or the offload line said why. Unloading models cannot fix
# this: ollama only unloads runners it knows about.
say "--- pre-load VRAM ---"
used=$(ssh -o BatchMode=yes eleven2go "nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits" 2>/dev/null | tr -d '\r ')
say "VRAM used before load: ${used:-<unknown>} MiB"
if [ -n "$used" ] && [ "$used" -gt 1000 ]; then
	say "orphaned runners holding the card:"
	ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "Get-Process llama-server -ErrorAction SilentlyContinue | Select-Object Id,StartTime | Format-Table -AutoSize | Out-String"' 2>/dev/null | tr -d '\r' >> "$LOG"
	die "$used MiB already in use with nothing loaded -- an orphaned llama-server is squatting on the card. Kill it by exact PID (ask first), then re-run."
fi
say "GATE OK: card is empty"


# Proved, not assumed: ollama's estimator will leave layers on the CPU and that
# alone is a ~10x throughput difference -- which is the very thing this arm is
# trying to measure, so it cannot be left to chance.
curl -s --max-time 560 "$E/api/generate" \
  -d "{\"model\":\"$TAG\",\"prompt\":\"say OK\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":8}}" >> "$LOG" 2>&1
off=$(ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "(Get-Content ($env:LOCALAPPDATA + \"\Ollama\server.log\") | Select-String -Pattern \"offloaded \d+/\d+ layers\" | Select-Object -Last 1).Line"' 2>/dev/null | tr -d '\r')
say "preflight offload: $off"
have="$(sed -n 's/.*offloaded \([0-9]\+\)\/\([0-9]\+\) layers.*/\1 \2/p' <<< "$off")"
set -- $have
[ $# -eq 2 ] && [ -n "$1" ] && [ "$1" = "$2" ] || die "$TAG not fully GPU-resident: $off"
say "residency ok: $1/$2 layers"

# ...and 66/66 is NOT proof the weights are on the card. That line reports what
# ollama ASSIGNED to the GPU; when the allocation exceeds VRAM the Windows
# driver keeps the assignment and pages the excess over PCIe, so the gate above
# passed at full marks while 3.18 GB was resident in system RAM. Only the
# adapter's own shared-usage counter can see it.
#   measured: 3.18 GB shared -> 21.5 tok/s   (orphan present, spilling)
#             1.06 GB shared -> 45.8 tok/s   (card clean; desktop baseline)
shared=$(ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "$c = Get-Counter -Counter \"\GPU Adapter Memory(*)\Shared Usage\" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CounterSamples | Measure-Object -Property CookedValue -Maximum; \"{0:N2}\" -f ($c.Maximum/1GB)"' 2>/dev/null | tr -d '\r ')
say "shared (system-RAM) GPU usage with the model loaded: ${shared:-<unknown>} GB"
if [ -n "$shared" ] && [ "$(python3 -c "print(1 if float('$shared') > 2.0 else 0)" 2>/dev/null)" = "1" ]; then
	die "$shared GB spilled to system RAM -- the model is paging over PCIe and any timing from this run would be meaningless."
fi
say "GATE OK: no meaningful spill"

before=$(wc -l < "$V" 2>/dev/null || echo 0)
rm -f "$H/STOP-NATIVE"
cd "$H" || die "cannot enter $H"
ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS="$RUNS" ./native.sh "$RUNS"
say "=== $TAG: $RUNS runs finished ==="
tail -n +$((before + 1)) "$V" >> "$LOG"
say ">>> QWEN36_27B_DENSE_DONE"
