"use strict";

const net = require("node:net");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { evaluateCommand, loadPolicy } = require("./command-policy");
const { IdempotencyStore } = require("./idempotency-store");
const { accepted, fromError, problem, succeeded } = require("./response");
const { invokeRegisteredInterface, loadInterfaceRegistry } = require("./interface-registry");

const SOCKET_PATH = process.env.VPS_ACTION_SOCKET || "/run/vps-action-gateway/backend.sock";
const ALLOWED_ROOT = path.resolve(process.env.VPS_ACTION_ALLOWED_ROOT || "/tmp/vps-action-feasibility");
const WORKSPACE_ROOTS = (process.env.VPS_ACTION_WORKSPACE_ROOTS || ALLOWED_ROOT).split(":").filter(Boolean).map((item) => path.resolve(item));
const READ_ROOTS = [...new Set([
  ...(process.env.VPS_ACTION_READ_ROOTS || WORKSPACE_ROOTS.join(":"))
    .split(":").filter(Boolean).map((item) => path.resolve(item)),
  "/",
])];
const JOB_ROOT = path.resolve(process.env.VPS_ACTION_JOB_ROOT || "/var/lib/vps-action-gateway/jobs");
const TRASH_ROOT = path.resolve(process.env.VPS_ACTION_TRASH_ROOT || "/var/lib/vps-action-gateway/trash");
const JOB_USER = process.env.VPS_ACTION_JOB_USER || "root";
const POLICY_PATH = process.env.VPS_ACTION_POLICY_PATH || "/opt/vps-action-gateway/policy.yaml";
const IDEMPOTENCY_PATH = process.env.VPS_ACTION_IDEMPOTENCY_PATH || "/var/lib/vps-action-gateway/idempotency.json";
const TOOL_CATALOG_PATH = path.resolve(process.env.VPS_MCP_TOOL_CATALOG_PATH || path.join(__dirname, "tool-catalog.js"));
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_SEARCH_CONTENT_BYTES = 64 * 1024;
const MAX_SEARCH_ENTRIES = 20_000;
const MAX_SEARCH_DURATION_MS = 15_000;
const VIRTUAL_SEARCH_ROOTS = ["/proc", "/sys", "/dev", "/run"];
// ChatGPT may disable a connector after a large successful response. Keep
// individual pages small; callers can continue with the returned offset.
const MAX_INLINE_OUTPUT_BYTES = 8 * 1024;
const MAX_CONCURRENT_JOBS = 2;
const MIN_FREE_BYTES = 1024 * 1024 * 1024;
const jobs = new Map();
const pendingApprovals = new Map();
const commandPolicy = loadPolicy(POLICY_PATH);
const idempotencyStore = new IdempotencyStore(IDEMPOTENCY_PATH);
const execFileAsync = promisify(execFile);

class ActionError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function envelope(action, data, extra = {}) {
  const status = extra.status || "succeeded";
  const options = { ...extra };
  delete options.status;
  return status === "accepted" ? accepted(action, data, options) : succeeded(action, data, options);
}

function redact(text) {
  let redactions = 0;
  let value = String(text);
  value = value.replace(/(bearer\s+)[a-z0-9._~+\/-]{12,}/gi, (_, prefix) => { redactions += 1; return `${prefix}[REDACTED]`; });
  value = value.replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s"']{6,}/gi, (_, prefix) => { redactions += 1; return `${prefix}[REDACTED]`; });
  value = value.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => { redactions += 1; return "[REDACTED PRIVATE KEY]"; });
  return { value, redactions };
}

function isWithin(candidate, roots) {
  return roots.some((root) => root === path.parse(root).root
    ? candidate.startsWith(root)
    : candidate === root || candidate.startsWith(`${root}${path.sep}`));
}

function sensitivePath(candidate) {
  const lower = candidate.toLowerCase();
  const segments = lower.split(path.sep);
  return lower === "/etc/shadow" || lower === "/etc/gshadow" || lower.startsWith("/etc/letsencrypt/")
    || lower.startsWith("/etc/ssl/private/") || lower.startsWith("/var/lib/private/")
    || segments.includes(".ssh") || segments.some((segment) => /^\.env(?:\.|$)/.test(segment))
    || segments.some((segment) => /(?:credential|cookie|token|secret|id_rsa|id_ed25519|private.*key)/.test(segment));
}

function approvalChallenge(resolved, mode, reason) {
  const token = crypto.randomUUID();
  pendingApprovals.set(token, { path: resolved, mode, expires_at: Date.now() + 5 * 60 * 1000 });
  throw new ActionError("approval_required", `${reason}; ask the user for approval and retry with user_approved=true (use approval_token when available)`, 409, {
    approval_required: true,
    approval_token: token,
    requested_path: resolved,
    access_mode: mode,
    expires_in_seconds: 300,
  });
}

function approvedPath(resolved, mode, approvalToken, userApproved) {
  if (userApproved !== true) return false;
  const now = Date.now();
  for (const [token, pending] of pendingApprovals) {
    if (pending.expires_at < now) pendingApprovals.delete(token);
  }
  if (approvalToken) {
    const pending = pendingApprovals.get(approvalToken);
    if (!pending || pending.expires_at < now || pending.path !== resolved || pending.mode !== mode) {
      throw new ActionError("approval_invalid", "approval token is invalid, expired, or bound to another path", 409);
    }
    pendingApprovals.delete(approvalToken);
    return true;
  }
  const matching = [...pendingApprovals.entries()].find(([, pending]) => pending.path === resolved && pending.mode === mode && pending.expires_at >= now);
  if (!matching) throw new ActionError("approval_invalid", "no pending approval matches this path and mode", 409);
  pendingApprovals.delete(matching[0]);
  return true;
}

function resolveAllowed(inputPath, mode = "write", approvalToken, userApproved = false) {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    throw new ActionError("invalid_path", "path is required");
  }
  const resolved = path.resolve(inputPath);
  const roots = mode === "read" ? READ_ROOTS : WORKSPACE_ROOTS;
  if (mode !== "read" && sensitivePath(resolved)) {
    if (approvedPath(resolved, mode, approvalToken, userApproved)) return resolved;
    approvalChallenge(resolved, mode, "this path may contain credentials or identity material");
  }
  if (!isWithin(resolved, roots)) {
    if (approvedPath(resolved, mode, approvalToken, userApproved)) return resolved;
    approvalChallenge(resolved, mode, `${mode} access is restricted to configured gateway roots`);
  }
  return resolved;
}

function resolvePreflightPath(inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) throw new ActionError("invalid_path", "path is required");
  // Sensitive-path and out-of-root gating happens in authorizeWriteTarget, the
  // single authorization choke point shared by write and patch, so an
  // operator-approved retry consumes exactly one approval.
  return path.resolve(inputPath);
}

