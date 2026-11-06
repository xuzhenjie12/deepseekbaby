import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "deepseekbaby-bill-"));
process.env.DSH_HOME = home;

const billing = await import("../lib/billing.js");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("costOf splits cache hits from misses", () => {
  assert.equal(billing.costOf({ input: 1e6, hit: 0, output: 0 }).amount, 2);
  assert.equal(billing.costOf({ input: 1e6, hit: 1e6, output: 0 }).amount, 0.2);
  assert.equal(billing.costOf({ input: 0, hit: 0, output: 1e6 }).amount, 3);
  const mixed = billing.costOf({ input: 1000, hit: 400, output: 100 });
  assert.equal(mixed.miss, 600);
  assert.equal(Math.round(mixed.amount * 1e8) / 1e8, 0.00158);
});

test("costOf treats usage.prompt as the request total", () => {
  // DSH shape: input is only the uncached part, hit the cached prefix.
  const dsh = billing.costOf({ input: 1285, hit: 3968, output: 500, prompt: 5253 });
  assert.equal(dsh.input, 5253);
  assert.equal(dsh.hit, 3968);
  assert.equal(dsh.miss, 1285);
  assert.equal(Math.round(dsh.amount * 1e8) / 1e8, 0.0048636);
});

test("dayOf reads stamps and fills local days", () => {
  const stamp = billing.dayOf(new Date(2025, 0, 2, 3, 4, 5));
  assert.equal(stamp, "2025-01-02");
  assert.equal(billing.dayOf("2025-01-01 12:00:00"), "2025-01-01");
  assert.equal(billing.dayOf("not a date"), "");
});

test("appendTurn writes one line and skips empty usage", async () => {
  const record = await billing.appendTurn({
    ts: "2025-01-01 10:00:00",
    node: "n1",
    model: "test/model",
    usage: { input: 1e6, hit: 0, output: 0 },
  });
  assert.equal(record.amount, 2);
  assert.equal(record.day, "2025-01-01");
  const empty = await billing.appendTurn({ usage: { input: 0, hit: 0, output: 0 } });
  assert.equal(empty, null);
  const raw = await readFile(billing.ledgerPath(), "utf8");
  assert.equal(raw.trim().split("\n").length, 1);
});

test("summary fills empty days and totals even outside the window", async () => {
  const raw = await readFile(billing.ledgerPath(), "utf8");
  await writeFile(billing.ledgerPath(), raw + "{\"ts\":\"torn", "utf8");
  const result = await billing.summary({ days: 3 });
  assert.equal(result.days.length, 3);
  assert.equal(result.days.filter((day) => day.amount > 0).length, 0);
  assert.equal(result.total.amount, 2);
  assert.equal(result.total.turns, 1);
  assert.equal(result.currency, "CNY");
  assert.equal(result.prices.miss, 2);
});

test("hourOf buckets by local hour", () => {
  assert.equal(billing.hourOf(new Date(2025, 0, 2, 3, 4, 5)), "2025-01-02 03:00");
  assert.equal(billing.hourOf("2025-01-01 12:34:56"), "2025-01-01 12:00");
  assert.equal(billing.hourOf("not a date"), "");
});

test("summary counts the hourly window and fills empty hours", async () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = billing.dayOf(now) + " " + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":00";
  await writeFile(billing.ledgerPath(), JSON.stringify({
    ts,
    day: billing.dayOf(ts),
    node: "n1",
    model: "test/model",
    input: 1e6,
    hit: 0,
    output: 0,
    amount: 2,
  }) + "\n", "utf8");
  const result = await billing.summary({ hours: 24 });
  assert.equal(result.window, "hour", "hourly window signalled");
  assert.equal(result.hours.length, 24, "24 hourly buckets");
  assert.equal(result.hours.filter((row) => row.amount > 0).length, 1, "only the current hour has spend");
  const bucket = result.hours.find((row) => row.hour === billing.hourOf(ts));
  assert.equal(bucket.amount, 2, "the record lands in its hour bucket");
  assert.equal(bucket.turns, 1);
  assert.equal(result.total.turns, 1, "total counts the ledger once");
  assert.equal(result.hours.at(-1).hour, billing.hourOf(new Date()), "the axis ends at the current hour");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log("ok -", name);
  } catch (error) {
    failed += 1;
    console.error("not ok -", name);
    console.error(error && error.stack ? error.stack : error);
  }
}
console.log(`billing tests: ${failed === 0 ? "all passed" : failed + " failed"}`);
process.exit(failed === 0 ? 0 : 1);
