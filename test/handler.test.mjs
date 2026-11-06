/**
 * Exercises the host handler without DSH: a fake ctx captures the registered
 * webserver route, then each route is invoked with a fake req/res.
 * Run: node test/handler.test.mjs
 */
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { apply } from "../index.js";

process.env.DSH_HOME = resolve("tmp-handler-test");

let routes = [];
const toolSets = [];
const ctx = {
  inject(names, callback) {
    const webCtx = {
      get(name) {
        if (name === "agentDefaultModel") {
          return { currentSelection: () => ({ provider: "fake", model: "fake-model" }) };
        }
        if (name === "llm") {
          return {
            stream(options) {
              toolSets.push((options.tools || []).map((tool) => tool.name));
              return (async function* () {
                yield { type: "text-delta", text: "账单自检" };
                yield { type: "usage", usage: { inputTokens: 1000, cacheReadTokens: 200, outputTokens: 50 } };
                yield { type: "finish", reason: { kind: "stop" } };
              })();
            },
          };
        }
        return undefined;
      },
      effect(fn) {
        return fn();
      },
      webServer: {
        register(route) {
          routes.push(route);
          return () => {};
        },
      },
    };
    callback(webCtx);
  },
};

function res() {
  return {
    status: 0,
    headers: null,
    body: "",
    headersSent: false,
    writeHead(code, headers) {
      this.status = code;
      this.headers = headers || {};
      this.headersSent = true;
    },
    end(body) {
      this.body = body || "";
    },
    on() {},
  };
}

function call(pathname, method = "GET", body) {
  const handler = routes[0].handler;
  const response = res();
  const request = { url: pathname, method, headers: {}, on() {} };
  if (body !== undefined) {
    const chunks = [Buffer.from(JSON.stringify(body), "utf8")];
    request.on = (event, listener) => {
      if (event === "data") for (const chunk of chunks) listener(chunk);
      if (event === "end") listener();
      return request;
    };
  }
  return Promise.resolve(handler(request, response)).then(() => response);
}

await rm(process.env.DSH_HOME, { recursive: true, force: true });
await mkdir(process.env.DSH_HOME, { recursive: true });
apply(ctx, {});
assert.equal(routes.length, 1);
assert.equal(routes[0].kind, "prefix");
assert.equal(routes[0].path, "/node-chat");

const panel = await call("/node-chat/");
assert.equal(panel.status, 200);
assert.ok(panel.body.includes("/node-chat/markdown.js"), "panel embeds the renderer script");

const markdown = await call("/node-chat/markdown.js");
assert.equal(markdown.status, 200);
assert.ok(String(markdown.headers["content-type"]).includes("javascript"), "js content type");
assert.ok(markdown.body.includes("renderMarkdown"), "renderer source served");

const state = await call("/node-chat/api/state");
assert.equal(state.status, 200, "api/state body: " + state.body);
const parsed = JSON.parse(state.body);
assert.equal(parsed.ok, true);
assert.ok(Array.isArray(parsed.state.nodes));

const icon = await call("/node-chat/icon.svg");
assert.equal(icon.status, 200, "icon.svg: " + icon.body);
assert.ok(String(icon.headers["content-type"]).includes("image/svg+xml"), "svg content type");
assert.ok(icon.body.includes("<svg"), "icon markup served");

const missing = await call("/node-chat/nope");
assert.equal(missing.status, 404);

const badCount = await call("/node-chat/api/turns/delete", "POST", { count: 0 });
assert.equal(badCount.status, 400, "count 0 rejected");

const emptyDelete = await call("/node-chat/api/turns/delete", "POST", { count: 1 });
assert.equal(emptyDelete.status, 200, "empty node is a no-op: " + emptyDelete.body);

const badWorkspace = await call("/node-chat/api/node/new", "POST", {
  root: true,
  title: "bad",
  workspace: "relative/path",
});
assert.equal(badWorkspace.status, 400, "relative workspace rejected");

const idleStop = await call("/node-chat/api/stop", "POST", {});
assert.equal(idleStop.status, 200, "stop without a run is a no-op");
assert.equal(JSON.parse(idleStop.body).stopping, false);

const devRoot = await call("/node-chat/api/node/new", "POST", {
  root: true,
  title: "开发者任务",
  dev: true,
});
assert.equal(devRoot.status, 200, devRoot.body);
const devNode = JSON.parse(devRoot.body).state.nodes.find((node) => node.title === "开发者任务");
assert.equal(devNode.dev, true);
assert.ok(devNode.workspace.endsWith("node-chat"), devNode.workspace);

const unknownApi = await call("/node-chat/api/nope");
assert.equal(unknownApi.status, 404);

