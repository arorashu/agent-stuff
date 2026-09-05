import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DELIVERY_CLAIM_TTL_MS,
	STARTUP_GRACE_MS,
	STORE_VERSION,
	claimDelivery,
	createJob,
	deliveryPath,
	exclusiveWriteJson,
	getProcessIdentity,
	isSameProcess,
	jobDirFor,
	makeJobId,
	markDelivered,
	readJson,
	readOutputExcerpt,
	sanitizeOutput,
	snapshotJob,
	type JobMetadata,
	type JobResult,
} from "../core.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "async-monitor-test-"));
	roots.push(value);
	return value;
}

function metadata(store: string, overrides: Partial<JobMetadata> = {}): JobMetadata {
	const id = overrides.id ?? makeJobId();
	const dir = jobDirFor(id, store);
	return {
		version: STORE_VERSION,
		id,
		kind: "dispatch",
		label: "test",
		cwd: process.cwd(),
		createdAt: new Date().toISOString(),
		ownerSessionId: "session-a",
		subscribers: ["session-a"],
		outputPath: join(dir, "output.log"),
		prompt: "input",
		command: process.execPath,
		args: ["-e", "process.stdin.resume(); setTimeout(() => process.exit(0), 20)"],
		...overrides,
	};
}

describe("process identity", () => {
	test("captures Linux start ticks and rejects a missing process", async () => {
		const identity = await getProcessIdentity(process.pid);
		expect(identity?.pid).toBe(process.pid);
		expect(identity?.startTicks).toMatch(/^\d+$/);
		expect(await isSameProcess(identity)).toBe(true);
		expect(await isSameProcess({ pid: 2_147_483_647, startTicks: "1" })).toBe(false);
	});
});

describe("job reconciliation", () => {
	test("reports a watched process running and then terminal exactly once", async () => {
		const store = await root();
		const child = spawn("node", ["-e", "setTimeout(() => {}, 150)"], { stdio: "ignore" });
		const watched = await getProcessIdentity(child.pid!);
		const data = metadata(store, { kind: "watch", watchedProcess: watched, command: undefined, args: undefined });
		const dir = await createJob(data, store);
		expect((await snapshotJob(dir)).status).toBe("running");
		await new Promise<void>((resolve) => child.once("close", () => resolve()));
		const first = await snapshotJob(dir);
		const second = await snapshotJob(dir);
		expect(first.status).toBe("completed");
		expect(second.result).toEqual(first.result);
	});

	test("marks an absent dispatch runner lost after startup grace", async () => {
		const store = await root();
		const old = new Date(Date.now() - STARTUP_GRACE_MS - 1_000).toISOString();
		const data = metadata(store, { createdAt: old });
		const dir = await createJob(data, store);
		const snapshot = await snapshotJob(dir);
		expect(snapshot.status).toBe("lost");
		const result = await readJson<JobResult>(join(dir, "result.json"));
		expect(result?.summary).toContain("did not start");
	});
});

describe("exclusive durable commits", () => {
	test("publishes one complete winner under concurrent writes", async () => {
		const store = await root();
		const path = join(store, "winner.json");
		const outcomes = await Promise.all([
			exclusiveWriteJson(path, { winner: "a", payload: "x".repeat(10_000) }),
			exclusiveWriteJson(path, { winner: "b", payload: "y".repeat(10_000) }),
		]);
		expect(outcomes.filter(Boolean)).toHaveLength(1);
		const value = JSON.parse(await readFile(path, "utf8"));
		expect(["a", "b"]).toContain(value.winner);
		expect(value.payload).toHaveLength(10_000);
	});
});

