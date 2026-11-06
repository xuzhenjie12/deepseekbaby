/**
 * Version and seam compatibility for a deployment that was not developed here.
 *
 * Two separate questions, deliberately kept apart:
 *
 *  - `checkNode` — is the *host* Node new enough? `engines.node` (>=20) is only
 *    enforced by npm, so a hand-copied directory or a bundled runtime can still
 *    run this code on an older Node. What the source relies on today (ESM,
 *    global `fetch`, `fs/promises`) also exists in 18, so the floor is a support
 *    promise rather than a hard syntax requirement: below it we warn, never throw.
 *
 *  - `seamReport` — which DSH services exist. The plugin reaches into DSH
 *    internals through `ctx.get(<name>)` and two client injects; none of those
 *    names is a public promise. This report is what a user can paste into an
 *    issue when the panel does not show up or a feature silently disappears.
 *
 * `services[].reach` says how the plugin gets hold of the seam, because the two
 * routes fail differently: an `inject` seam disappears silently (the callback
 * never runs, yet `ctx.get` may still answer), while a `get` seam is probed at
 * use time.
 *
 * Nothing here imports `@deepseek-ai/*`: it must resolve from any directory.
 */

/** Host Node floor. Keep in sync with `engines.node` in package.json. */
export const MIN_NODE_MAJOR = 20;

/** DSH releases known to expose the seams below. Advisory, not enforced. */
export const TESTED_DSH = ">=1.2 <2";

/**
 * Every host seam the plugin touches, what breaks without it, whether the
 * plugin still starts, and how the plugin reaches it (`inject` | `get`).
 * `required: true` means the panel is unusable.
 */
export const HOST_SEAMS = [
  { name: "webServer", required: true, reach: "inject", usedBy: "index.js / 面板与全部 API" },
  { name: "llm", required: false, reach: "get", usedBy: "lib/agent.js 对话（也可配 baseURL 直连）" },
  { name: "agentDefaultModel", required: false, reach: "get", usedBy: "lib/agent.js 默认模型与供应商" },
  { name: "workspaceRegistry", required: false, reach: "get", usedBy: "lib/workspace.js 默认工作区" },
  { name: "workingDirectory", required: false, reach: "get", usedBy: "lib/workspace.js 默认工作区兜底" },
  { name: "sessionQuery", required: false, reach: "get", usedBy: "lib/sessions.js、lib/workspace.js 导入 DSH 会话" },
  { name: "attachments", required: false, reach: "get", usedBy: "index.js 图片给模型看" },
  { name: "web", required: false, reach: "get", usedBy: "lib/web.js 联网搜索首选通路" },
  { name: "deepseekAccount", required: false, reach: "get", usedBy: "lib/web.js 联网直连的账号令牌" },
  { name: "pluginManager", required: false, reach: "get", usedBy: "index.js 面板里的 ⟳ 重启" },
];

/** Client-side injects declared in package.json `dsh.client.inject`. */
export const CLIENT_INJECTS = [
  { name: "@deepseek-ai/dsh-client-locale", usedBy: "client.js 中英文字典" },
  { name: "@deepseek-ai/dsh-client-ui-layout", usedBy: "client.js shell.overlay 插槽" },
];

function majorOf(version) {
  const match = /^v?(\d+)/.exec(String(version || "").trim());
  return match ? Number(match[1]) : null;
}

/** Node version gate, reported rather than thrown so the panel can say why. */
export function checkNode(version = process.versions.node) {
  const major = majorOf(version);
  if (major === null) return { ok: true, version: String(version || ""), message: "无法解析 Node 版本，跳过检查" };
  if (major >= MIN_NODE_MAJOR) return { ok: true, version: String(version), message: "Node " + version };
  return {
    ok: false,
    version: String(version),
    message: "Node " + version + " 太旧：本插件需要 Node " + String(MIN_NODE_MAJOR) + " 或更新",
  };
}

/**
 * Which seams this runtime actually provides. Injected seams are answered from
 * `injected` (the names whose callback ran); everything else is probed with
 * `get(name)`, the same way the plugin reads it at use time.
 */
export function seamReport(get, injected) {
  const injectedNames = Array.isArray(injected) ? injected : [];
  const services = HOST_SEAMS.map((seam) => {
    // An injected seam is present when the plugin's own inject callback ran:
    // ctx.get may answer for a service nobody was allowed to inject.
    const viaInject = seam.reach === "inject";
    let present = viaInject ? injectedNames.includes(seam.name) : false;
    if (!viaInject && typeof get === "function") {
      try {
        present = Boolean(get(seam.name));
      } catch {
        present = false;
      }
    }
    return { ...seam, present };
  });
  const missingRequired = services.filter((seam) => seam.required && !seam.present).map((seam) => seam.name);
  const degraded = services.filter((seam) => !seam.required && !seam.present).map((seam) => seam.name);
  return {
    usable: missingRequired.length === 0,
    node: checkNode(),
    testedDsh: TESTED_DSH,
    services,
    missingRequired,
    degraded,
  };
}

/** One-paragraph summary for the panel's compatibility card. */
export function describeSeams(report, labels) {
  const label = (name) => (labels && labels[name]) || name;
  const lines = [];
  if (!report.node.ok) lines.push("✗ " + report.node.message);
  if (report.missingRequired.length) {
    lines.push("✗ 缺少必需服务：" + report.missingRequired.map(label).join("、") + "（面板无法工作）");
  }
  if (report.degraded.length) {
    lines.push("△ 以下服务缺失，对应功能会降级：" + report.degraded.map(label).join("、"));
  }
  if (!lines.length) lines.push("✓ 必需服务齐全，Node " + report.node.version);
  return lines.join("\n");
}
