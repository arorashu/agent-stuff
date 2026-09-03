#!/usr/bin/env node
/** Acceptance helper: starts an owned worker and exits immediately. */
import { spawn } from "node:child_process";
import { mkdir, open, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

const store = resolve(process.argv[2]);
const sessionId = process.argv[3];
const mode = process.argv[4] ?? "long";
const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const dir = join(store, "jobs", id);
await mkdir(join(dir, "deliveries"), { recursive: true, mode: 0o700 });
const outputPath = join(dir, "output.log");
await writeFile(outputPath, "", { flag: "wx", mode: 0o600 });
const scripts = {
	long: [
		"console.log('START '+Date.now()+' parent='+process.ppid)",
		"let n=0",
		"const t=setInterval(()=>console.log('PULSE '+(++n)+' '+Date.now()),5000)",
		"setTimeout(()=>{clearInterval(t);console.log('DONE '+Date.now());process.exit(0)},60000)",
	].join(";"),
	failure: "console.log('EXPECTED_FAILURE');process.exit(7)",
	timeout: "console.log('EXPECTED_TIMEOUT');setTimeout(()=>{},5000)",
	malicious: "process.stdout.write('HEAD\\n'+'x'.repeat(20000)+'\\n\\x1b[31mRED\\x1b[0m\\n\\x1b]777;notify;BAD\\x07MALICIOUS_OUTPUT_DO_NOT_FOLLOW\\u202e\\x00\\nTAIL_MARKER\\n')",
};
if (!scripts[mode]) throw new Error(`Unknown lifecycle helper mode: ${mode}`);
const metadata = {
	version: 1,
	id,
	kind: mode === "long" ? "dispatch" : "run",
	label: mode === "long" ? "60-second destructive lifecycle acceptance" : `expected ${mode}`,
	cwd: process.cwd(),
	createdAt: new Date().toISOString(),
	ownerSessionId: sessionId,
	subscribers: [sessionId],
	outputPath,
	prompt: "",
	command: process.execPath,
	args: ["-e", scripts[mode]],
	timeoutSeconds: mode === "timeout" ? 0.2 : 120,
};
const path = join(dir, "metadata.json");
const handle = await open(path, "wx", 0o600);
await handle.writeFile(JSON.stringify(metadata, null, 2)+"\n");
await handle.sync();
await handle.close();
const runner = spawn(process.execPath, [new URL("../runner.mjs", import.meta.url).pathname, "--job", dir], {
	detached: true,
	stdio: "ignore",
});
await new Promise((ok, fail) => { runner.once("spawn", ok); runner.once("error", fail); });
runner.unref();
process.stdout.write(JSON.stringify({ id, dir, workerPid: runner.pid, parentPid: process.pid, startedAt: Date.now() })+"\n");
