/**
 * Offline unit tests for the deepseek-search extension.
 *
 * No API keys and no network: the extension is loaded with a mocked
 * ExtensionAPI (capturing registerTool / session_start) and fetch is mocked
 * with canned SSE streams.
 *
 * Run: npm test  (node --import tsx --test)
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import deepseekSearchExtension from "../index.ts";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details?: unknown;
}

interface CapturedTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (
		callId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: (u: unknown) => void,
		ctx: { modelRegistry: { getApiKeyForProvider: (p: string) => Promise<string | undefined> } },
	) => Promise<ToolResult>;
	renderCall?: (args: unknown, theme: unknown) => Text;
	renderResult?: (result: unknown, opts: { expanded: boolean }, theme: unknown) => Text;
}

interface Harness {
	pi: ExtensionAPI;
	handlers: Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>;
	tools: CapturedTool[];
	ctx: { modelRegistry: { getApiKeyForProvider: (p: string) => Promise<string | undefined> } };
}

function makeHarness(apiKey?: string): Harness {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
	const tools: CapturedTool[] = [];
	const pi = {
		on: (event: string, handler: (e: unknown, c: unknown) => void | Promise<void>) => {
			handlers.set(event, handler);
		},
		registerTool: (def: CapturedTool) => {
			tools.push(def);
		},
	} as unknown as ExtensionAPI;

	const ctx = { modelRegistry: { getApiKeyForProvider: async () => apiKey } };

	deepseekSearchExtension(pi);

	return { pi, handlers, tools, ctx };
}

async function startSession(h: Harness): Promise<void> {
	const handler = h.handlers.get("session_start");
	assert.ok(handler, "session_start handler should be registered");
	await handler({}, h.ctx);
}

const fakeTheme = {
	fg: (_style: string, s: string) => s,
	bold: (s: string) => s,
	dim: (s: string) => s,
};

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sse(obj: unknown): string {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

function chunkify(s: string, size: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
	return out;
}

function sseResponse(events: unknown[], chunkSize?: number) {
	const full = events.map(sse).join("");
	const chunks = chunkSize ? chunkify(full, chunkSize) : [full];
	return (async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({}),
		body: new ReadableStream({
			start(controller) {
				for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
				controller.close();
			},
		}),
	})) as unknown as typeof fetch;
}

function errorResponse(status: number, statusText: string, message: string) {
	return (async () => ({
		ok: false,
		status,
		statusText,
		json: async () => ({ error: { message } }),
		body: null,
	})) as unknown as typeof fetch;
}

const SEARCH_EVENTS = [
	{
		type: "message_start",
		message: { model: "deepseek-v4-flash", usage: { input_tokens: 100, output_tokens: 0 } },
	},
	{
		type: "content_block_start",
		content_block: {
			type: "web_search_tool_result",
			content: [
				{ type: "web_search_result", title: "Source One", url: "https://example.com/1", page_age: "2 days ago" },
				{ type: "web_search_result", title: "Source Two", url: "https://example.com/2" },
			],
		},
	},
	{ type: "content_block_start", content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", delta: { type: "text_delta", text: "Here is the " } },
	{ type: "content_block_delta", delta: { type: "text_delta", text: "answer." } },
	{ type: "message_delta", usage: { output_tokens: 42 } },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("registers deepseek_search when a DeepSeek key is available", async () => {
	delete process.env.DEEPSEEK_API_KEY;
	delete process.env.ANTHROPIC_AUTH_TOKEN;

	const h = makeHarness("test-key");
	await startSession(h);

	assert.equal(h.tools.length, 1);
	assert.equal(h.tools[0]?.name, "deepseek_search");
	assert.equal(h.tools[0]?.label, "DeepSeek Web Search");
	assert.match(h.tools[0]?.description ?? "", /Search the web/);
});

test("does not register without a DeepSeek key", async () => {
	delete process.env.DEEPSEEK_API_KEY;
	delete process.env.ANTHROPIC_AUTH_TOKEN;

	const h = makeHarness(undefined);
	await startSession(h);

	assert.equal(h.tools.length, 0);
});

test("execute returns synthesized answer, sources, and token footer", async () => {
	delete process.env.DEEPSEEK_API_KEY;
	delete process.env.ANTHROPIC_AUTH_TOKEN;

	const h = makeHarness("test-key");
	await startSession(h);
	const tool = h.tools[0];
	assert.ok(tool);

	const originalFetch = globalThis.fetch;
	// Chunk size 37 splits lines mid-way to exercise the streaming buffer.
	globalThis.fetch = sseResponse(SEARCH_EVENTS, 37);
	try {
		const result = await tool.execute(
			"call-1",
			{ query: "test query" },
			new AbortController().signal,
			() => {},
			h.ctx,
		);
		assert.equal(result.isError, undefined);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /Here is the answer\./);
		assert.match(text, /\[Source One\]\(https:\/\/example\.com\/1\) \(2 days ago\)/);
		assert.match(text, /\[Source Two\]\(https:\/\/example\.com\/2\)/);
		assert.match(text, /142 tokens · deepseek-v4-flash/); // 100 input + 42 output
		assert.match(text, /REMINDER/);
		const details = result.details as { sources?: Array<{ title: string; url: string }> };
		assert.equal(details.sources?.length, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("execute reports API errors with the server message", async () => {
	delete process.env.DEEPSEEK_API_KEY;
	delete process.env.ANTHROPIC_AUTH_TOKEN;

	const h = makeHarness("test-key");
	await startSession(h);
	const tool = h.tools[0];
	assert.ok(tool);

	const originalFetch = globalThis.fetch;
	globalThis.fetch = errorResponse(401, "Unauthorized", "Invalid API key");
	try {
		const result = await tool.execute(
			"call-2",
			{ query: "test query" },
			new AbortController().signal,
			() => {},
			h.ctx,
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /DeepSeek API 401: Invalid API key/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("execute rejects an empty query", async () => {
	const h = makeHarness("test-key");
	await startSession(h);
	const tool = h.tools[0];
	assert.ok(tool);

	const result = await tool.execute(
		"call-3",
		{ query: "   " },
		new AbortController().signal,
		() => {},
		h.ctx,
	);
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /query is required/);
});

test("sources-only response still returns links", async () => {
	delete process.env.DEEPSEEK_API_KEY;
	delete process.env.ANTHROPIC_AUTH_TOKEN;

	const h = makeHarness("test-key");
	await startSession(h);
	const tool = h.tools[0];
	assert.ok(tool);

	const originalFetch = globalThis.fetch;
	globalThis.fetch = sseResponse([
		{ type: "message_start", message: { model: "deepseek-v4-flash", usage: { input_tokens: 5, output_tokens: 0 } } },
		{
			type: "content_block_start",
			content_block: {
				type: "web_search_tool_result",
				content: [{ type: "web_search_result", title: "Lone Source", url: "https://example.com/only" }],
			},
		},
		{ type: "message_delta", usage: { output_tokens: 7 } },
	]);
	try {
		const result = await tool.execute(
			"call-4",
			{ query: "test query" },
			new AbortController().signal,
			() => {},
			h.ctx,
		);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /No answer was synthesized/);
		assert.match(text, /\[Lone Source\]\(https:\/\/example\.com\/only\)/);
		assert.match(text, /12 tokens/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("renderCall and renderResult produce TUI text", async () => {
	const h = makeHarness("test-key");
	await startSession(h);
	const tool = h.tools[0];
	assert.ok(tool);

	const callRender = tool.renderCall?.({ query: "hello", allowed_domains: ["example.com"] }, fakeTheme);
	assert.ok(callRender instanceof Text);

	const resultRender = tool.renderResult?.(
		{ content: [{ type: "text", text: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8" }] },
		{ expanded: false },
		fakeTheme,
	);
	assert.ok(resultRender instanceof Text);

	const expandedRender = tool.renderResult?.(
		{ content: [{ type: "text", text: "full text here" }] },
		{ expanded: true },
		fakeTheme,
	);
	assert.ok(expandedRender instanceof Text);
});
