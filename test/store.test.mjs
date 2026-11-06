/** Tail-only turn deletion. Run: node test/store.test.mjs */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { compactSide, composeText, createStore, workspaceOf } from "../lib/store.js";

process.env.DSH_HOME = resolve("tmp-store-test");
await rm(process.env.DSH_HOME, { recursive: true, force: true });

const store = createStore();
await store.createRoot("任务", [], "none");
const answer = (text) => async (ctx) => { globalThis.__lastCtx = ctx; return { text }; };
await store.turn("q1", false, answer("a1"));
await store.turn("q2", false, answer("a2"));
await store.turn("q3", false, answer("a3"));

let state = await store.readState();
assert.equal(state.history.length, 6);
const rootId = state.active[0];

state = await store.deleteTurns(undefined, 2);
assert.deepEqual(state.history.map((entry) => entry.content), ["q1", "a1"], "tail turns removed, head kept");
assert.ok(state.history.every((entry) => entry.node === rootId));

state = await store.deleteTurns(undefined, 10);
assert.equal(state.history.length, 0, "more turns than available removes all");

/* Another node's history must not be touched. */
await store.turn("x", false, answer("y"));
const childState = await store.createNode("子");
const childId = childState.active[childState.active.length - 1];
await store.turn("cq", false, answer("ca"));
state = await store.deleteTurns(childId, 1);
assert.equal(state.history.filter((entry) => entry.node === rootId).length, 2, "parent untouched");
assert.equal(state.history.filter((entry) => entry.node === childId).length, 0, "child tail removed");

/* A user entry without an answer still counts as one turn. */
await store.turn("orphan", false, answer(""));
state = await store.deleteTurns(childId, 1);
assert.equal(state.history.filter((entry) => entry.node === childId).length, 0);

/* A main task owns a workspace; its children inherit it by ancestry. */
const withWorkspace = await store.createRoot("ws", [], "none", "D:\\tmp\\ws-task");
const wsRoot = withWorkspace.nodes.find((node) => node.title === "ws");
assert.equal(workspaceOf(withWorkspace, wsRoot.id), "D:\\tmp\\ws-task");
const wsChild = await store.createNode("ws-child");
const wsChildId = wsChild.active[wsChild.active.length - 1];
assert.equal(workspaceOf(wsChild, wsChildId), "D:\\tmp\\ws-task");
assert.equal(workspaceOf(wsChild, wsRoot.id), "D:\\tmp\\ws-task");

/* Input split: fixed headings, side dropped when blank, parts kept aside. */
assert.equal(composeText(null), "", "no parts means no text");
assert.equal(composeText({ main: "  目标  " }), "目标", "main only, trimmed");
assert.equal(composeText({ main: "A", side: "  \n " }), "A", "blank side adds no heading");
assert.equal(
  composeText({ main: "A", side: "B" }),
  "## 目标\nA\n\n## 补充细节（非必需）\nB",
  "both sections in fixed order",
);
assert.equal(composeText({ side: "B" }), "## 补充细节（非必需）\nB", "side without main");

/* Lite mode: optional details are compacted before the text is sent. */
assert.equal(compactSide(""), "", "empty side stays empty");
assert.equal(compactSide("   "), "", "whitespace-only side stays empty");
assert.equal(compactSide(null), "", "non-string side stays empty");
assert.equal(compactSide(42), "", "number side stays empty");
assert.equal(compactSide(" a \t b \n\n c "), "a b\nc", "whitespace collapsed, blank lines dropped");
assert.equal(compactSide("短内容"), "短内容", "short side untouched");
assert.ok(!compactSide("短内容").includes("已精简"), "short side gets no marker");

const longLine = "x".repeat(401);
assert.equal(compactSide(longLine).length, 400, "single over-long line cut to 160 plus ellipsis");
assert.ok(compactSide(longLine).includes("…"), "over-long line marked with ellipsis");
const edged = "HEAD" + "y".repeat(600) + "TAIL";
assert.ok(compactSide(edged).startsWith("HEAD"), "clipping keeps the head");
assert.ok(compactSide(edged).endsWith("TAIL"), "clipping keeps the tail");

