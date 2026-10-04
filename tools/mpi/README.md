# mpi: Pi with OptMem memory

`mpi` starts your existing Pi with an additional system prompt and a separate
OptMem store. Ordinary `pi` is unchanged. Pi keeps its normal model, login,
extensions, project instructions, and session behavior. All arguments pass
through, for example `mpi --model sonnet`, `mpi -c`, or `mpi "Work on this project"`.

## Install

Requires Python 3.8+, Pi on `PATH`, and Linux or macOS (WSL also works).
Install Pi and configure its model credentials separately.

```sh
git clone https://github.com/arorashu/agent-stuff.git
cd agent-stuff
python3 tools/mpi/install.py
export PATH="$HOME/.local/bin:$PATH"
mpi
```

Add the PATH line to your shell startup file if needed. No alias is required.
The opt-in installer copies the launcher into `~/.local/bin/mpi` and downloads
[OptMem](https://github.com/VictorTaelin/OptMem) at revision
`1fb164cf39028047781f72ac3bb1e5a691c1dcb0`, verifying its SHA-256 before installation.
OptMem is fetched separately, not vendored into this repository. No API calls
or model sessions are started by installation. The clone can be removed afterward.
The main skills/extensions installer does not install mpi.

To update, pull this repository and rerun `python3 tools/mpi/install.py`.
This replaces the launcher and pinned tool, preserving memory. To install
offline, supply `--optmem-source /path/to/memo` from that exact revision.
`--bin-dir /path/to/bin` changes the launcher destination.

## How memory works

At the start of a session, the prompt asks the agent to run `memo wake`.
While working, it records short notes and writes summaries when OptMem asks.
Older notes are progressively summarized; original notes remain searchable
with `recall`, and `zoom` opens a summary's children. This costs model tokens
and tool calls. The agent chooses what to save and must follow the prompt;
the launcher does not automatically archive your conversation or guarantee recall.

By default, the tool and memory live under `~/.local/share/mpi/`:

```text
memo           downloaded tool
memory/        private notes, summaries, and configuration
```

All mpi sessions on a machine share this store, across projects. New stores
use restrictive permissions. Memory contents are never added to this repo.
Notes read by the agent are sent to your configured model provider as context.

Overrides:

| Variable | Purpose |
| --- | --- |
| `XDG_DATA_HOME` | Base data directory, used by both installer and launcher |
| `MPI_MEMORY_DIR` | Separate memory store (created on first launch) |
| `MPI_MEMO` | Alternative OptMem script path |

The launcher sets `MEMORY_DIR` for Pi and its tools, overriding any inherited
OptMem store selection. Use `MPI_MEMORY_DIR` to choose a different store.
Relative paths resolve from your current directory; absolute paths are best
for memory that should persist across projects.

Install on each machine using the same commands. Memories start independently;
to move them, copy the entire `memory/` directory while sessions are stopped.
There is no built-in cross-machine synchronization. Do not concurrently edit
one store through a file-sync service; local locking does not coordinate machines.

Try it by telling mpi a distinctive preference, asking it to remember it, then
exiting and starting a fresh `mpi` session (without `-c`). Ask what it remembers.
Inspect `memory/LOG.txt` to see exactly what was recorded.

Uninstall by removing `~/.local/bin/mpi` and the downloaded `memo` file.
Keep `memory/` if you want to retain the experiment's notes.
