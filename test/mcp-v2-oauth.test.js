"use strict";

process.env.VPS_MCP_OAUTH_ISSUER = "https://action.example";
process.env.VPS_MCP_V2_OAUTH_ISSUER = "https://action.example/oauth-v2";
process.env.VPS_MCP_V2_OAUTH_RESOURCE = "https://action.example/mcp-v2/";
process.env.VPS_MCP_OAUTH_CLIENT_ID = "claude-v2-client";
process.env.VPS_MCP_OAUTH_CLIENT_SECRET = "claude-v2-secret";
process.env.VPS_MCP_OAUTH_CALLBACK_URI = "https://claude.ai/api/mcp/auth_callback";
process.env.VPS_MCP_CHATGPT_CLIENT_ID = "chatgpt-v2-client";
process.env.VPS_MCP_CHATGPT_CLIENT_SECRET = "chatgpt-v2-secret";
process.env.VPS_MCP_CHATGPT_CALLBACK_URI = "https://chatgpt.com/connector/oauth/v2-test";
process.env.VPS_MCP_OAUTH_TOKEN_SECRET = "v2-test-signing-secret-with-enough-entropy";
process.env.VPS_ACTION_MCP_KEY = "v2-internal-key";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { createServer } = require("../mcp-v2/server");

function verifier() { return crypto.randomBytes(48).toString("base64url"); }
function challenge(value) { return crypto.createHash("sha256").update(value).digest("base64url"); }

async function start(t) {
  const server = createServer({ log: false, callBackend: async () => ({ ok: true, status: "succeeded", summary: "ok", data: { status: "ok", tool_count: 18, tool_names: [], tool_schema_revision: "test" }, warnings: [] }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("v2 has audience-isolated OAuth metadata, PKCE, access, and refresh", async (t) => {
  const base = await start(t);
  const protectedMetadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp-v2`).then((response) => response.json());
  assert.equal(protectedMetadata.resource, "https://action.example/mcp-v2/");
  assert.deepEqual(protectedMetadata.authorization_servers, ["https://action.example/oauth-v2"]);
  const authMetadata = await fetch(`${base}/.well-known/oauth-authorization-server/oauth-v2`).then((response) => response.json());
  assert.equal(authMetadata.issuer, "https://action.example/oauth-v2");
  assert.equal(authMetadata.token_endpoint, "https://action.example/oauth-v2/token");

  const unauthorized = await fetch(`${base}/mcp-v2/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate"), /oauth-protected-resource\/mcp-v2/);

  const pkce = verifier();
  const authorize = new URL(`${base}/oauth-v2/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", "claude-v2-client");
  authorize.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  authorize.searchParams.set("resource", "https://action.example/mcp-v2/");
  authorize.searchParams.set("scope", "mcp");
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("code_challenge", challenge(pkce));
  const authorized = await fetch(authorize, { redirect: "manual" });
  assert.equal(authorized.status, 302);
  const code = new URL(authorized.headers.get("location")).searchParams.get("code");
  assert.ok(code);

  const token = await fetch(`${base}/oauth-v2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from("claude-v2-client:claude-v2-secret").toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://claude.ai/api/mcp/auth_callback", resource: "https://action.example/mcp-v2/", code_verifier: pkce }),
  }).then((response) => response.json());
  assert.ok(token.access_token);
  assert.ok(token.refresh_token);

  const listed = await fetch(`${base}/mcp-v2/`, { method: "POST", headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }).then((response) => response.json());
  assert.equal(listed.result.tools.length, 9);

  const refreshed = await fetch(`${base}/oauth-v2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from("claude-v2-client:claude-v2-secret").toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token }),
  }).then((response) => response.json());
  assert.ok(refreshed.access_token);
  assert.notEqual(refreshed.refresh_token, token.refresh_token);
});

test("v1-audience token and internal key boundaries remain explicit", async (t) => {
  const base = await start(t);
  const internal = await fetch(`${base}/mcp-v2/`, { method: "POST", headers: { authorization: "Bearer v2-internal-key", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(internal.status, 200);
  const fakeV1Token = [Buffer.from('{"alg":"none"}').toString("base64url"), Buffer.from('{"aud":"https://action.example/mcp/"}').toString("base64url"), "x"].join(".");
  const denied = await fetch(`${base}/mcp-v2/`, { method: "POST", headers: { authorization: `Bearer ${fakeV1Token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  assert.equal(denied.status, 401);
});
