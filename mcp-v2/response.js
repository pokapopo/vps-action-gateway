"use strict";

const { boundMcpResult, compact, problem } = require("../response");

const MAX_TEXT_BYTES = 8 * 1024;
const MAX_STRUCTURED_BYTES = 8 * 1024;

function clipUtf8(value, maxBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text) <= maxBytes) return { text, clipped: false };
  const suffix = "\n... [truncated; continue with the same core tool using the returned cursor or narrower arguments]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  let clipped = Buffer.from(text).subarray(0, budget).toString("utf8");
  while (Buffer.byteLength(clipped + suffix) > maxBytes) clipped = clipped.slice(0, -1);
  return { text: clipped + suffix, clipped: true };
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function renderHealth(data) {
  return [
    `Gateway health: ${data?.status || "unknown"}`,
    `Backend tool_count: ${data?.tool_count ?? "unknown"}`,
    `Backend tool_schema_revision: ${data?.tool_schema_revision || "unknown"}`,
    `Backend tool_names: ${(data?.tool_names || []).join(", ")}`,
    data?.v2 ? `V2 core tools: ${(data.v2.core_tools || []).join(", ")}` : undefined,
    data?.v2 ? `V2 capabilities: ${json(data.v2.capabilities || {})}` : undefined,
    `Running jobs: ${data?.running_jobs ?? "unknown"}`,
    `Free bytes: ${data?.free_bytes ?? "unknown"}`,
  ].filter(Boolean).join("\n");
}

function renderRead(selector, data) {
  if (selector === "file") {
    return [
      `Read succeeded: ${data?.path || "unknown path"}`,
      `SHA-256: ${data?.sha256 || "unknown"}`,
      `Size: ${data?.size ?? "unknown"} bytes`,
      `Offset: ${data?.offset ?? 0}`,
      "--- content ---",
      data?.content || "",
    ].join("\n");
  }
  if (selector === "search") {
    return [`Search succeeded: ${data?.query || ""} in ${data?.path || ""}`, "--- results ---", json(data?.results || [])].join("\n");
  }
  return [`Tree inspection succeeded: ${data?.path || ""}`, `Entry count: ${data?.entry_count ?? 0}`, "--- entries ---", json(data?.entries || [])].join("\n");
}

function renderObserve(selector, data) {
  if (selector === "logs") {
    return [`Logs succeeded: ${data?.source || "unknown"}${data?.unit ? ` unit=${data.unit}` : ""}${data?.path ? ` path=${data.path}` : ""}`, "--- output ---", data?.output || ""].join("\n");
  }
  if (selector === "system") return ["System observation succeeded", json(data || {})].join("\n");
  return ["Process observation succeeded", json(data || {})].join("\n");
}

function renderPayload(tool, selector, result) {
  if (result.status === "waiting_confirmation") {
    const pending = result.data || {};
    const approvalId = pending.approval_id || result.next_action?.arguments?.arguments?.approval_id;
    const operation = pending.operation || `${tool}${selector ? `:${selector}` : ""}`;
    const target = pending.target ? ` — ${pending.target}` : "";
    return [
      `${tool} is waiting for your approval`,
      `Pending: ${operation}${target}`,
      `Approve or deny by calling operation(action=approval_confirm) with approval_id=${approvalId ?? "?"} and decision=approve/deny.`,
      "Do not echo raw JSON to the user. First ask in plain language whether to allow this exact operation; only call approval_confirm after an explicit answer.",
    ].join("\n");
  }
  if (result.status === "accepted") {
    return [
      `${tool} is still running; the task has not completed yet.`,
      result.data?.job_id ? `Job: ${result.data.job_id}` : undefined,
      "Continue by calling the returned next_action and report the final result only after the job reaches completed, failed, timed_out, or cancelled.",
      result.next_action ? `Next action: ${json(result.next_action)}` : undefined,
    ].filter(Boolean).join("\n");
  }
  if (result.status !== "succeeded" && result.status !== "accepted") {
    return [
      `${tool} ${result.status || "failed"}: ${result.summary || result.error?.message || "unknown result"}`,
      result.error ? `Error: ${json(result.error)}` : undefined,
      result.next_action ? `Next action: ${json(result.next_action)}` : undefined,
    ].filter(Boolean).join("\n");
  }
  if (tool === "health") return renderHealth(result.data);
  if (tool === "read") return renderRead(selector, result.data);
  if (tool === "observe") return renderObserve(selector, result.data);
  if (tool === "discover") return ["Current server-side capabilities", json({ capabilities: result.data?.capabilities || {}, interfaces: result.data?.interfaces || [] })].join("\n");
  if (tool === "facilities") return [
    "Configured VPS facilities",
    "For an unknown local facility, use this catalog first. Use exact returned names and schemas, then call operation(action=invoke). Do not guess or bypass a matching facility with execute.",
    json({ facilities: result.data?.interfaces || [], invoke_with: result.data?.invoke_with || {}, rules: result.data?.rules || [] }),
  ].join("\n");
  return [`${tool} ${result.status}`, json(result.data || {})].join("\n");
}

function buildCoreResult(tool, selector, rawResult, options = {}) {
  const v2Data = options.v2Data;
  const compacted = compact(rawResult, options.debug === true);
  if (tool === "health" && v2Data && compacted?.data) compacted.data = { ...compacted.data, v2: v2Data };
  const structuredContent = boundMcpResult(compacted, MAX_STRUCTURED_BYTES);
  const rendered = clipUtf8(renderPayload(tool, selector, structuredContent), MAX_TEXT_BYTES);
  if (rendered.clipped) {
    structuredContent.truncated = true;
    structuredContent.warnings = [...new Set([...(structuredContent.warnings || []), "TextContent was bounded at 8192 bytes; use pagination or narrower arguments."])];
  }
  return {
    content: [{ type: "text", text: rendered.text }],
    structuredContent,
    isError: structuredContent.status === "failed" || structuredContent.status === "interrupted",
  };
}

function buildCoreFailure(tool, error) {
  const failed = problem(tool, "failed", error?.code || "internal_error", error?.status && error.status < 500 ? error.message : "internal error", {
    retryable: !error?.status || error.status >= 500,
    errorStatus: error?.status || 500,
    details: error?.details,
  });
  return buildCoreResult(tool, undefined, failed);
}

module.exports = { MAX_STRUCTURED_BYTES, MAX_TEXT_BYTES, buildCoreFailure, buildCoreResult, clipUtf8, renderPayload };
