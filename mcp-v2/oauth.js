"use strict";

const crypto = require("node:crypto");

const PUBLIC_ORIGIN = String(process.env.VPS_MCP_OAUTH_ISSUER || "http://127.0.0.1:8789").replace(/\/$/, "");
const ISSUER = String(process.env.VPS_MCP_V2_OAUTH_ISSUER || `${PUBLIC_ORIGIN}/oauth-v2`).replace(/\/$/, "");
const RESOURCE = process.env.VPS_MCP_V2_OAUTH_RESOURCE || `${PUBLIC_ORIGIN}/mcp-v2/`;
const TOKEN_SECRET = process.env.VPS_MCP_OAUTH_TOKEN_SECRET || "";
const INTERNAL_KEY = process.env.VPS_ACTION_MCP_KEY || "";
const CLIENTS = [
  {
    id: process.env.VPS_MCP_V2_OAUTH_CLIENT_ID || process.env.VPS_MCP_OAUTH_CLIENT_ID || "",
    secret: process.env.VPS_MCP_V2_OAUTH_CLIENT_SECRET || process.env.VPS_MCP_OAUTH_CLIENT_SECRET || "",
    redirectUri: process.env.VPS_MCP_V2_OAUTH_CALLBACK_URI || process.env.VPS_MCP_OAUTH_CALLBACK_URI || "https://claude.ai/api/mcp/auth_callback",
  },
  {
    id: process.env.VPS_MCP_V2_CHATGPT_CLIENT_ID || process.env.VPS_MCP_CHATGPT_CLIENT_ID || "",
    secret: process.env.VPS_MCP_V2_CHATGPT_CLIENT_SECRET || process.env.VPS_MCP_CHATGPT_CLIENT_SECRET || "",
    redirectUri: process.env.VPS_MCP_V2_CHATGPT_CALLBACK_URI || process.env.VPS_MCP_CHATGPT_CALLBACK_URI || "",
  },
  {
    id: process.env.VPS_MCP_V2_GEMINI_CLIENT_ID || "",
    secret: process.env.VPS_MCP_V2_GEMINI_CLIENT_SECRET || "",
    redirectUri: process.env.VPS_MCP_V2_GEMINI_CALLBACK_URI || "",
  },
].filter((client) => client.id && client.secret && client.redirectUri);

const pendingCodes = new Map();
const usedRefreshTokens = new Set();
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizedResource(value) { return String(value || "").replace(/\/$/, ""); }
function validResource(value) { return normalizedResource(value) === normalizedResource(RESOURCE); }
function getClient(clientId) { return CLIENTS.find((client) => safeEqual(client.id, clientId)); }
function b64url(value) { return Buffer.from(value).toString("base64url"); }

function signToken(kind, ttl, clientId, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ISSUER, aud: RESOURCE, sub: clientId, scope: "mcp", iat: now, exp: now + ttl, jti: crypto.randomUUID(), kind, ...extra };
  const encoded = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac("sha256", TOKEN_SECRET).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyToken(token, expectedKind = "access") {
  if (!TOKEN_SECRET) return null;
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  if (!safeEqual(parts[2], expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== ISSUER || !validResource(payload.aud) || !getClient(payload.sub) || payload.kind !== expectedKind || payload.exp <= now || payload.iat > now + 60) return null;
    if (!String(payload.scope || "").split(/\s+/).includes("mcp")) return null;
    return payload;
  } catch { return null; }
}

function bearer(req) { return String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] || ""; }
function authorized(req) {
  const token = bearer(req);
  return Boolean(token) && ((INTERNAL_KEY && safeEqual(token, INTERNAL_KEY)) || Boolean(verifyToken(token)));
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Cache-Control": "no-store", ...(body === undefined ? {} : { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", "Content-Length": Buffer.byteLength(payload) }), ...headers });
  res.end(payload);
}

function oauthError(res, status, error, description) { send(res, status, { error, error_description: description }); }
function challenge(res) {
  const metadata = `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp-v2`;
  send(res, 401, { error: "invalid_token", error_description: "OAuth access token required" }, { "WWW-Authenticate": `Bearer resource_metadata="${metadata}", error="invalid_token"` });
}

async function readRaw(req, limit = 1024 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > limit) throw Object.assign(new Error("request too large"), { status: 413 });
  }
  return raw;
}

