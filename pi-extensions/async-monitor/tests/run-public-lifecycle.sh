#!/usr/bin/env bash
set -euo pipefail
EXT_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d /tmp/pi-async-public.XXXXXX)
STORE="$TMP/store"
SESSIONS="$TMP/sessions"
mkdir -p "$STORE" "$SESSIONS"
export PI_ASYNC_MONITOR_DIR="$STORE"
export PI_ASYNC_MONITOR_POLL_MS=250
export PI_ASYNC_MONITOR_MODEL=deepseek/deepseek-v4-flash
export PI_ASYNC_LIFECYCLE_INPUT="/async run node -e 'console.log(\"PUBLIC_START\");setTimeout(()=>console.log(\"PUBLIC_DONE\"),60000)'"
cleanup() {
  [[ -n "${FIRST_PI_PID:-}" ]] && kill "$FIRST_PI_PID" 2>/dev/null || true
  [[ -n "${RESUME_PI_PID:-}" ]] && kill "$RESUME_PI_PID" 2>/dev/null || true
  [[ -n "${WORKER_PID:-}" ]] && kill -TERM -- "-$WORKER_PID" 2>/dev/null || true
}
trap cleanup EXIT

node "$EXT_DIR/tests/rpc-client.mjs" command-hold "$EXT_DIR/index.ts" new "$SESSIONS" "$PWD" >"$TMP/first.json" &
FIRST_CLIENT=$!
for _ in {1..300}; do [[ -s "$TMP/first.json" ]] && break; sleep .05; done
[[ -s "$TMP/first.json" ]] || { echo "public dispatch did not return"; exit 1; }
FIRST_PI_PID=$(node -p "JSON.parse(require('fs').readFileSync('$TMP/first.json','utf8')).pid")
SESSION_FILE=$(node -p "JSON.parse(require('fs').readFileSync('$TMP/first.json','utf8')).state.sessionFile")
SESSION_ID=$(node -p "JSON.parse(require('fs').readFileSync('$TMP/first.json','utf8')).state.sessionId")
RETURN_MS=$(node -p "JSON.parse(require('fs').readFileSync('$TMP/first.json','utf8')).commandReturnMs")
for _ in {1..100}; do
  JOB_DIR=$(find "$STORE/jobs" -mindepth 1 -maxdepth 1 -type d | head -1 || true)
  if [[ -n "$JOB_DIR" && -s "$JOB_DIR/runner.json" ]] && node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(x.childPid?0:1)' "$JOB_DIR/runner.json"; then break; fi
  sleep .05
done
[[ -n "${JOB_DIR:-}" && -s "$JOB_DIR/runner.json" && -s "$SESSION_FILE" ]]
JOB_ID=$(basename "$JOB_DIR")
WORKER_PID=$(node -p "JSON.parse(require('fs').readFileSync('$JOB_DIR/runner.json','utf8')).pid")
CHILD_PID=$(node -p "JSON.parse(require('fs').readFileSync('$JOB_DIR/runner.json','utf8')).childPid")
CREATED_AT=$(node -p "JSON.parse(require('fs').readFileSync('$JOB_DIR/metadata.json','utf8')).createdAt")

kill -TERM "$FIRST_PI_PID"
wait "$FIRST_CLIENT"
FIRST_PI_PID=
kill -0 "$WORKER_PID"
kill -0 "$CHILD_PID"
sleep 7
kill -0 "$WORKER_PID"
kill -0 "$CHILD_PID"

node "$EXT_DIR/tests/rpc-client.mjs" resume "$EXT_DIR/index.ts" "$SESSION_FILE" "$SESSIONS" "$PWD" >"$TMP/resume.json"
node - "$TMP/resume.json" "$JOB_DIR" "$JOB_ID" "$RETURN_MS" "$CREATED_AT" <<'NODE'
const fs=require('fs');
const [resumePath,jobDir,jobId,returnMs,createdAt]=process.argv.slice(2);
const run=JSON.parse(fs.readFileSync(resumePath));
const result=JSON.parse(fs.readFileSync(jobDir+'/result.json'));
const deliveryDir=jobDir+'/deliveries';
const receipts=fs.readdirSync(deliveryDir).filter(x=>x.endsWith('.json'));
const custom=(run.entries||[]).filter(e=>e.type==='custom_message'&&e.customType==='async-monitor-complete'&&e.details?.jobId===jobId);
const durationMs=new Date(result.completedAt)-new Date(createdAt);
const evidence={jobId,commandReturnMs:Number(returnMs),durationMs,terminalStatus:result.status,transcriptCompletions:custom.length,deliveryReceipts:receipts.length,settled:run.settled,sessionId:run.state.sessionId};
console.log(JSON.stringify(evidence,null,2));
if(evidence.commandReturnMs>2000||durationMs<45000||durationMs>120000||result.status!=='completed'||custom.length!==1||receipts.length!==1||!run.settled) process.exit(1);
NODE

echo "artifacts=$TMP"
trap - EXIT
