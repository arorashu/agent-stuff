import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const MODEL = process.env.OPENAI_SEARCH_MODEL || "gpt-5.5";
const TIMEOUT_MS = 90_000;
const MAX_QUERY = 1000;
const MAX_STREAM_BYTES = 3_000_000;
const MAX_FRAME = 500_000;
const MAX_SOURCES = 30;
const MAX_ANSWER = 12_000;
const LOG_FILE = join(homedir(), ".pi", "agent", "logs", "openai-search-tool.jsonl");

export interface Source { url: string; title?: string }
export interface SearchResult { answer: string; sources: Source[]; searchCalls: number; usage?: Usage; model?: string; answerTruncated: boolean }

type SseEvent = {
	type?: string;
	item?: {
		id?: string; type?: string; status?: string; action?: { type?: string; sources?: Source[] };
		content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string; title?: string }> }>;
	};
	response?: { status?: string; model?: string; usage?: {
		input_tokens?: number; output_tokens?: number; total_tokens?: number;
		input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		output_tokens_details?: { reasoning_tokens?: number };
	} };
};

// Untrusted search text must never supply terminal escapes or other control characters.
export function safeText(value: string): string {
	return value.replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)?|\[[0-?]*[ -/]*[@-~]|[PX^_][^\x1b]*(?:\x1b\\)?|.)/g, "")
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

function safeUrl(value: string): string | undefined {
	if (value.length > 1024 || /[\x00-\x20\x7f-\x9f]/.test(value)) return undefined;
	try {
		const url = new URL(value);
		if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) return undefined;
		return url.href;
	} catch { return undefined; }
}

function safeLink(source: Source): string {
	const title = safeText(source.title || source.url).slice(0, 200).replace(/[\[\]<>]/g, "\\$&");
	return `[${title}](<${source.url.replace(/\)/g, "%29").replace(/>/g, "%3E")}>)`;
}

