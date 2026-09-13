"use strict";

const crypto = require("node:crypto");

const PUBLIC_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    status: { type: "string", enum: ["succeeded", "accepted", "waiting_confirmation", "interrupted", "failed"] },
    summary: { type: "string" },
    data: { type: "object" },
    error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, retryable: { type: "boolean" } }, required: ["code", "message", "retryable"] },
    next_action: { type: "object", properties: { tool: { type: "string" }, arguments: { type: "object" } }, required: ["tool", "arguments"] },
    truncated: { type: "boolean" },
    redactions: { type: "integer" },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["ok", "status"],
};

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
const OPEN_DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });

function tool(name, description, properties = {}, required = [], annotations = READ_ONLY) {
  const inputSchema = { type: "object", properties: { ...properties, debug: { type: "boolean", description: "Include internal request_id and action_id for diagnostics." } }, additionalProperties: false };
  if (required.length) inputSchema.required = required;
  return { name, description, inputSchema, outputSchema: PUBLIC_OUTPUT_SCHEMA, annotations };
}

function getToolCatalog() {
  const approval = { approval_token: { type: "string" }, user_approved: { type: "boolean" } };
  const idempotency = { idempotency_key: { type: "string", maxLength: 200 } };
  const tools = [
    tool("healthCheck", "Check gateway health, the live tool catalog, allowed roots, disk capacity, and running jobs."),
    tool("inspectWorkspace", "Inspect a bounded directory tree anywhere on the VPS without approval.", { path: { type: "string" }, max_depth: { type: "integer", minimum: 0, maximum: 6 }, max_entries: { type: "integer", minimum: 1, maximum: 250 }, ...approval }),
    tool("getSystemOverview", "Get hostname, OS, uptime, memory, disks, and selected service states."),
    tool("queryLogs", "Read bounded systemd journal or log output anywhere on the VPS without approval.", { source: { type: "string", enum: ["journal", "file"] }, unit: { type: "string" }, path: { type: "string" }, since: { type: "string" }, lines: { type: "integer", minimum: 1, maximum: 500 }, ...approval }),
    tool("searchFiles", "Search filenames and bounded text anywhere on the VPS without approval.", { query: { type: "string" }, path: { type: "string" }, content: { type: "boolean" }, max_results: { type: "integer", minimum: 1, maximum: 200 }, ...approval }, ["query"]),
    tool("readFile", "Read a bounded file slice anywhere on the VPS without approval.", { path: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 16384 }, ...approval }, ["path"]),
    tool("applyPatch", "Apply an ordinary low-risk, SHA-guarded file or script edit without approval. Reuse idempotency_key only when retrying the exact same logical patch.", { path: { type: "string" }, patch: { type: "string" }, expected_sha256: { type: "string" }, ...idempotency, ...approval }, ["path", "patch", "expected_sha256"], WRITE),
    tool("writeFile", "Atomically create an ordinary file or script, or SHA-guard replace one, without approval. Reuse idempotency_key only when retrying the exact same logical write.", { path: { type: "string" }, content: { type: "string" }, expected_sha256: { type: ["string", "null"] }, ...idempotency, ...approval }, ["path", "content"], WRITE),
    tool("deletePath", "Move a file or directory to recoverable trash. Reuse idempotency_key only when retrying the exact same logical deletion.", { path: { type: "string" }, expected_sha256: { type: "string" }, ...idempotency, ...approval }, ["path"], DESTRUCTIVE),
    tool("restorePath", "Restore a previously trashed item. If the destination is denied, ask the user and retry with approval_token and user_approved=true.", { trash_id: { type: "string" }, restore_path: { type: "string" }, ...approval }, ["trash_id"], WRITE),
    tool("runCommand", "Run as root. Wait up to wait_seconds (default 5); completed commands return inline, otherwise follow next_action.", { command: { type: "string" }, cwd: { type: "string" }, timeout_seconds: { type: "integer", minimum: 1, maximum: 1800 }, wait_seconds: { type: "integer", minimum: 0, maximum: 30, default: 5 }, ...approval }, ["command"], OPEN_DESTRUCTIVE),
    tool("startJob", "Run as root. Wait up to wait_seconds (default 5); completed commands return inline, otherwise follow next_action.", { command: { type: "string" }, cwd: { type: "string" }, timeout_seconds: { type: "integer", minimum: 1, maximum: 1800 }, wait_seconds: { type: "integer", minimum: 0, maximum: 30, default: 5 }, ...approval }, ["command"], OPEN_DESTRUCTIVE),
    tool("getJob", "Get bounded output and state from a running or completed job.", { job_id: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 16384 } }, ["job_id"]),
    tool("cancelJob", "Cancel a currently running gateway job.", { job_id: { type: "string" } }, ["job_id"], DESTRUCTIVE),
    tool("manageService", "Inspect or manage a systemd service. For restart retries, reuse idempotency_key with identical arguments.", { name: { type: "string" }, action: { type: "string", enum: ["status", "start", "stop", "restart", "reload", "enable", "disable"] }, ...idempotency }, ["name", "action"], DESTRUCTIVE),
    tool("managePackage", "Query or manage Debian packages through the system package manager.", { action: { type: "string", enum: ["update", "install", "remove", "purge", "status"] }, packages: { type: "array", items: { type: "string" }, maxItems: 20 } }, ["action"], OPEN_DESTRUCTIVE),
    tool("invokeInterface", "Call a configured VPS facility through its named interface. The gateway supplies credentials and transport details; use the MCP discover capability to see available interfaces.", {
      interface: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
      method: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
      input: { type: "object" },
    }, ["interface", "method"], OPEN_DESTRUCTIVE),
  ];
  const batchNames = tools.map((item) => item.name);
  tools.push(tool("operationBatch", "Run 1-16 independent gateway operations concurrently. Every existing tool is available; only recursive operationBatch calls are rejected.", {
    steps: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", properties: { id: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$" }, tool: { type: "string", enum: batchNames }, args: { type: "object" } }, required: ["id", "tool"], additionalProperties: false } },
  }, ["steps"], OPEN_DESTRUCTIVE));
  return tools;
}

function catalogRevision(tools = getToolCatalog()) {
  return crypto.createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 16);
}

function catalogMetadata(tools = getToolCatalog()) {
  return { tool_count: tools.length, tool_names: tools.map((item) => item.name), tool_schema_revision: catalogRevision(tools) };
}

module.exports = { PUBLIC_OUTPUT_SCHEMA, catalogMetadata, catalogRevision, getToolCatalog };
