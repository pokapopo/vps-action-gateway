"use strict";

function base(action, status, ok, data, extra = {}) {
  return {
    ok,
    status,
    summary: extra.summary || `${action} ${status}`,
    data: data || {},
    truncated: extra.truncated === true,
    redactions: Number(extra.redactions) || 0,
    warnings: Array.isArray(extra.warnings) ? extra.warnings : [],
    ...((extra.nextAction || extra.next_action) ? { next_action: extra.nextAction || extra.next_action } : {}),
    ...(extra.next_cursor !== undefined ? { next_cursor: extra.next_cursor } : {}),
    ...(extra.request_id ? { request_id: extra.request_id } : {}),
    ...(extra.action_id ? { action_id: extra.action_id } : {}),
  };
}

function succeeded(action, data, extra = {}) {
  return base(action, "succeeded", true, data, extra);
}

function accepted(action, data, extra = {}) {
  return base(action, "accepted", true, data, extra);
}

function problem(action, status, code, message, options = {}) {
  return {
    ...base(action, status, false, options.data, { ...options, summary: message }),
    error: {
      code,
      message,
      retryable: options.retryable === true,
      ...(options.errorStatus ? { status: options.errorStatus } : {}),
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  };
}

function fromError(action, _args, error) {
  const status = error?.code === "approval_required" ? "waiting_confirmation" : "failed";
  return problem(action, status, String(error?.code || "internal_error").toUpperCase(), error?.message || "internal error", {
    retryable: status === "waiting_confirmation" || !error?.status || error.status >= 500,
    errorStatus: error?.status || 500,
    data: error?.details || {},
    details: error?.details,
  });
}

function compact(value, debug = false) {
  if (debug || !value || typeof value !== "object") return value;
  const result = { ...value };
  delete result.request_id;
  delete result.action_id;
  return result;
}

function boundMcpResult(value, maxBytes = 8 * 1024) {
  if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) return value;
  const bounded = { ...value, truncated: true, warnings: [...new Set([...(value.warnings || []), "Structured result was bounded; use pagination or narrower arguments."])] };
  if (bounded.data && typeof bounded.data === "object") {
    bounded.data = { ...bounded.data };
    for (const key of ["content", "output", "entries", "results", "journal"]) {
      if (!(key in bounded.data)) continue;
      bounded.data[key] = typeof bounded.data[key] === "string" ? "[truncated]" : [];
      if (Buffer.byteLength(JSON.stringify(bounded)) <= maxBytes) break;
    }
  }
  return bounded;
}

module.exports = { accepted, boundMcpResult, compact, fromError, problem, succeeded };
