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

**Sub-agents across your machines.** Delegate work to agents with their own tools
and context. One `spawn_agent` call can start a whole fan-out: a list of agents,
agents you defined in `.cline/agents`, and shared context loaded once. The Agents
tab holds several **nodes**, each with its own provider, model and priority, and
agents queue for the best node with room. On a PolyKV server, `merge: true` runs
them as a swarm on a snapshot of your context with one merged report.

**Every agent works in a sandbox.** Every delegated agent (sub-agents, swarm
workers, teammates, configured agents) writes to a private copy-on-write overlay,
and its changes come back to the lead as revisions to review and adopt. Nothing is
applied behind your back. With **Agents can run commands** on, the agent's shell
runs in a native sandbox against that copy: user namespaces with overlayfs on
Linux x64 and arm64 (with a ptrace fallback), APFS clonefile on macOS Apple
Silicon and Intel, and Detours injection on Windows x64. All six launchers are
built and verified on native CI runners and ship in the extension.

**Watch and steer them.** A strip above the chat shows each running agent: its
node, model, current tool, speed and recent activity, with Stop, Restart and Stop
all. Send a message mid-round and the lead answers at once. An agent never fails
on a server restart or refusal. It waits and runs its turn again, and every
agent's report reaches the lead.

**Sampling per agent.** Spawn tools take an optional `temperature` and `seed`
(offset per agent in a fan-out); leave them out and the model's sampler applies.

**Compaction Council.** A compaction summary becomes the session, so it is
reviewed before it replaces anything. The writer produces a present-tense replay
that cites tool calls instead of copying them and quotes you verbatim. Two fresh
reviewers each check it against half of the transcript, in parallel. A
synthesizer joins their corrections. It is on by default, costs three extra calls,
and never fails a compaction.

**Escalation to a stronger model, scored by Jev.** When the working model gets
stuck, a stronger expert takes over the edit itself, on the same transaction, and
hands its edits back as revisions. The base model stays live and supervises. The
hand-over is offered only when a struggle detector's counts say so, you approve
it, and you and the expert both see an assessment built from measurements, the
code's complexity and Jev's independent score, next to the model's own account.

**Prompt templates per model family.** Upstream ships one system prompt for every
model. Cerebriline ships a template per family — each one written *by a model of
that family*, against the prompt it would really receive, then checked by audit
gates. A 9B model and a frontier model do not need the same instructions.

**Questions that recommend.** When the model asks you to choose, it marks the
option it would pick and lists it first. Optionally, Jev scores the options.

**Image generation.** Generate images in the conversation, and see them there even
when the working model is text-only.

**Conversation history.** Tag conversations and filter by `#tag`, see what model
and settings a session ran with, and check its size on disk.

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

**Local-serving support.** One output budget on every provider, reasoning replay
chosen per profile, tool calls run as a parallel batch, a context bar
that shows what the tool schemas cost, tools switchable per profile, Ollama's
thinking budget and cloud models, the full sampler on llama.cpp and
opencoti-llamafile with the server's own timings, PolyKV pools on opencoti,
per-profile configuration, and a VS Code MCP bridge.

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

Cerebriline talks to local servers (Ollama, LM Studio, llama.cpp,
opencoti-llamafile) and to hosted providers (Anthropic, OpenAI, Google,
OpenRouter, and more). The point of the fork is that the small local ones work
too, so three local engines get more than a generic OpenAI-compatible client
here.

## Ollama: install the thinking-budget build

The Ollama panel offers a **thinking budget** — a cap on how long the model may
reason before it has to answer — alongside the full sampler (`num_ctx`,
`num_gpu`, `temperature`, `top_k`, `top_p`, penalties, `num_predict`, `stop`).

The budget needs a server that understands it. Stock Ollama accepts unknown
request options and silently drops them, so on a stock build the control changes
nothing, says nothing, and the model reasons for as long as it likes. Long
reasoning on a small model is the single most common reason a task never
finishes.

Install the thinking-budget build of Ollama from the fork:

**https://github.com/mann1x/ollama/releases/latest**

It is ordinary Ollama with the budget sampler added — same models, same API, same
`OLLAMA_HOST`; nothing needs re-importing. Take the binary for your platform, and
on Windows and Linux take the matching **runtime** archive from the same release:
the sampler lives in the runtime libraries, and a binary paired with the stock
runtime will fail to start or quietly lose the budget.

Everything else in the Ollama panel works on stock Ollama. Only the thinking
budget requires this build.

## llama.cpp: the server's own numbers

A `llama-server` is configured through the **OpenAI Compatible** provider —
point it at `http://localhost:8080/v1` and set Context Window to whatever you
started the server with, because nothing probes it for you.

What this fork adds there is llama.cpp's own measurements. The server returns a
`timings` object that a standard OpenAI client throws away; Cerebriline keeps it
and shows, per request, the prompt and generation split the server measured,
how much of the prompt it served from its KV cache, and — if you run a draft
model — how many speculative tokens were accepted. Turn on **Show request
timings**; it is off by default. Set **Parallel Sessions** to match the server's
`--parallel`.

## opencoti-llamafile: PolyKV pools and agentic serving

**https://huggingface.co/ManniX-ITA/opencoti-llamafile**

opencoti-llamafile is a single-file inference engine from the
[opencoti](https://github.com/mann1x/opencoti) project: a llamafile base
carrying the opencoti patch series — PolyKV shared-prefix KV pools with a REST
control plane, KV residency and quantization, a rolling KV window that spills to
host RAM, elastic multi-session serving behind an admission gate, DCA long
context, MTP speculative decode, CUDA and Vulkan backends. One executable, no
runtime to install, nothing to import.

It has a provider of its own, with no API key. It uses the same form as llama.cpp
(timings, sampler, thinking budget) plus a **PolyKV** section. In the CLI:

```bash
cline auth --provider opencoti --modelid <model> --baseurl http://localhost:8080/v1
```

On that provider the system prompt and tool schemas are held once on the server
for every conversation, and each delegated agent runs in a shared tree of pools,
so fifty agents fit in one window. **Book a context window** guarantees the
context size, and a reopened conversation gets the same window back or a **Can't
resume** card instead of a silent truncation. Admission refusals are waited out,
and a server restart is detected and recovered from rather than failing the turn.

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
