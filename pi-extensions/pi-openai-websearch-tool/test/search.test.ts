import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import openaiWebsearchTool, { logCompletedSearch, readSearchStream, safeText, searchCodex } from "../index.ts";

const search = { type: "response.output_item.done", item: { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", sources: [{ url: "https://python.org/x", type: "url" }] } } };
const message = { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Answer", annotations: [{ type: "url_citation", url: "https://python.org/x", title: "Python" }] }] } };
const terminal = { type: "response.done", response: { status: "completed", model: "gpt-5.5", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 3 } } } };

function sse(events: object[], eol = "\n", chunkSize = Infinity) {
  const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}${eol}${eol}`).join(""));
  return new ReadableStream<Uint8Array>({ start(c) { for (let i=0; i<bytes.length; i+=chunkSize) c.enqueue(bytes.slice(i,i+chunkSize)); c.close(); } });
}
function token() {
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url");
  return `header.${claims}.sig`;
}

test("accepts completed response and accounts for nested token usage", async () => {
  let completed = 0;
  const result = await readSearchStream(sse([search, message, terminal]), undefined, () => completed++);
  assert.equal(completed, 1);
  assert.equal(result.searchCalls, 1);
  assert.equal(result.answer, "Answer");
  assert.deepEqual(result.sources, [{ url: "https://python.org/x", title: "Python" }]);
  assert.deepEqual([result.usage?.input, result.usage?.cacheRead, result.usage?.output, result.usage?.totalTokens], [7,3,5,15]);
});

test("requires successful terminal response, a search call and an answer", async () => {
  await assert.rejects(readSearchStream(sse([search])), /ended before/);
  await assert.rejects(readSearchStream(sse([message, terminal])), /no completed web_search_call/);
  await assert.rejects(readSearchStream(sse([search, terminal])), /no answer/);
  await assert.rejects(readSearchStream(sse([search, message, { type: "response.incomplete", response: { status: "incomplete" } }])), /not complete/);
  await assert.rejects(readSearchStream(sse([search, message, { type: "response.done", response: { status: "failed" } }])), /not complete/);
  await assert.rejects(readSearchStream(sse([search, message, { type: "response.failed", response: { error: { message: "PRIVATE_TOKEN" } } }])), /not complete/);
});

test("parses LF and CRLF independent of chunk boundaries", async () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    for (const chunkSize of [1, 3, 1048576]) {
      const result = await readSearchStream(sse([search, message, terminal], eol, chunkSize));
      assert.equal(result.searchCalls, 1, `eol=${JSON.stringify(eol)}, chunkSize=${chunkSize}`);
    }
  }
});

test("deduplicates search call ids and rejects malformed and oversized events", async () => {
  const result = await readSearchStream(sse([search, search, message, terminal]));
  assert.equal(result.searchCalls, 1);
  const bad = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("data: secret is not JSON\n\n")); c.close(); } });
  await assert.rejects(readSearchStream(bad), /Malformed Codex search stream/);
  await assert.rejects(readSearchStream(sse([{ padding: "X".repeat(510000) }])), /event too large/);
});

test("successful response.completed stops a held-open stream", async () => {
  let cancelled = false;
  const frames = new TextEncoder().encode([search, message,
    { type: "response.completed", response: { status: "completed" } }]
    .map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(frames); }, cancel() { cancelled = true; } });
  const result = await readSearchStream(body);
  assert.equal(result.searchCalls, 1);
  assert.equal(cancelled, true);
});

test("rejects oversized multiline SSE events and marks truncated answers", async () => {
  const event = JSON.stringify({ type: "response.created", padding: "x".repeat(600000) });
  const bytes = new TextEncoder().encode(`data: ${event.slice(0,300000)}\ndata: ${event.slice(300000)}\n\n`);
  await assert.rejects(readSearchStream(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } })), /event too large/);
  const bigMessage = { ...message, item: { ...message.item, content: [{ type: "output_text", text: "a".repeat(12005) }] } };
  const result = await readSearchStream(sse([search, bigMessage, terminal]));
  assert.equal(result.answer.length, 12000);
  assert.equal(result.answerTruncated, true);
});

test("handles pre-aborted stream without waiting for bytes", async () => {
  const ac = new AbortController(); ac.abort();
  const idle = new ReadableStream<Uint8Array>({ start() {} });
  await assert.rejects(readSearchStream(idle, ac.signal), /cancelled or timed out/);
});

test("sanitizes terminal controls and filters dangerous URLs", async () => {
  const dangerous = { ...search, item: { ...search.item, action: { ...search.item.action, sources: [{ url: "javascript:alert(1)" }, { url: "https://python.org/\x1b]52;c;BAD\x07" }] } } };
  const injectedMessage = { ...message, item: { ...message.item, content: [{ type: "output_text", text: "Hi\x1b]52;c;SECRET\x07! \x1b[2J", annotations: [] }] } };
  const result = await readSearchStream(sse([dangerous, injectedMessage, terminal]));
  assert.equal(result.answer, "Hi!");
  assert.deepEqual(result.sources, []);
  assert.equal(safeText("x\x1b]52;c;secret\x07y\x1b[2J"), "xy");
});

test("OAuth request uses Codex backend, hosted search required, no transcript or token in body", async () => {
  let requestBody: Record<string, any> = {};
  const mockFetch: typeof fetch = async (input, init) => {
    assert.equal(input, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "acct-1");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token()}`);
    requestBody = JSON.parse(init?.body as string);
    return new Response(sse([search, message, terminal]), { status: 200 });
  };
  const result = await searchCodex("What changed?", token(), "gpt-5.5", undefined, undefined, mockFetch);
  assert.equal(result.searchCalls, 1);
  assert.equal(requestBody.model, "gpt-5.5");
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.tool_choice, "required");
  assert.deepEqual(requestBody.tools, [{ type: "web_search" }]);
  assert.equal(requestBody.input[0].content, "What changed?");
  assert.ok(!JSON.stringify(requestBody).includes(token()));
});

