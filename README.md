# agent-stuff

Reusable agent skills and Pi extensions in one repository.

This repository holds the skill instructions and extension code. It does
not install the external CLIs those skills describe.

## Skills

| Skill | Purpose | External dependency |
|---|---|---|
| `article-html` | Turn a public web article into a self-contained reader HTML file with no banners or subscribe chrome | Network fetch (Jina reader first); clipboard `wl-paste` on this machine |
| `async-monitor` | Register durable commands and asynchronous checks without polling from the agent | This repository's `async-monitor` Pi extension and/or a separately installed `codex-monitor` |
| `launch-agents` | Choose and operate built-in, headless, or tmux-based Codex and Pi agents | The agent CLIs being used; tmux for interactive sessions |

## Pi extensions

| Extension | Purpose | Requirement |
|---|---|---|
| `async-monitor` | Run durable commands, polling checks, and detached Pi tasks with automatic session delivery | Node.js; Pi |
| `pi-deepseek-websearch` | Register a `deepseek_search` tool that runs DeepSeek's server-side web search | DeepSeek key (`/login` or `DEEPSEEK_API_KEY`); Pi |
| `tps` | Show current and session-average generation speed in Pi's footer | Pi |
| `work-timer` | Show live and final agent work duration in Pi's footer | Pi |

`async-monitor` and `pi-deepseek-websearch` are directories (`index.ts`
entrypoints). `tps` and `work-timer` are single files. The installer accepts
both forms.

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

One Pi extension (Pi must already exist):

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi-extensions/async-monitor ~/.pi/agent/extensions/async-monitor
cp pi-extensions/tps.ts ~/.pi/agent/extensions/tps.ts
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
./install.sh --extension tps.ts
./install.sh --extension async-monitor
./install.sh --extension pi-deepseek-websearch
./install.sh --skill article-html --extension work-timer.ts -y
```

Make does the same selection (`make help` lists the variables):

```bash
make install SKILL=article-html
make install SKILL="async-monitor launch-agents"
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

`make test` runs a hermetic suite in temp directories. It never touches
real agent directories.
