//! Linux backend L1: an unprivileged user namespace plus a kernel overlayfs
//! mounted over the workspace path itself, so the command tree sees the agent's
//! private view at the workspace's own absolute path (unprivileged since kernel
//! 5.11). The lower layer is the workspace; the upper is seeded from the agent's
//! tool edits and folded back into the `.wh.` format afterwards.
//!
//! The overlay's upper/work layers live on a **tmpfs the launcher mounts inside
//! the namespace**, not on the persistent disk. A plain disk directory is
//! rejected as an unprivileged overlay upper on many filesystems ("failed to set
//! xattr on upper"); a self-mounted tmpfs is owned by our own user namespace and
//! always supports what overlayfs needs. The upper is transient RAM for the
//! duration of the command; the durable result is written out to the persistent
//! overlay root by the reconcile step, in the `.wh.` format the hand-back reads.
//!
//! Because the upper is a tmpfs private to the child's mount namespace, the
//! seed and the reconcile both run *in the child*, and the overlay is unmounted
//! before reconcile so `workspace_has` sees the pristine lower rather than the
//! merged view.

use std::ffi::CString;
use std::fs;
use std::io::{self, Write};
use std::os::raw::{c_char, c_int, c_ulong, c_void};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use crate::{overlay, Config};

// The libc entry points the backend needs, declared directly so the crate has
// no external dependency and builds with a bare toolchain, offline. Rust links
// libc by default on this target, which resolves them.
extern "C" {
    fn fork() -> c_int;
    fn unshare(flags: c_int) -> c_int;
    fn mount(
        source: *const c_char,
        target: *const c_char,
        fstype: *const c_char,
        flags: c_ulong,
        data: *const c_void,
    ) -> c_int;
    fn umount2(target: *const c_char, flags: c_int) -> c_int;
    fn waitpid(pid: c_int, status: *mut c_int, options: c_int) -> c_int;
    fn execvp(file: *const c_char, argv: *const *const c_char) -> c_int;
    fn geteuid() -> u32;
    fn getegid() -> u32;
}

const CLONE_NEWNS: c_int = 0x0002_0000;
const CLONE_NEWUSER: c_int = 0x1000_0000;
const MS_REC: c_ulong = 0x4000;
const MS_PRIVATE: c_ulong = 1 << 18;
const MNT_DETACH: c_int = 2;

/// Default cap on the per-agent overlay tmpfs. Generous for a coding task while
/// bounding a runaway write; override with `CEREBRILINE_SANDBOX_TMPFS_SIZE`
/// (e.g. `8g`, `50%`, or `default` for the kernel's own 50%-of-RAM cap).
const DEFAULT_TMPFS_SIZE: &str = "4g";

/// Run the command under the L1 sandbox. Returns the process exit code to
/// propagate, or a non-zero launcher error code if the sandbox could not be set
/// up (the caller must treat that as a failed command, never as "ran without a
/// sandbox").
pub fn run(cfg: &Config) -> i32 {
    let ws_root = cfg.ws_root.as_path();
    let overlay_root = cfg.overlay_root.as_path();
    let scratch = sibling(overlay_root, ".ovl-scratch");

    // A path with an overlayfs option separator cannot be expressed in the mount
    // data string; refuse rather than mis-mount somewhere unexpected.
    for p in [ws_root, scratch.as_path()] {
        if has_mount_meta(p) {
            eprintln!(
                "cerebriline-sandbox: path contains ':' or ',', which overlayfs \
                 options cannot express: {}",
                p.display()
            );
            return 71;
        }
    }

    // The tmpfs mountpoint. A previous run killed mid-flight may have leaked it.
    let _ = fs::remove_dir_all(&scratch);
    if let Err(e) = fs::create_dir_all(&scratch) {
        eprintln!("cerebriline-sandbox: cannot create the overlay mountpoint: {e}");
        return 71;
    }
    if let Err(e) = fs::create_dir_all(overlay_root) {
        eprintln!("cerebriline-sandbox: cannot create the overlay root: {e}");
        return 71;
    }

    log_line(
        cfg,
        &format!(
            "MOUNT lower={} scratch={} cmd={:?}",
            ws_root.display(),
            scratch.display(),
            cfg.command
        ),
    );

    // SAFETY: single-threaded process; the child only calls async-signal-safe
    // work plus its own file I/O before exec, which is sound without threads.
    let pid = unsafe { fork() };
    if pid == 0 {
        let code = child_setup_and_exec(cfg, ws_root, overlay_root, &scratch);
        std::process::exit(code);
    }
    if pid < 0 {
        eprintln!(
            "cerebriline-sandbox: fork failed: {}",
            io::Error::last_os_error()
        );
        let _ = fs::remove_dir_all(&scratch);
        return 71;
    }

    let mut status: c_int = 0;
    let waited = unsafe { waitpid(pid, &mut status, 0) };
    let code = if waited < 0 {
        eprintln!(
            "cerebriline-sandbox: waitpid failed: {}",
            io::Error::last_os_error()
        );
        71
    } else {
        exit_code_of(status)
    };

    // The child's tmpfs unmounted itself when its namespace was destroyed; only
    // the empty mountpoint directory remains to remove.
    let _ = fs::remove_dir_all(&scratch);
    log_line(cfg, &format!("EXIT code={code}"));
    code
}

