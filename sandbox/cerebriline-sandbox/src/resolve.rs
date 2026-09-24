//! Live overlay resolution for the L2 (ptrace) backend: given an absolute path a
//! traced syscall is about to use, decide what the sandbox should do — read
//! through to the workspace, redirect to the agent's private overlay copy, or
//! emulate a delete. This mirrors the in-process `AgentOverlay` (overlay-fs.ts)
//! and produces the same `.wh.<name>` on-disk format, so a change a command
//! makes through L2 reads back for the hand-back exactly like one made by a tool
//! or by the L1 backend.
//!
//! None of this needs privilege — it is plain file I/O — so it is unit-tested
//! without ptrace.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::overlay::WHITEOUT_PREFIX;

/// Where an absolute path sits relative to the sandbox.
pub struct Located {
    /// True when the path is inside the workspace (so the overlay governs it).
    pub inside: bool,
    /// The overlay copy's path (valid only when `inside`).
    pub overlay: PathBuf,
    /// The whiteout marker's path (valid only when `inside`).
    pub whiteout: PathBuf,
}

fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

fn whiteout_for(overlay_path: &Path) -> PathBuf {
    let name = overlay_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    match overlay_path.parent() {
        Some(parent) => parent.join(format!("{WHITEOUT_PREFIX}{name}")),
        None => PathBuf::from(format!("{WHITEOUT_PREFIX}{name}")),
    }
}

/// Locate `abs` (already absolute and normalised) against the workspace.
pub fn locate(ws_root: &Path, overlay_root: &Path, abs: &Path) -> Located {
    match abs.strip_prefix(ws_root) {
        Ok(rel) if rel.as_os_str().is_empty() => Located {
            // The workspace root itself: inside, but it has no overlay file.
            inside: true,
            overlay: overlay_root.to_path_buf(),
            whiteout: overlay_root.join(WHITEOUT_PREFIX),
        },
        Ok(rel) => {
            let overlay = overlay_root.join(rel);
            let whiteout = whiteout_for(&overlay);
            Located {
                inside: true,
                overlay,
                whiteout,
            }
        }
        Err(_) => Located {
            inside: false,
            overlay: PathBuf::new(),
            whiteout: PathBuf::new(),
        },
    }
}

/// The path a *read* (open O_RDONLY, stat, access, readlink, …) should use, or
/// `None` to leave the syscall pointing at the original path (a read-through to
/// the workspace). Returns the overlay path when the agent has its own copy, or
/// when the file was whiteouted (the overlay path then does not exist, so the
/// syscall fails with ENOENT — the deletion the agent made).
pub fn resolve_read(ws_root: &Path, overlay_root: &Path, abs: &Path) -> Option<PathBuf> {
    let l = locate(ws_root, overlay_root, abs);
    if !l.inside {
        return None;
    }
    if exists(&l.overlay) {
        return Some(l.overlay);
    }
    if exists(&l.whiteout) {
        return Some(l.overlay); // absent -> ENOENT for the command
    }
    None
}

/// The path a *write* (open with write/create/trunc/append, creat) should use:
/// the overlay copy, copying the workspace version up first so a
/// read-modify-write sees the lead's content, and dropping any whiteout. Returns
/// `None` for a path outside the workspace (left untouched).
pub fn resolve_write(
    ws_root: &Path,
    overlay_root: &Path,
    abs: &Path,
) -> io::Result<Option<PathBuf>> {
    let l = locate(ws_root, overlay_root, abs);
    if !l.inside {
        return Ok(None);
    }
    if let Some(parent) = l.overlay.parent() {
        fs::create_dir_all(parent)?;
    }
    if exists(&l.whiteout) {
        let _ = fs::remove_file(&l.whiteout);
    }
    // Copy the lead's file up on first write so a read-modify-write sees its
    // content. `abs` is the workspace path, so it reads the pristine lower.
    if !exists(&l.overlay) {
        if let Ok(meta) = fs::symlink_metadata(abs) {
            if meta.is_file() {
                fs::copy(abs, &l.overlay)?;
            }
        }
    }
    Ok(Some(l.overlay))
}

/// The overlay path a directory create should use (mkdir/mkdirat), dropping any
/// whiteout, or `None` outside the workspace.
pub fn resolve_mkdir(
    ws_root: &Path,
    overlay_root: &Path,
    abs: &Path,
) -> io::Result<Option<PathBuf>> {
    let l = locate(ws_root, overlay_root, abs);
    if !l.inside {
        return Ok(None);
    }
    if let Some(parent) = l.overlay.parent() {
        fs::create_dir_all(parent)?;
    }
    if exists(&l.whiteout) {
        let _ = fs::remove_file(&l.whiteout);
    }
    Ok(Some(l.overlay))
}

