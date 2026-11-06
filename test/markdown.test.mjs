/** Checks for the panel Markdown renderer. Run: node test/markdown.test.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../panel-markdown.js", import.meta.url)), "utf8");
const scope = {};
const load = new Function("window", source + "\nreturn window.__nodeChatMarkdown;");
const md = load(scope);

assert.equal(md.renderMarkdown("**粗体**"), "<p><strong>粗体</strong></p>");
assert.equal(md.renderMarkdown("`a < b`"), "<p><code>a &lt; b</code></p>");
assert.equal(md.renderMarkdown("# 标题"), '<div class="md-h" style="font-size:18px">标题</div>');
assert.equal(md.renderMarkdown("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
assert.equal(md.renderMarkdown("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
assert.equal(md.renderMarkdown("> 引用"), "<blockquote>引用</blockquote>");

const fence = md.renderMarkdown("```js\nconst a = 1 < 2;\n```");
assert.ok(fence.startsWith("<pre>"), fence);
assert.ok(fence.includes("const a = 1 &lt; 2;"), fence);
assert.ok(fence.includes('class="md-copy"'), fence);

const evil = md.renderMarkdown('<img src=x onerror="alert(1)">');
assert.ok(!evil.includes("<img"), evil);
assert.ok(evil.includes("&lt;img"), evil);

const link = md.renderMarkdown("[站点](https://example.com)");
assert.ok(link.includes('href="https://example.com"'), link);
assert.ok(link.includes('rel="noreferrer noopener"'), link);

const bad = md.renderMarkdown("[x](javascript:alert(1))");
assert.ok(!bad.includes("<a"), bad);

assert.equal(md.escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
console.log("markdown tests: all passed");
