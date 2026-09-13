"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MAX_STRUCTURED_BYTES, MAX_TEXT_BYTES, buildCoreResult } = require("../mcp-v2/response");

function succeeded(data, extra = {}) {
  return { ok: true, status: "succeeded", summary: "ok", data, truncated: false, warnings: [], ...extra };
}

test("model-critical health payload survives discarded structuredContent", () => {
  const result = buildCoreResult("health", undefined, succeeded({ status: "ok", tool_count: 18, tool_names: ["healthCheck", "readFile"], tool_schema_revision: "abc" }), {
    v2Data: { core_tools: ["health", "read", "observe", "edit", "move_out", "execute", "manage", "operation", "discover"], capabilities: { read: ["file", "search", "tree"] } },
  });
  const text = result.content[0].text;
  assert.match(text, /tool_count: 18/);
  assert.match(text, /healthCheck, readFile/);
  assert.match(text, /file/);
});

test("discover and mutation IDs are present in TextContent", () => {
  const discovered = buildCoreResult("discover", undefined, succeeded({ capabilities: { observe: ["system", "network"] } })).content[0].text;
  const edited = buildCoreResult("edit", "write", succeeded({ path: "/tmp/a", sha256: "new-sha" })).content[0].text;
  const deleted = buildCoreResult("move_out", "delete", succeeded({ trash_id: "trash_1", original_path: "/tmp/a" })).content[0].text;
  assert.match(discovered, /network/);
  assert.match(edited, /new-sha/);
  assert.match(deleted, /trash_1/);
});

test("file, logs, search, and process payloads survive discarded structuredContent", () => {
  const file = buildCoreResult("read", "file", succeeded({ path: "/tmp/a", sha256: "abc", size: 5, offset: 0, content: "hello" })).content[0].text;
  const logs = buildCoreResult("observe", "logs", succeeded({ source: "journal", unit: "x", output: "real log line" })).content[0].text;
  const search = buildCoreResult("read", "search", succeeded({ path: "/tmp", query: "needle", results: [{ path: "/tmp/a", match: "content" }] })).content[0].text;
  const processes = buildCoreResult("observe", "processes", succeeded({ count: 1, processes: [{ pid: 123, command: "node" }] })).content[0].text;
  assert.match(file, /hello/);
  assert.match(file, /SHA-256: abc/);
  assert.match(logs, /real log line/);
  assert.match(search, /\/tmp\/a/);
  assert.match(processes, /123/);
  assert.match(processes, /node/);
});

test("text and structured results remain independently bounded", () => {
  const result = buildCoreResult("read", "file", succeeded({ path: "/tmp/a", sha256: "abc", size: 50000, offset: 0, content: "x".repeat(50000) }));
  assert.ok(Buffer.byteLength(result.content[0].text) <= MAX_TEXT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) <= MAX_STRUCTURED_BYTES + 512);
  assert.equal(result.structuredContent.truncated, true);
  assert.match(result.content[0].text, /truncated/);
});
