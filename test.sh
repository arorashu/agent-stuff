#!/usr/bin/env bash
# Hermetic smoke tests for install.sh and the make facade.
#
# All filesystem access is isolated in mktemp directories via the
# AGENT_SKILLS_DIR, CODEX_SKILLS_DIR, PI_SKILLS_DIR, and PI_EXTENSIONS_DIR
# overrides plus a temporary HOME; real agent directories are never touched.
#
# Assertion strategy: exact for contract state (exit codes, path existence,
# symlink resolution, sentinel location, single plan header); loose fixed
# strings for prose. No output snapshots.

set -u

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$repo_root"

# Explicit expected inventory. Update when adding installable items.
skills=(async-monitor launch-agents)
extensions=(tps.ts work-timer.ts)

workspace() {
  local d=$1
  mkdir -p "$d/home" "$d/agents" "$d/pi" "$d/piext" "$d/codex" || {
    printf 'workspace setup failed: %s\n' "$d" >&2
    exit 1
  }
  export HOME="$d/home" \
    AGENT_SKILLS_DIR="$d/agents" \
    CODEX_SKILLS_DIR="$d/codex" \
    PI_SKILLS_DIR="$d/pi" \
    PI_EXTENSIONS_DIR="$d/piext"
}

tmp=$(mktemp -d) || { printf 'mktemp -d failed\n' >&2; exit 1; }
[[ -n "$tmp" && -d "$tmp" ]] || { printf 'mktemp produced no directory\n' >&2; exit 1; }
trap 'rm -rf "$tmp"' EXIT
workspace "$tmp/w1"

