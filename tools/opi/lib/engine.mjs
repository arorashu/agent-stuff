export class Engine {
  constructor(store, compactor, backend) {
    this.store = store;
    this.compactor = compactor;
    this.backend = backend;
    this.active = null;
    this.controller = null;
  }

  async run(text) {
    if (this.controller) throw new Error('A turn is already running.');
    this.controller = new AbortController();
    const signal = this.controller.signal;
    let logged = false;
    try {
      await this.compactor.settle(signal);
      signal.throwIfAborted();
      const view = this.store.render(); // Snapshot before appending the new user message.
      this.store.append('user', text);
      logged = true;
      this.compactor.pump();
      const handle = await this.backend.session(view, this.store, this.compactor);
      this.active = handle.session;
      signal.throwIfAborted();
      await this.active.prompt(text, { expandPromptTemplates: false });
      handle.check();
      signal.throwIfAborted();
    } finally {
      // A cancelled settle or failed setup must not silently lose user input.
      if (!logged) { this.store.append('user', text, { unanswered: true }); this.compactor.pump(); }
      if (this.active) {
        for (const pending of this.active.getSteeringMessages()) this.store.append('user', pending, { unanswered: true });
        this.active.dispose();
      }
      this.active = null;
      this.controller = null;
    }
  }

  async steer(text) {
    if (!this.active?.isStreaming) return false;
    await this.active.steer(text, undefined, { expandPromptTemplates: false });
    return true;
  }

  async abort() {
    this.controller?.abort(new Error('Turn cancelled; accepted text remains in the log.'));
    await this.active?.abort();
  }
}
