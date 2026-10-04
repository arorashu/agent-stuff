import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';

export const bytes = text => Buffer.byteLength(text, 'utf8');
export const key = (l, i) => `${l}:${i}`;
export const start = p => p.i * 2 ** p.l;
export const end = p => (p.i + 1) * 2 ** p.l;
export const localDay = date => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function acquireLock(directory) {
  const socket = path.join(directory, 'lock');
  async function listen() {
    const server = net.createServer(client => client.end());
    server.listen(socket);
    await once(server, 'listening');
    return server;
  }
  try { return await listen(); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const live = await new Promise((resolve, reject) => {
      const client = net.createConnection(socket);
      client.once('connect', () => { client.destroy(); resolve(true); });
      client.once('error', err => {
        client.destroy();
        if (['ECONNREFUSED', 'ENOENT'].includes(err.code)) resolve(false);
        else reject(err);
      });
    });
    if (live) throw new Error(`OptChat is already open: ${directory}. Use another --memory directory for a separate chat.`);
    fs.rmSync(socket, { force: true });
    return listen();
  }
}

function durableAppend(file, value) {
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    const data = Buffer.from(JSON.stringify(value) + '\n');
    const written = fs.writeSync(fd, data);
    if (written !== data.length) throw new Error(`Short write to ${file}; restart to recover the torn record.`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

export class Store {
  static async open(directory, options = {}) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = await acquireLock(directory);
    try { return new Store(directory, lock, options); }
    catch (error) { await new Promise(resolve => lock.close(resolve)); throw error; }
  }

  constructor(directory, lock, { budget = 128000, warn = console.error } = {}) {
    if (!Number.isSafeInteger(budget) || budget < 2048) throw new Error('View budget must be an integer of at least 2048 bytes.');
    this.directory = directory;
    this.lock = lock;
    this.budget = budget;
    this.roots = [];
    this.nodes = new Map();
    this.view = [];
    this.seq = 0;
    this.closed = false;
    const events = [];
    for (const kind of ['main', 'tree']) {
      const dir = path.join(directory, kind);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort()) {
        const file = path.join(dir, name);
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (!lines[index].trim()) continue;
          try { events.push({ kind, value: JSON.parse(lines[index]) }); }
          catch {
            // Only a final torn record is recoverable. Never silently discard history.
            if (index < lines.length - 1) throw new Error(`Invalid JSON in ${file}:${index + 1}; restore it from backup.`);
            warn(`Ignoring torn final record in ${file}`);
          }
        }
        if (text && !text.endsWith('\n')) {
          // Preserve damaged text as evidence, but move it out of the active stream.
          const last = lines.at(-1);
          try { JSON.parse(last); durableNewline(file); }
          catch {
            fs.copyFileSync(file, `${file}.torn-${Date.now()}`);
            const fd = fs.openSync(file, 'r+');
            try { fs.ftruncateSync(fd, bytes(text.slice(0, text.lastIndexOf('\n') + 1))); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
          }
        }
      }
    }
    // Replay arrival order, including asynchronous node completions. This preserves
    // exactly the same incremental view after restart, rather than retessellating it.
    events.sort((a, b) => a.value.seq - b.value.seq);
    let previous = -1;
    for (const { kind, value } of events) {
      if (!Number.isSafeInteger(value.seq) || value.seq <= previous) throw new Error('Invalid or duplicate journal sequence.');
      previous = value.seq;
      this.apply(kind, value);
    }
    this.seq = previous + 1;
  }

  apply(kind, entry) {
    if (kind === 'main') {
      if (entry.i !== this.roots.length || typeof entry.text !== 'string' || !['user', 'talk', 'tool', 'echo', 'note'].includes(entry.kind)) throw new Error('Invalid log entry or noncontiguous message IDs.');
      this.roots.push(entry);
      this.view.push({ l: 0, i: entry.i });
    } else {
      if (!Number.isSafeInteger(entry.l) || entry.l < 0 || entry.l > 50 || !Number.isSafeInteger(entry.i) || entry.i < 0 || end(entry) > this.roots.length || typeof entry.text !== 'string' || !entry.text.trim() || this.nodes.has(key(entry.l, entry.i))) throw new Error('Invalid or duplicate summary.');
      if (entry.l && (!this.node(entry.l - 1, entry.i * 2) || !this.node(entry.l - 1, entry.i * 2 + 1))) throw new Error('Summary has missing children.');
      this.nodes.set(key(entry.l, entry.i), entry);
    }
    this.fit();
  }

  append(kind, text, metadata = {}) {
    if (this.closed) throw new Error('Store is closed.');
    const entry = { ...metadata, i: this.roots.length, kind, text, size: bytes(`${kind}: ${text}`), date: new Date().toISOString(), seq: this.seq++ };
    durableAppend(path.join(this.directory, 'main', `${localDay(entry.date)}.jsonl`), entry);
    this.apply('main', entry);
    return entry;
  }

  saveNode(l, i, text) {
    if (this.closed || this.node(l, i)) throw new Error('Store closed or summary already built.');
    const entry = { l, i, text, size: bytes(text), seq: this.seq++ };
    durableAppend(path.join(this.directory, 'tree', `${localDay(Date.now())}.jsonl`), entry);
    this.apply('tree', entry);
  }

  node(l, i) { return this.nodes.get(key(l, i)); }
  text(p) { return this.node(p.l, p.i)?.text ?? '(not summarized yet: zoom it)'; }
  size() { return this.view.reduce((n, p) => n + bytes(this.text(p)), 0); }
  ready() { return this.view.every(p => this.node(p.l, p.i)) && this.size() <= this.budget; }
  first() { return start(this.view.find(p => !this.node(p.l, p.i)) ?? { l: 0, i: this.roots.length }); }

  fit() {
    let size = this.size();
    while (size > this.budget) {
      let best = -1, due = -1;
      for (let j = 0; j + 1 < this.view.length; j++) {
        const a = this.view[j], b = this.view[j + 1];
        if (a.l !== b.l || a.i % 2 || b.i !== a.i + 1 || !this.node(a.l + 1, a.i / 2)) continue;
        const weight = (this.roots.length - start(a)) / 2 ** (a.l + 2);
        if (weight > due) { due = weight; best = j; }
      }
      if (best < 0) break;
      const a = this.view[best], b = this.view[best + 1];
      const parent = { l: a.l + 1, i: a.i / 2 };
      size += bytes(this.text(parent)) - bytes(this.text(a)) - bytes(this.text(b));
      this.view.splice(best, 2, parent);
    }
  }

  render({ ids = true, before = Infinity } = {}) {
    const parts = this.view.filter(p => end(p) <= before);
    if (parts.some(p => !this.node(p.l, p.i))) throw new Error('Cannot expose an unfinished memory view.');
    return '<chat>\n' + parts.map(p => `${ids ? `${start(p)}+${2 ** p.l}|` : ''}${this.text(p).replace(/\r?\n/g, ' ')}`).join('\n') + '\n</chat>';
  }

  zoom(id, n) {
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(n) || n < 1 || !Number.isInteger(Math.log2(n)) || id % n || id + n > this.roots.length) throw new Error('No such aligned id+n range.');
    if (n === 1) { const row = this.roots[id]; return `${id}+0|${row.kind}: ${row.text}`; }
    const l = Math.log2(n) - 1;
    return [id, id + n / 2].map(j => {
      const node = this.node(l, j / (n / 2));
      if (!node) throw new Error('Summary is still being built.');
      return `${j}+${n / 2}|${node.text}`;
    }).join('\n');
  }

  date(id) {
    if (!Number.isSafeInteger(id) || !this.roots[id]) throw new Error('No such message.');
    return new Date(this.roots[id].date).toString();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await new Promise(resolve => this.lock.close(resolve));
  }
}

function durableNewline(file) {
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
