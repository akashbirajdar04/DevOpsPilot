/**
 * In-Flight Run Locking Service.
 * Ensures a single active remediation execution per GitHub Actions workflow runId.
 * Prevents concurrent webhook race conditions, duplicate LLM requests, and token waste.
 */

export class RunLock {
  /**
   * @param {number} [ttlMs=180000] - Lock expiration in milliseconds (default: 3 minutes)
   */
  constructor(ttlMs = 180000) {
    this.activeRuns = new Map(); // runId -> timeoutHandle
    this.ttlMs = ttlMs;
  }

  /**
   * Attempt to acquire lock for a given runId.
   * @param {string|number} runId
   * @returns {boolean} True if acquired, false if already locked
   */
  acquire(runId) {
    if (!runId) return false;
    const key = String(runId);
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
   * Release lock for a given runId.
   * @param {string|number} runId
   * @returns {boolean} True if released, false if not held
   */
  release(runId) {
    if (!runId) return false;
    const key = String(runId);
    if (this.activeRuns.has(key)) {
      clearTimeout(this.activeRuns.get(key));
      this.activeRuns.delete(key);
      return true;
    }
    return false;
  }

  /**
   * Check if a runId is currently locked.
   * @param {string|number} runId
   * @returns {boolean}
   */
  isLocked(runId) {
    if (!runId) return false;
    return this.activeRuns.has(String(runId));
  }

  /**
   * Clear all active locks (useful for testing or shutdown).
   */
  clear() {
    for (const timer of this.activeRuns.values()) {
      clearTimeout(timer);
    }
    this.activeRuns.clear();
  }
}

export const globalRunLock = new RunLock();

