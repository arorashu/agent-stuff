# Validation on 2026-10-04

Tested against the installed Pi 1.0.2 SDK and the real
`openai-codex/gpt-6.1-sol` model, using an existing Pi login.
All synthetic conversations used separate temporary memory, workspace and
Pi configuration directories. Production opi/mpi histories were not test fixtures.

## Real-provider tests

`OPI_LIVE_TEST=1 node tools/opi/test/live-e2e.mjs` passed:

- Default main model and summarizer both selected Codex Sol.
- A long user message triggered real summarizer requests.
- A new process recovered a random phrase containing Japanese characters and
  an exact date by executing `zoom` against the original message.
- Twelve synthetic imported notes forced binary merges under a 2,048-byte view
  budget. A subsequent process recovered the original phrase and distinguished
  the original launch date from a later correction.
- Originals remained intact, summaries were durable, the view was ready and
  within budget, and no ordinary Pi session file was created.

The actual Pi InteractiveMode UI was also exercised in a PTY with real requests:

- Standard editor, streaming response, tool display, model picker and OptChat
  footer rendered; the selected model was Codex Sol.
- First turn saved fictional project details; second turn used `zoom` and
  returned the exact code and date.
- After quitting and restarting, `zoom` recovered both original values again.
- `/memory` displayed isolated-store status; the normal `/model` picker opened.
- The restarted UI showed automatic Pi compaction disabled.

This caught a settings issue: resource reloads discarded compaction overrides,
and Pi's warming getter bypassed overrides. Harness-local getters now preserve
both policies across reloads without modifying saved Pi settings.

## Deterministic regression tests

All 48 checks passed: 15 Node memory/SDK/UI tests, 3 opi installer tests,
24 repository checks and 6 mpi tests. SDK integration tests deliberately use a
fake provider to inspect exact outgoing context, preserve signed reasoning
within a tool loop, and prove prior UI turns are excluded from later requests.
These complement the real-provider tests; they do not replace them.

```sh
node --test tools/opi/test/*.test.mjs
python3 tools/opi/test_install.py
make test
```

On systems without `/bin/bash`, use `make SHELL="$(command -v bash)" test`.

These are functional tests, not a long-history recall or cache-efficiency
benchmark. They do not establish guaranteed retrieval, model reliability over
months of history, or provider cache savings. UI transcript scrollback remains
in process memory; only the history view sent to the model is bounded.
