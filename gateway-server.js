"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { callBackend } = require("./ipc-client");
const { compact, problem } = require("./response");

const HOST = process.env.VPS_ACTION_HOST || "127.0.0.1";
const PORT = Number(process.env.VPS_ACTION_PORT || 8787);
const SOCKET_PATH = process.env.VPS_ACTION_SOCKET || "/run/vps-action-gateway/backend.sock";
const API_KEY = process.env.VPS_ACTION_GPT_KEY || "";
const MAX_REQUEST = 1024 * 1024;

const routes = new Map([
  ["GET /gpt/v1/health", ["healthCheck", false]],
  ["POST /gpt/v1/workspace/inspect", ["inspectWorkspace", true]],
  ["POST /gpt/v1/system/overview", ["getSystemOverview", true]],
  ["POST /gpt/v1/logs/query", ["queryLogs", true]],
  ["POST /gpt/v1/files/search", ["searchFiles", true]],
  ["POST /gpt/v1/files/read", ["readFile", true]],
  ["POST /gpt/v1/files/patch", ["applyPatch", true]],
  ["POST /gpt/v1/files/write", ["writeFile", true]],
  ["POST /gpt/v1/files/delete", ["deletePath", true]],
  ["POST /gpt/v1/files/restore", ["restorePath", true]],
  ["POST /gpt/v1/commands/run", ["runCommand", true]],
  ["POST /gpt/v1/jobs", ["startJob", true]],
  ["POST /gpt/v1/jobs/get", ["getJob", true]],
  ["POST /gpt/v1/jobs/cancel", ["cancelJob", true]],
  ["POST /gpt/v1/services/manage", ["manageService", true]],
  ["POST /gpt/v1/packages/manage", ["managePackage", true]],
  ["POST /gpt/v1/operations/batch", ["operationBatch", true]],
]);

function authorized(req) {
  if (!API_KEY) return false;
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), "Cache-Control": "no-store" });
  res.end(payload);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_REQUEST) throw Object.assign(new Error("request too large"), { status: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) return send(res, 401, { ok: false, error: { code: "unauthorized", message: "invalid Bearer key" } });
  const route = routes.get(`${req.method} ${new URL(req.url, "http://localhost").pathname}`);
  if (!route) return send(res, 404, { ok: false, error: { code: "not_found", message: "route not found" } });
  try {
    const args = route[1] ? await readJson(req) : {};
    const result = await callBackend(SOCKET_PATH, route[0], args);
    const publicResult = compact(result, args.debug === true);
    const waiting = result.status === "waiting_confirmation";
    send(res, result.status === "accepted" ? 202 : result.ok || waiting ? 200 : result.error?.status || 500, publicResult);
  } catch (error) {
    send(res, error.status || 502, compact(problem(route[0], "failed", "GATEWAY_ERROR", error.message, { retryable: true, errorStatus: error.status || 502 }), false));
  }
});

server.listen(PORT, HOST, () => console.log(`VPS Action GPT gateway listening on http://${HOST}:${PORT}`));
