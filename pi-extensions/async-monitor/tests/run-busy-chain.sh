#!/usr/bin/env bash
set -euo pipefail
EXT_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d /tmp/pi-async-busy-chain.XXXXXX)
export PI_ASYNC_MONITOR_DIR="$TMP/store"
export PI_ASYNC_MONITOR_POLL_MS=200
SENTINEL="$TMP/sentinel"
export PI_ASYNC_LIFECYCLE_INPUTS=$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' \
  "/async start --interval 0.2 --timeout 10 --check-timeout 1 -- test -f $SENTINEL && echo SENTINEL_FIRED || exit 10" \
  "/async run sleep 2; touch $SENTINEL; echo SENTINEL_CREATED")
mkdir -p "$TMP/store" "$TMP/sessions"
node "$EXT_DIR/tests/rpc-client.mjs" busy-chain "$EXT_DIR/index.ts" new "$TMP/sessions" "$PWD" >"$TMP/result.json"
node - "$TMP" <<'NODE'
const fs=require('fs');
const tmp=process.argv[2];
const run=JSON.parse(fs.readFileSync(tmp+'/result.json'));
const jobsRoot=tmp+'/store/jobs';
const dirs=fs.readdirSync(jobsRoot).map(x=>jobsRoot+'/'+x);
const jobs=dirs.map(dir=>({dir,meta:JSON.parse(fs.readFileSync(dir+'/metadata.json')),result:JSON.parse(fs.readFileSync(dir+'/result.json'))}));
const customs=(run.entries||[]).filter(e=>e.type==='custom_message'&&e.customType==='async-monitor-complete');
const customIds=customs.map(e=>e.details?.jobId);
const receipts=jobs.map(j=>fs.readdirSync(j.dir+'/deliveries').filter(x=>x.endsWith('.json')).length);
const assistants=(run.entries||[]).filter(e=>e.type==='message'&&e.message?.role==='assistant').length;
const evidence={
  jobs:jobs.length,
  kinds:jobs.map(j=>j.meta.kind).sort(),
  statuses:jobs.map(j=>j.result.status),
  checkAttempts:jobs.find(j=>j.meta.kind==='check')?.result.attempts,
  sentinelCreated:fs.existsSync(tmp+'/sentinel'),
  customMessages:customs.length,
  uniqueCustomJobs:new Set(customIds).size,
  receipts,
  busyToolEndedAt:run.busyToolEndedAt,
  completionTimes:run.completionTimes,
  deferredAfterBusy:run.busyToolEndedAt>0&&run.completionTimes.every(t=>t>=run.busyToolEndedAt),
  assistantTurns:assistants,
  settledCount:run.settledCount,
};
console.log(JSON.stringify(evidence,null,2));
if(jobs.length!==2||evidence.kinds.join(',')!=='check,run'||jobs.some(j=>j.result.status!=='completed')||(evidence.checkAttempts??0)<2||!evidence.sentinelCreated||customs.length!==2||new Set(customIds).size!==2||receipts.some(n=>n!==1)||!evidence.deferredAfterBusy||assistants<3) process.exit(1);
NODE
echo "artifacts=$TMP"