function toUsage(raw: NonNullable<SseEvent["response"]>["usage"]): Usage | undefined {
	if (!raw) return undefined;
	const valid = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
	const cached = valid(raw.input_tokens_details?.cached_tokens);
	const cacheWrite = valid(raw.input_tokens_details?.cache_write_tokens);
	const input = valid(raw.input_tokens);
	const output = valid(raw.output_tokens);
	return { input: Math.max(0, input - cached - cacheWrite), output, cacheRead: cached, cacheWrite,
		reasoning: valid(raw.output_tokens_details?.reasoning_tokens), totalTokens: valid(raw.total_tokens) || input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Parses real provider events. A search item alone is not a successful full response. */
export async function readSearchStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal,
	onSearch?: () => void): Promise<SearchResult> {
	if (signal?.aborted) throw new Error("Search cancelled or timed out");
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const sources = new Map<string, Source>();
	const searchIds = new Set<string>();
	let anonymousCalls = 0;
	let answer = "";
	let answerTruncated = false;
	let usage: Usage | undefined;
	let model: string | undefined;
	let terminal = false;
	let bytes = 0;
	let line = "";
	let afterCR = false;
	let dataLines: string[] = [];
	let eventChars = 0;
	const addSource = (source: Source) => {
		const url = typeof source.url === "string" ? safeUrl(source.url) : undefined;
		if (!url) return;
		const existing = sources.get(url);
		if (existing?.title || (!existing && sources.size >= MAX_SOURCES)) return;
		sources.set(url, { url, ...(source.title ? { title: safeText(source.title).slice(0, 200) } : {}) });
	};
	const onAbort = () => { void reader.cancel().catch(() => {}); };
	const parseEvent = () => {
		const data = dataLines.join("\n");
		dataLines = [];
		eventChars = 0;
		if (!data || data === "[DONE]") return;
		let event: SseEvent;
		try { event = JSON.parse(data) as SseEvent; } catch { throw new Error("Malformed Codex search stream"); }
		if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
			throw new Error("Codex search did not complete successfully");
		}
		if (event.type === "response.output_item.done" && event.item?.type === "web_search_call" && event.item.status === "completed") {
			const id = event.item.id;
			if (!id || !searchIds.has(id)) {
				if (id) searchIds.add(id); else anonymousCalls++;
				onSearch?.();
			}
			for (const source of event.item.action?.sources ?? []) addSource(source);
		}
		if (event.type === "response.output_item.done" && event.item?.type === "message") {
			for (const content of event.item.content ?? []) {
				if (content.type !== "output_text") continue;
				const fragment = safeText(content.text || "");
				const remaining = MAX_ANSWER - answer.length;
				if (fragment.length > remaining) answerTruncated = true;
				if (remaining > 0) answer += fragment.slice(0, remaining);
				for (const annotation of content.annotations ?? []) {
					if (annotation.type === "url_citation" && annotation.url) addSource({ url: annotation.url, title: annotation.title });
				}
			}
		}
		if (event.type === "response.completed" || event.type === "response.done") {
			if (event.response?.status !== "completed") throw new Error("Codex search did not complete successfully");
			usage = toUsage(event.response.usage);
			model = event.response.model;
			terminal = true;
		}
	};
	const parseLine = () => {
		if (line === "") parseEvent();
		else if (line.startsWith("data:")) {
			eventChars += line.length;
			if (eventChars > MAX_FRAME) throw new Error("Codex search event too large");
			dataLines.push(line.slice(5).trimStart());
		}
		line = "";
	};
	try {
		signal?.addEventListener("abort", onAbort, { once: true });
		while (!terminal) {
			const { done, value } = await reader.read();
			if (signal?.aborted) throw new Error("Search cancelled or timed out");
			if (value) {
				bytes += value.byteLength;
				if (bytes > MAX_STREAM_BYTES) throw new Error("Codex search response too large");
			}
			const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
			for (const char of text) {
				if (afterCR) { afterCR = false; if (char === "\n") continue; }
				if (char === "\r") { parseLine(); afterCR = true; }
				else if (char === "\n") parseLine();
				else { line += char; if (line.length > MAX_FRAME) throw new Error("Codex search event too large"); }
				if (terminal) break;
			}
			if (done) {
				if (line) parseLine();
				if (dataLines.length) parseEvent();
				break;
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try { await reader.cancel(); } catch { /* stream already closed */ }
		reader.releaseLock();
	}
	if (!terminal) throw new Error("Codex search stream ended before successful completion");
	const searchCalls = searchIds.size + anonymousCalls;
	if (!searchCalls) throw new Error("Codex returned no completed web_search_call; search not confirmed");
	if (!answer.trim()) throw new Error("Codex search returned no answer");
	return { answer: answer.trim(), sources: [...sources.values()], searchCalls, usage, model, answerTruncated };
}

function getAccountId(token: string): string {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof id === "string" && id) return id;
	} catch { /* invalid token */ }
	throw new Error("Codex OAuth token has no ChatGPT account ID");
}

export async function searchCodex(query: string, token: string, model: string, signal?: AbortSignal,
	onSearch?: () => void, request: typeof fetch = fetch): Promise<SearchResult> {
	if (signal?.aborted) throw new Error("Search cancelled or timed out");
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await request(ENDPOINT, {
		method: "POST", signal: combined,
		headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": getAccountId(token), originator: "pi",
			"Content-Type": "application/json", Accept: "text/event-stream" },
		body: JSON.stringify({ model, store: false, stream: true,
			instructions: "Search the web and answer the user's query succinctly. Cite URLs from your search results; never invent sources.",
			input: [{ role: "user", content: query }], tools: [{ type: "web_search" }], tool_choice: "required",
			include: ["web_search_call.action.sources"] }),
	});
	if (!response.ok) {
		try { await response.body?.cancel(); } catch { /* best effort */ }
		throw new Error(`Codex search HTTP ${response.status}`);
	}
	if (!response.body) throw new Error("Codex search returned no response stream");
	return readSearchStream(response.body, combined, onSearch);
}

