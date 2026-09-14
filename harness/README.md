# manic_miner loop harness

Asks the same question of the same broken file, over and over, and writes down
what happened each time:

> check manic_miner.html, it's not working. Run `node run_game.js
> manic_miner.html` to see whether it actually works — it loads the page, starts
> the game and pumps animation frames, and prints what went wrong.

The file is restored from `manic_miner_1TESTSOURCE.html` before every run and
each run gets its own `--data-dir`, so run N measures the agent rather than what
run N-1 left behind.

**Last updated 2026-09-14.** The version of this file describing the original
`harness.sh` only is kept as `README-harness-sh-20260811.md`; parts of it are
stale (paths, model, build) but its reasoning about *what counts as success* is
not, and is summarised below.

**The scripts live here, in the repository, on `main`.** They were untracked
for the first month of the campaign, which is exactly how the report collector
and the migration tool each went stale without anyone noticing. The runs do
not live here and never will — see *Where this lives*.

---

## The four loops

Four scripts, all asking the same question of the same file. They differ in who
runs the protocol and how many models are in the room. Each has its own
`runs-*/`, `work-*/`, `verdicts-*.txt` and `results-*.jsonl`, so they never
collide — but they share the GPU and the endpoint, so **only one runs at a
time**.

| script | what it is | runs |
|---|---|---|
| `native.sh` | the plugin runs the change protocol itself. **The current line of work.** | `runs-native/` (300) |
| `atomic.sh` | the change protocol implemented *in bash*: one CLI session per transaction, this script keeps the ledger and rolls back | `runs-atomic/` (21) |
| `teams.sh` | `native.sh` plus teammates — can a model that cannot do it alone do it by delegating | `runs-teams/` (6) |
| `harness.sh` | the original: ask, let it work until it stops or the clock does, analyse | see the old README |

`runs-discarded/` and `runs-abandoned-*/` are exactly that — kept, not deleted,
and not to be read as arms.

## Running

```sh
./native.sh 5                      # five runs
ARM=manual MODEL=… ./native.sh 1   # one run of a named arm
```

Launch through a **driver script** (`go-*.sh`) rather than by hand. A driver
gates on everything that has silently invalidated an arm before: the tag is
present, the tag's `RENDERER`/`PARSER`/`TEMPLATE` are intact, the sampler JSON
parses, the model is *fully* GPU-resident, the lane is free, and — if an expert
is configured — that the expert actually answers. `go-jackod4ac-manual-e2g.sh`
is the current example and the one to copy.

**Stopping.** `touch STOP-NATIVE`. The run in flight finishes and is analysed,
then the loop ends. The stop file is checked *between* runs, so it will not
abort one already started.

Killing instead is a last resort, and the order matters: **loop, then driver,
then the run's own `timeout` process**. The `bun` process survives its parent
and will keep the GPU busy with nothing left to write its analysis. Kill by
exact PID — `pkill -f native.sh` also matches the shell you typed it in.

**Never edit a running loop script.** bash reads the script as it goes, and a
running one holds its own open inode: an edit takes effect on the *next*
invocation, not this one. Install with `mv`, and **`stat` the result** — an
`mv`-based install does not carry the file's mode, which is how all four
scripts silently lost `+x` on 2026-09-13.

**Never rebuild `@cline/core` while a run is in flight.** The CLI reads `dist/`,
so a run started on one build can finish on another.

## The arms — `native.sh`

`ARM=` picks what decides whether a transaction is kept. The workspace, the
prompt, the model and the file are identical across all of them.

| arm | `--atomic` | the check | what it measures |
|---|---|---|---|
| `oracle` | `auto` | run_game.js, handed to the protocol | the baseline; every run before 0076 |
| `self` | `always` | the model's own account | what the extension did before 4.100.62 |
| `proposed` | `always` | the model names it, CLI auto-approves | the extension's flow, minus the user |
| `rethink` | `always` | as `proposed`, but a never-passing check may be replaced once | whether the freeze is the problem |
| `manual` | **`off`** | **none — the harness runs the oracle once, at the end** | **the protocol's absence** |

`manual` (2026-09-13) is the control the other four never had: each of them
measures a variant *of* the protocol, so "the protocol helps" was an assumption
rather than a reading. It is refused if `ATOMIC_MODE` is overridden to anything
but `off`, because that would be the full protocol under a label saying it is
off.

The oracle judges every arm either way. `oracle()` names the command itself and
`ORACLE_EXPECT` is a separate variable, so emptying `ORACLE` stops the check
reaching the **model** and leaves the harness's own reading untouched.

**Note for 4.100.108 and later:** `--atomic` is now `off | static`. `auto`,
`always` and `on` are kept as aliases for `static`, so these arms still run and
their records still read the same — but `auto` and `always` are no longer two
different things.

## The expert (escalation)

`EXPERT_MODEL=` arms the `escalate` path; unset, the CLI closes every escalation
path — the tool is not offered, the struggle detector does not suggest it, the
terminal guards do not force it — so an arm without it is exactly the arm that
ran before the feature existed.

```sh
EXPERT_MODEL=nemotron-3-nano:30b-cloud ./go-jackod4ac-manual-e2g.sh
```

Also `EXPERT_NUM_CTX`, `EXPERT_MAX_ESCALATIONS` (default 3),
`EXPERT_MAX_FOLLOW_UPS` (default 20), `EXPERT_CLOSE_AFTER=yes`.

Two things that will cost you a run if forgotten:

- **The expert shares the session's provider and base URL.** The CLI builds its
  connection from `config.baseUrl` and there is no flag to move it, so the
  expert must be a model the run's own endpoint can serve.
- **A pull is not a probe.** An ollama `-cloud` tag returns
  `{"status":"success"}` from `/api/pull` on a host that is not signed in, and
  then `{"error":"Unauthorized"}` at the first token. Probe with a real
  `/api/generate`.

## What counts as success

Not "the file was fixed eventually". A run succeeds when the **oracle** passes —
and the oracle is run by this script, after the CLI exits, never by the model.

`run_game.js` (installed from `smoke.js`) loads the page, starts the game and
pumps **400** frames, then reports. It exits 0 whether the game works or not, so
the verdict is the *pattern*, not the status:

```
"ok":\s*true.*"frames_run":\s*[1-9][0-9]*.*"reached_playing":\s*true
```

`reached_playing` is load-bearing. The game opens in `COUNTDOWN` and `update()`
returns early for every frame of it; `PLAYING` begins at frame 180. The old
30-frame oracle **never left the countdown**, so `collide()`, the enemy sweeps
and the camera never ran, and a file with `collide` undefined scored
`{"ok":true,"frames_run":30}` and was recorded FIXED. See
`changes-20260911/CHANGES.md` §A.

The oracle is `chmod 444` and its sha256 is recorded at copy time and re-checked
**before** its output is read. 444 blocks an in-place write, not `rm` in a
writable directory — a run that replaces the oracle has graded its own exam and
scores `ABORTED`.

### The four verdicts

| verdict | meaning |
|---|---|
| `FIXED` | the oracle passed. Outranks the clock — a run that fixes the file in its last minute has fixed the file. |
| `TIMEOUT` | the run hit the wall: `timeout` killed it (124/137), **or** the CLI's own `-t` ended the session from inside and exited **0** at ~`RUN_TIMEOUT`. |
| `ABORTED` | it died without producing one: a non-zero exit that is not the clock (crash, OOM, operator kill → 143), an empty event log, or a replaced oracle. |
| `broken` | the oracle looked at the file and said no. **Nothing else.** |

`broken` used to mean all four. Five "broken" rows in one arm turned out to be
the CLI's own `-t` exiting 0 at 5402s against a 5400s cap, indistinguishable
from a verdict.

**`verdicts-native.txt` carries lowercase `broken`.** A `grep -o
'verdict=[A-Z]*'` silently drops it and leaves the TIMEOUTs looking like the
whole failure population.

### The older criterion, still worth reading

The original README's standard was **`finish=completed` in roughly 900
seconds** — the model deciding it is done, not the clock deciding for it. It
came from an eight-run baseline where every run but one reported `aborted` at
5399.8s having produced 216k–241k output tokens: the same generation rate
running until the wall stopped it. Two of those scored FIXED, one of them *at*
5399.8s — the file happened to be in a working state at the moment of the cut.
A fix at 1h54m is a failure by that standard, and the `manual` arm exists partly
because two ad-hoc plugin runs met it (28 and 39 minutes) where the oracle arm
did not.

## Output

```
runs-native/<timestamp>-NNNN/
  run.jsonl(.gz)         the agent event stream (--json), accumulated-field stripped
  run.stderr
  build.txt              version, sha, dirty, model, endpoint, arm, limits, expert, oracle_sha
  prompt.txt             the exact prompt sent
  oracle.txt             the harness's own oracle run — the verdict's evidence
  transactions.txt       kept / discarded / empty, from the event stream
  checks.txt             what the model proposed and what was done with it
  escalations.txt        escalate calls, expert replies, what the expert cost
  manic_miner.before.html / .after.html
  auth.log, ollama.log, tmp-scratch.tar.gz
  exit.txt               the one-line verdict
  state/                 archived, then removed — see below
