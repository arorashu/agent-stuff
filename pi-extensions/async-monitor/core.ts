import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	access,
	chmod,
	link,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const STORE_VERSION = 1;
export const STARTUP_GRACE_MS = 15_000;
export const DELIVERY_CLAIM_TTL_MS = 60_000;
export const DEFAULT_POLL_MS = 1_000;
export const GC_GRACE_MS = 24 * 60 * 60 * 1_000;
export const TMP_STALE_MS = 60 * 60 * 1_000;
export const NOTIFICATION_MAX_BYTES = 12 * 1024;
export const NOTIFICATION_MAX_LINES = 200;
export const TOOL_MAX_BYTES = 50 * 1024;
export const TOOL_MAX_LINES = 2_000;

export type JobKind = "dispatch" | "run" | "check" | "watch";
export type TerminalStatus = "completed" | "failed" | "timeout" | "cancelled" | "lost";
export type JobStatus = "starting" | "running" | TerminalStatus;

export interface ProcessIdentity {
	pid: number;
	startTicks?: string;
}

export interface JobMetadata {
	version: 1;
	id: string;
	kind: JobKind;
	label: string;
	cwd: string;
	createdAt: string;
	ownerSessionId: string;
	subscribers: string[];
	outputPath: string;
	prompt?: string;
	model?: string;
	thinking?: string;
	command?: string;
	args?: string[];
	timeoutSeconds?: number;
	intervalSeconds?: number;
	checkTimeoutSeconds?: number;
	watchedProcess?: ProcessIdentity;
}

export interface RunnerState extends ProcessIdentity {
	startedAt: string;
	childPid?: number;
	attempt?: number;
}

export interface JobResult {
	version: 1;
	jobId: string;
	status: TerminalStatus;
	completedAt: string;
	exitCode?: number | null;
	signal?: string | null;
	summary?: string;
	attempts?: number;
}

export interface JobSnapshot {
	dir: string;
	metadata: JobMetadata;
	status: JobStatus;
	result?: JobResult;
	runner?: RunnerState;
	acknowledged: boolean;
}

export interface OutputExcerpt {
	text: string;
	truncated: boolean;
	totalBytes: number;
	shownBytes: number;
	totalLines: number;
	shownLines: number;
}

export interface DeliveryReceipt {
	state: "claimed" | "delivered";
	instanceId: string;
	updatedAt: string;
}

