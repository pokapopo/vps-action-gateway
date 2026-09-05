"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { CHAT_DEFAULT_WAIT_SECONDS, coreNextAction, createCapabilityRegistry, discoverCapabilities, resolveRoute, routeCoreTool } = require("../mcp-v2/router");

test("read and observe selectors route only to existing backend actions", () => {
  assert.equal(resolveRoute("read", { view: "file", arguments: { path: "/tmp/a" } }).action, "readFile");
  assert.equal(resolveRoute("read", { view: "search", query: "x" }).action, "searchFiles");
  assert.equal(resolveRoute("read", { view: "tree" }).action, "inspectWorkspace");
  assert.equal(resolveRoute("observe", { view: "system" }).action, "getSystemOverview");
  assert.equal(resolveRoute("observe", { view: "cyberboss" }).action, "getCyberbossMonitorSnapshot");
  assert.equal(resolveRoute("observe", { view: "logs" }).action, "queryLogs");
  assert.throws(() => resolveRoute("observe", { view: "network" }), (error) => error.code === "unsupported_capability");
});

test("all stable core selectors map to existing backend actions", () => {
  assert.equal(resolveRoute("edit", { action: "write" }).action, "writeFile");
  assert.equal(resolveRoute("edit", { action: "patch" }).action, "applyPatch");
  assert.equal(resolveRoute("move_out", { action: "delete" }).action, "deletePath");
  assert.equal(resolveRoute("move_out", { action: "restore" }).action, "restorePath");
  assert.equal(resolveRoute("execute", { action: "run" }).action, "runCommand");
  assert.equal(resolveRoute("execute", { action: "start" }).action, "startJob");
  assert.equal(resolveRoute("execute", { action: "status" }).action, "getJob");
  assert.equal(resolveRoute("execute", { action: "cancel" }).action, "cancelJob");
  assert.equal(resolveRoute("manage", { target: "service" }).action, "manageService");
  assert.equal(resolveRoute("manage", { target: "package" }).action, "managePackage");
  assert.equal(resolveRoute("operation", { action: "batch" }).action, "operationBatch");
  assert.equal(resolveRoute("operation", { action: "invoke" }).action, "invokeInterface");
  assert.ok(discoverCapabilities(createCapabilityRegistry()).operation.includes("approval_confirm"));
  assert.ok(discoverCapabilities(createCapabilityRegistry()).operation.includes("invoke"));
});

test("chat-facing command routes wait for short jobs by default", () => {
  assert.equal(resolveRoute("execute", { action: "run", arguments: { command: "printf ok" } }).args.wait_seconds, CHAT_DEFAULT_WAIT_SECONDS);
  assert.equal(resolveRoute("execute", { action: "start", arguments: { command: "printf ok", wait_seconds: 0 } }).args.wait_seconds, 0);
});

test("discover and a newly registered capability work without catalog changes", async () => {
  const registry = createCapabilityRegistry({ observe: { "test-capability": "healthCheck" } });
  assert.ok(discoverCapabilities(registry).observe.includes("test-capability"));
  const discovered = await routeCoreTool("discover", {}, { registry });
  assert.ok(discovered.result.data.capabilities.observe.includes("test-capability"));
  const called = await routeCoreTool("observe", { view: "test-capability" }, {
    registry,
    callBackend: async (_socket, action) => ({ ok: true, status: "succeeded", data: { action } }),
  });
  assert.equal(called.action, "healthCheck");
});

test("backend continuations are translated back to stable core tools", () => {
  assert.deepEqual(coreNextAction({ tool: "getJob", arguments: { job_id: "job_1", offset: 0 } }), {
    tool: "execute",
    arguments: { action: "status", arguments: { job_id: "job_1", offset: 0 } },
  });
  assert.deepEqual(coreNextAction({ tool: "writeFile", arguments: { path: "/tmp/a", user_approved: true } }), {
    tool: "edit",
    arguments: { action: "write", arguments: { path: "/tmp/a", user_approved: true } },
  });
});

test("file reads are kept below the text-first response page budget", () => {
  assert.equal(resolveRoute("read", { view: "file", arguments: { path: "/tmp/a", limit: 16000 } }).args.limit, 6144);
  assert.equal(resolveRoute("read", { view: "file", path: "/tmp/a" }).args.limit, 6144);
});

test("router calls the Unix-socket backend without reimplementing the action", async () => {
  let observed;
  const routed = await routeCoreTool("observe", { view: "logs", arguments: { source: "journal", unit: "x", lines: 5 } }, {
    socketPath: "/run/test.sock",
    callBackend: async (...args) => { observed = args; return { ok: true, status: "succeeded", data: { output: "ok" } }; },
  });
  assert.deepEqual(observed, ["/run/test.sock", "queryLogs", { source: "journal", unit: "x", lines: 5 }]);
  assert.equal(routed.result.data.output, "ok");
});
