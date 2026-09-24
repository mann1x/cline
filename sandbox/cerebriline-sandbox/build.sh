#!/usr/bin/env bash
# Build cerebriline-sandbox for the Linux targets and stage them, arch-suffixed,
# into the vsix assets. No external crates, so this works offline with a bare
# toolchain; the arm64 target needs `rustup target add aarch64-unknown-linux-gnu`
# and the `aarch64-linux-gnu-gcc` cross-linker (see .cargo/config.toml).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
dest_dir="$here/../../apps/vscode/assets/sandbox"

stage() { # <target-triple> <arch-suffix>
	local triple="$1" arch="$2"
	if ! rustc --print target-list | grep -qx "$triple"; then
		echo "skip $arch: target $triple unknown to rustc"
		return
	fi
	if ! rustup target list --installed 2>/dev/null | grep -qx "$triple"; then
		echo "skip $arch: run 'rustup target add $triple' first"
		return
	fi
	cargo build --release --target "$triple"
	local out="$dest_dir/cerebriline-sandbox-$arch"
	cp "$here/target/$triple/release/cerebriline-sandbox" "$out"
	chmod 755 "$out"
	echo "staged: $out"
	sha256sum "$out"
}

stage x86_64-unknown-linux-gnu x64
stage aarch64-unknown-linux-gnu arm64
