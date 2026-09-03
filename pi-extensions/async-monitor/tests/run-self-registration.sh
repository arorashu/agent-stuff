#!/usr/bin/env bash
set -euo pipefail
EXT_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d /tmp/pi-async-self-register.XXXXXX)
export PI_ASYNC_MONITOR_DIR="$TMP/store"
export PI_ASYNC_MONITOR_POLL_MS=200
mkdir -p "$TMP/store" "$TMP/sessions"
node "$EXT_DIR/tests/rpc-client.mjs" self-register "$EXT_DIR/index.ts" new "$TMP/sessions" "$PWD" >"$TMP/result.json"
node - "$TMP" <<'NODE'
const fs=require('fs'),tmp=process.argv[2],run=JSON.parse(fs.readFileSync(tmp+'/result.json'));
const entries=run.entries||[];
const assistants=entries.filter(e=>e.type==='message'&&e.message?.role==='assistant');
const calls=assistants.flatMap(e=>e.message.content||[]).filter(x=>x.type==='toolCall'&&x.name==='async_monitor');
const actions=calls.map(x=>x.arguments?.action);
const custom=entries.filter(e=>e.type==='custom_message'&&e.customType==='async-monitor-complete'&&String(e.content).includes('SELF_REGISTERED'));
const finalText=assistants.flatMap(e=>e.message.content||[]).filter(x=>x.type==='text').at(-1)?.text||'';
const jobsRoot=tmp+'/store/jobs',jobs=fs.readdirSync(jobsRoot);
const receiptCount=jobs.reduce((n,id)=>n+fs.readdirSync(`${jobsRoot}/${id}/deliveries`).filter(x=>x.endsWith('.json')).length,0);
const evidence={jobs:jobs.length,asyncActions:actions,customMessages:custom.length,receiptCount,idleBeforeCompletion:run.settledTimes.some(t=>t<run.completionTimes[0]),assistantResponses:assistants.length,historyAnswer:finalText,settledCount:run.settledCount};
console.log(JSON.stringify(evidence,null,2));
if(jobs.length!==1||actions.join(',')!=='run'||custom.length!==1||receiptCount!==1||!evidence.idleBeforeCompletion||assistants.length<3||!/HISTORY_COUNT=1\b/.test(finalText))process.exit(1);
NODE
echo "artifacts=$TMP"
