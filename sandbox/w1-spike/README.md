# W1 file-sandbox spike

A per-agent copy-on-write view of the workspace for Cerebriline's delegated
sub-agents, built by injecting a small file-redirect DLL into the agent's own
command processes (the "W1" approach). Same technique as Microsoft BuildXL's
sandbox and VFS for Git; [Microsoft Detours](https://github.com/microsoft/Detours)
(MIT) does the injection and process-tree propagation.

Every command an agent runs, and every process it spawns, sees the workspace
through an overlay: reads fall through to the lead's version, writes are copied
up into a private per-agent folder, and the real workspace is never touched.
At the end, the overlay folder *is* the agent's change set to hand back.

## Files

| file | what |
|---|---|
| `hook.cpp` | the injected DLL: redirect, copy-up, whiteout, stat, directory merge, child re-inject |
| `launcher.cpp` | `sandbox-launch.exe` — starts a command with the DLL loaded |
| `hook.def` | exports `DetourFinishHelperProcess @1` (required by Detours) |
| `build.bat` | clones + builds Detours (directly with `cl`, not its nmake), then the DLL and launcher |
| `test.bat` | milestone 1 — injection + whole-tree logging |
| `test2.bat` | milestone 2 — transparent redirect through the real path |
| `test3.bat` | milestone 3 — read fall-through, write isolation, copy-up, fresh create |
| `test4.bat` | milestone 4a — deletes as whiteouts, `stat`/`exists` correctness, re-create |
| `test5.bat` | milestone 4b — directory-listing merge (node readdir + cmd dir) |
| `test6.bat` | milestone 4c — rename isolation (workspace untouched, source whiteouted) |

## Build (on a Windows box with VS + git)

```
build.bat
```

Produces `hook.dll` and `sandbox-launch.exe`. Built and tested on pandorum
(VS 18 / toolset 14.50, git 2.55, node v26.4.0, NTFS, non-admin).

## Run

```
set CEREBRILINE_WS_ROOT=C:\path\to\workspace
set CEREBRILINE_OVERLAY_ROOT=C:\path\to\agent\overlay
sandbox-launch.exe hook.dll run.log <command...>
```

The command (and its whole process tree) reads/writes the workspace path but
lands in the overlay. `CEREBRILINE_SANDBOX_LOG` (the `run.log` arg) receives a
UTF-16 trace of every open and each redirect/whiteout.

## What is proven

- Injection into the agent's command and every child/grandchild; **ESET did not
  flag it** (we only inject into our own processes).
- A command opening the real absolute workspace path transparently gets the
  agent's copy.
- Reads of unchanged files fall through to the workspace; writes copy up and are
  isolated; new files and nested dirs land in the overlay.
- Deletes become `.wh.<name>` whiteouts; the workspace file survives;
  `exists`/`stat` and directory listings honour the deletion; re-creating works.
- Renames are isolated: the target is rerouted into the overlay and the source
  is whiteouted, so `MoveFile`/`rename` never writes the workspace.
- Directory listings show the merged workspace+overlay view (both `node`'s
  `readdir` via `NtQueryDirectoryFile` and `cmd`'s `dir` via
  `NtQueryDirectoryFileEx`), minus whiteouts and tombstones.
- The overlay folder's contents (excluding `.wh.*`) are exactly the agent's
  change set for the hand-back to the lead.

## Known gaps (before production)

- 8.3 short names are zeroed in the `*BothDir` info classes.
- Directory queries with a specific wildcard (not `*`) fall through unmerged.
- Case-insensitive matching is assumed (NTFS default).

## Next: extension integration

Ship the binary in the vsix; run each delegated agent's `run_commands` through
`sandbox-launch` with a per-agent overlay folder in extension storage; fold the
overlay's changed files into the lead's revision log as `#N`-from-agent
snapshots; gate it on a Features **"agents can run commands"** toggle.
