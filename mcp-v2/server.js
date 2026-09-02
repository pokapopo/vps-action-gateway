"use strict";

const http = require("node:http");
const { getCoreCatalog } = require("./catalog");
const { DEFAULT_REGISTRY, discoverCapabilities, routeCoreTool } = require("./router");
const { buildCoreFailure, buildCoreResult } = require("./response");
const { ApprovalStore } = require("./approval-store");
const oauth = require("./oauth");

const HOST = process.env.VPS_MCP_V2_HOST || "127.0.0.1";
const PORT = Number(process.env.VPS_MCP_V2_PORT || 8789);
const PATHNAME = process.env.VPS_MCP_V2_PATH || "/mcp-v2/";
const SOCKET_PATH = process.env.VPS_ACTION_SOCKET || "/run/vps-action-gateway/backend.sock";
const MUTATING_CORE_TOOLS = new Set(["edit", "move_out", "execute", "manage", "operation"]);
let defaultApprovalStore;

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message, data) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }; }

async function handleRpc(message, options = {}) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return rpcError(message?.id, -32600, "Invalid Request");
  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion;
    const protocolVersion = ["2025-06-18", "2025-03-26"].includes(requested) ? requested : "2025-06-18";
    return rpcResult(message.id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "vps-action-mcp-v2", version: "1.0.0" } });
  }
  if (message.method === "notifications/initialized") return undefined;
  if (message.method === "ping") return rpcResult(message.id, {});
  if (message.method === "tools/list") return rpcResult(message.id, { tools: getCoreCatalog() });
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments || {};
    const startedAt = Date.now();
    try {
      const approvalStore = options.approvalStore || (defaultApprovalStore ||= new ApprovalStore());
      const routed = name === "operation" && String(args.action || "").startsWith("approval_")
        ? await handleApprovalOperation(args, { ...options, approvalStore })
        : await routeAndCaptureApproval(name, args, { ...options, approvalStore });
      const v2Data = { core_tools: getCoreCatalog().map((tool) => tool.name), capabilities: discoverCapabilities(options.registry || DEFAULT_REGISTRY) };
      const result = buildCoreResult(name, routed.selector, routed.result, { debug: args.debug === true, v2Data });
      if (options.log !== false) logCall(name, routed.action, result, startedAt, args);
      return rpcResult(message.id, result);
    } catch (error) {
      const result = buildCoreFailure(name, error);
      if (options.log !== false) logCall(name, undefined, result, startedAt, args, error);
      return rpcResult(message.id, result);
    }
  }
  return rpcError(message.id, -32601, "Method not found");
}

function approvalTarget(request, backendResult) {
  const input = request.arguments?.arguments || request.arguments || {};
  return backendResult?.data?.requested_path || input.path || input.restore_path || input.cwd || input.name || input.command || request.tool;
}

function challengeResult(approval, backendResult) {
  return {
    ok: false,
    status: "waiting_confirmation",
    summary: "gateway business approval is required for this exact operation",
    data: approval,
    truncated: false,
    redactions: Number(backendResult.redactions) || 0,
    warnings: backendResult.warnings || [],
    error: { code: "APPROVAL_REQUIRED", message: "Confirm this exact operation through operation(action=approval_confirm).", retryable: true },
    next_action: { tool: "operation", arguments: { action: "approval_confirm", arguments: { approval_id: approval.approval_id, decision: "approve" } } },
  };
}

async function routeAndCaptureApproval(name, args, options) {
  const routed = await routeCoreTool(name, args, { socketPath: options.socketPath || SOCKET_PATH, callBackend: options.callBackend, registry: options.registry || DEFAULT_REGISTRY });
  if (routed.result?.status !== "waiting_confirmation") return routed;
  const request = { tool: name, arguments: args };
  const approval = await options.approvalStore.prepare({
    request,
    operation: `${name}${routed.selector ? `:${routed.selector}` : ""}`,
    target: approvalTarget(request, routed.result),
    backendChallenge: routed.result.data,
  });
  return { ...routed, result: challengeResult(approval, routed.result) };
}

function approvalProblem(code, message, data) {
  return { ok: false, status: "failed", summary: message, data, truncated: false, redactions: 0, warnings: [], error: { code, message, retryable: false } };
}

