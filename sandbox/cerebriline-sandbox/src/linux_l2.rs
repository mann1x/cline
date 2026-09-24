//! Linux backend L2: a ptrace supervisor that rewrites filesystem paths, for
//! hosts where L1 (user namespace + overlayfs) cannot run — unprivileged user
//! namespaces blocked (AppArmor on Ubuntu 24.04+), or a workspace filesystem
//! that refuses an unprivileged overlay (e.g. ext4 with project quotas on
//! bcache, where copy-up fails with EOVERFLOW).
//!
//! Unlike seccomp user-notification, ptrace can modify a syscall's arguments
//! before it runs, which is what path redirection needs (this is how proot
//! works). The supervisor traces the command and every descendant; on each
//! path-bearing syscall it resolves the path against the overlay (see
//! `resolve.rs`) and either rewrites the path argument to the overlay copy,
//! leaves it (a read-through to the workspace), or neutralises the syscall and
//! emulates it (a delete becomes a `.wh.` whiteout). Writes land in the overlay
//! in the same `.wh.` format as L1 and the in-process overlay, so the hand-back
//! is unchanged and no reconcile step is needed.
//!
//! x86_64 only for now; other arches fall through to "unsupported" (the caller
//! then withholds the shell rather than run it unsandboxed). Scope is the file
//! syscalls a coding command uses: open/stat/access/readlink/mkdir (rewritten)
//! and unlink/rmdir/rename (emulated). Symlink following in the tracee's view
//! and a handful of rarer path syscalls are documented gaps (PLANS.md §10).

use std::collections::HashMap;
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::raw::{c_int, c_long, c_void};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::FileExt;
use std::path::{Component, Path, PathBuf};

use crate::{resolve, Config};

extern "C" {
    fn fork() -> c_int;
    fn execvp(file: *const i8, argv: *const *const i8) -> c_int;
    fn waitpid(pid: c_int, status: *mut c_int, options: c_int) -> c_int;
    fn ptrace(request: c_int, pid: c_int, addr: *mut c_void, data: *mut c_void) -> c_long;
}

const PTRACE_TRACEME: c_int = 0;
const PTRACE_SYSCALL: c_int = 24;
const PTRACE_SETOPTIONS: c_int = 0x4200;
const PTRACE_GETREGS: c_int = 12;
const PTRACE_SETREGS: c_int = 13;
const PTRACE_GET_SYSCALL_INFO: c_int = 0x420e;

const PTRACE_O_TRACESYSGOOD: c_long = 0x0000_0001;
const PTRACE_O_TRACEFORK: c_long = 0x0000_0002;
const PTRACE_O_TRACEVFORK: c_long = 0x0000_0004;
const PTRACE_O_TRACECLONE: c_long = 0x0000_0008;
const PTRACE_O_TRACEEXEC: c_long = 0x0000_0010;
const PTRACE_O_EXITKILL: c_long = 0x0010_0000;

const PTRACE_SYSCALL_INFO_ENTRY: u8 = 1;
const PTRACE_SYSCALL_INFO_EXIT: u8 = 2;

// x86_64 syscall numbers.
const SYS_OPEN: u64 = 2;
const SYS_STAT: u64 = 4;
const SYS_LSTAT: u64 = 6;
const SYS_ACCESS: u64 = 21;
const SYS_RENAME: u64 = 82;
const SYS_MKDIR: u64 = 83;
const SYS_RMDIR: u64 = 84;
const SYS_UNLINK: u64 = 87;
const SYS_READLINK: u64 = 89;
const SYS_OPENAT: u64 = 257;
const SYS_MKDIRAT: u64 = 258;
const SYS_UNLINKAT: u64 = 263;
const SYS_RENAMEAT: u64 = 264;
const SYS_READLINKAT: u64 = 267;
const SYS_FACCESSAT: u64 = 269;
const SYS_NEWFSTATAT: u64 = 262;
const SYS_RENAMEAT2: u64 = 316;
const SYS_STATX: u64 = 332;
const SYS_FACCESSAT2: u64 = 439;

const AT_FDCWD: i64 = -100;

