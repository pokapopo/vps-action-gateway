"use strict";

const fs = require("node:fs");

function unquote(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

function parsePolicy(text) {
  const policy = { default: "confirm", allow: [], confirm: [] };
  let section = "";
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    const trimmed = withoutComment.trim();
    if (!trimmed || trimmed === "commands:") continue;
    const sectionMatch = trimmed.match(/^(allow|confirm):\s*$/);
    if (sectionMatch) { section = sectionMatch[1]; continue; }
    const defaultMatch = trimmed.match(/^default:\s*(.+)$/);
    if (defaultMatch) { policy.default = unquote(defaultMatch[1]).toLowerCase(); continue; }
    const itemMatch = trimmed.match(/^-\s*(.+)$/);
    if (itemMatch && section) policy[section].push(unquote(itemMatch[1]));
  }
  if (!["allow", "confirm"].includes(policy.default)) throw new Error("commands.default must be allow or confirm");
  for (const key of ["allow", "confirm"]) {
    policy[key] = policy[key].map((source) => {
      try { return new RegExp(source); } catch (error) { throw new Error(`invalid ${key} command regex ${source}: ${error.message}`); }
    });
  }
  return policy;
}

function loadPolicy(filePath) {
  return parsePolicy(fs.readFileSync(filePath, "utf8"));
}

function commandSegments(command) {
  const input = String(command || "").trim();
  if (!input) return { segments: [], unsafe: true };
  const segments = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  const push = (end) => {
    const value = input.slice(start, end).trim();
    if (!value) return false;
    segments.push(value);
    return true;
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote !== "'" && (character === "`" || (character === "$" && input[index + 1] === "(")))
      return { segments: [input], unsafe: true };
    if (escaped) { escaped = false; continue; }
    if (quote === "'") { if (character === "'") quote = ""; continue; }
    if (quote === '"') {
      if (character === "\\") escaped = true;
      else if (character === '"') quote = "";
      continue;
    }
    if (character === "\\") { escaped = true; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === ">" || character === "<")
      return { segments: [input], unsafe: true };
    if (character === "|") {
      if (!push(index)) return { segments: [input], unsafe: false };
      if (input[index + 1] === "|") index += 1;
      start = index + 1;
      continue;
    }
    if (character === "&") {
      if (input[index + 1] !== "&") return { segments: [input], unsafe: true };
      if (!push(index)) return { segments: [input], unsafe: false };
      index += 1;
      start = index + 1;
      continue;
    }
    if (character === ";" || character === "\n") {
      if (!push(index)) return { segments: [], unsafe: true };
      start = index + 1;
    }
  }
  if (quote || escaped || !push(input.length)) return { segments: [input], unsafe: false };
  return { segments, unsafe: false };
}

function matchSegment(segment, policy) {
  if (policy.confirm.some((rule) => rule.test(segment))) return "confirm";
  if (policy.allow.some((rule) => rule.test(segment))) return "allow";
  return policy.default;
}

function evaluateCommand(command, policy) {
  const parsed = commandSegments(command);
  if (parsed.unsafe) return { decision: "confirm", unsafe: true, segments: [] };
  const segments = parsed.segments.map((value) => ({ command: value, decision: matchSegment(value, policy) }));
  const decision = segments.some((item) => item.decision === "confirm") ? "confirm"
      : "allow";
  return { decision, unsafe: false, segments };
}

module.exports = { commandSegments, evaluateCommand, loadPolicy, parsePolicy };
