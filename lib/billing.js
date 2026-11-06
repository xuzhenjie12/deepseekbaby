/**
 * Append-only cost ledger for deepseekbaby.
 *
 * The node tree in `history.json` is editable — deleting a node or a turn
 * removes those entries, so recomputing spend from it would silently shrink
 * past days. This ledger is therefore append-only and never rewritten.
 *
 * Prices follow DeepSeek's published table for deepseek-chat (V3.2-Exp):
 *   input, cache hit  $0.028 / 1M  = ¥0.2 / 1M
 *   input, cache miss $0.28  / 1M  = ¥2.0 / 1M
 *   output            $0.42  / 1M  = ¥3.0 / 1M
 * See `lib/config.js` for the overridable fields; prices are resolved once at
 * plugin activation, so changing them needs a plugin restart.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./store.js";

/** CNY per 1M tokens. */
export const PRICES_CNY = { hit: 0.2, miss: 2, output: 3 };
/** USD per 1M tokens (same table, DeepSeek's international pricing). */
export const PRICES_USD = { hit: 0.028, miss: 0.28, output: 0.42 };
/** Reference rate used only to display the secondary currency. */
export const USD_CNY = 7.14;

export function ledgerPath() {
  return join(dataDir(), "billing.jsonl");
}

/** Local calendar day, `YYYY-MM-DD`, so "today" matches the user's clock. */
export function dayOf(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** Local hour bucket, `YYYY-MM-DD HH:00`, for the hourly view. */
export function hourOf(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return dayOf(d) + " " + pad(d.getHours()) + ":00";
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Split one usage record into billed buckets and price it.
 *
 * `input` is the full prompt token count and `hit` is the cached prefix inside
 * it, so the uncached remainder is what gets charged at the miss rate.
 */
export function costOf(usage, prices = PRICES_CNY) {
  const hitRaw = num(usage && usage.hit);
  // `prompt` is the request total. DSH entries also carry it now; entries from
  // before that carry only the uncached `input`, where the OpenAI path stores
  // the full prompt. Taking the larger of the two keeps both shapes sane.
  const prompt = num(usage && usage.prompt);
  const input = prompt > 0 ? prompt : Math.max(num(usage && usage.input), hitRaw);
  const hit = Math.min(input, hitRaw);
  const miss = Math.max(0, input - hit);
  const output = num(usage && usage.output);
  const amount = (miss * prices.miss + hit * prices.hit + output * prices.output) / 1e6;
  return { input, hit, miss, output, amount };
}

/** Append one finished turn. Never throws: accounting must not break a turn. */
export async function appendTurn(entry, prices = PRICES_CNY) {
  try {
    const cost = costOf(entry.usage, prices);
    if (cost.input === 0 && cost.output === 0) return null;
    const ts = typeof entry.ts === "string" && entry.ts ? entry.ts : new Date().toISOString();
    const record = {
      ts,
      day: dayOf(ts),
      node: typeof entry.node === "string" ? entry.node : "",
      model: typeof entry.model === "string" ? entry.model : "",
      input: cost.input,
      hit: cost.hit,
      output: cost.output,
      amount: Math.round(cost.amount * 1e8) / 1e8,
    };
    await fs.mkdir(dataDir(), { recursive: true });
    await fs.appendFile(ledgerPath(), JSON.stringify(record) + "\n", "utf8");
    return record;
  } catch (error) {
    return null;
  }
}

/** Read every ledger line, skipping the torn tail a crash can leave behind. */
export async function readLedger() {
  let raw = "";
  try {
    raw = await fs.readFile(ledgerPath(), "utf8");
  } catch (error) {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const item = JSON.parse(text);
      if (item && typeof item === "object") out.push(item);
    } catch (error) {
      // Ignore a partial line from an interrupted append.
    }
  }
  return out;
}

function emptyBucket(key, field) {
  return { [field]: key, input: 0, hit: 0, output: 0, amount: 0, turns: 0 };
}

/**
 * Rolling totals, oldest first, with empty buckets filled in so the chart keeps
 * a stable x-axis. Pass `hours` for the hourly view, `days` for the daily one;
 * both are clamped to keep the payload small.
 */
export async function summary(options = {}) {
  const prices = options.prices || PRICES_CNY;
  const hourly = Number(options.hours) > 0;
  const count = hourly
    ? Math.max(1, Math.min(168, Number(options.hours) || 24))
    : Math.max(1, Math.min(366, Number(options.days) || 30));
  const field = hourly ? "hour" : "day";
  const rows = await readLedger();

  const buckets = new Map();
  const now = new Date();
  if (hourly) {
    const start = new Date(now);
    start.setMinutes(0, 0, 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const d = new Date(start);
      d.setHours(d.getHours() - index);
      const key = hourOf(d);
      buckets.set(key, emptyBucket(key, field));
    }
  } else {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const d = new Date(start);
      d.setDate(d.getDate() - index);
      const key = dayOf(d);
      buckets.set(key, emptyBucket(key, field));
    }
  }

  const total = emptyBucket("total", field);
  // Populate two lists from the source so the summary can be totalled once.
  for (const row of rows) {
    const input = num(row.input);
    const hit = Math.min(input, num(row.hit));
    const output = num(row.output);
    if (input === 0 && output === 0) continue;
    const amount = row.amount !== undefined
      ? num(row.amount)
      : costOf({ input, hit, output }, prices).amount;

    total.input += input;
    total.hit += hit;
    total.output += output;
    total.amount += amount;
    total.turns += 1;

    const key = hourly
      ? hourOf(row.ts)
      : (typeof row.day === "string" && row.day ? row.day : dayOf(row.ts));
    const bucket = buckets.get(key);
    if (!bucket) continue; // older than the requested window
    bucket.input += input;
    bucket.hit += hit;
    bucket.output += output;
    bucket.amount += amount;
    bucket.turns += 1;
  }

  const list = [...buckets.values()].map((bucket) => ({
    ...bucket,
    amount: Math.round(bucket.amount * 1e6) / 1e6,
  }));
  total.amount = Math.round(total.amount * 1e6) / 1e6;
  const result = { total, prices, currency: options.currency || "CNY", window: field };
  result[hourly ? "hours" : "days"] = list;
  return result;
}
