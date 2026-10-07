import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const originalSpawn = childProcess.spawn;
const spawned = [];
let mode = '';
childProcess.spawn = function(command, args, options) {
  const child = mode === 'spawn-fail'
    ? originalSpawn('/nonexistent/diagnostic-fake-codex', [], options)
    : originalSpawn(process.execPath, [fileURLToPath(new URL('./fixtures/cleanup-proxy.mjs', import.meta.url)), mode], options);
  spawned.push(child);
  return child;
};
syncBuiltinESMExports();
const { withClient, AppServerClient } = await import('../src/app-server-client.mjs');
function fdCount() {
  if (process.platform === 'linux') return readdirSync('/proc/self/fd').length;
  const raw = childProcess.execFileSync('lsof', ['-n', '-P', '-a', '-p', String(process.pid), '-F', 'f'], { encoding: 'utf8' });
  return raw.split('\n').filter(x => /^f\d+$/.test(x)).length;
}
const results = [];
let successful = false;
try {
  for (mode of ['bad-handshake', 'early-close', 'timeout']) {
    const baseline = fdCount();
    const observations = [];
    for (let i = 0; i < (mode === 'timeout' ? 2 : 5); i++) {
      await assert.rejects(withClient('/never-used-fake-socket', async () => {}));
      assert.equal(spawned.filter(c => c.exitCode === null && c.signalCode === null).length, 0, 'failed call must await proxy exit');
      observations.push({ attempt: i + 1, live_fake_children: 0, fd_count: fdCount() });
    }
    assert.ok(observations.at(-1).fd_count <= baseline + 1, 'FD count must stabilize after failures');
    results.push({ mode, baseline_fds: baseline, observations });
  }
  mode = 'normal';
  assert.deepEqual(await withClient('/never-used-fake-socket', client => client.request('test/echo')), { ok: true });
  assert.equal(spawned.filter(c => c.exitCode === null && c.signalCode === null).length, 0);
  results.push({ mode, live_fake_children: 0, fd_count: fdCount() });
  mode = 'ignore-term';
  await assert.rejects(withClient('/never-used-fake-socket', async () => {}), /WebSocket upgrade failed/);
  assert.equal(spawned.at(-1).signalCode, 'SIGKILL', 'uncooperative owned proxy must be reaped');
  results.push({ mode, live_fake_children: 0, fd_count: fdCount() });
  mode = 'spawn-fail';
  await assert.rejects(withClient('/never-used-fake-socket', async () => {}));
  results.push({ mode, fd_count: fdCount() });
  mode = 'timeout';
  const client = new AppServerClient({ socket: '/never-used-fake-socket' });
  const readyRejection = assert.rejects(client.ready, /closed before upgrade/);
  const firstClose = client.close();
  assert.equal(client.close(), firstClose, 'concurrent closes share one cleanup promise');
  await firstClose;
  await readyRejection;
  assert.equal(spawned.filter(c => c.exitCode === null && c.signalCode === null).length, 0);
  results.push({ mode: 'explicit-concurrent-close', live_fake_children: 0, fd_count: fdCount() });
  successful = true;
} finally {
  // Terminate only this test's disposable fake children, even if an assertion fails.
  for (const child of spawned) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const done = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGKILL');
    await done;
  }
}
console.log(JSON.stringify({ successful, results }, null, 2));
