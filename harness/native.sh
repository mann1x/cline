#!/usr/bin/env bash
# The same file, the same protocol, run by the plugin instead of by this script.
#
# `atomic.sh` implements the change protocol in bash: it opens a transaction,
# starts a fresh CLI session, runs the oracle when that session exits, restores
# a copy on failure, and starts another session with a ledger. It has produced
# 13 FIXED verdicts that way. The protocol is now native -- snapshot, oracle,
# rollback and the record all live in the plugin -- and this arm measures that
# implementation against the one the campaign was built on.
#
# What is deliberately the same:
#
#   * the same broken file, the same injected fault, the same run_game.js
#   * the same model, thinking level and sampling (the model's own)
#   * three declared changes per transaction, six transactions
#   * the oracle decides, and it is run by something other than the model
#
# What is necessarily different, and is the thing to read:
#
#   * ONE session for the whole run, not one per transaction. In atomic.sh a
#     discarded transaction takes its context with it and the next one starts
#     from an empty window plus a ledger. Here the next transaction inherits the
#     conversation -- every tool call, every failed edit, the oracle output --
#     and the record of what was tried is in the system prompt rather than in
#     the opening message. That is more context and less curation, and whether
#     it converges better or worse is exactly what this arm answers.
#
#   * The clock is per-run, not per-transaction. Six transactions inside one
#     session cannot be given two hours each without a twelve-hour worst case,
#     so the budget is the run's and a transaction that overruns eats the ones
#     after it.
#
#   * The oracle is judged on output, not exit status. run_game.js prints
#     {"ok":false,...} and exits 0 whether the game runs or not, so the pattern
#     is what makes it a check at all -- without it every transaction would be
#     kept. atomic.sh greps the same string; this passes it as --oracle-expect.
#
# Usage:  ./native.sh [iterations]        (0 or empty = until stopped)
#         MAX_TX=3 RUN_TIMEOUT=7200 ./native.sh 1
set -uo pipefail

H="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Where aged-out session state goes. The spool disk is at 88%; this one has 19 TB
# free, and an archive that costs nothing is the difference between a campaign
# that can be re-read next month and one that cannot.
ARCHIVE="${ARCHIVE:-/srv/dev-disk-by-uuid-f8b1803e-334f-4f4b-af3b-f802bb6883c5/manic-harness-archive}"
# The worktree the native protocol was built in, not the campaign's checkout:
# `atomic.sh` runs from /shared/dev/cline and may be mid-run, and building there
# while a transaction is in flight has broken a run before.
CLI_DIR="${CLI_DIR:-/srv/dev-disk-by-label-opt/dev/cline/apps/cli}"
MODEL="${MODEL:-a3b-coder_tb:Q4_K_M}"
PROVIDER="${PROVIDER:-ollama}"
THINKING="${THINKING:-high}"
# Six, to match the plugin's own default -- the number the extension ships and
# the number pandorum's settings hold (user, 2026-09-11: "we have set
# maxChanges default to 6! the harness should be set to 6 not pandorum"). It
# was 3 here, which meant the harness prompt said "AT MOST 3 changes" while
# every plugin session said 6, and the two were not measuring the same protocol.
MAX_CHANGES="${MAX_CHANGES:-6}"
MAX_TX="${MAX_TX:-6}"
RETRIES="${RETRIES:-6}"
# Two hours (user, 2026-09-11: "set the timeoute to 2h").
#
# It was six hours, then ninety minutes, and ninety was measurably too tight for
# the 27B arms. The pp0 arm closed 10/10 on 2026-09-11 at 5 FIXED / 5 broken --
# and all five failures landed at 5402-5405s, i.e. the cap to within three
# seconds, not one of them a verdict. The five successes averaged 4742s (79.0
# min) against a 5400s limit, the fastest at 4185s. An arm whose successes
# finish 11 minutes inside the limit and whose every failure is the limit is not
# measuring the model; it is measuring the clock, and a FIXED rate read off it
# is a statement about what fits in ninety minutes.
#
# The original reasoning for cutting it still stands and is why this is 2h and
# not back to 6h: run 0190 spent five hours to end on the error it started with,
# and nothing after its first ninety minutes was a measurement. Two hours keeps
# that bound while clearing the observed success distribution by ~35 minutes.
RUN_TIMEOUT="${RUN_TIMEOUT:-7200}"
ORACLE="${ORACLE:-node run_game.js manic_miner.html}"
# Three conditions, not one (user, 2026-09-11: "it should check the framerate
# as well above 0").
#
#   "ok": true              the oracle's own verdict
#   "frames_run": >= 1      the page actually pumped a frame. A file that loads
#                           and schedules nothing used to be caught only by the
#                           oracle's internal check; now the pattern says it.
#   "reached_playing": true the physics path executed. This is the one that
#                           matters: run 0208 scored ok:true with frames_run:30
#                           while stuck in the countdown, and `collide` was
#                           still undefined.
#
# The fields are emitted in this order, so one ordered pattern matches them.
# `\s` is a GNU grep extension and also valid in the CLI's JS regex, so the
# same string works on both sides.
ORACLE_EXPECT="${ORACLE_EXPECT:-\"ok\":\\s*true.*\"frames_run\":\\s*[1-9][0-9]*.*\"reached_playing\":\\s*true}"
# Which of the three verdicts this batch is measuring. The workspace, the
# prompt, the model and the file are identical across all three; the only
# thing that moves is what decides whether a transaction is kept.
#
#   oracle    ORACLE set. The check is handed to the protocol and outranks
#             anything else. This is every run before 0076 and the baseline.
#   self      ORACLE empty, --propose-check off. The model's own account of
#             its work is the verdict, which is what the extension did before
#             4.100.62 and what the switch turns back on.
#   proposed  ORACLE empty, --propose-check auto. The model names a check and
#             the CLI approves it without asking -- the extension's flow with
#             the user's judgement removed, which is the only shape an
#             unattended batch can run it in.
#   manual    --atomic off. No change protocol at all: no transactions, no
#             declared changes, no rollback, and nothing handed to the model
#             that decides whether its work is kept. The model edits the file
#             and stops when it says it is done; THIS SCRIPT then runs the
#             oracle and that is the verdict. The oracle is still the judge --
#             it is simply the only judge, and it judges once, at the end.
#
#             This is the control the other four arms never had. Every one of
#             them measures a variant OF the protocol; none of them measures
#             its absence, so "the protocol helps" has been an assumption
#             rather than a reading. The user has two ad-hoc plugin runs that
#             fixed the file in 28 and 39 minutes with the protocol off,
#             against an oracle arm that spent two hours per run and closed no
#             transaction -- which is what this arm exists to put on the same
#             footing as the rest.
#
# `auto` stands the protocol down where nothing in the workspace can be run,
# and for `self` that is exactly the case -- so those two arms need `always`
# or they would measure a protocol that never armed. `oracle` keeps `auto`
# because that is what the 10 baseline runs on this model were recorded with,
# and with an oracle present the two modes are the same code path.
ARM="${ARM:-oracle}"
case "$ARM" in
	oracle)   ATOMIC_MODE="${ATOMIC_MODE:-auto}";   PROPOSE_CHECK="" ;;
	self)     ATOMIC_MODE="${ATOMIC_MODE:-always}"; PROPOSE_CHECK="off";  ORACLE="" ;;
	proposed) ATOMIC_MODE="${ATOMIC_MODE:-always}"; PROPOSE_CHECK="auto"; ORACLE="" ;;
	# ORACLE is emptied for the same reason as the two arms above -- it is what
	# stops the check being handed to the run -- and the verdict is unaffected,
	# because `oracle()` below names the command itself and ORACLE_EXPECT is a
	# separate variable that the verdict block greps either way.
	manual)   ATOMIC_MODE="${ATOMIC_MODE:-off}";    PROPOSE_CHECK="";     ORACLE="" ;;
	# Same as `proposed`, with the one crack in the freeze open: a check the
	# model named that has never once passed may be replaced, once, after two
	# discarded attempts. `proposed` pins it shut, so the two are the arms.
	rethink)  ATOMIC_MODE="${ATOMIC_MODE:-always}"; PROPOSE_CHECK="auto"; ORACLE=""
	          CHECK_RECONSIDER_AFTER="${CHECK_RECONSIDER_AFTER:-2}" ;;
	*) echo "native: unknown ARM \"$ARM\" (expected oracle, self, proposed, rethink or manual)" >&2; exit 1 ;;
