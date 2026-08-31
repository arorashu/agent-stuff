#!/usr/bin/env bash
set -euo pipefail

backup_existing=false
dry_run=false
pi_mode=auto

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Install this repository's skills and Pi extensions using symlinks.

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
codex_root="${CODEX_SKILLS_DIR:-$HOME/.codex/skills}"
pi_root="${PI_SKILLS_DIR:-$HOME/.pi/agent/skills}"
pi_extensions_root="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"
timestamp=$(date +%Y%m%d-%H%M%S)
skills=(async-monitor launch-agents)
extensions=(tps.ts work-timer.ts)

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
  local label=$3
  shift 3
  local names=("$@")
  local name source destination
  local conflicts=()

  for name in "${names[@]}"; do
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
    printf 'Refusing to replace existing %s:\n' "$label" >&2
    printf '  %s\n' "${conflicts[@]}" >&2
    printf 'Rerun with --backup-existing to move them aside safely.\n' >&2
    return 1
  fi
}

link_points_to() {
  local expected=$1
  local destination=$2
  local link_value link_path

  [[ -L "$destination" ]] || return 1
  link_value=$(readlink -- "$destination")
  if [[ "$link_value" = /* ]]; then
    link_path=$link_value
  else
    link_path="$(dirname -- "$destination")/$link_value"
  fi

  [[ "$(realpath -m -- "$link_path")" == "$(realpath -m -- "$expected")" ]]
}

preflight_pi() {
  local name destination
  local conflicts=()

  for name in "${skills[@]}"; do
    destination="$pi_root/$name"

    if same_target "$repo_root/skills/$name" "$destination" ||
      link_points_to "$shared_root/$name" "$destination"; then
      continue
    fi

    if [[ -e "$destination" || -L "$destination" ]]; then
      conflicts+=("$destination")
    fi
  done

  if (("${#conflicts[@]}" > 0)) && ! "$backup_existing"; then
    printf 'Refusing to replace existing Pi skill paths:\n' >&2
    printf '  %s\n' "${conflicts[@]}" >&2
    printf 'Rerun with --backup-existing to move them aside safely.\n' >&2
    return 1
  fi
}

preflight_codex_duplicates() {
  local name destination
  local conflicts=()

  [[ "$(realpath -m -- "$codex_root")" == "$(realpath -m -- "$shared_root")" ]] &&
    return 0

  for name in "${skills[@]}"; do
    destination="$codex_root/$name"
    if [[ -e "$destination" || -L "$destination" ]]; then
      conflicts+=("$destination")
    fi
  done

  if (("${#conflicts[@]}" > 0)) && ! "$backup_existing"; then
    printf 'Direct Codex copies would duplicate the shared skills:\n' >&2
    printf '  %s\n' "${conflicts[@]}" >&2
    printf 'Rerun with --backup-existing to move them aside safely.\n' >&2
    return 1
  fi
}

migrate_codex_duplicates() {
  local name destination backup_root
  local prepared=false

  [[ "$(realpath -m -- "$codex_root")" == "$(realpath -m -- "$shared_root")" ]] &&
    return 0

  backup_root="$(dirname -- "$codex_root")/skill-backups/$timestamp"
  for name in "${skills[@]}"; do
    destination="$codex_root/$name"
    if [[ ! -e "$destination" && ! -L "$destination" ]]; then
      continue
    fi

    if ! "$prepared"; then
      run mkdir -p -- "$backup_root"
      prepared=true
    fi
    run mv -- "$destination" "$backup_root/$name"
    if "$dry_run"; then
      printf 'Would migrate duplicate: %s -> %s\n' "$destination" "$backup_root/$name"
    else
      printf 'Migrated duplicate: %s -> %s\n' "$destination" "$backup_root/$name"
    fi
  done
}

install_links() {
  local destination_root=$1
  local source_root=$2
  local backup_directory=$3
  shift 3
  local names=("$@")
  local name source destination backup_root
  local prepared_backup=false

  run mkdir -p -- "$destination_root"

  for name in "${names[@]}"; do
    source="$source_root/$name"
    destination="$destination_root/$name"

    if same_target "$source" "$destination"; then
      printf 'Already installed: %s\n' "$destination"
      continue
    fi

    if [[ -e "$destination" || -L "$destination" ]]; then
      backup_root="$(dirname -- "$destination_root")/$backup_directory/$timestamp"
      if ! "$prepared_backup"; then
        run mkdir -p -- "$backup_root"
        prepared_backup=true
      fi
      run mv -- "$destination" "$backup_root/$name"
      if "$dry_run"; then
        printf 'Would back up: %s -> %s\n' "$destination" "$backup_root/$name"
      else
        printf 'Backed up: %s -> %s\n' "$destination" "$backup_root/$name"
      fi
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

for name in "${extensions[@]}"; do
  if [[ ! -f "$repo_root/pi-extensions/$name" ]]; then
    printf 'Missing Pi extension: %s\n' "$repo_root/pi-extensions/$name" >&2
    exit 1
  fi
done

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

preflight "$shared_root" "$repo_root/skills" "skill paths" "${skills[@]}"
preflight_codex_duplicates
if "$install_pi"; then
  preflight_pi
  preflight "$pi_extensions_root" "$repo_root/pi-extensions" "Pi extension paths" "${extensions[@]}"
fi

migrate_codex_duplicates
install_links "$shared_root" "$repo_root/skills" "skill-backups" "${skills[@]}"
if "$install_pi"; then
  install_links "$pi_root" "$shared_root" "skill-backups" "${skills[@]}"
  install_links "$pi_extensions_root" "$repo_root/pi-extensions" "extension-backups" "${extensions[@]}"
fi