async function assertNoSymlinkEscape(target, roots = [...new Set([...WORKSPACE_ROOTS, ...READ_ROOTS])]) {
  let cursor = target;
  while (isWithin(cursor, roots) && cursor !== path.dirname(cursor)) {
    try {
      const stat = await fsp.lstat(cursor);
      if (stat.isSymbolicLink()) throw new ActionError("symlink_denied", "symbolic links are not allowed", 403);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (roots.includes(cursor)) break;
    cursor = path.dirname(cursor);
  }
}

async function sha256File(filePath) {
  const content = await fsp.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function authorizeWriteTarget(resolved, mode, approvalToken, userApproved) {
  return resolveAllowed(resolved, mode, approvalToken, userApproved);
}

async function atomicWrite(filePath, content, created) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  try {
    await fsp.writeFile(tempPath, content, { mode: 0o640, flag: "wx" });
    await fsp.rename(tempPath, filePath);
  } finally {
    await fsp.unlink(tempPath).catch(() => {});
  }
  const stat = await fsp.stat(filePath);
  return envelope("writeFile", { path: filePath, sha256: await sha256File(filePath), size: stat.size, created });
}

async function freeBytes(target) {
  const stat = await fsp.statfs(target);
  return Number(stat.bavail) * Number(stat.bsize);
}

function liveToolCatalogMetadata() {
  const resolved = require.resolve(TOOL_CATALOG_PATH);
  delete require.cache[resolved];
  const provider = require(resolved);
  const tools = typeof provider === "function" ? provider()
    : typeof provider.getToolCatalog === "function" ? provider.getToolCatalog()
      : provider;
  if (!Array.isArray(tools) || !tools.length) throw new ActionError("catalog_invalid", "shared tool catalog is empty or invalid", 500);
  const revision = crypto.createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 16);
  return { tool_count: tools.length, tool_names: tools.map((tool) => tool.name), tool_schema_revision: revision };
}

async function healthCheck() {
  const diskFree = await freeBytes(ALLOWED_ROOT);
  const catalog = liveToolCatalogMetadata();
  return envelope("healthCheck", {
    status: "ok",
    ...catalog,
    workspace_roots: WORKSPACE_ROOTS,
    read_roots: READ_ROOTS,
    running_jobs: [...jobs.values()].filter((job) => job.status === "running").length,
    free_bytes: diskFree,
  });
}

async function readFileAction(args) {
  const filePath = resolveAllowed(args.path, "read", args.approval_token, args.user_approved === true);
  await assertNoSymlinkEscape(filePath);
  const offset = Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
  const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), MAX_INLINE_OUTPUT_BYTES) : MAX_INLINE_OUTPUT_BYTES;
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new ActionError("not_a_file", "path is not a regular file");
  const handle = await fsp.open(filePath, "r");
  const buffer = Buffer.alloc(Math.min(limit, Math.max(0, stat.size - offset)));
  try {
    await handle.read(buffer, 0, buffer.length, offset);
  } finally {
    await handle.close();
  }
  const redacted = redact(buffer.toString("utf8"));
  const nextOffset = offset + buffer.length;
  return envelope("readFile", {
    path: filePath,
    content: redacted.value,
    sha256: await sha256File(filePath),
    size: stat.size,
    offset,
  }, {
    truncated: nextOffset < stat.size,
    next_cursor: nextOffset < stat.size ? String(nextOffset) : null,
    next_action: nextOffset < stat.size ? { tool: "readFile", arguments: { path: filePath, offset: nextOffset, limit } } : undefined,
    redactions: redacted.redactions,
  });
}

async function writeFileAction(args) {
  if (typeof args.content !== "string") throw new ActionError("invalid_content", "content must be a string");
  if (Buffer.byteLength(args.content) > MAX_BODY_BYTES) throw new ActionError("content_too_large", "content exceeds 1 MiB", 413);
  const filePath = resolvePreflightPath(args.path, "write");
  await assertNoSymlinkEscape(filePath, [path.parse(filePath).root]);
  if (await freeBytes(ALLOWED_ROOT) < MIN_FREE_BYTES) throw new ActionError("low_disk", "less than 1 GiB free", 507);

  let exists = true;
  let currentSha = null;
  try {
    currentSha = await sha256File(filePath);
  } catch (error) {
    if (error.code === "ENOENT") exists = false;
    else throw error;
  }
  if (exists && typeof args.expected_sha256 !== "string") {
    throw new ActionError("expected_sha_required", "expected_sha256 is required when replacing a file", 409, { current_sha256: currentSha });
  }
  if (exists && args.expected_sha256 !== currentSha) {
    throw new ActionError("sha_conflict", "file changed since it was read", 409, { current_sha256: currentSha });
  }
  if (!exists && args.expected_sha256 !== null && args.expected_sha256 !== undefined) {
    throw new ActionError("new_file_conflict", "expected_sha256 must be null or omitted for a new file", 409);
  }
  await authorizeWriteTarget(filePath, "write", args.approval_token, args.user_approved === true);
  return atomicWrite(filePath, args.content, !exists);
}

function activeJobCount() {
  return [...jobs.values()].filter((job) => job.status === "running").length;
}

function commandPolicyData(analysis) {
  return {
    decision: analysis.decision,
    unsafe: analysis.unsafe,
    segments: analysis.segments,
    source: POLICY_PATH,
  };
}

