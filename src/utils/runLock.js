/**
 * In-Flight Run Locking & Idempotency Service.
 * Ensures a single active remediation execution per (repoId, runId, runAttempt, deliveryId).
 * Prevents concurrent webhook race conditions, duplicate LLM requests, and token waste.
 * Persists completed runs across process restarts to avoid re-triggering on container reboots.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export class RunLock {
  /**
   * @param {object|number} [optionsOrTtl=180000] - Configuration options or ttlMs
   * @param {number} [completedTtlMs=3600000] - Completed run retention in milliseconds (default: 1 hour)
   */
  constructor(optionsOrTtl = 180000, completedTtlMs = 3600000) {
    let ttl = 180000;
    let completedTtl = 3600000;
    let persistPath = path.join(os.tmpdir(), "healops-completed-runs.json");

    if (typeof optionsOrTtl === "object" && optionsOrTtl !== null) {
      ttl = optionsOrTtl.ttlMs || 180000;
      completedTtl = optionsOrTtl.completedTtlMs || 3600000;
      if (optionsOrTtl.persistPath) persistPath = optionsOrTtl.persistPath;
    } else if (typeof optionsOrTtl === "number") {
      ttl = optionsOrTtl;
      completedTtl = completedTtlMs;
    }

    this.ttlMs = ttl;
    this.completedTtlMs = completedTtl;
    this.persistPath = persistPath;

    this.activeRuns = new Map(); // key -> timeoutHandle
    this.completedRuns = new Map(); // key -> expirationTimestamp
    this.processedDeliveries = new Set(); // deliveryId

    // Load persisted completed runs from disk
    this._loadPersistedState();
  }

  _loadPersistedState() {
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, "utf-8");
        const entries = JSON.parse(raw);
        const now = Date.now();
        if (Array.isArray(entries)) {
          for (const item of entries) {
            if (item.expiresAt > now) {
              this.completedRuns.set(item.key, item.expiresAt);
            }
          }
        }
      }
    } catch {}
  }

  _savePersistedState() {
    try {
      const now = Date.now();
      const entries = [];
      for (const [key, expiresAt] of this.completedRuns.entries()) {
        if (expiresAt > now) {
          entries.push({ key, expiresAt });
        }
      }
      fs.writeFileSync(this.persistPath, JSON.stringify(entries), "utf-8");
    } catch {}
  }

  /**
   * Build consistent composite key for run locking.
   * @param {string|number} repoId
   * @param {string|number} [runId]
   * @param {string|number} [runAttempt]
   * @returns {string}
   */
  buildKey(repoId, runId = null, runAttempt = null) {
    if (runId === null && runAttempt === null) {
      return String(repoId);
    }
    const attempt = runAttempt !== null && runAttempt !== undefined ? runAttempt : 1;
    return `${repoId}:${runId}:${attempt}`;
  }

  /**
   * Attempt to acquire lock for a given run (or composite repoId + runId + runAttempt).
   * Rejects if deliveryId already seen, or if currently in-flight OR if already completed.
   *
   * @param {string|number|object} repoIdOrOptions
   * @param {string|number} [runId]
   * @param {string|number} [runAttempt]
   * @param {string} [deliveryId]
   * @returns {boolean} True if acquired, false if already locked or completed
   */
  acquire(repoIdOrOptions, runId = null, runAttempt = null, deliveryId = null) {
    let repoId = repoIdOrOptions;
    let rId = runId;
    let attempt = runAttempt;
    let delId = deliveryId;

    if (typeof repoIdOrOptions === "object" && repoIdOrOptions !== null) {
      repoId = repoIdOrOptions.repoId;
      rId = repoIdOrOptions.runId;
      attempt = repoIdOrOptions.runAttempt;
      delId = repoIdOrOptions.deliveryId;
    }

    if (!repoId) return false;

    // 1. Webhook delivery ID check (drop exact duplicate deliveries)
    if (delId) {
      if (this.processedDeliveries.has(delId)) {
        return false;
      }
      this.processedDeliveries.add(delId);
    }

    const key = this.buildKey(repoId, rId, attempt);
    const now = Date.now();

    // 2. Check if already completed (including persisted across restarts)
    if (this.completedRuns.has(key)) {
      const exp = this.completedRuns.get(key);
      if (exp > now) {
        return false;
      }
      this.completedRuns.delete(key);
    }

    // 3. Check if currently in-flight
    if (this.activeRuns.has(key)) {
      return false;
    }

    const timer = setTimeout(() => {
      this.activeRuns.delete(key);
    }, this.ttlMs);

    if (timer.unref) {
      timer.unref();
    }

    this.activeRuns.set(key, timer);
    return true;
  }

  /**
   * Release lock for a given run. Optionally mark as completed for idempotency.
   *
   * @param {string|number|object} repoIdOrOptions
   * @param {string|number} [runId]
   * @param {string|number} [runAttempt]
   * @param {boolean} [markAsCompleted=false]
   * @returns {boolean} True if released, false if not held
   */
  release(repoIdOrOptions, runId = null, runAttempt = null, markAsCompleted = false) {
    let repoId = repoIdOrOptions;
    let rId = runId;
    let attempt = runAttempt;
    let completed = markAsCompleted;

    if (typeof repoIdOrOptions === "object" && repoIdOrOptions !== null) {
      repoId = repoIdOrOptions.repoId;
      rId = repoIdOrOptions.runId;
      attempt = repoIdOrOptions.runAttempt;
      completed = repoIdOrOptions.markAsCompleted ?? false;
    }

    if (!repoId) return false;
    const key = this.buildKey(repoId, rId, attempt);

    let released = false;
    if (this.activeRuns.has(key)) {
      clearTimeout(this.activeRuns.get(key));
      this.activeRuns.delete(key);
      released = true;
    }

    if (completed) {
      const expiresAt = Date.now() + this.completedTtlMs;
      this.completedRuns.set(key, expiresAt);
      this._savePersistedState();
    }

    return released;
  }

  /**
   * Check if a run is currently locked (active).
   * @param {string|number} repoId
   * @param {string|number} [runId]
   * @param {string|number} [runAttempt]
   * @returns {boolean}
   */
  isLocked(repoId, runId = null, runAttempt = null) {
    if (!repoId) return false;
    const key = this.buildKey(repoId, runId, runAttempt);
    return this.activeRuns.has(key);
  }

  /**
   * Check if a run was already completed.
   * @param {string|number} repoId
   * @param {string|number} [runId]
   * @param {string|number} [runAttempt]
   * @returns {boolean}
   */
  isCompleted(repoId, runId = null, runAttempt = null) {
    if (!repoId) return false;
    const key = this.buildKey(repoId, runId, runAttempt);
    const expiresAt = this.completedRuns.get(key);
    if (!expiresAt) return false;
    if (expiresAt < Date.now()) {
      this.completedRuns.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Clear all active locks and completed records.
   */
  clear() {
    for (const timer of this.activeRuns.values()) {
      clearTimeout(timer);
    }
    this.activeRuns.clear();
    this.completedRuns.clear();
    this.processedDeliveries.clear();
    try {
      if (fs.existsSync(this.persistPath)) {
        fs.unlinkSync(this.persistPath);
      }
    } catch {}
  }
}

export const globalRunLock = new RunLock();
