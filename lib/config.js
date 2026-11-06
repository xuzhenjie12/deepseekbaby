/** Configuration surface for @local/node-chat. Every field is optional. */

export const DEFAULT_SYSTEM = [
  "你是一个简洁、可靠的中文助手。",
  "回答直接、具体，不说客套话；需要分点时用短列表。",
  "动手前用一句话说明要做什么；计划已经说过就直接调用工具，不要每轮重复复述。",
  "已写入的文件正文不会回显，不要为了确认写入而重新读取整个文件；需要核对时只读目标片段。",
  "需要查看或修改文件、执行命令时，使用提供的工具，不要臆测文件内容。",
  "工具结果过长时只会回传摘要；需要更多内容时用 fs_read 的 offset/limit 分段读取，或把命令范围缩小。",
  "不要在磁盘范围内做大范围搜索（find /、dir C:\\ 之类）；先确定工作目录再查。",
  "输出以结论为主：不重复粘贴已存在的完整文件内容；引用代码位置用「文件:行号」，只贴必要的关键片段。",
  "不复述过程、不列举步骤、不预告下一步；只给结论、改动清单和验证结果。",
].join("\n");

/** Tool-round gears offered in the panel: 短 4 / 中 8 / 长 12 / 无限制 24. */
export const ROUND_PRESETS = [4, 8, 12, 24];
export const ROUND_LABELS = { 4: "短", 8: "中", 12: "长", 24: "无限制" };
export const ROUND_MAX = 32;

const text = (value, fallback) => (typeof value === "string" && value.trim() ? value.trim() : fallback);

/** An explicitly empty string means "no key: rely on the host service"; undefined means the default. */
const overridable = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") return fallback;
  return value.trim();
};

const number = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);

function stringList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function resolveConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  return {
    // Model route
    baseURL: text(cfg.baseURL, "").replace(/\/+$/, ""),
    // Empty string = rely on the DSH-hosted LLM service, no direct key needed.
    apiKeyEnv: overridable(cfg.apiKeyEnv, "DEEPSEEK_API_KEY"),
    model: text(cfg.model, ""),
    provider: text(cfg.provider, ""),
    systemPrompt: text(cfg.systemPrompt, DEFAULT_SYSTEM),
    maxTokens: number(cfg.maxTokens, 4096),
    temperature: typeof cfg.temperature === "number" ? cfg.temperature : undefined,
    timeoutMs: number(cfg.timeoutMs, 120000),
    // Files
    fileAccess: text(cfg.fileAccess, "computer") === "workspace" ? "workspace" : "computer",
    roots: stringList(cfg.roots),
    workspaceRoot: text(cfg.workspaceRoot, ""),
    enableWrite: bool(cfg.enableWrite, true),
    enableDelete: bool(cfg.enableDelete, true),
    enableShell: bool(cfg.enableShell, true),
    enableWebSearch: bool(cfg.enableWebSearch, true),
    // Fallback search endpoint for deployments without a DEEPSEEK_API_KEY.
    searchBaseURL: text(cfg.searchBaseURL, "https://api.deepseek.com/anthropic/v1").replace(/\/+$/, ""),
    searchModel: text(cfg.searchModel, "deepseek-v4-flash"),
    shellScope: text(cfg.shellScope, "workspace") === "anywhere" ? "anywhere" : "workspace",
    shellGuard: text(cfg.shellGuard, "system") === "off"
      ? "off"
      : text(cfg.shellGuard, "system") === "strict" ? "strict" : "system",
    shellTimeoutMs: number(cfg.shellTimeoutMs, 60000),
    maxToolRounds: Math.max(1, Math.min(ROUND_MAX, number(cfg.maxToolRounds, 16))),
    liteWire: bool(cfg.liteWire, false),
    // Billing (per 1M tokens). Defaults are DeepSeek-V3.2-Exp list prices in CNY.
    priceHitPerM: number(cfg.priceHitPerM, 0.2),
    priceMissPerM: number(cfg.priceMissPerM, 2),
    priceOutputPerM: number(cfg.priceOutputPerM, 3),
    priceCurrency: text(cfg.priceCurrency, "CNY"),
  };
}
