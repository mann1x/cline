# Harness changes, 2026-09-13 (evening)

Everything altered between 22:00 and 22:10, in the order it was made. The
**boundary run is `20260913-220843-0297`** — the first run with all of it, and
the first `manual` arm ever run.

Same split as `changes-20260911/CHANGES.md`: some changes alter **what the
model does**, some alter only **how it is scored**. Ask which kind moved before
reading anything into a rate.

Backups are in `backups/`. Reverting is `cp` + relaunch.

---

## The reason all of this exists

Arm p01 (jackod4ac 9B, eleven2go, oracle arm, change protocol on) closed at
**1 FIXED / 3 TIMEOUT of 4**, and all three failures closed **zero**
transactions:

```
0292  TIMEOUT  7203s  kept=0 discarded=3 empty=1
0293  FIXED     563s  kept=1
0294  TIMEOUT  7205s  kept=0 discarded=4
0295  TIMEOUT  7203s  kept=0 discarded=1 empty=1
0296  killed mid-flight at 22:00 (this work); no verdict, do not read it
```

Against that, the user ran the same task through the plugin **without** the
change protocol, twice, and it fixed the file both times in **28 and 39
minutes** (user, 2026-09-13):

> the change protocol is not helping. It's making things worse. […] it starts
> messing up much earlier the file and it's unable to recover due to the stress
> of the transactions and continuosly reverting to the original.

The harness could not put that on the same footing, because **every arm it had
measured a variant OF the protocol** — `oracle`, `self`, `proposed` and
`rethink` differ only in what decides whether a transaction is kept. None of
them measured its absence. "The protocol helps" was an assumption, not a
reading. Section B is the arm that tests it.

---

## A. The build under test — `/shared/dev/cline-scan`

| # | change | from | to | kind |
|---|---|---|---|---|
| A1 | harness worktree checkout | `7d465bd84` (4.100.104) | **`1b39e1480` (4.100.108)** | **behaviour** |

54 commits. The worktree is a `git worktree` of
`/srv/dev-disk-by-label-opt/dev/cline` (branch `mann1x/full-build-release`), so
this is a checkout, not a fetch.

`bun.lock` and two `package.json` moved in that range, so the sequence was
`git checkout` → `bun install` → **`bun run build:sdk`** → smoke. `apps/cli`
runs from source but imports the SDK from its gitignored `dist/`, so a checkout
without the build leaves the CLI dying at import — **and it exits 0 while
printing the failure**, so the smoke test greps the output, never `$?`.

**What 4.100.108 brings that matters here:** the `escalate` tool and the whole
escalation path, `--expert-model` and its four budget flags (`ab05c85aa`), the
struggle detector's offer, and the terminal guards. None of it existed in
4.100.104, which is why the escalation arm could not have been run before now.

**One vocabulary change to know about.** `--atomic` is now `off | static`.
`auto`, `always` and `on` are **kept as aliases for `static`** — the CLI's own
comment says it is because the harness passes them — so the four existing arms
are unaffected and their run records still read the same. But `auto` and
`always` are no longer two things: both engage the protocol, which is what
`static` means. The `oracle` arm's `auto` and the `self`/`proposed` arms'
`always` now differ in nothing.

**Revert:** `git -C /shared/dev/cline-scan checkout 7d465bd84 && bun install &&
bun run build:sdk`

---

## B. `native.sh` — the `manual` arm

Backup: `backups/native.sh.bak-pre-manual-20260913-220247` (28,302 bytes,
sha256 `253efa8e…`). Current sha256 `3963c060…`.

| # | change | kind |
|---|---|---|
| B1 | new arm **`manual`**: `ATOMIC_MODE=off`, `PROPOSE_CHECK=""`, `ORACLE=""` | **behaviour** |
| B2 | guard: `ARM=manual` with `ATOMIC_MODE != off` refuses to launch | neither |
| B3 | `EXPERT_MODEL` + four budget variables → the `--expert-*` flags | **behaviour** |
| B4 | `build.txt` records the expert line | scoring |
| B5 | new `escalations.txt` per run, and `expert_configured=` | scoring |
| B6 | `exit.txt` / `verdicts-native.txt` carry the escalation fields | scoring |
| B7 | the launch banner prints `expert=` | scoring |

**B1 — what the arm is.** `--atomic off`. No transactions, no declared changes,
no rollback, and nothing handed to the model that decides whether its work is
kept. The model edits the file and stops when it says it is done; **`native.sh`
then runs the oracle once, and that is the verdict**.

The oracle did not have to be added for this. `oracle()` has always named the
command itself rather than reading `$ORACLE`, and `ORACLE_EXPECT` has always
been a separate variable that the verdict block greps either way — which is why
the `self` and `proposed` arms could already empty `ORACLE` and still be
scored. Emptying `ORACLE` is what stops the check reaching the *model*; the
harness's own reading is untouched. So `manual` is the existing scoring with
the protocol switched off, not a new way of judging.

Verified on run 0297 before it was two minutes old: zero `atomic_transaction`
events, zero `run_check` and `propose_check` calls, and no protocol text
anywhere in the session state.

