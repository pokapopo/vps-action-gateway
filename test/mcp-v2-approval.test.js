"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const test = require("node:test");
const { ApprovalStore, fingerprint } = require("../mcp-v2/approval-store");
const { handleRpc } = require("../mcp-v2/server");
const { dispatch } = require("../privileged-server");
const { getCoreCatalog } = require("../mcp-v2/catalog");

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-v2-approval-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return new ApprovalStore(path.join(root, "approvals.json"), options);
}

test("v2 edits are advertised as host-approved mutations", () => {
  const edit = getCoreCatalog().find((tool) => tool.name === "edit");
  assert.equal(edit.annotations.readOnlyHint, false);
  assert.equal(edit.annotations.destructiveHint, true);
  assert.match(edit.description, /host's native tool approval/);
});

test("approval store persists five-state, fingerprint-bound records without public request data", async (t) => {
  const store = await fixture(t);
  const request = { tool: "move_out", arguments: { action: "delete", arguments: { path: "/tmp/a" } } };
  const prepared = await store.prepare({ request, operation: "move_out:delete", target: "/tmp/a" });
  assert.equal(prepared.state, "pending");
  assert.equal(prepared.fingerprint, fingerprint(request));
  assert.equal(prepared.request, undefined);
  const consumed = await store.approveAndConsume(prepared.approval_id);
  assert.equal(consumed.kind, "execute");
  assert.equal((await store.status(prepared.approval_id)).state, "consumed");
  await store.complete(prepared.approval_id, { ok: true, status: "succeeded", data: { trash_id: "trash_1" } });
  const replay = await store.approveAndConsume(prepared.approval_id);
  assert.equal(replay.kind, "replay");
  assert.equal(replay.record.result.data.trash_id, "trash_1");
  assert.equal((await fsp.stat(store.filePath)).mode & 0o777, 0o600);
});

test("pending approvals expire and can be cancelled", async (t) => {
  const expiringStore = await fixture(t, { ttlMs: 5 });
  const one = await expiringStore.prepare({ request: { tool: "edit", arguments: { action: "write" } }, operation: "edit:write", target: "/tmp/a" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await expiringStore.status(one.approval_id)).state, "expired");
  const cancellableStore = await fixture(t, { ttlMs: 60_000 });
  const two = await cancellableStore.prepare({ request: { tool: "edit", arguments: { action: "write" } }, operation: "edit:write", target: "/tmp/b" });
  assert.equal((await cancellableStore.cancel(two.approval_id)).state, "cancelled");
});

test("backend challenge is consumed inside the host-approved tool call", async (t) => {
  const store = await fixture(t);
  const calls = [];
  const backend = async (_socket, action, args) => {
    calls.push({ action, args });
    if (!args.user_approved) return { ok: false, status: "waiting_confirmation", summary: "confirm", data: { approval_token: "backend-secret", requested_path: args.path }, warnings: [] };
    return { ok: true, status: "succeeded", summary: "done", data: { path: args.path, sha256: "new-sha" }, warnings: [] };
  };
  const first = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edit", arguments: { action: "write", arguments: { path: "/tmp/a", content: "hello" } } } }, { approvalStore: store, callBackend: backend, log: false });
  assert.equal(first.result.structuredContent.status, "succeeded");
  assert.doesNotMatch(JSON.stringify(first), /backend-secret/);
  assert.doesNotMatch(JSON.stringify(first), /approval_token/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.user_approved, true);
  assert.equal(calls[1].args.approval_token, "backend-secret");
  assert.equal(calls[1].args.content, "hello");
});

test("real out-of-root patch completes in one host-approved tool call", async (t) => {
  const store = await fixture(t);
  const target = path.join(os.tmpdir(), `mcp-v2-approved-patch-${process.pid}-${Date.now()}.txt`);
  await fsp.writeFile(target, "one\ntwo\n", "utf8");
  t.after(() => fsp.rm(target, { force: true }));
  const expectedSha = crypto.createHash("sha256").update("one\ntwo\n").digest("hex");
  const callBackend = async (_socket, action, args) => {
    try { return await dispatch(action, args); }
    catch (error) {
      return {
        ok: false,
        status: error.code === "approval_required" ? "waiting_confirmation" : "failed",
        summary: error.message,
        data: error.details || {},
        warnings: [],
        error: { code: String(error.code).toUpperCase(), message: error.message, retryable: error.code === "approval_required" },
      };
    }
  };
  const first = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edit", arguments: { action: "patch", arguments: { path: target, expected_sha256: expectedSha, patch: "@@ -1,2 +1,2 @@\n one\n-two\n+changed\n" } } } }, { approvalStore: store, callBackend, log: false });
  assert.equal(first.result.structuredContent.status, "succeeded");
  assert.equal(await fsp.readFile(target, "utf8"), "one\nchanged\n");
});

test("explicit prepare never dispatches before semantic confirmation", async (t) => {
  const store = await fixture(t);
  let calls = 0;
  const backend = async () => { calls += 1; return { ok: true, status: "succeeded", data: {} }; };
  const prepared = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "operation", arguments: { action: "approval_prepare", arguments: { request: { tool: "move_out", arguments: { action: "delete", arguments: { path: "/tmp/a", expected_sha256: crypto.randomBytes(32).toString("hex") } } } } } } }, { approvalStore: store, callBackend: backend, log: false });
  assert.equal(prepared.result.structuredContent.status, "waiting_confirmation");
  assert.equal(calls, 0);
});

