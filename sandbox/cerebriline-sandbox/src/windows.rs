//! Windows **W1** backend — Microsoft Detours DLL injection.
//!
//! This folds the C++ `sandbox-launch.exe` (`sandbox/w1-spike/launcher.cpp`) into
//! the one Rust launcher. The injected `hook.dll` stays C++ — it is the piece that
//! does the redirect, copy-up, whiteout and child re-injection — and this backend
//! is only its loader: start the command with the DLL already mapped via
//! `DetourCreateProcessWithDllExW`, let the DLL re-inject into every child, wait,
//! and return the child's exit code. The launcher's job is identical on every
//! milestone; only the DLL changes.
//!
//! ## Write confinement
//!
//! With `CEREBRILINE_SANDBOX_CONFINE=1` the command tree is started at **Low
//! integrity**. Windows then refuses, by itself, every write to an object
//! labelled higher, which is everything the user owns by default: the profile,
//! the real workspace, `%TEMP%`, `HKCU`. Reads are not affected. Nothing has to
//! be installed or configured, and no privilege is needed to lower one's own
//! token. What the command may write is what this launcher labels Low before
//! it starts: the agent's overlay (where `hook.dll` lands every workspace
//! write), its trace log, and the temp folder named in
//! `CEREBRILINE_SANDBOX_TMP`, which the caller also puts in `TEMP`/`TMP`.
//! Children inherit the token; none of them can raise it.
//!
//! This is what was missing in swarm wlafh, where one agent appended to the
//! user's `PATH` (a write to `HKCU\Environment`) and another copied a program
//! into `%USERPROFILE%\.local\bin`.
//!
//! Like the other backends this declares the handful of entry points it needs
//! directly (`extern "system"`), so the crate stays free of external
//! dependencies. The one native library on the link line is Microsoft Detours'
//! `detours.lib` (for `DetourCreateProcessWithDllExW`), located at build time via
//! `DETOURS_LIB_DIR` — see `build.rs` and `sandbox/w1-spike/build.bat`.

use std::ffi::CString;
use std::os::raw::{c_char, c_void};
use std::path::Path;
use std::sync::atomic::{AtomicPtr, Ordering};

use crate::Config;

#[repr(C)]
struct StartupInfoW {
    cb: u32,
    lp_reserved: *mut u16,
    lp_desktop: *mut u16,
    lp_title: *mut u16,
    dw_x: u32,
    dw_y: u32,
    dw_x_size: u32,
    dw_y_size: u32,
    dw_x_count_chars: u32,
    dw_y_count_chars: u32,
    dw_fill_attribute: u32,
    dw_flags: u32,
    w_show_window: u16,
    cb_reserved2: u16,
    lp_reserved2: *mut u8,
    h_std_input: *mut c_void,
    h_std_output: *mut c_void,
    h_std_error: *mut c_void,
}

#[repr(C)]
struct ProcessInformation {
    h_process: *mut c_void,
    h_thread: *mut c_void,
    dw_process_id: u32,
    dw_thread_id: u32,
}

// kernel32 is linked by std; detours.lib is put on the link line by build.rs.
// Detours' functions are `extern "C"`, which on x64 is the one calling
// convention, so `extern "system"` names them undecorated.
extern "system" {
    fn SetEnvironmentVariableW(name: *const u16, value: *const u16) -> i32;
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn GetLastError() -> u32;

    fn DetourCreateProcessWithDllExW(
        application_name: *const u16,
        command_line: *mut u16,
        process_attributes: *mut c_void,
        thread_attributes: *mut c_void,
        inherit_handles: i32,
        creation_flags: u32,
        environment: *mut c_void,
        current_directory: *const u16,
        startup_info: *const StartupInfoW,
        process_information: *mut ProcessInformation,
        dll_name: *const c_char,
        create_process: *mut c_void,
    ) -> i32;
}

#[repr(C)]
struct SidAndAttributes {
    sid: *mut c_void,
    attributes: u32,
}

