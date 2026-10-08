// check-watchdog tests: watchdog behavior under failure modes, plus the
// daemon-side classification (imported via the bin entry guard, no CLI main).
// No live app-server is contacted. Every scenario has an independent outer
// deadline; the finally block kills exact owned groups/pids and re-checks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyWatchdogResult } from "../src/check-watchdog.mjs";

const BIN = process.execPath;
const WATCHDOG = fileURLToPath(new URL("../src/check-watchdog.mjs", import.meta.url));
const LINUX_PROC = (() => {
  try {
    readdirSync("/proc");
    return true;
  } catch {
    return false;
  }
})();
const results = [];
let successful = false;
const ownedPids = new Set();
const ownedGroups = new Set();

function trackPid(pid) {
  if (pid) ownedPids.add(pid);
}

function trackGroup(pgid) {
  if (pgid) ownedGroups.add(pgid);
}

function procState(pid) {
  try {
    const raw = readFileSync(join("/proc", String(pid), "stat"), "utf8");
    return raw.split(") ").pop().split(" ")[0];
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie is dead for cleanup purposes.
  return procState(pid) !== "Z";
}

function groupAlive(pgid) {
  if (!LINUX_PROC || !pgid) return false;
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return false;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const raw = readFileSync(join("/proc", name, "stat"), "utf8");
      const parts = raw.split(") ").pop().split(" ");
      if (parts[0] === "Z") continue; // Zombies are not live group members.
      if (parts[2] === String(pgid)) return true;
    } catch (err) {
      // Only entry-vanished I/O errors mean "this process is gone"; any other
      // error (including programming errors) must surface, not masquerade as
      // group absence.
      if (err?.code === "ENOENT" || err?.code === "EACCES" || err?.code === "EPERM") continue;
      throw err;
    }
  }
  return false;
}

// Find live processes whose argv contains the given exact file path AND
// whose parent is the given pid. Scoped to this test run: a wrapper spawned
// by a user daemon or another concurrent test invocation has a different
// parent, so it can neither fail nor be touched by this oracle.
function pidsWithArgvOwnedBy(arg, parentPid) {
  const pids = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let raw;
    try {
      raw = readFileSync(join("/proc", name, "stat"), "utf8");
    } catch (err) {
      if (err?.code === "ENOENT" || err?.code === "EACCES" || err?.code === "EPERM") continue;
      throw err;
    }
    if (raw.split(") ").pop().split(" ")[1] !== String(parentPid)) continue; // index 1 = ppid (0 = state, 2 = pgrp, 3 = session).
    try {
      const argv = readFileSync(join("/proc", name, "cmdline"), "utf8").split("\0").filter(Boolean);
      if (argv.includes(arg)) pids.push(Number(name));
    } catch (err) {
      if (err?.code === "ENOENT" || err?.code === "EACCES" || err?.code === "EPERM") continue;
      throw err;
    }
  }
  return pids;
}

async function waitUntil(check, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`${label}: condition not met within ${timeoutMs}ms`);
}

async function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: exceeded outer deadline ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function runWatchdog(timeoutMs, commandArgs, options = {}) {
  const child = spawn(BIN, [WATCHDOG, String(timeoutMs), ...commandArgs], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const state = { stdout: "", stderr: "", statusLines: [], pending: "", code: null, signal: null };
  child.stdout.setEncoding("latin1"); // 1:1 byte mapping for integrity checks
  child.stdout.on("data", (chunk) => {
    state.stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk;
  });
  const statusStream = child.stdio[3];
  statusStream.setEncoding("utf8");
  statusStream.on("data", (chunk) => {
    state.pending += chunk;
    let idx;
    while ((idx = state.pending.indexOf("\n")) !== -1) {
      const line = state.pending.slice(0, idx).trim();
      state.pending = state.pending.slice(idx + 1);
      if (line) {
        state.statusLines.push(line);
        // Register group ownership as soon as it is reported, not only in
        // scenario bodies, so the finalizer can clean failing paths too.
        try {
          const status = JSON.parse(line);
          if (status?.kind === "spawned") trackGroup(status.pgroup);
        } catch {
          // Non-JSON line; nothing to track.
        }
      }
    }
  });
  const exitPromise = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      state.code = code;
      state.signal = signal;
      resolve(state);
    });
  });
  trackPid(child.pid);
  return { child, state, exit: exitPromise };
}

const finalStatus = (state) => JSON.parse(state.statusLines.at(-1));

