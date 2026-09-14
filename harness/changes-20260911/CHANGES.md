# Harness changes, 2026-09-11

Everything altered between 13:53 and 15:55, in the order it was made. The
**boundary run is `20260911-155111-0213`** — it is the first run that has all of
it. Runs 0207–0212 are partial states and my own kills; do not read them as an
arm.

Two of the four sections change **what the model does**; two change only **how
it is scored**. That distinction is the first question to ask if the numbers
move: a lower FIXED rate after 15:34 may mean nothing changed except that the
oracle stopped lying.

Backups of every file are in `backups/`. Reverting is `cp` + relaunch; no run
has to be rebuilt.

---

## A. The oracle — `smoke.js` (copied to each workspace as `run_game.js`)

Installed 15:33. Backup: `backups/smoke.js.bak-20260911-153236` (7,177 bytes).
Current: 9,906 bytes, sha256 `5da1a77f61c070e214088e34004e3bf5a2b7c72ae2570b609059ba9db3978995`.

| # | change | kind |
|---|---|---|
| A1 | `FRAMES` default **30 -> 400** | scoring |
| A2 | after the pump, probe the context's global lexical scope for `gameState` and `player.frameCount` | scoring |
| A3 | new output fields `state`, `player_frames`, `reached_playing` | scoring |
| A4 | `ok:true` now **requires `reached_playing`** (i.e. `player.frameCount > 0`) | scoring |
| A5 | every error return path emits the same JSON shape | scoring |

**Why.** The game opens in `COUNTDOWN`; `update()` returns early for every frame
of it. `performance.now()` in the sandbox is `framesRun * 16.7` and the
countdown steps once per 1000 ms from 3, so `PLAYING` begins at frame 180 and
the physics first runs at frame **181**. Thirty frames never left the countdown:
`collide()`, the enemy/item sweeps and the camera never executed.

**The evidence.** Run `0208` restored two of the three deleted functions, left
`collide` called-but-undefined, and scored `{"ok":true,"frames_run":30}`. It was
recorded FIXED. Under the new oracle it fails with
`frame 181: ReferenceError: collide is not defined`.

**This breaks comparability with every arm before 2026-09-11 15:34**, which the
user accepted explicitly. The completed pp0 (5/5) and qwen36 (5/5) arms still
have their `manic_miner.after.html` on disk and can be re-adjudicated — see
`adjudicate.py`, which checks the three bindings without touching the oracle.

**Revert:** `cp backups/smoke.js.bak-20260911-153236 ../smoke.js`

---

## B. `native.sh`

| # | change | from | to | kind |
|---|---|---|---|---|
| B1 | `RUN_TIMEOUT` | 5400 | **7200** | scoring |
| B2 | verdict statuses | FIXED / broken | **FIXED / TIMEOUT / ABORTED / broken** | scoring |
| B3 | `MAX_CHANGES` | 3 | **6** | **behaviour** |
| B4 | `ORACLE_EXPECT` | `"ok":\s*true` | `"ok":\s*true.*"frames_run":\s*[1-9][0-9]*.*"reached_playing":\s*true` | scoring |
| B5 | the verdict grep | hardcoded loose pattern | `grep -qE "$ORACLE_EXPECT"` | scoring |
| B6 | `protocol_args` | empty | `--task-progress-interval 2` | **behaviour** |
| B7 | `providers.json`, post-`auth` | unset | `maxToolResultChars: 64000` | **behaviour** |

**B2 — why.** `broken` used to mean three different things. The pp0 arm's five
"broken" rows were all the CLI's own `-t` ending the session from inside and
**exiting 0** at 5402–5405s against a 5400s cap — indistinguishable from a
verdict. TIMEOUT is now `status in (124,137)` **or** `elapsed >= RUN_TIMEOUT-5`;
ABORTED is a non-zero exit that is not the clock (operator kill -> 143) or an
empty event log. A `reason=` goes into `exit.txt` and `abort-reason.txt`.
Ten cases tested in `test-verdict.sh`.

**B3, B6, B7 — why.** The harness exists to exercise the plugin, not to be its
own thing (user, 2026-09-11). These are the extension's own defaults, taken from
pandorum's `globalState.json`. `MAX_CHANGES` was 3 here while every plugin
session said 6, so the two were not running the same protocol.
`maxToolResultChars` has no CLI flag — it is a per-provider field, so it is
patched into the run's `providers.json` after `auth` and verified per run.

**Already equal, listed so nobody re-derives them:** task progress on (CLI
default), compaction `agentic` (CLI default; matches `useAutoCondense:true`),
`editVerification` `nudge` (SDK default).

**Deliberately NOT replicated:** `autoApprovalSettings.maxRequests: 20`. The
extension pauses for the user every 20 requests; there is no CLI equivalent and
an unattended batch has nobody to answer, so faking it would hang every run.
**This remains a real plugin/harness difference** and is the first thing to
suspect if the plugin stalls where the harness does not.