#[repr(C)]
struct TokenMandatoryLabel {
    label: SidAndAttributes,
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
    fn DuplicateTokenEx(
        existing: *mut c_void,
        access: u32,
        attributes: *mut c_void,
        impersonation_level: u32,
        token_type: u32,
        new_token: *mut *mut c_void,
    ) -> i32;
    fn ConvertStringSidToSidW(string_sid: *const u16, sid: *mut *mut c_void) -> i32;
    fn GetLengthSid(sid: *mut c_void) -> u32;
    fn SetTokenInformation(
        token: *mut c_void,
        class: u32,
        information: *const c_void,
        length: u32,
    ) -> i32;
    fn CreateProcessAsUserW(
        token: *mut c_void,
        application_name: *const u16,
        command_line: *mut u16,
        process_attributes: *mut c_void,
        thread_attributes: *mut c_void,
        inherit_handles: i32,
        creation_flags: u32,
        environment: *mut c_void,
        current_directory: *const u16,
        startup_info: *const StartupInfoW,
        process_information: *mut ProcessInformation,
    ) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl: *const u16,
        revision: u32,
        descriptor: *mut *mut c_void,
        size: *mut u32,
    ) -> i32;
    fn GetSecurityDescriptorSacl(
        descriptor: *mut c_void,
        present: *mut i32,
        sacl: *mut *mut c_void,
        defaulted: *mut i32,
    ) -> i32;
    fn SetNamedSecurityInfoW(
        name: *const u16,
        object_type: u32,
        info: u32,
        owner: *mut c_void,
        group: *mut c_void,
        dacl: *mut c_void,
        sacl: *mut c_void,
    ) -> u32;
}

extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
    fn LocalFree(mem: *mut c_void) -> *mut c_void;
}

const TOKEN_ASSIGN_PRIMARY: u32 = 0x0001;
const TOKEN_DUPLICATE: u32 = 0x0002;
const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_ADJUST_DEFAULT: u32 = 0x0080;
const MAXIMUM_ALLOWED: u32 = 0x0200_0000;
const SECURITY_IMPERSONATION: u32 = 2;
const TOKEN_PRIMARY: u32 = 1;
const TOKEN_INTEGRITY_LEVEL: u32 = 25;
const SE_GROUP_INTEGRITY: u32 = 0x20;
const SE_FILE_OBJECT: u32 = 1;
const LABEL_SECURITY_INFORMATION: u32 = 0x10;
const SDDL_REVISION_1: u32 = 1;
/// The Low mandatory level.
const LOW_INTEGRITY_SID: &str = "S-1-16-4096";
/// A Low label that new entries inherit: a file an in-process tool writes into
/// the overlay later is writable to the command without another pass.
const LOW_LABEL_DIR: &str = "S:(ML;OICI;NW;;;LW)";
const LOW_LABEL_FILE: &str = "S:(ML;;NW;;;LW)";

/// The Low-integrity token the create routine starts the command with.
static LOW_TOKEN: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

