/**
 * Sent-context contract. Run: node test/sent.test.mjs
 *
 * A turn stores what was typed plus the compacted payload that was actually
 * sent (`sent`). Later turns replay `sent`, so the prefix stays byte-identical
 * and an already-compacted message never grows back when a mode is toggled.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyTerseNote, joinAnswer } from "../lib/agent.js";
import { composeText, createStore } from "../lib/store.js";

process.env.DSH_HOME = resolve("tmp-sent-test");
await rm(process.env.DSH_HOME, { recursive: true, force: true });

const store = createStore();
const created = await store.createRoot("任务", [], "none");
const rootId = created.active[0];

const contexts = [];
const answer = (text) => async (ctx) => {
  contexts.push(ctx.map((entry) => ({ role: entry.role, content: entry.content })));
  return { text };
};

/* --- A lite turn sends compacted text and remembers exactly that. --- */
await store.setLite(rootId, true);
const side = "细节".repeat(1200);
const parts = { main: "目标 A", side };
const full = composeText({ main: parts.main, side: parts.side });
await store.turn(full, false, answer("a1"), { parts });

let state = await store.readState();
const firstUser = state.history.find((entry) => entry.role === "user");
assert.equal(firstUser.content, full, "typed text is kept verbatim");
assert.equal(firstUser.parts.side, side, "original details stay in history");
assert.equal(typeof firstUser.sent, "string", "compacted payload is recorded");
assert.ok(firstUser.sent.length < full.length, "compacted payload is shorter");
const firstSent = firstUser.sent;

/* --- The next turn replays the snapshot, not a recomposition. --- */
await store.turn("q2", false, answer("a2"), {});
const secondUsers = contexts[1].filter((entry) => entry.role === "user");
assert.equal(secondUsers[0].content, firstSent, "earlier user message replays the compacted snapshot");
assert.equal(secondUsers[1].content, "q2", "a plain message is sent as typed");

state = await store.readState();
const plain = state.history.find((entry) => entry.role === "user" && entry.content === "q2");
assert.equal(plain.sent, undefined, "no compaction means no sent field");

/* --- Toggling lite off must not rewrite the prefix. --- */
const before = JSON.stringify(contexts[1].filter((entry) => entry.role === "user"));
await store.setLite(rootId, false);
await store.turn("q3", false, answer("a3"), {});
const after = contexts[2].filter((entry) => entry.role === "user");
assert.equal(after[0].content, firstSent, "compacted snapshot survives the toggle");
assert.equal(
  JSON.stringify(after.slice(0, 2)),
  before,
  "history prefix is byte-identical after toggling lite off",
);

/* --- A malformed sent field is dropped on read. --- */
const historyFile = join(store.dir, "history.json");
const raw = JSON.parse(readFileSync(historyFile, "utf8"));
raw.push({ role: "user", content: "bad-sent", sent: 42, node: rootId, ts: "t" });
writeFileSync(historyFile, JSON.stringify(raw));
state = await store.readState();
assert.equal(state.history.find((entry) => entry.content === "bad-sent").sent, undefined, "invalid sent dropped");

/* --- Terse helpers: conclusion only, note on the newest user message. --- */
assert.equal(joinAnswer({ terse: true, steps: "步骤一\n步骤二", closing: "结论" }), "步骤一\n步骤二\n\n结论", "terse keeps stage text and the closing");
assert.equal(joinAnswer({ lite: true, steps: "步骤", closing: "结论" }), "步骤\n\n结论", "lite keeps every stage");
assert.equal(joinAnswer({ steps: "中间", closing: "最后" }), "中间\n\n最后", "plain mode keeps every stage");
assert.equal(joinAnswer({ terse: true, steps: "", closing: "", stopped: true }), "（已暂停，未产生回复）");
assert.ok(joinAnswer({ terse: true, steps: "", closing: "", reason: "轮数用尽" }).includes("轮数用尽"));

const wire = [
  { role: "system", content: "sys" },
  { role: "user", content: "old" },
  { role: "assistant", content: "a" },
  { role: "user", content: "new" },
];
const noted = applyTerseNote(wire);
assert.equal(noted[0].content, "sys", "system prompt untouched");
assert.equal(noted[1].content, "old", "older turns untouched");
assert.ok(noted[3].content.startsWith("new"), "newest user message keeps its text");
assert.ok(noted[3].content.includes("【极简模式】"), "terse note appended once at the tail");
assert.equal(noted[3].content.split("【极简模式】").length, 2, "note appended exactly once");
assert.equal(wire[3].content, noted[3].content, "wire array is the only thing mutated");

console.log("sent-context: all passed");
