#!/usr/bin/env bash
set -euo pipefail
EXT_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d /tmp/pi-async-cancel.XXXXXX)
export PI_ASYNC_MONITOR_DIR="$TMP/store"
export PI_ASYNC_MONITOR_POLL_MS=200
mkdir -p "$TMP/store" "$TMP/sessions"
node "$EXT_DIR/tests/rpc-client.mjs" cancel-job "$EXT_DIR/index.ts" new "$TMP/sessions" "$PWD" >"$TMP/first.json"
SESSION_FILE=$(node -p "JSON.parse(require('fs').readFileSync('$TMP/first.json')).state.sessionFile")
node "$EXT_DIR/tests/rpc-client.mjs" inspect "$EXT_DIR/index.ts" "$SESSION_FILE" "$TMP/sessions" "$PWD" >"$TMP/resumed.json"
node - "$TMP" <<'NODE'
const fs=require('fs'),tmp=process.argv[2],first=JSON.parse(fs.readFileSync(tmp+'/first.json')),resumed=JSON.parse(fs.readFileSync(tmp+'/resumed.json'));
const jobDir=tmp+'/store/jobs/'+first.jobId,result=JSON.parse(fs.readFileSync(jobDir+'/result.json'));
const custom=entries=>(entries||[]).filter(e=>e.type==='custom_message'&&e.customType==='async-monitor-complete'&&e.details?.jobId===first.jobId);
const firstCustom=custom(first.entries),resumedCustom=custom(resumed.entries);
const resumedNewEvents=resumed.events.filter(e=>e.type==='message_start'&&e.message?.role==='custom'&&e.message?.customType==='async-monitor-complete');
const receipts=fs.readdirSync(jobDir+'/deliveries').filter(x=>x.endsWith('.json'));
const output=fs.readFileSync(jobDir+'/output.log','utf8');
const evidence={status:result.status,firstCustom:firstCustom.length,resumedCustom:resumedCustom.length,resumedNewEvents:resumedNewEvents.length,receipts:receipts.length,commandDidNotFinish:!output.includes('SHOULD_NOT_FINISH')};
console.log(JSON.stringify(evidence,null,2));
if(result.status!=='cancelled'||firstCustom.length!==1||resumedCustom.length!==1||resumedNewEvents.length!==0||receipts.length!==1||!evidence.commandDidNotFinish)process.exit(1);
NODE
echo "artifacts=$TMP"
