/** Durable node tree and flat message history under `$DSH_HOME/node-chat/`. */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hasMarkup, stripMarkup } from "./dsml.js";
import { isExecConfirm } from "./agent.js";

const DEFAULT_NODES = () => ({
  nodes: [{ id: "main", parent: null, title: "主任务", closed: false, workspace: null }],
  active: ["main"],
});

export function dataDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");
  return join(home, "deepseekbaby");
}

export function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(), "-", pad(date.getMonth() + 1), "-", pad(date.getDate()),
    " ", pad(date.getHours()), ":", pad(date.getMinutes()), ":", pad(date.getSeconds()),
  ].join("");
}

/**
 * Join the two input fields into the text that is actually sent and stored.
 * Order and headings are fixed on purpose: a stable prefix keeps the prompt
 * cache warm, so the split must never reorder or add timestamps.
 */
/** Lite mode rewrites long optional details into a short outline before sending. */
const LITE_SIDE_MAX = 600;
const LITE_LINE_MAX = 400;
/** Over-long lines keep both ends: paths and identifiers usually sit at the edges. */
const LITE_HEAD = 240;
const LITE_TAIL = 159;

export function compactSide(side) {
  const raw = typeof side === "string" ? side : "";
  const lines = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  const kept = [];
  let used = 0;
  let cut = false;
  for (const line of lines) {
    const trimmed =
      LITE_LINE_MAX - line.length < 0
        ? line.slice(0, LITE_HEAD) + "…" + line.slice(line.length - LITE_TAIL)
        : line;
    if (used + trimmed.length > LITE_SIDE_MAX) {
      cut = true;
      break;
    }
    kept.push(trimmed);
    used += trimmed.length;
  }
  if (kept.length === 0) return "";
  if (cut) kept.push("…（已精简，原 " + String(raw.length) + " 字）");
  return kept.join("\n");
}

export function composeText(parts) {
  const main = parts && typeof parts.main === "string" ? parts.main.trim() : "";
  const sideRaw = parts && typeof parts.side === "string" ? parts.side.trim() : "";
  const side = parts && parts.lite === true ? compactSide(sideRaw) : sideRaw;
  if (!side) return main;
  if (!main) return "## 补充细节（非必需）\n" + side;
  return "## 目标\n" + main + "\n\n## 补充细节（非必需）\n" + side;
}

export function pathOf(nodes, id) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path = [];
  const seen = new Set();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current.id);
    current = current.parent ? byId.get(current.parent) : undefined;
  }
  return path;
}

/** Nearest workspace up the ancestry: each main task shares one with its subtree. */
export function workspaceOf(source, id) {
  const nodes = Array.isArray(source) ? source : source && Array.isArray(source.nodes) ? source.nodes : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set();
  let node = byId.get(id);
  while (node && !seen.has(node.id)) {
    if (node.workspace) return node.workspace;
    seen.add(node.id);
    node = node.parent ? byId.get(node.parent) : undefined;
  }
  return null;
}

function nextId(nodes) {
  const taken = new Set(nodes.map((node) => node.id));
  let index = 1;
  while (taken.has("n" + String(index))) index += 1;
  return "n" + String(index);
}

const ROUND_VALUES = [4, 8, 12, 24];

function normalizeRounds(value) {
  return ROUND_VALUES.includes(value) ? value : null;
}