describe("delivery claims", () => {
	test("allows one claimant and persists delivery once", async () => {
		const store = await root();
		const data = metadata(store);
		const dir = await createJob(data, store);
		const path = deliveryPath(dir, "session-a");
		expect(await claimDelivery(dir, "session-a", "one")).toBe(true);
		expect(await claimDelivery(dir, "session-a", "two")).toBe(false);
		expect(await markDelivered(dir, "session-a", "one")).toBe(true);
		const delivered = await readJson<any>(path);
		const inode = (await stat(path)).ino;
		expect(await markDelivered(dir, "session-a", "two")).toBe(false);
		expect(await stat(path)).toMatchObject({ ino: inode });
		expect(await readJson<any>(path)).toEqual(delivered);
		expect(await claimDelivery(dir, "session-a", "one")).toBe(false);
		expect(delivered?.state).toBe("delivered");
	});

	test("reclaims a stale claim only from a different extension instance", async () => {
		const store = await root();
		const data = metadata(store);
		const dir = await createJob(data, store);
		const old = new Date(Date.now() - DELIVERY_CLAIM_TTL_MS - 1_000);
		expect(await claimDelivery(dir, "session-a", "old", old)).toBe(true);
		expect(await claimDelivery(dir, "session-a", "old", new Date())).toBe(false);
		expect(await claimDelivery(dir, "session-a", "new", new Date())).toBe(true);
	});
});

