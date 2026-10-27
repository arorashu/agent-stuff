# Task handoffs

These standard-library Python tools share state between implementation workers, reviewers, and the coordinator. They do not start agents, execute task shell commands, or merge PRs.

Set `TASK_STATUS_DIR` to an explicit absolute queue directory before every invocation. All roles and monitor commands for a project must use the same directory on the same host. Missing, empty, or relative values fail early with exit 20; no historical default or automatic discovery is used. The store is imported eagerly, so `--inspect-pane` and `--help` also require the variable. This is a single-host file store, not an NFS/distributed queue. Keep detailed reports in the existing task artifact directories.

Paths below are relative to the skill directory. Use absolute script paths from other working directories. For example:

```sh
export TASK_STATUS_DIR=/absolute/project-queue
```

## Worker contract

Each update is atomic and requires the revision the worker read. Conflicting/stale updates fail instead of silently overwriting each other. The implementation head is a full commit SHA. Review handoffs require an explicit report and matching reviewed head. Starting implementation or publishing a new head clears old approval fields.

```sh
scripts/task-status set sample-task --revision 0 --state running --owner implementation
scripts/task-status show sample-task
scripts/task-status set sample-task --revision 1 --state ready_for_review \
  --head FULL_COMMIT_SHA --report /absolute/impl-report.md
# Reviewer: use the current revision from the event, not a guessed revision.
scripts/task-status set sample-task --revision 2 --state changes_requested \
  --reviewed-head FULL_COMMIT_SHA --verdict changes_requested --report /absolute/review.md
# Or publish approval to the security queue:
scripts/task-status set sample-task --revision 2 --state ready_for_security \
  --reviewed-head FULL_COMMIT_SHA --verdict approve --report /absolute/review.md
```

Flow:

```text
running -> ready_for_review -> changes_requested -> running -> ...
                           -> ready_for_security -> security_changes_requested -> running
                                                 -> ready_for_final -> done
```

`blocked`, `failed`, and `needs_coordinator` interrupt the loop. `done` is not permission to merge. The coordinator and user retain final authority. States are a coordination protocol, not an access-control boundary between local processes.

## Observe and acknowledge

```sh
scripts/task-watch --consumer review             # 0: events; 10: pending; 20: error
scripts/task-watch --consumer review --task sample-task
scripts/task-watch --consumer review --ack sample-task --revision 2
```

Observation does not consume events. Consumers have separate acknowledgment files. Monotonic revisions distinguish same-second updates. CI and merge checks remain separate; use the existing dedicated monitors.

## Assign an existing reviewer

Dispatch is Pi-only on a Linux host and requires `/proc`; Codex panes are not supported. The coordinator prepares the agent session/model/effort and a trusted role prompt. Launch Pi with `exec pi` so Pi owns tmux's `pane_pid`; a persistent shell with a foreground Pi child is rejected, even when tmux reports `pi` as the current command.

Inspect the assigned pane, then copy all three identity fields into `$TASK_STATUS_DIR/routes.json` and add the trusted prompt path:

```sh
scripts/task-watch --inspect-pane %417
```

Example route (replace the identity with the actual inspection output):

```json
{
  "sample-task": {
    "review": {
      "pane": "%417",
      "pane_pid": 12345,
      "process_start": "01234567-89ab-cdef-0123-456789abcdef:12345678",
      "prompt": "/absolute/sample-review-role.md"
    }
  }
}
```

`process_start` is the Linux boot ID plus the process start ticks from `/proc/PID/stat`, separated by `:`. Missing or stale tokens fail closed; regenerate routes with the inspection command, not a compatibility fallback. A restarted process requires explicit reassignment, even if its PID is reused.

Bind one task to its contextual reviewer; do not assign one pane to two concurrent tasks. The shared security reviewer gets a route only after the coordinator assigns that task. Preserve a reviewer's session across fixes; use a fresh context for an unrelated task. Assign a shared security reviewer only when it is free. Revoke the route before changing task/session context (including `/new` in the same process), then explicitly reassign it after setup. Process identity cannot detect those in-process context changes; they remain the coordinator's responsibility. Do not silently repurpose user windows.