pass=0
fail=0
ok()  { printf 'ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf 'FAIL %s\n' "$1"; fail=$((fail + 1)); }

# check DESCRIPTION EXPECTED_RC COMMAND...  (captures rc even on failure)
check() {
  local desc=$1 want=$2
  shift 2
  local got=0
  "$@" >/dev/null 2>&1 || got=$?
  if [[ "$got" == "$want" ]]; then
    ok "$desc"
  else
    bad "$desc (want exit $want, got $got)"
  fi
}

# no_mutation DESCRIPTION DIR...  (every dir must have no entries)
no_mutation() {
  local desc=$1
  shift
  local d clean=true
  for d in "$@"; do
    if [[ ! -d "$d" ]] || ! ls -A "$d" >/dev/null 2>&1; then
      clean=false
      continue
    fi
    [[ -n "$(ls -A "$d")" ]] && clean=false
  done
  if "$clean"; then
    ok "$desc"
  else
    bad "$desc (destination tree missing, unreadable, or not empty)"
  fi
}

# 1. Shell syntax
check "install.sh passes bash -n" 0 bash -n install.sh

# 2. make help integrity (a truncated help recipe must not pass)
help_out=$(make help 2>&1)
help_rc=$?
if [[ "$help_rc" == 0 ]] && grep -q 'Conventions:' <<<"$help_out" \
  && grep -q 'Exit codes:' <<<"$help_out"; then
  ok "make help exits 0 and prints through the final sections"
else
  bad "make help integrity (rc=$help_rc)"
fi

# 3. Dry-run: exactly one plan, zero mutations
out=$(./install.sh --dry-run --pi 2>&1)
rc=$?
plan_count=$(grep -c 'Install plan:' <<<"$out")
if [[ "$rc" == 0 && "$plan_count" == 1 ]] \
  && grep -q 'skill async-monitor' <<<"$out" \
  && grep -q 'pi skill launch-agents' <<<"$out" \
  && grep -q 'extension tps.ts' <<<"$out"; then
  ok "dry-run prints exactly one plan"
else
  bad "dry-run single plan (rc=$rc, plans=$plan_count)"
fi
no_mutation "dry-run leaves destination trees empty" "$tmp/w1/agents" "$tmp/w1/pi" "$tmp/w1/piext"
if [[ ! -d "$tmp/w1/skill-backups" && ! -d "$tmp/w1/extension-backups" ]]; then
  ok "dry-run creates no backup roots"
else
  bad "dry-run created backup roots"
fi

# 4. Non-interactive without -y: fail closed
out=$(./install.sh --pi </dev/null 2>&1)
rc=$?
if [[ "$rc" == 1 ]] && grep -q 're-run with -y' <<<"$out"; then
  ok "non-interactive without -y fails closed (exit 1)"
else
  bad "non-interactive guard (rc=$rc)"
fi
no_mutation "non-interactive abort leaves destination trees empty" "$tmp/w1/agents" "$tmp/w1/pi" "$tmp/w1/piext"

# 5. Unknown selector rejected with the valid list
out=$(./install.sh --skill bogus -y 2>&1)
rc=$?
if [[ "$rc" == 2 ]] && grep -q 'Unknown skill: bogus' <<<"$out" \
  && grep -q 'Valid skills: async-monitor launch-agents' <<<"$out"; then
  ok "unknown skill rejected with valid list"
else
  bad "unknown skill rejection (rc=$rc)"
fi

# 6. Make facade validates boolean variables
out=$(make install YES=bogus DRY=1 2>&1)
rc=$?
if [[ "$rc" == 2 ]] && grep -q 'Invalid value for YES' <<<"$out"; then
  ok "make rejects invalid boolean (YES=bogus)"
else
  bad "make boolean validation (rc=$rc)"
fi

# 7. ARGS pass-through reaches the script (fresh workspace)
workspace "$tmp/w2"
out=$(make install SKILL=async-monitor ARGS="--dry-run --no-pi" 2>&1)
rc=$?
if [[ "$rc" == 0 ]] && grep -q 'skill async-monitor' <<<"$out" \
  && ! grep -q 'extension tps.ts' <<<"$out"; then
  ok "ARGS forwarded: plan selects exactly the named skill"
else
  bad "ARGS pass-through (rc=$rc)"
fi

# 8. Apply with -y: symlinks exist and resolve to repo sources (fresh)
workspace "$tmp/w3"
check "apply with -y" 0 ./install.sh --pi -y
link_ok=true
for name in "${skills[@]}"; do
  [[ -L "$tmp/w3/agents/$name" && "$(readlink -f "$tmp/w3/agents/$name")" == "$repo_root/skills/$name" ]] || link_ok=false
  [[ -L "$tmp/w3/pi/$name" && "$(readlink -f "$tmp/w3/pi/$name")" == "$repo_root/skills/$name" ]] || link_ok=false
done
for name in "${extensions[@]}"; do
  [[ -L "$tmp/w3/piext/$name" && "$(readlink -f "$tmp/w3/piext/$name")" == "$repo_root/pi-extensions/$name" ]] || link_ok=false
done
if "$link_ok"; then
  ok "apply created correct symlinks resolving to repo sources"
else
  bad "apply symlink targets"
fi

# 9. Idempotent no-op rerun without -y (no prompt on no-op)
out=$(./install.sh --pi </dev/null 2>&1)
rc=$?
if [[ "$rc" == 0 ]] && grep -q 'Nothing to do.' <<<"$out"; then
  ok "idempotent no-op rerun without -y"
else
  bad "idempotent rerun (rc=$rc)"
fi

# 10. Conflict refusal protects existing content (fresh, seeded)
workspace "$tmp/w4"
mkdir -p "$tmp/w4/agents/async-monitor"
printf 'sentinel\n' > "$tmp/w4/agents/async-monitor/SKILL.md"
out=$(./install.sh --no-pi --skill async-monitor -y 2>&1)
rc=$?
if [[ "$rc" == 1 ]] && grep -q 'Refusing to replace existing skill paths' <<<"$out" \
  && [[ -f "$tmp/w4/agents/async-monitor/SKILL.md" ]] \
  && [[ "$(cat "$tmp/w4/agents/async-monitor/SKILL.md")" == "sentinel" ]]; then
  ok "conflict refused without --backup-existing (sentinel intact)"
else
  bad "conflict refusal (rc=$rc)"
fi

# 11. --backup-existing relocates the conflict and installs the link
check "--backup-existing applies" 0 ./install.sh --no-pi --skill async-monitor --backup-existing -y
moved=$(find "$tmp/w4/skill-backups" -name SKILL.md 2>/dev/null)
if [[ -n "$moved" && "$(cat "$moved")" == "sentinel" ]] \
  && [[ -L "$tmp/w4/agents/async-monitor" ]] \
  && [[ "$(readlink -f "$tmp/w4/agents/async-monitor")" == "$repo_root/skills/async-monitor" ]]; then
  ok "--backup-existing relocated sentinel and installed the link"
else
  bad "backup relocation (found: ${moved:-none})"
fi

printf '%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