/** Strip terminal escapes, C0 controls (except tab/newline), and bidi controls. */
export function sanitizeOutput(value: string): string {
	return value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\][\s\S]*$/g, "")
		.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
		.replace(/\x1b(?:[@-_]|\([^)]?)/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
		.replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

function safeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

export function getStoreRoot(): string {
	return process.env.PI_ASYNC_MONITOR_DIR
		? resolve(process.env.PI_ASYNC_MONITOR_DIR)
		: join(homedir(), ".pi", "agent", "async-monitor");
}

export function getJobsRoot(storeRoot = getStoreRoot()): string {
	return join(storeRoot, "jobs");
}

function storeRootFromJobDir(jobDir: string): string {
	return dirname(dirname(jobDir));
}

function pendingDir(sessionId: string, storeRoot = getStoreRoot()): string {
	return join(storeRoot, "sessions", safeSegment(sessionId), "pending");
}

export function pendingMarkerPath(sessionId: string, jobId: string, storeRoot = getStoreRoot()): string {
	return join(pendingDir(sessionId, storeRoot), jobId);
}

export async function enqueuePending(sessionId: string, jobId: string, storeRoot = getStoreRoot()): Promise<void> {
	assertJobId(jobId);
	const path = pendingMarkerPath(sessionId, jobId, storeRoot);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	try {
		await writeFile(path, "", { flag: "wx", mode: 0o600 });
	} catch (error: any) {
		if (error?.code !== "EEXIST") throw error;
	}
}

export async function dequeuePending(sessionId: string, jobId: string, storeRoot = getStoreRoot()): Promise<void> {
	try {
		await unlink(pendingMarkerPath(sessionId, jobId, storeRoot));
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}
}

export async function ensureStore(storeRoot = getStoreRoot()): Promise<string> {
	const jobsRoot = getJobsRoot(storeRoot);
	await mkdir(storeRoot, { recursive: true, mode: 0o700 });
	await chmod(storeRoot, 0o700);
	await mkdir(jobsRoot, { recursive: true, mode: 0o700 });
	await chmod(jobsRoot, 0o700);
	return jobsRoot;
}

export function makeJobId(now = Date.now()): string {
	return `${now.toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function assertJobId(id: string): void {
	if (!/^[a-z0-9]+-[a-f0-9]{8}$/.test(id)) throw new Error(`Invalid async job id: ${id}`);
}

export function jobDirFor(id: string, storeRoot = getStoreRoot()): string {
	assertJobId(id);
	return join(getJobsRoot(storeRoot), id);
}

async function syncDirectory(path: string): Promise<void> {
	let handle;
	try {
		handle = await open(path, fsConstants.O_RDONLY);
		await handle.sync();
	} catch (error: any) {
		// Directory fsync is not supported on every platform. Linux supports it.
		if (process.platform === "linux") throw error;
	} finally {
		await handle?.close();
	}
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
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

/** Create an all-or-nothing JSON file without replacing a competing writer. */
export async function exclusiveWriteJson(path: string, value: unknown): Promise<boolean> {
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
		// Same-directory hard linking is atomic and fails with EEXIST without
		// exposing a partially written final path.
		await link(temp, path);
		await syncDirectory(dirname(path));
		return true;
	} catch (error: any) {
		if (error?.code === "EEXIST") return false;
		throw error;
	} finally {
		await rm(temp, { force: true });
	}
}

export async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function getProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const raw = await readFile(`/proc/${pid}/stat`, "utf8");
		const closeParen = raw.lastIndexOf(")");
		if (closeParen < 0) return { pid };
		const fieldsAfterComm = raw.slice(closeParen + 2).trim().split(/\s+/);
		// fieldsAfterComm[0] is field 3 (state); field 22 (starttime) is index 19.
		return { pid, startTicks: fieldsAfterComm[19] };
	} catch (error: any) {
		if (error?.code === "ENOENT" || error?.code === "ESRCH") return undefined;
		try {
			process.kill(pid, 0);
			return { pid };
		} catch (killError: any) {
			if (killError?.code === "EPERM") return { pid };
			return undefined;
		}
	}
}

export async function isSameProcess(identity: ProcessIdentity | undefined): Promise<boolean> {
	if (!identity) return false;
	const current = await getProcessIdentity(identity.pid);
	if (!current) return false;
	if (identity.startTicks && current.startTicks) return identity.startTicks === current.startTicks;
	return true;
}

export async function createJob(metadata: JobMetadata, storeRoot = getStoreRoot()): Promise<string> {
	if (metadata.version !== STORE_VERSION) throw new Error(`Unsupported async-monitor version: ${metadata.version}`);
	assertJobId(metadata.id);
	const jobsRoot = await ensureStore(storeRoot);
	const dir = join(jobsRoot, metadata.id);
	await mkdir(dir, { mode: 0o700 });
	await mkdir(join(dir, "deliveries"), { mode: 0o700 });
	await writeFile(join(dir, "output.log"), "", { flag: "wx", mode: 0o600 });
	await atomicWriteJson(join(dir, "metadata.json"), metadata);
	for (const sessionId of metadata.subscribers) await enqueuePending(sessionId, metadata.id, storeRoot);
	return dir;
}

export async function writeResult(jobDir: string, result: JobResult): Promise<boolean> {
	return exclusiveWriteJson(join(jobDir, "result.json"), result);
}

function lostResult(metadata: JobMetadata, summary: string, now: Date): JobResult {
	return {
		version: STORE_VERSION,
		jobId: metadata.id,
		status: "lost",
		completedAt: now.toISOString(),
		summary,
	};
}

export async function snapshotJob(jobDir: string, now = new Date()): Promise<JobSnapshot> {
	const metadata = await readJson<JobMetadata>(join(jobDir, "metadata.json"));
	if (!metadata) throw new Error(`Missing metadata: ${jobDir}`);
	const acknowledged = Boolean(await readJson(join(jobDir, "acknowledged.json")));
	let result = await readJson<JobResult>(join(jobDir, "result.json"));
	const runner = await readJson<RunnerState>(join(jobDir, "runner.json"));

	if (result) return { dir: jobDir, metadata, runner, result, status: result.status, acknowledged };

	if (metadata.kind === "watch") {
		if (await isSameProcess(metadata.watchedProcess)) {
			return { dir: jobDir, metadata, status: "running", acknowledged };
		}
		result = {
			version: STORE_VERSION,
			jobId: metadata.id,
			status: "completed",
			completedAt: now.toISOString(),
			summary: "Watched process exited; its exit status is unavailable because async-monitor did not own it.",
		};
		await writeResult(jobDir, result);
		result = (await readJson<JobResult>(join(jobDir, "result.json"))) ?? result;
		return { dir: jobDir, metadata, result, status: result.status, acknowledged };
	}

	if (runner && (await isSameProcess(runner))) {
		return { dir: jobDir, metadata, runner, status: "running", acknowledged };
	}

	const age = now.getTime() - new Date(metadata.createdAt).getTime();
	if (!runner && Number.isFinite(age) && age < STARTUP_GRACE_MS) {
		return { dir: jobDir, metadata, status: "starting", acknowledged };
	}

	result = lostResult(
		metadata,
		runner
			? "The detached runner disappeared without recording a result. Inspect output.log for partial output."
			: "The detached runner did not start within the startup grace period.",
		now,
	);
	await writeResult(jobDir, result);
	result = (await readJson<JobResult>(join(jobDir, "result.json"))) ?? result;
	return { dir: jobDir, metadata, runner, result, status: result.status, acknowledged };
}

export async function listJobs(storeRoot = getStoreRoot(), now = new Date()): Promise<JobSnapshot[]> {
	const jobsRoot = await ensureStore(storeRoot);
	const entries = await readdir(jobsRoot, { withFileTypes: true });
	const snapshots: JobSnapshot[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^[a-z0-9]+-[a-f0-9]{8}$/.test(entry.name)) continue;
		try {
			snapshots.push(await snapshotJob(join(jobsRoot, entry.name), now));
		} catch (error) {
			console.error(`[async-monitor] skipping corrupt job ${entry.name}:`, error);
		}
	}
	return snapshots.sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt));
}

export async function listPendingJobs(
	sessionId: string,
	storeRoot = getStoreRoot(),
	now = new Date(),
): Promise<JobSnapshot[]> {
	let names: string[] = [];
	try {
		names = await readdir(pendingDir(sessionId, storeRoot));
	} catch (error: any) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	const snapshots: JobSnapshot[] = [];
	for (const name of names) {
		if (!/^[a-z0-9]+-[a-f0-9]{8}$/.test(name)) continue;
		try {
			snapshots.push(await snapshotJob(jobDirFor(name, storeRoot), now));
		} catch {
			await dequeuePending(sessionId, name, storeRoot);
		}
	}
	return snapshots.sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt));
}

export async function gcJobs(
	storeRoot = getStoreRoot(),
	now = new Date(),
	graceMs = GC_GRACE_MS,
): Promise<number> {
	const jobsRoot = await ensureStore(storeRoot);
	const entries = await readdir(jobsRoot, { withFileTypes: true });
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^[a-z0-9]+-[a-f0-9]{8}$/.test(entry.name)) continue;
		const jobDir = join(jobsRoot, entry.name);
		await removeStaleDeliveryFiles(jobDir);
		const result = await readJson<JobResult>(join(jobDir, "result.json"));
		const metadata = await readJson<JobMetadata>(join(jobDir, "metadata.json"));
		if (!result || !metadata) continue;
		const completed = Date.parse(result.completedAt);
		if (!Number.isFinite(completed) || now.getTime() - completed < graceMs) continue;
		let delivered = true;
		for (const sessionId of metadata.subscribers) {
			const receipt = await readJson<DeliveryReceipt>(deliveryPath(jobDir, sessionId));
			if (receipt?.state !== "delivered") {
				delivered = false;
				break;
			}
		}
		if (!delivered) continue;
		await rm(jobDir, { recursive: true, force: true });
		for (const sessionId of metadata.subscribers) await dequeuePending(sessionId, metadata.id, storeRoot);
		removed += 1;
	}
	return removed;
}

export async function reconcileSession(
	sessionId: string,
	storeRoot = getStoreRoot(),
	now = new Date(),
	graceMs = GC_GRACE_MS,
): Promise<void> {
	await gcJobs(storeRoot, now, graceMs);
	const jobs = await listJobs(storeRoot, now);
	const live = new Set<string>();
	for (const job of jobs) {
		if (!job.metadata.subscribers.includes(sessionId)) continue;
		live.add(job.metadata.id);
		const receipt = await readJson<DeliveryReceipt>(deliveryPath(job.dir, sessionId));
		if (receipt?.state === "delivered") await dequeuePending(sessionId, job.metadata.id, storeRoot);
		else await enqueuePending(sessionId, job.metadata.id, storeRoot);
	}
	let names: string[] = [];
	try {
		names = await readdir(pendingDir(sessionId, storeRoot));
	} catch (error: any) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	for (const name of names) {
		if (!live.has(name)) await dequeuePending(sessionId, name, storeRoot);
	}
}

export async function readOutputExcerpt(
	path: string,
	maxBytes = TOOL_MAX_BYTES,
	maxLines = TOOL_MAX_LINES,
): Promise<OutputExcerpt> {
	let data: Buffer;
	try {
		data = await readFile(path);
	} catch (error: any) {
		if (error?.code === "ENOENT") data = Buffer.alloc(0);
		else throw error;
	}
	const totalBytes = data.byteLength;
	const allText = data.toString("utf8");
	const totalLines = allText.length === 0 ? 0 : allText.split("\n").length;
	let shown = data.byteLength > maxBytes ? data.subarray(data.byteLength - maxBytes) : data;
	let text = shown.toString("utf8");
	// Drop a partial UTF-8 replacement/line at the head after byte truncation.
	if (shown.byteOffset > data.byteOffset) {
		const newline = text.indexOf("\n");
		if (newline >= 0) text = text.slice(newline + 1);
	}
	let lines = text.split("\n");
	if (lines.length > maxLines) lines = lines.slice(lines.length - maxLines);
	text = lines.join("\n");
	const shownBytes = Buffer.byteLength(text);
	const shownLines = text.length === 0 ? 0 : lines.length;
	return {
		text,
		truncated: shownBytes < totalBytes || shownLines < totalLines,
		totalBytes,
		shownBytes,
		totalLines,
		shownLines,
	};
}

export function deliveryPath(jobDir: string, sessionId: string): string {
	return join(jobDir, "deliveries", `${safeSegment(sessionId)}.json`);
}

export async function markDelivered(
	jobDir: string,
	sessionId: string,
	instanceId: string,
): Promise<boolean> {
	const path = deliveryPath(jobDir, sessionId);
	const already = (await readJson<DeliveryReceipt>(path))?.state === "delivered";
	if (!already) {
		await atomicWriteJson(path, {
			state: "delivered",
			instanceId,
			updatedAt: new Date().toISOString(),
		} satisfies DeliveryReceipt);
	}
	await dequeuePending(sessionId, basename(jobDir), storeRootFromJobDir(jobDir));
	return !already;
}

export async function claimDelivery(
	jobDir: string,
	sessionId: string,
	instanceId: string,
	now = new Date(),
): Promise<boolean> {
	const path = deliveryPath(jobDir, sessionId);
	const claim: DeliveryReceipt = { state: "claimed", instanceId, updatedAt: now.toISOString() };
	if (await exclusiveWriteJson(path, claim)) return true;
	const existing = await readJson<DeliveryReceipt>(path);
	if (!existing || existing.state === "delivered") return false;
	// A live extension instance must never reclaim its own queued notification,
	// even when an agent turn runs longer than the cross-process stale TTL.
	if (existing.instanceId === instanceId) return false;
	const age = now.getTime() - new Date(existing.updatedAt).getTime();
	// Session history promotes claims to delivered. Only a different, resumed
	// extension instance may recover a stale claim left by a dead Pi process.
	if (!Number.isFinite(age) || age <= DELIVERY_CLAIM_TTL_MS) return false;
	// Rename stale claim away. A competing process may win; exclusive creation decides ownership.
	try {
		await rename(path, `${path}.stale.${process.pid}.${Date.now()}`);
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}
	return exclusiveWriteJson(path, claim);
}

export async function acknowledgeJob(jobDir: string, sessionId: string): Promise<void> {
	await atomicWriteJson(join(jobDir, "acknowledged.json"), {
		acknowledgedAt: new Date().toISOString(),
		acknowledgedBy: sessionId,
	});
}

export function resolveOutputPath(cwd: string, candidate?: string): string {
	return candidate ? resolve(cwd, candidate.replace(/^@/, "")) : "";
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function removeStaleDeliveryFiles(jobDir: string): Promise<void> {
	const dir = join(jobDir, "deliveries");
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch (error: any) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	for (const name of names) {
		const stale = name.includes(".stale.");
		const tmp = name.endsWith(".tmp");
		if (!stale && !tmp) continue;
		const path = join(dir, name);
		try {
			const info = await stat(path);
			const age = Date.now() - info.mtimeMs;
			if ((stale && age > 24 * 60 * 60 * 1000) || (tmp && age > TMP_STALE_MS)) await unlink(path);
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
}
