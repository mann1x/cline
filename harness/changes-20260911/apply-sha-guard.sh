#!/usr/bin/env bash
# Staged 2026-09-11 15:55. Install ONLY when the running arm has finished.
#   bash apply-sha-guard.sh
# Adds a sha256 integrity check on the workspace oracle. run_game.js is chmod
# 444, but work-native/ is writable, so the file can be unlinked and replaced.
# 444 blocks in-place writes, not deletion.
set -euo pipefail
H=/srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness
S=/tmp/claude-0/-srv-dev-disk-by-label-opt-dev-ollama/e7e7fe27-8e00-48a5-8133-20ed095a6be9/scratchpad

for p in $(ls /proc | grep -E '^[0-9]+$'); do
  c=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null) || continue
  case "$c" in "bash ./native.sh"*) echo "REFUSING: native.sh still running as pid $p"; exit 1;; esac
done

cp "$H/native.sh" "$S/native.sh.bak-pre-shaguard-$(date +%Y%m%d-%H%M%S)"
cp "$H/native.sh" "$S/native.sha.sh"

python3 - "$S/native.sha.sh" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()

old = '\tchmod 444 "$WORK/run_game.js"'
new = '''\tchmod 444 "$WORK/run_game.js"
\t# 444 stops an in-place write; it does not stop `rm` in a writable directory.
\t# Record what the oracle is so the verdict can prove it is still that.
\toracle_sha="$(sha256sum "$WORK/run_game.js" | cut -d" " -f1)"
\techo "oracle_sha=$oracle_sha" >> "$run_dir/build.txt"'''
assert old in s, "chmod 444 site not found"
s = s.replace(old, new, 1)

old2 = '''\tlocal elapsed=$((ended - started))
\tlocal reason=""
\tif grep -qE "$ORACLE_EXPECT" <<<"$out"; then'''
new2 = '''\tlocal elapsed=$((ended - started))
\tlocal reason=""
\t# The oracle is only a verdict if it is still the oracle. A run that replaces
\t# run_game.js has graded its own exam, and no reading of its output is worth
\t# anything -- so this is checked before the output is read, not after.
\tlocal oracle_now=""
\t[[ -f "$WORK/run_game.js" ]] && oracle_now="$(sha256sum "$WORK/run_game.js" | cut -d" " -f1)"
\tif [[ -n "${oracle_sha:-}" && "$oracle_now" != "$oracle_sha" ]]; then
\t\tverdict="ABORTED"
\t\tif [[ -z "$oracle_now" ]]; then
\t\t\treason="oracle deleted: run_game.js is gone"
\t\telse
\t\t\treason="oracle replaced: run_game.js sha ${oracle_now:0:12} != ${oracle_sha:0:12}"
\t\tfi
\telif grep -qE "$ORACLE_EXPECT" <<<"$out"; then'''
assert old2 in s, "verdict block not found"
s = s.replace(old2, new2, 1)

# oracle_sha must be visible in the verdict block: declare it with the locals.
old3 = '\tlocal since started ended verdict\n'
new3 = '\tlocal since started ended verdict oracle_sha\n'
assert old3 in s, "locals line not found"
s = s.replace(old3, new3, 1)

open(p, "w", encoding="utf-8").write(s)
print("  patched 3 places")
PY

bash -n "$S/native.sha.sh"
echo "  bash syntax OK"
chmod 755 "$S/native.sha.sh"
mv -f "$S/native.sha.sh" "$H/native.sh"
echo "  installed"
grep -n 'oracle_sha\|oracle replaced\|oracle deleted' "$H/native.sh"
