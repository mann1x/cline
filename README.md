<p align="center">
  <img src="assets/icons/icon.png" width="80" alt="Cerebriline" />
</p>

<h1 align="center">Cerebriline</h1>

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
npm i -g Cerebriline
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
npm install @Cerebriline/sdk
```
-->

<a href="#placeholder">Documentation</a>
<br><br>

</td>
</tr>
</table>
</div>

---

## Index

| Product | Description | Location | CHANGELOG |
|---------|------------|--------------|--------------|
| **SDK** | Node.js programmatic agent API and extension exports. | [`sdk/`](#) | [CHANGELOG.md](#) |
| **CLI** | Terminal UI, headless mode, shell commands, and CLI-specific flows. | [`apps/cli/`](#) | [CHANGELOG.md](#) |
| **VS Code Extension** | The Marketplace extension and extension host integration. | [`/`](#) (WIP migrating) | [CHANGELOG.md](#) |
| **JetBrains Plugin** | JetBrains-hosted client that talks to the shared agent core. | Currently we are not open-sourcing JetBrains plugins | - |
| **Kanban** | Web-based multi-agent task board. | [`Cerebriline/kanban`](#) | [CHANGELOG.md](#) |
| **Docs site** | Public documentation pages. | [`docs/`](#) | - |

## Edits Code Across Your Project

Cerebriline reads your project structure, understands the relationships between files, and makes coordinated changes across your codebase. It monitors linter and compiler errors as it works, fixing issues like missing imports, type mismatches, and syntax errors before you even see them. In VS Code and JetBrains, every edit shows up as a diff you can review, modify, or revert. All changes are tracked with checkpoints, so you can easily undo the agent's work.

## Runs Bash Commands

Cerebriline executes commands directly in your terminal and watches the output in real time. Install packages, run build scripts, execute tests, deploy applications, manage databases. For long-running processes like dev servers, Cerebriline continues working in the background and reacts to new output as it appears, catching compile errors, test failures, and server crashes as they happen.

## Plan and Act

Toggle between Plan mode and Act mode. In Plan mode, Cerebriline explores your codebase, asks clarifying questions, and lays out a strategy. Once you're aligned, switch to Act mode and Cerebriline executes the plan. Every file edit and terminal command requires your approval, so you stay in control of what actually changes. Or toggle auto-approve and let Cerebriline run autonomously.

## Rules and Skills

Define project-specific rules in `.Cerebrilinerules` files that guide how Cerebriline works in your codebase: coding standards, architecture conventions, deployment procedures, testing requirements. Rules are picked up automatically by the CLI, VS Code extension, and JetBrains plugin. Use skills to let the model load specific rules when needed.

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
| Any OpenAI-compatible API | Self-hosted or third-party endpoints |

## Extend With Plugins or MCP Servers

Extend Cerebriline's capabilities with plugins. Using the SDK, register tools and lifecycle hooks programmatically through the plugin system for logging, auditing, policy enforcement, or adding domain-specific capabilities. Simple plugin example below.

```typescript
import { Agent, createTool } from "@Cerebriline/sdk"

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
...or use [MCP servers](https://github.com/modelcontextprotocol) to connect to databases, query APIs, manage cloud infrastructure, and interact with external systems. Use [community-built servers](https://github.com/modelcontextprotocol/servers) or ask Cerebriline to create custom tools on the fly. In the CLI, manage servers with `Cerebriline mcp`.

## Multi-Agent Teams

Coordinate multiple agents working together on complex tasks. A coordinator agent breaks the work into subtasks and delegates to specialist agents, each with their own tools and context. Team state persists across sessions so you can pick up where you left off.

```bash
Cerebriline --team-name auth-sprint "Plan and implement user authentication with tests"
```

## Scheduled Agents

Run agents on cron schedules for recurring automations. Daily PR summaries, weekly dependency checks, codebase health reports. Schedules persist across restarts and run independently of any terminal session.

```bash
Cerebriline schedule create "PR summary" \
  --cron "0 9 * * MON-FRI" \
  --prompt "List all open PRs and their review status" \
  --workspace /path/to/repo
```

## Connect to Slack, Telegram, Discord, and More

Chat with your agent from any messaging platform: Telegram, Slack, Discord, Google Chat, WhatsApp, and Linear. Each conversation thread maps to an agent session with full context. Set up access control to restrict who can interact with your agent.

```bash
# Connect to Telegram
Cerebriline connect telegram -k $BOT_TOKEN
# Connect to Slack through webhook
Cerebriline connect slack --bot-token $SLACK_TOKEN --signing-secret $SECRET --base-url $URL
# Connect to Slack using socket mode
Cerebriline connect slack --bot-token $SLACK_TOKEN --app-token $SLACK_APP_TOKEN
# Connect to Discord
Cerebriline connect discord --application-id $DISCORD_APP_ID --bot-token $DISCORD_BOT_TOKEN \
  --public-key $DISCORD_PUBLIC_KEY --base-url $URL
```

Run `Cerebriline connect` to list every channel, and `Cerebriline connect <channel> --help` for that channel's flags and the environment variables it reads.

## Headless CLI for CI/CD

Run Cerebriline with zero interaction for scripting and automation. Pipe input, get JSON output, chain commands, integrate into CI/CD pipelines.

```bash
Cerebriline "Run tests and fix any failures"
git diff origin/main | Cerebriline "Review these changes for issues"
Cerebriline --json "List all TODO comments" | jq -r 'select(.type == "agent_event" and .event.text) | .event.text'
```

## Contributing

Start with the [Contributing Guide](CONTRIBUTING.md). Join our [Discord](https://discord.gg/CuE9Jaggp) and head to the `#contributors` channel to connect with other contributors. 
## License

[Apache 2.0 © 2026 Cerebriline Bot Inc.](./LICENSE)
