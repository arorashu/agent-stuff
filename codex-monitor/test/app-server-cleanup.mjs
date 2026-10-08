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
const { withClient, AppServerClient, RpcError } = await import('../src/app-server-client.mjs');
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

  // Bug 1: an indefinite waitForNotification (no timeoutMs) must not reject
  // immediately and must resolve when the notification arrives; a closed
  // client rejects new waits that have no cached match; finite timeouts
  // still reject.
  mode = 'notify';
  {
    const client = new AppServerClient({ socket: '/never-used-fake-socket' });
    await client.ready;
    const wait = client.waitForNotification((message) => message.method === 'test/notify');
    const pendingOutcome = await Promise.race([
      wait.then(() => 'resolved').catch(() => 'rejected'),
      new Promise((r) => setTimeout(() => r('pending'), 400)),
    ]);
    assert.equal(pendingOutcome, 'pending', 'indefinite wait must not reject immediately');
    await client.request('push-notify', {}, 5000);
    const arrived = await Promise.race([
      wait.then(() => 'resolved').catch(() => 'rejected'),
      new Promise((r) => setTimeout(() => r('not-arrived'), 5000)),
    ]);
    assert.equal(arrived, 'resolved', 'indefinite wait must resolve on notification delivery');
    await client.close();
    await assert.rejects(
      client.waitForNotification((message) => message.method === 'never-sent'),
      /client is closed/,
      'wait after close must reject when no cached notification matches',
    );
    // Cache-first is preserved after close: a matching cached notification
    // still resolves.
    await client.waitForNotification((message) => message.method === 'test/notify');
    const client2 = new AppServerClient({ socket: '/never-used-fake-socket' });
    await client2.ready;
    await assert.rejects(client2.waitForNotification(() => false, 100), /Timed out/);
    await client2.close();
    // null behaves like undefined: indefinite, no immediate rejection, and
    // close-during-wait rejects the registered waiter via #rejectAll.
    const client3 = new AppServerClient({ socket: '/never-used-fake-socket' });
    await client3.ready;
    const nullWait = client3.waitForNotification(() => false, null);
    const nullOutcome = await Promise.race([
      nullWait.then(() => 'resolved').catch(() => 'rejected'),
      new Promise((r) => setTimeout(() => r('pending'), 200)),
    ]);
    assert.equal(nullOutcome, 'pending', 'null timeout waits indefinitely');
    await client3.close();
    await nullWait.then(
      () => assert.fail('null wait resolved after close'),
      (err) => assert.match(err.message, /closing|closed/),
    );
    // Validation matrix: zero is an immediate timeout; non-finite/negative and
    // non-number values reject with TypeError; oversized finite values are
    // accepted by validation but clamped by Node to a near-immediate timer.
    const client4 = new AppServerClient({ socket: '/never-used-fake-socket' });
    await client4.ready;
    await assert.rejects(client4.waitForNotification(() => false, 0), /Timed out/);
    for (const bad of ['fast', NaN, -1, Infinity]) {
      await assert.rejects(client4.waitForNotification(() => false, bad), TypeError);
    }
    const hugeOutcome = await Promise.race([
      client4.waitForNotification(() => false, 2 ** 32).then(() => 'resolved').catch(() => 'rejected'),
      new Promise((r) => setTimeout(() => r('pending'), 5000)),
    ]);
    assert.equal(hugeOutcome, 'rejected', 'oversized finite timeout degrades via Node clamp, not a validation pass-through');
    await client4.close();
    results.push({ mode: 'indefinite-wait', live_fake_children: 0, fd_count: fdCount() });
  }

  // Bug 2: close-before-await-ready must survive under strict unhandled
  // rejections; run in a subprocess so a regression cannot kill this script
  // before its cleanup finally block.
  {
    const idleProxy = fileURLToPath(new URL('./fixtures/idle-proxy.mjs', import.meta.url));
    const out = childProcess.execFileSync(process.execPath, [
      '--unhandled-rejections=strict',
      fileURLToPath(new URL('./ready-unhandled-rejection.mjs', import.meta.url)),
    ], { encoding: 'utf8', env: { ...process.env, CODEX_MONITOR_CODEX_BIN: idleProxy }, timeout: 20000 });
    assert.match(out, /ready-unhandled-rejection: ok/);
    results.push({ mode: 'ready-unhandled-rejection-subprocess', exit_code: 0 });
  }

  // Bug 4: withClient must preserve the original operation error (identity,
  // prototype, primitives) when close also fails, and still surface the close
  // error when the operation succeeded. The patched close awaits the real
  // close first so fixture proxies are disposed properly.
  {
    const originalClose = AppServerClient.prototype.close;
    AppServerClient.prototype.close = function closeWithFailure() {
      return originalClose.call(this).then(() => { throw new Error('close boom'); });
    };
    try {
      mode = 'normal';
      await assert.rejects(
        withClient('/never-used-fake-socket', async () => { throw new Error('fn boom'); }),
        (err) => {
          assert.ok(err instanceof Error, 'original Error identity preserved');
          assert.ok(/fn boom/.test(err.message), 'original message preserved');
          assert.ok(err.cause instanceof Error && /close boom/.test(err.cause.message), 'cause is the close error');
          return true;
        },
      );
      mode = 'normal';
      let primitiveError = 'unset';
      await withClient('/never-used-fake-socket', async () => { throw null; }).catch((err) => {
        primitiveError = err;
      });
      assert.equal(primitiveError, null, 'primitive rejection values are rethrown as-is');
      mode = 'normal';
      await assert.rejects(withClient('/never-used-fake-socket', async () => 'ok'), /close boom/);
      // Frozen Error: the best-effort cause annotation must not throw; the
      // exact frozen error is rethrown.
      mode = 'normal';
      const frozen = Object.freeze(new Error('frozen boom'));
      let frozenError = 'unset';
      await withClient('/never-used-fake-socket', async () => { throw frozen; }).catch((err) => {
        frozenError = err;
      });
      assert.equal(frozenError, frozen, 'frozen Error rethrown as-is without annotation throw');
      // RpcError identity survives for delivery-code instanceof checks.
      mode = 'normal';
      const rpc = new RpcError('rpc boom');
      let rpcError = 'unset';
      await withClient('/never-used-fake-socket', async () => { throw rpc; }).catch((err) => {
        rpcError = err;
      });
      assert.equal(rpcError, rpc, 'RpcError identity preserved');
      assert.ok(rpcError instanceof RpcError);
      // Pre-existing cause is never overwritten by the close error.
      mode = 'normal';
      const withCause = new Error('outer boom');
      withCause.cause = new Error('original cause');
      let causeError = 'unset';
      await withClient('/never-used-fake-socket', async () => { throw withCause; }).catch((err) => {
        causeError = err;
      });
      assert.equal(causeError, withCause);
      assert.equal(causeError.cause.message, 'original cause', 'pre-existing cause preserved');
      mode = 'bad-handshake';
      await assert.rejects(
        withClient('/never-used-fake-socket', async () => 'never'),
        /WebSocket upgrade failed/,
        'initialization failure propagates ahead of the close failure',
      );
    } finally {
      AppServerClient.prototype.close = originalClose;
    }
    results.push({ mode: 'withclient-error-preservation', ok: true });
  }

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
