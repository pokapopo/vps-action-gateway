"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CODEX_HOME = process.env.VPS_CODEX_HOME || path.join(os.homedir(), ".codex");
const INDEX = process.env.VPS_CODEX_SESSION_INDEX || path.join(CODEX_HOME, "session_index.jsonl");
const STATE = process.env.VPS_CODEX_ACTIVE_STATE || "/var/lib/vps-action-gateway/codex-active-thread.json";
const CODEX = process.env.VPS_CODEX_BIN || "/usr/bin/codex";
const REMOTE = process.env.VPS_CODEX_REMOTE || `unix://${path.join(CODEX_HOME, "app-server-control/app-server-control.sock")}`;
const DEFAULT_THREAD = process.env.VPS_CODEX_DEFAULT_THREAD || "";

function sessions() {
  const byId = new Map();
  for (const line of fs.readFileSync(INDEX, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.id && item.thread_name) byId.set(item.id, item);
    } catch {}
  }
  return [...byId.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

function active() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); }
  catch {
    const item = DEFAULT_THREAD ? sessions().find((x) => x.id === DEFAULT_THREAD) : null;
    return item ? { id: item.id, name: item.thread_name } : null;
  }
}

function save(item) {
  const value = { id: item.id, name: item.thread_name };
  const temp = STATE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value) + "\n", { mode: 0o600 });
  fs.renameSync(temp, STATE);
  return value;
}

function main() {
  const action = process.argv[2];
  const value = process.argv[3] || "";
  if (action === "list") {
    console.log(JSON.stringify({ windows: sessions().slice(0, 20).map(({ id, thread_name, updated_at }) => ({ id, name: thread_name, updated_at })) }));
    return;
  }
  if (action === "current") {
    console.log(JSON.stringify({ active: active() }));
    return;
  }
  if (action === "switch") {
    const needle = value.trim().toLowerCase();
    if (!needle) throw new Error("window is required");
    const matches = sessions().filter((x) => x.id === value || x.thread_name.toLowerCase().includes(needle));
    if (matches.length === 0) throw new Error("window not found");
    const exact = matches.find((x) => x.id === value || x.thread_name.toLowerCase() === needle);
    if (!exact && matches.length > 1) {
      console.log(JSON.stringify({ error: "window is ambiguous", matches: matches.slice(0, 10).map((x) => ({ id: x.id, name: x.thread_name })) }));
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify({ active: save(exact || matches[0]) }));
    return;
  }
  if (action === "send") {
    const target = active();
    if (!target) throw new Error("no active window");
    if (!value.trim()) throw new Error("message is required");
    const output = execFileSync(CODEX, ["queue", "--remote", REMOTE, "--thread", target.id, "--message", value], { encoding: "utf8", timeout: 120000 });
    console.log(JSON.stringify({ active: target, queued: true, output: output.trim() }));
    return;
  }
  throw new Error("unknown action");
}

main();