/// Emulate a delete (unlink/unlinkat/rmdir): remove the overlay copy if any and
/// leave a whiteout so the workspace file reads as gone. Returns true when the
/// path was inside the workspace and the caller should neutralise the syscall
/// (make it a no-op success); false to let the original syscall run (outside the
/// workspace).
pub fn emulate_delete(ws_root: &Path, overlay_root: &Path, abs: &Path) -> io::Result<bool> {
    let l = locate(ws_root, overlay_root, abs);
    if !l.inside {
        return Ok(false);
    }
    if exists(&l.overlay) {
        if fs::symlink_metadata(&l.overlay)
            .map(|m| m.is_dir())
            .unwrap_or(false)
        {
            let _ = fs::remove_dir_all(&l.overlay);
        } else {
            let _ = fs::remove_file(&l.overlay);
        }
    }
    // Only a file that exists in the workspace needs a tombstone; an overlay-only
    // file is simply gone.
    if exists_in_workspace(abs) {
        if let Some(parent) = l.whiteout.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&l.whiteout, b"")?;
    }
    Ok(true)
}

fn exists_in_workspace(abs: &Path) -> bool {
    // `abs` is the workspace path itself; a command that reaches delete-emulation
    // has not had it redirected, so a stat here is the pristine workspace.
    exists(abs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "cbl-resolve-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    struct Fx {
        base: PathBuf,
        ws: PathBuf,
        ov: PathBuf,
    }
    fn fx() -> Fx {
        let base = tmp();
        let ws = base.join("ws");
        let ov = base.join("ov");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&ov).unwrap();
        Fx { base, ws, ov }
    }

    #[test]
    fn read_of_an_untouched_file_is_left_alone() {
        let f = fx();
        fs::write(f.ws.join("a.txt"), "ORIG").unwrap();
        assert_eq!(resolve_read(&f.ws, &f.ov, &f.ws.join("a.txt")), None);
        fs::remove_dir_all(&f.base).ok();
    }

    #[test]
    fn read_prefers_the_overlay_copy() {
        let f = fx();
        fs::write(f.ws.join("a.txt"), "ORIG").unwrap();
        fs::write(f.ov.join("a.txt"), "EDIT").unwrap();
        assert_eq!(
            resolve_read(&f.ws, &f.ov, &f.ws.join("a.txt")),
            Some(f.ov.join("a.txt"))
        );
        fs::remove_dir_all(&f.base).ok();
    }

    #[test]
    fn read_of_a_whiteouted_file_points_at_the_absent_overlay_path() {
        let f = fx();
        fs::write(f.ws.join("a.txt"), "ORIG").unwrap();
        fs::write(f.ov.join(".wh.a.txt"), "").unwrap();
        let got = resolve_read(&f.ws, &f.ov, &f.ws.join("a.txt"));
        assert_eq!(got, Some(f.ov.join("a.txt")));
        assert!(!got.unwrap().exists(), "the overlay path must not exist");
        fs::remove_dir_all(&f.base).ok();
    }

    #[test]
    fn write_copies_the_workspace_file_up_and_returns_the_overlay_path() {
        let f = fx();
        fs::write(f.ws.join("a.txt"), "ORIG").unwrap();
        let got = resolve_write(&f.ws, &f.ov, &f.ws.join("a.txt")).unwrap();
        assert_eq!(got, Some(f.ov.join("a.txt")));
        assert_eq!(fs::read_to_string(f.ov.join("a.txt")).unwrap(), "ORIG");
        assert_eq!(fs::read_to_string(f.ws.join("a.txt")).unwrap(), "ORIG");
        fs::remove_dir_all(&f.base).ok();
    }

    #[test]
    fn write_drops_a_prior_whiteout() {
        let f = fx();
        fs::write(f.ov.join(".wh.a.txt"), "").unwrap();
        let got = resolve_write(&f.ws, &f.ov, &f.ws.join("a.txt")).unwrap();
        assert_eq!(got, Some(f.ov.join("a.txt")));
        assert!(!f.ov.join(".wh.a.txt").exists());
        fs::remove_dir_all(&f.base).ok();
    }

    #[test]
    fn delete_of_a_workspace_file_leaves_a_whiteout() {
        let f = fx();
        fs::write(f.ws.join("a.txt"), "ORIG").unwrap();
        let handled = emulate_delete(&f.ws, &f.ov, &f.ws.join("a.txt")).unwrap();
        assert!(handled);
        assert!(f.ov.join(".wh.a.txt").exists());
        assert!(f.ws.join("a.txt").exists(), "workspace untouched");
        fs::remove_dir_all(&f.base).ok();
    }

    #[test]
    fn delete_of_an_overlay_only_file_removes_it_without_a_tombstone() {
        let f = fx();
        fs::write(f.ov.join("fresh.txt"), "NEW").unwrap();
        let handled = emulate_delete(&f.ws, &f.ov, &f.ws.join("fresh.txt")).unwrap();
        assert!(handled);
        assert!(!f.ov.join("fresh.txt").exists());
        assert!(!f.ov.join(".wh.fresh.txt").exists(), "no tombstone needed");
        fs::remove_dir_all(&f.base).ok();
    }

    #[test]
    fn a_path_outside_the_workspace_is_never_intercepted() {
        let f = fx();
        let outside = f.base.join("elsewhere/x.txt");
        assert_eq!(resolve_read(&f.ws, &f.ov, &outside), None);
        assert_eq!(resolve_write(&f.ws, &f.ov, &outside).unwrap(), None);
        assert!(!emulate_delete(&f.ws, &f.ov, &outside).unwrap());
        fs::remove_dir_all(&f.base).ok();
    }
}
