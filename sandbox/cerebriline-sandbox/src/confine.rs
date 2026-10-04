//! Write confinement for the Linux backends: the command tree may read the
//! whole system and may write only the workspace and the temp folders.
//!
//! The overlay already keeps the agent's work off the lead's files. It says
//! nothing about the rest of the machine: a command runs with the user's own
//! rights and can write the home directory, shell profiles, `~/.local/bin`.
//! In swarm wlafh (Windows, where the same gap exists) two agents changed the
//! host to get a check past a shell that could not find its program, and their
//! reports said "no file changes".
//!
//! Nothing here needs setup or privilege. It uses what the L1 backend already
//! has, a user namespace of its own:
//!
//! 1. a second mount namespace for the command alone, so the launcher keeps
//!    its writable view for the reconcile step;
//! 2. the temp folders (`/tmp`, `/var/tmp`) bound onto themselves, which makes
//!    each a mount of its own that stays writable;
//! 3. every other mount remounted read-only, keeping the flags it had (a
//!    locked flag that is dropped fails the remount);
//! 4. the capability bounding set emptied and `no_new_privs` set, so the
//!    command, which is uid 0 inside the namespace, cannot remount anything
//!    writable again, and neither can a namespace it creates: the mounts it
//!    inherits there are locked.
//!
//! `/proc`, `/sys` and `/dev` are left as they are. They hold no user data, a
//! write to a device node is not a write to the filesystem, and programs
//! expect `/dev/shm`, `/dev/pts` and `/proc/self` to work.
//!
//! Landlock would be the smaller tool, but it has to be in the kernel's active
//! LSM list, and on the hosts measured (a PVE 6.2 kernel, a Raspberry Pi 6.18
//! kernel) it is compiled in and not active.

use std::ffi::CString;
use std::fs;
use std::io;
use std::os::raw::{c_char, c_int, c_ulong, c_void};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

extern "C" {
    fn unshare(flags: c_int) -> c_int;
    fn mount(
        source: *const c_char,
        target: *const c_char,
        fstype: *const c_char,
        flags: c_ulong,
        data: *const c_void,
    ) -> c_int;
    fn prctl(option: c_int, arg2: c_ulong, arg3: c_ulong, arg4: c_ulong, arg5: c_ulong) -> c_int;
}

const CLONE_NEWNS: c_int = 0x0002_0000;
const MS_RDONLY: c_ulong = 1;
const MS_NOSUID: c_ulong = 2;
const MS_NODEV: c_ulong = 4;
const MS_NOEXEC: c_ulong = 8;
const MS_REMOUNT: c_ulong = 32;
const MS_NOATIME: c_ulong = 1024;
const MS_NODIRATIME: c_ulong = 2048;
const MS_BIND: c_ulong = 4096;
const MS_REC: c_ulong = 0x4000;
const MS_PRIVATE: c_ulong = 1 << 18;
const MS_RELATIME: c_ulong = 1 << 21;
const PR_CAPBSET_DROP: c_int = 24;
const PR_SET_NO_NEW_PRIVS: c_int = 38;
/// Above the highest capability any kernel defines; the surplus calls fail
/// with EINVAL and are ignored.
const CAP_LAST_PROBE: c_ulong = 63;

/// Kernel filesystems left untouched: no user data, and programs expect them
/// to behave.
const KERNEL_TREES: [&str; 3] = ["/proc", "/sys", "/dev"];
/// The system temp folders, writable to the command.
const TEMP_DIRS: [&str; 2] = ["/tmp", "/var/tmp"];

/// One line of `/proc/self/mountinfo`: where it is mounted and with what flags.
struct MountEntry {
    point: PathBuf,
    flags: c_ulong,
}

/// `\040`-style octal escapes, as mountinfo writes a space, tab, newline or
/// backslash inside a path.
fn unescape(field: &str) -> PathBuf {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&field[i + 1..i + 4], 8) {
                out.push(v);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    PathBuf::from(std::ffi::OsStr::from_bytes(&out))
}

fn parse_mountinfo(text: &str) -> Vec<MountEntry> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split(' ');
            let point = fields.nth(4)?;
            let options = fields.next()?;
            let mut flags: c_ulong = 0;
            for option in options.split(',') {
                flags |= match option {
                    "ro" => MS_RDONLY,
                    "nosuid" => MS_NOSUID,
                    "nodev" => MS_NODEV,
                    "noexec" => MS_NOEXEC,
                    "noatime" => MS_NOATIME,
                    "nodiratime" => MS_NODIRATIME,
                    "relatime" => MS_RELATIME,
                    _ => 0,
                };
            }
            Some(MountEntry {
                point: unescape(point),
                flags,
            })
        })
        .collect()
}

