//! The overlay reconciliation: bridge the kernel overlayfs upper layer (regular
//! files plus `0:0` chardev whiteouts) to the `.wh.<name>` on-disk format the
//! in-process `AgentOverlay` reads back for the hand-back.
//!
//! A change is a full regular file at `overlay_root/<rel>`; a deletion is an
//! empty `.wh.<name>` file. `changedFiles()` on the TypeScript side walks
//! `overlay_root` and already filters copy-ups whose content equals the
//! workspace, so re-writing an unchanged file here is harmless.
//!
//! None of this needs privilege: it is plain file I/O in the launcher's parent
//! process, so it is unit-tested without a namespace or a mount.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};

/// AUFS-style whiteout marker prefix, shared with the TS overlay and the
/// Windows hook (`WHITEOUT_PREFIX` in `overlay-fs.ts`).
pub use crate::WHITEOUT_PREFIX;

/// What a walk of the kernel upper layer found, as workspace-relative paths.
#[derive(Default, Debug)]
pub struct UpperScan {
    /// Files the command created or modified.
    pub regular: BTreeSet<String>,
    /// Names the command deleted, recorded by overlayfs as a `0:0` char device.
    pub whiteouts: BTreeSet<String>,
}

fn is_whiteout_name(name: &str) -> bool {
    name.starts_with(WHITEOUT_PREFIX)
}

fn join_rel(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// Seed the kernel upper layer with the tool overlay's current files so a
/// command sees the edits the agent already made with its file tools. Only
/// regular files are copied; a `.wh.` tool-deletion is left out of the command's
/// view (a documented v1 gap — see PLANS.md §10). Returns the rels seeded, which
/// reconcile needs to detect an upper-only file the command then deleted.
pub fn preseed(overlay_root: &Path, upper: &Path) -> io::Result<Vec<String>> {
    let mut seeded = Vec::new();
    if !overlay_root.exists() {
        return Ok(seeded);
    }
    seed_dir(overlay_root, overlay_root, upper, &mut seeded)?;
    Ok(seeded)
}

fn seed_dir(
    overlay_root: &Path,
    dir: &Path,
    upper: &Path,
    seeded: &mut Vec<String>,
) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let ft = entry.file_type()?;
        let path = entry.path();
        if ft.is_dir() {
            seed_dir(overlay_root, &path, upper, seeded)?;
            continue;
        }
        if is_whiteout_name(&name) || !ft.is_file() {
            continue;
        }
        let rel = rel_of(overlay_root, &path);
        let dst = upper.join(&rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&path, &dst)?;
        seeded.push(rel);
    }
    Ok(())
}

/// Walk the kernel upper layer, classifying each entry as a written file or a
/// whiteout (a `0:0` char device). Opaque-directory xattrs are not handled in
/// v1; a directory is recursed as normal.
pub fn scan_upper(upper: &Path) -> io::Result<UpperScan> {
    let mut scan = UpperScan::default();
    if upper.exists() {
        scan_dir(upper, "", &mut scan)?;
    }
    Ok(scan)
}

fn scan_dir(dir: &Path, prefix: &str, scan: &mut UpperScan) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy().to_string();
        let meta = entry
            .metadata()
            .or_else(|_| fs::symlink_metadata(entry.path()))?;
        let ft = meta.file_type();
        if ft.is_dir() {
            scan_dir(&entry.path(), &join_rel(prefix, &name), scan)?;
            continue;
        }
        let rel = join_rel(prefix, &name);
        // overlayfs records a deletion as a character device with rdev 0.
        if ft.is_char_device() && meta.rdev() == 0 {
            scan.whiteouts.insert(rel);
        } else if ft.is_file() {
            scan.regular.insert(rel);
        }
        // Anything else (symlink, socket, real device) is left untouched in v1.
    }
    Ok(())
}

/// Fold the command's changes (in the kernel upper) into `overlay_root` in the
/// `.wh.` format the hand-back reads. `preseeded` is the set from [`preseed`], so
/// a tool-created file the command deleted (upper-only, no lower to whiteout) is
/// caught by its disappearance.
pub fn reconcile(
    ws_root: &Path,
    overlay_root: &Path,
    upper: &Path,
    preseeded: &[String],
) -> io::Result<()> {
    fs::create_dir_all(overlay_root)?;
    let scan = scan_upper(upper)?;

    // A file the command wrote: copy it in, and drop any tool-deletion marker
    // for the same name (the command re-created it).
    for rel in &scan.regular {
        let dst = overlay_root.join(rel);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(upper.join(rel), &dst)?;
        remove_whiteout_marker(overlay_root, rel)?;
    }

    // A file the command deleted. If the workspace has it, the deletion has to
    // be recorded as a `.wh.` tombstone; otherwise it was an overlay-only file
    // and it is enough that it is gone.
    for rel in &scan.whiteouts {
        remove_path(&overlay_root.join(rel))?;
        if workspace_has(ws_root, rel) {
            write_whiteout_marker(overlay_root, rel)?;
        } else {
            remove_whiteout_marker(overlay_root, rel)?;
        }
    }

    // A seeded file that is neither written nor whiteouted and is not in the
    // workspace vanished: the command deleted an overlay-only (tool-created)
    // file, which overlayfs drops from the upper without a whiteout because
    // there is no lower entry to hide.
    for rel in preseeded {
        if scan.regular.contains(rel) || scan.whiteouts.contains(rel) {
            continue;
        }
        if workspace_has(ws_root, rel) {
            continue;
        }
        remove_path(&overlay_root.join(rel))?;
    }

    Ok(())
}

