#!/usr/bin/env node
/** Per-job worker for durable commands and polling checks. */
import { constants as fsConstants, closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const STORE_VERSION = 1;
const CHECK_PENDING = 10;
const CHECK_FAILURE = 20;
const MAX_TRANSIENT_ERRORS = 3;
let jobDir = "";
let metadata;
let child;
let stopping = false;
const debug = (...args) => {
	if (process.env.PI_ASYNC_MONITOR_RUNNER_DEBUG === "1") {
		process.stderr.write(`[async-monitor runner ${process.pid}] ${args.join(" ")}\n`);
	}
};

async function syncDirectory(path) {
	let handle;
	try {
		handle = await open(path, fsConstants.O_RDONLY);
		await handle.sync();
	} finally {
		await handle?.close();
	}
}

async function atomicWriteJson(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	const handle = await open(temp, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temp, path);
		await syncDirectory(dirname(path));
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

async function exclusiveWriteJson(path, value) {
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	const handle = await open(temp, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await link(temp, path);
		await syncDirectory(dirname(path));
		return true;
	} catch (error) {
		if (error?.code === "EEXIST") return false;
		throw error;
	} finally {
		await rm(temp, { force: true });
	}
}

async function processIdentity(pid) {
	try {
		const raw = await readFile(`/proc/${pid}/stat`, "utf8");
		const closeParen = raw.lastIndexOf(")");
		const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
		return { pid, startTicks: fields[19] };
	} catch {
		return { pid };
	}
}

async function writeRunner(extra = {}) {
	await atomicWriteJson(join(jobDir, "runner.json"), {
		...(await processIdentity(process.pid)),
		startedAt: metadata.createdAt,
		...extra,
	});
}

async function finish(status, extra = {}, outputFd = undefined) {
	if (!metadata || !jobDir) return;
	debug("finish", status);
	if (outputFd !== undefined) fsyncSync(outputFd);
	await exclusiveWriteJson(join(jobDir, "result.json"), {
		version: STORE_VERSION,
		jobId: metadata.id,
		status,
		completedAt: new Date().toISOString(),
		...extra,
	});
}

function signalProcess(pid, signal) {
	if (!pid) return;
	try {
		if (process.platform === "win32") process.kill(pid, signal);
		else process.kill(-pid, signal);
	} catch (error) {
		if (error?.code !== "ESRCH") process.stderr.write(`[async-monitor runner] cannot signal process group ${pid}: ${error}\n`);
	}
}

function signalChild(signal) {
	if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
	signalProcess(child.pid, signal);
}

function stopChild(signal) {
	debug("signal", signal, `child=${child?.pid ?? "none"}`);
	stopping = true;
	const pid = child?.pid;
	signalChild(signal);
	if (pid && signal !== "SIGKILL") {
		setTimeout(() => signalProcess(pid, "SIGKILL"), 2_000);
	}
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
	process.on(signal, () => stopChild(signal));
}

function sleepInterruptible(ms) {
	return new Promise((resolveSleep) => {
		const deadline = Date.now() + ms;
		const tick = () => {
			if (stopping || Date.now() >= deadline) resolveSleep();
			else setTimeout(tick, Math.min(250, deadline - Date.now()));
		};
		tick();
	});
}

async function runChild(outputFd, timeoutMs, input = "", attempt = undefined) {
	let resolveOutcome;
	let settled = false;
	let timedOut = false;
	let killTimer;
	let timeoutTimer;
	const outcomePromise = new Promise((resolve) => { resolveOutcome = resolve; });
	const settle = (outcome) => {
		if (settled) return;
		settled = true;
		if (timeoutTimer) clearTimeout(timeoutTimer);
		if (killTimer && !timedOut) clearTimeout(killTimer);
		child = undefined;
		resolveOutcome({ ...outcome, timedOut });
	};
	child = spawn(metadata.command, metadata.args, {
		cwd: metadata.cwd,
		detached: process.platform !== "win32",
		shell: false,
		stdio: [input ? "pipe" : "ignore", outputFd, outputFd],
		windowsHide: true,
	});
	const childPid = child.pid;
	child.once("error", (error) => settle({ error }));
	child.once("close", (exitCode, signal) => settle({ exitCode, signal }));
	if (input) {
		child.stdin?.on("error", (error) => {
			if (error?.code !== "EPIPE") process.stderr.write(`[async-monitor runner] stdin: ${error}\n`);
		});
		child.stdin?.end(input);
	}
	timeoutTimer = setTimeout(() => {
		timedOut = true;
		signalChild("SIGTERM");
		killTimer = setTimeout(() => signalProcess(childPid, "SIGKILL"), 2_000);
	}, Math.max(1, timeoutMs));
	try {
		await writeRunner({ childPid, attempt });
	} catch (error) {
		signalChild("SIGKILL");
		throw error;
	}
	return outcomePromise;
}

async function runOnce(outputFd) {
	const timeoutMs = Math.max(1, Number(metadata.timeoutSeconds ?? 3600) * 1000);
	const outcome = await runChild(outputFd, timeoutMs, metadata.prompt ?? "");
	if (outcome.error) {
		await finish("failed", {
			exitCode: outcome.error.code === "ENOENT" ? 127 : 126,
			summary: `Cannot start command: ${outcome.error.message}`,
		}, outputFd);
	} else if (stopping) {
		await finish("cancelled", { exitCode: outcome.exitCode, signal: outcome.signal, summary: "Cancelled by request." }, outputFd);
	} else if (outcome.timedOut) {
		await finish("timeout", {
			exitCode: 124,
			signal: outcome.signal,
			summary: `Command timed out after ${metadata.timeoutSeconds ?? 3600}s.`,
		}, outputFd);
	} else if (outcome.exitCode === 0) {
		await finish("completed", { exitCode: 0, signal: outcome.signal }, outputFd);
	} else {
		await finish("failed", { exitCode: outcome.exitCode, signal: outcome.signal }, outputFd);
	}
}

async function runCheckLoop(outputFd) {
	const overallMs = Math.max(1, Number(metadata.timeoutSeconds ?? 3600) * 1000);
	const checkMs = Math.max(1, Number(metadata.checkTimeoutSeconds ?? 60) * 1000);
	const intervalMs = Math.max(100, Number(metadata.intervalSeconds ?? 30) * 1000);
	const deadline = new Date(metadata.createdAt).getTime() + overallMs;
	let attempts = 0;
	let consecutiveErrors = 0;

	while (!stopping) {
		if (Date.now() >= deadline) {
			await finish("timeout", { attempts, exitCode: 124, summary: `Polling condition timed out after ${metadata.timeoutSeconds ?? 3600}s.` }, outputFd);
			return;
		}
		attempts += 1;
		writeSync(outputFd, `\n[async-monitor] check attempt ${attempts} at ${new Date().toISOString()}\n`);
		const remainingMs = Math.max(1, deadline - Date.now());
		const outcome = await runChild(outputFd, Math.min(checkMs, remainingMs), "", attempts);

		if (stopping) {
			await finish("cancelled", { attempts, exitCode: outcome.exitCode, signal: outcome.signal, summary: "Cancelled by request." }, outputFd);
			return;
		}
		if (outcome.error) {
			const code = outcome.error.code === "ENOENT" ? 127 : 126;
			await finish("failed", { attempts, exitCode: code, summary: `Cannot start check command: ${outcome.error.message}` }, outputFd);
			return;
		}
		if (outcome.timedOut) {
			consecutiveErrors += 1;
			writeSync(outputFd, `[async-monitor] check timed out after ${metadata.checkTimeoutSeconds ?? 60}s\n`);
		} else if (outcome.exitCode === 0) {
			await finish("completed", { attempts, exitCode: 0, signal: outcome.signal, summary: "Polling condition fired." }, outputFd);
			return;
		} else if (outcome.exitCode === CHECK_PENDING) {
			consecutiveErrors = 0;
		} else if (outcome.exitCode === CHECK_FAILURE) {
			await finish("failed", { attempts, exitCode: CHECK_FAILURE, signal: outcome.signal, summary: "Polling condition reported terminal failure." }, outputFd);
			return;
		} else if (outcome.exitCode === 126 || outcome.exitCode === 127) {
			await finish("failed", { attempts, exitCode: outcome.exitCode, signal: outcome.signal, summary: `Check command exited ${outcome.exitCode}.` }, outputFd);
			return;
		} else {
			consecutiveErrors += 1;
			writeSync(outputFd, `[async-monitor] transient check error exit=${outcome.exitCode} consecutive=${consecutiveErrors}\n`);
		}
		if (consecutiveErrors >= MAX_TRANSIENT_ERRORS) {
			await finish("failed", { attempts, exitCode: outcome.timedOut ? 124 : outcome.exitCode, summary: "Polling check reached three consecutive transient errors." }, outputFd);
			return;
		}
		await sleepInterruptible(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
	}
	await finish("cancelled", { attempts, summary: "Cancelled by request." }, outputFd);
}

process.on("uncaughtException", async (error) => {
	try {
		await finish("failed", { summary: `Worker crashed: ${error?.stack ?? error}` });
	} finally {
		process.exit(1);
	}
});

async function main() {
	const argIndex = process.argv.indexOf("--job");
	if (argIndex < 0 || !process.argv[argIndex + 1]) throw new Error("Usage: runner.mjs --job <job-directory>");
	jobDir = resolve(process.argv[argIndex + 1]);
	metadata = JSON.parse(await readFile(join(jobDir, "metadata.json"), "utf8"));
	if (metadata.version !== STORE_VERSION || !["dispatch", "run", "check"].includes(metadata.kind)) {
		throw new Error(`Unsupported worker-owned job metadata in ${jobDir}`);
	}
	if (!metadata.command || !Array.isArray(metadata.args)) throw new Error("Job has no command/args");
	await writeRunner();
	if (stopping) {
		await finish("cancelled", { summary: "Cancelled before the command started." });
		return;
	}

	const outputFd = openSync(metadata.outputPath, "a", 0o600);
	try {
		if (stopping) {
			await finish("cancelled", { summary: "Cancelled before the command started." });
			return;
		}
		if (metadata.kind === "check") await runCheckLoop(outputFd);
		else await runOnce(outputFd);
	} finally {
		closeSync(outputFd);
	}
}

main().catch(async (error) => {
	try {
		await finish("failed", { summary: error?.stack ?? String(error) });
	} finally {
		process.stderr.write(`[async-monitor runner] ${error?.stack ?? error}\n`);
		process.exitCode = 1;
	}
});
