//! `cerebriline-sandbox` — the command-sandbox launcher for Cerebriline's
//! delegated agents. It runs a command (and its whole process tree) against a
//! per-agent copy-on-write overlay of the workspace, so the agent's shell work
//! shares the same private view as its in-process file tools and never touches
//! the lead's files.
//!
//! One binary, one CLI, a per-OS backend chosen at build time: Linux (L1 user
//! namespace + overlayfs, L2 ptrace fallback), macOS (M1 APFS clonefile), Windows
//! (W1 Detours injection — the launcher folded in here; the C++ `hook.dll` it
//! loads stays separate). See PLANS.md §10.
//!
//! ## Invocation (matches `wrapSpawn` in `agent-sandbox.ts`)
//!
//! ```text
//! cerebriline-sandbox <hook> <log> <command> [args...]
//! ```
//!
//! with `CEREBRILINE_WS_ROOT` and `CEREBRILINE_OVERLAY_ROOT` in the environment
//! (and `CEREBRILINE_SANDBOX_LOG` optionally overriding `<log>`). `<hook>` is the
//! injected library the Windows backend needs and every other backend ignores;
//! it is kept positional so a single `wrapSpawn` shape drives every platform.

/// The whiteout marker prefix shared with the in-process overlay
/// (`WHITEOUT_PREFIX` in `overlay-fs.ts`): a deletion is an empty `.wh.<name>`.
/// Lives at the crate root so every backend's reconcile speaks the same format.
pub const WHITEOUT_PREFIX: &str = ".wh.";

// The overlayfs `.wh.` reconcile machinery is the L1 (Linux) teardown; macOS does
// its own diff-against-base reconcile, so the module is Linux-only.
#[cfg(target_os = "linux")]
mod overlay;

#[cfg(target_os = "linux")]
mod linux;

// The L2 (ptrace) backend and its resolver are x86_64-only for now.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod linux_l2;

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod resolve;

// The macOS M1 backend (APFS clonefile). x86_64 and arm64 both have clonefile.
#[cfg(target_os = "macos")]
mod macos;

// The Windows W1 backend (Detours DLL injection). It folds the C++
// `sandbox-launch.exe` into this binary; the injected `hook.dll` stays C++.
#[cfg(windows)]
mod windows;

use std::path::PathBuf;

/// The resolved launch request.
pub struct Config {
    /// The injected hook DLL the Windows (W1) backend loads into the child. It is
    /// positional so one `wrapSpawn` shape drives every platform; every backend but
    /// Windows ignores it.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub hook: PathBuf,
    /// The lead's workspace; the overlay's lower layer.
    pub ws_root: PathBuf,
    /// The agent's private overlay directory; the hand-back is read from here.
    pub overlay_root: PathBuf,
    /// Optional trace log path.
    pub log: Option<PathBuf>,
    /// The command and its arguments.
    pub command: Vec<String>,
}

fn parse() -> Result<Config, String> {
    let args: Vec<String> = std::env::args().collect();
    // args[0] = self, [1] = hook (ignored off Windows), [2] = log, [3..] = cmd.
    if args.len() < 4 {
        return Err(
            "usage: cerebriline-sandbox <hook> <log> <command> [args...] \
             (with CEREBRILINE_WS_ROOT and CEREBRILINE_OVERLAY_ROOT set)"
                .to_string(),
        );
    }
    let hook = PathBuf::from(args[1].clone());
    let log_arg = args[2].clone();
    let command = args[3..].to_vec();

    let ws_root = env_path("CEREBRILINE_WS_ROOT")?;
    let overlay_root = env_path("CEREBRILINE_OVERLAY_ROOT")?;
    let log = std::env::var("CEREBRILINE_SANDBOX_LOG")
        .ok()
        .or(Some(log_arg))
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    Ok(Config {
        hook,
        ws_root,
        overlay_root,
        log,
        command,
    })
}

fn env_path(key: &str) -> Result<PathBuf, String> {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => Ok(PathBuf::from(v)),
        _ => Err(format!("{key} is not set")),
    }
}

// The L2 (ptrace) backend is implemented for x86_64 only. On another Linux arch
// it is unavailable, so refuse rather than run the command unsandboxed (the
// escape-critical rule). arm64 has working user namespaces, so `auto` reaches
// this only when L1 is force-disabled or unavailable.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn run_l2(cfg: &Config) -> i32 {
    linux_l2::run(cfg)
}

#[cfg(all(target_os = "linux", not(target_arch = "x86_64")))]
fn run_l2(_cfg: &Config) -> i32 {
    eprintln!(
        "cerebriline-sandbox: the L2 (ptrace) backend is only implemented for \
         x86_64; refusing to run the command unsandboxed"
    );
    71
}

fn main() {
    let cfg = match parse() {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("cerebriline-sandbox: {e}");
            std::process::exit(64); // EX_USAGE
        }
    };

    #[cfg(target_os = "linux")]
    {
        // L1 (user namespace + overlayfs) is the default; L2 (ptrace) is the
        // fallback for hosts where L1 cannot run. `CEREBRILINE_SANDBOX_BACKEND`
        // forces one (`l1`/`l2`); `auto` (the default) uses L1 when unprivileged
        // user namespaces are available and L2 otherwise.
        let backend = std::env::var("CEREBRILINE_SANDBOX_BACKEND").unwrap_or_default();
        let code = match backend.as_str() {
            "l2" => run_l2(&cfg),
            "l1" => linux::run(&cfg),
            _ => {
                if linux::userns_available() {
                    linux::run(&cfg)
                } else {
                    run_l2(&cfg)
                }
            }
        };
        std::process::exit(code);
    }

    // macOS: the M1 backend (APFS clonefile). No user namespace and no viable
    // interpose, so the command runs against a copy-on-write clone and the change
    // set is diffed back out. `CEREBRILINE_SANDBOX_BACKEND` is accepted for
    // symmetry but there is only one backend to name here.
    #[cfg(target_os = "macos")]
    {
        std::process::exit(macos::run(&cfg));
    }

    // Windows: the W1 backend starts the command with `hook.dll` injected via
    // Detours; the DLL redirects file I/O into the overlay and re-injects itself
    // into every child, so the whole tree runs sandboxed.
    #[cfg(windows)]
    {
        std::process::exit(windows::run(&cfg));
    }

    // The escape-critical rule: with no working backend, refuse the command
    // rather than run it unsandboxed. The caller withholds `run_commands` when
    // no launcher exists, so reaching here is a wiring bug, and running the
    // command anyway would write straight to the lead's workspace.
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = &cfg;
        eprintln!(
            "cerebriline-sandbox: no command-sandbox backend is built for this \
             platform; refusing to run the command unsandboxed"
        );
        std::process::exit(70); // EX_SOFTWARE
    }
}
