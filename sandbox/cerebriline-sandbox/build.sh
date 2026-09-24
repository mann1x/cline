#!/usr/bin/env bash
# Build cerebriline-sandbox for the host target and stage it into the vsix
# assets. No external crates, so this works offline with a bare toolchain.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

cargo build --release

bin="$here/target/release/cerebriline-sandbox"
dest="$here/../../apps/vscode/assets/sandbox/cerebriline-sandbox"
cp "$bin" "$dest"
chmod 755 "$dest"

echo "built: $bin"
echo "staged: $dest"
sha256sum "$dest"
