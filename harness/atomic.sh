#!/usr/bin/env bash
# The same broken file, fixed under a transactional change protocol.
#
# `harness.sh` asks the model to fix the file and lets it work until it stops or
# the clock does. Measured over 20 runs that produces three outcomes and only
# one of them is progress: it converges (3), it edits without moving the fault
# (2), or it converts the injected bug into a fault of its own and then chases
# that (the rest). The third is the expensive one -- run 0008 of the nudge arm
# made 32 edits across 78 tool calls and ended further from working than it
# started, because by edit 10 it was debugging its own damage with no way back.
#
# Asking the model to undo that does not work. After a truncated turn its own
# reasoning has been discarded, and after compaction the edits themselves are no
# longer in the window, so "revert your last change" is a request to reconstruct
# a state it can no longer see. The cheapest way for a model to satisfy it is to
# regenerate the whole region, which is the 32,000-token turn that ends the run.
#
# So the undo is mechanical and the unit of work is a transaction:
#
#   * At most THREE declared changes per transaction. A hard limit, not a target.
#   * The model states where each one goes and what symptom it removes, before
#     it touches anything.
#   * The oracle decides. If the game runs, the transaction is kept and the run
#     is over.
#   * If it does not, every edit in that transaction is discarded -- the file
#     goes back to exactly what it was when the transaction opened -- and the
#     next transaction opens with a ledger of what was tried and what happened.
#
# Each transaction carries an id (TX-01, TX-02, ...) so a model reading the
# ledger can tell one attempt from another rather than seeing an undifferentiated
# list of things that did not work.
#
# The per-transaction clock is not the campaign's 900s target. Pinned there, the
# arm produced 18 transactions and 18 timeouts -- nothing ever closed, so nothing
# about the protocol could be read out of it. The clock now exists to stop a
# runaway, not to be the bar: a transaction is given room to finish and the
# measurement is whether the ledger makes the next one converge.
#
# Usage:  ./atomic.sh [iterations]        (0 or empty = until stopped)
#         MAX_TX=6 TX_TIMEOUT=1800 FIRST_TX_TIMEOUT=2400 ./atomic.sh 5
set -uo pipefail

H="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="${CLI_DIR:-/shared/dev/cline/apps/cli}"
# Third model under the same protocol. The first two were the same gemma-4
# v7-coder at two quants and neither fixed the file once:
#
#   iq4_nl  0/24 transactions, every oracle result a SyntaxError
#   q6_k    0/23 transactions, 1 closed on its own, 2 got the file to parse
#
# q6_k worked visibly better -- 18-109 iterations against 14-41, more tool calls
# on fewer output tokens, so less rumination per turn -- and still could not
# clear a syntax error in three hours. So the next variable is the family, not
# the quant: qwen3.6 27b-a3b-coder at Q4_K_M.
#
# Measured before switching: 16.0 GB fully GPU-resident, 84.8 tok/s, tool calls
# and thinking both returned through /api/chat. That last check mattered -- the
# model ships an ollama template of bare `{{ .Prompt }}`, with no Messages loop
# and no ToolCalls handling, and a passthrough template would have made this arm
# measure a broken Modelfile rather than a model. Ollama renders qwen35moe
# natively, so a live probe came back with a well-formed tool call.
#
# The stock tag would have carried a confound larger than the variable under
# test: it declares num_ctx 32768, against iq4_nl's 128000 and q6_k's 256000, so
# on a 14 KB file read across dozens of tool round-trips this arm would compact
# where the others never had to. It also ships no thinking budget, and leaves
# the MTP head loaded but never driven -- ollama zeroes DraftNumPredict for a
# model with an embedded head and no explicit draft_num_predict, which is
# deliberate and documented, so the 84.8 tok/s measured above was the head
# sitting idle. The arm therefore runs a derived model that closes those three
# gaps and changes nothing else; sampling is still the model's own, copied
# across unmodified:
#
#   num_ctx 262144        what the architecture declares; 19.1 GB, no spill
#   think_budget medium   65536 tokens, the same wiring v7-coder_tb ran on
#   draft_num_predict 4   turns the nextn head on; 4 rather than 8, measured
#
# Measured on the built model before starting: 99.0 tok/s on an unbounded
# generation, MTP acceptance 0.40 with per-position (0.576, 0.418, 0.270,
# 0.186). Built from build/modelfile_a3b_coder_q4km.txt in the ollama tree.
MODEL="${MODEL:-a3b-coder_tb:Q4_K_M}"
PROVIDER="${PROVIDER:-ollama}"
THINKING="${THINKING:-high}"
RETRIES="${RETRIES:-6}"
EDIT_VERIFICATION="${EDIT_VERIFICATION:-}"

