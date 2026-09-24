//! macOS **M1** backend — APFS `clonefile`.
//!
//! macOS gives an unprivileged process no mount namespace, and SIP strips
//! `DYLD_INSERT_LIBRARIES` from `/bin/sh` and every system binary, so neither the
//! Linux L1 trick (mount an overlay over the workspace path) nor a DYLD-interpose
//! redirect is available. The viable backend is a block-level copy-on-write clone
//! of the workspace tree: `clonefile(2)` clones the whole directory instantly and
//! copies no data (APFS shares the blocks until a file is written), the command
//! runs against the clone, and the change set is recovered by diffing the clone
//! against the workspace afterwards — there is no kernel whiteout to read, so
//! `changedFiles()` is a tree diff, not a `.wh.` walk.
//!
//! **The cost, and it is real:** macOS is the one platform where absolute-path
//! fidelity is lost. The command runs with its cwd at the clone root, and any
//! workspace-rooted path in its argv is rewritten to the clone, so the common case
//! — the model writing `/Users/…/ws/x.html` straight into the command — is
//! redirected. But a path the command *constructs* at run time still resolves to
//! the real workspace. This is the documented M1 limitation (PLANS §10); the
//! alternatives (DYLD interpose, FSKit) are dead or too heavy. The escape-critical
//! rule is still honoured in spirit: this is a working redirect for the case the
//! model actually exercises, not "no redirect".

use std::ffi::CString;
use std::fs;
use std::io;
use std::os::raw::{c_char, c_int};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{Config, WHITEOUT_PREFIX};

// Declared directly so the binary needs no external crate. `clonefile` lives in
// libSystem, which Rust links by default on this target.
extern "C" {
    fn clonefile(src: *const c_char, dst: *const c_char, flags: u32) -> c_int;
}

fn cstr(p: &Path) -> io::Result<CString> {
    CString::new(p.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path has an interior NUL"))
}

pub fn run(cfg: &Config) -> i32 {
    let ws_root = &cfg.ws_root;
    if cfg.command.is_empty() {
        eprintln!("cerebriline-sandbox: no command given");
        return 64;
    }

    // The clone must land on the workspace's own APFS volume (clonefile is
    // same-volume only) and must not already exist. A hidden sibling of the
    // workspace keeps it on that volume without touching the tree the agent sees.
    let clone_dir = match clone_path(ws_root) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("cerebriline-sandbox: cannot choose a clone path: {e}");
            return 71;
        }
    };

    if let Err(e) = clone_tree(ws_root, &clone_dir) {
        eprintln!(
            "cerebriline-sandbox: clonefile of {} failed: {e}",
            ws_root.display()
        );
        // Escape-critical: with no clone there is no isolated view, so refuse
        // rather than run the command against the real workspace.
        return 71;
    }

    // Lay the agent's existing overlay onto the clone so the command shares the
    // same private view as the in-process file tools -- a file a tool already
    // wrote must be visible to the shell, and a file a tool deleted must be gone.
    // A seed failure is degraded (the command sees a slightly stale view), not an
    // escape, so it does not abort the run.
    if let Err(e) = apply_overlay(&cfg.overlay_root, &clone_dir) {
        eprintln!("cerebriline-sandbox: seeding the clone from the overlay failed: {e}");
    }

    let code = run_in_clone(cfg, ws_root, &clone_dir);

    // Fold the clone's changes into the persistent overlay root before tearing the
    // clone down. A reconcile failure must not turn into a lost change set, but it
    // also must not mask the command's own exit code.
    if let Err(e) = reconcile_diff(ws_root, &clone_dir, &cfg.overlay_root) {
        eprintln!("cerebriline-sandbox: reconcile failed: {e}");
    }
    let _ = fs::remove_dir_all(&clone_dir);
    code
}

/// A hidden, unique sibling of the workspace, on the same volume.
fn clone_path(ws_root: &Path) -> io::Result<PathBuf> {
    let parent = ws_root
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "workspace has no parent"))?;
    let stem = ws_root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "ws".to_string());
    // pid + a nanosecond stamp is enough uniqueness for one agent run; the dir is
    // removed at the end and clonefile refuses a pre-existing target anyway.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(parent.join(format!(
        ".cerebriline-clone-{stem}-{}-{stamp}",
        std::process::id()
    )))
}

