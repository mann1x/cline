#!/usr/bin/env bash
# Reconstructs the change-protocol opening prompt at a given commit and prints
# its size. No build and no GPU: bun transpiles the one file, and the modules it
# imports are stubbed with the same constants the real ones export.
#
# The input is the arm's: TX-01, maxChanges 3, maxTransactions 6, no history,
# and the host-supplied command oracle the harness arms.
set -uo pipefail
REPO=/srv/dev-disk-by-label-opt/dev/cline
SHA="$1"
W=$(mktemp -d -p /srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness/bisect-prompt)
trap 'rm -rf "$W"' EXIT

git -C "$REPO" show "$SHA:sdk/packages/core/src/runtime/atomic/protocol.ts" > "$W/protocol.ts" 2>/dev/null || { echo "$SHA NOFILE"; exit 0; }

# Stub every sibling module this revision imports, with the real constants.
grep -oE 'from "\./[a-z0-9-]+"' "$W/protocol.ts" | sed 's/from "\.\///;s/"//' | sort -u | while read -r m; do
  case "$m" in
    oracle)         printf 'export function isPageOracle(o){return o.kind==="page";}\n' > "$W/$m.ts";;
    proposal)       printf 'export const PROPOSE_CHECK_TOOL_NAME="propose_check";\n' > "$W/$m.ts";;
    run-check-tool) printf 'export const RUN_CHECK_TOOL_NAME="run_check";\n' > "$W/$m.ts";;
    plan-tool)      printf 'export const PLAN_TOOL_NAME="plan";\n' > "$W/$m.ts";;
    *)              printf 'export const __stub=1;\n' > "$W/$m.ts";;
  esac
done

cat > "$W/run.ts" <<'TS'
import { buildProtocolPrompt } from "./protocol";
const text = buildProtocolPrompt({
	transaction: 1,
	maxChanges: 3,
	maxTransactions: 6,
	oracle: {
		kind: "command",
		label: "node run_game.js manic_miner.html",
		reason: "named for this task",
		expect: '"ok":\\s*true',
	} as never,
	history: [],
} as never);
process.stdout.write(String(text.length) + "\t" + String(text.split("\n").length) + "\n");
TS
out=$(cd "$W" && timeout 60 bun run run.ts 2>"$W/err")
if [[ -z "$out" ]]; then echo "$SHA ERR $(head -c 120 "$W/err" | tr '\n' ' ')"; else echo "$SHA $out"; fi
