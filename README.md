# agent-stuff

Small, reusable agent skills maintained in one repository and shared between
Codex and Pi with symlinks.

## Included skills

| Skill | Purpose | External dependency |
|---|---|---|
| `async-monitor` | Register durable commands and asynchronous checks without polling from the agent | Pi's `async_monitor` extension and/or a separately installed `codex-monitor` |
| `launch-agents` | Choose and operate built-in, headless, or tmux-based Codex and Pi agents | The agent CLIs being used; tmux for interactive sessions |
| `mdl` | Use the author's `mdl` workflow for YouTube format-140 M4A downloads | A separately installed `mdl` command and its uv-managed `yt-dlp` |

This repository contains the agent instructions, not the external commands
they describe.

## Install

Clone the repository:

```bash
git clone https://github.com/arorashu/agent-stuff.git ~/Work/agent-stuff
cd ~/Work/agent-stuff
```

Install the skills:

```bash
./install.sh
```

The installer creates links like these:

```text
~/.agents/skills/<name>       -> <clone>/skills/<name>
~/.pi/agent/skills/<name>    -> ~/.agents/skills/<name>
```

Current Codex builds discover the common `~/.agents/skills` directory, so the
installer does not create duplicate links under `~/.codex/skills`. Pi links
are installed when `~/.pi/agent` already exists; use `--pi` to create them
on a new Pi setup.

The installer refuses to replace existing files or links. To migrate existing
skill directories safely, move conflicts aside with timestamped names:

```bash
./install.sh --backup-existing
```

Preview either operation with `--dry-run`:

```bash
./install.sh --dry-run --backup-existing
```

Moving the clone later breaks the repository-facing links; rerun the installer
from the new location.

## Publication and safety notes

Only user-maintained skill content is included. Codex system skills and
Omarchy-managed links into `/usr/share/omarchy` are intentionally excluded:
their original packages should install and update them.

The published files were checked for credentials, private keys, tokens,
machine-specific absolute home paths, session data, and generated
authentication state. None are included. Some skills can launch commands or
agents; installing a skill does not grant those commands additional authority.
In particular, the public `launch-agents` guidance keeps Codex sandboxing on
unless a user explicitly chooses otherwise.
