# Cline Monorepo — `@cline/packages`

> **Releasing, building a VSIX, or deploying to pandorum?**
> **Read [`docs/protocols/BUILD-RELEASE-DEPLOY.md`](docs/protocols/BUILD-RELEASE-DEPLOY.md) first — the whole cycle is there.**
> Branch, version bump, `bun run package` *then* `vsce package` (separate
> steps), the tag-triggered release workflow, and how to verify the artefact
> rather than the build log. It has been re-derived from memory more times than
> it has been read; a mention in a list further down this file is not enough to
> find it in time.
>
> Do **not** follow `.claude/commands/release.md` — that is upstream's
> marketplace workflow and this fork does not publish to the marketplace.
> Fork scope and rationale: [`docs/protocols/FORK.md`](docs/protocols/FORK.md).

Bun **1.3.13** workspace (`package.json` `workspaces`), Node **>=22** (`.nvmrc`, `.tool-versions`). Never use npm/yarn/pnpm. Lockfile is `bun.lock`.

## Commands

```bash
bun install
bun run build:sdk      # REQUIRED after editing sdk/packages/* — consumers resolve dist/ only
bun run cli -i         # run the CLI from source; auto-spawns the @cline/cline-hub daemon
bun run types          # tsc --noEmit across every workspace
bun run test:unit      # parallel unit suites (agents, llms, core, cli, cline-hub, vscode)
bun run check          # biome + build:sdk + typecheck + sdk/scripts/check-publish.ts
bun run fix            # biome check --write (config: biome.json, sdk/biome.json)
```

Per package (`-F` = workspace filter):

```bash
bun -F @cline/core test:unit      # vitest --config sdk/packages/core/vitest.config.ts
bun -F @cline/cli test:e2e        # apps/cli/vitest.e2e.config.ts
bun -F @cline/llms generate:models
cd apps/vscode && bun run package # protos + check-types + webview + esbuild.mjs
```

Generated code, e2e, and release bookkeeping:

```bash
cd apps/vscode && bun run protos   # regenerate apps/vscode/src/generated/ after a proto edit
bun run test:e2e                   # @cline/core then @cline/cli e2e
bunx changeset                     # record a .changeset/ entry for a user-visible change
```

## Layout

**SDK** (`sdk/packages/`, see `sdk/ARCHITECTURE.md` + `sdk/AGENTS.md`): `shared/` (contracts, `src/mcp.ts`, hooks, `src/db`) → `llms/` (provider settings, model catalogs) → `agents/` (`src/agent-runtime.ts`, stateless loop) → `core/` (`src/ClineCore.ts`, `src/session`, `src/hub`, `src/cron`, `src/runtime`, `src/extensions/tools`) → `sdk/` (umbrella re-export) · `ui/` (`components.css`, Radix colors).

**Apps** (`apps/`): `cli/` — `src/index.ts` → `src/main.ts`, OpenTUI UI in `src/tui/`, commands in `src/commands/`, ACP in `src/acp/` · `vscode/` — `src/extension.ts`, generated protobus in `src/generated/`, React webview in `webview-ui/` · `cline-hub/` — `src/server.ts`, `src/webview-protocol.ts` · `vscode-rollout/` — A/B loader · `examples/desktop-app/` — Tauri + Next.js.

**Other**: `evals/` (`ARCHITECTURE.md`, `smoke-tests/`, `e2e/run-cline-bench.ts`) · `docs/` Mintlify site (`docs/docs.json`) · `sdk/examples/plugins/` + `sdk/examples/hooks/` · `.changeset/` · `patches/`.

**Repo config, assets, review notes**: `.vscode/` — `extensions.json` (the recommended-extension set VS Code prompts for on open) and `launch.json` (extension-debug targets, the F5 flow in `CONTRIBUTING.md`) · `.cline/skills/` — Cline-native skill definitions this checkout ships to the agent · `.greptile/` — `config.json` + `files.json`, the Greptile code-review scope and file filter · `.kanban/config.json` — board config read by the CLI kanban command · `assets/` — `icons/` (extension and app icons) and `docs/` (images referenced by the README and docs site) · `prompt-reviews/` — per-model system-prompt review notes (`claude.md`, `gemma.md`, `qwen.md`, `minimax.md`, …) plus `archive/` and `regen/` · `.clinerules/`.

## Conventions