/// A copy of this process's token at Low integrity.
fn low_integrity_token() -> Result<*mut c_void, String> {
    let mut own: *mut c_void = std::ptr::null_mut();
    let access = TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY;
    if unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut own) } == 0 {
        return Err(format!("OpenProcessToken failed: {}", unsafe {
            GetLastError()
        }));
    }
    let mut low: *mut c_void = std::ptr::null_mut();
    let ok = unsafe {
        DuplicateTokenEx(
            own,
            MAXIMUM_ALLOWED,
            std::ptr::null_mut(),
            SECURITY_IMPERSONATION,
            TOKEN_PRIMARY,
            &mut low,
        )
    };
    unsafe { CloseHandle(own) };
    if ok == 0 {
        return Err(format!("DuplicateTokenEx failed: {}", unsafe {
            GetLastError()
        }));
    }
    let mut sid: *mut c_void = std::ptr::null_mut();
    let sid_text = to_utf16_null(LOW_INTEGRITY_SID);
    if unsafe { ConvertStringSidToSidW(sid_text.as_ptr(), &mut sid) } == 0 {
        unsafe { CloseHandle(low) };
        return Err(format!("ConvertStringSidToSidW failed: {}", unsafe {
            GetLastError()
        }));
    }
    let label = TokenMandatoryLabel {
        label: SidAndAttributes {
            sid,
            attributes: SE_GROUP_INTEGRITY,
        },
    };
    let length = std::mem::size_of::<TokenMandatoryLabel>() as u32 + unsafe { GetLengthSid(sid) };
    let set = unsafe {
        SetTokenInformation(
            low,
            TOKEN_INTEGRITY_LEVEL,
            &label as *const TokenMandatoryLabel as *const c_void,
            length,
        )
    };
    let err = unsafe { GetLastError() };
    unsafe { LocalFree(sid) };
    if set == 0 {
        unsafe { CloseHandle(low) };
        return Err(format!("SetTokenInformation(integrity) failed: {err}"));
    }
    Ok(low)
}

/// Label one path Low, so a Low-integrity process may write it.
fn label_low(path: &Path, is_dir: bool) -> Result<(), String> {
    let sddl = to_utf16_null(if is_dir {
        LOW_LABEL_DIR
    } else {
        LOW_LABEL_FILE
    });
    let mut descriptor: *mut c_void = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(format!("building the Low label failed: {}", unsafe {
            GetLastError()
        }));
    }
    let mut sacl: *mut c_void = std::ptr::null_mut();
    let (mut present, mut defaulted) = (0i32, 0i32);
    let got =
        unsafe { GetSecurityDescriptorSacl(descriptor, &mut present, &mut sacl, &mut defaulted) };
    let name = to_utf16_null(&path.to_string_lossy());
    let rc = if got != 0 && present != 0 {
        unsafe {
            SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                sacl,
            )
        }
    } else {
        1
    };
    unsafe { LocalFree(descriptor) };
    if rc != 0 {
        return Err(format!("labelling {} Low failed: {rc}", path.display()));
    }
    Ok(())
}

/// Label a directory and everything in it Low. Entries the lead's process
/// wrote before the directory carried an inheritable label keep their own
/// (Medium) one until labelled here, and the command could not change them.
fn label_tree_low(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    label_low(root, true)?;
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            label_low(&path, is_dir)?;
            if is_dir {
                pending.push(path);
            }
        }
    }
    Ok(())
}

/// Everything the confined command writes, labelled before it starts.
fn prepare_confinement(cfg: &Config) -> Result<(), String> {
    label_tree_low(&cfg.overlay_root)?;
    if let Some(log) = &cfg.log {
        // The DLL appends to the log from inside the command's processes.
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .map_err(|e| format!("cannot create the log {}: {e}", log.display()))?;
        label_low(log, false)?;
    }
    if let Some(tmp) = std::env::var_os("CEREBRILINE_SANDBOX_TMP").filter(|v| !v.is_empty()) {
        label_tree_low(Path::new(&tmp))?;
    }
    let token = low_integrity_token()?;
    LOW_TOKEN.store(token, Ordering::SeqCst);
    Ok(())
}

/// Detours calls this in place of `CreateProcessW`: same arguments, started
/// with the Low token. Only the first process needs it; its children inherit.
unsafe extern "system" fn create_process_low(
    application_name: *const u16,
    command_line: *mut u16,
    process_attributes: *mut c_void,
    thread_attributes: *mut c_void,
    inherit_handles: i32,
    creation_flags: u32,
    environment: *mut c_void,
    current_directory: *const u16,
    startup_info: *const StartupInfoW,
    process_information: *mut ProcessInformation,
) -> i32 {
    CreateProcessAsUserW(
        LOW_TOKEN.load(Ordering::SeqCst),
        application_name,
        command_line,
        process_attributes,
        thread_attributes,
        inherit_handles,
        creation_flags,
        environment,
        current_directory,
        startup_info,
        process_information,
    )
}

