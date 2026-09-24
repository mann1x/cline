//! Integration test for the Linux L2 (ptrace) backend: force it with
//! CEREBRILINE_SANDBOX_BACKEND=l2 and assert the same isolation contract as L1
//! — the workspace is untouched, the change set lands in `.wh.` format, a
//! copy-up modify of an untouched file works (the case L1 cannot do on some
//! filesystems), absolute-path writes and a grandchild are captured, and the
//! exit code propagates.
//!
//! Needs ptrace, which most Linux hosts allow for a child you spawned. Where it
//! is denied, the test detects the tracer's failure and returns without
//! asserting rather than reporting a spurious failure.

#![cfg(target_os = "linux")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_cerebriline-sandbox");

fn unique_dir(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "cbl-l2-{tag}-{}-{}",
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
fn l2_isolates_the_workspace_and_produces_the_change_set() {
    let base = unique_dir("iso");
    let ws = base.join("ws");
    let ov = base.join("ov");
    let log = base.join("ov.sandbox.log");
    fs::create_dir_all(ws.join("sub")).unwrap();
    fs::create_dir_all(&ov).unwrap();
    write(&ws, "existing.txt", "ORIG\n"); // lower-only: forces copy-up
    write(&ws, "del.txt", "DELETEME\n");
    write(&ws, "sub/deep.txt", "DEEP\n");
    write(&ov, "tool_only.txt", "TOOLMADE\n"); // a prior tool-created file

    let script = "\
        cat \"$WS/existing.txt\" > \"$WS/../seen\";\
        cat \"$WS/tool_only.txt\" >> \"$WS/../seen\";\
        echo APPEND >> \"$WS/existing.txt\";\
        echo NEWFILE > \"$WS/created.txt\";\
        rm \"$WS/del.txt\";\
        /bin/sh -c 'echo GRANDCHILD > \"$WS/gc.txt\"';\
        exit 5";
    let out = Command::new(BIN)
        .arg("")
        .arg(&log)
        .arg("/bin/sh")
        .arg("-c")
        .arg(script)
        .env("CEREBRILINE_SANDBOX_BACKEND", "l2")
        .env("CEREBRILINE_WS_ROOT", &ws)
        .env("CEREBRILINE_OVERLAY_ROOT", &ov)
        .env("CEREBRILINE_SANDBOX_LOG", &log)
        .env("WS", &ws)
        .output()
        .expect("failed to run cerebriline-sandbox");

    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.code() == Some(71) && stderr.to_lowercase().contains("ptrace") {
        eprintln!("skipping: ptrace unavailable on this host\n{stderr}");
        fs::remove_dir_all(&base).ok();
        return;
    }

    assert_eq!(out.status.code(), Some(5), "stderr: {stderr}");

    // Reads inside the sandbox: workspace read-through, then the overlay copy.
    assert_eq!(
        fs::read_to_string(base.join("seen")).unwrap(),
        "ORIG\nTOOLMADE\n"
    );

    // The workspace is untouched.
    assert_eq!(read(&ws, "existing.txt").as_deref(), Some("ORIG\n"));
    assert!(ws.join("del.txt").exists(), "workspace delete escaped");
    assert!(!ws.join("created.txt").exists(), "workspace create escaped");
    assert!(!ws.join("gc.txt").exists(), "grandchild write escaped");

    // The overlay is the change set, in `.wh.` format.
    assert_eq!(read(&ov, "existing.txt").as_deref(), Some("ORIG\nAPPEND\n")); // copy-up modify
    assert_eq!(read(&ov, "created.txt").as_deref(), Some("NEWFILE\n"));
    assert_eq!(read(&ov, "gc.txt").as_deref(), Some("GRANDCHILD\n"));
    assert_eq!(read(&ov, "tool_only.txt").as_deref(), Some("TOOLMADE\n"));
    assert!(
        ov.join(".wh.del.txt").exists(),
        "a workspace deletion must be a .wh. marker"
    );

    fs::remove_dir_all(&base).ok();
}
