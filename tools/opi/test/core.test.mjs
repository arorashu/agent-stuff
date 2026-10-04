import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store, bytes, start, end } from '../lib/store.mjs';
import { Compactor } from '../lib/compactor.mjs';
import { Engine } from '../lib/engine.mjs';
import { cachePayload, capText, messageEntries } from '../lib/cache.mjs';
import { memoryExtension, memoryTools } from '../lib/pi.mjs';

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opi-test-'));
  const store = await Store.open(directory, options);
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return store;
}
const answer = text => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: { input: 10, output: 2, cacheRead: 8, cost: { total: 0.001 } }, timestamp: 0 });
const deadline = () => AbortSignal.timeout(15000);

test('log IDs, UTF-8, dates, exact originals and private permissions', async t => {
  const s = await fixture(t);
  const text = 'Keep João’s original\n東京 → café';
  s.append('user', text);
  assert.equal(s.zoom(0, 1), `0+0|user: ${text}`);
  assert.ok(s.date(0).includes(String(new Date().getFullYear())));
  assert.equal(fs.statSync(s.directory).mode & 0o777, 0o700);
  assert.equal(s.roots[0].size, bytes('user: ' + text));
  for (const [id, n] of [[0, 0], [1, 1], [0, 3], [-1, 1], [0.5, 1]]) assert.throws(() => s.zoom(id, n));
});

test('second writer rejected, normal close releases lock', async t => {
  const s = await fixture(t);
  await assert.rejects(Store.open(s.directory), /already open/);
  await s.close();
  const second = await Store.open(s.directory);
  await second.close();
});

test('process crash leaves a stale socket that the next writer recovers', async t => {
  const s = await fixture(t);
  await s.close();
  const moduleUrl = new URL('../lib/store.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { Store } from ${JSON.stringify(moduleUrl)}; const s = await Store.open(${JSON.stringify(s.directory)}); s.append('user', 'before process crash'); console.log('ready');`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const restored = await Store.open(s.directory);
  assert.equal(restored.roots[0].text, 'before process crash');
  restored.append('user', 'after recovery');
  await restored.close();
});

test('binary summaries cover history within budget and replay identical view', async t => {
  const s = await fixture(t, { budget: 2048 });
  const contexts = [];
  const c = new Compactor(s, async context => {
    contexts.push(context);
    const first = context.messages[0].content[0].text;
    assert.ok(!first.includes('not summarized yet'));
    assert.ok(!/^\d+\+\d+\|/m.test(first));
    return answer('user: memorable topic; talk: retained finding. '.repeat(7));
  });
  t.after(() => c.close());
  for (let i = 0; i < 128; i++) s.append('user', `message ${i}: ` + 'specific facts '.repeat(55));
  await c.settle(deadline(), { all: true });
  assert.equal(c.pendingCount(), 0);
  assert.equal(s.nodes.size, 255);
  assert.ok(s.size() <= 2048);
  assert.equal(start(s.view[0]), 0);
  assert.equal(end(s.view.at(-1)), 128);
  for (let i = 1; i < s.view.length; i++) assert.equal(end(s.view[i - 1]), start(s.view[i]));
  assert.ok(contexts.length > 0);
  const before = s.render();
  await c.close();
  await s.close();
  const restored = await Store.open(s.directory, { budget: 2048 });
  assert.equal(restored.render(), before);
  assert.match(restored.zoom(73, 1), /message 73:/);
  await restored.close();
});

test('short messages and small merges need no model calls', async t => {
  const s = await fixture(t);
  const c = new Compactor(s, () => { throw new Error('must not call model'); });
  t.after(() => c.close());
  s.append('user', 'hello'); s.append('talk', 'hi');
  await c.settle(deadline(), { all: true });
  assert.equal(s.node(1, 0).text, 'user: hello\ntalk: hi');
  assert.equal(c.stats.calls, 0);
  assert.equal(s.zoom(0, 2), '0+1|user: hello\n1+1|talk: hi');
});

test('summarizer retries byte overshoots in same conversation and preserves shortest', async t => {
  const s = await fixture(t);
  s.append('user', 'x'.repeat(1000));
  let calls = 0;
  const c = new Compactor(s, async context => {
    calls++;
    if (calls > 1) assert.match(context.messages.at(-1).content, /UTF-8|bytes/);
    return answer('é'.repeat(270 - calls));
  }, { tries: 3 });
  t.after(() => c.close());
  await c.settle(deadline());
  assert.equal(calls, 3);
  assert.equal(bytes(s.node(0, 0).text), 534);
  assert.equal(c.stats.cacheRead, 24);
});

test('failed summarizer retries, blocks unfinished view and supports cancellation', async t => {
  const s = await fixture(t);
  s.append('user', 'x'.repeat(1000));
  let attempts = 0;
  const reports = [];
  const c = new Compactor(s, async () => { if (++attempts < 3) throw new Error('temporary'); return answer('user: recovered'); }, { retryMs: 5, report: text => reports.push(text) });
  t.after(() => c.close());
  assert.throws(() => s.render(), /unfinished/);
  await c.settle(deadline());
  assert.equal(reports.length, 1);
  assert.equal(attempts, 3);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(c.settle(aborted.signal));
});

test('torn final record is preserved as evidence and append remains readable after two restarts', async t => {
  const s = await fixture(t);
  s.append('user', 'survives');
  await s.close();
  const file = path.join(s.directory, 'main', fs.readdirSync(path.join(s.directory, 'main'))[0]);
  fs.appendFileSync(file, '{"i":1,');
  const warnings = [];
  const recovered = await Store.open(s.directory, { warn: text => warnings.push(text) });
  assert.equal(warnings.length, 1);
  recovered.append('user', 'after crash');
  await recovered.close();
  const again = await Store.open(s.directory);
  assert.equal(again.roots.length, 2);
  assert.match(again.zoom(1, 1), /after crash/);
  assert.ok(fs.readdirSync(path.join(s.directory, 'main')).some(n => n.includes('.torn-')));
  await again.close();
});

test('cache checkpoints preserve original text, stay at line boundaries and do not alter reasoning', () => {
  const view = '<chat>\n' + '0+1|summary text\n'.repeat(9000) + '</chat>';
  const payload = { max_tokens: 1024, system: [{ type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'zoom', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: view }, { type: 'text', text: 'new' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'private', signature: 'opaque' }] }],
  };
  const output = cachePayload(payload);
  const blocks = output.messages[0].content;
  assert.equal(blocks.filter(b => b.cache_control).length, 3);
  assert.ok(blocks.filter(b => b.cache_control).every(b => b.text.endsWith('\n')));
  assert.equal(blocks.map(b => b.text).join(''), view + 'new');
  assert.deepEqual(output.messages[1], payload.messages[1]);
  assert.deepEqual(output.cache_control, { type: 'ephemeral' });
  assert.equal(output.system[0].cache_control, undefined);
  assert.equal(payload.messages[0].content.length, 2);
  const responses = { input: [], store: false };
  assert.equal(cachePayload(responses), responses);
});

