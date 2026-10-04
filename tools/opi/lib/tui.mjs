import { memoryExtension, memoryTools, protectMemorySettings } from './pi.mjs';
import { messageEntries } from './cache.mjs';
import { MASTER } from './prompts.mjs';

// The UI retains its transcript for scrollback. Only the model request is reset:
// a consolidated current system/tool declaration, frozen memory, and this turn.
export async function createTuiRuntime(backend, store, compactor, getCurrentSystemMessage) {
  const { sdk, settings, runtime, cwd, agentDir, model, thinking, tools } = backend;
  let session, ui, view, firstUser, failure, waiting, closed = false;
  let promptQueue = Promise.resolve();
  const status = () => ui?.setStatus('optchat', `OptChat · ${store.roots.length} messages · ${compactor.pendingCount()} pending`);
  const notify = error => ui?.notify(error.message ?? String(error), 'error');
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    waiting?.abort(new Error('OptChat is closing.'));
    for (const text of session?.getSteeringMessages() ?? []) store.append('user', text, { unanswered: true });
    compactor.off('change', status);
    await compactor.close();
    await store.close();
  };
  const extension = pi => {
    memoryExtension(null, MASTER, model.api)(pi);
    pi.on('session_start', (_event, ctx) => { ui = ctx.ui; status(); });
    pi.on('before_agent_start', () => {
      // Failure here must also stop transformContext: extension hook errors are
      // normally reported rather than fatal in Pi.
      view = undefined;
      firstUser = undefined;
      failure = undefined;
      view = store.render();
    });
    pi.on('session_shutdown', cleanup);
    const blockBranch = (_event, ctx) => {
      ctx.ui.notify('OptChat uses one persistent history. Start opi --memory DIR for a different chat.', 'info');
      return { cancel: true };
    };
    for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree']) pi.on(event, blockBranch);
    pi.registerCommand('memory', {
      description: 'OptChat status, view, zoom ID N, or flush',
      handler: async (args, ctx) => {
        const [command = 'status', a, b] = (args.trim() || 'status').split(/\s+/);
        if (command === 'flush') {
          waiting = new AbortController();
          try { await compactor.settle(waiting.signal, { all: true }); }
          finally { waiting = undefined; }
          ctx.ui.notify('All memory summaries saved.', 'info');
        } else if (command === 'view' || command === 'zoom') {
          const text = command === 'view' ? store.render() : store.zoom(Number(a), Number(b));
          await ctx.ui.editor('OptChat memory (read-only; edits are discarded)', text);
        } else if (command === 'status') {
          ctx.ui.notify(JSON.stringify({ directory: store.directory, messages: store.roots.length,
            pending: compactor.pendingCount(), viewBytes: store.size(), compactor: compactor.stats }, null, 2), 'info');
        } else throw new Error('Use /memory status, /memory view, /memory zoom ID N, or /memory flush.');
      },
    });
  };
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    noExtensions: true, noPromptTemplates: true, extensionFactories: [extension],
  });
  protectMemorySettings(loader, settings);
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length) throw new Error(`OptChat UI extension failed: ${JSON.stringify(errors)}`);
  const created = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model,
    thinkingLevel: thinking, settingsManager: settings, resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(cwd), customTools: memoryTools(store),
    ...(tools ? { tools: [...new Set([...tools, 'zoom', 'date'])] } : {}),
  });
  session = created.session;
  const originalPrompt = session.prompt.bind(session);
  const originalAbort = session.abort.bind(session);
  session.abort = async () => { waiting?.abort(new Error('Memory wait cancelled.')); await originalAbort(); };
  session.prompt = (text, options) => {
    if (session.isStreaming || text.startsWith('/')) return originalPrompt(text, options);
    const run = async () => {
      if (closed) throw new Error('OptChat is closed.');
      let submitted = false;
      waiting = new AbortController();
      try {
        ui?.setWorkingMessage('Preparing OptChat memory…');
        await compactor.settle(waiting.signal);
        waiting.signal.throwIfAborted();
        waiting = undefined;
        ui?.setWorkingMessage();
        submitted = true;
        await originalPrompt(text, options);
      } catch (error) {
        if (!submitted) { store.append('user', text, { unanswered: true }); compactor.pump(); }
        throw error;
      } finally { waiting = undefined; ui?.setWorkingMessage(); }
    };
    const result = promptQueue.then(run, run);
    promptQueue = result.catch(() => {});
    return result;
  };
  session.subscribe(event => {
    if (event.type !== 'message_end') return;
    if (event.message.role === 'user' && !firstUser) firstUser = structuredClone(event.message);
    try {
      for (const row of messageEntries(event.message)) store.append(row.kind, row.text);
      compactor.pump();
      status();
    } catch (error) { failure = error; notify(error); void session.abort(); }
  });
  const originalTransform = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    signal?.throwIfAborted();
    if (failure) throw failure;
    if (!view || !firstUser) throw new Error('OptChat turn was not initialized; refusing to send the full UI transcript.');
    const index = messages.findIndex(m => m.role === 'user' && m.timestamp === firstUser.timestamp
      && JSON.stringify(m.content) === JSON.stringify(firstUser.content));
    if (index < 0) throw new Error('Cannot find the current OptChat turn boundary.');
    const system = getCurrentSystemMessage(messages);
    if (!system) throw new Error('Pi did not supply a system/tool declaration.');
    const current = messages.slice(index).filter(m => m.role !== 'system');
    const content = typeof current[0].content === 'string' ? [{ type: 'text', text: current[0].content }] : current[0].content;
    current[0] = { ...current[0], content: [{ type: 'text', text: view }, ...content] };
    const context = [system, ...current];
    return originalTransform ? originalTransform(context, signal) : context;
  };
  compactor.on('change', status);
  compactor.report = message => ui ? ui.notify(message, 'error') : console.error(message);
  const services = { cwd, agentDir, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, diagnostics: [] };
  const host = new sdk.AgentSessionRuntime(session, services, async () => { throw new Error('OptChat does not replace its UI history with ordinary Pi sessions.'); });
  return { host, session, cleanup };
}
