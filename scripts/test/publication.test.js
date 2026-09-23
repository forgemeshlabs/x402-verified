"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertGeneratedPaths, initialProbeNeeded } = require("../lib/publication");
test("publication accepts only derived files", () => {
  assert.doesNotThrow(() => assertGeneratedPaths(["README.md", "dist/verified.json", "badges/new-seller.json", "state/new-seller.json"]));
  for (const file of ["sellers/new-seller.json", "scripts/build.js", ".github/workflows/build.yml", "partners/foo.json", "state/../seller.json", "dist/other.json"]) {
    assert.throws(() => assertGeneratedPaths(["README.md", file]));
  }
  assert.throws(() => assertGeneratedPaths([]));
});
test("record first probe only, not fake repeated runs every publication", () => {
  assert.equal(initialProbeNeeded({}), true);
  assert.equal(initialProbeNeeded({ probes: [] }), true);
  assert.equal(initialProbeNeeded({ probes: [{ pass: true }] }), false);
  assert.equal(initialProbeNeeded({ probes: [{ pass: false }] }), false);
});
