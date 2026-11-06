/**
 * One turn of model calls, including a bounded tool loop.
 *
 * The stream contract (confirmed with a live probe):
 *   block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish
 * `tool-call-delta` pieces are incomplete fragments: only `block-end` carries
 * the assembled `{ type:'tool-call', id, name, arguments }` block.
 *
 * Tool calls run serially on purpose: parallel calls would need partial-failure,
 * cancellation, and interleaved-output handling for a few milliseconds.
 */
import { createHash, randomUUID } from "node:crypto";
import { createStreamFilter, hasMarkup, parseCalls, stripMarkup } from "./dsml.js";

const MAX_TOOL_RESULT = 4000;
const TERSE_TOOL_RESULT = 800;
const SUMMARY_LINES = 20;
const TERSE_SUMMARY_LINES = 10;
const FULL_SUMMARY_LINES = 200;

/**
 * Lite mode summarizes, then acts. It used to plan and stop for a confirmation
 * the model never actually needed; now the summary is the first line of the
 * same answer and the work continues without waiting for a second message.
 * Both notes speak on the newest user message, not in the system prompt: the
 * system string heads the cached prefix, so toggling lite there would throw
 * away every cached token.
 */
export const LITE_PLAN_NOTE = [
  "【轻量模式 · 方案】先用一句话总结你理解的需求和打算怎么做，然后这一轮直接开始做，不要停下来等确认。",
  "1. 先写一句「方案」：意图、要改什么、不改什么、预计几步；随后在同一条回答里给出进度。",
  "2. 只做方案列出的必要步骤，不顺手重构、不加未要求的功能、不跑无关命令。",
  "3. 执行阶段同样遵守：每轮只做下一小步，做完立刻接下一步，不要反复确认同一件事。",
  "4. 只有三种情况才停下来问：缺关键信息无法推进、要删除或覆盖不可恢复的数据、方案和用户明确指令冲突。",
].join("\n");

export const LITE_EXEC_NOTE = [
  "【轻量模式 · 执行】按方案只做必要的那一步，做完继续下一步，不要回头重复已完成的步骤。",
  "1. 只做方案里的步骤；方案外的一律不做，也不扩大范围。",
  "2. 做完给阶段报告：已完成 / 未完成 / 下一步，各一行。",
  "3. 预算用尽就停，不要为了“显得完成”而跳过验证或编造结果。",
].join("\n");

/** Backwards-compatible alias: the plan note is what lite used to mean. */
export const LITE_NOTE = LITE_PLAN_NOTE;

const LITE_PLAN_CLOSING =
  "收尾只给：一句话结论 + 已完成 / 未完成 / 下一步，各一行；不复述格式要求原文，也不要声称做过没做的事。";

const LITE_EXEC_CLOSING =
  "收尾只给阶段报告：已完成 / 未完成 / 下一步，各一行，不复述格式要求原文。";

const LITE_CLOSING = LITE_EXEC_CLOSING;

/**
 * Wire-only: stored history keeps the user text exactly as typed. The same
 * helper carries the terse note and, when both switches are on, both notes.
 */
export function applyLiteNote(messages, note) {
  const body = typeof note === "string" && note ? note : LITE_PLAN_NOTE;
  if (!Array.isArray(messages)) return messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    const text = typeof message.content === "string" ? message.content : "";
    message.content = text ? text + "\n\n" + body : body;
    return messages;
  }
  return messages;
}

/** Typed confirmation is accepted as well, for users who still type 执行. */
export function isExecConfirm(text) {
  return /^(执行|开始|开始执行|做吧|直接做|直接改|按方案做|按计划做)[。！!.\s]*$/.test(String(text || "").trim());
}

/**
 * Terse mode is lite with a harder floor: conclusions and progress only, and
 * tool details never reach the panel at all. Same wire trick, one tail
 * message, decided per request, so the cached prefix is untouched.
 */
