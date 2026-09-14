#!/usr/bin/env bash
# Ask the same question of the same broken file, over and over.
#
# The point is repetition against a fixed starting state: the file is restored
# from the pristine test source before every run, so run N tells you something
# about the agent rather than about what run N-1 left behind. Each run gets its
# own data directory for the same reason -- a resumed session would carry the
# previous answer into the next question.
#
# Usage:  ./harness.sh [iterations]     (0 or empty = until stopped)
#         MODEL=... THINKING=... TIMEOUT=... ./harness.sh 5
set -uo pipefail

H="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="${CLI_DIR:-/shared/dev/cline/apps/cli}"
MODEL="${MODEL:-v7-coder_tb:vision-iq4_nl}"
PROVIDER="${PROVIDER:-ollama}"
THINKING="${THINKING:-high}"
# 90 minutes, raised from 40 once the 40 became the thing being measured.
# Per-iteration time tracks output tokens almost exactly, and output per turn
# varies 2.5x with how much the model thinks: measured across three runs of this
# same task, 2,000 tokens/turn at 45s/iter, 3,928 at 85s, 5,000 at 106s -- with
# *lower* input per turn on the slow ones, so it is generation, not prompt. At
# 2400s the two thinkier runs were cut off mid-task and scored broken, which
# says nothing about whether the model can fix the file. The loop guard stops a
# run that is going nowhere, so this bound only has to be generous.
TIMEOUT="${TIMEOUT:-5400}"
# Passed explicitly rather than left to the CLI's default, and recorded in
# build.txt with everything else. The default was 3 while `--retries --help` said
# 6, and a run that had made nine edits in twenty-four minutes was ended by a
# budget neither of us had chosen. A value that decides when a run stops does not
# belong in a default nobody reads.
RETRIES="${RETRIES:-6}"
# Whether the model is nudged, or required, to check a file it just edited.
# Empty leaves the host's own default (nudge) in force and passes no flag, so an
# unset value and an explicit "nudge" are not the same run on paper. Recorded in
# build.txt because it is the variable this arm of the campaign exists to test:
# run 0007 is the only run so far that ended because the model decided it was
# done rather than because the clock ran out, and it is also the only one that
# checked after every single edit -- an edit/check ratio of 1.0 against 2.5-4.2
# for every other run. "require" is the setting that imposes what 0007 did on
# its own.
EDIT_VERIFICATION="${EDIT_VERIFICATION:-}"
# Assigned in two steps on purpose: bash parses a single quote inside a
# "${var:-default}" default as an opening quote, and the apostrophe in "it's"
# then swallows the rest of the script.
PROMPT="${PROMPT-}"
# The model is graded on whether the game *runs*, and until now it could only
# find out whether the file *parses* — its work dir held the html and nothing
# else, `check_file` answers the parsing question, and it never once tried to
# execute the page because there was nothing there to execute it with. Measured
# on the first run whose file ever parsed: the stray braces were fixed, none of
# the 24 called-but-undefined functions were, and it reported "The task is
# finished." So the runner goes in the work dir and the prompt names it. This
# changes what the campaign measures; runs from before it are not comparable.
[[ -n "$PROMPT" ]] || PROMPT="check manic_miner.html, it's not working. Run \`node run_game.js manic_miner.html\` to see whether it actually works — it loads the page, starts the game and pumps animation frames, and prints what went wrong."
SOURCE="$H/manic_miner_1TESTSOURCE.html"
WORK="$H/work"
RESULTS="$H/results.jsonl"
ITERATIONS="${1:-0}"

# Sampling is the model's, not the harness's: no temperature, no num_predict,
# no num_ctx here. Whatever `ollama show --parameters` reports is what runs.

[[ -f "$SOURCE" ]] || { echo "missing test source: $SOURCE" >&2; exit 1; }
mkdir -p "$WORK" "$H/runs"

