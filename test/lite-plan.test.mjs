/**
 * 轻量：先总结再同一轮里动手；执行阶段按方案继续做；极简与轻量同开时两者叠加。
 * Run: node test/lite-plan.test.mjs
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { isExecConfirm, LITE_EXEC_NOTE, LITE_PLAN_NOTE, runTurn } from "../lib/agent.js";
import { PLAN_TOOL_NAMES, planTools } from "../lib/tools.js";
import { resolveConfig } from "../lib/config.js";
import { createStore } from "../lib/store.js";

process.env.DSH_HOME = resolve("tmp-lite-plan-test");
await rm(process.env.DSH_HOME, { recursive: true, force: true });

/* --- Typed confirmations --- */
for (const text of ["执行", "执行！", " 做吧 ", "开始执行。", "按方案做", "直接改"]) {
  assert.equal(isExecConfirm(text), true, "confirms: " + text);
}
for (const text of ["执行方案", "先执行哪一步？", "不要执行", "", "做吧然后再说"]) {
  assert.equal(isExecConfirm(text), false, "not a bare confirmation: " + text);
}

/* --- The read-only floor is still documented and still filterable --- */
const all = ["fs_read", "fs_list", "fs_write", "shell", "web_search", "restart_plugin"]
  .map((name) => ({ name }));
assert.deepEqual(
  planTools(all).map((tool) => tool.name),
  ["fs_read", "fs_list", "web_search"],
  "the read-only floor keeps only read tools",
);
assert.deepEqual([...PLAN_TOOL_NAMES].sort(), ["fs_list", "fs_read", "web_search"]);
assert.equal(planTools([{ name: "shell" }]).length, 0, "no write tools survive the filter");

/* --- Store wiring: lite starts in plan, exec flag or typed confirm switches it --- */
const store = createStore();
await store.createRoot("任务", [], "none");
const state = await store.readState();
const nodeId = state.active[0];
await store.setLite(nodeId, true);

const seenOptions = [];
const fakeRun = async (context, profile, options) => {
  seenOptions.push(options);
  const phase = options.liteExec ? "exec" : options.litePlan ? "plan" : "standard";
  return { text: "answer-" + phase, phase };
};

await store.turn("帮我改一下", false, fakeRun);
await store.turn("", false, fakeRun, { exec: true });
await store.turn("执行", false, fakeRun);
const after = await store.readState();
const phases = after.history.filter((entry) => entry.role === "assistant").map((entry) => entry.phase);
assert.deepEqual(seenOptions.map((options) => [options.litePlan, options.liteExec]), [
  [true, false],
  [false, true],
  [false, true],
], "plan first; exec via button or typed confirmation");
assert.deepEqual(phases, ["plan", "exec", "exec"], "phase is persisted on the assistant entry");

/* A non-lite node never enters either lite phase. */
await store.createNode("标准");
const standardRun = async (context, profile, options) => ({ text: "std", phase: options.litePlan ? "plan" : "standard" });
await store.turn("普通提问", false, standardRun);
assert.equal(seenOptions.at(-1).litePlan, false, "standard nodes bypass the plan gate");

/* --- runTurn labels the phase and puts the matching note on the wire --- */
function fakeLlm(seen) {
  return {
    stream(options) {
      seen.push(options);
      return (async function* () {
        yield { type: "text-delta", text: "方案：先读文件再改。" };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
}

async function turnText(cfgFlags) {
  const seen = [];
  const ctx = {
    get(name) {
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "p", model: "m" }) };
      if (name === "llm") return fakeLlm(seen);
      return undefined;
    },
  };
  const cfg = { ...resolveConfig({ provider: "p", model: "m", systemPrompt: "test" }), ...cfgFlags };
  const result = await runTurn({
    ctx,
    cfg,
    tools: [],
    history: [{ role: "user", content: "改一下", node: "n", ts: "now" }],
    profile: "none",
  });
  const flat = (message) => (Array.isArray(message.content)
    ? message.content.map((part) => (part && part.text) || "").join("")
    : String(message.content || ""));
  const lastUser = [...seen[0].messages].reverse().find((message) => message.role === "user") || {};
  return { result, userText: flat(lastUser) };
}

const plan = await turnText({ liteWire: true, litePlan: true });
assert.equal(plan.result.phase, "plan", "plan phase returned");
assert.ok(plan.userText.includes("直接开始做"), "plan note tells the model to act instead of stopping");
assert.ok(!plan.userText.includes("这一轮只读"), "plan note no longer freezes the turn");
assert.ok(plan.userText.includes(LITE_PLAN_NOTE.split("\n")[0]), "plan note is on the newest user message");
const exec = await turnText({ liteWire: true, liteExec: true });
assert.equal(exec.result.phase, "exec", "exec phase returned");
assert.ok(exec.userText.includes(LITE_EXEC_NOTE.split("\n")[0]), "exec note rides the newest user message");

/* --- Both switches on: the two notes stack, terse no longer voids lite --- */
const both = await turnText({ liteWire: true, litePlan: true, terseWire: true });
assert.equal(both.result.phase, "plan", "lite keeps its phase while terse is on");
assert.ok(both.userText.includes("【极简模式】"), "terse note still sent");
assert.ok(both.userText.includes("【轻量模式 · 方案】"), "lite note still sent alongside terse");

const bothExec = await turnText({ liteWire: true, liteExec: true, terseWire: true });
assert.equal(bothExec.result.phase, "exec", "exec phase survives terse");

const terseOnly = await turnText({ terseWire: true });
assert.equal(terseOnly.result.phase, "terse", "terse alone keeps its own phase");
assert.ok(terseOnly.userText.includes("【极简模式】"), "terse-only note sent");
assert.ok(!terseOnly.userText.includes("【轻量模式"), "terse alone adds no lite note");

const standard = await turnText({});
assert.equal(standard.result.phase, "standard", "standard phase untouched");
assert.equal(standard.userText, "改一下", "standard mode adds no note");

await rm(process.env.DSH_HOME, { recursive: true, force: true });
console.log("lite-plan tests: all passed");