export const TERSE_NOTE = [
  "【极简模式】",
  "1. 只给结论和完成进度：先一句话说结果，再最多 3 条进度（已完成 / 未完成 / 下一步）。",
  "2. 不展示工具调用：不提工具名、不贴参数、不复述输出、不贴代码或日志。",
  "3. 用户追问细节时再展开；此刻默认不展开。",
].join("\n");

const TERSE_CLOSING =
  "极简模式收尾：一句话结论 + 最多 3 条进度，不展示工具调用细节；不要复述格式要求原文。";

/** Wire-only: stored history keeps the user text exactly as typed. */
export function applyTerseNote(messages) {
  if (!Array.isArray(messages)) return messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    const text = typeof message.content === "string" ? message.content : "";
    message.content = text ? text + "\n\n" + TERSE_NOTE : TERSE_NOTE;
    return messages;
  }
  return messages;
}

/**
 * Note lines are stripped back out when the model echoes them: instruction
 * lines are not an answer.
 */
function normalizeNoteLine(line) {
  return String(line)
    .replace(/^\s*[0-9]+\s*[.、)．]\s*/, "")
    .replace(/\s+/g, "")
    .trim();
}

const NOTE_LINES = new Set(
  [...TERSE_NOTE.split("\n"), ...LITE_PLAN_NOTE.split("\n"), ...LITE_EXEC_NOTE.split("\n")]
    .map(normalizeNoteLine)
    .filter((line) => line.length > 0)
);

/**
 * The model occasionally answers by copying the note back. Those lines are
 * format instructions, not an answer: they must not reach the panel, and must
 * not be replayed into the next turn's context either.
 */
export function stripNoteEcho(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  const kept = [];
  for (const line of text.split("\n")) {
    const key = normalizeNoteLine(line);
    if (key.length === 0) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (NOTE_LINES.has(key)) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.join("\n").trim();
}

export function joinAnswer({ lite, terse, steps, closing, stopped, reason }) {
  const stepText = typeof steps === "string" ? steps.trim() : "";
  const closeText = typeof closing === "string" ? closing.trim() : "";
  const placeholder = stopped === true ? "（已暂停，未产生回复）" : "（" + reason + "，以上为阶段性结果。）";
  // 极简只缩短措辞（提示词 + 收尾请求），正文照常累积；否则历史里会丢掉
  // 前面几轮的结论，下一轮模型不知道已经做到哪。
  const parts = [stepText, closeText].map(stripNoteEcho).filter(Boolean);
  return parts.length === 0 ? placeholder : parts.join("\n\n");
}

/** Tools whose arguments carry a whole file body; history keeps only a stub. */
const BODY_ARG_TOOLS = new Set(["fs_write"]);

/**
 * history.json only feeds the panel, never the model, so a written file body
 * is replaced by length plus a short hash: still enough to tell two writes
 * apart, without storing every byte twice.
 */
function slimArgs(name, args) {
  if (!args || typeof args !== "object" || !BODY_ARG_TOOLS.has(name)) return args;
  const body = typeof args.content === "string" ? args.content : "";
  if (!body) return args;
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);
  return { ...args, content: "[省略 " + String(body.length) + " 字符 · " + hash + "]" };
}

/**
 * The model re-reads its own earlier tool calls on every later request in the
 * same round, so a written file body is swapped for a stub on the wire. The
 * call itself still runs with the original arguments; only the echoed copy
 * shrinks. The tool result ("Wrote N bytes to path") already confirms success.
 */
export function stubWireArgs(name, rawArguments) {
  if (!BODY_ARG_TOOLS.has(name) || typeof rawArguments !== "string") return rawArguments;
  let parsed;
  try {
    parsed = JSON.parse(rawArguments);
  } catch (error) {
    return rawArguments;
  }
  const body = parsed && typeof parsed === "object" ? parsed.content : undefined;
  if (typeof body !== "string" || body.length === 0) return rawArguments;
  return JSON.stringify({
    ...parsed,
    content: "[正文 " + String(body.length) + " 字符已写入成功，此处不回显；以工具结果为准]",
  });
}

