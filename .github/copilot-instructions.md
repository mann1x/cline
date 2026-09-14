# Copilot Instructions for Cline

This is the **Cline monorepo** — a Bun 1.3.13 workspace (`package.json` `workspaces`), Node >=22. The VS Code extension is **no longer at the repo root**: it lives in `apps/vscode/` (package `claude-dev`). Paths below are relative to `apps/vscode/` unless they start with `sdk/` or `apps/`. Read `.clinerules/general.md` for tribal knowledge.

## Workspace map

- **SDK** (`sdk/packages/`): `shared/` → `llms/` → `agents/` → `core/` → `sdk/`. One-way dependency direction. Details in `sdk/ARCHITECTURE.md`.
- **Apps** (`apps/`): `cli/` (OpenTUI terminal app), `vscode/` (extension + `webview-ui/`), `cline-hub/` (shared daemon), `vscode-rollout/` (A/B loader), `examples/desktop-app/` (Tauri).
- **Extension core**: `src/extension.ts` → `WebviewProvider` → `Controller` (single source of truth) → `Task` (agent loop). MCP host: `src/services/mcp/McpHub.ts`; MCP contracts also in `sdk/packages/shared/src/mcp.ts`.

## Build & test (non-obvious)

```bash
bun run build:sdk     # from repo root — REQUIRED after any sdk/packages/* edit
cd apps/vscode
bun run compile       # NOT `bun run build`
bun run protos        # run immediately after any .proto change
bun run test:unit     # UPDATE_SNAPSHOTS=true bun run test:unit after prompt/tool changes
```

## Protobuf RPC workflow (4 steps)

1. Define in `proto/cline/*.proto` — `PascalCaseService`, `camelCase` rpcs, `PascalCase` messages; reuse `common.proto` types.
2. Generate: `bun run protos` (writes `src/shared/proto/`, `src/generated/`).
3. Backend handler under `src/core/controller/<domain>/`.
4. Frontend: `UiServiceClient.myMethod(Request.create({...}))`.

Adding a `ClineSay` enum also requires `src/shared/proto-conversions/cline-message.ts`.

## Adding API providers (silent failure risk)

Miss any of these and the provider silently resets to Anthropic: `proto/cline/models.proto` (`ApiProvider` enum), `convertApiProviderToProto()` and `convertProtoToApiProvider()` in `src/shared/proto-conversions/models/api-configuration-conversion.ts`. Then update `src/shared/api.ts`, `src/shared/providers/providers.json`, `src/core/api/index.ts`, and the webview `providerUtils.ts` / `validate.ts` / `ApiOptions.tsx`. Responses-API providers also need `isNextGenModelProvider()` in `src/utils/model-utils.ts`.

## Adding tools

- **SDK tools** (`sdk/packages/core/src/extensions/tools/`): `createTool()` from `@cline/shared`, `snake_case` name in `constants.ts`, flags in `presets.ts`, export from `index.ts`. Executors return `ToolOperationResult` with `success: false` — do not throw.
- **Extension tools**: enum in `src/shared/tools.ts` → definition in `src/core/prompts/system-prompt/tools/` → register in `tools/init.ts` → whitelist in `variants/*/config.ts` → handler in `src/core/task/tools/handlers/` wired into `ToolExecutor.ts` → regenerate snapshots.

## Conventions

- **Formatter/linter**: Biome (`biome.json`, `apps/vscode/biome.jsonc`) — never ESLint or Prettier.
- **Tests**: Vitest, colocated `foo.test.ts` beside `foo.ts`.
- **Paths**: use `src/utils/path` helpers (`toPosixString`) for cross-platform safety.
- **State**: typed keys in `src/shared/storage/state-keys.ts`, read/written through `StateManager`, never raw `ExtensionContext` storage.
- **Slash commands** live in three places: `src/core/slash-commands/index.ts`, `src/core/prompts/commands.ts`, `webview-ui/src/utils/slash-commands.ts`.
- **Logging**: `src/shared/services/Logger.ts`.

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

If `caliber` is not found, tell the developer to set up Caliber by running `/setup-caliber` in Claude Code or Cursor. Alternatively, they can run these commands in their terminal:
```
npx @rely-ai/caliber hooks --install
npx @rely-ai/caliber refresh
```
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
If the pre-commit hook is not set up, the developer should run `/setup-caliber` in Claude Code or Cursor for automated setup. Alternatively, run in terminal:
```bash
npx @rely-ai/caliber hooks --install
npx @rely-ai/caliber refresh
git add CLAUDE.md .claude/ .cursor/ .cursorrules .github/copilot-instructions.md .github/instructions/ AGENTS.md CALIBER_LEARNINGS.md .agents/ .opencode/ 2>/dev/null
```
<!-- /caliber:managed:sync -->