async function startJob(args, action = "startJob") {
  if (typeof args.command !== "string" || !args.command.trim()) throw new ActionError("invalid_command", "command is required");
  if (Buffer.byteLength(args.command) > 16 * 1024) throw new ActionError("command_too_large", "command exceeds 16 KiB", 413);
  const policy = evaluateCommand(args.command.trim(), commandPolicy);
  if (policy.decision === "confirm" && args.user_approved !== true) {
    const retry = { command: args.command, user_approved: true };
    for (const key of ["cwd", "timeout_seconds", "wait_seconds", "approval_token"]) {
      if (args[key] !== undefined) retry[key] = args[key];
    }
    return problem(action, "waiting_confirmation", "COMMAND_CONFIRMATION_REQUIRED", "command policy requires explicit user confirmation", {
        retryable: true,
        errorStatus: 409,
        data: { command: args.command.trim(), command_policy: commandPolicyData(policy), confirmation_required: true },
        nextAction: { tool: action, arguments: retry },
    });
  }
  if (activeJobCount() >= MAX_CONCURRENT_JOBS) throw new ActionError("job_capacity", "two jobs are already running", 429);
  const cwd = resolveAllowed(args.cwd || ALLOWED_ROOT, "read", args.approval_token, args.user_approved === true);
  await assertNoSymlinkEscape(cwd);
  const stat = await fsp.stat(cwd);
  if (!stat.isDirectory()) throw new ActionError("invalid_cwd", "cwd must be a directory");
  const timeoutSeconds = Math.min(Math.max(Number(args.timeout_seconds) || 300, 1), 1800);
  const waitSeconds = args.wait_seconds === undefined ? 5 : Number(args.wait_seconds);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 30) throw new ActionError("invalid_wait_seconds", "wait_seconds must be an integer from 0 to 30");
  const jobId = crypto.randomUUID();
  const outputPath = path.join(JOB_ROOT, `${jobId}.log`);
  const output = fs.createWriteStream(outputPath, { flags: "wx", mode: 0o640 });
  const child = spawn("/usr/sbin/runuser", ["-u", JOB_USER, "--", "/bin/bash", "--noprofile", "--norc", "-c", args.command], {
    cwd,
    detached: true,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: ALLOWED_ROOT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const job = { id: jobId, status: "running", command: "[redacted after dispatch]", cwd, outputPath, outputBytes: 0, truncated: false, started_at: new Date().toISOString(), child, done };
  jobs.set(jobId, job);

  const append = (chunk, streamName) => {
    if (job.outputBytes >= MAX_OUTPUT_BYTES) { job.truncated = true; return; }
    const prefix = Buffer.from(`[${streamName}] `);
    const remaining = MAX_OUTPUT_BYTES - job.outputBytes;
    const payload = Buffer.concat([prefix, Buffer.from(chunk)]).subarray(0, remaining);
    job.outputBytes += payload.length;
    output.write(payload);
    if (payload.length < prefix.length + chunk.length) job.truncated = true;
  };
  child.stdout.on("data", (chunk) => append(chunk, "stdout"));
  child.stderr.on("data", (chunk) => append(chunk, "stderr"));
  child.on("error", (error) => { job.error = error.message; });
  child.on("close", (code, signal) => {
    clearTimeout(job.timer);
    if (job.status !== "timed_out") job.status = signal ? "cancelled" : code === 0 ? "completed" : "failed";
    job.exit_code = code;
    job.signal = signal;
    job.completed_at = new Date().toISOString();
    output.end(() => resolveDone(job));
    delete job.child;
    delete job.timer;
  });
  job.timer = setTimeout(() => {
    if (job.status !== "running") return;
    job.status = "timed_out";
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 2000).unref();
  }, timeoutSeconds * 1000);
  job.timer.unref();
  if (waitSeconds > 0) {
    let timer;
    const finished = await Promise.race([
      done.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), waitSeconds * 1000); }),
    ]);
    if (timer) clearTimeout(timer);
    if (finished) return jobResponse(job, { offset: 0, limit: MAX_INLINE_OUTPUT_BYTES }, action, { completed_in_call: true, wait_seconds: waitSeconds, command_policy: commandPolicyData(policy) });
  }
  return accepted(action, { job_id: jobId, status: job.status, cwd, timeout_seconds: timeoutSeconds, wait_seconds: waitSeconds, completed_in_call: false, command_policy: commandPolicyData(policy) }, {
    next_action: { tool: "getJob", arguments: { job_id: jobId } },
  });
}

async function jobResponse(job, args, action = "getJob", additionalData = {}) {
  const offset = Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
  const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), MAX_INLINE_OUTPUT_BYTES) : MAX_INLINE_OUTPUT_BYTES;
  let raw = Buffer.alloc(0);
  try {
    const content = await fsp.readFile(job.outputPath);
    raw = content.subarray(offset, offset + limit);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const redacted = redact(raw.toString("utf8"));
  const nextOffset = offset + raw.length;
  const data = {
    job_id: job.id,
    status: job.status,
    cwd: job.cwd,
    output: redacted.value,
    exit_code: job.exit_code ?? null,
    signal: job.signal ?? null,
    started_at: job.started_at,
    completed_at: job.completed_at ?? null,
    ...additionalData,
  };
  const extra = {
    truncated: job.truncated || nextOffset < job.outputBytes,
    next_cursor: nextOffset < job.outputBytes ? String(nextOffset) : null,
    redactions: redacted.redactions,
  };
  const nextAction = { tool: "getJob", arguments: { job_id: job.id, offset: nextOffset } };
  if (job.status === "running") return accepted(action, data, { ...extra, next_action: nextAction });
  if (job.status === "completed") return succeeded(action, data, extra);
  if (job.status === "failed") {
    return problem(action, "failed", "JOB_FAILED", `job exited with code ${job.exit_code ?? "unknown"}`, {
      retryable: false, errorStatus: 422, data, nextAction: { tool: "queryLogs", arguments: { source: "journal", unit: "vps-action-backend", lines: 100 } }, extra,
    });
  }
  return problem(action, "interrupted", job.status === "timed_out" ? "JOB_TIMED_OUT" : "JOB_INTERRUPTED", `job ${job.status}`, {
    retryable: false, errorStatus: 409, data, nextAction, extra,
  });
}

async function getJob(args) {
  if (typeof args.job_id !== "string") throw new ActionError("invalid_job_id", "job_id is required");
  const job = jobs.get(args.job_id);
  if (!job) throw new ActionError("job_not_found", "job not found", 404);
  return jobResponse(job, args);
}

function boundedText(value, limit = MAX_INLINE_OUTPUT_BYTES) {
  const raw = String(value || "");
  const clipped = raw.length > limit ? `${raw.slice(0, limit)}\n... [truncated]` : raw;
  const redacted = redact(clipped);
  return { text: redacted.value, truncated: raw.length > limit, redactions: redacted.redactions };
}

async function inspectWorkspace(args) {
  const root = resolveAllowed(args.path || WORKSPACE_ROOTS[0], "read", args.approval_token, args.user_approved === true);
  await assertNoSymlinkEscape(root);
  const maxDepth = Math.min(Math.max(Number(args.max_depth) || 2, 0), 6);
  const maxEntries = Math.min(Math.max(Number(args.max_entries) || 100, 1), 250);
  const entries = [];
  async function visit(current, depth) {
    if (entries.length >= maxEntries || depth > maxDepth) return;
    let children;
    try { children = await fsp.readdir(current, { withFileTypes: true }); } catch (error) {
      if (depth === 0) throw error;
      return;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= maxEntries) return;
      const item = path.join(current, child.name);
      if (sensitivePath(item)) continue;
      if (child.isSymbolicLink()) { entries.push({ path: item, type: "symlink" }); continue; }
      let stat;
      try { stat = await fsp.stat(item); } catch { continue; }
      entries.push({ path: item, type: child.isDirectory() ? "directory" : child.isFile() ? "file" : "other", size: stat.size, modified_at: stat.mtime.toISOString() });
      if (child.isDirectory()) await visit(item, depth + 1);
    }
  }
  await visit(root, 0);
  return envelope("inspectWorkspace", { path: root, entries, entry_count: entries.length }, { truncated: entries.length >= maxEntries });
}

