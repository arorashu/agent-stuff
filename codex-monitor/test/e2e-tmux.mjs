#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_BIN = join(ROOT, "bin", "codex-monitor.mjs");

function usage() {
  return `Usage:
  CODEX_MONITOR_E2E_THREAD_ID=<thread-id> [CODEX_MONITOR_E2E_TMUX_TARGET=session:window] node test/e2e-tmux.mjs [--run-monitor]

Environment:
  CODEX_MONITOR_BIN            defaults to this repo's bin/codex-monitor.mjs
  CODEX_MONITOR_E2E_THREAD_ID  required target Codex thread id
  CODEX_MONITOR_E2E_TMUX_TARGET optional tmux target to verify visible rendering
`;
}

function parseArgs(argv) {
  return {
    runMonitor: argv.includes("--run-monitor"),
  };
}

async function runFile(file, args, options = {}) {
  const result = await execFileAsync(file, args, {
    cwd: ROOT,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  return result.stdout;
}

async function runCommand(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: ROOT,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  return result.stdout;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Could not parse ${label} as JSON: ${err.message}\n${text}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sendProbe({ bin, threadId, marker }) {
  const message = `CODEX_MONITOR_E2E_DIRECT ${marker}: reply exactly ${marker}_ACK`;
  const raw = await runFile(bin, [
    "thread",
    "send",
    "--thread-id",
    threadId,
    "--message",
    message,
    "--wait-ms",
    "60000",
    "--json",
  ]);
  const result = parseJson(raw, "thread send output");
  assert(result.threadId === threadId, `send returned unexpected thread id: ${result.threadId}`);
  assert(result.turnId, "send did not return a turn id");
  assert(result.deliveryState === "delivered", `send deliveryState was ${result.deliveryState}`);
  assert(result.confirmedStatus === "completed", `send confirmedStatus was ${result.confirmedStatus}`);
  return { message, result };
}

async function verifyThreadReadback({ bin, threadId, marker }) {
  const raw = await runFile(bin, [
    "thread",
    "turns",
    "--thread-id",
    threadId,
    "--limit",
    "8",
    "--json",
  ]);
  const turns = parseJson(raw, "thread turns output");
  assert(JSON.stringify(turns).includes(marker), `thread readback did not include marker ${marker}`);
  return turns;
}

async function verifyTmuxPane({ tmuxTarget, marker }) {
  if (!tmuxTarget) return null;
  const pane = await runCommand("tmux", ["capture-pane", "-t", tmuxTarget, "-p", "-S", "-300"]);
  assert(pane.includes(marker), `tmux pane ${tmuxTarget} did not include marker ${marker}`);
  return pane;
}

async function waitForMonitor({ bin, id, timeoutMs = 120000 }) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const raw = await runFile(bin, ["status", id, "--json", "--full"]);
    last = parseJson(raw, "monitor status output");
    if (last.delivery_state === "delivered" || last.delivery_state === "failed") {
      return last;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
  }
  throw new Error(`monitor ${id} did not reach terminal delivery state; last=${JSON.stringify(last)}`);
}

async function runMonitorProbe({ bin, threadId, marker }) {
  await runFile(bin, ["daemon", "start"]);
  const runMarker = `${marker}_RUN_DONE`;
  const raw = await runFile(bin, [
    "run",
    "--title",
    `e2e-${marker}`,
    "--thread-id",
    threadId,
    "--timeout",
    "120",
    "--",
    "bash",
    "-lc",
    `sleep 5; echo ${runMarker}`,
  ]);
  const id = raw.match(/registered\s+(\S+)/)?.[1];
  assert(id, `could not parse registered monitor id from:\n${raw}`);
  const status = await waitForMonitor({ bin, id });
  assert(status.monitor_state === "success", `monitor_state was ${status.monitor_state}`);
  assert(status.delivery_state === "delivered", `delivery_state was ${status.delivery_state}`);
  return { id, runMarker, status };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bin = process.env.CODEX_MONITOR_BIN ?? DEFAULT_BIN;
  const threadId = process.env.CODEX_MONITOR_E2E_THREAD_ID;
  const tmuxTarget = process.env.CODEX_MONITOR_E2E_TMUX_TARGET ?? null;
  if (!threadId) {
    process.stderr.write(usage());
    process.exit(2);
  }

  const marker = `CODEX_MONITOR_E2E_${Date.now()}_${randomBytes(3).toString("hex")}`;
  const direct = await sendProbe({ bin, threadId, marker });
  await verifyThreadReadback({ bin, threadId, marker });
  await verifyTmuxPane({ tmuxTarget, marker });

  const output = {
    ok: true,
    marker,
    direct: {
      turnId: direct.result.turnId,
      confirmedStatus: direct.result.confirmedStatus,
      deliveryState: direct.result.deliveryState,
    },
  };

  if (args.runMonitor) {
    const monitor = await runMonitorProbe({ bin, threadId, marker });
    await verifyThreadReadback({ bin, threadId, marker: monitor.runMarker });
    await verifyTmuxPane({ tmuxTarget, marker: monitor.runMarker });
    output.monitor = {
      id: monitor.id,
      monitorState: monitor.status.monitor_state,
      deliveryState: monitor.status.delivery_state,
    };
  }

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message ?? err}\n`);
  process.exit(1);
});
