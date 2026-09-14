#!/usr/bin/env bash
# Reproduces native.sh's run_one scoping exactly: the sha is taken near the top
# of the function, the verdict block is 150 lines further down in the SAME
# function, and the question is whether the value survives the `local` line in
# between.
set -uo pipefail
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
printf 'ORACLE\n' > "$W/run_game.js"; chmod 444 "$W/run_game.js"

run_one() {   # $1 = "shadow" | "fixed", $2 = what happens to the file
	local WORK="$W"
	if [[ "$1" == shadow ]]; then
		oracle_sha="$(sha256sum "$WORK/run_game.js" | cut -d' ' -f1)"
	else
		local oracle_sha="$(sha256sum "$WORK/run_game.js" | cut -d' ' -f1)"
	fi
	case "$2" in
		replace) rm -f "$WORK/run_game.js"; printf 'MINE\n' > "$WORK/run_game.js";;
		delete)  rm -f "$WORK/run_game.js";;
	esac
	local since started ended verdict
	[[ "$1" == shadow ]] && local oracle_sha
	verdict=FIXED
	local oracle_now=""
	[[ -f "$WORK/run_game.js" ]] && oracle_now="$(sha256sum "$WORK/run_game.js" | cut -d' ' -f1)"
	if [[ -n "${oracle_sha:-}" && "$oracle_now" != "$oracle_sha" ]]; then verdict=ABORTED; fi
	printf '%s\n' "$verdict"
	# put it back for the next case
	rm -f "$WORK/run_game.js"; printf 'ORACLE\n' > "$WORK/run_game.js"; chmod 444 "$WORK/run_game.js"
}

fail=0
check() { # label expected actual
	if [[ "$2" == "$3" ]]; then printf '  ok   %-34s %s\n' "$1" "$3"
	else printf '  FAIL %-34s got %s, wanted %s\n' "$1" "$3" "$2"; fail=1; fi
}
echo "=== installed shape (local at the assignment) ==="
check "untouched oracle -> verdict stands" FIXED   "$(run_one fixed none)"
check "oracle replaced   -> ABORTED"       ABORTED "$(run_one fixed replace)"
check "oracle deleted    -> ABORTED"       ABORTED "$(run_one fixed delete)"
echo "=== negative control (the shadowing shape that was installed) ==="
check "replaced but guard blind"           FIXED   "$(run_one shadow replace)"
exit $fail