esac
# The one way to get a `manual` arm that is not one. ATOMIC_MODE is overridable
# per launch by design, and `ARM=manual ATOMIC_MODE=always` would run the full
# change protocol under a label that says it is off -- the arm's whole claim,
# inverted, in the run record. Refused rather than corrected, because which of
# the two the operator meant is not knowable from here.
MANUAL_PROMPT="${MANUAL_PROMPT:-new}"
case "$MANUAL_PROMPT" in
	old|new) ;;
	*) echo "native: MANUAL_PROMPT=$MANUAL_PROMPT is neither old nor new" >&2; exit 2 ;;
esac
# Only the manual arm has a prompt to choose. Recording the choice on runs that
# could not act on it would put an arm label on every other arm's rows.
if [[ "$ATOMIC_MODE" == "off" ]]; then PROMPT_ARM="$MANUAL_PROMPT"; else PROMPT_ARM="n/a"; fi

if [[ "$ARM" == "manual" && "$ATOMIC_MODE" != "off" ]]; then
	echo "native: ARM=manual with ATOMIC_MODE=$ATOMIC_MODE is not the manual arm -- that is the change protocol under another name" >&2
	exit 1
fi
# After the case, never before it. `${VAR:-0}` first sets it to "0", and "0" is
# set and non-empty, so the `rethink` arm's own `${VAR:-2}` then substitutes
# nothing and the arm runs with the crack pinned shut -- which is the control
# arm, measured twice. Every other arm wants 0, and the SDK default is 2, so
# the floor still has to be stated; it just has to be stated last.
CHECK_RECONSIDER_AFTER="${CHECK_RECONSIDER_AFTER:-0}"
if [[ "$ARM" == "rethink" && "$CHECK_RECONSIDER_AFTER" == "0" ]]; then
	echo "native: ARM=rethink with CHECK_RECONSIDER_AFTER=0 is the proposed arm under another name" >&2
	exit 1
