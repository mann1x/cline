# manic_miner loop harness

Asks the same question of the same broken file, over and over, and writes down
what happened each time:

> check manic_miner.html, it's not working

The file is restored from `manic_miner_1TESTSOURCE.html` before every run and
each run gets its own `--data-dir`, so run N measures the agent rather than
what run N-1 left behind.

## Running

```sh
./harness.sh          # loop until stopped
./harness.sh 5        # five runs
MODEL=… THINKING=… TIMEOUT=… ./harness.sh 10
```

Stop it with `touch STOP`. The run in flight finishes and is analysed, then the
loop ends and the file is removed. Do not kill the loop instead: the run's own
`bun` process survives the parent, so it keeps the GPU busy while nothing
remains to write its analysis, and `harness.sh` cannot be edited while it runs
because bash reads the script as it goes. `pkill -f harness.sh` also matches the
shell you typed it in.

Two more things belong to the run and not to a default. `RETRIES` (default 6) is
passed explicitly as `--retries` and recorded in `build.txt` — the CLI's own
default was 3 while its help said 6, and a run that had made nine edits in
twenty-four minutes was ended by a budget nobody chose. And rebuilding
`@cline/core` while a run is in flight contaminates it: the CLI reads `dist`, so
a run started on one build can finish on another.

## Where this lives

`/srv/dev-disk-by-uuid-92295e2c-.../spool/manic-harness`, on the nvme, since
2026-08-11. It used to sit on `backup_models/` — that is bcache0, backed by the
md2 RAID5, which is in writethrough and so has no write buffer other than its
own stripe cache. A run writes ~25MB of `cline.log` per 1000s straight onto that
array. On 2026-08-11 md2's stripe cache filled and the array stopped dispatching
entirely for 5.5 hours; the harness was one of the writers and the only one with
no reason to be there. The old path is a symlink, so nothing that remembers it
breaks.

## What counts as success

Not "the file was fixed eventually". A run succeeds when it **finishes** —
`finish=completed`, the model deciding it is done — in roughly **900 seconds**.

That criterion comes from the numbers. Across the eight-run nudge baseline
(`archive/nudge-4.100.37/`) every run except one reported `aborted` at 5399.8s
having produced 216k-241k output tokens: the same generation rate running until
the wall clock stopped it. Two of those were scored FIXED, but one of the two
was FIXED at 5399.8s, which means the file happened to be in a working state at
the moment of the cut rather than that the model converged. Only run 0007 ended
because the model said so: `completed`, 885.9s, 44,805 tokens.

A fix at 1h54m is a failure by this standard.

## The arm this is testing

0007 is also the only run that checked after every edit — an edit/check ratio of
1.0, against 2.5 to 4.2 for every other run. `EDIT_VERIFICATION=require` imposes
that: the model is not allowed to finish a turn leaving an edit unverified.
Whether that reproduces 0007's ending on purpose is the whole question.

Set it with `EDIT_VERIFICATION=require ./harness.sh`; empty leaves the host's own
default (`nudge`) and passes no flag at all.

## What is under test

| piece | version |
| --- | --- |
| ollama | 0.32.7-thinkbudget, built from `cdc6707e` |
| runtime | stock 0.32.7 ggml + locally built patched `libllama*`/`libmtmd`/`libllama-common`/`libllama-server-impl`. The stock half is byte-identical to 0.32.6's — `LLAMA_CPP_VERSION` is b10242 in both tags and `git diff v0.32.6 v0.32.7 -- llama/ ml/` is empty — so the runtime is not a variable between the two campaigns. |
| model | `v7-coder_tb:vision-iq4_nl` from `modelfile_v7_iq4nl.txt` (`think_budget medium`, `num_ctx 128000`) |
| agent | `@cline/cli` 3.0.49 run from source at `/shared/dev/cline`, build 4.100.38 |

Sampling is deliberately absent from this harness: no temperature, no
`num_predict`, no `num_ctx`. Those belong to the model, and whatever
`ollama show --parameters v7-coder_tb:vision-iq4_nl` reports is what runs.

## Output

```
runs/<timestamp>-NNNN/
  cline.jsonl            the agent event stream (--json)
  cline.log              the runtime's own diagnostics
  cline.stderr
  ollama.log             the server's journal for the run's wall-clock window
  manic_miner.before.html / .after.html
  summary.json           everything the analyser extracted
  exit.txt
verdicts.txt             one line per run
results.jsonl            one summary object per run
```

Run directories are timestamp-first so a name sort is a chronological sort:
index-first would put run 1 of a restarted loop ahead of run 40 of the
previous one, and the prune would then delete the newest runs. The index
itself continues from whatever is already in `runs/`.

The one-line verdict, from the first real run:

```
20260809-101848-0001  PROBLEM  finish=completed iters=27 432.1s
    tools=22 (edit=10 check=0) budget_hits=0 discards=2 retries=0
    js_errors=1 changed=True
```

- `budget_hits` — times the budget message appears in the model's own
  reasoning. A proxy: it counts what survived into the transcript.
- `cuts=N(Lline/Mmid)` — the same event from the server's side, which is the
  authority: `N` blocks cut by the budget, `L` of them landing at the end of a
  line and `M` mid-line after the grace window expired with no newline. `L` is
  the number the line-boundary patch exists to move. The sampler writes three
  wordings for a cut, not two — the bare one means it never had to wait because
  the budget expired on a boundary already — so `budget_forced_immediately`,
  `_after_wait` and `_mid_line` are kept apart in `summary.json` and always sum
  to `budget_forced`.
- `budget_hits` and `cuts` can disagree: the FIXED run of 2026-08-10 shows
  `budget_hits=6 cuts=7(4line/3mid)`, so one cut left no message in the
  transcript. Trust `cuts`.
- `discards` / `retries` — the output-limit ladder: turns cut off at the
  output cap, and turns retried on a halved cap.
- `js_errors` — every `<script>` block in the resulting HTML run through
  `node --check`. This is the one that matters: a run is not successful
  because it ended cleanly, it is successful because the file still parses.
  The failure this harness was built for was sixteen problems in the file
  after four unchecked edits.
- `changed` — whether the agent modified the file at all.

## Known limitation of this host

`check_calls` is always 0 and `edited_without_check` always true, and neither
is a finding. `check_file` is a VS Code extension tool; the CLI host does not
ship it, so the edit-verification guard has no checker to name and correctly
stands aside. Exercising that guard needs the extension, not this harness.
What this harness *can* measure is the thinking budget, the output-limit
ladder, the condenser, and whether the edits leave valid JavaScript behind.

Only the last 40 runs keep their `state/` directory; the logs and summaries of
older runs are kept.

## Server logging

`/etc/systemd/system/ollama.service.d/zz-debug-harness.conf` turns on
`OLLAMA_DEBUG=1`, without which `done_reason`, eval counts and the
reasoning-budget transitions never reach the journal. The `zz-` prefix is
load-bearing: drop-ins are read in name order and `override.conf` sets
`OLLAMA_DEBUG=0`, so anything sorting earlier is overwritten.

Remove that file and `systemctl daemon-reload && systemctl restart ollama` to
go back to quiet logging.