run_one() {
	local index="$1"
	local run_dir
	# Timestamp first so a plain name sort is a chronological sort. Index first
	# would put run 1 of a restarted loop ahead of run 40 of the previous one,
	# and the prune below would then delete the newest runs.
	run_dir="$H/runs/$(date +%Y%m%d-%H%M%S)-$(printf '%04d' "$index")"
	mkdir -p "$run_dir"

	# Fixed starting state, every time.
	cp -f "$SOURCE" "$WORK/manic_miner.html"
	cp -f "$SOURCE" "$run_dir/manic_miner.before.html"
	# The same runner the verdict is taken from, so the model is measured
	# against what it can itself check rather than against something it has no
	# way to see. Copied per run so an edit to it cannot be carried between runs.
	cp -f "$H/smoke.js" "$WORK/run_game.js"

	# Which build produced this run. Statistics that mix builds answer nothing,
	# and the streak is only meaningful against one of them.
	{
		echo "version=$(python3 -c "import json;print(json.load(open('$CLI_DIR/../vscode/package.json'))['version'])" 2>/dev/null)"
		echo "sha=$(git -C "$CLI_DIR" rev-parse --short HEAD 2>/dev/null)"
		echo "dirty=$(git -C "$CLI_DIR" status --porcelain 2>/dev/null | wc -l)"
		echo "model=$MODEL"
		echo "retries=$RETRIES"
		echo "edit_verification=${EDIT_VERIFICATION:-<host default>}"
	} > "$run_dir/build.txt"

	# The server log is shared, so bound it by wall clock rather than trying to
	# separate it after the fact.
	local since started ended
	since="$(date '+%Y-%m-%d %H:%M:%S')"
	started="$(date +%s)"

	# `-k`: SIGTERM alone is a request, and this one goes to a process that
	# installs a handler for it. Measured before the CLI's abort wiring was
	# fixed, a run took the SIGTERM, kept iterating for nineteen more minutes and
	# finished on its own terms. The agent's own `-t` bounds the run now, and
	# this bounds the process whatever the agent does with the signal.
	timeout -k 120 $((TIMEOUT + 120)) bun run "$CLI_DIR/src/index.ts" "$PROMPT" \
		--provider "$PROVIDER" \
		--model "$MODEL" \
		--thinking "$THINKING" \
		--cwd "$WORK" \
		--data-dir "$run_dir/state" \
		--json \
		--auto-approve true \
		--retries "$RETRIES" \
		${EDIT_VERIFICATION:+--edit-verification "$EDIT_VERIFICATION"} \
		-t "$TIMEOUT" \
		> "$run_dir/cline.jsonl" 2> "$run_dir/cline.stderr"
	local status=$?
	ended="$(date +%s)"

	journalctl -u ollama --since "$since" --no-pager -o cat > "$run_dir/ollama.log" 2>/dev/null
	cp -f "$run_dir/state/logs/cline.log" "$run_dir/cline.log" 2>/dev/null
	cp -f "$WORK/manic_miner.html" "$run_dir/manic_miner.after.html" 2>/dev/null

	printf 'exit=%s wall=%ss\n' "$status" "$((ended - started))" > "$run_dir/exit.txt"
	python3 "$H/analyse.py" "$run_dir" | tee -a "$H/verdicts.txt"
	[[ -f "$run_dir/summary.json" ]] && python3 -c "
import json,sys
print(json.dumps(json.load(open('$run_dir/summary.json'))))" >> "$RESULTS"

	# Keep the tree from growing without bound: the state dir is ~2MB a run.
	# It goes to the archive disk rather than to /dev/null -- "nothing reads it
	# after the analysis" was true right up until the analysis had to be redone.
	find "$H/runs" -maxdepth 1 -type d -name '2[0-9]*' | sort | head -n -40 |
		while read -r old; do "$H/archive-state.sh" "$old"; done
}

echo "harness: model=$MODEL thinking=$THINKING timeout=${TIMEOUT}s iterations=${ITERATIONS:-unbounded}"
# Carry on numbering from whatever is already there, so a restarted loop does
# not produce a second run 1.
index=$(( $(find "$H/runs" -maxdepth 1 -type d -name '2[0-9]*' 2>/dev/null |
	sed 's/.*-//' | sort -n | tail -1 | sed 's/^0*//' | grep -E '^[0-9]+$' || echo 0) + 1 ))
while :; do
	run_one "$index"
	if [[ "$ITERATIONS" != "0" ]] && (( index >= ITERATIONS )); then
		break
	fi
	# `touch STOP` ends the loop between runs, with the run in flight finished
	# and analysed. Killing the loop instead leaves the run's own bun process
	# orphaned and its analysis never written, and editing this script while it
	# is running corrupts it -- bash reads the file as it goes.
	if [[ -f "$H/STOP" ]]; then
		echo "harness: STOP file present, ending after run $index"
		rm -f "$H/STOP"
		break
	fi
	index=$((index + 1))
done
