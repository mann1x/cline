# Build → release → deploy, for this fork

The cycle for `mann1x/cline`: build a VSIX, cut a GitHub release, install it on
the test host. Written down 2026-09-11 after being re-derived from memory for
the seventh time. **Revised 2026-09-14**, when `main` became the trunk.

**This is not `.claude/commands/release.md`.** That file is upstream Cline's
marketplace workflow — publish from `main`, trigger
`ext-vscode-publish-stable.yml`, edit notes with `gh release edit`. We do not
publish to the marketplace, and although we now develop on `main` the rest of
that file still does not apply. If you followed it you are in the wrong
procedure.

## Which branch does what

| | |
|---|---|
| **Develop on** | `main`. Everything lands here: extension, CLI, SDK, docs, `tools/`, `harness/`. |
| **Release from** | `mann1x/full-build-release`, fast-forwarded from `main` at release time and tagged there. |

The release branch is a **cut**, not a second trunk. It exists so a tag names a
frozen ref rather than a moving one, and so a half-finished merge on `main`
cannot become a release by accident. It should never hold a commit `main` does
not — if `git rev-list --count main..mann1x/full-build-release` is not zero,
something was committed in the wrong place and belongs on `main` first.

## Where things are

| | |
|---|---|
| Build tree | `/srv/dev-disk-by-label-opt/dev/cline`, on `main` |
| Release branch | `mann1x/full-build-release` (cut from `main`) |
| Harness tree — **do not build here** | `/shared/dev/cline-scan`, on `mann1x/scan-analysis` |
| Test host | `pandorum` (Windows; `ssh` lands in `cmd`, so use `powershell -NoProfile -Command`) |
| Repo for releases | `mann1x/cline` |

## The standing exception: the harness tree

`native.sh` loads the CLI from `apps/cli/src/index.ts` in `/shared/dev/cline-scan`
at the start of **every run**. Two rules follow, and both have cost us a run:

- **Never build in that tree.** `bun run package` starts with `build:sdk`, which
  rewrites `sdk/packages/*/dist` — the exact files a running experiment is
  executing from.
- **Never fast-forward `mann1x/scan-analysis` while a batch is in flight.** It
  swaps the code under a live experiment. Do it when the batch closes, and say
  so rather than doing it silently.

Check before starting: a run in flight means `native.sh` is alive and the newest
directory under `runs-native/` has a `run.jsonl` written in the last few minutes.

## The cycle

### 1. Commit the work

On `main`. Every commit must stand alone — the pre-commit typecheck sees
untracked files, so splitting a change across commits fights the hook.

### 2. Bump and commit the version

```bash
cd apps/vscode && python3 - <<'PY'
import re; p='package.json'; s=open(p).read()
s2, n = re.subn(r'("version":\s*)"4\.100\.90"', r'\1"4.100.112"', s, count=1)
assert n == 1, "version line not matched"     # never a blind sed
open(p,'w').write(s2)
PY
git commit -am "release: 4.100.112"
```

**Then check the lockfile resolves before you tag:**

```bash
bun install --frozen-lockfile   # must say "no changes"
```

The release job runs exactly this, and it is the last thing that can fail
*after* a tag is pushed. `bun.lock` records each workspace's `name` and
`version`; a version drift it tolerates, but a **renamed** package it does not —
the name is the key for that package and every one of its dependency entries.
v4.100.112's first tag died here, because `apps/vscode` became `cerebriline`
while the lockfile still keyed the graph under `claude-dev`. Ten seconds here
saves a five-minute round trip and a re-tag.

### 3. Write the release notes

`release-notes/<version>.md`, committed alongside the version bump. **This is the
one text a release needs you to write**, and it feeds two places at once:

- the **GitHub release body**, and
- the **Changelog tab** of the Open VSX / Marketplace listing, via
  `apps/vscode/CHANGELOG.md` baked into the `.vsix`.

They cannot diverge, because both are generated from the same file.

```bash
$EDITOR release-notes/4.100.117.md
git add release-notes/4.100.117.md && git commit -m "release: 4.100.117"
```

Write it as ordinary markdown starting at `##` — the generator demotes headings
one level so they nest under the version heading, and strips the auto-generated
**Full Changelog** line.

**A release with no notes does not build.** The generator exits non-zero, before
anything is packaged, rather than shipping a version whose changelog entry is
blank. If you would rather not keep a file, annotate the tag instead — the
resolution order is:

1. `--pending-notes <file>`
2. `release-notes/<version>.md`
3. the annotated tag message for `v<version>`

To regenerate by hand, or to preview before tagging:

```bash
node apps/vscode/scripts/generate-fork-changelog.mjs \
  --pending-version 4.100.117 --emit-notes /tmp/body.md
```

Past entries come from the GitHub releases API; only the release being built is
read locally, because the workflow packages the `.vsix` **before** it creates
that release.

**Do not point any of this at the repo-root `CHANGELOG.md`.** That one is
upstream Cline's (`4.1.x`) and describes releases this extension never shipped.

