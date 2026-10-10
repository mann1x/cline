<p align="center">
  <img src="assets/icons/icon.png" width="80" alt="Cerebriline" />
</p>

<h1 align="center"><b>C</b>erebri<b>line</b></h1>

<p align="center">
The open source coding agent in your IDE and terminal.
</p>

<div align="center">

<div align="center">
<table>
<tbody>
<td align="center">
<a href="#placeholder" target="_blank"><strong>Docs</strong></a>
</td>
<td align="center">
<a href="https://discord.gg/CuE9Jaggp" target="_blank"><strong>Discord</strong></a>
</td>
<td align="center">
<a href="#placeholder" target="_blank"><strong>Feature Requests</strong></a>
</td>
</tbody>
</table>
</div>

</div>

<br>

**A fork of Cline built for local and small models.** The highlights:

- **[Every agent works in a sandbox](#every-agent-works-in-a-sandbox).** Delegated agents edit a private copy-on-write overlay and hand changes back as revisions. Their commands run in a native sandbox on Linux (x64, arm64), macOS (Apple Silicon, Intel) and Windows (x64).
- **[Sub-agents across your machines](#sub-agents-across-your-machines).** Agent nodes with priorities, one queue, swarms on shared KV pools, and rounds that survive a server restart.
- **[Compaction Council](#compaction-council).** Every summary is checked by two reviewers, each holding half the transcript, before it replaces the conversation.
- **[Escalation, scored by Jev](#escalation-to-a-stronger-model-scored-by-jev).** A stronger model takes over the edit when the working model is stuck. The hand-over is offered on measurements and scored by an independent model.
- **[The Library](#the-library) and [Memory](#memory).** Books the model can search, catalogued by a librarian, and notes it keeps from one task to the next.
- **[Built-in skills](#built-in-skills).** Seventeen ship with it: QA and deployment, test-driven and spec-driven development, the librarian and browser automation.
- **[Built for small models](#built-for-small-models).** Per-family prompt templates, one output budget, tolerant tool calls and guards against measured failure modes.

<br>

<div align="center">
<table>
<tr>
<td align="center" width="50%">

### CLI

Run Cerebriline in your terminal.
Interactive chat or fully headless
for CI/CD and scripting.
<!--
```
npm i -g cline
```
-->

<a href="./apps/cli/README.md">Learn more</a>
<br><br>

</td>
</tr>
<tr>
<td align="center" width="50%">

### VS Code Extension

AI coding assistant in your editor.
Create files, run commands, browse the web,
and use tools with human-in-the-loop approval.

<a href="https://marketplace.visualstudio.com/items?itemName=mann1x.cerebriline">Install from VS Marketplace</a>
<br><br>
</td>

</td>
</tr>
</table>
</div>

<div align="center">
<table>
<tr>
<td align="center">

### SDK

Build your own AI agents and integrations powered by the same engine that runs the CLI, Kanban, VS Code extension, and JetBrains plugin. Custom tools, multi-agent teams, connectors, scheduled automations, and more.

<!--
```
npm install @cline/sdk
```
-->

<a href="#placeholder">Documentation</a>
<br><br>

</td>
</tr>
</table>
</div>

---

## Install

There are three ways to get it.

**From the VS Code Marketplace** ([`mann1x.cerebriline`](https://marketplace.visualstudio.com/items?itemName=mann1x.cerebriline)).
In VS Code, search for **Cerebriline** in the Extensions panel, or:

```
code --install-extension mann1x.cerebriline
```

VS Code then keeps it up to date.

**From Open VSX** ([`mann1x.cerebriline`](https://open-vsx.org/extension/mann1x/cerebriline)).
This is the gallery **VSCodium, Cursor, Windsurf and Gitpod** use, so on those
editors Cerebriline installs and updates itself the ordinary way — search for
it in the Extensions panel, or:

```
codium --install-extension mann1x.cerebriline
```

Stock VS Code does not read Open VSX: use the Marketplace above, or the `.vsix` below.

**From the `.vsix`.** Download it from the
[latest release](https://github.com/mann1x/cline/releases/latest) and install:

```
code --install-extension cerebriline-<version>.vsix
```

Or, from VS Code: **Extensions** -> **...** -> **Install from VSIX...**

Then reload the window. Cerebriline appears in the activity bar.

### Staying up to date

VS Code only auto-updates extensions it installed from a gallery, so a `.vsix`
install is never checked again on its own. Cerebriline therefore checks for
itself: once a day it looks at the
[latest release](https://github.com/mann1x/cline/releases/latest), and when
there is a newer one it says so. The download is verified against the SHA-256
published with the release before anything is installed, and nothing installs
without you asking unless you choose **Auto**.

**Settings -> General -> Check for Updates**, with three values:

| | |
|---|---|
| **Off** | never check; install a `.vsix` yourself |
| **Notify** *(default)* | check daily and tell you; nothing is downloaded until you say so |
| **Auto** | check daily and install a newer release as soon as it is found, then offer to reload |

There is also a **Cerebriline: Check for Updates** command for checking on
demand. If you installed from the Marketplace or Open VSX your editor already keeps it current,
and this check will simply find nothing to report.

### Upgrading from the mann1x Cline fork

The fork used to be published under Cline's own extension identity
(`saoudrizwan.claude-dev`) and kept its data in `~/.cline`. It is now
`mann1x.cerebriline`, with its data in `~/.cerebriline`.

VS Code keys an extension's storage on its publisher and name, so as far as VS
Code is concerned this is a *different* extension: installing it leaves the old
one in place beside it, with its own settings and its own storage.

**Your conversations are not lost either way.** If Cerebriline starts and finds
no `~/.cerebriline` but does find `~/.cline`, it keeps using the old directory.
You can install and carry on.

To tidy the layout up properly - move the data across, rename the `cline.*`
settings keys, and remove the old extension - close VS Code and run:

```powershell
# See exactly what would move, and change nothing:
.\Migrate-ToCerebriline.ps1 -WhatIf

# Do it. You are asked whether to back up first; the default is yes:
.\Migrate-ToCerebriline.ps1

# Or answer in advance:
.\Migrate-ToCerebriline.ps1 -Backup      # back up, no question
.\Migrate-ToCerebriline.ps1 -SkipBackup  # do not back up, no question
```

The backup is a full second copy into a timestamped folder in your home
directory, with a `MANIFEST.txt` saying what came from where. It needs as much
room again as your data - on a real install that was 958 MB, nearly all of it
VS Code extension storage.

Close anything looking at these files, not just VS Code. Renaming a folder on
Windows needs every handle inside it closed, and an Explorer preview pane is
enough to block it. If that happens the script names the process holding it and
carries on - your data has already been copied and verified by that point.

`Migrate-ToCerebriline.ps1` is attached to the
[release](https://github.com/mann1x/cline/releases/latest) beside the `.vsix`,
so you do not need a checkout; it is also in the repo at
`tools/Migrate-ToCerebriline.ps1`. If PowerShell refuses to run it, either
unblock it (`Unblock-File .\Migrate-ToCerebriline.ps1`) or run it as
`powershell -ExecutionPolicy Bypass -File .\Migrate-ToCerebriline.ps1`.

Windows PowerShell 5.1 and PowerShell 7 both work, and it needs no admin
rights. It copies first, verifies the copy, and only then renames the original
aside as `*.migrated-<timestamp>` - nothing is deleted, and re-running it is
safe. Delete those folders yourself once you are happy.

It does **not** touch `.cline` folders inside your own projects. That name is
unchanged and still read: it is a convention shared with upstream Cline, so a
repository you work on with other people keeps working for everyone.

## Index

| Product | Description | Location | CHANGELOG |
|---------|------------|--------------|--------------|
| **SDK** | Node.js programmatic agent API and extension exports. | [`sdk/`](#) | [CHANGELOG.md](#) |
| **CLI** | Terminal UI, headless mode, shell commands, and CLI-specific flows. | [`apps/cli/`](#) | [CHANGELOG.md](#) |
| **VS Code Extension** | The Marketplace extension and extension host integration. | [`/`](#) (WIP migrating) | [CHANGELOG.md](#) |
| **JetBrains Plugin** | JetBrains-hosted client that talks to the shared agent core. | Currently we are not open-sourcing JetBrains plugins | - |
| **Kanban** | Web-based multi-agent task board. | [`cline/kanban`](#) | [CHANGELOG.md](#) |
| **Docs site** | Public documentation pages. | [`docs/`](#) | - |

## Edits Code Across Your Project

Cerebriline reads your project structure, understands the relationships between files, and makes coordinated changes across your codebase. It monitors linter and compiler errors as it works, fixing issues like missing imports, type mismatches, and syntax errors before you even see them. In VS Code and JetBrains, every edit shows up as a diff you can review, modify, or revert. All changes are tracked with checkpoints, so you can easily undo the agent's work.

## Runs Bash Commands

Cerebriline executes commands directly in your terminal and watches the output in real time. Install packages, run build scripts, execute tests, deploy applications, manage databases. For long-running processes like dev servers, Cerebriline continues working in the background and reacts to new output as it appears, catching compile errors, test failures, and server crashes as they happen.

## Plan and Act

Toggle between Plan mode and Act mode. In Plan mode, Cerebriline explores your codebase, asks clarifying questions, and lays out a strategy. Once you're aligned, switch to Act mode and Cerebriline executes the plan. Every file edit and terminal command requires your approval, so you stay in control of what actually changes. Or toggle auto-approve and let Cerebriline run autonomously.

## Rules and Skills

Define project-specific rules in `.clinerules` files that guide how Cerebriline works in your codebase: coding standards, architecture conventions, deployment procedures, testing requirements. Rules are picked up automatically by the CLI, VS Code extension, and JetBrains plugin. Use skills to let the model load specific rules when needed.

## Works With Every Model

Cerebriline is not locked to a single AI provider. Use whichever model fits your workflow:

| Provider | Models |
|----------|--------|
| Anthropic | Claude Opus, Sonnet, Haiku |
| OpenAI | GPT series models |
| Google | Gemini series models |
| OpenRouter | 200+ models from any provider |
| Vercel AI Gateway | Route to many providers through one gateway |
| AWS Bedrock | Claude, Llama, and more |
| Azure / GCP Vertex | All hosted models |
| Cerebras / Groq | Fast inference models |
| Ollama / LM Studio | Run local models on your machine |
| llama.cpp | `llama-server`, with the server's own timings read back |
| opencoti-llamafile | Single-file engine with PolyKV agentic KV pools |
| xOllama | Ollama-API server on the opencoti engine: councils, PolyKV, media engines |
| Any OpenAI-compatible API | Self-hosted or third-party endpoints |

### Ollama: install the thinking-budget build

The Ollama panel offers a **thinking budget** — a cap on how long the model may reason before it has to answer — alongside the full sampler (`num_ctx`, `num_gpu`, `temperature`, `top_k`, `top_p`, penalties, `num_predict`, `stop`).

The budget needs a server that understands it. Stock Ollama accepts unknown request options and silently drops them, so on a stock build the control changes nothing, says nothing, and the model reasons for as long as it likes — which is the single most common reason a small model never finishes a task.

Install the thinking-budget build from the fork: **https://github.com/mann1x/ollama/releases/latest**

It is ordinary Ollama with the budget sampler added — same models, same API, same `OLLAMA_HOST`, nothing to re-import. Take the binary for your platform, and on Windows and Linux take the matching **runtime** archive from the same release: the sampler lives in the runtime libraries, and a binary paired with the stock runtime will fail to start or quietly lose the budget.

The panel also reads your Ollama account: the plan you are on and which models are cloud models.

Everything else in the Ollama panel works on stock Ollama. Only the thinking budget requires this build.

### llama.cpp: the server's own numbers

A `llama-server` is configured through the **OpenAI Compatible** provider — point it at `http://localhost:8080/v1` and set Context Window to whatever you started the server with, because nothing probes it for you.

What this fork adds there is llama.cpp's own measurements. The server returns a `timings` object that a standard OpenAI client throws away; Cerebriline keeps it and shows, per request, the prompt and generation split the server measured, how much of the prompt it served from its KV cache, and — if you run a draft model — how many speculative tokens were accepted. Turn on **Show request timings**; it is off by default. Set **Parallel Sessions** to match the server's `--parallel`.

### opencoti-llamafile: PolyKV pools and agentic serving

**https://huggingface.co/ManniX-ITA/opencoti-llamafile**

opencoti-llamafile is a single-file inference engine from the [opencoti](https://github.com/mann1x/opencoti) project: a llamafile base carrying the opencoti patch series — PolyKV shared-prefix KV pools with a REST control plane, KV residency and quantization, a rolling KV window that spills to host RAM, elastic multi-session serving behind an admission gate, DCA long context, MTP speculative decode, CUDA and Vulkan backends. One executable, no runtime to install, nothing to import.

It has a provider of its own in the extension, the CLI and the SDK. It needs no API key. In the extension it uses the same form as llama.cpp (timings, the full sampler and the thinking budget) plus a **PolyKV** section. In the CLI:

```bash
cline auth --provider opencoti --modelid <model> --baseurl http://localhost:8080/v1
```

What the provider does with the engine:

- **Shared prompts.** The system prompt and tool schemas are about a third of the window. They are held once on the server for every conversation, across VS Code windows and the CLI. The per-session parts (date, folder, rules, mode) travel as a turn of their own. A new conversation books its window minus the shared part.
- **Agents in a pool tree.** Each delegated agent is its own engine session, attached to a tree of pools: system prompt and tools, then shared knowledge, then role, then its task. Fifty agents fit in one 262k window. With **Use PolyKV agents as Priority 0** on, up to 8 agents run inside your own session before any agent node is used.
- **Booked windows.** **Book a context window** asks the engine to guarantee the context size, with an optional floor. A reopened conversation asks for exactly the window it had. If the server can't give it back, a **Can't resume** card offers Retry instead of truncating the conversation. The context bar and compaction both size against the window actually granted.
- **Admission and liveness.** An admission refusal is waited out using the server's `Retry-After` instead of failing. Streams use the server's heartbeat, a server silent for 35 s is treated as down, and the server's boot id is checked on every response. After a restart, pools are rebuilt and turns are retried.
- **A status strip** under the PolyKV section shows the server's KV ledger, per-session windows and the admission floors in force.

### xOllama: councils, media engines and the KV rolling window

**https://github.com/mann1x/xollama**

xOllama is an Ollama fork that runs opencoti as its engine. It speaks Ollama's native API on its own port (22434), so it sits beside a stock Ollama. It has a provider of its own here, with its own settings.

- **Council models.** A model the server reports as a council deliberates with a planner, researchers, critics and a synthesizer. Each member's deliberation appears under its own heading in the thinking block. The council runs your tools, with read-only tools marked for researchers and critics so only the synthesizer writes, and it compacts its own conversation.
- **PolyKV on plain models.** On a model that keeps pool seats for the client, conversations share the system prompt and tools through PolyKV, as on opencoti.
- **Media engines.** A model that carries image, audio or video engines serves the [media tools](#media-tools-images-audio-video) with no second endpoint.
- **Jev.** xOllama serves Ollama's `/v1/systemone`, so the Jev tab can point at it and score with a local decision model.
- **The KV rolling window.** When the KV cache does not fit in VRAM, the engine keeps part of it in host RAM and streams it through VRAM while the model computes, instead of moving model layers to RAM. Set `kv.rolling_window` in the model's configuration (`on`, `off`, or a size in MiB). It is the engine's feature, and Cerebriline needs no setting for it.

**What the rolling window buys on a smaller card.** The engine can be given a video memory cap, and the measurements below use one to make a large card behave like a smaller one: 11.5 GB for a 12 GB card, 14.5 GB for a 16 GB card, 21 GB for a 24 GB card. Under the cap the engine keeps as much of the conversation's cache on the GPU as fits — C cells, read from each run's log — and reads the rest from system RAM on every token. The model itself stays on the GPU. Two comparisons are shown:

- **Uncapped:** the same model with all the video memory it wants, the big-card reference.
- **Layers in RAM:** no cap, but enough of the model's layers on the CPU (`-ngl`) to fit the same card, the usual way.

"Below the limit" means the conversation plus the 256 generated tokens fits in C. There the rolling window answers within 2% of uncapped, and its output is identical: the largest difference in any token's log-probability was 0.000000 at 8,000 tokens on the RX 9070 XT, with both cache types. Reading the prompt below the limit can be up to 14% slower. A capped run reads the quantized cache directly instead of converting it to f16, because the conversion buffer would take video memory from C.

Each row is one request: a fresh prompt of the given length, with no prompt cache and the same prompts on every setup, then 256 tokens with greedy decoding. Answering is tokens per second over those 256 tokens, reading is the prompt's prefill speed, and every cell is a single run.

#### RTX PRO 6000 under Linux, as a 12 GB card (cap 11.5 GB): OmniMerge v6 IQ2_M, 27B hybrid

Cache q4_0, CUDA. C = 58,112 cells.

| Conversation (tokens) | Below the limit? | Answering: rolling window | uncapped | layers in RAM | Reading: rolling window | uncapped | layers in RAM |
|---|---|---|---|---|---|---|---|
| 8,185 | yes | 90.4 | 90.7 | 6.8 | 3,030 | 3,057 | 1,730 |
| 30,668 | yes | 86.8 | 87.1 | 6.0 | 2,872 | 2,978 | 1,817 |
| 59,162 | no | 82.5 | 83.1 | 5.3 | 2,554 | 2,719 | 1,711 |
| 88,243 | no | 73.3 | 78.8 | 4.7 | 2,174 | 2,516 | 1,627 |
| 126,373 | no | 40.5 | 73.8 | 4.1 | 1,826 | 2,278 | 1,508 |

Cache q4_0, Vulkan. C = 39,936 cells.

| Conversation (tokens) | Below the limit? | Answering: rolling window | uncapped | Reading: rolling window | uncapped |
|---|---|---|---|---|---|
| 8,185 | yes | 67.4 | 67.3 | 2,168 | 2,174 |
| 30,668 | yes | 63.5 | 63.0 | 1,850 | 1,853 |
| 59,162 | no | 55.7 | 58.7 | 1,441 | 1,525 |
| 88,243 | no | 51.2 | 55.3 | 1,227 | 1,292 |
| 126,373 | no | 32.7 | 50.7 | 1,025 | 1,077 |

Cache KVarN 4-bit, CUDA. C = 61,056 cells. KVarN keeps its records in groups of 128 cells, and its window is flexible: 399 groups (51,072 cells) are the window. While no cell lies past them, the 78 groups the read slots will need stay on the device too, so C is the larger figure of 477 groups. Past it, those groups move to system RAM and their memory becomes the read slots.

| Conversation (tokens) | Below the limit? | Answering: rolling window | uncapped | Reading: rolling window | uncapped |
|---|---|---|---|---|---|
| 8,185 | yes | 90.4 | 90.5 | 2,995 | 2,992 |
| 30,668 | yes | 82.3 | 82.3 | 2,902 | 2,890 |
| 59,162 | yes | 76.5 | 76.6 | 2,585 | 2,575 |
| 88,243 | no | 56.7 | 71.7 | 2,226 | 2,304 |
| 126,373 | no | 34.3 | 64.0 | 1,865 | 2,033 |

Cache KVarN 4-bit, Vulkan. C = 66,048 cells (482 + 34 = 516 groups).

| Conversation (tokens) | Below the limit? | Answering: rolling window | uncapped | Reading: rolling window | uncapped |
|---|---|---|---|---|---|
| 8,185 | yes | 58.5 | 57.9 | 1,538 | 1,534 |
| 30,668 | yes | 41.9 | 41.8 | 1,459 | 1,457 |
| 59,162 | yes | 30.8 | 30.8 | 1,342 | 1,341 |
| 88,243 | no | 20.6 | 24.2 | 1,236 | 1,241 |
| 126,373 | no | 14.5 | 19.1 | 1,115 | 1,127 |

Cache f16, CUDA, as a control. C = 7,680 cells. An f16 cache is four times the bytes of q4_0, so under the same cap only 7,680 cells stay on the GPU, and every token moves four times as much over the link. Use q4_0 or KVarN with the rolling window.

| Conversation (tokens) | Below the limit? | Answering: rolling window | uncapped | Reading: rolling window | uncapped |
|---|---|---|---|---|---|
| 8,185 | no | 91.2 | 92.1 | 3,018 | 3,149 |
| 30,668 | no | 33.6 | 84.7 | 2,669 | 3,101 |
| 59,162 | no | 15.3 | 76.3 | 2,354 | 2,839 |
| 88,243 | no | 9.9 | 69.4 | 2,051 | 2,566 |
| 126,373 | no | 6.7 | 62.0 | 1,735 | 2,241 |

**With the model's built-in drafter.** OmniMerge v6 carries a small helper that guesses several tokens ahead (MTP), and the engine uses it by default. Its own cache stays on the GPU, so under the 11.5 GB cap the model's cache gets 1,536 cells on CUDA and 256 on Vulkan, and the rolling window is in use from the start of the conversation. With the drafter, answering speed follows how many of the guessed tokens are accepted, and that depends on the text being written, which can differ between two runs of the same engine. Compare rows only where the acceptance columns agree. At 59,162 tokens on CUDA the rolling-window run wrote a continuation that repeats the prompt, and the drafter copied it (12.75 tokens accepted per guess against 2.50). That row shows the text, not the engine.

Cache q4_0, CUDA. C = 1,536 cells.

| Conversation (tokens) | Answering: rolling window | uncapped | Reading: rolling window | uncapped | Acceptance (tokens per guess): rolling window | uncapped |
|---|---|---|---|---|---|---|
| 8,185 | 100.3 | 129.9 | 2,148 | 2,638 | 0.55 (2.63) | 0.52 (2.55) |
| 30,668 | 110.7 | 189.2 | 2,086 | 2,573 | 0.97 (3.91) | 0.96 (3.86) |
| 59,162 | 210.8 | 120.0 | 1,911 | 2,319 | 0.97 (12.75) | 0.50 (2.50) |
| 88,243 | 40.5 | 107.5 | 1,757 | 2,115 | 0.48 (2.44) | 0.42 (2.85) |
| 126,373 | 31.6 | 116.2 | 1,584 | 1,896 | 0.48 (2.43) | 0.56 (3.06) |

Cache q4_0, Vulkan. C = 256 cells.

| Conversation (tokens) | Answering: rolling window | uncapped | Reading: rolling window | uncapped | Acceptance (tokens per guess): rolling window | uncapped |
|---|---|---|---|---|---|---|
| 8,185 | 56.1 | 70.5 | 1,716 | 1,992 | 0.54 (2.62) | 0.55 (2.63) |
| 30,668 | 68.1 | 94.2 | 1,563 | 1,715 | 0.96 (3.86) | 0.96 (3.86) |
| 59,162 | 34.9 | 59.3 | 1,347 | 1,409 | 0.49 (2.47) | 0.56 (2.68) |
| 88,243 | 28.6 | 51.8 | 1,155 | 1,193 | 0.48 (2.44) | 0.52 (2.68) |
| 126,373 | 23.3 | 42.7 | 941 | 991 | 0.38 (2.62) | 0.43 (2.54) |

#### RTX PRO 6000 under Linux, as a 16 GB card (cap 14.5 GB): Qwen2.5-14B-Instruct-1M Q6_K

Cache q4_0, CUDA. C = 41,984 cells.

| Conversation (tokens) | Below the limit? | Answering: rolling window | uncapped | layers in RAM | Reading: rolling window | uncapped | layers in RAM |
|---|---|---|---|---|---|---|---|
| 8,058 | yes | 91.4 | 91.3 | 12.9 | 5,325 | 5,595 | 2,169 |
| 30,144 | yes | 80.2 | 80.1 | 5.4 | 3,616 | 4,203 | 1,895 |
| 49,913 | no | 70.0 | 73.2 | 3.7 | 2,702 | 3,261 | 1,648 |
| 70,099 | no | 35.9 | 66.6 | 2.6 | 2,125 | 2,664 | 1,468 |
| 88,206 | no | 21.3 | 61.6 | 1.9 | 1,792 | 2,290 | 1,330 |

Cache q4_0, Vulkan. C = 36,608 cells.

| Conversation (tokens) | Below the limit? | Answering: rolling window | uncapped | Reading: rolling window | uncapped |
|---|---|---|---|---|---|
| 8,058 | yes | 84.6 | 86.1 | 4,988 | 5,039 |
| 30,144 | yes | 72.7 | 73.2 | 3,722 | 3,729 |
| 49,913 | no | 57.6 | 64.9 | 2,649 | 2,998 |
| 70,099 | no | 29.1 | 58.0 | 2,013 | 2,493 |
| 88,206 | no | 18.8 | 53.0 | 1,674 | 2,167 |

#### RTX PRO 6000 under Linux, as a 24 GB card (cap 21 GB): Gemma 4 31B Q4_K_M

Gemma 4 has two caches. The sliding-window layers' cache stays on the GPU in full, and C is the global-attention layers' cache.

Cache q4_0, CUDA. C = 16,640 cells.

| Conversation (tokens) | Below the limit? | Answering: rolling window | uncapped | layers in RAM | Reading: rolling window | uncapped | layers in RAM |
|---|---|---|---|---|---|---|---|
| 7,216 | yes | 52.6 | 52.6 | 10.5 | 3,104 | 3,122 | 1,097 |
| 27,075 | no | 48.7 | 50.4 | 8.2 | 2,651 | 2,885 | 1,103 |
| 45,032 | no | 45.1 | 48.6 | 6.9 | 2,312 | 2,610 | 1,066 |
| 63,017 | no | 41.7 | 46.9 | 6.0 | 2,030 | 2,393 | 973 |
| 79,275 | no | 34.5 | 45.7 | 5.3 | 1,822 | 2,223 | 987 |

Cache q4_0, Vulkan. C = 256 cells: under this cap on Vulkan the global layers' budget holds only 256 cells, so the rolling window is in use from the first token.

| Conversation (tokens) | Below the limit? | Answering: rolling window | uncapped | Reading: rolling window | uncapped |
|---|---|---|---|---|---|
| 7,216 | no | 50.4 | 51.9 | 1,978 | 2,258 |
| 27,075 | no | 47.9 | 50.2 | 1,517 | 1,597 |
| 45,032 | no | 45.2 | 48.7 | 1,173 | 1,245 |
| 63,017 | no | 36.0 | 47.0 | 952 | 1,015 |
| 79,275 | no | 28.9 | 46.0 | 811 | 869 |

#### RX 9070 XT (16 GB) under Windows 11, Vulkan, as a 12 GB card (cap 11.5 GB): OmniMerge v6 IQ2_M

The same model and cap as above, on an AMD card. Under the same cap less is left for the cache here (1,293 MiB free after loading, against 1,788 MiB on the RTX PRO 6000 with CUDA), so far less of it stays on the GPU.

Cache q4_0. C = 9,728 cells.

| Conversation (tokens) | Below the limit? | Answering: rolling window | uncapped | layers in RAM | Reading: rolling window | uncapped | layers in RAM |
|---|---|---|---|---|---|---|---|
| 8,185 | yes | 36.5 | 36.4 | 6.8 | 747 | 744 | 581 |
| 30,668 | no | 33.6 | 34.6 | 6.1 | 611 | 640 | 530 |
| 59,162 | no | 31.6 | 32.7 | 5.4 | 508 | 541 | 460 |
| 88,243 | no | 29.3 | 30.7 | 4.8 | 433 | 467 | 406 |
| 126,373 | no | 23.8 | 28.6 | 4.2 | 364 | 395 | 350 |

Cache KVarN 4-bit. C = 29,696 cells (179 groups in the window, plus 53 for the read slots while no cell lies past them).

| Conversation (tokens) | Below the limit? | Answering: rolling window | uncapped | Reading: rolling window | uncapped |
|---|---|---|---|---|---|
| 8,185 | yes | 33.8 | 33.8 | 721 | 722 |
| 30,668 | no | 23.3 | 24.7 | 666 | 671 |
| 59,162 | no | 15.8 | 19.4 | 603 | 609 |
| 88,243 | no | 11.9 | 15.9 | 550 | 557 |
| 126,373 | no | 9.1 | 13.0 | 491 | 498 |

What the tables say:

- **Below the limit the rolling window costs nothing.** Answering is within 2% of the uncapped card, and the output is the same.
- **Past the limit it slows gradually.** OmniMerge v6 with a q4_0 cache under CUDA answers at 82.5 tokens per second at 59,000 tokens (uncapped: 83.1) and at 40.5 at 126,000 tokens (uncapped: 73.8).
- **It is far faster than the usual way.** Against layers in RAM on the same budget, the rolling window answers 10 to 16 times faster for OmniMerge v6 and 7 to 19 times faster for the 14B under CUDA, 5 to 7 times faster for Gemma 4, and 5 to 6 times faster on the RX 9070 XT.
- **Quantize the cache.** With an f16 cache the cap leaves only 7,680 cells, and answering falls to 6.7 tokens per second at 126,000 tokens, against 40.5 with q4_0.

How it was measured: the opencoti engine (the engine xOllama runs), release 0.10.5-c10, 2026-10-07. On the RTX PRO 6000 (PCIe 5.0): the development engine 2610071819001 with the published libraries. On the RX 9070 XT (PCIe 5.0 x16, Windows 11): the c10 release engine 2610072136001. Both are the same source apart from the version line. The same tables are in the release's [USAGE.md §3.3](https://huggingface.co/ManniX-ITA/opencoti-llamafile/blob/main/USAGE.md).

On Radeon under Windows, use AMD Software 26.9.2 or later for Vulkan.

## Extend With Plugins or MCP Servers

Extend Cerebriline's capabilities with plugins. Using the SDK, register tools and lifecycle hooks programmatically through the plugin system for logging, auditing, policy enforcement, or adding domain-specific capabilities. Simple plugin example below.

```typescript
import { Agent, createTool } from "@cline/sdk"

const deployTool = createTool({
  name: "deploy",
  description: "Deploy the current branch to staging.",
  inputSchema: { type: "object", properties: { env: { type: "string" } }, required: ["env"] },
  execute: async (input) => {
    // your deployment logic
  },
})

const agent = new Agent({ tools: [deployTool], /* ... */ })
```
...or use [MCP servers](https://github.com/modelcontextprotocol) to connect to databases, query APIs, manage cloud infrastructure, and interact with external systems. Use [community-built servers](https://github.com/modelcontextprotocol/servers) or ask Cerebriline to create custom tools on the fly. In the CLI, manage servers with `cline mcp`.

## Multi-Agent Teams

Coordinate multiple agents working together on complex tasks. A coordinator agent breaks the work into subtasks and delegates to specialist agents, each with their own tools and context. Team state persists across sessions so you can pick up where you left off.

Teams are off by default: the `team_*` tools add 18 tools (about 2,800 tokens) to every request. Turn on **Teammates** in Features (under **Agents can run commands**, and only with **Subagents** on), or pass `--teammates` (or set `CLINE_TEAMMATES=1`) to the CLI. A `/team` prompt turns them on for its own run.

```bash
cline --teammates --team-name auth-sprint "Plan and implement user authentication with tests"
```

### Sub-agents across your machines

Turn on **Subagents** in Features and the model can hand work to sub-agents with `spawn_agent`. One call can start a whole fan-out. `agents: [{name, task, type?, count?}]` lists them, `type` runs an agent you defined in `.cline/agents`, and `count` repeats an entry. `knowledge` and `instructions` carry the context those agents share, and it is loaded once for all of them.

- **Agent nodes.** The Agents tab holds several nodes, each with its own provider, model and a priority. Agents go to the best-priority node with room and wait in one queue when every node is busy. A node that is unreachable or lacks the model steps aside for a cool-off. In the CLI, `--agent-node model=…,url=…,priority=…,capacity=…` is repeatable.
- **Swarms.** With **Allow swarms** on and a PolyKV server behind it, `spawn_agent` with `merge: true` runs its agents on a snapshot of your context and returns one merged report.
- **Watch and steer.** A strip above the chat shows every running agent: its node, model, current tool, speed and recent activity, with **Stop**, **Restart** and **Stop all**. A message you send during a round is answered at once, and the lead can pass it to its agents or stop them.
- **Resilient rounds.** An agent never fails on infrastructure. After a server restart, a dropped connection or an admission refusal, it waits for the server and runs its turn again. The lead hears about an agent that has been stuck for a while. An agent that keeps running out its thinking budget is nudged once and then stopped, and it still reports.
- **Sampling per spawn.** `spawn_agent` (swarms included), teammates and configured agents take an optional `temperature` and `seed`. Leave them out and the model's own sampler applies. A seed that covers several agents is offset per agent (seed, seed+1, …). `"random"` draws a seed or a temperature per agent. A random temperature stays within 2% of the model's own (0.98 to 1.02 at 1.0); `temperature_range` widens that when you ask for it, up to 10%.
- **Token figures you can read.** An agent's input is every prompt it sent, summed over its turns, and most of it is served from the server's cache. Reports and rows read "N in (X cached, Y of it from the pool, Z fresh) / M out", and count how many of an agent's tool calls failed.
- **Inspect.** A button on an agent's row shows what its model is generating as it generates it: thinking, text and tool-call arguments.
- **Graceful stops.** Stopping an agent lets it finish its turn and report its partial work, unless you ask for an immediate stop.
- **Every report reaches the lead.** Each agent writes a short summary, and the lead reads any full report with `read_agent_report`. A question from an agent goes to the lead, not to you.

Every agent feature (sub-agents, configured agents, teammates, swarms, `create_agent`, `/delegate`, nodes, the sandbox, `max_iterations` and `check`, escalation), with how it works and example prompts: [`docs/features/agents.mdx`](docs/features/agents.mdx).

## Every Agent Works in a Sandbox

Every delegated agent (`spawn_agent` agents, swarm workers, teammates and configured agents) works on a **private copy-on-write overlay** of your workspace. It reads through to your files, but its writes, deletes and renames stay in its own copy. When it finishes, each file it changed comes back to the lead as a revision attributed to that agent. The lead reviews it with `read_files revision:"#N"` and adopts it with `restore_file`. Nothing is applied behind your back, and two agents working at once never see each other's writes. The overlay is pure TypeScript, so it is always on, on every platform.

**Agents can run commands** (Features, off by default) extends the copy to the shell. The agent's commands run through `cerebriline-sandbox`, a native launcher that points the whole command tree (builds, test runners, scripts) at the agent's copy:

| OS | architectures | how the agent's commands are isolated |
|---|---|---|
| Linux | x64, arm64 | **L1:** a user namespace with overlayfs mounted over the workspace |
| Linux | x64 | **L2:** ptrace path rewriting, used automatically where user namespaces are blocked (AppArmor) or overlayfs can't mount |
| macOS | Apple Silicon, Intel | **M1:** an APFS `clonefile` copy of the workspace |
| Windows | x64 | **W1:** Microsoft Detours injection that redirects file access into the overlay |

**Write confinement** is on by default for those commands: an agent may read the whole machine and write only its copy of the workspace and the temp folder. It needs no setup and no administrator rights: a read-only mount namespace on Linux, a `sandbox-exec` profile on macOS, and a Low integrity token on Windows. One switch on the model tab covers every agent provider. The lead's own commands can be confined the same way; that is off by default, because package managers and git write outside the workspace.

One Rust binary chooses the backend at runtime. All six launchers are built and verified on native CI runners for each OS and architecture, and they ship inside the `.vsix`. Where no launcher covers your platform the agent gets no shell, never an unsandboxed one. Design and build notes: [`sandbox/cerebriline-sandbox/README.md`](sandbox/cerebriline-sandbox/README.md).

## Compaction Council

A compaction summary is the one artifact in a session that is never checked against what it describes, and once written it *is* the session: every later turn reads it instead of the conversation. Measured summaries reported a failing check as a pass, paraphrased the instruction they were told to quote, and drifted into the past tense. None of that is a lack of intelligence. It happens when one pass has to cover more material than fits comfortably.

So the summary is reviewed the way a council reviews a proposal:

1. The writer produces a **present-tense replay** that cites tool calls by number (`[#3]`, `[#2-5]`) instead of copying them, quotes what you typed verbatim, and marks the halfway point of the work.
2. The transcript is split there. Two fresh reviewers each get **half of the evidence and all of the summary**. They work in parallel, both on the original, and each corrects what its half contradicts, adds what it shows missing and fixes every quotation.
3. A synthesizer joins the two corrected halves into one continuous replay and revises the retrospective against it.

It is on by default and costs three extra model calls. It never fails a compaction: a step that can't run falls back to what it was given. Every prompt is editable in Features, and a prompt template can carry its own compaction prompts for its model family.

## Escalation to a Stronger Model, Scored by Jev

When the working model is stuck, a stronger **expert** model (the Escalation tab: its own provider and model) can take over the edit itself, not just give advice.

- **Offered on evidence.** A struggle detector counts failed tool calls, turns that say the model is stuck, and discarded transactions. Only when it fires is the model offered `escalate`, and you approve the hand-over.
- **An assessment that isn't self-reported.** Next to the model's own account of why it is stuck, you and the expert see the harness's counts, the complexity walker's reading of the files in play, and **Jev's** score for the task. Jev is an outside scoring model that answers with a probability instead of an argument. A disagreement between the model's story and the numbers is shown, not hidden.
- **The expert edits.** It gets a brief (goal, open transaction, record), works on the same files with the same tools, and hands its edits back as revisions. The base model stays live and supervises, and you can steer the exchange while it runs.
- **Bounded.** A task gets three hand-overs (configurable), and one that buys nothing is refunded.

**Jev** also works outside escalation. With *Use Jev for confidence* ticked, the model can call a `jev` tool when it is unsure of a reading, a fact or a choice, and Jev scores the options of a question before it reaches you. Nothing is sent until the box is ticked and a key is stored.

**Jev on your own server.** The Jev tab takes any endpoint that speaks TypeSafe's Jev API. Ollama 0.35 serves it at `/v1/systemone` with local decision models (`nimble`, `tev1`), and xOllama carries the same code. Point the tab at the server and pick a model from the list; no key is needed, and TypeSafe's key is never sent to another server. The state sent is fitted to Ollama's body limit and to the model's loaded context window.

## Media Tools: Images, Audio, Video

Five tools reach a media server that speaks OpenAI's media routes: `generate_image`, `edit_image`, `transcribe_audio`, `synthesize_speech` and `generate_video`.

- **Images.** Generate an image, or edit one already in the workspace by instruction, with reference images and an optional mask.
- **Audio.** Speech-to-text returns text, subtitles (`srt`, `vtt`) or timed segments, and can translate to English. Text-to-speech writes an audio file, with a default voice and format.
- **Video.** A description, or an image in the workspace, becomes a clip. The chat shows the job's queue position and progress, and stopping the task deletes the job.
- **Where a tool goes.** A session on an opencoti or xOllama server that serves that kind of media uses that server. Otherwise each tab has an endpoint of its own. With neither, the tool is not offered and the model is never told it exists.

In the CLI: `--media-provider`, or `--media-config <file>`. Guide: [`docs/features/media-endpoints.mdx`](docs/features/media-endpoints.mdx).

## Document Reader

`extract_document` reads PDFs, Word, PowerPoint and Excel files (current and 97-2003 formats), OpenDocument, RTF, HTML and ebooks into Markdown, and writes their pictures out as files. Scanned pages are read with Tesseract on your machine, or by a vision model when one is configured. Each file is read in a process of its own, so a document that runs out of memory fails alone and the session carries on; files up to 1 GB are read, and **Largest file to read** sets the limit. It is off by default: Settings > Features > **Document Reader**, or `--documents`. Guide: [`docs/features/document-reader.mdx`](docs/features/document-reader.mdx).

## The Library

A place for what you want the model to be able to look things up in: ebooks, manuals, papers, notes and web pages. It is arranged as **sections**, **shelves** and **books**, kept in Cerebriline's data folder and shared by every workspace. A book keeps the files it was made from, the text read out of them, and their pictures with a description of each.

- **Search.** The model always has `search_library`, which returns the passages that best answer a question with the book and chapter each is from, and `list_library`. It works on keyword search alone, with nothing to download. Name an embedding model on the **Embedding** tab to search by meaning as well, and optionally a reranking model.
- **The librarian.** Ask *"act as a librarian, catalogue these ebooks and add them to the Library"*: the model reads each file, works out its title, authors and edition, writes a description and shelves it. Duplicates are skipped, and for another edition or translation it asks you first. Documents that only share text, such as one manufacturer's manuals for different products, are told apart by the running heads on their pages and are not taken for versions of one another.
- **Imports you can watch.** A long import lists every file with where it is, can be cancelled from its row, and ends with a report of every page or picture that was left out and why, which stays on the call's row, collapsed, to read or copy.
- **Pictures.** They are described by a model that reads images: a saved profile, the Vision tab's model, or the conversation's own model when it reads images. Only models that report a vision capability are offered. Descriptions can be added to a book later without reading it again.
- **Books from the web.** *"Create a book on GitHub recipes for Godot development"*: the librarian searches, picks the links, reads the pages through a [Firecrawl](https://github.com/firecrawl/firecrawl) endpoint and makes the book, and can check it for news later.
- **Nothing is lost.** Deleted books go to a trash for 30 days, after a Yes. The Library, or any mix of sections, shelves and books you tick, can be exported to one file and imported elsewhere.

It is off by default: **Settings > Library**, or `--library` and `--librarian` in the CLI. Guide: [`docs/features/library.mdx`](docs/features/library.mdx).

**Code search by meaning.** With an embedding model set, **Settings > Library > Index the code of this folder** indexes the folder's source files, and `search_codebase` gains a `semantic` mode: the query is a question in plain words and the answer is the passages that best match, each with its file and lines. It is for when the model knows what a piece of code does and not what it is called; regex search and `ask_lsp` are still what it uses when it does. Off by default and on per folder, because indexing sends every source file to the embedding model. Guide: [`docs/features/code-search.mdx`](docs/features/code-search.mdx).

**Web scraping.** With a [Firecrawl](https://github.com/firecrawl/firecrawl) endpoint set under **Settings > Features > Web scraping** and allowed in the API configuration, the model can search the web, read pages and crawl a site. By default only the librarian uses it, to make books. Untick **Only for the librarian** and every task gets a `web_scrape` tool that can also crawl a site into a folder of the workspace: each page as it was served and as the browser rendered it, with the stylesheets, scripts, pictures and fonts it uses, and a markdown reading of each page. Use it for a site to rework, or ask for the text only to keep knowledge as notes. `--web-scrape` in the CLI. Guide: [`docs/features/web-scraping.mdx`](docs/features/web-scraping.mdx).

## Memory

Notes the model keeps from one task to the next: a decision and its reason, how the project is built and tested, a convention, something you said you prefer. The model gets `remember`, `recall` and `forget`, and with every message you send the notes that are about it are put beside the message, with a line in the chat saying which.

There can be any number of memories. For each workspace you tick the ones its tasks may recall from and pick the one new notes are stored in. Notes are found by keyword, and by meaning with an embedding model. **Expand the question first (HyDE)** has a second model write the note that would answer your message and searches again with it, which finds notes that share its meaning and none of its words (HyDE, Gao et al., 2022, in the order of work [claude-hooks](https://github.com/mann1x/claude-hooks) uses).

It is off by default: **Settings > Memory**, or `--memory`. Guide: [`docs/features/memory.mdx`](docs/features/memory.mdx).

## Built-in Skills

Cerebriline ships with skills of its own, listed under **Built-in Skills** in the Skills tab with nothing to install, in the extension, the CLI and the SDK. All ship turned off.

- **Deploying and running:** `mandatory-qa-prompt-and-issue-resolution` and `docker-compose-deploy` (both by Chris), `build-project`, `run-project`.
- **Test-driven development:** `tdd-wizard`, `tdd-gen`, `tdd-test`, `tdd-coverage`, after Duke Harewood's "[Test-Driven Development with Claude Code: Practical Guide](https://aiskill.market/blog/tdd-with-claude-code)".
- **Spec-driven development:** `sdd-wizard`, `sdd-discuss`, `sdd-plan`, `sdd-execute`, `sdd-verify`, `sdd-quick`, `sdd-status`, after [Get Shit Done (GSD 2)](https://getshitdone.help/). The plan is kept in a database in your project and worked through one tool, `sdd`, which gives the model the step that is due and refuses one out of turn.
- **The librarian**, which runs the Library.
- **Browser automation:** `browser-automation` drives a real browser through the [Playwright MCP server](https://github.com/microsoft/playwright-mcp), which is a preset under **MCP Servers > Add Local**.

A built-in skill can be switched on and off and read, not edited; create a skill of your own with the same name to replace it. Guide: [`docs/customization/skills.mdx`](docs/customization/skills.mdx).

## Built for Small Models

A 27B model on a local server fails in ways a frontier model does not, and often silently. Most of what this fork adds exists because a measurement found one of those failures:

- **Prompt templates per model family**, each written by a model of that family. A template you write outranks a shipped one.
- **One output budget** on every provider: three quarters of the window, capped at 96,000 tokens per turn, adjustable with a slider. The number the prompt states is the number sent to the server.
- **Compaction that keeps the thread**, reviewed by the [Compaction Council](#compaction-council). The harness's own record of every tool call sits beside the summary.
- **A context bar that shows the fixed price**: system prompt, tool schemas and MCP schemas, before the conversation starts. Tools can be switched off per profile.
- **Tool calls read the shapes models actually send**, such as an array sent as a string or a single path where a list is expected. Refusals point at the character that went wrong.
- **Reasoning replay per provider.** Whether earlier thinking is sent back to the model is decided from what the model measurably does, is adjustable per profile, and is inlined into the content when a chat template would drop it.
- **Tool calls run as a batch.** Several independent calls in one message run in parallel. Writes to the same file are serialized, so no parallel edit is lost. A profile can set, or turn off, the size limit for a file read.
- **Guards** catch reasoning loops, repeated calls, non-convergence and files changed behind the model's back. An atomic change protocol with `restore_file` undoes damage ([Change Protocol](docs/features/change-protocol.mdx)).
- **Questions recommend an option.** When the model asks you to choose, it marks the option it would pick and lists it first. Optionally, **Jev** scores the options before they reach you.
- **Output you can account for.** Every request's output is split into thinking, answer text and tool-call arguments, and the log records each tool call's arguments as the model sent them.
- **Generated images reach you on text-only models.** The model gets a text result and the chat shows the image.

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

## Conversation History

- **Tags.** Right-click a conversation to tag it, then type `#tag` in the history search or click a chip to filter, with **Any / All**. The home view's recent list shows tags too.
- **What a session ran with.** Rest on a history row to see its provider, model, context window, output budget, reasoning and sampler. Credentials are never recorded.
- **Size on disk** splits a conversation into its transcript, its agents' transcripts and their overlays. Delete removes all of it.
- **News.** The home view shows this fork's own announcements when there are any.

## Scheduled Agents

Run agents on cron schedules for recurring automations. Daily PR summaries, weekly dependency checks, codebase health reports. Schedules persist across restarts and run independently of any terminal session.

```bash
cline schedule create "PR summary" \
  --cron "0 9 * * MON-FRI" \
  --prompt "List all open PRs and their review status" \
  --workspace /path/to/repo
```

## Connect to Slack, Telegram, Discord, and More

Chat with your agent from any messaging platform: Telegram, Slack, Discord, Google Chat, WhatsApp, and Linear. Each conversation thread maps to an agent session with full context. Set up access control to restrict who can interact with your agent.

```bash
# Connect to Telegram
cline connect telegram -k $BOT_TOKEN
# Connect to Slack through webhook
cline connect slack --bot-token $SLACK_TOKEN --signing-secret $SECRET --base-url $URL
# Connect to Slack using socket mode
cline connect slack --bot-token $SLACK_TOKEN --app-token $SLACK_APP_TOKEN
# Connect to Discord
cline connect discord --application-id $DISCORD_APP_ID --bot-token $DISCORD_BOT_TOKEN \
  --public-key $DISCORD_PUBLIC_KEY --base-url $URL
```

Run `cline connect` to list every channel, and `cline connect <channel> --help` for that channel's flags and the environment variables it reads.

## Headless CLI for CI/CD

Run Cerebriline with zero interaction for scripting and automation. Pipe input, get JSON output, chain commands, integrate into CI/CD pipelines.

```bash
cline "Run tests and fix any failures"
git diff origin/main | cline "Review these changes for issues"
cline --json "List all TODO comments" | jq -r 'select(.type == "agent_event" and .event.text) | .event.text'
```

## Working on this fork

Cerebriline is a fork of [cline/cline](https://github.com/cline/cline) aimed at
making coding agents work with **local and small models**, and at measuring
whether each change actually helps. Four documents cover the whole cycle:

| | |
|---|---|
| [`docs/protocols/FORK.md`](docs/protocols/FORK.md) | what this fork is, its branches, its trees, and what it adds to upstream |
| [`docs/protocols/BUILD-RELEASE-DEPLOY.md`](docs/protocols/BUILD-RELEASE-DEPLOY.md) | build a VSIX, cut a release, deploy it to the test host |
| [`docs/protocols/UPSTREAM-SYNC.md`](docs/protocols/UPSTREAM-SYNC.md) | merging `upstream/main`, and what must never come across with it |
| [`harness/README.md`](harness/README.md) | the `manic_miner` loop that judges whether a change helped |

Development happens on `main`; `mann1x/full-build-release` is where a release is
cut from, not a second trunk.

## Contributing to upstream Cline

Start with the [Contributing Guide](CONTRIBUTING.md). Join our [Discord](https://discord.gg/CuE9Jaggp) and head to the `#contributors` channel to connect with other contributors. 
## License

[Apache 2.0 © 2026 Cline Bot Inc.](./LICENSE)