/// The child: become root in a new user namespace, mount a tmpfs for the overlay
/// upper, mount the overlay over the workspace, run the command in a grandchild,
/// then reconcile the upper into the persistent overlay root. Returns the code
/// to exit with.
fn child_setup_and_exec(cfg: &Config, ws_root: &Path, overlay_root: &Path, scratch: &Path) -> i32 {
    let euid = unsafe { geteuid() };
    let egid = unsafe { getegid() };

    if unsafe { unshare(CLONE_NEWUSER | CLONE_NEWNS) } != 0 {
        eprintln!(
            "cerebriline-sandbox: unshare(user|mount) failed: {} \
             (unprivileged user namespaces may be disabled — e.g. AppArmor on \
             Ubuntu 24.04)",
            io::Error::last_os_error()
        );
        return 71;
    }

    // Map our own uid/gid to root inside the new namespace. setgroups must be
    // denied before gid_map may be written unprivileged.
    if let Err(e) = write_proc("/proc/self/setgroups", "deny") {
        eprintln!("cerebriline-sandbox: setgroups deny failed: {e}");
        return 71;
    }
    if let Err(e) = write_proc("/proc/self/uid_map", &format!("0 {euid} 1\n")) {
        eprintln!("cerebriline-sandbox: uid_map failed: {e}");
        return 71;
    }
    if let Err(e) = write_proc("/proc/self/gid_map", &format!("0 {egid} 1\n")) {
        eprintln!("cerebriline-sandbox: gid_map failed: {e}");
        return 71;
    }

    // Detach mount propagation so nothing we mount escapes into the host tree.
    if let Err(e) = do_mount("none", Path::new("/"), "", MS_REC | MS_PRIVATE, None) {
        eprintln!("cerebriline-sandbox: making mounts private failed: {e}");
        return 71;
    }

    // A tmpfs for the overlay upper/work, which a self-mounted, self-owned fs
    // makes possible unprivileged where a disk directory is refused.
    if let Err(e) = do_mount("tmpfs", scratch, "tmpfs", 0, Some(&tmpfs_options())) {
        eprintln!("cerebriline-sandbox: mounting the overlay tmpfs failed: {e}");
        return 71;
    }
    let upper = scratch.join("up");
    let work = scratch.join("wk");
    if let Err(e) = fs::create_dir_all(&upper).and_then(|()| fs::create_dir_all(&work)) {
        eprintln!("cerebriline-sandbox: cannot create upper/work dirs: {e}");
        return 71;
    }

    let seeded = match overlay::preseed(overlay_root, &upper) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cerebriline-sandbox: seeding the overlay failed: {e}");
            return 71;
        }
    };

    let data = format!(
        "lowerdir={},upperdir={},workdir={}",
        ws_root.display(),
        upper.display(),
        work.display()
    );
    if let Err(e) = do_mount("overlay", ws_root, "overlay", 0, Some(&data)) {
        eprintln!("cerebriline-sandbox: mounting overlayfs failed: {e}");
        return 71;
    }

    // Run the command in a grandchild so this process survives it to reconcile.
    let gpid = unsafe { fork() };
    if gpid == 0 {
        if let Err(e) = std::env::set_current_dir(ws_root) {
            eprintln!("cerebriline-sandbox: chdir to workspace failed: {e}");
            std::process::exit(127);
        }
        exec(&cfg.command);
        eprintln!(
            "cerebriline-sandbox: exec {:?} failed: {}",
            cfg.command.first(),
            io::Error::last_os_error()
        );
        std::process::exit(127);
    }
    if gpid < 0 {
        eprintln!(
            "cerebriline-sandbox: fork (command) failed: {}",
            io::Error::last_os_error()
        );
        return 71;
    }

    let mut status: c_int = 0;
    let waited = unsafe { waitpid(gpid, &mut status, 0) };
    let code = if waited < 0 { 71 } else { exit_code_of(status) };

    // Detach the overlay so `workspace_has` in reconcile sees the pristine lower,
    // not the merged view. Move our cwd off the mount first. MNT_DETACH removes
    // it from the tree for new lookups even if an fd somewhere still holds it.
    let _ = std::env::set_current_dir("/");
    if let Ok(ws_c) = CString::new(ws_root.as_os_str().as_bytes()) {
        unsafe {
            umount2(ws_c.as_ptr(), MNT_DETACH);
        }
    }

    if let Err(e) = overlay::reconcile(ws_root, overlay_root, &upper, &seeded) {
        eprintln!("cerebriline-sandbox: reconciling the overlay failed: {e}");
    }
    code
}

