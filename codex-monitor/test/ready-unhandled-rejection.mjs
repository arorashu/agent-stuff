// Regression: closing an AppServerClient without ever awaiting `ready` must
// not produce an unhandled rejection. Run under --unhandled-rejections=strict
// so the pre-fix behavior (process crash before the assertions) is
// deterministic. CODEX_MONITOR_CODEX_BIN is set to an executable idle fixture
// by the caller, so a real child process exists and no app-server is contacted.
import assert from "node:assert/strict";
import { AppServerClient } from "../src/app-server-client.mjs";

const client = new AppServerClient({ socket: "/never-used-fake-socket" });
assert.ok(client.proc.pid, "fixture proxy must actually spawn");
await client.close();
const capture = () =>
  new Promise((resolve, reject) => {
    client.ready.then(
      () => reject(new Error("ready resolved; expected rejection")),
      (err) => resolve(err),
    );
  });
const [a, b] = await Promise.all([capture(), capture()]);
assert.ok(a instanceof Error, "rejection is an Error");
assert.match(a.message, /closed before upgrade/);
assert.equal(a, b, "late awaiters receive the same rejection object");
console.log("ready-unhandled-rejection: ok");
