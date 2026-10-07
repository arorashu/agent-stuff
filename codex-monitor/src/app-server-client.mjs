import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class RpcError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "RpcError";
    this.detail = detail;
  }
}

class WebSocketOverStdio {
  constructor({ input, output, onMessage, onError, onClose, timeoutMs = 10000 }) {
    this.input = input;
    this.output = output;
    this.onMessage = onMessage;
    this.onError = onError;
    this.onClose = onClose;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.connected = false;
    this.closed = false;
    this.handshakeKey = null;
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.timer = null;

    this.input.on("error", (err) => this.#handleError(err));
    this.output.on("data", (chunk) => this.#handleData(chunk));
    this.output.on("close", () => this.#handleClose());
    this.output.on("error", (err) => this.#handleError(err));
  }

  connect() {
    if (this.connectPromise) return this.connectPromise;
    this.handshakeKey = randomBytes(16).toString("base64");
    this.connectPromise = new Promise((resolvePromise, rejectPromise) => {
      this.connectResolve = resolvePromise;
      this.connectReject = rejectPromise;
      this.timer = setTimeout(() => {
        this.#handleError(new Error(`Timed out waiting for WebSocket upgrade after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    const request = [
      "GET / HTTP/1.1",
      "Host: localhost",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${this.handshakeKey}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n");
    this.input.write(request, "latin1", (err) => {
      if (err) this.#handleError(err);
    });
    return this.connectPromise;
  }

  sendText(text) {
    if (this.closed) throw new Error("WebSocket transport is closed");
    this.#sendFrame(0x1, Buffer.from(text, "utf8"));
  }

  close() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.closed) return;
    this.closed = true;
    this.connectReject?.(new Error("WebSocket transport closed before upgrade completed"));
    try {
      if (this.connected) this.#sendFrame(0x8, Buffer.alloc(0));
    } catch {
      // Best effort close.
    }
    this.input.end();
  }

  #handleData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.connected) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const response = this.buffer.subarray(0, headerEnd + 4).toString("latin1");
      this.buffer = this.buffer.subarray(headerEnd + 4);
      try {
        this.#validateHandshake(response);
      } catch (err) {
        this.#handleError(err);
        return;
      }
      this.connected = true;
      clearTimeout(this.timer);
      this.timer = null;
      this.connectResolve?.();
    }
    this.#parseFrames();
  }

  #validateHandshake(response) {
    const lines = response.split("\r\n");
    const status = lines.shift() ?? "";
    if (!/^HTTP\/1\.[01] 101\b/.test(status)) {
      throw new Error(`WebSocket upgrade failed: ${status}`);
    }
    const headers = new Map();
    for (const line of lines) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
    }
    const expected = createHash("sha1").update(`${this.handshakeKey}${WS_ACCEPT_GUID}`).digest("base64");
    const actual = headers.get("sec-websocket-accept");
    if (actual !== expected) {
      throw new Error("WebSocket upgrade returned an invalid Sec-WebSocket-Accept header");
    }
  }

  #parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const bigintLength = this.buffer.readBigUInt64BE(offset);
        if (bigintLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.#handleError(new Error("WebSocket frame is too large"));
          return;
        }
        length = Number(bigintLength);
        offset += 8;
      }

      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);

      if (masked && mask) {
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i += 1) {
          unmasked[i] = payload[i] ^ mask[i % 4];
        }
        payload = unmasked;
      }

      if (opcode === 0x8) {
        this.#handleClose();
        return;
      }
      if (opcode === 0x9) {
        this.#sendFrame(0xA, payload);
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const message = Buffer.concat(this.fragments).toString("utf8");
          this.fragments = [];
          this.onMessage?.(message);
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          this.onMessage?.(payload.toString("utf8"));
        } else {
          this.fragments = [payload];
        }
      }
    }
  }

  #sendFrame(opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    const mask = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
      masked[i] = payload[i] ^ mask[i % 4];
    }
    this.input.write(Buffer.concat([header, mask, masked]));
  }

  #handleClose() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.connectReject?.(new Error("WebSocket transport closed before upgrade completed"));
    this.onClose?.();
  }

  #handleError(err) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.connectReject?.(err);
    this.onError?.(err);
    this.input.end();
  }
}