verdicts-native.txt      one line per run
results-native.jsonl     one JSON object per run
```

Run directories are timestamp-first so a name sort is a chronological sort. The
index continues from the highest already on disk.

**`exit.txt` is positional at the front.** `verdict`, the transaction counts,
`wall`, `exit` and `arm` are read by position by the chain scripts and
`tx_watch.py`; the check and escalation fields are appended. Add new fields at
the **end**.

`escalate_calls=0 … expert_configured=no` and `… expert_configured=yes` are
different findings. Without an expert every path is closed silently, so a run
that was never offered one and a run that never needed one produce identical
counts.

### Transcripts and state

**Nothing is pruned.** `run.jsonl` is gzipped once a run falls behind the newest
six (`run.jsonl.gz`, or `TX-NN.jsonl.gz` for the atomic-era runs). A `grep` for
`run.jsonl` finds only the newest six and makes the corpus look deleted — it is
not.

`state/` — the only record of what was actually *sent* (rendered system prompt,
message list, context history) — **used to be `rm -rf`'d** and only 9 of 336
survived. Since 2026-09-13 `archive-state.sh` tars it to
`$ARCHIVE/state/<id>.tar.zst` (default
`/srv/dev-disk-by-uuid-f8b1803e-…/manic-harness-archive`, the 19 TB disk) and
removes the original **only behind a successful, non-empty archive**. ~30x
compression, so a 300-run campaign is well under a gigabyte.

A running loop holds the old script, so that fix only took effect on the next
arm — `archive-sidecar.sh <driver-pid>` covers the gap, archiving with `--keep`
every 180s until the driver exits.

## Where this lives

Two halves, and the split is the point.

**The scripts** — this directory, `harness/` on `main`. Versioned with the
plugin they test, so "which scripts ran that arm" is a `git log` rather than a
guess.

**The runs** — `/srv/dev-disk-by-uuid-92295e2c-…/spool/manic-harness`, on the
nvme, since 2026-08-11. `runs-*/`, `work-*/`, `verdicts-*.txt`,
`results-*.jsonl`, `archive/`, `state*/`: 38 GB and growing, and never in git.
That directory is also where the scripts are **executed** from, beside their
output.

> **Drift warning, 2026-09-14.** Until the spool's copies are replaced by
> symlinks into this directory there are two copies of every script, and the
> one that runs is the spool's. Do not edit only one. The replacement is a
> between-batches job — a running loop holds its own open inode, so swapping a
> script under it is a no-op for the run in flight and a surprise for the next.

The spool used to sit on `backup_models/` — bcache0 over an md2 RAID5 in
writethrough, so no write buffer but its own stripe cache. A run writes ~25 MB
of log per 1000s straight onto that array; on 2026-08-11 md2's stripe cache
filled and the array stopped dispatching for 5.5 hours. The old path is a
symlink, so nothing that remembers it breaks.

## The build under test

`CLI_DIR` decides it, and `build.txt` records what actually ran.

- `/shared/dev/cline-scan/apps/cli` — the campaign checkout, a `git worktree` of
  `/srv/dev-disk-by-label-opt/dev/cline` on the `mann1x/scan-analysis` lineage.
  **Currently `b0e649603`, 4.100.115.** Every driver pins `CLI_DIR` to it, which
  is what lets the trunk move to the next release while an arm keeps running
  this one. That separation is the only reason `mann1x/scan-analysis` exists.
- `/srv/dev-disk-by-label-opt/dev/cline/apps/cli` — `native.sh`'s own default,
  the development tree on `main`, usually dirty. A driver that forgets to set
  `CLI_DIR` runs whatever is half-written there; `build.txt` records
  `dirty=<n>`, and a non-zero count on an arm is a run to discard.

`apps/cli` runs from source but imports the SDK from its **gitignored `dist/`**,
so after any checkout: `bun install` → **`bun run build:sdk`** → smoke with
`bun run apps/cli/src/index.ts --help`. A stale `dist` kills the CLI at import
**and exits 0 while printing the failure** — grep the output, never `$?`.

## Sampling, and who owns it

Sampling used to be deliberately absent here, on the principle that it belongs
to the model and whatever the tag declares is what runs.

**That changed on 2026-09-13.** The sampler and the thinking budget belong to
the *plugin*: the extension's Ollama panel writes them into the provider entry
and what the plugin sends wins field by field over the tag's `PARAMETER` lines.
`OLLAMA_SAMPLING` is that panel — JSON in the gateway's own field names
(`temperature`, `minP`, `repeatLastN`, `repeatPenalty`, `presencePenalty`,
`thinkBudget`) — written to `settings.sampling`, which is the field
`toProviderConfig` actually reads. It is read back after the write and the run
refuses to start if it did not survive. Unset leaves the model's own sampler.

This changes how earlier arms read: ollama resolves the request's own think
level **before** the model's `think_budget` parameter, so `--thinking high` has
been setting the budget to half the context window in every arm, and the tags'
own `think_budget "medium"` never applied to any of them.

## Plugin parity

The harness exists to exercise the plugin, not to be its own thing. These are
the extension's own defaults, carried here deliberately: `--max-changes 6`,
`--task-progress-interval 2`, `maxToolResultChars: 64000` (no CLI flag — patched
into the run's `providers.json` after `auth` and verified per run), compaction
`agentic`, edit-verification `nudge`, `--retries 6`.

**Deliberately not replicated:** `autoApprovalSettings.maxRequests: 20`. The
extension pauses for the user every 20 requests; there is no CLI equivalent and
an unattended batch has nobody to answer, so faking it would hang every run.
This remains a real plugin/harness difference and is the first thing to suspect
if the plugin stalls where the harness does not.

## Change records

Every change to this harness is written down, with backups and revert commands:

- `changes-20260911/CHANGES.md` — the oracle, `native.sh`, the launch
  environment and the model tag, all changed in one afternoon. Boundary run
  `20260911-155111-0213`. **Breaks comparability with everything before it.**
- `changes-20260913/CHANGES.md` — the `manual` arm, the expert wiring, the build
  move to 4.100.108, and the file-mode break. Boundary run
  `20260913-220843-0297`.

Each splits its changes into **behaviour** (what the model does) and **scoring**
(how it is judged), because the first question when a rate moves is which kind
changed.

## Server logging

`/etc/systemd/system/ollama.service.d/zz-debug-harness.conf` sets
`OLLAMA_DEBUG=1`, without which `done_reason`, eval counts and the
reasoning-budget transitions never reach the journal. The `zz-` prefix is
load-bearing: drop-ins are read in name order and `override.conf` sets
`OLLAMA_DEBUG=0`. This applies to the **local** ollama; runs against eleven2go
read its own `server.log` over ssh instead.
