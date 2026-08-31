# agent-stuff

Small, reusable agent skills and Pi extensions maintained in one
repository and shared.

## Included skills

| Skill | Purpose | External dependency |
|---|---|---|
| `async-monitor` | Register durable commands and asynchronous checks without polling from the agent | Pi's `async_monitor` extension and/or a separately installed `codex-monitor` |
| `launch-agents` | Choose and operate built-in, headless, or tmux-based Codex and Pi agents | The agent CLIs being used; tmux for interactive sessions |

This repository contains the agent instructions, not the external commands
they describe.

## Included Pi extensions

| Extension | Purpose | Requirement |
|---|---|---|
| `tps` | Show current and session-average generation speed in Pi's footer | Pi's `@earendil-works` extension API |
| `work-timer` | Show live and final agent work duration in Pi's footer | Pi's `@earendil-works` extension API |

## Install

Clone the repository:

```bash
git clone https://github.com/arorashu/agent-stuff.git ~/Work/agent-stuff
cd ~/Work/agent-stuff
```

Install the skills and, when Pi is present, the Pi extensions:

```bash
./install.sh
```

The installer creates links like these:

```text
~/.agents/skills/<name>       -> <clone>/skills/<name>
~/.pi/agent/skills/<name>    -> ~/.agents/skills/<name>
~/.pi/agent/extensions/<file> -> <clone>/pi-extensions/<file>
```

Current Codex builds discover the common `~/.agents/skills` directory, so the
installer does not create duplicate links under `~/.codex/skills`. Pi skill
and extension links are installed when `~/.pi/agent` already exists; use
`--pi` to create them on a new Pi setup.

The installer refuses to replace existing files or links. It also detects
same-named skills installed directly under `~/.codex/skills`, where they would
duplicate the common copy. To migrate existing skill directories safely, move
conflicts into timestamped sibling `skill-backups/...` or
`extension-backups/...` directories:

```bash
./install.sh --backup-existing
```

Backups stay outside active `skills/` and `extensions/` directories so
agents do not discover or load them.

Preview either operation with `--dry-run`:

```bash
./install.sh --dry-run --backup-existing
```

Moving the clone later breaks the repository-facing links; rerun the installer
from the new location.

## Publication and safety notes

Only user-maintained skill content is included. Codex system skills and
Omarchy-managed skills, themes, and extensions are intentionally excluded:
their original packages should install and update them.

The published files were checked for credentials, private keys, tokens,
machine-specific absolute home paths, session data, and generated
authentication state. None are included. Some skills can launch commands or
agents; installing a skill does not grant those commands additional authority.
In particular, the public `launch-agents` guidance keeps Codex sandboxing on
unless a user explicitly chooses otherwise. The included Pi extensions do not
make network requests or execute shell commands.
