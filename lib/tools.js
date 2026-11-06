/**
 * Tool registry for node-chat.
 *
 * Every tool exposes an LLM-facing JSON Schema plus `run(args)`, which always
 * resolves to a string: thrown errors are converted by the caller into an
 * "ERROR: ..." payload so one bad call cannot kill the turn.
 *
 * The shell blacklist is a guard against accidents, NOT a sandbox: shell
 * metacharacters, base64, and script files can all bypass it. Keep the tool
 * opt-in (`enableShell`) and treat the workspace root as the only boundary.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { searchWeb } from "./web.js";

const MAX_READ_BYTES = 200 * 1024;
const MAX_LIST_ENTRIES = 2000;
const MAX_SHELL_OUTPUT = 20000;

/** Irreversible whole-disk / host-power operations only. */
const SYSTEM_BLOCKED = [
  /\bformat\s+[a-z]:/i,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /\bdd\s+if=/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bbcdedit\s+\/delete/i,
];

/** The older, broader list: also blocks everyday file deletion. */
const STRICT_BLOCKED = SYSTEM_BLOCKED.concat([
  /\brm\s+-[a-z]*r[a-z]*f?\b/i,
  /\brm\s+-[a-z]*f[a-z]*r\b/i,
  /\bdel\s+\/[a-z]*[sfq]/i,
  /\brmdir\s+\/s/i,
  /\bremove-item\b[^\n]*-recurse[^\n]*-force/i,
]);

