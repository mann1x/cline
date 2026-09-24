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
| Linux | **L2** — ptrace path rewriting (fallback when L1 can't run) | **done**, x86_64 (`src/linux_l2.rs`, `src/resolve.rs`) |
| Windows | **W1** — Detours DLL injection | **done** (`src/windows.rs` — the launcher folded in here; the C++ `hook.dll` in `../w1-spike` is unchanged); verified on a `windows-latest` runner in CI (`sandbox-test.yml`) |
| macOS | **M1** — APFS clonefile | **done**, x86_64 + arm64 (`src/macos.rs`); verified on a real Apple-Silicon runner in CI (`sandbox-test.yml`) |

Backend selection is automatic: `CEREBRILINE_SANDBOX_BACKEND=auto` (the default)
uses **L1** where unprivileged user namespaces are available and **L2** where
they are not; `l1`/`l2` force one. A workspace on an overlayfs-hostile filesystem
(the copy-up EOVERFLOW below) is the one case `auto` does not detect — force `l2`
there.

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
exactly the case the **L2** backend covers.

### Linux L2 detail

L2 is a ptrace supervisor (like proot). ptrace is used, not seccomp
user-notification, because path redirection has to **rewrite** a syscall's
arguments before it runs, which seccomp-notify cannot do. The supervisor traces
the command and every descendant (`PTRACE_O_TRACEFORK|VFORK|CLONE|EXEC`); on each
path-bearing syscall it resolves the path against the overlay (`src/resolve.rs`,
the same `.wh.` semantics as the in-process overlay) and either:

- **rewrites** the path argument to the overlay copy — open (with copy-up on a
  write intent), stat/lstat/newfstatat/statx, access/faccessat, readlink, mkdir,
  and their `*at` forms — writing the new path into the tracee's stack scratch
  below the red zone;
- **reads through** to the workspace (an untouched file), by leaving the arg; or
- **neutralises and emulates** — unlink/rmdir/rename become a no-op syscall plus
  a userspace overlay op (a delete leaves a `.wh.` whiteout), by setting an
  invalid syscall number at entry and forcing the return value at exit.

Writes land directly in the overlay in `.wh.` format, so there is no reconcile
step and the hand-back is unchanged. It needs no user namespace and no special
filesystem, so it covers AppArmor-locked hosts and overlayfs-hostile
filesystems alike.

**Scope / gaps (x86_64 only for now):** symlink following in the tracee's view is
lexical, not resolved; a few rarer path syscalls (link, symlink, chdir-relative
edge cases, `*at` with an O_PATH dirfd) are not intercepted. These are tracked in
PLANS.md §10.

### macOS M1 detail

macOS gives an unprivileged process no mount namespace, and SIP strips
`DYLD_INSERT_LIBRARIES` from `/bin/sh` and every system binary, so neither the L1
overlay-over-the-path trick nor a DYLD-interpose redirect is available. M1 is a
block-level copy-on-write clone instead: `clonefile(2)` clones the whole workspace
tree to a hidden sibling on the same APFS volume instantly and copies no data (the
blocks are shared until written), the agent's existing overlay is laid onto the
clone (a prior tool's file becomes visible, a prior tool's deletion is removed) so
the shell shares the tools' view, the command runs with its **cwd at the clone
root**, and the change set is recovered afterwards by **diffing the clone against
the workspace** — there is no kernel whiteout to read, so the reconcile is a tree
diff that writes the same `.wh.` format (a changed file copies out, a deleted one
becomes an empty `.wh.<name>` marker). An unchanged file is still block-shared and
is skipped, exactly as the in-process `changedFiles()` skips a copy-up equal to the
lower.

**Known M1 limitation — runtime-constructed absolute paths.** Redirection is by
cwd and by rewriting workspace-rooted paths in the command's **argv**, so the
common case — the model writing `/Users/…/ws/x.html` straight into the command — is
redirected to the clone. A path the command *constructs* at run time (a shell
`$WS/x` expansion, a path a script builds from an env var) is not in the launcher's
argv and still resolves to the real workspace. This is the one platform where
absolute-path fidelity is lost; the alternatives (DYLD interpose, an FSKit
filesystem) are dead under SIP or too heavy, so it is documented and accepted
rather than worked around. `clonefile` is same-volume only, so the clone is a
sibling of the workspace; on a non-APFS volume the clone fails and the launcher
exits non-zero rather than run the command unsandboxed.

Because no macOS host exists in development, the M1 backend is verified only in CI:
`.github/workflows/sandbox-test.yml` builds and runs `tests/macos_isolation.rs` on
a `macos-14` runner (Apple Silicon, arm64), asserting the same isolation contract
as the Linux backends against the runner's own APFS volume.

### Windows W1 detail

W1 injects a small file-redirect DLL (`hook.dll`, C++, in `../w1-spike`) into the
command with Microsoft Detours and lets the DLL re-inject itself into every child,
so the whole process tree sees the agent's overlay: reads fall through to the
workspace, writes copy up into the overlay, deletes become `.wh.<name>` whiteouts,
and the real workspace is never touched — the same `.wh.` change set the other
backends produce. `src/windows.rs` is only the **loader**: it starts the command
with the DLL mapped via `DetourCreateProcessWithDllExW`, waits, and returns the
child's exit code (the C++ `sandbox-launch.exe` folded into the one Rust binary).

Like the other backends it declares the few Win32 calls plus the one Detours
entry point directly (`extern "system"`, no crates); the only native library on
the link line is Detours' `detours.lib`, found at build time via `DETOURS_LIB_DIR`
(`build.rs`) and matched with `+crt-static` (`.cargo/config.toml`) so the CRT
agrees with Detours' `/MT` and the `.exe` is self-contained. Build it with
`sandbox/w1-spike/build.bat` (Detours + `hook.dll`) then `cargo build`; the CI
`windows-latest` leg does exactly this and runs `tests/w1_isolation.rs`.

**Known W1 gaps (from the spike, pre-production):** 8.3 short names are zeroed in
the `*BothDir` info classes; a directory query with a *specific* wildcard (not
`*`) falls through unmerged — which is why `cmd`'s `del` is unreliable and the
tests delete via `node`'s `fs.unlink`; case-insensitive matching (NTFS default) is
assumed. The launcher's command-line rebuild does not yet escape embedded
quotes/backslashes (it matches the C++ launcher's `JoinArgs`).

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
cargo test --release  # reconcile unit tests + the host's integration tests
```

Each integration test is gated to its own platform (`#![cfg(target_os = …)]`) and
skips itself when its kernel/filesystem prerequisite is absent, so the suite is
green on any host and the full matrix runs in CI (`sandbox-test.yml`).

The build has **no external crate dependencies** (each backend declares the handful
of libc entry points it needs directly — the Linux syscalls, `clonefile` on macOS),
so it compiles offline with a bare toolchain. Ship the resulting
`target/release/cerebriline-sandbox` into `apps/vscode/assets/sandbox/`.
