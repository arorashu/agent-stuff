# pi-deepseek-websearch

Web search for [pi](https://github.com/earendil-works/pi-coding-agent) via DeepSeek's
server-side `web_search_20260209` tool. Registers a `deepseek_search` tool the model can
call for current, source-backed information.

The search executes **on DeepSeek's servers during inference** — no browser, no scraper,
no third-party search API. Auth reuses the DeepSeek API key pi already has from `/login`
(provider: `deepseek`), or `DEEPSEEK_API_KEY` / `ANTHROPIC_AUTH_TOKEN` env vars.

If no DeepSeek key is available, the tool silently never registers.

## Install

```bash
pi install ./pi-deepseek-websearch      # from this repo
```

Or try without installing:

```bash
pi -e ./index.ts
```

## Usage

Ask the model something current — it will decide when to call `deepseek_search`.
Parameters: `query` (required), `allowed_domains` / `blocked_domains` (optional, mutually exclusive).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `DEEPSEEK_SEARCH_MODEL` | `deepseek-v4-flash` | Model that runs the search |
| `DEEPSEEK_SEARCH_MAX_USES` | `8` | Max server-side searches per call |
| `DEEPSEEK_SEARCH_TIMEOUT_MS` | `60000` | HTTP timeout (ms) |

## Development

```bash
npm install
npm run check     # typecheck + unit tests (offline, mocked SSE + API)
```

## Notes

- Only requires a DeepSeek key; the search always executes with DeepSeek's model on
  DeepSeek's infrastructure, regardless of which chat model you're using.
- Cost and query visibility land on your DeepSeek account.
