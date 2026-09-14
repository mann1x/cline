#!/usr/bin/env bash
# Wait for the qwen36-base tag to finish importing, then start the control run.
# Never kills the import -- it only watches for the tag to appear, and gives up
# after 40 minutes rather than spinning.
set -uo pipefail
H="/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness"
LOG="$H/oracle3.log"
E="http://192.168.178.161:11434"
say(){ printf '%s  %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }
deadline=$(( $(date +%s) + 2400 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
	if curl -s --max-time 20 "$E/api/tags" \
	   | python3 -c 'import json,sys; sys.exit(0 if any("qwen36-base" in m["name"] for m in json.load(sys.stdin)["models"]) else 1)' 2>/dev/null; then
		say "qwen36-base tag is present; launching the control run"
		exec "$H/go-base1.sh"
	fi
	sleep 30
done
say "!! qwen36-base tag never appeared within 40 min -- control run NOT started"
