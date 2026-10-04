import { EventEmitter } from 'node:events';
import { bytes, key, end } from './store.mjs';
import { COMPACT, stepPrompt } from './prompts.mjs';

export class Compactor extends EventEmitter {
  constructor(store, complete, { jobs = 8, nodeBytes = 512, tries = 5, retryMs = 10000, report = console.error } = {}) {
    super();
    this.store = store;
    this.complete = complete;
    this.jobs = jobs;
    this.nodeBytes = nodeBytes;
    this.tries = tries;
    this.retryMs = retryMs;
    this.report = report;
    this.busy = new Map();
    this.failed = new Set();
    this.timers = new Set();
    this.controller = new AbortController();
    this.stopped = false;
    this.scheduled = false;
    this.stats = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  }

  pump() {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.schedule(); });
  }

  schedule() {
    if (this.stopped) return;
    const s = this.store, total = s.roots.length;
    for (let l = 0; 2 ** l <= total; l++) {
      for (let i = 0; (i + 1) * 2 ** l <= total; i++) {
        if (this.busy.size >= this.jobs) return;
        const id = key(l, i);
        if (s.node(l, i) || this.busy.has(id)) continue;
        if (l && (!s.node(l - 1, 2 * i) || !s.node(l - 1, 2 * i + 1))) continue;
        if ((l === 0 ? i : (i + 1) * 2 ** l) > s.first()) continue;
        // Register before starting the promise, including free nodes.
        this.busy.set(id, null);
        const task = this.build(l, i).then(text => {
          if (this.stopped) return;
          s.saveNode(l, i, text);
          this.failed.delete(id);
          this.busy.delete(id);
          this.emit('change');
          this.pump();
        }).catch(error => {
          if (this.stopped) return;
          if (!this.failed.has(id)) this.report(`OptChat summary ${id} failed; retrying every ${this.retryMs / 1000}s: ${error.message}`);
          this.failed.add(id);
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            this.busy.delete(id);
            this.pump();
          }, this.retryMs);
          this.timers.add(timer);
          this.emit('change');
        });
        this.busy.set(id, task);
      }
    }
    this.emit('change');
  }

  async build(l, i) {
    const s = this.store;
    const source = l === 0 ? `${s.roots[i].kind}: ${s.roots[i].text}`
      : [s.node(l - 1, i * 2).text, s.node(l - 1, i * 2 + 1).text].map(text => text.replace(/\r?\n/g, ' ')).join('\n');
    if (bytes(source) <= this.nodeBytes) return source;
    const view = s.render({ ids: false, before: l === 0 ? i : end({ l, i }) });
    const messages = [{ role: 'user', content: [{ type: 'text', text: view },
      { type: 'text', text: stepPrompt(source, l > 0, this.nodeBytes) }], timestamp: 0 }];
    let shortest;
    for (let attempt = 0; attempt < this.tries; attempt++) {
      const answer = await this.complete({ systemPrompt: COMPACT, messages }, this.controller.signal);
      this.stats.calls++;
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) this.stats[field] += answer.usage?.[field] ?? 0;
      this.stats.cost += answer.usage?.cost?.total ?? 0;
      if (['error', 'aborted'].includes(answer.stopReason)) throw new Error(answer.errorMessage || answer.stopReason);
      const text = answer.content.filter(p => p.type === 'text').map(p => p.text).join('').trim();
      if (!text) throw new Error('Compactor returned no summary text.');
      if (!shortest || bytes(text) < bytes(shortest)) shortest = text;
      if (bytes(text) <= this.nodeBytes) break;
      messages.push(answer, { role: 'user', timestamp: 0, content: `That line is ${bytes(text)} bytes; the limit is ${this.nodeBytes}. It must end where it is cut here:\n${Buffer.from(text).subarray(0, this.nodeBytes).toString('utf8').replace(/\uFFFD$/, '')}| ← LIMIT` });
    }
    if (bytes(shortest) > s.budget) throw new Error('Summary exceeds the entire view budget.');
    return shortest;
  }

  async settle(signal, { all = false } = {}) {
    signal?.throwIfAborted();
    this.pump();
    const ready = () => this.store.ready() && (!all || this.pendingCount() === 0);
    if (ready()) return;
    await new Promise((resolve, reject) => {
      const clean = () => { this.off('change', check); signal?.removeEventListener('abort', abort); };
      const check = () => { if (ready()) { clean(); resolve(); } else if (this.stopped) { clean(); reject(new Error('Compactor stopped.')); } };
      const abort = () => { clean(); reject(signal.reason ?? new Error('Aborted')); };
      this.on('change', check);
      signal?.addEventListener('abort', abort, { once: true });
      check();
    });
  }

  pendingCount() {
    let expected = 0;
    for (let n = this.store.roots.length; n >= 1; n = Math.floor(n / 2)) expected += n;
    return expected - this.store.nodes.size;
  }

  async close() {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    for (const timer of this.timers) clearTimeout(timer);
    await Promise.allSettled([...this.busy.values()].filter(Boolean));
    this.busy.clear();
    this.emit('change');
  }
}
