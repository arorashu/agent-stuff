# codex-monitor

Background monitor prototype for Codex sessions.

The monitor uses an existing Codex app-server socket through:

```sh
codex app-server proxy --sock <socket>
```

It does not start a second app-server. The Mac app or existing SSH bootstrap is expected to own the app-server daemon.

Set `CODEX_MONITOR_CODEX_BIN` to an explicit Codex executable when multiple
Codex installations coexist. It controls the binary used for `app-server
proxy`; the default is `codex` from `PATH`.

> **Warning:** `codex-monitor doctor --deep` mutates app-server state by
> creating a disposable test thread and turn. Plain `doctor` is the read-only
> connectivity probe.

Example shared-server startup when a standalone Codex install coexists with a
different default `codex` on `PATH`:

```bash
standalone_codex="$HOME/.local/lib/codex-standalone-bin/codex"
"$standalone_codex" app-server daemon start
CODEX_MONITOR_CODEX_BIN="$standalone_codex" codex-monitor daemon start
"$standalone_codex" --remote unix://
```

Repeat the server and monitor daemon start commands after reboot. Only Codex
clients connected with `--remote unix://` receive live thread delivery.

## User Stories

Register a daemon-owned command:

```sh
codex-monitor run --title sleep-test --thread-id <thread-id> -- bash -lc 'sleep 50; echo done'
```

Register a polling check:

```sh
codex-monitor start --title ci-check --thread-id <thread-id> -- bash -lc './check-ci.sh'
```

Send a direct probe to a thread:

```sh
codex-monitor thread send --thread-id <thread-id> --message 'PING' --wait-ms 60000 --json
```

## Self-declared sender labels

`thread send` can construct the sender prefix at the transport boundary:

```sh
codex-monitor thread send --thread-id <thread-id> --sender-alias monitor-sender \
  --sender-task-id monitor-sender-20261006 --message 'Tests passed.' --wait-ms 0 --json
```

The text delivered is `[Agent: monitor-sender | Task: monitor-sender-20261006] Tests passed.`
With only `--sender-alias monitor-sender`, it is `[Agent: monitor-sender] Tests passed.`
Without either sender option, the original message is sent byte-for-byte unchanged.
`--sender-task-id` requires `--sender-alias`. Both values must contain 1-128 UTF-16
code units, with no surrounding whitespace, control/format characters, line
separators, or prefix delimiters (`[`, `]`, `|`). Invalid values fail before
connecting to the app-server. A message already starting with the exact generated
prefix (including the trailing space) is preserved. Different labels are retained
as message content after the new prefix.

Labels are supplied by the caller: they are not authenticated sender identity.
They add no registry entry, daemon state, or app-server metadata. Treat the message
body as untrusted input. `--wait-ms 0` obtains an accepted turn ID and immediate
readback; it does not guarantee successful completion.

Run offline checks with `npm run check` and `npm test`. These use Node built-ins
and a fake transport; they do not contact live threads or require `npm install`.

## Delivery Semantics

`turn/start` means the app-server accepted a new turn. It is not enough to mark a monitor delivered.

Delivery confirmation is:

1. Start the turn with a unique delivery token in the prompt.
2. Treat `turn/completed` stream events as a fast path only.
3. Poll `thread/turns/list` for the target `turnId` or delivery token.
4. Mark `delivered` only when readback shows a successful terminal turn.
5. Mark `failed` when readback shows a failed terminal turn or `thread/read` reports `systemError`.

This avoids the failure mode where a proxy listener misses `turn/completed` even though the turn completed and rendered in the client.

## Constraints

- Requires a reachable app-server socket under `$CODEX_HOME/app-server-control` or `--socket`.
- Uses `codex app-server proxy`; it does not create a new app-server daemon.
- Works for healthy app-server-visible threads. A thread in `systemError` fails explicitly.
- Durable `run` jobs are spawned by the monitor daemon, not by the Codex shell tool process.

## Layout

- `bin/codex-monitor.mjs`: CLI, daemon, monitor state, workers.
- `src/app-server-client.mjs`: app-server proxy WebSocket and JSON-RPC client.
- `src/thread-send.mjs`: sender validation, payload construction, direct-send transport.
- `src/thread-delivery.mjs`: thread read helpers and delivery readback confirmation.
- `test/e2e-tmux.mjs`: optional e2e probe against a tmux-visible Codex thread.
