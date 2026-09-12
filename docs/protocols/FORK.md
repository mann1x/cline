# mann1x/cline — what this fork is

A fork of [cline/cline](https://github.com/cline/cline) maintained for one
purpose: making coding agents work with **local and small models**, and
measuring whether the changes actually help. Upstream optimises for frontier
models on hosted APIs. Much of what this fork adds exists because a 27B model on
an Ollama endpoint fails in ways a frontier model does not, and fails silently.

As of 2026-09-11: **438 commits ahead of `upstream/main`, 5 behind.**

## Identity

| | |
|---|---|
| Extension id | `saoudrizwan.claude-dev` — **unchanged from upstream**, deliberately |
| Display name | `Cline (mann1x build)` |
| Versioning | `4.100.x`, incremented per build; not aligned with upstream's numbering |
| Distribution | GitHub releases on `mann1x/cline` with the `.vsix` attached. **Never the marketplace.** |

Keeping the upstream extension id means installing a build **replaces** an
upstream Cline install rather than sitting beside it. That is intended — the
test host runs one Cline — but it is why `--force` is always needed and why the
display name says which build you have.

## Branches

| branch | role |
|---|---|
| `mann1x/full-build-release` | **where releases are cut.** The integration branch; the build tree sits here. |
| `main` | what the raw-URL tools fetch. Merge into it when a change must reach them; it has sat hundreds of commits behind. |
| `mann1x/scan-analysis` | what the **harness worktree** runs. A consumer of releases, not their source. |
| `mann1x/<topic>` | one per piece of work — `check-file-tool`, `code-intel-tool`, `compaction-trigger`, ~30 of them. |

Releases came from `mann1x/scan-analysis` in the 4.100.4x/5x line. They do not
any more; every tag since v4.100.79 is on `mann1x/full-build-release`. If a note
or a memory says otherwise, it is out of date — `git branch -a --contains <tag>`
settles it.

## Trees on solidPC

All **linked worktrees of one repository**, which is why a branch cannot be
checked out twice and why building in one does not disturb another:

| path | branch | role |
|---|---|---|
| `/srv/dev-disk-by-label-opt/dev/cline` | `mann1x/full-build-release` | the build tree |
| `/srv/dev-disk-by-label-opt/dev/cline-scan` | (scan-analysis lineage) | **the harness tree — never build here** |
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
one-file question does not trigger a project build), `code_intel` (LSP
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
loop that scores whether an agent fixed it. It is how a change here is judged;
`.../spool/manic-harness/native.sh` loads the CLI from **`apps/cli/src/index.ts`
in the harness tree at the start of every run**, which is the reason for the
never-build-there rule.

Do not "fix" `run_game.js` or `smoke.js`. They are the campaign constant — the
experiment is only comparable because they do not change.

## Building and releasing

See **[`BUILD-RELEASE-DEPLOY.md`](./BUILD-RELEASE-DEPLOY.md)**. Note that
`.claude/commands/release.md` in this repo is **upstream's** marketplace
workflow and does not apply.

## Staying current with upstream

`upstream/main` is a real remote and the fork is 5 behind it today. Merges are
occasional and deliberate: the surface this fork changes — system prompt, tool
descriptions, provider config, the agent loop — is exactly the surface upstream
edits most, so a merge is a review, not a fast-forward.
