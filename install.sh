#!/usr/bin/env bash
set -euo pipefail

backup_existing=false
dry_run=false
pi_mode=auto

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Install this repository's skills using symlinks.

Options:
  --backup-existing  Move conflicting paths to timestamped backups
  --dry-run          Print changes without making them
  --pi               Install Pi links even if ~/.pi/agent does not exist
  --no-pi            Do not install Pi links
  -h, --help         Show this help
EOF
}

while (($#)); do
  case "$1" in
    --backup-existing)
      backup_existing=true
      ;;
    --dry-run)
      dry_run=true
      ;;
    --pi)
      pi_mode=always
      ;;
    --no-pi)
      pi_mode=never
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
shared_root="${AGENT_SKILLS_DIR:-$HOME/.agents/skills}"
pi_root="${PI_SKILLS_DIR:-$HOME/.pi/agent/skills}"
timestamp=$(date +%Y%m%d-%H%M%S)
skills=(async-monitor launch-agents mdl)

run() {
  if "$dry_run"; then
    printf 'DRY RUN:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

same_target() {
  local source=$1
  local destination=$2
  local source_real destination_real

  [[ -L "$destination" ]] || return 1
  source_real=$(readlink -f -- "$source")
  destination_real=$(readlink -f -- "$destination" 2>/dev/null || true)
  [[ -n "$destination_real" && "$destination_real" == "$source_real" ]]
}

preflight() {
  local destination_root=$1
  local source_root=$2
  local name source destination
  local conflicts=()

  for name in "${skills[@]}"; do
    source="$source_root/$name"
    destination="$destination_root/$name"

    if same_target "$source" "$destination"; then
      continue
    fi

    if [[ -e "$destination" || -L "$destination" ]]; then
      conflicts+=("$destination")
    fi
  done

  if (("${#conflicts[@]}" > 0)) && ! "$backup_existing"; then
    printf 'Refusing to replace existing skill paths:\n' >&2
    printf '  %s\n' "${conflicts[@]}" >&2
    printf 'Rerun with --backup-existing to move them aside safely.\n' >&2
    return 1
  fi
}

install_links() {
  local destination_root=$1
  local source_root=$2
  local name source destination backup

  run mkdir -p -- "$destination_root"

  for name in "${skills[@]}"; do
    source="$source_root/$name"
    destination="$destination_root/$name"

    if same_target "$source" "$destination"; then
      printf 'Already installed: %s\n' "$destination"
      continue
    fi

    if [[ -e "$destination" || -L "$destination" ]]; then
      backup="$destination.backup.$timestamp"
      run mv -- "$destination" "$backup"
    fi

    run ln -s -- "$source" "$destination"
    if "$dry_run"; then
      printf 'Would install: %s -> %s\n' "$destination" "$source"
    else
      printf 'Installed: %s -> %s\n' "$destination" "$source"
    fi
  done
}

for name in "${skills[@]}"; do
  if [[ ! -f "$repo_root/skills/$name/SKILL.md" ]]; then
    printf 'Missing skill entrypoint: %s\n' "$repo_root/skills/$name/SKILL.md" >&2
    exit 1
  fi
done

preflight "$shared_root" "$repo_root/skills"
install_links "$shared_root" "$repo_root/skills"

install_pi=false
case "$pi_mode" in
  always)
    install_pi=true
    ;;
  auto)
    [[ -d "$HOME/.pi/agent" ]] && install_pi=true
    ;;
  never)
    ;;
esac

if "$install_pi"; then
  preflight "$pi_root" "$shared_root"
  install_links "$pi_root" "$shared_root"
fi
