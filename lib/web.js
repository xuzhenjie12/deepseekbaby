/**
 * Web search for node-chat.
 *
 * Preferred path: DSH's `ctx.web` seam, which owns provider selection, the
 * endpoint, and credentials. That seam only reaches the DeepSeek account token
 * while an Agent initiator is active (`agents.currentInitiator()`); an HTTP
 * request from the panel has no initiator, so the seam reports a credential
 * problem instead of searching.
 *
 * The fallback calls the same Anthropic-compatible search endpoint directly,
 * authenticating with the configured `apiKeyEnv` API key if present, else the
 * signed-in account token. It is attempted only when the seam is missing or
 * reports a credential problem — never to mask other failures.
 */

const SEARCH_BASE = "https://api.deepseek.com/anthropic/v1";
const SEARCH_MODEL = "deepseek-v4-flash";
const SEARCH_API_VERSION = "2023-06-01";
const SEARCH_TIMEOUT_MS = 60000;

function authHint(options) {
  const name = (options && options.apiKeyEnv) || "";
  return name ? "API key（环境变量 " + name + "）" : "API key";
}

function credentialProblem(error) {
  const code = error && error.code;
  if (code === "WEB_PROVIDER_CREDENTIAL_MISSING" || code === "WEB_PROVIDER_CONFIGURED_UNAVAILABLE") {
    return true;
  }
  return /no API key|credential|凭证/i.test(String((error && error.message) || error));
}

function normalize(result, maxResults) {
  const all = Array.isArray(result && result.sources) ? result.sources : [];
  const capped = maxResults ? all.slice(0, maxResults) : all;
  const cut = capped.length < all.length;
  const flagged = Boolean(result && result.truncated === true);
  return { sources: capped, truncated: flagged || cut };
}

/** url → cited_text, mirroring the provider: snippets live in text citations. */
function citationSnippets(blocks) {
  const map = new Map();
  for (const block of blocks) {
    if (!block || block.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const cite of block.citations) {
      if (typeof cite.url === "string" && cite.url && typeof cite.cited_text === "string" && cite.cited_text && !map.has(cite.url)) {
        map.set(cite.url, cite.cited_text);
      }
    }
  }
  return map;
}

function parseSearchPayload(payload) {
  const blocks = Array.isArray(payload && payload.content) ? payload.content : [];
  const snippets = citationSnippets(blocks);
  const seen = new Set();
  const sources = [];
  for (const block of blocks) {
    if (!block || block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const item of block.content) {
      if (!item || item.type !== "web_search_result" || typeof item.url !== "string" || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      const source = { url: item.url };
      if (item.title) source.title = item.title;
      if (item.page_age) source.publishedAt = item.page_age;
      if (snippets.has(item.url)) source.snippet = snippets.get(item.url);
      sources.push(source);
    }
  }
  if (sources.length === 0) {
    throw new Error("联网搜索没有返回结果块（请求可能未触发搜索）");
  }
  return sources;
}

async function directSearch(ctx, query, maxResults, options) {
  const baseURL = (options && options.baseURL) || SEARCH_BASE;
  const model = (options && options.model) || SEARCH_MODEL;
  const endpoint = baseURL.replace(/\/+$/, "") + "/messages";
  // Two ways to authenticate the direct call, so a deployment without the DSH
  // DeepSeek login still works: an env API key first, then the account token.
  const apiKey = (options && options.apiKey) || "";
  const account = typeof ctx.get === "function" ? ctx.get("deepseekAccount") : undefined;
  let headers;
  if (apiKey) {
    headers = { authorization: "Bearer " + apiKey };
  } else {
    if (!account || typeof account.resolveToken !== "function") {
      throw new Error(
        "联网搜索不可用：DSH 的 web 服务不可用，且既没有 " + authHint(options) + " 也没有登录 DeepSeek 账号",
      );
    }
    const token = await account.resolveToken(endpoint);
    if (!token) throw new Error("DeepSeek 账号未登录，无法联网搜索");
    headers = { "x-dsh-auth-token": token };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        ...headers,
        "anthropic-version": SEARCH_API_VERSION,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [{ type: "text", text: "Perform a web search for the query: " + query }],
        }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        thinking: { type: "disabled" },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error("联网搜索失败：HTTP " + String(response.status) + (detail ? " " + detail.slice(0, 200) : ""));
  }
  const payload = await response.json().catch(() => null);
  const sources = parseSearchPayload(payload);
  return {
    sources: maxResults ? sources.slice(0, maxResults) : sources,
    truncated: Boolean(maxResults && sources.length > maxResults),
  };
}

/** Run one search, preferring the seam and falling back to a direct request. */
export async function searchWeb(ctx, query, maxResults, options) {
  const service = typeof ctx.get === "function" ? ctx.get("web") : undefined;
  let seamError = null;
  if (service && typeof service.search === "function") {
    try {
      return normalize(await service.search({ query, maxResults }), maxResults);
    } catch (error) {
      if (!credentialProblem(error)) throw error;
      seamError = error;
    }
  }
  try {
    return await directSearch(ctx, query, maxResults, options);
  } catch (error) {
    if (seamError && typeof seamError.message === "string" && seamError.message.length > 0) {
      throw new Error(String(error.message) + "\n（web 服务报错：" + seamError.message.slice(0, 160) + "）");
    }
    throw error;
  }
}