fn clone_tree(src: &Path, dst: &Path) -> io::Result<()> {
    let (s, d) = (cstr(src)?, cstr(dst)?);
    // flags 0: follow the default (clones directories recursively, preserves
    // owner/mode, does not follow symlinks — they are cloned as symlinks).
    let rc = unsafe { clonefile(s.as_ptr(), d.as_ptr(), 0) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn run_in_clone(cfg: &Config, ws_root: &Path, clone_dir: &Path) -> i32 {
    let program = &cfg.command[0];
    let args = rewrite_args(&cfg.command[1..], ws_root, clone_dir);
    // A workspace-rooted program path is rewritten too, so `/ws/bin/tool` runs the
    // clone's copy; a bare name (`node`, `sh`) is left for PATH resolution.
    let program = rewrite_one(program, ws_root, clone_dir);
    match Command::new(&program)
        .args(&args)
        .current_dir(clone_dir)
        .status()
    {
        Ok(status) => status.code().unwrap_or_else(|| {
            // Killed by a signal: mirror the shell convention (128 + signal) so the
            // caller sees a non-zero code rather than a false success.
            use std::os::unix::process::ExitStatusExt;
            status.signal().map(|s| 128 + s).unwrap_or(1)
        }),
        Err(e) => {
            eprintln!("cerebriline-sandbox: failed to run {program}: {e}");
            127
        }
    }
}

/// Rewrite any argument that begins with the workspace root to the clone root, so
/// an absolute workspace path the model wrote into the command reaches the clone.
fn rewrite_args(args: &[String], ws_root: &Path, clone_dir: &Path) -> Vec<String> {
    args.iter()
        .map(|a| rewrite_one(a, ws_root, clone_dir))
        .collect()
}

fn rewrite_one(arg: &str, ws_root: &Path, clone_dir: &Path) -> String {
    let ws = ws_root.to_string_lossy();
    let clone = clone_dir.to_string_lossy();
    if arg == ws.as_ref() {
        return clone.into_owned();
    }
    // Only a real path boundary counts: `/ws` must not rewrite inside `/wsX`.
    let with_sep = format!("{ws}/");
    if let Some(rest) = arg.strip_prefix(&with_sep) {
        return format!("{clone}/{rest}");
    }
    arg.to_string()
}

/// Lay the agent's existing overlay onto the freshly cloned tree, so the command
/// sees exactly what the in-process file tools have already done: a regular file in
/// the overlay is copied over the clone's copy (or created), and a `.wh.<name>`
/// marker deletes the named entry from the clone. This is the inverse of
/// `reconcile_diff` and speaks the same `.wh.` format. An empty or absent overlay is
/// the common first-command case and is a no-op.
fn apply_overlay(overlay_root: &Path, clone_dir: &Path) -> io::Result<()> {
    if !overlay_root.exists() {
        return Ok(());
    }
    apply_overlay_dir(Path::new(""), overlay_root, clone_dir)
}

fn apply_overlay_dir(rel: &Path, overlay_root: &Path, clone_dir: &Path) -> io::Result<()> {
    let here = overlay_root.join(rel);
    let entries = match fs::read_dir(&here) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let file_type = entry.file_type()?;
        if let Some(stripped) = name_str.strip_prefix(WHITEOUT_PREFIX) {
            // A deletion: remove the named entry from the clone. It may be a file,
            // a symlink, or a directory; try each without treating "already gone" as
            // an error (the workspace may simply not have carried it).
            let target = clone_dir.join(rel).join(stripped);
            let _ = fs::remove_file(&target);
            let _ = fs::remove_dir_all(&target);
            continue;
        }
        let child_rel = rel.join(&name);
        if file_type.is_dir() {
            let dst = clone_dir.join(&child_rel);
            fs::create_dir_all(&dst)?;
            apply_overlay_dir(&child_rel, overlay_root, clone_dir)?;
        } else {
            let src = overlay_root.join(&child_rel);
            let dst = clone_dir.join(&child_rel);
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent)?;
            }
            // Replace whatever the clone carried; the overlay copy is authoritative.
            let _ = fs::remove_file(&dst);
            if file_type.is_symlink() {
                let link = fs::read_link(&src)?;
                std::os::unix::fs::symlink(link, &dst)?;
            } else {
                fs::copy(&src, &dst)?;
            }
        }
    }
    Ok(())
}