fn under(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn cstr(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path has an interior NUL"))
}

fn raw_mount(source: Option<&Path>, target: &Path, flags: c_ulong) -> io::Result<()> {
    let source_c = match source {
        Some(p) => Some(cstr(p)?),
        None => None,
    };
    let target_c = cstr(target)?;
    let rc = unsafe {
        mount(
            source_c
                .as_ref()
                .map(|c| c.as_ptr())
                .unwrap_or(std::ptr::null()),
            target_c.as_ptr(),
            std::ptr::null(),
            flags,
            std::ptr::null(),
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Confine the calling process, which then execs the command.
///
/// `writable` are the paths the command may write besides the temp folders:
/// the workspace (an overlay mount under L1, the real directory when there is
/// no overlay). A path that is not yet a mount of its own is bound onto itself
/// first. On an error nothing is to be run: the caller exits, so a command
/// never runs half confined.
pub fn apply(writable: &[&Path]) -> Result<(), String> {
    if unsafe { unshare(CLONE_NEWNS) } != 0 {
        return Err(format!(
            "unshare(mount) failed: {}",
            io::Error::last_os_error()
        ));
    }
    raw_mount(None, Path::new("/"), MS_REC | MS_PRIVATE)
        .map_err(|e| format!("making mounts private failed: {e}"))?;

    let before = fs::read_to_string("/proc/self/mountinfo")
        .map_err(|e| format!("cannot read the mount table: {e}"))?;
    let mounted: Vec<PathBuf> = parse_mountinfo(&before)
        .into_iter()
        .map(|entry| entry.point)
        .collect();

    // What stays writable has to be a mount of its own, or it shares the fate
    // of the mount it sits on.
    let mut keep: Vec<PathBuf> = Vec::new();
    for dir in TEMP_DIRS
        .iter()
        .map(Path::new)
        .chain(writable.iter().copied())
    {
        if !dir.is_dir() {
            continue;
        }
        if !mounted.iter().any(|point| point == dir) {
            raw_mount(Some(dir), dir, MS_BIND | MS_REC)
                .map_err(|e| format!("binding {} onto itself failed: {e}", dir.display()))?;
        }
        keep.push(dir.to_path_buf());
    }

    let table = fs::read_to_string("/proc/self/mountinfo")
        .map_err(|e| format!("cannot read the mount table: {e}"))?;
    let home = std::env::var_os("HOME").map(PathBuf::from);
    for entry in parse_mountinfo(&table) {
        let point = entry.point.as_path();
        if KERNEL_TREES
            .iter()
            .any(|tree| under(point, Path::new(tree)))
            || keep.iter().any(|dir| under(point, dir))
            || entry.flags & MS_RDONLY != 0
        {
            continue;
        }
        if let Err(e) = raw_mount(None, point, MS_REMOUNT | MS_BIND | MS_RDONLY | entry.flags) {
            // A mount that cannot be made read-only is a hole. For the root
            // and whatever holds the home directory that is not acceptable;
            // an odd mount elsewhere (autofs, a FUSE mount of another user)
            // is reported and left.
            let holds_home = home.as_deref().is_some_and(|h| under(h, point));
            if point == Path::new("/") || holds_home {
                return Err(format!("cannot make {} read-only: {e}", point.display()));
            }
            eprintln!(
                "cerebriline-sandbox: left {} writable (remount failed: {e})",
                point.display()
            );
        }
    }

    // uid 0 inside the namespace would otherwise remount all of it writable.
    for cap in 0..=CAP_LAST_PROBE {
        unsafe { prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) };
    }
    if unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(format!(
            "no_new_privs failed: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_mount_points_and_their_flags() {
        let table = "\
22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw
23 22 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw
40 22 8:17 / /srv/my\\040disk ro,noatime - ext4 /dev/sdb1 ro
";
        let entries = parse_mountinfo(table);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].point, PathBuf::from("/"));
        assert_eq!(entries[0].flags, MS_RELATIME);
        assert_eq!(
            entries[1].flags,
            MS_NOSUID | MS_NODEV | MS_NOEXEC | MS_RELATIME
        );
        assert_eq!(entries[2].point, PathBuf::from("/srv/my disk"));
        assert_eq!(entries[2].flags, MS_RDONLY | MS_NOATIME);
    }

    #[test]
    fn a_path_is_under_itself_and_its_parents_only() {
        assert!(under(Path::new("/tmp"), Path::new("/tmp")));
        assert!(under(Path::new("/tmp/a"), Path::new("/tmp")));
        assert!(!under(Path::new("/tmpfoo"), Path::new("/tmp")));
    }
}
