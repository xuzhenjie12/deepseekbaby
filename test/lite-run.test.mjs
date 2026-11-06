/**
 * 轻量模式回归：工具结果不再压缩、每轮正文都保留。
 * Run: node test/lite-run.test.mjs
 */
import assert from "node:assert/strict";
import { runTurn } from "../lib/agent.js";
import { resolveConfig } from "../lib/config.js";

const BIG = "x".repeat(3000);

function makeTool(log) {
  return {
    name: "fs_read",
    schema: { name: "fs_read", description: "read", parameters: { type: "object" } },
    enabled: () => true,
    async run(args) {
      log.push(args.path);
      return BIG;
    },
  };
}

/** Model: round 1 and 2 read a file, round 3 answers. */
function fakeLlm(seen) {
  let call = 0;
  return {
    stream(options) {
      call += 1;
      seen.push(options.messages);
      return (async function* () {
        if (call === 1) {
          yield { type: "text-delta", text: "先看文件。" };
          yield { type: "block-end", block: { type: "tool-call", id: "c1", name: "fs_read", arguments: '{"path":"a"}' } };
        } else if (call === 2) {
          yield { type: "text-delta", text: "再核对一处。" };
          yield { type: "block-end", block: { type: "tool-call", id: "c2", name: "fs_read", arguments: '{"path":"b"}' } };
        } else {
          yield { type: "text-delta", text: "改完了，已验证。" };
        }
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
}

async function run(cfg) {
  const seen = [];
  const log = [];
  const llm = fakeLlm(seen);
  const ctx = {
    get(name) {
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "p", model: "m" }) };
      if (name === "llm") return llm;
      return undefined;
    },
  };
  const base = resolveConfig({ provider: "p", model: "m", systemPrompt: "test" });
  const result = await runTurn({
    ctx,
    cfg: { ...base, ...cfg },
    tools: [makeTool(log)],
    history: [{ role: "user", content: "帮我改", node: "n", ts: "now" }],
    profile: "full",
  });
  return { result, seen, log };
}

/* --- 轻量：工具结果原样送达，不压缩；三轮正文都在。 --- */
const lite = await run({ liteWire: true });
assert.equal(lite.log.length, 2, "two tool rounds ran");
const flat = (message) => Array.isArray(message.content)
  ? message.content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("")
  : String(message.content || "");

for (const messages of lite.seen) {
  for (const message of messages) {
    if (message.role !== "tool") continue;
    assert.equal(flat(message).length, 3000, "lite sends the tool result verbatim");
  }
}
const lastUserText = (messages) => flat([...messages].reverse().find((message) => message.role === "user") || {});

assert.ok(lastUserText(lite.seen[0]).includes("轻量模式"), "lite note rides on the newest user message");
assert.ok(lite.result.text.includes("先看文件"), "first round text kept");
assert.ok(lite.result.text.includes("再核对一处"), "second round text kept");
assert.ok(lite.result.text.includes("改完了"), "final answer kept");

/* --- 极简：压缩工具结果 + 收短措辞，但正文仍累积。 --- */
const terse = await run({ terseWire: true });
const toolContents = terse.seen.flat().filter((message) => message.role === "tool").map(flat);
assert.ok(toolContents.length > 0, "terse ran tools");
assert.ok(toolContents.every((text) => text.length < 1000), "terse still clips tool results");
assert.ok(terse.result.text.includes("先看文件"), "terse keeps earlier round text");
assert.ok(terse.result.text.includes("改完了"), "terse keeps the final answer");

console.log("lite-run tests: all passed");
