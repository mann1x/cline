#!/usr/bin/env bash
# Stopgap for one arm: the loop that is running right now still holds the old
# native.sh in its open file descriptor, so it will keep doing `rm -rf state`
# however the file on disk now reads. This copies every state directory to the
# archive every few minutes until the driver exits, so nothing is lost in the
# gap between the fix landing and the next arm starting.
#
# Usage: archive-sidecar.sh <driver-pid>
set -uo pipefail
H="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pid="$1"
while kill -0 "$pid" 2>/dev/null; do
	for d in "$H"/runs-native/*/ "$H"/runs-teams/*/ "$H"/runs-atomic/*/; do
		[[ -d "$d" ]] || continue
		"$H/archive-state.sh" --keep "${d%/}"
	done
	sleep 180
done
echo "archive-sidecar: driver $pid gone, stopping"