- Format/lint is **Biome**, not ESLint/Prettier. `apps/vscode` uses its own `apps/vscode/biome.jsonc` with `--semicolons=as-needed`.
- Tests are **Vitest** and live beside the source (`sdk/packages/core/src/extensions/tools/executors/grep.ts` beside `sdk/packages/core/src/extensions/tools/executors/grep.test.ts`), not in a separate tests directory — except `apps/vscode/src/services/mcp/__tests__/`.
- Tools are declared with `createTool()` from `@cline/shared`; names are `snake_case` and listed in `sdk/packages/core/src/extensions/tools/constants.ts`.
- Tool executors return `ToolOperationResult` with `success: false` + `error` rather than throwing — a throw counts against the agent mistake limit.
- `.husky/pre-commit` runs `lint-staged` → `bun run types` + `biome check`.
- Releases: `sdk/scripts/release.ts`, `sdk/scripts/version.ts`, and the `.github/workflows/*-publish.yml` set. Fork process: `docs/protocols/FORK.md`, `docs/protocols/BUILD-RELEASE-DEPLOY.md`.

## MCP

Cline is both an MCP host and an MCP consumer. Server contracts live in `sdk/packages/shared/src/mcp.ts`; user docs in `docs/mcp/mcp-overview.mdx`. Manage servers with `bun run cli mcp`. This checkout also uses MCP servers for development — `context7` (live library docs), `lsp` (symbol definitions, references, diagnostics), `pgvector` (persistent memory), `github-mcp`, `filesystem`, `searxng`, `code-graph` and `gitnexus` (impact analysis). Prefer `lsp` over grep for symbol lookups.

@./CONTRIBUTING.md

# OpenWolf

@.wolf/OPENWOLF.md

This project uses OpenWolf for context management. Read and follow `.wolf/OPENWOLF.md` every session. Check `.wolf/cerebrum.md` before generating code. Check `.wolf/anatomy.md` before reading files. Cline-native rules also live in `.clinerules/` (`general.md`, `bun-and-node.md`, `protobuf-development.md`, `storage.md`).

<!-- caliber:managed:pre-commit -->
## Before Committing

**IMPORTANT:** Before every git commit, you MUST ensure Caliber syncs agent configs with the latest code changes.

First, check if the pre-commit hook is already installed:
```bash
grep -q "caliber" .git/hooks/pre-commit 2>/dev/null && echo "hook-active" || echo "no-hook"
```

- If **hook-active**: the hook handles sync automatically — just commit normally. Tell the user: "Caliber will sync your agent configs automatically via the pre-commit hook."
- If **no-hook**: run Caliber manually before committing:
  1. Tell the user: "Caliber: Syncing agent configs with your latest changes..."
  2. Run: `caliber refresh && git add CALIBER_LEARNINGS.md CLAUDE.md .claude/ .github/copilot-instructions.md .github/instructions/ AGENTS.md .agents/ 2>/dev/null`
  3. After it completes, briefly tell the user what Caliber updated. Then proceed with the commit.

**Valid `caliber refresh` options:** `--quiet` (suppress output) and `--dry-run` (preview without writing). Do not pass any other flags — options like `--auto-approve`, `--debug`, or `--force` do not exist and will cause errors.

**`caliber config`** takes no flags — it runs an interactive provider setup. Do not pass `--provider`, `--api-key`, or `--endpoint`.

If `caliber` is not found, tell the user: "This project uses Caliber for agent config sync. Run /setup-caliber to get set up."
<!-- /caliber:managed:pre-commit -->

<!-- caliber:managed:learnings -->
## Session Learnings

Read `CALIBER_LEARNINGS.md` for patterns and anti-patterns learned from previous sessions.
These are auto-extracted from real tool usage — treat them as project-specific rules.
<!-- /caliber:managed:learnings -->

<!-- caliber:managed:model-config -->
## Model Configuration

Recommended default: `claude-sonnet-4-6` with high effort (stronger reasoning; higher cost and latency than smaller models).
Smaller/faster models trade quality for speed and cost — pick what fits the task.
Pin your choice (`/model` in Claude Code, or `CALIBER_MODEL` when using Caliber with an API provider) so upstream default changes do not silently change behavior.

<!-- /caliber:managed:model-config -->

<!-- caliber:managed:sync -->
## Context Sync

This project uses [Caliber](https://github.com/caliber-ai-org/ai-setup) to keep AI agent configs in sync across Claude Code, Cursor, Copilot, and Codex.
Configs update automatically before each commit via `caliber refresh`.
If the pre-commit hook is not set up, run `/setup-caliber` to configure everything automatically.
<!-- /caliber:managed:sync -->
