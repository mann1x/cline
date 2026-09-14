# mann1x/cline — what this fork is

A fork of [cline/cline](https://github.com/cline/cline) maintained for one
purpose: making coding agents work with **local and small models**, and
measuring whether the changes actually help. Upstream optimises for frontier
models on hosted APIs. Much of what this fork adds exists because a 27B model on
an Ollama endpoint fails in ways a frontier model does not, and fails silently.

As of 2026-09-14: **570 commits ahead of `upstream/main`, 88 behind.**

## Identity

| | |
|---|---|
| Extension id | `mann1x.cerebriline` |
| Display name | `Cerebriline` |
| Artefact | `cerebriline-<version>.vsix` |
| Data directory | `~/.cerebriline`, falling back to `~/.cline` when that exists and the new one does not |
| Versioning | `4.100.x`, incremented per build; not aligned with upstream's numbering |
| Distribution | GitHub releases on `mann1x/cline` with the `.vsix` attached. **Never the marketplace.** |

The extension id was `saoudrizwan.claude-dev` until 4.100.112 — upstream's own,
so a build *replaced* an upstream Cline install rather than sitting beside it.
Since the rename the two coexist, which is why `tools/Migrate-ToCerebriline.ps1`
exists: it moves an existing install's data across rather than leaving a user
with two agents and one history. Releases before v4.100.112 carry the old
artefact name `cline-mann1x-<version>.vsix`.

## Branches

| branch | role |
|---|---|
| `main` | **the trunk.** Everything that is not a running experiment's output: the extension, the CLI, the SDK, the docs, `tools/`, `harness/`. The default branch, so it is also what a browser and every raw-URL fetch sees. |
| `mann1x/full-build-release` | **where releases are cut.** Fast-forwarded from `main` at release time and tagged there. It exists so a tag is never taken from a moving trunk, not as a second place to develop. |
| `mann1x/scan-analysis` | the **plugin build the harness runs**. A version pin, not a fork of content — it holds no commits `main` does not. It exists so an experiment can keep running one release while the trunk moves to the next. |
| `mann1x/<topic>` | one per piece of work — `check-file-tool`, `code-intel-tool`, `compaction-trigger`, ~30 of them. Also where an upstream sync is resolved. |

**This changed on 2026-09-14.** `main` had been left behind at 4.100.80 while
the work went to `mann1x/full-build-release`, so the repo a visitor saw was a
pre-rename Cline fork and `tools/Migrate-ToCerebriline.ps1` — shipped as a
release asset since v4.100.112 — was not in the tree at all. `main` was
fast-forwarded 137 commits onto the release branch's tip; nothing was lost, the
old tip is an ancestor. If a note or a memory says releases come from
`mann1x/scan-analysis`, or that `main` is only for raw-URL tools, it is out of
date — `git branch -a --contains <tag>` settles where a tag actually is.

## Trees on solidPC

All **linked worktrees of one repository**, which is why a branch cannot be
checked out twice and why building in one does not disturb another:

| path | branch | role |
|---|---|---|
| `/srv/dev-disk-by-label-opt/dev/cline` | `main` | the build and development tree |
| `/srv/dev-disk-by-label-opt/dev/cline-scan` | (scan-analysis lineage, often detached at the pinned build) | **the harness tree — never build here** |
| `.../spool/cline-parity` | `mann1x/cli-parity` | CLI/extension parity checks |

`/shared/dev/cline` and `/shared/dev/cline-scan` are symlinks to the first two.
A path starting `/shared/dev/` in an old note means the same tree.

## Hosts

| host | role |
|---|---|
| **solidPC** | this machine. Build tree, harness driver, the `manic_miner` experiment loop. GPU0 (RTX 3090) is for benches and should otherwise stay idle. |
| **pandorum** | Windows test host. Runs the VS Code extension. `ssh` lands in `cmd`, so wrap in `powershell -NoProfile -Command`. Never run the ollama CLI here — it takes the desktop-app path and can take the running server with it. |
| **eleven2go** | the model endpoint the harness arms run against (`:11434`). |

## What the fork adds, and why

Grouped by the failure each one answers. This is the part worth knowing before
changing anything — most of these exist because a measurement said so.

**Tools the model was hand-rolling in the shell.** `check_file` (a linter, so a
one-file question does not trigger a project build), `ask_lsp` (LSP
operations, so "where is this defined" is not a `grep` plus four file reads),
`list_files`, `browser`, a delimiter scan that names the unbalanced line.

**Prompt templates per model family.** Upstream has one system prompt. This fork
ships a template per family, each **written by a model of that family** against
the prompt it would really receive, then audited by gates. See
`sdk/packages/core/src/extensions/config/PROMPT-TEMPLATES.md` and
`prompt-reviews/README.md`. Neither the templating system nor the generator
exists upstream.

**Guards against measured agent failure modes.** A reasoning-loop guard and a
verbatim-repetition nudge; a non-convergence signal counted at turn level; an
unchanged-read ledger (one session re-read a 14 KB file 31 times, ~110k tokens);
a completion nudge; compaction trigger and progress fixes.

**The atomic transaction protocol.** Edits land as a transaction with a readable
base revision, `restore_file`, and an approved completion check — built after
runs were found destroying files with repaired tool calls and declaring success
on files that do not parse.

**Provider and config work for local serving.** Ollama and cloud-tag handling,
per-profile config, a VS Code MCP bridge, capability-list fixes.

## The harness

`manic_miner` — a deliberately broken HTML game, an oracle that runs it, and a
loop that scores whether an agent fixed it. It is how a change here is judged.

**The scripts live in [`harness/`](../../harness/), on `main`.** Read
[`harness/README.md`](../../harness/README.md) first: it is the reference for
the four loops, the arms, the verdicts and what counts as success.

Two halves, deliberately separate:

- **the scripts** — `harness/` in this repo, versioned with everything else.
- **the runs** — `.../spool/manic-harness` on the nvme: `runs-*/`, `work-*/`,
  `verdicts-*.txt`, the archives. 38 GB and growing, and never in git.

`native.sh` loads the CLI from **`apps/cli/src/index.ts` in the harness tree at
the start of every run** (`CLI_DIR`, which every driver pins to
`/shared/dev/cline-scan/apps/cli`). That is the whole reason for the
never-build-there rule, and the reason `mann1x/scan-analysis` exists as a pin:
the trunk can move to the next release while an arm keeps running the last one.

Do not "fix" `run_game.js` or `smoke.js`. They are the campaign constant — the
experiment is only comparable because they do not change.

## Building and releasing

See **[`BUILD-RELEASE-DEPLOY.md`](./BUILD-RELEASE-DEPLOY.md)**. Note that
`.claude/commands/release.md` in this repo is **upstream's** marketplace
workflow and does not apply.

## Staying current with upstream

See **[`UPSTREAM-SYNC.md`](./UPSTREAM-SYNC.md)**. In short: merges are occasional
and deliberate, resolved on a `mann1x/upstream-sync-*` branch rather than on the
trunk, and a merge is a review rather than a fast-forward — the surface this
fork changes is exactly the surface upstream edits most. The rename gives every
sync a small, known conflict set where the answer is always ours, and `bun.lock`
is regenerated rather than merged.