const TRUE: i32 = 1;
const INFINITE: u32 = 0xFFFF_FFFF;
const CREATE_DEFAULT_ERROR_MODE: u32 = 0x0400_0000;
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;

fn to_utf16_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Rebuild a single command line from the split argv, quoting an argument that
/// holds a space (or is empty). A faithful port of the C++ launcher's `JoinArgs`;
/// it does not escape embedded quotes/backslashes, matching the proven behaviour
/// (tracked as a hardening item alongside the DLL's own gaps).
fn command_line(args: &[String]) -> Vec<u16> {
    let mut out = String::new();
    for a in args {
        if !out.is_empty() {
            out.push(' ');
        }
        let need_quote = a.is_empty() || a.contains(' ');
        if need_quote {
            out.push('"');
        }
        out.push_str(a);
        if need_quote {
            out.push('"');
        }
    }
    to_utf16_null(&out)
}

pub fn run(cfg: &Config) -> i32 {
    if cfg.command.is_empty() {
        eprintln!("cerebriline-sandbox: no command given");
        return 64;
    }
    if cfg.hook.as_os_str().is_empty() {
        eprintln!("cerebriline-sandbox: no hook DLL given (positional arg 1)");
        return 2;
    }

    // The DLL reads its trace-log path from this env var, inherited by the child.
    // CEREBRILINE_WS_ROOT / CEREBRILINE_OVERLAY_ROOT are already in our environment
    // and inherit too (we pass a null environment block).
    if let Some(log) = &cfg.log {
        let name = to_utf16_null("CEREBRILINE_SANDBOX_LOG");
        let value = to_utf16_null(&log.to_string_lossy());
        // Best-effort: a failure here only loses the trace, not the isolation.
        unsafe { SetEnvironmentVariableW(name.as_ptr(), value.as_ptr()) };
    }

    // Escape-critical: asked to confine and unable to, nothing is started.
    let confine = crate::confine_requested();
    if confine {
        if let Err(e) = prepare_confinement(cfg) {
            eprintln!("cerebriline-sandbox: cannot confine the command: {e}");
            return 71;
        }
    }
    let create_routine: *mut c_void = if confine {
        create_process_low as *mut c_void
    } else {
        std::ptr::null_mut()
    };

    // Detours takes the DLL path as ANSI (LPCSTR), as the C++ launcher did.
    let dll = match CString::new(cfg.hook.to_string_lossy().as_bytes()) {
        Ok(c) => c,
        Err(_) => {
            eprintln!("cerebriline-sandbox: hook path has an interior NUL");
            return 2;
        }
    };

    // CreateProcess may write to the command-line buffer, so it must be mutable.
    let mut cmd = command_line(&cfg.command);

    let mut si: StartupInfoW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<StartupInfoW>() as u32;
    let mut pi: ProcessInformation = unsafe { std::mem::zeroed() };

    let ok = unsafe {
        DetourCreateProcessWithDllExW(
            std::ptr::null(),
            cmd.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            TRUE,
            CREATE_DEFAULT_ERROR_MODE | CREATE_UNICODE_ENVIRONMENT,
            std::ptr::null_mut(),
            std::ptr::null(),
            &si,
            &mut pi,
            dll.as_ptr(),
            create_routine,
        )
    };
    if ok == 0 {
        // Escape-critical: the child never started, so nothing ran unsandboxed.
        let err = unsafe { GetLastError() };
        eprintln!("cerebriline-sandbox: DetourCreateProcessWithDllExW failed: {err}");
        return 3;
    }

    unsafe { WaitForSingleObject(pi.h_process, INFINITE) };
    let mut code: u32 = 0;
    unsafe { GetExitCodeProcess(pi.h_process, &mut code) };
    unsafe {
        CloseHandle(pi.h_thread);
        CloseHandle(pi.h_process);
    }
    code as i32
}
