"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const YAML = require("yaml");

const execFileAsync = promisify(execFile);
const DEFAULT_INTERFACE_DIR = "/etc/vps-action-gateway/interfaces.d";
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function interfaceDirectory() {
  return process.env.VPS_ACTION_INTERFACE_DIR || DEFAULT_INTERFACE_DIR;
}

function invalid(message, details) {
  const error = new Error(message);
  error.code = "invalid_interface_config";
  error.status = 422;
  error.details = details;
  return error;
}

function assertObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(message);
  return value;
}

function validateManifest(manifest, source) {
  assertObject(manifest, "interface manifest must be an object");
  if (typeof manifest.name !== "string" || !NAME_PATTERN.test(manifest.name)) throw invalid("interface name is invalid", { source });
  assertObject(manifest.actions, "interface actions must be an object");
  const actions = {};
  for (const [name, definition] of Object.entries(manifest.actions)) {
    if (!NAME_PATTERN.test(name)) throw invalid("interface action name is invalid", { source, action: name });
    assertObject(definition, "interface action must be an object");
    const transport = definition.transport || "http";
    if (!new Set(["http", "command"]).has(transport)) throw invalid("unsupported interface transport", { source, action: name, transport });
    if (transport === "http") {
      if (!/^https?:\/\//i.test(String(definition.url || ""))) throw invalid("HTTP interface action requires an http(s) url", { source, action: name });
      if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]).has(String(definition.method || "POST").toUpperCase())) throw invalid("unsupported HTTP method", { source, action: name });
    } else if (!Array.isArray(definition.command) || !definition.command.length || definition.command.some((item) => typeof item !== "string" || !item)) {
      throw invalid("command interface action requires a non-empty command array", { source, action: name });
    }
    actions[name] = { ...definition, transport, method: String(definition.method || "POST").toUpperCase() };
  }
  return { name: manifest.name, description: String(manifest.description || manifest.name), actions, source };
}

async function loadInterfaceRegistry(directory = interfaceDirectory()) {
  let names;
  try { names = (await fsp.readdir(directory, { withFileTypes: true })).filter((item) => item.isFile() && /\.(?:ya?ml|json)$/i.test(item.name)).map((item) => item.name).sort(); }
  catch (error) { if (error.code === "ENOENT") return new Map(); throw error; }
  const registry = new Map();
  for (const name of names) {
    const source = path.join(directory, name);
    const manifest = validateManifest(YAML.parse(await fsp.readFile(source, "utf8")), source);
    if (registry.has(manifest.name)) throw invalid("duplicate interface name", { name: manifest.name, source });
    registry.set(manifest.name, manifest);
  }
  return registry;
}

function publicInterfaceCatalog(registry) {
  return [...registry.values()].map((item) => ({
    name: item.name,
    description: item.description,
    actions: Object.fromEntries(Object.entries(item.actions).map(([name, action]) => [name, {
      description: String(action.description || name),
      transport: action.transport,
      input_schema: action.input_schema || { type: "object" },
    }])),
  }));
}

function valueAt(input, key) {
  return key.split(".").reduce((value, part) => value && value[part], input);
}

function interpolate(value, input) {
  return String(value).replace(/\$\{input\.([A-Za-z0-9_.-]+)\}/g, (_, key) => {
    const resolved = valueAt(input, key);
    if (resolved === undefined || resolved === null) throw invalid(`missing interface input: ${key}`);
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
  });
}

function validateInput(input, schema) {
  if (!schema) return;
  assertObject(schema, "interface input_schema must be an object");
  for (const key of schema.required || []) {
    if (input[key] === undefined || input[key] === null) throw invalid(`missing interface input: ${key}`);
  }
  for (const [key, definition] of Object.entries(schema.properties || {})) {
    if (input[key] === undefined || !definition?.type) continue;
    const value = input[key];
    const valid = definition.type === "array" ? Array.isArray(value)
      : definition.type === "object" ? Boolean(value && typeof value === "object" && !Array.isArray(value))
        : definition.type === "null" ? value === null
          : typeof value === definition.type;
    if (!valid) throw invalid(`interface input ${key} must be ${definition.type}`);
  }
}

async function invokeRegisteredInterface(registry, name, method, input = {}) {
  if (!registry.has(name)) throw Object.assign(new Error(`unknown interface: ${name}`), { code: "interface_not_found", status: 404 });
  const manifest = registry.get(name);
  const action = manifest.actions[method];
  if (!action) throw Object.assign(new Error(`unknown interface action: ${name}.${method}`), { code: "interface_action_not_found", status: 404 });
  assertObject(input, "interface input must be an object");
  validateInput(input, action.input_schema);
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) throw invalid("interface input is too large");
  const timeoutMs = Math.min(Math.max(Number(action.timeout_ms) || 30_000, 1000), 120_000);
  if (action.transport === "command") {
    const command = action.command.map((item) => interpolate(item, input));
    const result = await execFileAsync(command[0], command.slice(1), { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env: { PATH: "/usr/local/bin:/usr/bin:/bin", ...process.env } });
    return { transport: "command", output: `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`, status_code: 0 };
  }
  const url = new URL(interpolate(action.url, input));
  const headers = { accept: "application/json, text/plain;q=0.9", ...(action.headers || {}) };
  if (action.bearer_env) {
    const token = process.env[String(action.bearer_env)];
    if (!token) throw invalid(`missing interface credential environment variable: ${action.bearer_env}`);
    headers.authorization = `Bearer ${token}`;
  }
  const body = action.method === "GET" || action.method === "DELETE" ? undefined : JSON.stringify(input);
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(url, { method: action.method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw invalid("interface response is too large");
  return { transport: "http", output: text, status_code: response.status, ok: response.ok };
}

module.exports = { DEFAULT_INTERFACE_DIR, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, interfaceDirectory, invokeRegisteredInterface, loadInterfaceRegistry, publicInterfaceCatalog, validateInput, validateManifest };
