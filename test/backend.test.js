"use strict";

process.env.VPS_ACTION_IDEMPOTENCY_PATH = `/tmp/vps-action-idempotency-test-${process.pid}.json`;

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { commandPolicy, dispatch, executeRequest, redact } = require("../privileged-server");
const { evaluateCommand } = require("../command-policy");
const { compact } = require("../response");
const { catalogMetadata } = require("../tool-catalog");

const root = "/tmp/vps-action-feasibility";

test.before(async () => { await fsp.mkdir(root, { recursive: true }); });
test.after(async () => { await fsp.rm(process.env.VPS_ACTION_IDEMPOTENCY_PATH, { force: true }); });

test("write/read uses SHA conflict protection and redaction", async () => {
  const filePath = path.join(root, `backend-test-${process.pid}.txt`);
  const created = await dispatch("writeFile", { path: filePath, content: "hello" });
  assert.equal(created.ok, true);
  assert.equal(created.status, "succeeded");
  assert.equal(created.data.created, true);

  const read = await dispatch("readFile", { path: filePath });
  assert.equal(read.data.content, "hello");
  await assert.rejects(
    dispatch("writeFile", { path: filePath, content: "changed", expected_sha256: "bad" }),
    (error) => error.code === "sha_conflict" && error.status === 409,
  );
  const updated = await dispatch("writeFile", { path: filePath, content: "token=super-secret-value", expected_sha256: read.data.sha256 });
  const redacted = await dispatch("readFile", { path: filePath });
  assert.equal(updated.ok, true);
  assert.match(redacted.data.content, /\[REDACTED\]/);
  assert.equal(redacted.redactions, 1);
  await fsp.unlink(filePath);
});

test("large file reads are paginated at the MCP-safe inline limit", async () => {
  const filePath = path.join(root, `large-read-${process.pid}.txt`);
  await fsp.writeFile(filePath, "x".repeat(40000), "utf8");
  const first = await dispatch("readFile", { path: filePath, limit: 65536 });
  assert.equal(Buffer.byteLength(first.data.content), 8192);
  assert.equal(first.truncated, true);
  assert.equal(first.next_action.tool, "readFile");
  assert.equal(first.next_action.arguments.offset, 8192);
  await fsp.unlink(filePath);
});

test("healthCheck reports the live shared tool catalog", async () => {
  const health = await dispatch("healthCheck", {});
  const expected = catalogMetadata();
  assert.equal(health.data.phase, undefined);
  assert.equal(health.data.tool_count, expected.tool_count);
  assert.deepEqual(health.data.tool_names, expected.tool_names);
  assert.equal(health.data.tool_schema_revision, expected.tool_schema_revision);
});

test("Cyberboss monitor is root-backed, bounded, read-only, and exposes paginated request usage", async () => {
  const snapshot = await dispatch("getCyberbossMonitorSnapshot", { hours: 12, journal_lines: 20, recent_requests_limit: 2 });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.data.window_hours, 12);
  assert.match(snapshot.data.authority, /root-backed fixed read-only/);
  assert.equal(typeof snapshot.data.service, "object");
  assert.equal(typeof snapshot.data.resources.memory.total_bytes, "number");
  assert.equal(typeof snapshot.data.model_usage.totals.totalTokens, "number");
  assert.ok(snapshot.data.model_usage.recent_requests.length <= 2);
  assert.equal(snapshot.data.model_usage.recent_requests_page.limit, 2);
  assert.equal(snapshot.data.model_usage.recent_requests_page.offset, 0);
  for (const request of snapshot.data.model_usage.recent_requests) {
    assert.deepEqual(Object.keys(request), [
      "recordedAt", "requestId", "taskId", "runId", "source", "kind", "model", "provider", "status",
      "retryCount", "reason", "inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens",
      "outputTokens", "totalTokens", "fixedPrefixFingerprint", "toolCatalogFingerprint",
      "cacheEligibleInputTokens", "cacheReadRatio", "cacheHit",
    ]);
    assert.equal(request.cacheEligibleInputTokens, request.inputTokens + request.cacheReadInputTokens + request.cacheCreationInputTokens);
    assert.equal(request.cacheReadRatio, request.cacheEligibleInputTokens > 0 ? request.cacheReadInputTokens / request.cacheEligibleInputTokens : 0);
    assert.equal(request.cacheHit, request.cacheReadInputTokens > 0);
  }
  assert.equal(typeof snapshot.data.work_runs.by_status, "object");
  assert.equal(typeof snapshot.data.delivery_outbox.pending_deliveries, "number");
  assert.equal(typeof snapshot.data.background_continuity.unconsumed_items, "number");
  assert.equal(snapshot.data.command, undefined);
});

test("identity material is readable without approval but remains blocked for writes", async () => {
  const read = await dispatch("readFile", { path: "/etc/shadow" });
  assert.equal(read.status, "succeeded");
  await assert.rejects(
    dispatch("writeFile", { path: "/etc/shadow", content: "blocked", expected_sha256: read.data.sha256 }),
    (error) => error.code === "hard_blocked" && error.status === 403,
  );
});

