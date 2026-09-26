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

<!--
<a href="https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev">Install from VS Marketplace</a>
<br><br> 
-->
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

Cerebriline is not on the VS Code Marketplace — upstream Cline is there, and one
of us is enough. There are two ways to get it.

**From Open VSX** ([`mann1x.cerebriline`](https://open-vsx.org/extension/mann1x/cerebriline)).
This is the gallery **VSCodium, Cursor, Windsurf and Gitpod** use, so on those
editors Cerebriline installs and updates itself the ordinary way — search for
it in the Extensions panel, or:

```
codium --install-extension mann1x.cerebriline
```

Stock VS Code does not read Open VSX, so on it use the `.vsix` below.

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
demand. If you installed from Open VSX your editor already keeps it current,
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
- **Sampling per spawn.** `spawn_agent` (swarms included), teammates and configured agents take an optional `temperature` and `seed`. Leave them out and the model's own sampler applies. A seed that covers several agents is offset per agent (seed, seed+1, …). `"random"` draws a seed or a temperature per agent, and `temperature_range` sets how far the temperature may move.
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

## Built for Small Models

A 27B model on a local server fails in ways a frontier model does not, and often silently. Most of what this fork adds exists because a measurement found one of those failures:

- **Prompt templates per model family**, each written by a model of that family. A template you write outranks a shipped one.
- **One output budget** on every provider: three quarters of the window, capped at 96,000 tokens per turn, adjustable with a slider. The number the prompt states is the number sent to the server.
- **Compaction that keeps the thread**, reviewed by the [Compaction Council](#compaction-council). The harness's own record of every tool call sits beside the summary.
- **A context bar that shows the fixed price**: system prompt, tool schemas and MCP schemas, before the conversation starts. Tools can be switched off per profile.
- **Tool calls read the shapes models actually send**, such as an array sent as a string or a single path where a list is expected. Refusals point at the character that went wrong.
- **Reasoning replay per provider.** Whether earlier thinking is sent back to the model is decided from what the model measurably does, is adjustable per profile, and is inlined into the content when a chat template would drop it.
- **Tool calls run as a batch.** Several independent calls in one message run in parallel. Writes to the same file are serialized, so no parallel edit is lost. A profile can set, or turn off, the size limit for a file read.
- **Guards** catch reasoning loops, repeated calls, non-convergence and files changed behind the model's back. An atomic change protocol with `restore_file` undoes damage.
- **Questions recommend an option.** When the model asks you to choose, it marks the option it would pick and lists it first. Optionally, **Jev** scores the options before they reach you.
- **Generated images reach you on text-only models.** The model gets a text result and the chat shows the image.

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
