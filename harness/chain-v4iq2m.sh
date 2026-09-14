#!/usr/bin/env bash
# 10 runs of omnimerge-v4 at IQ2_M (0086-0095), after the v6 IQ2_M batch.
#
# The question is the base model: v6 is built on qwen3.8, v4 on qwen3.6. Every
# other knob is pinned to what the v6 IQ2_M arm runs, so the arms differ in the
# base and the quant family only.
#
# draft_num_predict is 3 here, the published v4 value. It is not a free knob:
# the MTP draft head belongs to the base, and 3 is what qwen3.6 ships while
# qwen3.8 ships 4. Forcing 4 would measure a mis-configured v4 rather than v4,
# so each arm runs its own base at its own depth.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/chain-v4iq2m.log"
E="http://192.168.178.161:11434"
BASE="mannix/omnimerge-v4:IQ2_M"
MODEL="omnimerge-v4-mtp_tb:27b-iq2m-128k"
V6BATCH='[-]00(7[6-9]|8[0-5])'   # NOT a leading '-': ugrep reads that as options

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
die() { say "FAIL: $*"; say "NOT launching the v4 IQ2_M batch."; exit 1; }

say "armed; waiting for the v6 IQ2_M batch (0076-0085) to finish"
while :; do
	n=$(grep -cE -e "$V6BATCH" "$H/verdicts-native.txt" 2>/dev/null); [ -n "$n" ] || n=0
	if [ "$n" -ge 10 ] && ! pgrep -f 'bash \./native\.sh' > /dev/null; then break; fi
	sleep 120
done
say "v6 IQ2_M batch complete (10 verdicts, loop idle)"

say "pulling $BASE"
curl -sN --max-time 7200 "$E/api/pull" -d "{\"model\":\"$BASE\",\"stream\":true}" |
	python3 -u -c '
import json, sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: d=json.loads(line)
    except ValueError: continue
    if "error" in d: print("PULL-ERROR", d["error"]); sys.exit(1)
    if d.get("status") in ("success",): print("PULL-OK")
' >> "$LOG" 2>&1
grep -q 'PULL-OK' "$LOG" || die "pull did not report success"
curl -s --max-time 30 "$E/api/tags" | grep -q "$BASE" || die "$BASE absent from /api/tags"
got=$(curl -s --max-time 30 "$E/api/show" -d "{\"model\":\"$BASE\"}" |
	python3 -c "import json,sys; print(json.load(sys.stdin)['details'].get('quantization_level',''))" 2>/dev/null)
[ "$got" = "IQ2_M" ] || die "pulled model reports quantization_level='$got', expected IQ2_M"
say "pulled and verified IQ2_M"

say "creating $MODEL"
python3 - "$E" "$MODEL" "$BASE" > "$H/create-v4iq2m.log" 2>&1 <<'PY'
import json, sys, urllib.request
endpoint, model, base = sys.argv[1], sys.argv[2], sys.argv[3]
body = {
    "model": model, "from": base,
    "parameters": {
        "num_ctx": 131072,
        "think_budget": "medium",
        "think_budget_message": (
            "\n\nI have used my thinking budget. I must stop analysing now and "
            "act on what I have: make the tool call, or give a short final "
            "answer if no call is needed.\nI'll be more terse and concise now "
            "and maybe I need to consider a different approach.\n"
        ),
        "num_gpu": 99,
        # qwen3.6's own MTP depth. Inherited from the base anyway; stated
        # explicitly so the arm's configuration is legible in one place.
        "draft_num_predict": 3,
    },
    "stream": True,
}
req = urllib.request.Request(endpoint + "/api/create", data=json.dumps(body).encode(),
                             headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=1800) as r:
    for line in r:
        line = line.decode(errors="replace").strip()
        if not line: continue
        rec = json.loads(line)
        if "error" in rec: print("CREATE-ERROR", rec["error"]); sys.exit(1)
print("CREATE-OK")
PY
grep -q 'CREATE-OK' "$H/create-v4iq2m.log" || die "create failed: $(tail -3 "$H/create-v4iq2m.log" | tr '\n' ' ')"
say "created $MODEL"

curl -s --max-time 30 "$E/api/show" -d "{\"model\":\"$MODEL\"}" > "$H/show-v4iq2m.json"
python3 - "$H/show-v4iq2m.json" >> "$LOG" 2>&1 <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
mf, params = d.get("modelfile",""), d.get("parameters","")
want = {"RENDERER qwen3.5": mf, "PARSER qwen3.5": mf,
        "num_ctx                        131072": params,
        "num_gpu                        99": params,
        "draft_num_predict              3": params,
        'think_budget                   "medium"': params,
        "temperature                    1": params,
        "top_k                          20": params,
        "top_p                          0.95": params}
missing = [k for k, hay in want.items() if k not in hay]
q = d.get("details", {}).get("quantization_level")
if q != "IQ2_M": missing.append(f"quantization_level={q}")
print("VERIFY-FAILED: " + "; ".join(missing) if missing
      else "VERIFY-OK: renderer/parser, sampler, MTP=3, 128k, num_gpu 99, IQ2_M")
sys.exit(1 if missing else 0)
PY
grep -q 'VERIFY-OK' "$LOG" || die "model definition did not verify"

say "preflight: loading at 128k"
curl -s --max-time 900 "$E/api/generate" \
	-d "{\"model\":\"$MODEL\",\"prompt\":\"reply with the single word: ready\",\"stream\":false,\"options\":{\"num_predict\":8}}" \
	> "$H/preflight-v4iq2m.json" 2>&1
python3 -c "
import json
d=json.load(open('$H/preflight-v4iq2m.json'))
print('preflight: response=%r thinking=%r done=%s' % (d.get('response','')[:40], (d.get('thinking') or '')[:60], d.get('done_reason')))
" >> "$LOG" 2>&1 || die "preflight returned nothing usable"

off=$(ssh -o BatchMode=yes eleven2go 'type "%LOCALAPPDATA%\Ollama\server.log"' 2>/dev/null |
	grep -a 'offloaded' | tail -1 | tr -d '\r')
say "preflight residency: $off"
frac=$(printf '%s' "$off" | grep -oE 'offloaded [0-9]+/[0-9]+' | tail -1 | awk '{print $2}')
[ -n "$frac" ] || die "no offload line in the server log"
[ "${frac%/*}" = "${frac#*/}" ] || die "not fully resident (${frac}); would measure the estimator, not the model"
say "full GPU residency confirmed (${frac} layers)"

sed -i 's/^FIRST = .*/FIRST = 86          # omnimerge-v4 IQ2_M arm (0086-0095)/' "$H/tx_watch.py"
sed -i 's/^EXPECTED = .*/EXPECTED = 10/' "$H/tx_watch.py"
say "tx_watch repointed at 0086-0095"
setsid nohup python3 "$H/tx_watch.py" > "$H/tx-0086.log" 2>&1 < /dev/null &

cd "$H" || die "cannot cd to $H"
MODEL="$MODEL" OLLAMA_BASE_URL="$E" setsid nohup ./native.sh 10 \
	> "$H/native-v4iq2m.log" 2>&1 < /dev/null &
say "launched pid $! -- 10 runs of $MODEL against $E"
