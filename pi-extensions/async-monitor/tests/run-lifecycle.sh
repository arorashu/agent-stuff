#!/usr/bin/env bash
set -euo pipefail
EXT_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d /tmp/pi-async-lifecycle.XXXXXX)
STORE="$TMP/store"
SESSIONS="$TMP/sessions"
mkdir -p "$STORE" "$SESSIONS"
export PI_ASYNC_MONITOR_DIR="$STORE"
export PI_ASYNC_MONITOR_POLL_MS=250
cleanup() {
  if [[ -n "${FIRST_PI_PID:-}" ]]; then kill "$FIRST_PI_PID" 2>/dev/null || true; fi
  if [[ -n "${RESUME_PI_PID:-}" ]]; then kill "$RESUME_PI_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

# Create a persisted Pi session and hold it open as the initiating TUI-equivalent process.
node "$EXT_DIR/tests/rpc-client.mjs" hold "$EXT_DIR/index.ts" new "$SESSIONS" "$PWD" >"$TMP/first.json" &
FIRST_CLIENT=$!
for _ in {1..200}; do [[ -s "$TMP/first.json" ]] && break; sleep .05; done
[[ -s "$TMP/first.json" ]] || { echo "initial Pi failed"; exit 1; }
FIRST_PI_PID=$(node -p "JSON.parse(require('fs').readFileSync('$TMP/first.json','utf8')).pid")
SESSION_FILE=$(node -p "JSON.parse(require('fs').readFileSync('$TMP/first.json','utf8')).state.sessionFile")
SESSION_ID=$(node -p "JSON.parse(require('fs').readFileSync('$TMP/first.json','utf8')).state.sessionId")
# Pi defers creating an empty session file. The production start path appends an
# async-monitor-started entry; this low-level worker harness materializes only
# the equivalent v3 header before testing resume.
if [[ ! -e "$SESSION_FILE" ]]; then
  node - "$SESSION_FILE" "$SESSION_ID" "$PWD" <<'NODE'
const fs=require('fs');
const [path,id,cwd]=process.argv.slice(2);
fs.writeFileSync(path, JSON.stringify({type:'session',version:3,id,timestamp:new Date().toISOString(),cwd})+'\n', {mode:0o600});
NODE
fi

START_MS=$(date +%s%3N)
JOB=$(node "$EXT_DIR/tests/lifecycle-parent.mjs" "$STORE" "$SESSION_ID")
RETURN_MS=$(date +%s%3N)
JOB_ID=$(node -p "JSON.parse(process.argv[1]).id" "$JOB")
JOB_DIR=$(node -p "JSON.parse(process.argv[1]).dir" "$JOB")
WORKER_PID=$(node -p "JSON.parse(process.argv[1]).workerPid" "$JOB")
for _ in {1..100}; do [[ -s "$JOB_DIR/runner.json" ]] && break; sleep .05; done
CHILD_PID=$(node -p "JSON.parse(require('fs').readFileSync('$JOB_DIR/runner.json','utf8')).childPid")

# Destructive boundary: terminate the initiating Pi and its RPC client.
kill -TERM "$FIRST_PI_PID"
wait "$FIRST_CLIENT" 2>/dev/null || true
FIRST_PI_PID=
BEFORE=$(stat -c %s "$JOB_DIR/output.log")
sleep 7
AFTER=$(stat -c %s "$JOB_DIR/output.log")
kill -0 "$WORKER_PID"
kill -0 "$CHILD_PID"
[[ "$AFTER" -gt "$BEFORE" ]] || { echo "output did not advance after Pi exit"; exit 1; }

# Resume the exact same Pi session before completion. It must receive one result.
node "$EXT_DIR/tests/rpc-client.mjs" resume "$EXT_DIR/index.ts" "$SESSION_FILE" "$SESSIONS" "$PWD" >"$TMP/resume.json" &
RESUME_CLIENT=$!
wait "$RESUME_CLIENT"
RESUME_PI_PID=

node - "$TMP/resume.json" "$JOB_DIR" "$JOB_ID" "$RETURN_MS" "$START_MS" <<'NODE'
const fs=require('fs');
const [resultPath,jobDir,jobId,returnMs,startMs]=process.argv.slice(2);
const run=JSON.parse(fs.readFileSync(resultPath,'utf8'));
const result=JSON.parse(fs.readFileSync(jobDir+'/result.json','utf8'));
const receipt=JSON.parse(fs.readFileSync(jobDir+'/deliveries/'+run.state.sessionId+'.json','utf8'));
const custom=(run.entries||[]).filter(e=>e.type==='custom_message'&&e.customType==='async-monitor-complete'&&e.details?.jobId===jobId);
const contextEvents=run.events.filter(e=>(e.type==='message_start'||e.type==='message_end')&&e.message?.role==='custom'&&e.message?.customType==='async-monitor-complete');
const output=fs.readFileSync(jobDir+'/output.log','utf8');
const evidence={
  jobId,
  startReturnMs:Number(returnMs)-Number(startMs),
  terminalStatus:result.status,
  outputHasStart:output.includes('START '),
  outputHasDone:output.includes('DONE '),
  pulseCount:(output.match(/^PULSE /gm)||[]).length,
  transcriptCompletions:custom.length,
  customMessageEvents:contextEvents.length,
  deliveryState:receipt.state,
  deliveryRewriteLagMs:new Date(receipt.updatedAt).getTime()-run.completionSeenAt,
  sessionId:run.state.sessionId,
  settled:run.settled,
};
console.log(JSON.stringify(evidence,null,2));
if(evidence.startReturnMs>2000||result.status!=='completed'||!evidence.outputHasDone||evidence.pulseCount<10||custom.length!==1||receipt.state!=='delivered'||evidence.deliveryRewriteLagMs>2000||!run.settled) process.exit(1);
NODE

echo "artifacts=$TMP"
trap - EXIT
