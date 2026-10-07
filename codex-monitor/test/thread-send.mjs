import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { prepareThreadSend, sendThreadMessage } from "../src/thread-send.mjs";

const flags = (extra = {}) => new Map(Object.entries({ "thread-id": "target", message: "Tests passed.", ...extra }));
const cli = fileURLToPath(new URL("../bin/codex-monitor.mjs", import.meta.url));
const loader = new URL("./fixtures/fake-transport-loader.mjs", import.meta.url).href;
const registration = `import { register } from 'node:module'; register(${JSON.stringify(loader)});`;
const runCli = (...args) => spawnSync(process.execPath, [
  "--import", `data:text/javascript,${encodeURIComponent(registration)}`, cli, ...args,
], { encoding: "utf8", env: { ...process.env, CODEX_APP_SERVER_SOCKET: "/fake/offline/socket" } });

for (const message of ["Tests passed.", "  spacing\nsecond line\r\n", "🚀 résumé", "[Agent: old] body"]) {
  test(`no sender options preserve ${JSON.stringify(message)}`, () => {
    assert.equal(prepareThreadSend(flags({ message })).message, message);
  });
}

test("alias, task, and exact-prefix idempotence", () => {
  assert.equal(prepareThreadSend(flags({ "sender-alias": "monitor-sender" })).message,
    "[Agent: monitor-sender] Tests passed.");
  const options = { "sender-alias": "monitor-sender", "sender-task-id": "job-42" };
  const prefix = "[Agent: monitor-sender | Task: job-42] ";
  assert.equal(prepareThreadSend(flags(options)).message, prefix + "Tests passed.");
  assert.equal(prepareThreadSend(flags({ ...options, message: prefix + "body" })).message, prefix + "body");
  for (const message of ["[Agent: other | Task: job-42] body", "[Agent: monitor-sender | Task: other] body",
    "[Agent: monitor-sender | Task: job-42]body", "intro " + prefix + "body"]) {
    assert.equal(prepareThreadSend(flags({ ...options, message })).message, prefix + message);
  }
});

test("single-line Unicode labels and length boundary", () => {
  assert.equal(prepareThreadSend(flags({ "sender-alias": "réviseur 東京" })).message,
    "[Agent: réviseur 東京] Tests passed.");
  assert.doesNotThrow(() => prepareThreadSend(flags({ "sender-alias": "a".repeat(128) })));
});

for (const name of ["sender-alias", "sender-task-id"]) {
  for (const value of [true, "", " ", " padded", "padded ", "a\nb", "a\rb", "a\tb", "a\0b", "a\x1bb", "a\x7fb",
    "a\x85b", "a\u2028b", "a\u2029b", "a\u202eb", "a\u200bb", "a[b", "a]b", "a|b", "a".repeat(129)]) {
    test(`reject ${name}=${JSON.stringify(value)}`, () => {
      assert.throws(() => prepareThreadSend(flags({ "sender-alias": "valid", [name]: value })), new RegExp(`--${name} must be`));
    });
  }
}

test("task requires alias; required options and wait validation", () => {
  assert.throws(() => prepareThreadSend(flags({ "sender-task-id": "job" })), /requires --sender-alias/);
  for (const [name, value] of [["message", true], ["message", ""], ["thread-id", true], ["thread-id", ""]]) {
    assert.throws(() => prepareThreadSend(flags({ [name]: value })), /requires --thread-id and --message/);
  }
  assert.throws(() => prepareThreadSend(flags({ "wait-ms": "NaN" })), /must be a number/);
  assert.equal(prepareThreadSend(flags()).waitMs, 120000);
});

for (const status of ["completed", "failed", "interrupted", "inProgress", null]) {
  test(`fake transport preserves readback outcome ${status}`, async () => {
    const prepared = prepareThreadSend(flags({ "sender-alias": "worker", "wait-ms": "0" }));
    const requests = [];
    const client = {
      async request(method, params, timeoutMs) {
        requests.push({ method, params, timeoutMs });
        if (method === "turn/start") return { turn: { id: "accepted", status: "inProgress" } };
        assert.equal(method, "thread/turns/list");
        // A different turn ID exercises fallback matching of the actual prefixed payload.
        return { data: status ? [{ id: "readback", status, items: [{ text: prepared.message }] }] : [] };
      },
      async waitForNotification(predicate, timeoutMs) {
        assert.equal(timeoutMs, 0);
        assert.equal(predicate({ method: "turn/completed", params: { threadId: "other", turn: { id: "accepted" } } }), false);
        assert.equal(predicate({ method: "turn/completed", params: { threadId: "target", turn: { id: "other" } } }), false);
        assert.equal(predicate({ method: "turn/completed", params: { threadId: "target", turn: { id: "accepted" } } }), true);
        throw new Error("notification missed");
      },
    };
    const output = await sendThreadMessage(client, prepared);
    assert.deepEqual(requests[0], { method: "turn/start", params: { threadId: "target", input: [{ type: "text", text: prepared.message }] }, timeoutMs: 30000 });
    assert.equal(output.turnId, "accepted");
    assert.equal(output.confirmedStatus, status);
    assert.deepEqual(output.completed, { error: "notification missed" });
    assert.equal(output.readback?.tokenFound ?? false, Boolean(status));
    assert.equal(output.deliveryState, status === "completed" ? "delivered" : status === "failed" || status === "interrupted" ? "failed" : status ? "waiting_turn_completion" : "unconfirmed");
  });
}

test("CLI parser and JSON payload integrate through fake transport", () => {
  for (const senderArgs of [[], ["--sender-alias", "worker"], ["--sender-alias=worker", "--sender-task-id=job"]]) {
    const result = runCli("thread", "send", "--thread-id", "target", "--message", "body", "--wait-ms", "0", "--json", ...senderArgs);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const expected = senderArgs.length === 0 ? "body" : senderArgs.length === 2 && senderArgs[0].includes("=") ? "[Agent: worker | Task: job] body" : "[Agent: worker] body";
    assert.deepEqual(output.start.capturedPayload, { threadId: "target", input: [{ type: "text", text: expected }] });
    assert.equal(output.deliveryState, "delivered");
  }
});

test("CLI rejects malformed sender options before probing socket", () => {
  for (const senderArgs of [["--sender-alias"], ["--sender-alias="], ["--sender-task-id", "job"], ["--sender-alias", "bad\nlabel"], ["--sender-alias", "bad|label"]]) {
    // No loader: failure must come from validation, before any real transport access.
    const result = spawnSync(process.execPath, [cli, "thread", "send", "--thread-id", "target", "--message", "body", ...senderArgs],
      { encoding: "utf8", env: { ...process.env, CODEX_APP_SERVER_SOCKET: "/fake/unreachable/socket", CODEX_MONITOR_CODEX_BIN: "/fake/no-codex" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--sender-(alias|task-id) (must be|requires)/);
    assert.doesNotMatch(result.stderr, /socket|ENOENT|stack/);
  }
});

test("help documents opt-in fields and self-declared identity", () => {
  const result = runCli("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--sender-alias ALIAS/);
  assert.match(result.stdout, /--sender-task-id ID/);
  assert.match(result.stdout, /self-declared label/);
});

test("RPC send rejection propagates without reporting an accepted turn", async () => {
  const error = new Error("turn/start rejected");
  const client = { async request() { throw error; } };
  await assert.rejects(sendThreadMessage(client, prepareThreadSend(flags())), (actual) => actual === error);
});