fi
# The ollama the run talks to. Empty means the CLI's own default
# (localhost:11434), which is the campaign baseline on 0.32.7-thinkbudget.
# Set it to reach a different server -- a model whose format that build
# cannot pull or run has to be measured somewhere else, and pinning the
# endpoint in the run record is how the two stay tellable apart.
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-}"

# The model `escalate` hands a stuck task to. Empty means no expert, and core
# then closes every escalation path -- the tool is not offered, the struggle
# detector does not suggest it, and the terminal guards do not force it -- so an
# arm without this variable is exactly the arm that ran before it existed.
#
# It is the SAME PROVIDER AND BASE URL as the session: the CLI builds the
# expert's connection from `config.baseUrl`, and there is no flag to point it
# somewhere else. So the expert has to be a model the run's own endpoint can
# serve. Measured 2026-09-13: an ollama `-cloud` tag pulls with {"status":
# "success"} on a host that is not signed in and then answers {"error":
# "Unauthorized"} at the first token -- pulling it proves nothing. Probe with a
# real /api/generate before an arm depends on it.
EXPERT_MODEL="${EXPERT_MODEL:-}"
EXPERT_NUM_CTX="${EXPERT_NUM_CTX:-}"
EXPERT_MAX_ESCALATIONS="${EXPERT_MAX_ESCALATIONS:-}"
EXPERT_MAX_FOLLOW_UPS="${EXPERT_MAX_FOLLOW_UPS:-}"
# "yes"/"1" releases the expert's conversation when an escalation ends. A local
# endpoint with OLLAMA_MAX_LOADED_MODELS of 1 or 2 needs the slot back; a hosted
# or cloud expert pays for it with a cold prompt cache on the next escalation.
EXPERT_CLOSE_AFTER="${EXPERT_CLOSE_AFTER:-}"

SOURCE="$H/manic_miner_1TESTSOURCE.html"
WORK="$H/work-native"
RESULTS="$H/results-native.jsonl"
# How many runs to do, not which run to stop at. This was compared against
# the run directory's sequence number, which starts from the highest one
# already on disk -- so it did the right thing only on an empty tree, and
# once runs had accumulated `./native.sh 4` did exactly one run and stopped.
# "iterations" also already means the agent's turns within a run, which is
# what run.jsonl counts; RUNS is the number of runs.
RUNS="${1:-0}"

[[ -f "$SOURCE" ]] || { echo "missing test source: $SOURCE" >&2; exit 1; }
mkdir -p "$WORK" "$H/runs-native"

# The oracle, run here as well as by the plugin. Not redundant: this is the
# reading that goes in the verdict file, and a run where the plugin's answer and
# this one disagree is the single most important thing this arm could find.
oracle() {
	( cd "$WORK" && timeout 120 node run_game.js manic_miner.html 2>&1 )
}

