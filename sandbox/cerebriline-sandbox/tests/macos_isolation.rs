//! Integration test for the macOS M1 backend (APFS `clonefile`): assert the same
//! isolation contract as L1/L2 — the workspace is untouched, the change set lands
//! in `.wh.` format, the agent's existing overlay is seeded onto the clone (a prior
//! tool-created file is readable, a prior tool deletion is invisible), a grandchild
//! write is captured, and the exit code propagates.
//!
//! **The one deliberate difference from the Linux tests.** M1 redirects by running
//! the command with its cwd at the clone root, not by rewriting syscalls, so the
//! script works in *relative* paths. A workspace-rooted path the shell constructs at
//! run time (`$WS/x`) is not redirected — that is the documented M1 limitation
//! (`macos.rs` header, PLANS §10) — and testing with relative paths is testing the
//! redirect the backend actually provides, not papering over the gap.
//!
//! Needs an APFS volume for `clonefile`. Where the temp dir is not APFS the clone
//! fails and the backend exits 71; the test detects that and returns without
//! asserting rather than reporting a spurious failure.

#![cfg(target_os = "macos")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_cerebriline-sandbox");

fn unique_dir(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "cbl-m1-{tag}-{}-{}",
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
fn m1_isolates_the_workspace_and_produces_the_change_set() {
    let base = unique_dir("iso");
    let ws = base.join("ws");
    let ov = base.join("ov");
    let log = base.join("ov.sandbox.log");
    fs::create_dir_all(ws.join("sub")).unwrap();
    fs::create_dir_all(&ov).unwrap();
    write(&ws, "existing.txt", "ORIG\n"); // lower file the command appends to
    write(&ws, "del.txt", "DELETEME\n"); // the command deletes it
    write(&ws, "sub/deep.txt", "DEEP\n");
    write(&ws, "gone.txt", "GONE\n"); // a prior tool already deleted this
    write(&ov, "tool_only.txt", "TOOLMADE\n"); // a prior tool-created file

    // A prior tool deletion, in the shared `.wh.` format: the seed must remove
    // gone.txt from the clone so the command never sees it.
    fs::write(ov.join(".wh.gone.txt"), "").unwrap();

    // cwd is the clone root, so every path here is relative and resolves inside the
    // clone. `../seen` climbs to `base/` (a sibling of the clone) to record what the
    // sandbox saw, without adding it to the change set. A LEAK line would mean the
    // seed failed to delete gone.txt.
    let script = "\
        cat existing.txt > ../seen;\
        cat tool_only.txt >> ../seen;\
        if [ -e gone.txt ]; then echo LEAK >> ../seen; fi;\
        echo APPEND >> existing.txt;\
        echo NEWFILE > created.txt;\
        rm del.txt;\
        /bin/sh -c 'echo GRANDCHILD > gc.txt';\
        exit 5";
    let out = Command::new(BIN)
        .arg("")
        .arg(&log)
        .arg("/bin/sh")
        .arg("-c")
        .arg(script)
        .env("CEREBRILINE_WS_ROOT", &ws)
        .env("CEREBRILINE_OVERLAY_ROOT", &ov)
        .env("CEREBRILINE_SANDBOX_LOG", &log)
        .output()
        .expect("failed to run cerebriline-sandbox");

    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.code() == Some(71) && stderr.to_lowercase().contains("clonefile") {
        eprintln!("skipping: clonefile unavailable (temp dir not APFS?)\n{stderr}");
        fs::remove_dir_all(&base).ok();
        return;
    }

    assert_eq!(out.status.code(), Some(5), "stderr: {stderr}");

    // Reads inside the sandbox: the workspace file read-through, then the seeded
    // overlay copy. No LEAK line -> the prior tool deletion was honoured on the clone.
    assert_eq!(
        fs::read_to_string(base.join("seen")).unwrap(),
        "ORIG\nTOOLMADE\n"
    );

    // The workspace is untouched.
    assert_eq!(read(&ws, "existing.txt").as_deref(), Some("ORIG\n"));
    assert!(ws.join("del.txt").exists(), "workspace delete escaped");
    assert!(!ws.join("created.txt").exists(), "workspace create escaped");
    assert!(!ws.join("gc.txt").exists(), "grandchild write escaped");
    assert!(
        ws.join("gone.txt").exists(),
        "the seed must not touch the workspace"
    );

    // The overlay is the change set, in `.wh.` format.
    assert_eq!(read(&ov, "existing.txt").as_deref(), Some("ORIG\nAPPEND\n")); // modified
    assert_eq!(read(&ov, "created.txt").as_deref(), Some("NEWFILE\n"));
    assert_eq!(read(&ov, "gc.txt").as_deref(), Some("GRANDCHILD\n"));
    assert_eq!(read(&ov, "tool_only.txt").as_deref(), Some("TOOLMADE\n")); // survives
    assert!(
        ov.join(".wh.del.txt").exists(),
        "a workspace deletion must be a .wh. marker"
    );
    // The prior tool deletion is still a deletion after reconcile.
    assert!(
        ov.join(".wh.gone.txt").exists(),
        "a seeded deletion must survive the reconcile"
    );

    fs::remove_dir_all(&base).ok();
}
