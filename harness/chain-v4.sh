#!/usr/bin/env bash
# 10 runs of omnimerge-v4 once both v6 batches (0056-0065) are done.
#
# v4 and v6 share their params blob byte-for-byte -- same sampling, same
# num_ctx 131072, same draft_num_predict 4, same think_budget medium -- so the
# only declared difference is the renderer (v4 qwen3.5, v6 qwen3.8). Both are
# forced to full GPU residency with num_gpu 99, because ollama's estimator
# leaves two layers on the CPU otherwise and that alone is a 10x throughput
# difference; a speed comparison against a partly-CPU arm would measure the
# estimator, not the model.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/chain-v4.log"
E="http://192.168.178.161:11434"
MODEL="omnimerge-v4-mtp_tb:27b-q4km-128k"
MS="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/ollama_models"
MANIFEST="$MS/manifests/registry.ollama.ai/library/omnimerge-v4-mtp_tb/27b-q4km-128k"
BOTH_BATCHES='[-]00(5[6-9]|6[0-5])'   # NOT a leading '-': ugrep reads that as options

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
die() { say "$*"; say "NOT launching the v4 batch."; exit 1; }

say "armed; waiting for both v6 batches (0056-0065) to finish"
while :; do
	n=$(grep -cE -e "$BOTH_BATCHES" "$H/verdicts-native.txt" 2>/dev/null); [ -n "$n" ] || n=0
	if [ "$n" -ge 10 ] && ! pgrep -f 'bash \./native\.sh' > /dev/null; then break; fi
	sleep 120
done
say "both v6 batches complete (10 verdicts, loop idle)"

# The copy has to have finished, and the bytes have to match. A truncated blob
# would surface as a baffling load failure ten runs deep.
grep -q 'COPY-OK' "$H/copy-v4.log" 2>/dev/null || die "v4 blob copy did not report COPY-OK"
want=$(python3 -c "
import json;d=json.load(open('$MANIFEST'))
print([l['size'] for l in d['layers'] if l['mediaType'].endswith('.model')][0])")
got=$(ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "(Get-Item ($env:USERPROFILE + \"\.ollama\models\blobs\sha256-59e5c6fa3d44cb56937001696b6869b4b2cb2fe0643c0c12cd63a0a8221dfb79\")).Length"' 2>/dev/null | tr -d '\r\n ')
[ "$want" = "$got" ] || die "v4 weights size mismatch: want $want got $got"
say "v4 weights verified: $got bytes"

ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path ($env:USERPROFILE + \"\.ollama\models\manifests\registry.ollama.ai\library\omnimerge-v4-mtp_tb\") | Out-Null"' >/dev/null 2>&1
scp -o ConnectTimeout=30 "$MANIFEST" 'eleven2go:.ollama/models/manifests/registry.ollama.ai/library/omnimerge-v4-mtp_tb/27b-q4km-128k' >/dev/null 2>&1 || die "manifest copy failed"
curl -s --max-time 60 "$E/api/tags" | grep -q 'omnimerge-v4-mtp_tb' || die "v4 does not appear in /api/tags"
say "v4 manifest installed"

# Same full-residency override v6 carries.
curl -s --max-time 280 "$E/api/create" -d "{\"model\":\"$MODEL\",\"from\":\"$MODEL\",\"parameters\":{\"num_gpu\":99}}" >> "$LOG" 2>&1
say "num_gpu 99 baked into $MODEL"

# Preflight: prove it actually loads 66/66 before spending ten runs on it.
curl -s --max-time 60 "$E/api/generate" -d "{\"model\":\"$MODEL\",\"keep_alive\":0}" >/dev/null 2>&1
curl -s --max-time 560 "$E/api/generate" -d "{\"model\":\"$MODEL\",\"prompt\":\"say OK\",\"stream\":false,\"think\":false,\"options\":{\"num_predict\":8}}" >> "$LOG" 2>&1
off=$(ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "(Get-Content ($env:LOCALAPPDATA + \"\Ollama\server.log\") | Select-String -Pattern \"offloaded \d+/\d+ layers\" | Select-Object -Last 1).Line"' 2>/dev/null | tr -d '\r')
say "preflight offload: $off"
case "$off" in *"offloaded 66/66"*) ;; *) die "v4 did not reach full GPU residency: $off" ;; esac

sed -i 's/^FIRST = .*/FIRST = 66          # omnimerge-v4 comparison batch (0066-0075)/' "$H/tx_watch.py"
sed -i 's/^EXPECTED = .*/EXPECTED = 10/'                                                "$H/tx_watch.py"

cd "$H" || exit 1
rm -f "$H/STOP-NATIVE"
MODEL="$MODEL" OLLAMA_BASE_URL="$E" nohup ./native.sh 10 > "$H/native-0066.log" 2>&1 &
say "native.sh launched pid $! -- 10 runs of $MODEL"
sleep 20
nohup python3 tx_watch.py > "$H/tx-0066.log" 2>&1 &
say "tx_watch launched pid $! -> tx-0066.log"