/* Compatibility report: which seams the fake ctx provides. */
const compat = await call("/node-chat/api/compat");
assert.equal(compat.status, 200, "compat: " + compat.body);
const compatData = JSON.parse(compat.body);
assert.equal(compatData.ok, true);
assert.equal(compatData.usable, true, "webServer was injected, so the panel works");
// The fake ctx exposes llm + agentDefaultModel through ctx.get and webServer by
// injection; nothing else, so the other seven optional seams must read missing.
assert.equal(compatData.services.length, 10, "every documented seam is reported");
const present = compatData.services.filter((seam) => seam.present).map((seam) => seam.name).sort();
assert.deepEqual(present, ["agentDefaultModel", "llm", "webServer"]);
assert.equal(compatData.services.find((seam) => seam.name === "webServer").reach, "inject");
assert.equal(compatData.degraded.length, 7, "the seven optional seams are missing");
assert.ok(compatData.degraded.includes("attachments"), "missing seams are listed by name");
assert.ok(typeof compatData.summary === "string" && compatData.summary.length > 0);
assert.equal(typeof compatData.node.ok, "boolean");

const sent = await call("/node-chat/api/send", "POST", { text: "记账自检" });
assert.equal(sent.status, 200, "send: " + sent.body);
const ledger = await call("/node-chat/api/billing?days=1");
assert.equal(ledger.status, 200, "billing: " + ledger.body);
const spending = JSON.parse(ledger.body);
assert.equal(spending.ok, true);
assert.equal(spending.total.turns, 1, "the finished turn was billed");
assert.equal(spending.total.input, 1200, "input is the full prompt: 1000 uncached + 200 cached");
assert.equal(spending.total.output, 50);
const expected = (1000 * 2 + 200 * 0.2 + 50 * 3) / 1e6;
assert.ok(Math.abs(spending.total.amount - expected) < 1e-9, "amount " + spending.total.amount);
assert.ok(spending.ledger.endsWith("billing.jsonl"), spending.ledger);

const hourly = await call("/node-chat/api/billing?hours=24");
assert.equal(hourly.status, 200, "hourly billing: " + hourly.body);
const hourlyData = JSON.parse(hourly.body);
assert.equal(hourlyData.ok, true);
assert.equal(hourlyData.window, "hour");
assert.equal(hourlyData.hours.length, 24, "24 hourly buckets");

/* Lite mode: summarize first, then keep working in the same turn. */
await call("/node-chat/api/node/new", "POST", { title: "轻量节点" });
const beforePlan = JSON.parse((await call("/node-chat/api/state")).body).state;
const liteId = beforePlan.active.at(-1);
await call("/node-chat/api/node/lite", "POST", { id: liteId, lite: true });

const planSend = await call("/node-chat/api/send", "POST", { text: "给我方案" });
assert.equal(planSend.status, 200, "plan send: " + planSend.body);
const planState = JSON.parse(planSend.body).state;
const planEntry = planState.messages.filter((entry) => entry.node === liteId && entry.role === "assistant").at(-1);
assert.equal(planEntry.phase, "plan", "lite first turn is tagged as the plan phase");
const planTools = toolSets.at(-1);
assert.ok(planTools.length > 0, "lite first turn still offers the node's tools");
assert.ok(planTools.includes("fs_write"), "lite summarizes then acts in the same turn: " + planTools);

const execSend = await call("/node-chat/api/send", "POST", { text: "执行" });
assert.equal(execSend.status, 200, "exec send: " + execSend.body);
const execState = JSON.parse(execSend.body).state;
const execEntry = execState.messages.filter((entry) => entry.node === liteId && entry.role === "assistant").at(-1);
assert.equal(execEntry.phase, "exec", "typed confirmation enters the exec phase");
assert.ok(toolSets.at(-1).includes("fs_write"), "exec phase keeps the write tools");

/* Both switches on: terse shortens the wording, lite keeps working. */
await call("/node-chat/api/node/terse", "POST", { id: liteId, terse: true });
const bothSend = await call("/node-chat/api/send", "POST", { text: "继续" });
assert.equal(bothSend.status, 200, "lite+terse send: " + bothSend.body);
const bothEntry = JSON.parse(bothSend.body).state.messages
  .filter((entry) => entry.node === liteId && entry.role === "assistant").at(-1);
assert.equal(bothEntry.phase, "plan", "terse no longer voids the lite phase");
assert.ok(toolSets.at(-1).includes("fs_write"), "lite+terse still offers the write tools: " + toolSets.at(-1));

await rm(process.env.DSH_HOME, { recursive: true, force: true });
console.log("handler tests: all passed");
