# opi: an OptChat harness for Pi

`opi` implements the core architecture from
[Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
using Pi's SDK. It is a separate plain-terminal launcher, not a Pi fork.
`mpi` remains available and unchanged.

| Launcher | Memory behavior |
| --- | --- |
| `pi` | Normal Pi sessions |
| `mpi` | Normal Pi plus agent-written OptMem notes |
| `opi` | Automatic history log, background summary tree, fresh Pi session each user turn |

## Install

Linux or macOS (WSL also works), Node **22+**, Python **3.8+** for installation,
and the npm installation of **Pi 0.87.1** are required. The SDK version is
checked because transcript and extension contracts affect correctness. A
standalone Pi binary is insufficient; opi needs the JavaScript SDK files.

```sh
# If this exact Pi version is not installed already:
npm install -g @earendil-works/pi-coding-agent@0.87.1
# Run pi to configure your model/login before using opi.

git clone https://github.com/arorashu/agent-stuff.git
cd agent-stuff
python3 tools/opi/install.py
export PATH="$HOME/.local/bin:$PATH"
opi --doctor
opi
```

Already cloned? `git pull` and rerun the installer. It copies the application
to `$XDG_DATA_HOME/agent-stuff/opi` (default `~/.local/share/agent-stuff/opi`)
and the launcher to `~/.local/bin/opi`. The clone need not stay in place.
`--bin-dir` changes the launcher destination. Neither installation nor
`--doctor` makes model calls or changes your Pi settings or memories.

If you want to retain another global Pi version, install the SDK separately:

```sh
npm install --prefix "$HOME/.local/share/opi-sdk" @earendil-works/pi-coding-agent@0.87.1
export OPI_PI_ROOT="$HOME/.local/share/opi-sdk/node_modules/@earendil-works/pi-coding-agent"
```

`OPI_PI_ROOT` (or `--pi-root`) points at the package directory, not its executable.
Otherwise opi finds the npm package behind `pi` on PATH.

## Models and use

By default both the main agent and summarizer use the valid default in your
Pi settings. **Summarization makes additional model calls.** Choose a cheaper
competent summarizer explicitly if desired. Model names are exact `provider/id`
values from `pi --list-models`; authentication comes from Pi's usual credential
store or environment. `PI_CODING_AGENT_DIR` selects another Pi config directory.

```sh
opi --model PROVIDER/MAIN_MODEL --compact-model PROVIDER/SUMMARY_MODEL
opi --memory "$HOME/.local/share/optchat-work"
opi --tools read,grep,find,ls --print "What do you remember about this project?"
```

Replace the uppercase example model IDs with real ones. `OPI_COMPACT_MODEL`
can set a persistent summarizer preference. `--thinking` controls the main
agent; the summarizer requests medium effort. `--tools` restricts built-in
tools; memory tools `zoom` and `date` are always present. Otherwise normal
Pi default tools are enabled, with their normal filesystem/shell access.

Each text input starts a fresh Pi session with the memory view and your new
message. Messages typed during a running interactive turn steer Pi at tool
boundaries. Ctrl-C cancels the active turn or summary wait; Ctrl-C at an idle
prompt exits. Accepted but undelivered steering text is retained as unanswered
history. It is not automatically executed after restart.

Commands:

- `/status`: log size, pending summaries, view bytes, and per-process model usage
  (main and compactor separately, including cache read/write tokens and reported cost).
- `/view`: inspect the model's summary view; refuses while summaries are pending.
- `/zoom ID N`: inspect a node; `N=1` prints its exact original message.
- `/date ID`: look up the message timestamp.
- `/flush`: wait for all buildable summaries to finish; Ctrl-C cancels the wait.
- `/exit`: exit; unfinished summaries resume next launch from the durable log.

`--print` / `-p` performs one turn, finishes all pending summaries, prints usage
to stderr, and exits. It can wait indefinitely on repeated summarizer failures;
Ctrl-C cancels it. Errors identify the failing node and retry every 10 seconds.

Pi skills and AGENTS.md context files are loaded, but ordinary Pi extensions,
prompt templates, TUI commands, session continuation, and session switching are
not. Those can depend on a long-lived session or alter the context pipeline.
This launcher is **text-only**; it does not import or archive images or audio.
No subagent orchestrator is included. Work uses Pi's regular built-in tools.

## Storage and recovery

Default history: `$XDG_DATA_HOME/optchat` or `~/.local/share/optchat`.
Override it with `--memory` or `OPI_MEMORY_DIR`. This is separate from mpi's
`~/.local/share/mpi/memory`. Nothing in these directories is committed to this repo.

```text
optchat/
  main/YYYY-MM-DD.jsonl    user text, replies, tool calls, capped tool results
  tree/YYYY-MM-DD.jsonl    immutable binary summaries
  lock                    Unix socket held by the single owning process
```

New directories and logs have private permissions. Each record is appended
and fsynced. Reasoning/thinking blocks are not archived; they remain intact in
the current Pi tool loop. Ordinary tool results are capped at 30,000 Unicode
characters (head and tail, with an explicit truncation marker). The permanent
log therefore contains the capped result, not an unlimited copy of tool output.
User text and final reply text are retained in full.

One process owns a store. A second opi on the same directory refuses to start.
A stale socket after a crash is reclaimed. On recovery, a torn final JSON
record is preserved in a `.torn-*` backup before the incomplete bytes are
removed from the active stream. Interior corruption or inconsistent IDs stop
loading rather than silently losing history. Back up the entire directory
while opi is stopped. Copy it the same way to migrate machines; there is no
cross-machine synchronization, encryption, or automatic backup service.

The main model and summarizer receive chat contents as context. Use a separate
`--memory` for work that should not share history. Deleting the launcher does
not delete history. To uninstall, remove `~/.local/bin/opi` and the installed
`agent-stuff/opi` application directory; keep the separate history if desired.

## What follows the spec

- Append-only log plus a strictly binary tree; summaries target 512 UTF-8 bytes.
- Short inputs and pairs that fit the limit require no model call.
- Context-aware background summarization, up to eight jobs, ordered leaf
  compression, five size attempts, shortest result retained, 10-second retries.
- An incrementally maintained view: append, merge the most overdue available
  sibling pair until within budget, never split. Default **128,000 bytes of
  summary text**, configurable with `--view-bytes`; markup costs extra. This is
  not a guaranteed token count, nor a bound on the entire current tool loop.
- Wait for a fully summarized, under-budget view before a new turn. Freeze it
  before logging the new user message; that new message is sent whole.
- Fresh in-memory Pi session per user turn; `zoom` and `date` retrieve details.
- Keep a stable system prompt and view prefix; disable cache-warming pings.

## Deliberate adaptations and limits

The journal has an extra sequence number so restart can replay the **actual
arrival order** of log entries and asynchronous summary completions. This
preserves the exact incremental view across restarts with the same budget.
Large original messages are retrieved in pages by the model's zoom tool,
with explicit continuation offsets; the terminal `/zoom` prints them whole.
Neither adaptation changes the binary summary structure.

For the direct **Anthropic Messages** adapter, requests get view breakpoints
at line ends before 50k/80k/100k characters and automatic caching at the request
end, at most four breakpoints. The compactor uses the same layout. Other
providers retain Pi's native caching/serialization, with no speculative
provider fields added. A stable prefix helps caching but does not guarantee
a cache hit, supported retention policy, or lower total cost. Measure the
reported usage. Changing models, instructions, tools, or projects can break
prefix reuse. Provider-specific live cache hit rates have not been benchmarked.

The summarizer is a model, so summaries can omit or distort facts. Original
text remaining on disk does not guarantee the agent will find it. The system
asks the model to verify details with zoom; it does not claim infinite recall
or elimination of context degradation. Extremely long individual turns can
still exceed a model's context window; automatic Pi compaction is disabled.
Choose a smaller view for smaller-context models and leave room for tool work.

The source spec also describes optional history import, an HTML browser,
subagent management and computer-use tools. Those are not included here.

## Development checks

```sh
node --test tools/opi/test/core.test.mjs
node --test tools/opi/test/pi.test.mjs
python3 tools/opi/test_install.py
```

Core tests use synthetic summaries. The integration test loads the real Pi
0.87.1 SDK with a local fake provider: it exercises fresh turns, actual zoom
execution, in-turn reasoning preservation, compactor calls and restart recall.
No real model calls or external network requests occur in these tests. Unix
socket creation must be permitted for the store-lock tests.
