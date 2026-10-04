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

/// A lookup by name in a workspace directory sees the workspace, not only the
/// overlay. cmd finds a bare command name with a FindFirstFile on that name in
/// the working directory; the hook left such a query to the overlay directory,
/// which holds only what the agent changed, so a program that had been in the
/// workspace all along was "not recognized" (swarm wlafh, `run_game.exe`).
#[test]
fn w1_finds_a_workspace_program_by_its_bare_name() {
    let hook = match std::env::var("CEREBRILINE_TEST_HOOK_DLL") {
        Ok(p) if !p.is_empty() && Path::new(&p).exists() => p,
        _ => {
            eprintln!("skipping: CEREBRILINE_TEST_HOOK_DLL not set or the DLL is missing");
            return;
        }
    };

    let base = unique_dir("byname");
    let ws = base.join("ws");
    let ov = base.join("ov");
    let log = base.join("run.log");
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(&ov).unwrap();
    write(&ws, "tool.cmd", "@echo TOOL-RAN\r\n");
    write(&ws, "gone.txt", "X\r\n");
    // The agent deleted gone.txt and created made.txt: both live in the overlay.
    write(&ov, ".wh.gone.txt", "");
    write(&ov, "made.txt", "Y\r\n");

    let run = |line: &str| {
        Command::new(BIN)
            .arg(&hook)
            .arg(&log)
            .arg("cmd")
            .arg("/c")
            .arg(line)
            .current_dir(&ws)
            .env("CEREBRILINE_WS_ROOT", &ws)
            .env("CEREBRILINE_OVERLAY_ROOT", &ov)
            .env("CEREBRILINE_SANDBOX_LOG", &log)
            .output()
            .expect("failed to run cerebriline-sandbox")
    };

    let out = run("tool.cmd");
    if out.status.code() == Some(3) {
        eprintln!("skipping: Detours could not start the injected child on this host");
        fs::remove_dir_all(&base).ok();
        return;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stdout.contains("TOOL-RAN"),
        "a program in the workspace must be found by its bare name; stdout: {stdout} stderr: {stderr}"
    );

    let out = run("if exist gone.txt (echo PRESENT) else (echo ABSENT)");
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("ABSENT"),
        "a file the agent deleted must not be found by name"
    );

    let out = run("if exist made.txt (echo PRESENT) else (echo ABSENT)");
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("PRESENT"),
        "a file the agent created must be found by name"
    );

    let out = run("if exist nothere.txt (echo PRESENT) else (echo ABSENT)");
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("ABSENT"),
        "a name in neither layer must not be found"
    );

    // A relative path resolves against the working directory's handle, which
    // the loader opened before the hooks existed. Such a write went to the
    // lead's workspace, with no trace in the log (pandorum probe, 2026-10-04).
    let out = run("echo R> rel.txt && echo A>> tool.cmd && type rel.txt");
    assert!(
        String::from_utf8_lossy(&out.stdout).contains('R'),
        "a file written by a relative path must read back"
    );
    assert!(
        !ws.join("rel.txt").exists(),
        "a relative write reached the lead's workspace"
    );
    assert!(
        ov.join("rel.txt").exists(),
        "a relative write must land in the overlay"
    );
    assert_eq!(
        fs::read_to_string(ws.join("tool.cmd")).unwrap(),
        "@echo TOOL-RAN\r\n",
        "a relative append changed the lead's file"
    );

    fs::remove_dir_all(&base).ok();
}