# How many changes one transaction may declare. Three because a model allowed
# more declares a rewrite, and a rewrite of a file it has misread is the failure
# this exists to bound.
MAX_CHANGES="${MAX_CHANGES:-3}"
# How many transactions a run gets before it is called broken.
MAX_TX="${MAX_TX:-6}"
# How long a transaction gets.
#
# This was 900s, the campaign target, and at 900s the arm measured the clock
# instead of the protocol: 18 transactions across 3 runs, every single one killed
# by the timeout mid-turn, and half of them with no edit at all -- reads finish
# inside 25s and the remaining 875 go into one unfinished turn. A protocol that
# is never allowed to close cannot be judged, and the 900s target itself was hit
# exactly once in 14 nudge runs and never reproduced. So the transaction is given
# enough room to finish and the question becomes whether it converges, not
# whether it beats a stopwatch.
#
# 1800s was still the clock and not the protocol: on the a3b arm all four closed
# transactions died at the limit -- 2402/2400, 1801/1800, 1802/1800, 1801/1800 --
# and not one ever stopped on its own. A ceiling that every single transaction
# reaches is measuring the ceiling. So it goes to two hours, and the first
# question this arm answers is where a transaction actually finishes when it is
# allowed to. Only once that number exists is there anything to optimise down
# towards; a target chosen before it would be another 900s.
#
# The cost is stated rather than discovered: six transactions at two hours is a
# twelve-hour run in the worst case. That is the price of finding the real
# number once.
TX_TIMEOUT="${TX_TIMEOUT:-7200}"
# The first transaction pays for reading a file it has never seen: in every run
# so far the opening 25 seconds are six reads, and everything after is the model
# working out what to change. It no longer gets extra time on top -- at two
# hours the read is noise against the budget, and holding both at the same
# number makes "where does it finish" one measurement rather than two.
FIRST_TX_TIMEOUT="${FIRST_TX_TIMEOUT:-7200}"

SOURCE="$H/manic_miner_1TESTSOURCE.html"
WORK="$H/work-atomic"
RESULTS="$H/results-atomic.jsonl"
ITERATIONS="${1:-0}"

# Sampling is the model's, not the harness's: no temperature, no num_predict,
# no num_ctx here. Whatever `ollama show --parameters` reports is what runs.

[[ -f "$SOURCE" ]] || { echo "missing test source: $SOURCE" >&2; exit 1; }
mkdir -p "$WORK" "$H/runs-atomic"

# The protocol, stated to the model the same way every transaction. Repeated in
# full each time rather than referred back to: a transaction is a fresh session,
# and a rule the model cannot see is a rule it does not follow.
protocol() {
	cat <<-PROTOCOL
	== CHANGE PROTOCOL ==

	You are working in transactions. This one is $1.

	Before you edit anything, state your plan as a numbered list of AT MOST
	$MAX_CHANGES changes. For each one give three things:
	  WHERE - the function, or the exact text you will match on
	  WHAT  - the single concrete edit you will make there
	  WHY   - the specific symptom in the error output it removes

	Then make exactly those changes, in that order, and nothing else. Do not fix
	anything you did not declare. Do not rewrite a whole function or a whole
	file: edit the smallest region that removes the symptom.