/** No queries, results, headers, or credentials in the on-disk log. */
export function logCompletedSearch(model: string, count: number, durationMs?: number,
	path = process.env.OPENAI_SEARCH_TOOL_LOG_FILE || LOG_FILE): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), event: "web_search_completed", model,
		search_calls: count, ...(durationMs === undefined ? {} : { duration_ms: Math.round(durationMs) }) })}\n`,
		{ encoding: "utf8", mode: 0o600 });
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new Error("Search cancelled or timed out");
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("Search cancelled or timed out"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export default function openaiWebsearchTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "openai_search", label: "OpenAI Web Search",
		description: "Visible web search via OpenAI Codex OAuth. Returns an answer and source URLs only after a completed hosted web_search_call.",
		promptSnippet: "openai_search: visible, confirmed OpenAI web search using the existing Codex OAuth login.",
		promptGuidelines: ["Use openai_search for current or source-backed facts; cite its source URLs in your answer."],
		parameters: Type.Object({ query: Type.String({ minLength: 2, maxLength: MAX_QUERY,
			description: "Specific web search question (sent to OpenAI)" }) }),
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("openai_search ")) +
				theme.fg("accent", `"${safeText(typeof args.query === "string" ? args.query : "…").slice(0, 150)}"`), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { searchCalls?: number; durationMs?: number } | undefined;
			const body = result.content[0]?.type === "text" ? safeText(result.content[0].text) : "";
			const lines = body.split("\n");
			const preview = expanded ? lines : lines.slice(0, 6);
			return new Text(`${details?.searchCalls ? theme.fg("success", `${details.searchCalls} confirmed search call(s)${details.durationMs ? ` · ${details.durationMs}ms` : ""}\n`) : ""}${preview.join("\n")}${!expanded && lines.length > 6 ? "\n… ctrl+o to expand" : ""}`, 0, 0);
		},
		async execute(_toolCallId, { query }, signal, onUpdate, ctx: ExtensionContext) {
			const cleanQuery = query.trim();
			if (cleanQuery.length < 2 || cleanQuery.length > MAX_QUERY) throw new Error("Search query must be 2–1000 characters");
			const started = performance.now();
			const deadline = AbortSignal.timeout(TIMEOUT_MS);
			const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
			if (combined.aborted) throw new Error("Search cancelled or timed out");
			const token = await withAbort(ctx.modelRegistry.getApiKeyForProvider("openai-codex"), combined);
			if (!token) throw new Error("OpenAI Codex OAuth is not available. Run /login openai-codex.");
			onUpdate?.({ content: [{ type: "text", text: "Searching with OpenAI…" }], details: undefined });
			const result = await searchCodex(cleanQuery, token, MODEL, combined, () => {
				onUpdate?.({ content: [{ type: "text", text: "Hosted web_search_call completed…" }], details: undefined });
			});
			const durationMs = Math.round(performance.now() - started);
			try { logCompletedSearch(result.model || MODEL, result.searchCalls, durationMs); } catch { /* logging cannot fail search */ }
			const sourceText = result.sources.slice(0, 6).map((s, i) => `${i + 1}. ${safeLink(s)}`).join("\n");
			const text = [result.answer + (result.answerTruncated ? "\n[Answer truncated]" : ""),
				sourceText ? `Sources:\n${sourceText}${result.sources.length > 6 ? "\n[Additional sources omitted]" : ""}` :
					"No structured sources were returned; verify any links in the answer.",
				`Confirmed ${result.searchCalls} completed hosted web_search_call(s).`].join("\n\n");
			return { content: [{ type: "text", text }],
				details: { searchCalls: result.searchCalls, sources: result.sources, durationMs, model: result.model || MODEL },
				...(result.usage ? { usage: result.usage } : {}) };
		},
	});
}