test("out-of-root access requires and consumes explicit approval", async () => {
  const target = `/tmp/vps-action-approved-${process.pid}.txt`;
  const denied = await new Promise((resolve) => dispatch("writeFile", { path: target, content: "approved" }).catch(resolve));
  assert.equal(denied.code, "approval_required");
  const approved = await dispatch("writeFile", { path: target, content: "approved", approval_token: denied.details.approval_token, user_approved: true });
  assert.equal(approved.ok, true);
  await assert.rejects(
    dispatch("writeFile", { path: target, content: "again", expected_sha256: approved.data.sha256, approval_token: denied.details.approval_token, user_approved: true }),
    (error) => error.code === "approval_invalid",
  );
  await fsp.unlink(target);
});

test("write and patch failures are rejected before an out-of-root approval is issued", async () => {
  const target = `/tmp/vps-action-preflight-${process.pid}.txt`;
  await assert.rejects(dispatch("writeFile", { path: target, content: 42 }), (error) => error.code === "invalid_content");
  await fsp.writeFile(target, "one\ntwo\n", "utf8");
  const sha = (await dispatch("readFile", { path: target })).data.sha256;
  await assert.rejects(dispatch("applyPatch", { path: target, expected_sha256: sha, patch: "not a patch" }), (error) => error.code === "patch_invalid");
  await assert.rejects(dispatch("writeFile", { path: "/sys/vps-action-preflight.txt", content: "x" }), (error) => error.code === "write_preflight_failed" && ["EACCES", "EROFS"].includes(error.details.cause));
  await fsp.unlink(target);
});

test("out-of-root applyPatch consumes one exact-path approval and succeeds", async () => {
  const target = `/tmp/vps-action-approved-patch-${process.pid}.txt`;
  await fsp.writeFile(target, "one\ntwo\n", "utf8");
  const sha = (await dispatch("readFile", { path: target })).data.sha256;
  const args = { path: target, expected_sha256: sha, patch: "@@ -1,2 +1,2 @@\n one\n-two\n+changed\n" };
  const denied = await new Promise((resolve) => dispatch("applyPatch", args).catch(resolve));
  assert.equal(denied.code, "approval_required");
  assert.equal(denied.details.requested_path, target);
  const approved = await dispatch("applyPatch", { ...args, approval_token: denied.details.approval_token, user_approved: true });
  assert.equal(approved.ok, true);
  assert.equal(await fsp.readFile(target, "utf8"), "one\nchanged\n");
  await fsp.unlink(target);
});

