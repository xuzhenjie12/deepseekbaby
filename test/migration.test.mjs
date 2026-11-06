/** Legacy directory migration. Run: node test/migration.test.mjs */
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createStore } from "../lib/store.js";

process.env.DSH_HOME = resolve("tmp-migrate-test");
const home = process.env.DSH_HOME;
await rm(home, { recursive: true, force: true });
await mkdir(join(home, "node-chat"), { recursive: true });
await writeFile(
  join(home, "node-chat", "nodes.json"),
  JSON.stringify({ nodes: [{ id: "main", parent: null, title: "旧任务", workspace: null }], active: ["main"] }),
  "utf8",
);
await writeFile(
  join(home, "node-chat", "history.json"),
  JSON.stringify([{ role: "user", content: "旧的", node: "main", ts: "2026-01-01 00:00:00" }]),
  "utf8",
);

const store = createStore();
const state = await store.readState();
assert.equal(state.nodes[0].title, "旧任务");
assert.equal(state.history.length, 1);
assert.equal(state.history[0].content, "旧的");

await rm(home, { recursive: true, force: true });
console.log("migration tests: all passed");