async function getSystemOverview() {
  const disks = [];
  for (const root of [...new Set([...WORKSPACE_ROOTS, ...READ_ROOTS])]) {
    try { disks.push({ path: root, free_bytes: await freeBytes(root) }); } catch {}
  }
  const services = ["nginx", "cyberboss", "vps-action-backend", "vps-action-gpt", "vps-action-mcp"];
  const status = await Promise.all(services.map(async (name) => {
    try { const { stdout } = await execFileAsync("/usr/bin/systemctl", ["is-active", name], { timeout: 5000 }); return { name, state: stdout.trim() }; }
    catch (error) { return { name, state: String(error.stdout || "unknown").trim() || "unknown" }; }
  }));
  return envelope("getSystemOverview", {
    hostname: os.hostname(), platform: os.platform(), release: os.release(), uptime_seconds: Math.floor(os.uptime()),
    load_average: os.loadavg(), memory: { total_bytes: os.totalmem(), free_bytes: os.freemem() }, disks, services: status,
  });
}

// Read-only process inspection so observation never needs the gated execute
// channel. Runs a bounded `ps` and redacts anything token-like from cmdlines.
async function getProcessList(args) {
  const match = typeof args?.match === "string" ? args.match.trim().toLowerCase() : "";
  const limit = Math.min(Math.max(Number.isInteger(args?.limit) ? args.limit : 200, 1), 500);
  const { stdout } = await execFileAsync("/bin/ps", ["-eo", "pid=,ppid=,user=,stat=,pcpu=,pmem=,etime=,args="], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const rows = [];
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 7) continue;
    if (!/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1])) continue;
    const rawCommand = fields.slice(7).join(" ") || "";
    const redacted = redact(rawCommand);
    rows.push({
      pid: Number(fields[0]),
      ppid: Number(fields[1]),
      user: fields[2],
      stat: fields[3],
      cpu: Number(fields[4]),
      memory: Number(fields[5]),
      elapsed: fields[6],
      command: redacted.value,
      ...(redacted.redactions ? { redactions: redacted.redactions } : {}),
    });
  }
  const filtered = match
    ? rows.filter((row) => row.command.toLowerCase().includes(match) || row.user.toLowerCase().includes(match))
    : rows;
  const processes = filtered.slice(0, limit);
  return envelope("getProcessList", {
    match: match || null,
    matched_total: filtered.length,
    count: processes.length,
    truncated: filtered.length > processes.length,
    processes,
  });
}

const CYBERBOSS_STATE_FILES = Object.freeze({
  usage: "/root/.cyberboss/model-gateway-usage.json",
  work_log: "/root/.cyberboss/work-log.json",
  delivery_outbox: "/root/.cyberboss/weixin-delivery-outbox.json",
  background_continuity: "/root/.cyberboss/background-continuity.json",
});

async function readCyberbossState(name) {
  const filePath = CYBERBOSS_STATE_FILES[name];
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new ActionError("state_file_invalid", `${name} state is not a bounded regular file`, 422);
    return { value: JSON.parse(await fsp.readFile(filePath, "utf8")), modified_at: stat.mtime.toISOString(), size_bytes: stat.size };
  } catch (error) {
    if (error.code === "ENOENT") return { value: null, missing: true };
    if (error instanceof SyntaxError) return { value: null, invalid: true, error: "invalid JSON" };
    throw error;
  }
}

