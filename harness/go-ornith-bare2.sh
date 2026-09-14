#!/usr/bin/env bash
# One run each on the bare (GGUF-jinja, no renderer/parser) Ornith tags, 35B
# then 27B, on 0.33.3-thinkbudget-chattags2 where a bare model finally gets a think_budget: medium + cap message, as every
# thinking budget. Same arm as every earlier Ornith run -- proposed,
# reconsider off, max_tx 6 -- so only the model moves between the two.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/ornith-bare2tb.log"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

for TAG in ornith15-jinja-bare_tb:35b-t10 ornith15-coder-jinja-bare_tb:27b-t10; do
    # Never start a run on top of another: two on one card measures contention.
    while pgrep -f 'bash \./native\.sh' >/dev/null; do sleep 60; done
    rm -f "$H/STOP-ORNITH" "$H/STOP-NATIVE"
    say "=== launching 1 run on $TAG ==="
    cd "$H" || exit 1
    MODEL="$TAG" RUNS=1 ./chain-ornith.sh
    say "=== $TAG run finished ==="
    tail -1 "$H/verdicts-native.txt" >> "$LOG"
done
say "both bare runs done"
