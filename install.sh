#!/usr/bin/env bash
set -euo pipefail

backup_existing=false
dry_run=false
pi_mode=auto
assume_yes=false
wanted_skills=()
wanted_extensions=()
wanted_codex_monitor=false
wanted_codex_launcher=false

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Install this repository's skills and Pi extensions.

Options:
  --backup-existing  Move conflicting paths to timestamped backups
  --dry-run          Print the plan and exit without making changes
  --skill NAME       Select this skill (repeatable)
  --extension NAME   Select this extension (repeatable)
  --codex-monitor    Select the codex-monitor CLI
  --codex-launcher   Select codexr and the direct/Mise helpers (not plain codex)
  --pi               Install Pi links even if ~/.pi/agent does not exist
  --no-pi            Do not install Pi links
  -y, --yes          Apply without the confirmation prompt
  -h, --help         Show this help

Selection:
  With no --skill/--extension, all skills and extensions are installed.
  If any selector is given, only the explicitly named items are
  installed; selectors may be combined and repeated.

Exit codes:
  0  applied, dry-run completed, no-op, or user declined
  1  operational failure (conflict without --backup-existing, or
     confirmation unavailable on non-terminal stdin)
  2  invocation error (unknown option or item, missing argument)
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
    -y|--yes)
      assume_yes=true
      ;;
    --skill)
      if (( $# < 2 )); then
        printf 'Missing value for --skill\n' >&2
        exit 2
      fi
      wanted_skills+=("$2")
      shift
      ;;
    --extension)
      if (( $# < 2 )); then
        printf 'Missing value for --extension\n' >&2
        exit 2
      fi
      wanted_extensions+=("$2")
      shift
      ;;
    --codex-monitor)
      wanted_codex_monitor=true
      ;;
    --codex-launcher)
      wanted_codex_launcher=true
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
local_bin_root="${LOCAL_BIN_DIR:-$HOME/.local/bin}"
agent_bin_root="${AGENT_BIN_DIR:-$HOME/.local/agent-bin}"
bashrc_file="${BASHRC_FILE:-$HOME/.bashrc}"
pi_root="${PI_SKILLS_DIR:-$HOME/.pi/agent/skills}"
pi_extensions_root="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"
timestamp=$(date +%Y%m%d-%H%M%S)
all_skills=(article-html async-monitor launch-agents)
all_extensions=(async-monitor pi-deepseek-websearch session-id-status.ts tps.ts work-timer.ts)

for want in "${wanted_skills[@]}"; do
  found=false
  for name in "${all_skills[@]}"; do
    [[ "$want" == "$name" ]] && found=true
  done
  if ! "$found"; then
    printf 'Unknown skill: %s\nValid skills: %s\n' "$want" "${all_skills[*]}" >&2
    exit 2
  fi
done

for want in "${wanted_extensions[@]}"; do
  found=false
  for name in "${all_extensions[@]}"; do
    [[ "$want" == "$name" ]] && found=true
  done
  if ! "$found"; then
    printf 'Unknown extension: %s\nValid extensions: %s\n' "$want" "${all_extensions[*]}" >&2
    exit 2
  fi
done

selected_any=$(( ${#wanted_skills[@]} + ${#wanted_extensions[@]} ))
"$wanted_codex_monitor" && selected_any=$((selected_any + 1))
"$wanted_codex_launcher" && selected_any=$((selected_any + 1))

if (( ${#wanted_skills[@]} > 0 )); then
  skills=()
  for name in "${all_skills[@]}"; do
    for want in "${wanted_skills[@]}"; do
      [[ "$want" == "$name" ]] && skills+=("$name")
    done
  done
elif (( selected_any == 0 )); then
  skills=("${all_skills[@]}")
else
  skills=()
fi

if (( ${#wanted_extensions[@]} > 0 )); then
  extensions=()
  for name in "${all_extensions[@]}"; do
    for want in "${wanted_extensions[@]}"; do
      [[ "$want" == "$name" ]] && extensions+=("$name")
    done
  done
elif (( selected_any == 0 )); then
  extensions=("${all_extensions[@]}")
else
  extensions=()
fi

install_codex_monitor=false
if "$wanted_codex_monitor" || (( selected_any == 0 )); then
  install_codex_monitor=true
fi

if (( ${#skills[@]} == 0 && ${#extensions[@]} == 0 )) && ! "$install_codex_monitor" && ! "$wanted_codex_launcher"; then
  printf 'Nothing selected to install.\n'
  exit 0
fi

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
      mkdir -p -- "$backup_root"
      prepared=true
    fi
    mv -- "$destination" "$backup_root/$name"
    printf 'Migrated duplicate: %s -> %s\n' "$destination" "$backup_root/$name"
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

  mkdir -p -- "$destination_root"

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
        mkdir -p -- "$backup_root"
        prepared_backup=true
      fi
      mv -- "$destination" "$backup_root/$name"
      printf 'Backed up: %s -> %s\n' "$destination" "$backup_root/$name"
    fi

    ln -s -- "$source" "$destination"
    printf 'Installed: %s -> %s\n' "$destination" "$source"
  done
}

plan_entry() {
  local label=$1 name=$2 source=$3 destination=$4 backup_dir=$5
  local backup_note=""
  if [[ -e "$destination" || -L "$destination" ]]; then
    backup_note=" (existing will be backed up to $backup_dir/$name)"
  fi
  printf '  [install] %s %s\n' "$label" "$name"
  printf '          %s -> %s%s\n' "$destination" "$source" "$backup_note"
}

show_plan() {
  local name
  local changes=0

  printf 'Install plan:\n'

  if "$wanted_codex_launcher"; then
    if link_points_to "$repo_root/codex-launcher/codex" "$agent_bin_root/codex"; then
      changes=$((changes + 1))
      printf '  [migrate] owned obsolete codex link to agent-bin-backups/%s/codex\n' "$timestamp"
    fi
    for name in codexr codex-direct codex-mise; do
      if same_target "$repo_root/codex-launcher/$name" "$agent_bin_root/$name"; then
        printf '  [skip]    codex launcher %s (already installed)\n' "$name"
      else
        changes=$((changes + 1))
        plan_entry 'codex launcher' "$name" "$repo_root/codex-launcher/$name" \
          "$agent_bin_root/$name" "$(dirname -- "$agent_bin_root")/agent-bin-backups/$timestamp"
      fi
    done
    shell_line="[[ -r \"$repo_root/codex-launcher/path.bash\" ]] && source \"$repo_root/codex-launcher/path.bash\""
    if [[ -f "$bashrc_file" ]] && grep -Fqx -- "$shell_line" "$bashrc_file"; then
      printf '  [skip]    bash PATH integration (already installed)\n'
    else
      changes=$((changes + 1))
      printf '  [install] bash PATH integration at end of %s\n' "$bashrc_file"
    fi
  fi

  if "$install_codex_monitor"; then
    if same_target "$repo_root/codex-monitor/bin/codex-monitor.mjs" "$local_bin_root/codex-monitor"; then
      printf '  [skip]    codex-monitor (already installed)\n'
    else
      changes=$((changes + 1))
      plan_entry 'cli' 'codex-monitor' "$repo_root/codex-monitor/bin/codex-monitor.mjs" \
        "$local_bin_root/codex-monitor" "$(dirname -- "$local_bin_root")/bin-backups/$timestamp"
    fi
  fi

  for name in "${skills[@]}"; do
    if same_target "$repo_root/skills/$name" "$shared_root/$name"; then
      printf '  [skip]    skill %s (already installed)\n' "$name"
    else
      changes=$((changes + 1))
      plan_entry 'skill' "$name" "$repo_root/skills/$name" "$shared_root/$name" \
        "$(dirname -- "$shared_root")/skill-backups/$timestamp"
    fi
  done

  if "$install_pi"; then
    for name in "${skills[@]}"; do
      if same_target "$repo_root/skills/$name" "$pi_root/$name" ||
        link_points_to "$shared_root/$name" "$pi_root/$name"; then
        printf '  [skip]    pi skill %s (already installed)\n' "$name"
      else
        changes=$((changes + 1))
        plan_entry 'pi skill' "$name" "$shared_root/$name" "$pi_root/$name" \
          "$(dirname -- "$pi_root")/skill-backups/$timestamp"
      fi
    done
    for name in "${extensions[@]}"; do
      if same_target "$repo_root/pi-extensions/$name" "$pi_extensions_root/$name"; then
        printf '  [skip]    extension %s (already installed)\n' "$name"
      else
        changes=$((changes + 1))
        plan_entry 'extension' "$name" "$repo_root/pi-extensions/$name" "$pi_extensions_root/$name" \
          "$(dirname -- "$pi_extensions_root")/extension-backups/$timestamp"
      fi
    done
  fi

  if [[ "$(realpath -m -- "$codex_root")" != "$(realpath -m -- "$shared_root")" ]]; then
    for name in "${skills[@]}"; do
      if [[ -e "$codex_root/$name" || -L "$codex_root/$name" ]]; then
        changes=$((changes + 1))
        printf '  [migrate] codex duplicate %s\n' "$name"
        printf '          %s -> %s\n' "$codex_root/$name" \
          "$(dirname -- "$codex_root")/skill-backups/$timestamp/$name"
      fi
    done
  fi

  if (( changes == 0 )); then
    printf 'Nothing to do.\n'
    return 1
  fi
  return 0
}

confirm() {
  if "$assume_yes"; then
    return
  fi
  if [[ ! -t 0 ]]; then
    printf 'Cannot confirm because stdin is not a terminal; re-run with -y to apply.\n' >&2
    exit 1
  fi
  local answer
  read -r -p 'Proceed? [y/N] ' answer
  case "$answer" in
    y|Y|yes|YES) return ;;
    *) printf 'Aborted; nothing changed.\n'; exit 0 ;;
  esac
}

for name in "${skills[@]}"; do
  if [[ ! -f "$repo_root/skills/$name/SKILL.md" ]]; then
    printf 'Missing skill entrypoint: %s\n' "$repo_root/skills/$name/SKILL.md" >&2
    exit 1
  fi
done

for name in "${extensions[@]}"; do
  source="$repo_root/pi-extensions/$name"
  if [[ -f "$source" || -f "$source/index.ts" ]]; then
    continue
  fi
  printf 'Missing Pi extension: %s\n' "$source" >&2
  exit 1
done

if "$install_codex_monitor"; then
  for source in bin/codex-monitor.mjs src/app-server-client.mjs src/thread-delivery.mjs; do
    if [[ ! -f "$repo_root/codex-monitor/$source" ]]; then
      printf 'Missing Codex monitor package file: %s\n' "$repo_root/codex-monitor/$source" >&2
      exit 1
    fi
  done
  if [[ ! -x "$repo_root/codex-monitor/bin/codex-monitor.mjs" ]]; then
    printf 'Codex monitor launcher is not executable: %s\n' "$repo_root/codex-monitor/bin/codex-monitor.mjs" >&2
    exit 1
  fi
fi
if "$wanted_codex_launcher"; then
  for source in codexr codex-direct codex-mise path.bash; do
    if [[ ! -f "$repo_root/codex-launcher/$source" ]]; then
      printf 'Missing Codex launcher file: %s\n' "$repo_root/codex-launcher/$source" >&2
      exit 1
    fi
  done
  for source in codexr codex-direct codex-mise; do
    if [[ ! -x "$repo_root/codex-launcher/$source" ]]; then
      printf 'Codex launcher is not executable: %s\n' "$repo_root/codex-launcher/$source" >&2
      exit 1
    fi
  done
  preflight "$agent_bin_root" "$repo_root/codex-launcher" "Codex launcher paths" codexr codex-direct codex-mise
  # Never put an unrelated plain codex ahead of the user's native executable.
  if [[ -e "$agent_bin_root/codex" || -L "$agent_bin_root/codex" ]] &&
    ! link_points_to "$repo_root/codex-launcher/codex" "$agent_bin_root/codex"; then
    printf 'Refusing PATH integration: unowned codex in %s (left untouched).\n' "$agent_bin_root" >&2
    exit 1
  fi
fi

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
if "$install_codex_monitor"; then
  if [[ -e "$local_bin_root/codex-monitor" || -L "$local_bin_root/codex-monitor" ]]; then
    if ! same_target "$repo_root/codex-monitor/bin/codex-monitor.mjs" "$local_bin_root/codex-monitor" && ! "$backup_existing"; then
      printf 'Refusing to replace existing CLI path:\n  %s\n' "$local_bin_root/codex-monitor" >&2
      printf 'Rerun with --backup-existing to move it aside safely.\n' >&2
      exit 1
    fi
  fi
fi
preflight_codex_duplicates
if "$install_pi"; then
  preflight_pi
  preflight "$pi_extensions_root" "$repo_root/pi-extensions" "Pi extension paths" "${extensions[@]}"
fi

show_plan || exit 0
if "$dry_run"; then
  exit 0
fi
confirm

migrate_codex_duplicates
if "$wanted_codex_launcher"; then
  install_links "$agent_bin_root" "$repo_root/codex-launcher" "agent-bin-backups" codexr codex-direct codex-mise
  if link_points_to "$repo_root/codex-launcher/codex" "$agent_bin_root/codex"; then
    backup_root="$(dirname -- "$agent_bin_root")/agent-bin-backups/$timestamp"
    mkdir -p -- "$backup_root"
    mv -- "$agent_bin_root/codex" "$backup_root/codex"
    printf 'Backed up owned obsolete codex link: %s/codex\n' "$backup_root"
  fi
  shell_line="[[ -r \"$repo_root/codex-launcher/path.bash\" ]] && source \"$repo_root/codex-launcher/path.bash\""
  if [[ ! -f "$bashrc_file" ]] || ! grep -Fqx -- "$shell_line" "$bashrc_file"; then
    if [[ -f "$bashrc_file" ]]; then
      cp -p -- "$bashrc_file" "$bashrc_file.backup.$timestamp"
    else
      mkdir -p -- "$(dirname -- "$bashrc_file")"
    fi
    printf '\n# agent-stuff Codex launcher (keep after Omarchy/Mise initialization)\n%s\n' "$shell_line" >> "$bashrc_file"
    printf 'Installed PATH integration: %s\n' "$bashrc_file"
  fi
fi
if "$install_codex_monitor"; then
  mkdir -p -- "$local_bin_root"
  if ! same_target "$repo_root/codex-monitor/bin/codex-monitor.mjs" "$local_bin_root/codex-monitor"; then
    if [[ -e "$local_bin_root/codex-monitor" || -L "$local_bin_root/codex-monitor" ]]; then
      backup_root="$(dirname -- "$local_bin_root")/bin-backups/$timestamp"
      mkdir -p -- "$backup_root"
      mv -- "$local_bin_root/codex-monitor" "$backup_root/codex-monitor"
      printf 'Backed up: %s -> %s\n' "$local_bin_root/codex-monitor" "$backup_root/codex-monitor"
    fi
    ln -s -- "$repo_root/codex-monitor/bin/codex-monitor.mjs" "$local_bin_root/codex-monitor"
    printf 'Installed: %s -> %s\n' "$local_bin_root/codex-monitor" "$repo_root/codex-monitor/bin/codex-monitor.mjs"
  fi
fi
install_links "$shared_root" "$repo_root/skills" "skill-backups" "${skills[@]}"
if "$install_pi"; then
  install_links "$pi_root" "$shared_root" "skill-backups" "${skills[@]}"
  install_links "$pi_extensions_root" "$repo_root/pi-extensions" "extension-backups" "${extensions[@]}"
fi
