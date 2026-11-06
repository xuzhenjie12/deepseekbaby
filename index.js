/**
 * Host half of deepseekbaby.
 *
 * Serves one self-contained page at `/node-chat` plus its small JSON API, keeps
 * the node tree under `$DSH_HOME/node-chat/`, and runs a bounded tool loop over
 * DSH's configured provider (or a configured OpenAI-compatible endpoint).
 *
 * No `@deepseek-ai/*` import: a plugin installed from an arbitrary directory
 * cannot resolve those modules, so only Node built-ins and services reached
 * through the Cordis context are used.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTurn, selectionOf } from "./lib/agent.js";
import { appendTurn, ledgerPath, summary as billingSummary } from "./lib/billing.js";
import { describeSeams, seamReport } from "./lib/compat.js";
import { ROUND_PRESETS, resolveConfig } from "./lib/config.js";
import { listSessions, readRounds } from "./lib/sessions.js";
import { composeText, createStore, workspaceOf } from "./lib/store.js";
import { createTools } from "./lib/tools.js";
import { createWorkspace } from "./lib/workspace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PREFIX = "/node-chat";
const MAX_BODY = 1024 * 1024;
// The package may be installed under either name; restart finds whichever is loaded.
const MODULE_NAMES = ["deepseekbaby", "@local/deepseekbaby", "@local/node-chat"];

/**
 * One main task owns one workspace. An empty field gets a fresh private folder
 * under the deployment workspace so tasks never share files by accident.
 */
async function prepareWorkspace(input, title, fallbackRoot) {
  if (typeof input !== "string" || !input.trim()) {
    const slug = String(title || "task")
      .replace(/[\\/:*?"<>|\s]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task";
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const target = join(fallbackRoot, ".deepseekbaby", "workspaces", slug + "-" + stamp);
    await fs.mkdir(target, { recursive: true });
    return fs.realpath(target);
  }
  const raw = input.trim();
  if (!isAbsolute(raw)) throw new Error("工作区必须是绝对路径，例如 D:\\work\\task-a");
  if (/^[A-Za-z]:[\\/]?$/.test(raw)) throw new Error("不要直接用磁盘根目录作为工作区");
  const info = await fs.stat(raw).catch(() => null);
  if (info && !info.isDirectory()) throw new Error("工作区路径不是目录");
  if (!info) await fs.mkdir(raw, { recursive: true });
  return fs.realpath(raw);
}

/**
 * Directory-only listing for the workspace picker. Empty input lists drives on
 * Windows. It never returns file contents, and the panel is same-origin only.
 */
async function browseDirectories(input) {
  if (typeof input !== "string" || !input.trim()) {
    if (process.platform !== "win32") {
      return {
        path: "",
        parent: null,
        dirs: [{ name: "/", path: "/" }, { name: homedir(), path: homedir() }],
      };
    }
    const drives = [];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const candidate = letter + ":\\";
      const info = await fs.stat(candidate).catch(() => null);
      if (info && info.isDirectory()) drives.push({ name: candidate, path: candidate });
    }
    return { path: "", parent: null, dirs: drives };
  }
  const target = resolve(input.trim());
  const info = await fs.stat(target).catch(() => null);
  if (!info || !info.isDirectory()) throw new Error("目录不存在：" + target);
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(target, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const parent = dirname(target);
  return { path: target, parent: parent === target ? "" : parent, dirs };
}

/** Keep uploads inside the task workspace and never let a name escape it. */
function safeFileName(value) {
  const base = basename(String(value || "file")).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
  return base || "file";
}

/** Only paths the upload route produced: relative, no traversal, no absolute. */
function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 8).map((item) => {
    if (!item || typeof item !== "object") return null;
    const name = typeof item.name === "string" ? item.name.slice(0, 120) : "";
    const path = typeof item.path === "string" ? item.path.replace(/\\/g, "/").slice(0, 400) : "";
    if (!name || !path || isAbsolute(path) || path.split("/").includes("..")) return null;
    const record = {
      name,
      path,
      size: Number(item.size) || 0,
      mediaType: typeof item.mediaType === "string" ? item.mediaType.slice(0, 100) : "",
      kind: item.kind === "image" ? "image" : "file",
    };
    if (record.kind === "image" && item.ref && typeof item.ref === "object") record.ref = item.ref;
    return record;
  }).filter(Boolean);
}