function blocked(command, guard) {
  if (guard === "off") return false;
  const list = guard === "strict" ? STRICT_BLOCKED : SYSTEM_BLOCKED;
  return list.some((pattern) => pattern.test(command));
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

/** Textual scope checks for shell commands; a guard, not a sandbox. */
function shellScopeProblem(command) {
  if (/(^|[\s"'=>(\\/])\.\.([\\/\s"'<>)|;&]|$)/.test(command)) return "relative path escapes the workspace";
  if (/%USERPROFILE%|%APPDATA%|%TEMP%|%HOMEDRIVE%|%HOMEPATH%|\$HOME/i.test(command)) {
    return "home directory is outside the workspace";
  }
  if (/(^|[\s=&|;(])~([\s\\/]|$)/.test(command)) return "home directory is outside the workspace";
  if (/(^|[\s=&|;(])\/(?=\s|$)/.test(command)) return "filesystem root is outside the workspace";
  return "";
}

function insideRoots(candidate, roots) {
  const target = resolve(candidate);
  return roots.some((rootPath) => {
    const rel = relative(resolve(rootPath), target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function runShell(command, cwd, timeoutMs, signal) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    function killTree() {
      if (!child) return;
      try {
        if (process.platform === "win32") {
          // cmd.exe is the direct child; /T takes the whole tree (e.g. ping) with it.
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else {
          child.kill("SIGKILL");
        }
      } catch (error) {
        // The process may already be gone.
      }
    }
    function onAbort() {
      killTree();
      finish("ERROR: 已暂停");
    }
    function cleanup() {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    if (signal && signal.aborted) {
      finish("ERROR: 已暂停");
      return;
    }
    try {
      child = spawn(command, { shell: true, cwd, windowsHide: true });
    } catch (error) {
      finish("ERROR: " + String(error && error.message ? error.message : error));
      return;
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      killTree();
      finish("ERROR: 超时");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish("ERROR: " + String(error && error.message ? error.message : error));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      const merged = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      const cut = merged.length > MAX_SHELL_OUTPUT
        ? merged.slice(0, MAX_SHELL_OUTPUT) + "\n...[truncated]"
        : merged;
      finish("exit " + String(code) + (cut ? "\n" + cut : ""));
    });
  });
}

/**
 * Lite no longer freezes the first round: it summarizes, then acts in the same
 * turn. Only the `basic` tool profile still narrows a turn's tools now; this
 * read-only set is kept as the documented floor of that profile.
 */
export const PLAN_TOOL_NAMES = new Set(["fs_read", "fs_list", "web_search"]);

export function planTools(tools) {
  return Array.isArray(tools) ? tools.filter((tool) => tool && PLAN_TOOL_NAMES.has(tool.name)) : [];
}

export function createTools(workspace, cfg, ctx, hooks) {
  const fsRead = {
    name: "fs_read",
    enabled: () => true,
    schema: {
      name: "fs_read",
      description: "Read a UTF-8 text file inside the workspace. Supports line paging with offset/limit; long output is summarized.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root, or an absolute path" },
          offset: { type: "number", description: "1-based first line to read; defaults to 1" },
          limit: { type: "number", description: "Maximum lines to return; defaults to 200" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async run(args) {
      const target = await workspace.resolveIn(args.path);
      const info = await fs.stat(target);
      if (!info.isFile()) return "ERROR: not a file";
      const buffer = await fs.readFile(target);
      const truncatedBytes = buffer.length > MAX_READ_BYTES;
      const lines = buffer.subarray(0, MAX_READ_BYTES).toString("utf8").split("\n");
      const total = lines.length;
      const offset = clamp(args.offset, 1, Math.max(total, 1), 1);
      const limit = clamp(args.limit, 1, 400, 200);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const header = "[lines " + String(offset) + "-" + String(offset - 1 + slice.length) +
        " of " + String(total) + "]" + (truncatedBytes ? " [file truncated at 200KB]" : "");
      return header + "\n" + slice.join("\n");
    },
  };

  const fsList = {
    name: "fs_list",
    enabled: () => true,
    schema: {
      name: "fs_list",
      description: "List files under a workspace directory as a relative path tree.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory relative to the workspace root; defaults to the root" },
          depth: { type: "number", description: "Maximum depth, 1-4; defaults to 2" },
        },
        additionalProperties: false,
      },
    },
    async run(args) {
      const rootReal = await workspace.root();
      const start = args && typeof args.path === "string" && args.path.trim()
        ? await workspace.resolveIn(args.path)
        : rootReal;
      const depth = clamp(args && args.depth, 1, 4, 2);
      const lines = [];
      const walk = async (dir, level) => {
        if (lines.length >= MAX_LIST_ENTRIES) return;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error) {
          return;
        }
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (lines.length >= MAX_LIST_ENTRIES) return;
          if (entry.name === ".git") continue;
          const absolute = join(dir, entry.name);
          const rel = relative(rootReal, absolute) || entry.name;
          if (entry.isDirectory()) {
            lines.push(rel + "/");
            if (level < depth) await walk(absolute, level + 1);
          } else if (entry.isFile()) {
            lines.push(rel);
          }
        }
      };
      await walk(start, 1);
      if (lines.length === 0) return "(empty directory)";
      const capped = lines.length >= MAX_LIST_ENTRIES
        ? lines.concat("...[truncated at " + String(MAX_LIST_ENTRIES) + " entries]")
        : lines;
      return capped.join("\n");
    },
  };

  const fsWrite = {
    name: "fs_write",
    enabled: (config) => config.enableWrite === true,
    schema: {
      name: "fs_write",
      description: "Write a UTF-8 text file inside the workspace, creating parent directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    async run(args) {
      if (!cfg.enableWrite) return "ERROR: fs_write is disabled";
      const target = await workspace.resolveIn(args.path);
      await fs.mkdir(dirname(target), { recursive: true });
      const body = typeof args.content === "string" ? args.content : "";
      await fs.writeFile(target, body, "utf8");
      const rootReal = await workspace.root();
      return "Wrote " + String(Buffer.byteLength(body, "utf8")) + " bytes to " + (relative(rootReal, target) || ".");
    },
  };

  const shell = {
    name: "shell",
    enabled: (config) => config.enableShell === true,
    schema: {
      name: "shell",
      description: "Run a shell command in the workspace root and return exit code plus output.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Command line to run" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
    async run(args, context) {
      if (!cfg.enableShell) return "ERROR: shell is disabled";
      const command = typeof args.command === "string" ? args.command : "";
      if (!command.trim()) return "ERROR: empty command";
      if (blocked(command, cfg.shellGuard)) return "ERROR: command blocked by policy";
      if (cfg.shellScope !== "anywhere") {
        const problem = shellScopeProblem(command);
        if (problem) {
          return "ERROR: " + problem + "（shellScope=workspace；需要全盘访问请在插件配置里改成 anywhere）";
        }
        const allowed = await workspace.allowedRoots();
        const roots = allowed === null ? [await workspace.root(), ...(cfg.roots || [])] : allowed;
        const pattern = /(?:^|[\s"'=>(])([A-Za-z]:[\\/][^\s"'|&;<>)]*)/g;
        let match;
        while ((match = pattern.exec(command)) !== null) {
          if (!insideRoots(match[1], roots)) {
            return "ERROR: path outside workspace: " + match[1] + "（shellScope=workspace）";
          }
        }
      }
      return runShell(command, await workspace.root(), cfg.shellTimeoutMs, context && context.signal);
    },
  };

  const fsDelete = {
    name: "fs_delete",
    enabled: (config) => config.enableDelete === true,
    schema: {
      name: "fs_delete",
      description: "Delete a file or directory. A non-empty directory requires recursive: true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to delete; absolute paths are allowed" },
          recursive: { type: "boolean", description: "Delete a non-empty directory and its contents" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async run(args) {
      if (!cfg.enableDelete) return "ERROR: fs_delete is disabled";
      if (typeof args.path !== "string" || !args.path.trim()) return "ERROR: empty path";
      const target = await workspace.resolveIn(args.path);
      const rootReal = await workspace.root();
      if (target === rootReal) return "ERROR: refusing to delete the workspace root";
      const info = await fs.lstat(target).catch(() => null);
      if (!info) return "ERROR: not found";
      const rootForLabel = rootReal;
      const label = relative(rootForLabel, target) || target;
      if (info.isDirectory()) {
        const recursive = args.recursive === true;
        if (!recursive) {
          const entries = await fs.readdir(target);
          if (entries.length > 0) return "ERROR: directory is not empty (pass recursive: true)";
          await fs.rmdir(target);
          return "Deleted empty directory " + label;
        }
        await fs.rm(target, { recursive: true, force: false });
        return "Deleted directory (recursive) " + label;
      }
      await fs.unlink(target);
      return "Deleted file " + label;
    },
  };

  /**
   * Web search through DSH's `ctx.web` seam, falling back to a direct call
   * authenticated by `apiKeyEnv` or the signed-in DeepSeek account
   * (see lib/web.js). Fails loudly instead of pretending to search.
   */
  const webSearch = {
    name: "web_search",
    enabled: (config) => config.enableWebSearch === true,
    schema: {
      name: "web_search",
      description: "Search the web. Returns deduplicated titles, URLs, dates, and snippets. Use it for current facts, releases, prices, and anything after the model's training cutoff.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query, in the user's language" },
          maxResults: { type: "number", description: "Result count, 1-10; defaults to 5" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async run(args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return "ERROR: query is required";
      const maxResults = clamp(args.maxResults, 1, 10, 5);
      const result = await searchWeb(ctx, query, maxResults, {
        baseURL: cfg.searchBaseURL,
        model: cfg.searchModel,
        apiKey: cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined,
        apiKeyEnv: cfg.apiKeyEnv,
      });
      const sources = Array.isArray(result && result.sources) ? result.sources : [];
      if (sources.length === 0) return "No results for: " + query;
      const lines = sources.map((source, index) => {
        const parts = [String(index + 1) + ". " + (source.title || source.url || "(untitled)")];
        if (source.url) parts.push("   " + source.url);
        if (source.publishedAt) parts.push("   " + source.publishedAt);
        if (source.snippet) parts.push("   " + String(source.snippet).replace(/\s+/g, " ").slice(0, 300));
        return parts.join("\n");
      });
      if (result.truncated) lines.push("(结果已按上限截断)");
      return lines.join("\n\n");
    },
  };

  /** Developer mode only: schedule one restart after the current turn is saved. */
  const restartPlugin = {
    name: "restart_plugin",
    enabled: () => true,
    schema: {
      name: "restart_plugin",
      description: "Developer mode only: restart this plugin after the current turn so edited host code takes effect. Only call after tests pass.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    async run() {
      if (!hooks || typeof hooks.requestRestart !== "function") {
        return "ERROR: 当前宿主不支持自动重启，请让用户点面板上的 ⟳";
      }
      hooks.requestRestart();
      return "已排队：本轮保存并回复后会自动重启插件（约 1 秒）。";
    },
  };

  return [fsRead, fsList, fsWrite, fsDelete, shell, webSearch, restartPlugin];
}
