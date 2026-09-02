"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const fsp = require("node:fs/promises");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function requestFingerprint(action, args) {
  const businessArgs = { ...(args || {}) };
  for (const key of ["idempotency_key", "debug", "approval_token", "user_approved"]) delete businessArgs[key];
  return crypto.createHash("sha256").update(JSON.stringify(stable({ action, arguments: businessArgs }))).digest("hex");
}

class IdempotencyStore {
  constructor(filePath, { maxEntries = 1000, ttlMs = 7 * 24 * 3600 * 1000 } = {}) {
    this.filePath = path.resolve(filePath);
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.records = new Map();
    this.loaded = false;
    this.lock = Promise.resolve();
  }

  async withLock(operation) {
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
          if (record?.scope && record?.fingerprint && record?.updated_at) this.records.set(record.scope, record);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      this.loaded = true;
      await this.persistLocked();
    });
  }

  pruneLocked() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [scope, record] of this.records) {
      if (Date.parse(record.updated_at) < cutoff) this.records.delete(scope);
    }
    const ordered = [...this.records.values()].sort((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at));
    while (ordered.length > this.maxEntries) this.records.delete(ordered.shift().scope);
  }

  async persistLocked() {
    this.pruneLocked();
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${crypto.randomUUID()}`;
    await fsp.writeFile(temporary, `${JSON.stringify({ version: 1, records: [...this.records.values()] })}\n`, { mode: 0o640, flag: "wx" });
    await fsp.rename(temporary, this.filePath);
  }

  async claim(action, key, args) {
    await this.load();
    return this.withLock(async () => {
      const scope = `${action}:${key}`;
      const fingerprint = requestFingerprint(action, args);
      const existing = this.records.get(scope);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return { kind: "conflict" };
        if (existing.state === "pending") return { kind: "in_doubt" };
        return { kind: "replay", result: existing.result };
      }
      const now = new Date().toISOString();
      this.records.set(scope, { scope, action, key, fingerprint, state: "pending", created_at: now, updated_at: now });
      await this.persistLocked();
      return { kind: "claimed", scope, fingerprint };
    });
  }

  async complete(scope, fingerprint, result) {
    return this.withLock(async () => {
      const record = this.records.get(scope);
      if (!record || record.fingerprint !== fingerprint) throw new Error("idempotency claim disappeared");
      record.state = result.status;
      record.result = result;
      record.updated_at = new Date().toISOString();
      await this.persistLocked();
    });
  }

  async release(scope, fingerprint) {
    return this.withLock(async () => {
      const record = this.records.get(scope);
      if (record?.fingerprint === fingerprint && record.state === "pending") {
        this.records.delete(scope);
        await this.persistLocked();
      }
    });
  }
}

module.exports = { IdempotencyStore, requestFingerprint, stable };
