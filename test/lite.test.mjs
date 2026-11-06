/**
 * Lite-mode savings check. Run: node test/lite.test.mjs
 *
 * This is a model, not a measurement: it compares the tokens composed by
 * `composeText` with and without lite mode, then prices the difference with
 * the real table in `lib/billing.js`. Token counts are estimated from
 * character counts (assumption below), so treat the amounts as upper bounds
 * within a factor of two, not as billed figures.
 */
import assert from "node:assert/strict";
import { costOf, PRICES_CNY } from "../lib/billing.js";
import { compactSide, composeText } from "../lib/store.js";

/* Conservative: 1 token ~ 1.6 CJK characters, so this over-counts tokens. */
const CHARS_PER_TOKEN = 1.6;
const tokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

const SIDE_LINES = [
  "## 背景",
  "这个模块负责把用户的输入拆成目标与补充细节两部分，并按固定顺序拼接后发送。",
  "固定顺序的意义在于保持前缀稳定，让缓存命中不被无意义的重排破坏。",
  "## 已经确认的事实",
  "store.js 的 turn() 只把 user 与 assistant 写进历史，tool 角色的消息会被丢弃。",
  "agent.js 的 MAX_TOOL_RESULT 是 4000，超过部分按前 20 行截断并附带说明。",
  "history.json 里最重的是 toolCalls 的 args，fs_write 的全文会落在那里。",
  "## 约束",
  "不要改动 header 的顺序，不要插入时间戳，不要在任何位置加随机 id。",
  "面板每次请求都实时读盘，所以面板改动刷新即生效，不需要重启插件。",
  "## 待办",
  "精简模式要做成按钮，状态存进 nodes.json，并随 describe() 推送给前端。",
  "发送时压缩补充细节，面板隐藏工具调用明细，只留轮数与结论。",
];

function buildSide(minChars) {
  const out = [];
  let total = 0;
  for (let i = 0; total < minChars; i += 1) {
    const line = SIDE_LINES[i % SIDE_LINES.length];
    out.push(line);
    total += line.length + 1;
  }
  return out.join("\n");
}

const MAIN = "给 store.js 的 composeText 加一个 lite 开关";

/** One conversation, `requests` HTTP calls, each resending the whole prompt. */
function cachedHit(base, body, first, textCached) {
  if (textCached === true) return base + body;
  return first === true ? base : base + body;
}

function roundCost(text, requests, cachedPrefix, textCached) {
  const body = tokens(text.length);
  const base = tokens(cachedPrefix.length);
  let total = 0;
  for (let i = 0; i < requests; i += 1) {
    const first = i === 0;
    total += costOf({
      input: base + body,
      hit: cachedHit(base, body, first, textCached),
      output: 0,
    }, PRICES_CNY).amount;
  }
  return total;
}

/* --- 3000-character details: the case lite mode is meant for. --- */
const side = buildSide(3000);
const plainText = composeText({ main: MAIN, side });
const liteText = composeText({ main: MAIN, side, lite: true });

assert.ok(side.length >= 3000, "fixture holds at least 3000 characters");
assert.ok(liteText.length < plainText.length, "lite text is shorter than the plain text");
assert.ok(liteText.length < 700, "lite text stays near the 600-character budget");

const REQUESTS = 3;
const LATER_ROUNDS = 10;
const cachedPrefix = "## 系统提示与工具定义".repeat(400);

let savedFirstRound = 0;
let savedLaterRounds = 0;
for (let round = 0; round < 1 + LATER_ROUNDS; round += 1) {
  const plainCost = roundCost(plainText, REQUESTS, cachedPrefix, Boolean(round));
  const liteCost = roundCost(liteText, REQUESTS, cachedPrefix, Boolean(round));
  if (round === 0) savedFirstRound += plainCost - liteCost;
  else savedLaterRounds += plainCost - liteCost;
}

const savedTokensPerRequest = tokens(plainText.length) - tokens(liteText.length);

console.log("--- lite mode savings (model, not a bill) ---");
console.log("details: " + String(side.length) + " chars -> " + String(compactSide(side).length) + " chars kept");
console.log("sent text: " + String(plainText.length) + " -> " + String(liteText.length) + " chars");
console.log("tokens/request: -" + String(savedTokensPerRequest) + " (at " + String(CHARS_PER_TOKEN) + " chars/token)");
console.log("first round (" + String(REQUESTS) + " requests, uncached): save CNY " + savedFirstRound.toFixed(6));
console.log("next " + String(LATER_ROUNDS) + " rounds (cached): save CNY " + savedLaterRounds.toFixed(6));
console.log("total: CNY " + (savedFirstRound + savedLaterRounds).toFixed(6));

assert.ok(savedTokensPerRequest > 0, "lite mode sends fewer tokens");
assert.ok(savedFirstRound > 0, "the first round is cheaper");
assert.ok(savedLaterRounds > 0, "later rounds are cheaper");
/* Cached savings are a tenth of uncached ones: say so instead of hiding it. */
assert.ok(
  savedLaterRounds / LATER_ROUNDS < savedFirstRound,
  "each cached round saves less than the first uncached round",
);

/* --- Short details: lite mode is supposed to save nothing here. --- */
const shortSide = "改一行，加个开关。";
const shortPlain = composeText({ main: MAIN, side: shortSide });
const shortLite = composeText({ main: MAIN, side: shortSide, lite: true });
assert.equal(shortLite, shortPlain, "short details are sent unchanged");
const shortDelta = roundCost(shortPlain, REQUESTS, cachedPrefix) - roundCost(shortLite, REQUESTS, cachedPrefix);
assert.equal(shortDelta, 0, "short details save nothing");
console.log("short details (" + String(shortSide.length) + " chars): save CNY " + shortDelta.toFixed(6) + " - as expected");

/* --- Details over the budget but already compact: only the marker is added. --- */
const tightSide = "a".repeat(399);
assert.equal(compactSide(tightSide).length, 399, "399 chars are kept verbatim");

console.log("lite tests: all passed");
