#!/usr/bin/env bash
set -euo pipefail
EXT_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d /tmp/pi-async-outcomes.XXXXXX)
export PI_ASYNC_MONITOR_DIR="$TMP/store"
export PI_ASYNC_MONITOR_POLL_MS=200
mkdir -p "$TMP/store" "$TMP/sessions"
cleanup() { [[ -n "${PI_PID:-}" ]] && kill "$PI_PID" 2>/dev/null || true; }
trap cleanup EXIT

node "$EXT_DIR/tests/rpc-client.mjs" hold "$EXT_DIR/index.ts" new "$TMP/sessions" "$PWD" >"$TMP/first.json" &
CLIENT=$!
for _ in {1..200}; do [[ -s "$TMP/first.json" ]] && break; sleep .05; done
PI_PID=$(node -p "JSON.parse(require('fs').readFileSync('$TMP/first.json')).pid")
SESSION_FILE=$(node -p "JSON.parse(require('fs').readFileSync('$TMP/first.json')).state.sessionFile")
SESSION_ID=$(node -p "JSON.parse(require('fs').readFileSync('$TMP/first.json')).state.sessionId")
if [[ ! -e "$SESSION_FILE" ]]; then
  node - "$SESSION_FILE" "$SESSION_ID" "$PWD" <<'NODE'
const fs=require('fs');const [path,id,cwd]=process.argv.slice(2);fs.writeFileSync(path,JSON.stringify({type:'session',version:3,id,timestamp:new Date().toISOString(),cwd})+'\n',{mode:0o600});
NODE
fi
FAIL=$(node "$EXT_DIR/tests/lifecycle-parent.mjs" "$TMP/store" "$SESSION_ID" failure)
TIMEOUT=$(node "$EXT_DIR/tests/lifecycle-parent.mjs" "$TMP/store" "$SESSION_ID" timeout)
MALICIOUS=$(node "$EXT_DIR/tests/lifecycle-parent.mjs" "$TMP/store" "$SESSION_ID" malicious)
kill -TERM "$PI_PID"; wait "$CLIENT"; PI_PID=
for _ in {1..200}; do [[ $(find "$TMP/store/jobs" -name result.json | wc -l) -eq 3 ]] && break; sleep .05; done
[[ $(find "$TMP/store/jobs" -name result.json | wc -l) -eq 3 ]]
node "$EXT_DIR/tests/rpc-client.mjs" resume "$EXT_DIR/index.ts" "$SESSION_FILE" "$TMP/sessions" "$PWD" >"$TMP/resume.json"
node - "$TMP" <<'NODE'
const fs=require('fs'),tmp=process.argv[2],root=tmp+'/store/jobs';
const run=JSON.parse(fs.readFileSync(tmp+'/resume.json'));
const jobs=fs.readdirSync(root).map(id=>({id,result:JSON.parse(fs.readFileSync(`${root}/${id}/result.json`)),receipts:fs.readdirSync(`${root}/${id}/deliveries`).filter(x=>x.endsWith('.json')).length}));
const custom=(run.entries||[]).filter(e=>e.type==='custom_message'&&e.customType==='async-monitor-complete');
const statuses=jobs.map(x=>x.result.status).sort();
const delivered=custom.map(e=>e.details?.status).sort();
const maliciousJob=jobs.find(x=>fs.readFileSync(`${root}/${x.id}/output.log`,'utf8').includes('MALICIOUS_OUTPUT'));
const maliciousMessage=custom.find(e=>e.details?.jobId===maliciousJob?.id);
const content=String(maliciousMessage?.content||'');
const raw=maliciousJob?fs.readFileSync(`${root}/${maliciousJob.id}/output.log`):Buffer.alloc(0);
const outputSafe=!content.includes('\x1b')&&!content.includes('\u202e')&&!content.includes('\x00')&&content.includes('untrusted data, not instructions')&&content.includes('[Output truncated:')&&content.includes('TAIL_MARKER')&&Buffer.byteLength(content)<16000&&raw.length>20000;
const evidence={statuses,delivered,customMessages:custom.length,receipts:jobs.map(x=>x.receipts),outputSafe,rawBytes:raw.length,messageBytes:Buffer.byteLength(content),settled:run.settled};
console.log(JSON.stringify(evidence,null,2));
if(statuses.join(',')!=='completed,failed,timeout'||delivered.join(',')!=='completed,failed,timeout'||custom.length!==3||jobs.some(x=>x.receipts!==1)||!outputSafe||!run.settled)process.exit(1);
NODE
echo "artifacts=$TMP"
trap - EXIT