### 4. Build the VSIX

```bash
cd apps/vscode && bun run package && \
  bunx vsce package --no-dependencies --allow-package-secrets sendgrid \
    --out "cerebriline-4.100.112.vsix"
```

**`--out` is not optional.** With no `--out`, vsce names the file from
`package.json`. That is now `cerebriline`, so the default finally happens to be
right — but it is right by coincidence, and the coincidence is one
`package.json` edit away from ending. That is upstream's
identity on a fork's release asset. It happened: v4.100.86 was correctly
`cline-mann1x-4.100.86.vsix`, and v4.100.99 through v4.100.104 all shipped as
`claude-dev-<version>.vsix` because this line had no `--out`.

**The artefact is always `cerebriline-<version>.vsix`.** (It was
`cline-mann1x-<version>.vsix` until 2026-09-14, when the extension became
`mann1x.cerebriline`; releases before v4.100.112 carry the old name.) Check the name before
going further — the wrong one builds and uploads perfectly happily:

```bash
ls -l apps/vscode/cerebriline-4.100.112.vsix   # must exist, by that exact name
ls apps/vscode/*.vsix                          # must list nothing else
```

`package` is `build:sdk && check-types && build:webview && lint && esbuild`. It
**builds only** — it does not produce a `.vsix`; `vsce package` is a separate
step.