**B2 — why a guard rather than a coercion.** `ATOMIC_MODE` is overridable per
launch by design, so `ARM=manual ATOMIC_MODE=always` would run the full change
protocol under a label saying it is off — the arm's whole claim, inverted, in
the run record. Which of the two the operator meant is not knowable from here,
so it is refused.

**B3 — the expert's connection is not free to choose.** The CLI builds it from
`config.providerId` / `config.baseUrl` — the **session's** provider and base URL
— and there is no flag to point it anywhere else. The expert must therefore be a
model the run's own endpoint can serve.

Each flag is omitted rather than passed empty: `--expert-model ""` is a model
named `""`, and `--expert-max-escalations`/`--expert-max-follow-ups` have
defaults of 3 and 20 that an empty string would not preserve.

**B5 — why `expert_configured` is a separate field.** A run that never
escalated and a run that was never given an expert produce **identical** event
streams — all zeros. Without an expert the CLI closes every path silently: the
tool is not offered, the struggle detector does not suggest it, the terminal
guards do not force it. So `configured` is read off the CLI's own
`[Escalation] Expert configured` startup line, not off `EXPERT_MODEL`: the
variable says what was asked for, the line says what was built.

The extractor was tested against a synthetic stream (one escalation, two expert
replies, one of them `changed`) and against an empty and a missing file.

**Revert:** `cp backups/native.sh.bak-pre-manual-20260913-220247 ../native.sh &&
chmod 755 ../native.sh`

---

## C. File modes — a latent break, found by hitting it

`native.sh`, `atomic.sh`, `teams.sh` and `harness.sh` were **all `644`**. They
were `755` on 2026-09-11 (see `changes-20260911/backups/`, all `-rwxr-xr-x`)
and lost `+x` in the 20:23 archive-state edit earlier tonight, which wrote new
files rather than editing in place.

Nothing noticed for six hours: the p01 loop started at 15:35 and **a running
bash script holds its own open inode**, so it kept executing the old one. The
first `./native.sh` after that edit failed with `Permission denied` — which was
this arm's first launch attempt, at 22:07.

All four restored to `755`. The failed launch recorded no run and no verdict.

**The lesson is the archive-state one again, from the other side:** an edit that
replaces a script rather than modifying it does not take effect until the next
invocation *and* does not carry the file's mode. Check `stat` after any
`mv`-based install.

---

## D. New driver — `go-jackod4ac-manual-e2g.sh`

One script for both runs of the pair, parameterised by `EXPERT_MODEL`, so the
only difference between them is the escalation path.

Deliberately identical to `go-jackod4ac-p01-e2g.sh`: same host, same tag
(`jackod4ac-9b_tb:q6_k-128k-t08`), same plugin sampler, same oracle, same
7200s cap. **The one thing that moves is the change protocol** — except the
build, which moves with it (A1), so a difference is "protocol off, on the new
build" and not the protocol alone.

Three gates it adds over p01:

- **tag integrity** — `/api/show` must report `template len 13` (ollama
  supplying `{{ .Prompt }}` itself), `RENDERER qwen3.5` and `PARSER qwen3.5`.
  The plugin sampler overrides `PARAMETER` lines but cannot repair a tag whose
  quoted `TEMPLATE` swallowed its directives.
- **expert reachability, by inference and not by a pull** — see E.
- residency, sampler JSON and lane-busy, carried over from p01.

---

## E. eleven2go and ollama cloud — a pull is not a probe

The expert is `nemotron-3-nano:30b-cloud`, an ollama **cloud** tag, and this is
the trap it set at 22:00:

```
eleven2go   /api/pull  nemotron-3-nano:30b-cloud  ->  {"status":"success"}
            /api/generate                         ->  {"error":"Unauthorized"}
```

**A `-cloud` tag resolves its manifest on a host that is not signed in, and
then refuses every token.** The pull is not evidence. The user signed eleven2go
in at 22:05 and it now answers; the driver probes with a real `/api/generate`
and refuses to launch on an error, so this cannot be inherited silently by a
later arm.

The cloud expert holds no local GPU slot, so it does not contend with the
session model and the driver's unload loop does not evict it.

---

## F. What is deliberately NOT changed

- **The struggle detector's thresholds.** `f10 >= 4 AND (distress10 >= 2 OR
  hedging has not decayed) AND iteration >= 20`. Measured alternatives exist and
  were reported; the user's ruling stands: *"better to be conservative. we
  don't want to nudge unnecessarily to escalate."*
- **`MAX_CHANGES` / `MAX_TX`** stay 6 and 6. They are inert with `--atomic off`
  and are still passed, so a `manual` run's `build.txt` reads the same as every
  other arm's and the numbers are not mistaken for an arm difference.
- **`--retries 6`**, the mistake limit. It is the plugin's own value and it is
  what ends most failing runs; changing it here would be a second variable.
- **`autoApprovalSettings.maxRequests: 20`** — still not replicable, still the
  first thing to suspect if the plugin stalls where the harness does not.