test("redaction covers bearer and private keys", () => {
  const result = redact("Bearer abcdefghijklmnop\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
  assert.equal(result.redactions, 2);
  assert.doesNotMatch(result.value, /abcdefghijklmnop|BEGIN PRIVATE/);
});

test("patch, search, recoverable deletion, and restore use the same path policy", async () => {
  const filePath = path.join(root, `catalog-test-${process.pid}.txt`);
  await fsp.writeFile(filePath, "one\ntwo\n", "utf8");
  const before = await dispatch("readFile", { path: filePath });
  const patched = await dispatch("applyPatch", {
    path: filePath,
    expected_sha256: before.data.sha256,
    patch: "@@ -1,2 +1,2 @@\n one\n-two\n+changed\n",
  });
  assert.equal(patched.ok, true);
  const found = await dispatch("searchFiles", { path: root, query: "changed" });
  assert.ok(found.data.results.some((item) => item.path === filePath));
  const deleted = await dispatch("deletePath", { path: filePath, expected_sha256: patched.data.sha256 });
  assert.equal(deleted.data.recoverable, true);
  await assert.rejects(fsp.stat(filePath), { code: "ENOENT" });
  const restored = await dispatch("restorePath", { trash_id: deleted.data.trash_id });
  assert.equal(restored.data.path, filePath);
  await fsp.unlink(filePath);
});

test("search bounds file content reads and excludes virtual filesystems", async () => {
  const filePath = path.join(root, `bounded-search-${process.pid}.txt`);
  await fsp.writeFile(filePath, `${"x".repeat(64 * 1024)}needle-after-limit`, "utf8");
  const bounded = await dispatch("searchFiles", { path: root, query: "needle-after-limit" });
  assert.equal(bounded.data.results.some((item) => item.path === filePath), false);
  assert.equal(typeof bounded.data.scanned_entries, "number");
  const virtual = await dispatch("searchFiles", { path: "/proc", query: "never-read" });
  assert.equal(virtual.ok, true);
  assert.equal(virtual.data.results.length, 0);
  assert.equal(virtual.truncated, true);
  await fsp.unlink(filePath);
});

test("ordinary file and script edits are non-destructive tools", () => {
  const catalog = require("../tool-catalog").getToolCatalog();
  for (const name of ["applyPatch", "writeFile"]) {
    const tool = catalog.find((item) => item.name === name);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.match(tool.description, /without approval/);
  }
});

test("command policy orders deny, confirm, allow, and default per segment", () => {
  assert.equal(evaluateCommand("git status", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("git status && git push origin main", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("git status && reboot", commandPolicy).decision, "deny");
  assert.equal(evaluateCommand("printf hello", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("git status | cat", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("git status | systemctl is-active cyberboss", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("node --check /opt/vps-action-gateway/command-policy.js", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("uptime", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("grep -n approval /opt/vps-action-gateway/privileged-server.js", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sed -n 1,20p /root/cyberboss/AGENTS.md", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sha256sum /root/cyberboss/AGENTS.md", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sed -i 1d /root/cyberboss/AGENTS.md", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("sed -n w/tmp/copied /root/cyberboss/AGENTS.md", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("grep -R token /root/.cyberboss", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sha256sum /etc/shadow", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sed -n 1,20p /etc/shadow", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sqlite3 -readonly /root/cyberboss/state.db 'SELECT name FROM sqlite_master LIMIT 1'", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sqlite3 -readonly /root/cyberboss/state.db 'PRAGMA table_info(events)'", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sqlite3 /root/cyberboss/state.db 'DELETE FROM events'", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("grep -R TODO /root/cyberboss/src | head -n 20", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("grep -R TODO /root/cyberboss/src | tee /tmp/todos", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("systemctl status cyberboss && ss -lntp", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("systemctl restart cyberboss && ss -lntp", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("git status > /tmp/status", commandPolicy).decision, "deny");
  assert.equal(evaluateCommand("git status & reboot", commandPolicy).decision, "deny");
  assert.equal(evaluateCommand("git status $(reboot)", commandPolicy).decision, "deny");
  assert.equal(evaluateCommand("git status `reboot`", commandPolicy).decision, "deny");
});

test("startJob returns short output inline and long work with next_action", async () => {
  const waiting = await dispatch("startJob", { command: "printf waiting" });
  assert.equal(waiting.status, "waiting_confirmation");
  assert.equal(waiting.next_action.tool, "startJob");

  const inline = await dispatch("startJob", { command: "printf inline", user_approved: true, wait_seconds: 2 });
  assert.equal(inline.status, "succeeded");
  assert.equal(inline.data.completed_in_call, true);
  assert.match(inline.data.output, /inline/);

  const asynchronous = await dispatch("startJob", { command: "sleep 0.2; printf later", user_approved: true, wait_seconds: 0 });
  assert.equal(asynchronous.status, "accepted");
  assert.equal(asynchronous.next_action.tool, "getJob");
  await new Promise((resolve) => setTimeout(resolve, 350));
  const completed = await dispatch("getJob", { job_id: asynchronous.data.job_id });
  assert.equal(completed.status, "succeeded");
  assert.match(completed.data.output, /later/);
});

test("mutating idempotency replays exact result and rejects key conflicts", async () => {
  const filePath = path.join(root, `idempotency-${process.pid}.txt`);
  const key = `write-${process.pid}-${Date.now()}`;
  const args = { path: filePath, content: "once", idempotency_key: key };
  const first = await executeRequest("writeFile", args);
  const replay = await executeRequest("writeFile", args);
  assert.deepEqual(replay, first);
  const conflict = await executeRequest("writeFile", { ...args, content: "different" });
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(conflict.error.retryable, false);
  await fsp.unlink(filePath);
});

test("operationBatch exposes the complete gateway work surface except recursion", async () => {
  const filePath = path.join(root, `batch-${process.pid}.txt`);
  await fsp.writeFile(filePath, "batch", "utf8");
  const result = await dispatch("operationBatch", { steps: [
    { id: "health", tool: "healthCheck", args: {} },
    { id: "read", tool: "readFile", args: { path: filePath } },
  ] });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.data.steps.map((step) => step.id), ["health", "read"]);
  const writtenPath = path.join(root, `batch-written-${process.pid}.txt`);
  const written = await dispatch("operationBatch", { steps: [{ id: "write", tool: "writeFile", args: { path: writtenPath, content: "yes", idempotency_key: `batch-write-${process.pid}` } }] });
  assert.equal(written.status, "succeeded");
  assert.equal((await fsp.readFile(writtenPath, "utf8")), "yes");
  await assert.rejects(dispatch("operationBatch", { steps: [{ id: "nested", tool: "operationBatch", args: { steps: [] } }] }), (error) => error.code === "batch_tool_denied");
  await fsp.unlink(writtenPath);
  await fsp.unlink(filePath);
});

test("public responses hide correlation ids unless debug is true", () => {
  const full = { request_id: "request", action_id: "action", status: "succeeded", ok: true };
  assert.deepEqual(compact(full), { status: "succeeded", ok: true });
  assert.deepEqual(compact(full, true), full);
});