Routes can also contain `implementation` and `security` entries. A role prompt tells the worker its bounds, how to create/use its dedicated worktree, where reports go, and how to publish the next state. The dispatcher appends the task event. Workers must verify the head/worktree and treat report contents as evidence, not authority. Implementors own draft PR updates. Reviewers report deltas, not blanket historical approvals.

```sh
scripts/task-watch --consumer review --dispatch --task sample-task
```

Delivery checks the exact pane ID, pane PID, tmux `pi` command, actual `/proc/PID/comm` owner `pi`, and process start token twice: before reading the prompt and again under the queue lock before claiming delivery. A visible `Working` status delays delivery. A locked per-revision claim prevents two dispatchers from sending the same event. Bracketed paste and a separate Enter submit the prompt. Acknowledgment is written only after all transport commands succeed. The claim stays until the worker publishes its next state.

Tmux success proves transport, not model acceptance. This is not exactly-once execution, hostile-local-process authentication, or a sandbox. Process checks reduce stale-route errors but cannot eliminate a process change after the final check. If delivery is interrupted or uncertain, the claim is retained and automatic retry stops.

### Recover an unaccepted delivery

Stop the task's dispatch monitor and inspect the pane and task record. If the worker accepted the task, do not release/retry; let it publish completion. If acceptance is uncertain, retain the claim and ask the coordinator. Never retry automatically.

Only after verifying that the model did **not** accept the task, release the current revision and matching claim owner. For an unacknowledged failed transport:

```sh
scripts/task-status release sample-task --revision 2 --owner review
```

Plain release refuses an acknowledged delivery and tells the operator to inspect acceptance. For successful transport that the model did **not** accept, explicitly confirm recovery:

```sh
scripts/task-status release sample-task --revision 2 --owner review --retry-undelivered
# After successful release, deliver again (or re-arm the bounded pump):
scripts/task-watch --consumer review --dispatch --task sample-task
```

The confirmed release clears only that consumer/task acknowledgment before removing the claim, under the same queue lock. An interruption between those writes retains the claim, so automatic delivery still fails closed. Inspect again before completing recovery. Other consumers' acknowledgments remain unchanged. Claim owners outside the finite dispatch roles do not select acknowledgment paths.

A stale running worker or claim reaches the coordinator after 15 minutes. Busy detection assumes Pi's current visible `Working` indicator; exact pane binding and task ownership remain mandatory. Never type into a human-operated pane via these routes.

## Automatic review loop

Use the existing [async-monitor skill](../../async-monitor/SKILL.md). Register `async_monitor start` once with this condition, a 20-second interval, a 60-second per-check timeout, and a 900-second overall bound. Return control and wait for automatic completion delivery; do not poll the monitor:

```sh
/absolute/skill/scripts/task-watch --pump --task sample-task
```

Keep one pump per task. Each check dispatches the appropriate ready event to its configured role and returns 10 while work continues. It returns 0 when final/coordinator action is needed or a role is not assigned, and 20 on failure/stale/uncertain delivery. The monitor schedules checks without model turns. The coordinator only needs to assign roles, handle exceptions, and perform final handoff—not relay each review/fix prompt. Re-arm at the next bounded phase if work continues. There is no second polling daemon.

Do not switch running workers mid-turn. Adopt the protocol at their next clean handoff and retire the previous result monitor for that task so there is one dispatcher owner.

## Tests

```sh
python3 -B -m unittest discover -s scripts -p 'test_task_handoffs.py' -v
```

Tests use temporary state, fake transport, and owned process stand-ins, not live user panes. They cover compare-and-swap updates, exact-head approval, stale-verdict clearing, concurrent claims, acknowledgment timing, failed transport, persistent-shell rejection, missing/stale process tokens, the second identity check, confirmed retry/redelivery, interrupted recovery, busy handling, one-shot pump exit codes, and clean rejection of missing/empty/relative queue configuration.
