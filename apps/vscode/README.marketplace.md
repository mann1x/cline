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
Every agent feature, with example prompts, is documented in
[docs/features/agents.mdx](https://github.com/mann1x/cline/blob/main/docs/features/agents.mdx).

**Every agent works in a sandbox.** Every delegated agent (sub-agents, swarm
workers, teammates, configured agents) writes to a private copy-on-write overlay,
and its changes come back to the lead as revisions to review and adopt. Nothing is
applied behind your back. With **Agents can run commands** on, the agent's shell
runs in a native sandbox against that copy: user namespaces with overlayfs on
Linux x64 and arm64 (with a ptrace fallback), APFS clonefile on macOS Apple
Silicon and Intel, and Detours injection on Windows x64. All six launchers are
built and verified on native CI runners and ship in the extension.

Their commands are write-confined by default: an agent can read the machine and
write only its workspace copy and the temp folder, with no setup and no
administrator rights.

**Watch and steer them.** A strip above the chat shows each running agent: its
node, model, current tool, speed and recent activity, with Stop, Restart and Stop
all. Send a message mid-round and the lead answers at once. An agent never fails
on a server restart or refusal. It waits and runs its turn again, and every
agent's report reaches the lead. Token figures say how much of an agent's input
was served from cache and from a shared pool, failed tool calls are counted, and
**Inspect** shows what an agent's model is generating as it generates it.

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

**Media tools: images, audio, video.** Generate an image or edit one in the
workspace, turn speech into text or subtitles, turn text into speech, and
generate a video clip. A session on an opencoti or xOllama server that serves
the media uses that server; otherwise each kind has an endpoint of its own.
Generated images show in the conversation even when the working model is
text-only.

**Document Reader.** PDFs, Office files (current and 97-2003), OpenDocument and
ebooks are read into Markdown with their pictures, and scanned pages are read
with OCR on your machine or by a vision model. Off by default.

**The Library.** Ebooks, manuals, papers, notes and web pages the model can
look things up in, arranged as sections, shelves and books. `search_library`
returns the passages that answer a question with the book and chapter each is
from. Ask the model to act as a librarian and it catalogues your files, skips
duplicates and asks before adding another edition. A long import shows every
file's progress, can be cancelled, and ends with a report of everything left
out. Pictures are described by a model that reads images, and only models
that report a vision capability are offered for it. Keyword search needs
nothing; an embedding model adds search by meaning. Off by default.
[Guide](https://github.com/mann1x/cline/blob/main/docs/features/library.mdx).

**Memory.** Notes the model keeps from one task to the next, in any number of
memories chosen per workspace. `remember`, `recall` and `forget`, and the notes
about each message you send are put beside it automatically. Off by default.
[Guide](https://github.com/mann1x/cline/blob/main/docs/features/memory.mdx).

**Built-in skills.** Sixteen skills ship with the extension, all turned off:
QA and Docker deployment (by Chris), build and run, a test-driven set
(`tdd-wizard` and three more), a spec-driven set after Get Shit Done
(`sdd-wizard` and six more, with the plan kept in a database behind one tool),
and the librarian.
[Guide](https://github.com/mann1x/cline/blob/main/docs/customization/skills.mdx).

**Jev on your own server.** Jev, the outside scoring model, can run from any
endpoint that speaks TypeSafe's Jev API, including Ollama 0.35's
`/v1/systemone` with local decision models, and xOllama.

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
opencoti-llamafile, xOllama) and to hosted providers (Anthropic, OpenAI, Google,
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

## xOllama: councils, media engines and the KV rolling window

**https://github.com/mann1x/xollama**

xOllama is an Ollama fork that runs opencoti as its engine, on Ollama's native
API and its own port (22434). It has a provider of its own here.

- **Council models** deliberate with a planner, researchers, critics and a
  synthesizer, run your tools, and compact their own conversation.
- **PolyKV** shares the system prompt and tools across conversations on models
  that keep pool seats for the client.
- **Media engines** on a model serve the image, audio and video tools with no
  second endpoint, and its `/v1/systemone` serves Jev.
- **The KV rolling window.** When the KV cache does not fit in VRAM, the engine
  keeps part of it in host RAM and streams it through VRAM while the model
  computes, instead of moving model layers to RAM (`kv.rolling_window` in the
  model's configuration).

**What the rolling window buys on a 12 GB card.** A 27B model with a
131,072-token context wants about 12 GiB of video memory, which leaves no room
on a 12 GB card. There are two ways to make it fit in about 10 GiB:

- **Rolling window:** the whole model stays on the GPU. The oldest part of the
  conversation's cache is kept in system RAM and streamed to the GPU as it is
  needed.
- **Layers in RAM:** the usual way. Part of the model (here 10 of its 64 layers)
  runs on the CPU.

| Setup | Video memory used | System RAM used | Fits a 12 GB card |
|---|---|---|---|
| Everything in video memory (the reference) | 11.9 GiB (12,196 MiB) | 0.4 GiB | No |
| Rolling window | 9.9 GiB (10,140 MiB) | 2.2 GiB | Yes |
| 10 of 64 layers in RAM | 10.1 GiB (10,322 MiB) | 2.9 GiB | Yes |

Memory is what the engine holds once the model is loaded, before the first
request. The system RAM of the layers-in-RAM setup includes the 2.1 GiB of the
model file that those layers read.

Speed while answering, in tokens per second, as the conversation grows:

| Conversation size (tokens) | Everything in video memory | Rolling window | 10 of 64 layers in RAM |
|---|---|---|---|
| 8,091 | 89.1 | 88.7 | 5.0 |
| 16,086 | 88.3 | 87.9 | 4.7 |
| 30,486 | 85.4 | 82.8 | 4.5 |
| 45,051 | 83.7 | 75.4 | 4.1 |
| 59,196 | 81.9 | 69.7 | 3.8 |
| 73,841 | 79.3 | 54.4 | 3.6 |
| 88,115 | 78.0 | 42.1 | 3.4 |
| 102,504 | 75.7 | 33.6 | 3.2 |
| 116,821 | 74.0 | 28.3 | 3.1 |
| 126,050 | 73.0 | 24.4 | 3.2 |

- **Short conversations lose nothing.** Up to about 16,000 tokens the rolling
  window is as fast as having everything in video memory.
- **Long conversations slow down gradually.** At 59,000 tokens it is 15% slower
  than the reference, at 126,000 tokens about a third of its speed.
- **It is far faster than the usual way.** With layers in RAM the same model
  answers at 3 to 5 tokens per second at every size. The rolling window is 7 to
  18 times faster while using slightly less video memory.
- **Reading a prompt** runs at 1,892 to 3,111 tokens per second with the rolling
  window, against 2,275 to 3,100 for the reference and 1,375 to 1,682 with
  layers in RAM.

**With the model's built-in drafter.** OmniMerge v6 carries a small helper that
guesses several tokens ahead (MTP), and the engine uses it by default. It makes
answers faster, and it needs video memory of its own, so on the 12 GB budget the
rolling window is in use from the start of the conversation:

| Setup, with the drafter | Video memory used | System RAM used | Fits a 12 GB card |
|---|---|---|---|
| Everything in video memory (the reference) | 13.1 GiB (13,412 MiB) | 0.6 GiB | No |
| Rolling window | 10.7 GiB (10,930 MiB) | 2.9 GiB | Yes |
| 10 of 64 layers in RAM | 11.2 GiB (11,498 MiB) | 3.2 GiB | Yes |

Of that, the drafter takes 751 MiB of video memory in each setup. Speed while
answering, in tokens per second:

| Conversation size (tokens) | Everything in video memory | Rolling window | 10 of 64 layers in RAM |
|---|---|---|---|
| 8,091 | 122.6 | 117.0 | 4.6 |
| 16,086 | 193.9 | 172.6 | 5.5 |
| 30,486 | 144.2 | 125.6 | 23.3 * |
| 45,051 | 153.5 | 120.3 | 4.2 |
| 59,196 | 130.2 | 74.3 | 3.6 |
| 73,841 | 155.5 | 66.0 | 3.9 |
| 88,115 | 117.5 | 55.4 | 3.0 |
| 102,504 | 107.2 | 45.4 | 3.4 |
| 116,821 | 124.8 | 41.2 | 2.6 |
| 126,050 | 103.9 | 42.5 | 3.3 |

\* an outlier reading.

- **The drafter pays on a 12 GB budget too.** With the rolling window the model
  answers at 42 to 173 tokens per second with the drafter, against 24 to 89
  without it.
- **These figures jump around more.** How much the drafter helps depends on the
  text being written, and each row is a single run.

How it was measured: the opencoti engine (the engine xOllama runs), release 0.10.5-c8, 2026-10-04, on an RTX PRO 6000 under CUDA limited to 11,500 MiB
to act as a 12 GB card. Model: Qwen3.8-27B OmniMerge v6 at IQ2_M, cache
quantized to q4_0, 256 tokens generated per row.

On Radeon under Windows, use AMD Software 26.9.2 or later for Vulkan.

## Models

Cerebriline is developed and measured against these models, published by the same author. Each is on Hugging Face and in the Ollama library.

| Model | What it is | Hugging Face | Ollama |
|---|---|---|---|
| **OmniMerge v6** | Qwen3.8-27B merge, vision, with its own MTP drafter head | [weights](https://huggingface.co/ManniX-ITA/Qwen3.8-27B-Omnimerge-v6) · [GGUF with MTP](https://huggingface.co/ManniX-ITA/Qwen3.8-27B-Omnimerge-v6-MTP-GGUF) | [`mannix/omnimerge-v6`](https://ollama.com/mannix/omnimerge-v6) |
| **OmniMerge v4** | Qwen3.6-27B merge, vision | [weights](https://huggingface.co/ManniX-ITA/Qwen3.6-27B-Omnimerge-v4) · [GGUF](https://huggingface.co/ManniX-ITA/Qwen3.6-27B-Omnimerge-v4-GGUF) | [`mannix/omnimerge-v4`](https://ollama.com/mannix/omnimerge-v4) |
| **OmniMerge v4 MTP** | OmniMerge v4 with the MTP drafter head for speculative decoding | [GGUF with MTP](https://huggingface.co/ManniX-ITA/Qwen3.6-27B-Omnimerge-v4-MTP-GGUF) | [`mannix/omnimerge-v4-mtp`](https://ollama.com/mannix/omnimerge-v4-mtp) |
| **JackOD 9B Coder** | Qwen3.5-9B, agentic coding and tool calling | [weights](https://huggingface.co/ManniX-ITA/JackOD-9B-Coder) · [GGUF with MTP](https://huggingface.co/ManniX-ITA/JackOD-9B-Coder-MTP-GGUF) | [`mannix/JackOD-9B-Coder`](https://ollama.com/mannix/JackOD-9B-Coder) |
| **Qwen3.6 27B A3B Coder** | Qwen3.6-35B-A3B mixture of experts, pruned to 27B for coding | [weights](https://huggingface.co/ManniX-ITA/Qwen3.6-27B-A3B-Coder) · [GGUF with MTP](https://huggingface.co/ManniX-ITA/Qwen3.6-27B-A3B-Coder-MTP-GGUF) | [`mannix/qwen3.6-27b-a3b-coder`](https://ollama.com/mannix/qwen3.6-27b-a3b-coder) |
| **Qwen3.6 27B A3B CoderX** | The same pruning, text only | [weights](https://huggingface.co/ManniX-ITA/Qwen3.6-27B-A3B-CoderX) · [GGUF with MTP](https://huggingface.co/ManniX-ITA/Qwen3.6-27B-A3B-CoderX-MTP-GGUF) | [`mannix/qwen3.6-27b-a3b-coderx`](https://ollama.com/mannix/qwen3.6-27b-a3b-coderx) |
| **Ornith 1.5 27B A3B Coder** | Ornith 1.5 mixture of experts, pruned to 27B for coding | [weights](https://huggingface.co/ManniX-ITA/Ornith-1.5-27B-A3B-Coder) · [GGUF with MTP](https://huggingface.co/ManniX-ITA/Ornith-1.5-27B-A3B-Coder-MTP-GGUF) | [`mannix/ornith-1.5-27b-a3b-coder`](https://ollama.com/mannix/ornith-1.5-27b-a3b-coder) |
| **Ornith 1.5 27B A3B CoderX** | The same pruning, text only | [weights](https://huggingface.co/ManniX-ITA/Ornith-1.5-27B-A3B-CoderX) · [GGUF with MTP](https://huggingface.co/ManniX-ITA/Ornith-1.5-27B-A3B-CoderX-MTP-GGUF) | [`mannix/ornith-1.5-27b-a3b-coderx`](https://ollama.com/mannix/ornith-1.5-27b-a3b-coderx) |

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