/// Write confinement: at Low integrity the command reads the system, writes
/// its copy of the workspace and the temp folder it was given, and Windows
/// refuses the rest: the profile, any other folder, `HKCU`. In swarm wlafh an
/// agent appended to the user's `PATH` and another copied a program into the
/// profile; both are writes this refuses.
#[test]
fn w1_confines_writes_to_the_workspace_and_temp() {
    let hook = match std::env::var("CEREBRILINE_TEST_HOOK_DLL") {
        Ok(p) if !p.is_empty() && Path::new(&p).exists() => p,
        _ => {
            eprintln!("skipping: CEREBRILINE_TEST_HOOK_DLL not set or the DLL is missing");
            return;
        }
    };

    let base = unique_dir("confine");
    let ws = base.join("ws");
    let ov = base.join("ov");
    let tmp = base.join("tmp");
    let outside = base.join("outside");
    let log = base.join("run.log");
    for dir in [&ws, &ov, &tmp, &outside] {
        fs::create_dir_all(dir).unwrap();
    }
    write(&outside, "readable.txt", "READ-THROUGH\r\n");
    let profile = PathBuf::from(std::env::var("USERPROFILE").unwrap());
    let escape = profile.join(format!("cbl-confine-escape-{}.txt", std::process::id()));
    let key = format!(
        "HKCU\\Software\\CerebrilineConfineTest{}",
        std::process::id()
    );

    // No quotes in the script: the launcher joins argv without escaping them,
    // and none of these paths holds a space.
    let script = format!(
        "echo W> made.txt && echo ws-write-ok \
         & (echo O> %OUTSIDE%\\escaped.txt) 2>nul && echo OUTSIDE-WRITTEN || echo outside-denied \
         & (echo H> {escape}) 2>nul && echo HOME-WRITTEN || echo home-denied \
         & (echo T> %TMP%\\t.txt) 2>nul && echo tmp-write-ok || echo TMP-DENIED \
         & type %OUTSIDE%\\readable.txt \
         & reg add {key} /v t /d 1 /f >nul 2>nul && echo REG-WRITTEN || echo reg-denied \
         & whoami /groups | findstr /c:Mandatory",
        escape = escape.display(),
    );
    let run = |confine: bool, args: &[&str]| {
        let mut cmd = Command::new(BIN);
        cmd.arg(&hook)
            .arg(&log)
            .args(args)
            .current_dir(&ws)
            .env("CEREBRILINE_WS_ROOT", &ws)
            .env("CEREBRILINE_OVERLAY_ROOT", &ov)
            .env("CEREBRILINE_SANDBOX_LOG", &log)
            .env("OUTSIDE", &outside)
            .env("TMP", &tmp)
            .env("TEMP", &tmp);
        if confine {
            cmd.env("CEREBRILINE_SANDBOX_CONFINE", "1")
                .env("CEREBRILINE_SANDBOX_TMP", &tmp);
        } else {
            cmd.env_remove("CEREBRILINE_SANDBOX_CONFINE");
        }
        cmd.output().expect("failed to run cerebriline-sandbox")
    };
    let cleanup = || {
        fs::remove_file(&escape).ok();
        Command::new("reg")
            .args(["delete", &key, "/f"])
            .output()
            .ok();
    };

    let out = run(true, &["cmd", "/c", &script]);
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if out.status.code() == Some(3) {
        eprintln!("skipping: Detours could not start the injected child on this host\n{stderr}");
        cleanup();
        fs::remove_dir_all(&base).ok();
        return;
    }
    let escaped_home = escape.exists();
    let escaped_reg = Command::new("reg")
        .args(["query", &key])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    cleanup();

    assert!(
        stdout.contains("Low Mandatory Level"),
        "the command must run at Low integrity; stdout: {stdout} stderr: {stderr}"
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
        "a write to the profile must be refused: {stdout}"
    );
    assert!(
        stdout.contains("reg-denied"),
        "a write to HKCU must be refused: {stdout}"
    );
    assert!(
        !outside.join("escaped.txt").exists(),
        "a write escaped the sandbox"
    );
    assert!(!escaped_home, "a write reached the profile");
    assert!(!escaped_reg, "a write reached HKCU");
    assert!(
        !ws.join("made.txt").exists(),
        "the workspace itself was written"
    );
    assert!(
        ov.join("made.txt").exists(),
        "the workspace write must land in the overlay"
    );

    // The agents' shell on Windows is PowerShell: it has to start at Low.
    let out = run(
        true,
        &[
            "powershell",
            "-NoProfile",
            "-Command",
            "Write-Output PS-RAN",
        ],
    );
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("PS-RAN"),
        "PowerShell must run confined; stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // The control: without the flag the same command writes outside.
    let out = run(false, &["cmd", "/c", &script]);
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    cleanup();
    assert!(stdout.contains("OUTSIDE-WRITTEN"), "control run: {stdout}");

    fs::remove_dir_all(&base).ok();
}

/// Direct mode, the lead's: no hook and no overlay. The command runs at Low
/// integrity and writes the workspace in place, which the launcher labels,
/// and the temp folder it was given.
#[test]
fn w1_direct_writes_the_workspace_in_place_and_nothing_else() {
    let base = unique_dir("direct");
    let ws = base.join("ws");
    let tmp = base.join("tmp");
    let outside = base.join("outside");
    fs::create_dir_all(ws.join("sub")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    write(&ws, "sub\\kept.txt", "K\r\n");
    write(&outside, "readable.txt", "READ-THROUGH\r\n");

    let script = "echo W> made.txt && echo ws-write-ok \
         & echo A>> sub\\kept.txt && echo existing-write-ok \
         & (echo O> %OUTSIDE%\\escaped.txt) 2>nul && echo OUTSIDE-WRITTEN || echo outside-denied \
         & (echo T> %TMP%\\t.txt) 2>nul && echo tmp-write-ok || echo TMP-DENIED \
         & type %OUTSIDE%\\readable.txt \
         & whoami /groups | findstr /c:Mandatory";
    let run = || {
        Command::new(BIN)
            .arg("unused-hook")
            .arg(base.join("direct.log"))
            .args(["cmd", "/c", script])
            .current_dir(&ws)
            .env("CEREBRILINE_WS_ROOT", &ws)
            .env("CEREBRILINE_SANDBOX_DIRECT", "1")
            .env("CEREBRILINE_SANDBOX_TMP", &tmp)
            .env_remove("CEREBRILINE_OVERLAY_ROOT")
            .env("OUTSIDE", &outside)
            .env("TMP", &tmp)
            .env("TEMP", &tmp)
            .output()
            .expect("failed to run cerebriline-sandbox")
    };
    // Twice: the second run finds the workspace already labelled.
    for round in 0..2 {
        let out = run();
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        for marker in [
            "Low Mandatory Level",
            "ws-write-ok",
            "existing-write-ok",
            "tmp-write-ok",
            "READ-THROUGH",
            "outside-denied",
        ] {
            assert!(
                stdout.contains(marker),
                "round {round}: missing {marker}: {stdout}{stderr}"
            );
        }
    }
    assert!(
        !outside.join("escaped.txt").exists(),
        "a write escaped the sandbox"
    );
    assert!(
        ws.join("made.txt").exists(),
        "the workspace must be written in place"
    );
    assert_eq!(
        fs::read_to_string(ws.join("sub").join("kept.txt")).unwrap(),
        // cmd keeps the space before `&&` in what `echo` writes.
        "K\r\nA \r\nA \r\n",
        "a file that was there before must be writable"
    );

    fs::remove_dir_all(&base).ok();
}