/** Long tool output becomes head-plus-count; details stay retrievable on demand. */
export function summarizeToolResult(text, limit, lineCap) {
  const cap = Number(limit) ? Number(limit) : MAX_TOOL_RESULT;
  const maxLines = Number(lineCap) ? Number(lineCap) : SUMMARY_LINES;
  if (text.length <= cap) return text;
  const lines = text.split("\n");
  const tail = lines.length > maxLines
    ? "\n...[已截断：共 " + String(lines.length) + " 行 / " + String(text.length) +
      " 字符。这是摘要；需要更多内容请用 fs_read 的 offset/limit 分段读取，或缩小命令范围]"
    : "\n...[已截断：" + String(text.length) + " 字符]";
  // Reserve the note before slicing the head: if the note itself were cut,
  // the model would mistake an excerpt for the full output and stop asking.
  const budget = Math.max(0, cap - tail.length);
  const head = lines.slice(0, maxLines).join("\n").slice(0, budget);
  return head + tail;
}

/**
 * Tools offered by the `basic` profile: read/list plus the shell.
 */
const BASIC_TOOLS = new Set(["fs_read", "fs_list", "shell"]);

/** Tools the per-turn "联网" switch adds on top of whatever profile is fixed. */
const WEB_TOOLS = new Set(["web_search"]);

const DEV_PROMPT = [
  "你现在处于开发者模式：本任务的工作区就是 deepseekbaby 插件自己的源码目录，可以直接读写这些文件。",
  "结构速查：",
  "- index.js：宿主 HTTP 路由、上传、工作区、插件重载；",
  "- lib/agent.js：模型调用与工具循环；lib/tools.js：工具实现；lib/store.js：节点树与历史；lib/web.js：联网；lib/dsml.js：工具标记修复；",
  "- panel.html：面板 UI 与前端逻辑；panel-markdown.js：Markdown 渲染；client.js：DSH 浮层入口；install.ps1 / install.sh：安装脚本。",
  "改动要求：小步、可回退；改完必须运行 `node test/handler.test.mjs`（它会 import index.js，能发现语法错误），涉及其它模块时再跑对应的 test/*.mjs。",
  "不要修改 ~/.dsh 下的数据目录，不要运行 install.ps1，不要删除或重命名安装脚本。",
  "宿主代码只在插件重启后生效：测试通过后调用 restart_plugin 工具（本轮结束后自动重启），或让用户点面板上的 ⟳。",
  "回复里不要贴整份文件；说明改了哪些文件、为什么、如何验证。",
].join("\n");

function allowByProfile(name, profile, web, dev) {
  if (name === "restart_plugin") return dev === true;
  if (web === true && WEB_TOOLS.has(name)) return true;
  if (profile === "none") return false;
  if (profile === "basic") return BASIC_TOOLS.has(name);
  return !WEB_TOOLS.has(name) && name !== "restart_plugin";
}

export function selectionOf(ctx) {
  try {
    const service = typeof ctx.get === "function" ? ctx.get("agentDefaultModel") : undefined;
    const selection = service && typeof service.currentSelection === "function"
      ? service.currentSelection()
      : undefined;
    return {
      provider: selection && typeof selection.provider === "string" ? selection.provider : "",
      model: selection && typeof selection.model === "string" ? selection.model : "",
    };
  } catch (error) {
    return { provider: "", model: "" };
  }
}

function usageOf(input, hit, output, prompt) {
  // DSH reports the uncached prompt as `input` and the cached prefix as `hit`;
  // the prompt total is their sum. OpenAI instead reports prompt_tokens as the
  // total, so callers there pass it explicitly as `prompt`.
  const miss = Number(input) || 0;
  const cached = Number(hit) || 0;
  return {
    input: miss,
    hit: cached,
    output: Number(output) || 0,
    prompt: Number(prompt) || miss + cached,
  };
}

