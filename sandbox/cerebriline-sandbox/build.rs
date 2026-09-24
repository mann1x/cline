//! Build script. Its only job is the one native library the crate links: on
//! Windows, Microsoft Detours' `detours.lib` (for `DetourCreateProcessWithDllExW`
//! in the W1 backend). Every other target links nothing here — the Linux and
//! macOS backends declare their libc/libSystem entry points directly and need no
//! link step. This keeps `cargo build` dependency-free off Windows.

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "windows" {
        return;
    }

    // `detours.lib` is prebuilt (see sandbox/w1-spike/build.bat, which clones and
    // builds Detours as a /MT static lib). Point the linker at the folder holding
    // it via DETOURS_LIB_DIR. The Rust binary is built with +crt-static
    // (.cargo/config.toml) so its CRT matches Detours' /MT and the two link cleanly.
    println!("cargo:rerun-if-env-changed=DETOURS_LIB_DIR");
    if let Ok(dir) = std::env::var("DETOURS_LIB_DIR") {
        if !dir.is_empty() {
            println!("cargo:rustc-link-search=native={dir}");
        }
    } else {
        // Not fatal: `cargo check` type-checks without linking, so the Windows
        // backend can be checked anywhere. A real build without the dir set fails
        // at link with a clear "cannot open detours.lib", not a symbol dump.
        println!(
            "cargo:warning=DETOURS_LIB_DIR is not set; a Windows *build* (not check) \
             needs Microsoft Detours' detours.lib. Set DETOURS_LIB_DIR to the folder \
             containing it (sandbox/w1-spike/build.bat produces it)."
        );
    }
    println!("cargo:rustc-link-lib=static=detours");
}