function clientCredentials(req, params) {
  const auth = String(req.headers.authorization || "").match(/^Basic\s+(.+)$/i);
  if (auth) {
    try {
      const decoded = Buffer.from(auth[1], "base64").toString("utf8");
      const split = decoded.indexOf(":");
      return [decodeURIComponent(decoded.slice(0, split)), decodeURIComponent(decoded.slice(split + 1))];
    } catch { return ["", ""]; }
  }
  return [params.get("client_id") || "", params.get("client_secret") || ""];
}

function handleAuthorize(url, res) {
  const params = url.searchParams;
  const redirectUri = params.get("redirect_uri") || "";
  const client = getClient(params.get("client_id") || "");
  const fail = (error, description) => {
    if (client && redirectUri === client.redirectUri) {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error);
      target.searchParams.set("error_description", description);
      if (params.get("state")) target.searchParams.set("state", params.get("state"));
      return send(res, 302, undefined, { Location: target.toString() });
    }
    return oauthError(res, 400, error, description);
  };
  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
  if (!client) return fail("unauthorized_client", "unknown client_id");
  if (redirectUri !== client.redirectUri) return fail("invalid_request", "redirect_uri is not registered");
  if (!validResource(params.get("resource"))) return fail("invalid_target", "resource does not match this MCP server");
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(params.get("code_challenge") || "")) return fail("invalid_request", "PKCE S256 is required");
  if (!(params.get("scope") || "mcp").split(/\s+/).includes("mcp")) return fail("invalid_scope", "mcp scope is required");
  const code = crypto.randomBytes(32).toString("base64url");
  pendingCodes.set(code, { clientId: client.id, redirectUri, challenge: params.get("code_challenge"), resource: RESOURCE, expiresAt: Date.now() + 300_000 });
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (params.get("state")) target.searchParams.set("state", params.get("state"));
  return send(res, 302, undefined, { Location: target.toString() });
}

async function handleToken(req, res) {
  const params = new URLSearchParams(await readRaw(req));
  const [clientId, clientSecret] = clientCredentials(req, params);
  const client = getClient(clientId);
  if (!client || !safeEqual(client.secret, clientSecret)) return oauthError(res, 401, "invalid_client", "client authentication failed");
  if (params.get("grant_type") === "authorization_code") {
    const code = params.get("code") || "";
    const pending = pendingCodes.get(code);
    pendingCodes.delete(code);
    if (!pending || pending.expiresAt <= Date.now() || pending.clientId !== client.id || pending.redirectUri !== params.get("redirect_uri") || !validResource(params.get("resource") || pending.resource)) return oauthError(res, 400, "invalid_grant", "authorization code is invalid or expired");
    const verifier = params.get("code_verifier") || "";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    if (!safeEqual(challenge, pending.challenge)) return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
    return send(res, 200, { access_token: signToken("access", ACCESS_TTL, client.id), token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: signToken("refresh", REFRESH_TTL, client.id), scope: "mcp" });
  }
  if (params.get("grant_type") === "refresh_token") {
    const token = params.get("refresh_token") || "";
    const payload = verifyToken(token, "refresh");
    if (!payload || payload.sub !== client.id || usedRefreshTokens.has(payload.jti)) return oauthError(res, 400, "invalid_grant", "refresh token is invalid or already used");
    usedRefreshTokens.add(payload.jti);
    return send(res, 200, { access_token: signToken("access", ACCESS_TTL, client.id), token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: signToken("refresh", REFRESH_TTL, client.id), scope: "mcp" });
  }
  return oauthError(res, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

function handleOAuthRoute(req, res, url) {
  const pathname = url.pathname;
  if (pathname === "/.well-known/oauth-protected-resource/mcp-v2" && req.method === "GET") {
    send(res, 200, { resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ["mcp"], bearer_methods_supported: ["header"] });
    return true;
  }
  if (["/.well-known/oauth-authorization-server/oauth-v2", "/oauth-v2/.well-known/oauth-authorization-server"].includes(pathname) && req.method === "GET") {
    send(res, 200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"], scopes_supported: ["mcp"] });
    return true;
  }
  if (pathname === "/oauth-v2/authorize" && req.method === "GET") { handleAuthorize(url, res); return true; }
  if (pathname === "/oauth-v2/token" && req.method === "POST") { void handleToken(req, res); return true; }
  return false;
}

function assertConfigured() {
  if (!CLIENTS.length || !TOKEN_SECRET) throw new Error("MCP v2 OAuth credentials are not configured");
}

module.exports = { CLIENTS, ISSUER, PUBLIC_ORIGIN, RESOURCE, assertConfigured, authorized, challenge, handleOAuthRoute, send, verifyToken };
