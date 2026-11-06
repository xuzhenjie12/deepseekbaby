/**
 * Local checks for the DSML fallback. Run: node test/dsml.test.mjs
 * No framework: a thrown assertion exits non-zero.
 */
import assert from "node:assert/strict";
import { createStreamFilter, parseCalls, stripMarkup } from "../lib/dsml.js";

const sample = [
  "我先看一下工作区里有什么。",
  "",
  "<｜｜DSML｜｜ calls>",
  '<｜｜DSML｜｜ invoke name="fs_list">',
  '<｜｜DSML｜｜ parameter name="path" string="true">.</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="depth" string="false">1</｜｜DSML｜｜ parameter>',
  "</｜｜DSML｜｜ invoke>",
  "</｜｜DSML｜｜ calls>",
].join("\n");

const calls = parseCalls(sample, () => "id-1");
assert.equal(calls.length, 1);
assert.equal(calls[0].name, "fs_list");
assert.deepEqual(JSON.parse(calls[0].arguments), { path: ".", depth: 1 });

assert.equal(stripMarkup(sample), "我先看一下工作区里有什么。");
assert.equal(stripMarkup("普通回答，没有标记。"), "普通回答，没有标记。");
assert.equal(parseCalls("普通回答").length, 0);

const multiline = [
  '<｜｜DSML｜｜ invoke name="fs_write">',
  '<｜｜DSML｜｜ parameter name="path" string="true">a.txt</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="content" string="true">line1\nline2</｜｜DSML｜｜ parameter>',
  "</｜｜DSML｜｜ invoke>",
].join("\n");
assert.deepEqual(JSON.parse(parseCalls(multiline)[0].arguments), { path: "a.txt", content: "line1\nline2" });

/** The streaming view must never show a marker, at any chunk boundary. */
function streamed(chunks) {
  const parts = [];
  const filter = createStreamFilter((event) => parts.push(event.v));
  for (const chunk of chunks) filter.push(chunk);
  filter.flush();
  return parts.join("");
}

const prose = "我先看一下。\n" + sample.slice(sample.indexOf("<")) + "\n看完了。";
for (let size = 1; size <= 13; size += 1) {
  const chunks = [];
  for (let index = 0; index < prose.length; index += size) chunks.push(prose.slice(index, index + size));
  const out = streamed(chunks);
  assert.equal(out, "我先看一下。\n\n看完了。", "chunk size " + size + " leaked: " + JSON.stringify(out));
}

assert.equal(streamed(["你好", "，世界", "<3"]), "你好，世界<3");
assert.equal(streamed(["只", "有一行"]), "只有一行");

console.log("dsml tests: all passed");
