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
	if grep -q '"ok":[[:space:]]*true' <<<"$out"; then
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
