/**
 * P0/P1 smoke check that runs without DSH:
 *   node test/compat.test.mjs && node test/release.test.mjs
 *
 * verifies the seam inventory is internally consistent and that the package
 * metadata would survive `npm publish` + a fresh install.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNode, describeSeams, HOST_SEAMS, MIN_NODE_MAJOR, seamReport } from "../lib/compat.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/* --- Seam inventory --- */
assert.equal(new Set(HOST_SEAMS.map((seam) => seam.name)).size, HOST_SEAMS.length, "seam names are unique");
assert.equal(HOST_SEAMS.filter((seam) => seam.required).length, 1, "webServer is the only required seam");
for (const seam of HOST_SEAMS) {
  assert.ok(Boolean(seam.usedBy), seam.name + " says where it is used");
  assert.ok(seam.reach === "get" || seam.reach === "inject", seam.name + " has a known reach");
}

/* --- The declaration in package.json is derived from the same list --- */
assert.deepEqual(pkg.dsh.compat.seams, HOST_SEAMS.map((seam) => seam.name));
assert.equal(pkg.engines.node, ">=" + String(MIN_NODE_MAJOR));

/* --- Reports --- */
const present = seamReport((name) => ({ name }), ["webServer"]);
assert.equal(present.usable, true);
assert.equal(present.missingRequired.length, 0);
assert.equal(present.degraded.length, 0);
assert.match(describeSeams(present), /✓/);

const bare = seamReport(() => undefined, []);
assert.equal(bare.usable, false);
assert.deepEqual(bare.missingRequired, ["webServer"]);
assert.equal(bare.degraded.length, HOST_SEAMS.length - 1);
assert.match(describeSeams(bare), /✗/);

const node = checkNode(MIN_NODE_MAJOR + ".0.0");
assert.equal(node.ok, true);
assert.equal(checkNode(MIN_NODE_MAJOR - 1 + ".9.9").ok, false);
assert.equal(checkNode("not-a-version").ok, true, "an unknown host version must not be fatal");

console.log("compat tests: all passed");
