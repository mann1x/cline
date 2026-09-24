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
//! Like the other backends this declares the handful of entry points it needs
//! directly (`extern "system"`), so the crate stays free of external
//! dependencies. The one native library on the link line is Microsoft Detours'
//! `detours.lib` (for `DetourCreateProcessWithDllExW`), located at build time via
//! `DETOURS_LIB_DIR` — see `build.rs` and `sandbox/w1-spike/build.bat`.

use std::ffi::CString;
use std::os::raw::{c_char, c_void};

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
            std::ptr::null_mut(),
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