test('thinking is excluded from log, capped results retain head/tail, original user text stays whole', () => {
  const entries = messageEntries({ role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET', signature: 'SIG' }, { type: 'text', text: 'answer' }, { type: 'toolCall', name: 'zoom', arguments: { id: 0, n: 1 } }] });
  assert.deepEqual(entries.map(x => x.kind), ['talk', 'tool']);
  assert.ok(!JSON.stringify(entries).includes('SECRET'));
  const huge = 'START' + '😃'.repeat(40000) + 'END';
  const capped = capText(huge);
  assert.ok(Array.from(capped).length <= 30000);
  assert.ok(capped.startsWith('START') && capped.endsWith('END'));
  assert.match(capped, /truncated/);
  assert.equal(messageEntries({ role: 'user', content: huge })[0].text, huge);
});

test('fresh context injection preserves current-turn reasoning and never mutates original transcript', () => {
  const hooks = new Map();
  memoryExtension('<chat>\nhistory\n</chat>')({ on: (name, fn) => hooks.set(name, fn) });
  const messages = [{ role: 'user', content: 'new' }, { role: 'assistant', content: [{ type: 'thinking', signature: 'keep' }] }];
  const output = hooks.get('context')({ messages });
  assert.equal(output.messages[0].content[0].text, '<chat>\nhistory\n</chat>');
  assert.equal(output.messages[1], messages[1]);
  assert.equal(messages[0].content, 'new');
  assert.deepEqual(hooks.get('cache_warming_decision')(), { action: 'stop' });
  const other = new Map();
  memoryExtension('<chat>\nold\n</chat>', undefined, 'openai-completions')({ on: (name, fn) => other.set(name, fn) });
  const payload = { messages: [], max_tokens: 1024 };
  assert.equal(other.get('before_provider_request')({ payload }), payload, 'must not add Anthropic-only fields to another provider');
});

test('zoom pagination can recover a long original without losing characters', async t => {
  const s = await fixture(t);
  s.append('user', '😀'.repeat(40000));
  const zoom = memoryTools(s)[0];
  let offset = 0, reconstructed = '';
  for (;;) {
    const result = await zoom.execute('x', { id: 0, n: 1, offset });
    const text = result.content[0].text;
    const match = text.match(/\n\[More: zoom\(0, 1, offset=(\d+)\)\]$/);
    reconstructed += match ? text.slice(0, match.index) : text;
    if (!match) break;
    offset = Number(match[1]);
  }
  assert.equal(reconstructed, s.zoom(0, 1));
});

test('cancellation during settle preserves accepted user input without starting a model', async t => {
  const s = await fixture(t);
  const compactor = { pump() {}, settle: signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) };
  const engine = new Engine(s, compactor, { session() { throw new Error('must not start'); } });
  const running = engine.run('remember even when cancelled');
  await engine.abort();
  await assert.rejects(running, /cancelled/);
  assert.equal(s.roots[0].unanswered, true);
  assert.equal(s.roots[0].text, 'remember even when cancelled');
});
