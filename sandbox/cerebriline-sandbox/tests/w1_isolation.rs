//! Integration test for the Windows W1 backend (Detours DLL injection): the Rust
//! launcher starts a command with `hook.dll` injected, and the same isolation
//! contract as L1/L2 holds — the workspace is untouched, a read falls through, a
//! write copies up, a create lands in the overlay, a delete becomes a `.wh.`
//! marker, and the exit code propagates. W1 redirects the command's *absolute*
//! workspace path (like L1/L2, unlike macOS M1), so the child is `node` and reads
//! the workspace root from `%WS%`. node is used, not cmd, because its `fs` calls
//! take the clean Win32 write/delete path the spike's milestones proved; cmd's
//! `del` goes through a directory scan with a known unmerged-specific-query gap.
//!
//! `hook.dll` is a separate C++ build artifact, so the test reads its path from
//! `CEREBRILINE_TEST_HOOK_DLL` (CI sets it after `build.bat`). Without it there is
//! nothing to inject, so the test skips rather than fails — and if the child can't
//! be started at all (Detours failure, or node absent), the launcher refuses (3)
//! and the test skips too.

#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_cerebriline-sandbox");

fn unique_dir(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "cbl-w1-{tag}-{}-{}",
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

fn read(root: &Path, rel: &str) -> Option<String> {
    fs::read_to_string(root.join(rel)).ok()
}

#[test]
fn w1_isolates_the_workspace_and_produces_the_change_set() {
    let hook = match std::env::var("CEREBRILINE_TEST_HOOK_DLL") {
        Ok(p) if !p.is_empty() && Path::new(&p).exists() => p,
        _ => {
            eprintln!("skipping: CEREBRILINE_TEST_HOOK_DLL not set or the DLL is missing");
            return;
        }
    };

    let base = unique_dir("iso");
    let ws = base.join("ws");
    let ov = base.join("ov");
    let log = base.join("run.log");
    fs::create_dir_all(ws.join("sub")).unwrap();
    fs::create_dir_all(&ov).unwrap();
    let seen = base.join("seen.txt"); // outside the workspace: the read-through capture
    write(&ws, "existing.txt", "ORIG\r\n"); // read through, then overwrite (copy-up)
    write(&ws, "del.txt", "DELETEME\r\n"); // the command deletes it
    write(&ws, "sub\\deep.txt", "DEEP\r\n");

    // The child is node; it reads the workspace root from %WS% (inherited) and
    // builds backslash paths with path.join, so the hook sees the absolute
    // workspace path and redirects it into the overlay. It: (1) reads existing.txt
    // *through* the overlay and writes what it saw to %OUT% (outside the workspace,
    // so not redirected) — the read fall-through; (2) overwrites existing.txt — a
    // copy-up that must land in the overlay, not the workspace; (3) creates a new
    // file; (4) deletes del.txt, which must become a `.wh.` whiteout.
    let script = "const fs=require('fs'),p=require('path'),ws=process.env.WS;\
                  fs.writeFileSync(process.env.OUT,fs.readFileSync(p.join(ws,'existing.txt')));\
                  fs.writeFileSync(p.join(ws,'existing.txt'),'MODIFIED');\
                  fs.writeFileSync(p.join(ws,'created.txt'),'NEWFILE');\
                  fs.unlinkSync(p.join(ws,'del.txt'));\
                  process.exit(5);";

    let out = Command::new(BIN)
        .arg(&hook)
        .arg(&log)
        .arg("node")
        .arg("-e")
        .arg(script)
        .env("CEREBRILINE_WS_ROOT", &ws)
        .env("CEREBRILINE_OVERLAY_ROOT", &ov)
        .env("CEREBRILINE_SANDBOX_LOG", &log)
        .env("WS", &ws)
        .env("OUT", &seen)
        .output()
        .expect("failed to run cerebriline-sandbox");

    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.code() == Some(3) {
        eprintln!("skipping: Detours could not start the injected child on this host\n{stderr}");
        fs::remove_dir_all(&base).ok();
        return;
    }

    assert_eq!(out.status.code(), Some(5), "stderr: {stderr}");

    // The read fell through to the workspace: the child saw the real bytes.
    assert_eq!(
        fs::read_to_string(&seen).ok().as_deref(),
        Some("ORIG\r\n"),
        "reading a workspace file through the sandbox must return its real contents"
    );

    // The workspace is untouched.
    assert_eq!(read(&ws, "existing.txt").as_deref(), Some("ORIG\r\n"));
    assert!(ws.join("del.txt").exists(), "workspace delete escaped");
    assert!(!ws.join("created.txt").exists(), "workspace create escaped");

    // The overlay is the change set: the overwrite copied up, the create landed,
    // and the delete is a `.wh.` whiteout.
    assert_eq!(
        read(&ov, "existing.txt").as_deref(),
        Some("MODIFIED"),
        "an overwrite must land in the overlay, not the workspace"
    );
    assert_eq!(
        read(&ov, "created.txt").as_deref(),
        Some("NEWFILE"),
        "a new file must land in the overlay"
    );
    assert!(
        ov.join(".wh.del.txt").exists(),
        "a workspace deletion must be a .wh. marker"
    );

    fs::remove_dir_all(&base).ok();
}
