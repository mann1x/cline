#!/usr/bin/env bash
# ornith 27B CoderX with presence_penalty 0 -- 10 oracle runs.
#
# ONE VARIABLE. The Modelfile is `Ornith-27b-coderx-rp-tb.Modelfile` with a
# single line changed, verified by diff: `presence_penalty 1.5` -> `0`. Same
# GGUF blob, same RENDERER/PARSER qwen3.5, same think_budget high and message,
# same draft_num_predict 3, min_p 0, repeat_penalty 1, temperature 0.6,
# top_k 20, top_p 0.95, num_ctx 131072, num_gpu 99. Same host, same arm, same
# oracle, and the SAME deployed cline -- 4.100.90 at 86f9b786b, unchanged. The
# prompt-template split is deliberately NOT deployed first: it would give this
# arm two variables and make it unreadable against the baseline.
#
# WHY. `check_27b_config.py` sourced presence_penalty 1.5 from the published
# BASE model's params layer. ollama's published *coding* model for this family
# ships 0, and so does everything on this harness that works:
#
#   ornith15-base-rp_tb:35b-high   no presence_penalty   8/10 FIXED
#   qwen3.6 27B dense              presence_penalty 0    10/10 FIXED over two dates
#   ornith15-coderx-rp_tb:27b-high presence_penalty 1.5  2/9 FIXED
#
# The `.pre-sourced-params` backup (2026-09-09 08:55) shows the 27B coder
# carried NO presence_penalty before the 16:14 edit that added it; that edit
# also added min_p 0 and repeat_penalty 1, which are ollama's defaults and
# therefore no-ops. presence_penalty was the only behavioural change in it, and
# every -rp_tb:27b-high run ever recorded is on the far side of it.
#
# In llama.cpp this is a flat penalty on any token seen within `repeat_last_n`,
# unset here so ollama's default 64. It shapes local phrasing; it is NOT a
# global "do not repeat that action" memory. The mechanism for run 0190 writing
# 34 differently-named helper programs instead of re-running one check is
# therefore PLAUSIBLE, NOT ESTABLISHED. That is what this arm is for.
#
# THE BAR, and why 90 minutes is not unfair. RUN_TIMEOUT is now 5400s. Read
# against the baseline re-adjudicated at the same budget, the 1.5 arm is 0/9 --
# its only two successes took 14,715s and 7,705s. So any FIXED here is a result.
# Quote the 6h figure (2/9) whenever quoting this arm's, since they are the same
# runs judged against different clocks.
#
# DISARM: touch $H/STOP-PP0
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/ornith27-pp0.log"
E="http://192.168.178.161:11434"
V="$H/verdicts-native.txt"
TAG="${TAG:-ornith15-coderx-pp0_tb:27b-high}"
MF="${MF:-Ornith-27b-coderx-pp0-tb.Modelfile}"
RUNS="${RUNS:-10}"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
die(){ say "$*"; say "NOT launching."; exit 1; }

harness_busy(){
	local p
	for p in $(ps -eo pid,args | grep -F 'native.sh' | grep -v grep | grep -v 'bash -c' | awk '{print $1}'); do
		[ "$p" = "$$" ] && continue
		[ "$(readlink -f /proc/$p/cwd 2>/dev/null)" = "$H" ] && return 0
	done
	return 1
}

[ -f "$H/STOP-PP0" ] && die "STOP-PP0 present"
while harness_busy; do say "lane busy, waiting"; sleep 60; done
say "=== presence_penalty 0 arm: $TAG, $RUNS oracle runs on $E ==="

# ---- create -----------------------------------------------------------------
say "creating $TAG from $MF"
ssh -o BatchMode=yes eleven2go "ollama create $TAG -f \\\\solidpc\\opencoti_models\\$MF" >> "$LOG" 2>&1
say "create rc=$?"
curl -s --max-time 60 "$E/api/tags" | grep -q "$TAG" || die "$TAG did not appear on $E"
say "GATE OK: $TAG present"

# ---- config gate: the sourced set, with presence_penalty 0 expected ---------
python3 "$H/check_27b_config.py" --presence-penalty 0 "$E" "$TAG" >> "$LOG" 2>&1
[ $? -eq 0 ] || die "$TAG config gate failed -- the arms would not be comparable"
say "GATE OK: sourced param set, presence_penalty 0"