	Then run \`node run_game.js manic_miner.html\` and stop.

	If the game runs, $1 is kept and you are finished.

	If it does not, every change in $1 is discarded. The file goes back to
	exactly what it was when $1 opened, and you get a new transaction with a
	record of what this one tried. You will never be asked to undo an edit
	yourself -- that is done for you, mechanically, before the next transaction
	starts.

	$MAX_CHANGES is a hard limit and not a target. One change that removes one
	symptom is a better transaction than three that might.
	PROTOCOL
}

# The oracle. Its exit is the only thing that decides whether a transaction is
# kept, so it is run by the harness rather than read out of the model's report.
oracle() {
	( cd "$WORK" && timeout 120 node run_game.js manic_miner.html 2>&1 )
}

# The rollback, and deliberately not git.
#
# Cline's own checkpoints are git-backed and refuse outright on a workspace that
# is not a work tree -- `beginWorktreeRestoreTransaction` throws "is not a git
# repository" -- so a protocol built on them has no undo for exactly the kind of
# workspace this task is: a directory with one HTML file in it. Worse is the
# quiet version of that failure. On a host with git 2.30 a sibling project's
# snapshot layer had `git add --sparse` fail, swallowed the error, wrote the
# empty tree, and reverted nothing while reporting success -- an experiment that
# looks like it ran and measures nothing.
#
# A copy has no version floor, no repository state and no configuration, and the
# whole work directory here is two files. So the snapshot is a copy, and every
# restore is *verified* against a checksum manifest rather than trusted. A
# rollback that silently does not roll back would make every transaction after
# it a lie, so it stops the run instead.
snapshot_take() {
	rm -rf "$TX_BASE"
	mkdir -p "$TX_BASE"
	cp -a "$WORK/." "$TX_BASE/"
	( cd "$TX_BASE" && find . -type f -exec md5sum {} + | sort ) > "$TX_BASE.manifest"
}

snapshot_restore() {
	# The directory itself, not its glob: a transaction that leaves a dotfile
	# behind would otherwise survive its own rollback.
	rm -rf "${WORK:?}"
	mkdir -p "$WORK"
	cp -a "$TX_BASE/." "$WORK/"
	local now
	now="$( cd "$WORK" && find . -type f -exec md5sum {} + | sort )"
	if [[ "$now" != "$(cat "$TX_BASE.manifest")" ]]; then
		echo "atomic: ROLLBACK FAILED -- work dir does not match the snapshot" >&2
		echo "atomic: refusing to continue; every later transaction would be measuring wreckage" >&2
		return 1
	fi
	return 0
}

# What the transaction actually changed, for the ledger -- as opposed to what it
# said it would. `diff` where there is one, and a size delta where there is not,
# because this is a note to the model and not a patch to apply.
snapshot_diffstat() {
	if command -v diff >/dev/null 2>&1; then
		# `diff -rq` names both absolute paths in every line, which is noise in a
		# prompt. Reduce each line to `<file> <verb>` -- the model is being told
		# what it touched, not being handed a patch.
		local out
		out="$(diff -rq "$TX_BASE" "$WORK" 2>/dev/null | awk -v base="$TX_BASE" -v work="$WORK" '
			/^Files / { n = split($0, f, " "); sub(work "/", "", f[4]); print f[4] " modified"; next }
			/^Only in / { d = $3; sub(/:$/, "", d); if (d == work) print $4 " added"; else print $4 " deleted"; next }
		' | head -5 | paste -sd';' - | sed 's/;/; /g')"
		[[ -n "$out" ]] && { printf '%s' "$out"; return; }
		printf 'nothing'
		return
	fi
	local a b
	a=$(wc -c < "$TX_BASE/manic_miner.html" 2>/dev/null || echo 0)
	b=$(wc -c < "$WORK/manic_miner.html" 2>/dev/null || echo 0)
	if (( a == b )); then printf 'nothing'; else printf 'manic_miner.html %s bytes -> %s bytes' "$a" "$b"; fi
}

# Why the CLI stopped, when it stopped itself.
#
# The reason is already on the JSON stream as a `run_aborted` record -- the loop
# guard, the mistake limit, a timeout -- and nothing here read it, so a
# transaction that burned 99 minutes on six identical `read_files` calls was
# logged as "discarded, exit=0" and looked like the model simply failing.
abort_reason() {
	python3 - "$1" <<'PY' 2>/dev/null
import json
import sys

try:
    with open(sys.argv[1]) as stream:
        for line in stream:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if record.get("type") == "run_aborted":
                reason = record.get("reason", "?")
                print(f"{reason}: {record.get('message', '')}"[:180])
                break
except OSError:
    pass
PY
}

run_one() {
	local index="$1"
	local run_dir
	run_dir="$H/runs-atomic/$(date +%Y%m%d-%H%M%S)-$(printf '%04d' "$index")"
	mkdir -p "$run_dir"

	# Fixed starting state, every time.
	rm -rf "$WORK"; mkdir -p "$WORK"
	cp -f "$SOURCE" "$WORK/manic_miner.html"
	cp -f "$SOURCE" "$run_dir/manic_miner.before.html"
	cp -f "$H/smoke.js" "$WORK/run_game.js"
	# The runner is the oracle, and it sits in a directory the model can edit.
	# Measured on run 0002: a transaction spent 36 `editor` calls and 34 reads on
	# `run_game.js` -- trying to change the bracket-balance logic that was
	# reporting its failure -- and was stopped by the loop guard re-reading the
	# same 31 lines. Read-only makes that attempt fail on the first call instead
	# of costing 99 minutes; `snapshot_restore` removes the whole directory
	# before restoring, so the mode survives a rollback rather than blocking it.
	chmod 444 "$WORK/run_game.js"

	TX_BASE="$run_dir/.tx-base"

	{
		echo "version=$(python3 -c "import json;print(json.load(open('$CLI_DIR/../vscode/package.json'))['version'])" 2>/dev/null)"
		echo "sha=$(git -C "$CLI_DIR" rev-parse --short HEAD 2>/dev/null)"
		echo "dirty=$(git -C "$CLI_DIR" status --porcelain 2>/dev/null | wc -l)"
		echo "model=$MODEL"
		echo "mode=atomic max_changes=$MAX_CHANGES max_tx=$MAX_TX tx_timeout=${TX_TIMEOUT}s first_tx_timeout=${FIRST_TX_TIMEOUT}s"
		echo "edit_verification=${EDIT_VERIFICATION:-<host default>}"
	} > "$run_dir/build.txt"

	local since started ended ledger tx verdict tx_used
	since="$(date '+%Y-%m-%d %H:%M:%S')"
	started="$(date +%s)"
	ledger=""
	verdict="broken"
	tx_used=0

	for (( tx=1; tx<=MAX_TX; tx++ )); do
		local txid; txid="TX-$(printf '%02d' "$tx")"
		tx_used=$tx
		# Taken at the open of every transaction, not once per run: what a kept
		# transaction leaves behind is the base the next one is measured from.
		snapshot_take
		local prompt
		prompt="check manic_miner.html, it's not working. Run \`node run_game.js manic_miner.html\` to see whether it actually works -- it loads the page, starts the game and pumps animation frames, and prints what went wrong.

$(protocol "$txid")${ledger}"

		printf '%s\n' "$prompt" > "$run_dir/$txid.prompt.txt"

		local tx_limit=$(( tx == 1 ? FIRST_TX_TIMEOUT : TX_TIMEOUT ))
		local tx_started; tx_started="$(date +%s)"

		timeout -k 60 $((tx_limit + 60)) bun run "$CLI_DIR/src/index.ts" "$prompt" \
			--provider "$PROVIDER" \
			--model "$MODEL" \
			--thinking "$THINKING" \
			--cwd "$WORK" \
			--data-dir "$run_dir/state-$txid" \
			--json \
			--auto-approve true \
			--retries "$RETRIES" \
			${EDIT_VERIFICATION:+--edit-verification "$EDIT_VERIFICATION"} \
			-t "$tx_limit" \
			> "$run_dir/$txid.jsonl" 2> "$run_dir/$txid.stderr"
		local tx_status=$?
		# Elapsed against the limit is the thing to read first now: a transaction
		# that stopped short of its clock ended because the model finished, and
		# only those say anything about the protocol.
		local tx_secs=$(( $(date +%s) - tx_started ))

		local out; out="$(oracle)"
		printf '%s\n' "$out" > "$run_dir/$txid.oracle.txt"
		# What it actually changed, as opposed to what it said it would. Kept as
		# an artifact whether the transaction survives or not, because a
		# discarded transaction's edits exist nowhere else once it is rolled back.
		local changed; changed="$(snapshot_diffstat)"
		printf '%s\n' "$changed" > "$run_dir/$txid.diffstat.txt"
		diff -ru "$TX_BASE" "$WORK" > "$run_dir/$txid.diff.txt" 2>/dev/null

		if grep -q '"ok":[[:space:]]*true' <<<"$out"; then
			verdict="FIXED"
			echo "  $txid kept -- the game runs (${tx_secs}s/${tx_limit}s)"
			break
		fi

		# Discarded. The file goes back; the ledger carries what happened
		# forward, because that is the only thing the next transaction inherits.
		if ! snapshot_restore; then
			verdict="ROLLBACK-FAILED"
			echo "  $txid rollback failed -- ending the run"
			break
		fi
		local why; why="$(abort_reason "$run_dir/$txid.jsonl")"
		echo "  $txid discarded (${tx_secs}s/${tx_limit}s, exit=$tx_status) -- $(head -c 120 <<<"$out")${why:+ [stopped: $why]}"

		ledger="${ledger}

== $txid: DISCARDED ==
The file is back to exactly what it was before $txid. None of its edits are
present. Do not build on them, and do not assume any of them is still there.
What it changed: ${changed:-nothing}
What the game said after it: $(head -c 400 <<<"$out")"
	done

	ended="$(date +%s)"
	journalctl -u ollama --since "$since" --no-pager -o cat > "$run_dir/ollama.log" 2>/dev/null
	cp -f "$WORK/manic_miner.html" "$run_dir/manic_miner.after.html" 2>/dev/null

	printf 'verdict=%s transactions=%s wall=%ss\n' \
		"$verdict" "$tx_used" "$((ended - started))" > "$run_dir/exit.txt"
	printf '%s  %s  transactions=%s %ss\n' \
		"$(basename "$run_dir")" "$verdict" "$tx_used" "$((ended - started))" | tee -a "$H/verdicts-atomic.txt"
	python3 -c "
import json
print(json.dumps({'run':'$(basename "$run_dir")','verdict':'$verdict','transactions':$tx_used,'seconds':$((ended - started))}))" >> "$RESULTS"

	find "$H/runs-atomic" -maxdepth 1 -type d -name '2[0-9]*' | sort | head -n -40 |
		while read -r old; do "$H/archive-state.sh" "$old"; done
	# The event stream is quadratic in turn length: every content_start carries an
	# `accumulated` field holding the whole turn so far, so one 900s transaction
	# produced a 343 MB log and three runs cost 2.9 GB. Longer transactions make
	# that worse, and the logs compress ~20x. Keep the last few runs readable and
	# gzip the rest rather than deleting evidence.
	find "$H/runs-atomic" -maxdepth 1 -type d -name '2[0-9]*' | sort | head -n -6 |
		while read -r old; do gzip -q -f "$old"/TX-*.jsonl 2>/dev/null; done
}

echo "atomic: model=$MODEL thinking=$THINKING max_changes=$MAX_CHANGES max_tx=$MAX_TX tx_timeout=${TX_TIMEOUT}s first_tx=${FIRST_TX_TIMEOUT}s iterations=${ITERATIONS:-unbounded}"
index=$(( $(find "$H/runs-atomic" -maxdepth 1 -type d -name '2[0-9]*' 2>/dev/null |
	sed 's/.*-//' | sort -n | tail -1 | sed 's/^0*//' | grep -E '^[0-9]+$' || echo 0) + 1 ))
while :; do
	run_one "$index"
	if [[ "$ITERATIONS" != "0" ]] && (( index >= ITERATIONS )); then
		break
	fi
	if [[ -f "$H/STOP-ATOMIC" ]]; then
		echo "atomic: STOP-ATOMIC present, ending after run $index"
		rm -f "$H/STOP-ATOMIC"
		break
	fi
	index=$((index + 1))
done
