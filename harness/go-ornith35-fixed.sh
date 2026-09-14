#!/usr/bin/env bash
# One run on the corrected 35B (RENDERER qwen3.5, temp 0.6, no TEMPLATE), to see
# whether the sampler/config fix changes the 754-iteration behaviour of 0147.
# Same arm as 0147/0148 so only the model config moves: proposed, reconsider off.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/fix-ornith.log"; E="http://192.168.178.161:11434"
TAG="ornith15-mtp_tb:35b-iq4xs-128k"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# Wait out the rebuild chain AND any create, so no CIFS read races the run.
while pgrep -f "fix-ornith-models.sh" >/dev/null || pgrep -f "ollama create" >/dev/null; do
    sleep 30
done
curl -s --max-time 30 "$E/api/tags" | grep -q "ornith15-mtp_tb" || { say "35B tag never appeared; NOT launching"; exit 1; }
say "corrected 35B present; verifying config"
curl -s --max-time 30 "$E/api/show" -d "{\"model\":\"$TAG\"}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('SHOW parameters:',repr(d.get('parameters','')));print('SHOW modelfile renderer/parser/template:',[l for l in d.get('modelfile','').splitlines() if l.startswith(('RENDERER','PARSER','TEMPLATE'))])" >> "$LOG" 2>&1

rm -f "$H/STOP-ORNITH" "$H/STOP-NATIVE"
say "launching 1 run on $TAG"
cd "$H" || exit 1
MODEL="$TAG" RUNS=1 ./chain-ornith.sh
say "run finished"
