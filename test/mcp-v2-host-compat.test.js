"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer, handleRpc } = require("../mcp-v2/server");

test("stateless initialize and tools/list never require or issue an MCP session", async (t) => {
  const auth = {
    handleOAuthRoute: () => false,
    authorized: () => true,
    challenge: () => { throw new Error("unexpected challenge"); },
    send(res, status, body, headers = {}) { const payload = body === undefined ? "" : JSON.stringify(body); res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(payload); },
  };
  const server = createServer({ oauth: auth, log: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/mcp-v2/`;
  async function rpc(id, method, params = {}, headers = {}) {
    const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    return { response, body: await response.json() };
  }
  const initialized = await rpc(1, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initialized.body.result.serverInfo.name, "vps-action-mcp-v2");
  assert.deepEqual(initialized.body.result.capabilities.tools, {});
  assert.equal(initialized.body.result.capabilities.resources, undefined);
  assert.equal(initialized.response.headers.get("mcp-session-id"), null);
  const listed = await rpc(2, "tools/list", {}, { "mcp-session-id": "ignored-stale-session" });
  assert.equal(listed.body.result.tools.length, 9);
  assert.equal(listed.response.headers.get("mcp-session-id"), null);
});

test("tools/call returns usable text through the stateless handler", async () => {
  const response = await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read", arguments: { view: "file", arguments: { path: "/tmp/a" } } } }, {
    log: false,
    callBackend: async (_socket, action) => ({ ok: true, status: "succeeded", summary: "ok", data: { path: "/tmp/a", sha256: "sha", size: 7, offset: 0, content: `${action}:payload` }, truncated: false, warnings: [] }),
  });
  assert.match(response.result.content[0].text, /readFile:payload/);
  assert.equal(response.result.structuredContent.data.content, "readFile:payload");
});
