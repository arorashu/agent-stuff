// Explicitly opt-in: real provider calls, separate from the hermetic test suite.
// OPI_LIVE_TEST=1 node tools/opi/test/live-e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';

if (process.env.OPI_LIVE_TEST !== '1') throw new Error('Set OPI_LIVE_TEST=1 to authorize real model calls.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opi-live-e2e-'));
const agentDir = path.join(root, 'agent');
const memory = path.join(root, 'memory');
fs.mkdirSync(agentDir);
fs.mkdirSync(path.join(root, 'workspace'));
fs.symlinkSync(path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'auth.json'), path.join(agentDir, 'auth.json'));
fs.writeFileSync(path.join(agentDir, 'settings.json'), '{}');
const cli = fileURLToPath(new URL('../opi.mjs', import.meta.url));
const phrase = `violet-${crypto.randomBytes(6).toString('hex')}-東京`;
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
delete env.OPI_MODEL;
delete env.OPI_COMPACT_MODEL;
console.log(`Isolated live-test artifacts: ${root}`);

function run(name, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--memory', memory, '--view-bytes', '2048', '--tools', '', '--thinking', 'low', '--print', prompt], { cwd: path.join(root, 'workspace'), env });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(root, `${name}.stdout.txt`), stdout);
      fs.writeFileSync(path.join(root, `${name}.stderr.txt`), stderr);
      if (code !== 0) reject(new Error(`${name} exited ${code ?? signal}: ${stderr.slice(-2000)}`));
      else resolve({ stdout, stderr });
    });
  });
}

try {
  const save = await run('save', `Controlled synthetic memory test. The project is Lantern Orchard. Its exact recovery phrase is ${phrase}. Its launch date is 2031-04-19. These are fictional test data. Preserve them for later retrieval. ${'The project review concerned formatting and documentation; no action on real systems was requested. '.repeat(10)} Reply only SAVED.`);
  assert.match(save.stdout, /SAVED/);
  assert.match(save.stderr, /Main: openai-codex\/gpt-6\.1-sol/);
  assert.match(save.stderr, /Summarizer: openai-codex\/gpt-6\.1-sol/);
  console.log('PASS real default model, real summarizer, initial history saved');
  const recall = await run('recall-after-process-restart', 'For Lantern Orchard, retrieve the ORIGINAL user message using zoom, then return exactly a JSON object with recovery_phrase and launch_date. Do not guess from a summary.');
  assert.ok(recall.stdout.includes(phrase), 'must recover exact random Unicode phrase after process restart');
  assert.ok(recall.stdout.includes('2031-04-19'), 'must recover exact date');
  const rows = fs.readdirSync(path.join(memory, 'main')).filter(n => n.endsWith('.jsonl')).flatMap(n => fs.readFileSync(path.join(memory, 'main', n), 'utf8').trim().split('\n').map(JSON.parse));
  assert.ok(rows.some(row => row.kind === 'tool' && row.text.startsWith('zoom ')), 'real model must execute zoom');
  assert.ok(rows.some(row => row.kind === 'echo' && row.text.includes(phrase)), 'tool must return original phrase');
  assert.equal(rows.filter(row => row.kind === 'user').length, 2);
  assert.ok(fs.readdirSync(path.join(memory, 'tree')).length > 0);
  assert.ok(!fs.existsSync(path.join(agentDir, 'sessions')), 'no ordinary persistent Pi session should hold reasoning');
  console.log('PASS process restart, exact recall, real zoom tool execution, durable summaries');
  // Force a coarser tree with a small budget. These are synthetic imported notes,
  // not fake model summaries: the real summarizer builds all resulting parents.
  const seeded = await Store.open(memory, { budget: 2048 });
  for (let i = 0; i < 12; i++) seeded.append('note', `Unrelated synthetic project ${i}: ${'Reviewed its documentation, examples and release notes; no external changes were made. '.repeat(3)}`);
  seeded.append('user', 'Correction for Lantern Orchard: its launch date is now 2031-05-02. The recovery phrase is unchanged.');
  await seeded.close();
  const corrected = await run('recall-after-compression-and-correction', 'For Lantern Orchard, use zoom to verify the original recovery phrase and the later correction. Return JSON with recovery_phrase, original_launch_date, and current_launch_date.');
  assert.ok(corrected.stdout.includes(phrase));
  assert.ok(corrected.stdout.includes('2031-04-19'));
  assert.ok(corrected.stdout.includes('2031-05-02'));
  const verified = await Store.open(memory, { budget: 2048 });
  assert.ok(verified.view.some(part => part.l > 0), 'view must actually contain merged history');
  assert.ok(verified.size() <= 2048);
  assert.ok(verified.ready());
  assert.ok(verified.zoom(0, 1).includes(phrase), 'coarsening cannot alter the original');
  await verified.close();
  console.log('PASS real tree compression under 2048 bytes, original retrieval, later correction takes precedence');
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: true, provider: 'openai-codex', model: 'gpt-6.1-sol', memory, checks: ['default model', 'real summarizer', 'process restart', 'exact Unicode recall', 'date recall', 'zoom execution', 'durable summaries', 'no Pi session persistence', 'real tree compression', 'bounded view', 'correction precedence'] }, null, 2));
} finally {
  fs.unlinkSync(path.join(agentDir, 'auth.json'));
}