function sendJson(res, code, payload) {
  try {
    res.writeHead(code, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(payload));
  } catch (error) {
    // The socket may already be closed.
  }
}

function sendHtml(res, html) {
  try {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
  } catch (error) {
    // The socket may already be closed.
  }
}

function sameOriginOk(req) {
  const host = req.headers.host;
  const source = req.headers.origin || req.headers.referer;
  if (!source) return true;
  try {
    return new URL(source).host === host;
  } catch (error) {
    return false;
  }
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Usage shown for the last turn.
 *
 * A live probe across two turns shows `cacheReadTokens` is the *cached prefix*
 * of this request, not a running total (the raw value stayed 2560 while the
 * next turn reported 414 new input tokens). `input` is therefore the uncached
 * part, so the prompt total is `input + hit` and the hit share is
 * `hit / (input + hit)`. Both raw numbers stay in history for later recompute.
 */
function lastTurnStats(visible) {
  const assistants = visible.filter(
    (entry) => entry.role === "assistant" && entry.discard !== true && entry.usage,
  );
  const last = assistants[assistants.length - 1];
  if (!last) return null;
  const usage = last.usage && typeof last.usage === "object" ? last.usage : {};
  // New entries keep the final HTTP request's numbers in `last`; a turn with
  // tool rounds would otherwise report sum(input) against max(hit) and look
  // far colder than the last real request. Old entries have no `last`.
  const request = usage.last && typeof usage.last === "object" ? usage.last : usage;
  const input = Number(request.input) || 0;
  const hit = Number(request.hit) || 0;
  const prompt = Number(request.prompt) || input + hit;
  const percent = prompt > 0 ? Math.max(0, Math.min(100, (hit / prompt) * 100)) : 0;
  const calls = Array.isArray(last.toolCalls) ? last.toolCalls : [];
  return {
    input,
    hit,
    prompt,
    output: Number(request.output) || 0,
    turnInput: Number(usage.input) || 0,
    turnHit: Number(usage.hit) || 0,
    turnOutput: Number(usage.output) || 0,
    percent,
    tools: calls.length,
    toolsOk: calls.filter((call) => call.ok === true).length,
    rounds: Number(last.rounds) || 1,
  };
}

/** Total token consumption of the task tree that contains the active node. */
function taskUsageOf(state) {
  const rootId = state.active[0];
  const children = new Map();
  for (const node of state.nodes) {
    const key = node.parent || "";
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node.id);
  }
  const ids = new Set();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    for (const child of children.get(id) || []) stack.push(child);
  }
  let input = 0;
  let hit = 0;
  let output = 0;
  let turns = 0;
  for (const entry of state.history) {
    if (!ids.has(entry.node) || entry.role !== "assistant" || !entry.usage) continue;
    input += Number(entry.usage.input) || 0;
    hit += Number(entry.usage.hit) || 0;
    output += Number(entry.usage.output) || 0;
    turns += 1;
  }
  return { input, hit, output, turns, nodes: ids.size };
}

/**
 * Seam inventory plus a one-line summary, shared by /api/compat and the
 * start-up log line so the two can never disagree.
 */
function compatReport(webCtx) {
  const report = seamReport((name) => webCtx.get(name), ["webServer"]);
  return { ...report, summary: describeSeams(report) };
}

