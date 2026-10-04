//! Integration test for write confinement on Linux: the command reads the
//! system, writes its workspace copy and the temp folder, and is refused
//! everywhere else, the home directory included.
//!
//! Like the L1 test it needs unprivileged user namespaces, and returns without
//! asserting where the launcher reports it could not set one up.

#![cfg(target_os = "linux")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_cerebriline-sandbox");

/// A directory in the home folder, not in the temp folder: the temp folder
/// stays writable under confinement, so "outside" has to be somewhere else.
fn home_dir(tag: &str) -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| "/".into());
    let p = home.join(format!(
        ".cbl-confine-{tag}-{}-{}",
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

fn run(base: &Path, backend: &str, confine: bool, script: &str) -> std::process::Output {
    let ws = base.join("ws");
    let ov = base.join("ov");
    let log = base.join("ov.sandbox.log");
    let mut cmd = Command::new(BIN);
    cmd.arg("unused-hook")
        .arg(&log)
        .arg("sh")
        .arg("-c")
        .arg(script)
        .env("CEREBRILINE_WS_ROOT", &ws)
        .env("CEREBRILINE_OVERLAY_ROOT", &ov)
        .env("CEREBRILINE_SANDBOX_BACKEND", backend)
        .env("WS", &ws)
        .env("OUTSIDE", base.join("outside"));
    if confine {
        cmd.env("CEREBRILINE_SANDBOX_CONFINE", "1");
    } else {
        cmd.env_remove("CEREBRILINE_SANDBOX_CONFINE");
    }
    cmd.output().expect("failed to run cerebriline-sandbox")
}

/// What the command tries, one marker per attempt.
const SCRIPT: &str = "\
    echo W > \"$WS/made.txt\" && echo ws-write-ok;\
    echo O > \"$OUTSIDE/escaped.txt\" 2>/dev/null && echo OUTSIDE-WRITTEN || echo outside-denied;\
    if echo H > \"$HOME/.cbl-confine-escape-$$\" 2>/dev/null; then echo HOME-WRITTEN; rm -f \"$HOME/.cbl-confine-escape-$$\"; else echo home-denied; fi;\
    T=$(mktemp /tmp/cbl-confine-XXXXXX) && echo T > \"$T\" && echo tmp-write-ok && rm -f \"$T\";\
    cat \"$OUTSIDE/readable.txt\";\
    mount -o remount,rw / 2>/dev/null && echo REMOUNTED || echo remount-denied;\
    exit 7";

fn check(backend: &str) {
    let base = home_dir(backend);
    let ws = base.join("ws");
    let ov = base.join("ov");
    let outside = base.join("outside");
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(&ov).unwrap();
    fs::create_dir_all(&outside).unwrap();
    write(&outside, "readable.txt", "READ-THROUGH\n");

    let out = run(&base, backend, true, SCRIPT);
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if out.status.code() == Some(71) {
        eprintln!("skipping {backend}: the launcher could not set the sandbox up\n{stderr}");
        fs::remove_dir_all(&base).ok();
        return;
    }
    assert_eq!(
        out.status.code(),
        Some(7),
        "stdout: {stdout}\nstderr: {stderr}"
    );

    assert!(
        stdout.contains("ws-write-ok"),
        "the workspace must be writable: {stdout}{stderr}"
    );
    assert!(
        stdout.contains("tmp-write-ok"),
        "the temp folder must be writable: {stdout}{stderr}"
    );
    assert!(
        stdout.contains("READ-THROUGH"),
        "the system must be readable: {stdout}{stderr}"
    );
    assert!(
        stdout.contains("outside-denied"),
        "a write outside must be refused: {stdout}"
    );
    assert!(
        stdout.contains("home-denied"),
        "a write to the home folder must be refused: {stdout}"
    );
    assert!(
        stdout.contains("remount-denied"),
        "the command must not undo the confinement: {stdout}"
    );
    assert!(
        !outside.join("escaped.txt").exists(),
        "a write escaped the sandbox"
    );

    // The workspace write went to the agent's copy, not to the workspace.
    assert!(
        !ws.join("made.txt").exists(),
        "the workspace itself was written"
    );
    assert_eq!(
        fs::read_to_string(ov.join("made.txt")).ok().as_deref(),
        Some("W\n"),
        "the workspace write must be handed back in the overlay"
    );

    // Without the flag the same command writes outside: the test measures the
    // confinement, not a directory nobody could write anyway.
    let out = run(&base, backend, false, SCRIPT);
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.code() == Some(7) {
        assert!(stdout.contains("OUTSIDE-WRITTEN"), "control run: {stdout}");
    }

    fs::remove_dir_all(&base).ok();
}

/// Direct mode, the lead's: no overlay, the workspace written in place, the
/// rest of the system read-only, and the command still the user it was.
fn check_direct(backend: &str) {
    let base = home_dir(&format!("direct-{backend}"));
    let ws = base.join("ws");
    let outside = base.join("outside");
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(&outside).unwrap();
    write(&outside, "readable.txt", "READ-THROUGH\n");
    write(&ws, "kept.txt", "K\n");

    let script = format!("echo A >> kept.txt; echo \"uid=$(id -u)\"; {SCRIPT}");
    let out = Command::new(BIN)
        .arg("unused-hook")
        .arg(base.join("direct.log"))
        .arg("sh")
        .arg("-c")
        .arg(&script)
        .current_dir(&ws)
        .env("CEREBRILINE_WS_ROOT", &ws)
        .env("CEREBRILINE_SANDBOX_DIRECT", "1")
        .env_remove("CEREBRILINE_OVERLAY_ROOT")
        .env_remove("CEREBRILINE_SANDBOX_CONFINE")
        .env("CEREBRILINE_SANDBOX_BACKEND", backend)
        .env("WS", &ws)
        .env("OUTSIDE", &outside)
        .output()
        .expect("failed to run cerebriline-sandbox");
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if out.status.code() == Some(71) {
        eprintln!("skipping direct {backend}: the launcher could not set the sandbox up\n{stderr}");
        fs::remove_dir_all(&base).ok();
        return;
    }
    assert_eq!(
        out.status.code(),
        Some(7),
        "stdout: {stdout}\nstderr: {stderr}"
    );
    for marker in [
        "ws-write-ok",
        "tmp-write-ok",
        "READ-THROUGH",
        "outside-denied",
        "home-denied",
        "remount-denied",
    ] {
        assert!(
            stdout.contains(marker),
            "missing {marker}: {stdout}{stderr}"
        );
    }
    let uid = String::from_utf8_lossy(&Command::new("id").arg("-u").output().unwrap().stdout)
        .trim()
        .to_string();
    assert!(
        stdout.contains(&format!("uid={uid}")),
        "the command must stay the same user: {stdout}"
    );
    assert!(
        !outside.join("escaped.txt").exists(),
        "a write escaped the sandbox"
    );
    // In place: there is no copy to hand back.
    assert_eq!(
        fs::read_to_string(ws.join("made.txt")).ok().as_deref(),
        Some("W\n"),
        "the workspace must be written in place"
    );
    assert_eq!(
        fs::read_to_string(ws.join("kept.txt")).ok().as_deref(),
        Some("K\nA\n"),
        "a relative write must reach the workspace"
    );

    fs::remove_dir_all(&base).ok();
}

#[test]
fn l1_direct_writes_the_workspace_in_place_and_nothing_else() {
    check_direct("l1");
}

#[cfg(target_arch = "x86_64")]
#[test]
fn l2_direct_writes_the_workspace_in_place_and_nothing_else() {
    check_direct("l2");
}

#[test]
fn l1_confines_writes_to_the_workspace_and_temp() {
    check("l1");
}

/// The ptrace fallback refuses the same writes, and `mount` with them.
#[cfg(target_arch = "x86_64")]
#[test]
fn l2_confines_writes_to_the_workspace_and_temp() {
    check("l2");
}
