# agent-stuff

Skills, Pi extensions, and command-line tools for coding agents.

## Contents

### Skills

| Skill | Purpose | Requirements |
|---|---|---|
| [article-html](skills/article-html/SKILL.md) | Save a public article as a self-contained HTML file. | Network access; `wl-paste` for clipboard input on Wayland. |
| [async-monitor](skills/async-monitor/SKILL.md) | Run background work and receive completion notices. | The Pi `async-monitor` extension or `codex-monitor`. |
| [launch-agents](skills/launch-agents/SKILL.md) | Start and manage Codex or Pi agents. | The selected agent CLI; tmux for interactive sessions. |
| [task-handoffs](skills/task-handoffs/SKILL.md) | Coordinate assigned workers and reviewers with atomic state and exact-head approvals. | Python 3; an explicit `TASK_STATUS_DIR`; Linux, tmux, and Pi-owned panes for dispatch. |
| [ui-proof-video](skills/ui-proof-video/SKILL.md) | Record and verify continuous video of UI changes. | Browser recording tools; FFmpeg and ffprobe; a connected Google Drive account for Drive delivery. |

### Pi extensions

| Extension | Purpose |
|---|---|
| `async-monitor` | Run commands, periodic checks, and background Pi tasks. Deliver results to the session. |
| [pi-deepseek-websearch](pi-extensions/pi-deepseek-websearch/README.md) | Add a `deepseek_search` tool. Requires a DeepSeek API key. |
| `session-id-status.ts` | Show the session ID in the footer. |
| `tps.ts` | Show the current and average generation speed. |
| `work-timer.ts` | Show work duration and the local completion time. |

These five extensions are available through `install.sh`. Pi must be installed separately.

Two additional search extensions have separate setup instructions:

- [pi-openai-search](pi-extensions/pi-openai-search/README.md): offer hosted search in the current OpenAI Codex request.
- [pi-openai-websearch-tool](pi-extensions/pi-openai-websearch-tool/README.md): add an explicit `openai_search` tool that makes a separate request.

Use only one OpenAI search extension at a time. Search queries go to the selected service provider.

### Command-line tools

| Tool | Purpose | Installation |
|---|---|---|
| [codex-monitor](codex-monitor/README.md) | Run background commands and periodic checks. Deliver results to a Codex thread. | Included in the default installation. Requires Node.js and a compatible Codex app-server. |
| `codexr` | Start a Codex terminal session on a shared local app-server. | Optional: `./install.sh --codex-launcher`. |
| [mpi](tools/mpi/README.md) | Start Pi with persistent, agent-written OptMem notes. | Separate: `python3 tools/mpi/install.py`. Requires Python 3.8+ and Pi. |
| [opi](tools/opi/README.md) | Start Pi with automatic history storage and background summaries. | Separate: `python3 tools/opi/install.py`. Requires Node.js 22+, Python 3.8+, and a supported npm Pi SDK. |

`pi`, `mpi`, and `opi` remain separate commands. The memory launchers store data outside this repository. Read their guides for storage, privacy, and model-call costs.

## Install

The main installer requires Bash and standard Unix command-line tools. Install the requirements for each selected component separately. Add `~/.local/bin` to your PATH to use installed commands.

1. Clone the repository:

   ```bash
   git clone https://github.com/arorashu/agent-stuff.git
   cd agent-stuff
   ```

2. Review the installation plan:

   ```bash
   ./install.sh --dry-run
   ```

3. Install the default components:

   ```bash
   ./install.sh
   ```

The default installation includes all listed skills, the five listed extensions, and `codex-monitor`. It does not include the optional launchers or OpenAI search extensions.

The installer shows the plan and asks for confirmation. Use `-y` to install without a prompt. This option is required when standard input is not a terminal.

Pi links are created only if `~/.pi/agent` exists. Use `--pi` to create links for a new Pi setup. Use `--no-pi` to skip Pi links.

### Select components

If you use any component selector, the installer installs only the selected components. You can combine and repeat selectors.

```bash
./install.sh --skill article-html
./install.sh --skill async-monitor --skill launch-agents
./install.sh --extension session-id-status.ts
./install.sh --extension async-monitor --extension work-timer.ts
./install.sh --extension pi-deepseek-websearch
./install.sh --codex-monitor
./install.sh --codex-launcher
./install.sh --skill article-html --extension work-timer.ts -y
```

Equivalent Make commands are available:

