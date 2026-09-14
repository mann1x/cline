# Syncing with upstream Cline

`upstream/main` is [cline/cline](https://github.com/cline/cline). This fork
tracks it deliberately and occasionally, never automatically.

**As of 2026-09-14: `main` is 570 commits ahead of `upstream/main`, 88 behind.**
Recompute before planning a sync — both numbers move, and the second one is the
size of the review:

```bash
git fetch upstream
git rev-list --count upstream/main..main    # ours they do not have
git rev-list --count main..upstream/main    # theirs we do not have
```

## Why this is a review and not a fast-forward

The surface this fork changes — the system prompt, tool descriptions, provider
configuration, the agent loop — is exactly the surface upstream edits most. A
merge that resolves cleanly is not evidence that it resolved *correctly*: a
tool description upstream rewrote and a tool description we rewrote touch the
same lines for unrelated reasons, and git will happily take one of them.

Two kinds of change come across, and they are worth different amounts:

- **Take gladly.** Provider additions, SDK plumbing, webview components, build
  and CI fixes, dependency bumps, anything upstream fixed that we also have.
- **Read line by line.** Prompts, tool descriptions and schemas, the agent
  loop, compaction, anything under `sdk/packages/core/src/extensions/config` or
  `runtime/`. Much of what this fork adds exists because a **measurement** said
  so, and an upstream rewrite of the same lines has no such measurement behind
  it. Losing one silently is how a fixed failure mode comes back.

## The bounded conflict surface: the rename

Since 4.100.112 this fork is `mann1x.cerebriline`, and that rename touches a
small, known set of files. Every upstream merge will conflict on them, every
time, and the resolution is always **ours**:

| file | what is ours |
|---|---|
| `apps/vscode/package.json` | `name: cerebriline`, `displayName: Cerebriline`, `publisher: mann1x`, our `4.100.x` version |
| `apps/cli/package.json`, `sdk/packages/core/package.json` | our package names |
| `bun.lock` | regenerate, never hand-merge — see below |
| `README.md` | our install, migration and harness sections |
| `assets/icons/*`, `apps/vscode/assets/icons/*` | our icon |
| the path resolvers (`~/.cerebriline` with the `~/.cline` fallback) | ours |

A blind `sed` over the rename is how this went wrong once already: an earlier
pass renamed `npm i -g cline` to `npm i -g Cerebriline`, `@cline/sdk` to
`@Cerebriline/sdk` and the licence holder to "Cerebriline Bot Inc." — none of
which exist. **Package names and the licence are upstream's and stay upstream's.**
Only the extension identity, the display strings and our own data directory
change.

`bun.lock` is a **regenerate, not a merge**. It keys the graph by each
workspace's `name`, and ours are renamed, so a textual merge produces a lockfile
that resolves to packages that do not exist. Take ours, then:

```bash
bun install
bun install --frozen-lockfile   # must say "no changes" before you go further
```

## Never take from upstream

- `harness/` — ours entirely; upstream has no equivalent.
- `sdk/packages/core/assets/prompt-templates/` and the template machinery.
  Upstream ships one system prompt; these are per-family and each was written
  by a model of that family. See `PROMPT-TEMPLATES.md`.
- `harness/smoke.js`, `harness/manic_miner_1TESTSOURCE.html` — the campaign
  constants. The experiment is only comparable because they do not change.
- `.claude/commands/release.md` and `.clinerules/workflows/release.md` —
  upstream's marketplace workflow, which does not apply here. Ours is
  `BUILD-RELEASE-DEPLOY.md`.

## The procedure

Sync on a branch, never on `main` directly — a half-resolved merge on the trunk
is what `mann1x/full-build-release` used to exist to prevent, and a branch gives
that back without splitting the trunk again.

```bash
git fetch upstream
git checkout main && git pull --ff-only
git checkout -b mann1x/upstream-sync-YYYYMMDD
git merge upstream/main          # expect conflicts; resolve per the tables above
```

Then, in order, and do not skip one because the previous passed:

1. `bun install` and `bun install --frozen-lockfile` — the lockfile trap above.
2. `cd sdk/packages/core && npx tsc --noEmit -p tsconfig.json`
3. `cd apps/vscode && bun run check-types` — five minutes; it is the only thing
   that catches a proto gap, because the generated protos are gitignored.
4. `cd sdk/packages/core && npx vitest run --config vitest.config.ts` —
   **vitest, not `bun test`**, which invents failures in this repo.
5. `npx biome check src` from each package root.
6. Read `git diff main...HEAD` over the "read line by line" paths above. Not
   the merge diff — the diff against our own trunk, which is what actually
   changed for us.
7. Build a VSIX and install it on pandorum before merging. A sync that
   typechecks and fails at runtime is the normal outcome, not the surprising
   one.

Merge to `main` with `--no-ff`, so the sync is one identifiable commit range:

```bash
git checkout main && git merge --no-ff mann1x/upstream-sync-YYYYMMDD
git push origin main
```

Then cut a release from it the usual way — see
[`BUILD-RELEASE-DEPLOY.md`](./BUILD-RELEASE-DEPLOY.md).

## The harness is the arbiter

If a sync touches prompts, tool descriptions or the agent loop, a typecheck and
a test suite do not tell you whether it made the product worse. Run an arm
before and after against the same model and the same tag — `harness/README.md`
has the drivers and what counts as success. A 10-run arm is a night; a silently
reverted guard is months.
