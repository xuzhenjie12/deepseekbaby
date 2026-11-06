/**
 * DSML text fallback for providers that leak tool-call markup as plain text.
 *
 * DeepSeek sometimes writes its native tool-call syntax as ordinary text
 * instead of a structured `tool-call` block:
 *
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="fs_list">
 *   <｜｜DSML｜｜ parameter name="path" string="true">.</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 *
 * The intent is intact, so the text is parsed back into calls and the markup is
 * stripped from anything stored or shown. Line-based helpers keep the streaming
 * path cheap: a whole `invoke` block is dropped, not forwarded token by token.
 */

const MARK = "｜｜DSML｜｜";

const INVOKE = /<｜｜DSML｜｜\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/｜｜DSML｜｜\s*invoke>/g;
const PARAM = /<｜｜DSML｜｜\s*parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/｜｜DSML｜｜\s*parameter>/g;

export function hasMarkup(text) {
  return typeof text === "string" && text.includes(MARK);
}

function literal(value, isString) {
  if (isString === "true") return value;
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      // Fall through: it is just text.
    }
  }
  return value;
}

/** Turn leaked markup back into `{ name, arguments }` calls; `[]` when there is none. */
export function parseCalls(text, makeId) {
  if (!hasMarkup(text)) return [];
  const calls = [];
  INVOKE.lastIndex = 0;
  for (const match of text.matchAll(INVOKE)) {
    const name = match[1];
    const body = match[2];
    const args = {};
    PARAM.lastIndex = 0;
    for (const param of body.matchAll(PARAM)) {
      args[param[1]] = literal(param[3], param[2]);
    }
    if (Object.keys(args).length === 0) {
      const raw = body.replace(/<[^>]*>/g, "").trim();
      if (raw.startsWith("{")) {
        try {
          Object.assign(args, JSON.parse(raw));
        } catch (error) {
          // Keep the empty object: the model gave no usable arguments.
        }
      }
    }
    calls.push({
      id: typeof makeId === "function" ? makeId() : "dsml-" + String(calls.length),
      name,
      arguments: JSON.stringify(args),
    });
  }
  return calls;
}

/** Remove every leaked markup block and stray tag from `text`. */
export function stripMarkup(text) {
  if (!hasMarkup(text)) return typeof text === "string" ? text : "";
  const withoutBlocks = text
    .replace(/<｜｜DSML｜｜\s*(?:calls|tool_calls)\b[^>]*>[\s\S]*?<\/｜｜DSML｜｜\s*(?:calls|tool_calls)>/g, "")
    .replace(/<｜｜DSML｜｜\s*invoke\b[^>]*>[\s\S]*?<\/｜｜DSML｜｜\s*invoke>/g, "");
  return withoutBlocks
    .split("\n")
    .filter((line) => !line.includes(MARK))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Streaming filter: hold text at the first `<` until it proves not to be a
 * leaked tag, then forward it immediately; suppress a whole block from its
 * opening tag to its closing tag. Text outside the block still streams.
 */
const PREFIX = "<｜｜DSML｜｜";
const OPENER = /^<｜｜DSML｜｜\s*(calls|tool_calls|invoke)\b/;

function closerOf(kind) {
  return new RegExp(
    "</｜｜DSML｜｜\\s*" + (kind === "tool_calls" ? "(?:calls|tool_calls)" : kind) + ">",
  );
}

export function createStreamFilter(emit) {
  let pending = "";
  let inside = null;
  const emitText = (text) => {
    if (text) emit({ t: "text", v: text });
  };

  function pump() {
    for (;;) {
      if (inside) {
        const closer = closerOf(inside).exec(pending);
        if (!closer) return;
        pending = pending.slice(closer.index + closer[0].length);
        inside = null;
        continue;
      }
      const at = pending.indexOf("<");
      if (at < 0) {
        emitText(pending);
        pending = "";
        return;
      }
      if (at > 0) {
        emitText(pending.slice(0, at));
        pending = pending.slice(at);
      }
      // A partial marker, or the full marker waiting for its tag name: hold
      // until the tag closes. Never emit a marker character as text.
      if (pending.startsWith(PREFIX) || PREFIX.startsWith(pending)) {
        if (!pending.startsWith(PREFIX)) return; // still an incomplete marker
        const end = pending.indexOf(">");
        if (end < 0) return;
        const opened = OPENER.exec(pending);
        if (opened) {
          inside = opened[1];
          pending = pending.slice(opened[0].length);
          continue;
        }
        // A stray DSML tag (e.g. a parameter outside a block): drop the tag.
        pending = pending.slice(end + 1);
        continue;
      }
      // Plain text that merely starts with `<`.
      emitText("<");
      pending = pending.slice(1);
    }
  }

  return {
    push(text) {
      pending += text;
      pump();
    },
    flush() {
      if (inside) {
        pending = "";
        inside = null;
        return;
      }
      emitText(pending);
      pending = "";
    },
  };
}
