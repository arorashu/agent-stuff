#!/usr/bin/env bash
# Hermetic installer/migration and routing tests. Never starts real services.
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
export HOME="$tmp/home" AGENT_BIN_DIR="$tmp/agent-bin" BASHRC_FILE="$tmp/home/.bashrc"
export AGENT_SKILLS_DIR="$tmp/skills" CODEX_SKILLS_DIR="$tmp/codex-skills"
export PI_SKILLS_DIR="$tmp/pi-skills" PI_EXTENSIONS_DIR="$tmp/pi-ext" LOCAL_BIN_DIR="$tmp/local-bin"
mkdir -p "$HOME" "$AGENT_BIN_DIR" "$LOCAL_BIN_DIR" "$tmp/mocks"
pass=0
ok() { printf 'ok   %s\n' "$1"; pass=$((pass + 1)); }
expect_rc() {
  local expected=$1 got=0
  shift
  "$@" >"$tmp/stdout" 2>"$tmp/stderr" || got=$?
  [[ "$got" == "$expected" ]] || { printf 'FAIL expected rc=%s got=%s: %s\n' "$expected" "$got" "$*"; exit 1; }
}
for source in codexr codex-direct codex-mise path.bash test.sh; do
  bash -n "codex-launcher/$source"
done
ok 'launcher shell syntax'
printf 'existing-start\nexisting-end\n' > "$BASHRC_FILE"
printf '#!/bin/sh\nexit 0\n' > "$LOCAL_BIN_DIR/codex"
chmod +x "$LOCAL_BIN_DIR/codex"
original_bashrc=$(sha256sum "$BASHRC_FILE")
./install.sh --dry-run --no-pi >"$tmp/plan"
! grep -q 'codex launcher' "$tmp/plan"
[[ ! -e "$AGENT_BIN_DIR/codexr" && "$(sha256sum "$BASHRC_FILE")" == "$original_bashrc" ]]
ok 'default install does not select launcher'
# Simulate the exact owned old link (dangling after source removal).
ln -s "$repo_root/codex-launcher/codex" "$AGENT_BIN_DIR/codex"
./install.sh --codex-launcher --dry-run >"$tmp/plan"
[[ -L "$AGENT_BIN_DIR/codex" && ! -e "$AGENT_BIN_DIR/codexr" ]]
[[ "$(sha256sum "$BASHRC_FILE")" == "$original_bashrc" ]]
ok 'launcher dry-run does not migrate or modify shell'
./install.sh --codex-launcher -y >"$tmp/plan"
for name in codexr codex-direct codex-mise; do
  [[ -L "$AGENT_BIN_DIR/$name" && "$(readlink -f "$AGENT_BIN_DIR/$name")" == "$repo_root/codex-launcher/$name" ]]
