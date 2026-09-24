# Command-sandbox binaries

This folder ships the native binaries that isolate a **delegated agent's shell
commands**. When the "Agents can run commands" feature is on, a delegate's
commands are launched through `sandbox-launch.exe`, which injects `hook.dll`
into the command process and every process it spawns; the hook redirects the
tree's file operations into the agent's private overlay, so the commands touch a
copy of the workspace and never the real one.

The host (`local-runtime-host.ts` → `resolveSandboxBinaries`) looks for these
files here at runtime. If they are missing for the platform, delegated agents
get file-tool isolation but **no shell** — never an unsandboxed one — so a build
that omits them is safe, just less capable.

## Expected files

| file | platform | purpose |
|---|---|---|
| `sandbox-launch.exe` | win32 (x64) | starts the command with the hook loaded, re-injects into children |
| `hook.dll` | win32 (x64) | the injected file-redirection hook (Microsoft Detours) |

Other platforms have no launcher yet; the feature stays file-isolation-only
there by design.

## Building (Windows, on `pandorum`)

The source and build script live in the repo at `sandbox/w1-spike/`. On a
Windows box with Visual Studio's C++ toolset:

```bat
cd sandbox\w1-spike
build.bat
```

`build.bat` clones Microsoft Detours (MIT), compiles the five Detours TUs
directly with `cl` (bypassing its `nmake`, which the newer toolset rejects),
then builds `hook.dll` and `sandbox-launch.exe`. Copy the two artifacts into
this folder:

```bat
copy sandbox\w1-spike\hook.dll            apps\vscode\assets\sandbox\
copy sandbox\w1-spike\sandbox-launch.exe  apps\vscode\assets\sandbox\
```

Then build the vsix as usual (`bun run build:sdk` first — the vsix bundles core
from `dist`). `.vscodeignore` already re-includes `assets/sandbox/**`, so the
binaries ride along.

## Note

These binaries are x64. An ARM64 Windows host would need its own build; until
then it falls through to file-isolation-only, the same as Linux and macOS.