fn rel_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn workspace_has(ws_root: &Path, rel: &str) -> bool {
    fs::symlink_metadata(ws_root.join(rel)).is_ok()
}

fn whiteout_marker_path(overlay_root: &Path, rel: &str) -> PathBuf {
    let p = Path::new(rel);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let marker = format!("{WHITEOUT_PREFIX}{name}");
    match p.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => overlay_root.join(parent).join(marker),
        _ => overlay_root.join(marker),
    }
}

fn write_whiteout_marker(overlay_root: &Path, rel: &str) -> io::Result<()> {
    let marker = whiteout_marker_path(overlay_root, rel);
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&marker, b"")
}

fn remove_whiteout_marker(overlay_root: &Path, rel: &str) -> io::Result<()> {
    remove_path(&whiteout_marker_path(overlay_root, rel))
}

fn remove_path(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "cbl-ovl-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    // The kernel makes whiteouts as 0:0 char devices, which a test cannot
    // create without privilege. reconcile only ever *reads* them, so the tests
    // that need a whiteout drive reconcile through a hand-built upper where a
    // deletion is represented some other way is not possible — instead these
    // tests cover the paths that do not require a chardev, and the chardev read
    // itself is covered by the live Linux integration test.

    #[test]
    fn preseed_copies_regular_files_and_skips_whiteouts() {
        let base = tmp();
        let overlay = base.join("ov");
        let upper = base.join("up");
        write(&overlay, "src/a.txt", "EDIT");
        write(&overlay, "src/.wh.gone.txt", ""); // a tool deletion marker
        fs::create_dir_all(&upper).unwrap();

        let seeded = preseed(&overlay, &upper).unwrap();

        assert_eq!(seeded, vec!["src/a.txt".to_string()]);
        assert_eq!(fs::read_to_string(upper.join("src/a.txt")).unwrap(), "EDIT");
        assert!(!upper.join("src/.wh.gone.txt").exists());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn reconcile_writes_command_files_and_clears_recreate_marker() {
        let base = tmp();
        let ws = base.join("ws");
        let overlay = base.join("ov");
        let upper = base.join("up");
        write(&ws, "keep.txt", "ORIG");
        // The agent had deleted keep.txt with a tool: a marker is present.
        write(&overlay, ".wh.keep.txt", "");
        // The command then re-created keep.txt: it is a regular file in upper.
        write(&upper, "keep.txt", "REMADE");
        write(&upper, "fresh.txt", "NEW");

        reconcile(&ws, &overlay, &upper, &[]).unwrap();

        assert_eq!(
            fs::read_to_string(overlay.join("keep.txt")).unwrap(),
            "REMADE"
        );
        assert!(!overlay.join(".wh.keep.txt").exists(), "marker cleared");
        assert_eq!(
            fs::read_to_string(overlay.join("fresh.txt")).unwrap(),
            "NEW"
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn reconcile_drops_a_seeded_overlay_only_file_the_command_deleted() {
        let base = tmp();
        let ws = base.join("ws");
        let overlay = base.join("ov");
        let upper = base.join("up");
        fs::create_dir_all(&ws).unwrap();
        // A tool-created file (not in the workspace) that was seeded into upper.
        write(&overlay, "tool_only.txt", "FROM TOOL");
        // The command deleted it: overlayfs leaves no whiteout (no lower entry),
        // so it is simply absent from the upper, and not in the workspace.
        fs::create_dir_all(&upper).unwrap();

        reconcile(&ws, &overlay, &upper, &["tool_only.txt".to_string()]).unwrap();

        assert!(
            !overlay.join("tool_only.txt").exists(),
            "a seeded overlay-only file the command removed must be dropped"
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn reconcile_keeps_a_seeded_file_the_command_left_alone() {
        let base = tmp();
        let ws = base.join("ws");
        let overlay = base.join("ov");
        let upper = base.join("up");
        fs::create_dir_all(&ws).unwrap();
        write(&overlay, "tool_only.txt", "FROM TOOL");
        // Seeded and untouched: overlayfs keeps it in the upper as a regular file.
        write(&upper, "tool_only.txt", "FROM TOOL");

        reconcile(&ws, &overlay, &upper, &["tool_only.txt".to_string()]).unwrap();

        assert_eq!(
            fs::read_to_string(overlay.join("tool_only.txt")).unwrap(),
            "FROM TOOL"
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn whiteout_marker_path_is_a_sibling_dotwh_name() {
        let root = Path::new("/ov");
        assert_eq!(
            whiteout_marker_path(root, "src/a.txt"),
            Path::new("/ov/src/.wh.a.txt")
        );
        assert_eq!(
            whiteout_marker_path(root, "top.txt"),
            Path::new("/ov/.wh.top.txt")
        );
    }
}
