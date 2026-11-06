/**
 * Wire-size checks for the single-round context. Run: node test/wire.test.mjs
 *
 * The open question these guard: every later request in a round resends the
 * whole `messages` array, so anything already done (a written file body, a
 * long tool result) is paid for again on each of up to `maxToolRounds` calls.
 * These tests pin the two fixes: the echoed copy of a written body shrinks, and
 * a long tool result is capped without losing its truncation note.
 */
import assert from "node:assert/strict";
import { stubWireArgs, summarizeToolResult } from "../lib/agent.js";
import { costOf, PRICES_CNY } from "../lib/billing.js";

const MARKER = "UNIQUE-BODY-MARKER-7f3a";
const body = MARKER + "x".repeat(8000);
const writeArgs = JSON.stringify({ path: "lib/big.js", content: body });

/* 1) A written body is not echoed back to the model. */
const stubbed = stubWireArgs("fs_write", writeArgs);
const parsedStub = JSON.parse(stubbed);
assert.equal(parsedStub.path, "lib/big.js", "path must survive: the call needs it");
assert.ok(!stubbed.includes(MARKER), "body must not be echoed");
assert.ok(parsedStub.content.length < 120, "stub should be a line, got " + String(parsedStub.content.length));
assert.ok(parsedStub.content.includes(String(body.length)), "stub should state the body length");
assert.ok(stubbed.length < writeArgs.length / 20, "stub should shrink the call a lot");

/* 2) Edge cases keep the original string untouched (no accidental rewrites). */
assert.equal(stubWireArgs("fs_write", JSON.stringify({ path: "a", content: "" })), JSON.stringify({ path: "a", content: "" }));
assert.equal(stubWireArgs("fs_read", writeArgs), writeArgs);
assert.equal(stubWireArgs("fs_write", "not json"), "not json");
assert.equal(stubWireArgs("fs_write", undefined), undefined);
assert.equal(stubWireArgs("fs_write", JSON.stringify({ path: "a" })), JSON.stringify({ path: "a" }));

/* 3) Long tool output is capped, and the truncation note always survives. */
const longOutput = Array.from({ length: 200 }, (_, i) => "line " + String(i) + " " + "y".repeat(30)).join("\n");
const clipped = summarizeToolResult(longOutput, 1500);
assert.ok(clipped.length <= 1500, "cap is 1500, got " + String(clipped.length));
assert.ok(clipped.includes("已截断"), "the note must survive slicing");
assert.ok(clipped.includes("200 行"), "the note should carry the real line count");
assert.equal(summarizeToolResult("short"), "short");
assert.ok(Math.max(0, summarizeToolResult(longOutput).length - 4000) === 0, "default cap is 4000");

/* 4) Report: what one round of tool traffic costs on the wire, before/after. */
const CHARS_PER_TOKEN = 1.6;
const tokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);
const hitPrice = PRICES_CNY.hit;

function roundSaving(requests, perRequestTokens) {
  // The call appears from request 2 onward, and by then it is cached prefix.
  const t = perRequestTokens * (requests - 1); return costOf({ input: t, hit: t, output: 0 }, PRICES_CNY).amount;
}

const bodyTokens = tokens(writeArgs.length - stubbed.length);
const resultTokens = tokens(longOutput.length - clipped.length);
console.log("\n--- 单轮线上的节省（估算，非账单） ---");
console.log("fs_write 正文精简：每次后续请求少 " + String(bodyTokens) + " token");
console.log("工具结果 4000→1500：每次后续请求最多少 " + String(resultTokens) + " token");
for (const requests of [3, 8, 16]) {
  const write = roundSaving(requests, bodyTokens);
  const result = roundSaving(requests, resultTokens);
  console.log(
    "  " + String(requests) + " 次请求/轮：正文约 ¥" + write.toFixed(5) +
    "（命中价 ¥" + String(hitPrice) + "/M） + 结果上限约 ¥" + result.toFixed(5) +
    "，合计 ¥" + (write + result).toFixed(5),
  );
}
console.log("  说明：这是同轮内的重复传输成本；跨轮本就不保留 tool 消息，收益到此为止。");

console.log("\nwire tests: all passed");
