"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { stable } = require("../idempotency-store");

const STATES = new Set(["pending", "approved", "consumed", "expired", "cancelled"]);

function fingerprint(request) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(request))).digest("hex");
}

function publicApproval(record) {
  return {
    approval_id: record.id,
    state: record.state,
    operation: record.operation,
    target: record.target,
    fingerprint: record.fingerprint,
    created_at: record.created_at,
    expires_at: record.expires_at,
    ...(record.decision ? { decision: record.decision } : {}),
    ...(record.completed_at ? { completed_at: record.completed_at } : {}),
    ...(record.result ? { result: record.result } : {}),
  };
}

class ApprovalStore {
  constructor(filePath = process.env.VPS_MCP_V2_APPROVAL_PATH || "/var/lib/vps-action-mcp-v2/approvals.json", options = {}) {
    this.filePath = path.resolve(filePath);
    this.ttlMs = options.ttlMs || 5 * 60 * 1000;
    this.maxEntries = options.maxEntries || 500;
    this.records = new Map();
    this.loaded = false;
    this.lock = Promise.resolve();
  }

  withLock(operation) {
    const result = this.lock.then(operation, operation);
    this.lock = result.catch(() => {});
    return result;
  }

  async load() {
    return this.withLock(async () => {
      if (this.loaded) return;
      try {
        const parsed = JSON.parse(await fsp.readFile(this.filePath, "utf8"));
        for (const record of Array.isArray(parsed.records) ? parsed.records : []) {
          if (record?.id && STATES.has(record.state) && record.fingerprint) this.records.set(record.id, record);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      this.loaded = true;
      await this.persistLocked();
    });
  }

  expireLocked(now = Date.now()) {
    for (const record of this.records.values()) {
      if (["pending", "approved"].includes(record.state) && Date.parse(record.expires_at) <= now) record.state = "expired";
    }
  }

  pruneLocked() {
    this.expireLocked();
    const ordered = [...this.records.values()].sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
    while (ordered.length > this.maxEntries) this.records.delete(ordered.shift().id);
  }

  async persistLocked() {
    this.pruneLocked();
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${crypto.randomUUID()}`;
    await fsp.writeFile(temporary, `${JSON.stringify({ version: 1, records: [...this.records.values()] })}\n`, { mode: 0o600, flag: "wx" });
    await fsp.rename(temporary, this.filePath);
  }

  async prepare({ request, operation, target, backendChallenge }) {
    await this.load();
    return this.withLock(async () => {
      const now = new Date();
      const record = {
        id: `ap_${crypto.randomUUID()}`,
        state: "pending",
        operation,
        target: target || "unspecified",
        fingerprint: fingerprint(request),
        request,
        backend_challenge: backendChallenge,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + this.ttlMs).toISOString(),
      };
      this.records.set(record.id, record);
      await this.persistLocked();
      return publicApproval(record);
    });
  }

  async status(id) {
    await this.load();
    return this.withLock(async () => {
      const record = this.records.get(id);
      if (!record) return null;
      const before = record.state;
      this.expireLocked();
      if (before !== record.state) await this.persistLocked();
      return publicApproval(record);
    });
  }

  async cancel(id) {
    await this.load();
    return this.withLock(async () => {
      const record = this.records.get(id);
      if (!record) return null;
      this.expireLocked();
      if (!["pending", "approved"].includes(record.state)) return publicApproval(record);
      record.state = "cancelled";
      record.completed_at = new Date().toISOString();
      await this.persistLocked();
      return publicApproval(record);
    });
  }

  async approveAndConsume(id, decision = "allow") {
    await this.load();
    return this.withLock(async () => {
      const record = this.records.get(id);
      if (!record) return { kind: "missing" };
      this.expireLocked();
      if (record.state === "consumed") return { kind: "replay", record, public: publicApproval(record) };
      if (record.state !== "pending") return { kind: record.state, record, public: publicApproval(record) };
      record.decision = decision;
      record.state = "approved";
      await this.persistLocked();
      // Persist consumed before dispatch. If the process dies during the backend
      // call, a retry is reported as in-doubt instead of replaying a mutation.
      record.state = "consumed";
      record.consumed_at = new Date().toISOString();
      await this.persistLocked();
      return { kind: "execute", record, public: publicApproval(record) };
    });
  }

  async complete(id, result) {
    await this.load();
    return this.withLock(async () => {
      const record = this.records.get(id);
      if (!record || record.state !== "consumed") return null;
      record.result = result;
      record.completed_at = new Date().toISOString();
      await this.persistLocked();
      return publicApproval(record);
    });
  }
}

module.exports = { ApprovalStore, STATES, fingerprint, publicApproval };
