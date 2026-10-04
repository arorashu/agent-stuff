import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPi, createPiBackend } from '../lib/pi.mjs';
import { Store } from '../lib/store.mjs';
import { Compactor } from '../lib/compactor.mjs';
import { Engine } from '../lib/engine.mjs';

test('real Pi SDK: fresh turns, actual zoom tool loop, retained in-turn signatures, restart recall', async t => {
  const { sdk, root } = await loadPi();
  const { AssistantMessageEventStream } = await import(pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js')).href);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opi-sdk-'));
  const agentDir = path.join(directory, 'agent');
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, 'settings.json'), '{}');
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: path.join(directory, 'models-store.json'), refreshOnCreate: false });
  const requests = [];
  let mainCalls = 0;
  runtime.registerProvider('opi-test', {
    api: 'openai-completions', apiKey: 'test-not-a-real-key', baseUrl: 'http://127.0.0.1:1/no-network',
    models: [{ id: 'fake', name: 'OptChat test double', reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }],
    streamSimple(model, context, options) {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          const serialized = JSON.stringify(context);
          const compact = serialized.includes('Your sole task is to summarize');
          let content, stopReason = 'stop';
          if (compact) content = [{ type: 'text', text: 'user: prefers violet; talk: acknowledged.' }];
          else {
            mainCalls++;
            requests.push(structuredClone(context));
            if (mainCalls === 2) {
              content = [{ type: 'thinking', thinking: 'private reasoning', thinkingSignature: 'opaque-signature' }, { type: 'toolCall', id: 'zoom-test-1', name: 'zoom', arguments: { id: 0, n: 1 } }];
              stopReason = 'toolUse';
            } else content = [{ type: 'text', text: mainCalls === 1 ? 'I will remember violet.' : 'Your preference was violet.' }];
          }
          const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: Date.now(), usage: { input: 10, output: 5, cacheRead: 8, cacheWrite: 0, totalTokens: 23, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: 'start', partial: message });
          stream.push({ type: 'done', reason: stopReason, message });
          stream.end(message);
        } catch (error) { stream.end(); throw error; }
      });
      return stream;
    },
  });
  let store = await Store.open(path.join(directory, 'chat'));
  const backend = await createPiBackend({ sdk, cwd: directory, agentDir, runtime, model: 'opi-test/fake', tools: [], onText() {} });
  let compactor = new Compactor(store, backend.complete);
  t.after(async () => { await compactor.close(); await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let engine = new Engine(store, compactor, backend);
  await engine.run('My preferred color is violet. ' + 'Keep this detailed original available. '.repeat(30));
  await compactor.settle(AbortSignal.timeout(10000), { all: true });
  await engine.run('What color did I choose? Open the original.');
  await compactor.settle(AbortSignal.timeout(10000), { all: true });
  assert.equal(mainCalls, 3);
  assert.ok(compactor.stats.calls > 0, 'real SDK nested summarizer call was exercised');
  const firstUsers = requests[0].messages.filter(m => m.role === 'user');
  assert.equal(firstUsers.length, 1);
  assert.equal(firstUsers[0].content[0].text, '<chat>\n\n</chat>');
  const secondUsers = requests[1].messages.filter(m => m.role === 'user');
  assert.equal(secondUsers.length, 1, 'old user messages must not remain as conversation turns');
  assert.match(secondUsers[0].content[0].text, /violet/);
  assert.ok(!requests[1].messages.some(m => m.role === 'assistant'), 'no old assistant turns');
  const step = requests[2].messages;
  assert.ok(step.some(m => m.role === 'assistant' && m.content.some(p => p.thinkingSignature === 'opaque-signature')));
  assert.ok(step.some(m => m.role === 'toolResult' && JSON.stringify(m.content).includes('My preferred color is violet')));
  assert.ok(!JSON.stringify(store.roots).includes('private reasoning'));
  assert.ok(!JSON.stringify(store.roots).includes('opaque-signature'));
  assert.equal(store.roots.filter(m => m.kind === 'user').length, 2, 'no injected-view duplication');
  assert.equal(store.roots.filter(m => m.kind === 'tool').length, 1);
  assert.equal(store.roots.filter(m => m.kind === 'echo').length, 1);
  const before = store.render();
  await compactor.close();
  await store.close();
  store = await Store.open(path.join(directory, 'chat'));
  compactor = new Compactor(store, backend.complete);
  engine = new Engine(store, compactor, backend);
  assert.equal(store.render(), before);
  await engine.run('Check again after restarting.');
  assert.match(requests[3].messages.find(m => m.role === 'user').content[0].text, /violet/);
});
