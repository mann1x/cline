#!/usr/bin/env bash
# The same file and the same protocol as native.sh, with teammates.
#
# native.sh measures one model alone against manic_miner.html. This arm asks a
# different question: whether a model that cannot solve the task by itself can
# solve it by delegating the parts it is bad at. The main model is deliberately
# the weak one -- v7-coder, whose only broken verdict in the campaign is run
# 0006 at 10919s -- and the teammates run on a stronger model reached through
# the same ollama endpoint.
#
# What is deliberately the same as native.sh:
#
#   * the same broken file, the same injected fault, the same run_game.js
#   * three declared changes per transaction, six transactions, one session
#   * the oracle decides, and it is run by something other than the model
#
# What is different, and is the thing to read:
#
#   * `.cline/agents/` is installed in the work directory, so `auditor` and
#     `implementer` exist as configured agents. Neither has the editor: the
#     main model stays the only writer, because the atomic protocol accounts
#     for the changes *it* declares and a subagent writing the same file behind
#     that accounting would make the transaction record a fiction.
#
#   * The prompt says the teammates are there. A model that is never told does
#     not go looking, and this arm is not a test of whether it discovers them.
#
#   * --agents-model puts the delegates on their own model. --parallel-sessions
#     is set explicitly because the limit is otherwise asked of the local
#     endpoint, which serves one request at a time and so withholds the team
#     tools entirely (slotsAllowParallelDelegation needs > 1).
#
# Usage:  ./teams.sh [runs]              (0 or empty = until stopped)
#         AGENTS_MODEL=glm-5.2:cloud ./teams.sh 1
set -uo pipefail

H="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="${CLI_DIR:-/shared/dev/cline-scan/apps/cli}"
# The model that struggles. That is the point of the arm.
MODEL="${MODEL:-v7-coder_tb:vision-q6_k}"
PROVIDER="${PROVIDER:-ollama}"
THINKING="${THINKING:-high}"
MAX_CHANGES="${MAX_CHANGES:-3}"
MAX_TX="${MAX_TX:-6}"
RETRIES="${RETRIES:-6}"
RUN_TIMEOUT="${RUN_TIMEOUT:-21600}"
ORACLE="${ORACLE:-node run_game.js manic_miner.html}"
ORACLE_EXPECT="${ORACLE_EXPECT:-\"ok\":\\s*true}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-}"
# The teammates' model, reached through the same provider and base URL as the
# session -- which is how a `:cloud` tag works at all: the local server proxies
# it, so it is the same endpoint from the CLI's side.
AGENTS_MODEL="${AGENTS_MODEL:-glm-5.2:cloud}"
AGENTS_NUM_CTX="${AGENTS_NUM_CTX:-}"
PARALLEL_SESSIONS="${PARALLEL_SESSIONS:-3}"

SOURCE="$H/manic_miner_1TESTSOURCE.html"
AGENTS_SRC="$H/agents-teams"
WORK="$H/work-teams"
RESULTS="$H/results-teams.jsonl"
RUNS="${1:-0}"

[[ -f "$SOURCE" ]] || { echo "missing test source: $SOURCE" >&2; exit 1; }
[[ -d "$AGENTS_SRC" ]] || { echo "missing agent files: $AGENTS_SRC" >&2; exit 1; }
mkdir -p "$WORK" "$H/runs-teams"

oracle() {
	( cd "$WORK" && timeout 120 node run_game.js manic_miner.html 2>&1 )
}

