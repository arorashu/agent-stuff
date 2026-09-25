# pi-openai-websearch-tool

An **explicit, visible** `openai_search` Pi tool using the existing `openai-codex` OAuth login. Unlike `pi-openai-search` (same-turn hosted tool injection), this starts a separate Codex request and parses the *actual* `web_search_call` stream event. It fails rather than claiming success when no completed hosted search was observed. The main model then receives a searchable answer and sources as a normal tool result.

This tool can be called from **any tool-capable** Pi model, including the configured `local-lab/qwen3.8-27b-nvfp4a16`, provided Pi has a valid `openai-codex` login. Only the query sent to the tool is sent to OpenAI; the main model remains selected and the *full* session history is not forwarded by this extension. A model can put sensitive conversation-derived information into its query, so disable the tool for local-only/private sessions. Tool calls and results remain in normal Pi session history.

Test without loading the native extension:

```sh
pi --no-extensions -e ./index.ts --provider openai-codex --model gpt-5.5
# Also works from a local, tool-capable model:
pi --no-extensions -e ./index.ts --provider local-lab --model qwen3.8-27b-nvfp4a16
```

When installed, disable/remove the original native `pi-openai-search` package to avoid competing search modes.

The log `~/.pi/agent/logs/openai-search-tool.jsonl` (override `OPENAI_SEARCH_TOOL_LOG_FILE`) contains only timestamps, search model, elapsed tool time and the number of **completed** hosted search calls, no queries, credentials or request bodies. File permissions for new logs are 0600. Log failure does not block search. A confirmed hosted event proves the search tool ran, **not** that the answer is correct or that a source was fetched live. Check cited sources for important claims.

The nested search model is `gpt-5.5` by default, configurable with `OPENAI_SEARCH_MODEL` (requires `/reload`). Each tool use adds a separate Codex inference/search request, then another turn for the main model to consume the result. Search availability, latency, and any account limits belong to the ChatGPT/Codex service. Nested token usage is reported to Pi; the usage cost field is zero because this extension cannot know subscription billing, **not** because the service is free. Responses are bounded (1000-character query, 90-second deadline, 3 MB SSE stream, 30 source records, 12k-character answer); long output is marked truncated. Credential refresh may continue in the background after cancellation because Pi's compatibility API exposes no abort signal for that operation.

Development: `npm install && npm run check` (offline unit tests; live tests invoke `pi -p` explicitly).