/**
 * Deterministic message id.
 *
 * The provider caches a request prefix; anything that changes between two
 * otherwise identical requests breaks that prefix. A random id per request is
 * exactly such a change, so ids are derived from immutable entry fields.
 */
function stableId(source) {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return "nc-" + (hash >>> 0).toString(16).padStart(8, "0") + "-" + source.length.toString(16);
}

/**
 * User content parts: text, file notices, and image blocks backed by durable
 * attachment refs (the LLM layer projects or degrades them per model).
 */
function userContent(message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const parts = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    parts.push({ type: "text", text: message.content });
  }
  const files = attachments.filter((item) => item && item.kind !== "image");
  if (files.length > 0) {
    const lines = files.map((item) => "[附件] " + (item.path || item.name) + "（" + (item.name || "") + "）");
    parts.push({
      type: "text",
      text: lines.join("\n") + "\n这些文件已保存在本任务工作区，需要时用 fs_read 读取。",
    });
  }
  for (const item of attachments) {
    if (!item || item.kind !== "image") continue;
    if (item.ref) parts.push({ type: "image", attachment: item.ref });
    else parts.push({ type: "text", text: "[图片] " + (item.path || item.name) });
  }
  if (parts.length === 0) parts.push({ type: "text", text: "" });
  return parts;
}

function toDshMessages(messages, provider, model) {
  return messages.map((message) => {
    if (message.role === "assistant") {
      const content = [];
      if (typeof message.content === "string" && message.content) {
        content.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls || []) {
        content.push({ type: "tool-call", id: call.id, name: call.name, arguments: call.arguments });
      }
      const identity = message.id
        || stableId([message.node || "", message.ts || "", message.content || ""].join("\u0000"));
      return {
        role: "assistant",
        id: identity,
        content,
        source: { kind: "model", provider, model },
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        id: "nc-tool-" + String(message.toolCallId || ""),
        toolCallId: message.toolCallId,
        content: [{ type: "text", text: message.content }],
        source: { kind: "tool", callId: message.toolCallId },
      };
    }
    return { role: "user", content: userContent(message) };
  });
}

async function callDshLlm(ctx, cfg, provider, model, messages, schemas, system, emit, signal) {
  const llm = typeof ctx.get === "function" ? ctx.get("llm") : undefined;
  if (!llm || typeof llm.stream !== "function") {
    throw new Error("当前 DSH 没有提供模型服务：请给插件配置 provider，或配置 baseURL + apiKeyEnv + model");
  }
  const options = {
    provider,
    model,
    system,
    messages: toDshMessages(messages, provider, model),
    maxTokens: cfg.maxTokens,
  };
  if (schemas.length > 0) options.tools = schemas;
  if (signal) options.signal = signal;
  const stream = llm.stream(options);
  const filter = createStreamFilter(emit);
  let text = "";
  const calls = [];
  let usage = null;
  try {
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== "object") continue;
      if (chunk.type === "text-delta") {
        text += chunk.text;
        filter.push(chunk.text);
      } else if (chunk.type === "block-end") {
        const block = chunk.block;
        if (block && block.type === "tool-call") {
          calls.push({ id: block.id, name: block.name, arguments: block.arguments });
        }
      } else if (chunk.type === "usage") {
        usage = chunk.usage;
      } else if (chunk.type === "finish") {
        const reason = chunk.reason || {};
        if (reason.kind === "error") {
          throw new Error((reason.failure && reason.failure.message) || "模型调用失败");
        }
        if (reason.kind === "aborted") throw new Error("模型调用被中断");
      }
    }
  } catch (error) {
    // A user stop aborts the stream mid-way; the partial text is still useful.
    if (!signal || !signal.aborted) throw error;
    filter.flush();
    return {
      text,
      calls: [],
      usage: usage ? usageOf(usage.inputTokens, usage.cacheReadTokens, usage.outputTokens) : null,
      aborted: true,
    };
  }
  filter.flush();
  return {
    text,
    calls,
    usage: usage ? usageOf(usage.inputTokens, usage.cacheReadTokens, usage.outputTokens) : null,
  };
}