run_one() {
	local index="$1"
	local run_dir
	run_dir="$H/runs-teams/$(date +%Y%m%d-%H%M%S)-$(printf '%04d' "$index")"
	mkdir -p "$run_dir"

	rm -rf "$WORK"; mkdir -p "$WORK"
	cp -f "$SOURCE" "$WORK/manic_miner.html"
	cp -f "$SOURCE" "$run_dir/manic_miner.before.html"
	cp -f "$H/smoke.js" "$WORK/run_game.js"
	chmod 444 "$WORK/run_game.js"
	# Read-only for the same reason as the runner: a model that can rewrite its
	# own teammates can make the arm measure something other than delegation.
	mkdir -p "$WORK/.cline/agents"
	cp -f "$AGENTS_SRC"/*.md "$WORK/.cline/agents/"
	chmod 444 "$WORK/.cline/agents"/*.md

	{
		echo "version=$(python3 -c "import json;print(json.load(open('$CLI_DIR/../vscode/package.json'))['version'])" 2>/dev/null)"
		echo "sha=$(git -C "$CLI_DIR" rev-parse --short HEAD 2>/dev/null)"
		echo "dirty=$(git -C "$CLI_DIR" status --porcelain 2>/dev/null | wc -l)"
		echo "model=$MODEL"
		echo "agents_model=$AGENTS_MODEL agents_num_ctx=${AGENTS_NUM_CTX:-model default} parallel_sessions=$PARALLEL_SESSIONS"
		echo "agents=$(cd "$WORK/.cline/agents" && ls *.md | tr '\n' ' ')"
		echo "endpoint=${OLLAMA_BASE_URL:-http://localhost:11434 (default)}"
		echo "mode=teams max_changes=$MAX_CHANGES max_tx=$MAX_TX run_timeout=${RUN_TIMEOUT}s"
		echo "oracle=$ORACLE expect=$ORACLE_EXPECT"
	} > "$run_dir/build.txt"

	local since started ended verdict
	since="$(date '+%Y-%m-%d %H:%M:%S')"
	started="$(date +%s)"
	verdict="broken"

	# The teammates are named, and what they are for is said once. Anything more
	# prescriptive than this starts to be the protocol rather than the model's
	# choice, and whether it chooses to delegate is the measurement.
	local prompt
	prompt="check manic_miner.html, it's not working. Run \`node run_game.js manic_miner.html\` to see whether it actually works -- it loads the page, starts the game and pumps animation frames, and prints what went wrong.

You have teammates on a stronger model, and you should use them rather than doing everything yourself. \`auditor\` will read the file and tell you every function that is called but never defined and every block that closes in the wrong place. \`implementer\` will write one missing function at a time and hand you the code. You are the only one who edits the file, so apply what they give you yourself."
	printf '%s\n' "$prompt" > "$run_dir/prompt.txt"

	if [[ -n "$OLLAMA_BASE_URL" ]]; then
		bun run "$CLI_DIR/src/index.ts" auth \
			--provider "$PROVIDER" \
			--apikey local \
			--modelid "$MODEL" \
			--baseurl "$OLLAMA_BASE_URL" \
			--data-dir "$run_dir/state" \
			> "$run_dir/auth.log" 2>&1
	fi

	local agents_ctx_args=()
	[[ -n "$AGENTS_NUM_CTX" ]] && agents_ctx_args=(--agents-num-ctx "$AGENTS_NUM_CTX")

	timeout -k 60 $((RUN_TIMEOUT + 120)) bun run "$CLI_DIR/src/index.ts" "$prompt" \
		--provider "$PROVIDER" \
		--model "$MODEL" \
		--agents-model "$AGENTS_MODEL" \
		"${agents_ctx_args[@]}" \
		--parallel-sessions "$PARALLEL_SESSIONS" \
		--thinking "$THINKING" \
		--cwd "$WORK" \
		--data-dir "$run_dir/state" \
		--json \
		--auto-approve true \
		--retries "$RETRIES" \
		--atomic auto \
		--oracle "$ORACLE" \
		--oracle-expect "$ORACLE_EXPECT" \
		--max-changes "$MAX_CHANGES" \
		--max-transactions "$MAX_TX" \
		-t "$RUN_TIMEOUT" \
		> "$run_dir/run.jsonl" 2> "$run_dir/run.stderr"
	local status=$?
	ended="$(date +%s)"

	local out; out="$(oracle)"
	printf '%s\n' "$out" > "$run_dir/oracle.txt"
	grep -q '"ok":[[:space:]]*true' <<<"$out" && verdict="FIXED"

	python3 - "$run_dir/run.jsonl" > "$run_dir/transactions.txt" <<'PY'
import json, sys
kept = discarded = 0
try:
    with open(sys.argv[1], errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            event = record.get("event") if isinstance(record.get("event"), dict) else record
            meta = event.get("metadata") or {}
            if meta.get("kind") != "atomic_transaction":
                continue
            if meta.get("kept"):
                kept += 1
            else:
                discarded += 1
            print(event.get("message", "").strip()[:200])
except OSError:
    pass
print(f"kept={kept} discarded={discarded}")
PY

	# Whether it delegated at all, and to whom. A run that never spawns an agent
	# is the most likely outcome to be misread as "teams do not help": it did not
	# try. Counted from the event stream rather than inferred from the wall clock.
	# Counted from the tool calls in the session, not from the event stream. Run
	# 0001 delegated three times and this reported `delegations=0`, because it
	# looked for an `agentName` in event metadata and no event carries one: a
	# configured agent is offered as a tool named `subagent_<name>`, so the call
	# to it is the only place the delegation is written down.
	python3 - "$run_dir/state" > "$run_dir/delegation.txt" <<'PY'
import collections, glob, json, os, sys
spawned = collections.Counter()
for path in glob.glob(os.path.join(sys.argv[1], "sessions", "*", "*.messages.json")):
    try:
        with open(path, errors="replace") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        continue
    for message in data if isinstance(data, list) else data.get("messages", []):
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if part.get("type") not in ("tool_use", "tool-call"):
                continue
            name = str(part.get("name") or part.get("toolName") or "")
            if name.startswith("subagent_"):
                spawned[name[len("subagent_"):]] += 1
for name, count in sorted(spawned.items()):
    print(f"agent {name}: {count}")
print(f"delegations={sum(spawned.values())}")
PY

	local tx_line; tx_line="$(tail -1 "$run_dir/transactions.txt")"
	local del_line; del_line="$(tail -1 "$run_dir/delegation.txt")"
	cp -f "$WORK/manic_miner.html" "$run_dir/manic_miner.after.html" 2>/dev/null
	journalctl -u ollama --since "$since" --no-pager -o cat > "$run_dir/ollama.log" 2>/dev/null

	printf 'verdict=%s %s %s wall=%ss exit=%s\n' \
		"$verdict" "$tx_line" "$del_line" "$((ended - started))" "$status" > "$run_dir/exit.txt"
	printf '%s  %s  %s %s %ss\n' \
		"$(basename "$run_dir")" "$verdict" "$tx_line" "$del_line" "$((ended - started))" |
		tee -a "$H/verdicts-teams.txt"
	python3 -c "
import json
print(json.dumps({'run':'$(basename "$run_dir")','verdict':'$verdict','seconds':$((ended - started)),'exit':$status}))" >> "$RESULTS"

	find "$H/runs-teams" -maxdepth 1 -type d -name '2[0-9]*' | sort | head -n -6 |
		while read -r old; do
			gzip -q -f "$old"/run.jsonl 2>/dev/null
			# Archived, not deleted -- see archive-state.sh.
			"$H/archive-state.sh" "$old"
		done
}

echo "teams: model=$MODEL agents=$AGENTS_MODEL parallel=$PARALLEL_SESSIONS thinking=$THINKING max_changes=$MAX_CHANGES max_tx=$MAX_TX run_timeout=${RUN_TIMEOUT}s runs=${RUNS:-unbounded}"
index=$(( $(find "$H/runs-teams" -maxdepth 1 -type d -name '2[0-9]*' 2>/dev/null |
	sed 's/.*-//' | sort -n | tail -1 | sed 's/^0*//' | grep -E '^[0-9]+$' || echo 0) + 1 ))
completed=0
while :; do
	run_one "$index"
	completed=$(( completed + 1 ))
	if [[ "$RUNS" != "0" ]] && (( completed >= RUNS )); then
		break
	fi
	if [[ -f "$H/STOP-TEAMS" ]]; then
		echo "teams: stopping on STOP-TEAMS"
		break
	fi
	index=$(( index + 1 ))
done