try {
  // 1. Exit-code pass-through: no user exit status is reserved.
  for (const code of [0, 10, 20, 3, 124, 143, 253]) {
    const { state, exit } = runWatchdog(5000, [BIN, "-e", `process.exit(${code})`]);
    await withDeadline(exit, 15000, `pass-through ${code}`);
    assert.equal(state.code, code, `watchdog passes through exit ${code}`);
    const status = finalStatus(state);
    assert.equal(status.kind, "exit");
    assert.equal(status.code, code);
    results.push({ test: `pass-through ${code}`, ok: true });
  }

  // 2. Timeout: deadline enforcement plus the referenced KILL escalation.
  {
    const started = Date.now();
    const { state, exit } = runWatchdog(300, ["sleep", "5"]);
    await withDeadline(exit, 15000, "timeout");
    assert.equal(state.code, 124);
    assert.equal(finalStatus(state).kind, "timeout");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1500 && elapsed < 8000, `timeout took ${elapsed}ms (includes 2s escalation)`);
    results.push({ test: "timeout", ok: true, elapsed_ms: elapsed });
  }

  // 3. Spawn errors keep the historical 127/126 mapping with a message.
  {
    const { state, exit } = runWatchdog(2000, ["/nonexistent/diagnostic-fake-codex"]);
    await withDeadline(exit, 15000, "spawn-error-enent");
    assert.equal(state.code, 127);
    const status = finalStatus(state);
    assert.equal(status.kind, "spawn_error");
    assert.equal(status.code, 127);
    assert.ok(status.message.length > 0);
    results.push({ test: "spawn-error-enent", ok: true });
  }
  {
    const dir = mkdtempSync(join(tmpdir(), "cm-wd-nonexec-"));
    const target = join(dir, "plainfile");
    writeFileSync(target, "not executable\n");
    const { state, exit } = runWatchdog(2000, [target]);
    await withDeadline(exit, 15000, "spawn-error-eacces");
    assert.equal(state.code, 126);
    assert.equal(finalStatus(state).kind, "spawn_error");
    rmSync(dir, { recursive: true, force: true });
    results.push({ test: "spawn-error-eacces", ok: true });
  }

  // 4. SIGTERM to the watchdog forwards to the command group and exits 143.
  {
    const { child, state, exit } = runWatchdog(60000, ["sleep", "30"]);
    await waitUntil(() => state.statusLines.length > 0, 3000, "spawned status line");
    const pid = JSON.parse(state.statusLines[0]).pid;
    trackPid(pid);
    trackGroup(pid);
    await new Promise((resolve) => setTimeout(resolve, 200)); // handlers installed
    child.kill("SIGTERM");
    await withDeadline(exit, 15000, "watchdog-sigterm");
    assert.equal(state.code, 143);
    assert.equal(finalStatus(state).kind, "watchdog_signal");
    await waitUntil(() => !isAlive(pid), 4000, "command group reaped after watchdog SIGTERM");
    results.push({ test: "watchdog-sigterm", ok: true });
  }

  // 5a. Leader exits on TERM while a same-group descendant ignores TERM and
  // holds the inherited stdout: escalation must survive the leader's exit.
  // Readiness is synchronized via a marker file written AFTER the descendant
  // installs its TERM handler, so the deadline cannot race handler setup.
  {
    const dir = mkdtempSync(join(tmpdir(), "cm-wd-desc5a-"));
    const readyFile = join(dir, "ready");
    const descendant = `process.on("SIGTERM",()=>{});require("fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)`;
    const { state, exit } = runWatchdog(3000, [
      "bash",
      "-c",
      `node -e ${JSON.stringify(descendant)} ${JSON.stringify(readyFile)} & wait`,
    ]);
    await waitUntil(() => state.statusLines.length > 0, 3000, "spawned status line");
    const pgroup = JSON.parse(state.statusLines[0]).pgroup;
    trackGroup(pgroup);
    await withDeadline(
      waitUntil(() => {
        try {
          return readFileSync(readyFile, "utf8").length > 0;
        } catch {
          return false;
        }
      }, 2500, "descendant TERM handler ready"),
      4000,
      "5a readiness",
    );
    if (LINUX_PROC) {
      assert.ok(groupAlive(pgroup), "positive control: owned group reports alive before the deadline");
    }
    await withDeadline(exit, 15000, "leader-exit inherited-pipe descendant");
    assert.equal(state.code, 124);
    assert.equal(finalStatus(state).kind, "timeout");
    if (LINUX_PROC) {
      await withDeadline(waitUntil(() => !groupAlive(pgroup), 5000, "TERM-ignoring descendant reaped via escalation"), 8000, "5a reaping");
    } else {
      results.push({ test: "leader-exit inherited-pipe descendant", ok: true, group_check: "skipped-no-proc" });
    }
    rmSync(dir, { recursive: true, force: true });
    results.push({ test: "leader-exit inherited-pipe descendant", ok: true });
  }

  // 5b. Same, but the descendant redirects its own streams to /dev/null:
  // the child's pipes close with the leader, so child `close` alone must not
  // cancel the escalation (the exact surviving-orphan reproduction).
  {
    const dir = mkdtempSync(join(tmpdir(), "cm-wd-desc5b-"));
    const readyFile = join(dir, "ready");
    const descendant = `process.on("SIGTERM",()=>{});require("fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)`;
    const { state, exit } = runWatchdog(3000, [
      "bash",
      "-c",
      `node -e ${JSON.stringify(descendant)} ${JSON.stringify(readyFile)} >/dev/null 2>&1 & wait`,
    ]);
    await waitUntil(() => state.statusLines.length > 0, 3000, "spawned status line");
    const pgroup = JSON.parse(state.statusLines[0]).pgroup;
    trackGroup(pgroup);
    await withDeadline(
      waitUntil(() => {
        try {
          return readFileSync(readyFile, "utf8").length > 0;
        } catch {
          return false;
        }
      }, 2500, "descendant TERM handler ready"),
      4000,
      "5b readiness",
    );
    if (LINUX_PROC) {
      assert.ok(groupAlive(pgroup), "positive control: owned group reports alive before the deadline");
    }
    await withDeadline(exit, 15000, "leader-exit redirected-stream descendant");
    assert.equal(state.code, 124);
    assert.equal(finalStatus(state).kind, "timeout");
    if (LINUX_PROC) {
      await withDeadline(waitUntil(() => !groupAlive(pgroup), 5000, "redirected TERM-ignoring descendant reaped via escalation"), 8000, "5b reaping");
    } else {
      results.push({ test: "leader-exit redirected-stream descendant", ok: true, group_check: "skipped-no-proc" });
    }
    rmSync(dir, { recursive: true, force: true });
    results.push({ test: "leader-exit redirected-stream descendant", ok: true });
  }

  // 6. Parent death: the daemon dies while the command writes to both streams.
  // The writer survives its own output EPIPE (handlers) and heartbeats to a
  // file; the watchdog must survive its destination EPIPE, stay alive between
  // parent death and its deadline, and reap the command at the deadline.
  // Sensitivity: with the watchdog's destination error handlers removed, the
  // watchdog dies early and the writer heartbeats past the deadline, failing
  // the post-deadline reaping assertion.
  {
    const dir = mkdtempSync(join(tmpdir(), "cm-parent-death-"));
    const pidfile = join(dir, "ids.json");
    const heartbeat = join(dir, "heartbeat");
    const driverPath = join(dir, "driver.mjs");
    writeFileSync(driverPath, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [watchdogPath, timeoutMs, pidfile, writerCommandJson] = process.argv.slice(2);
const watcher = spawn(process.execPath, [watchdogPath, timeoutMs, ...JSON.parse(writerCommandJson)], {
  stdio: ["ignore", "pipe", "pipe", "pipe"],
});
watcher.stdio[3].setEncoding("utf8");
watcher.stdio[3].on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const status = JSON.parse(trimmed);
      if (status.kind === "spawned") writeFileSync(pidfile, JSON.stringify({ watchdog: watcher.pid, command: status.pid }));
    } catch {}
  }
});
setTimeout(() => process.kill(process.pid, "SIGKILL"), 500);
`);
    const writerScript = `
