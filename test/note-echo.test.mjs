/**
 * Note-echo contract. Run: node test/note-echo.test.mjs
 *
 * The format note rides on the newest user message. Models sometimes echo it
 * back verbatim; those lines must never reach the panel or the stored history.
 */
import assert from "node:assert/strict";
import {
  TERSE_NOTE,
  LITE_NOTE,
  stripNoteEcho,
  joinAnswer,
} from "../lib/agent.js";

assert.equal(typeof TERSE_NOTE, "string");
assert.ok(TERSE_NOTE.includes("【极简模式】"));

// A pure echo collapses to nothing, so joinAnswer falls back to its placeholder.
assert.equal(stripNoteEcho(TERSE_NOTE), "");
assert.equal(stripNoteEcho(LITE_NOTE), "");

// Content survives; only the echoed note lines are removed.
const echoed = [
  "结论：改动已完成，测试通过。",
  "",
  "【极简模式】",
  "1. 只给结论和完成进度：先一句话说结果，再最多 3 条进度（已完成 / 未完成 / 下一步）。",
  "2. 不展示工具调用：不提工具名、不贴参数、不复述输出、不贴代码或日志。",
  "3. 用户追问细节时再展开；此刻默认不展开。",
].join("\n");
const cleaned = stripNoteEcho(echoed);
assert.equal(cleaned, "结论：改动已完成，测试通过。");

// Numbering and spacing drift are tolerated.
assert.equal(stripNoteEcho("1、 只给结论和完成进度：先一句话说结果，再最多 3 条进度（已完成 / 未完成 / 下一步）。"), "");

// Normal prose that merely mentions the mode is not stripped.
const prose = "极简模式已开启，本轮只报结论。";
assert.equal(stripNoteEcho(prose), prose);

// Terse turns return the cleaned closing text.
assert.equal(
  joinAnswer({ terse: true, steps: "", closing: echoed, stopped: false, reason: "" }),
  "结论：改动已完成，测试通过。"
);

// A note-only reply degrades to the placeholder instead of echoing the note.
const only = joinAnswer({
  terse: true,
  steps: TERSE_NOTE,
  closing: "",
  stopped: false,
  reason: "已达轮数上限",
});
assert.equal(only, "（已达轮数上限，以上为阶段性结果。）");

// Normal mode keeps the multi-round join shape.
assert.equal(
  joinAnswer({ terse: false, lite: false, steps: "第一步", closing: "完成", stopped: false, reason: "" }),
  "第一步\n\n完成"
);

console.log("note-echo: all passed");
