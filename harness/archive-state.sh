#!/usr/bin/env bash
# Put a run's session state on the big disk, then remove it from the spool.
#
# Every harness loop caps how many runs keep their `state/` directory, because
# the spool disk is small and full. Until 2026-09-13 the cap was implemented as
# `rm -rf`, and that was a quiet, permanent loss: the state directory is the
# only record of what was actually *sent* -- the rendered system prompt, the
# message list, the context history -- and `run.jsonl` cannot reconstruct it.
# A prompt or protocol post-mortem has nothing else to read.
#
# It is also nearly free. Nine runs came to 2.3 MB from 70 MB on disk, a ~30x
# ratio, so a 300-run campaign archives in well under a gigabyte against 19 TB
# free. There was never a reason to delete instead of archive.
#
# Usage:  archive-state.sh <run-dir> [<run-dir> …]
#
# One tarball per run directory, holding whatever `state` directories it has
# (`state/` for the one-session loops, `state-TX-*/` for atomic.sh). Written to
# `.part` and moved into place, so a kill mid-write never leaves a truncated
# file that later looks complete. Nothing is removed unless its archive landed
# and is non-empty: on any failure the state stays where it is and the caller
# is told, because a full spool disk is a smaller problem than a lost record.
set -uo pipefail

ARCHIVE="${ARCHIVE:-/srv/dev-disk-by-uuid-f8b1803e-334f-4f4b-af3b-f802bb6883c5/manic-harness-archive}"

archive_state() {
	local run_dir="$1"
	local id out
	id="$(basename "$run_dir")"

	# Both layouts, and nothing to do when neither is present.
	local -a dirs=()
	[[ -d "$run_dir/state" ]] && dirs+=("state")
	while IFS= read -r one; do
		[[ -n "$one" ]] && dirs+=("$(basename "$one")")
	done < <(find "$run_dir" -maxdepth 1 -type d -name 'state-*' 2>/dev/null | sort)
	(( ${#dirs[@]} )) || return 0

	mkdir -p "$ARCHIVE/state" || return 1
	out="$ARCHIVE/state/$id.tar.zst"

	# A re-archive is normal: a run still in flight may be archived once while
	# running and again once finished, and the second must win.
	if tar -C "$run_dir" -cf - "${dirs[@]}" 2>/dev/null |
		zstd -q -3 -o "$out.part" 2>/dev/null && [[ -s "$out.part" ]]; then
		mv -f "$out.part" "$out"
		return 0
	fi
	rm -f "$out.part"
	return 1
}

# `--keep` archives without removing, for a run that is still in flight: a
# snapshot taken now is better than nothing if the process dies, and the real
# archive overwrites it when the run ages out.
KEEP=0
if [[ "${1:-}" == "--keep" ]]; then
	KEEP=1
	shift
fi

# Archive then remove. The removal is the caller's reason for calling, but it
# only ever happens behind a successful archive.
for run_dir in "$@"; do
	[[ -d "$run_dir" ]] || continue
	if archive_state "$run_dir"; then
		(( KEEP )) || rm -rf "$run_dir"/state "$run_dir"/state-*
	else
		echo "archive-state: FAILED for $run_dir -- keeping its state" >&2
	fi
done
