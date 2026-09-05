"use strict";

const crypto = require("node:crypto");

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    status: { type: "string" },
    summary: { type: "string" },
    data: { type: "object" },
    error: { type: "object" },
    next_action: { type: "object" },
    truncated: { type: "boolean" },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["ok", "status"],
};

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
const OPEN_DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });

function coreTool(name, description, selector, annotations = READ_ONLY) {
  const properties = {
    ...(selector ? { [selector]: { type: "string", description: `Server-validated ${selector}; use discover to see current values.` } } : {}),
    arguments: { type: "object", description: "Capability-specific arguments. This container keeps the top-level schema stable as capabilities evolve." },
    debug: { type: "boolean", description: "Include privacy-safe routing diagnostics." },
  };
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(selector ? { required: [selector] } : {}),
      additionalProperties: true,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations,
  };
}

function getCoreCatalog() {
  return [
    coreTool("health", "Check the gateway and report the current stable v2 capability surface."),
    coreTool("read", "Read a file, search files, or inspect a tree. Select with view; put capability-specific fields in arguments.", "view"),
    coreTool("observe", "Observe the system, Cyberboss, logs, or running processes (view=processes, optional arguments.match). Read-only, no approval. Prefer this over execute/run for any inspection.", "view"),
    coreTool("edit", "Create, replace, or patch files and scripts after the host's native tool approval when required; SHA guards prevent stale overwrites. Select with action.", "action", WRITE),
    coreTool("move_out", "Move a path to recoverable trash or restore it. Select with action.", "action", DESTRUCTIVE),
    coreTool("execute", "Run a command or start, inspect, or cancel a job. Select with action.", "action", OPEN_DESTRUCTIVE),
    coreTool("manage", "Inspect or mutate a service or package through bounded backend operations. Select with target.", "target", OPEN_DESTRUCTIVE),
    coreTool("operation", "Run an existing backend operation batch or manage a v2 business approval. Select with action.", "action", OPEN_DESTRUCTIVE),
    coreTool("discover", "Return the server-side capability registry without changing the top-level MCP tool schema."),
  ];
}

function schemaFingerprint(tools = getCoreCatalog()) {
  return crypto.createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 16);
}

module.exports = { OUTPUT_SCHEMA, getCoreCatalog, schemaFingerprint };