run_one() {
	local index="$1"
	local run_dir
	run_dir="$H/runs-native/$(date +%Y%m%d-%H%M%S)-$(printf '%04d' "$index")"
	mkdir -p "$run_dir"

	# /tmp is not reset between runs and the model scratches there freely.
	# This marker lets teardown tell this run's leftovers from everything else
	# in /tmp, so they can be archived with the run and then cleared: run 0149
	# read stale scratch left by 0148 and cited it as a previous session's
	# findings, which is indistinguishable from the task's own state.
	local tmp_mark="$run_dir/.tmp-mark"
	: > "$tmp_mark"

	# Fixed starting state, every time.
	rm -rf "$WORK"; mkdir -p "$WORK"
	cp -f "$SOURCE" "$WORK/manic_miner.html"
	cp -f "$SOURCE" "$run_dir/manic_miner.before.html"
	cp -f "$H/smoke.js" "$WORK/run_game.js"
	# Read-only for the same reason as the other arm: a transaction once spent
	# 36 editor calls trying to change the checker that was reporting its
	# failure. The snapshot restores by content, so a file nothing changed is
	# never written and the mode survives a rollback.
	chmod 444 "$WORK/run_game.js"
	# 444 stops an in-place write; it does not stop `rm` in a writable directory.
	# Record what the oracle is so the verdict can prove it is still that.
	local oracle_sha="$(sha256sum "$WORK/run_game.js" | cut -d" " -f1)"

	{
		echo "version=$(python3 -c "import json;print(json.load(open('$CLI_DIR/../vscode/package.json'))['version'])" 2>/dev/null)"
		echo "sha=$(git -C "$CLI_DIR" rev-parse --short HEAD 2>/dev/null)"
		echo "dirty=$(git -C "$CLI_DIR" status --porcelain 2>/dev/null | wc -l)"
		echo "model=$MODEL"
		echo "endpoint=${OLLAMA_BASE_URL:-http://localhost:11434 (default)}"
		echo "mode=native max_changes=$MAX_CHANGES max_tx=$MAX_TX run_timeout=${RUN_TIMEOUT}s"
		echo "arm=$ARM atomic=$ATOMIC_MODE propose_check=${PROPOSE_CHECK:-n/a} reconsider_after=$CHECK_RECONSIDER_AFTER"
		echo "manual_prompt=$PROMPT_ARM"
		echo "oracle=${ORACLE:-none} expect=${ORACLE:+$ORACLE_EXPECT}"
		echo "expert=${EXPERT_MODEL:-none} expert_num_ctx=${EXPERT_NUM_CTX:-default} max_escalations=${EXPERT_MAX_ESCALATIONS:-default} max_follow_ups=${EXPERT_MAX_FOLLOW_UPS:-default} close_after=${EXPERT_CLOSE_AFTER:-no}"
	} > "$run_dir/build.txt"
	# After the block, not before: that redirect truncates, and an oracle_sha
	# written ahead of it was being deleted on every run.
	echo "oracle_sha=$oracle_sha" >> "$run_dir/build.txt"

	local since started ended verdict
	since="$(date '+%Y-%m-%d %H:%M:%S')"
	started="$(date +%s)"
	verdict="broken"

	local prompt
	prompt="check manic_miner.html, it's not working. Run \`node run_game.js manic_miner.html\` to see whether it actually works -- it loads the page, starts the game and pumps animation frames, and prints what went wrong."
	# With the protocol off there is no `run_check`, nothing runs the oracle for
	# the model, and nothing makes it verify before it stops -- so the only
	# place a verification habit can come from is this sentence. Measured on
	# pandorum: the 4b, given the oracle in the prompt, ran both it and
	# `check_file` unprompted thereafter. Runs 0303 and 0304 made zero checks
	# between them.
	#
	# It is added only for the manual arm, so the other four measure the same
	# prompt they always did. That does make manual runs from here on
	# non-comparable with the manual runs before it, which is the point of the
	# change rather than a side effect of it.
	#
	# Which of the two manual prompts this run gets. `new` is the sentence
	# above and the default, so nothing changes for a launch that does not ask;
	# `old` is the bare prompt the manual runs before 0305 had. The switch
	# exists because one run is not evidence on a 9B model -- 0305 made 13
	# `check_file` calls and 0306 made 2, which is the spread you get from the
	# sampler alone. Set MANUAL_PROMPT=old to run the other arm.
	if [[ "$ATOMIC_MODE" == "off" && "$MANUAL_PROMPT" == "new" ]]; then
		prompt="$prompt Use \`check_file\` after each edit to see straight away whether what you wrote parses, and run the command again before you tell me you are done -- do not declare it fixed on a reading of the source."
	fi
	printf '%s\n' "$prompt" > "$run_dir/prompt.txt"

	# No protocol text here. That is the point of the arm: the rules, the change
	# limit, the record of what earlier transactions tried and the rollback are
	# all the plugin's now, and if any of it fails to arrive the run measures
	# that.
	# Through `auth` rather than by writing providers.json here. Hand-writing it
	# looked like it worked -- the file was on disk with the right base URL --
	# and the run still went to the default endpoint, because the CLI rewrites
	# the store from its own resolved settings at startup. Measured: a run
	# pointed at 11439 died on 11434's renderer registry in 14s.
	if [[ -n "$OLLAMA_BASE_URL" ]]; then
		bun run "$CLI_DIR/src/index.ts" auth \
			--provider "$PROVIDER" \
			--apikey local \
			--modelid "$MODEL" \
			--baseurl "$OLLAMA_BASE_URL" \
			--data-dir "$run_dir/state" \
			> "$run_dir/auth.log" 2>&1
	fi

	# maxToolResultChars has no flag: it is a per-provider field, and the
	# extension's default is 64000. `auth` does not write it, so it is added
	# here, after auth and before the run. Verified per run below.
	python3 - "$run_dir/state/settings/providers.json" <<'PYTHON' 2>/dev/null || true
import json, sys, os
path = sys.argv[1]
if os.path.exists(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    for entry in data.get("providers", {}).values():
        entry.setdefault("settings", {})["maxToolResultChars"] = 64000
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
PYTHON

	# The sampler, and the thinking level with it, belong to the plugin rather
	# than to the model (user, 2026-09-13). The extension's Ollama panel writes
	# them into the provider entry, and what the plugin sends wins field by
	# field over the tag's own PARAMETER lines -- so an arm that configures them
	# here is measuring the configuration a real session actually runs under.
	# It goes at settings.sampling, which is where `toProviderConfig` reads it
	# from -- an entry under settings.options is parsed and then never lifted
	# into what the vendor sees, and reaches nothing.
	# $OLLAMA_SAMPLING is that panel, as JSON in the gateway's own field names
	# (temperature, minP, repeatLastN, repeatPenalty, presencePenalty,
	# thinkBudget, ...). Unset leaves the file exactly as every previous arm had
	# it, which is the model's own sampler.
	if [[ -n "${OLLAMA_SAMPLING:-}" ]]; then
		python3 - "$run_dir/state/settings/providers.json" "${OLLAMA_SAMPLING}" <<'PYTHON'
import json, os, sys
path, sampling = sys.argv[1], json.loads(sys.argv[2])
if not os.path.exists(path):
    raise SystemExit(f"providers.json missing at {path}")
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
entry = data.get("providers", {}).get("ollama")
if entry is None:
    raise SystemExit("no ollama provider entry to configure")
entry.setdefault("settings", {})["sampling"] = sampling
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
# Read back, because a field the store writes and nobody reads is this
# codebase's most repeated failure.
with open(path, encoding="utf-8") as fh:
    back = json.load(fh)["providers"]["ollama"]["settings"]["sampling"]
if back != sampling:
    raise SystemExit(f"sampling did not survive the write: {back}")
print(f"native: plugin sampler {json.dumps(back, sort_keys=True)}")
PYTHON
		if [[ $? -ne 0 ]]; then
			echo "native: FAILED to configure the plugin sampler -- not running"
			return 1
		fi
	fi

	# An array rather than `${VAR:+--flag "$VAR"}`: that expansion is unquoted
	# by necessity, so `node run_game.js manic_miner.html` would arrive as three
	# arguments and the oracle would be `node`.
	# The extension's own defaults, because this harness exists to exercise the
	# plugin rather than to be its own thing (user, 2026-09-11). Each of these
	# is a value pandorum's globalState.json holds and the CLI does not reach
	# on its own:
	#
	#   task-progress-interval 2   plugin remindClineInterval=2; CLI default 6
	#
	# Already equal, and listed so nobody re-derives them:
	#   task-progress on           CLI default is on
	#   compaction agentic         CLI default; matches useAutoCondense=true
	#   edit-verification nudge    SDK default is already "nudge"
	#
	# Not reachable and deliberately not faked:
	#   autoApprovalSettings.maxRequests=20 -- the extension pauses for the
	#   user every 20 requests. There is no CLI equivalent, and an unattended
	#   batch has nobody to answer it, so replicating it would hang the run.
	local protocol_args=(--task-progress-interval 2)
	if [[ -n "$ORACLE" ]]; then
		protocol_args+=(--oracle "$ORACLE" --oracle-expect "$ORACLE_EXPECT")
	fi
	if [[ -n "$PROPOSE_CHECK" ]]; then
		protocol_args+=(--propose-check "$PROPOSE_CHECK")
		protocol_args+=(--check-reconsider-after "$CHECK_RECONSIDER_AFTER")
	fi
	# Each one omitted rather than passed empty: the CLI reads `--expert-model ""`
	# as a model named "", and the budgets have defaults of their own (3 and 20)
	# that an empty string would not preserve.
	if [[ -n "$EXPERT_MODEL" ]]; then
		protocol_args+=(--expert-model "$EXPERT_MODEL")
		[[ -n "$EXPERT_NUM_CTX" ]] && protocol_args+=(--expert-num-ctx "$EXPERT_NUM_CTX")
		[[ -n "$EXPERT_MAX_ESCALATIONS" ]] && protocol_args+=(--expert-max-escalations "$EXPERT_MAX_ESCALATIONS")
		[[ -n "$EXPERT_MAX_FOLLOW_UPS" ]] && protocol_args+=(--expert-max-follow-ups "$EXPERT_MAX_FOLLOW_UPS")
		case "$EXPERT_CLOSE_AFTER" in yes|1|true) protocol_args+=(--expert-close-after) ;; esac
	fi

	# Confine the run to its workspace. cline sets --cwd but enforces no
	# boundary: an absolute path in `editor`, or any `run_commands` shell line,
	# writes wherever it likes. Runs have been leaving scratch all over /tmp --
	# 93 files from one run -- and with two campaigns live, one run's teardown
	# was in a position to delete another's files.
	#
	# Everything is read-only except the workspace and this run's own
	# directory. /tmp is bound to $run_dir/tmp rather than a tmpfs, so the
	# model still gets a working /tmp, the scratch is preserved with the run
	# for forensics, and none of it touches the host. Reads are unrestricted,
	# which bun, node and the CLI all need. --share-net keeps ollama reachable.
	mkdir -p "$run_dir/tmp"
	timeout -k 60 $((RUN_TIMEOUT + 120)) \
		bwrap \
			--ro-bind / / \
			--dev /dev --proc /proc \
			--bind "$run_dir/tmp" /tmp \
			--bind "$WORK" "$WORK" \
			--bind "$run_dir" "$run_dir" \
			--share-net --die-with-parent \
			--chdir "$WORK" \
		bun run "$CLI_DIR/src/index.ts" "$prompt" \
		--provider "$PROVIDER" \
		--model "$MODEL" \
		--thinking "$THINKING" \
		--cwd "$WORK" \
		--data-dir "$run_dir/state" \
		--json \
		--auto-approve true \
		--retries "$RETRIES" \
		--atomic "$ATOMIC_MODE" \
		"${protocol_args[@]}" \
		--max-changes "$MAX_CHANGES" \
		--max-transactions "$MAX_TX" \
		-t "$RUN_TIMEOUT" \
		2> "$run_dir/run.stderr" \
		| python3 "$H/strip-accumulated.py" > "$run_dir/run.jsonl"
	# The CLI's status, not the filter's. Every text delta carries the whole
	# block so far in `accumulated`, so the log grows with the SQUARE of block
	# length -- 829 MB of one run's 843 MB was that one field. The filter drops
	# it as the file is written; content_end still carries the full block.
	local status=${PIPESTATUS[0]}
	ended="$(date +%s)"

	local out; out="$(oracle)"
	printf '%s\n' "$out" > "$run_dir/oracle.txt"

	# Four statuses, so that `broken` means one thing only: the oracle looked at
	# the file and said no.
	#
	#   FIXED    the oracle passed. It outranks the clock: a run that fixes the
	#            file on its last minute has still fixed the file.
	#   TIMEOUT  the run hit the wall. Two ways in -- `timeout` kills the
	#            process (124, or 137 after -k), or the CLI's own -t ends the
	#            session from inside and exits 0 at ~RUN_TIMEOUT. The pp0 arm's
	#            five "broken" rows were all the second kind, at 5402-5405s
	#            against a 5400s cap, and every one of them read as a verdict.
	#   ABORTED  the run died without producing one: non-zero exit that is not
	#            the clock (a crash, an OOM, an operator kill -> 143), or an
	#            empty event log.
	#   broken   the oracle's verdict, and now nothing else.
	local elapsed=$((ended - started))
	local reason=""
	# The oracle is only a verdict if it is still the oracle. A run that replaces
	# run_game.js has graded its own exam, and no reading of its output is worth
	# anything -- so this is checked before the output is read, not after.
	local oracle_now=""
	[[ -f "$WORK/run_game.js" ]] && oracle_now="$(sha256sum "$WORK/run_game.js" | cut -d" " -f1)"
	if [[ -n "${oracle_sha:-}" && "$oracle_now" != "$oracle_sha" ]]; then
		verdict="ABORTED"
		if [[ -z "$oracle_now" ]]; then
			reason="oracle deleted: run_game.js is gone"
		else
			reason="oracle replaced: run_game.js sha ${oracle_now:0:12} != ${oracle_sha:0:12}"
		fi
	elif grep -qE "$ORACLE_EXPECT" <<<"$out"; then
		verdict="FIXED"
	elif (( status == 124 || status == 137 )) || (( elapsed >= RUN_TIMEOUT - 5 )); then
		verdict="TIMEOUT"
		reason="clock: ${elapsed}s vs ${RUN_TIMEOUT}s cap, exit=$status"
	elif (( status != 0 )); then
		verdict="ABORTED"
		reason="exit=$status"
		(( status == 143 )) && reason="$reason (SIGTERM)"
		(( status == 130 )) && reason="$reason (SIGINT)"
	elif [[ ! -s "$run_dir/run.jsonl" ]]; then
		verdict="ABORTED"
		reason="no event log written"
	fi
	[[ -n "$reason" ]] && printf '%s\n' "$reason" > "$run_dir/abort-reason.txt"

	# What the plugin said it did, pulled out of the event stream. A run that
	# reports no transactions at all did not arm the protocol, and that reads
	# identically to a run that arms it and gets everything right first time --
	# which is why this is recorded rather than inferred from the verdict.
	python3 - "$run_dir/run.jsonl" > "$run_dir/transactions.txt" <<'PY'
import json, sys
kept = discarded = empty = 0
try:
    with open(sys.argv[1], errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            # In --json the CLI wraps every event as {"type":"agent_event",
            # "event":{...}}; unwrapped records are read too so this survives a
            # change to that shape rather than silently reporting nothing.
            event = record.get("event") if isinstance(record.get("event"), dict) else record
            meta = event.get("metadata") or {}
            # A submission that changed nothing, counted apart from the verdicts
            # because it is not one: no check ran, no file was put back, and
            # since the guard landed it no longer costs a transaction either.
            # Run 0028 spent five of its six on these and read as six failed
            # attempts when it had made one.
            if meta.get("kind") == "atomic_empty_attempt":
                empty += 1
                print(event.get("message", "").strip()[:200])
                continue
            if meta.get("kind") != "atomic_transaction":
                continue
            if meta.get("kept"):
                kept += 1
            else:
                discarded += 1
            print(event.get("message", "").strip()[:200])
except OSError:
    pass
print(f"kept={kept} discarded={discarded} empty={empty}")
PY

	# What the model did with the check, which is the whole variable in the
	# `self` and `proposed` arms and invisible in the transaction record: a
	# proposal approved without an `expect` keeps every transaction it judges,
	# because run_game.js exits 0 whether the game runs or not, and a run that
	# never proposed at all reads identically to one that did.
	python3 - "$run_dir/run.jsonl" > "$run_dir/checks.txt" <<'CHECKS'
import json, sys

# What the model asked for and what the protocol did with it. The adoption is
# read off the tool's own output rather than the logger's line: the logger says
# "you approved", which is written for a user who was asked, and this host does
# not ask -- so keying on it found nothing while the approval was working.
proposals = []
adopted = 0
ran = 0
# What the model verified with, as opposed to what the harness verified with.
#
# `ORACLE=""` does not produce a run without an oracle. It stops the check being
# handed to the CLI as `--oracle`; `run_game.js` is copied into the workspace
# unconditionally and the task prompt names it in every arm. So in the arms that
# are called non-oracle the model still has the ground-truth checker and is
# still told to run it, and the difference between the arms is only who judges.
# Run 0303 made 13 `run_commands` calls and every one of them was the oracle.
#
# Counted rather than removed: taking it away changes what the arms mean, and
# the size of the effect is knowable from the runs that already exist.
oracle_runs = 0
commands = 0
checked_files = 0
# The `rethink` arm's whole question: did the run ever get told its check had
# never passed, and did it then replace it. The offer is a heading in the
# transaction rules, so it is read wherever the prompt reaches the record.
offered = 0
broken_rejected = 0
try:
	with open(sys.argv[1], errors="replace") as handle:
		for line in handle:
			try:
				record = json.loads(line)
			except ValueError:
				continue
			event = record.get("event") if isinstance(record.get("event"), dict) else record
			if not isinstance(event, dict):
				continue
			if "THE CHECK HAS NEVER PASSED" in line:
				offered += 1
			name = event.get("toolName")
			if name == "run_check" and event.get("type") == "content_end":
				ran += 1
			if name == "check_file" and event.get("type") == "content_end":
				checked_files += 1
			if name == "run_commands" and event.get("type") == "content_start":
				commands += 1
				# The input, not the output: a command that failed to run is
				# still an attempt to verify, and that is what is being counted.
				if "run_game.js" in json.dumps(event.get("input") or {}):
					oracle_runs += 1
			if name != "propose_check":
				continue
			proposal = event.get("input")
			if isinstance(proposal, dict):
				proposals.append(proposal)
			output = event.get("output")
			if isinstance(output, str) and output.startswith("Approved."):
				adopted += 1
			# A check the interpreter could not run at all, caught before it
			# was frozen. Two runs of ten were lost to one of these.
			if isinstance(output, str) and "did not run:" in output:
				broken_rejected += 1
except OSError:
	pass

# The `expect` is the field to read. A proposal that names one the fixed file
# cannot produce judges every attempt against something unreachable and throws
# the whole run away, and there is nobody here to veto it -- which is the thing
# this arm is measuring, so it has to be in the record rather than inferred.
for proposal in proposals:
	print("proposed: " + json.dumps(proposal)[:400])
print(
	f"proposals={len(proposals)} adopted={adopted} run_checks={ran} "
	f"rethink_offered={offered} broken_rejected={broken_rejected} "
	f"oracle_runs={oracle_runs} commands={commands} check_files={checked_files}"
)
CHECKS

	# Whether the expert was ever reached, and what it cost. Recorded for the
	# same reason as the transaction record above: a run that never escalated
	# and a run with no expert configured produce identical event streams, and
	# the difference between them is the whole arm. `configured` is read off
	# the CLI's own startup line rather than off EXPERT_MODEL, because the
	# variable says what was asked for and the line says what was built.
	python3 - "$run_dir/run.jsonl" > "$run_dir/escalations.txt" <<'ESC'
import json, sys

calls = started = replies = ended = changed = 0
input_tokens = output_tokens = generate_ms = requests = asks = 0
try:
	with open(sys.argv[1], errors="replace") as handle:
		for line in handle:
			try:
				record = json.loads(line)
			except ValueError:
				continue
			event = record.get("event") if isinstance(record.get("event"), dict) else record
			if not isinstance(event, dict):
				continue
			if event.get("toolName") == "escalate" and event.get("type") == "content_end":
				calls += 1
			meta = event.get("metadata") or {}
			kind = meta.get("kind")
			if kind == "escalation_started":
				started += 1
				print("brief: " + str(meta.get("brief", ""))[:300])
			elif kind == "expert_reply":
				replies += 1
				if meta.get("changed"):
					changed += 1
				usage = meta.get("usage") or {}
				input_tokens += usage.get("inputTokens") or 0
				output_tokens += usage.get("outputTokens") or 0
				generate_ms += usage.get("generateMs") or 0
				# `requests` is provider calls and `asks` is hand-overs. They were
				# one field until 2026-09-14, which is why run 0303 printed
				# expert_in=9,490,524 against expert_requests=1.
				requests += usage.get("requests") or 0
				asks += usage.get("asks") or 0
			elif kind == "escalation_ended":
				ended += 1
except OSError:
	pass
print(
	f"escalate_calls={calls} started={started} expert_replies={replies} "
	f"changed={changed} ended={ended} expert_in={input_tokens} "
	f"expert_out={output_tokens} expert_gen_s={generate_ms // 1000} "
	f"expert_requests={requests} expert_asks={asks} "
	f"expert_in_per_request={(input_tokens // requests) if requests else 0}"
)
ESC

	# The expert is only armed if core built the connection. Without it every
	# escalation path is closed silently, and the arm would read as "the model
	# never needed the expert" when it was never offered one.
	# The line lands in the CLI's own log, not on stderr and not in the event
	# stream -- checked on run 0298, where stderr was 0 bytes and the expert was
	# configured. All three are grepped so a host that routes it differently
	# still reports the truth; `state/logs/cline.log` is the one that has it.
	local expert_configured="no"
	if grep -qs "\[Escalation\] Expert configured" \
		"$run_dir/state/logs/cline.log" "$run_dir/run.stderr" "$run_dir/run.jsonl"; then
		expert_configured="yes"
	fi
	local esc_line; esc_line="$(tail -1 "$run_dir/escalations.txt") expert_configured=$expert_configured"

	local tx_line; tx_line="$(tail -1 "$run_dir/transactions.txt")"
	cp -f "$WORK/manic_miner.html" "$run_dir/manic_miner.after.html" 2>/dev/null
	# Archive this run's /tmp scratch with the run, then clear it. Only
	# top-level regular files newer than the marker: directories are left
	# alone so no other tool's workspace is touched, and the tarball means the
	# wipe stays reversible if a leftover turns out to matter.
	# The list lives beside the run, not in /tmp: a scratch file in /tmp would
	# match its own find and land in the archive.
	local tmp_list="$run_dir/.tmp-list"
	# Scratch now lands in $run_dir/tmp inside the sandbox, so there is
	# nothing of ours in the host /tmp to collect and nothing to delete.
	: > "$tmp_list"
	find "$run_dir/tmp" -maxdepth 1 -type f -print0 >> "$tmp_list" 2>/dev/null
	if [ -s "$tmp_list" ]; then
		tar --null --files-from="$tmp_list" -czf "$run_dir/tmp-scratch.tar.gz" 2>/dev/null
		printf 'tmp scratch archived: %s files\n' \
			"$(tr -cd '\0' < "$tmp_list" | wc -c)" >> "$run_dir/exit.txt.pre" 2>/dev/null
		: # nothing to delete: the scratch lives in the run directory
	fi
	rm -f "$tmp_list" "$tmp_mark"
	journalctl -u ollama --since "$since" --no-pager -o cat > "$run_dir/ollama.log" 2>/dev/null

	local check_line; check_line="$(tail -1 "$run_dir/checks.txt")"
	# `esc_line` goes after `check_line` for the reason the arm went last: the
	# chain scripts and tx_watch.py read the leading fields by position, and
	# appending is the only edit to this line that cannot break them.
	printf 'verdict=%s %s wall=%ss exit=%s arm=%s %s %s%s\n' \
		"$verdict" "$tx_line" "$((ended - started))" "$status" "$ARM" "$check_line" "$esc_line" \
		"${reason:+ reason=\"$reason\"}" \
		> "$run_dir/exit.txt"
	# The arm goes last, after the fields the chain scripts and tx_watch.py
	# already read off this line by position.
	printf '%s  %s  %s %ss  arm=%s prompt=%s\n' \
		"$(basename "$run_dir")" "$verdict" "$tx_line" "$((ended - started))" "$ARM" "$PROMPT_ARM" |
		tee -a "$H/verdicts-native.txt"
	python3 -c "
import json
print(json.dumps({'run':'$(basename "$run_dir")','verdict':'$verdict','seconds':$((ended - started)),'exit':$status,'arm':'$ARM','checks':'$check_line'}))" >> "$RESULTS"

	# Age out the runs behind the newest six: compress the transcript in place,
	# and put the session state on the big disk before removing it here. The
	# second half used to be `rm -rf "$old"/state`, which threw away the only
	# record of what was actually sent. See archive-state.sh.
	find "$H/runs-native" -maxdepth 1 -type d -name '2[0-9]*' | sort | head -n -6 |
		while read -r old; do
			gzip -q -f "$old"/run.jsonl 2>/dev/null
			"$H/archive-state.sh" "$old"
		done
}

# The tag is checked before any run, every run, on every lane.
#
# `jackod4ac-9b_tb:q6_k-128k` on eleven2go had an unclosed quoted TEMPLATE that
# swallowed its RENDERER, PARSER and every PARAMETER -- no think_budget, no
# think_budget_message, no temperature, and the GGUF Jinja in place of the
# qwen3.5 renderer. Runs 0267-0271 were measured on it (5/5 broken, 4.1 h) and
# the failure was read as the model's. `ollama show` prints the swallowed text
# back as configuration, so checking by eye confirms the wrong answer; only
# /api/show's `parameters` field says what is really in force.
#
# TAG_CHECK=off to skip, TAG_CHECK_BUDGET=no if the arm's model has no budget.
if [[ "${TAG_CHECK:-on}" != "off" ]]; then
	_tc_ep="${OLLAMA_BASE_URL:-http://localhost:11434}"
	_tc_args=("$_tc_ep" "$MODEL")
	[[ "${TAG_CHECK_BUDGET:-yes}" == "yes" ]] && _tc_args+=(--require-budget)
	if ! "$H/check-tag.sh" "${_tc_args[@]}"; then
		echo "native: REFUSING to run -- $MODEL is misconfigured on $_tc_ep."
		echo "native: fix the tag, or set TAG_CHECK=off if you know what you are doing."
		exit 1
	fi
	if [[ -n "${EXPERT_MODEL:-}" ]]; then
		# The expert answers from the same endpoint; a broken expert tag is the
		# same silent failure, one level down.
		"$H/check-tag.sh" "$_tc_ep" "$EXPERT_MODEL" || {
			echo "native: REFUSING to run -- expert $EXPERT_MODEL is misconfigured."; exit 1; }
	fi
fi

echo "native: arm=$ARM atomic=$ATOMIC_MODE manual_prompt=$PROMPT_ARM oracle=${ORACLE:-none} propose_check=${PROPOSE_CHECK:-n/a} reconsider_after=$CHECK_RECONSIDER_AFTER expert=${EXPERT_MODEL:-none} model=$MODEL thinking=$THINKING max_changes=$MAX_CHANGES max_tx=$MAX_TX run_timeout=${RUN_TIMEOUT}s runs=${RUNS:-unbounded}"
index=$(( $(find "$H/runs-native" -maxdepth 1 -type d -name '2[0-9]*' 2>/dev/null |
	sed 's/.*-//' | sort -n | tail -1 | sed 's/^0*//' | grep -E '^[0-9]+$' || echo 0) + 1 ))
completed=0
while :; do
	run_one "$index"
	completed=$(( completed + 1 ))
	if [[ "$RUNS" != "0" ]] && (( completed >= RUNS )); then
		break
	fi
	if [[ -f "$H/STOP-NATIVE" ]]; then
		echo "native: stopping on STOP-NATIVE"
		break
	fi
	index=$(( index + 1 ))
done
