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

Bun **1.3.13** workspace (`package.json` `workspaces`) with Node **>=22** as the runtime (`.nvmrc`, `.tool-versions`). Do not use npm/yarn/pnpm. Lockfile: `bun.lock`.

## Build / lint / test

```bash
bun install
bun run build:sdk   # REQUIRED after any sdk/packages/* change — consumers import dist/ only
bun run types       # tsc --noEmit in every workspace
bun run test:unit   # parallel: agents, llms, core, cli, cline-hub, vscode
bun run test:e2e    # @cline/core then @cline/cli e2e
bun run check       # biome + build:sdk + typecheck + sdk/scripts/check-publish.ts
bun run fix         # biome check --write (biome.json, sdk/biome.json)
```

SDK packages (`@cline/shared|llms|agents|core|sdk`) resolve each other through compiled `dist/` — there is no source condition, so a running process does **not** hot-reload SDK edits. Rebuild and restart.

## Packages

`sdk/packages/`: `shared/` (contracts, `src/mcp.ts`, hooks, `src/db`) → `llms/` (provider settings, model catalogs) → `agents/` (`src/agent-runtime.ts`, stateless loop) → `core/` (`src/ClineCore.ts`, `src/session`, `src/hub`, `src/cron`, `src/extensions/tools`) → `sdk/`. Also `ui/` (`components.css`). Direction is one-way; see `sdk/ARCHITECTURE.md` and `sdk/AGENTS.md`.

`apps/`: `cli/` (`src/index.ts` → `src/main.ts`, OpenTUI in `src/tui/`, `src/commands/`, `src/acp/`) · `vscode/` (`src/extension.ts`, `src/generated/`, `webview-ui/`) · `cline-hub/` (`src/server.ts`, `src/webview-protocol.ts`) · `vscode-rollout/` · `examples/desktop-app/` (Tauri + Next.js).

Also: `evals/` (`ARCHITECTURE.md`, `smoke-tests/`), `docs/` (Mintlify, `docs/docs.json`), `sdk/examples/plugins/`, `sdk/examples/hooks/`, `.changeset/`, `patches/`.

Repo-level config, assets and notes an agent will meet: `.vscode/` (`extensions.json` recommended extensions, `launch.json` extension-debug targets) · `.cline/skills/` (Cline-native skills shipped with the checkout) · `.greptile/` (`config.json`, `files.json` — Greptile review scope and file filter) · `.kanban/config.json` (kanban board config used by the CLI board command) · `assets/` (`icons/` extension and app icons, `docs/` README and docs-site images) · `prompt-reviews/` (per-model system-prompt review notes — `claude.md`, `gemma.md`, `qwen.md`, `minimax.md`, plus `archive/` and `regen/`) · `.clinerules/`.

## Cline CLI

```bash
bun run cli -i        # interactive; auto-spawns the @cline/cline-hub daemon
bun run cli doctor    # local health
bun run cli mcp       # manage MCP servers (contracts: sdk/packages/shared/src/mcp.ts)
```

An actual agent turn needs a provider credential — without one the default `cline` provider fails fast with `Unauthorized`. Configure via `cline auth` or `ANTHROPIC_API_KEY` / `CLINE_API_KEY` / `OPENROUTER_API_KEY`; see `apps/cli/README.md`.

## VS Code extension (`apps/vscode`, package `cerebriline`, publisher `mann1x`)

- `bun run protos` regenerates `apps/vscode/src/generated/` after any proto edit (`dev`, `build:webview`, `check-types` already run it).
- Build: `bun run build:webview` then `bun esbuild.mjs`; full production build `bun run package`.
- Test: `bun run test:unit` (no VS Code host) · `bun run test:integration` (`@vscode/test-electron`) · `bun run test:e2e` (Playwright).
- Regenerate snapshots after prompt/tool changes: `UPDATE_SNAPSHOTS=true bun run test:unit`.
- Ripgrep binaries land in `apps/vscode/bin/` via `bun run download-ripgrep`.

## Desktop app (`apps/examples/desktop-app`, `@cline/code`)

Tauri v2 (Rust ≥1.85, `edition2024`) + Next.js webview + Bun sidecar. Headless: `bun run dev:sidecar` (`127.0.0.1:3126`) and `bun run dev:web` (`http://localhost:3125`). Native window: `bun run dev`. Checks: `bun run typecheck`, `bun run test:chat-ui`. Beta channel notes in `EXPERIMENTAL.md`.

## Conventions

- Biome, not ESLint/Prettier. `apps/vscode` uses `apps/vscode/biome.jsonc` with `--semicolons=as-needed`.
- Vitest, colocated (`apps/cli/src/commands/kanban.ts` beside `apps/cli/src/commands/kanban.test.ts`). Test names describe behaviour, not method names.
- Tools use `createTool()` from `@cline/shared`, `snake_case` names registered in `sdk/packages/core/src/extensions/tools/constants.ts`; executors return `ToolOperationResult` with `success: false` rather than throwing.
- `.husky/pre-commit` runs `lint-staged` → `bun run types` + `biome check`.
- Releases go through `sdk/scripts/release.ts` and `.github/workflows/*-publish.yml`; fork/release protocol in `docs/protocols/FORK.md` and `docs/protocols/BUILD-RELEASE-DEPLOY.md`.

## Known environment artifacts

- `@cline/core` `src/services/workspace/workspace-manifest.test.ts` (`prefers origin and returns the current branch`) fails on cloud VMs that rewrite GitHub remotes via git `insteadOf`. Environment artifact, not a code bug.
- Some `bun -F @cline/cli test:e2e` tool-listing string assertions drift; treat as pre-existing.
- A virtual X display is available at `DISPLAY=:1` for GUI/Tauri/VS Code runs; prefer `tmux` for long-lived processes.

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
  2. Run: `caliber refresh && git add CLAUDE.md .claude/ .cursor/ .cursorrules .github/copilot-instructions.md .github/instructions/ AGENTS.md CALIBER_LEARNINGS.md .agents/ .opencode/ 2>/dev/null`
  3. After it completes, briefly tell the user what Caliber updated. Then proceed with the commit.

**Valid `caliber refresh` options:** `--quiet` (suppress output) and `--dry-run` (preview without writing). Do not pass any other flags — options like `--auto-approve`, `--debug`, or `--force` do not exist and will cause errors.

**`caliber config`** takes no flags — it runs an interactive provider setup. Do not pass `--provider`, `--api-key`, or `--endpoint`.

If `caliber` is not found, read `.agents/skills/setup-caliber/SKILL.md` and follow its instructions to install Caliber.
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
If the pre-commit hook is not set up, read `.agents/skills/setup-caliber/SKILL.md` and follow the setup instructions.
<!-- /caliber:managed:sync -->
