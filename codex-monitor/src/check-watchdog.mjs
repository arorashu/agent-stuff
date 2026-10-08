#!/usr/bin/env node
// check-watchdog.mjs <timeout-ms> <command> [args...]
//
// Runs the command in its own process group and enforces the deadline even if
// the parent (the monitor daemon) dies: it is a normal, referenced child that
// outlives parent death and cleans up its own command group.
//
// Status channel: the parent opens a fourth pipe (stdio ["ignore","pipe","pipe","pipe"])
// and reads `child.stdio[3]`. This watchdog writes one JSON line per event:
//   {kind:"spawned", pid, pgroup}
//   {kind:"exit", code, signal}
//   {kind:"timeout", code, signal}
//   {kind:"spawn_error", code, message, pid, pgroup}
//   {kind:"watchdog_signal", signal}
// The status channel is authoritative; the process exit code (124 on timeout,
// otherwise the command's mapped code) is diagnostic only: it is never a
// reserved user exit code and never controls monitor state by itself. A
// missing or malformed final record classifies as a protocol failure
// (exitCode 1, protocolFailure true) rather than as the wrapper's code.
// No previously legal command exit status is reserved.
//
// Completion contract: a decisive status is reported only after the watchdog's
// cleanup obligation is complete. In normal completion that is the child's
// `close`. When the deadline fired or the watchdog itself was signaled, the
// KILL escalation must have been attempted first: a same-group descendant can
// ignore SIGTERM, redirect its own streams, and outlive the child, so child
// `close` alone does not establish that the group is gone.
//
// Documented limits: descendants that call setsid()/change process group
// escape group signaling; this watchdog reaps only its direct child.

import { writeSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";

const STATUS_FD = 3;
const MAX_TIMER_MS = 2 ** 31 - 2;
const ESCALATION_MS = 2000;

// Platform-correct signal names/numbers from node:os; used for BOTH record
// validation and numeric mapping, so an accepted name is always mapped to
// its true 128+N value and never substituted with another signal's number.
const OS_SIGNALS = osConstants.signals;

function isKnownSignal(v) {
  return typeof v === "string" && Object.hasOwn(OS_SIGNALS, v);
}

function signalNumber(name) {
  const n = OS_SIGNALS[name];
  return typeof n === "number" ? n : 15; // Unreachable for validated names.
}

export function mappedExitCode(code, signal, timedOut) {
  if (timedOut) return 124;
  if (code !== null && code !== undefined) return code;
  return signal ? 128 + signalNumber(signal) : 1;
}

const SPAWN_ERROR_CODES = new Set([126, 127]);

export function classifyWatchdogResult({ status = null, exitCode = null, signal = null, backstopFired = false }) {
  // Observed wrapper termination, diagnostic only: a missing or malformed
  // final record must never let this control monitor state (0/10/20 would be
  // a false success), so protocol failures report exit 1 and keep the raw
  // status purely for diagnostics.
  const rawExitCode = exitCode !== null ? exitCode : signal !== null ? 128 + signalNumber(signal) : null;
  const base = { drainIncomplete: false, protocolFailure: false, rawExitCode: null };
  const protocol = () => ({
    exitCode: 1,
    timedOut: false,
    spawnError: null,
    drainIncomplete: false,
    protocolFailure: true,
    rawExitCode,
  });
  if (status && typeof status === "object" && typeof status.kind === "string") {
    switch (status.kind) {
      case "timeout": {
        // The values are diagnostic; the shape must still be sane or the
        // record is untrusted.
        if (!(status.code === null || (typeof status.code === "number" && Number.isInteger(status.code)))) return protocol();
        if (!(status.signal === null || isKnownSignal(status.signal))) return protocol();
        return { exitCode: 124, timedOut: true, spawnError: null, ...base };
      }
      case "spawn_error": {
        // Only the ENOACCES/ENOENT codes the emitter can produce; anything
        // else (including 0) is a forged or corrupt record.
        if (!SPAWN_ERROR_CODES.has(status.code) || typeof status.message !== "string") return protocol();
        return { exitCode: status.code, timedOut: false, spawnError: status.message, ...base };
      }
      case "exit": {
        // Node reports exactly one of code or signal. Both fields must be
        // individually well-formed (integer or null code; known-name or null
        // signal) AND at most one may be present; a malformed non-null code
        // is rejected even when the signal is valid.
        const code = status.code;
        const sig = status.signal === undefined ? null : status.signal;
        const codeValid = code === null || (typeof code === "number" && Number.isInteger(code));
        const sigValid = sig === null || isKnownSignal(sig);
        if (!codeValid || !sigValid) return protocol();
        // Exactly one of code/signal must be present: both null (or both
        // non-null) is a contradictory record.
        if ((code === null) === (sig === null)) return protocol();
        if (backstopFired) {
          // The command finished but the watchdog was still draining output
          // when the backstop hard-killed it: the parent received truncated
          // output. Never classify that as a clean success.
          return { exitCode: 1, timedOut: false, spawnError: null, drainIncomplete: true, protocolFailure: false, rawExitCode: null };
        }
        return { exitCode: code !== null ? code : 128 + signalNumber(sig), timedOut: false, spawnError: null, ...base };
      }
      case "watchdog_signal":
        if (backstopFired) return { exitCode: 124, timedOut: true, spawnError: null, ...base };
        if (status.signal === "SIGINT" || status.signal === "SIGTERM") {
          return { exitCode: status.signal === "SIGINT" ? 130 : 143, timedOut: false, spawnError: null, ...base };
        }
        return protocol();
      default:
        break; // Unrecognized kind: fall through to protocol failure.
    }
  }
  // No usable final status (watchdog hard-killed, pipe lost, or record
  // rejected above).
  if (backstopFired) {
    // The deadline passed and the watchdog never reported: treat as timeout.
    return { exitCode: 124, timedOut: true, spawnError: null, ...base };
  }
  return protocol();
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    process.stderr.write("usage: check-watchdog.mjs <timeout-ms> <command> [args...]\n");
    process.exit(2);
  }
  const timeoutMs = Number(args[0]);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    process.stderr.write("check-watchdog: invalid timeout-ms\n");
    process.exit(2);
  }
  const command = args.slice(1);

  let reported = false;
  function report(status) {
    if (reported) return;
    reported = true;
    try {
      writeSync(STATUS_FD, `${JSON.stringify(status)}\n`);
    } catch {
      // Status channel unavailable; the process exit code remains the fallback.
    }
  }

  let timer = null;
  let child;
  try {
    child = spawn(command[0], command.slice(1), { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    report({ kind: "spawn_error", code: 126, message: String(err?.message ?? err), pid: null, pgroup: null });
    process.exit(126);
  }

  let timedOut = false;
  let selfSignal = null;
  let settled = false;
  let childClosed = false;
  let escalationFired = false;
  let escalationTimer = null;
  let exitCode = null;
  let exitSignal = null;
  let spawnError = null;

  // Bounded forwarding: pause the source when the destination write is not
  // accepted, resume on drain, and flush any queued chunks. Chunks are NEVER
  // discarded while the destination is healthy: if a data event arrives
  // while paused (platforms may resume child stdio after child exit), queue
  // it and reassert backpressure instead of dropping bytes. When the
  // destination breaks (parent died), discard: no EPIPE can take this
  // watchdog down, and no backpressure can block the command.
  let outBroken = false;
  let errBroken = false;
  let stdoutPaused = false;
  let stderrPaused = false;
  const pendingOut = [];
  const pendingErr = [];
  function pumpOut() {
    if (outBroken) return;
    while (pendingOut.length > 0) {
      const chunk = pendingOut.shift();
      const ok = process.stdout.write(chunk, () => {});
      if (!ok) {
        stdoutPaused = true;
        try {
          child.stdout.pause();
        } catch {}
        return;
      }
    }
    stdoutPaused = false;
    if (child.stdout.readable) child.stdout.resume();
  }
  function pumpErr() {
    if (errBroken) return;
    while (pendingErr.length > 0) {
      const chunk = pendingErr.shift();
      const ok = process.stderr.write(chunk, () => {});
      if (!ok) {
        stderrPaused = true;
        try {
          child.stderr.pause();
        } catch {}
        return;
      }
    }
    stderrPaused = false;
    if (child.stderr.readable) child.stderr.resume();
  }
  process.stdout.on("drain", pumpOut);
  process.stderr.on("drain", pumpErr);
  process.stdout.on("error", () => {
    outBroken = true;
    pendingOut.length = 0; // Destination gone: discard, and lift the obligation.
    stdoutPaused = false;
    if (child.stdout.readable) child.stdout.resume();
  });
  process.stderr.on("error", () => {
    errBroken = true;
    pendingErr.length = 0;
    stderrPaused = false;
    if (child.stderr.readable) child.stderr.resume();
  });

  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    if (outBroken) return;
    if (stdoutPaused) {
      pendingOut.push(chunk);
      try {
        child.stdout.pause();
      } catch {}
      return;
    }
    const ok = process.stdout.write(chunk, () => {});
    if (!ok) {
      stdoutPaused = true;
      try {
        child.stdout.pause();
      } catch {}
    }
  });
  child.stderr.on("data", (chunk) => {
    if (errBroken) return;
    if (stderrPaused) {
      pendingErr.push(chunk);
      try {
        child.stderr.pause();
      } catch {}
      return;
    }
    const ok = process.stderr.write(chunk, () => {});
    if (!ok) {
      stderrPaused = true;
      try {
        child.stderr.pause();
      } catch {}
    }
  });

  if (child.pid !== undefined && child.pid !== null) {
    try {
      writeSync(STATUS_FD, `${JSON.stringify({ kind: "spawned", pid: child.pid, pgroup: child.pid })}\n`);
    } catch {
      // Status channel unavailable; enforcement still proceeds.
    }
  }

  function killGroup(signalName) {
    if (child.pid === undefined || child.pid === null) return;
    try {
      process.kill(-child.pid, signalName);
    } catch (err) {
      // ESRCH means the group is already gone; anything else is unexpected
      // but must not bypass finalization.
      if (err?.code !== "ESRCH") process.stderr.write(`check-watchdog: group ${signalName} failed: ${err?.message ?? err}\n`);
    }
  }

  function armEscalation() {
    if (escalationTimer) return; // Idempotent: repeated signals do not restart the grace period.
    escalationTimer = setTimeout(() => {
      escalationTimer = null;
      escalationFired = true;
      killGroup("SIGKILL");
      maybeSettle();
    }, ESCALATION_MS);
  }

  function terminate() {
    if (settled) return;
    timedOut = true;
    killGroup("SIGTERM");
    armEscalation();
  }

  function settle() {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (spawnError) {
      report({ kind: "spawn_error", code: spawnError.code, message: spawnError.message, pid: null, pgroup: null });
      process.exitCode = spawnError.code;
      return;
    }
    if (timedOut) {
      report({ kind: "timeout", code: exitCode ?? null, signal: exitSignal ?? null });
      process.exitCode = 124;
      return;
    }
    if (selfSignal !== null) {
      report({ kind: "watchdog_signal", signal: selfSignal });
      process.exitCode = selfSignal === "SIGINT" ? 130 : 143;
      return;
    }
    report({ kind: "exit", code: exitCode ?? null, signal: exitSignal ?? null });
    process.exitCode = mappedExitCode(exitCode, exitSignal, false);
  }

  // Cleanup-case completion requires the KILL escalation to have been
  // attempted: child `close` alone does not prove the group is gone when a
  // descendant ignores SIGTERM (especially one that redirected its own
  // streams, so the child's pipes close with the leader).
  function maybeSettle() {
    if (settled || !childClosed) return;
    if ((timedOut || selfSignal !== null) && !escalationFired) return;
    settle();
  }

  child.on("error", (err) => {
    if (spawnError) return;
    spawnError = { code: err?.code === "ENOENT" ? 127 : 126, message: String(err?.message ?? err) };
    child.stdout?.destroy();
    child.stderr?.destroy();
  });

  child.on("exit", (code, signal) => {
    exitCode = code;
    exitSignal = signal;
  });

  child.on("close", () => {
    childClosed = true;
    clearTimeout(timer); // A finished command cannot still time out.
    maybeSettle();
  });

  timer = setTimeout(terminate, Math.min(timeoutMs, MAX_TIMER_MS));

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      if (settled || selfSignal !== null) return;
      selfSignal = sig;
      killGroup(sig);
      armEscalation();
    });
  }
}
