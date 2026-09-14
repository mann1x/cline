<p align="center">
  <img src="https://raw.githubusercontent.com/mann1x/cline/main/apps/vscode/assets/icons/icon.png" width="96" alt="Cerebriline" />
</p>

<h1 align="center">Cerebriline</h1>

<p align="center">
An autonomous coding agent for your IDE — a fork of <a href="https://github.com/cline/cline">Cline</a>
built for <strong>local and small models</strong>.
</p>

---

Cerebriline creates and edits files, runs commands, and uses tools with your
approval at every step. It keeps everything that makes Cline good, and adds the
machinery a smaller model needs to actually finish the job.

Most of what follows exists because a measurement said so: the fork ships with a
benchmark harness that scores whether a change actually helped, and features that
did not help were removed.

## What it adds over Cline

**Prompt templates per model family.** Upstream ships one system prompt for every
model. Cerebriline ships a template per family — each one written *by a model of
that family*, against the prompt it would really receive, then checked by audit
gates. A 9B model and a frontier model do not need the same instructions.

**Escalation to a stronger model.** When the working model gets stuck, a stronger
expert can be brought in on the same transaction, make the edits, and hand back —
while the base model stays live and supervises rather than sitting blocked.

**Sub-agents.** Delegate a self-contained piece of work to a separate agent with
its own tools and context, and get the result back without spending the main
conversation's window on it.

**Image generation.** Generate images directly in the conversation.

**An atomic transaction protocol.** Edits land as a transaction with a readable
base revision, a `restore_file` escape hatch, and an approved completion check.
Built after runs were caught destroying files with malformed tool calls and
declaring success on files that did not parse.

**Tools instead of shell guesswork.** `check_file` (lint one file without
triggering a project build), `ask_lsp` (go-to-definition instead of a grep plus
four file reads), `list_files`, `browser`, and a delimiter scan that names the
unbalanced line.

**Guards against measured failure modes.** A reasoning-loop guard, a
verbatim-repetition nudge, a turn-level non-convergence signal, and an
unchanged-read ledger — one observed session re-read the same 14 KB file 31
times, burning roughly 110k tokens.

**Local-serving support.** Ollama and cloud-tag handling, per-profile
configuration, a VS Code MCP bridge, and capability-list fixes.

## Install

From the Open VSX Registry, in VSCodium, Cursor, Windsurf, Gitpod, or any editor
that uses it:

```
ext install mann1x.cerebriline
```

For stock VS Code, download the `.vsix` from the
[latest release](https://github.com/mann1x/cline/releases/latest) and install it
with **Extensions: Install from VSIX…**, or:

```
code --install-extension cerebriline-<version>.vsix
```

## Staying up to date

VS Code only auto-updates extensions it installed from a gallery, so a `.vsix`
install is never re-checked on its own. Cerebriline therefore checks for itself:
once a day it looks at the latest release, and the download is verified against
the SHA-256 published with that release before anything is installed.

**Settings → General → Check for Updates**

| | |
|---|---|
| **Off** | never check; install a `.vsix` yourself |
| **Notify** *(default)* | check daily and tell you; nothing downloads until you say so |
| **Auto** | install a newer release as soon as it is found, then offer to reload |

If you installed from Open VSX your editor already keeps it current, and this
check will simply find nothing to report.

## Works with any model

Cerebriline talks to local servers (Ollama, LM Studio, llama.cpp) and to hosted
providers (Anthropic, OpenAI, Google, OpenRouter, and more). The point of the
fork is that the small local ones work too.

## Not affiliated with Cline

Cerebriline is an independent fork published by [mann1x](https://github.com/mann1x).
It is not the official Cline extension, is not published by Cline Bot Inc., and
is not supported by them. For upstream Cline, see
[cline/cline](https://github.com/cline/cline).

Source: [github.com/mann1x/cline](https://github.com/mann1x/cline) ·
Issues: [github.com/mann1x/cline/issues](https://github.com/mann1x/cline/issues)

## License

[Apache 2.0](https://github.com/mann1x/cline/blob/main/LICENSE) © 2026 Cline Bot Inc.
Modifications © 2026 mann1x.
