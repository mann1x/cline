//! Integration test for the Linux L1 backend: run the built binary against a
//! real workspace and assert the isolation contract end to end — the workspace
//! is untouched, the change set is produced in `.wh.` format, absolute-path
//! writes and a grandchild process are both captured, and the command's exit
//! code propagates.
//!
//! It needs unprivileged user namespaces. Where they are unavailable (some CI,
//! AppArmor-locked hosts) the test detects the launcher's setup failure and
//! returns without asserting, rather than reporting a spurious failure.

#![cfg(target_os = "linux")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_cerebriline-sandbox");

fn unique_dir(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "cbl-l1-{tag}-{}-{}",
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
fn l1_isolates_the_workspace_and_produces_the_change_set() {
    let base = unique_dir("iso");
    let ws = base.join("ws");
    let ov = base.join("ov");
    let log = base.join("ov.sandbox.log");
    fs::create_dir_all(ws.join("sub")).unwrap();
    fs::create_dir_all(&ov).unwrap();
    write(&ws, "orig.txt", "ORIG\n");
    write(&ws, "del.txt", "DELETEME\n");
    write(&ws, "sub/deep.txt", "DEEP\n");
    // A prior tool edit already in the overlay: orig modified, plus a new file.
    write(&ov, "orig.txt", "TOOLEDIT\n");
    write(&ov, "tool_only.txt", "TOOLMADE\n");

    // Mirrors wrapSpawn: argv = [hook, log, command...], config in the env.
    let script = "\
        cat \"$WS/orig.txt\" > \"$WS/../seen_orig\";\
        echo APPEND >> \"$WS/orig.txt\";\
        echo NEWFILE > \"$WS/created.txt\";\
        rm \"$WS/del.txt\";\
        /bin/sh -c 'echo GRANDCHILD > \"$WS/gc.txt\"';\
        exit 3";
    let out = Command::new(BIN)
        .arg("") // hook (ignored on Linux)
        .arg(&log)
        .arg("/bin/sh")
        .arg("-c")
        .arg(script)
        .env("CEREBRILINE_WS_ROOT", &ws)
        .env("CEREBRILINE_OVERLAY_ROOT", &ov)
        .env("CEREBRILINE_SANDBOX_LOG", &log)
        .env("WS", &ws)
        .output()
        .expect("failed to run cerebriline-sandbox");

    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.code() == Some(71) && stderr.contains("unshare") {
        eprintln!("skipping: unprivileged user namespaces unavailable on this host\n{stderr}");
        fs::remove_dir_all(&base).ok();
        return;
    }

    // The command's own exit code propagates through the launcher.
    assert_eq!(out.status.code(), Some(3), "stderr: {stderr}");

    // Inside the sandbox, reading the workspace saw the tool edit, not the disk.
    assert_eq!(
        fs::read_to_string(base.join("seen_orig")).unwrap(),
        "TOOLEDIT\n",
        "the command must see the agent's tool edit through the overlay"
    );

    // The real workspace is untouched.
    assert_eq!(read(&ws, "orig.txt").as_deref(), Some("ORIG\n"));
    assert!(ws.join("del.txt").exists(), "workspace delete escaped");
    assert!(!ws.join("created.txt").exists(), "workspace create escaped");
    assert!(!ws.join("gc.txt").exists(), "grandchild write escaped");

    // The overlay is the change set, in `.wh.` format.
    assert_eq!(read(&ov, "created.txt").as_deref(), Some("NEWFILE\n"));
    assert_eq!(read(&ov, "gc.txt").as_deref(), Some("GRANDCHILD\n"));
    assert_eq!(read(&ov, "orig.txt").as_deref(), Some("TOOLEDIT\nAPPEND\n"));
    assert_eq!(read(&ov, "tool_only.txt").as_deref(), Some("TOOLMADE\n"));
    assert!(
        ov.join(".wh.del.txt").exists(),
        "a workspace deletion must be a .wh. marker"
    );

    // The scratch mountpoint is cleaned up.
    assert!(
        !base.join("ov.ovl-scratch").exists(),
        "the overlay scratch mountpoint leaked"
    );

    fs::remove_dir_all(&base).ok();
}