function normalizeNodes(raw) {
  const source = raw && Array.isArray(raw.nodes) ? raw : DEFAULT_NODES();
  const nodes = source.nodes
    .filter((node) => node && typeof node.id === "string" && node.id.length > 0)
    .map((node) => ({
      id: node.id,
      parent: typeof node.parent === "string" ? node.parent : null,
      title: typeof node.title === "string" && node.title.trim() ? node.title : node.id,
      closed: node.closed === true,
      toolProfile: normalizeProfile(node.toolProfile),
      // Lite mode: compress optional details, hide tool call details.
      lite: node.lite === true,
      // Terse mode: conclusions only, tool details never leave the server.
      terse: node.terse === true,
      maxRounds: normalizeRounds(node.maxRounds),
      // Developer tasks point their workspace at the plugin source itself.
      dev: node.dev === true,
      // Only a main task owns a workspace; children inherit it by ancestry.
      workspace: typeof node.workspace === "string" && node.workspace.trim() ? node.workspace : null,
    }));
  if (nodes.length === 0) return DEFAULT_NODES();
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    if (node.parent !== null && !ids.has(node.parent)) node.parent = null;
  }
  const wanted = Array.isArray(source.active) ? source.active[source.active.length - 1] : undefined;
  let active = typeof wanted === "string" ? pathOf(nodes, wanted) : [];
  if (active.length === 0) active = pathOf(nodes, ids.has("main") ? "main" : nodes[0].id);
  if (active.length === 0) active = [nodes[0].id];
  return { nodes, active };
}

function normalizeProfile(value) {
  return value === "none" || value === "basic" ? value : "full";
}

/**
 * Old turns stored leaked tool markup as the assistant's visible answer. That
 * markup then got replayed into every later request. Clean it once on read and
 * drop answers that consisted of nothing but markup.
 */
function sanitizeHistory(history) {
  let changed = false;
  const next = [];
  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;
    let content = typeof entry.content === "string" ? entry.content : "";
    if (hasMarkup(content)) {
      content = stripMarkup(content);
      changed = true;
    }
    const hasCalls = Array.isArray(entry.toolCalls) && entry.toolCalls.length > 0;
    if (entry.role === "assistant" && content.trim() === "" && !hasCalls) {
      changed = true;
      continue;
    }
    let clean = content === entry.content ? entry : { ...entry, content };
    if (clean.sent !== undefined && (typeof clean.sent !== "string" || clean.sent === "")) {
      clean = { ...clean };
      delete clean.sent;
      changed = true;
    }
    next.push(clean);
  }
  return { history: next, changed };
}

