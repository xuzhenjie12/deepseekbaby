/** Checks for web_search: seam path, account-token fallback, formatting. */
import assert from "node:assert/strict";
import { createTools } from "../lib/tools.js";
import { searchWeb } from "../lib/web.js";

const workspace = { resolveIn: async (value) => value, root: async () => process.cwd() };
const cfg = { enableWebSearch: true, enableWrite: true, enableDelete: true, enableShell: true };

/* 1. Seam success: results pass through and are capped. */
{
  const web = {
    async search() {
      return {
        sources: [
          { title: "示例一条", url: "https://example.com/a", publishedAt: "2026-01-01", snippet: "第一段\n摘要" },
          { title: "示例二条", url: "https://example.com/b" },
        ],
        truncated: true,
      };
    },
  };
  const tools = createTools(workspace, cfg, { get: (name) => (name === "web" ? web : undefined) });
  const search = tools.find((tool) => tool.name === "web_search");
  assert.ok(search);
  assert.equal(search.enabled(cfg), true);
  assert.equal(search.enabled({ ...cfg, enableWebSearch: false }), false);

  const text = await search.run({ query: "测试", maxResults: 7 });
  assert.ok(text.includes("示例一条"), text);
  assert.ok(text.includes("https://example.com/a"), text);
  assert.ok(text.includes("2026-01-01"), text);
  assert.ok(text.includes("第一段 摘要"), text);
  assert.ok(text.includes("结果已按上限截断"), text);
}

/* 2. Credential error: falls back to the signed-in account token. */
{
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          content: [
            {
              type: "web_search_tool_result",
              content: [
                { type: "web_search_result", url: "https://fallback.test/1", title: "回退结果", page_age: "2026-02-02" },
                { type: "web_search_result", url: "https://fallback.test/2", title: "第二条" },
              ],
            },
            { type: "text", text: "正文", citations: [{ url: "https://fallback.test/1", cited_text: "引用片段" }] },
          ],
        };
      },
    };
  };
  const failure = Object.assign(new Error("DeepSeek search has no API key"), { code: "WEB_PROVIDER_CREDENTIAL_MISSING" });
  const web = { search: async () => { throw failure; } };
  const account = { resolveToken: async () => "token-123" };
  const ctx = { get: (name) => (name === "web" ? web : name === "deepseekAccount" ? account : undefined) };

  const result = await searchWeb(ctx, "查询", 1);
  assert.equal(calls.length, 1, "fallback used the search endpoint");
  assert.equal(calls[0].url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(calls[0].options.headers["x-dsh-auth-token"], "token-123");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.tools[0].name, "web_search");
  assert.equal(body.messages[0].content[0].text, "Perform a web search for the query: 查询");
  assert.equal(result.sources.length, 1, "maxResults caps the fallback result");
  assert.equal(result.sources[0].snippet, "引用片段");
  assert.equal(result.truncated, true);
  globalThis.fetch = originalFetch;
}

/* 3. No seam and no account: a clear error, not a fake result. */
{
  const ctx = { get: () => undefined };
  await assert.rejects(() => searchWeb(ctx, "x", 3), /不可用/);
}

console.log("web tests: all passed");