```bash
make install SKILL=article-html
make install SKILL="async-monitor launch-agents"
make install EXTENSION=work-timer.ts
make install SKILL=async-monitor DRY=1
make help
```

### Links, updates, and conflicts

The installer creates symbolic links to this clone:

```text
~/.agents/skills/<name>        -> <clone>/skills/<name>
~/.pi/agent/skills/<name>      -> ~/.agents/skills/<name>
~/.pi/agent/extensions/<name>  -> <clone>/pi-extensions/<name>
~/.local/bin/codex-monitor     -> <clone>/codex-monitor/bin/codex-monitor.mjs
```

Keep the clone in place. Run `git pull` to update linked components. If you move the clone, run the installer again from the new location.

Codex uses `~/.agents/skills`. The installer does not create additional links under `~/.codex/skills`.

The installer refuses to replace conflicting files or links. Use `--backup-existing` to move conflicts to timestamped backup directories before installation. This also handles duplicate skills under `~/.codex/skills`.

```bash
./install.sh --dry-run --backup-existing
./install.sh --backup-existing
```

Backups are stored outside the active skill, extension, or executable directory.

Installer exit codes:

| Code | Meaning |
|---|---|
| `0` | Installation completed, no change was needed, the user declined, or the dry run completed. |
| `1` | Installation failed. Examples: a file conflict or a required confirmation was unavailable. |
| `2` | An option or component name was invalid. |

### Copy files instead of creating links

You can copy a component if you do not want to keep the clone. Updates to copied files are manual.

```bash
mkdir -p ~/.agents/skills
cp -r skills/article-html ~/.agents/skills/article-html

mkdir -p ~/.pi/agent/extensions
cp pi-extensions/work-timer.ts ~/.pi/agent/extensions/work-timer.ts
cp -r pi-extensions/async-monitor ~/.pi/agent/extensions/async-monitor
```

For Pi to use the copied skill, also create its skill link:

```bash
mkdir -p ~/.pi/agent/skills
ln -s ~/.agents/skills/article-html ~/.pi/agent/skills/article-html
```

Copy the complete `codex-monitor/` directory if you install that tool manually. Its executable requires the modules in `src/`.

## Use Codex monitor

Start the shared app-server and the monitor daemon. Then connect the receiving Codex session:

```bash
codex app-server daemon start
codex-monitor daemon start
codex --remote unix://
```

Repeat the daemon start commands after a reboot. A Codex session must connect to the shared server to receive live monitor notices.

If you have multiple Codex installations, set `CODEX_MONITOR_CODEX_BIN` to the executable that owns the shared server.

**Warning:** `codex-monitor doctor --deep` creates a test thread and turn. Use plain `codex-monitor doctor` for a read-only connection check.

See the [Codex monitor guide](codex-monitor/README.md) for commands and delivery limits.

## Use the optional Codex launcher

Install both the launcher and monitor if you need them:

```bash
./install.sh --codex-launcher --codex-monitor
```

Open a new Bash session to load the PATH change. Then run:

```bash
codexr
codexr -- -m MODEL 'Describe this project'
codexr -- resume --last
codexr --help
```

Replace `MODEL` with an available model ID. Put native interactive Codex arguments after the wrapper's `--`.

`codexr` starts the local app-server and monitor daemons, then connects with `--remote unix://`. It does not change approval or sandbox settings. Use native `codex` for noninteractive commands, explicit remote connections, or `--no-daemon`.

By default, the launcher uses `~/.local/lib/codex-standalone-bin/codex`. Set `CODEX_LAUNCHER_STANDALONE_BIN` to use another compatible executable. It must support `--remote` and `app-server daemon start`. Set `CODEX_LAUNCHER_MONITOR_BIN` if the monitor is not at `~/.local/bin/codex-monitor`.

The launcher installer adds `codexr`, `codex-direct`, and `codex-mise` under `~/.local/agent-bin`. It backs up `~/.bashrc` before adding a PATH setup line. Plain `codex` remains unchanged.

`codex-direct` uses the default standalone executable path. `codex-mise` runs Codex through `/usr/bin/mise`. Set `AGENT_BIN_DIR` or `BASHRC_FILE` to change the installation destinations.

## Test

```bash
make test
```

The main suite uses temporary directories. It does not modify your agent configuration. It requires Bash, Python 3, and [Bun](https://bun.sh/).

Component guides describe additional tests and requirements. Run `make test-opi` for the OptChat tests with a supported Pi SDK.

## License

[MIT](LICENSE).
