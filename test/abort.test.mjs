/** Stop mid-turn: partial text is kept, no closing request is made. */
import assert from "node:assert/strict";
import { runTurn } from "../lib/agent.js";
import { resolveConfig } from "../lib/config.js";

let streamCalls = 0;
let sawAbort = false;

const ctx = {
  get(name) {
    if (name === "agentDefaultModel") {
      return { currentSelection: () => ({ provider: "p", model: "m" }) };
    }
    if (name === "llm") {
      return {
        stream(options) {
          streamCalls += 1;
          const signal = options.signal;
          return (async function* () {
            yield { type: "text-delta", text: "部分" };
            await new Promise((resolvePromise, reject) => {
              const fail = () => {
                sawAbort = true;
                reject(new DOMException("aborted", "AbortError"));
              };
              if (signal.aborted) return fail();
              signal.addEventListener("abort", fail, { once: true });
              setTimeout(() => reject(new Error("timeout: abort was not delivered")), 5000);
            });
            yield { type: "text-delta", text: "不该出现" };
          })();
        },
      };
    }
    return undefined;
  },
};

const cfg = resolveConfig({ provider: "p", model: "m", systemPrompt: "test" });
const controller = new AbortController();
setTimeout(() => controller.abort(), 20);

const result = await runTurn({
  ctx,
  cfg,
  tools: [],
  history: [{ role: "user", content: "hi", node: "n", ts: "now" }],
  profile: "none",
  signal: controller.signal,
});

assert.equal(sawAbort, true, "the stream saw the abort");
assert.equal(streamCalls, 1, "no second (closing) model request");
assert.equal(result.stopped, true);
assert.equal(result.text, "部分", "partial text is kept");

/* Abort before the first call: no request at all, still a clean result. */
const pre = new AbortController();
pre.abort();
const early = await runTurn({
  ctx,
  cfg,
  tools: [],
  history: [{ role: "user", content: "hi", node: "n", ts: "now" }],
  profile: "none",
  signal: pre.signal,
});
assert.equal(early.stopped, true);
assert.equal(streamCalls, 1, "pre-aborted turn makes no request");
assert.ok(early.text.includes("已暂停"), early.text);

console.log("abort tests: all passed");
