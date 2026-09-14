#!/usr/bin/env bash
# Pull mannix/omnimerge-v6:IQ2_M onto eleven2go. Detached because ollama aborts
# a pull the moment the requesting client goes away, and a foreground curl here
# dies with the tool call.
E=http://192.168.178.161:11434
exec 2>&1
echo "PULL START $(date '+%F %T')"
curl -sN --max-time 7200 "$E/api/pull" \
  -d '{"model":"mannix/omnimerge-v6:IQ2_M","stream":true}' |
python3 -u -c '
import json, sys, time
last = 0.0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except ValueError:
        print("RAW", line[:200]); continue
    if "error" in d:
        print("PULL-ERROR", d["error"]); sys.exit(1)
    status = d.get("status", "")
    total, done = d.get("total"), d.get("completed")
    now = time.time()
    # Throttle the byte-by-byte progress; keep every state change.
    if total and done:
        if now - last < 20 and done < total:
            continue
        last = now
        print(f"{status}  {done/2**30:6.2f}/{total/2**30:6.2f} GiB  {100*done/total:5.1f}%")
    else:
        print(status)
'
rc=${PIPESTATUS[0]}
echo "PULL END $(date '+%F %T') rc=$rc"
