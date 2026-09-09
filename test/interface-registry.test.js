"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const test = require("node:test");
const { invokeRegisteredInterface, loadInterfaceRegistry, publicInterfaceCatalog } = require("../interface-registry");
const { handleRpc } = require("../mcp-v2/server");
const { dispatch } = require("../privileged-server");

async function tempDirectory(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "vps-interface-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("interface registry validates manifests, exposes public capabilities, and invokes HTTP actions", async (t) => {
  const directory = await tempDirectory(t);
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ method: request.method, body: JSON.parse(body || "{}") }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  await fsp.writeFile(path.join(directory, "echo.yaml"), `name: echo\ndescription: Echo test service\nactions:\n  send:\n    description: Send a message\n    transport: http\n    method: POST\n    url: http://127.0.0.1:${port}/echo\n    input_schema:\n      type: object\n      required: [message]\n      properties:\n        message:\n          type: string\n`);
  await fsp.writeFile(path.join(directory, "local.yaml"), `name: local\ndescription: Local command service\nactions:\n  say:\n    transport: command\n    command: [printf, '%s', '\${input.message}']\n    input_schema:\n      type: object\n      required: [message]\n      properties:\n        message:\n          type: string\n`);
  const registry = await loadInterfaceRegistry(directory);
  assert.deepEqual(publicInterfaceCatalog(registry)[0].actions.send.input_schema.required, ["message"]);
  const result = await invokeRegisteredInterface(registry, "echo", "send", { message: "hello" });
  assert.equal(result.status_code, 200);
  assert.deepEqual(JSON.parse(result.output).body, { message: "hello" });
  const command = await invokeRegisteredInterface(registry, "local", "say", { message: "command ok" });
  assert.equal(command.output, "command ok");
  const previous = process.env.VPS_ACTION_INTERFACE_DIR;
  process.env.VPS_ACTION_INTERFACE_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.VPS_ACTION_INTERFACE_DIR;
    else process.env.VPS_ACTION_INTERFACE_DIR = previous;
  });
  const mcp = await handleRpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "operation", arguments: { action: "invoke", arguments: { interface: "echo", method: "send", input: { message: "through MCP" } } } } }, { log: false, callBackend: (_socket, action, args) => dispatch(action, args) });
  assert.equal(mcp.result.structuredContent.status, "succeeded");
  assert.match(mcp.result.structuredContent.data.output, /through MCP/);
  await assert.rejects(() => invokeRegisteredInterface(registry, "echo", "send", {}), { code: "invalid_interface_config" });
});

test("MCP facilities reliably exposes configured interfaces without execution details", async (t) => {
  const directory = await tempDirectory(t);
  await fsp.writeFile(path.join(directory, "milo.yaml"), "name: milo\ndescription: Milo\nactions:\n  chat:\n    transport: http\n    method: POST\n    url: http://127.0.0.1:1/chat\n");
  const previous = process.env.VPS_ACTION_INTERFACE_DIR;
  process.env.VPS_ACTION_INTERFACE_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.VPS_ACTION_INTERFACE_DIR;
    else process.env.VPS_ACTION_INTERFACE_DIR = previous;
  });
  const response = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "facilities", arguments: {} } }, { log: false });
  assert.equal(response.result.structuredContent.data.interfaces[0].name, "milo");
  assert.equal(response.result.structuredContent.data.interfaces[0].actions.chat.url, undefined);
  assert.equal(response.result.structuredContent.data.interfaces[0].actions.chat.bearer_env, undefined);
  assert.equal(response.result.structuredContent.data.interfaces[0].actions.chat.command, undefined);
  assert.equal(response.result.structuredContent.data.invoke_with.action, "invoke");
  assert.match(response.result.content[0].text, /Do not guess/);
  assert.equal((await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { log: false })).result.tools.length, 10);
});
