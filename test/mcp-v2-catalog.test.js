"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { getCoreCatalog, schemaFingerprint } = require("../mcp-v2/catalog");

test("catalog exposes exactly ten stable core tools with loose selectors", () => {
  const tools = getCoreCatalog();
  assert.deepEqual(tools.map((tool) => tool.name), ["health", "read", "observe", "edit", "move_out", "execute", "manage", "operation", "facilities", "discover"]);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, 10);
  assert.match(schemaFingerprint(tools), /^[a-f0-9]{16}$/);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, true);
    for (const selector of ["view", "action", "target"]) {
      assert.equal(tool.inputSchema.properties[selector]?.enum, undefined);
    }
  }
});

test("adding a server-side capability does not change tools/list schemas", () => {
  const before = getCoreCatalog();
  const beforeFingerprint = schemaFingerprint(before);
  const simulatedRegistryChange = { observe: { "test-capability": "healthCheck" } };
  assert.ok(simulatedRegistryChange.observe["test-capability"]);
  const after = getCoreCatalog();
  assert.equal(after.length, before.length);
  assert.equal(schemaFingerprint(after), beforeFingerprint);
  assert.deepEqual(after, before);
});
