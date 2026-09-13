"use strict";

process.env.VPS_ACTION_IDEMPOTENCY_PATH = `/tmp/vps-action-idempotency-test-${process.pid}.json`;
process.env.VPS_ACTION_JOB_ROOT = `/tmp/vps-action-jobs-test-${process.pid}`;
process.env.VPS_ACTION_TRASH_ROOT = `/tmp/vps-action-trash-test-${process.pid}`;
process.env.VPS_ACTION_JOB_USER = process.env.USER || "root";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { commandPolicy, dispatch, executeRequest, redact } = require("../privileged-server");
const { evaluateCommand } = require("../command-policy");
const { compact } = require("../response");
const { catalogMetadata } = require("../tool-catalog");

const root = "/tmp/vps-action-feasibility";

test.before(async () => {
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(process.env.VPS_ACTION_JOB_ROOT, { recursive: true });
  await fsp.mkdir(process.env.VPS_ACTION_TRASH_ROOT, { recursive: true });
});
test.after(async () => {
  await fsp.rm(process.env.VPS_ACTION_IDEMPOTENCY_PATH, { force: true });
  await fsp.rm(process.env.VPS_ACTION_JOB_ROOT, { recursive: true, force: true });
  await fsp.rm(process.env.VPS_ACTION_TRASH_ROOT, { recursive: true, force: true });
});

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

test("identity material is readable without approval and its writes escalate to approval, not a hard deny", async () => {
  const directory = path.join(root, `identity-test-${process.pid}`);
  const target = path.join(directory, ".env.test");
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(target, "TOKEN=test-value\n");
  const read = await dispatch("readFile", { path: target });
  assert.equal(read.status, "succeeded");
  await assert.rejects(
    dispatch("writeFile", { path: target, content: "TOKEN=changed\n", expected_sha256: read.data.sha256 }),
    (error) => error.code === "approval_required" && error.status === 409 && Boolean(error.details?.approval_token),
  );
  await fsp.rm(directory, { recursive: true, force: true });
});

test("sensitive in-root writes are approvable, never refused outright", async () => {
  const target = path.join(root, `sensitive-write-${process.pid}/.env`);
  const first = await new Promise((resolve) => dispatch("writeFile", { path: target, content: "SECRET=1" }).catch(resolve));
  assert.equal(first.code, "approval_required");
  assert.equal(first.status, 409);
  const approved = await dispatch("writeFile", { path: target, content: "SECRET=1", approval_token: first.details.approval_token, user_approved: true });
  assert.equal(approved.ok, true);
  await fsp.unlink(target);
  await fsp.rmdir(path.dirname(target));
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
  await fsp.unlink(target);
});

test("out-of-root unwritable paths require approval before surfacing the real filesystem error", async () => {
  // Authorization happens before any writable probe, so the first call cannot
  // create even a temporary file outside the configured roots.
  const first = await new Promise((resolve) => dispatch("writeFile", { path: "/sys/vps-action-preflight.txt", content: "x" }).catch(resolve));
  assert.equal(first.code, "approval_required");
  assert.equal(first.status, 409);
  assert.ok(first.details.approval_token);
  const second = await new Promise((resolve) => dispatch("writeFile", {
    path: "/sys/vps-action-preflight.txt", content: "x", approval_token: first.details.approval_token, user_approved: true,
  }).catch(resolve));
  assert.ok(second instanceof Error || second.code !== "approval_required");
  // The approval consumed the challenge; the real write now hits the read-only
  // filesystem and must fail with a true fs error rather than a policy deny.
  const realError = second instanceof Error ? second.code : second.error?.details?.cause;
  assert.ok(["EACCES", "EROFS"].includes(realError));
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

test("command policy has only allow and confirm outcomes", () => {
  assert.equal(evaluateCommand("git status", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("git status && git push origin main", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("git status && reboot", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("printf hello", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("git status | cat", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("git status | systemctl is-active example-app", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("node --check /opt/vps-action-gateway/command-policy.js", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("uptime", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("grep -n approval /opt/vps-action-gateway/privileged-server.js", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sed -n 1,20p /srv/ai-workspace/README.md", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sha256sum /srv/ai-workspace/README.md", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sed -i 1d /srv/ai-workspace/README.md", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("sed -n w/tmp/copied /srv/ai-workspace/README.md", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("grep -R token /srv/ai-workspace", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sha256sum /etc/shadow", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sed -n 1,20p /etc/shadow", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sqlite3 -readonly /srv/ai-workspace/state.db 'SELECT name FROM sqlite_master LIMIT 1'", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sqlite3 -readonly /srv/ai-workspace/state.db 'PRAGMA table_info(events)'", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("sqlite3 /srv/ai-workspace/state.db 'DELETE FROM events'", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("grep -R TODO /srv/ai-workspace/src | head -n 20", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("grep -R TODO /srv/ai-workspace/src | tee /tmp/todos", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("systemctl status example-app && ss -lntp", commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("systemctl restart example-app && ss -lntp", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("git status > /tmp/status", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("git status & reboot", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("git status $(reboot)", commandPolicy).decision, "confirm");
  assert.equal(evaluateCommand("git status `reboot`", commandPolicy).decision, "confirm");
});

test("read-only inspection commands are allow-listed so they never gate", () => {
  for (const cmd of [
    "ps aux",
    "ps aux | grep chromium",
    "ps -ef | grep -i chrome",
    "pgrep -a chromium",
    "df -h",
    "lsblk",
    "systemctl status example-app",
  ]) {
    assert.equal(evaluateCommand(cmd, commandPolicy).decision, "allow", cmd);
  }
});

test("formerly blocked administrative commands use the normal confirmation flow", async () => {
  const waiting = await dispatch("startJob", { command: "reboot" });
  assert.equal(waiting.status, "waiting_confirmation");
  assert.equal(waiting.data.command_policy.decision, "confirm");
  assert.equal(waiting.error.code, "COMMAND_CONFIRMATION_REQUIRED");
});

test("getProcessList observes running processes read-only and supports a match filter", async () => {
  const all = await dispatch("getProcessList", {});
  assert.equal(all.ok, true);
  assert.equal(all.status, "succeeded");
  assert.ok(Array.isArray(all.data.processes));
  assert.ok(all.data.processes.some((row) => row.pid === 1));
  const filtered = await dispatch("getProcessList", { match: "node" });
  assert.equal(filtered.ok, true);
  assert.ok(filtered.data.matched_total > 0);
  assert.ok(filtered.data.processes.every((row) => /node/i.test(row.command)));
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
