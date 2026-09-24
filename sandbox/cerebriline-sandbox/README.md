# cerebriline-sandbox

The command-sandbox launcher for Cerebriline's delegated agents. It runs a
command — and its whole process tree — against a per-agent copy-on-write overlay
of the workspace, so the agent's shell work shares the same private view as its
in-process file tools and never touches the lead's files.

One binary, one CLI, a per-OS backend chosen at build time. It is the launcher
`wrapSpawn` (`sdk/.../runtime/sandbox/agent-sandbox.ts`) points `run_commands`
at; the overlay it produces is read back by the in-process `AgentOverlay` for the
hand-back, so both halves share the exact `.wh.<name>` on-disk format.

## Backends

| OS | backend | status |
|---|---|---|
| Linux | **L1** — user namespace + overlayfs over the workspace path | **done** (`src/linux.rs`) |
| Windows | W1 — Detours DLL injection (`../w1-spike`, C++) | shipped separately as `sandbox-launch.exe` + `hook.dll`; folding it in here is planned |
| macOS | M1 — APFS clonefile | planned |

See PLANS.md §10 for the full design and the per-OS ladder.

### Linux L1 detail

The launcher forks; the child unshares a user + mount namespace, maps itself to
root in it, mounts a **tmpfs** for the overlay upper/work (a self-owned tmpfs is
accepted as an unprivileged overlay upper where a disk directory is refused with
"failed to set xattr on upper"), mounts overlayfs `lowerdir=workspace,
upperdir=tmpfs` **over the workspace path itself** so absolute paths resolve to
the agent's view, then runs the command in a grandchild. When it exits, the child
unmounts the overlay (so the pristine lower is visible again) and reconciles the
tmpfs upper into the persistent overlay root in `.wh.` format: written files copy
in, `0:0`-chardev whiteouts become empty `.wh.<name>` markers.

The upper is transient RAM (capped by `CEREBRILINE_SANDBOX_TMPFS_SIZE`, default
`4g`; `default` uses the kernel's own 50%-of-RAM cap); the durable result is on
disk in the overlay root.

Requires unprivileged user namespaces (kernel ≥ 5.11). Where they are blocked
(e.g. AppArmor on Ubuntu 24.04+), the mount fails and the launcher exits non-zero
rather than run the command unsandboxed — the caller then withholds the shell.

**Known L1 limitation — exotic lower filesystems.** On a few filesystems the
kernel's overlayfs copy-up of a lower file into the tmpfs upper fails with
`EOVERFLOW` ("Value too large for defined data type") the moment a command
modifies a file it has not already touched with a tool. Observed on an ext4
volume carrying project/user/group quotas (`jqfmt=vfsv0`) on top of bcache;
**not** on plain ext4, btrfs, xfs or tmpfs — i.e. not on a typical workspace.
Such a host is also the one that refuses a disk overlay upper ("failed to set
xattr on upper"), so it is doubly hostile to unprivileged overlayfs and is
exactly the case the **L2** (seccomp-notify) backend exists to cover. Until L2
lands, a command's copy-up failure surfaces as that command's own error and does
not corrupt anything.

## Invocation

```text
cerebriline-sandbox <hook> <log> <command> [args...]
```

with `CEREBRILINE_WS_ROOT` and `CEREBRILINE_OVERLAY_ROOT` set, and optionally
`CEREBRILINE_SANDBOX_LOG` (overrides `<log>`). `<hook>` is the injected library
the Windows backend needs and every other backend ignores; it stays positional so
one `wrapSpawn` shape drives every platform.

## Build

```
./build.sh            # release build for the host target
cargo test --release  # reconcile unit tests + the L1 integration test
```

The build has **no external crate dependencies** (the Linux backend declares the
handful of libc entry points it needs directly), so it compiles offline with a
bare toolchain. Ship the resulting `target/release/cerebriline-sandbox` into
`apps/vscode/assets/sandbox/`.