/// Produce the change set by diffing the clone against the workspace, writing the
/// agent's version into `overlay_root` in the shared `.wh.` format: a file the
/// command wrote or changed lands as a regular file, a file it deleted becomes an
/// empty `.wh.<name>` marker. An unchanged file (still block-shared by the COW
/// clone) is skipped, exactly as the in-process overlay's `changedFiles()` skips a
/// copy-up equal to the workspace.
fn reconcile_diff(ws_root: &Path, clone_dir: &Path, overlay_root: &Path) -> io::Result<()> {
    fs::create_dir_all(overlay_root)?;
    diff_dir(Path::new(""), ws_root, clone_dir, overlay_root)
}

fn diff_dir(rel: &Path, ws_root: &Path, clone_dir: &Path, overlay_root: &Path) -> io::Result<()> {
    let clone_here = clone_dir.join(rel);
    let ws_here = ws_root.join(rel);

    // Files/dirs present in the clone: new or modified relative to the workspace.
    if let Ok(entries) = fs::read_dir(&clone_here) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with(WHITEOUT_PREFIX) {
                continue; // never let a literal `.wh.` name in the tree confuse us
            }
            let child_rel = rel.join(&name);
            let clone_path = clone_dir.join(&child_rel);
            let ws_path = ws_root.join(&child_rel);
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                diff_dir(&child_rel, ws_root, clone_dir, overlay_root)?;
            } else if file_type.is_file() {
                if !same_file(&ws_path, &clone_path) {
                    let dst = overlay_root.join(&child_rel);
                    if let Some(parent) = dst.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::copy(&clone_path, &dst)?;
                }
            } else if file_type.is_symlink() && !same_symlink(&ws_path, &clone_path) {
                let dst = overlay_root.join(&child_rel);
                if let Some(parent) = dst.parent() {
                    fs::create_dir_all(parent)?;
                }
                let target = fs::read_link(&clone_path)?;
                let _ = fs::remove_file(&dst);
                std::os::unix::fs::symlink(target, &dst)?;
            }
        }
    }

    // Files present in the workspace but gone from the clone: the command deleted
    // them. Record a whiteout at the overlay path.
    if let Ok(entries) = fs::read_dir(&ws_here) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let child_rel = rel.join(&name);
            let clone_path = clone_dir.join(&child_rel);
            if !path_exists(&clone_path) {
                write_whiteout(overlay_root, &child_rel)?;
            }
        }
    }
    Ok(())
}

fn write_whiteout(overlay_root: &Path, rel: &Path) -> io::Result<()> {
    let dst = overlay_root.join(rel);
    let dir = dst.parent().unwrap_or(overlay_root);
    fs::create_dir_all(dir)?;
    let name = rel
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let marker = dir.join(format!("{}{name}", WHITEOUT_PREFIX));
    // A previous run's copy-up of the same path must not shadow the whiteout.
    let _ = fs::remove_file(&dst);
    fs::File::create(marker)?;
    Ok(())
}

/// True when both regular files exist with identical size and bytes. A COW clone
/// leaves an untouched file block-identical, so most files short-circuit on size.
fn same_file(a: &Path, b: &Path) -> bool {
    let (ma, mb) = match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(ma), Ok(mb)) => (ma, mb),
        _ => return false, // a is absent (b is new) or unreadable → treat as changed
    };
    if !ma.file_type().is_file() || !mb.file_type().is_file() || ma.size() != mb.size() {
        return false;
    }
    match (fs::read(a), fs::read(b)) {
        (Ok(ba), Ok(bb)) => ba == bb,
        _ => false,
    }
}

fn same_symlink(a: &Path, b: &Path) -> bool {
    match (fs::read_link(a), fs::read_link(b)) {
        (Ok(ta), Ok(tb)) => ta == tb,
        _ => false,
    }
}

fn path_exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}
