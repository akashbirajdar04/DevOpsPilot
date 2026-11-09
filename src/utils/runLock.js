/**
 * In-Flight Run Locking & Idempotency Service.
 * Ensures a single active remediation execution per (repoId, runId, runAttempt).
 * Prevents concurrent webhook race conditions, duplicate LLM requests, and token waste.
 */

export class RunLock {
  /**
   * @param {number} [ttlMs=180000] - Lock expiration in milliseconds (default: 3 minutes)
   * @param {number} [completedTtlMs=3600000] - Completed run retention in milliseconds (default: 1 hour)
   */
  constructor(ttlMs = 180000, completedTtlMs = 3600000) {
    this.activeRuns = new Map(); // key -> timeoutHandle
    this.completedRuns = new Map(); // key -> timeoutHandle
    this.ttlMs = ttlMs;
    this.completedTtlMs = completedTtlMs;
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
   * Rejects if currently in-flight OR if already completed.
   *
   * @param {string|number} repoId
   * @param {string|number} [runId]
   * @param {string|number} [runAttempt]
   * @returns {boolean} True if acquired, false if already locked or completed
   */
  acquire(repoId, runId = null, runAttempt = null) {
    if (repoId === null || repoId === undefined || repoId === "") return false;
    const key = this.buildKey(repoId, runId, runAttempt);

    // If already completed or currently in-flight, reject
    if (this.completedRuns.has(key) || this.activeRuns.has(key)) {
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
   * @param {string|number} repoId
   * @param {string|number} [runId]
   * @param {string|number} [runAttempt]
   * @param {boolean} [markAsCompleted=false]
   * @returns {boolean} True if released, false if not held
   */
  release(repoId, runId = null, runAttempt = null, markAsCompleted = false) {
    if (repoId === null || repoId === undefined || repoId === "") return false;
    const key = this.buildKey(repoId, runId, runAttempt);

    let released = false;
    if (this.activeRuns.has(key)) {
      clearTimeout(this.activeRuns.get(key));
      this.activeRuns.delete(key);
      released = true;
    }

    if (markAsCompleted) {
      const cTimer = setTimeout(() => {
        this.completedRuns.delete(key);
      }, this.completedTtlMs);
      if (cTimer.unref) cTimer.unref();
      this.completedRuns.set(key, cTimer);
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
    return this.completedRuns.has(key);
  }

  /**
   * Clear all active locks and completed records (useful for testing or shutdown).
   */
  clear() {
    for (const timer of this.activeRuns.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.completedRuns.values()) {
      clearTimeout(timer);
    }
    this.activeRuns.clear();
    this.completedRuns.clear();
  }
}

export const globalRunLock = new RunLock();