const fs = require("fs");
const hb = process.argv[1];
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const block = "x".repeat(4096);
let n = 0;
setInterval(() => {
  process.stdout.write(block);
  process.stderr.write(block);
  try { fs.appendFileSync(hb, String(Date.now()) + "\\n"); } catch {}
  n++;
}, 50);
`;
    const writer = [BIN, "-e", writerScript, heartbeat];
    const t0 = Date.now();
    const driver = spawn(BIN, [driverPath, WATCHDOG, "2000", pidfile, JSON.stringify(writer)], { stdio: "ignore" });
    trackPid(driver.pid);
    await withDeadline(
      waitUntil(() => {
        try {
          return readFileSync(pidfile, "utf8").length > 0;
        } catch {
          return false;
        }
      }, 5000, "driver recorded ids"),
      8000,
      "parent-death setup",
    );
    const ids = JSON.parse(readFileSync(pidfile, "utf8"));
    trackPid(ids.watchdog);
    trackPid(ids.command);
    trackGroup(ids.command);
    // Parent died at ~t0+500ms; deadline is t0+2000ms.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const afterParentDeath = Date.now();
    assert.ok(isAlive(ids.watchdog), "watchdog must survive parent death before its deadline");
    assert.ok(isAlive(ids.command), "writer must survive parent death before its deadline");
    const hbLines = readFileSync(heartbeat, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(hbLines.length > 0, "writer heartbeats");
    const lastBeat = Number(hbLines.at(-1));
    assert.ok(lastBeat > afterParentDeath - 150, "writer heartbeat advanced after parent death");
    // At the deadline the watchdog TERM/KILLs the group.
    await withDeadline(waitUntil(() => !isAlive(ids.command), 8000, "writer reaped after deadline"), 12000, "parent-death reaping");
    await withDeadline(waitUntil(() => !isAlive(ids.watchdog), 8000, "watchdog exited after parent death"), 12000, "parent-death watchdog exit");
    rmSync(dir, { recursive: true, force: true });
    results.push({ test: "parent-death-survives", ok: true });
  }

  // 6b. Destination vanishes while the forwarder is PAUSED on backpressure:
  // the watchdog must discard (resume consuming) rather than deadlock or die
  // on EPIPE, and complete with an exit status when the command finishes.
  {
    const dir = mkdtempSync(join(tmpdir(), "cm-paused-dest-"));
    const pidfile = join(dir, "ids.json");
    const driverPath = join(dir, "driver.mjs");
    writeFileSync(driverPath, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [watchdogPath, timeoutMs, pidfile, commandJson] = process.argv.slice(2);
const watcher = spawn(process.execPath, [watchdogPath, timeoutMs, ...JSON.parse(commandJson)], {
  stdio: ["ignore", "pipe", "pipe", "pipe"],
});
watcher.stdio[3].setEncoding("utf8");
watcher.stdio[3].on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const status = JSON.parse(trimmed);
      if (status.kind === "spawned") writeFileSync(pidfile, JSON.stringify({ watchdog: watcher.pid, command: status.pid }));
    } catch {}
  }
});
setTimeout(() => process.kill(process.pid, "SIGKILL"), 500);
`);
    // 30 x 50KB at 100ms: outpaces the 64KB pipe so the forwarder pauses;
    // the parent dies at 500ms, breaking the destination mid-pause.
    const producer = [
      BIN,
      "-e",
      `const b = Buffer.alloc(51200); b.fill(121); let n = 0;
const iv = setInterval(() => { n++; process.stdout.write(b); if (n >= 30) { clearInterval(iv); process.exitCode = 0; } }, 100);`,
    ];
    const t0 = Date.now();
    const driver = spawn(BIN, [driverPath, WATCHDOG, "10000", pidfile, JSON.stringify(producer)], { stdio: "ignore" });
    trackPid(driver.pid);
    await withDeadline(
      waitUntil(() => {
        try {
          return readFileSync(pidfile, "utf8").length > 0;
        } catch {
          return false;
        }
      }, 5000, "driver recorded ids"),
      8000,
      "paused-dest setup",
    );
    const ids = JSON.parse(readFileSync(pidfile, "utf8"));
    trackPid(ids.watchdog);
    trackPid(ids.command);
    trackGroup(ids.command);
    await new Promise((resolve) => setTimeout(resolve, 1000)); // parent dead at ~500ms
    assert.ok(isAlive(ids.watchdog), "watchdog must survive destination EPIPE while paused");
    assert.ok(isAlive(ids.command), "producer still running mid-transfer");
    // The producer finishes at ~3s on its own; the watchdog must complete
    // cleanly (deadline is 10s, so a timeout would have killed the producer
    // late instead), and neither may die from the broken destination.
    await withDeadline(
      waitUntil(() => !isAlive(ids.watchdog), 10000, "watchdog completed after destination vanished"),
      15000,
      "paused-dest completion",
    );
    await waitUntil(() => !isAlive(ids.command), 4000, "producer finished");
    rmSync(dir, { recursive: true, force: true });
    results.push({ test: "destination-vanishes-while-paused", ok: true, t0_elapsed_ms: Date.now() - t0 });
  }

  // 7. Output integrity at the watchdog boundary: full payload plus a stderr
  // tail written immediately before exit.
  {
    const payload = 1024 * 1024;
    const reference = Buffer.alloc(payload);
    for (let i = 0; i < payload; i += 1) reference[i] = i & 0xff;
    const expectedHash = createHash("sha256").update(reference).digest("hex");
    const script = [
      `const b = Buffer.alloc(${payload});`,
      "for (let i = 0; i < b.length; i++) b[i] = i & 0xff;",
      "process.stdout.write(b);",
      "process.stderr.write('tail-marker');",
      "process.exitCode = 0; // natural exit: streams drain before close",
    ].join(";");
    const { state, exit } = runWatchdog(15000, [BIN, "-e", script]);
    await withDeadline(exit, 20000, "output-integrity");
    assert.equal(state.code, 0);
    assert.equal(state.stdout.length, payload, "stdout bytes intact");
    const receivedHash = createHash("sha256").update(Buffer.from(state.stdout, "latin1")).digest("hex");
    assert.equal(receivedHash, expectedHash, "stdout payload byte-exact (sha256)");
    assert.match(state.stderr, /tail-marker/);
    assert.equal(finalStatus(state).kind, "exit");
    results.push({ test: "output-integrity", ok: true, bytes: payload });
  }

  // 7b. Live slow reader: the parent pauses reading while the command writes
  // past the pipe buffer and exits, so the forwarder is paused (and the
  // platform may resume the child's stdio at exit) around completion. Every
  // byte must still arrive: no discarding while the destination is healthy.
  {
    const outPayload = 300 * 1024;
    const errPayload = 300 * 1024;
    const outRef = Buffer.alloc(outPayload);
    for (let i = 0; i < outPayload; i += 1) outRef[i] = (i * 7) & 0xff;
    // stderr is read back as a utf8 string, so its pattern stays ASCII to
    // keep the byte-exact comparison unambiguous.
    const errRef = Buffer.alloc(errPayload);
    for (let i = 0; i < errPayload; i += 1) errRef[i] = (i % 94) + 32;
    const expectedOut = createHash("sha256").update(outRef).digest("hex");
    const expectedErr = createHash("sha256").update(errRef).digest("hex");
    const script = [
      `const ob = Buffer.alloc(${outPayload}); for (let i = 0; i < ob.length; i++) ob[i] = (i * 7) & 0xff;`,
      `const eb = Buffer.alloc(${errPayload}); for (let i = 0; i < eb.length; i++) eb[i] = (i % 94) + 32;`,
      "process.stdout.write(ob);",
      "process.stderr.write(eb);",
      "process.exitCode = 0;",
    ].join(";");
    const { child, state, exit } = runWatchdog(15000, [BIN, "-e", script]);
    // Simulate the slow parent: stop consuming while the command writes and
    // exits, so the watchdog's forwarder sits paused on full pipes.
    child.stdout.pause();
    child.stderr.pause();
    await new Promise((resolve) => setTimeout(resolve, 600));
    child.stdout.resume();
    child.stderr.resume();
    await withDeadline(exit, 20000, "slow-reader forwarding");
    assert.equal(state.code, 0);
    assert.equal(createHash("sha256").update(Buffer.from(state.stdout, "latin1")).digest("hex"), expectedOut, "stdout byte-exact under slow reading");
    assert.equal(Buffer.byteLength(state.stderr), errPayload, "stderr complete under slow reading");
    assert.equal(createHash("sha256").update(Buffer.from(state.stderr, "utf8")).digest("hex"), expectedErr, "stderr byte-exact under slow reading");
    assert.equal(finalStatus(state).kind, "exit");
    results.push({ test: "slow-reader-forwarding", ok: true });
  }

  // 8. classifyWatchdogResult unit table (daemon-side precedence rules).
  {
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "timeout", code: null, signal: "SIGKILL" }, backstopFired: true }),
      { exitCode: 124, timedOut: true, spawnError: null, drainIncomplete: false, protocolFailure: false, rawExitCode: null },
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: 143, signal: null }, backstopFired: false }),
      { exitCode: 143, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: false, rawExitCode: null },
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: 124, signal: null }, backstopFired: false }),
      { exitCode: 124, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: false, rawExitCode: null },
      "literal 124 remains a transient error, not a timeout",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: 0, signal: null }, backstopFired: true }),
      { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: true, protocolFailure: false, rawExitCode: null },
      "early exit status + backstop is an infrastructure failure, never clean success",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: "junk", signal: null }, backstopFired: false }),
      { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: true, rawExitCode: null },
      "malformed exit record is a protocol failure",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: 0, signal: "NOT_A_SIGNAL" }, backstopFired: false }),
      { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: true, rawExitCode: null },
      "unknown signal names are rejected",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: 5, signal: "SIGKILL" }, backstopFired: false }),
      { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: true, rawExitCode: null },
      "contradictory code+signal record is rejected",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: null, signal: "SIGKILL" }, backstopFired: false }),
      { exitCode: 137, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: false, rawExitCode: null },
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: "junk", signal: "SIGKILL" }, backstopFired: false }),
      { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: true, rawExitCode: null },
      "a malformed non-null code is rejected even with a valid signal",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: null, signal: null }, backstopFired: false }),
      { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: true, rawExitCode: null },
      "both-null exit record is rejected, never mapped to a default signal",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: null }, backstopFired: false }),
      { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: true, rawExitCode: null },
      "missing signal with null code is rejected",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: 7, signal: null }, backstopFired: false }),
      { exitCode: 7, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: false, rawExitCode: null },
      "positive control: code-only record accepted",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: null, signal: "SIGSEGV" }, backstopFired: false }),
      { exitCode: 139, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: false, rawExitCode: null },
      "SIGSEGV maps to 139, not another signal's number",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: null, signal: "SIGPIPE" }, backstopFired: false }),
      { exitCode: 141, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: false, rawExitCode: null },
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "exit", code: null, signal: "SIGPROF" }, backstopFired: false }),
      { exitCode: 155, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: false, rawExitCode: null },
      "SIGPROF maps to 155, not SIGTERM's 143",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: null, exitCode: null, signal: "SIGPROF", backstopFired: false }),
      { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: true, rawExitCode: 155 },
      "raw wrapper diagnostics use the true signal number",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "timeout", code: "junk", signal: 77 }, backstopFired: false }),
      { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: true, rawExitCode: null },
      "malformed timeout record is rejected",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "timeout", code: null, signal: "SIGKILL" }, backstopFired: false }),
      { exitCode: 124, timedOut: true, spawnError: null, drainIncomplete: false, protocolFailure: false, rawExitCode: null },
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "spawn_error", code: 0, message: "fake" }, backstopFired: false }),
      { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: true, rawExitCode: null },
      "spawn_error with code 0 is a forged record, not success",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "spawn_error", code: 126, message: "noexec" }, backstopFired: false }),
      { exitCode: 126, timedOut: false, spawnError: "noexec", drainIncomplete: false, protocolFailure: false, rawExitCode: null },
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "watchdog_signal", signal: "SIGTERM" }, backstopFired: true }),
      { exitCode: 124, timedOut: true, spawnError: null, drainIncomplete: false, protocolFailure: false, rawExitCode: null },
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "watchdog_signal", signal: "SIGINT" }, backstopFired: false }),
      { exitCode: 130, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: false, rawExitCode: null },
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "watchdog_signal", signal: "SIGTERM" }, backstopFired: false }),
      { exitCode: 143, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: false, rawExitCode: null },
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: null, exitCode: null, signal: "SIGKILL", backstopFired: true }),
      { exitCode: 124, timedOut: true, spawnError: null, drainIncomplete: false, protocolFailure: false, rawExitCode: null },
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: null, exitCode: 124, signal: null, backstopFired: false }),
      { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: true, rawExitCode: 124 },
      "missing status must not let an ordinary 124 control monitor state",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: null, exitCode: 0, signal: null, backstopFired: false }),
      { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: true, rawExitCode: 0 },
      "missing status must not let an ordinary 0 become success",
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: { kind: "spawn_error", code: 127, message: "nope" }, backstopFired: false }),
      { exitCode: 127, timedOut: false, spawnError: "nope", drainIncomplete: false, protocolFailure: false, rawExitCode: null },
    );
    assert.deepEqual(
      classifyWatchdogResult({ status: "garbage", exitCode: 3, signal: null, backstopFired: false }),
      { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: false, protocolFailure: true, rawExitCode: 3 },
    );
    results.push({ test: "classify-table", ok: true });
  }

  // 9. Daemon integration: runCheckCommand through the real bin module.
  const { runCheckCommand } = await import("../bin/codex-monitor.mjs");
  const cwd = mkdtempSync(join(tmpdir(), "cm-daemon-"));
  {
    const result = await withDeadline(
      runCheckCommand({ command: ["bash", "-c", "exit 20"], cwd, env: process.env, check_timeout_sec: 10 }),
      30000,
      "daemon-integration-exit20",
    );
    assert.equal(result.exitCode, 20);
    assert.equal(result.timedOut, false);
    results.push({ test: "daemon-integration-exit20", ok: true });
  }
  {
    const result = await withDeadline(
      runCheckCommand({ command: ["bash", "-c", "sleep 3"], cwd, env: process.env, check_timeout_sec: 0.5 }),
      30000,
      "daemon-integration-timeout",
    );
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
    assert.match(result.logText, /timed_out=true killed=true/);
    results.push({ test: "daemon-integration-timeout", ok: true });
  }
  {
    const result = await withDeadline(
      runCheckCommand({ command: ["bash", "-c", "exit 124"], cwd, env: process.env, check_timeout_sec: 10 }),
      30000,
      "daemon-integration-literal124",
    );
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, false, "literal 124 is not a timeout");
    results.push({ test: "daemon-integration-literal124", ok: true });
  }
  // A real, non-core-dumping signal must map to its true 128+N value
  // through the actual daemon helper (the reviewer's SIGPROF repro).
  {
    const result = await withDeadline(
      runCheckCommand({ command: ["bash", "-c", "kill -PROF $$"], cwd, env: process.env, check_timeout_sec: 10 }),
      30000,
      "daemon-integration-sigprof",
    );
    assert.equal(result.exitCode, 155, "SIGPROF maps to 155, not SIGTERM's 143");
    assert.equal(result.timedOut, false);
    assert.match(result.logText, /exit=155 signal=SIGPROF/);
    results.push({ test: "daemon-integration-sigprof", ok: true });
  }
  {
    const result = await withDeadline(
      runCheckCommand({ command: ["/nonexistent/diagnostic-fake-codex"], cwd, env: process.env, check_timeout_sec: 10 }),
      30000,
      "daemon-integration-spawn-error",
    );
    assert.equal(result.exitCode, 127);
    assert.match(result.logText, /failed to spawn/);
    results.push({ test: "daemon-integration-spawn-error", ok: true });
  }

  // 9b. Missing final status must not control monitor state: a wrapper that
  // exits 0/10/20/124 without writing a final status record must classify as
  // a non-success infrastructure failure, not success/pending/timeout.
  {
    const fakeStatusDir = mkdtempSync(join(tmpdir(), "cm-fake-status-"));
    const fakeStatusPath = join(fakeStatusDir, "no-status.mjs");
    writeFileSync(fakeStatusPath, `process.exit(Number(process.env.CM_FAKE_EXIT ?? "0"));\n`);
    for (const wrapperExit of [0, 10, 20, 124]) {
      const result = await withDeadline(
        runCheckCommand(
          { command: ["true"], cwd, env: { ...process.env, CM_FAKE_EXIT: String(wrapperExit) }, check_timeout_sec: 10 },
          { watchdogPath: fakeStatusPath },
        ),
        30000,
        `missing-status-${wrapperExit}`,
      );
      assert.equal(result.exitCode, 1, `wrapper exit ${wrapperExit} without status must not control state`);
      assert.equal(result.timedOut, false, `wrapper exit ${wrapperExit} without status is not a timeout`);
      assert.match(result.logText, new RegExp(`protocol_failure=true wrapper_exit=${wrapperExit}`));
    }
    rmSync(fakeStatusDir, { recursive: true, force: true });
    results.push({ test: "daemon-missing-status-no-state-control", ok: true });
  }

  // 9c. Malformed final records must not control monitor state either:
  // forged/contradictory records all classify as infrastructure failures,
  // while a well-formed record still works (positive control).
  {
    const fakeDir = mkdtempSync(join(tmpdir(), "cm-fake-malformed-"));
    const fakePath = join(fakeDir, "malformed.mjs");
    writeFileSync(
      fakePath,
      `import { writeSync } from "node:fs";
try {
  writeSync(3, process.env.CM_RECORD + "\\n");
} catch {}
process.exit(Number(process.env.CM_FAKE_EXIT ?? "0"));
`,
    );
    const cases = [
      ['{"kind":"spawn_error","code":0,"message":"fake"}', 0, 1, /protocol_failure=true wrapper_exit=0/],
      ['{"kind":"exit","code":0,"signal":"SIGKILL"}', 0, 1, /protocol_failure=true wrapper_exit=0/],
      ['{"kind":"timeout","code":"junk","signal":77}', 0, 1, /protocol_failure=true wrapper_exit=0/],
      ['{"kind":"exit","code":"junk","signal":"SIGKILL"}', 0, 1, /protocol_failure=true wrapper_exit=0/],
      ['{"kind":"exit","code":null,"signal":null}', 0, 1, /protocol_failure=true wrapper_exit=0/],
      ['{"kind":"exit","code":0,"signal":null}', 0, 0, /exit=0/],
      ['{"kind":"spawn_error","code":127,"message":"not found"}', 0, 127, /failed to spawn: not found/],
    ];
    for (const [record, wrapperExit, expected, expectedLog] of cases) {
      const result = await withDeadline(
        runCheckCommand(
          { command: ["true"], cwd, env: { ...process.env, CM_RECORD: record, CM_FAKE_EXIT: String(wrapperExit) }, check_timeout_sec: 10 },
          { watchdogPath: fakePath },
        ),
        30000,
        `malformed-record ${record}`,
      );
      assert.equal(result.exitCode, expected, `record ${record} must classify as ${expected}`);
      assert.match(result.logText, expectedLog);
      if (expected !== 0 && expected !== 127) {
        assert.equal(result.timedOut, false);
      }
    }
    rmSync(fakeDir, { recursive: true, force: true });
    results.push({ test: "daemon-malformed-records-no-state-control", ok: true });
  }
  rmSync(cwd, { recursive: true, force: true });

  // 10. Wedged watchdog (ignores the backstop's TERM, reports spawned only):
  // runCheckCommand must still resolve in bounded time and the backstop's
  // independent group kill must reap the command.
  {
    const dir = mkdtempSync(join(tmpdir(), "cm-wedged-"));
    const fakePath = join(dir, "wedged.mjs");
    writeFileSync(fakePath, `
import { spawn } from "node:child_process";
import { writeSync, writeFileSync } from "node:fs";
const [timeoutMs, ...command] = process.argv.slice(2);
const pidfile = new URL("./pid", import.meta.url).pathname;
// Report our own identity so the test harness owns the wrapper too.
writeFileSync(new URL("./wrapper-pid", import.meta.url).pathname, String(process.pid));
const child = spawn(command[0], command.slice(1), { detached: true, stdio: ["ignore", "pipe", "pipe"] });
try {
  writeSync(3, JSON.stringify({ kind: "spawned", pid: child.pid, pgroup: child.pid }) + "\\n");
} catch {}
writeFileSync(pidfile, String(child.pid));
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});
process.on("SIGTERM", () => {}); // wedged: the backstop's TERM does nothing
setInterval(() => {}, 1000);
`);
    const started = Date.now();
    const promise = runCheckCommand(
      { command: ["sleep", "30"], cwd: dir, env: process.env, check_timeout_sec: 0.5 },
      { watchdogPath: fakePath },
    );
    // Register ownership BEFORE awaiting the operation under test, so a
    // deadline failure still leaves identities for the finalizer: the
    // wedged wrapper itself AND the command it spawned.
    await withDeadline(
      waitUntil(() => {
        try {
          return readFileSync(join(dir, "wrapper-pid"), "utf8").trim().length > 0;
        } catch {
          return false;
        }
      }, 10000, "fake reported its own pid"),
      15000,
      "wedged setup",
    );
    const wrapperPid = Number(readFileSync(join(dir, "wrapper-pid"), "utf8").trim());
    trackPid(wrapperPid);
    await withDeadline(
      waitUntil(() => {
        try {
          return readFileSync(join(dir, "pid"), "utf8").trim().length > 0;
        } catch {
          return false;
        }
      }, 10000, "fake reported command pid"),
      15000,
      "wedged setup",
    );
    const orphanPid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
    trackPid(orphanPid);
    trackGroup(orphanPid);
    const result = await withDeadline(promise, 30000, "wedged-watchdog");
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true, "wedged watchdog + backstop classifies as timeout");
    assert.equal(result.exitCode, 124);
    assert.ok(elapsed < 25000, `wedged-watchdog bounded (${elapsed}ms)`);
    await withDeadline(waitUntil(() => !isAlive(orphanPid), 5000, "backstop group kill reaped the command"), 8000, "wedged reaping");
    assert.ok(!isAlive(wrapperPid), "the wedged wrapper itself was killed with its group");
    rmSync(dir, { recursive: true, force: true });
    results.push({ test: "wedged-watchdog-backstop-group-kill", ok: true, elapsed_ms: elapsed });
  }

  // 11. Ownership-oracle controls: the ppid-scoped discovery must find a
  // known directly-owned child with the watchdog path in argv (positive),
  // and must NOT attribute it to a different parent (negative).
  if (LINUX_PROC) {
    const probe = spawn(BIN, ["-e", "setInterval(()=>{},1000)", WATCHDOG], {
      stdio: "ignore",
      detached: true,
    });
    await withDeadline(
      waitUntil(() => pidsWithArgvOwnedBy(WATCHDOG, process.pid).includes(probe.pid), 3000, "owned probe discovered"),
      5000,
      "oracle positive control",
    );
    assert.ok(
      !pidsWithArgvOwnedBy(WATCHDOG, process.pid + 1).includes(probe.pid),
      "a matching-argv process must not be attributed to a different parent",
    );
    try {
      process.kill(-probe.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await withDeadline(waitUntil(() => !isAlive(probe.pid), 3000, "probe reaped"), 5000, "oracle cleanup");
    results.push({ test: "ownership-oracle-controls", ok: true });
  }

  successful = true;
} finally {
  // Terminate only this test's owned groups/pids, even if an assertion
  // failed. Groups first (descendants outlive leaders), then direct pids.
  for (const pgid of ownedGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const pid of ownedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const pgid of ownedGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (LINUX_PROC) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const pgid of ownedGroups) {
      assert.ok(!groupAlive(pgid), `owned group ${pgid} still alive after test cleanup`);
    }
    // No wrapper spawned BY THIS TEST PROCESS from the production watchdog
    // module may remain alive (scoped by parent pid, so unrelated concurrent
    // runs of this checkout cannot false-positive or be touched). Runs in
    // finally so failure paths get the same verification.
    const leaked = pidsWithArgvOwnedBy(WATCHDOG, process.pid);
    for (const pid of leaked) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(pidsWithArgvOwnedBy(WATCHDOG, process.pid).length, 0, `leaked watchdog wrappers: ${leaked.join(",")}`);
  }
}
console.log(JSON.stringify({ successful, results }, null, 2));
if (!successful) process.exitCode = 1;