function toOpenAiMessages(messages) {
  return messages.map((message) => {
    if (message.role === "assistant") {
      const out = { role: "assistant", content: message.content || "" };
      if (message.toolCalls && message.toolCalls.length > 0) {
        out.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      return out;
    }
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    return { role: "user", content: message.content };
  });
}

async function callOpenAi(cfg, model, messages, schemas, system) {
  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = "Bearer " + apiKey;
  const payload = {
    model,
    messages: [{ role: "system", content: system }, ...toOpenAiMessages(messages)],
    stream: false,
    max_tokens: cfg.maxTokens,
  };
  if (cfg.temperature !== undefined) payload.temperature = cfg.temperature;
  if (schemas.length > 0) {
    payload.tools = schemas.map((schema) => ({
      type: "function",
      function: { name: schema.name, description: schema.description, parameters: schema.parameters },
    }));
    payload.tool_choice = "auto";
  }
  const response = await fetch(cfg.baseURL + "/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error("模型接口 " + String(response.status) + "：" + raw.slice(0, 300));
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error("模型接口返回的不是 JSON");
  }
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : undefined;
  const message = (choice && choice.message) || {};
  const content = message.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("")
      : "";
  const calls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => ({
        id: call.id || randomUUID(),
        name: call.function ? call.function.name : "",
        arguments: call.function ? call.function.arguments || "{}" : "{}",
      }))
    : [];
  const usage = (data && data.usage) || {};
  return {
    text,
    calls,
    usage: usageOf(usage.prompt_tokens, usage.prompt_cache_hit_tokens, usage.completion_tokens, usage.prompt_tokens),
  };
}

