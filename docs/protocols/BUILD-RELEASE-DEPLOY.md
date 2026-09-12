# Build → release → deploy, for this fork

The cycle for `mann1x/cline`: build a VSIX, cut a GitHub release, install it on
the test host. Written down 2026-09-11 after being re-derived from memory for
the seventh time.

**This is not `.claude/commands/release.md`.** That file is upstream Cline's
marketplace workflow — publish from `main`, trigger
`ext-vscode-publish-stable.yml`, edit notes with `gh release edit`. We do not
publish to the marketplace and we do not release from `main`. If you followed
that file you are in the wrong procedure.

## Where things are

| | |
|---|---|
| Build tree | `/srv/dev-disk-by-label-opt/dev/cline` |
| Release branch | `mann1x/full-build-release` |
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

On `mann1x/full-build-release`. Every commit must stand alone — the pre-commit
typecheck sees untracked files, so splitting a change across commits fights the
hook.

### 2. Bump and commit the version

```bash
cd apps/vscode && python3 - <<'PY'
import re; p='package.json'; s=open(p).read()
s2, n = re.subn(r'("version":\s*)"4\.100\.90"', r'\1"4.100.91"', s, count=1)
assert n == 1, "version line not matched"     # never a blind sed
open(p,'w').write(s2)
PY
git commit -am "release: 4.100.91"
```

### 3. Build the VSIX

```bash
cd apps/vscode && bun run package && \
  bunx vsce package --no-dependencies --allow-package-secrets sendgrid \
    --out "cline-mann1x-4.100.91.vsix"
```

**`--out` is not optional.** With no `--out`, vsce names the file from
`package.json` — and this fork has never changed `name` from upstream's
`claude-dev`, so you get `claude-dev-<version>.vsix`. That is upstream's
identity on a fork's release asset. It happened: v4.100.86 was correctly
`cline-mann1x-4.100.86.vsix`, and v4.100.99 through v4.100.104 all shipped as
`claude-dev-<version>.vsix` because this line had no `--out`.

**The artefact is always `cline-mann1x-<version>.vsix`.** Check the name before
going further — the wrong one builds and uploads perfectly happily:

```bash
ls -l apps/vscode/cline-mann1x-4.100.91.vsix   # must exist, by that exact name
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

### 4. Push, tag, release

```bash
git push origin HEAD:mann1x/full-build-release
git tag -a v4.100.91 -m "v4.100.91" && git push origin v4.100.91
gh release create v4.100.91 \
  apps/vscode/cline-mann1x-4.100.91.vsix --repo mann1x/cline \
  --title "v4.100.91" --notes-file <notes>
```

**Name the file, never glob it.** `apps/vscode/*4.100.91.vsix` uploads whatever
is on disk, which is exactly how the `claude-dev-*` assets got published without
anyone noticing. Spelling the name out makes a mis-named build fail here instead
of shipping.

**Better: don't do this by hand.** `.github/workflows/fork-release.yml` does the
whole of steps 3 and 4 — it computes the name, asserts it, refuses a stray
second `.vsix`, and uploads by exact path. Push the tag and it runs:

```bash
git push origin HEAD:mann1x/full-build-release
git tag -a v4.100.91 -m "v4.100.91" && git push origin v4.100.91   # this releases
```

It also refuses to release if the tag and `apps/vscode/package.json` disagree.
Use the manual path only when Actions is unavailable on the fork.

Merge to `main` as well when the raw-URL tools need to see the change — `main`
is what those fetch from, and it has sat hundreds of commits behind before.

### 5. Verify the artefact, not the build log

Download the published asset back and compare `sha256sum` to the local file.
Then grep the packaged `extension.js` for a string that only exists in this
change. A build that "succeeded" and a bundle that carries the code are
different claims.

### 6. Deploy to pandorum

```bash
scp apps/vscode/cline-mann1x-4.100.91.vsix \
  'pandorum:C:/Users/manni/Downloads/cline-mann1x-4.100.91.vsix'
ssh pandorum 'powershell -NoProfile -Command "code --install-extension C:/Users/manni/Downloads/cline-mann1x-4.100.91.vsix --force"'
```

**Always the full path.** Path stripping is a standing rule, and the installer
fails confusingly without it. The `url.parse()` deprecation spew from the `code`
CLI is normal noise, not a failure.

### 7. Verify the install, then say to reload

```bash
ssh pandorum 'powershell -NoProfile -Command "Get-ChildItem C:/Users/manni/.vscode/extensions -Directory -Filter *claude-dev* | Sort-Object Name | Select-Object -Last 3 Name,CreationTime"'
```

Hash the **installed** `dist/extension.js` on pandorum and compare it to the
bundle you grepped, rather than trusting the installer's success message. Then
tell the maintainer to **Reload Window** — VS Code does not pick it up on its
own, and the old version's folder stays on disk until restart.

## What installing does NOT touch

The harness runs the **CLI** (`apps/cli/src/index.ts`) on solidPC, not the VS
Code extension on pandorum. Installing a VSIX therefore cannot disturb an
in-flight harness run. Rebuilding the harness tree can, which is why the rule
above is about the tree and not about the install.
