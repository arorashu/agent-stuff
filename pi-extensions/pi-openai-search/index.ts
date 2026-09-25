import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_LOG_FILE = join(homedir(), ".pi", "agent", "logs", "openai-search.jsonl");

/** Log only that search was made available; Pi does not expose hosted search execution here. */
export function logSearchOffer(model: string, logFile = process.env.OPENAI_SEARCH_LOG_FILE || DEFAULT_LOG_FILE): void {
	mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
	appendFileSync(
		logFile,
		`${JSON.stringify({ at: new Date().toISOString(), event: "web_search_offered", model, search_used: "unknown" })}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

/**
 * Expose OpenAI's hosted web search on Pi's existing openai-codex turn.
 * Pi handles OAuth, streaming, retries, tool calls, and usage accounting.
 * No additional request or API key is required.
 */
export function addCodexWebSearch(payload: unknown, provider?: string, api?: string): unknown {
	if (provider !== "openai-codex" || api !== "openai-codex-responses") return undefined;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;

	const body = payload as Record<string, unknown>;
	// Do not tamper with other Responses-style requests or change an existing tool.
	if (body.stream !== true || body.store !== false || typeof body.model !== "string") return undefined;
	if (body.tools !== undefined && !Array.isArray(body.tools)) return undefined;
	const tools = (body.tools ?? []) as unknown[];
	if (tools.some((tool) => tool && typeof tool === "object" && (tool as { type?: unknown }).type === "web_search")) {
		return undefined;
	}

	return { ...body, tools: [...tools, { type: "web_search" }] };
}

export default function openaiSearch(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.model?.provider !== "openai-codex" || ctx.model.api !== "openai-codex-responses") return;
		event.systemPromptOptions.sections.openai_web_search =
			"You have OpenAI's hosted web search available in this conversation. Search when the user needs current or source-backed information. If you use web search, cite real source URLs as clickable markdown links; never invent links or present opaque citation markers as URLs.";
	});

	let warnedAboutLog = false;
	pi.on("before_provider_request", (event, ctx) => {
		const modified = addCodexWebSearch(event.payload, ctx.model?.provider, ctx.model?.api);
		if (modified !== undefined) {
			try {
				logSearchOffer(ctx.model?.id ?? "unknown");
			} catch {
				// Logging must never block or alter a model request.
				if (!warnedAboutLog && ctx.hasUI) {
					ctx.ui.notify("openai-search: could not write search-offer log", "warning");
					warnedAboutLog = true;
				}
			}
		}
		return modified;
	});
}
