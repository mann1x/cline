#!/usr/bin/env bash
# Preserve each run's session state before native.sh's retention prune eats it.
#
# The prune at the end of every run keeps only the last six run directories'
# `state/`, and `state/sessions/*/*.messages.json` is the only place tool names
# appear -- run.jsonl does not carry them. On a ten-run arm the early runs would
# lose their tool profile before the arm finished. This copies the state out
# while the window is open, and writes a per-run tool count beside it.
#
# Read-only with respect to the harness: it never touches runs-native or
# native.sh, only $ARCHIVE.
set -u

H=/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness
ARCHIVE="$H/state-archive"
PROFILES="$ARCHIVE/tool-profiles.jsonl"
STOP_AFTER_INDEX="${STOP_AFTER_INDEX:-172}"   # last run of this arm
POLL="${POLL:-60}"
DEADLINE=$(( $(date +%s) + 86400 ))

mkdir -p "$ARCHIVE"
: >> "$PROFILES"

archived() { grep -q "\"run\": \"$1\"" "$PROFILES" 2>/dev/null; }

snapshot() {
	local d="$1" name; name="$(basename "$d")"
	# Already pruned by the harness before we got here: record that once, so
	# the run is not re-examined on every poll.
	if [ ! -d "$d/state" ]; then
		printf '{"run": "%s", "state": "pruned-before-snapshot"}\n' "$name" >> "$PROFILES"
		return 0
	fi
	tar -czf "$ARCHIVE/$name-state.tar.gz.part" -C "$d" state 2>/dev/null &&
		mv -f "$ARCHIVE/$name-state.tar.gz.part" "$ARCHIVE/$name-state.tar.gz"
	python3 - "$d" "$name" >> "$PROFILES" 2>/dev/null <<'PY'
import sys, json, glob, collections, os
d, name = sys.argv[1], sys.argv[2]
tools = collections.Counter(); roles = collections.Counter(); msgs = []
for p in glob.glob(os.path.join(d, "state", "sessions", "*", "*.messages.json")):
    try:
        data = json.load(open(p, encoding="utf8", errors="replace"))
    except Exception:
        continue
    ms = data if isinstance(data, list) else data.get("messages") or []
    msgs.extend(ms)
for m in msgs:
    roles[m.get("role")] += 1
    c = m.get("content")
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get("type") in ("tool_use", "tool-call"):
                tools[b.get("name") or b.get("toolName") or "?"] += 1
exit_line = ""
try:
    exit_line = open(os.path.join(d, "exit.txt"), encoding="utf8").read().strip()
except Exception:
    pass
print(json.dumps({
    "run": name,
    "messages": len(msgs),
    "assistant_turns": roles.get("assistant", 0),
    "tools": dict(tools.most_common()),
    "tool_calls": sum(tools.values()),
    "exit": exit_line,
}))
PY
}

echo "snapshot-tools: watching $H/runs-native, archiving to $ARCHIVE, stop after index $STOP_AFTER_INDEX"
while :; do
	for d in "$H"/runs-native/2[0-9]*/; do
		[ -d "$d" ] || continue
		[ -f "$d/exit.txt" ] || continue          # still running
		name="$(basename "$d")"
		archived "$name" && continue
		snapshot "$d"
		echo "archived $name"
	done
	last="$(ls -d "$H"/runs-native/2[0-9]*/ 2>/dev/null | sed 's:/$::' | sed 's/.*-//' | sort -n | tail -1)"
	if archived "$(ls -d "$H"/runs-native/*-"$(printf '%04d' "$STOP_AFTER_INDEX")"/ 2>/dev/null | head -1 | xargs -r basename)"; then
		echo "snapshot-tools: run $STOP_AFTER_INDEX archived, done"
		break
	fi
	[ "$(date +%s)" -gt "$DEADLINE" ] && { echo "snapshot-tools: 24h deadline, stopping"; break; }
	sleep "$POLL"
done
