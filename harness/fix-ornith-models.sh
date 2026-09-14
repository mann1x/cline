#!/usr/bin/env bash
# Rebuild both ornith tb models on the faithful config:
#   RENDERER/PARSER qwen3.5  (reproduces the GGUF Jinja default branch in Go,
#                             and is required at all for think_budget to arm)
#   temp 0.6 / top_k 20 / top_p 0.95   (ornith 1.0 line + the 27B README;
#                                       official ornith-1.5 ships no params)
#   no TEMPLATE
# The earlier tags used RENDERER ornith (= preserve_thinking, the 1.0 line's
# opt-in) and temp 1 with v4's presence_penalty 0. Both are wrong for 1.5.
set -uo pipefail
LOG=/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness/fix-ornith.log
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# Never race two big CIFS reads: wait out any create already in flight.
while pgrep -f "ollama create" > /dev/null; do say "waiting for an in-flight create"; sleep 30; done

for spec in "ornith15-mtp_tb:35b-iq4xs-128k:Ornith-35b-v2.Modelfile" \
            "ornith15-coder-mtp_tb:27b-q4km-128k:Ornith-27b-v2.Modelfile"; do
    tag="${spec%:*}"; mf="${spec##*:}"
    say "creating $tag from $mf"
    ssh -o BatchMode=yes eleven2go "ollama create $tag -f \\\\solidpc\\opencoti_models\\$mf" >> "$LOG" 2>&1
    say "create $tag rc=$?"
done
say "done"
