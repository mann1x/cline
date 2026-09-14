#!/usr/bin/env bash
set -uo pipefail
BLOCK="$(dirname "$0")/verdict-block.sh"
RUN_TIMEOUT=7200
pass=0; fail=0
check() { # name expected out status elapsed jsonl_nonempty
  local name=$1 expected=$2 status=$4 elapsed=$5
  local out=$3
  local run_dir; run_dir=$(mktemp -d)
  [[ "$6" == "yes" ]] && echo '{"x":1}' > "$run_dir/run.jsonl" || : > "$run_dir/run.jsonl"
  local verdict="broken" started=0 ended=$elapsed
  source "$BLOCK"
  if [[ "$verdict" == "$expected" ]]; then
    printf '  PASS  %-34s -> %-8s %s\n' "$name" "$verdict" "$(cat "$run_dir/abort-reason.txt" 2>/dev/null)"
    pass=$((pass+1))
  else
    printf '  FAIL  %-34s -> %-8s (expected %s)\n' "$name" "$verdict" "$expected"
    fail=$((fail+1))
  fi
  rm -rf "$run_dir"
}
OK='{"ok":true,"reached_playing":true}'
NO='{"ok":false,"error":"frame 181: ReferenceError"}'
check "oracle passed, quick"          FIXED   "$OK" 0   500  yes
check "oracle passed AT the cap"      FIXED   "$OK" 124 7200 yes
check "oracle failed, quick"          broken  "$NO" 0   500  yes
check "timeout kill (124)"            TIMEOUT "$NO" 124 7205 yes
check "timeout kill -9 (137)"         TIMEOUT "$NO" 137 7260 yes
check "CLI self-timeout, exit 0"      TIMEOUT "$NO" 0   7202 yes
check "just under the cap is a verdict" broken "$NO" 0  7100 yes
check "operator kill (143)"           ABORTED "$NO" 143 1000 yes
check "crash (exit 1)"                ABORTED "$NO" 1   300  yes
check "clean exit, empty event log"   ABORTED "$NO" 0   300  no
echo "  ---- $pass passed, $fail failed"
[[ $fail -eq 0 ]]