# Prove the ONLY difference from the baseline tag is presence_penalty.
python3 - "$E" "$TAG" >> "$LOG" 2>&1 <<'PY'
import json, subprocess, sys
def params(tag):
    r = subprocess.run(["curl","-s","--max-time","30",sys.argv[1]+"/api/show",
                        "-d",json.dumps({"name":tag})],capture_output=True,text=True)
    d = json.loads(r.stdout); out={}
    for ln in (d.get("parameters") or "").splitlines():
        if ln.strip():
            k,_,v=ln.strip().partition(" "); out[k]=v.strip()
    return out
a, b = params("ornith15-coderx-rp_tb:27b-high"), params(sys.argv[2])
diff = sorted(set(a) | set(b))
shown = [(k, a.get(k), b.get(k)) for k in diff if a.get(k) != b.get(k)]
print("params differing from ornith15-coderx-rp_tb:27b-high:")
for k, x, y in shown: print("   %s: %s -> %s" % (k, x, y))
print("ONE-VARIABLE OK" if [k for k,_,_ in shown] == ["presence_penalty"]
      else "ONE-VARIABLE FAIL: %s" % [k for k,_,_ in shown])
PY
grep -q "ONE-VARIABLE OK" "$LOG" || die "more than presence_penalty differs -- see the log"
say "GATE OK: presence_penalty is the only difference"

# ---- residency + spill ------------------------------------------------------
for T in $(curl -s --max-time 15 "$E/api/ps" \
           | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null); do
	say "unloading $T"; curl -s --max-time 30 "$E/api/generate" -d "{\"model\":\"$T\",\"keep_alive\":0}" >/dev/null
done
sleep 10
used=$(ssh -o BatchMode=yes eleven2go "nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits" 2>/dev/null | tr -d '\r ')
say "VRAM used before load: ${used:-<unknown>} MiB"
[ -n "$used" ] && [ "$used" -gt 1000 ] && die "$used MiB in use with nothing loaded -- an orphaned llama-server is squatting on the card"
curl -s --max-time 560 "$E/api/generate" \
  -d "{\"model\":\"$TAG\",\"prompt\":\"say OK\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":8}}" >> "$LOG" 2>&1
off=$(ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "(Get-Content ($env:LOCALAPPDATA + \"\Ollama\server.log\") | Select-String -Pattern \"offloaded \d+/\d+ layers\" | Select-Object -Last 1).Line"' 2>/dev/null | tr -d '\r')
say "preflight offload: $off"
have="$(sed -n 's/.*offloaded \([0-9]\+\)\/\([0-9]\+\) layers.*/\1 \2/p' <<< "$off")"
set -- $have
[ $# -eq 2 ] && [ -n "$1" ] && [ "$1" = "$2" ] || die "$TAG not fully GPU-resident: $off"
say "residency ok: $1/$2 layers"
# 66/66 is not proof the weights are on the card: measured 2026-09-10, an
# orphaned runner left 3.18 GB paging over PCIe at full reported offload.
shared=$(ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "$c = Get-Counter -Counter \"\GPU Adapter Memory(*)\Shared Usage\" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CounterSamples | Measure-Object -Property CookedValue -Maximum; \"{0:N2}\" -f ($c.Maximum/1GB)"' 2>/dev/null | tr -d '\r ')
say "shared (system-RAM) GPU usage: ${shared:-<unknown>} GB"
[ -n "$shared" ] && [ "$(python3 -c "print(1 if float('$shared') > 2.0 else 0)" 2>/dev/null)" = "1" ] \
	&& die "$shared GB spilled to system RAM -- timings would be meaningless"
say "GATE OK: no meaningful spill"

# ---- run --------------------------------------------------------------------
before=$(wc -l < "$V" 2>/dev/null || echo 0)
rm -f "$H/STOP-NATIVE"
cd "$H" || die "cannot enter $H"
ARM=oracle MODEL="$TAG" OLLAMA_BASE_URL="$E" RUNS="$RUNS" ./native.sh "$RUNS"
say "=== $TAG: $RUNS runs finished ==="
tail -n +$((before + 1)) "$V" >> "$LOG"
say ">>> ORNITH27_PP0_DONE"