export class AppServerClient {
  constructor({ socket, timeoutMs = 30000, captureDeltas = false, clientInfo = null }) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.captureDeltas = captureDeltas;
    this.clientInfo = clientInfo ?? {
      name: "codex_background_monitor",
      title: "Codex Background Monitor",
      version: "0.2.0",
    };
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.waiters = [];
    this.agentMessageDeltas = new Map();
    this.stderr = "";
    this.closed = false;

    const codexBin = process.env.CODEX_MONITOR_CODEX_BIN ?? "codex";
    this.proc = spawn(codexBin, ["app-server", "proxy", "--sock", socket], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      if (this.stderr.length > 16000) this.stderr = this.stderr.slice(-16000);
    });
    this.proc.on("error", (err) => this.#handleClosed(err));
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      const suffix = this.stderr.trim() ? `\n${this.stderr.trim()}` : "";
      this.#rejectAll(new Error(`app-server proxy exited code=${code} signal=${signal}${suffix}`));
    });

    this.transport = new WebSocketOverStdio({
      input: this.proc.stdin,
      output: this.proc.stdout,
      onMessage: (message) => this.#handleMessage(message),
      onError: (err) => this.#handleClosed(err),
      onClose: () => this.#handleClosed(new Error("app-server proxy connection closed")),
      timeoutMs: 10000,
    });
    this.ready = this.transport.connect();
  }

  async initialize() {
    await this.ready;
    const optOutNotificationMethods = [
      "commandExecution/output/delta",
      "fileChange/output/delta",
    ];
    if (!this.captureDeltas) {
      optOutNotificationMethods.push("item/agentMessage/delta");
    }
    const response = await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods,
      },
    });
    this.notify("initialized", {});
    return response;
  }

  async request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) throw new Error("app-server proxy connection is closed");
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timed out waiting for ${method} response after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          rejectPromise(err);
        },
      });
      try {
        this.transport.sendText(JSON.stringify({ method, id, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(err);
      }
    });
  }

  notify(method, params = {}) {
    this.transport.sendText(JSON.stringify({ method, params }));
  }

  waitForNotification(predicate, timeoutMs) {
    return new Promise((resolvePromise, rejectPromise) => {
      const existing = this.notifications.find(predicate);
      if (existing) {
        resolvePromise(existing);
        return;
      }
      const waiter = {
        predicate,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          rejectPromise(new Error(`Timed out waiting for notification after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    // Protocol closure and child-process disposal are independent states.
    this.closed = true;
    this.#rejectAll(new Error("app-server client is closing"));
    this.transport.close();
    this.closePromise = new Promise((resolvePromise, rejectPromise) => {
      const proc = this.proc;
      let timer = null;
      const finish = (error = null) => {
        clearTimeout(timer);
        proc.removeListener("close", onClose);
        error ? rejectPromise(error) : resolvePromise();
      };
      const onClose = () => finish();
      proc.once("close", onClose);
      // Stream destruction releases the parent's pipe descriptors on error paths too.
      proc.stdin?.destroy();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      if (!proc.pid) {
        finish();
        return;
      }
      if (proc.exitCode !== null || proc.signalCode !== null) {
        finish();
        return;
      }
      try {
        proc.kill("SIGTERM");
      } catch (err) {
        finish(err);
        return;
      }
      timer = setTimeout(() => {
        try {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        } catch (err) {
          finish(err);
          return;
        }
        timer = setTimeout(() => {
          finish(new Error("app-server proxy did not close after SIGKILL"));
        }, 1000);
      }, 1000);
    });
    return this.closePromise;
  }

  #handleMessage(text) {
    if (!text.trim()) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.stderr += `\n[non-json websocket message] ${text}`;
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new RpcError(`${pending.method} failed: ${message.error.message}`, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const { threadId, turnId, delta } = message.params ?? {};
      const key = `${threadId ?? ""}:${turnId ?? ""}`;
      this.agentMessageDeltas.set(key, `${this.agentMessageDeltas.get(key) ?? ""}${delta ?? ""}`);
    }
    this.notifications.push(message);
    if (this.notifications.length > 500) this.notifications.shift();
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        waiter.resolve(message);
      }
    }
  }

  #rejectAll(err) {
    for (const [, pending] of this.pending) pending.reject(err);
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.waiters = [];
  }

  #handleClosed(err) {
    if (this.closed) return;
    this.closed = true;
    this.#rejectAll(err);
  }
}

export async function withClient(socket, fn, options = {}) {
  const client = new AppServerClient({ socket, ...options });
  try {
    await client.initialize();
    return await fn(client);
  } finally {
    await client.close();
  }
}