export async function runTurn({ ctx, cfg, tools, history, profile, web, dev, signal, onEvent }) {
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  const isAborted = () => Boolean(signal && signal.aborted);
  const selection = selectionOf(ctx);
  const provider = cfg.provider || selection.provider;
  const model = cfg.model || selection.model || "deepseek-chat";
  const openAi = Boolean(cfg.baseURL);
  if (!openAi && !provider) {
    throw new Error("还没有可用的模型提供方：请给插件配置 provider，或配置 baseURL + apiKeyEnv + model");
  }

  const toolProfile = profile === "none" || profile === "basic" ? profile : "full";
  const active = tools.filter((tool) => {
    if (!allowByProfile(tool.name, toolProfile, web === true, dev === true)) return false;
    try {
      return tool.enabled(cfg);
    } catch (error) {
      return false;
    }
  });
  const byName = new Map(active.map((tool) => [tool.name, tool]));
  const schemas = active.map((tool) => tool.schema);

  const messages = history.map((entry) => ({
    role: entry.role,
    content: entry.content,
    node: entry.node,
    ts: entry.ts,
    ...(Array.isArray(entry.attachments) && entry.attachments.length > 0
      ? { attachments: entry.attachments }
      : {}),
  }));
  const systemParts = [cfg.systemPrompt];
  if (dev === true) systemParts.push(DEV_PROMPT);
  if (cfg.fileAccess === "computer" && cfg.roots.length === 0) {
    systemParts.push("文件工具可以读写本机任意绝对路径；相对路径相对于工作区根。写文件前先确认目标路径。");
  }
  if (toolProfile === "none") {
    systemParts.push("本次对话没有可用工具：不要输出工具调用标记、伪代码或 XML，直接用文字回答。");
  }
  const system = systemParts.join("\n");
  // Both spare modes speak at the tail of the newest user message, never in
  // the system prompt: the cached prefix stays byte-identical, and flipping a
  // switch only changes the request that follows it.
  // The two switches stack instead of competing: terse shortens the wording,
  // lite decides the phase. Before this, terse silently voided lite, so a task
  // with both on never saw the plan/exec notes and could never leave plan.
  const terse = cfg.terseWire === true;
  const litePlan = cfg.litePlan === true;
  const liteExec = cfg.liteExec === true;
  // `liteWire` without a phase keeps the old single-phase lite behaviour.
  const lite = litePlan || liteExec || cfg.liteWire === true;
  const phase = liteExec ? "exec" : lite ? "plan" : terse ? "terse" : "standard";
  const spare = terse || lite;
  const closingNote = liteExec
    ? LITE_EXEC_CLOSING
    : lite
      ? LITE_PLAN_CLOSING
      : terse
        ? TERSE_CLOSING
        : "";
  // One tail message carries both notes: flipping either switch still only
  // changes the newest user message, never the cached prefix.
  const tailNote = [terse ? TERSE_NOTE : "", lite ? (liteExec ? LITE_EXEC_NOTE : LITE_PLAN_NOTE) : ""]
    .filter(Boolean)
    .join("\n\n");
  if (tailNote) applyLiteNote(messages, tailNote);
  const summaries = [];
  let textAll = "";
  let input = 0;
  let hit = 0;
  let output = 0;
  let promptTotal = 0;
  // The last HTTP request is what a cache-hit percentage describes; summing
  // input across tool rounds and taking max(hit) would understate the rate.
  let last = { input: 0, hit: 0, output: 0 };
  let rounds = 0;
  const seenCalls = new Map();
  let repeated = false;

  /**
   * Ask for a conclusion with tools disabled. A turn that spent its whole tool
   * budget still owes the user an answer, not a bare "staged result" notice.
   */
  async function finishWithoutTools(reason, extraMessages) {
    const ask = litePlan
      ? "请不要再调用任何工具，直接收尾：一句话结论 + 已完成 / 未完成 / 下一步，各一行。"
      : liteExec
        ? "请不要再调用任何工具，直接给阶段报告：已完成 / 未完成 / 下一步。"
        : "请不要再调用任何工具，直接根据上面的工具结果给出最终结论："
          + "说明已经完成了什么、还缺什么、建议下一步怎么做。";
    const closing = {
      role: "user",
      content: "[" + reason + "] " + ask + (spare ? "\n" + closingNote : ""),
    };
    const result = openAi
      ? await callOpenAi(cfg, model, extraMessages.concat([closing]), [], system)
      : await callDshLlm(ctx, cfg, provider, model, extraMessages.concat([closing]), [], system, emit, signal);
    if (result.usage) {
      input += result.usage.input;
      hit += result.usage.hit;
      output += result.usage.output;
      promptTotal += result.usage.prompt || result.usage.input + result.usage.hit;
      last = result.usage;
    }
    return stripMarkup(result.text || "");
  }

  for (let round = 0; round < cfg.maxToolRounds; round += 1) {
    if (isAborted()) break;
    rounds = round + 1;
    const result = openAi
      ? await callOpenAi(cfg, model, messages, schemas, system)
      : await callDshLlm(ctx, cfg, provider, model, messages, schemas, system, emit, signal);
    if (openAi && result.text) emit({ t: "text", v: result.text });

    if (result.usage) {
      input += result.usage.input;
      hit += result.usage.hit;
      output += result.usage.output;
      promptTotal += result.usage.prompt || result.usage.input + result.usage.hit;
      last = result.usage;
    }
    const rawText = result.text || "";
    const hadMarkup = hasMarkup(rawText);
    const cleanText = stripMarkup(rawText);
    // 极简与轻量/标准一样累积每轮正文：提示词负责“说短”，历史仍要留进度。
    if (cleanText) textAll = textAll + cleanText;

    // Stopping skips the remaining calls and the closing summary request, which
    // is the part that would otherwise cost another full model turn.
    if (result.aborted || isAborted()) {
      return {
        text: textAll.trim(),
        usage: { input, hit, output, prompt: promptTotal, last },
        toolCalls: summaries,
        rounds,
        stopped: true,
        phase,
      };
    }

    // The provider sometimes writes the tool call as plain DSML text instead of
    // a structured block. Recover the calls so the turn still does the work.
    let calls = result.calls;
    if (calls.length === 0 && hadMarkup) {
      calls = parseCalls(rawText, () => randomUUID());
    }

    if (calls.length === 0) {
      // Unparseable markup means the model tried to call a tool that was not
      // offered; ask once more for a real answer instead of showing tags.
      if (hadMarkup && cleanText.trim().length < 40) {
        try {
          const retry = await finishWithoutTools("你刚才输出了无效的工具调用标记", messages.slice());
          if (retry.trim() && retry.trim() !== cleanText.trim()) {
            textAll = spare
              ? retry
              : textAll + (textAll.trim() ? "\n\n" : "") + retry;
          }
        } catch (error) {
          // Fall through with whatever text remains.
        }
      }
      const usage = { input, hit, output, prompt: promptTotal, last };
      return { text: textAll.trim(), usage, toolCalls: summaries, rounds, phase };
    }

    messages.push({
      role: "assistant",
      content: cleanText,
      toolCalls: calls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: spare ? stubWireArgs(call.name, call.arguments) : call.arguments,
      })),
      id: stableId(calls.map((call) => call.id).join("|")),
    });

    for (const call of calls) {
      if (isAborted()) break;
      const started = Date.now();
      const signature = call.name + "\u0000" + call.arguments;
      const times = (seenCalls.get(signature) || 0) + 1;
      seenCalls.set(signature, times);
      if (times >= 3) repeated = true;
      const tool = byName.get(call.name);
      let ok = false;
      let args = null;
      let content = "";
      if (!tool) {
        content = "ERROR: unknown tool " + String(call.name);
      } else {
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch (error) {
          content = "ERROR: tool arguments are not valid JSON";
        }
        if (!content) {
          emit({ t: "tool", phase: "start", name: call.name, args: args, round: rounds });
          try {
            content = await tool.run(args, { signal });
            ok = !String(content).startsWith("ERROR:");
          } catch (error) {
            content = "ERROR: " + String(error && error.message ? error.message : error);
          }
        }
      }
      const text = typeof content === "string" ? content : JSON.stringify(content);
      // 轻量不再压缩工具结果：省下的这 1~2K 字符会让模型多读一轮，
      // 多花的是一整次请求，净亏。
      const clipped = summarizeToolResult(
        text,
        terse ? TERSE_TOOL_RESULT : MAX_TOOL_RESULT,
        terse ? TERSE_SUMMARY_LINES : FULL_SUMMARY_LINES,
      );
      summaries.push({
        round: rounds,
        name: call.name,
        args: args === null ? { raw: call.arguments || "" } : slimArgs(call.name, args),
        ok,
        resultPreview: text.length > 200 ? text.slice(0, 200) + "…" : text,
        chars: text.length,
        sent: clipped.length,
        ms: Date.now() - started,
      });
      emit({
        t: "tool",
        phase: "end",
        name: call.name,
        ok: ok,
        ms: Date.now() - started,
        chars: text.length,
        preview: text.length > 200 ? text.slice(0, 200) + "…" : text,
      });
      messages.push({ role: "tool", toolCallId: call.id, content: clipped });
    }

    if (repeated) break;
  }

  const stopped = isAborted();
  const reason = repeated
    ? "检测到重复的工具调用，已提前停止"
    : "工具调用轮次已达上限 " + String(cfg.maxToolRounds);
  let closing = "";
  if (!stopped) {
    try {
      closing = (await finishWithoutTools(reason, messages.slice())).trim();
    } catch (error) {
      closing = "";
    }
  }
  return {
    text: joinAnswer({ lite: spare, terse: terse, steps: textAll, closing, stopped, reason }),
    usage: { input, hit, output, prompt: promptTotal, last },
    toolCalls: summaries,
    rounds,
    phase,
    ...(stopped ? { stopped: true } : {}),
  };
}