fn exec(command: &[String]) {
    let Some(prog) = command.first() else {
        return;
    };
    let Ok(prog_c) = CString::new(prog.as_str()) else {
        return;
    };
    let arg_c: Vec<CString> = command
        .iter()
        .filter_map(|a| CString::new(a.as_str()).ok())
        .collect();
    let mut ptrs: Vec<*const c_char> = arg_c.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    unsafe {
        execvp(prog_c.as_ptr(), ptrs.as_ptr());
    }
}

fn tmpfs_options() -> String {
    match std::env::var("CEREBRILINE_SANDBOX_TMPFS_SIZE") {
        Ok(v) if v == "default" => String::new(),
        Ok(v) if !v.is_empty() => format!("size={v}"),
        _ => format!("size={DEFAULT_TMPFS_SIZE}"),
    }
}

fn do_mount(
    source: &str,
    target: &Path,
    fstype: &str,
    flags: c_ulong,
    data: Option<&str>,
) -> io::Result<()> {
    let source_c = CString::new(source)?;
    let target_c = CString::new(target.as_os_str().as_bytes())?;
    let fstype_c = CString::new(fstype)?;
    let data_c = match data.filter(|d| !d.is_empty()) {
        Some(d) => Some(CString::new(d)?),
        None => None,
    };
    let data_ptr = data_c
        .as_ref()
        .map(|c| c.as_ptr() as *const c_void)
        .unwrap_or(std::ptr::null());
    let rc = unsafe {
        mount(
            source_c.as_ptr(),
            target_c.as_ptr(),
            fstype_c.as_ptr(),
            flags,
            data_ptr,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn write_proc(path: &str, contents: &str) -> io::Result<()> {
    let mut f = fs::OpenOptions::new().write(true).open(path)?;
    f.write_all(contents.as_bytes())
}

fn exit_code_of(status: c_int) -> i32 {
    if status & 0x7f == 0 {
        (status >> 8) & 0xff
    } else {
        // Terminated by a signal: mirror the shell's 128+signo convention.
        128 + (status & 0x7f)
    }
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{}", path.to_string_lossy(), suffix))
}

fn has_mount_meta(path: &Path) -> bool {
    let s = path.to_string_lossy();
    s.contains(':') || s.contains(',')
}

fn log_line(cfg: &Config, line: &str) {
    let Some(log) = &cfg.log else {
        return;
    };
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(log) {
        let _ = writeln!(f, "{line}");
    }
}
