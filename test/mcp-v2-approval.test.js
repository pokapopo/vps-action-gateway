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

test("ordinary v2 edits are advertised as non-destructive", () => {
  const edit = getCoreCatalog().find((tool) => tool.name === "edit");
  assert.equal(edit.annotations.readOnlyHint, false);
  assert.equal(edit.annotations.destructiveHint, false);
  assert.match(edit.description, /without approval/);
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

test("backend challenge becomes an approval_id and confirm injects gateway fields server-side", async (t) => {
  const store = await fixture(t);
  const calls = [];
  const backend = async (_socket, action, args) => {
    calls.push({ action, args });
    if (!args.user_approved) return { ok: false, status: "waiting_confirmation", summary: "confirm", data: { approval_token: "backend-secret", requested_path: args.path }, warnings: [] };
    return { ok: true, status: "succeeded", summary: "done", data: { path: args.path, sha256: "new-sha" }, warnings: [] };
  };
  const first = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edit", arguments: { action: "write", arguments: { path: "/tmp/a", content: "hello" } } } }, { approvalStore: store, callBackend: backend, log: false });
  const approvalId = first.result.structuredContent.data.approval_id;
  assert.match(approvalId, /^ap_/);
  assert.doesNotMatch(JSON.stringify(first), /backend-secret/);
  assert.doesNotMatch(JSON.stringify(first), /approval_token/);
  const confirmed = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "operation", arguments: { action: "approval_confirm", arguments: { approval_id: approvalId, decision: "approve" } } } }, { approvalStore: store, callBackend: backend, log: false });
  assert.equal(confirmed.result.structuredContent.status, "succeeded");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.user_approved, true);
  assert.equal(calls[1].args.approval_token, "backend-secret");
  assert.equal(calls[1].args.content, "hello");
  const replay = await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "operation", arguments: { action: "approval_confirm", arguments: { approval_id: approvalId } } } }, { approvalStore: store, callBackend: backend, log: false });
  assert.equal(replay.result.structuredContent.data.sha256, "new-sha");
  assert.equal(calls.length, 2);
});

test("real out-of-root patch approval_id confirms against the same normalized path", async (t) => {
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
  assert.equal(first.result.structuredContent.status, "waiting_confirmation");
  assert.equal(first.result.structuredContent.data.target, target);
  const approvalId = first.result.structuredContent.data.approval_id;
  const confirmed = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "operation", arguments: { action: "approval_confirm", arguments: { approval_id: approvalId, decision: "approve" } } } }, { approvalStore: store, callBackend, log: false });
  assert.equal(confirmed.result.structuredContent.status, "succeeded");
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