**`check-types` takes over five minutes** (protos, two `tsc --noEmit` passes,
a compat check, then the webview's own). Run the build detached and wait on a
sentinel. Do not background it with a trailing `&` *inside* another backgrounded
call — the outer shell exits and takes the build with it, and you get a silent
exit 0 with no artefact. Confirm `dist/extension.js` exists and is newer than the
commit before believing a success.

### 5. Push, tag, release

```bash
git push origin main                                    # the trunk first
git push origin main:mann1x/full-build-release          # cut the release branch
git tag -a v4.100.112 -m "v4.100.112" && git push origin v4.100.112
gh release create v4.100.112 \
  apps/vscode/cerebriline-4.100.112.vsix --repo mann1x/cline \
  --title "v4.100.112" --notes-file release-notes/4.100.112.md
```

**Name the file, never glob it.** `apps/vscode/*4.100.112.vsix` uploads whatever
is on disk, which is exactly how the `claude-dev-*` assets got published without
anyone noticing. Spelling the name out makes a mis-named build fail here instead
of shipping.

**Better: don't do this by hand.** `.github/workflows/fork-release.yml` does the
whole of steps 4 and 5 — it computes the name, asserts it, refuses a stray
second `.vsix`, and uploads by exact path. Push the tag and it runs:

```bash
git push origin main
git push origin main:mann1x/full-build-release
git tag -a v4.100.112 -m "v4.100.112" && git push origin v4.100.112   # this releases
```

Push `main` **before** the release branch, and the release branch before the
tag. The cut must be a fast-forward of the trunk, and a tag that names a commit
the trunk does not have is how the two drift apart again.

It also refuses to release if the tag and `apps/vscode/package.json` disagree.
Use the manual path only when Actions is unavailable on the fork.

No separate step is needed to reach the raw-URL tools any more: `tools/` lives
on `main` and `main` is what those fetch. That was not true until 2026-09-14,
and it cost us twice — a report collector three revisions stale, and
`Migrate-ToCerebriline.ps1` shipped as a release asset while being absent from
the tree for two days. If you ever find yourself pushing only to the release
branch, that is the bug.

### 6. Verify the artefact, not the build log

Download the published asset back and compare `sha256sum` to the local file.
Then grep the packaged `extension.js` for a string that only exists in this
change. A build that "succeeded" and a bundle that carries the code are
different claims.

**Check the listing files too.** The Overview and Changelog tabs are rendered
from `readme.md` and `CHANGELOG.md` *inside the `.vsix`*, and both were shipping
empty or absent up to 4.100.116 without anything failing:

```bash
# vsce lower-cases both names inside the package.
unzip -p "$VSIX" extension/readme.md    | wc -c    # must not be 0
unzip -p "$VSIX" extension/changelog.md | head -8  # must name this version
```

A zero-byte `readme.md` is the signature of the README swap not running;
`apps/vscode/README.md` is an empty upstream placeholder and is what vsce picks
up when `scripts/marketplace-readme.mjs swap-in` has not been called.

**Check the command-sandbox binaries are in the package.** The delegated-agent
command sandbox is a set of native launchers shipped under
`apps/vscode/assets/sandbox/` and kept in the `.vsix` by the single
`!assets/sandbox/**` line in `.vscodeignore`. They are code the bundle carries,
not code esbuild compiles, so `check-types` and the esbuild step pass whether or
not they made it in — a missing binary is invisible until an agent tries to run
a command on the affected OS. Assert them by name:

```bash
unzip -l "$VSIX" | grep -E \
  'assets/sandbox/(sandbox-launch\.exe|hook\.dll|cerebriline-sandbox-(x64|arm64))'
# expect FOUR lines: the Windows pair AND both Linux launchers.
```

The host (`resolveSandboxBinaries`, `local-runtime-host.ts`) resolves per OS:
**win32** needs *both* `sandbox-launch.exe` and `hook.dll`; **linux** needs
`cerebriline-sandbox-x64` or `-arm64` (arch-suffixed, flat `cerebriline-sandbox`
tolerated). macOS has no backend yet, by design. Miss the pair for an OS and
that OS silently loses `run_commands` for delegated agents — the launcher
resolves to `undefined`, the shell is withheld, and only the pure-path-rewrite
**overlay** (file isolation) still works. So the count is load-bearing: three
lines, not four, means the Linux launchers didn't rebuild into `assets/` before
packaging (they are produced by `sandbox/cerebriline-sandbox/build.sh`, not by
`bun run package`), and a Windows-only `.vsix` is the result. Rebuild the
launchers into `assets/sandbox/` and repackage rather than shipping the short
set.

### 7. Deploy to pandorum

```bash
scp apps/vscode/cerebriline-4.100.112.vsix \
  'pandorum:C:/Users/manni/Downloads/cerebriline-4.100.112.vsix'
ssh pandorum 'powershell -NoProfile -Command "code --install-extension C:/Users/manni/Downloads/cerebriline-4.100.112.vsix --force"'
```

**Always the full path.** Path stripping is a standing rule, and the installer
fails confusingly without it. The `url.parse()` deprecation spew from the `code`
CLI is normal noise, not a failure.

### 8. Verify the install, then say to reload

```bash
ssh pandorum 'powershell -NoProfile -Command "Get-ChildItem C:/Users/manni/.vscode/extensions -Directory -Filter *cerebriline* | Sort-Object Name | Select-Object -Last 3 Name,CreationTime"'
```

Hash the **installed** `dist/extension.js` on pandorum and compare it to the
bundle you grepped, rather than trusting the installer's success message. Then
tell the maintainer to **Reload Window** — VS Code does not pick it up on its
own, and the old version's folder stays on disk until restart.

## How users get the update

Three channels, and only the first is automatic on stock VS Code.

**The extension's own update check.** VS Code auto-updates extensions it
installed from a *gallery* and nothing else: a `.vsix` install is recorded with
`source: "vsix"` and is never looked at again. That is why 4.100.80 through .86
once sat unpacked side by side on pandorum, each arriving by `--force` and none
superseding anything. So the extension checks for itself —
`apps/vscode/src/services/updates/`. Once a day it reads
`repos/mann1x/cline/releases/latest`, and when the tag is newer than the running
build it offers to install: the `.vsix` is downloaded to the extension's own
global storage, its SHA-256 is compared against the `digest` GitHub published
with the asset, and only then does it reach
`workbench.extensions.installExtension`. Nothing is installed unverified and
nothing is installed silently unless the user set `cerebriline.updates` to
`auto`; the default is `notify`. `Cerebriline: Check for Updates` runs it on
demand and, unlike the scheduled check, says so when there is nothing to report.

Two consequences for this procedure. The release must carry the `.vsix` under
its exact expected name — the updater matches `cerebriline-*.vsix` and ignores
everything else, so a mis-named asset is invisible to it rather than wrong. And
a release published as a **draft or pre-release** will not be offered at all:
`releases/latest` skips both.

**Open VSX.** Published automatically by `fork-release.yml` when the `OVSX_PAT`
secret is set, and skipped in silence when it is not — the GitHub release is the
artefact of record either way, and an Open VSX outage must never lose a tag
that has already been pushed. VSCodium, Cursor, Windsurf and Gitpod use Open VSX
as their gallery, so a build published there is auto-updated by those editors
the ordinary way, and the extension's own check then finds the versions equal
and stays quiet.

Setup is **done** — the `mann1x` namespace was created on 2026-09-14 and the
token is stored as the `OVSX_PAT` repository secret, so nothing is needed per
release. If the namespace ever has to be recreated, or the token rotated:

```bash
OVSX_PAT=<token> npx ovsx create-namespace mann1x        # once, ever
gh secret set OVSX_PAT --repo mann1x/cline < token.txt   # never in argv
```

The first release through this path is the one to watch: the Open VSX step is
`continue-on-error`, so a rejection there will not fail the run and will not be
obvious. Check the step's log once.

**The VS Code Marketplace: no.** Upstream Cline is there and one of us there is
enough. This is a decision rather than a constraint — since the rename to
`mann1x.cerebriline` the extension *could* be published under its own publisher
— so if it is ever revisited, revisit it here.

## What installing does NOT touch

The harness runs the **CLI** (`apps/cli/src/index.ts`) on solidPC, not the VS
Code extension on pandorum. Installing a VSIX therefore cannot disturb an
in-flight harness run. Rebuilding the harness tree can, which is why the rule
above is about the tree and not about the install.
