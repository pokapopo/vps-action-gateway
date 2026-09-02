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

test("file, logs, search, and Cyberboss payloads survive discarded structuredContent", () => {
  const file = buildCoreResult("read", "file", succeeded({ path: "/tmp/a", sha256: "abc", size: 5, offset: 0, content: "hello" })).content[0].text;
  const logs = buildCoreResult("observe", "logs", succeeded({ source: "journal", unit: "x", output: "real log line" })).content[0].text;
  const search = buildCoreResult("read", "search", succeeded({ path: "/tmp", query: "needle", results: [{ path: "/tmp/a", match: "content" }] })).content[0].text;
  const cyberboss = buildCoreResult("observe", "cyberboss", succeeded({ generated_at: "now", service: { ActiveState: "active" }, model_usage: { recent_requests: [{ requestId: "request-1", cacheReadRatio: 0.75, cacheHit: true }], recent_requests_page: { limit: 20, offset: 0, has_more: false } }, delivery_outbox: { pending_deliveries: 1 } })).content[0].text;
  assert.match(file, /hello/);
  assert.match(file, /SHA-256: abc/);
  assert.match(logs, /real log line/);
  assert.match(search, /\/tmp\/a/);
  assert.match(cyberboss, /ActiveState/);
  assert.match(cyberboss, /pending_deliveries/);
  assert.match(cyberboss, /request-1/);
  assert.match(cyberboss, /cacheReadRatio/);
});

test("text and structured results remain independently bounded", () => {
  const result = buildCoreResult("read", "file", succeeded({ path: "/tmp/a", sha256: "abc", size: 50000, offset: 0, content: "x".repeat(50000) }));
  assert.ok(Buffer.byteLength(result.content[0].text) <= MAX_TEXT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) <= MAX_STRUCTURED_BYTES + 512);
  assert.equal(result.structuredContent.truncated, true);
  assert.match(result.content[0].text, /truncated/);
});

test("small Cyberboss request pages survive the MCP byte bound without losing the snapshot", () => {
  const request = {
    recordedAt: "2026-08-26T00:00:00.000Z", requestId: "request-1", taskId: "task-1", runId: "run-1",
    source: "checkin", kind: "wake_main", model: "model-1", provider: "provider-1", status: "completed",
    retryCount: 0, reason: "", inputTokens: 100, cacheReadInputTokens: 900, cacheCreationInputTokens: 0,
    outputTokens: 50, totalTokens: 1050, fixedPrefixFingerprint: "f".repeat(64), toolCatalogFingerprint: "t".repeat(64),
    cacheEligibleInputTokens: 1000, cacheReadRatio: 0.9, cacheHit: true,
  };
  const result = buildCoreResult("observe", "cyberboss", succeeded({
    generated_at: "now", window_hours: 3, service: { ActiveState: "active" }, resources: { memory: { free_bytes: 1 } },
    model_usage: { window_records: 1, totals: { totalTokens: 1050 }, by_kind: { wake_main: { requestCount: 1 } }, top_runs: [{ runId: "run-1" }], recent_requests: [request], recent_requests_page: { offset: 0, limit: 1, returned: 1, total: 1, has_more: false, next_offset: null } },
    work_runs: { window_records: 0, by_status: {}, active: [], recent_failures: [] }, delivery_outbox: {}, background_continuity: {}, journal: "ok",
  }));
  assert.equal(result.structuredContent.truncated, false);
  assert.equal(result.structuredContent.data.model_usage.recent_requests[0].requestId, "request-1");
  assert.match(result.content[0].text, /request-1/);
});
