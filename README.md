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

Everything else in the Ollama panel works on stock Ollama. Only the thinking budget requires this build.

### llama.cpp: the server's own numbers

A `llama-server` is configured through the **OpenAI Compatible** provider — point it at `http://localhost:8080/v1` and set Context Window to whatever you started the server with, because nothing probes it for you.

What this fork adds there is llama.cpp's own measurements. The server returns a `timings` object that a standard OpenAI client throws away; Cerebriline keeps it and shows, per request, the prompt and generation split the server measured, how much of the prompt it served from its KV cache, and — if you run a draft model — how many speculative tokens were accepted. Turn on **Show request timings**; it is off by default. Set **Parallel Sessions** to match the server's `--parallel`.

### opencoti-llamafile: PolyKV pools and agentic serving

**https://huggingface.co/ManniX-ITA/opencoti-llamafile**

opencoti-llamafile is a single-file inference engine from the [opencoti](https://github.com/mann1x/opencoti) project: a llamafile base carrying the opencoti patch series — PolyKV shared-prefix KV pools with a REST control plane, KV residency and quantization, a rolling KV window that spills to host RAM, elastic multi-session serving behind an admission gate, DCA long context, MTP speculative decode, CUDA and Vulkan backends. One executable, no runtime to install, nothing to import.

In the VS Code extension it is configured exactly like llama.cpp — the OpenAI Compatible panel, timings and all. The pool-aware half of it lives in the CLI and SDK, where the engine has a provider of its own and needs no API key:

```bash
cline auth --provider opencoti --modelid <model> --baseurl http://localhost:8080/v1
```

On that provider, with auto-compaction on, a session pins one PolyKV pool for its system prompt and tool schemas, asks the engine how much room is left before each turn, compacts when the engine reports cache pressure rather than when a token estimate guesses at it, and forks the pool at the prefix afterwards so the expensive part is not processed again. Delegated agents stop counting against a fixed slot limit and let the engine's admission control decide instead.

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

```bash
cline --team-name auth-sprint "Plan and implement user authentication with tests"
```

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