**Revert:** the backups are cumulative snapshots, newest last —
`native.sh.bak-20260911-153353` (pre-B2), `-maxchanges3-154535` (pre-B3),
`-pre-plugindefaults` (pre-B4/B5/B6/B7), `-pre-shaguard-20260911-155535`
(current state).

---

## C. Launch environment — not in any file, passed per launch

| # | variable | default | used |
|---|---|---|---|
| C1 | `CLI_DIR` | `/shared/dev/cline-scan/apps/cli` (4.100.90) | `/srv/dev-disk-by-label-opt/dev/cline/apps/cli` (**4.100.97, 47 dirty**) |
| C2 | `OLLAMA_BASE_URL` | localhost:11434 | `http://eleven2go:11434` |

C1 matters: the default checkout carries none of 4.100.94–.97. `build.txt` in
each run dir records which actually ran. Rebuild it with `bun run build:sdk`
then `bun run build` in `apps/cli` — a stale `dist` exits 0 while shipping the
code you just replaced.

---

## D. The model — `jackod-9b_tb:q6_k-128k` on eleven2go

| # | change | kind |
|---|---|---|
| D1 | repaired a malformed Modelfile: an unterminated `TEMPLATE "` had swallowed `RENDERER`, `PARSER` and 6 of 7 parameters, leaving only `top_k 20` | **behaviour** |
| D2 | added `num_gpu 99` (ollama's estimator refuses layers at 128k on that box) | **behaviour** |
| D3 | `temperature` 0.6 -> **0.7** | **behaviour** |
| D4 | added `repeat_penalty 1.1` | **behaviour** |
| D5 | dropped the `TEMPLATE` directive — **no effect**: with `RENDERER qwen3.5`, ollama supplies `{{ .Prompt }}` itself (`template len = 13`), it does not fall back to the GGUF Jinja | none |

D3/D4 exist to match what pandorum's Cline sends as a client-side override
(`sampling: {temperature: 0.7, repeatPenalty: 1.1}` in `providers.json`). The
tag now carries them, so the harness gets the same effective sampler without a
client override. Final state:

```
temperature 0.7   repeat_penalty 1.1   presence_penalty 1.5
top_k 20   top_p 0.95   num_ctx 131072   num_gpu 99   think_budget medium
```

---

## E. pandorum's workspace — `C:\Users\manni\source\repos\test`

Not the harness, but it is the other half of the comparison. Both were wrong:

- `run_game.js` was the **old 30-frame oracle**. Now byte-identical to the
  harness (sha `5DA1A77F…`).
- `manic_miner.html` was **14,124 bytes, not the 14,127-byte fault source** —
  leftover edits from the 14:09 ornith session, never reset. Every pandorum run
  after the first started from a file a previous model had already modified.
  Now sha `5B6559AB…`, matching `manic_miner_1TESTSOURCE.html`.

Backups alongside as `*.bak-20260911-154006`.

**Still divergent on pandorum, by choice or by necessity:**
`contextWindow: 110000` (user is changing this), the client-side `sampling`
block, the endpoint (pandorum's own RTX 5080 16 GB vs eleven2go), and
`maxRequests: 20`.

**And the prompt.** The harness sends exactly:

```
check manic_miner.html, it's not working. Run `node run_game.js manic_miner.html` to see whether it actually works -- it loads the page, starts the game and pumps animation frames, and prints what went wrong.
```

pandorum's sessions were started with:

```
check manic_miner.html, it's not working
use the linter and lsp (code_intel) tools
I see 12 problems with the linter, browser errors and node does not run it
```

That is not a cosmetic difference — it points the model at the linter and hands
it a finding to chase, instead of at the oracle.

---

## F. Installed 2026-09-11 18:29 — oracle sha guard (`native.sh` B8)

A sha256 integrity check on the workspace oracle. `run_game.js` is `chmod 444`
but `work-native/` is writable, so the file can be unlinked and replaced; 444
blocks in-place writes, not deletion. The guard records the hash at copy time
(`native.sh:186`, and it is written to `build.txt` as `oracle_sha=`) and
re-checks it **before** the expect pattern is read (`native.sh:336`), yielding
`ABORTED` with `oracle replaced:` or `oracle deleted:` on a mismatch. All 202
historical `oracle.txt` files are well-formed, so this has never happened.

**The staged script had a scoping bug and it was installed once before being
caught.** Both sites are inside `run_one()`, and the script also added
`oracle_sha` to the `local since started ended verdict` line at 200 — which runs
*after* the assignment at 186 and shadows it with an empty value, leaving
`[[ -n "${oracle_sha:-}" ]]` false forever. A guard that can never fire. The
installed version declares `local oracle_sha=` at the assignment and leaves the
locals line alone. Proved with `sha-scope-test.sh`: untouched -> verdict stands,
replaced -> ABORTED, deleted -> ABORTED, and the shadowing shape as a negative
control -> a replaced oracle scores FIXED.

---

## G. Cline build — 4.100.98, NOT yet under test

Two protocol changes built after run 0216. **Runs 0213-0215 (jackod) and 0216
(qwen3.6 canary) were all on 4.100.97.** Resuming the jackod arm on .98 makes it
a different arm — rebuild .97 or restart the ten if the comparison matters.

**G1. A second empty submission spends the transaction instead of ending the
run.** `session-protocol.ts`. The first empty submission is still nudged and the
transaction held open. The second used to do `finished = true; return
undefined` — the run stopped with transactions unspent and nothing said about
what had been tried. It now falls through to `controller.settle()`, the same
path a judged discard takes: this transaction closes, the retrospective is
written, and the next opens with the rules in full. A model that submits nothing
every time is stopped by running out of transactions, which is the budget it was
given. `describeEmptyAttempt(_, false)` reworded off "the run is stopping".

**G2. The `plan` tool.** `plan-tool.ts`, wired in `session-protocol.ts`. Carries
the numbered plan across a discarded transaction and generates the
WORKED/DID NOT/RE-USE/DIFFERENT retrospective from the record, so a banked win
is not lost when the transaction that contained it is rolled back. Capped at
`MAX_DECLARATIONS_PER_TRANSACTION = 3` restatements per transaction.

Both have tests with negative controls (18 for the plan tool, 2 for the empty
guard; each fails when the production change is reverted, and nothing else
does).

---

## Bisect order, if the harness starts failing like the plugin

Ask the scoring question first, then walk the behaviour changes. Most likely to
matter at the top:

1. **D3 + D4** — sampling. `temperature 0.7` with `repeat_penalty 1.1` against
   the tag's previous `0.6` with none is the largest single lever here, and it
   is exactly the setting pandorum runs. Revert by rebuilding the tag at 0.6
   with no repeat penalty.
2. **B3** — `MAX_CHANGES` 3 -> 6. Changes the protocol text the model reads
   ("AT MOST 6 changes"). A larger budget invites larger transactions.
3. **B6** — `--task-progress-interval 2`. Three times more re-sent checklist
   text than the CLI's default of 6, at a large context.
4. **B7** — `maxToolResultChars: 64000`. Truncates tool output that was
   previously untruncated.
5. **C2/D2** — endpoint and `num_gpu`. Only if something looks like a resource
   problem rather than a reasoning one.
6. **A1–A5, B4, B5** — scoring only. These cannot change what the model does.
   If the FIXED rate dropped and only these moved, the model did not get worse;
   the oracle stopped passing broken files.
7. **B1** — `RUN_TIMEOUT`. Only bounds the clock.

A cheap first cut before touching anything: re-adjudicate the new runs with
`adjudicate.py`. If the runs that scored `broken` would also have scored broken
under the old oracle, the regression is real behaviour; if they would have
passed, it is A1–A4 doing their job.

---

## H. 2026-09-11 19:05 — both lanes, 4.100.98, two concurrent arms

**H1. The 2nd lane was 4 days stale.** `manic-harness-gemma`'s `native.sh` dated
07 Sep: `MAX_CHANGES=3`, `RUN_TIMEOUT=21600`, the one-condition oracle, the
7,177-byte `smoke.js`, no ABORTED/TIMEOUT, no sha guard. Both lanes now carry the
same `native.sh`, `smoke.js`, `strip-accumulated.py` and seed HTML, verified with
`cmp`. Old files in `manic-harness-gemma/backups-20260911-185634/`.

**H2. `CLI_DIR` now defaults to the build tree** (`/srv/.../dev/cline/apps/cli`)
in both lanes, not `/shared/dev/cline-scan`. The harness runs the CLI from
source, so this is what makes a run measure .98 rather than the committed .90.

**H3. The sha guard's record was being deleted.** It wrote `oracle_sha=` into
`build.txt` immediately before the `{ ... } > "$run_dir/build.txt"` block, whose
redirect truncates. The guard always worked -- it compares a local variable, not
the file -- but nothing was recorded. The echo now comes after the block, proven
on run 0018 of the 2nd lane.

**Arms armed at 19:05, both on 4.100.98:**
  * lane 1, eleven2go -- `qwen36-base-mtp_tb:27b-q4km-128k` x10, the validation
    arm against the 0192-0196 / 0216 baselines.
  * lane 2, solidPC's 3090 (which is GPU0 -- this host has one GPU, so the usual
    "GPU0 stays idle" rule is deliberately suspended) -- `jackod4ac-9b_tb:q6_k-128k`
    x10 against `http://127.0.0.1:11439`.

