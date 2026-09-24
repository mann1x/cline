# Command-sandbox binaries

This folder ships the native launchers that isolate a **delegated agent's shell
commands**. When the "Agents can run commands" feature is on, a delegate's
commands run through the `cerebriline-sandbox` launcher for the host platform, so
the command tree sees the agent's private copy-on-write overlay of the workspace
and never touches the real one — the same isolation the in-process file tools get.

The host (`local-runtime-host.ts` → `resolveSandboxBinaries`) looks for these
files here at runtime. If they are missing for the platform, delegated agents get
file-tool isolation but **no shell** — never an unsandboxed one — so a build that
omits them is safe, just less capable.

## Expected files

| file | platform | backend |
|---|---|---|
| `cerebriline-sandbox-x64` | linux x64 | L1 userns+overlayfs / L2 ptrace |
| `cerebriline-sandbox-arm64` | linux arm64 | L1 userns+overlayfs |
| `cerebriline-sandbox-darwin-x64` | macOS x64 | M1 APFS clonefile |
| `cerebriline-sandbox-darwin-arm64` | macOS arm64 | M1 APFS clonefile |
| `cerebriline-sandbox.exe` | win32 x64 | W1 Detours injection |
| `hook.dll` | win32 x64 | the injected file-redirection hook (Microsoft Detours) |

## Do not edit these by hand

These binaries are **built and committed by CI** — `.github/workflows/sandbox-binaries.yml`
builds each launcher on its own native runner (Linux, macos-14, windows-latest)
whenever the sandbox source under `sandbox/` changes, and commits the refreshed
bytes here. A release just packages them; it never rebuilds. To change a
launcher, change its source under `sandbox/cerebriline-sandbox/` (or the C++
`hook.dll` under `sandbox/w1-spike/`) and let CI refresh this folder.

The full build recipe — including the by-hand build on `pandorum` for Windows —
is in `docs/protocols/BUILD-RELEASE-DEPLOY.md` under *The command-sandbox
binaries*, and the backend design is in `sandbox/cerebriline-sandbox/README.md`.
`.vscodeignore` re-includes `assets/sandbox/**`, so these ride along in the vsix.
