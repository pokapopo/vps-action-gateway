"use strict";

const { callBackend } = require("../ipc-client");

const READ_VIEWS = Object.freeze({
  file: "readFile",
  search: "searchFiles",
  tree: "inspectWorkspace",
});

const OBSERVE_VIEWS = Object.freeze({
  system: "getSystemOverview",
  cyberboss: "getCyberbossMonitorSnapshot",
  logs: "queryLogs",
  processes: "getProcessList",
});

// Chat-facing MCP calls get a longer first wait so short jobs finish in one
// tool turn. The legacy backend/API defaults remain unchanged.
const CHAT_DEFAULT_WAIT_SECONDS = 20;

const DEFAULT_REGISTRY = Object.freeze({
  health: Object.freeze({ default: "healthCheck" }),
  read: READ_VIEWS,
  observe: OBSERVE_VIEWS,
  edit: Object.freeze({ write: "writeFile", patch: "applyPatch" }),
  move_out: Object.freeze({ delete: "deletePath", restore: "restorePath" }),
  execute: Object.freeze({ run: "runCommand", start: "startJob", status: "getJob", cancel: "cancelJob" }),
  manage: Object.freeze({ service: "manageService", package: "managePackage" }),
  operation: Object.freeze({
    batch: "operationBatch",
    invoke: "invokeInterface",
    approval_prepare: "__approval_prepare",
    approval_status: "__approval_status",
    approval_confirm: "__approval_confirm",
  }),
  facilities: Object.freeze({ default: null }),
  discover: Object.freeze({ default: null }),
});

const SELECTOR_FIELDS = Object.freeze({ read: "view", observe: "view", edit: "action", move_out: "action", execute: "action", manage: "target", operation: "action" });

const BACKEND_TO_CORE = Object.freeze({
  healthCheck: ["health", undefined],
  inspectWorkspace: ["read", ["view", "tree"]],
  searchFiles: ["read", ["view", "search"]],
  readFile: ["read", ["view", "file"]],
  getSystemOverview: ["observe", ["view", "system"]],
  getCyberbossMonitorSnapshot: ["observe", ["view", "cyberboss"]],
  queryLogs: ["observe", ["view", "logs"]],
  getProcessList: ["observe", ["view", "processes"]],
  writeFile: ["edit", ["action", "write"]],
  applyPatch: ["edit", ["action", "patch"]],
  deletePath: ["move_out", ["action", "delete"]],
  restorePath: ["move_out", ["action", "restore"]],
  runCommand: ["execute", ["action", "run"]],
  startJob: ["execute", ["action", "start"]],
  getJob: ["execute", ["action", "status"]],
  cancelJob: ["execute", ["action", "cancel"]],
  manageService: ["manage", ["target", "service"]],
  managePackage: ["manage", ["target", "package"]],
  operationBatch: ["operation", ["action", "batch"]],
  invokeInterface: ["operation", ["action", "invoke"]],
});

function createCapabilityRegistry(overrides = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_REGISTRY).map(([tool, values]) => [tool, { ...values, ...(overrides[tool] || {}) }]));
}

function discoverCapabilities(registry = DEFAULT_REGISTRY) {
  return Object.fromEntries(Object.entries(registry)
    .filter(([tool]) => !["health", "facilities", "discover"].includes(tool))
    .map(([tool, values]) => [tool, Object.keys(values)]));
}

function invalidSelector(tool, field, value, allowed) {
  const error = new Error(`${tool}.${field} is not supported: ${String(value)}; use discover for current capabilities`);
  error.code = "unsupported_capability";
  error.status = 400;
  error.details = { tool, field, value, allowed };
  return error;
}

function backendArguments(input, selector) {
  const nested = input?.arguments;
  if (nested !== undefined && (nested === null || Array.isArray(nested) || typeof nested !== "object")) {
    const error = new Error("arguments must be an object");
    error.code = "invalid_arguments";
    error.status = 400;
    throw error;
  }
  const flat = Object.fromEntries(Object.entries(input || {}).filter(([key]) => ![selector, "arguments", "debug"].includes(key)));
  return { ...flat, ...(nested || {}) };
}

function clampReadArguments(action, args) {
  const bounded = { ...args };
  if (action === "readFile") bounded.limit = Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 6144, 1), 6144);
  if (action === "searchFiles") bounded.max_results = Math.min(Math.max(Number.isInteger(args.max_results) ? args.max_results : 50, 1), 200);
  if (action === "inspectWorkspace") bounded.max_entries = Math.min(Math.max(Number.isInteger(args.max_entries) ? args.max_entries : 100, 1), 250);
  if (action === "queryLogs") bounded.lines = Math.min(Math.max(Number.isInteger(args.lines) ? args.lines : 100, 1), 500);
  return bounded;
}

function resolveRoute(tool, input = {}, options = {}) {
  const registry = options.registry || DEFAULT_REGISTRY;
  if (!registry[tool]) {
    const error = new Error(`unknown v2 core tool: ${tool}`);
    error.code = "unknown_tool";
    error.status = 404;
    throw error;
  }
  if (tool === "discover" || tool === "facilities") return { action: null, args: {}, selector: undefined };
  if (tool === "health") return { action: registry.health.default, args: backendArguments(input) };
  const selectorField = SELECTOR_FIELDS[tool];
  const selector = input[selectorField];
  const action = registry[tool][selector];
  if (!action) throw invalidSelector(tool, selectorField, selector, Object.keys(registry[tool]));
  const args = clampReadArguments(action, backendArguments(input, selectorField));
  if (tool === "execute" && (selector === "run" || selector === "start") && args.wait_seconds === undefined) {
    args.wait_seconds = CHAT_DEFAULT_WAIT_SECONDS;
  }
  return { action, args, selector };
}

function coreNextAction(nextAction) {
  if (!nextAction?.tool) return nextAction;
  const mapped = BACKEND_TO_CORE[nextAction.tool];
  if (!mapped) return nextAction;
  const [tool, selector] = mapped;
  return { tool, arguments: { ...(selector ? { [selector[0]]: selector[1] } : {}), arguments: nextAction.arguments || {} } };
}

function normalizeResult(result) {
  if (!result?.next_action) return result;
  return { ...result, next_action: coreNextAction(result.next_action) };
}

async function routeCoreTool(tool, input = {}, options = {}) {
  const registry = options.registry || DEFAULT_REGISTRY;
  const route = resolveRoute(tool, input, { registry });
  if (tool === "discover") {
    return {
      ...route,
      result: {
        ok: true,
        status: "succeeded",
        summary: "discover succeeded",
        data: { capabilities: discoverCapabilities(registry) },
        truncated: false,
        redactions: 0,
        warnings: [],
      },
    };
  }
  if (tool === "facilities") {
    return {
      ...route,
      result: {
        ok: true,
        status: "succeeded",
        summary: "facilities listed",
        data: {},
        truncated: false,
        redactions: 0,
        warnings: [],
      },
    };
  }
  const backend = options.callBackend || callBackend;
  const socketPath = options.socketPath || process.env.VPS_ACTION_SOCKET || "/run/vps-action-gateway/backend.sock";
  const result = await backend(socketPath, route.action, route.args);
  return { ...route, result: normalizeResult(result) };
}

module.exports = { BACKEND_TO_CORE, CHAT_DEFAULT_WAIT_SECONDS, DEFAULT_REGISTRY, OBSERVE_VIEWS, READ_VIEWS, backendArguments, coreNextAction, createCapabilityRegistry, discoverCapabilities, normalizeResult, resolveRoute, routeCoreTool };