// open(2) access-mode / creation flags that mean the command intends to write.
const O_WRONLY: u64 = 0o1;
const O_RDWR: u64 = 0o2;
const O_CREAT: u64 = 0o100;
const O_TRUNC: u64 = 0o1000;
const O_APPEND: u64 = 0o2000;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct UserRegs {
    r15: u64,
    r14: u64,
    r13: u64,
    r12: u64,
    rbp: u64,
    rbx: u64,
    r11: u64,
    r10: u64,
    r9: u64,
    r8: u64,
    rax: u64,
    rcx: u64,
    rdx: u64,
    rsi: u64,
    rdi: u64,
    orig_rax: u64,
    rip: u64,
    cs: u64,
    eflags: u64,
    rsp: u64,
    ss: u64,
    fs_base: u64,
    gs_base: u64,
    ds: u64,
    es: u64,
    fs: u64,
    gs: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct SyscallInfoHead {
    op: u8,
    _pad: [u8; 3],
    arch: u32,
    instruction_pointer: u64,
    stack_pointer: u64,
    // The union tail is not needed here.
    _tail: [u64; 8],
}

struct TraceeState {
    /// When set, force this value into `rax` at the next syscall-exit stop
    /// (a neutralised syscall the supervisor emulated).
    pending_result: Option<i64>,
}

pub struct L2 {
    ws_root: PathBuf,
    overlay_root: PathBuf,
    states: HashMap<c_int, TraceeState>,
}

/// Run the command under the L2 sandbox. Returns the process exit code, or a
/// launcher error code if the tracer could not start.
pub fn run(cfg: &Config) -> i32 {
    let ws_root = cfg.ws_root.clone();
    let overlay_root = cfg.overlay_root.clone();
    if let Err(e) = fs::create_dir_all(&overlay_root) {
        eprintln!("cerebriline-sandbox: cannot create the overlay root: {e}");
        return 71;
    }

    // SAFETY: single-threaded; the child only does async-signal-safe work
    // (ptrace + exec) before handing control to the kernel.
    let pid = unsafe { fork() };
    if pid == 0 {
        unsafe {
            ptrace(
                PTRACE_TRACEME,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
        }
        if std::env::set_current_dir(&ws_root).is_err() {
            std::process::exit(127);
        }
        exec(&cfg.command);
        std::process::exit(127);
    }
    if pid < 0 {
        eprintln!(
            "cerebriline-sandbox: fork failed: {}",
            io::Error::last_os_error()
        );
        return 71;
    }

    let mut l2 = L2 {
        ws_root,
        overlay_root,
        states: HashMap::new(),
    };
    l2.supervise(pid)
}

impl L2 {
    fn supervise(&mut self, root: c_int) -> i32 {
        // Wait for the child's initial stop, then set the trace options.
        let mut status: c_int = 0;
        if unsafe { waitpid(root, &mut status, 0) } < 0 {
            eprintln!("cerebriline-sandbox: initial waitpid failed");
            return 71;
        }
        let opts = PTRACE_O_TRACESYSGOOD
            | PTRACE_O_TRACEFORK
            | PTRACE_O_TRACEVFORK
            | PTRACE_O_TRACECLONE
            | PTRACE_O_TRACEEXEC
            | PTRACE_O_EXITKILL;
        unsafe {
            ptrace(
                PTRACE_SETOPTIONS,
                root,
                std::ptr::null_mut(),
                opts as *mut c_void,
            );
        }
        self.states.insert(
            root,
            TraceeState {
                pending_result: None,
            },
        );
        resume(root, 0);

        let mut root_exit: i32 = 0;
        loop {
            let mut status: c_int = 0;
            let pid = unsafe { waitpid(-1, &mut status, 0) };
            if pid < 0 {
                break; // no more tracees
            }
            if wifexited(status) || wifsignaled(status) {
                if pid == root {
                    root_exit = if wifexited(status) {
                        wexitstatus(status)
                    } else {
                        128 + wtermsig(status)
                    };
                }
                self.states.remove(&pid);
                if pid == root {
                    // Keep draining any stragglers, but remember the code.
                }
                continue;
            }

            let sig = wstopsig(status);
            let event = (status >> 16) & 0xff;
            if event != 0 {
                // fork/vfork/clone/exec stop: a new child is auto-traced; just
                // register it and continue. exec resets nothing we track.
                if let Some(newpid) = event_new_pid(pid) {
                    self.states.entry(newpid).or_insert(TraceeState {
                        pending_result: None,
                    });
                }
                resume(pid, 0);
                continue;
            }

            if sig == (0x80 | 5) {
                // syscall-stop (SIGTRAP|0x80 via TRACESYSGOOD).
                self.on_syscall_stop(pid);
                resume(pid, 0);
                continue;
            }

            // Any other signal: forward it to the tracee.
            resume(pid, sig);
        }
        root_exit
    }

    fn on_syscall_stop(&mut self, pid: c_int) {
        let info = match get_syscall_info(pid) {
            Some(i) => i,
            None => return,
        };
        if info.op == PTRACE_SYSCALL_INFO_EXIT {
            if let Some(state) = self.states.get_mut(&pid) {
                if let Some(result) = state.pending_result.take() {
                    if let Some(mut regs) = getregs(pid) {
                        regs.rax = result as u64;
                        setregs(pid, &regs);
                    }
                }
            }
            return;
        }
        if info.op != PTRACE_SYSCALL_INFO_ENTRY {
            return;
        }
        let Some(mut regs) = getregs(pid) else {
            return;
        };
        self.handle_entry(pid, &mut regs);
    }

    fn handle_entry(&mut self, pid: c_int, regs: &mut UserRegs) {
        let nr = regs.orig_rax;
        match nr {
            // Single absolute-or-cwd path in rdi.
            SYS_OPEN => self.rewrite_path_arg(
                pid,
                regs,
                ArgReg::Rdi,
                AT_FDCWD,
                OpenIntent::from_flags(regs.rsi),
            ),
            SYS_STAT | SYS_LSTAT | SYS_ACCESS | SYS_READLINK => {
                self.rewrite_path_arg(pid, regs, ArgReg::Rdi, AT_FDCWD, OpenIntent::Read)
            }
            SYS_MKDIR => self.rewrite_path_arg(pid, regs, ArgReg::Rdi, AT_FDCWD, OpenIntent::Mkdir),
            SYS_UNLINK | SYS_RMDIR => self.emulate_delete_arg(pid, regs, ArgReg::Rdi, AT_FDCWD),
            // dirfd in rdi, path in rsi.
            SYS_OPENAT => self.rewrite_path_arg(
                pid,
                regs,
                ArgReg::Rsi,
                regs.rdi as i64,
                OpenIntent::from_flags(regs.rdx),
            ),
            SYS_NEWFSTATAT | SYS_STATX | SYS_FACCESSAT | SYS_FACCESSAT2 | SYS_READLINKAT => {
                self.rewrite_path_arg(pid, regs, ArgReg::Rsi, regs.rdi as i64, OpenIntent::Read)
            }
            SYS_MKDIRAT => {
                self.rewrite_path_arg(pid, regs, ArgReg::Rsi, regs.rdi as i64, OpenIntent::Mkdir)
            }
            SYS_UNLINKAT => self.emulate_delete_arg(pid, regs, ArgReg::Rsi, regs.rdi as i64),
            SYS_RENAME => {
                self.emulate_rename(pid, regs, ArgReg::Rdi, AT_FDCWD, ArgReg::Rsi, AT_FDCWD)
            }
            SYS_RENAMEAT | SYS_RENAMEAT2 => self.emulate_rename(
                pid,
                regs,
                ArgReg::Rsi,
                regs.rdi as i64,
                ArgReg::R10,
                regs.rdx as i64,
            ),
            _ => {}
        }
    }

    /// Resolve the path in `arg` and, if the overlay governs it, rewrite the
    /// register to the overlay path (written into tracee scratch memory).
    fn rewrite_path_arg(
        &mut self,
        pid: c_int,
        regs: &mut UserRegs,
        arg: ArgReg,
        dirfd: i64,
        intent: OpenIntent,
    ) {
        let ptr = arg.get(regs);
        if ptr == 0 {
            return;
        }
        let Some(raw) = read_string(pid, ptr) else {
            return;
        };
        let Some(abs) = self.absolutise(pid, dirfd, &raw) else {
            return;
        };
        let target = match intent {
            OpenIntent::Read => resolve::resolve_read(&self.ws_root, &self.overlay_root, &abs),
            OpenIntent::Write => {
                resolve::resolve_write(&self.ws_root, &self.overlay_root, &abs).unwrap_or_default()
            }
            OpenIntent::Mkdir => {
                resolve::resolve_mkdir(&self.ws_root, &self.overlay_root, &abs).unwrap_or_default()
            }
        };
        if let Some(target) = target {
            if let Some(scratch) = write_scratch(pid, regs, target.as_os_str().as_bytes()) {
                arg.set(regs, scratch);
                setregs(pid, regs);
            }
        }
    }

    fn emulate_delete_arg(&mut self, pid: c_int, regs: &mut UserRegs, arg: ArgReg, dirfd: i64) {
        let ptr = arg.get(regs);
        if ptr == 0 {
            return;
        }
        let Some(raw) = read_string(pid, ptr) else {
            return;
        };
        let Some(abs) = self.absolutise(pid, dirfd, &raw) else {
            return;
        };
        if let Ok(true) = resolve::emulate_delete(&self.ws_root, &self.overlay_root, &abs) {
            self.neutralise(pid, regs, 0);
        }
    }

    fn emulate_rename(
        &mut self,
        pid: c_int,
        regs: &mut UserRegs,
        old_arg: ArgReg,
        old_dirfd: i64,
        new_arg: ArgReg,
        new_dirfd: i64,
    ) {
        let (Some(old_raw), Some(new_raw)) = (
            read_string(pid, old_arg.get(regs)),
            read_string(pid, new_arg.get(regs)),
        ) else {
            return;
        };
        let (Some(old_abs), Some(new_abs)) = (
            self.absolutise(pid, old_dirfd, &old_raw),
            self.absolutise(pid, new_dirfd, &new_raw),
        ) else {
            return;
        };
        // Both must be inside the workspace for the emulation to be correct; if
        // either escapes, leave the syscall alone rather than half-apply it.
        let inside = |p: &Path| resolve::locate(&self.ws_root, &self.overlay_root, p).inside;
        if !inside(&old_abs) || !inside(&new_abs) {
            return;
        }
        let ok = (|| -> io::Result<()> {
            let src = resolve::resolve_read(&self.ws_root, &self.overlay_root, &old_abs)
                .unwrap_or_else(|| old_abs.clone());
            let body = fs::read(&src)?;
            if let Some(dst) = resolve::resolve_write(&self.ws_root, &self.overlay_root, &new_abs)?
            {
                fs::write(&dst, &body)?;
            }
            resolve::emulate_delete(&self.ws_root, &self.overlay_root, &old_abs)?;
            Ok(())
        })();
        if ok.is_ok() {
            self.neutralise(pid, regs, 0);
        }
    }

    /// Turn the pending syscall into a no-op that returns `result`: set an
    /// invalid syscall number now (so the kernel runs nothing) and force the
    /// return value at the exit stop.
    fn neutralise(&mut self, pid: c_int, regs: &mut UserRegs, result: i64) {
        regs.orig_rax = u64::MAX; // -1: no such syscall
        setregs(pid, regs);
        if let Some(state) = self.states.get_mut(&pid) {
            state.pending_result = Some(result);
        }
    }

    /// Turn a raw path argument into an absolute, lexically-normalised path,
    /// resolving a relative path against the tracee's cwd or the dirfd's target.
    fn absolutise(&self, pid: c_int, dirfd: i64, raw: &[u8]) -> Option<PathBuf> {
        let raw = Path::new(std::str::from_utf8(raw).ok()?);
        let base = if raw.is_absolute() {
            PathBuf::from("/")
        } else if dirfd == AT_FDCWD {
            read_link(&format!("/proc/{pid}/cwd"))?
        } else {
            read_link(&format!("/proc/{pid}/fd/{dirfd}"))?
        };
        Some(normalise(&base, raw))
    }
}

#[derive(Clone, Copy)]
enum ArgReg {
    Rdi,
    Rsi,
    R10,
}
impl ArgReg {
    fn get(self, r: &UserRegs) -> u64 {
        match self {
            ArgReg::Rdi => r.rdi,
            ArgReg::Rsi => r.rsi,
            ArgReg::R10 => r.r10,
        }
    }
    fn set(self, r: &mut UserRegs, v: u64) {
        match self {
            ArgReg::Rdi => r.rdi = v,
            ArgReg::Rsi => r.rsi = v,
            ArgReg::R10 => r.r10 = v,
        }
    }
}

#[derive(Clone, Copy)]
enum OpenIntent {
    Read,
    Write,
    Mkdir,
}
impl OpenIntent {
    fn from_flags(flags: u64) -> OpenIntent {
        let acc = flags & 0o3;
        if acc == O_WRONLY
            || acc == O_RDWR
            || flags & O_CREAT != 0
            || flags & O_TRUNC != 0
            || flags & O_APPEND != 0
        {
            OpenIntent::Write
        } else {
            OpenIntent::Read
        }
    }
}

/// Lexically resolve `rel` against `base`, collapsing `.` and `..` without
/// touching the filesystem (symlink-follow is a documented gap).
fn normalise(base: &Path, rel: &Path) -> PathBuf {
    let joined = base.join(rel);
    let mut out: Vec<Component> = Vec::new();
    for comp in joined.components() {
        match comp {
            Component::ParentDir => {
                if !matches!(out.last(), Some(Component::RootDir) | None) {
                    out.pop();
                }
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out.iter().collect()
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
    let mut ptrs: Vec<*const i8> = arg_c.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    unsafe {
        execvp(prog_c.as_ptr(), ptrs.as_ptr());
    }
}

fn resume(pid: c_int, sig: c_int) {
    unsafe {
        ptrace(
            PTRACE_SYSCALL,
            pid,
            std::ptr::null_mut(),
            sig as *mut c_void,
        );
    }
}

fn getregs(pid: c_int) -> Option<UserRegs> {
    let mut regs = UserRegs::default();
    let rc = unsafe {
        ptrace(
            PTRACE_GETREGS,
            pid,
            std::ptr::null_mut(),
            &mut regs as *mut _ as *mut c_void,
        )
    };
    if rc < 0 {
        None
    } else {
        Some(regs)
    }
}

fn setregs(pid: c_int, regs: &UserRegs) {
    unsafe {
        ptrace(
            PTRACE_SETREGS,
            pid,
            std::ptr::null_mut(),
            regs as *const _ as *mut c_void,
        );
    }
}

fn get_syscall_info(pid: c_int) -> Option<SyscallInfoHead> {
    let mut info = SyscallInfoHead::default();
    let size = std::mem::size_of::<SyscallInfoHead>() as c_int;
    let rc = unsafe {
        ptrace(
            PTRACE_GET_SYSCALL_INFO,
            pid,
            size as *mut c_void,
            &mut info as *mut _ as *mut c_void,
        )
    };
    if rc < 0 {
        None
    } else {
        Some(info)
    }
}

fn event_new_pid(pid: c_int) -> Option<c_int> {
    const PTRACE_GETEVENTMSG: c_int = 0x4201;
    let mut msg: u64 = 0;
    let rc = unsafe {
        ptrace(
            PTRACE_GETEVENTMSG,
            pid,
            std::ptr::null_mut(),
            &mut msg as *mut _ as *mut c_void,
        )
    };
    if rc < 0 {
        None
    } else {
        Some(msg as c_int)
    }
}

/// Read a NUL-terminated string from the tracee's memory via /proc/pid/mem.
fn read_string(pid: c_int, addr: u64) -> Option<Vec<u8>> {
    if addr == 0 {
        return None;
    }
    let mem = fs::File::open(format!("/proc/{pid}/mem")).ok()?;
    let mut out = Vec::with_capacity(64);
    let mut buf = [0u8; 256];
    let mut off = addr;
    loop {
        let n = mem.read_at(&mut buf, off).ok()?;
        if n == 0 {
            return None;
        }
        for &b in &buf[..n] {
            if b == 0 {
                return Some(out);
            }
            out.push(b);
            if out.len() > 4096 {
                return Some(out);
            }
        }
        off += n as u64;
    }
}

/// Write `bytes` plus a NUL into the tracee's stack scratch area (below the red
/// zone) and return the address, or None if the write failed. The scratch sits
/// well under the stack pointer, which is unused during a syscall stop.
fn write_scratch(pid: c_int, regs: &UserRegs, bytes: &[u8]) -> Option<u64> {
    let mem = fs::OpenOptions::new()
        .write(true)
        .open(format!("/proc/{pid}/mem"))
        .ok()?;
    // 512 bytes below rsp for the red zone, then room for the path, 16-aligned.
    let needed = bytes.len() as u64 + 1;
    let addr = (regs.rsp - 512 - needed) & !0xf;
    let mut payload = Vec::with_capacity(bytes.len() + 1);
    payload.extend_from_slice(bytes);
    payload.push(0);
    mem.write_at(&payload, addr).ok()?;
    Some(addr)
}

fn read_link(path: &str) -> Option<PathBuf> {
    fs::read_link(path).ok()
}

// wait(2) status helpers.
fn wifexited(status: c_int) -> bool {
    (status & 0x7f) == 0
}
fn wexitstatus(status: c_int) -> i32 {
    (status >> 8) & 0xff
}
fn wifsignaled(status: c_int) -> bool {
    let sig = status & 0x7f;
    sig != 0x7f && sig != 0
}
fn wtermsig(status: c_int) -> i32 {
    status & 0x7f
}
fn wstopsig(status: c_int) -> c_int {
    (status >> 8) & 0xff
}
