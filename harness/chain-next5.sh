#!/usr/bin/env bash
# Start a second batch of 5 once the first has genuinely finished.
#
# Detached with setsid so it outlives the session that armed it -- background
# shells started through the agent harness get reaped, and three waiters were
# killed that way before this was written. native.sh itself survives for the
# same reason.
#
# It will NOT launch on top of a batch that ended early: a loop that was killed
# by hand leaves fewer than five verdicts, and starting another five on top of
# that would be inventing work nobody asked for.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/chain-next5.log"
FIRST_BATCH='-005[6-9]|-0060'
MODEL="omnimerge-v6-mtp_tb:27b-q4km-128k"
BASE="http://192.168.178.161:11434"

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

say "armed; waiting for the current native.sh to finish"
while pgrep -f 'bash \./native\.sh' > /dev/null; do sleep 60; done
say "loop exited"

done_n=$(grep -cE "$FIRST_BATCH" "$H/verdicts-native.txt" 2>/dev/null || echo 0)
if [ "$done_n" -lt 5 ]; then
	say "ONLY $done_n/5 verdicts for runs 0056-0060 -- the batch did not finish normally."
	say "NOT launching a second batch. Re-run by hand once the reason is understood."
	exit 1
fi
say "first batch complete ($done_n/5). starting runs 0061-0065."

# The watcher's start index is a constant in the file; the first batch's watcher
# has exited by now, so this is not editing a script while it runs.
sed -i 's/^FIRST = .*/FIRST = 61          # second omnimerge-v6 128k batch (0061-0065)/' "$H/tx_watch.py"

cd "$H" || exit 1
rm -f "$H/STOP-NATIVE"
MODEL="$MODEL" OLLAMA_BASE_URL="$BASE" nohup ./native.sh 5 > "$H/native-0061.log" 2>&1 &
say "native.sh launched pid $!"
sleep 20
nohup python3 tx_watch.py > "$H/tx-0061.log" 2>&1 &
say "tx_watch launched pid $! -> tx-0061.log"
