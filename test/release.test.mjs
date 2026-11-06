#!/usr/bin/env node
/**
 * Release checklist that runs without DSH: `node test/release.test.mjs`.
 *
 * Everything a stranger needs before installing: publishable metadata, no dead
 * exports, engines/version agreement, and no secret-looking strings checked in.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve against the package root, not the caller's cwd: npm test and a bare
// `node test/release.test.mjs` from elsewhere must check the same files.
const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

/* --- Publishable --- */
assert.equal(pkg.private, undefined, "package.json must not set private");
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "version is a plain semver");
assert.ok(pkg.license, "license is declared");
assert.ok(pkg.author, "author is declared");
assert.ok(pkg.repository && pkg.repository.url, "repository is declared");
assert.ok(pkg.homepage, "homepage is declared");
assert.ok(pkg.bugs && pkg.bugs.url, "bugs is declared");
assert.ok(pkg.description, "description is declared");

/* --- Every export resolves to a real file --- */
for (const [key, target] of Object.entries(pkg.exports || {})) {
  assert.ok(!target.includes("*"), key + " has no wildcard export (glob targets need a real directory)");
  const path = resolve(dir, target);
  assert.ok(statSync(path).isFile(), key + " -> " + target + " exists");
}
for (const entry of pkg.files || []) {
  assert.ok(statSync(resolve(dir, entry)), "files entry " + entry + " exists");
}

/* --- engines.node agrees with the runtime gate --- */
const compat = readFileSync(join(dir, "lib", "compat.js"), "utf8");
const min = /MIN_NODE_MAJOR\s*=\s*(\d+)/.exec(compat);
assert.ok(min, "lib/compat.js declares MIN_NODE_MAJOR");
assert.equal(min[1], "20", "the runtime gate is Node 20");
assert.equal(pkg.engines.node, ">=" + min[1], "engines.node agrees with MIN_NODE_MAJOR");
assert.ok(pkg.scripts && pkg.scripts.test, "npm test exists");
for (const script of String(pkg.scripts.test).split("&&").map((part) => part.trim())) {
  const file = /^node (test\/\S+\.mjs)$/.exec(script);
  assert.ok(file, "npm test runs a node file: " + script);
  assert.ok(statSync(join(dir, file[1])).isFile(), "npm test target exists: " + file[1]);
}

/* --- The plugin still does not import a host package --- */
const hostImports = [];
function walk(path) {
  for (const name of readdirSync(path)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(path, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(js|mjs)$/.test(name)) continue;
    if (resolve(full).startsWith(resolve(dir, "test"))) continue;
    const text = readFileSync(full, "utf8");
    for (const match of text.matchAll(/(?:import|require)\s*\(?\s*["']([^"']+)["']/g)) {
      if (match[1].startsWith("@deepseek-ai/") && name !== "client.js") hostImports.push(full + " -> " + match[1]);
    }
  }
}
walk(dir);
assert.deepEqual(hostImports, [], "host packages are only referenced from client.js");

/* --- No secret-looking literals --- */
const offenders = [];
const secret = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/;
function scan(path) {
  for (const name of readdirSync(path)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(path, name);
    if (statSync(full).isDirectory()) {
      scan(full);
      continue;
    }
    if (!/\.(js|mjs|json|md|html|ps1|sh|yml)$/.test(name)) continue;
    if (secret.test(readFileSync(full, "utf8"))) offenders.push(full);
  }
}
scan(dir);
assert.deepEqual(offenders, [], "no API keys or tokens committed");

console.log("release tests: all passed (deepseekbaby " + pkg.version + ")");