describe("output safety", () => {
	test("strips terminal and bidi controls while preserving text lines", () => {
		const raw = "ok\n\x1b[31mred\x1b[0m\n\x1b]777;notify;bad\x07tail\u202eevil\x00";
		const safe = sanitizeOutput(raw);
		expect(safe).toBe("ok\nred\ntailevil");
		expect(safe).not.toContain("\x1b");
	});

	test("keeps a bounded tail and advertises truncation", async () => {
		const store = await root();
		const path = join(store, "output.log");
		await writeFile(path, Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n"));
		const excerpt = await readOutputExcerpt(path, 1_000, 3);
		expect(excerpt.truncated).toBe(true);
		expect(excerpt.text).toContain("line-19");
		expect(excerpt.text).not.toContain("line-0\n");
		expect(excerpt.shownLines).toBe(3);
	});
});

describe("detached runner", () => {
	test("owns child output and commits one terminal result", async () => {
		const store = await root();
		const data = metadata(store, {
			args: [
				"-e",
				"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{console.log('got:'+s);setTimeout(()=>process.exit(0),50)})",
			],
			prompt: "hello",
		});
		const dir = await createJob(data, store);
		const runnerPath = join(import.meta.dir, "..", "runner.mjs");
		const runner = spawn("node", [runnerPath, "--job", dir], { stdio: "ignore" });
		await new Promise<void>((resolve, reject) => {
			runner.once("error", reject);
			runner.once("close", (code) => code === 0 ? resolve() : reject(new Error(`runner exit ${code}`)));
		});
		const result = await readJson<JobResult>(join(dir, "result.json"));
		expect(result?.status).toBe("completed");
		expect(result?.exitCode).toBe(0);
		expect(await readFile(data.outputPath, "utf8")).toContain("got:hello");
	});

	test("runs a worker-owned command", async () => {
		const store = await root();
		const data = metadata(store, {
			kind: "run",
			command: "/bin/sh",
			args: ["-lc", "echo durable-run"],
			timeoutSeconds: 2,
			prompt: undefined,
		});
		const dir = await createJob(data, store);
		const runner = spawn("node", [join(import.meta.dir, "..", "runner.mjs"), "--job", dir], { stdio: "ignore" });
		await new Promise<void>((resolve, reject) => { runner.once("error", reject); runner.once("close", () => resolve()); });
		const result = await readJson<JobResult>(join(dir, "result.json"));
		expect(result?.status).toBe("completed");
		expect(await readFile(data.outputPath, "utf8")).toContain("durable-run");
	});

	test("times out worker-owned commands", async () => {
		const store = await root();
		const data = metadata(store, {
			kind: "run",
			command: "/bin/sh",
			args: ["-lc", "trap '' TERM; while :; do sleep 1; done"],
			timeoutSeconds: 0.1,
			prompt: undefined,
		});
		const dir = await createJob(data, store);
		const runner = spawn("node", [join(import.meta.dir, "..", "runner.mjs"), "--job", dir], { stdio: "ignore" });
		await new Promise<void>((resolve, reject) => { runner.once("error", reject); runner.once("close", () => resolve()); });
		const result = await readJson<JobResult>(join(dir, "result.json"));
		expect(result?.status).toBe("timeout");
		expect(result?.exitCode).toBe(124);
	});

	test("polls exit 10 until exit 0 fires", async () => {
		const store = await root();
		const counter = join(store, "counter");
		const command = `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; [ $n -lt 3 ] && exit 10; echo fired`;
		const data = metadata(store, {
			kind: "check",
			command: "/bin/sh",
			args: ["-lc", command],
			timeoutSeconds: 3,
			intervalSeconds: 0.1,
			checkTimeoutSeconds: 1,
			prompt: undefined,
		});
		const dir = await createJob(data, store);
		const runner = spawn("node", [join(import.meta.dir, "..", "runner.mjs"), "--job", dir], { stdio: "ignore" });
		await new Promise<void>((resolve, reject) => { runner.once("error", reject); runner.once("close", () => resolve()); });
		const result = await readJson<JobResult>(join(dir, "result.json"));
		expect(result?.status).toBe("completed");
		expect(result?.attempts).toBe(3);
		expect(await readFile(data.outputPath, "utf8")).toContain("fired");
	});

	test("treats exit 20 as terminal polling failure", async () => {
		const store = await root();
		const data = metadata(store, {
			kind: "check", command: "/bin/sh", args: ["-lc", "echo terminal-failure; exit 20"],
			timeoutSeconds: 2, intervalSeconds: 0.1, checkTimeoutSeconds: 1, prompt: undefined,
		});
		const dir = await createJob(data, store);
		const runner = spawn("node", [join(import.meta.dir, "..", "runner.mjs"), "--job", dir], { stdio: "ignore" });
		await new Promise<void>((resolve, reject) => { runner.once("error", reject); runner.once("close", () => resolve()); });
		const result = await readJson<JobResult>(join(dir, "result.json"));
		expect(result?.status).toBe("failed");
		expect(result?.exitCode).toBe(20);
	});

	test("fails after three consecutive per-check timeouts", async () => {
		const store = await root();
		const data = metadata(store, {
			kind: "check", command: "/bin/sh", args: ["-lc", "sleep 5"],
			timeoutSeconds: 2, intervalSeconds: 0.05, checkTimeoutSeconds: 0.05, prompt: undefined,
		});
		const dir = await createJob(data, store);
		const runner = spawn("node", [join(import.meta.dir, "..", "runner.mjs"), "--job", dir], { stdio: "ignore" });
		await new Promise<void>((resolve, reject) => { runner.once("error", reject); runner.once("close", () => resolve()); });
		const result = await readJson<JobResult>(join(dir, "result.json"));
		expect(result?.status).toBe("failed");
		expect(result?.attempts).toBe(3);
	});

	test("times out a polling condition that stays pending", async () => {
		const store = await root();
		const data = metadata(store, {
			kind: "check", command: "/bin/sh", args: ["-lc", "exit 10"],
			timeoutSeconds: 0.8, intervalSeconds: 0.1, checkTimeoutSeconds: 1, prompt: undefined,
		});
		const dir = await createJob(data, store);
		const runner = spawn("node", [join(import.meta.dir, "..", "runner.mjs"), "--job", dir], { stdio: "ignore" });
		await new Promise<void>((resolve, reject) => { runner.once("error", reject); runner.once("close", () => resolve()); });
		const result = await readJson<JobResult>(join(dir, "result.json"));
		expect(result?.status).toBe("timeout");
		expect((result?.attempts ?? 0) >= 2).toBe(true);
	});

	test("cancels the owned process group and records cancellation", async () => {
		const store = await root();
		const data = metadata(store, { args: ["-e", "setInterval(()=>console.log('alive'),20)"] });
		const dir = await createJob(data, store);
		const runnerPath = join(import.meta.dir, "..", "runner.mjs");
		const runner = spawn("node", [runnerPath, "--job", dir], {
			detached: true,
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, PI_ASYNC_MONITOR_RUNNER_DEBUG: "1" },
		});
		let stderr = "";
		runner.stderr.on("data", (data) => stderr += data);
		for (let i = 0; i < 100 && !(await readJson(join(dir, "runner.json"))); i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			runner.once("error", reject);
			runner.once("close", (code, signal) => resolve({ code, signal }));
		});
		process.kill(-runner.pid!, "SIGTERM");
		const outcome = await closed;
		const result = await readJson<JobResult>(join(dir, "result.json"));
		expect({ result: result?.status, outcome, stderr }).toMatchObject({ result: "cancelled", outcome: { signal: null } });
	});
});
