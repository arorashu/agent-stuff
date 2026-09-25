# pi-openai-search

Native web search for Pi's `openai-codex` models. Adds OpenAI's hosted `web_search` to the *current model request* through Pi's `before_provider_request` hook; it uses Pi's existing ChatGPT/Codex OAuth login, not a Platform API key or separate inference call.

## Install

```sh
pi install /home/arorashu/Work/agent-stuff/pi-extensions/pi-openai-search
```

Or try it for one session with `pi -e /home/arorashu/Work/agent-stuff/pi-extensions/pi-openai-search/index.ts`.

Run `/login openai-codex` and select an `openai-codex` model. Ask a question requiring current information; search is available to the model but not forced on every turn. Search usage is subject to the ChatGPT/Codex account's limits. The extension does nothing on other providers.

There is no separate `openai_search` client-side tool: this is provider-hosted search on the same inference turn. Pi 0.87.1 does not render the search call or citation annotations as dedicated UI components; check source links in the final answer.

## Local log

Each time this extension adds `web_search` to a Codex request, it appends one JSON line to `~/.pi/agent/logs/openai-search.jsonl` (override with `OPENAI_SEARCH_LOG_FILE`). Example:

```json
{"at":"2026-09-25T12:00:00.000Z","event":"web_search_offered","model":"gpt-5.5","search_used":"unknown"}
```

**`web_search_offered` does not mean a search ran.** Pi's request/response hooks cannot see the hosted `web_search_call` event; this log confirms only that the option was sent to Codex. No prompts, results, headers, tokens, or credentials are written. New log files are created with owner-only permissions (0600). Logging failures do not block searches.

## Tests

```sh
npm install
npm run check
```