function describe(state, cfg, label) {
  const pathSet = new Set(state.active);
  const visible = state.history.filter((entry) => pathSet.has(entry.node));
  const counts = new Map();
  for (const entry of state.history) {
    if (entry.discard === true) continue;
    counts.set(entry.node, (counts.get(entry.node) || 0) + 1);
  }
  return {
    nodes: state.nodes.map((node) => ({
      id: node.id,
      parent: node.parent,
      title: node.title,
      closed: node.closed,
      count: counts.get(node.id) || 0,
      workspace: node.workspace || null,
      dev: node.dev === true,
    })),
    active: state.active,
    messages: visible.map((entry) => {
      const message = {
        role: entry.role,
        content: entry.content,
        node: entry.node,
        ts: entry.ts,
        discard: entry.discard === true,
        stopped: entry.stopped === true,
      };
      if (typeof entry.phase === "string") message.phase = entry.phase;
      if (Array.isArray(entry.toolCalls) && entry.toolCalls.length > 0) {
        message.toolCalls = entry.toolCalls;
        message.rounds = Number(entry.rounds) || 1;
      }
      if (entry.parts && typeof entry.parts === "object") {
        message.parts = {
          main: typeof entry.parts.main === "string" ? entry.parts.main : "",
          side: typeof entry.parts.side === "string" ? entry.parts.side : "",
        };
      }
      if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
        message.attachments = entry.attachments.map((item) => ({
          name: item.name,
          path: item.path,
          kind: item.kind,
          size: item.size,
          mediaType: item.mediaType,
        }));
      }
      return message;
    }),
    lastUsage: lastTurnStats(visible),
    taskUsage: taskUsageOf(state),
    toolProfile: (() => {
      const activeNode = state.nodes.find((node) => node.id === state.active[state.active.length - 1]);
      return activeNode && activeNode.toolProfile ? activeNode.toolProfile : "full";
    })(),
    lite: (() => {
      const activeNode = state.nodes.find((node) => node.id === state.active[state.active.length - 1]);
      return Boolean(activeNode && activeNode.lite === true);
    })(),
    terse: (() => {
      const activeNode = state.nodes.find((node) => node.id === state.active[state.active.length - 1]);
      return Boolean(activeNode && activeNode.terse === true);
    })(),
    maxRounds: (() => {
      const activeNode = state.nodes.find((node) => node.id === state.active[state.active.length - 1]);
      return activeNode && ROUND_PRESETS.includes(activeNode.maxRounds) ? activeNode.maxRounds : null;
    })(),
    model: label,
  };
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const store = createStore();
  const workspace = createWorkspace(cfg, ctx);
  let pendingRestart = false;
  const tools = createTools(workspace, cfg, ctx, {
    requestRestart: () => { pendingRestart = true; },
  });
  const MAX_UPLOAD = 10 * 1024 * 1024;
  // At most one turn runs at a time (store serializes them); stop aborts that one.
  let activeRun = null;

  /**
   * Disable→enable this plugin so host code reloads. Only call after the HTTP
   * response (or NDJSON stream) has been written, otherwise the route dies
   * mid-answer. Returns false when the deployment has no plugin manager.
   */
  function restartSelf(webCtx, delay) {
    const manager = webCtx.get("pluginManager");
    if (!manager || typeof manager.setPluginEnabled !== "function") return false;
    setTimeout(() => {
      (async () => {
        const plugins = await manager.listPlugins();
        const entry = (plugins || []).find((item) => MODULE_NAMES.includes(item.moduleName));
        if (!entry) throw new Error("找不到 deepseekbaby 的插件条目");
        await manager.setPluginEnabled(entry.entryId, false);
        await new Promise((resolve) => setTimeout(resolve, 600));
        await manager.setPluginEnabled(entry.entryId, true);
      })().catch(() => {
        // The next request will fail until the plugin is re-enabled by hand.
      });
    }, typeof delay === "number" ? delay : 200);
    return true;
  }

  /**
   * Save one upload into the task workspace. Images are also admitted to the
   * attachment store so the model can receive them as image content blocks.
   */
  async function receiveUpload(webCtx, state, body) {
    const data = Buffer.from(String(body.data || ""), "base64");
    if (data.length === 0) throw new Error("文件为空或不是合法 base64");
    if (data.length > MAX_UPLOAD) throw new Error("单个文件上限 10MB");
    const name = safeFileName(body.name);
    const mediaType = typeof body.mediaType === "string" && body.mediaType.trim()
      ? body.mediaType.trim()
      : "application/octet-stream";
    const kind = mediaType.startsWith("image/") ? "image" : "file";
    const nodeId = typeof body.nodeId === "string" && body.nodeId
      ? body.nodeId
      : state.active[state.active.length - 1];
    const root = workspaceOf(state, nodeId) || await workspace.defaultRoot();
    const activeNode = state.nodes.find((node) => node.id === nodeId);
    // Developer tasks keep their uploads out of the plugin's real folders.
    const dir = join(root, activeNode && activeNode.dev ? ".dev-uploads" : "uploads");
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const target = join(dir, stamp + "-" + name);
    await fs.writeFile(target, data);
    const record = {
      name,
      path: relative(root, target).replace(/\\/g, "/"),
      size: data.length,
      mediaType,
      kind,
    };
    if (kind === "image") {
      try {
        const service = typeof webCtx.get === "function" ? webCtx.get("attachments") : undefined;
        if (service && typeof service.saveImages === "function") {
          const refs = await service.saveImages([{ data, mediaType, name }]);
          if (Array.isArray(refs) && refs[0]) record.ref = refs[0];
        }
      } catch (error) {
        record.visionError = String(error && error.message ? error.message : error);
      }
    }
    return record;
  }

  const label = () => {
    if (cfg.baseURL) return cfg.model || "deepseek-chat";
    const selection = selectionOf(ctx);
    return [cfg.provider || selection.provider, cfg.model || selection.model].filter(Boolean).join("/") || "";
  };

  const prices = () => ({
    hit: cfg.priceHitPerM,
    miss: cfg.priceMissPerM,
    output: cfg.priceOutputPerM,
  });

  /**
   * Record the turn just persisted in `history.json` on the append-only ledger.
   * Deleting nodes or turns later must not rewrite past spend, so this is the
   * only writer and it appends exactly one line per finished answer.
   */
  async function bill(state) {
    const last = state.history[state.history.length - 1];
    if (!last || last.role !== "assistant" || !last.usage) return;
    await appendTurn({
      ts: last.ts,
      node: last.node || "",
      model: label(),
      usage: last.usage,
    }, prices());
  }

  const page = () => fs.readFile(join(HERE, "panel.html"), "utf8");

  const handler = async (webCtx, req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname !== PREFIX && pathname !== PREFIX + "/" && !pathname.startsWith(PREFIX + "/")) {
      return sendJson(res, 404, { ok: false, error: "未知路由" });
    }
    if (!sameOriginOk(req)) {
      return sendJson(res, 403, { ok: false, error: "仅接受同源请求" });
    }
    if (pathname === PREFIX || pathname === PREFIX + "/") {
      try {
        return sendHtml(res, await page());
      } catch (error) {
        return sendHtml(
          res,
          "<!doctype html><meta charset=\"utf-8\"><h1>deepseekbaby</h1><p>panel.html 读取失败：" +
            String(error && error.message ? error.message : error).replace(/[<>&]/g, "") +
            "</p>",
        );
      }
    }

    const method = String(req.method || "GET").toUpperCase();

    // The panel's Markdown renderer lives in its own file so the host can also
    // serve it to tests, but it is still served from this same prefix.
    if (method === "GET" && pathname === PREFIX + "/markdown.js") {
      try {
        const source = await fs.readFile(join(HERE, "panel-markdown.js"), "utf8");
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(source);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: "markdown.js 读取失败" });
      }
      return;
    }

    // The pair-of-whales mark: used by the panel header/favicon and by anything
    // that wants the same art without copying the path around.
    if (method === "GET" && pathname === PREFIX + "/icon.svg") {
      try {
        const source = await fs.readFile(join(HERE, "icon.svg"), "utf8");
        res.writeHead(200, {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(source);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: "icon.svg 读取失败" });
      }
      return;
    }

    const apiPrefix = PREFIX + "/api";
    if (!pathname.startsWith(apiPrefix + "/")) {
      return sendJson(res, 404, { ok: false, error: "未知路由" });
    }
    const route = pathname.slice(apiPrefix.length);

    const respond = async (state) => sendJson(res, 200, {
      ok: true,
      root: await workspace.root(),
      state: describe(state, cfg, label()),
    });

    try {
      if (method === "GET" && route === "/fs") {
        const target = url.searchParams.get("path") || "";
        try {
          return sendJson(res, 200, { ok: true, ...(await browseDirectories(target)) });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
        }
      }

      if (method === "GET" && route === "/state") {
        return respond(await store.readState());
      }

      if (method === "GET" && route === "/billing") {
        const days = Number(url.searchParams.get("days"));
        const hours = Number(url.searchParams.get("hours"));
        const data = await billingSummary({
          ...(Number.isFinite(hours) && hours > 0
            ? { hours }
            : { days: Number.isFinite(days) ? days : 30 }),
          prices: prices(),
          currency: cfg.priceCurrency,
        });
        return sendJson(res, 200, { ok: true, ...data, ledger: ledgerPath() });
      }

      // Which DSH services this deployment actually exposes. Borrowers of
      // internals need a way to say *which* seam went missing.
      if (method === "GET" && route === "/compat") {
        return sendJson(res, 200, { ok: true, ...compatReport(webCtx) });
      }

      if (method === "GET" && route === "/sessions") {
        return sendJson(res, 200, { ok: true, sessions: await listSessions(webCtx, 20) });
      }

      if (method === "POST" && route === "/upload") {
        const body = await readBody(req, 16 * 1024 * 1024);
        try {
          const file = await receiveUpload(webCtx, await store.readState(), body);
          return sendJson(res, 200, { ok: true, file });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
        }
      }

      if (method === "POST" && route === "/send") {
        const body = await readBody(req);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        const side = typeof body.side === "string" ? body.side.trim() : "";
        const parts = { main: text, side };
        const composed = composeText(parts);
        const attachments = sanitizeAttachments(body.attachments);
        if (!composed && attachments.length === 0) {
          return sendJson(res, 400, { ok: false, error: "消息为空" });
        }
        if (composed.length > 8000) return sendJson(res, 400, { ok: false, error: "消息过长（上限 8000 字）" });

        const controller = new AbortController();

        if (body.stream === true) {
          res.writeHead(200, {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-store",
            "x-accel-buffering": "no",
          });
          if (typeof res.flushHeaders === "function") res.flushHeaders();
          let closed = false;
          res.on("close", () => { closed = true; });
          const write = (event) => {
            if (closed) return;
            try {
              res.write(JSON.stringify(event) + "\n");
            } catch (error) {
              closed = true;
            }
          };
          try {
            const state = await store.turn(
              composed,
              body.discard === true,
              (context, profile, options) => {
                workspace.setRoot(options.workspace);
                activeRun = { controller, stopped: false };
                return runTurn({
                  ctx: webCtx, cfg: { ...cfg, maxToolRounds: options.maxRounds ? options.maxRounds : cfg.maxToolRounds, liteWire: options.lite === true, litePlan: options.litePlan === true, liteExec: options.liteExec === true, terseWire: options.terse === true }, tools, history: context, profile,
                  web: options.web === true, dev: options.dev === true, signal: controller.signal, onEvent: write,
                });
              },
              { web: body.web === true, attachments, parts, exec: body.exec === true },
            );
            await bill(state);
            write({ t: "done", root: await workspace.root(), state: describe(state, cfg, label()) });
          } catch (error) {
            write({ t: "error", error: String(error && error.message ? error.message : error) });
          } finally {
            if (activeRun && activeRun.controller === controller) activeRun = null;
            workspace.setRoot(null);
          }
          try {
            res.end();
          } catch (error) {
            // The client already closed the connection.
          }
          if (pendingRestart) {
            pendingRestart = false;
            restartSelf(webCtx, 600);
          }
          return;
        }

        try {
          const state = await store.turn(
            composed,
            body.discard === true,
            (context, profile, options) => {
              workspace.setRoot(options.workspace);
              activeRun = { controller, stopped: false };
              return runTurn({
                ctx: webCtx, cfg: { ...cfg, maxToolRounds: options.maxRounds ? options.maxRounds : cfg.maxToolRounds, liteWire: options.lite === true, litePlan: options.litePlan === true, liteExec: options.liteExec === true, terseWire: options.terse === true }, tools, history: context, profile,
                web: options.web === true, dev: options.dev === true, signal: controller.signal,
              });
            },
            { web: body.web === true, attachments, parts, exec: body.exec === true },
          );
          await bill(state);
          await respond(state);
          if (pendingRestart) {
            pendingRestart = false;
            restartSelf(webCtx, 600);
          }
          return;
        } finally {
          if (activeRun && activeRun.controller === controller) activeRun = null;
          workspace.setRoot(null);
        }
      }

      if (method === "POST" && route === "/stop") {
        if (activeRun) {
          activeRun.controller.abort();
          return sendJson(res, 200, { ok: true, stopping: true });
        }
        return sendJson(res, 200, { ok: true, stopping: false });
      }

      if (method === "POST" && route === "/node/new") {
        const body = await readBody(req);
        const title = typeof body.title === "string" ? body.title : "";
        if (body.root === true) {
          let seed = null;
          if (typeof body.importSessionId === "string" && body.importSessionId) {
            seed = await readRounds(webCtx, body.importSessionId, body.rounds);
          }
          // Developer mode: the task workspace is the plugin source directory.
          if (body.dev === true) {
            return respond(await store.createRoot(title, seed, "full", HERE, true));
          }
          let workspacePath = null;
          try {
            workspacePath = await prepareWorkspace(body.workspace, title, await workspace.defaultRoot());
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
          }
          return respond(await store.createRoot(title, seed, body.toolProfile, workspacePath));
        }
        return respond(await store.createNode(title));
      }

      if (method === "POST" && route === "/node/profile") {
        const body = await readBody(req);
        const id = typeof body.id === "string" ? body.id : "";
        const profile = body.profile;
        if (!id) return sendJson(res, 400, { ok: false, error: "缺少节点 id" });
        return respond(await store.setProfile(id, profile));
      }

      if (method === "POST" && route === "/node/lite") {
        const body = await readBody(req);
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) return sendJson(res, 400, { ok: false, error: "缺少节点 id" });
        return respond(await store.setLite(id, body.lite === true));
      }
      if (method === "POST" && route === "/node/terse") {
        const body = await readBody(req);
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) return sendJson(res, 400, { ok: false, error: "缺少节点 id" });
        return respond(await store.setTerse(id, body.terse === true));
      }
      if (method === "POST" && route === "/node/rounds") {
        const body = await readBody(req);
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) return sendJson(res, 400, { ok: false, error: "缺少节点 id" });
        return respond(await store.setRounds(id, ROUND_PRESETS.includes(body.rounds) ? body.rounds : null));
      }

      if (method === "POST" && route === "/node/delete") {
        const body = await readBody(req);
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) return sendJson(res, 400, { ok: false, error: "缺少节点 id" });
        return respond(await store.deleteNode(id));
      }

      if (method === "POST" && route === "/node/switch") {
        const body = await readBody(req);
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) return sendJson(res, 400, { ok: false, error: "缺少节点 id" });
        return respond(await store.switchNode(id));
      }

      if (method === "POST" && route === "/node/back") {
        return respond(await store.goBack());
      }

      if (method === "POST" && route === "/turns/delete") {
        const body = await readBody(req);
        const count = Number(body.count);
        if (!Number.isFinite(count) || count < 1) {
          return sendJson(res, 400, { ok: false, error: "count 必须是正整数" });
        }
        const id = typeof body.id === "string" ? body.id : "";
        return respond(await store.deleteTurns(id, count));
      }

      if (method === "POST" && route === "/restart") {
        if (!restartSelf(webCtx, 200)) {
          return sendJson(res, 500, { ok: false, error: "当前 DSH 没有插件管理服务" });
        }
        // Answer first: disabling this plugin tears down the route mid-request.
        return sendJson(res, 200, { ok: true, restarting: true });
      }

      return sendJson(res, 404, { ok: false, error: "未知路由 " + method + " " + route });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
    }
  };

  ctx.inject(["webServer"], (webCtx) => {
    // Say once, at start-up, what this deployment is missing: a packed Electron
    // log is the first place a user looks. The full breakdown is /api/compat.
    const report = compatReport(webCtx);
    if (!report.usable || report.degraded.length || !report.node.ok) {
      const write = report.usable ? console.info : console.error;
      write("[deepseekbaby] " + report.summary);
    }
    if (process.env.DEEPSEEKBABY_DEBUG === "1") {
      const data = { ...report };
      delete data.summary;
      console.info("[deepseekbaby] compat " + JSON.stringify(data));
    }
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: "prefix",
        path: PREFIX,
        handler: (req, res) => handler(webCtx, req, res),
      }),
      "deepseekbaby: routes",
    );
  });
}
