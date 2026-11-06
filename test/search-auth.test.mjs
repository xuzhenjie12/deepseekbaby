/**
 * Direct search fallback: authenticate with an env API key when the host has
 * no DeepSeek login. Stubs the global fetch, so nothing leaves the machine.
 * Run: node test/search-auth.test.mjs
 */
import assert from "node:assert/strict";
import { searchWeb } from "../lib/web.js";

const reply = {
  content: [
    {
      type: "web_search_tool_result",
      content: [
        { type: "web_search_result", url: "https://example.com/a", title: "A", page_age: "2026-11-01" },
      ],
    },
    { type: "text", text: "结果", citations: [{ url: "https://example.com/a", cited_text: "摘要 A" }] },
  ],
};

const seen = [];
const original = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
  return {
    ok: true,
    status: 200,
    async json() {
      return reply;
    },
    async text() {
      return "";
    },
  };
};

// A ctx with no seams at all: the direct call has to carry the whole search.
const naked = { get: () => undefined };
const options = { baseURL: "https://search.invalid/v1/", model: "m", apiKey: "sk-test", apiKeyEnv: "MY_SEARCH_KEY" };

try {
  const result = await searchWeb(naked, "deepseek 发布", 5, options);
  assert.equal(seen.length, 1, "the fallback made exactly one request");
  assert.equal(seen[0].url, "https://search.invalid/v1/messages", "endpoint is baseURL + /messages");
  assert.equal(seen[0].headers.authorization, "Bearer sk-test", "an env key authenticates with a bearer token");
  assert.equal(seen[0].headers["x-dsh-auth-token"], undefined, "the account token is not sent when a key exists");
  assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(seen[0].body.model, "m");
  assert.equal(seen[0].body.tools[0].name, "web_search");
  assert.equal(result.sources.length, 1, "result blocks become sources");
  assert.equal(result.sources[0].title, "A");
  assert.equal(result.sources[0].snippet, "摘要 A", "the citation becomes the snippet");
  assert.equal(result.truncated, false);

  // No key and no account: fail with an actionable message, not a silent empty list.
  await assert.rejects(
    () => searchWeb(naked, "q", 5, { ...options, apiKey: "" }),
    (error) => {
      assert.match(error.message, /MY_SEARCH_KEY/, "the message names the env var to set");
      assert.match(error.message, /DeepSeek/, "the message names the alternative");
      return true;
    },
  );

  // An account token is still honoured when no key is configured.
  seen.length = 0;
  const withAccount = {
    get: (name) => (name === "deepseekAccount" ? { resolveToken: async () => "acct-token" } : undefined),
  };
  await searchWeb(withAccount, "q", 5, { ...options, apiKey: undefined });
  assert.equal(seen[0].headers["x-dsh-auth-token"], "acct-token");
  assert.equal(seen[0].headers.authorization, undefined);

  // A working ctx.web seam wins: no direct request at all.
  seen.length = 0;
  const withSeam = {
    get: (name) =>
      name === "web"
        ? { search: async () => ({ sources: [{ url: "https://seam.example", title: "S" }], truncated: false }) }
        : undefined,
  };
  const viaSeam = await searchWeb(withSeam, "q", 5, options);
  assert.equal(seen.length, 0, "the seam answered, so fetch was never called");
  assert.equal(viaSeam.sources[0].url, "https://seam.example");
} finally {
  globalThis.fetch = original;
}

console.log("search-auth tests: all passed");
