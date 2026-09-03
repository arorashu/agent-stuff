#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const [action, extensionPath, sessionArg, sessionDir, cwd] = process.argv.slice(2);
const args = ["--mode", "rpc", "--offline", "--no-extensions", "-e", extensionPath, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--session-dir", sessionDir];
if (sessionArg && sessionArg !== "new") args.push("--session", sessionArg);
const child = spawn("pi", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
const decoder = new StringDecoder("utf8");
const events = [];
let state;
let entries;
let settled = false;
let settledCount = 0;
const settledTimes = [];
let completionSeenAt = 0;
const completionTimes = [];
let busyToolEndedAt = 0;
const responses = new Map();

function send(value) { child.stdin.write(JSON.stringify(value)+"\n"); }
function handle(line) {
	if (!line.trim()) return;
	const value = JSON.parse(line);
	events.push(value);
	if (value.type === "response" && value.id) responses.set(value.id, value);
	if (value.type === "response" && value.command === "get_state") state = value.data;
	if (value.type === "response" && value.command === "get_entries") entries = value.data.entries;
	if (value.type === "message_start" && value.message?.role === "custom" && value.message?.customType === "async-monitor-complete") {
		completionSeenAt ||= Date.now();
		completionTimes.push(Date.now());
	}
	if (
		(value.type === "tool_execution_end" && JSON.stringify(value.args ?? {}).includes("BUSY_DONE")) ||
		(value.type === "message_end" && value.message?.role === "toolResult" && JSON.stringify(value.message.content).includes("BUSY_DONE"))
	) busyToolEndedAt = Date.now();
	if (value.type === "agent_settled") { settled = true; settledCount += 1; settledTimes.push(Date.now()); }
}
child.stdout.on("data", chunk => {
	buffer += decoder.write(chunk);
	for (;;) {
		const i = buffer.indexOf("\n");
		if (i < 0) break;
		handle(buffer.slice(0, i).replace(/\r$/, ""));
		buffer = buffer.slice(i+1);
	}
});
let stderr = "";
child.stderr.on("data", d => stderr += d);
await new Promise((ok, fail) => { child.once("spawn", ok); child.once("error", fail); });
send({ id: "state", type: "get_state" });
const deadline = Date.now()+15000;
while (!state && Date.now()<deadline) await new Promise(r=>setTimeout(r,25));
if (!state) throw new Error(`RPC state timeout: ${stderr}`);
if (action === "cancel-job") {
	send({ id: "bootstrap", type: "prompt", message: "Reply exactly READY and do not use tools." });
	const bootstrapDeadline=Date.now()+60_000;
	while (settledCount<1 && Date.now()<bootstrapDeadline) await new Promise(r=>setTimeout(r,100));
	send({ id: "start-cancel", type: "prompt", message: "/async run sleep 30; echo SHOULD_NOT_FINISH" });
	const startDeadline=Date.now()+10_000;
	while (!responses.has("start-cancel") && Date.now()<startDeadline) await new Promise(r=>setTimeout(r,25));
	const jobsRoot=process.env.PI_ASYNC_MONITOR_DIR+"/jobs";
	const jobDeadline=Date.now()+5000;
	while ((!existsSync(jobsRoot)||readdirSync(jobsRoot).length<1) && Date.now()<jobDeadline) await new Promise(r=>setTimeout(r,25));
	const jobId=readdirSync(jobsRoot)[0];
	send({ id: "cancel", type: "prompt", message: `/async cancel ${jobId}` });
	const cancelDeadline=Date.now()+10_000;
	while (!responses.has("cancel") && Date.now()<cancelDeadline) await new Promise(r=>setTimeout(r,25));
	const completionDeadline=Date.now()+120_000;
	while ((completionTimes.length<1 || !settledTimes.some(t=>t>completionTimes[0])) && Date.now()<completionDeadline) await new Promise(r=>setTimeout(r,100));
	await new Promise(r=>setTimeout(r,3000));
	send({ id: "entries", type: "get_entries" });
	const entriesDeadline=Date.now()+5000;
	while (!entries && Date.now()<entriesDeadline) await new Promise(r=>setTimeout(r,25));
	process.stdout.write(JSON.stringify({ pid: child.pid, state, jobId, completionTimes, settledCount, settledTimes, entries, events, stderr })+"\n");
	child.kill("SIGTERM");
} else if (action === "inspect") {
	await new Promise(r=>setTimeout(r,5000));
	send({ id: "entries", type: "get_entries" });
	const entriesDeadline=Date.now()+5000;
	while (!entries && Date.now()<entriesDeadline) await new Promise(r=>setTimeout(r,25));
	process.stdout.write(JSON.stringify({ pid: child.pid, state, entries, events, stderr })+"\n");
	child.kill("SIGTERM");
} else if (action === "self-register") {
	send({
		id: "register",
		type: "prompt",
		message: "Use async_monitor exactly once with action run, label SELF_REGISTER, command 'sleep 12; echo SELF_REGISTERED', and timeoutSeconds 30. Report the job ID, then stop. Do not call list/get and do not poll.",
	});
	const completionDeadline=Date.now()+120_000;
	while ((completionTimes.length<1 || !settledTimes.some(t=>t>completionTimes[0])) && Date.now()<completionDeadline) await new Promise(r=>setTimeout(r,100));
	const settledBeforeFollowup=settledCount;
	send({ id: "history", type: "prompt", message: "How many async-monitor completion custom messages containing SELF_REGISTERED are present in the conversation history? Reply exactly HISTORY_COUNT=N and do not use tools." });
	const historyDeadline=Date.now()+60_000;
	while (settledCount<=settledBeforeFollowup && Date.now()<historyDeadline) await new Promise(r=>setTimeout(r,100));
	send({ id: "entries", type: "get_entries" });
	const entriesDeadline=Date.now()+5000;
	while (!entries && Date.now()<entriesDeadline) await new Promise(r=>setTimeout(r,25));
	process.stdout.write(JSON.stringify({ pid: child.pid, state, completionTimes, settledCount, settledTimes, entries, events, stderr })+"\n");
	child.kill("SIGTERM");
} else if (action === "busy-chain") {
	const inputs = JSON.parse(process.env.PI_ASYNC_LIFECYCLE_INPUTS ?? "[]");
	if (!Array.isArray(inputs) || inputs.length < 2) throw new Error("PI_ASYNC_LIFECYCLE_INPUTS requires at least two commands");
	for (let i=0;i<inputs.length;i++) {
		const id=`job-${i}`;
		send({ id, type: "prompt", message: inputs[i] });
		const commandDeadline=Date.now()+10_000;
		while (!responses.has(id) && Date.now()<commandDeadline) await new Promise(r=>setTimeout(r,25));
		if (!responses.get(id)?.success) throw new Error(`Async registration failed: ${JSON.stringify(responses.get(id))}`);
	}
	send({ id: "busy", type: "prompt", message: "Use the bash tool exactly once to run: sleep 4; echo BUSY_DONE. Wait for it and then reply BUSY_PARENT_DONE." });
	const completionDeadline=Date.now()+120_000;
	while ((completionTimes.length<inputs.length || settledCount<inputs.length) && Date.now()<completionDeadline) await new Promise(r=>setTimeout(r,100));
	await new Promise(r=>setTimeout(r,3000));
	send({ id: "entries", type: "get_entries" });
	const entriesDeadline=Date.now()+5000;
	while (!entries && Date.now()<entriesDeadline) await new Promise(r=>setTimeout(r,25));
	process.stdout.write(JSON.stringify({ pid: child.pid, state, completionTimes, busyToolEndedAt, settledCount, entries, events, stderr })+"\n");
	child.kill("SIGTERM");
} else if (action === "command-hold" || action === "dispatch-hold") {
	const task = process.env.PI_ASYNC_LIFECYCLE_INPUT ?? (process.env.PI_ASYNC_LIFECYCLE_TASK ? `/dispatch ${process.env.PI_ASYNC_LIFECYCLE_TASK}` : undefined);
	if (!task) throw new Error("PI_ASYNC_LIFECYCLE_INPUT is required");
	// A real model tool call already has a persisted user turn. This extension-
	// command test starts from an empty RPC session, so materialize its header.
	if (!existsSync(state.sessionFile)) {
		writeFileSync(state.sessionFile, JSON.stringify({
			type: "session", version: 3, id: state.sessionId,
			timestamp: new Date().toISOString(), cwd,
		})+"\n", { mode: 0o600 });
	}
	const requestedAt = Date.now();
	send({ id: "command", type: "prompt", message: task });
	const commandDeadline = Date.now()+10_000;
	while (!responses.has("command") && Date.now()<commandDeadline) await new Promise(r=>setTimeout(r,25));
	if (!responses.get("command")?.success) throw new Error(`Async command failed: ${JSON.stringify(responses.get("command"))}`);
	process.stdout.write(JSON.stringify({ pid: child.pid, state, commandReturnMs: Date.now()-requestedAt })+"\n");
	await new Promise(resolveClose => child.once("close", resolveClose));
} else if (action === "hold") {
	// Force creation of the otherwise-lazy empty session file before the parent
	// process is terminated and later resumed. Production start does this with
	// its async-monitor-started custom entry.
	send({ id: "persist", type: "bash", command: "true" });
	const persistDeadline = Date.now()+5000;
	while (!responses.has("persist") && Date.now()<persistDeadline) await new Promise(r=>setTimeout(r,25));
	if (!responses.get("persist")?.success) throw new Error(`Cannot persist initial session: ${JSON.stringify(responses.get("persist"))}`);
	process.stdout.write(JSON.stringify({ pid: child.pid, state })+"\n");
	await new Promise(resolveClose => child.once("close", resolveClose));
} else if (action === "resume") {
	const waitDeadline = Date.now()+150000;
	while ((!completionSeenAt || !settled) && Date.now()<waitDeadline) await new Promise(r=>setTimeout(r,100));
	// Stay through several poll intervals to detect duplicate injection.
	await new Promise(r=>setTimeout(r,4000));
	send({ id: "entries", type: "get_entries" });
	const entriesDeadline = Date.now()+5000;
	while (!entries && Date.now()<entriesDeadline) await new Promise(r=>setTimeout(r,25));
	process.stdout.write(JSON.stringify({ pid: child.pid, state, completionSeenAt, settled, entries, events, stderr })+"\n");
	child.kill("SIGTERM");
}