async function handleApprovalOperation(args, options) {
  const action = args.action;
  const input = { ...args, ...(args.arguments || {}) };
  const store = options.approvalStore;
  if (action === "approval_prepare") {
    const request = input.request;
    if (!request || !MUTATING_CORE_TOOLS.has(request.tool) || request.tool === "operation" && String(request.arguments?.action || "").startsWith("approval_")) {
      return { action: null, selector: action, result: approvalProblem("INVALID_APPROVAL_REQUEST", "approval_prepare requires a mutating core-tool request", {}) };
    }
    // Validate the stable core route without dispatching it.
    const planned = require("./router").resolveRoute(request.tool, request.arguments || {}, { registry: options.registry || DEFAULT_REGISTRY });
    const approval = await store.prepare({ request, operation: `${request.tool}${planned.selector ? `:${planned.selector}` : ""}`, target: approvalTarget(request) });
    return { action: null, selector: action, result: challengeResult(approval, { summary: "explicit gateway business approval requested", warnings: [] }) };
  }
  if (action === "approval_status") {
    const approval = await store.status(input.approval_id);
    return { action: null, selector: action, result: approval ? { ok: true, status: "succeeded", summary: "approval status", data: approval, truncated: false, warnings: [] } : approvalProblem("APPROVAL_NOT_FOUND", "approval does not exist", {}) };
  }
  if (action !== "approval_confirm") return { action: null, selector: action, result: approvalProblem("UNSUPPORTED_APPROVAL_ACTION", "use approval_prepare, approval_status, or approval_confirm", {}) };
  if (input.decision === "cancel") {
    const cancelled = await store.cancel(input.approval_id);
    return { action: null, selector: action, result: cancelled ? { ok: false, status: "interrupted", summary: "approval cancelled", data: cancelled, truncated: false, warnings: [] } : approvalProblem("APPROVAL_NOT_FOUND", "approval does not exist", {}) };
  }
  const consumed = await store.approveAndConsume(input.approval_id);
  if (consumed.kind === "missing") return { action: null, selector: action, result: approvalProblem("APPROVAL_NOT_FOUND", "approval does not exist", {}) };
  if (consumed.kind === "replay") {
    return { action: null, selector: action, result: consumed.record.result || approvalProblem("APPROVAL_IN_DOUBT", "approval was consumed but no result was recorded; inspect state before retrying", consumed.public) };
  }
  if (consumed.kind !== "execute") return { action: null, selector: action, result: approvalProblem(`APPROVAL_${consumed.kind.toUpperCase()}`, `approval is ${consumed.kind}`, consumed.public) };
  const record = consumed.record;
  const requestArgs = structuredClone(record.request.arguments || {});
  const nested = { ...(requestArgs.arguments || {}) };
  nested.user_approved = true;
  if (record.backend_challenge?.approval_token) nested.approval_token = record.backend_challenge.approval_token;
  requestArgs.arguments = nested;
  const executed = await routeCoreTool(record.request.tool, requestArgs, { socketPath: options.socketPath || SOCKET_PATH, callBackend: options.callBackend, registry: options.registry || DEFAULT_REGISTRY });
  await store.complete(record.id, executed.result);
  return { action: executed.action, selector: action, result: executed.result };
}

function logCall(coreTool, backendAction, result, startedAt, args, error) {
  const bytes = Buffer.byteLength(JSON.stringify(result));
  const approval = args?.arguments?.approval_id || args?.approval_id || args?.arguments?.approval_token || args?.approval_token;
  console.log(JSON.stringify({
    component: "vps-mcp-v2",
    core_tool: coreTool,
    backend_action: backendAction || null,
    status: result.structuredContent?.status || "unknown",
    duration_ms: Date.now() - startedAt,
    response_bytes: bytes,
    is_error: result.isError,
    has_approval_reference: Boolean(approval),
    error_code: error?.code || result.structuredContent?.error?.code || null,
  }));
}

async function readMessage(req, limit = 1024 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > limit) throw Object.assign(new Error("request too large"), { status: 413 });
  }
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error("invalid JSON-RPC payload"), { status: 400 }); }
}

function createServer(options = {}) {
  const auth = options.oauth || oauth;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (auth.handleOAuthRoute(req, res, url)) return;
      if (url.pathname !== PATHNAME && url.pathname !== PATHNAME.replace(/\/$/, "")) return auth.send(res, 404, { error: "not found" });
      if (!auth.authorized(req)) return auth.challenge(res);
      if (req.method !== "POST") return auth.send(res, 405, { error: "Stateless Streamable HTTP endpoint accepts POST only" }, { Allow: "POST" });
      const response = await handleRpc(await readMessage(req), options);
      return auth.send(res, response === undefined ? 202 : 200, response);
    } catch (error) {
      return auth.send(res, error.status || 500, rpcError(null, -32603, error.status && error.status < 500 ? error.message : "Internal error"));
    }
  });
}

if (require.main === module) {
  oauth.assertConfigured();
  createServer().listen(PORT, HOST, () => console.log(`VPS Action MCP v2 listening on http://${HOST}:${PORT}${PATHNAME}`));
}

module.exports = { challengeResult, createServer, handleApprovalOperation, handleRpc, routeAndCaptureApproval };