export function createStore() {
  const dir = dataDir();
  let queue = Promise.resolve();

  const locked = (task) => {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  const file = (name) => join(dir, name);

  async function readJson(name) {
    try {
      return JSON.parse(await fs.readFile(file(name), "utf8"));
    } catch (error) {
      return null;
    }
  }

  async function writeJson(name, value) {
    await fs.mkdir(dir, { recursive: true });
    const target = file(name);
    const temp = target + ".tmp";
    await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(temp, target);
  }

  /** One-time copy from the pre-rename directory (`node-chat`). */
  async function migrateLegacy() {
    const legacy = join(dirname(dir), "node-chat");
    try {
      await fs.access(join(legacy, "nodes.json"));
    } catch (error) {
      return;
    }
    for (const name of ["nodes.json", "history.json"]) {
      try {
        await fs.copyFile(join(legacy, name), file(name));
      } catch (error) {
        // A missing file is fine; the caller creates a default.
      }
    }
  }

  async function ensure() {
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.access(file("nodes.json"));
    } catch (error) {
      await migrateLegacy();
      try {
        await fs.access(file("nodes.json"));
      } catch (stillMissing) {
        await writeJson("nodes.json", DEFAULT_NODES());
      }
    }
    try {
      await fs.access(file("history.json"));
    } catch (error) {
      await writeJson("history.json", []);
    }
  }

  async function readState() {
    await ensure();
    const nodesRaw = await readJson("nodes.json");
    const historyRaw = await readJson("history.json");
    const { nodes, active } = normalizeNodes(nodesRaw);
    const rawHistory = Array.isArray(historyRaw)
      ? historyRaw.filter((entry) => entry && typeof entry === "object" && typeof entry.content === "string")
      : [];
    const { history, changed } = sanitizeHistory(rawHistory);
    if (changed) await writeJson("history.json", history);
    return { nodes, active, history };
  }

  async function persist(state) {
    await writeJson("nodes.json", { nodes: state.nodes, active: state.active });
    await writeJson("history.json", state.history);
  }

  /**
   * Append one question/answer pair. `run` receives the visible context and
   * returns the answer plus optional `usage`, `toolCalls`, and `rounds`.
   */
  function turn(textInput, discard, run, options) {
    return locked(async () => {
      const state = await readState();
      const nodeId = state.active[state.active.length - 1];
      const attachments = Array.isArray(options && options.attachments) ? options.attachments : [];
      const rawParts = options && options.parts && typeof options.parts === "object" ? options.parts : null;
      const parts = rawParts
        ? { main: typeof rawParts.main === "string" ? rawParts.main : "", side: typeof rawParts.side === "string" ? rawParts.side : "" }
        : null;
      const context = state.history
        .filter((entry) => state.active.includes(entry.node) && entry.discard !== true)
        .filter((entry) => entry.role === "user" || entry.role === "assistant")
        .map((entry) => ({
          // `sent` is the text the model actually received on that turn. Reusing
          // the snapshot — rather than recomposing from `parts` with today's
          // flag — keeps the cached prefix byte-identical when a mode is toggled,
          // and keeps an already-compacted payload compacted for good.
          role: entry.role,
          content: typeof entry.sent === "string" && entry.sent ? entry.sent : entry.content,
          node: entry.node,
          ts: entry.ts,
          ...(Array.isArray(entry.attachments) && entry.attachments.length > 0
            ? { attachments: entry.attachments }
            : {}),
        }));
      const activeNode = state.nodes.find((node) => node.id === nodeId);
      const liteOn = Boolean(activeNode && activeNode.lite === true);
      const terseOn = Boolean(activeNode && activeNode.terse === true);
      // 轻量第一轮就是「总结 + 动手」，不再停在方案等确认；点「执行」或直接打
      // 「执行/做吧」只是把后续轮次显式标记为执行阶段。terse 不再屏蔽这一判断。
      const execOn = liteOn
        && (options && options.exec === true || isExecConfirm(textInput));
      const liteText = liteOn && parts ? composeText({ main: parts.main, side: parts.side, lite: true }) : "";
      const userText = liteOn && liteText ? liteText : textInput;
      context.push({ role: "user", content: userText, ...(attachments.length > 0 ? { attachments } : {}) });
      const profile = activeNode && activeNode.toolProfile ? activeNode.toolProfile : "full";
      const answer = await run(context, profile, {
        ...(options || {}),
        workspace: workspaceOf(state, nodeId),
        dev: Boolean(activeNode && activeNode.dev === true),
        maxRounds: activeNode ? normalizeRounds(activeNode.maxRounds) : null,
        lite: liteOn,
        litePlan: liteOn && !execOn,
        liteExec: execOn,
        terse: terseOn,
      });
      const flag = discard ? { discard: true } : {};
      const base = { node: nodeId, ts: stamp() };
      state.history.push({
        role: "user",
        content: textInput,
        // The typed text stays in `content`; `sent` records the compacted
        // payload so every later turn replays exactly this, not the original.
        ...(userText !== textInput ? { sent: userText } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(parts && (parts.main || parts.side) ? { parts } : {}),
        ...base,
        ...flag,
      });
      const entry = {
        role: "assistant",
        content: stripMarkup(answer.text || ""),
        node: nodeId,
        ts: stamp(),
        usage: answer.usage ?? null,
        ...flag,
      };
      if (Array.isArray(answer.toolCalls) && answer.toolCalls.length > 0) {
        entry.toolCalls = answer.toolCalls;
        entry.rounds = answer.rounds || 1;
      }
      if (typeof answer.phase === "string" && answer.phase !== "standard") entry.phase = answer.phase;
      if (answer.stopped === true) entry.stopped = true;
      state.history.push(entry);
      await persist(state);
      return state;
    });
  }

  function createNode(title) {
    return locked(async () => {
      const state = await readState();
      const parent = state.active[state.active.length - 1];
      const parentNode = state.nodes.find((node) => node.id === parent);
      const label = typeof title === "string" && title.trim()
        ? title.trim().slice(0, 60)
        : "节点 " + String(state.nodes.length);
      const node = {
        id: nextId(state.nodes),
        parent,
        title: label,
        closed: false,
        toolProfile: parentNode && parentNode.toolProfile ? parentNode.toolProfile : "full",
        lite: Boolean(parentNode && parentNode.lite === true),
        terse: Boolean(parentNode && parentNode.terse === true),
        maxRounds: parentNode ? normalizeRounds(parentNode.maxRounds) : null,
      };
      state.nodes.push(node);
      state.active = [...state.active, node.id];
      await persist(state);
      return state;
    });
  }

  /** Create a top-level task branch and switch to it; optional seed messages become its initial content. */
  function createRoot(title, seed, profile, workspace, dev) {
    return locked(async () => {
      const state = await readState();
      const roots = state.nodes.filter((node) => node.parent === null).length;
      const label = typeof title === "string" && title.trim()
        ? title.trim().slice(0, 60)
        : "主任务 " + String(roots + 1);
      const isDev = dev === true;
      const node = {
        id: nextId(state.nodes),
        parent: null,
        title: label,
        closed: false,
        toolProfile: isDev ? "full" : normalizeProfile(profile === undefined ? (seed ? "full" : "basic") : profile),
        lite: false,
        workspace: typeof workspace === "string" && workspace.trim() ? workspace : null,
        dev: isDev,
      };
      state.nodes.push(node);
      state.active = [node.id];
      if (Array.isArray(seed)) {
        for (const message of seed) {
          if (!message || typeof message.content !== "string") continue;
          const role = message.role === "assistant" ? "assistant" : "user";
          state.history.push({
            role,
            content: message.content,
            node: node.id,
            ts: message.ts || stamp(),
            imported: true,
          });
        }
      }
      await persist(state);
      return state;
    });
  }

  /** Remove one node, its descendants, and their messages. */
  function deleteNode(id) {
    return locked(async () => {
      const state = await readState();
      const node = state.nodes.find((item) => item.id === id);
      if (!node) throw new Error("节点不存在");
      if (state.nodes.length <= 1) throw new Error("至少保留一个节点");
      const doomed = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const item of state.nodes) {
          if (item.parent && doomed.has(item.parent) && !doomed.has(item.id)) {
            doomed.add(item.id);
            grew = true;
          }
        }
      }
      state.nodes = state.nodes.filter((item) => !doomed.has(item.id));
      state.history = state.history.filter((entry) => !doomed.has(entry.node));
      if (state.active.some((activeId) => doomed.has(activeId))) {
        const parent = node.parent;
        const fallback = parent && state.nodes.some((item) => item.id === parent)
          ? parent
          : (state.nodes.find((item) => item.parent === null) || state.nodes[0]).id;
        state.active = pathOf(state.nodes, fallback);
        if (state.active.length === 0) state.active = [state.nodes[0].id];
      }
      await persist(state);
      return state;
    });
  }

  /** Change one task's tool profile; the whole subtree follows so a task stays consistent. */
  function setProfile(id, profile) {
    return locked(async () => {
      const state = await readState();
      if (!state.nodes.some((node) => node.id === id)) throw new Error("节点不存在");
      let rootId = id;
      for (;;) {
        const current = state.nodes.find((node) => node.id === rootId);
        if (!current || !current.parent) break;
        rootId = current.parent;
      }
      const value = normalizeProfile(profile);
      const members = new Set([rootId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const node of state.nodes) {
          if (node.parent && members.has(node.parent) && !members.has(node.id)) {
            members.add(node.id);
            grew = true;
          }
        }
      }
      for (const node of state.nodes) {
        if (members.has(node.id)) node.toolProfile = value;
      }
      await persist(state);
      return state;
    });
  }

  /** Toggle lite mode for one node and its descendants, like setProfile. */
  function setLite(id, on) {
    return locked(async () => {
      const state = await readState();
      const value = on === true;
      if (!state.nodes.some((node) => node.id === id)) throw new Error("节点不存在");
      const members = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const node of state.nodes) {
          if (node.parent && members.has(node.parent) && !members.has(node.id)) {
            members.add(node.id);
            grew = true;
          }
        }
      }
      for (const node of state.nodes) {
        if (members.has(node.id)) node.lite = value;
      }
      await persist(state);
      return state;
    });
  }

  /** Toggle terse mode for one node and its descendants, like setProfile. */
  function setTerse(id, on) {
    return locked(async () => {
      const state = await readState();
      const value = on === true;
      if (!state.nodes.some((node) => node.id === id)) throw new Error("节点不存在");
      const members = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const node of state.nodes) {
          if (node.parent && members.has(node.parent) && !members.has(node.id)) {
            members.add(node.id);
            grew = true;
          }
        }
      }
      for (const node of state.nodes) {
        if (members.has(node.id)) node.terse = value;
      }
      await persist(state);
      return state;
    });
  }

  /** Cap tool rounds for one node and its descendants, like setProfile. */
  function setRounds(id, rounds) {
    return locked(async () => {
      const state = await readState();
      const value = normalizeRounds(rounds);
      if (!state.nodes.some((node) => node.id === id)) throw new Error("节点不存在");
      const members = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const node of state.nodes) {
          if (node.parent && members.has(node.parent) && !members.has(node.id)) {
            members.add(node.id);
            grew = true;
          }
        }
      }
      for (const node of state.nodes) {
        if (members.has(node.id)) node.maxRounds = value;
      }
      await persist(state);
      return state;
    });
  }

  function switchNode(id) {
    return locked(async () => {
      const state = await readState();
      const next = pathOf(state.nodes, id);
      if (next.length === 0) throw new Error("节点不存在");
      state.active = next;
      await persist(state);
      return state;
    });
  }

  function goBack() {
    return locked(async () => {
      const state = await readState();
      if (state.active.length > 1) state.active = state.active.slice(0, -1);
      await persist(state);
      return state;
    });
  }

  /**
   * Drop the newest N turns of one node.
   *
   * Only the tail is removable on purpose: deleting anywhere earlier would
   * rewrite the prefix after that point and force the next turn to re-bill the
   * whole suffix, while truncating the tail leaves every surviving message byte
   * identical to what was already sent.
   */
  function deleteTurns(id, count) {
    return locked(async () => {
      const state = await readState();
      const nodeId = typeof id === "string" && id ? id : state.active[state.active.length - 1];
      if (!state.nodes.some((node) => node.id === nodeId)) throw new Error("节点不存在");
      const limit = Math.max(1, Math.min(500, Math.trunc(Number(count)) || 1));
      const entries = state.history
        .map((entry, index) => ({ entry, index }))
        .filter((item) => item.entry.node === nodeId);
      if (entries.length === 0) return state;

      const doomed = new Set();
      let removed = 0;
      let cursor = entries.length - 1;
      while (cursor >= 0 && removed < limit) {
        const last = entries[cursor];
        const before = cursor > 0 ? entries[cursor - 1] : undefined;
        if (last.entry.role === "assistant" && before && before.entry.role === "user") {
          doomed.add(before.index);
          doomed.add(last.index);
          cursor -= 2;
        } else {
          doomed.add(last.index);
          cursor -= 1;
        }
        removed += 1;
      }
      state.history = state.history.filter((_entry, index) => !doomed.has(index));
      await persist(state);
      return state;
    });
  }

  return { dir, readState, turn, createNode, createRoot, deleteNode, setProfile, setLite, setTerse, setRounds, switchNode, goBack, deleteTurns };
}
