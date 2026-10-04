import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { MASTER } from './prompts.mjs';
import { cachePayload, capText, messageEntries } from './cache.mjs';

export function findPiRoot(explicit = process.env.OPI_PI_ROOT) {
  if (explicit) return path.resolve(explicit);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const bin = path.join(dir, 'pi');
    if (!fs.existsSync(bin)) continue;
    let candidate = path.dirname(fs.realpathSync(bin));
    for (let level = 0; level < 5; level++) {
      const pkg = path.join(candidate, 'package.json');
      if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, 'utf8')).name === '@earendil-works/pi-coding-agent') return candidate;
      candidate = path.dirname(candidate);
    }
  }
  throw new Error('Pi SDK not found. Install @earendil-works/pi-coding-agent@0.87.1 with npm, or set OPI_PI_ROOT to its package directory.');
}

export async function loadPi(explicit) {
  const root = findPiRoot(explicit);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== '0.87.1') throw new Error(`opi is tested against Pi 0.87.1; found ${pkg.version}. Set OPI_PI_ROOT to a 0.87.1 installation. This check protects context and logging contracts.`);
  return { sdk: await import(pathToFileURL(path.join(root, 'dist/index.js')).href), root, version: pkg.version };
}

export function memoryTools(store) {
  const result = text => ({ content: [{ type: 'text', text }], details: {} });
  return [{
    name: 'zoom', label: 'Zoom memory',
    description: 'Open memory line id+n into its two children; n=1 retrieves the original message. Large originals are paginated; use the returned offset to continue.',
    parameters: { type: 'object', properties: { id: { type: 'integer', minimum: 0 }, n: { type: 'integer', minimum: 1 }, offset: { type: 'integer', minimum: 0 } }, required: ['id', 'n'], additionalProperties: false },
    async execute(_id, { id, n, offset = 0 }) {
      const text = store.zoom(id, n);
      if (offset >= text.length && offset !== 0) throw new Error('Offset is past the end of the message.');
      let finish = Math.min(offset + 28000, text.length);
      if (finish < text.length && /[\uD800-\uDBFF]/.test(text[finish - 1])) finish--;
      return result(text.slice(offset, finish) + (finish < text.length ? `\n[More: zoom(${id}, ${n}, offset=${finish})]` : ''));
    },
  }, {
    name: 'date', label: 'Memory date', description: 'Get the local date and time of a memory message, or the current time when id is omitted.',
    parameters: { type: 'object', properties: { id: { type: 'integer', minimum: 0 } }, additionalProperties: false },
    async execute(_id, { id }) { return result(id === undefined ? new Date().toString() : store.date(id)); },
  }];
}

export function memoryExtension(view, systemSuffix = MASTER, api = 'anthropic-messages') {
  return pi => {
    pi.on('before_agent_start', event => ({ systemPrompt: `${event.systemPrompt}\n\n${systemSuffix}` }));
    pi.on('context', event => {
      const messages = [...event.messages];
      const index = messages.findIndex(m => m.role === 'user');
      if (index < 0) throw new Error('Fresh OptChat turn has no user message.');
      const first = messages[index];
      const content = typeof first.content === 'string' ? [{ type: 'text', text: first.content }] : first.content;
      messages[index] = { ...first, content: [{ type: 'text', text: view }, ...content] };
      return { messages };
    });
    pi.on('before_provider_request', event => api === 'anthropic-messages' ? cachePayload(event.payload) : event.payload);
    pi.on('cache_warming_decision', () => ({ action: 'stop' }));
    pi.on('tool_result', event => {
      if (event.toolName === 'zoom' || event.toolName === 'date') return;
      const text = event.content.map(p => p.type === 'text' ? p.text : '[Non-text tool result omitted by text-only OptChat]').join('\n');
      return { content: [{ type: 'text', text: capText(text) }] };
    });
    pi.on('session_before_compact', () => ({ cancel: true }));
  };
}

export async function createPiBackend({ sdk, cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), model: choice, compactModel, thinking = 'medium', tools, runtime, onText = text => process.stdout.write(text), onTool = () => {}, onUsage = () => {} } = {}) {
  const settings = sdk.SettingsManager.create(cwd, agentDir);
  settings.applyOverrides({ compaction: { enabled: false }, cacheWarming: 'off' });
  runtime ??= await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json') });
  function resolve(name) {
    const slash = name.indexOf('/');
    if (slash < 1) throw new Error(`Use an exact provider/model ID, got: ${name}`);
    const model = runtime.getModel(name.slice(0, slash), name.slice(slash + 1));
    if (!model) throw new Error(`Model not found in Pi: ${name}. Run pi --list-models to see available models.`);
    return model;
  }
  let model;
  if (choice) model = resolve(choice);
  else {
    const provider = settings.getDefaultProvider(), id = settings.getDefaultModel();
    if (provider && id) model = runtime.getModel(provider, id);
    if (!model) throw new Error('Choose --model provider/model (or configure a valid default in Pi).');
  }
  const compressor = compactModel ? resolve(compactModel) : model;
  for (const selected of [model, compressor]) {
    if (!runtime.hasConfiguredAuth(selected.provider) && !await runtime.checkAuth(selected.provider)) throw new Error(`No Pi credentials for ${selected.provider}; run pi and log in first.`);
  }
  return {
    model, compressor,
    async complete(context, signal) {
      return runtime.completeSimple(compressor, context, {
        signal, reasoning: 'medium', cacheRetention: 'short',
        maxTokens: 8192, onPayload: payload => compressor.api === 'anthropic-messages' ? cachePayload(payload) : payload,
      });
    },
    async session(view, store, compactor) {
      // Native extensions may rely on one long-lived TUI/session. Only our memory
      // extension is loaded; normal context files and skills remain discoverable.
      const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
        noExtensions: true, noThemes: true, noPromptTemplates: true,
        extensionFactories: [memoryExtension(view, MASTER, model.api)],
      });
      await loader.reload();
      const errors = loader.getExtensions().errors;
      if (errors.length) throw new Error(`Memory extension failed to load: ${JSON.stringify(errors)}`);
      const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime,
        model, thinkingLevel: thinking, settingsManager: settings, resourceLoader: loader,
        sessionManager: sdk.SessionManager.inMemory(cwd), customTools: memoryTools(store),
        ...(tools ? { tools: [...new Set([...tools, 'zoom', 'date'])] } : {}),
      });
      let firstUser = true;
      let failure;
      session.subscribe(event => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') onText(event.assistantMessageEvent.delta);
        if (event.type === 'tool_execution_start') onTool(event.toolName);
        if (event.type !== 'message_end') return;
        if (event.message.role === 'assistant') {
          onUsage(event.message.usage);
          if (event.message.stopReason === 'error') failure = event.message.errorMessage || 'Model request failed.';
        }
        if (event.message.role === 'user' && firstUser) { firstUser = false; return; }
        try {
          for (const row of messageEntries(event.message)) store.append(row.kind, row.text);
          compactor.pump();
        } catch (error) { failure = error.message; void session.abort(); }
      });
      return { session, check: () => { if (failure) throw new Error(failure); } };
    },
  };
}