done
[[ ! -L "$AGENT_BIN_DIR/codex" && ! -e "$AGENT_BIN_DIR/codex" ]]
old_link=$(find "$tmp/agent-bin-backups" -type l -name codex)
[[ "$(readlink "$old_link")" == "$repo_root/codex-launcher/codex" ]]
[[ -x "$LOCAL_BIN_DIR/codex" ]]
ok 'installed explicit helpers, backed up exact owned obsolete link, kept native codex'
[[ "$(head -n 2 "$BASHRC_FILE")" == $'existing-start\nexisting-end' ]]
[[ "$(tail -n 1 "$BASHRC_FILE")" == *'/codex-launcher/path.bash"' ]]
backup=$(find "$HOME" -name '.bashrc.backup.*' -type f)
[[ "$(head -n 2 "$backup")" == $'existing-start\nexisting-end' ]]
ok 'shell contents preserved, backed up, hook appended after initialization'
installed_bashrc=$(sha256sum "$BASHRC_FILE")
expect_rc 0 ./install.sh --codex-launcher </dev/null
[[ "$(sha256sum "$BASHRC_FILE")" == "$installed_bashrc" ]]
ok 'idempotent rerun preserves hook/helper links and needs no confirmation'
# Unowned links (including another repository's old wrapper) must stay untouched.
ln -s "$tmp/other-repo/codex-launcher/codex" "$AGENT_BIN_DIR/codex"
expect_rc 1 ./install.sh --codex-launcher --backup-existing -y
[[ "$(readlink "$AGENT_BIN_DIR/codex")" == "$tmp/other-repo/codex-launcher/codex" ]]
[[ "$(sha256sum "$BASHRC_FILE")" == "$installed_bashrc" ]]
rm -- "$AGENT_BIN_DIR/codex"
ok 'unowned plain codex blocks PATH integration, even with backup option'
# A fresh noninteractive shell with a controlled rc-equivalent environment.
path_result=$(PATH="$LOCAL_BIN_DIR:/usr/bin:$AGENT_BIN_DIR:$AGENT_BIN_DIR:" bash --noprofile --norc -ec '
  source "$1"
  first=$PATH
  source "$1"
  [[ "$PATH" == "$first" ]]
  [[ "$PATH" == "$AGENT_BIN_DIR:$LOCAL_BIN_DIR:/usr/bin:" ]]
  [[ "$(command -v codex)" == "$LOCAL_BIN_DIR/codex" ]]
  [[ "$(command -v codexr)" == "$AGENT_BIN_DIR/codexr" ]]
  printf verified
' bash "$repo_root/codex-launcher/path.bash")
[[ "$path_result" == verified ]]
ok 'PATH fixes inherited precedence/deduplicates, preserves empty entry and native codex'

# Mock binaries record exact argv and daemon ordering, with injected failures.
cat > "$tmp/mocks/codex" <<'EOF'
#!/usr/bin/env bash
name=${0##*/}
printf '%s env=%s args=' "$name" "${CODEX_MONITOR_CODEX_BIN-}" >> "$CODEX_LAUNCHER_TEST_LOG"
printf '<%s>' "$@" >> "$CODEX_LAUNCHER_TEST_LOG"
printf '\n' >> "$CODEX_LAUNCHER_TEST_LOG"
if [[ "$name" == codex && "${1-}" == app-server ]]; then exit "${FAIL_SERVER:-0}"; fi
if [[ "$name" == codex-monitor ]]; then exit "${FAIL_MONITOR:-0}"; fi
EOF
cp "$tmp/mocks/codex" "$tmp/mocks/codex-monitor"
cp "$tmp/mocks/codex" "$tmp/mocks/mise"
chmod +x "$tmp/mocks/"*
export CODEX_LAUNCHER_STANDALONE_BIN="$tmp/mocks/codex"
export CODEX_LAUNCHER_MONITOR_BIN="$tmp/mocks/codex-monitor"
export CODEX_LAUNCHER_MISE_BIN="$tmp/mocks/mise"
export CODEX_LAUNCHER_TEST_LOG="$tmp/route-log"
unset CODEX_MONITOR_CODEX_BIN FAIL_SERVER FAIL_MONITOR
route() { : > "$CODEX_LAUNCHER_TEST_LOG"; expect_rc "$1" "codex-launcher/codexr" "${@:2}"; }
shared_route() {
  route 0 "$@"
  [[ "$(head -n 1 "$CODEX_LAUNCHER_TEST_LOG")" == 'codex env= args=<app-server><daemon><start>' ]]
  [[ "$(wc -l < "$CODEX_LAUNCHER_TEST_LOG")" == 3 ]]
  grep -Fqx "codex-monitor env=$CODEX_LAUNCHER_STANDALONE_BIN args=<daemon><start>" "$CODEX_LAUNCHER_TEST_LOG"
}
shared_route
shared_route -- -m sol -c model_reasoning_effort=high 'fix it'
grep -Fqx 'codex env= args=<--remote><unix://><-m><sol><-c><model_reasoning_effort=high><fix it>' "$CODEX_LAUNCHER_TEST_LOG"
ok 'default/model/config startup ordered once with exact argv and no weakened defaults'
for command in resume fork; do
  shared_route -- "$command" --last
  grep -Fqx "codex env= args=<--remote><unix://><$command><--last>" "$CODEX_LAUNCHER_TEST_LOG"
done
shared_route -- agents
grep -Fqx 'codex env= args=<--remote><unix://><agents>' "$CODEX_LAUNCHER_TEST_LOG"
ok 'resume/fork/agents argv forwarded (mocked, not real sessions)'
for args in '--remote' '--remote=unix:///tmp/custom.sock' '--remote-auth-token-env=TOKEN' '--no-daemon'; do
  for command in resume fork; do
    route 2 -- "$command" "$args"
    [[ ! -s "$CODEX_LAUNCHER_TEST_LOG" ]]
    grep -q 'use native codex' "$tmp/stderr"
  done
  route 2 -- "$args"
  [[ ! -s "$CODEX_LAUNCHER_TEST_LOG" ]]
done
route 2 -- resume --remote-auth-token-env TOKEN
[[ ! -s "$CODEX_LAUNCHER_TEST_LOG" ]]
ok 'explicit remote/auth/no-daemon rejected before any invocation, including after resume/fork'
route 2 -m sol
[[ ! -s "$CODEX_LAUNCHER_TEST_LOG" ]]
route 2 exec hello
[[ ! -s "$CODEX_LAUNCHER_TEST_LOG" ]]
ok 'native arguments require separator; no catch-all subcommand parser'
route 0 --help
[[ ! -s "$CODEX_LAUNCHER_TEST_LOG" ]]
route 0 --version
[[ "$(<"$CODEX_LAUNCHER_TEST_LOG")" == 'codex env= args=<--version>' ]]
route 0 -- resume --help
[[ "$(<"$CODEX_LAUNCHER_TEST_LOG")" == 'codex env= args=<resume><--help>' ]]
route 0 -- --version
[[ "$(<"$CODEX_LAUNCHER_TEST_LOG")" == 'codex env= args=<--version>' ]]
ok 'wrapper/native help and version never start services'
shared_route -- -- --remote
grep -Fqx 'codex env= args=<--remote><unix://><--><--remote>' "$CODEX_LAUNCHER_TEST_LOG"
shared_route -- -- --no-daemon
grep -Fqx 'codex env= args=<--remote><unix://><--><--no-daemon>' "$CODEX_LAUNCHER_TEST_LOG"
ok 'native terminator preserves flag-shaped literal prompts'
export FAIL_SERVER=7
route 7
[[ "$(wc -l < "$CODEX_LAUNCHER_TEST_LOG")" == 1 ]]
unset FAIL_SERVER
export FAIL_MONITOR=8
route 8
[[ "$(wc -l < "$CODEX_LAUNCHER_TEST_LOG")" == 2 ]]
unset FAIL_MONITOR
ok 'daemon startup failure stops launch and preserves exit status'
: > "$CODEX_LAUNCHER_TEST_LOG"
codex-launcher/codex-direct alpha beta
[[ "$(<"$CODEX_LAUNCHER_TEST_LOG")" == 'codex env= args=<alpha><beta>' ]]
: > "$CODEX_LAUNCHER_TEST_LOG"
codex-launcher/codex-mise --version
[[ "$(<"$CODEX_LAUNCHER_TEST_LOG")" == 'mise env= args=<x><codex><--><codex><--version>' ]]
ok 'existing direct/Mise helpers use exact binaries without PATH recursion'
printf '%d launcher checks passed\n' "$pass"
