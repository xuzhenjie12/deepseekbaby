/** Read DSH sessions through the Host `sessionQuery` service, for task seeding. */

function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function service(ctx) {
  const query = typeof ctx.get === "function" ? ctx.get("sessionQuery") : undefined;
  if (!query || typeof query.listSessions !== "function") {
    throw new Error("当前 DSH 没有会话查询服务");
  }
  return query;
}

/** Recent sessions, newest first, with folded titles. */
export async function listSessions(ctx, limit = 20) {
  const query = service(ctx);
  const records = await query.listSessions();
  const recent = records.slice(0, Math.max(1, Math.min(50, limit)));
  const titles = new Map();
  try {
    const ids = recent.map((record) => record.header.id);
    const observed = await query.readTitleSnapshots(ids);
    for (const item of observed) {
      if (item && item.status === "fulfilled" && item.value && item.value.title) {
        titles.set(item.sessionId, item.value.title.title);
      }
    }
  } catch (error) {
    // Titles are cosmetic; the list still works without them.
  }
  return recent.map((record) => {
    const header = record.header || {};
    const folder = typeof header.cwd === "string" ? header.cwd.split(/[\\/]/).filter(Boolean).pop() : "";
    return {
      id: header.id,
      title: titles.get(header.id) || folder || String(header.id || "").slice(0, 12),
      cwd: header.cwd || "",
      createdAt: header.createdAt || 0,
      live: record.live === true,
    };
  });
}

/**
 * Fold one session log into question/answer rounds and keep the newest `rounds`.
 * Only text parts are imported; tool calls and reasoning are skipped.
 */
export async function readRounds(ctx, sessionId, rounds) {
  const query = service(ctx);
  if (typeof query.readSession !== "function") throw new Error("当前 DSH 没有会话读取能力");
  const snapshot = await query.readSession(sessionId);
  const list = [];
  let current = null;
  for (const event of snapshot.events || []) {
    if (!event || typeof event.type !== "string") continue;
    if (event.type === "user/message") {
      // Only human input starts a round; time-context and other injected
      // reminders carry synthetic source kinds and would cut real pairs apart.
      const source = event.data && event.data.source;
      if (!source || source.kind !== "user") continue;
      const text = textOf(event.data && event.data.content);
      if (!text) continue;
      current = { user: text, answers: [] };
      list.push(current);
    } else if (event.type === "assistant/message" && current) {
      const message = event.data && event.data.message;
      const text = textOf(message && message.content);
      if (text) current.answers.push(text);
    }
  }
  const complete = list.filter((round) => round.answers.length > 0);
  const usable = complete.length > 0 ? complete : list;
  const wanted = Math.max(1, Math.min(50, Number(rounds) || 5));
  const picked = usable.slice(-wanted);
  const messages = [];
  for (const round of picked) {
    messages.push({ role: "user", content: round.user });
    const answer = round.answers.join("\n\n").trim();
    if (answer) messages.push({ role: "assistant", content: answer });
  }
  return messages;
}