const manyLines = Array.from({ length: 10 }, () => "y".repeat(100)).join("\n");
const compacted = compactSide(manyLines);
assert.ok(compacted.endsWith("…（已精简，原 " + manyLines.length + " 字）"), "over-budget side gets total marker");
assert.ok(compacted.length < manyLines.length, "over-budget side shrinks");
assert.equal(compacted.split("\n").length, 7, "six whole lines kept, then the marker");

/* Budget boundary: the line limit fires first, so use many short lines. */
const fourFifteens = Array.from({ length: 4 }, () => "f".repeat(150)).join("\n");
assert.equal(compactSide(fourFifteens).includes("已精简"), false, "600 counted chars fit the budget");
const fiveFifteens = fourFifteens + "\n" + "f".repeat(150);
assert.equal(compactSide(fiveFifteens).includes("已精简"), true, "750 counted chars overflow the budget");
assert.equal(compactSide("z".repeat(600)).length, 400, "a 600-char single line is cut by the line limit, not the budget");
/* lite flag is opt-in: default and lite:false must leave the text alone. */
const longSide = Array.from({ length: 30 }, (_, index) => "line " + String(index) + " " + "d".repeat(80)).join("\n");
const plain = composeText({ main: "goal", side: longSide });
const lite = composeText({ main: "goal", side: longSide, lite: true });
assert.ok(plain.length > lite.length, "lite text is shorter");
assert.ok(plain.includes(longSide), "non-lite keeps the side verbatim");
assert.ok(lite.startsWith("## 目标\ngoal\n\n## 补充细节（非必需）\n"), "lite keeps the fixed headings");
assert.equal(composeText({ main: "goal", side: longSide, lite: false }).length, plain.length, "lite:false is the old path");

await store.turn(composeText({ main: "goal", side: "notes" }), false, answer("ok"), {
  parts: { main: "goal", side: "notes" },
});
state = await store.readState();
const split = state.history.filter((entry) => entry.node === wsChildId).at(-2);
assert.deepEqual(split.parts, { main: "goal", side: "notes" }, "parts stored beside content");
assert.ok(split.content.includes("## 目标") && split.content.includes("## 补充细节"), "content stays composed");
assert.equal(
  state.history.filter((entry) => entry.node === wsChildId).at(-1).content,
  "ok",
  "answer unchanged",
);

/* lite node rewrites the outgoing text, and the stored copy matches what was sent. */
const liteNode = await store.createNode("lite");
const liteId = liteNode.active[liteNode.active.length - 1];
const liteState = await store.setLite(liteId, true);
assert.equal(liteState.nodes.find((node) => node.id === liteId).lite, true, "setLite persists on the node");
assert.equal(liteState.nodes.find((node) => node.id === childId).lite, false, "setLite leaves siblings alone");
await store.turn(composeText({ main: "g", side: longSide }), false, answer("done"), {
  parts: { main: "g", side: longSide },
});
state = await store.readState();
const liteSent = state.history.filter((entry) => entry.node === liteId).at(-2);
const liteOutgoing = globalThis.__lastCtx.at(-1).content;
assert.equal(liteSent.content, composeText({ main: 'g', side: longSide }), 'history keeps the original text');
assert.ok(liteOutgoing.length < liteSent.content.length, 'lite node sends the compacted text');
assert.deepEqual(liteSent.parts, { main: "g", side: longSide }, "original parts kept for the panel");
assert.equal(state.history.filter((entry) => entry.node === liteId).at(-1).content, "done");

await store.setLite(liteId, false);
state = await store.readState();
assert.equal(state.nodes.find((node) => node.id === liteId).lite, false, "setLite can turn off");

await rm(process.env.DSH_HOME, { recursive: true, force: true });
console.log("store tests: all passed");
