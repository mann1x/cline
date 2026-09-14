#!/usr/bin/env bash
# Stop a run the moment it leaves TX-01.
#
# The question these two runs are answering is how long the first transaction
# takes, so a run that discards TX-01 and starts over has already given its
# answer -- everything after that is the wall we are trying to measure, not
# more signal. transactions.txt is only written at teardown, so the live
# trigger is the `atomic_transaction` notice in run.jsonl, which fires the
# moment a transaction closes.
#
# Kills only the run's own CLI child, never the chain: the next model in the
# chain still gets its turn.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/tx02-guard.log"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

say "guard armed"
declare -A done_run
while pgrep -f 'go-ornith-bare[2]\.sh' >/dev/null; do
	run_dir="$(ls -1dt "$H"/runs-native/*/ 2>/dev/null | head -1)"
	jsonl="$run_dir/run.jsonl"
	if [[ -n "$run_dir" && -f "$jsonl" && -z "${done_run[$run_dir]:-}" ]]; then
		hit="$(python3 - "$jsonl" <<'PY'
import json,sys
for line in open(sys.argv[1], errors="ignore"):
    try: e = (json.loads(line).get("event") or {})
    except Exception: continue
    if e.get("type") != "notice": continue
    if (e.get("metadata") or {}).get("kind") != "atomic_transaction": continue
    msg = e.get("message") or ""
    # TX-01 closing as anything but kept means the run is now in TX-02.
    if msg.startswith("TX-01") and "kept" not in msg.split("—")[0]:
        print(msg[:160]); break
    if msg.startswith("TX-02"):
        print(msg[:160]); break
PY
)"
		if [[ -n "$hit" ]]; then
			say "TX-02 reached in $(basename "$run_dir"): $hit"
			printf 'stopped by tx02-guard: %s\n' "$hit" > "$run_dir/STOPPED-TX02.txt"
			pkill -f 'cline-scan/apps/cli/src/index\.t[s]' && say "killed CLI child"
			done_run[$run_dir]=1
		fi
	fi
	sleep 20
done
say "guard done (chain finished)"
