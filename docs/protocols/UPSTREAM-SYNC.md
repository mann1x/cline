# Syncing with upstream Cline

`upstream/main` is [cline/cline](https://github.com/cline/cline). This fork
tracks it deliberately and occasionally, never automatically.

**As of 2026-10-11: synced to upstream `c3a4057276` (v4.1.23).** Going in, `main`
was 1,280 commits ahead and 375 behind; 249 files had changed on both sides and
108 of them conflicted. Recompute before planning a sync — both numbers move, and the second one is the
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
that resolves to packages that do not exist. Start from **upstream's** lockfile,
not ours:

```bash
git show upstream/main:bun.lock > bun.lock
bun install
bun install --frozen-lockfile   # must say "no changes" before you go further
```

Starting from ours was the instruction here until 2026-10-11, and it is the
wrong half to keep. Upstream bumps the ranges of the dependencies both sides
share (the whole AI SDK family, in that sync), and a lockfile that does not
already pin them resolves each to the newest release in range: `@ai-sdk/anthropic`
came out at 4.0.78 where upstream had tested 4.0.67, and the empty-turn retry
and the transcription tests failed on versions nobody had run. From upstream's
pins the only thing that moves is what this fork alone depends on — one package
(`@napi-rs/canvas`, a patch level) in that sync. Check that the three
`patchedDependencies` still name versions the lockfile resolves.

On solidPC the install needs `--ignore-scripts`: `better-sqlite3`'s prebuilt
binding wants glibc 2.33 and the host has 2.31. The repo pins a Bun newer than
the host's; fetch the pinned one somewhere disposable to run the frozen check
with it (`npm install --prefix <dir> bun@<pin>`), and leave the global one alone.

## Upstream fixes the same things

By the 2026-10-11 sync the two trees had solved the same problems separately,
and this is now the common case, not the exception: the compaction trigger from
provider-reported tokens, recovery of a truncated turn, team state persistence,
turn generations in the extension, a silent terminal command, the default
output cap. Git reports these as conflicts at best and merges them cleanly at
worst — two retry layers, two reasoning counters, a constant that one side
raised and the other built a ladder on.

For each one, decide which implementation stays, **then delete the other's
tests or rewrite them to the rule that stays**. A test left asserting the
behaviour that was not taken fails for the next person with no trace of why.
What was decided in that sync, and why, is in the merge commit's message.

Three things that sync found only by running the suites, none of which a
typecheck reports:

- A value upstream changed in a file this fork did not touch merges silently
  and overrides a design built on the old value (the compaction summary floor;
  the default output cap raised to a share of the model's ceiling).
- A cap upstream added for its own reasons can cut something this fork routes
  through the same field: run records were limited to 4,000 characters of
  answer, and a teammate's report read through `read_agent_report` ended there
  saying it was "the end of the report".
- Upstream removes plumbing it has retired that this fork still stands on. The
  Focus Chain removal (`5dea21ab89`) took the `task_progress` message type and
  the settings proto that the task-progress checklist uses; the files had not
  conflicted. Search the upstream log for `Remove` before trusting a clean
  merge, and reverse the parts that are still load-bearing here.

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

## The desktop app is carried, not shipped

`apps/examples/desktop-app` (`@cline/code`) is upstream's desktop product: a
Tauri shell, a Bun sidecar and a Next.js UI on the workspace's own `@cline/core`.
This fork has never changed a file in it, so it merges without a conflict, and
that is the reason it stays: take upstream's copy whole on every sync and do
not edit it. Cerebriline does not ship a desktop app, so three things are left
out each time, and each will come back with the merge:

- the docs pages (`docs/usage/cline-desktop*.mdx`, `docs/assets/desktop/`),
  their group in `docs/docs.json`, and the links to them from
  `cline-overview.mdx`, `getting-started/installing-cline.mdx` and
  `usage/cloud-agents.mdx`;
- any "desktop app" wording in the root `README.md`, which is ours anyway;
- the workflows `desktop-publish.yml` and `desktop-test.yml`, which stay in the
  tree and stay disabled on the fork.

As of 2026-10-11 it typechecks and builds its sidecar and web UI against this
fork's core. A Cerebriline desktop app would be a rebrand of this tree, and is
its own project, not part of a sync.

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
2. `bun run build:sdk`, then `npx tsc --noEmit` in each of `sdk/packages/{shared,llms,agents,core}`
   and `apps/cli`. Build first: the packages typecheck against each other's
   `dist`, and the bundler rejects things `tsc` accepts (a declaration merged
   in twice, a comment that lost its opening line).
3. `cd apps/vscode && bun run check-types` — five minutes; it is the only thing
   that catches a proto gap, because the generated protos are gitignored.
4. `npx vitest run` in every package, not only core: `shared`, `llms`, `agents`,
   `core` (`--config vitest.config.ts`), `apps/cli`, `apps/vscode`
   (`--config vitest.config.ts`) and `apps/vscode/webview-ui`. **vitest, not
   `bun test`**, which invents failures in this repo — except
   `bun scripts/run-bun-unit-tests.ts` in `apps/vscode`, which is its own
   suite. The mocha tests need the extension host and run in CI only.
5. `bun run check` from the root for the SDK and CLI (`biome check`), and
   `bun run lint` in `apps/vscode` — `bun run package` runs that one, so a
   failure there is a failed release build.
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