function confirmingBackend() {
  const calls = [];
  const backend = async (_socket, action, args) => {
    calls.push({ action, args });
    if (!args.user_approved) {
      return { ok: false, status: "waiting_confirmation", summary: "confirm", data: { approval_token: "t-" + calls.length, requested_path: args.path || "/tmp/a" }, warnings: [] };
    }
    return { ok: true, status: "succeeded", summary: "done", data: { path: args.path || "/tmp/a", sha256: `sha-${calls.length}` }, warnings: [] };
  };
  return { backend, calls };
}

function prepareCall(id, tool = "edit") {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "operation", arguments: { action: "approval_prepare", arguments: { request: { tool, arguments: { action: "write", arguments: { path: "/tmp/a", content: "x" } } } } } } };
}

function confirmCall(id, arguments_) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "operation", arguments: { action: "approval_confirm", arguments: arguments_ } } };
}

test("approval_confirm accepts allow/confirm/deny decisions and records the decision", async (t) => {
  const store = await fixture(t);
  const { backend, calls } = confirmingBackend();
  const prep = async (id) => (await handleRpc(prepareCall(id), { approvalStore: store, callBackend: backend, log: false })).result.structuredContent.data.approval_id;
  const first = await prep(1);
  const second = await prep(2);
  const third = await prep(3);
  assert.equal(calls.length, 0);

  const allowed = await handleRpc(confirmCall(11, { approval_id: first, decision: "allow" }), { approvalStore: store, callBackend: backend, log: false });
  assert.equal(allowed.result.structuredContent.status, "succeeded");
  assert.equal((await store.status(first)).decision, "allow");

  const confirmed = await handleRpc(confirmCall(12, { approval_id: second, decision: "confirm" }), { approvalStore: store, callBackend: backend, log: false });
  assert.equal(confirmed.result.structuredContent.status, "succeeded");
  assert.equal((await store.status(second)).decision, "confirm");

  const denied = await handleRpc(confirmCall(13, { approval_id: third, decision: "deny" }), { approvalStore: store, callBackend: backend, log: false });
  assert.equal(denied.result.structuredContent.status, "interrupted");
  assert.equal((await store.status(third)).state, "cancelled");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.user_approved, true);
  assert.equal(calls[1].args.user_approved, true);
  assert.equal(calls[0].args.content, "x");
  assert.equal(calls[1].args.content, "x");
});

test("approval_confirm supports batch approval_ids with allow and partial deny", async (t) => {
  const store = await fixture(t);
  const { backend, calls } = confirmingBackend();
  const prep = async (id) => (await handleRpc(prepareCall(id), { approvalStore: store, callBackend: backend, log: false })).result.structuredContent.data.approval_id;
  const first = await prep(1);
  const second = await prep(2);
  const third = await prep(3);

  const batched = await handleRpc(confirmCall(21, { approval_ids: [first, second, "ap_missing"], decision: "allow" }), { approvalStore: store, callBackend: backend, log: false });
  const data = batched.result.structuredContent.data;
  assert.equal(batched.result.structuredContent.status, "succeeded");
  assert.equal(data.confirmed, 2);
  assert.equal(data.missing, 1);
  assert.equal(calls.length, 2);

  const replayBatch = await handleRpc(confirmCall(22, { approval_ids: [first, second], decision: "allow" }), { approvalStore: store, callBackend: backend, log: false });
  assert.equal(replayBatch.result.structuredContent.status, "succeeded");
  assert.equal(replayBatch.result.structuredContent.data.confirmed, 2);
  assert.equal(calls.length, 2);

  const deniedBatch = await handleRpc(confirmCall(23, { approval_ids: [third, "ap_missing"], decision: "deny" }), { approvalStore: store, callBackend: backend, log: false });
  assert.equal(deniedBatch.result.structuredContent.status, "interrupted");
  assert.equal(deniedBatch.result.structuredContent.data.denied, 1);
  assert.equal(deniedBatch.result.structuredContent.data.missing, 1);
});

test("mutating tools use native host approval and return no materialized HTML attachment", async (t) => {
  const store = await fixture(t);
  const backend = async (_socket, action, args) => {
    if (!args.user_approved) return { ok: false, status: "waiting_confirmation", summary: "confirm", data: { approval_token: "backend-secret", requested_path: args.path }, warnings: [] };
    return { ok: true, status: "succeeded", summary: "done", data: { path: args.path }, warnings: [] };
  };
  const result = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edit", arguments: { action: "write", arguments: { path: "/tmp/a", content: "hello" } } } }, { approvalStore: store, callBackend: backend, log: false });
  assert.equal(result.result.structuredContent.status, "succeeded");
  assert.equal((result.result.content || []).some((item) => item.type === "resource"), false);
  const tools = (await handleRpc({ jsonrpc: "2.0", id: 10, method: "tools/list" }, { log: false })).result.tools;
  for (const name of ["edit", "move_out", "execute", "manage", "operation"]) {
    const tool = tools.find((item) => item.name === name);
    assert.equal(tool.annotations.destructiveHint, true);
    assert.equal(tool._meta, undefined);
  }
  const listed = await handleRpc({ jsonrpc: "2.0", id: 11, method: "resources/list" }, { log: false });
  assert.equal(listed.error.code, -32601);
});

test("approval_confirm rejects missing and unknown decisions", async (t) => {
  const store = await fixture(t);
  const { backend } = confirmingBackend();
  const approvalId = (await handleRpc(prepareCall(1), { approvalStore: store, callBackend: backend, log: false })).result.structuredContent.data.approval_id;
  for (const decision of [undefined, "typo"]) {
    const response = await handleRpc(confirmCall(2, { approval_id: approvalId, ...(decision === undefined ? {} : { decision }) }), { approvalStore: store, callBackend: backend, log: false });
    assert.equal(response.result.structuredContent.error.code, "APPROVAL_DECISION_REQUIRED");
    assert.equal((await store.status(approvalId)).state, "pending");
  }
});
