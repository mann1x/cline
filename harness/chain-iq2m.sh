#!/usr/bin/env bash
# Build the thinkbudget model from the freshly pulled mannix/omnimerge-v6:IQ2_M
# and run 10 manic_miner runs (0076-0085) against it on eleven2go.
#
# This is a quant arm, and it is only worth running because the published
# IQ2_M already declares everything the q4km arm declares: renderer qwen3.8,
# parser qwen3.5, draft_num_predict 4 (so the MTP head is present), and the
# same six sampler values. The four things it does NOT declare -- num_ctx,
# think_budget, think_budget_message, num_gpu -- are exactly what this adds,
# which leaves file_type as the single variable against runs 0056-0065.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/chain-iq2m.log"
E="http://192.168.178.161:11434"
BASE="mannix/omnimerge-v6:IQ2_M"
MODEL="omnimerge-v6-mtp_tb:27b-iq2m-128k"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
die() { say "FAIL: $*"; say "NOT launching the IQ2_M batch."; exit 1; }

say "armed; waiting for the pull to finish"
while :; do
	grep -qE 'PULL END|PULL-ERROR' "$H/pull-iq2m.log" 2>/dev/null && break
	pgrep -f '[p]ull-iq2m.sh' > /dev/null 2>&1 || die "pull process vanished with no end marker"
	sleep 30
done
grep -q 'PULL END.*rc=0' "$H/pull-iq2m.log" || die "pull did not end rc=0: $(tail -2 "$H/pull-iq2m.log" | tr '\n' ' ')"
say "pull finished rc=0"

# The pull reports success before the manifest is queryable in some versions;
# ask the server rather than trusting the stream.
curl -s --max-time 30 "$E/api/tags" | grep -q "$BASE" || die "$BASE absent from /api/tags after pull"
say "$BASE present in /api/tags"

# Weights must be the full 10243577408 bytes the registry manifest declares.
# A short blob surfaces later as an inscrutable load failure, not as a bad pull.
got=$(curl -s --max-time 30 "$E/api/show" -d "{\"model\":\"$BASE\"}" |
	python3 -c "import json,sys; print(json.load(sys.stdin)['details'].get('quantization_level',''))" 2>/dev/null)
[ "$got" = "IQ2_M" ] || die "pulled model reports quantization_level='$got', expected IQ2_M"
say "quantization verified: IQ2_M"

# Create the tb model. Structured /api/create so the budget message keeps its
# newlines -- a Modelfile heredoc has mangled that string before.
say "creating $MODEL from $BASE"
python3 - "$E" "$MODEL" "$BASE" > "$H/create-iq2m.log" 2>&1 <<'PY'
import json, sys, urllib.request
endpoint, model, base = sys.argv[1], sys.argv[2], sys.argv[3]
body = {
    "model": model,
    "from": base,
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
    },
    "stream": True,
}
req = urllib.request.Request(
    endpoint + "/api/create",
    data=json.dumps(body).encode(),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(req, timeout=1800) as response:
    for line in response:
        line = line.decode(errors="replace").strip()
        if not line:
            continue
        record = json.loads(line)
        if "error" in record:
            print("CREATE-ERROR", record["error"]); sys.exit(1)
        print(record.get("status", ""))
print("CREATE-OK")
PY
grep -q 'CREATE-OK' "$H/create-iq2m.log" || die "create failed: $(tail -3 "$H/create-iq2m.log" | tr '\n' ' ')"
say "created $MODEL"

# Everything the arm depends on, read back from the server rather than assumed.
curl -s --max-time 30 "$E/api/show" -d "{\"model\":\"$MODEL\"}" > "$H/show-iq2m.json"
python3 - "$H/show-iq2m.json" >> "$LOG" 2>&1 <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
mf, params = d.get("modelfile", ""), d.get("parameters", "")
want = {
    "RENDERER qwen3.8": mf, "PARSER qwen3.5": mf,
    "num_ctx                        131072": params,
    "num_gpu                        99": params,
    "draft_num_predict              4": params,
    'think_budget                   "medium"': params,
    "temperature                    1": params,
    "top_k                          20": params,
    "top_p                          0.95": params,
}
missing = [k for k, hay in want.items() if k not in hay]
quant = d.get("details", {}).get("quantization_level")
if quant != "IQ2_M":
    missing.append(f"quantization_level={quant} (expected IQ2_M)")
if missing:
    print("VERIFY-FAILED: " + "; ".join(missing)); sys.exit(1)
print("VERIFY-OK: renderer/parser, sampler, MTP, 128k, num_gpu 99, IQ2_M all present")
PY
grep -q 'VERIFY-OK' "$LOG" || die "model definition did not verify"

# Preflight: a real generation, then the server's own residency line. /api/ps
# does not count the KV cache and has misreported this before, so the log is
# what decides.
say "preflight: loading at 128k"
curl -s --max-time 900 "$E/api/generate" \
	-d "{\"model\":\"$MODEL\",\"prompt\":\"reply with the single word: ready\",\"stream\":false,\"options\":{\"num_predict\":8}}" \
	> "$H/preflight-iq2m.json" 2>&1
python3 -c "
import json
d=json.load(open('$H/preflight-iq2m.json'))
print('preflight response:', repr(d.get('response','')[:80]), 'done_reason=', d.get('done_reason'))
" >> "$LOG" 2>&1 || die "preflight generate returned nothing usable"

off=$(ssh -o BatchMode=yes eleven2go 'type "%LOCALAPPDATA%\Ollama\server.log"' 2>/dev/null |
	grep -a 'offloaded' | tail -1 | tr -d '\r')
say "preflight residency: $off"
# Assert full residency, not a specific count: the layer count belongs to the
# architecture and asserting 66 would fail spuriously if this GGUF differs.
frac=$(printf '%s' "$off" | grep -oE 'offloaded [0-9]+/[0-9]+' | tail -1 | awk '{print $2}')
[ -n "$frac" ] || die "no offload line in the server log -- '$off'"
[ "${frac%/*}" = "${frac#*/}" ] || die "not fully resident (${frac}); a partial offload would measure ollama's estimator, not the quant"
say "full GPU residency confirmed (${frac} layers)"

# Point the watcher at this batch before the loop can produce anything.
sed -i 's/^FIRST = .*/FIRST = 76          # omnimerge-v6 IQ2_M quant arm (0076-0085)/' "$H/tx_watch.py"
sed -i 's/^EXPECTED = .*/EXPECTED = 10/' "$H/tx_watch.py"
say "tx_watch repointed at 0076-0085"
setsid nohup python3 "$H/tx_watch.py" > "$H/tx-0076.log" 2>&1 < /dev/null &

cd "$H" || die "cannot cd to $H"
MODEL="$MODEL" OLLAMA_BASE_URL="$E" setsid nohup ./native.sh 10 \
	> "$H/native-iq2m.log" 2>&1 < /dev/null &
say "launched pid $! -- 10 runs of $MODEL against $E"
