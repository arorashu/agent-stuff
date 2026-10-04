# agent-stuff

Reusable agent skills, Pi extensions, optional launchers, and the `codex-monitor` CLI in one repository.

This repository holds skill instructions, extension code, and a complete
repo-relative `codex-monitor` package. Other external CLIs remain separate.

## Pi with persistent memory

[`mpi`](tools/mpi/README.md) launches Pi with OptMem instructions and a private,
persistent memory store. Install it separately with
`python3 tools/mpi/install.py`; requires Python 3.8+ and Pi. The installer
downloads a pinned, checksum-verified OptMem script. Memories stay outside
this repository. See the linked guide for setup on multiple machines.

## Skills

| Skill | Purpose | External dependency |
|---|---|---|
| `article-html` | Turn a public web article into a self-contained reader HTML file with no banners or subscribe chrome | Network fetch (Jina reader first); clipboard `wl-paste` on this machine |
| `async-monitor` | Register durable commands and asynchronous checks without polling from the agent | This repository's `async-monitor` Pi extension and/or `codex-monitor` package |
| `launch-agents` | Choose and operate built-in, headless, or tmux-based Codex and Pi agents | The agent CLIs being used; tmux for interactive sessions |

## Pi extensions

| Extension | Purpose | Requirement |
|---|---|---|
| `async-monitor` | Run durable commands, polling checks, and detached Pi tasks with automatic session delivery | Node.js; Pi |
| `pi-deepseek-websearch` | Register a `deepseek_search` tool that runs DeepSeek's server-side web search | DeepSeek key (`/login` or `DEEPSEEK_API_KEY`); Pi |
| `session-id-status` | Show the current session ID in Pi's default footer | Pi |
| `tps` | Show current and session-average generation speed in Pi's footer | Pi |
| `work-timer` | Show live and final agent work duration in Pi's footer | Pi |

## Codex monitor

`codex-monitor` owns durable commands and polling checks, then delivers their
terminal outcome into a Codex thread through an existing shared app-server.
Its launcher and both `src/` dependencies live together under
`codex-monitor/`; do not copy the launcher by itself.

The source was recovered from an untracked nix2 working tree with no Git
history or configured remote, so its earlier commit provenance is unavailable.

`codex-monitor doctor --deep` is a mutating protocol probe: it creates a test
thread and turn on the selected app-server. Use plain `doctor` for read-only
connectivity checks.

Set `CODEX_MONITOR_CODEX_BIN` to an explicit Codex executable when multiple
installations coexist. The monitor uses that exact binary for `app-server
proxy`; otherwise it resolves `codex` from `PATH`.

Start the standalone-managed shared server and launch receiving TUIs against
it explicitly. The monitor daemon must inherit the same executable selection:

```bash
standalone_codex="$HOME/.local/lib/codex-standalone-bin/codex"
"$standalone_codex" app-server daemon start
CODEX_MONITOR_CODEX_BIN="$standalone_codex" codex-monitor daemon start
"$standalone_codex" --remote unix://
```

These commands are also the post-reboot startup procedure. A regular Codex
session that was not launched with `--remote unix://` is not attached to this
shared server and cannot receive monitor notifications live.

`async-monitor` and `pi-deepseek-websearch` are directories (`index.ts`
entrypoints). `session-id-status`, `tps`, and `work-timer` are single files.
The installer accepts both forms.

## Install everything

```bash
git clone https://github.com/arorashu/agent-stuff.git ~/Work/agent-stuff
cd ~/Work/agent-stuff
./install.sh
```

The installer prints a plan of what will be linked where and asks for
confirmation. Pass `-y` to skip the prompt (required when stdin is not a
terminal). `--dry-run` prints the plan and makes no changes.

With no `--skill` / `--extension`, every skill and extension is installed.

Pi skill and extension links are created when `~/.pi/agent` already exists.
Use `--pi` to create them on a new Pi setup, or `--no-pi` to skip Pi.

## Install only some items

You can copy files, or you can ask the installer for specific names.
They do different things.

### Copy (no clone needed afterwards)

The repository is only a source of files. After the copy, you can delete
it. Updates are manual.

One skill:

```bash
mkdir -p ~/.agents/skills
cp -r skills/article-html ~/.agents/skills/article-html
```

Pi extension examples (Pi must already exist):

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi-extensions/async-monitor ~/.pi/agent/extensions/async-monitor
cp pi-extensions/session-id-status.ts ~/.pi/agent/extensions/session-id-status.ts
cp pi-extensions/tps.ts ~/.pi/agent/extensions/tps.ts
cp pi-extensions/work-timer.ts ~/.pi/agent/extensions/work-timer.ts
cp -r pi-extensions/pi-deepseek-websearch ~/.pi/agent/extensions/pi-deepseek-websearch
```

Optional Pi skill link after a shared-skill copy:

```bash
mkdir -p ~/.pi/agent/skills
ln -s ~/.agents/skills/article-html ~/.pi/agent/skills/article-html
```

### Installer, specific names (symlink into this clone)

The installer links into the clone. `git pull` in the clone updates the
linked files. Moving the clone later breaks the links; rerun the installer
from the new path.

If you pass any `--skill` or `--extension`, **only** the named items are
installed. You can combine and repeat selectors.

```bash
./install.sh --skill article-html
./install.sh --skill async-monitor --skill launch-agents
./install.sh --extension session-id-status.ts
./install.sh --extension tps.ts
./install.sh --extension async-monitor
./install.sh --extension pi-deepseek-websearch
./install.sh --codex-monitor --backup-existing
./install.sh --skill article-html --extension work-timer.ts -y
```

Make does the same selection (`make help` lists the variables):

```bash
make install SKILL=article-html
make install SKILL="async-monitor launch-agents"
make install EXTENSION=session-id-status.ts
make install EXTENSION=tps.ts
make install EXTENSION=pi-deepseek-websearch
make install-skill NAME=launch-agents
make install-extension NAME=tps.ts
make install SKILL=async-monitor ARGS="--dry-run"
```

## What the installer links

```text
~/.agents/skills/<name>        -> <clone>/skills/<name>
~/.pi/agent/skills/<name>      -> ~/.agents/skills/<name>
~/.pi/agent/extensions/<name>  -> <clone>/pi-extensions/<name>
~/.local/bin/codex-monitor     -> <clone>/codex-monitor/bin/codex-monitor.mjs
```

Current Codex builds discover `~/.agents/skills`, so the installer does
not also link under `~/.codex/skills`.

The installer never overwrites existing files or links. Conflicts —
including same-named copies under `~/.codex/skills` — can be moved aside
with `--backup-existing`. Backups go to timestamped `skill-backups/` or
`extension-backups/` siblings, outside the active directories.

```bash
./install.sh --backup-existing
./install.sh --dry-run --backup-existing
```

Exit codes: `0` applied / no-op / declined / dry-run; `1` operational
failure (conflict without `--backup-existing`, or confirmation needed on
non-terminal stdin); `2` invocation error (unknown option or item).

An existing monitor launcher can likewise be moved to a timestamped
`~/.local/bin-backups/` directory with `--backup-existing`.

`make test` runs a hermetic suite in temp directories. It never touches
real agent directories. It requires Bash and [Bun](https://bun.sh/) to execute
the TypeScript extension behavior tests.