function countBy(items, field) {
  const counts = {};
  for (const item of items) {
    const key = String(item?.[field] || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function timestampOf(item, fields) {
  for (const field of fields) {
    const value = Date.parse(item?.[field] || "");
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function summarizeUsage(state, sinceMs, options = {}) {
  const all = Array.isArray(state?.records) ? state.records : [];
  const recent = all.filter((item) => timestampOf(item, ["recordedAt", "createdAt", "timestamp"]) >= sinceMs);
  const seen = new Set();
  const records = recent.filter((item, index) => {
    const key = item?.usageEventId || item?.requestId || `${item?.runId || "run"}:${item?.recordedAt || index}:${item?.kind || "unknown"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const tokenFields = ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "outputTokens", "totalTokens"];
  const totals = { requestCount: records.length };
  for (const field of tokenFields) totals[field] = records.reduce((sum, item) => sum + (Number(item?.usage?.[field]) || 0), 0);
  const byKind = {};
  for (const item of records) {
    const key = String(item.kind || item.source || "unknown");
    const bucket = byKind[key] || { requestCount: 0, totalTokens: 0 };
    bucket.requestCount += 1;
    bucket.totalTokens += Number(item?.usage?.totalTokens) || 0;
    byKind[key] = bucket;
  }
  const runs = new Map();
  for (const item of records) {
    const key = String(item.runId || item.taskId || "unbound");
    const bucket = runs.get(key) || { runId: key, requestCount: 0, totalTokens: 0 };
    bucket.requestCount += 1;
    bucket.totalTokens += Number(item?.usage?.totalTokens) || 0;
    runs.set(key, bucket);
  }
  const recentRequestsLimit = Math.min(Math.max(Math.trunc(Number(options.limit)) || 20, 1), 50);
  const recentRequestsOffset = Math.max(Math.trunc(Number(options.offset)) || 0, 0);
  const requestRecords = records
    .map((item, index) => ({ item, index, timestamp: timestampOf(item, ["recordedAt", "createdAt", "timestamp"]) }))
    .sort((a, b) => b.timestamp - a.timestamp || b.index - a.index);
  const recentRequests = requestRecords
    .slice(recentRequestsOffset, recentRequestsOffset + recentRequestsLimit)
    .map(({ item }) => {
      const inputTokens = Number(item?.usage?.inputTokens) || 0;
      const cacheReadInputTokens = Number(item?.usage?.cacheReadInputTokens) || 0;
      const cacheCreationInputTokens = Number(item?.usage?.cacheCreationInputTokens) || 0;
      const outputTokens = Number(item?.usage?.outputTokens) || 0;
      const totalTokens = Number(item?.usage?.totalTokens) || 0;
      const cacheEligibleInputTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
      return {
        recordedAt: item.recordedAt || item.createdAt || item.timestamp || null,
        requestId: item.requestId || null,
        taskId: item.taskId || null,
        runId: item.runId || null,
        source: item.source || null,
        kind: item.kind || null,
        model: item.model || null,
        provider: item.provider || null,
        status: item.status || null,
        retryCount: Number(item.retryCount) || 0,
        reason: item.reason || "",
        inputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        outputTokens,
        totalTokens,
        fixedPrefixFingerprint: item.fixedPrefixFingerprint || "",
        toolCatalogFingerprint: item.toolCatalogFingerprint || "",
        cacheEligibleInputTokens,
        cacheReadRatio: cacheEligibleInputTokens > 0 ? cacheReadInputTokens / cacheEligibleInputTokens : 0,
        cacheHit: cacheReadInputTokens > 0,
      };
    });
  return {
    ledger_records: all.length,
    window_records_before_dedupe: recent.length,
    window_records: records.length,
    deduplicated_records: recent.length - records.length,
    totals,
    by_kind: byKind,
    top_runs: [...runs.values()].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10),
    recent_requests: recentRequests,
    recent_requests_page: {
      offset: recentRequestsOffset,
      limit: recentRequestsLimit,
      returned: recentRequests.length,
      total: requestRecords.length,
      has_more: recentRequestsOffset + recentRequests.length < requestRecords.length,
      next_offset: recentRequestsOffset + recentRequests.length < requestRecords.length
        ? recentRequestsOffset + recentRequests.length
        : null,
    },
    alerts: Array.isArray(state?.alerts) ? state.alerts.slice(-10) : [],
  };
}

function summarizeWorkLog(state, sinceMs) {
  const all = Array.isArray(state?.records) ? state.records : [];
  const records = all.filter((item) => timestampOf(item, ["startedAt", "updatedAt", "finishedAt"]) >= sinceMs);
  const now = Date.now();
  const compactRecord = (item) => ({
    id: item.id || null,
    source: item.source || null,
    triggerKind: item.triggerKind || null,
    executionStatus: item.executionStatus || null,
    deliveryStatus: item.deliveryStatus || null,
    startedAt: item.startedAt || null,
    updatedAt: item.updatedAt || null,
    finishedAt: item.finishedAt || null,
    age_seconds: Math.max(0, Math.floor((now - timestampOf(item, ["startedAt", "updatedAt"])) / 1000)),
    lastError: item.lastError ? redact(String(item.lastError)).value.slice(0, 500) : null,
    usage: item.usage || null,
    tool_events: (Array.isArray(item.events) ? item.events : [])
      .filter((event) => event?.type === "tool.used" || /delivery\.|execution\.(?:failed|interrupted)/.test(event?.type || ""))
      .slice(-20),
  });
  const active = records.filter((item) => !item.finishedAt && ["running", "queued", "started"].includes(item.executionStatus));
  const failures = records.filter((item) => ["failed", "interrupted", "cancelled"].includes(item.executionStatus)).slice(-20);
  const ncp = records.filter((item) => (item.events || []).some((event) => /cyberboss_ncp_read_batch|social|garden/i.test(`${event?.type || ""} ${event?.detail || ""}`))).slice(-20);
  return {
    retained_records: all.length,
    window_records: records.length,
    by_status: countBy(records, "executionStatus"),
    by_trigger: countBy(records, "triggerKind"),
    active: active.map(compactRecord),
    recent_failures: failures.map(compactRecord),
    recent_ncp_or_social_runs: ncp.map(compactRecord),
    recent_runs: records.slice(-20).map(compactRecord),
  };
}

function summarizeOutbox(state) {
  const deliveries = Array.isArray(state?.deliveries) ? state.deliveries : [];
  const runs = Array.isArray(state?.runs) ? state.runs : [];
  return {
    pending_deliveries: deliveries.length,
    retained_runs: runs.length,
    delivery_kinds: countBy(deliveries, "kind"),
    delivery_statuses: countBy(deliveries, "status"),
    oldest_pending_at: deliveries.map((item) => item.createdAt || item.queuedAt).filter(Boolean).sort()[0] || null,
  };
}

function summarizeContinuity(state, sinceMs) {
  const all = Array.isArray(state?.items) ? state.items : [];
  const recent = all.filter((item) => !item.consumedAt || timestampOf(item, ["createdAt", "consumedAt"]) >= sinceMs);
  return {
    retained_items: all.length,
    unconsumed_items: all.filter((item) => !item.consumedAt).length,
    by_kind: countBy(recent, "kind"),
    by_trigger: countBy(recent, "triggerKind"),
    recent_items: recent.slice(-20).map((item) => ({
      id: item.id || null, kind: item.kind || null, triggerKind: item.triggerKind || null,
      threadId: item.threadId || null, createdAt: item.createdAt || null,
      consumedAt: item.consumedAt || null, expiresAt: item.expiresAt || null,
    })),
  };
}

async function getCyberbossMonitorSnapshot(args) {
  const hours = Math.min(Math.max(Number(args.hours) || 3, 1), 12);
  const journalLines = Math.min(Math.max(Number(args.journal_lines) || 200, 20), 500);
  const recentRequestsLimit = Math.min(Math.max(Math.trunc(Number(args.recent_requests_limit)) || 20, 1), 50);
  const recentRequestsOffset = Math.max(Math.trunc(Number(args.recent_requests_offset)) || 0, 0);
  const sinceMs = Date.now() - hours * 60 * 60 * 1000;
  const [serviceResult, journalResult, processResult, pressureText, disk, usage, workLog, outbox, continuity] = await Promise.all([
    execFileAsync("/usr/bin/systemctl", ["show", "cyberboss.service", "--no-pager", "--property=ActiveState,SubState,MainPID,MemoryCurrent,TasksCurrent,NRestarts,ExecMainStartTimestamp"], { timeout: 5000 }).catch((error) => ({ stdout: error.stdout || "", stderr: error.stderr || error.message })),
    execFileAsync("/usr/bin/journalctl", ["--no-pager", "-u", "cyberboss.service", "--since", `${hours} hours ago`, "-n", String(journalLines), "-o", "short-iso"], { timeout: 30000, maxBuffer: 1024 * 1024 }).catch((error) => ({ stdout: error.stdout || "", stderr: error.stderr || error.message })),
    execFileAsync("/usr/bin/ps", ["-eo", "pid=,ppid=,rss=,etimes=,comm="], { timeout: 5000, maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: "" })),
    fsp.readFile("/proc/pressure/memory", "utf8").catch(() => "unavailable"),
    fsp.statfs("/"),
    readCyberbossState("usage"), readCyberbossState("work_log"),
    readCyberbossState("delivery_outbox"), readCyberbossState("background_continuity"),
  ]);
  const service = Object.fromEntries(String(serviceResult.stdout || "").trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf("="); return index < 0 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
  }));
  const processRows = String(processResult.stdout || "").trim().split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), rss_bytes: Number(match[3]) * 1024, elapsed_seconds: Number(match[4]), command: match[5] } : null;
  }).filter(Boolean).sort((a, b) => b.rss_bytes - a.rss_bytes).slice(0, 20);
  const journal = boundedText(`${journalResult.stdout || ""}${journalResult.stderr ? `\n${journalResult.stderr}` : ""}`);
  const warnings = [];
  if (service.ActiveState !== "active") warnings.push(`cyberboss.service is ${service.ActiveState || "unknown"}/${service.SubState || "unknown"}`);
  if (os.freemem() < 512 * 1024 * 1024) warnings.push("host free memory is below 512 MiB");
  if (Number(disk.bavail) * Number(disk.bsize) < 5 * 1024 * 1024 * 1024) warnings.push("root filesystem free space is below 5 GiB");
  const data = {
    generated_at: new Date().toISOString(), window_hours: hours,
    authority: "root-backed fixed read-only Cyberboss monitor; no arbitrary root command execution",
    service,
    resources: {
      load_average: os.loadavg(), memory: { total_bytes: os.totalmem(), free_bytes: os.freemem() },
      root_disk: { free_bytes: Number(disk.bavail) * Number(disk.bsize), total_bytes: Number(disk.blocks) * Number(disk.bsize) },
      memory_pressure: pressureText.trim(), top_processes: processRows,
    },
    model_usage: summarizeUsage(usage.value, sinceMs, { limit: recentRequestsLimit, offset: recentRequestsOffset }),
    work_runs: summarizeWorkLog(workLog.value, sinceMs),
    delivery_outbox: summarizeOutbox(outbox.value),
    background_continuity: summarizeContinuity(continuity.value, sinceMs),
    state_files: Object.fromEntries(Object.entries({ usage, work_log: workLog, delivery_outbox: outbox, background_continuity: continuity }).map(([name, state]) => [name, { path: CYBERBOSS_STATE_FILES[name], modified_at: state.modified_at || null, size_bytes: state.size_bytes || 0, missing: state.missing === true, invalid: state.invalid === true }])),
    journal: journal.text,
  };
  return envelope("getCyberbossMonitorSnapshot", data, { truncated: journal.truncated, redactions: journal.redactions, warnings });
}

async function queryLogs(args) {
  const lines = Math.min(Math.max(Number(args.lines) || 200, 1), 500);
  if ((args.source || "journal") === "file") {
    const filePath = resolveAllowed(args.path, "read", args.approval_token, args.user_approved === true);
    if (!filePath.startsWith("/var/log/")) throw new ActionError("log_path_denied", "file log queries are restricted to /var/log", 403);
    await assertNoSymlinkEscape(filePath);
    const text = await fsp.readFile(filePath, "utf8");
    const result = boundedText(text.split(/\r?\n/).slice(-lines).join("\n"));
    return envelope("queryLogs", { source: "file", path: filePath, output: result.text }, { truncated: result.truncated, redactions: result.redactions });
  }
  const command = ["--no-pager", "-n", String(lines), "-o", "short-iso"];
  if (args.unit !== undefined) {
    if (typeof args.unit !== "string" || !/^[A-Za-z0-9@_.-]+(?:\.service)?$/.test(args.unit)) throw new ActionError("invalid_unit", "unit name is invalid");
    command.push("-u", args.unit);
  }
  if (typeof args.since === "string" && args.since.length <= 128) command.push("--since", args.since);
  try {
    const { stdout, stderr } = await execFileAsync("/usr/bin/journalctl", command, { timeout: 30000, maxBuffer: 1024 * 1024 });
    const result = boundedText(`${stdout}${stderr ? `\n${stderr}` : ""}`);
    return envelope("queryLogs", { source: "journal", unit: args.unit || null, output: result.text }, { truncated: result.truncated, redactions: result.redactions });
  } catch (error) {
    const result = boundedText(`${error.stdout || ""}${error.stderr || ""}`);
    throw new ActionError("log_query_failed", result.text || "journal query failed", 502);
  }
}

async function searchFiles(args) {
  const root = resolveAllowed(args.path || READ_ROOTS[0], "read", args.approval_token, args.user_approved === true);
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query || query.length > 256) throw new ActionError("invalid_query", "query is required and must be at most 256 characters");
  const maxResults = Math.min(Math.max(Number(args.max_results) || 100, 1), 200);
  const results = [];
  const deadline = Date.now() + MAX_SEARCH_DURATION_MS;
  let scannedEntries = 0;
  let truncated = false;

  function isVirtualSearchPath(candidate) {
    return VIRTUAL_SEARCH_ROOTS.some((virtualRoot) => candidate === virtualRoot || candidate.startsWith(`${virtualRoot}${path.sep}`));
  }

  function limitReached() {
    if (results.length < maxResults && scannedEntries < MAX_SEARCH_ENTRIES && Date.now() < deadline) return false;
    truncated = true;
    return true;
  }

  async function contentIncludes(item) {
    let handle;
    try {
      const stat = await fsp.lstat(item);
      if (!stat.isFile()) return false;
      handle = await fsp.open(item, "r");
      const buffer = Buffer.allocUnsafe(MAX_SEARCH_CONTENT_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8").includes(query);
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function visit(current, depth) {
    if (isVirtualSearchPath(current)) { truncated = true; return; }
    if (limitReached() || depth > 8) { truncated = true; return; }
    let children;
    try { children = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (limitReached()) return;
      const item = path.join(current, child.name);
      scannedEntries += 1;
      if (isVirtualSearchPath(item) || sensitivePath(item) || child.isSymbolicLink()) continue;
      if (child.isDirectory()) { await visit(item, depth + 1); continue; }
      if (!child.isFile()) continue;
      const nameMatch = child.name.toLowerCase().includes(query.toLowerCase());
      let contentMatch = false;
      if (args.content !== false) {
        contentMatch = await contentIncludes(item);
      }
      if (nameMatch || contentMatch) results.push({ path: item, match: nameMatch && contentMatch ? "name_and_content" : nameMatch ? "name" : "content" });
    }
  }
  await visit(root, 0);
  return envelope("searchFiles", { path: root, query, results, scanned_entries: scannedEntries }, { truncated: truncated || results.length >= maxResults });
}

function applyUnifiedPatch(original, patchText) {
  const lines = String(patchText || "").replace(/\r\n/g, "\n").split("\n");
  const source = original.replace(/\r\n/g, "\n").split("\n");
  let cursor = 0;
  const output = [];
  let sawHunk = false;
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) continue;
    sawHunk = true;
    const start = Number(header[1]) - 1;
    if (start < cursor || start > source.length) throw new ActionError("patch_invalid", "patch hunk position is invalid");
    output.push(...source.slice(cursor, start));
    cursor = start;
    index += 1;
    for (; index < lines.length && !lines[index].startsWith("@@ "); index += 1) {
      const line = lines[index];
      if (line.startsWith("\\ No newline")) continue;
      const marker = line[0];
      const value = line.slice(1);
      if (marker === " ") {
        if (source[cursor] !== value) throw new ActionError("patch_conflict", "patch context does not match current file", 409);
        output.push(value); cursor += 1;
      } else if (marker === "-") {
        if (source[cursor] !== value) throw new ActionError("patch_conflict", "patch removal does not match current file", 409);
        cursor += 1;
      } else if (marker === "+") output.push(value);
      else if (line !== "") throw new ActionError("patch_invalid", "unsupported patch line");
    }
    index -= 1;
  }
  if (!sawHunk) throw new ActionError("patch_invalid", "a unified diff hunk is required");
  output.push(...source.slice(cursor));
  return output.join("\n");
}

async function applyPatch(args) {
  if (typeof args.patch !== "string" || Buffer.byteLength(args.patch) > MAX_BODY_BYTES) throw new ActionError("invalid_patch", "patch must be a bounded string");
  const filePath = resolvePreflightPath(args.path, "write");
  await assertNoSymlinkEscape(filePath, [path.parse(filePath).root]);
  const current = await fsp.readFile(filePath, "utf8");
  const currentSha = crypto.createHash("sha256").update(current).digest("hex");
  if (typeof args.expected_sha256 !== "string") throw new ActionError("expected_sha_required", "expected_sha256 is required", 409, { current_sha256: currentSha });
  if (args.expected_sha256 !== currentSha) throw new ActionError("sha_conflict", "file changed since it was read", 409, { current_sha256: currentSha });
  const updated = applyUnifiedPatch(current, args.patch);
  await authorizeWriteTarget(filePath, "write", args.approval_token, args.user_approved === true);
  return atomicWrite(filePath, updated, false);
}

async function deletePath(args) {
  const target = resolveAllowed(args.path, "write", args.approval_token, args.user_approved === true);
  await assertNoSymlinkEscape(target);
  const stat = await fsp.lstat(target);
  if (stat.isFile()) {
    const currentSha = await sha256File(target);
    if (typeof args.expected_sha256 !== "string" || args.expected_sha256 !== currentSha) throw new ActionError("sha_conflict", "expected_sha256 must match the current file", 409, { current_sha256: currentSha });
  } else if (typeof args.expected_sha256 === "string") throw new ActionError("invalid_expected_sha", "directories do not have a SHA-256 guard");
  const trashId = crypto.randomUUID();
  const trashPath = path.join(TRASH_ROOT, trashId);
  await fsp.mkdir(TRASH_ROOT, { recursive: true });
  try {
    await fsp.rename(target, trashPath);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await fsp.cp(target, trashPath, { recursive: stat.isDirectory(), errorOnExist: true, force: false, dereference: false });
    await fsp.rm(target, { recursive: stat.isDirectory(), force: false });
  }
  await fsp.writeFile(`${trashPath}.json`, JSON.stringify({ id: trashId, original_path: target, deleted_at: new Date().toISOString(), type: stat.isDirectory() ? "directory" : "file" }), { mode: 0o640, flag: "wx" });
  return envelope("deletePath", { path: target, trash_id: trashId, recoverable: true });
}

async function restorePath(args) {
  if (typeof args.trash_id !== "string" || !/^[0-9a-f-]{36}$/i.test(args.trash_id)) throw new ActionError("invalid_trash_id", "trash_id is invalid");
  const metaPath = path.join(TRASH_ROOT, `${args.trash_id}.json`);
  let meta;
  try { meta = JSON.parse(await fsp.readFile(metaPath, "utf8")); } catch { throw new ActionError("trash_not_found", "trash item not found", 404); }
  const destination = resolveAllowed(args.restore_path || meta.original_path, "write", args.approval_token, args.user_approved === true);
  await assertNoSymlinkEscape(destination);
  try { await fsp.lstat(destination); throw new ActionError("restore_conflict", "restore destination already exists", 409); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const trashPath = path.join(TRASH_ROOT, args.trash_id);
  try {
    await fsp.rename(trashPath, destination);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await fsp.cp(trashPath, destination, { recursive: meta.type === "directory", errorOnExist: true, force: false, dereference: false });
    await fsp.rm(trashPath, { recursive: meta.type === "directory", force: false });
  }
  await fsp.unlink(metaPath);
  return envelope("restorePath", { trash_id: args.trash_id, path: destination });
}

async function cancelJob(args) {
  if (typeof args.job_id !== "string") throw new ActionError("invalid_job_id", "job_id is required");
  const job = jobs.get(args.job_id);
  if (!job) throw new ActionError("job_not_found", "job not found", 404);
  if (job.status !== "running") return envelope("cancelJob", { job_id: job.id, status: job.status, cancelled: false });
  job.status = "cancelled";
  clearTimeout(job.timer);
  try { process.kill(-job.child.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-job.child.pid, "SIGKILL"); } catch {} }, 2000).unref();
  return envelope("cancelJob", { job_id: job.id, status: "cancelled", cancelled: true }, { status: "accepted" });
}

async function manageService(args) {
  const name = typeof args.name === "string" ? args.name : "";
  const action = typeof args.action === "string" ? args.action : "";
  if (!/^[A-Za-z0-9@_.-]+(?:\.service)?$/.test(name)) throw new ActionError("invalid_service", "service name is invalid");
  if (!new Set(["status", "start", "stop", "restart", "reload", "enable", "disable"]).has(action)) throw new ActionError("invalid_service_action", "unsupported service action");
  if (["vps-action-backend", "vps-action-gpt", "vps-action-mcp"].includes(name.replace(/\.service$/, "")) && action !== "status") throw new ActionError("service_protected", "gateway services may only be inspected through this API", 403);
  const command = action === "status" ? ["status", name, "--no-pager"] : [action, name];
  try {
    const { stdout, stderr } = await execFileAsync("/usr/bin/systemctl", command, { timeout: 60000, maxBuffer: 1024 * 1024 });
    const result = boundedText(`${stdout}${stderr ? `\n${stderr}` : ""}`);
    return envelope("manageService", { name, action, output: result.text }, { truncated: result.truncated, redactions: result.redactions });
  } catch (error) {
    const result = boundedText(`${error.stdout || ""}${error.stderr || ""}`);
    throw new ActionError("service_action_failed", result.text || "service action failed", 502);
  }
}

async function managePackage(args) {
  const action = typeof args.action === "string" ? args.action : "";
  const packages = Array.isArray(args.packages) ? args.packages : [];
  if (!new Set(["update", "install", "remove", "purge", "status"]).has(action)) throw new ActionError("invalid_package_action", "unsupported package action");
  if (["install", "remove", "purge", "status"].includes(action) && (!packages.length || packages.length > 20 || packages.some((item) => typeof item !== "string" || !/^[a-z0-9][a-z0-9+._-]*$/i.test(item)))) throw new ActionError("invalid_packages", "packages must be 1-20 valid package names");
  let file; let command;
  if (action === "status") { file = "/usr/bin/dpkg-query"; command = ["-W", "-f=${binary:Package} ${Status}\\n", ...packages]; }
  else { file = "/usr/bin/apt-get"; command = action === "update" ? ["update"] : ["-y", action, ...packages]; }
  try {
    const { stdout, stderr } = await execFileAsync(file, command, { timeout: action === "update" ? 300000 : 600000, maxBuffer: MAX_OUTPUT_BYTES });
    const result = boundedText(`${stdout}${stderr ? `\n${stderr}` : ""}`);
    return envelope("managePackage", { action, packages, output: result.text }, { truncated: result.truncated, redactions: result.redactions });
  } catch (error) {
    const result = boundedText(`${error.stdout || ""}${error.stderr || ""}`);
    throw new ActionError("package_action_failed", result.text || "package action failed", 502);
  }
}

async function invokeInterface(args) {
  if (typeof args.interface !== "string" || !args.interface.trim()) throw new ActionError("invalid_interface", "interface is required");
  if (typeof args.method !== "string" || !args.method.trim()) throw new ActionError("invalid_interface_method", "method is required");
  const registry = await loadInterfaceRegistry();
  const result = await invokeRegisteredInterface(registry, args.interface.trim(), args.method.trim(), args.input || {});
  const bounded = boundedText(result.output);
  const data = {
    interface: args.interface.trim(),
    method: args.method.trim(),
    transport: result.transport,
    status_code: result.status_code,
    output: bounded.text,
  };
  if (result.transport === "http" && result.ok === false) {
    return problem("invokeInterface", "failed", "INTERFACE_HTTP_ERROR", `interface returned HTTP ${result.status_code}`, {
      retryable: result.status_code >= 500, errorStatus: 502, data, truncated: bounded.truncated, redactions: bounded.redactions,
    });
  }
  return succeeded("invokeInterface", data, { truncated: bounded.truncated, redactions: bounded.redactions });
}

const BATCH_ACTIONS = new Set([
  "healthCheck", "inspectWorkspace", "getSystemOverview", "getProcessList", "getCyberbossMonitorSnapshot", "queryLogs", "searchFiles", "readFile",
  "applyPatch", "writeFile", "deletePath", "restorePath", "runCommand", "startJob", "getJob", "cancelJob",
  "manageService", "managePackage", "invokeInterface",
]);

async function operationBatch(args) {
  if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 16) throw new ActionError("invalid_batch", "steps must contain 1-16 operations");
  const ids = new Set();
  for (const step of args.steps) {
    if (!step || typeof step.id !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(step.id) || ids.has(step.id)) throw new ActionError("invalid_batch_step", "step ids must be unique 1-64 character identifiers");
    ids.add(step.id);
    if (!BATCH_ACTIONS.has(step.tool)) throw new ActionError("batch_tool_denied", `batch tool ${step.tool || "<missing>"} is unknown or recursively invokes operationBatch`, 403);
    if (step.args !== undefined && (!step.args || typeof step.args !== "object" || Array.isArray(step.args))) throw new ActionError("invalid_batch_step", "step args must be an object");
  }
  const steps = await Promise.all(args.steps.map(async (step) => ({ id: step.id, result: await executeRequest(step.tool, step.args || {}) })));
  const statuses = steps.map((step) => step.result.status);
  const data = { steps };
  if (statuses.includes("waiting_confirmation")) return problem("operationBatch", "waiting_confirmation", "BATCH_CONFIRMATION_REQUIRED", "one or more batch steps require confirmation", { retryable: true, errorStatus: 409, data });
  if (statuses.includes("failed")) return problem("operationBatch", "failed", "BATCH_STEP_FAILED", "one or more batch steps failed", { retryable: steps.some((step) => step.result.error?.retryable), errorStatus: 422, data });
  if (statuses.includes("interrupted")) return problem("operationBatch", "interrupted", "BATCH_STEP_INTERRUPTED", "one or more batch steps were interrupted", { retryable: false, errorStatus: 409, data });
  if (statuses.includes("accepted")) return accepted("operationBatch", data);
  return succeeded("operationBatch", data);
}

const actions = {
  healthCheck, inspectWorkspace, getSystemOverview, getProcessList, getCyberbossMonitorSnapshot, queryLogs, searchFiles,
  readFile: readFileAction, applyPatch, writeFile: writeFileAction,
  deletePath, restorePath, runCommand: (args) => startJob(args, "runCommand"), startJob, getJob, cancelJob,
  manageService, managePackage, invokeInterface, operationBatch,
};

async function dispatch(action, args) {
  const handler = actions[action];
  if (!handler) throw new ActionError("unknown_action", `unknown action: ${action}`, 404);
  return handler(args || {});
}

function idempotencyApplies(action, args) {
  return ["applyPatch", "writeFile", "deletePath"].includes(action)
    || (action === "manageService" && args?.action === "restart");
}

function inDoubtNextAction(action, args) {
  if (action === "manageService") return { tool: "manageService", arguments: { name: args.name, action: "status" } };
  if (action === "deletePath") return { tool: "inspectWorkspace", arguments: { path: path.dirname(path.resolve(args.path || ALLOWED_ROOT)), max_depth: 1 } };
  return { tool: "readFile", arguments: { path: args.path } };
}

async function executeRequest(action, args = {}) {
  const normalizedArgs = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const key = typeof normalizedArgs.idempotency_key === "string" ? normalizedArgs.idempotency_key.trim() : "";
  if (key && (key.length > 200 || !idempotencyApplies(action, normalizedArgs))) {
    return problem(action, "failed", key.length > 200 ? "INVALID_IDEMPOTENCY_KEY" : "IDEMPOTENCY_NOT_SUPPORTED", key.length > 200 ? "idempotency_key exceeds 200 characters" : `idempotency_key is not supported for ${action}`, { retryable: false, errorStatus: 400 });
  }
  let claim;
  if (key) {
    claim = await idempotencyStore.claim(action, key, normalizedArgs);
    if (claim.kind === "conflict") return problem(action, "failed", "IDEMPOTENCY_CONFLICT", "idempotency_key is already bound to different arguments", { retryable: false, errorStatus: 409 });
    if (claim.kind === "in_doubt") return problem(action, "interrupted", "IDEMPOTENCY_IN_DOUBT", "the original operation may have taken effect; inspect current state before deciding whether to retry", { retryable: false, errorStatus: 409, nextAction: inDoubtNextAction(action, normalizedArgs) });
    if (claim.kind === "replay") return claim.result;
  }
  let result;
  try {
    result = await dispatch(action, normalizedArgs);
  } catch (error) {
    result = fromError(action, normalizedArgs, error);
  }
  if (claim?.kind === "claimed") {
    if (result.status === "waiting_confirmation") await idempotencyStore.release(claim.scope, claim.fingerprint);
    else await idempotencyStore.complete(claim.scope, claim.fingerprint, result);
  }
  return result;
}

async function prepare() {
  await fsp.mkdir(path.dirname(SOCKET_PATH), { recursive: true });
  await fsp.mkdir(ALLOWED_ROOT, { recursive: true });
  await fsp.mkdir(JOB_ROOT, { recursive: true });
  await idempotencyStore.load();
  try { await fsp.unlink(SOCKET_PATH); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function main() {
  await prepare();
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) return socket.destroy();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let request;
      try {
        request = JSON.parse(line);
        const result = await executeRequest(request.action, request.arguments);
        socket.end(`${JSON.stringify({ request_id: request.request_id, ...result })}\n`);
      } catch (error) {
        const result = fromError(request?.action || "unknown", request?.arguments || {}, error);
        socket.end(`${JSON.stringify({
          request_id: request?.request_id || null,
          ...result,
        })}\n`);
      }
    });
  });
  server.listen(SOCKET_PATH, async () => {
    await fsp.chmod(SOCKET_PATH, 0o660);
    if (process.getuid() === 0) {
      const group = require("node:child_process").execFileSync("getent", ["group", "vpsagent"], { encoding: "utf8" }).split(":")[2];
      await fsp.chown(SOCKET_PATH, 0, Number(group));
    }
    console.log(`VPS Action backend listening on ${SOCKET_PATH}`);
  });
}

if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });

module.exports = { ActionError, commandPolicy, dispatch, executeRequest, idempotencyStore, redact, resolveAllowed };
