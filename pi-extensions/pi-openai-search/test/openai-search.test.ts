import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addCodexWebSearch, logSearchOffer } from "../index.ts";

const codex = { provider: "openai-codex", api: "openai-codex-responses" };
const body = {
  model: "gpt-5.4",
  stream: true,
  store: false,
  tools: [{ type: "function", name: "bash" }],
  input: [{ role: "user", content: "Hello" }],
};

test("adds hosted search without changing Pi's original request", () => {
  const result = addCodexWebSearch(body, codex.provider, codex.api) as typeof body;
  assert.deepEqual(result.tools, [...body.tools, { type: "web_search" }]);
  assert.deepEqual(body.tools, [{ type: "function", name: "bash" }]);
  assert.equal(result.input, body.input);
});

test("adds tools array when Pi has no function tools", () => {
  const result = addCodexWebSearch({ model: "gpt-5.4", stream: true, store: false }, codex.provider, codex.api);
  assert.deepEqual(result, { model: "gpt-5.4", stream: true, store: false, tools: [{ type: "web_search" }] });
});

test("does not add duplicate hosted search", () => {
  assert.equal(addCodexWebSearch({ ...body, tools: [{ type: "web_search" }] }, codex.provider, codex.api), undefined);
});

test("does not affect other providers or unexpected request shapes", () => {
  assert.equal(addCodexWebSearch(body, "openai", codex.api), undefined);
  assert.equal(addCodexWebSearch(body, codex.provider, "openai-responses"), undefined);
  assert.equal(addCodexWebSearch({ ...body, store: true }, codex.provider, codex.api), undefined);
  assert.equal(addCodexWebSearch({ ...body, stream: false }, codex.provider, codex.api), undefined);
  assert.equal(addCodexWebSearch({ ...body, tools: {} }, codex.provider, codex.api), undefined);
  assert.equal(addCodexWebSearch(null, codex.provider, codex.api), undefined);
});

test("writes a private, minimal offer log without prompts or credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-openai-search-"));
  const file = join(dir, "logs", "search.jsonl");
  try {
    logSearchOffer("gpt-5.5", file);
    logSearchOffer("gpt-6-sol", file);
    const entries = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(entries.map(({ at, ...rest }) => rest), [
      { event: "web_search_offered", model: "gpt-5.5", search_used: "unknown" },
      { event: "web_search_offered", model: "gpt-6-sol", search_used: "unknown" },
    ]);
    assert.match(entries[0].at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
