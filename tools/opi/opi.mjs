#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Store } from './lib/store.mjs';
import { Compactor } from './lib/compactor.mjs';
import { Engine } from './lib/engine.mjs';
import { loadPi, createPiBackend } from './lib/pi.mjs';

const HELP = `opi — Pi with an OptChat history (separate from mpi)

Usage: opi [options] [initial message]
       opi -p "message"

  --model provider/id          Main model (default: Pi settings)
  --compact-model provider/id  Summarizer (default: main model; costs extra)
  --thinking LEVEL            off, minimal, low, medium, high, xhigh, max
  --memory DIR                History (default: $XDG_DATA_HOME/optchat)
  --view-bytes N              Summary text budget (default: 128000)
  --tools read,bash,...        Built-in allowlist; zoom and date always enabled
  --pi-root DIR               Pi 0.87.1 npm package directory
  --doctor                    Check SDK and paths without model calls
  -p, --print                  One turn, finish summaries, then exit
  -h, --help                   Show this help

Interactive: /status, /view, /zoom ID N, /date ID, /flush, /exit.
Ctrl-C cancels active work, or exits at the prompt. Messages typed while the
agent is streaming steer it at tool boundaries. Pi TUI commands/extensions
are not loaded. Model credentials, skills and context files come from Pi.
`;

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    model: { type: 'string' }, 'compact-model': { type: 'string' }, thinking: { type: 'string', default: 'medium' },
    memory: { type: 'string' }, 'view-bytes': { type: 'string', default: '128000' }, tools: { type: 'string' },
    'pi-root': { type: 'string' }, doctor: { type: 'boolean' }, print: { type: 'boolean', short: 'p' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(HELP); return; }
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(values.thinking)) throw new Error('Invalid --thinking level.');
  const directory = path.resolve(values.memory || process.env.OPI_MEMORY_DIR || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'optchat'));
  const pi = await loadPi(values['pi-root']);
  if (values.doctor) {
    console.log(`Pi SDK: ${pi.version}\nPackage: ${pi.root}\nHistory: ${directory}\nHistory exists: ${fs.existsSync(directory)}\nNo model calls made.`);
    return;
  }
  const prompt = positionals.join(' ');
  if (values.print && !prompt) throw new Error('Provide a message with --print.');
  const mainUsage = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const backend = await createPiBackend({ sdk: pi.sdk, model: values.model,
    compactModel: values['compact-model'] || process.env.OPI_COMPACT_MODEL,
    thinking: values.thinking, tools: values.tools?.split(',').filter(Boolean),
    onTool: name => console.error(`\n[tool: ${name}]`),
    onUsage: usage => {
      mainUsage.requests++;
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) mainUsage[field] += usage?.[field] ?? 0;
      mainUsage.cost += usage?.cost?.total ?? 0;
    },
  });
  const store = await Store.open(directory, { budget: Number(values['view-bytes']) });
  const compactor = new Compactor(store, backend.complete);
  const engine = new Engine(store, compactor, backend);
  console.error(`OptChat: ${directory}\nMain: ${backend.model.provider}/${backend.model.id}\nSummarizer: ${backend.compressor.provider}/${backend.compressor.id} (background model calls)`);
  compactor.pump();
  let rl, flushing;
  let exiting = false;
  const cancel = () => {
    if (engine.controller) void engine.abort();
    else if (flushing) flushing.abort(new Error('Summary wait cancelled.'));
    else { exiting = true; rl?.close(); }
  };
  const terminate = () => { exiting = true; void engine.abort(); flushing?.abort(); rl?.close(); };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', terminate);
  async function flush() {
    flushing = new AbortController();
    try { await compactor.settle(flushing.signal, { all: true }); }
    finally { flushing = undefined; }
  }
  function status() {
    console.error(JSON.stringify({ messages: store.roots.length, summaries: store.nodes.size,
      pending: compactor.pendingCount(), viewBytes: store.size(), viewBudget: store.budget,
      main: mainUsage, compactor: compactor.stats }, null, 2));
  }
  async function command(line) {
    const [name, ...args] = line.trim().split(/\s+/);
    if (name === '/status') status();
    else if (name === '/view') console.log(store.render());
    else if (name === '/zoom') console.log(store.zoom(Number(args[0]), Number(args[1])));
    else if (name === '/date') console.log(store.date(Number(args[0])));
    else if (name === '/flush') await flush();
    else if (name === '/exit') { exiting = true; rl.close(); }
    else throw new Error('Unknown command. Use /status, /view, /zoom ID N, /date ID, /flush, /exit.');
  }
  try {
    if (values.print) {
      await engine.run(prompt);
      console.log();
      await flush();
      status();
      return;
    }
    // readline allows steering while a model request runs; only one fresh turn
    // executes at a time. Commands are queued instead of racing the store.
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    rl.on('SIGINT', cancel);
    const queue = prompt ? [prompt] : [];
    let draining = false, inputClosed = false, resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    async function drain() {
      if (draining) return;
      draining = true;
      while (queue.length && !exiting) {
        const line = queue.shift();
        try {
          if (line.startsWith('/')) await command(line);
          else { await engine.run(line); console.log(); }
        } catch (error) { console.error(`opi: ${error.message}`); }
      }
      draining = false;
      if (inputClosed || exiting) resolveDone();
      else { rl.setPrompt('opi> '); rl.prompt(); }
    }
    rl.on('line', line => {
      if (!line.trim()) return;
      if (!line.startsWith('/') && engine.active?.isStreaming && process.stdin.isTTY) {
        void engine.steer(line).then(accepted => { if (!accepted) { queue.push(line); void drain(); } }).catch(error => console.error(error.message));
      } else { queue.push(line); void drain(); }
    });
    rl.on('close', () => { inputClosed = true; if (!draining) resolveDone(); });
    await drain();
    await done;
    // Preserve piped or queued user text if exit interrupted before delivery.
    for (const line of queue) if (!line.startsWith('/')) store.append('user', line, { unanswered: true });
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', terminate);
    await engine.abort();
    await compactor.close();
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`opi: ${error.message}`); process.exitCode = 1; });
}