test("registered tool executes with a local main model and reports usage", async () => {
  let tool: any;
  openaiWebsearchTool({ registerTool(x: unknown) { tool=x; } } as any);
  assert.equal(tool.name, "openai_search");
  const original = globalThis.fetch;
  const oldLog = process.env.OPENAI_SEARCH_TOOL_LOG_FILE;
  const dir = mkdtempSync(join(tmpdir(), "pi-openai-websearch-execute-"));
  process.env.OPENAI_SEARCH_TOOL_LOG_FILE = join(dir, "search.jsonl");
  globalThis.fetch = (async () => new Response(sse([search, message, terminal]), { status: 200 })) as typeof fetch;
  try {
    const ctx = { model: { provider: "local-lab", id: "qwen3.8-27b-nvfp4a16" }, modelRegistry: { getApiKeyForProvider: async (provider: string) => { assert.equal(provider, "openai-codex"); return token(); } } };
    const result = await tool.execute("call-1", { query: "What changed?" }, undefined, undefined, ctx);
    assert.equal(result.details.searchCalls, 1);
    assert.equal(result.usage.input, 7);
    assert.equal(ctx.model.provider, "local-lab");
    assert.equal(JSON.parse(readFileSync(process.env.OPENAI_SEARCH_TOOL_LOG_FILE, "utf8")).search_calls, 1);
  } finally {
    globalThis.fetch = original;
    if (oldLog === undefined) delete process.env.OPENAI_SEARCH_TOOL_LOG_FILE;
    else process.env.OPENAI_SEARCH_TOOL_LOG_FILE = oldLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("call and result renderers handle partial arguments and strip terminal controls", () => {
  let tool: any;
  openaiWebsearchTool({ registerTool(x: unknown) { tool=x; } } as any);
  const theme = { fg: (_kind: string, value: string) => value, bold: (value: string) => value };
  assert.doesNotThrow(() => tool.renderCall({}, theme).render(80));
  const query = tool.renderCall({ query: "Q\x1b]52;c;secret\x07?" }, theme).render(80).join("\n");
  const result = tool.renderResult({ content: [{ type: "text", text: "A\x1b[2J!" }], details: { searchCalls: 1 } }, { expanded: true }, theme).render(80).join("\n");
  assert.ok(!query.includes("\x1b"));
  assert.ok(!result.includes("\x1b"));
});

test("already-aborted execution does not initiate credential resolution", async () => {
  let tool: any;
  openaiWebsearchTool({ registerTool(x: unknown) { tool=x; } } as any);
  const ac = new AbortController(); ac.abort();
  let authCalls = 0;
  await assert.rejects(tool.execute("call-1", { query: "Test?" }, ac.signal, undefined,
    { modelRegistry: { getApiKeyForProvider: () => { authCalls++; return Promise.resolve(token()); } } }), /cancelled or timed out/);
  assert.equal(authCalls, 0);
});

test("cancelled auth never starts a search request", async () => {
  let tool: any;
  openaiWebsearchTool({ registerTool(x: unknown) { tool=x; } } as any);
  const ac = new AbortController();
  const pending = new Promise<string>(() => {});
  const promise = tool.execute("call-1", { query: "Test?" }, ac.signal, undefined,
    { modelRegistry: { getApiKeyForProvider: async () => pending } });
  ac.abort();
  await assert.rejects(promise, /cancelled or timed out/);
});

test("logs only confirmed call counts and duration with private permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-openai-websearch-"));
  try {
    const path = join(dir, "logs", "search.jsonl");
    logCompletedSearch("gpt-5.5", 2, 321, path);
    const entry = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(entry.event, "web_search_completed");
    assert.equal(entry.search_calls, 2);
    assert.equal(entry.duration_ms, 321);
    assert.deepEqual(Object.keys(entry).sort(), ["at", "duration_ms", "event", "model", "search_calls"]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
